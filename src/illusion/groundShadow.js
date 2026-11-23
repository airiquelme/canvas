// A moving capsule's shadow on the ground (stylized sun, light.js): its two end spheres projected along the sun onto the ground's
// tangent plane under it. A sphere's shadow on a plane is an ellipse, r across the sun's in-plane direction and r / |n . L| along
// it; both ends' ellipses have that same shape, so scaling the plane by |n . L| along that direction makes them circles, whose
// capsule (two arcs, two tangent lines) maps back to the shadow's exact outline: arcs of 3D ellipses on the plane and lines.
// Returns its sides on screen and its x, z box, or null (the sun is down, or the plane is edge-on to it).
import { line } from './shape.js';
import { ellipseEdge } from './sheet.js';

const add = (p, q, k = 1) => ({ x: p.x + q.x * k, y: p.y + q.y * k, z: p.z + q.z * k });
const sub = (p, q) => ({ x: p.x - q.x, y: p.y - q.y, z: p.z - q.z });
const dot = (p, q) => p.x * q.x + p.y * q.y + p.z * q.z;
const cross = (p, q) => ({ x: p.y * q.z - p.z * q.y, y: p.z * q.x - p.x * q.z, z: p.x * q.y - p.y * q.x });
const unit = (p) => { const l = Math.hypot(p.x, p.y, p.z) || 1; return { x: p.x / l, y: p.y / l, z: p.z / l }; };

export function capsuleShadow(o, H, L, projector) {
  if (L.y <= 0.02) return null;
  const c = { x: (o.a.c.x + o.b.c.x) / 2, y: (o.a.c.y + o.b.c.y) / 2, z: (o.a.c.z + o.b.c.z) / 2 };
  // Where the ray from the center away from the sun meets the ground, and the ground's normal there. The ray's height over the
  // ground f(t) falls at most (L.y + 1.5 |L horizontal|) per unit for slopes up to 1.5, so a step of f over that can't pass the
  // ground; then bisection. (Six fixed-point steps t = (c.y - H) / L.y diverged on slopes steeper than tan(elevation): with the
  // low default sun, 11% of the movers' shadows were off by over 10 units, the worst by 334.)
  const f = (t) => c.y - t * L.y - H(c.x - t * L.x, c.z - t * L.z);
  const rate = L.y + 1.5 * Math.hypot(L.x, L.z);
  let t = 0, ft = f(0), prev = 0;
  if (ft <= 0) return null;   // (its center under the ground)
  for (let k = 0; k < 400 && ft > 0.01; k++) {
    prev = t;
    t += Math.max(0.25, ft / rate);
    ft = f(t);
    if (t > 5000) return null;
  }
  if (ft < 0) { let a = prev, b = t; for (let k = 0; k < 30; k++) { const m = (a + b) / 2; if (f(m) > 0) a = m; else b = m; } t = (a + b) / 2; }
  const G = { x: c.x - t * L.x, y: c.y - t * L.y, z: c.z - t * L.z }, e = 1;
  const n = unit({ x: -(H(G.x + e, G.z) - H(G.x - e, G.z)) / (2 * e), y: 1, z: -(H(G.x, G.z + e) - H(G.x, G.z - e)) / (2 * e) });
  const nl = dot(n, L);
  if (nl < 0.05) return null;
  // Plane frame: e1 along the sun's in-plane direction, e2 across; the scale k = n . L squeezes the shadow ellipses into circles.
  let e1 = sub(L, { x: n.x * nl, y: n.y * nl, z: n.z * nl });
  if (Math.hypot(e1.x, e1.y, e1.z) < 1e-6) e1 = cross(n, { x: 1, y: 0, z: 0 });
  e1 = unit(e1);
  const e2 = cross(n, e1), k = nl;
  const onPlane = (P) => { const s = dot(sub(P, G), n) / nl; return add(P, L, -s); };   // along the sun onto the plane
  const flat = (P) => { const d = sub(P, G); return { x: dot(d, e1) * k, y: dot(d, e2) }; };   // plane coords, squeezed
  const back = (q) => add(add(G, e1, q.x / k), e2, q.y);
  const A = flat(onPlane(o.a.c)), B = flat(onPlane(o.b.c)), ra = o.a.r, rb = o.b.r;
  // The capsule of circles (A, ra), (B, rb) in the squeezed plane: outer tangents.
  const dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy);
  const T = projector.toCamera, P = projector.persp, sides = [];
  const arc3 = (C, r, t0, t1) => {   // the circle (C, r) in squeezed coords, as a 3D ellipse on the plane, from t0 to t1
    const Cw = back(C), Uw = sub(back({ x: C.x + r, y: C.y }), Cw), Vw = sub(back({ x: C.x, y: C.y + r }), Cw);
    const Cc = T(Cw), Uc = sub(T(add(Cw, Uw)), Cc), Vc = sub(T(add(Cw, Vw)), Cc);
    sides.push(...ellipseEdge(Cc, Uc, Vc, t0, t1, P, 0));
  };
  const scr = (q) => projector.projectPoint(back(q));
  if (d <= Math.abs(ra - rb) + 1e-9) {   // one circle holds the other
    const [C, r] = ra >= rb ? [A, ra] : [B, rb];
    arc3(C, r, 0, Math.PI);
    arc3(C, r, Math.PI, 2 * Math.PI);
  } else {
    const phi = Math.atan2(dy, dx), w = Math.acos((ra - rb) / d);   // tangent points at angles phi +- w
    const pa = (s) => ({ x: A.x + ra * Math.cos(phi + s * w), y: A.y + ra * Math.sin(phi + s * w) });
    const pb = (s) => ({ x: B.x + rb * Math.cos(phi + s * w), y: B.y + rb * Math.sin(phi + s * w) });
    arc3(B, rb, phi - w, phi + w);                      // B's cap (the far side from A)
    sides.push(line(scr(pb(1)), scr(pa(1))));
    arc3(A, ra, phi + w, phi + 2 * Math.PI - w);        // A's cap
    sides.push(line(scr(pa(-1)), scr(pb(-1))));
  }
  // x, z box: the two shadow ellipses' boxes.
  const box = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
  for (const [C, r] of [[A, ra], [B, rb]]) for (let j = 0; j < 8; j++) {
    const p = back({ x: C.x + r * Math.cos((j * Math.PI) / 4) * 1.09, y: C.y + r * Math.sin((j * Math.PI) / 4) * 1.09 });
    box.x0 = Math.min(box.x0, p.x); box.x1 = Math.max(box.x1, p.x); box.z0 = Math.min(box.z0, p.z); box.z1 = Math.max(box.z1, p.z);
  }
  return { sides, box };
}
