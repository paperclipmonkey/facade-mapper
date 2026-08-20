/**
 * Text.
 *
 * Two placements: inside a shape's box, or wrapped along the shape's path so
 * lettering follows an arch, a roofline or a bay window. Both go through the
 * same animation options, so "TRICK OR TREAT" can type itself on across a door
 * frame or ripple round a window.
 *
 * Fonts are limited to what the browser already has — the app ships no webfonts
 * so it keeps working offline and off a bare static host.
 */

import { rgba, clamp, TAU, frac, lerp } from '../../core/math.js';
import { now as linkNow } from '../../core/time.js';

export const FONT_STACKS = {
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  slab: '"Rockwell", "Courier New", Georgia, serif',
  mono: '"SF Mono", "Cascadia Mono", Consolas, "Courier New", monospace',
  condensed: '"Arial Narrow", "Helvetica Neue", Impact, sans-serif',
  impact: 'Impact, "Haettenschweiler", "Arial Black", sans-serif',
  cursive: '"Brush Script MT", "Segoe Script", cursive',
  fantasy: 'Papyrus, "Luminari", fantasy',
};

const TEXT_PARAMS = [
  { key: 'content', type: 'text', label: 'Text', default: 'TRICK OR TREAT' },
  { key: 'mode', type: 'select', label: 'Placement', default: 'box', options: ['box', 'path', 'marquee'] },
  { key: 'font', type: 'select', label: 'Font', default: 'impact', options: Object.keys(FONT_STACKS) },
  { key: 'weight', type: 'select', label: 'Weight', default: '700', options: ['300', '400', '600', '700', '900'] },
  { key: 'size', type: 'range', label: 'Size', default: 0.5, min: 0.02, max: 3, step: 0.005 },
  { key: 'tracking', type: 'range', label: 'Letter spacing', default: 0, min: -0.3, max: 1.5, step: 0.01 },
  { key: 'color', type: 'color', label: 'Colour', default: '#ff7a18' },
  { key: 'stroke', type: 'color', label: 'Outline colour', default: '#000000' },
  { key: 'strokeWidth', type: 'range', label: 'Outline width', default: 0, min: 0, max: 24, step: 0.5 },
  { key: 'glow', type: 'range', label: 'Glow', default: 0, min: 0, max: 60, step: 1 },
  { key: 'align', type: 'select', label: 'Align', default: 'centre', options: ['left', 'centre', 'right'] },
  { key: 'offsetX', type: 'range', label: 'Offset X', default: 0, min: -1, max: 1, step: 0.005 },
  { key: 'offsetY', type: 'range', label: 'Offset Y', default: 0, min: -1, max: 1, step: 0.005 },
  { key: 'rotate', type: 'range', label: 'Rotate', default: 0, min: -180, max: 180, step: 1 },
  {
    key: 'animation',
    type: 'select',
    label: 'Animation',
    default: 'none',
    options: ['none', 'typewriter', 'wave', 'jitter', 'flicker', 'fade', 'pop', 'rainbow'],
  },
  { key: 'speed', type: 'range', label: 'Animation speed', default: 1, min: 0, max: 8, step: 0.01 },
  { key: 'amount', type: 'range', label: 'Animation amount', default: 0.5, min: 0, max: 2, step: 0.01 },
  { key: 'pathOffset', type: 'range', label: 'Position on path', default: 0, min: -1, max: 1, step: 0.002 },
  { key: 'flip', type: 'bool', label: 'Flip on path', default: false },
  { key: 'fit', type: 'bool', label: 'Shrink to fit path', default: true },
];

/**
 * What Size is a multiple of.
 *
 * Fitting inside the box is right for an area: text lighting a window should
 * not spill out of it, so the height of the box caps it. It is meaningless for
 * the other thing people point text at — a roofline, or a guide line traced
 * across the wall to write along. Those are open paths, and a horizontal one
 * has a bounding box with *no height at all*, so `min(h, …)` collapses to zero
 * and every position of the Size slider produces the same four-pixel text. That
 * is not a small size; that is the control not working, and it looks from the
 * outside exactly like the slider not going high enough.
 *
 * So a shape too thin to be a container is measured along its length instead,
 * which is the dimension it actually has. Twelve world pixels is well below
 * anything traced deliberately — a gutter strip is tens — so a real thin shape
 * keeps the old behaviour.
 */
