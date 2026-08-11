/**
 * The `fx` namespace available inside every effect module.
 *
 * User effects are compiled from a blob: URL, where relative import specifiers
 * can't resolve — so the registry appends an absolute import of this file and
 * binds it to `fx`. Import declarations are hoisted, which is why appending it
 * doesn't shift the line numbers in your syntax errors.
 *
 * Everything here is also reachable through the draw context, so `fx` is a
 * convenience, not a requirement.
 */

export {
  clamp,
  lerp,
  smoothstep,
  frac,
  TAU,
  hexToRgb,
  rgba,
  mixHex,
  makeRng,
  hashString,
  boundingBox,
  polygonCentroid,
  pointInPolygon,
  buildPathSampler,
  smoothPolyline,
} from '../core/math.js';

export { createNoise, defaultNoise } from '../core/noise.js';

/**
 * Physically-motivated colour, for effects that model light rather than paint.
 *
 * `blackbodyCss(kelvin)` is the one to reach for whenever something is hot —
 * flame, embers, sparks, filament bulbs, lightning. Driving colour from a
 * temperature means it reddens correctly as it cools, which a fade between two
 * chosen hexes never quite does.
 */
export { blackbody, blackbodyCss, blackbodyBytes, mixLinear, rampAt, luminance, srgbToLinear, linearToSrgb } from './color.js';

/**
 * Low-resolution density fields, for anything volumetric.
 *
 * Fire, smoke and fog are volumes. Drawing them as hundreds of additive circles
 * reads as a bag of marbles; evaluating a field on a coarse grid and letting the
 * browser interpolate it reads as a volume — and it is faster.
 */
export { createField, ensureField, curlNoise } from './field.js';

/**
 * Surface collision, for things that should land on the house rather than fall
 * straight past it.
 *
 * `ctx.shapes(tag, excludeId)` hands you the rest of the traced scene;
 * `ensureHeightfield` collapses it to the top surface it presents, and the rest
 * accumulate material on that surface, let it slump to a natural angle, and shed
 * it as falling slabs when it gets too deep. Snow uses the whole set — read
 * `js/effects/collide.js` for how the pieces fit together.
 */
export {
  buildHeightfield,
  ensureSurfaces,
  ensureDrift,
  columnAt,
  sweepLanding,
  settle,
  shedSlabs,
  advanceSlabs,
  drawDrift,
  drawSlabs,
} from './collide.js';

/** Trace a point list onto a context. Handy when you want your own path. */
export function tracePoints(g, points, closed = true) {
  if (!points.length) return;
  g.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) g.lineTo(points[i].x, points[i].y);
  if (closed) g.closePath();
}

/**
 * Radial glow, the workhorse behind candles, fairy lights and eyes.
 * Drawn with 'lighter' composite so overlapping lights add rather than occlude.
 */
export function glow(g, x, y, radius, colour, intensity = 1) {
  if (radius <= 0 || intensity <= 0) return;
  const grad = g.createRadialGradient(x, y, 0, x, y, radius);
  const { r, gr, b } = (() => {
    const h = colour.replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const n = parseInt(full.slice(0, 6), 16) || 0;
    return { r: (n >> 16) & 255, gr: (n >> 8) & 255, b: n & 255 };
  })();
  grad.addColorStop(0, `rgba(${r},${gr},${b},${Math.min(1, intensity)})`);
  grad.addColorStop(0.4, `rgba(${r},${gr},${b},${Math.min(1, intensity) * 0.35})`);
  grad.addColorStop(1, `rgba(${r},${gr},${b},0)`);
  g.fillStyle = grad;
  g.beginPath();
  g.arc(x, y, radius, 0, Math.PI * 2);
  g.fill();
}

/**
 * Vertical gradient across a bounding box, given colour stops as [offset, css].
 */
export function verticalGradient(g, bbox, stops) {
  const grad = g.createLinearGradient(0, bbox.y, 0, bbox.y + bbox.h);
  for (const [offset, colour] of stops) grad.addColorStop(offset, colour);
  return grad;
}

/** Shorthand for the common "draw inside this shape only" pattern. */
export function withClip(g, path, fn) {
  g.save();
  g.clip(path);
  fn();
  g.restore();
}
