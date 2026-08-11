/**
 * Halloween effects.
 *
 * A recurring trick in here: anything that should read as a *dark* shape on the
 * house is drawn with `destination-out` on top of a lit fill, not with black
 * paint. Projectors can't emit darkness, so a black silhouette on an unlit wall
 * is invisible — the figure has to be a hole punched in light.
 *
 * Randomness is seeded per event (per lightning strike, per drip) so two
 * projectors covering the same wall draw the identical bolt.
 */

import { rgba, clamp, lerp, TAU, frac, makeRng, mixHex } from '../../core/math.js';

const bloodDrip = {
  id: 'blood-drip',
  name: 'Blood Drip',
  category: 'halloween',
  scope: 'shape',
  description:
    'Runs blood down from the top edge of a shape. Point it at a window or a door frame.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#8b0000' },
    { key: 'highlight', type: 'color', label: 'Highlight', default: '#e01b24' },
    { key: 'count', type: 'range', label: 'Drips', default: 9, min: 1, max: 60, step: 1 },
    { key: 'speed', type: 'range', label: 'Speed', default: 0.16, min: 0.01, max: 2, step: 0.005 },
    { key: 'width', type: 'range', label: 'Thickness', default: 16, min: 1, max: 90, step: 0.5 },
    { key: 'variation', type: 'range', label: 'Variation', default: 0.6, min: 0, max: 1, step: 0.01 },
    { key: 'pool', type: 'range', label: 'Pool at top', default: 0.05, min: 0, max: 0.3, step: 0.005 },
    { key: 'droplets', type: 'bool', label: 'Falling droplets', default: true },
    { key: 'restart', type: 'bool', label: 'Loop', default: true },
  ],
  init() {
    return { drips: null, count: 0 };
  },
  draw({ g, p, shape, t, rng, state }) {
    const { bbox } = shape;
    if (bbox.h <= 0) return;
    const count = Math.max(1, Math.round(p.count));

    if (state.count !== count) {
      state.count = count;
      state.drips = Array.from({ length: count }, (_, i) => ({
        // Jitter within the column so drips don't look like a comb.
        x: bbox.x + ((i + 0.5) / count + (rng() - 0.5) * 0.6 / count) * bbox.w,
        rate: 1 - p.variation * rng(),
        delay: rng() * 4,
        wobble: rng() * 10,
        thickness: 0.6 + rng() * 0.8,
      }));
    }

    g.save();
    g.clip(shape.path);

    if (p.pool > 0) {
      const poolH = bbox.h * p.pool;
      const grad = g.createLinearGradient(0, bbox.y, 0, bbox.y + poolH * 1.6);
      grad.addColorStop(0, p.color);
      grad.addColorStop(1, rgba(p.color, 0));
      g.fillStyle = grad;
      g.fillRect(bbox.x, bbox.y, bbox.w, poolH * 1.6);
    }

    for (const drip of state.drips) {
      const elapsed = Math.max(0, t - drip.delay);
      let progress = elapsed * p.speed * drip.rate;
      if (p.restart) progress = frac(progress / 1.4) * 1.4;
      if (progress <= 0) continue;

      // Ease-in: blood hesitates at the lip then accelerates.
      const eased = Math.min(1.35, progress * progress * 0.6 + progress * 0.4);
      const headY = bbox.y + eased * bbox.h;
      const w = p.width * drip.thickness;
      const sway = Math.sin(t * 0.5 + drip.wobble) * w * 0.18;

      const grad = g.createLinearGradient(0, bbox.y, 0, headY);
      grad.addColorStop(0, p.color);
      grad.addColorStop(0.75, p.color);
      grad.addColorStop(1, p.highlight);
      g.fillStyle = grad;

      // Trail: a tapering ribbon rather than a rectangle, so it looks wet.
      g.beginPath();
      g.moveTo(drip.x - w / 2, bbox.y);
      g.quadraticCurveTo(drip.x - w * 0.35 + sway, (bbox.y + headY) / 2, drip.x - w * 0.3 + sway, headY);
      g.lineTo(drip.x + w * 0.3 + sway, headY);
      g.quadraticCurveTo(drip.x + w * 0.35 + sway, (bbox.y + headY) / 2, drip.x + w / 2, bbox.y);
      g.closePath();
      g.fill();

      // Bulbous head.
      g.fillStyle = p.highlight;
      g.beginPath();
      g.ellipse(drip.x + sway, headY, w * 0.5, w * 0.62, 0, 0, TAU);
      g.fill();
      g.fillStyle = rgba('#ffffff', 0.18);
      g.beginPath();
      g.ellipse(drip.x + sway - w * 0.15, headY - w * 0.15, w * 0.14, w * 0.2, 0, 0, TAU);
      g.fill();

      if (p.droplets && progress > 0.35) {
        const dropPhase = frac(elapsed * p.speed * drip.rate * 2.3 + drip.wobble);
        const dropY = bbox.y + dropPhase * bbox.h * 1.1;
        if (dropY > headY) {
          g.fillStyle = p.color;
          g.beginPath();
          g.ellipse(drip.x + sway, dropY, w * 0.25, w * 0.34, 0, 0, TAU);
          g.fill();
        }
      }
    }
    g.restore();
  },
};

