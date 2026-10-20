// Pure 2D/3D math -- no canvas.

export function vecSub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
export function vecCross(a, b) { return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }; }
export function vecDot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
export function vecNormalize(v) { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; }

// Wraps an angle into [-PI, PI].
export function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// ---------------------------------------------------------
// 3D SIGNED DISTANCES (negative inside) and root finding
// ---------------------------------------------------------

export function sdfSphere(p, c, r) {
  return Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z) - r;
}

// Cone frustum (capsule) from sphere (a, ra) to sphere (b, rb). Not an
// exact distance, but the sign is right, which is all the roots need.
export function sdfFrustum(p, a, ra, b, rb) {
  const ab = vecSub(b, a), ap = vecSub(p, a);
  const t = Math.min(1, Math.max(0, vecDot(ap, ab) / (vecDot(ab, ab) || 1)));
  return Math.hypot(ap.x - ab.x * t, ap.y - ab.y * t, ap.z - ab.z * t) - (ra + (rb - ra) * t);
}

// Outward face planes { n, p, idx } of the convex hull of 3D points; empty when
// they are all coplanar (no volume).
export function hullPlanes(pts) {
  const planes = [];
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) for (let k = j + 1; k < pts.length; k++) {
    const n = vecCross(vecSub(pts[j], pts[i]), vecSub(pts[k], pts[i]));
    if (Math.hypot(n.x, n.y, n.z) < 1e-9) continue;
    const nn = vecNormalize(n);
    let pos = false, neg = false;
    pts.forEach(q => {
      const d = vecDot(nn, vecSub(q, pts[i]));
      if (d > 1e-6) pos = true; else if (d < -1e-6) neg = true;
    });
    if (pos && neg) continue;
    if (!pos && !neg) return [];
    planes.push({ n: pos ? { x: -nn.x, y: -nn.y, z: -nn.z } : nn, p: pts[i], idx: [i, j, k] });
  }
  return planes;
}

// The visible flat face of three spheres: the plane tangent to all three on
// the outward side of `outN` (the centers' face normal). Returns { n, p, tri }
// (tri = the three contact points), or null when no tangent plane exists.
export function sphereFace(centers, radii, outN) {
  const e1 = vecSub(centers[1], centers[0]), e2 = vecSub(centers[2], centers[0]);
  const r1 = radii[0] - radii[1], r2 = radii[0] - radii[2];
  const a11 = vecDot(e1, e1), a12 = vecDot(e1, e2), a22 = vecDot(e2, e2);
  const det = a11 * a22 - a12 * a12;
  if (Math.abs(det) < 1e-12) return null;
  const a = (r1 * a22 - r2 * a12) / det, b = (r2 * a11 - r1 * a12) / det;
  const w = { x: a * e1.x + b * e2.x, y: a * e1.y + b * e2.y, z: a * e1.z + b * e2.z };
  const w2 = vecDot(w, w);
  if (w2 >= 1) return null;
  const h = Math.sqrt(1 - w2);
  const n = { x: w.x + h * outN.x, y: w.y + h * outN.y, z: w.z + h * outN.z };
  const at = (c, r) => ({ x: c.x + r * n.x, y: c.y + r * n.y, z: c.z + r * n.z });
  return { n, p: at(centers[0], radii[0]), tri: centers.map((c, i) => at(c, radii[i])) };
}

// Is p (on the face's plane) inside the face triangle?
export function pointInTriangle(p, [a, b, c]) {
  const n = vecCross(vecSub(b, a), vecSub(c, a));
  return [[a, b], [b, c], [c, a]].every(([u, v]) => vecDot(vecCross(vecSub(v, u), vecSub(p, u)), n) >= 0);
}

export function insideHull(planes, p) {
  return planes.length > 0 && planes.every(({ n, p: q }) => vecDot(n, vecSub(p, q)) < 0);
}

// A root of f in [lo, hi], given f(lo) and f(hi) differ in sign.
export function bisectRoot(f, lo, hi, iters = 24) {
  const loNeg = f(lo) < 0;
  for (let i = 0; i < iters; i++) {
    const mid = (lo + hi) / 2;
    if ((f(mid) < 0) === loNeg) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

export function circleRimPoint(center, radius, angle) {
  return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) };
}

export function closestPointOnCircle(center, radius, point) {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  if (Math.hypot(dx, dy) < 1e-9) return { x: center.x + radius, y: center.y };
  return circleRimPoint(center, radius, Math.atan2(dy, dx));
}

// ---------------------------------------------------------
// CAPSULES (two circles joined by their outer tangent lines)
// ---------------------------------------------------------

// Directions from each center to the two tangent lines' touch points.
export function computePairTangents(c1, r1, c2, r2) {
  const dx = c2.x - c1.x, dy = c2.y - c1.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  const centerAngle = Math.atan2(dy, dx);
  const alpha = Math.asin((r1 - r2) / d);
  return { t1Angle: centerAngle + Math.PI / 2 - alpha, t2Angle: centerAngle - Math.PI / 2 + alpha };
}

// Edge t1 runs p1a (on c1) -> p1b (on c2); edge t2 runs p2a (on c2) -> p2b (on c1).
export function capsuleTangentPoints(c1, r1, c2, r2) {
  const { t1Angle, t2Angle } = computePairTangents(c1, r1, c2, r2);
  return {
    t1Angle, t2Angle,
    p1a: circleRimPoint(c1, r1, t1Angle),
    p1b: circleRimPoint(c2, r2, t1Angle),
    p2a: circleRimPoint(c2, r2, t2Angle),
    p2b: circleRimPoint(c1, r1, t2Angle),
  };
}

// ---------------------------------------------------------
// POLYGONS
// ---------------------------------------------------------

// Monotone chain convex hull.
export function convexHull(points) {
  const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

// ---------------------------------------------------------
// LINE / CIRCLE INTERSECTIONS
// ---------------------------------------------------------

// First point where segment from -> to crosses the circle, or null.
export function segmentCircleHit(from, to, center, radius) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const fx = from.x - center.x, fy = from.y - center.y;
  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - radius * radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0 || a <= 1e-9) return null;
  const sqrtDisc = Math.sqrt(disc);
  const t = [(-b - sqrtDisc) / (2 * a), (-b + sqrtDisc) / (2 * a)].find(t => t >= 0 && t <= 1);
  return t === undefined ? null : { x: from.x + dx * t, y: from.y + dy * t };
}
