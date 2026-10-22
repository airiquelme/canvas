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
// NODE SHAPES: spheroids and their support function
// ---------------------------------------------------------

// A spheroid of the volume of a sphere of radius `radius`: semi-axis ra = radius * squash
// along the unit `axis`, rp = radius / sqrt(squash) across it (squash < 1 flattens, > 1
// stretches). isSphere is exact (squash === 1), so callers can keep their closed forms.
// `cutDir` is the unit full-diameter direction (perpendicular to the axis) of the shape's
// cut: the meridian ellipse through both poles (semi-axes ra along the axis, rp along
// cutDir), a fixed 3D ellipse that is only drawn in the debug view. Every meridian is the
// same ellipse; `cut` (a hint vector, default world +x) says which one, projected
// perpendicular to the axis (world +z if the hint is parallel to it).
export function makeShape(radius, squash, axis, cut = { x: 1, y: 0, z: 0 }) {
  const l = Math.hypot(axis.x, axis.y, axis.z) || 1;
  const a = { x: axis.x / l, y: axis.y / l, z: axis.z / l };
  const perp = (h) => { const k = vecDot(h, a); return { x: h.x - k * a.x, y: h.y - k * a.y, z: h.z - k * a.z }; };
  let p = perp(cut);
  if (Math.hypot(p.x, p.y, p.z) < 1e-6) p = perp({ x: 0, y: 0, z: 1 });
  const pl = Math.hypot(p.x, p.y, p.z);
  const cutDir = { x: p.x / pl, y: p.y / pl, z: p.z / pl }, ra = radius * squash, rp = radius / Math.sqrt(squash);
  // Q = S^2 = rp^2 I + (ra^2 - rp^2) a a^T (row-major), and the principal frame for ellipsoid distances: the
  // semi-axes ex = [rp, rp, ra] along ux = [cutDir, a x cutDir, a] (three world unit vectors, flat).
  const rp2 = rp * rp, d = ra * ra - rp2, third = vecCross(a, cutDir);
  return {
    isSphere: squash === 1,
    axis: a,
    cutDir,
    ra,
    rp,
    Q: [rp2 + d * a.x * a.x, d * a.x * a.y, d * a.x * a.z, d * a.y * a.x, rp2 + d * a.y * a.y, d * a.y * a.z, d * a.z * a.x, d * a.z * a.y, rp2 + d * a.z * a.z],
    ex: [rp, rp, ra],
    ux: [cutDir.x, cutDir.y, cutDir.z, third.x, third.y, third.z, a.x, a.y, a.z],
  };
}

// A general ellipsoid whose z axis is the view axis and whose other two axes are in the screen
// plane: semi-axes a, b along the screen directions at angle phi (canvas angle, y down) and
// the first, and c along z. It is the shape the flat solid of a joint gives a node (render.js):
// its orthographic shadow along z is exactly the ellipse { a, b, phi }. Same interface as a
// spheroid for shapeMul / shapeForm / supportPoint / supportH (the matrices are row-major 3x3):
// Q = S^2, S the symmetric semi-axis matrix, Sinv its inverse.
export function ellipsoidShape(a, b, phi, c) {
  const cs = Math.cos(phi), sn = Math.sin(phi);
  const mat = (p, q, r) => [p * cs * cs + q * sn * sn, (p - q) * cs * sn, 0, (p - q) * cs * sn, p * sn * sn + q * cs * cs, 0, 0, 0, r];
  return {
    isSphere: false, flat: true, axes: [a, b, c], rot: { cs, sn },
    ex: [a, b, c], ux: [cs, sn, 0, -sn, cs, 0, 0, 0, 1],
    Q: mat(a * a, b * b, c * c), S: mat(a, b, c), Sinv: mat(1 / a, 1 / b, 1 / c),
  };
}

// M v for a row-major 3x3 matrix.
export function mat3Mul(M, v) {
  return { x: M[0] * v.x + M[1] * v.y + M[2] * v.z, y: M[3] * v.x + M[4] * v.y + M[5] * v.z, z: M[6] * v.x + M[7] * v.y + M[8] * v.z };
}

// S^2 n for a node shape (spheroid: rp^2 n + (ra^2 - rp^2) (axis . n) axis).
export function shapeMul(shape, n) {
  if (shape.Q) return mat3Mul(shape.Q, n);
  const k = (shape.ra * shape.ra - shape.rp * shape.rp) * vecDot(shape.axis, n), rp2 = shape.rp * shape.rp;
  return { x: rp2 * n.x + k * shape.axis.x, y: rp2 * n.y + k * shape.axis.y, z: rp2 * n.z + k * shape.axis.z };
}

