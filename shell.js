// Shells (CLAUDE.md "Shells"): parts of spheroids drawn as open surfaces. Pure math, no canvas.
//
// A shell is x = c + T u, u on the unit sphere, T = [r e1, r e2, r roundness a]: roundness 1 a sphere, < 1 oblate, 0 a flat disc
// (the curvature at the pole is roundness / r). T is affine, so every test is a *cap* { n, d } = { u : n . u >= d } on the unit
// sphere, bounded by a circle: the cuts (given in u-space, so a part keeps its outline as the roundness changes), the face toward the
// camera (u . p >= 1, p = T^-1 (camPos - c): its circle is the contour) and the lit side (u . T^-1 L >= 0, a great circle). A piece is
// an intersection of caps, its boundary arcs of circles, and every circle is a planar 3D ellipse in the world: exact on screen.
import { vecSub, vecDot, vecCross, vecNormalize } from './geometry.js';

export const shells = {};
let nextShellId = 1;

// `cuts`: a list of caps (the helpers below, concatenated). `spin` turns e1 about the axis (radians).
// `group`: same-colored shells that read as one surface never stroke each other. With `zone` (a shell id, a joint's ball) they are
// exempt only where that shell's silhouette covers them, so outside it they stroke and clip as separate shells.
export function createShell({ center, radius, roundness = 1, axis = { x: 0, y: 1, z: 0 }, spin = 0, cuts = [], color, innerColor = color, group = null, zone = null }) {
  const id = nextShellId++;
  shells[id] = { id, center, radius, roundness, axis, spin, cuts, color, innerColor, group, zone };
  return id;
}

// The tube light of a joint of two limbs (axes dA, dB pointing away from the ball): the engine's tube light, bent through the ball.
// The light loses its part along the tube and the lit half-section stays fixed in the frame carried along the path (e1 = the bend
// plane's normal, e2 = tangent x e1, tangents -dA into the ball and dB out of it), at the angle phiL the light has at the ball.
// A limb's border is then a straight generatrix; the ball's is the small circle u . e1 = c through the border points on its wedge,
// tangent to both generatrices there, so the border is continuous and tangent at both rims. null: the light runs along the tube.
function tubeLight(dA, dB, L) {
  const cr = vecCross(dA, dB), straight = vecDot(cr, cr) < 1e-8, t = straight ? dB : vecNormalize(vecSub(dB, dA));
  const k = vecDot(L, t), l = { x: L.x - k * t.x, y: L.y - k * t.y, z: L.z - k * t.z }, ll = Math.hypot(l.x, l.y, l.z);
  if (ll < 1e-6) return null;
  const b1 = straight ? { x: l.x / ll, y: l.y / ll, z: l.z / ll } : vecNormalize(cr);
  const tA = { x: -dA.x, y: -dA.y, z: -dA.z }, e2 = (tt) => vecCross(tt, b1);
  const phiL = Math.atan2(vecDot(l, e2(t)), vecDot(l, b1));
  // The unit vector of the cross-section at tube angle phi, in the frame of tangent tt.
  const at = (tt, phi) => { const q = e2(tt), c = Math.cos(phi), s = Math.sin(phi); return { x: c * b1.x + s * q.x, y: c * b1.y + s * q.y, z: c * b1.z + s * q.z }; };
  return { b1, phiL, tA, tB: dB, at };
}

