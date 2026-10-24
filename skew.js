// Skewed meshes: a 2-node mesh bent through a third "skew" node (CLAUDE.md "Skewed meshes"). Pure math.

const smooth = (x) => x * x * (3 - 2 * x);

// The arch from node A to node B through the point S (the skew node's center; only its position counts): the ellipse with
// conjugate semi-diameters (B - A) / 2 and S - M (M the midpoint), so it passes through A, S (at t = 0.5) and B exactly, in
// the plane of the three, even when S is not above M. Returns at(t), t in [0, 1] from A to B:
// { center: {x, y, z}, radius } with the radius a smoothstep mix of A and B.
export function archAt(A, B, S) {
  const M = { x: (A.center.x + B.center.x) / 2, y: (A.center.y + B.center.y) / 2, z: (A.center.z + B.center.z) / 2 };
  const h = { x: (B.center.x - A.center.x) / 2, y: (B.center.y - A.center.y) / 2, z: (B.center.z - A.center.z) / 2 };
  const s = { x: S.center.x - M.x, y: S.center.y - M.y, z: S.center.z - M.z };
  return (t) => {
    const th = Math.PI * (1 - t), c = Math.cos(th), n = Math.sin(th);
    return {
      center: { x: M.x + c * h.x + n * s.x, y: M.y + c * h.y + n * s.y, z: M.z + c * h.z + n * s.z },
      radius: A.radius + (B.radius - A.radius) * smooth(t),
    };
  };
}

// The body's quadratic form Q(t) (row-major 3x3, a spheroid's `shape.Q`) along the arch, from the two end nodes only. Each
// end's form is written in the arch's moving frame F(t) (columns: tangent T, in-plane normal N, plane normal Bn) at its own
// end, L = F^T Q F, and the two are mixed with one smoothstep; Q(t) = F(t) L(t) F(t)^T. The frame turns with the arch, so a
// thickness along N (or a width along Bn) is the same matrix entry all along and stays what the ends have, instead of
// swelling where differently oriented shapes are mixed in world coordinates. Equal ends give a constant section; the ends hold
// exactly. A straight arch (S on the line AB) has no plane normal: the world-frame mix is used.
export function shapeAt(A, B, S) {
  const mix = (P, R, u) => P.map((v, i) => v + (R[i] - v) * u);
  const frame = archFrame(A, B, S);
  if (!frame) return (t) => mix(A.shape.Q, B.shape.Q, smooth(t));
  const F0 = frame(0), F1 = frame(1);
  const LA = mul(tr(F0), mul(A.shape.Q, F0)), LB = mul(tr(F1), mul(B.shape.Q, F1));
  return (t) => { const F = frame(t); return mul(F, mul(mix(LA, LB, smooth(t)), tr(F))); };
}

// Row-major 3x3 helpers.
function mul(P, R) { const o = new Array(9); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[3 * i + j] = P[3 * i] * R[j] + P[3 * i + 1] * R[3 + j] + P[3 * i + 2] * R[6 + j]; return o; }
function tr(P) { return [P[0], P[3], P[6], P[1], P[4], P[7], P[2], P[5], P[8]]; }
export function inverse(P) {
  const [a, b, c, d, e, f, g, h, i] = P, A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, det = a * A + b * B + c * C;
  return [A, c * h - b * i, b * f - c * e, B, a * i - c * g, c * d - a * f, C, b * g - a * h, a * e - b * d].map(v => v / det);
}

// The arch's moving frame: frame(t) is the row-major matrix with columns tangent T, in-plane normal N, plane normal Bn.
// null for a straight arch (S on the line AB: no plane).
export function archFrame(A, B, S) {
  const hx = (B.center.x - A.center.x) / 2, hy = (B.center.y - A.center.y) / 2, hz = (B.center.z - A.center.z) / 2;
  const sx = S.center.x - (A.center.x + B.center.x) / 2, sy = S.center.y - (A.center.y + B.center.y) / 2, sz = S.center.z - (A.center.z + B.center.z) / 2;
  let bx = hy * sz - hz * sy, by = hz * sx - hx * sz, bz = hx * sy - hy * sx;
  const bl = Math.hypot(bx, by, bz);
  if (!(bl > 1e-9 * Math.hypot(hx, hy, hz) * Math.hypot(sx, sy, sz))) return null;
  bx /= bl; by /= bl; bz /= bl;
  return (t) => {
    const th = Math.PI * (1 - t);
    let tx = -Math.sin(th) * hx + Math.cos(th) * sx, ty = -Math.sin(th) * hy + Math.cos(th) * sy, tz = -Math.sin(th) * hz + Math.cos(th) * sz;
    const tl = Math.hypot(tx, ty, tz); tx /= tl; ty /= tl; tz /= tl;
    const nx = by * tz - bz * ty, ny = bz * tx - bx * tz, nz = bx * ty - by * tx;
    return [tx, nx, bx, ty, ny, by, tz, nz, bz];
  };
}

