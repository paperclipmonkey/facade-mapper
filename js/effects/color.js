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

/* ------------------------------------------------------------------ *
 * Water
 * ------------------------------------------------------------------ */

/**
 * Absorption coefficients of clear water, per metre, at the wavelengths a
 * display's three primaries sit at — roughly 630 nm, 532 nm and 465 nm.
 *
 * Read off the pure-water absorption spectrum (Pope & Fry 1997). The numbers
 * matter less than the *ratio*: water is nearly thirty times more absorbing in
 * the red than in the blue, which is the entire reason anything more than a
 * couple of metres under the surface is blue. It is not a tint anybody chose.
 * A diver's torch at ten metres puts out the same white it always did; what
 * comes back has had its red taken out of it on the way there and again on the
 * way back.
 */
const WATER_ABSORPTION = [0.30, 0.047, 0.0105];

/**
 * A colour as it arrives after `metres` of water, by Beer–Lambert.
 *
 * `I = I0 · e^(−a·d)`, per channel, in linear light — which is the only place
 * it means anything, because absorption is a fraction of the *energy* and an
 * sRGB value is not energy.
 *
 * This is the water equivalent of `blackbodyCss`, and it earns its keep the same
 * way. Fading a chosen blue towards black as things get deeper gives you a
 * uniform darkening, which reads as a dimmer switch. Removing the red first
 * gives you the thing everybody recognises from a photograph taken underwater:
 * warm things lose their colour with distance while blue-green things barely
 * change, so depth is legible from the colour alone rather than only from the
 * brightness. On a projector, where you cannot make the wall darker, that
 * distinction is the whole of it.
 *
 * `turbidity` scales all three coefficients together: 1 is clear open water, and
 * anything above about 4 is a harbour. It multiplies rather than replaces
 * because suspended matter absorbs broadly — it makes water murkier without
 * making it a different colour of murky.
 *
 * Cached, and quantised to a quarter of a metre to make the cache work — see
 * below, and `blackbodyCss`, which does the same thing for the same reason.
 *
 * @param {string} hex    the colour leaving the source
 * @param {number} metres how far it travels through water
 * @param {number} [turbidity]
 */
export function waterAbsorb(hex, metres, turbidity = 1) {
  const d = Math.max(0, metres) * Math.max(0, turbidity);
  if (!(d > 0)) return `#${parseHex(hex).map(toHexByte).join('')}`;

  /**
   * Cached and quantised, exactly as `blackbodyCss` is, and for the same
   * reason: this is called from inside per-particle and per-gradient-stop
   * loops. A shoal of forty fish, each tinted for its own depth, is forty
   * parses, a hundred and twenty exponentials and forty string builds a frame,
   * every frame — which is more than the drawing costs.
   *
   * A quarter of a metre is the step, which changes the red by about seven per
   * cent and everything else by less than one. Invisible between two fish and
   * invisible between two stops of a gradient, which are the only two places
   * anything here compares one sample against its neighbour.
   *
   * Keyed on the *product* rather than on the two arguments, so a colour asked
   * for at five metres in water twice as murky lands on the same entry as one
   * at ten metres in clear — which is the same question and, above, is
   * literally the same computation.
   */
  const key = `${hex}|${Math.round(d * 4)}`;
  const hit = absorbCache.get(key);
  if (hit) return hit;

  const quantised = Math.round(d * 4) / 4;
  const src = parseHex(hex);
  const out = [0, 1, 2].map((i) =>
    linearToSrgb(srgbToLinear(src[i]) * Math.exp(-WATER_ABSORPTION[i] * quantised))
  );
  const css = `#${toHexByte(out[0])}${toHexByte(out[1])}${toHexByte(out[2])}`;

  // Bounded because the key holds a colour, and a colour can be bound to an
  // LFO — which would otherwise add an entry a frame for the rest of the
  // evening. Clearing outright rather than evicting one: this is a cache of
  // pure functions, so the only cost of losing it is recomputing a frame's
  // worth, and a few thousand entries is far more than any show needs at once.
  if (absorbCache.size >= ABSORB_LIMIT) absorbCache.clear();
  absorbCache.set(key, css);
  return css;
}

const absorbCache = new Map();
const ABSORB_LIMIT = 4096;

/**
 * The same attenuation as a bare multiplier, for callers already working in
 * linear light or in bytes.
 *
 * Returns `[r, g, b]` factors in 0..1 — multiply your own components by them.
 * Useful inside a per-pixel loop, where round-tripping a hex string per sample
 * would dominate the cost of everything else in it.
 */
export function waterTransmission(metres, turbidity = 1) {
  const d = Math.max(0, metres) * Math.max(0, turbidity);
  return WATER_ABSORPTION.map((a) => Math.exp(-a * d));
}
