// An EGG (the figures' arms): a limb between two joints, widest at M (a circle of radius B across its axis u) and closing onto
// each joint as a ball of the joint's radius r. Each half is a half spheroid (half-axes A along u, B across) whose A is chosen so
// that the joint's ball fits inside it TANGENT along a circle: the half's surface runs into the ball's with no crease, and the
// body ends at the joint, nothing past it. No 3D body is drawn: on screen it is ONE smooth closed curve of ellipse arcs, so it
// LOOKS like that solid from the camera, in exact PERSPECTIVE:
// - a quadric's perspective image is an exact conic: with the camera at the origin (camera space), a spheroid or ball (center c,
//   K^-1 = A^2 u u^T + B^2 (I - u u^T), or r^2 I) has the image dual conic S (K^-1 - c c^T) S^T, S the screen map
//   [[s, 0, cx], [0, -s, cy], [0, 0, 1]];
// - the outline runs along a surface where its tangent plane passes through the eye: on the widest circle (normal w across u) where
//   w . (eye - M) = B, on a joint's tangent circle (the ball's normal n = c u + s w) where n . (eye - S) = r: closed forms. These
//   points lie on both surfaces' outlines with the same tangent there, so the arcs meet with no corner;
// - the outline: each half's spheroid image from the widest circle's two outline points round to the points where it meets its
//   ball's outline, then round the ball. When the tangent circle has no outline point (seen nearly along the axis) the ball lies
//   inside: the half's whole arc.
// Tangency (axial x from M, the joint at distance d): the ellipse's normal at (x0, y0) meets the axis at x0 (1 - e), e = B^2 / A^2;
// with that at d and the distance r: e / (1 - e) = q = (B^2 - r^2) / d^2, x0 = d (1 + q) (on the half while B^2 - r^2 <= d r).

import { hullOutline, ellipseParam, ellipsePoint } from '../core/geometry.js';

const TAU = 2 * Math.PI, mod = (t) => ((t % TAU) + TAU) % TAU;
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const add = (a, b, k = 1) => ({ x: a.x + b.x * k, y: a.y + b.y * k, z: a.z + b.z * k });
const scale = (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k });

// ctx.ellipse's parameter of the point p on (or in direction p from the center of) e
function paramOf(e, p) {
  const dx = p.x - e.x, dy = p.y - e.y, ca = Math.cos(e.angle), sa = Math.sin(e.angle);
  return Math.atan2((-dx * sa + dy * ca) / e.b, (dx * ca + dy * sa) / e.a);
}
// the arc of e from tS to tE through tM
function arcVia(e, tS, tE, tM) {
  const d = mod(tE - tS), dm = mod(tM - tS);
  return { kind: 'arc', e, t0: tS, t1: dm < d ? tS + d : tS - (TAU - d) };
}

