/**
 * Christmas effects.
 *
 * Same engine as the Halloween set, different mood. Snow and stars are usually
 * pointed at a whole wall (leave a layer's targets empty and it covers the frame);
 * icicles and candy stripes want a specific edge or outline.
 */

import { rgba, clamp, TAU, frac, mixHex } from '../../core/math.js';

const snow = {
  id: 'snow',
  name: 'Snow',
  category: 'christmas',
  scope: 'shape',
  description:
    'Falling snow with depth layers and wind. Leave targets empty to cover everything.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#ffffff' },
    { key: 'count', type: 'range', label: 'Flakes', default: 320, min: 10, max: 2000, step: 10 },
    { key: 'speed', type: 'range', label: 'Fall speed', default: 90, min: 5, max: 600, step: 1 },
    { key: 'wind', type: 'range', label: 'Wind', default: 20, min: -300, max: 300, step: 1 },
    { key: 'gust', type: 'range', label: 'Gustiness', default: 0.5, min: 0, max: 3, step: 0.05 },
    { key: 'size', type: 'range', label: 'Flake size', default: 5, min: 0.5, max: 30, step: 0.25 },
    { key: 'depth', type: 'range', label: 'Depth spread', default: 0.7, min: 0, max: 1, step: 0.01 },
    { key: 'sparkle', type: 'range', label: 'Sparkle', default: 0.3, min: 0, max: 1, step: 0.01 },
    { key: 'settle', type: 'range', label: 'Settle at bottom', default: 0, min: 0, max: 1, step: 0.01 },
  ],
  init() {
    return { flakes: [], count: 0 };
  },
  draw({ g, p, shape, t, dt, rng, state, noise }) {
    const { bbox } = shape;
    if (bbox.w <= 0 || bbox.h <= 0) return;
    const target = Math.round(p.count);

    const spawn = (flake = {}, atTop = true) => {
      flake.x = bbox.x + rng() * bbox.w;
      flake.y = atTop ? bbox.y - rng() * bbox.h * 0.1 : bbox.y + rng() * bbox.h;
      // Depth drives size, speed and brightness together, which is what sells
      // the parallax without needing separate layers.
      flake.z = 1 - p.depth * rng();
      flake.phase = rng() * TAU;
      flake.spin = (rng() - 0.5) * 2;
      return flake;
    };

    while (state.flakes.length < target) state.flakes.push(spawn({}, false));
    if (state.flakes.length > target) state.flakes.length = target;

    g.save();
    g.clip(shape.path);
    g.fillStyle = p.color;

    const gust = p.gust > 0 ? noise.noise2(t * 0.12, 0) * p.gust : 0;

    for (const flake of state.flakes) {
      const z = flake.z;
      flake.y += p.speed * z * dt;
      flake.x +=
        (p.wind * z + Math.sin(t * 0.9 + flake.phase) * 16 * z + gust * 60) * dt;

      if (flake.y > bbox.y + bbox.h + 10) spawn(flake, true);
      if (flake.x < bbox.x - 20) flake.x = bbox.x + bbox.w + 10;
      if (flake.x > bbox.x + bbox.w + 20) flake.x = bbox.x - 10;

      const r = p.size * z * 0.5;
      let alpha = 0.35 + 0.65 * z;
      if (p.sparkle > 0) {
        alpha *= 1 - p.sparkle * (0.5 + 0.5 * Math.sin(t * 6 + flake.phase * 3));
      }
      g.globalAlpha = clamp(alpha, 0, 1);
      g.beginPath();
      g.arc(flake.x, flake.y, Math.max(0.4, r), 0, TAU);
      g.fill();
    }

    if (p.settle > 0) {
      // A soft drift along the bottom edge, as if snow is piling up on the sill.
      const h = bbox.h * 0.06 * p.settle;
      const grad = g.createLinearGradient(0, bbox.y + bbox.h - h * 2.2, 0, bbox.y + bbox.h);
      grad.addColorStop(0, rgba(p.color, 0));
      grad.addColorStop(1, rgba(p.color, 0.85));
      g.globalAlpha = 1;
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(bbox.x, bbox.y + bbox.h);
      for (let x = 0; x <= 24; x++) {
        const f = x / 24;
        const px = bbox.x + f * bbox.w;
        const py = bbox.y + bbox.h - h * (0.6 + 0.4 * noise.noise2(f * 4, 3.1));
        g.lineTo(px, py);
      }
      g.lineTo(bbox.x + bbox.w, bbox.y + bbox.h);
      g.closePath();
      g.fill();
    }
    g.restore();
  },
};

