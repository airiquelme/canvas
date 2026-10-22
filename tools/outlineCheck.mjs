// Exact outline math (geometry.js): ellipse common tangents (quartic), tangents from a point, the hull outline of
// ellipses / arcs / polygons against a dense brute-force hull, and the conic of a projected circle against sampled
// perspective projections. Run from a copy of the modules (see trace.mjs).
import * as G from '../geometry.js';

const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
const mkE = () => { const a = rnd(5, 70); return { center: { x: rnd(0, 120), y: rnd(0, 120) }, a, b: rnd(1.5, 1) * Math.min(a, rnd(3, 70)), angle: rnd(0, 6.28) }; };
const TWO = Math.PI * 2;
const norm = (a) => ((a % TWO) + TWO) % TWO;

// 1. common tangents of two ellipses: roots of g, count against a dense scan
{
  let cases = 0, miss = 0, extra = 0, worst = 0;
  for (let t = 0; t < 4000; t++) {
    const e1 = mkE(), e2 = mkE(), g = (th) => G.ellipseSupport(e2, th) - G.ellipseSupport(e1, th);
    const roots = G.ellipseTangentAngles(e1, e2);
    let scan = 0, prev = g(0);
    for (let i = 1; i <= 20000; i++) { const cur = g((i / 20000) * TWO); if ((prev < 0) !== (cur < 0)) scan++; prev = cur; }
    cases++;
    if (roots.length < scan) miss++; else if (roots.length > scan) extra++;
    roots.forEach(r => { worst = Math.max(worst, Math.abs(g(r))); });
  }
  console.log('1 ellipse common tangents:', { cases, missedVsScan: miss, extraVsScan: extra, worstResidual: worst.toExponential(1) });
}
// 2. tangents from a point
{
  let worst = 0, bad = 0;
  for (let t = 0; t < 3000; t++) {
    const e = mkE(), p = { x: rnd(-100, 220), y: rnd(-100, 220) }, ang = G.pointEllipseTangents(p, e);
    const inside = Math.hypot((p.x - e.center.x), (p.y - e.center.y)) < e.b * 0.99;
    if (!inside && ang.length !== 2) { bad++; continue; }
    ang.forEach(th => { worst = Math.max(worst, Math.abs(p.x * Math.cos(th) + p.y * Math.sin(th) - G.ellipseSupport(e, th))); });
  }
  console.log('2 tangents from a point:', { wrongCount: bad, worstResidual: worst.toExponential(1) });
}
// 3. hull outline vs brute force
{
  const dist = (q, poly) => poly.reduce((m, a, i) => { const b = poly[(i + 1) % poly.length], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1e-12, f = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2)); return Math.min(m, Math.hypot(q.x - a.x - dx * f, q.y - a.y - dy * f)); }, Infinity);
  let worst = 0, cases = 0, bad = 0;
  for (let t = 0; t < 600; t++) {
    const items = [], dense = [];
    const n = 1 + Math.floor(Math.random() * 3);
    for (let k = 0; k < n; k++) {
      const e = mkE(), kind = Math.floor(Math.random() * 3);
      if (kind === 0) { items.push({ e }); for (let i = 0; i < 3000; i++) dense.push(G.ellipsePoint(e, (i / 3000) * TWO)); }
      else if (kind === 1) { const th0 = rnd(0, TWO), span = rnd(0.5, 5.5); items.push({ e, th0, th1: th0 + span }); for (let i = 0; i <= 3000; i++) dense.push(G.ellipsePoint(e, th0 + (span * i) / 3000)); }
      else { const pts = Array.from({ length: 2 + Math.floor(Math.random() * 12) }, () => ({ x: rnd(0, 150), y: rnd(0, 150) })); items.push({ pts }); dense.push(...pts); }
    }
    const ops = G.hullOutline(items), poly = G.outlinePolygon(ops, 0.002), ref = G.convexHull(dense);
    cases++;
    if (poly.length < 3 || ref.length < 3) { bad++; continue; }
    const d = Math.max(...poly.filter((_, i) => i % 3 === 0).map(q => dist(q, ref)), ...ref.filter((_, i) => i % 7 === 0).map(q => dist(q, poly)));
    worst = Math.max(worst, d);
  }
  console.log('3 hull outline vs dense hull:', { cases, degenerate: bad, worstGap: worst.toFixed(4) });
}
// 4. projected circle: perspective projection of a 3D circle vs the conic
{
  const f = 700, project = (p) => ({ x: 500 + 1.7 * 700 * p.x / (p.z + 700) , y: 400 - 1.7 * 700 * p.y / (p.z + 700) });
  let worst = 0, fallback = 0;
  for (let t = 0; t < 1500; t++) {
    const ax = G.vecNormalize({ x: rnd(-1, 1), y: rnd(-1, 1), z: rnd(-1, 1) }), h = Math.abs(ax.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    const u = G.vecNormalize(G.vecCross(ax, h)), v = G.vecCross(ax, u), C = { x: rnd(-150, 150), y: rnd(-150, 150), z: rnd(-150, 150) }, r = rnd(10, 80);
    const e = G.projectedCircleEllipse(C, r, { u, v }, project);
    let w = 0;
    for (let i = 0; i < 200; i++) {
      const th = (i / 200) * TWO, c = Math.cos(th) * r, s = Math.sin(th) * r;
      const q = project({ x: C.x + u.x * c + v.x * s, y: C.y + u.y * c + v.y * s, z: C.z + u.z * c + v.z * s });
      // implicit distance: ellipse frame radius
      const ca = Math.cos(e.angle), sa = Math.sin(e.angle), dx = q.x - e.center.x, dy = q.y - e.center.y;
      const rad = Math.hypot((dx * ca + dy * sa) / e.a, (-dx * sa + dy * ca) / e.b);
      w = Math.max(w, Math.abs(rad - 1) * Math.min(e.a, e.b));
    }
    worst = Math.max(worst, w);
  }
  console.log('4 projected circle conic vs 200 sampled projections: worst gap (px)', worst.toExponential(1));
}
