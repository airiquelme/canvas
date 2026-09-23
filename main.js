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
// LIGHT
// ---------------------------------------------------------
// Kept from before: only used later to decide shade-stroke vs
// light-stroke on boundaries. Not used for any shading math yet.
const light = { x: 0, y: 0, z: 0 };

// ---------------------------------------------------------
// NODE / MESH STRUCTURE
// ---------------------------------------------------------
// A Node is a circle for now (rx=ry=radius; rotation is a reserved
// concept for later, not yet meaningful). Nodes stand alone -- no
// father/child relationship.
//
// Node = { id, center: {x,y}, radius }
//
// A Mesh holds an ORDERED LIST of node ids. Rendering a Mesh draws
// the outline formed by treating each node as a "corner": tangent
// lines connect consecutive nodes, with a rounding arc at each
// intermediate node where the tangent direction changes. A 2-node
// Mesh is exactly our old single tube; a Mesh with more nodes
// generalizes that into a rounded polyline / capsule chain.
//
// Mesh = { id, nodeIds: [id, id, ...], color }

const nodes = {};
let nextNodeId = 1;
function createNode(center, radius) {
  const id = nextNodeId++;
  // center is now a full 3D position {x, y, z}; z defaults to 0 if omitted.
  nodes[id] = { id, center: { x: center.x, y: center.y, z: center.z ?? 0 }, radius };
  return id;
}

const meshes = {};
let nextMeshId = 1;
function createMesh(nodeIds, color) {
  const id = nextMeshId++;
  meshes[id] = { id, nodeIds, color };
  return id;
}

// ---------------------------------------------------------
// MESH GEOMETRY: convex hull of node centers (straight lines only,
// for now -- radii are ignored at this stage).
// ---------------------------------------------------------

// Standard gift-wrapping (Jarvis march) for points. Order-independent,
// correctly excludes interior points.
function convexHullIndices(points) {
  const n = points.length;
  if (n < 3) return points.map((_, i) => i);

  let startIdx = 0;
  for (let i = 1; i < n; i++) if (points[i].x < points[startIdx].x) startIdx = i;

  const hull = [];
  let currentIdx = startIdx;
  do {
    hull.push(currentIdx);
    let nextIdx = (currentIdx + 1) % n;
    for (let i = 0; i < n; i++) {
      if (i === currentIdx) continue;
      const cross = (points[nextIdx].x - points[currentIdx].x) * (points[i].y - points[currentIdx].y) -
        (points[nextIdx].y - points[currentIdx].y) * (points[i].x - points[currentIdx].x);
      if (cross < 0) nextIdx = i;
    }
    currentIdx = nextIdx;
  } while (currentIdx !== startIdx && hull.length <= n);

  return hull;
}

