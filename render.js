// Frame assembly: project -> ownership -> joints -> primitives -> depth
// sort -> batched draw. Terms (joint, joint ring, split cone): see CLAUDE.md.
import { DESIGN_WIDTH, DESIGN_HEIGHT, debug, focus, strokes, lighting } from './config.js';
import { makeShading } from './shading.js';
import { SHADE, TWILIGHT, toneColor } from './light.js';
import { buildJointCurve, edgeContacts } from './jointCurve.js';
import { buildJointCurveGeneral, edgeContactsGeneral } from './jointCurveGeneral.js';
import { projectJointSplit } from './jointSplit.js';
import { findSplitRing } from './splitRing.js';
import { buildConeDebugCurves, drawConeDebugCurves } from './coneDebug.js';
import { drawJointDebug } from './jointDebug.js';
import { drawShapeDebug } from './shapeDebug.js';
import { shadowEllipse, vecSub, vecDot, vecNormalize, closestPointOnCircle, ellipseRayPoint, ellipsePoint, ellipsoidShape, ellipseCapsule, hullOutline, outlinePolygon, ellipseParam, ellipseArc, mapArc, arcPoint, loopBox, untwistLoop, capsuleTangentPoints, pointInPolygon, subtractDisc, subtractPolygon } from './geometry.js';
import { camera, getCameraPosition, computeViewBasis, worldToCamera, makeProjector } from './camera.js';
import { nodes, meshes } from './scene.js';
import { archAt, archSamples, shapeAt, inverse } from './skew.js';
import {
  pixelScale, seamUnderlap, fillCircle, circlePoints, traceCapsule, traceCircle, traceTriangle,
  nodeEllipse, traceEllipseCapsule, traceEllipse, splitScreenPoints, drawSplitSharedGeneral, drawSplitFarGeneral,
  drawJointBody, drawJointSplitFromCurve, drawSplitShared, drawSplitFar, splitRingPoints,
} from './shapes.js';

// How far a polyline of a joint curve may stray from the curve, in device pixels.
const CURVE_TOL_PX = 0.02;

// Depth strata (CLAUDE.md "Layering"). A piece whose depth runs across several strata (a cone nearer at one
// end than another piece and farther at the other) is cut into one slab per stratum; slabs are drawn
// farthest stratum first, and within a stratum by the piece's own sort key, so every layering rule that
// works on piece keys (host layers, joint bodies) still holds inside a stratum.
const DEPTH_BIN = 16;
// Slice descriptor of a piece along the screen line from node p to node q: the unit axis, the offsets s0 / s1
// of the two centers along it, and the end depths (depth is a linear ramp between them, flat beyond).
function makeSlice(p, q) {
  const dx = q.center.x - p.center.x, dy = q.center.y - p.center.y, dist = Math.hypot(dx, dy);
  if (dist < 1 || p.depth === q.depth) return null;
  const ax = dx / dist, ay = dy / dist, s0 = p.center.x * ax + p.center.y * ay;
  return { ax, ay, s0, s1: s0 + dist, d0: p.depth, d1: q.depth };
}
// An ink owner is a mesh id, or "id.half" for one half of a skewed mesh that folds over itself.
const meshOf = (owner) => meshes[typeof owner === 'string' ? parseInt(owner, 10) : owner];
const boxesMeet = (p, q) => p.x0 <= q.x1 && q.x0 <= p.x1 && p.y0 <= q.y1 && q.y0 <= p.y1;
// Colors worn by two or more different meshes among the pieces to draw (the ones that get border strokes), or none when
// strokes are off or the browser lacks Path2D / DOMMatrix / an offscreen canvas.
function strokeColorsOf(primitives) {
  const none = new Set();
  if (!strokes.on || typeof Path2D === 'undefined' || typeof DOMMatrix === 'undefined' || (typeof OffscreenCanvas === 'undefined' && typeof document === 'undefined')) return none;
  const byColor = new Map();
  primitives.forEach(p => (p.owners || [p.meshId]).forEach(id => {
    if (id === undefined) return;
    const color = meshOf(id).color, set = byColor.get(color) || byColor.set(color, new Set()).get(color);
    set.add(id);
  }));
  return new Set([...byColor].filter(([, ids]) => ids.size > 1).map(([color]) => color));
}
// Scratch canvases the size of the main one, kept between frames: stroke, mask, piece group, and for the strokes' tones
// the frame's lit map, the front fill's lit mask and a dilation layer.
let layerCache = null;
function scratchLayers(ctx) {
  const { width, height } = ctx.canvas;
  if (!layerCache || layerCache[0].width !== width || layerCache[0].height !== height) {
    const make = () => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height }));
    layerCache = [make(), make(), make(), make(), make(), make()];
  }
  return layerCache;
}
// The screen box of some projected nodes (discs or ellipses) and optional extra points, with a margin:
// what a primitive between those nodes can cover. Used to tell which pieces can overlap.
function boxOf(projs, points = []) {
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  projs.forEach(p => {
    const rad = Math.max(p.radius, p.ellipse ? p.ellipse.a : 0) + 3;
    box.x0 = Math.min(box.x0, p.center.x - rad); box.x1 = Math.max(box.x1, p.center.x + rad);
    box.y0 = Math.min(box.y0, p.center.y - rad); box.y1 = Math.max(box.y1, p.center.y + rad);
  });
  points.forEach(q => { box.x0 = Math.min(box.x0, q.x - 3); box.x1 = Math.max(box.x1, q.x + 3); box.y0 = Math.min(box.y0, q.y - 3); box.y1 = Math.max(box.y1, q.y + 3); });
  return box;
}
const boxesOverlap = (p, q) => !p || !q || (p.x0 <= q.x1 && q.x0 <= p.x1 && p.y0 <= q.y1 && q.y0 <= p.y1);

