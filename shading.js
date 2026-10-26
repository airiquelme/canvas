// The light engine's 2D side (CLAUDE.md "Light engine"): the lit part of a piece, painted over its fill.
//
// One directional world light (parallel rays) and two tones, Lit and Twilight: a surface is Lit when its normal faces the light
// (n . L >= 0), so one half of every sphere or cone gets light and the other half does not. A piece is filled in Twilight
// (`baseColor`) and the lit parts of its *elements* are painted over it in the mesh color. Everything is computed in a per-frame
// orthographic "flat solid" (screen x, y (y down), z = -depth * zoom toward the viewer, each node a sphere of its projected
// radius), so the terminators meet the drawn silhouettes. An element is a sphere (the lit cap `n . l >= 0`: a great circle, which
// projects to an ellipse through the node's center, closed by the rim arc), a cone (the lit generatrices, straight lines) or a
// face (a flat triangle of a 3+ node mesh, wholly one tone).
import { light, debug, lighting } from './config.js';
import { camera } from './camera.js';
import { TWILIGHT, LIT, toneColor } from './light.js';
import { convexHull } from './geometry.js';

const TAU = Math.PI * 2;
// The line drawn along the circle where a cone meets a sphere, in pixels (see `buildCone`), and the stroke of a face.
const SEAM_LINE_PX = 2, FACE_STROKE_PX = 1.5;
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const len = (a) => Math.hypot(a.x, a.y, a.z);
const unit = (a) => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; };

function polygon(points) {
  const path = new Path2D();
  points.forEach((p, i) => (i ? path.lineTo(p[0], p[1]) : path.moveTo(p[0], p[1])));
  path.closePath();
  return path;
}
function disc(s) {
  const path = new Path2D();
  path.moveTo(s.x + s.r, s.y);
  path.arc(s.x, s.y, s.r, 0, TAU);
  path.closePath();
  return path;
}

// The part of the visible hemisphere of sphere `s` whose normals n satisfy n . l >= c, as { path, rule } or null.
// The boundary circle n = c l + rho (cos e1 + sin e2) projects to an ellipse; the region is its visible arc closed by the
// rim arc (n_z = 0) on the lit side.
function capRegion(s, l, c, step) {
  if (c >= 1) return null;
  if (c <= -1) return { path: disc(s), rule: 'nonzero' };
  const lxy = Math.hypot(l.x, l.y);
  const rim = c <= -lxy ? 'all' : c >= lxy ? 'none' : { a0: Math.atan2(l.y, l.x), d: Math.acos(c / lxy) };
  const rho = Math.sqrt(1 - c * c);
  const e1 = unit(cross(l, Math.abs(l.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 })), e2 = cross(l, e1);
  const A = Math.hypot(e1.z, e2.z), phi1 = Math.atan2(e2.z, e1.z), base = c * l.z;
  let vis;       // the circle's visible part: 'all', 'none' or an angle range
  if (rho * A < 1e-9) vis = base >= 0 ? 'all' : 'none';
  else {
    const K = -base / (rho * A);
    vis = K <= -1 ? 'all' : K >= 1 ? 'none' : { lo: phi1 - Math.acos(K), hi: phi1 + Math.acos(K) };
  }
  const at = (phi) => {
    const cs = Math.cos(phi), sn = Math.sin(phi);
    return [s.x + s.r * (c * l.x + rho * (cs * e1.x + sn * e2.x)), s.y + s.r * (c * l.y + rho * (cs * e1.y + sn * e2.y))];
  };
  const steps = (span) => Math.max(2, Math.ceil(span / step));
  const wholeDisc = () => (l.z >= c ? { path: disc(s), rule: 'nonzero' } : null);
  if (vis === 'none') return wholeDisc();
  if (vis === 'all') {
    const n = steps(TAU), ring = [];
    for (let i = 0; i < n; i++) ring.push(at(TAU * i / n));
    const path = polygon(ring);
    if (rim === 'all') path.addPath(disc(s));
    return { path, rule: rim === 'all' ? 'evenodd' : 'nonzero', arc: ring };
  }
  if (rim === 'all' || rim === 'none') return wholeDisc();     // grazing: the circle touches the rim, nothing between
  const n = steps(vis.hi - vis.lo), m = steps(2 * rim.d), arc = [], edge = [];
  for (let i = 0; i <= n; i++) arc.push(at(vis.lo + (vis.hi - vis.lo) * i / n));
  for (let i = 0; i <= m; i++) { const a = rim.a0 - rim.d + 2 * rim.d * i / m; edge.push([s.x + s.r * Math.cos(a), s.y + s.r * Math.sin(a)]); }
  const d2 = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2, last = arc[arc.length - 1];
  return { path: polygon(d2(last, edge[0]) <= d2(last, edge[edge.length - 1]) ? arc.concat(edge) : arc.concat(edge.reverse())), rule: 'nonzero', arc };
}

// Arcs of the circle of angles: cos(phi - c) >= K as 'all' | 'none' | { c, hw }, and their intersection as intervals of [0, TAU].
const arcOf = (c, K) => (K <= -1 ? 'all' : K >= 1 ? 'none' : { c, hw: Math.acos(K) });
const intervalsOf = (a) => {
  if (a === 'all') return [[0, TAU]];
  if (a === 'none') return [];
  const lo = ((a.c - a.hw) % TAU + TAU) % TAU, hi = lo + 2 * a.hw;
  return hi > TAU ? [[lo, TAU], [0, hi - TAU]] : [[lo, hi]];
};
const intersectArcs = (arcs) => arcs.reduce((acc, a) => {
  const out = [];
  acc.forEach(p => intervalsOf(a).forEach(q => { const lo = Math.max(p[0], q[0]), hi = Math.min(p[1], q[1]); if (hi > lo) out.push([lo, hi]); }));
  return out;
}, [[0, TAU]]);