// A joint (CLAUDE.md "Shells"): a ball of `radius` at `center` and one limb per `{ dir, length, color }`, a half prolate spheroid of the
// same equatorial radius whose equator is a great circle of the ball, so the two surfaces are tangent there. The ball keeps only the
// part outside the limbs (a plane per limb through its center, pushed `underlapPx` into the limb so it underpaints the rim). All are
// one group (unless `joined` is false: plain shells), exempt from strokes only inside the ball's silhouette. Each is lit by its own exact normals;
// `tube` lights the joint with the bent-tube light instead (`tubeLight`: one border running through the ball, tangent at both rims). Returns { ball, limbs }.
export function joint({ center, radius, limbs, color, innerColor = color, underlapPx = 1.5, joined = true, tube = false }) {
  const ball = createShell({ center, radius, color, innerColor });
  const f = shellFrame(shells[ball]), eps = underlapPx / radius;
  shells[ball].cuts = limbs.flatMap(l => { const u = f.toU(vecNormalize(l.dir)), k = Math.hypot(...u); return plane([-u[0] / k, -u[1] / k, -u[2] / k], -eps).map(c => ({ ...c, nominal: 0 })); });
  const g = joined ? ball : null;
  shells[ball].group = shells[ball].zone = g;
  const ids = limbs.map(l => {
    const d = vecNormalize(l.dir), id = createShell({ center, radius, roundness: l.length / radius, axis: d, cuts: hemisphere(), color: l.color || color, innerColor: l.color || innerColor, group: g, zone: g });
    shells[id].depthPoint = { x: center.x + d.x * l.length / 2, y: center.y + d.y * l.length / 2, z: center.z + d.z * l.length / 2 };
    return id;
  });
  // Where two limbs meet their surfaces cross in a plane through the center (two spheroids with one equatorial radius r and semi-axes
  // h: x^T (Q_B^-1 - Q_A^-1) x = 0 with Q^-1 = I / r^2 - k d d^T, k = 1 / r^2 - 1 / h^2, i.e. sqrt(kA) x.dA = +- sqrt(kB) x.dB). A's
  // visible part is the side sqrt(kA) x.dA - sqrt(kB) x.dB >= 0 (the points with x.dB < 0 are outside B's half anyway), so the limbs
  // tile the surface and each one's shade region ends at that edge. Pushed `underlapPx` (world units) into the other limb so the seam underpaints.
  if (joined) {
    const k = limbs.map(l => 1 / (radius * radius) - 1 / (l.length * l.length)), dirs = limbs.map(l => vecNormalize(l.dir));
    ids.forEach((id, i) => {
      if (!(k[i] > 0)) return;
      const fl = shellFrame(shells[id]), extra = [];
      ids.forEach((_, j) => {
        if (j === i || !(k[j] > 0)) return;
        const sa = Math.sqrt(k[i]), sb = Math.sqrt(k[j]);
        const w = { x: sa * dirs[i].x - sb * dirs[j].x, y: sa * dirs[i].y - sb * dirs[j].y, z: sa * dirs[i].z - sb * dirs[j].z };
        const u = [fl.r * vecDot(w, fl.e1), fl.r * vecDot(w, fl.e2), fl.h * vecDot(w, fl.a)], len = Math.hypot(...u);
        if (len > 1e-12) extra.push(...plane([u[0] / len, u[1] / len, u[2] / len], -underlapPx * Math.hypot(w.x, w.y, w.z) / len).map(c => ({ ...c, nominal: 0 })));   // underlapPx in world units across the plane
      });
      shells[id].cuts = [...shells[id].cuts, ...extra];
    });
  }
  if (tube && joined && limbs.length === 2) {   // the bent-tube light (off: every shell is lit by its own exact normals)
    const dA = vecNormalize(limbs[0].dir), dB = vecNormalize(limbs[1].dir), HALF = Math.PI / 2;
    // The ball: the small circle u . b1 = c through the border point on A's rim that lies in the wedge, lit on the side toward phiL.
    shells[ball].sunCap = (L, fb) => {
      const tl = tubeLight(dA, dB, L);
      if (!tl) return null;
      const { b1, phiL, tA, at } = tl;
      let s = 1, p = at(tA, phiL + HALF);
      if (vecDot(p, dB) > 0) { s = -1; p = at(tA, phiL - HALF); }
      const c = vecDot(p, b1), sg = vecDot(at(tA, phiL + s * HALF - s * 0.1), b1) < c ? -1 : 1;
      return { n: [sg * vecDot(b1, fb.e1), sg * vecDot(b1, fb.e2), sg * vecDot(b1, fb.a)], d: sg * c };
    };
    // A limb: the plane through its axis, lit toward m = the lit direction of the cross-section in its own frame.
    [[ids[0], 'tA'], [ids[1], 'tB']].forEach(([id, key]) => {
      shells[id].sunCap = (L, fl) => {
        const tl = tubeLight(dA, dB, L);
        if (!tl) return null;
        const m = tl.at(tl[key], tl.phiL), u = [fl.r * vecDot(m, fl.e1), fl.r * vecDot(m, fl.e2), fl.h * vecDot(m, fl.a)], k = Math.hypot(...u);
        return { n: [u[0] / k, u[1] / k, u[2] / k], d: 0 };
      };
    });
  }
  return { ball, limbs: ids };
}

