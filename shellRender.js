// Draws the shells scene (CLAUDE.md "Shells"): each shell's pieces as exact elliptic arcs, back to front.
import { debug, lighting, light, strokes } from './config.js';
import { TWILIGHT, LIT, toneColor } from './light.js';
import { camera, getCameraPosition, computeViewBasis, worldToCamera, makeProjector, makeConicProjector } from './camera.js';
import { applyDesignSpaceTransform, scratchLayers } from './render.js';
import { vecDot, vecSub } from './geometry.js';
import { shells, shellPieces, shellFrame, shellRange, worldEllipse, circlePoint, capRegion } from './shell.js';

const TWO_PI = Math.PI * 2;
const mod2pi = (x) => ((x % TWO_PI) + TWO_PI) % TWO_PI;
const DEGENERATE_PX = 1e-3;
const boxesMeet = (p, q) => p.x0 <= q.x1 && q.x0 <= p.x1 && p.y0 <= q.y1 && q.y0 <= p.y1;
// The same-colored fills behind are eroded by this much (canvas px) before they mask the stroke: where a shell's two faces meet on its
// contour their edges coincide, and the back face's antialiased edge would leave a faint stroke along the silhouette.
const ERODE_PX = 1;
// The tone map (CLAUDE.md "Shells"): one scratch layer per tone, opaque where the face on top has that tone (Shade will take layer 5).
const TONE_LAYERS = { [LIT]: 3, [TWILIGHT]: 4 };

// The draw order: back to front by center depth, except that a flat shell and a shell lying wholly on one side of its plane (by the
// exact range of the cut region, `shellRange`) are ordered by that plane: the one on the camera's side draws later. Kahn's algorithm
// on those constraints, taking the farthest ready shell each time (the farthest left when the constraints cycle).
function orderShells(list, camPos, depthOf) {
  const after = new Map(list.map(s => [s, new Set()]));   // s -> the shells that must draw before s
  for (const A of list) {
    if (!(A.roundness < 1e-9)) continue;
    const f = shellFrame(A), side = Math.sign(vecDot(f.a, vecSub(camPos, f.c))), tol = 1e-6 * A.radius;
    for (const B of list) {
      if (B === A) continue;
      const r = shellRange(B, f.a);
      if (!r) continue;
      const off = vecDot(f.a, f.c), lo = r.lo - off, hi = r.hi - off;
      const sideB = lo >= -tol ? 1 : hi <= tol ? -1 : 0;
      if (!sideB || !side) continue;
      if (sideB === side) after.get(B).add(A); else after.get(A).add(B);
    }
  }
  const left = [...list].sort((p, q) => depthOf(q) - depthOf(p)), done = new Set(), out = [];
  while (left.length) {
    let k = left.findIndex(s => [...after.get(s)].every(o => done.has(o)));
    if (k < 0) k = 0;
    const [s] = left.splice(k, 1);
    done.add(s); out.push(s);
  }
  return out;
}

