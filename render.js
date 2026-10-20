// Frame assembly: project -> ownership -> joints -> primitives -> depth
// sort -> batched draw. Terms (joint, joint ring, split cone): see CLAUDE.md.
import { DESIGN_WIDTH, DESIGN_HEIGHT, debug, SPLIT_STRIP_MAX_FLAT } from './config.js';
import { drawJointDebug } from './jointDebug.js';
import { buildJointCurve } from './jointCurve.js';
import { projectJointSplit } from './jointSplit.js';
import { findSplitRing } from './splitRing.js';
import { buildConeDebugCurves, drawConeDebugCurves } from './coneDebug.js';
import { vecSub, vecDot, vecNormalize, closestPointOnCircle } from './geometry.js';
import { camera, getCameraPosition, computeViewBasis, worldToCamera, makeProjector } from './camera.js';
import { nodes, meshes } from './scene.js';
import {
  fillCircle, drawTriangle, traceCapsule, traceCircle, traceTriangle,
  drawPairCapsule, drawJointSplitFromCurve, drawSplitShared, drawSplitFar, drawSplitStrip,
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

// Each joint: its ring (jointCurve.js) and its phase, the depth sign of the
// axis between the two meshes' directions in camera space (phase >= 0: meshA
// is the nearer one and dominates the disc).
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
      phase: axis.z / axisLen,
      meshA, meshB,
    };
  });
  return joints;
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
  const { ctx, camPos, projectPoint, projected, sharedNodeIds, splitNodeIds, basis, jointNodeIds } = frame;
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

  const draw = () => {
    if (split) {
      const far = projected[mesh.nodeIds.find(id => id !== split.splitNodeId)];
      drawSplitFar(ctx, far, splitRing, color, projectPoint, { farIsJoint: jointNodeIds.has(far.id) });
      return;
    }

    drawTriangle(ctx, screenCentroid,
      closestPointOnCircle(a.center, a.radius, screenCentroid),
      closestPointOnCircle(b.center, b.radius, screenCentroid), color);
    drawPairCapsule(ctx, a.center, a.radius, b.center, b.radius, color, sharedA, sharedB);
    // A joint's disc is its own primitive; any other shared end is the circle here.
    if (sharedA && !jointNodeIds.has(a.id)) fillCircle(ctx, a.center, a.radius, color);
    if (sharedB && !jointNodeIds.has(b.id)) fillCircle(ctx, b.center, b.radius, color);
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
  const { ctx, projected, joints, coneDepths, camPos, projectPoint } = frame;
  const joint = joints[nodeId];
  // The dominant mesh is the nearer one (phase >= 0: meshA); its side of the
  // ring is the dominant region.
  const dominantA = joint.phase >= 0;
  const dominantColor = dominantA ? joint.meshA.color : joint.meshB.color;
  const crescentColor = dominantA ? joint.meshB.color : joint.meshA.color;
  const split = projectJointSplit(joint.curve, joint.center, joint.radius, { camPos, projectPoint },
    projected[(dominantA ? joint.farA : joint.farB).id].center);
  return {
    // A split cone ending here must go under the joint circle.
    depth: Math.min(projected[nodeId].depth - 0.001, ...[joint.meshA.id, joint.meshB.id].map(id => (coneDepths[id] ?? Infinity) - 0.0001)),
    // No usable ring in view (e.g. one arm points at the camera): one color.
    draw: () => (split
      ? drawJointSplitFromCurve(ctx, joint.center, joint.radius, split, dominantColor, crescentColor)
      : fillCircle(ctx, joint.center, joint.radius, dominantColor)),
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

  if (debug.on && debug.joint) drawJointDebug(ctx, frame.joints, { camPos, projectPoint });

  if (debug.on && debug.cone) {
    Object.values(meshes).forEach(mesh => {
      const split = findSplit(mesh, owners);
      if (split) drawConeDebugCurves(ctx, buildConeDebugCurves(split, mesh, split.hostMesh, camPos, projectPoint));
    });
  }
}
