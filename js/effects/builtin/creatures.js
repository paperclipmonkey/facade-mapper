/**
 * Things that move across the house.
 *
 * A flock, a firework, a face in a window. These are the moments people
 * actually point at, and they work because they are *events* — something
 * happens, then it stops, then later it happens again. An effect that runs
 * continuously becomes wallpaper within a minute; one that appears every couple
 * of minutes keeps a crowd watching.
 *
 * That is why most of these have an interval rather than just a speed.
 */

import { rgba, clamp, lerp, TAU, frac, makeRng } from '../../core/math.js';
import { blackbodyCss } from '../color.js';

const bats = {
  id: 'bats',
  name: 'Bat Swarm',
  category: 'halloween',
  scope: 'shape',
  description:
    'A flock crossing the frame with flapping wings and a bit of flocking wander. Set an interval so they arrive, then leave.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#12040f' },
    { key: 'silhouette', type: 'bool', label: 'Cut out of light', default: false },
    { key: 'count', type: 'range', label: 'Bats', default: 14, min: 1, max: 80, step: 1 },
    { key: 'size', type: 'range', label: 'Wingspan', default: 0.09, min: 0.01, max: 0.5, step: 0.005 },
    { key: 'speed', type: 'range', label: 'Speed', default: 0.16, min: 0.01, max: 1.5, step: 0.005 },
    { key: 'flap', type: 'range', label: 'Flap rate', default: 7, min: 0.5, max: 24, step: 0.1 },
    { key: 'spread', type: 'range', label: 'Flock spread', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'wander', type: 'range', label: 'Wander', default: 0.35, min: 0, max: 1, step: 0.01 },
    { key: 'direction', type: 'select', label: 'Direction', default: 'right', options: ['right', 'left'] },
    { key: 'interval', type: 'range', label: 'Every (s)', default: 0, min: 0, max: 600, step: 1 },
    { key: 'crossing', type: 'range', label: 'Crossing time (s)', default: 12, min: 1, max: 120, step: 0.5 },
  ],
  init() {
    return { flock: null, count: 0 };
  },
  /**
   * Cast the flock, at a moment every tab agrees on.
   *
   * Everything else here is a function of `t`, so the flock is the only thing
   * that could differ between two tabs — and it would have, because it used to
   * be cast on the first frame *drawn* and `rng` is seeded from the simulation
   * step the frame landed on. Casting from `step` puts it on step one always.
   */
  step({ p, rng, state }) {
    const count = Math.round(p.count);
    if (state.count === count) return;
    state.count = count;
    state.flock = Array.from({ length: count }, () => ({
      lane: rng(),
      lead: rng(),
      scale: 0.6 + rng() * 0.8,
      seed: rng() * 100,
      flapOffset: rng() * TAU,
    }));
  },
  draw({ g, p, shape, t, state, noise }) {
    const { bbox } = shape;
    if (!state.flock) return;

    // interval 0 means "always flying"; otherwise they arrive on a schedule.
    let phaseT = t;
    if (p.interval > 0) {
      const cycle = t % Math.max(1, p.interval);
      if (cycle > p.crossing) return;
      phaseT = cycle;
    }

    const dir = p.direction === 'left' ? -1 : 1;
    const span = p.interval > 0 ? phaseT / Math.max(0.1, p.crossing) : frac(phaseT * p.speed);

    g.save();
    g.clip(shape.path);
    if (p.silhouette) {
      g.globalCompositeOperation = 'destination-out';
      g.fillStyle = '#000';
    } else {
      g.fillStyle = p.color;
    }

    for (const bat of state.flock) {
      // Each bat trails the leader by its own amount, so the flock is strung out.
      const progress = span - bat.lead * p.spread * 0.5;
      if (progress < -0.2 || progress > 1.2) continue;

      const baseX = dir > 0 ? bbox.x - bbox.w * 0.15 : bbox.x + bbox.w * 1.15;
      const x = baseX + dir * progress * bbox.w * 1.3;
      const laneY = bbox.y + lerp(0.15, 0.85, bat.lane) * bbox.h;
      const wanderY = noise.noise2(phaseT * 0.5 + bat.seed, 0) * bbox.h * 0.12 * p.wander;
      const wanderX = noise.noise2(phaseT * 0.4 + bat.seed + 50, 0) * bbox.w * 0.05 * p.wander;
      const y = laneY + wanderY;

      const wing = Math.sin(phaseT * p.flap * TAU * 0.5 + bat.flapOffset);
      drawBat(g, x + wanderX, y, bbox.h * p.size * bat.scale, wing, dir);
    }
    g.restore();
  },
};

