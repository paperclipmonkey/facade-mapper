/**
 * Path animations.
 *
 * Every shape carries an arc-length sampler, so "60% of the way round this
 * window frame" is a meaningful question whether the shape is a rectangle, an
 * arched door or a hand-traced roofline. These effects all work by walking that
 * parameter, which is why a chase runs at constant speed instead of sprinting
 * along the short edges.
 *
 * Open paths (type: path) and closed polygons behave identically here — the only
 * difference is whether the chase wraps or bounces off the ends.
 */

import { rgba, clamp, lerp, TAU, frac } from '../../core/math.js';
import { blackbodyCss } from '../color.js';

/** Position along a path, wrapping for closed shapes and clamping for open ones. */
function sampleAt(shape, u) {
  return shape.sampler.at(shape.closed ? frac(u) : clamp(u, 0, 1));
}

const chase = {
  id: 'chase',
  name: 'Chase',
  category: 'path',
  scope: 'shape',
  description:
    'Lights running around the outline. The classic door and window treatment.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#ff9500' },
    { key: 'trail', type: 'color', label: 'Trail colour', default: '#ff0033' },
    { key: 'count', type: 'range', label: 'Lights', default: 6, min: 1, max: 64, step: 1 },
    { key: 'size', type: 'range', label: 'Size', default: 14, min: 1, max: 90, step: 0.5 },
    { key: 'speed', type: 'range', label: 'Speed (laps/s)', default: 0.25, min: -3, max: 3, step: 0.005 },
    { key: 'tail', type: 'range', label: 'Tail length', default: 0.06, min: 0, max: 0.5, step: 0.005 },
    { key: 'glow', type: 'range', label: 'Glow', default: 1, min: 0, max: 3, step: 0.05 },
    { key: 'bounce', type: 'bool', label: 'Bounce (open paths)', default: false },
    { key: 'level', type: 'range', label: 'Brightness', default: 1, min: 0, max: 2, step: 0.01 },
  ],
  draw({ g, p, shape, t }) {
    if (!shape.sampler.length) return;
    const count = Math.max(1, Math.round(p.count));
    const bouncing = p.bounce && !shape.closed;
    // Ping-pong along an open path instead of teleporting back to the start.
    const base = bouncing ? Math.abs(frac(t * p.speed * 0.5) * 2 - 1) : t * p.speed;

    g.save();
    g.globalAlpha *= clamp(p.level, 0, 4);
    g.globalCompositeOperation = 'lighter';

    const tailSteps = p.tail > 0 ? Math.max(2, Math.round(p.tail * 240)) : 0;

    for (let i = 0; i < count; i++) {
      // Bouncing lights travel as a tight cluster; wrapping ones space evenly.
      const u = bouncing
        ? clamp(base + (i - (count - 1) / 2) * 0.025, 0, 1)
        : base + i / count;
      const head = sampleAt(shape, u);

      // Tail first, so the bright head paints over it.
      for (let s = tailSteps; s > 0; s--) {
        const f = s / tailSteps;
        const pt = sampleAt(shape, u - p.tail * f * (p.speed >= 0 ? 1 : -1));
        const a = (1 - f) * 0.45;
        g.globalAlpha = clamp(p.level, 0, 4) * a;
        g.fillStyle = rgba(p.trail, 1);
        g.beginPath();
        g.arc(pt.x, pt.y, p.size * (1 - f) * 0.7, 0, TAU);
        g.fill();
      }

      g.globalAlpha = clamp(p.level, 0, 4);
      if (p.glow > 0) {
        const grad = g.createRadialGradient(head.x, head.y, 0, head.x, head.y, p.size * (1 + p.glow));
        grad.addColorStop(0, rgba(p.color, 0.9));
        grad.addColorStop(1, rgba(p.color, 0));
        g.fillStyle = grad;
        g.beginPath();
        g.arc(head.x, head.y, p.size * (1 + p.glow), 0, TAU);
        g.fill();
      }
      g.fillStyle = p.color;
      g.beginPath();
      g.arc(head.x, head.y, p.size * 0.5, 0, TAU);
      g.fill();
    }
    g.restore();
  },
};

