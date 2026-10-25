// Where a split cone changes color (CLAUDE.md "Split cone"), in 3D. The
// cone is the tangent hull of its two end spheres; the split is a circle
// perpendicular to its axis at the host's first contact (findSplitRing), found
// per host element in closed form. Pure 3D, independent of the camera.
import {
  vecSub, vecDot, sdfSphere, sdfFrustum, bisectRoot, hullPlanes, pointInTriangle, sphereFace, supportPoint,
} from './geometry.js';
import { coneFrame } from './shapes.js';
import { buildHullCone, hullNormal } from './hullCone.js';
import { buildHostHull, hostProbe } from './hostHull.js';
import { nodes } from './scene.js';

const RING_SAMPLES = 128, SLIDE_STEPS = 64;
// Slack so a ring resting exactly on the shared sphere counts as clear.
const CLEAR_TOL = 1e-6;

// The cone as drawn. It touches the shared sphere along a circle at axial
// distance sA; a circle at axial s has radius radA + slope * (s - sA).
export function tangentCone(shared, far, frame) {
  const sinT = (shared.radius - far.radius) / frame.len, cosT = Math.sqrt(1 - sinT * sinT);
  return {
    sinT, cosT, sA: shared.radius * sinT, sB: frame.len + far.radius * sinT,
    radA: shared.radius * cosT, slope: -sinT / cosT,
  };
}

// The semi-axes of a cone end along the cone's axis and across it: a sphere's radius both ways, an axial spheroid's
// (scene.js finalizeShapes: squashed along the axis to its partner) ra and rp. A body may give its own `ra` / `rp` (the
// joint's flat solid, render.js computeJoints).
const endAxes = (n) => (n.ra !== undefined ? [n.ra, n.rp] : n.shape && n.shape.axial ? [n.shape.ra, n.shape.rp] : [n.radius, n.radius]);

// The cone between two bodies of revolution about the axis between their centers (spheres, or spheroids squashed
// along it), in tangentCone's terms. Every meridian plane shows the same two axis-aligned ellipses, so the hull is a
// circular cone and its normal n = cosT r + sinT d is where their supports agree:
//   sqrt(raN^2 s^2 + rpN^2 c^2) = D s + sqrt(raF^2 s^2 + rpF^2 c^2)        (s = sinT, c = cosT, D the distance)
// Squared twice it is a quadratic in x = s^2 (closed form); the root that satisfies the equation itself is the outer
// tangent. Each end touches the cone along the circle at axial offset ra^2 s / h, radius rp^2 c / h (its support point,
// h = its support). Two spheres give tangentCone's numbers exactly.
export function coaxialCone(shared, far, frame) {
  const [raN, rpN] = endAxes(shared), [raF, rpF] = endAxes(far);
  if (raN === rpN && raF === rpF) return tangentCone(shared, far, frame);
  const D = frame.len, aN = raN * raN, bN = rpN * rpN, aF = raF * raF, bF = rpF * rpF;
  // A^2 = bN + (aN - bN) x, B^2 = bF + (aF - bF) x; 4 A^2 B^2 = (A^2 + B^2 - D^2 x)^2
  const p1 = aN - bN, q1 = aF - bF, m = p1 + q1 - D * D, c0 = bN + bF;
  const qa = m * m - 4 * p1 * q1, qb = 2 * m * c0 - 4 * (bN * q1 + bF * p1), qc = c0 * c0 - 4 * bN * bF;
  const xs = Math.abs(qa) < 1e-12 * (Math.abs(qb) + Math.abs(qc)) ? [-qc / qb] : (() => {
    const disc = qb * qb - 4 * qa * qc;
    if (disc < 0) return [];
    const r = Math.sqrt(disc);
    return [(-qb + r) / (2 * qa), (-qb - r) / (2 * qa)];
  })();
  const hN = (sn, cs) => Math.sqrt(aN * sn * sn + bN * cs * cs), hF = (sn, cs) => Math.sqrt(aF * sn * sn + bF * cs * cs);
  let best = null;
  xs.filter(x => x >= 0 && x < 1).forEach(x => [Math.sqrt(x), -Math.sqrt(x)].forEach(sinT => {
    const cosT = Math.sqrt(1 - sinT * sinT), err = Math.abs(hN(sinT, cosT) - D * sinT - hF(sinT, cosT));
    if (!best || err < best.err) best = { sinT, cosT, err };
  }));
  if (!best) return tangentCone({ radius: rpN }, { radius: rpF }, frame);
  const { sinT, cosT } = best, h0 = hN(sinT, cosT), h1 = hF(sinT, cosT);
  return { sinT, cosT, sA: aN * sinT / h0, sB: D + aF * sinT / h1, radA: bN * cosT / h0, slope: -sinT / cosT };
}

