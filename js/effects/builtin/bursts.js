/**
 * One-shots: effects that happen *at* a moment rather than carrying on.
 *
 * Everything else in the library loops. That is right for a house that has to
 * look alive from dusk until the last group has gone, and it is exactly wrong
 * for the thing you want when somebody actually reaches the door. A swarm that
 * is always crossing the wall is scenery; a swarm that erupts out of the porch
 * the instant the bell goes is an event, and the difference is entirely in the
 * timing.
 *
 * They all work the same way: `ctx.age` is seconds since the layer was switched
 * on, they play once over `duration`, and they draw nothing afterwards. Wire one
 * to a trigger — a key, the doorbell wired to a key, motion on the path — and
 * the trigger's scene switches the layer on, which restarts the clock. Press it
 * again and it plays again.
 *
 * The origin is the middle of whatever shape the layer is pointed at, so
 * pointing one at the door makes things come out of the door. Point it at the
 * whole frame and it comes out of the middle of the house, which is rarely what
 * anybody wants — these are effects that want a target.
 */

import { rgba, clamp, lerp, TAU, mixHex, makeRng } from '../../core/math.js';
import { glow, blackbodyCss } from '../lib.js';

/** Shared by everything here: fade in fast, hold, fade out over the last third. */
function envelope(age, duration) {
  if (age < 0 || age > duration) return 0;
  const u = age / duration;
  if (u < 0.06) return u / 0.06;
  if (u > 0.7) return 1 - (u - 0.7) / 0.3;
  return 1;
}

/** Where a burst comes from, and how big the thing it comes out of is. */
function origin(shape) {
  const { bbox } = shape;
  return { x: bbox.cx, y: bbox.cy, r: Math.max(8, Math.min(bbox.w, bbox.h) * 0.5) };
}

/* ------------------------------------------------------------------ *
 * Bats out of the door
 * ------------------------------------------------------------------ */

