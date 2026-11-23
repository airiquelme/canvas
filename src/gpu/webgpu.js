// WebGPU backend of the illusion renderer: the same plan (plan.js) and passes as webgl2.js, in one render pass per frame.
// Differences from WebGL2: 4x MSAA (the count WebGPU guarantees), and EXACT per-sample curve coverage: a curve triangle's fragment
// evaluates u^2 + v^2 <= 1 at each of the 4 standard sample positions (its (u, v) are affine on screen, so extrapolating them by
// their screen derivatives is exact) and writes the result as the sample mask, instead of WebGL2's alpha-to-coverage.
// Stencil masks are pipeline state in WebGPU, so every stencil operation of the passes is its own pipeline.
import { createFramePlanner, rgbOf } from './plan.js';
import { skyParams } from '../illusion/sky.js';
import { light, shadeOverlay } from '../illusion/light.js';
import { DESIGN_WIDTH, DESIGN_HEIGHT } from '../config.js';

const SAMPLES = 4;
const SHADER = /* wgsl */ `
struct U { xf: vec4f, size: vec2f, _p: vec2f, zen: vec4f, mid: vec4f, hor: vec4f, sunc: vec4f, gy: vec4f, sun: vec4f };
@group(0) @binding(0) var<uniform> u: U;

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

struct COut { @builtin(position) pos: vec4f, @location(0) rgba: vec4f };
@vertex fn vsCover(@location(0) pos: vec2f, @location(1) z: f32, @location(2) rgba: vec4f) -> COut {
  var o: COut; o.pos = clip(pos, z * 0.5 + 0.5); o.rgba = rgba; return o;   // (clip-space z in -1..1 as in WebGL -> 0..1)
}
@fragment fn fsCover(i: COut) -> @location(0) vec4f { return i.rgba; }

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
  const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }] });
  const bind = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: ubuf } }] });
  const plLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const DS = 'depth24plus-stencil8';
  const stencilVB = [{ arrayStride: 20, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }, { shaderLocation: 1, offset: 8, format: 'float32x3' }] }];
  const coverVB = [{ arrayStride: 28, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }, { shaderLocation: 1, offset: 8, format: 'float32' }, { shaderLocation: 2, offset: 12, format: 'float32x4' }] }];
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
    edges: pipe({ vs: 'vsCover', fs: 'fsCover', vb: coverVB, depth: ['less', true], front: always }),
    winding: pipe({ vs: 'vsStencil', fs: 'fsStencil', vb: stencilVB, color: false, front: face('always', 'increment-wrap'), back: face('always', 'decrement-wrap') }),
    winding6: pipe({ vs: 'vsStencil', fs: 'fsStencil', vb: stencilVB, color: false, front: face('always', 'increment-wrap'), back: face('always', 'decrement-wrap'), write: 0x3f }),
    parity7: pipe({ vs: 'vsStencil', fs: 'fsStencil', vb: stencilVB, color: false, front: face('always', 'invert'), write: 0x80 }),
    // fills blend by their opacity (1 but for fading pieces), the canvas's alpha kept
    cover: pipe({ vs: 'vsCover', fs: 'fsCover', vb: coverVB, depth: ['less', true], front: face('not-equal', 'zero', 'keep', 'zero'),
      blend: { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } } }),
    winding7: pipe({ vs: 'vsStencil', fs: 'fsStencil', vb: stencilVB, color: false, front: face('always', 'increment-wrap'), back: face('always', 'decrement-wrap'), write: 0x7f }),
    cover7: pipe({ vs: 'vsCover', fs: 'fsCover', vb: coverVB, depth: ['less', true], front: face('not-equal', 'zero', 'keep', 'zero'), read: 0x7f }),
    flagZero: pipe({ vs: 'vsCover', fs: 'fsCover', vb: coverVB, color: false, front: face('equal', 'invert'), write: 0x80 }),   // ref 0
    zeroNotFlag: pipe({ vs: 'vsCover', fs: 'fsCover', vb: coverVB, color: false, front: face('not-equal', 'zero') }),            // ref 0x80
    zeroNo7: pipe({ vs: 'vsCover', fs: 'fsCover', vb: coverVB, color: false, front: face('equal', 'zero'), read: 0x80 }),        // ref 0
    zeroAll: pipe({ vs: 'vsCover', fs: 'fsCover', vb: coverVB, color: false, front: face('always', 'zero') }),
    zeroBut6: pipe({ vs: 'vsCover', fs: 'fsCover', vb: coverVB, color: false, front: face('always', 'zero'), write: 0xbf }),
    noHost: pipe({ vs: 'vsCover', fs: 'fsCover', vb: coverVB, color: false, front: face('equal', 'zero'), read: 0x3f, write: 0x80 }),   // ref 0
    shadeMul: pipe({ vs: 'vsCover', fs: 'fsCover', vb: coverVB, depth: ['less', false], front: face('equal', 'keep'), read: 0xc0, write: 0,
      blend: { color: { srcFactor: 'zero', dstFactor: 'constant', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } } }),
    shadeAdd: pipe({ vs: 'vsCover', fs: 'fsCover', vb: coverVB, depth: ['less', false], front: face('equal', 'invert'), read: 0xc0, write: 0x40,
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
    const { sSink, cSink } = plan;
    sBuf = upload(sBuf, sSink.f.subarray(0, sSink.n * 5));
    cBuf = upload(cBuf, cSink.f.subarray(0, cSink.n * 7));
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
    draw(P.edges, plan.edges);   // silhouette edges, at their patches' depths
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
