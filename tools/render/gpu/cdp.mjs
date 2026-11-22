// Headless Chrome for the GPU tests, with no npm dependency: a static file server for the project folder and the installed Chrome
// driven over the DevTools protocol (Node's built-in WebSocket).
//
//   const b = await launch({ gpu: 'swiftshader' | 'hardware', width, height });
//   await b.open('/tools/render/gpu/page.html?backend=webgl2');
//   const v = await b.eval('window.result');          // awaits promises
//   await b.screenshot('out.png');
//   await b.close();
//
// gpu 'swiftshader': software WebGL2 / WebGPU (deterministic pixels, for the pixel tests); 'hardware': the machine's GPU (timings).
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../..');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css' };

export function serve(root = ROOT) {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(root, url === '/' ? '/index.html' : url);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port })));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ gpu = 'swiftshader', width = 1600, height = 900, root = ROOT } = {}) {
  const { server, port } = await serve(root);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-test-'));
  const debugPort = 9300 + Math.floor(Math.random() * 500);
  const flags = [
    '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--enable-unsafe-webgpu', '--ignore-gpu-blocklist',
    ...(gpu === 'swiftshader'
      ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan']
      : ['--use-angle=d3d11', '--enable-gpu-rasterization']),
    'about:blank',
  ];
  const proc = spawn(CHROME, flags, { stdio: 'ignore' });
  let ws = null;
  for (let i = 0; i < 100 && !ws; i++) {
    await sleep(100);
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
    } catch { /* not up yet */ }
  }
  if (!ws) throw new Error('Chrome did not start');
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  let id = 0;
  const pending = new Map(), logs = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.consoleAPICalled') logs.push(msg.params.type + ': ' + msg.params.args.map((a) => a.value ?? a.description).join(' '));
    if (msg.method === 'Runtime.exceptionThrown') logs.push('exception: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
  };
  const send = (method, params = {}) => new Promise((ok) => { const i = ++id; pending.set(i, ok); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const api = {
    logs,
    async open(url) {
      await send('Page.navigate', { url: `http://127.0.0.1:${port}${url}` });
      for (let i = 0; i < 300; i++) {   // until the document is complete
        const r = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
        if (r.result?.result?.value === 'complete') break;
        await sleep(50);
      }
    },
    async eval(expression, timeout = 600000) {
      const r = await Promise.race([
        send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
        sleep(timeout).then(() => ({ timeout: true })),
      ]);
      if (r.timeout) throw new Error('eval timed out: ' + expression.slice(0, 80));
      if (r.result?.exceptionDetails) throw new Error((r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text) + '\n' + logs.join('\n'));
      return r.result?.result?.value;
    },
    async screenshot(file) {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    },
    async close() {
      await Promise.race([send('Browser.close'), sleep(2000)]);
      ws.close(); server.closeAllConnections(); server.close();
      await sleep(300);
      try { proc.kill(); } catch { /* gone */ }
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* locked */ }
    },
  };
  return api;
}