// A rig (CLAUDE.md "Rigs"): balls and bones, a bone ONE shell with a joint at each end. A bone is a prolate spheroid (equatorial r, semi-axis
// h) with a ball tangent to it along a circle at each end (the ball's center on its axis); the balls (radius rho_i < r) a distance D apart
// fix it in closed form: s_i = sqrt(1 - rho_i^2 / r^2), q = sqrt(h^2 - r^2) = D / (s1 + s2), ball i is c_i = q s_i from the bone's center,
// and the tangent circle is the plane at z_i = h^2 s_i / q (z from the center), delta_i = z_i - c_i = s_i r^2 / q behind the ball's center.
// The bone keeps the part between its two tangent planes; a ball keeps the part beyond every incident bone's tangent plane. Two bones tangent
// to the same ball meet in a pair of planes (F_i = S / r_i^2 + beta_i L_i^2 with S the ball's sphere, L_i the tangent plane, beta_i = 1 / h_i^2
// - 1 / r_i^2, so on A's surface F_B = (kA^2 L_A^2 - kB^2 L_B^2) / r_B^2, k = q / h = sqrt(1 - r^2 / h^2)): A keeps kA L_A - kB L_B >= 0
// (L_i = d_i . (x - J) - ell_i, d_i from the ball toward the bone, ell_i = -delta_i). `joint()`'s limbs are the case rho = r (ell = 0).
// Every cut is pushed `underlapPx` into the neighbor and carries `nominal`, the plane itself. All the shells are one `group`.
// balls: [{ center, radius }], bones: [{ a, b, radius }] (indices into balls). Returns { balls: ids, bones: ids }.
export function rig({ balls, bones, color, innerColor = color, underlapPx = 1.5 }) {
  const ballIds = balls.map(b => createShell({ center: b.center, radius: b.radius, color, innerColor }));
  const group = ballIds[0], elems = balls.map(() => []), eps = underlapPx;
  const sub = (p, q) => ({ x: p.x - q.x, y: p.y - q.y, z: p.z - q.z });
  const neg = (v) => ({ x: -v.x, y: -v.y, z: -v.z });
  const info = [];
  const boneIds = bones.map((bn) => {
    const A = balls[bn.a], B = balls[bn.b], r = bn.radius, dv = sub(B.center, A.center), D = Math.hypot(dv.x, dv.y, dv.z), ax = vecNormalize(dv);
    if (!(A.radius < r && B.radius < r)) throw new Error('a bone must be thicker than its balls');
    const s1 = Math.sqrt(1 - (A.radius / r) ** 2), s2 = Math.sqrt(1 - (B.radius / r) ** 2), q = D / (s1 + s2), h = Math.hypot(r, q);
    // The nearest surface point to a ball is on its tangent circle only while the ball's center is inside the focal range: s_i < q / h.
    if (Math.max(s1, s2) >= q / h) throw new Error('rig: a ball is too small for its bone (thicken the ball, thin the bone or lengthen it)');
    const c1 = q * s1, z1 = h * h * s1 / q, z2 = h * h * s2 / q, kappa = q / h;
    const M = { x: A.center.x + ax.x * c1, y: A.center.y + ax.y * c1, z: A.center.z + ax.z * c1 };
    const cap = (n, d, nominal) => ({ ...plane(n, d)[0], nominal });
    const id = createShell({ center: M, radius: r, roundness: h / r, axis: ax, cuts: [cap([0, 0, 1], -(z1 + eps) / h, -z1 / h), cap([0, 0, -1], -(z2 + eps) / h, -z2 / h)], color, innerColor });
    const d1 = ax, d2 = neg(ax), ell1 = -(z1 - c1), ell2 = -(z2 - q * s2);
    elems[bn.a].push({ shell: id, d: d1, kappa, ell: ell1 });
    elems[bn.b].push({ shell: id, d: d2, kappa, ell: ell2 });
    shells[id].rig = { ends: [{ ball: ballIds[bn.a], d: d1, kappa, ell: ell1 }, { ball: ballIds[bn.b], d: d2, kappa, ell: ell2 }] };
    info.push({ id, M });
    return id;
  });
  balls.forEach((b, i) => {
    const ball = shells[ballIds[i]], f = shellFrame(ball);
    ball.rig = { ball: true, J: b.center, radius: b.radius };
    // A ball keeps the part beyond each incident tangent plane: (x - J) . d <= ell (+ the overlap).
    ball.cuts = elems[i].map(e => {
      const du = [vecDot(e.d, f.e1), vecDot(e.d, f.e2), vecDot(e.d, f.a)];
      return { n: [-du[0], -du[1], -du[2]], d: -(e.ell + eps) / b.radius, nominal: -e.ell / b.radius };
    });
    // Bones at the same ball: X keeps kX LX - kY LY >= 0, i.e. n . (x - J) >= c, n = kX dX - kY dY, c = kX ellX - kY ellY.
    for (const X of elems[i]) {
      const sh = shells[X.shell], fX = shellFrame(sh), M = info.find(o => o.id === X.shell).M, rel = sub(M, b.center), extra = [];
      for (const Y of elems[i]) {
        if (Y === X) continue;
        const n = { x: X.kappa * X.d.x - Y.kappa * Y.d.x, y: X.kappa * X.d.y - Y.kappa * Y.d.y, z: X.kappa * X.d.z - Y.kappa * Y.d.z };
        const nl = Math.hypot(n.x, n.y, n.z), c = X.kappa * X.ell - Y.kappa * Y.ell;
        const v = [fX.r * vecDot(n, fX.e1), fX.r * vecDot(n, fX.e2), fX.h * vecDot(n, fX.a)], vl = Math.hypot(...v);
        if (nl < 1e-9 || vl < 1e-12) continue;
        extra.push({ n: [v[0] / vl, v[1] / vl, v[2] / vl], d: (c - vecDot(n, rel) - eps * nl) / vl, nominal: (c - vecDot(n, rel)) / vl });
      }
      sh.cuts = [...sh.cuts, ...extra];
    }
  });
  for (const id of [...ballIds, ...boneIds]) shells[id].group = group;
  return { balls: ballIds, bones: boneIds };
}

