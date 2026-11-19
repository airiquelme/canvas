// A 2-node mesh bent through a third point, as one screen shape whose sides are ellipse arcs.
// The 3D centerline is the half-ellipse with conjugate semi-diameters (A - B) / 2 and S - M (M the midpoint of A, B),
// X(th) = M + U cos th + V sin th, th = 0 at A, PI / 2 at S, PI at B. On screen the tube is the union of the discs of its
// cross-sections, D(th): center = X(th) projected, radius w(th) = r(th) * scale. Its outline is drawn as:
// - two long sides, the envelope of the discs on each side, O(th, s) = C + w (sqrt(1 - w'^2) s n - w' t), s = +-1 (t, n the
//   screen tangent and normal, w' = dw / d(screen arclength): the tilt from the width changing with depth), so each meets its
//   end discs tangentially;
// - the end caps, the outward arcs of D(0) and D(PI).
// FOLDS. Where the tube turns toward the camera its screen centerline bends tighter than the tube is wide (w * curvature > 1),
// and the envelope on the inside runs past the turn, doubles back (two cusps) and crosses itself; at an end the same loop runs
// back across the end. Those parts lie inside the tube's own discs, so every point of the sides and caps that lies inside another
// disc is dropped: a fold in the middle leaves two pieces (the part coming toward the camera and the part going away), meeting at
// the corner where they cross. Visibility is tested on samples; each corner is then solved exactly (Newton) where the two curves
// cross; seen nearly end-on (a hairpin: the two halves overlapping) the outline jumps between the curves at those corners, so the
// stretches are chained by their corners, not in the curves' order (and may make several loops). Each visible stretch of a side
// is ellipse arcs (`fitSide`; a straight stretch a line), a cap stretch an arc of its circle. Not the true silhouette
// of a 3D tube (that is no conic), one that looks right from the camera.
import { arc, pointOnEllipse } from './shape.js';

// Distance from p to a polyline.
function polyDist(poly, p) {
  let best = Infinity;
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i], b = poly[i + 1], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
  }
  return best;
}

const TAU = Math.PI * 2;
const mod = (x) => ((x % TAU) + TAU) % TAU;
const N_SIDE = 256, N_CAP = 64;   // default visibility samples per side / cap (options nSide / nCap: the renderer scales them
                                  // with the shape's size on screen)
const HIDE_TOL_PX = 0.02;         // a sample is hidden only this far inside another disc
const TH_TURN = 0.05, TH_DEPTH = 12;   // adaptive samples: bisect a step while the centerline turns more than this (rad)
const CUSP_TURN = 1;   // a step at the last depth turning more than this (rad) is a cusp
const NESTED_WP = 0.999;
const TIP_EPS_PX = 0.5;
const SAMPLE_PX = 3;   // adaptive samples: also bisect while a side's envelope moves more than this   // a run end this close to a tip circle continues along it   // |dw / ds| past which the discs are nested (no envelope)
const FIT_TOL_PX = 0.3, MAX_SPLIT = 6;

// ctx.ellipse's parameter of a screen point on e.
export function paramOn(e, p) {
  const dx = p.x - e.x, dy = p.y - e.y, ca = Math.cos(e.angle), sa = Math.sin(e.angle);
  return Math.atan2((-dx * sa + dy * ca) / e.b, (dx * ca + dy * sa) / e.a);
}

// The arc of e from tS to tE that passes through tM.
function arcThrough(e, tS, tE, tM) {
  const d = mod(tE - tS), dm = mod(tM - tS);
  return arc(e, tS, dm < d ? tS + d : tS - (TAU - d));
}

