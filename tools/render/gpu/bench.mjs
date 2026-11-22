// Frame timings per backend in headless Chrome on the machine's GPU (`npm run bench`): node tools/render/gpu/bench.mjs [backends...]
import { launch } from './cdp.mjs';
const kinds = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const list = kinds.length ? kinds : ['canvas', 'webgl2', 'webgpu'];
const gpu = (process.argv.find((a) => a.startsWith('--gpu=')) || '--gpu=hardware').split('=')[1];
for (const backend of list) {
  const b = await launch({ gpu, width: 1600, height: 900 });
  await b.open('/tools/render/gpu/blank.html');
  try {
    const r = await b.eval(`import('/tools/render/gpu/bench.js').then((m) => m.bench(${JSON.stringify({ backend })}))`);
    const f = (s) => `${String(s.mean).padStart(6)} (p95 ${String(s.p95).padStart(6)}, max ${String(s.max).padStart(6)})`;
    console.log(`${backend.padEnd(7)} build ${f(r.build)}  draw ${f(r.draw)}  total ${f(r.total)} ms`);
  } catch (e) { console.log(`${backend.padEnd(7)} ERROR ${e.message.split('\n')[0]}`); }
  await b.close();
}
process.exit(0);
