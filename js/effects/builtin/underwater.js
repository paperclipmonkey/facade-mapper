/**
 * The house goes under.
 *
 * Every other themed set in this library decorates a building: lights on the
 * roofline, something in the windows, weather in front of it. This one changes
 * what the building is *in*, and that is a different job — the eye does not
 * accept "underwater" from a blue wash and some bubbles, because the thing it
 * actually reads depth from is not blue at all. It is the *loss of red*.
 *
 * Water absorbs long wavelengths about thirty times faster than short ones. Two
 * metres down a red brick is brown, at five it is grey, and at ten there is no
 * red light left to reflect at all — while the blue-green of everything else is
 * still nearly untouched. That is why an underwater photograph taken without a
 * torch looks the way it does, and it is a *spectral* effect rather than a
 * brightness one, which is exactly the difference between a wall that is under
 * water and a wall with a blue gel over it.
 *
 * So everything here is driven from `fx.waterAbsorb(colour, metres)` rather than
 * from a picked tint, and every effect in the set shares two parameters — where
 * the surface is, and how many metres of water a screen height represents — so
 * that all of them agree about depth without anybody matching numbers across
 * six inspector panels. Set the surface once and the shafts, the water body,
 * the kelp and the jellyfish are all lit consistently.
 *
 * The rest of the set is the physics that survives being stared at:
 *
 *   - **Waves obey the dispersion relation.** In deep water ω² = gk, so a long
 *     swell travels faster than a short chop. Sum three components that each
 *     satisfy it and you get a surface that never repeats and never looks like
 *     a sine wave; sum three that do not and you get corduroy.
 *   - **Wave motion dies off exponentially with depth**, at e^(−kz). This is
 *     why kelp thrashes near the surface and barely stirs at its holdfast, and
 *     it is one line of code that does more for the look than the drawing does.
 *   - **Bubbles do not go straight up.** Above about a millimetre and a half
 *     they shed vortices alternately off each side and zigzag, more slowly the
 *     bigger they are. They also *grow* as they rise, because the water above
 *     them weighs less.
 *   - **A jellyfish's tentacles are its own history.** They trail behind the
 *     bell rather than hanging from it, so a tentacle point is simply where the
 *     bell was a moment ago — which the bell's motion, being analytic, can
 *     answer exactly.
 *   - **A fish flashes when it banks**, because its flank is a mirror and it
 *     has just turned it towards the light. Not when it is fast; when it turns.
 *
 * Shoal is the one that treats the traced house as terrain — it steers round
 * the windows the way `serpent` does — and it is the effect that makes the
 * whole thing land, for the same reason as everywhere else in this library:
 * your eye will accept a cartoon fish and will not accept one that swims
 * through the bay window.
 */

import { rgba, clamp, lerp, TAU, mixHex, makeRng, smoothstep, pointInPolygon, hashString } from '../../core/math.js';
import { waterAbsorb } from '../color.js';
import { collectObstacles, deflect, surfaceNormal, nearestSurface, isClear, findFreeSpot } from '../obstacles.js';
import { glow, curveThrough, offscreen } from '../lib.js';

/* ------------------------------------------------------------------ *
 * Depth
 *
 * One convention, shared by all six effects, so that a show does not end up
 * with a waterline at one height and shafts of light arriving at another.
 * ------------------------------------------------------------------ */

/**
 * Where the surface is, and how much water a screen height is worth.
 *
 * Spelled out as two parameters rather than one because they answer different
 * questions and want different answers. `surface` is composition — put the
 * waterline across the middle of the house, or above the top of the frame so
 * the whole building is under. `metres` is *scale*, and it is the one that
 * decides how blue the bottom of the wall goes: the same picture at 6 m and at
 * 40 m is a swimming pool and a shipwreck.
 *
 * `surface` is allowed to be negative, which reads as "the surface is off the
 * top of the picture" — the usual case for a house that is properly sunk.
 */
const SURFACE_PARAMS = [
  { key: 'surface', type: 'range', label: 'Surface at', default: -0.2, min: -1, max: 1, step: 0.01 },
  { key: 'metres', type: 'range', label: 'Metres top to bottom', default: 14, min: 1, max: 60, step: 0.5 },
  { key: 'turbidity', type: 'range', label: 'Murkiness', default: 1.3, min: 0.2, max: 6, step: 0.05 },
];

/**
 * What `Surface at` is a fraction *of*.
 *
 * Most of this set reads depth off the whole frame, which is what makes the
 * effects agree about one body of water — and for the ones that read depth as
 * a gradient it is invisible, because being a little off changes nothing you
 * can see.
 *
 * The effects that draw *at* the surface are the exception: a waterline is a
 * line and a leaping dolphin is a splash, and both have to land somewhere
 * specific. Measured against the frame and pointed at a wall traced across the
 * middle of the picture, the default puts the surface above that wall,
 * everything below it gets clipped away, and the effect appears not to work at
 * all — which is exactly what it looked like. The value that would have worked
 * was findable by dragging, and nothing said so.
 *
 * `auto` is the answer for both cases without anybody having to know: a layer
 * covering the whole frame measures from the frame, and one pointed at a shape
 * measures inside that shape, so half way down means half way down *the thing
 * you aimed it at*. `frame` and `shape` force it, and `frame` is the one to
 * pick when the surface has to agree with the shafts and the kelp to the metre.
 */
const ANCHOR_PARAM = {
  key: 'anchor',
  type: 'select',
  label: 'Surface measured from',
  default: 'auto',
  options: ['auto', 'frame', 'shape'],
};

/**
 * The surface height as a fraction of the *frame*, whatever `p.anchor` says it
 * was a fraction of to begin with — so `depthAt` keeps working in world metres
 * and the colour stays physical either way.
 *
 * The frame shape is the stand-in the renderer substitutes for a layer with no
 * targets, and its id is the one reliable way to tell "this covers everything"
 * from "this was aimed at something".
 */
export function surfaceFraction(p, shape, world) {
  const anchored = p.anchor === 'shape'
    || (p.anchor !== 'frame' && shape.id !== '__frame__');
  if (!anchored) return p.surface ?? 0;
  return (shape.bbox.y + (p.surface ?? 0) * shape.bbox.h) / Math.max(1, world.h);
}

/** Metres of water above a world-pixel `y`. Never negative — air is not water. */
function depthAt(p, y, world) {
  return Math.max(0, (y / Math.max(1, world.h) - (p.surface ?? 0)) * (p.metres ?? 14));
}

/**
 * The world-pixel `y` the surface sits at. Off the top of the frame is normal.
 */
function surfaceY(p, world) {
  return (p.surface ?? 0) * world.h;
}

/**
 * Gravity, in metres per second squared, for the wave dispersion relation.
 *
 * Present as a named constant rather than 9.81 buried in an expression because
 * it is the thing that makes the waves below behave like water rather than like
 * a sine wave somebody picked the speed of.
 */
const G = 9.81;

/**
 * A deep-water wave train: three components, each obeying ω = √(gk).
 *
 * The dispersion relation is what stops this looking like corduroy. Real water
 * is dispersive — a long swell outruns a short chop — so components sharing a
 * surface slide past each other continuously and the pattern never repeats. Fix
 * their speeds to be equal instead (which is what you get by picking three
 * frequencies by eye) and they lock into a repeating comb within a second.
 *
 * Returns the surface displacement in metres at a horizontal position given in
 * metres, and the local slope, which is what a glint needs.
 */
export function waveTrain(xm, t, amplitude, wavelength) {
  waveAt(xm, t, amplitude, wavelength);
  return { height: WAVE.height, slope: WAVE.slope };
}

/**
 * Harmonics of the primary, at the amplitude ratios a real wind sea carries:
 * most of the energy in the swell, a third in the chop, a little in the ripple.
 * As [amplitude, harmonic] pairs.
 */
const WAVE_PARTS = [
  [1, 1],
  [0.47, 2.7],
  [0.21, 6.3],
];

/** Where `waveAt` leaves its answer, so a loop over a few thousand samples allocates nothing. */
const WAVE = { height: 0, slope: 0, curvature: 0, outline: 0 };

/**
 * How much of each component survives into the *outline* of the surface seen
 * edge-on, as opposed to its height at one point.
 *
 * A swell is long-crested — its crests run for tens of metres side by side —
 * so seen along its length it lines up and the edge of the water rolls with
 * it. Chop is shorter-crested and a ripple barely has a crest at all: seen
 * edge-on across a metre of water, the ripples in front and behind are at
 * every phase at once and average out. So the rim you can see is mostly swell,
 * while the facets that make the glints are mostly ripple — and drawing the
 * rim from the full height instead is what made it a nervous scribble.
 */
const OUTLINE_WEIGHTS = [1, 0.55, 0.12];

/**
 * `waveTrain`, written into `WAVE` instead of returned — the waterline asks it
 * a couple of thousand times a frame — and with the curvature as well, which
 * is what decides whether a stretch of surface focuses light or spreads it,
 * and the edge-on outline described above.
 */
function waveAt(xm, t, amplitude, wavelength) {
  let height = 0;
  let slope = 0;
  let curvature = 0;
  let outline = 0;
  for (let i = 0; i < WAVE_PARTS.length; i++) {
    const amp = WAVE_PARTS[i][0];
    const k = (TAU * WAVE_PARTS[i][1]) / Math.max(0.2, wavelength);
    const omega = Math.sqrt(G * k);
    // Offset in phase per component so the crests do not all start stacked.
    const phase = k * xm - omega * t + i * 1.7;
    const s = Math.sin(phase);
    height += amplitude * amp * s;
    slope += amplitude * amp * k * Math.cos(phase);
    curvature -= amplitude * amp * k * k * s;
    outline += amplitude * amp * OUTLINE_WEIGHTS[i] * s;
  }
  WAVE.height = height;
  WAVE.slope = slope;
  WAVE.curvature = curvature;
  WAVE.outline = outline;
}

/**
 * How much wave motion survives at depth `z` metres, for wavelength `lambda`.
 *
 * e^(−kz) — the orbital motion of a deep-water wave decays by a factor of e
 * every wavelength over 2π of depth, which means it is essentially gone half a
 * wavelength down. This single term is why kelp near the surface thrashes and
 * kelp at its holdfast barely stirs, and why a diver twenty metres down feels
 * nothing from a swell that is breaking boats on the beach.
 */
export function orbitalDecay(z, lambda) {
  const k = TAU / Math.max(0.2, lambda);
  return Math.exp(-k * Math.max(0, z));
}

/* ------------------------------------------------------------------ *
 * Shafts from the surface
 * ------------------------------------------------------------------ */

/**
 * Where along a shaft its colour is sampled, from the surface down.
 *
 * Absorption is exponential, and a two-stop gradient across ten metres of it
 * is visibly a straight line where the curve should be steepest. So eight
 * stops, bunched near the top where two things change fast — the shaft
 * fading *in* out of the bright band under the surface over its first few
 * per cent, and the knee of the absorption just below — and spread out over
 * the long tail. Eight `waterAbsorb` calls per shaft per frame, cached and
 * quantised: about a hundred for a full fan, which is nothing.
 */
const SHAFT_STOPS = [0, 0.035, 0.1, 0.2, 0.34, 0.52, 0.74, 1];

/**
 * How a shaft is drawn, and why it is not drawn at full size.
 *
 * Canvas has no gradient across the width of a shape, and a beam with a hard
 * edge is a plank. The old answer was a dozen nested quads, each carrying an
 * increment of a Gaussian — but the outermost still stood at a tenth of the
 * peak, so every shaft had a visible edge at its full width and read as a
 * slab of cellophane, and the stack painted the middle of every beam twelve
 * times, which made the shafts the dearest thing in the set.
 *
 * A shaft of light in water has no detail finer than a few centimetres. So
 * the fan is drawn into a buffer at a quarter of the resolution: each shaft a
 * soft-sided body, a narrower, brighter core that drifts from side to side as
 * the lens above it changes, and a few thin streaks — three fills, each with
 * the shaft's own gradient down its length. Then the whole buffer is blurred
 * once and blown back up over the shape. The blur is what feathers every
 * edge into nothing, and it costs one filter for the entire fan rather than
 * one per shaft; under it the three add up to a beam that is brightest along
 * a line that wanders and is grained along its length, which is how a shaft
 * of sunlight in water actually looks — light gathered by a moving lens and
 * caught by whatever is suspended in it, not shone through a slot.
 *
 * Painting at a sixteenth of the pixels also pays for itself: the fan costs
 * about what the old stack did on a software canvas, and far less wherever
 * the canvas is on the GPU and the old stack's twelvefold overdraw was the
 * whole bill.
 *
 * Where a browser has no canvas filter the blow-up alone softens the edges a
 * little, and the shafts are harder but still correct.
 */
const SHAFT_RESOLUTION = 0.25;
const SHAFT_BUFFER_MAX = 720;
let shaftBuffer = null;
let shaftSoft = null;

/** A buffer of at least `w × h`, grown rather than replaced, cleared over that much of it. */
function shaftScratch(canvas, w, h) {
  const out = canvas || offscreen(w, h);
  if (out.width < w || out.height < h) {
    out.width = Math.max(out.width, w);
    out.height = Math.max(out.height, h);
  }
  const b = out.getContext('2d');
  b.setTransform(1, 0, 0, 1, 0, 0);
  b.filter = 'none';
  b.globalAlpha = 1;
  b.globalCompositeOperation = 'copy';
  b.fillStyle = 'rgba(0,0,0,0)';
  b.fillRect(0, 0, w, h);
  return out;
}

/** One side-to-side slice of a shaft, `lo..hi` in half-widths of its axis, added to the path as a closed quad. */
function shaftSlice(b, originX, top, endX, endY, w0, w1, lo, hi) {
  // Offsets taken along the surface rather than square to the shaft, so a
  // slanting shaft does not poke a corner up out of the water.
  b.moveTo(originX + lo * w0 * 0.5, top);
  b.lineTo(originX + hi * w0 * 0.5, top);
  b.lineTo(endX + hi * w1 * 0.5, endY);
  b.lineTo(endX + lo * w1 * 0.5, endY);
  b.closePath();
}

