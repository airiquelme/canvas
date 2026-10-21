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
import { vecSub, vecDot, vecCross, vecNormalize } from './geometry.js';
import { coneFrame } from './shapes.js';
import { tangentCone, coneSurface } from './splitRing.js';

// Chord tolerance (in the units of the spheres' coordinates) when a curve is cut into
// segments, and the fewest segments of any arc.
const DEFAULT_TOL = 0.05, MIN_STEPS = 8;
const TWO_PI = Math.PI * 2;
// A generatrix meets the ring's plane at least this far (in radii) past its tangent
// circle to count as part of the ring (the touch points themselves are added).
const ON_SPHERE_EPS = 0.002;

const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const len = (a) => Math.hypot(a.x, a.y, a.z);

// Unit vector u on the sphere -> a curve point with its outward normal.
const spherePoint = (node, u) => ({ p: add(node.center, scale(u, node.radius)), n: u });

// Segments needed to cut an arc of `span` radians of a circle of radius `rho` with
// chords no farther than `tol` from it (the chord's sagitta is rho (1 - cos(step/2))).
function arcSteps(span, rho, tol) {
  const step = rho > tol ? 2 * Math.acos(1 - tol / rho) : Math.PI;
  return Math.max(MIN_STEPS, Math.ceil(Math.abs(span) / step));
}

// Points e1 cos(phi) + e2 sin(phi) on the sphere, phi from a to b.
function arc(node, e1, e2, a, b, steps) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const phi = a + (b - a) * i / steps;
    out.push(spherePoint(node, add(scale(e1, Math.cos(phi)), scale(e2, Math.sin(phi)))));
  }
  return out;
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
export function buildJointCurve(node, farA, farB, tol = DEFAULT_TOL) {
  return computeJointCurve(node, farA, farB, tol);
}