const santa = {
  id: 'santa',
  name: 'Santa Fly-past',
  category: 'christmas',
  scope: 'shape',
  description:
    'A sleigh and reindeer silhouette crossing the sky, on a timer so it stays a surprise.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#ffe9b0' },
    { key: 'reindeer', type: 'range', label: 'Reindeer', default: 4, min: 0, max: 9, step: 1 },
    { key: 'size', type: 'range', label: 'Size', default: 0.25, min: 0.03, max: 1, step: 0.005 },
    { key: 'interval', type: 'range', label: 'Every (s)', default: 45, min: 3, max: 600, step: 1 },
    { key: 'crossing', type: 'range', label: 'Crossing time (s)', default: 9, min: 1, max: 60, step: 0.5 },
    { key: 'direction', type: 'select', label: 'Direction', default: 'right', options: ['right', 'left'] },
    { key: 'height', type: 'range', label: 'Height', default: 0.3, min: 0, max: 1, step: 0.01 },
    { key: 'bob', type: 'range', label: 'Bob', default: 0.03, min: 0, max: 0.2, step: 0.005 },
    { key: 'trail', type: 'range', label: 'Sparkle trail', default: 0.6, min: 0, max: 1, step: 0.01 },
    { key: 'silhouette', type: 'bool', label: 'Dark silhouette', default: false },
  ],
  draw({ g, p, shape, t, noise }) {
    const { bbox } = shape;
    const cycle = t % Math.max(1, p.interval);
    if (cycle > p.crossing) return;

    const f = cycle / p.crossing;
    const dir = p.direction === 'left' ? -1 : 1;
    const startX = dir > 0 ? bbox.x - bbox.w * 0.25 : bbox.x + bbox.w * 1.25;
    const x = startX + dir * f * bbox.w * 1.5;
    const baseY = bbox.y + bbox.h * clamp(p.height, 0, 1);
    const y = baseY + Math.sin(t * 1.7) * bbox.h * p.bob;
    const s = bbox.h * p.size;

    g.save();
    g.clip(shape.path);

    if (p.trail > 0) {
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 40; i++) {
        const tf = i / 40;
        const tx = x - dir * tf * s * 6;
        const ty = y + noise.noise2(i * 0.5, t) * s * 0.25 + tf * s * 0.2;
        g.globalAlpha = (1 - tf) * 0.5 * p.trail;
        const r = s * 0.06 * (1 - tf * 0.6);
        const grad = g.createRadialGradient(tx, ty, 0, tx, ty, r * 3);
        grad.addColorStop(0, rgba(p.color, 0.9));
        grad.addColorStop(1, rgba(p.color, 0));
        g.fillStyle = grad;
        g.beginPath();
        g.arc(tx, ty, r * 3, 0, TAU);
        g.fill();
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
    }

    g.translate(x, y);
    g.scale(dir, 1);
    if (p.silhouette) {
      g.globalCompositeOperation = 'destination-out';
      g.fillStyle = '#000';
      g.strokeStyle = '#000';
    } else {
      g.fillStyle = p.color;
      g.strokeStyle = p.color;
    }
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.lineWidth = s * 0.035;

    // Reindeer team, strung out ahead of the sleigh on a rein line.
    const team = Math.round(p.reindeer);
    for (let i = 0; i < team; i++) {
      const rx = -s * (1.6 + i * 1.05);
      const gallop = Math.sin(t * 9 + i * 1.3);
      g.save();
      g.translate(rx, Math.sin(t * 2.4 + i) * s * 0.04);
      // Body.
      g.beginPath();
      g.ellipse(0, 0, s * 0.34, s * 0.16, 0, 0, TAU);
      g.fill();
      // Head and antlers.
      g.beginPath();
      g.moveTo(-s * 0.3, -s * 0.05);
      g.lineTo(-s * 0.52, -s * 0.26);
      g.stroke();
      g.beginPath();
      g.arc(-s * 0.55, -s * 0.3, s * 0.08, 0, TAU);
      g.fill();
      g.lineWidth = s * 0.022;
      for (const side of [-1, 1]) {
        g.beginPath();
        g.moveTo(-s * 0.55, -s * 0.36);
        g.lineTo(-s * 0.62 + side * s * 0.04, -s * 0.55);
        g.lineTo(-s * 0.7 + side * s * 0.09, -s * 0.5);
        g.stroke();
      }
      g.lineWidth = s * 0.035;
      // Legs.
      for (const [ox, ph] of [[-0.2, 0], [0.18, Math.PI]]) {
        g.beginPath();
        g.moveTo(s * ox, s * 0.12);
        g.lineTo(s * ox + Math.sin(gallop + ph) * s * 0.16, s * 0.38);
        g.stroke();
      }
      g.restore();
    }

    if (team > 0) {
      g.lineWidth = s * 0.015;
      g.beginPath();
      g.moveTo(-s * 0.3, -s * 0.05);
      g.lineTo(-s * (1.6 + (team - 1) * 1.05) - s * 0.3, -s * 0.08);
      g.stroke();
      g.lineWidth = s * 0.035;
    }

    // Sleigh: a curled runner and a seat back.
    g.beginPath();
    g.moveTo(-s * 0.5, s * 0.18);
    g.quadraticCurveTo(-s * 0.65, s * 0.3, -s * 0.45, s * 0.34);
    g.lineTo(s * 0.5, s * 0.34);
    g.stroke();
    g.beginPath();
    g.moveTo(-s * 0.45, s * 0.18);
    g.lineTo(s * 0.45, s * 0.18);
    g.quadraticCurveTo(s * 0.6, s * 0.1, s * 0.62, -s * 0.25);
    g.quadraticCurveTo(s * 0.4, -s * 0.05, s * 0.28, s * 0.18);
    g.closePath();
    g.fill();

    // Santa.
    g.beginPath();
    g.ellipse(s * 0.05, -s * 0.06, s * 0.15, s * 0.19, 0, 0, TAU);
    g.fill();
    g.beginPath();
    g.arc(s * 0.05, -s * 0.3, s * 0.1, 0, TAU);
    g.fill();
    g.beginPath();
    g.moveTo(-s * 0.05, -s * 0.36);
    g.lineTo(s * 0.15, -s * 0.36);
    g.lineTo(s * 0.22, -s * 0.52);
    g.closePath();
    g.fill();
    g.beginPath();
    g.moveTo(s * 0.15, -s * 0.12);
    g.lineTo(-s * 0.3, -s * 0.24);
    g.stroke();

    g.restore();
  },
};