const lightning = {
  id: 'lightning',
  name: 'Lightning',
  category: 'halloween',
  scope: 'global',
  description:
    'Full-frame storm flashes with a branching bolt. Runs on its own timer; every projector draws the same strike.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#dbe9ff' },
    { key: 'rate', type: 'range', label: 'Strikes / min', default: 6, min: 0.2, max: 60, step: 0.1 },
    { key: 'flash', type: 'range', label: 'Flash brightness', default: 0.55, min: 0, max: 1, step: 0.01 },
    { key: 'bolt', type: 'bool', label: 'Draw bolt', default: true },
    { key: 'thickness', type: 'range', label: 'Bolt thickness', default: 5, min: 1, max: 40, step: 0.5 },
    { key: 'branches', type: 'range', label: 'Branches', default: 4, min: 0, max: 14, step: 1 },
    { key: 'flickers', type: 'range', label: 'Flickers per strike', default: 3, min: 1, max: 8, step: 1 },
    { key: 'duration', type: 'range', label: 'Strike length (s)', default: 0.5, min: 0.05, max: 3, step: 0.01 },
  ],
  draw({ g, p, world, t }) {
    const interval = 60 / Math.max(0.2, p.rate);
    const strike = Math.floor(t / interval);

    // Offset each strike randomly within its slot. A metronomic flash reads as a
    // effect on a timer; this reads as weather. It also stops every projector
    // firing a bolt the instant the show is loaded.
    const slack = Math.max(0, interval - p.duration);
    const offset = makeRng(`when${strike}`)() * slack;
    const local = t - strike * interval - offset;
    if (local < 0 || local > p.duration) return;

    // One RNG per strike index: every tab, every frame, same bolt.
    const rng = makeRng(`bolt${strike}`);
    const phase = local / p.duration;

    // Stuttering intensity envelope — a real strike is several flashes.
    const flickers = Math.max(1, Math.round(p.flickers));
    const sub = Math.floor(phase * flickers);
    const subPhase = frac(phase * flickers);
    const gate = subPhase < 0.55 ? 1 : 0;
    const decay = Math.pow(1 - phase, 1.6);
    const intensity = gate * decay * (0.55 + 0.45 * makeRng(`f${strike}-${sub}`)());
    if (intensity <= 0.01) return;

    g.save();
    g.globalAlpha *= intensity;

    if (p.flash > 0) {
      g.fillStyle = p.color;
      g.globalAlpha = intensity * p.flash;
      g.fillRect(0, 0, world.w, world.h);
    }

    if (p.bolt) {
      g.globalAlpha = intensity;
      g.globalCompositeOperation = 'lighter';
      g.lineCap = 'round';
      g.lineJoin = 'round';

      const startX = rng() * world.w;
      const endX = startX + (rng() - 0.5) * world.w * 0.5;

      /** Jagged polyline from a to b, recursing into side branches. */
      const drawBolt = (x0, y0, x1, y1, thickness, depth) => {
        const segments = 12;
        const pts = [{ x: x0, y: y0 }];
        for (let i = 1; i <= segments; i++) {
          const f = i / segments;
          const jitter = (1 - f) * world.w * 0.06 * (rng() - 0.5) * 2;
          pts.push({ x: lerp(x0, x1, f) + jitter, y: lerp(y0, y1, f) });
        }

        g.strokeStyle = rgba(p.color, 0.25);
        g.lineWidth = thickness * 4;
        g.beginPath();
        g.moveTo(pts[0].x, pts[0].y);
        for (const pt of pts.slice(1)) g.lineTo(pt.x, pt.y);
        g.stroke();

        g.strokeStyle = '#ffffff';
        g.lineWidth = thickness;
        g.beginPath();
        g.moveTo(pts[0].x, pts[0].y);
        for (const pt of pts.slice(1)) g.lineTo(pt.x, pt.y);
        g.stroke();

        if (depth > 0) {
          const branchCount = Math.min(3, Math.round(p.branches / (depth + 1)));
          for (let b = 0; b < branchCount; b++) {
            const at = pts[1 + Math.floor(rng() * (pts.length - 2))];
            drawBolt(
              at.x,
              at.y,
              at.x + (rng() - 0.5) * world.w * 0.35,
              at.y + rng() * world.h * 0.35,
              thickness * 0.5,
              depth - 1
            );
          }
        }
      };

      drawBolt(startX, 0, endX, world.h * (0.6 + rng() * 0.5), p.thickness, p.branches > 0 ? 2 : 0);
    }
    g.restore();
  },
};