// A piece's rough shape for the "is it in the way" tests: capsules { x0, y0, x1, y1, r } along its axis (a long
// diagonal piece has a huge box that overlaps almost everything; its capsule does not). r is the larger end radius
// plus a margin, so the shape contains the piece (the hull of two circles lies in the capsule of the larger one);
// kp / kq widen an end that reaches beyond its node's circle (a joint body's lens, up to ~1.3 radii past the center).
function capsuleOf(p, q, kp = 1, kq = 1) {
  const reach = (n) => Math.max(n.radius, n.ellipse ? n.ellipse.a : 0);
  return { x0: p.center.x, y0: p.center.y, x1: q.center.x, y1: q.center.y, r: Math.max(reach(p) * kp, reach(q) * kq) + 3 };
}
// Squared distance from a point to a segment, and the distance between two segments (0 when they cross).
function pointSeg2(px, py, a) {
  const dx = a.x1 - a.x0, dy = a.y1 - a.y0, l2 = dx * dx + dy * dy, t = l2 > 0 ? Math.max(0, Math.min(1, ((px - a.x0) * dx + (py - a.y0) * dy) / l2)) : 0;
  const ex = a.x0 + dx * t - px, ey = a.y0 + dy * t - py;
  return ex * ex + ey * ey;
}
function segDistance(a, b) {
  const rx = a.x1 - a.x0, ry = a.y1 - a.y0, sx = b.x1 - b.x0, sy = b.y1 - b.y0, den = rx * sy - ry * sx;
  if (Math.abs(den) > 1e-12) {
    const t = ((b.x0 - a.x0) * sy - (b.y0 - a.y0) * sx) / den, u = ((b.x0 - a.x0) * ry - (b.y0 - a.y0) * rx) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  return Math.sqrt(Math.min(pointSeg2(a.x0, a.y0, b), pointSeg2(a.x1, a.y1, b), pointSeg2(b.x0, b.y0, a), pointSeg2(b.x1, b.y1, a)));
}
// Can two pieces overlap on screen? Their boxes first, then their capsules.
function piecesOverlap(p, q) {
  if (!boxesOverlap(p.box, q.box)) return false;
  if (!p.caps || !q.caps) return true;
  return p.caps.some(a => q.caps.some(b => segDistance(a, b) <= a.r + b.r));
}

// The slabs of a primitive: { prim, bin, lo, hi }, [lo, hi] the strip along the slice axis (the ends
// beyond the two centers, caps included, are unbounded). A piece within one stratum is one slab.
const slabsOf = rawSlabs;
function rawSlabs(prim) {
  const bin = (d) => Math.floor(d / DEPTH_BIN), sl = prim.slice;
  if (!sl) return [{ prim, bin: bin(prim.binDepth ?? prim.depth), lo: -Infinity, hi: Infinity }];
  const dmin = Math.min(sl.d0, sl.d1), dmax = Math.max(sl.d0, sl.d1), kLo = bin(dmin), kHi = bin(dmax);
  if (kLo === kHi) return [{ prim, bin: kHi, lo: -Infinity, hi: Infinity }];
  const sAt = (d) => sl.s0 + ((d - sl.d0) / (sl.d1 - sl.d0)) * (sl.s1 - sl.s0);
  const out = [];
  for (let k = kHi; k >= kLo; k--) {
    const a = sAt(Math.max(dmin, k * DEPTH_BIN)), b = sAt(Math.min(dmax, (k + 1) * DEPTH_BIN));
    let lo = Math.min(a, b), hi = Math.max(a, b);
    if (k === bin(sl.d0)) lo = -Infinity;
    if (k === bin(sl.d1)) hi = Infinity;
    out.push({ prim, bin: k, lo, hi });
  }
  return out;
}

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
    if (mesh.skew) return;   // skewed meshes are plain: no joints or split cones, their ends count as unshared
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
function alignToFlatCone(points, c1, c2, tol) {
  if (!c1.round || !c2.round) return alignToFlatEllipses(points, c1, c2, tol);
  const t = capsuleTangentPoints(c1.center, c1.radius, c2.center, c2.radius);
  const lines = [[t.p1a, t.p1b], [t.p2b, t.p2a]];
  if (![t.p1a, t.p1b, t.p2a, t.p2b].every(p => p && isFinite(p.x) && isFinite(p.y))) return points;
  // The capsule (hull of the two circles) in closed form: inside test and nearest
  // boundary point from its two tangent segments and the two outer arcs. On circle 1
  // the exposed arc is the directions with u . e <= k, on circle 2 those with u . e >= k
  // (e = unit c1 -> c2, k = (r1 - r2) / d, the cosine of the tangent points' angle to e).
  const ex = c2.center.x - c1.center.x, ey = c2.center.y - c1.center.y, d = Math.hypot(ex, ey);
  const k = (c1.radius - c2.radius) / d;
  const quad = [t.p1a, t.p1b, t.p2a, t.p2b];
  const inCapsule = (p) => Math.hypot(p.x - c1.center.x, p.y - c1.center.y) <= c1.radius
    || Math.hypot(p.x - c2.center.x, p.y - c2.center.y) <= c2.radius
    || pointInPolygon(p, quad);
  const nearestOnSegment = (p, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
    const f = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    return { x: a.x + dx * f, y: a.y + dy * f };
  };
  const nearestOnBoundary = (p) => {
    const cands = lines.map(([a, b]) => nearestOnSegment(p, a, b));
    [[c1, -1], [c2, 1]].forEach(([c, sign]) => {
      const dx = p.x - c.center.x, dy = p.y - c.center.y, l = Math.hypot(dx, dy);
      if (l > 1e-12 && sign * ((dx * ex + dy * ey) / (l * d) - k) >= 0) cands.push({ x: c.center.x + (dx / l) * c.radius, y: c.center.y + (dy / l) * c.radius });
    });
    return cands.reduce((best, q) => (Math.hypot(q.x - p.x, q.y - p.y) < Math.hypot(best.x - p.x, best.y - p.y) ? q : best));
  };
  const clamped = points.map(p => (inCapsule(p) ? p : nearestOnBoundary(p)));
  const feet = lines.map(([a, b]) => {
    const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
    const across = (p) => Math.abs(((p.x - a.x) * dy - (p.y - a.y) * dx) / l);
    const p = clamped.reduce((best, q) => (across(q) < across(best) ? q : best), clamped[0]);
    const k = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (l * l);
    return { x: a.x + dx * k, y: a.y + dy * k };
  });
  return [...clamped, ...feet];
}

// alignToFlatCone for ellipse ends: the flat capsule is the polygon of the two ellipses' hull
// (ellipseCapsule), whose two straight edges are the tangent lines.
function alignToFlatEllipses(points, p1, p2, tol) {
  const { poly, lines } = ellipseCapsule(nodeEllipse(p1), nodeEllipse(p2), tol);
  const nearestOnSegment = (p, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
    const f = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    return { x: a.x + dx * f, y: a.y + dy * f };
  };
  const nearestOnBoundary = (p) => poly.reduce((best, a, i) => {
    const q = nearestOnSegment(p, a, poly[(i + 1) % poly.length]);
    return Math.hypot(q.x - p.x, q.y - p.y) < Math.hypot(best.x - p.x, best.y - p.y) ? q : best;
  }, poly[0]);
  const clamped = points.map(p => (pointInPolygon(p, poly) ? p : nearestOnBoundary(p)));
  const feet = lines.filter(([a, b]) => Math.hypot(b.x - a.x, b.y - a.y) > 1e-9).map(([a, b]) => {
    const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy);
    const across = (p) => Math.abs(((p.x - a.x) * dy - (p.y - a.y) * dx) / l);
    const p = clamped.reduce((best, q) => (across(q) < across(best) ? q : best), clamped[0]);
    const k = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (l * l);
    return { x: a.x + dx * k, y: a.y + dy * k };
  });
  return [...clamped, ...feet];
}

// The loop shrunk toward its centroid so its boundary moves in by about `d`
// (exact for a circle; for a ring's ellipse it moves in by d at the nearest side). Its arcs
// (geometry.js loops) shrink with it. The centroid and the nearest side are taken on its points
// and its arcs' middles.
function insetPolygon(poly, d) {
  const probes = poly.flatMap(p => (p.arc ? [p, arcPoint(p.arc, (p.arc.t0 + p.arc.t1) / 2)] : [p]));
  const c = probes.reduce((s, p) => ({ x: s.x + p.x / probes.length, y: s.y + p.y / probes.length }), { x: 0, y: 0 });
  const near = Math.min(...probes.map(p => Math.hypot(p.x - c.x, p.y - c.y)));
  const k = Math.max(0.5, 1 - d / (near || 1));
  const f = (p) => ({ x: c.x + (p.x - c.x) * k, y: c.y + (p.y - c.y) * k }), lin = (v) => ({ x: v.x * k, y: v.y * k });
  return poly.map(p => (p.arc ? { ...f(p), arc: mapArc(p.arc, f, lin) } : f(p)));
}

// A linear map of the screen plane that turns an ellipse into the circle of radius b about the
// same center (the long axis shrunk by b / a). A squashed joint node's 2D work (the color split,
// the disc cut out of the cone bodies) is done in this space, where the node is a circle, and
// mapped back: the map is affine, so hulls, crossings and arcs carry over exactly.
function ellipseUnitMap(center, e) {
  const k = e.b / e.a, c = Math.cos(e.angle), s = Math.sin(e.angle);
  // to: M = R diag(k, 1) R^T ; from: M^-1 = R diag(1/k, 1) R^T (both symmetric)
  const mat = (f) => ({ xx: f * c * c + s * s, xy: (f - 1) * c * s, yy: f * s * s + c * c });
  const T = mat(k), F = mat(1 / k);
  const apply = (m) => (p) => {
    const dx = p.x - center.x, dy = p.y - center.y;
    return { x: center.x + m.xx * dx + m.xy * dy, y: center.y + m.xy * dx + m.yy * dy };
  };
  return {
    to: apply(T), from: apply(F), radius: e.b, stretch: e.a / e.b,
    toLin: (v) => ({ x: T.xx * v.x + T.xy * v.y, y: T.xy * v.x + T.yy * v.y }), fromLin: (v) => ({ x: F.xx * v.x + F.xy * v.y, y: F.xy * v.x + F.yy * v.y }),
    // canvas transform for drawing in unit space: x' = F (x - center) + center
    fromMatrix: [F.xx, F.xy, F.xy, F.yy, center.x - (F.xx * center.x + F.xy * center.y), center.y - (F.xy * center.x + F.yy * center.y)],
  };
}

// The ellipsoid a node is in a joint's flat solid: its projected ellipse as the shadow along z, and
// the body's own half-extent along the view for the third axis (CLAUDE.md "Flat solid").
function flatBody(p, pz) {
  return { center: { x: p.center.x, y: p.center.y, z: -p.depth * pz }, shape: ellipsoidShape(p.ellipse.a, Math.max(p.ellipse.b, 1e-3), p.ellipse.angle, Math.max(p.zRadius, 1e-3)) };
}

