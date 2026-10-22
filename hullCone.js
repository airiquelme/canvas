// The cone between two nodes as the boundary of the convex hull of their bodies, for any
// spheroids (CLAUDE.md "Squashed nodes") or the flat solid's general ellipsoids (ellipsoidShape,
// geometry.js). Pure 3D, no canvas.
//
// A node's body has a support function h(n) = c.n + |S n| (geometry.js supportH). The hull's
// support function is H = max(hA, hB): the normals n with hA > hB belong to A's surface, hA < hB
// to B's, and the ruled part of the hull (the cone proper) has the normals on the closed curve
// hA(n) = hB(n). Each of them gives one generatrix, the segment from A's support point to B's
// (it is perpendicular to n, because n.pA = hA = hB = n.pB). For two spheres the curve is the
// circle n.axis = sinT of tangentCone (splitRing.js) and the generatrices are its generatrices.
// With squashed nodes the generatrices are skew and the "circle" at an axial distance is an
// arbitrary closed convex curve.
//
// The inner loops work on scalars (a node's `shape.Q` is its S^2 as 9 numbers, `ex` / `ux` its
// principal semi-axes and axes), not on {x, y, z} objects, and every normal is solved to rounding
// error: Newton on g(phi) from the neighbor generatrix' phi (interpolated between the stored ones
// for an arbitrary azimuth), never an interpolation used as the answer.
import { supportPoint } from './geometry.js';
import { coneFrame } from './shapes.js';

const TWO_PI = Math.PI * 2;
const mod2pi = (a) => ((a % TWO_PI) + TWO_PI) % TWO_PI;

// Scratch for gEval: [g, g', nx, ny, nz].
const SC = new Float64Array(5);
// Scratch for the body normals: [nx, ny, nz].
const BN = new Float64Array(3);

// The support function of a node's body for the (unit) direction (nx, ny, nz).
function supH(node, nx, ny, nz) {
  const q = node.shape.Q, c = node.center;
  const qx = q[0] * nx + q[1] * ny + q[2] * nz, qy = q[3] * nx + q[4] * ny + q[5] * nz, qz = q[6] * nx + q[7] * ny + q[8] * nz;
  return c.x * nx + c.y * ny + c.z * nz + Math.sqrt(nx * qx + ny * qy + nz * qz);
}

// g(phi) = (hB - hA)(n) = len cos(phi) + |S_B n| - |S_A n| and its slope for n = cos(phi) dir + sin(phi) r
// (d |S n| / d phi = (S^2 n . n') / |S n|, n' = -sin dir + cos r), and n, into SC.
function gEval(QA, QB, len, dx, dy, dz, rx, ry, rz, phi) {
  const c = Math.cos(phi), s = Math.sin(phi);
  const nx = dx * c + rx * s, ny = dy * c + ry * s, nz = dz * c + rz * s;
  const ax = QA[0] * nx + QA[1] * ny + QA[2] * nz, ay = QA[3] * nx + QA[4] * ny + QA[5] * nz, az = QA[6] * nx + QA[7] * ny + QA[8] * nz;
  const bx = QB[0] * nx + QB[1] * ny + QB[2] * nz, by = QB[3] * nx + QB[4] * ny + QB[5] * nz, bz = QB[6] * nx + QB[7] * ny + QB[8] * nz;
  const ra = Math.sqrt(nx * ax + ny * ay + nz * az), rb = Math.sqrt(nx * bx + ny * by + nz * bz);
  const mx = -dx * s + rx * c, my = -dy * s + ry * c, mz = -dz * s + rz * c;
  SC[0] = len * c + rb - ra;
  SC[1] = -len * s + (bx * mx + by * my + bz * mz) / rb - (ax * mx + ay * my + az * mz) / ra;
  SC[2] = nx; SC[3] = ny; SC[4] = nz;
}

