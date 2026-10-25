// The joint ring (jointCurve.js, CLAUDE.md "Joint ring") for joints whose nodes are general
// ellipsoids, i.e. squashed in the flat solid (render.js `flatBody`). Same result shape as
// buildJointCurve, so jointSplit / the debug view / render.js read it unchanged.
//
// The cones are hullCone.js hulls of the joint body N with each far body. A cone touches N along
// the curve of normals n with hN(n) = hF(n) (its contact curve). The *touch points* are where
// the two contact curves meet: normals with hN = hFA = hFB. Along A's contact curve (parameter
// psi, the azimuth of the normal about the axis N -> FA), G = hFB - hN is positive on the arc
// whose points are inside hull B, and zero at the touch points.
//  - front: for each psi on the arc G > 0, A's generatrix starts inside hull B and leaves it at
//    one point (hull B's signed distance is convex along the line, so Newton from the far end
//    converges monotonically). Those points are on both surfaces: the crease from touch point
//    to touch point. The ring is no longer planar;
//  - back: the stretch of the plane through both touch points and the front's centroid that
//    cuts N, around the exposed back (an ellipse on N; computed on the unit sphere Sinv (x - c)).
import { vecSub, vecDot, vecCross, vecNormalize, supportH, supportPoint, mat3Mul } from './geometry.js';
import { buildHullCone, hullProbe, coneNormal } from './hullCone.js';
import { screenLoopOf } from './jointCurve.js';

const TWO_PI = Math.PI * 2;
const mod2pi = (a) => ((a % TWO_PI) + TWO_PI) % TWO_PI;
const MIN_STEPS = 8, ON_SPHERE_EPS = 0.002;
// Exact ring points (each a Newton solve) before the checks; the rest of the front is a Hermite spline through
// them with the exact tangent n_A x n_B at every node. (The checks add a node wherever the spline is off, so fewer
// to start with means fewer solves: 12 took 23 per joint, 8 takes 18, the ring within 0.02 px of it.)
const RING_NODES = 8;
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const len = (a) => Math.hypot(a.x, a.y, a.z);

// Azimuth in [0, 2 PI) about a cone's axis of a unit normal, the psi of hullNormal (n =
// cos(phi) dir + sin(phi) (u cos psi + v sin psi)).
const azimuth = (cone, n) => mod2pi(Math.atan2(vecDot(n, cone.frame.v), vecDot(n, cone.frame.u)));

// What the last frame computed for a joint (key = the joint node id): the numbers it was computed from (an
// unchanged joint returns the same curve) and the exact ring nodes' t / azimuth on cone B, which start the next
// frame's Newton solves a step from the answer.
const MEMORY = new Map();
const signature = (tol, ...bodies) => {
  const s = [tol];
  bodies.forEach(b => s.push(b.center.x, b.center.y, b.center.z, ...b.shape.ex, ...b.shape.ux));
  return s;
};
const sameSignature = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// Where the generatrix pN + t d (t in [0, 1]) of one cone leaves the other cone's hull: the root
// of f(t) = hullSigned(other, x(t)), convex in t with f(0) <= 0. Newton from the right of the
// root (the envelope theorem gives the slope: the probe normal . d), monotone for a convex
// function; `hint` = { t, psi } of a neighboring generatrix (or of the last frame) starts a little right
// of its root and narrows the probes' scan. The solve uses the ruled normals only (cheap, exact on the
// cone's ruled surface); one probe with the whole hull then confirms the point is on that surface (else a
// cap is what the generatrix leaves through, and the full Newton decides). null when the far end is
// inside the hull or the slope is lost.
function crossHull(other, pN, d, hint) {
  const dl = len(d) || 1;
  const x = (t) => ({ x: pN.x + d.x * t, y: pN.y + d.y * t, z: pN.z + d.z * t });
  const newton = (caps) => {
    const at = (t, psi, rounds = 1) => hullProbe(other, x(t), psi, caps, rounds);
    let t = 1, probe = null;
    // (just right of the hint's root first: from there Newton needs a step or two; then further right, then the far end)
    if (hint) for (const off of [0.02, 0.1]) {
      t = Math.min(1, hint.t + off);
      probe = at(t, hint.psi);
      if (probe.value > 0) break;
      t = 1; probe = null;
    }
    if (!probe) { probe = at(t, hint && hint.psi); if (!(probe.value > 0)) return null; }
    for (let it = 0; it < 40; it++) {
      const slope = vecDot(probe.n, d);
      if (!(slope > 1e-12 * dl)) return null;
      const next = t - probe.value / slope;
      if (next < 0) return null;
      if (Math.abs(next - t) * dl < 1e-9) { t = next; probe = at(t, probe.psi, 3); break; }
      t = next;
      probe = at(t, probe.psi);
    }
    return { t, probe };
  };
  let hit = newton(false);
  if (hit && Math.abs(hullProbe(other, x(hit.t), hit.probe.psi, true, 2).value) > 1e-6 * dl) hit = null;
  if (!hit) hit = newton(true);
  if (!hit) return null;
  return { t: hit.t, n2: hit.probe.n, psi: hit.probe.psi, point: x(hit.t) };
}

