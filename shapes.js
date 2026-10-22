// Canvas drawing primitives. Layering rules and terms: see CLAUDE.md.
import { SEAM_PX } from './config.js';
import {
  vecSub, vecCross, vecDot, vecNormalize,
  capsuleTangentPoints, convexHull, ellipseHullArcs, ellipsePoint, ellipseParam, supportH,
  hullOutline, projectedCircleEllipse, ellipsePolygon,
} from './geometry.js';

// A projected node as an ellipse object: { center, a, b, angle }.
export const nodeEllipse = (p) => ({ center: p.center, a: p.ellipse.a, b: Math.max(p.ellipse.b, 1e-6), angle: p.ellipse.angle });

// Device pixels per drawing unit under the current transform (read once per frame).
export function pixelScale(ctx) {
  const t = ctx.getTransform();
  return Math.hypot(t.a, t.b);
}

// SEAM_PX / 2 device pixels, in drawing units.
export function seamUnderlap(pxPerUnit) {
  return (SEAM_PX / 2) / pxPerUnit;
}

export function fillPolygon(ctx, pts, color) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

export function fillCircle(ctx, center, radius, color) {
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

// ---------------------------------------------------------
// TRACED PIECES (appended to the current path, filled later as one
// nonzero union -- all wound anticlockwise on screen)
// ---------------------------------------------------------

export function traceCapsule(ctx, c1, r1, c2, r2, skipCap1 = false, skipCap2 = false) {
  const { t1Angle, t2Angle, p1a, p1b, p2a, p2b } = capsuleTangentPoints(c1, r1, c2, r2);
  ctx.moveTo(p1a.x, p1a.y);
  ctx.lineTo(p1b.x, p1b.y);
  if (skipCap2) ctx.lineTo(p2a.x, p2a.y);
  else ctx.arc(c2.x, c2.y, r2, t1Angle, t2Angle, true);
  ctx.lineTo(p2b.x, p2b.y);
  if (skipCap1) ctx.lineTo(p1a.x, p1a.y);
  else ctx.arc(c1.x, c1.y, r1, t2Angle, t1Angle, true);
  ctx.closePath();
}

// The hull of two ellipses (the capsule of squashed nodes): the common tangent segments and
// the arcs between them, anticlockwise on screen like traceCapsule. skip1 / skip2 leave out
// the arcs of that ellipse (its cap), joining the tangents by a chord instead.
export function traceEllipseCapsule(ctx, e1, e2, skip1 = false, skip2 = false) {
  const es = [e1, e2], skips = [skip1, skip2];
  const { whole, arcs } = ellipseHullArcs(e1, e2);
  if (whole) {
    const { k } = arcs[0];
    if (!skips[k]) traceEllipse(ctx, es[k]);
    return;
  }
  const start = ellipsePoint(es[arcs[0].k], arcs[0].from);
  ctx.moveTo(start.x, start.y);
  arcs.forEach(arc => {
    const e = es[arc.k];
    if (skips[arc.k]) {
      // No cap: the tangent line comes in to the arc's start and a chord runs to its end (like
      // traceCapsule's lineTo p1b, lineTo p2a), so both tangent lines of this end are kept.
      const p0 = ellipsePoint(e, arc.from), p1 = ellipsePoint(e, arc.to);
      ctx.lineTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      return;
    }
    ctx.ellipse(e.center.x, e.center.y, e.a, e.b, e.angle, ellipseParam(e, arc.from), ellipseParam(e, arc.to), true);
  });
  ctx.closePath();
}

// A whole ellipse, anticlockwise on screen.
export function traceEllipse(ctx, e) {
  const p = ellipsePoint(e, e.angle);
  ctx.moveTo(p.x, p.y);
  ctx.ellipse(e.center.x, e.center.y, e.a, e.b, e.angle, 0, -Math.PI * 2, true);
  ctx.closePath();
}

export function traceCircle(ctx, c, r) {
  ctx.moveTo(c.x + r, c.y);
  ctx.arc(c.x, c.y, r, 0, -Math.PI * 2, true);
  ctx.closePath();
}

export function traceTriangle(ctx, p1, p2, p3) {
  // Anticlockwise on screen = negative shoelace area (y points down).
  const area = (p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x);
  if (area > 0) [p2, p3] = [p3, p2];
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.lineTo(p3.x, p3.y);
  ctx.closePath();
}

// ---------------------------------------------------------
// ---------------------------------------------------------
// JOINT NODE (moon-phase split circle)
// ---------------------------------------------------------

// A joint's node disc, divided by the terminator from the joint ring
// (jointSplit.js): the dominant region (terminator + the rim arc on its side)
// goes first, reaching `underlap` under the crescent's inner edge but not its
// rim; the crescent goes on top. `split` = projectJointSplit's result.
export function drawJointSplitFromCurve(ctx, center, radius, split, dominantColor, crescentColor, pxPerUnit) {
  const { terminator, th0, th1, domIncreasing, span } = split;
  const e0 = terminator[0], e1 = terminator[terminator.length - 1];
  // The crescent arc runs from e1 to e0: increasing angle if the dominant arc
  // is th0 -> th1, decreasing otherwise.
  const crescentSpan = domIncreasing ? 2 * Math.PI - span : span;
  const crescentAt = (f) => th1 + (domIncreasing ? 1 : -1) * crescentSpan * f;

  // Thickness of the crescent: its area over the longer of chord and rim arc. The area is
  // the terminator polygon (closed by its chord) plus the circular segment between that
  // chord and the rim arc, r^2/2 (span - sin span), signed by the arc's direction.
  let area = 0;
  terminator.forEach((p, i) => { const q = terminator[(i + 1) % terminator.length]; area += p.x * q.y - q.x * p.y; });
  area = area / 2 + (domIncreasing ? 1 : -1) * 0.5 * radius * radius * (crescentSpan - Math.sin(crescentSpan));
  const chordLen = Math.hypot(e1.x - e0.x, e1.y - e0.y);
  const thickness = Math.abs(area) / Math.max(chordLen, radius * crescentSpan, 1e-6);
  // A crescent grows from nothing as the ring leaves the rim, so it is drawn at
  // any thickness: below a pixel it antialiases to partial coverage, which fades
  // it in. (A cutoff at 1 px made a whole 1 px crescent appear at once.) Only a
  // crescent that could not cover 2% of a pixel is skipped.
  if (thickness * pxPerUnit < 0.02) {
    fillCircle(ctx, center, radius, dominantColor);
    return;
  }

  // Push the terminator toward the crescent by the underlap (not its ends), but
  // never past half the crescent, or the dominant region would spill over the rim.
  const underlap = Math.min(seamUnderlap(pxPerUnit), 0.5 * thickness);
  const mid = crescentAt(0.5);
  let nx = -(e1.y - e0.y) / (chordLen || 1), ny = (e1.x - e0.x) / (chordLen || 1);
  if (nx * Math.cos(mid) + ny * Math.sin(mid) < 0) { nx = -nx; ny = -ny; }
  const last = terminator.length - 1;

  ctx.fillStyle = dominantColor;
  ctx.beginPath();
  terminator.forEach((p, i) => {
    const k = (i === 0 || i === last) ? 0 : underlap;
    if (i === 0) ctx.moveTo(p.x + nx * k, p.y + ny * k); else ctx.lineTo(p.x + nx * k, p.y + ny * k);
  });
  ctx.arc(center.x, center.y, radius, th1, th0, domIncreasing);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = crescentColor;
  ctx.beginPath();
  terminator.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.arc(center.x, center.y, radius, th1, th0, !domIncreasing);
  ctx.closePath();
  ctx.fill();
}

// ---------------------------------------------------------
// SPLIT CONE (2-node mesh sharing a node with a 3+ node mesh)
// ---------------------------------------------------------

// A cone of a joint, cut off at the joint ring: `polys` (lists of screen points)
// are its outline pieces, with the ring's projected interior among them where this
// mesh is the front one. One nonzero path, filled once, so their shared edge along
// the ring doesn't stack (CLAUDE.md rule 3).
export function drawJointBody(ctx, polys, color) {
  const sign = (pts) => pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p.x * q.y - q.x * p.y; }, 0) >= 0 ? 1 : -1;
  const first = polys.find(pts => pts.length >= 3);
  if (!first) return;
  ctx.beginPath();
  polys.forEach(pts => {
    if (pts.length < 3) return;
    const ordered = sign(pts) === sign(first) ? pts : pts.slice().reverse();
    ordered.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
  });
  ctx.fillStyle = color;
  ctx.fill();
}


