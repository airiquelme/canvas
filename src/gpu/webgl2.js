// WebGL2 backend of the illusion renderer: draws a frame (illusionRender.js `buildIllusionFrame`) on the GPU.
//
// STENCIL-THEN-COVER with DRAW ORDER AS DEPTH. Every entry (a piece's fill, its crescents, a mover's shadow, in the frame's back-to-
// front order) gets a depth: later = nearer. A fill takes two passes: its triangles (tessellate.js: a fan over each loop plus a
// curve triangle per arc piece, which keeps u^2 + v^2 <= 1) count the winding in the stencil (up for one facing, down for the
// other; nonzero = inside, as a canvas), then its box is drawn at its depth where the stencil is not 0, writing the color and
// clearing the stencil. Because the depth test orders the entries, fills whose screen boxes don't overlap share one stencil pass and
// one cover pass whatever their order: they are put into GROUPS of disjoint boxes (first fit on a coarse grid), two draw calls per
// group.
// CRESCENTS (shape minus the shape moved by d, illusionRender.js stylized light): the moved shape's winding turned into a flag
// (bit 7 = outside it), the shape's winding in bits 0-6, cleared where the flag is not set, then the crescent color where bits 0-6
// are not 0. SHADOWS (groundShadow.js, drawn on the lit ground of their hosts, no stacking): the hosts' lit pieces' winding in bits
// 0-5, the shadow's parity in bit 7, bit 7 cleared where no host, then multiply by a gray and add a color (light.js shadeOverlay)
// where bit 7 is set and bit 6 is not, setting bit 6 (already shadowed this frame).
// ANTIALIASING: an MSAA target (up to 8 samples); straight edges get per-sample coverage, curve edges their analytic coverage
// (distance to the ellipse over its screen gradient) as alpha, turned into samples by alpha-to-coverage. Coverage is per sample, so
// two pieces meeting on an edge leave no seam (no ground underlay needed).
import { createFramePlanner, rgbOf } from './plan.js';
import { skyParams } from '../illusion/sky.js';
import { light, shadeOverlay } from '../illusion/light.js';
import { DESIGN_WIDTH, DESIGN_HEIGHT } from '../config.js';

const STENCIL_VS = `#version 300 es
in vec2 pos; in vec3 uvm;
uniform vec4 xf;   // design -> canvas px: (fit, e, f, 0)
uniform vec2 size;
out vec3 v_uvm;
void main() {
  vec2 p = vec2(xf.x * pos.x + xf.y, xf.x * pos.y + xf.z);
  gl_Position = vec4(p.x / size.x * 2.0 - 1.0, 1.0 - p.y / size.y * 2.0, 0.0, 1.0);
  v_uvm = uvm;
}`;
const STENCIL_FS = `#version 300 es
precision highp float;
in vec3 v_uvm;
out vec4 color;
void main() {
  float a = 1.0;
  if (v_uvm.z > 0.5) {   // a curve triangle: keep the inside of the unit circle, antialiased (alpha-to-coverage)
    float f = dot(v_uvm.xy, v_uvm.xy) - 1.0;
    vec2 g = vec2(dFdx(f), dFdy(f));
    float d = f / max(length(g), 1e-12);   // signed distance to the ellipse, in px (+ outside)
    a = clamp(0.5 - d, 0.0, 1.0);
    if (a <= 0.0) discard;
  }
  color = vec4(0.0, 0.0, 0.0, a);
}`;
const COVER_VS = `#version 300 es
in vec2 pos; in float z; in vec4 rgba;
uniform vec4 xf; uniform vec2 size;
out vec4 v_rgba;
void main() {
  vec2 p = vec2(xf.x * pos.x + xf.y, xf.x * pos.y + xf.z);
  gl_Position = vec4(p.x / size.x * 2.0 - 1.0, 1.0 - p.y / size.y * 2.0, z, 1.0);
  v_rgba = rgba;
}`;
const COVER_FS = `#version 300 es
precision highp float;
in vec4 v_rgba; out vec4 color;
void main() { color = v_rgba; }`;
// The sky: a vertical gradient (stops at g0, the 0.75 point, g1; clamped beyond, as a canvas gradient), the sun's glow (radial
// alpha 0.45 -> 0 from 0.8 r to 6 r, inside its square) and disc, in design px.
const SKY_VS = `#version 300 es
in vec2 pos; out vec2 v_px;
void main() { v_px = pos; gl_Position = vec4(pos, 0.999999, 1.0); }`;
const SKY_FS = `#version 300 es
precision highp float;
in vec2 v_px;
uniform vec4 xf; uniform vec2 size;
uniform vec3 zen, mid, hor, sunc; uniform vec2 gy; uniform vec3 sun;   // sun: x, y, r (r = 0: none)
out vec4 color;
void main() {
  vec2 c = vec2((v_px.x + 1.0) * 0.5 * size.x, (1.0 - v_px.y) * 0.5 * size.y);   // canvas px
  vec2 d = vec2((c.x - xf.y) / xf.x, (c.y - xf.z) / xf.x);                       // design px
  float t = clamp((d.y - gy.x) / (gy.y - gy.x), 0.0, 1.0);
  vec3 col = t < 0.75 ? mix(zen, mid, t / 0.75) : mix(mid, hor, (t - 0.75) / 0.25);
  if (sun.z > 0.0) {
    vec2 q = d - sun.xy;
    if (abs(q.x) <= sun.z * 6.0 && abs(q.y) <= sun.z * 6.0) {
      float k = clamp((length(q) - sun.z * 0.8) / (sun.z * 5.2), 0.0, 1.0);
      col = mix(col, sunc, 0.45 * (1.0 - k));
    }
    float px = 1.0 / xf.x, dd = length(q) - sun.z;   // the disc, antialiased over a canvas pixel
    col = mix(col, sunc, clamp(0.5 - dd / px, 0.0, 1.0));
  }
  color = vec4(col, 1.0);
}`;