const batBurst = {
  id: 'bat-burst',
  name: 'Bat Burst',
  category: 'halloween',
  scope: 'shape',
  description:
    'A swarm erupts out of the shape and scatters across the house. Plays once each time the layer is switched on, so put it on a trigger and point it at the door.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#120a14' },
    { key: 'count', type: 'range', label: 'Bats', default: 40, min: 4, max: 200, step: 1 },
    { key: 'duration', type: 'range', label: 'Lasts (s)', default: 2.6, min: 0.3, max: 12, step: 0.1 },
    { key: 'speed', type: 'range', label: 'Speed', default: 900, min: 100, max: 4000, step: 25 },
    { key: 'spread', type: 'range', label: 'Spread', default: 1, min: 0.05, max: 1, step: 0.01 },
    { key: 'aim', type: 'range', label: 'Aim (degrees)', default: -90, min: -180, max: 180, step: 5 },
    { key: 'size', type: 'range', label: 'Wingspan', default: 46, min: 8, max: 200, step: 1 },
    { key: 'flap', type: 'range', label: 'Flap rate', default: 9, min: 0, max: 30, step: 0.5 },
    { key: 'rise', type: 'range', label: 'Climb', default: -260, min: -1500, max: 1500, step: 20 },
    { key: 'wander', type: 'range', label: 'Wander', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'glow', type: 'range', label: 'Backlight', default: 0.5, min: 0, max: 3, step: 0.05 },
    { key: 'glowColor', type: 'color', label: 'Backlight colour', default: '#8b00ff' },
  ],
  init() {
    return { swarm: null, born: -1 };
  },
  /**
   * Cast the swarm — once, at a moment every tab agrees on.
   *
   * This is the only stateful thing a burst does, and it has to happen here
   * rather than on the first frame that gets drawn. `rng` is seeded from the
   * simulation step, and the first frame lands on a different step depending on
   * the frame rate: a tab at 60fps would cast from step one and a tab at 30fps
   * from step two, so two projectors threw two different swarms out of the same
   * window. `step` always runs from step one, whatever the frame rate.
   */
  step({ p, age, rng, state }) {
    const count = Math.round(clamp(p.count, 4, 200));

    /**
     * Keyed on the age going backwards, which is what a retrigger looks like
     * from in here — the layer was switched off and on, the clock restarted,
     * and this needs a fresh swarm rather than the tail of the last one.
     */
    if (!state.swarm || state.swarm.length !== count || age < state.born) {
      state.born = age;
      const aim = (p.aim * Math.PI) / 180;
      state.swarm = Array.from({ length: count }, () => {
        // Spread of 1 is the full circle; anything less is a cone about `aim`.
        const a = aim + (rng() - 0.5) * Math.PI * 2 * p.spread;
        const v = 0.35 + rng() * 0.65;
        return {
          a,
          v,
          // Staggered, so they pour out rather than appearing as a ring.
          delay: rng() * 0.28,
          size: 0.6 + rng() * 0.7,
          phase: rng() * TAU,
          drift: rng() * 100,
        };
      });
    }
    state.born = Math.min(state.born, age);
  },
  draw({ g, p, shape, age, state, noise }) {
    const fade = envelope(age, p.duration);
    if (fade <= 0 || !state.swarm) return;
    const at = origin(shape);

    g.save();
    for (const b of state.swarm) {
      const life = age - b.delay;
      if (life <= 0) continue;
      const travel = p.speed * b.v * life;
      const wobble = p.wander > 0
        ? noise.noise2(life * 1.6 + b.drift, 0) * travel * 0.22 * p.wander
        : 0;
      const x = at.x + Math.cos(b.a) * travel - Math.sin(b.a) * wobble;
      const y = at.y + Math.sin(b.a) * travel + Math.cos(b.a) * wobble + p.rise * life * life * 0.5;

      const span = p.size * b.size;
      // Wings beat about the direction of travel, so they bank as they turn.
      const heading = b.a + wobble * 0.002;
      const beat = Math.sin(life * p.flap * TAU + b.phase);
      drawBat(g, x, y, span, heading, beat, p.color, fade);

      if (p.glow > 0) {
        g.globalCompositeOperation = 'lighter';
        glow(g, x, y, span * 0.9, p.glowColor, 0.1 * p.glow * fade);
        g.globalCompositeOperation = 'source-over';
      }
    }
    g.restore();
  },
};

/**
 * One bat: a body and two swept wings, folded by `beat`.
 *
 * Quadratics rather than a sprite because the silhouette has to survive being
 * halved by a projector, and the shape of the leading edge is the only thing
 * that says "bat" rather than "bird" at that size.
 */
function drawBat(g, x, y, span, heading, beat, colour, alpha) {
  const half = span * 0.5;
  const fold = 0.35 + 0.65 * (0.5 + 0.5 * beat);
  g.save();
  g.translate(x, y);
  g.rotate(heading + Math.PI / 2);
  g.globalAlpha = alpha;
  g.fillStyle = colour;

  g.beginPath();
  g.moveTo(0, -half * 0.34);
  for (const side of [1, -1]) {
    g.moveTo(0, -half * 0.2);
    g.quadraticCurveTo(side * half * 0.55, -half * fold * 0.9, side * half, -half * fold * 0.25);
    g.quadraticCurveTo(side * half * 0.72, half * 0.12, side * half * 0.5, -half * fold * 0.05);
    g.quadraticCurveTo(side * half * 0.4, half * 0.3, side * half * 0.18, half * 0.16);
    g.lineTo(0, half * 0.34);
    g.closePath();
  }
  g.fill();

  g.beginPath();
  g.ellipse(0, 0, half * 0.15, half * 0.32, 0, 0, TAU);
  g.fill();
  g.restore();
  g.globalAlpha = 1;
}

/* ------------------------------------------------------------------ *
 * Shockwave
 * ------------------------------------------------------------------ */

