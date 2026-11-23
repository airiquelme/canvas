// Sun shade on the ground, in WORLD space (the same from every angle): one field for both a hill's own far side and the shadow it
// casts on the ground behind it.
//
// FIELD. The sun is directional and the ground a height field H, so whether a ground point is in shade does not depend on the
// camera. Sweep lines run across the ground along the sun's horizontal direction, starting on the sun's side; along each, the
// "shadow line" height falls by tan(elevation) per unit and is raised to the ground wherever the ground is higher:
// SL = max(SL - ds tanE, H). A point is in shade where the ground is below it. Stored on that rotated grid and read bilinearly:
// depth(x, z) = the INCOMING shadow line (SL - ds tanE, before the max) minus H: SL - H in shade (> 0), and on lit ground how far
// the ground stands above the line (< 0). Signed and continuous across the border, so the border read back (depth = EPS) runs
// smoothly between the grid points; storing SL - H itself (0 exactly on lit ground) put it on a staircase along the grid's cells.
// A slope facing away from the sun falls below its crest's shadow line, so a hill's own shade side and its cast shadow are one
// region, joined at the terminator.
// SPLIT. Each floor patch (a triangle) is cut along the field's border: the border's crossings of its edges by bisection (cached
// per edge, so two neighbors, and every level of the terrain, cut a shared edge at the same point), and inside, a circle arc in
// x, z through both crossings and the border's point on the chord's perpendicular bisector (a line where they are in line). Parts:
// [{ loop, shade }], each a loop of patch pieces (patch.js) whose sides on the triangle's edges keep that edge's index and whose
// cut is tagged 'cut'.

const EPS = 0.25;   // world units of depth below which a point counts as lit

export function buildShadowField({ H, x0, x1, z0, z1, dir, res = 512 }) {
  const hl = Math.hypot(dir.x, dir.z);
  if (dir.y <= 0) return { all: true };   // the sun is down: everything in shade
  if (hl < 1e-6) return { none: true };   // overhead: nothing
  const ux = dir.x / hl, uz = dir.z / hl, vx = -uz, vz = ux, tanE = dir.y / hl;   // u toward the sun, v across
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
  for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) {
    const u = (x - cx) * ux + (z - cz) * uz, v = (x - cx) * vx + (z - cz) * vz;
    umin = Math.min(umin, u); umax = Math.max(umax, u); vmin = Math.min(vmin, v); vmax = Math.max(vmax, v);
  }
  const ds = Math.max(umax - umin, vmax - vmin) / res, nu = Math.ceil((umax - umin) / ds) + 1, nv = Math.ceil((vmax - vmin) / ds) + 1;
  const depth = new Float32Array(nu * nv);
  const t0 = performance.now();
  const sweep = (j) => {
    const v = vmin + j * ds;
    let SL = -Infinity;
    for (let i = 0; i < nu; i++) {   // i = 0 on the sun's side (u = umax)
      const u = umax - i * ds, x = cx + u * ux + v * vx, z = cz + u * uz + v * vz, h = H(x, z), inc = SL - ds * tanE;
      SL = Math.max(inc, h);
      depth[j * nu + i] = Math.max(inc - h, -1e4);   // (the first point: no line yet)
    }
  };
  for (let j = 0; j < nv; j++) sweep(j);
  // After an edit of the ground in an x, z box: redo the sweep lines that cross it (a line's shade depends only on the ground
  // along it, upwind).
  const update = (box) => {
    let a = Infinity, b = -Infinity;
    for (const [x, z] of [[box.x0, box.z0], [box.x1, box.z0], [box.x0, box.z1], [box.x1, box.z1]]) {
      const v = (x - cx) * vx + (z - cz) * vz; a = Math.min(a, v); b = Math.max(b, v);
    }
    for (let j = Math.max(0, Math.floor((a - vmin) / ds) - 1); j <= Math.min(nv - 1, Math.ceil((b - vmin) / ds) + 1); j++) sweep(j);
    field.version++;
  };
  const at = (x, z) => {
    const u = (x - cx) * ux + (z - cz) * uz, v = (x - cx) * vx + (z - cz) * vz;
    const fi = (umax - u) / ds, fj = (v - vmin) / ds;
    const i = Math.max(0, Math.min(nu - 2, Math.floor(fi))), j = Math.max(0, Math.min(nv - 2, Math.floor(fj)));
    const a = Math.max(0, Math.min(1, fi - i)), b = Math.max(0, Math.min(1, fj - j));
    const k = j * nu + i;
    return (depth[k] * (1 - a) + depth[k + 1] * a) * (1 - b) + (depth[k + nu] * (1 - a) + depth[k + nu + 1] * a) * b;
  };
  // Whether a world point (above the ground too) is in shade: below the shadow line there.
  const point = (p) => at(p.x, p.z) + H(p.x, p.z) > p.y + EPS;
  // grid: the field itself, for a GPU that reads it per pixel (webgl2.js): depth[j nu + i] at u = umax - i ds, v = vmin + j ds;
  // version: bumped by every update (re-upload)
  const field = { at, point, update, ms: performance.now() - t0, ux, uz, tanE, version: 0, grid: { depth, nu, nv, cx, cz, ux, uz, umax, vmin, ds, eps: EPS } };
  return field;
}

