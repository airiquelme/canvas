// hostProbe (hostHull.js) against a brute force over normals with a local hill climb. Run from a copy of the modules.
import * as G from '../geometry.js';
import { buildHostHull, hostProbe } from '../hostHull.js';
const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
const rvec = (k) => ({ x: rnd(-k, k), y: rnd(-k, k), z: rnd(-k, k) });
const body = (c, r, sq) => ({ center: c, radius: r, shape: G.makeShape(r, sq, G.vecNormalize(rvec(1)), rvec(1)) });
const fib = Array.from({ length: 30000 }, (_, i) => { const z = 1 - 2 * (i + .5) / 30000, r = Math.sqrt(1 - z * z), a = i * 2.399963229728653; return { x: r * Math.cos(a), y: r * Math.sin(a), z }; });
let below = 0, above = 0, signBad = 0, n = 0, tSeed = 0;
for (let t = 0; t < 40; t++) {
  const bodies = [0, 1, 2, 3].map(i => body({ x: rnd(-100, 100), y: rnd(-100, 100), z: rnd(-100, 100) }, rnd(20, 40), rnd(0.5, 1.6)));
  const host = buildHostHull(bodies);
  for (let k = 0; k < 10; k++) {
    const x = rvec(220);
    const H = (m) => Math.max(...bodies.map(b => G.supportH(b, m))), phi = (m) => G.vecDot(x, m) - H(m);
    let bf = -Infinity, bn = null; for (const m of fib) { const v = phi(m); if (v > bf) { bf = v; bn = m; } }
    let cur = bn, cv = bf, step = 0.02;
    for (let it = 0; it < 3000; it++) { const m = G.vecNormalize({ x: cur.x + rnd(-step, step), y: cur.y + rnd(-step, step), z: cur.z + rnd(-step, step) }), v = phi(m); if (v > cv) { cv = v; cur = m; } if (it % 400 === 399) step /= 2; }
    const t0 = performance.now(), p = hostProbe(host, x); tSeed += performance.now() - t0;
    n++;
    below = Math.max(below, cv - p.value);          // mine must not be below the climb
    above = Math.max(above, p.value - cv);          // and the climb should reach it
    if ((cv > 0) !== (p.value > 0)) signBad++;
  }
}
console.log('hostProbe vs brute force + hill climb:', { probes: n, mineBelowClimb: below.toExponential(1), mineAboveClimb: above.toExponential(1), signMismatch: signBad, msPerProbe: (tSeed / n).toFixed(3) });
