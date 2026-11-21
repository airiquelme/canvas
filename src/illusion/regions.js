// Splitting a floor patch's loop (local x, z pieces: lines and ellipse arcs, patch.js) by a boolean field, for regions that are
// not circles (water: shorelines). Crossings along each piece by sampling and bisection; inside, the cut between two crossings is a
// circle arc in x, z through both and the border's point on the chord's perpendicular bisector (a line where they are in line), as
// the shadow field's cuts (shadow.js). Crossings are paired as neighbors along the loop, the pairing of the two with the shorter
// cuts (they never cross). Returns [{ loop, inside }]; a loop with no crossings (or an odd count) is whole, by the field at its
// first piece's middle (an island inside it is left out).
import { pieceAt } from './patch.js';

export function splitLoop(loop, test) {
  const cuts = [];
  loop.forEach((pc, k) => {
    const n = pc.kind === 'arc' ? 24 : 12;
    let ua = 0, sa = test(pieceAt(pc, 0));
    for (let j = 1; j <= n; j++) {
      const ub = j / n, sb = test(pieceAt(pc, ub));
      if (sa !== sb) {
        let lo = ua, hi = ub;
        for (let it = 0; it < 32; it++) { const m = (lo + hi) / 2; if (test(pieceAt(pc, m)) === sa) lo = m; else hi = m; }
        const u = (lo + hi) / 2, p = pieceAt(pc, u);
        if (u > 1e-9 && u < 1 - 1e-9) cuts.push({ k, u, p: { x: p.x, z: p.z } });
      }
      ua = ub; sa = sb;
    }
  });
  if (cuts.length < 2 || cuts.length % 2) return [{ loop, inside: test(pieceAt(loop[0], 0.5)) }];
  const nC = cuts.length;
  const len = (off) => { let s = 0; for (let a = 0; a < nC; a += 2) { const p = cuts[(a + off) % nC].p, q = cuts[(a + off + 1) % nC].p; s += Math.hypot(q.x - p.x, q.z - p.z); } return s; };
  const off = nC > 2 && len(1) < len(0) ? 1 : 0;
  const partner = new Array(nC);
  for (let a = 0; a < nC; a += 2) { const i = (a + off) % nC, j = (a + off + 1) % nC; partner[i] = j; partner[j] = i; }
  const cutPiece = (A, B) => {
    const m = { x: (A.x + B.x) / 2, z: (A.z + B.z) / 2 }, n = { x: -(B.z - A.z) / 2, z: (B.x - A.x) / 2 };
    const at = (s) => ({ x: m.x + n.x * s, z: m.z + n.z * s }), sm = test(m);
    let M = null;
    for (const sgn of [1, -1]) {
      let lo = 0, found = null;
      for (let k = 1; k <= 8 && !found; k++) { const s = (sgn * k) / 8; if (test(at(s)) !== sm) found = [lo, s]; else lo = s; }
      if (found) {
        let [a, b] = found;
        for (let it = 0; it < 30; it++) { const c = (a + b) / 2; if (test(at(c)) === sm) a = c; else b = c; }
        M = at((a + b) / 2);
        break;
      }
    }
    const straight = { kind: 'line', a: A, b: B, edge: 'cut' };
    if (!M) return straight;
    const ax = A.x, az = A.z, bx = M.x, bz = M.z, cx = B.x, cz = B.z;
    const d = 2 * (ax * (bz - cz) + bx * (cz - az) + cx * (az - bz)), chord = Math.hypot(B.x - A.x, B.z - A.z);
    const sag = Math.abs((B.x - A.x) * (M.z - A.z) - (B.z - A.z) * (M.x - A.x)) / (chord || 1);
    if (Math.abs(d) < 1e-12 || sag < chord * 1e-3) return straight;
    const ux = ((ax * ax + az * az) * (bz - cz) + (bx * bx + bz * bz) * (cz - az) + (cx * cx + cz * cz) * (az - bz)) / d;
    const uz = ((ax * ax + az * az) * (cx - bx) + (bx * bx + bz * bz) * (ax - cx) + (cx * cx + cz * cz) * (bx - ax)) / d;
    const r = Math.hypot(ax - ux, az - uz), ang = (p) => Math.atan2(p.z - uz, p.x - ux);
    const TAU = 2 * Math.PI, mod = (t) => ((t % TAU) + TAU) % TAU;
    const t0 = ang(A), dB = mod(ang(B) - t0), dM = mod(ang(M) - t0);
    return { kind: 'arc', c: { x: ux, z: uz }, U: { x: r, z: 0 }, V: { x: 0, z: r }, t0, t1: dM < dB ? t0 + dB : t0 - (TAU - dB), edge: 'cut' };
  };
  const rev = (pc) => (pc.kind === 'line' ? { ...pc, a: pc.b, b: pc.a } : { ...pc, t0: pc.t1, t1: pc.t0 });
  const cutOf = new Map();
  const getCut = (i, j) => {
    const k = i < j ? `${i}-${j}` : `${j}-${i}`;
    if (!cutOf.has(k)) cutOf.set(k, { from: Math.min(i, j), pc: cutPiece(cuts[Math.min(i, j)].p, cuts[Math.max(i, j)].p) });
    const c = cutOf.get(k);
    return c.from === i ? c.pc : rev(c.pc);
  };
  const sub = (pc, u0, u1) => {
    if (pc.kind === 'line') { const P = (u) => ({ x: pc.a.x + (pc.b.x - pc.a.x) * u, z: pc.a.z + (pc.b.z - pc.a.z) * u }); return { ...pc, a: P(u0), b: P(u1) }; }
    return { ...pc, t0: pc.t0 + (pc.t1 - pc.t0) * u0, t1: pc.t0 + (pc.t1 - pc.t0) * u1 };
  };
  const walk = (ci, cj) => {
    const A = cuts[ci], B = cuts[cj], nP = loop.length;
    if (A.k === B.k && B.u > A.u) return [sub(loop[A.k], A.u, B.u)];
    const out = [sub(loop[A.k], A.u, 1)];
    for (let k = (A.k + 1) % nP; k !== B.k; k = (k + 1) % nP) out.push(loop[k]);
    out.push(sub(loop[B.k], 0, B.u));
    return out;
  };
  const used = new Set(), parts = [];
  for (let s0 = 0; s0 < nC; s0++) {
    if (used.has(s0)) continue;
    const pieces = [];
    let s = s0, guard = 0;
    do {
      used.add(s);
      const e = (s + 1) % nC;
      pieces.push(...walk(s, e));
      pieces.push(getCut(e, partner[e]));
      s = partner[e];
    } while (s !== s0 && ++guard <= nC);
    // its side: the field just inside, at the middle of its first boundary stretch nudged toward its corners' centroid
    const first = pieces[0], mid = pieceAt(first, 0.5);
    const cen = pieces.reduce((acc, pc) => { const p = pieceAt(pc, 0); return { x: acc.x + p.x / pieces.length, z: acc.z + p.z / pieces.length }; }, { x: 0, z: 0 });
    parts.push({ loop: pieces, inside: test({ x: mid.x + (cen.x - mid.x) * 0.15, z: mid.z + (cen.z - mid.z) * 0.15 }) });
  }
  return parts;
}
