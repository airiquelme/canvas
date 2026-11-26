// MARKS: the stylized lines drawn on a figure's body (the collarbones, ...), a texture, not geometry. Each mark is a smooth 3D
// curve on (just under) the skin, given by control points with an outward normal each; per frame its samples are projected and
// the runs whose normals face the eye are drawn as a band of the standard line's width (config.js LINE_PX, on screen whatever the
// distance) with round ends: one loop of lines (the band's two sides, sampled finely along the curve) and two half circles.
// A mark ends where it turns away from the eye (its normals), so it slides off the body's outline as the body turns; one with a
// `front` (a direction) shows only to an eye on that side of it (the body would hide it: a line under the breast seen from behind).
import { LINE_PX } from '../config.js';

export const MARK_COLOR = '#2e9e48';
const SAMPLES = 48;   // samples along a mark (Catmull-Rom through its control points)
const MIN_LINES = 6;   // a mark shorter on screen than this many line widths is not drawn (it would read as a dot)
const FACING = 0.25;   // a sample shows while its normal is within acos(FACING) of the eye: the mark ends just inside the outline

// a point of the (uniform) Catmull-Rom curve through P at segment i, fraction u
function cr(P, i, u) {
  const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[Math.min(P.length - 1, i + 1)], p3 = P[Math.min(P.length - 1, i + 2)];
  const u2 = u * u, u3 = u2 * u;
  const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3);
  return { x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y), z: f(p0.z, p1.z, p2.z, p3.z) };
}
// samples of a mark { pts, normals } (world): positions and normals along the curve
function sampleMark(m) {
  const out = [], n = m.pts.length - 1;
  for (let k = 0; k <= SAMPLES; k++) {
    const s = (k / SAMPLES) * n, i = Math.min(n - 1, Math.floor(s)), u = s - i;
    out.push({ p: cr(m.pts, i, u), n: cr(m.normals, i, u) });
  }
  return out;
}

// a band of width w along the screen polyline Q (>= 2 points): one closed loop of sides
export function band(Q, w) {
  const r = w / 2, n = Q.length, N = [];
  for (let i = 0; i < n; i++) {
    const a = Q[Math.max(0, i - 1)], b = Q[Math.min(n - 1, i + 1)];
    let dx = b.x - a.x, dy = b.y - a.y; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    N.push({ x: -dy, y: dx });   // (the left normal)
  }
  const L = Q.map((q, i) => ({ x: q.x + N[i].x * r, y: q.y + N[i].y * r })), R = Q.map((q, i) => ({ x: q.x - N[i].x * r, y: q.y - N[i].y * r }));
  const sides = [];
  for (let i = 0; i + 1 < n; i++) sides.push({ kind: 'line', from: L[i], to: L[i + 1] });
  const te = Math.atan2(N[n - 1].y, N[n - 1].x);   // the end's cap: from the left side round the front to the right
  sides.push({ kind: 'arc', e: { x: Q[n - 1].x, y: Q[n - 1].y, a: r, b: r, angle: 0 }, t0: te, t1: te - Math.PI });
  for (let i = n - 1; i > 0; i--) sides.push({ kind: 'line', from: R[i], to: R[i - 1] });
  const ts = Math.atan2(N[0].y, N[0].x);   // the start's cap: from the right side round the back to the left
  sides.push({ kind: 'arc', e: { x: Q[0].x, y: Q[0].y, a: r, b: r, angle: 0 }, t0: ts - Math.PI, t1: ts - 2 * Math.PI });
  sides[0].move = true;
  return sides;
}

// The marks' sides (one loop per run that faces the eye) for this view; [] when none shows. eye: the camera's position;
// project(p): screen point or null (behind the eye).
export function markSides(marks, eye, project) {
  const out = [];
  for (const m of marks) {
    let run = [];
    const flush = () => {
      if (run.length >= 2) {
        let len = 0; for (let i = 1; i < run.length; i++) len += Math.hypot(run[i].x - run[i - 1].x, run[i].y - run[i - 1].y);
        if (len >= MIN_LINES * LINE_PX) out.push(...band(run, LINE_PX));
      }
      run = [];
    };
    for (const { p, n } of sampleMark(m)) {
      const vx = eye.x - p.x, vy = eye.y - p.y, vz = eye.z - p.z;
      const vl = Math.hypot(vx, vy, vz), F = m.front;
      const faces = n.x * vx + n.y * vy + n.z * vz > FACING * Math.hypot(n.x, n.y, n.z) * vl && (!F || F.x * vx + F.y * vy + F.z * vz > 0);
      const q = faces ? project(p) : null;
      if (q) run.push(q); else flush();
    }
    flush();
  }
  return out;
}

