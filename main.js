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
  nodes[id] = { id, center, radius };
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

function render() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  applyDesignSpaceTransform();

  Object.values(meshes).forEach(mesh => {
    const meshNodes = mesh.nodeIds.map(id => nodes[id]);
    drawMeshFlat(ctx, meshNodes, mesh.color);
  });
}

// ---------------------------------------------------------
// EXAMPLE SCENE
// ---------------------------------------------------------
// Quadrant 1 (top-left): a node shared between TWO meshes -- a
// "shoulder" node that's part of both a torso mesh and an arm mesh.
// Nothing special has to happen for this to work: a Node is just an
// id that any number of Meshes can reference.
const q1x = DESIGN_WIDTH * 0.25, q1y = DESIGN_HEIGHT * 0.25;
const shoulder = createNode({ x: q1x, y: q1y - 20 }, 35);
const torsoTop = createNode({ x: q1x - 60, y: q1y - 90 }, 30);
const torsoBottom = createNode({ x: q1x - 20, y: q1y + 90 }, 45);
createMesh([shoulder, torsoTop, torsoBottom], '#4fc3f7'); // torso, uses shoulder
const elbow = createNode({ x: q1x + 110, y: q1y + 40 }, 20);
createMesh([shoulder, elbow], '#ff8a65'); // arm, ALSO uses shoulder

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
// arrangement -- a bigger, more organic-looking blob
const q4x = DESIGN_WIDTH * 0.75, q4y = DESIGN_HEIGHT * 0.75;
const d1 = createNode({ x: q4x - 150, y: q4y - 60 }, 40);
const d2 = createNode({ x: q4x - 60, y: q4y - 130 }, 55);
const d3 = createNode({ x: q4x + 90, y: q4y - 100 }, 30);
const d4 = createNode({ x: q4x + 150, y: q4y + 40 }, 45);
const d5 = createNode({ x: q4x + 30, y: q4y + 140 }, 35);
const d6 = createNode({ x: q4x - 110, y: q4y + 90 }, 25);
createMesh([d1, d2, d3, d4, d5, d6], '#ce93d8');

render();