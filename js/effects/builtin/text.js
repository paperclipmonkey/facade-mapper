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
 *
 * Everything in this file is lettering somebody has to *read*: from the
 * pavement, at night, through a bloom pass that spreads every bright edge into
 * its neighbours. So every glyph is painted in three passes over the whole
 * line, not one glyph at a time — a soft halo under all of them, then the
 * outlines, then the faces. Painting glyph by glyph let the next letter's glow
 * land on top of the previous letter's face and outline, so a dark keyline was
 * dark on one side of each letter and washed out on the other, and the halo
 * of a whole word piled up on the faces in the middle of it. Laid out once and
 * painted in passes, each layer of the sign sits where a sign-writer would put
 * it: glow on the wall, outline round the letter, face on top.
 */

import { clamp, TAU, frac, lerp, hexToRgb } from '../../core/math.js';
import { srgbToLinear, linearToSrgb } from '../color.js';
import { offscreen } from '../lib.js';
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

const fontOf = (weight, px, font) => `${weight} ${px}px ${FONT_STACKS[font] || FONT_STACKS.system}`;

/* ------------------------------------------------------------------ *
 * Measuring, once
 * ------------------------------------------------------------------ */

/**
 * The advance and ink box of every character in a line, per pixel of font size.
 *
 * Measured once at a reference size and kept, because a line is laid out every
 * frame and the widths of its letters are not going to change between frames:
 * they scale with the font size and with nothing else that can move. The ink
 * box is what the halo sprites are cut to — `width` is where the next letter
 * starts, which is not the same thing as where this one's ink stops, and a halo
 * cut to the advance clips the overhang of every italic and every J.
 *
 * Where a browser (or a test stand-in) reports no ink box, the advance and a
 * generous em stand in for it.
 */
function measureLine(g, text, font, weight, baseline = 'middle') {
  const chars = [...text];
  const n = chars.length;
  const out = {
    chars,
    /** The baseline the ink box was measured against; the halos are cut to it. */
    baseline,
    w: new Float64Array(n),
    left: new Float64Array(n),
    right: new Float64Array(n),
    up: new Float64Array(n),
    down: new Float64Array(n),
  };
  g.font = fontOf(weight, 100, font);
  g.textBaseline = baseline;
  for (let i = 0; i < n; i++) {
    const m = g.measureText(chars[i]);
    const w = Number.isFinite(m.width) ? m.width / 100 : 0.6;
    out.w[i] = w;
    out.left[i] = Number.isFinite(m.actualBoundingBoxLeft) ? m.actualBoundingBoxLeft / 100 : 0;
    out.right[i] = Number.isFinite(m.actualBoundingBoxRight) ? m.actualBoundingBoxRight / 100 : w;
    out.up[i] = Number.isFinite(m.actualBoundingBoxAscent) ? m.actualBoundingBoxAscent / 100 : 0.62;
    out.down[i] = Number.isFinite(m.actualBoundingBoxDescent) ? m.actualBoundingBoxDescent / 100 : 0.62;
  }
  return out;
}

/** The line's measurements, cached in `state` until the text or the font changes. */
function lineMetrics(state, slot, g, text, font, weight, baseline) {
  const key = `${text}|${font}|${weight}|${baseline}`;
  const held = state[slot];
  if (held && held.key === key) return held.m;
  const m = measureLine(g, text, font, weight, baseline);
  state[slot] = { key, m };
  return m;
}

/* ------------------------------------------------------------------ *
 * Halos
 * ------------------------------------------------------------------ */

/**
 * The colour a halo takes on, from the colour of the lettering.
 *
 * Light scattered off a wall round a lit sign is the sign's colour with the
 * white taken out of it: the face of a letter is bright enough to clip towards
 * white in any camera and in any eye, and the spill round it is not, so the
 * spill shows the hue the face only implies. Raising each channel to a power in
 * linear light and putting the brightest one back where it was does exactly
 * that — a cream face gets a gold halo, an orange one a deeper orange — and
 * leaves a pure hue alone. Memoised, since it is a pure function of a string.
 */
const deepCache = new Map();
function deepen(hex) {
  let out = deepCache.get(hex);
  if (out) return out;
  const { r, g, b } = hexToRgb(hex);
  const lin = [r, g, b].map((v) => srgbToLinear(v / 255));
  const peak = Math.max(lin[0], lin[1], lin[2]);
  if (peak <= 0) {
    out = '#000000';
  } else {
    const bent = lin.map((v) => (v / peak) ** 1.4 * peak);
    out = `#${bent.map((v) => Math.round(linearToSrgb(v) * 255).toString(16).padStart(2, '0')).join('')}`;
  }
  if (deepCache.size > 256) deepCache.clear();
  deepCache.set(hex, out);
  return out;
}

/**
 * How soft a halo is, in world pixels of Gaussian deviation, for a Glow value.
 * The visible skirt of a Gaussian runs out at about three deviations, so a Glow
 * of 20 throws light about twenty-five pixels off the letter — which is what
 * the slider has always meant by it.
 */