// v^T S^2 w for the semi-axis matrix S of the shape (spheroid: S^2 = rp^2 I + (ra^2 - rp^2) a a^T).
export function shapeForm(shape, v, w) {
  if (shape.Q) return vecDot(v, mat3Mul(shape.Q, w));
  return shape.rp * shape.rp * vecDot(v, w) + (shape.ra * shape.ra - shape.rp * shape.rp) * vecDot(shape.axis, v) * vecDot(shape.axis, w);
}

// Support function of a node: the largest n . x over the body, for a unit n.
export function supportH(node, n) {
  return vecDot(node.center, n) + Math.sqrt(shapeForm(node.shape, n, n));
}

// The body's surface point with outward unit normal n: c + S^2 n / |S n|.
export function supportPoint(node, n) {
  const { shape } = node, q = shapeMul(shape, n), l = Math.sqrt(vecDot(n, q));
  return { x: node.center.x + q.x / l, y: node.center.y + q.y / l, z: node.center.z + q.z / l };
}

// The spheroid's orthographic shadow on the plane spanned by the unit vectors right and
// up: the ellipse { a, b, angle } (semi-axes, a >= b; angle of the a axis from `right`
// toward `up`), in the body's units. Its covariance is [[S2(r,r), S2(r,u)], [S2(r,u), S2(u,u)]].
export function shadowEllipse(shape, right, up) {
  const xx = shapeForm(shape, right, right), yy = shapeForm(shape, up, up), xy = shapeForm(shape, right, up);
  const mean = (xx + yy) / 2, diff = Math.hypot((xx - yy) / 2, xy);
  return { a: Math.sqrt(mean + diff), b: Math.sqrt(Math.max(mean - diff, 0)), angle: 0.5 * Math.atan2(2 * xy, xx - yy) };
}

