import { DESIGN_WIDTH, DESIGN_HEIGHT } from './config.js';
import { makeShape } from './geometry.js';
import { rig, shells } from './shell.js';

// Node = { id, center: {x, y, z}, radius, shape }. `radius` is the radius of the
// sphere of equal volume; `shape` (makeShape, geometry.js) is the spheroid: semi-axis
// radius * squash along a unit `axis`, the other two keep the volume.
// Mesh = { id, nodeIds: [id, ...], color }; a node in several meshes is shared.
export const nodes = {};
export const meshes = {};
let nextNodeId = 1;
let nextMeshId = 1;

// `squash` (and `axis`, which only an arch end keeps) is what the node asks for; finalizeShapes settles it once the meshes
// are made.
export function createNode(center, radius, { squash = 1, axis = { x: 0, y: 1, z: 0 }, cut } = {}) {
  const id = nextNodeId++;
  nodes[id] = { id, center: { x: center.x, y: center.y, z: center.z ?? 0 }, radius, shape: makeShape(radius, squash, axis, cut), spec: { squash, axis, cut } };
  return id;
}

// The rules for squashed nodes (CLAUDE.md "Squashed nodes"), applied once the meshes exist:
//  - the free end of a plain 2-node mesh squashes along the axis to its partner (`shape.axial`): the hull of two bodies of
//    revolution about the same axis is a circular cone, so every closed form of the round cones holds (splitRing.js
//    coaxialCone);
//  - an arch end (a skewed mesh's node) keeps its own axis: an arch is a sweep, each row a plane slice of an ellipsoid;
//  - a node in several meshes, or in a 3+ node mesh, is made round: it can't be symmetric about every cone's axis.
export function finalizeShapes() {
  const all = Object.values(meshes);
  Object.values(nodes).forEach(n => {
    const spec = n.spec;
    if (!spec || spec.squash === 1) return;
    const own = all.filter(m => m.nodeIds.includes(n.id));
    if (!own.length) return;                                  // a skew node (only a point) or unused
    if (own.length === 1 && own[0].skew !== undefined) return;
    if (own.length === 1 && own[0].nodeIds.length === 2) {
      const o = nodes[own[0].nodeIds.find(id => id !== n.id)].center, c = n.center;
      n.shape = { ...makeShape(n.radius, spec.squash, { x: o.x - c.x, y: o.y - c.y, z: o.z - c.z }, spec.cut), axial: true };
      return;
    }
    console.warn(`node ${n.id}: squashed but shared or in a 3+ node mesh, made round`);
    n.shape = makeShape(n.radius, 1, spec.axis, spec.cut);
  });
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
  finalizeShapes();
}

export function buildDemoScene() { buildFullScene(); }

export function buildFullScene() {
  // Left: two 2-node meshes sharing a joint node (a V). Shared nodes are round (finalizeShapes); the blue end is free,
  // stretched along its cone's axis (a circular cone, so the joint ring is the closed form). The orange end is the
  // orange/yellow joint whose yellow cone is a split cone into the pyramid.
  const S = 1.6;
  const cx = DESIGN_WIDTH / 2 - 180, cy = DESIGN_HEIGHT / 2 + 50 * S;
  const jointNode = createNode({ x: cx, y: cy }, 35 * S);
  const blueEnd = createNode({ x: cx - 110 * S, y: cy - 100 * S }, 30 * S, { squash: 1.5 });
  createMesh([blueEnd, jointNode], '#4fc3f7');
  const orangeEnd = createNode({ x: cx + 110 * S, y: cy - 100 * S, z: 40 * S }, 25 * S);
  createMesh([jointNode, orangeEnd], '#ff8a65');

  // Right: a 4-node pyramid (triangular base in the x-z plane, apex above)...
  const px = DESIGN_WIDTH / 2 + 210, py = DESIGN_HEIGHT / 2;
  // (Its nodes are in a 3+ node mesh, so they are round.)
  const pyrBase = [0, 1, 2].map(i => {
    const a = Math.PI / 2 + i * 2 * Math.PI / 3;
    return createNode({ x: px + 110 * Math.cos(a), y: py + 90, z: 110 * Math.sin(a) }, 30);
  });
  const pyrApex = createNode({ x: px, y: py - 110 }, 25);
  createMesh([...pyrBase, pyrApex], '#a5d6a7');

  // A second split cone, on the apex, whose free far end is flattened along the cone's axis (a coin facing along it).
  createMesh([pyrApex, createNode({ x: px + 30, y: py - 200, z: -110 }, 22, { squash: 0.5 })], '#ce93d8');

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
  // A squashed node squashes along the axis to its one partner (finalizeShapes), so each figure is a 2-node mesh:
  // the squashed node and a partner (round, or squashed too). squash < 1 flattens it into a coin facing along the
  // cone, > 1 stretches it along the cone. The partners are off the plane in z so the shapes turn as the camera orbits.
  const pair2 = (x, y, r, squash, color, m) => {
    createMesh([createNode({ x, y }, r, { squash }), createNode({ x: x + m.dx, y: y + m.dy, z: m.dz ?? 0 }, m.r ?? 11, { squash: m.squash ?? 1 })], color);
  };
  pair2(520, 225, 26, 0.35, '#f06292', { dx: 60, dy: -10, dz: 45 });
  pair2(645, 225, 26, 0.45, '#ba68c8', { dx: 60, dy: 25, dz: -45 });
  // Small V joints (two 2-node meshes sharing a node; the joint node is round), with squashed arm ends.
  // The arms are off the plane in z so the ring changes as the camera orbits.
  const vee = (x, y, colorA, colorB, armA = {}, armB = {}) => {
    const j = createNode({ x, y }, 20);
    const a = createNode({ x: x - 52, y: y - 30, z: 25 }, 14, armA);
    const b = createNode({ x: x + 52, y: y - 30, z: -25 }, 13, armB);
    createMesh([a, j], colorA);
    createMesh([j, b], colorB);
  };
  vee(268, 225, '#e57373', '#4dd0e1', { squash: 0.5 });
  vee(388, 225, '#9575cd', '#aed581', { squash: 0.5 }, { squash: 1.7 });
  vee(690, 575, '#a1887f', '#80cbc4', { squash: 1.6 }, { squash: 0.6 });
  pair2(270, 575, 20, 1.8, '#ffb74d', { dx: 60, dy: -20, dz: 45 });
  pair2(395, 575, 20, 1.8, '#81c784', { dx: 75, dy: 0, r: 18, squash: 0.5 });
  pair2(520, 575, 20, 1.8, '#64b5f6', { dx: 60, dy: 0, dz: -60 });
  finalizeShapes();

  // The split-cone figure, for the debug view to center on.
  return [...pyrBase, pyrApex];
}

