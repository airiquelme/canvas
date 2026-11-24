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

// a side's point and tangent (along the loop) at u in [0, 1]
function evalSide(s, u) {
  if (s.kind === 'line') return { x: s.from.x + (s.to.x - s.from.x) * u, y: s.from.y + (s.to.y - s.from.y) * u, tx: s.to.x - s.from.x, ty: s.to.y - s.from.y };
  const e = s.e, k = s.t1 - s.t0, t = s.t0 + k * u, c = Math.cos(t), sn = Math.sin(t), ca = Math.cos(e.angle), sa = Math.sin(e.angle);
  return { x: e.x + e.a * c * ca - e.b * sn * sa, y: e.y + e.a * c * sa + e.b * sn * ca, tx: (-e.a * sn * ca - e.b * c * sa) * k, ty: (-e.a * sn * sa + e.b * c * ca) * k };
}
function sampleLoop(sides) {
  const out = [];
  for (const s of sides) {
    const len = s.kind === 'line' ? Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y) : Math.abs(s.t1 - s.t0) * Math.max(s.e.a, s.e.b);
    const n = Math.max(16, Math.min(400, Math.ceil(len / SAMPLE_PX)));   // (16 at least: a small figure far away still walks its fillets' lengths)
    for (let j = 0; j < n; j++) out.push(evalSide(s, j / n));
  }
  return out;
}
function inside(poly, p) {
  const b = poly.box;
  if (b && (p.x < b.x0 || p.x > b.x1 || p.y < b.y0 || p.y > b.y1)) return false;
  let w = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) w = !w;
  }
  return w;
}
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
// side `move`).
export function filletSides(A, B, d) {
  if (!A.length || !B.length || !(d > 0.5)) return [];
  const PA = sampleLoop(A), PB = sampleLoop(B);
  const box = (P) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of P) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; } return (P.box = { x0, y0, x1, y1 }); };
  const bA = box(PA), bB = box(PB);
  if (bA.x1 < bB.x0 || bB.x1 < bA.x0 || bA.y1 < bB.y0 || bB.y1 < bA.y0) return [];
  // only the segments of each that reach the boxes' overlap can cross
  const I = { x0: Math.max(bA.x0, bB.x0), y0: Math.max(bA.y0, bB.y0), x1: Math.min(bA.x1, bB.x1), y1: Math.min(bA.y1, bB.y1) };
  const near = (P) => { const out = []; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length];
    if (Math.max(a.x, b.x) >= I.x0 && Math.min(a.x, b.x) <= I.x1 && Math.max(a.y, b.y) >= I.y0 && Math.min(a.y, b.y) <= I.y1) out.push(i); } return out; };
  const nA = near(PA), nB = near(PB), out = [];
  for (const i of nA) {
    const a0 = PA[i], a1 = PA[(i + 1) % PA.length];
    const ax0 = Math.min(a0.x, a1.x), ax1 = Math.max(a0.x, a1.x), ay0 = Math.min(a0.y, a1.y), ay1 = Math.max(a0.y, a1.y);
    for (const j of nB) {
      const b0 = PB[j], b1 = PB[(j + 1) % PB.length];
      if (Math.max(b0.x, b1.x) < ax0 || Math.min(b0.x, b1.x) > ax1 || Math.max(b0.y, b1.y) < ay0 || Math.min(b0.y, b1.y) > ay1) continue;
      const rx = a1.x - a0.x, ry = a1.y - a0.y, sx = b1.x - b0.x, sy = b1.y - b0.y, den = rx * sy - ry * sx;
      if (Math.abs(den) < 1e-12) continue;
      const qx = b0.x - a0.x, qy = b0.y - a0.y, ta = (qx * sy - qy * sx) / den, tb = (qx * ry - qy * rx) / den;
      if (ta < 0 || ta >= 1 || tb < 0 || tb >= 1) continue;
      const X = { x: a0.x + rx * ta, y: a0.y + ry * ta };
      // along each outline, the way that leaves the other
      const dA = inside(PB, a1) ? -1 : 1, dB = inside(PA, b1) ? -1 : 1;
      // the fillet: its ends dd along each outline; shortened (halved, up to 3 times) while the outlines turn too far over it (the
      // tangents must meet on the corner's side of the chord, and the fillet's middle must lie outside both parts)
      let patch = null, last = null;
      for (let dd = d, tries = 0; tries < 4 && !patch; dd /= 2, tries++) {
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
