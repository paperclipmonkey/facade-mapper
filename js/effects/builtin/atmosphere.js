/**
 * Weather, light and depth.
 *
 * These lean on the post-processing stage rather than fighting it: they draw
 * relatively dim, and let bloom do the glowing. That is the main difference
 * between an effect that reads as "a bright shape" and one that reads as light
 * falling on brickwork.
 *
 * Rain, searchlights and projected caustics all give a facade a sense of
 * weather and depth that flat colour never will.
 */

import { rgba, clamp, TAU, frac } from '../../core/math.js';
import { blackbodyCss, mixLinear } from '../color.js';
import { ensureField } from '../field.js';

const rain = {
  id: 'rain',
  name: 'Rain',
  category: 'atmosphere',
  scope: 'shape',
  description:
    'Falling rain with depth, wind and optional splashes where it lands. Leave targets empty to cover the house.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#bcd6ff' },
    { key: 'count', type: 'range', label: 'Drops', default: 450, min: 20, max: 3000, step: 10 },
    { key: 'speed', type: 'range', label: 'Fall speed', default: 900, min: 100, max: 3000, step: 10 },
    { key: 'angle', type: 'range', label: 'Angle', default: 12, min: -60, max: 60, step: 1 },
    { key: 'length', type: 'range', label: 'Streak length', default: 42, min: 4, max: 200, step: 1 },
    { key: 'width', type: 'range', label: 'Thickness', default: 1.6, min: 0.3, max: 8, step: 0.1 },
    { key: 'depth', type: 'range', label: 'Depth spread', default: 0.7, min: 0, max: 1, step: 0.01 },
    { key: 'opacity', type: 'range', label: 'Opacity', default: 0.5, min: 0.02, max: 1, step: 0.01 },
    { key: 'splash', type: 'range', label: 'Splashes', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'gust', type: 'range', label: 'Gustiness', default: 0.4, min: 0, max: 2, step: 0.05 },
  ],
  init() {
    return { drops: [], count: 0, splashes: [] };
  },
  draw({ g, p, shape, t, dt, rng, state, noise }) {
    const { bbox } = shape;
    if (bbox.w <= 0 || bbox.h <= 0) return;

    const target = Math.round(p.count);
    const angle = (p.angle * Math.PI) / 180;
    const dirX = Math.sin(angle);
    const dirY = Math.cos(angle);

    const spawn = (drop = {}, atTop = true) => {
      // Spawn wider than the shape so wind-blown rain enters from the side.
      drop.x = bbox.x + (rng() * 1.6 - 0.3) * bbox.w;
      drop.y = atTop ? bbox.y - rng() * bbox.h * 0.2 : bbox.y + rng() * bbox.h;
      drop.z = 1 - p.depth * rng();
      return drop;
    };

    while (state.drops.length < target) state.drops.push(spawn({}, false));
    if (state.drops.length > target) state.drops.length = target;

    const gust = p.gust > 0 ? noise.noise2(t * 0.3, 0) * p.gust : 0;

    g.save();
    g.clip(shape.path);
    g.lineCap = 'round';

    for (const drop of state.drops) {
      const z = drop.z;
      const fall = p.speed * z * dt;
      drop.x += (dirX * fall) + gust * 120 * z * dt;
      drop.y += dirY * fall;

      if (drop.y > bbox.y + bbox.h) {
        if (p.splash > 0 && rng() < p.splash * 0.5) {
          state.splashes.push({ x: drop.x, y: bbox.y + bbox.h, age: 0, z });
        }
        spawn(drop, true);
        continue;
      }
      if (drop.x < bbox.x - bbox.w * 0.35 || drop.x > bbox.x + bbox.w * 1.35) {
        spawn(drop, true);
        continue;
      }

      // Nearer drops are longer, thicker and brighter — the whole illusion of
      // depth in a rain effect comes from covarying those three.
      const len = p.length * z;
      const grad = g.createLinearGradient(drop.x, drop.y, drop.x - dirX * len, drop.y - dirY * len);
      grad.addColorStop(0, rgba(p.color, p.opacity * z));
      grad.addColorStop(1, rgba(p.color, 0));
      g.strokeStyle = grad;
      g.lineWidth = Math.max(0.3, p.width * z);
      g.beginPath();
      g.moveTo(drop.x, drop.y);
      g.lineTo(drop.x - dirX * len, drop.y - dirY * len);
      g.stroke();
    }

    if (p.splash > 0 && state.splashes.length) {
      g.globalCompositeOperation = 'lighter';
      for (let i = state.splashes.length - 1; i >= 0; i--) {
        const s = state.splashes[i];
        s.age += dt;
        if (s.age > 0.35) {
          state.splashes.splice(i, 1);
          continue;
        }
        const f = s.age / 0.35;
        const r = p.length * 0.35 * s.z * (0.3 + f);
        g.globalAlpha = (1 - f) * p.opacity * p.splash;
        g.strokeStyle = p.color;
        g.lineWidth = Math.max(0.3, p.width * s.z * 0.7);
        g.beginPath();
        g.ellipse(s.x, s.y, r, r * 0.35, 0, Math.PI, TAU);
        g.stroke();
      }
      // Runaway guard if the splash rate ever outpaces the lifetime.
      if (state.splashes.length > 400) state.splashes.length = 400;
    }
    g.restore();
  },
};

