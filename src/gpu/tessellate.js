// A shape's loops (sides: lines and ellipse arcs, shape.js) as triangles for STENCIL-THEN-COVER, with its arcs EXACT:
//
//   - every arc is cut into pieces of at most MAX_SWEEP of its parameter; each loop is a FAN of triangles from its first point over
//     its chord polygon (corners and arc piece ends), and each arc piece from A to B, with C where the tangents at A and B meet, is
//     a CURVE TRIANGLE (A, C, B) whose corners carry their coordinates in the ellipse's unit-circle frame: (cos t, sin t) at A and B,
//     (cos m, sin m) / cos(h) at C (m the middle parameter, h half the sweep). The map from that frame to the screen is affine, so
//     the fragment's interpolated (u, v) are exact and u^2 + v^2 = 1 is the ellipse itself; the fragment keeps u^2 + v^2 <= 1;
//   - the stencil counts the winding (up for triangles facing one way, down for the other): the fan gives the chord polygon's
//     winding, and a curve triangle adds or removes its segment by its own facing, so an arc bulging out of the loop adds it and
//     one bulging in removes it, with no classification. Nonzero winding = filled, exactly a canvas's nonzero rule, for any loop
//     (thin bands, cusps, loops crossing themselves or each other).
//
// Per vertex: x, y (design px), u, v, mode (0 fan, 1 curve).

const MAX_SWEEP = Math.PI / 4;

// Growing interleaved Float32 buffer.
export class Sink {
  constructor(stride, n = 1 << 15) { this.stride = stride; this.f = new Float32Array(n * stride); this.n = 0; }
  reserve(k) {
    if ((this.n + k) * this.stride <= this.f.length) return;
    let m = this.f.length;
    while ((this.n + k) * this.stride > m) m *= 2;
    const g = new Float32Array(m); g.set(this.f.subarray(0, this.n * this.stride)); this.f = g;
  }
  clear() { this.n = 0; }
}

// Scratch buffers (no allocation per piece): the triangles being written, [x, y, u, v, mode] per vertex, and a loop's chord polygon.
// T is an ARENA: every piece tessellated in a frame stays in it (from `beginFrame()` on) and its triangles are a view of it, so the
// planner reads them without a copy; a cached piece gets its own copy.
let T = new Float32Array(1 << 18), tn = 0, t0 = 0;
export function beginFrame() { tn = 0; }
let PX = new Float64Array(1024), PY = new Float64Array(1024), pn = 0;
let bx0 = 0, by0 = 0, bx1 = 0, by1 = 0;
// (tests: `tessellate` also writes float64 copies, D)
let F64 = false, D = new Float64Array(1 << 14), dn = 0;
const put = (x, y, u, v, m) => {
  if (F64) { if (dn + 5 > D.length) { const g = new Float64Array(D.length * 2); g.set(D); D = g; } D[dn] = x; D[dn + 1] = y; D[dn + 2] = u; D[dn + 3] = v; D[dn + 4] = m; dn += 5; }
  if (tn + 5 > T.length) { const g = new Float32Array(T.length * 2); g.set(T); T = g; }   // (earlier views stay valid: old buffer)
  T[tn] = x; T[tn + 1] = y; T[tn + 2] = u; T[tn + 3] = v; T[tn + 4] = m; tn += 5;
  if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
};
const poly = (x, y) => {
  if (pn >= PX.length) { const gx = new Float64Array(PX.length * 2), gy = new Float64Array(PX.length * 2); gx.set(PX); gy.set(PY); PX = gx; PY = gy; }
  PX[pn] = x; PY[pn] = y; pn++;
};

// A piece's triangles in its own frame ({ tris: Float32Array [x, y, u, v, mode] per vertex, box: [x0, y0, x1, y1] }), cached on it
// when `cache` (kept pieces, reused references).
export function trianglesOf(shape, cache = false) {
  if (cache && shape.gpu) return shape.gpu;
  run(shape.sides);
  const view = T.subarray(t0, tn);
  const r = { tris: cache ? view.slice() : view, box: tn > t0 ? [bx0, by0, bx1, by1] : [0, 0, 0, 0] };
  if (cache) shape.gpu = r;
  return r;
}

// The triangles as a plain (float64) array, [x, y, u, v, mode] per vertex (tests).
export function tessellate(sides) {
  tn = 0;
  F64 = true; run(sides); F64 = false;
  return Array.from(D.subarray(0, dn));
}

function run(sides) {
  t0 = tn; dn = 0; bx0 = by0 = Infinity; bx1 = by1 = -Infinity;
  let start = 0;
  for (let i = 1; i <= sides.length; i++) if (i === sides.length || sides[i].move) { tessellateLoop(sides, start, i); start = i; }
}

