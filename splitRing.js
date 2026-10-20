// Where a split cone changes color (CLAUDE.md "Split cone"), in 3D. The
// cone is the tangent hull of its two end spheres; the split is a circle
// perpendicular to its axis, slid out from the shared node until it just
// clears the host mesh. Pure 3D, independent of the camera.
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

// The split circle: the smallest axial s (from the shared node outward) at
// which the whole circle is outside the host mesh. Returns
// { s, dir, surface, ringRadius, frame, cone, touch } -- `touch` is the ring
// point closest to the host (on its edge when the ring was slid).
export function findSplitRing(shared, far, hostMesh) {
  const frame = coneFrame(shared, far);
  const cone = tangentCone(shared, far, frame);
  const hostSdf = buildHostSdf(hostMesh, shared.id);
  const ringPoint = (s, a) => coneSurface(shared, frame, cone, a)(s).point;

  // The ring's clearance at s, and where it is smallest.
  const clearance = (s) => {
    let min = Infinity, at = 0;
    for (let i = 0; i < RING_SAMPLES; i++) {
      const a = (i / RING_SAMPLES) * Math.PI * 2;
      const d = hostSdf(ringPoint(s, a));
      if (d < min) { min = d; at = a; }
    }
    return { min, at };
  };
  const clear = (s) => clearance(s).min + CLEAR_TOL;

  let s = cone.sA;
  if (clear(cone.sA) < 0) {
    for (let j = 1; j <= SLIDE_STEPS; j++) {
      const s1 = cone.sA + (cone.sB - cone.sA) * j / SLIDE_STEPS;
      if (clear(s1) >= 0) {
        s = bisectRoot(clear, cone.sA + (cone.sB - cone.sA) * (j - 1) / SLIDE_STEPS, s1);
        break;
      }
    }
  }

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
    touch: ringPoint(s, clearance(s).at),
  };
}