// Roots of a function of psi sampled on the cone's generatrices (values[i] at gens[i]): each sign
// change is refined by false position (Illinois), `value(psi)` being cheap and smooth.
function psiRoots(cone, values, value) {
  const M = cone.gens.length, out = [];
  for (let i = 0; i < M; i++) {
    const j = (i + 1) % M;
    if ((values[i] > 0) === (values[j] > 0)) continue;
    let a = cone.gens[i].psi, b = a + TWO_PI / M, fa = values[i], fb = values[j], side = 0, c = (a + b) / 2;
    for (let it = 0; it < 14; it++) {
      c = (fa * b - fb * a) / (fa - fb);
      const fc = value(c);
      if (fc === null) break;
      if (Math.abs(fc) < 1e-14 || Math.abs(b - a) < 1e-13) break;
      if ((fc > 0) === (fa > 0)) { a = c; fa = fc; if (side === -1) fb /= 2; side = -1; } else { b = c; fb = fc; if (side === 1) fa /= 2; side = 1; }
    }
    out.push(mod2pi(c));
  }
  return out;
}

// The distance from an exact ring point q (it is ON the ring) to segment i of the spline: how far the spline is
// from the curve there. (The spline's parameter is not the azimuth, so q is compared with the nearest point of the
// segment, found by a golden section around its projection on the chord, not with the spline at the same
// parameter value.)
function distToSpline(spl, i, pa, pb, q) {
  const ch = vecSub(pb, pa), l2 = vecDot(ch, ch) || 1e-12;
  const f0 = Math.max(0, Math.min(1, vecDot(vecSub(q, pa), ch) / l2));
  const d2 = (f) => { const p = spl(i, f).p, dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z; return dx * dx + dy * dy + dz * dz; };
  const gr = 0.6180339887498949;
  let lo = Math.max(0, f0 - 0.35), hi = Math.min(1, f0 + 0.35), a = hi - gr * (hi - lo), b = lo + gr * (hi - lo), fa = d2(a), fb = d2(b);
  for (let it = 0; it < 16; it++) {
    if (fa < fb) { hi = b; b = a; fb = fa; a = hi - gr * (hi - lo); fa = d2(a); } else { lo = a; a = b; fa = fb; b = lo + gr * (hi - lo); fb = d2(b); }
  }
  return Math.sqrt(Math.min(fa, fb));
}

// Is angle x inside the cyclic arc that runs from a to b through m?
function inArc(a, b, m, x) {
  const span = (p, q) => mod2pi(q - p);
  const forward = span(a, m) <= span(a, b);       // a -> b increasing contains m
  return forward ? span(a, x) <= span(a, b) + 1e-9 : span(b, x) <= span(b, a) + 1e-9;
}

