// Free-flying camera (the illusion scene): WASD moves in the view's horizontal plane (hold Q: 6x faster), Space / Shift up / down,
// the mouse looks around while the pointer is locked (click the canvas to lock, Esc to release), the wheel zooms.
// It drives the shared `camera` (camera.js): `camera.position` overrides the orbit, and `camera.target` is kept one
// `orbitRadius` ahead of the eye, so the renderers' computeViewBasis(camPos, camera.target) and the projection's
// scale (refDistance = orbitRadius) work unchanged.
import { camera, getCameraPosition } from './camera.js';

export const fly = {
  speed: 300,          // world units per second
  sensitivity: 0.0022, // radians per pixel of mouse movement
  yaw: 0, pitch: 0,
};

const MAX_PITCH = Math.PI / 2 - 0.01;   // computeViewBasis crosses with world up, so never look straight up / down
const keys = new Set();

const forwardOf = () => ({
  x: Math.cos(fly.pitch) * Math.cos(fly.yaw), y: Math.sin(fly.pitch), z: Math.cos(fly.pitch) * Math.sin(fly.yaw),
});

function syncTarget() {
  const f = forwardOf(), p = camera.position, R = camera.orbitRadius;
  camera.target = { x: p.x + f.x * R, y: p.y + f.y * R, z: p.z + f.z * R };
}

// Starts from the current orbit view (same eye, looking at the same target).
export function enableFly(canvas, onChange) {
  const p = getCameraPosition(), t = camera.target;
  const dx = t.x - p.x, dy = t.y - p.y, dz = t.z - p.z;
  fly.yaw = Math.atan2(dz, dx);
  fly.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  camera.position = p;
  syncTarget();

  canvas.addEventListener('click', () => {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();   // so Space doesn't press a button
    if (document.pointerLockElement !== canvas) canvas.requestPointerLock();
  });
  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== canvas) return;
    fly.yaw += e.movementX * fly.sensitivity;
    fly.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, fly.pitch - e.movementY * fly.sensitivity));
    syncTarget();
    onChange();
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    camera.zoom = Math.max(0.1, Math.min(30, camera.zoom * Math.exp(-e.deltaY * 0.0015)));
    onChange();
  }, { passive: false });
  const tracked = (code) => ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'Space', 'ShiftLeft', 'ShiftRight'].includes(code);
  window.addEventListener('keydown', (e) => {
    if (!tracked(e.code)) return;
    if (e.target instanceof HTMLInputElement) return;   // e.g. a slider with focus
    e.preventDefault();
    keys.add(e.code);
  });
  window.addEventListener('keyup', (e) => { if (tracked(e.code)) { e.preventDefault(); keys.delete(e.code); } });
  window.addEventListener('blur', () => keys.clear());
}

// Moves the eye for dt seconds of held keys; returns whether it moved.
export function updateFly(dt) {
  const fwd = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
  const side = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  const vert = (keys.has('Space') ? 1 : 0) - (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 1 : 0);
  if (!fwd && !side && !vert) return false;
  // Horizontal forward (cos yaw, 0, sin yaw); right = forward x world up = (-sin yaw, 0, cos yaw), as computeViewBasis.
  const cy = Math.cos(fly.yaw), sy = Math.sin(fly.yaw);
  let mx = fwd * cy - side * sy, mz = fwd * sy + side * cy, my = vert;
  const len = Math.hypot(mx, my, mz), step = fly.speed * (keys.has('KeyQ') ? 6 : 1) * dt / len;   // Q: sprint
  const p = camera.position;
  camera.position = { x: p.x + mx * step, y: p.y + my * step, z: p.z + mz * step };
  syncTarget();
  return true;
}

export const flyStatus = () => {
  const p = camera.position, deg = (r) => (r * 180 / Math.PI).toFixed(0);
  return `pos ${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}  yaw ${deg(fly.yaw)}  pitch ${deg(fly.pitch)}  zoom ${camera.zoom.toFixed(2)}`;
};
