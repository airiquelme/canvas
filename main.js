const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

// ---------------------------------------------------------
// DESIGN SPACE
// ---------------------------------------------------------
const DESIGN_WIDTH = 1000;
const DESIGN_HEIGHT = 1000;

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

function applyDesignSpaceTransform() {
  const dpr = window.devicePixelRatio || 1;
  const scaleX = (canvas.width / dpr) / DESIGN_WIDTH;
  const scaleY = (canvas.height / dpr) / DESIGN_HEIGHT;
  const scale = Math.min(scaleX, scaleY) * dpr;
  const offsetX = (canvas.width - DESIGN_WIDTH * scale) / 2;
  const offsetY = (canvas.height - DESIGN_HEIGHT * scale) / 2;
  ctx.setTransform(scale, 0, 0, scale, offsetX, offsetY);
}

// ---------------------------------------------------------
// LIGHT
// ---------------------------------------------------------
const light = { x: 0, y: 0, z: 0 };

// ---------------------------------------------------------
// MOON-PHASE CIRCLE SHADING (plain, uncut)
// ---------------------------------------------------------
function getCircleLightInfo(circleX, circleY) {
  const dx = light.x - circleX, dy = light.y - circleY, dz = light.z;
  const dist = Math.hypot(dx, dy, dz) || 1;
  const angle = Math.atan2(dy, dx);
  const phase = Math.max(-1, Math.min(1, dz / dist));
  return { angle, phase };
}

function drawMoonPhaseCircle(ctx, circleX, circleY, r, baseColor, shadeColor, avoidConstraints) {
  const { angle, phase } = getCircleLightInfo(circleX, circleY);

  ctx.save();
  ctx.beginPath();
  ctx.arc(circleX, circleY, r, 0, Math.PI * 2);
  ctx.clip();

  // No base-color repaint here -- the link's own base fill already
  // covers this circle, and the tube shade may already be drawn on
  // top of that. Repainting here would erase it; skipping lets the
  // crescent below simply ADD to what's already there.
  ctx.translate(circleX, circleY);

  // For each connected link, slide the cutoff to the red tangent
  // point and remove the sliver beyond it (toward the link).
  if (avoidConstraints) {
    for (const { avoidAngle, offset } of avoidConstraints) {
      ctx.rotate(avoidAngle);
      ctx.beginPath();
      ctx.rect(-r * 1.5, -r * 1.5, r * 1.5 + offset, r * 3); // keep local x <= offset
      ctx.clip();
      ctx.rotate(-avoidAngle);
    }
  }

  ctx.rotate(angle); // local +x now points toward the light

  const ex = Math.abs(phase) * r;
  ctx.fillStyle = shadeColor;
  ctx.beginPath();
  ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, true);
  const termCcw = phase >= 0 ? false : true;
  ctx.ellipse(0, 0, ex, r, 0, Math.PI / 2, -Math.PI / 2, termCcw);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

// Project a point onto the given axis direction, relative to a
// circle's own center -- how far the cutoff should slide.
function computeSlideOffset(circleX, circleY, axisAngle, point) {
  if (!point) return 0;
  const dx = point.x - circleX, dy = point.y - circleY;
  return dx * Math.cos(axisAngle) + dy * Math.sin(axisAngle);
}

// ---------------------------------------------------------
// NEW RED MARKER: points on circle A's shade ellipse where the
// tangent line is ALSO tangent to circle B (the actual linked
// circle, not its own ellipse).
// ---------------------------------------------------------
// Ellipse A local tangent line at theta: A_coef*x + B_coef*y = 1
//   A_coef = cos(theta)/(kA*rA), B_coef = sin(theta)/rA
// Distance from circle B's center (in A's local frame) to this line
// must equal rB:
//   (A_coef*bx + B_coef*by - 1) = +/- rB * sqrt(A_coef^2+B_coef^2)
function localOf(cA, azimuthA, worldPoint) {
  const dx = worldPoint.x - cA.x, dy = worldPoint.y - cA.y;
  return {
    x: dx * Math.cos(azimuthA) + dy * Math.sin(azimuthA),
    y: -dx * Math.sin(azimuthA) + dy * Math.cos(azimuthA),
  };
}

