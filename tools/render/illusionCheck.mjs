// Headless regression check of the illusion renderer: `node tools/render/illusionCheck.mjs [root]` (default: this folder).
// Runs a few frames of each illusion scene against a stub canvas and reports, failing (exit 1) on any of:
//   - a non-finite number passed to the canvas (NaN / Infinity in a path);
//   - the ground patch under a low eye not drawn (near cut, omission);
//   - the same seed not growing the same blades whatever the order of visits;
//   - a face-up point of a split ground patch projecting outside its drawn parts (coverage, a sample);
//   - an exception.
// It also prints the JS time per frame (Node, stub canvas: not the browser's).
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = pathToFileURL(path.resolve(process.argv[2] || '.')).href;
const { camera, getCameraPosition, computeViewBasis, makeProjector } = await import(root + '/src/core/camera.js');
const R = await import(root + '/src/illusion/illusionRender.js');
const { selectGrass } = await import(root + '/src/illusion/grass.js');
const { makeFrustum } = await import(root + '/src/illusion/cull.js');
const { patchPieces, heightAt } = await import(root + '/src/illusion/patch.js');
const { pointOnEllipse } = await import(root + '/src/illusion/shape.js');
const M = await import(root + '/src/illusion/meadow.js');

let bad = 0, fails = 0;
const check = (num) => { if (typeof num === 'number' && !Number.isFinite(num)) bad++; };
const fns = { createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: (...a) => { a.forEach(check); return { addColorStop() {} }; } };
const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (fns[k] || (fns[k] = (...a) => { for (const v of a) check(v); }))), set: (t, k, v) => (t[k] = v, true) });
globalThis.Path2D = class {
  moveTo(...a) { a.forEach(check); } lineTo(...a) { a.forEach(check); } ellipse(...a) { a.slice(0, 7).forEach(check); }
  closePath() {} rect() {} addPath() {}
};
const canvas = { width: 1600, height: 900 };
const fail = (msg) => { console.log('FAIL ' + msg); fails++; };
const frame = (time = 0) => R.renderIllusion(ctx, canvas, { time });

// 1. The meadow from several views: no bad numbers; the patch under a low eye drawn.
const g = R.buildMeadowScene();
const views = [[1200, 0, 60, 500, 0], [1200, 0, 300, 300, 400], [-400, -900, 200, 500, 0], [500, 1300, 40, 400, -600], [-1500, 1500, 30, 1500, -1500]];
let ms = 0;
for (const [ex, ez, up, tx, tz] of views) {
  for (let f = 0; f < 6; f++) {
    camera.position = { x: ex + f, y: g(ex, ez) + up, z: ez }; camera.target = { x: tx, y: g(tx, tz), z: tz };
    const t = performance.now(); frame(f * 0.1); if (f >= 2) ms += performance.now() - t;
  }
}
console.log(`meadow: ${(ms / (views.length * 4)).toFixed(1)} ms JS per frame`);
const T = R.sceneTerrain();
const inTri = (o, x, z) => {
  const [a, b, c] = o.loop.map((pc) => ({ x: pc.a.x + o.ox, z: pc.a.z + o.oz }));
  const s = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x), P = { x, z };
  const d1 = s(a, b, P), d2 = s(b, c, P), d3 = s(c, a, P);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};
for (const [x, z, up, look] of [[900, 100, 25, 60], [700, -200, 12, 30], [500, 0, 8, 40]]) {
  camera.position = { x, y: g(x, z) + up, z }; camera.target = { x: x - look, y: g(x, z) - 5, z };
  const st = frame();
  // The selected patch under the eye must be drawn, unless all of it is within the near cut (8 units: far below the screen).
  const pos = getCameraPosition(), basis = computeViewBasis(pos, camera.target);
  const depth = (p) => { const d = { x: p.x - pos.x, y: p.y - pos.y, z: p.z - pos.z }; return d.x * basis.forward.x + d.y * basis.forward.y + d.z * basis.forward.z; };
  let ok = false, found = false;
  // (every selected patch: the grid points are nudged, so a triangle's children cover it and its diamond partner together)
  for (const o of T.patches) if (o.sel === st.frame && inTri(o, x, z)) {
    found = true;
    if (o.drawnFrame === st.frame || Math.max(...o.bound.map(depth)) <= 8) ok = true;
  }
  if (!found || !ok) fail(`the ground under the eye at (${x}, ${z}) +${up} is not drawn`);
}

