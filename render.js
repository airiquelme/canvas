// Frame assembly: project -> ownership -> joints -> primitives -> depth
// sort -> batched draw. Terms (joint, seam line, cut, trim): see CLAUDE.md.
import { DESIGN_WIDTH, DESIGN_HEIGHT, GAP_DEBUG } from './config.js';
import {
  vecSub, vecNormalize, wrapAngle, circleRimPoint, closestPointOnCircle,
  computePairTangents, edgeSegment, findEdgeCrossing, segmentCircleHit, findEllipseTangentPoint,
} from './geometry.js';
import { camera, getCameraPosition, computeViewBasis, worldToCamera, makeProjector } from './camera.js';
import { nodes, meshes } from './scene.js';
import {
  fillCircle, drawTriangle, traceCapsule, traceCircle, traceTriangle,
  drawPairCapsule, drawSeamBand, drawJointSplitCircle, drawSplitCone,
} from './shapes.js';

function applyDesignSpaceTransform(ctx, canvas) {
  const scale = Math.min(canvas.width / DESIGN_WIDTH, canvas.height / DESIGN_HEIGHT);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.scale(scale, scale);
  ctx.translate(-DESIGN_WIDTH / 2, -DESIGN_HEIGHT / 2);
}

function centroid(points) {
  const sum = points.reduce((acc, c) => ({ x: acc.x + c.x, y: acc.y + c.y, z: acc.z + c.z }), { x: 0, y: 0, z: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length, z: sum.z / points.length };
}

// nodeId -> ids of the meshes containing it.
function buildOwnership() {
  const owners = {};
  Object.values(meshes).forEach(mesh => {
    mesh.nodeIds.forEach(id => { (owners[id] ||= []).push(mesh.id); });
  });
  return owners;
}

// Joint nodes: shared by exactly two meshes, both 2-node meshes.
function findJointNodeIds(owners) {
  const ids = new Set();
  Object.keys(owners).forEach(key => {
    const ownerIds = owners[key];
    if (ownerIds.length === 2 && ownerIds.every(meshId => meshes[meshId].nodeIds.length === 2)) ids.add(Number(key));
  });
  return ids;
}

// The terminator of each joint: azimuth and phase of the axis between the
// two meshes' directions, in camera space.
function computeJoints(jointNodeIds, owners, projected, camPos, basis) {
  const joints = {};
  jointNodeIds.forEach(nodeId => {
    const [meshA, meshB] = owners[nodeId].map(id => meshes[id]);
    const otherCenters = (mesh) => mesh.nodeIds.filter(id => id !== nodeId).map(id => nodes[id].center);
    const nodeCam = worldToCamera(nodes[nodeId].center, camPos, basis);
    const dA = vecNormalize(vecSub(worldToCamera(centroid(otherCenters(meshA)), camPos, basis), nodeCam));
    const dB = vecNormalize(vecSub(worldToCamera(centroid(otherCenters(meshB)), camPos, basis), nodeCam));
    const axis = { x: dB.x - dA.x, y: dB.y - dA.y, z: dB.z - dA.z };
    const axisLen = Math.hypot(axis.x, axis.y, axis.z);
    if (axisLen < 1e-9) return;
    const p = projected[nodeId];
    joints[nodeId] = {
      center: p.center,
      radius: p.radius,
      azimuth: Math.atan2(-axis.y / axisLen, axis.x / axisLen),
      phase: axis.z / axisLen,
      meshA, meshB,
    };
  });
  return joints;
}

// The longest seam among this pair's shared ends: for each other mesh at
// the shared node, where this capsule's edge crosses that capsule's edge.
// seam = { crossing, tangentRim, pivotIsA, pivotId, otherFar }.
function findSeam(frame, mesh, a, b, sharedA, sharedB) {
  const { owners, projected } = frame;
  let seam = null, seamLen = -1;
  [{ isShared: sharedA, pivot: a, other: b, pivotIsA: true },
   { isShared: sharedB, pivot: b, other: a, pivotIsA: false }].forEach(({ isShared, pivot, other, pivotIsA }) => {
    if (!isShared) return;
    const tanA = computePairTangents(pivot.center, pivot.radius, other.center, other.radius);
    owners[pivot.id].forEach(otherMeshId => {
      if (otherMeshId === mesh.id) return;
      meshes[otherMeshId].nodeIds.filter(id => id !== pivot.id).forEach(otherId => {
        const otherFar = projected[otherId];
        const tanB = computePairTangents(pivot.center, pivot.radius, otherFar.center, otherFar.radius);
        const crossT1 = (ext) => findEdgeCrossing(edgeSegment(pivot, other, tanA.t1Angle), edgeSegment(pivot, otherFar, tanB.t2Angle), other, otherFar, ext);
        const crossT2 = (ext) => findEdgeCrossing(edgeSegment(pivot, other, tanA.t2Angle), edgeSegment(pivot, otherFar, tanB.t1Angle), other, otherFar, ext);
        const ext = !crossT1(false) && !crossT2(false);
        const c1 = crossT1(ext), c2 = crossT2(ext);
        // Both pairings can have an extended crossing; both capsules must
        // pick the same one, so take the nearer.
        const pivotDist = (p) => Math.hypot(p.x - pivot.center.x, p.y - pivot.center.y);
        const onT1 = !!c1 && (!ext || !c2 || pivotDist(c1) <= pivotDist(c2));
        const crossing = onT1 ? c1 : c2;
        if (!crossing) return;
        const rim = circleRimPoint(pivot.center, pivot.radius, Math.atan2(crossing.y - pivot.center.y, crossing.x - pivot.center.x));
        const len = Math.hypot(rim.x - crossing.x, rim.y - crossing.y);
        if (len > seamLen) {
          seamLen = len;
          const tangentRim = circleRimPoint(pivot.center, pivot.radius, onT1 ? tanA.t1Angle : tanA.t2Angle);
          seam = { crossing, tangentRim, pivotIsA, pivotId: pivot.id, otherFar };
        }
      });
    });
  });
  return seam;
}

// The seam line at a joint: from the crossing, tangent to the terminator,
// to where it leaves the rim. Shared by the capsule cut and the crescent
// trim, so they always agree. Null for a capped (non-tangent) point.
function seamLine(joint, crossing) {
  const ex = Math.abs(joint.phase) * joint.radius;
  const tangentPoint = findEllipseTangentPoint(joint.center, ex, joint.radius, joint.azimuth, joint.phase, crossing);
  if (!tangentPoint || tangentPoint.capped) return null;
  const rimHit = segmentCircleHit(crossing, tangentPoint, joint.center, joint.radius);
  return rimHit && { tangentPoint, rimHit };
}

// The capsule cut along the seam line, or null when the line leaves the
// rim far from this capsule's edge (it would slice across the capsule).
function buildCut(seam, joint, a, b) {
  const line = joint && seamLine(joint, seam.crossing);
  if (!line) return null;
  const { center } = joint;
  const rimDiff = wrapAngle(Math.atan2(line.rimHit.y - center.y, line.rimHit.x - center.x) -
    Math.atan2(seam.tangentRim.y - center.y, seam.tangentRim.x - center.x));
  if (Math.abs(rimDiff) >= Math.PI / 2) return null;
  const pivot = seam.pivotIsA ? a : b;
  return {
    pivotIsC1: seam.pivotIsA, crossing: seam.crossing, rimHit: line.rimHit, tangentRim: seam.tangentRim,
    other: seam.crossing.extended
      ? { c1: pivot.center, r1: pivot.radius, c2: seam.otherFar.center, r2: seam.otherFar.radius }
      : null,
  };
}

// The crescent trim in the joint's local frame (see drawJointSplitCircle).
function buildTrim(joint, crossing) {
  const line = seamLine(joint, crossing);
  if (!line) return null;
  const { center, radius, azimuth, phase } = joint;
  const ex = Math.abs(phase) * radius;
  const cosA = Math.cos(-azimuth), sinA = Math.sin(-azimuth);
  const toLocal = (p) => {
    const dx = p.x - center.x, dy = p.y - center.y;
    return { x: dx * cosA - dy * sinA, y: dx * sinA + dy * cosA };
  };
  const tangentLocal = toLocal(line.tangentPoint);
  const angleT = Math.atan2(tangentLocal.y / radius, tangentLocal.x / Math.max(ex, 1e-4));
  const crossingLocal = toLocal(crossing);
  const dirAngle = Math.atan2(crossingLocal.y, crossingLocal.x);
  const angularDist = (p, q) => Math.abs(wrapAngle(p - q));
  const nearPole = angularDist(dirAngle, Math.PI / 2) <= angularDist(dirAngle, -Math.PI / 2) ? Math.PI / 2 : -Math.PI / 2;
  const farPole = -nearPole;
  return { start: farPole, end: angleT, anticlockwise: wrapAngle(angleT - farPole) < 0, rimHit: toLocal(line.rimHit) };
}

// A 2-node mesh sharing a node with a 3+ node mesh is drawn as a split
// cone; returns { hostMesh, splitNodeId } or null.
function findSplit(mesh, owners) {
  if (mesh.nodeIds.length !== 2) return null;
  const isHost = (mid) => meshes[mid].nodeIds.length >= 3;
  const splitNodeId = mesh.nodeIds.find(id => owners[id].some(isHost));
  return splitNodeId === undefined ? null : { splitNodeId, hostMesh: meshes[owners[splitNodeId].find(isHost)] };
}

// One primitive per node pair: a depth key plus either draw() or, for
// plain pieces, tracePath() (batched into one fill per mesh run).
function buildPairPrimitive(frame, mesh, a, b, screenCentroid, split) {
  const { ctx, camPos, projectPoint, projected, sharedNodeIds, jointNodeIds, joints, trimSources, drawnJointIds } = frame;
  const sharedA = sharedNodeIds.has(a.id);
  const sharedB = sharedNodeIds.has(b.id);
  const color = mesh.color;
  const touchesJoint = jointNodeIds.has(a.id) || jointNodeIds.has(b.id);

  const seam = findSeam(frame, mesh, a, b, sharedA, sharedB);
  const atJoint = seam && jointNodeIds.has(seam.pivotId);
  if (atJoint) trimSources.push(seam);

  const draw = () => {
    if (split) {
      const shared = nodes[split.splitNodeId];
      const far = nodes[mesh.nodeIds.find(id => id !== split.splitNodeId)];
      drawSplitCone(ctx, shared, far, projected[shared.id], projected[far.id], split.hostMesh.color, color, camPos, projectPoint);
      return;
    }

    const cut = atJoint ? buildCut(seam, joints[seam.pivotId], a, b) : null;
    // Only the first capsule drawn at a joint lays the seam band.
    const firstAtJoint = atJoint && !drawnJointIds.has(seam.pivotId);
    [a.id, b.id].forEach(id => { if (jointNodeIds.has(id)) drawnJointIds.add(id); });
    if (cut && firstAtJoint) drawSeamBand(ctx, cut, color);

    drawTriangle(ctx, screenCentroid,
      closestPointOnCircle(a.center, a.radius, screenCentroid),
      closestPointOnCircle(b.center, b.radius, screenCentroid), color);
    const masked = drawPairCapsule(ctx, a.center, a.radius, b.center, b.radius, color, sharedA, sharedB, cut);
    // A drawn cap already is the circle; filling it again would bulge.
    if ((sharedA || masked) && !jointNodeIds.has(a.id)) fillCircle(ctx, a.center, a.radius, color);
    if ((sharedB || masked) && !jointNodeIds.has(b.id)) fillCircle(ctx, b.center, b.radius, color);
  };

  const tracePath = (split || touchesJoint) ? null : () => {
    traceTriangle(ctx, screenCentroid,
      closestPointOnCircle(a.center, a.radius, screenCentroid),
      closestPointOnCircle(b.center, b.radius, screenCentroid));
    traceCapsule(ctx, a.center, a.radius, b.center, b.radius, sharedA, sharedB);
    if (sharedA) traceCircle(ctx, a.center, a.radius);
    if (sharedB) traceCircle(ctx, b.center, b.radius);
  };

  return { depth: Math.max(a.depth, b.depth), meshId: mesh.id, color, draw, tracePath };
}

function buildJointPrimitive(frame, nodeId) {
  const { ctx, projected, joints, trimSources } = frame;
  const joint = joints[nodeId];
  const source = trimSources.find(s => s.pivotId === nodeId);
  const trim = source ? buildTrim(joint, source.crossing) : null;
  return {
    depth: projected[nodeId].depth - 0.001,
    draw: () => drawJointSplitCircle(ctx, joint.center, joint.radius, joint.azimuth, joint.phase, joint.meshA.color, joint.meshB.color, trim),
  };
}

// Back to front. Consecutive traced primitives of one mesh become a single
// nonzero fill, so their shared edges don't stack (CLAUDE.md "Batching").
function drawPrimitives(ctx, primitives) {
  primitives.sort((p, q) => q.depth - p.depth);
  let batch = null;
  const flush = () => {
    if (!batch) return;
    ctx.fillStyle = batch.color;
    ctx.fill();
    batch = null;
  };
  primitives.forEach(p => {
    if (!p.tracePath) { flush(); p.draw(); return; }
    if (!batch || batch.meshId !== p.meshId) {
      flush();
      ctx.beginPath();
      batch = { meshId: p.meshId, color: p.color };
    }
    p.tracePath();
  });
  flush();
}

export function render(ctx, canvas, { darkMode }) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = GAP_DEBUG ? '#ff00ff' : (darkMode ? '#000000' : '#ffffff');
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  applyDesignSpaceTransform(ctx, canvas);

  const camPos = getCameraPosition();
  const basis = computeViewBasis(camPos, camera.target);
  const { projectPoint, projectNode } = makeProjector(camPos, basis);
  const projected = {};
  Object.values(nodes).forEach(node => { projected[node.id] = projectNode(node); });

  const owners = buildOwnership();
  const sharedNodeIds = new Set(Object.keys(owners).filter(id => owners[id].length >= 2).map(Number));
  const jointNodeIds = findJointNodeIds(owners);
  const frame = {
    ctx, camPos, projectPoint, projected, owners, sharedNodeIds, jointNodeIds,
    joints: computeJoints(jointNodeIds, owners, projected, camPos, basis),
    trimSources: [],         // seams at joints, for the crescent trims
    drawnJointIds: new Set(), // joints that already have a capsule drawn
  };

  const primitives = [];
  Object.values(meshes).forEach(mesh => {
    const screenCentroid = projectPoint(centroid(mesh.nodeIds.map(id => nodes[id].center)));
    const split = findSplit(mesh, owners);
    const pNodes = mesh.nodeIds.map(id => projected[id]);
    for (let i = 0; i < pNodes.length; i++) {
      for (let j = i + 1; j < pNodes.length; j++) {
        primitives.push(buildPairPrimitive(frame, mesh, pNodes[i], pNodes[j], screenCentroid, split));
      }
    }
  });
  Object.keys(frame.joints).forEach(key => primitives.push(buildJointPrimitive(frame, Number(key))));

  drawPrimitives(ctx, primitives);
}