/**
 * One bat, drawn as two swept wings and a body.
 *
 * The wings are quadratic curves whose control points move with the flap
 * parameter — cheap, and the scalloped trailing edge is what makes the
 * silhouette read as "bat" rather than "bird" at a distance.
 */
function drawBat(g, x, y, span, flap, dir) {
  const w = span * 0.5;
  const h = span * 0.34;
  const lift = flap * h * 0.9;

  g.save();
  g.translate(x, y);
  g.scale(dir, 1);

  g.beginPath();
  g.moveTo(0, 0);
  for (const side of [-1, 1]) {
    g.moveTo(0, 0);
    // Leading edge out to the wingtip.
    g.quadraticCurveTo(side * w * 0.5, -h * 0.5 - lift * 0.6, side * w, -lift);
    // Scalloped trailing edge back to the body.
    g.quadraticCurveTo(side * w * 0.72, h * 0.25 - lift * 0.35, side * w * 0.55, -lift * 0.1);
    g.quadraticCurveTo(side * w * 0.45, h * 0.4 - lift * 0.2, side * w * 0.3, h * 0.05);
    g.quadraticCurveTo(side * w * 0.2, h * 0.4, 0, h * 0.2);
    g.closePath();
  }
  g.fill();

  g.beginPath();
  g.ellipse(0, 0, span * 0.07, span * 0.13, 0, 0, TAU);
  g.fill();

  // Ears.
  g.beginPath();
  g.moveTo(-span * 0.05, -span * 0.1);
  g.lineTo(-span * 0.08, -span * 0.2);
  g.lineTo(-span * 0.01, -span * 0.12);
  g.closePath();
  g.moveTo(span * 0.05, -span * 0.1);
  g.lineTo(span * 0.08, -span * 0.2);
  g.lineTo(span * 0.01, -span * 0.12);
  g.closePath();
  g.fill();

  g.restore();
}

/**
 * How long a shell takes to reach apogee, in seconds.
 *
 * Up here rather than inside `draw` because `cues` needs the same number to
 * tell the soundscape when the break happens, and two copies of it would drift
 * the bang off the flash the first time anybody tuned one of them.
 */
const SHELL_RISE = 0.9;