// 2. Grass: the same blades whatever the order of visits.
{
  const view = { x0: -1e6, x1: 1e6, y0: -1e6, y1: 1e6 };
  const run = (TT, eye) => {
    camera.position = eye; camera.target = { x: eye.x - 300, y: eye.y - 40, z: eye.z };
    const pos = getCameraPosition(), pr = makeProjector(pos, computeViewBasis(pos, camera.target));
    selectGrass(TT, pos, { F: null, L: null, toCamera: pr.toCamera, projectPoint: pr.projectPoint, persp: pr.persp, frustum: makeFrustum(pr.persp, view) });
  };
  const a = M.buildMeadow(), b = M.buildMeadow();
  const near = { x: 900, y: a.groundAt(900, 0) + 40, z: 0 }, far = { x: 3300, y: a.groundAt(3300, 0) + 40, z: 0 };
  run(a.terrain, near); run(b.terrain, far); run(b.terrain, near);
  let diff = 0, n = 0;
  a.terrain.leafNodes.forEach((la, i) => {
    const lb = b.terrain.leafNodes[i];
    if (!la.gen || !lb.gen) return;
    for (let k = 0; k < Math.min(la.gen.made.length, lb.gen.made.length); k++) {
      const p = la.gen.made[k], q = lb.gen.made[k]; n++;
      if (p.base.x !== q.base.x || p.base.z !== q.base.z || p.h !== q.h) diff++;
    }
  });
  if (!n) fail('no blades grown'); else if (diff) fail(`${diff} of ${n} blades differ with the order of visits`);
  else console.log(`grass: ${n} blades, the same whatever the order of visits`);
}

// 3. Coverage of split patches (lit + shade parts) from a few views: every face-up sample inside the drawn loops.
{
  // (patches smaller than the 700-unit viewing distance: the selection never draws a bigger one that near)
  const P = T.patches.filter((o) => o.parts && o.parts.length > 1 && Math.hypot(o.bound[7].x - o.bound[0].x, o.bound[7].z - o.bound[0].z) < 700).slice(0, 60);
  let out = 0, samples = 0;
  const loopsOf = (sides) => { const L = []; let cur = null; for (const s of sides) { if (!cur || s.move) { cur = []; L.push(cur); } if (s.kind === 'line') cur.push(s.from, s.to); else for (let k = 0; k <= 64; k++) cur.push(pointOnEllipse(s.e, s.t0 + (s.t1 - s.t0) * k / 64)); } return L; };
  const wind = (L, p) => { let w = 0; for (const l of L) for (let i = 0; i < l.length; i++) { const a = l[i], b = l[(i + 1) % l.length], c = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y); if (a.y <= p.y) { if (b.y > p.y && c > 0) w++; } else if (b.y <= p.y && c < 0) w--; } return w; };
  const dist = (L, p) => { let d = Infinity; for (const l of L) for (let i = 0; i < l.length; i++) { const a = l[i], b = l[(i + 1) % l.length], ex = b.x - a.x, ey = b.y - a.y, t = Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / (ex * ex + ey * ey || 1))); d = Math.min(d, Math.hypot(a.x + ex * t - p.x, a.y + ey * t - p.y)); } return d; };
  for (const o of P) for (const ang of [0, 2.1, 4.2]) {
    const eye = { x: o.mid.x + 700 * Math.cos(ang), y: o.mid.y + 80, z: o.mid.z + 700 * Math.sin(ang) };
    camera.position = eye; camera.target = o.mid;
    const pos = getCameraPosition(), pr = makeProjector(pos, computeViewBasis(pos, o.mid));
    const sides = [];
    for (const part of o.parts) for (const p of patchPieces(o, pr, pos, Infinity, part.loop)) p.sides.forEach((s, j) => sides.push(j === 0 && sides.length ? { ...s, move: true } : s));
    const L = loopsOf(sides), [A, B, C] = o.loop.map((pc) => pc.a);
    for (let i = 0; i <= 8; i++) for (let j = 0; i + j <= 8; j++) {
      const x = A.x + (B.x - A.x) * i / 8 + (C.x - A.x) * j / 8, z = A.z + (B.z - A.z) * i / 8 + (C.z - A.z) * j / 8;
      const X = { x: o.ox + x, y: o.oy + heightAt(o.q, x, z), z: o.oz + z };
      const hx = 2 * o.q[0] * x + o.q[1] * z + o.q[3], hz = o.q[1] * x + 2 * o.q[2] * z + o.q[4];
      if (-hx * (pos.x - X.x) + (pos.y - X.y) - hz * (pos.z - X.z) <= 0) continue;
      samples++;
      const q = pr.projectPoint(X);
      if (wind(L, q) === 0 && dist(L, q) > 0.5) out++;
    }
  }
  if (out) fail(`${out} of ${samples} face-up samples outside their split patch's parts`);
  else console.log(`coverage: ${samples} face-up samples of ${P.length} split patches inside their parts`);
}

