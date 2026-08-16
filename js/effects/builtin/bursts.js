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

import { rgba, clamp, TAU, mixHex } from '../../core/math.js';
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
  draw({ g, p, shape, age, rng, state, noise }) {
    const fade = envelope(age, p.duration);
    if (fade <= 0) return;

    const at = origin(shape);
    const count = Math.round(clamp(p.count, 4, 200));

    /**
     * Cast once per firing.
     *
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
  draw({ g, p, shape, age, rng, state }) {
    const fade = envelope(age, p.duration);
    if (fade <= 0) return;
    const at = origin(shape);
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

export default [batBurst, shockwave, sparkBurst];
