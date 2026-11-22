// Pixel tests of the renderers in headless Chrome (`npm run test:render`, or with arguments):
//   node tools/render/gpu/pixelTest.mjs [A] [B] [--gpu=swiftshader|hardware] [--night] [--images] [--samples] [--max-flat=N]
// A, B: "<src url>:<backend>", default "/src:canvas" vs "/src:webgl2". The reference copy of src/ before a refactor can be put at
// tools/render/gpu/out/ref/src (then "/tools/render/gpu/out/ref/src:canvas"). Prints per view the pixels that differ in flat areas
// (must be 0) and along edges; --images writes a | b | diff PNGs to tools/render/gpu/out/.
import fs from 'node:fs';
import path from 'node:path';
import { launch, ROOT } from './cdp.mjs';

const args = process.argv.slice(2);
const pos = args.filter((x) => !x.startsWith('--'));
const flag = (k) => args.find((x) => x.startsWith('--' + k));
const side = (s) => { const i = s.lastIndexOf(':'); return { src: s.slice(0, i), backend: s.slice(i + 1) }; };
const a = side(pos[0] || '/src:canvas'), b = side(pos[1] || '/src:webgl2');
const gpu = (flag('gpu') || '--gpu=hardware').split('=')[1];
const night = !!flag('night'), images = !!flag('images');
const maxFlat = Number((flag('max-flat') || '--max-flat=0').split('=')[1]);   // flat-area pixels allowed per view (GPU antialiasing of hairlines)
const views = [[1200, 0, 60, 500, 0], [1200, 0, 300, 300, 400], [-400, -900, 200, 500, 0], [500, 1300, 40, 400, -600],
  [-1500, 1500, 30, 1500, -1500], [700, -200, 12, 600, -200]];

const br = await launch({ gpu, width: 400, height: 300 });
let fails = 0;
try {
  await br.open('/tools/render/gpu/blank.html');
  const res = await br.eval(`import('/tools/render/gpu/compare.js').then((m) => m.compare(${JSON.stringify({ a, b, views, night, diffImages: images })}))`);
  const outDir = path.join(ROOT, 'tools/render/gpu/out');
  fs.mkdirSync(outDir, { recursive: true });
  for (const r of res) {
    console.log(`view ${r.view}: flat ${r.flat}  edge ${r.edge}  max ${r.max}`);
    if (r.flat > maxFlat) fails++;
    if (flag('samples')) for (const q of r.samples) console.log('   ', JSON.stringify(q));
    if (images && r.crops) fs.writeFileSync(path.join(outDir, `v${r.view}${night ? 'n' : ''}_crops.png`), Buffer.from(r.crops.split(',')[1], 'base64'));
    if (images) for (const k of ['a', 'b', 'diff']) fs.writeFileSync(path.join(outDir, `v${r.view}${night ? 'n' : ''}_${k}.png`), Buffer.from(r[k].split(',')[1], 'base64'));
  }
} catch (e) { console.log('ERROR ' + e.message); fails++; }
if (br.logs.length) console.log(br.logs.slice(0, 10).join('\n'));
await br.close();
console.log(fails ? `${fails} view(s) with flat-area differences` : 'pixel test passed');
process.exit(fails ? 1 : 0);
