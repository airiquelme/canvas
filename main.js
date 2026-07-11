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

function drawMeshFlat(ctx, meshNodes, color, sharedNodeIds = new Set()) {
  ctx.save();

  // HULL FILL TEMPORARILY DISABLED -- verifying circles + capsules alone cover the shape
  // traceMeshPath(ctx, meshNodes);
  // ctx.fillStyle = color;
  // ctx.fill();

  // Hull circles -- skip shared nodes entirely, never attempt to render them.
  const hull = meshNodes.length === 1 ? [0] : convexHullIndices(meshNodes.map(n => n.center));
  hull.forEach(idx => {
    const node = meshNodes[idx];
    if (sharedNodeIds.has(node.id)) return;
    ctx.beginPath();
    ctx.arc(node.center.x, node.center.y, node.radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  });

  // Pair capsules -- skip the end-cap arc at any shared-node end.
  for (let i = 0; i < meshNodes.length; i++) {
    for (let j = i + 1; j < meshNodes.length; j++) {
      const skip1 = sharedNodeIds.has(meshNodes[i].id);
      const skip2 = sharedNodeIds.has(meshNodes[j].id);
      drawPairCapsule(ctx, meshNodes[i].center, meshNodes[i].radius, meshNodes[j].center, meshNodes[j].radius, color, skip1, skip2);
    }
  }

  ctx.restore();
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
// A node shared by exactly two meshes renders as a circle split
// between the two meshes' colors, "phases of the moon" style. The
// split is derived from real 3D geometry:
//  - Each mesh's "approach direction" at the node = from the node
//    toward the centroid of the mesh's OTHER nodes (in camera space).
//    Convexity guarantees the centroid is interior, so this is always
//    a meaningful "toward that mesh's body" direction.
//  - The joint axis (difference of the two approach directions) gives
//    the terminator's screen azimuth from its projected part, and the
//    phase from its component along the viewing direction -- same
//    role the light direction played in classic moon-phase shading.
// Meaning: if the joint were a real sphere between two 3D tubes, the
// tube leaning toward the camera would genuinely wrap more of it.

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

  // Project all nodes once
  const projectedNodes = {};
  Object.values(nodes).forEach(node => {
    projectedNodes[node.id] = projectNode(node, camPos, basis);
  });

  // Build a flat list of primitives, each with its own depth key.
  // - circle: depth = node's own depth
  // - capsule: depth = max of its two endpoints' depths
  // Shared nodes are skipped here and rendered separately after.
  const primitives = [];

  Object.values(meshes).forEach(mesh => {
    const pNodes = mesh.nodeIds.map(id => projectedNodes[id]);

    // Node circles (skip shared nodes)
    const hull = pNodes.length === 1 ? [0] : convexHullIndices(pNodes.map(n => n.center));
    hull.forEach(idx => {
      const pn = pNodes[idx];
      if (sharedNodeIds.has(pn.id)) return;
      const color = mesh.color;
      primitives.push({
        depth: pn.depth,
        ownerMeshId: mesh.id,
        draw: () => {
          ctx.beginPath();
          ctx.arc(pn.center.x, pn.center.y, pn.radius, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
        }
      });
    });

    // Pair capsules (skip end caps at shared nodes)
    for (let i = 0; i < pNodes.length; i++) {
      for (let j = i + 1; j < pNodes.length; j++) {
        const a = pNodes[i], b = pNodes[j];
        const depth = Math.max(a.depth, b.depth);
        const skip1 = sharedNodeIds.has(a.id);
        const skip2 = sharedNodeIds.has(b.id);
        const color = mesh.color;
        primitives.push({
          depth,
          ownerMeshId: mesh.id,
          draw: () => drawPairCapsule(ctx, a.center, a.radius, b.center, b.radius, color, skip1, skip2)
        });
      }
    }
  });

  // Shared nodes: inserted into the primitives list at the right depth
  // so non-owner meshes that are nearer to the camera still draw over
  // them correctly. Depth key = min depth among all owner primitives
  // (i.e. just after the frontmost owner, but before nearer non-owners).
  Object.keys(owners).forEach(nodeIdStr => {
    if (owners[nodeIdStr].length < 2) return;
    const nodeId = Number(nodeIdStr);
    const p = projectedNodes[nodeId];
    const ownerIds = owners[nodeId];

    // The shared node's depth key is simply its own projected depth,
    // so it sorts naturally among all other primitives. A small tie-
    // break offset ensures it draws just after (on top of) any owner
    // primitive at the exact same depth.
    const sharedDepth = p.depth - 0.001;

    if (ownerIds.length !== 2) {
      primitives.push({
        depth: sharedDepth,
        draw: () => {
          ctx.beginPath();
          ctx.arc(p.center.x, p.center.y, p.radius, 0, Math.PI * 2);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
        }
      });
      return;
    }

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
    const separatorColor = meshA.id < meshB.id ? meshA.color : meshB.color;
    const center = p.center, radius = p.radius;
    primitives.push({
      depth: sharedDepth,
      draw: () => drawJointSplitCircle(ctx, center, radius, azimuth, phase, meshA.color, meshB.color, separatorColor)
    });
  });

  // Sort all primitives back-to-front and draw
  primitives.sort((a, b) => b.depth - a.depth);
  primitives.forEach(p => p.draw());

  // Black outlines on every node, drawn last so they're always on top.
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 2;
  Object.values(nodes).forEach(node => {
    const p = projectedNodes[node.id];
    ctx.beginPath();
    ctx.arc(p.center.x, p.center.y, p.radius, 0, Math.PI * 2);
    ctx.stroke();
  });

  // Red dots at intersections between pivot lines of different meshes
  // sharing the same pivot. For each pivot, for each pair of meshes
  // (A, B), for each other node in A and each other node in B, find
  // where the t1/t2 edge of A's capsule meets the t2/t1 edge of B's
  // capsule at the pivot.
  function tangentLineAtPivot(pivotCenter, pivotRadius, angle) {
    const pt = { x: pivotCenter.x + pivotRadius * Math.cos(angle), y: pivotCenter.y + pivotRadius * Math.sin(angle) };
    const dir = { x: -Math.sin(angle), y: Math.cos(angle) };
    return { pt, dir };
  }
  function lineIntersect2D(p1, d1, p2, d2) {
    const denom = d1.x * d2.y - d1.y * d2.x;
    if (Math.abs(denom) < 1e-9) return null;
    const t = ((p2.x - p1.x) * d2.y - (p2.y - p1.y) * d2.x) / denom;
    return { x: p1.x + t * d1.x, y: p1.y + t * d1.y };
  }

  Object.keys(owners).forEach(nodeIdStr => {
    if (owners[nodeIdStr].length < 2) return;
    const pivotId = Number(nodeIdStr);
    const pivotProj = projectedNodes[pivotId];
    const ownerIds = owners[pivotId];

    // For each pair of owner meshes
    for (let mi = 0; mi < ownerIds.length; mi++) {
      for (let mj = mi + 1; mj < ownerIds.length; mj++) {
        const meshA = meshes[ownerIds[mi]], meshB = meshes[ownerIds[mj]];

        // Other nodes in each mesh connected to the pivot
        const othersA = meshA.nodeIds.filter(id => id !== pivotId);
        const othersB = meshB.nodeIds.filter(id => id !== pivotId);

        othersA.forEach(idA => {
          const pA = projectedNodes[idA];
          const tanA = computePairTangents(pivotProj.center, pivotProj.radius, pA.center, pA.radius);

          othersB.forEach(idB => {
            const pB = projectedNodes[idB];
            const tanB = computePairTangents(pivotProj.center, pivotProj.radius, pB.center, pB.radius);

            // The two near intersections: t1(A)×t2(B) and t2(A)×t1(B)
            [
              [tanA.t1Angle, tanB.t2Angle],
              [tanA.t2Angle, tanB.t1Angle],
            ].forEach(([angleA, angleB]) => {
              const lineA = tangentLineAtPivot(pivotProj.center, pivotProj.radius, angleA);
              const lineB = tangentLineAtPivot(pivotProj.center, pivotProj.radius, angleB);
              const pt = lineIntersect2D(lineA.pt, lineA.dir, lineB.pt, lineB.dir);
              if (!pt) return;
              ctx.fillStyle = '#ff0000';
              ctx.beginPath();
              ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
              ctx.fill();
            });
          });
        });
      }
    }
  });
}

// ---------------------------------------------------------
// EXAMPLE SCENE
// ---------------------------------------------------------
// Quadrant 1 (top-left): the MINIMAL shared-node case -- two 2-node
// meshes (two "lines") sharing the middle node, forming an elbow.
// The simplest possible configuration for verifying the joint split.
const q1x = DESIGN_WIDTH * 0.25, q1y = DESIGN_HEIGHT * 0.25;
const jointNode = createNode({ x: q1x, y: q1y }, 35);
const blueEnd = createNode({ x: q1x - 110, y: q1y - 80 }, 30);
createMesh([blueEnd, jointNode], '#4fc3f7'); // blue line
const orangeEnd = createNode({ x: q1x + 110, y: q1y + 80, z: 40 }, 25);
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

// A new green mesh sharing d1 with the purple mesh above -- tests
// how a node with multiple edges within one mesh handles sharing.
// d1 is the purple node closest to the orange blob (top-left).
const e1 = createNode({ x: q4x - 260, y: q4y + 60 }, 30);
const e2 = createNode({ x: q4x - 200, y: q4y + 180 }, 25);
createMesh([d1, e1, e2], '#a5d6a7');

// ---------------------------------------------------------
// ANIMATION LOOP: orbit the camera around the center, always looking
// at it, to verify meshes stay round/billboard-like (no pancaking)
// as the viewing angle changes.
// ---------------------------------------------------------
// White background
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