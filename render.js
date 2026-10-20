// Frame assembly: project -> ownership -> joints -> primitives -> depth
// sort -> batched draw. Terms (joint, seam line, cut, trim): see CLAUDE.md.
import { DESIGN_WIDTH, DESIGN_HEIGHT, debug, JOINT_FROM_CURVE, SPLIT_STRIP_MAX_FLAT } from './config.js';
import { drawJointDebug } from './jointDebug.js';
import { buildJointCurve } from './jointCurve.js';
import { projectJointSplit } from './jointSplit.js';
import { findSplitRing } from './splitRing.js';
import { buildConeDebugCurves, drawConeDebugCurves } from './coneDebug.js';
import {
  vecSub, vecDot, vecNormalize, wrapAngle, circleRimPoint, closestPointOnCircle,
  computePairTangents, edgeSegment, findEdgeCrossing, segmentCircleHit, findEllipseTangentPoint,
} from './geometry.js';
import { camera, getCameraPosition, computeViewBasis, worldToCamera, makeProjector } from './camera.js';
import { nodes, meshes } from './scene.js';
import {
  fillCircle, drawTriangle, traceCapsule, traceCircle, traceTriangle,
  drawPairCapsule, drawSeamBand, drawJointSplitCircle, drawJointSplitFromCurve, drawSplitShared, drawSplitFar, drawSplitStrip,
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
    const farNode = (mesh) => nodes[mesh.nodeIds.find(id => id !== nodeId)];
    joints[nodeId] = {
      farA: farNode(meshA), farB: farNode(meshB),
      curve: buildJointCurve(nodes[nodeId], farNode(meshA), farNode(meshB)),
      center: p.center,
      radius: p.radius,
      azimuth: Math.atan2(-axis.y / axisLen, axis.x / axisLen),
      phase: axis.z / axisLen,
      meshA, meshB,
    };
  });
  return joints;
}

// The seam at one joint end of a pair: for each other mesh at the pivot
// node, where this capsule's edge crosses that capsule's edge; the longest
// wins. seam = { crossing, tangentRim, pivotIsA, pivotId, otherFar }.
function findSeamAt(frame, mesh, pivot, other, pivotIsA) {
  const { owners, projected } = frame;
  let seam = null, seamLen = -1;
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
  return seam;
}

// One seam per joint end of this pair (a capsule can be a joint at both ends).
function findSeams(frame, mesh, a, b, jointA, jointB) {
  return [jointA && findSeamAt(frame, mesh, a, b, true), jointB && findSeamAt(frame, mesh, b, a, false)].filter(Boolean);
}

