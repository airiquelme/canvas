// The PLAN of a frame for the GPU backends (webgl2.js, webgpu.js): the frame's entries in draw order (each piece's fill, its
// crescents, a mover's shadow after its last host shape), their depths, their groups of disjoint boxes and their vertices; and the
// ground underlay. The backends only replay it with their own API.
import { trianglesOf, beginFrame, Sink } from './tessellate.js';
import { litOf } from '../illusion/light.js';

const rgbCache = new Map();
// A CSS color (#rrggbb or rgb(a)(r, g, b, ...)) as 0-1 floats.
export function rgbOf(css) {
  let v = rgbCache.get(css);
  if (!v) {
    if (css[0] === '#') { const n = parseInt(css.slice(1), 16); v = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; }
    else v = css.match(/[\d.]+/g).slice(0, 3).map((x) => Number(x) / 255);
    if (rgbCache.size > 8192) rgbCache.clear();
    rgbCache.set(css, v);
  }
  return v;
}

const CELL = 24;   // design px per cell of the grouping grid
const UNDER_PX = 2;   // the ground underlay's band width (canvas px)
const TAPER_PX = 3;   // its taper (canvas px) where a side meets the ground's outline
const PX = new Float64Array(80), PY = new Float64Array(80), CUM = new Float64Array(80);   // a side's polyline (at most 65 points)
const ellipsePoint = (e, t) => {
  const ca = Math.cos(e.angle), sa = Math.sin(e.angle), c = Math.cos(t) * e.a, s = Math.sin(t) * e.b;
  return { x: e.x + c * ca - s * sa, y: e.y + c * sa + s * ca };
};

