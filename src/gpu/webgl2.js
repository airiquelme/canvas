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
in vec2 pos; in float z; in vec4 rgba; in float gid;
uniform vec4 xf; uniform vec2 size;
out vec4 v_rgba; flat out float v_gid;
void main() {
  vec2 p = vec2(xf.x * pos.x + xf.y, xf.x * pos.y + xf.z);
  gl_Position = vec4(p.x / size.x * 2.0 - 1.0, 1.0 - p.y / size.y * 2.0, z, 1.0);
  v_rgba = rgba; v_gid = gid;
}`;
// PER-PIXEL GROUND SHADE (gid >= 0: a ground piece, plan.js `groundId`). The pixel's view ray D (design px -> camera -> world) meets
// the piece's sheet curve where -a2 t^2 + (D.y - gx D.x - gz D.z) t + k0 = 0 (the nearest root; none, at the outline's antialiased
// edge: the closest approach), at the world point P = eye + t D. Its shade s (0 lit .. 1 shade, antialiased over a pixel by the
// screen derivative): the sun's shade field there (shadow.js, the same bilinear read as the CPU's), the movers' shadows (the ray
// from P toward the sun against each capsule) or, with the sun down, all; its shade tone lifted by the lamps' bands (lamps.js:
// toward base x lamp color by 0.22 / 0.48 / 0.75 within 1 / 0.66 / 0.33 of the reach). Color: lit (the vertex color) -> shade by s.
// A fragment that is not ground returns at once: gid is flat per triangle, so the 2 x 2 quads that derivatives come from never
// diverge (the stencil-only box passes, the objects' fills, pay nothing).
const COVER_FS = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec4 v_rgba; flat in float v_gid; out vec4 color;
uniform vec4 xf; uniform vec2 size;
uniform sampler2D gdata; uniform sampler2D field;
uniform int mode;                       // 0: no per-pixel shade, 1: field + movers, 2: all in shade (the sun down)
uniform int hasField;
uniform vec3 eye, camR, camU, camF, persp;   // persp: s, cx, cy (screen = c + s X / Z)
uniform vec4 fA; uniform vec4 fB; uniform vec2 fN;   // field: (cx, cz, ux, uz), (umax, vmin, ds, eps), (nu, nv)
uniform vec3 sunL; uniform int nCast; uniform vec4 castA[16]; uniform vec4 castB[16];
uniform int nLamp; uniform vec4 lampP[4]; uniform vec3 lampC[4];
vec4 gd(int k) { return texelFetch(gdata, ivec2(k % 1024, k / 1024), 0); }
float fieldAt(vec2 xz) {
  vec2 d = xz - fA.xy;
  float u = dot(d, fA.zw), v = dot(d, vec2(-fA.w, fA.z));
  float fi = (fB.x - u) / fB.z, fj = (v - fB.y) / fB.z;
  float i = clamp(floor(fi), 0.0, fN.x - 2.0), j = clamp(floor(fj), 0.0, fN.y - 2.0);
  float a = clamp(fi - i, 0.0, 1.0), b = clamp(fj - j, 0.0, 1.0);
  ivec2 k = ivec2(int(i), int(j));
  float d00 = texelFetch(field, k, 0).r, d10 = texelFetch(field, k + ivec2(1, 0), 0).r;
  float d01 = texelFetch(field, k + ivec2(0, 1), 0).r, d11 = texelFetch(field, k + ivec2(1, 1), 0).r;
  return mix(mix(d00, d10, a), mix(d01, d11, a), b);
}
// distance from the ray P + s L (s >= 0) to the segment A B, and the segment's parameter there
vec2 raySeg(vec3 P, vec3 L, vec3 A, vec3 B) {
  vec3 v = B - A; float c = max(dot(v, v), 1e-9);
  float t = clamp(dot(P - A, v) / c, 0.0, 1.0), s = 0.0;
  for (int it = 0; it < 3; it++) { s = max(0.0, dot(A + v * t - P, L)); t = clamp(dot(P + L * s - A, v) / c, 0.0, 1.0); }
  return vec2(length(P + L * s - (A + v * t)), t);
}
void main() {
  if (v_gid < 0.0 || mode == 0) { color = v_rgba; return; }
  int g = int(v_gid) * 4;
  vec4 G0 = gd(g), G1 = gd(g + 1), G2 = gd(g + 2), G3 = gd(g + 3);   // A B C gx | gz k0 ex ez | shade rgb, base r | base g b
  vec2 fc = vec2(gl_FragCoord.x, size.y - gl_FragCoord.y);
  vec2 dp = (fc - xf.yz) / xf.x;
  vec3 D = camF + ((dp.x - persp.y) / persp.x) * camR - ((dp.y - persp.z) / persp.x) * camU;
  float k2 = -(G0.x * D.x * D.x + G0.y * D.x * D.z + G0.z * D.z * D.z), k1 = D.y - G0.w * D.x - G1.x * D.z, k0 = G1.y;
  float t;
  if (abs(k2) < 1e-9 * abs(k1)) t = -k0 / k1;
  else {
    float disc = k1 * k1 - 4.0 * k2 * k0;
    if (disc < 0.0) t = -k1 / (2.0 * k2);
    else {
      float q = -0.5 * (k1 + (k1 >= 0.0 ? 1.0 : -1.0) * sqrt(disc)), r1 = q / k2, r2 = k0 / q;
      // the hit nearer the patch (its local origin, inside it): the other one is on its sheet curve extended
      vec2 h1 = G1.zw + r1 * D.xz, h2 = G1.zw + r2 * D.xz;
      t = (r1 > 0.0 && (dot(h1, h1) < dot(h2, h2) || r2 <= 0.0)) ? r1 : r2;
    }
  }
  vec3 P = eye + max(t, 0.0) * D;
  // the pixel's footprint on the ground (world units): the antialiasing width of the movers' and lamps' distances (no derivative
  // inside a loop: that made WebGPU's compiler run every iteration)
  vec3 fP = fwidth(P);
  float pw = max(length(fP), 1e-4);
  float sh = 0.0;
  if (hasField == 1) { float fd = fieldAt(P.xz); sh = clamp((fd - fB.w) / max(fwidth(fd), 1e-4) + 0.5, 0.0, 1.0); }
  int cm = int(G3.z), lm = int(G3.w);   // the movers and lamps that can reach this piece (plan.js reachOf)
  for (int i = 0; i < 16; i++) {
    if (i >= nCast) break;
    if (((cm >> i) & 1) == 0) continue;
    vec2 dr = raySeg(P, sunL, castA[i].xyz, castB[i].xyz);
    float dd = dr.x - mix(castA[i].w, castB[i].w, dr.y);
    sh = max(sh, clamp(0.5 - dd / pw, 0.0, 1.0));
  }
  if (mode == 2) sh = 1.0;
  float best = 0.0; vec3 lc = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    if (i >= nLamp) break;
    if (((lm >> i) & 1) == 0) continue;
    float dl = length(P - lampP[i].xyz) / lampP[i].w, w = pw / lampP[i].w;
    float lv = 0.22 * clamp((1.0 - dl) / w + 0.5, 0.0, 1.0) + 0.26 * clamp((0.66 - dl) / w + 0.5, 0.0, 1.0) + 0.27 * clamp((0.33 - dl) / w + 0.5, 0.0, 1.0);
    if (lv > best) { best = lv; lc = lampC[i]; }
  }
  vec3 shadeC = mix(G2.xyz, vec3(G2.w, G3.xy) * lc, best);
  vec3 ground = mix(v_rgba.rgb, shadeC, sh);
  color = vec4(ground, v_rgba.a);
}`;
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
  gl.enableVertexAttribArray(coverP.attr('pos')); gl.vertexAttribPointer(coverP.attr('pos'), 2, gl.FLOAT, false, 32, 0);
  gl.enableVertexAttribArray(coverP.attr('z')); gl.vertexAttribPointer(coverP.attr('z'), 1, gl.FLOAT, false, 32, 8);
  gl.enableVertexAttribArray(coverP.attr('rgba')); gl.vertexAttribPointer(coverP.attr('rgba'), 4, gl.FLOAT, false, 32, 12);
  gl.enableVertexAttribArray(coverP.attr('gid')); gl.vertexAttribPointer(coverP.attr('gid'), 1, gl.FLOAT, false, 32, 28);
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
  // per-pixel ground: the pieces' data (RGBA32F, 1024 texels a row, 4 per piece) and the shade field (R32F, nu x nv)
  const texOf = () => {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  const gTex = texOf(), fTex = texOf();
  let gRows = 0, fieldOf = null, fieldV = -1, gBuf = new Float32Array(0);
  const ca = new Float32Array(64), cb = new Float32Array(64), lp = new Float32Array(16), lcol = new Float32Array(12);
  const groundUniforms = (F, ground) => {
    const u = coverP.u, pix = !!F.pixelGround && light.on;
    gl.uniform1i(u.mode, !pix ? 0 : light.dir.y <= 0 || (F.field && F.field.all) ? 2 : 1);
    if (!pix) return;
    // the pieces' data
    const rows = Math.max(1, Math.ceil((ground.n * 4) / 1024));
    if (gBuf.length < rows * 1024 * 4) gBuf = new Float32Array(rows * 1024 * 4);
    gBuf.set(ground.data.subarray(0, ground.n * 16));
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, gTex);
    if (rows > gRows) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1024, rows, 0, gl.RGBA, gl.FLOAT, gBuf.subarray(0, rows * 1024 * 4)); gRows = rows; }
    else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1024, rows, gl.RGBA, gl.FLOAT, gBuf.subarray(0, rows * 1024 * 4));
    gl.uniform1i(u.gdata, 0);
    // the field (re-uploaded when it changes: a rebuild, an edit's sweep lines)
    const Fd = F.field, grid = Fd && Fd.grid;
    gl.uniform1i(u.hasField, grid ? 1 : 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, fTex);
    if (grid && (fieldOf !== Fd || fieldV !== Fd.version)) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, grid.nu, grid.nv, 0, gl.RED, gl.FLOAT, grid.depth);
      fieldOf = Fd; fieldV = Fd.version;
    }
    gl.uniform1i(u.field, 1);
    if (grid) { gl.uniform4f(u.fA, grid.cx, grid.cz, grid.ux, grid.uz); gl.uniform4f(u.fB, grid.umax, grid.vmin, grid.ds, grid.eps); gl.uniform2f(u.fN, grid.nu, grid.nv); }
    const E = F.camPos, B = F.basis, P = F.persp;
    gl.uniform3f(u.eye, E.x, E.y, E.z);
    gl.uniform3f(u.camR, B.right.x, B.right.y, B.right.z); gl.uniform3f(u.camU, B.up.x, B.up.y, B.up.z); gl.uniform3f(u.camF, B.forward.x, B.forward.y, B.forward.z);
    gl.uniform3f(u.persp, P.s, P.cx, P.cy);
    const L = light.dir;
    gl.uniform3f(u.sunL, L.x, L.y, L.z);
    const C = F.casters.slice(0, 16);
    C.forEach((c, i) => { ca.set([c.a.x, c.a.y, c.a.z, c.r], 4 * i); cb.set([c.b.x, c.b.y, c.b.z, c.r], 4 * i); });
    gl.uniform1i(u.nCast, C.length);
    if (u['castA[0]']) { gl.uniform4fv(u['castA[0]'], ca); gl.uniform4fv(u['castB[0]'], cb); }
    const Lm = (F.lamps || []).slice(0, 4);
    Lm.forEach((l, i) => { lp.set([l.pos.x, l.pos.y, l.pos.z, l.radius], 4 * i); lcol.set(l.color.map((v) => v / 255), 3 * i); });
    gl.uniform1i(u.nLamp, Lm.length);
    if (u['lampP[0]']) { gl.uniform4fv(u['lampP[0]'], lp); gl.uniform3fv(u['lampC[0]'], lcol); }
    gl.activeTexture(gl.TEXTURE0);
  };

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
    gl.bufferData(gl.ARRAY_BUFFER, cSink.f.subarray(0, cSink.n * 8), gl.STREAM_DRAW);
    gl.enable(gl.STENCIL_TEST);
    gl.useProgram(stencilP.p); gl.uniform4fv(stencilP.u.xf, xf); gl.uniform2f(stencilP.u.size, W, H);
    gl.useProgram(coverP.p); gl.uniform4fv(coverP.u.xf, xf); gl.uniform2f(coverP.u.size, W, H);
    groundUniforms(F, plan.ground);
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

