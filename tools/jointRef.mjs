// Ground truth for squashed joints. Builds a small V of two 2-node meshes sharing a joint node
// (some nodes squashed), renders it with the real renderer into a recording context, point-samples
// the painted colors (last nonzero fill wins), and compares them with an exact ray cast of the
// joint's flat solid: along each pixel's ray (the camera looks along -z), the nearer of the two
// hulls (joint.curve.general.coneA / coneB) gives the color. Boundary pixels (the colors
// within 0.6 px differ) are not counted.
// Usage: node tools/jointRef.mjs <srcDir> [variant] [steps] [png-prefix]
// Env: STEP (pixel step, default 3), ANGLE (one camera angle instead of the orbit), ROWS=y0,y1,x0,x1 (print, per
// row, where the painted and the reference color change, at 1 px steps, for that window).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

const [srcDir, variantArg = 'all', stepsArg = '6', pngPrefix] = process.argv.slice(2);
const steps = Number(stepsArg);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jref-'));
fs.readdirSync(srcDir).filter(f => f.endsWith('.js')).forEach(f => fs.copyFileSync(path.join(srcDir, f), path.join(dir, f)));
fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
const load = (f) => import(pathToFileURL(path.join(dir, f)).href);
const R = await load('render.js'), C = await load('camera.js'), S = await load('scene.js'), H = await load('hullCone.js');

