// The player's character (the meadow): a 3D figure in skin tone (clothing comes later), all of it one connected body built as
// OPTICAL ILLUSIONS, not 3D proxies: every part is a smooth closed outline that is the exact perspective image of a solid (half
// ellipsoids sharing a section, eggs closing onto their joints' balls, hulls of ellipsoids: egg.js), so it LOOKS like the body from
// the camera. A head and neck, a torso (chest, pelvis and shoulders in one hull), two-segment arms with mittens and legs with feet.
// The parts share one `body` tag: illusionRender.js (FLAT BODIES) draws them as ONE shape (their loops in one path, filled nonzero)
// in one flat tone. Each part keeps a capsule inside it (its joints' balls) that only bounds it and casts its shadow (`casts`).
// A temporary red SKELETON (the joints and bones, `body.joints` / BONES) is drawn over it.
// `buildFigure`: the player, standing where the walk mode's body is (flyCamera.js `walk.body`, its feet; `walk.yaw` its facing;
// `walk.phase` / `walk.gait` the stride); every part is a mover (`move` reads that state every frame), so it is drawn, shaded and
// casts its shadow like the meadow's logs and balls. `buildStaticFigure`: the same body, posed once, as static objects (a copy to
// look at from any side).
import { walk } from '../core/flyCamera.js';
import { ovoidSides, hullOfEllipsoids, eggSides } from './egg.js';
import { filletSides } from './blend.js';

export const SKIN = '#eac4a5';
const STICK = 0.018;   // the joints' balls' radius at the elbows, shoulders and ankles, in body heights (the head's top at 1)
// PROPORTIONS, in body heights, from anthropometric tables (Drillis & Contini, as in Winter's Biomechanics): standing, the ankle at
// 0.039, knee 0.285, hip joint 0.53, shoulder joint 0.818, the neck's base (C7) 0.83, the head's center 0.935; thigh 0.245, shank
// 0.246, upper arm 0.186, forearm 0.146; hip joints about 0.1 apart, shoulder joints about 0.24. Hip and shoulder half-widths, the
// spine (hip joints' middle to the neck's base), the neck (to the head's center), the shoulders' drop below the neck's base. Standing,
// the knees are closer than the hip joints (the femurs slope in) and the ankles a little apart (KNEE_W, ANKLE_W: half-widths).
const HIP_W = 0.05, KNEE_W = 0.034, ANKLE_W = 0.04, SHOULDER_W = 0.12, SHOULDER_DROP = 0.012, SPINE = 0.3, NECK = 0.105, ANKLE = 0.039,
  THIGH = 0.245, SHIN = 0.246, UPPER = 0.186, FORE = 0.146;
