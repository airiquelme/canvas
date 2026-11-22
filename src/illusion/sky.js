// The sky (stylized, light.js's sun): a vertical gradient from the zenith color down to the horizon color, placed where the true
// horizon is on screen (it follows the view's pitch), the colors by the sun's height (midday blues, sunset orange under a dimmer
// blue, night), and optionally the sun's disc with a soft glow. Drawn as the frame's background, in design space.

// [elevation (rad), zenith, horizon, sun disc]
const KEYS = [
  [-0.25, [8, 12, 32], [20, 26, 52], [255, 200, 140]],
  [-0.03, [24, 30, 70], [70, 60, 90], [255, 150, 80]],
  [0.06, [58, 82, 140], [246, 160, 92], [255, 170, 90]],
  [0.25, [72, 128, 205], [214, 200, 170], [255, 225, 170]],
  [0.6, [70, 140, 220], [190, 222, 245], [255, 250, 225]],
];
const mixC = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const css = (c, a = 1) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;

export function skyColors(elevation) {
  if (elevation <= KEYS[0][0]) return { zenith: KEYS[0][1], horizon: KEYS[0][2], sun: KEYS[0][3] };
  for (let i = 1; i < KEYS.length; i++) {
    if (elevation <= KEYS[i][0]) {
      const a = KEYS[i - 1], b = KEYS[i], t = (elevation - a[0]) / (b[0] - a[0]), s = t * t * (3 - 2 * t);
      return { zenith: mixC(a[1], b[1], s), horizon: mixC(a[2], b[2], s), sun: mixC(a[3], b[3], s) };
    }
  }
  const k = KEYS[KEYS.length - 1];
  return { zenith: k[1], horizon: k[2], sun: k[3] };
}

// The sky's terms for this frame (shared by the backends): the gradient's colors and vertical span (design y: g0 at zenith, the
// 0.75 stop, g1 = the horizon), and the sun's disc and glow ({ x, y, r, color } or null). view: the visible design rectangle.
export function skyParams(view, { projectPoint, camPos, forward, light, sunDisc = true }) {
  const { zenith, horizon, sun } = skyColors(light.on ? light.elevation : 0.6);
  // The horizon on screen: a far point straight ahead, level with the eye.
  const fh = Math.hypot(forward.x, forward.z) || 1;
  const far = { x: camPos.x + (forward.x / fh) * 1e6, y: camPos.y, z: camPos.z + (forward.z / fh) * 1e6 };
  let hy = projectPoint(far).y;
  if (!Number.isFinite(hy)) hy = (view.y0 + view.y1) / 2;
  const top = Math.min(view.y0, hy - 1), span = Math.max(1, hy - top);
  const P = { zenith, mid: mixC(zenith, horizon, 0.55), horizon, g0: hy - span * 1.4, g1: hy, sun: null };
  if (!sunDisc || !light.on) return P;
  const L = light.dir, sp = { x: camPos.x + L.x * 1e5, y: camPos.y + L.y * 1e5, z: camPos.z + L.z * 1e5 };
  if (L.x * forward.x + L.y * forward.y + L.z * forward.z <= 0.05) return P;   // behind the eye
  const q = projectPoint(sp);
  if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) return P;
  P.sun = { x: q.x, y: q.y, r: 16, color: sun };
  return P;
}

// ctx in design space; view: the visible design rectangle; projectPoint, camPos, basis (forward) of this frame; sun: light.
export function drawSky(ctx, view, opts) {
  const P = skyParams(view, opts);
  const g = ctx.createLinearGradient(0, P.g0, 0, P.g1);
  g.addColorStop(0, css(P.zenith));
  g.addColorStop(0.75, css(P.mid));
  g.addColorStop(1, css(P.horizon));
  ctx.fillStyle = g;
  ctx.fillRect(view.x0, view.y0, view.x1 - view.x0, view.y1 - view.y0);
  if (!P.sun) return;
  const { x, y, r, color } = P.sun;
  const glow = ctx.createRadialGradient(x, y, r * 0.8, x, y, r * 6);
  glow.addColorStop(0, css(color, 0.45));
  glow.addColorStop(1, css(color, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(x - r * 6, y - r * 6, r * 12, r * 12);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = css(color);
  ctx.fill();
}
