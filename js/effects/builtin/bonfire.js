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

import { rgba, clamp, lerp, TAU, frac, makeRng } from '../../core/math.js';
import { blackbodyCss, blackbodyBytes, ensureField, glow } from '../lib.js';

/* ------------------------------------------------------------------ *
 * Bonfire
 * ------------------------------------------------------------------ */

const bonfire = {
  id: 'bonfire',
  name: 'Bonfire',
  category: 'celebration',
  scope: 'shape',
  description:
    'A built pyre with flame rising out of it, embers lifting on the thermal and firelight flickering onto the wall. With “Guy on top” it burns down over the evening.',
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
    return { embers: [], count: 0, logs: null, logKey: '' };
  },
  /**
   * The stack, and the embers.
   *
   * The pyre is laid once and then stays put — a bonfire that reshuffles its
   * logs every frame is a bonfire nobody built. It is cast here rather than in
   * `draw` for the usual reason: `rng` is seeded from the simulation step, and
   * which step the first frame lands on depends on the frame rate, so two tabs
   * would lay two different stacks.
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
        // Leaned in from alternating sides, longest at the outside: a tepee,
        // which is how anybody who has built one actually builds one.
        const side = i % 2 === 0 ? -1 : 1;
        const spread = 0.15 + (i / Math.max(1, logCount)) * 0.85;
        return {
          side,
          foot: side * spread * (0.35 + lay() * 0.2),
          /**
           * Leaning *in*, towards the middle.
           *
           * The sign matters more than it looks: with it the wrong way round
           * the stack splays outwards into a V, the tops go nowhere near each
           * other, and what you get is not a tepee with a fire in it but a
           * starburst of bright bars — which is exactly what the first version
           * of this drew.
           */
          lean: -(0.35 + lay() * 0.5) * side,
          length: 0.55 + lay() * 0.45,
          thick: 0.5 + lay() * 0.7,
          shade: lay(),
        };
      });
    }

    const target = Math.round(clamp(p.embers, 0, 400));
    if (!(target > 0)) {
      state.embers.length = 0;
      state.count = 0;
      return;
    }

    const base = bbox.y + bbox.h * 0.92;
    const spawn = (e) => {
      e.x = bbox.cx + (rng() - 0.5) * bbox.w * p.width * 0.7;
      e.y = base - rng() * bbox.h * 0.1;
      // Straight up out of the hottest part, fast, and then the thermal lets go
      // of them — which is the `vy` decay in the loop below.
      e.vy = -bbox.h * (0.35 + rng() * 0.5);
      e.vx = (rng() - 0.5) * bbox.w * 0.1;
      e.life = 1.2 + rng() * 2.6;
      e.age = 0;
      e.seed = rng() * 100;
      e.size = 0.5 + rng() * 0.9;
      return e;
    };

    if (state.count !== target) {
      while (state.embers.length < target) state.embers.push(spawn({ age: rng() * 2 }));
      state.embers.length = target;
      state.count = target;
    }

    const step = dt * p.speed;
    for (const e of state.embers) {
      e.age += step;
      if (e.age >= e.life) spawn(e);
      // Curl: the plume above a fire is not laminar, and an ember that rises in
      // a straight line looks like a tracer round.
      const swirl = noise.noise3(e.x * 0.005, e.y * 0.005, t * 0.5 + e.seed);
      e.x += (e.vx + swirl * bbox.w * 0.3) * step;
      e.y += e.vy * step;
      e.vy *= 1 - 0.55 * step;
    }
  },
  draw({ g, p, shape, t, state, noise }) {
    const { bbox } = shape;
    if (bbox.w <= 4 || bbox.h <= 4) return;

    const base = bbox.y + bbox.h * 0.92;
    const pyreH = bbox.h * 0.34;
    const flicker = 0.75 + 0.25 * noise.noise2(t * 3.1, 0) + 0.12 * noise.noise2(t * 11, 4.2);

    g.save();

    /* --- The stack --- */

    if (state.logs?.length) {
      // Thickness from the pyre rather than from the shape's width, so a fire
      // in a doorway gets logs and not matchsticks.
      const girth = Math.min(bbox.w * p.width, pyreH * 1.6);
      for (const log of state.logs) {
        const x = bbox.cx + log.foot * bbox.w * 0.5 * p.width;
        const len = pyreH * log.length;
        const thick = Math.max(3, girth * 0.07 * log.thick);
        g.save();
        g.translate(x, base);
        g.rotate(log.lean);
        // Charred, and darker still where it is not catching anything. Two flat
        // tones rather than a gradient: at projector distance the silhouette is
        // doing all the work anyway.
        g.fillStyle = log.shade > 0.5 ? p.logColor : rgba('#000000', 0.85);
        g.fillRect(-thick * 0.5, -len, thick, len);
        /**
         * A lit edge down one side.
         *
         * Without it the stack is black on black and disappears entirely — the
         * one thing a bonfire cannot afford, because the logs are what say this
         * is a fire somebody built rather than a fire that started. Every log
         * in a real pyre has a bright edge facing the flame and a black one
         * facing out, and one strip of blackbody orange is all it takes.
         */
        g.globalCompositeOperation = 'lighter';
        g.fillStyle = rgba(blackbodyCss(1600), 0.16 * flicker);
        g.fillRect(-thick * 0.5, -len, thick * 0.22, len);
        g.restore();
      }
      // The heart of it: the gap between the logs is the brightest thing in the
      // frame, and it is what makes the stack read as burning rather than as a
      // pile of sticks with a fire drawn behind it.
      g.globalCompositeOperation = 'lighter';
      glow(g, bbox.cx, base - pyreH * 0.18, bbox.w * 0.3 * p.width, blackbodyCss(p.coreTemp), 0.55 * flicker);
      g.globalCompositeOperation = 'source-over';
    }

    /* --- The flame --- */

    const cols = Math.max(8, Math.round(p.detail));
    const rows = Math.max(8, Math.round((cols * bbox.h) / bbox.w));
    const field = ensureField(state, 'field', cols, rows);
    field.clear();

    const scroll = t * p.speed;
    const wander = noise.noise2(t * 0.5, 3.3) * 0.1;
    // The fire sits on the pyre rather than on the bottom of the box.
    const seat = (base - bbox.y) / bbox.h;

    for (let y = 0; y < rows; y++) {
      const v = (y + 0.5) / rows;
      const hh = seat - v;
      if (hh < 0 || hh > p.height * 1.35) continue;

      // A bonfire is not a candle: it is wide at the bottom and stays wide for
      // a good part of its height before it necks in and breaks up.
      const taper = Math.max(0.06, 1 - Math.pow(hh / Math.max(0.05, p.height), 1.6) * 0.85);
      const halfWidth = p.width * 0.5 * taper;

      for (let x = 0; x < cols; x++) {
        const u = (x + 0.5) / cols;
        const dx = (u - 0.5 - wander * hh) / Math.max(0.02, halfWidth);
        if (dx * dx > 6) continue;
        const profile = Math.exp(-dx * dx * 1.5);

        const warpX = noise.noise3(u * 2.1, hh * 1.5 - scroll * 0.3, 7.7) * p.turbulence * 0.4;
        const warpY = noise.noise3(u * 1.9 + 4.2, hh * 1.7 - scroll * 0.45, 2.3) * p.turbulence * 0.3;
        const n1 = noise.noise3((u + warpX) * 3.0, (hh + warpY) * 2.3 - scroll, scroll * 0.22);
        const n2 = noise.noise3((u + warpX) * 6.8, (hh + warpY) * 4.8 - scroll * 1.6, scroll * 0.35);
        const detail = 0.5 + 0.36 * n1 + 0.18 * n2;

        const fuel = profile * Math.pow(Math.max(0, 1 - hh / Math.max(0.05, p.height)), 0.7);
        let density = fuel * detail * 2 - hh * 0.3;
        if (density <= 0.02) continue;
        density = clamp(density, 0, 1);

        const kelvin = lerp(p.tipTemp, p.coreTemp, clamp(density * 1.25 - hh * 0.3, 0, 1));
        const [r, gg, b] = blackbodyBytes(kelvin);
        field.set(x, y, r, gg, b, clamp(density * 1.25, 0, 1) * flicker);
      }
    }

    g.globalCompositeOperation = 'lighter';
    field.blit(g, bbox.x, bbox.y, bbox.w, bbox.h);

    /* --- Embers --- */

    for (const e of state.embers) {
      const f = clamp(e.age / e.life, 0, 1);
      // An ember leaving a bonfire is around 1300 K and on its way to dark red;
      // it is the same curve the flame tips are on, continued upwards.
      const kelvin = lerp(1350, 850, f);
      g.globalAlpha = (1 - f) * 0.85;
      g.fillStyle = blackbodyCss(kelvin);
      g.beginPath();
      g.arc(e.x, e.y, Math.max(0.6, bbox.w * 0.004 * e.size * (1 - f * 0.4)), 0, TAU);
      g.fill();
    }
    g.globalAlpha = 1;

    /* --- Firelight on the house --- */

    if (p.spill > 0) {
      // Sized off the larger dimension: a fire in a doorway throws its light
      // as far as one in a garden does, and scaling the spill by the width of
      // a door makes it a puddle.
      glow(
        g, bbox.cx, base - bbox.h * 0.2,
        Math.max(bbox.w, bbox.h) * 1.3 * p.spill,
        blackbodyCss(p.coreTemp * 0.85), 0.16 * p.spill * flicker
      );
    }
    g.globalCompositeOperation = 'source-over';

    /* --- The guy --- */

    if (p.guy) drawGuy(g, bbox, base, pyreH, t, p, noise);

    /* --- Smoke --- */

    if (p.smoke > 0) {
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 5; i++) {
        // Five slow blobs rather than a second density field: smoke above a fire
        // has no structure worth resolving once it is out of the light, and this
        // costs five gradient fills instead of another few thousand cells.
        const phase = frac(t * 0.06 * p.speed + i * 0.2);
        const y = base - bbox.h * (0.3 + phase * 1.1);
        const x = bbox.cx + noise.noise2(phase * 2 + i, t * 0.1) * bbox.w * 0.3;
        const r = bbox.w * (0.12 + phase * 0.4) * p.width;
        const a = 0.1 * p.smoke * Math.sin(phase * Math.PI);
        if (a <= 0.002) continue;
        const grad = g.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, rgba('#6b6f78', a));
        grad.addColorStop(1, rgba('#6b6f78', 0));
        g.fillStyle = grad;
        g.beginPath();
        g.arc(x, y, r, 0, TAU);
        g.fill();
      }
      g.globalCompositeOperation = 'source-over';
    }

    g.restore();
  },
};