// The ellipse through P1 and P2 tangent to T1 / T2 there, as close to Q as an ellipse can be: { e, dist } (dist(p): p's
// distance from the conic, to first order) or null. The pencil L1 L2 - k M^2 (L1, L2 the tangent lines, M the chord) holds
// every conic tangent to both lines at those points; Q fixes k. Its discriminant B^2 - 4AC is linear in k, so where Q's conic
// is a hyperbola, k is moved just past the parabola (k*) into the ellipses.
export function conicThrough(P1, T1, P2, T2, Q) {
  const lineAt = (P, T) => { const a = -T.y, b = T.x; return [a, b, -(a * P.x + b * P.y)]; };
  const L1 = lineAt(P1, T1), L2 = lineAt(P2, T2), M = lineAt(P1, { x: P2.x - P1.x, y: P2.y - P1.y });
  const ev = (L, p) => L[0] * p.x + L[1] * p.y + L[2];
  const mq = ev(M, Q);
  if (Math.abs(mq) < 1e-9) return null;
  let k = ev(L1, Q) * ev(L2, Q) / (mq * mq);
  const a0 = L1[0] * L2[0], b0 = L1[0] * L2[1] + L2[0] * L1[1], c0 = L1[1] * L2[1];
  const d0 = b0 * b0 - 4 * a0 * c0, d1 = -4 * b0 * M[0] * M[1] + 4 * a0 * M[1] * M[1] + 4 * c0 * M[0] * M[0];
  if (!(d0 + d1 * k < 0)) {
    if (Math.abs(d1) < 1e-15) return null;
    const ks = -d0 / d1;
    k = ks - Math.sign(d1) * (Math.abs(ks) * 0.02 + 1e-12);
  }
  const A = a0 - k * M[0] * M[0], B = b0 - 2 * k * M[0] * M[1], C = c0 - k * M[1] * M[1];
  const D = L1[0] * L2[2] + L2[0] * L1[2] - 2 * k * M[0] * M[2];
  const E = L1[1] * L2[2] + L2[1] * L1[2] - 2 * k * M[1] * M[2];
  const F = L1[2] * L2[2] - k * M[2] * M[2];
  const disc = B * B - 4 * A * C;
  if (!(disc < 0)) return null;
  const x = (B * E - 2 * C * D) / -disc, y = (B * D - 2 * A * E) / -disc;   // center: grad = 0
  const F0 = F + (D * x + E * y) / 2;
  const angle = 0.5 * Math.atan2(B, A - C), ca = Math.cos(angle), sa = Math.sin(angle);
  const la = A * ca * ca + B * ca * sa + C * sa * sa, lb = A * sa * sa - B * ca * sa + C * ca * ca;
  const a2 = -F0 / la, b2 = -F0 / lb;
  if (!(a2 > 0 && b2 > 0)) return null;
  const dist = (p) => {
    const f = A * p.x * p.x + B * p.x * p.y + C * p.y * p.y + D * p.x + E * p.y + F;
    const gx = 2 * A * p.x + B * p.y + D, gy = B * p.x + 2 * C * p.y + E;
    return Math.abs(f) / (Math.hypot(gx, gy) || 1e-300);
  };
  return { e: { x, y, a: Math.sqrt(a2), b: Math.sqrt(b2), angle }, dist };
}