// The draw order of a rig's members, farthest first: the pairs that meet at a ball are separated by a plane (an element and its ball: the
// tangent plane, the element is in front when the camera is on its bone side; two elements: kA LA - kB LB, A in front when positive), the
// camera's side of a plane is met first; the order is a topological sort of those pairs, the farthest first (any cycle: the farthest left).
function rigOrder(members, camPos) {
  const byBall = new Map(), before = new Map(members.map(s => [s, new Set()]));
  for (const s of members) if (s.rig && s.rig.ball) byBall.set(s.id, { ball: s, elems: [] });
  for (const s of members) if (s.rig && s.rig.ends) for (const e of s.rig.ends) { const b = byBall.get(e.ball); if (b) b.elems.push({ shell: s, e }); }
  for (const { ball, elems } of byBall.values()) {
    const rel = vecSub(camPos, ball.rig.J), L = (e) => vecDot(e.d, rel) - e.ell;
    for (const x of elems) { if (L(x.e) > 0) before.get(x.shell).add(ball); else before.get(ball).add(x.shell); }
    for (let i = 0; i < elems.length; i++) for (let j = i + 1; j < elems.length; j++) {
      const a = elems[i], b = elems[j];
      if (a.e.kappa * L(a.e) - b.e.kappa * L(b.e) > 0) before.get(a.shell).add(b.shell); else before.get(b.shell).add(a.shell);
    }
  }
  const dist = (s) => { const p = shellMid(s); return Math.hypot(p.x - camPos.x, p.y - camPos.y, p.z - camPos.z); };
  const left = [...members].sort((p, q) => dist(q) - dist(p)), done = new Set(), out = [];
  while (left.length) {
    let i = left.findIndex(s => [...before.get(s)].every(o => done.has(o)));
    if (i < 0) i = 0;
    const [s] = left.splice(i, 1);
    done.add(s); out.push(s);
  }
  return out;
}

