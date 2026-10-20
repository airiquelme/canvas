// Entry point: canvas setup, UI buttons, animation loop. See CLAUDE.md.
import { camera } from './camera.js';
import { debug, focus } from './config.js';
import { buildDemoScene } from './scene.js';
import { nodes } from './scene.js';
import { render } from './render.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

buildDemoScene();

// Focus view: only some meshes, the camera on one joint, magnified (config.js focus).
const home = { target: { ...camera.target }, zoom: camera.zoom };
function applyFocus() {
  camera.target = focus.on ? { ...nodes[focus.nodeId].center } : { ...home.target };
  camera.zoom = focus.on ? focus.zoom : home.zoom;
}
applyFocus();

let paused = false;
// Black background makes light seam gaps easier to spot, white makes dark ones.
let darkMode = false;

function drawFrame() {
  render(ctx, canvas, { darkMode });
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

const debugBtn = document.getElementById('debugBtn');
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
