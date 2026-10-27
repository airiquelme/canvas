// Shells (CLAUDE.md "Shells"): parts of spheroids drawn as open surfaces. Pure math, no canvas.
//
// A shell is x = c + T u, u on the unit sphere, T = [r e1, r e2, r roundness a]: roundness 1 a sphere, < 1 oblate, 0 a flat disc
// (the curvature at the pole is roundness / r). T is affine, so every test is a *cap* { n, d } = { u : n . u >= d } on the unit
// sphere, bounded by a circle: the cuts (given in u-space, so a part keeps its outline as the roundness changes), the face toward the
// camera (u . p >= 1, p = T^-1 (camPos - c): its circle is the contour) and the lit side (u . T^-1 L >= 0, a great circle). A piece is
// an intersection of caps, its boundary arcs of circles, and every circle is a planar 3D ellipse in the world: exact on screen.
import { vecSub, vecDot, vecCross, vecNormalize } from './geometry.js';

export const shells = {};
let nextShellId = 1;

// `cuts`: a list of caps (the helpers below, concatenated). `spin` turns e1 about the axis (radians).
export function createShell({ center, radius, roundness = 1, axis = { x: 0, y: 1, z: 0 }, spin = 0, cuts = [], color, innerColor = color }) {
  const id = nextShellId++;
  shells[id] = { id, center, radius, roundness, axis, spin, cuts, color, innerColor };
  return id;
}

// Cut helpers, in u-space (e1, e2, axis): each returns a list of caps.
const cap = (n, d) => { const l = Math.hypot(n[0], n[1], n[2]); return { n: [n[0] / l, n[1] / l, n[2] / l], d: d / l }; };
export const plane = (n, d = 0) => [cap(n, d)];
// The half on the axis' side.
export const hemisphere = () => [cap([0, 0, 1], 0)];
// A ribbon: latitudes lat0 <= lat <= lat1 (radians, 0 = equator).
export const band = (lat0, lat1) => [cap([0, 0, 1], Math.sin(lat0)), cap([0, 0, -1], -Math.sin(lat1))];
// Azimuths phi0 <= phi <= phi1 about the axis (from e1 toward e2), a span of at most PI (an intersection of two half-spaces).
export const wedge = (phi0, phi1) => [cap([-Math.sin(phi0), Math.cos(phi0), 0], 0), cap([Math.sin(phi1), -Math.cos(phi1), 0], 0)];
// |u . e1| <= wx, |u . e2| <= wy (fractions of the radius): planes parallel to the axis.
export const box = (wx, wy) => [cap([1, 0, 0], -wx), cap([-1, 0, 0], -wx), cap([0, 1, 0], -wy), cap([0, -1, 0], -wy)];
// A rectangular panel on the axis' side: a floor or a pane at roundness 0, a curved panel above it.
export const panel = (wx, wy) => [...hemisphere(), ...box(wx, wy)];

export const FLAT_EPS = 1e-9;

// The shell's frame: center, e1, e2, axis, radius, roundness; `toWorld(u)` = T u (a direction), `toU(w)` = T^-1 w (not when flat).
export function shellFrame(s) {
  const a = vecNormalize(s.axis);
  const ref = Math.abs(a.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 };
  const k = vecDot(ref, a), b1 = vecNormalize({ x: ref.x - k * a.x, y: ref.y - k * a.y, z: ref.z - k * a.z }), b2 = vecCross(a, b1);
  const cs = Math.cos(s.spin), sn = Math.sin(s.spin);
  const e1 = { x: cs * b1.x + sn * b2.x, y: cs * b1.y + sn * b2.y, z: cs * b1.z + sn * b2.z }, e2 = vecCross(a, e1);
  const r = s.radius, h = r * s.roundness, flat = s.roundness < FLAT_EPS;
  const toWorld = (u) => ({
    x: r * (u[0] * e1.x + u[1] * e2.x) + h * u[2] * a.x,
    y: r * (u[0] * e1.y + u[1] * e2.y) + h * u[2] * a.y,
    z: r * (u[0] * e1.z + u[1] * e2.z) + h * u[2] * a.z,
  });
  const toU = (w) => [vecDot(w, e1) / r, vecDot(w, e2) / r, vecDot(w, a) / h];
  return { c: s.center, e1, e2, a, r, h, flat, toWorld, toU };
}

const dot3 = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const cross3 = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
const TWO_PI = Math.PI * 2;
const mod2pi = (x) => ((x % TWO_PI) + TWO_PI) % TWO_PI;
// `term` marks the light's cap (the terminator), kept by the complement.
export const complement = (k) => ({ n: [-k.n[0], -k.n[1], -k.n[2]], d: -k.d, term: k.term });

