// ---------------------------------------------------------
// CANVAS SETUP
// ---------------------------------------------------------
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const DESIGN_WIDTH = 1000, DESIGN_HEIGHT = 800;

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

function applyDesignSpaceTransform() {
  const sx = canvas.width / DESIGN_WIDTH;
  const sy = canvas.height / DESIGN_HEIGHT;
  const scale = Math.min(sx, sy); // preserve aspect ratio
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.scale(scale, scale);
  ctx.translate(-DESIGN_WIDTH / 2, -DESIGN_HEIGHT / 2);
}

// ---------------------------------------------------------
// LIGHT & PHASE
// ---------------------------------------------------------
const light = { x: 0, y: 0, z: 0 };

function getCircleLightInfo(circleX, circleY) {
  const dx = light.x - circleX;
  const dy = light.y - circleY;
  const dz = light.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const angle = Math.atan2(dy, dx);
  const phase = dz / dist;
  return { angle, phase, dist };
}

// ---------------------------------------------------------
// DRAWING FUNCTIONS
// ---------------------------------------------------------
const baseColor = '#4fc3f7';
const shadeColor = 'rgb(2, 50, 80)';

function drawEllipseBoundary(ctx, circleX, circleY, r, azimuth, phase) {
  const ex = Math.abs(phase) * r;
  const termCcw = phase >= 0 ? false : true;

  ctx.save();
  ctx.translate(circleX, circleY);
  ctx.rotate(azimuth);

  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(0, 0, ex, r, 0, Math.PI / 2, -Math.PI / 2, termCcw);
  ctx.stroke();

  ctx.restore();
}

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

// Shared per-circle computation: given a circle's outer-rim sweep,
// find the two red circle centers (anchored at the black qualifying
// points, tangential direction leaning toward the dark pole).
function computeRedCenters(c, r, azimuth, phase, sweepStart, sweepEnd) {
  const angles = computeQualifyingAngles(azimuth, sweepStart, sweepEnd);
  const capRadius = r * (1 - phase);
  const darkPole = { x: c.x - r * Math.cos(azimuth), y: c.y - r * Math.sin(azimuth) };

  const centers = angles.map(a => {
    const anchor = { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
    const rx = (anchor.x - c.x) / r, ry = (anchor.y - c.y) / r;
    const perp1 = { x: -ry, y: rx };
    const perp2 = { x: ry, y: -rx };
    const toDarkX = darkPole.x - anchor.x, toDarkY = darkPole.y - anchor.y;
    const dot1 = perp1.x * toDarkX + perp1.y * toDarkY;
    const dot2 = perp2.x * toDarkX + perp2.y * toDarkY;
    const chosen = dot1 > dot2 ? perp1 : perp2;
    return { x: anchor.x + chosen.x * capRadius, y: anchor.y + chosen.y * capRadius };
  });

  return { capRadius, centers };
}

function drawShadeEllipse(ctx, c1, azimuth1, r1, phase1, c2, azimuth2, r2, phase2, shadeColor) {
  const { t1Angle, t2Angle } = computeLinkTangents(c1, r1, c2, r2);

  [
    { c: c1, r: r1, azimuth: azimuth1, phase: phase1, sweepStart: t1Angle, sweepEnd: t2Angle },
    { c: c2, r: r2, azimuth: azimuth2, phase: phase2, sweepStart: t2Angle, sweepEnd: t1Angle },
  ].forEach(({ c, r, azimuth, phase, sweepStart, sweepEnd }) => {
    const angles = computeQualifyingAngles(azimuth, sweepStart, sweepEnd);
    const capRadius = r * (1 - phase);
    const darkPole = { x: c.x - r * Math.cos(azimuth), y: c.y - r * Math.sin(azimuth) };

    const anchors = angles.map(a => ({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) }));
    const radials = anchors.map(anchor => ({ x: (anchor.x - c.x) / r, y: (anchor.y - c.y) / r }));
    const reds = anchors.map((anchor, i) => {
      const rx = radials[i].x, ry = radials[i].y;
      const perp1 = { x: -ry, y: rx }, perp2 = { x: ry, y: -rx };
      const toDarkX = darkPole.x - anchor.x, toDarkY = darkPole.y - anchor.y;
      const dot1 = perp1.x * toDarkX + perp1.y * toDarkY, dot2 = perp2.x * toDarkX + perp2.y * toDarkY;
      const chosen = dot1 > dot2 ? perp1 : perp2;
      return { x: anchor.x + chosen.x * capRadius, y: anchor.y + chosen.y * capRadius };
    });
    const [red1, red2] = reds;
    const [radial1, radial2] = radials;

    // The circular arc through red1 and red2, tangent at each to that
    // same terminator/seam point's own tangent direction: its center
    // is where the two radial lines (through each red center, in that
    // point's own radial direction) intersect.
    const denom = radial1.x * radial2.y - radial1.y * radial2.x;
    ctx.save();
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.strokeStyle = shadeColor;
    ctx.lineWidth = capRadius * 2;
    ctx.lineCap = 'round';
    ctx.beginPath();

    if (Math.abs(denom) < 1e-9) {
      // Degenerate (parallel radials) -- fall back to a straight line
      ctx.moveTo(red1.x, red1.y);
      ctx.lineTo(red2.x, red2.y);
    } else {
      const t = ((red2.x - red1.x) * radial2.y - (red2.y - red1.y) * radial2.x) / denom;
      const arcCenter = { x: red1.x + t * radial1.x, y: red1.y + t * radial1.y };
      const arcR = Math.hypot(arcCenter.x - red1.x, arcCenter.y - red1.y);
      const startAngle = Math.atan2(red1.y - arcCenter.y, red1.x - arcCenter.x);
      const endAngle = Math.atan2(red2.y - arcCenter.y, red2.x - arcCenter.x);

      // Test both real canvas sweeps (properly accounting for angle
      // wraparound) and pick whichever bulges outward, away from c.
      function sweepMidDist(ccwTest) {
        let s = startAngle, e = endAngle;
        if (!ccwTest) { while (e < s) e += Math.PI * 2; } else { while (e > s) e -= Math.PI * 2; }
        const mid = (s + e) / 2;
        const pt = { x: arcCenter.x + arcR * Math.cos(mid), y: arcCenter.y + arcR * Math.sin(mid) };
        return Math.hypot(pt.x - c.x, pt.y - c.y);
      }
      const ccw = sweepMidDist(true) > sweepMidDist(false);
      ctx.arc(arcCenter.x, arcCenter.y, arcR, startAngle, endAngle, ccw);
    }

    ctx.stroke();
    ctx.restore();
  });
}

