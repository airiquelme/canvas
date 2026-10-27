// Entry point: canvas setup, UI buttons, animation loop. See CLAUDE.md.
import { camera, getCameraPosition, computeViewBasis, makeProjector } from './camera.js';
import { debug, focus, strokes, lighting, DESIGN_WIDTH, DESIGN_HEIGHT } from './config.js';
import { buildBasicScene, buildFullScene, buildShellScene, nodes, meshes } from './scene.js';
import { render } from './render.js';
import { renderShells } from './shellRender.js';
import { shells } from './shell.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
resizeCanvas();
// Resizing clears the canvas; redraw so a paused view doesn't stay blank.
window.addEventListener('resize', () => { resizeCanvas(); drawFrame(); });

// The default is the shells scene (CLAUDE.md "Shells"); ?scene=basic is the small skew scene, ?scene=full the squashed-nodes demo.
const sceneName = new URLSearchParams(location.search).get('scene');
const shellScene = sceneName !== 'basic' && sceneName !== 'full';
const paneId = shellScene ? buildShellScene() : null;
if (!shellScene) (sceneName === 'full' ? buildFullScene : buildBasicScene)();
if (shellScene) camera.height = 180;   // look down on the floor

// Focus view: one mesh of 3+ nodes (and the meshes sharing a node with it), the camera on its bounding sphere, magnified until all of
// it fits (config.js focus). A point at distance d from the view axis is drawn at zoom * orbitRadius / depth px per unit, and the
// nearest point of the sphere is orbitRadius - R from the camera.
const home = { target: { ...camera.target }, zoom: camera.zoom };
// The shells scene: the first joint (ball and limbs). Its bounding sphere is the ball's center and the limbs' tips, and the same fit.
function shellFocusFrame() {
  const ball = Object.values(shells).find(s => s.group != null && s.id === s.group);
  if (!ball) return null;
  const pts = [ball.center];
  Object.values(shells).forEach(s => {
    if (s.group !== ball.group || s === ball) return;
    const a = Math.hypot(s.axis.x, s.axis.y, s.axis.z), h = s.radius * s.roundness;
    pts.push({ x: s.center.x + s.axis.x / a * h, y: s.center.y + s.axis.y / a * h, z: s.center.z + s.axis.z / a * h });
  });
  const target = { x: 0, y: 0, z: 0 };
  pts.forEach(p => { target.x += p.x / pts.length; target.y += p.y / pts.length; target.z += p.z / pts.length; });
  // One zoom that stays: the largest at which the arm's outline (the key points and the ball's radius, projected) fits `focus.shellFill`
  // of the half-height from every orbit angle. A point's offset from the view center and its scale both grow with the zoom, so each
  // angle's fit is a ratio of the numbers at the current zoom.
  const saved = { target: camera.target, angle: camera.orbitAngle, zoom: camera.zoom };
  camera.target = target; camera.zoom = 1;
  let ext = 0;
  for (let k = 0; k < 72; k++) {
    camera.orbitAngle = k * Math.PI * 2 / 72;
    const camPos = getCameraPosition(), { projectPoint } = makeProjector(camPos, computeViewBasis(camPos, target));
    for (const p of pts) {
      const q = projectPoint(p);
      ext = Math.max(ext, Math.hypot(q.x - DESIGN_WIDTH / 2, q.y - DESIGN_HEIGHT / 2) + ball.radius * q.scale);
    }
  }
  camera.target = saved.target; camera.orbitAngle = saved.angle; camera.zoom = saved.zoom;
  return { target, zoom: ext > 1e-6 ? Math.min(Math.max(focus.shellFill * Math.min(DESIGN_WIDTH, DESIGN_HEIGHT) / 2 / ext, home.zoom), 12) : home.zoom };
}
function focusFrame() {
  if (shellScene) return shellFocusFrame();
  const mesh = focus.meshId !== null ? meshes[focus.meshId] : Object.values(meshes).find(m => m.nodeIds.length > 2);
  if (!mesh) return null;
  const ns = mesh.nodeIds.map(id => nodes[id]), n = ns.length;
  const target = { x: 0, y: 0, z: 0 };
  ns.forEach(nd => { target.x += nd.center.x / n; target.y += nd.center.y / n; target.z += nd.center.z / n; });
  const R = Math.max(...ns.map(nd => Math.hypot(nd.center.x - target.x, nd.center.y - target.y, nd.center.z - target.z) + nd.radius));
  const near = camera.orbitRadius - R, half = Math.min(DESIGN_WIDTH, DESIGN_HEIGHT) / 2;
  const zoom = near > 0 ? focus.fill * half * near / (R * camera.orbitRadius) : home.zoom;
  const shares = (m) => m.nodeIds.some(id => mesh.nodeIds.includes(id));
  focus.meshIds = Object.values(meshes).filter(shares).map(m => m.id);
  return { target, zoom };
}
function applyFocus() {
  const f = focus.on ? focusFrame() : null;
  camera.target = f ? f.target : { ...home.target };
  camera.zoom = f ? f.zoom : home.zoom;
}
applyFocus();