function traceMeshPath(ctx, meshNodes) {
  if (meshNodes.length === 1) {
    const only = meshNodes[0];
    ctx.beginPath();
    ctx.arc(only.center.x, only.center.y, only.radius, 0, Math.PI * 2);
    return;
  }

  const centers = meshNodes.map(n => n.center);
  const hull = convexHullIndices(centers);

  ctx.beginPath();
  hull.forEach((idx, i) => {
    const p = centers[idx];
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.closePath();
}

// Simple 2-node tangent capsule (brought back as a connector piece,
// not the whole Mesh's outline anymore).
function computePairTangents(c1, r1, c2, r2) {
  const dx = c2.x - c1.x, dy = c2.y - c1.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  const centerAngle = Math.atan2(dy, dx);
  const alpha = Math.asin((r1 - r2) / d);
  return { t1Angle: centerAngle + Math.PI / 2 - alpha, t2Angle: centerAngle - Math.PI / 2 + alpha };
}

function drawPairCapsule(ctx, c1, r1, c2, r2, color, skipCap1 = false, skipCap2 = false) {
  const { t1Angle, t2Angle } = computePairTangents(c1, r1, c2, r2);
  const p1a = { x: c1.x + r1 * Math.cos(t1Angle), y: c1.y + r1 * Math.sin(t1Angle) };
  const p1b = { x: c2.x + r2 * Math.cos(t1Angle), y: c2.y + r2 * Math.sin(t1Angle) };
  const p2a = { x: c2.x + r2 * Math.cos(t2Angle), y: c2.y + r2 * Math.sin(t2Angle) };
  const p2b = { x: c1.x + r1 * Math.cos(t2Angle), y: c1.y + r1 * Math.sin(t2Angle) };

  ctx.beginPath();
  ctx.moveTo(p1a.x, p1a.y);
  ctx.lineTo(p1b.x, p1b.y);
  if (!skipCap2) {
    ctx.arc(c2.x, c2.y, r2, t1Angle, t2Angle, true);
  } else {
    ctx.lineTo(p2a.x, p2a.y);
  }
  ctx.lineTo(p2b.x, p2b.y);
  if (!skipCap1) {
    ctx.arc(c1.x, c1.y, r1, t2Angle, t1Angle, true);
  } else {
    ctx.lineTo(p1a.x, p1a.y);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

// Helper: compute the (up to) 2 raw analytic tangent point candidates from
// an external point to an ellipse, in the ellipse's own local (unrotated)
// coordinate space. Returns [] if no well-defined tangent exists.
function computeEllipseTangentCandidatesLocal(radiusX, radiusY, localX, localY) {
  const a = Math.max(radiusX, 1e-4);
  const b = radiusY;

  const u = localX / a;
  const v = localY / b;
  const d2 = u * u + v * v; // must be >= 1 since externalPoint is outside the ellipse

  let X1, Y1, X2, Y2;
  if (Math.abs(v) > 1e-6) {
    const disc = Math.max(0, d2 - 1);
    const sqrtTerm = Math.abs(v) * Math.sqrt(disc);
    X1 = (u + sqrtTerm) / d2;
    X2 = (u - sqrtTerm) / d2;
    Y1 = (1 - X1 * u) / v;
    Y2 = (1 - X2 * u) / v;
  } else if (Math.abs(u) > 1e-6) {
    // externalPoint lies along the local x-axis: line becomes X*u = 1
    X1 = X2 = 1 / u;
    const yy = Math.sqrt(Math.max(0, 1 - X1 * X1));
    Y1 = yy;
    Y2 = -yy;
  } else {
    // externalPoint effectively at the ellipse center -- no well-defined tangent
    return [];
  }

  return [
    { x: a * X1, y: b * Y1, angle: Math.atan2(Y1, X1) },
    { x: a * X2, y: b * Y2, angle: Math.atan2(Y2, X2) },
  ];
}

// Helper: Find tangent point on ellipse from external point, pick the one on visible arc.
// Uses the closed-form analytic solution (exactly 2 tangent points from an
// external point to an ellipse) instead of a numeric angular search -- the
// old search could occasionally miss the correct candidate near the visible
// range's boundary for a stray frame, causing a visible flicker to the wrong side.
function findEllipseTangentPoint(ellipseCenter, radiusX, radiusY, ellipseRotation, phase, externalPoint) {
  // Transform external point to ellipse's local (unrotated) coordinate system
  const dx = externalPoint.x - ellipseCenter.x;
  const dy = externalPoint.y - ellipseCenter.y;
  const cos_rot = Math.cos(-ellipseRotation);
  const sin_rot = Math.sin(-ellipseRotation);
  const localX = dx * cos_rot - dy * sin_rot;
  const localY = dx * sin_rot + dy * cos_rot;

  const candidates = computeEllipseTangentCandidatesLocal(radiusX, radiusY, localX, localY);
  if (candidates.length === 0) return null;

  // Which side of the split (local x sign) is actually visible: the
  // terminator sweeps through positive local x when phase >= 0, and
  // through negative local x when phase < 0 (matches drawJointSplitCircle's
  // termCcw convention). Checking the sign of x directly avoids any
  // angle-wraparound edge cases near the ±90° pole boundary.
  const wantsPositiveSide = phase >= 0;
  const onCorrectSide = (c) => (c.x >= 0) === wantsPositiveSide;

  const angularDist = (p, q) => {
    let d = p - q;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d);
  };

  // The "near" tangent is always the one whose angle is closest to the
  // external point's own direction from the ellipse center -- this is
  // mathematically the correct discriminator (picking "whichever candidate
  // happens to be first" can silently grab the wrong/far one).
  const dirAngle = Math.atan2(localY, localX);

  const sideCandidates = candidates.filter(onCorrectSide);
  const pool = sideCandidates.length > 0 ? sideCandidates : candidates;
  let bestTangent = pool.reduce((best, curr) =>
    angularDist(curr.angle, dirAngle) < angularDist(best.angle, dirAngle) ? curr : best
  );

  const a = Math.max(radiusX, 1e-4);
  const centerAngle = wantsPositiveSide ? 0 : Math.PI;
  let capped = false;
  const useCenterFallback = () => {
    bestTangent = { x: a * Math.cos(centerAngle), y: radiusY * Math.sin(centerAngle), angle: centerAngle };
    capped = true;
  };

  // Safety cap #1: if the chosen point still doesn't actually land on the
  // correct side (e.g. near-degenerate geometry where both real tangent
  // points sit on the wrong side), don't risk a wrong-side pick -- just
  // use the center of the visible arc instead.
  if (!onCorrectSide(bestTangent)) {
    useCenterFallback();
  } else {
    // Safety cap #2: being on the correct HALF isn't enough -- it also
    // needs to be on the correct QUARTER, i.e. between the center and
    // whichever pole is nearest the external point, not the far pole.
    // Compare each one's signed offset from the arc's center; if the
    // candidate has overshot into the opposite quarter, clamp to center.
    const signedOffset = (angle) => {
      let d = angle - centerAngle;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      return d;
    };
    const candidateOffset = signedOffset(bestTangent.angle);
    const dirOffset = signedOffset(dirAngle);
    const sign = (v) => (v > 1e-9 ? 1 : v < -1e-9 ? -1 : 0);
    if (sign(candidateOffset) !== 0 && sign(dirOffset) !== 0 && sign(candidateOffset) !== sign(dirOffset)) {
      useCenterFallback();
    }
  }

  // Convert back to screen space
  const cos_rot_back = Math.cos(ellipseRotation);
  const sin_rot_back = Math.sin(ellipseRotation);
  const screenX = ellipseCenter.x + (bestTangent.x * cos_rot_back - bestTangent.y * sin_rot_back);
  const screenY = ellipseCenter.y + (bestTangent.x * sin_rot_back + bestTangent.y * cos_rot_back);
  return { x: screenX, y: screenY, capped };
}

// Helper: find the closest point on a circle to a given point
function closestPointOnCircle(center, radius, point) {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-9) {
    // Point is at center, just return a point on the circle
    return { x: center.x + radius, y: center.y };
  }
  const angle = Math.atan2(dy, dx);
  return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) };
}