const glowSigma = (glow) => Math.max(0.8, glow * 0.42);

/**
 * How bright a halo is stamped, for a Glow value.
 *
 * Against the letter, where it is brightest, the halo comes to about a third
 * of the face — and in linear light, which is how a wall adds it up, a good
 * deal less. Any more and the light beside a stroke is as bright as the stroke,
 * which is the definition of a letterform being swamped; and it does not need
 * more, because the grade's bloom spreads every bright face on its own, and on
 * a low-threshold grade that is most of the glow anybody sees. It rises quickly
 * and then slowly, so that past a certain point more Glow means more spread
 * (see `glowSigma`) rather than more brightness.
 */
const glowStrength = (glow) => 0.7 * clamp(1 - Math.exp(-glow / 12), 0, 1);

/** Sprite pixels per world pixel, at most, and the longest side a halo may have. */
const HALO_RES = 0.5;
const HALO_MAX_SIDE = 224;

/**
 * Whether a canvas can be made here at all.
 *
 * Always, in a browser. Not in a bare test runner with no DOM, where lettering
 * is still worth laying out and checking — so there the halo falls back to the
 * stroked one rather than taking the whole effect down with it.
 */
const canBake = () => typeof document !== 'undefined';

/**
 * Halos, baked once per character and stamped under the lettering.
 *
 * The glow used to be two widening strokes of the glyph's outline, which is
 * cheap and wrong in a way that matters on a sign: a stroke straddles *every*
 * contour of a letter, including the inside of an R's bowl and an A's
 * triangle, so the halo landed inside the counters at full strength. At the
 * size an arch over a door leaves room for, a counter is a few pixels across
 * and was simply filled in — then bloom spread the faces into the same few
 * pixels, and MERRY CHRISTMAS read as a row of glowing lozenges.
 *
 * A blurred copy of the letter behaves like light instead. The blur spreads
 * the glyph's brightness over its surroundings, so the middle of a counter
 * gets about what the wall beside the letter gets — a fraction of the face,
 * never all of it — and the falloff is a smooth skirt rather than two
 * hard-edged bands that read as extra outlines. Blurring is far too dear to do
 * per glyph per frame (a filtered draw is a composite of its own; see
 * docs/performance.md), so each distinct character is blurred once into a
 * small canvas, at reduced resolution because a blur has no detail to lose,
 * and stamped with `drawImage` from then on.
 *
 * Baked in the halo colour, so the stamp needs nothing but an alpha. Rainbow
 * lettering changes colour every frame and keeps the stroked halo instead.
 */
function bakeHalos(m, font, weight, px, outline, sigma, colour) {
  const map = new Map();
  const pad = outline * 0.5 + sigma * 3 + 2;
  let longest = 1;
  for (let i = 0; i < m.chars.length; i++) {
    longest = Math.max(longest, (m.left[i] + m.right[i]) * px + pad * 2, (m.up[i] + m.down[i]) * px + pad * 2);
  }
  const res = Math.min(HALO_RES, HALO_MAX_SIDE / longest);
  for (let i = 0; i < m.chars.length; i++) {
    const ch = m.chars[i];
    if (map.has(ch) || !ch.trim()) continue;
    const left = m.left[i] * px + pad;
    const up = m.up[i] * px + pad;
    const w = left + m.right[i] * px + pad;
    const h = up + m.down[i] * px + pad;
    const canvas = offscreen(Math.ceil(w * res), Math.ceil(h * res));
    const c = canvas.getContext('2d');
    c.font = fontOf(weight, px * res, font);
    c.textBaseline = m.baseline;
    c.textAlign = 'left';
    c.lineJoin = 'round';
    c.fillStyle = colour;
    c.strokeStyle = colour;
    c.lineWidth = outline * res;
    const x = left * res;
    const y = up * res;
    if ('filter' in c) {
      c.filter = `blur(${Math.max(0.6, sigma * res).toFixed(2)}px)`;
      c.fillText(ch, x, y);
      if (outline > 0) c.strokeText(ch, x, y);
      c.filter = 'none';
    } else {
      // No canvas filters (older Safari): a ring of faint copies is a passable
      // blur at this size, and still a halo rather than a stroke.
      c.globalCompositeOperation = 'lighter';
      c.globalAlpha = 0.09;
      const r = Math.max(0.6, sigma * res);
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * TAU;
        const d = k % 2 ? r : r * 0.5;
        c.fillText(ch, x + Math.cos(a) * d, y + Math.sin(a) * d);
      }
    }
    map.set(ch, { canvas, x: -left, y: -up, w: canvas.width / res, h: canvas.height / res });
  }
  return map;
}

/**
 * The sprites for this line, rebuilt only when something they depend on moves.
 *
 * Keyed on `stable`-derived numbers only: Christmas binds its glow to the
 * microphone, and a key built from the modulated value would rebake the whole
 * set sixty times a second. A modulated glow changes how brightly the sprites
 * are stamped and a modulated size how large; neither needs a new sprite.
 */
