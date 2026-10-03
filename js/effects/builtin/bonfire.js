/**
 * The fifth of November.
 *
 * Bonfire Night is the one celebration in the British calendar that is
 * *already* a light show: everybody is outdoors in the cold looking up at
 * things burning, which is the exact audience this application is for. It also
 * asks for the three hardest things in the library at once — a fire that is
 * built rather than a fire that fills a rectangle, a firework pinned flat to a
 * wall, and the particular white of burning iron.
 *
 * The rules those three follow are the ones the rest of the library follows.
 * Anything hot takes its colour from a temperature on the blackbody curve, so
 * it reddens as it cools instead of merely dimming. Anything volumetric is a
 * density field rather than a heap of additive circles. And anything that
 * remembers where it was last frame does that in `step`, at a fixed rate, so
 * two projectors covering the same wall agree about where every spark is.
 */

import { rgba, clamp, lerp, TAU, frac, makeRng, smoothstep } from '../../core/math.js';
import { blackbodyCss, blackbodyBytes, ensureField, glow, mixLinear, offscreen } from '../lib.js';

/* ------------------------------------------------------------------ *
 * Bonfire
 * ------------------------------------------------------------------ */

/**
 * The fire's lights, baked from its temperatures.
 *
 * Keyed on `stable` for the usual reason — a bound temperature would otherwise
 * rebake both canvases every frame — and coloured at bake time, because a
 * sprite cannot be tinted cheaply once it is a sprite.
 */
function fireSprites(state, stable) {
  const key = `${stable.coreTemp}|${stable.tipTemp}`;
  if (state.spriteKey === key && state.sprites) return state.sprites;
  const core = blackbodyCss(stable.coreTemp);
  const warm = blackbodyCss(lerp(stable.tipTemp, stable.coreTemp, 0.75));
  const deep = blackbodyCss(lerp(stable.tipTemp, stable.coreTemp, 0.35));
  /**
   * The light a whole fire throws is dominated by its hottest, brightest
   * parts, so the wall is lit nearer the core's colour than the tips' — and a
   * little hotter still, because a wall lit by firelight is photographed (and
   * seen) as amber, not red. Light that dim loses its green on the way through
   * the grade before it loses its red, and a spill at the flame's own colour
   * comes out the colour of a darkroom.
   */
  const cast = blackbodyCss(stable.coreTemp * 1.2);
  state.sprites = {
    // Firelight on the wall: an inverse-square skirt round a bright middle,
    // warmer and redder as it goes out, because the light reaching the far
    // edge of the wall is the light from the low, cooler body of the fire.
    // Held down in the middle, where the fire itself is: light added under the
    // flames only bleaches them, and the wall there is behind the fire anyway.
    spill: bakeLight(128, [
      [0, cast, 0.45], [0.1, cast, 0.62], [0.22, cast, 0.56], [0.38, cast, 0.38],
      [0.55, warm, 0.2], [0.75, deep, 0.07], [1, deep, 0],
    ]),
    // The heart of the stack, where the logs are burning through.
    heart: bakeLight(64, [
      [0, '#fff3d6', 1], [0.18, core, 0.85], [0.45, warm, 0.35], [0.75, deep, 0.08], [1, deep, 0],
    ]),
  };
  state.spriteKey = key;
  return state.sprites;
}

/**
 * The guy, traced in his own units: one unit is his height from the seat to
 * the top of his head, `y` runs down, and the origin is where he sits.
 *
 * Stuffed old clothes on a pile of wood, so nothing about him is a stick: a
 * sack of a body slumped to one side, sleeves and trouser legs as fat as the
 * newspaper in them, gloves, boots, and the hat — the one detail that says
 * *Guy Fawkes* from the far side of a field rather than "a man". Every part is
 * a curve; a silhouette is all anybody will see of him against the flame, and
 * an outline made of straight lines is a cardboard cut-out.
 *
 * Bodies and limbs are traced separately because they are drawn differently:
 * the bodies filled, the limbs stroked fat with round ends, which is exactly
 * what a stuffed sleeve looks like.
 */
function guyBodies(g) {
  g.beginPath();
  // The body: a sack, wider at the shoulders than a person, sagging at the
  // middle where the stuffing has settled.
  g.moveTo(-0.2, 0.03);
  g.bezierCurveTo(-0.31, -0.1, -0.29, -0.32, -0.25, -0.45);
  g.bezierCurveTo(-0.14, -0.53, 0.12, -0.54, 0.25, -0.46);
  g.bezierCurveTo(0.3, -0.3, 0.31, -0.1, 0.21, 0.03);
  g.bezierCurveTo(0.08, 0.08, -0.08, 0.08, -0.2, 0.03);
  g.closePath();
  // A scarf bunched under the chin.
  g.moveTo(0.16, -0.5);
  g.ellipse(0.02, -0.5, 0.14, 0.055, 0.12, 0, TAU);
  // Gloves and boots.
  g.moveTo(-0.27, 0.0);
  g.ellipse(-0.33, 0.0, 0.065, 0.05, 0.4, 0, TAU);
  g.moveTo(0.27, 0.08);
  g.ellipse(0.21, 0.08, 0.065, 0.05, -0.3, 0, TAU);
  g.moveTo(-0.08, 0.43);
  g.ellipse(-0.17, 0.43, 0.1, 0.05, -0.15, 0, TAU);
  g.moveTo(0.33, 0.41);
  g.ellipse(0.25, 0.41, 0.1, 0.05, 0.25, 0, TAU);
}

/** The head and hat, lolling: traced about the neck, which the caller tilts. */
function guyHead(g) {
  // A stuffed head is rounder than a real one and a little too big.
  g.moveTo(0.12, -0.13);
  g.ellipse(0, -0.13, 0.12, 0.135, 0, 0, TAU);
  // The brim, wide and slightly turned down at the edges.
  g.moveTo(-0.25, -0.24);
  g.bezierCurveTo(-0.18, -0.29, 0.18, -0.29, 0.25, -0.24);
  g.bezierCurveTo(0.19, -0.2, -0.19, -0.2, -0.25, -0.24);
  // The crown: tall, a little tapered, a little battered at the top.
  g.moveTo(-0.13, -0.26);
  g.bezierCurveTo(-0.14, -0.34, -0.12, -0.42, -0.1, -0.47);
  g.bezierCurveTo(-0.04, -0.5, 0.06, -0.49, 0.11, -0.46);
  g.bezierCurveTo(0.13, -0.4, 0.14, -0.33, 0.13, -0.26);
  g.closePath();
}

function guyLimbs(g) {
  g.beginPath();
  // Arms hanging off the shoulders, one dropped to his side and one fallen
  // across his knee.
  g.moveTo(-0.22, -0.42);
  g.bezierCurveTo(-0.36, -0.32, -0.38, -0.14, -0.33, -0.02);
  g.moveTo(0.22, -0.42);
  g.bezierCurveTo(0.35, -0.3, 0.34, -0.06, 0.22, 0.06);
  // Trouser legs over the front of the stack, splayed.
  g.moveTo(-0.11, 0.0);
  g.bezierCurveTo(-0.15, 0.12, -0.18, 0.26, -0.16, 0.39);
  g.moveTo(0.11, 0.0);
  g.bezierCurveTo(0.17, 0.11, 0.24, 0.24, 0.24, 0.37);
}

/** The whole guy, filled and stroked in whatever `fillStyle` / `strokeStyle` are. */
function traceGuy(g, tilt) {
  guyBodies(g);
  g.save();
  g.translate(0.03, -0.52);
  g.rotate(tilt);
  guyHead(g);
  g.restore();
  g.fill();
  guyLimbs(g);
  g.lineWidth = 0.13;
  g.lineCap = 'round';
  g.stroke();
}

