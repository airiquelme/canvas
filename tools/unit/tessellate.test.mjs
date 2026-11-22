// Tessellation (src/gpu/tessellate.js): the winding-weighted area of the stencil triangles must equal the exact signed area of the
// shape (closed form: chords + elliptic segments), for hand-made loops (inward arcs, arcs over 90 degrees, full ellipses, thin
// bands, crossing loops) and for every loop of every piece of real meadow frames (day and night).
import test from 'node:test';
import assert from 'node:assert/strict';
import { tessellate, exactArea, windingArea } from '../../src/gpu/tessellate.js';

globalThis.Path2D = class { moveTo() {} lineTo() {} ellipse() {} closePath() {} rect() {} addPath() {} };
const check = (sides, tag) => {
  const ex = exactArea(sides), w = windingArea(tessellate(sides));
  // tolerance: rounding (float64; arcs of ellipses with half axes in the millions are badly conditioned at 1e-4 px^2)
  assert.ok(Math.abs(ex - w) <= 1e-3 + 1e-6 * Math.abs(ex), `${tag}: exact ${ex} vs winding ${w}`);
};
const E = (x, y, a, b, angle) => ({ x, y, a, b, angle });
const arc = (e, t0, t1, move) => ({ kind: 'arc', e, t0, t1, move });
const pt = (e, t) => ({ x: e.x + e.a * Math.cos(t) * Math.cos(e.angle) - e.b * Math.sin(t) * Math.sin(e.angle), y: e.y + e.a * Math.cos(t) * Math.sin(e.angle) + e.b * Math.sin(t) * Math.cos(e.angle) });
const line = (from, to) => ({ kind: 'line', from, to });

test('hand-made loops', () => {
  const e = E(10, 20, 30, 12, 0.4);
  check([arc(e, 0, 2 * Math.PI)], 'full ellipse');
  check([arc(e, 0.3, 0.3 - 2 * Math.PI)], 'full ellipse, other way');
  check([arc(e, 0, 3.5), line(pt(e, 3.5), pt(e, 0))], 'D');
  const f = E(0, 0, 10, 10, 0);
  check([line({ x: -10, y: 0 }, { x: -20, y: 0 }), line({ x: -20, y: 0 }, { x: -20, y: 20 }), line({ x: -20, y: 20 }, { x: 20, y: 20 }),
    line({ x: 20, y: 20 }, { x: 20, y: 0 }), line({ x: 20, y: 0 }, { x: 10, y: 0 }), arc(f, 0, Math.PI)], 'bite');
  const g = E(0, 0, 100, 100, 0), h = E(0, 0.1, 100, 99.9, 0);
  check([arc(g, 0.2, 2.9), line(pt(g, 2.9), pt(h, 2.9)), arc(h, 2.9, 0.2), line(pt(h, 0.2), pt(g, 0.2))], 'thin band');
  check([arc(E(0, 0, 20, 20, 0), 0, 6.283), arc(E(15, 0, 20, 20, 0), 0, 6.283, true)], 'two crossing loops');
  check([line({ x: 0, y: 0 }, { x: 10, y: 10 }), line({ x: 10, y: 10 }, { x: 10, y: 0 }), line({ x: 10, y: 0 }, { x: 0, y: 10 })], 'figure eight');
});

test('every piece of meadow frames', async () => {
  const { camera } = await import('../../src/core/camera.js');
  const R = await import('../../src/illusion/illusionRender.js');
  const L = await import('../../src/illusion/light.js');
  const canvas = { width: 1600, height: 900 };
  let n = 0;
  for (const el of [0.2, -0.1]) {
    L.setSun(L.light.azimuth, el);
    const g = R.buildMeadowScene();
    for (const [ex, ez, up, tx, tz] of [[1200, 0, 60, 500, 0], [-400, -900, 200, 500, 0], [700, -200, 12, 600, -200], [500, 1300, 40, 400, -600]]) {
      camera.position = { x: ex, y: g(ex, ez) + up, z: ez }; camera.target = { x: tx, y: g(tx, tz), z: tz };
      const F = R.buildIllusionFrame(canvas, { time: 0.5 });
      for (const s of F.shapes) for (const p of s.pieces || []) { check((p.ref || p).sides, `shape ${s.o.kind || 'tube'}`); n++; }
    }
  }
  L.setSun(L.light.azimuth, 0.2);
  assert.ok(n > 1000, `only ${n} pieces checked`);
  console.log(`  ${n} pieces checked`);
});
