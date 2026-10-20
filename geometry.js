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

// One tangent edge of a projected pair, from the pivot's rim to the other's.
export function edgeSegment(pivotProj, otherProj, angle) {
  return {
    a: circleRimPoint(pivotProj.center, pivotProj.radius, angle),
    b: circleRimPoint(otherProj.center, otherProj.radius, angle),
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

// A capsule's outline as a convex polygon (hull of both sampled circles).
export function capsulePolygon(c1, r1, c2, r2, n = 64) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    pts.push(circleRimPoint(c1, r1, t));
    pts.push(circleRimPoint(c2, r2, t));
  }
  return convexHull(pts);
}

// Sutherland-Hodgman: the part of `subject` inside the convex `clip`.
export function clipToConvex(subject, clip) {
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  let area = 0;
  for (let i = 0; i < clip.length; i++) area += cross(clip[0], clip[i], clip[(i + 1) % clip.length]);
  const sign = area < 0 ? -1 : 1;
  let out = subject;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    const inside = (p) => sign * cross(a, b, p) >= 0;
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j], q = input[(j + 1) % input.length];
      const pin = inside(p), qin = inside(q);
      if (pin) out.push(p);
      if (pin !== qin) {
        const cp = cross(a, b, p), cq = cross(a, b, q);
        const s = cp / (cp - cq);
        out.push({ x: p.x + (q.x - p.x) * s, y: p.y + (q.y - p.y) * s });
      }
    }
  }
  return out;
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

// The FAR crossing of a ray (origin + t*dir, t >= 0) with a circle: the
// side matching the capsule's outer silhouette.
export function rayCircleFarSide(origin, dir, center, radius) {
  const fx = origin.x - center.x, fy = origin.y - center.y;
  const a = dir.x * dir.x + dir.y * dir.y;
  if (a < 1e-9) return null;
  const b = 2 * (fx * dir.x + fy * dir.y);
  const c = fx * fx + fy * fy - radius * radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sqrtDisc = Math.sqrt(disc);
  const roots = [(-b - sqrtDisc) / (2 * a), (-b + sqrtDisc) / (2 * a)].filter(t => t >= 0).sort((x, y) => x - y);
  if (roots.length === 0) return null;
  const t = roots[roots.length - 1];
  return { x: origin.x + t * dir.x, y: origin.y + t * dir.y, t };
}

// Where two capsule edges (both starting at the shared pivot) cross. See
// CLAUDE.md "Edge crossing" for the short-arm and extended fallbacks.
export function findEdgeCrossing(s1, s2, farNode1, farNode2, allowExtended = false) {
  const d1 = { x: s1.b.x - s1.a.x, y: s1.b.y - s1.a.y };
  const d2 = { x: s2.b.x - s2.a.x, y: s2.b.y - s2.a.y };
  const denom = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((s2.a.x - s1.a.x) * d2.y - (s2.a.y - s1.a.y) * d2.x) / denom;
  const u = ((s2.a.x - s1.a.x) * d1.y - (s2.a.y - s1.a.y) * d1.x) / denom;
  if (t < 0 || u < 0) return null; // behind the pivot
  if (t <= 1 && u <= 1) {
    return { x: s1.a.x + t * d1.x, y: s1.a.y + t * d1.y };
  }
  if (t > 1) {
    // s1's arm is the short one: where s2 crosses farNode1's circle.
    const hit = rayCircleFarSide(s2.a, d2, farNode1.center, farNode1.radius);
    if (hit && hit.t <= 1) return { x: hit.x, y: hit.y };
  }
  if (u > 1) {
    // s2's arm is the short one: where s1 crosses farNode2's circle.
    const hit = rayCircleFarSide(s1.a, d1, farNode2.center, farNode2.radius);
    if (hit && hit.t <= 1) return { x: hit.x, y: hit.y };
  }
  if (allowExtended && t > 1 && u > 1) {
    // Last resort: the extended lines' crossing, past both arms.
    return { x: s1.a.x + t * d1.x, y: s1.a.y + t * d1.y, extended: true };
  }
  return null;
}

// ---------------------------------------------------------
// ELLIPSE TANGENTS
// ---------------------------------------------------------

