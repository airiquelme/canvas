// Floor patches: a region of the ground (in x, z) bounded by lines and ellipse arcs, with a SHEET CURVE: a quadratic height
// y = h(x, z) over it (a dome, a bowl, a saddle, a slope). Like a tube (curve.js), it is an optical illusion: no faces, the screen
// shape is the area the lifted patch covers from this camera, rebuilt every frame so its outline follows the curve.
//
//   { kind: 'patch', ox, oy, oz, q: [A, B, C, D, E, F], loop, edges, bound, mid, fill }
//   h = A x^2 + B x z + C z^2 + D x + E z + F in local coordinates (x - ox, z - oz), the world point (ox + x, oy + h, oz + z);
//   loop: the boundary in local x, z, in order: { kind: 'line', a, b } or { kind: 'arc', c, U, V, t0, t1 } (c + U cos t + V sin t);
//   edges[k]: piece k's world end points (lines; shared edges are found from them), bound: 8 world points boxing it, mid: a world
//   point inside it (for the seam test).
//
// THE CONTOUR. With the normal n = (-hx, 1, -hz), g = n . (eye - X) is quadratic in x, z (the eye's terms cancel the cubic ones):
// g = A x^2 + B x z + C z^2 - (2A ex + B ez) x - (B ex + 2C ez) z + ey - F - D ex - E ez (eye in local coordinates). g > 0: the top is
// seen. Its zero set (a conic in x, z) is where the surface turns away, the patch's silhouette inside the region. The region splits
// into g > 0 and g < 0 parts, each bounded by stretches of the boundary and arcs of that conic; the screen shape is the union of
// their images (each loop turned to the same orientation, filled nonzero), so a crest seen from the side is drawn up to the
// surface's own outline, not to its edges.
// ONE-SIDED (floors, walls: a surface, not a body). The part with g < 0 (seen from below) is never drawn: nearer ground in front
// of it always covers it, so a patch is only its g > 0 part, and a patch with no g > 0 part is skipped (back-face culling).
// FLAT. `bulge` (built with the patch): how far the surface can rise or sink from the flat triangle through its corners (world
// units; a triangle's is 4/3 of its largest edge-midpoint offset, a bound for a quadratic through the 6 nodes). When that is under
// FLAT_PX on screen (pxScale: screen px per world unit at the patch's nearest point), the patch is drawn as that flat triangle:
// 3 lines, no contour, no fits (off by under FLAT_PX).
// SIDES. Every side is a curve with exact screen points and exact tangents at its ends and an exact middle point, drawn as the
// ellipse through them (`conicThrough`): exact where the image is an ellipse (a lifted line is a parabola in a vertical plane, the
// contour a plane conic), the nearest ellipse with the same end tangents otherwise, split in two (up to 3 times) where it is off by
// more than SPLIT_PX at its quarter points. Consecutive sides share the exact point and tangent, so the outline has no corners.
import { line, pointOnEllipse } from './shape.js';
import { conicThrough, paramOn, arcThrough } from './curve.js';

const SPLIT_PX = 0.3, ARC_STEP = Math.PI / 4, FLAT_PX = 0.25;
// A fitted side shorter than this (its chord, design px) is not checked at its quarter points: a short arc through exact ends,
// tangents and middle can't drift visibly from the true curve.
const CHECK_PX = 16;
const long = (pa, pb) => Math.hypot(pb.x - pa.x, pb.y - pa.y) > CHECK_PX;
const add = (p, q, k = 1) => ({ x: p.x + q.x * k, y: p.y + q.y * k, z: p.z + q.z * k });
const sub = (p, q) => ({ x: p.x - q.x, y: p.y - q.y, z: p.z - q.z });

export const heightAt = (q, x, z) => q[0] * x * x + q[1] * x * z + q[2] * z * z + q[3] * x + q[4] * z + q[5];
const slope = (q, x, z) => [2 * q[0] * x + q[1] * z + q[3], q[1] * x + 2 * q[2] * z + q[4]];
const gAt = (G, x, z) => G[0] * x * x + G[1] * x * z + G[2] * z * z + G[3] * x + G[4] * z + G[5];
const gGrad = (G, x, z) => [2 * G[0] * x + G[1] * z + G[3], G[1] * x + 2 * G[2] * z + G[4]];