// The draw order of one joint's members (its shells, ball = the shell whose id is the group), farthest first. The members tile the surface,
// but on screen they can overlap (a bend's inner side is concave), and what is in front is exact: two members are separated by a plane
// through the ball's center (limb | ball: the limb's rim plane, limb | limb: the stop plane sqrt(kX) x.dX = sqrt(kY) x.dY), and a ray
// from the camera meets the camera's side of any plane first. Members with no such plane (a limb no longer than its radius) go by
// the distance of their middle to the camera.
export function jointOrder(members, camPos) {
  if (members.some(s => s.rig)) return rigOrder(members, camPos);
  const ball = members.find(s => s.id === s.group), J = ball ? ball.center : members[0].center;
  const rel = vecSub(camPos, J), dir = (s) => vecNormalize(s.axis);
  const k = (s) => 1 / (s.radius * s.radius) - 1 / (s.radius * s.roundness) ** 2;
  const near = (X, Y) => {   // is X in front of Y?
    const limbs = [X, Y].filter(s => s !== ball);
    if (limbs.length === 2 && k(X) > 0 && k(Y) > 0) {
      const a = dir(X), b = dir(Y), sx = Math.sqrt(k(X)), sy = Math.sqrt(k(Y));
      return sx * vecDot(a, rel) - sy * vecDot(b, rel) > 0;
    }
    if (limbs.length === 1) { const s = vecDot(dir(limbs[0]), rel); if (Math.abs(s) > 1e-12) return (X === ball) === (s < 0); }
    const dist = (s) => { const p = shellMid(s); return Math.hypot(p.x - camPos.x, p.y - camPos.y, p.z - camPos.z); };
    return dist(X) < dist(Y);
  };
  const left = [...members].sort((p, q) => (q === ball) - (p === ball)), out = [];
  while (left.length) {
    // The next one to draw is behind every other that is left.
    let i = left.findIndex(m => left.every(o => o === m || near(o, m)));
    if (i < 0) i = 0;
    out.push(left.splice(i, 1)[0]);
  }
  return out;
}

// A cap pushed past its plane for an underlap carries `nominal`, the d of the plane itself (the Debug view draws that one).
// Cut helpers, in u-space (e1, e2, axis): each returns a list of caps.
const cap = (n, d) => { const l = Math.hypot(n[0], n[1], n[2]); return { n: [n[0] / l, n[1] / l, n[2] / l], d: d / l }; };
export const plane = (n, d = 0) => [cap(n, d)];
// The half on the axis' side.
export const hemisphere = () => [cap([0, 0, 1], 0)];
// A ribbon: latitudes lat0 <= lat <= lat1 (radians, 0 = equator).
export const band = (lat0, lat1) => [cap([0, 0, 1], Math.sin(lat0)), cap([0, 0, -1], -Math.sin(lat1))];
// Azimuths phi0 <= phi <= phi1 about the axis (from e1 toward e2), a span of at most PI (an intersection of two half-spaces).
export const wedge = (phi0, phi1) => [cap([-Math.sin(phi0), Math.cos(phi0), 0], 0), cap([Math.sin(phi1), -Math.cos(phi1), 0], 0)];
// |u . e1| <= wx, |u . e2| <= wy (fractions of the radius): planes parallel to the axis.
export const box = (wx, wy) => [cap([1, 0, 0], -wx), cap([-1, 0, 0], -wx), cap([0, 1, 0], -wy), cap([0, -1, 0], -wy)];
// A rectangular panel on the axis' side: a floor or a pane at roundness 0, a curved panel above it.
export const panel = (wx, wy) => [...hemisphere(), ...box(wx, wy)];

export const FLAT_EPS = 1e-9;