export function makeShading({ basis, tol, px, camPos, projectPoint, lit = true }) {
  const pz = camera.zoom;
  // The light in the flat solid: screen right, screen down, toward the viewer (unit).
  const L = { x: dot(light.dir, basis.right), y: -dot(light.dir, basis.up), z: -dot(light.dir, basis.forward) };
  const angleStep = (r) => 2 * Math.acos(1 - Math.min(0.5, 2.5 * tol / Math.max(r, 1e-6)));
  const flat = (p) => ({ x: p.center.x, y: p.center.y, z: -p.depth * pz, r: p.radius });
  const debugItems = [];     // what the debug view draws (drawDebug)
  const cache = new Map();
  const cached = (key, make) => { if (!cache.has(key)) cache.set(key, make()); return cache.get(key); };

  // The part of a sphere a mesh shows: where the cones to its partners (the mesh's other nodes) have not taken over, i.e. the
  // normals n with n . d <= sinT for each partner node (d the unit axis from this sphere to it, sinT = (r - r') / length, which is
  // also the normal of the tangent circle). Footprints of the spheres and cone strips of a convex hull then tile its visible
  // surface, so a far node behind a near one adds nothing. A sphere inside a partner is hidden (null).
  const exposure = (s, partners) => {
    const clips = [];
    for (const q of partners) {
      const dv = sub(q, s), D = len(dv);
      if (D <= Math.abs(s.r - q.r)) { if (s.r > q.r) continue; return null; }
      const region = capRegion(s, { x: -dv.x / D, y: -dv.y / D, z: -dv.z / D }, -(s.r - q.r) / D, angleStep(s.r));
      if (!region) return null;
      clips.push(region);
    }
    return clips;
  };

  // The lit cap of a sphere for the light direction `lam` (unit) inside its exposure, or null.
  const buildSphere = (s, lam, partners, id = null) => {
    const clips = exposure(s, partners);
    if (!clips) return null;
    const lit = capRegion(s, lam, 0, angleStep(s.r));
    if (lit && lit.arc && id && debug.on) debugItems.push({ kind: 'arc', id, pts: lit.arc });
    return lit ? { kind: 'sphere', lit, clips } : null;
  };

  // The tangent cone of two spheres: its lit generatrices (n . lam >= 0, a straight line each) among the visible ones (n_z >= 0), and
  // among the ones on the hull of the mesh when `others` (the mesh's other spheres) are given: a generatrix under a face of a 3+
  // node mesh shows nothing. Each condition is `cos(phi - c) >= K`, so the lit generatrices are an exact set of angle intervals.
  const buildCone = (sa, sb, lam, others = [], id = null) => {
    const dv = sub(sb, sa), Ln = len(dv), sinT = (sa.r - sb.r) / Ln;
    if (Ln < 1e-6 || Math.abs(sinT) >= 1) return null;
    const cosT = Math.sqrt(1 - sinT * sinT), d = { x: dv.x / Ln, y: dv.y / Ln, z: dv.z / Ln };
    const u = unit(cross(d, Math.abs(d.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 })), v = cross(d, u);
    const normal = (phi) => {
      const cs = Math.cos(phi) * cosT, sn = Math.sin(phi) * cosT;
      return { x: cs * u.x + sn * v.x + sinT * d.x, y: cs * u.y + sn * v.y + sinT * d.y, z: cs * u.z + sn * v.z + sinT * d.z };
    };
    // n . w + k >= 0 for the generatrix at phi: cosT (cos phi u.w + sin phi v.w) + sinT d.w + k >= 0.
    const halfSpace = (w, k) => {
      const R = cosT * Math.hypot(dot(u, w), dot(v, w));
      const rest = sinT * dot(d, w) + k;
      if (R < 1e-9) return rest >= 0 ? 'all' : 'none';
      return arcOf(Math.atan2(dot(v, w), dot(u, w)), -rest / R);
    };
    const neg = (a) => (a === 'all' ? 'none' : a === 'none' ? 'all' : { c: a.c + Math.PI, hw: Math.PI - a.hw });
    const arcs = [halfSpace({ x: 0, y: 0, z: 1 }, 0)];
    const litArc = halfSpace(lam, 0);
    arcs.push(litArc);
    // A generatrix is under a face where another sphere reaches past it: n . (c_m - c_a) + r_m - r_a > 0.
    others.forEach(m => arcs.push(neg(halfSpace(sub(m, sa), m.r - sa.r))));
    const runs = intersectArcs(arcs);
    const step = angleStep(Math.max(sa.r, sb.r));
    const gen = (phi) => {
      const nn = normal(phi);
      return { a: [sa.x + sa.r * nn.x, sa.y + sa.r * nn.y], b: [sb.x + sb.r * nn.x, sb.y + sb.r * nn.y] };
    };
    // Debug: the border between the cone and each of its nodes, the visible part of the two tangent circles (lit or not).
    if (id && debug.on) {
      intersectArcs(arcs.filter(a => a !== litArc)).forEach(([from, to]) => {
        const n = Math.max(2, Math.ceil((to - from) / step)), na = [], nb = [];
        for (let i = 0; i <= n; i++) { const G = gen(from + (to - from) * i / n); na.push(G.a); nb.push(G.b); }
        debugItems.push({ kind: 'seam', pts: na }, { kind: 'seam', pts: nb });
      });
    }
    if (!runs.length) return null;
    const lit = new Path2D(), seams = new Path2D();
    runs.forEach(([from, to]) => {
      const n = Math.max(2, Math.ceil((to - from) / step)), far = [], near = [];
      for (let i = 0; i <= n; i++) { const G = gen(from + (to - from) * i / n); far.push(G.b); near.push(G.a); }
      if (id && debug.on) { const ga = gen(from), gb = gen(to); debugItems.push({ kind: 'cone', id, lines: [[ga.a, ga.b], [gb.a, gb.b]] }); }
      lit.addPath(polygon(far.concat(near.reverse())));
      // The cone and the sphere it meets are separate shapes that end on the same circle, so their antialiased edge pixels leave a
      // thin line of the base tone. A line along each end circle, in the lit tone and wide enough to cover those pixels, closes it.
      [far, near].forEach(pts => pts.forEach((p, i) => (i ? seams.lineTo(p[0], p[1]) : seams.moveTo(p[0], p[1]))));
    });
    return { kind: 'cone', lit, seams };
  };

  // The visible planes tangent to three spheres of a 3+ node mesh with every other sphere below them: flat triangles through the
  // tangent points, wholly Lit or Twilight. Also the pairs that are an edge of such a plane (of a visible or a hidden one).
  const buildFaces = (flats) => {
    const n = flats.length, faces = [], edges = new Set();
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = j + 1; k < n; k++) {
      const ci = flats[i], e1 = sub(flats[j], ci), e2 = sub(flats[k], ci), m = cross(e1, e2);
      if (len(m) < 1e-9) continue;
      // n . (cj - ci) = ri - rj and n . (ck - ci) = ri - rk: the minimal solution lies in the triangle's plane, the rest is along m.
      const a11 = dot(e1, e1), a12 = dot(e1, e2), a22 = dot(e2, e2), det = a11 * a22 - a12 * a12;
      const b1 = ci.r - flats[j].r, b2 = ci.r - flats[k].r;
      const al = (b1 * a22 - b2 * a12) / det, be = (a11 * b2 - a12 * b1) / det;
      const n0 = { x: al * e1.x + be * e2.x, y: al * e1.y + be * e2.y, z: al * e1.z + be * e2.z }, q = 1 - dot(n0, n0);
      if (q < 0) continue;
      const mh = unit(m), w = Math.sqrt(q);
      [1, -1].forEach(sg => {
        const nn = { x: n0.x + sg * w * mh.x, y: n0.y + sg * w * mh.y, z: n0.z + sg * w * mh.z }, h = dot(nn, ci) + ci.r;
        if (flats.some((f, l) => l !== i && l !== j && l !== k && dot(nn, f) + f.r > h + 1e-6)) return;
        edges.add(i + ',' + j); edges.add(i + ',' + k); edges.add(j + ',' + k);
        if (nn.z <= 1e-9) return;
        faces.push({
          kind: 'face', tone: dot(nn, L) >= 0 ? LIT : TWILIGHT,
          footprint: polygon([i, j, k].map(t => [flats[t].x + flats[t].r * nn.x, flats[t].y + flats[t].r * nn.y])),
        });
      });
    }
    return { faces, edges };
  };

  // A 3+ node mesh as the hull of its spheres, lit by the parallel light directly (n . L >= 0), so the elements agree where they meet.
  // `ids`: the node ids, for the debug view's colors.
  const buildHull = (flats, ids) => {
    const n = flats.length, { faces, edges } = buildFaces(flats);
    // (Whether the hull has edges must not depend on the view: `faces` are only the visible planes, and at an angle where a flat mesh is
    // edge-on none is, which used to drop every cone's hull range and make all pairs edges: new shade edges for a few frames.)
    const hasHull = edges.size > 0;
    const isEdge = (i, j) => !hasHull || edges.has(i + ',' + j);
    const partnersOf = flats.map((f, i) => flats.filter((q, j) => j !== i && isEdge(Math.min(i, j), Math.max(i, j))));
    const spheres = flats.map((f, i) => buildSphere(f, L, partnersOf[i], 'n' + ids[i]));
    const cones = new Map();
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      if (isEdge(i, j)) cones.set(i + ',' + j, buildCone(flats[i], flats[j], L, hasHull ? flats.filter((f, l) => l !== i && l !== j) : [], ids[i] + '-' + ids[j]));
    }
    return { spheres, faces, flats, partnersOf, cones: [...cones.values()] };
  };

  const inv3 = (m) => {
    const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, det = a * A + b * B + c * C;
    return [A / det, (c * h - b * i) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, (c * d - a * f) / det, C / det, (b * g - a * h) / det, (a * e - b * d) / det];
  };
  // The perspective projection in homogeneous form: camera space (X, Y, Z) -> (s X + cx Z, -s Y + cy Z, Z) (projectToScreen).
  const projK = (() => {
    const Z0 = 100, f = basis.forward, q = projectPoint({ x: camPos.x + f.x * Z0, y: camPos.y + f.y * Z0, z: camPos.z + f.z * Z0 });
    return { cx: q.x, cy: q.y, s: q.scale * Z0 };
  })();
  const hom = (w, isPoint) => {
    const d = isPoint ? sub(w, camPos) : w, X = dot(d, basis.right), Y = dot(d, basis.up), Z = dot(d, basis.forward);
    return [projK.s * X + projK.cx * Z, -projK.s * Y + projK.cy * Z, Z];
  };
  // The screen image of the 3D ellipse C + U cos th + V sin th, in closed form: the projection is a projective map H = [U V C] (homogeneous
  // columns), so the image is the conic H^-T diag(1, 1, -1) H^-1, whose dual (its tangent lines) is H diag(1, 1, -1) H^T: no inverse,
  // so a thin row (a flat ribbon's, U or V tiny) stays well-conditioned (inverting H blew such a conic up to thousands of pixels). The
  // dual of the ellipse (x - c)^T P^-1 (x - c) = 1 is [[P - c c^T, -c], [-c^T, -1]], which gives the center and P. As { x, y, a, b, angle }
  // (ctx.ellipse's terms), or null if it is not a proper ellipse (the row crosses the camera's plane).
  const projectedEllipse = (C, U, V) => {
    const u = hom(U, false), v = hom(V, false), c = hom(C, true);
    const m = (i, j) => u[i] * u[j] + v[i] * v[j] - c[i] * c[j];
    const w = m(2, 2);
    if (!(w < 0)) return null;
    const k = -1 / w, x = -k * m(0, 2), y = -k * m(1, 2);
    const P00 = k * m(0, 0) + x * x, P01 = k * m(0, 1) + x * y, P11 = k * m(1, 1) + y * y;
    const mean = (P00 + P11) / 2, diff = Math.hypot((P00 - P11) / 2, P01), l1 = mean + diff, l2 = mean - diff;
    if (!(l1 > 0)) return null;
    return { x, y, a: Math.sqrt(l1), b: Math.sqrt(Math.max(l2, 0)), angle: 0.5 * Math.atan2(2 * P01, P00 - P11) };
  };
  // A screen point's parameter on an ellipse (ctx.ellipse's angle) and back.
  const paramOn = (e, p) => {
    const dx = p[0] - e.x, dy = p[1] - e.y, ca = Math.cos(e.angle), sa = Math.sin(e.angle);
    return Math.atan2((dy * ca - dx * sa) / e.b, (dx * ca + dy * sa) / e.a);
  };
  const pointOn = (e, psi) => {
    const ca = Math.cos(e.angle), sa = Math.sin(e.angle), c = Math.cos(psi), s = Math.sin(psi);
    return [e.x + e.a * c * ca - e.b * s * sa, e.y + e.a * c * sa + e.b * s * ca];
  };
  const boxOfPts = (ps) => ps.reduce((b, [x, y]) => ({ x0: Math.min(b.x0, x), y0: Math.min(b.y0, y), x1: Math.max(b.x1, x), y1: Math.max(b.y1, y) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
  const boxesMeet = (p, q) => p.x0 <= q.x1 && q.x0 <= p.x1 && p.y0 <= q.y1 && q.y0 <= p.y1;
  const inBox = (x, y, b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;

  // A skewed arch (CLAUDE.md "Skewed meshes"), lit in WORLD space. `sampleAt(t)` gives the arch's sample at t in [0, 1]: { tv: t, c, Q, t, sinT }
  // (the center, the body's quadratic form x^T Q x = 1, row-major 3x3, the unit tangent, on a round arch the radius' tilt); the same t gives
  // the same object while the nodes stay put (render.js caches them), so a sample's camera-independent data is computed once (`prep`). The
  // swept body's surface is the envelope of the ellipsoids: its point with the unit normal n (n perpendicular to the arch's tangent t) is
  // c + S n / sqrt(n^T S n), S = Q^-1. So per sample the normals are a circle, n(phi) = cos(phi) e1 + sin(phi) e2, and n . L >= 0 is EXACTLY
  // one arc of phi (centered on the light's direction in that plane) and n . v >= 0 (facing the viewer) another: the lit visible surface of a
  // sample is the intersection of the two arcs, whose ends are the terminator (a point of the border, independent of the camera) or the
  // silhouette. Each row of the surface is a planar 3D conic (a circle on a round arch; on a squashed one the ellipsoid's cut by the plane
  // t^T Q x = 0), so on screen it is an exact ellipse (`projectedEllipse`) and its arcs are drawn as elliptic arcs; consecutive rows' arcs are
  // joined into strips in ONE path (no antialiasing seam between them). The rows are placed where they are needed: bisected while a tracked
  // curve (the visible and lit arcs' ends: the silhouette and the terminator) bends away from the chord between two rows by more than
  // ROW_TOL on screen, or the arcs change between them, so only the strips' sides are chords. The two ends are capped the same way, on rings
  // n = cos(a) n(phi) + sin(a) out (a from the end row to the pole), whose arcs are cos(phi - phiL) >= -tan(a) (out . L) / |L_e| (circles on
  // a round end; a squashed end is sliced by planes parallel to its end row instead, `sliceRing`, plane ellipses too).
  // `cuts` (a skewed mesh split into two halves), as values of t: `apex` the skew node (its tangent gives the tube light), `lo` / `hi` where
  // the two halves' drawn fills end (one drawn sample before / after the apex, where they overlap). The surface is always cut into sheets at
  // lo and hi (see the sheets below), each sheet tagged with its `half`: 0 before lo, 1 after hi, 'both' in between.
  const buildArch = (sampleAt, cutsT = null) => {
    const Lw = light.dir, cp = camPos;
    const PROBES = 5, PROXY_STEPS = 5, ARCH_SEAM_PX = 1.5, ROW_TOL = 0.5 * px, POLY_STEP = 0.3, MAIN_DEPTH = 6, CAP_DEPTH = 4;
    const TWO_PI = 2 * Math.PI;
    const Qm = (Q, v) => ({ x: Q[0] * v.x + Q[1] * v.y + Q[2] * v.z, y: Q[3] * v.x + Q[4] * v.y + Q[5] * v.z, z: Q[6] * v.x + Q[7] * v.y + Q[8] * v.z });
    const wrap = (x) => { x = (x + Math.PI) % TWO_PI; if (x < 0) x += TWO_PI; return x - Math.PI; };
    const mod = (x) => ((x % TWO_PI) + TWO_PI) % TWO_PI;
    // the arcs (relative to the first center) where both cos(phi - c1) >= -k1 and cos(phi - c2) >= -k2: half widths w = acos(-k)
    const meet = (c1, w1, c2, w2) => {
      const D = wrap(c2 - c1);
      if (w1 >= Math.PI - 1e-9) return [[D - w2, D + w2]];
      if (w2 >= Math.PI - 1e-9) return [[-w1, w1]];
      const out = [];
      [D, D - TWO_PI, D + TWO_PI].forEach(Dc => {
        const lo = Math.max(-w1, Dc - w2), hi = Math.min(w1, Dc + w2);
        if (hi - lo > 1e-9) out.push([lo, hi]);
      });
      return out.sort((p, q) => p[0] - q[0]);
    };
    const halfWidth = (k) => (k <= -1 ? null : Math.acos(Math.max(-1, Math.min(1, -k))));      // cos(x) >= -k; null: never
    // a frame (e1, e2) perpendicular to the tangent that turns with the arch (e1 from the arch plane's normal r0; the same as the Debug
    // view's curves, archBorderCurves)
    const sA = sampleAt(0), sB = sampleAt(1), sM = sampleAt(cutsT ? cutsT.apex : 0.5);
    let r0 = cross(sub(sB.c, sA.c), sub(sM.c, sA.c));
    if (len(r0) < 1e-9) { const ch = sA.t; r0 = Math.abs(ch.x) < 0.9 ? cross(ch, { x: 1, y: 0, z: 0 }) : cross(ch, { x: 0, y: 1, z: 0 }); }
    r0 = unit(r0);
    const prep = (s) => {
      if (s.arch) return s.arch;
      const t = s.t, k = dot(r0, t), Q = s.Q;
      const e1 = unit({ x: r0.x - k * t.x, y: r0.y - k * t.y, z: r0.z - k * t.z }), e2 = cross(t, e1);
      const round = Q[1] === 0 && Q[2] === 0 && Q[3] === 0 && Q[5] === 0 && Q[6] === 0 && Q[7] === 0 && Q[0] === Q[4] && Q[4] === Q[8];
      return (s.arch = { t, e1, e2, S: inv3(Q), round, r: round ? 1 / Math.sqrt(Q[0]) : 0 });
    };
    // Tube mode (config.js lighting.archTube): every row is lit on one fixed half of its cross-section in this frame, centered on the
    // tube light at the skew node (`phiS`: the light without its part along the tangent there), so the shade lines are the curves at
    // phiS +- pi/2 from end to end (the Debug view's cyan curves); on the end caps the same half (n . lam >= 0 for the tube light carried
    // to that end, cos(phi - phiS) >= 0 on every ring), as a straight cone's end sphere continues its border.
    const tube = lighting.archTube && !!cutsT;
    let phiS = 0, tubeDark = false;
    if (tube) {
      const f = prep(sM), u = f.t, k = dot(Lw, u), lam = { x: Lw.x - k * u.x, y: Lw.y - k * u.y, z: Lw.z - k * u.z };
      if (len(lam) < 1e-9) tubeDark = true;
      else phiS = Math.atan2(dot(lam, f.e2), dot(lam, f.e1));
    }
    // the ring a (a = 0: the tube itself) of sample s, facing `sign` of its tangent: arcs of phi, plus the terminator's phi (+ and -)
    // A squashed end's cap (rows a != 0) is sliced by planes parallel to its end row instead of rings of constant normal angle,
    // which on an ellipsoid are not planar: with T the semi-diameter along the tangent and U0 / V0 the end row's conjugate
    // semi-diameters (a conjugate triple, so each slice is the plane ellipse c + sign sin a T + cos a (U0 cos phi + V0 sin phi)),
    // facing the viewer (n . v >= 0, n ~ K y) and lit (n . L >= 0) are each y^T K w >= 0, linear in (cos phi, sin phi): one arc each,
    // closed form, and a = 0 gives the end row's own arcs.
    const isSlice = (s, a) => a !== 0 && !prep(s).round;
    const triple = (s) => {
      const f = prep(s);
      if (f.triple) return f.triple;
      const Kt = Qm(s.Q, f.t), kt = Math.sqrt(dot(f.t, Kt)), T = { x: f.t.x / kt, y: f.t.y / kt, z: f.t.z / kt };
      const Se1 = Qm(f.S, f.e1), k = dot(f.e2, Se1) / dot(f.e1, Se1), m = { x: f.e2.x - k * f.e1.x, y: f.e2.y - k * f.e1.y, z: f.e2.z - k * f.e1.z };
      const Sm = Qm(f.S, m), ku = Math.sqrt(dot(f.e1, Se1)), kv = Math.sqrt(Math.max(dot(m, Sm), 1e-300));
      return (f.triple = { T, U0: { x: Se1.x / ku, y: Se1.y / ku, z: Se1.z / ku }, V0: { x: Sm.x / kv, y: Sm.y / kv, z: Sm.z / kv } });
    };
    const sliceRing = (s, a, sign) => {
      const { T, U0, V0 } = triple(s), sa = Math.sin(a) * sign, ca = Math.cos(a);
      // y^T K w >= 0 as cos(phi - c) >= -C / R: { c, w } (w the half-width), w = PI when it always holds, null when never
      // (`one`: y^T K w >= one; facing the camera in perspective is (K w) . y >= 1 with w = camPos - c, the point's own view ray)
      const half = (w, one = 0) => {
        const Kw = Qm(s.Q, w), A = ca * dot(U0, Kw), B = ca * dot(V0, Kw), C = sa * dot(T, Kw) - one, R = Math.hypot(A, B);
        if (R < 1e-12 * (Math.abs(C) + 1e-300)) return C >= 0 ? { c: 0, w: Math.PI } : { c: 0, w: null };
        return { c: Math.atan2(B, A), w: halfWidth(C / R) };
      };
      const f = prep(s), V = half(sub(cp, s.c), 1);
      const dark = !lit || (tube && tubeDark);
      const L = dark ? null : half(tube ? { x: Math.cos(phiS) * f.e1.x + Math.sin(phiS) * f.e2.x, y: Math.cos(phiS) * f.e1.y + Math.sin(phiS) * f.e2.y, z: Math.cos(phiS) * f.e1.z + Math.sin(phiS) * f.e2.z } : Lw);
      const vis = V.w === null ? null : [V.c - V.w, V.c + V.w];
      const phiL = L ? L.c : 0, wL = L ? L.w : null;
      if (wL === null || V.w === null) return { arcs: [], phiL, wL, vis };
      return { arcs: meet(phiL, wL, V.c, V.w).map(([lo, hi]) => [phiL + lo, phiL + hi]), phiL, wL, phiV: V.c, wV: V.w, vis };
    };
    const ring = (s, a, sign) => {
      if (isSlice(s, a)) return sliceRing(s, a, sign);
      const f = prep(s), { e1, e2, t } = f, w = sub(cp, s.c), w1 = dot(w, e1), w2 = dot(w, e2);
      const hL = Math.hypot(dot(Lw, e1), dot(Lw, e2)), hW = Math.hypot(w1, w2);
      if (hW < 1e-9 * len(w)) return null;
      // (no light: an instance for the outline only, `lit` false, or the light along the tangent: the visible arc alone)
      const dark = !lit || (tube ? tubeDark : hL < 1e-9);
      const ta = Math.tan(a);
      // The visible arc in perspective: a point x faces the camera where its normal n has n . (camPos - x) >= 0, so the arc's ends are
      // on the exact contour (the silhouette the outline follows, and the cap's contour ellipse at the end rows). On a round row x =
      // c + r n, n = cos a n(phi) + sin a t: cos a hW cos(phi - phiW) + sin a (t . w) >= r. On a squashed row (a = 0) x = c + S n / k,
      // k = sqrt(n^T S n): n . w >= k, i.e. (n . w)^2 - n^T S n >= 0 on the side n . w > 0, a quadratic form in (cos phi, sin phi).
      let phiV = Math.atan2(w2, w1), wV;
      if (f.round) wV = halfWidth((Math.sin(a) * sign * dot(w, t) - f.r) / (Math.cos(a) * hW));
      else {
        const Se1 = Qm(f.S, e1), Se2 = Qm(f.S, e2);
        const A = w1 * w1 - dot(e1, Se1), B = w1 * w2 - dot(e1, Se2), C = w2 * w2 - dot(e2, Se2);
        const m = (A + C) / 2, R = Math.hypot((A - C) / 2, B);
        if (R < 1e-12 * Math.abs(m)) wV = m >= 0 ? Math.PI / 2 : null;
        else if (-m / R <= -1) wV = Math.PI / 2;
        else if (-m / R >= 1) wV = null;
        else {
          const psi = 0.5 * Math.atan2(B, (A - C) / 2);
          phiV = Math.cos(psi - phiV) >= 0 ? psi : psi + Math.PI;
          wV = Math.acos(-m / R) / 2;
        }
      }
      const phiL = tube ? phiS : dark ? 0 : Math.atan2(dot(Lw, e2), dot(Lw, e1));
      const wL = dark ? null : tube ? Math.PI / 2 : halfWidth(ta * sign * dot(Lw, t) / hL);
      const vis = wV === null ? null : [phiV - wV, phiV + wV];     // the visible arc (lit or not)
      if (wL === null || wV === null) return { arcs: [], phiL, wL, vis };
      const arcs = meet(phiL, wL, phiV, wV).map(([lo, hi]) => [phiL + lo, phiL + hi]);
      return { arcs, phiL, wL, phiV, wV, vis };
    };
    const at = (r, phi) => {
      if (isSlice(r.s, r.a)) {
        const { T, U0, V0 } = triple(r.s), sa = Math.sin(r.a) * r.sign, ca = Math.cos(r.a), cu = ca * Math.cos(phi), cv = ca * Math.sin(phi), c = r.s.c;
        return { x: c.x + sa * T.x + cu * U0.x + cv * V0.x, y: c.y + sa * T.y + cu * U0.y + cv * V0.y, z: c.z + sa * T.z + cu * U0.z + cv * V0.z };
      }
      const { e1, e2, t, S } = prep(r.s), ca = Math.cos(r.a), sa = Math.sin(r.a) * r.sign, cs = Math.cos(phi), sn = Math.sin(phi);
      const nv = { x: ca * (cs * e1.x + sn * e2.x) + sa * t.x, y: ca * (cs * e1.y + sn * e2.y) + sa * t.y, z: ca * (cs * e1.z + sn * e2.z) + sa * t.z };
      const x = Qm(S, nv), k = Math.sqrt(Math.max(dot(nv, x), 1e-300)), c = r.s.c;
      return { x: c.x + x.x / k, y: c.y + x.y / k, z: c.z + x.z / k };
    };
    const onScreen = (r, phi) => { const q = projectPoint(at(r, phi)); return [q.x, q.y]; };
    const makeRow = (s, a, sign) => ({ s, a, sign, ring: ring(s, a, sign) });
    // what the rows' spacing follows: the ends of the visible arc and of the lit arcs on screen, and the arcs' layout
    const track = (r) => {
      if (r.tr) return r.tr;
      const g = r.ring;
      if (!g) return (r.tr = { key: 'x', pts: [] });
      const phis = g.vis ? [g.vis[0], g.vis[1]] : [];
      g.arcs.forEach(a => phis.push(a[0], a[1]));
      return (r.tr = { key: (g.vis ? 'v' : '-') + g.arcs.length, pts: phis.map(phi => onScreen(r, phi)) });
    };
    // the rows after r0 up to r1 (parameters p0, p1), bisected where needed (above), at most `depth` times
    const refine = (p0, rA, p1, rB, make, depth, out) => {
      if (depth > 0) {
        const pm = (p0 + p1) / 2, rm = make(pm), T0 = track(rA), T1 = track(rB), Tm = track(rm);
        let split = T0.key !== Tm.key || Tm.key !== T1.key;
        for (let j = 0; !split && j < Tm.pts.length; j++) {
          const a = T0.pts[j], b = T1.pts[j], m = Tm.pts[j];
          split = Math.hypot(m[0] - (a[0] + b[0]) / 2, m[1] - (a[1] + b[1]) / 2) > ROW_TOL;
        }
        if (split) { refine(p0, rA, pm, rm, make, depth - 1, out); refine(pm, rm, p1, rB, make, depth - 1, out); return; }
      }
      out.push(rB);
    };
    // (in tube mode a round arch's rows take the radius' tilt, sinT: the normals of the swept spheres' surface, like the curves)
    const tilt = (s) => (tube ? Math.asin(Math.max(-1, Math.min(1, s.sinT || 0))) : 0);
    const mainRow = (t) => { const s = sampleAt(t); return makeRow(s, tilt(s), 1); };
    const ts = [...new Set([...Array.from({ length: 17 }, (_, i) => i / 16), ...(cutsT ? [cutsT.apex, cutsT.lo, cutsT.hi, ...(cutsT.draw || [])] : [])])].sort((p, q) => p - q);
    const main = [mainRow(ts[0])];
    for (let k = 1; k < ts.length; k++) refine(ts[k - 1], main[main.length - 1], ts[k], mainRow(ts[k]), mainRow, MAIN_DEPTH, main);
    // The borders (the outline's two silhouettes, see `outline`): per main row the two ends of the visible arc on screen, exact, with
    // their screen tangents, which are the row ellipse's tangents there (a curve on the surface through a contour point projects tangent
    // to the silhouette). Between two rows a border is a cubic through both ends with those tangents (lengths as jointCurveGeneral.js:
    // exact for a circular arc); a row is added between them wherever the exact point at the middle t is off the cubic by BEZ_TOL.
    const BEZ_TOL = 0.25 * px, BEZ_DEPTH = 5, DPHI = 1e-4;
    const silOf = (r) => {
      if (r.sil !== undefined) return r.sil;
      const g = r.ring;
      if (!g || !g.vis || g.vis[1] - g.vis[0] >= TWO_PI - 1e-9) return (r.sil = null);
      // (a tangent is left out, d null, where the row runs nearly along the view ray at the point: seen edge-on there, its screen
      // image has a cusp and its direction says nothing about the border's; the border's neighbors give it instead, `border`)
      return (r.sil = g.vis.map(phi => {
        const p = onScreen(r, phi), a = onScreen(r, phi - DPHI), b = onScreen(r, phi + DPHI), dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
        const A = at(r, phi - DPHI), B = at(r, phi + DPHI), l3 = len(sub(B, A)) * projectPoint(at(r, phi)).scale;
        return { p, d: l > 1e-12 && l > 0.1 * l3 ? [dx / l, dy / l] : null };
      }));
    };
    const bezOf = (A, B) => {
      const cx = B.p[0] - A.p[0], cy = B.p[1] - A.p[1], L = Math.hypot(cx, cy);
      if (L < 1e-9) return { kind: 'bez', p0: A.p, c1: A.p, c2: B.p, p1: B.p };
      const ux = cx / L, uy = cy / L;
      // (each tangent signed along the chord)
      const dir = (d) => (!d ? [ux, uy] : d[0] * ux + d[1] * uy < 0 ? [-d[0], -d[1]] : d);
      const T0 = dir(A.d), T1 = dir(B.d);
      const m0 = 2 * L / (1 + T0[0] * ux + T0[1] * uy) / 3, m1 = 2 * L / (1 + T1[0] * ux + T1[1] * uy) / 3;
      return { kind: 'bez', p0: A.p, c1: [A.p[0] + T0[0] * m0, A.p[1] + T0[1] * m0], c2: [B.p[0] - T1[0] * m1, B.p[1] - T1[1] * m1], p1: B.p };
    };
    const bezAt = (z, u) => {
      const v = 1 - u, a = v * v * v, b = 3 * v * v * u, c = 3 * v * u * u, d = u * u * u;
      return [a * z.p0[0] + b * z.c1[0] + c * z.c2[0] + d * z.p1[0], a * z.p0[1] + b * z.c1[1] + c * z.c2[1] + d * z.p1[1]];
    };
    const bezDist = (z, p) => {
      let best = Infinity, prev = z.p0;
      for (let j = 1; j <= 24; j++) {
        const q = bezAt(z, j / 24), dx = q[0] - prev[0], dy = q[1] - prev[1], l2 = dx * dx + dy * dy;
        const u = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - prev[0]) * dx + (p[1] - prev[1]) * dy) / l2)) : 0;
        best = Math.min(best, Math.hypot(prev[0] + u * dx - p[0], prev[1] + u * dy - p[1]));
        prev = q;
      }
      return best;
    };
    // In perspective a row can face away entirely (a tube pointing at the camera: its sides are hidden), so the visible surface is
    // one disc per run of rows that have a visible arc. Where the arc vanishes between two rows, a row is added just on the visible
    // side of that t (bisected): there the two borders meet. The arc can also shrink to a sliver on one side of the body and grow
    // back on the other (a thin ribbon turning from one face to the other as seen: its row seen edge-on), with every row keeping a
    // sliver: its center jumps by about pi and the two ends swap edges. That is a split too: both rows next to the jump are bisected
    // in and the first is marked `flipNext`, so each face is its own disc (joined, one loop crossed the band twice and wound the
    // second face backwards, which cancelled where the two overlapped: a bulge near the green ribbon's skew node at 0.124).
    {
      const seen = (r) => !!(r.ring && r.ring.vis), mid = (r) => (r.ring.vis[0] + r.ring.vis[1]) / 2;
      const flips = (a, b) => seen(a) && seen(b) && Math.abs(wrap(mid(a) - mid(b))) > Math.PI / 2;
      const out = [main[0]];
      const bisect = (a, b, same) => {
        let lo = a, hi = b;
        for (let j = 0; j < 40 && hi.s.tv - lo.s.tv > 1e-10; j++) { const m = mainRow((lo.s.tv + hi.s.tv) / 2); if (same(m)) lo = m; else hi = m; }
        return [lo, hi];
      };
      for (let k = 1; k < main.length; k++) {
        const a = main[k - 1], b = main[k];
        if (seen(a) !== seen(b)) {
          const [lo, hi] = bisect(a, b, (m) => seen(m) === seen(a)), pick = seen(a) ? lo : hi;
          if (pick !== a && pick !== b) out.push(pick);
        } else if (flips(a, b)) {
          const [lo, hi] = bisect(a, b, (m) => seen(m) && !flips(a, m));
          if (lo !== a) out.push(lo);
          lo.flipNext = true;
          if (hi !== b) out.push(hi);
        }
        out.push(b);
      }
      main.splice(0, main.length, ...out);
    }
    // (the distance from a point to the polyline through some points)
    const polyDist = (p, pts) => pts.slice(1).reduce((best, q, i) => {
      const o = pts[i], dx = q[0] - o[0], dy = q[1] - o[1], l2 = dx * dx + dy * dy;
      const u = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - o[0]) * dx + (p[1] - o[1]) * dy) / l2)) : 0;
      return Math.min(best, Math.hypot(o[0] + u * dx - p[0], o[1] + u * dy - p[1]));
    }, Infinity);
    const straightOf = (A, B) => ({ kind: 'bez', p0: A.p, c1: A.p, c2: B.p, p1: B.p });
    {
      const fitted = [main[0]];
      // A cubic's error against the exact border, both ways: the exact middle point to the cubic, and the cubic's middle to the exact
      // points (where the border sweeps across a thin ribbon's face almost at once, the exact middle sits near an end, and so does the
      // cubic, which swung out on its end tangents, along the edges, in a loop: a bulge beside the green ribbon's skew node at 3.178).
      const errOf = (z, A, M, B) => Math.max(bezDist(z, M.p), polyDist(bezAt(z, 0.5), [A.p, M.p, B.p]));
      const fit = (rA, rB, depth) => {
        const SA = silOf(rA), SB = silOf(rB);
        if (SA && SB && !rA.flipNext) {
          const rm = mainRow((rA.s.tv + rB.s.tv) / 2), Sm = silOf(rm);
          const errs = Sm ? [0, 1].map(j => errOf(bezOf(SA[j], SB[j]), SA[j], Sm[j], SB[j])) : [0, 0];
          if (errs.some(e => e > BEZ_TOL)) {
            if (depth > 0) { fit(rA, rm, depth - 1); fit(rm, rB, depth - 1); return; }
            // still not a cubic at the last depth (such a sweep): the chord where it is closer
            rA.straight = [0, 1].map(j => errs[j] > BEZ_TOL && errOf(straightOf(SA[j], SB[j]), SA[j], Sm[j], SB[j]) < errs[j]);
          }
        }
        fitted.push(rB);
      };
      for (let k = 1; k < main.length; k++) fit(main[k - 1], main[k], BEZ_DEPTH);
      main.splice(0, main.length, ...fitted);
    }
    const samples = main.map(r => r.s), n = samples.length;
    const indexOf = (t) => samples.findIndex(s => s.tv === t);
    const cuts = cutsT ? { lo: indexOf(cutsT.lo), hi: indexOf(cutsT.hi) } : null;
    // the caps: rings from the end row (the same circle, as a ring facing outward) to the pole; the pole's ring is a point (its arc is all or
    // nothing), so the strip to it closes the cap
    const POLE = (Math.PI / 2) * (1 - 1e-4);
    const cap = (end, sign) => {
      const s = end.s, make = (a) => makeRow(s, a, sign), a0 = sign * end.a, out = [];
      const base = [0, 1, 2, 3, 4].map(k => a0 + (POLE - a0) * k / 4);
      let prev = make(base[0]);
      for (let k = 1; k < base.length; k++) { const r = make(base[k]); refine(base[k - 1], prev, base[k], r, make, CAP_DEPTH, out); prev = r; }
      return out;
    };
    const rows = [...cap(main[0], -1).reverse(), ...main, ...cap(main[n - 1], 1)];
    const nCap0 = rows.indexOf(main[0]);
    rows.forEach((r, k) => { r.i = k < nCap0 ? 0 : k < nCap0 + n ? k - nCap0 : n - 1; });
    // A row's screen ellipse (every row is planar), or null (an edge-on row, thinner than half a pixel: drawn as a polyline).
    const conicOf = (r) => {
      if (r.conic !== undefined) return r.conic;
      const f = prep(r.s);
      let C, U, V;
      if (f.round) {
        const ra = f.r * Math.cos(r.a), off = f.r * Math.sin(r.a) * r.sign, c = r.s.c;
        C = { x: c.x + off * f.t.x, y: c.y + off * f.t.y, z: c.z + off * f.t.z };
        U = { x: ra * f.e1.x, y: ra * f.e1.y, z: ra * f.e1.z }; V = { x: ra * f.e2.x, y: ra * f.e2.y, z: ra * f.e2.z };
      } else if (isSlice(r.s, r.a)) {
        // a cap slice (above)
        const { T, U0, V0 } = triple(r.s), sa = Math.sin(r.a) * r.sign, ca = Math.cos(r.a), c = r.s.c;
        C = { x: c.x + sa * T.x, y: c.y + sa * T.y, z: c.z + sa * T.z };
        U = { x: ca * U0.x, y: ca * U0.y, z: ca * U0.z }; V = { x: ca * V0.x, y: ca * V0.y, z: ca * V0.z };
      } else if (r.a === 0) {
        // conjugate semi-diameters of the cut: S e1 and S m, m = e2 - (e1^T S e2 / e1^T S e1) e1, each scaled onto the body
        const Se1 = Qm(f.S, f.e1), k = dot(f.e2, Se1) / dot(f.e1, Se1), m = { x: f.e2.x - k * f.e1.x, y: f.e2.y - k * f.e1.y, z: f.e2.z - k * f.e1.z };
        const Sm = Qm(f.S, m), ku = Math.sqrt(dot(f.e1, Se1)), kv = Math.sqrt(Math.max(dot(m, Sm), 1e-300));
        C = r.s.c; U = { x: Se1.x / ku, y: Se1.y / ku, z: Se1.z / ku }; V = { x: Sm.x / kv, y: Sm.y / kv, z: Sm.z / kv };
      } else return (r.conic = null);
      const e = projectedEllipse(C, U, V);
      return (r.conic = e && e.b >= 0.5 * px ? e : null);
    };
    // An end of an arc that is the silhouette (not the terminator) is pushed out ARCH_SEAM_PX on screen: the drawn outline and the 3D
    // silhouette differ by about a pixel, and a lit part that falls short leaves a thin line of the base tone along the edge (the
    // part past the outline is cut off by the fill). The terminator ends stay where they are.
    const csc = samples.map(s => projectPoint(s.c));
    // A row's arc on screen: `draw` the elliptic arc (or null: the polyline `pts`), `P0` / `P1` its exact ends, `Q0` / `Q1` the same pushed
    // out; `pts` a coarse polyline on it (PROXY_STEPS steps, pushed ends) and `raw` the same unpushed (the true projection), what the
    // sheets' overlap and order tests work on (they only need to find where strips overlap, the drawing is the exact arc).
    const chain = (r, arc) => {
      const g = r.ring, e = conicOf(r);
      const isTerm = (phi) => Math.abs(wrap(phi - (g.phiL + g.wL))) < 1e-6 || Math.abs(wrap(phi - (g.phiL - g.wL))) < 1e-6;
      const whole = arc[1] - arc[0] >= TWO_PI - 1e-9;
      const P0 = onScreen(r, arc[0]), P1 = whole ? P0 : onScreen(r, arc[1]);
      let raw, draw = null;
      if (e) {
        const p0 = paramOn(e, P0);
        let dir, span;
        if (whole) { dir = mod(paramOn(e, onScreen(r, arc[0] + Math.PI / 2)) - p0) < Math.PI ? 1 : -1; span = TWO_PI; }
        else {
          const p1 = paramOn(e, P1), pm = paramOn(e, onScreen(r, (arc[0] + arc[1]) / 2));
          dir = mod(pm - p0) < mod(p1 - p0) ? 1 : -1;
          span = dir > 0 ? mod(p1 - p0) : mod(p0 - p1);
        }
        draw = { e, from: p0, to: p0 + dir * span, ccw: dir < 0 };
        raw = [];
        for (let j = 0; j <= PROXY_STEPS; j++) raw.push(j === 0 ? P0 : j === PROXY_STEPS ? P1 : pointOn(e, p0 + dir * span * j / PROXY_STEPS));
      } else {
        const m = Math.max(2, Math.ceil((arc[1] - arc[0]) / POLY_STEP));
        raw = [];
        for (let j = 0; j <= m; j++) raw.push(j === 0 ? P0 : j === m ? P1 : onScreen(r, arc[0] + (arc[1] - arc[0]) * j / m));
      }
      const push = (P, phi) => {
        if (isTerm(phi)) return P;
        const c = csc[r.i], dx = P[0] - c.x, dy = P[1] - c.y, l = Math.hypot(dx, dy) || 1;
        return [P[0] + dx / l * ARCH_SEAM_PX * px, P[1] + dy / l * ARCH_SEAM_PX * px];
      };
      const Q0 = push(P0, arc[0]), Q1 = push(P1, arc[1]), pts = raw.slice();
      pts[0] = Q0; pts[pts.length - 1] = Q1;
      return { draw, P0, P1, Q0, Q1, pts, raw };
    };
    // A strip's shape: a list of points [x, y] and arcs { c: chain, rev }; `flat` its polyline (pushed ends), `trace` adds it to a path.
    const flat = (shape) => shape.flatMap(it => (Array.isArray(it) ? [it] : it.rev ? it.c.pts.slice().reverse() : it.c.pts));
    const reversed = (shape) => shape.slice().reverse().map(it => (Array.isArray(it) ? it : { c: it.c, rev: !it.rev }));
    // (`exact`: the true projection, without the ARCH_SEAM_PX push: the fill's outline)
    const trace = (path, shape, exact = false) => {
      let started = false;
      const to = (p) => { if (started) path.lineTo(p[0], p[1]); else path.moveTo(p[0], p[1]); started = true; };
      shape.forEach(it => {
        if (Array.isArray(it)) { to(it); return; }
        const c = it.c, d = c.draw, line = exact ? c.raw : c.pts;
        if (!d) { (it.rev ? line.slice().reverse() : line).forEach(to); return; }
        const [Qa, Pa, Qb, from, end] = exact ? (it.rev ? [c.P1, c.P1, c.P0, d.to, d.from] : [c.P0, c.P0, c.P1, d.from, d.to])
          : it.rev ? [c.Q1, c.P1, c.Q0, d.to, d.from] : [c.Q0, c.P0, c.Q1, d.from, d.to];
        to(Qa); to(Pa);
        path.ellipse(d.e.x, d.e.y, d.e.a, d.e.b, d.e.angle, from, end, it.rev ? !d.ccw : d.ccw);
        path.lineTo(Qb[0], Qb[1]);
      });
      path.closePath();
    };
    const area = (ps) => ps.reduce((acc, p, i) => { const q = ps[(i + 1) % ps.length]; return acc + p[0] * q[1] - q[0] * p[1]; }, 0);
    // The arch is not convex: where its surface folds over itself on screen (a wide band turning past edge-on at a bend), a lit strip
    // behind can lie under an unlit one in front, and one lit path would show it through. The visible surface is front-facing everywhere,
    // so a fold is not a flip of orientation but a contour ACROSS the band: between two rows, a silhouette point (an end of the visible
    // arc) jumps from one edge of the band to the other instead of moving along with the center. The strips are cut into *sheets* there;
    // with more than one sheet, they are painted back to front (by their depths where they overlap), each first covering what it hides
    // in the base tone (`cover`), then its lit part.
    const strips = [];       // per pair of rows: the visible quad (or null), its signed area, the lit quads
    for (let k = 0; k + 1 < rows.length; k++) {
      const A = rows[k].ring, B = rows[k + 1].ring, strip = { k, vis: null, area: 0, lits: [] };
      strips.push(strip);
      if (!A || !B) continue;
      if (A.vis && B.vis) {
        const a = chain(rows[k], A.vis), b = chain(rows[k + 1], B.vis);
        strip.vis = [{ c: a }, { c: b, rev: true }];
        strip.visFlat = flat(strip.vis); strip.area = area(strip.visFlat);
        strip.rawRows = [a.raw, b.raw];
      }
      const push = (shape) => strip.lits.push(area(flat(shape)) < 0 ? reversed(shape) : shape);
      const lerp = (p, q, f) => [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f];
      if (A.arcs.length !== B.arcs.length) {
        // A lit patch that starts between the two rows (none on one, one or more arcs on the other): each arc tapers to a point halfway to
        // the other row, instead of ending square on its own row. The tip is at the arc's end nearest the other row's visible arc (the
        // patch vanishes where that end meets the silhouette): aimed at its middle, the tip could face away on the other row and project
        // across the tube (a lit hook at the skew node of the threaded orange arch at 2.0, where the tube points at the camera).
        if (A.arcs.length && B.arcs.length) continue;
        const [R0, R1, arcs, first] = A.arcs.length ? [rows[k], rows[k + 1], A.arcs, true] : [rows[k + 1], rows[k], B.arcs, false];
        const visO = R1.ring.vis, off = (phi) => (visO ? Math.max(0, Math.abs(wrap(phi - (visO[0] + visO[1]) / 2)) - (visO[1] - visO[0]) / 2) : 0);
        arcs.forEach(arc => {
          const c = !visO ? (arc[0] + arc[1]) / 2 : off(arc[0]) <= off(arc[1]) ? arc[0] : arc[1];
          const tip = lerp(onScreen(R0, c), onScreen(R1, c), 0.5), side = { c: chain(R0, arc) };
          push(first ? [side, tip] : [tip, side]);
        });
        continue;
      }
      A.arcs.forEach((arcA, j) => {
        const arcB = B.arcs[j], whole = (arc) => arc[1] - arc[0] >= TWO_PI - 1e-6;
        if (!whole(arcA) && !whole(arcB) && Math.abs(wrap((arcA[0] + arcA[1] - arcB[0] - arcB[1]) / 2)) > 1) {
          // The two rows' lit arcs are on different sides of the body: the light comes from nearly behind, the lit part is a sliver along
          // the silhouette, and where the light lines up with the view it shrinks to nothing and comes back on the other side. Joined, the
          // strip would cross the whole body; each sliver tapers instead to a point on its silhouette, at the fraction of the way where the
          // widths reach zero (the terminator crosses the silhouette there).
          if (!A.vis || !B.vis) return;
          const wA = arcA[1] - arcA[0], wB = arcB[1] - arcB[0], f = wA / (wA + wB || 1);
          const near = (phi, list) => list.reduce((m, x) => (Math.abs(wrap(x - phi)) < Math.abs(wrap(m - phi)) ? x : m));
          // an arc's silhouette end is the one on an end of the visible arc (the other is the terminator)
          const silEnd = (arc, vis) => { const d = (x) => Math.abs(wrap(x - near(x, vis))); return d(arc[0]) <= d(arc[1]) ? arc[0] : arc[1]; };
          const endA = silEnd(arcA, A.vis), endB = silEnd(arcB, B.vis);
          push([{ c: chain(rows[k], arcA) }, lerp(onScreen(rows[k], endA), onScreen(rows[k + 1], near(endA, B.vis)), f)]);
          push([lerp(onScreen(rows[k], near(endB, A.vis)), onScreen(rows[k + 1], endB), f), { c: chain(rows[k + 1], arcB) }]);
          return;
        }
        push([{ c: chain(rows[k], arcA) }, { c: chain(rows[k + 1], arcB), rev: true }]);
      });
    }
    const scr = (r, phi) => { const p = at(r, phi), q = projectPoint(p); return { x: q.x, y: q.y, d: dot(sub(p, cp), basis.forward) }; };
    const sil = rows.map(r => (r.ring && r.ring.vis ? r.ring.vis.map(phi => scr(r, phi)) : null));
    const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
    const crosses = (k) => {
      if (rows[k].i === rows[k + 1].i) return false;     // inside an end cap (half of a convex ellipsoid: no fold)
      const a = sil[k], b = sil[k + 1], step = dist(csc[rows[k].i], csc[rows[k + 1].i]);
      const jump = Math.max(dist(a[0], b[0]), dist(a[1], b[1])), width = Math.min(dist(a[0], a[1]), dist(b[0], b[1]));
      return jump > 3 * step + 0.5 * width + 2 * px;
    };
    const inside = (pt, poly) => {
      let c = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) c = !c;
      }
      return c;
    };
    // Two strips overlap on screen: a few points of one (its corners and the midpoints across it) inside the other. A tube bending toward
    // the camera hides its own earlier strips behind later ones without any contour across it (at the apex of the threaded orange arch
    // at 2.02, a lit rim sliver showed through as a crescent), so a sheet is also cut where a strip overlaps a non-neighbor of its sheet.
    // Each strip's two row curves in their true projection (`raw`: without the ARCH_SEAM_PX push at the silhouette, which would make strips
    // of an ordinary bend touch), end points included: two strips overlap where those curves cross or a point of one lies inside the other.
    // (Counting sample points inside missed thin crescents: where the tube points at the camera, consecutive rows are nearly concentric, and a
    // lit taper showed through a nearer strip of the same sheet as a hook at the skew node, threaded orange arch at 2.0. Leaving the end
    // points out instead of unpushing them missed strips that overlap only along the silhouette: a lit rim near the apex showed through a
    // nearer, unlit part of the same half as a thin sliver, 4.256.)
    strips.forEach(st => {
      if (!st.vis) return;
      st.chains = st.rawRows;
      st.poly = st.rawRows[0].concat(st.rawRows[1].slice().reverse());
      st.box = boxOfPts(st.poly);
      st.visBox = boxOfPts(st.visFlat);
    });
    const segsCross = (a, b, c, d) => {
      const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
      return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
    };
    // The fill's outline (render.js buildSkewPrimitives): the union of the visible strips in their true projection, all wound anticlockwise
    // on screen, traced into one nonzero path. The visible surface covers the whole body on screen (a ray that meets the body enters it
    // through a front-facing point), so this is the body's outline from the same exact rows as its shading, with only the strips' sides
    // as chords (within ROW_TOL of the silhouette). A strip whose sides cross (a fold, the silhouette jumping across the band) is the
    // hull of its two row curves instead: wound one way it would cancel the strips beside it.
    const outlineOf = (st) => {
      if (st.outline !== undefined) return st.outline;
      if (!st.vis) return (st.outline = null);
      const [a, b] = [st.vis[0].c, st.vis[1].c];
      if (crosses(st.k) || segsCross(a.P0, b.P0, a.P1, b.P1)) {
        const hull = convexHull(st.poly.map(([x, y]) => ({ x, y }))).reverse();
        return (st.outline = { hull: hull.map(q => [q.x, q.y]) });
      }
      return (st.outline = { shape: area(st.poly) > 0 ? reversed(st.vis) : st.vis });
    };
    const tvOf = (k) => samples[rows[k].i].tv;
    // the strips from t0 to t1 (an end cap goes with its end)
    const stripOutline = (t0, t1) => (path) => strips.forEach(st => {
      if (tvOf(st.k) < t0 - 1e-12 || tvOf(st.k + 1) > t1 + 1e-12) return;
      const o = outlineOf(st);
      if (!o) return;
      if (o.shape) trace(path, o.shape, true);
      else { o.hull.forEach((q, j) => (j ? path.lineTo(q[0], q[1]) : path.moveTo(q[0], q[1]))); path.closePath(); }
    });
    // The body's outline from t0 to t1 as ONE closed curve, no inner edges (CLAUDE.md "Skewed meshes"). The visible surface is a disc in
    // (t, phi) (one visible arc per row) mapped onto the screen without mirroring anywhere, so its boundary, filled nonzero, covers
    // exactly the body's screen area, folds included: border 0 (the visible arcs' first ends) from t0 to t1, the end at t1, border 1
    // back, the end at t0. An end is the row's own visible arc (an exact ellipse arc) or, at t = 0 / 1, the cap: half of the end node's
    // ellipsoid, whose screen outline is an arc of the ellipsoid's exact silhouette (its contour is the plane section x^T K w = 1, w =
    // camPos - c, projected by `projectedEllipse`) between the two borders' ends, on the cap's side of the end row. Segments: { kind:
    // 'bez', p0, c1, c2, p1 }, { kind: 'arc', e, from, to, ccw, P0, P1 } (ctx.ellipse's terms), { kind: 'poly', pts } (an edge-on row).
    // null where a row has no proper visible arc (looking along the tangent): the strips are used there instead.
    const revSeg = (g) => (g.kind === 'bez' ? { kind: 'bez', p0: g.p1, c1: g.c2, c2: g.c1, p1: g.p0 }
      : g.kind === 'arc' ? { kind: 'arc', e: g.e, from: g.to, to: g.from, ccw: !g.ccw, P0: g.P1, P1: g.P0 } : { kind: 'poly', pts: g.pts.slice().reverse() });
    const rowArc = (r) => {
      const c = chain(r, r.ring.vis);
      return c.draw ? { kind: 'arc', e: c.draw.e, from: c.draw.from, to: c.draw.to, ccw: c.draw.ccw, P0: c.P0, P1: c.P1 } : { kind: 'poly', pts: c.raw };
    };
    // the cap at the end row r (sign -1 at t = 0, +1 at t = 1), from border 0's end to border 1's
    // the end node's contour: center c + S p / (p^T S p), p = K w, conjugate semi-diameters u1, u2 in its plane (p . y = 0) with
    // y^T K y = rho2 = 1 - 1 / (p^T S p); `side(X)` > 0 on the cap's side of the end row's plane (normal K t through the row's center,
    // offset along t on a tilted round row). null with the camera inside the node.
    const contourOf = (r, sign) => {
      const s = r.s, f = prep(s), K = s.Q;
      const p = Qm(K, sub(cp, s.c)), Sp = Qm(f.S, p), pSp = dot(p, Sp), rho2 = 1 - 1 / pSp;
      if (!(pSp > 0) || !(rho2 > 1e-12)) return null;
      const C = { x: s.c.x + Sp.x / pSp, y: s.c.y + Sp.y / pSp, z: s.c.z + Sp.z / pSp };
      const pu = unit(p), onto = (u) => { const k = Math.sqrt(rho2 / dot(u, Qm(K, u))); return { x: u.x * k, y: u.y * k, z: u.z * k }; };
      const u1 = onto(unit(cross(pu, Math.abs(pu.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 }))), u2 = onto(unit(cross(p, Qm(K, u1))));
      const e = projectedEllipse(C, u1, u2);
      if (!e || !(e.b > 1e-9)) return null;
      const Ku1 = Qm(K, u1), Ku2 = Qm(K, u2);
      const ptAt = (th) => ({ x: C.x + u1.x * Math.cos(th) + u2.x * Math.sin(th), y: C.y + u1.y * Math.cos(th) + u2.y * Math.sin(th), z: C.z + u1.z * Math.cos(th) + u2.z * Math.sin(th) });
      const thetaOf = (X) => { const y = sub(X, C); return Math.atan2(dot(y, Ku2), dot(y, Ku1)); };
      const nP = Qm(K, f.t), off = f.round ? f.r * Math.sin(r.a) * r.sign : 0, Cr = { x: s.c.x + off * f.t.x, y: s.c.y + off * f.t.y, z: s.c.z + off * f.t.z };
      return { e, ptAt, thetaOf, side: (X) => sign * dot(nP, sub(X, Cr)) };
    };
    const capArc = (r, sign) => {
      const S2 = silOf(r), k = S2 && contourOf(r, sign);
      if (!k) return null;
      const th0 = k.thetaOf(at(r, r.ring.vis[0])), th1 = k.thetaOf(at(r, r.ring.vis[1])), thm = th0 + mod(th1 - th0) / 2;
      const mid = k.side(k.ptAt(thm)) > 0 ? k.ptAt(thm) : k.ptAt(thm + Math.PI), qm = projectPoint(mid), e = k.e;
      const P0 = S2[0].p, P1 = S2[1].p, q0 = paramOn(e, P0), q1 = paramOn(e, P1), pm = paramOn(e, [qm.x, qm.y]);
      const dir = mod(pm - q0) < mod(q1 - q0) ? 1 : -1, span = dir > 0 ? mod(q1 - q0) : mod(q0 - q1);
      return { kind: 'arc', e, from: q0, to: q0 + dir * span, ccw: dir < 0, P0, P1 };
    };
    // an end row with no visible arc: its contour does not cross the row, so the cap shows its whole contour or nothing
    const capWhole = (r, sign) => {
      const k = contourOf(r, sign);
      if (!k || !(k.side(k.ptAt(0)) > 0)) return [];
      const P = pointOn(k.e, 0);
      return [[{ kind: 'arc', e: k.e, from: 0, to: TWO_PI, ccw: false, P0: P, P1: P }]];
    };
    const startOf = (g) => (g.kind === 'bez' ? g.p0 : g.kind === 'arc' ? g.P0 : g.pts[0]);
    // a polyline along the loop (for its winding)
    const loopPoly = (segs) => segs.flatMap(g => (g.kind === 'bez' ? [0, 0.25, 0.5, 0.75].map(u => bezAt(g, u))
      : g.kind === 'arc' ? Array.from({ length: 8 }, (_, j) => pointOn(g.e, g.from + (g.to - g.from) * j / 8)) : g.pts.slice(0, -1)));
    const loopMemo = new Map();
    const loopOf = (t0, t1) => {
      const key = t0 + ':' + t1;
      if (loopMemo.has(key)) return loopMemo.get(key);
      const i0 = main.findIndex(r => r.s.tv === t0), i1 = main.findIndex(r => r.s.tv === t1);
      // (a row whose whole ring faces the camera has no silhouette: the strips are used for that range)
      const whole = (r) => r.ring && r.ring.vis && !silOf(r);
      let loops = null;
      if (i0 >= 0 && i1 > i0 && !main.slice(i0, i1 + 1).some(whole)) {
        loops = [];
        // one loop per run of rows with a visible arc; a run's end is the cap at t = 0 / 1, else its row's visible arc
        for (let a = i0; a <= i1 && loops; ) {
          if (!silOf(main[a])) { a++; continue; }
          let b = a;
          while (b + 1 <= i1 && silOf(main[b + 1]) && !main[b].flipNext) b++;
          if (b === a) { a++; continue; }               // (a single row: no area)
          // (a point without a tangent takes the direction through its neighbors on the border)
          const border = (j) => {
            const pts = main.slice(a, b + 1).map(r => silOf(r)[j]);
            const dirOf = (k) => {
              if (pts[k].d) return pts[k];
              const P = pts[Math.max(k - 1, 0)].p, Q = pts[Math.min(k + 1, pts.length - 1)].p, dx = Q[0] - P[0], dy = Q[1] - P[1], l = Math.hypot(dx, dy);
              return { p: pts[k].p, d: l > 1e-12 ? [dx / l, dy / l] : null };
            };
            const T = pts.map((_, k) => dirOf(k));
            return T.slice(1).map((B, k) => (main[a + k].straight && main[a + k].straight[j] ? straightOf(T[k], B) : bezOf(T[k], B)));
          };
          const endB = b === n - 1 ? capArc(main[b], 1) : rowArc(main[b]), endA = a === 0 ? capArc(main[a], -1) : rowArc(main[a]);
          if (!endA || !endB) { loops = null; break; }
          loops.push([...border(0), endB, ...border(1).reverse().map(revSeg), revSeg(endA)]);
          a = b + 1;
        }
        if (loops && i0 === 0 && !silOf(main[0])) loops.push(...capWhole(main[0], -1));
        if (loops && i1 === n - 1 && !silOf(main[n - 1])) loops.push(...capWhole(main[n - 1], 1));
        // each wound anticlockwise on screen (the batching rule); a loop's area is the sum of the layers it covers, so its sign is reliable
        if (loops) loops = loops.map(segs => (area(loopPoly(segs)) > 0 ? segs.reverse().map(revSeg) : segs));
      }
      loopMemo.set(key, loops);
      return loops;
    };
    const outline = (t0, t1) => (path) => {
      const loops = loopOf(t0, t1);
      if (!loops) { stripOutline(t0, t1)(path); return; }
      loops.forEach(segs => {
        const s0 = startOf(segs[0]);
        path.moveTo(s0[0], s0[1]);
        segs.forEach(g => {
          if (g.kind === 'bez') path.bezierCurveTo(g.c1[0], g.c1[1], g.c2[0], g.c2[1], g.p1[0], g.p1[1]);
          else if (g.kind === 'arc') { path.lineTo(g.P0[0], g.P0[1]); path.ellipse(g.e.x, g.e.y, g.e.a, g.e.b, g.e.angle, g.from, g.to, g.ccw); }
          else g.pts.forEach(q => path.lineTo(q[0], q[1]));
        });
        path.closePath();
      });
    };
    const overlaps = (p, q) => {
      if (!boxesMeet(p.box, q.box)) return false;
      const within = (pt, s) => inBox(pt[0], pt[1], s.box) && inside(pt, s.poly);
      if (p.chains.some(ch => ch.some(pt => within(pt, q))) || q.chains.some(ch => ch.some(pt => within(pt, p)))) return true;
      return p.chains.some(ca => q.chains.some(cb => {
        for (let i = 0; i + 1 < ca.length; i++) for (let j = 0; j + 1 < cb.length; j++) if (segsCross(ca[i], ca[i + 1], cb[j], cb[j + 1])) return true;
        return false;
      }));
    };
    const sheets = [];
    let sheet = null;
    if (lit) strips.forEach(st => {
      if (!st.vis) { sheet = null; return; }
      // the cuts at `lo` and `hi` are soft (not contours): the strips on both sides of them paint no cover, so no line of the base tone is
      // left across the arch where the later sheet's edge meets the earlier one
      const soft = !!cuts && !!sheet && [cuts.lo, cuts.hi].some(c => rows[st.k].i === c && rows[st.k + 1].i === c + 1);
      if (soft) sheet.softEnd = true;
      // (a non-neighbor: at least 3/64 of the arch back, not 3 strips: the rows are denser where the arch points at the camera, and
      // nearly concentric rows a few strips apart overlap there without hiding anything of another tone)
      const tv = (k) => samples[rows[k].i].tv;
      const hidden = sheet && sheet.strips.some(o => tv(st.k) - tv(o.k + 1) >= 3 / 64 - 1e-9 && overlaps(st, o));
      const fold = !soft && !hidden && !!sheet && crosses(st.k);
      // (`joined`: the sheet continues the previous one across a cut that is not a contour, see the underpaint below)
      if (!sheet || soft || hidden || fold) sheets.push(sheet = { strips: [], softStart: soft, joined: !!sheet && !fold });
      sheet.strips.push(st);
    });
    const litPath = (list) => { const path = new Path2D(); list.forEach(st => st.lits.forEach(shape => trace(path, shape))); return path; };
    let out;
    if (!lit) out = [];
    else if (sheets.length <= 1) out = [{ kind: 'lit', lit: litPath(strips) }];
    else {
      // Probe points of each sheet (its visible quads' interiors, with their depth), to order two sheets where they overlap on screen;
      // each strip keeps its probes' mean depth, each sheet its box (and the box of its true projection, for the overlap test).
      sheets.forEach(sh => {
        sh.probes = [];
        sh.box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
        sh.rawBox = { ...sh.box };
        sh.strips.forEach(st => {
          const A = rows[st.k], B = rows[st.k + 1];
          let dSum = 0;
          for (let m = 1; m < PROBES; m++) {
            const f = m / PROBES, pa = scr(A, A.ring.vis[0] + (A.ring.vis[1] - A.ring.vis[0]) * f), pb = scr(B, B.ring.vis[0] + (B.ring.vis[1] - B.ring.vis[0]) * f);
            const q = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2, d: (pa.d + pb.d) / 2, st };
            sh.probes.push(q); dSum += q.d;
          }
          st.probeD = dSum / (PROBES - 1);
          [[sh.box, st.visBox], [sh.rawBox, st.box]].forEach(([b, s]) => { b.x0 = Math.min(b.x0, s.x0); b.y0 = Math.min(b.y0, s.y0); b.x1 = Math.max(b.x1, s.x1); b.y1 = Math.max(b.y1, s.y1); });
        });
        sh.depth = sh.probes.reduce((acc, q) => acc + q.d, 0) / (sh.probes.length || 1);
      });
      const idx = new Map(sheets.map((sh, i) => [sh, i])), pairKey = (P, Q) => idx.get(P) * sheets.length + idx.get(Q);
      // +1 if sheet P is in front of sheet Q where they overlap (P's probes inside Q's strips), -1 behind, 0 if they don't overlap.
      const orderMemo = new Map();
      const order = (P, Q) => {
        const key = pairKey(P, Q);
        if (orderMemo.has(key)) return orderMemo.get(key);
        let votes = 0;
        if (boxesMeet(P.box, Q.box)) P.probes.forEach(q => {
          if (!inBox(q.x, q.y, Q.box)) return;
          const st = Q.strips.find(s2 => inBox(q.x, q.y, s2.visBox) && inside([q.x, q.y], s2.visFlat));
          if (st) votes += q.d < st.probeD ? 1 : -1;
        });
        orderMemo.set(key, Math.sign(votes));
        return Math.sign(votes);
      };
      // Back to front: repeatedly take, among the sheets left, one that nothing left is behind (ties and cycles: the farthest).
      const left = sheets.slice(), sorted = [];
      const relOf = (P, Q) => order(P, Q) - order(Q, P);
      while (left.length) {
        left.sort((p, q) => q.depth - p.depth);
        const pick = left.find(P => left.every(Q => Q === P || relOf(P, Q) <= 0)) || left[0];
        sorted.push(pick); left.splice(left.indexOf(pick), 1);
      }
      // Underpaint across the cuts that are not contours (soft cuts, self-overlap cuts; rule 1): of two sheets that meet there, the one
      // painted later also fills the other's strip next to the cut, so its lit part has no edge on the cut row (two antialiased edges on
      // one line left a hairline of the base tone across the lit part); it ends one strip into the earlier sheet, over the same lit part.
      sheets.forEach((sh, i) => {
        if (!i || !sh.joined) return;
        const prev = sheets[i - 1];
        if (sorted.indexOf(sh) > sorted.indexOf(prev)) (sh.extra ||= []).push(prev.strips[prev.strips.length - 1]);
        else (prev.extra ||= []).push(sh.strips[0]);
      });
      // A sheet covers what it hides only if it overlaps a sheet painted before it: by the probes' order (`relOf`) or by the strips' own
      // overlap test (the probes, a few points inside each strip, missed a thin overlap along a junction: the big tube of the threaded
      // orange arch painted no cover over the thin tube's lit tip behind it, a lit spike beside the skew node at 2.146).
      const overlapMemo = new Map();
      const sheetsOverlap = (P, Q) => {
        const key = pairKey(P, Q);
        if (!overlapMemo.has(key)) overlapMemo.set(key, boxesMeet(P.rawBox, Q.rawBox) && P.strips.some(a => a.chains && Q.strips.some(b => b.chains && overlaps(a, b))));
        return overlapMemo.get(key);
      };
      const coversSome = (sh, p) => sorted.slice(0, p).some(Q => relOf(sh, Q) !== 0 || sheetsOverlap(sh, Q));
      out = sorted.map((sh, p) => {
        // `half`: the part the sheet is in (a skewed mesh's half drawn first paints only its own sheets and the shared band, render.js),
        // read from its first strip's start
        const i0 = rows[sh.strips[0].k].i, half = !cuts ? undefined : i0 < cuts.lo ? 0 : i0 >= cuts.hi ? 1 : 'both';
        const lit = litPath(sh.extra ? sh.strips.concat(sh.extra) : sh.strips);
        if (!coversSome(sh, p)) return { kind: 'lit', lit, half };
        const cover = new Path2D(), last = sh.strips.length - 1;
        sh.strips.forEach((st, j) => {
          if ((j === 0 && sh.softStart) || (j === last && sh.softEnd)) return;
          trace(cover, st.area < 0 ? reversed(st.vis) : st.vis);
        });
        return { kind: 'lit', lit, cover, half };
      });
    }
    if (debug.on) {
      // the border (terminator): the two ends of each ring's lit arc where they face the viewer, both sides as polylines
      [1, -1].forEach(side => {
        let run = [];
        const flush = () => { if (run.length > 1) debugItems.push({ kind: 'border', pts: run }); run = []; };
        rows.forEach(r => {
          const g = r.ring;
          if (!g || g.wL === null || g.wL === undefined) { flush(); return; }
          const phi = g.phiL + side * g.wL, p = at(r, phi), c = r.s.c;
          const nrm = Qm(r.s.Q, { x: p.x - c.x, y: p.y - c.y, z: p.z - c.z });
          if (dot(nrm, unit(sub(cp, p))) < 0) { flush(); return; }
          const q = projectPoint(p);
          run.push([q.x, q.y]);
        });
        flush();
      });
    }
    out.outline = outline;
    return out;
  };

  // A straight cone's shade borders in WORLD space, for round nodes at world centers cA, cB with radii rA, rB (tube light: lam = the light
  // without its part along the axis d; the border's radial directions r = +-(d x lam); the tangent cone's normal there n = cosT r + sinT d,
  // sinT = (rA - rB) / |cB - cA|): the two border generatrices [{ n, ends: [cA + rA n, cB + rB n] }], or [] (light along the axis).
  const tubeBorders = (cA, rA, cB, rB) => {
    const dv = sub(cB, cA), D = len(dv), sinT = (rA - rB) / D;
    if (D < 1e-12 || Math.abs(sinT) >= 1) return [];
    const cosT = Math.sqrt(1 - sinT * sinT), u = unit(dv), Lw = light.dir, k = dot(Lw, u);
    const lam = { x: Lw.x - k * u.x, y: Lw.y - k * u.y, z: Lw.z - k * u.z };
    if (len(lam) < 1e-9) return [];
    const r = unit(cross(u, unit(lam)));
    return [1, -1].map(sg => {
      const n = { x: sg * cosT * r.x + sinT * u.x, y: sg * cosT * r.y + sinT * u.y, z: sg * cosT * r.z + sinT * u.z };
      return { n, ends: [[cA, rA], [cB, rB]].map(([c, rr]) => ({ x: c.x + rr * n.x, y: c.y + rr * n.y, z: c.z + rr * n.z })) };
    });
  };

  return {
    flat,
    // A skewed arch by its mesh id, its samples (`sampleAt(t)`) and its cuts as values of t (buildArch).
    arch: (key, sampleAt, cuts) => cached('a' + key, () => buildArch(sampleAt, cuts)),
    // The pair of a 2-node mesh (or a split cone): lit as a tube, i.e. by the light's component perpendicular to the axis only, so a
    // generatrix has one tone along its whole length (the cone's border is a straight line) and a node's border is the great circle
    // n . lam = 0 (a plane parallel to the axis), which continues that line across the seam without a corner. Returns the elements
    // [sphere a, sphere b, cone] (nulls where nothing is lit).
    // (Cached by the unordered pair, so a joint disc, a split cone's two parts and a plain piece share one tube.)
    pair: (pa, pb) => {
      const swap = pa.id > pb.id, [p0, p1] = swap ? [pb, pa] : [pa, pb];
      const els = cached('p' + p0.id + ',' + p1.id, () => {
        const sa = flat(p0), sb = flat(p1), dv = sub(sb, sa), Ln = len(dv);
        if (Ln < 1e-6) return [];
        const d = { x: dv.x / Ln, y: dv.y / Ln, z: dv.z / Ln }, k = dot(L, d), perp = { x: L.x - k * d.x, y: L.y - k * d.y, z: L.z - k * d.z };
        if (len(perp) < 1e-6) return [];
        const lam = unit(perp);
        return [buildSphere(sa, lam, [sb], 'n' + p0.id), buildSphere(sb, lam, [sa], 'n' + p1.id), buildCone(sa, sb, lam, [], p0.id + '-' + p1.id)];
      });
      return swap && els.length ? [els[1], els[0], els[2]] : els;
    },
    // The tangent cone of two nodes lit by the light itself (not as a tube): a split cone's host-colored part, so the whole host
    // color has one light model and the switch to the tube is on the split ring, a color border.
    cone: (pa, pb) => cached('c' + pa.id + ',' + pb.id, () => buildCone(flat(pa), flat(pb), L, [], pa.id + '-' + pb.id + 'L')),
    // Debug: where the shade borders of a plain (straight) cone would cross a skew node's cross-section, taken as that cone's
    // cross-section, in WORLD space (fixed on the object; only the projection depends on the camera). Filled where they face the viewer.
    // A round arch passes `round`: the arch's spheres just before and after the skew node, { cA, rA, cB, rB }; the dots are the middle
    // of the two border generatrices of their tangent cone (`tubeBorders`, the same logic as `tubeBorderLines`), which as the two
    // close in is the swept body's own cross-section there, including the tilt of its normals where the radius changes (sinT).
    // A squashed arch passes `c` the center, `K` the body's form there (x^T K x = 1), `t` the arch's tangent: tube light, the border
    // normals perpendicular to t with n . lam = 0, so n = +-(t x lam), at the body points c + S n / sqrt(n^T S n), S = K^-1.
    tubeBorderDebug: (c, K, t, round = null) => {
      if (!debug.on) return;
      if (round) {
        tubeBorders(round.cA, round.rA, round.cB, round.rB).forEach(({ n, ends: [p, q] }) => {
          const m = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, z: (p.z + q.z) / 2 }, sp = projectPoint(m);
          debugItems.push({ kind: 'dot', pt: [sp.x, sp.y], visible: dot(n, sub(camPos, m)) >= 0 });
        });
        return;
      }
      const u = unit(t), Lw = light.dir, k = dot(Lw, u), lam = { x: Lw.x - k * u.x, y: Lw.y - k * u.y, z: Lw.z - k * u.z };
      if (len(lam) < 1e-9) return;
      const [a, b, cc, d, e, f, g, h, i] = K, A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, det = a * A + b * B + cc * C;
      const S = [A / det, (cc * h - b * i) / det, (b * f - cc * e) / det, B / det, (a * i - cc * g) / det, (cc * d - a * f) / det, C / det, (b * g - a * h) / det, (a * e - b * d) / det];
      const n = unit(cross(u, unit(lam)));
      [n, { x: -n.x, y: -n.y, z: -n.z }].forEach(m => {
        const x = { x: S[0] * m.x + S[1] * m.y + S[2] * m.z, y: S[3] * m.x + S[4] * m.y + S[5] * m.z, z: S[6] * m.x + S[7] * m.y + S[8] * m.z };
        const q = Math.sqrt(Math.max(dot(m, x), 1e-300)), p = { x: c.x + x.x / q, y: c.y + x.y / q, z: c.z + x.z / q }, sp = projectPoint(p);
        debugItems.push({ kind: 'dot', pt: [sp.x, sp.y], visible: dot(m, sub(camPos, p)) >= 0 });
      });
    },
    // Debug: a straight cone's shade borders in WORLD space (fixed on the object; only the projection depends on the camera), for the
    // round nodes at world centers cA, cB with radii rA, rB. Tube light as in `tubeBorderDebug`: lam = the light without its part along
    // the axis d, the border's radial directions r = +-(d x lam), and the tangent cone's normal there n = cosT r + sinT d; each border
    // generatrix runs between the two tangent circles, cA + rA n to cB + rB n. Solid where it faces the viewer at both ends.
    tubeBorderLines: (cA, rA, cB, rB) => {
      if (!debug.on) return;
      tubeBorders(cA, rA, cB, rB).forEach(({ n, ends }) => debugItems.push({
        kind: 'tubeLine', pts: ends.map(p => { const q = projectPoint(p); return [q.x, q.y]; }), visible: ends.every(p => dot(n, sub(camPos, p)) >= 0),
      }));
    },
    // Debug: the two curves along a skewed arch through its skew-node dots (tubeBorderDebug), in WORLD space from end node to end node.
    // Each keeps its dot's angle phi0 around the arch in the arch's own frame: e1 = the arch plane's normal made perpendicular to the
    // tangent t, e2 = t x e1 (the arch is planar, so this frame turns with it without twisting; nothing depends on the camera). At each
    // row the normal is n = cosT (cos phi0 e1 + sin phi0 e2) + sinT t on a round arch (sinT the radius' tilt, as in tubeBorders) and the
    // point c + r n; on a squashed arch n has no tilt and the point is c + S n / sqrt(n^T S n), S = K^-1. `rows`: { c, t (unit), r, sinT,
    // K } along the arch, `apex` the index of the skew node's row. Solid where the curve faces the viewer, dashed where it faces away.
    archBorderCurves: (rows, apex, round) => {
      if (!debug.on || rows.length < 3) return;
      const inv = (m) => {
        const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, det = a * A + b * B + c * C;
        return [A / det, (c * h - b * i) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, (c * d - a * f) / det, C / det, (b * g - a * h) / det, (a * e - b * d) / det];
      };
      const last = rows.length - 1;
      let N = cross(sub(rows[last].c, rows[0].c), sub(rows[apex].c, rows[0].c));
      if (len(N) < 1e-9) { const t0 = rows[apex].t; N = Math.abs(t0.x) < 0.9 ? cross(t0, { x: 1, y: 0, z: 0 }) : cross(t0, { x: 0, y: 1, z: 0 }); }
      N = unit(N);
      const frame = (t) => { const k = dot(N, t), e1 = unit({ x: N.x - k * t.x, y: N.y - k * t.y, z: N.z - k * t.z }); return { e1, e2: cross(t, e1) }; };
      // the dots' radial directions at the skew node (tube light there), as angles in its frame
      const u = rows[apex].t, Lw = light.dir, k = dot(Lw, u), lam = { x: Lw.x - k * u.x, y: Lw.y - k * u.y, z: Lw.z - k * u.z };
      if (len(lam) < 1e-9) return;
      const r0 = unit(cross(u, unit(lam))), f0 = frame(u);
      const phi0 = Math.atan2(dot(r0, f0.e2), dot(r0, f0.e1));
      [phi0, phi0 + Math.PI].forEach(phi => {
        const pts = rows.map(row => {
          const { e1, e2 } = frame(row.t), cs = Math.cos(phi), sn = Math.sin(phi);
          const rad = { x: cs * e1.x + sn * e2.x, y: cs * e1.y + sn * e2.y, z: cs * e1.z + sn * e2.z };
          let n, p;
          if (round) {
            const ct = Math.sqrt(Math.max(0, 1 - row.sinT * row.sinT));
            n = { x: ct * rad.x + row.sinT * row.t.x, y: ct * rad.y + row.sinT * row.t.y, z: ct * rad.z + row.sinT * row.t.z };
            p = { x: row.c.x + row.r * n.x, y: row.c.y + row.r * n.y, z: row.c.z + row.r * n.z };
          } else {
            const S = inv(row.K), x = { x: S[0] * rad.x + S[1] * rad.y + S[2] * rad.z, y: S[3] * rad.x + S[4] * rad.y + S[5] * rad.z, z: S[6] * rad.x + S[7] * rad.y + S[8] * rad.z };
            const q = Math.sqrt(Math.max(dot(rad, x), 1e-300));
            n = rad; p = { x: row.c.x + x.x / q, y: row.c.y + x.y / q, z: row.c.z + x.z / q };
          }
          const sp = projectPoint(p);
          return { pt: [sp.x, sp.y], visible: dot(n, sub(camPos, p)) >= 0 };
        });
        // runs of one visibility (neighboring runs share their end point)
        let run = [pts[0]];
        for (let i = 1; i < pts.length; i++) {
          if (pts[i].visible !== run[0].visible) { run.push(pts[i]); debugItems.push({ kind: 'tubeLine', pts: run.map(q => q.pt), visible: run[0].visible }); run = [pts[i]]; }
          else run.push(pts[i]);
        }
        if (run.length > 1) debugItems.push({ kind: 'tubeLine', pts: run.map(q => q.pt), visible: run[0].visible });
      });
    },
    // A 3+ node mesh (buildHull), by its mesh id `key` and its projected nodes `ps`.
    hull: (key, ps) => cached('h' + key, () => {
      const h = buildHull(ps.map(flat), ps.map(p => p.id));
      // Sphere i also given way to the nodes `fars` (the far ends of the split cones that start there).
      const given = new Map();
      const sphereWith = (i, fars) => {
        if (!given.has(i)) given.set(i, buildSphere(h.flats[i], L, h.partnersOf[i].concat(fars.map(flat))));
        return given.get(i);
      };
      return {
        // All the mesh's elements: its spheres, its cones, its visible faces. EVERY piece of the mesh paints all of them over its own fill:
        // a piece drawn after another (separate depth strata) covers that piece's elements with its own base tone, and would leave them
        // dark where it overlaps. `giveWay(id)`: the far nodes of the split cones at node `id` (or null); that sphere gives way to them.
        elements: (giveWay = () => null) => [...h.spheres.map((s, i) => { const fars = giveWay(ps[i].id); return fars ? sphereWith(i, fars) : s; }), ...h.cones, ...h.faces],
      };
    }),
    // The debug view of the shade borders (Debug button): per cone, in its own color, the generatrices where its lit part starts and
    // ends (solid lines) with a dot at each end on the two tangent circles; per node, dashed black, the border of its lit cap; and dotted
    // white, the border between each cone and its nodes (the visible part of the tangent circles). Where a
    // cone's dot and a node's dashed border do not meet, they compete.
    drawDebug(ctx) {
      const palette = ['#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#00acc1', '#f4511e', '#6d4c41', '#d81b60', '#7cb342'];
      const colorOf = (id) => { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return palette[h % palette.length]; };
      ctx.save();
      ctx.lineCap = 'round';
      debugItems.forEach(it => {
        if (it.kind === 'seam') {
          // white dots over a dark underlay, so they also show on a light background
          ctx.lineCap = 'butt';
          ctx.setLineDash([2 * px, 4 * px]);
          [['#000000', 3.5], ['#ffffff', 2]].forEach(([color, w]) => {
            ctx.strokeStyle = color;
            ctx.lineWidth = w * px;
            ctx.beginPath();
            it.pts.forEach((pt, i) => (i ? ctx.lineTo(pt[0], pt[1]) : ctx.moveTo(pt[0], pt[1])));
            ctx.stroke();
          });
          ctx.lineCap = 'round';
        } else if (it.kind === 'border') {
          // where an arch's shade border is meant to be: magenta over a dark underlay
          ctx.setLineDash([]);
          [['#000000', 4], ['#ff00ff', 2]].forEach(([color, w]) => {
            ctx.strokeStyle = color;
            ctx.lineWidth = w * px;
            ctx.beginPath();
            it.pts.forEach((pt, i) => (i ? ctx.lineTo(pt[0], pt[1]) : ctx.moveTo(pt[0], pt[1])));
            ctx.stroke();
          });
        } else if (it.kind === 'tubeLine') {
          // a straight cone's shade border in world space (tubeBorderLines), or an arch's curve through its skew-node dots
          // (archBorderCurves): cyan over a dark underlay, dashed where it faces away
          ctx.lineCap = 'butt';
          ctx.setLineDash(it.visible ? [] : [6 * px, 5 * px]);
          [['#000000', 4], ['#00e5ff', 2]].forEach(([color, w]) => {
            ctx.strokeStyle = color;
            ctx.lineWidth = w * px;
            ctx.beginPath();
            it.pts.forEach((pt, i) => (i ? ctx.lineTo(pt[0], pt[1]) : ctx.moveTo(pt[0], pt[1])));
            ctx.stroke();
          });
          ctx.lineCap = 'round';
        } else if (it.kind === 'dot') {
          // a straight cone's shade border on a skew node's cross-section (tubeBorderDebug): cyan, hollow where it faces away
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.arc(it.pt[0], it.pt[1], 4.5 * px, 0, TAU);
          ctx.fillStyle = '#00e5ff';
          ctx.strokeStyle = '#000000';
          ctx.lineWidth = 1.5 * px;
          if (it.visible) ctx.fill();
          ctx.stroke();
        } else if (it.kind === 'cone') {
          ctx.strokeStyle = ctx.fillStyle = colorOf(it.id);
          ctx.lineWidth = 2 * px;
          ctx.setLineDash([]);
          it.lines.forEach(([p, q]) => {
            ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
            [p, q].forEach(pt => { ctx.beginPath(); ctx.arc(pt[0], pt[1], 4 * px, 0, TAU); ctx.fill(); });
          });
        } else {
          ctx.strokeStyle = '#000000';
          ctx.lineWidth = 2 * px;
          ctx.setLineDash([5 * px, 4 * px]);
          ctx.beginPath();
          it.pts.forEach((pt, i) => (i ? ctx.lineTo(pt[0], pt[1]) : ctx.moveTo(pt[0], pt[1])));
          ctx.stroke();
        }
      });
      ctx.restore();
    },
    // The color of a piece's fill when its lit part is painted over it.
    baseColor: (color) => toneColor(color, TWILIGHT),
    // Paints the elements over the fill `path` (already filled in `baseColor(color)`), clipped to it.
    // `atop`: on a group layer that already holds the piece's base fill, composited source-atop instead of clipped to `path`
    // (a clip's antialiased edge on top of the fill's own edge blends the lit tone twice there).
    // `mask`: paints a lit mask instead (opaque where Lit, erased where a later element is Twilight), for the border strokes' tones.
    paint(ctx, path, color, elements, atop = false, mask = false) {
      ctx.save();
      if (!atop) ctx.clip(path);
      const list = [...new Set(elements)].filter(Boolean), lit = mask ? '#ffffff' : toneColor(color, LIT);
      const twilight = (g) => { if (mask) g.globalCompositeOperation = 'destination-out'; else g.fillStyle = g.strokeStyle = toneColor(color, TWILIGHT); };
      list.forEach(el => {
        ctx.save();
        el.clips?.forEach(c => ctx.clip(c.path, c.rule));
        if (el.kind === 'face') {
          if (el.tone === LIT || !mask) ctx.fillStyle = ctx.strokeStyle = mask ? lit : toneColor(color, el.tone);
          else twilight(ctx);
          ctx.lineWidth = FACE_STROKE_PX * px;
          ctx.lineJoin = 'round';
          ctx.fill(el.footprint);
          ctx.stroke(el.footprint);
        } else {
          if (el.cover) { ctx.save(); twilight(ctx); ctx.fill(el.cover); ctx.restore(); }      // an arch sheet over the ones behind it
          ctx.fillStyle = lit;
          if (el.kind === 'sphere') ctx.fill(el.lit.path, el.lit.rule); else ctx.fill(el.lit);
        }
        ctx.restore();
      });
      // The seam lines go on top of every element.
      ctx.strokeStyle = lit;
      ctx.lineWidth = SEAM_LINE_PX * px;
      ctx.lineCap = 'butt';
      list.forEach(el => { if (el.seams) ctx.stroke(el.seams); });
      ctx.restore();
    },
  };
}