const bonfire = {
  id: 'bonfire',
  name: 'Bonfire',
  category: 'celebration',
  scope: 'shape',
  description:
    'A built pyre of crossed logs with flame rising through it, sparks lifting on the thermal and firelight flickering onto the wall. With “Guy on top” a stuffed guy sits slumped on the stack and burns down over the evening.',
  params: [
    { key: 'coreTemp', type: 'range', label: 'Core temperature (K)', default: 1900, min: 900, max: 4000, step: 25 },
    { key: 'tipTemp', type: 'range', label: 'Tip temperature (K)', default: 1000, min: 800, max: 2600, step: 25 },
    { key: 'height', type: 'range', label: 'Flame height', default: 0.72, min: 0.1, max: 1.4, step: 0.01 },
    { key: 'width', type: 'range', label: 'Fire width', default: 0.62, min: 0.1, max: 1.4, step: 0.01 },
    { key: 'speed', type: 'range', label: 'Speed', default: 1, min: 0.05, max: 4, step: 0.05 },
    { key: 'turbulence', type: 'range', label: 'Turbulence', default: 0.7, min: 0, max: 2, step: 0.01 },
    { key: 'detail', type: 'range', label: 'Detail', default: 56, min: 16, max: 130, step: 2 },
    { key: 'logs', type: 'range', label: 'Logs', default: 9, min: 0, max: 30, step: 1 },
    { key: 'logColor', type: 'color', label: 'Log colour', default: '#2a1a12' },
    { key: 'embers', type: 'range', label: 'Embers', default: 90, min: 0, max: 400, step: 5 },
    { key: 'smoke', type: 'range', label: 'Smoke', default: 0.5, min: 0, max: 2, step: 0.01 },
    { key: 'spill', type: 'range', label: 'Firelight on the wall', default: 1, min: 0, max: 3, step: 0.05 },
    { key: 'guy', type: 'bool', label: 'Guy on top', default: false },
    { key: 'burn', type: 'range', label: 'Guy burns over (s)', default: 90, min: 5, max: 900, step: 5 },
    { key: 'seed', type: 'range', label: 'Stack', default: 3, min: 1, max: 40, step: 1 },
  ],
  init() {
    return {
      embers: [], count: 0, logs: null, logKey: '', sprites: null, spriteKey: '',
    };
  },
  /**
   * The stack, and the embers.
   *
   * The pyre is laid once and then stays put — a bonfire that reshuffles its
   * logs every frame is a bonfire nobody built. It is cast here rather than in
   * `draw` for the usual reason: anything kept in `state` belongs to `step`,
   * and a stack laid from its own seeded generator comes out the same in every
   * tab however many frames each has painted.
   */
  step({ p, shape, t, dt, rng, state, noise, stable }) {
    const { bbox } = shape;
    if (bbox.w <= 4 || bbox.h <= 4) return;

    const logCount = Math.round(clamp(p.logs, 0, 30));
    // Keyed off `stable`, never off `p` — any of these can be bound to an LFO,
    // and a key built from the modulated value misses on every single frame.
    const key = `${logCount}:${stable.seed}:${Math.round(bbox.w)}x${Math.round(bbox.h)}`;
    if (state.logKey !== key) {
      state.logKey = key;
      const lay = makeRng(`pyre:${shape.id}:${stable.seed}`);
      state.logs = Array.from({ length: logCount }, (_, i) => {
        /**
         * Leaned in from alternating sides and crossed over at the top: a
         * tepee, which is how anybody who has built one actually builds one.
         *
         * Each log is set by where its foot is and where its top end is,
         * rather than by an angle, because the thing that makes a stack read
         * as a stack is that the tops *cross* — every log carries on past the
         * middle and over its neighbours from the other side, and the apex is
         * a tangle of crossed ends with the guy sat in it. Lean the logs by an
         * angle and the tops land wherever the arithmetic puts them; the first
         * version of this splayed them into a starburst of bright bars.
         */
        const side = i % 2 === 0 ? -1 : 1;
        const outward = 0.22 + 0.78 * Math.pow((i + 0.5) / logCount, 0.8);
        return {
          side,
          foot: side * outward * (0.82 + lay() * 0.18),
          top: -side * (0.06 + lay() * 0.32),
          rise: 0.8 + lay() * 0.28 - outward * 0.12,
          thick: 0.72 + lay() * 0.5,
          bend: (lay() - 0.5) * 0.1,
          // How far into the fire it sits: deep logs are half lost in flame,
          // near ones are black against it.
          depth: lay(),
          crack: [0.2 + lay() * 0.25, 0.5 + lay() * 0.3],
          phase: lay() * 100,
        };
      });
      // Deepest first, so the near logs cross over the far ones.
      state.logs.sort((a, b) => b.depth - a.depth);
    }

    const target = Math.round(clamp(p.embers, 0, 400));
    if (!(target > 0)) {
      state.embers.length = 0;
      state.count = 0;
      return;
    }

    const base = bbox.y + bbox.h * 0.92;
    const spawn = (e) => {
      e.x = bbox.cx + (rng() - 0.5) * bbox.w * p.width * 0.6;
      e.y = base - bbox.h * (0.05 + rng() * 0.25);
      // Straight up out of the hottest part, fast, and then the thermal lets go
      // of them — which is the `vy` decay in the loop below.
      e.vy = -bbox.h * (0.35 + rng() * 0.55);
      e.wind = (rng() - 0.5) * bbox.w * 0.12;
      e.vx = e.wind;
      e.life = 1.2 + rng() * 2.6;
      e.age = 0;
      e.drift = rng() * 100;
      e.seed = rng();
      return e;
    };

    if (state.count !== target) {
      while (state.embers.length < target) {
        /**
         * Staggered on the first fill, and it has to be done *after* `spawn`
         * rather than by handing it an age: spawn assigns `age = 0` along with
         * everything else, so a seeded age passed in was silently discarded and
         * the whole first population lifted off the fire in one sheet.
         */
        const born = spawn({});
        born.age = rng() * born.life;
        state.embers.push(born);
      }
      state.embers.length = target;
      state.count = target;
    }

    const step = dt * p.speed;
    for (const e of state.embers) {
      e.age += step;
      if (e.age >= e.life) spawn(e);
      /**
       * Carried by the air rather than steered.
       *
       * The plume above a fire is not laminar, and an ember that rises in a
       * straight line looks like a tracer round. Its sideways speed relaxes
       * towards the swirl of the air it is in, a quarter of a second behind,
       * which is what something that weighs nothing does — and keeping the
       * result as its velocity is what lets `draw` streak it along the way it
       * is actually going.
       */
      const swirl = noise.noise3(e.x * 0.005, e.y * 0.005, t * 0.5 + e.drift);
      e.vx += (e.wind + swirl * bbox.w * 0.3 - e.vx) * Math.min(1, 4 * step);
      e.x += e.vx * step;
      e.y += e.vy * step;
      e.vy *= 1 - 0.55 * step;
    }
  },
  draw({ g, p, shape, t, state, noise, stable }) {
    const { bbox } = shape;
    if (bbox.w <= 4 || bbox.h <= 4) return;

    const base = bbox.y + bbox.h * 0.92;
    const pyreH = bbox.h * 0.34;
    const halfW = bbox.w * 0.5 * p.width;
    const cx = bbox.cx;
    // Two rates of flicker, because a fire's light has both: the slow heave of
    // the whole blaze, and the quick stutter of the flames on top of it.
    const flicker = 0.78 + 0.22 * noise.noise2(t * 2.3, 0) + 0.1 * noise.noise2(t * 9, 4.2);
    const sprites = fireSprites(state, stable);
    const guy = p.guy ? guyPlacement(bbox, base, pyreH, t, p, noise) : null;

    g.save();
    g.globalCompositeOperation = 'lighter';
    const alpha0 = g.globalAlpha;

    /* --- Firelight on the house --- */

    if (p.spill > 0) {
      // Sized off the larger dimension: a fire in a doorway throws its light
      // as far as one in a garden does, and scaling the spill by the width of
      // a door makes it a puddle. Centred low, where the fire is brightest.
      const reach = Math.max(bbox.w, bbox.h) * (0.8 + 0.45 * Math.min(2, p.spill));
      stamp(g, sprites.spill, cx, base - pyreH * 0.6, reach, Math.min(1, 0.9 * p.spill) * flicker);
    }

    /* --- The flame --- */

    const front = flameFields(state, p, bbox, base, t, noise, flicker, guy);
    state.field.blit(g, bbox.x, bbox.y, bbox.w, bbox.h);

    /* --- The stack --- */

    if (state.logs?.length) {
      // The heart of it: the gaps between the logs are the brightest thing in
      // the frame, and they are what make the stack read as burning rather
      // than as a pile of sticks with a fire drawn behind it.
      stamp(g, sprites.heart, cx, base - pyreH * 0.32, halfW * 1.05, 0.9 * flicker);
      drawLogs(g, p, state.logs, cx, base, pyreH, halfW, t, noise, flicker);
      // The bed of embers the whole thing stands in, in front of the feet of
      // the logs: the one part of a bonfire that is brighter than its flame.
      const bed = halfW * 1.15;
      const deepBed = bbox.h * 0.05;
      g.globalAlpha = alpha0 * Math.min(1, 0.95 * flicker);
      g.drawImage(sprites.heart, cx - bed, base - deepBed * 1.1, bed * 2, deepBed * 2);
      g.globalAlpha = alpha0;
    }

    /* --- The guy --- */

    if (guy) {
      // The fire behind him lights the air round him, so he stands out of a
      // glow rather than out of a patchwork of tongues — which is what makes a
      // silhouette readable from the far side of a field.
      const chest = guy.y + guy.unit * (guy.sink - 0.4);
      stamp(g, sprites.heart, guy.x, chest, guy.unit * 1.05, 0.55 * flicker * (1 - guy.burn));
      drawGuy(g, guy, p);
    }

    /**
     * Flame in front.
     *
     * The same field again, weighted to the bottom of the fire: the flames
     * licking up the front of the stack and over the guy's legs. Drawn after
     * the logs and the guy, it puts them *in* the fire rather than in front of
     * it — the near logs half lost in light at their feet and black against it
     * higher up, which is what gives a flat picture of a bonfire its depth.
     */
    if (front) {
      g.globalCompositeOperation = 'lighter';
      state.front.blit(g, bbox.x, bbox.y, bbox.w, bbox.h);
    }

    /* --- Embers --- */

    if (state.embers.length) {
      strokeSparks(g, state.embers, {
        hotTemp: 2600,
        coolTemp: 1100,
        tint: '#ffe2b0',
        size: Math.max(2.4, Math.min(bbox.w, bbox.h) * 0.021),
        level: 1,
        maxLen: bbox.h * 0.12,
        shutter: 0.05,
        twinkle: 1.2,
      });
    }

    /* --- Smoke --- */

    if (p.smoke > 0) drawSmoke(g, p, bbox, base, t, noise, flicker);

    g.restore();
  },
};

/**
 * The flame, as two density fields filled in one pass.
 *
 * The first is the whole fire. The second is the same fire weighted to its
 * lower part, for drawing back over the logs and the guy — see `draw`. Filling
 * both from the one evaluation costs a second write per cell and nothing else.
 *
 * Returns whether the front field has anything in it.
 */
