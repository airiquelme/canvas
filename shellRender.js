// Draws the shells scene (CLAUDE.md "Shells"): each shell's pieces as exact elliptic arcs, back to front.
import { debug, lighting, light, strokes } from './config.js';
import { TWILIGHT, LIT, toneColor } from './light.js';
import { camera, getCameraPosition, computeViewBasis, worldToCamera, makeProjector, makeConicProjector } from './camera.js';
import { applyDesignSpaceTransform, scratchLayers } from './render.js';
import { vecDot, vecSub } from './geometry.js';
import { shells, shellPieces, shellFrame, shellRange, worldEllipse, circlePoint, capRegion, jointOrder } from './shell.js';

const TWO_PI = Math.PI * 2;
const mod2pi = (x) => ((x % TWO_PI) + TWO_PI) % TWO_PI;
const DEGENERATE_PX = 1e-3;
// Debug: points per arc of a shade line when looking for where it reaches another shell.
const TERM_SAMPLES = 240;
const boxesMeet = (p, q) => p.x0 <= q.x1 && q.x0 <= p.x1 && p.y0 <= q.y1 && q.y0 <= p.y1;
// The same-colored fills behind are eroded by this much (canvas px) before they mask the stroke: where a shell's two faces meet on its
// contour their edges coincide, and the back face's antialiased edge would leave a faint stroke along the silhouette.
const ERODE_PX = 1;
// A joint's no-stroke zone is its ball's silhouette grown by this much (canvas px).
const ZONE_GROW_PX = 1;
// The tone map (CLAUDE.md "Shells"): one scratch layer per tone, opaque where the face on top has that tone (Shade will take layer 5).
const TONE_LAYERS = { [LIT]: 3, [TWILIGHT]: 4 };

// The draw order, back to front. A unit is a shell, or a whole joint (its ball and limbs tile one surface, drawn together). Units sort by
// the straight-line distance from the camera to their center, farthest first: O(n log n), nothing pairwise, so a field of small shells
// costs a sort. A flat shell (a floor, a wall) is the one exception: units wholly on its camera's side draw after it, units wholly on the
// other side before it (a unit crossing the plane goes by its center's side). Sides come from a bounding sphere (one dot product) and
// only when that is inconclusive from the exact range of the cut region (`shellRange`, cached). The flat shell is then moved into place in the sorted array
// (units forced before it that sorted after it are moved up to it): O(n) per flat shell, and no cycles are possible.
const reach = (s) => Math.max(s.radius, s.radius * s.roundness);
export function orderShells(list, camPos) {
  const groups = new Map(), units = [];
  for (const s of list) {
    if (s.group == null) { units.push({ shells: [s], c: s.center, R: reach(s) }); continue; }
    let u = groups.get(s.group);
    if (!u) { u = { shells: [], c: null, R: 0 }; groups.set(s.group, u); units.push(u); }
    u.shells.push(s);
  }
  for (const u of groups.values()) {
    u.shells.sort((p, q) => (q.id === q.group) - (p.id === p.group));   // the ball first
    u.c = u.shells[0].center;
    u.R = Math.max(...u.shells.map(s => Math.hypot(s.center.x - u.c.x, s.center.y - u.c.y, s.center.z - u.c.z) + reach(s)));
  }
  for (const u of units) u.key = Math.hypot(u.c.x - camPos.x, u.c.y - camPos.y, u.c.z - camPos.z);
  let arr = units.sort((p, q) => q.key - p.key);
  const flats = arr.filter(u => u.shells.length === 1 && u.shells[0].roundness < 1e-9);   // farthest first
  for (const A of flats) {
    const f = shellFrame(A.shells[0]), side = Math.sign(vecDot(f.a, vecSub(camPos, f.c)));
    if (!side) continue;
    const off = vecDot(f.a, f.c), tol = 1e-6 * A.shells[0].radius;
    // +1: on the camera's side of A (draws after it), -1: behind it. A unit crossing the plane goes by its center's side (things resting
    // on a floor are mostly above it; the part below is what a cut by the floor will remove later).
    const sideOf = (U) => {
      const d = vecDot(f.a, U.c) - off;
      if (d > U.R + tol) return side > 0 ? 1 : -1;
      if (d < -U.R - tol) return side > 0 ? -1 : 1;
      let lo = Infinity, hi = -Infinity;
      for (const s of U.shells) { const r = shellRange(s, f.a); if (r) { lo = Math.min(lo, r.lo - off); hi = Math.max(hi, r.hi - off); } }
      const sg = lo > hi ? 0 : lo >= -tol ? 1 : hi <= tol ? -1 : 0;
      return (sg || (d >= 0 ? 1 : -1)) * side;
    };
    const rest = arr.filter(U => U !== A), cls = rest.map(U => sideOf(U));
    let lo = -1, hi = rest.length;
    cls.forEach((c, k) => { if (c < 0) lo = k; });
    for (let k = 0; k < rest.length; k++) if (cls[k] > 0) { hi = k; break; }
    if (lo < hi) {
      let p = rest.findIndex(U => U.key <= A.key);
      if (p < 0) p = rest.length;
      p = Math.min(Math.max(p, lo + 1), hi);
      arr = [...rest.slice(0, p), A, ...rest.slice(p)];
    } else {
      const late = rest.filter((U, k) => k >= hi && cls[k] < 0);
      arr = [...rest.slice(0, hi), ...late, A, ...rest.slice(hi).filter((U, k) => !(cls[k + hi] < 0))];
    }
  }
  return arr.flatMap(u => u.shells);
}

