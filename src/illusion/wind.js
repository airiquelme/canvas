// WIND: a smooth field over the ground, moving with time, that LEANS the grass (grass.js: the blades; illusionRender.js: the grass
// edge's tufts). At a ground point (x, z) and time t it gives a lean: a horizontal vector whose length is the tilt angle (radians)
// and whose direction is where the tip goes. Close points lean alike (every term is a long wave over the ground, nothing per blade),
// so gusts are seen rolling across the meadow as waves.
//   - GUSTS: a wave GUST_LEN long travelling downwind at GUST_SPEED; squared, so the gusts are narrower than the lulls between them;
//   - a shorter wave travelling a little off the wind's direction (a second set of gusts crossing the first: the fronts are not
//     straight lines).
// The lean always points DOWNWIND (`wind.angle`): only its strength varies. (A sideways flutter, tried first, turned it up to about
// 35 degrees either way in the lulls: the grass seemed to move every which way.)
// A blade keeps its length: tilted by angle th toward u, its height h becomes h cos th and its tip moves h sin th along u.

export const wind = { on: true, angle: 0.8, strength: 1 };   // angle: the direction the wind blows TOWARD (x, z), radians; strength: x the leans

const TAU = 2 * Math.PI;
const GUST_LEN = 420, GUST_SPEED = 55;            // world units, units per second
const CROSS_LEN = 170, CROSS_SPEED = 38, CROSS_TURN = 0.5;
const CALM = 0.12, GUST = 0.3, CROSS = 0.1;   // radians: always, at a gust's peak, the crossing wave

// The field at time t: (x, z) => [lx, lz] (the lean, radians), or null without wind.
export function windAt(t) {
  if (!wind.on || !(wind.strength > 0)) return null;
  const a = wind.angle, s = wind.strength, dx = Math.cos(a), dz = Math.sin(a);
  const cx = Math.cos(a + CROSS_TURN), cz = Math.sin(a + CROSS_TURN);
  const o1 = GUST_SPEED * t, o2 = CROSS_SPEED * t;
  return (x, z) => {
    const g = 0.5 + 0.5 * Math.sin((TAU * (x * dx + z * dz - o1)) / GUST_LEN);
    const c = 0.5 + 0.5 * Math.sin((TAU * (x * cx + z * cz - o2)) / CROSS_LEN);
    const lean = s * (CALM + GUST * g * g + CROSS * c);
    return [dx * lean, dz * lean];
  };
}