function tessellateLoop(sides, i0, i1) {
  pn = 0;
  for (let i = i0; i < i1; i++) {
    const s = sides[i];
    if (s.kind === 'line') {
      poly(s.from.x, s.from.y);
      const nx = sides[i + 1 < i1 ? i + 1 : i0];   // its end, when the next side starts elsewhere (a canvas joins them)
      let sx, sy;
      if (nx.kind === 'line') { sx = nx.from.x; sy = nx.from.y; }
      else { const e = nx.e, ca = Math.cos(e.angle), sa = Math.sin(e.angle), c = Math.cos(nx.t0) * e.a, sn = Math.sin(nx.t0) * e.b; sx = e.x + c * ca - sn * sa; sy = e.y + c * sa + sn * ca; }
      if (Math.abs(sx - s.to.x) > 1e-12 || Math.abs(sy - s.to.y) > 1e-12) poly(s.to.x, s.to.y);
      continue;
    }
    const e = s.e, sweep = s.t1 - s.t0, ca = Math.cos(e.angle), sa = Math.sin(e.angle);
    const X = (cu, sv) => e.x + cu * e.a * ca - sv * e.b * sa, Y = (cu, sv) => e.y + cu * e.a * sa + sv * e.b * ca;
    if (!(Math.abs(sweep) > 1e-12) || !(e.a > 0) || !(e.b > 0)) { const c = Math.cos(s.t0), sn = Math.sin(s.t0); poly(X(c, sn), Y(c, sn)); continue; }
    const n = Math.max(1, Math.ceil(Math.abs(sweep) / MAX_SWEEP)), step = sweep / n, kk = 1 / Math.cos(Math.abs(step) / 2);
    let ca0 = Math.cos(s.t0), sa0 = Math.sin(s.t0);
    for (let k = 0; k < n; k++) {
      const tb = s.t0 + step * (k + 1), m = s.t0 + step * (k + 0.5);
      const cb = Math.cos(tb), sb = Math.sin(tb), uc = Math.cos(m) * kk, vc = Math.sin(m) * kk;
      const ax = X(ca0, sa0), ay = Y(ca0, sa0);
      put(ax, ay, ca0, sa0, 1); put(X(uc, vc), Y(uc, vc), uc, vc, 1); put(X(cb, sb), Y(cb, sb), cb, sb, 1);
      poly(ax, ay);
      if (k === n - 1) poly(X(cb, sb), Y(cb, sb));   // its end (the next side may start elsewhere: a canvas joins them by a line)
      ca0 = cb; sa0 = sb;
    }
  }
  for (let i = 1; i + 1 < pn; i++) { put(PX[0], PY[0], 0, 0, 0); put(PX[i], PY[i], 0, 0, 0); put(PX[i + 1], PY[i + 1], 0, 0, 0); }
}

const ept = (e, t) => {
  const ca = Math.cos(e.angle), sa = Math.sin(e.angle), c = Math.cos(t) * e.a, s = Math.sin(t) * e.b;
  return { x: e.x + c * ca - s * sa, y: e.y + c * sa + s * ca };
};

// The sides split into loops (a side with `move` starts a new one).
function loopsOf(sides) {
  const loops = [];
  let cur = null;
  sides.forEach((s, i) => { if (i === 0 || s.move) { cur = []; loops.push(cur); } cur.push(s); });
  return loops;
}

// Exact signed area of the loops of a shape (shoelace over the chords plus each arc's segment), for tests. As on a canvas, a side
// that does not start where the previous one ended is joined to it by a straight line (and each loop is closed the same way).
export function exactArea(sides) {
  let a = 0;
  const cross = (p, q) => p.x * q.y - q.x * p.y;
  for (const loop of loopsOf(sides)) {
    let first = null, prev = null;
    for (const s of loop) {
      const A = s.kind === 'line' ? s.from : ept(s.e, s.t0), B = s.kind === 'line' ? s.to : ept(s.e, s.t1);
      if (prev) a += cross(prev, A); else first = A;
      if (s.kind === 'line') a += cross(A, B);
      else {
        // integral of x dy - y dx along c + R D q(t): c x (B - A) + a b (t1 - t0)  (R a rotation, D = diag(a, b))
        const e = s.e;
        a += e.x * (B.y - A.y) - e.y * (B.x - A.x) + e.a * e.b * (s.t1 - s.t0);
      }
      prev = B;
    }
    if (prev) a += cross(prev, first);
  }
  return a / 2;
}

// The winding-weighted area the stencil counts (for tests): every triangle signed by its facing, a curve triangle's by the area of
// its elliptic segment (the unit circle's segment h2 - sin(h2), scaled by the triangle's own screen / unit area ratio).
export function windingArea(tris) {
  let a = 0;
  for (let i = 0; i < tris.length; i += 15) {
    const ax = tris[i], ay = tris[i + 1], bx = tris[i + 5], by = tris[i + 6], cx = tris[i + 10], cy = tris[i + 11];
    const tri = ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;   // signed
    if (tris[i + 4] === 0) { a += tri; continue; }
    const ua = tris[i + 2], va = tris[i + 3], uc = tris[i + 7], vc = tris[i + 8], ub = tris[i + 12], vb = tris[i + 13];
    const th = Math.abs(Math.atan2(ua * vb - va * ub, ua * ub + va * vb)), h = th / 2;
    // the unit triangle (chord 2 sin h, height 1 / cos h - cos h) and segment, in forms with no cancellation for tiny sweeps
    const triU = Math.sin(h) ** 3 / Math.cos(h);
    const seg = th < 1e-2 ? (th ** 3 / 6 - th ** 5 / 120 + th ** 7 / 5040) / 2 : (th - Math.sin(th)) / 2;
    void uc; void vc;
    a += tri * seg / triU;
  }
  return a;
}
