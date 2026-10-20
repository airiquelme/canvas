// The 3D split between the two cones of a moon-phase joint (CLAUDE.md "Joint
// ring"), computed on spheres given as { center, radius }; render.js passes the
// flat solid (projected centers and radii). Each cone is the tangent hull of the joint's sphere and its
// far sphere, so it touches the sphere along a circle. The two circles meet at
// the *touch points*, where the cones touch each other. The color split is one
// closed ring through them:
//  - front: the cones' 3D intersection curve, touch point to touch point. It
//    depends on the two cones only;
//  - back: the circle on the sphere from touch point to touch point around the
//    exposed back (the side facing away from both cones).
// The whole ring is ONE plane. Two cones tangent to the same sphere intersect in
// plane conics (Monge), and the plane contains both touch points, so it is the
// plane through them that best fits the marched intersection (it misses the
// sphere's center by a few percent of the radius when the cones differ). The
// back circle is where that plane cuts the sphere. Pure 3D; every
// point carries its outward normal so a view can tell which parts face it.
import { vecSub, vecDot, vecCross, vecNormalize, sdfFrustum } from './geometry.js';
import { coneFrame } from './shapes.js';
import { tangentCone, coneSurface } from './splitRing.js';

const THETA_STEPS = 240, ARC_STEPS = 48;
// A generatrix meets the ring's plane at least this far (in radii) past its tangent
// circle to count as part of the ring (the touch points themselves are added).
const ON_SPHERE_EPS = 0.002;

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