// The shape's cut ellipse (makeShape) seen from the plane spanned by the unit vectors right
// and up: the image of the ellipse c + ra cos(t) axis + rp sin(t) cutDir. Returns
// { a, b, angle } like shadowEllipse plus its two projected diameters A (half the squash
// axis' line) and B (half the full-diameter line), as (right, up) components. b is 0 when
// the cut's plane is edge-on to the view, unlike the silhouette's.
export function cutEllipse(shape, right, up) {
  const A = { x: shape.ra * vecDot(shape.axis, right), y: shape.ra * vecDot(shape.axis, up) };
  const B = { x: shape.rp * vecDot(shape.cutDir, right), y: shape.rp * vecDot(shape.cutDir, up) };
  const xx = A.x * A.x + B.x * B.x, yy = A.y * A.y + B.y * B.y, xy = A.x * A.y + B.x * B.y;
  const mean = (xx + yy) / 2, diff = Math.hypot((xx - yy) / 2, xy);
  return { a: Math.sqrt(mean + diff), b: Math.sqrt(Math.max(mean - diff, 0)), angle: 0.5 * Math.atan2(2 * xy, xx - yy), A, B };
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
// ELLIPSES (screen shadows of squashed nodes) AND THEIR HULL
// ---------------------------------------------------------
// An ellipse is { center, a, b, angle }: semi-axes and the a axis' angle from +x (canvas
// angles, clockwise on screen). Outward normals are given by their canvas angle th.

// Support function: the largest n . x over the ellipse, n = (cos th, sin th).
export function ellipseSupport(e, th) {
  const u = th - e.angle, c = Math.cos(u), s = Math.sin(u);
  return e.center.x * Math.cos(th) + e.center.y * Math.sin(th) + Math.sqrt(e.a * e.a * c * c + e.b * e.b * s * s);
}

// The boundary point whose outward normal is at angle th.
export function ellipsePoint(e, th) {
  const u = th - e.angle, c = Math.cos(u), s = Math.sin(u), l = Math.sqrt(e.a * e.a * c * c + e.b * e.b * s * s) || 1;
  const x = e.a * e.a * c / l, y = e.b * e.b * s / l, ca = Math.cos(e.angle), sa = Math.sin(e.angle);
  return { x: e.center.x + x * ca - y * sa, y: e.center.y + x * sa + y * ca };
}

// The ellipse's own parameter (the angle ctx.ellipse takes) of the point with normal angle th.
export function ellipseParam(e, th) {
  const u = th - e.angle;
  return Math.atan2(e.b * Math.sin(u), e.a * Math.cos(u));
}

// The point of the ellipse where the ray from its center toward `p` leaves it.
export function ellipseRayPoint(e, p) {
  const ca = Math.cos(e.angle), sa = Math.sin(e.angle), dx = p.x - e.center.x, dy = p.y - e.center.y;
  const x = (dx * ca + dy * sa) / e.a, y = (-dx * sa + dy * ca) / (e.b || 1e-9), l = Math.hypot(x, y);
  if (l < 1e-12) return { x: e.center.x + e.a * ca, y: e.center.y + e.a * sa };
  return { x: e.center.x + (e.a * x * ca - e.b * y * sa) / l, y: e.center.y + (e.a * x * sa + e.b * y * ca) / l };
}

// The boundary of the hull of two ellipses as arcs. Each is { k, from, to }: ellipse k
// (0 or 1) is on the boundary for normal angles from `from` down to `to` (canvas angles,
// decreasing = anticlockwise on screen). Consecutive arcs are joined by the common tangent
// segment at the normal angle where they meet. `whole`: one ellipse contains the other
// (arcs is then [{ k, from: 0, to: -2 PI }], k the one that contains).
export function ellipseHullArcs(e1, e2) {
  const g = (th) => ellipseSupport(e2, th) - ellipseSupport(e1, th);
  const roots = ellipseTangentAngles(e1, e2);
  if (roots.length < 2 || roots.length % 2) return { whole: true, arcs: [{ k: g(0) > 0 ? 1 : 0, from: 0, to: -Math.PI * 2 }] };
  // Walk the roots downward around the circle; the dominant ellipse of each gap is
  // read at its midpoint.
  const down = roots.slice().sort((a, b) => b - a);
  const arcs = down.map((from, i) => {
    const to = i + 1 < down.length ? down[i + 1] : down[0] - Math.PI * 2;
    return { k: g((from + to) / 2) > 0 ? 1 : 0, from, to };
  });
  return { whole: false, arcs };
}

// ---- exact tangents ----

const TWO_PI = Math.PI * 2;
const normAng = (a) => ((a % TWO_PI) + TWO_PI) % TWO_PI;

// Real roots of a x^3 + b x^2 + c x + d (trigonometric / Cardano).
function solveCubic(a, b, c, d) {
  if (Math.abs(a) < 1e-14 * (Math.abs(b) + Math.abs(c) + Math.abs(d))) {
    if (Math.abs(b) < 1e-14 * (Math.abs(c) + Math.abs(d))) return Math.abs(c) > 1e-300 ? [-d / c] : [];
    const disc = c * c - 4 * b * d;
    if (disc < 0) return [];
    const s = Math.sqrt(disc);
    return [(-c + s) / (2 * b), (-c - s) / (2 * b)];
  }
  const B = b / a, C = c / a, D = d / a, p = C - B * B / 3, q = 2 * B * B * B / 27 - B * C / 3 + D, sh = -B / 3;
  const disc = q * q / 4 + p * p * p / 27;
  if (disc > 1e-14 * (1 + Math.abs(q * q))) {
    const s = Math.sqrt(disc), u = Math.cbrt(-q / 2 + s), v = Math.cbrt(-q / 2 - s);
    return [u + v + sh];
  }
  if (Math.abs(p) < 1e-300) return [Math.cbrt(-q) + sh];
  const r = 2 * Math.sqrt(-p / 3), arg = Math.max(-1, Math.min(1, (3 * q) / (p * r))), phi = Math.acos(arg) / 3;
  return [0, 1, 2].map(k => r * Math.cos(phi - (TWO_PI * k) / 3) + sh);
}

// Real roots of c4 t^4 + c3 t^3 + c2 t^2 + c1 t + c0 (Ferrari), each polished by Newton on the polynomial.
function solveQuartic(c4, c3, c2, c1, c0) {
  const scaleC = Math.abs(c4) + Math.abs(c3) + Math.abs(c2) + Math.abs(c1) + Math.abs(c0);
  if (!(scaleC > 0)) return [];
  if (Math.abs(c4) < 1e-13 * scaleC) return solveCubic(c3, c2, c1, c0);
  const B = c3 / c4, C = c2 / c4, D = c1 / c4, E = c0 / c4;
  const p = C - 3 * B * B / 8, q = D - B * C / 2 + B * B * B / 8, r = E - B * D / 4 + B * B * C / 16 - 3 * B * B * B * B / 256, sh = -B / 4;
  let ys = [];
  if (Math.abs(q) < 1e-12 * (1 + Math.abs(p) + Math.abs(r))) {
    const disc = p * p - 4 * r;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      [(-p + s) / 2, (-p - s) / 2].forEach(z => { if (z >= 0) { const y = Math.sqrt(z); ys.push(y, -y); } });
    }
  } else {
    const zs = solveCubic(1, p, p * p / 4 - r, -q * q / 8).filter(z => z > 1e-14).sort((x, y) => y - x);
    if (zs.length) {
      const m = zs[0], s2m = Math.sqrt(2 * m);
      [[s2m, p / 2 + m - q / (2 * s2m)], [-s2m, p / 2 + m + q / (2 * s2m)]].forEach(([bb, cc]) => {
        const disc = bb * bb - 4 * cc;
        if (disc >= 0) { const s = Math.sqrt(disc); ys.push((-bb + s) / 2, (-bb - s) / 2); }
      });
    }
  }
  const f = (t) => (((c4 * t + c3) * t + c2) * t + c1) * t + c0, df = (t) => ((4 * c4 * t + 3 * c3) * t + 2 * c2) * t + c1;
  return ys.map(y => {
    let t = y + sh;
    for (let it = 0; it < 4; it++) { const d1 = df(t); if (Math.abs(d1) < 1e-300) break; const nt = t - f(t) / d1; if (!Number.isFinite(nt)) break; t = nt; }
    return t;
  });
}

