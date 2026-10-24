import { DESIGN_WIDTH, DESIGN_HEIGHT } from './config.js';
import { makeShape } from './geometry.js';

// Node = { id, center: {x, y, z}, radius, shape }. `radius` is the radius of the
// sphere of equal volume; `shape` (makeShape, geometry.js) is the spheroid: semi-axis
// radius * squash along a unit `axis`, the other two keep the volume.
// Mesh = { id, nodeIds: [id, ...], color }; a node in several meshes is shared.
export const nodes = {};
export const meshes = {};
let nextNodeId = 1;
let nextMeshId = 1;

export function createNode(center, radius, { squash = 1, axis = { x: 0, y: 1, z: 0 }, cut } = {}) {
  const id = nextNodeId++;
  nodes[id] = { id, center: { x: center.x, y: center.y, z: center.z ?? 0 }, radius, shape: makeShape(radius, squash, axis, cut) };
  return id;
}

// `skew`: id of a node that is not in `nodeIds`; the 2-node mesh then bends through it (skew.js).
export function createMesh(nodeIds, color, { skew } = {}) {
  const id = nextMeshId++;
  meshes[id] = { id, nodeIds, color };
  if (skew !== undefined) {
    if (nodeIds.length !== 2) throw new Error('a skewed mesh has exactly 2 nodes');
    meshes[id].skew = skew;
  }
  return id;
}

// Small scene for the skewed meshes (a skew node is only a point the arch passes through), nothing shared (no joints or split cones).
export function buildBasicScene() {
  const cx = DESIGN_WIDTH / 2, cy = DESIGN_HEIGHT / 2;
  const pair = (x0, y0, x1, y1, r0, r1, z0 = 0, z1 = 0) =>
    [createNode({ x: x0, y: y0, z: z0 }, r0), createNode({ x: x1, y: y1, z: z1 }, r1)];
  // A plain straight mesh, for comparison.
  createMesh(pair(cx - 110, cy + 150, cx - 20, cy + 150, 24, 24), '#4fc3f7');
  // Skew above the midpoint (a symmetric arch).
  createMesh(pair(cx - 330, cy + 40, cx - 90, cy + 40, 24, 24), '#ff8a65',
    { skew: createNode({ x: cx - 210, y: cy - 90 }, 6) });
  // Skew off-center and toward the camera's side in z (a sheared, tilted arch).
  // A flat ribbon whose end nodes are thin grains (prolate, squash > 1) instead of discs: the grain's long axis is the arch
  // plane's normal, so each end's "square edge" is the grain itself, W long each way, and it is only T thick both along the
  // arch and across it. With nothing wide along the arch there is no bulge where it bends; the curve is the arch's own.
  // A node keeps its volume: ra = radius * squash = W (the long semi-axis), rp = radius / sqrt(squash) = T, so
  // radius = cbrt(W T^2) and squash = W / radius.
  {
    const A = { x: cx + 20, y: cy + 40, z: 0 }, B = { x: cx + 330, y: cy + 40, z: 0 }, S = { x: cx + 80, y: cy - 110, z: 120 };
    const u = { x: B.x - A.x, y: B.y - A.y, z: B.z - A.z }, s = { x: S.x - (A.x + B.x) / 2, y: S.y - (A.y + B.y) / 2, z: S.z - (A.z + B.z) / 2 };
    const normal = { x: u.y * s.z - u.z * s.y, y: u.z * s.x - u.x * s.z, z: u.x * s.y - u.y * s.x };
    const W = 24 / Math.sqrt(0.3), T = 0.001, radius = Math.cbrt(W * T * T), shape = { squash: W / radius, axis: normal };
    createMesh([createNode(A, radius, shape), createNode(B, radius, shape)], '#a5d6a7', { skew: createNode(S, 6) });
  }
  // Different end radii. Threaded through the orange arch: its plane (x = const) is perpendicular to the
  // orange one, the ends are in front of / behind it (z = -150 / 150) below the orange tube, and the apex
  // passes through the orange arch's opening at z = 0.
  // (Same color as the orange arch it passes through, to show the border strokes.)
  createMesh(pair(cx - 210, cy + 120, cx - 210, cy + 120, 14, 30, -150, 150), '#ff8a65',
    { skew: createNode({ x: cx - 210, y: cy - 10, z: 0 }, 6) });
  // Plain meshes (no skew) for the light engine: a pair and a 3-node triangle (the split cone that was on one of its nodes is left out for now).
  createMesh(pair(cx - 290, cy - 190, cx - 150, cy - 150, 26, 18, 0, 60), '#ffd54f');
  {
    const tri = [createNode({ x: cx - 90, y: cy - 110, z: 0 }, 20), createNode({ x: cx + 30, y: cy - 110, z: 40 }, 22), createNode({ x: cx - 30, y: cy - 190, z: -30 }, 18)];
    createMesh(tri, '#4dd0e1');
  }
  // Oblate (squashed) nodes: flattened ends with tilted axes (the skew node is only a point).
  createMesh([createNode({ x: cx + 40, y: cy + 230, z: -40 }, 26, { squash: 0.45 }),
    createNode({ x: cx + 330, y: cy + 230, z: 40 }, 26, { squash: 0.5, axis: { x: 1, y: 1, z: 0 } })], '#ba68c8',
    { skew: createNode({ x: cx + 185, y: cy + 110 }, 6) });
}

