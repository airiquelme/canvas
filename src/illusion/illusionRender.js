// The illusion renderer (`optical-illusion` branch, the default scene): every object is rebuilt each frame
// as flat shapes that only have to look right from the camera (shape.js), not a 3D body sorted by depth.
// Objects are 2-node meshes: capsules (capsule.js) or tubes bent through a point (curve.js), and sheets (sheet.js: panels, discs,
// ribbons, two-sided), drawn back to front by the mean depth of their points. Borders (each side stroked in its own color) only with the Strokes button.
import { debug, strokes, DESIGN_WIDTH, DESIGN_HEIGHT, LINE_PX } from '../config.js';
import { camera, getCameraPosition, computeViewBasis, worldToCamera, makeProjector } from '../core/camera.js';
import { applyDesignSpaceTransform } from '../core/canvas.js';
import { drawShape, tracePath, traceSide, sideStart, pointOnEllipse, line } from './shape.js';
import { capsuleSides } from './capsule.js';
import { curvedSides, curveChainSides } from './curve.js';
import { buildWorld } from './world.js';
import { buildMeadow } from './meadow.js';
import { relSize, boundPoints, boundRadius, buildBVH, makeFrustum, sphereBox, makeMask, maskHides, maskAddCapsule, maskAddTube, maskAddConvex, Heap } from './cull.js';
import { sheetPieces, panelPolygon, backOf } from './sheet.js';
import { quadPieces, quadConvex } from './quad.js';
import { patchPieces, ringPatch, heightAt, pieceAt, liftLocal, facingAt, contourWorld, ringWorld } from './patch.js';
import { selectTerrain } from './terrain.js';
import { light, shadeOf, brightOf, litOf, shadeOverlay } from './light.js';
import { capsuleShadow } from './groundShadow.js';
import { selectGrass, bladePieces } from './grass.js';
import { drawSky } from './sky.js';
import { lamps, lampAt, lampTone } from './lamps.js';
import { clipLoopNear } from './patch.js';

// One color per side (capsule: end arc 2, line, end arc 1, line), distinct from every fill.
// 5th: a curved mesh's tip; 6th on: the further stretches a fold splits a curved mesh's sides into.
const SIDE_COLORS = ['#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#00acc1', '#d81b60', '#6d4c41', '#c0ca33', '#3949ab'];

// The scene's objects: { a: { c, r }, b: { c, r }, bend?, fill, move? } (world.js), or sheets ({ kind, ... }, sheet.js).
export const objects = [];