// The two analytic tangent points from an external point to an ellipse,
// in the ellipse's local (unrotated) frame. [] if none is well defined.
function ellipseTangentCandidatesLocal(radiusX, radiusY, localX, localY) {
  const a = Math.max(radiusX, 1e-4);
  const b = radiusY;

  const u = localX / a;
  const v = localY / b;
  const d2 = u * u + v * v; // >= 1 for an external point

  let X1, Y1, X2, Y2;
  if (Math.abs(v) > 1e-6) {
    const disc = Math.max(0, d2 - 1);
    const sqrtTerm = Math.abs(v) * Math.sqrt(disc);
    X1 = (u + sqrtTerm) / d2;
    X2 = (u - sqrtTerm) / d2;
    Y1 = (1 - X1 * u) / v;
    Y2 = (1 - X2 * u) / v;
  } else if (Math.abs(u) > 1e-6) {
    // Point on the local x axis: the tangent condition is X*u = 1.
    X1 = X2 = 1 / u;
    const yy = Math.sqrt(Math.max(0, 1 - X1 * X1));
    Y1 = yy;
    Y2 = -yy;
  } else {
    return [];
  }

  return [
    { x: a * X1, y: b * Y1, angle: Math.atan2(Y1, X1) },
    { x: a * X2, y: b * Y2, angle: Math.atan2(Y2, X2) },
  ];
}

// The tangent point where the seam line touches the terminator ellipse. Always
// a true tangent point (the line touches the ellipse and never enters it),
// except in a narrow window of thin ellipses described below.
//  - Only the half of the ellipse on the crescent's side (local x >= 0 for
//    phase >= 0, x <= 0 otherwise) is a boundary between the joint's two
//    colors, so a wide ellipse takes the tangent on that half nearest the
//    external point (if both touch the hidden half: the pole it faces).
//  - A collapsed ellipse is a line, and its two halves coincide. Taking the
//    visible half's tangent then flips with the sign of the phase, and can be
//    the far end of the line on one side of the swap and the near end on the
//    other. So for a thin ellipse the nearest tangent is taken, on either
//    side: the point moves toward the external point as the ellipse collapses
//    and back out after the swap. The two choices are blended along the
//    ellipse while its half-width goes from 0.02 to 0.08 of its height (a few
//    pixels, so the blend is barely off the tangent).
export function findEllipseTangentPoint(ellipseCenter, radiusX, radiusY, ellipseRotation, phase, externalPoint) {
  const dx = externalPoint.x - ellipseCenter.x;
  const dy = externalPoint.y - ellipseCenter.y;
  const cos_rot = Math.cos(-ellipseRotation);
  const sin_rot = Math.sin(-ellipseRotation);
  const localX = dx * cos_rot - dy * sin_rot;
  const localY = dx * sin_rot + dy * cos_rot;

  const candidates = ellipseTangentCandidatesLocal(radiusX, radiusY, localX, localY);
  if (candidates.length === 0) return null;

  const wantsPositiveSide = phase >= 0;
  const angularDist = (p, q) => Math.abs(wrapAngle(p - q));
  const dirAngle = Math.atan2(localY, localX);
  const closest = (list) => list.reduce((best, curr) =>
    angularDist(curr.angle, dirAngle) < angularDist(best.angle, dirAngle) ? curr : best);

  const nearSign = localY >= 0 ? 1 : -1; // which pole the external point faces
  const distToPoint = (c) => Math.hypot(c.x - localX, c.y - localY);
  const nearest = candidates.reduce((best, c) => distToPoint(c) < distToPoint(best) ? c : best);
  const visible = candidates.filter((c) => wantsPositiveSide ? c.x >= 0 : c.x <= 0);
  const onVisibleHalf = visible.length > 0
    ? closest(visible)
    : { x: 0, y: nearSign * radiusY, angle: nearSign * Math.PI / 2 };

  const width = radiusX / radiusY; // 1 for a full circle, 0 for a line
  const t = Math.min(1, Math.max(0, (width - 0.02) / (0.08 - 0.02)));
  const weight = t * t * (3 - 2 * t); // 0: nearest tangent, 1: visible half's
  let bestTangent = onVisibleHalf;
  if (weight < 1) {
    const angle = nearest.angle + wrapAngle(onVisibleHalf.angle - nearest.angle) * weight;
    bestTangent = { x: Math.max(radiusX, 1e-4) * Math.cos(angle), y: radiusY * Math.sin(angle) };
  }

  const cos_rot_back = Math.cos(ellipseRotation);
  const sin_rot_back = Math.sin(ellipseRotation);
  const screenX = ellipseCenter.x + (bestTangent.x * cos_rot_back - bestTangent.y * sin_rot_back);
  const screenY = ellipseCenter.y + (bestTangent.x * sin_rot_back + bestTangent.y * cos_rot_back);
  return { x: screenX, y: screenY };
}
