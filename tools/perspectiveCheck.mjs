// The debug cut follows the perspective: compare, for nodes at several places, the true
// perspective image of the 3D meridian ellipse (projectPoint, relative to the projected center)
// with projectNode's `cut` and with the old flat cut (plain camera basis). Run from a copy of
// the modules (see trace.mjs).
import * as C from '../camera.js';
import * as G from '../geometry.js';
import { createNode, nodes } from '../scene.js';

const spots = { 'view center': { x: 500, y: 400, z: 0 }, 'bottom row': { x: 395, y: 225, z: 0 }, 'top row': { x: 395, y: 575, z: 0 }, 'far left': { x: 250, y: 300, z: 0 } };
for (const [name, p] of Object.entries(spots)) {
  const node = nodes[createNode(p, 26, { squash: 0.35 })], { shape } = node;
  let flatGap = 0, persGap = 0, minB = Infinity, maxB = 0, angAtMin = 0;
  for (let ang = 0; ang < 6.2832; ang += 0.04) {
    C.camera.orbitAngle = ang;
    const camPos = C.getCameraPosition(), basis = C.computeViewBasis(camPos, C.camera.target);
    const { projectPoint, projectNode } = C.makeProjector(camPos, basis);
    const pn = projectNode(node), c0 = projectPoint(node.center);
    const flat = G.cutEllipse(shape, basis.right, basis.up), sc = pn.radius / node.radius;
    const off = (e, q, flip) => { // normalized radial distance of screen offset q from ellipse e (angle in screen frame)
      const ang2 = flip ? -e.angle : e.angle, ca = Math.cos(ang2), sa = Math.sin(ang2);
      return Math.hypot((q.x * ca + q.y * sa) / (e.a * sc), (-q.x * sa + q.y * ca) / Math.max(e.b * sc, 1e-9));
    };
    for (let i = 0; i < 48; i++) {
      const t = i / 48 * 6.2832;
      const q3 = { x: node.center.x + shape.ra * Math.cos(t) * shape.axis.x + shape.rp * Math.sin(t) * shape.cutDir.x, y: node.center.y + shape.ra * Math.cos(t) * shape.axis.y + shape.rp * Math.sin(t) * shape.cutDir.y, z: node.center.z + shape.ra * Math.cos(t) * shape.axis.z + shape.rp * Math.sin(t) * shape.cutDir.z };
      const q = projectPoint(q3), d = { x: q.x - c0.x, y: q.y - c0.y };
      // gap in px: how far the point is from the ellipse along its own direction
      const r1 = Math.abs(off({ a: pn.cut.a / sc, b: pn.cut.b / sc, angle: pn.cut.angle }, d, false) - 1) * Math.hypot(d.x, d.y);
      const r2 = Math.abs(off({ a: flat.a, b: flat.b, angle: flat.angle }, d, true) - 1) * Math.hypot(d.x, d.y);
      if (pn.cut.b > 0.05 * pn.cut.a) { persGap = Math.max(persGap, r1); flatGap = Math.max(flatGap, r2); }
    }
    if (pn.cut.b < minB) { minB = pn.cut.b; angAtMin = ang; }
    maxB = Math.max(maxB, pn.cut.b);
  }
  console.log(name.padEnd(12), 'gap to true perspective: new cut', persGap.toFixed(2), 'px | flat cut', flatGap.toFixed(2),
    'px | cut b range', minB.toFixed(2), '..', maxB.toFixed(2), '(min at', angAtMin.toFixed(2) + ')');
}