const shockwave = {
  id: 'shockwave',
  name: 'Shockwave',
  category: 'basic',
  scope: 'shape',
  description:
    'Rings of light race outwards from the shape and fade. Plays once each time the layer is switched on — the cheapest way to make a house react to something.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#7cf3ff' },
    { key: 'color2', type: 'color', label: 'Trailing colour', default: '#8b00ff' },
    { key: 'rings', type: 'range', label: 'Rings', default: 3, min: 1, max: 10, step: 1 },
    { key: 'duration', type: 'range', label: 'Lasts (s)', default: 1.6, min: 0.2, max: 10, step: 0.1 },
    { key: 'reach', type: 'range', label: 'Reach', default: 2200, min: 100, max: 6000, step: 50 },
    { key: 'width', type: 'range', label: 'Ring thickness', default: 26, min: 4, max: 200, step: 1 },
    { key: 'flash', type: 'range', label: 'Flash at the centre', default: 1, min: 0, max: 3, step: 0.05 },
    { key: 'gap', type: 'range', label: 'Gap between rings', default: 0.12, min: 0, max: 1, step: 0.01 },
  ],
  init() {
    return {};
  },
  draw({ g, p, shape, age }) {
    const fade = envelope(age, p.duration);
    if (fade <= 0) return;
    const at = origin(shape);
    const rings = Math.round(clamp(p.rings, 1, 10));

    g.save();
    g.globalCompositeOperation = 'lighter';

    if (p.flash > 0) {
      // The flash is the fastest thing in it and mostly over before the first
      // ring has gone anywhere, which is what reads as an impact.
      const punch = Math.max(0, 1 - age / (p.duration * 0.22));
      if (punch > 0) glow(g, at.x, at.y, at.r * 3 + p.width * 4, p.color, 0.7 * p.flash * punch * punch);
    }

    for (let i = 0; i < rings; i++) {
      const u = (age / p.duration) - i * p.gap;
      if (u <= 0 || u >= 1) continue;
      // Fast at first and slowing, which is how a wavefront in anything reads.
      const r = at.r + p.reach * (1 - Math.pow(1 - u, 2.4));
      const thin = 1 - u;
      g.strokeStyle = rgba(mixHex(p.color, p.color2, u), 0.85 * thin * fade);
      g.lineWidth = Math.max(2, p.width * thin);
      g.beginPath();
      g.arc(at.x, at.y, r, 0, TAU);
      g.stroke();
    }
    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * Sparks
 * ------------------------------------------------------------------ */

const sparkBurst = {
  id: 'spark-burst',
  name: 'Spark Burst',
  category: 'basic',
  scope: 'shape',
  description:
    'A shower of embers thrown out of the shape, falling under gravity and burning out. Plays once each time the layer is switched on.',
  params: [
    { key: 'hotTemp', type: 'range', label: 'Hot (K)', default: 2600, min: 1000, max: 9000, step: 50 },
    { key: 'coolTemp', type: 'range', label: 'Cool (K)', default: 1100, min: 800, max: 4000, step: 50 },
    { key: 'count', type: 'range', label: 'Sparks', default: 90, min: 5, max: 400, step: 1 },
    { key: 'duration', type: 'range', label: 'Lasts (s)', default: 2, min: 0.2, max: 10, step: 0.1 },
    { key: 'speed', type: 'range', label: 'Speed', default: 700, min: 50, max: 3000, step: 25 },
    { key: 'spread', type: 'range', label: 'Spread', default: 1, min: 0.05, max: 1, step: 0.01 },
    { key: 'aim', type: 'range', label: 'Aim (degrees)', default: -90, min: -180, max: 180, step: 5 },
    { key: 'gravity', type: 'range', label: 'Gravity', default: 900, min: -1000, max: 3000, step: 25 },
    { key: 'size', type: 'range', label: 'Size', default: 7, min: 2, max: 40, step: 0.5 },
    { key: 'trail', type: 'range', label: 'Trail', default: 0.6, min: 0, max: 1, step: 0.01 },
  ],
  init() {
    return { sparks: null, born: -1 };
  },
  /**
   * Cast the swarm — once, at a moment every tab agrees on.
   *
   * This is the only stateful thing a burst does, and it has to happen here
   * rather than on the first frame that gets drawn. `rng` is seeded from the
   * simulation step, and the first frame lands on a different step depending on
   * the frame rate: a tab at 60fps would cast from step one and a tab at 30fps
   * from step two, so two projectors threw two different swarms out of the same
   * window. `step` always runs from step one, whatever the frame rate.
   */
  step({ p, age, rng, state }) {
    const count = Math.round(clamp(p.count, 5, 400));

    // Recast on a retrigger, which from in here is the age going backwards.
    if (!state.sparks || state.sparks.length !== count || age < state.born) {
      state.born = age;
      const aim = (p.aim * Math.PI) / 180;
      state.sparks = Array.from({ length: count }, () => {
        const a = aim + (rng() - 0.5) * Math.PI * 2 * p.spread;
        const v = p.speed * (0.25 + rng() * 0.95);
        return {
          vx: Math.cos(a) * v,
          vy: Math.sin(a) * v,
          size: 0.5 + rng() * 0.9,
          // Each burns out at its own rate, so they do not all die together.
          life: 0.45 + rng() * 0.55,
        };
      });
    }
    state.born = Math.min(state.born, age);
  },
  draw({ g, p, shape, age, state }) {
    const fade = envelope(age, p.duration);
    if (fade <= 0 || !state.sparks) return;
    const at = origin(shape);

    g.save();
    g.globalCompositeOperation = 'lighter';
    for (const s of state.sparks) {
      const u = age / (p.duration * s.life);
      if (u >= 1) continue;
      // Ballistic, because they are: thrown, then falling.
      const x = at.x + s.vx * age;
      const y = at.y + s.vy * age + 0.5 * p.gravity * age * age;
      // Cooling as it goes, which is what makes a dying ember read as burning
      // rather than merely dimming. See docs/effects.md on blackbody colour.
      const temp = p.coolTemp + (p.hotTemp - p.coolTemp) * (1 - u);
      const colour = blackbodyCss(temp);
      const r = Math.max(1.5, p.size * s.size * (1 - u * 0.6));
      const bright = (1 - u) * fade;

      if (p.trail > 0) {
        // A streak back along its own velocity — one frame of motion blur, which
        // is most of what separates a spark from a dot.
        const back = 0.035 * p.trail;
        g.strokeStyle = rgba(colour, 0.5 * bright);
        g.lineWidth = r * 0.9;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x - s.vx * back, y - (s.vy + p.gravity * age) * back);
        g.stroke();
      }

      g.fillStyle = rgba(colour, bright);
      g.beginPath();
      g.arc(x, y, r, 0, TAU);
      g.fill();
    }
    g.restore();
  },
};


