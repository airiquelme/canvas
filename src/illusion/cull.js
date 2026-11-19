// Occlusion culling for the illusion renderer: which objects can be skipped without changing a pixel.
// - Static objects (no `move`) sit in a bounding-sphere tree (`buildBVH`, built once per scene). A node outside the view
//   frustum or behind the eye is skipped with all its objects.
// - The GLOBAL MASK (`makeMask`): the union of the near shapes drawn so far, kept as a grid of TILE design px (and blocks of
//   4 x 4 tiles, for big boxes). A tile holds
//   the farthest depth of a shape whose opaque interior covers it whole (+Infinity: not covered yet). Objects are visited
//   nearest first (a heap keyed by nearest depth, nodes and objects together); one whose screen box lies on tiles that are
//   all covered by something nearer than its own nearest point is hidden and skipped (no sides built, no fill), and so is
//   a tree node in the same position. Conservative: only what is certainly hidden is skipped, so the frame is unchanged
//   (no popping). Only capsules are added to the mask (their screen shape is convex: a tile is covered when its 4 corners
//   are inside).

const LEAF = 8;
export const TILE = 8;

// Points that bound an object's body, each widened by boundRadius(o): the two ends, for a bent tube or ribbon the parallelogram
// A, B, A + V, B + V that holds its half-ellipse (V = bend - midpoint of A, B), for a panel or disc its corners c +- e1 +- e2.
// A static object's are kept (they never change).
export function boundPoints(o) {
  if (o.move) return pointsOf(o);
  return o.boundPts || (o.boundPts = pointsOf(o));
}
export const boundRadius = (o) => (o.kind === 'panel' || o.kind === 'disc' ? 0 : Math.max(o.a.r, o.b.r));
function pointsOf(o) {
  if (o.kind === 'panel' || o.kind === 'disc') {
    const { c, e1, e2 } = o, at = (s1, s2) => ({ x: c.x + s1 * e1.x + s2 * e2.x, y: c.y + s1 * e1.y + s2 * e2.y, z: c.z + s1 * e1.z + s2 * e2.z });
    return [at(1, 1), at(-1, 1), at(-1, -1), at(1, -1)];
  }
  if (!o.bend) return [o.a.c, o.b.c];
  const A = o.a.c, B = o.b.c, S = o.bend;
  const V = { x: S.x - (A.x + B.x) / 2, y: S.y - (A.y + B.y) / 2, z: S.z - (A.z + B.z) / 2 };
  return [A, B, { x: A.x + V.x, y: A.y + V.y, z: A.z + V.z }, { x: B.x + V.x, y: B.y + V.y, z: B.z + V.z }];
}

// Tree of bounding spheres (median split along the longest axis of the objects' centers).
export function buildBVH(objects) {
  const items = objects.map((o) => {
    const r = boundRadius(o), pts = boundPoints(o);
    const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const p of pts) for (const k of ['x', 'y', 'z']) { min[k] = Math.min(min[k], p[k] - r); max[k] = Math.max(max[k], p[k] + r); }
    return { o, min, max, c: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 } };
  });
  return items.length ? split(items) : null;
}

function split(items) {
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  const cmin = { x: Infinity, y: Infinity, z: Infinity }, cmax = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const it of items) for (const k of ['x', 'y', 'z']) {
    min[k] = Math.min(min[k], it.min[k]); max[k] = Math.max(max[k], it.max[k]);
    cmin[k] = Math.min(cmin[k], it.c[k]); cmax[k] = Math.max(cmax[k], it.c[k]);
  }
  const c = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 };
  const node = { c, R: Math.hypot(max.x - min.x, max.y - min.y, max.z - min.z) / 2, count: items.length };
  if (items.length <= LEAF) { node.items = items.map((it) => it.o); return node; }
  const ext = { x: cmax.x - cmin.x, y: cmax.y - cmin.y, z: cmax.z - cmin.z };
  const axis = ext.x >= ext.y && ext.x >= ext.z ? 'x' : ext.y >= ext.z ? 'y' : 'z';
  items.sort((p, q) => p.c[axis] - q.c[axis]);
  const mid = items.length >> 1;
  node.kids = [split(items.slice(0, mid)), split(items.slice(mid))];
  return node;
}