// M: the widest circle's center (world), u: the unit axis, B: the widest half-width, d1 / d2: the joints' distances from M back
// along u / along u, r1 / r2: the joints' radii there (world units). []: not wholly in front of the eye.
export function eggSides(M, u, B, d1, d2, r1, r2, projector) {
  const T = projector.toCamera, P = projector.persp;
  const Mc = T(M), uc0 = T(add(M, u)), uc = { x: uc0.x - Mc.x, y: uc0.y - Mc.y, z: uc0.z - Mc.z };   // camera space: the eye at 0
  if (Mc.z - Math.max(d1, d2) - B <= 1) return [];
  const proj = (X) => ({ x: P.cx + (P.s * X.x) / X.z, y: P.cy - (P.s * X.y) / X.z });
  // the image of the quadric (center c, K^-1 = A^2 a a^T + Bq^2 (I - a a^T), camera space) as ctx.ellipse's terms, or null
  const image = (c, a, A, Bq) => {
    const k1 = A * A - Bq * Bq, Q = (i, j) => (i === j ? Bq * Bq : 0) + k1 * a[i] * a[j] - c[i] * c[j];
    const s = P.s, row = [[s, 0, P.cx], [0, -s, P.cy], [0, 0, 1]];
    const D = (i, j) => { let v = 0; for (let p = 0; p < 3; p++) for (let q = 0; q < 3; q++) v += row[i][p] * Q(p, q) * row[j][q]; return v; };
    const d33 = D(2, 2);
    if (!(d33 < 0)) return null;
    const kk = -1 / d33, ex = -D(0, 2) * kk, ey = -D(1, 2) * kk;
    const p = D(0, 0) * kk + ex * ex, q = D(0, 1) * kk + ex * ey, rr = D(1, 1) * kk + ey * ey;
    const m = (p + rr) / 2, dl = Math.hypot((p - rr) / 2, q);
    return { x: ex, y: ey, a: Math.sqrt(Math.max(0, m + dl)), b: Math.sqrt(Math.max(1e-12, m - dl)), angle: 0.5 * Math.atan2(2 * q, p - rr) };
  };
  const arr = (v) => [v.x, v.y, v.z];
  const Ma = arr(Mc), ua = arr(uc);
  // the widest circle's outline points: w . (eye - M) = B, w across u
  const DM = scale(Mc, -1), DMu = dot(DM, uc), DMp = add(DM, uc, -DMu), dmp = Math.hypot(DMp.x, DMp.y, DMp.z);
  if (dmp <= B * 1.0001) {   // seen along the axis (the eye inside the widest circle's cylinder): its widest disc
    const e = image(Ma, ua, 0, B);
    return e ? [{ kind: 'arc', e, t0: 0, t1: TAU }] : [];
  }
  const eM = scale(DMp, 1 / dmp), bM = cross(uc, eM), cw = B / dmp, sw = Math.sqrt(1 - cw * cw);
  const side = bM;   // which side of the axis: the start of the end half (d2)
  const Wp = add(Mc, add(scale(eM, cw), bM, sw), B), Wm = add(Mc, add(scale(eM, cw), bM, -sw), B);
  // one half: sg = +1 toward the end (d2), -1 toward the start (d1); from the widest circle's outline point on its start side round
  // its ball to the other
  const half = (sg, d, r) => {
    const ui = scale(uc, sg);
    const Bh = Math.min(B, Math.sqrt(r * r + d * r) * (1 - 1e-9));   // (tangency needs B^2 - r^2 <= d r)
    const q = (Bh * Bh - r * r) / (d * d), A = Bh * Math.sqrt((1 + q) / q), x0 = d * (1 + q);
    const y0 = Bh * Math.sqrt(Math.max(0, 1 - (x0 * x0) / (A * A)));
    const E = image(Ma, ua, A, Bh);
    if (!E) return null;
    const from = proj(sg > 0 ? Wp : Wm), to = proj(sg > 0 ? Wm : Wp), tipW = proj(add(Mc, ui, d + r));
    const tS = paramOf(E, from), tE = paramOf(E, to);
    // the arc's direction: the way from tS to tE through tV (a point of the half's arc)
    let dir = 1;
    const via = (tV) => { dir = mod(tV - tS) < mod(tE - tS) ? 1 : -1; };
    const span = (a, b) => ({ kind: 'arc', e: E, t0: a, t1: a + dir * mod(dir * (b - a)) });
    via(paramOf(E, tipW));   // (the tip's direction; replaced below by the exact point where it meets its ball's outline)
    // the joint's tangent circle: normals n = c ui + s w (w across ui), on the outline where n . (eye - S) = r
    const S = add(Mc, ui, d), c = (x0 - d) / r, s = y0 / r;
    const D = scale(S, -1), Du = dot(D, ui), Dp = add(D, ui, -Du), dp = Math.hypot(Dp.x, Dp.y, Dp.z);
    const cs = dp > 1e-12 && s > 1e-12 ? (r - c * Du) / (s * dp) : 2;
    if (Math.abs(cs) >= 1) return [span(tS, tE)];   // the ball inside: the half's whole arc
    const eh = scale(Dp, 1 / dp), bh = cross(ui, eh), sn = Math.sqrt(1 - cs * cs);
    let nA = add(scale(ui, c), add(scale(eh, cs), bh, sn), s), nB = add(scale(ui, c), add(scale(eh, cs), bh, -sn), s);
    if ((dot(nA, side) > 0) !== (sg > 0)) [nA, nB] = [nB, nA];   // nA on the side the half starts from
    const ball = image(arr(S), ua, r, r);
    if (!ball) return null;
    const PA = proj(add(S, nA, r)), PB = proj(add(S, nB, r)), tipB = proj(add(S, ui, r));
    via(paramOf(E, PA));   // on the arc between the widest circle's points (exact, also seen nearly along the axis)
    return [span(tS, paramOf(E, PA)), arcVia(ball, paramOf(ball, PA), paramOf(ball, PB), paramOf(ball, tipB)), span(paramOf(E, PB), tE)];
  };
  const h2 = half(1, d2, r2), h1 = half(-1, d1, r1);
  return h1 && h2 ? [...h2, ...h1] : [];
}