// The normal angles of the tangent lines from a point p to an ellipse (two, closed form: the point's
// polar in the ellipse frame is a quadratic in t = tan u). None when p is inside.
export function pointEllipseTangents(p, e) {
  const ca = Math.cos(e.angle), sa = Math.sin(e.angle), dx = p.x - e.center.x, dy = p.y - e.center.y;
  const wx = dx * ca + dy * sa, wy = -dx * sa + dy * ca, a2 = e.a * e.a, b2 = e.b * e.b;
  const A = wy * wy - b2, B = 2 * wx * wy, C = wx * wx - a2, scaleC = Math.abs(A) + Math.abs(B) + Math.abs(C);
  const out = [], tol = 1e-9 * (1 + Math.abs(wx) + Math.abs(wy));
  const push = (u) => { [u, u + Math.PI].forEach(uu => { if (wx * Math.cos(uu) + wy * Math.sin(uu) >= -tol) out.push(normAng(uu + e.angle)); }); };
  if (Math.abs(A) < 1e-12 * scaleC) {
    push(Math.PI / 2);
    if (Math.abs(B) > 1e-12 * scaleC) push(Math.atan(-C / B));
  } else {
    const disc = B * B - 4 * A * C;
    if (disc >= 0) { const s = Math.sqrt(disc); push(Math.atan((-B + s) / (2 * A))); push(Math.atan((-B - s) / (2 * A))); }
  }
  return out;
}