// Does a curve point face the camera, whose direction (unit, toward the
// camera) is `viewDir`? A crease point lies on both cones, so both of its
// normals must.
export function facesCamera(q, viewDir) {
  return vecDot(viewDir, q.n) > 0 && (!q.n2 || vecDot(viewDir, q.n2) > 0);
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
//  plane  the unit normal of the ring's plane (not through the node center
//         unless the cones are equal).
export function buildJointCurve(node, farA, farB) {
  return computeJointCurve(node, farA, farB);
}

function computeJointCurve(node, farA, farB) {
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

  const sdfB = (p) => sdfFrustum(p, node.center, node.radius, farB.center, farB.radius);

  // The ring's plane. Two cones tangent to the same sphere intersect in plane
  // conics (Monge), so the intersection IS planar; the plane just doesn't pass
  // through the sphere's center unless the cones are equal. It contains both
  // touch points, so it is found by turning about the chord between them to
  // best fit the intersection curve (without a curve: through the chord and the
  // middle of the back).
  const T0 = add(node.center, scale(rawTouch[0], node.radius)), T1 = add(node.center, scale(rawTouch[1], node.radius));
  const chord = vecNormalize(vecSub(T1, T0));            // = n
  const ca = vecNormalize(vecCross(chord, backMid)), cb = vecCross(chord, ca);
  let plane = ca;                                         // normal ~ the plane through the chord and the back
  // Exact plane. A cone tangent to the sphere S = |X - c|^2 - r^2 = 0 along the circle
  // L(X) = (X - c).axis - r sinT = 0 satisfies S = k L^2 for a constant k, so the
  // cones' intersection S = kA LA^2 = kB LB^2 is the pair of planes
  // sqrt(kA) LA = +-sqrt(kB) LB. Both contain the touch points (LA = LB = 0); the
  // ring lies in the one that holds the marched curve. Camera-independent and
  // not fitted to any sampled points.
  const kOf = (frame, cone, axis) => {
    const P = coneSurface(node, frame, cone, 0)((cone.sA + cone.sB) / 2).point, d = vecSub(P, node.center);
    const L = vecDot(d, axis) - node.radius * cone.sinT;
    return (vecDot(d, d) - node.radius * node.radius) / (L * L);
  };
  const kA = kOf(frameA, coneA, dA), kB = kOf(frameB, coneB, dB);
  if (kA > 0 && kB > 0 && isFinite(kA) && isFinite(kB)) {
    const sa = Math.sqrt(kA), sb = Math.sqrt(kB);
    const candidates = [vecNormalize(vecSub(scale(dA, sa), scale(dB, sb))), vecNormalize(add(scale(dA, sa), scale(dB, sb)))];
    // The ring's plane separates the two cones: the cones' far centers are on opposite
    // sides of it. That decides from the geometry alone; a tie (never seen) goes to the
    // plane nearer the middle of the back.
    const separates = (n) => vecDot(vecSub(farA.center, T0), n) * vecDot(vecSub(farB.center, T0), n) < 0;
    const sep = candidates.map(separates);
    const backPoint = add(node.center, scale(backMid, node.radius));
    const err = (n) => Math.abs(vecDot(vecSub(backPoint, T0), n));
    if (sep[0] !== sep[1]) plane = sep[0] ? candidates[0] : candidates[1];
    else plane = err(candidates[0]) <= err(candidates[1]) ? candidates[0] : candidates[1];
  }
  const inPlane = (v) => vecSub(v, scale(plane, vecDot(v, plane)));
  const onPlane = (p) => vecSub(p, scale(plane, vecDot(vecSub(p, T0), plane)));

  // The ring itself, in closed form: each generatrix of cone A meets the ring's plane
  // at one point, and the ones that do so beyond the cone's tangent circle (and within
  // the cone, and on cone B's frustum) form the ring, from touch point to touch point.
  // No marching and no choice between branches: it ends exactly where the generatrix
  // reaches the tangent circle, i.e. at the touch points. (Marching the exits of A out
  // of B's sdf instead flipped to the other crossing conic when the two were almost
  // equally long, and lost the ends near the touch points.)
  const crease = new Array(THETA_STEPS).fill(null);
  for (let i = 0; i < THETA_STEPS; i++) {
    const at = coneSurface(node, frameA, coneA, (i / THETA_STEPS) * Math.PI * 2);
    const p0 = at(coneA.sA).point, dirv = vecSub(at(coneA.sA + 1).point, p0), denom = vecDot(plane, dirv);
    if (Math.abs(denom) < 1e-12) continue;
    const t = -vecDot(plane, vecSub(p0, T0)) / denom, s = coneA.sA + t;
    if (!(t > ON_SPHERE_EPS * node.radius) || s > coneA.sB) continue;
    const q = at(s);
    const axialB = vecDot(vecSub(q.point, node.center), dB);
    if (axialB < coneB.sA || axialB > coneB.sB) continue;            // on cone B's frustum
    crease[i] = q;
  }
  const run = longestRun(crease.map(Boolean));
  const pts = run ? Array.from({ length: run.count }, (_, k) => crease[(run.start + k) % THETA_STEPS]) : [];

  // The circle where the plane cuts the sphere: it passes through both touch
  // points. The back arc is its stretch between them through the back.
  const off = vecDot(vecSub(T0, node.center), plane);
  const ringCenter = add(node.center, scale(plane, off));
  const rho = Math.sqrt(Math.max(node.radius * node.radius - off * off, 0));
  const circle = (e1, e2, a0, a1, steps) => {
    const out = [];
    for (let i = 0; i <= steps; i++) {
      const phi = a0 + (a1 - a0) * i / steps;
      const p = add(ringCenter, add(scale(e1, rho * Math.cos(phi)), scale(e2, rho * Math.sin(phi))));
      out.push({ p, n: scale(vecSub(p, node.center), 1 / node.radius) });
    }
    return out;
  };
  const touch = rawTouch.map(u => spherePoint(node, u));
  const mid = inPlane(backMid);
  const e1 = len(mid) > 1e-6 ? vecNormalize(mid) : vecNormalize(inPlane(base));
  const e2 = vecNormalize(vecCross(plane, e1));
  const phi = [T0, T1].map(T => { const d = vecSub(T, ringCenter); return Math.atan2(vecDot(d, e2), vecDot(d, e1)); });
  // The linear sweep from touch[0] to touch[1] that contains phi = 0 (the back).
  let phiEnd = phi[1];
  const through0 = (b) => Math.min(phi[0], b) <= 0 && Math.max(phi[0], b) >= 0;
  for (const cand of [phi[1], phi[1] + 2 * Math.PI, phi[1] - 2 * Math.PI]) {
    if (through0(cand) && (!through0(phiEnd) || Math.abs(cand - phi[0]) < Math.abs(phiEnd - phi[0]))) phiEnd = cand;
  }
  const back = [touch[0], ...circle(e1, e2, phi[0], phiEnd, ARC_STEPS).slice(1, -1), touch[1]];

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
    const exact = pts.map(q => ({ p: onPlane(q.point), n: q.outward, n2: gradB(q.point) }));
    front = [startsAtPlus ? touch[0] : touch[1], ...exact, startsAtPlus ? touch[1] : touch[0]];
  } else {
    // The surfaces never leave each other past the sphere: use the other half
    // of the circle so the ring still closes.
    const other = phiEnd > phi[0] ? phiEnd - 2 * Math.PI : phiEnd + 2 * Math.PI;
    front = [touch[0], ...circle(e1, e2, phi[0], other, ARC_STEPS).slice(1, -1), touch[1]];
  }

  // Close the ring: front runs P_start -> P_end, so the back must run P_end -> P_start.
  const frontStartsAtPlus = front[0] === touch[0] || len(vecSub(front[0].p, touch[0].p)) < 1e-9;
  const backBack = frontStartsAtPlus ? back.slice().reverse() : back;
  const loop = [...front, ...backBack.slice(1)];
  // The ring is the crease of cone A's generatrices over this cyclic angle range.
  const ringRange = run ? { theta0: (run.start / THETA_STEPS) * Math.PI * 2, span: (run.count / THETA_STEPS) * Math.PI * 2 } : null;
  return { hasTouch: true, touch, front, back, loop, plane, ringRange };
}

