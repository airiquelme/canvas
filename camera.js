import { DESIGN_WIDTH, DESIGN_HEIGHT } from './config.js';
import { vecSub, vecCross, vecDot, vecNormalize, shadowEllipse, cutEllipse, shapeForm } from './geometry.js';

// Orbits `target`, always looking at it. Nodes are flat billboards: only
// their projected position and size change with the view.
export const camera = {
  target: { x: DESIGN_WIDTH / 2, y: DESIGN_HEIGHT / 2, z: 0 },
  orbitRadius: 700,
  orbitAngle: 0,
  height: 0, // world-y offset from the target
  fov: Math.PI / 3,
  zoom: 1.7, // magnifies everything about the screen center
};

export function getCameraPosition() {
  return {
    x: camera.target.x + camera.orbitRadius * Math.cos(camera.orbitAngle),
    y: camera.target.y + camera.height,
    z: camera.target.z + camera.orbitRadius * Math.sin(camera.orbitAngle),
  };
}

export function computeViewBasis(camPos, target) {
  const forward = vecNormalize(vecSub(target, camPos));
  const worldUp = { x: 0, y: 1, z: 0 };
  const right = vecNormalize(vecCross(forward, worldUp));
  const up = vecCross(right, forward);
  return { forward, right, up };
}

export function worldToCamera(point, camPos, basis) {
  const d = vecSub(point, camPos);
  return { x: vecDot(d, basis.right), y: vecDot(d, basis.up), z: vecDot(d, basis.forward) };
}

// Camera space -> screen position plus a scale factor for radii. A point
// at refDistance renders at its true size, whatever the FOV. Note the
// y flip: larger world y appears higher on screen.
export function projectToScreen(camSpace, fov, refDistance, screenCenter) {
  const focalLength = 1 / Math.tan(fov / 2);
  const screenScale = refDistance * Math.tan(fov / 2);
  const scale = (focalLength * screenScale) / camSpace.z * camera.zoom;
  return {
    x: screenCenter.x + camSpace.x * scale,
    y: screenCenter.y - camSpace.y * scale,
    scale,
  };
}

// Projection helpers for one frame's camera.
export function makeProjector(camPos, basis) {
  const screenCenter = { x: DESIGN_WIDTH / 2, y: DESIGN_HEIGHT / 2 };
  const projectCam = (camSpace) => projectToScreen(camSpace, camera.fov, camera.orbitRadius, screenCenter);
  return {
    projectPoint: (world) => projectCam(worldToCamera(world, camPos, basis)),
    // depth = camera-space z, used for depth sorting.
    projectNode: (node) => {
      const camSpace = worldToCamera(node.center, camPos, basis);
      const proj = projectCam(camSpace);
      // A world offset d from the node moves its screen point by scale * (d.right - (X/Z) d.forward,
      // -(d.up - (Y/Z) d.forward)): the projection's Jacobian at the node (camera-space X, Y, Z).
      // It is linear, so shapes stay exact ellipses (no lens distortion) but slant with the node's
      // own view ray: a node below the center shows its top, one above shows its underside.
      // `right` / `up` below are the oblique axes that map reads off d.
      const lean = (v, k) => ({ x: v.x - k * basis.forward.x, y: v.y - k * basis.forward.y, z: v.z - k * basis.forward.z });
      const right = lean(basis.right, camSpace.x / camSpace.z), up = lean(basis.up, camSpace.y / camSpace.z);
      // `ellipse` is the node's silhouette on the screen (y flipped, so the angle is clockwise
      // on screen from +x), in px: what is drawn. A sphere stays the circle of `radius`.
      const e = node.shape.isSphere ? shadowEllipse(node.shape, basis.right, basis.up) : shadowEllipse(node.shape, right, up);
      const ellipse = { a: e.a * proj.scale, b: e.b * proj.scale, angle: -e.angle };
      // `cut` is the meridian ellipse (debug view only), with its two screen diameters A and B;
      // it lies inside the silhouette, touching it where the spheroid's outline is.
      const c = cutEllipse(node.shape, right, up);
      const cut = {
        a: c.a * proj.scale, b: c.b * proj.scale, angle: -c.angle,
        A: { x: c.A.x * proj.scale, y: -c.A.y * proj.scale }, B: { x: c.B.x * proj.scale, y: -c.B.y * proj.scale },
      };
      // `zRadius`: the body's half-extent along the view direction in px, the third semi-axis of the
      // ellipsoid the joint's flat solid gives the node (render.js flatBody); `scale`: px per unit.
      const zRadius = Math.sqrt(shapeForm(node.shape, basis.forward, basis.forward)) * proj.scale;
      return { id: node.id, center: { x: proj.x, y: proj.y }, radius: node.radius * proj.scale, ellipse, cut, round: node.shape.isSphere, zRadius, scale: proj.scale,
        // The linear map of a world offset d from the node to the screen: center + scale (d . right, -d . up).
        // Spheres use the plain camera axes, so their points stay on their circle.
        axes: node.shape.isSphere ? { right: basis.right, up: basis.up } : { right, up },
        depth: camSpace.z };
    },
  };
}