function ellipseCircleResidual(theta, kA, rA, bx, by, rB, sign) {
  const Ac = Math.cos(theta) / (kA * rA);
  const Bc = Math.sin(theta) / rA;
  const d = Ac * bx + Bc * by - 1;
  return d - sign * rB * Math.hypot(Ac, Bc);
}

function findEllipseCircleRoots(kA, rA, bx, by, rB, sign, steps = 240) {
  const f = (theta) => ellipseCircleResidual(theta, kA, rA, bx, by, rB, sign);
  let prevTheta = -Math.PI, prevVal = f(prevTheta);
  const roots = [];
  for (let i = 1; i <= steps; i++) {
    const theta = -Math.PI + (2 * Math.PI) * (i / steps);
    const val = f(theta);
    if (isFinite(val) && isFinite(prevVal) && Math.sign(val) !== Math.sign(prevVal)) {
      let lo = prevTheta, hi = theta, flo = prevVal;
      for (let it = 0; it < 50; it++) {
        const mid = (lo + hi) / 2, fm = f(mid);
        if (Math.sign(fm) === Math.sign(flo)) { lo = mid; flo = fm; } else { hi = mid; }
      }
      roots.push((lo + hi) / 2);
    }
    prevTheta = theta; prevVal = val;
  }
  return roots;
}

function isVisibleTheta(theta, phase) {
  const c = Math.cos(theta);
  return phase >= 0 ? c <= 0 : c >= 0;
}

// Returns array of { pointA, pointB, theta } -- pointA on circle A's
// ellipse, pointB the actual tangency point on circle B, connected by
// the same straight tangent line.
function computeEllipseCircleTangentPoints(cA, azimuthA, phaseA, rA, cB, rB) {
  const kA = Math.abs(phaseA);
  if (kA < 1e-6) return [];
  const local = localOf(cA, azimuthA, cB);

  const results = [];
  for (const sign of [1, -1]) {
    const thetas = findEllipseCircleRoots(kA, rA, local.x, local.y, rB, sign);
    for (const theta of thetas) {
      if (!isVisibleTheta(theta, phaseA)) continue;
      const Ac = Math.cos(theta) / (kA * rA), Bc = Math.sin(theta) / rA;
      const norm = Math.hypot(Ac, Bc);

      // Point on ellipse A (world space)
      const lxA = kA * rA * Math.cos(theta), lyA = rA * Math.sin(theta);
      const pointA = {
        x: cA.x + lxA * Math.cos(azimuthA) - lyA * Math.sin(azimuthA),
        y: cA.y + lxA * Math.sin(azimuthA) + lyA * Math.cos(azimuthA),
      };

      // Tangency point on circle B: foot of perpendicular from B's
      // center (in A's local frame) onto the tangent line, offset by rB
      const tangXLocal = local.x - sign * rB * (Ac / norm);
      const tangYLocal = local.y - sign * rB * (Bc / norm);
      const pointB = {
        x: cA.x + tangXLocal * Math.cos(azimuthA) - tangYLocal * Math.sin(azimuthA),
        y: cA.y + tangXLocal * Math.sin(azimuthA) + tangYLocal * Math.cos(azimuthA),
      };

      results.push({ pointA, pointB, theta });
    }
  }
  return results;
}

function drawTangentLine(ctx, pointA, pointB) {
  ctx.strokeStyle = '#ff3333';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(pointA.x, pointA.y);
  ctx.lineTo(pointB.x, pointB.y);
  ctx.stroke();
  ctx.fillStyle = '#ff3333';
  ctx.beginPath();
  ctx.arc(pointA.x, pointA.y, 5, 0, Math.PI * 2);
  ctx.fill();
}