// The cone of the hull of nodes A and B, as `count` generatrices evenly spaced in the azimuth
// psi of their normal around the axis A -> B (psi as in coneFrame(A, B).radial). Returns
// { A, B, frame, gens, sRuledMin, sRuledMax, degenerate, phi } where
//  - gens[i] = { psi, phi, n, pA, pB, sA, sB }: the normal (n = cos(phi) dir + sin(phi) radial(psi)), A's and B's support points, and their
//    axial distances from A's center along frame.dir;
//  - phi = the same phis as a Float64Array (the inner loops' lookup);
//  - [sRuledMin, sRuledMax] = [max sA, min sB], the axial range where every generatrix exists
//    (crossSection is complete there);
//  - degenerate = 'A' or 'B' when one body contains the other's reach (no ruled part; the hull
//    is that body), else null.
export function buildHullCone(A, B, count = 128) {
  const frame = coneFrame(A, B), { dir } = frame;
  const gens = [], phis = new Float64Array(count);
  let prevPhi;
  for (let i = 0; i < count; i++) {
    const psi = (i / count) * TWO_PI;
    const g = hullNormal(A, B, frame, psi, prevPhi);
    if (g.none) return { A, B, frame, gens: [], phi: phis, sRuledMin: NaN, sRuledMax: NaN, degenerate: g.none };
    prevPhi = g.phi;
    phis[i] = g.phi;
    const pA = supportPoint(A, g.n), pB = supportPoint(B, g.n);
    gens.push({
      psi, phi: g.phi, n: g.n, pA, pB,
      sA: (pA.x - A.center.x) * dir.x + (pA.y - A.center.y) * dir.y + (pA.z - A.center.z) * dir.z,
      sB: (pB.x - A.center.x) * dir.x + (pB.y - A.center.y) * dir.y + (pB.z - A.center.z) * dir.z,
    });
  }
  let sMin = -Infinity, sMax = Infinity;
  for (const g of gens) { if (g.sA > sMin) sMin = g.sA; if (g.sB < sMax) sMax = g.sB; }
  return { A, B, frame, gens, phi: phis, degenerate: null, sRuledMin: sMin, sRuledMax: sMax };
}

// The ruled-part normal at azimuth psi: n = cos(phi) dir + sin(phi) radial(psi), with phi in
// (0, PI) the root of g(phi) (above), which falls from g(0) > 0 (B reaches farther along +dir) to
// g(PI) < 0. `guess` (the neighbor's phi) starts a plain Newton; without one, or when it does not
// land on a root in (0, PI), a bracket is found and Newton is kept inside it (bisection when a step
// leaves it). { none: 'A' | 'B' } when there is no root: g(0) <= 0 means A's reach covers B's end
// (the hull is A there), g(PI) >= 0 the reverse.
export function hullNormal(A, B, frame, psi, guess) {
  const { dir, len, u, v } = frame, cp = Math.cos(psi), sp = Math.sin(psi);
  const rx = u.x * cp + v.x * sp, ry = u.y * cp + v.y * sp, rz = u.z * cp + v.z * sp;
  const QA = A.shape.Q, QB = B.shape.Q, dx = dir.x, dy = dir.y, dz = dir.z;
  if (guess !== undefined) {
    let phi = guess;
    for (let it = 0; it < 8; it++) {
      gEval(QA, QB, len, dx, dy, dz, rx, ry, rz, phi);
      const next = phi - SC[0] / SC[1];
      if (!(next > 1e-9 && next < Math.PI - 1e-9)) break;
      if (Math.abs(next - phi) < 1e-12) return { phi: next, n: { x: SC[2], y: SC[3], z: SC[4] } };
      phi = next;
    }
  }
  let lo = 0, hi = Math.PI;
  if (guess !== undefined) {
    const a = Math.max(0, guess - 0.25), b = Math.min(Math.PI, guess + 0.25);
    gEval(QA, QB, len, dx, dy, dz, rx, ry, rz, a);
    const ga = SC[0];
    gEval(QA, QB, len, dx, dy, dz, rx, ry, rz, b);
    if (ga > 0 && SC[0] <= 0) { lo = a; hi = b; }
  }
  if (lo === 0 && hi === Math.PI) {
    gEval(QA, QB, len, dx, dy, dz, rx, ry, rz, 0);
    if (SC[0] <= 0) return { none: 'A' };
    gEval(QA, QB, len, dx, dy, dz, rx, ry, rz, Math.PI);
    if (SC[0] >= 0) return { none: 'B' };
    const K = 16;
    for (let i = 1; i <= K; i++) {
      const phi = (i / K) * Math.PI;
      gEval(QA, QB, len, dx, dy, dz, rx, ry, rz, phi);
      if (SC[0] <= 0) { lo = ((i - 1) / K) * Math.PI; hi = phi; break; }
    }
  }
  let phi = guess !== undefined && guess > lo && guess < hi ? guess : (lo + hi) / 2;
  for (let it = 0; it < 60; it++) {
    gEval(QA, QB, len, dx, dy, dz, rx, ry, rz, phi);
    if (SC[0] > 0) lo = phi; else hi = phi;
    let next = phi - SC[0] / SC[1];
    if (!(next > lo && next < hi)) next = (lo + hi) / 2;
    if (Math.abs(next - phi) < 1e-13 || hi - lo < 1e-13) { phi = next; break; }
    phi = next;
  }
  gEval(QA, QB, len, dx, dy, dz, rx, ry, rz, phi);
  return { phi, n: { x: SC[2], y: SC[3], z: SC[4] } };
}