const fire = {
  id: 'fire',
  name: 'Fire',
  category: 'halloween',
  scope: 'shape',
  description: 'Flames licking up inside a shape. Works on windows, doors and chimneys.',
  params: [
    { key: 'hot', type: 'color', label: 'Core colour', default: '#fff3c4' },
    { key: 'mid', type: 'color', label: 'Mid colour', default: '#ff8c00' },
    { key: 'cool', type: 'color', label: 'Tip colour', default: '#b3160c' },
    { key: 'height', type: 'range', label: 'Flame height', default: 0.75, min: 0.1, max: 1.5, step: 0.01 },
    { key: 'count', type: 'range', label: 'Particles', default: 220, min: 20, max: 900, step: 10 },
    { key: 'speed', type: 'range', label: 'Speed', default: 1, min: 0.1, max: 4, step: 0.05 },
    { key: 'spread', type: 'range', label: 'Spread', default: 0.35, min: 0, max: 1.5, step: 0.01 },
    { key: 'size', type: 'range', label: 'Particle size', default: 0.16, min: 0.02, max: 0.6, step: 0.005 },
    { key: 'smoke', type: 'range', label: 'Smoke', default: 0, min: 0, max: 1, step: 0.01 },
    { key: 'downward', type: 'bool', label: 'Burn downward', default: false },
  ],
  init() {
    return { parts: [], count: 0 };
  },
  draw({ g, p, shape, dt, t, rng, state, noise }) {
    const { bbox } = shape;
    if (bbox.w <= 0 || bbox.h <= 0) return;
    const target = Math.round(p.count);
    const dir = p.downward ? 1 : -1;

    const spawn = (part = {}) => {
      part.x = bbox.x + (0.5 + (rng() - 0.5) * (0.6 + p.spread)) * bbox.w;
      part.y = p.downward ? bbox.y : bbox.y + bbox.h;
      part.vx = (rng() - 0.5) * bbox.w * 0.25 * p.spread;
      part.vy = dir * bbox.h * p.height * (0.35 + rng() * 0.4);
      part.life = 0.7 + rng() * 0.9;
      part.age = rng() * part.life;
      part.seed = rng() * 100;
      part.r = bbox.w * p.size * (0.4 + rng() * 0.9) * 0.25;
      return part;
    };

    while (state.parts.length < target) state.parts.push(spawn({}));
    if (state.parts.length > target) state.parts.length = target;

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';

    const step = dt * p.speed;
    for (const part of state.parts) {
      part.age += step;
      if (part.age >= part.life) {
        spawn(part);
        part.age = 0;
      }

      const n = noise.noise3(part.x * 0.006, part.y * 0.004, t * 0.8 + part.seed);
      part.x += (part.vx + n * bbox.w * 0.25) * step;
      part.y += part.vy * step;

      const f = clamp(part.age / part.life, 0, 1);
      // Colour ramp: white-hot at the base, deep red at the tip.
      const colour = f < 0.35 ? mixHex(p.hot, p.mid, f / 0.35) : mixHex(p.mid, p.cool, (f - 0.35) / 0.65);
      const alpha = Math.sin((1 - f) * Math.PI * 0.5) * 0.55;
      const radius = part.r * (0.5 + f * 1.3);

      const grad = g.createRadialGradient(part.x, part.y, 0, part.x, part.y, radius);
      grad.addColorStop(0, rgba(colour, alpha));
      grad.addColorStop(1, rgba(colour, 0));
      g.fillStyle = grad;
      g.beginPath();
      g.arc(part.x, part.y, radius, 0, TAU);
      g.fill();
    }

    if (p.smoke > 0) {
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = p.smoke * 0.25;
      for (let i = 0; i < 24; i++) {
        const u = frac(i * 0.137 + t * 0.05);
        const x = bbox.x + (0.5 + noise.noise2(i, t * 0.2) * 0.4) * bbox.w;
        const y = bbox.y + bbox.h * (p.downward ? u : 1 - u);
        const r = bbox.w * 0.18 * (0.4 + u);
        const grad = g.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, `rgba(40,40,45,${0.5 * (1 - u)})`);
        grad.addColorStop(1, 'rgba(40,40,45,0)');
        g.fillStyle = grad;
        g.beginPath();
        g.arc(x, y, r, 0, TAU);
        g.fill();
      }
    }
    g.restore();
  },
};

const candle = {
  id: 'candle',
  name: 'Candle Flicker',
  category: 'halloween',
  scope: 'shape',
  description:
    'Warm, unsteady light — the "somebody is home, and they should not be" look for windows.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#ffb45c' },
    { key: 'shadow', type: 'color', label: 'Shadow', default: '#2a0d00' },
    { key: 'level', type: 'range', label: 'Brightness', default: 0.85, min: 0, max: 1.5, step: 0.01 },
    { key: 'jitter', type: 'range', label: 'Flicker depth', default: 0.35, min: 0, max: 1, step: 0.01 },
    { key: 'rate', type: 'range', label: 'Flicker speed', default: 3.5, min: 0.2, max: 20, step: 0.1 },
    { key: 'gust', type: 'range', label: 'Gusts', default: 0.25, min: 0, max: 1, step: 0.01 },
    { key: 'hotspot', type: 'range', label: 'Hotspot', default: 0.6, min: 0, max: 1, step: 0.01 },
  ],
  draw({ g, p, shape, t, noise, i }) {
    const { bbox } = shape;
    // Offsetting the noise field per instance keeps a row of windows from
    // flickering in lockstep, which instantly reads as fake.
    const seedOffset = i * 37.7;
    const fast = noise.noise2(t * p.rate + seedOffset, 0);
    const slow = noise.noise2(t * p.rate * 0.13 + seedOffset, 11.3);
    // Occasional deep dip, as if a draught caught the flame.
    const gustField = noise.noise2(t * 0.35 + seedOffset, 41.1);
    const gust = p.gust > 0 && gustField > 0.55 ? 1 - p.gust * ((gustField - 0.55) / 0.45) : 1;

    const level = clamp(p.level * (1 + p.jitter * (fast * 0.7 + slow * 0.3)) * gust, 0, 2);
    if (level <= 0.005) return;

    g.save();
    g.globalAlpha *= level;

    if (p.hotspot > 0) {
      const cx = bbox.cx + slow * bbox.w * 0.08;
      const cy = bbox.cy + fast * bbox.h * 0.05;
      const grad = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(bbox.w, bbox.h) * 0.75);
      grad.addColorStop(0, p.color);
      grad.addColorStop(clamp(1 - p.hotspot, 0.05, 0.95), mixHex(p.color, p.shadow, 0.55));
      grad.addColorStop(1, p.shadow);
      g.fillStyle = grad;
    } else {
      g.fillStyle = p.color;
    }
    g.fill(shape.path);
    g.restore();
  },
};