// World point and world tangent at local (x, z), moving along (dx, dz).
function lift(o, x, z, dx, dz) {
  const [hx, hz] = slope(o.q, x, z);
  return { X: { x: o.ox + x, y: o.oy + heightAt(o.q, x, z), z: o.oz + z }, T: { x: dx, y: hx * dx + hz * dz, z: dz } };
}

// A boundary piece at u in [0, 1]: local point and its derivative.
export function pieceAt(pc, u) {
  if (pc.kind === 'line') return { x: pc.a.x + (pc.b.x - pc.a.x) * u, z: pc.a.z + (pc.b.z - pc.a.z) * u, dx: pc.b.x - pc.a.x, dz: pc.b.z - pc.a.z };
  const t = pc.t0 + (pc.t1 - pc.t0) * u, c = Math.cos(t), s = Math.sin(t), k = pc.t1 - pc.t0;
  return { x: pc.c.x + pc.U.x * c + pc.V.x * s, z: pc.c.z + pc.U.z * c + pc.V.z * s, dx: k * (pc.V.x * c - pc.U.x * s), dz: k * (pc.V.z * c - pc.U.z * s) };
}

// The side through screen points pa, pb (with tangents) and pm: an ellipse arc, or a line where it is straight.
function fitSide(pa, pb, pm) {
  const cx = pb.x - pa.x, cy = pb.y - pa.y, cl = Math.hypot(cx, cy);
  const off = cl > 1e-9 ? Math.abs(cx * (pm.y - pa.y) - cy * (pm.x - pa.x)) / cl : Math.hypot(pm.x - pa.x, pm.y - pa.y);
  if (off <= 0.05) return { side: line(pa, pb), ok: true };
  const tangents = Math.hypot(pa.T.x, pa.T.y) > 1e-9 && Math.hypot(pb.T.x, pb.T.y) > 1e-9;
  const fit = tangents ? conicThrough(pa, pa.T, pb, pb.T, pm) : null;
  if (!fit) return { side: line(pa, pb), ok: false };
  return { side: arcThrough(fit.e, paramOn(fit.e, pa), paramOn(fit.e, pb), paramOn(fit.e, pm)), ok: true };
}
const offFit = (side, p) => {
  if (side.kind === 'line') {
    const cx = side.to.x - side.from.x, cy = side.to.y - side.from.y, cl = Math.hypot(cx, cy) || 1;
    return Math.abs(cx * (p.y - side.from.y) - cy * (p.x - side.from.x)) / cl;
  }
  const q = pointOnEllipse(side.e, paramOn(side.e, p));
  return Math.hypot(q.x - p.x, q.y - p.y);
};

// Sides along a curve given by at(u) -> screen point with tangent, from ua to ub; split while off by more than SPLIT_PX.
function curveSides(at, ua, ub, tag, out, depth = 0) {
  const pa = at(ua), pb = at(ub), pm = at((ua + ub) / 2);
  const { side, ok } = fitSide(pa, pb, pm);
  if (depth < 3 && (!ok || (long(pa, pb) && (offFit(side, at(ua + (ub - ua) / 4)) > SPLIT_PX || offFit(side, at(ua + (3 * (ub - ua)) / 4)) > SPLIT_PX)))) {
    curveSides(at, ua, (ua + ub) / 2, tag, out, depth + 1);
    curveSides(at, (ua + ub) / 2, ub, tag, out, depth + 1);
    return;
  }
  out.push({ ...side, ...tag });
}

// The point of the conic g = 0 on the perpendicular bisector of R1 R2 nearest their midpoint (a contour arc's middle).
function bisect(G, R1, R2) {
  const m = { x: (R1.x + R2.x) / 2, z: (R1.z + R2.z) / 2 }, n = { x: -(R2.z - R1.z), z: R2.x - R1.x };
  const g0 = gAt(G, m.x, m.z), gp = gAt(G, m.x + n.x, m.z + n.z), gm = gAt(G, m.x - n.x, m.z - n.z);
  const a = (gp + gm) / 2 - g0, b = (gp - gm) / 2;
  let s;
  if (Math.abs(a) < 1e-14 * (Math.abs(b) + Math.abs(g0) + 1e-300)) s = Math.abs(b) > 1e-300 ? -g0 / b : 0;
  else {
    const d = b * b - 4 * a * g0;
    if (d < 0) return { ...m, bad: true };
    const r = Math.sqrt(d), s1 = (-b + r) / (2 * a), s2 = (-b - r) / (2 * a);
    s = Math.abs(s1) < Math.abs(s2) ? s1 : s2;
  }
  return { x: m.x + n.x * s, z: m.z + n.z * s };
}

