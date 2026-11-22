// Fits the grass tips' density by distance (grass.js tipTuning.share) offline, from walking views of the meadow in headless Chrome:
//   node tools/render/gpu/grassDensity.mjs [--fit[=N]] [--target=D]
// Prints, per distance band, the share of ground pixels covered by tip lines. --fit: N rounds (default 4) of scaling each knot's
// share by target / measured coverage (--target=<coverage %>, default: the median of the 181-512 bands, the meadow's far look),
// raising the density where a share would pass 1, then prints `density` and `share` to paste into grass.js tipTuning. Distances are
// the eye's 3D distance (walking: at least the eye's height, 52.3).
import { launch } from './cdp.mjs';

const args = process.argv.slice(2), flag = (k) => args.find((x) => x.startsWith('--' + k));
const rounds = flag('fit') ? Number(flag('fit').split('=')[1] || 4) : 0;
// knots at the bands' geometric middles
const bands = [8, 11, 16, 23, 32, 45, 64, 90, 128, 181, 256, 362, 512, 1024, 2048, 4096];
const knots = bands.slice(0, -1).map((b, i) => Math.round(Math.sqrt(b * bands[i + 1])));
// walking views: eye 52.3 units up (2 cubes, grid.js), level and looking slightly down, several places and directions
const views = [];
for (const [x, z] of [[700, 0], [200, 600], [1200, -700], [-400, -300], [1600, 900]])
  for (const yaw of [0, 2.1, 4.2]) for (const pitch of [-0.1, -0.2, -0.35, -0.6, -0.9, -1.2]) views.push([x, z, yaw, pitch]);

const br = await launch({ gpu: 'hardware', width: 400, height: 300 });
await br.open('/tools/render/gpu/blank.html');
const run = (share, density) => br.eval(`import('/tools/render/gpu/grassDensity.js').then((m) => m.measure(${JSON.stringify({ views, bands, share, density })}))`);
const cur = await br.eval(`import('/src/illusion/grass.js').then((m) => m.tipTuning)`);
let share = knots.map((d) => [d, interp(cur.share, d)]), density = cur.density;
function interp(tab, d) {   // grass.js tipShare, uncapped
  const l = Math.log(d), K = tab.map(([x, y]) => [Math.log(x), Math.log(y)]);
  if (l <= K[0][0]) return Math.exp(K[0][1]);
  for (let i = 1; i < K.length; i++) if (l <= K[i][0]) { const u = (l - K[i - 1][0]) / (K[i][0] - K[i - 1][0]); return Math.exp(K[i - 1][1] + u * (K[i][1] - K[i - 1][1])); }
  return Math.exp(K[K.length - 1][1]);
}
// per band: the MEDIAN over the views of the view's coverage (views with at least 2000 sampled ground pixels in the band): a view
// facing a hill in shade, or with the band only in a sliver, says little and would sway a sum
function coverageOf(r) {
  return bands.slice(0, -1).map((_, k) => {
    const cs = r.perView.filter(([, b, g]) => b === k && g >= 2000).map(([, , g, c]) => c / g).sort((a, b) => a - b);
    return cs.length ? cs[Math.floor(cs.length / 2)] : NaN;
  });
}
const show = (r, label) => {
  console.log(label);
  const cov = coverageOf(r);
  for (let k = 0; k < bands.length - 1; k++) {
    const n = r.perView.filter(([, b, g]) => b === k && g >= 2000).length;
    console.log(`  ${String(bands[k]).padStart(5)}-${String(bands[k + 1]).padEnd(5)} views ${String(n).padStart(3)}  coverage ${(100 * cov[k]).toFixed(2)}%`);
  }
};
let r = await run(share, density);
show(r, `current table (density ${density})`);
for (let round = 0; round < rounds; round++) {
  const cov = coverageOf(r);
  // the target: --target=<coverage %>, else the median of the bands from 181 to 512 (the far look the meadow has had)
  const mids = cov.filter((c, k) => bands[k] >= 181 && bands[k + 1] <= 512 && Number.isFinite(c)).sort((a, b) => a - b);
  const target = flag('target') ? Number(flag('target').split('=')[1]) / 100 : mids[Math.floor(mids.length / 2)];
  // each measured knot scaled by target / coverage; unmeasured ones keep their ratio to the nearest measured one
  const meas = cov.map((c) => c > 0 && Number.isFinite(c));
  let raw = share.map(([d, s], k) => [d, meas[k] ? s * target / cov[k] : null]);
  for (let k = 0; k < raw.length; k++) if (raw[k][1] === null) {
    let j = -1, best = 1e9;
    for (let q = 0; q < raw.length; q++) if (meas[q] && Math.abs(q - k) < best) { best = Math.abs(q - k); j = q; }
    raw[k][1] = j < 0 ? share[k][1] : share[k][1] * raw[j][1] / share[j][1];
  }
  // a share above 1 needs more blades: the density rises so the largest share is 1
  const top = Math.max(...raw.map(([, s]) => s));
  if (top > 1) { density *= top; raw = raw.map(([d, s]) => [d, s / top]); }
  share = raw;
  r = await run(share, density);
  show(r, `round ${round + 1} (target ${(100 * target).toFixed(2)}%, density ${density.toPrecision(3)})`);
}
if (rounds) console.log(`density: ${+density.toPrecision(3)},
share: [` + share.map(([d, s]) => `[${d}, ${+s.toPrecision(3)}]`).join(', ') + '],');
if (br.logs.length) console.log(br.logs.slice(0, 10).join('\n'));
await br.close();
process.exit(0);