const searchlight = {
  id: 'searchlight',
  name: 'Searchlight',
  category: 'atmosphere',
  scope: 'shape',
  description:
    'A sweeping beam with a visible cone. Reads as a real light source raking across the front of the house.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#dbe9ff' },
    { key: 'beams', type: 'range', label: 'Beams', default: 1, min: 1, max: 6, step: 1 },
    { key: 'spread', type: 'range', label: 'Beam width', default: 14, min: 1, max: 90, step: 0.5 },
    { key: 'speed', type: 'range', label: 'Sweep speed', default: 0.12, min: -1.5, max: 1.5, step: 0.005 },
    { key: 'arc', type: 'range', label: 'Sweep arc', default: 70, min: 5, max: 360, step: 1 },
    { key: 'originX', type: 'range', label: 'Origin X', default: 0.5, min: -0.5, max: 1.5, step: 0.005 },
    { key: 'originY', type: 'range', label: 'Origin Y', default: 1.15, min: -0.5, max: 2, step: 0.005 },
    { key: 'aim', type: 'range', label: 'Aim', default: -90, min: -180, max: 180, step: 1 },
    { key: 'intensity', type: 'range', label: 'Intensity', default: 0.55, min: 0, max: 2, step: 0.01 },
    { key: 'haze', type: 'range', label: 'Haze', default: 0.4, min: 0, max: 1, step: 0.01 },
    { key: 'flicker', type: 'range', label: 'Flicker', default: 0.08, min: 0, max: 1, step: 0.01 },
  ],
  draw({ g, p, shape, t, noise }) {
    const { bbox } = shape;
    const ox = bbox.x + p.originX * bbox.w;
    const oy = bbox.y + p.originY * bbox.h;
    const reach = Math.hypot(bbox.w, bbox.h) * 1.6;
    const spread = (p.spread * Math.PI) / 180;
    const arc = (p.arc * Math.PI) / 180;
    const aim = (p.aim * Math.PI) / 180;

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';

    for (let b = 0; b < Math.round(p.beams); b++) {
      const phase = t * p.speed + b / Math.max(1, p.beams);
      // Triangle wave sweep: a beam that snaps back to the start looks broken.
      const sweep = (Math.abs(frac(phase) * 2 - 1) - 0.5) * arc;
      const centre = aim + sweep;
      const wobble = p.flicker > 0 ? 1 - p.flicker * Math.abs(noise.noise2(t * 6 + b * 10, 0)) : 1;
      const level = clamp(p.intensity * wobble, 0, 3);
      if (level <= 0.002) continue;

      const tipX = ox + Math.cos(centre) * reach;
      const tipY = oy + Math.sin(centre) * reach;

      // The cone body: bright at the source, fading along its length.
      const grad = g.createLinearGradient(ox, oy, tipX, tipY);
      grad.addColorStop(0, rgba(p.color, 0.55 * level));
      grad.addColorStop(0.35, rgba(p.color, 0.28 * level * (0.4 + p.haze)));
      grad.addColorStop(1, rgba(p.color, 0));
      g.fillStyle = grad;

      g.beginPath();
      g.moveTo(ox, oy);
      g.arc(ox, oy, reach, centre - spread / 2, centre + spread / 2);
      g.closePath();
      g.fill();

      // A tighter, brighter core inside the cone.
      const coreGrad = g.createLinearGradient(ox, oy, tipX, tipY);
      coreGrad.addColorStop(0, rgba(p.color, 0.7 * level));
      coreGrad.addColorStop(1, rgba(p.color, 0));
      g.fillStyle = coreGrad;
      g.beginPath();
      g.moveTo(ox, oy);
      g.arc(ox, oy, reach, centre - spread / 6, centre + spread / 6);
      g.closePath();
      g.fill();

      // The lamp itself, if it happens to be inside the shape.
      const lampR = Math.min(bbox.w, bbox.h) * 0.05;
      const lamp = g.createRadialGradient(ox, oy, 0, ox, oy, lampR * 4);
      lamp.addColorStop(0, rgba(p.color, level));
      lamp.addColorStop(1, rgba(p.color, 0));
      g.fillStyle = lamp;
      g.beginPath();
      g.arc(ox, oy, lampR * 4, 0, TAU);
      g.fill();
    }
    g.restore();
  },
};