// The cone surface at axial distance s and angle a, with its outward normal.
export function coneSurface(shared, frame, cone, a) {
  const r = frame.radial(a);
  const outward = {
    x: r.x * cone.cosT + frame.dir.x * cone.sinT,
    y: r.y * cone.cosT + frame.dir.y * cone.sinT,
    z: r.z * cone.cosT + frame.dir.z * cone.sinT,
  };
  return (s) => {
    const rad = cone.radA + cone.slope * (s - cone.sA);
    return {
      point: {
        x: shared.center.x + frame.dir.x * s + r.x * rad,
        y: shared.center.y + frame.dir.y * s + r.y * rad,
        z: shared.center.z + frame.dir.z * s + r.z * rad,
      },
      outward,
    };
  };
}

// The host mesh's elements as sdf closures (negative inside): each node's
// sphere, a frustum per node pair, and one flat face per hull face.
// `solid` is the face's prism (3 centers + 3 contact points), also an sdf.
export function hostElements(hostMesh, sharedId, planes) {
  const els = [];
  const hostNodes = hostMesh.nodeIds.map(id => nodes[id]);
  hostNodes.forEach(n => els.push({
    kind: n.id === sharedId ? 'shared' : 'sphere', sdf: (p) => sdfSphere(p, n.center, n.radius),
  }));
  hostNodes.forEach((a, i) => hostNodes.slice(i + 1).forEach(b => els.push({
    kind: 'frustum', sdf: (p) => sdfFrustum(p, a.center, a.radius, b.center, b.radius),
  })));
  // Faces are flat triangles, not solids: they only add curves, never bury.
  // Each is the plane tangent to its three spheres (the face you see).
  planes.forEach(({ n: outN, idx }) => {
    const centers = idx.map(i => hostNodes[i].center);
    const face = sphereFace(centers, idx.map(i => hostNodes[i].radius), outN);
    if (!face) return;
    const prism = hullPlanes([...centers, ...face.tri]);
    els.push({
      kind: 'face', flat: true, sdf: (q) => vecDot(face.n, vecSub(q, face.p)), accept: (q) => pointInTriangle(q, face.tri),
      solid: prism.length ? (q) => maxPlane(prism, q) : null,
    });
  });
  return els;
}

// Signed value of a convex polytope: max over its planes (negative inside).
function maxPlane(planes, q) {
  let m = -Infinity;
  planes.forEach(({ n, p }) => { m = Math.max(m, vecDot(n, vecSub(q, p))); });
  return m;
}

// The host mesh as one solid: negative inside, zero on its visible boundary.
export function buildHostSdf(hostMesh, sharedId) {
  const centerPlanes = hullPlanes(hostMesh.nodeIds.map(id => nodes[id].center));
  const parts = hostElements(hostMesh, sharedId, centerPlanes)
    .map(el => el.flat ? el.solid : el.sdf).filter(Boolean);
  if (centerPlanes.length) parts.push((q) => maxPlane(centerPlanes, q));
  return (p) => parts.reduce((m, f) => Math.min(m, f(p)), Infinity);
}

