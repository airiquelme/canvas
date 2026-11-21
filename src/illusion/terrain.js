// Terrain: ground as a hierarchy of floor patches (patch.js), drawn each frame at the coarsest level that is right on screen.
//
// HIERARCHY (a right-triangle bintree over a (2^k + 1)^2 grid, as in RTIN / Martini). A triangle (hypotenuse a-b, right-angle
// corner c) splits at its hypotenuse's middle grid point m into (c, a, m) and (b, c, m); two triangles share each hypotenuse (a
// "diamond"), so they split or merge together. Every triangle at every level is a patch whose sheet curve passes through its
// corners and the height field's values at its edges' midpoints: a coarse triangle is a real, smooth stand-in for its descendants,
// precomputed, not merged per frame.
// ERRORS, per grid point m that splits a diamond, both the largest over the diamond's two triangles and everything finer below:
//   - errGeo[m]: how far the coarse patches are from the height field (shape only). BUILD-TIME REDUCTION: a diamond whose errGeo
//     is under `minErr` (world units) does not split at all (`kids` null; `allKids` kept, so an edit can refine it again): flat or
//     regular ground stays coarse, a dug hole gets the finest level around it;
//   - err[m]: errGeo, and for a diamond whose patches differ in color or tone (a shade border), its radius x colorK: such a
//     diamond merges only when small on screen (a shade border is cut across a coarse patch by an arc, so the cut level needs
//     no finer patches).
// rad[m]: a sphere around m holding the diamond and every finer one in it. All grow toward the root, so a parent always splits
// before a child: any cut of the tree is conforming (no T-junctions, no cracks), as both triangles of a diamond read the same m.
// SELECTION (per frame): from the roots, a triangle splits while err[m] * s / zNear > TOL_PX (s the projection's scale, zNear the
// nearest depth of m's sphere) and its sphere is in the frustum.
// EDITS: `refresh(box)` rebuilds what an edit of the height field touches: the grid points in the box (x, z), every triangle that
// overlaps it (its patch, parts, own error; their ancestors overlap too), the errors of their diamonds, the cut, and the list of
// leaves (grass regrows from the same seeds on the new ground).
import { trianglePatch } from './patch.js';
import { seedOf } from './grass.js';