// A strip running parallel to a given line (here, the chosen red
// tangent line), from that line out to the far/shaded edge of the
// tube, so it continues the circle's own cutoff shade seamlessly.
function drawTubeShade(ctx, c1, r1, c2, r2, originX, originY, lineAngle, farEdgeSign, shadeColor) {
  ctx.save();
  traceLinkPath(ctx, c1, r1, c2, r2);
  ctx.clip();

  ctx.translate(originX, originY);
  ctx.rotate(lineAngle);

  const BIG = 100000;
  ctx.fillStyle = shadeColor;
  const yA = 0, yB = farEdgeSign * BIG;
  const yStart = Math.min(yA, yB), yEnd = Math.max(yA, yB);
  ctx.fillRect(-BIG, yStart, BIG * 2, yEnd - yStart);

  ctx.restore();
}

// Which perpendicular side (relative to lineAngle) is the shaded,
// far-from-light side.
function computeFarEdgeSign(azimuth, lineAngle) {
  const perpAngle = lineAngle + Math.PI / 2;
  return Math.cos(azimuth - perpAngle) >= 0 ? -1 : 1;
}

// Draws the FULL ellipse terminator curve (not the fixed rim half) in
// black, always at its true uncut extent -- regardless of whatever
// half-plane cutoff is currently clipping the actual shade fill. Lets
// you track where the boundary "really" is even when trimmed.
function drawEllipseBoundary(ctx, circleX, circleY, r, azimuth, phase) {
  const ex = Math.abs(phase) * r;
  const termCcw = phase >= 0 ? false : true;

  ctx.save();
  ctx.beginPath();
  ctx.arc(circleX, circleY, r, 0, Math.PI * 2);
  ctx.clip();

  ctx.translate(circleX, circleY);
  ctx.rotate(azimuth);

  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(0, 0, ex, r, 0, Math.PI / 2, -Math.PI / 2, termCcw);
  ctx.stroke();

  ctx.restore();
}

// ---------------------------------------------------------
// COMMON TANGENT TO TWO ELLIPSES (green marker)
// ---------------------------------------------------------
// Where would a single straight line be tangent to BOTH circles'
// (uncut) shade boundaries simultaneously? Solved numerically: scan +
// bisect for sign changes in a residual, verify each is a true
// double-tangent (not a branch-switch artifact), then require BOTH
// points to be on their own circle's VISIBLE side -- this generically
// leaves exactly one candidate, no unstable tie-break needed.
function ellipsePointWorld(c, azimuth, k, r, theta) {
  const lx = k * r * Math.cos(theta), ly = r * Math.sin(theta);
  return {
    x: c.x + lx * Math.cos(azimuth) - ly * Math.sin(azimuth),
    y: c.y + lx * Math.sin(azimuth) + ly * Math.cos(azimuth),
  };
}
function ellipseTangentWorld(azimuth, k, r, theta) {
  const lx = -k * r * Math.sin(theta), ly = r * Math.cos(theta);
  return {
    x: lx * Math.cos(azimuth) - ly * Math.sin(azimuth),
    y: lx * Math.sin(azimuth) + ly * Math.cos(azimuth),
  };
}
function findThetaForDirection(azimuth, k, dirAngle) {
  const delta = dirAngle - azimuth;
  const b1 = Math.atan2(-Math.cos(delta), k * Math.sin(delta));
  return [b1, b1 + Math.PI];
}
function crossVec(a, b) { return a.x * b.y - a.y * b.x; }

function commonTangentResidual(cA, azA, kA, rA, cB, azB, kB, rB, thetaB) {
  const TB = ellipseTangentWorld(azB, kB, rB, thetaB);
  const dirAngle = Math.atan2(TB.y, TB.x);
  const candidates = findThetaForDirection(azA, kA, dirAngle);
  const PB = ellipsePointWorld(cB, azB, kB, rB, thetaB);
  let best = Infinity, bestThetaA = null;
  for (const thetaA of candidates) {
    const PA = ellipsePointWorld(cA, azA, kA, rA, thetaA);
    const diff = { x: PB.x - PA.x, y: PB.y - PA.y };
    const denom = Math.hypot(diff.x, diff.y) * Math.hypot(TB.x, TB.y) || 1;
    const res = crossVec(diff, TB) / denom;
    if (Math.abs(res) < Math.abs(best)) { best = res; bestThetaA = thetaA; }
  }
  return { residual: best, thetaA: bestThetaA };
}

