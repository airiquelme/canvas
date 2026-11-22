// The illusion renderer's backends: 'webgl2', 'webgpu' (src/gpu/) or 'canvas' (Canvas 2D, illusionRender.js `drawIllusion2D`, the
// reference). `createBackend(kind, canvas)`: that backend, or null when the browser can't run it; `bestBackend(canvas, wanted)`:
// the wanted one, else the next in WebGL2 -> WebGPU -> Canvas 2D. WebGL2 comes first: on the test machine (RTX 4060, Chrome) it
// was a little faster than WebGPU (15.1 vs 17.3 ms per frame, flying over the meadow) with 8 samples per pixel instead of 4. A
// canvas can only hold one kind of context, so a backend owns its canvas.
import { createWebGL2 } from './webgl2.js';

export async function createBackend(kind, canvas, opts = {}) {
  if (kind === 'webgl2') return createWebGL2(canvas, opts);
  if (kind === 'webgpu') {
    const { createWebGPU } = await import('./webgpu.js');
    return createWebGPU(canvas, opts);
  }
  if (kind === 'canvas') {
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const { drawIllusion2D } = await import('../illusion/illusionRender.js');
    return { name: 'canvas', ctx, render: (F) => drawIllusion2D(ctx, canvas, F) };
  }
  return null;
}

export const ORDER = ['webgl2', 'webgpu', 'canvas'];
export async function bestBackend(canvas, wanted = null) {
  const order = wanted ? [wanted, ...ORDER.filter((k) => k !== wanted)] : ORDER;
  for (const k of order) {
    try { const b = await createBackend(k, canvas); if (b) return b; } catch (e) { console.warn(`backend ${k} failed:`, e); }
  }
  return null;
}
