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
// LIGHT: orbits azimuthally at fixed radius/z (phase stays constant)
// ---------------------------------------------------------
const orbitRadius = 380;
const fixedZ = 250;
const light = { x: 0, y: 0, z: fixedZ };

// ---------------------------------------------------------
// MOON-PHASE CIRCLE SHADING
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

  // No base-color repaint here anymore -- the link's own base fill
  // already covers this circle, and the tube shade may have already
  // been drawn on top of that. Repainting base color here would
  // erase the tube shade; skipping it lets the crescent below simply
  // ADD to whatever's already there, so the straight tube strip and
  // the curved crescent merge instead of one overwriting the other.
  ctx.translate(circleX, circleY);

  // For each connected link, clip out the side of the cutoff line
  // facing TOWARD it. The cutoff itself still runs perpendicular to
  // the link direction (same as before) -- but now it's SLID along
  // that direction to pass through the tangent point instead of
  // always through the center.
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

// Of the two tangent-equation solutions, only ONE is ever on the
// visible crescent (the other is its mirror on the hidden side of
// the ellipse). Returns that one's world point, or null.
function getVisibleTangentPoint(points, phase) {
  const visible = points.filter(p => {
    const cosTheta = Math.cos(p.theta);
    return phase >= 0 ? cosTheta <= 0 : cosTheta >= 0;
  });
  return visible.length ? visible[0] : null;
}

// Project the tangent point onto the link's own direction to get how
// far along that axis the cutoff line should slide (0 = through the
// center, matching the previous behavior).
function computeSlideOffset(circleX, circleY, avoidAngle, tangentPoint) {
  if (!tangentPoint) return 0;
  const dx = tangentPoint.x - circleX, dy = tangentPoint.y - circleY;
  return dx * Math.cos(avoidAngle) + dy * Math.sin(avoidAngle);
}

// ---------------------------------------------------------
// TANGENT MARKERS: both points where the shade boundary's tangent
// is parallel to a given reference (yellow) line direction
// ---------------------------------------------------------
function computeTangentPoints(circleX, circleY, r, azimuth, phase, lineAngle) {
  const delta = lineAngle - azimuth;
  const k = Math.abs(phase);
  if (k < 1e-6) return [];

  const branch1 = Math.atan2(-Math.cos(delta), k * Math.sin(delta));
  const branch2 = branch1 + Math.PI;

  return [branch1, branch2].map(theta => {
    const localX = k * r * Math.cos(theta);
    const localY = r * Math.sin(theta);
    const worldX = circleX + localX * Math.cos(azimuth) - localY * Math.sin(azimuth);
    const worldY = circleY + localX * Math.sin(azimuth) + localY * Math.cos(azimuth);
    return { x: worldX, y: worldY, theta };
  });
}

function drawTangentMarker(ctx, point, lineAngle, length) {
  const dx = Math.cos(lineAngle) * length, dy = Math.sin(lineAngle) * length;
  ctx.strokeStyle = '#ff3333';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(point.x - dx, point.y - dy);
  ctx.lineTo(point.x + dx, point.y + dy);
  ctx.stroke();
  ctx.fillStyle = '#ff3333';
  ctx.beginPath();
  ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
  ctx.fill();
}

// A strip running PARALLEL TO THE GREEN LINE itself (not the tube's
// length axis) -- since both green points lie exactly ON that line,
// translating to either one and rotating by the line's own angle puts
// the line at local y=0, so the shade is simply everything from there
// out to the far/shaded edge, no separate offset needed.
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

// Marker's distance from the origin's center, measured along the
// PERPENDICULAR-to-length axis (how far it sits from the centerline
// widthwise) -- this sets the strip's width.
function computePerpOffset(originX, originY, lengthAngle, tangentPoint) {
  if (!tangentPoint) return 0;
  const perpAngle = lengthAngle + Math.PI / 2;
  const dx = tangentPoint.x - originX, dy = tangentPoint.y - originY;
  return dx * Math.cos(perpAngle) + dy * Math.sin(perpAngle);
}

