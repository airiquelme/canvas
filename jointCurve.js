// The real 3D split between the two cones of a moon-phase joint (CLAUDE.md
// "Joint curve"). Each cone is the tangent hull of the joint's sphere and its
// far sphere, so it touches the sphere along a circle. The two circles meet at
// the *touch points*, where the cones touch each other. The color split is one
// closed ring through them, lying in ONE plane through the sphere's center:
//  - front: the cones' intersection curve, touch point to touch point, as cut by
//    that plane (an ellipse-like conic);
//  - back: the circle where the plane cuts the sphere, from touch point to touch
//    point around the exposed back (the side facing away from both cones).
// The plane is fitted to the intersection curve (it is exactly planar only for
// equal cones). Pure 3D and independent of the camera; every point carries its
// outward normal so a view can tell which parts face it.
import { vecSub, vecDot, vecCross, vecNormalize, sdfFrustum, bisectRoot } from './geometry.js';
import { coneFrame } from './shapes.js';
import { tangentCone, coneSurface } from './splitRing.js';

const THETA_STEPS = 240, S_STEPS = 96, ARC_STEPS = 48;
// Reach of the intersection search along a generatrix, in sphere radii.
const REACH = 6;
// A generatrix leaves the other cone at least this far (in radii) past its
// tangent circle to count as part of the intersection curve.
const ON_SPHERE_EPS = 0.002;
// The touch points count this many times in the plane fit, so the ring starts
// (almost exactly) at them.
const TOUCH_WEIGHT = 10;

const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const len = (a) => Math.hypot(a.x, a.y, a.z);

// Unit vector u on the sphere -> a curve point with its outward normal.
const spherePoint = (node, u) => ({ p: add(node.center, scale(u, node.radius)), n: u });

// Points e1 cos(phi) + e2 sin(phi) on the sphere, phi from a to b.
function arc(node, e1, e2, a, b, steps) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const phi = a + (b - a) * i / steps;
    out.push(spherePoint(node, add(scale(e1, Math.cos(phi)), scale(e2, Math.sin(phi)))));
  }
  return out;
}

// Normal of the plane through the origin that best fits `vectors` (least
// squares): the smallest-eigenvalue direction of sum(v v^T), found by power
// iteration on (trace I - S).
function planeNormal(vectors, start) {
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  vectors.forEach(q => {
    const a = [q.v.x, q.v.y, q.v.z];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) S[i][j] += q.w * a[i] * a[j];
  });
  const t = S[0][0] + S[1][1] + S[2][2];
  let v = [start.x, start.y, start.z];
  for (let it = 0; it < 200; it++) {
    const w = [0, 0, 0];
    for (let i = 0; i < 3; i++) { w[i] = t * v[i]; for (let j = 0; j < 3; j++) w[i] -= S[i][j] * v[j]; }
    const l = Math.hypot(w[0], w[1], w[2]) || 1;
    v = [w[0] / l, w[1] / l, w[2] / l];
  }
  return { x: v[0], y: v[1], z: v[2] };
}

// Longest cyclic run of true values in `flags`: { start, count } or null.
function longestRun(flags) {
  const n = flags.length;
  if (flags.every(Boolean) || !flags.some(Boolean)) return null;
  const first = flags.findIndex(f => !f);          // start just after a false
  let best = null, runStart = -1, run = 0;
  for (let k = 1; k <= n; k++) {
    const i = (first + k) % n;
    if (flags[i]) { if (run === 0) runStart = i; run++; }
    if (!flags[i] || k === n) {
      if (run > 0 && (!best || run > best.count)) best = { start: runStart, count: run };
      run = 0;
    }
  }
  return best;
}

// Does a curve point face the camera? A crease point lies on both cones, so
// both of its normals must.
export function facesCamera(q, camPos) {
  const v = vecSub(camPos, q.p);
  return vecDot(v, q.n) > 0 && (!q.n2 || vecDot(v, q.n2) > 0);
}