// ?scene=pairs: the first sanity check, three pairs around (500, 400, 0), the purple one bent around the blue one.
export function buildPairsScene() {
  objects.length = 0;
  skipped = 0;
  terrain = null;
  groundEdit = null;
  sky.on = false;
  lamps.length = 0;
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
  terrain = null;
  groundEdit = null;
  sky.on = false;
  lamps.length = 0;
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

// The default: the meadow (meadow.js), rolling ground of edge-sharing panels.
export function buildMeadowScene(opts = {}) {
  // a rebuild (the sun, the light) keeps the ground's edits unless others are given
  if (opts.edits === undefined && groundGrid) opts = { ...opts, edits: groundGrid.edits() };
  objects.length = 0;
  skipped = 0;
  terrain = null;
  groundEdit = null;
  sky.on = false;
  lamps.length = 0;
  const m = buildMeadow(opts);
  terrain = m.terrain;
  groundEdit = m.edit;
  groundGrid = m.grid;
  groundFn = m.groundAt;
  sky.on = true; sky.sunDisc = true;
  objects.push(...m.movers, ...m.poles);
  tree = null;
  return m.groundAt;
}

// ?scene=patch: the floor patch's basic example (patch.js): a ring with a dome as its sheet curve, and one with a bowl.
export function buildPatchScene() {
  objects.length = 0;
  skipped = 0;
  terrain = null;
  groundEdit = null;
  sky.on = false;
  lamps.length = 0;
  objects.push(ringPatch({ c: { x: 500, y: 300, z: 0 }, a: 220, b: 160, angle: 0.4, height: 110, fill: '#7cb342' }));
  objects.push(ringPatch({ c: { x: 500, y: 300, z: 520 }, a: 180, b: 180, height: -70, fill: '#8d6e63' }));
  tree = null;
}

// ?scene=world: the stress world (world.js), sized by the panel's sliders.
export function buildWorldScene(opts) {
  objects.length = 0;
  terrain = null;
  lamps.length = 0;
  sky.on = true; sky.sunDisc = false;
  const built = buildWorld(opts);
  for (const o of built) if (!o.kind) o.shade = { r: Math.max(o.a.r, o.b.r) };   // capsules and tubes: stylized light
  objects.push(...built);
  skipped = built.skipped;   // shapes that found no free spot (world.js)
  tree = null;
}

const NEAR = 1;
// A floor patch reaching the eye's plane is cut at this depth (patch.js clipLoopNear): what is nearer is never on screen for ground
// seen from above (it is far below the view's bottom edge), and the cut keeps every drawn point well in front of the eye.
const NEAR_CUT = 8;
// Grass blades nearer than this are drawn whole (lit face too); farther, only their shade (the lit face melts into the ground).
const GRASS_FULL_D = 80;
const MIN_PX = 0.35;   // a shape whose screen box is smaller than this is not drawn
// OMISSION by relevant size (cull.js relSize: a thin shape's width, a round one's diameter), at its nearest depth, before any
// outline is built: under VANISH_PX (canvas px) it is not drawn; from there to FULL_PX it SHRINKS toward nothing (its radii, a
// sheet's sides, scaled by a smoothstep), so it fades out instead of popping. A tree node whose largest member is under VANISH_PX
// at its nearest point is skipped whole.
const VANISH_PX = 0.6, FULL_PX = 1.5;
const growOf = (px) => { const u = Math.max(0, Math.min(1, (px - VANISH_PX) / (FULL_PX - VANISH_PX))); return u * u * (3 - 2 * u); };
const OCCLUDER_PX = 40;   // a shape bigger than this on screen is added to the global mask (cull.js)
// A curved shape smaller than this on screen (its box's diagonal) is drawn simplified: a chain of capsules (curveChainSides), off
// by under half a pixel, instead of its exact outline (curve.js, 0.1-0.4 ms each). A chain of 16 capsules at 160 px: still far
// cheaper. With a margin: an exact shape turns simplified below 150 px, a simplified one exact above 170 px (o.exact), so a
// shape sitting at the cutover doesn't flip every frame.
const CURVE_EXACT_PX = 160, CURVE_MARGIN_PX = 10;
// An exact curved outline is kept (o.exactRef) until one of the object's bounding points, or the radius there, has moved this
// far on screen (canvas px) since it was built: an approximation, off by at most that much, rebuilt at once past it.
const REUSE_PX = 0.5;
// GROUND REUSE: a fully front-facing patch's screen shape is redrawn as its last built one under the affine map that carries its
// three corners to where they are now, while 4 check points of the surface (its edges' middles, its middle) land within
// PATCH_REUSE_PX canvas px of their true projections (a sliver between neighbors would show the ground
// underlay, not the sky); else it is rebuilt (and becomes the new reference).
const PATCH_REUSE_PX = 0.25;

// A sheet shrunk toward its center by g (while it fades out): a panel's or disc's half-axes, a ribbon's width.
function shrunkSheet(o, g) {
  if (o.kind === 'panel' || o.kind === 'disc') return { ...o, e1: { x: o.e1.x * g, y: o.e1.y * g, z: o.e1.z * g }, e2: { x: o.e2.x * g, y: o.e2.y * g, z: o.e2.z * g } };
  if (o.kind === 'ribbon') return { ...o, a: { c: o.a.c, r: o.a.r * g }, b: { c: o.b.c, r: o.b.r * g } };
  return o;
}

// The static objects' tree and the movers, rebuilt after a scene build (null: stale).
let tree = null, skipped = 0, frameNo = 0;
// The scene's terrain (terrain.js), or null: its patches are picked per frame, at the coarsest level within TERRAIN_TOL_PX.
let terrain = null;
// The meadow's ground edit (meadow.js edit: dig / place a cube of the grid at the screen's center), or null.
let groundEdit = null, groundGrid = null, groundFn = null;
// The meadow's walkable ground for the walk mode (flyCamera.js): the drawn ground's height at x, z (land or water, edits included)
// and the grid's cube size, or null outside the meadow.
export const walkGround = () => (groundEdit && groundFn ? { height: groundFn, cube: groundGrid.cube } : null);
// The ground's edits ([["i,j,k", solid], ...], grid.js), for saving.
export const groundEdits = () => (groundGrid ? groundGrid.edits() : []);
export function editGround(action) {
  if (!groundEdit) return null;
  const eye = getCameraPosition(), t = camera.target;
  const d = { x: t.x - eye.x, y: t.y - eye.y, z: t.z - eye.z }, l = Math.hypot(d.x, d.y, d.z) || 1;
  return groundEdit(action, eye, { x: d.x / l, y: d.y / l, z: d.z / l });
}
// The scene's sky (sky.js): a gradient by the sun's height (meadow, world), with the sun's disc (meadow: the world has a sun shape).
const sky = { on: false, sunDisc: false };
export const sceneTerrain = () => terrain;   // for tools
// Grass on the terrain (grass.js); the Grass button.
export const grass = { on: false, tips: true };   // tips: only the blades' shaded tips (a texture), grass.js
// The ground's SILHOUETTE: the sides of floor patches beyond which no ground is drawn. Contour arcs (no `edge` tag: where the
// surface turns away), and stretches of patch edges whose neighbor is not drawn there (it faces away from the eye at that point: a
// crest's crease between two triangles) or that have none (the terrain's border). The edge is the same curve in both patches, so
// along a stretch of it the neighbor's facing g is quadratic: its roots give the exact sub-stretches.
// GRASS EDGE: TUFTS of grass planted in the world, seen where they poke out past the silhouette. One tuft per TUFT_CELL cell, at a
// jittered point (a hash of the cell), standing on the DRAWN ground there (the run's patch's sheet curve; across a crest edge, the
// neighbor's), its tip TUFT_ASPECT x R up (x 0.7-1.3 by the tuft; R = TUFT_R x cell, the tuft's half-width). For the tufts within
// TUFT_REACH (x, z) of a run, the tip is projected and, if it lands past the outline (toward the sky), a spike is drawn from the
// outline up to it, VERTICAL (along world up on screen, whatever the outline's slant): its foot where the tuft's vertical meets the
// outline, its base along the outline (R wide each way at the tuft's depth, TUFT_DOWN_PX into the ground). So a tuft just behind a crest sticks up over it and one on the slope in front peeks over its top, by the real geometry:
// the spikes rise and sink exactly as fast as the hill turns toward or away from the eye, and keep their world size (narrower with
// distance). A tuft shows at all only once its full height on screen, from its distance, is over TUFT_SHOW_LINES standard lines
// (config.js LINE_PX, design px: the texture width the grass tips use), growing in up to TUFT_FULL_LINES: near crests only. Fades, all smooth: that one, by distance
// from the run (a window 1 - (d / REACH)^2, squared, so none pops in at the reach), and a spike under SPIKE_VANISH_PX past the
// outline is flat, full from SPIKE_FULL_PX.
// SHADE BORDERS (`shade`): the lit / shade cut inside a patch (edge 'cut', shadow.js; shores too) sprouts the same tufts. Both
// parts hold the cut; each takes only the tufts on its own side whose ground point is on the near side of the cut on screen, so the
// part lower on screen (nearer, from where the eye is) sprouts, in its own tone, over the other: lit grass over the shade behind
// it, or shade grass over the lit ground behind it, switching as the eye moves. Water grows none.
// Each run's spikes are one piece (one loop each) in the tone of the ground piece it lies on, drawn right after its patch.
// `red`: the silhouette stroked in red on top of its patch (the test view).
export const silhouette = { on: true, spikes: true, shade: true, red: false, color: '#ff0000', px: 2 };
// A loop's turn in (x, z): twice its signed area (> 0 counterclockwise), from its pieces sampled; once per loop.
const turnCache = new WeakMap();
function loopTurn(loop) {
  let a = turnCache.get(loop);
  if (a !== undefined) return a;
  const pts = [];
  for (const pc of loop) { const n = pc.kind === 'line' ? 1 : 8; for (let j = 0; j < n; j++) pts.push(pieceAt(pc, j / n)); }
  a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p.x * q.z - q.x * p.z; }
  turnCache.set(loop, a);
  return a;
}
export const isSilhouetteSide = (sd) => sd.edge === undefined;
const TUFT_CELL = 2.4, TUFT_R = 0.6, TUFT_ASPECT = 3.0, TUFT_DOWN_PX = 1.5, TUFT_REACH = 6;
// NEAR ONLY: a tuft shows once its full height on screen is over TUFT_SHOW_LINES standard lines (LINE_PX), full at TUFT_FULL_LINES
// (6 / 12: from about 290 units away, full by about 145, at the default zoom); far crests have none.
const TUFT_SHOW_LINES = 6, TUFT_FULL_LINES = 12;
const SPIKE_VANISH_PX = 1, SPIKE_FULL_PX = 3;
const RUN_SEG_PX = 16;   // a run is a polyline of chords about this long on screen (the spikes' base line)
const smooth01 = (u) => { u = Math.max(0, Math.min(1, u)); return u * u * (3 - 2 * u); };
const hash2 = (i, j, L) => {   // 0..1 from a cell
  let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(L + 1, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
export const spikeStats = { pieces: 0, points: 0, tufts: 0, ms: 0 };
const edgeKey = (E) => {
  const a = `${E[0].x.toFixed(3)},${E[0].z.toFixed(3)}`, b = `${E[1].x.toFixed(3)},${E[1].z.toFixed(3)}`;
  return a < b ? a + '|' + b : b + '|' + a;
};
// a patch's edge keys, once per patch (its edges are fixed; an edit builds new patches)
const edgeKeysOf = (o) => (o.edgeKeysFor === o.edges ? o.edgeKeys : ((o.edgeKeysFor = o.edges), (o.edgeKeys = o.edges.map((E) => (E ? edgeKey(E) : null)))));
const dist3 = (a, b) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);

// The spikes of the tufts near one run (world polyline P) -> a piece, or null. groundY(x, z): the drawn ground's height there.
// keep(x, z): which tufts may sprout (shade borders: the part's own side); baseBelow: only tufts whose own ground point is on the
// near side of the line on screen (a tuft already past it would show in the other part's area, in its own tone: no contrast).
function tuftPiece(P, fill, projectPoint, fit, groundY, keep = null, baseBelow = false) {
  const Q = P.map(projectPoint);
  if (Q.some((q) => !(q.scale > 0))) return null;
  let smax = 0;
  for (const q of Q) smax = Math.max(smax, q.scale);
  const R = TUFT_R * TUFT_CELL, c = TUFT_CELL, S = TUFT_REACH;
  if (TUFT_ASPECT * R * 1.3 * smax * 1.2 <= TUFT_SHOW_LINES * LINE_PX) return null;   // every tuft too small from here (+ the reach's margin)
  const sides = [];
  const tri = (a, b, cc) => {
    const ar = (b.x - a.x) * (cc.y - a.y) - (b.y - a.y) * (cc.x - a.x);
    const [p, q, r] = ar < 0 ? [a, cc, b] : [a, b, cc];
    sides.push({ ...line(p, q), ci: 4, move: sides.length > 0 }, { ...line(q, r), ci: 4 }, { ...line(r, p), ci: 4 });
  };
  for (let s = 0; s + 1 < P.length; s++) {
    const A = P[s], B = P[s + 1], dx = B.x - A.x, dz = B.z - A.z, l2 = dx * dx + dz * dz;
    if (!(l2 > 1e-12)) continue;
    const qa = Q[s], qb = Q[s + 1];
    const sx_ = qb.x - qa.x, sy_ = qb.y - qa.y, sl = Math.hypot(sx_, sy_);
    if (!(sl > 1e-9)) continue;
    const tx = sx_ / sl, ty = sy_ / sl;   // the chord on screen and its normal toward the sky (screen up of world up at A)
    const qu = projectPoint({ x: A.x, y: A.y + 1, z: A.z });
    let nx = -ty, ny = tx;
    if (nx * (qu.x - qa.x) + ny * (qu.y - qa.y) < 0) { nx = -nx; ny = -ny; }
    const i0 = Math.floor((Math.min(A.x, B.x) - S) / c), i1 = Math.floor((Math.max(A.x, B.x) + S) / c);
    const j0 = Math.floor((Math.min(A.z, B.z) - S) / c), j1 = Math.floor((Math.max(A.z, B.z) + S) / c);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const sx = (i + 0.1 + 0.8 * hash2(i, j, 0)) * c, sz = (j + 0.1 + 0.8 * hash2(j, i, 17)) * c;
      const t = ((sx - A.x) * dx + (sz - A.z) * dz) / l2;   // each tuft to the chord it lies beside (unclamped)
      if (t < 0 || t >= 1) continue;
      const ex = A.x + dx * t - sx, ez = A.z + dz * t - sz, d2 = ex * ex + ez * ez;
      if (d2 >= S * S) continue;
      if (keep && !keep(sx, sz)) continue;
      // the real tuft: its tip TUFT_ASPECT x R above its own ground point
      const h = TUFT_ASPECT * R * (0.7 + 0.6 * hash2(i, j, 33)), y = groundY(sx, sz);
      const tip = projectPoint({ x: sx, y: y + h, z: sz }), base = projectPoint({ x: sx, y, z: sz });
      if (!(tip.scale > 0) || !(base.scale > 0)) continue;
      // SIZE GATE, from distance alone: none while the tuft's full height on screen is under TUFT_SHOW_LINES standard lines, grown in
      // by TUFT_FULL_LINES
      const wt = smooth01(((h * tip.scale) / LINE_PX - TUFT_SHOW_LINES) / (TUFT_FULL_LINES - TUFT_SHOW_LINES));
      if (wt <= 0) continue;
      if (baseBelow && (base.x - qa.x) * nx + (base.y - qa.y) * ny > 0) continue;
      // VERTICAL: world up on screen at the tuft (U); its foot is where the vertical through the tip meets the chord's line,
      // qa + a T + lam U = tip, and lam (> 0) is how far the tip stands past the outline along U
      const ul = Math.hypot(tip.x - base.x, tip.y - base.y);
      if (!(ul > 1e-9)) continue;
      const ux = (tip.x - base.x) / ul, uy = (tip.y - base.y) / ul;
      if (ux * nx + uy * ny <= 0) continue;
      const det = tx * uy - ty * ux;
      if (Math.abs(det) < 0.2) continue;   // the outline nearly vertical on screen: a spike would run along it
      const rx = tip.x - qa.x, ry = tip.y - qa.y, a = (rx * uy - ry * ux) / det;
      let out = (tx * ry - ty * rx) / det;
      if (out <= 0) continue;
      const win = 1 - d2 / (S * S);
      out *= wt * win * win;   // a window in x, z (no tuft pops in at its edge) and the size gate's fade
      const opx = out * fit;
      if (opx < SPIKE_VANISH_PX) continue;
      out *= smooth01((opx - SPIKE_VANISH_PX) / (SPIKE_FULL_PX - SPIKE_VANISH_PX));
      const w = R * tip.scale, down = TUFT_DOWN_PX / fit;
      const fx = qa.x + tx * a, fy = qa.y + ty * a;   // the foot on the chord
      tri({ x: fx - tx * w - ux * down, y: fy - ty * w - uy * down }, { x: fx + ux * out, y: fy + uy * out },
        { x: fx + tx * w - ux * down, y: fy + ty * w - uy * down });
      spikeStats.tufts++;
    }
  }
  return sides.length ? { sides, fill, colors: SIDE_COLORS, spike: true } : null;
}
function silhouetteEdges(shapes, eye, projectPoint, fit) {
  spikeStats.pieces = spikeStats.points = spikeStats.tufts = 0;
  const byEdge = new Map();
  for (const s of shapes) if (s.o.kind === 'patch' && s.o.edges && s.pieces) for (const key of edgeKeysOf(s.o)) {
    if (!key) continue;
    const t = byEdge.get(key);
    if (t === undefined) byEdge.set(key, s); else if (t !== s) byEdge.set(key, [t, s]);
  }
  const wholly = (t) => { const p0 = t.pieces[0]; return !!(p0.M || (p0.ref || p0).flat); };   // drawn whole: flat, or reused (front-facing)
  const screenLen = (A, B) => { const a = projectPoint(A), b = projectPoint(B); return a.scale > 0 && b.scale > 0 ? Math.hypot(b.x - a.x, b.y - a.y) : -1; };
  for (const s of shapes) {
    const o = s.o;
    if (o.kind !== 'patch' || !s.pieces || !s.pieces.length || !(s.pieces[0].ref || s.pieces[0]).floor) continue;
    const lines = [], spikes = [];
    const own = (x, z) => liftLocal(o, x - o.ox, z - o.oz).y;
    const emit = (P, fill, groundY = own, keep = null, baseBelow = false) => {
      if (silhouette.red) lines.push(P.map(projectPoint));
      if (silhouette.spikes) { const sp = tuftPiece(P, fill, projectPoint, fit, groundY, keep, baseBelow); spikeStats.points += P.length; if (sp) { spikes.push(sp); spikeStats.pieces++; } }
    };
    for (const p of s.pieces) {
      const r = p.ref || p, loop = r.loop, fill = p.fill;
      if (!loop || r.water) continue;   // (no grass on water)
      for (const sd of r.sides) {
        if (sd.edge === undefined) {   // a contour side: points on the conic
          if (p.M) continue;
          if (sd.cl && r.G) {
            const len = screenLen(liftLocal(o, sd.cl[0].x, sd.cl[0].z), liftLocal(o, sd.cl[1].x, sd.cl[1].z));
            if (len < 0) continue;
            emit(contourWorld(o, r.G, sd.cl[0], sd.cl[1], Math.max(1, Math.min(7, Math.ceil(Math.log2((1.3 * len) / RUN_SEG_PX + 1))))), fill);
          } else if (sd.ring && sd.ua !== undefined) {
            const [A, B] = ringWorld(o, sd.ring, sd.ua, sd.ub, 1), len = screenLen(A, B);
            if (len < 0) continue;
            emit(ringWorld(o, sd.ring, sd.ua, sd.ub, Math.max(2, Math.min(64, Math.ceil((1.3 * len) / RUN_SEG_PX)))), fill);
          }
          continue;
        }
        if (sd.edge === 'cut' && silhouette.shade && sd.piece !== undefined && loop[sd.piece]) {
          // a SHADE BORDER (or a shore): this part sprouts tufts from its own side, shown where they poke past the border on screen
          const pc = loop[sd.piece], W = (u) => { const q = pieceAt(pc, u); return liftLocal(o, q.x, q.z); };
          const ua = Math.min(sd.ua, sd.ub), ub = Math.max(sd.ua, sd.ub), len = screenLen(W(ua), W(ub));
          if (len < 0) continue;
          const n = Math.max(1, Math.min(64, Math.ceil((pc.kind === 'arc' ? 1.3 : 1) * len / RUN_SEG_PX))), P = [];
          for (let i = 0; i <= n; i++) P.push(W(ua + ((ub - ua) * i) / n));
          // the part's side of the border: its loop's interior lies left of the piece's direction when the loop turns
          // counterclockwise in (x, z); tested against the nearest chord of the run
          const ccw = loopTurn(loop) > 0;
          const keep = (x, z) => {
            let best = Infinity, side = true;
            for (let i = 0; i + 1 < P.length; i++) {
              const A = P[i], B = P[i + 1], dx = B.x - A.x, dz = B.z - A.z, l2 = dx * dx + dz * dz || 1;
              const t = Math.max(0, Math.min(1, ((x - A.x) * dx + (z - A.z) * dz) / l2)), ex = A.x + dx * t - x, ez = A.z + dz * t - z, d2 = ex * ex + ez * ez;
              if (d2 < best) { best = d2; side = (dx * (z - A.z) - dz * (x - A.x) > 0) === ccw; }
            }
            return side;
          };
          emit(P, fill, own, keep, true);
          continue;
        }
        if (!Number.isInteger(sd.edge) || sd.piece === undefined || !o.edges || !o.edges[sd.edge]) continue;
        const pc = loop[sd.piece];
        if (!pc || pc.kind !== 'line') continue;
        const W = (u) => { const q = pieceAt(pc, u); return liftLocal(o, q.x, q.z); };
        const l = byEdge.get(edgeKeysOf(o)[sd.edge]), N = Array.isArray(l) ? (l[0] === s ? l[1] : l[0]) : l === s ? null : l;
        const ua = Math.min(sd.ua, sd.ub), ub = Math.max(sd.ua, sd.ub), runs = [];
        if (!N || !N.pieces.length) {
          // the terrain's BORDER (or a neighbor not drawn at all): grass only where the patch's ground lies below the edge on screen
          // (seen from outside the terrain, the ground is above its border: spikes would point into the ground and their bases poke
          // out below the edge as dark teeth)
          const um = (ua + ub) / 2, qm = pieceAt(pc, um), M = liftLocal(o, qm.x, qm.z);
          const lx = qm.x + (o.mid.x - o.ox - qm.x) * 0.05, lz = qm.z + (o.mid.z - o.oz - qm.z) * 0.05;
          const pM = projectPoint(M), pI = projectPoint(liftLocal(o, lx, lz)), pU = projectPoint({ x: M.x, y: M.y + 1, z: M.z });
          if (!(pM.scale > 0) || (pI.x - pM.x) * (pU.x - pM.x) + (pI.y - pM.y) * (pU.y - pM.y) > 0) continue;
          runs.push([ua, ub]);
        }
        else if (!wholly(N)) {
          // g of N along the stretch: a quadratic through three samples; the runs where it is <= 0
          const g0 = facingAt(N.o, eye, W(ua)), gh = facingAt(N.o, eye, W((ua + ub) / 2)), g1 = facingAt(N.o, eye, W(ub));
          const a = 2 * (g1 - 2 * gh + g0), b = 4 * gh - 3 * g0 - g1;   // g(v) = a v^2 + b v + g0, v in [0, 1]
          const cuts = [0];
          if (Math.abs(a) > 1e-12 * (Math.abs(b) + Math.abs(g0) + 1e-300)) {
            const d = b * b - 4 * a * g0;
            if (d > 0) { const q = Math.sqrt(d); cuts.push((-b - q) / (2 * a), (-b + q) / (2 * a)); }
          } else if (Math.abs(b) > 1e-300) cuts.push(-g0 / b);
          const vs = [...new Set(cuts.filter((v) => v > 0 && v < 1)), 1].sort((x, y) => x - y);
          for (let i = 0; i + 1 < vs.length; i++) {
            const vm = (vs[i] + vs[i + 1]) / 2;
            if (a * vm * vm + b * vm + g0 <= 0) runs.push([ua + (ub - ua) * vs[i], ua + (ub - ua) * vs[i + 1]]);
          }
        }
        for (const [u0, u1] of runs) {
          const len = screenLen(W(u0), W(u1));
          if (len < 0) continue;
          const n = Math.max(1, Math.min(64, Math.ceil(len / RUN_SEG_PX))), P = [];
          for (let i = 0; i <= n; i++) P.push(W(u0 + ((u1 - u0) * i) / n));
          // tufts on the far side of the edge stand on the neighbor's ground
          const E0 = W(0), E1 = W(1), ex = E1.x - E0.x, ez = E1.z - E0.z, sideOf = (x, z) => ex * (z - E0.z) - ez * (x - E0.x) > 0;
          const mine = sideOf(o.mid.x, o.mid.z), No = N && N.o;
          emit(P, fill, No ? (x, z) => (sideOf(x, z) === mine ? own(x, z) : liftLocal(No, x - No.ox, z - No.oz).y) : own);
        }
      }
    }
    s.pieces[0].silLines = lines;
    if (spikes.length) s.pieces = s.pieces.concat(spikes);
  }
}