// The shell's frame: center, e1, e2, axis, radius, roundness; `toWorld(u)` = T u (a direction), `toU(w)` = T^-1 w (not when flat).
export function shellFrame(s) {
  const a = vecNormalize(s.axis);
  const ref = Math.abs(a.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 };
  const k = vecDot(ref, a), b1 = vecNormalize({ x: ref.x - k * a.x, y: ref.y - k * a.y, z: ref.z - k * a.z }), b2 = vecCross(a, b1);
  const cs = Math.cos(s.spin), sn = Math.sin(s.spin);
  const e1 = { x: cs * b1.x + sn * b2.x, y: cs * b1.y + sn * b2.y, z: cs * b1.z + sn * b2.z }, e2 = vecCross(a, e1);
  const r = s.radius, h = r * s.roundness, flat = s.roundness < FLAT_EPS;
  const toWorld = (u) => ({
    x: r * (u[0] * e1.x + u[1] * e2.x) + h * u[2] * a.x,
    y: r * (u[0] * e1.y + u[1] * e2.y) + h * u[2] * a.y,
    z: r * (u[0] * e1.z + u[1] * e2.z) + h * u[2] * a.z,
  });
  const toU = (w) => [vecDot(w, e1) / r, vecDot(w, e2) / r, vecDot(w, a) / h];
  return { c: s.center, e1, e2, a, r, h, flat, toWorld, toU };
}

const dot3 = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const cross3 = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
const TWO_PI = Math.PI * 2;
const mod2pi = (x) => ((x % TWO_PI) + TWO_PI) % TWO_PI;
// `term` marks the light's cap (the terminator), kept by the complement.
export const complement = (k) => ({ n: [-k.n[0], -k.n[1], -k.n[2]], d: -k.d, term: k.term });

// The circle bounding a cap: center d n, radius rho, basis (p, q) with p x q = n, so increasing t runs counterclockwise about n
// with the cap on the left.
function circleOf(k) {
  const n = k.n, ref = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const c = dot3(ref, n), pr = [ref[0] - c * n[0], ref[1] - c * n[1], ref[2] - c * n[2]], pl = Math.hypot(...pr);
  const p = [pr[0] / pl, pr[1] / pl, pr[2] / pl], q = cross3(n, p);
  return { n, d: k.d, m: [k.d * n[0], k.d * n[1], k.d * n[2]], rho: Math.sqrt(Math.max(0, 1 - k.d * k.d)), p, q, term: !!k.term };
}
export const circlePoint = (ci, t) => {
  const c = Math.cos(t) * ci.rho, s = Math.sin(t) * ci.rho;
  return [ci.m[0] + c * ci.p[0] + s * ci.q[0], ci.m[1] + c * ci.p[1] + s * ci.q[1], ci.m[2] + c * ci.p[2] + s * ci.q[2]];
};
const paramOnCircle = (ci, x) => Math.atan2(dot3(ci.q, x), dot3(ci.p, x));

// The boundary of the intersection of caps: { empty } or { whole } or { circles, loops }, each loop a list of arcs
// { ci, t0, t1 } (t1 > t0) running with the region on the left. Arcs of each circle between its crossings with the others are kept
// where their middle lies in every other cap; a circle crossing none is kept whole if it lies in the others.
export function capRegion(caps) {
  const ks = [];
  for (const k of caps) {
    if (k.d >= 1) return { empty: true };
    if (k.d <= -1) continue;
    let skip = false;
    for (const o of ks) {
      const c = dot3(o.n, k.n);
      if (c > 1 - 1e-12 && Math.abs(o.d - k.d) < 1e-12) { skip = true; break; }               // the same cap twice
      if (c < -1 + 1e-12 && Math.abs(o.d + k.d) < 1e-12) return { empty: true };              // a cap and its complement
    }
    if (!skip) ks.push(k);
  }
  if (!ks.length) return { whole: true };
  const circles = ks.map(circleOf), n = circles.length;
  const ts = circles.map(() => []);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const A = circles[i], B = circles[j], c = dot3(A.n, B.n), det = 1 - c * c;
    if (det < 1e-14) continue;
    const al = (A.d - c * B.d) / det, be = (B.d - c * A.d) / det;
    const u0 = [al * A.n[0] + be * B.n[0], al * A.n[1] + be * B.n[1], al * A.n[2] + be * B.n[2]], w = cross3(A.n, B.n);
    const rest = 1 - dot3(u0, u0);
    if (rest <= 1e-14) continue;
    const s = Math.sqrt(rest / det);
    for (const sg of [s, -s]) {
      const x = [u0[0] + sg * w[0], u0[1] + sg * w[1], u0[2] + sg * w[2]];
      ts[i].push(paramOnCircle(A, x));
      ts[j].push(paramOnCircle(B, x));
    }
  }
  const inOthers = (i, x) => ks.every((k, j) => j === i || dot3(k.n, x) >= k.d - 1e-12);
  const arcs = [];
  for (let i = 0; i < n; i++) {
    if (!ts[i].length) {
      if (inOthers(i, circlePoint(circles[i], 0))) arcs.push({ ci: i, t0: 0, t1: TWO_PI, whole: true });
      continue;
    }
    const t = ts[i].map(mod2pi).sort((x, y) => x - y);
    for (let a = 0; a < t.length; a++) {
      const t0 = t[a], t1 = a + 1 < t.length ? t[a + 1] : t[0] + TWO_PI;
      if (t1 - t0 < 1e-12) continue;
      if (inOthers(i, circlePoint(circles[i], (t0 + t1) / 2))) arcs.push({ ci: i, t0, t1 });
    }
  }
  if (!arcs.length) return { empty: true };
  // Chain the arcs into loops: each ends where the next one starts.
  arcs.forEach(r => { r.p0 = circlePoint(circles[r.ci], r.t0); r.p1 = circlePoint(circles[r.ci], r.t1); });
  const dist2 = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
  const used = new Set(), loops = [];
  for (const first of arcs) {
    if (used.has(first)) continue;
    used.add(first);
    const loop = [first];
    let cur = first;
    while (!cur.whole && dist2(cur.p1, first.p0) > 1e-14) {
      let best = null, bd = 1e-10;
      for (const r of arcs) if (!used.has(r) && !r.whole) { const d2 = dist2(cur.p1, r.p0); if (d2 < bd) { bd = d2; best = r; } }
      if (!best) break;
      used.add(best); loop.push(best); cur = best;
    }
    loops.push(loop);
  }
  return { circles, loops };
}

