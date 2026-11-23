// The PLAN of a frame for the GPU backends (webgl2.js, webgpu.js): the frame's entries in draw order (each piece's fill, its
// crescents, a mover's shadow after its last host shape), their depths, their groups of disjoint boxes and their vertices; and the
// ground underlay. The backends only replay it with their own API.
import { trianglesOf, beginFrame, Sink } from './tessellate.js';
import { litOf, shadeOf, light } from '../illusion/light.js';

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

const CELL = 24;
export const GDATA_STRIDE = 16;   // floats per per-pixel ground piece (createFramePlanner)   // design px per cell of the grouping grid
const UNDER_PX = 2;   // the ground underlay's band width (canvas px)
// its sides' polylines: within this of the true curve (canvas px). The band (UNDER_PX wide) only has to cover gaps of about 0.25 px
// (flat and reused patches against their neighbors), so a chord this far inside a curve still leaves half a pixel of band beyond it
const UNDER_TOL_PX = 0.5;
const TAPER_PX = 3;   // its taper (canvas px) where a side meets the ground's outline
const PX = new Float64Array(80), PY = new Float64Array(80), CUM = new Float64Array(80);   // a side's polyline (at most 65 points)
let BAND = new Uint8Array(256), L0 = new Int32Array(256), L1 = new Int32Array(256);   // a piece's sides: banded, its loop's first and last