const pulse = {
  id: 'pulse',
  name: 'Pulse',
  category: 'path',
  scope: 'shape',
  description:
    'Breathing outline and/or fill. Set it slow for a heartbeat, fast for an alarm.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#ff2d55' },
    { key: 'mode', type: 'select', label: 'Mode', default: 'outline', options: ['outline', 'fill', 'both'] },
    { key: 'rate', type: 'range', label: 'Rate (Hz)', default: 0.6, min: 0.02, max: 12, step: 0.01 },
    { key: 'wave', type: 'select', label: 'Shape', default: 'sine', options: ['sine', 'triangle', 'heartbeat', 'ramp', 'square'] },
    { key: 'min', type: 'range', label: 'Minimum', default: 0.1, min: 0, max: 1, step: 0.01 },
    { key: 'max', type: 'range', label: 'Maximum', default: 1, min: 0, max: 2, step: 0.01 },
    { key: 'width', type: 'range', label: 'Outline width', default: 10, min: 0.5, max: 80, step: 0.5 },
    { key: 'grow', type: 'range', label: 'Size wobble', default: 0, min: 0, max: 0.3, step: 0.005 },
    { key: 'sync', type: 'bool', label: 'Sync to beat', default: false },
    { key: 'division', type: 'range', label: 'Beats per pulse', default: 1, min: 0.125, max: 16, step: 0.125 },
  ],
  draw({ g, p, shape, t, beat }) {
    const phase = p.sync ? frac(beat / Math.max(0.0625, p.division)) : frac(t * p.rate);

    let w;
    switch (p.wave) {
      case 'triangle':
        w = 1 - Math.abs(phase * 2 - 1);
        break;
      case 'ramp':
        w = 1 - phase;
        break;
      case 'square':
        w = phase < 0.5 ? 1 : 0;
        break;
      case 'heartbeat': {
        // Two quick thumps then a rest — reads far more organic than a sine.
        const beat1 = Math.exp(-Math.pow((phase - 0.06) / 0.05, 2));
        const beat2 = 0.65 * Math.exp(-Math.pow((phase - 0.22) / 0.06, 2));
        w = clamp(beat1 + beat2, 0, 1);
        break;
      }
      case 'sine':
      default:
        w = 0.5 - 0.5 * Math.cos(phase * TAU);
    }

    const level = lerp(p.min, p.max, w);
    if (level <= 0.001) return;

    g.save();
    g.globalAlpha *= clamp(level, 0, 4);

    if (p.grow > 0) {
      const s = 1 + p.grow * (w - 0.5) * 2;
      g.translate(shape.bbox.cx, shape.bbox.cy);
      g.scale(s, s);
      g.translate(-shape.bbox.cx, -shape.bbox.cy);
    }

    if (p.mode === 'fill' || p.mode === 'both') {
      g.fillStyle = p.color;
      g.fill(shape.path);
    }
    if (p.mode === 'outline' || p.mode === 'both') {
      g.lineWidth = p.width;
      g.lineJoin = 'round';
      g.strokeStyle = p.color;
      g.save();
      g.globalCompositeOperation = 'lighter';
      g.lineWidth = p.width * 2.4;
      g.strokeStyle = rgba(p.color, 0.2);
      g.stroke(shape.path);
      g.restore();
      g.stroke(shape.path);
    }
    g.restore();
  },
};