// The split circle: the circle of the cone, perpendicular to its axis, at the
// host's first contact: the largest axial s at which the cone's circle still
// meets the host, coming in from the far node (before it, from the shared node
// out, the circle is in the host or touching it). The host is the union of its
// spheres, the tangent cones between each pair of them (its capsules, the same
// solid as the cones drawn) and its faces (planes tangent to three spheres); each
// gives its own last contact in closed form (firstContact) and the ring takes the
// largest. Camera-independent, so cached. Returns
// { s, dir, surface, ringRadius, frame, cone, touch } -- `touch` is the point
// where the ring meets the host.
// One entry per cone (shared, far, host), compared by the numbers of the nodes it was
// computed from, so any change of a node (however it is made) recomputes it.
const ringCache = new Map();
const snapshot = (...ns) => ns.flatMap(n => [n.id, n.center.x, n.center.y, n.center.z, n.radius, n.shape.ra, n.shape.rp, n.shape.axis.x, n.shape.axis.y, n.shape.axis.z]);
export function findSplitRing(shared, far, hostMesh) {
  const id = `${shared.id}:${far.id}:${hostMesh.id}`;
  const snap = snapshot(shared, far, ...hostMesh.nodeIds.map(nid => nodes[nid]));
  const hit = ringCache.get(id);
  if (hit && hit.snap.length === snap.length && hit.snap.every((v, i) => v === snap[i])) return hit.ring;
  const hostNodes = hostMesh.nodeIds.map(nid => nodes[nid]);
  // A round shared node and host with a round or axial far end (scene.js finalizeShapes: the cone is circular,
  // coaxialCone): the closed forms of the sphere cone. Any other squashed node: the uniform closed form (all the same
  // shape) or the general numeric ring (below), kept for free-axis shapes.
  const general = [shared, ...hostNodes].some(n => !n.shape.isSphere) || !(far.shape.isSphere || far.shape.axial);
  const ring = (general && (findUniformSplitRing(shared, far, hostNodes) || findGeneralSplitRing(shared, far, hostNodes))) || sphereSplitRing(shared, far, hostNodes);
  ringCache.set(id, { snap, ring });
  return ring;
}

// The split ring of a cone of spheres (the nodes are { id, center, radius }, the host's among them): closed forms.
export function sphereSplitRing(shared, far, hostNodes) {
  const frame = coneFrame(shared, far);
  const cone = coaxialCone(shared, far, frame);
  const { s, touch } = firstContact(shared, hostNodes, frame, cone);
  return {
    s, frame, cone, dir: frame.dir,
    surface: {
      x: shared.center.x + frame.dir.x * s, y: shared.center.y + frame.dir.y * s, z: shared.center.z + frame.dir.z * s,
    },
    ringRadius: cone.radA + cone.slope * (s - cone.sA),
    // The cone's tangent circle on the shared sphere (where the sphere ends).
    tangentCenter: {
      x: shared.center.x + frame.dir.x * cone.sA, y: shared.center.y + frame.dir.y * cone.sA, z: shared.center.z + frame.dir.z * cone.sA,
    },
    tangentRadius: cone.radA,
    touch,
  };
}