// The view frustum's 4 side planes in camera space (screen x = cx + s X / Z, y = cy - s Y / Z), from the visible rectangle.
// `outside(q, R)`: the sphere (camera-space center q, radius R) is wholly outside one of them.
export function makeFrustum({ s, cx, cy }, view) {
  const planes = [
    [1, 0, -(view.x1 - cx) / s],    //  X - kx1 Z <= 0
    [-1, 0, (view.x0 - cx) / s],    // -X + kx0 Z <= 0
    [0, 1, -(cy - view.y0) / s],    //  Y - ky1 Z <= 0
    [0, -1, (cy - view.y1) / s],    // -Y + ky0 Z <= 0
  ].map(([a, b, c]) => { const n = Math.hypot(a, b, c); return [a / n, b / n, c / n]; });
  return { outside: (q, R) => planes.some(([a, b, c]) => a * q.x + b * q.y + c * q.z > R) };
}

// Screen box of a sphere wholly in front of the eye (q.z - R > 0): X' / Z' over X' in X +- R, Z' in Z +- R is extreme at the
// corners (conservative).
export function sphereBox({ s, cx, cy }, q, R) {
  const zn = q.z - R, zf = q.z + R;
  const xl = Math.min((q.x - R) / zn, (q.x - R) / zf), xh = Math.max((q.x + R) / zn, (q.x + R) / zf);
  const yl = Math.min((q.y - R) / zn, (q.y - R) / zf), yh = Math.max((q.y + R) / zn, (q.y + R) / zf);
  return { x0: cx + s * xl, x1: cx + s * xh, y0: cy - s * yh, y1: cy - s * yl };
}

// Two levels: tiles, and blocks of BLOCK x BLOCK tiles holding their tiles' largest depth (+Infinity while any is uncovered), so a
// big box is tested block by block.
const BLOCK = 4;
// The buffers are kept from frame to frame (refilled, not reallocated) while the view's size stays.
let kept = null;
export function makeMask(view) {
  const cols = Math.max(1, Math.ceil((view.x1 - view.x0) / TILE)), rows = Math.max(1, Math.ceil((view.y1 - view.y0) / TILE));
  const bcols = Math.ceil(cols / BLOCK), brows = Math.ceil(rows / BLOCK);
  if (!kept || kept.cols !== cols || kept.rows !== rows) {
    kept = {
      cols, rows, bcols, brows,
      occ: new Float32Array(cols * rows), bmax: new Float32Array(bcols * brows), corner: new Uint8Array((cols + 1) * (rows + 1)),
    };
  }
  kept.occ.fill(Infinity); kept.bmax.fill(Infinity);
  kept.view = view;
  return kept;
}

// True when every tile under the box (its part on screen) is covered by something nearer than minDepth.
export function maskHides(m, box, minDepth) {
  const v = m.view;
  const i0 = Math.max(0, Math.floor((box.x0 - v.x0) / TILE)), i1 = Math.min(m.cols - 1, Math.floor((box.x1 - v.x0) / TILE));
  const j0 = Math.max(0, Math.floor((box.y0 - v.y0) / TILE)), j1 = Math.min(m.rows - 1, Math.floor((box.y1 - v.y0) / TILE));
  if (i0 > i1 || j0 > j1) return false;
  for (let bj = Math.floor(j0 / BLOCK); bj <= Math.floor(j1 / BLOCK); bj++) {
    const tj0 = bj * BLOCK, tj1 = Math.min(m.rows - 1, tj0 + BLOCK - 1);
    for (let bi = Math.floor(i0 / BLOCK); bi <= Math.floor(i1 / BLOCK); bi++) {
      const ti0 = bi * BLOCK, ti1 = Math.min(m.cols - 1, ti0 + BLOCK - 1);
      if (ti0 >= i0 && ti1 <= i1 && tj0 >= j0 && tj1 <= j1) {   // the whole block is under the box
        if (!(m.bmax[bj * m.bcols + bi] < minDepth)) return false;
        continue;
      }
      for (let j = Math.max(j0, tj0); j <= Math.min(j1, tj1); j++) {
        const row = j * m.cols;
        for (let i = Math.max(i0, ti0); i <= Math.min(i1, ti1); i++) if (!(m.occ[row + i] < minDepth)) return false;
      }
    }
  }
  return true;
}

