// Frame assembly: project -> ownership -> joints -> primitives -> depth
// sort -> batched draw. Terms (joint, joint ring, split cone): see CLAUDE.md.
import { DESIGN_WIDTH, DESIGN_HEIGHT, debug, focus } from './config.js';
import { buildJointCurve, edgeContacts } from './jointCurve.js';
import { projectJointSplit } from './jointSplit.js';
import { findSplitRing } from './splitRing.js';
import { buildConeDebugCurves, drawConeDebugCurves } from './coneDebug.js';
import { drawJointDebug } from './jointDebug.js';
import { vecSub, vecDot, vecCross, vecNormalize, closestPointOnCircle, circleRimPoint, convexHull, capsuleTangentPoints, pointInPolygon, subtractDisc, subtractPolygon } from './geometry.js';
import { camera, getCameraPosition, computeViewBasis, worldToCamera, makeProjector } from './camera.js';
import { nodes, meshes } from './scene.js';
import {
  seamUnderlap, fillCircle, drawTriangle, traceCapsule, traceCircle, traceTriangle,
  drawPairCapsule, drawJointBody, drawJointSplitFromCurve, drawSplitShared, drawSplitFar, splitRingPoints,
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

// A joint's geometry lives in the solid the flat renderer is drawing: every node
// is a sphere at its projected center with its projected radius (z = -depth * the
// joint node's px per world unit, so the arms keep their angle at the joint).
// Its orthographic silhouette is exactly the flat circles and their tangent hull,
// so the ring computed there (a plane conic, touch points on the rim, back arc on
// the disc) matches the discs, the cone edges and the debug lines to the pixel.
// Projecting is dropping z; the camera is at +z.
const flatView = {
  projectPoint: (w) => ({ x: w.x, y: w.y }),
  viewDirAt: () => ({ x: 0, y: 0, z: 1 }),
};

// Points of a cone's end (a split ring's projected circle) made consistent with
// the flat cone through the circles c1 and c2: points outside the flat capsule are
// moved onto its boundary, and the point nearest each of its two edges gets a
// copy on that edge, so the hull has the edges' exact lines there.
function alignToFlatCone(points, c1, c2) {
  const t = capsuleTangentPoints(c1.center, c1.radius, c2.center, c2.radius);
  const lines = [[t.p1a, t.p1b], [t.p2b, t.p2a]];
  if (![t.p1a, t.p1b, t.p2a, t.p2b].every(p => p && isFinite(p.x) && isFinite(p.y))) return points;
  const ring = (c) => Array.from({ length: 180 }, (_, i) => circleRimPoint(c.center, c.radius, (i / 180) * Math.PI * 2));
  const capsule = convexHull(ring(c1).concat(ring(c2)));
  const nearestOnSegment = (p, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
    const k = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    return { x: a.x + dx * k, y: a.y + dy * k };
  };
  const clamped = points.map(p => {
    if (pointInPolygon(p, capsule)) return p;
    let best = null, bestD = Infinity;
    capsule.forEach((a, i) => {
      const q = nearestOnSegment(p, a, capsule[(i + 1) % capsule.length]), d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bestD) { bestD = d; best = q; }
    });
    return best;
  });
  const feet = lines.map(([a, b]) => {
    const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
    const across = (p) => Math.abs(((p.x - a.x) * dy - (p.y - a.y) * dx) / l);
    const p = clamped.reduce((best, q) => (across(q) < across(best) ? q : best), clamped[0]);
    const k = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (l * l);
    return { x: a.x + dx * k, y: a.y + dy * k };
  });
  return [...clamped, ...feet];
}

// The polygon shrunk toward its centroid so its boundary moves in by about `d`
// (exact for a circle; for a ring's ellipse it moves in by d at the nearest side).
function insetPolygon(poly, d) {
  const c = poly.reduce((s, p) => ({ x: s.x + p.x / poly.length, y: s.y + p.y / poly.length }), { x: 0, y: 0 });
  const near = Math.min(...poly.map(p => Math.hypot(p.x - c.x, p.y - c.y)));
  const k = Math.max(0.5, 1 - d / (near || 1));
  return poly.map(p => ({ x: c.x + (p.x - c.x) * k, y: c.y + (p.y - c.y) * k }));
}