// Helper: Draw a triangle with three vertices and a thin stroke
function drawTriangle(ctx, p1, p2, p3, color) {
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.lineTo(p3.x, p3.y);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  
  // Thin stroke to cover antialiasing gaps
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();
}

// ---------------------------------------------------------
// RENDER
// ---------------------------------------------------------

// A real 3D camera: a position, a target it always looks at (so its
// orientation is always derived, never set directly), and a field of
// view. Nodes are still rendered as flat billboards (their SHAPE
// never changes with viewing angle -- only their projected screen
// position and apparent size do), so none of the mesh/hull/capsule
// code below needs to know about any of this; it still just works
// with plain 2D {x,y} + radius.
const camera = {
  target: { x: DESIGN_WIDTH / 2, y: DESIGN_HEIGHT / 2, z: 0 },
  orbitRadius: 700,
  orbitAngle: 0,
  height: 0, // world-Y offset from target during orbit (0 = level orbit for now)
  fov: Math.PI / 3, // 60 degrees
};

function getCameraPosition() {
  return {
    x: camera.target.x + camera.orbitRadius * Math.cos(camera.orbitAngle),
    y: camera.target.y + camera.height,
    z: camera.target.z + camera.orbitRadius * Math.sin(camera.orbitAngle),
  };
}

function vecSub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function vecCross(a, b) { return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }; }
function vecDot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function vecNormalize(v) { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; }

// The camera's orientation is always DERIVED from position + target
// (it always looks at the target), never set independently -- this
// guarantees "always looking at center" by construction.
function computeViewBasis(camPos, target) {
  const forward = vecNormalize(vecSub(target, camPos));
  const worldUp = { x: 0, y: 1, z: 0 };
  const right = vecNormalize(vecCross(forward, worldUp));
  const up = vecCross(right, forward);
  return { forward, right, up };
}

function worldToCamera(point, camPos, basis) {
  const d = vecSub(point, camPos);
  return { x: vecDot(d, basis.right), y: vecDot(d, basis.up), z: vecDot(d, basis.forward) };
}

// Projects a camera-space point to a 2D screen position + a scale
// factor (used for both position and radius, so size and position
// scale together correctly). screenScale is calibrated so that a
// node exactly at the camera's orbit distance renders at its true
// stored size, regardless of the current FOV.
function projectToScreen(camSpace, fov, refDistance, screenCenter) {
  const focalLength = 1 / Math.tan(fov / 2);
  const screenScale = refDistance * Math.tan(fov / 2);
  const scale = (focalLength * screenScale) / camSpace.z;
  return {
    x: screenCenter.x + camSpace.x * scale,
    y: screenCenter.y - camSpace.y * scale,
    scale,
  };
}

// Projects a Node's true 3D position/radius into the 2D {center,
// radius} shape the rest of the rendering code expects.
function projectNode(node, camPos, basis) {
  const camSpace = worldToCamera(node.center, camPos, basis);
  const screenCenterOfDesign = { x: DESIGN_WIDTH / 2, y: DESIGN_HEIGHT / 2 };
  const proj = projectToScreen(camSpace, camera.fov, camera.orbitRadius, screenCenterOfDesign);
  // depth = camera-space z (distance along the viewing direction),
  // carried along so rendering priority can use it without a second
  // world-to-camera pass.
  return { id: node.id, center: { x: proj.x, y: proj.y }, radius: node.radius * proj.scale, depth: camSpace.z };
}

// ---------------------------------------------------------
// SHARED-NODE JOINT SPLIT (moon-phase division)
// ---------------------------------------------------------

function centroidOfOtherNodes(mesh, sharedNodeId) {
  const others = mesh.nodeIds.filter(id => id !== sharedNodeId);
  if (others.length === 0) return null;
  const sum = others.reduce((acc, id) => {
    const c = nodes[id].center;
    return { x: acc.x + c.x, y: acc.y + c.y, z: acc.z + c.z };
  }, { x: 0, y: 0, z: 0 });
  return { x: sum.x / others.length, y: sum.y / others.length, z: sum.z / others.length };
}