const icicles = {
  id: 'icicles',
  name: 'Icicles',
  category: 'christmas',
  scope: 'shape',
  description: 'Ice hanging from the top edge of the shape, growing and glinting.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#bfe9ff' },
    { key: 'tip', type: 'color', label: 'Tip colour', default: '#ffffff' },
    { key: 'count', type: 'range', label: 'Icicles', default: 16, min: 2, max: 90, step: 1 },
    { key: 'length', type: 'range', label: 'Length', default: 0.25, min: 0.02, max: 1, step: 0.005 },
    { key: 'variation', type: 'range', label: 'Variation', default: 0.6, min: 0, max: 1, step: 0.01 },
    { key: 'width', type: 'range', label: 'Width', default: 1, min: 0.2, max: 3, step: 0.05 },
    { key: 'grow', type: 'range', label: 'Grow time (s)', default: 0, min: 0, max: 60, step: 0.5 },
    { key: 'glint', type: 'range', label: 'Glint', default: 0.5, min: 0, max: 1, step: 0.01 },
  ],
  init() {
    return { spikes: null, count: 0 };
  },
  draw({ g, p, shape, t, rng, state }) {
    const { bbox } = shape;
    const count = Math.round(p.count);
    if (state.count !== count) {
      state.count = count;
      state.spikes = Array.from({ length: count }, () => ({
        len: 1 - p.variation * rng(),
        w: 0.6 + rng() * 0.8,
        glint: rng() * TAU,
      }));
    }

    const growth = p.grow > 0 ? clamp(t / p.grow, 0, 1) : 1;

    // Two placements. On a closed area, ice hangs from the top edge and is
    // clipped to the shape. On an open path — a gutter or a roofline, which is
    // what you actually trace for this — each icicle hangs from the path itself,
    // following its slope, with no clipping.
    const onPath = !shape.closed && shape.sampler.length > 0;
    const slot = onPath ? shape.sampler.length / count : bbox.w / count;
    const span = onPath ? Math.max(bbox.h, bbox.w * 0.3) : bbox.h;

    g.save();
    if (!onPath) g.clip(shape.path);

    for (let i = 0; i < count; i++) {
      const spike = state.spikes[i];
      const anchor = onPath
        ? shape.sampler.at((i + 0.5) / count)
        : { x: bbox.x + (i + 0.5) * slot, y: bbox.y };
      const x = anchor.x;
      const topY = anchor.y;
      const len = span * p.length * spike.len * growth;
      // Cap the width against the length. Spacing alone would let a sparse
      // string produce squat blue triangles rather than anything icicle-shaped.
      const w = Math.min(slot * 0.45 * p.width * spike.w, len * 0.3 * p.width);
      if (len <= 1 || w <= 0.2) continue;

      const grad = g.createLinearGradient(0, topY, 0, topY + len);
      grad.addColorStop(0, rgba(p.color, 0.9));
      grad.addColorStop(0.7, rgba(p.color, 0.55));
      grad.addColorStop(1, rgba(p.tip, 0.95));
      g.fillStyle = grad;

      g.beginPath();
      g.moveTo(x - w, topY);
      g.quadraticCurveTo(x - w * 0.35, topY + len * 0.65, x, topY + len);
      g.quadraticCurveTo(x + w * 0.35, topY + len * 0.65, x + w, topY);
      g.closePath();
      g.fill();

      if (p.glint > 0) {
        const sparkle = Math.max(0, Math.sin(t * 2 + spike.glint));
        if (sparkle > 0.9) {
          g.save();
          g.globalCompositeOperation = 'lighter';
          g.globalAlpha = (sparkle - 0.9) * 10 * p.glint;
          const gy = topY + len * 0.85;
          const grd = g.createRadialGradient(x, gy, 0, x, gy, w * 2.5);
          grd.addColorStop(0, '#ffffff');
          grd.addColorStop(1, 'rgba(255,255,255,0)');
          g.fillStyle = grd;
          g.beginPath();
          g.arc(x, gy, w * 2.5, 0, TAU);
          g.fill();
          g.restore();
        }
      }
    }
    g.restore();
  },
};

