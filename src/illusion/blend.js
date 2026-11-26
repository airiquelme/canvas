// FILLETS: two convex outlines (closed loops of ellipse arcs and lines, e.g. two parts of a figure) joined with no corner. Their
// union, filled nonzero with them, has a reflex corner wherever the outlines cross; each is filled by a PATCH: from the crossing X
// along each outline (outside the other) to the points TA, TB `d` screen px away, then the ellipse through TA and TB tangent to both
// outlines there (curve.js conicThrough, its middle at 0.45 of the way from the chord's middle to where the two tangents meet). The
// patch's other sides (X to TA, TB to X) are chords of the convex outlines, inside them: the union's outline now runs along one
// part, round the fillet's arc and on along the other, smooth. An illusion: the parts are designed alone, the join is drawn on
// screen (no 3D blend), so it follows any pose or proportions.
import { conicThrough, paramOn } from './curve.js';
import { pointOnEllipse } from './shape.js';

const SAMPLE_PX = 4;   // the outlines' sampling step for finding crossings and walking along them

// a loop's samples: each side's points and tangents (along the loop) SAMPLE_PX apart
function sampleLoop(sides) {
  const out = [];
  for (const s of sides) {
    if (s.kind === 'line') {
      const fx = s.from.x, fy = s.from.y, dx = s.to.x - fx, dy = s.to.y - fy;
      const n = Math.max(16, Math.min(400, Math.ceil(Math.hypot(dx, dy) / SAMPLE_PX)));   // (16 at least: a small figure far away still walks its fillets' lengths)
      for (let j = 0; j < n; j++) out.push({ x: fx + dx * (j / n), y: fy + dy * (j / n), tx: dx, ty: dy });
      continue;
    }
    const e = s.e, k = s.t1 - s.t0, ca = Math.cos(e.angle), sa = Math.sin(e.angle), A = e.a, B = e.b;
    const n = Math.max(16, Math.min(400, Math.ceil((Math.abs(k) * Math.max(A, B)) / SAMPLE_PX)));
    for (let j = 0; j < n; j++) {
      const t = s.t0 + (k * j) / n, c = Math.cos(t), sn = Math.sin(t);
      out.push({ x: e.x + A * c * ca - B * sn * sa, y: e.y + A * c * sa + B * sn * ca, tx: (-A * sn * ca - B * c * sa) * k, ty: (-A * sn * sa + B * c * ca) * k });
    }
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of out) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
  out.box = { x0, y0, x1, y1 };
  return out;
}
// a loop's samples (with tangents and a box), kept per loop (the sides array): a figure's part meets several others and its
// outline marks read the same samples. A loop must not change once sampled (they are built fresh every frame).
const SAMPLED = new WeakMap();
export function loopSamples(sides) {
  let P = SAMPLED.get(sides);
  if (!P) SAMPLED.set(sides, (P = sampleLoop(sides)));
  return P;
}
// A point inside a sampled CONVEX loop, exact for the sampled polygon (even-odd over its edges) but mostly answered from a table:
// per screen row (1 px apart) the loop's span [L, R], built once per loop. L is convex in y (R concave), so between two rows the
// chord of L lies on or right of the true edge (inside: certain) and the extensions of the neighboring rows' chords on or left of
// it (outside: certain); only a point between the two (within about a row of the edge) or near the loop's tips takes the edges.
function spans(P) {
  const b = P.box, y0 = Math.floor(b.y0), n = Math.max(1, Math.ceil(b.y1) - y0 + 1);
  const L = new Float64Array(n).fill(Infinity), R = new Float64Array(n).fill(-Infinity);
  for (let i = 0, m = P.length; i < m; i++) {
    const a = P[i], c = P[(i + 1) % m], ya = Math.min(a.y, c.y), yb = Math.max(a.y, c.y);
    for (let r = Math.ceil(ya - y0), r1 = Math.floor(yb - y0); r <= r1; r++) {
      const y = y0 + r, x = yb - ya < 1e-12 ? Math.min(a.x, c.x) : a.x + ((c.x - a.x) * (y - a.y)) / (c.y - a.y);
      if (x < L[r]) L[r] = x;
      if (x > R[r]) R[r] = x;
      if (yb - ya < 1e-12) { const x2 = Math.max(a.x, c.x); if (x2 > R[r]) R[r] = x2; }
    }
  }
  return (P.spans = { y0, n, L, R });
}
function insideExact(poly, p) {
  let w = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], c = poly[j];
    if ((a.y > p.y) !== (c.y > p.y) && p.x < ((c.x - a.x) * (p.y - a.y)) / (c.y - a.y) + a.x) w = !w;
  }
  return w;
}
function inside(poly, p) {
  const b = poly.box;
  if (p.x < b.x0 || p.x > b.x1 || p.y < b.y0 || p.y > b.y1) return false;
  const S = poly.spans || spans(poly), u = p.y - S.y0, r = Math.floor(u), f = u - r, L = S.L, R = S.R, x = p.x;
  if (r < 1 || r + 2 >= S.n || !(L[r - 1] <= R[r - 1] && L[r + 2] <= R[r + 2])) return insideExact(poly, p);   // (near a tip)
  const l0 = L[r], l1 = L[r + 1], r0 = R[r], r1 = R[r + 1];
  if (x > l0 + (l1 - l0) * f && x < r0 + (r1 - r0) * f) return true;
  if (x < Math.max(l0 + (l0 - L[r - 1]) * f, l1 - (L[r + 2] - l1) * (1 - f))) return false;
  if (x > Math.min(r0 + (r0 - R[r - 1]) * f, r1 - (R[r + 2] - r1) * (1 - f))) return false;
  return insideExact(poly, p);
}
export { inside as insideConvex };
// from sample index i (fraction f toward i + 1) along poly in direction dir, the first sample at least d away (path length)
function walk(poly, i, f, dir, d, other) {
  const n = poly.length;
  let k = dir > 0 ? (i + 1) % n : i, prev = { x: poly[i].x + (poly[(i + 1) % n].x - poly[i].x) * f, y: poly[i].y + (poly[(i + 1) % n].y - poly[i].y) * f }, acc = 0;
  for (let step = 0; step < n; step++) {
    const p = poly[k];
    acc += Math.hypot(p.x - prev.x, p.y - prev.y);
    if (acc >= d) return p;
    if (inside(other, p)) return step > 1 ? poly[(k - dir + n) % n] : null;   // (reached the other crossing: stop short of it)
    prev = p; k = (k + dir + n) % n;
  }
  return null;
}