export function textBase(shape) {
  const { w, h } = shape.bbox;
  const box = Math.min(h, w * 0.9);
  return box > 12 ? box : Math.max(w, h) * 0.3;
}

/** Set up font/colour once, then hand back the pixel size chosen for this shape. */
function applyStyle(g, p, shape) {
  const px = Math.max(4, textBase(shape) * p.size);
  g.font = `${p.weight} ${px}px ${FONT_STACKS[p.font] || FONT_STACKS.system}`;
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.miterLimit = 2;
  return px;
}

/** Per-character animation offsets. Returns null when the glyph is hidden. */
function charState(p, index, count, t) {
  const anim = p.animation;
  const speed = p.speed;
  const amount = p.amount;
  const state = { dx: 0, dy: 0, alpha: 1, scale: 1, colour: null };

  switch (anim) {
    case 'typewriter': {
      // One glyph per tick, then a hold, then repeat.
      const total = count + Math.max(2, count * 0.4);
      const pos = frac((t * speed) / Math.max(0.5, total * 0.12)) * total;
      if (index > pos) return null;
      // Blink the newest glyph so it reads as a cursor landing.
      if (index > pos - 1) state.alpha = 0.4 + 0.6 * frac(t * 6);
      break;
    }
    case 'wave':
      state.dy = Math.sin(t * speed * 3 - index * 0.5) * amount * 0.35;
      break;
    case 'jitter':
      state.dx = Math.sin(t * speed * 21 + index * 7.1) * amount * 0.08;
      state.dy = Math.cos(t * speed * 19 + index * 3.7) * amount * 0.08;
      break;
    case 'flicker': {
      // Dead-neon-sign flicker: most glyphs steady, a few stuttering.
      const n = Math.sin(index * 12.9898 + 78.233) * 43758.5453;
      const seed = n - Math.floor(n);
      const rate = 3 + seed * 9;
      const on = Math.sin(t * speed * rate + seed * 40) > -0.55 + seed * 0.9;
      state.alpha = on ? 1 : 0.06 + 0.1 * seed;
      break;
    }
    case 'fade':
      state.alpha = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(t * speed * 2 - index * 0.4));
      break;
    case 'pop':
      state.scale = 1 + amount * 0.5 * Math.max(0, Math.sin(t * speed * 3 - index * 0.6));
      break;
    case 'rainbow':
      state.colour = `hsl(${((t * speed * 60 + index * 25) % 360).toFixed(1)} 100% 60%)`;
      break;
    default:
      break;
  }
  return state;
}

/**
 * A halo around a glyph, built from widening strokes rather than a shadow.
 *
 * `shadowBlur` gives a lovely soft glow and costs a third of a millisecond *per
 * glyph*: the browser renders each shadowed draw into its own layer and blurs
 * it. Eleven characters on five windows is 55 of those, measured at 19.6ms a
 * frame — more than the entire frame budget, for one line of text.
 *
 * The same 55 glyphs with two widening strokes come to 0.16ms, and read almost
 * identically on a wall, because the bloom in the post stage is what actually
 * produces the spill your eye responds to. This only has to give it something
 * bright and slightly spread to work with. Trading an exact Gaussian for a
 * hundredfold speed-up in front of a real bloom is not a close call.
 */
function haloGlyph(g, ch, x, y, colour, glow) {
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.lineJoin = 'round';
  g.lineCap = 'round';
  for (const [width, alpha] of [[glow, 0.1], [glow * 0.45, 0.16]]) {
    g.lineWidth = width;
    g.strokeStyle = rgba(colour, alpha);
    g.strokeText(ch, x, y);
  }
  g.fillStyle = rgba(colour, 0.3);
  g.fillText(ch, x, y);
  g.restore();
}

