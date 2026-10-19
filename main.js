// Entry point: canvas setup, UI buttons, animation loop. See CLAUDE.md.
import { camera } from './camera.js';
import { buildDemoScene } from './scene.js';
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

let lastTime = 0;
function loop(timestamp) {
  if (!paused) {
    const dt = (timestamp - lastTime) / 1000;
    lastTime = timestamp;
    camera.orbitAngle += dt * 0.4;
    drawFrame();
  } else {
    lastTime = timestamp;
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
