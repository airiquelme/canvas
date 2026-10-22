// Checks traceEllipseCapsule against the convex hull of densely sampled ellipse boundaries
// (max distance between the two outlines, and anticlockwise winding on screen).
// Run from a copy of the modules with a {"type":"module"} package.json (see trace.mjs).
import { traceEllipseCapsule } from '../shapes.js';
import { convexHull, ellipsePoint } from '../geometry.js';

// A recording ctx that tessellates ellipse arcs into points.
function recorder() {
  const pts = [];
  return {
    pts,
    moveTo: (x, y) => pts.push({ x, y }), lineTo: (x, y) => pts.push({ x, y }), closePath() {},
    ellipse(cx, cy, a, b, rot, t0, t1, ccw) {
      let d = t1 - t0;
      if (ccw) { while (d > 0) d -= 2 * Math.PI; while (d < -2 * Math.PI) d += 2 * Math.PI; } else { while (d < 0) d += 2 * Math.PI; }
      const n = Math.max(2, Math.ceil(Math.abs(d) / 0.002));
      for (let i = 0; i <= n; i++) {
        const t = t0 + d * i / n, x = a * Math.cos(t), y = b * Math.sin(t);
        pts.push({ x: cx + x * Math.cos(rot) - y * Math.sin(rot), y: cy + x * Math.sin(rot) + y * Math.cos(rot) });
      }
    },
  };
}
const area = (p) => p.reduce((s, q, i) => { const r = p[(i + 1) % p.length]; return s + q.x * r.y - r.x * q.y; }, 0) / 2;
const distToPoly = (q, poly) => poly.reduce((m, a, i) => {
  const b = poly[(i + 1) % poly.length], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1e-12;
  const f = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2));
  return Math.min(m, Math.hypot(q.x - a.x - dx * f, q.y - a.y - dy * f));
}, Infinity);

let worst = 0, badWind = 0, whole = 0, n = 0;
const rnd = (lo, hi) => lo + Math.random() * (hi - lo);
for (let t = 0; t < 600; t++) {
  const mk = () => ({ center: { x: rnd(0, 150), y: rnd(0, 150) }, a: rnd(5, 60), b: rnd(2, 60), angle: rnd(0, 6.28) });
  let e1 = mk(), e2 = mk();
  [e1, e2].forEach(e => { if (e.b > e.a) e.b = e.a; });
  const ctx = recorder();
  traceEllipseCapsule(ctx, e1, e2);
  const dense = [e1, e2].flatMap(e => Array.from({ length: 4000 }, (_, i) => ellipsePoint(e, i / 4000 * 2 * Math.PI)));
  const ref = convexHull(dense);
  const got = ctx.pts;
  // symmetric distance between the outlines
  const d = Math.max(...got.filter((_, i) => i % 7 === 0).map(q => distToPoly(q, ref)), ...ref.filter((_, i) => i % 7 === 0).map(q => distToPoly(q, got)));
  worst = Math.max(worst, d); n++;
  if (area(got) > 0) badWind++; // y-down screen: anticlockwise = negative shoelace area
}
console.log({ cases: n, worstOutlineGap: worst, wrongWinding: badWind });