// Recomputes the blocks over tiles [i0, i1) x [j0, j1).
function updateBlocks(m, i0, i1, j0, j1) {
  for (let bj = Math.floor(j0 / BLOCK); bj <= Math.floor((j1 - 1) / BLOCK); bj++) {
    for (let bi = Math.floor(i0 / BLOCK); bi <= Math.floor((i1 - 1) / BLOCK); bi++) {
      let mx = -Infinity;
      for (let j = bj * BLOCK; j < Math.min(m.rows, bj * BLOCK + BLOCK); j++)
        for (let i = bi * BLOCK; i < Math.min(m.cols, bi * BLOCK + BLOCK); i++) mx = Math.max(mx, m.occ[j * m.cols + i]);
      m.bmax[bj * m.bcols + bi] = mx;
    }
  }
}

// Adds a capsule's opaque interior to the mask: the hull of the screen circles c1, c2 ({ x, y, r }), shrunk by `inset` (its
// antialiased edge). The hull is the union of the discs c(t), r(t) for t in [0, 1]; a point is taken as inside when it is
// inside the disc at its projection's t (a sufficient test).
export function maskAddCapsule(m, c1, c2, maxDepth, inset) {
  const v = m.view, W = m.cols + 1;
  const bx0 = Math.min(c1.x - c1.r, c2.x - c2.r), bx1 = Math.max(c1.x + c1.r, c2.x + c2.r);
  const by0 = Math.min(c1.y - c1.r, c2.y - c2.r), by1 = Math.max(c1.y + c1.r, c2.y + c2.r);
  const ci0 = Math.max(0, Math.ceil((bx0 - v.x0) / TILE)), ci1 = Math.min(m.cols, Math.floor((bx1 - v.x0) / TILE));
  const cj0 = Math.max(0, Math.ceil((by0 - v.y0) / TILE)), cj1 = Math.min(m.rows, Math.floor((by1 - v.y0) / TILE));
  if (ci1 - ci0 < 1 || cj1 - cj0 < 1) return;
  const dx = c2.x - c1.x, dy = c2.y - c1.y, dr = c2.r - c1.r, L2 = dx * dx + dy * dy;
  for (let j = cj0; j <= cj1; j++) {
    const py = v.y0 + j * TILE;
    for (let i = ci0; i <= ci1; i++) {
      const px = v.x0 + i * TILE;
      let t = L2 > 0 ? ((px - c1.x) * dx + (py - c1.y) * dy) / L2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = px - c1.x - t * dx, ey = py - c1.y - t * dy, r = c1.r + t * dr - inset;
      m.corner[j * W + i] = r > 0 && ex * ex + ey * ey <= r * r ? 1 : 0;
    }
  }
  for (let j = cj0; j < cj1; j++) for (let i = ci0; i < ci1; i++) {
    const k = j * W + i;
    if (m.corner[k] && m.corner[k + 1] && m.corner[k + W] && m.corner[k + W + 1]) {
      const t = j * m.cols + i;
      if (maxDepth < m.occ[t]) m.occ[t] = maxDepth;
    }
  }
  updateBlocks(m, ci0, ci1, cj0, cj1);
}

