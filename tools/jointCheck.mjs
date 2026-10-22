// The general joint ring on random squashed (general ellipsoid) triples: invariants of the curve
// and timing. Run from a copy of the modules (see trace.mjs).
import * as G from '../geometry.js';
import { buildHullCone, hullSigned } from '../hullCone.js';
import { buildJointCurveGeneral, edgeContactsGeneral } from '../jointCurveGeneral.js';

const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
const body = (c, r, sq) => {
  // a screen-aligned flat-solid ellipsoid with the squash of a spheroid seen from some angle
  const a = r * rnd(0.8, 1.6) / Math.sqrt(sq), b = r * sq * rnd(0.8, 1.2) * Math.sqrt(sq), c3 = r * rnd(0.5, 1.2);
  return { center: c, shape: G.ellipsoidShape(Math.max(a, b), Math.min(a, b), rnd(0, 6.28), c3) };
};
const nrm = (n) => Math.abs(Math.hypot(n.x, n.y, n.z) - 1);
let cases = 0, noTouch = 0, noFront = 0, tOnN = 0, tOnA = 0, tOnB = 0, frontA = 0, frontB = 0, backOnN = 0, backOnPlane = 0, loopGap = 0, normErr = 0, edges = 0, edgeContact = 0, edgeOn = 0, tTotal = 0;
for (let t = 0; t < 150; t++) {
  const N = body({ x: 0, y: 0, z: 0 }, rnd(35, 60), rnd(0.4, 1.6));
  const A = body({ x: rnd(-200, -80), y: rnd(-200, -60), z: rnd(-60, 60) }, rnd(25, 50), rnd(0.4, 1.6));
  const B = body({ x: rnd(80, 200), y: rnd(-200, -60), z: rnd(-60, 60) }, rnd(25, 50), rnd(0.4, 1.6));
  const t0 = performance.now();
  const curve = buildJointCurveGeneral(N, A, B, 0.02);
  tTotal += performance.now() - t0;
  cases++;
  if (!curve.hasTouch) { noTouch++; continue; }
  const { coneA, coneB } = curve.general;
  const Hs = (n, ...bs) => Math.max(...bs.map(b => G.supportH(b, n)));
  curve.touch.forEach(T => {
    // on N's surface with normal n; the hulls' supports agree there
    tOnN = Math.max(tOnN, Math.abs(G.vecDot(T.n, T.p) - G.supportH(N, T.n)), nrm(T.n));
    tOnA = Math.max(tOnA, Math.abs(Hs(T.n, N, A) - G.supportH(N, T.n)));
    tOnB = Math.max(tOnB, Math.abs(Hs(T.n, N, B) - G.supportH(N, T.n)));
  });
  if (curve.front.length < 3) { noFront++; continue; }
  curve.front.forEach((q, i) => {
    frontA = Math.max(frontA, Math.abs(hullSigned(coneA, q.p)));
    frontB = Math.max(frontB, Math.abs(hullSigned(coneB, q.p)));
    if (q.n) normErr = Math.max(normErr, nrm(q.n));
  });
  curve.back.forEach(q => { const y = G.mat3Mul(N.shape.Sinv, G.vecSub(q.p, N.center)); backOnN = Math.max(backOnN, Math.abs(Math.hypot(y.x, y.y, y.z) - 1)); });
  const a = curve.loop[0].p, b = curve.loop[curve.loop.length - 1].p;
  loopGap = Math.max(loopGap, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
  const e = edgeContactsGeneral(curve);
  e.flat().forEach(ed => { edges++; if (ed.contact) { edgeContact++; edgeOn = Math.max(edgeOn, Math.abs(hullSigned(coneA, ed.contact)) * Math.abs(hullSigned(coneB, ed.contact)) > 0 ? Math.min(Math.abs(hullSigned(coneA, ed.contact)), Math.abs(hullSigned(coneB, ed.contact))) : 0); } });
}
console.log({ cases, noTouch, noFront, edges, edgeContact });
console.log('touch: on N', tOnN.toExponential(1), '| on hull A', tOnA.toExponential(1), '| on hull B', tOnB.toExponential(1));
console.log('front points on hull A surface', frontA.toExponential(1), '| on hull B surface', frontB.toExponential(1), '| normals', normErr.toExponential(1));
console.log('back on N', backOnN.toExponential(1), '| loop closure gap', loopGap.toExponential(1), '| edge contact on a hull surface', edgeOn.toExponential(1));
console.log('build time per joint (ms):', (tTotal / cases).toFixed(2));