// The cone's circle at axial s has radius R(s) = R0 + k s and points
// o + d s + R(s) r(a), r(a) = u cos a + v sin a. For each host element, the
// largest s at which that circle still meets it:
//  - a sphere (c, rho): the circle point nearest c is in c's radial direction, so
//    they meet while (h - s)^2 + (R(s) - q)^2 <= rho^2 (h, q: c's axial and radial
//    coordinates): the larger root of a quadratic;
//  - a capsule from the shared node: it and the split cone are both tangent to the
//    shared sphere, so they meet in a plane (Monge; see jointCurve.js). A point at
//    distance l along a cone's generatrix past its tangent circle has
//    |X - o|^2 - r^2 = l^2 and (X - o).axis - r sinT = l cosT, so on both cones
//    l = L/cosT and the surfaces meet where LA/cosA = LB/cosB, a plane. Along
//    generatrix a of the split cone the plane is at l = (P - Q w)/(U - V w), with
//    w = n . r(a) between -W and W: monotonic in w, so the largest l is at w = +-W
//    or, past a pole, unbounded (then the frustums' ends: the spheres take over);
//  - a face (plane n, outward): the circle has a point inside while
//    n.(o - p) + s n.d - R(s) |n_perp| <= 0, linear in s; kept if the circle's
//    contact point is on the face's triangle (else an edge or sphere is the contact);
//  - a capsule between two other spheres: along each generatrix the line's exit
//    from the cone is a quadratic root (closed form); its largest value over the
//    generatrices is found numerically (CAPSULE_ANGLES, then golden section).
// The shared sphere touches the cone at sA. Returns { s, touch }, s in [sA, sB].
const CAPSULE_ANGLES = 72;
function firstContact(shared, hostNodes, frame, cone) {
  const o = shared.center, d = frame.dir, u = frame.radial(0), v = frame.radial(Math.PI / 2);
  const k = cone.slope, R0 = cone.radA - k * cone.sA;
  const at = (a, s) => coneSurface(shared, frame, cone, a)(s).point;
  const angleOf = (w) => Math.atan2(vecDot(w, v), vecDot(w, u));
  const add = (p, q, t = 1) => ({ x: p.x + q.x * t, y: p.y + q.y * t, z: p.z + q.z * t });
  let best = { s: cone.sA, a: 0 };
  const consider = (s, a) => { if (Number.isFinite(s) && s > best.s) best = { s, a }; };

  // Spheres.
  hostNodes.forEach(n => {
    if (n.id === shared.id) return;
    const w = vecSub(n.center, o), h = vecDot(w, d), wr = add(w, d, -h), q = Math.hypot(wr.x, wr.y, wr.z);
    const A = 1 + k * k, B = 2 * (-h + k * (R0 - q)), C = h * h + (R0 - q) * (R0 - q) - n.radius * n.radius;
    const disc = B * B - 4 * A * C;
    if (disc >= 0) consider((-B + Math.sqrt(disc)) / (2 * A), q > 1e-9 ? angleOf(wr) : 0);
  });

  // Capsules.
  const lA = (cone.sB - cone.sA) / cone.cosT;
  hostNodes.forEach((p, i) => hostNodes.slice(i + 1).forEach(q => {
    if (p.id === shared.id || q.id === shared.id) {
      const b = p.id === shared.id ? q : p;
      const fB = coneFrame(shared, b), cB = tangentCone(shared, b, fB), r = shared.radius;
      const n = add({ x: d.x / cone.cosT, y: d.y / cone.cosT, z: d.z / cone.cosT }, fB.dir, -1 / cB.cosT);
      const rhs = r * (cone.sinT / cone.cosT - cB.sinT / cB.cosT);
      const N = vecDot(n, d), U = vecDot(n, u), V = vecDot(n, v), W = Math.hypot(U, V), phi = Math.atan2(V, U);
      if (Math.hypot(n.x, n.y, n.z) < 1e-12) return;
      // l(w) = (al - be w) / (ga - de w), valid on both frustums for 0 <= l <= lMax.
      const lMax = Math.min(lA, (cB.sB - cB.sA) / cB.cosT);
      const al = rhs - r * cone.sinT * N, be = r * cone.cosT, ga = cone.cosT * N, de = cone.sinT;
      const l = (w) => (al - be * w) / (ga - de * w);
      const rising = de * al - be * ga > 0;
      // The range of l over w in [-W, W], as intervals; the largest valid l in it.
      const w0 = Math.abs(de) > 1e-12 ? ga / de : Infinity, pole = Math.abs(w0) < W;
      const lo = l(-W), hi = l(W);
      const ranges = !pole ? [[Math.min(lo, hi), Math.max(lo, hi)]]
        : rising ? [[lo, Infinity], [-Infinity, hi]] : [[-Infinity, lo], [hi, Infinity]];
      let lBest = -Infinity;
      ranges.forEach(([r0, r1]) => { if (r1 >= 0 && r0 <= lMax) lBest = Math.max(lBest, Math.min(r1, lMax)); });
      if (lBest === -Infinity) return;
      // The generatrix where it is reached: l(w) = lBest is linear in w.
      const wStar = Math.max(-W, Math.min(W, (al - lBest * ga) / (be - lBest * de)));
      consider(cone.sA + lBest * cone.cosT, phi + Math.acos(W > 1e-12 ? wStar / W : 1));
      return;
    }
    const fK = coneFrame(p, q), cK = tangentCone(p, q, fK), e = fK.dir;
    // The exit s of generatrix a's line from the capsule's cone, between its tangent circles.
    const exitAt = (a) => {
      const ra = frame.radial(a), Y0 = vecSub(add(o, ra, R0), p.center), D = add(d, ra, k);
      const t0 = vecDot(Y0, e), te = vecDot(D, e);
      const c0 = cK.radA + cK.slope * (t0 - cK.sA), c1 = cK.slope * te;
      const A = vecDot(D, D) - te * te - c1 * c1, B = 2 * (vecDot(Y0, D) - t0 * te - c0 * c1);
      const C = vecDot(Y0, Y0) - t0 * t0 - c0 * c0;
      const inside = (s) => { const t = t0 + te * s; return t >= cK.sA && t <= cK.sB && c0 + c1 * s >= 0; };
      const roots = [];
      if (Math.abs(A) < 1e-12) { if (Math.abs(B) > 1e-12) roots.push(-C / B); }
      else { const disc = B * B - 4 * A * C; if (disc >= 0) roots.push((-B - Math.sqrt(disc)) / (2 * A), (-B + Math.sqrt(disc)) / (2 * A)); }
      // Where the line is inside the cone: between the roots (A > 0) or outside them.
      // Its last point inside, also within the frustum's axial range.
      const tBounds = te !== 0 ? [(cK.sA - t0) / te, (cK.sB - t0) / te] : [];
      const cands = [...roots, ...tBounds].filter(s => Number.isFinite(s)).filter(s => {
        const Y = add(Y0, D, s), t = vecDot(Y, e), rad = cK.radA + cK.slope * (t - cK.sA);
        return inside(s) && vecDot(Y, Y) - t * t - rad * rad <= 1e-9 * (1 + rad * rad);
      });
      return cands.length ? Math.max(...cands) : -Infinity;
    };
    // The scan only seeds: the two best local maxima of exitAt over CAPSULE_ANGLES angles are each refined by a golden
    // section to rounding error (exitAt is smooth between its kinks, so a peak between seeds is found from the seed beside it).
    const seeds = Array.from({ length: CAPSULE_ANGLES }, (_, i) => exitAt((i / CAPSULE_ANGLES) * Math.PI * 2));
    const peaks = seeds.map((v, i) => ({ v, i })).filter(({ v, i }) => v > -Infinity && v >= seeds[(i + CAPSULE_ANGLES - 1) % CAPSULE_ANGLES] && v >= seeds[(i + 1) % CAPSULE_ANGLES])
      .sort((p, q) => q.v - p.v).slice(0, 2);
    const g = (Math.sqrt(5) - 1) / 2, stepA = Math.PI * 2 / CAPSULE_ANGLES;
    peaks.forEach(({ v, i }) => {
      const bestA = i * stepA;
      let lo = bestA - stepA, hi = bestA + stepA;
      for (let it = 0; it < 60; it++) {
        const m1 = hi - g * (hi - lo), m2 = lo + g * (hi - lo);
        if (exitAt(m1) >= exitAt(m2)) hi = m2; else lo = m1;
      }
      const aStar = (lo + hi) / 2, sStar = Math.max(exitAt(aStar), v);
      consider(sStar, exitAt(aStar) >= v ? aStar : bestA);
    });
  }));

  // Faces.
  hullPlanes(hostNodes.map(n => n.center)).forEach(({ n: outN, idx }) => {
    const face = sphereFace(idx.map(i => hostNodes[i].center), idx.map(i => hostNodes[i].radius), outN);
    if (!face) return;
    const N = vecDot(face.n, d), nPerp = add(face.n, d, -N), m = Math.hypot(nPerp.x, nPerp.y, nPerp.z);
    const slope = N - k * m;
    if (m < 1e-12 || slope <= 1e-12) return;
    const s = (R0 * m - vecDot(face.n, vecSub(o, face.p))) / slope, a = angleOf({ x: -nPerp.x, y: -nPerp.y, z: -nPerp.z });
    if (pointInTriangle(at(a, s), face.tri)) consider(s, a);
  });

  const s = Math.min(best.s, cone.sB);
  return { s, touch: at(best.a, s) };
}