const fairyLights = {
  id: 'fairy-lights',
  name: 'Fairy Lights',
  category: 'path',
  scope: 'shape',
  description:
    'A string of bulbs pinned along the path, with twinkle, chase and colour-cycle patterns.',
  params: [
    { key: 'pattern', type: 'select', label: 'Pattern', default: 'twinkle', options: ['steady', 'twinkle', 'chase', 'alternate', 'wave', 'cycle'] },
    { key: 'palette', type: 'select', label: 'Palette', default: 'multi', options: ['multi', 'warm', 'cool', 'halloween', 'christmas', 'single'] },
    { key: 'color', type: 'color', label: 'Single colour', default: '#ffd27f' },
    { key: 'spacing', type: 'range', label: 'Spacing (px)', default: 55, min: 8, max: 400, step: 1 },
    { key: 'size', type: 'range', label: 'Bulb size', default: 9, min: 1, max: 50, step: 0.5 },
    { key: 'glow', type: 'range', label: 'Glow', default: 2.4, min: 0, max: 6, step: 0.05 },
    { key: 'speed', type: 'range', label: 'Speed', default: 0.6, min: -6, max: 6, step: 0.01 },
    { key: 'level', type: 'range', label: 'Brightness', default: 1, min: 0, max: 2, step: 0.01 },
    { key: 'wire', type: 'range', label: 'Wire opacity', default: 0.15, min: 0, max: 1, step: 0.01 },
  ],
  init() {
    return { phases: null, count: 0 };
  },
  /**
   * Per-bulb random phase, regenerated only when the count changes, so bulbs
   * keep their identity while you drag the spacing slider.
   *
   * Cast here rather than on the first frame drawn: `rng` is seeded from the
   * simulation step, and which step the first frame lands on depends on the
   * frame rate — so two tabs used to twinkle the same string differently.
   */
  step({ p, shape, rng, state }) {
    const length = shape.sampler.length;
    if (length <= 0) return;
    const count = clamp(Math.round(length / Math.max(4, p.spacing)), 1, 900);
    if (state.count === count) return;
    state.count = count;
    state.phases = new Float32Array(count);
    for (let i = 0; i < count; i++) state.phases[i] = rng();
  },
  draw({ g, p, shape, t, state }) {
    const length = shape.sampler.length;
    if (length <= 0 || !state.phases) return;
    const count = state.count;

    const palettes = {
      multi: ['#ff2d55', '#ffd60a', '#30d158', '#0a84ff', '#bf5af2'],
      warm: ['#ffd27f', '#ffb347', '#ff8c42'],
      cool: ['#7fd8ff', '#a0b8ff', '#d0e8ff'],
      halloween: ['#ff7a18', '#8b00ff', '#39ff14'],
      christmas: ['#ff2d2d', '#1db954', '#ffd700', '#ffffff'],
      single: [p.color],
    };
    const palette = palettes[p.palette] || palettes.multi;

    g.save();
    g.globalAlpha *= clamp(p.level, 0, 4);

    if (p.wire > 0) {
      g.globalAlpha = clamp(p.level, 0, 4) * p.wire;
      g.strokeStyle = '#ffffff';
      g.lineWidth = Math.max(1, p.size * 0.12);
      g.stroke(shape.path);
    }

    g.globalCompositeOperation = 'lighter';

    for (let i = 0; i < count; i++) {
      const u = i / count;
      const pt = sampleAt(shape, u);
      const phase = state.phases[i];

      let brightness = 1;
      let colour = palette[i % palette.length];

      switch (p.pattern) {
        case 'twinkle':
          brightness = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin((t * p.speed + phase) * TAU * 1.7));
          break;
        case 'chase': {
          // The lit run is a fixed fraction of the string, so changing the bulb
          // spacing changes the density rather than the length of the chase.
          const head = frac(t * p.speed * 0.25);
          const d = Math.abs(frac(u - head + 0.5) - 0.5);
          brightness = clamp(1 - d / 0.14, 0, 1);
          break;
        }
        case 'alternate':
          brightness = (i % 2 === 0) === (frac(t * p.speed * 0.5) < 0.5) ? 1 : 0.08;
          break;
        case 'wave':
          brightness = 0.2 + 0.8 * (0.5 + 0.5 * Math.sin((u * 3 - t * p.speed) * TAU));
          break;
        case 'cycle':
          colour = palette[(i + Math.floor(t * p.speed * 2)) % palette.length];
          break;
        case 'steady':
        default:
          brightness = 1;
      }

      if (brightness <= 0.01) continue;
      const r = p.size * 0.5;
      const outer = r * (1 + p.glow);

      if (p.glow > 0) {
        const grad = g.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, outer);
        grad.addColorStop(0, rgba(colour, 0.75 * brightness));
        grad.addColorStop(0.35, rgba(colour, 0.25 * brightness));
        grad.addColorStop(1, rgba(colour, 0));
        g.fillStyle = grad;
        g.beginPath();
        g.arc(pt.x, pt.y, outer, 0, TAU);
        g.fill();
      }

      g.fillStyle = rgba(colour, brightness);
      g.beginPath();
      g.arc(pt.x, pt.y, r, 0, TAU);
      g.fill();
    }
    g.restore();
  },
};