export function buildDemoScene() { buildFullScene(); }

export function buildFullScene() {
  // Left: two 2-node meshes sharing a joint node (a V). The joint node and the blue end are
  // squashed (the general joint ring, jointCurveGeneral.js), and so is the orange end, the
  // orange/yellow joint whose yellow cone is a split cone into the (squashed) pyramid.
  const S = 1.6;
  const cx = DESIGN_WIDTH / 2 - 180, cy = DESIGN_HEIGHT / 2 + 50 * S;
  const jointNode = createNode({ x: cx, y: cy }, 35 * S, { squash: 0.7, axis: { x: 1, y: 1, z: 0 } });
  const blueEnd = createNode({ x: cx - 110 * S, y: cy - 100 * S }, 30 * S, { squash: 1.5, axis: { x: 1, y: 0, z: 0 } });
  createMesh([blueEnd, jointNode], '#4fc3f7');
  const orangeEnd = createNode({ x: cx + 110 * S, y: cy - 100 * S, z: 40 * S }, 25 * S, { squash: 0.8, axis: { x: 1, y: 0, z: 1 } });
  createMesh([jointNode, orangeEnd], '#ff8a65');

  // Right: a 4-node pyramid (triangular base in the x-z plane, apex above)...
  const px = DESIGN_WIDTH / 2 + 210, py = DESIGN_HEIGHT / 2;
  // The pyramid's nodes are squashed too (the host of the split cone, whose shared node is one of them).
  const pyramidShapes = [{ squash: 0.7, axis: { x: 1, y: 1, z: 0 } }, { squash: 1.4 }, { squash: 0.8, axis: { x: 1, y: 0, z: 1 } }];
  const pyrBase = [0, 1, 2].map(i => {
    const a = Math.PI / 2 + i * 2 * Math.PI / 3;
    return createNode({ x: px + 110 * Math.cos(a), y: py + 90, z: 110 * Math.sin(a) }, 30, pyramidShapes[i]);
  });
  const pyrApex = createNode({ x: px, y: py - 110 }, 25, { squash: 0.75 });
  createMesh([...pyrBase, pyrApex], '#a5d6a7');

  // (A purple 2-node mesh on the apex, a second split cone, is left out for now
  // to check the split with one shared mesh:
  // createMesh([pyrApex, createNode({ x: px + 30, y: py - 200, z: -110 }, 22)], '#ce93d8').)

  // A bridge between the closest pair of nodes, one from the pyramid and one
  // from the other 2-node meshes: a joint at its 2-node end, a split cone at
  // the pyramid end.
  const pyramidIds = [...pyrBase, pyrApex];
  const otherIds = [blueEnd, jointNode, orangeEnd];
  const dist = (a, b) => Math.hypot(nodes[a].center.x - nodes[b].center.x, nodes[a].center.y - nodes[b].center.y, nodes[a].center.z - nodes[b].center.z);
  let bridge = null;
  const linked = (a, b) => Object.values(meshes).some(m => m.nodeIds.includes(a) && m.nodeIds.includes(b));
  otherIds.forEach(o => pyramidIds.forEach(p => {
    if (!linked(o, p) && (!bridge || dist(o, p) < bridge.d)) bridge = { o, p, d: dist(o, p) };
  }));
  createMesh([bridge.o, bridge.p], '#fff176');

  // Squashed nodes (static) in plain meshes. They sit in the free bands above and below the
  // other figures, inside the view (about x 206-794, y 165-635 around the camera target).
  // A figure is its squashed node plus `more` nodes (offsets from it, so a mesh of 2 or 3
  // nodes). Bottom row: a sphere (control), a ball flattened along world y, a flatter one with
  // two more nodes (a bounce), one flattened along a tilted axis with two more. Top row:
  // stretched along y with two more, a stretched-along-x node meshed with a second squashed
  // node and a sphere, and a pair stretched along z (end-on from some angles).
  const squashed = (x, y, r, shape, color, more = [{ dx: 60, dy: 0 }]) => {
    const ids = [createNode({ x, y }, r, shape)];
    more.forEach(m => ids.push(createNode({ x: x + m.dx, y: y + m.dy, z: m.dz ?? 0 }, m.r ?? 11, m.shape)));
    createMesh(ids, color);
  };
  squashed(520, 225, 26, { squash: 0.35 }, '#f06292', [{ dx: 60, dy: 0 }, { dx: 30, dy: -38, dz: 45 }]);
  squashed(645, 225, 26, { squash: 0.45, axis: { x: 1, y: 1, z: 0 } }, '#ba68c8', [{ dx: 60, dy: 5 }, { dx: 25, dy: 40, dz: -45 }]);
  // Small V joints (two 2-node meshes sharing a node) with squashed nodes, in view: the joint
  // node squashed, only the arm ends squashed, and all three squashed (the general joint ring).
  // The arms are off the plane in z so the ring changes as the camera orbits.
  const vee = (x, y, colorA, colorB, joint, armA = {}, armB = {}) => {
    const j = createNode({ x, y }, 20, joint);
    const a = createNode({ x: x - 52, y: y - 30, z: 25 }, 14, armA);
    const b = createNode({ x: x + 52, y: y - 30, z: -25 }, 13, armB);
    createMesh([a, j], colorA);
    createMesh([j, b], colorB);
  };
  vee(268, 225, '#e57373', '#4dd0e1', { squash: 0.5 });
  vee(388, 225, '#9575cd', '#aed581', {}, { squash: 0.5, axis: { x: 1, y: 1, z: 0 } }, { squash: 1.7, axis: { x: 1, y: 0, z: 0 } });
  vee(690, 575, '#a1887f', '#80cbc4', { squash: 0.35, axis: { x: 1, y: 1, z: 0 } }, { squash: 1.6, axis: { x: 0, y: 1, z: 0 } }, { squash: 0.6 });
  squashed(270, 575, 20, { squash: 1.8 }, '#ffb74d', [{ dx: 60, dy: 0 }, { dx: 30, dy: -42, dz: 45 }]);
  squashed(395, 575, 20, { squash: 1.8, axis: { x: 1, y: 0, z: 0 } }, '#81c784',
    [{ dx: 75, dy: 0, r: 18, shape: { squash: 0.5, axis: { x: 0, y: 1, z: 1 } } }, { dx: 35, dy: 35, dz: 40 }]);
  squashed(520, 575, 20, { squash: 1.8, axis: { x: 0, y: 0, z: 1 } }, '#64b5f6');

  // The split-cone figure, for the debug view to center on.
  return [...pyrBase, pyrApex];
}