// The seam line at a joint: from the crossing, tangent to the terminator,
// to where it leaves the rim. Shared by the capsule cut and the crescent
// trim, so they always agree.
function seamLine(joint, crossing) {
  const ex = Math.abs(joint.phase) * joint.radius;
  const tangentPoint = findEllipseTangentPoint(joint.center, ex, joint.radius, joint.azimuth, joint.phase, crossing);
  if (!tangentPoint) return null;
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
    pivotId: seam.pivotId, pivotIsC1: seam.pivotIsA, crossing: seam.crossing, rimHit: line.rimHit, tangentRim: seam.tangentRim,
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
  let angleT = Math.atan2(tangentLocal.y / radius, tangentLocal.x / Math.max(ex, 1e-4));
  // The crescent lies on the phase's side; a tangent at a pole may land a hair
  // past it, so pull it back onto that half.
  const crescentOnPositive = phase >= 0;
  if ((Math.cos(angleT) >= 0) !== crescentOnPositive) angleT = (Math.sin(angleT) >= 0 ? 1 : -1) * Math.PI / 2;
  const crossingLocal = toLocal(crossing);
  const dirAngle = Math.atan2(crossingLocal.y, crossingLocal.x);
  const angularDist = (p, q) => Math.abs(wrapAngle(p - q));
  const nearPole = angularDist(dirAngle, Math.PI / 2) <= angularDist(dirAngle, -Math.PI / 2) ? Math.PI / 2 : -Math.PI / 2;
  const farPole = -nearPole;
  // From the far pole to the tangent point through the crescent's half (not
  // by the sign of a difference that is +-PI when the tangent is at the pole).
  return { start: farPole, end: angleT, anticlockwise: crescentOnPositive === (farPole > 0), rimHit: toLocal(line.rimHit) };
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
  const { ctx, camPos, projectPoint, projected, sharedNodeIds, splitNodeIds, basis, jointNodeIds, joints, trimSources, drawnJointIds } = frame;
  const sharedA = sharedNodeIds.has(a.id);
  const sharedB = sharedNodeIds.has(b.id);
  const color = mesh.color;
  const touchesJoint = jointNodeIds.has(a.id) || jointNodeIds.has(b.id);

  // A split cone is two primitives, sorted in layers around its host: far
  // parts of cones facing away, then every cone's host-colored shared part,
  // then far parts of cones facing the camera (CLAUDE.md "Split cone").
  const splitRing = split && findSplitRing(nodes[split.splitNodeId], nodes[mesh.nodeIds.find(id => id !== split.splitNodeId)], split.hostMesh);
  let depth = Math.max(a.depth, b.depth);
  if (splitRing) {
    const hostDepths = split.hostMesh.nodeIds.map(id => projected[id].depth);
    const hostMin = Math.min(...hostDepths), hostMax = Math.max(...hostDepths);
    const facing = vecDot(vecNormalize(vecSub(camPos, splitRing.surface)), splitRing.dir);
    // Cones on the same node: the one pointing more toward the camera is nearer, drawn later.
    depth = (facing > 0 ? hostMin - 0.001 : hostMax + 0.001) - 1e-4 * facing;
    frame.coneDepths[mesh.id] = depth;
    const sharedProj = projected[split.splitNodeId];
    const axisCam = { x: vecDot(splitRing.dir, basis.right), y: vecDot(splitRing.dir, basis.up) };
    frame.extraPrimitives.push({
      depth: hostMax + 0.0005,
      draw: () => drawSplitShared(ctx, sharedProj, splitRing, axisCam, split.hostMesh.color, projectPoint),
    });
    // Drawn before the host, edge-on: lay the far color over the host's bulge.
    if (facing <= 0 && -facing < SPLIT_STRIP_MAX_FLAT) {
      frame.extraPrimitives.push({
        depth: hostMin - 0.002,
        draw: () => drawSplitStrip(ctx, splitRing, color, projectPoint),
      });
    }
  }

  // A split cone's shared end is the host's business; only its other end can be a joint.
  const isSplitEnd = (n) => split && n.id === split.splitNodeId;
  const seams = findSeams(frame, mesh, a, b, jointNodeIds.has(a.id) && !isSplitEnd(a), jointNodeIds.has(b.id) && !isSplitEnd(b));
  seams.forEach(seam => trimSources.push(seam));

  const draw = () => {
    // One cut per joint end. Only the first capsule drawn at a joint lays the seam band.
    const ends = seams.map(seam => ({
      cut: buildCut(seam, joints[seam.pivotId], a, b), first: !drawnJointIds.has(seam.pivotId),
    })).filter(e => e.cut);
    [a.id, b.id].forEach(id => { if (jointNodeIds.has(id)) drawnJointIds.add(id); });
    ends.forEach(({ cut, first }) => { if (first) drawSeamBand(ctx, cut, color); });
    const cuts = ends.map(e => e.cut);

    if (split) {
      const far = projected[mesh.nodeIds.find(id => id !== split.splitNodeId)];
      drawSplitFar(ctx, far, splitRing, color, projectPoint, { farIsJoint: jointNodeIds.has(far.id), cut: cuts[0] || null, ends: [a, b] });
      return;
    }

    drawTriangle(ctx, screenCentroid,
      closestPointOnCircle(a.center, a.radius, screenCentroid),
      closestPointOnCircle(b.center, b.radius, screenCentroid), color);
    const masked = drawPairCapsule(ctx, a.center, a.radius, b.center, b.radius, color, sharedA, sharedB, cuts);
    // A drawn cap already is the circle; filling it again would bulge.
    if ((sharedA || masked) && !jointNodeIds.has(a.id)) fillCircle(ctx, a.center, a.radius, color);
    if ((sharedB || masked) && !jointNodeIds.has(b.id)) fillCircle(ctx, b.center, b.radius, color);
  };

  const tracePath = (split || touchesJoint) ? null : () => {
    traceTriangle(ctx, screenCentroid,
      closestPointOnCircle(a.center, a.radius, screenCentroid),
      closestPointOnCircle(b.center, b.radius, screenCentroid));
    traceCapsule(ctx, a.center, a.radius, b.center, b.radius, sharedA, sharedB);
    // A split node's disc belongs to its cone (drawSplitShared), which clips it to the ring plane.
    if (sharedA && !splitNodeIds.has(a.id)) traceCircle(ctx, a.center, a.radius);
    if (sharedB && !splitNodeIds.has(b.id)) traceCircle(ctx, b.center, b.radius);
  };

  return { depth, meshId: mesh.id, color, draw, tracePath };
}

