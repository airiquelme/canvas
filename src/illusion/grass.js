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
// TIPS (`tips` on, the default): a TEXTURE rather than objects: of every blade only a single THINNING CURVED LINE on its shade
// side over the top TIP_H of its height: the band between two of the blade's curves, k = kc +- dk / 2 around the middle of its
// shade band (kc = edge (1 - f); 0 when all shade), from t0 (sin t0 = 1 - TIP_H) to the tip, where every curve meets (so it thins
// to a point by itself); each side one exact arc; the start closed by a half circle. Every line starts the STANDARD LINE wide
// (config.js LINE_PX, design px) on screen, whatever its blade's size or distance (a stylized stroke; dk may pass the blade's own edges, |k| > 1). Small and curved blades alike; never the lit face. Off: the leaves.
import { line } from './shape.js';
import { LINE_PX } from '../config.js';
import { litOf } from './light.js';
import { ellipseEdge } from './sheet.js';

const DENSITY = 0.05;     // leaves: blades per square unit of ground (tips: tipTuning.density blades are generated, a share drawn)
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
const TIP_H = 1;          // tips: the share of a blade's height drawn, from the top (1: down to the ground)
const H_STD = (7 + 16) / 2;   // tips: the standard blade's height (the cutoff by distance assumes it)
const FADE_LEVELS = 8;    // tips: a line's fade in this many color steps
// TIPS' DENSITY BY DISTANCE: the share of a patch's blades drawn at distance d, so that the share of ground pixels covered by tip
// lines is the same near and far (the illusion of one texture). Fitted offline (tools/render/gpu/grassDensity.mjs: renders walking
// views with and without grass, finds each pixel's ground distance by a ray cast, and scales each knot by target / measured
// coverage), not measured at run time. Knots [distance, share], log-log interpolated, the ends held. No width cutoff: the lines
// have the standard width at any distance.
export const tipTuning = {
  density: 0.157,   // blades generated per square unit (the most a patch can draw: share 1)
  // FARTHER, SPARSER: the fitted shares (equal coverage) times (from / d)^power beyond `from`: equal coverage still read denser far
  // away (many short lines), so the far texture is thinned on purpose (power 0.5: 42% of equal coverage at 512, 30% at 1000)
  falloff: { from: 90, power: 0.5 },
  // NO DOTS: a line no longer on screen than minLen x its width (LINE_PX) reads as a dot, not a stroke. Decided from DISTANCE alone,
  // before any blade is built: a standard blade (H_STD tall) has its line exactly that long at dMax = H_STD TIP_H s / (minLen
  // LINE_PX) (s: the projection's px per unit at depth 1, so it follows the zoom); nothing is drawn from there on
  minLen: 3,
  // FADES (the stylized look: no growing): a line comes and goes by its OPACITY (truly translucent, so it fades against the sky or
  // anything behind it too; a color mix toward the ground's tone popped there), over the last RANK_FADE of its thinning share and the
  // last distFade of dMax; in FADE_LEVELS steps (one path each per patch)
  distFade: 0.25,
  band: null,   // tools only: [d0, d1] draws only the blades at distances in it (grassDensity.mjs measures band by band)
  // fitted 2026-11-22: walking views (eye 52.3 up), coverage 1.05% +- 2% in every band from 64 to 2048 units (none nearer than the
  // eye's height); the knots under 54 are held, not measured
  share: [[9, 0.993], [13, 0.993], [19, 0.993], [27, 0.993], [38, 0.993], [54, 0.868], [76, 0.675], [107, 0.154], [152, 0.0609],
    [215, 0.0342], [304, 0.015], [431, 0.00834], [724, 0.00363], [1448, 0.00101], [2896, 0.000263]],
};
let shareLn = null, shareOf = null;   // the table in logs, rebuilt when tipTuning.share is replaced
function tableShare(d) {
  if (shareOf !== tipTuning.share) { shareOf = tipTuning.share; shareLn = shareOf.map(([x, y]) => [Math.log(x), Math.log(Math.max(1e-9, y))]); }
  const K = shareLn, l = Math.log(Math.max(1, d));
  if (l <= K[0][0]) return Math.min(1, Math.exp(K[0][1]));
  for (let i = 1; i < K.length; i++) if (l <= K[i][0]) {
    const u = (l - K[i - 1][0]) / (K[i][0] - K[i - 1][0]);
    return Math.min(1, Math.exp(K[i - 1][1] + u * (K[i][1] - K[i - 1][1])));
  }
  return Math.min(1, Math.exp(K[K.length - 1][1]));
}
function tipShare(d) {
  const f = tipTuning.falloff, s = tableShare(d);
  return f && d > f.from ? s * (f.from / d) ** f.power : s;
}

