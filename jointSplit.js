// Screen-space split of a moon-phase joint's disc from its real 3D curve
// (jointCurve.js; CLAUDE.md "Joint curve"). Only the part of the curve that
// faces the camera separates the two colors, so that part, clipped to the
// node circle, is the terminator; the rim arc on the dominant mesh's side
// closes the dominant region.
import { segmentCircleHit } from './geometry.js';
import { facesCamera } from './jointCurve.js';

const TWO_PI = Math.PI * 2;
const mod2pi = (a) => ((a % TWO_PI) + TWO_PI) % TWO_PI;

// The indices of the longest run of consecutive true values in a cyclic list,
// by summed `weight`; null when none or all are true.
function longestCyclicRun(flags, weight) {
  const n = flags.length;
  if (!flags.some(Boolean) || flags.every(Boolean)) return null;
  const first = flags.findIndex(f => !f);
  let best = null, cur = null;
  for (let k = 1; k <= n; k++) {
    const i = (first + k) % n;
    if (flags[i]) {
      if (!cur) cur = { idx: [], w: 0 };
      cur.idx.push(i);
      cur.w += weight(i);
    } else if (cur) {
      if (!best || cur.w > best.w) best = cur;
      cur = null;
    }
  }
  if (cur && (!best || cur.w > best.w)) best = cur;
  return best && best.idx;
}

// The ring's points on screen with whether each faces the camera, and the
// longest visible run of them as screen points (null when there is none).
function visibleRun(curve, view) {
  let loop = curve.loop;
  if (loop.length > 2) {
    const a = loop[0].p, b = loop[loop.length - 1].p;
    if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 1e-6) loop = loop.slice(0, -1);
  }
  const pts = loop.map(q => {
    const s = view.projectPoint(q.p);
    return { x: s.x, y: s.y, facing: facesCamera(q, view.viewDirAt(q.p)) };
  });
  const segLen = (i) => Math.hypot(pts[(i + 1) % pts.length].x - pts[i].x, pts[(i + 1) % pts.length].y - pts[i].y);
  const run = longestCyclicRun(pts.map(q => q.facing), segLen);
  return run && run.length >= 2 ? run.map(i => pts[i]) : null;
}

// curve: buildJointCurve's result; center / radius: the projected node circle;
// view: { viewDirAt, projectPoint } (render.js flatView); dominantFar: screen center of the dominant
// mesh's far node (it tells which side of the terminator is dominant).
// Returns { terminator: [{x, y}], th0, th1, domIncreasing, span } or null when
// the curve gives no usable split (the caller falls back to one color).
export function projectJointSplit(curve, center, radius, view, dominantFar) {
  const T = visibleRun(curve, view);
  if (!T) return null;

  // Clip to the node circle: the longest stretch of T inside it.
  const inside = T.map(q => Math.hypot(q.x - center.x, q.y - center.y) <= radius);
  let best = null, start = -1;
  for (let i = 0; i <= T.length; i++) {
    if (i < T.length && inside[i]) { if (start < 0) start = i; }
    else if (start >= 0) {
      if (!best || i - start > best.end - best.start + 1) best = { start, end: i - 1 };
      start = -1;
    }
  }
  if (!best) return null;
  const snap = (p) => {
    const d = Math.hypot(p.x - center.x, p.y - center.y) || 1;
    return { x: center.x + (p.x - center.x) / d * radius, y: center.y + (p.y - center.y) / d * radius };
  };
  const stretch = T.slice(best.start, best.end + 1).map(q => ({ x: q.x, y: q.y }));
  const entry = best.start > 0 ? segmentCircleHit(T[best.start - 1], T[best.start], center, radius) : null;
  const exit = best.end < T.length - 1 ? segmentCircleHit(T[best.end], T[best.end + 1], center, radius) : null;
  const terminator = [entry || snap(stretch[0]), ...stretch, exit || snap(stretch[stretch.length - 1])];
  if (terminator.length < 3) return null;

  const e0 = terminator[0], e1 = terminator[terminator.length - 1];
  const th0 = Math.atan2(e0.y - center.y, e0.x - center.x), th1 = Math.atan2(e1.y - center.y, e1.x - center.x);
  const span = mod2pi(th1 - th0);
  if (span < 1e-3 || span > TWO_PI - 1e-3) return null;
  // The increasing-angle arc th0 -> th1 is the dominant side if it holds the
  // direction of the dominant mesh.
  const phiDominant = Math.atan2(dominantFar.y - center.y, dominantFar.x - center.x);
  const domIncreasing = mod2pi(phiDominant - th0) <= span;
  return { terminator, th0, th1, domIncreasing, span };
}