// Segments needed for an arc of `span` radians of a circle of radius `rho` (chord within tol).
function arcSteps(span, rho, tol) {
  const step = rho > tol ? 2 * Math.acos(1 - tol / rho) : Math.PI;
  return Math.max(MIN_STEPS, Math.ceil(Math.abs(span) / step));
}

// N: the joint body; FA / FB: the far bodies ({ center, shape } with shape from ellipsoidShape). `key` (the
// joint node id) lets the result be reused when the bodies are unchanged and warm-starts the next frame.
export function buildJointCurveGeneral(N, FA, FB, tol = 0.05, key) {
  const prior = key === undefined ? null : MEMORY.get(key);
  const sig = key === undefined ? null : signature(tol, N, FA, FB);
  if (prior && sameSignature(prior.sig, sig)) return prior.curve;
  const curve = computeGeneral(N, FA, FB, tol, prior && prior.warm);
  if (key !== undefined) MEMORY.set(key, { sig, curve, warm: curve.warm || null });
  return curve;
}

function computeGeneral(N, FA, FB, tol, warmIn) {
  const coneA = buildHullCone(N, FA, 96), coneB = buildHullCone(N, FB, 96);
  const dA = coneA.frame.dir, dB = coneB.frame.dir;
  const geo = { N, FA, FB, coneA, coneB };
  const noRing = (extra = {}) => ({ hasTouch: false, touch: null, front: [], ...bisectorCircle(geo, tol), general: geo, ...extra });
  if (coneA.degenerate || coneB.degenerate) return noRing();

  // Touch points: psi on A's contact curve where hFB = hN.
  const Gn = (n) => supportH(FB, n) - supportH(N, n);
  const normA = (psi) => { const h = coneNormal(coneA, psi); return h && h.n; };
  const roots = psiRoots(coneA, coneA.gens.map(g => Gn(g.n)), (psi) => { const n = normA(psi); return n ? Gn(n) : null; });
  if (roots.length !== 2) return noRing();
  const touchN = roots.map(normA);
  if (touchN.some(n => !n)) return noRing();
  const rawTouch = touchN.map(n => ({ p: supportPoint(N, n), n }));
  // touch[0] on the + side of dA x dB, like the closed form.
  const nAxis = vecCross(dA, dB);
  if (vecDot(vecSub(rawTouch[0].p, N.center), nAxis) < vecDot(vecSub(rawTouch[1].p, N.center), nAxis)) { rawTouch.reverse(); roots.reverse(); touchN.reverse(); }
  const touch = rawTouch;

  // The front arc of A's azimuths: between the two roots, where G > 0.
  const r0 = Math.min(...roots), r1 = Math.max(...roots);
  const midA = normA((r0 + r1) / 2), arc1Plus = midA && Gn(midA) > 0;
  const psiStart = arc1Plus ? r0 : r1, span = arc1Plus ? r1 - r0 : r0 + TWO_PI - r1;

  // The ring at azimuth psi of A's contact curve; `prev` (a neighbor's result, or the last frame's) warm-starts
  // it. Besides the point and both normals it carries the exact tangent n_A x n_B (the ring lies on both
  // surfaces).
  const ringAt = (psi, prev) => {
    const h = coneNormal(coneA, psi);
    if (!h) return null;
    const pN = supportPoint(N, h.n), pF = supportPoint(FA, h.n);
    const hit = crossHull(coneB, pN, vecSub(pF, pN), prev && { t: prev.t, psi: prev.psiB });
    if (!hit) return null;
    const c = vecCross(h.n, hit.n2), cl = len(c);
    return { p: hit.point, n: h.n, n2: hit.n2, psi, t: hit.t, psiB: hit.psi, tan: cl > 1e-9 ? scale(c, 1 / cl) : null };
  };
  const touchAt = (T) => ({ p: T.p, n: T.n });
  const nStart = normA(psiStart);
  const startsAtFirst = nStart ? len(vecSub(supportPoint(N, nStart), touch[0].p)) <= len(vecSub(supportPoint(N, nStart), touch[1].p)) : true;
  const tStart = startsAtFirst ? touch[0] : touch[1], tEnd = startsAtFirst ? touch[1] : touch[0];
  // The exact ring at cosine-spaced tau along the arc (psi = psiStart + span tau), denser toward
  // the touch points, where the ring turns fastest; each point starts from the last frame's solution at
  // the same tau, else from its neighbor's.
  const K = RING_NODES, tauOf = (k) => (1 - Math.cos(Math.PI * k / K)) / 2;
  const nodes = [{ tau: 0, q: { ...touchAt(tStart), n2: null, tan: null } }], uniform = [], warm = [];
  let prev = null;
  for (let k = 1; k < K; k++) {
    const tk = tauOf(k);
    let hint = prev;
    if (warmIn) {
      let best = null;
      for (const w of warmIn) if (!best || Math.abs(w.tau - tk) < Math.abs(best.tau - tk)) best = w;
      if (best && Math.abs(best.tau - tk) < 0.5 / K) hint = best;
    }
    const q = ringAt(psiStart + span * tk, hint);
    if (!q) { prev = null; continue; }
    prev = q;
    uniform.push(q);
    warm.push({ tau: tk, t: q.t, psiB: q.psiB });
    nodes.push({ tau: tk, q });
  }
  nodes.push({ tau: 1, q: { ...touchAt(tEnd), n2: null, tan: null } });
  let front = [], plane = null;
  if (uniform.length >= K - 3) {
    // A cubic Hermite spline through the nodes: at a node the tangent direction is the exact n_A x n_B (signed
    // along the curve), its length the chord length of the segment; at the two touch points (where n_A = n_B and
    // the cross product vanishes) the direction mirrors the neighbor's about the chord. It is checked at the
    // middle of each segment against the exact ring: where it is off by more than tol / 2 that exact point
    // becomes a node.
    const unit = (v) => { const l = len(v); return l > 1e-12 ? scale(v, 1 / l) : v; };
    const reflect = (T, c) => unit(vecSub(scale(c, 2 * vecDot(T, c)), T));
    const tangents = (list) => {
      const n = list.length, P = list.map(e => e.q.p), T = new Array(n);
      for (let i = 1; i < n - 1; i++) {
        const chord = vecSub(P[i + 1], P[i - 1]);
        let t = list[i].q.tan || unit(chord);
        if (vecDot(t, chord) < 0) t = scale(t, -1);
        T[i] = t;
      }
      if (n > 2) {
        T[0] = reflect(T[1], unit(vecSub(P[1], P[0])));
        T[n - 1] = reflect(T[n - 2], unit(vecSub(P[n - 1], P[n - 2])));
      } else { T[0] = T[n - 1] = unit(vecSub(P[1], P[0])); }
      return T;
    };
    const lerpN = (a, b, f) => (a && b ? vecNormalize(add(scale(a, 1 - f), scale(b, f))) : (a || b));
    const makeSpline = (list) => {
      const T = tangents(list);
      return (i, f) => {
        const f2 = f * f, f3 = f2 * f, a = list[i].q, b = list[i + 1].q, chord = vecSub(b.p, a.p), L = len(chord) || 1e-12;
        const c = scale(chord, 1 / L);
        // Tangent lengths 2 L / (1 + T . c): exact for a circular arc (handle length (L / 3) / cos^2(theta / 2), theta
        // the angle between the tangent and the chord), where the plain chord length falls short on a sharp turn.
        const m0 = 2 * L / Math.max(1 + vecDot(T[i], c), 0.2), m1 = 2 * L / Math.max(1 + vecDot(T[i + 1], c), 0.2);
        const h00 = 2 * f3 - 3 * f2 + 1, h10 = f3 - 2 * f2 + f, h01 = -2 * f3 + 3 * f2, h11 = f3 - f2;
        const p = add(add(scale(a.p, h00), scale(T[i], h10 * m0)), add(scale(b.p, h01), scale(T[i + 1], h11 * m1)));
        return { p, n: lerpN(a.n, b.n, f), n2: lerpN(a.n2, b.n2, f) };
      };
    };
    nodes.forEach(nd => { nd.dirty = true; });
    let spl = makeSpline(nodes);
    for (let round = 0; round < 5; round++) {
      const inserts = [];
      for (let i = 0; i + 1 < nodes.length; i++) {
        if (!nodes[i].dirty) continue;
        nodes[i].dirty = false;
        const tm = (nodes[i].tau + nodes[i + 1].tau) / 2, qm = ringAt(psiStart + span * tm, nodes[i].q.t !== undefined ? nodes[i].q : null);
        if (qm && distToSpline(spl, i, nodes[i].q.p, nodes[i + 1].q.p, qm.p) > tol * 0.5) inserts.push({ after: i, node: { tau: tm, q: qm, dirty: true } });
      }
      if (!inserts.length) break;
      for (let k = inserts.length - 1; k >= 0; k--) { nodes[inserts[k].after].dirty = true; nodes.splice(inserts[k].after + 1, 0, inserts[k].node); }
      spl = makeSpline(nodes);
    }
    const pts = [];
    const refine = (i, f0, p0, f1, p1, depth) => {
      const fm = (f0 + f1) / 2, pm = spl(i, fm), chordMid = scale(add(p0.p, p1.p), 0.5);
      const need = depth < 10 && len(vecSub(pm.p, chordMid)) > tol;
      if (need) refine(i, f0, p0, fm, pm, depth + 1);
      pts.push(pm);
      if (need) refine(i, fm, pm, f1, p1, depth + 1);
    };
    for (let i = 0; i + 1 < nodes.length; i++) {
      if (i > 0) pts.push(nodes[i].q);
      refine(i, 0, nodes[i].q, 1, nodes[i + 1].q, 0);
    }
    front = [touchAt(tStart), ...pts, touchAt(tEnd)];
    // plane through both touch points and the centroid of the exact samples
    const C = scale(uniform.reduce((sum, q) => add(sum, q.p), { x: 0, y: 0, z: 0 }), 1 / uniform.length);
    const pl = vecCross(vecSub(touch[1].p, touch[0].p), vecSub(C, touch[0].p));
    if (len(pl) > 1e-9) plane = vecNormalize(pl);
  }
  const backInfo = bisectBackArc(geo, touch, plane, tol, front.length ? null : 'half');
  let frontArc = null;
  if (!front.length) { front = backInfo.otherHalf; frontArc = backInfo.otherArc; }
  const frontStartsAtPlus = len(vecSub(front[0].p, touch[0].p)) < 1e-9;
  const backBack = frontStartsAtPlus ? backInfo.back.slice().reverse() : backInfo.back;
  const loop = [...front, ...backBack.slice(1)];
  // on screen: the front's chords (the crease of two hulls is no conic), the back's exact arc
  const ba = backInfo.backArc, screenLoop = screenLoopOf(front, frontArc, frontStartsAtPlus ? { ...ba, t0: ba.t1, t1: ba.t0 } : ba);
  // The ring's arcs in A's and B's azimuths, for the edge contacts.
  const mid = uniform[Math.floor(uniform.length / 2)];
  const ringRange = mid ? {
    A: { a: azimuth(coneA, touchN[0]), b: azimuth(coneA, touchN[1]), m: azimuth(coneA, mid.n) },
    B: { a: azimuth(coneB, touchN[0]), b: azimuth(coneB, touchN[1]), m: azimuth(coneB, mid.n2) },
  } : null;
  return { hasTouch: true, touch, front, back: backInfo.back, loop, screenLoop, plane: backInfo.plane, ringRange, general: geo, exact: uniform, warm };
}