// The ruled-part normal at an arbitrary azimuth, exact: the stored phis interpolated (cubic Hermite,
// Catmull-Rom tangents) give the starting phi of Newton on g, which converges in 2-3 steps to
// rounding error. Leaves g's n in SC[2..4] and returns phi (NaN when there is no root).
function normalNear(cone, psi) {
  const { A, B, frame } = cone, phis = cone.phi, count = phis.length, step = TWO_PI / count;
  const u = mod2pi(psi) / step, i = Math.floor(u), f = u - i;
  const at = (k) => phis[((k % count) + count) % count];
  const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2), f2 = f * f, f3 = f2 * f;
  let phi = (2 * f3 - 3 * f2 + 1) * p1 + (f3 - 2 * f2 + f) * 0.5 * (p2 - p0) + (-2 * f3 + 3 * f2) * p2 + (f3 - f2) * 0.5 * (p3 - p1);
  const { dir, len, u: fu, v: fv } = frame, cp = Math.cos(psi), sp = Math.sin(psi);
  const rx = fu.x * cp + fv.x * sp, ry = fu.y * cp + fv.y * sp, rz = fu.z * cp + fv.z * sp;
  const QA = A.shape.Q, QB = B.shape.Q;
  for (let it = 0; it < 6; it++) {
    gEval(QA, QB, len, dir.x, dir.y, dir.z, rx, ry, rz, phi);
    const next = phi - SC[0] / SC[1];
    if (!(next > 1e-9 && next < Math.PI - 1e-9)) {
      const h = hullNormal(A, B, frame, psi, phi);
      if (h.none) return NaN;
      SC[2] = h.n.x; SC[3] = h.n.y; SC[4] = h.n.z;
      return h.phi;
    }
    if (Math.abs(next - phi) < 1e-12) return next;
    phi = next;
  }
  return phi;
}

// The exact ruled-part normal at an arbitrary azimuth: { phi, n }, or null when the cone has no generatrix
// there. (Stored phis interpolate to the starting point of a Newton solve, see normalNear.)
export function coneNormal(cone, psi) {
  const phi = normalNear(cone, psi);
  return Number.isNaN(phi) ? null : { phi, n: { x: SC[2], y: SC[3], z: SC[4] } };
}

// The cone's section by the plane at axial distance s from A's center: one point per
// generatrix, pA + t (pB - pA) with (point - A.center) . dir = s. `ok` is false when s is
// outside some generatrix' range [sA, sB] (then that point is extrapolated, and the curve is
// not on the cone; use s within [sRuledMin, sRuledMax]).
export function crossSection(cone, s) {
  let ok = true;
  const points = cone.gens.map(g => {
    const t = (s - g.sA) / (g.sB - g.sA);
    if (t < 0 || t > 1) ok = false;
    return { x: g.pA.x + (g.pB.x - g.pA.x) * t, y: g.pA.y + (g.pB.y - g.pA.y) * t, z: g.pA.z + (g.pB.z - g.pA.z) * t };
  });
  return { points, ok };
}