// The cone's last contact with the host, the counterpart of the split ring's
// touch: walking each generatrix from the far node toward the shared one, its
// entry is where it first goes into the host (or, if it never does, its tangent
// point on the shared sphere, s = sA). The touch is the generatrix whose entry is
// farthest out; this is the one whose entry is nearest the shared node. Equal
// entries (an arc of generatrices all reaching the sphere) resolve to the middle
// of the longest run. Returns { s, angle, point, onSphere }.
const lastCache = new Map();
export function findLastContact(shared, far, hostMesh) {
  const id = `${shared.id}:${far.id}:${hostMesh.id}`;
  const snap = snapshot(shared, far, ...hostMesh.nodeIds.map(nid => nodes[nid]));
  const hit = lastCache.get(id);
  if (hit && hit.snap.length === snap.length && hit.snap.every((v, i) => v === snap[i])) return hit.contact;
  const contact = computeLastContact(shared, far, hostMesh);
  lastCache.set(id, { snap, contact });
  return contact;
}

function computeLastContact(shared, far, hostMesh) {
  const frame = coneFrame(shared, far);
  const cone = coaxialCone(shared, far, frame);
  const hostSdf = buildHostSdf(hostMesh, shared.id);
  const step = (cone.sB - cone.sA) / SLIDE_STEPS;

  const entries = Array.from({ length: RING_SAMPLES }, (_, i) => {
    const at = coneSurface(shared, frame, cone, (i / RING_SAMPLES) * Math.PI * 2);
    const buried = (s) => hostSdf(at(s).point) + CLEAR_TOL;
    if (buried(cone.sB) < 0) return cone.sB;
    for (let j = SLIDE_STEPS - 1; j >= 0; j--) {
      const s0 = cone.sA + step * j;
      if (buried(s0) < 0) return bisectRoot(buried, s0, s0 + step);
    }
    return cone.sA;
  });

  const min = Math.min(...entries), tol = 1e-9 * frame.len;
  const tied = entries.map(s => s - min <= tol);
  let best = { start: entries.indexOf(min), count: 1 };
  if (!tied.every(Boolean)) {
    const first = tied.indexOf(false);
    for (let k = 1, run = 0; k <= RING_SAMPLES; k++) {
      const i = (first + k) % RING_SAMPLES;
      if (tied[i]) run++;
      else run = 0;
      if (run > best.count) best = { start: (i - run + 1 + RING_SAMPLES) % RING_SAMPLES, count: run };
    }
  }
  const angle = ((best.start + (best.count - 1) / 2) / RING_SAMPLES) * Math.PI * 2;
  return { s: min, angle, point: coneSurface(shared, frame, cone, angle)(min).point, onSphere: min === cone.sA };
}

