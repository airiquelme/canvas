// Free-flying camera (the illusion scene): WASD moves in the view's horizontal plane (hold Q: 6x faster), Space / Shift up / down,
// the mouse looks around while the pointer is locked (click the canvas to lock, Esc to release), the wheel zooms.
// Enter (where the scene has walkable ground, `fly.ground`: the meadow) toggles WALKING: the player's body under gravity on the
// ground, `player.height` cubes tall with the eyes at `player.eye` of that, WASD at walking pace (Q runs), Space jumps.
// It drives the shared `camera` (camera.js): `camera.position` overrides the orbit, and `camera.target` is kept one
// `orbitRadius` ahead of the eye, so the renderers' computeViewBasis(camPos, camera.target) and the projection's
// scale (refDistance = orbitRadius) work unchanged.
import { camera, getCameraPosition } from './camera.js';

export const fly = {
  speed: 300,          // world units per second
  sensitivity: 0.0022, // radians per pixel of mouse movement
  yaw: 0, pitch: 0,
  ground: null,        // () => { height(x, z), cube } | null: the walkable ground (set by main.js)
};

// The player's body, in cubes of the grid (the frame of reference for the scenery's scale). A cube is taken as 0.875 m, so the
// default body is 1.75 m tall with the eyes 1.63 m up (0.93 of the height, about the middle of the second cube's head).
export const player = { height: 2, eye: 0.93 };
const CUBE_M = 0.875;                                  // meters per cube
const WALK_MS = 1.4, RUN_MS = 5, GRAVITY_MS2 = 9.81, JUMP_M = 0.45, MAX_FALL_MS = 50;
export const walk = { on: false, vy: 0, grounded: false };

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
    if (e.target instanceof HTMLInputElement) return;   // e.g. a slider with focus
    if ((e.code === 'Enter' || e.code === 'NumpadEnter') && !e.repeat) {
      if (!fly.ground || !fly.ground()) return;
      e.preventDefault();
      walk.on = !walk.on; walk.vy = 0; walk.grounded = false;   // walking starts where the eye is: from the air it falls
      onChange();
      return;
    }
    if (!tracked(e.code)) return;
    e.preventDefault();
    keys.add(e.code);
  });
  window.addEventListener('keyup', (e) => { if (tracked(e.code)) { e.preventDefault(); keys.delete(e.code); } });
  window.addEventListener('blur', () => keys.clear());
}

// Walking: the feet under the eye, moved by WASD in the horizontal plane, then gravity against the ground's height. On the ground
// the feet follow it down slopes (up to a drop of twice the step's run, about 63 degrees) instead of leaving it on every step; a
// bigger drop (a dug hole, a ledge) is a fall.
function updateWalk(dt) {
  const G = fly.ground && fly.ground();
  if (!G) { walk.on = false; return false; }
  const m = G.cube / CUBE_M;                           // world units per meter
  const eyeH = player.height * player.eye * G.cube;
  const p = camera.position;
  const fwd = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
  const side = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  let x = p.x, z = p.z, y = p.y - eyeH;
  let run = 0;
  if (fwd || side) {
    const cy = Math.cos(fly.yaw), sy = Math.sin(fly.yaw);
    const mx = fwd * cy - side * sy, mz = fwd * sy + side * cy, len = Math.hypot(mx, mz);
    run = (keys.has('KeyQ') ? RUN_MS : WALK_MS) * m * dt;
    x += mx / len * run; z += mz / len * run;
  }
  const g = G.height(x, z);
  if (walk.grounded && keys.has('Space')) { walk.vy = Math.sqrt(2 * GRAVITY_MS2 * JUMP_M) * m; walk.grounded = false; }
  if (walk.grounded && y - g <= 2 * run + 0.01 * m) y = g;   // stays on the ground (uphill: lifted, downhill: follows)
  else {
    walk.grounded = false;
    walk.vy = Math.max(walk.vy - GRAVITY_MS2 * m * dt, -MAX_FALL_MS * m);
    y += walk.vy * dt;
    if (y <= g) { y = g; walk.vy = 0; walk.grounded = true; }
  }
  const ny = y + eyeH;
  if (x === p.x && z === p.z && ny === p.y) return false;
  camera.position = { x, y: ny, z };
  syncTarget();
  return true;
}

// Moves the eye for dt seconds of held keys (walking: and gravity); returns whether it moved.
export function updateFly(dt) {
  if (walk.on) return updateWalk(dt);
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
  const mode = walk.on ? `walk (${player.height} cubes, Enter: fly)  ` : (fly.ground && fly.ground() ? 'fly (Enter: walk)  ' : '');
  return `${mode}pos ${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}  yaw ${deg(fly.yaw)}  pitch ${deg(fly.pitch)}  zoom ${camera.zoom.toFixed(2)}`;
};
