// A 2-node mesh as one shape: the hull of its two nodes' screen circles, i.e. two tangent lines and an
// arc of each node closing its end. Built for the current view only, not a 3D body.
import { line, arc } from './shape.js';

// c1, c2: screen circles { x, y, r }. Returns the sides, in order: end arc of node 2, line back to node 1,
// end arc of node 1, line to node 2 (4 sides), or the bigger circle alone (1 side) when one contains the other.
export function capsuleSides(c1, c2) {
  const dx = c2.x - c1.x, dy = c2.y - c1.y, d = Math.hypot(dx, dy);
  const ellipseOf = (c) => ({ x: c.x, y: c.y, a: c.r, b: c.r, angle: 0 });
  if (d <= Math.abs(c1.r - c2.r) + 1e-9) {
    const big = c1.r >= c2.r ? c1 : c2;
    return [arc(ellipseOf(big), 0, Math.PI * 2)];
  }
  // An outer tangent's normal n has n . (c2 - c1) = r1 - r2: angle phi +- A from the axis direction phi.
  const phi = Math.atan2(dy, dx), A = Math.acos((c1.r - c2.r) / d);
  const at = (c, t) => ({ x: c.x + c.r * Math.cos(t), y: c.y + c.r * Math.sin(t) });
  const e1 = ellipseOf(c1), e2 = ellipseOf(c2);
  return [
    arc(e2, phi - A, phi + A),                       // node 2's end: the normals facing away from node 1
    line(at(c2, phi + A), at(c1, phi + A)),
    arc(e1, phi + A, phi - A + Math.PI * 2),         // node 1's end
    line(at(c1, phi - A), at(c2, phi - A)),
  ];
}