// The circle bounding a cap: center d n, radius rho, basis (p, q) with p x q = n, so increasing t runs counterclockwise about n
// with the cap on the left.
function circleOf(k) {
  const n = k.n, ref = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const c = dot3(ref, n), pr = [ref[0] - c * n[0], ref[1] - c * n[1], ref[2] - c * n[2]], pl = Math.hypot(...pr);
  const p = [pr[0] / pl, pr[1] / pl, pr[2] / pl], q = cross3(n, p);
  return { n, d: k.d, m: [k.d * n[0], k.d * n[1], k.d * n[2]], rho: Math.sqrt(Math.max(0, 1 - k.d * k.d)), p, q, term: !!k.term };
}
export const circlePoint = (ci, t) => {
  const c = Math.cos(t) * ci.rho, s = Math.sin(t) * ci.rho;
  return [ci.m[0] + c * ci.p[0] + s * ci.q[0], ci.m[1] + c * ci.p[1] + s * ci.q[1], ci.m[2] + c * ci.p[2] + s * ci.q[2]];
};
const paramOnCircle = (ci, x) => Math.atan2(dot3(ci.q, x), dot3(ci.p, x));

// The boundary of the intersection of caps: { empty } or { whole } or { circles, loops }, each loop a list of arcs
// { ci, t0, t1 } (t1 > t0) running with the region on the left. Arcs of each circle between its crossings with the others are kept
// where their middle lies in every other cap; a circle crossing none is kept whole if it lies in the others.
export function capRegion(caps) {
  const ks = [];
  for (const k of caps) {
    if (k.d >= 1) return { empty: true };
    if (k.d <= -1) continue;
    let skip = false;
    for (const o of ks) {
      const c = dot3(o.n, k.n);
      if (c > 1 - 1e-12 && Math.abs(o.d - k.d) < 1e-12) { skip = true; break; }               // the same cap twice
      if (c < -1 + 1e-12 && Math.abs(o.d + k.d) < 1e-12) return { empty: true };              // a cap and its complement
    }
    if (!skip) ks.push(k);
  }
  if (!ks.length) return { whole: true };
  const circles = ks.map(circleOf), n = circles.length;
  const ts = circles.map(() => []);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const A = circles[i], B = circles[j], c = dot3(A.n, B.n), det = 1 - c * c;
    if (det < 1e-14) continue;
    const al = (A.d - c * B.d) / det, be = (B.d - c * A.d) / det;
    const u0 = [al * A.n[0] + be * B.n[0], al * A.n[1] + be * B.n[1], al * A.n[2] + be * B.n[2]], w = cross3(A.n, B.n);
    const rest = 1 - dot3(u0, u0);
    if (rest <= 1e-14) continue;
    const s = Math.sqrt(rest / det);
    for (const sg of [s, -s]) {
      const x = [u0[0] + sg * w[0], u0[1] + sg * w[1], u0[2] + sg * w[2]];
      ts[i].push(paramOnCircle(A, x));
      ts[j].push(paramOnCircle(B, x));
    }
  }
  const inOthers = (i, x) => ks.every((k, j) => j === i || dot3(k.n, x) >= k.d - 1e-12);
  const arcs = [];
  for (let i = 0; i < n; i++) {
    if (!ts[i].length) {
      if (inOthers(i, circlePoint(circles[i], 0))) arcs.push({ ci: i, t0: 0, t1: TWO_PI, whole: true });
      continue;
    }
    const t = ts[i].map(mod2pi).sort((x, y) => x - y);
    for (let a = 0; a < t.length; a++) {
      const t0 = t[a], t1 = a + 1 < t.length ? t[a + 1] : t[0] + TWO_PI;
      if (t1 - t0 < 1e-12) continue;
      if (inOthers(i, circlePoint(circles[i], (t0 + t1) / 2))) arcs.push({ ci: i, t0, t1 });
    }
  }
  if (!arcs.length) return { empty: true };
  // Chain the arcs into loops: each ends where the next one starts.
  arcs.forEach(r => { r.p0 = circlePoint(circles[r.ci], r.t0); r.p1 = circlePoint(circles[r.ci], r.t1); });
  const dist2 = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
  const used = new Set(), loops = [];
  for (const first of arcs) {
    if (used.has(first)) continue;
    used.add(first);
    const loop = [first];
    let cur = first;
    while (!cur.whole && dist2(cur.p1, first.p0) > 1e-14) {
      let best = null, bd = 1e-10;
      for (const r of arcs) if (!used.has(r) && !r.whole) { const d2 = dist2(cur.p1, r.p0); if (d2 < bd) { bd = d2; best = r; } }
      if (!best) break;
      used.add(best); loop.push(best); cur = best;
    }
    loops.push(loop);
  }
  return { circles, loops };
}

