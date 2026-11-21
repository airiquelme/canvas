// The world's GRID of cubes, for game interactions (digging, placing), under a ground that looks unchanged.
//
// DATA. The map is the height function (the generator, `base`) plus a sparse list of edited cubes: cube (i, j, k) spans x in
// [i, i + 1) cube, y in [j, j + 1) cube, z in [k, k + 1) cube. A cube is solid when edited solid, else when it is at or below the cube holding the base
// surface at its column's center (the column is filled up to the ground). Nothing else is stored.
// SURFACE. Each column (i, k) has a top: the base surface at its center while untouched; the top of its highest solid cube once
// edited (a dug surface cube leaves the column's top at that cube's floor; a placed cube raises it to the cube's top). The ground
// drawn is H(x, z) = base(x, z) - D(x, z), D the columns' DEFICITS (base at the center minus the top) interpolated between column
// centers by a Catmull-Rom spline (C1, local: 4 x 4 columns, exact at the centers): untouched ground is exactly the old one, a dug
// cube is a smooth rounded hollow (with a slight rim, the spline's overshoot), placed cubes a mound, never a cliff. Caves and
// overhangs would need real 3D surfaces (not a height field): out of scope.
// EDITS return the x, z box they change (the column +- 2 cubes) for terrain.js refresh.

export function makeGrid({ cube, base }) {
  const solid = new Map();   // "i,j,k" -> true (solid) / false (air): edits only
  const deficit = new Map(); // "i,k" -> base at the column's center - its top (columns whose top changed)
  let ex0 = Infinity, ex1 = -Infinity, ez0 = Infinity, ez1 = -Infinity;   // edited columns' box (i, k), for a fast path
  const key = (i, j, k) => `${i},${j},${k}`, ckey = (i, k) => `${i},${k}`;
  const center = (i, k) => ({ x: (i + 0.5) * cube, z: (k + 0.5) * cube });
  const baseTopCube = (i, k) => { const c = center(i, k); return Math.floor(base(c.x, c.z) / cube); };   // the cube holding the surface

  function isSolid(i, j, k) {
    const e = solid.get(key(i, j, k));
    if (e !== undefined) return e;
    return j <= baseTopCube(i, k);   // the column is filled up to (and with) the cube holding its surface
  }
  // The column's top (world y): its highest solid cube's top; the base surface while that is the base's own surface cube.
  function columnTop(i, k) {
    const c = center(i, k), b = base(c.x, c.z), j0 = baseTopCube(i, k);
    let top = null;
    for (let j = j0 + 8; j > j0; j--) if (solid.get(key(i, j, k)) === true) { top = (j + 1) * cube; break; }   // placed above
    if (top === null) {
      if (solid.get(key(i, j0, k)) !== false) top = b;   // its surface cube is there: the smooth surface itself
      else { let j = j0 - 1; while (j > j0 - 64 && !isSolid(i, j, k)) j--; top = (j + 1) * cube; }
    }
    return top;
  }
  function D(x, z) {
    if (!deficit.size) return 0;
    const u = x / cube - 0.5, v = z / cube - 0.5, i0 = Math.floor(u), k0 = Math.floor(v);
    if (i0 + 2 < ex0 || i0 - 1 > ex1 || k0 + 2 < ez0 || k0 - 1 > ez1) return 0;
    const wu = cr(u - i0), wv = cr(v - k0);
    let d = 0;
    for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
      const df = deficit.get(ckey(i0 - 1 + a, k0 - 1 + b));
      if (df) d += df * wu[a] * wv[b];
    }
    return d;
  }
  const H = (x, z) => base(x, z) - D(x, z);
  const touch = (i, k) => {
    const c = center(i, k), df = base(c.x, c.z) - columnTop(i, k);
    if (Math.abs(df) < 1e-9) deficit.delete(ckey(i, k)); else deficit.set(ckey(i, k), df);
    ex0 = Math.min(ex0, i); ex1 = Math.max(ex1, i); ez0 = Math.min(ez0, k); ez1 = Math.max(ez1, k);
    return { x0: (i - 2) * cube, x1: (i + 3) * cube, z0: (k - 2) * cube, z1: (k + 3) * cube };
  };
  const cellOf = (p) => ({ i: Math.floor(p.x / cube), j: Math.floor(p.y / cube), k: Math.floor(p.z / cube) });
  // Dig the column's top cube under a ground point (null if there is nothing to dig); place a cube on top of it.
  function dig(p) {
    const { i, k } = cellOf(p), top = columnTop(i, k), j = Math.ceil(top / cube) - 1;
    if (!isSolid(i, j, k)) return null;
    solid.set(key(i, j, k), false);
    return { box: touch(i, k), cube: { i, j, k }, raised: false };
  }
  function place(p) {
    const { i, k } = cellOf(p), top = columnTop(i, k), j = Math.max(Math.ceil(top / cube), baseTopCube(i, k) + 1);
    solid.set(key(i, j, k), true);
    return { box: touch(i, k), cube: { i, j, k }, raised: true };
  }
  // The first ground point along a ray (origin, unit dir) within maxDist, or null: steps of a quarter cube, then bisection.
  function raycast(o, d, maxDist = 3000) {
    const step = cube / 4;
    let t0 = 0, above = o.y - H(o.x, o.z) > 0;
    if (!above) return null;
    for (let t = step; t <= maxDist; t += step) {
      const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
      if (y - H(x, z) <= 0) {
        let lo = t0, hi = t;
        for (let it = 0; it < 30; it++) { const m = (lo + hi) / 2; if (o.y + d.y * m - H(o.x + d.x * m, o.z + d.z * m) > 0) lo = m; else hi = m; }
        const tt = (lo + hi) / 2;
        return { x: o.x + d.x * tt, y: o.y + d.y * tt, z: o.z + d.z * tt, t: tt };
      }
      t0 = t;
    }
    return null;
  }
  // Replays a saved list of edits ([["i,j,k", solid], ...]: what `edits` returns).
  function load(list) {
    for (const [kk, v] of list || []) {
      const [i, j, k] = kk.split(',').map(Number);
      if (![i, j, k].every(Number.isFinite)) continue;
      solid.set(key(i, j, k), !!v);
      touch(i, k);
    }
  }
  return { cube, H, D, isSolid, columnTop, dig, place, raycast, cellOf, load, edits: () => [...solid.entries()] };
}

// Catmull-Rom weights of the 4 samples around t in [0, 1).
function cr(t) {
  const t2 = t * t, t3 = t2 * t;
  return [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2];
}