// Each joint: its ring (jointCurve.js), which mesh is in front of it (frontIsA:
// the cone on the camera's side of the ring plane) and its phase, the depth sign
// of the axis between the two meshes' directions in camera space.
function computeJoints(jointNodeIds, owners, projected, camPos, basis, tol) {
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
    // A far end squashed along its cone's axis (scene.js finalizeShapes) is, in the flat solid, the spheroid about the flat
    // axis with its own scale (`ra` / `rp`): the cone stays circular (splitRing.js coaxialCone), so the closed form holds.
    const flat = (id) => {
      const out = { center: { ...projected[id].center, z: -projected[id].depth * pz }, radius: projected[id].radius }, sh = nodes[id].shape;
      if (sh.axial) { out.ra = sh.ra * projected[id].scale; out.rp = sh.rp * projected[id].scale; }
      return out;
    };
    // A squashed joint node, or a far end squashed along another axis, takes the general ring (jointCurveGeneral.js);
    // round joint nodes with round or axial far ends keep the closed form.
    const general = !projected[nodeId].round || [farNode(meshA).id, farNode(meshB).id].some(id => !projected[id].round && !nodes[id].shape.axial);
    const bodies = general ? [nodeId, farNode(meshA).id, farNode(meshB).id].map(id => flatBody(projected[id], pz)) : null;
    const curve = general ? buildJointCurveGeneral(bodies[0], bodies[1], bodies[2], tol, nodeId) : buildJointCurve(flat(nodeId), flat(farNode(meshA).id), flat(farNode(meshB).id), tol);
    // The ring's plane separates the two cones, so the cone on the camera's side
    // of it is the front one (the phase says the same, except in edge-on views).
    let frontIsA = axis.z / axisLen >= 0;
    if (curve.hasTouch) {
      const camSide = curve.plane.z, armSide = vecDot(vecSub(general ? bodies[1].center : flat(farNode(meshA).id).center, curve.touch[0].p), curve.plane);
      if (camSide * armSide !== 0) frontIsA = camSide * armSide > 0;
    }
    const screen = (pts) => pts.map(q => ({ x: q.p.x, y: q.p.y }));
    const flatA = flat(farNode(meshA).id), flatB = flat(farNode(meshB).id);
    const contacts = (general ? edgeContactsGeneral(curve) : edgeContacts(flat(nodeId), flatA, flatB, curve)).map(cone => cone.map(e => ({
      near: { x: e.near.x, y: e.near.y }, contact: e.contact && { x: e.contact.x, y: e.contact.y },
    })));
    const usable = curve.hasTouch && curve.front.length >= 3;
    joints[nodeId] = {
      farA: farNode(meshA), farB: farNode(meshB),
      frontIsA, contacts,
      frontArc: usable ? screen(curve.front) : null,
      // A point inside both the ring and the node circle: the touch points' midpoint.
      inner: usable ? { x: (curve.touch[0].p.x + curve.touch[1].p.x) / 2, y: (curve.touch[0].p.y + curve.touch[1].p.y) / 2 } : null,
      // the ring on screen with its exact arcs (jointCurve.js screenLoop)
      loop: usable ? curve.screenLoop : null,
      // as simple loops: seen nearly edge-on the ring crosses itself on screen, and its two lobes, wound opposite ways, made
      // the front's fill cancel its own body along the joint (a gap of background at 1.8 in the squashed demo)
      lobes: usable ? untwistLoop(curve.screenLoop) : null,
      farProjA: projected[farNode(meshA).id], farProjB: projected[farNode(meshB).id],
      curve,
      view: flatView,
      center: p.center,
      radius: p.radius,
      // A squashed joint node: its map to a circle (ellipseUnitMap) and the view of the ring in that space.
      map: p.round ? null : ellipseUnitMap(p.center, p.ellipse),
      phase: axis.z / axisLen,
      meshA, meshB,
    };
  });
  return joints;
}

// A 2-node mesh sharing a node with a 3+ node mesh is drawn as a split
// cone; returns { hostMesh, splitNodeId } or null.
// Mesh id -> a cluster id: meshes joined by shared nodes (joints, split cones and their hosts) share one. Pieces of
// one cluster keep the piece-key order between each other where they overlap (CLAUDE.md "Layering").
function buildClusters(owners) {
  const parent = {};
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  Object.values(meshes).forEach(m => { parent[m.id] = m.id; });
  Object.values(owners).forEach(ids => ids.slice(1).forEach(id => { parent[find(id)] = find(ids[0]); }));
  const out = {};
  Object.values(meshes).forEach(m => { out[m.id] = find(m.id); });
  return out;
}