// An OVOID (the figures' mittens): two half ELLIPSOIDS sharing their widest cross-section, the ellipse M + Bw cos f w + Bn sin f n
// (w, n unit, across the unit axis a), one reaching A2 along a (to the fingertips), the other A1 back (into the wrist). Both
// halves' surfaces run parallel to a along the shared ellipse: no crease. On screen, in exact perspective, ONE smooth closed curve
// of two ellipse arcs: each half's image (the dual quadric, as for the egg) from the shared ellipse's outline points round to the
// other. In the half's own unit-sphere coordinates y (the eye at e), the outline is the circle |y| = 1, y . e = 1: it crosses the
// shared ellipse (y_a = 0) where ew cos f + en sin f = 1 (closed form) and is farthest along the half at c + R a_perp (c = e / |e|^2,
// R = sqrt(1 - 1 / |e|^2)): that point picks the arc. Seen from within the shared ellipse's cylinder (the eye nearly on the axis)
// the near half's contour lies wholly on it and hides the other: its whole image.
// `ball` ({ c, r }, optional: the wrist): the outline is the HULL of the ovoid and that ball, the exact image of their 3D convex
// hull (the image of a convex hull is the hull of the images): where the hand is thinner than the wrist (its thickness, seen from
// the front) the outline runs on from the ball to the hand along their common tangents, straight, with no notch.
export function ovoidSides(M, a, w, n, A1, A2, Bw, Bn, projector, ball = null) {
  const T = projector.toCamera, P = projector.persp;
  const Mc = T(M), dir = (v) => { const q = T(add(M, v)); return { x: q.x - Mc.x, y: q.y - Mc.y, z: q.z - Mc.z }; };
  const ac = dir(a), wc = dir(w), nc = dir(n);
  if (Mc.z - Math.max(A1, A2, Bw, Bn) <= 1) return [];
  const proj = (X) => ({ x: P.cx + (P.s * X.x) / X.z, y: P.cy - (P.s * X.y) / X.z });
  // the image of the ellipsoid (center M, half-axes A along sg a, Bw along w, Bn along n) as ctx.ellipse's terms, or null
  const image = (A, C = Mc, V = [[ac.x, ac.y, ac.z, A], [wc.x, wc.y, wc.z, Bw], [nc.x, nc.y, nc.z, Bn]]) => {
    const c = [C.x, C.y, C.z];
    const Q = (i, j) => V[0][i] * V[0][j] * V[0][3] ** 2 + V[1][i] * V[1][j] * V[1][3] ** 2 + V[2][i] * V[2][j] * V[2][3] ** 2 - c[i] * c[j];
    const s = P.s, row = [[s, 0, P.cx], [0, -s, P.cy], [0, 0, 1]];
    const D = (i, j) => { let v = 0; for (let p = 0; p < 3; p++) for (let q = 0; q < 3; q++) v += row[i][p] * Q(p, q) * row[j][q]; return v; };
    const d33 = D(2, 2);
    if (!(d33 < 0)) return null;
    const kk = -1 / d33, ex = -D(0, 2) * kk, ey = -D(1, 2) * kk;
    const p = D(0, 0) * kk + ex * ex, q = D(0, 1) * kk + ex * ey, rr = D(1, 1) * kk + ey * ey;
    const m = (p + rr) / 2, dl = Math.hypot((p - rr) / 2, q);
    return { x: ex, y: ey, a: Math.sqrt(Math.max(0, m + dl)), b: Math.sqrt(Math.max(1e-12, m - dl)), angle: 0.5 * Math.atan2(2 * q, p - rr) };
  };
  const E = scale(Mc, -1), ea = dot(E, ac), ew = dot(E, wc) / Bw, en = dot(E, nc) / Bn, rho = Math.hypot(ew, en);
  const at = (ya, yw, yn, sg, A) => add(add(add(Mc, ac, sg * A * ya), wc, Bw * yw), nc, Bn * yn);   // camera space
  if (rho <= 1.0001) {   // the eye within the cylinder: the near half's whole image
    const e = image(ea > 0 ? A2 : A1);
    return e ? [{ kind: 'arc', e, t0: 0, t1: TAU }] : [];
  }
  const f0 = Math.atan2(en, ew), df = Math.acos(1 / rho);
  const Pp = proj(at(0, Math.cos(f0 + df), Math.sin(f0 + df), 1, 0)), Pm = proj(at(0, Math.cos(f0 - df), Math.sin(f0 - df), 1, 0));
  const half = (sg, A, from, to) => {
    const e = image(A);
    if (!e) return null;
    const ya = (sg * ea) / A, n2 = ya * ya + rho * rho, R = Math.sqrt(Math.max(0, 1 - 1 / n2));
    // a_perp = (1, 0, 0) minus its part along the eye, unit
    let px = 1 - (ya * ya) / n2, pw = -(ya * ew) / n2, pn = -(ya * en) / n2;
    const pl = Math.hypot(px, pw, pn) || 1;
    const tip = proj(at(ya / n2 + (R * px) / pl, ew / n2 + (R * pw) / pl, en / n2 + (R * pn) / pl, sg, A));
    return arcVia(e, paramOf(e, from), paramOf(e, to), paramOf(e, tip));
  };
  const h2 = half(1, A2, Pp, Pm), h1 = half(-1, A1, Pm, Pp);
  if (!h1 || !h2) return [];
  const balls = (ball ? (Array.isArray(ball) ? ball : [ball]) : []).map((b) => ellipsoidImage(projector, b.c, [[{ x: 1, y: 0, z: 0 }, b.r], [{ x: 0, y: 1, z: 0 }, b.r], [{ x: 0, y: 0, z: 1 }, b.r]]));
  if (balls.some((b) => !b)) return [h2, h1];
  return balls.length ? hullSides([h2, h1], balls) : [h2, h1];
}

