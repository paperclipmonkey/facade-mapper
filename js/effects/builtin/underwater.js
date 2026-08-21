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

import { rgba, clamp, lerp, TAU, mixHex, makeRng, smoothstep } from '../../core/math.js';
import { waterAbsorb } from '../color.js';
import { collectObstacles, deflect, nearestSurface, isClear } from '../obstacles.js';
import { glow } from '../lib.js';

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
  // Harmonics of the primary, at the amplitude ratios a real wind sea carries:
  // most of the energy in the swell, a third in the chop, a little in the ripple.
  const parts = [
    [1, 1],
    [0.47, 2.7],
    [0.21, 6.3],
  ];
  let height = 0;
  let slope = 0;
  for (let i = 0; i < parts.length; i++) {
    const [amp, harmonic] = parts[i];
    const k = (TAU * harmonic) / Math.max(0.2, wavelength);
    const omega = Math.sqrt(G * k);
    // Offset in phase per component so the crests do not all start stacked.
    const phase = k * xm - omega * t + i * 1.7;
    height += amplitude * amp * Math.sin(phase);
    slope += amplitude * amp * k * Math.cos(phase);
  }
  return { height, slope };
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
 * How many depths a shaft's gradient is sampled at.
 *
 * Absorption is exponential, and a two-stop gradient across ten metres of it is
 * visibly a straight line where the curve should be steepest. Six is enough
 * that the knee is smooth, and it is six `waterAbsorb` calls per shaft per
 * frame — about sixty for a full fan, which is nothing.
 */
const SHAFT_STOPS = 6;

/**
 * The cross-section of a shaft, as [width, alpha] pairs.
 *
 * Widths halve geometrically; alphas are `exp(−2u²)` at the half-width, which
 * is what makes the stack add up to something with no edge in it. Precomputed
 * because it never changes and this is inside a per-shaft loop.
 */
const SHAFT_SECTION = [1, 0.68, 0.46, 0.31, 0.16].map((scale) => [
  scale,
  Math.exp(-2 * scale * scale) / Math.exp(-2 * 0.16 * 0.16),
]);

const godrays = {
  id: 'godrays',
  name: 'Shafts from the Surface',
  category: 'underwater',
  scope: 'shape',
  description:
    'Sunlight coming down through the surface in shafts, swaying with the swell and reddening out of existence as it goes deeper. The colour is absorption rather than a tint, so the depth reads even in a still.',
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
      for (let i = 0; i < SHAFT_STOPS; i++) {
        const u = i / (SHAFT_STOPS - 1);
        const y = lerp(top, bottom, u);
        const colour = waterAbsorb(p.color, depthAt(p, y, world), p.turbidity);
        wash.addColorStop(u, rgba(colour, p.haze * 0.16 * p.intensity * (1 - u * 0.45)));
      }
      g.fillStyle = wash;
      g.fillRect(bbox.x, top, bbox.w, bottom - top);
    }

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

      const length = (bottom - top) / Math.max(0.15, Math.cos(clamp(angle, -1.4, 1.4)));
      const dx = Math.sin(angle);
      const dy = Math.cos(angle);
      const endX = originX + dx * length;
      const endY = top + dy * length;

      const w0 = bbox.w * p.width * (0.55 + 0.9 * (1 - focus)) * (0.7 + jitter * 0.6);
      // Beams widen going down: the surface is a rough lens, not a slit.
      const w1 = w0 * 2.6;

      // The shimmer is the surface breaking up, and it is independent per shaft
      // — a fan that brightens as one reads as a lamp behind a fan blade.
      const shimmer = 1 - p.shimmer * 0.5 * (0.5 + 0.5 * noise.noise2(i * 3.7, t * 0.9));
      const peak = 0.5 * p.intensity * shimmer * (0.6 + 0.4 * focus);

      const grad = g.createLinearGradient(originX, top, endX, endY);
      for (let s = 0; s < SHAFT_STOPS; s++) {
        const u = s / (SHAFT_STOPS - 1);
        const y = lerp(top, endY, u);
        const colour = waterAbsorb(p.color, depthAt(p, y, world), p.turbidity);
        // Fades out along its own length as well as reddening: a shaft ends
        // because the light in it has been scattered away, not at a hard edge.
        grad.addColorStop(u, rgba(colour, peak * (1 - u) ** 1.6));
      }

      /**
       * Nested quads rather than one, because Canvas has no gradient across the
       * width of a shape and a beam with a hard edge is a plank.
       *
       * Five rather than three, and this is worth the extra two fills: the
       * widths are a geometric series and the alphas are the Gaussian
       * `exp(−2u²)` evaluated at them, so the stack sums to a smooth section
       * instead of to visible steps. At three the steps are plainly there on a
       * wide shaft — the beam reads as three planks stacked, which is worse
       * than one plank because it looks like a mistake rather than a style.
       */
      g.fillStyle = grad;
      for (const [scale, alpha] of SHAFT_SECTION) {
        g.globalAlpha = alpha;
        g.beginPath();
        g.moveTo(originX - w0 * scale * 0.5, top);
        g.lineTo(originX + w0 * scale * 0.5, top);
        g.lineTo(endX + w1 * scale * 0.5, endY);
        g.lineTo(endX - w1 * scale * 0.5, endY);
        g.closePath();
        g.fill();
      }
      g.globalAlpha = 1;
    }

    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * The waterline
 * ------------------------------------------------------------------ */