const TERRAIN_TOL_PX = 0.5;   // canvas px


// Draws one frame at time t (seconds, for the movers) with Canvas 2D; returns its stats.
export function renderIllusion(ctx, canvas, opts = {}) {
  return drawIllusion2D(ctx, canvas, buildIllusionFrame(canvas, opts));
}

// THE FRAME: everything but the drawing, the same for every backend (Canvas 2D here, the GPU backends in src/gpu/): the shapes in
// draw order (back to front, each with its `pieces`), the movers' shadows (each drawn right after shape `last`), the sky's terms
// and the stats. Canvas size only matters through `fit` / `view`.
export function buildIllusionFrame(canvas, { darkMode = false, time = 0 } = {}) {
  const t0 = performance.now();
  // The visible part of the design space (the canvas may be wider or taller than its aspect).
  const fit = Math.min(canvas.width / DESIGN_WIDTH, canvas.height / DESIGN_HEIGHT);
  const hw = canvas.width / 2 / fit, hh = canvas.height / 2 / fit;
  const view = { x0: DESIGN_WIDTH / 2 - hw, x1: DESIGN_WIDTH / 2 + hw, y0: DESIGN_HEIGHT / 2 - hh, y1: DESIGN_HEIGHT / 2 + hh };

  for (const o of objects) if (o.move) o.move(time);

  const camPos = getCameraPosition(), basis = computeViewBasis(camPos, camera.target);
  const projector = makeProjector(camPos, basis), { projectPoint } = projector;
  const depthOf = (p) => projector.toCamera(p).z;

  const stats = { objects: objects.length, skipped, drawn: 0, curved: 0, culled: 0, behind: 0, tiny: 0, occluded: 0, nodesSkipped: 0, simplified: 0, reused: 0, kept: 0, sheets: 0, seams: 0, flat: 0, shadows: 0, blades: 0, fullBlades: 0, specks: 0,
    buildMs: 0, drawMs: 0, curvedMs: 0, reusedGround: 0, backGround: 0, fills: 0 };
  if (!tree) {   // static objects in a tree, built once per scene
    tree = { root: buildBVH(objects.filter((o) => !o.move)), movers: objects.filter((o) => o.move) };
  }
  // An object's screen data, or null (counted in the stats) when it can't be drawn.
  const prep = (o) => {
    let pts = boundPoints(o), ra = o.a && o.a.r, rb = o.b && o.b.r;
    const rMax = boundRadius(o);
    // NEAR CLIP for a straight capsule with one end behind the eye: that end moved along it to just in front of the eye (its
    // radius interpolated), so the rest is drawn instead of the whole capsule dropped.
    if (!o.kind && !o.bend) {
      const za = depthOf(o.a.c), zb = depthOf(o.b.c), lim = NEAR + rMax + 1;
      if ((za <= lim) !== (zb <= lim)) {
        const t = (lim + 0.5 - za) / (zb - za), P = o.a.c, Q = o.b.c;
        const X = { x: P.x + (Q.x - P.x) * t, y: P.y + (Q.y - P.y) * t, z: P.z + (Q.z - P.z) * t }, rx = o.a.r + (o.b.r - o.a.r) * t;
        if (za <= lim) { pts = [X, Q]; ra = rx; } else { pts = [P, X]; rb = rx; }
      }
    }
    let depthSum = 0, zMin = Infinity, zMax = -Infinity;
    let crossing = false;
    for (const p of pts) {
      const z = depthOf(p);
      if (!(z > NEAR + rMax)) {   // reaches the eye's plane: not drawn (no near clip yet), except floor patches, cut there
        if (o.kind !== 'patch') { stats.behind++; return null; }
        crossing = true;
      }
      depthSum += z; zMin = Math.min(zMin, z); zMax = Math.max(zMax, z);
    }
    // Its width on screen at its nearest point (canvas px), from its relevant size alone.
    // (Ground never vanishes; a shape reaching the eye's plane is near: no test.)
    const rs = relSize(o), wpx = rs === Infinity || crossing ? Infinity : (rs * persp.s * fit) / zMin;
    if (wpx < VANISH_PX) { stats.tiny++; return null; }
    const grow = wpx >= FULL_PX ? 1 : growOf(wpx);
    if (crossing) {
      if (!(zMax > NEAR_CUT)) { stats.behind++; return null; }
      // Its screen box can't be projected: the whole view (so it is never culled, never hidden by the mask); its key: its points'
      // mean depth, kept in front of the eye.
      const proj = pts.filter((p) => depthOf(p) > NEAR).map(projectPoint);
      return { o, size: 1e9, proj, rMax, depth: Math.max(NEAR_CUT, depthSum / pts.length), near: Math.max(NEAR, zMin), far: zMax,
        box: { x0: view.x0 - pad, x1: view.x1 + pad, y0: view.y0 - pad, y1: view.y1 + pad }, nearCut: true };
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
    const s = { o, size, proj, rMax, depth: depthSum / pts.length, near: zMin - rMax, far: zMax + rMax, grow,
      box: { x0: x0 - pad, x1: x1 + pad, y0: y0 - pad, y1: y1 + pad } };
    if (!o.kind && !o.bend) {   // a capsule: its two screen circles (its sides and, if big, the mask); shrunk while fading
      s.c1 = { x: proj[0].x, y: proj[0].y, r: ra * proj[0].scale * grow };
      s.c2 = { x: proj[1].x, y: proj[1].y, r: rb * proj[1].scale * grow };
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
    if (q.z - n.R > NEAR && (n.maxSize * persp.s * fit) / (q.z - n.R) < VANISH_PX) { stats.tiny += n.count; stats.nodesSkipped++; return; }
    heap.push(q.z - n.R, { node: n, q });
  };
  const pxScaleOf = (s) => s.proj.reduce((m, q) => Math.max(m, q.scale), 0);   // screen px per world unit at its nearest point
  const pushObject = (o) => { const s = prep(o); if (s) { heap.push(s.near, s); if (o.kind === 'patch') { o.prepS = s; o.prepFrame = frameNo; } } };
  frameNo++;
  let frameBlades = null;
  for (const o of tree.movers) pushObject(o);
  if (terrain) {
    const sel = selectTerrain(terrain, { toCamera: projector.toCamera, persp, frustum, tol: TERRAIN_TOL_PX / fit, stamp: frameNo, near: NEAR });
    stats.objects += sel.length; stats.terrain = sel.length;
    for (const o of sel) pushObject(o);
    if (grass.on && terrain.leafNodes) {   // blades from the patches' seeds (grass.js), near the eye only
      frameBlades = selectGrass(terrain, camPos, { F: light.on ? terrain.F : null, L: light.on ? light.dir : null,
        toCamera: projector.toCamera, projectPoint, persp, frustum, near: NEAR, fit, tips: grass.tips });
      stats.grass = frameBlades.curved.length; stats.specks = frameBlades.triangles;
    }
  }
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
      else if (o.kind === 'quad') { const q = quadConvex(v.proj); if (q) maskAddConvex(mask, q, v.far, aa); }
      else if (!o.kind) maskAddTube(mask, o, projector, aa);
    }
  }
  // Blades go straight into the draw list (no visibility heap, mask or cache: they are many, small, and the mask hides nothing on
  // the ground): base and tip projected, the chain of capsules built at once (3 near, 1 far), the key their middle's depth.
  // Far blades: each patch's shade triangles as one shape (grass.js), drawn after the patch.
  const grassShade = (fill, p) => { const lf = lamps.length ? lampAt(p) : null; return lf ? lampTone(fill, shadeOf(fill), lf) : shadeOf(fill); };
  if (frameBlades) for (const g of frameBlades.specks) shapes.push({ o: g, size: 1, proj: [], depth: g.depth, prebuilt: true,
    pieces: [{ sides: g.sides, fill: grassShade(g.host.patch.fill, g.host.patch.mid), alpha: g.alpha, colors: SIDE_COLORS }] });
  if (frameBlades) for (const b of frameBlades.curved) {
    const z = depthOf(b.mid);
    if (z <= NEAR) continue;
    const qa = projectPoint(b.base), qt = projectPoint(b.tip), size = Math.hypot(qt.x - qa.x, qt.y - qa.y);
    if (size < MIN_PX) { stats.tiny++; continue; }
    shapes.push({ o: b, size, proj: [qa, qt], depth: z, blade: true });
  }
  // A blade is drawn after the ground patch it stands on (the drawn level holding its finest patch): its key at most that patch's.
  for (const s of shapes) if (s.o.grass) {
    let nd = s.o.host;
    while (nd && nd.patch.sel !== frameNo) nd = nd.parent;
    const hs = nd && nd.patch.prepFrame === frameNo ? nd.patch.prepS : null;
    if (hs) s.depth = Math.min(s.depth, hs.depth - 1e-6);
    s.hostS = hs;
  }
  // Objects standing on the terrain (`onGround`: movers, poles) are drawn after the ground patch under their base, as blades are
  // (a big patch's mean depth can be nearer than an object on it): their key at most that patch's.
  if (terrain) {
    // the drawn triangles' corners (world x, z), gathered once only if something stands on the ground
    let tri = null, tn = 0, tS = null;
    const sg = (ax, az, bx, bz, x, z) => (bx - ax) * (z - az) - (bz - az) * (x - ax);
    for (const s of shapes) if (s.o.onGround) {
      if (!tri) {
        tri = new Float64Array(shapes.length * 6); tS = [];
        for (const g of shapes) {
          const o = g.o;
          if (o.kind !== 'patch' || o.loop.length !== 3 || o.loop.some((pc) => pc.kind !== 'line')) continue;
          for (let k = 0; k < 3; k++) { tri[6 * tn + 2 * k] = o.loop[k].a.x + o.ox; tri[6 * tn + 2 * k + 1] = o.loop[k].a.z + o.oz; }
          tS.push(g); tn++;
        }
      }
      const pts = boundPoints(s.o);
      let low = pts[0];
      for (const p of pts) if (p.y < low.y) low = p;
      const x = low.x, z = low.z;
      for (let k = 0; k < tn; k++) {
        const j = 6 * k;
        const d1 = sg(tri[j], tri[j + 1], tri[j + 2], tri[j + 3], x, z), d2 = sg(tri[j + 2], tri[j + 3], tri[j + 4], tri[j + 5], x, z);
        const d3 = sg(tri[j + 4], tri[j + 5], tri[j], tri[j + 1], x, z);
        if ((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0)) continue;
        s.depth = Math.min(s.depth, tS[k].depth - 1e-6); break;
      }
    }
  }
  shapes.sort((p, q) => q.depth - p.depth);

  // A static object keeps its pieces while the camera (and the canvas) stays put.
  const camKey = [camPos.x, camPos.y, camPos.z, camera.target.x, camera.target.y, camera.target.z, camera.zoom, camera.fov,
    camera.orbitRadius, canvas.width, canvas.height, light.on, light.version].join(',');
  const tol = REUSE_PX / fit;   // design px
  const near = (ref, s) => ref.proj.length === s.proj.length && ref.proj.every((p, i) => {
    const q = s.proj[i];
    return Math.abs(p.x - q.x) <= tol && Math.abs(p.y - q.y) <= tol && Math.abs(p.scale - q.scale) * s.rMax <= tol;
  });
  // Stylized light (light.js), for objects with `shade: { r, bright? }`: the shade crescent is the shape minus itself moved toward
  // the sun on screen by r (1 - cos th) (th: between the sun and the view ray; r in world units at the object's center), so a front
  // lit object has a thin crescent, a side lit one half, a backlit one nearly all; the bright crescent, toward the sun, is
  // 0.3 r times how much the sun is across the view (none when it is straight behind the eye or the object).
  const setCrescents = (o, pieces) => {
    if (!light.on || !o.shade) { for (const p of pieces) p.crescents = null; return; }
    const pts = boundPoints(o), c = { x: 0, y: 0, z: 0 };
    for (const p of pts) { c.x += p.x / pts.length; c.y += p.y / pts.length; c.z += p.z / pts.length; }
    const lift = lamps.length ? lampAt(c) : null, shadeTone = (f) => (lift ? lampTone(f, shadeOf(f), lift) : shadeOf(f));
    // The sun down, or inside a hill's shadow: all of it in shade (a lamp's tone near one).
    if (light.dir.y <= 0 || (o.move && terrain && terrain.F && terrain.F.point && terrain.F.point(pts[0]))) {
      for (const p of pieces) { p.fill = shadeTone(o.fill); p.crescents = null; }
      return;
    }
    if (depthOf(c) <= NEAR + 1) { for (const p of pieces) p.crescents = null; return; }   // its middle behind the eye (near clip)
    const L = light.dir, R = o.shade.r, q0 = projectPoint(c);
    const q1 = projectPoint({ x: c.x + L.x * R, y: c.y + L.y * R, z: c.z + L.z * R });
    let dx = q1.x - q0.x, dy = q1.y - q0.y;
    const dl = Math.hypot(dx, dy) || 1, px = R * q0.scale;
    dx /= dl; dy /= dl;
    const vx = c.x - camPos.x, vy = c.y - camPos.y, vz = c.z - camPos.z, vl = Math.hypot(vx, vy, vz) || 1;
    const cos = -(L.x * vx + L.y * vy + L.z * vz) / vl, sh = px * (1 - cos);
    const br = o.shade.bright === false ? 0 : 0.3 * px * Math.min(1, dl / (px || 1));
    for (const p of pieces) {
      p.crescents = [{ dx: dx * sh, dy: dy * sh, color: shadeTone(p.base ?? p.fill) }];
      if (br > 0.05) p.crescents.push({ dx: -dx * br, dy: -dy * br, color: brightOf(p.base ?? p.fill) });
    }
  };
  // Pieces: the shapes an object is drawn as, farthest first (one, except a sheet's faces). `keep`: kept for later frames, so
  // its path is recorded once (shape.js).
  const one = (o, sides) => (sides.length ? [{ sides, fill: litOf(o.fill), base: o.fill, colors: SIDE_COLORS, keep: !o.move }] : []);
  // Ground reuse (PATCH_REUSE_PX): the patch's 7 control points (3 corners, then the check points), world, cached on it.
  const reuseOn = !debug.on && !strokes.on && typeof Path2D !== 'undefined', ptol = PATCH_REUSE_PX / fit;
  const lightKey = light.on + ':' + light.version;
  const ctrlOf = (o) => {
    if (o.ctrl !== undefined) return o.ctrl;
    if (o.loop.length !== 3 || o.loop.some((pc) => pc.kind !== 'line')) return (o.ctrl = null);
    const L = (x, z) => ({ x: o.ox + x, y: o.oy + heightAt(o.q, x, z), z: o.oz + z, lx: x, lz: z });
    const c = o.loop.map((pc) => pc.a);
    return (o.ctrl = [L(c[0].x, c[0].z), L(c[1].x, c[1].z), L(c[2].x, c[2].z),
      L((c[0].x + c[1].x) / 2, (c[0].z + c[1].z) / 2), L((c[1].x + c[2].x) / 2, (c[1].z + c[2].z) / 2),
      L((c[2].x + c[0].x) / 2, (c[2].z + c[0].z) / 2), L((c[0].x + c[1].x + c[2].x) / 3, (c[0].z + c[1].z + c[2].z) / 3)]);
  };
  // The exact range over a triangle patch of g (patch.js: > 0 where its top faces the eye), a quadratic in x, z: its extremes
  // are at the corners, at each edge's own extreme (a parabola along it) or at its stationary point inside. [min, max].
  const gRange = (o, W) => {
    if (o.gFrame === frameNo) return o.gR;
    o.gFrame = frameNo;
    return (o.gR = gRangeOf(o, W));
  };
  const gRangeOf = (o, W) => {
    const [A, B, C, D, E, F] = o.q, ex = camPos.x - o.ox, ey = camPos.y - o.oy, ez = camPos.z - o.oz;
    const G3 = -(2 * A * ex + B * ez), G4 = -(B * ex + 2 * C * ez), G5 = ey - F - D * ex - E * ez;
    const g = (x, z) => A * x * x + B * x * z + C * z * z + G3 * x + G4 * z + G5;
    let lo = Infinity, hi = -Infinity;
    const see = (v) => { if (v < lo) lo = v; if (v > hi) hi = v; };
    for (let k = 0; k < 3; k++) {
      const p = W[k], q = W[(k + 1) % 3], dx = q.lx - p.lx, dz = q.lz - p.lz;
      see(g(p.lx, p.lz));
      const a2 = A * dx * dx + B * dx * dz + C * dz * dz;   // g(p + t d) = a2 t^2 + a1 t + g(p)
      if (Math.abs(a2) > 1e-12) {
        const a1 = 2 * A * p.lx * dx + B * (p.lx * dz + p.lz * dx) + 2 * C * p.lz * dz + G3 * dx + G4 * dz, t = -a1 / (2 * a2);
        if (t > 0 && t < 1) see(g(p.lx + t * dx, p.lz + t * dz));
      }
    }
    const det = 4 * A * C - B * B;   // inside: 2A x + B z + G3 = 0, B x + 2C z + G4 = 0
    if (Math.abs(det) > 1e-12) {
      const x = (B * G4 - 2 * C * G3) / det, z = (B * G3 - 2 * A * G4) / det;
      const s1 = (W[1].lx - W[0].lx) * (z - W[0].lz) - (W[1].lz - W[0].lz) * (x - W[0].lx);
      const s2 = (W[2].lx - W[1].lx) * (z - W[1].lz) - (W[2].lz - W[1].lz) * (x - W[1].lx);
      const s3 = (W[0].lx - W[2].lx) * (z - W[2].lz) - (W[0].lz - W[2].lz) * (x - W[2].lx);
      if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) see(g(x, z));
    }
    return [lo, hi];
  };
  const frontAll = (o) => gRange(o, o.ctrl)[0] > 0;   // its top seen everywhere (no contour across it)
  // The reused pieces (each { M, ref }) or null.
  const reusePatch = (o, s, W, Q) => {
    const R = o.ref;
    if (!R || R.parts !== o.parts || R.light !== lightKey) return null;
    const P = R.Q;
    // affine M with M(P_k) = Q_k, k = 0..2
    const ux = P[1].x - P[0].x, uy = P[1].y - P[0].y, vx = P[2].x - P[0].x, vy = P[2].y - P[0].y, det = ux * vy - uy * vx;
    if (!(Math.abs(det) > 1e-6)) return null;
    const qx1 = Q[1].x - Q[0].x, qy1 = Q[1].y - Q[0].y, qx2 = Q[2].x - Q[0].x, qy2 = Q[2].y - Q[0].y;
    const a = (qx1 * vy - qx2 * uy) / det, c = (qx2 * ux - qx1 * vx) / det, b = (qy1 * vy - qy2 * uy) / det, d = (qy2 * ux - qy1 * vx) / det;
    const e = Q[0].x - a * P[0].x - c * P[0].y, f = Q[0].y - b * P[0].x - d * P[0].y;
    for (let k = 3; k < 7; k++) {
      const x = a * P[k].x + c * P[k].y + e, y = b * P[k].x + d * P[k].y + f;
      if (Math.abs(x - Q[k].x) > ptol || Math.abs(y - Q[k].y) > ptol) return null;
    }
    const M = { a, b, c, d, e, f };
    return R.pieces.map((p) => ({ ref: p, M, fill: p.fill, sides: p.sides }));
  };
  for (const s of shapes) {
    if (s.prebuilt) continue;   // far grass: built already
    if (s.blade) {   // grass: built after its ground patch (drawn before it), so whether that patch shows its crest is known
      const hs = s.hostS;
      if (hs && hs.pieces && hs.sil === undefined) hs.sil = hs.pieces.some((p) => p.sides.some((sd) => sd.ci === 4));
      // its lit face only where it can show: near the eye, or on the ground's outline
      const full = !grass.tips && (s.o.dist < GRASS_FULL_D || !!(hs && hs.sil));
      s.pieces = bladePieces(s.o, projector, grassShade(s.o.ground ?? s.o.fill, s.o.mid), SIDE_COLORS, full, grass.tips).pieces;
      if (grass.tips && s.o.alpha < 1) for (const p of s.pieces) p.alpha = s.o.alpha;   // fading: translucent
      if (s.pieces.length) { stats.blades++; if (full) stats.fullBlades++; }
      continue;
    }
    const o = s.o, curved = !o.kind && o.bend;
    if (curved && o.simple) o.exact = false;   // grass: always the chain
    else if (curved) {   // exact or simplified, with the margin
      if (o.exact === undefined) o.exact = s.size >= CURVE_EXACT_PX;
      else if (o.exact && s.size < CURVE_EXACT_PX - CURVE_MARGIN_PX) o.exact = false;
      else if (!o.exact && s.size > CURVE_EXACT_PX + CURVE_MARGIN_PX) o.exact = true;
    }
    let pieces;
    const g = s.grow ?? 1, fading = g < 1;
    const sh = fading && o.kind && o.kind !== 'quad' && o.kind !== 'patch' ? shrunkSheet(o, g) : o;
    if (!o.move && !s.nearCut && !fading && o.cache && o.cache.key === camKey) { pieces = o.cache.pieces; stats.reused++; }
    else if (o.kind === 'quad') pieces = quadPieces(s.proj).map((p) => ({ sides: p.sides, fill: litOf(o.fill), base: o.fill, colors: SIDE_COLORS, keep: !o.move }));
    else if (o.kind === 'patch' && !s.nearCut && o.oneSided !== false && ctrlOf(o) && gRange(o, o.ctrl)[1] <= 0) { pieces = []; stats.backGround++; }   // seen from below only
    else if (o.kind === 'patch' && reuseOn && !s.nearCut && ctrlOf(o) && frontAll(o) &&
      (pieces = reusePatch(o, s, o.ctrl, o.ctrl.map(projectPoint)))) stats.reusedGround++;
    else if (o.kind === 'patch') {   // its lit / shade parts (shadow.js) in their tones, lit first, else the whole patch
      pieces = [];
      for (const part of o.parts || [{ loop: o.loop, shade: false }]) {
        const loop = s.nearCut ? clipLoopNear(o, part.loop, (p) => depthOf(p), NEAR_CUT) : part.loop;   // only the part in front
        if (!loop) continue;
        for (const p of patchPieces(o, projector, camPos, s.nearCut ? Infinity : pxScaleOf(s), loop)) {
          if (p.flat) stats.flat++;
          const base = part.fill || o.fill;   // a part's own color (water), else the patch's
          const sh = part.shade && light.on ? (part.lamp ? lampTone(base, shadeOf(base), part.lamp) : shadeOf(base)) : litOf(base);
          pieces.push({ sides: p.sides, fill: sh, colors: SIDE_COLORS, keep: !o.move, floor: true, loop: p.loop, G: p.G, flat: !!p.flat, water: !!part.fill });
        }
      }
      // the reference for later frames: only a patch with no contour (wholly front-facing) and a whole view of it
      o.ref = null;
      if (reuseOn && !s.nearCut && ctrlOf(o) && frontAll(o) && !pieces.some((p) => p.sides.some((sd) => sd.ci === 4)))
        o.ref = { Q: o.ctrl.map(projectPoint), pieces, parts: o.parts, light: lightKey };
    }
    else if (o.kind) {
      pieces = sheetPieces(sh, projector).sort((p, q) => q.depth - p.depth)
        .map((p) => ({ sides: p.sides, fill: litOf(p.front ? o.fill : o.back), base: p.front ? o.fill : o.back, colors: SIDE_COLORS, keep: !o.move }));
    } else if (curved && o.exact) {
      if (!fading && o.exactRef && near(o.exactRef, s)) { pieces = o.exactRef.pieces; stats.kept++; }
      else {
        const tc = performance.now();
        pieces = one(o, curvedSides(o.a.c, o.bend, o.b.c, o.a.r * g, o.b.r * g, projector).sides);
        stats.curvedMs += performance.now() - tc;
        for (const p of pieces) p.keep = true;
        o.exactRef = { proj: s.proj, pieces };
      }
    } else if (curved) {
      pieces = one(o, curveChainSides(o.a.c, o.bend, o.b.c, o.a.r * g, o.b.r * g, projector,
        o.simple ? (s.size > 30 ? 3 : 1) : Math.max(2, Math.ceil(1.2 * Math.sqrt(s.size)))));
    } else pieces = one(o, capsuleSides(s.c1, s.c2));
    if (curved) { if (o.exact) stats.curved++; else stats.simplified++; }
    if (o.kind && o.kind !== 'quad' && o.kind !== 'patch') stats.sheets++;
    if (!o.move && !s.nearCut && !fading) o.cache = { key: camKey, pieces };
    setCrescents(o, pieces);
    s.pieces = pieces;
  }
  if (silhouette.on) { const ts = performance.now(); silhouetteEdges(shapes, camPos, projectPoint, fit); spikeStats.ms = performance.now() - ts; }
  const t1 = performance.now();
  // Movers' shadows on the terrain (groundShadow.js): each drawn right after the last ground patch under it, inside the lit parts of
  // those patches (one clip of all of them), as the shade overlay.
  const shadows = [];
  if (light.on && terrain && terrain.H) {
    // the drawn ground patches' boxes, once (not one scan of every shape per mover)
    let gi = null, gb = null, gn = 0;
    for (const o of tree.movers) if (!o.kind && o.shade) {
      const sh = capsuleShadow(o, terrain.H, light.dir, projector);
      if (!sh) continue;
      if (!gi) {
        gi = new Int32Array(shapes.length); gb = new Float64Array(shapes.length * 4);
        shapes.forEach((s, i) => {
          if (s.o.kind !== 'patch' || !s.pieces.length) return;
          const b = s.o.bound;
          gi[gn] = i; gb[4 * gn] = b[0].x; gb[4 * gn + 1] = b[7].x; gb[4 * gn + 2] = b[0].z; gb[4 * gn + 3] = b[7].z; gn++;
        });
      }
      let last = -1;
      const hosts = [], bx = sh.box;
      for (let k = 0; k < gn; k++) {
        if (gb[4 * k + 1] < bx.x0 || gb[4 * k] > bx.x1 || gb[4 * k + 3] < bx.z0 || gb[4 * k + 2] > bx.z1) continue;
        hosts.push(shapes[gi[k]]); last = gi[k];
      }
      if (last >= 0) shadows.push({ sh, hosts, last });
    }
  }
  return { t0, t1, fit, view, darkMode, shapes, shadows, stats, frameNo, projectPoint, camPos, forward: basis.forward,
    sky: sky.on && !darkMode ? { sunDisc: sky.sunDisc } : null, groundEdit: !!groundEdit,
    silhouette: silhouette.on && silhouette.red ? { color: silhouette.color, px: silhouette.px } : null };
}

