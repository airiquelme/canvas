// Sheets: thin two-sided surfaces (paper, cards, discs, ribbons, strands of hair) as screen shapes whose sides are lines and
// ellipse arcs, like every illusion shape. Each face has its own color: `fill` where the surface's normal faces the camera,
// `back` where it faces away.
//
//   panel:  { kind: 'panel', c, e1, e2, round, fill, back }   a flat rectangle with half-axes e1, e2 (perpendicular), its corners
//           rounded by round * the shorter half-axis (0: square corners, 1: a stadium; a circle when e1, e2 are equal)
//   disc:   { kind: 'disc', c, e1, e2, fill, back }           the flat ellipse c + e1 cos t + e2 sin t
//   ribbon: { kind: 'ribbon', a: { c, r }, b: { c, r }, bend, dir, fill, back }   a strip along the half-ellipse through A, bend,
//           B (as curve.js), across the fixed direction `dir`, half-width r(th) = r0 + r1 cos th (rA at A, rB at B; rB = 0: a
//           pointed tip, a strand)
//
// EXACT. Every edge is a 3D ellipse arc C + U cos t + V sin t: a rounded corner, the disc, and both edges of a ribbon (the
// centerline M + U cos th + V sin th moved by +-r(th) dir is (M +- r0 dir) + (U +- r1 dir) cos th + V sin th). Its perspective
// image is a conic, so the ellipse through two exact screen points with their exact tangents and one more exact point is the image
// itself (`conicThrough`, curve.js), drawn with ctx.ellipse; edges are cut every PI / 4 to keep each fit well conditioned.
// FACES. A ribbon is a ruled surface whose normal n = X'(th) x dir is constant along each ruling, so which face is seen depends on th
// only: g(th) = n . (eye - X) = k + (a . M) sin th - (b . M) cos th in camera space (a = U x dir, b = V x dir, k = a . V), a first
// order trig polynomial: it turns from front to back at most twice, at closed-form angles. Each stretch between them is one simple
// loop (edge +, the ruling at its end, edge - back, the ruling at its start) in its face's color; the ruling where it turns is the
// ribbon's silhouette there (a developable surface's contour runs along a ruling).
import { line } from './shape.js';
import { conicThrough, paramOn, arcThrough } from './curve.js';

const BREAK = Math.PI / 4;

const add = (p, q, k = 1) => ({ x: p.x + q.x * k, y: p.y + q.y * k, z: p.z + q.z * k });
const sub = (p, q) => ({ x: p.x - q.x, y: p.y - q.y, z: p.z - q.z });
const dot = (p, q) => p.x * q.x + p.y * q.y + p.z * q.z;
const cross = (p, q) => ({ x: p.y * q.z - p.z * q.y, y: p.z * q.x - p.x * q.z, z: p.x * q.y - p.y * q.x });
const len = (p) => Math.hypot(p.x, p.y, p.z);
const scale = (p, k) => ({ x: p.x * k, y: p.y * k, z: p.z * k });