// OUTLINE MARKS (view dependent: a line along part of a shape's outline on screen, e.g. a breast's lower edge where it lies over
// the chest). `loop`: the shape's sides (lines and ellipse arcs, one loop); keep(p, n): whether the sample p (n: the outline's
// outward normal there, unit) is drawn. Returns the kept runs as screen polylines (samples about OUTLINE_STEP px apart), each a
// band when drawn. Its outward side: away from the loop's middle (convex loops). P: its samples ({ x, y, tx, ty }), if taken.
const OUTLINE_STEP = 3;
function evalSide(s, u) {
  if (s.kind === 'line') return { x: s.from.x + (s.to.x - s.from.x) * u, y: s.from.y + (s.to.y - s.from.y) * u, tx: s.to.x - s.from.x, ty: s.to.y - s.from.y };
  const e = s.e, k = s.t1 - s.t0, t = s.t0 + k * u, c = Math.cos(t), sn = Math.sin(t), ca = Math.cos(e.angle), sa = Math.sin(e.angle);
  return { x: e.x + e.a * c * ca - e.b * sn * sa, y: e.y + e.a * c * sa + e.b * sn * ca, tx: (-e.a * sn * ca - e.b * c * sa) * k, ty: (-e.a * sn * sa + e.b * c * ca) * k };
}
export function sampleOutline(loop, step = OUTLINE_STEP) {
  const out = [];
  for (const s of loop) {
    const len = s.kind === 'line' ? Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y) : Math.abs(s.t1 - s.t0) * Math.max(s.e.a, s.e.b);
    const n = Math.max(1, Math.min(600, Math.ceil(len / step)));
    for (let j = 0; j < n; j++) out.push(evalSide(s, j / n));
  }
  return out;
}
export function outlineRuns(loop, keep, P = sampleOutline(loop), inset = 0) {   // (P: the loop's samples, if taken; inset: the runs moved that far inward)
  if (P.length < 3) return [];
  // the outward normal: the tangent turned to the side away from the loop's middle (a convex loop)
  let mx = 0, my = 0; for (const p of P) { mx += p.x; my += p.y; } mx /= P.length; my /= P.length;
  let side = 0; for (const p of P) side += p.ty * (p.x - mx) - p.tx * (p.y - my);
  const sg = side >= 0 ? 1 : -1;
  const N = P.map((p) => { const l = Math.hypot(p.tx, p.ty) || 1; return { x: (sg * p.ty) / l, y: (-sg * p.tx) / l }; });
  const ok = P.map((p, i) => keep(p, N[i]));
  const at = (i) => ({ x: P[i].x - N[i].x * inset, y: P[i].y - N[i].y * inset });
  // the runs, joined across the loop's start
  const s0 = ok.indexOf(false);
  if (s0 < 0) return [P.map((p, i) => at(i))];
  const runs = [];
  let run = [];
  for (let k = 1; k <= P.length; k++) {
    const i = (s0 + k) % P.length;
    if (ok[i]) run.push(at(i));
    else { if (run.length >= 2) runs.push(run); run = []; }
  }
  if (run.length >= 2) runs.push(run);
  return runs;
}
// the bands of screen polylines (outline marks), dropped when shorter than MIN_LINES widths
export function polylineSides(runs) {
  const out = [];
  for (const run of runs) {
    let len = 0; for (let i = 1; i < run.length; i++) len += Math.hypot(run[i].x - run[i - 1].x, run[i].y - run[i - 1].y);
    if (len >= MIN_LINES * LINE_PX) out.push(...band(run, LINE_PX));
  }
  return out;
}