// The normal angles theta where the supports of two ellipses are equal (the common tangent lines of their hull):
// h1(theta) = c1.n + s1 and h2 likewise, so s1 - s2 = (c2 - c1).n =: delta. Squaring twice (2 s1 s2 = q1 + q2 - delta^2,
// then 4 q1 q2 = R^2) leaves a quartic form in (cos, sin), a quartic in t = tan(theta), solved in closed form
// (Ferrari); the roots are checked against the original equation and polished on it. Up to 4 angles.
export function ellipseTangentAngles(e1, e2) {
  const quad = (e) => {
    const c = Math.cos(e.angle), s = Math.sin(e.angle), a2 = e.a * e.a, b2 = e.b * e.b;
    return [a2 * c * c + b2 * s * s, 2 * (a2 - b2) * c * s, a2 * s * s + b2 * c * c];   // coefficients of cos^2, cos sin, sin^2
  };
  const q1 = quad(e1), q2 = quad(e2), dx = e2.center.x - e1.center.x, dy = e2.center.y - e1.center.y;
  const R = [q1[0] + q2[0] - dx * dx, q1[1] + q2[1] - 2 * dx * dy, q1[2] + q2[2] - dy * dy];
  // product of two forms (a, b, c) in t = sin / cos: coefficients of t^0 .. t^4
  const mul = (u, v) => [u[0] * v[0], u[0] * v[1] + u[1] * v[0], u[0] * v[2] + u[1] * v[1] + u[2] * v[0], u[1] * v[2] + u[2] * v[1], u[2] * v[2]];
  const P = mul(q1, q2), RR = mul(R, R), F = P.map((x, i) => 4 * x - RR[i]);
  const g = (th) => ellipseSupport(e2, th) - ellipseSupport(e1, th);
  const scaleG = Math.abs(dx) + Math.abs(dy) + e1.a + e2.a + 1e-12;
  const cand = [];
  solveQuartic(F[4], F[3], F[2], F[1], F[0]).forEach(t => { const th = Math.atan(t); cand.push(th, th + Math.PI); });
  cand.push(Math.PI / 2, -Math.PI / 2);          // t = infinity: the quartic's degree drops there
  // polish on g (secant on a tiny bracket) and keep the true roots
  const roots = [];
  cand.forEach(th0 => {
    let th = th0;
    for (let it = 0; it < 6; it++) {
      const h = 1e-6, g0 = g(th), g1 = (g(th + h) - g(th - h)) / (2 * h);
      if (Math.abs(g1) < 1e-14) break;
      const nt = th - g0 / g1;
      if (!Number.isFinite(nt) || Math.abs(nt - th) > 0.05) break;
      th = nt;
    }
    if (Math.abs(g(th)) < 1e-9 * scaleG) {
      const a = normAng(th);
      if (!roots.some(r => Math.abs(normAng(r - a + Math.PI) - Math.PI) < 1e-7)) roots.push(a);
    }
  });
  // The quartic is ill-conditioned for some pairs (two far-apart, nearly parallel ellipses lose their roots), so what it
  // found is checked against a 96-angle sign scan: the number of crossings must match (the scan can only under-count by
  // missing two crossings within a 1/96 turn, where the quartic then has to agree), else the bisected scan is the answer.
  const sign = (th) => g(th) < 0;
  let scanned = 0, prevSign = sign(0);
  for (let i = 1; i <= 96; i++) { const cur = sign((i / 96) * TWO_PI); if (cur !== prevSign) scanned++; prevSign = cur; }
  const srt = roots.slice().sort((a, b) => a - b);
  let changes = 0;
  srt.forEach(r => { if (sign(r + 1e-5) !== sign(r - 1e-5)) changes++; });
  if (srt.length % 2 === 0 && changes === srt.length && srt.length >= scanned) return srt;
  return sampledTangentAngles(g);
}

// The fallback: sign changes of g over 96 angles, bisected.
function sampledTangentAngles(g) {
  const samples = 96, roots = [];
  let prev = g(0);
  for (let i = 1; i <= samples; i++) {
    const th = (i / samples) * TWO_PI, cur = g(th);
    if ((prev < 0) !== (cur < 0)) {
      let lo = ((i - 1) / samples) * TWO_PI, hi = th, flo = prev;
      for (let it = 0; it < 44; it++) { const mid = (lo + hi) / 2, fm = g(mid); if ((fm < 0) === (flo < 0)) { lo = mid; flo = fm; } else hi = mid; }
      roots.push(normAng((lo + hi) / 2));
    }
    prev = cur;
  }
  return roots;
}

// ---- hulls of ellipses, arcs and polygons, as exact outlines ----

