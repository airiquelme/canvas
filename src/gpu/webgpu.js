// WebGPU backend of the illusion renderer: the same plan (plan.js) and passes as webgl2.js, in one render pass per frame.
// Differences from WebGL2: 4x MSAA (the count WebGPU guarantees), and EXACT per-sample curve coverage: a curve triangle's fragment
// evaluates u^2 + v^2 <= 1 at each of the 4 standard sample positions (its (u, v) are affine on screen, so extrapolating them by
// their screen derivatives is exact) and writes the result as the sample mask, instead of WebGL2's alpha-to-coverage.
// Stencil masks are pipeline state in WebGPU, so every stencil operation of the passes is its own pipeline.
// PER-PIXEL GROUND SHADE (F.pixelGround): as webgl2.js (its COVER_FS has the description): the ground pieces' data and the shade
// field as textures (textureLoad), the camera, field, movers and lamps in a second uniform block. Only the cover passes that write
// color run it (fsCover); the stencil-only ones use fsPlain.
import { createFramePlanner, rgbOf } from './plan.js';
import { skyParams } from '../illusion/sky.js';
import { light, shadeOverlay } from '../illusion/light.js';
import { DESIGN_WIDTH, DESIGN_HEIGHT } from '../config.js';

const SAMPLES = 4;
const SHADER = /* wgsl */ `
// a ground fragment returns early unless it is ground: gid is flat per triangle, so a 2 x 2 quad never diverges (derivatives stay
// defined), which the static uniformity analysis can't see
diagnostic(off, derivative_uniformity);
struct U { xf: vec4f, size: vec2f, _p: vec2f, zen: vec4f, mid: vec4f, hor: vec4f, sunc: vec4f, gy: vec4f, sun: vec4f };
@group(0) @binding(0) var<uniform> u: U;
struct G { eye: vec4f, camR: vec4f, camU: vec4f, camF: vec4f, persp: vec4f, fA: vec4f, fB: vec4f, fN: vec4f, sunL: vec4f,
  counts: vec4f,   // mode (0 none, 1 field + movers, 2 all shade), hasField, nCast, nLamp
  castA: array<vec4f, 16>, castB: array<vec4f, 16>, lampP: array<vec4f, 4>, lampC: array<vec4f, 4> };
@group(0) @binding(1) var<uniform> gu: G;
@group(0) @binding(2) var gdata: texture_2d<f32>;
@group(0) @binding(3) var field: texture_2d<f32>;
fn gd(k: i32) -> vec4f { return textureLoad(gdata, vec2i(k % 1024, k / 1024), 0); }
fn fieldAt(xz: vec2f) -> f32 {
  let d = xz - gu.fA.xy;
  let uu = dot(d, gu.fA.zw); let vv = dot(d, vec2f(-gu.fA.w, gu.fA.z));
  let fi = (gu.fB.x - uu) / gu.fB.z; let fj = (vv - gu.fB.y) / gu.fB.z;
  let i = clamp(floor(fi), 0.0, gu.fN.x - 2.0); let j = clamp(floor(fj), 0.0, gu.fN.y - 2.0);
  let a = clamp(fi - i, 0.0, 1.0); let b = clamp(fj - j, 0.0, 1.0);
  let k = vec2i(i32(i), i32(j));
  let d00 = textureLoad(field, k, 0).r; let d10 = textureLoad(field, k + vec2i(1, 0), 0).r;
  let d01 = textureLoad(field, k + vec2i(0, 1), 0).r; let d11 = textureLoad(field, k + vec2i(1, 1), 0).r;
  return mix(mix(d00, d10, a), mix(d01, d11, a), b);
}
fn raySeg(P: vec3f, L: vec3f, A: vec3f, B: vec3f) -> vec2f {
  let v = B - A; let c = max(dot(v, v), 1e-9);
  var t = clamp(dot(P - A, v) / c, 0.0, 1.0); var s = 0.0;
  for (var it = 0; it < 3; it++) { s = max(0.0, dot(A + v * t - P, L)); t = clamp(dot(P + L * s - A, v) / c, 0.0, 1.0); }
  return vec2f(length(P + L * s - (A + v * t)), t);
}
fn groundColor(fc: vec2f, rgba: vec4f, gid: f32) -> vec4f {
  let g = i32(gid) * 4;
  let G0 = gd(g); let G1 = gd(g + 1); let G2 = gd(g + 2); let G3 = gd(g + 3);
  let dp = (fc - u.xf.yz) / u.xf.x;
  let D = gu.camF.xyz + ((dp.x - gu.persp.y) / gu.persp.x) * gu.camR.xyz - ((dp.y - gu.persp.z) / gu.persp.x) * gu.camU.xyz;
  let k2 = -(G0.x * D.x * D.x + G0.y * D.x * D.z + G0.z * D.z * D.z); let k1 = D.y - G0.w * D.x - G1.x * D.z; let k0 = G1.y;
  var t = 0.0;
  if (abs(k2) < 1e-9 * abs(k1)) { t = -k0 / k1; }
  else {
    let disc = k1 * k1 - 4.0 * k2 * k0;
    if (disc < 0.0) { t = -k1 / (2.0 * k2); }
    else {
      let q = -0.5 * (k1 + select(-1.0, 1.0, k1 >= 0.0) * sqrt(disc)); let r1 = q / k2; let r2 = k0 / q;
      let h1 = G1.zw + r1 * D.xz; let h2 = G1.zw + r2 * D.xz;
      t = select(r2, r1, r1 > 0.0 && (dot(h1, h1) < dot(h2, h2) || r2 <= 0.0));
    }
  }
  let P = gu.eye.xyz + max(t, 0.0) * D;
  let pw = max(length(fwidth(P)), 1e-4);   // (the antialiasing width: no derivative inside the loops, webgl2.js)
  var sh = 0.0;
  if (gu.counts.y > 0.5) { let fd = fieldAt(P.xz); sh = clamp((fd - gu.fB.w) / max(fwidth(fd), 1e-4) + 0.5, 0.0, 1.0); }
  let cm = u32(G3.z); let lm = u32(G3.w);   // the movers and lamps that can reach this piece (plan.js reachOf)
  for (var i = 0; i < 16; i++) {
    if (f32(i) >= gu.counts.z) { break; }
    if (((cm >> u32(i)) & 1u) == 0u) { continue; }
    let dr = raySeg(P, gu.sunL.xyz, gu.castA[i].xyz, gu.castB[i].xyz);
    let dd = dr.x - mix(gu.castA[i].w, gu.castB[i].w, dr.y);
    sh = max(sh, clamp(0.5 - dd / pw, 0.0, 1.0));
  }
  if (gu.counts.x > 1.5) { sh = 1.0; }
  var best = 0.0; var lc = vec3f(0.0);
  for (var i = 0; i < 4; i++) {
    if (f32(i) >= gu.counts.w) { break; }
    if (((lm >> u32(i)) & 1u) == 0u) { continue; }
    let dl = length(P - gu.lampP[i].xyz) / gu.lampP[i].w; let w = pw / gu.lampP[i].w;
    let lv = 0.22 * clamp((1.0 - dl) / w + 0.5, 0.0, 1.0) + 0.26 * clamp((0.66 - dl) / w + 0.5, 0.0, 1.0) + 0.27 * clamp((0.33 - dl) / w + 0.5, 0.0, 1.0);
    if (lv > best) { best = lv; lc = gu.lampC[i].rgb; }
  }
  let shadeC = mix(G2.xyz, vec3f(G2.w, G3.x, G3.y) * lc, best);
  return vec4f(mix(rgba.rgb, shadeC, sh), rgba.a);
}

fn clip(pos: vec2f, z: f32) -> vec4f {
  let p = vec2f(u.xf.x * pos.x + u.xf.y, u.xf.x * pos.y + u.xf.z);
  return vec4f(p.x / u.size.x * 2.0 - 1.0, 1.0 - p.y / u.size.y * 2.0, z, 1.0);
}

struct SOut { @builtin(position) pos: vec4f, @location(0) uvm: vec3f };
@vertex fn vsStencil(@location(0) pos: vec2f, @location(1) uvm: vec3f) -> SOut {
  var o: SOut; o.pos = clip(pos, 0.5); o.uvm = uvm; return o;
}
struct FOut { @location(0) color: vec4f, @builtin(sample_mask) mask: u32 };
@fragment fn fsStencil(i: SOut) -> FOut {
  var o: FOut; o.color = vec4f(0.0);
  o.mask = 0xfu;
  // derivatives in uniform control flow (every fragment of the draw computes them)
  let dx = dpdx(i.uvm.xy); let dy = dpdy(i.uvm.xy);
  if (i.uvm.z > 0.5) {   // a curve triangle: the samples inside the unit circle
    // the standard 4x sample positions, from the pixel center
    let s = array<vec2f, 4>(vec2f(-0.125, -0.375), vec2f(0.375, -0.125), vec2f(-0.375, 0.125), vec2f(0.125, 0.375));
    var m = 0u;
    for (var k = 0u; k < 4u; k++) {
      let q = i.uvm.xy + dx * s[k].x + dy * s[k].y;
      if (dot(q, q) <= 1.0) { m |= (1u << k); }
    }
    o.mask = m;
  }
  return o;
}

struct COut { @builtin(position) pos: vec4f, @location(0) rgba: vec4f, @location(1) @interpolate(flat) gid: f32 };
@vertex fn vsCover(@location(0) pos: vec2f, @location(1) z: f32, @location(2) rgba: vec4f, @location(3) gid: f32) -> COut {
  var o: COut; o.pos = clip(pos, z * 0.5 + 0.5); o.rgba = rgba; o.gid = gid; return o;   // (clip-space z in -1..1 as in WebGL -> 0..1)
}
@fragment fn fsCover(i: COut) -> @location(0) vec4f {
  if (i.gid < 0.0 || gu.counts.x < 0.5) { return i.rgba; }
  return groundColor(i.pos.xy, i.rgba, i.gid);   // (pos.xy: framebuffer px, y down)
}
@fragment fn fsPlain(i: COut) -> @location(0) vec4f { return i.rgba; }

struct KOut { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };
@vertex fn vsSky(@builtin(vertex_index) vi: u32) -> KOut {
  let q = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1), vec2f(-1, 1), vec2f(1, -1), vec2f(1, 1));
  var o: KOut; o.pos = vec4f(q[vi], 0.999999, 1.0); o.ndc = q[vi]; return o;
}
@fragment fn fsSky(i: KOut) -> @location(0) vec4f {
  let c = vec2f((i.ndc.x + 1.0) * 0.5 * u.size.x, (1.0 - i.ndc.y) * 0.5 * u.size.y);
  let d = vec2f((c.x - u.xf.y) / u.xf.x, (c.y - u.xf.z) / u.xf.x);
  let t = clamp((d.y - u.gy.x) / (u.gy.y - u.gy.x), 0.0, 1.0);
  var col = select(mix(u.mid.rgb, u.hor.rgb, (t - 0.75) / 0.25), mix(u.zen.rgb, u.mid.rgb, t / 0.75), t < 0.75);
  if (u.sun.z > 0.0) {
    let q = d - u.sun.xy;
    if (abs(q.x) <= u.sun.z * 6.0 && abs(q.y) <= u.sun.z * 6.0) {
      let k = clamp((length(q) - u.sun.z * 0.8) / (u.sun.z * 5.2), 0.0, 1.0);
      col = mix(col, u.sunc.rgb, 0.45 * (1.0 - k));
    }
    let dd = length(q) - u.sun.z;
    col = mix(col, u.sunc.rgb, clamp(0.5 - dd * u.xf.x, 0.0, 1.0));
  }
  return vec4f(col, 1.0);
}
`;

