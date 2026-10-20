// Debug overlay for the moon-phase joints (config.js debug.joint): the
// terminator ellipse, and for each seam at the joint the crossing, the
// tangent point and the seam line out to the rim; plus the real 3D split from
// jointCurve.js: touch points (magenta), the cones' intersection curve (cyan)
// and the circle across the sphere's back (green), all in one plane through the
// node's center. Solid where a curve
// faces the camera, dashed where it faces away. Drawn on top of the frame.
import { facesCamera } from './jointCurve.js';

const SEAM_COLORS = ['#ff1744', '#ff9100'];

function dot(ctx, p, r, fill, stroke = '#000000') {
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1;
  ctx.stroke();
}

// joints: nodeId -> joint (computeJoints); seams: the seams found at joints
// (frame.trimSources); seamLine: render.js's, so this shows what the cut and
// the trim really use.
export function drawJointDebug(ctx, joints, seams, seamLine, view) {
  ctx.save();
  ctx.setLineDash([]);
  Object.entries(joints).forEach(([key, joint]) => {
    const { center, radius, azimuth, phase } = joint;

    // The terminator: the boundary between the dominant side and the crescent.
    ctx.save();
    ctx.translate(center.x, center.y);
    ctx.rotate(azimuth);
    ctx.strokeStyle = '#0091ea';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.ellipse(0, 0, Math.max(Math.abs(phase) * radius, 0.5), radius, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    ctx.font = '12px monospace';
    ctx.fillStyle = '#0091ea';
    ctx.fillText(`phase ${phase.toFixed(3)}`, center.x - radius, center.y + radius + 14);

    if (joint.curve) drawJointCurve(ctx, joint.curve, view);

    seams.filter(s => s.pivotId === Number(key)).forEach((seam, i) => {
      const color = SEAM_COLORS[i % SEAM_COLORS.length];
      const line = seamLine(joint, seam.crossing);
      ctx.setLineDash([]);
      if (!line) {
        // No usable tangent: the cut and the trim are dropped for this seam.
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        const c = seam.crossing;
        ctx.beginPath();
        ctx.moveTo(c.x - 6, c.y - 6); ctx.lineTo(c.x + 6, c.y + 6);
        ctx.moveTo(c.x + 6, c.y - 6); ctx.lineTo(c.x - 6, c.y + 6);
        ctx.stroke();
        return;
      }
      // Crossing -> tangent point -> where the line leaves the rim.
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(seam.crossing.x, seam.crossing.y);
      ctx.lineTo(line.tangentPoint.x, line.tangentPoint.y);
      ctx.lineTo(line.rimHit.x, line.rimHit.y);
      ctx.stroke();
      dot(ctx, seam.crossing, 4, '#ffffff');            // crossing
      dot(ctx, line.tangentPoint, 4, '#ffea00');        // tangent point
      dot(ctx, line.rimHit, 3, color);                  // rim hit
      dot(ctx, seam.tangentRim, 3, '#00e676');          // the capsule edge's own rim point
    });
  });
  ctx.restore();
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

function drawJointCurve(ctx, curve, view) {
  strokeCurve(ctx, curve.front, '#00e5ff', view);
  strokeCurve(ctx, curve.back, '#00c853', view);
  (curve.touch || []).forEach(t => dot(ctx, view.projectPoint(t.p), 5, '#d500f9'));
}