// Adds a bent tube (curve.js: centerline X(th) = M + (A - M) cos th + (S - M) sin th, radius r0 + r1 cos th, th in [0, PI]) to the
// mask by TUBE_DISCS of its cross-section discs. The drawn shape is the exact union of those discs, and each disc is convex, so
// a tile inside one is covered (each disc with its own far depth: its center's depth + r). The hull of two neighboring discs is
// not used: on a bend its straight edge pokes out of the tube's inner side. Tiles that straddle two discs are left unmarked.
const TUBE_DISCS = 16;
export function maskAddTube(m, o, projector, inset) {
  const A = o.a.c, B = o.b.c, S = o.bend;
  const M = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2, z: (A.z + B.z) / 2 };
  const r0 = (o.a.r + o.b.r) / 2, r1 = (o.a.r - o.b.r) / 2;
  for (let k = 0; k < TUBE_DISCS; k++) {
    const th = (Math.PI * k) / (TUBE_DISCS - 1), c = Math.cos(th), s = Math.sin(th);
    const X = { x: M.x + (A.x - M.x) * c + (S.x - M.x) * s, y: M.y + (A.y - M.y) * c + (S.y - M.y) * s, z: M.z + (A.z - M.z) * c + (S.z - M.z) * s };
    const r = r0 + r1 * c, q = projector.projectPoint(X), w = r * q.scale;
    if (w - inset < TILE * 0.71) continue;   // too small to hold a whole tile
    const disc = { x: q.x, y: q.y, r: w };
    maskAddCapsule(m, disc, disc, projector.toCamera(X).z + r, inset);
  }
}

// Adds a convex screen polygon (points in either winding, inside the shape: e.g. its outline's chords) to the mask: a tile is
// covered when its 4 corners are inside, `inset` from every edge.
export function maskAddConvex(m, poly, maxDepth, inset) {
  const n = poly.length;
  if (n < 3) return;
  let area = 0, bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    area += p.x * q.y - q.x * p.y;
    bx0 = Math.min(bx0, p.x); bx1 = Math.max(bx1, p.x); by0 = Math.min(by0, p.y); by1 = Math.max(by1, p.y);
  }
  if (Math.abs(area) < 1e-6) return;
  const sg = Math.sign(area), edges = [];
  for (let i = 0; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n], ex = q.x - p.x, ey = q.y - p.y, l = Math.hypot(ex, ey);
    if (l > 1e-9) edges.push({ px: p.x, py: p.y, nx: (-ey / l) * sg, ny: (ex / l) * sg });   // inward normal
  }
  const v = m.view, W = m.cols + 1;
  const ci0 = Math.max(0, Math.ceil((bx0 - v.x0) / TILE)), ci1 = Math.min(m.cols, Math.floor((bx1 - v.x0) / TILE));
  const cj0 = Math.max(0, Math.ceil((by0 - v.y0) / TILE)), cj1 = Math.min(m.rows, Math.floor((by1 - v.y0) / TILE));
  if (ci1 - ci0 < 1 || cj1 - cj0 < 1) return;
  for (let j = cj0; j <= cj1; j++) {
    const py = v.y0 + j * TILE;
    for (let i = ci0; i <= ci1; i++) {
      const px = v.x0 + i * TILE;
      let inside = 1;
      for (const e of edges) if ((px - e.px) * e.nx + (py - e.py) * e.ny < inset) { inside = 0; break; }
      m.corner[j * W + i] = inside;
    }
  }
  for (let j = cj0; j < cj1; j++) for (let i = ci0; i < ci1; i++) {
    const k = j * W + i;
    if (m.corner[k] && m.corner[k + 1] && m.corner[k + W] && m.corner[k + W + 1]) {
      const t = j * m.cols + i;
      if (maxDepth < m.occ[t]) m.occ[t] = maxDepth;
    }
  }
  updateBlocks(m, ci0, ci1, cj0, cj1);
}

// Binary min-heap of (key, value).
export class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length; k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, top = v[0], key = k.pop(), val = v.pop(), n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= key) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = key; v[i] = val;
    }
    return top;
  }
}
