// A 2-node mesh bent through a third point, as screen shapes whose sides are ellipse arcs and lines. NO SAMPLING: every event is
// a root of a polynomial, every piece is built from exact points.
//
// The 3D centerline is the half-ellipse with conjugate semi-diameters (A - B) / 2 and S - M (M the midpoint of A, B),
// X(th) = M + U cos th + V sin th, th = 0 at A, PI / 2 at S, PI at B; the radius is r(th) = r0 + r1 cos th (rA at A, rB at B).
// The camera is affine, so in camera space X, Y, Z and r are all of the form a + b cos th + c sin th. On screen the tube is the
// union of its cross-sections' discs D(th): center c = (cx + s X / Z, cy - s Y / Z), radius w = s r / Z. Every quantity below
// (and its th derivatives) is a trig polynomial over a power of Z, so every condition on it is a trig polynomial = 0.
//
// THE UNION, piece by piece. Between events, each stretch of the arch is drawn as a simple closed loop whose area is exactly the
// union of its discs, and all loops go into ONE path with the same orientation: the canvas's nonzero fill then paints their
// union, including the corners where two parts of a fold cross, with no outline computed.
// - normal stretch: a tube. Its sides are the discs' envelope, O = c + w (-w~ t + s k n), s = +-1 (t, n = t turned +90 degrees
//   the screen tangent and normal, w~ = dw / d(screen arclength), k = sqrt(1 - w~^2)); its caps are arcs of the end discs, centered
//   on the outward direction, half-angle acos(-+w~) (a half disc for a constant width, the whole disc or nothing where the
//   envelope ends on a nested stretch).
// - fold: where the tube turns toward the camera its screen centerline bends tighter than the tube is wide, and the envelope on
//   the inside folds (a swallowtail between two cusps, inside the tube). There each envelope point of the folded side lies inside
//   its neighbors' discs (|p - c(th + h)|^2 - w^2 = h^2 (1 - w curvature) < 0), so the union of the stretch's discs is bounded by
//   the outer envelope and the two end discs alone, meeting where the two circles cross (closed form), at an end of the arch too.
// - nested: seen almost end-on, |w~| >= 1: each disc lies inside the next and there is no envelope at all; the stretch is its
//   largest disc, the one at an end.
// EVENTS (th in [0, PI]): nesting starts / stops where w'^2 = |c'|^2 (degree 4); a side's envelope has a cusp where the circle
// family's second th derivative vanishes on it: E = s G sqrt(H) with E = L2 (L2 - w'^2 - w w'') + w w' (c' . c''),
// G = w (c' x c''), H = L2 - w'^2 (L2 = |c'|^2), squared E^2 - G^2 H = 0 (degree 16). Both are solved as polynomials in
// z = e^(i th) (Aberth's method), roots near the unit circle kept; spurious extra roots only add harmless breaks, since each
// stretch is classified by evaluating the exact functions at its middle. Fixed breaks at every PI / 4 keep each stretch's turn
// small.
// SIDES. Each stretch's envelope is cut where its tangent turns more than MAX_TURN (bisection on the exact tangent angle) and
// each part is the ellipse through both ends with their tangents (perpendicular to the radius: the envelope touches its disc)
// nearest the middle point (`conicThrough`), or a line if straight.
// BORDERS (Strokes button) are stroked under the fill (shape.js), so only the outer half of the union's outline shows.
import { arc } from './shape.js';

const TAU = Math.PI * 2;
const mod = (x) => ((x % TAU) + TAU) % TAU;
const MAX_TURN = Math.PI / 8;   // the most an envelope part may turn (rad)
const MAX_CHORD_PX = 300;       // ... or span on screen
const ROOT_TOL = 0.05;          // |ln |z|| for a root to count as real

// ctx.ellipse's parameter of a screen point on e.
export function paramOn(e, p) {
  const dx = p.x - e.x, dy = p.y - e.y, ca = Math.cos(e.angle), sa = Math.sin(e.angle);
  return Math.atan2((-dx * sa + dy * ca) / e.b, (dx * ca + dy * sa) / e.a);
}

// The arc of e from tS to tE that passes through tM.
function arcThrough(e, tS, tE, tM) {
  const d = mod(tE - tS), dm = mod(tM - tS);
  return arc(e, tS, dm < d ? tS + d : tS - (TAU - d));
}