const fireworks = {
  id: 'fireworks',
  name: 'Fireworks',
  category: 'christmas',
  scope: 'shape',
  description:
    'Shells that rise, burst and fall with gravity and trails. Good for New Year, or a big finish.',
  params: [
    { key: 'palette', type: 'select', label: 'Palette', default: 'multi', options: ['multi', 'warm', 'cool', 'gold', 'single'] },
    { key: 'color', type: 'color', label: 'Single colour', default: '#ffd166' },
    { key: 'rate', type: 'range', label: 'Shells / min', default: 26, min: 1, max: 240, step: 1 },
    { key: 'sparks', type: 'range', label: 'Sparks per shell', default: 70, min: 8, max: 300, step: 1 },
    { key: 'power', type: 'range', label: 'Burst size', default: 0.32, min: 0.03, max: 1.2, step: 0.01 },
    { key: 'gravity', type: 'range', label: 'Gravity', default: 0.28, min: 0, max: 2, step: 0.01 },
    { key: 'life', type: 'range', label: 'Spark life (s)', default: 1.8, min: 0.3, max: 8, step: 0.05 },
    { key: 'trail', type: 'bool', label: 'Rising trail', default: true },
    { key: 'level', type: 'range', label: 'Brightness', default: 1, min: 0, max: 2, step: 0.01 },
  ],
  /**
   * When each shell leaves the ground and when it breaks, in show time.
   *
   * Two events per shell: the lift, which the sound follows up as a rush, and
   * the break, which is the bang. Both derive from the shell index the same way
   * `draw` derives the picture from it, so the report lands on the flash rather
   * than near it — see `cue` in core/soundscape.js.
   *
   * Once per layer, not once per target. A layer pointed at four windows draws
   * four bursts but they are the same four shells on the same clock, and four
   * copies of one bang is one muddy bang.
   */
  cues(p, from, to) {
    const interval = 60 / Math.max(1, p.rate);
    const events = [];
    const first = Math.max(0, Math.floor((from - SHELL_RISE) / interval));
    for (let index = first; index <= Math.floor(to / interval); index++) {
      const launch = index * interval;
      // Only when the rising trail is actually drawn: a sound for something
      // invisible is a sound coming from nowhere.
      if (p.trail && launch >= from && launch < to) {
        events.push({ at: launch, kind: 'rise', duration: SHELL_RISE, level: 1 });
      }
      const breaks = launch + SHELL_RISE;
      if (breaks >= from && breaks < to) {
        events.push({ at: breaks, kind: 'burst', level: clamp(0.45 + p.power * 0.55, 0.15, 1) });
      }
    }
    return events;
  },
  draw({ g, p, shape, t }) {
    const { bbox } = shape;
    if (bbox.w <= 0 || bbox.h <= 0) return;

    const palettes = {
      multi: ['#ff3b6b', '#ffd166', '#4cc2ff', '#8aff80', '#c77dff'],
      warm: ['#ff8a3d', '#ffd166', '#ff5c5c'],
      cool: ['#7fd8ff', '#a0b8ff', '#c77dff'],
      gold: ['#ffd166', '#ffb347', '#fff3c4'],
      single: [p.color],
    };
    const palette = palettes[p.palette] || palettes.multi;

    const interval = 60 / Math.max(1, p.rate);
    const riseTime = SHELL_RISE;
    const total = riseTime + p.life;
    // How many shells could still be visible at once.
    const overlap = Math.ceil(total / interval) + 1;
    const current = Math.floor(t / interval);

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = clamp(p.level, 0, 3);

    for (let k = 0; k <= overlap; k++) {
      const index = current - k;
      if (index < 0) continue;
      const age = t - index * interval;
      if (age < 0 || age > total) continue;

      // Everything about this shell derives from its index, so all tabs agree
      // and no per-shell state has to be kept between frames.
      const rng = makeRng(`shell${index}`);
      const launchX = bbox.x + (0.12 + rng() * 0.76) * bbox.w;
      const peakY = bbox.y + (0.1 + rng() * 0.38) * bbox.h;
      const groundY = bbox.y + bbox.h;
      const colour = palette[Math.floor(rng() * palette.length)];

      if (age < riseTime) {
        if (!p.trail) continue;
        // Ease-out rise, as a shell decelerating towards apogee.
        const f = age / riseTime;
        const eased = 1 - (1 - f) ** 2;
        const y = lerp(groundY, peakY, eased);
        const grad = g.createLinearGradient(launchX, y + bbox.h * 0.08, launchX, y);
        grad.addColorStop(0, rgba(colour, 0));
        grad.addColorStop(1, rgba(colour, 0.9 * (1 - f * 0.4)));
        g.strokeStyle = grad;
        g.lineWidth = Math.max(1, bbox.h * 0.006);
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(launchX, y + bbox.h * 0.08);
        g.lineTo(launchX, y);
        g.stroke();
        continue;
      }

      const burstAge = age - riseTime;
      const f = burstAge / p.life;
      const sparks = Math.round(p.sparks);
      const reach = Math.min(bbox.w, bbox.h) * p.power;

      for (let s = 0; s < sparks; s++) {
        // Even angular spread with a little jitter, and varied speed so the
        // burst is a filled sphere rather than a ring.
        const angle = (s / sparks) * TAU + rng() * 0.25;
        const speed = 0.45 + rng() * 0.55;
        const dist = reach * speed * (1 - (1 - f) ** 2) * 1.4;
        const x = launchX + Math.cos(angle) * dist;
        const y = peakY + Math.sin(angle) * dist + p.gravity * bbox.h * f * f;
        if (y > groundY) continue;

        const fade = (1 - f) ** 1.5;
        // A firework star is burning metal, so it cools along the blackbody
        // curve as it dies: white-hot, then yellow, then a deep red ember. The
        // palette colour tints the hot end; physics does the rest.
        const kelvin = 2600 * Math.exp(-1.6 * f) + 900;
        const tint = f < 0.25 ? colour : blackbodyCss(kelvin);
        const r = Math.max(0.6, bbox.h * 0.005 * (0.5 + fade));
        g.fillStyle = rgba(tint, fade * (0.5 + 0.5 * Math.sin(burstAge * 22 + s)));
        g.beginPath();
        g.arc(x, y, r, 0, TAU);
        g.fill();
      }

      // The flash at the moment of detonation.
      if (f < 0.12) {
        const punch = 1 - f / 0.12;
        const r = reach * (0.3 + f * 4);
        const grad = g.createRadialGradient(launchX, peakY, 0, launchX, peakY, r);
        grad.addColorStop(0, rgba('#ffffff', 0.8 * punch));
        grad.addColorStop(1, rgba(colour, 0));
        g.fillStyle = grad;
        g.beginPath();
        g.arc(launchX, peakY, r, 0, TAU);
        g.fill();
      }
    }
    g.restore();
  },
};

