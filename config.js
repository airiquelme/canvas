export const DESIGN_WIDTH = 1000, DESIGN_HEIGHT = 800;

// Debug views, all switched together by the Debug button (main.js). `on` is
// the live state; the others pick which views it turns on:
//   gap   paints the background magenta so antialiasing seam gaps stand out
//   cone  split cone / host mesh intersection curves (coneDebug.js)
export const debug = { on: false, gap: true, cone: true };

// Where two separately filled pieces meet, the lower one reaches
// SEAM_PX / 2 device pixels under the upper one (see CLAUDE.md).
export const SEAM_PX = 1.5;

// Split cone, nearly edge-on ring: the host's silhouette bulges a little past
// the ring plane, so a thin strip of the far color (this fraction of the ring
// radius) is laid over it after the host, when |cos(view, axis)| is below
// the second value (see drawSplitStrip).
export const SPLIT_STRIP_FRAC = 0.15, SPLIT_STRIP_MAX_FLAT = 0.2;

// Focus view (the Focus button): only the meshes with these colors are drawn
// (here orange and yellow), the camera centers on `nodeId` and magnifies by `zoom`.
export const focus = { on: false, meshColors: ['#ff8a65', '#fff176'], nodeId: 3, zoom: 6 };
