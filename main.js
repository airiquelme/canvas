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
// LIGHT SOURCE
// ---------------------------------------------------------
// x, y fixed here on purpose -- only z oscillates, so shade and gloss
// each get their own moment on screen instead of blending as it orbits.
const light = { x: 0, y: 0, z: 0 };

// ---------------------------------------------------------
// PER-LINK SWEEPING SHADE (exact tangent-point construction)
// ---------------------------------------------------------
// A world-space gradient can't exactly track a TAPERING capsule's true
// edges (different radii mean the edges aren't parallel to the length
// axis), which is what left a sliver no matter how far the shade grew.
// Fix: build the shaded region directly from the same tangent points
// that define the link's own shape. The "moving" boundary interpolates
// each circle's angle from its far tangent point toward its near one,
// so at shadeAmount=0 it degenerates exactly onto the far edge (zero
// area) and at shadeAmount=1 it lands exactly on the near edge
// (the full link) -- no gap is possible at either extreme.
function unwrap(start, endStated, ccw) {
  let e = endStated;
  if (!ccw) { while (e < start) e += Math.PI * 2; }
  else { while (e > start) e -= Math.PI * 2; }
  return e;
}

// For a given circle's FIXED natural far-cap sweep (always ccw=true,
// always the same start/end regardless of lighting), compute the
// sub-arc that should currently be shaded. If this circle's "far"
// reference is its natural start, the shaded sub-arc grows outward
// from that start. If "far" is instead its natural END, the shaded
// sub-arc grows backward from that end -- either way, ccw stays true
// (the circle's own fixed direction), only which end is "moving" flips.
function computeArcRange(naturalStart, naturalEnd, farMatchesNaturalStart, shadeAmount) {
  if (farMatchesNaturalStart) {
    return { arcStart: naturalStart, arcEnd: naturalStart + (naturalEnd - naturalStart) * shadeAmount, movingIsEnd: true };
  } else {
    return { arcStart: naturalStart + (naturalEnd - naturalStart) * (1 - shadeAmount), arcEnd: naturalEnd, movingIsEnd: false };
  }
}