// The boundary of the convex hull of some convex shapes: `items` are { pts } (points: their hull),
// { e } (a whole ellipse) or { e, th0, th1 } (the arc of e whose outward normals run from th0 to th1, increasing; it
// also contributes its two end points); an item may carry `skip` (its arcs are cut by a chord). The hull's support
// is the largest of the shapes' supports, so the boundary follows one shape between the normal angles where two
// supports are equal, and those are all closed form: edge normals of the point hull, the two tangents from a point
// to an ellipse, the common tangents of two ellipses (ellipseTangentAngles), the ends of an arc's range.
// Returns the loop in decreasing normal angle (anticlockwise on screen) as ops: { k: 'p', p } (a corner) and
// { k: 'e', e, from, to, skip } (the arc of e for the normal angles from `from` down to `to`); consecutive ops are
// joined by the straight common tangents. See shapes.js traceOutline.
export function hullOutline(items) {
  const verts = [], ells = [];
  items.forEach(it => {
    if (it.pts) { it.pts.forEach(p => verts.push(p)); return; }
    const e = { center: it.e.center, a: it.e.a, b: Math.max(it.e.b, 1e-9), angle: it.e.angle };
    if (it.th0 === undefined) ells.push({ e, full: true, skip: !!it.skip });
    else {
      const span = normAng(it.th1 - it.th0) || TWO_PI;
      ells.push({ e, full: false, th0: normAng(it.th0), span, skip: !!it.skip });
      verts.push(ellipsePoint(e, it.th0), ellipsePoint(e, it.th1));
    }
  });
  const hv = verts.length ? convexHull(verts) : [];
  const inRange = (E, th) => E.full || normAng(th - E.th0) <= E.span + 1e-12;
  const crit = [0];
  for (let i = 0; i < hv.length; i++) {
    const a = hv[i], b = hv[(i + 1) % hv.length];
    if (a === b) continue;
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    crit.push(normAng(ang + Math.PI / 2), normAng(ang - Math.PI / 2));
  }
  ells.forEach((E, i) => {
    hv.forEach(v => pointEllipseTangents(v, E.e).forEach(a => crit.push(a)));
    for (let j = i + 1; j < ells.length; j++) ellipseTangentAngles(E.e, ells[j].e).forEach(a => crit.push(a));
    if (!E.full) crit.push(E.th0, normAng(E.th0 + E.span));
  });
  const angles = crit.sort((x, y) => x - y).filter((a, i, arr) => i === 0 || a - arr[i - 1] > 1e-12);
  // the dominant component in each gap between critical angles: a hull vertex (index) or an ellipse (id n + index)
  const nv = hv.length, runs = [];
  for (let i = 0; i < angles.length; i++) {
    const a = angles[i], b = i + 1 < angles.length ? angles[i + 1] : angles[0] + TWO_PI, m = (a + b) / 2, nx = Math.cos(m), ny = Math.sin(m);
    let best = -Infinity, id = -1;
    for (let k = 0; k < nv; k++) { const s = hv[k].x * nx + hv[k].y * ny; if (s > best + 1e-12) { best = s; id = k; } }
    ells.forEach((E, k) => { if (inRange(E, m)) { const s = ellipseSupport(E.e, m); if (s > best + 1e-9) { best = s; id = nv + k; } } });
    if (id < 0) continue;
    if (runs.length && runs[runs.length - 1].id === id) runs[runs.length - 1].b = b; else runs.push({ id, a, b });
  }
  if (runs.length > 1 && runs[0].id === runs[runs.length - 1].id) { const last = runs.pop(); runs[0].a = last.a - TWO_PI; }
  const ops = [];
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i];
    if (r.id < nv) ops.push({ k: 'p', p: hv[r.id] });
    else { const E = ells[r.id - nv]; ops.push({ k: 'e', e: E.e, from: r.b, to: r.a, skip: E.skip }); }
  }
  return ops;
}

// The outline's boundary as a polygon with chords within `tol` of the arcs (for the boolean operations, which work
// on polygons): corners as they are, an arc cut at normal-angle steps sqrt(8 tol / rho), rho = a^2 b^2 / h^3 the
// radius of curvature (h the support in that direction), so the sagitta is the same everywhere.
export function outlinePolygon(ops, tol) {
  const out = [];
  ops.forEach(op => {
    if (op.k === 'p') { out.push(op.p); return; }
    if (op.skip) { out.push(ellipsePoint(op.e, op.from), ellipsePoint(op.e, op.to)); return; }
    const e = op.e, a2b2 = e.a * e.a * e.b * e.b;
    let th = op.from, guard = 0;
    while (th > op.to && guard++ < 4000) {
      out.push(ellipsePoint(e, th));
      const u = th - e.angle, h2 = e.a * e.a * Math.cos(u) ** 2 + e.b * e.b * Math.sin(u) ** 2, rho = a2b2 / (h2 * Math.sqrt(h2));
      th -= Math.max(1e-3, Math.min(0.6, Math.sqrt((8 * tol) / Math.max(rho, 1e-9))));
    }
    out.push(ellipsePoint(e, op.to));
  });
  return out;
}

// A whole ellipse as a polygon with chords within tol.
export function ellipsePolygon(e, tol) {
  return outlinePolygon([{ k: 'e', e: { center: e.center, a: e.a, b: Math.max(e.b, 1e-9), angle: e.angle }, from: TWO_PI, to: 0 }], tol).slice(0, -1);
}

