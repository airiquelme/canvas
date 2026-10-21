// Where a split cone changes color (CLAUDE.md "Split cone"), in 3D. The
// cone is the tangent hull of its two end spheres; the split is a circle
// perpendicular to its axis at the host's first contact (findSplitRing), found
// per host element in closed form. Pure 3D, independent of the camera.
import {
  vecSub, vecDot, sdfSphere, sdfFrustum, bisectRoot, hullPlanes, pointInTriangle, sphereFace,
} from './geometry.js';
import { coneFrame } from './shapes.js';
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
const snapshot = (...ns) => ns.flatMap(n => [n.id, n.center.x, n.center.y, n.center.z, n.radius]);
export function findSplitRing(shared, far, hostMesh) {
  const id = `${shared.id}:${far.id}:${hostMesh.id}`;
  const snap = snapshot(shared, far, ...hostMesh.nodeIds.map(nid => nodes[nid]));
  const hit = ringCache.get(id);
  if (hit && hit.snap.length === snap.length && hit.snap.every((v, i) => v === snap[i])) return hit.ring;
  const frame = coneFrame(shared, far);
  const cone = tangentCone(shared, far, frame);
  const { s, touch } = firstContact(shared, hostMesh, frame, cone);
  const ring = {
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
  ringCache.set(id, { snap, ring });
  return ring;
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
const CAPSULE_ANGLES = 360;
function firstContact(shared, hostMesh, frame, cone) {
  const o = shared.center, d = frame.dir, u = frame.radial(0), v = frame.radial(Math.PI / 2);
  const k = cone.slope, R0 = cone.radA - k * cone.sA;
  const at = (a, s) => coneSurface(shared, frame, cone, a)(s).point;
  const angleOf = (w) => Math.atan2(vecDot(w, v), vecDot(w, u));
  const add = (p, q, t = 1) => ({ x: p.x + q.x * t, y: p.y + q.y * t, z: p.z + q.z * t });
  let best = { s: cone.sA, a: 0 };
  const consider = (s, a) => { if (Number.isFinite(s) && s > best.s) best = { s, a }; };
  const hostNodes = hostMesh.nodeIds.map(id => nodes[id]);

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
    let bestA = 0, bestS = -Infinity;
    for (let i = 0; i < CAPSULE_ANGLES; i++) {
      const a = (i / CAPSULE_ANGLES) * Math.PI * 2, s = exitAt(a);
      if (s > bestS) { bestS = s; bestA = a; }
    }
    if (bestS === -Infinity) return;
    let lo = bestA - Math.PI * 2 / CAPSULE_ANGLES, hi = bestA + Math.PI * 2 / CAPSULE_ANGLES;
    const g = (Math.sqrt(5) - 1) / 2;
    for (let it = 0; it < 60; it++) {
      const m1 = hi - g * (hi - lo), m2 = lo + g * (hi - lo);
      if (exitAt(m1) >= exitAt(m2)) hi = m2; else lo = m1;
    }
    const aStar = (lo + hi) / 2, sStar = Math.max(exitAt(aStar), bestS);
    consider(sStar, exitAt(aStar) >= bestS ? aStar : bestA);
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
  const cone = tangentCone(shared, far, frame);
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