export function renderShells(ctx, canvas, { darkMode }) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = debug.on && debug.gap ? '#ff00ff' : (darkMode ? '#000000' : '#ffffff');
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  applyDesignSpaceTransform(ctx, canvas);

  const camPos = getCameraPosition(), basis = computeViewBasis(camPos, camera.target);
  const { projectPoint } = makeProjector(camPos, basis);
  const { projectedEllipse, paramOn } = makeConicProjector(camPos, basis, projectPoint);
  const depthOf = (s) => worldToCamera(s.depthPoint || s.center, camPos, basis).z;
  const toScreen = (f, u) => { const w = f.toWorld(u), q = projectPoint({ x: f.c.x + w.x, y: f.c.y + w.y, z: f.c.z + w.z }); return [q.x, q.y]; };

  // Traces a region's loops (throws 'behind' if a circle crosses the camera's plane: the shell is skipped). `edgesOnly`: only the arcs
  // on the face's own edge, as open runs, leaving out the terminator (the light cap's arcs): a tone region's share of the face outline.
  const traceRegion = (path, f, region, box, edgesOnly = false, termOnly = false) => {
    for (const loop of region.loops) {
      const isTerm = (r) => termOnly ? !region.circles[r.ci].term : edgesOnly && region.circles[r.ci].term;
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
  // A joint ball's silhouette (its front cap's circle) as a screen path, grown a little: where the group's members don't stroke.
  const zoneOf = (z) => {
    const f = shellFrame(z), p = f.toU(vecSub(camPos, f.c)), pl = Math.hypot(...p);
    if (f.flat || pl <= 1) return null;
    const reg = capRegion([{ n: [p[0] / pl, p[1] / pl, p[2] / pl], d: 1 / pl }]);
    const W = worldEllipse(f, reg.circles[0]), e = projectedEllipse(W.C, W.U, W.V);
    if (!e) return null;
    const path = new Path2D(), tf = ctx.getTransform(), g = ZONE_GROW_PX / Math.hypot(tf.a, tf.b);
    path.ellipse(e.x, e.y, e.a + g, e.b + g, e.angle, 0, TWO_PI);
    return path;
  };
  const units = [], termLines = [], termArcs = [];
  const list = Object.values(shells).filter(s => depthOf(s) > 0);
  const order = orderShells(list, camPos);
  for (const s of order) {
    // The shading: the dark area of the shell as a lone full spheroid (below), cut by what the face has. With strokes on, the face's own
    // tone regions are also built (the stroke code reads them), as before.
    const wantTones = lighting.on && strokes.on, shade = lighting.on && !strokes.on;
    const pieces = shellPieces(s, camPos, light.dir, wantTones);
    try {
      // The terminator of the shell as a lone, full spheroid (no cuts, no joint): its front half solid, its back half dashed (Debug view).
      // The area that line and the silhouette enclose on its dark side (`darkFull`, per face) is what is shaded, where the shell has
      // surface (its own face) and until a shell drawn later covers it; 
      const darkFull = {};
      if (debug.on || shade) {
        for (const pc of shellPieces({ ...s, cuts: [], sunCap: null }, camPos, light.dir, true)) {
          const path = new Path2D();
          if (pc.dark) {
            const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
            traceRegion(path, pc.frame, pc.region, box);
            darkFull[pc.face] = { path, box };
          } else if (pc.lit && debug.on) {
            traceRegion(path, pc.frame, pc.region, { x0: 0, y0: 0, x1: 0, y1: 0 }, false, true);
            termLines.push({ path, dashed: pc.face === 'inner' });
            if (pc.face === 'outer' && s.group != null) {   // the solid line as points, to find where it reaches the other shells of its joint
              const arcs = [];
              for (const loop of pc.region.loops) for (const r of loop) {
                const ci = pc.region.circles[r.ci];
                if (!ci.term) continue;
                const t1 = r.whole ? r.t0 + TWO_PI : r.t1, arc = [];
                for (let k = 0; k <= TERM_SAMPLES; k++) arc.push(toScreen(pc.frame, circlePoint(ci, r.t0 + (t1 - r.t0) * k / TERM_SAMPLES)));
                arcs.push(arc);
              }
              termArcs.push({ sid: s.id, group: s.group, arcs });
            }
          }
        }
      }
      // The faces with the cuts at their own planes (no underlap): their tones, the Debug fill and the dots follow the seams themselves. The
      // overlapped faces only cover the seams' antialiasing (`cover`, painted first for the whole joint).
      const nominal = {};
      if ((debug.on || shade) && s.cuts.some(k => k.nominal !== undefined)) {
        const cuts = s.cuts.map(k => (k.nominal !== undefined ? { ...k, d: k.nominal } : k));
        const trace0 = (pc) => { const path = new Path2D(); traceRegion(path, pc.frame, pc.region, { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }); return path; };
        for (const pc of shellPieces({ ...s, cuts, sunCap: null }, camPos, light.dir, lighting.on)) {
          const n = nominal[pc.face] || (nominal[pc.face] = {});
          if (!lighting.on || (!pc.lit && !pc.dark)) n.path = trace0(pc);
          else if (pc.dark) n.dark = trace0(pc);
          else n.lit = trace0(pc);
        }
      }
      const mine = [];
      for (const face of ['inner', 'outer']) {
        const ps = pieces.filter(pc => pc.face === face);
        const basePc = wantTones ? ps.find(pc => !pc.lit && !pc.dark) : ps[0];
        if (!basePc) continue;
        const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
        const trace = (pc, edgesOnly) => { const path = new Path2D(); traceRegion(path, pc.frame, pc.region, box, edgesOnly); return path; };
        const real = trace(basePc), nom = nominal[face] && nominal[face].path, path = nom && !wantTones ? nom : real;
        const toneOf = (pc, tone) => ({ tone, fill: pc === basePc ? path : trace(pc), edges: trace(pc, true) });
        const tones = wantTones
          ? [[ps.find(pc => pc.lit), LIT], [ps.find(pc => pc.dark), TWILIGHT]].filter(([pc]) => pc).map(([pc, t]) => toneOf(pc, t))
          : [toneOf(basePc, LIT)];
        const lit = wantTones ? (tones.find(t => t.tone === LIT) || {}).fill || null : null;
        mine.push({ cover: path !== real && face === 'outer' ? real : null, regions: shade && path !== real && face === 'outer' ? { lit: nominal[face].lit || null, dark: nominal[face].dark || null } : null, nomPath: nom || null, sid: s.id, hatch: debug.on ? darkFull[face] || null : null, shade, dark: darkFull[face] || null, dashed: face === 'inner', owner: s.id + '.' + face, group: s.group, zone: s.zone && shells[s.zone] ? zoneOf(shells[s.zone]) : null, color: face === 'inner' ? s.innerColor : s.color, path, lit, tones, box });
      }
      units.push(...mine);
    } catch (err) {
      if (err.message !== 'behind') throw err;
    }
  }
  // A joint's linings are painted before its outer faces, so a limb's lining never covers the ball or the other limb; within each, its
  // members go farthest first (`jointOrder`: exact, by the planes that separate them).
  for (let i = 0; i < units.length;) {
    const g = units[i].group;
    if (g == null) { i++; continue; }
    let j = i;
    while (j < units.length && units[j].group === g) j++;
    const run = units.slice(i, j), rank = new Map(jointOrder([...new Set(run.map(u => shells[u.sid]))], camPos).map((s, k) => [s.id, k]));
    run.sort((p, q) => p.dashed !== q.dashed ? (q.dashed - p.dashed) : rank.get(p.sid) - rank.get(q.sid));
    units.splice(i, j - i, ...run);
    i = j;
  }
  // Debug: where the solid shade line of a shell reaches the outline of another outer face of its joint (red dots).
  const dots = [];
  if (debug.on) {
    const tf = ctx.getTransform(), inside = (path, p) => { const q = tf.transformPoint({ x: p[0], y: p[1] }); return ctx.isPointInPath(path, q.x, q.y); };
    const outers = units.filter(u => !u.dashed && u.group != null);
    for (const ta of termArcs) for (const arc of ta.arcs) for (const O of outers) {
      if (O.sid === ta.sid || O.group !== ta.group) continue;
      const op = O.nomPath || O.path;
      let prev = inside(op, arc[0]);
      for (let k = 1; k < arc.length; k++) {
        const cur = inside(op, arc[k]);
        if (cur !== prev) {
          let a = arc[k - 1], b = arc[k];
          for (let it = 0; it < 20; it++) { const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; if (inside(op, m) === prev) a = m; else b = m; }
          dots.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
        }
        prev = cur;
      }
    }
  }
  drawUnits(ctx, units);
  if (termLines.length) {
    const tf = ctx.getTransform(), pxPerUnit = Math.hypot(tf.a, tf.b);
    // The terminator lines are debug: over everything, a dark line on a light halo so they read on any background.
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const [w, c] of [[2.5, '#ffffff'], [1, '#111111']]) {
      ctx.lineWidth = w / pxPerUnit; ctx.strokeStyle = c;
      termLines.forEach(l => { ctx.setLineDash(l.dashed ? [6 / pxPerUnit, 5 / pxPerUnit] : []); ctx.stroke(l.path); });
    }
    ctx.setLineDash([]);
  }
  if (dots.length) {
    const tf = ctx.getTransform(), k = 1 / Math.hypot(tf.a, tf.b);
    for (const [x, y] of dots) {
      ctx.beginPath(); ctx.arc(x, y, 2 * k, 0, TWO_PI);
      ctx.fillStyle = '#e53935'; ctx.fill();
    }
  }

  if (debug.on) {
    drawShellDebug(ctx, list, camPos, projectedEllipse);
    // The draw layer of each shell (1 = drawn first, at the bottom), at its center (a limb: the middle of its length).
    const k = 1 / Math.hypot(ctx.getTransform().a, ctx.getTransform().b);
    ctx.save();
    ctx.font = `bold ${16 * k}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    order.forEach((s, i) => {
      const q = projectPoint(s.depthPoint || s.center);
      ctx.lineWidth = 4 * k; ctx.strokeStyle = '#ffffff'; ctx.strokeText(String(i + 1), q.x, q.y);
      ctx.fillStyle = '#111111'; ctx.fillText(String(i + 1), q.x, q.y);
    });
    ctx.restore();
  }
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
    const mates = (q) => u.group != null && q.group === u.group;
    const others = painted.filter(q => q.owner !== u.owner && q.color === u.color && boxesMeet(q.box, u.box) && !(mates(q) && !u.zone));
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
    if (u.zone) { m.globalCompositeOperation = 'destination-out'; m.fill(u.zone); }
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
  for (let idx = 0; idx < units.length; idx++) {
    const u = units[idx];
    // The start of a joint's outer faces: its overlapped faces first, under every tone, so the antialiased seams blend over paint of the right
    // tone, not background and not the linings (which are lit where the outside is dark and showed through the seams as a thin lit line).
    const prev = units[idx - 1];
    if (u.group != null && !u.dashed && (!prev || prev.group !== u.group || prev.dashed)) {
      for (let k = idx; k < units.length && units[k].group === u.group && !units[k].dashed; k++) {
        const v = units[k];
        if (!v.cover) continue;
        // In the face's own tones, so a seam's antialiasing blends over the right color.
        ctx.fillStyle = toneColor(v.color, lighting.on && v.dark ? TWILIGHT : LIT); ctx.fill(v.cover);
        if (lighting.on && v.dark) {
          const rest = new Path2D();
          rest.rect(-1e6, -1e6, 2e6, 2e6); rest.addPath(v.dark.path);
          ctx.save(); ctx.clip(rest, 'evenodd'); ctx.fillStyle = toneColor(v.color, LIT); ctx.fill(v.cover); ctx.restore();
        }
      }
    }
    if (layers) strokeUnder(u);
    if (u.regions) {
      // A joint's face: its lit part and its dark part as two regions of their own, so the face's edge is antialiased once (a Twilight base
      // under a Lit overlay left a dark fringe along every seam), over the overlapped faces painted first.
      if (u.regions.lit) { ctx.fillStyle = toneColor(u.color, LIT); ctx.fill(u.regions.lit); }
      if (u.regions.dark) { ctx.fillStyle = toneColor(u.color, TWILIGHT); ctx.fill(u.regions.dark); }
    } else if (u.shade) {
      // Twilight everywhere, the Lit tone over the face outside the dark area (a face with no dark area is all Lit).
      ctx.fillStyle = toneColor(u.color, u.dark ? TWILIGHT : LIT);
      ctx.fill(u.path);
      if (u.dark) {
        const rest = new Path2D();
        rest.rect(-1e6, -1e6, 2e6, 2e6); rest.addPath(u.dark.path);
        ctx.save(); ctx.clip(rest, 'evenodd'); ctx.fillStyle = toneColor(u.color, LIT); ctx.fill(u.path); ctx.restore();
      }
    } else {
      ctx.fillStyle = toneColor(u.color, lighting.on ? TWILIGHT : LIT);
      ctx.fill(u.path);
      if (u.lit) { ctx.fillStyle = toneColor(u.color, LIT); ctx.fill(u.lit); }
    }
    if (u.hatch) {   // Debug: the face's part of the enclosed dark area in pitch black (later faces cover it like any fill)
      ctx.save(); ctx.clip(u.nomPath || u.path); ctx.clip(u.hatch.path);
      ctx.fillStyle = '#000000'; ctx.fill(u.hatch.path);
      ctx.restore();
    }
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
  const seen = new Set();
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
    // Each cut at its own plane (`nominal`: not the underlap's offset copy), and a plane shared by two shells (a joint's rim or stop edge,
    // one circle on each) once.
    s.cuts.forEach(k => {
      const reg = capRegion([{ n: k.n, d: k.nominal !== undefined ? k.nominal : k.d }]);
      if (!reg.circles) return;
      const W = worldEllipse(f, reg.circles[0]), cx = W.U.y * W.V.z - W.U.z * W.V.y, cy = W.U.z * W.V.x - W.U.x * W.V.z, cz = W.U.x * W.V.y - W.U.y * W.V.x;
      const area = Math.hypot(cx, cy, cz), sg = (cx || cy || cz) < 0 ? -1 : 1, r = (v) => Math.round(v * 100) / 100;
      const key = [r(W.C.x), r(W.C.y), r(W.C.z), r(sg * cx / area), r(sg * cy / area), r(sg * cz / area), r(area)].join();
      if (seen.has(key)) return;
      seen.add(key);
      stroke(f, reg.circles[0], '#888888');
    });
    if (f.flat) continue;
    const p = f.toU(vecSub(camPos, f.c)), pl = Math.hypot(...p);
    if (pl <= 1) continue;
    const reg = capRegion([{ n: [p[0] / pl, p[1] / pl, p[2] / pl], d: 1 / pl }]);
    if (reg.circles) stroke(f, reg.circles[0], '#8e24aa');
  }
  ctx.restore();
}