const eyes = {
  id: 'eyes',
  name: 'Watching Eyes',
  category: 'halloween',
  scope: 'shape',
  description: 'Pairs of glowing eyes that blink and track around inside the shape.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#ffe74c' },
    { key: 'pupil', type: 'color', label: 'Pupil', default: '#1a0000' },
    { key: 'pairs', type: 'range', label: 'Pairs', default: 2, min: 1, max: 12, step: 1 },
    { key: 'size', type: 'range', label: 'Eye size', default: 0.1, min: 0.01, max: 0.4, step: 0.005 },
    { key: 'blink', type: 'range', label: 'Blink rate', default: 0.35, min: 0, max: 2, step: 0.01 },
    { key: 'wander', type: 'range', label: 'Wander', default: 0.3, min: 0, max: 1, step: 0.01 },
    { key: 'glow', type: 'range', label: 'Glow', default: 1.2, min: 0, max: 4, step: 0.05 },
  ],
  init() {
    return { eyes: null, count: 0 };
  },
  draw({ g, p, shape, t, rng, state, noise }) {
    const { bbox } = shape;
    const pairs = Math.max(1, Math.round(p.pairs));
    if (state.count !== pairs) {
      state.count = pairs;
      state.eyes = Array.from({ length: pairs }, () => ({
        x: 0.15 + rng() * 0.7,
        y: 0.15 + rng() * 0.7,
        scale: 0.7 + rng() * 0.6,
        phase: rng() * 100,
        blinkOffset: rng() * 10,
      }));
    }

    const eyeR = Math.min(bbox.w, bbox.h) * p.size * 0.5;
    g.save();
    g.clip(shape.path);

    for (const eye of state.eyes) {
      const driftX = noise.noise2(t * 0.12, eye.phase) * p.wander * bbox.w * 0.12;
      const driftY = noise.noise2(t * 0.1, eye.phase + 50) * p.wander * bbox.h * 0.08;
      const cx = bbox.x + eye.x * bbox.w + driftX;
      const cy = bbox.y + eye.y * bbox.h + driftY;
      const gap = eyeR * 2.6 * eye.scale;
      const r = eyeR * eye.scale;

      // Blink: a short closure on a slow, per-eye offset cycle.
      let open = 1;
      if (p.blink > 0) {
        const cycle = frac(t * p.blink * 0.35 + eye.blinkOffset);
        if (cycle < 0.07) open = Math.abs(cycle / 0.035 - 1);
      }
      if (open <= 0.02) continue;

      // Gaze direction wanders slowly, both eyes together.
      const gazeX = noise.noise2(t * 0.3, eye.phase + 200) * r * 0.35;
      const gazeY = noise.noise2(t * 0.28, eye.phase + 300) * r * 0.25;

      for (const side of [-1, 1]) {
        const ex = cx + (side * gap) / 2;
        if (p.glow > 0) {
          g.globalCompositeOperation = 'lighter';
          const grad = g.createRadialGradient(ex, cy, 0, ex, cy, r * (2 + p.glow));
          grad.addColorStop(0, rgba(p.color, 0.5));
          grad.addColorStop(1, rgba(p.color, 0));
          g.fillStyle = grad;
          g.beginPath();
          g.arc(ex, cy, r * (2 + p.glow), 0, TAU);
          g.fill();
          g.globalCompositeOperation = 'source-over';
        }
        g.fillStyle = p.color;
        g.beginPath();
        g.ellipse(ex, cy, r, r * 0.62 * open, 0, 0, TAU);
        g.fill();

        g.fillStyle = p.pupil;
        g.beginPath();
        g.ellipse(ex + gazeX, cy + gazeY, r * 0.3, r * 0.42 * open, 0, 0, TAU);
        g.fill();
      }
    }
    g.restore();
  },
};

