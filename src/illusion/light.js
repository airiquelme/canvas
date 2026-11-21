// The illusion renderer's light: one sun (a direction), stylized. Nothing here is per-pixel 3D shading: shapes that opt in get a
// shade crescent on their far side and a bright crescent toward the sun (illusionRender.js, shape.js), and the ground gets the
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
  light.version++;
}

// CONTRAST by the sun's height: how far a shade goes toward the shade color. Near the lit tone at midday (SHADE_NOON from
// NOON_ELEV up), much darker toward the horizon (SHADE_DUSK at it), smoothly in between (smoothstep); below the horizon everything
// is in shade at SHADE_DUSK (the light is out). Every shade (ground, cast shadows, crescents, blades) uses this one strength.
const SHADE_NOON = 0.12, SHADE_DUSK = 0.62, SHADE_NIGHT = 0.84, NOON_ELEV = Math.PI / 3, NIGHT_ELEV = -0.15;
function shadeStrength(elevation) {
  if (elevation < 0) {   // after sunset: on to SHADE_NIGHT by NIGHT_ELEV below the horizon (lamps show)
    const u = Math.min(1, elevation / NIGHT_ELEV), s = u * u * (3 - 2 * u);
    return SHADE_DUSK + (SHADE_NIGHT - SHADE_DUSK) * s;
  }
  const u = Math.max(0, Math.min(1, elevation / NOON_ELEV)), s = u * u * (3 - 2 * u);
  return SHADE_DUSK + (SHADE_NOON - SHADE_DUSK) * s;
}

// Tones: the shade mixes toward a dusky blue, the bright side toward white (cached per color).
const SHADE = [26, 35, 64], BRIGHT_K = 0.28;
// The shade as an overlay: this over any color at its alpha gives exactly shadeOf(color) (a cast shadow on mixed ground).
export const shadeOverlay = () => `rgba(${SHADE[0]}, ${SHADE[1]}, ${SHADE[2]}, ${light.shadeK.toFixed(3)})`;
const cache = new Map();
function mix(hex, to, k) {
  const n = parseInt(hex.slice(1), 16), c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const r = c.map((v, i) => Math.round(v + (to[i] - v) * k));
  return '#' + ((1 << 24) | (r[0] << 16) | (r[1] << 8) | r[2]).toString(16).slice(1);
}
let shadeCache = new Map(), shadeCacheK = -1;   // shade tones for the current strength (reset when it changes)
export function shadeOf(hex) {
  if (shadeCacheK !== light.shadeK) { shadeCache = new Map(); shadeCacheK = light.shadeK; }
  let v = shadeCache.get(hex);
  if (!v) shadeCache.set(hex, (v = mix(hex, SHADE, light.shadeK)));
  return v;
}
export function brightOf(hex) {
  const key = 'b' + hex;
  let v = cache.get(key);
  if (!v) cache.set(key, (v = mix(hex, [255, 255, 255], BRIGHT_K)));
  return v;
}

setSun();