// MITTENS (anthropometric: hand length 0.108, breadth at the knuckles 0.055, wrist 0.036; the knuckles 0.058 from the wrist; the
// thumb's knuckle (its MCP joint, the thumb held against the hand) about 0.04 from the wrist, on the thumb's side and toward the
// palm: with the ball of the thumb under it, it makes the lower hand its thickest part): each an OVOID (egg.js; kind 'disc' with
// `ovoid`, illusionRender.js), two half ellipsoids sharing their widest and thickest cross-section at the thumb knuckle's level,
// its middle drawn toward it (THUMB_PULL along the thumb's side and the palm's), the palm facing the body. The long half runs to the
// fingertips (its width at the knuckles their breadth), the short one back into the forearm (its width at the wrist the
// forearm's there, WRIST_R). Its outline is the hull of the ovoid and the wrist's ball (egg.js): seen from the front, where the
// hand is thinner than the wrist, it runs straight on from the wrist to the thick of the hand. On screen ONE smooth closed curve
// from every side.
// EGGS (egg.js): a limb widest at `at` from its start (half-width B), closing onto each joint as a ball (the stick's radius STICK;
// the forearm's wrist end WRIST_R, the wrist's half-thickness: slimmer than the elbow): no crease, nothing past the joint. In body
// heights:
// - FOREARM (anthropometric: breadth 0.045 at its widest, a third of the way from the elbow);
// - UPPER ARM (breadth about 0.05 at the deltoid, a quarter of the way from the shoulder).
const FOREARM_EGG = { at: FORE / 3, B: 0.0225 }, UPPER_EGG = { at: UPPER / 4, B: 0.025 }, WRIST_R = 0.015;
const PALM = 0.058, HAND = 0.108, THUMB_K = { along: 0.04, side: 0.022, palm: 0.009 }, THUMB_PULL = 0.003;
const HAND_BN = 0.0135;   // the half-thickness at the thumb knuckle's level
const HAND_A2 = HAND - THUMB_K.along, HAND_BW = 0.0275 / Math.sqrt(1 - ((PALM - THUMB_K.along) / HAND_A2) ** 2);
const HAND_A1 = THUMB_K.along / Math.sqrt(1 - (WRIST_R / HAND_BW) ** 2);
// THE REST OF THE BODY, the same way (body heights; anthropometric breadths and depths, as tables give them, halved):
// - TORSO (a FIT build: lean, smooth, no fat folds; a V from the armpits to the waist): each part designed on its own (its own
//   proportions: character creation) and placed along the SPINE, one smooth curve (a circular arc of length SPINE from the hip
//   joints' middle to the neck's base, bent by `bend` { f: forward, s: sideways, total radians; no vertebrae):
//   - the CHEST (the ribcage with the lats and pecs: an OVOID along the spine, widest at the armpits' level, breadth 0.186, depth
//     0.116, a little ahead of the spine; its lower half tapers into the waist);
//   - the ABDOMEN (an OVOID along the spine at the waist, rounder than the ribcage: breadth 0.128, depth 0.092), set FORWARD so
//     its back stays inside the line from the ribcage's back to the buttocks: it shapes the waist's front and sides only;
//   - the PELVIS (an OVOID upright on the hips, widest at the iliac crests' breadth 0.16 above the hip joints (the hips' greatest
//     breadth is the thighs' tops), 0.086 deep: from the side the front runs flat from the chest down to the groin, the back
//     straight down to the buttocks; its bottom at the crotch);
//   - a YOKE over the chest (the HULL of the shoulders' balls and the neck's base: the trapezius sloping from the neck to the
//     shoulders; the image of a 3D convex hull is the hull of the images). Its shoulder balls are the upper arms' own (STICK at
//     the shoulder joints): the yoke meets each arm exactly at its joint, nothing past it;
//   - the LATS (latissimus dorsi, the upper torso's sides): per side, the HULL of the shoulder joint's ball and a small ball on
//     the lower ribcage's side, at its back (LAT): the V from the armpit down to the waist; filleted to the ribcage and abdomen;
//   - the PECS (pectoralis major): per side, the HULL of the shoulder joint's ball and a flat ellipsoid on the ribcage's front
//     (PEC): the line from the armpit to the chest; its lower edge meets the ribcage at a crease (no fillet), as the muscle's;
//   - FEMALE (`form.female`): a modest BREAST on each pec (BREAST: centered near the nipple's level, 0.715, about 0.1 apart,
//     turned out by `out`; its lower half hanging a little), in a HULL with a flat ANCHOR above it on the chest: the upper slope
//     runs smoothly from the chest into it, the fold under it stays a crease.
//   THE RULE: every part is CONVEX; every concave curve is a FILLET where two parts' outlines cross (blend.js: an ellipse arc tangent
//   to both, WAIST_FILLET long on each, on screen), so it stays one smooth line whatever the (smooth) bend or the parts' sizes. The
//   waist's sides are the chest's, abdomen's and pelvis's fillets; the LUMBAR ARCH (lordosis, about 0.011 deep) is the fillet where
//   the ribcage's back crosses the pelvis's and the buttocks' (nothing between them at the back): it flattens when bending forward
//   and deepens bending back, by itself. The ribcage's join is to follow the same rule;
// - HEAD: an OVOID up the body (the cranium the short half, the jaw the long one: an egg narrowing to the chin), widest across at
//   the section (breadth 0.087, length 0.11), the head's top at 1;
// - NECK: an EGG from the neck's base (C7) to the head's center (breadth about 0.056), its ends inside the torso and the head;
// - THIGH: an EGG widest at its top (breadth 0.1 at the crotch's level, where the hips are widest: the greater trochanters), so
//   standing the thighs touch (no gap); closing onto the hip joint's ball (HIP_R, inside the pelvis) and the knee's (KNEE_R: knee
//   breadth about 0.054); FILLETED on screen to the pelvis (THIGH_EGG.toPelvis: the hips' side runs on from the waist into the
//   thigh);
// - BUTTOCKS (gluteus maximus: from the pelvis's back to the femur), each part of its THIGH: an ellipsoid hanging off the hip joint
//   (GLUTE: its middle `back` behind, `down` under and `in` toward the middle from the hip joint; half-axes `depth`, `height`,
//   `width`: each cheek about 0.09 across and 0.1 tall), tilted by GLUTE.tilt (its lower part back: it sags, the fullest part
//   low, over the fold) turned with the thigh's swing by HALF its angle (the muscle runs between the pelvis and the femur): standing it bulges
//   out behind the hips, sitting it rolls under the pelvis and the thigh reads straight. Joined on screen by FILLETS (blend.js) to
//   the pelvis (GLUTE.toPelvis long: the lower back runs on into it) and to its thigh by a fillet that grows with the thigh's
//   raise (none standing or with the leg back: the fold under the buttock is a crease, nearly a right angle; GLUTE.toThigh once
//   the thigh is raised by GLUTE.foldOpen radians: the fold smooths out as the hip flexes); the two cheeks are not filleted to
//   each other (the cleft);
// - SHANK: an EGG widest at the calf (breadth 0.068, 0.28 of the way down), closing onto the knee and the ankle (STICK);
// - FOOT (length 0.152, the heel's back about 0.038 behind the ankle; breadth 0.055 at the ball of the foot, 0.04 at the heel): the
//   ankle stays off the ground and the foot SPLITS in two under it, as its bones do. The OUTER side (the lateral column: heel bone,
//   cuboid, fifth metatarsal) rests on the ground from the heel to the ball: the HULL of the ankle's ball, the HEEL (an ellipsoid
//   behind and under the ankle) and the fifth metatarsal's head (a small ball on the ground on the outside of the ball of the
//   foot), whose bottom is ONE straight line on the ground. The INNER side (the medial column, to the big toe) arches: the FOREFOOT,
//   an OVOID widest and thickest at the ball of the foot (sole on the ground there) thinning to the toes, its back half rising under
//   the ankle, in a HULL with the ankle's ball (the instep). Between the heel and the forefoot, on the inside only, the arch.
//   Joints: heel, ball (the big toe's knuckle), ballOut (the little toe's), toe tip.
const CHEST_OV = { at: 0.205, fwd: 0.006, A1: 0.14, A2: 0.12, Bw: 0.093, Bn: 0.058 };   // its widest section `at` along the spine (from the hips)
// the pelvis: its widest section `up` over the hip joints and `back` behind them (shallow in front: no belly; the hip's depth
// in the tables includes the buttocks, here GLUTE's)
const PELVIS_OV = { up: 0.03, back: 0.0, A1: 0.085, A2: 0.09, Bw: 0.08, Bn: 0.043 };
const ABDOMEN = { at: 0.1, fwd: 0.009, A1: 0.065, A2: 0.065, Bw: 0.064, Bn: 0.046 };   // its middle `at` along the spine
const WAIST_FILLET = 0.035, NECK_BASE_R = 0.035;
// (`at`: height along the spine from the hip joints' middle; `fwd` / `side` from the spine there; half-axes along f, u, s)
const LAT = { at: 0.115, side: 0.062, fwd: -0.008, r: 0.014 }, LAT_SHOULDER_R = 0.014;
const PEC = { at: 0.22, side: 0.045, fwd: 0.055, ax: [0.016, 0.035, 0.045] };
const BREAST = { at: 0.185, side: 0.05, fwd: 0.06, ax: [0.019, 0.037, 0.041], out: 0.3, sag: 0.25,
  anchor: { at: 0.22, side: 0.048, fwd: 0.056, ax: [0.01, 0.025, 0.04] } };