function computeCommonTangentPoints(cA, azA, phaseA, rA, cB, azB, phaseB, rB, preferPoint) {
  const kA = Math.abs(phaseA), kB = Math.abs(phaseB);
  if (kA < 1e-6 || kB < 1e-6) return null;

  const f = (thetaB) => commonTangentResidual(cA, azA, kA, rA, cB, azB, kB, rB, thetaB).residual;

  const steps = 240;
  let prevTheta = -Math.PI, prevVal = f(prevTheta);
  const roots = [];
  for (let i = 1; i <= steps; i++) {
    const theta = -Math.PI + (2 * Math.PI) * (i / steps);
    const val = f(theta);
    if (isFinite(val) && isFinite(prevVal) && Math.sign(val) !== Math.sign(prevVal) && Math.abs(val) < 50 && Math.abs(prevVal) < 50) {
      let lo = prevTheta, hi = theta, flo = prevVal;
      for (let it = 0; it < 50; it++) {
        const mid = (lo + hi) / 2, fm = f(mid);
        if (Math.sign(fm) === Math.sign(flo)) { lo = mid; flo = fm; } else { hi = mid; }
      }
      roots.push((lo + hi) / 2);
    }
    prevTheta = theta; prevVal = val;
  }

  function isVisible(theta, phase) {
    const c = Math.cos(theta);
    return phase >= 0 ? c <= 0 : c >= 0;
  }

  let best = null, bestScore = Infinity;
  for (const thetaB of roots) {
    const { thetaA } = commonTangentResidual(cA, azA, kA, rA, cB, azB, kB, rB, thetaB);
    const TA = ellipseTangentWorld(azA, kA, rA, thetaA);
    const PA = ellipsePointWorld(cA, azA, kA, rA, thetaA);
    const PB = ellipsePointWorld(cB, azB, kB, rB, thetaB);
    const lineDir = { x: PB.x - PA.x, y: PB.y - PA.y };
    const tangentACheck = Math.abs(crossVec(TA, lineDir)) / (Math.hypot(TA.x, TA.y) * Math.hypot(lineDir.x, lineDir.y) || 1);
    if (tangentACheck > 0.01) continue;

    if (!isVisible(thetaA, phaseA) || !isVisible(thetaB, phaseB)) continue;

    const score = Math.hypot(PA.x - preferPoint.x, PA.y - preferPoint.y);
    if (score < bestScore) { bestScore = score; best = { pointA: PA, pointB: PB }; }
  }
  return best;
}

function drawGreenTangentLine(ctx, pointA, pointB) {
  ctx.strokeStyle = '#33ff33';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(pointA.x, pointA.y);
  ctx.lineTo(pointB.x, pointB.y);
  ctx.stroke();
  ctx.fillStyle = '#33ff33';
  [pointA, pointB].forEach(p => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fill();
  });
}

// Kurzgesagt-style cartoon shade: a thick rounded-cap stroke running
// along the circle's rim, from one pole directly to the other (the
// fixed far half of the circle, away from the light) -- matching the
// black pole markers exactly, not a phase-proportional sweep.
function drawCartoonShadeLine(ctx, circleX, circleY, r, azimuth, phase, shadeColor) {
  const thickness = r * (1 - phase); // same length as the green thickness line: 0 at full moon, 2r at new moon

  ctx.save();
  ctx.beginPath();
  ctx.arc(circleX, circleY, r, 0, Math.PI * 2);
  ctx.clip();

  ctx.translate(circleX, circleY);
  ctx.rotate(azimuth);

  ctx.strokeStyle = shadeColor;
  ctx.lineWidth = thickness * 2; // lineWidth is the stroke's diameter; doubling makes its RADIUS match the green line
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, true); // pole to pole, via the far side
  ctx.stroke();

  ctx.restore();
}