// ---------------------------------------------------------
// SPLIT RING WITH SQUASHED NODES
// ---------------------------------------------------------
// The ring is where the cone's cross-section by a *slicing plane* last meets the host. The planes are
// { (p - c_shared) . w = const } with w = Q_shared^-1 d (d the unit axis, Q = S^2 of the shared node), scaled so that
// the constant is the axial distance of the point where the plane crosses the axis. For a round shared node w = d (planes
// perpendicular to the axis, as always); in general these are exactly the planes perpendicular to the axis once the
// shared body is a sphere (the linear map S^-1), which is what makes the uniform closed form below the same ring.

// The inverse of a symmetric 3 x 3 matrix (9 numbers, row-major).
function inv3(Q) {
  const [a, b, c, , e, f, , , i] = Q;
  const A = e * i - f * f, B = c * f - b * i, C = b * f - c * e, det = a * A + b * B + c * C;
  return [A / det, B / det, C / det, B / det, (a * i - c * c) / det, (b * c - a * f) / det, C / det, (b * c - a * f) / det, (a * e - b * b) / det];
}

// The slicing plane normal w (see above), as a function ell(p) = (p - c_shared) . w, and w.
function slicingPlanes(shared, dir) {
  const Qi = inv3(shared.shape.Q);
  const w = { x: Qi[0] * dir.x + Qi[1] * dir.y + Qi[2] * dir.z, y: Qi[3] * dir.x + Qi[4] * dir.y + Qi[5] * dir.z, z: Qi[6] * dir.x + Qi[7] * dir.y + Qi[8] * dir.z };
  const k = 1 / (w.x * dir.x + w.y * dir.y + w.z * dir.z), o = shared.center;
  w.x *= k; w.y *= k; w.z *= k;
  return { w, ell: (p) => (p.x - o.x) * w.x + (p.y - o.y) * w.y + (p.z - o.z) * w.z };
}

