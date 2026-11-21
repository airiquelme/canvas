// LOCAL LIGHTS (lamps): a point with a reach and a color. Stylized and consistent from every angle: a lamp only lifts the SHADE
// (it raises the ambient light where the sun does not reach: shade, interiors, night), never the sunlit tone, and tints it toward
// its color. In BANDS: within BAND_R[b] x radius of the lamp (3D distance) the shade is lifted by BAND_LIFT[b] toward the lamp's
// tone of the color (the color multiplied by the lamp's, as lit), so pools of light step outward (no per-pixel falloff).
// GROUND: a patch's shade parts are cut along the bands' circles (the sphere of each band's radius meets the ground near the lamp
// in a circle of x, z radius sqrt(R^2 - h^2), h the lamp's height over the ground under it): exact circle arcs in the patch's
// domain (`splitByCircle`), the same pieces patch.js draws. OBJECTS (crescents, blades, movers in shade): the band at their
// center (`lampAt`).
import { pieceAt } from './patch.js';

const BAND_R = [1, 0.66, 0.33], BAND_LIFT = [0.22, 0.48, 0.75];
export const lamps = [];   // { pos: { x, y, z }, radius, color: [r, g, b] }

// The strongest lift at a world point: { level, color } or null.
export function lampAt(p) {
  let best = null;
  for (const L of lamps) {
    const d = Math.hypot(p.x - L.pos.x, p.y - L.pos.y, p.z - L.pos.z) / L.radius;
    for (let b = BAND_R.length - 1; b >= 0; b--) if (d < BAND_R[b]) {
      if (!best || BAND_LIFT[b] > best.level) best = { level: BAND_LIFT[b], color: L.color };
      break;
    }
  }
  return best;
}

// The shade tone of `hex` lifted toward the lamp's tone (cached).
const cache = new Map();
export function lampTone(hex, shade, lift) {
  const key = hex + shade + lift.level + lift.color.join();
  let v = cache.get(key);
  if (v) return v;
  const n = parseInt(hex.slice(1), 16), s = parseInt(shade.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255], sc = [(s >> 16) & 255, (s >> 8) & 255, s & 255];
  const lit = c.map((x, i) => (x * lift.color[i]) / 255);
  const r = sc.map((x, i) => Math.round(x + (lit[i] - x) * lift.level));
  v = '#' + ((1 << 24) | (r[0] << 16) | (r[1] << 8) | r[2]).toString(16).slice(1);
  if (cache.size > 4096) cache.clear();
  cache.set(key, v);
  return v;
}

// The ground parts of a patch with the lamps' bands cut in: every shade part split by each band's circle (x, z) and its inner
// pieces tagged `lamp` (the strongest band). H: the ground height (for the circles' radii).
export function lampParts(o, parts, H) {
  if (!lamps.length) return parts;
  const W = { x: o.ox, z: o.oz };
  const bx0 = o.bound[0].x, bx1 = o.bound[7].x, bz0 = o.bound[0].z, bz1 = o.bound[7].z;
  let out = parts;
  for (const L of lamps) {
    const h = L.pos.y - H(L.pos.x, L.pos.z);
    for (let b = 0; b < BAND_R.length; b++) {
      const R = BAND_R[b] * L.radius;
      if (R <= h) continue;
      const r = Math.sqrt(R * R - h * h), cx = L.pos.x - W.x, cz = L.pos.z - W.z;
      if (L.pos.x + r < bx0 || L.pos.x - r > bx1 || L.pos.z + r < bz0 || L.pos.z - r > bz1) continue;
      const next = [];
      for (const part of out) {
        if (!part.shade) { next.push(part); continue; }
        for (const q of splitByCircle(part.loop, { x: cx, z: cz }, r)) {
          const lamp = q.inside && (!part.lamp || BAND_LIFT[b] > part.lamp.level) ? { level: BAND_LIFT[b], color: L.color } : part.lamp;
          next.push({ ...part, loop: q.loop, lamp, overlay: part.overlay || q.overlay });
        }
      }
      out = next;
    }
  }
  // Overlays (a band's disc wholly inside a part) after what they lie on.
  return out.sort((a, b) => (a.shade - b.shade) || ((a.overlay ? 1 : 0) - (b.overlay ? 1 : 0)));
}