function program(gl, vs, fs) {
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(p, i); u[a.name] = gl.getUniformLocation(p, a.name); }
  return { p, u, attr: (name) => gl.getAttribLocation(p, name) };
}

export function createWebGL2(canvas, { preserveDrawingBuffer = false } = {}) {
  // alpha: the MSAA resolve (blit) needs the canvas buffer in the same format as the target (RGBA8); every pixel written is opaque
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true, depth: false, stencil: false, preserveDrawingBuffer, powerPreference: 'high-performance' });
  if (!gl) return null;
  const samples = Math.min(8, gl.getParameter(gl.MAX_SAMPLES));
  const stencilP = program(gl, STENCIL_VS, STENCIL_FS), coverP = program(gl, COVER_VS, COVER_FS), skyP = program(gl, SKY_VS, SKY_FS);
  // buffers and vertex arrays
  const sBuf = gl.createBuffer(), cBuf = gl.createBuffer(), qBuf = gl.createBuffer();
  const sVao = gl.createVertexArray();
  gl.bindVertexArray(sVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, sBuf);
  gl.enableVertexAttribArray(stencilP.attr('pos')); gl.vertexAttribPointer(stencilP.attr('pos'), 2, gl.FLOAT, false, 20, 0);
  gl.enableVertexAttribArray(stencilP.attr('uvm')); gl.vertexAttribPointer(stencilP.attr('uvm'), 3, gl.FLOAT, false, 20, 8);
  const cVao = gl.createVertexArray();
  gl.bindVertexArray(cVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, cBuf);
  gl.enableVertexAttribArray(coverP.attr('pos')); gl.vertexAttribPointer(coverP.attr('pos'), 2, gl.FLOAT, false, 28, 0);
  gl.enableVertexAttribArray(coverP.attr('z')); gl.vertexAttribPointer(coverP.attr('z'), 1, gl.FLOAT, false, 28, 8);
  gl.enableVertexAttribArray(coverP.attr('rgba')); gl.vertexAttribPointer(coverP.attr('rgba'), 4, gl.FLOAT, false, 28, 12);
  const qVao = gl.createVertexArray();
  gl.bindVertexArray(qVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, qBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(skyP.attr('pos')); gl.vertexAttribPointer(skyP.attr('pos'), 2, gl.FLOAT, false, 8, 0);
  gl.bindVertexArray(null);
  // the MSAA target
  let fbo = null, colorRb = null, dsRb = null, fw = 0, fh = 0;
  const target = (w, h) => {
    if (fbo && w === fw && h === fh) return;
    if (fbo) { gl.deleteFramebuffer(fbo); gl.deleteRenderbuffer(colorRb); gl.deleteRenderbuffer(dsRb); }
    fw = w; fh = h;
    colorRb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, colorRb);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, w, h);
    dsRb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, dsRb);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH24_STENCIL8, w, h);
    fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, colorRb);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, dsRb);
  };
  const frame = createFramePlanner();

  function render(F, { darkMode = false } = {}) {
    const t0 = performance.now();
    const W = canvas.width, H = canvas.height, fit = F.fit;
    const xf = [fit, W / 2 - (fit * DESIGN_WIDTH) / 2, H / 2 - (fit * DESIGN_HEIGHT) / 2, 0];
    const plan = frame.plan(F);
    const t1 = performance.now();
    target(W, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, W, H);
    const bg = darkMode ? 0 : 1;
    gl.clearColor(bg, bg, bg, 1); gl.clearDepth(1); gl.clearStencil(0);
    gl.depthMask(true); gl.stencilMask(0xff); gl.colorMask(true, true, true, true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    if (F.sky) {
      const P = skyParams(F.view, { projectPoint: F.projectPoint, camPos: F.camPos, forward: F.forward, light, sunDisc: F.sky.sunDisc });
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.STENCIL_TEST);
      gl.useProgram(skyP.p);
      gl.uniform4fv(skyP.u.xf, xf); gl.uniform2f(skyP.u.size, W, H);
      gl.uniform3fv(skyP.u.zen, P.zenith.map((v) => v / 255)); gl.uniform3fv(skyP.u.mid, P.mid.map((v) => v / 255)); gl.uniform3fv(skyP.u.hor, P.horizon.map((v) => v / 255));
      gl.uniform2f(skyP.u.gy, P.g0, P.g1);
      if (P.sun) { gl.uniform3f(skyP.u.sun, P.sun.x, P.sun.y, P.sun.r); gl.uniform3fv(skyP.u.sunc, P.sun.color.map((v) => v / 255)); } else gl.uniform3f(skyP.u.sun, 0, 0, 0);
      gl.bindVertexArray(qVao);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    const { sSink, cSink } = plan;
    gl.bindBuffer(gl.ARRAY_BUFFER, sBuf);
    gl.bufferData(gl.ARRAY_BUFFER, sSink.f.subarray(0, sSink.n * 5), gl.STREAM_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, cBuf);
    gl.bufferData(gl.ARRAY_BUFFER, cSink.f.subarray(0, cSink.n * 7), gl.STREAM_DRAW);
    gl.enable(gl.STENCIL_TEST);
    gl.useProgram(stencilP.p); gl.uniform4fv(stencilP.u.xf, xf); gl.uniform2f(stencilP.u.size, W, H);
    gl.useProgram(coverP.p); gl.uniform4fv(coverP.u.xf, xf); gl.uniform2f(coverP.u.size, W, H);
    const winding = (r, mask) => {   // count the winding of stencil triangles r = [a, b) into the stencil bits `mask`
      if (r[1] <= r[0]) return;
      gl.useProgram(stencilP.p); gl.bindVertexArray(sVao);
      gl.colorMask(false, false, false, false); gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
      gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
      gl.stencilMask(mask); gl.stencilFunc(gl.ALWAYS, 0, 0xff);
      gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, gl.INCR_WRAP);
      gl.stencilOpSeparate(gl.BACK, gl.KEEP, gl.KEEP, gl.DECR_WRAP);
      gl.drawArrays(gl.TRIANGLES, r[0], r[1] - r[0]);
      gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    };
    const parity = (r, bit) => {   // flip stencil bit `bit` under stencil triangles r (even-odd)
      if (r[1] <= r[0]) return;
      gl.useProgram(stencilP.p); gl.bindVertexArray(sVao);
      gl.colorMask(false, false, false, false); gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
      gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
      gl.stencilMask(bit); gl.stencilFunc(gl.ALWAYS, 0, 0xff); gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
      gl.drawArrays(gl.TRIANGLES, r[0], r[1] - r[0]);
      gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    };
    // boxes r (cover vertices) under a stencil test; `color`: write color (with depth test and, unless blending, depth write)
    const boxes = (r, { color = false, blend = false, func, ref = 0, fmask = 0xff, write = 0xff, zfail = gl.KEEP, zpass = gl.KEEP }) => {
      if (r[1] <= r[0]) return;
      gl.useProgram(coverP.p); gl.bindVertexArray(cVao);
      gl.colorMask(color, color, color, color);
      if (color) { gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); } else gl.disable(gl.DEPTH_TEST);
      gl.depthMask(color && !blend);
      gl.stencilMask(write); gl.stencilFunc(func, ref, fmask); gl.stencilOp(gl.KEEP, zfail, zpass);
      gl.drawArrays(gl.TRIANGLES, r[0], r[1] - r[0]);
    };
    gl.disable(gl.STENCIL_TEST);   // the ground underlay: plain quads at the farthest depth
    boxes(plan.under, { color: true, func: gl.ALWAYS });
    gl.enable(gl.STENCIL_TEST);
    // fills blend by their opacity (1 but for fading pieces), the canvas's alpha kept
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    for (const G of plan.fills) {
      winding(G.tris, 0xff);
      boxes(G.boxes, { color: true, func: gl.NOTEQUAL, zfail: gl.ZERO, zpass: gl.ZERO });
    }
    gl.disable(gl.BLEND);
    // crescents: the moved shape's winding (all bits) turned into a flag, bit 7 = OUTSIDE it (a tube's chain of loops is a union:
    // nonzero, not parity); then the shape's winding in bits 0-6, cleared where bit 7 is not set, and the crescent color there
    for (const G of plan.crescents) {
      winding(G.moved, 0xff);
      boxes(G.movedBoxes, { func: gl.EQUAL, ref: 0, write: 0x80, zpass: gl.INVERT });          // winding 0: 0x80
      boxes(G.movedBoxes, { func: gl.NOTEQUAL, ref: 0x80, zpass: gl.ZERO });                    // anything else: 0
      winding(G.shapes, 0x7f);
      boxes(G.movedBoxes, { func: gl.EQUAL, ref: 0, fmask: 0x80, zpass: gl.ZERO });             // inside the moved shape: 0
      boxes(G.boxes, { color: true, func: gl.NOTEQUAL, fmask: 0x7f, zfail: gl.ZERO, zpass: gl.ZERO });
      boxes(G.movedBoxes, { func: gl.ALWAYS, zpass: gl.ZERO });                                  // anything left: 0
    }
    if (plan.shadows.length) {
      const [mul, add] = shadeOverlay().map((x) => rgbOf(x.color));
      for (const G of plan.shadows) {
        winding(G.hosts, 0x3f);
        parity(G.shape, 0x80);
        boxes(G.allBox, { func: gl.EQUAL, ref: 0, fmask: 0x3f, write: 0x80, zpass: gl.ZERO });      // no lit host there: not shadowed
        gl.enable(gl.BLEND);
        gl.blendColor(mul[0], mul[1], mul[2], 1); gl.blendFunc(gl.ZERO, gl.CONSTANT_COLOR);        // dst x gray (multiply)
        boxes(G.box, { color: true, blend: true, func: gl.EQUAL, ref: 0x80, fmask: 0xc0, write: 0 });
        gl.blendColor(add[0], add[1], add[2], 1); gl.blendFunc(gl.CONSTANT_COLOR, gl.ONE);         // dst + color (lighter)
        // the same samples (bit 7, not bit 6), now marking bit 6: INVERT (a REPLACE would write the test's reference, bit 6 clear)
        boxes(G.box, { color: true, blend: true, func: gl.EQUAL, ref: 0x80, fmask: 0xc0, write: 0x40, zpass: gl.INVERT });
        gl.disable(gl.BLEND);
        boxes(G.allBox, { func: gl.ALWAYS, write: 0xbf, zpass: gl.ZERO });                         // all but bit 6 back to 0
      }
    }
    gl.stencilMask(0xff);
    gl.disable(gl.STENCIL_TEST); gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);   // resolve onto the canvas
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    const t2 = performance.now();
    const st = F.stats;
    st.buildMs = F.t1 - F.t0; st.prepMs = t1 - t0; st.drawMs = t2 - t0;
    st.groups = plan.fills.length + plan.crescents.length; st.pieces = plan.entries; st.shadows = plan.shadows.length;
    st.vertices = sSink.n + cSink.n; st.frame = F.frameNo; st.samples = samples;
    return st;
  }
  return { name: 'webgl2', gl, render, samples, readPixel: () => { const b = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b); return b; } };
}

