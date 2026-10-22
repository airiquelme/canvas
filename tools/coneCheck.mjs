// Checks of hullCone.js. Run from a copy of the modules (see trace.mjs).
//  1. spheres: the generatrices are splitRing.js' tangent cone (tangentCone / coneSurface)
//  2. squashed pairs: every generatrix is a common support line of both bodies
//  3. hullSigned vs a brute-force max over 60000 normals refined by a local hill climb (the optimum
//     is on a kink ridge when nearest to the cone, so the bare grid is only good to ~0.5); points along a generatrix' normal
//     are at exactly their offset; points of the bodies and their segments are inside
//  4. the cross-section lies on the hull's surface (|sdf| ~ 0) and is convex
import * as G from '../geometry.js';
import { createNode, nodes } from '../scene.js';
import { buildHullCone, crossSection, hullSigned } from '../hullCone.js';
import { tangentCone, coneSurface } from '../splitRing.js';
import { coneFrame } from '../shapes.js';

const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
const rvec = (k) => ({ x: rnd(-k, k), y: rnd(-k, k), z: rnd(-k, k) });
const unit = () => G.vecNormalize(rvec(1));
const mk = (c, r, squash) => nodes[createNode(c, r, { squash, axis: unit(), cut: rvec(1) })];
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);

// 1. spheres
{
  let worst = 0;
  for (let t = 0; t < 200; t++) {
    const A = mk(rvec(100), rnd(10, 40), 1), B = mk({ x: rnd(150, 300), y: rnd(-60, 60), z: rnd(-60, 60) }, rnd(5, 40), 1);
    const frame = coneFrame(A, B), cone = tangentCone(A, B, frame), mine = buildHullCone(A, B, 64);
    mine.gens.forEach(g => {
      const surf = coneSurface(A, frame, cone, g.psi);
      worst = Math.max(worst, dist(surf(cone.sA).point, g.pA), dist(surf(cone.sB).point, g.pB));
    });
  }
  console.log('1 spheres vs tangentCone, worst endpoint gap', worst.toExponential(1));
}