// Which perpendicular side (+1 or -1) is the shaded, far-from-light
// side of this tube -- same logic as the original per-link sweep.
function computeFarEdgeSign(azimuth, lengthAngle) {
  const perpAngle = lengthAngle + Math.PI / 2;
  return Math.cos(azimuth - perpAngle) >= 0 ? -1 : 1;
}

// ---------------------------------------------------------
// COMMON TANGENT TO TWO ELLIPSES (green marker)
// ---------------------------------------------------------
// Where would a single straight line be tangent to BOTH circles'
// (uncut) shade boundaries simultaneously? This is a genuine
// two-unknown system (no simple closed form like the single-ellipse
// case), solved numerically: scan + bisect for sign changes in a
// residual, verify each is a true double-tangent (not a branch-switch
// artifact), then pick whichever matches the tube's own far/shaded
// side most closely.
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

  const steps = 240; // finer scan -- a coarser one can step over a genuinely thin valid window without ever sampling inside it
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
    if (tangentACheck > 0.01) continue; // spurious branch-switch artifact, not a real double-tangent

    // The key filter: BOTH points must be on their own circle's
    // VISIBLE side (same criterion as the original single-ellipse
    // marker). This generically leaves exactly ONE candidate -- no
    // tie-break needed at all, which is what makes it stable.
    if (!isVisible(thetaA, phaseA) || !isVisible(thetaB, phaseB)) continue;

    // On the rare occasion two candidates both pass (right at a
    // transition), fall back to closest-to-reference as a last resort.
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

  const shoulder = { x: cx - 220, y: cy - 80 };
  const elbow    = { x: cx,       y: cy + 120 };
  const wrist    = { x: cx + 220, y: cy - 40  };
  const rS = 70, rE = 45, rW = 25;

  drawLinkFlat(ctx, shoulder, rS, elbow, rE, baseColor);
  drawLinkFlat(ctx, elbow, rE, wrist, rW, baseColor);

  // Yellow reference lines between each linked pair
  const lengthAngle1 = Math.atan2(elbow.y - shoulder.y, elbow.x - shoulder.x);
  const lengthAngle2 = Math.atan2(wrist.y - elbow.y, wrist.x - elbow.x);

  // Tangent points per circle, computed once and reused for both the
  // trim bounds and the red markers.
  const shoulderInfo = getCircleLightInfo(shoulder.x, shoulder.y);
  const elbowInfo = getCircleLightInfo(elbow.x, elbow.y);
  const wristInfo = getCircleLightInfo(wrist.x, wrist.y);

  // Green common-tangent points computed below

  // Compute the green common-tangent points FIRST -- these now drive
  // both the circle clip and the tube shade width, replacing the red
  // marker's single-ellipse tangent point.
  function findGreenPair(cA, rA, infoA, cB, rB, infoB, lengthAngle) {
    const { t1Angle, t2Angle } = computeLinkTangents(cA, rA, cB, rB);
    const perpAngle = lengthAngle + Math.PI / 2;
    const nearIsT1 = Math.cos(infoA.angle - perpAngle) >= 0;
    const farAngle = nearIsT1 ? t2Angle : t1Angle;
    const preferPoint = { x: cA.x + rA * Math.cos(farAngle), y: cA.y + rA * Math.sin(farAngle) };
    return computeCommonTangentPoints(cA, infoA.angle, infoA.phase, rA, cB, infoB.angle, infoB.phase, rB, preferPoint);
  }
  const greenPair1 = findGreenPair(shoulder, rS, shoulderInfo, elbow, rE, elbowInfo, lengthAngle1);
  const greenPair2 = findGreenPair(elbow, rE, elbowInfo, wrist, rW, wristInfo, lengthAngle2);

  // Trim constraints anchored to where each link actually attaches,
  // not to the marker's own arbitrary position.
  // Each circle's shade avoids the half facing toward whichever
  // link(s) it's connected to -- shoulder/wrist have one, elbow has
  // both (so its shade gets clipped away from BOTH directions).
  // Now sliding the cutoff to the GREEN point instead of the red one.
  function buildConstraint(circle, avoidAngle, tangentPoint) {
    const offset = tangentPoint ? computeSlideOffset(circle.x, circle.y, avoidAngle, tangentPoint) : 0;
    return { avoidAngle, offset, originX: circle.x, originY: circle.y };
  }

  const shoulderConstraint = buildConstraint(shoulder, lengthAngle1, greenPair1 ? greenPair1.pointA : null);
  const elbowConstraint1 = buildConstraint(elbow, lengthAngle1 + Math.PI, greenPair1 ? greenPair1.pointB : null);
  const elbowConstraint2 = buildConstraint(elbow, lengthAngle2, greenPair2 ? greenPair2.pointA : null);
  const wristConstraint = buildConstraint(wrist, lengthAngle2 + Math.PI, greenPair2 ? greenPair2.pointB : null);

  // Tube shade: strip runs parallel to the GREEN LINE itself.
  function buildTubeShadeFromGreen(c1, r1, c2, r2, azimuth, greenPair, useA) {
    if (!greenPair) return;
    const { pointA, pointB } = greenPair;
    const lineAngle = Math.atan2(pointB.y - pointA.y, pointB.x - pointA.x);
    const origin = useA ? pointA : pointB;
    const perpAngleGreen = lineAngle + Math.PI / 2;
    const farEdgeSign = computeFarEdgeSign(azimuth, lineAngle);
    drawTubeShade(ctx, c1, r1, c2, r2, origin.x, origin.y, lineAngle, farEdgeSign, shadeColor);
  }

  buildTubeShadeFromGreen(shoulder, rS, elbow, rE, shoulderInfo.angle, greenPair1, true);
  buildTubeShadeFromGreen(shoulder, rS, elbow, rE, elbowInfo.angle, greenPair1, false);
  buildTubeShadeFromGreen(elbow, rE, wrist, rW, elbowInfo.angle, greenPair2, true);
  buildTubeShadeFromGreen(elbow, rE, wrist, rW, wristInfo.angle, greenPair2, false);

  // Circles redraw their own proper crescent fresh on top, correcting
  // the tube shade's overreach within just their own disk.
  drawMoonPhaseCircle(ctx, shoulder.x, shoulder.y, rS, baseColor, shadeColor, [shoulderConstraint]);
  drawMoonPhaseCircle(ctx, elbow.x, elbow.y, rE, baseColor, shadeColor, [elbowConstraint1, elbowConstraint2]);
  drawMoonPhaseCircle(ctx, wrist.x, wrist.y, rW, baseColor, shadeColor, [wristConstraint]);

  // Green marker: common tangent pairs computed above
  if (greenPair1) drawGreenTangentLine(ctx, greenPair1.pointA, greenPair1.pointB);
  if (greenPair2) drawGreenTangentLine(ctx, greenPair2.pointA, greenPair2.pointB);

  // Light position marker
  ctx.fillStyle = 'rgba(255, 220, 120, 0.9)';
  ctx.beginPath();
  ctx.arc(light.x, light.y, 12, 0, Math.PI * 2);
  ctx.fill();
}

let t = 0;
let lastTime = 0;
function loop(timestamp) {
  const dt = (timestamp - lastTime) / 1000;
  lastTime = timestamp;
  t += dt;

  const cx = DESIGN_WIDTH / 2, cy = DESIGN_HEIGHT / 2;
  const orbitAngle = t * 0.3;
  light.x = cx + Math.cos(orbitAngle) * orbitRadius;
  light.y = cy + Math.sin(orbitAngle) * orbitRadius * 0.6;
  light.z = Math.sin(t * 0.6) * 400; // closer/further, oscillating again

  render();
  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);