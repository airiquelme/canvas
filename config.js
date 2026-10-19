export const DESIGN_WIDTH = 1000, DESIGN_HEIGHT = 800;

// Paints the background magenta so antialiasing seam gaps stand out.
export const GAP_DEBUG = false;

// Where two separately filled pieces meet, the lower one reaches
// SEAM_PX / 2 device pixels under the upper one (see CLAUDE.md).
export const SEAM_PX = 1.5;

// A joint crescent thinner than this (device pixels) is not drawn.
export const MIN_CRESCENT_PX = 1;
