// The basic element of the illusion renderer: a flat 2D shape on the screen, a closed loop of SIDES.
// Every side is a straight line or an arc of an ellipse (no other curves), so it is drawn exactly with
// ctx.lineTo / ctx.ellipse.
//
//   line: { kind: 'line', from: {x, y}, to: {x, y} }
//   arc:  { kind: 'arc', e: { x, y, a, b, angle }, t0, t1 }   ctx.ellipse's terms; t runs from t0 to t1
//         (t1 > t0 goes clockwise on screen, y down; t1 < t0 the other way)
//
// A shape is { sides: [...], fill, colors: [stroke colors], depth, keep? }. Each side starts where the previous one ends. A side's
// stroke is colors[side.ci] (pieces of one logical side share it), else colors[its index]. A side with `move` starts a new
// loop (subpath).

export const line = (from, to) => ({ kind: 'line', from, to });
export const arc = (e, t0, t1) => ({ kind: 'arc', e, t0, t1 });

export const pointOnEllipse = (e, t) => {
  const ca = Math.cos(e.angle), sa = Math.sin(e.angle), c = Math.cos(t) * e.a, s = Math.sin(t) * e.b;
  return { x: e.x + c * ca - s * sa, y: e.y + c * sa + s * ca };
};

export const sideStart = (s) => s.kind === 'line' ? s.from : pointOnEllipse(s.e, s.t0);

// Adds one side to the current path (assumes the pen is already at its start).
function traceSide(ctx, s) {
  if (s.kind === 'line') ctx.lineTo(s.to.x, s.to.y);
  else ctx.ellipse(s.e.x, s.e.y, s.e.a, s.e.b, s.e.angle, s.t0, s.t1, s.t1 < s.t0);
}

export function tracePath(ctx, shape) {
  shape.sides.forEach((s, i) => {
    if (i === 0 || s.move) {   // a new subpath (a shape may be several loops, filled nonzero)
      if (i > 0) ctx.closePath();
      const p = sideStart(s);
      ctx.moveTo(p.x, p.y);
    }
    traceSide(ctx, s);
  });
  ctx.closePath();
}

// (With `stroke`) each side stroked on its own in its own color, at twice `lineWidth`, then the fill over them (nonzero: a shape
// made of several overlapping loops fills their union). The fill covers each stroke's inner half and every stroke inside the
// shape, so only the outer `lineWidth` of the shape's true outline shows (underpaint, no outline computed).
export function drawShape(ctx, shape, { lineWidth = 3, stroke = true } = {}) {
  if (stroke) {
    ctx.lineWidth = 2 * lineWidth;
    ctx.lineCap = 'round';
    shape.sides.forEach((s, i) => {
      const p = sideStart(s);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      traceSide(ctx, s);
      ctx.strokeStyle = shape.colors[(s.ci ?? i) % shape.colors.length];
      ctx.stroke();
    });
  }
  if (ctx.fillStyle !== shape.fill) ctx.fillStyle = shape.fill;   // setting a color parses it: only when it changes
  // A shape kept from frame to frame (`keep`) records its path once (Path2D) and refills it.
  if (shape.keep && typeof Path2D !== 'undefined') {
    if (!shape.path) { shape.path = new Path2D(); tracePath(shape.path, shape); }
    ctx.fill(shape.path);
    return;
  }
  ctx.beginPath();
  tracePath(ctx, shape);
  ctx.fill();
}
