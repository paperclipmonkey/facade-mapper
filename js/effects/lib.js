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

// Re-exported below as part of `fx`; also imported into scope for the helpers
// at the foot of this file.
import { hexToRgb } from '../core/math.js';

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
 * The other half of "colour is a physical quantity": what a medium takes out of
 * light on the way through it.
 *
 * `waterAbsorb(hex, metres)` is to depth what `blackbodyCss` is to heat. Water
 * absorbs red about thirty times faster than blue, so anything more than a
 * couple of metres down is blue whatever colour it started — and fading a
 * chosen blue towards black instead gives you a dimmer switch rather than a
 * depth cue.
 */
export { waterAbsorb, waterTransmission } from './color.js';

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

/**
 * A scratch canvas, for effects that accumulate or that pre-bake a sprite.
 *
 * Anything that only ever adds — frost spreading, ivy growing, a wet trail on
 * glass — should stroke into one of these once and blit it thereafter. The
 * alternative is redrawing the entire history every frame, which turns a
 * pleasing effect into a slideshow by about the thirty-second mark.
 *
 * A detached `<canvas>` element, deliberately, and **not** an `OffscreenCanvas`
 * despite the name being a much better fit. Effects run on the main thread and
 * blit these into a main-thread 2D context, and on that path the two are not
 * interchangeable: an OffscreenCanvas source makes `drawImage` around thirty
 * times slower, because its backing store is not the one the destination
 * context is compositing into and every blit pays to bridge them. Measured at
 * 71 ms against 2.0 ms for the same sixteen hundred stamps — the difference
 * between snow that runs and snow that does not. OffscreenCanvas earns its keep
 * inside a worker; on this path it is a trap.
 *
 * Measure it yourself with test/bench.html if you doubt it.
 */
export function offscreen(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  return canvas;
}

/**
 * Obstacle-aware movement, for effects that cross the facade rather than fill
 * a shape. See js/effects/obstacles.js.
 */
export {
  collectObstacles,
  surfaceNormal,
  deflect,
  isClear,
  findFreeSpot,
  nearestSurface,
} from './obstacles.js';

/** Trace a point list onto a context. Handy when you want your own path. */
export function tracePoints(g, points, closed = true) {
  if (!points.length) return;
  g.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) g.lineTo(points[i].x, points[i].y);
  if (closed) g.closePath();
}

/**
 * Radial glow, the workhorse behind candles, fairy lights, eyes and embers.
 * Drawn with 'lighter' composite so overlapping lights add rather than occlude.
 *
 * The stops trace an inverse-square falloff rather than a straight ramp, which
 * is what a small source scattering in air actually does: a tight bright core
 * and a long faint skirt. A linear ramp gives neither, and reads as a painted
 * disc — the halo has a visible edge where it reaches zero, and the core is too
 * broad to look like a point of light. Cheap to change, and it lifts every
 * effect that emits.
 */
const GLOW_STOPS = [
  [0, 1],
  [0.08, 0.807],
  [0.18, 0.446],
  [0.35, 0.163],
  [0.6, 0.046],
  [1, 0],
];

export function glow(g, x, y, radius, colour, intensity = 1) {
  if (radius <= 0 || intensity <= 0) return;
  const { r, g: gr, b } = hexToRgb(colour);
  const peak = Math.min(1, intensity);
  const grad = g.createRadialGradient(x, y, 0, x, y, radius);
  for (const [offset, falloff] of GLOW_STOPS) {
    grad.addColorStop(offset, `rgba(${r},${gr},${b},${peak * falloff})`);
  }
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