/**
 * The guy, burning from the feet up.
 *
 * A silhouette rather than a figure: he is on top of a fire and behind a metre
 * of flame, and every detail beyond the outline is lost by the time it reaches
 * the street. What is *not* lost is the moment he starts to go, so the burn is
 * a rising line — below it he is gone, at it he is a glowing edge, above it he
 * is still a black shape against the flame.
 *
 * A function of show time, so a tab that joins late finds him at exactly the
 * same stage as every other tab rather than starting him again.
 */
function drawGuy(g, bbox, base, pyreH, t, p, noise) {
  const burn = clamp(t / Math.max(1, p.burn), 0, 1);
  if (burn >= 1) return;

  const top = base - pyreH * 1.05;
  const h = bbox.h * 0.2;
  const w = h * 0.42;
  const cx = bbox.cx;
  // Where the char line has reached, from the feet upwards.
  const line = top + h * (1 - burn);
  const lean = noise.noise2(t * 0.7, 1.1) * 0.05;

  g.save();
  g.translate(cx, top + h);
  g.rotate(lean);
  g.translate(-cx, -(top + h));

  // Clip away everything the fire has already had, then fill what is left.
  g.save();
  g.beginPath();
  g.rect(bbox.x - bbox.w, top - h * 1.2, bbox.w * 3, Math.max(0, line - (top - h * 1.2)));
  g.clip();
  g.fillStyle = 'rgba(0,0,0,0.92)';
  guyPath(g, cx, top, w, h);
  g.fill();
  g.restore();

  // The burning edge: a bright line where the flame is eating him, hottest at
  // the moment it passes.
  g.save();
  g.globalCompositeOperation = 'lighter';
  const edge = g.createLinearGradient(0, line - h * 0.12, 0, line + h * 0.04);
  edge.addColorStop(0, rgba(blackbodyCss(1250), 0));
  edge.addColorStop(0.7, rgba(blackbodyCss(2000), 0.5));
  edge.addColorStop(1, rgba(blackbodyCss(1400), 0));
  g.fillStyle = edge;
  guyPath(g, cx, top, w, h);
  g.fill();
  g.restore();

  g.restore();
}

