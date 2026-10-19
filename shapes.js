// Canvas drawing primitives. Layering rules and terms: see CLAUDE.md.
import { SEAM_PX, MIN_CRESCENT_PX } from './config.js';
import {
  vecSub, vecCross, vecDot, vecNormalize, wrapAngle, circleRimPoint,
  capsuleTangentPoints, convexHull, capsulePolygon, clipToConvex,
} from './geometry.js';

// SEAM_PX / 2 device pixels, in the current transform's units.
export function seamUnderlap(ctx) {
  const t = ctx.getTransform();
  return (SEAM_PX / 2) / Math.hypot(t.a, t.b);
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

// Fills a triangle plus a 1px stroke of the same color.
export function drawTriangle(ctx, p1, p2, p3, color) {
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.lineTo(p3.x, p3.y);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();
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
// JOINT CAPSULES
// ---------------------------------------------------------

// Clips everything except the polygon traced by `tracePoly` (evenodd).
// The caller restores.
function clipOut(ctx, tracePoly) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(-1e5, -1e5, 2e5, 2e5);
  tracePoly();
  ctx.closePath();
  ctx.clip('evenodd');
}

// Masks the cut's sliver out of a capsule whose edge can't simply be
// redirected (CLAUDE.md "Capsule cut"). Returns whether a clip was pushed.
function clipOutSliver(ctx, c1, r1, c2, r2, cut) {
  const pc = cut.pivotIsC1 ? c1 : c2, pr = cut.pivotIsC1 ? r1 : r2;
  const underlap = seamUnderlap(ctx);
  const angH = Math.atan2(cut.rimHit.y - pc.y, cut.rimHit.x - pc.x);
  const angT = Math.atan2(cut.tangentRim.y - pc.y, cut.tangentRim.x - pc.x);
  const diff = wrapAngle(angT - angH);
  // The mask closes along the pivot rim, pulled inside it (the joint covers there).
  const ri = pr - underlap;

  if (!cut.other) {
    // Short-arm fallback: crossing is on the far node's circle.
    clipOut(ctx, () => {
      ctx.moveTo(cut.tangentRim.x, cut.tangentRim.y);
      ctx.lineTo(cut.crossing.x, cut.crossing.y);
      ctx.lineTo(cut.rimHit.x, cut.rimHit.y);
      ctx.lineTo(pc.x + ri * Math.cos(angH), pc.y + ri * Math.sin(angH));
      ctx.arc(pc.x, pc.y, ri, angH, angT, diff < 0);
    });
    return true;
  }

  // Extended crossing: only the part the other capsule covers (shrunk by
  // the underlap), with the side along this capsule's edge pushed outward.
  const nx = (cut.tangentRim.x - pc.x) / pr, ny = (cut.tangentRim.y - pc.y) / pr;
  const push = (p) => ({ x: p.x + nx * underlap * 2, y: p.y + ny * underlap * 2 });
  const o = cut.other;
  const cover = capsulePolygon(o.c1, Math.max(o.r1 - underlap, 0), o.c2, Math.max(o.r2 - underlap, 0));
  const rimArc = [];
  for (let i = 0; i <= 16; i++) rimArc.push(circleRimPoint(pc, ri, angH + diff * i / 16));
  const mask = clipToConvex([push(cut.tangentRim), push(cut.crossing), cut.crossing, cut.rimHit, ...rimArc], cover);
  if (mask.length < 3) return false;
  clipOut(ctx, () => {
    ctx.moveTo(mask[0].x, mask[0].y);
    mask.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
  });
  return true;
}

// A capsule with optional skipped caps. `cut` (CLAUDE.md "Capsule cut")
// removes the sliver between one tangent edge and the seam line:
// cut = { pivotIsC1, crossing, rimHit, tangentRim, other }.
// Returns whether the fill was masked (the mask can reach into the far
// node's circle, so the caller re-fills it).
export function drawPairCapsule(ctx, c1, r1, c2, r2, color, skipCap1 = false, skipCap2 = false, cut = null) {
  const { t1Angle, t2Angle, p1a, p1b, p2a, p2b } = capsuleTangentPoints(c1, r1, c2, r2);
  const cap2 = () => skipCap2 ? ctx.lineTo(p2a.x, p2a.y) : ctx.arc(c2.x, c2.y, r2, t1Angle, t2Angle, true);
  const cap1 = () => skipCap1 ? ctx.lineTo(p1a.x, p1a.y) : ctx.arc(c1.x, c1.y, r1, t2Angle, t1Angle, true);
  const to = (p) => ctx.lineTo(p.x, p.y);

  // Which tangent edge the crossing lies on, and whether it's on it at all.
  const distToLine = (p, u, v) =>
    Math.abs((v.x - u.x) * (p.y - u.y) - (v.y - u.y) * (p.x - u.x)) / (Math.hypot(v.x - u.x, v.y - u.y) || 1);
  const d1 = cut ? distToLine(cut.crossing, p1a, p1b) : 0;
  const d2 = cut ? distToLine(cut.crossing, p2a, p2b) : 0;
  const onEdge = cut && !cut.other && Math.min(d1, d2) < 1e-6 * Math.max(r1, r2, 1);

  const clipped = cut && !onEdge ? clipOutSliver(ctx, c1, r1, c2, r2, cut) : false;

  ctx.beginPath();
  if (!onEdge) {
    ctx.moveTo(p1a.x, p1a.y); to(p1b); cap2(); to(p2b); cap1();
  } else {
    // Redirect the edge: far node -> crossing -> rimHit, then chord across the pivot.
    const onT1 = d1 <= d2;
    const { crossing, rimHit } = cut;
    if (!cut.pivotIsC1) {
      if (onT1) { ctx.moveTo(p1a.x, p1a.y); to(crossing); to(rimHit); to(p2a); to(p2b); cap1(); }
      else      { ctx.moveTo(p1a.x, p1a.y); to(p1b); to(rimHit); to(crossing); to(p2b); cap1(); }
    } else {
      if (onT1) { ctx.moveTo(rimHit.x, rimHit.y); to(crossing); to(p1b); cap2(); to(p2b); }
      else      { ctx.moveTo(p1a.x, p1a.y); to(p1b); cap2(); to(crossing); to(rimHit); }
    }
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  if (clipped) ctx.restore();
  return clipped;
}

// The seam band the lower capsule lays under a cut (CLAUDE.md "Seam band"):
// SEAM_PX / 2 wide, along the seam line, on the sliver's side.
export function drawSeamBand(ctx, cut, color) {
  const w = seamUnderlap(ctx);
  const { crossing, rimHit, tangentRim } = cut;
  const lx = rimHit.x - crossing.x, ly = rimHit.y - crossing.y;
  const len = Math.hypot(lx, ly) || 1;
  // Distance from the seam line, positive on the sliver's side.
  const side = Math.sign(lx * (tangentRim.y - crossing.y) - ly * (tangentRim.x - crossing.x)) || 1;
  const off = (p) => side * (lx * (p.y - crossing.y) - ly * (p.x - crossing.x)) / len;
  // Point on segment from -> tangentRim that is w from the line.
  const toward = (from) => {
    const s = Math.min(1, w / Math.max(off(tangentRim) - off(from), 1e-9));
    return { x: from.x + (tangentRim.x - from.x) * s, y: from.y + (tangentRim.y - from.y) * s };
  };
  let band = [crossing, toward(crossing), toward(rimHit), rimHit];
  if (cut.other) {
    // An extended crossing runs past the upper capsule; keep to what it covers.
    const o = cut.other;
    band = clipToConvex(band, capsulePolygon(o.c1, Math.max(o.r1 - w, 0), o.c2, Math.max(o.r2 - w, 0)));
  }
  fillPolygon(ctx, band, color);
}

// ---------------------------------------------------------
// JOINT NODE (moon-phase split circle)
// ---------------------------------------------------------

// colorA faces meshA, colorB faces meshB, divided by the terminator
// ellipse (local frame: rotated by azimuth, half-width |phase| * r).
// The dominant side is filled first, reaching `underlap` under the
// crescent's inner edges but not its rim; the crescent goes on top.
// trim (local coords) cuts the crescent off at the seam line:
// { start: far pole, end: tangent angle, anticlockwise, rimHit }.
export function drawJointSplitCircle(ctx, screenCenter, screenRadius, azimuth, phase, colorA, colorB, trim) {
  const r = screenRadius;
  const ex = Math.abs(phase) * r;
  const termCcw = phase >= 0;
  const dominantColor = termCcw ? colorA : colorB;
  const crescentColor = termCcw ? colorB : colorA;

  ctx.save();
  ctx.translate(screenCenter.x, screenCenter.y);
  ctx.rotate(azimuth);

  const t = ctx.getTransform();
  const pxPerUnit = Math.hypot(t.a, t.b);

  // A sub-pixel crescent would only render as a hairline along the rim.
  if ((r - ex) * pxPerUnit < MIN_CRESCENT_PX) {
    ctx.fillStyle = dominantColor;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  const underlap = (SEAM_PX / 2) / pxPerUnit;
  ctx.fillStyle = dominantColor;
  ctx.beginPath();
  if (trim) {
    // From just past rimHit the long way round to the far pole, back along
    // a wider terminator; closePath runs parallel to the seam line.
    const rimHitAngle = Math.atan2(trim.rimHit.y, trim.rimHit.x);
    const startAngle = rimHitAngle + (trim.anticlockwise ? 1 : -1) * underlap / r;
    ctx.arc(0, 0, r, startAngle, trim.start, trim.anticlockwise);
    ctx.ellipse(0, 0, ex + underlap, r, 0, trim.start, trim.end, trim.anticlockwise);
  } else if (termCcw) {
    ctx.arc(0, 0, r, Math.PI / 2, 3 * Math.PI / 2, false);
    ctx.ellipse(0, 0, ex + underlap, r, 0, -Math.PI / 2, Math.PI / 2, false);
  } else {
    ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);
    ctx.ellipse(0, 0, ex + underlap, r, 0, Math.PI / 2, 3 * Math.PI / 2, false);
  }
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = crescentColor;
  ctx.beginPath();
  if (trim) {
    const rimHitAngle = Math.atan2(trim.rimHit.y, trim.rimHit.x);
    ctx.ellipse(0, 0, ex, r, 0, trim.start, trim.end, trim.anticlockwise);
    ctx.lineTo(trim.rimHit.x, trim.rimHit.y);
    ctx.arc(0, 0, r, rimHitAngle, trim.start, !trim.anticlockwise);
  } else if (termCcw) {
    ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);
    ctx.ellipse(0, 0, ex, r, 0, Math.PI / 2, -Math.PI / 2, true);
  } else {
    ctx.arc(0, 0, r, Math.PI / 2, -Math.PI / 2, false);
    ctx.ellipse(0, 0, ex, r, 0, -Math.PI / 2, Math.PI / 2, true);
  }
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

// ---------------------------------------------------------
// SPLIT CONE (2-node mesh sharing a node with a 3+ node mesh)
// ---------------------------------------------------------

// The 2-node mesh as a 3D cone from `node` to `other`: its cross-section
// ring where the axis leaves `node`'s sphere (CLAUDE.md "Split cone").
function coneRing(node, other, n, projectPoint) {
  const dir = vecNormalize(vecSub(other.center, node.center));
  const surface = {
    x: node.center.x + node.radius * dir.x,
    y: node.center.y + node.radius * dir.y,
    z: node.center.z + node.radius * dir.z,
  };
  const len = Math.hypot(other.center.x - node.center.x, other.center.y - node.center.y, other.center.z - node.center.z);
  const ringR = node.radius + (other.radius - node.radius) * (node.radius / len);
  const helper = Math.abs(dir.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const u = vecNormalize(vecCross(dir, helper));
  const v = vecCross(dir, u);
  const ring = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const radial = {
      x: u.x * Math.cos(a) + v.x * Math.sin(a),
      y: u.y * Math.cos(a) + v.y * Math.sin(a),
      z: u.z * Math.cos(a) + v.z * Math.sin(a),
    };
    ring.push(projectPoint({ x: surface.x + radial.x * ringR, y: surface.y + radial.y * ringR, z: surface.z + radial.z * ringR }));
  }
  return { dir, surface, ring };
}

// Each part is the hull of the projected ring and its end circle; the
// part on the camera's side of the ring plane is drawn second.
export function drawSplitCone(ctx, shared, far, sharedProj, farProj, sharedColor, farColor, camPos, projectPoint) {
  const { dir, surface, ring: ringPts } = coneRing(shared, far, 128, projectPoint);
  const circlePts = (p) => Array.from({ length: 128 }, (_, i) => circleRimPoint(p.center, p.radius, (i / 128) * Math.PI * 2));
  const drawShared = () => fillPolygon(ctx, convexHull(circlePts(sharedProj).concat(ringPts)), sharedColor);
  const drawFar = () => fillPolygon(ctx, convexHull(ringPts.concat(circlePts(farProj))), farColor);
  if (vecDot(vecSub(camPos, surface), dir) > 0) { drawShared(); drawFar(); }
  else { drawFar(); drawShared(); }
}