let paused = false;
// Black background makes light seam gaps easier to spot, white makes dark ones.
let darkMode = false;

function drawFrame() {
  (shellScene ? renderShells : render)(ctx, canvas, { darkMode });
}

const pauseBtn = document.getElementById('pauseBtn');
if (pauseBtn) {
  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    if (!paused) lastTime = performance.now();
  });
}

const themeBtn = document.getElementById('themeBtn');
if (themeBtn) {
  themeBtn.addEventListener('click', () => {
    darkMode = !darkMode;
    themeBtn.textContent = darkMode ? 'Light mode' : 'Dark mode';
    document.body.style.background = darkMode ? '#000000' : '#ffffff';
    canvas.style.background = darkMode ? '#000000' : '#ffffff';
    drawFrame();
  });
}

const focusBtn = document.getElementById('focusBtn');
if (focusBtn) {
  const label = () => { focusBtn.textContent = focus.on ? 'Focus: on' : 'Focus: off'; focusBtn.style.background = focus.on ? '#1b5e20' : '#333'; };
  label();
  focusBtn.addEventListener('click', () => { focus.on = !focus.on; applyFocus(); label(); drawFrame(); });
}

const strokeBtn = document.getElementById('strokeBtn');
if (strokeBtn) {
  const label = () => { strokeBtn.textContent = strokes.on ? 'Strokes: on' : 'Strokes: off'; strokeBtn.style.background = strokes.on ? '#1b5e20' : '#333'; };
  label();
  strokeBtn.addEventListener('click', () => { strokes.on = !strokes.on; label(); drawFrame(); });
}

const lightBtn = document.getElementById('lightBtn');
if (lightBtn) {
  const label = () => { lightBtn.textContent = lighting.on ? 'Light: on' : 'Light: off'; lightBtn.style.background = lighting.on ? '#1b5e20' : '#333'; };
  label();
  lightBtn.addEventListener('click', () => { lighting.on = !lighting.on; label(); drawFrame(); });
}

// Roundness slider (shells scene only): the curved pane, from flat (0) to a dome.
const roundBox = document.getElementById('roundBox');
if (roundBox && shellScene) {
  roundBox.style.display = 'flex';
  const slider = document.getElementById('roundSlider'), label = document.getElementById('roundLabel');
  slider.value = shells[paneId].roundness;
  label.textContent = Number(slider.value).toFixed(2);
  slider.addEventListener('input', () => { shells[paneId].roundness = Number(slider.value); label.textContent = Number(slider.value).toFixed(2); drawFrame(); });
}

const debugBtn =document.getElementById('debugBtn');
if (debugBtn) {
  debugBtn.addEventListener('click', () => {
    debug.on = !debug.on;
    debugBtn.textContent = debug.on ? 'Debug: on' : 'Debug: off';
    debugBtn.style.background = debug.on ? '#b71c1c' : '#333';
    drawFrame();
  });
}

// Angle slider: dragging it pauses the orbit at that angle (the label shows the
// value to report); while the orbit runs it follows the camera.
const angleSlider = document.getElementById('angleSlider');
const angleLabel = document.getElementById('angleLabel');
const TWO_PI = Math.PI * 2;
function syncAngleUi() {
  if (!angleSlider) return;
  const a = ((camera.orbitAngle % TWO_PI) + TWO_PI) % TWO_PI;
  angleSlider.value = a;
  angleLabel.textContent = a.toFixed(3);
}
if (angleSlider) {
  angleSlider.addEventListener('input', () => {
    paused = true;
    if (pauseBtn) pauseBtn.textContent = 'Resume';
    camera.orbitAngle = Number(angleSlider.value);
    angleLabel.textContent = Number(angleSlider.value).toFixed(3);
    drawFrame();
  });
}

let lastTime = 0;
function loop(timestamp) {
  if (!paused) {
    const dt = (timestamp - lastTime) / 1000;
    lastTime = timestamp;
    camera.orbitAngle += dt * 0.4;
    drawFrame();
    syncAngleUi();
  } else {
    lastTime = timestamp;
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
