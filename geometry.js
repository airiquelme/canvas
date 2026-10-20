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

// Is the point inside the (any, simple) polygon? Even-odd ray cast.
export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// The polygon `poly` with the polygon `cut` cut out of it, as a list of polygons
// (the cut can split it). Same idea as subtractDisc: the boundary of `poly`
// outside `cut`, and wherever it enters `cut` the boundary of `cut` itself (against
// poly's turning direction) up to the next point where poly's boundary leaves.
// `cut` may be any simple polygon; it is walked at its own scale (1/32 of its size).
export function subtractPolygon(poly, cut) {
  const dedupe = (pts) => pts.filter((p, i) => { const q = pts[(i + 1) % pts.length]; return Math.hypot(p.x - q.x, p.y - q.y) > 1e-9; });
  poly = dedupe(poly); cut = dedupe(cut);
  const n = poly.length, qn = cut.length;
  if (n < 3 || qn < 3) return [poly];
  const xs = cut.map(p => p.x), ys = cut.map(p => p.y);
  const size = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) || 1;
  const walk = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n], steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (size / 32)));
    for (let k = 0; k < steps; k++) walk.push({ x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps });
  }
  const m = walk.length, flags = walk.map(p => pointInPolygon(p, cut));
  if (!flags.some(Boolean)) return [poly];
  if (flags.every(Boolean)) return [];
  // The cut's boundary with cumulative lengths.
  const cum = [0];
  for (let k = 0; k < qn; k++) cum.push(cum[k] + Math.hypot(cut[(k + 1) % qn].x - cut[k].x, cut[(k + 1) % qn].y - cut[k].y));
  const perim = cum[qn];
  // Where segment a (outside) -> b (inside), or the reverse, crosses the cut's boundary:
  // the crossing nearest the outside point, and its position along the boundary.
  const cross = (out, inn) => {
    let best = null;
    for (let k = 0; k < qn; k++) {
      const c = cut[k], d = cut[(k + 1) % qn];
      const rx = inn.x - out.x, ry = inn.y - out.y, sx = d.x - c.x, sy = d.y - c.y, den = rx * sy - ry * sx;
      if (Math.abs(den) < 1e-18) continue;
      const t = ((c.x - out.x) * sy - (c.y - out.y) * sx) / den, u = ((c.x - out.x) * ry - (c.y - out.y) * rx) / den;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1 && (!best || t < best.t)) best = { t, pt: { x: out.x + rx * t, y: out.y + ry * t }, s: cum[k] + u * (cum[k + 1] - cum[k]) };
    }
    return best;
  };
  const nearest = (p) => { // fallback: closest boundary position to a point
    let bestD = Infinity, best = null;
    for (let k = 0; k < qn; k++) { const d = Math.hypot(cut[k].x - p.x, cut[k].y - p.y); if (d < bestD) { bestD = d; best = { pt: cut[k], s: cum[k] }; } }
    return best;
  };
  const start = flags.findIndex((f, i) => !f && flags[(i + m - 1) % m]);
  const stretches = [];
  let cur = null;
  for (let k = 0; k < m; k++) {
    const i = (start + k) % m, prev = walk[(i + m - 1) % m];
    if (!flags[i]) {
      if (!cur) {
        const x = cross(walk[i], prev) || nearest(walk[i]);
        cur = { X: x, pts: [x.pt] };
        stretches.push(cur);
      }
      cur.pts.push(walk[i]);
    } else if (cur) {
      cur.E = cross(prev, walk[i]) || nearest(walk[i]);
      cur.pts.push(cur.E.pt);
      cur = null;
    }
  }
  const area = (pts) => pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p.x * q.y - q.x * p.y; }, 0);
  // Follow the cut's boundary against poly's turning direction.
  const dir = Math.sign(area(poly)) === Math.sign(area(cut)) ? -1 : 1;
  const wrap = (a) => ((a % perim) + perim) % perim;
  const used = new Array(stretches.length).fill(false), result = [];
  for (let s0 = 0; s0 < stretches.length; s0++) {
    if (used[s0]) continue;
    const out = [];
    let s = s0;
    while (!used[s] && stretches[s].E) {
      used[s] = true;
      out.push(...stretches[s].pts);
      const qE = stretches[s].E.s;
      let best = -1, bestD = Infinity;
      stretches.forEach((t, j) => {
        let d = wrap(dir * (t.X.s - qE));
        if (d < 1e-12 && j !== s) d = perim;
        if (d < bestD) { bestD = d; best = j; }
      });
      // The cut's vertices passed on the way, nearest first.
      const mids = [];
      for (let k = 0; k < qn; k++) { const d = wrap(dir * (cum[k] - qE)); if (d > 1e-12 && d < bestD) mids.push({ d, p: cut[k] }); }
      mids.sort((p, q) => p.d - q.d).forEach(v => out.push(v.p));
      s = best;
    }
    if (out.length >= 3) result.push(out);
  }
  return result;
}