const caustics = {
  id: 'caustics',
  name: 'Water Caustics',
  category: 'atmosphere',
  scope: 'shape',
  description:
    'Rippling light like sun through water. Slow it right down and it becomes a very good "something is wrong" wash.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#7fe8ff' },
    { key: 'color2', type: 'color', label: 'Deep colour', default: '#04203a' },
    { key: 'scale', type: 'range', label: 'Scale', default: 3.2, min: 0.5, max: 12, step: 0.1 },
    { key: 'speed', type: 'range', label: 'Speed', default: 0.35, min: 0, max: 3, step: 0.01 },
    { key: 'sharpness', type: 'range', label: 'Sharpness', default: 3.5, min: 1, max: 10, step: 0.1 },
    { key: 'level', type: 'range', label: 'Brightness', default: 0.8, min: 0, max: 2, step: 0.01 },
    { key: 'resolution', type: 'range', label: 'Detail', default: 56, min: 12, max: 130, step: 2 },
  ],
  draw({ g, p, shape, t, state, noise }) {
    const { bbox } = shape;
    if (bbox.w <= 2 || bbox.h <= 2) return;

    // A field rather than thousands of fillRects: one draw call, and the
    // browser's bilinear filtering turns the cells into continuous ripples.
    const cols = Math.max(8, Math.round(p.resolution));
    const rows = Math.max(8, Math.round((cols * bbox.h) / bbox.w));
    const field = ensureField(state, 'field', cols, rows);
    field.clear();

    // Precompute the colour ramp once per frame instead of per cell — building
    // a CSS string 5000 times a frame is what made the old version expensive.
    const RAMP_STEPS = 24;
    const ramp = [];
    for (let i = 0; i < RAMP_STEPS; i++) {
      const hex = mixLinear(p.color2, p.color, i / (RAMP_STEPS - 1)).replace('#', '');
      const n = parseInt(hex, 16) || 0;
      ramp.push([(n >> 16) & 255, (n >> 8) & 255, n & 255]);
    }

    for (let y = 0; y < rows; y++) {
      const v = (y + 0.5) / rows;
      for (let x = 0; x < cols; x++) {
        const u = (x + 0.5) / cols;
        // Two counter-drifting noise fields; ridged so the bright veins are
        // thin and the dark areas broad, which is what caustics actually do.
        const a = noise.noise3(u * p.scale, v * p.scale, t * p.speed);
        const b = noise.noise3(u * p.scale * 1.7 + 4.2, v * p.scale * 1.7 - 2.1, t * p.speed * 0.7);
        const ridge = 1 - Math.abs(a + b) * 0.5;
        const value = Math.pow(clamp(ridge, 0, 1), p.sharpness);
        if (value < 0.02) continue;

        const [r, gg, bb] = ramp[Math.min(RAMP_STEPS - 1, (value * RAMP_STEPS) | 0)];
        field.set(x, y, r, gg, bb, clamp(value * p.level, 0, 1));
      }
    }

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';
    field.blit(g, bbox.x, bbox.y, bbox.w, bbox.h);
    g.restore();
  },
};

