// Time per render() of the demo scene over the orbit, with the squashed shapes and with every node
// forced round (SPHERES=1). Run from a copy of the modules.
const R = await import('../render.js'), C = await import('../camera.js'), S = await import('../scene.js'), G = await import('../geometry.js');
S.buildDemoScene();
if (process.env.SPHERES) Object.values(S.nodes).forEach(n => { n.shape = G.makeShape(n.radius, 1, { x: 0, y: 1, z: 0 }); });
const ctx = new Proxy({}, { get: (_, n) => (n === 'getTransform' ? () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) : () => {}), set: () => true });
const N = 240, canvas = { width: 1000, height: 800 };
for (let i = 0; i < 30; i++) { C.camera.orbitAngle = i * 0.2; R.render(ctx, canvas, { darkMode: false }); }
const t0 = performance.now();
for (let i = 0; i < N; i++) { C.camera.orbitAngle = (i / N) * Math.PI * 2; R.render(ctx, canvas, { darkMode: false }); }
console.log(process.env.SPHERES ? 'all round' : 'squashed demo', ((performance.now() - t0) / N).toFixed(2), 'ms per frame');