// The shells scene (CLAUDE.md "Shells", "Rigs"): a hand, a `rig` of balls (joints) and bones (one shell each, with a joint at each end). The
// wrist ball has the forearm and a metacarpal to each knuckle; each finger runs knuckle, two joints and a tip ball. The hand lies in the
// (y, z) plane with the palm facing +x (the camera at angle 0); the fingers curl toward the palm. Every number is in the table.
export function buildShellScene() {
  const cx = DESIGN_WIDTH / 2, cy = DESIGN_HEIGHT / 2, SKIN = '#e8b48a', rad = Math.PI / 180;
  const u = { x: 0, y: 1, z: 0 }, l = { x: 0, y: 0, z: 1 }, n = { x: 1, y: 0, z: 0 };   // along the hand, across it, out of the palm
  const lin = (...terms) => terms.reduce((a, [v, k]) => ({ x: a.x + v.x * k, y: a.y + v.y * k, z: a.z + v.z * k }), { x: 0, y: 0, z: 0 });
  const wrist = { x: cx, y: cy - 20, z: 0 };
  // phi: the metacarpal's angle across the hand, tilt: out of the palm plane (the thumb), mLen: wrist to knuckle, r: the joints' radius,
  // tip: the tip ball's size against r (default 0.8), segs: the phalanges, bend: each one's angle toward the palm (cumulative, degrees). A bone is 1.15 times thicker than its joints.
  const fingers = [
    { name: 'index', phi: -14, tilt: 0, mLen: 58, r: 6, segs: [22, 14, 11], bend: [12, 20, 16] },
    { name: 'middle', phi: 0, tilt: 0, mLen: 62, r: 6.5, segs: [25, 16, 12], bend: [14, 24, 18] },
    { name: 'ring', phi: 11, tilt: 0, mLen: 58, r: 6, segs: [22, 15, 11], bend: [16, 26, 20] },
    { name: 'pinky', phi: 24, tilt: 0, mLen: 50, r: 6.4, segs: [18, 11, 10], bend: [18, 28, 22] },
    { name: 'thumb', phi: -48, tilt: 28, mLen: 30, r: 7.5, tip: 0.7, segs: [17, 13], bend: [10, 18] },
  ];
  const metaDir = (f) => {
    const m0 = lin([u, Math.cos(f.phi * rad)], [l, Math.sin(f.phi * rad)]);
    return lin([m0, Math.cos(f.tilt * rad)], [n, Math.sin(f.tilt * rad)]);
  };
  const balls = [{ center: wrist, radius: 13 }, { center: lin([wrist, 1], [u, -100]), radius: 11 }];
  const bones = [{ a: 1, b: 0, radius: 19 }];   // the forearm
  const knuckles = [];
  for (const f of fingers) {
    const m = metaDir(f);
    let theta = 0, p = lin([wrist, 1], [m, f.mLen]), prev = 0;
    knuckles.push(balls.length);
    balls.push({ center: p, radius: f.r });
    f.boneIdx = [bones.length];
    bones.push({ a: 0, b: balls.length - 1, radius: 13.1 });   // the metacarpal: barely thicker than the wrist ball, so the ball sits almost at the bone's center
    prev = balls.length - 1;
    f.segs.forEach((L, j) => {
      theta += f.bend[j];
      p = lin([p, 1], [m, L * Math.cos(theta * rad)], [n, L * Math.sin(theta * rad)]);
      const last = j === f.segs.length - 1;
      balls.push({ center: p, radius: last ? f.r * (f.tip ?? 0.8) : f.r });
      // Every phalanx is barely thicker than its balls: its first joint sits almost at the bone's center, and the spheroid is much longer than the
      // part drawn (the tangent planes cut it).
      f.boneIdx.push(bones.length);
      bones.push({ a: prev, b: balls.length - 1, radius: f.r + 0.1 });
      prev = balls.length - 1;
    });
  }
  const made = rig({ balls, bones, color: SKIN });
  knuckles.forEach(i => { shells[made.balls[i]].ring = '#ff9800'; });   // the Debug view circles the knuckle joints
}