// Sides along the contour from R1 to R2 (local points on g = 0), split at bisector points while off by more than SPLIT_PX.
function contourSides(o, G, R1, R2, scr, out, depth = 0) {
  const L = (p) => { const [gx, gz] = gGrad(G, p.x, p.z); return scr(lift(o, p.x, p.z, -gz, gx)); };
  const M = bisect(G, R1, R2), pa = L(R1), pb = L(R2), pm = L(M);
  const { side, ok } = fitSide(pa, pb, pm);
  if (depth < 3 && (!ok || (long(pa, pb) && (offFit(side, L(bisect(G, R1, M))) > SPLIT_PX || offFit(side, L(bisect(G, M, R2))) > SPLIT_PX)))) {
    contourSides(o, G, R1, M, scr, out, depth + 1);
    contourSides(o, G, M, R2, scr, out, depth + 1);
    return;
  }
  out.push({ ...side, ci: 4 });
}

function insideLoop(loop, p) {
  const poly = [];
  for (const pc of loop) {
    const n = pc.kind === 'line' ? 1 : 24;
    for (let j = 0; j < n; j++) poly.push(pieceAt(pc, j / n));
  }
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > p.z) !== (b.z > p.z) && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

// The roots of g along a piece, as u in (0, 1): closed form on a line (g is quadratic in u), sampled and bisected on an arc.
function piecRoots(G, pc) {
  const g = (u) => { const p = pieceAt(pc, u); return gAt(G, p.x, p.z); };
  const out = [];
  if (pc.kind === 'line') {
    const g0 = g(0), gh = g(0.5), g1 = g(1), a = 2 * (g1 - 2 * gh + g0), b = 4 * gh - 3 * g0 - g1;
    if (Math.abs(a) < 1e-14 * (Math.abs(b) + Math.abs(g0) + 1e-300)) { if (Math.abs(b) > 1e-300) out.push(-g0 / b); }
    else {
      const d = b * b - 4 * a * g0;
      if (d >= 0) { const r = Math.sqrt(d); out.push((-b + r) / (2 * a), (-b - r) / (2 * a)); }
    }
    return out.filter((u) => u > 1e-9 && u < 1 - 1e-9).sort((p, q) => p - q);
  }
  const n = Math.max(8, Math.ceil((Math.abs(pc.t1 - pc.t0) / (2 * Math.PI)) * 64));
  let ua = 0, ga = g(0);
  for (let k = 1; k <= n; k++) {
    const ub = k / n, gb = g(ub);
    if ((ga > 0) !== (gb > 0)) {
      let lo = ua, hi = ub, gl = ga;
      for (let it = 0; it < 50; it++) { const mid = (lo + hi) / 2, gm = g(mid); if ((gm > 0) === (gl > 0)) { lo = mid; gl = gm; } else hi = mid; }
      out.push((lo + hi) / 2);
    }
    ua = ub; ga = gb;
  }
  return out.filter((u) => u > 1e-9 && u < 1 - 1e-9);
}

// The conic g = 0 as an ellipse c + U cos s + V sin s, or null.
function contourEllipse(G) {
  const [A, B, C, D, E] = G, det = 4 * A * C - B * B;
  if (!(det > 0)) return null;
  const cx = (B * E - 2 * C * D) / det, cz = (B * D - 2 * A * E) / det, gc = gAt(G, cx, cz);
  const th = 0.5 * Math.atan2(B, A - C), c = Math.cos(th), s = Math.sin(th);
  const l1 = A * c * c + B * c * s + C * s * s, l2 = A * s * s - B * c * s + C * c * c;
  if (!(-gc / l1 > 0 && -gc / l2 > 0)) return null;
  const r1 = Math.sqrt(-gc / l1), r2 = Math.sqrt(-gc / l2);
  return { c: { x: cx, z: cz }, U: { x: c * r1, z: s * r1 }, V: { x: -s * r2, z: c * r2 } };
}

