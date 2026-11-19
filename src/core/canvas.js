import { DESIGN_WIDTH, DESIGN_HEIGHT } from '../config.js';

// Maps the design space (DESIGN_WIDTH x DESIGN_HEIGHT, centered) onto the canvas, keeping its aspect.
export function applyDesignSpaceTransform(ctx, canvas) {
  const scale = Math.min(canvas.width / DESIGN_WIDTH, canvas.height / DESIGN_HEIGHT);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.scale(scale, scale);
  ctx.translate(-DESIGN_WIDTH / 2, -DESIGN_HEIGHT / 2);
}