// 2 + 3 + 4. squashed pairs
let signWrong = 0, insideCount = 0, insideAbove = 0, sup = 0, sdfLow = 0, sdfHigh = 0, normalOff = 0, inside = 0, sec = 0, secConvex = 0, cases = 0, degenerate = 0;
const fib = Array.from({ length: 60000 }, (_, i) => { const z = 1 - 2 * (i + .5) / 60000, r = Math.sqrt(1 - z * z), a = i * 2.399963229728653; return { x: r * Math.cos(a), y: r * Math.sin(a), z }; });
for (let t = 0; t < 60; t++) {
  const A = mk(rvec(30), rnd(10, 40), rnd(0.3, 2)), B = mk({ x: rnd(80, 220), y: rnd(-60, 60), z: rnd(-60, 60) }, rnd(8, 40), rnd(0.3, 2));
  const cone = buildHullCone(A, B, 96);
  if (cone.degenerate) { degenerate++; continue; }
  cases++;
  const H = (n) => Math.max(G.supportH(A, n), G.supportH(B, n));
  cone.gens.forEach(g => {
    // common support line: n . pA = n . pB = H(n), n unit, segment perpendicular to n
    sup = Math.max(sup, Math.abs(G.vecDot(g.n, g.pA) - H(g.n)), Math.abs(G.vecDot(g.n, g.pB) - H(g.n)), Math.abs(Math.hypot(g.n.x, g.n.y, g.n.z) - 1));
    // both bodies stay behind the plane: sample some surface points
    for (let k = 0; k < 20; k++) {
      const m = unit();
      [A, B].forEach(N => { const q = G.supportPoint(N, m); sup = Math.max(sup, G.vecDot(g.n, q) - H(g.n)); });
    }
  });
  // points along a ruled normal are at exactly their offset from the hull
  for (let k = 0; k < 10; k++) {
    const g = cone.gens[Math.floor(Math.random() * cone.gens.length)], u = Math.random(), d = rnd(1, 30);
    const q = { x: g.pA.x + (g.pB.x - g.pA.x) * u, y: g.pA.y + (g.pB.y - g.pA.y) * u, z: g.pA.z + (g.pB.z - g.pA.z) * u };
    normalOff = Math.max(normalOff, Math.abs(hullSigned(cone, { x: q.x + g.n.x * d, y: q.y + g.n.y * d, z: q.z + g.n.z * d }) - d));
  }
  // brute force sdf at random points
  for (let k = 0; k < 8; k++) {
    const x = { x: rnd(-80, 300), y: rnd(-120, 120), z: rnd(-120, 120) };
    let bf = -Infinity, bn = null; for (const n of fib) { const f = G.vecDot(x, n) - H(n); if (f > bf) { bf = f; bn = n; } }
    for (let it = 0, step = 0.01; it < 4000; it++) {
      const m = G.vecNormalize({ x: bn.x + rnd(-step, step), y: bn.y + rnd(-step, step), z: bn.z + rnd(-step, step) }), f = G.vecDot(x, m) - H(m);
      if (f > bf) { bf = f; bn = m; } if (it % 500 === 499) step /= 2;
    }
    const v = hullSigned(cone, x);
    // Outside the hull (bf > 0) the value is exact. Inside, only the sign is: the value can
    // only be lower (more negative) than the true depth.
    if (bf > 0) { sdfLow = Math.max(sdfLow, bf - v); sdfHigh = Math.max(sdfHigh, v - bf); } else { signWrong += v > 0 ? 1 : 0; insideCount++; if (v > bf + 1e-9) insideAbove++; }
    if (bf > 0 && v <= 0) signWrong++;
  }
  // inside: points of the bodies and segments between them
  for (let k = 0; k < 30; k++) {
    const p = G.supportPoint(A, unit()), q = G.supportPoint(B, unit()), u = Math.random();
    inside = Math.max(inside, hullSigned(cone, { x: p.x + (q.x - p.x) * u, y: p.y + (q.y - p.y) * u, z: p.z + (q.z - p.z) * u }));
  }
  // cross-section on the surface and convex
  if (cone.sRuledMax > cone.sRuledMin) {
    const s = cone.sRuledMin + Math.random() * (cone.sRuledMax - cone.sRuledMin), cs = crossSection(cone, s);
    if (!cs.ok) throw new Error('cross-section not ok inside the ruled range');
    cs.points.forEach(p => { sec = Math.max(sec, Math.abs(hullSigned(cone, p))); });
    // convexity in the plane perpendicular to the axis
    const { dir, u, v } = cone.frame, P = cs.points.map(p => ({ x: G.vecDot(G.vecSub(p, A.center), u), y: G.vecDot(G.vecSub(p, A.center), v) }));
    let neg = 0; const n = P.length;
    for (let i = 0; i < n; i++) { const a = P[i], b = P[(i + 1) % n], c = P[(i + 2) % n]; if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) < -1e-9) neg++; }
    secConvex += neg;
  }
}
console.log({ cases, degenerate });
console.log('2 support-line violation (should be ~0):', sup.toExponential(1));
console.log('3 sdf outside the hull: below brute force by', Math.max(sdfLow, 0).toExponential(1), '| above by', Math.max(sdfHigh, 0).toExponential(1), '(hill-climb accuracy)');
console.log('3 sdf sign wrong:', signWrong, '| inside points', insideCount, '(value above true depth:', insideAbove + ')');
console.log('3 sdf along ruled normals, error:', normalOff.toExponential(1), '| worst sdf of inside points:', inside.toExponential(1));
console.log('4 cross-section |sdf|:', sec.toExponential(1), '| non-convex corners:', secConvex);

// timing
{
  const A = mk({ x: 0, y: 0, z: 0 }, 30, 0.5), B = mk({ x: 150, y: 20, z: 10 }, 20, 1.4);
  let t0 = performance.now(); let cone; for (let i = 0; i < 200; i++) cone = buildHullCone(A, B, 128);
  const tb = (performance.now() - t0) / 200; t0 = performance.now();
  for (let i = 0; i < 500; i++) hullSigned(cone, { x: 60 + i % 7, y: 40, z: 5 });
  console.log('timing: build(128)', tb.toFixed(3), 'ms | hullSigned', ((performance.now() - t0) / 500).toFixed(3), 'ms');
}