// The two "pole" points where the terminator meets the true circle
// rim -- directly: perpendicular to the light direction, at radius r.
// No ellipse formula needed at all.
function drawPoleMarkers(ctx, circleX, circleY, r, azimuth) {
  const perpAngle = azimuth + Math.PI / 2;
  const pole1 = { x: circleX + r * Math.cos(perpAngle), y: circleY + r * Math.sin(perpAngle) };
  const pole2 = { x: circleX - r * Math.cos(perpAngle), y: circleY - r * Math.sin(perpAngle) };
  ctx.fillStyle = '#000000';
  [pole1, pole2].forEach(p => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fill();
  });
}

// Green line: from the ellipse's widest point (the equator, where the
// terminator bulges furthest) to the true circle edge at the same
// height -- showing the maximum shade thickness at the current phase.
function drawShadeThicknessLine(ctx, circleX, circleY, r, azimuth, phase) {
  const localXMid = -phase * r;  // widest point of the terminator (y=0)
  const localXEdge = -r;         // the FIXED boundary edge -- always the same side, never flips with phase sign

  const midPoint = { x: circleX + localXMid * Math.cos(azimuth), y: circleY + localXMid * Math.sin(azimuth) };
  const edgePoint = { x: circleX + localXEdge * Math.cos(azimuth), y: circleY + localXEdge * Math.sin(azimuth) };

  ctx.strokeStyle = '#33ff33';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(midPoint.x, midPoint.y);
  ctx.lineTo(edgePoint.x, edgePoint.y);
  ctx.stroke();
  ctx.fillStyle = '#33ff33';
  [midPoint, edgePoint].forEach(p => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fill();
  });
}

// Where does the stroke's rounded cap (a circle of radius = the
// stroke's own radius, centered at the pole) cross back through the
// main circle? Standard circle-circle intersection, preferring the
// point in the direction the stroke sweeps (toward the far side).
function computeCapIntersection(r, capRadius, poleLocalX, poleLocalY, preferNegX) {
  const d = (r * r - capRadius * capRadius) / 2;
  const polTheta = Math.atan2(poleLocalY, poleLocalX);
  const cosVal = d / (r * r);
  if (Math.abs(cosVal) > 1) return null; // cap has grown large enough to fully engulf the circle
  const delta = Math.acos(cosVal);
  const t1 = polTheta + delta, t2 = polTheta - delta;
  const p1 = { x: r * Math.cos(t1), y: r * Math.sin(t1) };
  const p2 = { x: r * Math.cos(t2), y: r * Math.sin(t2) };
  return preferNegX ? (p1.x < p2.x ? p1 : p2) : (p1.x > p2.x ? p1 : p2);
}

function drawCapMeetingPoints(ctx, circleX, circleY, r, azimuth, phase) {
  const thickness = r * (1 - phase);
  const capRadius = thickness;

  const toWorld = (lx, ly) => ({
    x: circleX + lx * Math.cos(azimuth) - ly * Math.sin(azimuth),
    y: circleY + lx * Math.sin(azimuth) + ly * Math.cos(azimuth),
  });

  // Two poles: start (-PI/2 local) and end (PI/2 local). The stroke
  // sweeps through the far/negative-x side, so each cap's relevant
  // intersection is the one on that same side.
  const pole1Local = { x: 0, y: -r };
  const pole2Local = { x: 0, y: r };

  const pt1 = computeCapIntersection(r, capRadius, pole1Local.x, pole1Local.y, true);
  const pt2 = computeCapIntersection(r, capRadius, pole2Local.x, pole2Local.y, true);

  ctx.fillStyle = '#ff3333';
  [pt1, pt2].forEach(pt => {
    if (!pt) return;
    const world = toWorld(pt.x, pt.y);
    ctx.beginPath();
    ctx.arc(world.x, world.y, 5, 0, Math.PI * 2);
    ctx.fill();
  });
}