export function renderShells(ctx, canvas, { darkMode }) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = debug.on && debug.gap ? '#ff00ff' : (darkMode ? '#000000' : '#ffffff');
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  applyDesignSpaceTransform(ctx, canvas);

  const camPos = getCameraPosition(), basis = computeViewBasis(camPos, camera.target);
  const { projectPoint } = makeProjector(camPos, basis);
  const { projectedEllipse, paramOn } = makeConicProjector(camPos, basis, projectPoint);
  const depthOf = (s) => worldToCamera(s.center, camPos, basis).z;
  const toScreen = (f, u) => { const w = f.toWorld(u), q = projectPoint({ x: f.c.x + w.x, y: f.c.y + w.y, z: f.c.z + w.z }); return [q.x, q.y]; };

  // Traces a region's loops (throws 'behind' if a circle crosses the camera's plane: the shell is skipped). `edgesOnly`: only the arcs
  // on the face's own edge, as open runs, leaving out the terminator (the light cap's arcs): a tone region's share of the face outline.
  const traceRegion = (path, f, region, box, edgesOnly = false) => {
    for (const loop of region.loops) {
      const isTerm = (r) => edgesOnly && region.circles[r.ci].term;
      const open = loop.some(isTerm), start = open ? (loop.findIndex(isTerm) + 1) % loop.length : 0;
      let pen = false;
      for (let j = 0; j < loop.length; j++) {
        const r = loop[(start + j) % loop.length], ci = region.circles[r.ci];
        if (isTerm(r)) { pen = false; continue; }
        const W = worldEllipse(f, ci), e = projectedEllipse(W.C, W.U, W.V);
        if (!e) throw new Error('behind');
        const ext = Math.max(e.a, e.b);
        box.x0 = Math.min(box.x0, e.x - ext); box.x1 = Math.max(box.x1, e.x + ext);
        box.y0 = Math.min(box.y0, e.y - ext); box.y1 = Math.max(box.y1, e.y + ext);
        const P0 = toScreen(f, circlePoint(ci, r.t0)), P1 = toScreen(f, circlePoint(ci, r.t1)), Pm = toScreen(f, circlePoint(ci, (r.t0 + r.t1) / 2));
        if (!pen) { path.moveTo(P0[0], P0[1]); pen = true; }
        if (e.b < DEGENERATE_PX) { path.lineTo(Pm[0], Pm[1]); path.lineTo(P1[0], P1[1]); continue; }
        const s0 = paramOn(e, P0);
        if (r.whole) {
          const up = mod2pi(paramOn(e, toScreen(f, circlePoint(ci, r.t0 + Math.PI / 2))) - s0) < Math.PI;
          path.ellipse(e.x, e.y, e.a, e.b, e.angle, s0, up ? s0 + TWO_PI : s0 - TWO_PI, !up);
          continue;
        }
        const span = mod2pi(paramOn(e, P1) - s0), up = mod2pi(paramOn(e, Pm) - s0) <= span;
        path.ellipse(e.x, e.y, e.a, e.b, e.angle, s0, up ? s0 + span : s0 - (TWO_PI - span), !up);
      }
      if (!open) path.closePath();
    }
  };

  // Each face of each shell is one fill with its own owner (`id.inner` / `id.outer`): the base path, filled in Twilight, and its lit
  // part over it (with the light off, one path in the Lit tone). `tones`: each tone's exact region (`fill`) and its share of the face's
  // outline (`edges`), for the border strokes and the tone map.
  const units = [];
  const list = Object.values(shells).filter(s => depthOf(s) > 0);
  for (const s of orderShells(list, camPos, depthOf)) {
    const pieces = shellPieces(s, camPos, light.dir, lighting.on);
    try {
      const mine = [];
      for (const face of ['inner', 'outer']) {
        const ps = pieces.filter(pc => pc.face === face);
        const basePc = lighting.on ? ps.find(pc => !pc.lit && !pc.dark) : ps[0];
        if (!basePc) continue;
        const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
        const trace = (pc, edgesOnly) => { const path = new Path2D(); traceRegion(path, pc.frame, pc.region, box, edgesOnly); return path; };
        const path = trace(basePc);
        const toneOf = (pc, tone) => ({ tone, fill: pc === basePc ? path : trace(pc), edges: trace(pc, true) });
        const tones = lighting.on
          ? [[ps.find(pc => pc.lit), LIT], [ps.find(pc => pc.dark), TWILIGHT]].filter(([pc]) => pc).map(([pc, t]) => toneOf(pc, t))
          : [toneOf(basePc, LIT)];
        const lit = lighting.on ? (tones.find(t => t.tone === LIT) || {}).fill || null : null;
        mine.push({ owner: s.id + '.' + face, color: face === 'inner' ? s.innerColor : s.color, path, lit, tones, box });
      }
      units.push(...mine);
    } catch (err) {
      if (err.message !== 'behind') throw err;
    }
  }
  drawUnits(ctx, units);

  if (debug.on) drawShellDebug(ctx, list, camPos, projectedEllipse);
}