function haloSet(state, slot, m, font, weight, px, outline, glow, colour) {
  if (!canBake() || glow <= 0) return null;
  const sigma = glowSigma(glow);
  const key = `${m.chars.join('')}|${font}|${weight}|${px.toFixed(1)}|${outline.toFixed(1)}|${sigma.toFixed(1)}|${colour}`;
  const held = state[slot];
  if (held && held.key === key) return held;
  const set = { key, px, map: bakeHalos(m, font, weight, px, outline, sigma, colour) };
  state[slot] = set;
  return set;
}

/**
 * The fallback halo: two widening strokes, faint.
 *
 * For rainbow lettering, whose colour moves every frame, and for anywhere a
 * canvas cannot be made. Kept faint for the reason the sprites exist — a
 * stroke lands inside the counters as strongly as outside them.
 */
function strokeHalo(g, ch, x, y, colour, glow, alpha) {
  g.lineJoin = 'round';
  for (const [width, a] of [[glow, 0.05], [glow * 0.5, 0.09]]) {
    g.globalAlpha = alpha * a * 2;
    g.lineWidth = width;
    g.strokeStyle = colour;
    g.strokeText(ch, x, y);
  }
}

/* ------------------------------------------------------------------ *
 * The line, laid out
 * ------------------------------------------------------------------ */

/**
 * Where each glyph of the current line goes, filled by the layout functions
 * and read by the painter. Module-level and reused, because a line is laid out
 * every frame and there is no reason for that to allocate: drawing is
 * synchronous, so two layers can never be halfway through it at once.
 *
 * Each glyph is drawn at (`lx`, `ly`) after a translate to (`tx`, `ty`) and a
 * rotation by `rot` — a path glyph is placed by its transform and a box glyph
 * by its coordinates — scaled by `sc` about its own middle.
 */
const RUN = { cap: 0, ch: [], colour: [], tx: null, ty: null, rot: null, lx: null, ly: null, w: null, sc: null, alpha: null };
const FIELDS = ['tx', 'ty', 'rot', 'lx', 'ly', 'w', 'sc', 'alpha'];
function reserveRun(n) {
  if (RUN.cap >= n) return;
  const cap = Math.max(64, n);
  for (const f of FIELDS) RUN[f] = new Float64Array(cap);
  RUN.ch.length = cap;
  RUN.colour.length = cap;
  RUN.cap = cap;
}

/** Scratch for the curvature allowance in a path layout. Grown, never per frame. */
let ROOMY = new Float64Array(64);

/** One glyph's animation, written into a single reused object. */
const ST = { dx: 0, dy: 0, alpha: 1, scale: 1, colour: null };

/**
 * A small integer hash to [0, 1), for decisions that have to be the same in
 * every tab and must not cost an allocation each.
 */