const stars = {
  id: 'stars',
  name: 'Twinkling Stars',
  category: 'christmas',
  scope: 'shape',
  description: 'A field of twinkling stars, with optional occasional shooting stars.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#ffffff' },
    { key: 'count', type: 'range', label: 'Stars', default: 140, min: 5, max: 900, step: 5 },
    { key: 'size', type: 'range', label: 'Size', default: 4, min: 0.5, max: 24, step: 0.25 },
    { key: 'twinkle', type: 'range', label: 'Twinkle speed', default: 1, min: 0, max: 8, step: 0.05 },
    { key: 'spikes', type: 'bool', label: 'Four-point spikes', default: true },
    { key: 'shooting', type: 'range', label: 'Shooting stars / min', default: 4, min: 0, max: 60, step: 1 },
  ],
  init() {
    return { stars: null, count: 0 };
  },
  draw({ g, p, shape, t, rng, state }) {
    const { bbox } = shape;
    const count = Math.round(p.count);
    if (state.count !== count) {
      state.count = count;
      state.stars = Array.from({ length: count }, () => ({
        x: rng(),
        y: rng(),
        s: 0.3 + rng() * 0.9,
        phase: rng() * TAU,
      }));
    }

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';

    for (const star of state.stars) {
      const x = bbox.x + star.x * bbox.w;
      const y = bbox.y + star.y * bbox.h;
      const tw = p.twinkle > 0 ? 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * p.twinkle + star.phase)) : 1;
      const r = p.size * star.s * 0.5 * tw;
      g.globalAlpha = tw;
      g.fillStyle = p.color;
      g.beginPath();
      g.arc(x, y, r, 0, TAU);
      g.fill();

      if (p.spikes && r > 1) {
        g.strokeStyle = rgba(p.color, 0.5 * tw);
        g.lineWidth = Math.max(0.5, r * 0.35);
        g.beginPath();
        g.moveTo(x - r * 3.2, y);
        g.lineTo(x + r * 3.2, y);
        g.moveTo(x, y - r * 3.2);
        g.lineTo(x, y + r * 3.2);
        g.stroke();
      }
    }

    if (p.shooting > 0) {
      const interval = 60 / p.shooting;
      const index = Math.floor(t / interval);
      const local = (t % interval) / 1.1;
      if (local < 1) {
        // Deterministic per shooting-star index, so all projectors agree.
        const sx = ((index * 9301 + 49297) % 233280) / 233280;
        const sy = ((index * 4523 + 12345) % 100000) / 100000;
        const x0 = bbox.x + sx * bbox.w;
        const y0 = bbox.y + sy * bbox.h * 0.5;
        const dx = bbox.w * 0.35;
        const dy = bbox.h * 0.22;
        const x = x0 + dx * local;
        const y = y0 + dy * local;
        const alpha = Math.sin(local * Math.PI);
        const grad = g.createLinearGradient(x - dx * 0.22, y - dy * 0.22, x, y);
        grad.addColorStop(0, rgba(p.color, 0));
        grad.addColorStop(1, rgba(p.color, alpha));
        g.globalAlpha = 1;
        g.strokeStyle = grad;
        g.lineWidth = p.size * 0.5;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(x - dx * 0.22, y - dy * 0.22);
        g.lineTo(x, y);
        g.stroke();
      }
    }
    g.restore();
  },
};