// A loop of pieces (local x, z) split by the circle (c, r): [{ loop, inside, overlay? }]. Crossings by sampling and bisection
// along each piece; the cut is the circle's own arc (exact), the side inside the loop. A circle wholly inside the loop gives the
// loop (outside) and the disc drawn over it (`overlay`).
export function splitByCircle(loop, c, r) {
  const f = (p) => Math.hypot(p.x - c.x, p.z - c.z) - r;
  const cuts = [];
  loop.forEach((pc, k) => {
    const n = pc.kind === 'arc' ? 24 : 12;
    let ua = 0, fa = f(pieceAt(pc, 0));
    for (let j = 1; j <= n; j++) {
      const ub = j / n, fb = f(pieceAt(pc, ub));
      if ((fa < 0) !== (fb < 0)) {
        let lo = ua, hi = ub;
        for (let it = 0; it < 40; it++) { const m = (lo + hi) / 2; if ((f(pieceAt(pc, m)) < 0) === (fa < 0)) lo = m; else hi = m; }
        const u = (lo + hi) / 2, p = pieceAt(pc, u);
        if (u > 1e-9 && u < 1 - 1e-9) cuts.push({ k, u, p: { x: p.x, z: p.z }, t: Math.atan2(p.z - c.z, p.x - c.x) });
      }
      ua = ub; fa = fb;
    }
  });
  const poly = [];
  for (const pc of loop) for (let j = 0; j < (pc.kind === 'arc' ? 16 : 1); j++) poly.push(pieceAt(pc, j / (pc.kind === 'arc' ? 16 : 1)));
  const inPoly = (p) => {
    let ins = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.z > p.z) !== (b.z > p.z) && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) ins = !ins;
    }
    return ins;
  };
  const disc = () => [{ kind: 'arc', c, U: { x: r, z: 0 }, V: { x: 0, z: r }, t0: 0, t1: 2 * Math.PI, edge: 'lamp' }];
  if (cuts.length < 2 || cuts.length % 2) {
    const inside = f(pieceAt(loop[0], 0.5)) < 0;
    if (!inside && inPoly(c) && poly.every((p) => f(p) > 0)) return [{ loop, inside: false }, { loop: disc(), inside: true, overlay: true }];
    return [{ loop, inside }];
  }
  const nC = cuts.length;
  // Each boundary stretch from crossing s to s + 1 lies inside or outside; an inside stretch's two crossings are joined by the
  // circle's arc inside the loop (partner), and every region walks stretch, arc, stretch...
  const insideOf = (s) => { const A = cuts[s], B = cuts[(s + 1) % nC]; const u = A.k === B.k && B.u > A.u ? (A.u + B.u) / 2 : (A.u + 1) / 2; return f(pieceAt(loop[A.k], u)) < 0; };
  const partner = new Array(nC);
  for (let s = 0; s < nC; s++) if (insideOf(s)) { partner[s] = (s + 1) % nC; partner[(s + 1) % nC] = s; }
  if (partner.some((x) => x === undefined)) return [{ loop, inside: f(pieceAt(loop[0], 0.5)) < 0 }];
  const TAU = 2 * Math.PI, mod = (t) => ((t % TAU) + TAU) % TAU;
  const arcPiece = (A, B) => {   // the circle from crossing A to B, the way that runs inside the loop
    const d = mod(B.t - A.t), tm1 = A.t + d / 2;
    const mid = { x: c.x + r * Math.cos(tm1), z: c.z + r * Math.sin(tm1) };
    const t1 = inPoly(mid) ? A.t + d : A.t - (TAU - d);
    return { kind: 'arc', c, U: { x: r, z: 0 }, V: { x: 0, z: r }, t0: A.t, t1, edge: 'lamp' };
  };
  const sub = (pc, u0, u1) => {   // a piece's stretch from u0 to u1
    if (pc.kind === 'line') {
      const P = (u) => ({ x: pc.a.x + (pc.b.x - pc.a.x) * u, z: pc.a.z + (pc.b.z - pc.a.z) * u });
      return { ...pc, a: P(u0), b: P(u1) };
    }
    return { ...pc, t0: pc.t0 + (pc.t1 - pc.t0) * u0, t1: pc.t0 + (pc.t1 - pc.t0) * u1 };
  };
  const walk = (ci, cj) => {
    const A = cuts[ci], B = cuts[cj], out = [], nP = loop.length;
    if (A.k === B.k && B.u > A.u) return [sub(loop[A.k], A.u, B.u)];
    out.push(sub(loop[A.k], A.u, 1));
    for (let k = (A.k + 1) % nP; k !== B.k; k = (k + 1) % nP) out.push(loop[k]);
    out.push(sub(loop[B.k], 0, B.u));
    return out;
  };
  const used = new Set(), parts = [];
  for (let s0 = 0; s0 < nC; s0++) {
    if (used.has(s0)) continue;
    const pieces = [], inside = insideOf(s0);
    let s = s0, guard = 0;
    do {
      used.add(s);
      const e = (s + 1) % nC;
      pieces.push(...walk(s, e));
      const p = partner[e];
      pieces.push(arcPiece(cuts[e], cuts[p]));
      s = p;
    } while (s !== s0 && ++guard <= nC);
    parts.push({ loop: pieces, inside });
  }
  return parts;
}