const HEAD_OV = { up: 0.01, back: 0.005, A1: 0.075, A2: 0.058, Bw: 0.0435, Bn: 0.055 };
const NECK_EGG = { at: 0.04, B: 0.028 }, NECK_R = 0.024;
const GLUTE = { back: 0.025, down: 0.035, in: 0.008, depth: 0.036, height: 0.048, width: 0.042, tilt: -0.3, toPelvis: 0.04, toThigh: 0.035, foldOpen: 1.2 };
const THIGH_EGG = { at: 0.05, B: 0.05, toPelvis: 0.05 }, SHIN_EGG = { at: SHIN * 0.28, B: 0.034 }, HIP_R = 0.032, KNEE_R = 0.027;
// the foot's parts: { fwd: ahead of the ankle, side: outward (- inward), up: over the ground } in body heights
const HEEL = { fwd: -0.016, ax: [0.022, 0.022, 0.02] };   // its center (its bottom on the ground); half-axes along f, u, s
const BALL_OUT = { fwd: 0.072, side: 0.017, r: 0.011 };   // the fifth metatarsal's head (on the ground)
const FOREFOOT = { fwd: 0.07, side: -0.004, A1: 0.06, A2: 0.044, Bw: 0.0275, Bn: 0.0125 };   // its widest section; sole on the ground
const BALL_J = { fwd: 0.07, side: -0.012, up: 0.012 }, TOE_J = { fwd: 0.105, side: -0.006, up: 0.0125 };

