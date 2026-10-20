// Debug overlay for the moon-phase joints (config.js debug.joint): the joint
// ring from jointCurve.js, which is what splits each joint's colors. Touch
// points (magenta), the cones' intersection curve (cyan) and the circle across
// the sphere's back (green), all in one plane through the node's center. Solid
// where a curve faces the camera, dashed where it faces away. Drawn on top of
// the frame.
import { facesCamera } from './jointCurve.js';

function dot(ctx, p, r, fill, stroke = '#000000') {
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  ctx.stroke();
}

// A polyline of curve points ({ p, n }), solid where both ends face the camera.
function strokeCurve(ctx, pts, color, { camPos, projectPoint }) {
  const proj = pts.map(q => ({ ...projectPoint(q.p), facing: facesCamera(q, camPos) }));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  for (let i = 0; i + 1 < proj.length; i++) {
    ctx.setLineDash(proj[i].facing && proj[i + 1].facing ? [] : [3, 4]);
    ctx.beginPath();
    ctx.moveTo(proj[i].x, proj[i].y);
    ctx.lineTo(proj[i + 1].x, proj[i + 1].y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

// joints: nodeId -> joint (computeJoints); view: { camPos, projectPoint }.
export function drawJointDebug(ctx, joints, view) {
  ctx.save();
  Object.values(joints).forEach(({ curve, center, radius, phase }) => {
    strokeCurve(ctx, curve.front, '#00e5ff', view);
    strokeCurve(ctx, curve.back, '#00c853', view);
    (curve.touch || []).forEach(t => dot(ctx, view.projectPoint(t.p), 5, '#d500f9'));
    ctx.font = '12px monospace';
    ctx.fillStyle = '#00c853';
    ctx.fillText(`phase ${phase.toFixed(3)}`, center.x - radius, center.y + radius + 14);
  });
  ctx.restore();
}