const shaded = (F, p) => F.all || (!F.none && F.at(p.x, p.z) > EPS);

// The crossings of the field's border along the world segment p -> q, as u in (0, 1), cached by edge.
function crossings(F, p, q, cache) {
  const ka = `${Math.round(p.x * 100)},${Math.round(p.z * 100)}`, kb = `${Math.round(q.x * 100)},${Math.round(q.z * 100)}`;
  const flip = kb < ka, key = flip ? kb + '|' + ka : ka + '|' + kb;
  let us = cache.get(key);
  if (!us) {
    const A = flip ? q : p, B = flip ? p : q, pt = (u) => ({ x: A.x + (B.x - A.x) * u, z: A.z + (B.z - A.z) * u });
    const n = Math.max(4, Math.ceil(Math.hypot(B.x - A.x, B.z - A.z) / 6));
    us = [];
    let ua = 0, sa = shaded(F, pt(0));
    for (let k = 1; k <= n; k++) {
      const ub = k / n, sb = shaded(F, pt(ub));
      if (sa !== sb) {
        let lo = ua, hi = ub;
        for (let it = 0; it < 30; it++) { const m = (lo + hi) / 2; if (shaded(F, pt(m)) === sa) lo = m; else hi = m; }
        us.push((lo + hi) / 2);
      }
      ua = ub; sa = sb;
    }
    cache.set(key, us);
  }
  return flip ? us.map((u) => 1 - u).reverse() : us;
}