// The figure's parts and a function posing them: pose(state), state = { body (feet), yaw, phase, gait (0 standing .. 1 walking), air,
// bend (the spine's: { f, s }, radians, optional) }.
function makeFigure(h, extra, form = {}) {
  const r = STICK * h;
  const body = {};   // the tag shared by the parts: drawn as one shape
  const v0 = () => ({ x: 0, y: 0, z: 0 });
  const part = (ra, rb = ra) => ({ a: { c: v0(), r: ra }, b: { c: v0(), r: rb }, fill: SKIN, body, casts: true, onGround: true, ...extra });
  // the limbs' EGGS (egg.js); each one's capsule (its joints' balls, inside the egg) only bounds it and casts its shadow
  const egg = (E, ra = r, rb = ra) => ({ ...part(ra, rb), egg: { at: E.at * h, B: E.B * h } });
  // a part drawing its own outline (`outline`, illusionRender.js): its capsule (inside it) bounds it and casts its shadow, boundR
  // covers the whole outline
  const own = (ra, rb, bound, outline) => ({ ...part(ra, rb), boundR: bound, outline });
  const grownBody = (q, g) => ({ C: q.C, axes: q.axes.map(([v, l]) => [v, l * g]) });
  const loops = (...ls) => ls.filter((l) => l.length).flatMap((l, i) => (i ? [{ ...l[0], move: true }, ...l.slice(1)] : l));
  // an ovoid's terms (set by pose) and its outline; `ball`: the joint it is wrapped with
  const ovoid = (O, ball) => ({ M: v0(), a: v0(), w: v0(), n: v0(), A1: O.A1 * h, A2: O.A2 * h, Bw: O.Bw * h, Bn: O.Bn * h, ball });
  const ovoidOut = (H) => (pr, g) => ovoidSides(H.M, H.a, H.w, H.n, H.A1 * g, H.A2 * g, H.Bw * g, H.Bn * g, pr, H.ball && { c: H.ball.c, r: H.ball.r * g });
  // the torso: chest and pelvis (filleted where they meet: the waist), the yoke; its capsule from the pelvis's middle to the chest's
  const chestOv = ovoid(CHEST_OV, null), abdomenOv = ovoid(ABDOMEN, null), pelvisOv = ovoid(PELVIS_OV, null), yoke = [];
  const upper = { lats: [], pecs: [], breasts: [] };   // per side: the bodies of each hull (set by pose)
  const latJ = [v0(), v0()], pecJ = [v0(), v0()], breastJ = [v0(), v0()];
  const torso = own(0.04 * h, 0.04 * h, 0.17 * h, (pr, g) => {
    const chest = ovoidOut(chestOv)(pr, g), abdomen = ovoidOut(abdomenOv)(pr, g), pelvis = ovoidOut(pelvisOv)(pr, g);
    const d = WAIST_FILLET * h * g * pr.projectPoint(torso.a.c).scale;
    const hull = (bodies) => hullOfEllipsoids(pr, bodies.map((b) => grownBody(b, g)));
    const lats = upper.lats.map(hull), pecs = upper.pecs.map(hull), breasts = upper.breasts.map(hull);
    return loops(chest, abdomen, pelvis, hull(yoke), ...lats, ...pecs, ...breasts,
      filletSides(chest, abdomen, d), filletSides(abdomen, pelvis, d), filletSides(chest, pelvis, d),
      ...lats.flatMap((l) => [filletSides(l, chest, d), filletSides(l, abdomen, d)]));
  });
  const headOv = ovoid(HEAD_OV, null);
  const head = own(0.038 * h, 0.038 * h, 0.08 * h, ovoidOut(headOv));
  const neck = egg(NECK_EGG, NECK_R * h);
  const arms = [0, 1].map(() => { const fore = egg(FOREARM_EGG); fore.b.r = WRIST_R * h; return [egg(UPPER_EGG), fore]; });
  // the thighs: each its egg, its buttock and their fillets (to each other and to the pelvis); its capsule bounds them all
  const glutes = [0, 1].map(() => ({ C: v0(), axes: [] })), folds = [0, 0];   // folds: the fold's opening, 0 (a crease) .. 1
  const thighOut = (i) => (pr, g) => {
    const o = legs[i][0], A = o.a.c, Bp = o.b.c, L = Math.hypot(Bp.x - A.x, Bp.y - A.y, Bp.z - A.z) || 1;
    const u = { x: (Bp.x - A.x) / L, y: (Bp.y - A.y) / L, z: (Bp.z - A.z) / L }, at = Math.min(THIGH_EGG.at * h, 0.9 * L);
    const thigh = eggSides({ x: A.x + u.x * at, y: A.y + u.y * at, z: A.z + u.z * at }, u, THIGH_EGG.B * h * g, at, L - at, o.a.r * g, o.b.r * g, pr);
    const glute = hullOfEllipsoids(pr, [grownBody(glutes[i], g)]), px = pr.projectPoint(A).scale * h * g;
    const pelvis = ovoidOut(pelvisOv)(pr, g);
    return loops(thigh, glute, filletSides(thigh, glute, GLUTE.toThigh * folds[i] * px), filletSides(pelvis, glute, GLUTE.toPelvis * px), filletSides(pelvis, thigh, THIGH_EGG.toPelvis * px));
  };
  const legs = [0, 1].map((i) => [own(HIP_R * h, KNEE_R * h, 0.12 * h, thighOut(i)), egg(SHIN_EGG, KNEE_R * h, r)]);
  const fore = [0, 1].map(() => ovoid(FOREFOOT, { c: null, r })), heels = [0, 1].map(() => ({ C: v0(), axes: [] })), outs = [0, 1].map(() => ({ C: v0(), axes: [] }));
  const ankleBall = (i) => ({ C: fore[i].ball.c, axes: [[{ x: 1, y: 0, z: 0 }, r], [{ x: 0, y: 1, z: 0 }, r], [{ x: 0, y: 0, z: 1 }, r]] });
  const feet = [0, 1].map((i) => ({ ...own(r, FOREFOOT.Bn * 0.9 * h, 0.075 * h, (pr, g) => loops(ovoidOut(fore[i])(pr, g),
    hullOfEllipsoids(pr, [ankleBall(i), heels[i], outs[i]].map((q) => grownBody(q, g))))), casts: false }));   // (no shadow: the shaders take 16 casters)
  const gluteJ = [v0(), v0()], heelJ = [v0(), v0()], ballJ = [v0(), v0()], ballOutJ = [v0(), v0()], toeJ = [v0(), v0()];
  // the mittens: one ovoid per hand (c, e1, e2 and boundR only bound it)
  const hands = [0, 1].map(() => ({ kind: 'disc', c: v0(), e1: v0(), e2: v0(), boundR: HAND_BN * h, fill: SKIN, body, ...extra,
    ovoid: { M: v0(), a: v0(), w: v0(), n: v0(), A1: HAND_A1 * h, A2: 0, Bw: HAND_BW * h, Bn: HAND_BN * h, ball: { c: v0(), r: WRIST_R * h } } }));
  const parts = [head, neck, torso, ...arms.flat(), ...legs.flat(), ...feet, ...hands];
  const knuckles = [{}, {}], tips = [{}, {}], thumbs = [{}, {}];   // (joints for the skeleton)
  const shoulderJ = [v0(), v0()], hipJ = [v0(), v0()];

  // Every point in the body's frame (forward f, up u, right s, in body heights).
  const pose = ({ body: B, yaw, phase: ph, gait: g, air, bend = { f: 0, s: 0 } }) => {
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
    const hipU = Math.max(-L[0].su, -L[1].su) + ANKLE;   // the lower ankle ANKLE over the ground: the body bobs with the stride
    const hipMid = at(0, hipU, 0);
    const F = { x: cy, y: 0, z: sy }, U = { x: 0, y: 1, z: 0 }, S = { x: -sy, y: 0, z: cy };   // forward, up, right
    const add = (p, v, k) => ({ x: p.x + v.x * k * h, y: p.y + v.y * k * h, z: p.z + v.z * k * h });
    // the SPINE: a circular arc from the hips' middle, its tangent turned by beta u toward D (u: 0 .. 1 along it); its frame at u
    // (up along it, forward, right) is the body's turned the same way
    const beta = Math.hypot(bend.f, bend.s), D = beta > 1e-9 ? { x: (F.x * bend.f + S.x * bend.s) / beta, y: 0, z: (F.z * bend.f + S.z * bend.s) / beta } : F;
    const K = { x: U.y * D.z - U.z * D.y, y: U.z * D.x - U.x * D.z, z: U.x * D.y - U.y * D.x };   // the turn's axis (U x D)
    const turn = (v, th) => {   // Rodrigues: v turned by th about K
      const c = Math.cos(th), sn = Math.sin(th), kv = K.x * v.x + K.y * v.y + K.z * v.z;
      const kx = { x: K.y * v.z - K.z * v.y, y: K.z * v.x - K.x * v.z, z: K.x * v.y - K.y * v.x };
      return { x: v.x * c + kx.x * sn + K.x * kv * (1 - c), y: v.y * c + kx.y * sn + K.y * kv * (1 - c), z: v.z * c + kx.z * sn + K.z * kv * (1 - c) };
    };
    const spineAt = (u) => {
      const th = beta * u, along = beta > 1e-9 ? Math.sin(th) / beta : u, side = beta > 1e-9 ? (1 - Math.cos(th)) / beta : 0;
      const P = add(add(hipMid, U, SPINE * along), D, SPINE * side);
      return { P, U: turn(U, th), F: turn(F, th), S: turn(S, th) };
    };
    const top = spineAt(1), base = add(top.P, top.F, 0.01), headC = add(add(base, top.U, NECK), top.F, 0.005);
    hipJ[0] = at(0, hipU, HIP_W); hipJ[1] = at(0, hipU, -HIP_W);
    const shoulderAt = (sg) => add(add(base, top.U, -SHOULDER_DROP), top.S, sg * SHOULDER_W);
    shoulderJ[0] = shoulderAt(1); shoulderJ[1] = shoulderAt(-1);
    // the torso: the chest along the spine, the pelvis upright on the hips, the yoke on the shoulders
    const ch = spineAt(CHEST_OV.at / SPINE), ab = spineAt(ABDOMEN.at / SPINE);
    Object.assign(abdomenOv.M, add(ab.P, ab.F, ABDOMEN.fwd)); Object.assign(abdomenOv.a, ab.U); Object.assign(abdomenOv.w, ab.S); Object.assign(abdomenOv.n, ab.F);
    Object.assign(chestOv.M, add(ch.P, ch.F, CHEST_OV.fwd)); Object.assign(chestOv.a, ch.U); Object.assign(chestOv.w, ch.S); Object.assign(chestOv.n, ch.F);
    Object.assign(pelvisOv.M, at(-PELVIS_OV.back, hipU + PELVIS_OV.up, 0)); Object.assign(pelvisOv.a, U); Object.assign(pelvisOv.w, S); Object.assign(pelvisOv.n, F);
    const ball = (C, rr) => ({ C, axes: [[top.F, rr * h], [top.U, rr * h], [top.S, rr * h]] });
    yoke.length = 0; yoke.push(ball(shoulderJ[0], STICK), ball(shoulderJ[1], STICK), ball(base, NECK_BASE_R));
    // the lats, pecs (and breasts) per side: positions in the spine's frame at their height
    const onSpine = (q, sg) => { const f = spineAt(q.at / SPINE); return { f, C: add(add(f.P, f.F, q.fwd), f.S, sg * q.side) }; };
    const ell = (C, fr, [a, b, c]) => ({ C, axes: [[fr.F, a * h], [fr.U, b * h], [fr.S, c * h]] });
    upper.lats = []; upper.pecs = []; upper.breasts = [];
    [1, -1].forEach((sg, i) => {
      const lat = onSpine(LAT, sg), pec = onSpine(PEC, sg);
      upper.lats.push([ball(shoulderJ[i], LAT_SHOULDER_R), ell(lat.C, lat.f, [LAT.r, LAT.r, LAT.r])]);
      upper.pecs.push([ball(shoulderJ[i], LAT_SHOULDER_R), ell(pec.C, pec.f, PEC.ax)]);
      Object.assign(latJ[i], lat.C); Object.assign(pecJ[i], pec.C);
      if (!form.female) return;
      // the breast: its frame turned out (about U) by `out` and its lower half down (about the turned S) by `sag`
      const br = onSpine(BREAST, sg), an = onSpine(BREAST.anchor, sg), fr = br.f;
      const co = Math.cos(BREAST.out), so = Math.sin(BREAST.out) * sg;
      const Fo = { x: fr.F.x * co + fr.S.x * so, y: fr.F.y * co + fr.S.y * so, z: fr.F.z * co + fr.S.z * so };
      const So = { x: fr.S.x * co - fr.F.x * so, y: fr.S.y * co - fr.F.y * so, z: fr.S.z * co - fr.F.z * so };
      const cs = Math.cos(BREAST.sag), ss = Math.sin(BREAST.sag);
      const Fd = { x: Fo.x * cs - fr.U.x * ss, y: Fo.y * cs - fr.U.y * ss, z: Fo.z * cs - fr.U.z * ss };   // (points a little down)
      const Ud = { x: fr.U.x * cs + Fo.x * ss, y: fr.U.y * cs + Fo.y * ss, z: fr.U.z * cs + Fo.z * ss };
      upper.breasts.push([{ C: br.C, axes: [[Fd, BREAST.ax[0] * h], [Ud, BREAST.ax[1] * h], [So, BREAST.ax[2] * h]] }, ell(an.C, an.f, BREAST.anchor.ax)]);
      Object.assign(breastJ[i], br.C);
    });
    torso.a.c = { ...pelvisOv.M }; torso.b.c = { ...chestOv.M };
    const waistJ = spineAt(0.32).P, chestJ = ch.P;
    neck.a.c = base; neck.b.c = headC;
    head.a.c = head.b.c = headC;
    Object.assign(headOv.M, add(add(headC, top.U, HEAD_OV.up), top.F, -HEAD_OV.back));
    Object.assign(headOv.a, top.U); Object.assign(headOv.w, top.S); Object.assign(headOv.n, top.F);
    legs.forEach(([thigh, shin], i) => {
      const v = L[i], s = i ? -1 : 1;
      thigh.a.c = hipJ[i];
      thigh.b.c = shin.a.c = at(v.kf, hipU + v.ku, s * KNEE_W);
      // the buttock: turned about the hips' axis (S) by half the thigh's swing forward (its angle from straight down, toward F)
      const dk = { x: thigh.b.c.x - thigh.a.c.x, y: thigh.b.c.y - thigh.a.c.y, z: thigh.b.c.z - thigh.a.c.z };
      const swing = Math.atan2(dk.x * F.x + dk.y * F.y + dk.z * F.z, -dk.y), al = swing / 2 + GLUTE.tilt, ca = Math.cos(al), sa = Math.sin(al);
      const rot = (v) => {   // Rodrigues about S (S x -U = F: a positive turn takes down toward forward)
        const kv = S.x * v.x + S.y * v.y + S.z * v.z, kx = { x: S.y * v.z - S.z * v.y, y: S.z * v.x - S.x * v.z, z: S.x * v.y - S.y * v.x };
        return { x: v.x * ca + kx.x * sa + S.x * kv * (1 - ca), y: v.y * ca + kx.y * sa + S.y * kv * (1 - ca), z: v.z * ca + kx.z * sa + S.z * kv * (1 - ca) };
      };
      const gF = rot(F), gU = rot(U);
      glutes[i].C = add(add(add(hipJ[i], gF, -GLUTE.back), gU, -GLUTE.down), S, -s * GLUTE.in);
      glutes[i].axes = [[gF, GLUTE.depth * h], [gU, GLUTE.height * h], [S, GLUTE.width * h]];
      Object.assign(gluteJ[i], glutes[i].C);
      const fo = Math.max(0, Math.min(1, swing / GLUTE.foldOpen));
      folds[i] = fo * fo * (3 - 2 * fo);   // (smoothstep: the fillet grows in from nothing)
      shin.b.c = feet[i].a.c = at(v.sf, hipU + v.su, s * ANKLE_W);
      // the foot: the outer column (heel, the fifth metatarsal's head) and the forefoot, on the ground when standing
      const O = fore[i], A = shin.b.c;
      const off = (fw, sd, up) => ({ x: A.x + (F.x * fw + S.x * s * sd) * h, y: A.y + (up - ANKLE) * h, z: A.z + (F.z * fw + S.z * s * sd) * h });
      O.ball.c = A;
      Object.assign(O.M, off(FOREFOOT.fwd, FOREFOOT.side, FOREFOOT.Bn)); Object.assign(O.a, F); Object.assign(O.w, S); Object.assign(O.n, U);
      heels[i].C = off(HEEL.fwd, 0, HEEL.ax[1]); heels[i].axes = [[F, HEEL.ax[0] * h], [U, HEEL.ax[1] * h], [S, HEEL.ax[2] * h]];
      outs[i].C = off(BALL_OUT.fwd, BALL_OUT.side, BALL_OUT.r); outs[i].axes = [[F, BALL_OUT.r * h], [U, BALL_OUT.r * h], [S, BALL_OUT.r * h]];
      Object.assign(heelJ[i], heels[i].C); Object.assign(ballOutJ[i], outs[i].C);
      Object.assign(ballJ[i], off(BALL_J.fwd, BALL_J.side, BALL_J.up)); Object.assign(toeJ[i], off(TOE_J.fwd, TOE_J.side, TOE_J.up));
      feet[i].b.c = O.M;
    });
    // arms: from the shoulders' ends, swung against the legs, elbows a little bent (raised in the air)
    arms.forEach(([upper, fore], i) => {
      const s = i ? -1 : 1;
      const th = -s * 0.45 * g * Math.sin(ph) + air * 0.9, out = 0.12 + air * 0.4;
      const elbow = th + 0.35 + 0.3 * g, Sh = shoulderJ[i];   // (hanging from the shoulder wherever the spine puts it)
      const E3 = add(add(add(Sh, F, UPPER * Math.sin(th) * Math.cos(out)), U, -UPPER * Math.cos(th) * Math.cos(out)), S, s * UPPER * Math.sin(out));
      upper.a.c = Sh;
      upper.b.c = fore.a.c = E3;
      fore.b.c = add(add(add(E3, F, FORE * Math.sin(elbow)), U, -FORE * Math.cos(elbow)), S, s * 0.015);
      // the mitten: along the forearm d, the palm's normal n toward the body (across d), its width w = d x n
      const W = fore.b.c, E = fore.a.c;
      const nrm = (v) => { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; };
      const d = nrm({ x: W.x - E.x, y: W.y - E.y, z: W.z - E.z });
      let n = { x: s * sy, y: 0, z: -s * cy };   // toward the body's middle line (minus this side's outward direction)
      const nd = n.x * d.x + n.y * d.y + n.z * d.z;
      n = nrm({ x: n.x - nd * d.x, y: n.y - nd * d.y, z: n.z - nd * d.z });
      const w = { x: d.y * n.z - d.z * n.y, y: d.z * n.x - d.x * n.z, z: d.x * n.y - d.y * n.x };
      const m = hands[i], at3 = (o, k) => ({ x: o.x + d.x * k * h, y: o.y + d.y * k * h, z: o.z + d.z * k * h });
      const t = { x: s * w.x, y: s * w.y, z: s * w.z };   // toward the thumb (forward while the arm hangs)
      const off = (o, kt, kn) => ({ x: o.x + (t.x * kt + n.x * kn) * h, y: o.y + (t.y * kt + n.y * kn) * h, z: o.z + (t.z * kt + n.z * kn) * h });
      Object.assign(knuckles[i], at3(W, PALM)); Object.assign(tips[i], at3(W, HAND));
      Object.assign(thumbs[i], off(at3(W, THUMB_K.along), THUMB_K.side, THUMB_K.palm));
      // the ovoid: its middle at the thumb knuckle's level, pulled toward it; its axis from there to the fingertips
      const H = m.ovoid, M = off(at3(W, THUMB_K.along), THUMB_PULL, THUMB_PULL), T = tips[i];
      const ax = { x: T.x - M.x, y: T.y - M.y, z: T.z - M.z }, A2 = Math.hypot(ax.x, ax.y, ax.z);
      const a = nrm(ax), wa = w.x * a.x + w.y * a.y + w.z * a.z, wp = nrm({ x: w.x - wa * a.x, y: w.y - wa * a.y, z: w.z - wa * a.z });
      const np = { x: a.y * wp.z - a.z * wp.y, y: a.z * wp.x - a.x * wp.z, z: a.x * wp.y - a.y * wp.x };
      Object.assign(H.M, M); Object.assign(H.ball.c, W); Object.assign(H.a, a); Object.assign(H.w, wp); Object.assign(H.n, np); H.A2 = A2;
      Object.assign(m.c, M);
      m.e1.x = a.x * A2; m.e1.y = a.y * A2; m.e1.z = a.z * A2;
      m.e2.x = wp.x * H.Bw; m.e2.y = wp.y * H.Bw; m.e2.z = wp.z * H.Bw;
    });
    // the SKELETON (temporary, drawn red over everything: illusionRender.js drawOverlay): the joints and the bones joining them
    const J = { head: headC, neck: base, chest: chestJ, waist: waistJ, pelvis: hipMid };
    ['L', 'R'].forEach((k, i) => {
      J['shoulder' + k] = shoulderJ[i]; J['lat' + k] = latJ[i]; J['pec' + k] = pecJ[i];
      if (form.female) J['breast' + k] = breastJ[i]; J['elbow' + k] = arms[i][0].b.c; J['wrist' + k] = arms[i][1].b.c;
      J['knuckles' + k] = knuckles[i]; J['fingertip' + k] = tips[i]; J['thumbKnuckle' + k] = thumbs[i];
      J['hip' + k] = hipJ[i]; J['glute' + k] = gluteJ[i]; J['knee' + k] = legs[i][0].b.c; J['ankle' + k] = legs[i][1].b.c;
      J['heel' + k] = heelJ[i]; J['ball' + k] = ballJ[i]; J['ballOut' + k] = ballOutJ[i]; J['toe' + k] = toeJ[i];
    });
    body.joints = J;
  };
  return { parts, pose };
}