// A circle of u-space as the world's 3D ellipse C + U cos t + V sin t.
export function worldEllipse(f, ci) {
  const m = f.toWorld(ci.m), p = f.toWorld(ci.p), q = f.toWorld(ci.q);
  return { C: { x: f.c.x + m.x, y: f.c.y + m.y, z: f.c.z + m.z }, U: { x: p.x * ci.rho, y: p.y * ci.rho, z: p.z * ci.rho }, V: { x: q.x * ci.rho, y: q.y * ci.rho, z: q.z * ci.rho } };
}

// The range of w . x over the shell's cut region (camera-independent; cached on the shell while its parameters stay put): the
// largest of g . u (g = T^T w) at the interior extreme g / |g| if it is in the region, and on every arc at its extreme or ends.
export function shellRange(s, w) {
  const key = [s.center.x, s.center.y, s.center.z, s.radius, s.roundness, s.axis.x, s.axis.y, s.axis.z, s.spin, s.cuts.length].join();
  if (!s._region || s._region.key !== key) s._region = { key, f: shellFrame(s), reg: capRegion(s.cuts) };
  const { f, reg } = s._region;
  if (reg.empty) return null;
  const g = [vecDot(w, f.e1) * f.r, vecDot(w, f.e2) * f.r, vecDot(w, f.a) * f.h], gl = Math.hypot(...g), base = vecDot(w, f.c);
  const inRegion = (x) => s.cuts.every(k => dot3(k.n, x) >= k.d - 1e-12);
  const extreme = (sg) => {
    let best = -Infinity;
    if (gl > 0 && inRegion([sg * g[0] / gl, sg * g[1] / gl, sg * g[2] / gl])) best = gl;
    if (!reg.whole) for (const loop of reg.loops) for (const r of loop) {
      const ci = reg.circles[r.ci], gp = sg * dot3(g, ci.p), gq = sg * dot3(g, ci.q), gm = sg * dot3(g, ci.m);
      const tStar = Math.atan2(gq, gp), cands = [r.t0, r.t1];
      const k = r.t0 + mod2pi(tStar - r.t0);
      if (k <= r.t1) cands.push(k);
      for (const t of cands) best = Math.max(best, gm + ci.rho * (gp * Math.cos(t) + gq * Math.sin(t)));
    }
    if (reg.whole) best = gl;
    return best;
  };
  return { lo: base - extreme(-1), hi: base + extreme(1) };
}

// The pieces of a shell for one camera, back to front: the inside face (where it shows through the opening), then the outside, each as
// its base (Twilight) and its lit part over it; with `lit` false one piece per face in its Lit tone. [{ face: 'inner' | 'outer', lit,
// region, frame }]; with the light on, also each face's unlit part (`dark`: not drawn, the border strokes' tone mask), or [] when nothing shows (camera inside the shell, a flat shell seen edge-on).
export function shellPieces(s, camPos, lightDir, lit = true) {
  const f = shellFrame(s), rel = vecSub(camPos, f.c);
  let front, sun;
  if (f.flat) {
    const sc = Math.sign(vecDot(f.a, rel));
    if (!sc) return [];
    front = { n: [0, 0, sc], d: 0 };
    sun = { n: [0, 0, Math.sign(vecDot(f.a, lightDir)) || 1], d: 0, term: true };
  } else {
    const p = f.toU(rel), pl = Math.hypot(...p);
    if (pl <= 1) return [];
    front = { n: [p[0] / pl, p[1] / pl, p[2] / pl], d: 1 / pl };
    const l = f.toU(lightDir), ll = Math.hypot(...l);
    sun = { n: [l[0] / ll, l[1] / ll, l[2] / ll], d: 0, term: true };
  }
  const out = [];
  const add = (face, isLit, caps, dark = false) => { const region = capRegion([...s.cuts, ...caps]); if (!region.empty) out.push({ face, lit: isLit, dark, region, frame: f }); };
  const back = complement(front);
  if (lit) {
    add('inner', false, [back]); add('inner', true, [back, complement(sun)]);
    add('outer', false, [front]); add('outer', true, [front, sun]);
    add('inner', false, [back, sun], true); add('outer', false, [front, complement(sun)], true);
  } else {
    add('inner', true, [back]); add('outer', true, [front]);
  }
  return out;
}