const silhouette = {
  id: 'silhouette',
  name: 'Shadow in the Window',
  category: 'halloween',
  scope: 'shape',
  description:
    'A lit window with a figure walking past. The figure is cut out of the light, so it reads as a real shadow.',
  params: [
    { key: 'color', type: 'color', label: 'Window light', default: '#ffbe6f' },
    { key: 'figure', type: 'select', label: 'Figure', default: 'person', options: ['person', 'creature', 'cat', 'reaper'] },
    { key: 'speed', type: 'range', label: 'Speed', default: 0.12, min: 0.01, max: 1.5, step: 0.005 },
    { key: 'size', type: 'range', label: 'Size', default: 0.85, min: 0.2, max: 1.6, step: 0.01 },
    { key: 'direction', type: 'select', label: 'Direction', default: 'right', options: ['right', 'left', 'pace'] },
    { key: 'pause', type: 'range', label: 'Pause & stare', default: 0.3, min: 0, max: 1, step: 0.01 },
    { key: 'level', type: 'range', label: 'Light level', default: 0.9, min: 0, max: 1.5, step: 0.01 },
  ],
  draw({ g, p, shape, t }) {
    const { bbox } = shape;
    if (bbox.w <= 0 || bbox.h <= 0) return;

    g.save();
    g.globalAlpha *= clamp(p.level, 0, 2);
    g.fillStyle = p.color;
    g.fill(shape.path);
    g.globalAlpha = 1;
    g.clip(shape.path);

    // Where along the window the figure is, 0..1 with generous margins so it
    // enters and leaves off-frame.
    let u;
    let facing = 1;
    const cycle = frac(t * p.speed);
    if (p.direction === 'pace') {
      const tri = Math.abs(cycle * 2 - 1);
      u = -0.25 + tri * 1.5;
      facing = cycle < 0.5 ? 1 : -1;
    } else if (p.direction === 'left') {
      u = 1.25 - cycle * 1.5;
      facing = -1;
    } else {
      u = -0.25 + cycle * 1.5;
    }

    // Optional hesitation in the middle: freeze the walk and turn to face out.
    let stride = t * p.speed * 14;
    let staring = 0;
    if (p.pause > 0) {
      const holdWindow = 0.18 * p.pause;
      const d = Math.abs(cycle - 0.5);
      if (d < holdWindow) {
        staring = 1 - d / holdWindow;
        u = p.direction === 'left' ? 1.25 - 0.5 * 1.5 : -0.25 + 0.5 * 1.5;
        stride = 0;
      }
    }

    const h = bbox.h * p.size;
    const x = bbox.x + u * bbox.w;
    const groundY = bbox.y + bbox.h * 1.02;

    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = '#000';
    g.strokeStyle = '#000';
    g.lineCap = 'round';
    g.lineJoin = 'round';

    drawFigure(g, p.figure, x, groundY, h, stride, facing, staring);
    g.restore();
  },
};

/** Procedural silhouettes. Crude by design — a sharp shadow reads better than detail. */
function drawFigure(g, kind, x, groundY, h, stride, facing, staring) {
  const swing = Math.sin(stride) * (staring > 0 ? 0 : 1);
  const swing2 = Math.sin(stride + Math.PI) * (staring > 0 ? 0 : 1);
  const bob = Math.abs(Math.sin(stride)) * h * 0.015;

  if (kind === 'cat') {
    const bodyH = h * 0.28;
    const y = groundY - bodyH;
    g.beginPath();
    g.ellipse(x, y, bodyH * 1.5, bodyH * 0.55, 0, 0, TAU);
    g.fill();
    // Head, ears and a curling tail.
    g.beginPath();
    g.arc(x + facing * bodyH * 1.5, y - bodyH * 0.5, bodyH * 0.45, 0, TAU);
    g.fill();
    g.beginPath();
    g.moveTo(x + facing * bodyH * 1.2, y - bodyH * 0.75);
    g.lineTo(x + facing * bodyH * 1.35, y - bodyH * 1.35);
    g.lineTo(x + facing * bodyH * 1.6, y - bodyH * 0.85);
    g.closePath();
    g.fill();
    g.lineWidth = bodyH * 0.22;
    g.beginPath();
    g.moveTo(x - facing * bodyH * 1.5, y);
    g.quadraticCurveTo(x - facing * bodyH * 2.6, y - bodyH * 0.4, x - facing * bodyH * 2.2, y - bodyH * 1.4);
    g.stroke();
    g.lineWidth = bodyH * 0.18;
    for (const off of [-0.7, 0.7]) {
      g.beginPath();
      g.moveTo(x + off * bodyH, y + bodyH * 0.4);
      g.lineTo(x + off * bodyH + swing * bodyH * 0.3, groundY);
      g.stroke();
    }
    return;
  }

  const headR = h * 0.075;
  const shoulderY = groundY - h * 0.72;
  const hipY = groundY - h * 0.42;
  const headY = groundY - h * 0.85 + bob;

  if (kind === 'reaper') {
    // A hooded robe: one big flared shape plus a dark hollow where a face isn't.
    g.beginPath();
    g.moveTo(x, headY - headR * 1.6);
    g.quadraticCurveTo(x + h * 0.16, shoulderY, x + h * 0.2, groundY);
    g.lineTo(x - h * 0.2, groundY);
    g.quadraticCurveTo(x - h * 0.16, shoulderY, x, headY - headR * 1.6);
    g.closePath();
    g.fill();
    g.lineWidth = h * 0.02;
    g.beginPath();
    g.moveTo(x + facing * h * 0.16, groundY - h * 0.05);
    g.lineTo(x + facing * h * 0.2, headY - h * 0.12);
    g.stroke();
    g.beginPath();
    g.moveTo(x + facing * h * 0.2, headY - h * 0.12);
    g.quadraticCurveTo(x + facing * h * 0.36, headY - h * 0.06, x + facing * h * 0.28, headY + h * 0.06);
    g.stroke();
    return;
  }

  const lean = kind === 'creature' ? facing * h * 0.06 : 0;

  g.beginPath();
  g.arc(x + lean, headY, headR * (kind === 'creature' ? 0.85 : 1), 0, TAU);
  g.fill();

  g.lineWidth = h * (kind === 'creature' ? 0.05 : 0.075);
  g.beginPath();
  g.moveTo(x + lean, headY + headR);
  g.lineTo(x, hipY);
  g.stroke();

  // Arms.
  g.lineWidth = h * 0.038;
  for (const [s, dir] of [[swing, 1], [swing2, -1]]) {
    g.beginPath();
    g.moveTo(x + lean * 0.5, shoulderY);
    const elbowX = x + lean * 0.5 + dir * h * 0.06 + s * h * 0.05;
    g.quadraticCurveTo(elbowX, shoulderY + h * 0.12, elbowX + s * h * 0.06, shoulderY + h * 0.24);
    g.stroke();
  }
  if (kind === 'creature') {
    // Longer, wrong-jointed arms hanging past the knees.
    g.lineWidth = h * 0.03;
    for (const dir of [-1, 1]) {
      g.beginPath();
      g.moveTo(x + lean * 0.5, shoulderY + h * 0.02);
      g.quadraticCurveTo(x + dir * h * 0.12, hipY, x + dir * h * 0.09 + swing * h * 0.04, groundY - h * 0.1);
      g.stroke();
    }
  }

  // Legs.
  g.lineWidth = h * 0.045;
  for (const s of [swing, swing2]) {
    g.beginPath();
    g.moveTo(x, hipY);
    g.quadraticCurveTo(x + s * h * 0.07, hipY + h * 0.2, x + s * h * 0.12, groundY);
    g.stroke();
  }
}

