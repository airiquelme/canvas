// The host mesh of a split cone (CLAUDE.md "Split cone") as the convex hull of its node bodies, for hosts with
// squashed nodes. For a convex mesh this is the solid the sphere code's host sdf adds up from spheres, capsules and
// faces. Its signed distance from a point x is the maximum over unit normals n of
//   phi(n) = n . x - H(n),   H(n) = max_i h_i(n)  (the hull's support function),
// i.e. phi = min_i phi_i with every phi_i = n . x - h_i(n) concave. So the maximum is attained either at one body's own
// maximizer (its nearest-point normal, closed form up to a root: hullCone.js bodyNearestNormal), or on a tie of two
// bodies (along the ruled curve of their hull cone: hullProbe), or at a tie of three (a face: the normal of the plane
// tangent to all three, a Newton solve done once per host). Every candidate is evaluated with the true H, so a wrong
// candidate can't win and the result is exact. A table of 4096 fixed normals only SEEDS the search: its best normal
// tells which bodies are (nearly) active there, and only those candidates are tried.
import { supportH, supportPoint, vecDot, vecSub, vecNormalize, vecCross, sphereFace } from './geometry.js';
import { buildHullCone, hullProbe, bodyNearestNormal } from './hullCone.js';

const M = 4096;
const NX = new Float64Array(M), NY = new Float64Array(M), NZ = new Float64Array(M);
// Fibonacci sphere.
for (let i = 0; i < M; i++) {
  const z = 1 - (2 * (i + 0.5)) / M, r = Math.sqrt(1 - z * z), a = i * 2.399963229728653;
  NX[i] = r * Math.cos(a); NY[i] = r * Math.sin(a); NZ[i] = z;
}

// The normals of the hull's flat faces: the plane tangent to three bodies, i.e. h_i = h_j = h_k, two unknowns on the unit
// sphere (the gradients of the supports being the support points), solved by Newton from two seeds on each side of the
// plane of the centers: the plane's own normal, and the closed-form face of three spheres of the bodies' support radii
// along the current normal (a fixed point iteration; close even when the radii differ a lot). A solution is a face of the
// hull only if the three are the largest supports there.
function faceNormals(bodies, i, j, k) {
  const b = [bodies[i], bodies[j], bodies[k]], out = [];
  const base = vecCross(vecSub(b[1].center, b[0].center), vecSub(b[2].center, b[0].center));
  if (Math.hypot(base.x, base.y, base.z) < 1e-9) return out;
  const n0 = vecNormalize(base);
  const newton = (start) => {
    let n = start;
    for (let it = 0; it < 40; it++) {
      const p = b.map(q => supportPoint(q, n)), h = p.map(q => vecDot(q, n));
      const f1 = h[0] - h[1], f2 = h[1] - h[2];
      if (Math.abs(f1) < 1e-11 && Math.abs(f2) < 1e-11) return n;
      const proj = (g) => { const d = vecDot(g, n); return { x: g.x - n.x * d, y: g.y - n.y * d, z: g.z - n.z * d }; };
      const a = proj(vecSub(p[0], p[1])), bb = proj(vecSub(p[1], p[2]));
      const helper = Math.abs(n.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
      const e1 = vecNormalize(vecCross(n, helper)), e2 = vecCross(n, e1);
      const a1 = vecDot(a, e1), a2 = vecDot(a, e2), b1 = vecDot(bb, e1), b2 = vecDot(bb, e2), det = a1 * b2 - a2 * b1;
      if (Math.abs(det) < 1e-14) return null;
      const d1 = (-f1 * b2 + f2 * a2) / det, d2 = (-a1 * f2 + b1 * f1) / det;
      n = vecNormalize({ x: n.x + e1.x * d1 + e2.x * d2, y: n.y + e1.y * d1 + e2.y * d2, z: n.z + e1.z * d1 + e2.z * d2 });
    }
    return null;
  };
  const valid = (n) => {
    const hs = bodies.map(q => supportH(q, n)), top = Math.max(...hs);
    return [i, j, k].every(q => hs[q] >= top - 1e-7 * (1 + Math.abs(top)));
  };
  [1, -1].forEach(sign => {
    const outN = { x: n0.x * sign, y: n0.y * sign, z: n0.z * sign };
    let fp = outN;
    for (let it = 0; it < 30; it++) {
      const f = sphereFace(b.map(q => q.center), b.map(q => supportH(q, fp) - vecDot(q.center, fp)), outN);
      if (!f) break;
      const nn = vecNormalize(f.n), moved = Math.abs(nn.x - fp.x) + Math.abs(nn.y - fp.y) + Math.abs(nn.z - fp.z);
      fp = nn;
      if (moved < 1e-13) break;
    }
    [fp, outN].forEach(seed => {
      const n = newton(seed);
      if (n && valid(n) && !out.some(m => Math.abs(m.x - n.x) + Math.abs(m.y - n.y) + Math.abs(m.z - n.z) < 1e-8)) out.push(n);
    });
  });
  return out;
}

// bodies: [{ center, shape }] (nodes).
export function buildHostHull(bodies) {
  const H = new Float64Array(M);
  for (let i = 0; i < M; i++) {
    const n = { x: NX[i], y: NY[i], z: NZ[i] };
    let h = -Infinity;
    for (const b of bodies) h = Math.max(h, supportH(b, n));
    H[i] = h;
  }
  let span = 0;
  bodies.forEach(a => bodies.forEach(b => { span = Math.max(span, Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y, a.center.z - b.center.z)); }));
  span += Math.max(...bodies.map(b => Math.max(...b.shape.ex)));
  // for every table normal, the bodies whose support is within a twentieth of the host's size of the top one
  const near = new Int32Array(M);
  for (let i = 0; i < M; i++) {
    const n = { x: NX[i], y: NY[i], z: NZ[i] };
    let mask = 0;
    bodies.forEach((b, k) => { if (supportH(b, n) >= H[i] - 0.05 * span) mask |= 1 << k; });
    near[i] = mask;
  }
  const pairs = [], faces = [];
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      pairs.push({ i, j, cone: buildHullCone(bodies[i], bodies[j], 96) });
      for (let k = j + 1; k < bodies.length; k++) faceNormals(bodies, i, j, k).forEach(n => faces.push({ i, j, k, n }));
    }
  }
  return { bodies, H, near, pairs, faces, span };
}