// The ellipse through P1 and P2 tangent to T1 / T2 there, as close to Q as an ellipse can be: { e } or null. The pencil
// L1 L2 - k M^2 (L1, L2 the tangent lines, M the chord) holds every conic tangent to both lines at those points; Q fixes k. Its
// discriminant B^2 - 4AC is linear in k, so where Q's conic is a hyperbola, k is moved just past the parabola (k*) into the
// ellipses.
export function conicThrough(P1, T1, P2, T2, Q) {
  const lineAt = (P, T) => { const a = -T.y, b = T.x; return [a, b, -(a * P.x + b * P.y)]; };
  const L1 = lineAt(P1, T1), L2 = lineAt(P2, T2), M = lineAt(P1, { x: P2.x - P1.x, y: P2.y - P1.y });
  const ev = (L, p) => L[0] * p.x + L[1] * p.y + L[2];
  const mq = ev(M, Q);
  if (Math.abs(mq) < 1e-9) return null;
  let k = ev(L1, Q) * ev(L2, Q) / (mq * mq);
  const a0 = L1[0] * L2[0], b0 = L1[0] * L2[1] + L2[0] * L1[1], c0 = L1[1] * L2[1];
  const d0 = b0 * b0 - 4 * a0 * c0, d1 = -4 * b0 * M[0] * M[1] + 4 * a0 * M[1] * M[1] + 4 * c0 * M[0] * M[0];
  if (!(d0 + d1 * k < 0)) {
    if (Math.abs(d1) < 1e-15) return null;
    const ks = -d0 / d1;
    k = ks - Math.sign(d1) * (Math.abs(ks) * 0.02 + 1e-12);
  }
  const A = a0 - k * M[0] * M[0], B = b0 - 2 * k * M[0] * M[1], C = c0 - k * M[1] * M[1];
  const D = L1[0] * L2[2] + L2[0] * L1[2] - 2 * k * M[0] * M[2];
  const E = L1[1] * L2[2] + L2[1] * L1[2] - 2 * k * M[1] * M[2];
  const F = L1[2] * L2[2] - k * M[2] * M[2];
  const disc = B * B - 4 * A * C;
  if (!(disc < 0)) return null;
  const x = (B * E - 2 * C * D) / -disc, y = (B * D - 2 * A * E) / -disc;   // center: grad = 0
  const F0 = F + (D * x + E * y) / 2;
  const angle = 0.5 * Math.atan2(B, A - C), ca = Math.cos(angle), sa = Math.sin(angle);
  const la = A * ca * ca + B * ca * sa + C * sa * sa, lb = A * sa * sa - B * ca * sa + C * ca * ca;
  const a2 = -F0 / la, b2 = -F0 / lb;
  if (!(a2 > 0 && b2 > 0)) return null;
  return { e: { x, y, a: Math.sqrt(a2), b: Math.sqrt(b2), angle } };
}

// ---- Trig polynomials: { a: [a0 .. aN], b: [0, b1 .. bN] } = sum a_k cos k th + b_k sin k th. ----
const tp1 = (c0, c1, s1) => ({ a: [c0, c1], b: [0, s1] });
function tpAdd(P, Q, kq = 1) {
  const n = Math.max(P.a.length, Q.a.length), a = new Array(n).fill(0), b = new Array(n).fill(0);
  for (let i = 0; i < P.a.length; i++) { a[i] += P.a[i]; b[i] += P.b[i]; }
  for (let i = 0; i < Q.a.length; i++) { a[i] += kq * Q.a[i]; b[i] += kq * Q.b[i]; }
  return { a, b };
}
function tpMul(P, Q) {
  const n = P.a.length + Q.a.length - 1, a = new Array(n).fill(0), b = new Array(n).fill(0);
  for (let i = 0; i < P.a.length; i++) for (let j = 0; j < Q.a.length; j++) {
    const pa = P.a[i], pb = P.b[i], qa = Q.a[j], qb = Q.b[j];
    if (!pa && !pb) break;
    const s = i + j, d = i - j;
    a[s] += (pa * qa - pb * qb) / 2;               // cos i cos j, sin i sin j -> cos(i + j)
    a[Math.abs(d)] += (pa * qa + pb * qb) / 2;     //                          -> cos(i - j)
    b[s] += (pb * qa + pa * qb) / 2;               // sin i cos j, cos i sin j -> sin(i + j)
    const sd = (pb * qa - pa * qb) / 2;            //                          -> sin(i - j)
    if (d > 0) b[d] += sd; else if (d < 0) b[-d] -= sd;
  }
  return { a, b };
}
const tpD = (P) => ({ a: P.a.map((_, k) => k * P.b[k]), b: P.a.map((ak, k) => -k * ak) });