const ghost = {
  id: 'ghost',
  name: 'Ghost',
  category: 'halloween',
  scope: 'shape',
  description: 'A translucent apparition drifting through the shape, fading in and out.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#cfe8ff' },
    { key: 'count', type: 'range', label: 'Ghosts', default: 1, min: 1, max: 8, step: 1 },
    { key: 'size', type: 'range', label: 'Size', default: 0.55, min: 0.1, max: 1.5, step: 0.01 },
    { key: 'speed', type: 'range', label: 'Speed', default: 0.08, min: 0.005, max: 1, step: 0.005 },
    { key: 'opacity', type: 'range', label: 'Opacity', default: 0.45, min: 0.02, max: 1, step: 0.01 },
    { key: 'wobble', type: 'range', label: 'Wobble', default: 1, min: 0, max: 3, step: 0.05 },
    { key: 'fade', type: 'bool', label: 'Fade in/out', default: true },
  ],
  draw({ g, p, shape, t, noise }) {
    const { bbox } = shape;
    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';

    for (let k = 0; k < Math.round(p.count); k++) {
      const seed = k * 91.7;
      const cycle = frac(t * p.speed + k / Math.max(1, p.count));
      const x = bbox.x + bbox.w * (-0.2 + cycle * 1.4);
      const y = bbox.cy + noise.noise2(t * 0.25 + seed, 0) * bbox.h * 0.25;
      const h = bbox.h * p.size;
      const w = h * 0.6;

      const alpha = p.fade ? Math.sin(cycle * Math.PI) * p.opacity : p.opacity;
      if (alpha <= 0.01) continue;

      g.globalAlpha = alpha;
      const grad = g.createRadialGradient(x, y - h * 0.15, 0, x, y, h * 0.8);
      grad.addColorStop(0, rgba(p.color, 0.95));
      grad.addColorStop(0.55, rgba(p.color, 0.35));
      grad.addColorStop(1, rgba(p.color, 0));
      g.fillStyle = grad;

      // Body: a dome with a ragged, waving hem.
      g.beginPath();
      g.moveTo(x - w / 2, y + h * 0.35);
      g.quadraticCurveTo(x - w / 2, y - h * 0.5, x, y - h * 0.5);
      g.quadraticCurveTo(x + w / 2, y - h * 0.5, x + w / 2, y + h * 0.35);
      const tails = 5;
      for (let i = tails; i >= 0; i--) {
        const f = i / tails;
        const tx = x - w / 2 + f * w;
        const wave = Math.sin(f * Math.PI * tails + t * 3 * p.wobble + seed) * h * 0.07 * p.wobble;
        g.lineTo(tx, y + h * 0.35 + wave + (i % 2 ? h * 0.05 : 0));
      }
      g.closePath();
      g.fill();

      // Hollow eyes, subtracted from the glow.
      g.globalCompositeOperation = 'destination-out';
      g.globalAlpha = alpha * 1.6;
      for (const side of [-1, 1]) {
        g.beginPath();
        g.ellipse(x + side * w * 0.17, y - h * 0.18, w * 0.09, h * 0.08, 0, 0, TAU);
        g.fill();
      }
      g.beginPath();
      g.ellipse(x, y - h * 0.02, w * 0.08, h * 0.06, 0, 0, TAU);
      g.fill();
      g.globalCompositeOperation = 'lighter';
    }
    g.restore();
  },
};

