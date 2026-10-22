// Rasterizes the fills of the squashed-node meshes in real frames (nonzero winding of the
// recorded paths) and compares each with the convex hull of its nodes' ellipses (the shape
// a plain mesh should have). Usage: node tools/meshCheck.mjs <srcDir> [steps]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [srcDir, stepsArg] = process.argv.slice(2);
const steps = Number(stepsArg || 24);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-'));
fs.readdirSync(srcDir).filter(f => f.endsWith('.js')).forEach(f => fs.copyFileSync(path.join(srcDir, f), path.join(dir, f)));
fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
const load = (f) => import(pathToFileURL(path.join(dir, f)).href);
const R = await load('render.js'), C = await load('camera.js'), S = await load('scene.js'), G = await load('geometry.js');
S.buildDemoScene();

// A ctx that records the path and the fills as tessellated subpaths.
let subs, cur, fills;
const tess = (cx, cy, a, b, rot, t0, t1, ccw) => {
  let d = t1 - t0;
  if (ccw) { while (d > 0) d -= 2 * Math.PI; while (d < -2 * Math.PI) d += 2 * Math.PI; } else { while (d < 0) d += 2 * Math.PI; }
  const n = Math.max(2, Math.ceil(Math.abs(d) / 0.01)), pts = [];
  for (let i = 0; i <= n; i++) { const t = t0 + d * i / n, x = a * Math.cos(t), y = b * Math.sin(t); pts.push({ x: cx + x * Math.cos(rot) - y * Math.sin(rot), y: cy + x * Math.sin(rot) + y * Math.cos(rot) }); }
  return pts;
};
const ctx = {
  fillStyle: null,
  getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
  beginPath() { subs = []; cur = null; },
  moveTo(x, y) { cur = [{ x, y }]; subs.push(cur); },
  lineTo(x, y) { if (!cur) { cur = []; subs.push(cur); } cur.push({ x, y }); },
  arc(x, y, r, a0, a1, ccw) { if (!cur) { cur = []; subs.push(cur); } cur.push(...tess(x, y, r, r, 0, a0, a1, ccw)); },
  ellipse(x, y, a, b, rot, a0, a1, ccw) { if (!cur) { cur = []; subs.push(cur); } cur.push(...tess(x, y, a, b, rot, a0, a1, ccw)); },
  closePath() { cur = null; },
  fill() { fills.push({ color: this.fillStyle, subs: subs.map(p => p.slice()) }); },
  fillRect() {}, save() {}, restore() {}, stroke() {}, setLineDash() {}, setTransform() {}, translate() {}, scale() {}, transform() {}, clip() {},
};
const winding = (p, poly) => {
  let w = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i];
    if (a.y <= p.y) { if (b.y > p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) > 0) w++; }
    else if (b.y <= p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) < 0) w--;
  }
  return w;
};

const canvas = { width: 1000, height: 800 };
// Plain squashed meshes only: a mesh sharing a node with another is drawn by the joint / split code.
const shared = (id) => Object.values(S.meshes).filter(m => m.nodeIds.includes(id)).length > 1;
const figures = Object.values(S.meshes).filter(m => m.nodeIds.some(id => !S.nodes[id].shape.isSphere) && !m.nodeIds.some(shared));
const stats = Object.fromEntries(figures.map(m => [m.color, { nodes: m.nodeIds.length, worstOnly: 0, worstMiss: 0, area: 0, wrongWinding: 0 }]));
for (let i = 0; i < steps; i++) {
  C.camera.orbitAngle = (i / steps) * Math.PI * 2;
  fills = [];
  R.render(ctx, canvas, { darkMode: false });
  const frame = R.lastFrame;
  for (const m of figures) {
    const own = fills.filter(f => f.color === m.color).flatMap(f => f.subs).filter(s => s.length > 2);
    // hull of the nodes' ellipses (densely sampled)
    const pts = m.nodeIds.flatMap(id => {
      const p = frame.projected[id], e = { center: p.center, a: p.ellipse.a, b: Math.max(p.ellipse.b, 1e-6), angle: p.ellipse.angle };
      return Array.from({ length: 720 }, (_, k) => G.ellipsePoint(e, k / 720 * 2 * Math.PI));
    });
    const hull = G.convexHull(pts);
    // wrong winding: every subpath must be anticlockwise on screen (negative shoelace in y-down)
    own.forEach(sp => { const A = sp.reduce((s, q, k) => { const r = sp[(k + 1) % sp.length]; return s + q.x * r.y - r.x * q.y; }, 0); if (A > 1e-6) stats[m.color].wrongWinding++; });
    const xs = hull.map(p => p.x), ys = hull.map(p => p.y);
    const x0 = Math.min(...xs) - 3, x1 = Math.max(...xs) + 3, y0 = Math.min(...ys) - 3, y1 = Math.max(...ys) + 3;
    let only = 0, miss = 0, area = 0;
    for (let y = y0; y < y1; y += 0.5) for (let x = x0; x < x1; x += 0.5) {
      const inHull = winding({ x, y }, hull) !== 0, inFill = own.reduce((w, sp) => w + winding({ x, y }, sp), 0) !== 0;
      if (inHull) area++;
      if (inFill && !inHull) only++;
      if (inHull && !inFill) miss++;
    }
    const st = stats[m.color];
    st.worstOnly = Math.max(st.worstOnly, only / 4); st.worstMiss = Math.max(st.worstMiss, miss / 4); st.area = Math.max(st.area, area / 4);
  }
}
console.log('per figure (px^2; area = hull area, onlyFill = filled outside the hull, missed = inside the hull but unfilled):');
for (const [color, s] of Object.entries(stats)) console.log(color, s.nodes + ' nodes', 'area', s.area.toFixed(0), 'onlyFill', s.worstOnly.toFixed(1), 'missed', s.worstMiss.toFixed(1), 'wrong-winding subpaths', s.wrongWinding);
fs.rmSync(dir, { recursive: true, force: true });