function flameFields(state, p, bbox, base, t, noise, flicker, guy) {
  const cols = Math.max(8, Math.round(p.detail));
  const rows = Math.max(8, Math.round((cols * bbox.h) / bbox.w));
  const field = ensureField(state, 'field', cols, rows);
  const front = ensureField(state, 'front', cols, rows);
  field.clear();
  front.clear();

  const scroll = t * p.speed;
  const wander = noise.noise2(t * 0.5, 3.3) * 0.1;
  // The fire sits on the pyre rather than on the bottom of the box.
  const seat = (base - bbox.y) / bbox.h;
  const height = Math.max(0.05, p.height);
  // Where the flame in front stops: just above the stack, or just above the
  // guy's seat once he is sat on it, so that it licks over his legs and leaves
  // the rest of him a clean shape against the fire.
  const pyreTop = 0.34;
  const frontTop = guy ? (base - guy.y) / bbox.h + 0.05 : pyreTop + 0.06;
  const hot = p.coreTemp;
  const cool = p.tipTemp;
  let anyFront = false;

  for (let y = 0; y < rows; y++) {
    const v = (y + 0.5) / rows;
    const hh = seat - v;
    if (hh < -0.03 || hh > height * 1.35) continue;

    // A bonfire is not a candle: it is wide at the bottom and stays wide for
    // a good part of its height before it necks in and breaks up.
    const taper = Math.max(0.06, 1 - Math.pow(Math.max(0, hh) / height, 1.6) * 0.85);
    const halfWidth = Math.max(0.02, p.width * 0.5 * taper);
    // The fuel the flame has at this height, before any noise: the most the
    // density here could be. Anything that cannot reach the threshold is
    // skipped *before* the noise is evaluated, which is most of the cost.
    const supply = Math.pow(Math.max(0, 1 - Math.max(0, hh) / height), 0.7);
    const ceiling = supply * 2.5 - hh * 0.22;
    if (ceiling <= 0.03) continue;
    // The very bottom is the ember bed, not a hard edge of flame on the ground.
    const floor = smoothstep(-0.04, 0.025, hh);
    // A fire burns hardest at the bottom of the stack, and the flame licking
    // up the front of it is drawn back over the logs; it fades out above.
    const frontWeight = 0.4 * smoothstep(-0.03, 0.08, hh) * (1 - smoothstep(frontTop - 0.1, frontTop, hh));

    let warpX = 0;
    let warpY = 0;
    let warpAt = -2;
    for (let x = 0; x < cols; x++) {
      const u = (x + 0.5) / cols;
      const dx = (u - 0.5 - wander * hh) / halfWidth;
      if (dx * dx > 4.4) continue;
      const profile = Math.exp(-dx * dx * 1.2) * floor;
      if (ceiling * profile <= 0.03) continue;

      // Domain warp, so tongues curl over rather than rising as straight
      // columns. It is the lowest-frequency thing in here, so it is worked out
      // on every other column and held for the next — half the warp lookups
      // for a difference no projector can show.
      if (x - warpAt >= 2) {
        warpAt = x;
        warpX = noise.noise3(u * 2.1, hh * 1.5 - scroll * 0.3, 7.7) * p.turbulence * 0.4;
        warpY = noise.noise3(u * 1.9 + 4.2, hh * 1.7 - scroll * 0.45, 2.3) * p.turbulence * 0.3;
      }
      const n1 = noise.noise3((u + warpX) * 3.0, (hh + warpY) * 2.3 - scroll, scroll * 0.22);
      const n2 = noise.noise3((u + warpX) * 6.8, (hh + warpY) * 4.8 - scroll * 1.6, scroll * 0.35);
      const detail = 0.5 + 0.36 * n1 + 0.18 * n2;

      let density = profile * supply * detail * 2.4 - hh * 0.22;
      if (density <= 0.03) continue;
      /**
       * Sharpened, so the flame has tongues and gaps rather than a glow with
       * texture on it. A fire's edges are where the fuel meets the air and
       * burns out, and that boundary is thin — a soft ramp from dense to empty
       * is smoke, not flame.
       */
      density = smoothstep(0.03, 0.62, density);

      // Hottest where it is densest and lowest; the tips cool towards red,
      // which is why the colour ramp comes out right without a palette.
      const kelvin = lerp(cool, hot, clamp(density * 1.15 - Math.max(0, hh) * 0.9, 0, 1));
      const [r, gg, b] = blackbodyBytes(kelvin);
      const alpha = clamp(density * 1.05, 0, 1) * flicker;
      field.set(x, y, r, gg, b, alpha);
      if (frontWeight > 0.005) {
        front.set(x, y, r, gg, b, alpha * frontWeight);
        anyFront = true;
      }
    }
  }
  return anyFront;
}

/**
 * The logs, near ones last.
 *
 * Each is drawn as what it is on a projector: an absence of light the shape of
 * a log, with light on it only where the fire reaches it. A rim along the edge
 * that faces into the fire, a couple of cracks glowing through the char, and
 * the deep ones only half there — painted at partial strength, so the flame
 * behind them shows through as if through the gaps in the stack. Nothing here
 * is a fill of colour, because a lit log is not a brown rectangle; it is a
 * black one with a burning edge.
 */
function drawLogs(g, p, logs, cx, base, pyreH, halfW, t, noise, flicker) {
  const girth = Math.min(halfW * 2, pyreH * 1.6);
  const rimHot = blackbodyCss(lerp(p.tipTemp, p.coreTemp, 0.85));
  const crackHot = blackbodyCss(lerp(p.tipTemp, p.coreTemp, 0.6));
  const base0 = g.globalAlpha;
  for (const log of logs) {
    const fx = cx + log.foot * halfW;
    const fy = base;
    const tx = cx + log.top * halfW;
    const ty = base - log.rise * pyreH;
    const len = Math.hypot(tx - fx, ty - fy) || 1;
    // Unit along the log (foot to top) and across it.
    const ax = (tx - fx) / len;
    const ay = (ty - fy) / len;
    const nx = -ay;
    const ny = ax;
    const t0 = Math.max(3, girth * 0.12 * log.thick);
    const t1 = t0 * 0.72;
    const bow = log.bend * len;
    const mx = (fx + tx) / 2 + nx * bow;
    const my = (fy + ty) / 2 + ny * bow;

    // The silhouette: tapered, slightly bowed, round at both ends.
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = base0 * lerp(0.95, 0.55, log.depth);
    g.fillStyle = p.logColor;
    g.beginPath();
    g.moveTo(fx + nx * t0 * 0.5, fy + ny * t0 * 0.5);
    g.quadraticCurveTo(mx + nx * (t0 + t1) * 0.25, my + ny * (t0 + t1) * 0.25, tx + nx * t1 * 0.5, ty + ny * t1 * 0.5);
    g.arc(tx, ty, t1 * 0.5, Math.atan2(ny, nx), Math.atan2(ny, nx) + Math.PI, true);
    g.quadraticCurveTo(mx - nx * (t0 + t1) * 0.25, my - ny * (t0 + t1) * 0.25, fx - nx * t0 * 0.5, fy - ny * t0 * 0.5);
    g.arc(fx, fy, t0 * 0.5, Math.atan2(-ny, -nx), Math.atan2(-ny, -nx) + Math.PI, true);
    g.closePath();
    g.fill();

    // The edge that faces the fire. Which side that is depends on which way
    // the log leans: the fire is towards the middle of the stack.
    const inward = (cx - (fx + tx) / 2) * nx >= 0 ? 1 : -1;
    const lit = (0.5 + 0.5 * (1 - log.depth)) * flicker;
    const rim = g.createLinearGradient(fx, fy, tx, ty);
    rim.addColorStop(0, rgba(rimHot, 0.85 * lit));
    rim.addColorStop(0.55, rgba(rimHot, 0.45 * lit));
    rim.addColorStop(1, rgba(rimHot, 0.12 * lit));
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = base0;
    g.strokeStyle = rim;
    g.lineCap = 'round';
    g.lineWidth = Math.max(1, t0 * 0.2);
    g.beginPath();
    const off = 0.36 * inward;
    g.moveTo(fx + nx * t0 * off, fy + ny * t0 * off);
    g.quadraticCurveTo(mx + nx * (t0 + t1) * off * 0.5, my + ny * (t0 + t1) * off * 0.5, tx + nx * t1 * off, ty + ny * t1 * off);
    g.stroke();

    // Cracks in the char, breathing with the fire.
    g.lineWidth = Math.max(1, t0 * 0.16);
    for (let c = 0; c < log.crack.length; c++) {
      const along = log.crack[c];
      const breathe = 0.55 + 0.45 * noise.noise2(t * 1.7 + log.phase + c * 3.1, 7.3);
      if (breathe <= 0.05) continue;
      const px = lerp(fx, tx, along) + nx * bow * 2 * along * (1 - along);
      const py = lerp(fy, ty, along) + ny * bow * 2 * along * (1 - along);
      const w = lerp(t0, t1, along) * 0.42;
      g.strokeStyle = rgba(crackHot, 0.75 * breathe * lit);
      g.beginPath();
      g.moveTo(px - nx * w + ax * w * 0.3, py - ny * w + ay * w * 0.3);
      g.lineTo(px + nx * w - ax * w * 0.2, py + ny * w - ay * w * 0.2);
      g.stroke();
    }
  }
  g.globalAlpha = base0;
  g.globalCompositeOperation = 'lighter';
}

/**
 * Where the guy sits, and how far gone he is.
 *
 * A function of show time, so a tab that joins late finds him at exactly the
 * same stage as every other tab rather than starting him again.
 */