const aurora = {
  id: 'aurora',
  name: 'Aurora',
  category: 'christmas',
  scope: 'shape',
  description: 'Slow curtains of northern-lights colour. Lovely across a whole wall.',
  params: [
    { key: 'color', type: 'color', label: 'Colour A', default: '#2bff88' },
    { key: 'color2', type: 'color', label: 'Colour B', default: '#7b5cff' },
    { key: 'bands', type: 'range', label: 'Curtains', default: 5, min: 1, max: 14, step: 1 },
    { key: 'speed', type: 'range', label: 'Speed', default: 0.12, min: 0, max: 1.5, step: 0.005 },
    { key: 'amplitude', type: 'range', label: 'Waviness', default: 0.2, min: 0, max: 0.8, step: 0.01 },
    { key: 'thickness', type: 'range', label: 'Thickness', default: 0.22, min: 0.02, max: 1, step: 0.01 },
    { key: 'level', type: 'range', label: 'Brightness', default: 0.7, min: 0, max: 1.5, step: 0.01 },
  ],
  draw({ g, p, shape, t, noise }) {
    const { bbox } = shape;
    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha *= clamp(p.level, 0, 2);

    const bands = Math.round(p.bands);
    const cols = 40;
    for (let b = 0; b < bands; b++) {
      const f = b / Math.max(1, bands - 1 || 1);
      const colour = mixHex(p.color, p.color2, f);
      const yBase = bbox.y + bbox.h * (0.15 + f * 0.55);
      const thickness = bbox.h * p.thickness * (0.6 + 0.6 * (1 - f));

      g.beginPath();
      for (let i = 0; i <= cols; i++) {
        const u = i / cols;
        const x = bbox.x + u * bbox.w;
        const y = yBase + noise.noise3(u * 2.2, b * 3.7, t * p.speed) * bbox.h * p.amplitude;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      for (let i = cols; i >= 0; i--) {
        const u = i / cols;
        const x = bbox.x + u * bbox.w;
        const y =
          yBase +
          noise.noise3(u * 2.2, b * 3.7, t * p.speed) * bbox.h * p.amplitude +
          thickness * (0.6 + 0.4 * noise.noise2(u * 3, b));
        g.lineTo(x, y);
      }
      g.closePath();

      const grad = g.createLinearGradient(0, yBase - thickness * 0.3, 0, yBase + thickness);
      grad.addColorStop(0, rgba(colour, 0));
      grad.addColorStop(0.35, rgba(colour, 0.45));
      grad.addColorStop(1, rgba(colour, 0));
      g.fillStyle = grad;
      g.fill();
    }
    g.restore();
  },
};

const candyStripe = {
  id: 'candy-stripe',
  name: 'Candy Cane Stripes',
  category: 'christmas',
  scope: 'shape',
  description: 'Diagonal barber stripes that travel along the shape. Made for door frames.',
  params: [
    { key: 'color', type: 'color', label: 'Colour A', default: '#ff2d2d' },
    { key: 'color2', type: 'color', label: 'Colour B', default: '#ffffff' },
    { key: 'stripes', type: 'range', label: 'Stripes', default: 14, min: 2, max: 80, step: 1 },
    { key: 'angle', type: 'range', label: 'Angle', default: 35, min: 0, max: 180, step: 1 },
    { key: 'speed', type: 'range', label: 'Speed', default: 0.25, min: -3, max: 3, step: 0.01 },
    { key: 'mode', type: 'select', label: 'Mode', default: 'fill', options: ['fill', 'outline'] },
    { key: 'width', type: 'range', label: 'Outline width', default: 18, min: 1, max: 90, step: 0.5 },
  ],
  draw({ g, p, shape, t }) {
    const { bbox } = shape;
    if (bbox.w <= 0 || bbox.h <= 0) return;

    const a = (p.angle * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const diag = Math.hypot(bbox.w, bbox.h) * 1.2;
    const period = diag / Math.max(2, Math.round(p.stripes));
    const shift = frac(t * p.speed);
    const bands = Math.ceil(diag / period) + 2;

    // Stripe corners are computed in world coordinates rather than by rotating
    // the context, so the same band can clip a stroke of the untransformed path.
    const toWorld = (u, v) => ({
      x: bbox.cx + u * cos - v * sin,
      y: bbox.cy + u * sin + v * cos,
    });

    g.save();
    g.lineWidth = p.width;
    g.lineJoin = 'round';
    if (p.mode === 'fill') g.clip(shape.path);

    for (let i = -bands; i <= bands; i++) {
      const colour = (((i % 2) + 2) % 2) === 0 ? p.color : p.color2;
      const offset = (i + shift) * period;

      const c0 = toWorld(offset - period / 2, -diag);
      const c1 = toWorld(offset + period / 2, -diag);
      const c2 = toWorld(offset + period / 2, diag);
      const c3 = toWorld(offset - period / 2, diag);

      g.save();
      g.beginPath();
      g.moveTo(c0.x, c0.y);
      g.lineTo(c1.x, c1.y);
      g.lineTo(c2.x, c2.y);
      g.lineTo(c3.x, c3.y);
      g.closePath();

      if (p.mode === 'outline') {
        g.clip();
        g.strokeStyle = colour;
        g.stroke(shape.path);
      } else {
        g.fillStyle = colour;
        g.fill();
      }
      g.restore();
    }
    g.restore();
  },
};

export default [snow, santa, icicles, stars, aurora, candyStripe];