// A floor patch's parts under the field (a triangle patch: o.loop are 3 lines, local x, z). [{ loop, shade }].
export function splitPatch(o, F, cache) {
  const W = (p) => ({ x: p.x + o.ox, z: p.z + o.oz }), Lc = (p) => ({ x: p.x - o.ox, z: p.z - o.oz });
  const loop = o.loop;
  if (F.all || F.none || loop.some((pc) => pc.kind !== 'line')) return [{ loop, shade: !!F.all }];
  // Crossings around the loop: { k (edge), u, p (local) }.
  const cuts = [];
  loop.forEach((pc, k) => { for (const u of crossings(F, W(pc.a), W(pc.b), cache)) cuts.push({ k, u, p: { x: pc.a.x + (pc.b.x - pc.a.x) * u, z: pc.a.z + (pc.b.z - pc.a.z) * u } }); });
  if (cuts.length < 2 || cuts.length % 2) {   // whole (an island inside it is left out)
    const c = { x: (loop[0].a.x + loop[1].a.x + loop[2].a.x) / 3, z: (loop[0].a.z + loop[1].a.z + loop[2].a.z) / 3 };
    const votes = loop.filter((pc) => shaded(F, W(pc.a))).length + (shaded(F, W(c)) ? 1 : 0);
    return [{ loop, shade: votes >= 2 }];
  }
  // The border's point on the perpendicular bisector of A B (searched both ways, up to half the chord), or null. (A blob entering
  // through one edge can bulge farther than that: the cut then falls back to the chord. Searching up to 1.5 chords found other
  // stretches of the border instead and made things worse; that case needs the border traced through the field's cells.)
  const borderNear = (A, B) => {
    const m = { x: (A.x + B.x) / 2, z: (A.z + B.z) / 2 }, n = { x: -(B.z - A.z) / 2, z: (B.x - A.x) / 2 };
    const at = (s) => ({ x: m.x + n.x * s, z: m.z + n.z * s }), sm = shaded(F, W(m));
    for (const sgn of [1, -1]) {   // search the perpendicular both ways for the border
      let lo = 0, found = null;
      for (let k = 1; k <= 8 && !found; k++) { const s = (sgn * k) / 8; if (shaded(F, W(at(s))) !== sm) found = [lo, s]; else lo = s; }
      if (found) {
        let [a, b] = found;
        for (let it = 0; it < 30; it++) { const c = (a + b) / 2; if (shaded(F, W(at(c))) === sm) a = c; else b = c; }
        return at((a + b) / 2);
      }
    }
    // (the chord's middle itself on the border: no sign change either way)
    return null;
  };
  // The cut from crossing A to B: a CHAIN of pieces. One circle arc through A, the border's middle point M and B, kept when the
  // border near the middles of A M and M B lies within CUT_TOL of it; else the two halves, each its own chain (up to 3 levels).
  // (A single arc missed a shadow blob's curving tip inside a patch: a third of the patch in the wrong tone.)
  const cutChain = (A, B, depth = 0) => {
    const M = borderNear(A, B);
    if (!M) return [{ kind: 'line', a: A, b: B, edge: 'cut' }];
    const pc = cutPiece(A, M, B);
    if (depth < 3) {
      const chord = Math.hypot(B.x - A.x, B.z - A.z), tol = Math.max(0.5, chord * 0.01);
      const off = (P) => (!P ? 0 : pc.kind === 'line' ? Math.abs((B.x - A.x) * (P.z - A.z) - (B.z - A.z) * (P.x - A.x)) / (chord || 1) : Math.abs(Math.hypot(P.x - pc.c.x, P.z - pc.c.z) - pc.U.x));
      if (off(borderNear(A, M)) > tol || off(borderNear(M, B)) > tol) return [...cutChain(A, M, depth + 1), ...cutChain(M, B, depth + 1)];
    }
    return [pc];
  };
  // The circle arc (in x, z) from A through M to B, or the line A B where they are nearly in line.
  const cutPiece = (A, M, B) => {
    // Circle through A, M, B (in x, z).
    const ax = A.x, az = A.z, bx = M.x, bz = M.z, cx = B.x, cz = B.z;
    const d = 2 * (ax * (bz - cz) + bx * (cz - az) + cx * (az - bz));
    const chord = Math.hypot(B.x - A.x, B.z - A.z);
    const sag = Math.abs((B.x - A.x) * (M.z - A.z) - (B.z - A.z) * (M.x - A.x)) / (chord || 1);
    if (Math.abs(d) < 1e-12 || sag < chord * 1e-3) return { kind: 'line', a: A, b: B, edge: 'cut' };
    const ux = ((ax * ax + az * az) * (bz - cz) + (bx * bx + bz * bz) * (cz - az) + (cx * cx + cz * cz) * (az - bz)) / d;
    const uz = ((ax * ax + az * az) * (cx - bx) + (bx * bx + bz * bz) * (ax - cx) + (cx * cx + cz * cz) * (bx - ax)) / d;
    const r = Math.hypot(ax - ux, az - uz), ang = (p) => Math.atan2(p.z - uz, p.x - ux);
    const TAU = 2 * Math.PI, mod = (t) => ((t % TAU) + TAU) % TAU;
    const t0 = ang(A), dB = mod(ang(B) - t0), dM = mod(ang(M) - t0);
    const t1 = dM < dB ? t0 + dB : t0 - (TAU - dB);
    return { kind: 'arc', c: { x: ux, z: uz }, U: { x: r, z: 0 }, V: { x: 0, z: r }, t0, t1, edge: 'cut' };
  };
  const rev = (pc) => (pc.kind === 'line' ? { ...pc, a: pc.b, b: pc.a } : { ...pc, t0: pc.t1, t1: pc.t0 });
  const revChain = (ch) => ch.slice().reverse().map(rev);
  // Walk the triangle's boundary from crossing i to crossing j (forward), as pieces.
  const nC = cuts.length;
  const walk = (ci, cj) => {
    const A = cuts[ci], B = cuts[cj], out = [];
    const part = (k, pa, pb) => { if (Math.hypot(pb.x - pa.x, pb.z - pa.z) > 1e-9) out.push({ kind: 'line', a: pa, b: pb, edge: k }); };
    if (A.k === B.k && B.u > A.u) { part(A.k, A.p, B.p); return out; }
    part(A.k, A.p, loop[A.k].b);
    for (let k = (A.k + 1) % 3; k !== B.k; k = (k + 1) % 3) part(k, loop[k].a, loop[k].b);
    part(B.k, loop[B.k].a, B.p);
    return out;
  };
  // Regions: each boundary stretch between consecutive crossings, closed by the cuts of the pairing (crossing a + off with
  // a + off + 1: the two ways of pairing neighbors without crossing chords).
  const build = (off) => {
  const partner = new Array(nC);
  for (let a = 0; a < nC; a += 2) { const i = (a + off) % nC, j = (a + off + 1) % nC; partner[i] = j; partner[j] = i; }
  const cutOf = new Map();
  const getCut = (i, j) => { const k = i < j ? `${i}-${j}` : `${j}-${i}`; if (!cutOf.has(k)) cutOf.set(k, { from: Math.min(i, j), ch: cutChain(cuts[Math.min(i, j)].p, cuts[Math.max(i, j)].p) }); const c = cutOf.get(k); return c.from === i ? c.ch : revChain(c.ch); };
  const used = new Set(), parts = [];
  for (let s0 = 0; s0 < nC; s0++) {
    if (used.has(s0)) continue;
    const pieces = [];
    let s = s0, guard = 0;
    do {
      used.add(s);
      const e = (s + 1) % nC;
      pieces.push(...walk(s, e));
      const p = partner[e];
      pieces.push(...getCut(e, p));
      s = p;
    } while (s !== s0 && ++guard < nC);
    // Its tone: the field at the middle of its longest stretch of the triangle's edges. Between two consecutive crossings an edge
    // is on one side of the border (that is how the crossings were found), so that point has the region's tone. (Nudged 20% toward
    // the region's rough centroid, as before, it could land past a curved cut: a thin strip between a cut and an edge, its
    // centroid outside it, took the other part's tone and was drawn lit inside the shade, up to the patch's straight edges.)
    let b0 = null, bl = -1;
    for (const pc of pieces) if (pc.kind === 'line' && pc.edge !== 'cut') { const l = Math.hypot(pc.b.x - pc.a.x, pc.b.z - pc.a.z); if (l > bl) { bl = l; b0 = pc; } }
    let probe;
    if (b0) probe = { x: (b0.a.x + b0.b.x) / 2, z: (b0.a.z + b0.b.z) / 2 };
    else {   // (no edge stretch: the centroid of its corners)
      const pts = pieces.map((pc) => pc.a || { x: pc.c.x + pc.U.x * Math.cos(pc.t0), z: pc.c.z + pc.V.z * Math.sin(pc.t0) });
      probe = pts.reduce((acc, p) => ({ x: acc.x + p.x / pts.length, z: acc.z + p.z / pts.length }), { x: 0, z: 0 });
    }
    parts.push({ loop: pieces, shade: shaded(F, W(probe)) });
  }
  return parts;
  };
  // PAIRING (4+ crossings): both, and the one whose parts' tones agree with the field at more points of the triangle. (The shorter
  // chords, chosen before, joined a shadow blob's two lit sides across it and drew most of the blob lit.)
  let parts = build(0);
  if (nC > 2) {
    const other = build(1);
    if (mismatches(other, loop, F, W) < mismatches(parts, loop, F, W)) parts = other;
  }
  // Lit parts first (their cut is underpainted before the shade parts are drawn over it).
  return parts.sort((a, b) => a.shade - b.shade);
}

