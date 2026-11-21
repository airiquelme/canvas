// The meadow (the default scene): rolling ground as a terrain hierarchy (terrain.js) of floor patches (patch.js), in patches of
// greens.
//
// A (2^k + 1)^2 grid over a height field H (slow waves plus round hills), every inner grid point nudged sideways a little. Every
// triangle of the hierarchy is a floor patch through its corners and H at its edges' midpoints; each frame draws the coarsest level
// that is within half a pixel of the finest. Colors come from a color field per finest triangle; a coarse triangle has its
// descendants' color when they agree (else it only merges when sub-pixel). Seams: the renderer's ground underlay.
import { buildTerrain } from './terrain.js';
import { buildShadowField, splitPatch } from './shadow.js';
import { makeGrid } from './grid.js';
import { lamps, lampParts } from './lamps.js';
import { splitLoop } from './regions.js';
import { light } from './light.js';

const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const GREENS = ['#7cb342', '#8bc34a', '#689f38', '#9ccc65', '#558b2f', '#aed581', '#7fa84a', '#6b9e3a'];

// 2^k x 2^k cells over `size` units, centered on `center` (its y is the mean ground height); `hills` bumps, kept off `clear`
// (x, z offsets from the center, e.g. the camera's start); minErr: diamonds flatter than this (world units) never split; oneColor:
// a single green (to see how far the geometry alone merges).
export function buildMeadow({ center = { x: 500, y: 0, z: 0 }, k = 7, size = 3600, hills = 9, clear = [{ x: 700, z: 0 }], minErr = 0.4, oneColor = true, water, edits = null, colorK, colorCells = 1, movers: movers_ = 10 } = {}) {
  const rand = rng(7), N = 2 ** k, cell = size / N;
  const waves = Array.from({ length: 5 }, (_, i) => {
    const a = rand() * 6.283, L = 2200 / (i + 1.2) * (0.7 + rand() * 0.6);
    return { kx: Math.cos(a) * 6.283 / L, kz: Math.sin(a) * 6.283 / L, amp: 22 / (i + 1) * (0.6 + rand() * 0.8), ph: rand() * 6.283 };
  });
  const bumps = [];
  while (bumps.length < hills) {
    const b = { x: (rand() - 0.5) * size * 0.85, z: (rand() - 0.5) * size * 0.85, r: 150 + rand() * 350 };
    b.h = b.r * (0.25 + rand() * 0.35);
    if (clear.some((q) => Math.hypot(q.x - b.x, q.z - b.z) < b.r + 150)) continue;
    bumps.push(b);
  }
  const Hl = (x, z) => {
    let y = 0;
    for (const w of waves) y += w.amp * Math.sin(w.kx * x + w.kz * z + w.ph);
    for (const b of bumps) {   // a hill: none past 3.5 of its radius (exp(-12) of its height: under a thousandth of a unit)
      const d2 = ((x - b.x) ** 2 + (z - b.z) ** 2) / (b.r * b.r);
      if (d2 < 12.25) y += b.h * Math.exp(-d2);
    }
    return y;
  };
  const Hbase = (x, z) => center.y + Hl(x - center.x, z - center.z);
  // The grid of cubes (grid.js), one per finest cell: the ground drawn is its height (the base, minus the edited columns' deficits).
  const grid = makeGrid({ cube: cell, base: Hbase });
  grid.load(edits);   // saved edits replayed (the map: the generator plus this list)
  // WATER: a level (`water`, default: the 9th percentile of the ground, a few ponds); the ground drawn is the higher of the land and
  // the water, and a patch's parts are cut along the shoreline (regions.js), the wet ones in the water color (shade, shadows and
  // lamps as any ground). Digging below the level fills with water.
  const Hraw = grid.H;
  let level = water;
  if (level === undefined) {
    const hs = [];
    for (let i = 0; i <= N; i += 2) for (let j = 0; j <= N; j += 2) hs.push(Hbase(center.x - size / 2 + i * cell, center.z - size / 2 + j * cell));
    hs.sort((a, b) => a - b);
    level = hs[Math.floor(hs.length * 0.09)];
  }
  // the higher of land and water, its crease at the shore rounded over SHORE_K units (a smooth maximum): the terrain needs no
  // finest level all along the shore for a kink
  const SHORE_K = 6;
  const H = (x, z) => {
    const a = Hraw(x, z), d = a - level;
    if (d >= SHORE_K) return a;
    if (d <= -SHORE_K) return level;
    const t = 0.5 + d / (2 * SHORE_K);
    return level + d * t + SHORE_K * t * (1 - t);
  };
  const WATER = '#3d86c6';
  const wetParts = (o, parts) => {
    const test = (p) => Hraw(p.x + o.ox, p.z + o.oz) < level;
    const b = o.bound;
    if (Math.min(...b.map((p) => p.y)) > level + 0.5 && Hraw(o.mid.x, o.mid.z) > level) return parts;   // high above the water
    const out = [];
    for (const part of parts) for (const q of splitLoop(part.loop, test)) out.push(q.inside ? { ...part, loop: q.loop, fill: WATER } : { ...part, loop: q.loop });
    return out.sort((a, c) => a.shade - c.shade);
  };
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const row = [];
    for (let j = 0; j <= N; j++) {
      const edge = i === 0 || j === 0 || i === N || j === N;
      const x = center.x - size / 2 + i * cell + (edge ? 0 : (rand() - 0.5) * cell * 0.4);
      const z = center.z - size / 2 + j * cell + (edge ? 0 : (rand() - 0.5) * cell * 0.4);
      row.push({ x, y: H(x, z), z });
    }
    pts.push(row);
  }
  // Color field: slow waves for the patches, a faster one for ragged borders.
  const field = (x, z) => Math.sin(x / 310 + 1.1) + Math.sin(z / 270 - 0.4) + Math.sin((x + z) / 190 + 2.3) + 0.45 * Math.sin(x / 47 + 0.3) * Math.sin(z / 53 - 1.2);
  const colorOf = (p) => {
    if (oneColor) return GREENS[0];
    let x = p.x - center.x, z = p.z - center.z;
    if (colorCells > 1) {   // the field at the middle of a block of colorCells x colorCells cells (borders on coarse edges)
      const w = cell * colorCells;
      x = (Math.floor((x + size / 2) / w) + 0.5) * w - size / 2; z = (Math.floor((z + size / 2) / w) + 0.5) * w - size / 2;
    }
    const v = (field(x, z) + 3.45) / 6.9;
    return GREENS[Math.max(0, Math.min(GREENS.length - 1, Math.floor(v * GREENS.length)))];
  };
  // Sun shade (shadow.js): the field over the meadow, and every patch split along it (crossings cached per edge).
  const t0 = performance.now();
  let F = light.on ? buildShadowField({ H, x0: center.x - size / 2, x1: center.x + size / 2, z0: center.z - size / 2, z1: center.z + size / 2, dir: light.dir }) : null;
  const cache = new Map();
  // Lamps (lamps.js) on the first three poles (placed below; their positions are drawn from the same random sequence first).
  lamps.length = 0;
  const poleSpots = [];
  for (let i = 0; i < 7; i++) {
    const x = center.x + 250 + rand() * 450, z = center.z + (rand() - 0.5) * 600, r = 2 + rand() * 2, h = 50 + rand() * 70;
    poleSpots.push({ x, z, r, h, dx: (rand() - 0.5) * 6, dz: (rand() - 0.5) * 6 });
  }
  const LAMPS = [[[255, 196, 120], '#ffd894'], [[140, 190, 255], '#b4d4ff'], [[150, 255, 175], '#c2ffd0']];
  for (let i = 0; i < 3; i++) {
    const p = poleSpots[i];
    lamps.push({ pos: { x: p.x + p.dx, y: Hbase(p.x, p.z) + p.h + 6, z: p.z + p.dz }, radius: 230, color: LAMPS[i][0], head: LAMPS[i][1] });
  }
  const terrain = buildTerrain({ grid: pts, H, colorOf, minErr, colorK, partsOf: F ? (o) => lampParts(o, wetParts(o, splitPatch(o, F, cache)), H) : (o) => wetParts(o, [{ loop: o.loop, shade: false }]) });
  terrain.wet = (x, z) => Hraw(x, z) < level + 1;
  terrain.waterLevel = level;
  terrain.shadowMs = performance.now() - t0;
  terrain.F = F;
  // Movers: logs rolling along circles and balls drifting, just over the ground (stylized light: `shade`).
  const movers = [];
  const LOGS = ['#8d6e63', '#a1887f', '#795548'], BALLS = ['#e53935', '#fdd835', '#1e88e5', '#fb8c00'];
  for (let i = 0; i < movers_; i++) {
    const log = i % 2 === 0, R0 = 150 + rand() * 900, a0 = rand() * 6.283, sp = (0.05 + rand() * 0.08) * (rand() < 0.5 ? 1 : -1);
    const r = log ? 9 + rand() * 6 : 12 + rand() * 14, len = log ? 50 + rand() * 50 : 0, fill = (log ? LOGS : BALLS)[i % (log ? 3 : 4)];
    const o = { a: { c: { x: 0, y: 0, z: 0 }, r }, b: { c: { x: 0, y: 0, z: 0 }, r }, fill, shade: { r }, onGround: true };
    const cx = center.x + 700 + (rand() - 0.5) * 600, cz = center.z + (rand() - 0.5) * 600, hop = log ? 0 : 20 + rand() * 30, ph = rand() * 6.283;
    o.move = (t) => {
      const ang = a0 + sp * t, x = cx + Math.cos(ang) * R0 * 0.4, z = cz + Math.sin(ang) * R0 * 0.4;
      const y = H(x, z) + r + (log ? 0 : hop * Math.abs(Math.sin(t * 1.7 + ph)));
      const tx = -Math.sin(ang), tz = Math.cos(ang);   // a log lies across its path (it rolls)
      o.a.c = { x: x - tz * len / 2, y: log ? H(x - tz * len / 2, z + tx * len / 2) + r : y, z: z + tx * len / 2 };
      o.b.c = { x: x + tz * len / 2, y: log ? H(x + tz * len / 2, z - tx * len / 2) + r : y, z: z - tx * len / 2 };
    };
    o.move(0);
    movers.push(o);
  }
  // Poles: static thin posts between the start and the meadow's middle, to see the grass against something.
  const poles = [];
  poleSpots.forEach((p, i) => {
    const y = H(p.x, p.z);
    poles.push({ a: { c: { x: p.x, y: y - p.r, z: p.z }, r: p.r }, b: { c: { x: p.x + p.dx, y: y + p.h, z: p.z + p.dz }, r: p.r * 0.8 },
      fill: ['#6d4c41', '#eceff1', '#90a4ae'][i % 3], shade: { r: p.r }, onGround: true });
  });
  for (const L of lamps) poles.push({ a: { c: L.pos, r: 6 }, b: { c: L.pos, r: 6 }, fill: L.head, glow: true });   // lamp heads
  // EDIT (grid.js): dig or place the cube where the ray from `eye` along `dir` meets the ground, then redo only what it touches: the
  // shadow field's lines across it, and the terrain there (patches, parts, errors, cut, grass). A placed cube's shadow can reach
  // far downwind: those patches' shade parts are redone too. Returns the grid's result, or null.
  const edit = (action, eye, dir) => {
    const hit = grid.raycast(eye, dir);
    if (!hit) return null;
    const r = action === 'dig' ? grid.dig(hit) : grid.place(hit);
    if (!r) return null;
    const t0 = performance.now();
    let shadeBox = r.box;
    if (F && F.update) {
      shadeBox = { ...r.box };
      if (r.raised && F.tanE > 0) {   // downwind of the box, as far as a few cubes' shadow reaches
        const len = Math.min(size, (cell * 3) / Math.max(F.tanE, 0.05)), dx = -F.ux * len, dz = -F.uz * len;
        shadeBox = { x0: Math.min(r.box.x0, r.box.x0 + dx), x1: Math.max(r.box.x1, r.box.x1 + dx), z0: Math.min(r.box.z0, r.box.z0 + dz), z1: Math.max(r.box.z1, r.box.z1 + dz) };
      }
      F.update(shadeBox);
    }
    cache.clear();   // shadow crossings: recomputed where touched (unchanged elsewhere, so neighbors still agree)
    terrain.refresh(r.box, shadeBox);
    r.ms = performance.now() - t0;
    return r;
  };
  return { terrain, groundAt: H, movers, poles, grid, edit };
}
