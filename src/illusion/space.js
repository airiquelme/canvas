// Keeping the world's shapes apart in 3D (world.js): every static shape is placed only where it overlaps no other shape and no
// mover's orbit.
// - A shape's PARTS: segments with a radius whose capsules hold it. A capsule is one part with its larger radius (conservative
//   for a tapered one); a bent tube (curve.js: X(th) = M + U cos th + V sin th, r0 + r1 cos th) is a chain of BENT_PARTS, each with
//   the larger radius of its ends plus the chord's sagitta bound (a ribbon the same, its half-width as the radius); a panel or
//   disc one segment along its longer half-axis, its radius the shorter half-axis (it reaches every corner).
// - Two shapes overlap when two of their parts' segments come closer than the sum of the radii (closest points of two segments,
//   closed form). Candidates come from a multi-level grid (`Space`, below).
// - A mover's ORBIT (`lane`): a horizontal circle (radius R at height y) swept by a ball of radius `rad` (its reach, bob
//   included). A part keeps clear of it when every point of its segment is farther than rad + r from the circle.

const BENT_PARTS = 8;

const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const arr = (p) => [p.x, p.y, p.z];
const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

export function partsOf(o) {
  if (o.kind === 'panel' || o.kind === 'disc') {   // flat: a segment along the longer half-axis, its radius the shorter one
    const l1 = Math.hypot(o.e1.x, o.e1.y, o.e1.z), l2 = Math.hypot(o.e2.x, o.e2.y, o.e2.z), [L, S] = l1 >= l2 ? [o.e1, l2] : [o.e2, l1];
    return [{ p: [o.c.x - L.x, o.c.y - L.y, o.c.z - L.z], q: [o.c.x + L.x, o.c.y + L.y, o.c.z + L.z], r: S }];
  }
  if (!o.bend) return [{ p: arr(o.a.c), q: arr(o.b.c), r: Math.max(o.a.r, o.b.r) }];
  const A = arr(o.a.c), B = arr(o.b.c), S = arr(o.bend);
  const M = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2], U = sub(A, M), V = sub(S, M);
  const r0 = (o.a.r + o.b.r) / 2, r1 = (o.a.r - o.b.r) / 2;
  const sag = Math.max(Math.sqrt(dot(U, U)), Math.sqrt(dot(V, V))) * (1 - Math.cos(Math.PI / (2 * BENT_PARTS)));
  const at = (k) => {
    const th = (Math.PI * k) / BENT_PARTS, c = Math.cos(th), s = Math.sin(th);
    return { x: [M[0] + U[0] * c + V[0] * s, M[1] + U[1] * c + V[1] * s, M[2] + U[2] * c + V[2] * s], r: r0 + r1 * c };
  };
  const parts = [];
  let prev = at(0);
  for (let k = 1; k <= BENT_PARTS; k++) {
    const cur = at(k);
    parts.push({ p: prev.x, q: cur.x, r: Math.max(prev.r, cur.r) + sag });
    prev = cur;
  }
  return parts;
}

// Squared distance between segments p1 q1 and p2 q2 (closest points, clamped to both).
function segDist2(p1, q1, p2, q2) {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r), EPS = 1e-12;
  let s, t;
  if (a <= EPS && e <= EPS) { s = 0; t = 0; }
  else if (a <= EPS) { s = 0; t = clamp01(f / e); }
  else {
    const c = dot(d1, r);
    if (e <= EPS) { t = 0; s = clamp01(-c / a); }
    else {
      const b = dot(d1, d2), den = a * e - b * b;
      s = den > EPS ? clamp01((b * f - c * e) / den) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); }
      else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  const x = p1[0] + d1[0] * s - p2[0] - d2[0] * t, y = p1[1] + d1[1] * s - p2[1] - d2[1] * t, z = p1[2] + d1[2] * s - p2[2] - d2[2] * t;
  return x * x + y * y + z * z;
}

function boxOf(parts) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const { p, q, r } of parts) for (let k = 0; k < 3; k++) {
    lo[k] = Math.min(lo[k], p[k] - r, q[k] - r); hi[k] = Math.max(hi[k], p[k] + r, q[k] + r);
  }
  return { lo, hi };
}
const boxesMeet = (a, b) => a.lo[0] <= b.hi[0] && b.lo[0] <= a.hi[0] && a.lo[1] <= b.hi[1] && b.lo[1] <= a.hi[1] && a.lo[2] <= b.hi[2] && b.lo[2] <= a.hi[2];

function partsMeet(A, B) {
  for (const a of A) for (const b of B) {
    const R = a.r + b.r;
    if (segDist2(a.p, a.q, b.p, b.q) < R * R) return true;
  }
  return false;
}