/** Temperature falls fast at first, then levels off — Newtonian cooling. */
function lerpTemp(hot, cool, f) {
  return cool + (hot - cool) * Math.exp(-3.2 * f);
}

const embers = {
  id: 'embers',
  name: 'Drifting Embers',
  category: 'atmosphere',
  scope: 'shape',
  description:
    'Slow motes rising through the frame with turbulence. Costs almost nothing and adds enormous depth behind other effects.',
  params: [
    { key: 'hotTemp', type: 'range', label: 'Hot temperature (K)', default: 2000, min: 900, max: 3500, step: 25 },
    { key: 'coolTemp', type: 'range', label: 'Cooled temperature (K)', default: 1050, min: 800, max: 2500, step: 25 },
    { key: 'count', type: 'range', label: 'Motes', default: 90, min: 5, max: 600, step: 5 },
    { key: 'rise', type: 'range', label: 'Rise speed', default: 34, min: -200, max: 200, step: 1 },
    { key: 'drift', type: 'range', label: 'Drift', default: 22, min: -200, max: 200, step: 1 },
    { key: 'turbulence', type: 'range', label: 'Turbulence', default: 26, min: 0, max: 200, step: 1 },
    { key: 'size', type: 'range', label: 'Size', default: 3.4, min: 0.5, max: 20, step: 0.1 },
    { key: 'twinkle', type: 'range', label: 'Twinkle', default: 0.6, min: 0, max: 1, step: 0.01 },
    { key: 'opacity', type: 'range', label: 'Opacity', default: 0.8, min: 0.02, max: 1, step: 0.01 },
  ],
  init() {
    return { motes: [], count: 0 };
  },
  draw({ g, p, shape, t, dt, rng, state, noise }) {
    const { bbox } = shape;
    if (bbox.w <= 0 || bbox.h <= 0) return;
    const target = Math.round(p.count);

    const spawn = (mote = {}, fresh = false) => {
      mote.x = bbox.x + rng() * bbox.w;
      mote.y = fresh ? bbox.y + bbox.h + rng() * bbox.h * 0.1 : bbox.y + rng() * bbox.h;
      mote.seed = rng() * 100;
      mote.scale = 0.4 + rng() * 1.1;
      mote.life = 0;
      mote.span = 4 + rng() * 8;
      return mote;
    };

    while (state.motes.length < target) state.motes.push(spawn({}, false));
    if (state.motes.length > target) state.motes.length = target;

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';

    for (const mote of state.motes) {
      mote.life += dt;
      const turb = noise.noise3(mote.x * 0.003, mote.y * 0.003, t * 0.25 + mote.seed);
      mote.x += (p.drift + turb * p.turbulence) * dt;
      mote.y -= p.rise * dt;

      if (mote.y < bbox.y - bbox.h * 0.1 || mote.y > bbox.y + bbox.h * 1.1 || mote.life > mote.span) {
        spawn(mote, true);
        continue;
      }

      // Fade in and out over the mote's life so nothing pops.
      const f = clamp(mote.life / mote.span, 0, 1);
      let alpha = Math.sin(f * Math.PI) * p.opacity;
      if (p.twinkle > 0) alpha *= 1 - p.twinkle * (0.5 + 0.5 * Math.sin(t * 5 + mote.seed * 3));
      if (alpha <= 0.01) continue;

      const r = p.size * mote.scale;
      // An ember cools as it travels, so its colour is a temperature rather
      // than a fade between two chosen hexes. That is what makes a dying one go
      // deep red instead of merely dim.
      const colour = blackbodyCss(lerpTemp(p.hotTemp, p.coolTemp, clamp(f, 0, 1)));
      const grad = g.createRadialGradient(mote.x, mote.y, 0, mote.x, mote.y, r * 3);
      grad.addColorStop(0, rgba(colour, alpha));
      grad.addColorStop(1, rgba(colour, 0));
      g.fillStyle = grad;
      g.beginPath();
      g.arc(mote.x, mote.y, r * 3, 0, TAU);
      g.fill();
    }
    g.restore();
  },
};