// Fills the faces in order. With strokes on, a face drawn over an earlier face of the SAME color (another shell's, or its own shell's
// other face) first gets a border stroke under it (CLAUDE.md "Shells"), per tone of the front: that tone region's share of the outline
// stroked 2 `strokes.px` wide in the next darker tone (Lit -> Twilight, Twilight -> Shade), masked to where an earlier same-colored face
// is on top (eroded by ERODE_PX) and to where the tone map has the same tone; the fill then covers its inner half.
function drawUnits(ctx, units) {
  const base = ctx.getTransform(), pxPerUnit = Math.hypot(base.a, base.b);
  const painted = [];
  const layers = strokes.on ? scratchLayers(ctx) : null;
  const clear = (g, x0, y0, w, h) => { g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-over'; g.clearRect(x0, y0, w, h); };
  const toneLayer = (tone) => layers[TONE_LAYERS[tone]];
  if (layers) Object.values(TONE_LAYERS).forEach(i => clear(layers[i].getContext('2d'), 0, 0, layers[i].width, layers[i].height));
  const strokeUnder = (u) => {
    const others = painted.filter(q => q.owner !== u.owner && q.color === u.color && boxesMeet(q.box, u.box));
    if (!others.length) return;
    const [sl, ml] = layers, s = sl.getContext('2d'), m = ml.getContext('2d');
    const pad = (2 * strokes.px + 2) / pxPerUnit, b = u.box;
    const x0 = Math.max(0, Math.floor(base.a * (b.x0 - pad) + base.e)), y0 = Math.max(0, Math.floor(base.d * (b.y0 - pad) + base.f));
    const x1 = Math.min(sl.width, Math.ceil(base.a * (b.x1 + pad) + base.e)), y1 = Math.min(sl.height, Math.ceil(base.d * (b.y1 + pad) + base.f));
    if (x1 <= x0 || y1 <= y0) return;
    const w = x1 - x0, h = y1 - y0;
    // Where a same-colored earlier face is on top (a later face of another color covers it again).
    clear(m, x0, y0, w, h);
    m.setTransform(base); m.fillStyle = '#ffffff';
    painted.forEach(q => {
      if (!boxesMeet(q.box, u.box)) return;
      m.globalCompositeOperation = q.color === u.color && q.owner !== u.owner ? 'source-over' : 'destination-out';
      m.fill(q.path);
    });
    m.globalCompositeOperation = 'destination-out'; m.lineWidth = 2 * ERODE_PX / pxPerUnit; m.strokeStyle = '#000000';
    others.forEach(q => m.stroke(q.path));
    for (const { tone, edges } of u.tones) {
      clear(s, x0, y0, w, h);
      s.setTransform(base); s.lineWidth = 2 * strokes.px / pxPerUnit; s.lineJoin = 'round'; s.strokeStyle = '#000000'; s.stroke(edges);
      s.setTransform(1, 0, 0, 1, 0, 0);
      s.globalCompositeOperation = 'destination-in'; s.drawImage(ml, x0, y0, w, h, x0, y0, w, h);
      s.drawImage(toneLayer(tone), x0, y0, w, h, x0, y0, w, h);
      s.globalCompositeOperation = 'source-in'; s.fillStyle = toneColor(u.color, tone - 1); s.fillRect(x0, y0, w, h);
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(sl, x0, y0, w, h, x0, y0, w, h); ctx.restore();
    }
  };
  for (const u of units) {
    if (layers) strokeUnder(u);
    ctx.fillStyle = toneColor(u.color, lighting.on ? TWILIGHT : LIT);
    ctx.fill(u.path);
    if (u.lit) { ctx.fillStyle = toneColor(u.color, LIT); ctx.fill(u.lit); }
    if (layers) {
      // The tone map: the face now on top, by tone.
      for (const i of Object.values(TONE_LAYERS)) {
        const g = layers[i].getContext('2d');
        g.setTransform(base); g.globalCompositeOperation = 'destination-out'; g.fill(u.path);
      }
      for (const { tone, fill } of u.tones) {
        const g = toneLayer(tone).getContext('2d');
        g.globalCompositeOperation = 'source-over'; g.fillStyle = '#ffffff'; g.fill(fill);
      }
    }
    painted.push(u);
  }
}

// Debug: every cut's whole circle (dashed gray) and each shell's silhouette (dashed purple).
function drawShellDebug(ctx, list, camPos, projectedEllipse) {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  const stroke = (f, ci, color) => {
    const W = worldEllipse(f, ci), e = projectedEllipse(W.C, W.U, W.V);
    if (!e) return;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.ellipse(e.x, e.y, e.a, e.b, e.angle, 0, TWO_PI);
    ctx.stroke();
  };
  for (const s of list) {
    const f = shellFrame(s);
    s.cuts.forEach(k => { const reg = capRegion([k]); if (reg.circles) stroke(f, reg.circles[0], '#888888'); });
    if (f.flat) continue;
    const p = f.toU(vecSub(camPos, f.c)), pl = Math.hypot(...p);
    if (pl <= 1) continue;
    const reg = capRegion([{ n: [p[0] / pl, p[1] / pl, p[2] / pl], d: 1 / pl }]);
    if (reg.circles) stroke(f, reg.circles[0], '#8e24aa');
  }
  ctx.restore();
}
