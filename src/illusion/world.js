// The stress scene of the illusion renderer: as many shapes as the sliders ask for, in every direction, size and distance,
// to find where it breaks on the way to a skybox + world + moving objects.
// Every object is a 2-node mesh { a: { c, r }, b: { c, r }, bend?, fill, sky?, move? }: a capsule, or (with `bend`) the
// tube bent through that point (curve.js). `move(t)` rewrites a, b, bend for time t (seconds).
// - sky: huge shapes 20-40k units away (a mountain ring on the horizon, clouds above it, a sun), so they barely move as the
//   camera flies: a skybox made of the same shapes;
// - world: static shapes scattered log-uniformly from 40 to 8000 units around the start, sizes 2-100 (bigger far away);
// - sheets: paper, cards, discs and ribbons / strands (sheet.js), two-sided;
// - walls: rings of wall segments around the start, to hide parts of the world (occlusion culling);
// No two static shapes overlap in 3D, and none lies on a mover's orbit (space.js); a shape that finds no free spot in 20 tries is
// left out (`skipped`). Movers may pass through each other.
// - movers: shapes circling, spinning and (the curved ones) flexing, near the start.

const WORLD_FILLS = ['#ef9a9a', '#f48fb1', '#ce93d8', '#b39ddb', '#9fa8da', '#90caf9', '#81d4fa', '#80deea', '#80cbc4',
  '#a5d6a7', '#c5e1a5', '#e6ee9c', '#fff59d', '#ffe082', '#ffcc80', '#ffab91', '#bcaaa4', '#b0bec5'];
const MOVER_FILLS = ['#e53935', '#d81b60', '#8e24aa', '#3949ab', '#1e88e5', '#00897b', '#43a047', '#fdd835', '#fb8c00', '#6d4c41'];
const MOUNTAIN_FILLS = ['#78909c', '#607d8b', '#8d6e63', '#6d8b74', '#7e8f6a'];
const WALL_FILLS = ['#a1887f', '#8d6e63', '#9e9e9e', '#90a4ae'];
const SHEET_FILLS = ['#fafafa', '#fff8e1', '#e3f2fd', '#fce4ec', '#e8f5e9', '#ffcdd2', '#d1c4e9', '#ffe0b2', '#b2dfdb', '#f0f4c3'];
const CLOUD_FILLS = ['#eceff1', '#e3f2fd', '#fce4ec', '#f3e5f5', '#e8eaf6'];

import { Space, partsOf, lane, partsHitShapes } from './space.js';
import { backOf } from './sheet.js';

export const CENTER = { x: 500, y: 300, z: 0 };

// Seeded, so a slider change rebuilds the same world plus or minus some shapes.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const add = (p, q, k = 1) => ({ x: p.x + q.x * k, y: p.y + q.y * k, z: p.z + q.z * k });
const cross = (p, q) => ({ x: p.y * q.z - p.z * q.y, y: p.z * q.x - p.x * q.z, z: p.x * q.y - p.y * q.x });
const norm = (p) => { const l = Math.hypot(p.x, p.y, p.z) || 1; return { x: p.x / l, y: p.y / l, z: p.z / l }; };
const unit = (rand) => {   // uniform on the sphere
  const z = rand() * 2 - 1, a = rand() * Math.PI * 2, s = Math.sqrt(1 - z * z);
  return { x: s * Math.cos(a), y: z, z: s * Math.sin(a) };
};
const perpTo = (d, rand) => norm(cross(d, unit(rand)));
const pick = (arr, rand) => arr[Math.floor(rand() * arr.length)];

// A capsule (or bent tube) centered at p along d, of length len, radii ra / rb, bent sideways by `bow` (fraction of len).
function body(p, d, len, ra, rb, fill, bow, side) {
  const a = { c: add(p, d, -len / 2), r: ra }, b = { c: add(p, d, len / 2), r: rb };
  const o = { a, b, fill };
  if (bow) o.bend = add(p, side, bow * len);
  return o;
}