// ---------------------------------------------------------
// SHAPES: two-circle tangent link (flat, no shading of its own)
// ---------------------------------------------------------
function computeLinkTangents(c1, r1, c2, r2) {
  const dx = c2.x - c1.x, dy = c2.y - c1.y;
  const d = Math.hypot(dx, dy);
  const centerAngle = Math.atan2(dy, dx);
  const alpha = Math.asin((r1 - r2) / d);
  const t1Angle = centerAngle + Math.PI / 2 + alpha;
  const t2Angle = centerAngle - Math.PI / 2 - alpha;
  const point = (c, r, a) => ({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
  return {
    p1a: point(c1, r1, t1Angle), p2a: point(c2, r2, t1Angle),
    p1b: point(c1, r1, t2Angle), p2b: point(c2, r2, t2Angle),
    t1Angle, t2Angle,
  };
}

function traceLinkPath(ctx, c1, r1, c2, r2) {
  const { p1a, p2a, p1b, t1Angle, t2Angle } = computeLinkTangents(c1, r1, c2, r2);
  ctx.beginPath();
  ctx.moveTo(p1a.x, p1a.y);
  ctx.lineTo(p2a.x, p2a.y);
  ctx.arc(c2.x, c2.y, r2, t1Angle, t2Angle, true);
  ctx.lineTo(p1b.x, p1b.y);
  ctx.arc(c1.x, c1.y, r1, t2Angle, t1Angle, true);
  ctx.closePath();
}

function drawLinkFlat(ctx, c1, r1, c2, r2, baseColor) {
  traceLinkPath(ctx, c1, r1, c2, r2);
  ctx.fillStyle = baseColor;
  ctx.fill();
}

// ---------------------------------------------------------
// RENDER
// ---------------------------------------------------------
const baseColor = '#4fc3f7';
const shadeColor = 'rgb(2, 50, 80)';

function render() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  applyDesignSpaceTransform();

  const cx = DESIGN_WIDTH / 2, cy = DESIGN_HEIGHT / 2;

  // Single circle -- light orbits through z only, cycling smoothly
  // through every phase from full to new moon.
  const circle = { x: cx, y: cy };
  const r = 120;

  ctx.fillStyle = baseColor;
  ctx.beginPath();
  ctx.arc(circle.x, circle.y, r, 0, Math.PI * 2);
  ctx.fill();

  const info = getCircleLightInfo(circle.x, circle.y);

  drawCartoonShadeLine(ctx, circle.x, circle.y, r, info.angle, info.phase, shadeColor);
  drawEllipseBoundary(ctx, circle.x, circle.y, r, info.angle, info.phase);
  drawPoleMarkers(ctx, circle.x, circle.y, r, info.angle);
  drawShadeThicknessLine(ctx, circle.x, circle.y, r, info.angle, info.phase);
  drawCapMeetingPoints(ctx, circle.x, circle.y, r, info.angle, info.phase);

  // Light position marker -- sized by z: smallest when far (z very
  // negative, behind), biggest when close (z very positive, in front)
  const zMin = -400, zMax = 400, radiusMin = 4, radiusMax = 28;
  const zClamped = Math.max(zMin, Math.min(zMax, light.z));
  const markerRadius = radiusMin + (radiusMax - radiusMin) * ((zClamped - zMin) / (zMax - zMin));
  ctx.fillStyle = 'rgba(255, 220, 120, 0.9)';
  ctx.beginPath();
  ctx.arc(light.x, light.y, markerRadius, 0, Math.PI * 2);
  ctx.fill();
}

// Light orbits in 3D through the Y-Z plane (x stays fixed, centered
// on the circle) -- sweeping from directly above, through in-front,
// through directly below, through behind, and back. This covers every
// combination of azimuth and phase naturally, like a real orbit,
// rather than only modulating depth along one fixed line.
const cx0 = DESIGN_WIDTH / 2, cy0 = DESIGN_HEIGHT / 2;
const lightOrbitRadius = 400;
light.x = cx0;

let t = 0;
let lastTime = 0;
function loop(timestamp) {
  const dt = (timestamp - lastTime) / 1000;
  lastTime = timestamp;
  t += dt;

  const orbitAngle = t * 0.5;
  light.y = cy0 + Math.sin(orbitAngle) * lightOrbitRadius;
  light.z = Math.cos(orbitAngle) * lightOrbitRadius;

  render();
  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);