// A circle of u-space as the world's 3D ellipse C + U cos t + V sin t.
export function worldEllipse(f, ci) {
  const m = f.toWorld(ci.m), p = f.toWorld(ci.p), q = f.toWorld(ci.q);
  return { C: { x: f.c.x + m.x, y: f.c.y + m.y, z: f.c.z + m.z }, U: { x: p.x * ci.rho, y: p.y * ci.rho, z: p.z * ci.rho }, V: { x: q.x * ci.rho, y: q.y * ci.rho, z: q.z * ci.rho } };
}

// The range of w . x over the shell's cut region (camera-independent; cached on the shell while its parameters stay put): the
// largest of g . u (g = T^T w) at the interior extreme g / |g| if it is in the region, and on every arc at its extreme or ends.
export function shellRange(s, w) {
  const key = [s.center.x, s.center.y, s.center.z, s.radius, s.roundness, s.axis.x, s.axis.y, s.axis.z, s.spin, s.cuts.length].join();
  if (!s._region || s._region.key !== key) s._region = { key, f: shellFrame(s), reg: capRegion(s.cuts) };
  const { f, reg } = s._region;
  if (reg.empty) return null;
  const g = [vecDot(w, f.e1) * f.r, vecDot(w, f.e2) * f.r, vecDot(w, f.a) * f.h], gl = Math.hypot(...g), base = vecDot(w, f.c);
  const inRegion = (x) => s.cuts.every(k => dot3(k.n, x) >= k.d - 1e-12);
  const extreme = (sg) => {
    let best = -Infinity;
    if (gl > 0 && inRegion([sg * g[0] / gl, sg * g[1] / gl, sg * g[2] / gl])) best = gl;
    if (!reg.whole) for (const loop of reg.loops) for (const r of loop) {
      const ci = reg.circles[r.ci], gp = sg * dot3(g, ci.p), gq = sg * dot3(g, ci.q), gm = sg * dot3(g, ci.m);
      const tStar = Math.atan2(gq, gp), cands = [r.t0, r.t1];
      const k = r.t0 + mod2pi(tStar - r.t0);
      if (k <= r.t1) cands.push(k);
      for (const t of cands) best = Math.max(best, gm + ci.rho * (gp * Math.cos(t) + gq * Math.sin(t)));
    }
    if (reg.whole) best = gl;
    return best;
  };
  return { lo: base - extreme(-1), hi: base + extreme(1) };
}

