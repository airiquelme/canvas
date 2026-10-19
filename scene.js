import { DESIGN_WIDTH, DESIGN_HEIGHT } from './config.js';

// Node = { id, center: {x, y, z}, radius }
// Mesh = { id, nodeIds: [id, ...], color }; a node in several meshes is shared.
export const nodes = {};
export const meshes = {};
let nextNodeId = 1;
let nextMeshId = 1;

export function createNode(center, radius) {
  const id = nextNodeId++;
  nodes[id] = { id, center: { x: center.x, y: center.y, z: center.z ?? 0 }, radius };
  return id;
}

export function createMesh(nodeIds, color) {
  const id = nextMeshId++;
  meshes[id] = { id, nodeIds, color };
  return id;
}

export function buildDemoScene() {
  // Left: two 2-node meshes sharing a joint node (a V).
  const S = 1.6;
  const cx = DESIGN_WIDTH / 2 - 180, cy = DESIGN_HEIGHT / 2 + 50 * S;
  const jointNode = createNode({ x: cx, y: cy }, 35 * S);
  const blueEnd = createNode({ x: cx - 110 * S, y: cy - 100 * S }, 30 * S);
  createMesh([blueEnd, jointNode], '#4fc3f7');
  const orangeEnd = createNode({ x: cx + 110 * S, y: cy - 100 * S, z: 40 * S }, 25 * S);
  createMesh([jointNode, orangeEnd], '#ff8a65');

  // Right: a 4-node pyramid (triangular base in the x-z plane, apex above)...
  const px = DESIGN_WIDTH / 2 + 210, py = DESIGN_HEIGHT / 2;
  const pyrBase = [0, 1, 2].map(i => {
    const a = Math.PI / 2 + i * 2 * Math.PI / 3;
    return createNode({ x: px + 110 * Math.cos(a), y: py + 90, z: 110 * Math.sin(a) }, 30);
  });
  const pyrApex = createNode({ x: px, y: py - 110 }, 25);
  createMesh([...pyrBase, pyrApex], '#a5d6a7');

  // ...and a 2-node mesh sharing its apex (split cone).
  const purpleEnd = createNode({ x: px + 30, y: py - 200, z: -110 }, 22);
  createMesh([pyrApex, purpleEnd], '#ce93d8');
}
