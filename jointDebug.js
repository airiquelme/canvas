// Debug overlay for the 2-to-2 joints (config.js debug.joint): the joint ring
// from jointCurve.js, which splits each joint's colors, in the flat solid the
// joint is computed in (CLAUDE.md "Flat solid"; projecting is dropping z, the
// camera looks along -z). Touch points (magenta), the cones' intersection from
// touch point to touch point (cyan), the plane's circle across the sphere's back
// (green); solid where the ring faces the camera, dashed where it faces away.
// Each cone edge's stop (joint.contacts): a black dot where it touches the ring,
// a hollow one where it ends on the node circle instead. Drawn on top of the frame.
import { facesCamera } from './jointCurve.js';

function dot(ctx, p, r, fill, stroke = '#000000') {
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  ctx.strokeStyle = stroke;
  ctx.lineWidth = fill ? 1 : 2;
  ctx.stroke();
}

// A polyline of curve points ({ p, n }), solid where both ends face the camera.
function strokeCurve(ctx, pts, color, view) {
  const proj = pts.map(q => ({ ...view.projectPoint(q.p), facing: facesCamera(q, view.viewDirAt(q.p)) }));
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

// joints: nodeId -> joint (computeJoints in render.js).
export function drawJointDebug(ctx, joints) {
  ctx.save();
  Object.values(joints).forEach(({ curve, view, contacts, center, radius, phase, frontIsA, meshA, meshB }) => {
    strokeCurve(ctx, curve.front, '#00e5ff', view);
    strokeCurve(ctx, curve.back, '#00c853', view);
    (curve.touch || []).forEach(t => dot(ctx, view.projectPoint(t.p), 5, '#d500f9'));
    contacts.forEach(cone => cone.forEach(e => (e.contact ? dot(ctx, e.contact, 3.5, '#000000', '#ffffff') : dot(ctx, e.near, 3.5, null))));
    ctx.font = '12px monospace';
    ctx.fillStyle = '#000000';
    ctx.fillText(`phase ${phase.toFixed(3)}  front ${(frontIsA ? meshA : meshB).color}`, center.x - radius, center.y + radius + 14);
  });
  ctx.restore();
}
