// The illusion renderer (`optical-illusion` branch, the default scene): every object is rebuilt each frame
// as flat shapes that only have to look right from the camera (shape.js), not a 3D body sorted by depth.
// Objects are 2-node meshes: capsules (capsule.js) or tubes bent through a point (curve.js), and sheets (sheet.js: panels, discs,
// ribbons, two-sided), drawn back to front by the mean depth of their points. Borders (each side stroked in its own color) only with the Strokes button.
import { debug, strokes, DESIGN_WIDTH, DESIGN_HEIGHT } from '../config.js';
import { camera, getCameraPosition, computeViewBasis, worldToCamera, makeProjector } from '../core/camera.js';
import { applyDesignSpaceTransform } from '../core/canvas.js';
import { drawShape } from './shape.js';
import { capsuleSides } from './capsule.js';
import { curvedSides, curveChainSides } from './curve.js';
import { buildWorld } from './world.js';
import { boundPoints, boundRadius, buildBVH, makeFrustum, sphereBox, makeMask, maskHides, maskAddCapsule, maskAddTube, maskAddConvex, Heap } from './cull.js';
import { sheetPieces, panelPolygon, backOf } from './sheet.js';

// One color per side (capsule: end arc 2, line, end arc 1, line), distinct from every fill.
// 5th: a curved mesh's tip; 6th on: the further stretches a fold splits a curved mesh's sides into.
const SIDE_COLORS = ['#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#00acc1', '#d81b60', '#6d4c41', '#c0ca33', '#3949ab'];

// The scene's objects: { a: { c, r }, b: { c, r }, bend?, fill, move? } (world.js), or sheets ({ kind, ... }, sheet.js).
export const objects = [];

// ?scene=pairs: the first sanity check, three pairs around (500, 400, 0), the purple one bent around the blue one.
export function buildPairsScene() {
  objects.length = 0;
  skipped = 0;
  const P = (x, y, z, r) => ({ c: { x: 500 + x, y: 400 + y, z }, r });
  objects.push({ a: P(-130, 20, -60, 42), b: P(110, 70, 90, 24), fill: '#ffe08a' });
  objects.push({ a: P(30, -120, 130, 30), b: P(-20, 130, -120, 48), fill: '#b9e6ff' });
  // Bent around the blue pair (at least 31 units clear of it along the whole curve).
  objects.push({ a: P(-60, -60, 160, 20), b: P(160, -90, -40, 20), fill: '#e2c6ff', bend: P(-30, -75, -30, 0).c });
  tree = null;
}

// ?scene=sheets: one of each sheet (sheet.js) around (500, 400, 0): a sheet of paper, a card with rounded corners, a disc, a hoop
// ribbon, a ribbon tilted across its arch (it shows both faces), and a lock of hair (strands tapering to a tip).
export function buildSheetsScene() {
  objects.length = 0;
  skipped = 0;
  const P = (x, y, z) => ({ x: 500 + x, y: 400 + y, z });
  const V = (x, y, z) => ({ x, y, z });
  const S = (o) => objects.push({ back: backOf(o.fill), ...o });
  S({ kind: 'panel', c: P(-170, 90, -40), e1: V(70, 10, 20), e2: V(-8, 20, 90), round: 0, fill: '#fafafa' });
  S({ kind: 'panel', c: P(150, 110, 30), e1: V(60, 0, -30), e2: V(0, 45, 0), round: 0.4, fill: '#ffe0b2' });
  S({ kind: 'disc', c: P(-10, 160, -60), e1: V(55, 0, 0), e2: V(0, 25, 48), fill: '#b2dfdb' });
  S({ kind: 'ribbon', a: { c: P(-120, -80, 40), r: 18 }, b: { c: P(80, -80, 40), r: 18 }, bend: P(-20, -80, 160), dir: V(0, 1, 0), fill: '#ffcdd2' });
  S({ kind: 'ribbon', a: { c: P(-60, -10, -120), r: 22 }, b: { c: P(140, -40, -60), r: 12 }, bend: P(60, 70, -110), dir: V(0.6, 0.2, 0.77), fill: '#d1c4e9' });
  for (let k = 0; k < 7; k++) {   // a lock of hair from one point, fanning out and falling
    const a = (k - 3) * 0.16;
    S({ kind: 'ribbon', a: { c: P(-250 + k * 4, 40, 120), r: 5 }, b: { c: P(-250 + Math.sin(a) * 170, -150, 120 + Math.cos(a) * 60 - 60), r: 0 },
      bend: P(-250 + Math.sin(a) * 120, -10, 160 + k * 3), dir: V(Math.cos(a), 0, -Math.sin(a)), fill: '#8d6e63' });
  }
  tree = null;
}

