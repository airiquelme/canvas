// Tones (CLAUDE.md "Light engine"). Pure math, no canvas.
import { lighting } from './config.js';

export const UNLIT = 0, SHADE = 1, TWILIGHT = 2, LIT = 3, SHINING = 4;

const colorCache = new Map();
// `hex` (#rgb or #rrggbb) in a tone: Lit is the color itself.
export function toneColor(hex, tone) {
  const key = hex + tone;
  let out = colorCache.get(key);
  if (out) return out;
  const mix = lighting.toneMix[tone];
  if (!mix) out = hex;
  else {
    const h = hex.length === 4 ? '#' + [...hex.slice(1)].map(ch => ch + ch).join('') : hex;
    const channel = (i) => {
      const c = parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16);
      return Math.round(mix > 0 ? c * (1 - mix) : c + (255 - c) * -mix);
    };
    out = '#' + [0, 1, 2].map(i => channel(i).toString(16).padStart(2, '0')).join('');
  }
  colorCache.set(key, out);
  return out;
}