// The patches joining loops A and B (sides each) with fillets d px long: [] when they don't cross. Each patch is a loop (its first
// side `move`). d may be a function of the crossing point X (screen) giving each crossing its own length.
export function filletSides(A, B, d) {
  const dOf = typeof d === 'function' ? d : () => d;
  if (!A.length || !B.length || (typeof d !== 'function' && !(d > 0.5))) return [];
  const PA = loopSamples(A), PB = loopSamples(B), bA = PA.box, bB = PB.box;
  if (bA.x1 < bB.x0 || bB.x1 < bA.x0 || bA.y1 < bB.y0 || bB.y1 < bA.y0) return [];
  // the crossings: where A's samples go into or out of B (convex: the span tables, O(1) each), each matched with the nearest of
  // B's own switches; the exact crossing of the two outlines' segments is searched next to both
  const flips = (P, Q) => { const out = [], n = P.length; let prev = inside(Q, P[n - 1]);
    for (let i = 0; i < n; i++) { const cur = inside(Q, P[i]); if (cur !== prev) out.push((i - 1 + n) % n); prev = cur; } return out; };
  const fA = flips(PA, PB), fB = flips(PB, PA), out = [];
  if (!fA.length && !fB.length) return out;
  const nA = PA.length, nB = PB.length;
  const nearest = (P, p) => { let k = 0, bd = Infinity; for (let m = 0; m < P.length; m++) { const dd = (P[m].x - p.x) ** 2 + (P[m].y - p.y) ** 2; if (dd < bd) { bd = dd; k = m; } } return k; };
  // a switch on either loop (a thin overlap may hold no sample of one of them), next to the other loop's nearest sample
  const seeds = [...fA.map((i) => [i, nearest(PB, PA[i])]), ...fB.map((j) => [nearest(PA, PB[j]), j])];
  const hits = new Map();
  for (const [fi, fj] of seeds) {
    let hit = null;
    for (let di = 0; di <= 2 && !hit; di++) for (const si of di ? [-di, di] : [0]) {
      const i = (fi + si + nA) % nA, a0 = PA[i], a1 = PA[(i + 1) % nA];
      for (let dj = 0; dj <= 3 && !hit; dj++) for (const sj of dj ? [-dj, dj] : [0]) {
        const j = (fj + sj + nB) % nB, b0 = PB[j], b1 = PB[(j + 1) % nB];
        const rx = a1.x - a0.x, ry = a1.y - a0.y, sx = b1.x - b0.x, sy = b1.y - b0.y, den = rx * sy - ry * sx;
        if (Math.abs(den) < 1e-12) continue;
        const qx = b0.x - a0.x, qy = b0.y - a0.y, ta = (qx * sy - qy * sx) / den, tb = (qx * ry - qy * rx) / den;
        if (ta < 0 || ta >= 1 || tb < 0 || tb >= 1) continue;
        hit = { i, j, ta, tb, a0, a1, b1, rx, ry };
        break;
      }
      if (hit) break;
    }
    if (hit && !hits.has(hit.i * nB + hit.j)) hits.set(hit.i * nB + hit.j, hit);
  }
  // in A's order along its loop, then B's (as the search over all pairs found them)
  for (const hit of [...hits.values()].sort((p, q) => p.i - q.i || p.j - q.j)) {
    const { i, j, ta, tb, a0, a1, b1, rx, ry } = hit;
    {
      const X = { x: a0.x + rx * ta, y: a0.y + ry * ta };
      // along each outline, the way that leaves the other
      const dA = inside(PB, a1) ? -1 : 1, dB = inside(PA, b1) ? -1 : 1;
      // the fillet: its ends dd along each outline; shortened (halved, up to 3 times) while the outlines turn too far over it (the
      // tangents must meet on the corner's side of the chord, and the fillet's middle must lie outside both parts)
      let patch = null, last = null;
      const d0 = dOf(X);
      if (!(d0 > 0.5)) continue;
      for (let dd = d0, tries = 0; tries < 4 && !patch; dd /= 2, tries++) {
        const TA = walk(PA, i, ta, dA, dd, PB), TB = walk(PB, j, tb, dB, dd, PA);
        if (!TA || !TB) continue;
        const pa = { x: TA.x, y: TA.y }, pb = { x: TB.x, y: TB.y };
        last = [pa, pb];
        const tA = { x: TA.tx, y: TA.ty }, tB = { x: TB.tx, y: TB.ty }, den2 = tA.x * tB.y - tA.y * tB.x;
        if (Math.abs(den2) < 1e-9) continue;
        const s = ((TB.x - TA.x) * tB.y - (TB.y - TA.y) * tB.x) / den2, V = { x: TA.x + tA.x * s, y: TA.y + tA.y * s };
        const cx = pb.x - pa.x, cy = pb.y - pa.y, sideOf = (p) => cx * (p.y - pa.y) - cy * (p.x - pa.x);
        if (sideOf(V) * sideOf(X) <= 0) continue;   // (the tangents open away from the corner)
        const along = ((V.x - pa.x) * cx + (V.y - pa.y) * cy) / (cx * cx + cy * cy);
        if (along < 0.05 || along > 0.95) continue;   // (nearly parallel tangents meeting far past an end)
        const M = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 }, Q = { x: M.x + 0.45 * (V.x - M.x), y: M.y + 0.45 * (V.y - M.y) };
        if (inside(PA, Q) || inside(PB, Q)) continue;
        const f = conicThrough(TA, tA, TB, tB, Q);
        if (!f) continue;
        // of the two ways round the ellipse from TA to TB, the one whose middle is nearer Q (conicThrough moves a conic that would
        // be a hyperbola into the ellipses: Q is then off it, its parameter meaningless); none near it (a nearly flat corner): a chord
        const t0 = paramOn(f.e, TA), t1 = paramOn(f.e, TB), fwd = ((t1 - t0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
        const ways = [t0 + fwd, t0 - (2 * Math.PI - fwd)].map((te) => ({ te, m: pointOnEllipse(f.e, (t0 + te) / 2) }));
        const best = ways.reduce((p, q) => (Math.hypot(q.m.x - Q.x, q.m.y - Q.y) < Math.hypot(p.m.x - Q.x, p.m.y - Q.y) ? q : p));
        if (Math.hypot(best.m.x - Q.x, best.m.y - Q.y) > 0.25 * Math.hypot(cx, cy)) { patch = [pa, { kind: 'line', from: pa, to: pb }, pb]; break; }
        // its inside must stay outside both parts (else the parts' corner would show through): checked at 5 points
        let bad = false;
        for (let q = 1; q <= 5 && !bad; q++) { const p = pointOnEllipse(f.e, t0 + ((best.te - t0) * q) / 6); bad = inside(PA, p) || inside(PB, p); }
        if (bad) continue;
        patch = [pa, { kind: 'arc', e: f.e, t0, t1: best.te }, pb];
      }
      if (!patch && last) patch = [last[0], { kind: 'line', from: last[0], to: last[1] }, last[1]];   // (a chord: still no gap)
      if (!patch) continue;
      const [pa, side, pb] = patch;
      out.push({ kind: 'line', from: X, to: pa, move: true, joins: [A, B] }, side, { kind: 'line', from: pb, to: X });   // (joins: for checks)
    }
  }
  return out;
}