function drawShadeThicknessLine(ctx, circleX, circleY, r, azimuth, phase) {
  const localXMid = -phase * r;
  const localXEdge = -r;

  const midPoint = { x: circleX + localXMid * Math.cos(azimuth), y: circleY + localXMid * Math.sin(azimuth) };
  const edgePoint = { x: circleX + localXEdge * Math.cos(azimuth), y: circleY + localXEdge * Math.sin(azimuth) };

  ctx.strokeStyle = '#33ff33';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(midPoint.x, midPoint.y);
  ctx.lineTo(edgePoint.x, edgePoint.y);
  ctx.stroke();
}

function drawGreenLineMidpoint(ctx, circleX, circleY, r, azimuth, phase, sweepStart, sweepEnd) {
  const localXMid = -phase * r;   // equator point
  const localXEdge = -r;          // dark pole

  const equatorPoint = { x: circleX + localXMid * Math.cos(azimuth), y: circleY + localXMid * Math.sin(azimuth) };
  const darkPole = { x: circleX + localXEdge * Math.cos(azimuth), y: circleY + localXEdge * Math.sin(azimuth) };

  const midpoint = { x: (equatorPoint.x + darkPole.x) / 2, y: (equatorPoint.y + darkPole.y) / 2 };
  const radius = Math.hypot(equatorPoint.x - darkPole.x, equatorPoint.y - darkPole.y) / 2;

  const subCircleRadius = Math.hypot(midpoint.x - circleX, midpoint.y - circleY);

  // Determine which arc of the sub-circle lies in the crescent
  // (beyond the terminator ellipse, toward the dark rim) -- that
  // portion draws red, the rest draws green.
  const ex = Math.abs(phase) * r;
  const subR = subCircleRadius;
  let crescentStart = null, crescentEnd = null, entireRed = false;

  if (subR > 1e-9) {
    if (ex < 1e-9) {
      crescentStart = azimuth + Math.PI / 2;
      crescentEnd = azimuth + Math.PI * 1.5;
    } else {
      const denom = 1 - (ex * ex) / (r * r);
      const y2 = (subR * subR - ex * ex) / denom;
      if (y2 < 0 || y2 > subR * subR + 1e-9) {
        entireRed = true; // no valid intersection -- dark pole is always in the crescent, so the whole sub-circle is
      } else {
        const y = Math.sqrt(Math.min(y2, subR * subR));
        const xMag = ex * Math.sqrt(Math.max(0, 1 - y2 / (r * r)));
        const xLocal = phase >= 0 ? -xMag : xMag;
        // These are LOCAL angles (in the azimuth-rotated frame where
        // the dark pole sits at local angle PI) -- convert to world
        // angles by adding azimuth before use.
        const angleALocal = Math.atan2(y, xLocal);
        const angleBLocal = Math.atan2(-y, xLocal);
        function contains(s, e, target) {
          let ee = e; while (ee < s) ee += Math.PI * 2;
          const shift = Math.round((s - target) / (Math.PI * 2)) * Math.PI * 2;
          const t = target + shift;
          return t >= s && t <= ee;
        }
        // Membership test done in LOCAL terms (dark pole = local PI)
        if (contains(angleALocal, angleBLocal, Math.PI)) { crescentStart = angleALocal + azimuth; crescentEnd = angleBLocal + azimuth; }
        else { crescentStart = angleBLocal + azimuth; crescentEnd = angleALocal + azimuth; }
      }
    }
  }

  // Additionally cut off by the seam-point chord: the red portion
  // should only exist on the outer-rim side (opposite the tube).
  // Intersect the crescent arc (dark-pole side) with the outer-rim
  // sweep, both as circular intervals.
  function intersectArcs(startA, endA, startB, endB) {
    let eA = endA; while (eA < startA) eA += Math.PI * 2;
    let eB = endB; while (eB < startB) eB += Math.PI * 2;
    for (const offset of [0, Math.PI * 2, -Math.PI * 2]) {
      const s = Math.max(startA, startB + offset);
      const e = Math.min(eA, eB + offset);
      if (s <= e) return [s, e];
    }
    return null;
  }

  let redStart = null, redEnd = null;
  if (subR > 1e-9) {
    if (entireRed) {
      // Crescent = whole circle; red is just the outer-rim sweep itself.
      redStart = sweepStart;
      redEnd = sweepEnd;
    } else {
      const result = intersectArcs(crescentStart, crescentEnd, sweepStart, sweepEnd);
      if (result) { redStart = result[0]; redEnd = result[1]; }
    }
  }

  if (subR > 1e-9) {
    if (redStart !== null) {
      let re = redEnd; while (re < redStart) re += Math.PI * 2;
      ctx.strokeStyle = '#ff3333';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(circleX, circleY, subR, redStart, re, false);
      ctx.stroke();

      ctx.strokeStyle = '#33ff33';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(circleX, circleY, subR, re, redStart + Math.PI * 2, false);
      ctx.stroke();
    } else {
      // No red segment at all -- entire sub-circle is green.
      ctx.strokeStyle = '#33ff33';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(circleX, circleY, subR, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  ctx.strokeStyle = '#ffee33';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(midpoint.x, midpoint.y, radius, 0, Math.PI * 2);
  ctx.stroke();
}

function computeCapIntersection(r, capRadius, poleLocalX, poleLocalY, preferPosX) {
  const d = (r * r - capRadius * capRadius) / 2;
  const polTheta = Math.atan2(poleLocalY, poleLocalX);
  const cosVal = d / (r * r);
  if (Math.abs(cosVal) > 1) return null;
  const delta = Math.acos(cosVal);
  const t1 = polTheta + delta, t2 = polTheta - delta;
  const p1 = { x: r * Math.cos(t1), y: r * Math.sin(t1) };
  const p2 = { x: r * Math.cos(t2), y: r * Math.sin(t2) };
  return preferPosX ? (p1.x > p2.x ? p1 : p2) : (p1.x < p2.x ? p1 : p2);
}

function drawCapMeetingPoints(ctx, circleX, circleY, r, azimuth, phase) {
  const thickness = r * (1 - phase);
  const capRadius = thickness;

  const toWorld = (lx, ly) => ({
    x: circleX + lx * Math.cos(azimuth) - ly * Math.sin(azimuth),
    y: circleY + lx * Math.sin(azimuth) + ly * Math.cos(azimuth),
  });

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

function drawPoleCaps(ctx, c1, azimuth1, r1, phase1, c2, azimuth2, r2, phase2) {
  const { t1Angle, t2Angle } = computeLinkTangents(c1, r1, c2, r2);

  [
    { c: c1, r: r1, azimuth: azimuth1, phase: phase1, sweepStart: t1Angle, sweepEnd: t2Angle },
    { c: c2, r: r2, azimuth: azimuth2, phase: phase2, sweepStart: t2Angle, sweepEnd: t1Angle },
  ].forEach(({ c, r, azimuth, phase, sweepStart, sweepEnd }) => {
    const { capRadius, centers } = computeRedCenters(c, r, azimuth, phase, sweepStart, sweepEnd);
    centers.forEach(redCenter => {
      ctx.strokeStyle = '#ff3333';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(redCenter.x, redCenter.y, capRadius, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = '#ff3333';
      ctx.beginPath();
      ctx.arc(redCenter.x, redCenter.y, 5, 0, Math.PI * 2);
      ctx.fill();
    });
  });
}

// ---------------------------------------------------------
// SHAPES: two-circle tangent link (flat, no shading of its own)
// ---------------------------------------------------------
function computeLinkTangents(c1, r1, c2, r2) {
  const dx = c2.x - c1.x, dy = c2.y - c1.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  const centerAngle = Math.atan2(dy, dx);
  const alpha = Math.asin((r1 - r2) / d);
  const t1Angle = centerAngle + Math.PI / 2 - alpha;
  const t2Angle = centerAngle - Math.PI / 2 + alpha;
  return { t1Angle, t2Angle };
}

function traceLinkPath(ctx, c1, r1, c2, r2) {
  const { t1Angle, t2Angle } = computeLinkTangents(c1, r1, c2, r2);
  const p1a = { x: c1.x + r1 * Math.cos(t1Angle), y: c1.y + r1 * Math.sin(t1Angle) };
  const p1b = { x: c2.x + r2 * Math.cos(t1Angle), y: c2.y + r2 * Math.sin(t1Angle) };
  const p2a = { x: c2.x + r2 * Math.cos(t2Angle), y: c2.y + r2 * Math.sin(t2Angle) };
  const p2b = { x: c1.x + r1 * Math.cos(t2Angle), y: c1.y + r1 * Math.sin(t2Angle) };

  ctx.beginPath();
  ctx.moveTo(p1a.x, p1a.y);
  ctx.lineTo(p1b.x, p1b.y);
  ctx.arc(c2.x, c2.y, r2, t1Angle, t2Angle, false);
  ctx.lineTo(p2b.x, p2b.y);
  ctx.arc(c1.x, c1.y, r1, t2Angle, t1Angle, false);
  ctx.closePath();
}

function drawLinkFlat(ctx, c1, r1, c2, r2, baseColor) {
  traceLinkPath(ctx, c1, r1, c2, r2);
  ctx.fillStyle = baseColor;
  ctx.fill();
}

function drawTubeTangentPoints(ctx, c1, r1, c2, r2) {
  const { t1Angle, t2Angle } = computeLinkTangents(c1, r1, c2, r2);
  const points = [
    { x: c1.x + r1 * Math.cos(t1Angle), y: c1.y + r1 * Math.sin(t1Angle) },
    { x: c1.x + r1 * Math.cos(t2Angle), y: c1.y + r1 * Math.sin(t2Angle) },
    { x: c2.x + r2 * Math.cos(t1Angle), y: c2.y + r2 * Math.sin(t1Angle) },
    { x: c2.x + r2 * Math.cos(t2Angle), y: c2.y + r2 * Math.sin(t2Angle) },
  ];
  ctx.fillStyle = '#ffee33';
  points.forEach(p => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fill();
  });
}

function angDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// Pure computation: given a circle's outer-rim sweep [sweepStart,
// sweepEnd] and its azimuth, returns the two angles where the outer
// rim intersects the dark rim -- via direct interval intersection,
// no per-point branching, no wraparound ambiguity.
function computeQualifyingAngles(azimuth, sweepStart, sweepEnd) {
  let outerStart = sweepStart;
  let outerEnd = sweepEnd;
  while (outerEnd < outerStart) outerEnd += Math.PI * 2;

  // Dark-rim interval: cos(theta-azimuth)<=0 holds for
  // theta in [azimuth+PI/2, azimuth+3*PI/2].
  let darkStart = azimuth + Math.PI / 2;
  let darkEnd = azimuth + Math.PI * 1.5;
  const shift = Math.round((outerStart - darkStart) / (Math.PI * 2)) * Math.PI * 2;
  darkStart += shift;
  darkEnd += shift;

  for (const offset of [0, Math.PI * 2, -Math.PI * 2]) {
    const ds = darkStart + offset, de = darkEnd + offset;
    const start = Math.max(outerStart, ds);
    const end = Math.min(outerEnd, de);
    if (start <= end) return [start, end];
  }
  // Fallback: right at the boundary where a terminator point and a
  // seam point coincide, floating-point noise can make the interval
  // intersection above flicker between a tiny valid window and none
  // at all. Falling back to the seam points themselves is not just a
  // band-aid -- at exactly that boundary they ARE the same point, so
  // this is the mathematically correct answer, and it's always defined.
  return [outerStart, outerEnd];
}

// Black dots, derived directly via interval intersection instead of
// testing discrete candidate points each frame (which flickers near
// angle wraparound boundaries).
//
// c1's exposed/outer arc sweeps t1Angle -> t2Angle (through the far
// side, away from c2); c2's sweeps the other way, t2Angle -> t1Angle
// (matching traceLinkPath's actual geometry).
function drawQualifyingPoints(ctx, c1, azimuth1, r1, c2, azimuth2, r2) {
  const { t1Angle, t2Angle } = computeLinkTangents(c1, r1, c2, r2);

  [
    { c: c1, r: r1, azimuth: azimuth1, sweepStart: t1Angle, sweepEnd: t2Angle },
    { c: c2, r: r2, azimuth: azimuth2, sweepStart: t2Angle, sweepEnd: t1Angle },
  ].forEach(({ c, r, azimuth, sweepStart, sweepEnd }) => {
    const angles = computeQualifyingAngles(azimuth, sweepStart, sweepEnd);
    if (!angles) return;
    ctx.fillStyle = '#000000';
    angles.forEach(a => {
      const x = c.x + r * Math.cos(a), y = c.y + r * Math.sin(a);
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
    });
  });
}

function drawTerminatorToDarkPoleLines(ctx, circleX, circleY, r, azimuth, phase) {
  const length = r * (1 - phase) / 2; // half the green thickness line's length
  const ex = Math.abs(phase) * r;
  const subR = r * (phase + 1) / 2;

  // Ellipse-subcircle intersection (same math as drawEllipseSubCircleIntersections)
  let xLocal = 0, yLocal = 0, hasIntersection = false;
  if (ex < 1e-9) {
    if (subR <= r) { xLocal = 0; yLocal = subR; hasIntersection = true; }
  } else {
    const denom = 1 - (ex * ex) / (r * r);
    const y2 = (subR * subR - ex * ex) / denom;
    if (y2 >= 0) {
      const y = Math.sqrt(y2);
      const x2 = ex * ex * (1 - y2 / (r * r));
      if (x2 >= -1e-9) {
        const x = Math.sqrt(Math.max(0, x2));
        xLocal = phase >= 0 ? -x : x;
        yLocal = y;
        hasIntersection = true;
      }
    }
  }
  if (!hasIntersection) return;

  const intersectionsLocal = [{ x: xLocal, y: yLocal }, { x: xLocal, y: -yLocal }];

  ctx.strokeStyle = '#ffee33';
  ctx.lineWidth = 3;
  intersectionsLocal.forEach(il => {
    const endPoint = { x: circleX + il.x * Math.cos(azimuth) - il.y * Math.sin(azimuth), y: circleY + il.x * Math.sin(azimuth) + il.y * Math.cos(azimuth) };
    ctx.beginPath();
    ctx.arc(endPoint.x, endPoint.y, length, 0, Math.PI * 2);
    ctx.stroke();
  });
}

// Black dot on the green line (at its midpoint), drawn only when the
// dark pole currently sits in the OUTER rim (not facing the tube).
function drawDarkPoleOuterRimMarker(ctx, c, r, azimuth, phase, sweepStart, sweepEnd) {
  let outerStart = sweepStart, outerEnd = sweepEnd;
  while (outerEnd < outerStart) outerEnd += Math.PI * 2;

  const darkPoleAngle = azimuth + Math.PI;
  const shift = Math.round((outerStart - darkPoleAngle) / (Math.PI * 2)) * Math.PI * 2;
  const shiftedDarkPole = darkPoleAngle + shift;
  const isOuter = shiftedDarkPole >= outerStart && shiftedDarkPole <= outerEnd;
  if (!isOuter) return;

  const localXMid = -phase * r, localXEdge = -r;
  const equatorPoint = { x: c.x + localXMid * Math.cos(azimuth), y: c.y + localXMid * Math.sin(azimuth) };
  const darkPole = { x: c.x + localXEdge * Math.cos(azimuth), y: c.y + localXEdge * Math.sin(azimuth) };
  const midpoint = { x: (equatorPoint.x + darkPole.x) / 2, y: (equatorPoint.y + darkPole.y) / 2 };

  ctx.fillStyle = '#000000';
  ctx.beginPath();
  ctx.arc(midpoint.x, midpoint.y, 5, 0, Math.PI * 2);
  ctx.fill();
}

// Checks whether a world-space point lies ON the terminator ellipse,
// or in the crescent between the ellipse and the dark rim (i.e., on
// the correct dark side, and outside/on the ellipse boundary).
function isOnOrBeyondEllipse(c, r, azimuth, phase, point) {
  const dx = point.x - c.x, dy = point.y - c.y;
  const xLocal = dx * Math.cos(azimuth) + dy * Math.sin(azimuth);
  const yLocal = -dx * Math.sin(azimuth) + dy * Math.cos(azimuth);

  const correctSide = phase >= 0 ? xLocal <= 1e-9 : xLocal >= -1e-9;
  if (!correctSide) return false;

  const ex = Math.abs(phase) * r;
  if (ex < 1e-9) return true; // ellipse degenerates to the x=0 line; correct side already confirmed

  const val = (xLocal * xLocal) / (ex * ex) + (yLocal * yLocal) / (r * r);
  return val >= 1 - 1e-9;
}

function drawEllipseSubCircleIntersections(ctx, circleX, circleY, r, azimuth, phase, sweepStart, sweepEnd) {
  const ex = Math.abs(phase) * r;
  const subR = r * (phase + 1) / 2;

  let points = [];
  if (ex < 1e-9) {
    if (subR <= r) points = [{ x: 0, y: subR }, { x: 0, y: -subR }];
  } else {
    const denom = 1 - (ex * ex) / (r * r);
    const y2 = (subR * subR - ex * ex) / denom;
    if (y2 >= 0) {
      const y = Math.sqrt(y2);
      const x2 = ex * ex * (1 - y2 / (r * r));
      if (x2 >= -1e-9) {
        const x = Math.sqrt(Math.max(0, x2));
        const xLocal = phase >= 0 ? -x : x;
        points = [{ x: xLocal, y }, { x: xLocal, y: -y }];
      }
    }
  }
  if (points.length === 0 || subR < 1e-9) return;

  let outerStart = sweepStart, outerEnd = sweepEnd;
  while (outerEnd < outerStart) outerEnd += Math.PI * 2;

  ctx.fillStyle = '#ffee33';
  points.forEach(p => {
    // World position of the intersection point I
    const worldI = { x: circleX + p.x * Math.cos(azimuth) - p.y * Math.sin(azimuth), y: circleY + p.x * Math.sin(azimuth) + p.y * Math.cos(azimuth) };
    // Where the corresponding yellow circle (centered at I) touches the main circle
    const tangentAngle = Math.atan2(worldI.y - circleY, worldI.x - circleX);
    const shift = Math.round((outerStart - tangentAngle) / (Math.PI * 2)) * Math.PI * 2;
    const shiftedAngle = tangentAngle + shift;
    const touchesOuter = shiftedAngle >= outerStart && shiftedAngle <= outerEnd;
    if (!touchesOuter) return;

    ctx.beginPath();
    ctx.arc(worldI.x, worldI.y, 5, 0, Math.PI * 2);
    ctx.fill();
  });
}

// Point A: sits on the sub-circle, at the same angle as a seam point
// on the main circle.
function drawPointA(ctx, c, r, azimuth, phase, sweepStart, sweepEnd) {
  const subR = r * (phase + 1) / 2;
  ctx.fillStyle = '#ff3333';
  [sweepStart, sweepEnd].forEach(angle => {
    const p = { x: c.x + subR * Math.cos(angle), y: c.y + subR * Math.sin(angle) };
    if (!isOnOrBeyondEllipse(c, r, azimuth, phase, p)) return;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fill();
  });
}

// ---------------------------------------------------------
// RENDER LOOP
// ---------------------------------------------------------
function render() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  applyDesignSpaceTransform();

  const cx = DESIGN_WIDTH / 2, cy = DESIGN_HEIGHT / 2;

  const top = { x: cx, y: cy - 150 };
  const bottom = { x: cx, y: cy + 150 };
  const rTop = 90, rBottom = 60;

  drawLinkFlat(ctx, top, rTop, bottom, rBottom, baseColor);

  const { t1Angle, t2Angle } = computeLinkTangents(top, rTop, bottom, rBottom);

  [
    { c: top, r: rTop, sweepStart: t1Angle, sweepEnd: t2Angle },
    { c: bottom, r: rBottom, sweepStart: t2Angle, sweepEnd: t1Angle },
  ].forEach(({ c, r, sweepStart, sweepEnd }) => {
    ctx.fillStyle = baseColor;
    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.fill();

    const info = getCircleLightInfo(c.x, c.y);
    drawEllipseBoundary(ctx, c.x, c.y, r, info.angle, info.phase);
    drawShadeThicknessLine(ctx, c.x, c.y, r, info.angle, info.phase);
    drawTerminatorToDarkPoleLines(ctx, c.x, c.y, r, info.angle, info.phase);
    drawGreenLineMidpoint(ctx, c.x, c.y, r, info.angle, info.phase, sweepStart, sweepEnd);
  });

  const topInfo = getCircleLightInfo(top.x, top.y);
  const bottomInfo = getCircleLightInfo(bottom.x, bottom.y);
  // drawShadeEllipse(ctx, top, topInfo.angle, rTop, topInfo.phase, bottom, bottomInfo.angle, rBottom, bottomInfo.phase, shadeColor);
  // drawQualifyingPoints(ctx, top, topInfo.angle, rTop, bottom, bottomInfo.angle, rBottom);
  // drawPoleCaps(ctx, top, topInfo.angle, rTop, topInfo.phase, bottom, bottomInfo.angle, rBottom, bottomInfo.phase);

  // Light position marker
  const zMin = -400, zMax = 400, radiusMin = 4, radiusMax = 28;
  const zClamped = Math.max(zMin, Math.min(zMax, light.z));
  const markerRadius = radiusMin + (radiusMax - radiusMin) * ((zClamped - zMin) / (zMax - zMin));
  ctx.fillStyle = 'rgba(255, 220, 120, 0.9)';
  ctx.beginPath();
  ctx.arc(light.x, light.y, markerRadius, 0, Math.PI * 2);
  ctx.fill();
}

// Light orbits azimuthally around the shape in the X/Y plane, while Z
// also oscillates independently -- full 3D movement. Marker size still
// tracks Z (smallest far away, biggest up close).
const cx0 = DESIGN_WIDTH / 2, cy0 = DESIGN_HEIGHT / 2;
const orbitRadius = 400;
const zAmplitude = 400;

let t = 0;
let lastTime = 0;
let paused = false;

const pauseBtn = document.getElementById('pauseBtn');
pauseBtn.addEventListener('click', () => {
  paused = !paused;
  pauseBtn.textContent = paused ? 'Resume' : 'Pause';
  if (!paused) lastTime = performance.now(); // avoid a big dt jump on resume
});

function loop(timestamp) {
  if (!paused) {
    const dt = (timestamp - lastTime) / 1000;
    lastTime = timestamp;
    t += dt;

    const orbitAngle = t * 0.4;
    light.x = cx0 + Math.cos(orbitAngle) * orbitRadius;
    light.y = cy0 + Math.sin(orbitAngle) * orbitRadius;
    light.z = Math.sin(t * 0.7) * zAmplitude;

    render();
  } else {
    lastTime = timestamp;
  }
  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);