// Distance from x to a body, as the outward unit normal of its nearest point (into BN): the nearest point
// of an ellipsoid with principal semi-axes e_i, y the point in the principal frame: p_i = e_i^2 y_i / (t +
// e_i^2), t the root of F(t) = sum (e_i y_i / (t + e_i^2))^2 - 1 (decreasing and convex for t >= 0, so
// Newton from t = 0 rises monotonically to it), the normal along y - p, i.e. y_i / (t + e_i^2). Inside
// (F(0) <= 0) the normal is the ellipsoid's at the radial projection, y_i / e_i^2 (the hull test only needs
// the sign there).
function bodyNormal(node, X, Y, Z) {
  const sh = node.shape, ex = sh.ex, ux = sh.ux, c = node.center;
  const dx = X - c.x, dy = Y - c.y, dz = Z - c.z;
  const y0 = dx * ux[0] + dy * ux[1] + dz * ux[2], y1 = dx * ux[3] + dy * ux[4] + dz * ux[5], y2 = dx * ux[6] + dy * ux[7] + dz * ux[8];
  const e0 = ex[0] * ex[0], e1 = ex[1] * ex[1], e2 = ex[2] * ex[2];
  const w0 = ex[0] * y0, w1 = ex[1] * y1, w2 = ex[2] * y2;
  let t = 0;
  for (let it = 0; it < 30; it++) {
    const d0 = t + e0, d1 = t + e1, d2 = t + e2;
    const a0 = w0 / d0, a1 = w1 / d1, a2 = w2 / d2, F = a0 * a0 + a1 * a1 + a2 * a2 - 1;
    if (it === 0 && F <= 0) {
      const g0 = y0 / e0, g1 = y1 / e1, g2 = y2 / e2, gl = Math.hypot(g0, g1, g2) || 1;
      BN[0] = (g0 * ux[0] + g1 * ux[3] + g2 * ux[6]) / gl; BN[1] = (g0 * ux[1] + g1 * ux[4] + g2 * ux[7]) / gl; BN[2] = (g0 * ux[2] + g1 * ux[5] + g2 * ux[8]) / gl;
      return;
    }
    const dF = -2 * (a0 * a0 / d0 + a1 * a1 / d1 + a2 * a2 / d2);
    const next = t - F / dF;
    if (Math.abs(next - t) < 1e-13 * (1 + t)) { t = next; break; }
    t = next;
  }
  const g0 = y0 / (t + e0), g1 = y1 / (t + e1), g2 = y2 / (t + e2), gl = Math.hypot(g0, g1, g2) || 1;
  BN[0] = (g0 * ux[0] + g1 * ux[3] + g2 * ux[6]) / gl; BN[1] = (g0 * ux[1] + g1 * ux[4] + g2 * ux[7]) / gl; BN[2] = (g0 * ux[2] + g1 * ux[5] + g2 * ux[8]) / gl;
}

// The outward unit normal of the nearest point of a body to x (its own maximizer of n.x - h(n)), as an object.
export function bodyNearestNormal(node, x) {
  bodyNormal(node, x.x, x.y, x.z);
  return { x: BN[0], y: BN[1], z: BN[2] };
}

// The signed distance from x to the hull of the cone's two bodies: the max over unit n of
// n.x - H(n), H the hull's support function (hullProbe). Exact outside the hull and on its surface;
// inside, the sign and the zero level are exact but the value is not the depth (a body's distance
// can have several local maxima there, only the global one is tried). Enough for "inside?" and for
// root finding across the surface. Its maximizer is either A's nearest-point normal (x nearest to
// A's part of the surface), B's, or lies on the ruled curve hA = hB (x nearest to the cone), so the
// answer is the best of those three candidates, each evaluated with the true hull support function
// (any n gives a lower bound, so a wrong candidate can't win).
export function hullSigned(cone, x) { return hullProbe(cone, x).value; }