const godrays = {
  id: 'godrays',
  name: 'Shafts from the Surface',
  category: 'underwater',
  scope: 'shape',
  description:
    'Sunlight coming down through the surface in soft shafts, brightest just under it, swaying and shimmering with the swell and reddening out of existence as it goes deeper. The colour is absorption rather than a tint, so the depth reads even in a still.',
  params: [
    { key: 'color', type: 'color', label: 'Light at the surface', default: '#eaf7ff' },
    ...SURFACE_PARAMS,
    { key: 'shafts', type: 'range', label: 'Shafts', default: 11, min: 1, max: 40, step: 1 },
    { key: 'tilt', type: 'range', label: 'Sun off vertical', default: -9, min: -60, max: 60, step: 1 },
    { key: 'spread', type: 'range', label: 'Fan', default: 30, min: 0, max: 90, step: 1 },
    { key: 'width', type: 'range', label: 'Shaft width', default: 0.045, min: 0.004, max: 0.3, step: 0.001 },
    { key: 'sway', type: 'range', label: 'Sway', default: 0.6, min: 0, max: 3, step: 0.01 },
    { key: 'swell', type: 'range', label: 'Swell period (s)', default: 6.5, min: 1, max: 30, step: 0.1 },
    { key: 'shimmer', type: 'range', label: 'Shimmer', default: 0.7, min: 0, max: 1, step: 0.01 },
    { key: 'haze', type: 'range', label: 'Water in the beam', default: 0.35, min: 0, max: 1, step: 0.01 },
    { key: 'intensity', type: 'range', label: 'Brightness', default: 1, min: 0, max: 3, step: 0.05 },
  ],
  draw({ g, p, shape, t, world, noise }) {
    const { bbox } = shape;
    if (bbox.w <= 2 || bbox.h <= 2 || p.intensity <= 0) return;

    const top = Math.max(bbox.y, surfaceY(p, world));
    const bottom = bbox.y + bbox.h;
    // The surface is below the shape: there is no water here to put light in.
    if (bottom - top <= 1) return;

    // Only the part of the shape a projector can show is worth drawing into.
    const left = Math.max(bbox.x, -world.w * 0.1);
    const right = Math.min(bbox.x + bbox.w, world.w * 1.1);
    const high = Math.max(top, -world.h * 0.1);
    const low = Math.min(bottom, world.h * 1.1);
    if (right - left < 2 || low - high < 2) return;

    const count = Math.max(1, Math.round(p.shafts));
    const tiltRad = (p.tilt * Math.PI) / 180;
    const spreadRad = (p.spread * Math.PI) / 180;
    const swell = TAU / Math.max(0.1, p.swell);

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';

    /**
     * The water in front of the beams, before the beams.
     *
     * A shaft is light scattering out of a volume towards you, and a volume
     * with nothing in it scatters nothing — so the shafts on their own read as
     * cellophane strips hung in front of the wall. A faint absorbed wash behind
     * them is what puts them *in* something, and it costs one gradient.
     */
    if (p.haze > 0) {
      const wash = g.createLinearGradient(0, top, 0, bottom);
      for (let i = 0; i < 6; i++) {
        const u = i / 5;
        const y = lerp(top, bottom, u);
        const colour = waterAbsorb(p.color, depthAt(p, y, world), p.turbidity);
        wash.addColorStop(u, rgba(colour, p.haze * 0.16 * p.intensity * (1 - u * 0.45)));
      }
      g.fillStyle = wash;
      g.fillRect(bbox.x, top, bbox.w, bottom - top);
    }

    // The quarter-size buffer, in world coordinates with a little margin all
    // round so the blur has room to fall off before the edge.
    const res = Math.min(SHAFT_RESOLUTION, SHAFT_BUFFER_MAX / (right - left), SHAFT_BUFFER_MAX / (low - high));
    const pad = 12;
    const bw = Math.ceil((right - left) * res) + pad * 2;
    const bh = Math.ceil((low - high) * res) + pad * 2;
    shaftBuffer = shaftScratch(shaftBuffer, bw, bh);
    const b = shaftBuffer.getContext('2d');
    b.globalCompositeOperation = 'lighter';
    b.setTransform(res, 0, 0, res, pad - left * res, pad - high * res);

    let totalWidth = 0;
    for (let i = 0; i < count; i++) {
      const rng = makeRng(`godrays:${shape.id}:${i}`);
      const jitter = rng();
      // Spread the origins across a band wider than the shape, so the ones that
      // enter at a steep angle still cross it rather than clipping the corner.
      const originX = bbox.x + bbox.w * (-0.35 + 1.7 * ((i + 0.5) / count + (jitter - 0.5) * 0.5));
      const fan = count > 1 ? ((i + 0.5) / count - 0.5) * 2 : 0;

      /**
       * The swell moves the shafts, and it moves each of them differently.
       *
       * A surface wave is a lens: where it is convex the light entering under
       * it converges, where it is concave it spreads. So a shaft does not
       * merely wave from side to side, it also narrows and brightens on the
       * same period — and it is that second part the eye reads as *water*
       * rather than as searchlights. Same phase, different consequence.
       */
      const phase = t * swell + jitter * TAU;
      const angle = tiltRad + fan * spreadRad + Math.sin(phase) * p.sway * 0.16;
      const focus = 0.5 + 0.5 * Math.cos(phase * 1.37 + jitter * 3.1);

      const slant = Math.max(0.15, Math.cos(clamp(angle, -1.4, 1.4)));
      const length = (bottom - top) / slant;
      const endX = originX + Math.sin(angle) * length;
      const endY = top + Math.cos(angle) * length;

      const w0 = bbox.w * p.width * (0.55 + 0.9 * (1 - focus)) * (0.7 + jitter * 0.6);
      // Beams widen going down: the surface is a rough lens, not a slit.
      const w1 = w0 * 2.6;

      // The shimmer is the surface breaking up, and it is independent per shaft
      // — a fan that brightens as one reads as a lamp behind a fan blade.
      const shimmer = 1 - p.shimmer * 0.5 * (0.5 + 0.5 * noise.noise2(i * 3.7, t * 0.9));
      // A focused shaft is narrower and brighter at once: the lens again.
      const peak = 0.9 * p.intensity * shimmer * (0.6 + 0.4 * focus);

      /**
       * The shaft's own gradient, down its length.
       *
       * Its colour is the light after the water it has actually crossed, and
       * a slanting shaft has crossed more of it than its depth: to get `z`
       * metres down at an angle θ off vertical, sunlight travels `z / cos θ`.
       * So the shafts at the edge of the fan redden out sooner than the ones
       * coming straight down — which is the only reason a fan of them is not
       * one colour, and is visible as the outer ones going bluer first.
       *
       * Made on `g` and filled on the buffer: a gradient belongs to no
       * context in particular, and it is in world coordinates either way.
       */
      const grad = g.createLinearGradient(originX, top, endX, endY);
      for (const u of SHAFT_STOPS) {
        const y = lerp(top, endY, u);
        const colour = waterAbsorb(p.color, depthAt(p, y, world) / slant, p.turbidity);
        /**
         * Out of the surface band, brightest a little way down, then fading
         * along its own length as well as reddening: a shaft ends because the
         * light in it has been scattered away, not at a hard edge — and it
         * does not begin at one either. The first few per cent rise out of
         * the bright mirror under the waterline instead of starting at a ruled
         * line across the top of the picture.
         */
        const rise = smoothstep(0, 0.09, u);
        grad.addColorStop(u, rgba(colour, (0.3 + 0.7 * rise) * (1 - u) ** 1.2));
      }
      b.fillStyle = grad;

      // The body, soft-sided under the blur...
      b.globalAlpha = Math.min(1, peak * 0.42);
      b.beginPath();
      shaftSlice(b, originX, top, endX, endY, w0, w1, -1, 1);
      b.fill();
      // ...the core: narrower, brighter, wandering across the beam...
      const wander = 0.4 * p.shimmer * noise.noise2(i * 2.3 + 7.1, t * 0.35);
      b.globalAlpha = Math.min(1, peak * 0.4);
      b.beginPath();
      shaftSlice(b, originX, top, endX, endY, w0, w1, wander - 0.36, wander + 0.36);
      b.fill();
      /**
       * ...and the streaks: a few thin rays inside the beam, each its own
       * width, drifting slowly across it. The light in a shaft does not come
       * through as a smooth wash; it is gathered by facets of the surface,
       * and each facet sends its own ray. One path, so one fill for all of
       * them.
       */
      b.globalAlpha = Math.min(1, peak * 0.5);
      b.beginPath();
      for (let k = 0; k < 4; k++) {
        const at = 0.8 * noise.noise2(i * 4.1 + k * 9.7, t * 0.12 * (1 + k * 0.3));
        const thin = 0.05 + 0.07 * rng();
        shaftSlice(b, originX, top, endX, endY, w0, w1, at - thin, at + thin);
      }
      b.fill();
      totalWidth += w0;
    }

    /**
     * The one blur, sized to the shafts: about a tenth of a typical shaft's
     * width at the surface. Enough that no edge survives it, and not so much
     * that a shaft turns into a column of fog — it keeps its body, its core
     * and its streaks, only feathered.
     */
    shaftSoft = shaftScratch(shaftSoft, bw, bh);
    const s = shaftSoft.getContext('2d');
    const sigma = clamp((totalWidth / count) * res * 0.1, 1, 6);
    s.filter = `blur(${sigma.toFixed(1)}px)`;
    s.drawImage(shaftBuffer, 0, 0, bw, bh, 0, 0, bw, bh);
    s.filter = 'none';
    s.globalCompositeOperation = 'source-over';

    g.drawImage(shaftSoft, 0, 0, bw, bh, left - pad / res, high - pad / res, bw / res, bh / res);
    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * The waterline
 * ------------------------------------------------------------------ */

/**
 * The most samples the surface is ever traced with, and the scratch they live in.
 *
 * Module-level and reused: the surface is traced once for the rim and again
 * for every row of the mirror band under it, which is a couple of thousand
 * samples a frame, and a fresh set of arrays for each would be garbage on
 * every one of them.
 */
const SURFACE_MAX = 480;
const surfX = new Float64Array(SURFACE_MAX + 1);
const surfY = new Float64Array(SURFACE_MAX + 1);
const surfSlope = new Float64Array(SURFACE_MAX + 1);
const surfBend = new Float64Array(SURFACE_MAX + 1);
const rowY = new Float64Array(SURFACE_MAX + 1);
const rowLight = new Float64Array(SURFACE_MAX + 1);

/**
 * The rows of the mirror band, nearest first.
 *
 * Seen from below, the underside of the surface is not a line but a sheet
 * running away from you, and perspective packs it into a band under the rim:
 * the nearest metre of it gets most of the height and the far side of the
 * water is a hairline at the bottom. So the rows are spaced geometrically —
 * each gap about two thirds of the one above — and each is a fresh look at
 * the same wave train a little further back, which is why their highlights do
 * not stack up vertically into stripes.
 *
 * `[offset, distance, perspective]` — how far down the band the row sits (0..1),
 * how many metres behind the rim it is, and how much of the wave's height
 * survives being seen that far off.
 */
const MIRROR_ROWS = (() => {
  const rows = [];
  const count = 5;
  const ratio = 0.64;
  const total = 1 - ratio ** count;
  for (let k = 1; k <= count; k++) {
    const offset = (1 - ratio ** k) / total;
    rows.push([offset, 0.55 * 1.85 ** (k - 1), 1 - offset * 0.78]);
  }
  return rows;
})();

/**
 * How squarely a facet of slope `s` throws light at the viewer, 0..1.
 *
 * A glint is a mirror pointing the right way: the surface has to be tilted at
 * the one angle that sends the light into your eye, and a little either side
 * of it is nothing. `aim` is that angle's slope. Narrow on purpose, because
 * the narrowness is what makes the highlights sparkle — a broad lobe lights
 * whole flanks at once and the surface reads as a glowing ribbon.
 *
 * Flat water has no facet at that angle anywhere, so it has no glints at all,
 * which is correct and is also the thing the old window got wrong: it lit a
 * level surface along its entire length.
 */
function facing(s, aim) {
  const off = Math.abs(s - aim) * 6.5;
  return off >= 1 ? 0 : 1 - off;
}

/**
 * A soft fleck of light at the peak of every run of `light` along a row of the
 * surface, as long as the run it stands for.
 *
 * One per run, not one per sample: a facet ten samples wide is one highlight,
 * and ten overlapping ones are a bar. Flecks rather than strokes, because a
 * stroke that switches on and off along its length has ends, and a band of
 * ends reads as rows of dashes — rain, or morse — rather than as light on
 * water. Alpha is `(light − offset) × gain` at the peak.
 */
function stampFlecks(g, sprite, ys, light, count, spacing, tall, peak, run, minWide, stretch, offset, gain) {
  for (let i = 1; i < count - 1; i++) {
    const here = light[i];
    if (here < peak || here < light[i - 1] || here <= light[i + 1]) continue;
    let back = 1;
    while (back < 16 && i - back > 0 && light[i - back] > run) back++;
    let ahead = 1;
    while (ahead < 16 && i + ahead < count - 1 && light[i + ahead] > run) ahead++;
    const wide = Math.max(minWide, (back + ahead) * spacing * stretch);
    g.globalAlpha = clamp((here - offset) * gain, 0, 1);
    g.drawImage(sprite, surfX[i] - wide / 2, ys[i] - tall / 2, wide, tall);
  }
  g.globalAlpha = 1;
}

/**
 * A glint, baked once per colour.
 *
 * A hot white point with a soft skirt and a long thin streak either side of it
 * — the streak is what sunlight broken up on moving water actually looks like,
 * stretched along the surface because the facets are long in that direction
 * and short across it. Stamped with `drawImage`, because there are dozens of
 * them a frame and each would otherwise be a radial gradient built and thrown
 * away.
 */
const GLINT_SIZE = 96;
const glintSprites = new Map();

function glintSprite(colour) {
  let sprite = glintSprites.get(colour);
  if (sprite) return sprite;
  if (glintSprites.size > 64) glintSprites.clear();
  sprite = offscreen(GLINT_SIZE, GLINT_SIZE);
  const g = sprite.getContext('2d');
  const m = GLINT_SIZE / 2;
  g.globalCompositeOperation = 'lighter';

  const halo = g.createRadialGradient(m, m, 0, m, m, m * 0.5);
  halo.addColorStop(0, rgba('#ffffff', 1));
  halo.addColorStop(0.12, rgba('#ffffff', 0.7));
  halo.addColorStop(0.32, rgba(colour, 0.24));
  halo.addColorStop(0.62, rgba(colour, 0.06));
  halo.addColorStop(1, rgba(colour, 0));
  g.fillStyle = halo;
  g.fillRect(0, 0, GLINT_SIZE, GLINT_SIZE);

  // The streak, tapering out to both ends: a horizontal gradient through a
  // thin bar, and a fainter, shorter one across it so the core reads as a
  // point of light rather than a dash.
  const streak = g.createLinearGradient(0, 0, GLINT_SIZE, 0);
  streak.addColorStop(0, rgba(colour, 0));
  streak.addColorStop(0.3, rgba(colour, 0.18));
  streak.addColorStop(0.5, rgba('#ffffff', 0.9));
  streak.addColorStop(0.7, rgba(colour, 0.18));
  streak.addColorStop(1, rgba(colour, 0));
  g.fillStyle = streak;
  g.fillRect(0, m - 1.5, GLINT_SIZE, 3);
  const spike = g.createLinearGradient(0, m * 0.75, 0, m * 1.25);
  spike.addColorStop(0, rgba(colour, 0));
  spike.addColorStop(0.5, rgba('#ffffff', 0.35));
  spike.addColorStop(1, rgba(colour, 0));
  g.fillStyle = spike;
  g.fillRect(m - 1, m * 0.75, 2, m * 0.5);

  glintSprites.set(colour, sprite);
  return sprite;
}

/**
 * A soft round patch of light, baked once per colour and stamped stretched.
 *
 * Drawn much wider than it is tall it is a fleck of light on the underside of
 * the surface: a facet a metre long and a hand's width deep, foreshortened.
 * A Gaussian rather than a disc, so a run of them merges into a shimmer
 * instead of into a string of beads.
 */
const PATCH_SIZE = 48;
const patchSprites = new Map();

function patchSprite(colour) {
  let sprite = patchSprites.get(colour);
  if (sprite) return sprite;
  if (patchSprites.size > 64) patchSprites.clear();
  sprite = offscreen(PATCH_SIZE, PATCH_SIZE);
  const g = sprite.getContext('2d');
  const m = PATCH_SIZE / 2;
  const soft = g.createRadialGradient(m, m, 0, m, m, m);
  for (let i = 0; i <= 6; i++) {
    const u = i / 6;
    soft.addColorStop(u, rgba(i === 0 ? mixHex(colour, '#ffffff', 0.5) : colour, Math.exp(-u * u * 4.5) * (1 - u)));
  }
  g.fillStyle = soft;
  g.fillRect(0, 0, PATCH_SIZE, PATCH_SIZE);
  patchSprites.set(colour, sprite);
  return sprite;
}

const waterline = {
  id: 'waterline',
  name: 'Waterline',
  category: 'underwater',
  scope: 'shape',
  description:
    'The surface of the water crossing the house, seen from underneath: a bright rim rolling on the swell, the mirror under it, glints running along the crests and the light it throws up the wall above. Three wave components on the real dispersion relation, so it never repeats.',
  params: [
    { key: 'color', type: 'color', label: 'Light on the water', default: '#dff2ff' },
    /**
     * The one effect in the set that starts with its surface *in shot*.
     *
     * The shared default is −0.2 — off the top of the picture — because that
     * is what a properly sunk house wants, and for the other five it is
     * invisible in the right way: they read depth as a gradient and simply
     * come out deeper. This one draws the surface itself, so the same default
     * makes it draw nothing, which is not a subtle look, it is a broken one.
     */
    ...SURFACE_PARAMS.map((param) =>
      (param.key === 'surface' ? { ...param, default: 0.08 } : param)),
    ANCHOR_PARAM,
    { key: 'body', type: 'range', label: 'Water', default: 0.55, min: 0, max: 1.5, step: 0.01 },
    { key: 'wave', type: 'range', label: 'Wave height (cm)', default: 22, min: 0, max: 200, step: 1 },
    { key: 'wavelength', type: 'range', label: 'Wavelength (m)', default: 5, min: 0.5, max: 40, step: 0.1 },
    { key: 'tide', type: 'range', label: 'Tide', default: 0.02, min: 0, max: 0.3, step: 0.005 },
    { key: 'tidePeriod', type: 'range', label: 'Tide period (s)', default: 42, min: 4, max: 300, step: 1 },
    { key: 'glint', type: 'range', label: 'Glints', default: 0.8, min: 0, max: 2, step: 0.01 },
    { key: 'spill', type: 'range', label: 'Light above the line', default: 0.7, min: 0, max: 2, step: 0.01 },
    { key: 'level', type: 'range', label: 'Brightness', default: 1, min: 0, max: 3, step: 0.05 },
  ],
  draw({ g, p, stable, shape, t, world }) {
    const { bbox } = shape;
    if (bbox.w <= 2 || bbox.h <= 2 || p.level <= 0) return;

    const metresPerPixel = (p.metres || 14) / Math.max(1, world.h);
    const pixelsPerMetre = 1 / Math.max(1e-6, metresPerPixel);
    const level = p.level;

    /**
     * The tide, which is the difference between a picture of water and water.
     *
     * A fixed line across a wall reads as a painted stripe within about ten
     * seconds. A line that is a metre higher two minutes later reads as the
     * house going under, and the effect never has to do anything else.
     */
    const tide = Math.sin((t * TAU) / Math.max(1, p.tidePeriod)) * p.tide * world.h;

    // Where the surface actually is — see `surfaceFraction` — and `p` rewritten
    // so `depthAt` below keeps reading it as a fraction of the frame.
    const fraction = surfaceFraction(p, shape, world);
    const water = fraction === p.surface ? p : { ...p, surface: fraction };

    const baseY = fraction * world.h + tide;
    const metresHigh = p.wave / 100;
    const amplitude = metresHigh * pixelsPerMetre;

    const left = bbox.x;
    const right = bbox.x + bbox.w;
    const bottom = bbox.y + bbox.h;

    /**
     * Sampled finely enough that the shortest ripple is a curve.
     *
     * The old trace took ninety-six samples whatever the wave was, which at
     * the defaults put three and a half of them on each ripple — a ripple
     * drawn as a triangle, and a surface drawn as a row of triangles is a
     * mountain range, or lightning. Eight to a ripple, traced through with
     * `curveThrough`, and the same numbers come out as a swell.
     */
    const ripplePx = (Math.max(0.2, p.wavelength) / WAVE_PARTS[WAVE_PARTS.length - 1][1]) * pixelsPerMetre;
    const spacing = clamp(ripplePx / 8, 4, 14);
    const count = Math.min(SURFACE_MAX, Math.max(24, Math.ceil(bbox.w / spacing))) + 1;
    for (let i = 0; i < count; i++) {
      const x = lerp(left, right, i / (count - 1));
      waveAt(x * metresPerPixel, t, metresHigh, p.wavelength);
      surfX[i] = x;
      // The edge-on outline for where the rim goes, and the full slope and
      // curvature for what it does with the light — see `OUTLINE_WEIGHTS`.
      surfY[i] = baseY + WAVE.outline * pixelsPerMetre;
      surfSlope[i] = WAVE.slope;
      surfBend[i] = WAVE.curvature;
    }

    /**
     * How tall the mirror band under the rim is, in world pixels.
     *
     * The underside of the surface is a sheet seen nearly edge-on, so its
     * height on the wall is a matter of how far below it you are standing —
     * a few per cent of the picture — plus the swell itself, because a rough
     * surface is a thicker sheet than a calm one.
     */
    const band = world.h * 0.035 + amplitude * 1.4;
    const surfaceColour = waterAbsorb(p.color, 0, p.turbidity);

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';
    g.lineJoin = 'round';

    /**
     * The body of the water, absorbed with depth, and dark just under the rim.
     *
     * Brightest a band's depth below the surface and falling away beneath:
     * two separate things are happening and they pull the same way — the
     * light has further to travel, and what is left of it has been scattered
     * out of the line of sight. Both are exponential, and the `waterAbsorb`
     * only accounts for the first, hence the falloff term. Without it the deep
     * water is a saturated blue slab, which is what a gel looks like and not
     * what water looks like.
     *
     * The dip right under the rim is total internal reflection. Seen from
     * below at a grazing angle the underside of the surface is a perfect
     * mirror, and what it mirrors is the water beneath — so the strip just
     * under the line is not lit by the sky at all but holds a reflection of
     * the deep. It is darker than the water a metre further down, and that
     * darkness is what makes the rim above it read as a surface rather than as
     * a line drawn across the wall.
     */
    if (p.body > 0 && bottom > baseY - amplitude) {
      const gradTop = Math.max(bbox.y, baseY - amplitude * 2);
      const span = Math.max(1, bottom - gradTop);
      const grad = g.createLinearGradient(0, gradTop, 0, bottom);
      // Four stops through the band, where the shape of the curve is, and the
      // rest spread over the long exponential tail below it.
      const stops = [
        [baseY - amplitude * 2, 0.62],
        [baseY + band * 0.35, 0.5],
        [baseY + band * 0.85, 0.9],
        [baseY + band * 1.6, 1],
      ];
      let last = -1;
      for (let i = 0; i < 8; i++) {
        let y;
        let lift;
        if (i < stops.length) {
          [y, lift] = stops[i];
        } else {
          y = lerp(baseY + band * 1.6, bottom, (i - stops.length + 1) / (8 - stops.length));
          lift = 1;
        }
        // Monotonic and inside the gradient, whatever the shape cuts off.
        const offset = Math.max(last + 1e-4, clamp((y - gradTop) / span, 0, 1));
        if (offset > 1) break;
        last = offset;
        const below = Math.max(0, gradTop + offset * span - baseY);
        const falloff = Math.exp(-(below / span) * 1.6);
        const colour = waterAbsorb(p.color, depthAt(water, gradTop + offset * span, world), p.turbidity);
        grad.addColorStop(offset, rgba(colour, p.body * 0.5 * level * falloff * lift));
      }
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(left, bottom);
      curveThrough(g, surfX, surfY, count);
      g.lineTo(right, bottom);
      g.closePath();
      g.fill();
    }

    /**
     * The mirror band: the underside of the surface running away from you.
     *
     * First the sheen — the mirror itself, which is lit by the bright water
     * just under the rim and fades out as the sheet it belongs to recedes.
     * Flat water is still a mirror, just one with nothing sparkling in it.
     *
     * Then the rows. Each is the same wave train looked at a little further
     * back, so its swell is flatter (perspective) and its phase has moved on
     * (it is a different stretch of water), and each puts light only where a
     * facet in it is tilted to send the light down to you: a soft fleck,
     * stretched along the surface, at the peak of each run of facing water.
     * Packed tighter and dimmer towards the bottom of the band, that is the
     * shimmer on the ceiling of a swimming pool seen from the deep end.
     *
     * Flecks rather than the broken strokes this started as: a stroke that
     * switches on and off along its length has ends, and a band of ends reads
     * as rows of dashes — rain, or morse — rather than as light on water.
     */
    {
      const sheen = g.createLinearGradient(0, baseY - amplitude, 0, baseY + band);
      sheen.addColorStop(0, rgba(surfaceColour, clamp(0.16 * level, 0, 1)));
      sheen.addColorStop(0.5, rgba(surfaceColour, clamp(0.07 * level, 0, 1)));
      sheen.addColorStop(1, rgba(surfaceColour, 0));
      g.fillStyle = sheen;
      g.beginPath();
      curveThrough(g, surfX, surfY, count, { move: true });
      g.lineTo(right, baseY + band);
      g.lineTo(left, baseY + band);
      g.closePath();
      g.fill();
    }
    for (let r = 0; r < MIRROR_ROWS.length; r++) {
      const [offset, distance, perspective] = MIRROR_ROWS[r];
      const drop = band * offset;
      // Further back, the light has crossed more water to get here.
      const rowColour = waterAbsorb(p.color, distance * 0.6, p.turbidity);
      const aim = 0.15 + r * 0.03;
      for (let i = 0; i < count; i++) {
        waveAt(surfX[i] * metresPerPixel + distance * 0.8, t, metresHigh, p.wavelength);
        rowY[i] = baseY + drop + WAVE.outline * pixelsPerMetre * perspective;
        // Wider than the rim's window: these are reflections of reflections,
        // softened by the water they have crossed.
        rowLight[i] = facing(WAVE.slope * 0.75, aim * 0.75);
      }
      const fade = 1 - offset * 0.6;
      const tall = Math.max(2, world.h * 0.011 * perspective);

      // The wrinkle itself — soft, wide and faint, so it reads as a fold in a
      // sheet of light rather than as a line ruled across it.
      g.strokeStyle = rgba(rowColour, clamp(0.09 * fade * level, 0, 1));
      g.lineWidth = tall * 0.7;
      g.beginPath();
      curveThrough(g, surfX, rowY, count, { move: true });
      g.stroke();

      if (p.glint > 0) {
        // The sprite's tint from `stable`: a baked sprite is a cache, and a
        // murkiness bound to an LFO would otherwise bake a new one a frame.
        const flecks = patchSprite(waterAbsorb(stable.color, distance * 0.6, stable.turbidity));
        stampFlecks(g, flecks, rowY, rowLight, count, spacing, tall,
          0.3, 0.1, tall * 6, 1.4, 0.15, 0.9 * fade * p.glint * level);
      }
    }

    /**
     * The surface itself, seen edge-on.
     *
     * At a grazing angle water is a mirror — the Fresnel reflectance of water
     * is about 2% face-on and effectively 100% at the horizon — so the line
     * where it meets the wall is the brightest thing in the picture by a long
     * way. Getting this too dim is the single commonest way an underwater look
     * fails to read: without a bright rim there is no surface, and with no
     * surface there is no "under".
     *
     * A tight glow and a hot core, and nothing wider. The old version hung
     * three ever-wider strokes under the line and each had an edge of its own,
     * so the surface came with a stack of contour lines beneath it — a wide
     * halo that read as lightning's, not as water's. The bloom downstream does
     * the spreading, and does it without edges.
     */
    for (const [width, alpha, white] of [[0.012, 0.12, 0], [0.0055, 0.3, 0.2], [0.0022, 0.75, 0.6]]) {
      g.strokeStyle = rgba(mixHex(surfaceColour, '#ffffff', white), clamp(alpha * level, 0, 1));
      g.lineWidth = Math.max(1.2, world.h * width);
      g.beginPath();
      curveThrough(g, surfX, surfY, count, { move: true });
      g.stroke();
    }

    /**
     * Glints, on the facets pointing at the light.
     *
     * A specular highlight is not "on the crest"; it is wherever the surface
     * slope happens to satisfy the reflection, which is on the flanks just
     * short of each crest, and it moves along the wave rather than with it.
     * Driving them off the slope gives that for nothing, and it is the reason
     * they sparkle in and out instead of marching sideways in a row.
     *
     * One per facet — at the peak of each run of light, not at every sample
     * in it — or a facet ten samples wide is ten glints welded into a bar.
     */
    if (p.glint > 0) {
      const sprite = glintSprite(surfaceColour);
      for (let i = 1; i < count - 1; i++) {
        const here = facing(surfSlope[i], 0.16);
        if (here < 0.55) continue;
        if (here < facing(surfSlope[i - 1], 0.16) || here <= facing(surfSlope[i + 1], 0.16)) continue;
        // Brighter where the facet is also curved towards you: a convex patch
        // gathers the light it reflects into a smaller, hotter image.
        const focus = clamp(0.6 + Math.abs(surfBend[i]) * 0.35, 0.6, 1.4);
        const strength = (here - 0.55) / 0.45;
        const size = world.h * (0.035 + 0.05 * strength) * focus;
        g.globalAlpha = clamp(strength * 0.95 * p.glint * level, 0, 1);
        g.drawImage(sprite, surfX[i] - size / 2, surfY[i] - size / 2, size, size);
      }
      g.globalAlpha = 1;
    }

    /**
     * The light that gets past the surface and lands on the wall above it.
     *
     * The bit of a swimming pool everybody has actually looked at: bright
     * ripples crawling up the wall above the water, brightest right at the
     * line and gone within a metre or so. It is a caustic, it comes from the
     * same wave train, and it is the cheapest possible confirmation that the
     * wave is real rather than drawn — the two agree because they are the
     * same numbers.
     *
     * Each band is a stretch of the surface thrown up the wall — the light
     * landing higher came off water further out, so each is the same wave
     * train sampled further back and stretched sideways by the angle it
     * arrives at — and it is lit only where that water is curved the way
     * that focuses light: a trough is a concave mirror and gathers what it
     * reflects into a bright line, a crest spreads it out to nothing. That is
     * why the real thing is dappled — bright flecks that swell and slide and
     * go out — and why a band drawn all the way across reads as a contour
     * line rather than as light. Drawn as soft flecks rather than as strokes
     * for the same reason as the mirror band: a thin bright stroke with ends
     * is a scratch, and a wall of them is a wall of scratches.
     */
    if (p.spill > 0 && baseY > bbox.y) {
      const reach = world.h * 0.12;
      const sprite = patchSprite(surfaceColour);
      for (let b = 1; b <= 4; b++) {
        const up = (b / 4) ** 1.3 * reach * 0.85;
        const fade = (1 - b / 5) ** 1.5 * p.spill * level;
        const stretch = 1 / (1 + b * 0.4);
        for (let i = 0; i < count; i++) {
          waveAt((surfX[i] * stretch) * metresPerPixel + b * 2.3, t, metresHigh, p.wavelength);
          // The vertical swing is the surface's own, magnified a little by
          // the throw: it is the same lens, further from what it lights.
          rowY[i] = baseY - up + WAVE.outline * pixelsPerMetre * (1 + b * 0.3);
          rowLight[i] = clamp(WAVE.curvature * 0.3, 0, 1);
        }
        // Further up the wall the light has spread: wider, taller, fainter.
        const tall = world.h * (0.012 + b * 0.005);
        stampFlecks(g, sprite, rowY, rowLight, count, spacing, tall, 0.12, 0.05, tall * 3.5, 1.1, 0, 1.3 * fade);
      }
      // And a faint wash of all of it together, right at the line.
      const wash = g.createLinearGradient(0, baseY - reach * 0.6, 0, baseY);
      wash.addColorStop(0, rgba(surfaceColour, 0));
      wash.addColorStop(1, rgba(surfaceColour, clamp(0.08 * p.spill * level, 0, 1)));
      g.fillStyle = wash;
      g.beginPath();
      g.moveTo(left, baseY - reach * 0.6);
      g.lineTo(right, baseY - reach * 0.6);
      g.lineTo(surfX[count - 1], surfY[count - 1]);
      for (let i = count - 2; i >= 0; i--) g.lineTo(surfX[i], surfY[i]);
      g.closePath();
      g.fill();
    }

    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * The shoal
 * ------------------------------------------------------------------ */

/** Shortest signed difference between two angles. */
function angleDelta(from, to) {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/**
 * Three body plans, and the trade-off they are three points on.
 *
 * A fish's shape is a choice between going fast in a straight line and turning
 * on the spot, and you can read which one it made off the silhouette. A
 * sardine is fusiform with a deeply forked tail — a high-aspect-ratio foil, low
 * induced drag, superb cruising, and it turns like a bus. An angelfish is a
 * disc with a rounded paddle: hopeless over distance, and it can pivot inside
 * its own length, which is what you want among coral heads where the food is a
 * body length away and so is the thing eating you. Reef fish sit in between.
 *
 * So `cruise` is not decoration either. A deep-bodied fish in the same shoal
 * as a sardine, swimming at the same speed, is the tell that these are three
 * paint jobs rather than three animals.
 *
 * `radius` is the other half of that same trade-off and the half that was
 * missing: how tight a circle the body can hold, in body lengths. Without it
 * the silhouettes claimed a difference the swimming did not have, and worse,
 * nothing bounded how fast a fish could come round at all — the avoidance term
 * is a couple of thousand pixels per second per second, which against a
 * cruising speed is a fifth of a radian in a single step, or twelve radians a
 * second. No animal does that, and a shoal working past a bay window was
 * therefore full of fish snapping instantaneously through ninety degrees, which
 * is both the vibration and, since the flash is keyed to turning, the reason
 * every one of them was lit up like a strip light while it happened.
 */
const SPECIES = {
  sardine: { depth: 0.28, fork: 1, dorsal: 0.5, cruise: 1, radius: 2.2 },
  reef: { depth: 0.46, fork: 0.5, dorsal: 0.8, cruise: 0.82, radius: 1.3 },
  angelfish: { depth: 0.78, fork: 0.05, dorsal: 1.1, cruise: 0.62, radius: 0.8 },
};
const SPECIES_NAMES = Object.keys(SPECIES);

/** Which body plan fish `tint` has, given the layer's setting. */
function speciesFor(choice, tint) {
  if (choice && choice !== 'mixed' && SPECIES[choice]) return SPECIES[choice];
  return SPECIES[SPECIES_NAMES[Math.min(SPECIES_NAMES.length - 1,
    Math.floor(tint * SPECIES_NAMES.length))]];
}

/**
 * Fish graze the facade rather than bouncing off it. See `slide` in
 * effects/obstacles.js — one object, hoisted, because it is passed forty-odd
 * times a step and a literal here would allocate on every one of them.
 */
const GRAZE = { slide: true };

/** Scratch for the look-ahead point, so a per-fish probe allocates nothing. */
const PROBE = { x: 0, y: 0 };

const shoal = {
  id: 'shoal',
  name: 'Shoal',
  category: 'underwater',
  scope: 'shape',
  description:
    'A shoal working its way across the wall, keeping off the windows and the door. They flash as they bank, because a fish’s flank is a mirror and it has just turned it towards the light.',
  params: [
    { key: 'color', type: 'color', label: 'Back', default: '#2f6f8f' },
    { key: 'belly', type: 'color', label: 'Flank', default: '#dff6ff' },
    { key: 'count', type: 'range', label: 'Fish', default: 42, min: 1, max: 90, step: 1 },
    { key: 'size', type: 'range', label: 'Length', default: 30, min: 6, max: 180, step: 1 },
    { key: 'species', type: 'select', label: 'Body plan', default: 'mixed', options: ['mixed', ...SPECIES_NAMES] },
    { key: 'speed', type: 'range', label: 'Speed', default: 190, min: 20, max: 900, step: 5 },
    { key: 'cohesion', type: 'range', label: 'Cohesion', default: 0.7, min: 0, max: 2, step: 0.01 },
    { key: 'alignment', type: 'range', label: 'Alignment', default: 1, min: 0, max: 2, step: 0.01 },
    { key: 'separation', type: 'range', label: 'Personal space', default: 1, min: 0, max: 3, step: 0.01 },
    { key: 'wander', type: 'range', label: 'Roaming', default: 0.6, min: 0, max: 2, step: 0.01 },
    { key: 'obstacles', type: 'text', label: 'Solid tags', default: 'window, door' },
    { key: 'startle', type: 'range', label: 'Startles', default: 0.25, min: 0, max: 2, step: 0.01 },
    { key: 'flash', type: 'range', label: 'Flank flash', default: 1, min: 0, max: 3, step: 0.05 },
    ...SURFACE_PARAMS,
  ],
  init() {
    return { fish: [], targetX: 0, targetY: 0, scare: 0, scareX: 0, scareY: 0 };
  },
  step({ p, shape, dt, rng, state, shapes, noise, t }) {
    const container = shape;
    if (container.bbox.w <= 4 || container.bbox.h <= 4) return;

    const obstacles = collectObstacles(shapes, p.obstacles, container.id);
    const size = Math.max(3, p.size);
    const target = Math.round(clamp(p.count, 1, 90));

    while (state.fish.length < target) {
      // Rejection-sampled so a fish never begins its life inside the bay
      // window — from which, being pushed out along the nearest normal, it
      // would leave through whichever wall it happened to be closest to.
      let x = container.bbox.cx;
      let y = container.bbox.cy;
      for (let i = 0; i < 30; i++) {
        const cx = container.bbox.x + rng() * container.bbox.w;
        const cy = container.bbox.y + rng() * container.bbox.h;
        if (isClear(container, obstacles, cx, cy)) {
          x = cx;
          y = cy;
          break;
        }
      }
      const a = rng() * TAU;
      state.fish.push({
        x,
        y,
        vx: Math.cos(a) * p.speed,
        vy: Math.sin(a) * p.speed,
        /** Tail-beat phase, advanced by distance rather than by time. */
        beat: rng() * TAU,
        /** Smoothed turn rate, in radians per second. Drives the flash. */
        turn: 0,
        /** A little size and speed variation, or it is a school of clones. */
        scale: 0.75 + rng() * 0.5,
        tint: rng(),
        /** Consecutive steps with nowhere legal to be. See the escape below. */
        wedged: 0,
      });
    }
    if (state.fish.length > target) state.fish.length = target;

    /**
     * Where the shoal is trying to get to.
     *
     * Boids on their own mill about in one spot: the three classic rules are
     * all *relative*, so a flock with no external term has no reason to go
     * anywhere. A slowly wandering attractor is what takes them on a tour of
     * the wall — and taking it from noise rather than from a random walk means
     * every tab agrees about where they went without anything being broadcast.
     */
    const roam = Math.max(0.001, p.wander);
    let roamX = container.bbox.x + container.bbox.w * (0.5 + 0.42 * noise.noise2(t * 0.05 * roam, 11.3));
    let roamY = container.bbox.y + container.bbox.h * (0.5 + 0.38 * noise.noise2(4.7, t * 0.045 * roam));

    /**
     * And it is not allowed to be inside the bay window.
     *
     * Nothing stopped it being, and for the third of the time it was the whole
     * shoal was being steered *into* the glass while the avoidance below shoved
     * it back out. The two settle against each other rather than cancelling:
     * every fish ends up pressed on the sill, holding station, buzzing, and
     * since they are drawn additively the pile reads as one white smear with
     * fins. It is the standoff that looks broken, not either force.
     *
     * Sliding it out to the nearest edge keeps the tour going — the shoal
     * rounds the window instead of parking on it — and costs one surface query
     * a step rather than one per fish.
     */
    const span = Math.hypot(container.bbox.w, container.bbox.h);
    // Twice, because a house has shapes inside shapes — a door in its frame —
    // and stepping out of the inner one puts the target in the outer.
    for (let tries = 0; tries < 3 && !isClear(container, obstacles, roamX, roamY); tries++) {
      const surf = nearestSurface(obstacles, roamX, roamY, span);
      if (!surf) break;
      // `n` points from the surface towards the target, so it is the way out
      // when the target is outside and the way in when it has crossed.
      const out = surf.inside ? -1 : 1;
      roamX = surf.px + surf.nx * out * size * 3;
      roamY = surf.py + surf.ny * out * size * 3;
    }
    // And if there is nowhere near it to move it to — a target deep inside a
    // nest of overlapping shapes — the shoal carries on towards wherever it
    // was already going until the wander takes the destination somewhere it
    // can actually be. Never towards the middle of a window.
    if (isClear(container, obstacles, roamX, roamY) || !state.targetX) {
      state.targetX = roamX;
      state.targetY = roamY;
    }

    /**
     * Being startled, which is what a shoal is *for*.
     *
     * A bait ball's whole behaviour is the flinch: hundreds of fish going one
     * way, something arrives, and the ball turns itself inside out in about a
     * fifth of a second. Without it the effect is a screensaver. `rng()` is
     * reseeded from the step index by the renderer, so this Poisson process is
     * a property of show time and fires on the same frame in every tab.
     */
    if (p.startle > 0 && state.scare <= 0 && rng() < p.startle * dt * 0.35) {
      state.scare = 1;
      state.scareX = container.bbox.x + rng() * container.bbox.w;
      state.scareY = container.bbox.y + rng() * container.bbox.h;
    }
    state.scare = Math.max(0, state.scare - dt * 0.9);

    const sepR = size * 1.5 * Math.max(0.05, p.separation);
    const neighR = size * 5;
    const sepR2 = sepR * sepR;
    const neighR2 = neighR * neighR;

    /**
     * Every pair, once.
     *
     * O(n²), and deliberately: at the ninety-fish maximum that is four thousand
     * pair tests a step, a quarter of a million a second, each of them a
     * subtraction and a compare. A spatial grid would cost more to maintain
     * than it saves at this size, and a shoal is the worst possible case for
     * one anyway — the whole point of the effect is that they are all in the
     * same bucket.
     */
    const n = state.fish.length;
    for (let i = 0; i < n; i++) {
      const f = state.fish[i];
      f.ax = 0;
      f.ay = 0;
      f.near = 0;
    }
    for (let i = 0; i < n; i++) {
      const a = state.fish[i];
      for (let j = i + 1; j < n; j++) {
        const b = state.fish[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > neighR2 || d2 < 1e-6) continue;
        if (d2 < sepR2) {
          const d = Math.sqrt(d2);
          const push = (1 - d / sepR) * p.separation * 900;
          const ux = dx / d;
          const uy = dy / d;
          a.ax -= ux * push;
          a.ay -= uy * push;
          b.ax += ux * push;
          b.ay += uy * push;
        }
        a.ax += (b.vx - a.vx) * p.alignment * 0.9 + dx * p.cohesion * 0.5;
        a.ay += (b.vy - a.vy) * p.alignment * 0.9 + dy * p.cohesion * 0.5;
        b.ax += (a.vx - b.vx) * p.alignment * 0.9 - dx * p.cohesion * 0.5;
        b.ay += (a.vy - b.vy) * p.alignment * 0.9 - dy * p.cohesion * 0.5;
        a.near++;
        b.near++;
      }
    }

    const look = size * 3.4;
    const maxSpeed = p.speed * (1 + state.scare * 1.6);
    const minSpeed = p.speed * 0.45;

    for (const f of state.fish) {
      // The neighbour terms are sums, so a fish in the middle of the ball would
      // otherwise be accelerated forty times harder than one on the edge.
      if (f.near > 0) {
        f.ax /= f.near;
        f.ay /= f.near;
      }

      // Towards wherever the shoal is heading, weakly.
      f.ax += (state.targetX - f.x) * 0.35 * p.wander;
      f.ay += (state.targetY - f.y) * 0.35 * p.wander;

      // And hard away from whatever just turned up.
      if (state.scare > 0) {
        const dx = f.x - state.scareX;
        const dy = f.y - state.scareY;
        const d = Math.hypot(dx, dy) || 1;
        const strength = state.scare * 5200 / (1 + (d / (size * 6)) ** 2);
        f.ax += (dx / d) * strength;
        f.ay += (dy / d) * strength;
      }

      /**
       * Looking where it is going.
       *
       * Probing ahead rather than reacting on contact is the difference between
       * a shoal that flows round the bay window and one that bumps into it and
       * ricochets. The steer is along the surface — `ex, ey` is the edge the
       * probe found — taken in whichever direction agrees with the heading, so
       * a fish approaching a sill runs along it and leaves at the corner.
       */
      const speed = Math.hypot(f.vx, f.vy) || 1;
      const probeX = f.x + (f.vx / speed) * look;
      const probeY = f.y + (f.vy / speed) * look;

      /**
       * The edge of the wall is a wall too.
       *
       * Only the obstacles were ever probed, so a fish saw the bay window
       * coming and never saw the end of the building: it arrived at the
       * boundary at full speed and was put back by the hard constraint at the
       * foot of this loop. That is not a fish noticing anything — it is a
       * ricochet, or, now that a fish grazes rather than bounces, a slide that
       * carries it along the edge for as long as the shoal is heading that way.
       * Either is a row of fish pressed against the top of the frame.
       */
      PROBE.x = probeX;
      PROBE.y = probeY;
      const edge = surfaceNormal(container.points, probeX, probeY);
      if (edge.dist < look) {
        // `n` points from the edge towards the probe: inwards while the probe
        // is still over the wall, outwards once it has left.
        const inward = pointInPolygon(PROBE, container.points) ? 1 : -1;
        const urgency = (1 - edge.dist / look) * 2600;
        f.ax += edge.nx * inward * urgency;
        f.ay += edge.ny * inward * urgency;
      }

      /**
       * Every obstacle within reach, not just the closest one.
       *
       * `nearestSurface` used to stand in here on its own, and picking a
       * single winner is fine when there is only one thing to avoid. Between
       * two — a gap between windows, a window close to the edge of the wall —
       * it is not: whichever is a pixel closer takes over the steering
       * completely, so a fish easing into the gap gets shoved one way, and the
       * moment that nudge makes the *other* obstacle the nearer one, shoved
       * back. The turning-circle cap keeps either shove from being a full
       * reversal, so the fish neither escapes nor settles — it sits in the gap
       * flipping between the two headings, which is a fish stuck vibrating at
       * the mouth of every such gap, precisely where the shafts of light also
       * happen to line up.
       *
       * Summing every obstacle in range instead gives the fish sitting between
       * two of them what it should feel: both pushes at once, cancelling in
       * the middle of the gap and net-zero exactly on the centreline, with
       * only the tangents left to carry it through. The hard constraint below
       * already loops over all of them for the same reason; this brings the
       * soft steering into line with it.
       */
      for (const o of obstacles) {
        const { bbox } = o;
        if (
          probeX < bbox.x - look
          || probeX > bbox.x + bbox.w + look
          || probeY < bbox.y - look
          || probeY > bbox.y + bbox.h + look
        ) continue;
        const surf = surfaceNormal(o.points, probeX, probeY);
        if (surf.dist >= look) continue;
        const urgency = (1 - surf.dist / look) * 2600;
        const elen = Math.hypot(surf.ex, surf.ey) || 1;
        let tx = surf.ex / elen;
        let ty = surf.ey / elen;
        if (tx * f.vx + ty * f.vy < 0) {
          tx = -tx;
          ty = -ty;
        }
        // Out of the obstacle, and along it. `nx, ny` points away from the
        // surface towards the probe, which is the way out when the probe is
        // still outside and the way *in* when it has already crossed — hence
        // the sign, which is the one thing here that is easy to get backwards.
        const sign = pointInPolygon(PROBE, o.points) ? -1 : 1;
        f.ax += surf.nx * sign * urgency + tx * urgency * 0.8;
        f.ay += surf.ny * sign * urgency + ty * urgency * 0.8;
      }

      const heading = Math.atan2(f.vy, f.vx);
      f.vx += f.ax * dt;
      f.vy += f.ay * dt;

      // A deep-bodied fish holding station beside a sardine at the same speed
      // is the tell that these are three paint jobs rather than three animals.
      const kind = speciesFor(p.species, f.tint);
      const top = maxSpeed * kind.cruise;
      const floor = minSpeed * kind.cruise;
      const sp = Math.hypot(f.vx, f.vy);
      if (sp > top) {
        f.vx *= top / sp;
        f.vy *= top / sp;
      } else if (sp < floor && sp > 1e-6) {
        f.vx *= floor / sp;
        f.vy *= floor / sp;
      }

      /**
       * And it cannot come round faster than its body will let it.
       *
       * Everything above is a force, and a force applied to a light thing
       * turns it arbitrarily fast: the avoidance term alone swung a fish a
       * fifth of a radian in one step. Nothing said it could not, so near a
       * sill a fish would flip end for end frame after frame — the vibration
       * in the photograph — and because a mirror flank flashes when it banks,
       * every fish doing it sat at maximum flash the whole time.
       *
       * A turning circle is the one constraint that fixes both, and it is the
       * one the body plans already imply: radius equals speed over angular
       * rate, so a fish holding a circle `radius` body lengths across can
       * manage `v / (radius · length)` radians a second and no more. The
       * sardine that turns like a bus now turns like a bus. Faster fish turn
       * *wider*, which is why a startled shoal bursts outwards in an arc
       * instead of scattering like billiard balls.
       */
      const held = Math.hypot(f.vx, f.vy);
      if (held > 1e-6) {
        const most = (held / Math.max(1, size * f.scale * kind.radius)) * dt;
        const swing = angleDelta(heading, Math.atan2(f.vy, f.vx));
        if (Math.abs(swing) > most) {
          const capped = heading + Math.sign(swing) * most;
          f.vx = Math.cos(capped) * held;
          f.vy = Math.sin(capped) * held;
        }
      }

      /**
       * The flank flash, and why it is keyed to turning rather than to speed.
       *
       * A fish is a mirror with a fish-shaped outline. Swimming straight, its
       * flank faces sideways and reflects the downwelling light away from you;
       * banking into a turn, it rolls that flank up towards the surface and for
       * a fraction of a second throws the light straight at you. That is the
       * silver flicker that runs through a shoal as it changes direction, and
       * it is the single most recognisable thing a shoal does.
       *
       * Measured here, over the *steering* — before the hard constraints below
       * get a say. A wall does not bank a fish, it stops one, and reading the
       * heading after a deflect calls a rebound a turn: half a radian in a
       * sixtieth of a second, which is thirty radians per second against a
       * scale that saturates at seven. So every fish held against a sill was
       * pinned at maximum flash for as long as it stayed there — which is why
       * the shoal in the photograph is a row of white bars rather than fish.
       *
       * Smoothed, because the flash outlasts the instant of the turn — it is a
       * broad specular lobe, not a delta function.
       */
      const rate = Math.abs(angleDelta(heading, Math.atan2(f.vy, f.vx))) / Math.max(1e-4, dt);
      f.turn = lerp(f.turn, Math.min(12, rate), 0.25);

      f.x += f.vx * dt;
      f.y += f.vy * dt;

      // Hard constraints last, so nothing this step can leave a fish inside a
      // window: the accelerations above are a suggestion, these are the wall.
      // Grazing rather than bouncing, because a fish that meets a sill swims
      // along it — see `slide` in effects/obstacles.js for why the alternative
      // buzzes.
      deflect(container.points, f, size * 0.35, 0.25, true, GRAZE);
      for (const o of obstacles) {
        const { bbox } = o;
        if (
          f.x < bbox.x - size
          || f.x > bbox.x + bbox.w + size
          || f.y < bbox.y - size
          || f.y > bbox.y + bbox.h + size
        ) continue;
        deflect(o.points, f, size * 0.35, 0.25, false, GRAZE);
      }

      /**
       * Grazing off two surfaces in the same step can leave less than one.
       *
       * A slide removes only the component driving into *that* surface, which
       * is correct for one surface at a time — but a fish squeezed into a gap
       * now gets pushed towards every obstacle in reach rather than just the
       * nearest, so it reaches the mouth of a gap heading closer to square-on
       * to both sides than it used to. Slide off the wall, then off the window
       * beside it, and the second slide can remove most of what the first one
       * left, since the two normals are not parallel. What survives is still
       * the correct direction — clear of both surfaces — just thinner than the
       * floor promises, and nothing after this put it back.
       */
      const grazed = Math.hypot(f.vx, f.vy);
      if (grazed < floor) {
        if (grazed > 1e-6) {
          f.vx *= floor / grazed;
          f.vy *= floor / grazed;
        } else {
          f.vx = Math.cos(heading) * floor;
          f.vy = Math.sin(heading) * floor;
        }
      }

      /**
       * And a way out for one that cannot be put anywhere legal at all.
       *
       * The constraints are applied one after another and each is satisfied on
       * its own, so a fish in a space narrower than two of them — the ring
       * between a door and its frame, the gap where a window meets the edge of
       * the wall — is placed by the last one to run and is illegal again by the
       * time the first runs next step. Sliding stops it *arriving* there, but a
       * shape can be re-tagged or a fish startled into one, and there is no
       * position that satisfies everything to converge on.
       *
       * Half a second of being unplaceable is proof rather than bad luck, so it
       * is moved somewhere it fits and given a fresh heading. Once every few
       * minutes at worst, on one fish out of forty, in a shoal that is already
       * moving.
       */
      if (isClear(container, obstacles, f.x, f.y)) {
        f.wedged = 0;
      } else if (++f.wedged > 30) {
        const spot = findFreeSpot(container, obstacles, rng);
        f.x = spot.x;
        f.y = spot.y;
        const away = rng() * TAU;
        f.vx = Math.cos(away) * p.speed;
        f.vy = Math.sin(away) * p.speed;
        f.turn = 0;
        f.wedged = 0;
      }
      // Beat phase advances with distance covered, so a fish that speeds up
      // beats its tail faster rather than swimming with the same stroke.
      f.beat += (Math.hypot(f.vx, f.vy) / Math.max(1, size)) * dt * 9;
    }
  },
  draw({ g, p, shape, state, world }) {
    if (!state.fish?.length) return;
    const size = Math.max(3, p.size);

    /**
     * Fish are painted over one another, not added.
     *
     * A fish is not a light, it is a thing in front of the wall — and in a
     * shoal the nearer fish hides the one behind it. Drawn additively, as
     * they were, every place two fish crossed was brighter than either, and
     * a shoal packed into a corner or streaming along an edge summed to a
     * white bar with fins. Painted, the overlap is just the nearer fish, so a
     * dense shoal stays a crowd of fish however dense it gets. Only the
     * flash adds, because the flash is light: the mirror of the flank
     * throwing the sky at you.
     */
    g.save();
    g.clip(shape.path);
    g.lineCap = 'round';
    g.lineJoin = 'round';

    for (const f of state.fish) {
      const kind = speciesFor(p.species, f.tint);
      const len = size * f.scale;
      const half = len * 0.5;
      /**
       * How deep the fish is either side of its midline, at its deepest.
       *
       * Everything that has to sit *on* the fish — the fins, the stripe —
       * is measured from this, and the outline reaches it exactly: the flank
       * is drawn with cubics whose shoulder is an end point rather than a
       * control point, so there is no guessing how far short of its control
       * point a curve falls. Getting that wrong is what used to hang the fins
       * in the water beside the animal.
       */
      const rim = len * kind.depth * 0.5;
      const angle = Math.atan2(f.vy, f.vx);
      const metres = depthAt(p, f.y, world);

      const back = waterAbsorb(mixHex(p.color, p.belly, f.tint * 0.25), metres, p.turbidity);
      const flank = waterAbsorb(p.belly, metres, p.turbidity);
      /**
       * How much of the flank is pointed at you, and it has a floor under it.
       *
       * Straight and level is not a flash: an ordinary correction while
       * cruising among forty others is a couple of radians a second and should
       * show nothing at all, or every fish shines all the time and the shoal is
       * a field of white lozenges. What earns one is a *bank* — the hard turn
       * into a startle, the roll round the corner of a sill — so the response
       * starts above the cruising rate and goes as the square of it, which
       * makes the flash a flicker running through the shoal rather than a state
       * each fish is in.
       */
      const bank = clamp((f.turn - 0.5) / 5, 0, 1);
      const shine = clamp(bank * bank * p.flash, 0, 1);

      g.save();
      g.translate(f.x, f.y);
      g.rotate(angle);
      /**
       * Back up, whichever way it is swimming.
       *
       * Rotating a fish to its heading turns it upside down the moment it
       * swims left, and a fish is counter-shaded — dark back, bright belly —
       * precisely because the light comes from above. Upside down it is lit
       * from below, which reads instantly as wrong even when nobody can say
       * why. So a fish heading left is mirrored rather than rolled.
       */
      if (Math.cos(angle) < 0) g.scale(1, -1);

      /**
       * The tail, hinged at the peduncle and forked as deeply as the body plan
       * says. The fork is the aspect ratio: a deep one is a long thin foil
       * that sheds little energy sideways and drives a cruiser; a rounded
       * paddle is a low-aspect-ratio blade that is inefficient and can throw a
       * lot of water in one stroke, which is how a reef fish leaves.
       *
       * Seen from the side a tail beats across the line of sight, so what the
       * eye gets is not a fin swinging up and down but one turning edge-on
       * and back: it narrows and flares with every stroke, which is the
       * flicker that says a fish is swimming rather than gliding.
       */
      const beat = Math.sin(f.beat);
      const flare = 0.55 + 0.45 * Math.abs(Math.cos(f.beat));
      const ped = rim * (0.16 + 0.12 * (1 - kind.fork));
      const tailX = -half * 0.64;
      const span = Math.max(rim * 0.95, len * 0.13);
      const reach = half * (0.42 + 0.12 * kind.fork) * flare;
      const notch = reach * (0.2 + 0.62 * kind.fork);
      const lift = beat * span * 0.12;
      g.fillStyle = rgba(mixHex(back, flank, 0.35), 0.7);
      g.beginPath();
      g.moveTo(tailX + half * 0.04, -ped);
      g.quadraticCurveTo(tailX - reach * 0.45, -span * 0.55 + lift, tailX - reach, -span + lift);
      g.quadraticCurveTo(tailX - reach * 0.8, -span * 0.35 + lift, tailX - notch, lift * 0.5);
      g.quadraticCurveTo(tailX - reach * 0.8, span * 0.35 + lift, tailX - reach, span + lift);
      g.quadraticCurveTo(tailX - reach * 0.45, span * 0.55 + lift, tailX + half * 0.04, ped);
      g.closePath();
      g.fill();

      /**
       * The body: fusiform, deepest a third of the way back, tapering a long
       * way to a narrow peduncle, with a blunt rounded snout — and
       * counter-shaded, which on a wall of light means a dim back and a bright
       * belly. The gradient runs across the fish rather than along it, from the
       * back's colour at a third of the brightness to the silver of the belly,
       * because that is the one detail that turns a lozenge into a fish at the
       * size these are seen from the pavement.
       */
      const shoulder = half * 0.2;
      const belly = rim * 1.04;
      const skin = g.createLinearGradient(0, -rim, 0, belly);
      skin.addColorStop(0, rgba(back, 0.3));
      skin.addColorStop(0.38, rgba(mixHex(back, flank, 0.45), 0.5));
      skin.addColorStop(0.62, rgba(flank, 0.82));
      skin.addColorStop(1, rgba(flank, 0.68));
      g.fillStyle = skin;
      g.beginPath();
      g.moveTo(half, rim * 0.08);
      g.bezierCurveTo(half, -rim * 0.55, shoulder + half * 0.42, -rim, shoulder, -rim);
      g.bezierCurveTo(shoulder - half * 0.4, -rim, tailX + half * 0.3, -ped * 1.3, tailX, -ped);
      g.lineTo(tailX, ped);
      g.bezierCurveTo(tailX + half * 0.3, ped * 1.3, shoulder - half * 0.4, belly, shoulder, belly);
      g.bezierCurveTo(shoulder + half * 0.42, belly, half, rim * 0.6, half, rim * 0.08);
      g.closePath();
      g.fill();

      // Dorsal, swept back, on the deepest part of the back.
      g.fillStyle = rgba(back, 0.5);
      g.beginPath();
      g.moveTo(half * 0.32, -rim * 0.92);
      g.quadraticCurveTo(half * 0.05, -(rim + half * 0.24 * kind.dorsal), -half * 0.18, -(rim + half * 0.2 * kind.dorsal));
      g.quadraticCurveTo(-half * 0.25, -rim * 0.9, -half * 0.42, -rim * 0.72);
      g.closePath();
      g.fill();
      /**
       * And, on the deep-bodied ones, the anal fin that mirrors it.
       *
       * A tall dorsal on its own reads as a sailfish. The pair — one above,
       * one below, both swept back — is what makes the outline a disc with
       * points on it, which is the thing anybody recognises as a reef fish.
       */
      if (kind.dorsal > 0.7) {
        g.fillStyle = rgba(mixHex(back, flank, 0.5), 0.5);
        g.beginPath();
        g.moveTo(-half * 0.02, rim * 0.95);
        g.quadraticCurveTo(-half * 0.2, rim + half * 0.17 * kind.dorsal, -half * 0.4, rim + half * 0.12 * kind.dorsal);
        g.quadraticCurveTo(-half * 0.42, rim * 0.85, -half * 0.5, rim * 0.6);
        g.closePath();
        g.fill();
      }

      /**
       * The silver line along the flank, and the gill behind the head.
       *
       * A sardine's flank is a mirror and the brightest thing on it is the
       * stripe where the mirror is flattest; the gill cover is a second,
       * curved one. Neither is visible from across the road on its own, but
       * together they are what stops a slim fish reading as a leaf.
       *
       * Not on the deep-bodied ones, and there are no bars on them either,
       * though a reef fish has them. Bars are *dark* bands, and on a wall of
       * light the only way to draw something dark is to leave it out; drawn
       * as light instead, bars and a stripe across a disc read as the ribs of
       * an X-rayed fish. A reef fish here is its silhouette — the disc, the
       * paired fins, the paddle tail — which is what anybody recognises it by.
       */
      const slim = kind.depth < 0.4;
      g.strokeStyle = rgba(mixHex(flank, '#ffffff', 0.5), slim ? 0.5 : 0.3);
      g.lineWidth = Math.max(0.7, rim * (slim ? 0.14 : 0.08));
      g.beginPath();
      if (slim) {
        g.moveTo(half * 0.5, -rim * 0.12);
        g.quadraticCurveTo(0, -rim * 0.2, tailX + half * 0.05, -ped * 0.2);
      }
      g.moveTo(half * 0.5, -rim * 0.55);
      g.quadraticCurveTo(half * 0.4, 0, half * 0.5, rim * 0.6);
      g.stroke();

      // The pectoral, sculling against the tail.
      g.fillStyle = rgba(flank, 0.45);
      g.beginPath();
      g.moveTo(half * 0.36, rim * 0.28);
      g.quadraticCurveTo(half * 0.12, rim * (0.55 + beat * 0.12), half * 0.02, rim * (0.72 + beat * 0.15));
      g.quadraticCurveTo(half * 0.2, rim * 0.4, half * 0.36, rim * 0.28);
      g.closePath();
      g.fill();

      /**
       * The flash, which is the whole flank rather than a line on it.
       *
       * A fish is a mirror with a fish-shaped outline, and when it rolls its
       * flank up to the light the mirror throws the whole of the sky at you:
       * for a moment the fish *is* a white fish. Drawn as the flank itself,
       * filled white at the strength of the bank, and inside the outline, so a
       * flashing fish is still a fish rather than a glowing capsule with fins
       * stuck on it.
       */
      if (shine > 0.02) {
        g.globalCompositeOperation = 'lighter';
        g.fillStyle = rgba(mixHex(flank, '#ffffff', 0.7), shine * 0.85);
        g.beginPath();
        g.moveTo(half * 0.62, -rim * 0.1);
        g.quadraticCurveTo(0, -rim * 0.95, tailX + half * 0.08, -ped * 0.5);
        g.quadraticCurveTo(0, rim * 0.85, half * 0.62, -rim * 0.1);
        g.closePath();
        g.fill();
        g.globalCompositeOperation = 'source-over';
      }

      /**
       * The eye: the one bright point on the head, which is what a fish eye
       * is in reflected light — a silvered ring round a black pupil. On a
       * wall of light the pupil is just where no light goes, so it is a small
       * bright ring, and at the size of these mostly a catchlight.
       */
      g.strokeStyle = rgba(mixHex(flank, '#ffffff', 0.6), 0.75);
      g.lineWidth = Math.max(0.6, rim * 0.1);
      g.beginPath();
      g.arc(half * 0.66, -rim * 0.22, Math.max(0.6, rim * 0.17), 0, TAU);
      g.stroke();

      g.restore();
    }

    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * Bubbles
 * ------------------------------------------------------------------ */

/**
 * One atmosphere, expressed as the depth of water that weighs the same.
 *
 * 10.33 m, and it is the number that makes a bubble grow. The absolute pressure
 * on a bubble ten metres down is twice the pressure on one at the surface, so
 * by Boyle's law it has half the volume — a radius ratio of the cube root of
 * two, about 1.26. A bubble leaving a vent at the foot of a house and reaching
 * the surface visibly swells on the way, and an effect where they all stay the
 * same size is one where the eye is told, quietly, that there is no water.
 */
const ATMOSPHERE_IN_METRES = 10.33;

/** Where bubbles come out of: the low edge of whatever shape they are given. */
function ventsFor(shape, count, rng, spread) {
  const { bbox } = shape;
  const low = [];
  for (let i = 0; i < 64; i++) {
    const at = shape.sampler.at(i / 64);
    if (at.y > bbox.y + bbox.h * 0.72) low.push(at);
  }
  const vents = [];
  for (let i = 0; i < count; i++) {
    const pick = low.length ? low[Math.floor(rng() * low.length) % low.length] : null;
    const jitter = (rng() - 0.5) * bbox.w * spread;
    vents.push({
      x: (pick ? pick.x : bbox.cx) + jitter,
      y: pick ? pick.y : bbox.y + bbox.h,
      // A vent is a crack in something, and cracks do not breathe evenly.
      duty: 0.35 + rng() * 0.65,
      phase: rng() * TAU,
    });
  }
  return vents;
}

/**
 * A bubble, baked once per colour and size, and stamped.
 *
 * A bubble is a rim, not a disc. Under water it is a lens of air with almost
 * nothing in the middle of it: light passing through the centre is barely
 * bent and carries on, while light meeting the edge hits the interface at a
 * grazing angle and is thrown back at you whole — total internal reflection,
 * the same physics as the mirror under the waterline. So what you see is a
 * bright ring that falls away steeply inside (a Fresnel rim rather than a
 * stroke), a hard catchlight where the top of the bubble faces the surface,
 * and a fainter crescent underneath from the light that went through and
 * came back. Drawn as a filled circle it is a pearl; drawn as a plain stroked
 * circle, as it was, it is a diagram of one.
 *
 * A ladder of three sizes, because a rim is a feature a pixel or two wide
 * whatever the size of the bubble, and shrinking one big sprite down to a
 * small bubble averages its rim into the dark middle and puts it out. Each
 * rung has its rim drawn at its own scale, and a bubble is stamped from the
 * smallest rung at least as big as it is. Baked rather than drawn because
 * there are hundreds of them: one `drawImage` each, where the old rings were
 * three paths and three fills.
 */
const BUBBLE_RUNGS = [16, 32, 64];
const bubbleSprites = new Map();

function bubbleSprite(colour, diameter) {
  let ladder = bubbleSprites.get(colour);
  if (!ladder) {
    if (bubbleSprites.size > 64) bubbleSprites.clear();
    ladder = BUBBLE_RUNGS.map((size) => bakeBubble(colour, size));
    bubbleSprites.set(colour, ladder);
  }
  for (let i = 0; i < BUBBLE_RUNGS.length - 1; i++) {
    if (diameter <= BUBBLE_RUNGS[i]) return ladder[i];
  }
  return ladder[BUBBLE_RUNGS.length - 1];
}

function bakeBubble(colour, size) {
  const sprite = offscreen(size, size);
  const g = sprite.getContext('2d');
  const m = size / 2;
  const r = m - 0.5;
  // The rim is never thinner than a pixel and a half of this rung.
  const band = Math.max(1.5 / r, 0.12);
  g.globalCompositeOperation = 'lighter';

  const rim = g.createRadialGradient(m, m, 0, m, m, r);
  rim.addColorStop(0, rgba(colour, 0.05));
  rim.addColorStop(Math.max(0.3, 1 - band * 3), rgba(colour, 0.1));
  rim.addColorStop(1 - band * 1.2, rgba(colour, 0.55));
  rim.addColorStop(1 - band * 0.45, rgba(mixHex(colour, '#ffffff', 0.35), 1));
  rim.addColorStop(1, rgba(colour, 0.15));
  g.fillStyle = rim;
  g.beginPath();
  g.arc(m, m, r, 0, TAU);
  g.fill();

  // The catchlight, up and to one side, where the bubble faces the surface.
  const hx = m - r * 0.36;
  const hy = m - r * 0.4;
  const hr = Math.max(1.2, r * 0.28);
  const catchlight = g.createRadialGradient(hx, hy, 0, hx, hy, hr);
  catchlight.addColorStop(0, rgba('#ffffff', 1));
  catchlight.addColorStop(0.4, rgba('#ffffff', 0.6));
  catchlight.addColorStop(1, rgba('#ffffff', 0));
  g.fillStyle = catchlight;
  g.beginPath();
  g.arc(hx, hy, hr, 0, TAU);
  g.fill();

  // The crescent underneath: light that went through and came back.
  g.strokeStyle = rgba(mixHex(colour, '#ffffff', 0.3), 0.45);
  g.lineWidth = Math.max(1, r * 0.1);
  g.lineCap = 'round';
  g.beginPath();
  g.arc(m, m, r * 0.7, Math.PI * 0.2, Math.PI * 0.7);
  g.stroke();
  return sprite;
}

const bubbles = {
  id: 'bubbles',
  name: 'Bubbles',
  category: 'underwater',
  scope: 'shape',
  description:
    'Bubbles leaving the bottom edge of the shape, zigzagging the way real ones do, swelling as the water above them thins out, and collecting under any sill they meet on the way.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#dff6ff' },
    { key: 'vents', type: 'range', label: 'Vents', default: 5, min: 1, max: 24, step: 1 },
    { key: 'rate', type: 'range', label: 'Bubbles a second', default: 9, min: 0.2, max: 60, step: 0.2 },
    { key: 'size', type: 'range', label: 'Size', default: 9, min: 1, max: 60, step: 0.5 },
    { key: 'variation', type: 'range', label: 'Size spread', default: 0.7, min: 0, max: 1, step: 0.01 },
    { key: 'rise', type: 'range', label: 'Rise speed', default: 150, min: 10, max: 800, step: 5 },
    { key: 'wobble', type: 'range', label: 'Zigzag', default: 1, min: 0, max: 3, step: 0.01 },
    { key: 'expand', type: 'range', label: 'Swelling', default: 1, min: 0, max: 3, step: 0.05 },
    { key: 'spread', type: 'range', label: 'Vent scatter', default: 0.06, min: 0, max: 0.6, step: 0.005 },
    { key: 'obstacles', type: 'text', label: 'Solid tags', default: 'window, door' },
    { key: 'level', type: 'range', label: 'Brightness', default: 1, min: 0, max: 3, step: 0.05 },
    ...SURFACE_PARAMS,
  ],
  init() {
    return { bubbles: [], vents: null, ventKey: '' };
  },
  step({ p, shape, dt, rng, state, shapes, world, stable }) {
    const { bbox } = shape;
    if (bbox.w <= 2 || bbox.h <= 2) return;

    // Keyed on `stable`, never on `p`: the vent layout must not be rebuilt
    // sixty times a second because somebody bound Rise speed to the microphone.
    const key = `${shape.id}|${Math.round(stable.vents)}|${stable.spread}`;
    if (state.ventKey !== key) {
      state.ventKey = key;
      state.vents = ventsFor(shape, Math.max(1, Math.round(p.vents)), makeRng(`vents:${key}`), p.spread);
    }

    const obstacles = collectObstacles(shapes, p.obstacles, shape.id);
    const top = Math.max(bbox.y, surfaceY(p, world));

    // Poisson spawning, per vent, from a generator the renderer reseeds per
    // step — so two tabs release the same bubble on the same frame.
    const perVent = (p.rate * dt) / state.vents.length;
    for (const vent of state.vents) {
      if (rng() > perVent * vent.duty) continue;
      const size = Math.max(0.5, p.size);
      const r0 = size * (1 - p.variation * 0.7 + rng() * p.variation);
      state.bubbles.push({
        x: vent.x + (rng() - 0.5) * size,
        y: vent.y,
        r0,
        r: r0,
        depth0: depthAt(p, vent.y, world),
        vx: 0,
        vy: 0,
        phase: vent.phase + rng() * TAU,
        life: 0,
        sparkle: rng(),
      });
    }

    /**
     * A bubble is not a ball with gravity turned round.
     *
     * Above about a millimetre and a half across, a rising bubble sheds
     * vortices alternately off one side and then the other, and the reaction
     * pushes it into a zigzag or a slow helix — which is why a stream of them
     * from one crack arrives at the surface spread over a metre. Bigger bubbles
     * shed more slowly, so the zigzag gets wider and lazier with size, and that
     * relationship is most of what makes a column of them read as a column of
     * *bubbles* rather than as rising dots.
     */
    const drag = 6;
    for (let i = state.bubbles.length - 1; i >= 0; i--) {
      const b = state.bubbles[i];
      b.life += dt;

      // Swelling: Boyle's law on the absolute pressure, which is one atmosphere
      // plus the water above. Radius goes as the cube root of the volume.
      const metres = depthAt(p, b.y, world);
      const ratio = (ATMOSPHERE_IN_METRES + b.depth0) / (ATMOSPHERE_IN_METRES + metres);
      b.r = b.r0 * (1 + (Math.cbrt(Math.max(0.05, ratio)) - 1) * p.expand);

      // Terminal velocity goes as the square root of the radius in the
      // large-bubble limit, so the big ones genuinely outrun the small ones.
      const terminal = p.rise * Math.sqrt(b.r / Math.max(0.5, p.size));
      const omega = 6.5 / Math.sqrt(Math.max(0.4, b.r / Math.max(0.5, p.size)));
      const push = p.wobble * b.r * omega * omega * 0.16;

      b.vx += (Math.sin(b.phase + b.life * omega) * push - b.vx * drag) * dt;
      b.vy += (-terminal * drag - b.vy * drag) * dt;

      b.x += b.vx * dt;
      b.y += b.vy * dt;

      /**
       * The house is in the way, and a bubble that meets a sill does not
       * bounce off it — it presses against the underside and creeps along it
       * to the nearer end, then carries on up past the edge.
       *
       * The creep has to be put in. A restitution near zero and the zigzag
       * alone were supposed to slide it out, but the zigzag is symmetric, so
       * under a level sill a bubble went nowhere: every one released below a
       * window gathered at the same spot under it and, drawn additively,
       * the pile burned into a white ball. Under a real sill the slightest
       * tilt decides which way they go and they run out along it quickly;
       * here the nearer end decides, at a pace that drag holds to most of
       * the rise speed, so a sill holds a short string of them rather than
       * a crowd.
       */
      for (const o of obstacles) {
        const { bbox: ob } = o;
        if (
          b.x < ob.x - b.r
          || b.x > ob.x + ob.w + b.r
          || b.y < ob.y - b.r
          || b.y > ob.y + ob.h + b.r
        ) continue;
        const wasX = b.x;
        const wasY = b.y;
        deflect(o.points, b, b.r, 0.05, false);
        if (b.x !== wasX || b.y !== wasY) {
          const toward = b.x < ob.x + ob.w / 2 ? -1 : 1;
          b.vx += toward * p.rise * 0.8 * drag * dt;
        }
      }

      // Gone at the surface, or off the top of what we were given.
      if (b.y + b.r < top || b.life > 60) state.bubbles.splice(i, 1);
    }

    // A hard ceiling on the population, because `rate` times a long catch-up is
    // otherwise unbounded and a projector tab opened at midnight would spend a
    // frame allocating an hour of bubbles it is about to throw away.
    if (state.bubbles.length > 900) state.bubbles.splice(0, state.bubbles.length - 900);
  },
  draw({ g, p, stable, shape, state, world }) {
    if (!state.bubbles?.length || p.level <= 0) return;

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';

    const top = Math.max(shape.bbox.y, surfaceY(p, world));

    for (const b of state.bubbles) {
      const metres = depthAt(p, b.y, world);
      /**
       * The tint, quantised to a third of a metre of water (the bubble's
       * light only crosses a third of its depth) so a few dozen sprites cover
       * every depth, and taken from `stable`: the sprites are a cache, and a
       * murkiness bound to an LFO would otherwise bake a ladder a frame.
       */
      const colour = waterAbsorb(stable.color, Math.round(metres) * 0.35, stable.turbidity);
      // Fades in off the vent and out at the surface, so nothing appears or
      // vanishes on a frame boundary.
      const fade = clamp(b.life * 4, 0, 1)
        * clamp((b.y - top) / Math.max(1, world.h * 0.06), 0, 1);
      const alpha = clamp(0.9 * fade * p.level, 0, 1);
      if (alpha <= 0.004 || b.r < 0.4) continue;

      /**
       * Bigger bubbles are not round.
       *
       * Below a couple of millimetres surface tension holds a bubble to a
       * sphere; above it the pressure of the water it is shouldering aside
       * flattens it into an oblate spheroid, wider than tall, and it rocks
       * and wobbles as it sheds the vortices that make it zigzag. So the
       * aspect follows the size, and wobbles on the same phase as the zigzag.
       */
      const big = clamp((b.r - 5) / 18, 0, 1);
      const squash = 1 - big * (0.22 + 0.07 * Math.sin(b.phase + b.life * 9));
      const w = b.r * 2 * (1 + big * 0.12);
      const h = b.r * 2 * squash;
      g.globalAlpha = alpha;
      g.drawImage(bubbleSprite(colour, w), b.x - w / 2, b.y - h / 2, w, h);
    }
    g.globalAlpha = 1;

    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * Kelp
 * ------------------------------------------------------------------ */

/** Nodes up a frond. Enough for a smooth curve, few enough to be free. */
const KELP_NODES = 14;

/** Points down each side of one blade, and the scratch its outline is gathered in. */
const BLADE_STEPS = 6;
const bladeX = new Float64Array(BLADE_STEPS * 2 + 2);
const bladeY = new Float64Array(BLADE_STEPS * 2 + 2);
/** Per node of the frond being drawn: which side its blade is on (0 for none), its size and ruffle. */
const leafSide = new Int8Array(KELP_NODES + 1);
const leafSize = new Float64Array(KELP_NODES + 1);
const leafRipple = new Float64Array(KELP_NODES + 1);

const kelp = {
  id: 'kelp',
  name: 'Kelp',
  category: 'underwater',
  scope: 'shape',
  description:
    'Weed rooted along the bottom edge of the shape, swaying on the same swell as everything else. The motion dies off exponentially with depth, which is why the tips thrash and the holdfast barely stirs.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#3f7d4a' },
    { key: 'tip', type: 'color', label: 'Tip', default: '#a8d86a' },
    { key: 'fronds', type: 'range', label: 'Fronds', default: 9, min: 1, max: 40, step: 1 },
    { key: 'height', type: 'range', label: 'Height', default: 0.62, min: 0.05, max: 1.4, step: 0.01 },
    { key: 'thickness', type: 'range', label: 'Thickness', default: 7, min: 1, max: 40, step: 0.5 },
    { key: 'blades', type: 'range', label: 'Blades', default: 1, min: 0, max: 2, step: 0.01 },
    { key: 'sway', type: 'range', label: 'Sway', default: 0.35, min: 0, max: 2, step: 0.01 },
    { key: 'current', type: 'range', label: 'Current', default: 0.35, min: 0, max: 2, step: 0.01 },
    { key: 'wavelength', type: 'range', label: 'Wavelength (m)', default: 9, min: 0.5, max: 40, step: 0.1 },
    { key: 'bladders', type: 'range', label: 'Floats', default: 0.6, min: 0, max: 1, step: 0.01 },
    { key: 'level', type: 'range', label: 'Brightness', default: 1, min: 0, max: 3, step: 0.05 },
    ...SURFACE_PARAMS,
  ],
  draw({ g, p, shape, t, world }) {
    const { bbox } = shape;
    if (bbox.w <= 2 || bbox.h <= 2 || p.level <= 0) return;

    const count = Math.max(1, Math.round(p.fronds));
    const metresPerPixel = (p.metres || 14) / Math.max(1, world.h);
    const k = TAU / Math.max(0.2, p.wavelength);
    const omega = Math.sqrt(G * k);

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';

    const nx = new Array(KELP_NODES + 1);
    const ny = new Array(KELP_NODES + 1);

    for (let f = 0; f < count; f++) {
      const rng = makeRng(`kelp:${shape.id}:${f}`);
      const jitter = rng();
      const rootX = bbox.x + bbox.w * ((f + 0.5) / count + (jitter - 0.5) * (0.9 / count));
      const rootY = bbox.y + bbox.h * (0.97 + (rng() - 0.5) * 0.06);
      const height = bbox.h * p.height * (0.65 + rng() * 0.7);
      const width = p.thickness * (0.6 + rng() * 0.8);
      const lean = (rng() - 0.5) * 0.35;
      // Sway is a fraction of the plant's own length, not of the frame: a
      // frond that lays right over is doing something a frond can do, and one
      // whose tip travels a third of the wall is not.
      const swayPx = p.sway * height * 0.5;

      /**
       * The whole of the movement, and the only part of this effect that is
       * physics rather than drawing.
       *
       * A deep-water wave does not push the water along, it rolls it in place:
       * every particle goes round a circle, and the circles get smaller with
       * depth by exactly e^(−kz) — a factor of e for every wavelength divided
       * by 2π. Half a wavelength down there is essentially nothing left. That
       * is why kelp is a whip near the surface and a post at the seabed, and it
       * is the reason a plant drawn with a uniform sine wave up its length —
       * which is what everyone draws — reads as a flag rather than as weed.
       *
       * Normalised against the tip so that `Sway` stays a distance in world
       * pixels whatever depth the surface has been set to. The exponential
       * shapes the frond; the slider says how far it goes.
       */
      const tipDepth = depthAt(p, rootY - height, world);
      const tipDecay = Math.max(1e-4, orbitalDecay(tipDepth, p.wavelength));
      const rootMetresX = rootX * metresPerPixel;

      /**
       * The current, which is why a whole frond is alive and not only its tip.
       *
       * The orbital term above is right and on its own it draws a plant whose
       * bottom two thirds are a post — half a wavelength down there is nothing
       * left of a wave. But a wave is not the only thing moving. A tidal stream
       * is near enough uniform over the few metres a house is tall, and it is
       * what lays a kelp bed over one way and lets it back up again over the
       * next quarter of an hour. So: no depth term at all, slow, and tapered
       * only by the holdfast.
       */
      const drift = p.current * height * 0.3
        * Math.sin(t * 0.21 + jitter * 5.3 + rootMetresX * 0.05);
      const swell = omega * t - k * rootMetresX + jitter * 2.4;

      for (let i = 0; i <= KELP_NODES; i++) {
        const u = i / KELP_NODES;
        const y = rootY - height * u;
        const z = depthAt(p, y, world);
        const decay = orbitalDecay(z, p.wavelength) / tipDecay;
        // Anchored at the holdfast: the exponential alone still leaves a base
        // that slides, and a plant that slides is a plant that is not rooted.
        const anchored = u * u * (3 - 2 * u);
        const offset = swayPx * decay * anchored * (Math.sin(swell) + 0.35 * Math.sin(swell * 2.1 + 1.1));
        nx[i] = rootX + offset + (lean * height + drift) * anchored;
        ny[i] = y;
      }

      const nearColour = waterAbsorb(p.color, depthAt(p, rootY, world), p.turbidity);
      const tipColour = waterAbsorb(p.tip, tipDepth, p.turbidity);
      const grad = g.createLinearGradient(rootX, rootY, nx[KELP_NODES], ny[KELP_NODES]);
      grad.addColorStop(0, rgba(nearColour, clamp(0.75 * p.level, 0, 1)));
      grad.addColorStop(1, rgba(tipColour, clamp(0.95 * p.level, 0, 1)));

      /**
       * Which way the water is moving past the frond, -1..1: the rate of
       * change of the sway, which is the same sign all the way up a frond
       * because the whole of it is in the same phase of the wave. Blades
       * stream with it, so the frond is visibly being moved by something
       * rather than waving on its own.
       */
      const stream = (Math.cos(swell) + 0.735 * Math.cos(swell * 2.1 + 1.1)) / 1.735 * Math.min(1, p.sway * 2);

      /**
       * The blades, first, so the stipe is drawn over their roots.
       *
       * A giant kelp frond is a cord with a blade hanging off it every hand's
       * width or so, each on a small gas bladder that holds it up: long,
       * narrow and ruffled along both edges, leaving the stipe at a shallow
       * angle and curving back up along it, because it floats. Not every node
       * has one and they do not strictly alternate — the old regular
       * left-right leaves read as an ear of wheat, which is a picture of a
       * plant that has never been in water. Each blade is its own length,
       * swings out with the water passing it, and the ruffle along its edges
       * moves, which is most of what makes weed look wet.
       */
      if (p.blades > 0 || p.bladders > 0) {
        // Which nodes carry a blade, which side, how big — drawn from the
        // frond's own generator so they are the same every frame.
        let side = rng() < 0.5 ? 1 : -1;
        for (let i = 2; i < KELP_NODES; i++) {
          const here = rng();
          leafSize[i] = rng();
          leafRipple[i] = rng() * TAU;
          // Mostly alternating, sometimes not; and some nodes bare.
          side = here < 0.2 ? side : -side;
          leafSide[i] = here > 0.82 ? 0 : side;
        }

        /**
         * All of a frond's blades are one path and one fill, and so are all
         * of its bladders. A fill costs about the same whatever is in it, and
         * the blades of one frond overlapping is the same weed seen through
         * itself, not two lights adding up — so one fill is both cheaper and
         * more right. Every outline goes round the same way relative to its
         * own blade, so where two overlap the non-zero rule fills them once
         * rather than cutting a hole.
         */
        g.fillStyle = grad;
        g.globalAlpha = 0.72;
        g.beginPath();
        for (let pass = 0; pass < 2; pass++) {
          if (pass === 1) {
            if (p.blades > 0) g.fill();
            g.globalAlpha = 1;
            g.fillStyle = rgba(tipColour, clamp(0.5 * p.level, 0, 1));
            g.beginPath();
          }
          for (let i = 2; i < KELP_NODES; i++) {
            const leaf = leafSide[i];
            if (!leaf) continue;
            const u = i / KELP_NODES;
            const size = leafSize[i];
            let tx = nx[i + 1] - nx[i - 1];
            let ty = ny[i + 1] - ny[i - 1];
            const tl = Math.hypot(tx, ty) || 1;
            tx /= tl;
            ty /= tl;
            // The normal on this blade's side of the stipe.
            const qx = -ty * leaf;
            const qy = tx * leaf;
            const swing = 0.5 + stream * leaf * 0.32;

            if (pass === 0) {
              if (!(p.blades > 0)) break;
              /**
               * Two and a half to five node spacings long, so neighbouring
               * blades overlap into a mane instead of standing apart like the
               * teeth of a comb; and a ribbon, seven or eight times as long as
               * it is wide, which is the proportion that says kelp rather
               * than corn. Down the midrib it turns back towards the stipe,
               * because it floats.
               */
              const length = (height / KELP_NODES) * p.blades * (2.4 + 2.4 * size) * (0.7 + 0.45 * u);
              const breadth = Math.max(width * 1.1, length * 0.135);
              let mx = nx[i];
              let my = ny[i];
              bladeX[0] = mx;
              bladeY[0] = my;
              for (let j = 1; j <= BLADE_STEPS; j++) {
                const sAt = j / BLADE_STEPS;
                const turn = swing * (1 - 0.6 * sAt);
                const dx = tx * Math.cos(turn) + qx * Math.sin(turn);
                const dy = ty * Math.cos(turn) + qy * Math.sin(turn);
                mx += (dx * length) / BLADE_STEPS;
                my += (dy * length) / BLADE_STEPS;
                // Lanceolate — widest a third of the way out — and ruffled.
                const w = breadth * 0.5 * Math.sin(Math.PI * sAt ** 0.7)
                  * (1 + 0.32 * Math.sin(sAt * 16 + leafRipple[i] + t * 1.7));
                bladeX[j] = mx - dy * w;
                bladeY[j] = my + dx * w;
                bladeX[BLADE_STEPS * 2 + 1 - j] = mx + dy * w;
                bladeY[BLADE_STEPS * 2 + 1 - j] = my - dx * w;
              }
              bladeX[BLADE_STEPS * 2 + 1] = nx[i];
              bladeY[BLADE_STEPS * 2 + 1] = ny[i];
              curveThrough(g, bladeX, bladeY, BLADE_STEPS * 2 + 2, { move: true });
              g.closePath();
            } else if (p.bladders > 0) {
              // Its gas bladder, at the root of the blade: what holds a real
              // frond up, and the one detail that makes weed look like weed
              // rather than like rope.
              const r = width * 0.42 * p.bladders * (0.75 + 0.5 * size) * (0.7 + 0.5 * u);
              const along = Math.atan2(ty * Math.cos(swing) + qy * Math.sin(swing), tx * Math.cos(swing) + qx * Math.sin(swing));
              const bx = nx[i] + Math.cos(along) * r;
              const by = ny[i] + Math.sin(along) * r;
              g.moveTo(bx + Math.cos(along) * r * 1.5, by + Math.sin(along) * r * 1.5);
              g.ellipse(bx, by, r * 1.5, r, along, 0, TAU);
            }
          }
        }
        if (p.bladders > 0) g.fill();
      }

      g.strokeStyle = grad;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.lineWidth = width;
      // Through the nodes rather than between them: fourteen straight pieces
      // is fourteen straight pieces once the frond is a metre and a half tall
      // on a wall. See `curveThrough`.
      g.beginPath();
      curveThrough(g, nx, ny, KELP_NODES + 1, { move: true });
      g.stroke();
    }

    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * Jellyfish
 * ------------------------------------------------------------------ */

/**
 * The fraction of a pulse spent contracting.
 *
 * A jellyfish's stroke is strongly asymmetric: the bell squeezes shut in a
 * quarter of the cycle and refills over the other three. All of the thrust is
 * in the squeeze, which is why one does not swim smoothly — it surges, coasts,
 * sinks back a little, and surges again. Make the two halves equal and you get
 * a jellyfish-shaped balloon bobbing on a spring.
 */
const SQUEEZE = 0.28;

/**
 * Every strand's points, gathered before any of them is traced.
 *
 * Module-level and reused, because this is inside a loop over every strand of
 * every jellyfish on screen and fresh arrays per strand would be a few
 * hundred allocations a frame for nothing. All of one animal's strands are
 * gathered at once, because each is traced twice — a glow and a core — and
 * computing a strand's history twice is the expensive half. Sized for the
 * thirty-two strands the slider allows at thirteen points each.
 */
const strandX = new Float64Array(32 * 13);
const strandY = new Float64Array(32 * 13);

/**
 * Trace the `count` gathered points from `start` as one smooth strand — the
 * same curve `curveThrough` makes, read from an offset into the scratch so
 * that no strand needs an array of its own.
 */
function traceStrand(g, start, count) {
  g.moveTo(strandX[start], strandY[start]);
  for (let i = 1; i < count - 1; i++) {
    const a = start + i;
    g.quadraticCurveTo(strandX[a], strandY[a], (strandX[a] + strandX[a + 1]) / 2, (strandY[a] + strandY[a + 1]) / 2);
  }
  if (count > 1) g.lineTo(strandX[start + count - 1], strandY[start + count - 1]);
}

/**
 * How far back in time strand `s` reaches, in seconds.
 *
 * A medusa carries two quite different appendages: four thick oral arms under
 * the middle of the bell, and a fringe of fine tentacles round its margin. The
 * arms are shorter and stiffer, so they lag less; the tentacles stream. Every
 * third strand is an arm, and the small variation on the rest is what stops the
 * fringe reading as a comb.
 *
 * Exported because it is the number the tentacles' whole shape is a
 * consequence of, and a test that has to guess it is testing its own guess.
 */
export function strandLag(s, trail) {
  const isArm = s % 3 === 0;
  return trail * (isArm ? 0.55 : 1) * (0.7 + ((s * 37) % 11) / 18);
}

/** How contracted the bell is, 0 relaxed to 1 shut, over one cycle's phase. */
export function contraction(phase) {
  const u = phase < SQUEEZE ? phase / SQUEEZE : (phase - SQUEEZE) / (1 - SQUEEZE);
  return phase < SQUEEZE ? smoothstep(0, 1, u) : 1 - smoothstep(0, 1, u);
}

/**
 * The mean of `contraction` over a whole cycle.
 *
 * Both halves are smoothsteps, whose integral is exactly half their width, so
 * the mean is a half regardless of where `SQUEEZE` is set. Subtracting it makes
 * the surge term zero-mean, which is what keeps the pulse from quietly adding a
 * drift of its own on top of the one the Rise slider asks for.
 */
const CONTRACTION_MEAN = 0.5;

/**
 * How far down a strand a jet gets before drag has taken most of it out, as a
 * fraction of the strand's length.
 *
 * Just under one, so the far tip keeps about a third of the pulse. Set it much
 * shorter and the tentacles hang like string off an animal that is visibly
 * swimming; leave the decay out altogether and every point on the strand
 * answers the bell's jet in full, which is the thing that used to throw them
 * up through the bell.
 */
const WASH_LENGTH = 0.95;

/**
 * Where a bell is at time `t`. Analytic, on purpose.
 *
 * Nothing here integrates. The position is a closed-form function of show time,
 * which buys two things that are worth more than the small amount of algebra:
 * a projector tab opened at eleven o'clock draws the jellyfish exactly where
 * every other tab has it with no catching up to do, and — because it can be
 * evaluated at times other than now — the tentacles can be drawn as *where the
 * bell was*, which is what a trailing tentacle actually is.
 */
export function bellAt(t, j, p, world, bbox) {
  const period = Math.max(0.4, p.pulse) * j.periodScale;
  const phase = ((t / period) + j.phase) % 1;
  const c = contraction(phase < 0 ? phase + 1 : phase);
  const surge = (c - CONTRACTION_MEAN) * p.size * j.scale * p.thrust;

  /**
   * Two positions, and the second one is not decoration.
   *
   * `x, y` is where to draw it, which wraps: a jellyfish that leaves the frame
   * and never comes back leaves an evening with fewer of them than it started
   * with. `cx, cy` is the same motion *unwrapped* — continuous in `t`, with no
   * jump at the edge of the frame.
   *
   * The tentacles need the second, because what they want is not "where was
   * the bell" but "how far has the bell moved since". Take the difference of
   * the wrapped positions and a bell that crossed the edge a moment ago drags
   * its tentacles right across the house; take the difference of these and it
   * does the right thing without the drawing code knowing a wrap happened.
   */
  const spanX = bbox.w + p.size * 4;
  const spanY = bbox.h + p.size * 5;
  const travelX = j.x0 + t * p.drift * j.driftScale;
  const travelY = j.y0 + t * p.rise;

  return {
    x: bbox.x - p.size * 2 + (((travelX % spanX) + spanX) % spanX),
    y: bbox.y + bbox.h + p.size * 2.5 - (((travelY % spanY) + spanY) % spanY) - surge,
    cx: travelX,
    cy: -travelY - surge,
    /**
     * The same vertical motion with the pulse taken back out: where the animal
     * has got to through the water, as opposed to where it is in its stroke.
     *
     * The tentacles want this one. A strand hangs off the bell's *path*; the
     * jet is a thing the bell does on top of that path, and something the
     * strand only partly feels — see the drawing code.
     */
    ty: -travelY,
    surge,
    c,
    phase,
  };
}

const jellyfish = {
  id: 'jellyfish',
  name: 'Jellyfish',
  category: 'underwater',
  scope: 'shape',
  description:
    'Bells pulsing up the wall, surging on the squeeze and coasting between, trailing tentacles that follow where the bell has been rather than hanging off it.',
  params: [
    { key: 'color', type: 'color', label: 'Bell', default: '#9fd9ff' },
    { key: 'rim', type: 'color', label: 'Glow', default: '#ff7ad9' },
    { key: 'count', type: 'range', label: 'Jellyfish', default: 6, min: 1, max: 24, step: 1 },
    { key: 'size', type: 'range', label: 'Bell size', default: 70, min: 10, max: 320, step: 1 },
    { key: 'pulse', type: 'range', label: 'Pulse (s)', default: 2.4, min: 0.4, max: 10, step: 0.05 },
    { key: 'thrust', type: 'range', label: 'Surge', default: 1, min: 0, max: 3, step: 0.05 },
    { key: 'rise', type: 'range', label: 'Rise', default: 26, min: -120, max: 200, step: 1 },
    { key: 'drift', type: 'range', label: 'Current', default: 14, min: -200, max: 200, step: 1 },
    { key: 'tentacles', type: 'range', label: 'Tentacles', default: 12, min: 0, max: 32, step: 1 },
    { key: 'trail', type: 'range', label: 'Tentacle length (s)', default: 1.6, min: 0.1, max: 6, step: 0.05 },
    { key: 'glow', type: 'range', label: 'Bioluminescence', default: 1, min: 0, max: 3, step: 0.05 },
    { key: 'level', type: 'range', label: 'Brightness', default: 1, min: 0, max: 3, step: 0.05 },
    ...SURFACE_PARAMS,
  ],
  draw({ g, p, shape, t, world }) {
    const { bbox } = shape;
    if (bbox.w <= 2 || bbox.h <= 2 || p.level <= 0) return;

    const count = Math.max(1, Math.round(p.count));
    const segments = 12;

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';
    g.lineJoin = 'round';

    for (let i = 0; i < count; i++) {
      const rng = makeRng(`jellyfish:${shape.id}:${i}`);
      const j = {
        x0: rng() * (bbox.w + p.size * 4),
        y0: rng() * (bbox.h + p.size * 5),
        phase: rng(),
        periodScale: 0.8 + rng() * 0.45,
        driftScale: 0.7 + rng() * 0.7,
        scale: 0.65 + rng() * 0.7,
        hue: rng(),
      };

      const now = bellAt(t, j, p, world, bbox);
      const R = p.size * j.scale * 0.5;
      /**
       * How fast a strand hangs away from the bell, in pixels per second of
       * trail. Proportional to the animal, or a big jellyfish comes out with
       * the stubby tentacles of a small one drawn at the wrong scale.
       */
      const hang = 60 + R * 1.7;
      // Cull on the bell *and its tentacles* — the strands reach a long way
      // below it, and a bell just off the top still has them in shot.
      if (now.y + R * 6 + p.trail * hang < bbox.y || now.y - R * 2 > bbox.y + bbox.h) continue;

      const metres = depthAt(p, now.y, world);
      const bell = waterAbsorb(mixHex(p.color, p.rim, j.hue * 0.3), metres, p.turbidity);
      /**
       * The glow is *not* absorbed by the depth.
       *
       * Everything else in this set is lit from the surface, so the further
       * down it is the less red is left in the light that reaches it. A
       * bioluminescent animal makes its own, right there, and the water between
       * it and you is a few centimetres. Attenuating it as well would be the
       * physically wrong kind of consistency, and it would put out the one
       * thing in the picture that is supposed to survive at depth.
       */
      const rimColour = p.rim;

      // Contracted: narrower and taller. Relaxed: a flatter dome.
      const bellW = R * (1.18 - 0.34 * now.c);
      const bellH = R * (0.62 + 0.36 * now.c);
      const level = p.level;

      /**
       * The margin lights up on the recoil, not on the squeeze.
       *
       * Bioluminescence in a medusa is a startle response — it fires *after*
       * something happens, and the flash outlasts the movement that set it off.
       * Peaking it just past the end of the contraction is a small thing that
       * makes the animal look alive rather than lit.
       */
      const flash = Math.max(0, 1 - Math.abs(now.phase - SQUEEZE * 1.4) * 4);
      const glowing = p.glow * (0.55 + 0.45 * flash);

      /**
       * The tentacles, drawn out of the bell's own past.
       *
       * A tentacle does not point anywhere in particular; it is dragged, so the
       * shape it takes is the path the bell has just travelled, delayed a
       * little more the further down it you look. Since `bellAt` is a function
       * of time rather than an integration, that path is simply available —
       * evaluate it at `t - lag` and the tentacles curl through the surges by
       * themselves, lag behind on the fast part of the stroke, and gather back
       * under the bell as it coasts. None of which is drawn; all of it falls
       * out of the delay.
       *
       * Every strand is gathered first and traced twice: a wide faint pass
       * that the bloom turns into the haze of a living thread, and a fine
       * bright one inside it. A thread a couple of pixels wide at a quarter
       * of the brightness of the bell is what made the tentacles vanish at
       * any distance — real ones are the length of a person and catch the
       * light along all of it.
       */
      const strands = Math.round(p.tentacles);
      if (strands > 0) {
        const anchorY = now.y + bellH * 0.55;
        let n = 0;
        for (let s = 0; s < strands; s++) {
          const across = strands > 1 ? (s / (strands - 1) - 0.5) * 2 : 0;
          const anchorX = across * bellW * 0.82;
          const isArm = s % 3 === 0;
          const span = strandLag(s, p.trail);
          // Gathered first, then traced as a curve: a strand is a hanging
          // thing and a chain of chords looks like a chain. See `curveThrough`.
          strandX[n] = now.x + anchorX;
          strandY[n++] = anchorY;
          for (let k = 1; k <= segments; k++) {
            const u = k / segments;
            const past = bellAt(t - span * u, j, p, world, bbox);
            // Where the bell was, expressed as how far it has come since —
            // see `cx, cy` in `bellAt` for why it is not simply `past.x`.
            const drop = u * span * hang * (isArm ? 0.5 : 1);
            const splay = anchorX * (1 - u * 0.45) + Math.sin(u * 6 + s) * R * 0.12 * u;
            /**
             * The pulse reaches a strand, but not all of it and not forever.
             *
             * The delay alone gets the *phase* right — a point that far down
             * is feeling a jet the bell made that long ago — but not the
             * amplitude, and using the delayed position wholesale hands every
             * point on the strand the bell's full stroke. On the refill,
             * when the bell is sinking back, that lifts the tentacles up
             * through the animal, which is the one thing a tentacle never
             * does.
             *
             * So two corrections, both of them things a real strand does.
             * Drag damps the jet out along the length, hence `wash`. And the
             * strand is inextensible: no point on it can be flung further
             * than the distance it hangs, hence the clamp — which is also
             * what guarantees the strand stays below the bell it hangs from,
             * because `drop` is exactly the amount it is below by.
             */
            const wash = Math.exp(-u / WASH_LENGTH);
            const swing = clamp((now.surge - past.surge) * wash, -drop, drop);
            strandX[n] = now.x - (now.cx - past.cx) + splay;
            strandY[n++] = anchorY - (now.ty - past.ty) + drop + swing;
          }
        }
        /**
         * Brightest where they leave the bell and gone by the tips, because a
         * thread thins and the light along it is scattered away — one
         * gradient down the whole fringe, shared by every strand of a kind.
         */
        const per = segments + 1;
        const reach = anchorY + p.trail * hang * 1.2;
        const fringe = g.createLinearGradient(0, anchorY, 0, reach);
        fringe.addColorStop(0, rgba(rimColour, 1));
        fringe.addColorStop(0.55, rgba(rimColour, 0.55));
        fringe.addColorStop(1, rgba(rimColour, 0));
        const lobes = g.createLinearGradient(0, anchorY, 0, anchorY + p.trail * hang * 0.6);
        lobes.addColorStop(0, rgba(bell, 1));
        lobes.addColorStop(1, rgba(bell, 0.1));
        for (const [width, alpha] of [[0.12, 0.1], [0.035, 0.55]]) {
          for (let s = 0; s < strands; s++) {
            const isArm = s % 3 === 0;
            g.strokeStyle = isArm ? lobes : fringe;
            g.globalAlpha = clamp(alpha * (isArm ? 1.1 : 1) * level, 0, 1);
            g.lineWidth = Math.max(0.6, R * width * (isArm ? 1.6 : 1));
            g.beginPath();
            traceStrand(g, s * per, per);
            g.stroke();
          }
        }
        g.globalAlpha = 1;
      }

      /**
       * The oral arms: four frilled lobes hanging from the middle of the bell.
       *
       * They are the other half of the silhouette everybody knows — the
       * tentacles are a fringe, the arms are a skirt — and what makes them
       * read is the frill: a ruffled edge, not a smooth ribbon. Each is a
       * short trail of the bell's past like a tentacle, but stiffer, each its
       * own length, tapering to a point, with a ripple running down both
       * edges out of step with each other.
       */
      for (let a = 0; a < 4; a++) {
        const side = (a - 1.5) / 1.5;
        const armLength = R * (1.15 + 0.5 * ((a * 0.618 + j.hue) % 1));
        let m = 0;
        for (let k = 0; k <= 8; k++) {
          const u = k / 8;
          const past = bellAt(t - p.trail * 0.35 * u, j, p, world, bbox);
          const sway = Math.sin(t * 1.3 + a * 1.9 + u * 3) * R * 0.1 * u;
          strandX[m] = now.x - (now.cx - past.cx) + side * bellW * (0.12 + 0.3 * u) + sway;
          strandY[m++] = now.y + bellH * 0.3 + u * armLength
            - clamp((now.ty - past.ty) * 0.5, -u * armLength * 0.4, u * armLength * 0.4);
        }
        // Both edges, rippled out of phase with each other: the frill.
        const ribbon = R * (0.13 - 0.04 * Math.abs(side));
        g.fillStyle = rgba(mixHex(bell, rimColour, 0.3), clamp(0.16 * level, 0, 1));
        g.strokeStyle = rgba(mixHex(bell, rimColour, 0.45), clamp(0.32 * level, 0, 1));
        g.lineWidth = Math.max(0.6, R * 0.022);
        g.beginPath();
        for (let k = 0; k <= 8; k++) {
          const taper = 1 - k / 8;
          const ruffle = 1 + 0.55 * Math.sin(k * 2.3 + t * 2.2 + a);
          const x = strandX[k] - ribbon * ruffle * (0.25 + taper);
          if (k === 0) g.moveTo(x, strandY[k]);
          else g.lineTo(x, strandY[k]);
        }
        for (let k = 8; k >= 0; k--) {
          const taper = 1 - k / 8;
          const ruffle = 1 + 0.55 * Math.sin(k * 2.3 + t * 2.2 + a + 2.4);
          g.lineTo(strandX[k] + ribbon * ruffle * (0.25 + taper), strandY[k]);
        }
        g.closePath();
        g.fill();
        g.stroke();
      }

      /**
       * The bell: a dome with the margin curled under, which is the
       * silhouette everybody recognises and the thing a plain half-ellipse
       * misses.
       *
       * Lit the way jelly is lit. Most of the bell is clear, so the body is a
       * faint wash brightest near the crown; but seen through its own edge the
       * light crosses far more of it, so the outline glows — the rim lighting
       * that lets you see a moon jelly in murky water at all — and it is that
       * glowing edge, not the fill, that carries the shape.
       */
      const crown = now.y - bellH * 1.42;
      const dome = g.createRadialGradient(now.x, now.y - bellH * 0.75, 0, now.x, now.y - bellH * 0.4, bellW * 1.05);
      dome.addColorStop(0, rgba(mixHex(bell, '#ffffff', 0.4), clamp(0.42 * level, 0, 1)));
      dome.addColorStop(0.55, rgba(bell, clamp(0.24 * level, 0, 1)));
      dome.addColorStop(1, rgba(bell, clamp(0.1 * level, 0, 1)));
      g.fillStyle = dome;
      g.beginPath();
      g.moveTo(now.x - bellW, now.y);
      g.bezierCurveTo(now.x - bellW, now.y - bellH * 1.9, now.x + bellW, now.y - bellH * 1.9, now.x + bellW, now.y);
      g.quadraticCurveTo(now.x + bellW * 0.45, now.y + bellH * 0.7, now.x, now.y + bellH * 0.42);
      g.quadraticCurveTo(now.x - bellW * 0.45, now.y + bellH * 0.7, now.x - bellW, now.y);
      g.closePath();
      g.fill();

      // The edge, in two passes: a soft glow and a bright line.
      for (const [width, alpha] of [[0.14, 0.18], [0.045, 0.7]]) {
        g.strokeStyle = rgba(mixHex(bell, '#ffffff', 0.25), clamp(alpha * level, 0, 1));
        g.lineWidth = Math.max(0.8, R * width);
        g.beginPath();
        g.moveTo(now.x - bellW, now.y);
        g.bezierCurveTo(now.x - bellW, now.y - bellH * 1.9, now.x + bellW, now.y - bellH * 1.9, now.x + bellW, now.y);
        g.stroke();
      }

      /**
       * Radial canals, running from the crown to the margin.
       *
       * Eight of them round a real bell; seen side-on, the five on the near
       * face. Fine and faint, but they are what make the dome a structure
       * rather than a blob.
       */
      g.strokeStyle = rgba(mixHex(bell, '#ffffff', 0.3), clamp(0.3 * level, 0, 1));
      g.lineWidth = Math.max(0.6, R * 0.025);
      g.beginPath();
      for (let c = -2; c <= 2; c++) {
        const off = (c / 2.4) * bellW * 0.85;
        g.moveTo(now.x + off * 0.18, crown + bellH * 0.12);
        g.quadraticCurveTo(now.x + off * 0.8, now.y - bellH * 0.55, now.x + off, now.y + bellH * 0.1);
      }
      g.stroke();

      /**
       * The gonads: four horseshoes in a cross round the middle of a moon
       * jelly, which seen from the side and a little below merge into one
       * soft, flattened blush of denser tissue in the middle of the bell —
       * the first thing a light through it picks out. Drawn as that blush:
       * outlined, the horseshoes are letters, and drawn as separate lobes the
       * two at the sides are a pair of eyes looking back at you.
       */
      {
        const gy = now.y - bellH * 0.58;
        const blush = g.createRadialGradient(now.x, gy, 0, now.x, gy, bellW * 0.5);
        const ink = mixHex(rimColour, '#ffffff', 0.2);
        const strength = clamp(0.32 * level * (0.6 + 0.4 * p.glow), 0, 1);
        blush.addColorStop(0, rgba(ink, strength));
        blush.addColorStop(0.6, rgba(ink, strength * 0.55));
        blush.addColorStop(1, rgba(ink, 0));
        g.fillStyle = blush;
        g.beginPath();
        g.ellipse(now.x, gy, bellW * 0.5, bellH * 0.28, 0, 0, TAU);
        g.fill();
      }

      if (p.glow > 0) {
        // The margin itself, where the light organs are.
        g.strokeStyle = rgba(rimColour, clamp((0.45 + flash * 0.5) * p.glow * level, 0, 1));
        g.lineWidth = Math.max(0.8, R * 0.08);
        g.beginPath();
        g.moveTo(now.x - bellW, now.y);
        g.quadraticCurveTo(now.x - bellW * 0.45, now.y + bellH * 0.7, now.x, now.y + bellH * 0.42);
        g.quadraticCurveTo(now.x + bellW * 0.45, now.y + bellH * 0.7, now.x + bellW, now.y);
        g.stroke();
        glow(g, now.x, now.y - bellH * 0.35, R * (2 + flash), rimColour,
          clamp((0.14 + flash * 0.25) * glowing * level, 0, 1));
      }
    }

    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * Dolphins
 * ------------------------------------------------------------------ */

/**
 * The Strouhal number, and why a dolphin does not get a "tail speed" slider.
 *
 * St = fA/U — beat frequency times peak-to-peak fluke amplitude, over swimming
 * speed. Measure it across dolphins, sharks, tuna, bats, hummingbirds and
 * moths and it comes out between about 0.2 and 0.4 in every one of them,
 * because that is the band in which a flapping foil sheds its vortices in the
 * arrangement that produces thrust efficiently. It is one of the few numbers
 * in biomechanics that is genuinely universal.
 *
 * So the beat is not a parameter here, it is a *consequence*: pick the speed
 * and the animal's length, and the frequency follows. Which is also the reason
 * a dolphin speeding up looks right — it beats faster, exactly as fast as it
 * has to, and nobody had to tie two sliders together by hand.
 */
const STROUHAL = 0.3;

/**
 * Fluke amplitude as a fraction of body length — peak to peak, tip to tip of
 * the stroke. About a fifth, across the range of animals the number above was
 * measured in.
 */
const FLUKE_AMPLITUDE = 0.2;

/**
 * Porpoising: the vertical motion of one animal, in metres, over its cycle.
 *
 * Leaving the water is not showing off, it is economy. A body swimming at the
 * surface makes waves, and wave drag at the surface runs to several times the
 * drag on the same body a couple of diameters down. Above a threshold speed
 * the cheapest way to breathe is therefore to leave entirely — a ballistic
 * hop, during which the drag is that of air and the propulsion bill is zero —
 * and that is why fast dolphins porpoise and slow ones do not.
 *
 * So the airborne arc here is not a shape chosen to look like a leap; it is
 * `−4H·s(1−s)`, which is what constant gravity gives, with the hang time
 * `2√(2H/g)` that goes with the height. Ask for twice the height and the
 * animal stays up √2 times as long, all by itself.
 *
 * The submerged half is a Hermite whose end slopes are the entry and launch
 * speeds `√(2gH)`, so the vertical velocity is continuous through the surface
 * in both directions — it enters as fast as it left, nose down at the angle it
 * went up at. The `dive` term on top is the only part anybody chose.
 *
 * Returns depth in metres, positive downwards, with `vz` its rate.
 */
export function porpoise(t, p, phase = 0) {
  const height = Math.max(0, p.leap ?? 0);
  const tAir = height > 0 ? 2 * Math.sqrt((2 * height) / G) : 0;
  const tUnder = Math.max(0.05, p.between ?? 2.6);
  const period = tAir + tUnder;
  const q = ((((t / period + phase) % 1) + 1) % 1) * period;

  if (q < tAir) {
    const s = q / tAir;
    return {
      z: -4 * height * s * (1 - s),
      vz: (-4 * height * (1 - 2 * s)) / tAir,
      airborne: true,
      q, period, tAir, tUnder,
    };
  }

  const w = (q - tAir) / tUnder;
  const entry = Math.sqrt(2 * G * height);
  const dive = Math.max(0, p.dive ?? 0);
  const sink = Math.sin(Math.PI * w);
  return {
    z: entry * tUnder * w * (1 - w) + dive * sink * sink,
    vz: entry * (1 - 2 * w) + (dive * Math.PI * Math.sin(TAU * w)) / tUnder,
    airborne: false,
    q, period, tAir, tUnder,
  };
}

/**
 * The girth of a cetacean at `u` along it, nose at 0 and peduncle at 1, as a
 * fraction of its deepest.
 *
 * Fusiform, and widest about two fifths of the way back — the shape that keeps
 * the flow attached the whole length of the body. Widest at the middle, which
 * is the obvious thing to draw, reads as a seal; widest at the shoulder reads
 * as a fish. It does not taper to a point either: the peduncle carries a fifth
 * of the maximum, because there is a spine and a lot of muscle in it, and it
 * is the bit doing the work.
 */
function girth(u) {
  const b = clamp((u - 0.115) / 1.13, 0, 1);
  return Math.pow(Math.sin(Math.PI * Math.pow(b, 0.55)), 1.5);
}

/**
 * The beak, which the girth profile above starts too far back to include.
 *
 * Roughly a tenth of the animal, and near enough parallel-sided rather than
 * tapering to a point — a bottlenose's jaw is a stubby thing with teeth in it,
 * not a bill. It fades out across the same span the head swells over, so the
 * two add to a continuous line instead of pinching in between.
 */
function rostrum(u) {
  return 0.3 * (1 - smoothstep(0.04, 0.22, u));
}

/**
 * The melon: the fatty acoustic lens over the forehead, dorsal side only.
 *
 * It is the reason a dolphin's head is a dome and its jaw is a beak, and
 * leaving it off is most of the difference between a dolphin and a small
 * whale — or, with the beak still on, a fish.
 */
function melon(u) {
  return 0.3 * Math.exp(-(((u - 0.215) / 0.115) ** 2));
}

/**
 * A place for animal `i` of `n`, in 0..1, jittered inside its own band.
 *
 * The point is the *gap*. A free `rng()` per animal is at liberty to land on
 * top of the last one, and at four animals it does so often — which does not
 * read as coincidence, it reads as one animal drawn twice. Giving each its own
 * band and letting it move within `fill` of it keeps a guaranteed `1 − fill`
 * of a band between any two, while still looking placed rather than ruled.
 */
export function stratum(i, n, rng, fill) {
  return (i + (1 - fill) / 2 + rng() * fill) / Math.max(1, n);
}

/**
 * Where animal `i` of a pod of `count` starts, and how it differs from the
 * rest of them.
 *
 * Exported because it is the whole of what makes a pod read as several animals
 * rather than one drawn a few times, and a test that reconstructs it is
 * testing its own copy of it.
 *
 * All three of position, stroke phase and depth are stratified — see
 * `stratum`. Drawn freely they collide, and they did: at the defaults two of
 * the four sat four tenths of a body length apart with their leap phases five
 * thousandths of a cycle apart, which is not two dolphins passing, it is one
 * dolphin with a small offset.
 *
 * `together` then chooses between two arrangements that are *both* well
 * spread: at 1 an echelon a couple of body lengths apart with the leap running
 * down it as a wave, which is what a porpoising pod looks like; at 0, spread
 * across the frame and completely out of phase with one another.
 */
export function podPlacement(i, count, together, spanX, length) {
  const rng = makeRng(`dolphins:pod:${i}`);
  const tight = clamp(together, 0, 1);
  return {
    x0: lerp(
      stratum(i, count, rng, 0.7) * spanX,
      i * length * 2.1 + rng() * length * 0.4,
      tight
    ),
    /**
     * A whole cycle apart when they are strangers, a tenth of one when they
     * are a pod: near enough to surface together, far enough that no two are
     * ever in the same posture.
     */
    phase: (stratum(i, count, rng, 0.6) * lerp(1, 0.12, tight)) % 1,
    scale: 0.78 + rng() * 0.44,
    /** Its own cruising depth in metres, faded in below the surface by `draw`. */
    lane: stratum(i, count, rng, 0.8) * 1.8,
    tint: rng(),
  };
}

/** `v` brought into one span, offset to start at `from`. */
function wrapped(v, span, from) {
  return from + (((v % span) + span) % span);
}

/** Scratch for one body outline. Module-level so `draw` allocates nothing. */
const BODY_SEGMENTS = 22;
const bodyCx = new Float64Array(BODY_SEGMENTS + 1);
const bodyCy = new Float64Array(BODY_SEGMENTS + 1);
const bodyUp = new Float64Array(BODY_SEGMENTS + 1);
const bodyDn = new Float64Array(BODY_SEGMENTS + 1);
/** The silhouette as one run — up the back, down the belly — for `curveThrough`. */
const outlineX = new Float64Array(BODY_SEGMENTS * 2 + 2);
const outlineY = new Float64Array(BODY_SEGMENTS * 2 + 2);

/**
 * A small generator for one splash, reseeded from numbers rather than built
 * from a string key — so a splash is the same droplets in every tab and on
 * every frame it is in the air, and drawing one allocates nothing.
 */
let splashState = 0;

function seedSplash(a, b, c) {
  splashState = (Math.imul(a + 1, 2654435761) ^ Math.imul(b + 7, 2246822519) ^ Math.imul(c + 13, 3266489917)) >>> 0;
}

function splashRand() {
  splashState = (Math.imul(splashState ^ (splashState >>> 15), 2246822519) + 0x9e3779b9) >>> 0;
  return splashState / 4294967296;
}

/**
 * Spray, thrown on real ballistics from a point on the surface.
 *
 * Droplets leave at the speed the animal arrived with, and then they are
 * simply projectiles: the same `g` the leap used, so the water that comes off
 * a big leap hangs in the air longer than the water off a small one without
 * anything being told to.
 *
 * Each droplet is drawn as the streak it makes in a thirtieth of a second
 * rather than as a dot: a dot a pixel or two across is invisible on a house,
 * and what an eye or a camera actually sees of flying water is streaks. They
 * all go into one path, so a splash is one stroke. And under them, where the
 * animal broke the surface, a patch of white water spreading out along it
 * and fading — the part of a splash you can see from across a road.
 */
function splash(g, x, y, age, life, spread, speed, gPx, colour, strength, foam) {
  if (age < 0 || age >= life || strength <= 0) return;
  const fade = 1 - age / life;

  if (foam > 0) {
    const wide = speed * (0.22 + age * 0.9);
    const white = g.createRadialGradient(x, y, 0, x, y, wide);
    white.addColorStop(0, rgba('#ffffff', clamp(fade * fade * strength * foam, 0, 1)));
    white.addColorStop(0.35, rgba(colour, clamp(fade * strength * foam * 0.45, 0, 1)));
    white.addColorStop(1, rgba(colour, 0));
    g.save();
    g.translate(x, y);
    g.scale(1, 0.24);
    g.translate(-x, -y);
    g.fillStyle = white;
    g.beginPath();
    g.arc(x, y, wide, 0, TAU);
    g.fill();
    g.restore();
  }

  g.strokeStyle = rgba(mixHex(colour, '#ffffff', 0.4), clamp(fade * strength * 1.4, 0, 1));
  g.lineWidth = Math.max(1, speed * 0.012);
  g.lineCap = 'round';
  g.beginPath();
  for (let i = 0; i < 18; i++) {
    const a = -Math.PI / 2 + (splashRand() - 0.5) * spread;
    const v = speed * (0.35 + splashRand() * 1.15);
    const vx = Math.cos(a) * v;
    const vy = Math.sin(a) * v + gPx * age;
    const px = x + vx * age;
    const py = y + Math.sin(a) * v * age + 0.5 * gPx * age * age;
    // Below the surface it is water again.
    if (py > y + 2) continue;
    g.moveTo(px, py);
    g.lineTo(px - vx * 0.035, py - vy * 0.035);
  }
  g.stroke();
}

const dolphins = {
  id: 'dolphins',
  name: 'Dolphins',
  category: 'underwater',
  scope: 'shape',
  description:
    'A pod crossing the wall, porpoising through the surface on real ballistics — the hang time is the one that goes with the height — and beating their flukes up and down at whatever rate keeps their Strouhal number where every swimming animal keeps it.',
  params: [
    { key: 'color', type: 'color', label: 'Back', default: '#2b4756' },
    { key: 'belly', type: 'color', label: 'Belly', default: '#eaf6fd' },
    { key: 'count', type: 'range', label: 'Pod', default: 4, min: 1, max: 16, step: 1 },
    /**
     * Length in metres, not pixels, because everything else about this effect
     * already is — the leap, the dive, the depth the colour is read off. A
     * three metre animal in fourteen metres of water is the right size for
     * that water however big the wall is, and the alternative is a slider
     * somebody has to re-find every time the scale of the show changes.
     */
    { key: 'length', type: 'range', label: 'Length (m)', default: 3, min: 0.4, max: 14, step: 0.1 },
    { key: 'speed', type: 'range', label: 'Speed', default: 210, min: -800, max: 800, step: 5 },
    { key: 'leap', type: 'range', label: 'Leap height (m)', default: 1.1, min: 0, max: 6, step: 0.05 },
    { key: 'between', type: 'range', label: 'Seconds under', default: 2.4, min: 0.2, max: 20, step: 0.1 },
    { key: 'dive', type: 'range', label: 'Extra dive (m)', default: 1, min: 0, max: 20, step: 0.1 },
    { key: 'together', type: 'range', label: 'Formation', default: 0.7, min: 0, max: 1, step: 0.01 },
    { key: 'strouhal', type: 'range', label: 'Strouhal number', default: STROUHAL, min: 0.12, max: 0.6, step: 0.005 },
    { key: 'spray', type: 'range', label: 'Spray', default: 1, min: 0, max: 3, step: 0.05 },
    { key: 'level', type: 'range', label: 'Brightness', default: 1, min: 0, max: 3, step: 0.05 },
    ...SURFACE_PARAMS.map((param) =>
      (param.key === 'surface' ? { ...param, default: 0.08 } : param)),
    ANCHOR_PARAM,
  ],
  draw({ g, p, shape, t, world }) {
    const { bbox } = shape;
    if (bbox.w <= 2 || bbox.h <= 2 || p.level <= 0) return;

    const fraction = surfaceFraction(p, shape, world);
    const water = fraction === p.surface ? p : { ...p, surface: fraction };
    const pixelsPerMetre = Math.max(1, world.h) / Math.max(1, p.metres || 14);
    const surfacePx = fraction * world.h;
    const gPx = G * pixelsPerMetre;

    const count = Math.max(1, Math.round(p.count));
    const length = Math.max(6, p.length * pixelsPerMetre);
    const facing = p.speed < 0 ? -1 : 1;
    const spanX = bbox.w + length * 2.5;

    /**
     * The beat rate, from the Strouhal number rather than from a slider.
     *
     * Phase is taken from the *horizontal* speed only, which is constant, so
     * it advances smoothly through a leap. The vertical motion changes the
     * animal's speed through the water by a few per cent over a cycle; letting
     * that into the phase would buy nothing visible and cost continuity.
     */
    const amplitude = FLUKE_AMPLITUDE * length;
    const beatHz = (p.strouhal * Math.abs(p.speed)) / Math.max(1, amplitude);

    g.save();
    g.clip(shape.path);

    for (let i = 0; i < count; i++) {
      const { x0, phase, scale, lane, tint } =
        podPlacement(i, count, p.together, spanX, length);

      const L = length * scale;
      const swim = porpoise(t, p, phase);
      /**
       * Its own cruising depth, faded in below the surface.
       *
       * A pod is not a line of animals at one depth — but an offset applied
       * flat would either lift somebody permanently into the air or stop
       * somebody else ever breaking the surface, and both are worse than the
       * problem. Fading it in over the first metre keeps every animal's
       * surfacing exact and still puts them on different levels underneath.
       */
      const depthM = swim.z + lane * clamp(swim.z, 0, 1);

      const unwrappedX = x0 + t * p.speed;
      const x = wrapped(unwrappedX, spanX, bbox.x - length * 1.25);
      const y = surfacePx + depthM * pixelsPerMetre;
      if (
        x < bbox.x - L || x > bbox.x + bbox.w + L
        || y < bbox.y - L * 2 || y > bbox.y + bbox.h + L
      ) continue;

      const metres = depthAt(water, y, world);
      const back = waterAbsorb(mixHex(p.color, p.belly, tint * 0.12), metres, p.turbidity);
      const belly = waterAbsorb(p.belly, metres, p.turbidity);
      const alpha = clamp(0.92 * p.level, 0, 1);

      /**
       * Pitch, from the velocity rather than from the pose.
       *
       * The body points where it is going, which through a leap means nose up
       * on the way out and nose down on the way in, at equal angles, because
       * the vertical speed is continuous through the surface. It is the single
       * detail that separates a leaping animal from a sprite on an arc.
       */
      const pitch = Math.atan2(swim.vz * pixelsPerMetre, Math.max(1, Math.abs(p.speed)));

      g.save();
      g.translate(x, y);
      if (facing < 0) g.scale(-1, 1);
      g.rotate(pitch);

      const half = L * 0.5;
      const depth = L * 0.105;
      /**
       * Airborne, the body locks into an arch and stops beating. A dolphin in
       * the air is a rigid projectile — there is nothing to push against — and
       * a fluke still swinging up there is the thing that makes an otherwise
       * good leap read as a puppet.
       */
      const drive = swim.airborne ? 0.12 : 1;
      const wavePhase = TAU * beatHz * t;

      /**
       * The centreline, as a wave running aft.
       *
       * Thunniform swimming: one wavelength to the body, and an amplitude that
       * is nothing at the head and everything at the peduncle. A tuna, a mako
       * and a dolphin all converged on it independently, because it is what
       * lets a body be stiff enough to hold its shape at speed and still drive
       * a foil at the back. Give the whole body equal amplitude instead and
       * you have an eel.
       */
      for (let k = 0; k <= BODY_SEGMENTS; k++) {
        const u = k / BODY_SEGMENTS;
        const env = amplitude * 0.5 * scale * Math.pow(u, 2.2) * drive;
        const g0 = depth * (girth(u) + rostrum(u));
        bodyCx[k] = half - u * L;
        bodyCy[k] = env * Math.sin(wavePhase - u * TAU);
        bodyUp[k] = g0 + depth * melon(u);
        bodyDn[k] = g0;
      }

      const skin = g.createLinearGradient(0, -depth * 1.5, 0, depth * 1.3);
      skin.addColorStop(0, rgba(back, alpha));
      skin.addColorStop(0.46, rgba(back, alpha));
      skin.addColorStop(0.62, rgba(mixHex(back, belly, 0.55), alpha));
      skin.addColorStop(0.8, rgba(belly, alpha));
      skin.addColorStop(1, rgba(mixHex(belly, back, 0.22), alpha));
      g.fillStyle = skin;

      /**
       * The silhouette, as a curve rather than as twenty-two chords.
       *
       * A body this size on a wall is two metres of animal, and at that scale
       * a polygon reads as a polygon — the back comes out faceted and the
       * whole thing looks like a cut-out. Collected into one run so the head
       * and the peduncle are curves too, and closed back to the tip of the
       * rostrum, which is a point on the centreline and the one corner the
       * animal actually has.
       */
      let n = 0;
      outlineX[n] = bodyCx[0]; outlineY[n++] = bodyCy[0];
      for (let k = 1; k <= BODY_SEGMENTS; k++) {
        outlineX[n] = bodyCx[k];
        outlineY[n++] = bodyCy[k] - bodyUp[k];
      }
      for (let k = BODY_SEGMENTS; k >= 1; k--) {
        outlineX[n] = bodyCx[k];
        outlineY[n++] = bodyCy[k] + bodyDn[k];
      }
      g.beginPath();
      curveThrough(g, outlineX, outlineY, n, { move: true });
      g.closePath();
      g.fill();

      /**
       * The flukes, pitched to the local slope of the body wave and *feathered*
       * — held at less than the path angle, so the blade meets the water at an
       * angle of attack and generates lift forwards. Rigidly aligned to the
       * body it produces no thrust and looks like it; square to the path it
       * stalls. Somewhere in between is what the animal does, and it is the
       * detail that makes the animal look like it is pushing rather than being
       * pulled.
       *
       * Horizontal, too. Every fish on this wall beats side to side; a whale
       * beats up and down, because it is a land mammal that went back, and the
       * spine it took with it bends that way. It is the one silhouette cue
       * that says mammal, and it costs nothing to get right.
       */
      const tail = BODY_SEGMENTS;
      const slope = Math.atan2(bodyCy[tail] - bodyCy[tail - 4], bodyCx[tail] - bodyCx[tail - 4]);
      g.fillStyle = rgba(back, alpha);
      g.save();
      g.translate(bodyCx[tail], bodyCy[tail]);
      g.rotate(slope * 0.65);
      g.beginPath();
      g.moveTo(L * 0.025, 0);
      g.quadraticCurveTo(-L * 0.005, -L * 0.05, -L * 0.065, -L * 0.125);
      g.quadraticCurveTo(-L * 0.045, -L * 0.045, -L * 0.04, 0);
      g.quadraticCurveTo(-L * 0.045, L * 0.045, -L * 0.065, L * 0.125);
      g.quadraticCurveTo(-L * 0.005, L * 0.05, L * 0.025, 0);
      g.closePath();
      g.fill();
      g.restore();

      // Dorsal fin: falcate, swept back, with the concave trailing edge that
      // makes it a dolphin's rather than a shark's.
      const dorsalAt = Math.round(BODY_SEGMENTS * 0.42);
      const dx0 = bodyCx[dorsalAt];
      const dy0 = bodyCy[dorsalAt] - bodyUp[dorsalAt] * 0.94;
      g.beginPath();
      g.moveTo(dx0 + L * 0.075, dy0);
      g.quadraticCurveTo(dx0 + L * 0.045, dy0 - L * 0.055, dx0 - L * 0.075, dy0 - L * 0.125);
      g.quadraticCurveTo(dx0 - L * 0.015, dy0 - L * 0.045, dx0 - L * 0.07, dy0);
      g.closePath();
      g.fill();

      // Pectoral flipper, sculling gently out of phase with the fluke.
      const pecAt = Math.round(BODY_SEGMENTS * 0.24);
      const scull = Math.sin(wavePhase - 1.9) * 0.22 * drive;
      g.fillStyle = rgba(mixHex(back, belly, 0.12), alpha * 0.95);
      g.save();
      g.translate(bodyCx[pecAt], bodyCy[pecAt] + bodyDn[pecAt] * 0.45);
      g.rotate(1.05 + scull);
      g.beginPath();
      g.moveTo(L * 0.02, 0);
      g.quadraticCurveTo(L * 0.022, L * 0.085, -L * 0.028, L * 0.14);
      g.quadraticCurveTo(-L * 0.026, L * 0.06, -L * 0.03, 0);
      g.closePath();
      g.fill();
      g.restore();

      // The mouthline, from the tip of the beak back to under the eye, which
      // is where a bottlenose's runs and why it looks like it is smiling.
      const eyeAt = Math.round(BODY_SEGMENTS * 0.2);
      g.strokeStyle = rgba(mixHex(back, '#000000', 0.4), alpha * 0.5);
      g.lineWidth = Math.max(0.5, L * 0.006);
      g.beginPath();
      g.moveTo(half - L * 0.005, bodyCy[0] + depth * 0.06);
      g.quadraticCurveTo(
        bodyCx[eyeAt] + L * 0.03, bodyCy[eyeAt] + bodyDn[eyeAt] * 0.5,
        bodyCx[eyeAt] - L * 0.01, bodyCy[eyeAt] + bodyDn[eyeAt] * 0.35
      );
      g.stroke();

      // An eye, just aft of the melon.
      g.fillStyle = rgba('#06141d', alpha * 0.9);
      g.beginPath();
      g.arc(bodyCx[eyeAt] - L * 0.01, bodyCy[eyeAt] - bodyUp[eyeAt] * 0.05,
        Math.max(0.5, L * 0.0075), 0, TAU);
      g.fill();

      /**
       * Wet skin in air. Above the surface the animal is not being lit through
       * ten metres of water, it is being lit directly and it is *shiny* — the
       * flash off a wet back is most of what you see of a leap at night.
       */
      if (swim.airborne) {
        g.strokeStyle = rgba('#ffffff', alpha * 0.2);
        g.lineWidth = Math.max(0.6, depth * 0.16);
        g.lineCap = 'round';
        let r = 0;
        outlineX[r] = bodyCx[3]; outlineY[r++] = bodyCy[3] - bodyUp[3] * 0.55;
        for (let k = 4; k <= dorsalAt + 4; k++) {
          outlineX[r] = bodyCx[k];
          outlineY[r++] = bodyCy[k] - bodyUp[k] * 0.6;
        }
        g.beginPath();
        curveThrough(g, outlineX, outlineY, r, { move: true });
        g.stroke();
      }

      g.restore();

      /**
       * What the surface does about it: a burst where the animal left and
       * another where it came back in, and the exhale on the way up.
       */
      if (p.spray > 0) {
        const entrySpeed = Math.sqrt(2 * G * Math.max(0, p.leap)) * pixelsPerMetre;
        const leapIndex = Math.floor(t / swim.period + phase);
        const launch = swim.q;
        const reentry = swim.q - swim.tAir;
        // Where the animal was when it crossed, not where it is now — it has
        // travelled since, and the water it threw has not.
        const outX = wrapped(unwrappedX - p.speed * launch, spanX, bbox.x - length * 1.25);
        const inX = wrapped(unwrappedX - p.speed * reentry, spanX, bbox.x - length * 1.25);
        const life = 0.6;
        const who = hashString(shape.id);
        seedSplash(who, i, leapIndex * 3);
        splash(g, outX, surfacePx, launch, life, 1.5,
          Math.max(L * 0.9, entrySpeed * 0.55), gPx, belly,
          p.spray * p.level * 0.5, 0.5);
        seedSplash(who, i, leapIndex * 3 + 1);
        splash(g, inX, surfacePx, reentry, life * 1.3, 2.2,
          Math.max(L * 1.1, entrySpeed * 0.7), gPx, belly,
          p.spray * p.level * 0.6, 0.8);
        // The blow: a narrow plume of exhaled breath, straight up, slow.
        seedSplash(who, i, leapIndex * 3 + 2);
        splash(g, outX, surfacePx, launch, 0.75, 0.5, L * 0.35, gPx * 0.15,
          '#ffffff', p.spray * p.level * 0.35, 0);
      }
    }

    g.restore();
  },
};

export default [godrays, waterline, shoal, dolphins, bubbles, kelp, jellyfish];
