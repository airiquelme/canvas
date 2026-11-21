// Grass from seeds. The map stores only the ground patches; each finest patch of the terrain (terrain.js) carries a `seed`, and its
// blades are generated from that seed alone, so the same seed always grows the same blades. A patch's blades come in the order of
// their thinning rank (stratified: blade k has rank (k + u) / n), so a far patch only generates its first few and more are added as
// the eye comes near; the sequence is the same whatever the order of visits.
//
// DENSITY BY DISTANCE: a blade is drawn when its rank u < (D0 / d)^2 (all of them within D0), at every distance: about the same
// number per screen area near and far, so even far patches have texture and nothing stops at a radius; a blade only appears or
// disappears, never moves.
// OMISSION: a patch whose blades would be under W_VANISH wide on screen (standard width, its depth) draws none.
// FADES: blades never pop: near the width cutoff and near their thinning rank they grow out of the ground (scaled about their
// base); the curved / triangle switch has a buffer (CURVE_ON, CURVE_OFF).
// DETAIL BY ANGULAR SIZE: a blade's height on screen is h s / z (known size, its depth): no curve is computed to decide.
//   - small (under CURVE_ON, or once curved under CURVE_OFF): a TRIANGLE (its base corners and its tip) in the shade tone, no light computed; all of a patch's triangles are
//     one path (one fill), drawn after the patch;
//   - larger: the curved BLADE, a leaf with three sides (base line, two edges meeting at the tip). In the blade's frame (base
//     center B, half-width W across it, height Y up, curl L toward the side it bends to), the curves
//       c_k(t) = B + k W (1 - sin t) + L (1 - cos t) + Y sin t,   t from 0 (the base) to PI / 2 (the tip), k in [-1, 1]
//     are each a plane 3D ellipse (C = B + k W + L, U = -L, V = Y - k W): one exact arc on screen. SHADE grows from the edge away from
//     the sun: the part between k = s and k = s (1 - 2 f); with a = |n . sun| (n the leaf's horizontal normal), f = (1 - a) / 2 if the
//     face seen faces the sun, else (1 + a) / 2 (continuous: 1/2 when the sun runs along the leaf); 1 in the ground's shadow field.
//     Its lit face is the ground's green, so it is drawn only where it can show (illusionRender.js: near the eye, on the ground's
//     outline); elsewhere only the shade.
import { line } from './shape.js';
import { ellipseEdge } from './sheet.js';

const DENSITY = 0.05;     // blades per square unit of ground
const D0 = 70;            // all blades within this distance; beyond, the share (D0 / d)^2
// Curved and lit from CURVE_ON px tall on screen; back to a shade triangle under CURVE_OFF (a buffer, so a blade at the border
// does not flip with every step).
const CURVE_ON = 36, CURVE_OFF = 24;
// OMISSION by width, per patch (a shortcut: no blade is measured): a standard blade's full width (WIDTH_STD) at the patch's depth,
// in canvas px. Under W_VANISH none of its blades; from there to W_FULL they GROW out of the ground (scaled about their base by a
// smoothstep), so a patch's grass rises as the eye comes near instead of appearing at once.
const WIDTH_STD = 2.3, W_VANISH = 1.2, W_FULL = 2.0;
// Thinning fades too: a blade whose rank is within the last RANK_FADE of the share kept at its distance is grown only partly.
const RANK_FADE = 0.35;
const smooth = (u) => { u = Math.max(0, Math.min(1, u)); return u * u * (3 - 2 * u); };
// A blade grown to g of its size (scaled about its base).
function grownBy(b, g) {
  const sc = (v) => ({ x: v.x * g, y: v.y * g, z: v.z * g }), W = sc(b.W), L = sc(b.L), Y = sc(b.Y);
  return { ...b, W, L, Y, h: b.h * g, tip: { x: b.base.x + L.x + Y.x, y: b.base.y + L.y + Y.y, z: b.base.z + L.z + Y.z },
    mid: { x: b.base.x + (b.mid.x - b.base.x) * g, y: b.base.y + (b.mid.y - b.base.y) * g, z: b.base.z + (b.mid.z - b.base.z) * g } };
}
const SLIVER_PX = 0.5;    // a curved blade's shade narrower than this (at the base, on screen) is not drawn
const H_MIN = 7, H_MAX = 16;