// Canvas 2D drawing of a frame (the reference backend).
export function drawIllusion2D(ctx, canvas, F) {
  const { t0, t1, fit, view, darkMode, shapes, shadows, stats, frameNo } = F;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = darkMode ? '#000000' : '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  applyDesignSpaceTransform(ctx, canvas);
  if (F.sky) drawSky(ctx, view, { projectPoint: F.projectPoint, camPos: F.camPos, forward: F.forward, light, sunDisc: F.sky.sunDisc });
  // No stacking: each shadow leaves out the shadows drawn before it this frame (one even-odd clip each), so the ground under two
  // overlapping shadows is darkened once, to the same shade tone.
  // Reused ground pieces (`M`, `ref`): their reference path, recorded once, drawn / added under M.
  // Every piece's path is recorded once per frame (a kept piece's, once for all) and shared by the underlay and the fill.
  const pathOf = (p) => {
    const r = p.ref || p;
    if (!r.path) { const path = new Path2D(); tracePath(path, r); if (r.keep || p.ref) r.path = path; else return (r.framePath = path); }
    return r.path;
  };
  const framePathOf = (p) => (p.ref || p.keep ? pathOf(p) : p.framePath || pathOf(p));
  const traceInto = (path, p) => { if (p.M) path.addPath(pathOf(p), p.M); else path.addPath(framePathOf(p)); };
  // BATCHES: consecutive GROUND pieces of one color with nothing drawn between them are filled as one path (the same pixels for an
  // opaque color, minus the seam between them). Nonzero: only pieces wound the same way (positive area on screen) go in, else two
  // overlapping pieces would cancel where they overlap.
  const areaSign = (sides) => {
    let a = 0, px = 0, py = 0, fx = 0, fy = 0, first = true;
    const pt = (q) => { if (first) { fx = q.x; fy = q.y; first = false; } else a += px * q.y - q.x * py; px = q.x; py = q.y; };
    for (const sd of sides) { if (sd.kind === 'line') pt(sd.from); else { pt(sideStart(sd)); pt(pointOnEllipse(sd.e, (sd.t0 + sd.t1) / 2)); } }
    a += px * fy - fx * py;
    return a;
  };
  const positive = (p) => {
    const r = p.ref || p;
    if (r.sgn === undefined) r.sgn = areaSign(r.sides) > 0;
    return p.M ? r.sgn === (p.M.a * p.M.d - p.M.b * p.M.c > 0) : r.sgn;
  };
  let batch = null, batchFill = null;
  const flush = () => { if (batch) { if (ctx.fillStyle !== batchFill) ctx.fillStyle = batchFill; ctx.fill(batch); batch = null; stats.fills++; } };
  const batchPiece = (p) => {
    if (batch && batchFill !== p.fill) flush();
    if (!batch) { batch = new Path2D(); batchFill = p.fill; }
    traceInto(batch, p);
  };
  const shadowsDrawn = [];
  const drawShadow = ({ sh, hosts }) => {
    if (typeof Path2D === 'undefined') return;
    const clip = new Path2D();
    for (const s of hosts) for (const p of s.pieces) if (p.fill === litOf(s.o.fill)) traceInto(clip, p);
    ctx.save();
    ctx.clip(clip);
    for (const prev of shadowsDrawn) {
      const out = new Path2D();
      out.rect(-1e6, -1e6, 2e6, 2e6);
      tracePath(out, { sides: prev });
      ctx.clip(out, 'evenodd');
    }
    ctx.beginPath();
    tracePath(ctx, { sides: sh.sides });
    for (const pass of shadeOverlay()) { ctx.globalCompositeOperation = pass.op; ctx.fillStyle = pass.color; ctx.fill(); }
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
    shadowsDrawn.push(sh.sides);
    stats.shadows++;
  };
  // GROUND UNDERLAY (no seams): two ground shapes that meet on an edge each antialias it, so a little of what is behind both shows
  // through (a thin line). Before anything else, every ground piece drawn this frame (patches, quads) is filled once more, all of
  // one tone in ONE path (lit, then shade): the union of the ground in its own tones, with no inner edges. A seam's antialiasing
  // then blends over the ground's own tone, not the sky, whatever the draw order, level of detail or cut (lit / shade, near): no
  // neighbor bookkeeping, nothing stroked.
  if (typeof Path2D !== 'undefined') {
    const under = new Map();
    for (const s of shapes) if ((s.o.kind === 'patch' || s.o.kind === 'quad') && s.pieces) for (const p of s.pieces) {
      if (p.spike) continue;
      let path = under.get(p.fill);
      if (!path) under.set(p.fill, (path = new Path2D()));
      traceInto(path, p);
    }
    for (const [fill, path] of under) { ctx.fillStyle = fill; ctx.fill(path); stats.seams++; }
  }
  for (let si = 0; si < shapes.length; si++) {
    const s = shapes[si];
    const o = s.o;
    o.drawnFrame = frameNo;
    if (!s.pieces.length) continue;
    const ground = o.kind === 'patch' || o.kind === 'quad';
    for (const p of s.pieces) {
      if ((p.M || (ground && !p.crescents && !strokes.on && typeof Path2D !== 'undefined')) && positive(p)) batchPiece(p);
      else if (p.M) {   // a reused piece wound the other way: alone, under its map
        flush(); ctx.save(); ctx.transform(p.M.a, p.M.b, p.M.c, p.M.d, p.M.e, p.M.f);
        if (ctx.fillStyle !== p.fill) ctx.fillStyle = p.fill;
        ctx.fill(pathOf(p)); ctx.restore(); stats.fills++;
      } else if (p.alpha !== undefined && p.alpha < 1) {   // a fading piece (grass): translucent
        flush(); ctx.globalAlpha = p.alpha; drawShape(ctx, p, { stroke: strokes.on }); ctx.globalAlpha = 1; stats.fills++;
      } else { flush(); drawShape(ctx, p, { stroke: strokes.on }); stats.fills++; }
    }
    if (F.silhouette && o.kind === 'patch') {   // its silhouette sides, on top of it and under everything drawn later
      let any = false;
      for (const p of s.pieces) if (!p.M) {   // (a reused piece, under its map M, never has a contour)
        for (const sd of p.sides) if (isSilhouetteSide(sd)) {
          if (!any) { flush(); ctx.save(); ctx.beginPath(); any = true; }
          const q = sideStart(sd);
          ctx.moveTo(q.x, q.y); traceSide(ctx, sd);
        }
      }
      for (const L of s.pieces[0].silLines || []) {
        if (!any) { flush(); ctx.save(); ctx.beginPath(); any = true; }
        ctx.moveTo(L[0].x, L[0].y);
        for (let i = 1; i < L.length; i++) ctx.lineTo(L[i].x, L[i].y);
      }
      if (any) { ctx.strokeStyle = F.silhouette.color; ctx.lineWidth = F.silhouette.px / fit; ctx.lineCap = 'round'; ctx.stroke(); ctx.restore(); }
    }
    stats.drawn++;
    for (const sh of shadows) if (sh.last === si) { flush(); drawShadow(sh); }
  }
  flush();
  const t2 = performance.now();
  stats.buildMs = t1 - t0; stats.drawMs = t2 - t1;
  stats.frame = frameNo;

  drawOverlay(ctx, F);
  ctx.restore();
  return stats;
}