const pumpkin = {
  id: 'pumpkin',
  name: 'Jack-o’-lantern',
  category: 'halloween',
  scope: 'shape',
  description:
    'A carved face glowing in the shape, with candle flicker behind it. Put it in a window and it looks carved into the house.',
  params: [
    { key: 'color', type: 'color', label: 'Glow colour', default: '#ff8c1a' },
    { key: 'inner', type: 'color', label: 'Inner colour', default: '#fff0a8' },
    { key: 'face', type: 'select', label: 'Face', default: 'classic', options: ['classic', 'grin', 'angry', 'surprised'] },
    { key: 'scale', type: 'range', label: 'Size', default: 0.82, min: 0.2, max: 1.4, step: 0.01 },
    { key: 'flicker', type: 'range', label: 'Flicker', default: 0.35, min: 0, max: 1, step: 0.01 },
    { key: 'rate', type: 'range', label: 'Flicker speed', default: 4, min: 0.2, max: 20, step: 0.1 },
    { key: 'level', type: 'range', label: 'Brightness', default: 1, min: 0, max: 2, step: 0.01 },
    { key: 'blink', type: 'range', label: 'Blink rate', default: 0.12, min: 0, max: 2, step: 0.01 },
    { key: 'glowSpill', type: 'range', label: 'Glow spill', default: 0.5, min: 0, max: 1, step: 0.01 },
  ],
  draw({ g, p, shape, t, noise, i }) {
    const { bbox } = shape;
    const size = Math.min(bbox.w, bbox.h) * p.scale;
    if (size <= 2) return;

    const seed = i * 31.7;
    const flick = 1 + p.flicker * noise.noise2(t * p.rate + seed, 0) * 0.6;
    const level = clamp(p.level * flick, 0, 3);
    if (level <= 0.01) return;

    // Eyes shut briefly on their own slow cycle.
    let open = 1;
    if (p.blink > 0) {
      const cycle = frac(t * p.blink + seed);
      if (cycle < 0.05) open = Math.abs(cycle / 0.025 - 1);
    }

    const cx = bbox.cx;
    const cy = bbox.cy;

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';

    if (p.glowSpill > 0) {
      const spill = g.createRadialGradient(cx, cy, 0, cx, cy, size * 1.1);
      spill.addColorStop(0, rgba(p.color, 0.4 * level * p.glowSpill));
      spill.addColorStop(1, rgba(p.color, 0));
      g.fillStyle = spill;
      g.beginPath();
      g.arc(cx, cy, size * 1.1, 0, TAU);
      g.fill();
    }

    g.translate(cx, cy);
    g.scale(size / 2, size / 2);

    // Face features are authored in a -1..1 box so the shapes stay proportional.
    const eye = (side) => {
      const x = side * 0.42;
      const y = -0.28;
      g.beginPath();
      switch (p.face) {
        case 'angry':
          g.moveTo(x - side * 0.26, y - 0.18);
          g.lineTo(x + side * 0.24, y + 0.1);
          g.lineTo(x - side * 0.22, y + 0.16 * open + 0.02);
          break;
        case 'surprised':
          g.ellipse(x, y, 0.19, 0.2 * open + 0.01, 0, 0, TAU);
          break;
        case 'grin':
        case 'classic':
        default:
          g.moveTo(x, y - 0.24);
          g.lineTo(x + 0.23, y + 0.16 * open + 0.02);
          g.lineTo(x - 0.23, y + 0.16 * open + 0.02);
      }
      g.closePath();
      g.fill();
    };

    const mouth = () => {
      g.beginPath();
      if (p.face === 'surprised') {
        g.ellipse(0, 0.42, 0.24, 0.28, 0, 0, TAU);
        g.closePath();
        g.fill();
        return;
      }
      // A jagged grin: alternate up and down along the mouth line.
      const teeth = p.face === 'angry' ? 7 : 5;
      const halfWidth = 0.68;
      const top = 0.24;
      const bottom = 0.62;
      g.moveTo(-halfWidth, top);
      for (let k = 0; k <= teeth; k++) {
        const fx = -halfWidth + (k / teeth) * halfWidth * 2;
        g.lineTo(fx, k % 2 === 0 ? top : top + 0.16);
      }
      g.lineTo(halfWidth, bottom - 0.1);
      for (let k = teeth; k >= 0; k--) {
        const fx = -halfWidth + (k / teeth) * halfWidth * 2;
        g.lineTo(fx, k % 2 === 0 ? bottom : bottom - 0.16);
      }
      g.closePath();
      g.fill();
    };

    // Two passes: a soft wide glow, then a bright core, which is what gives the
    // impression of light coming through a thick carved edge.
    g.globalAlpha = 0.5 * level;
    g.fillStyle = p.color;
    g.filter = 'none';
    eye(-1);
    eye(1);
    mouth();

    g.globalAlpha = level;
    g.fillStyle = p.inner;
    g.scale(0.82, 0.82);
    eye(-1);
    eye(1);
    mouth();

    g.restore();
  },
};