// Each joint: its ring (jointCurve.js), which mesh is in front of it (frontIsA:
// the cone on the camera's side of the ring plane) and its phase, the depth sign
// of the axis between the two meshes' directions in camera space.
function computeJoints(jointNodeIds, owners, projected, camPos, basis, projectPoint) {
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
    const pz = projected[nodeId].radius / nodes[nodeId].radius;
    const flat = (id) => ({ center: { ...projected[id].center, z: -projected[id].depth * pz }, radius: projected[id].radius });
    const curve = buildJointCurve(flat(nodeId), flat(farNode(meshA).id), flat(farNode(meshB).id));
    // The ring's plane separates the two cones, so the cone on the camera's side
    // of it is the front one (the phase says the same, except in edge-on views).
    let frontIsA = axis.z / axisLen >= 0;
    if (curve.hasTouch) {
      const camSide = curve.plane.z, armSide = vecDot(vecSub(flat(farNode(meshA).id).center, curve.touch[0].p), curve.plane);
      if (camSide * armSide !== 0) frontIsA = camSide * armSide > 0;
    }
    const screen = (pts) => pts.map(q => ({ x: q.p.x, y: q.p.y }));
    const flatA = flat(farNode(meshA).id), flatB = flat(farNode(meshB).id);
    const contacts = edgeContacts(flat(nodeId), flatA, flatB, curve).map(cone => cone.map(e => ({
      near: { x: e.near.x, y: e.near.y }, contact: e.contact && { x: e.contact.x, y: e.contact.y },
    })));
    const usable = curve.hasTouch && curve.front.length >= 3;
    joints[nodeId] = {
      farA: farNode(meshA), farB: farNode(meshB),
      frontIsA, contacts,
      frontArc: usable ? screen(curve.front) : null,
      // A point inside both the ring and the node circle: the touch points' midpoint.
      inner: usable ? { x: (curve.touch[0].p.x + curve.touch[1].p.x) / 2, y: (curve.touch[0].p.y + curve.touch[1].p.y) / 2 } : null,
      loop: usable ? screen(curve.loop) : null,
      farProjA: projected[farNode(meshA).id], farProjB: projected[farNode(meshB).id],
      curve,
      view: flatView,
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
    // (The host-colored shared part belongs to the host: hidden in the focus view.)
    if (!focus.on) frame.extraPrimitives.push({
      depth: hostMax + 0.0005,
      draw: () => drawSplitShared(ctx, sharedProj, splitRing, axisCam, split.hostMesh.color, projectPoint),
    });
  }

  // A cone ending at a joint stops at the joint ring: its body is the hull of
  // the other end's circle and the ring's front arc; where it is the front mesh
  // it also fills the whole ring's interior (CLAUDE.md "Joint ring").
  const discRadius = (joint) => Math.max(joint.radius - seamUnderlap(ctx), 0.5 * joint.radius);
  const circlePoints = (c) => Array.from({ length: 64 }, (_, i) => circleRimPoint(c.center, c.radius, (i / 64) * Math.PI * 2));
  // A cone's body where it ends at joints (every cone arriving at a 2-to-2 shared
  // node, split cone or not): `basePoints` are the hull points of the rest of the
  // cone, `joints` the joints it ends at. The cone truncated at a ring is convex:
  // the hull of the rest, the ring's front arc and the flat node circle's rim on
  // its own side of the ring plane (CLAUDE.md "Joint ring"). The body stops at the
  // ring (its interior is cut out; the front cone fills it) and at the flat node
  // circle (the joint disc is drawn over it), whichever it meets first: it follows
  // the ring where the ring leaves the node, the flat rim elsewhere. The cut disc
  // is pulled in by the seam underlap so the body reaches under the disc's
  // antialiased rim (rule 1).
  const drawAtJoints = (basePoints, joints) => {
    const points = [...basePoints], fills = [], cutLoops = [], closings = [];
    joints.forEach(joint => {
      const isFront = (joint.frontIsA ? joint.meshA : joint.meshB) === mesh;
      if (isFront) fills.push(...subtractDisc(joint.loop, joint.center, discRadius(joint)));
      // The back cone is cut a little inside the ring, so it reaches under the
      // front cone's antialiased edge along the ring (rule 1); the front cone's
      // fill and outline share the ring's exact edge in one path.
      cutLoops.push(isFront ? joint.loop : insetPolygon(joint.loop, seamUnderlap(ctx)));
      // The cone's two edges STOP at a known point each: where it touches the ring
      // (the green dot, exact) or, if it doesn't, where it meets the node's circle.
      // Those two stopping points are the only hull points at this end, so each edge
      // ends exactly at its stop. The hull would close with the straight line between
      // them; instead that line is routed through a point inside both the ring and the
      // node circle (the midpoint of the touch points), so the closing path lies
      // entirely in what is cut out next (the ring's interior and the node circle).
      // What is left is then bounded by the real path: the ring arc where the ring
      // leaves the node, the flat rim elsewhere. (With no silhouette, an arm pointing
      // at the camera, the ring's front arc is used.)
      const side = joint.meshA === mesh ? 0 : 1, stops = joint.contacts[side];
      if (stops.length === 2) {
        const pair = stops.map(e => ({ ...(e.contact || e.near) }));
        points.push(...pair);
        closings.push({ pair, via: joint.inner });
      } else points.push(...joint.frontArc);
    });
    let hull = convexHull(points);
    closings.forEach(({ pair, via }) => {
      const n = hull.length, i = hull.indexOf(pair[0]), j = hull.indexOf(pair[1]);
      if (i < 0 || j < 0 || !via) return;
      // The two stops are neighbors on the hull (the chord); put the via point between them.
      const after = (j - i + n) % n === 1 ? i : ((i - j + n) % n === 1 ? j : -1);
      if (after >= 0) hull = [...hull.slice(0, after + 1), via, ...hull.slice(after + 1)];
    });
    let outline = [hull];
    joints.forEach(joint => { outline = outline.flatMap(poly => subtractDisc(poly, joint.center, discRadius(joint))); });
    cutLoops.forEach(loop => { outline = outline.flatMap(poly => subtractPolygon(poly, loop)); });
    drawJointBody(ctx, [...outline, ...fills], color);
  };
  const draw = () => {
    if (split) {
      const far = projected[mesh.nodeIds.find(id => id !== split.splitNodeId)];
      const joint = jointNodeIds.has(far.id) ? frame.joints[far.id] : null;
      if (joint && joint.frontArc) {
        // The cone's own part, from the split ring to a joint: the joint logic at that end.
        // The split ring is projected in perspective, but the joint works in the flat
        // model (the dotted edges are tangents of the flat circles): its ends are
        // aligned to those two lines so the outline leaves them exactly at the ring.
        drawAtJoints(alignToFlatCone(splitRingPoints(splitRing, projectPoint), far, projected[split.splitNodeId]), [joint]);
        return;
      }
      drawSplitFar(ctx, far, splitRing, color, projectPoint, { farIsJoint: jointNodeIds.has(far.id) });
      return;
    }
    if (touchesJoint) {
      const joints = [], basePoints = [];
      [a, b].forEach(end => {
        const joint = frame.joints[end.id];
        if (joint && joint.frontArc) joints.push(joint); else basePoints.push(...circlePoints(end));
      });
      drawAtJoints(basePoints, joints);
      return;
    }
    drawTriangle(ctx, screenCentroid,
      closestPointOnCircle(a.center, a.radius, screenCentroid),
      closestPointOnCircle(b.center, b.radius, screenCentroid), color);
    drawPairCapsule(ctx, a.center, a.radius, b.center, b.radius, color, sharedA, sharedB);
    if (sharedA) fillCircle(ctx, a.center, a.radius, color);
    if (sharedB) fillCircle(ctx, b.center, b.radius, color);
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

  const prim = { depth, meshId: mesh.id, color, draw, tracePath };
  [a, b].forEach(end => { if (jointNodeIds.has(end.id)) (frame.jointBodies[end.id] ||= []).push({ meshId: mesh.id, prim, isSplit: !!split }); });
  return prim;
}

// Sort key of a joint's disc: just in front of its node, and behind any split
// cone ending there.
function jointDepth(frame, nodeId) {
  const { projected, joints, coneDepths } = frame;
  const joint = joints[nodeId];
  return Math.min(projected[nodeId].depth - 0.001, ...[joint.meshA.id, joint.meshB.id].map(id => (coneDepths[id] ?? Infinity) - 0.0001));
}

// The front mesh's body (the one on the camera's side of the ring) must draw
// after the back one, over the lens where they overlap. The sort key (depth of a
// capsule's farther node) can tie or order them wrongly when both arms point at
// the camera, so settle it here. A split cone keeps its own layered key. A body
// can sit at two joints (a cone between two joints is one primitive), so all the
// joints are settled together: settling them one by one let the last joint undo
// the first (orange drawn over blue at the blue/orange joint because the
// orange/yellow joint put orange right after the yellow split cone). The back body
// moves to be drawn earlier, unless it is a split cone or is itself the front body
// at another joint; then the front body moves to be drawn later.
const ORDER_EPS = 0.0005;
function orderJointBodies(frame) {
  const pairs = [];
  Object.keys(frame.joints).forEach(key => {
    const joint = frame.joints[key], bodies = frame.jointBodies[key];
    if (!bodies || bodies.length !== 2) return;
    const frontId = joint.frontIsA ? joint.meshA.id : joint.meshB.id;
    const front = bodies.find(body => body.meshId === frontId), back = bodies.find(body => body !== front);
    if (front && back) pairs.push({ front, back });
  });
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    pairs.forEach(pair => {
      const { front, back } = pair;
      if (back.prim.depth >= front.prim.depth + ORDER_EPS) return;
      const backLeadsElsewhere = pairs.some(p => p !== pair && p.front.prim === back.prim);
      if (!back.isSplit && !backLeadsElsewhere) back.prim.depth = front.prim.depth + ORDER_EPS;
      else if (!front.isSplit) front.prim.depth = back.prim.depth - ORDER_EPS;
      else return;
      changed = true;
    });
    if (!changed) break;
  }
}