// The shell's RENDER CENTER, for the draw order: the centroid of the surface it really has (a hemisphere's is toward the side that exists, a
// bone cut between its tangent planes is at the middle of the part drawn), not the center of its spheroid. It is found once, by area-weighted
// samples of the cut region on the unit sphere (a flat shell: of its disc), and kept as an offset in the shell's own frame (e1, e2, axis), so it
// follows the shell when it moves or turns; it is redone only when the shape or the cuts change (the radius, roundness, or the `cuts` list).
const MID_SAMPLES = 2000;
export function shellMid(s) {
  let m = s._mid;
  if (!m || m.cuts !== s.cuts || m.n !== s.cuts.length || m.r !== s.radius || m.rd !== s.roundness) {
    const f = shellFrame(s), r = f.r, h = f.flat ? 0 : f.h;
    let sx = 0, sy = 0, sz = 0, sw = 0;
    for (let i = 0; i < MID_SAMPLES; i++) {
      let u;
      if (f.flat) { const rho = Math.sqrt((i + 0.5) / MID_SAMPLES), t = i * 2.399963229728653; u = [rho * Math.cos(t), rho * Math.sin(t), 0]; }
      else { const z = 1 - 2 * (i + 0.5) / MID_SAMPLES, rho = Math.sqrt(1 - z * z), t = i * 2.399963229728653; u = [rho * Math.cos(t), rho * Math.sin(t), z]; }
      if (!s.cuts.every(k => dot3(k.n, u) >= k.d - 1e-9)) continue;
      const w = f.flat ? 1 : Math.hypot(u[0] / r, u[1] / r, u[2] / h);   // the surface area element of x = T u
      sx += w * r * u[0]; sy += w * r * u[1]; sz += w * h * u[2]; sw += w;
    }
    m = s._mid = { cuts: s.cuts, n: s.cuts.length, r: s.radius, rd: s.roundness, o: sw > 0 ? [sx / sw, sy / sw, sz / sw] : [0, 0, 0] };
  }
  const f = shellFrame(s), o = m.o;
  return { x: s.center.x + o[0] * f.e1.x + o[1] * f.e2.x + o[2] * f.a.x, y: s.center.y + o[0] * f.e1.y + o[1] * f.e2.y + o[2] * f.a.y, z: s.center.z + o[0] * f.e1.z + o[1] * f.e2.z + o[2] * f.a.z };
}

// The pieces of a shell for one camera, back to front: the inside face (where it shows through the opening), then the outside, each as
// its base (Twilight) and its lit part over it; with `lit` false one piece per face in its Lit tone. [{ face: 'inner' | 'outer', lit,
// region, frame }]; with the light on, also each face's unlit part (`dark`: not drawn, the border strokes' tone mask), or [] when nothing shows (camera inside the shell, a flat shell seen edge-on).
export function shellPieces(s, camPos, lightDir, lit = true) {
  const f = shellFrame(s), rel = vecSub(camPos, f.c);
  let front, sun;
  if (f.flat) {
    const sc = Math.sign(vecDot(f.a, rel));
    if (!sc) return [];
    front = { n: [0, 0, sc], d: 0 };
    sun = { n: [0, 0, Math.sign(vecDot(f.a, lightDir)) || 1], d: 0, term: true };
  } else {
    const p = f.toU(rel), pl = Math.hypot(...p);
    if (pl <= 1) return [];
    front = { n: [p[0] / pl, p[1] / pl, p[2] / pl], d: 1 / pl };
    const l = f.toU(lightDir), ll = Math.hypot(...l);
    sun = { n: [l[0] / ll, l[1] / ll, l[2] / ll], d: 0, term: true };
    const own = s.sunCap && s.sunCap(lightDir, f);   // a joint's tube light
    if (own) sun = { n: own.n, d: own.d, term: true };
  }
  const out = [];
  const add = (face, isLit, caps, dark = false) => { const region = capRegion([...s.cuts, ...caps]); if (!region.empty) out.push({ face, lit: isLit, dark, region, frame: f }); };
  const back = complement(front);
  if (lit) {
    add('inner', false, [back]); add('inner', true, [back, complement(sun)]);
    add('outer', false, [front]); add('outer', true, [front, sun]);
    add('inner', false, [back, sun], true); add('outer', false, [front, complement(sun)], true);
  } else {
    add('inner', true, [back]); add('outer', true, [front]);
  }
  return out;
}