function hash01(a, b) {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Per-character animation. Returns null when the glyph is hidden. */
function charState(p, index, count, t) {
  const anim = p.animation;
  const speed = p.speed;
  const amount = p.amount;
  const state = ST;
  state.dx = 0;
  state.dy = 0;
  state.alpha = 1;
  state.scale = 1;
  state.colour = null;

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
      /**
       * A failing tube, not a dimmer and not a missing letter.
       *
       * This used to switch each glyph off for a third of its cycle, at a
       * fixed depth, ignoring Animation amount — so every still of TRICK OR
       * TREAT read "R K TRE". A real sign that is going is mostly lit: now and
       * then one tube loses it for a fraction of a second, stutters — out,
       * half, out, struck — and catches again. So each glyph rolls once per
       * window, on its own clock, for whether it has a fault; a fault is a
       * ragged square wave at about twenty steps a second; and Amount is how
       * far down a stutter goes. At 0.6 a glyph dips to forty per cent and
       * stays legible, which is what flicker is for on lettering people have
       * to read; only at 1 does it go right out. Past 1 the faults come more
       * often and last longer.
       *
       * Old signs are also uneven — one tube a little tired beside its
       * neighbours — so each glyph carries a fixed handicap that grows with
       * Amount. A function of `t` and the index alone, so every tab stutters
       * on the same frame.
       */
      const depth = clamp(amount, 0, 1);
      const busy = clamp(amount - 1, 0, 1);
      const rate = Math.max(0.05, speed);
      const window = 1.7 / rate;
      const phase = t / window + hash01(index, 7) * 3.1;
      const k = Math.floor(phase);
      let level = 1;
      if (hash01(index, k * 4 + 1) < 0.34 + 0.3 * busy) {
        const start = hash01(index, k * 4 + 2) * 0.55;
        const length = (0.14 + 0.3 * hash01(index, k * 4 + 3)) * (1 + 1.5 * busy);
        const into = phase - k - start;
        if (into >= 0 && into < length) {
          const tick = Math.floor(into * window * 19);
          const roll = hash01(index * 131 + k, tick);
          level = roll < 0.42 ? 0 : roll < 0.64 ? 0.5 : 1;
        }
      }
      state.alpha = (1 - depth * (1 - level))
        * (1 - 0.18 * depth * hash01(index, 99))
        * (1 - 0.035 * (0.5 + 0.5 * Math.sin(t * 61 + index * 2.3)));
      break;
    }
    case 'fade': {
      // Breathing. Amount is how deep the breath goes, scaled so that the
      // default of 0.5 dips to a quarter exactly as this always did — it used
      // to ignore Amount entirely, so there was no taking it down to the
      // gentle swell a sign over a bonfire wants.
      const depth = clamp(amount * 1.5, 0, 1);
      state.alpha = 1 - depth * (0.5 - 0.5 * Math.sin(t * speed * 2 - index * 0.4));
      break;
    }
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

/** Copy the current `ST` into the run, or hide the glyph. */
function setGlyph(i, ch, st, tx, ty, rot, lx, ly, w) {
  RUN.ch[i] = ch;
  RUN.tx[i] = tx;
  RUN.ty[i] = ty;
  RUN.rot[i] = rot;
  RUN.lx[i] = lx;
  RUN.ly[i] = ly;
  RUN.w[i] = w;
  RUN.sc[i] = st ? st.scale : 1;
  RUN.alpha[i] = st ? clamp(st.alpha, 0, 1) : 0;
  RUN.colour[i] = st ? st.colour : null;
}

/* ------------------------------------------------------------------ *
 * Painting
 * ------------------------------------------------------------------ */

/** Everything the painter needs about the line's look. Reused, like `RUN`. */
const LOOK = { colour: '#fff', halo: '#fff', stroke: '#000', outline: 0, glow: 0, strength: 0, sprites: null, k: 1 };

function enter(g, i) {
  g.save();
  if (RUN.tx[i] || RUN.ty[i]) g.translate(RUN.tx[i], RUN.ty[i]);
  if (RUN.rot[i]) g.rotate(RUN.rot[i]);
  const s = RUN.sc[i];
  if (s !== 1) {
    const cx = RUN.lx[i] + RUN.w[i] / 2;
    const cy = RUN.ly[i];
    g.translate(cx, cy);
    g.scale(s, s);
    g.translate(-cx, -cy);
  }
}

/**
 * Halo, outline, face — each pass over the whole line before the next.
 *
 * The halo is added light ('lighter'), so it brightens whatever is under it and
 * overlapping halos sum the way light does. The outline and the face are paint
 * ('source-over'): a dark outline therefore *replaces* the halo in a band round
 * each letter, which is the sign-writer's keyline and the single most useful
 * thing for legibility at a distance, and a light one sits crisply on the halo
 * rather than being washed into it.
 */
function paintRun(g, n) {
  const base = g.globalAlpha;
  const mode = g.globalCompositeOperation;
  const look = LOOK;

  if (look.strength > 0.002) {
    g.globalCompositeOperation = 'lighter';
    const sprites = look.sprites;
    const k = look.k;
    for (let i = 0; i < n; i++) {
      const a = RUN.alpha[i];
      const ch = RUN.ch[i];
      if (a <= 0.004 || !ch || !ch.trim()) continue;
      const sprite = sprites && !RUN.colour[i] ? sprites.get(ch) : null;
      enter(g, i);
      if (sprite) {
        g.globalAlpha = base * a * look.strength;
        g.drawImage(sprite.canvas, RUN.lx[i] + sprite.x * k, RUN.ly[i] + sprite.y * k, sprite.w * k, sprite.h * k);
      } else {
        strokeHalo(g, ch, RUN.lx[i], RUN.ly[i], RUN.colour[i] || look.halo, look.glow, base * a * look.strength);
      }
      g.restore();
    }
    g.globalCompositeOperation = mode;
  }

  if (look.outline > 0) {
    g.lineWidth = look.outline;
    g.lineJoin = 'round';
    g.strokeStyle = look.stroke;
    for (let i = 0; i < n; i++) {
      const a = RUN.alpha[i];
      if (a <= 0.004 || !RUN.ch[i]) continue;
      enter(g, i);
      g.globalAlpha = base * a;
      g.strokeText(RUN.ch[i], RUN.lx[i], RUN.ly[i]);
      g.restore();
    }
  }

  for (let i = 0; i < n; i++) {
    const a = RUN.alpha[i];
    if (a <= 0.004 || !RUN.ch[i]) continue;
    enter(g, i);
    g.globalAlpha = base * a;
    g.fillStyle = RUN.colour[i] || look.colour;
    g.fillText(RUN.ch[i], RUN.lx[i], RUN.ly[i]);
    g.restore();
  }
  g.globalAlpha = base;
}

/**
 * The outline, kept out of the counters.
 *
 * An outline straddles every contour of a letter, the insides of its counters
 * included, so half its width eats into each one from every side. Past about a
 * tenth of the letter's size it has closed them — Christmas's white edge,
 * bound to the microphone, used to swell until MERRY was a row of blobs. So it
 * is capped there: below the cap Outline width means exactly what it says, and
 * above it the letter stays a letter.
 */
const outlineFor = (width, px) => Math.max(0, Math.min(width, px * 0.1));

/** Fill `LOOK` for one line. `fit` scales the outline and glow with the lettering. */
function setLook(p, px, fit) {
  LOOK.colour = p.color;
  LOOK.halo = deepen(p.color);
  LOOK.stroke = p.stroke;
  LOOK.outline = outlineFor((p.strokeWidth || 0) * fit, px);
  LOOK.glow = Math.max(0, p.glow || 0) * fit;
  LOOK.strength = glowStrength(LOOK.glow);
  LOOK.sprites = null;
  LOOK.k = 1;
}

/* ------------------------------------------------------------------ *
 * Text
 * ------------------------------------------------------------------ */

/**
 * Where a line of `total` pixels starts along a path of `length`, for the
 * alignment and offset asked for.
 */
function startAlong(p, length, total) {
  let start;
  if (p.align === 'left') start = 0;
  else if (p.align === 'right') start = length - total;
  else start = (length - total) / 2;
  return start + p.pathOffset * length;
}

/** The point `s` pixels along the shape's path, wrapped or clamped as the path is. */
function along(shape, s) {
  const length = shape.sampler.length;
  const u = s / length;
  return shape.sampler.at(shape.closed ? frac(u) : clamp(u, 0, 1));
}

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * How fast the path is turning at `s`, in radians per pixel, positive when it
 * bends clockwise on screen — which is away from the tops of upright glyphs
 * travelling left to right, as over the crown of an arch. Measured from two
 * chords either side rather than from the sampler's own segment angle, which
 * jumps at every vertex of a polyline.
 */
function bendAt(shape, s, half) {
  const a = along(shape, s - half);
  const b = along(shape, s);
  const c = along(shape, s + half);
  const ab = Math.hypot(b.x - a.x, b.y - a.y);
  const bc = Math.hypot(c.x - b.x, c.y - b.y);
  if (ab < 1e-6 || bc < 1e-6) return 0;
  const turn = wrapAngle(Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x));
  return turn / ((ab + bc) / 2);
}

