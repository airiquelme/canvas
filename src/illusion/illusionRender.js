// The illusion renderer (`optical-illusion` branch, the default scene): every object is rebuilt each frame
// as flat shapes that only have to look right from the camera (shape.js), not a 3D body sorted by depth.
// Objects are 2-node meshes: capsules (capsule.js) or tubes bent through a point (curve.js), drawn back to front by the
// mean depth of their points. Borders (each side stroked in its own color) only with the Strokes button.
import { debug, strokes, DESIGN_WIDTH, DESIGN_HEIGHT } from '../config.js';
import { camera, getCameraPosition, computeViewBasis, worldToCamera, makeProjector } from '../core/camera.js';
import { applyDesignSpaceTransform } from '../core/canvas.js';
import { drawShape } from './shape.js';
import { capsuleSides } from './capsule.js';
import { curvedSides } from './curve.js';
import { buildWorld } from './world.js';

// One color per side (capsule: end arc 2, line, end arc 1, line), distinct from every fill.
// 5th: a curved mesh's tip; 6th on: the further stretches a fold splits a curved mesh's sides into.
const SIDE_COLORS = ['#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#00acc1', '#d81b60', '#6d4c41', '#c0ca33', '#3949ab'];

// The scene's objects: { a: { c, r }, b: { c, r }, bend?, fill, move? } (world.js).
export const objects = [];

// ?scene=pairs: the first sanity check, three pairs around (500, 400, 0), the purple one bent around the blue one.
export function buildPairsScene() {
  objects.length = 0;
  const P = (x, y, z, r) => ({ c: { x: 500 + x, y: 400 + y, z }, r });
  objects.push({ a: P(-130, 20, -60, 42), b: P(110, 70, 90, 24), fill: '#ffe08a' });
  objects.push({ a: P(30, -120, 130, 30), b: P(-20, 130, -120, 48), fill: '#b9e6ff' });
  // Bent around the blue pair (at least 31 units clear of it along the whole curve).
  objects.push({ a: P(-60, -60, 160, 20), b: P(160, -90, -40, 20), fill: '#e2c6ff', bend: P(-30, -75, -30, 0).c });
}

// The default: the stress world (world.js), sized by the panel's sliders.
export function buildWorldScene(opts) {
  objects.length = 0;
  objects.push(...buildWorld(opts));
}

const NEAR = 1;
const MIN_PX = 0.35;   // a shape whose screen box is smaller than this is not drawn

// Draws one frame at time t (seconds, for the movers); returns its stats.
export function renderIllusion(ctx, canvas, { darkMode = false, time = 0 } = {}) {
  const t0 = performance.now();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = darkMode ? '#000000' : '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  applyDesignSpaceTransform(ctx, canvas);
  // The visible part of the design space (the canvas may be wider or taller than its aspect).
  const fit = Math.min(canvas.width / DESIGN_WIDTH, canvas.height / DESIGN_HEIGHT);
  const hw = canvas.width / 2 / fit, hh = canvas.height / 2 / fit;
  const view = { x0: DESIGN_WIDTH / 2 - hw, x1: DESIGN_WIDTH / 2 + hw, y0: DESIGN_HEIGHT / 2 - hh, y1: DESIGN_HEIGHT / 2 + hh };

  for (const o of objects) if (o.move) o.move(time);

  const camPos = getCameraPosition(), basis = computeViewBasis(camPos, camera.target);
  const projector = makeProjector(camPos, basis), { projectPoint } = projector;
  const depthOf = (p) => worldToCamera(p, camPos, basis).z;

  const stats = { objects: objects.length, drawn: 0, curved: 0, culled: 0, behind: 0, tiny: 0, buildMs: 0, drawMs: 0, curvedMs: 0 };
  const shapes = [];
  for (const o of objects) {
    // Points that bound the body: the two ends, and for a bent tube the parallelogram A, B, A + V, B + V that holds its
    // half-ellipse (V = bend - midpoint of A, B).
    let pts;
    if (o.bend) {
      const A = o.a.c, B = o.b.c, S = o.bend;
      const V = { x: S.x - (A.x + B.x) / 2, y: S.y - (A.y + B.y) / 2, z: S.z - (A.z + B.z) / 2 };
      pts = [A, B, { x: A.x + V.x, y: A.y + V.y, z: A.z + V.z }, { x: B.x + V.x, y: B.y + V.y, z: B.z + V.z }];
    } else pts = [o.a.c, o.b.c];
    const rMax = Math.max(o.a.r, o.b.r);
    let depthSum = 0, ok = true;
    for (const p of pts) { const z = depthOf(p); if (!(z > NEAR + rMax)) { ok = false; break; } depthSum += z; }
    if (!ok) { stats.behind++; continue; }   // reaches the eye's plane: not drawn (no near clip yet)
    // Screen box: each point's projection widened by the radius there.
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of pts) {
      const q = projectPoint(p), w = rMax * q.scale;
      x0 = Math.min(x0, q.x - w); x1 = Math.max(x1, q.x + w); y0 = Math.min(y0, q.y - w); y1 = Math.max(y1, q.y + w);
    }
    if (x1 < view.x0 || x0 > view.x1 || y1 < view.y0 || y0 > view.y1) { stats.culled++; continue; }
    const size = Math.hypot(x1 - x0, y1 - y0);
    if (size < MIN_PX) { stats.tiny++; continue; }
    shapes.push({ o, size, depth: depthSum / pts.length });
  }
  shapes.sort((p, q) => q.depth - p.depth);

  for (const s of shapes) {
    const o = s.o;
    let sides;
    if (o.bend) {
      // Detail by screen size: the visibility samples (cost ~ n^2) scale with the box's diagonal.
      const tc = performance.now();
      const nSide = Math.max(8, Math.min(256, Math.round(s.size / 2))), nCap = Math.max(8, Math.min(64, Math.round(s.size / 6)));
      sides = curvedSides(o.a.c, o.bend, o.b.c, o.a.r, o.b.r, projector, { nSide, nCap }).sides;
      stats.curvedMs += performance.now() - tc;
      stats.curved++;
    } else {
      const p = projectPoint(o.a.c), q = projectPoint(o.b.c);
      sides = capsuleSides({ x: p.x, y: p.y, r: o.a.r * p.scale }, { x: q.x, y: q.y, r: o.b.r * q.scale });
    }
    if (sides.length) s.shape = { sides, fill: o.fill, colors: SIDE_COLORS };
  }
  const t1 = performance.now();
  for (const s of shapes) if (s.shape) { drawShape(ctx, s.shape, { stroke: strokes.on }); stats.drawn++; }
  const t2 = performance.now();
  stats.buildMs = t1 - t0; stats.drawMs = t2 - t1;

  if (debug.on) {   // node centers
    ctx.fillStyle = darkMode ? '#ffffff' : '#000000';
    for (const s of shapes) for (const p of [s.o.a.c, s.o.b.c]) { const q = projectPoint(p); ctx.beginPath(); ctx.arc(q.x, q.y, 2, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.restore();
  return stats;
}
