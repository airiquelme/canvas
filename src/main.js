// Entry point: canvas setup, UI buttons, animation loop. See CLAUDE.md.
import { camera, getCameraPosition, computeViewBasis, makeProjector } from './core/camera.js';
import { debug, focus, strokes, lighting, DESIGN_WIDTH, DESIGN_HEIGHT } from './config.js';
import { buildBasicScene, buildFullScene, buildShellScene, nodes, meshes } from './scene.js';
import { render } from './meshes/render.js';
import { renderShells } from './shells/shellRender.js';
import { shells } from './shells/shell.js';
import { grass, silhouette, groundShade, meadowSun, editGround, groundEdits, buildMeadowScene, buildPatchScene, buildPairsScene, buildSheetsScene, buildWorldScene, renderIllusion, buildIllusionFrame, drawIllusionOverlay, walkGround } from './illusion/illusionRender.js';
import { bestBackend } from './gpu/backend.js';
import { wind } from './illusion/wind.js';
import { enableFly, updateFly, flyStatus, fly, walk } from './core/flyCamera.js';
import { light, setSun } from './illusion/light.js';

const canvas = document.getElementById('game');
// BACKENDS (illusion scenes, src/gpu/backend.js): WebGPU, WebGL2 or Canvas 2D, the best the browser runs unless ?backend= names
// one. A GPU backend draws on its own canvas under #game, which then only holds the overlay (Debug view, the ground edit's aim)
// on a transparent background; with Strokes on (no GPU path yet) the frame is drawn in Canvas 2D on #game.
const params = new URLSearchParams(location.search);
const illusionAtLoad = !['shells', 'basic', 'full'].includes(params.get('scene'));
const wantedBackend = params.get('backend');
let gpu = null, gpuCanvas = null;
if (illusionAtLoad && wantedBackend !== 'canvas') {
  gpuCanvas = document.createElement('canvas');
  gpuCanvas.style.cssText = 'position:fixed; left:0; top:0; z-index:0; display:block;';
  canvas.before(gpuCanvas);
  canvas.style.position = 'relative'; canvas.style.zIndex = '1';
  gpu = await bestBackend(gpuCanvas, wantedBackend);
  if (!gpu || gpu.name === 'canvas') { gpuCanvas.remove(); gpuCanvas = null; gpu = null; }
}
// The GPU backends shade the ground per pixel (illusionRender.js `groundShade`): the meadow is then built without shade parts
groundShade.pixel = !!gpu;
// The illusion scenes paint their whole background every frame, so on its own their canvas is opaque (alpha: false): the browser
// then composites it without blending it over the page. Over a GPU canvas it is a transparent overlay.
const ctx = canvas.getContext('2d', illusionAtLoad && !gpu ? { alpha: false } : undefined);

// Canvas pixels per CSS pixel. The illusion world's Quality (panel) sets it, 100% unless chosen: the resolution is never lowered
// on its own (no automatic quality: what to lower when frames are slow is decided elsewhere, never the pixel count).
let renderScale = 1;
function resizeCanvas() {
  canvas.width = Math.max(1, Math.round(window.innerWidth * renderScale));
  canvas.height = Math.max(1, Math.round(window.innerHeight * renderScale));
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  canvas.style.display = 'block';
  if (gpuCanvas) {
    gpuCanvas.width = canvas.width; gpuCanvas.height = canvas.height;
    gpuCanvas.style.width = canvas.style.width; gpuCanvas.style.height = canvas.style.height;
  }
}
resizeCanvas();
// Resizing clears the canvas; redraw so a paused view doesn't stay blank.
window.addEventListener('resize', () => { resizeCanvas(); drawFrame(); });

