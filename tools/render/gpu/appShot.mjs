// Loads the app (index.html) in headless Chrome, waits, prints errors and the tracker's text, and saves a screenshot.
//   node tools/render/gpu/appShot.mjs [query] [out.png] [--gpu=hardware|swiftshader]
import { launch, ROOT } from './cdp.mjs';
import path from 'node:path';
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const gpu = (process.argv.find((a) => a.startsWith('--gpu=')) || '--gpu=hardware').split('=')[1];
const b = await launch({ gpu, width: 1400, height: 800 });
await b.open('/index.html' + (args[0] || ''));
await new Promise((r) => setTimeout(r, 4000));
try { console.log('tracker:', await b.eval(`[...document.querySelectorAll('div')].map((d) => d.textContent).find((t) => / fps/.test(t)) || 'none'`)); } catch (e) { console.log('ERR', e.message); }
await b.screenshot(path.join(ROOT, 'tools/render/gpu/out', args[1] || 'app.png'));
console.log(b.logs.filter((l) => !/DevTools|Download/.test(l)).slice(0, 10).join('\n') || 'no console messages');
await b.close(); process.exit(0);
