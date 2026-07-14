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

// Helper: Find tangent point on ellipse from external point, pick the one on visible arc
function findEllipseTangentPoint(ellipseCenter, radiusX, radiusY, ellipseRotation, phase, externalPoint) {
  // Transform external point to ellipse's local coordinate system
  const dx = externalPoint.x - ellipseCenter.x;
  const dy = externalPoint.y - ellipseCenter.y;
  const cos_rot = Math.cos(-ellipseRotation);
  const sin_rot = Math.sin(-ellipseRotation);
  const localX = dx * cos_rot - dy * sin_rot;
  const localY = dx * sin_rot + dy * cos_rot;

  // Find tangent points by searching around the ellipse
  const candidates = [];
  
  for (let t = 0; t < Math.PI * 2; t += 0.02) {
    const cos_t = Math.cos(t);
    const sin_t = Math.sin(t);
    
    // Point on ellipse
    const px = radiusX * cos_t;
    const py = radiusY * sin_t;
    
    // Vector from ellipse point to external point
    const vx = localX - px;
    const vy = localY - py;
    
    // Normal to ellipse at this point
    const nx = cos_t / (radiusX * radiusX);
    const ny = sin_t / (radiusY * radiusY);
    
    // For tangency: dot product should be ~0
    const dot = vx * nx + vy * ny;
    candidates.push({ t, dot, px, py });
  }
  
  // Find local minima of |dot| to get tangent points
  let tangents = [];
  for (let i = 0; i < candidates.length; i++) {
    const prev = candidates[(i - 1 + candidates.length) % candidates.length];
    const curr = candidates[i];
    const next = candidates[(i + 1) % candidates.length];
    
    if (Math.abs(curr.dot) < Math.abs(prev.dot) && Math.abs(curr.dot) < Math.abs(next.dot)) {
      tangents.push(curr);
    }
  }
  
  // Determine visible arc based on phase
  // termCcw = phase >= 0 (same logic as drawJointSplitCircle)
  // If phase >= 0: visible arc is drawn as [-π/2, π/2] counterclockwise (normal)
  // If phase < 0: visible arc is drawn as [-π/2, π/2] clockwise (flipped)
  const visibleTangents = tangents.filter(t => {
    let angle = t.t;
    while (angle > Math.PI) angle -= Math.PI * 2;
    while (angle < -Math.PI) angle += Math.PI * 2;
    
    if (phase >= 0) {
      // Normal: visible arc is [-π/2, π/2]
      return angle >= -Math.PI / 2 && angle <= Math.PI / 2;
    } else {
      // Flipped: visible arc is the other half [π/2, 3π/2] or [-π/2, -3π/2]
      return angle <= -Math.PI / 2 || angle >= Math.PI / 2;
    }
  });
  
  // Pick the tangent closest to angle 0 (center of visible arc)
  const bestTangent = visibleTangents.length > 0 
    ? visibleTangents.reduce((best, curr) => {
        let currAngle = curr.t % (Math.PI * 2);
        if (currAngle > Math.PI) currAngle -= Math.PI * 2;
        if (currAngle < -Math.PI) currAngle += Math.PI * 2;
        
        let bestAngle = best.t % (Math.PI * 2);
        if (bestAngle > Math.PI) bestAngle -= Math.PI * 2;
        if (bestAngle < -Math.PI) bestAngle += Math.PI * 2;
        
        // For flipped phase, measure distance from π instead of 0
        const currDist = phase >= 0 ? Math.abs(currAngle) : Math.abs(Math.abs(currAngle) - Math.PI);
        const bestDist = phase >= 0 ? Math.abs(bestAngle) : Math.abs(Math.abs(bestAngle) - Math.PI);
        
        return currDist < bestDist ? curr : best;
      })
    : tangents[0];
  
  // Convert to screen space
  if (bestTangent) {
    const cos_rot_back = Math.cos(ellipseRotation);
    const sin_rot_back = Math.sin(ellipseRotation);
    const screenX = ellipseCenter.x + (bestTangent.px * cos_rot_back - bestTangent.py * sin_rot_back);
    const screenY = ellipseCenter.y + (bestTangent.px * sin_rot_back + bestTangent.py * cos_rot_back);
    return { x: screenX, y: screenY };
  }
  
  return null;
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
  ctx.strokeStyle = separatorColor;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.ellipse(0, 0, ex, r, 0, -Math.PI / 2, Math.PI / 2, !termCcw);
  ctx.stroke();

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
      phase: phase
    };
  });

  // Build a flat list of primitives, each with its own depth key.
  // Node circles now render with their pairs for proper depth sorting.
  const primitives = [];

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
                segmentIntersect(edgeSegment(pivotNode, otherNode, tanA.t1Angle), edgeSegment(pivotNode, pB, tanB.t2Angle)) ||
                segmentIntersect(edgeSegment(pivotNode, otherNode, tanA.t2Angle), edgeSegment(pivotNode, pB, tanB.t1Angle));
              if (!pt) return;
              const rimAngle = Math.atan2(pt.y - pivotNode.center.y, pt.x - pivotNode.center.x);
              const rim = { x: pivotNode.center.x + pivotNode.radius * Math.cos(rimAngle), y: pivotNode.center.y + pivotNode.radius * Math.sin(rimAngle) };
              const onT1 = !!segmentIntersect(edgeSegment(pivotNode, otherNode, tanA.t1Angle), edgeSegment(pivotNode, pB, tanB.t2Angle));
              const tangentAngle = onT1 ? tanA.t1Angle : tanA.t2Angle;
              const tangentRim = { x: pivotNode.center.x + pivotNode.radius * Math.cos(tangentAngle), y: pivotNode.center.y + pivotNode.radius * Math.sin(tangentAngle) };
              redLines.push({ pt, rim, tangentRim, onT1, pivotIsA });
            });
          });
        });

        // Find the longest red line at build time
        let longestPt = null, longestRim = null, longestOnT1 = null, longestPivotIsA = null, longestDist = -1;
        redLines.forEach(({ pt, rim, onT1, pivotIsA }) => {
          const dist = Math.hypot(rim.x - pt.x, rim.y - pt.y);
          if (dist > longestDist) { longestDist = dist; longestPt = pt; longestRim = rim; longestOnT1 = onT1; longestPivotIsA = pivotIsA; }
        });
        
        // Determine which pivot node the longest red line belongs to
        const longestPivotNodeId = longestPivotIsA ? a.id : b.id;

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
            
            // DEBUG -- red dot and tangent line to visible terminator (only on moon phase pivot nodes)
            if (longestPt && moonPhaseNodeIds.has(longestPivotNodeId)) {
              let ellipseData = moonPhaseNodeData[longestPivotNodeId];
              
              // Fallback: if data isn't populated, use the projected node directly
              if (!ellipseData) {
                const p = projectedNodes[longestPivotNodeId];
                ellipseData = {
                  center: p.center,
                  radius: p.radius,
                  azimuth: 0,
                  phase: 0
                };
              }
              
              if (ellipseData) {
                // Find tangent point on the visible terminator ellipse
                const r = ellipseData.radius;
                const ex = Math.abs(ellipseData.phase) * r;
                const tangentPoint = findEllipseTangentPoint(ellipseData.center, ex, r, ellipseData.azimuth, ellipseData.phase, longestPt);
                
                if (tangentPoint) {
                  // Draw red line from longest point to tangent point
                  ctx.strokeStyle = '#ff0000';
                  ctx.lineWidth = 1.5;
                  ctx.setLineDash([]);
                  ctx.beginPath();
                  ctx.moveTo(longestPt.x, longestPt.y);
                  ctx.lineTo(tangentPoint.x, tangentPoint.y);
                  ctx.stroke();
                }
              }
              
              // Draw red dot at longest point
              ctx.fillStyle = '#ff0000';
              ctx.beginPath();
              ctx.arc(longestPt.x, longestPt.y, 5, 0, Math.PI * 2);
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

  // DEBUG -- Black outline of visible terminator arc for moon phase nodes
  Object.keys(moonPhaseNodeData).forEach(nodeIdStr => {
    const nodeId = Number(nodeIdStr);
    const ellipseData = moonPhaseNodeData[nodeId];
    const r = ellipseData.radius;
    const ex = Math.abs(ellipseData.phase) * r;
    const termCcw = ellipseData.phase >= 0;
    
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    ctx.save();
    ctx.translate(ellipseData.center.x, ellipseData.center.y);
    ctx.rotate(ellipseData.azimuth);
    ctx.beginPath();
    // Draw the same arc as drawJointSplitCircle uses for the terminator
    ctx.ellipse(0, 0, ex, r, 0, -Math.PI / 2, Math.PI / 2, !termCcw);
    ctx.stroke();
    ctx.restore();
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