// 4. Grid edits (meadow): dig 3 times at one spot (the hole deepens), place 2 cubes beside it (the ground rises); frames clean;
// the drawn cut still conforming (every inner edge of the drawn patches shared by exactly 2).
{
  const g2 = R.buildMeadowScene();
  const spot = { x: 800, z: 60 }, h0 = g2(spot.x, spot.z);
  const aim = (x, z) => { camera.position = { x: x + 120, y: g2(x, z) + 90, z }; camera.target = { x, y: g2(x, z), z }; };
  const times = [];
  for (let k = 0; k < 3; k++) { aim(spot.x, spot.z); const r = R.editGround('dig'); if (!r) fail('dig found no ground'); else times.push(r.ms); }
  const h1 = g2(spot.x, spot.z);
  const wl = R.sceneTerrain().waterLevel ?? -Infinity;   // a hole below the water level fills with water
  if (!(h1 < Math.max(h0 - 20, wl + 0.01))) fail(`digging 3 cubes lowered the ground only from ${h0.toFixed(1)} to ${h1.toFixed(1)}`);
  const p2 = { x: spot.x - 150, z: spot.z + 90 }, hp0 = g2(p2.x, p2.z);
  for (let k = 0; k < 2; k++) { aim(p2.x, p2.z); const r = R.editGround('place'); if (!r) fail('place found no ground'); else times.push(r.ms); }
  const hp1 = g2(p2.x, p2.z);
  if (!(hp1 > hp0 + 20)) fail(`placing 2 cubes raised the ground only from ${hp0.toFixed(1)} to ${hp1.toFixed(1)}`);
  const key = (p) => `${Math.round(p.x * 100)},${Math.round(p.y * 100)},${Math.round(p.z * 100)}`;
  for (const [x, z] of [[spot.x + 200, spot.z], [spot.x, spot.z + 220]]) {
    camera.position = { x, y: g2(x, z) + 60, z }; camera.target = { x: spot.x, y: g2(spot.x, spot.z), z: spot.z };
    const st = frame();
    const count = new Map();
    for (const o of R.sceneTerrain().patches) if (o.sel === st.frame) for (const [p, q] of o.edges) { const a = key(p), b = key(q), k = a < b ? a + b : b + a; count.set(k, (count.get(k) || 0) + 1); }
    const over = [...count.values()].filter((c) => c > 2).length;
    if (over) fail(`${over} edges shared by 3+ drawn patches after edits`);
  }
  console.log(`grid: dug ${h0.toFixed(1)} -> ${h1.toFixed(1)}, placed ${hp0.toFixed(1)} -> ${hp1.toFixed(1)}; refresh ${times.map((t) => t.toFixed(0)).join(', ')} ms`);
  // edits survive a rebuild (the sun, the light), and replay identically from their saved list
  const list = JSON.parse(JSON.stringify(R.groundEdits()));
  const g4 = R.buildMeadowScene();
  if (Math.abs(g4(spot.x, spot.z) - h1) > 1e-9 || Math.abs(g4(p2.x, p2.z) - hp1) > 1e-9) fail('a rebuild lost the ground edits');
  const g5 = R.buildMeadowScene({ edits: list });
  if (Math.abs(g5(spot.x, spot.z) - h1) > 1e-9 || Math.abs(g5(p2.x, p2.z) - hp1) > 1e-9) fail('saved edits do not replay the same ground');
  R.buildMeadowScene({ edits: null });
}

// 5. Night (lamps): the sun below the horizon, every patch in shade, lamp bands cut in near the lamps; a frame clean.
{
  const { setSun, light } = await import(root + '/src/illusion/light.js');
  const { lamps } = await import(root + '/src/illusion/lamps.js');
  const [az, el] = [light.azimuth, light.elevation];
  setSun(az, -0.1);
  const g3 = R.buildMeadowScene();
  const banded = R.sceneTerrain().patches.filter((o) => o.parts && o.parts.some((p) => p.lamp)).length;
  if (!lamps.length || !banded) fail(`night: ${lamps.length} lamps, ${banded} patches with a lamp band`);
  const L0 = lamps[0].pos;
  camera.position = { x: L0.x + 260, y: g3(L0.x + 260, L0.z) + 70, z: L0.z }; camera.target = { x: L0.x, y: L0.y - 60, z: L0.z };
  const st = frame();
  console.log(`night: ${lamps.length} lamps, ${banded} patches with a lamp band, drawn ${st.drawn}`);
  setSun(az, el);
}

// 6. The other scenes: a frame each.
for (const [name, build] of [['world', () => R.buildWorldScene({ count: 3000, curved: 100, movers: 200, walls: 48, sheets: 600 })], ['sheets', R.buildSheetsScene], ['patch', R.buildPatchScene], ['pairs', R.buildPairsScene]]) {
  build();
  camera.position = { x: 1200, y: 520, z: 0 }; camera.target = { x: 500, y: 400, z: 0 };
  const t = performance.now(); const st = frame(1);
  console.log(`${name}: drawn ${st.drawn} of ${st.objects}, ${(performance.now() - t).toFixed(1)} ms (first frame)`);
}

if (bad) fail(`${bad} non-finite numbers passed to the canvas`);
console.log(fails ? `${fails} FAILED` : 'all checks passed');
process.exit(fails ? 1 : 0);