// The cone's axis frame: unit axis, length, and a radial direction per angle.
export function coneFrame(node, other) {
  const dir = vecNormalize(vecSub(other.center, node.center));
  const len = Math.hypot(other.center.x - node.center.x, other.center.y - node.center.y, other.center.z - node.center.z);
  const helper = Math.abs(dir.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const u = vecNormalize(vecCross(dir, helper));
  const v = vecCross(dir, u);
  const radial = (a) => ({
    x: u.x * Math.cos(a) + v.x * Math.sin(a),
    y: u.y * Math.cos(a) + v.y * Math.sin(a),
    z: u.z * Math.cos(a) + v.z * Math.sin(a),
  });
  return { dir, len, radial, u, v };
}

// cos / sin of i/n of a turn, i = 0..n-1, computed once per n (same values
// as evaluating them at (i / n) * 2 PI each time).
const unitCircles = new Map();
export function unitCircle(n) {
  let t = unitCircles.get(n);
  if (!t) {
    t = { cos: new Float64Array(n), sin: new Float64Array(n) };
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; t.cos[i] = Math.cos(a); t.sin[i] = Math.sin(a); }
    unitCircles.set(n, t);
  }
  return t;
}

// n points evenly spaced on a screen circle, starting at angle 0.
export function circlePoints(center, radius, n) {
  const { cos, sin } = unitCircle(n);
  return Array.from({ length: n }, (_, i) => ({ x: center.x + radius * cos[i], y: center.y + radius * sin[i] }));
}