// The plane through the touch points and the back, as a circle on N: returns { back, plane,
// otherHalf }. `plane` (a unit normal) may be null: then the plane through both touch points and
// the middle of the back is used. back runs touch[0] -> touch[1] through the back.
function bisectBackArc(geo, touch, planeIn, tol, wantOther) {
  const { N, coneA, coneB } = geo, dA = coneA.frame.dir, dB = coneB.frame.dir;
  const sum = add(dA, dB);
  const backMid = len(sum) > 1e-6 ? scale(sum, -1 / len(sum)) : vecNormalize(vecCross(vecSub(touch[1].p, touch[0].p), dA));
  let plane = planeIn;
  if (!plane) {
    const chord = vecNormalize(vecSub(touch[1].p, touch[0].p));
    plane = vecNormalize(vecCross(chord, backMid));
  }
  const circle = planeCircle(N, plane, vecDot(plane, touch[0].p));
  // basis e1 (toward the back) / e2 in the unit-sphere space
  const yBack = mat3Mul(N.shape.Sinv, backMid);
  const inPlane = (v) => vecSub(v, scale(circle.mh, vecDot(v, circle.mh)));
  let e1 = inPlane(yBack);
  e1 = len(e1) > 1e-6 ? vecNormalize(e1) : circle.u1;
  const e2 = vecCross(circle.mh, e1);
  const yOf = (p) => mat3Mul(N.shape.Sinv, vecSub(p, N.center));
  const phi = touch.map(T => { const d = vecSub(yOf(T.p), scale(circle.mh, circle.e)); return Math.atan2(vecDot(d, e2), vecDot(d, e1)); });
  let phiEnd = phi[1];
  const through0 = (b) => Math.min(phi[0], b) <= 0 && Math.max(phi[0], b) >= 0;
  for (const cand of [phi[1], phi[1] + TWO_PI, phi[1] - TWO_PI]) {
    if (through0(cand) && (!through0(phiEnd) || Math.abs(cand - phi[0]) < Math.abs(phiEnd - phi[0]))) phiEnd = cand;
  }
  const pointAt = (ph) => {
    const y = add(scale(circle.mh, circle.e), add(scale(e1, circle.rho * Math.cos(ph)), scale(e2, circle.rho * Math.sin(ph))));
    const p = add(N.center, mat3Mul(N.shape.S, y));
    return { p, n: vecNormalize(mat3Mul(N.shape.Sinv, y)) };
  };
  const arcPts = (a0, a1, steps) => Array.from({ length: steps + 1 }, (_, i) => pointAt(a0 + (a1 - a0) * i / steps));
  // The radius of the circle in the world is of the order of N's size: use the largest semi-axis.
  const rWorld = Math.max(...N.shape.axes) * circle.rho;
  const back = [touch[0], ...arcPts(phi[0], phiEnd, arcSteps(phiEnd - phi[0], rWorld, tol)).slice(1, -1), touch[1]];
  // The same circle on screen (viewed along z): N's center + S y, so an ellipse with conjugate semi-diameters rho S e1 and
  // rho S e2, its parameter phi.
  const c0 = add(N.center, mat3Mul(N.shape.S, scale(circle.mh, circle.e))), Se1 = mat3Mul(N.shape.S, e1), Se2 = mat3Mul(N.shape.S, e2);
  const ell = { c: { x: c0.x, y: c0.y }, U: { x: circle.rho * Se1.x, y: circle.rho * Se1.y }, V: { x: circle.rho * Se2.x, y: circle.rho * Se2.y } };
  let otherHalf = null, otherArc = null;
  if (wantOther) {
    const other = phiEnd > phi[0] ? phiEnd - TWO_PI : phiEnd + TWO_PI;
    otherHalf = [touch[0], ...arcPts(phi[0], other, arcSteps(other - phi[0], rWorld, tol)).slice(1, -1), touch[1]];
    otherArc = { ...ell, t0: phi[0], t1: other };
  }
  return { back, plane, otherHalf, backArc: { ...ell, t0: phi[0], t1: phiEnd }, otherArc };
}