function drawLinkSweepShade(ctx, c1, r1, c2, r2, shadeColor) {
  const { t1Angle, t2Angle } = computeLinkTangents(c1, r1, c2, r2);

  const midX = (c1.x + c2.x) / 2, midY = (c1.y + c2.y) / 2;
  const dx = light.x - midX, dy = light.y - midY, dz = light.z;
  const dist = Math.hypot(dx, dy, dz) || 1;
  const azimuth = Math.atan2(dy, dx);
  const phase = Math.max(-1, Math.min(1, dz / dist));

  const lengthAngle = Math.atan2(c2.y - c1.y, c2.x - c1.x);
  const perpAngle = lengthAngle + Math.PI / 2;
  const nearIsT1 = Math.cos(azimuth - perpAngle) >= 0;

  const perpComponent = dx * Math.cos(perpAngle) + dy * Math.sin(perpAngle);
  const alignment = Math.sqrt(perpComponent * perpComponent + dz * dz) / dist;

  const rawShadeAmount = Math.max(0, Math.min(1, (1 - phase) / 2));
  const shadeAmount = rawShadeAmount * alignment;

  const farAngle = nearIsT1 ? t2Angle : t1Angle;

  // Each circle's own fixed natural far-cap sweep -- always the SAME
  // start/end/direction regardless of lighting, matching exactly the
  // verified-correct full-link construction. Only which end plays
  // "far" (matching the current light) changes.
  const c2NaturalStart = t1Angle, c2NaturalEnd = unwrap(t1Angle, t2Angle, true);
  const c1NaturalStart = t2Angle, c1NaturalEnd = unwrap(t2Angle, t1Angle, true);
  const c2FarMatchesStart = (farAngle === t1Angle);
  const c1FarMatchesStart = (farAngle === t2Angle);

  const overreach = 2;
  const r1o = r1 + overreach, r2o = r2 + overreach;

  const c2Range = computeArcRange(c2NaturalStart, c2NaturalEnd, c2FarMatchesStart, shadeAmount);
  const c1Range = computeArcRange(c1NaturalStart, c1NaturalEnd, c1FarMatchesStart, shadeAmount);

  const point = (c, r, a) => ({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
  const farPoint1 = point(c1, r1o, farAngle);
  const farPoint2 = point(c2, r2o, farAngle);
  const movingPoint1 = c1Range.movingIsEnd ? point(c1, r1o, c1Range.arcEnd) : point(c1, r1o, c1Range.arcStart);

  ctx.beginPath();
  ctx.moveTo(farPoint1.x, farPoint1.y);
  ctx.lineTo(farPoint2.x, farPoint2.y);
  if (c2FarMatchesStart) {
    ctx.arc(c2.x, c2.y, r2o, c2Range.arcStart, c2Range.arcEnd, true);
  } else {
    ctx.arc(c2.x, c2.y, r2o, c2Range.arcEnd, c2Range.arcStart, false);
  }
  ctx.lineTo(movingPoint1.x, movingPoint1.y);
  if (c1FarMatchesStart) {
    ctx.arc(c1.x, c1.y, r1o, c1Range.arcStart, c1Range.arcEnd, true);
  } else {
    ctx.arc(c1.x, c1.y, r1o, c1Range.arcEnd, c1Range.arcStart, false);
  }
  ctx.closePath();
  ctx.fillStyle = shadeColor;
  ctx.fill();
}

function drawLinkShaded(ctx, c1, r1, c2, r2, baseColor, shadeColor) {
  traceLinkPath(ctx, c1, r1, c2, r2);
  ctx.fillStyle = baseColor;
  ctx.fill();

  ctx.save();
  traceLinkPath(ctx, c1, r1, c2, r2);
  ctx.clip();
  drawLinkSweepShade(ctx, c1, r1, c2, r2, shadeColor);
  ctx.restore();
}

// ---------------------------------------------------------
// SHAPES: circle, and two-circle tangent link
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

// ---------------------------------------------------------
// DEMO SCENE
// ---------------------------------------------------------
let t = 0;
const baseColor = '#4fc3f7';
const shadeColor = 'rgb(2, 50, 80)'; // opaque -- elbow now gets shade from both links, and opaque overlap can't stack

function render() {
  const cx = DESIGN_WIDTH / 2;
  const cy = DESIGN_HEIGHT / 2;

  // Light now orbits slowly (varying azimuth) while also cycling in z
  // faster -- this lets you watch each link pass through both its own
  // "mostly perpendicular" (full shade range) and "mostly parallel"
  // (shade suppressed) alignment, since the two links point different
  // directions and hit those moments at different orbit angles.
  const orbitRadius = 380;
  light.x = cx + Math.cos(t * 0.2) * orbitRadius;
  light.y = cy + Math.sin(t * 0.2) * orbitRadius * 0.6;
  light.z = Math.sin(t * 0.9) * 400;

  const shoulder = { x: cx - 220, y: cy - 80 };
  const elbow    = { x: cx,       y: cy + 120 };
  const wrist    = { x: cx + 220, y: cy - 40  };
  const rS = 70, rE = 45, rW = 25;

  // Each link now gets its own independent sweep, aligned to its own
  // orientation. Circles are NOT redrawn flat afterward -- a link's
  // own shape already fully covers both its endpoint circles (base
  // color included), and its shade sweep already extends into them
  // too. Redrawing flat circles on top was erasing that and causing
  // the "sudden stop" you saw.
  drawLinkShaded(ctx, shoulder, rS, elbow, rE, baseColor, shadeColor);
  drawLinkShaded(ctx, elbow, rE, wrist, rW, baseColor, shadeColor);

  // Light position marker -- sized by distance from the scene, so you
  // can actually see depth: closer (small |z|, near the viewer) reads
  // as bigger, farther (light swung behind, or just far off to the
  // side) reads as smaller. Pure visual aid, doesn't affect shading.
  const sceneDist = Math.hypot(light.x - cx, light.y - cy, light.z) || 1;
  const referenceDist = 500; // distance at which the marker is "normal" size
  const markerRadius = Math.max(4, Math.min(28, 12 * (referenceDist / sceneDist)));
  ctx.fillStyle = 'rgba(255, 220, 120, 0.9)';
  ctx.beginPath();
  ctx.arc(light.x, light.y, markerRadius, 0, Math.PI * 2);
  ctx.fill();

  // On-screen readout of the light's depth, which drives the sweep
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = '20px sans-serif';
  ctx.fillText(`light: x=${light.x.toFixed(0)} y=${light.y.toFixed(0)} z=${light.z.toFixed(0)}`, 40, 40);
}

// ---------------------------------------------------------
// MAIN LOOP
// ---------------------------------------------------------
let lastTime = 0;
function loop(timestamp) {
  const dt = (timestamp - lastTime) / 1000;
  lastTime = timestamp;
  t += dt;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  applyDesignSpaceTransform();

  render();

  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);