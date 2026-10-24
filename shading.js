// The light engine's 2D side (CLAUDE.md "Light engine"): the lit part of a piece, painted over its fill.
//
// One directional world light (parallel rays) and two tones, Lit and Twilight: a surface is Lit when its normal faces the light
// (n . L >= 0), so one half of every sphere or cone gets light and the other half does not. A piece is filled in Twilight
// (`baseColor`) and the lit parts of its *elements* are painted over it in the mesh color. Everything is computed in a per-frame
// orthographic "flat solid" (screen x, y (y down), z = -depth * zoom toward the viewer, each node a sphere of its projected
// radius), so the terminators meet the drawn silhouettes. An element is a sphere (the lit cap `n . l >= 0`: a great circle, which
// projects to an ellipse through the node's center, closed by the rim arc), a cone (the lit generatrices, straight lines) or a
// face (a flat triangle of a 3+ node mesh, wholly one tone).
import { light, debug } from './config.js';
import { camera } from './camera.js';
import { TWILIGHT, LIT, toneColor } from './light.js';

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

export function makeShading({ basis, tol, px, camPos, projectPoint }) {
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

  // A skewed arch (CLAUDE.md "Skewed meshes"), lit in WORLD space: `samples` are { c, Q } along the arch (the center and the body's
  // quadratic form x^T Q x = 1, row-major 3x3). The swept body's surface is the envelope of the ellipsoids: its point with the unit
  // normal n (n perpendicular to the arch's tangent t) is c + S n / sqrt(n^T S n), S = Q^-1. So per sample the normals are a circle,
  // n(phi) = cos(phi) e1 + sin(phi) e2, and n . L >= 0 is EXACTLY one arc of phi (centered on the light's direction in that plane) and
  // n . v >= 0 (facing the viewer) another: the lit visible surface of a sample is the intersection of the two arcs, whose ends are
  // the terminator (a point of the border, independent of the camera) or the silhouette. Consecutive samples' arcs, cut into the same
  // number of steps, are joined into quads in ONE path (no antialiasing seam between them). The two ends are capped the same way, on
  // rings n = cos(a) n(phi) + sin(a) out (a from 0 to the pole), whose arcs are cos(phi - phiL) >= -tan(a) (out . L) / |L_e|.
  const buildArch = (samples) => {
    const n = samples.length, Lw = light.dir, cp = camPos;
    const M = 5, RINGS = 10, ARCH_SEAM_PX = 1.5;
    const TWO_PI = 2 * Math.PI;
    const inv3 = (m) => {
      const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, det = a * A + b * B + c * C;
      return [A / det, (c * h - b * i) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, (c * d - a * f) / det, C / det, (b * g - a * h) / det, (a * e - b * d) / det];
    };
    const Qm = (Q, v) => ({ x: Q[0] * v.x + Q[1] * v.y + Q[2] * v.z, y: Q[3] * v.x + Q[4] * v.y + Q[5] * v.z, z: Q[6] * v.x + Q[7] * v.y + Q[8] * v.z });
    const wrap = (x) => { x = (x + Math.PI) % TWO_PI; if (x < 0) x += TWO_PI; return x - Math.PI; };
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
    // the arch's tangent and a frame (e1, e2) perpendicular to it that turns with the arch (e1 from the plane's normal)
    const tans = samples.map((s, i) => unit(sub(samples[Math.min(i + 1, n - 1)].c, samples[Math.max(i - 1, 0)].c)));
    let r0 = cross(sub(samples[n - 1].c, samples[0].c), sub(samples[n >> 1].c, samples[0].c));
    if (len(r0) < 1e-9) { const ch = tans[0]; r0 = Math.abs(ch.x) < 0.9 ? cross(ch, { x: 1, y: 0, z: 0 }) : cross(ch, { x: 0, y: 1, z: 0 }); }
    r0 = unit(r0);
    const S = samples.map(s => inv3(s.Q));
    const frames = samples.map((s, i) => {
      const t = tans[i], k = dot(r0, t);
      const e1 = unit({ x: r0.x - k * t.x, y: r0.y - k * t.y, z: r0.z - k * t.z }), e2 = cross(t, e1);
      return { e1, e2, t };
    });
    // the ring a (a = 0: the tube itself) of sample i, facing `sign` of its tangent: arcs of phi, plus the terminator's phi (+ and -)
    const ring = (i, a, sign) => {
      const { e1, e2, t } = frames[i], c = samples[i].c, v = unit(sub(cp, c));
      const hL = Math.hypot(dot(Lw, e1), dot(Lw, e2)), hV = Math.hypot(dot(v, e1), dot(v, e2));
      if (hL < 1e-9 || hV < 1e-9) return null;
      const ta = Math.tan(a), phiL = Math.atan2(dot(Lw, e2), dot(Lw, e1)), phiV = Math.atan2(dot(v, e2), dot(v, e1));
      const wL = halfWidth(ta * sign * dot(Lw, t) / hL), wV = halfWidth(ta * sign * dot(v, t) / hV);
      if (wL === null || wV === null) return { arcs: [], phiL, wL };
      const arcs = meet(phiL, wL, phiV, wV).map(([lo, hi]) => [phiL + lo, phiL + hi]);
      return { arcs, phiL, wL, phiV, wV };
    };
    const at = (i, a, sign, phi) => {
      const { e1, e2, t } = frames[i], ca = Math.cos(a), sa = Math.sin(a) * sign;
      const nv = { x: ca * (Math.cos(phi) * e1.x + Math.sin(phi) * e2.x) + sa * t.x, y: ca * (Math.cos(phi) * e1.y + Math.sin(phi) * e2.y) + sa * t.y, z: ca * (Math.cos(phi) * e1.z + Math.sin(phi) * e2.z) + sa * t.z };
      const x = Qm(S[i], nv), k = Math.sqrt(Math.max(dot(nv, x), 1e-300)), c = samples[i].c;
      return { x: c.x + x.x / k, y: c.y + x.y / k, z: c.z + x.z / k };
    };
    const rows = [];       // rings in order along the surface: cap 0 (pole first), the samples, cap 1
    for (let k = RINGS - 1; k >= 1; k--) rows.push({ i: 0, a: (Math.PI / 2) * (k - 0.25) / RINGS, sign: -1 });
    for (let i = 0; i < n; i++) rows.push({ i, a: 0, sign: 1 });
    for (let k = 1; k < RINGS; k++) rows.push({ i: n - 1, a: (Math.PI / 2) * (k - 0.25) / RINGS, sign: 1 });
    rows.forEach(r => { r.ring = ring(r.i, r.a, r.sign); });
    // An end of an arc that is the silhouette (not the terminator) is pushed out ARCH_SEAM_PX on screen: the drawn outline and the 3D
    // silhouette differ by about a pixel, and a lit part that falls short leaves a thin line of the base tone along the edge (the
    // part past the outline is cut off by the fill). The terminator ends stay where they are.
    const csc = samples.map(s => projectPoint(s.c));
    const pts = (r, arc) => {
      const out = [], g = r.ring;
      const isTerm = (phi) => Math.abs(wrap(phi - (g.phiL + g.wL))) < 1e-6 || Math.abs(wrap(phi - (g.phiL - g.wL))) < 1e-6;
      for (let s = 0; s <= M; s++) {
        const phi = arc[0] + (arc[1] - arc[0]) * s / M, p = projectPoint(at(r.i, r.a, r.sign, phi));
        let x = p.x, y = p.y;
        if ((s === 0 || s === M) && !isTerm(s === 0 ? arc[0] : arc[1])) {
          const c = csc[r.i], dx = x - c.x, dy = y - c.y, l = Math.hypot(dx, dy) || 1;
          x += dx / l * ARCH_SEAM_PX * px; y += dy / l * ARCH_SEAM_PX * px;
        }
        out.push([x, y]);
      }
      return out;
    };
    const area = (ps) => ps.reduce((acc, p, i) => { const q = ps[(i + 1) % ps.length]; return acc + p[0] * q[1] - q[0] * p[1]; }, 0);
    const path = new Path2D();
    for (let k = 0; k + 1 < rows.length; k++) {
      const A = rows[k].ring, B = rows[k + 1].ring;
      if (!A || !B || A.arcs.length !== B.arcs.length) continue;
      A.arcs.forEach((arcA, j) => {
        // two rows whose lit arcs are on different sides of the body (the lit and the visible arcs are almost opposite, so their small overlap
        // jumps from one end to the other) are not joined: the strip would cross the whole body
        const arcB = B.arcs[j];
        if (Math.abs(wrap((arcA[0] + arcA[1] - arcB[0] - arcB[1]) / 2)) > 1) return;
        const poly = pts(rows[k], arcA).concat(pts(rows[k + 1], B.arcs[j]).reverse());
        path.addPath(polygon(area(poly) < 0 ? poly.reverse() : poly));
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
          const phi = g.phiL + side * g.wL, p = at(r.i, r.a, r.sign, phi), c = samples[r.i].c;
          const nrm = Qm(samples[r.i].Q, { x: p.x - c.x, y: p.y - c.y, z: p.z - c.z });
          if (dot(nrm, unit(sub(cp, p))) < 0) { flush(); return; }
          const q = projectPoint(p);
          run.push([q.x, q.y]);
        });
        flush();
      });
    }
    return [{ kind: 'lit', lit: path }];
  };

  return {
    flat,
    // A skewed arch by its mesh id and its world samples (buildArch).
    arch: (key, samples) => cached('a' + key, () => buildArch(samples)),
    // The pair of a 2-node mesh (or a split cone): lit as a tube, i.e. by the light's component perpendicular to the axis only, so a
    // generatrix has one tone along its whole length (the cone's border is a straight line) and a node's border is the great circle
    // n . lam = 0 (a plane parallel to the axis), which continues that line across the seam without a corner. Returns the elements
    // [sphere a, sphere b, cone] (nulls where nothing is lit).
    pair: (pa, pb) => cached('p' + pa.id + ',' + pb.id, () => {
      const sa = flat(pa), sb = flat(pb), dv = sub(sb, sa), Ln = len(dv);
      if (Ln < 1e-6) return [];
      const d = { x: dv.x / Ln, y: dv.y / Ln, z: dv.z / Ln }, k = dot(L, d), perp = { x: L.x - k * d.x, y: L.y - k * d.y, z: L.z - k * d.z };
      if (len(perp) < 1e-6) return [];
      const lam = unit(perp);
      return [buildSphere(sa, lam, [sb], 'n' + pa.id), buildSphere(sb, lam, [sa], 'n' + pb.id), buildCone(sa, sb, lam, [], pa.id + '-' + pb.id)];
    }),
    // A 3+ node mesh (buildHull), by its mesh id `key` and its projected nodes `ps`.
    hull: (key, ps) => cached('h' + key, () => {
      const h = buildHull(ps.map(flat), ps.map(p => p.id));
      return {
        // All the mesh's elements: its spheres (but those of the node ids `skip` says), its cones, its visible faces. EVERY piece of the
        // mesh paints all of them over its own fill: a piece drawn after another (separate depth strata) covers that piece's cone with its
        // own base tone, and would leave it dark where it overlaps.
        elements: (skip = () => false) => [...h.spheres.filter((s, i) => !skip(ps[i].id)), ...h.cones, ...h.faces],
        // Node `p`'s sphere, also given way to the node `far` (a split cone starts there).
        sphereWith: (p, far) => { const i = ps.findIndex(q => q.id === p.id); return buildSphere(h.flats[i], L, h.partnersOf[i].concat(flat(far))); },
      };
    }),
    // A sphere lit by the light itself, with no partners (a joint's disc).
    free: (p) => cached('s' + p.id, () => buildSphere(flat(p), L, [])),
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
    paint(ctx, path, color, elements, atop = false) {
      ctx.save();
      if (!atop) ctx.clip(path);
      const list = [...new Set(elements)].filter(Boolean), lit = toneColor(color, LIT);
      list.forEach(el => {
        ctx.save();
        el.clips?.forEach(c => ctx.clip(c.path, c.rule));
        if (el.kind === 'face') {
          ctx.fillStyle = ctx.strokeStyle = toneColor(color, el.tone);
          ctx.lineWidth = FACE_STROKE_PX * px;
          ctx.lineJoin = 'round';
          ctx.fill(el.footprint);
          ctx.stroke(el.footprint);
        } else {
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