// The skeleton's bones, as pairs of joint names (figure body.joints).
export const BONES = [['neck', 'head'], ['neck', 'chest'], ['chest', 'waist'], ['waist', 'pelvis'],
  ...['L', 'R'].flatMap((k) => [['neck', 'shoulder' + k], ['shoulder' + k, 'lat' + k], ['shoulder' + k, 'pec' + k], ['pec' + k, 'breast' + k], ['shoulder' + k, 'elbow' + k], ['elbow' + k, 'wrist' + k], ['wrist' + k, 'knuckles' + k], ['knuckles' + k, 'fingertip' + k], ['wrist' + k, 'thumbKnuckle' + k],
    ['pelvis', 'hip' + k], ['hip' + k, 'glute' + k], ['hip' + k, 'knee' + k], ['knee' + k, 'ankle' + k], ['ankle' + k, 'heel' + k], ['ankle' + k, 'ball' + k], ['ankle' + k, 'ballOut' + k], ['ball' + k, 'toe' + k]])];

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

// The same body standing at x, z facing yaw, as static objects. gait / phase: a stride to hold (default: standing); bend: the
// spine's ({ f, s }, radians; default straight); female: the female form (so far: the chest).
export function buildStaticFigure({ height, groundAt, x, z, yaw, gait = 0, phase = 0, bend, female = false }) {
  const { parts, pose } = makeFigure(height, undefined, { female });
  pose({ body: { x, y: groundAt(x, z), z }, yaw, phase, gait, air: 0, bend });
  return parts;
}
