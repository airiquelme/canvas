// In-page timing of one backend over the flying views (bench.mjs). Per frame: build (the frame's JS, buildIllusionFrame), draw (the
// backend's JS: Canvas 2D calls, or tessellation + GPU commands), total (until the GPU / rasterizer is done: a 1-pixel readback).
export async function bench({ backend, W = 1600, H = 900, frames = 40, src = '/src', pixel }) {
  const cam = await import(src + '/core/camera.js');
  const R = await import(src + '/illusion/illusionRender.js');
  const B = await import(src + '/gpu/backend.js');
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  document.body.append(canvas);
  const be = await B.createBackend(backend, canvas);
  const sync = backend === 'canvas' ? (() => { const x = be.ctx.getImageData(0, 0, 1, 1); return x; }) : backend === 'webgl2' ? be.readPixel : be.sync;
  if (pixel !== undefined && R.groundShade) R.groundShade.pixel = pixel;   // per-pixel ground shade (webgl2)
  const g = R.buildMeadowScene();
  const views = [[1200, 0, 60, 500, 0], [1200, 0, 300, 300, 400], [-400, -900, 200, 500, 0], [500, 1300, 40, 400, -600], [-1500, 1500, 30, 1500, -1500], [700, -200, 12, 600, -200]];
  const acc = { build: [], draw: [], total: [] };
  for (const [ex, ez, up, tx, tz] of views) for (let f = 0; f < frames; f++) {
    const x = ex + f * 3, z = ez + f * 2;
    cam.camera.position = { x, y: g(x, z) + up, z }; cam.camera.target = { x: tx, y: g(tx, tz), z: tz };
    const t0 = performance.now();
    const F = R.buildIllusionFrame(canvas, { time: f / 60 });
    const t1 = performance.now();
    be.render(F, {});
    const t2 = performance.now();
    await sync();
    const t3 = performance.now();
    if (f >= 5) { acc.build.push(t1 - t0); acc.draw.push(t2 - t1); acc.total.push(t3 - t0); }
  }
  const stat = (a) => { const s = [...a].sort((p, q) => p - q); return { mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2), p95: +s[Math.floor(0.95 * s.length)].toFixed(2), max: +s[s.length - 1].toFixed(2) }; };
  return { backend, build: stat(acc.build), draw: stat(acc.draw), total: stat(acc.total) };
}