// The exact perspective image of the ellipsoid C + sum axes[i][0] axes[i][1] cos.. (axes: [unit direction, half-axis] x 3, mutually
// perpendicular, world), as ctx.ellipse's terms { x, y, a, b, angle }, or null (not wholly in front of the eye).
export function ellipsoidImage(projector, C, axes) {
  const T = projector.toCamera, P = projector.persp, Cc = T(C);
  if (Cc.z - Math.max(...axes.map((q) => q[1])) <= 1) return null;
  const V = axes.map(([v, l]) => { const q = T(add(C, v)); return [q.x - Cc.x, q.y - Cc.y, q.z - Cc.z, l]; }), c = [Cc.x, Cc.y, Cc.z];
  const Q = (i, j) => V[0][i] * V[0][j] * V[0][3] ** 2 + V[1][i] * V[1][j] * V[1][3] ** 2 + V[2][i] * V[2][j] * V[2][3] ** 2 - c[i] * c[j];
  const s = P.s, row = [[s, 0, P.cx], [0, -s, P.cy], [0, 0, 1]];
  const D = (i, j) => { let v = 0; for (let p = 0; p < 3; p++) for (let q = 0; q < 3; q++) v += row[i][p] * Q(p, q) * row[j][q]; return v; };
  const d33 = D(2, 2);
  if (!(d33 < 0)) return null;
  const kk = -1 / d33, ex = -D(0, 2) * kk, ey = -D(1, 2) * kk;
  const p = D(0, 0) * kk + ex * ex, q = D(0, 1) * kk + ex * ey, rr = D(1, 1) * kk + ey * ey;
  const m = (p + rr) / 2, dl = Math.hypot((p - rr) / 2, q);
  return { x: ex, y: ey, a: Math.sqrt(Math.max(0, m + dl)), b: Math.sqrt(Math.max(1e-12, m - dl)), angle: 0.5 * Math.atan2(2 * q, p - rr) };
}