/** The guy's outline, traced into the current path. */
function guyPath(g, cx, top, w, h) {
  g.beginPath();
  g.arc(cx, top + h * 0.12, h * 0.12, 0, TAU);
  g.moveTo(cx - w * 0.28, top + h * 0.24);
  g.lineTo(cx + w * 0.28, top + h * 0.24);
  g.lineTo(cx + w * 0.22, top + h * 0.62);
  g.lineTo(cx + w * 0.34, top + h);
  g.lineTo(cx - w * 0.34, top + h);
  g.lineTo(cx - w * 0.22, top + h * 0.62);
  g.closePath();
  g.moveTo(cx - w * 0.26, top + h * 0.28);
  g.lineTo(cx - w, top + h * 0.5);
  g.lineTo(cx - w, top + h * 0.6);
  g.lineTo(cx - w * 0.24, top + h * 0.42);
  g.closePath();
  g.moveTo(cx + w * 0.26, top + h * 0.28);
  g.lineTo(cx + w, top + h * 0.5);
  g.lineTo(cx + w, top + h * 0.6);
  g.lineTo(cx + w * 0.24, top + h * 0.42);
  g.closePath();
}

/* ------------------------------------------------------------------ *
 * Catherine wheel
 * ------------------------------------------------------------------ */

const catherineWheel = {
  id: 'catherine-wheel',
  name: 'Catherine Wheel',
  category: 'celebration',
  scope: 'shape',
  description:
    'A wheel pinned to the shape that spins up, throws sparks off the rim and burns out. Sparks leave tangentially, because that is what they do.',
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
    return { sparks: [], angle: 0, lit: 0, cycle: -1 };
  },
  /**
   * Spin, and the sparks that come off it.
   *
   * The wheel's angle is integrated rather than computed from `t` because the
   * sparks have to be *released* at the angle the nozzle was pointing when they
   * left — so the two have to advance together, one step at a time, in the same
   * order in every tab.
   */
  step({ p, shape, t, dt, rng, state }) {
    const { bbox } = shape;
    const R = Math.min(bbox.w, bbox.h) * 0.5 * clamp(p.radius, 0.05, 1);
    if (R < 2) return;

    /**
     * Where in the light-burn-relight cycle we are.
     *
     * `repeat` of zero means one burn and then nothing, which is the shape a
     * trigger wants. Anything else loops, which is what an ambient layer wants,
     * and both come out of the same clock rather than out of a state machine.
     */
    const period = p.repeat > 0 ? p.duration + p.repeat : Infinity;
    const cycle = period === Infinity ? 0 : Math.floor(t / period);
    const age = period === Infinity ? t : t - cycle * period;
    const burning = age < p.duration;

    if (state.cycle !== cycle) {
      state.cycle = cycle;
      state.angle = 0;
      state.lit = 0;
    }

    // Thrust builds as the fuse takes hold, and the last fifth is the wheel
    // running down: a firework that stops dead reads as a video ending.
    const throttle = burning
      ? Math.min(1, age / Math.max(0.05, p.spinUp)) * clamp((p.duration - age) / (p.duration * 0.2), 0, 1)
      : 0;
    state.lit = throttle;
    state.angle += throttle * p.spin * TAU * dt;

    const nozzles = Math.round(clamp(p.nozzles, 1, 6));
    const want = burning ? p.sparks * throttle * dt : 0;
    // Fractional spawn carried between steps, so a low rate still produces an
    // even stream instead of nothing at all.
    state.owed = (state.owed || 0) + want;
    const toSpawn = Math.floor(state.owed);
    state.owed -= toSpawn;

    for (let i = 0; i < toSpawn; i++) {
      const n = i % nozzles;
      const a = state.angle + (n / nozzles) * TAU;
      /**
       * Tangential, not radial.
       *
       * This is the one thing everybody draws wrong. A spark on the rim is
       * travelling *along* the rim at ωR; when the casing lets go of it, it
       * carries straight on in the direction it was already going, at ninety
       * degrees to the spoke. Sparks that fly outwards along the spoke give you
       * a sea urchin; sparks that leave tangentially give you the curved,
       * lopsided catherine wheel everybody has actually stood in front of.
       */
      const tangent = a + Math.PI / 2;
      const rimSpeed = throttle * p.spin * TAU * R;
      const thrust = p.speed * (0.6 + rng() * 0.7);
      // Hard ceiling on the shower: a rate slider at nine hundred and a life
      // slider at four seconds is thirty-six hundred particles, which is a
      // dropped frame on every tab at once.
      if (state.sparks.length >= 1500) state.sparks.shift();
      state.sparks.push({
        x: bbox.cx + Math.cos(a) * R,
        y: bbox.cy + Math.sin(a) * R,
        vx: Math.cos(tangent) * (thrust + rimSpeed) + (rng() - 0.5) * p.speed * 0.2,
        vy: Math.sin(tangent) * (thrust + rimSpeed) + (rng() - 0.5) * p.speed * 0.2,
        age: 0,
        life: p.life * (0.5 + rng() * 0.8),
        size: 0.6 + rng() * 0.8,
      });
    }

    for (let i = state.sparks.length - 1; i >= 0; i--) {
      const s = state.sparks[i];
      s.age += dt;
      if (s.age >= s.life) {
        state.sparks.splice(i, 1);
        continue;
      }
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vy += p.gravity * dt;
      // Air drag: a millimetre of burning metal loses its speed in a fraction
      // of a second, which is why the sparks near the rim are fast streaks and
      // the ones at the edge of the shower are drifting motes.
      const drag = 1 - 2.2 * dt;
      s.vx *= drag;
      s.vy *= drag;
    }
  },
  draw({ g, p, shape, state }) {
    const { bbox } = shape;
    const R = Math.min(bbox.w, bbox.h) * 0.5 * clamp(p.radius, 0.05, 1);
    if (R < 2 || !state.sparks) return;

    g.save();
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';

    for (const s of state.sparks) {
      const f = clamp(s.age / s.life, 0, 1);
      const kelvin = lerp(p.hotTemp, p.coolTemp, f);
      const colour = f < 0.15 ? p.tint : blackbodyCss(kelvin);
      const bright = (1 - f) ** 1.4;
      const r = Math.max(0.6, p.size * s.size * (1 - f * 0.5));

      // One frame of motion blur back along the velocity. A spark travelling
      // six hundred pixels a second covers ten in a frame, and drawing it as a
      // dot throws away the only cue that says how fast it is going.
      g.strokeStyle = rgba(colour, 0.55 * bright);
      g.lineWidth = r;
      g.beginPath();
      g.moveTo(s.x, s.y);
      g.lineTo(s.x - s.vx * 0.02, s.y - s.vy * 0.02);
      g.stroke();
    }

    /* --- The wheel itself --- */

    if (state.lit > 0) {
      const nozzles = Math.round(clamp(p.nozzles, 1, 6));
      for (let n = 0; n < nozzles; n++) {
        const a = state.angle + (n / nozzles) * TAU;
        const x = bbox.cx + Math.cos(a) * R;
        const y = bbox.cy + Math.sin(a) * R;
        glow(g, x, y, R * 0.5, '#ffffff', 0.8 * state.lit);
      }
      // The casing, as a faint ring — it is only visible because it is on fire.
      g.strokeStyle = rgba(p.tint, 0.25 * state.lit);
      g.lineWidth = Math.max(1, R * 0.06);
      g.beginPath();
      g.arc(bbox.cx, bbox.cy, R, 0, TAU);
      g.stroke();
      glow(g, bbox.cx, bbox.cy, R * 2.2, p.tint, 0.18 * state.lit);
    }

    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * Sparkler
 * ------------------------------------------------------------------ */

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
    { key: 'size', type: 'range', label: 'Spark size', default: 2.6, min: 0.5, max: 12, step: 0.2 },
  ],
  init() {
    return { sparks: [], trail: null, owed: 0 };
  },
  step({ p, shape, t, dt, rng, state, stable }) {
    const length = shape.sampler.length;
    if (length <= 0) return;

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

    for (let i = 0; i < toSpawn; i++) {
      const head = i % heads;
      const hx = ring.xy[(slot * heads + head) * 2];
      const hy = ring.xy[(slot * heads + head) * 2 + 1];
      const a = rng() * TAU;
      const v = p.throw * (0.25 + rng() * 0.9);
      // Bounded: the rate and life sliders multiply, and a thousand live sparks
      // is already more than the wall can resolve.
      if (state.sparks.length >= 2000) state.sparks.shift();
      state.sparks.push({
        x: hx, y: hy,
        vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        age: 0,
        life: p.life * (0.5 + rng() * 0.9),
        size: 0.6 + rng() * 0.8,
        /**
         * When this one bursts.
         *
         * The forks are the whole signature of a sparkler, and they are not
         * decoration: the wire is coated in iron filings, each filing burns
         * from the outside in, and when the molten shell fails the trapped
         * gas inside blows it apart into a little starburst. That is why the
         * sparks divide *partway along their flight* rather than at the wire.
         */
        burst: p.fork > 0 && rng() < p.fork ? 0.35 + rng() * 0.3 : -1,
        forked: false,
      });
    }

    for (let i = state.sparks.length - 1; i >= 0; i--) {
      const s = state.sparks[i];
      s.age += dt;
      if (s.age >= s.life) {
        state.sparks.splice(i, 1);
        continue;
      }
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vy += p.gravity * dt;
      const drag = 1 - 3.4 * dt;
      s.vx *= drag;
      s.vy *= drag;

      if (!s.forked && s.burst > 0 && s.age / s.life > s.burst && state.sparks.length < 2000) {
        s.forked = true;
        const shards = 2 + Math.floor(rng() * 2);
        for (let k = 0; k < shards; k++) {
          const spread = (rng() - 0.5) * 1.6;
          const boost = 0.5 + rng() * 0.7;
          const speed = Math.hypot(s.vx, s.vy) * boost;
          const dir = Math.atan2(s.vy, s.vx) + spread;
          state.sparks.push({
            x: s.x, y: s.y,
            vx: Math.cos(dir) * speed, vy: Math.sin(dir) * speed,
            age: 0,
            life: (s.life - s.age) * (0.5 + rng() * 0.6),
            size: s.size * 0.7,
            burst: -1,
            forked: true,
          });
        }
      }
    }
  },
  draw({ g, p, shape, t, state }) {
    const ring = state.trail;
    if (!state.sparks || !ring) return;

    g.save();
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';

    // The after-image, oldest first so the bright end is drawn last.
    const at = (j, head) => {
      const slot = (ring.next - ring.len + j + ring.cap * 2) % ring.cap;
      return {
        t: ring.times[slot],
        x: ring.xy[(slot * ring.heads + head) * 2],
        y: ring.xy[(slot * ring.heads + head) * 2 + 1],
      };
    };

    if (p.trail > 0 && ring.len > 1) {
      for (let head = 0; head < ring.heads; head++) {
        for (let j = 1; j < ring.len; j++) {
          const a = at(j - 1, head);
          const b = at(j, head);
          const fade = clamp(1 - (t - b.t) / p.trail, 0, 1);
          if (fade <= 0.01) continue;
          // Cooling as it fades, so the tail of the stroke goes red rather than
          // merely dim — the same curve the sparks themselves are on.
          g.strokeStyle = rgba(blackbodyCss(lerp(p.coolTemp, p.hotTemp, fade)), 0.35 * fade * fade);
          g.lineWidth = Math.max(1, p.head * 0.3 * fade);
          g.beginPath();
          g.moveTo(a.x, a.y);
          g.lineTo(b.x, b.y);
          g.stroke();
        }
      }
    }

    for (const s of state.sparks) {
      const f = clamp(s.age / s.life, 0, 1);
      const bright = (1 - f) ** 1.3;
      const colour = blackbodyCss(lerp(p.hotTemp, p.coolTemp, f));
      g.strokeStyle = rgba(colour, 0.8 * bright);
      g.lineWidth = Math.max(0.6, p.size * s.size * (1 - f * 0.4));
      g.beginPath();
      g.moveTo(s.x, s.y);
      g.lineTo(s.x - s.vx * 0.016, s.y - s.vy * 0.016);
      g.stroke();
    }

    // The head last, over its own sparks: burning iron is close enough to white
    // that the core saturates, and everything around it takes its colour from
    // how far down the curve it has already fallen.
    if (ring.len > 0) {
      for (let head = 0; head < ring.heads; head++) {
        const now = at(ring.len - 1, head);
        glow(g, now.x, now.y, p.head * 3, blackbodyCss(p.hotTemp), 0.9);
        g.fillStyle = '#ffffff';
        g.beginPath();
        g.arc(now.x, now.y, p.head * 0.28, 0, TAU);
        g.fill();
      }
    }

    g.restore();
  },
};

export default [bonfire, catherineWheel, sparkler];