// Draws the split circle: colorA fills the side facing meshA, colorB
// the side facing meshB, divided by the terminator ellipse.
function drawJointSplitCircle(ctx, screenCenter, screenRadius, azimuth, phase, colorA, colorB, separatorColor) {
  const r = screenRadius;
  const ex = Math.abs(phase) * r;
  const termCcw = phase >= 0;

  ctx.save();
  ctx.beginPath();
  ctx.arc(screenCenter.x, screenCenter.y, r, 0, Math.PI * 2);
  ctx.clip();

  ctx.translate(screenCenter.x, screenCenter.y);
  ctx.rotate(azimuth);

  // A's region: the -x half, bounded by the terminator ellipse.
  ctx.fillStyle = colorA;
  ctx.beginPath();
  ctx.arc(0, 0, r, Math.PI / 2, -Math.PI / 2, false);
  ctx.ellipse(0, 0, ex, r, 0, -Math.PI / 2, Math.PI / 2, !termCcw);
  ctx.closePath();
  ctx.fill();

  // B's region: the +x half, bounded by the terminator ellipse.
  ctx.fillStyle = colorB;
  ctx.beginPath();
  ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);
  ctx.ellipse(0, 0, ex, r, 0, Math.PI / 2, -Math.PI / 2, termCcw);
  ctx.closePath();
  ctx.fill();

  // Separator stroke along the terminator ellipse -- minimum thickness
  // to cover the sub-pixel gap between the two filled halves. Color
  // is always the lower-id mesh's color, stable across all frames.
  // -- Temporarily disabled to check if it's still needed.
  // ctx.strokeStyle = separatorColor;
  // ctx.lineWidth = 1.5;
  // ctx.beginPath();
  // ctx.ellipse(0, 0, ex, r, 0, -Math.PI / 2, Math.PI / 2, !termCcw);
  // ctx.stroke();

  // Rim strokes: one per half in each mesh's own color, covering
  // the antialiased white edge at the circle's outer boundary.
  ctx.strokeStyle = colorA;
  ctx.beginPath();
  ctx.arc(0, 0, r, Math.PI / 2, -Math.PI / 2, false);
  ctx.stroke();

  ctx.strokeStyle = colorB;
  ctx.beginPath();
  ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);
  ctx.stroke();

  ctx.restore();
}