// c_k(t) of blade b (world): see the header.
function bladeAt(b, k, t) {
  const s = 1 - Math.sin(t), c = 1 - Math.cos(t), y = Math.sin(t);
  return { x: b.base.x + b.W.x * k * s + b.L.x * c + b.Y.x * y, y: b.base.y + b.L.y * c + b.Y.y * y, z: b.base.z + b.W.z * k * s + b.L.z * c + b.Y.z * y };
}
// Curve k of blade b from t0 to t1 on screen: exact arcs (a plane 3D ellipse: C = B + k W + L, U = -L, V = Y - k W).
function bladeCurve(b, k, t0, t1, T, P) {
  const C = { x: b.base.x + b.W.x * k + b.L.x, y: b.base.y + b.L.y, z: b.base.z + b.W.z * k + b.L.z };
  const Cc = T(C), Uc = T({ x: C.x - b.L.x, y: C.y - b.L.y, z: C.z - b.L.z });
  const Vc = T({ x: C.x + b.Y.x - k * b.W.x, y: C.y + b.Y.y, z: C.z + b.Y.z - k * b.W.z });
  return ellipseEdge(Cc, { x: Uc.x - Cc.x, y: Uc.y - Cc.y, z: Uc.z - Cc.z }, { x: Vc.x - Cc.x, y: Vc.y - Cc.y, z: Vc.z - Cc.z }, t0, t1, P, 0, 1);
}
// Tips: the blade's shade line appended to `out` as a new loop.
function tipLine(b, pp, T, P, out) {
  const t0 = Math.asin(1 - TIP_H), w = Math.hypot(b.W.x, b.W.z);
  const kc = b.f >= 0.98 ? 0 : b.edge * (1 - b.f);
  const scale = pp(bladeAt(b, kc, t0)).scale;
  const dk = LINE_PX / (scale * w * TIP_H);   // the width at t0 is dk w TIP_H (world)
  let ka = kc + dk / 2, kb = kc - dk / 2;
  let A = pp(bladeAt(b, ka, t0)), B = pp(bladeAt(b, kb, t0));
  const tip = pp(b.tip);
  // every loop wound the same way (A -> tip -> B), so overlapping lines of one path add up under the nonzero rule
  if ((tip.x - A.x) * (B.y - A.y) - (tip.y - A.y) * (B.x - A.x) < 0) { [ka, kb] = [kb, ka]; [A, B] = [B, A]; }
  const sd = [...bladeCurve(b, ka, t0, Math.PI / 2, T, P), ...bladeCurve(b, kb, Math.PI / 2, t0, T, P)];
  // the start: a half circle from B to A, on the side away from the tip
  const cx = (A.x + B.x) / 2, cy = (A.y + B.y) / 2, r = Math.hypot(A.x - B.x, A.y - B.y) / 2;
  if (r > 1e-6) {
    const tb = Math.atan2(B.y - cy, B.x - cx), m = tb + Math.PI / 2;
    const away = Math.cos(m) * (tip.x - cx) + Math.sin(m) * (tip.y - cy) < 0;
    sd.push({ kind: 'arc', e: { x: cx, y: cy, a: r, b: r, angle: 0 }, t0: tb, t1: away ? tb + Math.PI : tb - Math.PI });
  } else sd.push(line(B, A));
  if (out.length) sd[0] = { ...sd[0], move: true };
  out.push(...sd);
  return out;
}

