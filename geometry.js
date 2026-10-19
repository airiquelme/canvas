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

// The tangent point on the terminator ellipse's visible half (local x > 0
// for phase >= 0, x < 0 otherwise) nearest the external point's direction.
// When no candidate is on that half, returns the half's center with
// capped: true -- a fallback, not a real tangent (see CLAUDE.md).
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
  const onCorrectSide = (c) => (c.x >= 0) === wantsPositiveSide;
  const angularDist = (p, q) => Math.abs(wrapAngle(p - q));
  const dirAngle = Math.atan2(localY, localX);

  const sideCandidates = candidates.filter(onCorrectSide);
  const pool = sideCandidates.length > 0 ? sideCandidates : candidates;
  let bestTangent = pool.reduce((best, curr) =>
    angularDist(curr.angle, dirAngle) < angularDist(best.angle, dirAngle) ? curr : best
  );

  let capped = false;
  if (!onCorrectSide(bestTangent)) {
    const a = Math.max(radiusX, 1e-4);
    const centerAngle = wantsPositiveSide ? 0 : Math.PI;
    bestTangent = { x: a * Math.cos(centerAngle), y: radiusY * Math.sin(centerAngle), angle: centerAngle };
    capped = true;
  }

  const cos_rot_back = Math.cos(ellipseRotation);
  const sin_rot_back = Math.sin(ellipseRotation);
  const screenX = ellipseCenter.x + (bestTangent.x * cos_rot_back - bestTangent.y * sin_rot_back);
  const screenY = ellipseCenter.y + (bestTangent.x * sin_rot_back + bestTangent.y * cos_rot_back);
  return { x: screenX, y: screenY, capped };
}