// Each shape is registered on its own level (the first whose cells are at least its size, so it spans at most 2 cells per axis)
// and on every coarser one. Two shapes always meet on the coarser of their two levels: a query reads, on its own level, every
// shape registered there (`all`: its own size and smaller), and on each coarser level only the shapes native to it (`own`).
// At most 8 cells per level either way.
const LEVELS = [64, 512, 4096, 32768, 262144, Infinity];

const cellsOf = (box, size, fn) => {
  if (size === Infinity) { fn('*'); return; }
  for (let i = Math.floor(box.lo[0] / size); i <= Math.floor(box.hi[0] / size); i++)
    for (let j = Math.floor(box.lo[1] / size); j <= Math.floor(box.hi[1] / size); j++)
      for (let k = Math.floor(box.lo[2] / size); k <= Math.floor(box.hi[2] / size); k++) fn(`${i},${j},${k}`);
};
const levelOf = (box) => {
  const ext = Math.max(box.hi[0] - box.lo[0], box.hi[1] - box.lo[1], box.hi[2] - box.lo[2]);
  return LEVELS.findIndex((size) => size >= ext);
};
const push = (map, key, it) => { const c = map.get(key); if (c) c.push(it); else map.set(key, [it]); };

export class Space {
  constructor() {
    this.items = [];
    this.levels = LEVELS.map((size) => ({ size, own: new Map(), all: new Map() }));
    this.lanes = [];
    this.stamp = 0;
  }
  // True when the parts overlap a shape already placed or an orbit.
  hits(parts) {
    const box = boxOf(parts), stamp = ++this.stamp;
    for (const lane of this.lanes) if (laneHits(lane, parts)) return true;
    const test = (it) => {
      if (it.stamp === stamp) return false;
      it.stamp = stamp;
      return boxesMeet(box, it.box) && partsMeet(parts, it.parts);
    };
    const l0 = levelOf(box);
    for (let l = l0; l < LEVELS.length; l++) {
      const L = this.levels[l], map = l === l0 ? L.all : L.own;
      if (!map.size) continue;
      let hit = false;
      cellsOf(box, L.size, (key) => { if (!hit) { const c = map.get(key); if (c && c.some(test)) hit = true; } });
      if (hit) return true;
    }
    return false;
  }
  add(parts) {
    const box = boxOf(parts), it = { parts, box, stamp: 0 }, l0 = levelOf(box);
    for (let l = l0; l < LEVELS.length; l++) {
      const L = this.levels[l];
      cellsOf(box, L.size, (key) => { push(L.all, key, it); if (l === l0) push(L.own, key, it); });
    }
    this.items.push(it);
  }
  // Places the object if it overlaps nothing; returns whether it did.
  place(o) {
    const parts = partsOf(o);
    if (this.hits(parts)) return false;
    this.add(parts);
    return true;
  }
}

// An orbit: center C (world, the circle's axis is vertical through it), radius R, height y, swept ball radius rad.
export const lane = (C, R, y, rad) => ({ cx: C.x, cz: C.z, R, y, rad });

// Horizontal distance from the orbit's axis to a segment (2D point-segment distance: its lower bound along the segment).
function axisDist(L, p, q) {
  const ax = p[0] - L.cx, az = p[2] - L.cz, dx = q[0] - p[0], dz = q[2] - p[2], l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? clamp01(-(ax * dx + az * dz) / l2) : 0;
  return Math.hypot(ax + t * dx, az + t * dz);
}

export function laneHits(L, parts) {
  for (const { p, q, r } of parts) {
    const reach = L.rad + r;
    if (Math.min(p[1], q[1]) - reach > L.y || Math.max(p[1], q[1]) + reach < L.y) continue;
    const rhoMin = axisDist(L, p, q), rhoMax = Math.max(Math.hypot(p[0] - L.cx, p[2] - L.cz), Math.hypot(q[0] - L.cx, q[2] - L.cz));
    if (rhoMin - reach > L.R || rhoMax + reach < L.R) continue;
    // Sampled along the segment, each sample standing for its half-step either side.
    const d = sub(q, p), len = Math.sqrt(dot(d, d)), m = Math.max(1, Math.min(256, Math.ceil(len / (0.5 * L.rad + 1)))), half = len / m / 2;
    for (let k = 0; k <= m; k++) {
      const t = k / m, x = p[0] + d[0] * t, y = p[1] + d[1] * t, z = p[2] + d[2] * t;
      if (Math.hypot(Math.hypot(x - L.cx, z - L.cz) - L.R, y - L.y) < reach + half) return true;
    }
  }
  return false;
}

// The orbits as obstacles for the shapes placed after them.
export function partsHitShapes(space, L) {
  return space.items.some((it) => laneHits(L, it.parts));
}