function computeJointCurve(node, farA, farB, tol) {
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
    const back = arc(node, e1, vecCross(m, e1), 0, TWO_PI, arcSteps(TWO_PI, node.radius, tol));
    return { hasTouch: false, touch: null, front: [], back, loop: back, plane: m };
  }

  // The point of the sphere farthest from both cones: the middle of the back.
  const sum = add(dA, dB);
  const backMid = len(sum) > 1e-6 ? scale(sum, -1 / len(sum)) : vecNormalize(vecCross(n, dA));
  const rawTouch = [add(base, scale(n, gamma)), add(base, scale(n, -gamma))];    // unit vectors

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

  // The ring itself, in closed form. Each generatrix of cone A (angle th around its axis)
  // meets the ring's plane at one point, distance t past its tangent circle:
  //   t(w) = -(al0 + radA w) / (nd + slope w),  w(th) = nu cos th + nv sin th
  // (n = the plane's normal, u / v the radial basis; a Moebius function of w). The ring is
  // the stretch of th where t > 0 (past the tangent circle), t <= sB - sA (within the cone)
  // and the point is on cone B's frustum. t = 0 holds exactly at the touch points (the plane
  // meets the tangent circle there), t = tMax and the poles of t are linear in w, and
  // w = W cos(th - phiW), so every change between valid and invalid is at a known angle:
  // no marching, no sampling, and the ring ends exactly at the touch points.
  const nd = vecDot(plane, dA), nu = vecDot(plane, frameA.u), nv = vecDot(plane, frameA.v);
  const al0 = vecDot(plane, vecSub(add(node.center, scale(dA, coneA.sA)), T0));
  const Wm = Math.hypot(nu, nv), phiW = Math.atan2(nv, nu), tMax = coneA.sB - coneA.sA;
  const tAt = (th) => {
    const den = nd + coneA.slope * (nu * Math.cos(th) + nv * Math.sin(th));
    return Math.abs(den) < 1e-12 ? NaN : -(al0 + coneA.radA * (nu * Math.cos(th) + nv * Math.sin(th))) / den;
  };
  // The ring point on generatrix th (after the plane test), with both cones' normals.
  const ringPoint = (th, t) => {
    const q = coneSurface(node, frameA, coneA, th)(coneA.sA + t);
    const d = vecSub(q.point, node.center), ax = vecDot(d, dB);
    const radB = vecNormalize(vecSub(d, scale(dB, ax)));
    return { point: q.point, outward: q.outward, axialB: ax, n2: add(scale(radB, coneB.cosT), scale(dB, coneB.sinT)) };
  };
  const onRing = (th) => {
    const t = tAt(th);
    if (!(t > 0) || t > tMax) return false;
    const ax = ringPoint(th, t).axialB;
    return ax >= coneB.sA && ax <= coneB.sB;
  };
  const events = [];
  const addEvent = (w, atTouch) => {
    if (!Number.isFinite(w) || Math.abs(w) >= Wm) return;
    const a = Math.acos(w / Wm);
    events.push({ a: phiW + a, atTouch }, { a: phiW - a, atTouch });
  };
  addEvent(-al0 / coneA.radA, true);
  addEvent(-(al0 + tMax * nd) / (coneA.radA + tMax * coneA.slope), false);
  if (Math.abs(coneA.slope) > 1e-12) addEvent(-nd / coneA.slope, false);
  // The ends of cone B's frustum: the axial coordinate along B's axis of the generatrix
  // point is g (sA + t) + (radA + slope t) q(th), with g = dA . dB and q = r(th) . dB. Times
  // the denominator (nd + slope w) it is linear in w and q, so axialB = S is
  // K0 + Kw w + Kq q = 0, i.e. a + b cos th + c sin th = 0 (and the touch points are where
  // it equals B's tangent circle, S = sA of B).
  const bu = vecDot(frameA.u, dB), bv = vecDot(frameA.v, dB);
  const Kq = coneA.radA * nd - coneA.slope * al0;
  [[coneB.sA, true], [coneB.sB, false]].forEach(([S, atTouch]) => {
    const K0 = g * (coneA.sA * nd - al0) - S * nd, Kw = g * (coneA.sA * coneA.slope - coneA.radA) - S * coneA.slope;
    const Pc = Kw * nu + Kq * bu, Ps = Kw * nv + Kq * bv, Pm = Math.hypot(Pc, Ps);
    if (Pm < 1e-12 || Math.abs(K0) >= Pm) return;
    const a = Math.acos(-K0 / Pm), phiP = Math.atan2(Ps, Pc);
    events.push({ a: phiP + a, atTouch }, { a: phiP - a, atTouch });
  });
  // Sorted, with events closer than the arc test can resolve merged into one.
  const sorted = events.map(e => ({ a: ((e.a % TWO_PI) + TWO_PI) % TWO_PI, atTouch: e.atTouch })).sort((p, q) => p.a - q.a);
  const cuts = [];
  sorted.forEach(e => {
    const last = cuts[cuts.length - 1];
    if (last && e.a - last.a < 1e-7) last.atTouch = last.atTouch || e.atTouch; else cuts.push({ ...e });
  });
  if (cuts.length > 1 && cuts[0].a + TWO_PI - cuts[cuts.length - 1].a < 1e-7) { cuts[0].atTouch = cuts[0].atTouch || cuts.pop().atTouch; }
  // Arcs between consecutive change angles (each remembers whether its two ends are at
  // touch points); the ring is the cyclic run of valid ones that ends at a touch point on
  // both sides, else the longest run.
  const arcs = cuts.length
    ? cuts.map((c, i) => ({ a: c.a, span: (i + 1 < cuts.length ? cuts[i + 1].a : cuts[0].a + TWO_PI) - c.a, from: c.atTouch, to: cuts[(i + 1) % cuts.length].atTouch }))
    : [{ a: 0, span: TWO_PI, from: false, to: false }];
  const valid = arcs.map(r => r.span > 1e-9 && onRing(r.a + r.span / 2));
  let run = null;
  if (valid.some(Boolean) && !valid.every(Boolean)) {
    const first = valid.indexOf(false), rank = (r) => (r.from && r.to ? 1 : 0);
    for (let k = 1, cur = null; k <= arcs.length; k++) {
      const i = (first + k) % arcs.length;
      if (valid[i]) cur = cur ? { ...cur, span: cur.span + arcs[i].span, to: arcs[i].to } : { theta0: arcs[i].a, span: arcs[i].span, from: arcs[i].from, to: arcs[i].to };
      if ((!valid[i] || k === arcs.length) && cur) {
        if (!run || rank(cur) > rank(run) || (rank(cur) === rank(run) && cur.span > run.span)) run = cur;
        cur = null;
      }
    }
    if (run) run = { theta0: run.theta0, span: run.span };
  }

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
  const back = [touch[0], ...circle(e1, e2, phi[0], phiEnd, arcSteps(phiEnd - phi[0], rho, tol)).slice(1, -1), touch[1]];

  let front;
  if (run) {
    // Cut the arc into chords no farther than tol from it: halve a segment until its
    // middle is within tol of the chord (never fewer than 4 segments of the arc).
    const at = (th) => { const q = ringPoint(th, tAt(th)); return { p: onPlane(q.point), n: q.outward, n2: q.n2 }; };
    const dist = (a, b) => len(vecSub(a, b));
    const pts = [];
    const split = (th0, p0, th1, p1, depth) => {
      const thm = (th0 + th1) / 2, pm = at(thm), chordMid = scale(add(p0.p, p1.p), 0.5);
      if (depth < 12 && (depth < 2 || dist(pm.p, chordMid) > tol)) split(th0, p0, thm, pm, depth + 1);
      pts.push(pm);
      if (depth < 12 && (depth < 2 || dist(pm.p, chordMid) > tol)) split(thm, pm, th1, p1, depth + 1);
    };
    const th0 = run.theta0, th1 = run.theta0 + run.span;
    const eStart = at(th0), eEnd = at(th1);
    split(th0, eStart, th1, eEnd, 0);
    const startsAtPlus = dist(eStart.p, touch[0].p) <= dist(eStart.p, touch[1].p);
    front = [startsAtPlus ? touch[0] : touch[1], ...pts, startsAtPlus ? touch[1] : touch[0]];
  } else {
    // The surfaces never leave each other past the sphere: use the other half
    // of the circle so the ring still closes.
    const other = phiEnd > phi[0] ? phiEnd - 2 * Math.PI : phiEnd + 2 * Math.PI;
    front = [touch[0], ...circle(e1, e2, phi[0], other, arcSteps(other - phi[0], rho, tol)).slice(1, -1), touch[1]];
  }

  // Close the ring: front runs P_start -> P_end, so the back must run P_end -> P_start.
  const frontStartsAtPlus = front[0] === touch[0] || len(vecSub(front[0].p, touch[0].p)) < 1e-9;
  const backBack = frontStartsAtPlus ? back.slice().reverse() : back;
  const loop = [...front, ...backBack.slice(1)];
  // The ring is the crease of cone A's generatrices over this cyclic angle range.
  const ringRange = run;
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
    return rel <= ringRange.span + 1e-9;
  };
  return [farA, farB].map((far) => {
    const frame = coneFrame(node, far), cone = tangentCone(node, far, frame);
    // The silhouette generatrices: the outward normal r(a) cosT + axis sinT has z = 0
    // where r.z = u.z cos a + v.z sin a = Wz cos(a - psi) equals -axis.z tanT, so
    // a = psi +- acos(-axis.z tanT / Wz) (none when |.| >= 1: no silhouette).
    const Wz = Math.hypot(frame.u.z, frame.v.z), psi = Math.atan2(frame.v.z, frame.u.z);
    const c = Wz > 1e-12 ? -frame.dir.z * (cone.sinT / cone.cosT) / Wz : Infinity;
    const out = [];
    const angles = Math.abs(c) < 1 ? [psi + Math.acos(c), psi - Math.acos(c)].map(a => ((a % TWO_PI) + TWO_PI) % TWO_PI).sort((a, b) => a - b) : [];
    for (const th of angles) {
      const at = coneSurface(node, frame, cone, th);
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