const shatter = {
  id: 'shatter',
  name: 'Cracking Glass',
  category: 'atmosphere',
  scope: 'shape',
  description:
    'A crack spreading from an impact point, on a timer. Point it at a window and time it with a bang.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#dff0ff' },
    { key: 'interval', type: 'range', label: 'Every (s)', default: 25, min: 2, max: 600, step: 1 },
    { key: 'grow', type: 'range', label: 'Spread time (s)', default: 0.35, min: 0.05, max: 5, step: 0.01 },
    { key: 'hold', type: 'range', label: 'Hold (s)', default: 4, min: 0, max: 60, step: 0.5 },
    { key: 'branches', type: 'range', label: 'Main cracks', default: 9, min: 3, max: 24, step: 1 },
    { key: 'depth', type: 'range', label: 'Branching', default: 3, min: 0, max: 5, step: 1 },
    { key: 'width', type: 'range', label: 'Thickness', default: 2.4, min: 0.4, max: 12, step: 0.1 },
    { key: 'impactX', type: 'range', label: 'Impact X', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'impactY', type: 'range', label: 'Impact Y', default: 0.45, min: 0, max: 1, step: 0.01 },
    { key: 'flash', type: 'range', label: 'Impact flash', default: 0.7, min: 0, max: 1, step: 0.01 },
  ],
  draw({ g, p, shape, t, rng }) {
    const { bbox } = shape;
    const cycle = t % Math.max(1, p.interval);
    const total = p.grow + p.hold;
    if (cycle > total) return;

    const progress = clamp(cycle / Math.max(0.01, p.grow), 0, 1);
    // Fade the whole thing out over the last second of the hold.
    const fade = cycle > p.grow ? clamp(1 - (cycle - p.grow) / Math.max(0.01, p.hold), 0, 1) : 1;
    const eased = 1 - (1 - progress) ** 3;

    const cx = bbox.x + p.impactX * bbox.w;
    const cy = bbox.y + p.impactY * bbox.h;
    const reach = Math.hypot(bbox.w, bbox.h) * 0.6;

    // Seeded per impact so the same crack pattern persists while it is on
    // screen, and a different one appears next time.
    const impact = Math.floor(t / Math.max(1, p.interval));
    const seeded = (() => {
      let a = (impact * 2654435761) >>> 0;
      return () => {
        a = (Math.imul(a ^ (a >>> 15), 2246822519) + 0x9e3779b9) >>> 0;
        return a / 4294967296;
      };
    })();

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';
    g.globalAlpha = fade;

    const drawCrack = (x, y, angle, length, width, depth) => {
      if (length < 4 || width < 0.15) return;
      let px = x;
      let py = y;
      let a = angle;
      const steps = 6;
      g.strokeStyle = rgba(p.color, 0.85);
      g.lineWidth = width;
      g.beginPath();
      g.moveTo(px, py);
      for (let i = 1; i <= steps; i++) {
        a += (seeded() - 0.5) * 0.5;
        const seg = (length / steps) * eased;
        px += Math.cos(a) * seg;
        py += Math.sin(a) * seg;
        g.lineTo(px, py);
        if (depth > 0 && seeded() < 0.4) {
          drawCrack(px, py, a + (seeded() - 0.5) * 1.8, length * 0.45, width * 0.55, depth - 1);
        }
      }
      g.stroke();
    };

    for (let i = 0; i < Math.round(p.branches); i++) {
      const angle = (i / p.branches) * TAU + seeded() * 0.4;
      drawCrack(cx, cy, angle, reach * (0.5 + seeded() * 0.6), p.width, Math.round(p.depth));
    }

    if (p.flash > 0 && progress < 0.3) {
      const punch = (1 - progress / 0.3) * p.flash;
      const r = reach * 0.5 * (0.3 + progress * 2);
      const grad = g.createRadialGradient(cx, cy, 0, cx, cy, r);
      grad.addColorStop(0, rgba('#ffffff', punch));
      grad.addColorStop(1, rgba(p.color, 0));
      g.fillStyle = grad;
      g.beginPath();
      g.arc(cx, cy, r, 0, TAU);
      g.fill();
    }
    g.restore();
  },
};