function paintGlyph(g, ch, x, y, p, st, px) {
  g.save();
  g.globalAlpha *= st.alpha;
  if (st.scale !== 1) {
    g.translate(x, y);
    g.scale(st.scale, st.scale);
    g.translate(-x, -y);
  }
  const colour = st.colour || p.color;

  if (p.glow > 0) haloGlyph(g, ch, x, y, colour, p.glow);
  if (p.strokeWidth > 0) {
    g.lineWidth = p.strokeWidth;
    g.strokeStyle = p.stroke;
    g.strokeText(ch, x, y);
  }
  g.fillStyle = colour;
  g.fillText(ch, x, y);
  g.restore();
}

const text = {
  id: 'text',
  name: 'Text',
  category: 'text',
  scope: 'shape',
  description:
    'Lettering placed in a shape or wrapped along its path, with typewriter, wave, flicker and other animations.',
  params: TEXT_PARAMS,
  draw({ g, p, shape, t }) {
    const content = String(p.content ?? '');
    if (!content) return;
    const { bbox } = shape;

    g.save();
    const px = applyStyle(g, p, shape);
    const tracking = p.tracking * px;

    if (p.mode === 'path' && shape.sampler.length > 0) {
      drawOnPath(g, content, p, shape, t, px, tracking);
      g.restore();
      return;
    }

    const chars = [...content];
    const widths = chars.map((c) => g.measureText(c).width);
    const totalWidth = widths.reduce((a, b) => a + b, 0) + tracking * (chars.length - 1);

    let originX;
    if (p.mode === 'marquee') {
      // Scroll right-to-left across the shape, wrapping with a gap.
      const span = totalWidth + bbox.w * 0.4;
      originX = bbox.x + bbox.w - frac((t * p.speed * 0.15) || 0) * span;
    } else if (p.align === 'left') {
      originX = bbox.x;
    } else if (p.align === 'right') {
      originX = bbox.x + bbox.w - totalWidth;
    } else {
      originX = bbox.cx - totalWidth / 2;
    }

    originX += p.offsetX * bbox.w;
    const originY = bbox.cy + p.offsetY * bbox.h;

    g.beginPath();
    g.rect(bbox.x - px, bbox.y - px, bbox.w + px * 2, bbox.h + px * 2);
    g.clip();

    if (p.rotate) {
      g.translate(bbox.cx, bbox.cy);
      g.rotate((p.rotate * Math.PI) / 180);
      g.translate(-bbox.cx, -bbox.cy);
    }

    let x = originX;
    for (let i = 0; i < chars.length; i++) {
      const st = charState(p, i, chars.length, t);
      if (st) {
        paintGlyph(g, chars[i], x + st.dx * px, originY + st.dy * px, p, st, px);
      }
      x += widths[i] + tracking;
    }
    g.restore();
  },
};

/** Lay glyphs along the arc-length parameter, each rotated to the local tangent. */
function drawOnPath(g, content, p, shape, t, px, tracking) {
  const chars = [...content];
  let widths = chars.map((c) => g.measureText(c).width);
  let total = widths.reduce((a, b) => a + b, 0) + tracking * (chars.length - 1);
  const pathLen = shape.sampler.length;

  /**
   * Shrink to fit the path it was given.
   *
   * A phrase longer than its arch used to run off both ends: `sampler.at`
   * clamps at the ends of an open path, so the overflowing glyphs stack up on
   * the last point and "MERRY CHRISTMAS" over a door reads "ERRY CHRISTM".
   * Silently losing the first and last letters of a sign is the worst of the
   * available behaviours, and the size that would fit is knowable — so use it.
   *
   * Off by default it is not, but it *is* switchable: laying text longer than
   * the path and scrolling it along with `pathOffset` is a legitimate thing to
   * want, and that needs the overflow.
   */
  if (p.fit !== false && total > pathLen && pathLen > 0) {
    const scale = pathLen / total;
    px *= scale;
    tracking *= scale;
    g.font = `${p.weight} ${Math.max(4, px)}px ${FONT_STACKS[p.font] || FONT_STACKS.system}`;
    widths = chars.map((c) => g.measureText(c).width);
    total = widths.reduce((a, b) => a + b, 0) + tracking * (chars.length - 1);
  }

  let startDist;
  if (p.align === 'left') startDist = 0;
  else if (p.align === 'right') startDist = pathLen - total;
  else startDist = (pathLen - total) / 2;
  startDist += p.pathOffset * pathLen;

  let dist = startDist;
  for (let i = 0; i < chars.length; i++) {
    const st = charState(p, i, chars.length, t);
    const advance = widths[i];
    if (st) {
      const u = (dist + advance / 2) / pathLen;
      const at = shape.sampler.at(shape.closed ? frac(u) : clamp(u, 0, 1));
      g.save();
      g.translate(at.x, at.y);
      g.rotate(at.angle + (p.flip ? Math.PI : 0) + (p.rotate * Math.PI) / 180);
      // Offset perpendicular to the path so text can sit above or below the line.
      const lift = p.offsetY * px * 2 + st.dy * px;
      paintGlyph(g, chars[i], -advance / 2 + st.dx * px, lift, p, st, px);
      g.restore();
    }
    dist += advance + tracking;
  }
}