const rngOf = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
export const seedOf = (i, j, k) => (((i * 73856093) ^ (j * 19349663) ^ (k * 83492791)) >>> 0) || 1;

// The patch's blades up to the first m (by rank), generated on demand from its seed.
function bladesUpTo(leaf, T, m) {
  let g = leaf.gen;
  if (!g) {
    const A = T.P(leaf.a), B = T.P(leaf.b), C = T.P(leaf.c);
    const area = Math.abs((B.x - A.x) * (C.z - A.z) - (C.x - A.x) * (B.z - A.z)) / 2;
    g = leaf.gen = { rand: rngOf(leaf.patch.seed), n: Math.max(1, Math.round(area * DENSITY)), A, B, C, made: [] };
  }
  const { rand, n, A, B, C, made } = g;
  m = Math.min(m, n);
  while (made.length < m) {
    const k = made.length;
    let u = rand(), v = rand();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const x = A.x + (B.x - A.x) * u + (C.x - A.x) * v, z = A.z + (B.z - A.z) * u + (C.z - A.z) * v;
    const h = H_MIN + rand() * (H_MAX - H_MIN), w = 0.8 + rand() * 0.7, phi = rand() * 6.283, curl = (rand() - 0.5) * h * 0.9;
    const rank = (k + rand()) / n;
    const W = { x: Math.cos(phi) * w, y: 0, z: Math.sin(phi) * w }, nrm = { x: -Math.sin(phi), y: 0, z: Math.cos(phi) };
    const base = { x, y: T.H(x, z) - 0.4, z };
    const L = { x: nrm.x * curl, y: 0, z: nrm.z * curl }, Y = { x: 0, y: h, z: 0 };
    const mid = { x: x + L.x * 0.3, y: base.y + h * 0.7, z: z + L.z * 0.3 };
    // (under water: still generated, so the seed's sequence stays the same, but never drawn)
    made.push({ grass: true, base, W, L, Y, n: nrm, h, mid, tip: { x: x + L.x, y: base.y + h, z: z + L.z }, rank, wet: !!(T.wet && T.wet(x, z)) });
  }
  return made;
}

// This frame's grass: { curved: [blades, with host, fill, f, edge], specks: [{ host, sides, depth }] (one per patch) }.
export function selectGrass(T, eye, { F, L, toCamera, projectPoint, persp, frustum, near = 1, fit = 1 }) {
  const curved = [], specks = [];
  let count = 0;
  for (const leaf of T.leafNodes) {
    const c = leaf.patch.mid, q = toCamera(c), R = leaf.R + H_MAX;
    if (q.z + R <= near || frustum.outside(q, R)) continue;   // behind the eye or off screen: none of its blades
    const wpx = (WIDTH_STD * persp.s * fit) / Math.max(near, q.z);   // its blades' width on screen
    if (wpx < W_VANISH) continue;   // hairlines: none
    const gw = wpx >= W_FULL ? 1 : smooth((wpx - W_VANISH) / (W_FULL - W_VANISH));
    const dmin = Math.max(1, Math.hypot(c.x - eye.x, c.y - eye.y, c.z - eye.z) - R);
    const share = Math.min(1, (D0 / dmin) ** 2);
    const n = leaf.gen ? leaf.gen.n : Infinity;
    const blades = bladesUpTo(leaf, T, n === Infinity ? 1 : Math.ceil(n * share));
    if (n === Infinity) bladesUpTo(leaf, T, Math.ceil(leaf.gen.n * share));
    const sides = [];
    let zSum = 0, zN = 0;
    for (const b0 of blades) {
      const db = Math.hypot(b0.base.x - eye.x, b0.base.y - eye.y, b0.base.z - eye.z);
      const tau = db <= D0 ? 1 : (D0 / db) ** 2;
      if (b0.rank >= tau || b0.wet) continue;
      const gr = tau >= 1 ? 1 : smooth((tau - b0.rank) / (RANK_FADE * tau)), g = gw * gr;
      if (g < 0.04) continue;
      const b = g < 0.999 ? grownBy(b0, g) : b0;
      const z = toCamera(b.mid).z;
      if (z <= near + b.h) continue;
      const px = (b.h * persp.s) / z;   // its height on screen
      b0.curvedOn = b0.curvedOn ? px >= CURVE_OFF : px >= CURVE_ON;
      if (!b0.curvedOn) {   // a shade triangle: base corners, tip
        const p0 = projectPoint({ x: b.base.x - b.W.x, y: b.base.y, z: b.base.z - b.W.z });
        const p1 = projectPoint({ x: b.base.x + b.W.x, y: b.base.y, z: b.base.z + b.W.z }), p2 = projectPoint(b.tip);
        sides.push({ ...line(p0, p1), move: sides.length > 0 }, line(p1, p2), line(p2, p0));
        zSum += z; zN++;
        continue;
      }
      b.fill = leaf.patch.fill;
      b.host = leaf;
      b.dist = db;
      if (!L) b.f = 0;
      else {
        if (b0.shadowOf !== F) { b0.shadowOf = F; b0.inShadow = !!(F && F.point && F.point(b0.mid)); }
        b.inShadow = b0.inShadow;
        const nn = b.n, seen = nn.x * (eye.x - b.mid.x) + nn.z * (eye.z - b.mid.z), lit = nn.x * L.x + nn.z * L.z, a = Math.min(1, Math.abs(lit));
        b.f = b.inShadow || L.y <= 0 ? 1 : seen * lit > 0 ? (1 - a) / 2 : (1 + a) / 2;   // the sun down: all shade
        b.edge = b.W.x * L.x + b.W.z * L.z > 0 ? -1 : 1;   // the edge away from the sun
      }
      curved.push(b);
    }
    if (zN) { specks.push({ grass: true, host: leaf, sides, depth: zSum / zN }); count += zN; }
  }
  return { curved, specks, triangles: count };
}