const plasma = {
  id: 'plasma',
  name: 'Plasma Wash',
  category: 'atmosphere',
  scope: 'shape',
  description:
    'Smooth drifting colour fields. A far better ambient base than a flat wash — the wall never looks static.',
  params: [
    { key: 'colorA', type: 'color', label: 'Colour A', default: '#2a0060' },
    { key: 'colorB', type: 'color', label: 'Colour B', default: '#00306b' },
    { key: 'colorC', type: 'color', label: 'Colour C', default: '#5c0030' },
    { key: 'scale', type: 'range', label: 'Scale', default: 1.6, min: 0.2, max: 8, step: 0.05 },
    { key: 'speed', type: 'range', label: 'Speed', default: 0.09, min: 0, max: 1.5, step: 0.005 },
    { key: 'level', type: 'range', label: 'Brightness', default: 0.75, min: 0, max: 2, step: 0.01 },
    { key: 'resolution', type: 'range', label: 'Detail', default: 40, min: 8, max: 100, step: 2 },
    { key: 'contrast', type: 'range', label: 'Contrast', default: 1.3, min: 0.2, max: 4, step: 0.05 },
  ],
  draw({ g, p, shape, t, state, noise }) {
    const { bbox } = shape;
    if (bbox.w <= 2 || bbox.h <= 2) return;

    const cols = Math.max(6, Math.round(p.resolution));
    const rows = Math.max(6, Math.round((cols * bbox.h) / bbox.w));
    const field = ensureField(state, 'field', cols, rows);
    field.clear();

    // Two precomputed ramps, blended per cell. Mixing in linear light is what
    // keeps the transitions from passing through a muddy grey.
    const STEPS = 20;
    const rampAB = [];
    const rampC = [];
    for (let i = 0; i < STEPS; i++) {
      const f = i / (STEPS - 1);
      for (const [target, from, to] of [[rampAB, p.colorA, p.colorB], [rampC, p.colorA, p.colorC]]) {
        const hex = mixLinear(from, to, f).replace('#', '');
        const n = parseInt(hex, 16) || 0;
        target.push([(n >> 16) & 255, (n >> 8) & 255, n & 255]);
      }
    }

    for (let y = 0; y < rows; y++) {
      const v = (y + 0.5) / rows;
      for (let x = 0; x < cols; x++) {
        const u = (x + 0.5) / cols;
        // Two offset noise samples act as weights for three colours, which
        // gives smooth blends without ever computing a hue.
        const a = noise.noise3(u * p.scale, v * p.scale, t * p.speed) * 0.5 + 0.5;
        const b = noise.noise3(u * p.scale + 9.1, v * p.scale - 3.7, t * p.speed * 1.3) * 0.5 + 0.5;

        const shaped = clamp((a - 0.5) * p.contrast + 0.5, 0, 1);
        const shapedB = clamp((b - 0.5) * p.contrast + 0.5, 0, 1);

        const base = rampAB[Math.min(STEPS - 1, (shaped * STEPS) | 0)];
        const tint = rampC[Math.min(STEPS - 1, (shapedB * 0.6 * STEPS) | 0)];
        const mix = shapedB * 0.6;

        field.set(
          x, y,
          base[0] * (1 - mix) + tint[0] * mix,
          base[1] * (1 - mix) + tint[1] * mix,
          base[2] * (1 - mix) + tint[2] * mix,
          clamp(p.level * (0.35 + 0.65 * shaped), 0, 1)
        );
      }
    }

    g.save();
    g.clip(shape.path);
    field.blit(g, bbox.x, bbox.y, bbox.w, bbox.h);
    g.restore();
  },
};