const comet = {
  id: 'comet',
  name: 'Comet',
  category: 'path',
  scope: 'shape',
  description: 'A single bright head dragging a smooth tapered tail around the path.',
  params: [
    { key: 'color', type: 'color', label: 'Head colour', default: '#ffffff' },
    { key: 'tailColor', type: 'color', label: 'Tail colour', default: '#00b3ff' },
    { key: 'speed', type: 'range', label: 'Speed (laps/s)', default: 0.2, min: -3, max: 3, step: 0.005 },
    { key: 'tail', type: 'range', label: 'Tail length', default: 0.25, min: 0.01, max: 1, step: 0.005 },
    { key: 'width', type: 'range', label: 'Width', default: 16, min: 1, max: 90, step: 0.5 },
    { key: 'heads', type: 'range', label: 'Comets', default: 1, min: 1, max: 8, step: 1 },
    { key: 'level', type: 'range', label: 'Brightness', default: 1, min: 0, max: 2, step: 0.01 },
  ],
  draw({ g, p, shape, t }) {
    if (!shape.sampler.length) return;
    const steps = 64;
    g.save();
    g.globalAlpha *= clamp(p.level, 0, 4);
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';

    for (let c = 0; c < p.heads; c++) {
      const head = t * p.speed + c / p.heads;
      // Drawn as many short segments rather than one stroke, because the taper
      // needs both width and colour to change along the tail.
      for (let s = steps - 1; s >= 0; s--) {
        const f0 = s / steps;
        const f1 = (s + 1) / steps;
        const dir = p.speed >= 0 ? -1 : 1;
        const a = sampleAt(shape, head + dir * p.tail * f0);
        const b = sampleAt(shape, head + dir * p.tail * f1);
        const fade = 1 - f0;
        g.globalAlpha = clamp(p.level, 0, 4) * fade * fade * 0.9;
        g.strokeStyle = f0 < 0.12 ? p.color : p.tailColor;
        g.lineWidth = p.width * (0.25 + 0.75 * fade);
        g.beginPath();
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
        g.stroke();
      }

      const h = sampleAt(shape, head);
      const grad = g.createRadialGradient(h.x, h.y, 0, h.x, h.y, p.width * 1.8);
      grad.addColorStop(0, rgba(p.color, 1));
      grad.addColorStop(1, rgba(p.color, 0));
      g.globalAlpha = clamp(p.level, 0, 4);
      g.fillStyle = grad;
      g.beginPath();
      g.arc(h.x, h.y, p.width * 1.8, 0, TAU);
      g.fill();
    }
    g.restore();
  },
};

const trace = {
  id: 'trace',
  name: 'Trace On/Off',
  category: 'path',
  scope: 'shape',
  description:
    'Draws the outline on progressively, then wipes it away. Good for reveals and for "the house wakes up" moments.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#ffffff' },
    { key: 'width', type: 'range', label: 'Width', default: 8, min: 0.5, max: 60, step: 0.5 },
    { key: 'period', type: 'range', label: 'Cycle (s)', default: 6, min: 0.5, max: 60, step: 0.1 },
    { key: 'hold', type: 'range', label: 'Hold fraction', default: 0.25, min: 0, max: 0.8, step: 0.01 },
    { key: 'reverse', type: 'bool', label: 'Wipe backwards', default: false },
    { key: 'glow', type: 'range', label: 'Glow', default: 14, min: 0, max: 80, step: 1 },
  ],
  draw({ g, p, shape, t }) {
    const total = shape.sampler.length;
    if (total <= 0) return;

    // The cycle is: draw on -> hold -> wipe off. Splitting the remaining time
    // evenly between the two motions keeps it feeling symmetrical.
    const phase = frac(t / Math.max(0.1, p.period));
    const motion = (1 - clamp(p.hold, 0, 0.9)) / 2;
    let visible;
    if (phase < motion) visible = phase / motion;
    else if (phase < motion + p.hold) visible = 1;
    else visible = clamp(1 - (phase - motion - p.hold) / motion, 0, 1);

    if (visible <= 0.001) return;

    g.save();
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = p.color;
    // A dash pattern of [visible, rest] with the right offset reveals the path
    // in order, which is far cheaper than re-tracing it point by point.
    const shown = total * visible;
    g.setLineDash([shown, total]);
    g.lineDashOffset = p.reverse ? shown - total : 0;

    if (p.glow > 0) {
      g.save();
      g.globalCompositeOperation = 'lighter';
      g.lineWidth = p.width + p.glow;
      g.strokeStyle = rgba(p.color, 0.2);
      g.stroke(shape.path);
      g.restore();
    }
    g.lineWidth = p.width;
    g.stroke(shape.path);
    g.restore();
  },
};