const screenArea = (sides) => {
  const pts = [];
  for (const s of sides) {
    if (s.kind === 'line') pts.push(s.from);
    else { pts.push(pointOnEllipse(s.e, s.t0)); pts.push(pointOnEllipse(s.e, (s.t0 + s.t1) / 2)); }
  }
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p.x * q.y - q.x * p.y; }
  return a;
};
const reversed = (sides) => sides.slice().reverse().map((s) => (s.kind === 'line' ? { ...s, from: s.to, to: s.from } : { ...s, t0: s.t1, t1: s.t0 }));

// The patch's screen shape for this view: [{ sides }] (one piece, possibly several loops). Boundary sides carry `edge` (the piece
// index) and `front` (on the seen-from-above part).
// `loop`: a part of the patch's region to draw instead of all of it (shadow.js: lit / shade parts; same sheet curve). A piece's
// `edge` tag (else its index) goes to its sides.
export function patchPieces(o, projector, eye, pxScale = Infinity, loop = o.loop) {
  const P = projector.persp, T = projector.toCamera, oneSided = o.oneSided !== false;
  const scr = ({ X, T: d }) => {
    const C = T(X), D = sub(T(add(X, d)), C), iz = 1 / C.z;
    return { x: P.cx + P.s * C.x * iz, y: P.cy - P.s * C.y * iz, T: { x: P.s * (D.x * C.z - C.x * D.z) * iz * iz, y: -P.s * (D.y * C.z - C.y * D.z) * iz * iz } };
  };
  const [A, B, C, D, E, F] = o.q, ex = eye.x - o.ox, ey = eye.y - o.oy, ez = eye.z - o.oz;
  const G = [A, B, C, -(2 * A * ex + B * ez), -(B * ex + 2 * C * ez), ey - F - D * ex - E * ez];
  const nP = loop.length;
  if (o.bulge !== undefined && o.bulge * pxScale < FLAT_PX && loop.every((pc) => pc.kind === 'line')) {   // flat on screen: its corners' polygon
    if (oneSided && loop.every((pc) => gAt(G, pc.a.x, pc.a.z) <= 0) && gAt(G, 0, 0) <= 0) return [];
    const Q = loop.map((pc) => projector.projectPoint(lift(o, pc.a.x, pc.a.z, 0, 0).X));
    return [{ sides: Q.map((p, k) => ({ ...line(p, Q[(k + 1) % Q.length]), ci: k % 4, edge: loop[k].edge ?? k, front: true })), flat: true }];
  }
  const at = (i) => (u) => { const p = pieceAt(loop[i], u); return scr(lift(o, p.x, p.z, p.dx, p.dz)); };
  // Boundary from (i, ua) to (j, ub), forward around the loop; arcs cut at ARC_STEP first.
  const span = (i, ua, j, ub, front, out) => {
    const one = (k, u0, u1) => {
      const pc = loop[k], n = pc.kind === 'arc' ? Math.max(1, Math.ceil((Math.abs(pc.t1 - pc.t0) * (u1 - u0)) / ARC_STEP)) : 1;
      for (let m = 0; m < n; m++) curveSides(at(k), u0 + ((u1 - u0) * m) / n, u0 + ((u1 - u0) * (m + 1)) / n, { ci: k % 4, edge: pc.edge ?? k, front }, out);
    };
    if (i === j && ub > ua) { one(i, ua, ub); return; }
    one(i, ua, 1);
    for (let k = (i + 1) % nP; k !== j; k = (k + 1) % nP) one(k, 0, 1);
    one(j, 0, ub);
  };
  const roots = [];
  loop.forEach((pc, i) => { for (const u of piecRoots(G, pc)) { const p = pieceAt(pc, u); roots.push({ i, u, p: { x: p.x, z: p.z } }); } });
  roots.sort((r, s) => r.i - s.i || r.u - s.u);
  const loops = [];
  if (roots.length < 2 || roots.length % 2) {
    const p0 = pieceAt(loop[0], 0.5), seen = gAt(G, p0.x, p0.z) > 0;
    const el = roots.length ? null : contourEllipse(G);   // a closed contour inside the region: its loop too
    const closed = el && insideLoop(loop, { x: el.c.x + el.U.x, z: el.c.z + el.U.z });
    if (oneSided && !seen && !closed) return [];   // seen from below only
    const sides = [];
    for (let k = 0; k < nP; k++) span(k, 0, k, 1, seen, sides);
    loops.push(sides);   // a closed contour inside the region: its loop too
    if (closed) {
      const cs = [];
      const atC = (u) => { const t = u * 2 * Math.PI, c = Math.cos(t), s = Math.sin(t);
        return scr(lift(o, el.c.x + el.U.x * c + el.V.x * s, el.c.z + el.U.z * c + el.V.z * s, el.V.x * c - el.U.x * s, el.V.z * c - el.U.z * s)); };
      for (let m = 0; m < 8; m++) curveSides(atC, m / 8, (m + 1) / 8, { ci: 4 }, cs);
      loops.push(cs);
    }
  } else {
    const k = roots.length, partner = new Array(k);
    const pairing = (off) => { for (let a = 0; a < k; a += 2) { partner[(a + off) % k] = (a + off + 1) % k; partner[(a + off + 1) % k] = (a + off) % k; } };
    pairing(0);
    if (k > 2) {   // pick the pairing whose contour arcs run inside the region
      const valid = () => { for (let a = 0; a < k; a++) if (partner[a] > a) { const M = bisect(G, roots[a].p, roots[partner[a]].p); if (M.bad || !insideLoop(loop, M)) return false; } return true; };
      if (!valid()) pairing(1);
    }
    // Segment s runs from root s to root s + 1; its sign: g just after root s.
    const r0 = roots[0], pa = pieceAt(loop[r0.i], Math.min(1, r0.u + 1e-6));
    const sign0 = gAt(G, pa.x, pa.z) > 0;
    const signOf = (s) => (s % 2 === 0 ? sign0 : !sign0);
    const used = new Set();
    for (let s0 = 0; s0 < k; s0++) {
      if (used.has(s0) || (oneSided && !signOf(s0))) continue;
      const sides = [], front = signOf(s0);
      let s = s0, guard = 0;
      do {
        used.add(s);
        const a = roots[s], b = roots[(s + 1) % k];
        span(a.i, a.u, b.i, b.u, front, sides);
        const p = partner[(s + 1) % k];
        contourSides(o, G, b.p, roots[p].p, scr, sides);
        s = p;
      } while (s !== s0 && ++guard < k);
      loops.push(sides);
    }
  }
  const sides = [];
  for (const L of loops) {
    if (!L.length) continue;
    const oriented = screenArea(L) < 0 ? reversed(L) : L;
    oriented.forEach((sd, i) => sides.push(i === 0 && sides.length ? { ...sd, move: true } : sd));
  }
  return sides.length ? [{ sides }] : [];
}