// The default is the illusion meadow (meadow.js); ?scene=world the stress world, ?scene=sheets one of each sheet, ?scene=pairs the illusion's first three pairs, ?scene=shells the
// shells, ?scene=basic the small skew scene, ?scene=full the squashed-nodes demo.
const sceneName = new URLSearchParams(location.search).get('scene');
const illusionScene = !['shells', 'basic', 'full'].includes(sceneName);
const shellScene = sceneName === 'shells';
const worldScene = sceneName === 'world';
const meadowScene = illusionScene && !['world', 'sheets', 'pairs', 'patch'].includes(sceneName);
const animScene = worldScene || meadowScene;   // scenes with movers (animated every frame)
// The world's size, set by the panel's sliders (illusion world only).
const worldOpts = { count: 3000, curved: 100, movers: 200, walls: 48, sheets: 600 };
if (illusionScene) {
  camera.height = 120;
  if (worldScene) buildWorldScene(worldOpts);
  else if (sceneName === 'sheets') buildSheetsScene();
  else if (sceneName === 'patch') buildPatchScene();
  else if (sceneName === 'pairs') { buildPairsScene(); strokes.on = true; }   // the pairs scene is about its borders
  else {   // the meadow: the eye 60 units over the ground, looking across it
    let saved = null;   // the ground's edits from an earlier visit (grid.js), replayed
    try { saved = JSON.parse(localStorage.getItem('gatomica.groundEdits') || 'null'); } catch (e) { saved = null; }
    const groundAt = buildMeadowScene({ edits: Array.isArray(saved) ? saved : null });
    camera.target = { x: 500, y: groundAt(500, 0) + 20, z: 0 };
    camera.height = groundAt(500 + camera.orbitRadius * Math.cos(camera.orbitAngle), camera.orbitRadius * Math.sin(camera.orbitAngle)) + 60 - camera.target.y;
  }
}
const paneId = shellScene ? buildShellScene() : null;
if (!shellScene && !illusionScene) (sceneName === 'full' ? buildFullScene : buildBasicScene)();
if (shellScene) { camera.height = 180; camera.zoom = 2.6; }   // look down on the hand, magnified (the hand is ~230 units tall)