// partsOf(patch): its lit / shade parts (shadow.js), or omitted. grid: (2^k + 1)^2 points { x, y, z }; H(x, z) the height (its y is
// recomputed from H on a refresh).
export function buildTerrain({ grid, H, colorOf, minErr = 0, colorK = 0.5, partsOf = null }) {
  const n = grid.length - 1, idx = (i, j) => i * (n + 1) + j, N2 = (n + 1) * (n + 1);
  const err = new Float64Array(N2), errGeo = new Float64Array(N2), rad = new Float64Array(N2);
  const P = (v) => grid[v[0]][v[1]];
  const at = (x, z) => ({ x, y: H(x, z), z });
  const mid = (p, q) => at((p.x + q.x) / 2, (p.z + q.z) / 2);
  const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
  const T = { err, errGeo, rad, idx, P, H, n, roots: null, leafNodes: [], patches: [], leaves: 0 };
  const diamonds = new Map();   // m index -> its triangles
  const levels = [];
  const make = (a, b, c, depth, parent) => {
    const node = { a, b, c, depth, parent };
    const xs = [a, b, c].map((v) => P(v));
    node.box = { x0: Math.min(...xs.map((p) => p.x)), x1: Math.max(...xs.map((p) => p.x)), z0: Math.min(...xs.map((p) => p.z)), z1: Math.max(...xs.map((p) => p.z)) };
    node.seed = seedOf(a[0] * 4 + c[0], a[1] * 4 + c[1], b[0] * 4 + b[1] + depth * 7919);
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    if (Number.isInteger(mx) && Number.isInteger(mz)) {
      node.m = [mx, mz];
      node.mi = idx(mx, mz);
      if (!diamonds.has(node.mi)) diamonds.set(node.mi, []);
      diamonds.get(node.mi).push(node);
      node.allKids = [make(c, a, node.m, depth + 1, node), make(b, c, node.m, depth + 1, node)];
    } else node.allKids = null;
    node.kids = node.allKids;
    (levels[depth] || (levels[depth] = [])).push(node);
    return node;
  };
  T.roots = [make([0, 0], [n, n], [n, 0], 0, null), make([n, n], [0, 0], [0, n], 0, null)];
  const SAMPLES = [[0.5, 0.5], [0.25, 0.25], [0.5, 0.25], [0.25, 0.5], [0.125, 0.125], [0.75, 0.125], [0.125, 0.75], [0.375, 0.375]];
  // One triangle's patch, parts, color and own error (shape), from the current heights.
  const buildNode = (node) => {
    const A = P(node.a), B = P(node.b), C = P(node.c);
    const o = trianglePatch([A, B, C], [mid(A, B), mid(B, C), mid(C, A)], null);
    o.node = node;
    o.seed = node.seed;
    o.fill = colorOf(o.mid);
    if (partsOf) o.parts = partsOf(o);
    node.patch = o;
    let e = 0;
    for (const [u, v] of SAMPLES) {
      const x = A.x + (B.x - A.x) * u + (C.x - A.x) * v, z = A.z + (B.z - A.z) * u + (C.z - A.z) * v;
      const lx = x - o.ox, lz = z - o.oz, q = o.q;
      e = Math.max(e, Math.abs(q[0] * lx * lx + q[1] * lx * lz + q[2] * lz * lz + q[3] * lx + q[4] * lz + q[5] - H(x, z)));
    }
    node.errOwn = e;
    const M = o.mid;
    node.R = Math.max(...[A, B, C].map((p) => Math.hypot(p.x - M.x, p.z - M.z)));
  };
  const toneOf = (p) => (!p.parts ? 'l' : p.parts.length === 1 ? (p.parts[0].shade ? 's' : 'l') + (p.parts[0].fill || '') + (p.parts[0].lamp ? p.parts[0].lamp.level : '') : null);
  // Uniform: one color and tone, and so are all its descendants (with the same ones).
  const uniformOf = (node) => {
    if (!node.allKids) return toneOf(node.patch) !== null;
    const [k0, k1] = node.allKids, t = toneOf(node.patch);
    return k0.uniform && k1.uniform && t !== null && node.patch.fill === k0.patch.fill && node.patch.fill === k1.patch.fill &&
      t === toneOf(k0.patch) && t === toneOf(k1.patch);
  };
  // A diamond's errors and sphere, from its triangles and their children (deepest first, so the children's are final).
  const diamondErr = (mi) => {
    let eg = 0, e = 0, r = 0;
    const M = grid[Math.floor(mi / (n + 1))][mi % (n + 1)];
    for (const node of diamonds.get(mi)) {
      const A = P(node.a), B = P(node.b), C = P(node.c);
      const rn = Math.max(dist(M, A), dist(M, B), dist(M, C)) + node.errOwn;
      eg = Math.max(eg, node.errOwn);
      e = Math.max(e, node.errOwn, node.uniform ? 0 : rn * colorK);
      r = Math.max(r, rn);
      for (const k of node.allKids) if (k.m) {
        eg = Math.max(eg, errGeo[k.mi]); e = Math.max(e, err[k.mi]);
        r = Math.max(r, rad[k.mi] + dist(M, P(k.m)));
      }
    }
    errGeo[mi] = eg; err[mi] = e; rad[mi] = r;
  };
  // The cut (build-time reduction), the leaves, the list of patches.
  const finish = () => {
    const leaves = [], all = [];
    const walk = (node) => {
      node.kids = node.allKids && errGeo[node.mi] >= minErr ? node.allKids : null;
      all.push(node.patch);
      if (node.kids) node.kids.forEach(walk); else leaves.push(node);
    };
    T.roots.forEach(walk);
    T.leafNodes = leaves; T.patches = all; T.leaves = leaves.length;
  };
  // Rebuild what overlaps the x, z box (null: everything); shadeBox: where shade parts must be redone too (a raised edit's shadow
  // reaches beyond it).
  T.refresh = (box = null, shadeBox = box) => {
    const hit = (b, q) => !q || (b.x1 >= q.x0 && b.x0 <= q.x1 && b.z1 >= q.z0 && b.z0 <= q.z1);
    if (box) for (const row of grid) for (const p of row) if (p.x >= box.x0 && p.x <= box.x1 && p.z >= box.z0 && p.z <= box.z1) p.y = H(p.x, p.z);
    const touched = [];
    for (let d = levels.length - 1; d >= 0; d--) for (const node of levels[d]) {
      if (hit(node.box, box)) { buildNode(node); touched.push(node); }
      else if (partsOf && shadeBox && hit(node.box, shadeBox)) { node.patch.parts = partsOf(node.patch); touched.push(node); }
      else continue;
      node.uniform = uniformOf(node);
    }
    // Diamonds of touched triangles and of their ancestors (their flags and errors depend on them), deepest first.
    const ms = new Set();
    for (const node of touched) for (let a = node; a; a = a.parent) { if (a.m) ms.add(a.mi); }
    const anc = new Set();
    for (const node of touched) for (let a = node.parent; a; a = a.parent) anc.add(a);
    [...anc].sort((p, q) => q.depth - p.depth).forEach((a) => { a.uniform = uniformOf(a); });
    const order = [...ms].sort((p, q) => diamonds.get(q)[0].depth - diamonds.get(p)[0].depth);
    for (const mi of order) diamondErr(mi);
    for (const node of touched) if (!node.allKids || node.kids === null) node.gen = null;   // grass regrows on the new ground (same seeds)
    finish();
  };
  T.refresh(null);
  return T;
}

// The patches to draw this frame: tol in design px, persp the projection, toCamera, frustum (cull.js). Stamps each with `sel`.
export function selectTerrain(T, { toCamera, persp, frustum, tol, stamp, near = 1 }) {
  const out = [];
  const visit = (node) => {
    const o = node.patch;
    if (node.kids) {
      const mi = node.mi, q = toCamera(T.P(node.m)), R = T.rad[mi];
      if (q.z + R <= near || frustum.outside(q, R)) return;   // wholly behind the eye, or off screen
      const z = q.z - R;
      if (z <= near || (T.err[mi] * persp.s) / z > tol) { node.kids.forEach(visit); return; }
    }
    o.sel = stamp;
    out.push(o);
  };
  T.roots.forEach(visit);
  return out;
}
