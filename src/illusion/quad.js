// Quads: the plainest 3D shape, { kind: 'quad', pts: [4 world points], fill }. Its four sides are the straight lines between its
// corners' projections, filled in one color. Not a surface: no faces, no front or back, and the corners need not be coplanar (it
// is the screen shape the four 3D lines enclose, as a tube is the screen shape of its outline). Edges move with the camera because
// the corners are 3D points.
//
// SHARED EDGES. Quads whose edges have the same two end points (to 0.01 units) are declared neighbors (`linkEdges`: links =
// [{ edge, to }]). The renderer fills the seam between declared neighbors only (illusionRender.js): an edge is a seam when the two
// quads lie on OPPOSITE sides of it on screen (`seamBetween`); on the same side they overlap there (the far one folds behind the
// near one: a crest's outline), and the edge keeps its antialiasing.
import { line } from './shape.js';

export const quadMid = (o) => o.mid || (o.mid = {
  x: (o.pts[0].x + o.pts[1].x + o.pts[2].x + o.pts[3].x) / 4,
  y: (o.pts[0].y + o.pts[1].y + o.pts[2].y + o.pts[3].y) / 4,
  z: (o.pts[0].z + o.pts[1].z + o.pts[2].z + o.pts[3].z) / 4,
});

// Its screen shape: [{ sides }], side k the line from corner k to k + 1 (tagged `edge`). `proj`: the corners' projections.
export function quadPieces(proj) {
  const sides = proj.map((p, k) => ({ ...line(p, proj[(k + 1) % 4]), ci: k, edge: k }));
  return [{ sides }];
}

// The projected corners when they make a convex quad (for the global mask, cull.js), else null.
export function quadConvex(proj) {
  let sign = 0;
  for (let k = 0; k < 4; k++) {
    const a = proj[k], b = proj[(k + 1) % 4], c = proj[(k + 2) % 4];
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cr) < 1e-9) continue;
    if (sign && Math.sign(cr) !== sign) return null;
    sign = Math.sign(cr);
  }
  return sign ? proj : null;
}

// Whether the edge (p, q) on screen has the two quads' centers (a, b, on screen) on opposite sides.
export function seamBetween(p, q, a, b) {
  const ex = q.x - p.x, ey = q.y - p.y;
  return (ex * (a.y - p.y) - ey * (a.x - p.x)) * (ex * (b.y - p.y) - ey * (b.x - p.x)) < 0;
}

// Links quads and floor patches (patch.js: `edges`, its line pieces' world end points) that share an edge: links = [{ edge, cands,
// p, q }], cands every other shape with that edge (one for a flat list; in a terrain hierarchy (terrain.js) the same edge belongs
// to triangles of several levels, and the one drawn this frame is the neighbor), p and q the edge's world end points.
export function linkEdges(list) {
  const key = (p) => `${Math.round(p.x * 100)},${Math.round(p.y * 100)},${Math.round(p.z * 100)}`;
  const groups = new Map();
  for (const o of list) {
    const edges = o.kind === 'quad' ? o.pts.map((p, k) => [p, o.pts[(k + 1) % 4]]) : o.kind === 'patch' ? o.edges : [];
    edges.forEach((e, edge) => {
      if (!e) return;
      const [p, q] = e, a = key(p), b = key(q), k = a < b ? a + '|' + b : b + '|' + a;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push({ o, edge, p, q });
    });
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    for (const m of g) (m.o.links || (m.o.links = [])).push({ edge: m.edge, p: m.p, q: m.q, cands: g.filter((x) => x.o !== m.o).map((x) => x.o) });
  }
}