// A curved blade's pieces on screen: the leaf (only when `full`), then its shade (from edge b.edge, a fraction b.f across) in
// `shade`; and its size. Not full: only the shade (the lit face is the ground's own color), none when it would not show.
export function bladePieces(b, projector, shade, colors, full = true) {
  if (!full && b.f <= 0.02) return { pieces: [], size: 0 };
  const T = projector.toCamera, P = projector.persp, pp = projector.projectPoint;
  const qa = pp(b.base), qt = pp(b.tip), size = Math.hypot(qt.x - qa.x, qt.y - qa.y);
  if (!full && 2 * b.f * Math.hypot(b.W.x, b.W.z) * qa.scale < SLIVER_PX) return { pieces: [], size };
  const at = (k, t) => {   // c_k(t), world
    const s = 1 - Math.sin(t), c = 1 - Math.cos(t), y = Math.sin(t);
    return { x: b.base.x + b.W.x * k * s + b.L.x * c + b.Y.x * y, y: b.base.y + b.L.y * c + b.Y.y * y, z: b.base.z + b.W.z * k * s + b.L.z * c + b.Y.z * y };
  };
  const curve = (k, t0, t1) => {   // curve k from t0 to t1 on screen: one exact arc
    const C = { x: b.base.x + b.W.x * k + b.L.x, y: b.base.y + b.L.y, z: b.base.z + b.W.z * k + b.L.z };
    const Cc = T(C), Uc = T({ x: C.x - b.L.x, y: C.y - b.L.y, z: C.z - b.L.z });
    const Vc = T({ x: C.x + b.Y.x - k * b.W.x, y: C.y + b.Y.y, z: C.z + b.Y.z - k * b.W.z });
    return ellipseEdge(Cc, { x: Uc.x - Cc.x, y: Uc.y - Cc.y, z: Uc.z - Cc.z }, { x: Vc.x - Cc.x, y: Vc.y - Cc.y, z: Vc.z - Cc.z }, t0, t1, P, 0, 1);
  };
  // The part between curves k0 and k1: k0 up to the tip, k1 back down, the base across.
  const part = (k0, k1) => [...curve(k0, 0, Math.PI / 2), ...curve(k1, Math.PI / 2, 0), line(pp(at(k1, 0)), pp(at(k0, 0)))];
  const pieces = [];
  if (b.f >= 0.98) pieces.push({ sides: part(-1, 1), fill: shade, colors });
  else {
    if (full) pieces.push({ sides: part(-1, 1), fill: b.fill, colors });
    if (b.f > 0.02) pieces.push({ sides: part(b.edge, b.edge * (1 - 2 * b.f)), fill: shade, colors });
  }
  return { pieces, size };
}