// A HULL of ellipsoids (the torso: chest, pelvis, shoulders): the image of their 3D convex hull is the hull of their images, so its
// outline is exact: arcs of the images joined by their common tangents. bodies: [{ C, axes }] (ellipsoidImage's terms).
export function hullOfEllipsoids(projector, bodies) {
  const es = bodies.map((b) => ellipsoidImage(projector, b.C, b.axes));
  if (es.some((e) => !e)) return [];
  return es.length === 1 ? [{ kind: 'arc', e: es[0], t0: 0, t1: TAU }] : hullSides([], es);   // (one: its own image)
}

// The hull of a convex loop of ellipse arcs and some whole ellipses, as sides (arcs and the common tangents' lines).
function hullSides(arcs, fulls) {
  const E = (e) => ({ center: { x: e.x, y: e.y }, a: e.a, b: e.b, angle: e.angle });
  const nrmAt = (e, t) => e.angle + Math.atan2(e.a * Math.sin(t), e.b * Math.cos(t));   // the outward normal's angle at t
  const items = arcs.map((s) => {
    const [lo, hi] = s.t1 > s.t0 ? [s.t0, s.t1] : [s.t1, s.t0];
    return { e: E(s.e), th0: nrmAt(s.e, lo), th1: nrmAt(s.e, hi), src: s.e };
  });
  for (const f of fulls) items.push({ e: E(f), src: f });
  const ops = hullOutline(items, 32);   // (a coarser check of the common tangents: small hulls of near-circles; the fallback is unchanged)
  const back = (ge) => { const it = items.find((q) => q.e.center === ge.center); return it ? it.src : { x: ge.center.x, y: ge.center.y, a: ge.a, b: ge.b, angle: ge.angle }; };
  // each op as [start, end, side or null]: arcs run toward decreasing normal angle
  const segs = ops.map((op) => {
    if (op.k === 'p') return [op.p, op.p, null];
    const e = back(op.e), span = op.from - op.to, t0 = ellipseParam(op.e, op.from);
    const t1 = span >= TAU - 1e-9 ? t0 - TAU : t0 - mod(t0 - ellipseParam(op.e, op.to));
    return [ellipsePoint(op.e, op.from), ellipsePoint(op.e, op.to), { kind: 'arc', e, t0, t1 }];
  });
  const out = [];
  segs.forEach(([, end, side], i) => {
    if (side) out.push(side);
    const next = segs[(i + 1) % segs.length][0];
    if (Math.hypot(next.x - end.x, next.y - end.y) > 1e-4) out.push({ kind: 'line', from: end, to: next });
  });
  return out;
}
