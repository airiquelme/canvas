// Canvas drawing primitives. Layering rules and terms: see CLAUDE.md.
import { SEAM_PX, MIN_CRESCENT_PX, SPLIT_STRIP_FRAC } from './config.js';
import {
  vecSub, vecCross, vecDot, vecNormalize, circleRimPoint,
  capsuleTangentPoints, convexHull,
} from './geometry.js';

// SEAM_PX / 2 device pixels, in the current transform's units.
export function seamUnderlap(ctx) {
  const t = ctx.getTransform();
  return (SEAM_PX / 2) / Math.hypot(t.a, t.b);
}

export function fillPolygon(ctx, pts, color) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

export function fillCircle(ctx, center, radius, color) {
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

// Fills a triangle plus a 1px stroke of the same color.
export function drawTriangle(ctx, p1, p2, p3, color) {
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.lineTo(p3.x, p3.y);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();
}

// ---------------------------------------------------------
// TRACED PIECES (appended to the current path, filled later as one
// nonzero union -- all wound anticlockwise on screen)
// ---------------------------------------------------------

export function traceCapsule(ctx, c1, r1, c2, r2, skipCap1 = false, skipCap2 = false) {
  const { t1Angle, t2Angle, p1a, p1b, p2a, p2b } = capsuleTangentPoints(c1, r1, c2, r2);
  ctx.moveTo(p1a.x, p1a.y);
  ctx.lineTo(p1b.x, p1b.y);
  if (skipCap2) ctx.lineTo(p2a.x, p2a.y);
  else ctx.arc(c2.x, c2.y, r2, t1Angle, t2Angle, true);
  ctx.lineTo(p2b.x, p2b.y);
  if (skipCap1) ctx.lineTo(p1a.x, p1a.y);
  else ctx.arc(c1.x, c1.y, r1, t2Angle, t1Angle, true);
  ctx.closePath();
}

export function traceCircle(ctx, c, r) {
  ctx.moveTo(c.x + r, c.y);
  ctx.arc(c.x, c.y, r, 0, -Math.PI * 2, true);
  ctx.closePath();
}

export function traceTriangle(ctx, p1, p2, p3) {
  // Anticlockwise on screen = negative shoelace area (y points down).
  const area = (p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x);
  if (area > 0) [p2, p3] = [p3, p2];
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.lineTo(p3.x, p3.y);
  ctx.closePath();
}

// ---------------------------------------------------------
// JOINT CAPSULES
// ---------------------------------------------------------

// A capsule with optional skipped caps (a skipped cap is closed by a chord:
// the shared node's circle is drawn separately).
export function drawPairCapsule(ctx, c1, r1, c2, r2, color, skipCap1 = false, skipCap2 = false) {
  const { t1Angle, t2Angle, p1a, p1b, p2a, p2b } = capsuleTangentPoints(c1, r1, c2, r2);
  ctx.beginPath();
  ctx.moveTo(p1a.x, p1a.y);
  ctx.lineTo(p1b.x, p1b.y);
  if (skipCap2) ctx.lineTo(p2a.x, p2a.y); else ctx.arc(c2.x, c2.y, r2, t1Angle, t2Angle, true);
  ctx.lineTo(p2b.x, p2b.y);
  if (skipCap1) ctx.lineTo(p1a.x, p1a.y); else ctx.arc(c1.x, c1.y, r1, t2Angle, t1Angle, true);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

// ---------------------------------------------------------
// JOINT NODE (moon-phase split circle)
// ---------------------------------------------------------

// A joint's node disc, divided by the terminator from the joint ring
// (jointSplit.js): the dominant region (terminator + the rim arc on its side)
// goes first, reaching `underlap` under the crescent's inner edge but not its
// rim; the crescent goes on top. `split` = projectJointSplit's result.
export function drawJointSplitFromCurve(ctx, center, radius, split, dominantColor, crescentColor) {
  const { terminator, th0, th1, domIncreasing, span } = split;
  const t = ctx.getTransform();
  const pxPerUnit = Math.hypot(t.a, t.b);
  const e0 = terminator[0], e1 = terminator[terminator.length - 1];
  // The crescent arc runs from e1 to e0: increasing angle if the dominant arc
  // is th0 -> th1, decreasing otherwise.
  const crescentSpan = domIncreasing ? 2 * Math.PI - span : span;
  const crescentAt = (f) => th1 + (domIncreasing ? 1 : -1) * crescentSpan * f;

  // Thickness of the crescent: its area over the longer of chord and rim arc.
  const outline = terminator.slice();
  for (let k = 1; k <= 16; k++) {
    const a = crescentAt(k / 16);
    outline.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) });
  }
  let area = 0;
  outline.forEach((p, i) => { const q = outline[(i + 1) % outline.length]; area += p.x * q.y - q.x * p.y; });
  const chordLen = Math.hypot(e1.x - e0.x, e1.y - e0.y);
  const thickness = Math.abs(area / 2) / Math.max(chordLen, radius * crescentSpan, 1e-6);
  if (thickness * pxPerUnit < MIN_CRESCENT_PX) {
    fillCircle(ctx, center, radius, dominantColor);
    return;
  }

  // Push the terminator toward the crescent by the underlap (not its ends).
  const underlap = seamUnderlap(ctx);
  const mid = crescentAt(0.5);
  let nx = -(e1.y - e0.y) / (chordLen || 1), ny = (e1.x - e0.x) / (chordLen || 1);
  if (nx * Math.cos(mid) + ny * Math.sin(mid) < 0) { nx = -nx; ny = -ny; }
  const last = terminator.length - 1;

  ctx.fillStyle = dominantColor;
  ctx.beginPath();
  terminator.forEach((p, i) => {
    const k = (i === 0 || i === last) ? 0 : underlap;
    if (i === 0) ctx.moveTo(p.x + nx * k, p.y + ny * k); else ctx.lineTo(p.x + nx * k, p.y + ny * k);
  });
  ctx.arc(center.x, center.y, radius, th1, th0, domIncreasing);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = crescentColor;
  ctx.beginPath();
  terminator.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.arc(center.x, center.y, radius, th1, th0, !domIncreasing);
  ctx.closePath();
  ctx.fill();
}