// The general numeric ring. The cone is the hull cone of the two bodies (hullCone.js) and the host the convex hull of its
// bodies (hostHull.js). Along each generatrix pN + t (pF - pN) the host distance is convex in t and <= 0 at t = 0 (the
// shared body is in the host), so it leaves the host at its largest t with distance <= 0: Newton from t = 1 (the table's
// slope is the best normal . the line's direction). Its slicing-plane constant is ell(pN) + t (ell(pF) - ell(pN)), and the
// ring is at the largest over the generatrices (the last plane at which the cone's cross-section still meets the host),
// refined in azimuth for a grazing contact, kept where every generatrix crosses. Returns the fields render.js reads (s,
// dir, surface, touch, frame) and `general = { cone, tStar }`: the cone and, per generatrix, its parameter t at the ring,
// so the ring's points are the generatrices' points at tStar.
const SPLIT_GENS = 96;
export function findGeneralSplitRing(shared, far, hostNodes) {
  const host = buildHostHull(hostNodes);
  const cone = buildHullCone(shared, far, SPLIT_GENS);
  if (cone.degenerate) return null;
  const { frame, gens } = cone, dir = frame.dir, o = shared.center, { ell } = slicingPlanes(shared, dir);
  const exitT = (pN, d) => {
    const at = (t) => hostProbe(host, { x: pN.x + d.x * t, y: pN.y + d.y * t, z: pN.z + d.z * t });
    let t = 1, probe = at(t);
    if (probe.value <= 0) return 1;
    for (let it = 0; it < 40; it++) {
      const slope = vecDot(probe.n, d);
      if (!(slope > 1e-12)) return 0;
      const next = t - probe.value / slope;
      if (next <= 0) return 0;
      t = next;
      probe = at(t);
      if (Math.abs(probe.value) < 1e-9) break;
    }
    return t;
  };
  const lA = gens.map(g => ell(g.pA)), lB = gens.map(g => ell(g.pB));
  const ts = gens.map(g => exitT(g.pA, vecSub(g.pB, g.pA)));
  const ss = gens.map((g, i) => lA[i] + ts[i] * (lB[i] - lA[i]));
  let bi = 0;
  ss.forEach((v, i) => { if (v > ss[bi]) bi = i; });
  // Refine the maximum over the azimuth around the best generatrix.
  const sAt = (psi) => {
    const h = hullNormal(shared, far, frame, psi);
    if (h.none) return -Infinity;
    const pN = supportPoint(shared, h.n), pF = supportPoint(far, h.n), t = exitT(pN, vecSub(pF, pN));
    const a = ell(pN);
    return a + t * (ell(pF) - a);
  };
  const step = (Math.PI * 2) / gens.length;
  let lo = gens[bi].psi - step, hi = gens[bi].psi + step, sBest = ss[bi], psiBest = gens[bi].psi;
  const gr = (Math.sqrt(5) - 1) / 2;
  for (let it = 0; it < 24; it++) {
    const p1 = hi - gr * (hi - lo), p2 = lo + gr * (hi - lo), f1 = sAt(p1), f2 = sAt(p2);
    if (f1 > sBest) { sBest = f1; psiBest = p1; }
    if (f2 > sBest) { sBest = f2; psiBest = p2; }
    if (f1 >= f2) hi = p2; else lo = p1;
  }
  // Only where every generatrix crosses the plane is the cross-section a closed curve.
  const sMin = Math.max(...lA), sMax = Math.min(...lB);
  const s = sMin < sMax ? Math.max(sMin, Math.min(sMax, sBest)) : (sMin + sMax) / 2;
  const tStar = gens.map((g, i) => Math.max(0, Math.min(1, (s - lA[i]) / (lB[i] - lA[i]))));
  const hb = hullNormal(shared, far, frame, psiBest), touch = (() => {
    if (hb.none) return { x: o.x + dir.x * s, y: o.y + dir.y * s, z: o.z + dir.z * s };
    const pN = supportPoint(shared, hb.n), pF = supportPoint(far, hb.n), a = ell(pN), t = Math.max(0, Math.min(1, (s - a) / (ell(pF) - a)));
    return { x: pN.x + (pF.x - pN.x) * t, y: pN.y + (pF.y - pN.y) * t, z: pN.z + (pF.z - pN.z) * t };
  })();
  return {
    s, frame, dir,
    surface: { x: o.x + dir.x * s, y: o.y + dir.y * s, z: o.z + dir.z * s },
    touch,
    general: { cone, tStar },
  };
}