const web = {
  id: 'web',
  name: 'Spider Web',
  category: 'halloween',
  scope: 'shape',
  description: 'A web anchored in a corner of the shape, with a spider that comes and goes.',
  params: [
    { key: 'color', type: 'color', label: 'Web colour', default: '#e8f0ff' },
    { key: 'corner', type: 'select', label: 'Anchor', default: 'top-left', options: ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'centre'] },
    { key: 'rings', type: 'range', label: 'Rings', default: 6, min: 2, max: 16, step: 1 },
    { key: 'spokes', type: 'range', label: 'Spokes', default: 10, min: 3, max: 28, step: 1 },
    { key: 'width', type: 'range', label: 'Thread width', default: 2, min: 0.5, max: 12, step: 0.25 },
    { key: 'scale', type: 'range', label: 'Size', default: 1, min: 0.2, max: 2, step: 0.01 },
    { key: 'spider', type: 'bool', label: 'Spider', default: true },
    { key: 'spiderSpeed', type: 'range', label: 'Spider speed', default: 0.12, min: 0.01, max: 1, step: 0.005 },
    { key: 'sway', type: 'range', label: 'Sway', default: 0.4, min: 0, max: 2, step: 0.01 },
  ],
  draw({ g, p, shape, t, noise }) {
    const { bbox } = shape;
    const corners = {
      'top-left': [bbox.x, bbox.y, 0, 90],
      'top-right': [bbox.x + bbox.w, bbox.y, 90, 180],
      'bottom-left': [bbox.x, bbox.y + bbox.h, 270, 360],
      'bottom-right': [bbox.x + bbox.w, bbox.y + bbox.h, 180, 270],
      centre: [bbox.cx, bbox.cy, 0, 360],
    };
    const [ax, ay, a0deg, a1deg] = corners[p.corner] || corners['top-left'];
    const a0 = (a0deg * Math.PI) / 180;
    const a1 = (a1deg * Math.PI) / 180;
    const maxR = Math.hypot(bbox.w, bbox.h) * (p.corner === 'centre' ? 0.45 : 0.85) * p.scale;
    const spokes = Math.round(p.spokes);
    const rings = Math.round(p.rings);
    const sway = (i) => noise.noise2(t * 0.4, i * 3.1) * p.sway * maxR * 0.01;

    g.save();
    g.clip(shape.path);
    g.strokeStyle = p.color;
    g.lineWidth = p.width;
    g.globalAlpha *= 0.85;

    for (let s = 0; s <= spokes; s++) {
      const a = lerp(a0, a1, s / spokes);
      g.beginPath();
      g.moveTo(ax, ay);
      g.lineTo(ax + Math.cos(a) * maxR + sway(s), ay + Math.sin(a) * maxR + sway(s + 7));
      g.stroke();
    }

    // Rings sag between spokes, which is what makes it look spun rather than drawn.
    for (let r = 1; r <= rings; r++) {
      const radius = (r / rings) * maxR;
      g.beginPath();
      for (let s = 0; s <= spokes; s++) {
        const a = lerp(a0, a1, s / spokes);
        const x = ax + Math.cos(a) * radius + sway(s + r);
        const y = ay + Math.sin(a) * radius + sway(s + r + 13);
        if (s === 0) g.moveTo(x, y);
        else {
          const aPrev = lerp(a0, a1, (s - 1) / spokes);
          const aMid = (a + aPrev) / 2;
          const sag = radius * 0.93;
          g.quadraticCurveTo(ax + Math.cos(aMid) * sag, ay + Math.sin(aMid) * sag, x, y);
        }
      }
      g.stroke();
    }

    if (p.spider) {
      const phase = frac(t * p.spiderSpeed);
      // Out along a thread, pause, back again.
      const out = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
      const sa = lerp(a0, a1, 0.5 + noise.noise2(Math.floor(t * p.spiderSpeed), 0) * 0.3);
      const sr = 0.15 * maxR + out * maxR * 0.7;
      const sx = ax + Math.cos(sa) * sr;
      const sy = ay + Math.sin(sa) * sr;
      const bodyR = maxR * 0.035;

      g.globalAlpha = 1;
      g.fillStyle = p.color;
      g.lineWidth = Math.max(0.8, p.width * 0.8);
      for (let l = 0; l < 8; l++) {
        const la = (l / 8) * TAU + Math.sin(t * 6 + l) * 0.14;
        g.beginPath();
        g.moveTo(sx, sy);
        g.quadraticCurveTo(
          sx + Math.cos(la) * bodyR * 2.2,
          sy + Math.sin(la) * bodyR * 1.4,
          sx + Math.cos(la) * bodyR * 3,
          sy + Math.sin(la) * bodyR * 3
        );
        g.stroke();
      }
      g.beginPath();
      g.ellipse(sx, sy, bodyR * 1.4, bodyR, 0, 0, TAU);
      g.fill();
    }
    g.restore();
  },
};