// How many of a grid of points inside the triangle (`loop`, local x, z) lie in a part whose tone differs from the field there.
function mismatches(parts, loop, F, W) {
  const polys = parts.map((p) => {
    const pts = [];
    for (const pc of p.loop) {
      if (pc.kind === 'line') pts.push(pc.a);
      else for (let i = 0; i < 12; i++) { const t = pc.t0 + ((pc.t1 - pc.t0) * i) / 12; pts.push({ x: pc.c.x + pc.U.x * Math.cos(t) + pc.V.x * Math.sin(t), z: pc.c.z + pc.U.z * Math.cos(t) + pc.V.z * Math.sin(t) }); }
    }
    return pts;
  });
  const inside = (P, q) => {
    let w = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const a = P[i], b = P[j];
      if ((a.z > q.z) !== (b.z > q.z) && q.x < a.x + ((q.z - a.z) * (b.x - a.x)) / (b.z - a.z)) w = !w;
    }
    return w;
  };
  const A = loop[0].a, B = loop[1].a, C = loop[2].a, K = 9;
  let bad = 0;
  for (let i = 0; i < K; i++) for (let j = 0; i + j < K; j++) {
    const u = (i + 0.33) / K, v = (j + 0.33) / K;
    const q = { x: A.x + (B.x - A.x) * u + (C.x - A.x) * v, z: A.z + (B.z - A.z) * u + (C.z - A.z) * v };
    const k = polys.findIndex((P) => inside(P, q));
    if (k >= 0 && parts[k].shade !== shaded(F, W(q))) bad++;
  }
  return bad;
}