// The plane { plane . x = d } cut with the ellipsoid N, on the unit sphere y = Sinv (x - c):
// { mh, e, rho, u1 } -- the plane's unit normal there, its signed offset, the circle's radius and
// a unit vector in its plane.
function planeCircle(N, plane, d) {
  const m = mat3Mul(N.shape.S, plane), ml = len(m) || 1;
  const mh = scale(m, 1 / ml), e = Math.max(-1, Math.min(1, (d - vecDot(plane, N.center)) / ml));
  const helper = Math.abs(mh.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  return { mh, e, rho: Math.sqrt(Math.max(1 - e * e, 0)), u1: vecNormalize(vecCross(mh, helper)) };
}

// No touch points: the exposed N is split by the plane through its center halfway between the
// two cones' directions. Returns { back, loop, plane } (the whole circle).
function bisectorCircle(geo, tol) {
  const { N, coneA, coneB } = geo, dA = coneA.frame.dir, dB = coneB.frame.dir;
  const m = len(vecSub(dA, dB)) > 1e-6 ? vecNormalize(vecSub(dA, dB)) : vecNormalize(vecCross(dA, { x: 0, y: 1, z: 0 }));
  const sum = add(dA, dB);
  const circle = planeCircle(N, m, vecDot(m, N.center));
  const yHalf = mat3Mul(N.shape.Sinv, len(sum) > 1e-6 ? vecNormalize(sum) : vecNormalize(vecCross(m, { x: 0, y: 1, z: 0 })));
  let e1 = vecSub(yHalf, scale(circle.mh, vecDot(yHalf, circle.mh)));
  e1 = len(e1) > 1e-6 ? vecNormalize(e1) : circle.u1;
  const e2 = vecCross(circle.mh, e1);
  const steps = arcSteps(TWO_PI, Math.max(...N.shape.axes), tol);
  const back = Array.from({ length: steps + 1 }, (_, i) => {
    const ph = TWO_PI * i / steps, y = add(scale(e1, Math.cos(ph)), scale(e2, Math.sin(ph)));
    return { p: add(N.center, mat3Mul(N.shape.S, y)), n: vecNormalize(mat3Mul(N.shape.Sinv, y)) };
  });
  return { back, loop: back, plane: m };
}

// Where each cone's two silhouette edges touch the ring (the general counterpart of
// jointCurve.js edgeContacts). An edge is the generatrix whose normal is perpendicular to the view
// (n.z = 0, the camera looks along z). Per cone ('A' then 'B'), the edges as { near, contact }:
// near = the edge's point on N, contact = where it leaves the other hull, if that is on the ring
// (its azimuth in the ring's arc), else null. Kept on the curve, so a reused curve reuses its edges.
export function edgeContactsGeneral(curve) {
  if (curve.edges) return curve.edges;
  const { N, FA, FB, coneA, coneB } = curve.general;
  curve.edges = [[FA, coneA, coneB, 'A'], [FB, coneB, coneA, 'B']].map(([F, cone, other, side]) => {
    if (cone.degenerate) return [];
    const nz = (psi) => { const h = coneNormal(cone, psi); return h && h.n.z; };
    const psis = psiRoots(cone, cone.gens.map(g => g.n.z), nz);
    if (psis.length !== 2) return [];
    return psis.sort((a, b) => a - b).map(psi => {
      const h = coneNormal(cone, psi), pN = supportPoint(N, h.n), pF = supportPoint(F, h.n);
      let contact = null;
      const rr = curve.ringRange && curve.ringRange[side];
      if (curve.touch && rr && inArc(rr.a, rr.b, rr.m, psi)) {
        const hit = crossHull(other, pN, vecSub(pF, pN));
        if (hit && hit.t > ON_SPHERE_EPS) contact = hit.point;
      }
      return { near: pN, contact };
    });
  });
  return curve.edges;
}