// The part of a loop (local x, z pieces) whose lifted points are at least `cut` deep (depth(worldPoint)), or null if none: the
// loop as a polygon (arcs as 12 chords each), clipped by Sutherland-Hodgman; a crossing on a line is where the depth, quadratic
// along it (the surface is), meets `cut` (bisection). Kept pieces keep their edge tags; the cut is tagged 'near'. The cut is a
// chord of the true near curve: off by at most the surface's bulge, far off screen.
export function clipLoopNear(o, loop, depth, cut) {
  const verts = [];
  loop.forEach((pc, k) => {
    const tag = pc.edge ?? k, n = pc.kind === 'arc' ? 12 : 1;
    for (let j = 0; j < n; j++) { const p = pieceAt(pc, j / n); verts.push({ p: { x: p.x, z: p.z }, tag }); }
  });
  const dOf = (p) => depth(lift(o, p.x, p.z, 0, 0).X);
  const ds = verts.map((v) => dOf(v.p));
  if (ds.every((d) => d >= cut)) return loop;
  if (ds.every((d) => d < cut)) return null;
  const cross = (a, b, da) => {
    let lo = 0, hi = 1;
    const at = (u) => ({ x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u });
    for (let it = 0; it < 40; it++) { const m = (lo + hi) / 2; if ((dOf(at(m)) >= cut) === (da >= cut)) lo = m; else hi = m; }
    return at((lo + hi) / 2);
  };
  const out = [];
  for (let i = 0; i < verts.length; i++) {
    const A = verts[i], B = verts[(i + 1) % verts.length], dA = ds[i], dB = ds[(i + 1) % verts.length];
    const inA = dA >= cut, inB = dB >= cut;
    if (inA) out.push({ p: A.p, tag: A.tag });
    if (inA && !inB) out.push({ p: cross(A.p, B.p, dA), tag: 'near' });
    if (!inA && inB) out.push({ p: cross(A.p, B.p, dA), tag: A.tag });
  }
  if (out.length < 3) return null;
  return out.map((v, i) => ({ kind: 'line', a: v.p, b: out[(i + 1) % out.length].p, edge: v.tag }));
}

