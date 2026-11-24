// The player's character (the meadow): a 3D stick figure in skin tone (clothing comes later), all of it one connected body: a ball
// for the head on a neck, a shoulder bar and a hip bar joined by the spine, two-segment arms from the shoulders' ends and legs from
// the hips' ends. Every part is a capsule of one radius and neighbors share their end points, so the joints are closed; the
// limbs are lit as tubes (`shade.tube`: the shade runs along each stick), and each part's shade crescent is cut as the joined
// shape's (`links`, illusionRender.js LINKED SHADE), so it runs on across a joint where both sides agree.
// `buildFigure`: the player, standing where the walk mode's body is (flyCamera.js `walk.body`, its feet; `walk.yaw` its facing;
// `walk.phase` / `walk.gait` the stride); every part is a mover (`move` reads that state every frame), so it is drawn, shaded and
// casts its shadow like the meadow's logs and balls. `buildStaticFigure`: the same body, posed once, as static objects (a copy to
// look at from any side).
import { walk } from '../core/flyCamera.js';

export const SKIN = '#eac4a5';
const STICK = 0.018, HEAD = 0.075;   // radii, in body heights
// proportions, in body heights: hip and shoulder half-widths, spine (hips to the neck's base), neck (to the head's center), limbs
const HIP_W = 0.07, SHOULDER_W = 0.11, SHOULDER_DROP = 0.015, SPINE = 0.3, NECK = 0.11, THIGH = 0.25, SHIN = 0.25, UPPER = 0.17, FORE = 0.16;

// The figure's parts and a function posing them: pose(state), state = { body (feet), yaw, phase, gait (0 standing .. 1 walking), air }.
function makeFigure(h, extra) {
  const r = STICK * h;
  const part = (rr) => ({ a: { c: { x: 0, y: 0, z: 0 }, r: rr }, b: { c: { x: 0, y: 0, z: 0 }, r: rr }, fill: SKIN, shade: { r: rr, tube: rr === r }, onGround: true, ...extra });
  const head = part(HEAD * h), neck = part(r), spine = part(r), shoulders = part(r), hips = part(r);
  const arms = [0, 1].map(() => [part(r), part(r)]), legs = [0, 1].map(() => [part(r), part(r)]);
  // LINKS (illusionRender.js LINKED SHADE): which parts are joined, so the shade runs on across a joint as on one shape
  const link = (A, B) => { (A.links ||= []).push(B); (B.links ||= []).push(A); };
  link(head, neck); link(neck, spine); link(spine, shoulders); link(spine, hips);
  for (const [u, f] of arms) { link(shoulders, u); link(u, f); }
  for (const [t, sh] of legs) { link(hips, t); link(t, sh); }
  const parts = [head, neck, spine, shoulders, hips, ...arms.flat(), ...legs.flat()];

  // Every point in the body's frame (forward f, up u, right s, in body heights).
  const pose = ({ body: B, yaw, phase: ph, gait: g, air }) => {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const at = (f, u, s) => ({ x: B.x + (f * cy - s * sy) * h, y: B.y + u * h, z: B.z + (f * sy + s * cy) * h });
    // legs: swung forward by th, the knee bent while the leg swings forward
    const legVec = (i) => {
      const s = i ? -1 : 1, th = s * 0.5 * g * Math.sin(ph) + air * (i ? 0.35 : -0.15);
      const flex = g * 0.9 * Math.max(0, s * Math.cos(ph)) + air * 0.7;
      const kf = THIGH * Math.sin(th), ku = -THIGH * Math.cos(th);
      return { kf, ku, sf: kf + SHIN * Math.sin(th - flex), su: ku - SHIN * Math.cos(th - flex) };
    };
    const L = [legVec(0), legVec(1)];
    const hipU = Math.max(-L[0].su, -L[1].su);   // the lower foot on the ground: the body bobs with the stride
    const baseU = hipU + SPINE, shU = baseU - SHOULDER_DROP;
    const hipMid = at(0, hipU, 0), base = at(0.01, baseU, 0), headC = at(0.015, baseU + NECK, 0);
    hips.a.c = at(0, hipU, HIP_W); hips.b.c = at(0, hipU, -HIP_W);
    spine.a.c = hipMid; spine.b.c = base;
    shoulders.a.c = at(0.01, shU, SHOULDER_W); shoulders.b.c = at(0.01, shU, -SHOULDER_W);
    neck.a.c = base; neck.b.c = headC;
    head.a.c = head.b.c = headC;
    legs.forEach(([thigh, shin], i) => {
      const v = L[i], s = i ? -1 : 1;
      thigh.a.c = i ? hips.b.c : hips.a.c;
      thigh.b.c = shin.a.c = at(v.kf, hipU + v.ku, s * HIP_W * 1.05);
      shin.b.c = at(v.sf, hipU + v.su, s * HIP_W * 1.1);
    });
    // arms: from the shoulders' ends, swung against the legs, elbows a little bent (raised in the air)
    arms.forEach(([upper, fore], i) => {
      const s = i ? -1 : 1;
      const th = -s * 0.45 * g * Math.sin(ph) + air * 0.9, out = 0.12 + air * 0.4;
      const ef = 0.01 + UPPER * Math.sin(th) * Math.cos(out), eu = shU - UPPER * Math.cos(th) * Math.cos(out), es = s * (SHOULDER_W + UPPER * Math.sin(out));
      const bend = th + 0.35 + 0.3 * g;
      upper.a.c = i ? shoulders.b.c : shoulders.a.c;
      upper.b.c = fore.a.c = at(ef, eu, es);
      fore.b.c = at(ef + FORE * Math.sin(bend), eu - FORE * Math.cos(bend), es + s * 0.015);
    });
  };
  return { parts, pose };
}

// height: the body's height in world units (player.height cubes); groundAt(x, z): the ground under the feet; start: where the
// figure stands until the walk mode moves it ({ x, z, yaw }).
export function buildFigure({ height, groundAt, start }) {
  if (!walk.body) {
    walk.body = { x: start.x, y: groundAt(start.x, start.z), z: start.z };
    walk.yaw = start.yaw;
  }
  const { parts, pose } = makeFigure(height);
  // every part's move redoes the pose (a few dozen trig calls)
  const move = () => pose({ body: walk.body, yaw: walk.yaw, phase: walk.phase, gait: walk.gait, air: walk.on && !walk.grounded ? 1 : 0 });
  for (const p of parts) p.move = move;
  return parts;
}

// The same body standing at x, z facing yaw, as static objects. gait / phase: a stride to hold (default: standing).
export function buildStaticFigure({ height, groundAt, x, z, yaw, gait = 0, phase = 0 }) {
  const { parts, pose } = makeFigure(height);
  pose({ body: { x, y: groundAt(x, z), z }, yaw, phase, gait, air: 0 });
  return parts;
}