/** Horizontal samples across the surface. Enough for the shortest harmonic. */
const SURFACE_SAMPLES = 96;

const waterline = {
  id: 'waterline',
  name: 'Waterline',
  category: 'underwater',
  scope: 'shape',
  description:
    'The surface of the water crossing the house, with everything under it absorbed towards blue and the light of the surface dancing on the wall above. Three wave components on the real dispersion relation, so it never repeats.',
  params: [
    { key: 'color', type: 'color', label: 'Light on the water', default: '#dff2ff' },
    ...SURFACE_PARAMS,
    { key: 'body', type: 'range', label: 'Water', default: 0.55, min: 0, max: 1.5, step: 0.01 },
    { key: 'wave', type: 'range', label: 'Wave height (cm)', default: 22, min: 0, max: 200, step: 1 },
    { key: 'wavelength', type: 'range', label: 'Wavelength (m)', default: 5, min: 0.5, max: 40, step: 0.1 },
    { key: 'tide', type: 'range', label: 'Tide', default: 0.02, min: 0, max: 0.3, step: 0.005 },
    { key: 'tidePeriod', type: 'range', label: 'Tide period (s)', default: 42, min: 4, max: 300, step: 1 },
    { key: 'glint', type: 'range', label: 'Glints', default: 0.8, min: 0, max: 2, step: 0.01 },
    { key: 'spill', type: 'range', label: 'Light above the line', default: 0.7, min: 0, max: 2, step: 0.01 },
    { key: 'level', type: 'range', label: 'Brightness', default: 1, min: 0, max: 3, step: 0.05 },
  ],
  draw({ g, p, shape, t, world }) {
    const { bbox } = shape;
    if (bbox.w <= 2 || bbox.h <= 2 || p.level <= 0) return;

    const metresPerPixel = (p.metres || 14) / Math.max(1, world.h);
    const pixelsPerMetre = 1 / Math.max(1e-6, metresPerPixel);

    /**
     * The tide, which is the difference between a picture of water and water.
     *
     * A fixed line across a wall reads as a painted stripe within about ten
     * seconds. A line that is a metre higher two minutes later reads as the
     * house going under, and the effect never has to do anything else.
     */
    const tide = Math.sin((t * TAU) / Math.max(1, p.tidePeriod)) * p.tide * world.h;
    const baseY = surfaceY(p, world) + tide;
    const amplitude = (p.wave / 100) * pixelsPerMetre;

    const left = bbox.x;
    const right = bbox.x + bbox.w;
    const bottom = bbox.y + bbox.h;

    // Sample the surface once and reuse it for the body, the meniscus, the
    // glints and the spill — four passes that must agree about where the water
    // is, and would drift apart if each computed its own.
    const xs = new Array(SURFACE_SAMPLES + 1);
    const ys = new Array(SURFACE_SAMPLES + 1);
    const slopes = new Array(SURFACE_SAMPLES + 1);
    for (let i = 0; i <= SURFACE_SAMPLES; i++) {
      const u = i / SURFACE_SAMPLES;
      const x = lerp(left, right, u);
      const wave = waveTrain(x * metresPerPixel, t, p.wave / 100, p.wavelength);
      xs[i] = x;
      ys[i] = baseY + wave.height * pixelsPerMetre;
      slopes[i] = wave.slope;
    }

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';

    /* The body of the water, absorbed with depth. */
    if (p.body > 0 && bottom > baseY - amplitude) {
      const gradTop = Math.max(bbox.y, baseY - amplitude * 2);
      const grad = g.createLinearGradient(0, gradTop, 0, bottom);
      for (let i = 0; i < 8; i++) {
        const u = i / 7;
        const y = lerp(gradTop, bottom, u);
        const colour = waterAbsorb(p.color, depthAt(p, y, world), p.turbidity);
        /**
         * Brightest immediately under the surface and falling away below.
         *
         * Two separate things are happening and they pull the same way: the
         * light has further to travel, and what is left of it has been
         * scattered out of the line of sight. Both are exponential, and the
         * `waterAbsorb` above only accounts for the first — hence the second
         * term. Without it the deep water is a saturated blue slab, which is
         * what a gel looks like and not what water looks like.
         */
        const falloff = Math.exp(-u * 1.6);
        grad.addColorStop(u, rgba(colour, p.body * 0.5 * p.level * falloff));
      }
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(left, bottom);
      for (let i = 0; i <= SURFACE_SAMPLES; i++) g.lineTo(xs[i], ys[i]);
      g.lineTo(right, bottom);
      g.closePath();
      g.fill();
    }

    /**
     * The surface itself, seen edge-on.
     *
     * At a grazing angle water is a mirror — the Fresnel reflectance of water
     * is about 2% face-on and effectively 100% at the horizon — so the line
     * where it meets the wall is the brightest thing in the picture by a long
     * way. Getting this too dim is the single commonest way an underwater look
     * fails to read: without a bright meniscus there is no surface, and with no
     * surface there is no "under".
     */
    const surfaceColour = waterAbsorb(p.color, 0, p.turbidity);
    g.strokeStyle = rgba(surfaceColour, clamp(0.7 * p.level, 0, 1));
    g.lineWidth = Math.max(1.5, world.h * 0.003);
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(xs[0], ys[0]);
    for (let i = 1; i <= SURFACE_SAMPLES; i++) g.lineTo(xs[i], ys[i]);
    g.stroke();

    /**
     * The halo under the line — the part of the surface light that got through.
     *
     * Three widening passes rather than one wide one. A single fat stroke has
     * an edge of its own, and an edge under a waterline reads as a second
     * waterline, which is the one thing there cannot be two of. Widening and
     * fading gives a skirt that ends where the eye cannot find it.
     */
    for (const [spread, alpha] of [[0.4, 0.1], [1, 0.06], [2.2, 0.035]]) {
      g.strokeStyle = rgba(surfaceColour, clamp(alpha * p.level, 0, 1));
      g.lineWidth = Math.max(4, world.h * 0.018 * spread);
      const drop = g.lineWidth * 0.4;
      g.beginPath();
      g.moveTo(xs[0], ys[0] + drop);
      for (let i = 1; i <= SURFACE_SAMPLES; i++) g.lineTo(xs[i], ys[i] + drop);
      g.stroke();
    }

    /**
     * Glints, on the faces that are pointing at the light.
     *
     * A specular highlight is not "on the crest"; it is wherever the surface
     * slope happens to satisfy the reflection, which is on the *flanks* and
     * moves along the wave rather than with it. Driving them off the slope
     * gives that for nothing, and it is the reason they sparkle in and out
     * instead of marching sideways in a row.
     */
    if (p.glint > 0) {
      for (let i = 1; i < SURFACE_SAMPLES; i++) {
        const facing = clamp(1 - Math.abs(slopes[i] * 3 - 0.55), 0, 1);
        if (facing < 0.35) continue;
        const strength = (facing - 0.35) / 0.65;
        glow(
          g,
          xs[i],
          ys[i],
          world.h * 0.012 * (0.6 + strength),
          surfaceColour,
          clamp(strength * strength * 0.7 * p.glint * p.level, 0, 1)
        );
      }
    }

    /**
     * The light that gets past the surface and lands on the wall above it.
     *
     * The bit of a swimming pool everybody has actually looked at: bright
     * ripples crawling up the wall above the water, brightest right at the line
     * and gone within a metre or so. It is a caustic, it comes from the same
     * wave train, and it is the cheapest possible confirmation that the wave is
     * real rather than drawn — the two agree because they are the same numbers.
     */
    if (p.spill > 0 && baseY > bbox.y) {
      /**
       * Four broad bands, not seven thin ones.
       *
       * A caustic on a wall is a band of light with soft edges, and drawing it
       * as a hairline traces the *outline* of one — which above a dark
       * waterline reads as scribble rather than as light. Wide, few, and faint
       * is the same amount of light in a shape the eye accepts.
       */
      const reach = world.h * 0.12;
      for (let band = 1; band <= 4; band++) {
        const up = (band / 4) ** 1.5 * reach;
        const fade = (1 - band / 5) ** 2;
        g.lineWidth = Math.max(3, world.h * 0.012 * (0.6 + band * 0.5));
        g.strokeStyle = rgba(surfaceColour, clamp(fade * 0.16 * p.spill * p.level, 0, 1));
        g.beginPath();
        for (let i = 0; i <= SURFACE_SAMPLES; i++) {
          // The caustic above the line is the surface slope, magnified — where
          // the water is steep the light is bent furthest up the wall.
          const y = ys[i] - up * (0.6 + slopes[i] * 1.4);
          if (i === 0) g.moveTo(xs[i], y);
          else g.lineTo(xs[i], y);
        }
        g.stroke();
      }
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
    state.targetX = container.bbox.x + container.bbox.w * (0.5 + 0.42 * noise.noise2(t * 0.05 * roam, 11.3));
    state.targetY = container.bbox.y + container.bbox.h * (0.5 + 0.38 * noise.noise2(4.7, t * 0.045 * roam));

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
      const surf = nearestSurface(obstacles, probeX, probeY, look);
      if (surf) {
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
        const sign = surf.inside ? -1 : 1;
        f.ax += surf.nx * sign * urgency + tx * urgency * 0.8;
        f.ay += surf.ny * sign * urgency + ty * urgency * 0.8;
      }

      const before = Math.atan2(f.vy, f.vx);
      f.vx += f.ax * dt;
      f.vy += f.ay * dt;

      const sp = Math.hypot(f.vx, f.vy);
      if (sp > maxSpeed) {
        f.vx *= maxSpeed / sp;
        f.vy *= maxSpeed / sp;
      } else if (sp < minSpeed && sp > 1e-6) {
        f.vx *= minSpeed / sp;
        f.vy *= minSpeed / sp;
      }

      f.x += f.vx * dt;
      f.y += f.vy * dt;

      // Hard constraints last, so nothing this step can leave a fish inside a
      // window: the accelerations above are a suggestion, these are the wall.
      deflect(container.points, f, size * 0.35, 0.25, true);
      for (const o of obstacles) {
        const { bbox } = o;
        if (
          f.x < bbox.x - size
          || f.x > bbox.x + bbox.w + size
          || f.y < bbox.y - size
          || f.y > bbox.y + bbox.h + size
        ) continue;
        deflect(o.points, f, size * 0.35, 0.25, false);
      }

      const after = Math.atan2(f.vy, f.vx);
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
       * Smoothed, because the flash outlasts the instant of the turn — it is a
       * broad specular lobe, not a delta function.
       */
      const rate = Math.abs(angleDelta(before, after)) / Math.max(1e-4, dt);
      f.turn = lerp(f.turn, Math.min(12, rate), 0.25);
      // Beat phase advances with distance covered, so a fish that speeds up
      // beats its tail faster rather than swimming with the same stroke.
      f.beat += (Math.hypot(f.vx, f.vy) / Math.max(1, size)) * dt * 9;
    }
  },
  draw({ g, p, shape, state, world }) {
    if (!state.fish?.length) return;
    const size = Math.max(3, p.size);
    // Constant for every fish, so built once rather than forty times a frame.
    const eyeInk = rgba('#04121b', 0.85);

    g.save();
    g.clip(shape.path);

    for (const f of state.fish) {
      const len = size * f.scale;
      const half = len * 0.5;
      const body = len * 0.3;
      const angle = Math.atan2(f.vy, f.vx);
      const metres = depthAt(p, f.y, world);

      const back = waterAbsorb(mixHex(p.color, p.belly, f.tint * 0.25), metres, p.turbidity);
      const flank = waterAbsorb(p.belly, metres, p.turbidity);
      const shine = clamp((f.turn / 7) * p.flash, 0, 1);

      g.save();
      g.translate(f.x, f.y);
      g.rotate(angle);

      // The tail leads the body: a fish is pushed by its tail, so the beat has
      // to be visibly *ahead* of where the body is going or it reads as a lure
      // being pulled through the water.
      const beat = Math.sin(f.beat);
      const bend = beat * 0.35;

      g.globalCompositeOperation = 'lighter';

      // Tail fin, hinged at the peduncle.
      g.fillStyle = rgba(back, 0.75);
      g.beginPath();
      g.moveTo(-half * 0.55, 0);
      g.lineTo(-half * 1.15, -body * (0.75 - bend));
      g.lineTo(-half * 0.95, 0);
      g.lineTo(-half * 1.15, body * (0.75 + bend));
      g.closePath();
      g.fill();

      // Body: nose to peduncle, curved along the beat.
      const grad = g.createLinearGradient(0, -body, 0, body);
      grad.addColorStop(0, rgba(back, 0.9));
      grad.addColorStop(0.45, rgba(flank, 0.55 + shine * 0.45));
      grad.addColorStop(1, rgba(back, 0.9));
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(half, 0);
      g.quadraticCurveTo(0, -body * (1 + bend * 0.4), -half * 0.6, -body * 0.25);
      g.lineTo(-half * 0.6, body * 0.25);
      g.quadraticCurveTo(0, body * (1 - bend * 0.4), half, 0);
      g.closePath();
      g.fill();

      // Dorsal, and a pectoral that sculls opposite the tail.
      g.fillStyle = rgba(back, 0.55);
      g.beginPath();
      g.moveTo(half * 0.1, -body * 0.85);
      g.lineTo(-half * 0.35, -body * 1.45);
      g.lineTo(-half * 0.5, -body * 0.7);
      g.closePath();
      g.fill();
      g.beginPath();
      g.moveTo(half * 0.05, body * 0.3);
      g.lineTo(-half * 0.3, body * (0.9 - bend * 0.6));
      g.lineTo(-half * 0.15, body * 0.2);
      g.closePath();
      g.fill();

      // The specular itself: a hard line down the flank, not a general
      // brightening. A mirror gives you an image of the source, and the source
      // here is a band of sky seen through a rough surface.
      if (shine > 0.02) {
        g.strokeStyle = rgba('#ffffff', shine * 0.85);
        g.lineWidth = Math.max(0.8, body * 0.3);
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(half * 0.55, -body * 0.05);
        g.lineTo(-half * 0.4, body * 0.05);
        g.stroke();
      }

      // Eye. One dot, and the fish stops being a leaf.
      g.fillStyle = eyeInk;
      g.beginPath();
      g.arc(half * 0.55, -body * 0.22, Math.max(0.6, body * 0.16), 0, TAU);
      g.fill();

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

      // The house is in the way, and a bubble that meets a sill does not bounce
      // off it — it presses against the underside and slides out sideways,
      // which is what a restitution near zero plus a lateral wobble gives.
      for (const o of obstacles) {
        const { bbox: ob } = o;
        if (
          b.x < ob.x - b.r
          || b.x > ob.x + ob.w + b.r
          || b.y < ob.y - b.r
          || b.y > ob.y + ob.h + b.r
        ) continue;
        deflect(o.points, b, b.r, 0.05, false);
      }

      // Gone at the surface, or off the top of what we were given.
      if (b.y + b.r < top || b.life > 60) state.bubbles.splice(i, 1);
    }

    // A hard ceiling on the population, because `rate` times a long catch-up is
    // otherwise unbounded and a projector tab opened at midnight would spend a
    // frame allocating an hour of bubbles it is about to throw away.
    if (state.bubbles.length > 900) state.bubbles.splice(0, state.bubbles.length - 900);
  },
  draw({ g, p, shape, state, world }) {
    if (!state.bubbles?.length || p.level <= 0) return;

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';

    const top = Math.max(shape.bbox.y, surfaceY(p, world));

    for (const b of state.bubbles) {
      const metres = depthAt(p, b.y, world);
      const colour = waterAbsorb(p.color, metres * 0.35, p.turbidity);
      // Fades in off the vent and out at the surface, so nothing appears or
      // vanishes on a frame boundary.
      const fade = clamp(b.life * 4, 0, 1)
        * clamp((b.y - top) / Math.max(1, world.h * 0.06), 0, 1);
      const alpha = clamp(0.75 * fade * p.level, 0, 1);
      if (alpha <= 0.004 || b.r < 0.4) continue;

      /**
       * A bubble is a rim, not a disc.
       *
       * Under water a bubble is a lens of air with almost nothing in the middle
       * of it: light passing through the centre is barely bent and carries on,
       * while light meeting the edge hits the interface at a grazing angle and
       * is thrown back at you whole. So what you see is a bright ring, a hard
       * highlight where the surface faces the light, and a second smaller one
       * underneath from the light that went through and came back. Drawn as a
       * filled circle it is a pearl.
       */
      g.strokeStyle = rgba(colour, alpha);
      g.lineWidth = Math.max(0.6, b.r * 0.22);
      g.beginPath();
      g.arc(b.x, b.y, Math.max(0.5, b.r - g.lineWidth * 0.5), 0, TAU);
      g.stroke();

      if (b.r > 2.2) {
        g.fillStyle = rgba('#ffffff', alpha * 0.8);
        g.beginPath();
        g.arc(b.x - b.r * 0.32, b.y - b.r * 0.36, Math.max(0.4, b.r * 0.2), 0, TAU);
        g.fill();
        g.fillStyle = rgba(colour, alpha * 0.45);
        g.beginPath();
        g.arc(b.x + b.r * 0.3, b.y + b.r * 0.34, Math.max(0.3, b.r * 0.13), 0, TAU);
        g.fill();
      }
    }

    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * Kelp
 * ------------------------------------------------------------------ */

/** Nodes up a frond. Enough for a smooth curve, few enough to be free. */
const KELP_NODES = 14;

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

      for (let i = 0; i <= KELP_NODES; i++) {
        const u = i / KELP_NODES;
        const y = rootY - height * u;
        const z = depthAt(p, y, world);
        const decay = orbitalDecay(z, p.wavelength) / tipDecay;
        // Anchored at the holdfast: the exponential alone still leaves a base
        // that slides, and a plant that slides is a plant that is not rooted.
        const anchored = u * u * (3 - 2 * u);
        const phase = omega * t - k * rootMetresX + jitter * 2.4;
        const offset = swayPx * decay * anchored * (Math.sin(phase) + 0.35 * Math.sin(phase * 2.1 + 1.1));
        nx[i] = rootX + offset + (lean * height + drift) * anchored;
        ny[i] = y;
      }

      const nearColour = waterAbsorb(p.color, depthAt(p, rootY, world), p.turbidity);
      const tipColour = waterAbsorb(p.tip, tipDepth, p.turbidity);
      const grad = g.createLinearGradient(rootX, rootY, nx[KELP_NODES], ny[KELP_NODES]);
      grad.addColorStop(0, rgba(nearColour, clamp(0.75 * p.level, 0, 1)));
      grad.addColorStop(1, rgba(tipColour, clamp(0.95 * p.level, 0, 1)));

      // Blades first, so the stipe is drawn over their roots.
      if (p.blades > 0) {
        g.fillStyle = grad;
        for (let i = 2; i < KELP_NODES; i++) {
          const side = i % 2 === 0 ? 1 : -1;
          const u = i / KELP_NODES;
          const dx = nx[i + 1] - nx[i - 1];
          const dy = ny[i + 1] - ny[i - 1];
          const len = Math.hypot(dx, dy) || 1;
          // Perpendicular to the stipe, so a blade lies along the flow instead
          // of sticking out sideways from a plant that is bent double.
          const px = (-dy / len) * side;
          const py = (dx / len) * side;
          const bladeLen = width * 3.4 * p.blades * (0.5 + u * 0.9);
          const along = (height / KELP_NODES) * 1.5;
          g.beginPath();
          g.moveTo(nx[i], ny[i]);
          g.quadraticCurveTo(
            nx[i] + px * bladeLen * 0.7 + (dx / len) * along * 0.5,
            ny[i] + py * bladeLen * 0.7 + (dy / len) * along * 0.5,
            nx[i] + px * bladeLen * 0.35 + (dx / len) * along * 1.6,
            ny[i] + py * bladeLen * 0.35 + (dy / len) * along * 1.6
          );
          g.quadraticCurveTo(
            nx[i] + px * bladeLen * 0.12,
            ny[i] + py * bladeLen * 0.12,
            nx[i],
            ny[i]
          );
          g.closePath();
          g.fill();
        }
      }

      g.strokeStyle = grad;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.lineWidth = width;
      g.beginPath();
      g.moveTo(nx[0], ny[0]);
      for (let i = 1; i <= KELP_NODES; i++) g.lineTo(nx[i], ny[i]);
      g.stroke();

      // Gas bladders, which is what holds a real frond up and is also the one
      // detail that makes weed look like weed rather than like rope.
      if (p.bladders > 0) {
        g.fillStyle = rgba(tipColour, clamp(0.8 * p.level, 0, 1));
        for (let i = 4; i < KELP_NODES; i += 3) {
          const r = width * 0.7 * p.bladders * (0.6 + (i / KELP_NODES) * 0.8);
          g.beginPath();
          g.ellipse(nx[i], ny[i], r, r * 1.5, 0, 0, TAU);
          g.fill();
        }
      }
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
  const travelY = j.y0 - t * p.rise;

  return {
    x: bbox.x - p.size * 2 + (((travelX % spanX) + spanX) % spanX),
    y: bbox.y + bbox.h + p.size * 2.5 - (((travelY % spanY) + spanY) % spanY) - surge,
    cx: travelX,
    cy: -travelY - surge,
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
      if (now.y + R * 6 < bbox.y || now.y - R * 2 > bbox.y + bbox.h) continue;

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
      const alpha = clamp(0.5 * p.level, 0, 1);

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
       */
      const strands = Math.round(p.tentacles);
      if (strands > 0) {
        g.lineCap = 'round';
        for (let s = 0; s < strands; s++) {
          const across = strands > 1 ? (s / (strands - 1) - 0.5) * 2 : 0;
          const anchorX = across * bellW * 0.82;
          const isArm = s % 3 === 0;
          const span = strandLag(s, p.trail);
          g.strokeStyle = rgba(isArm ? bell : rimColour, alpha * (isArm ? 0.75 : 0.4));
          g.lineWidth = Math.max(0.6, R * (isArm ? 0.11 : 0.05));
          g.beginPath();
          g.moveTo(now.x + anchorX, now.y + bellH * 0.55);
          for (let k = 1; k <= segments; k++) {
            const u = k / segments;
            const past = bellAt(t - span * u, j, p, world, bbox);
            // Where the bell was, expressed as how far it has come since —
            // see `cx, cy` in `bellAt` for why it is not simply `past.x`.
            const sag = bellH * 0.55 + u * span * 120 * (isArm ? 0.5 : 1);
            const splay = anchorX * (1 - u * 0.45) + Math.sin(u * 6 + s) * R * 0.12 * u;
            g.lineTo(
              now.x - (now.cx - past.cx) + splay,
              now.y - (now.cy - past.cy) + sag
            );
          }
          g.stroke();
        }
      }

      // The bell: a dome with the margin curled under, which is the silhouette
      // everybody recognises and the thing a plain half-ellipse misses.
      const dome = g.createRadialGradient(now.x, now.y - bellH * 0.3, 0, now.x, now.y, bellW);
      dome.addColorStop(0, rgba('#ffffff', alpha * 0.55));
      dome.addColorStop(0.45, rgba(bell, alpha * 0.8));
      dome.addColorStop(1, rgba(bell, alpha * 0.12));
      g.fillStyle = dome;
      g.beginPath();
      g.moveTo(now.x - bellW, now.y);
      g.bezierCurveTo(
        now.x - bellW, now.y - bellH * 1.9,
        now.x + bellW, now.y - bellH * 1.9,
        now.x + bellW, now.y
      );
      g.quadraticCurveTo(now.x + bellW * 0.45, now.y + bellH * 0.7, now.x, now.y + bellH * 0.42);
      g.quadraticCurveTo(now.x - bellW * 0.45, now.y + bellH * 0.7, now.x - bellW, now.y);
      g.closePath();
      g.fill();

      // Radial canals.
      g.strokeStyle = rgba(bell, alpha * 0.5);
      g.lineWidth = Math.max(0.5, R * 0.035);
      for (let c = -2; c <= 2; c++) {
        const off = (c / 2.4) * bellW * 0.8;
        g.beginPath();
        g.moveTo(now.x + off * 0.25, now.y - bellH * 0.95);
        g.quadraticCurveTo(now.x + off * 0.8, now.y - bellH * 0.2, now.x + off, now.y + bellH * 0.12);
        g.stroke();
      }

      /**
       * The margin lights up on the recoil, not on the squeeze.
       *
       * Bioluminescence in a medusa is a startle response — it fires *after*
       * something happens, and the flash outlasts the movement that set it off.
       * Peaking it just past the end of the contraction is a small thing that
       * makes the animal look alive rather than lit.
       */
      if (p.glow > 0) {
        const flash = Math.max(0, 1 - Math.abs(now.phase - SQUEEZE * 1.4) * 4);
        g.strokeStyle = rgba(rimColour, clamp((0.35 + flash * 0.6) * p.glow * p.level, 0, 1));
        g.lineWidth = Math.max(0.8, R * 0.09);
        g.beginPath();
        g.moveTo(now.x - bellW, now.y);
        g.quadraticCurveTo(now.x, now.y + bellH * 0.85, now.x + bellW, now.y);
        g.stroke();
        glow(g, now.x, now.y - bellH * 0.2, R * (1.6 + flash), rimColour,
          clamp((0.12 + flash * 0.3) * p.glow * p.level, 0, 1));
      }
    }

    g.restore();
  },
};

export default [godrays, waterline, shoal, bubbles, kelp, jellyfish];
