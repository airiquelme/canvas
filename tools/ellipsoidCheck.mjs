// General (flat-solid) ellipsoids in hullCone.js: the node-to-point distance against a brute
// force over normals, then the hull of two of them. Run from a copy of the modules (see trace.mjs).
import * as G from '../geometry.js';
import { buildHullCone, hullSigned, hullProbe } from '../hullCone.js';

const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
const unit = () => G.vecNormalize({ x: rnd(-1, 1), y: rnd(-1, 1), z: rnd(-1, 1) });
const body = (c) => ({ center: c, shape: G.ellipsoidShape(rnd(8, 40), rnd(4, 30), rnd(0, 6.28), rnd(5, 35)) });
const fib = Array.from({ length: 40000 }, (_, i) => { const z = 1 - 2 * (i + .5) / 40000, r = Math.sqrt(1 - z * z), a = i * 2.399963229728653; return { x: r * Math.cos(a), y: r * Math.sin(a), z }; });
const climb = (f, n0) => { let cur = n0, cv = f(n0), step = 0.02; for (let it = 0; it < 3000; it++) { const m = G.vecNormalize({ x: cur.x + rnd(-step, step), y: cur.y + rnd(-step, step), z: cur.z + rnd(-step, step) }); const v = f(m); if (v > cv) { cv = v; cur = m; } if (it % 400 === 399) step /= 2; } return cv; };

// shape matrices are consistent: S S = Q, S Sinv = I
{
  const sh = G.ellipsoidShape(12, 5, 1.1, 9), v = { x: 0.3, y: -0.8, z: 0.5 };
  const a = G.mat3Mul(sh.S, G.mat3Mul(sh.S, v)), b = G.mat3Mul(sh.Q, v), c = G.mat3Mul(sh.S, G.mat3Mul(sh.Sinv, v));
  console.log('S*S - Q', Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z).toExponential(1), '| S*Sinv - I', Math.hypot(c.x - v.x, c.y - v.y, c.z - v.z).toExponential(1));
}

// 1. distance to one ellipsoid (through a degenerate hull is not possible, so use hullProbe of a cone whose far body is tiny and far)
let below = 0, signBad = 0;
for (let t = 0; t < 150; t++) {
  const A = body({ x: 0, y: 0, z: 0 }), B = body({ x: 400, y: 0, z: 0 }); // the hull is far from the test points near A
  const cone = buildHullCone(A, B, 64);
  const x = { x: rnd(-90, 60), y: rnd(-90, 90), z: rnd(-90, 90) };
  const f = (n) => G.vecDot(x, n) - G.supportH(A, n);
  let bf = -Infinity, bn = null; for (const n of fib) { const v = f(n); if (v > bf) { bf = v; bn = n; } }
  const v = climb(f, bn), mine = hullSigned(cone, x);
  const H = (n) => Math.max(G.supportH(A, n), G.supportH(B, n));
  const truth = climb((n) => G.vecDot(x, n) - H(n), bn);
  if ((truth > 0) !== (mine > 0)) signBad++;
  // mine comes from a real normal, so it is a lower bound of the true distance, as is the climb
  // (which can stall on a kink): mine must never be BELOW the climb.
  if (truth > 0) below = Math.max(below, truth - mine);
}
console.log('1 hull vs brute force (general ellipsoids): mine below the climb by', Math.max(below, 0).toExponential(1), '| sign mismatches', signBad);

// 2. the cone between two general ellipsoids: support lines + sdf
let sup = 0, sdfErr = 0, signWrong = 0;
for (let t = 0; t < 60; t++) {
  const A = body({ x: 0, y: 0, z: 0 }), B = body({ x: rnd(70, 200), y: rnd(-60, 60), z: rnd(-60, 60) });
  const cone = buildHullCone(A, B, 96);
  if (cone.degenerate) continue;
  const H = (n) => Math.max(G.supportH(A, n), G.supportH(B, n));
  cone.gens.forEach(g => {
    sup = Math.max(sup, Math.abs(G.vecDot(g.n, g.pA) - H(g.n)), Math.abs(G.vecDot(g.n, g.pB) - H(g.n)));
    for (let k = 0; k < 10; k++) { const m = unit(); [A, B].forEach(N => { sup = Math.max(sup, G.vecDot(g.n, G.supportPoint(N, m)) - H(g.n)); }); }
  });
  for (let k = 0; k < 6; k++) {
    const x = { x: rnd(-60, 260), y: rnd(-100, 100), z: rnd(-100, 100) };
    let bf = -Infinity, bn = null; for (const n of fib) { const v = G.vecDot(x, n) - H(n); if (v > bf) { bf = v; bn = n; } }
    const truth = climb((n) => G.vecDot(x, n) - H(n), bn), pr = hullProbe(cone, x);
    if ((truth > 0) !== (pr.value > 0)) signWrong++;
    if (truth > 0) sdfErr = Math.max(sdfErr, truth - pr.value);
    if (truth > 0.5) { // the probe normal is the surface normal: the offset along it from the surface point is the value
      const p = { x: x.x - pr.n.x * pr.value, y: x.y - pr.n.y * pr.value, z: x.z - pr.n.z * pr.value };
      sdfErr = Math.max(sdfErr, Math.abs(hullSigned(cone, p)));
    }
  }
}
console.log('2 support-line violation', sup.toExponential(1), '| sdf: below the climb by', Math.max(sdfErr, 0).toExponential(1), '| sign wrong', signWrong);
