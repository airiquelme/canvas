// Independent check of a squashed node's screen ellipses against the 3D body: project
// points of the real spheroid / its meridian cut with the camera's own basis and compare
// with projectNode's `ellipse` (silhouette) and `cut`. Run from a copy of the modules
// (see trace.mjs).
import * as C from '../camera.js';
import * as G from '../geometry.js';
import { createNode, nodes } from '../scene.js';

const scenes = [
  ['upright (axis y)', { squash: 0.35 }],
  ['tilted (1,1,0)', { squash: 0.45, axis: { x: 1, y: 1, z: 0 } }],
  ['prolate along z', { squash: 1.8, axis: { x: 0, y: 0, z: 1 } }],
];
for (const [name, opts] of scenes) {
  const node = nodes[createNode({ x: 520, y: 380, z: 30 }, 40, opts)];
  const { shape } = node;
  console.log(name, 'cutDir', shape.cutDir);
  let minCutB = Infinity, minSilB = Infinity, worstSil = 0, worstCut = 0;
  for (let ang = 0; ang < 6.2832; ang += 0.05) {
    C.camera.orbitAngle = ang;
    const camPos = C.getCameraPosition(), basis = C.computeViewBasis(camPos, C.camera.target);
    const pn = C.makeProjector(camPos, basis).projectNode(node), k = pn.radius / node.radius;
    const toScreen = (d) => ({ x: G.vecDot(d, basis.right) * k, y: -G.vecDot(d, basis.up) * k });
    const inEllipse = (p, e) => { const ca = Math.cos(e.angle), sa = Math.sin(e.angle); return [(p.x * ca + p.y * sa) / e.a, (-p.x * sa + p.y * ca) / e.b]; };
    // silhouette: every surface sample is inside it
    for (let i = 0; i < 400; i++) {
      const n = G.vecNormalize({ x: Math.random() - .5, y: Math.random() - .5, z: Math.random() - .5 });
      const [u, v] = inEllipse(toScreen(G.vecSub(G.supportPoint(node, n), node.center)), pn.ellipse);
      worstSil = Math.max(worstSil, Math.hypot(u, v) - 1);
    }
    // cut: points of the 3D meridian ellipse lie ON the projected cut ellipse (when it has area)
    const third = G.vecCross(shape.axis, shape.cutDir);
    for (let i = 0; i < 64 && pn.cut.b > 1e-3 * pn.cut.a; i++) {
      const t = Math.random() * 6.2832;
      const d = { x: shape.ra * Math.cos(t) * shape.axis.x + shape.rp * Math.sin(t) * shape.cutDir.x, y: shape.ra * Math.cos(t) * shape.axis.y + shape.rp * Math.sin(t) * shape.cutDir.y, z: shape.ra * Math.cos(t) * shape.axis.z + shape.rp * Math.sin(t) * shape.cutDir.z };
      const [u, v] = inEllipse(toScreen(d), pn.cut);
      worstCut = Math.max(worstCut, Math.abs(Math.hypot(u, v) - 1));
    }
    if (Math.abs(G.vecDot(third, third) - 1) > 1e-9) throw new Error('axis and cutDir are not perpendicular unit vectors');
    minCutB = Math.min(minCutB, pn.cut.b); minSilB = Math.min(minSilB, pn.ellipse.b);
  }
  console.log('  silhouette: worst overshoot', worstSil.toExponential(1), ' min b', minSilB.toFixed(2),
    '| cut: worst off-ellipse', worstCut.toExponential(1), ' min b', minCutB.toFixed(3));
}