// The body's cross-section at t (debug view): the cut of the ellipsoid Q(t) by the plane through the arch's point
// perpendicular to the tangent, as n closed 3D points. With y = (a, b) in the basis (N, Bn) the section is y^T M y = 1,
// M = P^T Q^-1 P (P = [N Bn]), an ellipse found from M's eigen-decomposition. null for a straight arch.
export function sectionAt(A, B, S, t, n = 64) {
  const frame = archFrame(A, B, S);
  if (!frame) return null;
  const F = frame(t), Q = shapeAt(A, B, S)(t), Qi = inverse(Q), c = archAt(A, B, S)(t).center;
  const N = [F[1], F[4], F[7]], Bn = [F[2], F[5], F[8]];
  const apply = (v) => [0, 1, 2].map(i => Qi[3 * i] * v[0] + Qi[3 * i + 1] * v[1] + Qi[3 * i + 2] * v[2]);
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const m00 = dot(N, apply(N)), m01 = dot(N, apply(Bn)), m11 = dot(Bn, apply(Bn));
  const mean = (m00 + m11) / 2, diff = Math.hypot((m00 - m11) / 2, m01), th = 0.5 * Math.atan2(2 * m01, m00 - m11);
  const r1 = 1 / Math.sqrt(Math.max(mean + diff, 1e-30)), r2 = 1 / Math.sqrt(Math.max(mean - diff, 1e-30));
  const e1 = [0, 1, 2].map(i => Math.cos(th) * N[i] + Math.sin(th) * Bn[i]), e2 = [0, 1, 2].map(i => -Math.sin(th) * N[i] + Math.cos(th) * Bn[i]);
  return Array.from({ length: n }, (_, k) => {
    const phi = 2 * Math.PI * k / n, u = r1 * Math.cos(phi), v = r2 * Math.sin(phi);
    return { x: c.x + u * e1[0] + v * e2[0], y: c.y + u * e1[1] + v * e2[1], z: c.z + u * e1[2] + v * e2[2] };
  });
}

// Parameters t in [0, 1] (A to B, both included) where the swept body is drawn as a chain of capsules between the
// projected circles, refined until each in-between circle lies inside the capsule of its neighbors within `tol`.
// project(t) -> { x, y, r } is the screen circle at t.
export function archSamples(project, tol, minSegments = 8, maxDepth = 10) {
  const ts = [];
  const refine = (t0, c0, t1, c1, depth) => {
    const tm = (t0 + t1) / 2, cm = project(tm);
    const dx = c1.x - c0.x, dy = c1.y - c0.y, l2 = dx * dx + dy * dy;
    const u = l2 > 0 ? Math.max(0, Math.min(1, ((cm.x - c0.x) * dx + (cm.y - c0.y) * dy) / l2)) : 0;
    const off = Math.hypot(cm.x - (c0.x + u * dx), cm.y - (c0.y + u * dy));
    const reach = off + cm.r - (c0.r + u * (c1.r - c0.r));
    if (depth < maxDepth && reach > tol) {
      refine(t0, c0, tm, cm, depth + 1);
      ts.push(tm);
      refine(tm, cm, t1, c1, depth + 1);
    } else ts.push(tm);
  };
  const out = [];
  let prev = { t: 0, c: project(0) };
  out.push(prev);
  for (let i = 1; i <= minSegments; i++) {
    const t = i / minSegments, c = project(t);
    ts.length = 0;
    refine(prev.t, prev.c, t, c, 0);
    // refine() lists the midpoints inside (prev.t, t) in order, and always the midpoint itself
    ts.sort((p, q) => p - q).forEach(tm => out.push({ t: tm, c: project(tm) }));
    prev = { t, c };
    out.push(prev);
  }
  return out;
}
