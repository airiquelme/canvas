// The illusion renderer's light: one sun (a direction), stylized. Nothing here is per-pixel 3D shading: shapes that opt in get a
// shade crescent on their far side, the rest lit (two tones; illusionRender.js, shape.js), and the ground gets the
// shadow field's regions (shadow.js), computed in world space so they look the same from every angle.
//
// light.dir: unit vector TOWARD the sun (y up), from azimuth (around y, from +x toward +z) and elevation (above the horizon).
export const light = { on: true, azimuth: 2.4, elevation: 0.2, dir: null, version: 0 };

export function setSun(azimuth = light.azimuth, elevation = light.elevation) {
  light.azimuth = azimuth;
  light.elevation = elevation;
  const c = Math.cos(elevation);
  light.dir = { x: c * Math.cos(azimuth), y: Math.sin(elevation), z: c * Math.sin(azimuth) };
  light.shadeK = shadeStrength(elevation);
  const { tint, bright } = sunTone(elevation);
  light.tint = tint;                       // the sun's hue (0-1 per channel): lit AND shade tones are multiplied by it
  light.bright = bright;                   // the lit tone's brightness
  { const u = Math.max(0, Math.min(1, elevation / FADE_ELEV)); light.litFade = 1 - u * u * (3 - 2 * u); }
  light.version++;
}

// CONTRAST by the sun's height: how far a shade goes toward the shade color. Near the lit tone at midday (SHADE_NOON from
// NOON_ELEV up), much darker toward the horizon (SHADE_DUSK at it), smoothly in between (smoothstep); below the horizon everything
// is in shade, deepening to SHADE_NIGHT by NIGHT_ELEV (the end of twilight). Every shade (ground, cast shadows, crescents, blades)
// uses this one strength.
const SHADE_NOON = 0.12, SHADE_DUSK = 0.62, SHADE_NIGHT = 0.84, NOON_ELEV = Math.PI / 3, NIGHT_ELEV = -0.15;
function shadeStrength(elevation) {
  if (elevation < 0) {   // after sunset: on to SHADE_NIGHT by NIGHT_ELEV below the horizon (lamps show)
    const u = Math.min(1, elevation / NIGHT_ELEV), s = u * u * (3 - 2 * u);
    return SHADE_DUSK + (SHADE_NIGHT - SHADE_DUSK) * s;
  }
  const u = Math.max(0, Math.min(1, elevation / NOON_ELEV)), s = u * u * (3 - 2 * u);
  return SHADE_DUSK + (SHADE_NOON - SHADE_DUSK) * s;
}

// SUN TONE by the sun's height: its hue (a slight yellow at midday, orange low, red at the horizon) tints every tone, lit and
// shade alike, so the two always match; the lit tone is also times the brightness (dimmer as it sets). Smoothstep between keys.
// [elevation (rad), rgb, brightness]
const SUN_KEYS = [[0, [255, 140, 92], 0.62], [0.08, [255, 170, 118], 0.74], [0.2, [255, 205, 156], 0.86], [0.45, [255, 232, 196], 0.95],
  [Math.PI / 3, [255, 244, 222], 1]];
// FADE: below FADE_ELEV the lit tone also blends into the shade tone (all of it at the horizon), so sunset has no jump when
// everything turns to shade.
const FADE_ELEV = 0.1;
// TWILIGHT: from the horizon down to NIGHT_ELEV the sun is gone but its light still scatters in the atmosphere: the horizon's
// tint stays on the (all-shade) world and fades out (smoothstep) as night falls; after that the tones are their own colors' shade.
const smooth = (u) => { u = Math.max(0, Math.min(1, u)); return u * u * (3 - 2 * u); };
function sunTone(elevation) {
  const hue = (k) => k[1].map((v) => v / 255);
  if (elevation <= 0) {
    const s = smooth(1 - elevation / NIGHT_ELEV), h = hue(SUN_KEYS[0]);   // 1 at the horizon, 0 at the end of twilight
    return { tint: h.map((v) => 1 + (v - 1) * s), bright: SUN_KEYS[0][2] };
  }
  for (let i = 1; i < SUN_KEYS.length; i++) if (elevation <= SUN_KEYS[i][0]) {
    const A = SUN_KEYS[i - 1], B = SUN_KEYS[i], t = smooth((elevation - A[0]) / (B[0] - A[0])), a = hue(A), b = hue(B);
    return { tint: a.map((v, j) => v + (b[j] - v) * t), bright: A[2] + (B[2] - A[2]) * t };
  }
  const k = SUN_KEYS[SUN_KEYS.length - 1];
  return { tint: hue(k), bright: k[2] };
}

// Tones: the shade mixes toward a dusky blue, then everything is times the sun's tint (cached per sun).
const SHADE = [26, 35, 64];
const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const toHex = (c) => { const r = c.map((v) => Math.max(0, Math.min(255, Math.round(v)))); return '#' + ((1 << 24) | (r[0] << 16) | (r[1] << 8) | r[2]).toString(16).slice(1); };
// Per channel, shade = A c + B and lit = Lf c + w B (A = tint (1 - k), B = tint k SHADE, Lf = tint (b (1 - w) + (1 - k) w),
// w = litFade): both linear in the color c.
const shadeRgb = (c) => c.map((v, i) => light.tint[i] * (v * (1 - light.shadeK) + SHADE[i] * light.shadeK));
let shadeCache = new Map(), shadeCacheV = -1;
export function shadeOf(hex) {
  if (shadeCacheV !== light.version) { shadeCache = new Map(); shadeCacheV = light.version; }
  let v = shadeCache.get(hex);
  if (!v) shadeCache.set(hex, (v = toHex(shadeRgb(rgb(hex)))));
  return v;
}
// The lit tone: the color in the sun's light (unchanged with the light off). Cached per sun.
let litCache = new Map(), litCacheV = -1;
export function litOf(hex) {
  if (!light.on) return hex;
  if (litCacheV !== light.version) { litCache = new Map(); litCacheV = light.version; }
  let v = litCache.get(hex);
  if (!v) {
    const c = rgb(hex), w = light.litFade, sh = shadeRgb(c);
    litCache.set(hex, (v = toHex(c.map((x, i) => x * light.tint[i] * light.bright * (1 - w) + sh[i] * w))));
  }
  return v;
}
// The cast shadow as an overlay over lit ground of ANY color, exactly its shade tone: lit = Lf c + w B, so multiplying by
// m = (1 - k) / (b (1 - w) + (1 - k) w) (the same for every channel) and adding D = B (1 - w m) gives A c + B. Two fills of the
// same path: 'multiply' by gray m, then 'lighter' with D.
export function shadeOverlay() {
  const k = light.shadeK, w = light.litFade, m = Math.min(1, (1 - k) / (light.bright * (1 - w) + (1 - k) * w));
  const g = Math.round(m * 255);
  return [
    { op: 'multiply', color: `rgb(${g}, ${g}, ${g})` },
    { op: 'lighter', color: toHex(SHADE.map((v, i) => light.tint[i] * k * v * (1 - w * m))) },
  ];
}
setSun();