function findSplit(mesh, owners) {
  if (mesh.nodeIds.length !== 2 || mesh.skew) return null;
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
  // A split cone with a squashed node (splitRing.general): its screen polygons from the cached 3D ring.
  const farNodeOf = () => nodes[mesh.nodeIds.find(id => id !== split.splitNodeId)];
  const splitScreen = () => splitScreenPoints(splitRing, nodes[split.splitNodeId], projected[split.splitNodeId], farNodeOf(), projected[farNodeOf().id]);
  const splitRing = split && findSplitRing(nodes[split.splitNodeId], nodes[mesh.nodeIds.find(id => id !== split.splitNodeId)], split.hostMesh);
  let depth = Math.max(a.depth, b.depth);
  if (splitRing) {
    const hostDepths = split.hostMesh.nodeIds.map(id => projected[id].depth);
    const hostMin = Math.min(...hostDepths), hostMax = Math.max(...hostDepths);
    const facing = vecDot(vecNormalize(vecSub(camPos, splitRing.surface)), splitRing.dir);
    // Cones on the same node: the one pointing more toward the camera is nearer, drawn later.
    // The far part is keyed past the host's whole depth range (so it layers against the host) and
    // past its own far node, so a mesh near that end sorts against the cone by where it really is.
    const farDepth = (a.id === split.splitNodeId ? b : a).depth;
    // The far part goes over the host only if the cone points at the camera AND its far node is nearer than every host node: with the
    // far node still behind the host's nearest node, the host's own pieces (e.g. a cone to a nearer node) are in front of it, and drawing
    // it over them cut the green into the blue (3.406). Otherwise it goes under, and the host's pieces cover it.
    const overHost = facing > 0 && farDepth < hostMin;
    depth = (overHost ? Math.min(hostMin, farDepth) - 0.001 : Math.max(hostMax, farDepth) + 0.001) - 1e-4 * facing;
    frame.coneDepths[mesh.id] = depth;
    const sharedProj = projected[split.splitNodeId];
    const axisCam = { x: vecDot(splitRing.dir, basis.right), y: vecDot(splitRing.dir, basis.up) };
    // (The host-colored shared part belongs to the host: hidden in the focus view unless the host is shown.) It is sorted by
    // the split node's own depth, so other meshes near it (behind or in front of that node) layer
    // against the node; it stays between the cones' far parts (hostMax + 0.001 away from the
    // camera, hostMin - 0.001 toward it), which are keyed past the host's whole depth range.
    if (!focus.on || focus.meshIds.includes(split.hostMesh.id)) frame.extraPrimitives.push({
      cluster: frame.clusterOf[split.hostMesh.id], depth: sharedProj.depth + 0.0005, binDepth: sharedProj.depth, box: boxOf([sharedProj, projected[farNodeOf().id]]), caps: [capsuleOf(sharedProj, sharedProj, 1.2)],
      owners: [split.hostMesh.id],
      shade: (frame.shading && sharedProj.round && projected[farNodeOf().id].round)
        ? () => {
          const hostProj = split.hostMesh.nodeIds.map(id => projected[id]), far = projected[farNodeOf().id];
          // This part is host-colored and painted over the host's own pieces, so it paints the host's whole lit hull (like any of the host's
          // pieces: its spheres, cones and faces, the shared node given way to the split cones), then the cone lit by the light itself like
          // the host (the tube light starts at the split ring, where the color changes). Without the host's elements its dark base would
          // cover them where they overlap.
          if (!hostProj.every(p => p.round)) { const [pairSphere, , cone] = frame.shading.pair(sharedProj, far); return [pairSphere, cone]; }
          return [...frame.shading.hull(split.hostMesh.id, hostProj).elements(frame.splitFarsOf), frame.shading.cone(sharedProj, far)];
        } : null,
      draw: (c = ctx) => (splitRing.general
        ? drawSplitSharedGeneral(c, nodes[split.splitNodeId], sharedProj, farNodeOf(), splitScreen(), split.hostMesh.color)
        : drawSplitShared(c, sharedProj, splitRing, axisCam, split.hostMesh.color, projectPoint)),
    });
  }

  // A cone ending at a joint stops at the joint ring: its body is the hull of
  // the other end's circle and the ring's front arc; where it is the front mesh
  // it also fills the whole ring's interior (CLAUDE.md "Joint ring").
  const underlap = frame.underlap;
  const discRadius = (joint) => Math.max(joint.radius - underlap, 0.5 * joint.radius);
  // The polygon with the joint's node disc cut out (subtractDisc, its cut an exact arc): a squashed node is cut in its
  // unit-circle space and mapped back (the polygon's own points as they were, the circle's arcs as arcs of the ellipse
  // the map turns them into: x' = R diag(stretch, 1) R^T x, so the circle's angle th is the ellipse's th - angle).
  const cutDisc = (poly, joint) => {
    if (!joint.map) return subtractDisc(poly, joint.center, discRadius(joint));
    const m = joint.map, rad = Math.max(m.radius - underlap, 0.5 * m.radius);
    const move = (f, lin) => (p) => { const q = f(p); if (p.arc) q.arc = mapArc(p.arc, f, lin); return q; };
    return subtractDisc(poly.map(move(m.to, m.toLin)), joint.center, rad).map(out => out.map(move(m.from, m.fromLin)));
  };
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
  // `baseEllipses`: whole ellipses (a far end's rim) taking part in the hull as exact arcs.
  const drawAtJoints = (basePoints, joints, c = ctx, baseEllipses = []) => {
    const points = [...basePoints], fills = [], cutLoops = [], closings = [];
    joints.forEach(joint => {
      const isFront = (joint.frontIsA ? joint.meshA : joint.meshB) === mesh;
      if (isFront) joint.lobes.forEach(lobe => fills.push(...cutDisc(lobe, joint)));
      // The back cone is cut a little inside the ring, so it reaches under the
      // front cone's antialiased edge along the ring (rule 1); the front cone's
      // fill and outline share the ring's exact edge in one path.
      joint.lobes.forEach(lobe => cutLoops.push(isFront ? lobe : insetPolygon(lobe, underlap)));
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
    // The hull as an exact outline (hullOutline: corners, and arcs of the far ends' rims joined by their tangents).
    let ops = hullOutline([{ pts: points }, ...baseEllipses.map(e => ({ e }))]);
    closings.forEach(({ pair, via }) => {
      const n = ops.length, i = ops.findIndex(op => op.p === pair[0]), j = ops.findIndex(op => op.p === pair[1]);
      if (i < 0 || j < 0 || !via) return;
      // The two stops are neighbors on the hull (the chord); put the via point between them.
      const after = (j - i + n) % n === 1 ? i : ((i - j + n) % n === 1 ? j : -1);
      if (after >= 0) ops = [...ops.slice(0, after + 1), { k: 'p', p: via }, ...ops.slice(after + 1)];
    });
    // As a polygon for the booleans: an arc is its two ends with the `arc` on the second (drawJointBody), a chord to the
    // booleans; an arc whose box meets a cut's box (a far end close to the joint) is chords within the tolerance instead.
    const cutBoxes = joints.flatMap(joint => {
      const r = joint.map ? joint.map.radius * joint.map.stretch : joint.radius;
      return [{ x0: joint.center.x - r, y0: joint.center.y - r, x1: joint.center.x + r, y1: joint.center.y + r }, loopBox(joint.loop)];
    });
    const hull = [];
    const add = (p) => {
      const last = hull[hull.length - 1];
      if (last && Math.hypot(p.x - last.x, p.y - last.y) < 1e-9) { if (p.arc) hull[hull.length - 1] = { x: last.x, y: last.y, arc: p.arc }; return; }
      hull.push(p);
    };
    ops.forEach(op => {
      if (op.k === 'p') { add(op.p); return; }
      const e = op.e, box = { x0: e.center.x - e.a, y0: e.center.y - e.a, x1: e.center.x + e.a, y1: e.center.y + e.a };
      if (cutBoxes.some(b => b.x0 <= box.x1 && box.x0 <= b.x1 && b.y0 <= box.y1 && box.y0 <= b.y1)) { outlinePolygon([op], 2.5 * frame.tol).forEach(add); return; }
      const start = ellipseParam(e, op.from), end = op.from - op.to >= 2 * Math.PI - 1e-9 ? start - 2 * Math.PI : ellipseParam(e, op.to);
      add(ellipsePoint(e, op.from));
      add({ ...ellipsePoint(e, op.to), arc: ellipseArc(e.center.x, e.center.y, e.a, e.b, e.angle, start, end, true) });
    });
    if (hull.length > 1) {
      const p = hull[hull.length - 1], q = hull[0];
      if (Math.hypot(p.x - q.x, p.y - q.y) < 1e-9) { hull.pop(); if (p.arc) hull[0] = { x: q.x, y: q.y, arc: p.arc }; }
    }
    // the ring loops first, then the discs: a disc's cut is an exact arc, which the polygon booleans would take for a chord
    let outline = [hull];
    cutLoops.forEach(loop => { outline = outline.flatMap(poly => subtractPolygon(poly, loop)); });
    joints.forEach(joint => { outline = outline.flatMap(poly => cutDisc(poly, joint)); });
    drawJointBody(c, [...outline, ...fills], color);
  };
  const draw = (c = ctx) => {
    if (split) {
      const far = projected[mesh.nodeIds.find(id => id !== split.splitNodeId)];
      const joint = jointNodeIds.has(far.id) ? frame.joints[far.id] : null;
      if (joint && joint.frontArc) {
        // The cone's own part, from the split ring to a joint: the joint logic at that end.
        // The split ring is projected in perspective, but the joint works in the flat
        // model (the dotted edges are tangents of the flat circles): its ends are
        // aligned to those two lines so the outline leaves them exactly at the ring.
        drawAtJoints(alignToFlatCone(splitRing.general ? splitScreen().ringPts : splitRingPoints(splitRing, projectPoint, 2.5 * frame.tol), far, projected[split.splitNodeId], 2.5 * frame.tol), [joint], c);
        return;
      }
      if (splitRing.general) drawSplitFarGeneral(c, far, splitScreen().ringPts, color, { farIsJoint: jointNodeIds.has(far.id) });
      else drawSplitFar(c, far, splitRing, color, projectPoint, { farIsJoint: jointNodeIds.has(far.id) });
      return;
    }
    if (touchesJoint) {
      const joints = [], ellipses = [];
      [a, b].forEach(end => {
        const joint = frame.joints[end.id];
        if (joint && joint.frontArc) joints.push(joint); else ellipses.push(nodeEllipse(end));
      });
      drawAtJoints([], joints, c, ellipses);
      return;
    }
  };

  // The fill triangle of a 2-node mesh is flat (its centroid is on the line between the
  // two centers, and so are both of its other corners), so it is only traced for bigger meshes.
  const tracePath = (split || touchesJoint) ? null : (c = ctx) => {
    // Squashed nodes are ellipses (their capsule is the hull of the two ellipses); round
    // ones keep the circle code. Joints and split cones still treat every node as a circle.
    const round = a.round && b.round;
    const ea = nodeEllipse(a), eb = nodeEllipse(b);
    if (mesh.nodeIds.length > 2) {
      traceTriangle(c, screenCentroid,
        a.round ? closestPointOnCircle(a.center, a.radius, screenCentroid) : ellipseRayPoint(ea, screenCentroid),
        b.round ? closestPointOnCircle(b.center, b.radius, screenCentroid) : ellipseRayPoint(eb, screenCentroid));
    }
    if (round) {
      // One circle inside the other (two nodes in line with the camera): the bigger circle
      // is the whole piece; the tangent lines of traceCapsule don't exist.
      if (Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y) <= Math.abs(a.radius - b.radius)) {
        const bigA = a.radius >= b.radius;
        if (!(bigA ? sharedA : sharedB)) traceCircle(c, (bigA ? a : b).center, (bigA ? a : b).radius);
      } else traceCapsule(c, a.center, a.radius, b.center, b.radius, sharedA, sharedB);
    } else traceEllipseCapsule(c, ea, eb, sharedA, sharedB);
    // A split node's disc belongs to its cone (drawSplitShared), which clips it to the ring plane.
    if (sharedA && !splitNodeIds.has(a.id)) { if (a.round) traceCircle(c, a.center, a.radius); else traceEllipse(c, ea); }
    if (sharedB && !splitNodeIds.has(b.id)) { if (b.round) traceCircle(c, b.center, b.radius); else traceEllipse(c, eb); }
  };

  const caps = [capsuleOf(a, b, jointNodeIds.has(a.id) ? 1.3 : 1, jointNodeIds.has(b.id) ? 1.3 : 1)];
  if (mesh.nodeIds.length > 2) caps.push(capsuleOf(a, { center: screenCentroid, radius: 0 }), capsuleOf(b, { center: screenCentroid, radius: 0 }));
  // The surfaces this piece shows, for the light engine (shading.js): the spheres at its ends (not at a joint, whose disc is
  // its own piece, nor at the split node, which the cone's host part owns), the cone between them and, for a plain piece of a
  // 3+ node mesh, its fill triangle.
  const S = frame.shading;
  const shade = (S && a.round && b.round) ? () => {
    // The nodes at a joint (its disc is its own piece) or at the split node (its cone owns the disc) are left out.
    if (mesh.nodeIds.length > 2) {
      if (!mesh.nodeIds.every(id => projected[id].round)) return null;
      // (every piece paints the whole mesh's elements, shading.js hull, the split node's sphere given way to its cones: a piece
      // drawn after the cone's host-colored part would otherwise cover that sphere's lit cap with its base tone)
      return S.hull(mesh.id, mesh.nodeIds.map(id => projected[id])).elements(frame.splitFarsOf);
    }
    const els = [...S.pair(a, b)];
    if (jointNodeIds.has(a.id) || (split && a.id === split.splitNodeId)) els[0] = null;
    if (jointNodeIds.has(b.id) || (split && b.id === split.splitNodeId)) els[1] = null;
    return els;
  } : null;
  const prim = { cluster: frame.clusterOf[mesh.id], depth, binDepth: Math.max(a.depth, b.depth), slice: makeSlice(a, b), box: boxOf([a, b], mesh.nodeIds.length > 2 ? [screenCentroid] : []), caps, meshId: mesh.id, color, draw, tracePath, shade };
  [a, b].forEach(end => { if (jointNodeIds.has(end.id)) (frame.jointBodies[end.id] ||= []).push({ meshId: mesh.id, prim, isSplit: !!split }); });
  return prim;
}

// A skewed mesh (CLAUDE.md "Skewed meshes"): the arch's visible surface in its exact rows (shading.js buildArch), as two traced
// primitives split at the skew node (A..S and S..B, reaching a little into each other), each with its own depth key (the mean
// depth of its screen circles), so another body can pass between the halves.
const archSampleCache = new Map();     // mesh id -> { stamp (its nodes), map: t -> the shading's world sample }
function buildSkewPrimitives(frame, mesh) {
  const { projectPoint } = frame;
  const [A, B] = mesh.nodeIds.map(id => nodes[id]), S = nodes[mesh.skew];
  const at = archAt(A, B, S);
  // With a squashed end node, each sample is the shadow ellipse of the blended spheroid (skew.js shapeAt),
  // read with the projection's Jacobian at that point like projectNode; all round keeps the circle path.
  const oblate = !(A.shape.isSphere && B.shape.isSphere), qAt = shapeAt(A, B, S);
  const project = (t) => {
    const w = at(t), cam = worldToCamera(w.center, frame.camPos, frame.basis), p = projectPoint(w.center);
    const out = { x: p.x, y: p.y, r: w.radius * p.scale, depth: cam.z };
    if (oblate) {
      const lean = (v, k) => ({ x: v.x - k * frame.basis.forward.x, y: v.y - k * frame.basis.forward.y, z: v.z - k * frame.basis.forward.z });
      const e = shadowEllipse({ Q: qAt(t) }, lean(frame.basis.right, cam.x / cam.z), lean(frame.basis.up, cam.y / cam.z));
      out.e = { center: { x: p.x, y: p.y }, a: e.a * p.scale, b: Math.max(e.b * p.scale, 1e-6), angle: -e.angle };
      out.r = out.e.a;
    }
    return out;
  };
  const samples = archSamples(project, 5 * frame.tol);
  const apex = samples.findIndex(s => s.t === 0.5);
  // The body's world samples for its outline and shading (shading.js buildArch, which places its own rows by the view): the center, the
  // form of x^T K x = 1 (shape.Q is S^2), the tangent and, on a round arch, the radius' tilt sinT (the tube mode's surface, the same as the
  // Debug view's curves). Camera-independent, so they are kept per mesh while its nodes stay put.
  const h = 1e-4;
  const stamp = [A, B, S].map(nd => [nd.center.x, nd.center.y, nd.center.z, nd.radius, ...nd.shape.Q].join(',')).join(';');
  let store = archSampleCache.get(mesh.id);
  if (!store || store.stamp !== stamp || store.map.size > 4096) archSampleCache.set(mesh.id, store = { stamp, map: new Map() });
  const sampleAt = (t) => {
    let s = store.map.get(t);
    if (s) return s;
    const w = at(t), r2 = 1 / (w.radius * w.radius), lo = at(Math.max(0, t - h)), hi = at(Math.min(1, t + h));
    const dv = { x: hi.center.x - lo.center.x, y: hi.center.y - lo.center.y, z: hi.center.z - lo.center.z }, D = Math.hypot(dv.x, dv.y, dv.z) || 1;
    s = { tv: t, c: w.center, Q: oblate ? inverse(qAt(t)) : [r2, 0, 0, 0, r2, 0, 0, 0, r2], t: { x: dv.x / D, y: dv.y / D, z: dv.z / D }, sinT: oblate ? 0 : (lo.radius - hi.radius) / D };
    store.map.set(t, s);
    return s;
  };
  // The cuts, as values of t (shading.js buildArch `cuts`): `draw`, where the halves' fills end: they reach DRAW_BAND past the apex into
  // each other (same color), so where the apex section is a line (a flat ribbon) they overlap in a strip instead of only touching along an
  // edge, which lets the background through (rule 1); `lo` / `hi`, where the shading's sheets are cut, SHARED_BAND each way (its 'both'
  // band: the half drawn first paints its own sheets and that band, see below).
  const DRAW_BAND = 1 / 32, SHARED_BAND = 1 / 16;
  const cuts = { apex: 0.5, lo: 0.5 - SHARED_BAND, hi: 0.5 + SHARED_BAND, draw: [0.5 - DRAW_BAND, 0.5 + DRAW_BAND] };
  const all = () => frame.archGeom.arch(mesh.id, sampleAt, cuts);
  // A half: the visible strips of the arch's exact rows from t0 to t1 (shading.js `outline`), the same surface as its shading. Its box
  // and depth key come from the chain of screen circles `list` (archSamples).
  const half = (list, t0, t1) => {
    const tracePath = (c = frame.ctx) => all().outline(t0, t1)(c);
    const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    let depth = 0;
    list.forEach(({ c }) => {
      box.x0 = Math.min(box.x0, c.x - c.r - 3); box.x1 = Math.max(box.x1, c.x + c.r + 3);
      box.y0 = Math.min(box.y0, c.y - c.r - 3); box.y1 = Math.max(box.y1, c.y + c.r + 3);
      depth += c.depth / list.length;
    });
    return { cluster: frame.clusterOf[mesh.id], depth, binDepth: depth, slice: null, box, meshId: mesh.id, color: mesh.color, tracePath };
  };
  // (the circles reaching past each half's end, for the boxes)
  const upTo = (t) => { const k = samples.findIndex(s => s.t >= t); return k < 0 ? samples.length : k + 1; };
  const from = (t) => { let k = samples.length - 1; while (k > 0 && samples[k].t > t) k--; return k; };
  const first = half(samples.slice(0, Math.max(upTo(cuts.draw[1]), Math.min(apex + 2, samples.length))), 0, cuts.draw[1]);
  const second = half(samples.slice(Math.min(from(cuts.draw[0]), Math.max(apex - 1, 0))), cuts.draw[0], 1);
  // Border strokes between the halves (CLAUDE.md "Border strokes"): each half is its own stroke owner (and its own fill), so
  // wherever one half is drawn over the other the nearer one gets its edge stroked, growing and shrinking with the overlap.
  // The strip where the halves reach into each other around the apex is not a border: both strokes leave it out
  // (`strokeCut`: the body from draw[0] to draw[1], traced on demand).
  const strip = half([], cuts.draw[0], cuts.draw[1]);
  const strokeCut = { trace: strip.tracePath };
  first.owners = [`${mesh.id}.0`]; first.strokeCut = strokeCut;
  second.owners = [`${mesh.id}.1`]; second.strokeCut = strokeCut;
  // The light engine: the arch's lit part (shading.js buildArch), in world space, over each half's own fill, cut into sheets at lo and hi
  // (and at folds) and painted back to front. The half drawn LATER paints every sheet: painting only its own part left its round end past
  // the apex in the base tone (a moon-phase look at the skew node). The half drawn first paints only its own sheets and the band where
  // the two overlap: the other half's sheets past that are the other fill's, and where they reached past this half's outline they stayed
  // on the earlier half.
  if (frame.shading) {
    // Debug: the skew node's cross-section taken as the cross-section of a straight cone along the arch's tangent there, in world
    // space: where that cone's shade borders would be (shading.js tubeBorderDebug).
    if (debug.on) {
      const a = at(0.5 - h), b = at(0.5 + h);
      const s0 = sampleAt(0.5);
      frame.shading.tubeBorderDebug(s0.c, s0.Q, { x: b.center.x - a.center.x, y: b.center.y - a.center.y, z: b.center.z - a.center.z },
        oblate ? null : { cA: a.center, rA: a.radius, cB: b.center, rB: b.radius });
      // and the two curves along the arch through those dots, end node to end node (shading.js archBorderCurves)
      const T = 128, rows = Array.from({ length: T + 1 }, (_, i) => {
        const t = i / T, w = at(t), lo = at(Math.max(0, t - h)), hi = at(Math.min(1, t + h));
        const dv = { x: hi.center.x - lo.center.x, y: hi.center.y - lo.center.y, z: hi.center.z - lo.center.z }, D = Math.hypot(dv.x, dv.y, dv.z) || 1;
        const r2 = 1 / (w.radius * w.radius);
        return { c: w.center, t: { x: dv.x / D, y: dv.y / D, z: dv.z / D }, r: w.radius, sinT: (lo.radius - hi.radius) / D, K: oblate ? inverse(qAt(t)) : [r2, 0, 0, 0, r2, 0, 0, 0, r2] };
      });
      frame.shading.archBorderCurves(rows, T / 2, !oblate);
    }
    // the half drawn first: its own sheets and the band where the two fills overlap
    const own = (h) => () => all().filter(e => e.half === undefined || e.half === h || e.half === 'both');
    // (draw order between the halves: the larger key first; on a tie the first half, the sort being stable)
    if (first.depth >= second.depth) { first.shade = own(0); second.shade = all; } else { first.shade = all; second.shade = own(1); }
  }
  return [first, second];
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
  // A squashed node is drawn in its unit-circle space: the ring and the far node's center are
  // mapped there, the split is made for the circle, and the canvas maps the result back.
  const { map } = joint, farCenter = projected[(dominantA ? joint.farA : joint.farB).id].center;
  const radius = map ? map.radius : joint.radius;
  const view = map ? { viewDirAt: joint.view.viewDirAt, projectPoint: (w) => map.to(joint.view.projectPoint(w)) } : joint.view;
  const loop2D = joint.loop && (map ? joint.loop.map(p => { const q = map.to(p); if (p.arc) q.arc = mapArc(p.arc, map.to, map.toLin); return q; }) : joint.loop);
  const split = projectJointSplit(joint.curve, joint.center, radius, view, map ? map.to(farCenter) : farCenter, loop2D);
  const drawDisc = (c) => (split
    ? drawJointSplitFromCurve(c, joint.center, radius, split, dominantColor, crescentColor, frame.pxPerUnit)
    : fillCircle(c, joint.center, radius, dominantColor));
  return {
    // The disc's fills in order: the dominant region (the front mesh), then the crescent.
    owners: dominantA ? [joint.meshA.id, joint.meshB.id] : [joint.meshB.id, joint.meshA.id],
    // Each region is lit like the tube it belongs to (the joint sphere and the cone of `pair`, the disc also covers the cone past its
    // tangent circle), so each cone's straight shade border runs on across the disc; the light changes only on the ring.
    shade: (frame.shading && !map && projected[nodeId].round) ? () => {
      const tube = (far) => { if (!far.round) return []; const [sphere, , cone] = frame.shading.pair(projected[nodeId], far); return [sphere, cone]; };
      return { fills: dominantA ? [tube(joint.farProjA), tube(joint.farProjB)] : [tube(joint.farProjB), tube(joint.farProjA)] };
    } : null,
    // A split cone ending here must go under the joint circle.
    cluster: frame.clusterOf[joint.meshA.id], depth: jointDepth(frame, nodeId), binDepth: projected[nodeId].depth, box: boxOf([projected[nodeId]]), caps: [capsuleOf(projected[nodeId], projected[nodeId])],
    // No usable ring in view (e.g. one arm points at the camera): one color.
    draw: (c = ctx) => {
      if (!map) { drawDisc(c); return; }
      c.save();
      c.transform(...map.fromMatrix);
      drawDisc(c);
      c.restore();
    },
  };
}

// The base order is the strata order (above). Pieces of one cluster (joined by shared nodes: the cones of a joint,
// a split cone and its host) whose screen boxes overlap keep their piece-key order instead, which is what the
// joint / split rules (front body after back body, disc after its bodies, a split cone over or under its host)
// are written in; slabs of one piece stay in strata order. Kahn's algorithm on those constraints, taking the
// earliest available entry of the base order each time: an entry that must wait for another is moved later.
function orderByCluster(entries) {
  const n = entries.length, succ = Array.from({ length: n }, () => []), indeg = new Int32Array(n);
  const byPiece = new Map();
  entries.forEach(e => { if (!byPiece.has(e.prim)) byPiece.set(e.prim, []); byPiece.get(e.prim).push(e); });
  const edge = (u, v) => { succ[u.idx].push(v.idx); indeg[v.idx]++; };
  byPiece.forEach(list => { for (let k = 0; k + 1 < list.length; k++) edge(list[k], list[k + 1]); });
  const pieces = [...byPiece.keys()];
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      const P = pieces[i], Q = pieces[j];
      // Pieces of one mesh are left to the strata: chaining them whole (a hull's pieces all meet at its nodes) moved a piece's
      // far slabs after another mesh's body that is between them in depth (a cyan triangle node over the green arch at 2.374).
      if (P.cluster === undefined || P.cluster !== Q.cluster || P.depth === Q.depth || (P.meshId !== undefined && P.meshId === Q.meshId) || !piecesOverlap(P, Q)) continue;
      const [first, second] = P.depth > Q.depth ? [P, Q] : [Q, P], fl = byPiece.get(first), sl = byPiece.get(second);
      edge(fl[fl.length - 1], sl[0]);
    }
  }
  const out = [], ready = [];
  for (let k = 0; k < n; k++) if (indeg[k] === 0) ready.push(k);
  while (ready.length) {
    let m = 0;
    for (let k = 1; k < ready.length; k++) if (ready[k] < ready[m]) m = k;
    const u = ready.splice(m, 1)[0];
    out.push(entries[u]);
    succ[u].forEach(v => { if (--indeg[v] === 0) ready.push(v); });
  }
  return out.length === n ? out : entries;
}