// The real roots in [lo, hi] of a trig polynomial: the roots near the unit circle of z^N P (z = e^(i th)), by Aberth's method.
function tpRoots(P, lo, hi) {
  let N = P.a.length - 1;
  const scale = Math.max(1e-300, ...P.a.map(Math.abs), ...P.b.map(Math.abs));
  while (N > 0 && Math.abs(P.a[N]) + Math.abs(P.b[N]) < 1e-12 * scale) N--;
  if (N === 0) return [];
  // coefficients of z^j, j = 0 .. 2N: c_k (k = j - N): c_k = (a_k - i b_k) / 2, c_-k = conj, c_0 = a_0
  const n = 2 * N, cr = new Float64Array(n + 1), ci = new Float64Array(n + 1);
  for (let k = 1; k <= N; k++) {
    cr[N + k] = P.a[k] / 2 / scale; ci[N + k] = -P.b[k] / 2 / scale;
    cr[N - k] = P.a[k] / 2 / scale; ci[N - k] = P.b[k] / 2 / scale;
  }
  cr[N] = P.a[0] / scale;
  const zr = new Float64Array(n), zi = new Float64Array(n);
  for (let k = 0; k < n; k++) { const a = TAU * k / n + 0.4; zr[k] = 1.1 * Math.cos(a); zi[k] = 1.1 * Math.sin(a); }
  for (let it = 0; it < 200; it++) {
    let moved = 0;
    for (let k = 0; k < n; k++) {
      // p(z) and p'(z) by Horner
      let pr = cr[n], pi = ci[n], dr = 0, di = 0;
      const xr = zr[k], xi = zi[k];
      for (let j = n - 1; j >= 0; j--) {
        const ndr = dr * xr - di * xi + pr, ndi = dr * xi + di * xr + pi;
        dr = ndr; di = ndi;
        const npr = pr * xr - pi * xi + cr[j], npi = pr * xi + pi * xr + ci[j];
        pr = npr; pi = npi;
      }
      const dd = dr * dr + di * di;
      if (dd === 0) continue;
      const rr = (pr * dr + pi * di) / dd, ri = (pi * dr - pr * di) / dd;   // p / p'
      let sr = 0, si = 0;   // sum of 1 / (z_k - z_j)
      for (let j = 0; j < n; j++) {
        if (j === k) continue;
        const ur = xr - zr[j], ui = xi - zi[j], uu = ur * ur + ui * ui;
        if (uu === 0) continue;
        sr += ur / uu; si -= ui / uu;
      }
      // w = r / (1 - r s)
      const br = 1 - (rr * sr - ri * si), bi = -(rr * si + ri * sr), bb = br * br + bi * bi;
      if (bb === 0) continue;
      const wr = (rr * br + ri * bi) / bb, wi = (ri * br - rr * bi) / bb;
      zr[k] -= wr; zi[k] -= wi;
      moved = Math.max(moved, Math.hypot(wr, wi) / (1 + Math.hypot(xr, xi)));
    }
    if (moved < 1e-13) break;
  }
  const out = [];
  for (let k = 0; k < n; k++) {
    const m = Math.hypot(zr[k], zi[k]);
    if (!(Math.abs(Math.log(m)) < ROOT_TOL)) continue;
    let th = Math.atan2(zi[k], zr[k]);
    if (th < lo - 1e-9) th += TAU;
    if (th > lo && th < hi) out.push(th);
  }
  return out;
}