// A, S, B: world points; rA, rB: world radii; projector: makeProjector's result (its toCamera and persp). Sides in loop order:
// the + side (A to B), the
// cap at B, the - side (B to A), the cap at A, with color indices `ci` 0-3 (4: a tip; 5 on: each further stretch a fold splits off).
export function curvedSides(A, S, B, rA, rB, projector, { nSide = N_SIDE, nCap = N_CAP } = {}) {
  // CLOSED FORM. The camera is affine, so in camera space the centerline is X(th) = Mc + Uc cos th + Vc sin th; projected,
  // x = cx + s X / Z, y = cy - s Y / Z, and the radius w = r s / Z. Position, direction and width rate (and their th
  // derivatives) come straight from one evaluation: no projection calls, no finite differences.
  const { toCamera, persp } = projector, sp = persp.s, cx = persp.cx, cy = persp.cy;
  const Mc = toCamera({ x: (A.x + B.x) / 2, y: (A.y + B.y) / 2, z: (A.z + B.z) / 2 }), Ac = toCamera(A), Sc = toCamera(S);
  const Ux = Ac.x - Mc.x, Uy = Ac.y - Mc.y, Uz = Ac.z - Mc.z, Vx = Sc.x - Mc.x, Vy = Sc.y - Mc.y, Vz = Sc.z - Mc.z;
  const dr = (rB - rA) / Math.PI;
  // The disc at th: center (x, y), radius w, and their derivatives dx, dy, dw along th.
  const disc = (th) => {
    const c = Math.cos(th), s = Math.sin(th);
    const X = Mc.x + Ux * c + Vx * s, Y = Mc.y + Uy * c + Vy * s, Z = Mc.z + Uz * c + Vz * s;
    const Xp = Vx * c - Ux * s, Yp = Vy * c - Uy * s, Zp = Vz * c - Uz * s;
    const iz = 1 / Z, iz2 = iz * iz, r = rA + dr * th;
    return {
      x: cx + sp * X * iz, y: cy - sp * Y * iz, w: r * sp * iz,
      dx: sp * (Xp * Z - X * Zp) * iz2, dy: -sp * (Yp * Z - Y * Zp) * iz2, dw: sp * (dr * Z - r * Zp) * iz2,
    };
  };
  // The envelope point on side s at th (see the header).
  const off = (th, s) => {
    const d = disc(th), l = Math.hypot(d.dx, d.dy) || 1e-300, tx = d.dx / l, ty = d.dy / l;
    const wp = Math.max(-NESTED_WP, Math.min(NESTED_WP, d.dw / l)), k = Math.sqrt(1 - wp * wp);
    return { x: d.x + d.w * (-k * s * ty - wp * tx), y: d.y + d.w * (k * s * tx - wp * ty) };
  };
  const tangentOf = (th, s) => {
    const h = 1e-5, p = off(th + h, s), q = off(th - h, s), l = Math.hypot(p.x - q.x, p.y - q.y) || 1e-300;
    return { x: (p.x - q.x) / l, y: (p.y - q.y) / l };
  };
  const centerDir = (th) => { const d = disc(th); return Math.atan2(d.dy, d.dx); };
  const D0 = disc(0), D1 = disc(Math.PI);
  const capOf = (Dc, from, to, outward) => {
    const e = { x: Dc.x, y: Dc.y, a: Dc.w, b: Dc.w, angle: 0 };
    const a = arcThrough(e, Math.atan2(from.y - Dc.y, from.x - Dc.x), Math.atan2(to.y - Dc.y, to.x - Dc.x), outward);
    return { e, u0: a.t0, u1: a.t1 };
  };
  const capB = capOf(D1, off(Math.PI, 1), off(Math.PI, -1), centerDir(Math.PI));
  const capA = capOf(D0, off(0, -1), off(0, 1), centerDir(0) + Math.PI);
  const circlePt = (e, u) => ({ x: e.x + e.a * Math.cos(u), y: e.y + e.a * Math.sin(u) });
  // SAMPLES along th: N_SIDE steps, each bisected (up to TH_DEPTH times) while the screen centerline turns by more than
  // TH_TURN between its ends. Where the tube points at the camera the whole turn happens within a tiny range of th (the screen
  // speed nearly vanishes there), and uniform steps jumped over the fold.
  // A step still turning by more than CUSP_TURN at the last depth is a CUSP: the tube points straight at the camera there, its
  // screen centerline stops and reverses, the two sides swap, and the outline around the turn is the edge of that one disc
  // (a 'tip' curve below), which neither side's envelope sweeps.
  const ths = [0], cusps = [];
  const turnOf = (a, b) => { const d = centerDir(b) - centerDir(a); return Math.abs(Math.atan2(Math.sin(d), Math.cos(d))); };
  // Also bisected while either side's envelope moves more than SAMPLE_PX between the step's ends (next to a nested stretch the
  // envelope sweeps around the tip disc within a tiny range of th), except inside a nested stretch (no envelope there).
  const wpAt = (th) => { const d = disc(th); return Math.abs(d.dw) / (Math.hypot(d.dx, d.dy) || 1e-300); };
  const sweep = (a, b) => {
    if (wpAt((a + b) / 2) >= NESTED_WP) return 0;
    const p = off(a, 1), q = off(b, 1), r = off(a, -1), t = off(b, -1);
    return Math.max(Math.hypot(p.x - q.x, p.y - q.y), Math.hypot(r.x - t.x, r.y - t.y));
  };
  const refine = (a, b, depth) => {
    const turn = turnOf(a, b);
    if (depth < TH_DEPTH && (turn > TH_TURN || sweep(a, b) > SAMPLE_PX)) { const m = (a + b) / 2; refine(a, m, depth + 1); refine(m, b, depth + 1); return; }
    if (turn > CUSP_TURN && !cusps.some(c => Math.abs(c - b) < 1e-4)) cusps.push((a + b) / 2);
    ths.push(b);
  };
  for (let i = 0; i < nSide; i++) refine(Math.PI * i / nSide, Math.PI * (i + 1) / nSide, 0);
  const capUs = (cap) => Array.from({ length: nCap + 1 }, (_, i) => cap.u0 + (cap.u1 - cap.u0) * i / nCap);
  // The four curves of the loop, each its sample parameters (us) and its point.
  const curves = [
    { kind: 'side', s: 1, ci: 0, pt: (u) => off(u, 1), us: ths },
    { kind: 'cap', cap: capB, ci: 1, pt: (u) => circlePt(capB.e, u), us: capUs(capB), end: Math.PI },
    { kind: 'side', s: -1, ci: 2, pt: (u) => off(u, -1), us: ths.slice().reverse() },
    { kind: 'cap', cap: capA, ci: 3, pt: (u) => circlePt(capA.e, u), us: capUs(capA), end: 0 },
  ];
  // Visibility: a sample is hidden when it lies more than HIDE_TOL_PX inside a disc of the tube other than its own. (Its
  // neighbors' discs hold it only past a fold: on a side, |p - c(th + ds)|^2 - w^2 = ds^2 (1 - w * curvature) to second order.)
  const discs = ths.map(th => ({ th, ...disc(th) }));
  // The discs go into a screen grid (cells as wide as the largest disc, built on the first test, after the tip discs are in), so a
  // sample is tested only against the discs whose box covers its cell.
  let grid = null, cell = 1;
  const cellKey = (ix, iy) => ix * 1048576 + iy;
  const buildGrid = () => {
    grid = new Map();
    cell = Math.max(4, ...discs.map(d => d.w));
    for (const d of discs) {
      for (let ix = Math.floor((d.x - d.w) / cell); ix <= Math.floor((d.x + d.w) / cell); ix++)
        for (let iy = Math.floor((d.y - d.w) / cell); iy <= Math.floor((d.y + d.w) / cell); iy++) {
          const k = cellKey(ix, iy), list = grid.get(k);
          if (list) list.push(d); else grid.set(k, [d]);
        }
    }
  };
  const hidden = (p, ownTh) => {
    if (!grid) buildGrid();
    const list = grid.get(cellKey(Math.floor(p.x / cell), Math.floor(p.y / cell)));
    if (!list) return false;
    for (const d of list) {
      if (d.th === ownTh) continue;
      const dx = p.x - d.x, dy = p.y - d.y, r = d.w - HIDE_TOL_PX;
      if (r > 0 && dx * dx + dy * dy < r * r) return true;
    }
    return false;
  };

  // NESTED discs. Where the tube points almost straight at the camera, its discs grow (or shrink) on screen faster than they
  // move, |dw / ds| >= 1: each lies inside the next and the sides have no envelope at all (their samples there count as hidden).
  // The outline there is the edge of the disc where that stretch ends, so each such disc is added as a 'tip' curve, as is a
  // cusp's disc (the same with the speed reaching zero).
  const nested = ths.map(th => wpAt(th) >= NESTED_WP);
  // The boundary of a nested stretch between a and b (one in it, one not), on the side with an envelope.
  const nestBoundary = (a, b) => {
    const inA = wpAt(a) >= NESTED_WP;
    let lo = a, hi = b;
    for (let it = 0; it < 40; it++) { const m = (lo + hi) / 2; if ((wpAt(m) >= NESTED_WP) === inA) lo = m; else hi = m; }
    return inA ? hi : lo;
  };
  const tipThs = [...cusps];
  for (let i = 0; i + 1 < ths.length; i++) if (nested[i] !== nested[i + 1]) tipThs.push(nestBoundary(ths[i], ths[i + 1]));
  // The tip discs hide too: the largest of a nested stretch holds what the sampled (smaller) ones miss.
  for (const th of tipThs) if (th > 1e-6 && th < Math.PI - 1e-6) discs.push({ th, ...disc(th) });
  // A tip is the disc's whole circle, run with decreasing angle (the loop's direction: the tube on its left on screen), its
  // samples started at a hidden one (so no visible run crosses the seam; a circle with
  // none hidden is the whole outline). Color index 4.
  for (const th of tipThs) {
    if (th < 1e-6 || th > Math.PI - 1e-6) continue;   // at an end it is the cap's disc
    const Dc = disc(th), e = { x: Dc.x, y: Dc.y, a: Dc.w, b: Dc.w, angle: 0 };
    const k0 = Array.from({ length: nCap }, (_, i) => i).find(i => hidden(circlePt(e, TAU * i / nCap), th)) ?? 0;
    const a0 = TAU * k0 / nCap;
    curves.push({ kind: 'tip', cap: { e }, ci: 4, pt: (u) => circlePt(e, u), us: Array.from({ length: nCap + 1 }, (_, i) => a0 - TAU * i / nCap), end: th });
  }
  curves.forEach(cv => { cv.n = cv.us.length - 1; cv.u0 = cv.us[0]; cv.u1 = cv.us[cv.n]; });

  // Each curve as a polyline of n + 1 samples (its last is the next curve's first) and their visibility. uAt takes a
  // fractional sample index; stepAt is the parameter step after sample i.
  const uAt = (c, x) => { const us = curves[c].us, i = Math.max(0, Math.min(Math.floor(x), us.length - 2)); return us[i] + (us[i + 1] - us[i]) * (x - i); };
  const stepAt = (c, i) => { const us = curves[c].us, k = Math.max(0, Math.min(i, us.length - 2)); return us[k + 1] - us[k]; };
  const pts = curves.map(cv => cv.us.map(u => cv.pt(u)));
  const nestedArr = curves.map(cv => cv.us.map((_, i) => cv.kind === 'side' && nested[cv.s > 0 ? i : ths.length - 1 - i]));
  const nestedAt = (c, i) => nestedArr[c][i];
  const vis = curves.map((cv, c) => pts[c].map((p, i) => !nestedAt(c, i) && !hidden(p, cv.kind === 'side' ? cv.us[i] : cv.end)));

  // CORNERS. Where a curve leaves (or comes out of) the tube between samples i and i + 1, it crosses the curve that bounds the
  // tube there: found among all the polylines' segments (the nearest crossing to the visible sample, on this segment or a
  // neighbor), then solved exactly by Newton on pa(u) - pb(v) = 0. { u (this curve), p }.
  const segHit = (p0, p1, q0, q1) => {
    const rx = p1.x - p0.x, ry = p1.y - p0.y, sx = q1.x - q0.x, sy = q1.y - q0.y, d = rx * sy - ry * sx;
    if (Math.abs(d) < 1e-12) return null;
    const wx = q0.x - p0.x, wy = q0.y - p0.y, f = (wx * sy - wy * sx) / d, g = (wx * ry - wy * rx) / d;
    return f >= 0 && f <= 1 && g >= 0 && g <= 1 ? { f, g } : null;
  };
  // All polyline segments in a screen grid (built on the first corner), so a corner tests only the segments near its own.
  let segGrid = null;
  const SEG_CELL = 16;
  const buildSegGrid = () => {
    segGrid = new Map();
    pts.forEach((poly, c2) => {
      for (let j = 0; j < poly.length - 1; j++) {
        const q0 = poly[j], q1 = poly[j + 1];
        for (let ix = Math.floor(Math.min(q0.x, q1.x) / SEG_CELL); ix <= Math.floor(Math.max(q0.x, q1.x) / SEG_CELL); ix++)
          for (let iy = Math.floor(Math.min(q0.y, q1.y) / SEG_CELL); iy <= Math.floor(Math.max(q0.y, q1.y) / SEG_CELL); iy++) {
            const key = cellKey(ix, iy), list = segGrid.get(key);
            if (list) list.push(c2, j); else segGrid.set(key, [c2, j]);
          }
      }
    });
  };
  const corner = (c, i, leaving) => {
    if (!segGrid) buildSegGrid();
    let best = null;
    for (let di = -1; di <= 1; di++) {
      const k = i + di;
      if (k < 0 || k >= curves[c].n || nestedAt(c, k) || nestedAt(c, k + 1)) continue;
      const p0 = pts[c][k], p1 = pts[c][k + 1];
      const bx0 = Math.min(p0.x, p1.x), bx1 = Math.max(p0.x, p1.x), by0 = Math.min(p0.y, p1.y), by1 = Math.max(p0.y, p1.y);
      const seen = new Set();
      for (let ix = Math.floor(bx0 / SEG_CELL); ix <= Math.floor(bx1 / SEG_CELL); ix++) for (let iy = Math.floor(by0 / SEG_CELL); iy <= Math.floor(by1 / SEG_CELL); iy++) {
        const list = segGrid.get(cellKey(ix, iy));
        if (!list) continue;
        for (let m = 0; m < list.length; m += 2) {
          const c2 = list[m], j = list[m + 1], id = c2 * 1e6 + j;
          if (seen.has(id)) continue;
          seen.add(id);
          const poly = pts[c2], q0 = poly[j], q1 = poly[j + 1];   // box test first
          if ((q0.x < bx0 && q1.x < bx0) || (q0.x > bx1 && q1.x > bx1) || (q0.y < by0 && q1.y < by0) || (q0.y > by1 && q1.y > by1)) continue;
          if (c2 === c && Math.abs(j - k) <= 2) continue;
          if (nestedAt(c2, j) || nestedAt(c2, j + 1)) continue;   // no envelope there: those points mean nothing
          const h = segHit(pts[c][k], pts[c][k + 1], poly[j], poly[j + 1]);
          if (!h) continue;
          const pos = k + h.f, score = Math.abs(pos - (leaving ? i : i + 1));   // samples from the visible end
          if (!best || score < best.score) best = { score, u: uAt(c, pos), c2, v: uAt(c2, j + h.g), j };
        }
      }
    }
    const ha = stepAt(c, i);
    if (!best) {   // no crossing found: stop halfway between the samples
      const u = uAt(c, i + 0.5);
      return { u, p: curves[c].pt(u) };
    }
    const Pa = curves[c].pt, Pb = curves[best.c2].pt, hb = stepAt(best.c2, best.j);
    let u = best.u, v = best.v;
    for (let it = 0; it < 30; it++) {
      const pa = Pa(u), pb = Pb(v), fx = pa.x - pb.x, fy = pa.y - pb.y;
      if (Math.hypot(fx, fy) < 1e-9) break;
      const e1 = ha * 1e-3, e2 = hb * 1e-3, da = Pa(u + e1), db = Pb(v + e2);
      const ax = (da.x - pa.x) / e1, ay = (da.y - pa.y) / e1, bx = (db.x - pb.x) / e2, by = (db.y - pb.y) / e2;
      const det = -ax * by + bx * ay;   // J = [pa'(u), -pb'(v)]
      if (Math.abs(det) < 1e-12) break;
      const nu = u - (-fx * by + bx * fy) / det, nv = v - (ax * fy - ay * fx) / det;
      if (!(Math.abs(nu - best.u) <= 2 * Math.abs(ha) && Math.abs(nv - best.v) <= 2 * Math.abs(hb))) break;
      u = nu; v = nv;
    }
    // Not converged (two curves meeting almost tangentially): the run's own point, not a midpoint between far-apart points.
    const pa = Pa(u), pb = Pb(v);
    if (Math.hypot(pa.x - pb.x, pa.y - pb.y) > 1e-6) return { u, p: pa };
    return { u, p: { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 } };
  };

  // RUNS: the visible stretches of each curve, { c, u0, u1, P0?, P1? } (P: a corner, else the curve's own end), then chained
  // into loops: a run ending at its curve's end goes on into the next curve's run from its start; one ending at a corner goes on
  // into the run that starts at the same corner (the nearest start), which in a hairpin view may be on any curve.
  const runs = [];
  curves.forEach((cv, c) => {
    let i = 0;
    while (i <= cv.n) {
      if (!vis[c][i]) { i++; continue; }
      let j = i;
      while (j < cv.n && vis[c][j + 1]) j++;
      const run = { c };
      // A side that stops at a nested stretch ends exactly where it begins: on that stretch's tip circle, met tangentially.
      if (i === 0) run.u0 = cv.u0;
      else if (nestedAt(c, i - 1)) { run.u0 = nestBoundary(cv.us[i - 1], cv.us[i]); run.P0 = off(run.u0, cv.s); }
      else { const cr = corner(c, i - 1, false); run.u0 = cr.u; run.P0 = cr.p; }
      if (j === cv.n) run.u1 = cv.u1;
      else if (nestedAt(c, j + 1)) { run.u1 = nestBoundary(cv.us[j], cv.us[j + 1]); run.P1 = off(run.u1, cv.s); }
      else { const cr = corner(c, j, true); run.u1 = cr.u; run.P1 = cr.p; }
      if (!(i === cv.n && j === cv.n)) runs.push(run);   // (a lone visible end point is the next curve's start)
      i = j + 1;
    }
  });
  // A tip meets the sides tangentially (a nested stretch's envelope merges into the disc's edge), and along those joins a side
  // and the tip circle run within a fraction of a pixel of each other, too close for the visibility test to tell which is
  // outside. So a run may end ON a tip's visible arc: the outline goes on along the tip from that point and leaves it where
  // another run starts on the circle; the near-duplicate rest of the tip arc is dropped.
  const startPt = (r) => r.P0 || curves[r.c].pt(r.u0);
  const isTip = (r) => curves[r.c].kind === 'tip';
  const onTip = (r, u0, p) => {   // p's angle on tip run r if p lies on its circle within the run's range from u0 on, else null
    const e = curves[r.c].cap.e;
    if (Math.abs(Math.hypot(p.x - e.x, p.y - e.y) - e.a) > TIP_EPS_PX) return null;
    const d = mod(u0 - Math.atan2(p.y - e.y, p.x - e.x));   // tips run with decreasing angle
    return d <= u0 - r.u1 ? u0 - d : null;
  };
  const loops = [], used = new Set();
  const order = runs.map((_, k) => k).sort((p, q) => isTip(runs[p]) - isTip(runs[q]));   // start loops on the main curves
  for (const k0 of order) {
    if (used.has(k0)) continue;
    const loop = [];
    let k = k0, u0 = runs[k0].u0, P0 = runs[k0].P0;
    for (let guard = 0; guard <= 2 * runs.length + 4; guard++) {
      used.add(k);
      const r = runs[k], seg = { c: r.c, u0, P0, u1: r.u1, P1: r.P1 };
      let nk = -1, nu0, nP0;
      const free = (j) => j !== k && (!used.has(j) || j === k0);
      if (isTip(r)) {   // leave the tip where another run starts on it (the first along, i.e. the largest angle)
        let best = null;
        runs.forEach((q, j) => {
          if (!free(j) || isTip(q)) return;
          const S = startPt(q), u = onTip(r, u0, S);
          if (u != null && u < u0 - 1e-9 && (!best || u > best.u)) best = { u, j, S };
        });
        if (best) { seg.u1 = best.u; seg.P1 = best.S; nk = best.j; nu0 = runs[nk].u0; nP0 = runs[nk].P0; }
      }
      loop.push(seg);
      if (nk < 0) {
        if (!r.P1 && !isTip(r)) {   // the curve's own end: on into the next main curve (the 4 main curves form the loop)
          nk = runs.findIndex((q, j) => free(j) && q.c === (r.c + 1) % 4 && !q.P0);
          if (nk >= 0) { nu0 = runs[nk].u0; nP0 = runs[nk].P0; }
        } else {   // a corner: the nearest run start, or a point on a tip's visible arc
          const E = seg.P1 || curves[r.c].pt(seg.u1);
          let bd = Infinity;
          runs.forEach((q, j) => {
            if (!free(j)) return;
            if (q.P0) { const d = Math.hypot(q.P0.x - E.x, q.P0.y - E.y); if (d < bd) { bd = d; nk = j; nu0 = q.u0; nP0 = q.P0; } }
            if (isTip(q) && j !== k0) {
              const u = onTip(q, q.u0, E), e = curves[q.c].cap.e;
              if (u != null) { const d = Math.abs(Math.hypot(E.x - e.x, E.y - e.y) - e.a); if (d < bd) { bd = d; nk = j; nu0 = u; nP0 = E; } }
            }
          });
        }
      }
      if (nk < 0 || nk === k0) break;
      k = nk; u0 = nu0; P0 = nP0;
    }
    loops.push(loop);
  }

  // Ellipse arcs for side s over th0 -> th1 (P0 / P1 replace the end points).
  const fitSide = (th0, th1, s, ci, P0, P1, depth = 0) => {
    const thm = (th0 + th1) / 2;
    const p0 = P0 || off(th0, s), p1 = P1 || off(th1, s), q = off(thm, s);
    const fit = conicThrough(p0, tangentOf(th0, s), p1, tangentOf(th1, s), q);
    // Checked both ways: the true curve's points to the conic, and the drawn arc's points to the true curve (a polyline of
    // it); one way only misses an arc that swings out between the checked points (a needle ellipse rounding its tip).
    // The true curve over the stretch: 16 steps plus every adaptive sample inside it (a fold's fast turn is between them).
    // (The adaptive samples' points are the side's polyline, already computed; 4 more if the stretch holds fewer than 8.)
    const lo = Math.min(th0, th1), hi = Math.max(th0, th1), sp0 = s > 0 ? pts[0] : pts[2];
    const lowerBound = (t) => { let a = 0, b = ths.length; while (a < b) { const m = (a + b) >> 1; if (ths[m] <= t) a = m + 1; else b = m; } return a; };
    const i0 = lowerBound(lo), i1 = lowerBound(hi - 1e-15);
    let inner = [];
    for (let i = i0; i < i1; i++) if (ths[i] > lo && ths[i] < hi) inner.push({ t: ths[i], p: sp0[s > 0 ? i : ths.length - 1 - i] });
    if (inner.length < 8) for (let i = 1; i < 16; i++) { const t = lo + (hi - lo) * i / 16; inner.push({ t, p: off(t, s) }); }
    inner.sort((a, b) => (a.t - b.t) * Math.sign(th1 - th0));
    const poly = [p0, ...inner.map(e => e.p), p1];
    const chord = [p0, p1];   // a straight stretch is a line
    if (poly.every(p => polyDist(chord, p) <= FIT_TOL_PX / 2)) return [{ kind: 'line', from: p0, to: p1, ci }];
    let piece = null, err = Infinity;
    if (fit) {
      piece = arcThrough(fit.e, paramOn(fit.e, p0), paramOn(fit.e, p1), paramOn(fit.e, q));
      err = Math.max(...poly.slice(1, -1).map(fit.dist));
      for (let i = 1; i < 12 && err <= FIT_TOL_PX; i++) err = Math.max(err, polyDist(poly, pointOnEllipse(fit.e, piece.t0 + (piece.t1 - piece.t0) * i / 12)));
    }
    if (fit && err <= FIT_TOL_PX) return [{ ...piece, ci }];
    if (depth >= MAX_SPLIT) return [{ kind: 'line', from: p0, to: p1, ci }];
    return [...fitSide(th0, thm, s, ci, P0, null, depth + 1), ...fitSide(thm, th1, s, ci, null, P1, depth + 1)];
  };
  const sides = [];
  // Colors: each visible stretch is its own line. A curve's first stretch keeps the curve's color (0-4), every further one (a
  // fold's second part, a second tip) takes the next free index from 5 on. The arcs a fit splits a stretch into share its color.
  const seen = new Set();
  let extra = 5;
  for (const loop of loops) {
    const first = sides.length;
    for (const st of loop) {
      const cv = curves[st.c], key = cv.kind === 'tip' ? 'tip' : st.c;
      const ci = seen.has(key) ? extra++ : cv.ci;
      seen.add(key);
      if (cv.kind === 'side') sides.push(...fitSide(st.u0, st.u1, cv.s, ci, st.P0, st.P1));
      else {
        const e = cv.cap.e, p0 = st.P0 || circlePt(e, st.u0), p1 = st.P1 || circlePt(e, st.u1);
        const a0 = Math.atan2(p0.y - e.y, p0.x - e.x), a1 = Math.atan2(p1.y - e.y, p1.x - e.x);
        sides.push({ ...arcThrough(e, a0, a1, (st.u0 + st.u1) / 2), ci });
      }
    }
    if (sides.length > first) sides[first] = { ...sides[first], move: true };   // starts a subpath (shape.js)
  }
  return { sides, ends: [{ x: D0.x, y: D0.y }, { x: D1.x, y: D1.y }, disc(Math.PI / 2)] };
}
