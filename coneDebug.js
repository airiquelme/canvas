// Debug overlay: where a split cone's surface meets its host mesh, in 3D,
// projected. Drawn on top of the frame; buried parts dotted, far side dashed.
import { bisectRoot, hullPlanes, insideHull, vecSub, vecDot } from './geometry.js';
import { nodes } from './scene.js';
import { tangentCone, coneSurface, hostElements, findSplitRing, findLastContact } from './splitRing.js';

const ANGLES = 96, STEPS = 48;
const COLORS = { sphere: '#ec407a', ring: '#ffb300', last: '#76ff03' };

// Is p buried in the host mesh: inside any element other than `skip` (the
// one the curve lies on), or inside the hull of the node centers (the faces).
const EPS = 1e-3;
function isBuried(p, els, skip, planes) {
  return els.some(el => !el.flat && el !== skip && el.sdf(p) < -EPS) || insideHull(planes, p);
}

// curves: [{ kind, closed, points: [{ x, y, front, inside }] }]. Kind 'ring'
// is the split circle the split cone uses; 'touch' is where it meets the host,
// 'last' the cone's last contact with it (findLastContact; hollow when that is
// the tangent point on the shared sphere).
export function buildConeDebugCurves(split, mesh, hostMesh, camPos, projectPoint) {
  const shared = nodes[split.splitNodeId];
  const far = nodes[mesh.nodeIds.find(id => id !== split.splitNodeId)];
  const ring = findSplitRing(shared, far, hostMesh);
  const { frame, cone } = ring;
  const planes = hullPlanes(hostMesh.nodeIds.map(id => nodes[id].center));
  const els = hostElements(hostMesh, shared.id, planes);
  const sharedEl = els.find(el => el.kind === 'shared');

  const screenPoint = (point, outward, skip) => {
    const p = projectPoint(point);
    return { x: p.x, y: p.y, front: vecDot(vecSub(camPos, point), outward) > 0, inside: isBuried(point, els, skip, planes) };
  };

  // roots[el][k][angleIndex]: k-th sign change along each generatrix.
  const roots = els.map(() => []);
  for (let i = 0; i < ANGLES; i++) {
    const at = coneSurface(shared, frame, cone, (i / ANGLES) * Math.PI * 2);
    els.forEach((el, e) => {
      // Not drawn: the shared sphere, the capsules and the faces (too busy).
      if (el === sharedEl || el.kind === 'frustum' || el.kind === 'face') return;
      const f = (s) => el.sdf(at(s).point);
      let prev = f(cone.sA), k = 0;
      for (let j = 1; j <= STEPS; j++) {
        const s0 = cone.sA + (cone.sB - cone.sA) * (j - 1) / STEPS, s1 = cone.sA + (cone.sB - cone.sA) * j / STEPS;
        const cur = f(s1);
        if ((prev < 0) !== (cur < 0)) {
          const { point, outward } = at(bisectRoot(f, s0, s1));
          if (el.accept && !el.accept(point)) { prev = cur; continue; }
          (roots[e][k] ||= new Array(ANGLES).fill(null))[i] = screenPoint(point, outward, el);
          k++;
        }
        prev = cur;
      }
    });
  }

  const curves = [];

  els.forEach((el, e) => roots[e].forEach(points => {
    if (points.some(Boolean)) curves.push({ kind: el.kind, closed: points.every(Boolean), points });
  }));

  const circleAt = (s, skip) => Array.from({ length: ANGLES }, (_, i) => {
    const { point, outward } = coneSurface(shared, frame, cone, (i / ANGLES) * Math.PI * 2)(s);
    return screenPoint(point, outward, skip);
  });

  // The split circle, slid out until it clears the host, and its touch point.
  curves.push({ kind: 'ring', closed: true, points: circleAt(ring.s, sharedEl) });
  const touch = projectPoint(ring.touch);
  curves.push({ kind: 'touch', closed: false, points: [{ x: touch.x, y: touch.y }] });
  const last = findLastContact(shared, far, hostMesh), lastAt = projectPoint(last.point);
  curves.push({ kind: 'last', closed: false, hollow: last.onSphere, points: [{ x: lastAt.x, y: lastAt.y }] });
  return curves;
}

// Segment by segment: dotted where buried in the host mesh, else solid on
// the cone's near side and dashed on its far side.
export function drawConeDebugCurves(ctx, curves) {
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  // One path per run of same-style segments, so the dash pattern flows
  // instead of restarting on every short segment.
  curves.forEach(({ kind, closed, hollow, points }) => {
    if (kind === 'touch' || kind === 'last') {
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(points[0].x, points[0].y, 4, 0, Math.PI * 2);
      if (hollow) {
        // A ring: black under the color, so it reads on any background.
        ctx.lineWidth = 4;
        ctx.strokeStyle = '#000000';
        ctx.stroke();
        ctx.lineWidth = 2;
        ctx.strokeStyle = COLORS[kind];
        ctx.stroke();
        ctx.lineWidth = 1.5;
        return;
      }
      ctx.fillStyle = kind === 'touch' ? COLORS.ring : COLORS[kind];
      ctx.strokeStyle = '#000000';
      ctx.fill();
      ctx.stroke();
      return;
    }
    ctx.strokeStyle = COLORS[kind];
    const n = points.length;
    let style = null;
    const flush = () => { if (style) ctx.stroke(); style = null; };
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const p = points[i], q = points[(i + 1) % n];
      if (!p || !q) { flush(); continue; }
      const next = p.inside && q.inside ? 'dot' : p.front ? 'solid' : 'dash';
      if (next !== style) {
        flush();
        style = next;
        ctx.setLineDash({ dot: [1, 4], solid: [], dash: [4, 4] }[next]);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
      }
      ctx.lineTo(q.x, q.y);
    }
    flush();
  });
  ctx.restore();
}