/**
 * Lay the line along the shape's path, by arc length.
 *
 * Three things a sign-writer does on a curve, and the old layout did none of
 * them well:
 *
 *   - **Spacing by arc length**, at the letter's own height. A glyph centred on
 *     a path that bends away from its head has a foot standing on a shorter
 *     curve than its middle, so on the crown of an arch the feet of
 *     neighbouring letters close up and then collide — exactly where the
 *     letters are easiest to see. Each glyph's slot is widened by the amount
 *     its tighter edge loses, measured from the local bend, so the gaps at the
 *     feet are the gaps asked for. On a straight path nothing changes.
 *   - **Upright to the curve.** Each glyph is turned to the chord across its
 *     own width rather than to the single segment under its middle, so it
 *     stands square on the curve wherever the path's vertices fall, and a
 *     corner in a traced polyline is bridged rather than snapped across.
 *   - **Fit the whole sign.** When the line is longer than the path it is
 *     shrunk, outline and glow included — a sign scaled to fit is the same
 *     sign smaller, not thinner letters with a fatter rim.
 *
 * Writes the run and returns the font size actually used and the scale it was
 * shrunk by.
 */
function layoutOnPath(shape, m, p, t, px, tracking) {
  const n = m.chars.length;
  const length = shape.sampler.length;
  const flip = p.flip ? -1 : 1;
  /**
   * Flipped text runs the other way along the path as well as turning over.
   * Turning each glyph upside down and leaving them in path order — which is
   * what Flip used to do — gives lettering that reads backwards from either
   * side; running it from the far end is what makes a line under an arch, or
   * along a path traced right to left, read left to right.
   */
  const way = (d) => (p.flip ? length - d : d);
  const lift = p.offsetY * px * 2;
  const fitting = p.fit !== false && length > 0;

  let natural = 0;
  for (let i = 0; i < n; i++) natural += m.w[i] * px + (i < n - 1 ? tracking : 0);
  let scale = fitting && natural > length ? length / natural : 1;

  // The curvature allowance, measured where the glyphs would naively land.
  if (ROOMY.length < n) ROOMY = new Float64Array(Math.max(64, n));
  let s = startAlong(p, length, natural * scale);
  let roomy = 0;
  for (let i = 0; i < n; i++) {
    const adv = m.w[i] * px * scale;
    const gap = i < n - 1 ? tracking * scale : 0;
    const bend = bendAt(shape, way(s + adv / 2), Math.max(adv / 2, 2)) * flip;
    // How far the glyph's middle sits towards its head, and half its height.
    const up = -lift * scale;
    const half = px * scale * 0.36;
    const tight = 1 + Math.min(bend * (up - half), bend * (up + half));
    const widen = tight < 1 ? 1 / Math.max(0.55, tight) : 1;
    ROOMY[i] = widen;
    roomy += (adv + gap) * widen;
    s += adv + gap;
  }
  if (fitting && roomy > length) {
    const more = length / roomy;
    scale *= more;
    roomy = length;
  }

  const fpx = px * scale;
  s = startAlong(p, length, roomy);
  const turn = (p.flip ? Math.PI : 0) + (p.rotate * Math.PI) / 180;
  for (let i = 0; i < n; i++) {
    const adv = m.w[i] * fpx;
    const slot = (adv + (i < n - 1 ? tracking * scale : 0)) * ROOMY[i];
    const mid = s + (adv * ROOMY[i]) / 2;
    s += slot;
    const st = charState(p, i, n, t);
    if (!st) {
      setGlyph(i, m.chars[i], null, 0, 0, 0, 0, 0, adv);
      continue;
    }
    const at = along(shape, way(mid));
    const a = along(shape, way(mid) - adv / 2);
    const b = along(shape, way(mid) + adv / 2);
    const chord = Math.hypot(b.x - a.x, b.y - a.y);
    const angle = chord > 1e-6 ? Math.atan2(b.y - a.y, b.x - a.x) : at.angle;
    // Offset perpendicular to the path so text can sit above or below the line.
    setGlyph(i, m.chars[i], st, at.x, at.y, angle + turn, -adv / 2 + st.dx * fpx, lift * scale + st.dy * fpx, adv);
  }
  return { px: fpx, scale };
}