// Focus view: one mesh of 3+ nodes (and the meshes sharing a node with it), the camera on its bounding sphere, magnified until all of
// it fits (config.js focus). A point at distance d from the view axis is drawn at zoom * orbitRadius / depth px per unit, and the
// nearest point of the sphere is orbitRadius - R from the camera.
const home = { target: { ...camera.target }, zoom: camera.zoom };
// The shells scene: every joint (the balls and the limbs' tips).
function shellFocusFrame() {
  const members = Object.values(shells).filter(s => s.group != null);
  if (!members.length) return null;
  // The joints' balls and the limbs' tips (a rig's bones end in its balls); `pad`: the thickest member.
  const pts = [], pad = Math.max(...members.map(s => s.radius));
  members.forEach(s => {
    if (s.rig && s.rig.ends) return;
    if (s.id === s.group || (s.rig && s.rig.ball)) { pts.push(s.center); return; }
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
      ext = Math.max(ext, Math.hypot(q.x - DESIGN_WIDTH / 2, q.y - DESIGN_HEIGHT / 2) + pad * q.scale);
    }
  }
  camera.target = saved.target; camera.orbitAngle = saved.angle; camera.zoom = saved.zoom;
  return { target, zoom: ext > 1e-6 ? Math.min(Math.max(focus.shellFill * Math.min(DESIGN_WIDTH, DESIGN_HEIGHT) / 2 / ext, home.zoom), 12) : home.zoom };
}
function focusFrame() {
  if (illusionScene) return null;
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

// The illusion scene flies (flyCamera.js) instead of orbiting.
if (illusionScene) enableFly(canvas, () => { pendingDraw = true; });
if (worldScene) fly.speed = 600;
if (meadowScene) { fly.ground = walkGround; walk.on = true; }   // starts walking, in third person (Enter: fly)
let pendingDraw = true;

let worldTime = 0, lastStats = null;
function drawFrame() {
  const t0 = performance.now();
  if (illusionScene && gpu && !strokes.on) {
    const F = buildIllusionFrame(canvas, { darkMode, time: worldTime });
    lastStats = gpu.render(F, { darkMode });
    drawIllusionOverlay(ctx, canvas, F);
    gpuCanvas.style.visibility = 'visible';
  } else if (illusionScene) {
    lastStats = renderIllusion(ctx, canvas, { darkMode, time: worldTime });
    if (gpuCanvas) gpuCanvas.style.visibility = 'hidden';
  }
  else (shellScene ? renderShells : render)(ctx, canvas, { darkMode });
  tracker.work.push(performance.now() - t0);
  if (tracker.work.length > 30) tracker.work.shift();
}

// FRAME TRACKER (top right) and FPS CAP. Capped at CAP_FPS (the target: every other refresh of a 60 Hz screen), the button
// uncaps it (one frame per screen refresh). The scheduler keeps the average at the cap on any refresh rate: a frame is drawn
// when the time since the last one's due time has come (less a 3 ms margin for the refresh's jitter), and the next is due one
// interval after that one (or after now, once behind). Shown, over the last second: the mean time between drawn frames and its
// fps, the slowest frame (spikes), and the JS of drawing a frame (build + canvas calls; the browser rasterizes outside it).
const CAP_FPS = 30;
const tracker = { capped: true, nextDue: 0, frames: [], work: [] };   // frames: [timestamp, interval]; work: the last 30 frames' JS
function frameDue(ts) {
  if (!tracker.capped) return true;
  const iv = 1000 / CAP_FPS;
  if (ts < tracker.nextDue - 3) return false;
  tracker.nextDue = ts - tracker.nextDue > iv ? ts + iv : tracker.nextDue + iv;
  return true;
}
let lastDrawnTs = 0;
function trackFrame(ts) {
  if (lastDrawnTs && ts - lastDrawnTs < 250) tracker.frames.push([ts, ts - lastDrawnTs]);   // (a gap after idling is not a frame time)
  lastDrawnTs = ts;
}
{
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed; top:16px; right:16px; z-index:11; font:12px monospace; color:#fff; background:rgba(51,51,51,0.85);' +
    'padding:6px 10px; border-radius:6px; display:flex; align-items:center; gap:10px; white-space:pre; line-height:1.4;';
  const text = document.createElement('div');
  const btn = document.createElement('button');
  btn.style.cssText = 'color:#fff; border:none; border-radius:4px; padding:4px 8px; cursor:pointer; font:12px sans-serif;';
  const label = () => { btn.textContent = tracker.capped ? `Cap ${CAP_FPS}: on` : 'Uncapped'; btn.style.background = tracker.capped ? '#1b5e20' : '#8e2424'; };
  label();
  btn.addEventListener('click', () => { tracker.capped = !tracker.capped; tracker.nextDue = 0; frameTimes.length = 0; label(); btn.blur(); });
  // the backend (illusion scenes): switching reloads the page with ?backend= (a canvas holds one kind of context)
  if (illusionScene) {
    const sel = document.createElement('select');
    sel.style.cssText = 'font:12px sans-serif; background:#222; color:#fff; border:1px solid #555; border-radius:4px; padding:2px;';
    const current = gpu && !strokes.on ? gpu.name : 'canvas';
    for (const [v, t] of [['webgl2', 'WebGL2'], ['webgpu', 'WebGPU'], ['canvas', 'Canvas 2D']]) {
      const op = document.createElement('option'); op.value = v; op.textContent = t; op.selected = v === current; sel.append(op);
    }
    sel.addEventListener('change', () => { const q = new URLSearchParams(location.search); q.set('backend', sel.value); location.search = q.toString(); });
    box.append(text, sel, btn);
  } else box.append(text, btn);
  document.body.append(box);
  setInterval(() => {   // 4 times a second (each rewrite is a page layout)
    const now = performance.now();
    while (tracker.frames.length && now - tracker.frames[0][0] > 1000) tracker.frames.shift();
    const w = tracker.work, f = tracker.frames;
    if (!f.length) { text.textContent = 'idle (nothing moving)'; return; }
    const avg = f.reduce((a, x) => a + x[1], 0) / f.length, worst = Math.max(...f.map((x) => x[1]));
    const js = w.length ? w.reduce((a, b) => a + b, 0) / w.length : 0;
    const be = illusionScene ? (gpu && !strokes.on ? gpu.name + (gpu.samples ? ` ${gpu.samples}x` : '') : 'canvas') : 'canvas';
    text.textContent = `${avg.toFixed(1).padStart(5)} ms  ${(1000 / avg).toFixed(0).padStart(3)} fps  ${be}
` +
      `worst ${worst.toFixed(1).padStart(5)} ms  JS ${js.toFixed(1)} ms`;
  }, 250);
}

// The world's panel (top right): sliders for the number of shapes, and the last frames' stats. "frame" is the time between
// animation frames (what the browser really spends, rasterizing included); "build" the JS that makes the shapes, of which
// "curved" the bent tubes; "draw" the canvas calls (the browser may rasterize later, inside "frame").
let statsEl = null;
const frameTimes = [];
if (worldScene) {
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed; top:64px; right:16px; z-index:10; width:300px; font:13px sans-serif; color:#fff;' +
    'background:rgba(51,51,51,0.85); padding:10px 12px; border-radius:6px; display:flex; flex-direction:column; gap:6px;';
  const slider = (label, key, max, step) => {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex; align-items:center; gap:8px;';
    const name = document.createElement('span'); name.textContent = label; name.style.width = '64px';
    const input = document.createElement('input'); input.type = 'range'; input.min = 0; input.max = max; input.step = step; input.value = worldOpts[key];
    input.style.flex = '1';
    const val = document.createElement('span'); val.textContent = worldOpts[key]; val.style.cssText = 'width:44px; text-align:right; font-family:monospace;';
    input.addEventListener('input', () => { val.textContent = input.value; });
    input.addEventListener('change', () => { worldOpts[key] = Number(input.value); buildWorldScene(worldOpts); pendingDraw = true; });
    row.append(name, input, val);
    panel.append(row);
  };
  slider('Shapes', 'count', 30000, 500);
  slider('Curved', 'curved', 1000, 10);
  slider('Movers', 'movers', 3000, 50);
  slider('Walls', 'walls', 240, 12);
  slider('Sheets', 'sheets', 5000, 100);
  {   // Quality: the canvas resolution (only when chosen here)
    const row = document.createElement('label');
    row.style.cssText = 'display:flex; align-items:center; gap:8px;';
    const name = document.createElement('span'); name.textContent = 'Quality'; name.style.width = '64px';
    const sel = document.createElement('select');
    sel.style.flex = '1';
    for (const [v, t] of [['1', '100%'], ['0.75', '75%'], ['0.5', '50%']]) {
      const op = document.createElement('option'); op.value = v; op.textContent = t; sel.append(op);
    }
    sel.addEventListener('change', () => {
      setRenderScale(Number(sel.value));
      sel.blur();   // so Space / WASD go to the camera
    });
    row.append(name, sel);
    panel.append(row);
  }
  statsEl = document.createElement('div');
  statsEl.style.cssText = 'font-family:monospace; font-size:12px; white-space:pre; line-height:1.4;';
  panel.append(statsEl);
  document.body.append(panel);
}
function setRenderScale(k) {
  if (k === renderScale) return;
  renderScale = k;
  resizeCanvas();
  frameTimes.length = 0;
  drawFrame();
}
// The panel's text and the bottom bar are rewritten 4 times a second, not every frame (each rewrite is a page layout).
let lastUi = 0;
function uiDue(now) { if (now - lastUi < 250) return false; lastUi = now; return true; }
function showStats() {
  if (!statsEl || !lastStats || !frameTimes.length) return;
  const st = lastStats, avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
  statsEl.textContent =
    `frame  ${avg.toFixed(1)} ms  (${(1000 / avg).toFixed(0)} fps)  resolution ${Math.round(renderScale * 100)}%\n` +
    `build  ${st.buildMs.toFixed(1)} ms  curved ${st.curvedMs.toFixed(1)} ms\n` +
    `draw   ${st.drawMs.toFixed(1)} ms\n` +
    `shapes ${st.drawn} drawn (${st.curved} curved, ${st.simplified} simplified, ${st.sheets} sheets) of ${st.objects}${st.skipped ? ` (${st.skipped} left out: no free spot)` : ''}\n` +
    `       ${st.reused} reused (camera still), ${st.kept} curved kept (moved < 0.5 px)\n` +
    `       ${st.culled} off screen, ${st.tiny} sub-pixel, ${st.behind} behind the eye\n` +
    `       ${st.occluded} hidden (${st.nodesSkipped} tree nodes skipped whole)`;
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
  strokeBtn.addEventListener('click', () => {
    strokes.on = !strokes.on;
    // Strokes draw with Canvas 2D, which can't shade the ground per pixel: the meadow is rebuilt with shade parts (and back)
    const pixel = !!gpu && !strokes.on;
    if (meadowScene && groundShade.pixel !== pixel) { groundShade.pixel = pixel; buildMeadowScene(); }
    label(); drawFrame();
  });
}

const lightBtn = document.getElementById('lightBtn');
if (lightBtn) {   // the illusion scenes: the stylized sun (light.js); the others: the meshes' / shells' light
  const on = () => (illusionScene ? light.on : lighting.on);
  const label = () => { lightBtn.textContent = on() ? 'Light: on' : 'Light: off'; lightBtn.style.background = on() ? '#1b5e20' : '#333'; };
  label();
  lightBtn.addEventListener('click', () => {
    if (illusionScene) { light.on = !light.on; if (meadowScene) meadowSun(); }   // the meadow's shade is built with the sun
    else lighting.on = !lighting.on;
    label(); drawFrame();
  });
}

// The sun (illusion scenes): direction and height above the horizon. The meadow redoes its shade when a slider is let go (its
// shade field, about 40 ms, with per-pixel ground shade; else a whole rebuild); the other scenes follow while dragging.
if (illusionScene) {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed; left:16px; top:64px; z-index:10; font:13px sans-serif; color:#fff; background:rgba(51,51,51,0.85);' +
    'padding:8px 12px; border-radius:6px; display:flex; flex-direction:column; gap:4px; width:240px;';
  // a slider: degrees (set gets radians) unless `unit` / `scale` say otherwise; `sun`: letting go redoes the meadow's shade
  const row = (label, min, max, value, set, { unit = '°', scale = Math.PI / 180, sun = true } = {}) => {
    const r = document.createElement('label');
    r.style.cssText = 'display:flex; align-items:center; gap:8px;';
    const name = document.createElement('span'); name.textContent = label; name.style.width = '58px';
    const input = document.createElement('input'); input.type = 'range'; input.min = min; input.max = max; input.step = 1; input.value = value;
    input.style.flex = '1';
    const val = document.createElement('span'); val.textContent = value + unit; val.style.cssText = 'width:36px; text-align:right; font-family:monospace;';
    const apply = (rebuild) => { val.textContent = input.value + unit; set(Number(input.value) * scale); if (rebuild && sun && meadowScene) meadowSun(); pendingDraw = true; };
    input.addEventListener('input', () => apply(false));
    input.addEventListener('change', () => { apply(true); input.blur(); });
    r.append(name, input, val);
    box.append(r);
  };
  row('Sun dir', 0, 360, Math.round(light.azimuth * 180 / Math.PI), (a) => setSun(a, light.elevation));
  row('Sun height', -10, 80, Math.round(light.elevation * 180 / Math.PI), (e) => setSun(light.azimuth, e));
  if (meadowScene) {   // the wind (wind.js): the direction it blows toward, and how hard (x the grass's lean)
    row('Wind dir', 0, 360, Math.round(((wind.angle * 180) / Math.PI + 360) % 360), (a) => { wind.angle = a; }, { sun: false });
    row('Wind', 0, 200, Math.round(wind.strength * 100), (k) => { wind.strength = k; }, { unit: '%', scale: 0.01, sun: false });
  }
  if (meadowScene) {   // grass from the patches' seeds (grass.js)
    const b = document.createElement('button');
    const label = () => { b.textContent = grass.on ? 'Grass: on' : 'Grass: off'; b.style.background = grass.on ? '#1b5e20' : '#333'; };
    b.style.cssText = 'margin-top:4px; color:#fff; border:none; border-radius:4px; padding:4px 8px; cursor:pointer;';
    label();
    b.addEventListener('click', () => { grass.on = !grass.on; label(); b.blur(); pendingDraw = true; });
    box.append(b);
    const wb = document.createElement('button');   // the wind (wind.js): the blades and the grass edge's tufts sway in waves
    const wLabel = () => { wb.textContent = wind.on ? 'Wind: on' : 'Wind: off'; wb.style.background = wind.on ? '#1b5e20' : '#333'; };
    wb.style.cssText = b.style.cssText;
    wLabel();
    wb.addEventListener('click', () => { wind.on = !wind.on; wLabel(); wb.blur(); pendingDraw = true; });
    box.append(wb);
    const tb = document.createElement('button');   // the blades' style: shaded tips only (a texture) or whole leaves
    const tLabel = () => { tb.textContent = grass.faces ? 'Grass: faces' : grass.tips ? 'Grass: tips' : 'Grass: leaves'; tb.style.background = grass.faces || grass.tips ? '#1b5e20' : '#333'; };
    tb.style.cssText = b.style.cssText;
    tLabel();
    tb.addEventListener('click', () => {   // faces -> tips -> leaves -> faces
      if (grass.faces) { grass.faces = false; grass.tips = true; } else if (grass.tips) grass.tips = false; else grass.faces = true;
      tLabel(); tb.blur(); pendingDraw = true;
    });
    box.append(tb);
    const sb = document.createElement('button');   // the grass edge's spikes along silhouettes and shade borders (illusionRender.js)
    const sLabel = () => { sb.textContent = silhouette.spikes ? 'Spikes: on' : 'Spikes: off'; sb.style.background = silhouette.spikes ? '#1b5e20' : '#333'; };
    sb.style.cssText = b.style.cssText;
    sLabel();
    sb.addEventListener('click', () => { silhouette.spikes = !silhouette.spikes; sLabel(); sb.blur(); pendingDraw = true; });
    box.append(sb);
    const hint = document.createElement('div');
    hint.textContent = 'E: dig   R: place a cube (at the cross)   Enter: walk / fly';
    hint.style.cssText = 'font-size:12px; opacity:0.8; margin-top:2px;';
    box.append(hint);
    const reset = document.createElement('button');
    reset.textContent = 'Reset ground';
    reset.style.cssText = 'margin-top:4px; color:#fff; background:#333; border:none; border-radius:4px; padding:4px 8px; cursor:pointer;';
    reset.addEventListener('click', () => {
      try { localStorage.removeItem('gatomica.groundEdits'); } catch (err) { /* nothing saved */ }
      buildMeadowScene({ edits: null });
      reset.blur(); pendingDraw = true;
    });
    box.append(reset);
    // The grid of cubes (grid.js): dig / place at the screen's center.
    window.addEventListener('keydown', (e) => {
      if (e.repeat || e.target instanceof HTMLInputElement) return;
      if (e.code === 'KeyE' || e.code === 'KeyR') {
        if (editGround(e.code === 'KeyE' ? 'dig' : 'place')) {
          try { localStorage.setItem('gatomica.groundEdits', JSON.stringify(groundEdits())); } catch (err) { /* not saved */ }
        }
        pendingDraw = true;
      }
    });
  }
  document.body.append(box);
}

// Roundness slider (shells scene only): the curved pane, from flat (0) to a dome.
const roundBox = document.getElementById('roundBox');
if (roundBox && shellScene && paneId) {
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
  if (illusionScene) { if (angleLabel) angleLabel.textContent = flyStatus(); return; }
  if (!angleSlider) return;
  const a = ((camera.orbitAngle % TWO_PI) + TWO_PI) % TWO_PI;
  angleSlider.value = a;
  angleLabel.textContent = a.toFixed(3);
}
if (illusionScene) {   // no orbit: the bottom bar shows the fly camera instead of the angle slider
  if (angleSlider) angleSlider.style.display = 'none';
  if (angleLabel) { angleLabel.style.flex = '1'; angleLabel.style.textAlign = 'left'; }
  if (angleLabel && angleLabel.previousElementSibling) angleLabel.previousElementSibling.textContent = 'Click to look (Esc to release) · WASD move (Q sprint) · Space / Shift up / down · wheel zoom';
  if (pauseBtn && !animScene) pauseBtn.style.display = 'none';   // in the world and the meadow it freezes the movers
}
if (angleSlider && !illusionScene) {
  angleSlider.addEventListener('input', () => {
    paused = true;
    if (pauseBtn) pauseBtn.textContent = 'Resume';
    camera.orbitAngle = Number(angleSlider.value);
    angleLabel.textContent = Number(angleSlider.value).toFixed(3);
    drawFrame();
  });
}

let lastTime = 0, lastTime0 = 0;
function loop(timestamp) {
  if (!frameDue(timestamp)) { requestAnimationFrame(loop); return; }   // capped: not this refresh (dt then spans the skipped ones)
  if (illusionScene) {
    const dt = Math.min((timestamp - lastTime) / 1000, 0.1);
    lastTime = timestamp;
    if (animScene) {   // the movers move: every frame, unless paused with the camera still (then nothing is redrawn)
      if (!paused) worldTime += dt;
      const moved = updateFly(dt);
      if (paused && !moved && !pendingDraw) { lastTime0 = 0; requestAnimationFrame(loop); return; }
      pendingDraw = false;
      if (lastTime0) { frameTimes.push(timestamp - lastTime0); if (frameTimes.length > 30) frameTimes.shift(); }
      lastTime0 = timestamp;
      drawFrame(); trackFrame(timestamp);
      if (uiDue(timestamp)) { syncAngleUi(); showStats(); }
    } else if (updateFly(dt) || pendingDraw) { pendingDraw = false; drawFrame(); trackFrame(timestamp); if (uiDue(timestamp)) syncAngleUi(); }
  } else if (!paused) {
    const dt = (timestamp - lastTime) / 1000;
    lastTime = timestamp;
    camera.orbitAngle += dt * 0.4;
    drawFrame(); trackFrame(timestamp);
    syncAngleUi();
  } else {
    lastTime = timestamp;
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