function render() {
  function edgeSegment(pivotProj, otherProj, angle) {
    return {
      a: { x: pivotProj.center.x + pivotProj.radius * Math.cos(angle), y: pivotProj.center.y + pivotProj.radius * Math.sin(angle) },
      b: { x: otherProj.center.x + otherProj.radius * Math.cos(angle), y: otherProj.center.y + otherProj.radius * Math.sin(angle) },
    };
  }
  function segmentIntersect(s1, s2) {
    const d1 = { x: s1.b.x - s1.a.x, y: s1.b.y - s1.a.y };
    const d2 = { x: s2.b.x - s2.a.x, y: s2.b.y - s2.a.y };
    const denom = d1.x * d2.y - d1.y * d2.x;
    if (Math.abs(denom) < 1e-9) return null;
    const t = ((s2.a.x - s1.a.x) * d2.y - (s2.a.y - s1.a.y) * d2.x) / denom;
    const u = ((s2.a.x - s1.a.x) * d1.y - (s2.a.y - s1.a.y) * d1.x) / denom;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return { x: s1.a.x + t * d1.x, y: s1.a.y + t * d1.y };
  }
  // Where a ray (origin + t*dir, t >= 0) crosses a circle it isn't tangent
  // to, it hits two points: a near one (facing back toward the ray's
  // origin/pivot) and a far one (the outer side). We want the FAR one --
  // that's the side matching the capsule's actual outer silhouette, not
  // a point cutting through the middle of the short node.
  function rayCircleFarSide(origin, dir, center, radius) {
    const fx = origin.x - center.x, fy = origin.y - center.y;
    const a = dir.x * dir.x + dir.y * dir.y;
    if (a < 1e-9) return null;
    const b = 2 * (fx * dir.x + fy * dir.y);
    const c = fx * fx + fy * fy - radius * radius;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const sqrtDisc = Math.sqrt(disc);
    const roots = [(-b - sqrtDisc) / (2 * a), (-b + sqrtDisc) / (2 * a)].filter(t => t >= 0).sort((x, y) => x - y);
    if (roots.length === 0) return null;
    const t = roots[roots.length - 1];
    return { x: origin.x + t * dir.x, y: origin.y + t * dir.y, t };
  }
  // Same as segmentIntersect, but when the true crossing point lies beyond
  // one segment's far end (that node's arm is simply shorter than the
  // other's), fall back to where the OTHER line first enters that short
  // node's own circle -- the actual point the two capsules visually meet,
  // rather than reporting no intersection at all.
  function segmentIntersectWithCircleFallback(s1, s2, farNode1, farNode2) {
    const d1 = { x: s1.b.x - s1.a.x, y: s1.b.y - s1.a.y };
    const d2 = { x: s2.b.x - s2.a.x, y: s2.b.y - s2.a.y };
    const denom = d1.x * d2.y - d1.y * d2.x;
    if (Math.abs(denom) < 1e-9) return null;
    const t = ((s2.a.x - s1.a.x) * d2.y - (s2.a.y - s1.a.y) * d2.x) / denom;
    const u = ((s2.a.x - s1.a.x) * d1.y - (s2.a.y - s1.a.y) * d1.x) / denom;
    if (t < 0 || u < 0) return null; // crossing is behind the pivot -- still invalid
    if (t <= 1 && u <= 1) {
      return { x: s1.a.x + t * d1.x, y: s1.a.y + t * d1.y };
    }
    if (t > 1) {
      // s1's own arm (toward farNode1) is the short one -- check where
      // s2's line crosses the far side of farNode1's circle instead.
      const hit = rayCircleFarSide(s2.a, d2, farNode1.center, farNode1.radius);
      if (hit && hit.t <= 1) return { x: hit.x, y: hit.y };
    }
    if (u > 1) {
      // s2's own arm (toward farNode2) is the short one -- check where
      // s1's line crosses the far side of farNode2's circle instead.
      const hit = rayCircleFarSide(s1.a, d1, farNode2.center, farNode2.radius);
      if (hit && hit.t <= 1) return { x: hit.x, y: hit.y };
    }
    return null;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  applyDesignSpaceTransform();

  const camPos = getCameraPosition();
  const basis = computeViewBasis(camPos, camera.target);

  // Build ownership map for shared nodes
  const owners = {};
  Object.values(meshes).forEach(mesh => {
    mesh.nodeIds.forEach(id => { (owners[id] ||= []).push(mesh.id); });
  });
  const sharedNodeIds = new Set(Object.keys(owners).filter(id => owners[id].length >= 2).map(Number));
  
  // Build a set of moon phase nodes (ANY owner is 2-node mesh)
  const moonPhaseNodeIds = new Set();
  Object.keys(owners).forEach(nodeIdStr => {
    const nodeId = Number(nodeIdStr);
    const ownerIds = owners[nodeId];
    if (ownerIds.length >= 2 && ownerIds.some(meshId => meshes[meshId].nodeIds.length === 2)) {
      moonPhaseNodeIds.add(nodeId);
    }
  });

  // Project all nodes once
  const projectedNodes = {};
  Object.values(nodes).forEach(node => {
    projectedNodes[node.id] = projectNode(node, camPos, basis);
  });

  // Build a map to store moon phase node rendering data for red line drawing
  const moonPhaseNodeData = {};

  Object.keys(owners).forEach(nodeIdStr => {
    if (owners[nodeIdStr].length < 2) return;
    const nodeId = Number(nodeIdStr);
    const ownerIds = owners[nodeId];

    // Check if ANY owner is a 2-node mesh
    const hasAny2NodeOwner = ownerIds.some(meshId => meshes[meshId].nodeIds.length === 2);

    // Only process moon phase if at least one owner is 2-node
    if (!hasAny2NodeOwner) return;

    // At least one 2-node owner - calculate moon phase data
    if (ownerIds.length !== 2) return;  // Moon phase only works with 2 owners

    const p = projectedNodes[nodeId];
    const meshA = meshes[ownerIds[0]], meshB = meshes[ownerIds[1]];
    const centroidA = centroidOfOtherNodes(meshA, nodeId);
    const centroidB = centroidOfOtherNodes(meshB, nodeId);
    if (!centroidA || !centroidB) return;

    const nodeCam = worldToCamera(nodes[nodeId].center, camPos, basis);
    const dA = vecNormalize(vecSub(worldToCamera(centroidA, camPos, basis), nodeCam));
    const dB = vecNormalize(vecSub(worldToCamera(centroidB, camPos, basis), nodeCam));
    const axis = { x: dB.x - dA.x, y: dB.y - dA.y, z: dB.z - dA.z };
    const axisLen = Math.hypot(axis.x, axis.y, axis.z);
    if (axisLen < 1e-9) return;

    const axisN = { x: axis.x / axisLen, y: axis.y / axisLen, z: axis.z / axisLen };
    const azimuth = Math.atan2(-axisN.y, axisN.x);
    const phase = axisN.z;
    
    // Store moon phase data for this node
    moonPhaseNodeData[nodeId] = {
      center: p.center,
      radius: p.radius,
      azimuth: azimuth,
      phase: phase,
      idA: meshA.id,
      idB: meshB.id,
      colorA: meshA.color,
      colorB: meshB.color
    };
  });

  // Build a flat list of primitives, each with its own depth key.
  // Node circles now render with their pairs for proper depth sorting.
  const primitives = [];
  // Collected separately so the debug tangent line/dots can be drawn
  // unconditionally on top of everything, like the black debug outline.
  const debugTangentData = [];

  Object.values(meshes).forEach(mesh => {
    const pNodes = mesh.nodeIds.map(id => projectedNodes[id]);

    // Pair capsules and node circles
    for (let i = 0; i < pNodes.length; i++) {
      for (let j = i + 1; j < pNodes.length; j++) {
        const a = pNodes[i], b = pNodes[j];
        const depth = Math.max(a.depth, b.depth);
        const skip1 = sharedNodeIds.has(a.id);
        const skip2 = sharedNodeIds.has(b.id);
        const color = mesh.color;

        // Precompute all red lines for this capsule's pivot ends
        const redLines = [];
        [{ isPivot: skip1, pivotNode: a, otherNode: b, pivotIsA: true },
         { isPivot: skip2, pivotNode: b, otherNode: a, pivotIsA: false }].forEach(({ isPivot, pivotNode, otherNode, pivotIsA }) => {
          if (!isPivot) return;
          const tanA = computePairTangents(pivotNode.center, pivotNode.radius, otherNode.center, otherNode.radius);
          (owners[pivotNode.id] || []).forEach(otherMeshId => {
            if (otherMeshId === mesh.id) return;
            meshes[otherMeshId].nodeIds.filter(id => id !== pivotNode.id).forEach(otherId => {
              const pB = projectedNodes[otherId];
              const tanB = computePairTangents(pivotNode.center, pivotNode.radius, pB.center, pB.radius);
              const pt =
                segmentIntersectWithCircleFallback(edgeSegment(pivotNode, otherNode, tanA.t1Angle), edgeSegment(pivotNode, pB, tanB.t2Angle), otherNode, pB) ||
                segmentIntersectWithCircleFallback(edgeSegment(pivotNode, otherNode, tanA.t2Angle), edgeSegment(pivotNode, pB, tanB.t1Angle), otherNode, pB);
              if (!pt) return;
              const rimAngle = Math.atan2(pt.y - pivotNode.center.y, pt.x - pivotNode.center.x);
              const rim = { x: pivotNode.center.x + pivotNode.radius * Math.cos(rimAngle), y: pivotNode.center.y + pivotNode.radius * Math.sin(rimAngle) };
              const onT1 = !!segmentIntersectWithCircleFallback(edgeSegment(pivotNode, otherNode, tanA.t1Angle), edgeSegment(pivotNode, pB, tanB.t2Angle), otherNode, pB);
              const tangentAngle = onT1 ? tanA.t1Angle : tanA.t2Angle;
              const tangentRim = { x: pivotNode.center.x + pivotNode.radius * Math.cos(tangentAngle), y: pivotNode.center.y + pivotNode.radius * Math.sin(tangentAngle) };
              redLines.push({ pt, rim, tangentRim, onT1, pivotIsA });
            });
          });
        });

        // Find the longest red line at build time
        let longestPt = null, longestRim = null, longestTangentRim = null, longestOnT1 = null, longestPivotIsA = null, longestDist = -1;
        redLines.forEach(({ pt, rim, tangentRim, onT1, pivotIsA }) => {
          const dist = Math.hypot(rim.x - pt.x, rim.y - pt.y);
          if (dist > longestDist) { longestDist = dist; longestPt = pt; longestRim = rim; longestTangentRim = tangentRim; longestOnT1 = onT1; longestPivotIsA = pivotIsA; }
        });
        
        // Determine which pivot node the longest red line belongs to
        const longestPivotNodeId = longestPivotIsA ? a.id : b.id;

        // Stash this for the final top-layer debug pass instead of drawing
        // it inline (inline drawing gets sorted into depth order and can
        // end up buried under the moon phase circle).
        if (longestPt && moonPhaseNodeIds.has(longestPivotNodeId)) {
          debugTangentData.push({ longestPt, longestRim, longestTangentRim, longestPivotNodeId, meshId: mesh.id });
        }

        // Compute fill triangle from centroid to this capsule
        const meshCentroid = mesh.nodeIds.reduce(
          (acc, id) => {
            const c = nodes[id].center;
            return { x: acc.x + c.x, y: acc.y + c.y, z: acc.z + c.z };
          },
          { x: 0, y: 0, z: 0 }
        );
        meshCentroid.x /= mesh.nodeIds.length;
        meshCentroid.y /= mesh.nodeIds.length;
        meshCentroid.z /= mesh.nodeIds.length;

        // Project centroid to screen space
        const centroidCam = worldToCamera(meshCentroid, camPos, basis);
        const screenCenterOfDesign = { x: DESIGN_WIDTH / 2, y: DESIGN_HEIGHT / 2 };
        const centroidProj = projectToScreen(centroidCam, camera.fov, camera.orbitRadius, screenCenterOfDesign);
        const screenCentroid = { x: centroidProj.x, y: centroidProj.y };

        primitives.push({
          depth,
          ownerMeshId: mesh.id,
          draw: () => {
            // Draw fill triangle from centroid to closest points on each node circle
            const p2 = closestPointOnCircle(a.center, a.radius, screenCentroid);
            const p3 = closestPointOnCircle(b.center, b.radius, screenCentroid);
            drawTriangle(ctx, screenCentroid, p2, p3, color);
            
            // Draw capsule outline on top
            drawPairCapsule(ctx, a.center, a.radius, b.center, b.radius, color, skip1, skip2);
            
            // Draw the two node circles for this pair (unless they're moon phase nodes)
            if (!moonPhaseNodeIds.has(a.id)) {
              ctx.beginPath();
              ctx.arc(a.center.x, a.center.y, a.radius, 0, Math.PI * 2);
              ctx.fillStyle = color;
              ctx.fill();
            }
            if (!moonPhaseNodeIds.has(b.id)) {
              ctx.beginPath();
              ctx.arc(b.center.x, b.center.y, b.radius, 0, Math.PI * 2);
              ctx.fillStyle = color;
              ctx.fill();
            }
          }
        });
      }
    }
  });

  // Render moon phase nodes (2-node + any other mesh)
  Object.keys(moonPhaseNodeData).forEach(nodeIdStr => {
    const nodeId = Number(nodeIdStr);
    const ownerIds = owners[nodeId];
    
    const p = projectedNodes[nodeId];
    const sharedDepth = p.depth - 0.001;
    const meshA = meshes[ownerIds[0]], meshB = meshes[ownerIds[1]];
    const ellipseData = moonPhaseNodeData[nodeId];
    
    const separatorColor = meshA.id < meshB.id ? meshA.color : meshB.color;
    const center = ellipseData.center, radius = ellipseData.radius;
    primitives.push({
      depth: sharedDepth,
      draw: () => drawJointSplitCircle(ctx, center, radius, ellipseData.azimuth, ellipseData.phase, meshA.color, meshB.color, separatorColor)
    });
  });

  // Sort all primitives back-to-front and draw
  primitives.sort((a, b) => b.depth - a.depth);
  primitives.forEach(p => p.draw());

  // Fix up the moon phase joint's boundary: redirect each mesh's capsule
  // edge at the point where it crosses the other mesh's edge (longestPt),
  // handing the outer sliver and the crescent's tip over to the correct
  // color instead of leaving them on the wrong side of the seam.
  debugTangentData.forEach(({ longestPt, longestRim, longestTangentRim, longestPivotNodeId, meshId }) => {
    const ellipseData = moonPhaseNodeData[longestPivotNodeId];
    if (!ellipseData) return;

    const { center, radius: r, azimuth, phase, colorA, colorB, idA } = ellipseData;
    const ex = Math.abs(phase) * r;
    const tangentPoint = findEllipseTangentPoint(center, ex, r, azimuth, phase, longestPt);

    // rimHit (where the red line crosses the rim) and the outer wedge only
    // depend on where the line crosses the rim, which stays well-defined
    // even in the capped edge case -- so they should always apply. Only
    // the INNER (phase/crescent tip) wedge has the "carve out a huge
    // chunk" problem at the cap, so that part alone is skipped there.
    if (tangentPoint) {
      // --- Find where the red line (longestPt -> tangentPoint) crosses
      // the OUTER rim circle (it must cross exactly once, since longestPt
      // is outside the node and tangentPoint is inside it). ---
      const dxseg = tangentPoint.x - longestPt.x, dyseg = tangentPoint.y - longestPt.y;
      const fx = longestPt.x - center.x, fy = longestPt.y - center.y;
      const a_coef = dxseg * dxseg + dyseg * dyseg;
      const b_coef = 2 * (fx * dxseg + fy * dyseg);
      const c_coef = fx * fx + fy * fy - r * r;
      const disc = b_coef * b_coef - 4 * a_coef * c_coef;

      let rimHit = null;
      if (disc >= 0 && a_coef > 1e-9) {
        const sqrtDisc = Math.sqrt(disc);
        const t1 = (-b_coef - sqrtDisc) / (2 * a_coef);
        const t2 = (-b_coef + sqrtDisc) / (2 * a_coef);
        const validT = [t1, t2].find(t => t >= 0 && t <= 1);
        if (validT !== undefined) {
          rimHit = { x: longestPt.x + dxseg * validT, y: longestPt.y + dyseg * validT };
        }
      }

      if (rimHit) {
        // Work in the ellipse's local (unrotated) frame for the arcs.
        const toLocal = (pt) => {
          const dx = pt.x - center.x, dy = pt.y - center.y;
          const cosA = Math.cos(-azimuth), sinA = Math.sin(-azimuth);
          return { x: dx * cosA - dy * sinA, y: dx * sinA + dy * cosA };
        };
        const localRimHit = toLocal(rimHit);
        const localTangent = toLocal(tangentPoint);
        const rimHitAngle = Math.atan2(localRimHit.y, localRimHit.x);
        const angleT = Math.atan2(localTangent.y / r, localTangent.x / Math.max(ex, 1e-4));

        const angularDist = (p, q) => {
          let d = p - q;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          return Math.abs(d);
        };
        // The tip is bounded by whichever pole (always at local ±90°) is
        // nearest to the tangent point.
        const poleAngle = angularDist(angleT, Math.PI / 2) <= angularDist(angleT, -Math.PI / 2)
          ? Math.PI / 2 : -Math.PI / 2;

        // Whichever color currently occupies that sliver (based on the
        // standard colorA/colorB angular split) gets swapped to the other.
        let normRim = rimHitAngle;
        while (normRim < 0) normRim += Math.PI * 2;
        while (normRim >= Math.PI * 2) normRim -= Math.PI * 2;
        const inColorARange = normRim >= Math.PI / 2 && normRim <= (3 * Math.PI / 2);
        const otherColor = inColorARange ? colorB : colorA;

        const shortArcParams = (startAngle, endAngle) => {
          let diff = endAngle - startAngle;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          return { anticlockwise: diff < 0 };
        };

        ctx.save();
        ctx.translate(center.x, center.y);
        ctx.rotate(azimuth);

        // --- Outer wedge: redirect the boundary. Instead of the old
        // capsule edge continuing from longestPt to longestTangentRim (the
        // black line, straight into the rim), cut it off at longestPt and
        // give that sliver -- bounded by the black-line edge, the rim, and
        // the red line down to rimHit -- to the OTHER mesh's color. Net
        // effect: the rendered boundary now effectively follows the red
        // line from longestPt to the rim instead of the old edge.
        if (longestTangentRim) {
          const otherColorOuter = meshId === idA ? colorB : colorA;
          const localTangentRim = toLocal(longestTangentRim);
          const localLongestPt = toLocal(longestPt);
          const tangentRimAngle = Math.atan2(localTangentRim.y, localTangentRim.x);
          const outerRimSweep = shortArcParams(rimHitAngle, tangentRimAngle);

          ctx.beginPath();
          ctx.moveTo(localTangentRim.x, localTangentRim.y);
          ctx.lineTo(localLongestPt.x, localLongestPt.y);
          ctx.lineTo(localRimHit.x, localRimHit.y);
          ctx.arc(0, 0, r, rimHitAngle, tangentRimAngle, outerRimSweep.anticlockwise);
          ctx.closePath();
          ctx.fillStyle = otherColorOuter;
          ctx.fill();
        }

        ctx.beginPath();
        ctx.moveTo(localRimHit.x, localRimHit.y);
        const rimSweep = shortArcParams(rimHitAngle, poleAngle);
        ctx.arc(0, 0, r, rimHitAngle, poleAngle, rimSweep.anticlockwise);
        const termSweep = shortArcParams(poleAngle, angleT);
        ctx.ellipse(0, 0, ex, r, 0, poleAngle, angleT, termSweep.anticlockwise);
        ctx.closePath();
        // The inner (phase/crescent) wedge is the one that carves out a
        // huge chunk at the capped edge case -- skip only this part there.
        if (!tangentPoint.capped) {
          ctx.fillStyle = otherColor;
          ctx.fill();
        }
        ctx.restore();
      }
    }

    // DEBUG -- red dot at the found intersection point (longestPt)
    ctx.fillStyle = '#ff0000';
    ctx.beginPath();
    ctx.arc(longestPt.x, longestPt.y, 5, 0, Math.PI * 2);
    ctx.fill();
  });

  // DEBUG -- Black outlines (temporarily disabled)
  // ctx.strokeStyle = '#000000';
  // ctx.lineWidth = 2;
  // Object.values(nodes).forEach(node => {
  //   const p = projectedNodes[node.id];
  //   ctx.beginPath();
  //   ctx.arc(p.center.x, p.center.y, p.radius, 0, Math.PI * 2);
  //   ctx.stroke();
  // });
}

// ---------------------------------------------------------
// EXAMPLE SCENE
// ---------------------------------------------------------
// Quadrant 1 (top-left): the MINIMAL shared-node case -- two 2-node
// meshes (two "lines") sharing the middle node, forming a V shape.
const q1x = DESIGN_WIDTH * 0.25, q1y = DESIGN_HEIGHT * 0.25;
const jointNode = createNode({ x: q1x, y: q1y }, 35);
const blueEnd = createNode({ x: q1x - 110, y: q1y - 100 }, 30);
createMesh([blueEnd, jointNode], '#4fc3f7'); // blue line
const orangeEnd = createNode({ x: q1x + 110, y: q1y - 100, z: 40 }, 25);
createMesh([jointNode, orangeEnd], '#ff8a65'); // orange line

// Quadrant 2 (top-right): a 3-node triangle, order deliberately scrambled
const q2x = DESIGN_WIDTH * 0.75, q2y = DESIGN_HEIGHT * 0.25;
const b1 = createNode({ x: q2x, y: q2y - 100 }, 50);
const b2 = createNode({ x: q2x + 120, y: q2y + 80 }, 35);
const b3 = createNode({ x: q2x - 120, y: q2y + 60 }, 40);
createMesh([b3, b1, b2], '#ff8a65');

// Quadrant 3 (bottom-left): 4 nodes, one deliberately enclosed inside
// the hull of the other three -- demonstrates it's excluded from the
// hull outline but still connects via the all-pairs capsules.
const q3x = DESIGN_WIDTH * 0.25, q3y = DESIGN_HEIGHT * 0.75;
const c1n = createNode({ x: q3x - 130, y: q3y - 100 }, 45);
const c2n = createNode({ x: q3x + 130, y: q3y - 100 }, 45);
const c3n = createNode({ x: q3x, y: q3y + 120 }, 45);
const c4n = createNode({ x: q3x, y: q3y - 20 }, 20); // enclosed
createMesh([c1n, c2n, c3n, c4n], '#a5d6a7');

// A purple 2-node mesh sharing c2n with the green blob above
const purpleEnd = createNode({ x: q3x + 280, y: q3y - 80 }, 30);
createMesh([c2n, purpleEnd], '#ce93d8');

// Quadrant 4 (bottom-right): 6 nodes in an irregular, free-form
// arrangement -- a bigger, more organic-looking blob. Two nodes are
// given non-zero z to demonstrate perspective scaling: d2 sits closer
// to the viewer (z>0, renders bigger than its stored radius), d5
// sits farther away (z<0, renders smaller).
const q4x = DESIGN_WIDTH * 0.75, q4y = DESIGN_HEIGHT * 0.75;
const d1 = createNode({ x: q4x - 150, y: q4y - 60 }, 40);
const d2 = createNode({ x: q4x - 60, y: q4y - 130, z: 200 }, 55);
const d3 = createNode({ x: q4x + 90, y: q4y - 100 }, 30);
const d4 = createNode({ x: q4x + 150, y: q4y + 40 }, 45);
const d5 = createNode({ x: q4x + 30, y: q4y + 140, z: -200 }, 35);
const d6 = createNode({ x: q4x - 110, y: q4y + 90 }, 25);
createMesh([d1, d2, d3, d4, d5, d6], '#ce93d8');

// A new green mesh sharing d1 with the purple mesh above
const e1 = createNode({ x: q4x - 260, y: q4y + 60 }, 30);
const e2 = createNode({ x: q4x - 200, y: q4y + 180 }, 25);
createMesh([d1, e1, e2], '#a5d6a7');

// ---------------------------------------------------------
// ANIMATION LOOP
// ---------------------------------------------------------
canvas.style.background = '#ffffff';

let paused = false;
const pauseBtn = document.getElementById('pauseBtn');
if (pauseBtn) {
  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    if (!paused) lastTime = performance.now();
  });
}

let lastTime = 0;
function loop(timestamp) {
  if (!paused) {
    const dt = (timestamp - lastTime) / 1000;
    lastTime = timestamp;
    camera.orbitAngle += dt * 0.4;
    render();
  } else {
    lastTime = timestamp;
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);