// ---------------------------------------------------------
// OUTLINES (geometry.js hullOutline): corners, straight tangents and exact elliptical arcs
// ---------------------------------------------------------

const TWO_PI = Math.PI * 2;

// Appends the outline to the path: a corner is a lineTo, an arc is ctx.ellipse for its range (a chord between its ends
// when `skip`), the tangent segments between them come from the path's own connecting lines. Anticlockwise on screen.
export function traceOutline(ctx, ops) {
  let started = false;
  const go = (p) => { if (started) ctx.lineTo(p.x, p.y); else { ctx.moveTo(p.x, p.y); started = true; } };
  ops.forEach(op => {
    if (op.k === 'p') { go(op.p); return; }
    const e = op.e, p0 = ellipsePoint(e, op.from), p1 = ellipsePoint(e, op.to);
    go(p0);
    if (op.skip) { go(p1); return; }
    const start = ellipseParam(e, op.from);
    ctx.ellipse(e.center.x, e.center.y, e.a, e.b, e.angle, start, op.from - op.to >= TWO_PI - 1e-9 ? start - TWO_PI : ellipseParam(e, op.to), true);
  });
  ctx.closePath();
}

export function fillOutline(ctx, ops, color) {
  ctx.beginPath();
  traceOutline(ctx, ops);
  ctx.fillStyle = color;
  ctx.fill();
}

// ---------------------------------------------------------
// SPLIT CONE (round nodes): every curve is an exact ellipse
// ---------------------------------------------------------

// A split ring's circle (or the cone's tangent circle on the shared sphere) projected: an exact ellipse (the
// perspective image of a circle is a conic).
const ringEllipse = (ring, projectPoint) => projectedCircleEllipse(ring.surface, ring.ringRadius, ring.frame, projectPoint);

// A split ring's circle as polygon points (chords within tol), the hull points of a cone's own part at a joint.
export function splitRingPoints(ring, projectPoint, tol) {
  return ellipsePolygon(ringEllipse(ring, projectPoint), tol);
}

// The host-colored part, from the shared node to the ring: the hull of the projected ring, the tangent circle, and
// the shared sphere's rim. The sphere only counts up to its tangent circle: past it, the sphere is inside the cone,
// so its rim points there (axial coordinate above sinT * r, axisCam the axis in camera space: n . axis = R cos(theta +
// delta) <= sinT for the rim point at angle theta) are left out: the rim is an arc, from acos(sinT / R) - delta around
// to 2 PI - acos(sinT / R) - delta.
export function drawSplitShared(ctx, sharedProj, ring, axisCam, color, projectPoint) {
  const rim = { center: sharedProj.center, a: sharedProj.radius, b: sharedProj.radius, angle: 0 };
  const items = [{ e: ringEllipse(ring, projectPoint) }, { e: projectedCircleEllipse(ring.tangentCenter, ring.tangentRadius, ring.frame, projectPoint) }];
  const R = Math.hypot(axisCam.x, axisCam.y), sinT = ring.cone.sinT;
  if (R < 1e-12) { if (sinT >= -1e-9) items.push({ e: rim }); }
  else {
    const q = sinT / R;
    if (q >= 1) items.push({ e: rim });
    else if (q > -1) { const c = Math.acos(q), delta = Math.atan2(axisCam.y, axisCam.x); items.push({ e: rim, th0: c - delta, th1: TWO_PI - c - delta }); }
  }
  fillOutline(ctx, hullOutline(items), color);
}

// The cone's own part, from the ring to the far node. When the far node is a joint (opts.farIsJoint) this part has no
// cap there: the joint circle is drawn separately and the part ends in a chord.
export function drawSplitFar(ctx, farProj, ring, color, projectPoint, opts = {}) {
  const farCircle = { center: farProj.center, a: farProj.radius, b: farProj.radius, angle: 0 };
  fillOutline(ctx, hullOutline([{ e: ringEllipse(ring, projectPoint) }, { e: farCircle, skip: !!opts.farIsJoint }]), color);
}

