/**
 * Physically-motivated colour.
 *
 * Two things in here fix a lot of "why does that look like paint rather than
 * light".
 *
 * **Blackbody.** Fire, embers, candles, sparks and filament bulbs are all
 * thermal emitters: their colour is a function of temperature, not an arbitrary
 * hex value. Picking "orange" and dimming it towards black is wrong — a cooling
 * flame goes deep red before it goes dark, and a hot one goes yellow-white
 * rather than pale orange. Driving colour from a temperature makes every one of
 * those effects behave correctly as it brightens and fades, for free.
 *
 * **Linear mixing.** sRGB values are gamma-encoded, so lerping between two of
 * them travels through a muddy, desaturated middle. Blending in linear light
 * and converting back is what makes a flame's yellow-to-red gradient look like
 * a gradient of light rather than a smear of pigment.
 */

import { clamp } from '../core/math.js';

/* ------------------------------------------------------------------ *
 * sRGB <-> linear
 * ------------------------------------------------------------------ */

export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(c) {
  const v = clamp(c, 0, 1);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

/* ------------------------------------------------------------------ *
 * Blackbody radiation
 * ------------------------------------------------------------------ */

/**
 * Approximate the colour of a blackbody at `kelvin`, as 0..255 sRGB.
 *
 * Curve-fit to the Planckian locus (the standard Tanner Helland fit), valid
 * roughly 1000K–40000K. Exact enough that a 1200K ember and a 1900K flame tip
 * are visibly, correctly different, which is all this needs to do.
 *
 * Useful landmarks: 1000K dull red embers, 1500K orange flame, 1850K candle,
 * 2400K bright yellow flame, 3000K tungsten, 5500K daylight, 9000K+ the blue
 * white of a lightning channel.
 */
export function blackbody(kelvin) {
  const t = clamp(kelvin, 1000, 40000) / 100;
  let r;
  let g;
  let b;

  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
  } else {
    r = 329.698727446 * (t - 60) ** -0.1332047592;
    g = 288.1221695283 * (t - 60) ** -0.0755148492;
  }

  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;

  return [clamp(r, 0, 255), clamp(g, 0, 255), clamp(b, 0, 255)];
}

const bbCache = new Map();
const bbHexCache = new Map();

/** Blackbody as 0..255 components, for writing straight into an ImageData. */
export function blackbodyBytes(kelvin) {
  const key = Math.round(clamp(kelvin, 1000, 12000) / 25) * 25;
  let rgb = bbCache.get(key);
  if (!rgb) {
    rgb = blackbody(key).map(Math.round);
    bbCache.set(key, rgb);
  }
  return rgb;
}

/**
 * Cached blackbody as a `#rrggbb` string. Quantised to 25K, which is invisible.
 *
 * Hex rather than `rgb()` on purpose: every colour helper in here and in
 * core/math.js — `rgba`, `mixHex`, `mixLinear`, `glow` — parses hex, so
 * returning anything else silently turns into black at the first call site that
 * wants to apply an alpha to it.
 */
export function blackbodyCss(kelvin) {
  const key = Math.round(clamp(kelvin, 1000, 12000) / 25) * 25;
  let hex = bbHexCache.get(key);
  if (!hex) {
    const rgb = blackbodyBytes(key);
    hex = `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    bbHexCache.set(key, hex);
  }
  return hex;
}

/* ------------------------------------------------------------------ *
 * Mixing
 * ------------------------------------------------------------------ */

function parseHex(hex) {
  const h = String(hex || '#000000').replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full.slice(0, 6), 16) || 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const toHexByte = (v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0');

/**
 * Blend two colours through linear light rather than through sRGB.
 *
 * The difference is most obvious mixing a saturated colour with white or with
 * its complement: sRGB lerp dips through a dull midpoint, linear does not.
 */
export function mixLinear(a, b, t) {
  const A = parseHex(a);
  const B = parseHex(b);
  const f = clamp(t, 0, 1);
  const out = [0, 1, 2].map((i) => {
    const lin = srgbToLinear(A[i]) * (1 - f) + srgbToLinear(B[i]) * f;
    return linearToSrgb(lin);
  });
  return `#${toHexByte(out[0])}${toHexByte(out[1])}${toHexByte(out[2])}`;
}

/**
 * Sample a multi-stop ramp in linear light.
 * @param {Array<[number,string]>} stops sorted [position, hex] pairs
 */
export function rampAt(stops, t) {
  const f = clamp(t, 0, 1);
  if (!stops.length) return '#000000';
  if (f <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (f <= stops[i][0]) {
      const [p0, c0] = stops[i - 1];
      const [p1, c1] = stops[i];
      const span = p1 - p0 || 1e-6;
      return mixLinear(c0, c1, (f - p0) / span);
    }
  }
  return stops[stops.length - 1][1];
}

/**
 * Perceived brightness of a colour, in linear light.
 * Used to keep an effect's total output steady while its hue moves.
 */
export function luminance(hex) {
  const [r, g, b] = parseHex(hex).map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