function buildJointPrimitive(frame, nodeId) {
  const { ctx, projected, joints, trimSources, coneDepths, camPos, projectPoint } = frame;
  const joint = joints[nodeId];
  const source = trimSources.find(s => s.pivotId === nodeId);
  const trim = source ? buildTrim(joint, source.crossing) : null;
  // The dominant mesh is the nearer one (phase >= 0: meshA); its side of the terminator is the dominant region.
  const dominantA = joint.phase >= 0;
  const curveSplit = JOINT_FROM_CURVE
    ? projectJointSplit(joint.curve, joint.center, joint.radius, { camPos, projectPoint },
        projected[(dominantA ? joint.farA : joint.farB).id].center)
    : null;
  return {
    // A split cone ending here must go under the joint circle.
    depth: Math.min(projected[nodeId].depth - 0.001, ...[joint.meshA.id, joint.meshB.id].map(id => (coneDepths[id] ?? Infinity) - 0.0001)),
    draw: () => (curveSplit
      ? drawJointSplitFromCurve(ctx, joint.center, joint.radius, curveSplit,
          dominantA ? joint.meshA.color : joint.meshB.color, dominantA ? joint.meshB.color : joint.meshA.color)
      : drawJointSplitCircle(ctx, joint.center, joint.radius, joint.azimuth, joint.phase, joint.meshA.color, joint.meshB.color, trim)),
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
  ctx.fillStyle = (debug.on && debug.gap) ? '#ff00ff' : (darkMode ? '#000000' : '#ffffff');
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
    ctx, camPos, basis, projectPoint, projected, owners, sharedNodeIds, jointNodeIds,
    splitNodeIds: new Set(Object.values(meshes).map(m => findSplit(m, owners)).filter(Boolean).map(s => s.splitNodeId)),
    joints: computeJoints(jointNodeIds, owners, projected, camPos, basis),
    coneDepths: {},          // split cone mesh id -> sort key, for joints at their far end
    extraPrimitives: [],     // split-cone strips, sorted with the rest
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
  primitives.push(...frame.extraPrimitives);

  drawPrimitives(ctx, primitives);

  if (debug.on && debug.joint) drawJointDebug(ctx, frame.joints, frame.trimSources, seamLine, { camPos, projectPoint });

  if (debug.on && debug.cone) {
    Object.values(meshes).forEach(mesh => {
      const split = findSplit(mesh, owners);
      if (split) drawConeDebugCurves(ctx, buildConeDebugCurves(split, mesh, split.hostMesh, camPos, projectPoint));
    });
  }
}
