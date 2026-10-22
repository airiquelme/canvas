// The general joint ring (jointCurveGeneral.js) with spheres as its bodies against the closed-form
// ring (jointCurve.js): touch points, plane, front and back curves, edge stops.
// Run from a copy of the modules (see trace.mjs).
import * as G from '../geometry.js';
import { buildJointCurve, edgeContacts } from '../jointCurve.js';
import { buildJointCurveGeneral, edgeContactsGeneral } from '../jointCurveGeneral.js';

const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
const sph = (c, r) => ({ center: c, radius: r });
const body = (c, r) => ({ center: c, shape: G.ellipsoidShape(r, r, 0, r) });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
// distance from p to a polyline of {p}
const toPoly = (p, poly) => poly.reduce((m, a, i) => {
  if (i === poly.length - 1) return m;
  const b = poly[i + 1].p, q = a.p, d = G.vecSub(b, q), l2 = G.vecDot(d, d) || 1e-12;
  const f = Math.max(0, Math.min(1, G.vecDot(G.vecSub(p, q), d) / l2));
  return Math.min(m, dist(p, { x: q.x + d.x * f, y: q.y + d.y * f, z: q.z + d.z * f }));
}, Infinity);

let cases = 0, noTouchBoth = 0, mismatchTouch = 0, worstTouch = 0, worstPlane = 0, worstFront = 0, worstFrontRev = 0, worstBack = 0, edgeMis = 0, worstEdge = 0, frontSegs = [];
for (let t = 0; t < 120; t++) {
  const S = 1.6, rN = rnd(35, 60);
  const N = sph({ x: rnd(-10, 10), y: rnd(-10, 10), z: rnd(-10, 10) }, rN);
  const rA = rnd(25, 50), rB = rnd(25, 50);
  const A = sph({ x: rnd(-200, -80), y: rnd(-200, -60), z: rnd(-60, 60) }, rA), B = sph({ x: rnd(80, 200), y: rnd(-200, -60), z: rnd(-60, 60) }, rB);
  const old = buildJointCurve(N, A, B, 0.02), neu = buildJointCurveGeneral(body(N.center, N.radius), body(A.center, A.radius), body(B.center, B.radius), 0.02);
  cases++;
  if (!old.hasTouch && !neu.hasTouch) { noTouchBoth++; continue; }
  if (old.hasTouch !== neu.hasTouch) { mismatchTouch++; continue; }
  worstTouch = Math.max(worstTouch, dist(old.touch[0].p, neu.touch[0].p), dist(old.touch[1].p, neu.touch[1].p));
  worstPlane = Math.max(worstPlane, 1 - Math.abs(G.vecDot(old.plane, neu.plane)));
  // front points of the new ring lie on the old ring (polyline) and vice versa
  neu.front.forEach(q => { worstFront = Math.max(worstFront, toPoly(q.p, old.front)); });
  old.front.forEach(q => { worstFrontRev = Math.max(worstFrontRev, toPoly(q.p, neu.front)); });
  frontSegs.push(neu.front.length);
  neu.back.forEach(q => { worstBack = Math.max(worstBack, toPoly(q.p, old.back)); });
  const eo = edgeContacts(N, A, B, old), en = edgeContactsGeneral(neu);
  for (let c = 0; c < 2; c++) {
    if (eo[c].length !== en[c].length) { edgeMis++; continue; }
    // pair edges by nearest 'near'
    eo[c].forEach(e => {
      const m = en[c].reduce((b, f) => (dist(f.near, e.near) < dist(b.near, e.near) ? f : b));
      worstEdge = Math.max(worstEdge, dist(m.near, e.near));
      if (!!m.contact !== !!e.contact) edgeMis++; else if (e.contact) worstEdge = Math.max(worstEdge, dist(m.contact, e.contact));
    });
  }
}
console.log({ cases, noTouchBoth, mismatchTouch, edgeMismatches: edgeMis });
console.log('touch points', worstTouch.toExponential(1), '| plane (1-|cos|)', worstPlane.toExponential(1));
console.log('front: new on old', worstFront.toExponential(1), '| old on new', worstFrontRev.toExponential(1), '| back', worstBack.toExponential(1), '| edge stops', worstEdge.toExponential(1));
console.log('front points per ring: min', Math.min(...frontSegs), 'max', Math.max(...frontSegs));