function buildJointPrimitive(frame, nodeId) {
  const { ctx, projected, joints } = frame;
  const joint = joints[nodeId];
  // The dominant mesh is the front one; its side of the ring is the dominant region.
  const dominantA = joint.frontIsA;
  const dominantColor = dominantA ? joint.meshA.color : joint.meshB.color;
  const crescentColor = dominantA ? joint.meshB.color : joint.meshA.color;
  const split = projectJointSplit(joint.curve, joint.center, joint.radius, joint.view,
    projected[(dominantA ? joint.farA : joint.farB).id].center);
  return {
    // A split cone ending here must go under the joint circle.
    depth: jointDepth(frame, nodeId),
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

// The last frame's data (joints, body outlines), for test harnesses.
export let lastFrame = null;

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
    joints: computeJoints(jointNodeIds, owners, projected, camPos, basis, projectPoint),
    coneDepths: {},          // split cone mesh id -> sort key, for joints at their far end
    jointBodies: {},         // joint node id -> the two meshes' bodies there (draw order)
    extraPrimitives: [],     // split cones' host-colored parts, sorted with the rest
  };

  const primitives = [];
  // The focus view draws only some meshes; everything else is still computed with all of them.
  const isShown = (mesh) => !focus.on || focus.meshColors.includes(mesh.color);
  Object.values(meshes).forEach(mesh => {
    if (!isShown(mesh)) return;
    const screenCentroid = projectPoint(centroid(mesh.nodeIds.map(id => nodes[id].center)));
    const split = findSplit(mesh, owners);
    const pNodes = mesh.nodeIds.map(id => projected[id]);
    for (let i = 0; i < pNodes.length; i++) {
      for (let j = i + 1; j < pNodes.length; j++) {
        primitives.push(buildPairPrimitive(frame, mesh, pNodes[i], pNodes[j], screenCentroid, split));
      }
    }
  });
  const jointPrims = {};
  Object.keys(frame.joints).forEach(key => {
    const joint = frame.joints[key];
    if (!isShown(joint.meshA) || !isShown(joint.meshB)) { delete frame.joints[key]; return; }
    primitives.push(jointPrims[key] = buildJointPrimitive(frame, Number(key)));
  });
  orderJointBodies(frame);
  // A joint's disc stays after its bodies, wherever the ordering moved them.
  Object.keys(jointPrims).forEach(key => {
    const bodies = frame.jointBodies[key] || [];
    jointPrims[key].depth = Math.min(jointPrims[key].depth, ...bodies.map(b => b.prim.depth - 0.0001));
  });
  primitives.push(...frame.extraPrimitives);

  drawPrimitives(ctx, primitives);

  lastFrame = frame;

  if (debug.on && debug.joint) drawJointDebug(ctx, frame.joints);

  if (debug.on && debug.cone && !focus.on) {
    Object.values(meshes).forEach(mesh => {
      const split = findSplit(mesh, owners);
      if (split) drawConeDebugCurves(ctx, buildConeDebugCurves(split, mesh, split.hostMesh, camPos, projectPoint));
    });
  }
}