// The polygon with the disc cut out of it, as a list of polygons (the cut can
// split it): each is made of the original boundary outside the disc plus the
// circle's own arc wherever the disc bites in, so no area inside the disc is left.
// The boundary is walked in steps of 1/16 of the radius, so the cut follows the
// circle at any scale. A polygon with no part in the disc is returned as is.
// Where the boundary enters the disc it follows the circle (against the polygon's
// own turning direction) to the next point where the boundary leaves it.
export function subtractDisc(poly, center, radius) {
  const n = poly.length;
  if (n < 3) return [poly];
  const inDisc = (p) => Math.hypot(p.x - center.x, p.y - center.y) < radius;
  const walk = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n], steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (radius / 16)));
    for (let k = 0; k < steps; k++) walk.push({ x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps });
  }
  const flags = walk.map(inDisc), m = walk.length;
  if (!flags.some(Boolean)) return [poly];
  if (flags.every(Boolean)) return [];
  const angle = (p) => Math.atan2(p.y - center.y, p.x - center.x);
  const onCircle = (a) => ({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) });
  const TWO = Math.PI * 2, wrap = (a) => ((a % TWO) + TWO) % TWO;
  // Rotate so the walk starts just after the boundary leaves the disc.
  const start = flags.findIndex((f, i) => !f && flags[(i + m - 1) % m]);
  // Stretches outside the disc: each runs from an exit point X to the next entry point E.
  const stretches = [];
  let cur = null;
  for (let k = 0; k <= m; k++) {
    const i = (start + k) % m, prev = walk[(i + m - 1) % m];
    if (k === m) { if (cur) { cur.E = cur.pts[cur.pts.length - 1]; } break; }
    if (!flags[i]) {
      if (!cur) {
        const X = segmentCircleHit(walk[i], prev, center, radius) || onCircle(angle(walk[i]));
        cur = { X, pts: [X] };
        stretches.push(cur);
      }
      cur.pts.push(walk[i]);
    } else if (cur) {
      cur.E = segmentCircleHit(prev, walk[i], center, radius) || onCircle(angle(walk[i]));
      cur.pts.push(cur.E);
      cur = null;
    }
  }
  // The circle is followed against the polygon's turning direction.
  const area = poly.reduce((s, p, i) => { const q = poly[(i + 1) % n]; return s + p.x * q.y - q.x * p.y; }, 0);
  const dir = area >= 0 ? -1 : 1;
  const used = new Array(stretches.length).fill(false), result = [];
  for (let s0 = 0; s0 < stretches.length; s0++) {
    if (used[s0]) continue;
    const out = [];
    let s = s0;
    while (!used[s]) {
      used[s] = true;
      out.push(...stretches[s].pts);
      // The next exit point along the circle from this entry point.
      const aE = angle(stretches[s].E);
      let best = -1, bestD = Infinity;
      stretches.forEach((t, j) => {
        let d = wrap(dir * (angle(t.X) - aE));
        if (d < 1e-12 && j !== s) d = TWO;           // coincident points: not the next one
        if (d < bestD) { bestD = d; best = j; }
      });
      const arcSteps = Math.max(1, Math.ceil(bestD / (Math.PI / 90)));
      for (let q = 1; q < arcSteps; q++) out.push(onCircle(aE + dir * bestD * q / arcSteps));
      s = best;
    }
    if (out.length >= 3) result.push(out);
  }
  return result;
}
