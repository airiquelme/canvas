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
function createMesh(nodeIds, color, z = 0) {
  const id = nextMeshId++;
  meshes[id] = { id, nodeIds, color, z };
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

function drawPairCapsule(ctx, c1, r1, c2, r2, color) {
  const { t1Angle, t2Angle } = computePairTangents(c1, r1, c2, r2);
  const p1a = { x: c1.x + r1 * Math.cos(t1Angle), y: c1.y + r1 * Math.sin(t1Angle) };
  const p1b = { x: c2.x + r2 * Math.cos(t1Angle), y: c2.y + r2 * Math.sin(t1Angle) };
  const p2b = { x: c1.x + r1 * Math.cos(t2Angle), y: c1.y + r1 * Math.sin(t2Angle) };

  ctx.beginPath();
  ctx.moveTo(p1a.x, p1a.y);
  ctx.lineTo(p1b.x, p1b.y);
  ctx.arc(c2.x, c2.y, r2, t1Angle, t2Angle, true);
  ctx.lineTo(p2b.x, p2b.y);
  ctx.arc(c1.x, c1.y, r1, t2Angle, t1Angle, true);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function drawMeshFlat(ctx, meshNodes, color) {
  traceMeshPath(ctx, meshNodes);
  ctx.fillStyle = color;
  ctx.fill();

  // Circles at each corner (hull node), radius equal to that node's
  // own radius -- simple overlay for now, no tangent-arc rounding yet.
  const hull = meshNodes.length === 1 ? [0] : convexHullIndices(meshNodes.map(n => n.center));
  hull.forEach(idx => {
    const node = meshNodes[idx];
    ctx.beginPath();
    ctx.arc(node.center.x, node.center.y, node.radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  });

  // Wasteful for now, but simple: connect EVERY node to every other
  // node with a tangent capsule, not just hull-adjacent ones. Their
  // union covers the shape without needing precise hull-tangent math.
  for (let i = 0; i < meshNodes.length; i++) {
    for (let j = i + 1; j < meshNodes.length; j++) {
      drawPairCapsule(ctx, meshNodes[i].center, meshNodes[i].radius, meshNodes[j].center, meshNodes[j].radius, color);
    }
  }
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
  return { id: node.id, center: { x: proj.x, y: proj.y }, radius: node.radius * proj.scale };
}

function render() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  applyDesignSpaceTransform();

  const camPos = getCameraPosition();
  const basis = computeViewBasis(camPos, camera.target);

  // Painter's algorithm: draw back-to-front by z. Lower z = farther
  // away (drawn first, ends up behind); higher z = closer (drawn
  // last, ends up in front). This is still an independent, manually
  // assigned priority for now, separate from true camera depth.
  const sortedMeshes = Object.values(meshes).slice().sort((a, b) => a.z - b.z);

  sortedMeshes.forEach(mesh => {
    const meshNodes = mesh.nodeIds.map(id => projectNode(nodes[id], camPos, basis));
    drawMeshFlat(ctx, meshNodes, mesh.color);
  });
}

// ---------------------------------------------------------
// EXAMPLE SCENE
// ---------------------------------------------------------
// Quadrant 1 (top-left): a node shared between TWO meshes -- a
// "shoulder" node that's part of both a torso mesh and an arm mesh.
// Nothing special has to happen for the sharing to work: a Node is
// just an id that any number of Meshes can reference. The arm is
// given a higher z so it renders IN FRONT of the torso, demonstrating
// z-based rendering priority where the two meshes visibly overlap.
const q1x = DESIGN_WIDTH * 0.25, q1y = DESIGN_HEIGHT * 0.25;
const shoulder = createNode({ x: q1x, y: q1y - 20 }, 35);
const torsoTop = createNode({ x: q1x - 60, y: q1y - 90 }, 30);
const torsoBottom = createNode({ x: q1x - 20, y: q1y + 90 }, 45);
createMesh([shoulder, torsoTop, torsoBottom], '#4fc3f7', 0); // torso, z=0 (behind)
const elbow = createNode({ x: q1x + 40, y: q1y + 70 }, 20); // repositioned to overlap the torso
createMesh([shoulder, elbow], '#ff8a65', 1); // arm, z=1 (in front)

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

// ---------------------------------------------------------
// ANIMATION LOOP: orbit the camera around the center, always looking
// at it, to verify meshes stay round/billboard-like (no pancaking)
// as the viewing angle changes.
// ---------------------------------------------------------
let lastTime = 0;
function loop(timestamp) {
  const dt = (timestamp - lastTime) / 1000;
  lastTime = timestamp;

  camera.orbitAngle += dt * 0.4;

  render();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);