// The perspective image of a 3D circle (center, radius, in the plane of the unit vectors frame.u / frame.v) is an
// ellipse: a conic through the images of any five of its points, so the five exact projections give it in closed
// form (a 5 x 5 solve, then center, axes and angle of the conic). An edge-on or degenerate circle falls back to the
// ellipse with the projected conjugate diameters. projectPoint: world -> { x, y }.
export function projectedCircleEllipse(center, radius, frame, projectPoint) {
  const P = (th) => {
    const c = Math.cos(th) * radius, s = Math.sin(th) * radius;
    return projectPoint({ x: center.x + frame.u.x * c + frame.v.x * s, y: center.y + frame.u.y * c + frame.v.y * s, z: center.z + frame.u.z * c + frame.v.z * s });
  };
  const fromDiameters = () => {
    const p0 = P(0), p1 = P(Math.PI / 2), p2 = P(Math.PI), p3 = P(1.5 * Math.PI);
    const cx = (p0.x + p1.x + p2.x + p3.x) / 4, cy = (p0.y + p1.y + p2.y + p3.y) / 4;
    const ux = (p0.x - p2.x) / 2, uy = (p0.y - p2.y) / 2, vx = (p1.x - p3.x) / 2, vy = (p1.y - p3.y) / 2;
    const xx = ux * ux + vx * vx, yy = uy * uy + vy * vy, xy = ux * uy + vx * vy, mean = (xx + yy) / 2, diff = Math.hypot((xx - yy) / 2, xy);
    return { center: { x: cx, y: cy }, a: Math.sqrt(mean + diff), b: Math.sqrt(Math.max(mean - diff, 0)), angle: 0.5 * Math.atan2(2 * xy, xx - yy) };
  };
  const pts = [0, 1, 2, 3, 4].map(k => P((k * TWO_PI) / 5 + 0.3));
  const mx = pts.reduce((s, p) => s + p.x, 0) / 5, my = pts.reduce((s, p) => s + p.y, 0) / 5;
  const sc = Math.max(...pts.map(p => Math.hypot(p.x - mx, p.y - my))) || 1;
  // A x^2 + B x y + C y^2 + D x + E y = 1 in the centered, scaled coordinates
  const M = pts.map(p => { const x = (p.x - mx) / sc, y = (p.y - my) / sc; return [x * x, x * y, y * y, x, y, 1]; });
  for (let c = 0; c < 5; c++) {
    let piv = c;
    for (let r = c + 1; r < 5; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-10) return fromDiameters();
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < 5; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k < 6; k++) M[r][k] -= f * M[c][k];
    }
  }
  const [A, B, C, D, E] = M.map((row, i) => row[5] / row[i]);
  const det = 4 * A * C - B * B;
  if (!(det > 1e-12)) return fromDiameters();
  const cx = (B * E - 2 * C * D) / det, cy = (B * D - 2 * A * E) / det, k = 1 - (D * cx + E * cy) / 2;
  const mean = (A + C) / 2, diff = Math.hypot((A - C) / 2, B / 2), l1 = (mean + diff) / k, l2 = (mean - diff) / k;
  if (!(k > 0 && l2 > 0)) return fromDiameters();
  // the major axis is along the eigenvector of the smaller eigenvalue
  return { center: { x: mx + cx * sc, y: my + cy * sc }, a: sc / Math.sqrt(l2), b: sc / Math.sqrt(l1), angle: 0.5 * Math.atan2(B, A - C) + Math.PI / 2 };
}