function guyPlacement(bbox, base, pyreH, t, p, noise) {
  const burn = clamp(t / Math.max(1, p.burn), 0, 1);
  if (burn >= 1) return null;
  // Sized against the door rather than the stack, and capped by its width:
  // he is a full-sized guy on a full-sized fire, and in a narrow doorway that
  // means he fills it, not that he shrinks to fit the logs.
  const unit = Math.min(bbox.h * 0.3, bbox.w * 0.7);
  return {
    x: bbox.cx,
    y: base - pyreH * 0.86,
    unit,
    burn,
    /**
     * And he settles into the fire as he goes, in his own units.
     *
     * A guy does not burn away from the feet up while his top half hangs in
     * the air: what is left of him slumps down into the stack, lower and
     * further over, so the line he is burning at stays down in the flames.
     * Without it, the last thing on the fire is a hat floating over it.
     */
    sink: burn * 1.08,
    // Slumped to one side, and swaying a little in the heat.
    lean: -0.1 + noise.noise2(t * 0.35, 1.1) * 0.05,
    tilt: 0.32 + noise.noise2(t * 0.3, 5.7) * 0.06,
  };
}

/**
 * The guy, burning from the feet up.
 *
 * A silhouette rather than a figure: he is on top of a fire and behind a metre
 * of flame, and every detail beyond the outline is lost by the time it reaches
 * the street. What is *not* lost is the moment he starts to go, so the burn is
 * a rising line — below it he is gone, at it he is a glowing edge, above it he
 * is still a dark shape against the flame, lit dull red from underneath by the
 * fire he is sitting in.
 */
function drawGuy(g, guy, p) {
  const { unit, burn } = guy;
  // Where the char line has reached, in his own units: from the soles of his
  // boots (0.47 below the seat) to the top of his hat (1.0 above it).
  const line = 0.47 - burn * 1.5;

  g.save();
  g.translate(guy.x, guy.y + guy.sink * unit);
  g.rotate(guy.lean - burn * 0.35);
  g.scale(unit, unit);

  // Clip away everything the fire has already had, then draw what is left.
  g.save();
  g.beginPath();
  g.rect(-2, -2, 4, line + 2);
  g.clip();
  g.globalCompositeOperation = 'source-over';
  // Dark, warming towards his feet: the fire lights him from below.
  const body = g.createLinearGradient(0, -1, 0, 0.5);
  body.addColorStop(0, 'rgba(6,3,2,0.96)');
  body.addColorStop(0.55, 'rgba(14,6,3,0.95)');
  body.addColorStop(1, rgba(blackbodyCss(lerp(p.tipTemp, p.coreTemp, 0.2)), 0.5));
  g.fillStyle = body;
  g.strokeStyle = body;
  traceGuy(g, guy.tilt);
  g.restore();

  // The burning edge: a band of fire where the flame is eating him, hottest
  // at the line itself.
  if (burn > 0) {
    g.save();
    g.beginPath();
    g.rect(-2, line - 0.16, 4, 0.2);
    g.clip();
    g.globalCompositeOperation = 'lighter';
    const edge = g.createLinearGradient(0, line - 0.16, 0, line + 0.04);
    edge.addColorStop(0, rgba(blackbodyCss(1250), 0));
    edge.addColorStop(0.7, rgba(blackbodyCss(Math.max(p.coreTemp, 1800)), 0.75));
    edge.addColorStop(1, rgba(blackbodyCss(1400), 0));
    g.fillStyle = edge;
    g.strokeStyle = edge;
    traceGuy(g, guy.tilt);
    g.restore();
  }
  g.restore();
}

/**
 * Smoke, lit from underneath.
 *
 * A projector cannot draw grey smoke over a lit wall — grey is just less light
 * — so what it draws is the part of the smoke the fire is lighting: warm at
 * the bottom of the column where the flame is under it, fading to a dim cool
 * haze as it climbs out of the light. Seven slow soft blobs rather than a
 * second density field: smoke above a fire has no structure worth resolving
 * once it is out of the light, and this costs seven gradient fills instead of
 * another few thousand cells.
 */
function drawSmoke(g, p, bbox, base, t, noise, flicker) {
  const warm = blackbodyCss(lerp(p.tipTemp, p.coreTemp, 0.4));
  const BLOBS = 7;
  for (let i = 0; i < BLOBS; i++) {
    const phase = frac(t * 0.07 * p.speed + i / BLOBS);
    const y = base - bbox.h * (0.45 + phase * 1.2);
    // Leaning off downwind, and wandering as it goes.
    const x = bbox.cx + bbox.w * (0.25 * phase * phase + noise.noise2(phase * 2 + i * 1.7, t * 0.1) * 0.3);
    const r = bbox.w * (0.18 + phase * 0.55) * Math.max(0.4, p.width);
    const a = 0.09 * p.smoke * Math.sin(phase * Math.PI) * (1 - phase * 0.5);
    if (a <= 0.002) continue;
    // Firelit near the flames, cooling to a dim neutral haze above.
    const lit = (1 - phase) * (1 - phase);
    const colour = mixLinear('#5d6068', warm, lit * flicker);
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, rgba(colour, a));
    grad.addColorStop(0.5, rgba(colour, a * 0.45));
    grad.addColorStop(1, rgba(colour, 0));
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
  }
}

/* ------------------------------------------------------------------ *
 * Sparks, as the streaks they leave
 * ------------------------------------------------------------------ */

/**
 * How long a spark's streak is, in seconds of its own flight.
 *
 * A spark is a point. What anybody actually sees — and what a photograph of a
 * firework shows — is the line it draws in the fraction of a second the eye
 * holds it, and that line is the only thing in a still that says how fast it
 * was going. Drawn as dots, the same shower is a scatter of grit; drawn as the
 * streaks they leave, it is a jet.
 */
const SPARK_SHUTTER = 0.07;

/**
 * A streak, cut into three, head first: where each piece starts and ends as a
 * fraction of the streak behind the head, and how bright it is.
 *
 * The taper is the persistence again — the eye's hold on where the spark was a
 * moment ago is already letting go — and it is what makes a streak read as a
 * thing moving *forwards* rather than as a dash.
 */
const STREAK = [
  [0, 0.24, 1],
  [0.24, 0.58, 0.5],
  [0.58, 1, 0.2],
];

/** Brightness classes the shower is stroked in. See `strokeSparks`. */
const HEAT_CLASSES = 8;

/**
 * A shower of sparks, stroked in a few dozen passes rather than one per spark.
 *
 * Every spark's streak is cut into a head, a middle and a tail, and each piece
 * goes into the path of the class it belongs to — its heat, from how far
 * through its life the spark is, and its place along the streak. Each class is
 * then stroked twice: a wide pass in the spark's blackbody colour, which is the
 * glow, and a thin one that is the spark itself. Forty-eight strokes for a
 * shower of a thousand, and every streak still runs from a hot head to a
 * cooling tail.
 *
 * Colour and brightness come apart on purpose. A spark cools fastest while it
 * is hottest — radiation goes as the fourth power of temperature — so it is
 * past white-gold and into yellow almost at once and lingers in orange; but it
 * stays *bright* for most of its flight and only gutters at the end. Fading
 * the two together gives a shower that is dim before it has gone anywhere.
 *
 * The youngest are bright enough that their cores burn out to `tint`. The
 * white-gold of a fresh spark is overexposure, not a hue: a 3000 K spark is
 * orange, and so is the halo round it, but at the brightness it leaves the
 * nozzle the middle of it is simply as white as the eye goes.
 *
 * The class boundary is dithered per spark by its `seed`, so a cohort born on
 * the same step does not dim in lock-step — which on a wall is a whole arm of
 * the shower visibly stepping down a notch at once.
 *
 * `cluster` draws each simulated spark as that many more fragments fanning
 * away from it as it flies, `fan` pixels a second apart. A real jet is
 * thousands of sparks; simulating every one is not the job, but a shower that
 * *looks* like a hundred dots is not a jet either, and fragments placed by the
 * spark's own seed cost a path segment each and remember nothing.
 */
