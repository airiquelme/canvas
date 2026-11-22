// In-page measurement of the grass tips' texture density by distance (run by grassDensity.mjs). Per view and distance band: the
// ground pixels whose ground (a ray cast against the meadow's height) is in the band, and the pixels covered by the lines of the
// blades in the band alone (drawn with only those, grass.js tipTuning.band, against the frame without grass: |on - off| over the
// pixel's full difference to the lines' shade tone, capped at 1). Lines stand up over farther ground, so a pixel's own ground
// distance would credit near lines to far bands.
export async function measure({ W = 1600, H = 900, views, share = null, density = null, bands, step = 5, eyeUp = 52.3 }) {
  const cam = await import('/src/core/camera.js');
  const R = await import('/src/illusion/illusionRender.js');
  const G = await import('/src/illusion/grass.js');
  const L = await import('/src/illusion/light.js');
  const rgb = (css) => { const c = document.createElement('canvas').getContext('2d'); c.fillStyle = css; c.fillRect(0, 0, 1, 1); return c.getImageData(0, 0, 1, 1).data; };
  const { DESIGN_WIDTH, DESIGN_HEIGHT } = await import('/src/config.js');
  if (share) G.tipTuning.share = share;
  if (density) G.tipTuning.density = density;   // before the scene is built: the patches' blade counts
  const groundAt = R.buildMeadowScene({ edits: null });
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const nb = bands.length - 1, ground = new Float64Array(nb), cover = new Float64Array(nb);
  const fit = Math.min(W / DESIGN_WIDTH, H / DESIGN_HEIGHT);
  const perView = [];
  for (const view of views) {
    const [x, z, yaw, pitch] = view;
    const eye = { x, y: groundAt(x, z) + eyeUp, z }, Rr = cam.camera.orbitRadius;
    cam.camera.position = eye;
    cam.camera.target = { x: x + Math.cos(pitch) * Math.cos(yaw) * Rr, y: eye.y + Math.sin(pitch) * Rr, z: z + Math.cos(pitch) * Math.sin(yaw) * Rr };
    // the reference: grass on with no blade in its band (the same paths as the band frames: ground reuse, batches), drawn twice
    R.grass.tips = true; R.grass.on = true; G.tipTuning.band = [-2, -1];
    R.renderIllusion(ctx, canvas, { time: 0 });
    R.renderIllusion(ctx, canvas, { time: 0 });
    const off = ctx.getImageData(0, 0, W, H).data;
    let noise = 0;
    R.renderIllusion(ctx, canvas, { time: 0 });
    { const o2 = ctx.getImageData(0, 0, W, H).data; for (let i = 0; i < o2.length; i += 4) if (o2[i] !== off[i] || o2[i + 1] !== off[i + 1] || o2[i + 2] !== off[i + 2]) noise++; }
    if (noise) console.log('reference not repeatable: ' + noise + ' px');
    // the lines' color: the shade tone of the meadow's green (one green); a pixel's full difference is its ground color's distance to
    // it (ground already in that tone can't show lines)
    const [sr, sg, sb] = rgb(L.shadeOf(R.sceneTerrain().leafNodes[0].patch.fill));
    // a band reaching the screen's bottom edge is left out of this view: lines of blades standing below the edge reach into it
    const vGround = new Float64Array(nb), atBottom = new Uint8Array(nb);
    const basis = cam.computeViewBasis(eye, cam.camera.target), s = cam.camera.orbitRadius * cam.camera.zoom;
    for (let py = 0; py < H; py += step) for (let px = 0; px < W; px += step) {
      const dx = (px + 0.5 - W / 2) / fit / s, dy = -(py + 0.5 - H / 2) / fit / s;   // X / Z, Y / Z
      let vx = basis.forward.x + basis.right.x * dx + basis.up.x * dy, vy = basis.forward.y + basis.right.y * dx + basis.up.y * dy,
        vz = basis.forward.z + basis.right.z * dx + basis.up.z * dy;
      const l = Math.hypot(vx, vy, vz); vx /= l; vy /= l; vz /= l;
      if (vy >= 0.02) continue;   // up from the horizon: sky (the meadow's hills are low)
      // march (steps of 0.7 of the height over the ground: the hills are gentle), then bisect the crossing
      let t = 1, t0 = 1, hit = -1;
      const over = (t) => eye.y + vy * t - groundAt(eye.x + vx * t, eye.z + vz * t);
      while (t < 6000) {
        const h = over(t);
        if (h <= 0) { let a = t0, b = t; for (let i = 0; i < 8; i++) { const m = (a + b) / 2; if (over(m) <= 0) b = m; else a = m; } hit = b; break; }
        t0 = t; t += Math.max(1, 0.7 * h);
      }
      if (hit < 0) continue;
      const X = eye.x + vx * hit, Z = eye.z + vz * hit;
      if (X < -1300 || X > 2300 || Z < -1800 || Z > 1800) continue;   // past the map
      let b = -1;
      for (let k = 0; k < nb; k++) if (hit >= bands[k] && hit < bands[k + 1]) { b = k; break; }
      if (b < 0) continue;
      const i = 4 * (py * W + px), full = Math.max(Math.abs(off[i] - sr), Math.abs(off[i + 1] - sg), Math.abs(off[i + 2] - sb));
      if (full < 12) continue;   // ground in the lines' own tone (shade): nothing to see either way
      vGround[b]++;
      if (py + step >= H) atBottom[b] = 1;
    }
    for (let b = 0; b < nb; b++) {   // the band's lines alone, every pixel
      if (atBottom[b] || !vGround[b]) continue;
      ground[b] += vGround[b];
      G.tipTuning.band = [bands[b], bands[b + 1]];
      R.renderIllusion(ctx, canvas, { time: 0 });
      const on = ctx.getImageData(0, 0, W, H).data;
      let c = 0;
      for (let i = 0; i < on.length; i += 4) {
        const d = Math.max(Math.abs(on[i] - off[i]), Math.abs(on[i + 1] - off[i + 1]), Math.abs(on[i + 2] - off[i + 2]));
        if (d < 3) continue;
        const full = Math.max(Math.abs(off[i] - sr), Math.abs(off[i + 1] - sg), Math.abs(off[i + 2] - sb));
        if (full >= 12) c += Math.min(1, d / full);
      }
      cover[b] += c / (step * step);
      perView.push([views.indexOf(view), b, vGround[b], c / (step * step)]);   // in the ground count's units (one sample per step x step pixels)
    }
    G.tipTuning.band = null;
  }
  return { ground: [...ground], cover: [...cover], perView };
}