// The capsule of two ellipses (their hull) as a polygon of boundary points (chords within tol of the arcs), plus the
// two common tangent segments (the straight edges between the arcs) as [from, to] pairs; none when one ellipse
// contains the other.
export function ellipseCapsule(e1, e2, tol = 0.05) {
  const { whole, arcs } = ellipseHullArcs(e1, e2), es = [e1, e2];
  if (whole) return { poly: ellipsePolygon(es[arcs[0].k], tol), lines: [] };
  const lines = [];
  const ops = arcs.map((arc, i) => {
    const next = arcs[(i + 1) % arcs.length];
    lines.push([ellipsePoint(es[arc.k], arc.to), ellipsePoint(es[next.k], next.from)]);
    return { k: 'e', e: es[arc.k], from: arc.from, to: arc.to };
  });
  return { poly: outlinePolygon(ops, tol), lines };
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

// A polygon's edges with their bounding boxes, for quick rejection in the crossing tests.
function edgeIndex(poly) {
  const n = poly.length, box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }, e = new Float64Array(n * 4);
  for (let k = 0; k < n; k++) {
    const c = poly[k], d = poly[(k + 1) % n];
    e[4 * k] = Math.min(c.x, d.x); e[4 * k + 1] = Math.max(c.x, d.x); e[4 * k + 2] = Math.min(c.y, d.y); e[4 * k + 3] = Math.max(c.y, d.y);
    box.minX = Math.min(box.minX, e[4 * k]); box.maxX = Math.max(box.maxX, e[4 * k + 1]);
    box.minY = Math.min(box.minY, e[4 * k + 2]); box.maxY = Math.max(box.maxY, e[4 * k + 3]);
  }
  return { poly, e, box };
}

// The parameters t in (0, 1), ascending, where the segment a -> b crosses the boundary
// of the indexed polygon `cut` (edgeIndex).
function segmentPolygonCrossings(a, b, cut) {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y), bx = cut.box;
  if (x1 < bx.minX || x0 > bx.maxX || y1 < bx.minY || y0 > bx.maxY) return [];
  const pts = cut.poly, e = cut.e, rx = b.x - a.x, ry = b.y - a.y, ts = [];
  for (let k = 0; k < pts.length; k++) {
    if (x1 < e[4 * k] || x0 > e[4 * k + 1] || y1 < e[4 * k + 2] || y0 > e[4 * k + 3]) continue;
    const c = pts[k], d = pts[(k + 1) % pts.length], sx = d.x - c.x, sy = d.y - c.y, den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-18) continue;
    const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den, u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
  }
  return ts.sort((p, q) => p - q);
}

// The parameters t in (0, 1), ascending, where the segment a -> b crosses a circle.
function segmentCircleCrossings(a, b, center, radius) {
  const dx = b.x - a.x, dy = b.y - a.y, fx = a.x - center.x, fy = a.y - center.y;
  const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - radius * radius;
  const disc = B * B - 4 * A * C;
  if (disc <= 0 || A <= 1e-12) return [];
  const q = Math.sqrt(disc);
  return [(-B - q) / (2 * A), (-B + q) / (2 * A)].filter(t => t > 0 && t < 1);
}

// The polygon `poly` with the polygon `cut` cut out of it, as a list of polygons
// (the cut can split it). Same idea as subtractDisc: the boundary of `poly`
// outside `cut`, and wherever it enters `cut` the boundary of `cut` itself (against
// poly's turning direction) up to the next point where poly's boundary leaves.
// `cut` may be any simple polygon.
export function subtractPolygon(poly, cut) {
  const dedupe = (pts) => pts.filter((p, i) => { const q = pts[(i + 1) % pts.length]; return Math.hypot(p.x - q.x, p.y - q.y) > 1e-9; });
  poly = dedupe(poly); cut = dedupe(cut);
  const n = poly.length, qn = cut.length;
  if (n < 3 || qn < 3) return [poly];
  // The walk is poly's vertices plus, on an edge that crosses the cut's boundary,
  // a point between each two consecutive crossings (exact crossings, no resampling),
  // so consecutive walk points are separated by at most one crossing.
  const index = edgeIndex(cut), box = index.box;
  const walk = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n], ts = segmentPolygonCrossings(a, b, index);
    walk.push(a);
    for (let j = 0; j + 1 < ts.length; j++) {
      const t = (ts[j] + ts[j + 1]) / 2;
      walk.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  const m = walk.length, flags = walk.map(p => p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY && pointInPolygon(p, cut));
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
// A polygon with no part in the disc is returned as is.
// Where the boundary enters the disc it follows the circle (against the polygon's
// own turning direction) to the next point where the boundary leaves it.
export function subtractDisc(poly, center, radius) {
  const n = poly.length;
  if (n < 3) return [poly];
  const inDisc = (p) => Math.hypot(p.x - center.x, p.y - center.y) < radius;
  // The walk is the vertices plus, on an edge that crosses the circle, the point
  // between its two crossings (exact crossings, no resampling).
  const walk = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n], ts = segmentCircleCrossings(a, b, center, radius);
    walk.push(a);
    if (ts.length === 2) {
      const t = (ts[0] + ts[1]) / 2;
      walk.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
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
