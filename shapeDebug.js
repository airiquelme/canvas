// Debug overlay for squashed nodes (config.js debug.shape), drawn on top of the frame:
// - dashed purple: the node's silhouette on the screen (projectNode's `ellipse`), the
//   shape the drawing code uses; it never collapses;
// - solid orange: the spheroid's cut (projectNode's `cut`), the fixed 3D meridian ellipse
//   through both poles, with its two diameters: the squash axis (2 ra) and the full
//   diameter across it (2 rp). It flattens and collapses to a line when the camera sees
//   its plane edge-on.
import { nodes } from './scene.js';

export function drawShapeDebug(ctx, projected) {
  ctx.save();
  ctx.lineWidth = 1.5;
  Object.values(nodes).forEach(node => {
    if (node.shape.isSphere) return;
    const { center, ellipse: e, cut } = projected[node.id];
    ctx.strokeStyle = '#d500f9';
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.ellipse(center.x, center.y, Math.max(e.a, 0.01), Math.max(e.b, 0.01), e.angle, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
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