// The blade's shade: f, the share of its width from the edge away from the sun (b.edge); 1 in the ground's shadow or the sun down.
// atGround (tips): the shadow test at the blade's foot on the ground, as the ground's own shade parts: a line is only seen against the
// ground it stands on (at its middle, 0.7 of its height up, a blade near a shade border counted as lit over shaded ground, and its
// fading line, mixed toward the lit tone, showed as a bright line on the shade).
function shadeOfBlade(b0, b, F, L, eye, atGround = false) {
  if (!L) { b.f = 0; b.edge = 1; return; }
  if (b0.shadowOf !== F || b0.shadowAt !== atGround) {
    b0.shadowOf = F; b0.shadowAt = atGround;
    const p = atGround ? { x: b0.base.x, y: b0.base.y + 0.4, z: b0.base.z } : b0.mid;
    b0.inShadow = !!(F && F.point && F.point(p));
  }
  b.inShadow = b0.inShadow;
  const nn = b.n, seen = nn.x * (eye.x - b.mid.x) + nn.z * (eye.z - b.mid.z), lit = nn.x * L.x + nn.z * L.z, a = Math.min(1, Math.abs(lit));
  b.f = b.inShadow || L.y <= 0 ? 1 : seen * lit > 0 ? (1 - a) / 2 : (1 + a) / 2;   // the sun down: all shade
  b.edge = b.W.x * L.x + b.W.z * L.z > 0 ? -1 : 1;   // the edge away from the sun
}

const rngOf = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
export const seedOf = (i, j, k) => (((i * 73856093) ^ (j * 19349663) ^ (k * 83492791)) >>> 0) || 1;

// The patch's blades up to the first m (by rank), generated on demand from its seed.
function bladesUpTo(leaf, T, m) {
  let g = leaf.gen;
  if (!g) {
    const A = T.P(leaf.a), B = T.P(leaf.b), C = T.P(leaf.c);
    const area = Math.abs((B.x - A.x) * (C.z - A.z) - (C.x - A.x) * (B.z - A.z)) / 2;
    const n = Math.max(1, Math.round(area * tipTuning.density));
    // made: the blades; P: their bases and ranks packed (x, y, z, rank; rank 2 when under water), for the per-frame tests
    g = leaf.gen = { rand: rngOf(leaf.patch.seed), n, A, B, C, made: [], P: new Float64Array(4 * n) };
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
    const wet = !!(T.wet && T.wet(x, z));
    g.P[4 * k] = x; g.P[4 * k + 1] = base.y; g.P[4 * k + 2] = z; g.P[4 * k + 3] = wet ? 2 : rank;
    made.push({ grass: true, base, W, L, Y, n: nrm, h, mid, tip: { x: x + L.x, y: base.y + h, z: z + L.z }, rank, wet });
  }
  return made;
}