const countdown = {
  id: 'countdown',
  name: 'Countdown',
  category: 'text',
  scope: 'shape',
  description:
    'Counts down to a date and time. Set it to midnight on the 31st and let the house do the talking.',
  params: [
    { key: 'target', type: 'text', label: 'Target (YYYY-MM-DD HH:MM)', default: '2026-10-31 18:00' },
    { key: 'prefix', type: 'text', label: 'Prefix', default: '' },
    { key: 'expired', type: 'text', label: 'When finished', default: 'HAPPY HALLOWEEN' },
    { key: 'units', type: 'select', label: 'Show', default: 'auto', options: ['auto', 'dhms', 'hms', 'ms', 's'] },
    { key: 'font', type: 'select', label: 'Font', default: 'mono', options: Object.keys(FONT_STACKS) },
    { key: 'weight', type: 'select', label: 'Weight', default: '700', options: ['300', '400', '600', '700', '900'] },
    { key: 'size', type: 'range', label: 'Size', default: 0.4, min: 0.02, max: 2, step: 0.005 },
    { key: 'color', type: 'color', label: 'Colour', default: '#39ff88' },
    { key: 'glow', type: 'range', label: 'Glow', default: 18, min: 0, max: 60, step: 1 },
    { key: 'stroke', type: 'color', label: 'Outline colour', default: '#000000' },
    { key: 'strokeWidth', type: 'range', label: 'Outline width', default: 0, min: 0, max: 24, step: 0.5 },
    { key: 'tracking', type: 'range', label: 'Letter spacing', default: 0.05, min: -0.3, max: 1, step: 0.01 },
    { key: 'offsetY', type: 'range', label: 'Offset Y', default: 0, min: -1, max: 1, step: 0.005 },
    { key: 'pulse', type: 'bool', label: 'Pulse each second', default: true },
  ],
  draw({ g, p, shape }) {
    // Deliberately reads the wall clock, not show time — a countdown to a real
    // moment shouldn't pause when the transport does. Link time rather than
    // `Date.now()`, so two machines don't tick over to midnight a second apart.
    const target = Date.parse(String(p.target).replace(' ', 'T'));
    const now = linkNow();
    let label;
    let secondFraction = 0;

    if (!isFinite(target)) {
      label = 'BAD DATE';
    } else if (now >= target) {
      label = String(p.expired || '');
    } else {
      const remaining = (target - now) / 1000;
      secondFraction = 1 - (remaining % 1);
      const d = Math.floor(remaining / 86400);
      const h = Math.floor((remaining % 86400) / 3600);
      const m = Math.floor((remaining % 3600) / 60);
      const s = Math.floor(remaining % 60);
      const pad = (v) => String(v).padStart(2, '0');

      let unit = p.units;
      if (unit === 'auto') unit = d > 0 ? 'dhms' : h > 0 ? 'hms' : m > 0 ? 'ms' : 's';

      if (unit === 'dhms') label = `${d}d ${pad(h)}:${pad(m)}:${pad(s)}`;
      else if (unit === 'hms') label = `${pad(h)}:${pad(m)}:${pad(s)}`;
      else if (unit === 'ms') label = `${pad(m)}:${pad(s)}`;
      else label = String(Math.ceil(remaining));
    }

    if (p.prefix) label = `${p.prefix}${label}`;
    if (!label) return;

    const { bbox } = shape;
    g.save();
    const px = applyStyle(g, { ...p, size: p.size }, shape);
    const tracking = p.tracking * px;
    const chars = [...label];
    const widths = chars.map((c) => g.measureText(c).width);
    const totalWidth = widths.reduce((a, b) => a + b, 0) + tracking * (chars.length - 1);

    const scale = p.pulse ? lerp(1.06, 1, clamp(secondFraction * 4, 0, 1)) : 1;
    g.translate(bbox.cx, bbox.cy + p.offsetY * bbox.h);
    g.scale(scale, scale);

    let x = -totalWidth / 2;
    const st = { dx: 0, dy: 0, alpha: 1, scale: 1, colour: null };
    for (let i = 0; i < chars.length; i++) {
      paintGlyph(g, chars[i], x, 0, p, st, px);
      x += widths[i] + tracking;
    }
    g.restore();
  },
};