/**
 * The font size a path layout settles on, ignoring the curvature allowance.
 *
 * Only for keying the halo sprites: it is a function of the unmodulated
 * parameters and the path, so it holds still while the real layout breathes
 * with an LFO on Size — and once a line is being shrunk to fit, its size does
 * not depend on Size at all, which a key built from the slider would miss.
 */
function settledPx(m, px, trackingRatio, length, fitting) {
  let units = trackingRatio * (m.chars.length - 1);
  for (let i = 0; i < m.chars.length; i++) units += m.w[i];
  const natural = units * px;
  return fitting && natural > length && natural > 0 ? (px * length) / natural : px;
}

/**
 * The glow a halo is baked for. A layer whose glow sits at zero and is only
 * ever pushed up by a binding still needs sprites, and they must not be rebaked
 * at every new value of the binding — so they get a fixed nominal softness.
 */
const bakedGlow = (base, px) => (base.glow > 0 ? base.glow : Math.max(8, px * 0.25));

const text = {
  id: 'text',
  name: 'Text',
  category: 'text',
  scope: 'shape',
  description:
    'Lettering placed in a shape or wrapped along its path, with typewriter, wave, flicker and other animations.',
  params: TEXT_PARAMS,
  draw({ g, p, stable, shape, t, state }) {
    const content = String(p.content ?? '');
    if (!content) return;
    const { bbox } = shape;
    const base = stable || p;

    g.save();
    const m = lineMetrics(state, 'metrics', g, content, p.font, p.weight, 'middle');
    const n = m.chars.length;
    reserveRun(n);

    let px = Math.max(4, textBase(shape) * p.size);
    let fit = 1;
    const onPath = p.mode === 'path' && shape.sampler.length > 0;

    if (onPath) {
      const laid = layoutOnPath(shape, m, p, t, px, p.tracking * px);
      px = laid.px;
      fit = laid.scale;
    } else {
      const tracking = p.tracking * px;
      let totalWidth = tracking * (n - 1);
      for (let i = 0; i < n; i++) totalWidth += m.w[i] * px;

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

      let x = originX;
      for (let i = 0; i < n; i++) {
        const adv = m.w[i] * px;
        const st = charState(p, i, n, t);
        if (st) setGlyph(i, m.chars[i], st, 0, 0, 0, x + st.dx * px, originY + st.dy * px, adv);
        else setGlyph(i, m.chars[i], null, 0, 0, 0, x, originY, adv);
        x += adv + tracking;
      }

      g.beginPath();
      g.rect(bbox.x - px, bbox.y - px, bbox.w + px * 2, bbox.h + px * 2);
      g.clip();
      if (p.rotate) {
        g.translate(bbox.cx, bbox.cy);
        g.rotate((p.rotate * Math.PI) / 180);
        g.translate(-bbox.cx, -bbox.cy);
      }
    }

    setLook(p, px, fit);
    if (LOOK.strength > 0.002 && p.animation !== 'rainbow') {
      /**
       * The halo is baked at the size the *unmodulated* parameters give, and
       * stamped scaled to the size this frame actually is — the same sprites
       * whatever an LFO is doing to Size or the microphone to Glow.
       */
      const pxBase = Math.max(4, textBase(shape) * base.size);
      const pxStable = onPath
        ? settledPx(m, pxBase, base.tracking, shape.sampler.length, p.fit !== false)
        : pxBase;
      const shrunk = pxStable / pxBase;
      const outlineStable = outlineFor((base.strokeWidth || 0) * shrunk, pxStable);
      const glowStable = bakedGlow(base, pxStable) * shrunk;
      const set = haloSet(state, 'halos', m, p.font, p.weight, pxStable, outlineStable, glowStable, LOOK.halo);
      if (set) {
        LOOK.sprites = set.map;
        LOOK.k = px / set.px;
      }
    }

    g.font = fontOf(p.weight, px, p.font);
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.lineJoin = 'round';
    g.miterLimit = 2;
    paintRun(g, n);
    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * Countdown
 * ------------------------------------------------------------------ */

/**
 * Every character a countdown can show, measured once.
 *
 * The label changes every second and is a different length at every unit
 * boundary, so it is never worth measuring as a line: what is worth having is
 * every glyph it can be made of — the figures, the separators, and whatever
 * the prefix and the closing message spell — measured once and looked up.
 * Measured on the alphabetic baseline, because the figures are centred on
 * their own ink, not on the em box.
 */
function countdownGlyphs(state, g, p) {
  const alphabet = [...new Set([...`0123456789:d BADTE${p.prefix || ''}${p.expired || ''}`])].join('');
  const m = lineMetrics(state, 'metrics', g, alphabet, p.font, p.weight, 'alphabetic');
  if (!state.index || state.indexKey !== alphabet) {
    state.index = new Map(m.chars.map((ch, i) => [ch, i]));
    state.indexKey = alphabet;
    // How tall a figure is, per pixel of font: the ink of an 8 above the
    // baseline. Most faces put it at about seven tenths of the em.
    const eight = state.index.get('8');
    state.figure = eight !== undefined && m.up[eight] > 0.2 && m.up[eight] < 1.2 ? m.up[eight] : 0.72;
  }
  return m;
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
  draw({ g, p, stable, shape, state }) {
    // Deliberately reads the wall clock, not show time — a countdown to a real
    // moment shouldn't pause when the transport does. Link time rather than
    // `Date.now()`, so two machines don't tick over to midnight a second apart.
    const target = Date.parse(String(p.target).replace(' ', 'T'));
    const now = linkNow();
    let label;
    let secondFraction = 0;
    let remaining = Infinity;

    if (!isFinite(target)) {
      label = 'BAD DATE';
    } else if (now >= target) {
      label = String(p.expired || '');
    } else {
      remaining = (target - now) / 1000;
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
    const base = stable || p;
    g.save();
    const m = countdownGlyphs(state, g, p);
    const index = state.index;
    const figure = state.figure;

    /**
     * Big, and filling the panel it was given.
     *
     * Size is the height of the *figures* as a fraction of the shape, not the
     * size of the em box they sit in. A figure is about seven tenths of its em,
     * so measuring the em left every countdown a third smaller than its slider
     * said — New Year's "8", alone in a panel built for "00:08", came out as a
     * small digit in a lot of empty wall. Measured on the ink, Size 1 means
     * figures as tall as the shape.
     *
     * Then shrunk, never stretched, to fit the width: "4d 03:18:53" and
     * HAPPY NEW YEAR are three times as long as "8", and the same Size has to
     * keep all of them on the wall.
     */
    const room = textBase(shape);
    let px = Math.max(4, (room * p.size) / figure);
    const chars = [...label];
    const n = chars.length;
    let units = p.tracking * (n - 1);
    for (const ch of chars) units += m.w[index.get(ch) ?? 0];
    const across = bbox.w > 12 ? bbox.w * 0.94 : Infinity;
    if (units > 1e-6 && units * px > across) px = Math.max(4, across / units);
    const tracking = p.tracking * px;
    const totalWidth = units * px;

    /**
     * Each second lands. The figure swells and settles, and its halo flares
     * with it — far harder in the last ten, where a crowd is counting along and
     * the beat of the thing is the whole point.
     */
    const final = remaining <= 10;
    const landing = p.pulse ? 1 - clamp(secondFraction * (final ? 3 : 4), 0, 1) : 0;
    const scale = 1 + landing * (final ? 0.12 : 0.05);

    reserveRun(n);
    const y = (figure * px) / 2;
    let x = -totalWidth / 2;
    for (let i = 0; i < n; i++) {
      const adv = m.w[index.get(chars[i]) ?? 0] * px;
      RUN.ch[i] = chars[i];
      RUN.colour[i] = null;
      RUN.tx[i] = 0;
      RUN.ty[i] = 0;
      RUN.rot[i] = 0;
      RUN.lx[i] = x;
      RUN.ly[i] = y;
      RUN.w[i] = adv;
      RUN.sc[i] = 1;
      RUN.alpha[i] = 1;
      x += adv + tracking;
    }

    setLook(p, px, 1);
    LOOK.strength = Math.min(1, LOOK.strength * (1 + landing * (final ? 0.9 : 0.35)));
    if (LOOK.strength > 0.002) {
      const pxStable = Math.max(4, (room * base.size) / figure);
      const outlineStable = outlineFor(base.strokeWidth || 0, pxStable);
      const set = haloSet(state, 'halos', m, p.font, p.weight, pxStable, outlineStable, bakedGlow(base, pxStable), LOOK.halo);
      if (set) {
        LOOK.sprites = set.map;
        LOOK.k = px / set.px;
      }
    }

    g.translate(bbox.cx, bbox.cy + p.offsetY * bbox.h);
    g.scale(scale, scale);
    g.font = fontOf(p.weight, px, p.font);
    g.textBaseline = 'alphabetic';
    g.textAlign = 'left';
    g.lineJoin = 'round';
    g.miterLimit = 2;
    paintRun(g, n);
    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * Symbol
 * ------------------------------------------------------------------ */

/**
 * The symbol, drawn once into a sprite with a blurred copy of itself beside it.
 *
 * An emoji is a colour bitmap font, and asking the browser for one at a
 * hundred pixels is one of the dearer single calls a canvas has — forty of
 * them a frame on a wall of bats was most of the budget for one layer. Drawn
 * once and stamped, it costs what any sprite costs.
 *
 * The blurred copy is the glow, and it is in the symbol's own colours by
 * construction: a pumpkin gets an orange halo and a snowflake a pale blue one
 * without anybody choosing either, which is the difference between a picture
 * of a pumpkin stuck on the wall and one lit on it. A black bat blurs to
 * black, and added black is nothing, which is also right.
 */
const SYMBOL_SPRITE_MAX = 384;

function symbolSprites(state, glyph, px) {
  const key = `${glyph}|${px.toFixed(1)}`;
  if (state.sprite && state.sprite.key === key) return state.sprite;
  state.sprite = null;
  if (!canBake()) return null;
  const size = Math.min(px, SYMBOL_SPRITE_MAX);
  const side = Math.ceil(size * 1.6);
  const face = offscreen(side, side);
  const fc = face.getContext('2d');
  fc.font = `${size}px ${FONT_STACKS.system}`;
  fc.textAlign = 'center';
  fc.textBaseline = 'middle';
  fc.fillText(glyph, side / 2, side / 2);

  const res = 0.4;
  const hs = Math.ceil(side * res);
  const halo = offscreen(hs, hs);
  const hc = halo.getContext('2d');
  if ('filter' in hc) hc.filter = `blur(${(size * 0.09 * res).toFixed(2)}px)`;
  hc.drawImage(face, 0, 0, hs, hs);
  if ('filter' in hc) hc.filter = 'none';

  state.sprite = { key, face, halo, side: (side * px) / size };
  return state.sprite;
}

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
    return { spots: null, count: 0, sprite: null };
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
  draw({ g, p, stable, shape, t, state }) {
    const glyph = String(p.glyph || '');
    if (!glyph || !state.spots) return;
    const { bbox } = shape;
    const base = stable || p;

    // Same trap as the text effects: a glyph scattered along a traced path had
    // no height to be a multiple of.
    const px = Math.max(6, textBase(shape) * p.size);
    const pxStable = Math.max(6, textBase(shape) * base.size);
    const sprite = symbolSprites(state, glyph, pxStable);
    const k = px / pxStable;

    g.save();
    const alpha = g.globalAlpha * clamp(p.opacity, 0, 1);
    g.globalAlpha = alpha;
    g.font = `${px}px ${FONT_STACKS.system}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.clip(shape.path);

    // `state.count`, not a bare `count`: the scattering moved into `step` so
    // every tab places the same glyphs, and the local this once read went with
    // it — leaving a ReferenceError thrown out of `draw` on every frame, which
    // the renderer catches and reports as a broken layer. A single glyph drew
    // nothing at all.
    const single = state.count === 1;
    for (const spot of state.spots) {
      const sx = single ? bbox.cx : bbox.x + lerp(0.5, spot.x, p.scatter) * bbox.w;
      const baseY = single ? bbox.cy : bbox.y + lerp(0.5, spot.y, p.scatter) * bbox.h;
      const drift = p.drift !== 0 ? frac(t * p.drift + spot.phase) * bbox.h - bbox.h / 2 : 0;
      const sy = baseY + drift + Math.sin(t * 2 + spot.phase) * bbox.h * p.bob;

      g.save();
      g.translate(sx, sy);
      if (p.spin) g.rotate(t * p.spin + spot.phase);
      g.scale(spot.scale, spot.scale);
      if (sprite) {
        const side = sprite.side * k;
        // The glow first, added, a little larger than the symbol so it reads as
        // light thrown on the wall round it rather than as a shadow behind it.
        g.globalCompositeOperation = 'lighter';
        g.globalAlpha = alpha * 0.55;
        g.drawImage(sprite.halo, -side * 0.56, -side * 0.56, side * 1.12, side * 1.12);
        g.globalCompositeOperation = 'source-over';
        g.globalAlpha = alpha;
        if (px <= SYMBOL_SPRITE_MAX) g.drawImage(sprite.face, -side / 2, -side / 2, side, side);
        else g.fillText(glyph, 0, 0);
      } else {
        g.fillText(glyph, 0, 0);
      }
      g.restore();
    }
    g.restore();
  },
};

export default [text, countdown, shapes];
