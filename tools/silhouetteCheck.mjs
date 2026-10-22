// The drawn silhouette uses the same slanted (linearized) view as the debug cut. For nodes at
// several places over a full orbit: (1) the cut lies inside the silhouette, (2) the silhouette's
// extent in 72 directions vs the true perspective outline of the spheroid (projectPoint of
// surface samples), and the same for the old flat-basis silhouette. Run from a copy of the
// modules (see trace.mjs).
import * as C from '../camera.js';
import * as G from '../geometry.js';
import { createNode, nodes } from '../scene.js';

const spots = { 'view center': { x: 500, y: 400, z: 0 }, 'bottom row': { x: 395, y: 225, z: 0 }, 'top row': { x: 395, y: 575, z: 0 }, 'far left': { x: 250, y: 300, z: 0 } };
for (const [name, p] of Object.entries(spots)) {
  const node = nodes[createNode(p, 26, { squash: 0.35 })], { shape } = node;
  let cutOut = 0, gapNew = 0, gapFlat = 0;
  for (let ang = 0; ang < 6.2832; ang += 0.1) {
    C.camera.orbitAngle = ang;
    const camPos = C.getCameraPosition(), basis = C.computeViewBasis(camPos, C.camera.target);
    const { projectPoint, projectNode } = C.makeProjector(camPos, basis);
    const pn = projectNode(node), c0 = projectPoint(node.center), sc = pn.radius / node.radius;
    const sil = pn.ellipse, flat = G.shadowEllipse(shape, basis.right, basis.up);
    // (1) cut inside the silhouette (the cut's own tessellated points, in screen px)
    for (let i = 0; i < 90; i++) {
      const t = i / 90 * 6.2832, A = pn.cut.A, B = pn.cut.B;
      const q = { x: A.x * Math.cos(t) + B.x * Math.sin(t), y: A.y * Math.cos(t) + B.y * Math.sin(t) };
      const ca = Math.cos(sil.angle), sa = Math.sin(sil.angle);
      const r = Math.hypot((q.x * ca + q.y * sa) / sil.a, (-q.x * sa + q.y * ca) / sil.b);
      cutOut = Math.max(cutOut, (r - 1) * Math.hypot(q.x, q.y));
    }
    // (2) support extents vs the true perspective outline
    const pts = [];
    for (let i = 0; i < 6000; i++) {
      const n = G.vecNormalize({ x: Math.random() - .5, y: Math.random() - .5, z: Math.random() - .5 });
      const q = projectPoint(G.supportPoint(node, n));
      pts.push({ x: q.x - c0.x, y: q.y - c0.y });
    }
    for (let k = 0; k < 72; k++) {
      const th = k / 72 * 6.2832, n = { x: Math.cos(th), y: Math.sin(th) };
      const truth = Math.max(...pts.map(q => q.x * n.x + q.y * n.y));
      const ext = (a, b, angle) => Math.sqrt((a * Math.cos(th - angle)) ** 2 + (b * Math.sin(th - angle)) ** 2);
      gapNew = Math.max(gapNew, Math.abs(ext(sil.a, sil.b, sil.angle) - truth));
      gapFlat = Math.max(gapFlat, Math.abs(ext(flat.a * sc, flat.b * sc, -flat.angle) - truth));
    }
  }
  console.log(name.padEnd(12), 'cut outside silhouette by', Math.max(cutOut, 0).toExponential(1), 'px | silhouette vs true perspective: new', gapNew.toFixed(2), 'px, flat', gapFlat.toFixed(2), 'px');
}