// The signed distance (negative inside) of x to the hull, with the maximizing normal: the slope of the distance along any
// line through x is that normal . the line's direction.
export function hostProbe(host, x) {
  const { H, bodies } = host;
  const vals = new Float64Array(M);
  let tb = -Infinity, bi = 0;
  for (let i = 0; i < M; i++) {
    const v = NX[i] * x.x + NY[i] * x.y + NZ[i] * x.z - H[i];
    vals[i] = v;
    if (v > tb) { tb = v; bi = i; }
  }
  const n0 = { x: NX[bi], y: NY[bi], z: NZ[bi] };
  // The table is exact only where the maximum is smooth; at a kink (a face or a pair's ridge) it can be a couple of units
  // off and its best normal can sit anywhere along the ridge. So the bodies in play are those of every table normal whose
  // value is within a hundredth of the host's size of the best, not just of the best one.
  const eps = 0.01 * host.span;
  let mask = 0;
  for (let i = 0; i < M; i++) if (vals[i] >= tb - eps) mask |= host.near[i];
  const active = bodies.map((_, k) => k).filter(k => mask & (1 << k));
  let best = tb, bn = n0;
  const consider = (n) => {
    if (!n) return;
    let h = -Infinity;
    for (const b of bodies) h = Math.max(h, supportH(b, n));
    const v = x.x * n.x + x.y * n.y + x.z * n.z - h;
    if (v > best) { best = v; bn = n; }
  };
  active.forEach(i => consider(bodyNearestNormal(bodies[i], x)));
  host.pairs.forEach(p => { if (active.includes(p.i) && active.includes(p.j)) consider(hullProbe(p.cone, x, undefined, false).n); });
  host.faces.forEach(f => { if (active.includes(f.i) && active.includes(f.j) && active.includes(f.k)) consider(f.n); });
  return { value: best, n: bn };
}
