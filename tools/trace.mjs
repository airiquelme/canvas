// Records the canvas calls of every frame over the camera orbit, for diffing two
// copies of the renderer. Usage: node tools/trace.mjs <srcDir> <out.json> [steps]
// The modules are copied to a temp dir first (with a "type":"module" package.json),
// so nothing is written next to the sources.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [srcDir, out, stepsArg] = process.argv.slice(2);
const steps = Number(stepsArg || 120);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-'));
fs.readdirSync(srcDir).filter(f => f.endsWith('.js')).forEach(f => fs.copyFileSync(path.join(srcDir, f), path.join(dir, f)));
fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
const load = (f) => import(pathToFileURL(path.join(dir, f)).href);

const { render } = await load('render.js');
const { camera } = await load('camera.js');
const scene = await load('scene.js');
scene.buildDemoScene();
// SPHERES=1: every node made a sphere again, to compare against a copy without shapes.
if (process.env.SPHERES) {
  const { makeShape } = await load('geometry.js');
  Object.values(scene.nodes).forEach(n => { n.shape = makeShape(n.radius, 1, { x: 0, y: 1, z: 0 }); });
}

const round = (v) => (typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v);
let log;
const ctx = new Proxy({}, {
  get: (_, name) => (name === 'getTransform' ? () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
    : (...args) => { log.push([name, ...args.map(round)]); }),
  set: (_, name, value) => { log.push(['=' + String(name), value]); return true; },
});
const canvas = { width: 1000, height: 800 };

const frames = [];
for (let i = 0; i < steps; i++) {
  camera.orbitAngle = (i / steps) * Math.PI * 2;
  log = [];
  render(ctx, canvas, { darkMode: false });
  frames.push(log);
}
fs.writeFileSync(out, JSON.stringify(frames));
fs.rmSync(dir, { recursive: true, force: true });
console.log(`${frames.length} frames, ${frames.reduce((n, f) => n + f.length, 0)} calls`);