// ---- Builders ----

function solve6(M, b) {   // Gaussian elimination with partial pivoting
  const n = 6, a = M.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = c + 1; r < n; r++) { const f = a[r][c] / a[c][c]; for (let k = c; k <= n; k++) a[r][k] -= f * a[c][k]; }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) { let s = a[r][n]; for (let k = r + 1; k < n; k++) s -= a[r][k] * x[k]; x[r] = s / a[r][r]; }
  return x;
}

function finish(o, samples) {
  const lo = { x: Infinity, y: Infinity, z: Infinity }, hi = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of samples) for (const k of ['x', 'y', 'z']) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
  o.bound = [];
  for (const x of [lo.x, hi.x]) for (const y of [lo.y, hi.y]) for (const z of [lo.z, hi.z]) o.bound.push({ x, y, z });
  o.edges = o.loop.map((pc) => (pc.kind === 'line' ? [lift(o, pc.a.x, pc.a.z, 0, 0).X, lift(o, pc.b.x, pc.b.z, 0, 0).X] : null));
  return o;
}

// A triangle of ground whose sheet curve passes through its three corners and the three heights given at its edges' midpoints
// (world points; mids[k] is on the edge from corner k to k + 1). Two triangles with the same corners and midpoint on an edge lift
// that edge to the same curve (a quadratic along it through the same three points).
export function trianglePatch(P, mids, fill) {
  const ox = (P[0].x + P[1].x + P[2].x) / 3, oz = (P[0].z + P[1].z + P[2].z) / 3;
  const nodes = [...P, ...mids], M = nodes.map((p) => { const x = p.x - ox, z = p.z - oz; return [x * x, x * z, z * z, x, z, 1]; });
  const q = solve6(M, nodes.map((p) => p.y));
  const loc = (p) => ({ x: p.x - ox, z: p.z - oz });
  const loop = [0, 1, 2].map((k) => ({ kind: 'line', a: loc(P[k]), b: loc(P[(k + 1) % 3]) }));
  const o = { kind: 'patch', ox, oy: 0, oz, q, loop, fill };
  const c = lift(o, 0, 0, 0, 0).X, samples = [...nodes, c];
  for (const [a, b] of [[0, 1], [1, 2], [2, 0], [0, 4], [1, 5], [2, 3]]) {   // a few more points inside, for the box
    const p = { x: (nodes[a].x + nodes[b].x) / 2 - ox, z: (nodes[a].z + nodes[b].z) / 2 - oz };
    samples.push(lift(o, p.x, p.z, 0, 0).X);
  }
  o.mid = c;
  o.bulge = (4 / 3) * Math.max(...[0, 1, 2].map((k) => Math.abs(mids[k].y - (P[k].y + P[(k + 1) % 3].y) / 2)));
  return finish(o, samples);
}


// The basic example: a ring (an ellipse in the plane y = c.y, half-axes a, b, turned by `angle` about y) whose sheet curve is a
// dome (height > 0) or a bowl (height < 0) with its top at the center: h = height (1 - u^2 - v^2) in the ring's own axes.
export function ringPatch({ c, a, b, angle = 0, height, fill }) {
  const ca = Math.cos(angle), sa = Math.sin(angle);
  // u = (x ca + z sa) / a, v = (-x sa + z ca) / b
  const A = -height * (ca * ca / (a * a) + sa * sa / (b * b)), B = -height * 2 * ca * sa * (1 / (a * a) - 1 / (b * b));
  const C = -height * (sa * sa / (a * a) + ca * ca / (b * b));
  const loop = [{ kind: 'arc', c: { x: 0, z: 0 }, U: { x: a * ca, z: a * sa }, V: { x: -b * sa, z: b * ca }, t0: 0, t1: 2 * Math.PI }];
  const o = { kind: 'patch', ox: c.x, oy: c.y, oz: c.z, q: [A, B, C, 0, 0, height], loop, fill };
  const samples = [];
  for (let k = 0; k < 16; k++) { const p = pieceAt(loop[0], k / 16); samples.push(lift(o, p.x, p.z, 0, 0).X); }
  samples.push(lift(o, 0, 0, 0, 0).X);
  o.mid = lift(o, 0, 0, 0, 0).X;
  return finish(o, samples);
}