function strokeSparks(g, sparks, look) {
  const count = Math.min(sparks.length, SPARK_SCRATCH);
  if (!count) return;
  const { hotTemp, coolTemp, tint, size, level, maxLen } = look;
  const shutter = look.shutter ?? SPARK_SHUTTER;
  const cluster = look.cluster | 0;
  const fan = look.fan || 0;
  const twinkle = look.twinkle || 0;

  // Sort every spark into its class once, rather than once per pass: the
  // passes below then only have to compare a byte.
  for (let i = 0; i < count; i++) {
    const s = sparks[i];
    const speed = Math.hypot(s.vx, s.vy);
    if (!(speed > 1e-3) || !(s.life > 0)) {
      SPARK_CLASS[i] = -1;
      continue;
    }
    const wink = twinkle ? twinkle * Math.sin(s.age * 19 + s.seed * 61) : 0;
    const cls = Math.floor((s.age / s.life) * HEAT_CLASSES + (s.seed - 0.5) * 0.9 + wink);
    SPARK_CLASS[i] = cls < 0 ? 0 : cls >= HEAT_CLASSES ? HEAT_CLASSES - 1 : cls;
    SPARK_UX[i] = s.vx / speed;
    SPARK_UY[i] = s.vy / speed;
    SPARK_LEN[i] = Math.min(maxLen, Math.max(1.5, speed * shutter));
  }

  const base = g.globalAlpha;
  g.lineCap = 'round';
  for (let h = 0; h < HEAT_CLASSES; h++) {
    const f = (h + 0.5) / HEAT_CLASSES;
    const heat = 1 - f;
    const body = blackbodyCss(lerp(coolTemp, hotTemp, Math.pow(heat, 1.6)));
    const core = heat > 0.55 ? mixLinear(body, tint, (heat - 0.55) / 0.45) : body;
    const bright = (1 - Math.pow(f, 2.2)) * level;
    for (let k = 0; k < STREAK.length; k++) {
      const from = STREAK[k][0];
      const to = STREAK[k][1];
      g.beginPath();
      let any = false;
      for (let i = 0; i < count; i++) {
        if (SPARK_CLASS[i] !== h) continue;
        const s = sparks[i];
        const ux = SPARK_UX[i];
        const uy = SPARK_UY[i];
        const len = SPARK_LEN[i];
        g.moveTo(s.x - ux * len * from, s.y - uy * len * from);
        g.lineTo(s.x - ux * len * to, s.y - uy * len * to);
        for (let c = 1; c <= cluster; c++) {
          // Sideways and a little ahead or behind, growing with age: the
          // fragments of one spark separate as they fly. Each a little slower
          // than the spark itself, so a shorter streak — fragments the same
          // length as their parent, side by side, are a comb.
          const across = (frac(s.seed * (37.13 + c * 11.31)) - 0.5) * 2;
          const ahead = frac(s.seed * (53.71 + c * 7.93)) - 0.5;
          const short = 0.45 + 0.45 * frac(s.seed * (19.19 + c * 3.71));
          const spread = fan * s.age;
          const ox = (-uy * across + ux * ahead) * spread;
          const oy = (ux * across + uy * ahead) * spread;
          g.moveTo(s.x - ux * len * short * from + ox, s.y - uy * len * short * from + oy);
          g.lineTo(s.x - ux * len * short * to + ox, s.y - uy * len * short * to + oy);
        }
        any = true;
      }
      if (!any) continue;
      const a = bright * STREAK[k][2];
      g.globalAlpha = base * Math.min(1, 0.32 * a);
      g.strokeStyle = body;
      g.lineWidth = size * (0.8 + 0.5 * heat) * (1 - 0.2 * k);
      g.stroke();
      g.globalAlpha = base * Math.min(1, a);
      g.strokeStyle = core;
      g.lineWidth = Math.max(0.8, size * 0.34 * (0.6 + 0.6 * heat) * (1 - 0.18 * k));
      g.stroke();
    }
  }
  g.globalAlpha = base;
}

/**
 * Per-spark scratch for `strokeSparks`, sized past the largest shower any
 * effect here allows. Module-level so a frame allocates nothing; one draw
 * finishes before the next begins, so they can be shared.
 */
const SPARK_SCRATCH = 4096;
const SPARK_CLASS = new Int8Array(SPARK_SCRATCH);
const SPARK_UX = new Float32Array(SPARK_SCRATCH);
const SPARK_UY = new Float32Array(SPARK_SCRATCH);
const SPARK_LEN = new Float32Array(SPARK_SCRATCH);

/**
 * A soft round light, baked once and stamped thereafter.
 *
 * `stops` are `[offset, hex, alpha]`. Coloured at bake time rather than tinted
 * at draw time, because a canvas has no cheap way to tint a sprite and a
 * gradient built per frame per light is exactly the cost the sprite saves.
 */
function bakeLight(px, stops) {
  const canvas = offscreen(px, px);
  const c = canvas.getContext('2d');
  const half = px / 2;
  const grad = c.createRadialGradient(half, half, 0, half, half, half);
  for (const [offset, colour, alpha] of stops) grad.addColorStop(offset, rgba(colour, alpha));
  c.fillStyle = grad;
  c.fillRect(0, 0, px, px);
  return canvas;
}

/** Stamp a baked light centred on a point, at a radius and a strength. */
function stamp(g, sprite, x, y, radius, alpha) {
  if (!(radius > 0) || !(alpha > 0.002)) return;
  const base = g.globalAlpha;
  g.globalAlpha = base * Math.min(1, alpha);
  g.drawImage(sprite, x - radius, y - radius, radius * 2, radius * 2);
  g.globalAlpha = base;
}

/* ------------------------------------------------------------------ *
 * Catherine wheel
 * ------------------------------------------------------------------ */

/** How long the eye holds a nozzle's flame as it sweeps the rim. */
const RING_SHUTTER = 0.065;

/**
 * Points along each nozzle's jet, and scratch space for them — module-level
 * so drawing allocates nothing. `draw` runs to completion before any other
 * wheel draws, so one buffer serves every instance.
 */
const JET_POINTS = 12;
const JET_X = new Float64Array(JET_POINTS * 6);
const JET_Y = new Float64Array(JET_POINTS * 6);

/**
 * The wheel's lights, baked from the colours it was given.
 *
 * Keyed on `stable`, never on `p`: a temperature bound to the microphone would
 * otherwise rebake four canvases sixty times a second. The sparks themselves
 * still follow the modulated values, so a bound temperature is not lost — only
 * the glows hold still.
 */
function wheelSprites(state, stable) {
  const key = `${stable.tint}|${stable.hotTemp}|${stable.coolTemp}`;
  if (state.spriteKey === key && state.sprites) return state.sprites;
  const tint = /^#[0-9a-f]{3,8}$/i.test(String(stable.tint)) ? stable.tint : '#ffe9b0';
  const hot = blackbodyCss(stable.hotTemp);
  const warm = blackbodyCss(lerp(stable.coolTemp, stable.hotTemp, 0.55));
  const cool = blackbodyCss(stable.coolTemp);

  // The jet: a tongue of burning gas leaving the nozzle, white where it leaves
  // and cooling along its length. Built from a row of overlapping soft discs,
  // shrinking and dimming, because a flame has no edge to draw.
  const jetW = 160;
  const jetH = 40;
  const jet = offscreen(jetW, jetH);
  const jc = jet.getContext('2d');
  jc.globalCompositeOperation = 'lighter';
  for (let k = 0; k < 16; k++) {
    const f = k / 15;
    const x = jetH * 0.5 + f * (jetW - jetH);
    const r = jetH * 0.5 * (1 - 0.7 * f);
    const colour = f < 0.2 ? tint : f < 0.55 ? hot : cool;
    const grad = jc.createRadialGradient(x, jetH / 2, 0, x, jetH / 2, r);
    grad.addColorStop(0, rgba(colour, 0.3 * (1 - f) ** 1.3));
    grad.addColorStop(1, rgba(colour, 0));
    jc.fillStyle = grad;
    jc.fillRect(x - r, jetH / 2 - r, r * 2, r * 2);
  }

  state.sprites = {
    // Light thrown on the wall round it, by everything at once.
    spill: bakeLight(128, [
      [0, warm, 0.62], [0.12, warm, 0.46], [0.28, warm, 0.28], [0.5, cool, 0.12],
      [0.75, cool, 0.04], [1, cool, 0],
    ]),
    // The disc of fire a spinning wheel makes of itself.
    disc: bakeLight(128, [
      [0, '#ffffff', 1], [0.1, tint, 0.92], [0.24, hot, 0.55], [0.45, warm, 0.2],
      [0.72, cool, 0.05], [1, cool, 0],
    ]),
    // A burning nozzle, and the hub.
    flare: bakeLight(64, [
      [0, '#ffffff', 1], [0.14, '#ffffff', 0.9], [0.3, tint, 0.55], [0.55, hot, 0.18], [1, hot, 0],
    ]),
    jet,
    jetW,
    jetH,
  };
  state.spriteKey = key;
  return state.sprites;
}

