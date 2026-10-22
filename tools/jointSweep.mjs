// Frame-to-frame continuity of the demo's squashed joint over a dense orbit: does the ring appear /
// disappear (fallback to the bisector), and how far do the touch points, ring and plane move
// between neighboring angles? Also the time per render. Run from a copy of the modules.
const R = await import('../render.js'), C = await import('../camera.js'), S = await import('../scene.js');
S.buildDemoScene();
const ctx = new Proxy({}, { get: (_, n) => (n === 'getTransform' ? () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) : () => {}), set: () => true });
const N = Number(process.argv[2] || 720), canvas = { width: 1000, height: 800 };
const jointId = 1;
let prev = null, noTouch = 0, worstTouch = 0, worstPlane = 0, worstCentroid = 0, jumps = [], tRender = 0, frontIsAFlips = 0;
for (let i = 0; i < N; i++) {
  C.camera.orbitAngle = (i / N) * Math.PI * 2;
  const t0 = performance.now();
  R.render(ctx, canvas, { darkMode: false });
  tRender += performance.now() - t0;
  const j = R.lastFrame.joints[jointId], c = j.curve;
  if (!c.hasTouch) { noTouch++; prev = null; continue; }
  const centroid = c.front.reduce((s, q) => ({ x: s.x + q.p.x / c.front.length, y: s.y + q.p.y / c.front.length }), { x: 0, y: 0 });
  const cur = { t0: c.touch[0].p, t1: c.touch[1].p, plane: c.plane, centroid, frontIsA: j.frontIsA };
  if (prev) {
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
    const dt = Math.max(d(cur.t0, prev.t0), d(cur.t1, prev.t1)), dp = Math.acos(Math.min(1, Math.abs(cur.plane.x * prev.plane.x + cur.plane.y * prev.plane.y + cur.plane.z * prev.plane.z))), dc = d(cur.centroid, prev.centroid);
    worstTouch = Math.max(worstTouch, dt); worstPlane = Math.max(worstPlane, dp); worstCentroid = Math.max(worstCentroid, dc);
    if (dt > 8 || dp > 0.1 || dc > 8) jumps.push({ i, ang: (i / N * Math.PI * 2).toFixed(3), dt: dt.toFixed(1), dp: dp.toFixed(3), dc: dc.toFixed(1) });
    if (cur.frontIsA !== prev.frontIsA) frontIsAFlips++;
  }
  prev = cur;
}
console.log({ frames: N, noTouchFrames: noTouch, frontIsAFlips, msPerFrame: (tRender / N).toFixed(2) });
console.log('largest step between neighbors: touch point', worstTouch.toFixed(2), 'px | plane', worstPlane.toFixed(3), 'rad | ring centroid', worstCentroid.toFixed(2), 'px');
console.log('jumps (touch > 8px, plane > 0.1 rad or centroid > 8px):', jumps.slice(0, 10));