// A darker tone for a sheet's back when none is given.
export function backOf(hex) {
  const n = parseInt(hex.slice(1), 16), k = 0.72;
  const r = Math.round(((n >> 16) & 255) * k), g = Math.round(((n >> 8) & 255) * k), b = Math.round((n & 255) * k);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

// Screen point and screen tangent (d / dt) of the camera-space ellipse C + U cos t + V sin t.
export function edgeAt(C, U, V, t, P) {
  const c = Math.cos(t), s = Math.sin(t);
  const X = C.x + U.x * c + V.x * s, Y = C.y + U.y * c + V.y * s, Z = C.z + U.z * c + V.z * s;
  const Xp = V.x * c - U.x * s, Yp = V.y * c - U.y * s, Zp = V.z * c - U.z * s, iz = 1 / Z;
  return {
    x: P.cx + P.s * X * iz, y: P.cy - P.s * Y * iz, z: Z,
    T: { x: P.s * (Xp * Z - X * Zp) * iz * iz, y: -P.s * (Yp * Z - Y * Zp) * iz * iz },
  };
}

// The sides along the camera-space ellipse from t0 to t1 (either direction), each an exact arc (or a line where it is straight).
// pieces: how many arcs (default: one per PI / 4).
export function ellipseEdge(C, U, V, t0, t1, P, ci = 0, pieces = 0) {
  const n = pieces || Math.max(1, Math.ceil(Math.abs(t1 - t0) / BREAK)), sides = [];
  let pa = edgeAt(C, U, V, t0, P);
  for (let k = 1; k <= n; k++) {
    const tb = t0 + ((t1 - t0) * k) / n, tm = t0 + ((t1 - t0) * (k - 0.5)) / n;
    const pb = edgeAt(C, U, V, tb, P), pm = edgeAt(C, U, V, tm, P);
    const cx = pb.x - pa.x, cy = pb.y - pa.y, cl = Math.hypot(cx, cy);
    const off = cl > 1e-9 ? Math.abs(cx * (pm.y - pa.y) - cy * (pm.x - pa.x)) / cl : Math.hypot(pm.x - pa.x, pm.y - pa.y);
    const tangents = Math.hypot(pa.T.x, pa.T.y) > 1e-9 && Math.hypot(pb.T.x, pb.T.y) > 1e-9;
    const fit = off > 0.05 && tangents ? conicThrough(pa, pa.T, pb, pb.T, pm) : null;
    if (fit) sides.push({ ...arcThrough(fit.e, paramOn(fit.e, pa), paramOn(fit.e, pb), paramOn(fit.e, pm)), ci });
    else sides.push({ ...line(pa, pb), ci });
    pa = pb;
  }
  return sides;
}

const toCam = (projector, o) => {
  const T = projector.toCamera, C = T(o.c);
  return { C, E1: sub(T(add(o.c, o.e1)), C), E2: sub(T(add(o.c, o.e2)), C) };
};

// A panel's or disc's outline in camera space: a list of corners { K, U, V, t0, t1 } (rc = 0: a point K).
function panelCorners(o, C, E1, E2) {
  if (o.kind === 'disc') return [{ K: C, U: E1, V: E2, t0: 0, t1: Math.PI * 2 }];
  const h1 = len(E1), h2 = len(E2), u1 = scale(E1, 1 / h1), u2 = scale(E2, 1 / h2);
  const rc = Math.max(0, Math.min(1, o.round || 0)) * Math.min(h1, h2);
  return [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([s1, s2], i) => ({
    K: add(add(C, u1, s1 * (h1 - rc)), u2, s2 * (h2 - rc)), U: scale(u1, rc), V: scale(u2, rc), t0: (i * Math.PI) / 2, t1: ((i + 1) * Math.PI) / 2, rc,
  }));
}

function panelPieces(o, projector) {
  const P = projector.persp, { C, E1, E2 } = toCam(projector, o);
  const front = -dot(cross(E1, E2), C) > 0;
  const corners = panelCorners(o, C, E1, E2), sides = [];
  const ends = corners.map((k) => (k.rc === 0 ? { a: edgeAt(k.K, k.U, k.V, 0, P) } : null));
  corners.forEach((k, i) => {
    let endPt;
    if (k.rc === 0) endPt = ends[i].a;
    else {
      const arcs = ellipseEdge(k.K, k.U, k.V, k.t0, k.t1, P, i);
      sides.push(...arcs);
      endPt = edgeAt(k.K, k.U, k.V, k.t1, P);
    }
    if (corners.length > 1) {   // on to the next corner's start
      const nx = corners[(i + 1) % corners.length];
      const startPt = nx.rc === 0 ? ends[(i + 1) % corners.length].a : edgeAt(nx.K, nx.U, nx.V, nx.t0, P);
      if (Math.hypot(startPt.x - endPt.x, startPt.y - endPt.y) > 1e-6 || nx.rc === 0) sides.push({ ...line(endPt, startPt), ci: 4 + i });
    }
  });
  return [{ sides, front, depth: C.z }];
}

// Screen points of a panel's or disc's outline, inside it (its chords: the outline is convex): for the global mask (cull.js).
export function panelPolygon(o, projector) {
  const P = projector.persp, { C, E1, E2 } = toCam(projector, o), pts = [];
  for (const k of panelCorners(o, C, E1, E2)) {
    const n = k.rc === 0 ? 1 : o.kind === 'disc' ? 24 : 4;
    for (let j = 0; j < n; j++) pts.push(edgeAt(k.K, k.U, k.V, k.t0 + ((k.t1 - k.t0) * j) / n, P));
  }
  return pts;
}

function ribbonPieces(o, projector) {
  const P = projector.persp, T = projector.toCamera;
  const A = o.a.c, B = o.b.c, Mw = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2, z: (A.z + B.z) / 2 };
  const M = T(Mw), U = sub(T(A), M), V = sub(T(o.bend || Mw), M);
  let D = sub(T(add(Mw, o.dir)), M);
  D = scale(D, 1 / (len(D) || 1));
  const r0 = (o.a.r + o.b.r) / 2, r1 = (o.a.r - o.b.r) / 2;
  const a = cross(U, D), b = cross(V, D), k = dot(a, V), ca = -dot(b, M), sa = dot(a, M);
  const g = (th) => k + ca * Math.cos(th) + sa * Math.sin(th);
  // Where the face turns: ca cos + sa sin = -k.
  const breaks = [0], R = Math.hypot(ca, sa);
  if (R > Math.abs(k)) {
    const phi = Math.atan2(sa, ca), d = Math.acos(-k / R);
    for (const th0 of [phi - d, phi + d]) {
      const th = ((th0 % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      if (th > 1e-9 && th < Math.PI - 1e-9) breaks.push(th);
    }
  }
  breaks.sort((x, y) => x - y);
  breaks.push(Math.PI);
  const Cp = add(M, D, r0), Up = add(U, D, r1), Cm = add(M, D, -r0), Um = add(U, D, -r1);
  const pieces = [];
  for (let i = 0; i + 1 < breaks.length; i++) {
    const ta = breaks[i], tb = breaks[i + 1];
    if (tb - ta < 1e-7) continue;
    const tm = (ta + tb) / 2, sides = [];
    sides.push(...ellipseEdge(Cp, Up, V, ta, tb, P, 0));
    const pb = edgeAt(Cp, Up, V, tb, P), mb = edgeAt(Cm, Um, V, tb, P);
    if (Math.hypot(pb.x - mb.x, pb.y - mb.y) > 1e-6) sides.push({ ...line(pb, mb), ci: 1 });
    sides.push(...ellipseEdge(Cm, Um, V, tb, ta, P, 2));
    const ma = edgeAt(Cm, Um, V, ta, P), pa = edgeAt(Cp, Up, V, ta, P);
    if (Math.hypot(pa.x - ma.x, pa.y - ma.y) > 1e-6) sides.push({ ...line(ma, pa), ci: 3 });
    const c = Math.cos(tm), s = Math.sin(tm);
    pieces.push({ sides, front: g(tm) > 0, depth: M.z + U.z * c + V.z * s });
  }
  return pieces;
}

// A sheet's pieces for this view: [{ sides, front, depth }].
export function sheetPieces(o, projector) {
  return o.kind === 'ribbon' ? ribbonPieces(o, projector) : panelPieces(o, projector);
}