// Back to front: the farthest depth stratum first, and within a stratum by the piece's own key.
// Consecutive traced primitives of one mesh become a single nonzero fill, so their shared edges don't
// stack (CLAUDE.md "Batching"). A piece cut into slabs is drawn whole when its slabs can be put together:
// only pieces whose screen box overlaps it (of another color) are in the way, so the others between its
// slabs don't count. Then the output is that of an uncut piece (no clip, no seam). Otherwise the run of
// slabs is drawn through a clip strip along its slice axis, widened by `seam` toward each neighboring slab
// that is drawn LATER, so the earlier one reaches under the later one (rule 1).
//
// Border strokes (config.js `strokes`): where a mesh is drawn over another mesh of the SAME color, the edge of what it
// paints gets a black stroke, centered on the edge but laid down BEFORE the fill, so only its outer half shows. Each
// fill of such a mesh is first recorded (`paintRecorded`); its outline is stroked on an offscreen canvas, masked to the
// other same-colored meshes painted so far (never over the background) minus the mesh's own earlier fills (never along
// its own piece seams), composited, and then the fill is painted over the inner half. Only colors used by two or more
// meshes take this path; everything else is drawn as before.
function drawPrimitives(ctx, primitives, seam, pxPerUnit, shading) {
  const ownersOf = (p) => p.owners || [p.meshId];
  const inkColors = strokeColorsOf(primitives);
  const inked = (p) => inkColors.size > 0 && ownersOf(p).some(id => id !== undefined && inkColors.has(meshOf(id).color));
  // With the light engine on, every piece that has shape elements goes through the recorded path too (its tones are
  // painted over each fill, `shading.paint`).
  const recorded = (p) => inked(p) || !!(shading && p.shade);
  const painted = [];            // every fill of an ink color so far: { owner, color, path, box, strip }
  const base = (inkColors.size || shading) ? ctx.getTransform() : null;
  // The tones of the stroked colors' fills so far (`litMap`: opaque where Lit), for the strokes' tones.
  if (inkColors.size && shading) { const lm = scratchLayers(ctx)[3], g = lm.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-over'; g.clearRect(0, 0, lm.width, lm.height); }
  const litMask = (g, path, color, els) => {
    if (els) shading.paint(g, path, color, els, false, true);
    else { g.fillStyle = '#ffffff'; g.fill(path); }
  };
  const updateLitMap = (path, color, strip, els) => {
    if (!shading) return;
    const g = scratchLayers(ctx)[3].getContext('2d');
    g.save();
    g.setTransform(base);
    if (strip) g.clip(strip);
    g.globalCompositeOperation = 'destination-out';
    g.fill(path);
    g.globalCompositeOperation = 'source-over';
    litMask(g, path, color, els);
    g.restore();
  };
  // The stroke's color is one tone darker than the front fill's tone at its edge (Lit -> Twilight, Twilight -> Shade), and it is
  // drawn only where the mesh behind has that same tone: the front's lit and twilight parts are each spread out by the stroke's
  // width (offset copies) to reach the stroke, which lies outside the fill, and matched against the lit map there.
  const DILATE = [[0, 0], ...[1, 0.5].flatMap(k => Array.from({ length: 8 }, (_, i) => [k * Math.cos(i * Math.PI / 4), k * Math.sin(i * Math.PI / 4)]))];
  const toneStroke = (sl, ml, color, path, els, x0, y0, w, h) => {
    const blit = (src) => { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(src, x0, y0, w, h, x0, y0, w, h); ctx.restore(); };
    const s = sl.getContext('2d');
    if (!shading) {
      s.globalCompositeOperation = 'source-in';
      s.setTransform(1, 0, 0, 1, 0, 0);
      s.fillStyle = toneColor(color, TWILIGHT);
      s.fillRect(x0, y0, w, h);
      blit(sl);
      return;
    }
    const [, , , lm, fl, dl] = scratchLayers(ctx), m = ml.getContext('2d'), f = fl.getContext('2d'), d = dl.getContext('2d');
    [m, f, d].forEach(g => { g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-over'; g.clearRect(x0, y0, w, h); });
    f.save(); f.setTransform(base); litMask(f, path, color, els); f.restore();
    m.setTransform(base); m.fillStyle = '#ffffff'; m.fill(path);
    m.setTransform(1, 0, 0, 1, 0, 0); m.globalCompositeOperation = 'destination-out'; m.drawImage(fl, x0, y0, w, h, x0, y0, w, h);
    [[fl, 'destination-in', TWILIGHT], [ml, 'destination-out', SHADE]].forEach(([src, back, tone]) => {
      d.globalCompositeOperation = 'source-over';
      d.clearRect(x0, y0, w, h);
      DILATE.forEach(([dx, dy]) => d.drawImage(src, x0, y0, w, h, x0 + dx * strokes.px, y0 + dy * strokes.px, w, h));
      d.globalCompositeOperation = back;
      d.drawImage(lm, x0, y0, w, h, x0, y0, w, h);
      d.globalCompositeOperation = 'destination-in';
      d.drawImage(sl, x0, y0, w, h, x0, y0, w, h);
      d.globalCompositeOperation = 'source-in';
      d.fillStyle = toneColor(color, tone);
      d.fillRect(x0, y0, w, h);
      blit(dl);
    });
  };
  const strokeUnder = (owner, color, path, box, strip, cut, els) => {
    const others = painted.filter(q => q.owner !== owner && q.color === color && boxesMeet(q.box, box));
    if (!others.length) return;
    const [sl, ml] = scratchLayers(ctx),s = sl.getContext('2d'), m = ml.getContext('2d');
    const pad = 2 * strokes.px / pxPerUnit + 2 / pxPerUnit;
    const x0 = Math.max(0, Math.floor(base.a * (box.x0 - pad) + base.e)), y0 = Math.max(0, Math.floor(base.d * (box.y0 - pad) + base.f));
    const x1 = Math.min(sl.width, Math.ceil(base.a * (box.x1 + pad) + base.e)), y1 = Math.min(sl.height, Math.ceil(base.d * (box.y1 + pad) + base.f));
    if (x1 <= x0 || y1 <= y0) return;
    const fillAll = (g, list) => list.forEach(q => {
      g.save();
      if (q.strip) g.clip(q.strip);
      g.fill(q.path);
      g.restore();
    });
    [s, m].forEach(g => { g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-over'; g.clearRect(x0, y0, x1 - x0, y1 - y0); g.setTransform(base); g.fillStyle = '#000000'; });
    s.lineWidth = 2 * strokes.px / pxPerUnit;
    s.lineJoin = 'round';
    s.strokeStyle = '#000000';
    s.stroke(path);
    fillAll(m, others);
    s.globalCompositeOperation = 'destination-in';
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.drawImage(ml, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
    s.globalCompositeOperation = 'destination-out';
    s.setTransform(base);
    fillAll(s, painted.filter(q => q.owner === owner && q.color === color && boxesMeet(q.box, box)));
    if (cut) {
      if (!cut.path) {
        cut.path = new Path2D();
        record(cut.trace).forEach(([m, args]) => { if (PATH_OPS.includes(m)) cut.path[m](...args); });
      }
      s.lineWidth = 2 * pad;
      s.lineJoin = 'round';
      s.fill(cut.path);
      s.stroke(cut.path);
    }
    toneStroke(sl, ml, color, path, els, x0, y0, x1 - x0, y1 - y0);
  };
  // Replays recorded canvas calls onto `T` (the main canvas, or a piece's group layer); before each fill, the stroke under it
  // (always on the main canvas), and after it the fill is remembered.
  const paintRecorded = (ops, owners, box, strip = null, cut = null, elements = null, T = ctx) => {
    let sub = new Path2D(), mat = new DOMMatrix(), color = null, fills = 0;
    const stack = [];
    for (const [m, args] of ops) {
      if (m === '=fillStyle') { color = args; T.fillStyle = args; continue; }
      if (m === 'fill') {
        const fillIdx = fills++, owner = owners[Math.min(fillIdx, owners.length - 1)], path = new Path2D();
        // `elements` may be per fill ({ fills: [...] }, a joint disc's two regions), like `owners`.
        const els = elements && elements.fills ? elements.fills[Math.min(fillIdx, elements.fills.length - 1)] : elements;
        path.addPath(sub, mat);
        const shaded = els && els.length && !stack.length;
        if (owner !== undefined && inkColors.has(color) && meshOf(owner).color === color) {
          strokeUnder(owner, color, path, box, strip, cut, shaded ? els : null);
          painted.push({ owner, color, path, box, strip });
          updateLitMap(path, color, strip, shaded ? els : null);
        }
        if (shaded && T === ctx && els.every(e => e?.kind === 'lit')) {
          // A skewed arch: base and lit part are built on a transparent layer (the lit part source-atop, so it takes the fill's own
          // antialiased alpha) and composited once. Painted directly, the base tone and the lit tone each blend at the fill's edge and
          // leave a dark hairline where one arch's edge crosses another's lit part.
          const pad = 3 / pxPerUnit, gl = scratchLayers(ctx)[2], g = gl.getContext('2d'), b = box;
          const x0 = Math.max(0, Math.floor(base.a * (b.x0 - pad) + base.e)), y0 = Math.max(0, Math.floor(base.d * (b.y0 - pad) + base.f));
          const x1 = Math.min(gl.width, Math.ceil(base.a * (b.x1 + pad) + base.e)), y1 = Math.min(gl.height, Math.ceil(base.d * (b.y1 + pad) + base.f));
          if (x1 > x0 && y1 > y0) {
            g.setTransform(1, 0, 0, 1, 0, 0);
            g.clearRect(x0, y0, x1 - x0, y1 - y0);
            g.setTransform(base);
            g.fillStyle = shading.baseColor(color);
            g.fill(path);
            g.save();
            g.globalCompositeOperation = 'source-atop';
            shading.paint(g, path, color, els, true);
            g.restore();
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.drawImage(gl, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
            ctx.restore();
          }
          continue;
        }
        if (shaded) T.fillStyle = shading.baseColor(color);
        T.fill();
        if (shaded) shading.paint(T, path, color, els);
        continue;
      }
      if (m === 'beginPath') sub = new Path2D();
      else if (PATH_OPS.includes(m)) sub[m](...args);
      else if (m === 'save') stack.push({ mat, color });
      else if (m === 'restore') ({ mat, color } = stack.pop());
      else if (m === 'transform') mat = mat.multiply(new DOMMatrix(args));
      else if (m === 'translate') mat = mat.translate(...args);
      else if (m === 'scale') mat = mat.scale(...args);
      T[m](...args);
    }
  };
  let entries = primitives.flatMap(slabsOf);
  entries.sort((p, q) => (q.bin - p.bin) || (q.prim.depth - p.prim.depth));
  entries.forEach((e, i) => { e.idx = i; (e.prim.slabMap ||= new Map()).set(e.bin, e); });
  entries = orderByCluster(entries);
  entries.forEach((e, i) => { e.idx = i; });
  // Runs of slabs of one piece, drawn at the position of their first slab.
  const runs = [];
  entries.forEach((e) => {
    if (e.run) return;
    const p = e.prim, run = { prim: p, entries: [e], pos: e.idx };
    e.run = run;
    let last = e;
    for (let j = e.idx + 1; j < entries.length && run.entries.length < p.slabMap.size; j++) {
      const f = entries[j];
      if (f.prim === p) { if (f.bin !== last.bin - 1) break; f.run = run; run.entries.push(f); last = f; continue; }
      if (f.run) continue;                    // already moved into an earlier run: not in the way here
      const sameInk = p.color && f.prim.color && p.color === f.prim.color;
      if (!sameInk && piecesOverlap(p, f.prim)) break;
    }
    runs.push(run);
  });
  let batch = null;
  const flush = () => {
    if (!batch) return;
    if (batch.ops) paintRecorded([['beginPath', []], ...batch.ops, ['=fillStyle', batch.color], ['fill', []]], batch.owners, batch.box, null, batch.cut, batch.elements);
    else { ctx.fillStyle = batch.color; ctx.fill(); }
    batch = null;
  };
  const whole = (p) => {
    const ink = recorded(p);
    if (!p.tracePath) {
      flush();
      if (ink) paintRecorded(record(p.draw), ownersOf(p), p.box, null, null, p.shade && p.shade()); else p.draw();
      return;
    }
    const owners = ink ? ownersOf(p) : null;
    if (!batch || batch.meshId !== p.meshId || (ink && batch.owners && batch.owners[0] !== owners[0])) {
      flush();
      if (!ink) ctx.beginPath();
      batch = { meshId: p.meshId, color: p.color, ops: ink ? [] : null, box: ink ? { ...p.box } : null, owners, cut: p.strokeCut, elements: [] };
    }
    if (batch.ops) {
      batch.ops.push(...record(p.tracePath));
      if (p.shade) batch.elements.push(...(p.shade() || []));
      const b = batch.box;
      b.x0 = Math.min(b.x0, p.box.x0); b.y0 = Math.min(b.y0, p.box.y0); b.x1 = Math.max(b.x1, p.box.x1); b.y1 = Math.max(b.y1, p.box.y1);
    } else p.tracePath();
  };
  const BIG = 1e5;
  // A piece drawn in several runs builds its outline once: its canvas calls are recorded the first time
  // (the drawing functions take the context as an argument) and replayed under each clip strip.
  const RECORDED = ['beginPath', 'moveTo', 'lineTo', 'closePath', 'arc', 'ellipse', 'fill', 'save', 'restore', 'transform', 'translate', 'scale', 'stroke', 'rect'];
  const record = (fn) => {
    const ops = [], rec = {};
    RECORDED.forEach(m => { rec[m] = (...args) => { ops.push([m, args]); }; });
    Object.defineProperty(rec, 'fillStyle', { set(v) { ops.push(['=fillStyle', v]); } });
    fn(rec);
    return ops;
  };
  // A piece that is one path and one fill (a traced piece, a joint body, a split cone part) can be built once as a
  // Path2D and filled under each clip strip; anything else (several fills, transforms) is replayed. null without Path2D.
  const PATH_OPS = ['moveTo', 'lineTo', 'closePath', 'arc', 'ellipse', 'rect'];
  const pathOf = (ops) => {
    if (typeof Path2D === 'undefined') return null;
    const path = new Path2D();
    let fills = 0;
    for (const [m, args] of ops) {
      if (PATH_OPS.includes(m)) path[m](...args);
      else if (m === 'fill') fills++;
      else if (m !== 'beginPath' && m !== '=fillStyle') return null;
    }
    return fills <= 1 ? path : null;
  };
  const replay = (ops) => ops.forEach(([m, args]) => (m[0] === '=' ? (ctx[m.slice(1)] = args) : ctx[m](...args)));
  const partial = (p, run) => {
    flush();
    const first = run.entries[0], last = run.entries[run.entries.length - 1], sl = p.slice;
    let lo = Math.min(...run.entries.map(e => e.lo)), hi = Math.max(...run.entries.map(e => e.hi));
    [p.slabMap.get(first.bin + 1), p.slabMap.get(last.bin - 1)].forEach(n => {
      if (!n || n.run === run || n.run.pos < run.pos) return;     // drawn earlier: it reaches under this run
      if (Math.abs(n.lo - hi) < 1e-6) hi += seam; else if (Math.abs(n.hi - lo) < 1e-6) lo -= seam;
    });
    const { ax, ay } = sl, at = (s, w) => ({ x: s * ax - w * ay, y: s * ay + w * ax });
    const s0 = Number.isFinite(lo) ? lo : -BIG, s1 = Number.isFinite(hi) ? hi : BIG;
    ctx.save();
    ctx.beginPath();
    [at(s0, -BIG), at(s1, -BIG), at(s1, BIG), at(s0, BIG)].forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
    ctx.closePath();
    ctx.clip();
    p.ops ||= record(p.tracePath || p.draw);
    if (recorded(p)) {
      const strip = new Path2D();
      [at(s0, -BIG), at(s1, -BIG), at(s1, BIG), at(s0, BIG)].forEach((q, i) => (i ? strip.lineTo(q.x, q.y) : strip.moveTo(q.x, q.y)));
      strip.closePath();
      const ops = p.tracePath ? [['beginPath', []], ...p.ops, ['=fillStyle', p.color], ['fill', []]] : p.ops, elements = shading && p.shade && p.shade();
      if (!elements || (!elements.length && !elements.fills)) { paintRecorded(ops, ownersOf(p), p.box, strip); ctx.restore(); return; }
      // A shaded piece is several layers (its base tone, the tone regions over it). Through the strip's antialiased clip edge each
      // layer would blend over what the neighboring strip already painted and leave a trace of the lower one (a line that slides
      // along the piece as the strata move), so it is built on a transparent layer and composited through the clip once.
      const pad = 3 / pxPerUnit, gl = scratchLayers(ctx)[2], g = gl.getContext('2d'), b = p.box;
      const x0 = Math.max(0, Math.floor(base.a * (b.x0 - pad) + base.e)), y0 = Math.max(0, Math.floor(base.d * (b.y0 - pad) + base.f));
      const x1 = Math.min(gl.width, Math.ceil(base.a * (b.x1 + pad) + base.e)), y1 = Math.min(gl.height, Math.ceil(base.d * (b.y1 + pad) + base.f));
      if (x1 > x0 && y1 > y0) {
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(x0, y0, x1 - x0, y1 - y0);
        g.setTransform(base);
        paintRecorded(ops, ownersOf(p), p.box, strip, null, elements, g);
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(gl, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
        ctx.restore();
      }
      ctx.restore();
      return;
    }
    if (p.path === undefined) p.path = pathOf(p.ops);
    if (p.path) { ctx.fillStyle = p.color; ctx.fill(p.path); }
    else if (p.tracePath) { ctx.beginPath(); replay(p.ops); ctx.fillStyle = p.color; ctx.fill(); } else replay(p.ops);
    ctx.restore();
  };
  runs.forEach(run => (run.entries.length === run.prim.slabMap.size ? whole(run.prim) : partial(run.prim, run)));
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
  const pxPerUnit = pixelScale(ctx);
  const splitOf = {};      // mesh id -> its split (findSplit) or null
  Object.values(meshes).forEach(m => { splitOf[m.id] = findSplit(m, owners); });
  const frame = {
    ctx, pxPerUnit, underlap: seamUnderlap(pxPerUnit), camPos, basis, projectPoint, projected, owners, sharedNodeIds, jointNodeIds,
    splitNodeIds: new Set(Object.values(splitOf).filter(Boolean).map(s => s.splitNodeId)),
    joints: computeJoints(jointNodeIds, owners, projected, camPos, basis, CURVE_TOL_PX / pxPerUnit),
    tol: CURVE_TOL_PX / pxPerUnit,   // chord tolerance in drawing units
    coneDepths: {},          // split cone mesh id -> sort key, for joints at their far end
    jointBodies: {},         // joint node id -> the two meshes' bodies there (draw order)
    extraPrimitives: [],     // split cones' host-colored parts, sorted with the rest
    clusterOf: buildClusters(owners),
    shading: null,           // the light engine (shading.js), when on
  };
  // Node id -> the projected far nodes of the split cones starting there (null if none): the host's sphere there gives way to them.
  const splitFars = {};
  Object.values(meshes).forEach(m => {
    const s = splitOf[m.id];
    if (s) (splitFars[s.splitNodeId] ||= []).push(projected[m.nodeIds.find(id => id !== s.splitNodeId)]);
  });
  frame.splitFarsOf = (id) => splitFars[id] || null;
  const shadingOpts = { basis, tol: frame.tol, px: 1 / pxPerUnit, camPos, projectPoint: frame.projectPoint };
  if (lighting.on && typeof Path2D !== 'undefined') frame.shading = makeShading(shadingOpts);
  // the skewed arches' outlines come from their shading's rows (buildSkewPrimitives); with the light off, from an instance without light
  frame.archGeom = frame.shading || makeShading({ ...shadingOpts, lit: false });

  const primitives = [];
  // The focus view draws only some meshes; everything else is still computed with all of them.
  const isShown = (mesh) => !focus.on || focus.meshIds.includes(mesh.id);
  Object.values(meshes).forEach(mesh => {
    if (!isShown(mesh)) return;
    if (mesh.skew) { primitives.push(...buildSkewPrimitives(frame, mesh)); return; }
    const screenCentroid = projectPoint(centroid(mesh.nodeIds.map(id => nodes[id].center)));
    const split = splitOf[mesh.id];
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
  // Debug: the straight cones' shade borders in world space (shading.js tubeBorderLines), round 2-node meshes only.
  if (debug.on && frame.shading) Object.values(meshes).forEach(mesh => {
    if (!isShown(mesh) || mesh.skew || mesh.nodeIds.length !== 2) return;
    const [A, B] = mesh.nodeIds.map(id => nodes[id]);
    if (A.shape.isSphere && B.shape.isSphere) frame.shading.tubeBorderLines(A.center, A.radius, B.center, B.radius);
  });

  drawPrimitives(ctx, primitives, 2 * frame.underlap, pxPerUnit, frame.shading);

  lastFrame = frame;

  if (debug.on && debug.joint) drawJointDebug(ctx, frame.joints);
  if (debug.on && debug.shape) drawShapeDebug(ctx, projected, projectPoint);
  if (debug.on && frame.shading) frame.shading.drawDebug(ctx);
  if (debug.on && debug.cone && !focus.on) {
    Object.values(meshes).forEach(mesh => {
      const split = splitOf[mesh.id];
      // (the curves are the closed forms, with a round or axial far end: not drawn for a free-axis squashed node)
      const squashed = [...mesh.nodeIds, ...(split ? split.hostMesh.nodeIds : [])].some(id => !nodes[id].shape.isSphere && !nodes[id].shape.axial);
      if (split && !squashed) drawConeDebugCurves(ctx, buildConeDebugCurves(split, mesh, split.hostMesh, camPos, projectPoint));
    });
  }
}