// Where each cone's two silhouette edges touch the ring. An edge is the generatrix
// whose outward normal is perpendicular to the view (z = 0, the camera looks along
// z). The ring is a plane conic and the generatrix a line, so the contact is the
// line/plane intersection, closed form (no marching, no pixels, any scale). It is
// on the ring iff it is beyond the cone's tangent circle (s > sA, within the cone)
// and its angle around cone A's axis is in the ring's angular range; otherwise the
// edge ends on the node. Returns, per cone ('A' then 'B'), the edges as
// { near, contact }: near = the edge's point on the cone's tangent circle (where it
// meets the node), contact = its point on the ring or null. `curve`: buildJointCurve's result.
export function edgeContacts(node, farA, farB, curve) {
  const { plane, touch, ringRange } = curve;
  const frameA = coneFrame(node, farA);
  const ru = frameA.radial(0), rv = frameA.radial(Math.PI / 2);
  const onRingRange = (p) => {
    if (!ringRange) return false;
    const d = vecSub(p, node.center), r = vecSub(d, scale(frameA.dir, vecDot(d, frameA.dir)));
    const th = Math.atan2(vecDot(r, rv), vecDot(r, ru));
    const rel = (((th - ringRange.theta0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    return rel <= ringRange.span + (2 * Math.PI) / THETA_STEPS;
  };
  return [farA, farB].map((far) => {
    const frame = coneFrame(node, far), cone = tangentCone(node, far, frame);
    const nz = (th) => coneSurface(node, frame, cone, th)(cone.sA).outward.z;
    const out = [];
    const N = 720;
    for (let i = 0; i < N && out.length < 2; i++) {
      let t0 = (i / N) * Math.PI * 2, t1 = ((i + 1) / N) * Math.PI * 2, f0 = nz(t0);
      if (f0 * nz(t1) > 0 || f0 === 0) continue;
      for (let it = 0; it < 50; it++) { const m = (t0 + t1) / 2, fm = nz(m); if (f0 * fm <= 0) t1 = m; else { t0 = m; f0 = fm; } }
      const at = coneSurface(node, frame, cone, (t0 + t1) / 2);
      const p0 = at(cone.sA).point, p1 = at(cone.sA + 1).point;
      const dirv = vecSub(p1, p0), denom = vecDot(plane, dirv);
      let contact = null;
      if (touch && Math.abs(denom) > 1e-12) {
        const t = -vecDot(plane, vecSub(p0, touch[0].p)) / denom;
        if (t > ON_SPHERE_EPS * node.radius && cone.sA + t <= cone.sB) {
          const p = add(p0, scale(dirv, t));
          if (onRingRange(p)) contact = p;
        }
      }
      out.push({ near: p0, contact });
    }
    return out;
  });
}