const sparks = {
  id: 'sparks',
  name: 'Sparks',
  category: 'path',
  scope: 'shape',
  description: 'Particles thrown off the path — embers, fireflies, magic dust.',
  params: [
    { key: 'hotTemp', type: 'range', label: 'Hot temperature (K)', default: 2300, min: 900, max: 4000, step: 25 },
    { key: 'coolTemp', type: 'range', label: 'Cooled temperature (K)', default: 1000, min: 800, max: 2500, step: 25 },
    { key: 'count', type: 'range', label: 'Particles', default: 120, min: 4, max: 800, step: 1 },
    { key: 'life', type: 'range', label: 'Lifetime (s)', default: 2.2, min: 0.2, max: 12, step: 0.05 },
    { key: 'rise', type: 'range', label: 'Rise speed', default: -60, min: -400, max: 400, step: 1 },
    { key: 'spread', type: 'range', label: 'Spread', default: 40, min: 0, max: 400, step: 1 },
    { key: 'size', type: 'range', label: 'Size', default: 4, min: 0.5, max: 30, step: 0.25 },
    { key: 'drift', type: 'range', label: 'Wind', default: 8, min: -200, max: 200, step: 1 },
    { key: 'level', type: 'range', label: 'Brightness', default: 1, min: 0, max: 2, step: 0.01 },
  ],
  init() {
    return { parts: [], count: 0 };
  },
  step({ p, shape, t, dt, rng, state, noise }) {
    if (!shape.sampler.length) return;
    const target = Math.round(p.count);

    const spawn = () => {
      const u = rng();
      const at = sampleAt(shape, u);
      return {
        x: at.x + (rng() - 0.5) * 4,
        y: at.y + (rng() - 0.5) * 4,
        vx: (rng() - 0.5) * p.spread,
        vy: p.rise * (0.6 + rng() * 0.8),
        age: rng() * p.life,
        life: p.life * (0.6 + rng() * 0.8),
        seed: rng() * 100,
        size: p.size * (0.5 + rng()),
      };
    };

    while (state.parts.length < target) state.parts.push(spawn());
    if (state.parts.length > target) state.parts.length = target;

    for (const part of state.parts) {
      part.age += dt;
      if (part.age >= part.life) {
        Object.assign(part, spawn(), { age: 0 });
      }
      const turbulence = noise.noise3(part.x * 0.004, part.y * 0.004, t * 0.3 + part.seed);
      part.x += (part.vx + p.drift + turbulence * 40) * dt;
      part.y += part.vy * dt;
    }
  },
  draw({ g, p, state }) {
    g.save();
    g.globalAlpha *= clamp(p.level, 0, 4);
    g.globalCompositeOperation = 'lighter';

    for (const part of state.parts) {
      const f = part.age / part.life;
      const alpha = Math.sin(f * Math.PI); // fade in and out
      // Sparks cool as they fly, so colour comes from temperature.
      g.fillStyle = blackbodyCss(p.coolTemp + (p.hotTemp - p.coolTemp) * Math.exp(-3.5 * f));
      g.globalAlpha = clamp(p.level, 0, 4) * alpha * 0.9;
      g.beginPath();
      g.arc(part.x, part.y, part.size * (1 - f * 0.6), 0, TAU);
      g.fill();
    }
    g.restore();
  },
};

export default [chase, pulse, fairyLights, comet, trace, sparks];