// ---------------------------------------------------------
// SPLIT CONE (2-node mesh sharing a node with a 3+ node mesh)
// ---------------------------------------------------------

// The cone's axis frame: unit axis, length, and a radial direction per angle.
export function coneFrame(node, other) {
  const dir = vecNormalize(vecSub(other.center, node.center));
  const len = Math.hypot(other.center.x - node.center.x, other.center.y - node.center.y, other.center.z - node.center.z);
  const helper = Math.abs(dir.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const u = vecNormalize(vecCross(dir, helper));
  const v = vecCross(dir, u);
  const radial = (a) => ({
    x: u.x * Math.cos(a) + v.x * Math.sin(a),
    y: u.y * Math.cos(a) + v.y * Math.sin(a),
    z: u.z * Math.cos(a) + v.z * Math.sin(a),
  });
  return { dir, len, radial };
}

// A circle perpendicular to the cone axis (from findSplitRing,
// splitRing.js), projected.
function projectAxialCircle(center, radius, frame, n, projectPoint) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const r = frame.radial((i / n) * Math.PI * 2);
    pts.push(projectPoint({ x: center.x + r.x * radius, y: center.y + r.y * radius, z: center.z + r.z * radius }));
  }
  return pts;
}

// The far color's strip just past the split ring, minus the ring's own
// ellipse (the shared part owns that), drawn after the host (CLAUDE.md "Split cone").
export function drawSplitStrip(ctx, ring, color, projectPoint) {
  const d = Math.min(SPLIT_STRIP_FRAC * ring.ringRadius, ring.cone.sB - ring.s);
  const shiftedCenter = {
    x: ring.surface.x + ring.dir.x * d, y: ring.surface.y + ring.dir.y * d, z: ring.surface.z + ring.dir.z * d,
  };
  const ringPts = projectAxialCircle(ring.surface, ring.ringRadius, ring.frame, 128, projectPoint);
  const shifted = projectAxialCircle(shiftedCenter, ring.ringRadius + ring.cone.slope * d, ring.frame, 128, projectPoint);
  ctx.beginPath();
  convexHull(ringPts.concat(shifted)).forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ringPts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill('evenodd');
}

// The host-colored part, from the shared node to the ring: the hull of the
// projected ring, the tangent circle, and the shared sphere's rim. The sphere
// only counts up to its tangent circle: past it, the sphere is inside the
// cone, so its rim points there (axial coordinate above sinT * r, with
// axisCam the axis in camera space) are left out.
export function drawSplitShared(ctx, sharedProj, ring, axisCam, color, projectPoint) {
  const ringPts = projectAxialCircle(ring.surface, ring.ringRadius, ring.frame, 128, projectPoint);
  const tangentPts = projectAxialCircle(ring.tangentCenter, ring.tangentRadius, ring.frame, 128, projectPoint);
  const rim = Array.from({ length: 128 }, (_, i) => circleRimPoint(sharedProj.center, sharedProj.radius, (i / 128) * Math.PI * 2));
  const sharedSide = rim.filter((_, i) => {
    const th = (i / 128) * Math.PI * 2;
    return Math.cos(th) * axisCam.x - Math.sin(th) * axisCam.y <= ring.cone.sinT + 1e-9;
  });
  fillPolygon(ctx, convexHull(sharedSide.concat(tangentPts, ringPts)), color);
}

// Drops the interior of a hull's run of `arc` points, keeping the run's two
// ends: the far end of the cone gets a chord instead of its cap.
function chordOffArc(hull, arc) {
  const n = hull.length, on = hull.map(p => arc.has(p));
  if (!on.some(Boolean) || on.every(Boolean)) return hull;
  return hull.filter((p, i) => !on[i] || !on[(i + n - 1) % n] || !on[(i + 1) % n]);
}

// The cone's own part, from the ring to the far node. When the far node is a
// joint (opts.farIsJoint) this part has no cap there: the joint circle is drawn
// separately and the part ends in a chord.
export function drawSplitFar(ctx, farProj, ring, color, projectPoint, opts = {}) {
  const ringPts = projectAxialCircle(ring.surface, ring.ringRadius, ring.frame, 128, projectPoint);
  const farCircle = Array.from({ length: 128 }, (_, i) => circleRimPoint(farProj.center, farProj.radius, (i / 128) * Math.PI * 2));
  let hull = convexHull(ringPts.concat(farCircle));
  if (opts.farIsJoint) hull = chordOffArc(hull, new Set(farCircle));
  fillPolygon(ctx, hull, color);
}