const catherineWheel = {
  id: 'catherine-wheel',
  name: 'Catherine Wheel',
  category: 'celebration',
  scope: 'shape',
  description:
    'A wheel pinned to the shape that catches, spins up, throws spiralling jets of sparks off its rim and burns out. Sparks leave tangentially, because that is what they do. Staggered across several shapes, the wheels light one after another.',
  params: [
    { key: 'radius', type: 'range', label: 'Wheel size', default: 0.3, min: 0.05, max: 1, step: 0.01 },
    { key: 'nozzles', type: 'range', label: 'Nozzles', default: 2, min: 1, max: 6, step: 1 },
    { key: 'hotTemp', type: 'range', label: 'Hot (K)', default: 3000, min: 1200, max: 9000, step: 50 },
    { key: 'coolTemp', type: 'range', label: 'Cool (K)', default: 1100, min: 800, max: 4000, step: 50 },
    { key: 'tint', type: 'color', label: 'Star colour', default: '#ffe9b0' },
    { key: 'sparks', type: 'range', label: 'Sparks / s', default: 260, min: 20, max: 900, step: 10 },
    { key: 'speed', type: 'range', label: 'Spark speed', default: 620, min: 60, max: 3000, step: 20 },
    { key: 'life', type: 'range', label: 'Spark life (s)', default: 0.75, min: 0.1, max: 4, step: 0.05 },
    { key: 'gravity', type: 'range', label: 'Gravity', default: 520, min: -500, max: 3000, step: 20 },
    { key: 'spin', type: 'range', label: 'Top speed (rev/s)', default: 3.2, min: 0.1, max: 12, step: 0.1 },
    { key: 'spinUp', type: 'range', label: 'Spins up over (s)', default: 1.4, min: 0.1, max: 10, step: 0.1 },
    { key: 'duration', type: 'range', label: 'Burns for (s)', default: 9, min: 1, max: 90, step: 0.5 },
    { key: 'repeat', type: 'range', label: 'Relights after (s)', default: 6, min: 0, max: 300, step: 1 },
    { key: 'size', type: 'range', label: 'Spark size', default: 3.5, min: 1, max: 20, step: 0.5 },
  ],
  init() {
    return {
      sparks: [], pool: [], angle: 0, omega: 0, lit: 0, cycle: null, age: 0, owed: 0,
      sprites: null, spriteKey: '',
    };
  },
  /**
   * Spin, and the sparks that come off it.
   *
   * The wheel's angle is integrated rather than computed from `t` because the
   * sparks have to be *released* at the angle the nozzle was pointing when they
   * left — so the two have to advance together, one step at a time, in the same
   * order in every tab.
   */
  step({ p, shape, age: layerAge, dt, rng, state, layer, i: index }) {
    const { bbox } = shape;
    const R = Math.min(bbox.w, bbox.h) * 0.5 * clamp(p.radius, 0.05, 1);
    if (R < 2) return;
    state.pool = state.pool || [];

    /**
     * Where in the light-burn-relight cycle we are.
     *
     * `repeat` of zero means one burn and then nothing, which is the shape a
     * trigger wants. Anything else loops, which is what an ambient layer wants,
     * and both come out of the same clock rather than out of a state machine.
     *
     * The clock is the layer's **age** and not show time, which matters
     * entirely for the one-shot case: `age` is seconds since the layer was
     * switched on, so a wheel fired from a trigger at nine in the evening
     * starts from rest, whereas show time had it burning out three hours
     * earlier and drawing nothing for the rest of the night.
     *
     * Less this shape's share of the layer's stagger. The renderer staggers
     * `t` but not `age` — age is how long the *layer* has been on — so a wheel
     * keyed on age alone lit on every window in the same instant, at the same
     * angle, with "staggered so they do not all light at once" written over the
     * preset that asked for the opposite. Taking the lag off here puts each
     * window's wheel that many seconds behind the last: a looping layer simply
     * runs each one at its own phase, and a one-shot lights them in turn.
     */
    const lag = (Number(layer?.stagger) || 0) * (Number(index) || 0);
    const clock = layerAge - lag;
    const period = p.repeat > 0 ? p.duration + p.repeat : Infinity;
    let cycle;
    let age;
    if (period === Infinity) {
      cycle = clock < 0 ? -1 : 0;
      age = clock;
    } else {
      cycle = Math.floor(clock / period);
      age = clock - cycle * period;
    }
    const burning = age >= 0 && age < p.duration;

    /**
     * A retrigger, which from in here is the age going backwards.
     *
     * Necessary on top of the cycle check because a one-shot has no cycles to
     * count: `repeat` of zero pins `cycle` at zero forever, so firing the same
     * trigger twice would otherwise pick the wheel up mid-spin with the last
     * burn's sparks still in the air.
     */
    if (state.cycle !== cycle || age < (state.age ?? 0)) {
      state.cycle = cycle;
      state.angle = 0;
      state.omega = 0;
      state.lit = 0;
      state.owed = 0;
      for (const s of state.sparks) state.pool.push(s);
      state.sparks.length = 0;
    }
    state.age = age;

    /**
     * Thrust, and the spin it produces.
     *
     * The nozzles are at full pressure within a quarter of a second of the
     * fuse reaching them, and they stay there until the composition runs out
     * over the last fifth of the burn — so the shower is thick from the start.
     * What takes `spinUp` is the *wheel*: thrust against air drag is a
     * first-order lag, so it accelerates hard and then levels off at its top
     * speed, and once the gerbs die it coasts down the same curve rather than
     * stopping dead, which reads as a video ending.
     */
    const thrust = burning
      ? smoothstep(0, 0.25, age) * (1 - smoothstep(p.duration * 0.8, p.duration, age))
      : 0;
    state.lit = thrust;
    const lagTime = Math.max(0.03, p.spinUp / 3);
    state.omega += (thrust * p.spin * TAU - state.omega) * Math.min(1, dt / lagTime);
    const before = state.angle;
    state.angle += state.omega * dt;
    const swept = state.angle - before;

    const nozzles = Math.round(clamp(p.nozzles, 1, 6));
    state.owed += burning ? p.sparks * thrust * dt : 0;
    const toSpawn = Math.floor(state.owed);
    state.owed -= toSpawn;
    const perNozzle = Math.ceil(toSpawn / nozzles);

    for (let k = 0; k < toSpawn; k++) {
      // Hard ceiling on the shower: a rate slider at nine hundred and a life
      // slider at four seconds is thirty-six hundred particles, which is a
      // dropped frame on every tab at once.
      if (state.sparks.length >= 1500) break;
      const n = k % nozzles;
      /**
       * Spread through the step's sweep rather than all cast at its end.
       *
       * At three turns a second the wheel moves twenty degrees between steps,
       * and a step's worth of sparks all leaving at the same angle is a row of
       * spokes — the jet comes out as a dotted line. Placing each one at the
       * angle the nozzle passed through partway along the sweep makes the
       * stream continuous, which is what a jet is.
       */
      const along = (Math.floor(k / nozzles) + 0.5) / perNozzle;
      const a = before + swept * along + (n / nozzles) * TAU;
      /**
       * Tangential, not radial — and backwards.
       *
       * This is the one thing everybody draws wrong. A gerb on the rim points
       * along the rim, and the sparks it blows out are its exhaust: they leave
       * along the tangent, at ninety degrees to the spoke, and *behind* the
       * nozzle — which is what pushes the wheel round. Sparks flying outwards
       * along the spoke give you a sea urchin; sparks leaving tangentially, from
       * a nozzle that has moved on by the time the next one leaves, give you
       * the spiral arms everybody has actually stood in front of.
       *
       * The rim's own speed is left out of it. On a real wheel it is a few
       * metres a second against the composition's twenty or thirty; here the
       * wheel is drawn at many times its real size and spun at its real rate,
       * so its rim speed would be a number that belongs to no firework at all.
       */
      const back = a - Math.PI / 2;
      const thrown = p.speed * (0.8 + rng() * 0.4);
      const s = state.pool.pop() || {};
      s.x = bbox.cx + Math.cos(a) * R;
      s.y = bbox.cy + Math.sin(a) * R;
      // A gerb's spray is a cone, not a line — but a narrow one. Spread the
      // speeds or the directions much further and the spiral arms smear into
      // each other and the wheel becomes a ball of sparks.
      s.vx = Math.cos(back) * thrown + (rng() - 0.5) * p.speed * 0.12;
      s.vy = Math.sin(back) * thrown + (rng() - 0.5) * p.speed * 0.12;
      s.age = 0;
      s.life = p.life * (0.5 + rng() * 0.8);
      s.size = 0.6 + rng() * 0.8;
      s.seed = rng();
      state.sparks.push(s);
    }

    const sparks = state.sparks;
    // Air drag: a millimetre of burning metal loses its speed in a fraction of
    // a second, which is why the sparks near the rim are fast streaks and the
    // ones at the edge of the shower are drifting motes.
    const drag = 1 - 2.2 * dt;
    for (let j = sparks.length - 1; j >= 0; j--) {
      const s = sparks[j];
      s.age += dt;
      if (s.age >= s.life) {
        // Swap-remove into the pool: the shower is born and dies at a few
        // hundred a second, and a splice per spark is a copy of the array.
        sparks[j] = sparks[sparks.length - 1];
        sparks.pop();
        state.pool.push(s);
        continue;
      }
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vy += p.gravity * dt;
      s.vx *= drag;
      s.vy *= drag;
    }
  },
  /**
   * The wheel, as the light it gives off.
   *
   * A catherine wheel going properly is not an object with sparks coming off
   * it; it is a blaze. The hub is white, the nozzles' flames are swept into a
   * ring of fire by the spin, everything within a wheel's width of it is lit to
   * a disc, and the wall round it takes the light. Then the jets, spiralling
   * out. All of it additive, because all of it is light, and all of it scaled by
   * the thrust, so the wheel catches, roars and gutters rather than switching.
   */
  draw({ g, p, shape, t, state, stable, noise }) {
    const { bbox } = shape;
    const R = Math.min(bbox.w, bbox.h) * 0.5 * clamp(p.radius, 0.05, 1);
    if (R < 2 || !state.sparks) return;

    const cx = bbox.cx;
    const cy = bbox.cy;
    const thrust = state.lit || 0;
    const sprites = wheelSprites(state, stable);
    // Gerbs sputter; the light they throw is never quite steady.
    const flutter = 0.84 + 0.16 * noise.noise2(t * 9.3, 2.7);

    g.save();
    g.globalCompositeOperation = 'lighter';

    if (thrust > 0.002) {
      stamp(g, sprites.spill, cx, cy, R * 8, thrust * flutter);
      stamp(g, sprites.disc, cx, cy, R * 2.4, 0.72 * thrust * flutter);
    }

    strokeSparks(g, state.sparks, {
      hotTemp: p.hotTemp,
      coolTemp: p.coolTemp,
      tint: p.tint,
      size: p.size,
      level: 1,
      maxLen: R * 3 + 60,
      cluster: 2,
      fan: p.speed * 0.18,
    });

    if (thrust > 0.002) {
      const nozzles = Math.round(clamp(p.nozzles, 1, 6));
      const hot = blackbodyCss(p.hotTemp);

      /**
       * The ring of fire.
       *
       * Each nozzle's flame, held by the eye as it sweeps the rim: an arc
       * that is brightest where the nozzle is now and fades back along where it
       * has been. It is what says "spinning" in a still, and it grows with the
       * spin, so a wheel winding up visibly gathers itself into a circle — but
       * never quite closes it: the gaps between the nozzles' arcs are what
       * keep a fast wheel a pinwheel rather than a ring.
       */
      const sweep = Math.min((state.omega || 0) * RING_SHUTTER, (TAU / nozzles) * 0.6);
      if (sweep > 0.01) {
        const PIECES = 5;
        const base = g.globalAlpha;
        g.lineCap = 'round';
        for (let k = 0; k < PIECES; k++) {
          g.beginPath();
          for (let n = 0; n < nozzles; n++) {
            const head = state.angle + (n / nozzles) * TAU;
            const a1 = head - (sweep * k) / PIECES;
            const a0 = head - (sweep * (k + 1)) / PIECES;
            g.moveTo(cx + Math.cos(a0) * R, cy + Math.sin(a0) * R);
            g.arc(cx, cy, R, a0, a1);
          }
          const fade = (1 - k / PIECES) ** 1.6 * thrust;
          g.globalAlpha = base * 0.45 * fade;
          g.strokeStyle = hot;
          g.lineWidth = R * 0.32 * (1 - 0.12 * k);
          g.stroke();
          g.globalAlpha = base * Math.min(1, 1.1 * fade);
          g.strokeStyle = p.tint;
          g.lineWidth = Math.max(1, R * 0.1 * (1 - 0.12 * k));
          g.stroke();
        }
        g.globalAlpha = base;
      }

      /**
       * The jets, where they are too thick to be separate sparks.
       *
       * The last tenth of a second of each nozzle's exhaust, drawn as the curve
       * it makes now: leaving backwards along the rim, then bowed outwards by
       * the turn the nozzle has made since each part of it left. That bend is
       * the whole signature of a catherine wheel — every spark in it flies in a
       * straight line, and the arm still curls, because the thing throwing
       * them has moved on. Worked out from the same speed and drag the sparks
       * are given, so the arm leads straight into the shower it feeds.
       */
      if (state.omega > 0.05) {
        const k = 2.2;
        const span = 0.12;
        for (let j = 0; j < JET_POINTS; j++) {
          const tau = (j / (JET_POINTS - 1)) * span;
          const reach = (p.speed * (1 - Math.exp(-k * tau))) / k;
          const drop = 0.5 * p.gravity * tau * tau;
          for (let n = 0; n < nozzles; n++) {
            const phi = state.angle + (n / nozzles) * TAU - state.omega * tau;
            const c = Math.cos(phi);
            const s = Math.sin(phi);
            JET_X[n * JET_POINTS + j] = cx + c * R + s * reach;
            JET_Y[n * JET_POINTS + j] = cy + s * R - c * reach + drop;
          }
        }
        const base = g.globalAlpha;
        g.lineCap = 'round';
        for (let j = 0; j < JET_POINTS - 1; j++) {
          g.beginPath();
          for (let n = 0; n < nozzles; n++) {
            const at = n * JET_POINTS + j;
            g.moveTo(JET_X[at], JET_Y[at]);
            g.lineTo(JET_X[at + 1], JET_Y[at + 1]);
          }
          const along = j / (JET_POINTS - 2);
          const fade = (1 - along) ** 1.3 * thrust;
          g.globalAlpha = base * 0.4 * fade;
          g.strokeStyle = hot;
          g.lineWidth = R * 0.26 * (1 - 0.55 * along);
          g.stroke();
          g.globalAlpha = base * Math.min(1, 0.9 * fade);
          g.strokeStyle = p.tint;
          g.lineWidth = Math.max(1, R * 0.08 * (1 - 0.5 * along));
          g.stroke();
        }
        g.globalAlpha = base;
      }

      // The nozzles: a flare at each, and the jet of flame blowing out of it
      // backwards along the rim — the exhaust the sparks are riding in.
      for (let n = 0; n < nozzles; n++) {
        const a = state.angle + (n / nozzles) * TAU;
        const nx = cx + Math.cos(a) * R;
        const ny = cy + Math.sin(a) * R;
        const len = R * (0.6 + 0.9 * thrust) * (0.9 + 0.2 * flutter);
        const wide = R * 0.42;
        g.save();
        g.translate(nx, ny);
        g.rotate(a - Math.PI / 2);
        g.globalAlpha *= Math.min(1, thrust * 1.2);
        const lead = (sprites.jetH * 0.5) / sprites.jetW;
        g.drawImage(sprites.jet, -len * lead, -wide / 2, len, wide);
        g.restore();
        stamp(g, sprites.flare, nx, ny, R * 0.62 * (0.85 + 0.3 * flutter), thrust);
      }

      // The hub: white at the pin, where the whole wheel overlaps itself.
      stamp(g, sprites.disc, cx, cy, R * 0.8, 0.8 * thrust);
      stamp(g, sprites.flare, cx, cy, R * 0.42, thrust);
    }

    // Spent: the casing smoulders a dull red for a few seconds after the last
    // nozzle dies, which is the bit of a wheel nobody films and everybody sees.
    const since = (state.age ?? -1) - p.duration;
    if (since >= 0 && since < 3) {
      const ember = 1 - since / 3;
      glow(g, cx, cy, R * 0.9, blackbodyCss(lerp(950, 1350, ember)), 0.35 * ember * ember);
    }

    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * Sparkler
 * ------------------------------------------------------------------ */

/** Brightness classes the after-image is stroked in. */
const TRAIL_CLASSES = 6;

/**
 * A soft round light straight from a gradient: `stops` are `[offset, hex,
 * alpha]`.
 *
 * For lights there are only a handful of a frame — a sparkler's heads — where
 * a gradient per light costs what the blit of a sprite would and needs no
 * canvas kept for it.
 */
function softLight(g, x, y, radius, alpha, stops) {
  if (!(radius > 0) || !(alpha > 0.002)) return;
  const grad = g.createRadialGradient(x, y, 0, x, y, radius);
  const a = Math.min(1, alpha);
  for (const [offset, colour, strength] of stops) grad.addColorStop(offset, rgba(colour, strength * a));
  g.fillStyle = grad;
  g.beginPath();
  g.arc(x, y, radius, 0, TAU);
  g.fill();
}

const sparkler = {
  id: 'sparkler',
  name: 'Sparkler',
  category: 'celebration',
  scope: 'shape',
  description:
    'A sparkler head running round the path, throwing forked iron sparks and leaving the glowing after-image you get from writing your name with one.',
  params: [
    { key: 'count', type: 'range', label: 'Sparklers', default: 1, min: 1, max: 6, step: 1 },
    { key: 'speed', type: 'range', label: 'Speed (laps/s)', default: 0.16, min: -2, max: 2, step: 0.005 },
    { key: 'hotTemp', type: 'range', label: 'Hot (K)', default: 3200, min: 1500, max: 9000, step: 50 },
    { key: 'coolTemp', type: 'range', label: 'Cool (K)', default: 1400, min: 800, max: 4000, step: 50 },
    { key: 'rate', type: 'range', label: 'Sparks / s', default: 180, min: 20, max: 900, step: 10 },
    { key: 'life', type: 'range', label: 'Spark life (s)', default: 0.42, min: 0.05, max: 2, step: 0.01 },
    { key: 'throw', type: 'range', label: 'Throw', default: 260, min: 20, max: 1500, step: 10 },
    { key: 'gravity', type: 'range', label: 'Gravity', default: 260, min: -500, max: 2000, step: 10 },
    { key: 'fork', type: 'range', label: 'Forking', default: 0.7, min: 0, max: 1, step: 0.01 },
    { key: 'head', type: 'range', label: 'Head size', default: 10, min: 2, max: 60, step: 1 },
    { key: 'trail', type: 'range', label: 'After-image (s)', default: 0.5, min: 0, max: 3, step: 0.05 },
    // Step 0.1, not 0.2: from a minimum of 0.5 a step of 0.2 lands on 2.5 and
    // 2.7, so the default of 2.6 was a value the slider could not return to
    // once anybody nudged it. Finer rather than moving the default, because
    // this way the sparkler still starts exactly where it always has.
    { key: 'size', type: 'range', label: 'Spark size', default: 2.6, min: 0.5, max: 12, step: 0.1 },
  ],
  init() {
    return { sparks: [], pool: [], trail: null, owed: 0 };
  },
  step({ p, shape, t, dt, rng, state, stable }) {
    const length = shape.sampler.length;
    if (length <= 0) return;
    state.pool = state.pool || [];

    const heads = Math.round(clamp(p.count, 1, 6));

    /**
     * The after-image, as a ring buffer of past head positions.
     *
     * A sparkler is bright enough to leave a real streak on the retina, which
     * is the entire reason children write their names with them. Keeping the
     * last half-second of positions and drawing them as a fading line is that
     * effect — not motion blur, which is what a camera does, but persistence,
     * which is what an eye does.
     *
     * A ring rather than an array that is pushed and shifted, because this runs
     * sixty times a second for the whole evening and a per-step allocation is
     * the one thing the effect contract asks you not to do. Sized from
     * `stable`, never from `p`: with the trail length bound to an LFO, a
     * capacity computed from the modulated value would reallocate every frame.
     */
    const cap = Math.max(2, Math.ceil(clamp(stable.trail, 0, 3) * 60) + 2);
    let ring = state.trail;
    if (!ring || ring.cap !== cap || ring.heads !== heads) {
      ring = state.trail = {
        cap,
        heads,
        len: 0,
        next: 0,
        times: new Float32Array(cap),
        xy: new Float32Array(cap * heads * 2),
      };
    }

    const slot = ring.next;
    ring.times[slot] = t;
    for (let i = 0; i < heads; i++) {
      // Closed shapes lap; open ones run to the end and come back, so a
      // sparkler along a gutter does not teleport home every few seconds.
      const u = shape.closed
        ? frac(t * p.speed + i / heads)
        : clamp(1 - Math.abs(1 - frac((t * p.speed + i / heads) * 0.5) * 2), 0, 1);
      const at = shape.sampler.at(u);
      ring.xy[(slot * heads + i) * 2] = at.x;
      ring.xy[(slot * heads + i) * 2 + 1] = at.y;
    }
    ring.next = (slot + 1) % cap;
    ring.len = Math.min(ring.len + 1, cap);

    state.owed += p.rate * dt;
    const toSpawn = Math.floor(state.owed);
    state.owed -= toSpawn;

    // Bounded: the rate and life sliders multiply, and a few thousand live
    // sparks is already more than the wall can resolve.
    const LIMIT = 2000;
    const sparks = state.sparks;
    const take = () => {
      const s = state.pool.pop() || {};
      sparks.push(s);
      return s;
    };

    // Where each head was a step ago, for the speed the sparks inherit.
    const prev = (slot - 1 + cap) % cap;
    const moving = ring.len > 1;
    for (let i = 0; i < toSpawn && sparks.length < LIMIT; i++) {
      const head = i % heads;
      const hx = ring.xy[(slot * heads + head) * 2];
      const hy = ring.xy[(slot * heads + head) * 2 + 1];
      // A spark leaves the wire with the wire's own speed as well as its own,
      // so a sparkler swept along a gutter sprays forwards, not evenly.
      const hvx = moving ? (hx - ring.xy[(prev * heads + head) * 2]) / dt : 0;
      const hvy = moving ? (hy - ring.xy[(prev * heads + head) * 2 + 1]) / dt : 0;
      const a = rng() * TAU;
      const v = p.throw * (0.25 + rng() * 0.9);
      const s = take();
      s.x = hx;
      s.y = hy;
      s.vx = Math.cos(a) * v + (Number.isFinite(hvx) ? clamp(hvx, -2000, 2000) : 0);
      s.vy = Math.sin(a) * v + (Number.isFinite(hvy) ? clamp(hvy, -2000, 2000) : 0);
      s.age = 0;
      s.life = p.life * (0.5 + rng() * 0.9);
      s.size = 0.6 + rng() * 0.8;
      s.seed = rng();
      /**
       * When this one bursts.
       *
       * The forks are the whole signature of a sparkler, and they are not
       * decoration: the wire is coated in iron filings, each filing burns
       * from the outside in, and when the molten shell fails the trapped
       * gas inside blows it apart into a little starburst. That is why the
       * sparks divide *partway along their flight* rather than at the wire.
       */
      s.burst = p.fork > 0 && rng() < p.fork ? 0.35 + rng() * 0.3 : -1;
      s.forked = false;
      s.gen = 0;
    }

    // Swap-removed into the pool rather than spliced: a few hundred sparks
    // are born and die every second, and a splice per spark copies the array.
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.age += dt;
      if (s.age >= s.life) {
        sparks[i] = sparks[sparks.length - 1];
        sparks.pop();
        state.pool.push(s);
        continue;
      }
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vy += p.gravity * dt;
      const drag = 1 - 3.4 * dt;
      s.vx *= drag;
      s.vy *= drag;

      if (!s.forked && s.burst > 0 && s.age / s.life > s.burst && sparks.length < LIMIT) {
        s.forked = true;
        const shards = 2 + Math.floor(rng() * 3);
        const speed = Math.hypot(s.vx, s.vy);
        const heading = Math.atan2(s.vy, s.vx);
        for (let k = 0; k < shards && sparks.length < LIMIT; k++) {
          const spread = (rng() - 0.5) * 2.2;
          const boost = 0.6 + rng() * 0.8;
          const shard = take();
          shard.x = s.x;
          shard.y = s.y;
          shard.vx = Math.cos(heading + spread) * speed * boost;
          shard.vy = Math.sin(heading + spread) * speed * boost;
          shard.age = 0;
          shard.life = (s.life - s.age) * (0.5 + rng() * 0.6);
          shard.size = s.size * 0.75;
          shard.seed = rng();
          shard.gen = s.gen + 1;
          // A shard can burst again — real sparkler sparks branch two and
          // three deep, which is what makes the halo look like frost on a
          // window rather than like a dandelion clock. Only the first-born
          // sparks' shards, and only some of them.
          const again = s.gen === 0 && rng() < p.fork * 0.35;
          shard.burst = again ? 0.4 + rng() * 0.3 : -1;
          shard.forked = !again;
        }
      }
    }
  },
  /**
   * The after-image, the sparks, and the head over them.
   *
   * All of it light: a pool of it on the wall round the head, the streak the
   * eye holds behind it, the sparks as the lines they leave, and the head
   * itself last — burning iron is close enough to white that the core
   * saturates, and everything around it takes its colour from how far down
   * the curve it has already fallen.
   */
  draw({ g, p, t, state, noise }) {
    const ring = state.trail;
    if (!state.sparks || !ring) return;
    const hot = blackbodyCss(p.hotTemp);
    const warm = blackbodyCss(lerp(p.coolTemp, p.hotTemp, 0.5));

    g.save();
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';
    const base = g.globalAlpha;

    const posX = (j, head) => ring.xy[(((ring.next - ring.len + j + ring.cap * 2) % ring.cap) * ring.heads + head) * 2];
    const posY = (j, head) => ring.xy[(((ring.next - ring.len + j + ring.cap * 2) % ring.cap) * ring.heads + head) * 2 + 1];
    const timeAt = (j) => ring.times[(ring.next - ring.len + j + ring.cap * 2) % ring.cap];

    // Light on the wall round each head, flaring with the head's sputter.
    if (ring.len > 0) {
      for (let head = 0; head < ring.heads; head++) {
        const sputter = 0.8 + 0.2 * noise.noise2(t * 13 + head * 7.1, 1.3);
        softLight(g, posX(ring.len - 1, head), posY(ring.len - 1, head), p.head * 9, 0.75 * sputter, [
          [0, hot, 0.6], [0.15, hot, 0.42], [0.35, warm, 0.18], [0.6, warm, 0.05], [1, warm, 0],
        ]);
      }
    }

    /**
     * The after-image, oldest first so the bright end is drawn last.
     *
     * Batched by how faded it is, a handful of strokes for the whole trail
     * however long it is, and cooling as it fades — so the tail of the stroke
     * goes red rather than merely dim, on the same curve the sparks are on.
     */
    if (p.trail > 0 && ring.len > 1) {
      for (let c = 0; c < TRAIL_CLASSES; c++) {
        g.beginPath();
        let any = false;
        for (let head = 0; head < ring.heads; head++) {
          for (let j = 1; j < ring.len; j++) {
            const fade = clamp(1 - (t - timeAt(j)) / p.trail, 0, 1);
            if (fade <= 0.01) continue;
            if (Math.min(TRAIL_CLASSES - 1, Math.floor(fade * TRAIL_CLASSES)) !== c) continue;
            g.moveTo(posX(j - 1, head), posY(j - 1, head));
            g.lineTo(posX(j, head), posY(j, head));
            any = true;
          }
        }
        if (!any) continue;
        const fade = (c + 0.5) / TRAIL_CLASSES;
        const colour = blackbodyCss(lerp(p.coolTemp, p.hotTemp, fade * fade));
        g.globalAlpha = base * 0.3 * fade;
        g.strokeStyle = colour;
        g.lineWidth = Math.max(1, p.head * 0.55 * fade);
        g.stroke();
        g.globalAlpha = base * Math.min(1, 0.9 * fade * fade);
        g.strokeStyle = fade > 0.6 ? mixLinear(colour, '#ffffff', (fade - 0.6) * 1.5) : colour;
        g.lineWidth = Math.max(0.8, p.head * 0.2 * fade);
        g.stroke();
      }
      g.globalAlpha = base;
    }

    strokeSparks(g, state.sparks, {
      hotTemp: p.hotTemp,
      coolTemp: p.coolTemp,
      tint: '#fff4dc',
      size: p.size,
      level: 1,
      maxLen: p.throw * 0.2 + 4,
      shutter: 0.085,
      twinkle: 0.5,
      cluster: 1,
      fan: p.throw * 0.3,
    });

    /**
     * The bursts.
     *
     * A spark blowing apart flashes as it goes — the trapped gas and the
     * fresh metal both — and the flash is what makes a sparkler *crackle* to
     * look at as well as to listen to. A shard in its first few hundredths of
     * a second is still sitting on the point its parent burst at, so a bright
     * bead on each of those is that flash: zero-length strokes with round
     * ends, one path and one stroke for all of them. The shards' own streaks,
     * leaving it in three or four directions, draw the star.
     */
    g.beginPath();
    let flashes = false;
    for (const s of state.sparks) {
      if (!(s.gen > 0) || s.age > 0.03) continue;
      g.moveTo(s.x, s.y);
      g.lineTo(s.x + 0.01, s.y);
      flashes = true;
    }
    if (flashes) {
      g.globalAlpha = base * 0.9;
      g.strokeStyle = '#fff1d6';
      g.lineWidth = Math.max(1.2, p.size * 0.9);
      g.stroke();
      g.globalAlpha = base;
    }

    // The head last, over its own sparks, sputtering.
    if (ring.len > 0) {
      for (let head = 0; head < ring.heads; head++) {
        const x = posX(ring.len - 1, head);
        const y = posY(ring.len - 1, head);
        const sputter = 0.8 + 0.2 * noise.noise2(t * 13 + head * 7.1, 1.3);
        // White, because nothing that bright has a colour, with the iron's own
        // colour only in the skirt.
        softLight(g, x, y, p.head * 2.6 * sputter, 1, [
          [0, '#ffffff', 1], [0.12, '#ffffff', 0.95], [0.26, hot, 0.6], [0.5, hot, 0.2], [1, warm, 0],
        ]);
        softLight(g, x, y, p.head * 0.9, 1, [[0, '#ffffff', 1], [0.4, '#ffffff', 0.9], [1, hot, 0]]);
      }
    }

    g.restore();
  },
};

export default [bonfire, catherineWheel, sparkler];