// hullSigned with the maximizing unit normal: for x on or near the hull's surface, the surface
// normal there (the cone's generatrix normal on the ruled part), and the azimuth psi of that
// normal. `hintPsi` (the azimuth of a nearby earlier answer) limits the scan along the ruled
// curve to its neighborhood; the full scan is used when it fails to bracket the maximum.
// `caps` = false leaves out the two bodies' own nearest-point normals: the maximum is then over
// the ruled normals only (a fixed family, so still convex in x), exact on the cone's ruled surface.
// `rounds` = the parabola refinements of the azimuth (each gains several digits; 1 is enough while a Newton
// solve over probes is still converging, 3 for its last probe).
export function hullProbe(cone, x, hintPsi, caps = true, rounds = 2) {
  const { A, B, gens } = cone, X = x.x, Y = x.y, Z = x.z;
  let best = -Infinity, bx = 0, by = 0, bz = 0, bestPsi = null;
  const consider = (nx, ny, nz, psi) => {
    const hA = supH(A, nx, ny, nz), hB = supH(B, nx, ny, nz), v = X * nx + Y * ny + Z * nz - (hA > hB ? hA : hB);
    if (v > best) { best = v; bx = nx; by = ny; bz = nz; bestPsi = psi; }
    return v;
  };
  if (caps) {
    bodyNormal(A, X, Y, Z); consider(BN[0], BN[1], BN[2], null);
    bodyNormal(B, X, Y, Z); consider(BN[0], BN[1], BN[2], null);
  }
  if (cone.degenerate) return { value: best, n: { x: bx, y: by, z: bz }, psi: null };
  const count = gens.length, wrap = (i) => ((i % count) + count) % count;
  const score = (i) => { const n = gens[wrap(i)].n; const hA = supH(A, n.x, n.y, n.z), hB = supH(B, n.x, n.y, n.z); return X * n.x + Y * n.y + Z * n.z - (hA > hB ? hA : hB); };
  let bi = -1, bv = -Infinity;
  if (hintPsi !== undefined && hintPsi !== null) {
    const c = Math.round(hintPsi / (TWO_PI / count)), W = 2;
    for (let i = c - W; i <= c + W; i++) { const v = score(i); if (v > bv) { bv = v; bi = i; } }
    if (bi === c - W || bi === c + W) bi = -1;     // the maximum may lie beyond the window
  }
  if (bi < 0) {
    bv = -Infinity;
    for (let i = 0; i < count; i++) { const v = score(i); if (v > bv) { bv = v; bi = i; } }
  }
  const g0 = gens[wrap(bi)];
  consider(g0.n.x, g0.n.y, g0.n.z, g0.psi);
  // Refine the maximum of value(psi) = hullF(n(psi)) around generatrix bi: the vertex of the parabola
  // through it and its neighbors, then again on a finer stencil around that vertex (value is smooth in
  // psi, so each step gains several digits); a golden section when the parabola does not open downward.
  const step = TWO_PI / count, psiAt = (i) => gens[wrap(i)].psi + (i < 0 ? -TWO_PI : i >= count ? TWO_PI : 0);
  let psi = psiAt(bi), fpsi = score(bi);
  // The value at an arbitrary azimuth with its exact normal; every one is also a candidate for the maximum.
  const value = (p) => {
    if (Number.isNaN(normalNear(cone, p))) return -Infinity;
    return consider(SC[2], SC[3], SC[4], p);
  };
  let fl = score(bi - 1), fr = score(bi + 1), d = step, ok = true;
  for (let round = 0; round < rounds && ok; round++) {
    const den = fl - 2 * fpsi + fr;
    if (!(den < 0)) { ok = false; break; }
    const vtx = psi + d * 0.5 * (fl - fr) / den;
    if (Math.abs(vtx - psi) > 1.5 * d) { ok = false; break; }
    psi = vtx; fpsi = value(psi);
    if (round + 1 < rounds) { d /= 6; fl = value(psi - d); fr = value(psi + d); }
  }
  if (!ok) {
    const gr = 0.6180339887498949;
    let lo = psiAt(bi - 1), hi = psiAt(bi + 1), p1 = hi - gr * (hi - lo), p2 = lo + gr * (hi - lo), f1 = value(p1), f2 = value(p2);
    for (let it = 0; it < 14; it++) {
      if (f1 > f2) { hi = p2; p2 = p1; f2 = f1; p1 = hi - gr * (hi - lo); f1 = value(p1); } else { lo = p1; p1 = p2; f1 = f2; p2 = lo + gr * (hi - lo); f2 = value(p2); }
    }
    psi = f1 > f2 ? p1 : p2;
  }
  return { value: best, n: { x: bx, y: by, z: bz }, psi: bestPsi === null ? null : mod2pi(bestPsi) };
}

// Is x inside the hull (or on its surface)?
export const hullContains = (cone, x) => hullSigned(cone, x) <= 0;