// THE PLAN of a frame, shared by the GPU backends: the entries in draw order, their depths, groups and vertex ranges.
//   sSink: stencil triangles [x, y, u, v, mode]; cSink: cover boxes [x, y, z, r, g, b, a, gid] (gid: the ground piece it shades per
//   pixel, -1 for none: `ground`, below; z in clip space, later = nearer; a: the
//   piece's opacity, `p.alpha`, 1 unless it fades).
//   fills: [{ tris, boxes }], crescents: [{ shapes, moved, movedBoxes, boxes }], shadows: [{ hosts, shape, box, allBox }],
//   each a [first, end) vertex range of its sink.
export function createFramePlanner() {
  const sSink = new Sink(5), cSink = new Sink(8);
  // PER-PIXEL GROUND (F.pixelGround, webgl2.js): GDATA_STRIDE floats per ground piece this frame, its view ray's terms against its
  // patch's sheet curve (local coordinates, from the eye, in double precision here: h(t) = a2(D) t^2 + (gx Dx + gz Dz) t + h(eye)):
  // A, B, C (the curve's quadratic part), gx, gz (its slope at the eye), k0 (the eye's height over it), ex, ez (the eye in the
  // patch's local x, z: of the ray's two hits the one nearer the patch is its own, the other is on the curve extended), then its
  // shade and base colors (rgb 0-1), then which movers' shadows (bit i: F.casters[i]) and which lamps (bit i: F.lamps[i]) can
  // reach it: the shader tests only those. Its index is the cover vertices' gid.
  let gdata = new Float32Array(GDATA_STRIDE * 1024), gn = 0;
  const groundId = (s, p) => {
    const o = s.o, r = p.ref || p, base = r.base || p.base;
    if (!base || p.spike) return -1;   // (the grass edge's spikes: their tone is their own, illusionRender.js)
    if (p.gidFrame === F_frame) return p.gid;
    if ((gn + 1) * GDATA_STRIDE > gdata.length) { const g = new Float32Array(gdata.length * 2); g.set(gdata); gdata = g; }
    const q = o.q, E = F_eye, ex = E.x - o.ox, ez = E.z - o.oz, ey = E.y - o.oy, k = gn * GDATA_STRIDE;
    gdata[k] = q[0]; gdata[k + 1] = q[1]; gdata[k + 2] = q[2];
    gdata[k + 3] = 2 * q[0] * ex + q[1] * ez + q[3]; gdata[k + 4] = q[1] * ex + 2 * q[2] * ez + q[4];
    gdata[k + 5] = ey - (q[0] * ex * ex + q[1] * ex * ez + q[2] * ez * ez + q[3] * ex + q[4] * ez + q[5]);
    gdata[k + 6] = ex; gdata[k + 7] = ez;
    const sc = rgbOf(shadeOf(base)), bc = rgbOf(base);
    gdata[k + 8] = sc[0]; gdata[k + 9] = sc[1]; gdata[k + 10] = sc[2]; gdata[k + 11] = bc[0]; gdata[k + 12] = bc[1]; gdata[k + 13] = bc[2];
    if (o.reachFrame !== F_frame) { o.reachFrame = F_frame; o.reach = reachOf(o); }
    gdata[k + 14] = o.reach[0]; gdata[k + 15] = o.reach[1];
    p.gid = gn; p.gidFrame = F_frame;
    return gn++;
  };
  let F_frame = 0, F_eye = null, F_casters = null, F_lamps = null, F_sun = null;
  // [movers, lamps] that can reach patch o, as bitmasks. A mover: its two ends and their shadows on the plane of the patch's lowest
  // point (along the sun), boxed in x, z and widened by its radius stretched as its shadow is (r / sin elevation); a lamp: its reach
  // against the patch's box. Both conservative.
  const reachOf = (o) => {
    const b = o.bound, x0 = b[0].x, x1 = b[7].x, z0 = b[0].z, z1 = b[7].z, y0 = b[0].y;
    let mc = 0, ml = 0;
    const L = F_sun;
    if (L && L.y > 0.02) {
      const kx = L.x / L.y, kz = L.z / L.y, nc = Math.min(16, F_casters.length);
      for (let i = 0; i < nc; i++) {
        const c = F_casters[i], A = c.a, B = c.b, pad = c.r / Math.max(L.y, 0.05) + c.r;
        const sa = Math.max(0, A.y - y0), sb = Math.max(0, B.y - y0);   // (over L.y: folded into kx, kz)
        const ax = A.x - kx * sa, az = A.z - kz * sa, bx = B.x - kx * sb, bz = B.z - kz * sb;
        const bx0 = Math.min(A.x, B.x, ax, bx) - pad, bx1 = Math.max(A.x, B.x, ax, bx) + pad;
        const bz0 = Math.min(A.z, B.z, az, bz) - pad, bz1 = Math.max(A.z, B.z, az, bz) + pad;
        if (bx1 >= x0 && bx0 <= x1 && bz1 >= z0 && bz0 <= z1) mc |= 1 << i;
      }
    }
    if (F_lamps) for (let i = 0; i < F_lamps.length && i < 4; i++) {
      const l = F_lamps[i];
      const dx = Math.max(x0 - l.pos.x, 0, l.pos.x - x1), dz = Math.max(z0 - l.pos.z, 0, l.pos.z - z1), dy = Math.max(y0 - l.pos.y, 0, l.pos.y - b[7].y);
      if (dx * dx + dy * dy + dz * dz < l.radius * l.radius) ml |= 1 << i;
    }
    const R = o.reach || (o.reach = [0, 0]);
    R[0] = mc; R[1] = ml;
    return R;
  };
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
  const pushBox = (b, z, rgb, a = 1, gid = -1) => {
    cSink.reserve(6);
    const c = cSink.f;
    let q = cSink.n * 8;
    const x0 = b[0], y0 = b[1], x1 = b[2], y1 = b[3];
    const P = [x0, y0, x1, y0, x0, y1, x0, y1, x1, y0, x1, y1];
    for (let i = 0; i < 12; i += 2) { c[q] = P[i]; c[q + 1] = P[i + 1]; c[q + 2] = z; c[q + 3] = rgb[0]; c[q + 4] = rgb[1]; c[q + 5] = rgb[2]; c[q + 6] = a; c[q + 7] = gid; q += 8; }
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
  const band = (px, py, qx, qy, hp, hq, z, rgb, gid = -1) => {   // a quad along P -> Q, half width hp at P and hq at Q
    const dx = qx - px, dy = qy - py, l = Math.sqrt(dx * dx + dy * dy);
    if (!(l > 1e-9) || (hp <= 0 && hq <= 0)) return;
    const ux = -dy / l, uy = dx / l, pnx = ux * hp, pny = uy * hp, qnx = ux * hq, qny = uy * hq;
    cSink.reserve(6);
    const c = cSink.f, r = rgb[0], g = rgb[1], b = rgb[2];
    let q = cSink.n * 8;
    const ax = px + pnx, ay = py + pny, bx = qx + qnx, by = qy + qny, cx = px - pnx, cy = py - pny, dx2 = qx - qnx, dy2 = qy - qny;
    c[q] = ax; c[q + 1] = ay; c[q + 8] = bx; c[q + 9] = by; c[q + 16] = cx; c[q + 17] = cy;
    c[q + 24] = cx; c[q + 25] = cy; c[q + 32] = bx; c[q + 33] = by; c[q + 40] = dx2; c[q + 41] = dy2;
    for (let k = 0; k < 48; k += 8) { c[q + k + 2] = z; c[q + k + 3] = r; c[q + k + 4] = g; c[q + k + 5] = b; c[q + k + 6] = 1; c[q + k + 7] = gid; }
    cSink.n += 6;
  };
  const unionBox = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
  const shiftBox = (b, dx, dy) => [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy];
  const triOf = (p) => trianglesOf(p.ref || p, !!(p.ref || p.keep));
  const BLACK = [0, 0, 0], WHITE = [1, 1, 1];

  // A ground shape's edges as keys of their world end points (either order; null for a curved edge), cached on it while its edges
  // stay the same objects (a terrain edit rebuilds the patches it touches). The terrain's cut is conforming, so two drawn patches
  // sharing an edge give it the same key, whatever their levels.
  const ptKey = (p) => `${Math.round(p.x * 100)},${Math.round(p.y * 100)},${Math.round(p.z * 100)}`;
  const edgeKeys = (o) => {
    const src = o.kind === 'quad' ? o.pts : o.edges;
    if (o.underKeys && o.underKeysOf === src) return o.underKeys;
    const pairs = o.kind === 'quad' ? o.pts.map((p, k) => [p, o.pts[(k + 1) % 4]]) : o.edges || [];
    o.underKeys = pairs.map((e) => { if (!e) return null; const a = ptKey(e[0]), b = ptKey(e[1]); return a < b ? a + '|' + b : b + '|' + a; });
    o.underKeysOf = src;   // (not `edgeKeys`: the grass edge's own keys, illusionRender.js, are cached there)
    return o.underKeys;
  };
  // ... and as small integers (one per distinct key, interned once per shape; -1 for none), so the frame's count of the drawn shapes
  // holding each edge is arrays: uCount[id], valid where uStamp[id] is this frame's
  const underIdMap = new Map(), uCount = [], uStamp = [];
  let uFrame = 0;
  const edgeIds = (o) => {
    const keys = edgeKeys(o);
    if (o.underIds && o.underIdsOf === keys) return o.underIds;
    o.underIds = keys.map((k) => {
      if (!k) return -1;
      let id = underIdMap.get(k);
      if (id === undefined) { id = underIdMap.size; underIdMap.set(k, id); uCount.push(0); uStamp.push(0); }
      return id;
    });
    o.underIdsOf = keys;
    return o.underIds;
  };

  function plan(F) {
    beginFrame();
    F_frame++; F_eye = F.camPos; gn = 0; F_casters = F.casters || []; F_lamps = F.lamps; F_sun = light.dir;   // (F_frame: this plan, for the pieces' gids)
    const pix = !!F.pixelGround;
    // entries in draw order: each piece's fill, then its crescents; a shadow right after its last host shape
    const entries = [];
    F.shapes.forEach((s, si) => {
      if (s.pieces && s.pieces.length) {
        for (const p of s.pieces) {
          entries.push({ kind: 0, p, gid: pix && s.o.kind === 'patch' ? groundId(s, p) : -1 });
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
      G.boxes = range(cSink, () => { for (const k of list) pushBox(entries[k].box, zOf(k), rgbOf(entries[k].p.fill), entries[k].p.alpha ?? 1, entries[k].gid); });
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
    const zUnder = 1 - 1 / (N + 2), hw = UNDER_PX / 2 / F.fit, taper = TAPER_PX / F.fit, tol = UNDER_TOL_PX / F.fit;
    const isGround = (s) => s.pieces && s.pieces.length && (s.o.kind === 'patch' || s.o.kind === 'quad');
    const fr = ++uFrame;
    for (const s of F.shapes) if (isGround(s)) for (const id of edgeIds(s.o)) if (id >= 0) {
      if (uStamp[id] !== fr) { uStamp[id] = fr; uCount[id] = 0; }
      uCount[id]++;
    }
    const under = range(cSink, () => {
      for (const s of F.shapes) {
        if (!isGround(s)) continue;
        const ids = edgeIds(s.o);
        const banded = (tag) => { if (typeof tag !== 'number') return tag !== null; const id = ids[tag]; return id >= 0 && uStamp[id] === fr && uCount[id] > 1; };
        for (const p of s.pieces) {
          if (p.spike) continue;   // the grass edge's spikes stand over the sky: no underlay band
          // The piece's sides straight from its outline (its reference's, under its map M), into scratch buffers, nothing kept or
          // allocated: per side whether it is banded (its tag: a triangle edge's index, 'cut', 'lamp'; none for a contour (ci 4), a
          // near cut or an untagged side: nothing of the ground lies beyond those) and its loop's first and last side (a side with
          // `move` starts a loop, shape.js), for its neighbors.
          const r = p.ref || p, M = p.M, rgb = rgbOf(p.fill), rs = r.sides, ns = rs.length, gid = pix ? groundId(s, p) : -1;
          if (ns > BAND.length) { BAND = new Uint8Array(2 * ns); L0 = new Int32Array(2 * ns); L1 = new Int32Array(2 * ns); }
          let loop0 = 0;
          for (let j = 0; j < ns; j++) {
            const sd = rs[j];
            if (j > 0 && sd.move) loop0 = j;
            L0[j] = loop0;
            BAND[j] = sd.ci === 4 || sd.edge === 'near' ? 0 : banded(sd.edge ?? null) ? 1 : 0;
          }
          for (let j = ns - 1, end = ns - 1; j >= 0; j--) { if (j < ns - 1 && L0[j + 1] !== L0[j]) end = j; L1[j] = end; }
          for (let j = 0; j < ns; j++) {
            if (!BAND[j]) continue;
            const sd = rs[j];
            // an end that meets an unbanded side (where the ground's outline leaves this one, e.g. a contour across a ridge)
            // tapers to nothing over TAPER_PX: a full-width square end stuck out past the outline there, a bump per edge
            const openA = !BAND[j === L0[j] ? L1[j] : j - 1], openB = !BAND[j === L1[j] ? L0[j] : j + 1];
            let n = 0;
            const put = (x, y) => {
              if (M) { const X = M.a * x + M.c * y + M.e; y = M.b * x + M.d * y + M.f; x = X; }
              if (n) { const ddx = x - PX[n - 1], ddy = y - PY[n - 1]; CUM[n] = CUM[n - 1] + Math.sqrt(ddx * ddx + ddy * ddy); } else CUM[0] = 0;
              PX[n] = x; PY[n] = y; n++;
            };
            if (sd.kind === 'line') { put(sd.from.x, sd.from.y); put(sd.to.x, sd.to.y); }
            else {   // n + 1 points of the ellipse within tol, equally spaced in t: cos / sin of t by rotating one step at a time
              const e = sd.e, R = Math.max(e.a, e.b), sw = sd.t1 - sd.t0;
              const m = Math.min(64, Math.max(1, Math.ceil(Math.abs(sw) / (2 * Math.sqrt((2 * tol) / Math.max(R, tol))))));
              const ca = Math.cos(e.angle), sa = Math.sin(e.angle), dc = Math.cos(sw / m), ds = Math.sin(sw / m);
              let ct = Math.cos(sd.t0), st = Math.sin(sd.t0);
              for (let i = 0; i <= m; i++) {
                const c = ct * e.a, s2 = st * e.b;
                put(e.x + c * ca - s2 * sa, e.y + c * sa + s2 * ca);
                const c2 = ct * dc - st * ds; st = st * dc + ct * ds; ct = c2;
              }
            }
            const len = CUM[n - 1];
            const w = (d) => hw * Math.min(1, openA ? d / taper : 1, openB ? (len - d) / taper : 1);
            for (let i = 0; i + 1 < n; i++) band(PX[i], PY[i], PX[i + 1], PY[i + 1], w(CUM[i]), w(CUM[i + 1]), zUnder, rgb, gid);
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
    return { sSink, cSink, fills, crescents, shadows, under, entries: N, ground: { data: gdata, n: gn } };
  }
  return { plan };
}