// ---------------------------------------------------------
// SPLIT CONE WITH SQUASHED NODES (splitRing.js findGeneralSplitRing)
// ---------------------------------------------------------

// A world point q on a node's side of the cone, on the screen by that node's own linear map.
function screenOf(node, proj, q) {
  const dx = q.x - node.center.x, dy = q.y - node.center.y, dz = q.z - node.center.z, { right, up } = proj.axes;
  return {
    x: proj.center.x + proj.scale * (dx * right.x + dy * right.y + dz * right.z),
    y: proj.center.y - proj.scale * (dx * up.x + dy * up.y + dz * up.z),
  };
}

// The split ring's screen polygon and the cone's tangent curve on the shared node (the generatrices'
// shared ends). A ring point is its generatrix' two ends, each mapped by its own node's linear map
// (so they lie on the nodes' drawn ellipses), interpolated at the ring's parameter.
export function splitScreenPoints(ring, sharedNode, sharedProj, farNode, farProj) {
  const { cone, tStar } = ring.general, ringPts = [], tangentPts = [];
  cone.gens.forEach((gen, i) => {
    const a = screenOf(sharedNode, sharedProj, gen.pA), b = screenOf(farNode, farProj, gen.pB), t = tStar[i];
    tangentPts.push(a);
    ringPts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  });
  return { ringPts, tangentPts };
}

// The rim directions (screen normal angles) where the shared body reaches farther than the far body: the shared side
// of the cone. A rim point with screen normal (cx, cy) has the world normal cx right - cy up (the node's own linear
// map); the sphere test n . axis <= sinT is exactly supportH(shared) >= supportH(far). Returns 'full', null or
// { th0, th1 } (increasing): the longest run of directions where it holds, its ends found by bisection.
function sharedSideRange(sharedNode, farNode, sharedProj) {
  const { right, up } = sharedProj.axes;
  const f = (th) => {
    const c = Math.cos(th), s = Math.sin(th);
    const n = { x: c * right.x - s * up.x, y: c * right.y - s * up.y, z: c * right.z - s * up.z };
    return supportH(sharedNode, n) - supportH(farNode, n);
  };
  const N = 96, vals = Array.from({ length: N }, (_, i) => f((i / N) * TWO_PI));
  if (vals.every(v => v >= 0)) return 'full';
  if (vals.every(v => v < 0)) return null;
  const edge = (a, b) => {            // the sign change between angles a and b
    let lo = a, hi = b, flo = f(a) >= 0;
    for (let it = 0; it < 40; it++) { const m = (lo + hi) / 2; if ((f(m) >= 0) === flo) lo = m; else hi = m; }
    return (lo + hi) / 2;
  };
  let best = null;
  const start = vals.findIndex(v => v < 0);
  for (let k = 1; k <= N; k++) {
    const i = (start + k) % N;
    if (vals[i] < 0) continue;
    let j = i, len = 1;
    while (vals[(j + 1) % N] >= 0 && len < N) { j = (j + 1) % N; len++; }
    if (!best || len > best.len) best = { i, j, len };
    k += len - 1;
  }
  const iPrev = (best.i - 1 + N) % N, jNext = (best.j + 1) % N;
  const th0 = edge((iPrev / N) * TWO_PI, (best.i / N) * TWO_PI);
  let th1 = edge((best.j / N) * TWO_PI, (jNext === 0 ? N : jNext) / N * TWO_PI);
  if (th1 < th0) th1 += TWO_PI;
  return { th0, th1 };
}

// The host-colored part, from the shared node to the ring: the hull of the ring, the tangent curve (polygons, they are
// curves of generatrices) and the arc of the shared node's rim ellipse on the shared side of the cone.
export function drawSplitSharedGeneral(ctx, sharedNode, sharedProj, farNode, pts, color) {
  const items = [{ pts: pts.tangentPts.concat(pts.ringPts) }], range = sharedSideRange(sharedNode, farNode, sharedProj);
  if (range === 'full') items.push({ e: nodeEllipse(sharedProj) });
  else if (range) items.push({ e: nodeEllipse(sharedProj), th0: range.th0, th1: range.th1 });
  fillOutline(ctx, hullOutline(items), color);
}

// The cone's own part, from the ring to the far node (a chord instead of the cap there when the far
// node is a joint).
export function drawSplitFarGeneral(ctx, farProj, ringPts, color, opts = {}) {
  fillOutline(ctx, hullOutline([{ pts: ringPts }, { e: nodeEllipse(farProj), skip: !!opts.farIsJoint }]), color);
}