/* ------------------------------------------------------------------ *
 * Rocket
 * ------------------------------------------------------------------ */

/**
 * The colours a firework star actually comes in.
 *
 * Not a palette somebody liked: these are the metal salts. Strontium burns red,
 * barium green, copper blue, sodium yellow, and the white is magnesium burning
 * hot enough to be off the top of the visible curve. It matters here because
 * the *blue* is the tell — copper is the hardest colour to make and the dimmest
 * to burn, so a blue shell on a wall wants to be paler and weaker than the red
 * next to it, and a palette that treats them as equals looks like a screensaver.
 */
const STAR_COLOURS = {
  strontium: '#ff3b4d',
  barium: '#7dff8a',
  copper: '#5aa8ff',
  sodium: '#ffd166',
  magnesium: '#ffffff',
};

const SHELL_TYPES = ['peony', 'willow', 'palm', 'crossette'];

const rocket = {
  id: 'rocket',
  name: 'Rocket',
  category: 'celebration',
  scope: 'shape',
  description:
    'One shell, launched from the shape: it lifts on a plume, hangs, and breaks. Plays once each time the layer is switched on, so put it on a trigger and point it at the roofline.',
  params: [
    { key: 'shell', type: 'select', label: 'Shell', default: 'peony', options: SHELL_TYPES },
    { key: 'star', type: 'select', label: 'Star', default: 'strontium', options: [...Object.keys(STAR_COLOURS), 'single'] },
    { key: 'color', type: 'color', label: 'Single colour', default: '#ffd166' },
    { key: 'duration', type: 'range', label: 'Lasts (s)', default: 4.5, min: 1, max: 20, step: 0.1 },
    { key: 'lift', type: 'range', label: 'Lift (s)', default: 1.1, min: 0.2, max: 5, step: 0.05 },
    { key: 'height', type: 'range', label: 'Apogee', default: 900, min: 100, max: 3000, step: 25 },
    { key: 'drift', type: 'range', label: 'Drift', default: 120, min: -800, max: 800, step: 10 },
    { key: 'stars', type: 'range', label: 'Stars', default: 90, min: 8, max: 400, step: 1 },
    { key: 'power', type: 'range', label: 'Burst size', default: 520, min: 50, max: 2500, step: 10 },
    { key: 'gravity', type: 'range', label: 'Gravity', default: 260, min: 0, max: 2000, step: 10 },
    { key: 'size', type: 'range', label: 'Star size', default: 4, min: 1, max: 20, step: 0.5 },
    { key: 'flash', type: 'range', label: 'Report', default: 1, min: 0, max: 3, step: 0.05 },
    { key: 'seed', type: 'range', label: 'Shell number', default: 1, min: 1, max: 99, step: 1 },
  ],
  init() {
    return {};
  },
  /**
   * No `step`, and no particles.
   *
   * A shell is fully determined by the moment it was fired: every star is the
   * same star it was going to be, on a ballistic path from the same point. So
   * the whole thing is a function of `age`, seeded off the shell number — which
   * means a projector tab that joins the show a second after the trigger fired
   * draws the burst already half open, in the right place, rather than starting
   * it again from the ground.
   */
  draw({ g, p, shape, age }) {
    if (age < 0 || age > p.duration) return;
    const { bbox } = shape;
    const from = { x: bbox.cx, y: bbox.cy };
    const rng = makeRng(`rocket:${p.seed}:${p.shell}`);
    const tint = p.star === 'single' ? p.color : (STAR_COLOURS[p.star] || STAR_COLOURS.strontium);

    g.save();
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';

    /* --- Lift --- */

    /**
     * The climb, capped so it always leaves room for the break.
     *
     * Lift and Lasts are independent sliders and nothing stops the first
     * exceeding the second — at which point the shell is still rising when its
     * time runs out, and the effect draws a trail going up and nothing else.
     * That is not a shell that failed to burst, it is a shell that looks
     * broken, so the lift gets at most a third of the run.
     */
    const lift = Math.min(p.lift, p.duration * 0.34);

    // Decelerating all the way up, because it is: the motor burns for a moment
    // and the rest of the climb is coasting against gravity. A shell that rises
    // at a constant speed reads as a bubble going up a tube.
    const climb = clamp(age / lift, 0, 1);
    const eased = 1 - (1 - climb) ** 2;
    const apex = { x: from.x + p.drift * lift * eased, y: from.y - p.height * eased };

    if (age < lift) {
      const grad = g.createLinearGradient(from.x, apex.y + 90, apex.x, apex.y);
      grad.addColorStop(0, rgba(blackbodyCss(1400), 0));
      grad.addColorStop(1, rgba(blackbodyCss(2600), 0.9));
      g.strokeStyle = grad;
      g.lineWidth = 4;
      g.beginPath();
      g.moveTo(apex.x - p.drift * 0.06, apex.y + 90);
      g.lineTo(apex.x, apex.y);
      g.stroke();
      glow(g, apex.x, apex.y, 40, blackbodyCss(2600), 0.5);
      g.restore();
      return;
    }

    /* --- Break --- */

    const burst = age - lift;
    const span = Math.max(0.2, p.duration - lift);
    const f = clamp(burst / span, 0, 1);
    const stars = Math.round(clamp(p.stars, 8, 400));

    // The report: the flash you see before you hear it, over in a fifth of a
    // second and responsible for most of the impression that something exploded.
    if (p.flash > 0 && f < 0.14) {
      const punch = 1 - f / 0.14;
      glow(g, apex.x, apex.y, p.power * 1.2, '#ffffff', 0.8 * p.flash * punch * punch);
    }

    for (let s = 0; s < stars; s++) {
      /**
       * An even sphere, seen flat.
       *
       * Angles spread evenly with a little jitter and speeds varied, so the
       * shell reads as a filled ball rather than as a ring — a burst where
       * every star has the same speed is a circle, and a real one is a
       * chrysanthemum because the stars you see edge-on are moving across your
       * view slower than the ones coming at you.
       */
      const angle = (s / stars) * TAU + rng() * 0.3;
      let speed = 0.45 + rng() * 0.55;
      let drag = 1;
      let droop = 1;

      if (p.shell === 'willow') {
        // Willow stars are heavy charcoal: they slow quickly and fall in long
        // golden strands, which is why a willow hangs and a peony does not.
        drag = 0.55;
        droop = 3.2;
      } else if (p.shell === 'palm') {
        // A palm is a handful of thick comets, not a sphere.
        speed = s % 7 === 0 ? 1 : 0.15;
        droop = 2;
      }

      const reach = p.power * speed * drag * (1 - (1 - f) ** 2.2) * 1.3;
      let x = apex.x + Math.cos(angle) * reach;
      let y = apex.y + Math.sin(angle) * reach + p.gravity * droop * burst * burst * 0.5 * 0.02;

      if (p.shell === 'crossette' && f > 0.45) {
        // Crossette stars split once, and each piece flies off at right angles
        // to where it was going. It is the one shell that changes shape halfway.
        const split = (f - 0.45) / 0.55;
        const side = s % 2 === 0 ? 1 : -1;
        x += Math.cos(angle + side * Math.PI / 2) * p.power * 0.25 * split;
        y += Math.sin(angle + side * Math.PI / 2) * p.power * 0.25 * split;
      }

      // Stars burn out rather than fade out: the colour goes down the blackbody
      // curve as the composition is used up, so the last of a red shell is a
      // deep ember and the last of a white one is orange.
      const kelvin = lerp(3200, 900, f);
      const colour = f < 0.3 ? tint : blackbodyCss(kelvin);
      const bright = (1 - f) ** 1.6 * (0.55 + 0.45 * Math.sin(burst * 26 + s));
      if (bright <= 0.01) continue;

      g.fillStyle = rgba(colour, bright);
      g.beginPath();
      g.arc(x, y, Math.max(0.6, p.size * (1 - f * 0.5)), 0, TAU);
      g.fill();
    }

    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * Confetti cannon
 * ------------------------------------------------------------------ */

const CANNON_COLOURS = ['#ff3b6b', '#ffd166', '#4cc2ff', '#8aff80', '#c77dff', '#ff8a3d'];

const confettiCannon = {
  id: 'confetti-cannon',
  name: 'Confetti Cannon',
  category: 'celebration',
  scope: 'shape',
  description:
    'A cone of paper fired out of the shape, tumbling as it goes and drifting down. Plays once each time the layer is switched on — point it at the door and put it on the bell.',
  params: [
    { key: 'count', type: 'range', label: 'Pieces', default: 160, min: 10, max: 600, step: 10 },
    { key: 'duration', type: 'range', label: 'Lasts (s)', default: 5, min: 0.5, max: 20, step: 0.1 },
    { key: 'speed', type: 'range', label: 'Muzzle speed', default: 1100, min: 100, max: 4000, step: 25 },
    { key: 'aim', type: 'range', label: 'Aim (degrees)', default: -90, min: -180, max: 180, step: 5 },
    { key: 'spread', type: 'range', label: 'Spread', default: 0.16, min: 0.02, max: 1, step: 0.01 },
    { key: 'gravity', type: 'range', label: 'Gravity', default: 420, min: 0, max: 2000, step: 10 },
    { key: 'drag', type: 'range', label: 'Air drag', default: 1.6, min: 0, max: 6, step: 0.05 },
    { key: 'size', type: 'range', label: 'Size', default: 18, min: 3, max: 90, step: 1 },
    { key: 'tumble', type: 'range', label: 'Tumble', default: 1, min: 0, max: 4, step: 0.05 },
    { key: 'streamers', type: 'range', label: 'Streamers', default: 0.3, min: 0, max: 1, step: 0.01 },
    { key: 'seed', type: 'range', label: 'Charge', default: 1, min: 1, max: 99, step: 1 },
  ],
  init() {
    return {};
  },
  /**
   * Also stateless, and for the same reason as the rocket — but the physics is
   * the opposite one. A confetti cannon is the clearest demonstration of drag
   * there is: the paper leaves the barrel at the speed of a thrown ball and is
   * down to a drift within a metre, because a scrap of paper has an enormous
   * area for its mass. Modelled as exponential decay towards terminal velocity,
   * which is the closed form of exactly that, so no integration is needed and
   * every tab agrees without remembering anything.
   */
  draw({ g, p, shape, age }) {
    if (age < 0 || age > p.duration) return;
    const { bbox } = shape;
    const rng = makeRng(`cannon:${p.seed}`);
    const aim = (p.aim * Math.PI) / 180;
    const k = Math.max(0.05, p.drag);
    const terminal = p.gravity / k;
    /**
     * How far a body launched at v0 has travelled in `elapsed`, with drag ~ -k v.
     *
     * `elapsed` is a parameter rather than the enclosing `age` because the
     * pieces leave the barrel staggered: closing over `age` made the horizontal
     * position count from the shot and the vertical one from the piece's own
     * launch, so a delayed piece appeared already displaced sideways — very
     * visible at the muzzle speeds the presets use.
     */
    const travel = (v0, elapsed) => (v0 / k) * (1 - Math.exp(-k * elapsed));

    g.save();
    for (let i = 0; i < Math.round(clamp(p.count, 10, 600)); i++) {
      const a = aim + (rng() - 0.5) * Math.PI * p.spread * 2;
      const v = p.speed * (0.4 + rng() * 0.9);
      const colour = CANNON_COLOURS[Math.floor(rng() * CANNON_COLOURS.length)];
      const streamer = rng() < p.streamers;
      const size = p.size * (0.6 + rng() * 0.8);
      const spin = rng() * TAU;
      const rate = (0.8 + rng() * 2.4) * (rng() < 0.5 ? -1 : 1);
      const delay = rng() * 0.08;
      const life = age - delay;
      if (life <= 0) continue;

      const x = bbox.cx + travel(Math.cos(a) * v, life);
      // Vertical is the same decay plus the terminal fall it settles into.
      const y = bbox.cy + travel(Math.sin(a) * v, life) + terminal * (life - (1 - Math.exp(-k * life)) / k);

      const turn = spin + rate * p.tumble * life * 4;
      const facing = Math.cos(turn);
      const w = Math.max(0.6, Math.abs(facing) * size * (streamer ? 0.3 : 1));
      const fade = clamp((p.duration - age) / (p.duration * 0.25), 0, 1);

      g.save();
      g.translate(x, y);
      g.rotate(a + Math.sin(life * 3 + spin) * 0.5);
      g.globalAlpha = fade;
      g.fillStyle = facing >= 0 ? colour : mixHex(colour, '#000000', 0.45);
      if (streamer) g.fillRect(-w * 0.5, -size * 1.6, w, size * 3.2);
      else g.fillRect(-w * 0.5, -size * 0.35, w, size * 0.7);
      g.restore();
    }
    g.globalAlpha = 1;
    g.restore();
  },
};

export default [batBurst, shockwave, sparkBurst, rocket, confettiCannon];