const runes = {
  id: 'runes',
  name: 'Glyph Rain',
  category: 'halloween',
  scope: 'shape',
  description:
    'Columns of falling characters with a bright leading edge. Set the alphabet to anything — numbers, letters, symbols.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#3dff88' },
    { key: 'head', type: 'color', label: 'Leading colour', default: '#eaffef' },
    { key: 'alphabet', type: 'text', label: 'Characters', default: 'アイウエオカキクケコサシスセソ0123456789' },
    { key: 'columns', type: 'range', label: 'Columns', default: 22, min: 3, max: 90, step: 1 },
    { key: 'speed', type: 'range', label: 'Speed', default: 6, min: 0.5, max: 40, step: 0.1 },
    { key: 'tail', type: 'range', label: 'Tail length', default: 12, min: 2, max: 40, step: 1 },
    { key: 'churn', type: 'range', label: 'Character churn', default: 6, min: 0, max: 30, step: 0.5 },
    { key: 'level', type: 'range', label: 'Brightness', default: 1, min: 0, max: 2, step: 0.01 },
  ],
  init() {
    return { columns: null, count: 0 };
  },
  /** The columns' offsets and rates, cast on step one so every tab agrees. */
  step({ p, rng, state }) {
    const cols = Math.round(p.columns);
    if (state.count === cols) return;
    state.count = cols;
    state.columns = Array.from({ length: cols }, () => ({
      offset: rng() * 40,
      rate: 0.6 + rng() * 0.8,
      seed: Math.floor(rng() * 100000),
    }));
  },
  draw({ g, p, shape, t, state }) {
    const { bbox } = shape;
    const chars = [...String(p.alphabet || 'X')];
    if (!chars.length || bbox.w <= 0 || bbox.h <= 0 || !state.columns) return;

    const cols = state.count;
    const cellW = bbox.w / cols;
    const cellH = cellW * 1.25;
    const rows = Math.ceil(bbox.h / cellH) + 1;

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';
    g.font = `${cellH * 0.85}px "SF Mono", Consolas, monospace`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';

    for (let c = 0; c < cols; c++) {
      const col = state.columns[c];
      const head = (t * p.speed * col.rate + col.offset) % (rows + p.tail);
      const x = bbox.x + (c + 0.5) * cellW;

      for (let k = 0; k < p.tail; k++) {
        const row = Math.floor(head) - k;
        if (row < 0 || row > rows) continue;
        const y = bbox.y + (row + 0.5) * cellH;

        // Deterministic per (column, row, churn tick) so glyphs flicker in place
        // rather than the whole column re-rolling every frame.
        const churnTick = p.churn > 0 ? Math.floor(t * p.churn + row * 0.7) : 0;
        const hash = (col.seed + row * 2654435761 + churnTick * 40503) >>> 0;
        const ch = chars[hash % chars.length];

        const fade = 1 - k / p.tail;
        g.globalAlpha = clamp(fade * fade * p.level, 0, 1);
        g.fillStyle = k === 0 ? p.head : p.color;
        g.fillText(ch, x, y);
      }
    }
    g.restore();
  },
};

export default [bats, fireworks, pumpkin, runes];
