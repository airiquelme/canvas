// The split ring: the uniform closed form against the general numeric ring (same shapes), and the general numeric ring on
// round nodes against the sphere closed form. Run from a copy of the modules (see trace.mjs).
import * as G from '../geometry.js';
import { createNode, nodes } from '../scene.js';
import { sphereSplitRing, findGeneralSplitRing, findUniformSplitRing } from '../splitRing.js';

const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
const rvec = (k) => ({ x: rnd(-k, k), y: rnd(-k, k), z: rnd(-k, k) });
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
// a pyramid host, a shared node = apex, a far node outside
function scene(shape) {
  const mk = (c, r) => nodes[createNode(c, r, shape)];
  const base = [0, 1, 2].map(i => { const a = i * 2.094; return mk({ x: 110 * Math.cos(a), y: -90, z: 110 * Math.sin(a) }, rnd(25, 35)); });
  const apex = mk({ x: 0, y: 110, z: 0 }, rnd(20, 30)), far = mk({ x: rnd(120, 220) * (Math.random() < 0.5 ? 1 : -1), y: rnd(150, 300), z: rnd(-120, 120) }, rnd(15, 35));
  return { shared: apex, far, host: [...base, apex] };
}
// 1. uniform closed form vs numeric
{
  let n = 0, worstS = 0, worstP = 0, worstT = 0, skipped = 0;
  for (let t = 0; t < 60; t++) {
    const sh = { squash: rnd(0.4, 1.8), axis: G.vecNormalize(rvec(1)) }, { shared, far, host } = scene(sh);
    const u = findUniformSplitRing(shared, far, host), g = findGeneralSplitRing(shared, far, host);
    if (!u || !g) { skipped++; continue; }
    n++;
    worstS = Math.max(worstS, Math.abs(u.s - g.s));
    // ring points of both: the generatrices at tStar
    const pt = (r, i) => { const gen = r.general.cone.gens[i], tt = r.general.tStar[i]; return { x: gen.pA.x + (gen.pB.x - gen.pA.x) * tt, y: gen.pA.y + (gen.pB.y - gen.pA.y) * tt, z: gen.pA.z + (gen.pB.z - gen.pA.z) * tt }; };
    // the two rings are the same curve with different azimuth parameterizations: compare the curves, point of u to the nearest segment of g
    const gp = Array.from({ length: 96 }, (_, i) => pt(g, i));
    const nearest = (p) => gp.reduce((m, a, i) => { const b = gp[(i + 1) % 96], d = G.vecSub(b, a), l2 = G.vecDot(d, d) || 1e-12, f = Math.max(0, Math.min(1, G.vecDot(G.vecSub(p, a), d) / l2)); return Math.min(m, dist(p, { x: a.x + d.x * f, y: a.y + d.y * f, z: a.z + d.z * f })); }, Infinity);
    let w = 0; for (let i = 0; i < 96; i += 4) w = Math.max(w, nearest(pt(u, i)));
    worstP = Math.max(worstP, w);
    worstT = Math.max(worstT, dist(u.touch, g.touch));
  }
  console.log('1 uniform closed form vs numeric (same shapes):', { cases: n, skipped, worstRingConstant: worstS.toExponential(1), worstRingCurveGap: worstP.toExponential(1), worstTouch: worstT.toExponential(1) });
}
// 2. numeric general on round nodes vs the sphere closed form
{
  let n = 0, worstS = 0, worstT = 0;
  for (let t = 0; t < 60; t++) {
    const { shared, far, host } = scene({});
    const c = sphereSplitRing(shared, far, host), g = findGeneralSplitRing(shared, far, host);
    if (!g) continue;
    n++; worstS = Math.max(worstS, Math.abs(c.s - g.s)); worstT = Math.max(worstT, dist(c.touch, g.touch));
  }
  console.log('2 numeric general on round nodes vs sphere closed form:', { cases: n, worstS: worstS.toFixed(4), worstTouch: worstT.toFixed(4) });
}
