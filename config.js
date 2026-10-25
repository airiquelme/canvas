export const DESIGN_WIDTH = 1000, DESIGN_HEIGHT = 800;

// Debug views, all switched together by the Debug button (main.js). `on` is
// the live state; the others pick which views it turns on:
//   gap   paints the background magenta so antialiasing seam gaps stand out
//   cone  split cone / host mesh intersection curves (coneDebug.js)
//   joint 2-to-2 joint rings and cone edge stops (jointDebug.js)
//   shape squashed nodes' screen ellipses (shapeDebug.js)
export const debug = { on: false, gap: true, cone: true, joint: true, shape: true };

// Where two separately filled pieces meet, the lower one reaches
// SEAM_PX / 2 device pixels under the upper one (see CLAUDE.md).
export const SEAM_PX = 1.5;


// Border strokes (the Strokes button): where a mesh lies over another mesh of the SAME color and the same tone, its edge gets a
// stroke one tone darker than the front's (Lit -> Twilight, Twilight -> Shade), `px` canvas pixels thick (the visible, outer half
// of a stroke centered on the edge), whatever the zoom. No stroke where the two tones differ.
export const strokes = { on: true, px: 2 };

// Light engine (the Light button; light.js, shading.js). One directional world light (`dir`: unit vector toward the light, world
// axes, fixed in the world so the lit side stays put on the objects as the camera orbits; here upper-left-front of the camera's
// start: camera at +x looking toward -x, right = -z, left = +z). A surface is Lit or Twilight. `toneMix`: how far each tone's
// color (Unlit, Shade, Twilight, Lit, Shining) is mixed toward black (positive) or white (negative); Lit is the mesh color itself.
// Only Lit and Twilight are used for now; the others are for local (harsh) lights and shadows later.
export const lighting = {
  on: true,
  // Skewed arches lit like a straight tube (shading.js buildArch): one fixed half of the cross-section, in the arch's own frame,
  // centered on the tube light at the skew node, so the shade lines follow the arch from end to end (the Debug view's cyan curves).
  // Not realistic, like the straight cones' tube light; false: lit by the light itself at every point of the arch.
  archTube: true,
  toneMix: [1, 0.4, 0.18, 0, -0.25],
};
const lightLen = Math.hypot(100, 110, 200);
export const light = { dir: { x: 100 / lightLen, y: 110 / lightLen, z: 200 / lightLen } };

// Focus view (the Focus button): the camera centers on one mesh of 3+ nodes (`meshId`, default the first one) and magnifies until all
// of it fits on screen (its bounding sphere takes `fill` of the half-height of the view, at any orbit angle). Only that mesh and the
// meshes sharing a node with it (`meshIds`, set by main.js) are drawn.
export const focus = { on: false, meshId: null, fill: 0.7, meshIds: [] };
