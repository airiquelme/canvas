import { DESIGN_WIDTH, DESIGN_HEIGHT } from './config.js';
import { vecSub, vecCross, vecDot, vecNormalize } from './geometry.js';

// Orbits `target`, always looking at it. Nodes are flat billboards: only
// their projected position and size change with the view.
export const camera = {
  target: { x: DESIGN_WIDTH / 2, y: DESIGN_HEIGHT / 2, z: 0 },
  orbitRadius: 700,
  orbitAngle: 0,
  height: 0, // world-y offset from the target
  fov: Math.PI / 3,
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
  const scale = (focalLength * screenScale) / camSpace.z;
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
      return { id: node.id, center: { x: proj.x, y: proj.y }, radius: node.radius * proj.scale, depth: camSpace.z };
    },
  };
}
