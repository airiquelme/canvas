// Debug overlay for nodes (config.js debug.shape), drawn on top of the frame:
// - dotted: every node's silhouette on the screen (projectNode's `ellipse`), the shape the drawing
//   code uses; it never collapses. Purple for squashed nodes, gray for round ones;
// - a skew node (a mesh's `skew`, skew.js) is only a point, so instead of its own outline it shows, dotted teal, the body's
//   cross-section at that point of the arch (the cut perpendicular to the arch, from `sectionAt`) and a dot at the center;
// - solid orange: the spheroid's cut (projectNode's `cut`), the fixed 3D meridian ellipse
//   through both poles, with its two diameters: the squash axis (2 ra) and the full
//   diameter across it (2 rp). It flattens and collapses to a line when the camera sees
//   its plane edge-on.
import { nodes, meshes } from './scene.js';
import { sectionAt } from './skew.js';

export function drawShapeDebug(ctx, projected, projectPoint) {
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  const skewMesh = {};
  Object.values(meshes).forEach(m => { if (m.skew) skewMesh[m.skew] = m; });
  Object.values(nodes).forEach(node => {
    const { center, ellipse: e, cut } = projected[node.id];
    const mesh = skewMesh[node.id], section = mesh && sectionAt(nodes[mesh.nodeIds[0]], nodes[mesh.nodeIds[1]], node, 0.5);
    if (section) {
      ctx.strokeStyle = ctx.fillStyle = '#00897b';
      ctx.setLineDash([0.1, 4]);
      ctx.beginPath();
      section.forEach((q, i) => { const p = projectPoint(q); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); });
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(center.x, center.y, 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.strokeStyle = mesh ? '#00897b' : (node.shape.isSphere ? '#616161' : '#d500f9');
    ctx.setLineDash([0.1, 4]);
    ctx.beginPath();
    ctx.ellipse(center.x, center.y, Math.max(e.a, 0.01), Math.max(e.b, 0.01), e.angle, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    if (node.shape.isSphere) return;
    ctx.strokeStyle = '#ff6d00';
    ctx.beginPath();
    ctx.ellipse(center.x, center.y, cut.a, cut.b, cut.angle, 0, Math.PI * 2);
    [cut.A, cut.B].forEach(v => {
      ctx.moveTo(center.x - v.x, center.y - v.y);
      ctx.lineTo(center.x + v.x, center.y + v.y);
    });
    ctx.stroke();
  });
  ctx.restore();
}
