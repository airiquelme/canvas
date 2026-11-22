// In-page comparison of two renderers (two copies of src/, or two backends of one), loaded in headless Chrome by pixelTest.mjs.
// Each side: { src: '/src' (a copy's URL), backend: 'canvas' | 'webgl2' | 'webgpu' }. Every view flies in for `frames` frames (so
// the per-frame reuse paths run) and the last frame of each side is compared:
//   flat: pixels farther than EDGE_R px from any color change of the reference that differ by more than TOL (must be 0: a wrong
//   fill, a hole, a seam); edge: the rest that differ (antialiasing); seam: pixels of the clear color left inside the ground (the
//   page clears to magenta when `magenta` is set).
const EDGE_R = 2, TOL = 3;

async function sideOf({ src, backend }, W, H) {
  const cam = await import(src + '/core/camera.js');
  const R = await import(src + '/illusion/illusionRender.js');
  const L = await import(src + '/illusion/light.js');
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  let draw;
  if (backend === 'canvas') {
    const ctx = canvas.getContext('2d');
    draw = (opts) => R.renderIllusion(ctx, canvas, opts);
  } else {
    const B = await import(src + '/gpu/backend.js');
    const be = await B.createBackend(backend, canvas, { preserveDrawingBuffer: true });
    draw = (opts) => be.render(R.buildIllusionFrame(canvas, opts), opts);
    draw.backend = be;
  }
  return { cam, R, L, canvas, draw };
}

function readPixels(canvas) {
  const c = document.createElement('canvas');
  c.width = canvas.width; c.height = canvas.height;
  const x = c.getContext('2d');
  x.drawImage(canvas, 0, 0);
  return x.getImageData(0, 0, c.width, c.height).data;
}

function edgeMask(a, W, H) {
  const m = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = 4 * (y * W + x);
    const d = (j) => Math.max(Math.abs(a[i] - a[j]), Math.abs(a[i + 1] - a[j + 1]), Math.abs(a[i + 2] - a[j + 2]));
    if ((x + 1 < W && d(i + 4) > 2) || (y + 1 < H && d(i + 4 * W) > 2)) m[y * W + x] = 1;
  }
  // grow by EDGE_R (both images' edges sit within a pixel or two of the true outline)
  const g = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m[y * W + x])
    for (let dy = -EDGE_R; dy <= EDGE_R; dy++) for (let dx = -EDGE_R; dx <= EDGE_R; dx++) {
      const X = x + dx, Y = y + dy;
      if (X >= 0 && Y >= 0 && X < W && Y < H) g[Y * W + X] = 1;
    }
  return g;
}

export async function compare({ a, b, views, W = 1600, H = 900, frames = 12, night = false, diffImages = false }) {
  const A = await sideOf(a, W, H), B = await sideOf(b, W, H);
  const out = [];
  for (const S of [A, B]) {
    if (night) S.L.setSun(S.L.light.azimuth, -0.1);
    S.g = S.R.buildMeadowScene();
  }
  for (const [vi, [ex, ez, up, tx, tz]] of views.entries()) {
    for (let f = 0; f < frames; f++) {
      const x = ex + f * 3, z = ez + f * 2;
      for (const S of [A, B]) {
        S.cam.camera.position = { x, y: S.g(x, z) + up, z };
        S.cam.camera.target = { x: tx, y: S.g(tx, tz), z: tz };
        S.draw({ time: 0 });
      }
    }
    const pa = readPixels(A.canvas), pb = readPixels(B.canvas), edge = edgeMask(pa, W, H);
    let flat = 0, edgeDiff = 0, max = 0;
    const samples = [];
    const img = diffImages ? new ImageData(W, H) : null;
    for (let k = 0; k < W * H; k++) {
      const i = 4 * k, d = Math.max(Math.abs(pa[i] - pb[i]), Math.abs(pa[i + 1] - pb[i + 1]), Math.abs(pa[i + 2] - pb[i + 2]));
      if (d > TOL) { if (edge[k]) edgeDiff++; else { flat++; if (samples.length < 12 && flat % 37 === 1) samples.push([k % W, Math.floor(k / W), [pa[i], pa[i + 1], pa[i + 2]], [pb[i], pb[i + 1], pb[i + 2]]]); } }
      if (d > max) max = d;
      if (img) { const v = Math.min(255, d * 4); img.data[i] = edge[k] ? v : 255 * (d > TOL); img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255; }
    }
    const r = { view: vi, flat, edge: edgeDiff, max, samples };
    if (diffImages && samples.length) {   // 8x crops (a above b) around the first flat differences
      const Z = 8, R = 12, c = document.createElement('canvas');
      c.width = 2 * R * Z * Math.min(4, samples.length); c.height = 4 * R * Z;
      const x = c.getContext('2d');
      x.imageSmoothingEnabled = false;
      samples.slice(0, 4).forEach(([px, py], i) => {
        x.drawImage(A.canvas, px - R, py - R, 2 * R, 2 * R, i * 2 * R * Z, 0, 2 * R * Z, 2 * R * Z);
        x.drawImage(B.canvas, px - R, py - R, 2 * R, 2 * R, i * 2 * R * Z, 2 * R * Z, 2 * R * Z, 2 * R * Z);
      });
      r.crops = c.toDataURL();
    }
    if (img) { const c = document.createElement('canvas'); c.width = W; c.height = H; c.getContext('2d').putImageData(img, 0, 0); r.diff = c.toDataURL(); r.a = A.canvas.toDataURL(); r.b = B.canvas.toDataURL(); }
    out.push(r);
  }
  return out;
}