// This frame's grass: { curved: [blades, with host, fill, f, edge], specks: [{ host, sides, depth }] (one per patch) }.
export function selectGrass(T, eye, { F, L, toCamera, projectPoint, persp, frustum, near = 1, fit = 1, tips = false }) {
  const curved = [], specks = [];
  let count = 0;
  const dMax = H_STD * TIP_H * persp.s / (tipTuning.minLen * LINE_PX), dFade = tipTuning.distFade * dMax;
  for (const leaf of T.leafNodes) {
    const c = leaf.patch.mid, q = toCamera(c), R = leaf.R + H_MAX;
    if (q.z + R <= near || frustum.outside(q, R)) continue;   // behind the eye or off screen: none of its blades
    const wpx = (WIDTH_STD * persp.s * fit) / Math.max(near, q.z);   // its blades' width on screen
    if (!tips && wpx < W_VANISH) continue;   // hairlines: none (tips: their lines keep the standard width)
    const gw = tips || wpx >= W_FULL ? 1 : smooth((wpx - W_VANISH) / (W_FULL - W_VANISH));
    const ex_ = c.x - eye.x, ey_ = c.y - eye.y, ez_ = c.z - eye.z, dmin = Math.max(1, Math.sqrt(ex_ * ex_ + ey_ * ey_ + ez_ * ez_) - R);
    if (tips && dmin >= dMax) continue;   // past the dots' distance: none of its blades
    const lk = DENSITY / tipTuning.density;   // leaves keep their own density: their shares scaled
    const share = tips ? tipShare(dmin) : Math.min(1, lk * (D0 / dmin) ** 2);
    const n = leaf.gen ? leaf.gen.n : Infinity;
    const blades = bladesUpTo(leaf, T, n === Infinity ? 1 : Math.ceil(n * share));
    if (n === Infinity) bladesUpTo(leaf, T, Math.ceil(leaf.gen.n * share));
    const sides = [], byLevel = tips ? [] : null;   // tips: the lines' sides by fade level
    let zSum = 0, zN = 0;
    const D02 = D0 * D0, P = leaf.gen.P, ex = eye.x, ey = eye.y, ez = eye.z;
    for (let k = 0, nb = blades.length; k < nb; k++) {
      // thinning first, on the packed bases with no root: rank >= (D0 / d)^2  <=>  rank d^2 >= D0^2 (beyond D0); wet: rank 2
      const j = 4 * k, ddx = P[j] - ex, ddy = P[j + 1] - ey, ddz = P[j + 2] - ez, d2 = ddx * ddx + ddy * ddy + ddz * ddz, rk = P[j + 3];
      if (rk > 1) continue;
      let db, tau;
      if (tips) {
        db = Math.sqrt(d2);
        if (db >= dMax) continue;
        tau = tipShare(db);
        if (rk >= tau || (tipTuning.band && (db < tipTuning.band[0] || db >= tipTuning.band[1]))) continue;
      }
      else { if (rk * d2 >= lk * Math.max(D02, d2)) continue; db = Math.sqrt(d2); tau = lk * (db <= D0 ? 1 : D02 / d2); }
      const b0 = blades[k];
      const gr = tau >= 1 ? 1 : smooth((tau - b0.rank) / (RANK_FADE * tau));
      // tips: no growing, a fade (rank and distance); leaves: grown out of the ground
      const alpha = tips ? gr * smooth((dMax - db) / dFade) : 1, g = tips ? 1 : gw * gr;
      if (g < 0.04 || alpha < 0.5 / FADE_LEVELS) continue;
      const b = g < 0.999 ? grownBy(b0, g) : b0;
      const z = toCamera(b.mid).z;
      if (z <= near + b.h) continue;
      const px = (b.h * persp.s) / z;   // its height on screen
      b0.curvedOn = b0.curvedOn ? px >= CURVE_OFF : px >= CURVE_ON;
      if (tips) {
        shadeOfBlade(b0, b, F, L, eye, true);
        // in the ground's shade (or the sun down) the line is the ground's own tone: nothing to draw
        if (L && (b.inShadow || L.y <= 0)) continue;
        if (!L) b.f = 1;   // the light off: the whole tip
        if (b.f <= 0.02) continue;
      }
      if (!b0.curvedOn && tips) {   // its shade line, in its fade level's path
        const lv = Math.min(FADE_LEVELS, Math.round(alpha * FADE_LEVELS));
        tipLine(b, projectPoint, toCamera, persp, byLevel[lv] || (byLevel[lv] = []));
        zSum += z; zN++;
        continue;
      }
      if (!b0.curvedOn) {   // a shade triangle: base corners, tip
        const p0 = projectPoint({ x: b.base.x - b.W.x, y: b.base.y, z: b.base.z - b.W.z });
        const p1 = projectPoint({ x: b.base.x + b.W.x, y: b.base.y, z: b.base.z + b.W.z }), p2 = projectPoint(b.tip);
        sides.push({ ...line(p0, p1), move: sides.length > 0 }, line(p1, p2), line(p2, p0));
        zSum += z; zN++;
        continue;
      }
      b.ground = leaf.patch.fill;
      b.fill = litOf(b.ground);   // its lit face: the ground's lit tone
      b.host = leaf;
      b.dist = db;
      if (!tips) shadeOfBlade(b0, b, F, L, eye);
      b.alpha = Math.round(alpha * FADE_LEVELS) / FADE_LEVELS;
      curved.push(b);
    }
    if (zN && byLevel) byLevel.forEach((sd, lv) => { if (sd) specks.push({ grass: true, host: leaf, sides: sd, depth: zSum / zN, alpha: lv / FADE_LEVELS }); });
    else if (zN) specks.push({ grass: true, host: leaf, sides, depth: zSum / zN });
    if (zN) count += zN;
  }
  return { curved, specks, triangles: count };
}

// A curved blade's pieces on screen: the leaf (only when `full`), then its shade (from edge b.edge, a fraction b.f across) in
// `shade`; and its size. Not full: only the shade (the lit face is the ground's own color), none when it would not show.
export function bladePieces(b, projector, shade, colors, full = true, tips = false) {
  if (tips) full = false;
  if (!full && b.f <= 0.02) return { pieces: [], size: 0 };
  const T = projector.toCamera, P = projector.persp, pp = projector.projectPoint;
  const qa = pp(b.base), qt = pp(b.tip), size = Math.hypot(qt.x - qa.x, qt.y - qa.y);
  if (tips) return { pieces: [{ sides: tipLine(b, pp, T, P, []), fill: shade, colors }], size };
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