const shapes = {
  id: 'glyph',
  name: 'Symbol',
  category: 'text',
  scope: 'shape',
  description:
    'A single emoji or symbol scaled to the shape, with optional spin and bob. Quick pumpkins, bats and snowflakes.',
  params: [
    { key: 'glyph', type: 'text', label: 'Symbol', default: '🎃' },
    { key: 'size', type: 'range', label: 'Size', default: 0.8, min: 0.05, max: 2, step: 0.01 },
    { key: 'count', type: 'range', label: 'Count', default: 1, min: 1, max: 40, step: 1 },
    { key: 'scatter', type: 'range', label: 'Scatter', default: 0, min: 0, max: 1, step: 0.01 },
    { key: 'spin', type: 'range', label: 'Spin', default: 0, min: -4, max: 4, step: 0.01 },
    { key: 'bob', type: 'range', label: 'Bob', default: 0.05, min: 0, max: 0.5, step: 0.005 },
    { key: 'drift', type: 'range', label: 'Drift', default: 0, min: -1, max: 1, step: 0.005 },
    { key: 'opacity', type: 'range', label: 'Opacity', default: 1, min: 0, max: 1, step: 0.01 },
  ],
  init() {
    return { spots: null, count: 0 };
  },
  /** Scattered on step one, so the same glyphs sit in the same places in every tab. */
  step({ p, rng, state }) {
    const count = Math.round(p.count);
    if (state.count === count) return;
    state.count = count;
    state.spots = Array.from({ length: count }, () => ({
      x: rng(),
      y: rng(),
      phase: rng() * TAU,
      scale: 0.7 + rng() * 0.6,
    }));
  },
  draw({ g, p, shape, t, state }) {
    const glyph = String(p.glyph || '');
    if (!glyph || !state.spots) return;
    const { bbox } = shape;

    // Same trap as the text effects: a glyph scattered along a traced path had
    // no height to be a multiple of.
    const px = Math.max(6, textBase(shape) * p.size);
    g.save();
    g.globalAlpha *= clamp(p.opacity, 0, 1);
    g.font = `${px}px ${FONT_STACKS.system}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.clip(shape.path);

    for (const spot of state.spots) {
      const sx = count === 1 ? bbox.cx : bbox.x + lerp(0.5, spot.x, p.scatter) * bbox.w;
      const baseY = count === 1 ? bbox.cy : bbox.y + lerp(0.5, spot.y, p.scatter) * bbox.h;
      const drift = p.drift !== 0 ? frac(t * p.drift + spot.phase) * bbox.h - bbox.h / 2 : 0;
      const sy = baseY + drift + Math.sin(t * 2 + spot.phase) * bbox.h * p.bob;

      g.save();
      g.translate(sx, sy);
      if (p.spin) g.rotate(t * p.spin + spot.phase);
      g.scale(spot.scale, spot.scale);
      g.fillText(glyph, 0, 0);
      g.restore();
    }
    g.restore();
  },
};

export default [text, countdown, shapes];