const fog = {
  id: 'fog',
  name: 'Rolling Fog',
  category: 'halloween',
  scope: 'shape',
  description: 'Slow drifting mist. Put it on a whole wall, or low across the front of the house.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#8ea6c0' },
    { key: 'density', type: 'range', label: 'Density', default: 0.35, min: 0, max: 1, step: 0.01 },
    { key: 'scale', type: 'range', label: 'Scale', default: 2.2, min: 0.3, max: 10, step: 0.05 },
    { key: 'speed', type: 'range', label: 'Drift speed', default: 0.06, min: -0.6, max: 0.6, step: 0.005 },
    { key: 'layers', type: 'range', label: 'Layers', default: 3, min: 1, max: 6, step: 1 },
    { key: 'height', type: 'range', label: 'Height', default: 1, min: 0.1, max: 1, step: 0.01 },
  ],
  draw({ g, p, shape, t, noise }) {
    const { bbox } = shape;
    if (bbox.w <= 0 || bbox.h <= 0) return;

    g.save();
    g.clip(shape.path);

    // Fog is drawn as overlapping soft blobs positioned by noise. Sampling a
    // texture per-pixel would look better but costs far more than it's worth at
    // projector distance.
    const blobs = 26;
    for (let layer = 0; layer < Math.round(p.layers); layer++) {
      const depth = layer / Math.max(1, p.layers - 1 || 1);
      const speed = p.speed * (0.4 + depth);
      g.globalAlpha = p.density * (0.35 - depth * 0.12);
      for (let i = 0; i < blobs; i++) {
        const nx = noise.noise2(i * 0.7 + layer * 13, t * 0.05 * (1 + layer));
        const ny = noise.noise2(i * 0.9 + layer * 29, t * 0.04);
        const x = bbox.x + frac(i / blobs + t * speed + nx * 0.05) * bbox.w * 1.2 - bbox.w * 0.1;
        const y = bbox.y + bbox.h * (1 - p.height * (0.15 + 0.7 * Math.abs(ny)));
        const r = (bbox.w / p.scale) * (0.4 + Math.abs(nx) * 0.6);
        const grad = g.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, rgba(p.color, 0.8));
        grad.addColorStop(1, rgba(p.color, 0));
        g.fillStyle = grad;
        g.beginPath();
        g.arc(x, y, r, 0, TAU);
        g.fill();
      }
    }
    g.restore();
  },
};

const portal = {
  id: 'portal',
  name: 'Portal',
  category: 'halloween',
  scope: 'shape',
  description: 'A swirling vortex filling the shape. Doors become somewhere else.',
  params: [
    { key: 'color', type: 'color', label: 'Inner', default: '#8a2be2' },
    { key: 'color2', type: 'color', label: 'Outer', default: '#00ffc8' },
    { key: 'arms', type: 'range', label: 'Arms', default: 5, min: 1, max: 16, step: 1 },
    { key: 'twist', type: 'range', label: 'Twist', default: 3, min: 0, max: 12, step: 0.1 },
    { key: 'speed', type: 'range', label: 'Speed', default: 0.5, min: -3, max: 3, step: 0.01 },
    { key: 'detail', type: 'range', label: 'Detail', default: 60, min: 12, max: 200, step: 1 },
    { key: 'core', type: 'range', label: 'Core size', default: 0.15, min: 0, max: 0.8, step: 0.01 },
  ],
  draw({ g, p, shape, t }) {
    const { bbox } = shape;
    const R = Math.max(bbox.w, bbox.h) * 0.6;
    g.save();
    g.clip(shape.path);
    g.translate(bbox.cx, bbox.cy);
    g.globalCompositeOperation = 'lighter';

    const steps = Math.round(p.detail);
    g.lineCap = 'round';
    for (let a = 0; a < p.arms; a++) {
      const base = (a / p.arms) * TAU + t * p.speed;
      g.beginPath();
      for (let i = 0; i <= steps; i++) {
        const f = i / steps;
        const r = R * f;
        const angle = base + f * p.twist;
        const x = Math.cos(angle) * r;
        const y = Math.sin(angle) * r * (bbox.h / Math.max(1, bbox.w));
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      const grad = g.createRadialGradient(0, 0, 0, 0, 0, R);
      grad.addColorStop(0, rgba(p.color, 0.9));
      grad.addColorStop(1, rgba(p.color2, 0));
      g.strokeStyle = grad;
      g.lineWidth = R * 0.08;
      g.stroke();
    }

    if (p.core > 0) {
      const cr = R * p.core;
      const grad = g.createRadialGradient(0, 0, 0, 0, 0, cr);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.4, rgba(p.color, 0.8));
      grad.addColorStop(1, rgba(p.color, 0));
      g.fillStyle = grad;
      g.beginPath();
      g.arc(0, 0, cr, 0, TAU);
      g.fill();
    }
    g.restore();
  },
};

export default [bloodDrip, lightning, fire, candle, eyes, silhouette, ghost, web, fog, portal];