// node: the joint sphere; farA / farB: the far sphere of each cone.
// Returns { touch, front, back, loop, plane, hasTouch }:
//  touch  [P+, P-] curve points on the ring's plane, or null when the cones
//         don't touch;
//  front  the intersection curve from one touch point to the other ([] if none);
//         its points carry n2, the second cone's normal;
//  back   the circle arc from touch[0] to touch[1] through the back
//         (the whole bisector circle when there are no touch points);
//  loop   front followed by back, closed;
//  plane  the unit normal of the ring's plane (through the node center).
export function buildJointCurve(node, farA, farB) {
  const frameA = coneFrame(node, farA), frameB = coneFrame(node, farB);
  const coneA = tangentCone(node, farA, frameA), coneB = tangentCone(node, farB, frameB);
  const dA = frameA.dir, dB = frameB.dir;
  const g = vecDot(dA, dB), det = 1 - g * g;

  // Touch points: u . dA = sinT_A, u . dB = sinT_B, |u| = 1.
  let base = null, n = null, gamma = 0;
  if (det > 1e-6) {
    const alpha = (coneA.sinT - g * coneB.sinT) / det, beta = (coneB.sinT - g * coneA.sinT) / det;
    base = add(scale(dA, alpha), scale(dB, beta));
    const gamma2 = 1 - vecDot(base, base);
    if (gamma2 > 1e-9) { gamma = Math.sqrt(gamma2); n = vecNormalize(vecCross(dA, dB)); }
  }

  if (!n) {
    // No touch points: the cones don't meet at the sphere. Split the exposed
    // sphere by the plane halfway between the two cones' directions.
    const m = len(vecSub(dA, dB)) > 1e-6 ? vecNormalize(vecSub(dA, dB)) : vecNormalize(vecCross(dA, { x: 0, y: 1, z: 0 }));
    const sum = add(dA, dB);
    const e1 = len(sum) > 1e-6 ? vecNormalize(sum) : vecNormalize(vecCross(m, { x: 0, y: 1, z: 0 }));
    const back = arc(node, e1, vecCross(m, e1), 0, 2 * Math.PI, ARC_STEPS * 2);
    return { hasTouch: false, touch: null, front: [], back, loop: back, plane: m };
  }

  // The point of the sphere farthest from both cones: the middle of the back.
  const sum = add(dA, dB);
  const backMid = len(sum) > 1e-6 ? scale(sum, -1 / len(sum)) : vecNormalize(vecCross(n, dA));
  const rawTouch = [add(base, scale(n, gamma)), add(base, scale(n, -gamma))];    // unit vectors

  // The intersection curve: the exit of cone A's surface from cone B, away
  // from the sphere (generatrix by generatrix).
  const sdfB = (p) => sdfFrustum(p, node.center, node.radius, farB.center, farB.radius);
  const sMax = Math.min(coneA.sB, coneA.sA + REACH * node.radius);
  const crease = new Array(THETA_STEPS).fill(null);
  for (let i = 0; i < THETA_STEPS; i++) {
    const at = coneSurface(node, frameA, coneA, (i / THETA_STEPS) * Math.PI * 2);
    const f = (s) => sdfB(at(s).point);
    let prevS = coneA.sA, prevF = f(prevS);
    for (let j = 1; j <= S_STEPS; j++) {
      const s = coneA.sA + (sMax - coneA.sA) * j / S_STEPS, cur = f(s);
      if (prevF <= 1e-9 && cur > 0) {
        const root = bisectRoot(f, prevS, s);
        if (root - coneA.sA > ON_SPHERE_EPS * node.radius) crease[i] = at(root);
        break;
      }
      prevS = s; prevF = cur;
    }
  }
  const run = longestRun(crease.map(Boolean));
  const pts = run ? Array.from({ length: run.count }, (_, k) => crease[(run.start + k) % THETA_STEPS]) : [];

  // The ring's plane: through the node center, fitted to the intersection curve
  // and the touch points. Without a curve: the plane through the touch points'
  // axis and the middle of the back.
  const rel = (p) => vecSub(p, node.center);
  const fit = [...pts.map(q => ({ v: rel(q.point), w: 1 })), ...rawTouch.map(u => ({ v: scale(u, node.radius), w: TOUCH_WEIGHT * Math.max(pts.length, 1) / 2 }))];
  const plane = pts.length >= 3 ? planeNormal(fit, vecNormalize(vecCross(n, backMid))) : vecNormalize(vecCross(n, backMid));
  const inPlane = (v) => vecSub(v, scale(plane, vecDot(v, plane)));

  // The touch points on the plane's circle, and the back arc between them
  // through the middle of the back.
  const touchDir = rawTouch.map(u => vecNormalize(inPlane(u)));
  const touch = touchDir.map(u => spherePoint(node, u));
  const mid = inPlane(backMid);
  const e1 = len(mid) > 1e-6 ? vecNormalize(mid) : vecNormalize(inPlane(base));
  const e2 = vecNormalize(vecCross(plane, e1));
  const phi = touchDir.map(u => Math.atan2(vecDot(u, e2), vecDot(u, e1)));
  // The linear sweep from touch[0] to touch[1] that contains phi = 0 (the back).
  let phiEnd = phi[1];
  const through0 = (b) => Math.min(phi[0], b) <= 0 && Math.max(phi[0], b) >= 0;
  for (const cand of [phi[1], phi[1] + 2 * Math.PI, phi[1] - 2 * Math.PI]) {
    if (through0(cand) && (!through0(phiEnd) || Math.abs(cand - phi[0]) < Math.abs(phiEnd - phi[0]))) phiEnd = cand;
  }
  const back = [touch[0], ...arc(node, e1, e2, phi[0], phiEnd, ARC_STEPS).slice(1, -1), touch[1]];

  let front;
  if (run) {
    const near = (a, b) => len(vecSub(a, b));
    const startsAtPlus = near(pts[0].point, touch[0].p) <= near(pts[0].point, touch[1].p);
    // A crease point lies on both cones: it faces the camera only if both normals do.
    const h = 1e-3 * node.radius;
    const gradB = (p) => vecNormalize({
      x: sdfB({ x: p.x + h, y: p.y, z: p.z }) - sdfB({ x: p.x - h, y: p.y, z: p.z }),
      y: sdfB({ x: p.x, y: p.y + h, z: p.z }) - sdfB({ x: p.x, y: p.y - h, z: p.z }),
      z: sdfB({ x: p.x, y: p.y, z: p.z + h }) - sdfB({ x: p.x, y: p.y, z: p.z - h }),
    });
    // Each point is moved into the plane (its normals stay those of the cones).
    const planar = pts.map(q => ({ p: add(node.center, inPlane(rel(q.point))), n: q.outward, n2: gradB(q.point) }));
    front = [startsAtPlus ? touch[0] : touch[1], ...planar, startsAtPlus ? touch[1] : touch[0]];
  } else {
    // The surfaces never leave each other past the sphere: use the other half
    // of the circle so the ring still closes.
    const other = phiEnd > phi[0] ? phiEnd - 2 * Math.PI : phiEnd + 2 * Math.PI;
    front = [touch[0], ...arc(node, e1, e2, phi[0], other, ARC_STEPS).slice(1, -1), touch[1]];
  }

  // Close the ring: front runs P_start -> P_end, so the back must run P_end -> P_start.
  const frontStartsAtPlus = front[0] === touch[0] || len(vecSub(front[0].p, touch[0].p)) < 1e-9;
  const backBack = frontStartsAtPlus ? back.slice().reverse() : back;
  const loop = [...front, ...backBack.slice(1)];
  return { hasTouch: true, touch, front, back, loop, plane };
}