// The default: the stress world (world.js), sized by the panel's sliders.
export function buildWorldScene(opts) {
  objects.length = 0;
  const built = buildWorld(opts);
  objects.push(...built);
  skipped = built.skipped;   // shapes that found no free spot (world.js)
  tree = null;
}

const NEAR = 1;
const MIN_PX = 0.35;   // a shape whose screen box is smaller than this is not drawn
const OCCLUDER_PX = 40;   // a shape bigger than this on screen is added to the global mask (cull.js)
// A curved shape smaller than this on screen (its box's diagonal) is drawn simplified: a chain of capsules (curveChainSides), off
// by under half a pixel, instead of its exact outline (curve.js, 0.1-0.4 ms each). A chain of 16 capsules at 160 px: still far
// cheaper. With a margin: an exact shape turns simplified below 150 px, a simplified one exact above 170 px (o.exact), so a
// shape sitting at the cutover doesn't flip every frame.
const CURVE_EXACT_PX = 160, CURVE_MARGIN_PX = 10;
// An exact curved outline is kept (o.exactRef) until one of the object's bounding points, or the radius there, has moved this
// far on screen (canvas px) since it was built: an approximation, off by at most that much, rebuilt at once past it.
const REUSE_PX = 0.5;

// The static objects' tree and the movers, rebuilt after a scene build (null: stale).
let tree = null, skipped = 0;

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

  const stats = { objects: objects.length, skipped, drawn: 0, curved: 0, culled: 0, behind: 0, tiny: 0, occluded: 0, nodesSkipped: 0, simplified: 0, reused: 0, kept: 0, sheets: 0,
    buildMs: 0, drawMs: 0, curvedMs: 0 };
  if (!tree) {   // static objects in a tree, built once per scene
    tree = { root: buildBVH(objects.filter((o) => !o.move)), movers: objects.filter((o) => o.move) };
  }
  // An object's screen data, or null (counted in the stats) when it can't be drawn.
  const prep = (o) => {
    const pts = boundPoints(o), rMax = boundRadius(o);
    let depthSum = 0, zMin = Infinity, zMax = -Infinity;
    for (const p of pts) {
      const z = depthOf(p);
      if (!(z > NEAR + rMax)) { stats.behind++; return null; }   // reaches the eye's plane: not drawn (no near clip yet)
      depthSum += z; zMin = Math.min(zMin, z); zMax = Math.max(zMax, z);
    }
    // Screen box: each point's projection widened by the radius there.
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const proj = pts.map(projectPoint);
    for (const q of proj) {
      const w = rMax * q.scale;
      x0 = Math.min(x0, q.x - w); x1 = Math.max(x1, q.x + w); y0 = Math.min(y0, q.y - w); y1 = Math.max(y1, q.y + w);
    }
    if (x1 < view.x0 || x0 > view.x1 || y1 < view.y0 || y0 > view.y1) { stats.culled++; return null; }
    const size = Math.hypot(x1 - x0, y1 - y0);
    if (size < MIN_PX) { stats.tiny++; return null; }
    const s = { o, size, proj, rMax, depth: depthSum / pts.length, near: zMin - rMax, far: zMax + rMax,
      box: { x0: x0 - pad, x1: x1 + pad, y0: y0 - pad, y1: y1 + pad } };
    if (!o.kind && !o.bend) {   // a capsule: its two screen circles (its sides and, if big, the mask)
      s.c1 = { x: proj[0].x, y: proj[0].y, r: o.a.r * proj[0].scale };
      s.c2 = { x: proj[1].x, y: proj[1].y, r: o.b.r * proj[1].scale };
    }
    return s;
  };
  // Nearest first (nodes and objects in one heap by nearest depth), against the global mask (cull.js).
  const aa = 1.5 / fit, pad = aa + (strokes.on ? 6 : 0);   // a shape's antialiased edge (+ its border's reach) past its box
  const { persp } = projector, frustum = makeFrustum(persp, view), mask = makeMask(view), heap = new Heap();
  const pushNode = (n) => {
    const q = projector.toCamera(n.c);
    if (q.z + n.R <= NEAR) { stats.behind += n.count; return; }
    if (frustum.outside(q, n.R)) { stats.culled += n.count; return; }
    heap.push(q.z - n.R, { node: n, q });
  };
  const pushObject = (o) => { const s = prep(o); if (s) heap.push(s.near, s); };
  for (const o of tree.movers) pushObject(o);
  if (tree.root) pushNode(tree.root);
  const shapes = [];
  while (heap.size) {
    const v = heap.pop();
    if (v.node) {
      const n = v.node;
      if (v.q.z - n.R > NEAR) {
        const b = sphereBox(persp, v.q, n.R);
        if (maskHides(mask, { x0: b.x0 - pad, x1: b.x1 + pad, y0: b.y0 - pad, y1: b.y1 + pad }, v.q.z - n.R)) {
          stats.occluded += n.count; stats.nodesSkipped++; continue;
        }
      }
      if (n.items) for (const o of n.items) pushObject(o);
      else for (const k of n.kids) pushNode(k);
      continue;
    }
    if (maskHides(mask, v.box, v.near)) { stats.occluded++; continue; }
    shapes.push(v);
    if (v.size > OCCLUDER_PX) {   // big enough to hide others: into the global mask (ribbons not yet: not convex)
      const o = v.o;
      if (v.c1) maskAddCapsule(mask, v.c1, v.c2, v.far, aa);
      else if (o.kind === 'panel' || o.kind === 'disc') maskAddConvex(mask, panelPolygon(o, projector), v.far, aa);
      else if (!o.kind) maskAddTube(mask, o, projector, aa);
    }
  }
  shapes.sort((p, q) => q.depth - p.depth);

  // A static object keeps its pieces while the camera (and the canvas) stays put.
  const camKey = [camPos.x, camPos.y, camPos.z, camera.target.x, camera.target.y, camera.target.z, camera.zoom, camera.fov,
    camera.orbitRadius, canvas.width, canvas.height].join(',');
  const tol = REUSE_PX / fit;   // design px
  const near = (ref, s) => ref.proj.length === s.proj.length && ref.proj.every((p, i) => {
    const q = s.proj[i];
    return Math.abs(p.x - q.x) <= tol && Math.abs(p.y - q.y) <= tol && Math.abs(p.scale - q.scale) * s.rMax <= tol;
  });
  // Pieces: the shapes an object is drawn as, farthest first (one, except a sheet's faces). `keep`: kept for later frames, so
  // its path is recorded once (shape.js).
  const one = (o, sides) => (sides.length ? [{ sides, fill: o.fill, colors: SIDE_COLORS, keep: !o.move }] : []);
  for (const s of shapes) {
    const o = s.o, curved = !o.kind && o.bend;
    if (curved) {   // exact or simplified, with the margin
      if (o.exact === undefined) o.exact = s.size >= CURVE_EXACT_PX;
      else if (o.exact && s.size < CURVE_EXACT_PX - CURVE_MARGIN_PX) o.exact = false;
      else if (!o.exact && s.size > CURVE_EXACT_PX + CURVE_MARGIN_PX) o.exact = true;
    }
    let pieces;
    if (!o.move && o.cache && o.cache.key === camKey) { pieces = o.cache.pieces; stats.reused++; }
    else if (o.kind) {
      pieces = sheetPieces(o, projector).sort((p, q) => q.depth - p.depth)
        .map((p) => ({ sides: p.sides, fill: p.front ? o.fill : o.back, colors: SIDE_COLORS, keep: !o.move }));
    } else if (curved && o.exact) {
      if (o.exactRef && near(o.exactRef, s)) { pieces = o.exactRef.pieces; stats.kept++; }
      else {
        const tc = performance.now();
        pieces = one(o, curvedSides(o.a.c, o.bend, o.b.c, o.a.r, o.b.r, projector).sides);
        stats.curvedMs += performance.now() - tc;
        for (const p of pieces) p.keep = true;
        o.exactRef = { proj: s.proj, pieces };
      }
    } else if (curved) {
      pieces = one(o, curveChainSides(o.a.c, o.bend, o.b.c, o.a.r, o.b.r, projector, Math.max(2, Math.ceil(1.2 * Math.sqrt(s.size)))));
    } else pieces = one(o, capsuleSides(s.c1, s.c2));
    if (curved) { if (o.exact) stats.curved++; else stats.simplified++; }
    if (o.kind) stats.sheets++;
    if (!o.move) o.cache = { key: camKey, pieces };
    s.pieces = pieces;
  }
  const t1 = performance.now();
  for (const s of shapes) {
    if (!s.pieces.length) continue;
    for (const p of s.pieces) drawShape(ctx, p, { stroke: strokes.on });
    stats.drawn++;
  }
  const t2 = performance.now();
  stats.buildMs = t1 - t0; stats.drawMs = t2 - t1;

  if (debug.on) {   // node centers (a sheet's bounding corners)
    ctx.fillStyle = darkMode ? '#ffffff' : '#000000';
    for (const s of shapes) for (const q of s.proj) { ctx.beginPath(); ctx.arc(q.x, q.y, 2, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.restore();
  return stats;
}