// What is drawn over a frame in Canvas 2D whatever the backend (ctx in design space): the ground edit's aim, the Debug view.
function drawOverlay(ctx, F) {
  const { fit, view, darkMode, shapes } = F;
  if (F.groundEdit) {   // the grid's aim (main.js: E digs, R places at the screen's center)
    const cx = (view.x0 + view.x1) / 2, cy = (view.y0 + view.y1) / 2, r = 7;
    ctx.lineCap = 'round';
    for (const [w, c] of [[3.5 / fit, 'rgba(0, 0, 0, 0.45)'], [1.5 / fit, 'rgba(255, 255, 255, 0.9)']]) {
      ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
      ctx.lineWidth = w; ctx.strokeStyle = c; ctx.stroke();
    }
  }
  if (debug.on) {   // a sheet's edges (1 canvas px, on top); other objects' node centers
    ctx.strokeStyle = ctx.fillStyle = darkMode ? '#ffffff' : '#000000';
    ctx.lineWidth = 1 / fit; ctx.lineJoin = 'round';
    ctx.beginPath();
    for (const s of shapes) if (s.o.kind) for (const p of s.pieces) if (!p.spike) tracePath(ctx, p);   // (not the grass edge's spikes)
    ctx.stroke();
    for (const s of shapes) if (!s.o.kind) for (const q of s.proj) { ctx.beginPath(); ctx.arc(q.x, q.y, 2, 0, Math.PI * 2); ctx.fill(); }
    // the BLOCK GRID (grid.js cubes, the player's scale) on the ground around the eye: the terrain's patches are no guide (flat ground
    // is drawn with triangles many cubes wide)
    const G = walkGround();
    if (G) {
      const c = G.cube, R = 10, e = F.camPos, i0 = Math.floor(e.x / c) - R, k0 = Math.floor(e.z / c) - R, step = c / 4;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)'; ctx.lineWidth = 1 / fit;
      ctx.beginPath();
      const run = (x0, z0, dx, dz) => {   // a grid line on the ground, broken where it passes behind the eye
        let pen = false;
        for (let t = 0; t <= 2 * R * c + 1e-9; t += step) {
          const x = x0 + dx * t, z = z0 + dz * t, q = F.projectPoint({ x, y: G.height(x, z), z });
          if (!(q.scale > 0) || q.scale > 50) { pen = false; continue; }
          if (pen) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y);
          pen = true;
        }
      };
      for (let i = i0; i <= i0 + 2 * R; i++) run(i * c, k0 * c, 0, 1);
      for (let k = k0; k <= k0 + 2 * R; k++) run(i0 * c, k * c, 1, 0);
      ctx.stroke();
    }
  }
}

// The overlay alone on a transparent 2D canvas stacked over a GPU backend's canvas.
export function drawIllusionOverlay(ctx, canvas, F) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!F.groundEdit && !debug.on) return;
  ctx.save();
  applyDesignSpaceTransform(ctx, canvas);
  drawOverlay(ctx, F);
  ctx.restore();
}