// THE PLAN of a frame, shared by the GPU backends: the entries in draw order, their depths, groups and vertex ranges.
//   sSink: stencil triangles [x, y, u, v, mode]; cSink: cover boxes [x, y, z, r, g, b, a] (z in clip space, later = nearer; a: the
//   piece's opacity, `p.alpha`, 1 unless it fades).
//   fills: [{ tris, boxes }], crescents: [{ shapes, moved, movedBoxes, boxes }], shadows: [{ hosts, shape, box, allBox }],
//   each a [first, end) vertex range of its sink.
export function createFramePlanner() {
  const sSink = new Sink(5), cSink = new Sink(7);
  const pushTris = (t, M, dx = 0, dy = 0) => {   // a piece's triangles (its reference's under its map M, moved by dx, dy)
    const nv = t.length / 5;
    sSink.reserve(nv);
    const f = sSink.f;
    let o = sSink.n * 5;
    if (M || dx || dy) {
      for (let i = 0; i < t.length; i += 5) {
        const x = t[i], y = t[i + 1];
        f[o] = (M ? M.a * x + M.c * y + M.e : x) + dx; f[o + 1] = (M ? M.b * x + M.d * y + M.f : y) + dy;
        f[o + 2] = t[i + 2]; f[o + 3] = t[i + 3]; f[o + 4] = t[i + 4];
        o += 5;
      }
    } else f.set(t, o);
    sSink.n += nv;
  };
  const pushBox = (b, z, rgb, a = 1) => {
    cSink.reserve(6);
    const c = cSink.f;
    let q = cSink.n * 7;
    const x0 = b[0], y0 = b[1], x1 = b[2], y1 = b[3];
    const P = [x0, y0, x1, y0, x0, y1, x0, y1, x1, y0, x1, y1];
    for (let i = 0; i < 12; i += 2) { c[q] = P[i]; c[q + 1] = P[i + 1]; c[q + 2] = z; c[q + 3] = rgb[0]; c[q + 4] = rgb[1]; c[q + 5] = rgb[2]; c[q + 6] = a; q += 7; }
    cSink.n += 6;
  };
  const boxOf = (T, M) => {   // a piece's screen box (+1 px for the antialiased edge)
    let x0 = T.box[0], y0 = T.box[1], x1 = T.box[2], y1 = T.box[3];
    if (M) {
      const xs = [x0, x1, x0, x1], ys = [y0, y0, y1, y1];
      x0 = y0 = Infinity; x1 = y1 = -Infinity;
      for (let i = 0; i < 4; i++) {
        const X = M.a * xs[i] + M.c * ys[i] + M.e, Y = M.b * xs[i] + M.d * ys[i] + M.f;
        if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
      }
    }
    return [x0 - 1, y0 - 1, x1 + 1, y1 + 1];
  };
  const band = (px, py, qx, qy, hp, hq, z, rgb) => {   // a quad along P -> Q, half width hp at P and hq at Q
    const dx = qx - px, dy = qy - py, l = Math.sqrt(dx * dx + dy * dy);
    if (!(l > 1e-9) || (hp <= 0 && hq <= 0)) return;
    const ux = -dy / l, uy = dx / l, pnx = ux * hp, pny = uy * hp, qnx = ux * hq, qny = uy * hq;
    cSink.reserve(6);
    const c = cSink.f, r = rgb[0], g = rgb[1], b = rgb[2];
    let q = cSink.n * 7;
    const v = (x, y) => { c[q] = x; c[q + 1] = y; c[q + 2] = z; c[q + 3] = r; c[q + 4] = g; c[q + 5] = b; c[q + 6] = 1; q += 7; };
    v(px + pnx, py + pny); v(qx + qnx, qy + qny); v(px - pnx, py - pny); v(px - pnx, py - pny); v(qx + qnx, qy + qny); v(qx - qnx, qy - qny);
    cSink.n += 6;
  };
  const unionBox = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
  const shiftBox = (b, dx, dy) => [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy];
  const triOf = (p) => trianglesOf(p.ref || p, !!(p.ref || p.keep));
  const BLACK = [0, 0, 0], WHITE = [1, 1, 1];

  // A ground piece's sides for the underlay, in its own frame, cached on it: per side its tag (`edge`: a triangle edge's index,
  // 'cut', 'lamp'; null for a contour (ci 4), a near cut or an untagged side: nothing of the ground lies beyond those), its polyline
  // (arcs sampled within `tol`) as points [a, b) of the array `f` (x, y pairs), and its neighbors in its loop (`prev`, `next`; a
  // side with `move` starts a loop, shape.js).
  const underSegs = (r, tol) => {
    if (r.under && r.underTol === tol) return r.under;
    const f = [], sides = [];
    let loop0 = 0;
    r.sides.forEach((sd, j) => {
      if (j > 0 && sd.move) loop0 = j;
      const tag = sd.ci === 4 || sd.edge === 'near' ? null : sd.edge ?? null;
      const a = f.length / 2;
      if (tag !== null) {
        if (sd.kind === 'line') f.push(sd.from.x, sd.from.y, sd.to.x, sd.to.y);
        else {
          const e = sd.e, R = Math.max(e.a, e.b), sw = sd.t1 - sd.t0;
          const n = Math.min(64, Math.max(1, Math.ceil(Math.abs(sw) / (2 * Math.sqrt((2 * tol) / Math.max(R, tol))))));
          for (let i = 0; i <= n; i++) { const q = ellipsePoint(e, sd.t0 + (sw * i) / n); f.push(q.x, q.y); }
        }
      }
      sides.push({ tag, a, b: f.length / 2, loop0 });
    });
    for (let j = 0; j < sides.length; j++) {   // loop neighbors (a loop's last side is followed by its first)
      const s = sides[j], more = j + 1 < sides.length && sides[j + 1].loop0 === s.loop0;
      s.next = more ? j + 1 : s.loop0;
      if (!more) for (let k = s.loop0; k <= j; k++) sides[k].prev = k === s.loop0 ? j : k - 1;
    }
    const segs = { f: new Float32Array(f), sides };
    if (r.keep || r.ref === undefined) { r.under = segs; r.underTol = tol; }
    return segs;
  };
  // A ground shape's edges as keys of their world end points (either order; null for a curved edge), cached on it while its edges
  // stay the same objects (a terrain edit rebuilds the patches it touches). The terrain's cut is conforming, so two drawn patches
  // sharing an edge give it the same key, whatever their levels.
  const ptKey = (p) => `${Math.round(p.x * 100)},${Math.round(p.y * 100)},${Math.round(p.z * 100)}`;
  const edgeKeys = (o) => {
    const src = o.kind === 'quad' ? o.pts : o.edges;
    if (o.edgeKeys && o.edgeKeysOf === src) return o.edgeKeys;
    const pairs = o.kind === 'quad' ? o.pts.map((p, k) => [p, o.pts[(k + 1) % 4]]) : o.edges || [];
    o.edgeKeys = pairs.map((e) => { if (!e) return null; const a = ptKey(e[0]), b = ptKey(e[1]); return a < b ? a + '|' + b : b + '|' + a; });
    o.edgeKeysOf = src;
    return o.edgeKeys;
  };

  function plan(F) {
    beginFrame();
    // entries in draw order: each piece's fill, then its crescents; a shadow right after its last host shape
    const entries = [];
    F.shapes.forEach((s, si) => {
      if (s.pieces && s.pieces.length) {
        for (const p of s.pieces) {
          entries.push({ kind: 0, p });
          if (p.crescents) for (const c of p.crescents) if (Math.hypot(c.dx, c.dy) >= 0.05) entries.push({ kind: 1, p, c });
        }
        F.stats.drawn++;
        s.o.drawnFrame = F.frameNo;
      }
      for (const sh of F.shadows) if (sh.last === si) entries.push({ kind: 2, sh });
    });
    const N = entries.length, zOf = (k) => 1 - (2 * (k + 1)) / (N + 2);
    // groups of disjoint boxes (fills and crescents apart), first fit on a grid
    const view = F.view, gx = Math.max(1, Math.ceil((view.x1 - view.x0) / CELL)), gy = Math.max(1, Math.ceil((view.y1 - view.y0) / CELL));
    const fillOcc = [], cresOcc = [], fillGroups = [], cresGroups = [], shadowList = [];
    // a TRANSLUCENT entry (p.alpha < 1) blends over what is drawn before it, so it goes into a group after every group holding an
    // overlapping cell (everything behind it in the draw order that it overlaps is then drawn first; anything nearer that lands in
    // an earlier group wins by depth). Opaque entries: plain first fit (depth orders them).
    const place = (occ, list, box, k, after = false) => {
      const cx0 = Math.max(0, Math.floor((box[0] - view.x0) / CELL)), cx1 = Math.min(gx - 1, Math.floor((box[2] - view.x0) / CELL));
      const cy0 = Math.max(0, Math.floor((box[1] - view.y0) / CELL)), cy1 = Math.min(gy - 1, Math.floor((box[3] - view.y0) / CELL));
      let g = 0;
      if (after) for (let h = occ.length - 1; h >= 0 && !g; h--) {
        const o = occ[h];
        for (let y = cy0; y <= cy1 && !g; y++) for (let x = cx0; x <= cx1; x++) if (o[y * gx + x]) { g = h + 1; break; }
      }
      for (; g < occ.length; g++) {
        const o = occ[g];
        let free = true;
        for (let y = cy0; y <= cy1 && free; y++) for (let x = cx0; x <= cx1; x++) if (o[y * gx + x]) { free = false; break; }
        if (free) break;
      }
      if (g === occ.length) { occ.push(new Uint8Array(gx * gy)); list.push([]); }
      const o = occ[g];
      for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++) o[y * gx + x] = 1;
      list[g].push(k);
    };
    for (let k = 0; k < N; k++) {
      const E = entries[k];
      if (E.kind === 2) { shadowList.push(k); continue; }
      E.T = triOf(E.p);
      E.box = boxOf(E.T, E.p.M);
      if (E.kind === 0) place(fillOcc, fillGroups, E.box, k, E.p.alpha !== undefined && E.p.alpha < 1);
      else place(cresOcc, cresGroups, unionBox(E.box, shiftBox(E.box, E.c.dx, E.c.dy)), k);
    }
    sSink.clear(); cSink.clear();
    const range = (sink, f) => { const a = sink.n; f(); return [a, sink.n]; };
    const fills = fillGroups.map((list) => {
      const G = {};
      G.tris = range(sSink, () => { for (const k of list) pushTris(entries[k].T.tris, entries[k].p.M); });
      G.boxes = range(cSink, () => { for (const k of list) pushBox(entries[k].box, zOf(k), rgbOf(entries[k].p.fill), entries[k].p.alpha ?? 1); });
      return G;
    });
    const crescents = cresGroups.map((list) => {
      const G = {};
      G.shapes = range(sSink, () => { for (const k of list) pushTris(entries[k].T.tris, entries[k].p.M); });
      G.moved = range(sSink, () => { for (const k of list) { const E = entries[k]; pushTris(E.T.tris, E.p.M, E.c.dx, E.c.dy); } });
      G.movedBoxes = range(cSink, () => { for (const k of list) { const E = entries[k]; pushBox(unionBox(E.box, shiftBox(E.box, E.c.dx, E.c.dy)), 0, BLACK); } });
      G.boxes = range(cSink, () => { for (const k of list) pushBox(entries[k].box, zOf(k), rgbOf(entries[k].c.color)); });
      return G;
    });
    // GROUND UNDERLAY: a band UNDER_PX canvas px wide along each ground piece's inner sides (not its contour, ci 4) in its color, at
    // the farthest depth: every piece covers it, so it shows only where neighboring ground pieces leave a sub-pixel gap (levels of
    // detail, cuts), which per-sample coverage would otherwise show as dots of the sky (one sample of 8).
    // Only edges that two ground shapes drawn this frame share get the band: on any other (the ground's outline against the sky,
    // e.g. a ridge where the patch beyond faces away and is skipped) half the band stuck out past the ground as a ragged fringe of
    // straight segments. Inner cuts (shade, shore, lamp bands) always have ground on both sides.
    const zUnder = 1 - 1 / (N + 2), hw = UNDER_PX / 2 / F.fit, taper = TAPER_PX / F.fit, tol = 0.25 / F.fit;
    const isGround = (s) => s.pieces && s.pieces.length && (s.o.kind === 'patch' || s.o.kind === 'quad');
    const edgeCount = new Map();
    for (const s of F.shapes) if (isGround(s)) for (const k of edgeKeys(s.o)) if (k) edgeCount.set(k, (edgeCount.get(k) || 0) + 1);
    const under = range(cSink, () => {
      for (const s of F.shapes) {
        if (!isGround(s)) continue;
        const keys = edgeKeys(s.o);
        const banded = (tag) => (typeof tag === 'number' ? !!keys[tag] && edgeCount.get(keys[tag]) > 1 : tag !== null);
        for (const p of s.pieces) {
          if (p.spike) continue;   // the grass edge's spikes stand over the sky: no underlay band
          const r = p.ref || p, M = p.M, rgb = rgbOf(p.fill), U = underSegs(r, tol), g = U.f, S = U.sides;
          for (const sd of S) {
            if (sd.b - sd.a < 2 || !banded(sd.tag)) continue;
            // an end that meets an unbanded side (where the ground's outline leaves this one, e.g. a contour across a ridge)
            // tapers to nothing over TAPER_PX: a full-width square end stuck out past the outline there, a bump per edge
            const openA = !banded(S[sd.prev].tag), openB = !banded(S[sd.next].tag);
            let n = 0;
            for (let i = sd.a; i < sd.b; i++) {
              let x = g[2 * i], y = g[2 * i + 1];
              if (M) { const X = M.a * x + M.c * y + M.e; y = M.b * x + M.d * y + M.f; x = X; }
              PX[n] = x; PY[n] = y; CUM[n] = n ? CUM[n - 1] + Math.hypot(x - PX[n - 1], y - PY[n - 1]) : 0; n++;
            }
            const len = CUM[n - 1];
            const w = (d) => hw * Math.min(1, openA ? d / taper : 1, openB ? (len - d) / taper : 1);
            for (let i = 0; i + 1 < n; i++) band(PX[i], PY[i], PX[i + 1], PY[i + 1], w(CUM[i]), w(CUM[i + 1]), zUnder, rgb);
          }
        }
      }
    });
    const shadows = [];
    for (const k of shadowList) {
      const { sh, hosts } = entries[k].sh;
      let hb = null;
      const G = {};
      G.hosts = range(sSink, () => {
        for (const s of hosts) for (const p of s.pieces) if (p.fill === litOf(s.o.fill)) {
          const T = triOf(p);
          pushTris(T.tris, p.M);
          const b = boxOf(T, p.M);
          hb = hb ? unionBox(hb, b) : b;
        }
      });
      if (!hb) continue;
      const S = trianglesOf({ sides: sh.sides }), sb = boxOf(S, null);
      G.shape = range(sSink, () => pushTris(S.tris, null));
      G.box = range(cSink, () => pushBox(sb, zOf(k), WHITE));   // white: the add pass is src x constant
      G.allBox = range(cSink, () => pushBox(unionBox(hb, sb), 0, BLACK));
      shadows.push(G);
    }
    return { sSink, cSink, fills, crescents, shadows, under, entries: N };
  }
  return { plan };
}