// ---- recording context with a transform stack; fills are stored as polygons in screen space
let fills, subs, cur, M = [1, 0, 0, 1, 0, 0];
const stack = [];
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const P = (x, y) => ({ x: M[0] * x + M[2] * y + M[4], y: M[1] * x + M[3] * y + M[5] });
const tess = (cx, cy, a, b, rot, t0, t1, ccw) => {
  let d = t1 - t0;
  if (ccw) { while (d > 0) d -= 2 * Math.PI; while (d < -2 * Math.PI) d += 2 * Math.PI; } else { while (d < 0) d += 2 * Math.PI; }
  const n = Math.max(2, Math.ceil(Math.abs(d) / 0.01)), pts = [];
  for (let i = 0; i <= n; i++) { const t = t0 + d * i / n, x = a * Math.cos(t), y = b * Math.sin(t); pts.push(P(cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot))); }
  return pts;
};
const ctx = {
  fillStyle: null,
  getTransform: () => ({ a: M[0], b: M[1], c: M[2], d: M[3], e: M[4], f: M[5] }),
  setTransform(a, b, c, d, e, f) { M = [a, b, c, d, e, f]; },
  transform(a, b, c, d, e, f) { M = mul(M, [a, b, c, d, e, f]); },
  translate(x, y) { M = mul(M, [1, 0, 0, 1, x, y]); }, scale(x, y) { M = mul(M, [x, 0, 0, y, 0, 0]); },
  save() { stack.push(M.slice()); }, restore() { M = stack.pop(); },
  beginPath() { subs = []; cur = null; },
  moveTo(x, y) { cur = [P(x, y)]; subs.push(cur); },
  lineTo(x, y) { if (!cur) { cur = []; subs.push(cur); } cur.push(P(x, y)); },
  arc(x, y, r, a0, a1, ccw) { if (!cur) { cur = []; subs.push(cur); } cur.push(...tess(x, y, r, r, 0, a0, a1, ccw)); },
  ellipse(x, y, a, b, rot, a0, a1, ccw) { if (!cur) { cur = []; subs.push(cur); } cur.push(...tess(x, y, a, b, rot, a0, a1, ccw)); },
  closePath() { cur = null; },
  fill() { fills.push({ color: this.fillStyle, subs: subs.map(p => p.slice()) }); },
  fillRect() {}, stroke() {}, setLineDash() {}, clip() {},
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

// ---- scene variants: [joint, blue end, orange end], each { r, squash, axis }
const variants = {
  jointSquashed: [{ r: 55, squash: 0.5 }, { r: 40 }, { r: 36 }],
  jointFlat: [{ r: 55, squash: 0.3, axis: { x: 1, y: 1, z: 0 } }, { r: 40 }, { r: 36 }],
  jointStretched: [{ r: 50, squash: 1.7, axis: { x: 0, y: 0, z: 1 } }, { r: 40 }, { r: 36 }],
  farSquashed: [{ r: 55 }, { r: 42, squash: 0.45 }, { r: 38, squash: 1.6, axis: { x: 1, y: 0, z: 0 } }],
  // the demo's blue/orange V (scene.js buildDemoScene) with its squashed joint and blue end
  demoV: [{ r: 56, squash: 0.7, axis: { x: 1, y: 1, z: 0 }, at: { x: 320, y: 480, z: 0 } }, { r: 48, squash: 1.5, axis: { x: 1, y: 0, z: 0 }, at: { x: 144, y: 320, z: 0 } }, { r: 40, at: { x: 496, y: 320, z: 64 } }],
  allSquashed: [{ r: 55, squash: 0.55, axis: { x: 0, y: 1, z: 0 } }, { r: 42, squash: 0.5, axis: { x: 1, y: 1, z: 0 } }, { r: 38, squash: 1.5, axis: { x: 1, y: 0, z: 1 } }],
};
const COLOR_A = '#4fc3f7', COLOR_B = '#ff8a65';
function buildScene(spec) {
  for (const k of Object.keys(S.nodes)) delete S.nodes[k];
  for (const k of Object.keys(S.meshes)) delete S.meshes[k];
  const at = [{ x: 500, y: 400, z: 0 }, { x: 370, y: 290, z: 20 }, { x: 630, y: 290, z: -30 }];
  const ids = spec.map((s, i) => S.createNode(s.at ?? at[i], s.r, { squash: s.squash ?? 1, axis: s.axis ?? { x: 0, y: 1, z: 0 } }));
  S.createMesh([ids[1], ids[0]], COLOR_A);
  S.createMesh([ids[0], ids[2]], COLOR_B);
  return ids;
}

// ---- reference: nearer hull along the ray
function rayHit(cone, x, y, zLo, zHi) {
  const f = (z) => H.hullSigned(cone, { x, y, z });
  let lo = zLo, hi = zHi;
  for (let it = 0; it < 22; it++) {      // minimum of a convex function
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (f(m1) < f(m2)) hi = m2; else lo = m1;
  }
  const zMin = (lo + hi) / 2;
  if (f(zMin) > 0) return null;
  let a = zMin, b = zHi;                  // upper root (nearest to the camera, +z)
  for (let it = 0; it < 22; it++) { const m = (a + b) / 2; if (f(m) <= 0) a = m; else b = m; }
  return (a + b) / 2;
}
const BG = 'bg';
// Where both hulls end at the same depth the visible surface is the joint body's own, which the
// renderer splits by the ring's plane (the side holding A's far center is A's color).
function refColor(gen, plane, T0, x, y, zLo, zHi) {
  const zA = rayHit(gen.coneA, x, y, zLo, zHi), zB = rayHit(gen.coneB, x, y, zLo, zHi);
  if (zA === null && zB === null) return BG;
  if (zB === null) return COLOR_A;
  if (zA === null) return COLOR_B;
  if (Math.abs(zA - zB) < 0.05) {
    const side = (q) => (q.x - T0.x) * plane.x + (q.y - T0.y) * plane.y + (q.z - T0.z) * plane.z;
    return side({ x, y, z: zA }) * side(gen.FA.center) > 0 ? COLOR_A : COLOR_B;
  }
  return zA > zB ? COLOR_A : COLOR_B;
}

function crc(buf) { return zlib.crc32(buf); }
function png(file, w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
const RGB = { [COLOR_A]: [79, 195, 247], [COLOR_B]: [255, 138, 101], [BG]: [255, 255, 255] };

const names = variantArg === 'all' ? Object.keys(variants) : [variantArg];
const canvas = { width: 1000, height: 800 };
const STEP = Number(process.env.STEP || 3);
for (const name of names) {
  const ids = buildScene(variants[name]);
  let total = 0, bad = 0, worstFrame = 0, worstAng = 0;
  for (let fi = 0; fi < (process.env.ANGLE ? 1 : steps); fi++) {
    const ang = process.env.ANGLE ? Number(process.env.ANGLE) : (fi / steps) * Math.PI * 2 + 0.31;
    C.camera.orbitAngle = ang;
    fills = []; M = [1, 0, 0, 1, 0, 0];
    R.render(ctx, canvas, { darkMode: false });
    const frame = R.lastFrame, joint = frame.joints[ids[0]];
    if (!joint || !joint.curve.general) { console.log(name, 'angle', ang.toFixed(2), 'no general joint'); continue; }
    const gen = joint.curve.general;
    // region: bbox of the three node ellipses
    const boxes = ids.map(id => { const p = frame.projected[id], r = Math.max(p.ellipse.a, p.ellipse.b); return [p.center.x - r, p.center.y - r, p.center.x + r, p.center.y + r]; });
    const x0 = Math.floor(Math.min(...boxes.map(b => b[0]))) - 2, y0 = Math.floor(Math.min(...boxes.map(b => b[1]))) - 2;
    const x1 = Math.ceil(Math.max(...boxes.map(b => b[2]))) + 2, y1 = Math.ceil(Math.max(...boxes.map(b => b[3]))) + 2;
    const zs = [gen.N, gen.FA, gen.FB].flatMap(b => [b.center.z - Math.max(...b.shape.axes), b.center.z + Math.max(...b.shape.axes)]);
    const zLo = Math.min(...zs) - 5, zHi = Math.max(...zs) + 5;
    const painted = (x, y) => {
      let c = BG;
      for (const f of fills) { const w = f.subs.reduce((s, sp) => s + (sp.length > 2 ? winding({ x, y }, sp) : 0), 0); if (w !== 0) c = f.color; }
      return c;
    };
    if (process.env.ROWS) {
      const [ry0, ry1, rx0, rx1] = process.env.ROWS.split(',').map(Number);
      for (let y = ry0; y <= ry1; y += 4) {
        const row = (f) => { const out = []; let last = null; for (let x = rx0; x <= rx1; x++) { const c = f(x + 0.5, y + 0.5); if (c !== last) { out.push(x + ':' + (c === COLOR_A ? 'A' : c === COLOR_B ? 'B' : '.')); last = c; } } return out.join(' '); };
        console.log('y', y, '| painted', row(painted), '| reference', row((px, py) => refColor(gen, joint.curve.plane, joint.curve.touch[0].p, px, py, zLo, zHi)));
      }
    }
    const W = x1 - x0, Hh = y1 - y0;
    const img = pngPrefix ? Buffer.alloc(W * Hh * 4 * 3) : null;
    const rgbaW = W * 3;
    let nBad = 0, nTot = 0;
    for (let y = y0; y < y1; y += STEP) for (let x = x0; x < x1; x += STEP) {
      const px = x + 0.5, py = y + 0.5;
      const dc = painted(px, py), rc = refColor(gen, joint.curve.plane, joint.curve.touch[0].p, px, py, zLo, zHi);
      nTot++;
      let robust = false;
      if (dc !== rc) {
        const dj = [[0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6]];
        const refs = new Set([rc, ...dj.map(([a, b]) => refColor(gen, joint.curve.plane, joint.curve.touch[0].p, px + a, py + b, zLo, zHi))]);
        const drs = new Set([dc, ...dj.map(([a, b]) => painted(px + a, py + b))]);
        robust = !refs.has(dc) && !drs.has(rc);
      }
      if (robust) nBad++;
      if (img) for (let dy = 0; dy < STEP; dy++) for (let dx = 0; dx < STEP; dx++) {
        const ix = x - x0 + dx, iy = y - y0 + dy; if (ix >= W || iy >= Hh) continue;
        const put = (col, rgb) => { const o = (iy * rgbaW + col * W + ix) * 4; img[o] = rgb[0]; img[o + 1] = rgb[1]; img[o + 2] = rgb[2]; img[o + 3] = 255; };
        put(0, RGB[dc]); put(1, RGB[rc]); put(2, robust ? [255, 0, 0] : (dc === rc ? [235, 235, 235] : [255, 230, 120]));
      }
    }
    total += nTot; bad += nBad;
    if (nBad > worstFrame) { worstFrame = nBad; worstAng = ang; }
    if (img && (pngPrefix)) png(`${pngPrefix}-${name}-${fi}.png`, rgbaW, Hh, img);
    console.log(name.padEnd(15), 'angle', ang.toFixed(2), 'samples', nTot, 'robust mismatches', nBad, '(' + (100 * nBad / nTot).toFixed(2) + '%)', 'front', joint.frontIsA ? 'A(blue)' : 'B(orange)');
  }
  console.log('==', name, 'total mismatches', bad, 'of', total, '| worst frame', worstFrame, 'at angle', worstAng.toFixed(2));
}
fs.rmSync(dir, { recursive: true, force: true });