export function buildWorld({ count = 3000, curved = 40, movers = 200, walls = 0, sheets = 0 } = {}) {
  const objects = [], space = new Space();
  let skipped = 0;
  // Up to TRIES fresh candidates for one shape; the first that overlaps nothing is kept (space.js), else the shape is left out.
  const TRIES = 20;
  const placeOne = (make) => {
    for (let k = 0; k < TRIES; k++) { const o = make(); if (space.place(o)) { objects.push(o); return; } }
    skipped++;
  };
  // WALLS. Rings of wall segments around the start (16 per ring, rings 600 units apart from 1000 out), each a stack of 5
  // horizontal capsules that touch (rows 2r apart: no overlap, and no gap between them on screen), with WINDOW units between
  // neighboring segments' ends. They hide what lies behind them: the renderer's occlusion culling (cull.js) skips it.
  {
    const PER_RING = 16, WINDOW = 80, R0 = 1000, DR = 600, r = 70, rows = [-210, -70, 70, 210, 350];
    for (let i = 0; i < walls; i++) {
      const ring = Math.floor(i / PER_RING), k = i % PER_RING, R = R0 + ring * DR;
      const step = (Math.PI * 2) / PER_RING, a0 = (k + (ring % 2) * 0.5) * step;
      const half = (step - 2 * Math.asin((2 * r + WINDOW) / (2 * R))) / 2;   // the end centers' chord: 2r + WINDOW
      const at = (a, y) => ({ x: CENTER.x + Math.cos(a) * R, y: CENTER.y + y, z: CENTER.z + Math.sin(a) * R });
      const fill = WALL_FILLS[(ring + k) % WALL_FILLS.length];
      for (const y of rows) {
        const o = { a: { c: at(a0 - half, y), r }, b: { c: at(a0 + half, y), r }, fill };
        space.add(partsOf(o));
        objects.push(o);
      }
    }
  }
  // SKY. The sun, a ring of mountains on the horizon, clouds above it.
  {
    const rand = rng(7);
    const sunDir = norm({ x: -0.5, y: 0.35, z: -0.8 });
    const sun = add(CENTER, sunDir, 36000);
    placeOne(() => ({ a: { c: sun, r: 1800 }, b: { c: sun, r: 1800 }, fill: '#fff3b0', sky: true }));
    for (let i = 0; i < 70; i++) placeOne(() => {
      const ang = (i / 70) * Math.PI * 2 + rand() * 0.05, dist = 24000 + rand() * 16000;
      const p = { x: CENTER.x + Math.cos(ang) * dist, y: -1500 + rand() * 1500, z: CENTER.z + Math.sin(ang) * dist };
      const along = norm({ x: -Math.sin(ang), y: (rand() - 0.5) * 0.5, z: Math.cos(ang) });
      const r = 1800 + rand() * 2600;
      return { ...body(p, along, r * (1 + rand() * 2.5), r, r * (0.5 + rand() * 0.7), pick(MOUNTAIN_FILLS, rand)), sky: true };
    });
    for (let i = 0; i < 90; i++) placeOne(() => {
      const ang = rand() * Math.PI * 2, dist = 22000 + rand() * 14000, h = 2500 + rand() * 9000;
      const p = { x: CENTER.x + Math.cos(ang) * dist, y: h, z: CENTER.z + Math.sin(ang) * dist };
      const along = norm({ x: -Math.sin(ang) + (rand() - 0.5) * 0.6, y: (rand() - 0.5) * 0.15, z: Math.cos(ang) });
      const r = 500 + rand() * 1300, bow = rand() < 0.3 ? 0.15 + rand() * 0.2 : 0;
      return { ...body(p, along, r * (2 + rand() * 5), r, r * (0.4 + rand() * 0.8), pick(CLOUD_FILLS, rand), bow, { x: 0, y: 1, z: 0 }), sky: true };
    });
  }
  // MOVERS. Circling the start at 100-1500 units, spinning about their own axis; one in five bent, its bow flexing. Each orbit
  // (the circle swept by the mover's reach, bob included) keeps clear of the walls and sky, and the world's shapes are placed
  // clear of every orbit. Movers may pass through each other.
  {
    const rand = rng(23);
    for (let i = 0; i < movers; i++) {
      const r = 4 + rand() * 26, len = r * (2 + rand() * 6), rb = r * (0.5 + rand());
      const bent = rand() < 0.2, bow0 = 0.3 + rand() * 0.3, fill = pick(MOVER_FILLS, rand);
      const bob = rand() * 60, rad = len / 2 + Math.max(r, rb) + (bent ? len * bow0 : 0) + bob;
      let R, y0, L = null;
      for (let k = 0; k < TRIES && !L; k++) {
        R = 100 + rand() * 1400; y0 = CENTER.y + (rand() - 0.5) * 500;
        const cand = lane(CENTER, R, y0, rad);
        if (!partsHitShapes(space, cand)) L = cand;
      }
      if (!L) { skipped++; continue; }
      space.lanes.push(L);
      const w = (0.15 + rand() * 0.6) * (rand() < 0.5 ? -1 : 1), ph = rand() * Math.PI * 2, bw = 0.5 + rand() * 2;
      const spinAxis = unit(rand), spin = (rand() - 0.5) * 3, d0 = perpTo(spinAxis, rand);
      const o = { a: { c: CENTER, r }, b: { c: CENTER, r: rb }, fill };
      o.move = (t) => {
        const a = ph + w * t, p = { x: CENTER.x + Math.cos(a) * R, y: y0 + Math.sin(t * bw + ph) * bob, z: CENTER.z + Math.sin(a) * R };
        const s = spin * t, e2 = cross(spinAxis, d0);   // d spins in the plane perpendicular to spinAxis
        const d = norm(add({ x: d0.x * Math.cos(s), y: d0.y * Math.cos(s), z: d0.z * Math.cos(s) }, e2, Math.sin(s)));
        o.a.c = add(p, d, -len / 2); o.b.c = add(p, d, len / 2);
        if (bent) o.bend = add(p, spinAxis, len * bow0 * (0.6 + 0.4 * Math.sin(t * 1.7 + ph)));
      };
      o.move(0);
      objects.push(o);
    }
  }
  // WORLD. Log-uniform distance from the start, any direction; the first `curved` of them bent.
  {
    const rand = rng(11);
    for (let i = 0; i < count; i++) placeOne(() => {
      const dist = 40 * Math.pow(10, rand() * 2.3), ang = rand() * Math.PI * 2;
      const p = { x: CENTER.x + Math.cos(ang) * dist, y: CENTER.y + (rand() - 0.5) * (300 + dist * 0.25), z: CENTER.z + Math.sin(ang) * dist };
      const r = 2 * Math.pow(10, rand() * 1.7) * (1 + dist / 2500);
      const d = unit(rand), len = r * (1 + rand() * 10);
      const bent = i < curved;
      return body(p, d, len, r, r * (0.4 + rand() * 1.2), pick(WORLD_FILLS, rand), bent ? 0.25 + rand() * 0.45 : 0, perpTo(d, rand));
    });
  }
  // SHEETS (sheet.js). Scattered like the world's shapes: paper and cards (some with rounded corners), discs, and ribbons bent
  // through a point, half of them strands tapering to a tip. Two-sided: `back` a darker tone of `fill`.
  {
    const rand = rng(31);
    for (let i = 0; i < sheets; i++) placeOne(() => {
      const dist = 40 * Math.pow(10, rand() * 2.3), ang = rand() * Math.PI * 2;
      const c = { x: CENTER.x + Math.cos(ang) * dist, y: CENTER.y + (rand() - 0.5) * (300 + dist * 0.25), z: CENTER.z + Math.sin(ang) * dist };
      const r = 3 * Math.pow(10, rand() * 1.5) * (1 + dist / 2500), fill = pick(SHEET_FILLS, rand), back = backOf(fill);
      const d = unit(rand), side = perpTo(d, rand), kind = rand();
      if (kind < 0.5) {   // paper / card / disc
        const h1 = r * (1 + rand() * 3), h2 = h1 * (0.35 + rand() * 0.65);
        const e1 = { x: d.x * h1, y: d.y * h1, z: d.z * h1 }, e2 = { x: side.x * h2, y: side.y * h2, z: side.z * h2 };
        if (kind < 0.12) return { kind: 'disc', c, e1, e2, fill, back };
        return { kind: 'panel', c, e1, e2, round: rand() < 0.5 ? 0 : rand(), fill, back };
      }
      const strand = kind > 0.75, len = r * (strand ? 6 + rand() * 10 : 3 + rand() * 6);
      const w = strand ? r * (0.15 + rand() * 0.3) : r * (0.4 + rand() * 0.8);
      const bow = 0.15 + rand() * 0.45, tilt = (rand() - 0.5) * 1.2;
      const n = cross(d, side), dir = norm(add(n, side, tilt));   // across the strip: the arch plane's normal, tilted
      return {
        kind: 'ribbon', a: { c: add(c, d, -len / 2), r: w }, b: { c: add(c, d, len / 2), r: strand ? 0 : w * (0.6 + rand() * 0.6) },
        bend: add(c, side, bow * len), dir, fill, back,
      };
    });
  }
  objects.skipped = skipped;
  return objects;
}