export async function createWebGPU(canvas, { preserveDrawingBuffer = false } = {}) {
  if (!navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  const ctx = canvas.getContext('webgpu');
  if (!ctx) return null;
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: 'opaque', usage: GPUTextureUsage.RENDER_ATTACHMENT | (preserveDrawingBuffer ? GPUTextureUsage.COPY_SRC : 0) });
  const module = device.createShaderModule({ code: SHADER });
  const ubuf = device.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const GU_FLOATS = 4 * (10 + 16 + 16 + 4 + 4);
  const gubuf = device.createBuffer({ size: GU_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const unf = { sampleType: 'unfilterable-float' };
  const layout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: unf },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: unf },
  ] });
  // per-pixel ground: the pieces' data (rgba32float, 1024 texels a row, 4 per piece) and the shade field (r32float); the bind group
  // is remade when either texture is
  const tex = (w, h, format) => device.createTexture({ size: [w, h], format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  let gTex = tex(1024, 1, 'rgba32float'), fTex = tex(2, 2, 'r32float'), gRows = 1, fieldOf = null, fieldV = -1, bind = null;
  const rebind = () => { bind = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: ubuf } }, { binding: 1, resource: { buffer: gubuf } },
    { binding: 2, resource: gTex.createView() }, { binding: 3, resource: fTex.createView() }] }); };
  rebind();
  const gu = new Float32Array(GU_FLOATS);
  const groundUniforms = (F, ground) => {
    gu.fill(0);
    const pix = !!F.pixelGround && light.on;
    gu[36] = !pix ? 0 : light.dir.y <= 0 || (F.field && F.field.all) ? 2 : 1;
    if (pix) {
      const rows = Math.max(1, Math.ceil((ground.n * 4) / 1024));
      if (rows > gRows) { gTex.destroy(); gTex = tex(1024, rows, 'rgba32float'); gRows = rows; bind = null; }
      if (ground.n) device.queue.writeTexture({ texture: gTex }, ground.data.buffer, { offset: ground.data.byteOffset, bytesPerRow: 1024 * 16 },
        { width: Math.min(1024, ground.n * 4), height: Math.ceil((ground.n * 4) / 1024) });
      const Fd = F.field, grid = Fd && Fd.grid;
      if (grid && (fieldOf !== Fd || fieldV !== Fd.version)) {
        if (fTex.width !== grid.nu || fTex.height !== grid.nv) { fTex.destroy(); fTex = tex(grid.nu, grid.nv, 'r32float'); bind = null; }
        device.queue.writeTexture({ texture: fTex }, grid.depth.buffer, { offset: grid.depth.byteOffset, bytesPerRow: grid.nu * 4 }, { width: grid.nu, height: grid.nv });
        fieldOf = Fd; fieldV = Fd.version;
      }
      const E = F.camPos, B = F.basis, Pp = F.persp, L = light.dir;
      gu.set([E.x, E.y, E.z, 0, B.right.x, B.right.y, B.right.z, 0, B.up.x, B.up.y, B.up.z, 0, B.forward.x, B.forward.y, B.forward.z, 0, Pp.s, Pp.cx, Pp.cy, 0], 0);
      if (grid) gu.set([grid.cx, grid.cz, grid.ux, grid.uz, grid.umax, grid.vmin, grid.ds, grid.eps, grid.nu, grid.nv, 0, 0], 20);
      gu.set([L.x, L.y, L.z, 0], 32);
      const C = F.casters.slice(0, 16), Lm = (F.lamps || []).slice(0, 4);
      gu[37] = grid ? 1 : 0; gu[38] = C.length; gu[39] = Lm.length;
      C.forEach((c, i) => { gu.set([c.a.x, c.a.y, c.a.z, c.r], 40 + 4 * i); gu.set([c.b.x, c.b.y, c.b.z, c.r], 104 + 4 * i); });
      Lm.forEach((l, i) => { gu.set([l.pos.x, l.pos.y, l.pos.z, l.radius], 168 + 4 * i); gu.set(l.color.map((v) => v / 255), 184 + 4 * i); });
    }
    if (!bind) rebind();
    device.queue.writeBuffer(gubuf, 0, gu);
  };
  const plLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const DS = 'depth24plus-stencil8';
  const stencilVB = [{ arrayStride: 20, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }, { shaderLocation: 1, offset: 8, format: 'float32x3' }] }];
  const coverVB = [{ arrayStride: 32, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }, { shaderLocation: 1, offset: 8, format: 'float32' }, { shaderLocation: 2, offset: 12, format: 'float32x4' }, { shaderLocation: 3, offset: 28, format: 'float32' }] }];
  const face = (compare, passOp, failOp = 'keep', depthFailOp = 'keep') => ({ compare, passOp, failOp, depthFailOp });
  // one pipeline per pass kind: { vs, fs, vb, color (write), blend, depth: [compare, write], front / back stencil faces, masks }
  const pipe = ({ vs, fs, vb, color = true, blend, depth = ['always', false], front, back = front, read = 0xff, write = 0xff }) =>
    device.createRenderPipeline({
      layout: plLayout,
      vertex: { module, entryPoint: vs, buffers: vb },
      fragment: { module, entryPoint: fs, targets: [{ format, writeMask: color ? GPUColorWrite.ALL : 0, blend }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: DS, depthCompare: depth[0], depthWriteEnabled: depth[1], stencilFront: front, stencilBack: back, stencilReadMask: read, stencilWriteMask: write },
      multisample: { count: SAMPLES },
    });
  const always = face('always', 'keep');
  const P = {
    sky: pipe({ vs: 'vsSky', fs: 'fsSky', vb: [], front: always }),
    under: pipe({ vs: 'vsCover', fs: 'fsCover', vb: coverVB, depth: ['less', true], front: always }),
    winding: pipe({ vs: 'vsStencil', fs: 'fsStencil', vb: stencilVB, color: false, front: face('always', 'increment-wrap'), back: face('always', 'decrement-wrap') }),
    winding6: pipe({ vs: 'vsStencil', fs: 'fsStencil', vb: stencilVB, color: false, front: face('always', 'increment-wrap'), back: face('always', 'decrement-wrap'), write: 0x3f }),
    parity7: pipe({ vs: 'vsStencil', fs: 'fsStencil', vb: stencilVB, color: false, front: face('always', 'invert'), write: 0x80 }),
    // fills blend by their opacity (1 but for fading pieces), the canvas's alpha kept
    cover: pipe({ vs: 'vsCover', fs: 'fsCover', vb: coverVB, depth: ['less', true], front: face('not-equal', 'zero', 'keep', 'zero'),
      blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } } }),
    winding7: pipe({ vs: 'vsStencil', fs: 'fsStencil', vb: stencilVB, color: false, front: face('always', 'increment-wrap'), back: face('always', 'decrement-wrap'), write: 0x7f }),
    cover7: pipe({ vs: 'vsCover', fs: 'fsCover', vb: coverVB, depth: ['less', true], front: face('not-equal', 'zero', 'keep', 'zero'), read: 0x7f }),
    flagZero: pipe({ vs: 'vsCover', fs: 'fsPlain', vb: coverVB, color: false, front: face('equal', 'invert'), write: 0x80 }),   // ref 0
    zeroNotFlag: pipe({ vs: 'vsCover', fs: 'fsPlain', vb: coverVB, color: false, front: face('not-equal', 'zero') }),            // ref 0x80
    zeroNo7: pipe({ vs: 'vsCover', fs: 'fsPlain', vb: coverVB, color: false, front: face('equal', 'zero'), read: 0x80 }),        // ref 0
    zeroAll: pipe({ vs: 'vsCover', fs: 'fsPlain', vb: coverVB, color: false, front: face('always', 'zero') }),
    zeroBut6: pipe({ vs: 'vsCover', fs: 'fsPlain', vb: coverVB, color: false, front: face('always', 'zero'), write: 0xbf }),
    noHost: pipe({ vs: 'vsCover', fs: 'fsPlain', vb: coverVB, color: false, front: face('equal', 'zero'), read: 0x3f, write: 0x80 }),   // ref 0
    shadeMul: pipe({ vs: 'vsCover', fs: 'fsPlain', vb: coverVB, depth: ['less', false], front: face('equal', 'keep'), read: 0xc0, write: 0,
      blend: { color: { srcFactor: 'zero', dstFactor: 'constant', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } } }),
    shadeAdd: pipe({ vs: 'vsCover', fs: 'fsPlain', vb: coverVB, depth: ['less', false], front: face('equal', 'invert'), read: 0xc0, write: 0x40,
      blend: { color: { srcFactor: 'constant', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } } }),
  };
  let msaa = null, ds = null, tw = 0, th = 0;
  const targets = (w, h) => {
    if (msaa && w === tw && h === th) return;
    if (msaa) { msaa.destroy(); ds.destroy(); }
    tw = w; th = h;
    msaa = device.createTexture({ size: [w, h], sampleCount: SAMPLES, format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    ds = device.createTexture({ size: [w, h], sampleCount: SAMPLES, format: DS, usage: GPUTextureUsage.RENDER_ATTACHMENT });
  };
  let sBuf = null, cBuf = null;
  const upload = (old, data) => {
    const bytes = Math.max(256, data.byteLength);
    let b = old;
    if (!b || b.size < bytes) { if (b) b.destroy(); b = device.createBuffer({ size: Math.ceil(bytes * 1.5 / 256) * 256, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }); }
    if (data.byteLength) device.queue.writeBuffer(b, 0, data.buffer, data.byteOffset, data.byteLength);
    return b;
  };
  const planner = createFramePlanner();
  const uni = new Float32Array(64);

  function render(F, { darkMode = false } = {}) {
    const t0 = performance.now();
    const W = canvas.width, H = canvas.height, fit = F.fit;
    const plan = planner.plan(F);
    const t1 = performance.now();
    targets(W, H);
    uni.fill(0);
    uni.set([fit, W / 2 - (fit * DESIGN_WIDTH) / 2, H / 2 - (fit * DESIGN_HEIGHT) / 2, 0, W, H], 0);
    if (F.sky) {
      const S = skyParams(F.view, { projectPoint: F.projectPoint, camPos: F.camPos, forward: F.forward, light, sunDisc: F.sky.sunDisc });
      uni.set(S.zenith.map((v) => v / 255), 8); uni.set(S.mid.map((v) => v / 255), 12); uni.set(S.horizon.map((v) => v / 255), 16);
      if (S.sun) { uni.set(S.sun.color.map((v) => v / 255), 20); uni.set([S.sun.x, S.sun.y, S.sun.r], 28); }
      uni.set([S.g0, S.g1], 24);
    }
    device.queue.writeBuffer(ubuf, 0, uni);
    groundUniforms(F, plan.ground);
    const { sSink, cSink } = plan;
    sBuf = upload(sBuf, sSink.f.subarray(0, sSink.n * 5));
    cBuf = upload(cBuf, cSink.f.subarray(0, cSink.n * 8));
    const enc = device.createCommandEncoder();
    const bg = darkMode ? 0 : 1;
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: msaa.createView(), resolveTarget: ctx.getCurrentTexture().createView(), clearValue: { r: bg, g: bg, b: bg, a: 1 }, loadOp: 'clear', storeOp: 'discard' }],
      depthStencilAttachment: { view: ds.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard', stencilClearValue: 0, stencilLoadOp: 'clear', stencilStoreOp: 'discard' },
    });
    pass.setBindGroup(0, bind);
    pass.setVertexBuffer(0, sBuf);
    let vb = 's';
    const draw = (pl, r, ref = 0, buf = 'c') => {
      if (r[1] <= r[0]) return;
      if (buf !== vb) { pass.setVertexBuffer(0, buf === 's' ? sBuf : cBuf); vb = buf; }
      pass.setPipeline(pl); pass.setStencilReference(ref);
      pass.draw(r[1] - r[0], 1, r[0]);
    };
    if (F.sky) { pass.setPipeline(P.sky); pass.draw(6); }
    draw(P.under, plan.under);
    for (const G of plan.fills) { draw(P.winding, G.tris, 0, 's'); draw(P.cover, G.boxes); }
    for (const G of plan.crescents) {   // (webgl2.js: the moved shape's winding as a flag, bit 7 = outside it)
      draw(P.winding, G.moved, 0, 's');
      draw(P.flagZero, G.movedBoxes, 0);
      draw(P.zeroNotFlag, G.movedBoxes, 0x80);
      draw(P.winding7, G.shapes, 0, 's');
      draw(P.zeroNo7, G.movedBoxes, 0);
      draw(P.cover7, G.boxes);
      draw(P.zeroAll, G.movedBoxes);
    }
    if (plan.shadows.length) {
      const [mul, add] = shadeOverlay().map((x) => rgbOf(x.color));
      for (const G of plan.shadows) {
        draw(P.winding6, G.hosts, 0, 's');
        draw(P.parity7, G.shape, 0, 's');
        draw(P.noHost, G.allBox, 0);
        pass.setBlendConstant({ r: mul[0], g: mul[1], b: mul[2], a: 1 });
        draw(P.shadeMul, G.box, 0x80);
        pass.setBlendConstant({ r: add[0], g: add[1], b: add[2], a: 1 });
        draw(P.shadeAdd, G.box, 0x80);
        draw(P.zeroBut6, G.allBox);
      }
    }
    pass.end();
    device.queue.submit([enc.finish()]);
    const t2 = performance.now();
    const st = F.stats;
    st.buildMs = F.t1 - F.t0; st.prepMs = t1 - t0; st.drawMs = t2 - t0;
    st.groups = plan.fills.length + plan.crescents.length; st.pieces = plan.entries; st.shadows = plan.shadows.length;
    st.vertices = sSink.n + cSink.n; st.frame = F.frameNo; st.samples = SAMPLES;
    return st;
  }
  return { name: 'webgpu', device, render, samples: SAMPLES, sync: () => device.queue.onSubmittedWorkDone() };
}
