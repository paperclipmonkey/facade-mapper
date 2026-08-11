/**
 * Seeded 3D simplex noise + fractal helpers.
 *
 * Every effect gets a noise function from here rather than reaching for
 * Math.random(), so two projector tabs rendering the same overlapping wall
 * produce pixel-identical flame and fog instead of two fighting versions.
 */

import { makeRng } from './math.js';

const GRAD3 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

const F3 = 1 / 3;
const G3 = 1 / 6;

export function createNoise(seed = 'facade') {
  const rng = makeRng(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  // Fisher-Yates with the seeded generator.
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  const perm = new Uint8Array(512);
  const permMod12 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255];
    permMod12[i] = perm[i] % 12;
  }

  /** 3D simplex noise, roughly in [-1, 1]. */
  function noise3(xin, yin, zin) {
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const z0 = zin - (k - t);

    let i1;
    let j1;
    let k1;
    let i2;
    let j2;
    let k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
    else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }

    const x1 = x0 - i1 + G3;
    const y1 = y0 - j1 + G3;
    const z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3;
    const y2 = y0 - j2 + 2 * G3;
    const z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3;
    const y3 = y0 - 1 + 3 * G3;
    const z3 = z0 - 1 + 3 * G3;

    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;

    let n = 0;
    const corner = (gi, x, y, z) => {
      let t0 = 0.6 - x * x - y * y - z * z;
      if (t0 < 0) return 0;
      t0 *= t0;
      const g = gi * 3;
      return t0 * t0 * (GRAD3[g] * x + GRAD3[g + 1] * y + GRAD3[g + 2] * z);
    };

    n += corner(permMod12[ii + perm[jj + perm[kk]]], x0, y0, z0);
    n += corner(permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]], x1, y1, z1);
    n += corner(permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]], x2, y2, z2);
    n += corner(permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]], x3, y3, z3);

    return 32 * n;
  }

  const noise2 = (x, y) => noise3(x, y, 0);

  /** Sum of octaves. Higher `octaves` = more fine detail, at linear cost. */
  function fbm(x, y, z = 0, octaves = 4, lacunarity = 2, gain = 0.5) {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let fx = x;
    let fy = y;
    let fz = z;
    for (let o = 0; o < octaves; o++) {
      sum += noise3(fx, fy, fz) * amp;
      norm += amp;
      amp *= gain;
      fx *= lacunarity;
      fy *= lacunarity;
      fz *= lacunarity;
    }
    return norm > 0 ? sum / norm : 0;
  }

  /** Absolute-value fbm. Gives the wispy ridges that read as flame and smoke. */
  function turbulence(x, y, z = 0, octaves = 4) {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let fx = x;
    let fy = y;
    let fz = z;
    for (let o = 0; o < octaves; o++) {
      sum += Math.abs(noise3(fx, fy, fz)) * amp;
      norm += amp;
      amp *= 0.5;
      fx *= 2;
      fy *= 2;
      fz *= 2;
    }
    return norm > 0 ? sum / norm : 0;
  }

  return { noise2, noise3, fbm, turbulence };
}

/** Shared default instance, handed to effects that don't need their own seed. */
export const defaultNoise = createNoise('facade-mapper');