const scanner = {
  id: 'scan-lines',
  name: 'Scan Sweep',
  category: 'atmosphere',
  scope: 'shape',
  description: 'A bright line sweeping across the shape, leaving a decaying trail. Clean, technical, very readable.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#00ffc8' },
    { key: 'axis', type: 'select', label: 'Direction', default: 'down', options: ['down', 'up', 'right', 'left'] },
    { key: 'speed', type: 'range', label: 'Speed', default: 0.35, min: 0.01, max: 4, step: 0.01 },
    { key: 'thickness', type: 'range', label: 'Line thickness', default: 5, min: 0.5, max: 60, step: 0.5 },
    { key: 'trail', type: 'range', label: 'Trail', default: 0.3, min: 0, max: 1, step: 0.01 },
    { key: 'lines', type: 'range', label: 'Lines', default: 1, min: 1, max: 8, step: 1 },
    { key: 'grid', type: 'range', label: 'Grid behind', default: 0.12, min: 0, max: 1, step: 0.01 },
    { key: 'level', type: 'range', label: 'Brightness', default: 1, min: 0, max: 2, step: 0.01 },
  ],
  draw({ g, p, shape, t }) {
    const { bbox } = shape;
    const vertical = p.axis === 'down' || p.axis === 'up';
    const reversed = p.axis === 'up' || p.axis === 'left';
    const span = vertical ? bbox.h : bbox.w;
    if (span <= 0) return;

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = clamp(p.level, 0, 3);

    if (p.grid > 0) {
      g.strokeStyle = rgba(p.color, p.grid);
      g.lineWidth = 1;
      const step = span / 14;
      g.beginPath();
      for (let i = 0; i <= 14; i++) {
        if (vertical) {
          g.moveTo(bbox.x, bbox.y + i * step);
          g.lineTo(bbox.x + bbox.w, bbox.y + i * step);
        } else {
          g.moveTo(bbox.x + i * step, bbox.y);
          g.lineTo(bbox.x + i * step, bbox.y + bbox.h);
        }
      }
      g.stroke();
    }

    for (let i = 0; i < Math.round(p.lines); i++) {
      let f = frac(t * p.speed + i / Math.max(1, p.lines));
      if (reversed) f = 1 - f;
      const pos = (vertical ? bbox.y : bbox.x) + f * span;
      const trailLen = span * p.trail;

      if (trailLen > 1) {
        const from = reversed ? pos + trailLen : pos - trailLen;
        const grad = vertical
          ? g.createLinearGradient(0, from, 0, pos)
          : g.createLinearGradient(from, 0, pos, 0);
        grad.addColorStop(0, rgba(p.color, 0));
        grad.addColorStop(1, rgba(p.color, 0.4));
        g.fillStyle = grad;
        if (vertical) {
          g.fillRect(bbox.x, Math.min(from, pos), bbox.w, Math.abs(pos - from));
        } else {
          g.fillRect(Math.min(from, pos), bbox.y, Math.abs(pos - from), bbox.h);
        }
      }

      g.fillStyle = p.color;
      if (vertical) g.fillRect(bbox.x, pos - p.thickness / 2, bbox.w, p.thickness);
      else g.fillRect(pos - p.thickness / 2, bbox.y, p.thickness, bbox.h);
    }
    g.restore();
  },
};

export default [rain, searchlight, caustics, embers, shatter, plasma, scanner];
