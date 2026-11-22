// What the headless browser offers: WebGL2 (renderer, MSAA samples) and WebGPU (adapter), per GPU mode.
import { launch } from './cdp.mjs';
for (const gpu of ['swiftshader', 'hardware']) {
  const b = await launch({ gpu, width: 400, height: 300 });
  await b.open('/tools/render/gpu/blank.html');
  const info = await b.eval(`(async () => {
    const c = document.createElement('canvas'), gl = c.getContext('webgl2');
    const r = { webgl2: !!gl };
    if (gl) { const d = gl.getExtension('WEBGL_debug_renderer_info'); r.renderer = d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); r.maxSamples = gl.getParameter(gl.MAX_SAMPLES); }
    r.webgpu = !!navigator.gpu;
    if (navigator.gpu) { try { const a = await navigator.gpu.requestAdapter(); r.adapter = a ? (a.info ? (a.info.vendor + ' ' + a.info.architecture + ' ' + (a.info.description || '')) : 'yes') : null; } catch (e) { r.adapter = 'error ' + e.message; } }
    return r; })()`);
  console.log(gpu, JSON.stringify(info));
  await b.close();
}
