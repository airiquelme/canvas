// Numeric checks of the spheroid helpers (geometry.js). The repo has no package.json,
// so run it from a copy of the modules that has {"type":"module"} (as trace.mjs does).
import * as G from '../geometry.js';
const norm = (v) => G.vecNormalize(v);
let worst = { surface: 0, support: 0, shadow: 0 };
for (let t = 0; t < 2000; t++) {
  const r = () => Math.random() * 2 - 1;
  const axis = norm({ x: r(), y: r(), z: r() }), squash = 0.3 + Math.random() * 2;
  const node = { center: { x: r() * 5, y: r() * 5, z: r() * 5 }, shape: G.makeShape(1 + Math.random() * 3, squash, axis) };
  const n = norm({ x: r(), y: r(), z: r() }), { shape } = node;
  // support point lies on the surface: ((p-c).a / ra)^2 + (|p-c|^2 - ((p-c).a)^2) / rp^2 = 1
  const p = G.supportPoint(node, n), d = G.vecSub(p, node.center), da = G.vecDot(d, shape.axis);
  worst.surface = Math.max(worst.surface, Math.abs((da / shape.ra) ** 2 + (G.vecDot(d, d) - da * da) / shape.rp ** 2 - 1));
  // h(n) = n . support point
  worst.support = Math.max(worst.support, Math.abs(G.supportH(node, n) - G.vecDot(p, n)));
  // shadow: support of the 2D ellipse in direction (cos, sin) equals the 3D support in that plane direction
  const right = norm({ x: r(), y: r(), z: r() }), up = norm(G.vecCross(right, { x: r(), y: r(), z: r() }));
  const e = G.shadowEllipse(shape, right, up), th = Math.random() * 6.283, c = Math.cos(th), s = Math.sin(th);
  const dir = { x: right.x * c + up.x * s, y: right.y * c + up.y * s, z: right.z * c + up.z * s };
  const h3 = Math.sqrt(G.shapeForm(shape, dir, dir));
  const u = c * Math.cos(e.angle) + s * Math.sin(e.angle), v = -c * Math.sin(e.angle) + s * Math.cos(e.angle);
  worst.shadow = Math.max(worst.shadow, Math.abs(Math.sqrt((e.a * u) ** 2 + (e.b * v) ** 2) - h3));
}
console.log(worst);