// The uniform closed form: when the shared node, the far node and every host node have the same squash and axis
// (their radii may differ), S_i = r_i T for one linear map T, so under T^-1 they are spheres of radius r_i and the whole
// problem (cone, host, first contact) is the sphere problem, solved in closed form by sphereSplitRing. The map is
// affine, so hulls, generatrices and their parameters t carry over and the slicing planes of the mapped problem (perpendicular
// to the mapped axis) are exactly the slicing planes above. The ring's generatrices are T of the sphere cone's (analytic, no
// Newton) and the constant is s = s' / |T^-1 d|. null when the nodes are not uniform or the sphere cone is degenerate.
export function findUniformSplitRing(shared, far, hostNodes) {
  const all = [shared, far, ...hostNodes], first = shared.shape;
  const sq = (n) => n.shape.ra / n.radius;
  if (!all.every(n => !n.shape.isSphere && Math.abs(sq(n) - sq(shared)) < 1e-12 && Math.abs(vecDot(n.shape.axis, first.axis)) > 1 - 1e-12)) return null;
  const q = sq(shared), a = first.axis, rq = Math.sqrt(q);
  const T = (v) => { const k = (q - 1 / rq) * vecDot(a, v); return { x: v.x / rq + k * a.x, y: v.y / rq + k * a.y, z: v.z / rq + k * a.z }; };
  const Ti = (v) => { const k = (1 / q - rq) * vecDot(a, v); return { x: v.x * rq + k * a.x, y: v.y * rq + k * a.y, z: v.z * rq + k * a.z }; };
  const mk = (n) => ({ id: n.id, center: Ti(n.center), radius: n.radius });
  const shM = mk(shared), frM = mk(far), hostM = hostNodes.map(mk);
  const frameM = coneFrame(shM, frM), coneM = tangentCone(shM, frM, frameM);
  if (!Number.isFinite(coneM.sinT) || !Number.isFinite(coneM.cosT) || coneM.cosT < 1e-9) return null;
  const ringM = sphereSplitRing(shM, frM, hostM);
  const frame = coneFrame(shared, far), dir = frame.dir, o = shared.center;
  const dm = Ti(dir), s = ringM.s / Math.hypot(dm.x, dm.y, dm.z);
  const t = Math.max(0, Math.min(1, (ringM.s - coneM.sA) / (coneM.sB - coneM.sA)));
  const gens = Array.from({ length: SPLIT_GENS }, (_, i) => {
    const psi = (i / SPLIT_GENS) * Math.PI * 2, at = coneSurface(shM, frameM, coneM, psi);
    return { psi, pA: T(at(coneM.sA).point), pB: T(at(coneM.sB).point) };
  });
  return {
    s, frame, dir,
    surface: { x: o.x + dir.x * s, y: o.y + dir.y * s, z: o.z + dir.z * s },
    touch: T(ringM.touch),
    general: { cone: { gens, degenerate: null }, tStar: gens.map(() => t) },
  };
}