// A, S, B: world points; rA, rB: world radii; projector: makeProjector's result (its toCamera and persp). Returns the sides of
// every piece's loop (each loop starts with `move`), with color indices `ci`: 0 the + side, 2 the - side, 1 / 3 the caps at B / A,
// 4 inner caps and nested discs, 5 on each further stretch of a side.
export function curvedSides(A, S, B, rA, rB, projector) {
  const { toCamera, persp } = projector, sp = persp.s, cx = persp.cx, cy = persp.cy;
  const Mw = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2, z: (A.z + B.z) / 2 };
  const Mc = toCamera(Mw), Ac = toCamera(A), Sc = toCamera(S);
  const U = { x: Ac.x - Mc.x, y: Ac.y - Mc.y, z: Ac.z - Mc.z }, V = { x: Sc.x - Mc.x, y: Sc.y - Mc.y, z: Sc.z - Mc.z };
  const r0 = (rA + rB) / 2, r1 = (rA - rB) / 2;

  // The disc at th, exactly, with its first and second th derivatives (screen px).
  const ev = (th) => {
    const c = Math.cos(th), s = Math.sin(th);
    const X = Mc.x + U.x * c + V.x * s, Y = Mc.y + U.y * c + V.y * s, Z = Mc.z + U.z * c + V.z * s;
    const Xp = V.x * c - U.x * s, Yp = V.y * c - U.y * s, Zp = V.z * c - U.z * s;
    const Xpp = -(U.x * c + V.x * s), Ypp = -(U.y * c + V.y * s), Zpp = -(U.z * c + V.z * s);
    const r = r0 + r1 * c, rp = -r1 * s, rpp = -r1 * c;
    const iz = 1 / Z, iz2 = iz * iz, iz3 = iz2 * iz;
    const d1 = (F, Fp) => (Fp * Z - F * Zp) * iz2;
    const d2 = (F, Fp, Fpp) => ((Fpp * Z - F * Zpp) * Z - 2 * Zp * (Fp * Z - F * Zp)) * iz3;
    return {
      x: cx + sp * X * iz, y: cy - sp * Y * iz, w: sp * r * iz,
      dx: sp * d1(X, Xp), dy: -sp * d1(Y, Yp), dw: sp * d1(r, rp),
      ddx: sp * d2(X, Xp, Xpp), ddy: -sp * d2(Y, Yp, Ypp), ddw: sp * d2(r, rp, rpp),
    };
  };
  // The envelope point on side s at th, its unit radius direction rho and the side's tangent there (along growing th).
  const env = (th, s, e = ev(th)) => {
    const L = Math.hypot(e.dx, e.dy) || 1e-300, tx = e.dx / L, ty = e.dy / L;
    const wt = Math.max(-1, Math.min(1, e.dw / L)), k = Math.sqrt(1 - wt * wt);
    const rx = -wt * tx - s * k * ty, ry = -wt * ty + s * k * tx;
    return { x: e.x + e.w * rx, y: e.y + e.w * ry, T: { x: s * ry, y: -s * rx }, ang: Math.atan2(ry, rx), wt, tAng: Math.atan2(ty, tx) };
  };
  // The class of the stretch around th: 'nested', 'fold+' / 'fold-' (that side's envelope folded), or 'normal'.
  const classOf = (th) => {
    const e = ev(th), L2 = e.dx * e.dx + e.dy * e.dy, H = L2 - e.dw * e.dw;
    if (!(H > 0)) return 'nested';
    const D = e.dx * e.ddx + e.dy * e.ddy, C = e.dx * e.ddy - e.dy * e.ddx;
    const E = L2 * (L2 - e.dw * e.dw - e.w * e.ddw) + e.w * e.dw * D, G = e.w * C * Math.sqrt(H);
    const fp = E - G < 0, fm = E + G < 0;
    return fp && fm ? 'nested' : fp ? 'fold+' : fm ? 'fold-' : 'normal';
  };

  // EVENTS: the same conditions as trig polynomials (numerators over powers of Z; the scale s and the shift cx, cy drop out).
  const sc = 1 / (Math.abs(Mc.z) || 1);   // homogeneous: X, Y, Z, r scaled alike, for well-sized coefficients
  const Xt = tp1(Mc.x * sc, U.x * sc, V.x * sc), Yt = tp1(Mc.y * sc, U.y * sc, V.y * sc), Zt = tp1(Mc.z * sc, U.z * sc, V.z * sc);
  const Rt = tp1(r0 * sc, r1 * sc, 0);
  const Zp = tpD(Zt);
  const d1n = (F) => tpAdd(tpMul(tpD(F), Zt), tpMul(F, Zp), -1);        // (F' Z - F Z'): c' = (P, Q) / Z^2, w' = W1 / Z^2
  const d2n = (F1) => tpAdd(tpMul(tpD(F1), Zt), tpMul(F1, Zp), -2);     // (F1' Z - 2 F1 Z'): c'' = (P2, Q2) / Z^3, w'' = W2 / Z^3
  const P = d1n(Xt), Qn = d1n(Yt), Q = { a: Qn.a.map(v => -v), b: Qn.b.map(v => -v) };   // screen y points down
  const P2 = d2n(P), Q2 = d2n(Q), W1 = d1n(Rt), W2 = d2n(W1);
  const L2n = tpAdd(tpMul(P, P), tpMul(Q, Q));
  const Dn = tpAdd(tpMul(P, P2), tpMul(Q, Q2)), Cn = tpAdd(tpMul(P, Q2), tpMul(Q, P2), -1);
  const W1sq = tpMul(W1, W1), Hn = tpAdd(L2n, W1sq, -1);
  const En = tpAdd(tpMul(L2n, tpAdd(Hn, tpMul(Rt, W2), -1)), tpMul(tpMul(Rt, W1), Dn));
  const RC = tpMul(Rt, Cn);
  const Fn = tpAdd(tpMul(En, En), tpMul(tpMul(RC, RC), Hn), -1);
  const breaks = [0, Math.PI / 4, Math.PI / 2, 3 * Math.PI / 4, Math.PI, ...tpRoots(Hn, 0, Math.PI), ...tpRoots(Fn, 0, Math.PI)]
    .sort((p, q) => p - q).filter((t, i, arr) => i === 0 || t - arr[i - 1] > 1e-9);

  // STRETCHES: one per pair of consecutive breaks, each classified at its middle. They are not merged: a long piece could
  // overlap itself on screen, and a loop crossing itself with opposite windings would cancel its own fill.
  const runs = [];
  for (let i = 0; i + 1 < breaks.length; i++) runs.push({ cls: classOf((breaks[i] + breaks[i + 1]) / 2), a: breaks[i], b: breaks[i + 1] });

  // Colors: a side's first stretch keeps its color, every further one takes a new index from 5 on.
  let extra = 5;
  const sideColor = { 1: null, '-1': null };
  const colorOf = (s) => { const k = String(s); if (sideColor[k] === null) { sideColor[k] = s > 0 ? 0 : 2; return sideColor[k]; } return extra++; };

  // The envelope of side s from th0 to th1 (either order): ellipse arcs, cut where the tangent turns more than MAX_TURN.
  const sidePieces = (th0, th1, s, ci) => {
    const parts = [];
    const psi = (o) => Math.atan2(Math.sqrt(Math.max(0, 1 - o.wt * o.wt)), -o.wt);
    const rec = (a, b, ea, eb, depth) => {
      const dphi = Math.atan2(Math.sin(eb.tAng - ea.tAng), Math.cos(eb.tAng - ea.tAng));
      const turn = dphi + s * (psi(eb) - psi(ea));
      const chord = Math.hypot(eb.x - ea.x, eb.y - ea.y);
      if (depth < 12 && (Math.abs(turn) > MAX_TURN || Math.abs(dphi) > Math.PI / 2 || chord > MAX_CHORD_PX)) {
        const m = (a + b) / 2, em = env(m, s);
        rec(a, m, ea, em, depth + 1); rec(m, b, em, eb, depth + 1);
      } else parts.push([a, b, ea, eb]);
    };
    rec(th0, th1, env(th0, s), env(th1, s), 0);
    return parts.map(([a, b, ea, eb]) => {
      const q = env((a + b) / 2, s), ch = { x: eb.x - ea.x, y: eb.y - ea.y }, cl = Math.hypot(ch.x, ch.y) || 1e-300;
      const off = Math.abs((q.x - ea.x) * ch.y - (q.y - ea.y) * ch.x) / cl;
      const fit = off > 0.05 ? conicThrough(ea, ea.T, eb, eb.T, q) : null;
      if (!fit) return { kind: 'line', from: { x: ea.x, y: ea.y }, to: { x: eb.x, y: eb.y }, ci };
      return { ...arcThrough(fit.e, paramOn(fit.e, ea), paramOn(fit.e, eb), paramOn(fit.e, q)), ci };
    });
  };
  const reversed = (ps) => ps.reverse().map(p => p.kind === 'line' ? { ...p, from: p.to, to: p.from } : { ...p, t0: p.t1, t1: p.t0 });
  const discAt = (th) => { const e = ev(th); return { x: e.x, y: e.y, a: e.w, b: e.w, angle: 0, e }; };
  // An arc of disc d from point p to point q, decreasing angle (the loops' orientation: the tube on the left on screen).
  const decArc = (d, p, q, ci) => {
    const tS = Math.atan2(p.y - d.y, p.x - d.x), tE = Math.atan2(q.y - d.y, q.x - d.x);
    return { ...arc(d, tS, tS - mod(tS - tE)), ci };
  };
  // The cap at an end of a tube stretch: the arc of its disc centered on the outward direction u (+t at the stretch's end, -t at
  // its start), half-angle acos(-w~) / acos(w~), from the side ending there to the side starting there (decreasing angle).
  const capAt = (th, atEnd, ci) => {
    const d = discAt(th), L = Math.hypot(d.e.dx, d.e.dy) || 1e-300, wt = Math.max(-1, Math.min(1, d.e.dw / L));
    const au = Math.atan2(d.e.dy, d.e.dx) + (atEnd ? 0 : Math.PI), phi = Math.acos(atEnd ? -wt : wt);
    return { ...arc(d, au + phi, au - phi), ci };
  };
  // Where the circles of discs da and db cross on side s of the line from da to db (null if they don't).
  const crossing = (da, db, s) => {
    const dx = db.x - da.x, dy = db.y - da.y, d = Math.hypot(dx, dy);
    if (!(d < da.a + db.a && d > Math.abs(da.a - db.a))) return null;
    const ux = dx / d, uy = dy / d, m = (da.a * da.a - db.a * db.a + d * d) / (2 * d), h = Math.sqrt(Math.max(0, da.a * da.a - m * m));
    return { x: da.x + m * ux - s * h * uy, y: da.y + m * uy + s * h * ux };
  };
  const circle = (d, ci) => ({ ...arc(d, 0, -TAU), ci });
  // The projected centerline from a to b: a conic (the image of a planar ellipse), so the ellipse through both ends with their
  // tangents and the middle point is exact.
  const centerline = (a, b) => {
    const ea = ev(a), eb = ev(b), em = ev((a + b) / 2), P0 = { x: ea.x, y: ea.y }, P1 = { x: eb.x, y: eb.y }, Q = { x: em.x, y: em.y };
    const fit = conicThrough(P0, { x: ea.dx, y: ea.dy }, P1, { x: eb.dx, y: eb.dy }, Q);
    if (!fit) return [{ kind: 'line', from: P0, to: P1, ci: 4 }];
    return [{ ...arcThrough(fit.e, paramOn(fit.e, P0), paramOn(fit.e, P1), paramOn(fit.e, Q)), ci: 4 }];
  };

  const sides = [];
  const loop = (pieces) => { if (pieces.length) { pieces[0] = { ...pieces[0], move: true }; sides.push(...pieces); } };
  const capColor = (th, atEnd) => (atEnd && th >= Math.PI - 1e-12 ? 1 : !atEnd && th <= 1e-12 ? 3 : 4);
  for (const { cls, a, b } of runs) {
    if (cls === 'normal') {
      loop([...sidePieces(a, b, 1, colorOf(1)), capAt(b, true, capColor(b, true)), ...reversed(sidePieces(a, b, -1, colorOf(-1))), capAt(a, false, capColor(a, false))]);
    } else if (cls === 'nested') {
      const da = discAt(a), db = discAt(b);
      loop([circle(da.a >= db.a ? da : db, 4)]);
    } else {
      // A fold. Inside the stretch the folded side's envelope points lie inside their neighbors' discs, so the union of its discs
      // is bounded by the outer envelope and the two end discs only, which meet where their circles cross on the folded side.
      const sf = cls === 'fold+' ? 1 : -1, so = -sf, da = discAt(a), db = discAt(b), X = crossing(da, db, sf);
      const outer = sidePieces(a, b, so, colorOf(so)), Pa = env(a, so), Pb = env(b, so);
      if (!X) {   // the end discs don't cross (one holds the other): both discs, and the strip between the outer side and the centerline
        loop([circle(da, 4)]); loop([circle(db, 4)]);
        const ca = { x: da.x, y: da.y }, cb = { x: db.x, y: db.y };
        if (so > 0) loop([...outer, { kind: 'line', from: Pb, to: cb, ci: 4 }, ...reversed(centerline(a, b)), { kind: 'line', from: ca, to: Pa, ci: 4 }]);
        else loop([{ kind: 'line', from: Pa, to: ca, ci: 4 }, ...centerline(a, b), { kind: 'line', from: cb, to: Pb, ci: 4 }, ...reversed(outer)]);
        continue;
      }
      if (so > 0) loop([...outer, decArc(db, Pb, X, capColor(b, true)), decArc(da, X, Pa, capColor(a, false))]);
      else loop([decArc(db, X, Pb, capColor(b, true)), ...reversed(outer), decArc(da, Pa, X, capColor(a, false))]);
    }
  }
  const e0 = ev(0), e1 = ev(Math.PI), em = ev(Math.PI / 2);
  return { sides, ends: [{ x: e0.x, y: e0.y }, { x: e1.x, y: e1.y }, { x: em.x, y: em.y }] };
}
