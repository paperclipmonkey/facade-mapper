/**
 * Core effects: filling areas, stroking outlines, flashing, masking.
 *
 * These are the ones you reach for constantly — "make this window glow amber",
 * "put a hard black rectangle over the neighbour's bedroom". Everything more
 * elaborate is built on the same primitives.
 */

import { clamp, TAU, hexToRgb, hashString, frac, smoothstep } from '../../core/math.js';
import { mixLinear, srgbToLinear, linearToSrgb } from '../color.js';
import { ensureField } from '../field.js';

/**
 * Softens a shape's edges with a blur, where the browser supports it, and
 * keeps that blur to the neighbourhood of the shape.
 *
 * The clip is the point. A filtered draw is painted onto a scratch surface,
 * blurred there and composited back, and the canvas sizes that surface by the
 * clip rather than by what is being drawn — so an unclipped soft window was a
 * blur of the entire frame, once per window. "Warm rooms" on five windows
 * cost a quarter of a second a frame in a software-rendered tab, and every
 * preset that lights its rooms had one. Clipped to the shape (grown by
 * `grow`, for a negative inset) plus six blur radii, it is a few milliseconds
 * and draws exactly the same thing: three radii is where a Gaussian has all
 * but gone, and the other factor of two is for a preview drawn at half the
 * world's size or less, where the same blur in pixels reaches further over
 * the wall.
 */
function softFilter(g, softness, world, bbox, grow = 1) {
  if (!(softness > 0) || !('filter' in g)) return false;
  const blur = (softness * world.w) / 100;
  const hw = (bbox.w * grow) / 2 + blur * 6;
  const hh = (bbox.h * grow) / 2 + blur * 6;
  g.beginPath();
  g.rect(bbox.cx - hw, bbox.cy - hh, hw * 2, hh * 2);
  g.clip();
  g.filter = `blur(${blur}px)`;
  return true;
}

/**
 * Two colours mixed in linear light, remembered.
 *
 * A gradient between two colours here is laid down as a run of stops mixed in
 * linear light rather than as two stops the canvas blends for itself. The
 * canvas blends the gamma-encoded numbers, and halfway between a warm amber and
 * a dark brown in those numbers is a dull, muddy tan — the "brown smudge in the
 * window" look — where halfway in light is still plainly warm light. The
 * answers are the same handful every frame, so they are kept: the mix is
 * quantised to a sixty-fourth, which nobody can see, and the memo is bounded,
 * because colours are somebody's own typing. A pure function's memo, so it
 * cannot make two tabs disagree.
 */
const mixes = new Map();
function mix(a, b, t) {
  const f = Math.round(clamp(t, 0, 1) * 64) / 64;
  if (f === 0) return a;
  if (f === 1) return b;
  const key = `${a}|${b}|${f}`;
  let hex = mixes.get(key);
  if (!hex) {
    if (mixes.size > 2048) mixes.clear();
    hex = mixLinear(a, b, f);
    mixes.set(key, hex);
  }
  return hex;
}

/**
 * A colour driven harder than itself, the way light is rather than paint.
 *
 * Brightness above 1 used to do nothing at all: it went into `globalAlpha`,
 * which stops at 1, so the top half of every Brightness slider in this file
 * was dead. Light that is turned up gets brighter until the eye or the camera
 * runs out of range, and then whiter — an overdriven amber lamp reads as a
 * pale yellow-white, not as the same orange. So: multiplied in linear light,
 * and whatever no longer fits is let spill towards white.
 */
const brights = new Map();
function brighten(hex, k) {
  const q = Math.round(k * 32) / 32;
  if (q <= 1) return hex;
  const key = `${hex}|${q}`;
  let out = brights.get(key);
  if (!out) {
    if (brights.size > 512) brights.clear();
    const { r, g, b } = hexToRgb(hex);
    const lin = [r, g, b].map((v) => srgbToLinear(v / 255) * q);
    const top = Math.max(1, ...lin);
    const spill = Math.min(1, (top - 1) * 0.25);
    const byte = (v) => Math.round(linearToSrgb((v / top) * (1 - spill) + spill) * 255)
      .toString(16).padStart(2, '0');
    out = `#${byte(lin[0])}${byte(lin[1])}${byte(lin[2])}`;
    brights.set(key, out);
  }
  return out;
}

const LINEAR = (f) => f;

/**
 * Lay `stops + 1` colour stops from `a` to `b` along a gradient, mixed in linear
 * light, with `ease` shaping where along it the change happens.
 */
function ramp(grad, a, b, stops, ease = LINEAR, from = 0, to = 1) {
  for (let i = 0; i <= stops; i++) {
    const f = i / stops;
    grad.addColorStop(from + (to - from) * f, mix(a, b, ease(f)));
  }
}

/**
 * The radial fill's falloff: it holds its centre colour for a while and then
 * goes, the way a room lit by a lamp is evenly bright across the middle of the
 * window and darkens towards the reveals — rather than a straight ramp, which
 * has no middle and reads as a spotlight on the glass.
 */
const ROOM_FALLOFF = (f) => f ** 1.6;

/**
 * The shape's outline in the unit space of an ellipse fitted to it, kept.
 *
 * A canvas radial gradient is a circle, and a circle in a window twice as wide
 * as it is tall either leaves the ends dark or runs straight off the top and
 * bottom. Filling the shape under a transform that squashes the ellipse into a
 * circle fits the gradient to the window — but the transform squashes the
 * path too, so the path is handed over pre-stretched by the inverse, once,
 * and kept until the shape itself changes. Keyed on the path object, which
 * the renderer only replaces when the outline moves.
 */
function unitPath(state, shape, rx, ry) {
  if (state.unit && state.unitOf === shape.path && state.unitRx === rx && state.unitRy === ry) {
    return state.unit;
  }
  const { bbox } = shape;
  const path = new Path2D();
  path.addPath(shape.path, { a: 1 / rx, b: 0, c: 0, d: 1 / ry, e: -bbox.cx / rx, f: -bbox.cy / ry });
  state.unit = path;
  state.unitOf = shape.path;
  state.unitRx = rx;
  state.unitRy = ry;
  return path;
}

const fill = {
  id: 'fill',
  name: 'Fill',
  category: 'basic',
  scope: 'shape',
  description:
    'Flat or gradient colour inside a shape. The building block for lighting up rooms.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#ff7a18' },
    { key: 'color2', type: 'color', label: 'Colour 2', default: '#2b0a00' },
    {
      key: 'gradient',
      type: 'select',
      label: 'Gradient',
      default: 'none',
      options: ['none', 'vertical', 'horizontal', 'radial', 'conic'],
    },
    { key: 'level', type: 'range', label: 'Brightness', default: 1, min: 0, max: 2, step: 0.01 },
    { key: 'softness', type: 'range', label: 'Edge softness', default: 0, min: 0, max: 4, step: 0.05 },
    { key: 'inset', type: 'range', label: 'Inset', default: 0, min: -0.2, max: 0.4, step: 0.005 },
  ],
  draw({ g, p, shape, world, state }) {
    const { bbox } = shape;
    if (bbox.w <= 0 || bbox.h <= 0) return;
    const level = clamp(p.level, 0, 2);
    if (level <= 0) return;
    // Up to 1 the brightness is how much light; past it, how hard it is driven.
    const c1 = brighten(p.color, level);
    const c2 = brighten(p.color2, level);

    g.save();
    g.globalAlpha *= Math.min(1, level);
    softFilter(g, p.softness, world, bbox, Math.max(1, 1 - p.inset));

    if (p.inset !== 0) {
      // Scaling about the centroid is a cheap stand-in for a true polygon offset;
      // for the rectangles and arches on a house it reads identically.
      const s = 1 - p.inset;
      g.translate(bbox.cx, bbox.cy);
      g.scale(s, s);
      g.translate(-bbox.cx, -bbox.cy);
    }

    if (p.gradient === 'radial') {
      /**
       * An ellipse fitted to the shape rather than a circle sized to its long
       * side, so a wide bay is lit across its whole width instead of as a
       * bright stripe through the middle. Its edge sits a little outside the
       * shape's sides, so the second colour is reached in the corners — the
       * reveals of the window — and the sides are on their way to it.
       */
      const rx = Math.max(1, bbox.w * 0.72);
      const ry = Math.max(1, bbox.h * 0.72);
      const unit = unitPath(state, shape, rx, ry);
      g.translate(bbox.cx, bbox.cy);
      g.scale(rx, ry);
      const grad = g.createRadialGradient(0, 0, 0, 0, 0, 1);
      ramp(grad, c1, c2, 5, ROOM_FALLOFF);
      g.fillStyle = grad;
      g.fill(unit);
      g.restore();
      return;
    }

    let style = c1;
    if (p.gradient === 'vertical') {
      style = g.createLinearGradient(0, bbox.y, 0, bbox.y + bbox.h);
      ramp(style, c1, c2, 4);
    } else if (p.gradient === 'horizontal') {
      style = g.createLinearGradient(bbox.x, 0, bbox.x + bbox.w, 0);
      ramp(style, c1, c2, 4);
    } else if (p.gradient === 'conic' && g.createConicGradient) {
      style = g.createConicGradient(0, bbox.cx, bbox.cy);
      ramp(style, c1, c2, 3, LINEAR, 0, 0.5);
      ramp(style, c2, c1, 3, LINEAR, 0.5, 1);
    }

    g.fillStyle = style;
    g.fill(shape.path);
    g.restore();
  },
};

const outline = {
  id: 'outline',
  name: 'Outline',
  category: 'basic',
  scope: 'shape',
  description: 'Neon-style stroke around a shape or along a path, with optional dashes.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#39ff88' },
    { key: 'width', type: 'range', label: 'Width', default: 6, min: 0.5, max: 60, step: 0.5 },
    { key: 'glow', type: 'range', label: 'Glow', default: 12, min: 0, max: 80, step: 1 },
    { key: 'level', type: 'range', label: 'Brightness', default: 1, min: 0, max: 2, step: 0.01 },
    { key: 'dash', type: 'range', label: 'Dash length', default: 0, min: 0, max: 200, step: 1 },
    { key: 'gap', type: 'range', label: 'Gap length', default: 20, min: 0, max: 200, step: 1 },
    { key: 'scroll', type: 'range', label: 'Dash scroll', default: 0, min: -400, max: 400, step: 1 },
  ],
  draw({ g, p, shape, t }) {
    const level = clamp(p.level, 0, 2);
    if (level <= 0) return;
    const colour = brighten(p.color, level);
    const width = Math.max(0.5, p.width);
    const glow = Math.max(0, p.glow);

    g.save();
    g.globalAlpha *= Math.min(1, level);
    const base = g.globalAlpha;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.strokeStyle = colour;

    if (p.dash > 0) {
      const period = Math.max(0.01, p.dash + p.gap);
      g.setLineDash([p.dash, p.gap]);
      // Wrapped to one dash period. The pattern repeats every `period` pixels,
      // so the offset only ever needs to live in [0, period) — and feeding a
      // number that grows without bound into it means that four hours into a
      // show the browser is asked to offset a dash pattern by a few million
      // pixels, which is both slower and, once the float loses precision,
      // visibly jerky.
      g.lineDashOffset = -((t * p.scroll) % period);
    }

    /**
     * Light, in four passes: two wide faint ones for the halo, widest first,
     * so it falls away in steps rather than ending at one hard edge; the
     * stroke itself; and a thin core pushed most of the way to white, which is
     * what makes a bright line read as a lit tube rather than a painted one.
     * A single shadowed stroke reads muddy at projector brightness, and costs
     * a filter pass besides. With Glow at zero it is the crisp line alone.
     */
    if (glow > 0) {
      g.globalCompositeOperation = 'lighter';
      g.lineWidth = width + glow * 1.6;
      g.globalAlpha = base * 0.07;
      g.stroke(shape.path);
      g.lineWidth = width + glow * 0.7;
      g.globalAlpha = base * 0.16;
      g.stroke(shape.path);
      g.globalAlpha = base;
      g.globalCompositeOperation = 'source-over';
    }

    g.lineWidth = width;
    g.stroke(shape.path);

    if (glow > 0) {
      g.globalCompositeOperation = 'lighter';
      g.strokeStyle = mix(colour, '#ffffff', 0.6);
      g.lineWidth = Math.max(0.75, width * 0.38);
      g.globalAlpha = base * 0.75;
      g.stroke(shape.path);
    }
    g.restore();
  },
};

const strobe = {
  id: 'strobe',
  name: 'Strobe / Flash',
  category: 'basic',
  scope: 'shape',
  description: 'Hard on/off flashing. Sync it to the beat or run it free.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#ffffff' },
    { key: 'rate', type: 'range', label: 'Rate (Hz)', default: 6, min: 0.1, max: 30, step: 0.1 },
    { key: 'duty', type: 'range', label: 'On fraction', default: 0.3, min: 0.02, max: 0.98, step: 0.01 },
    { key: 'sync', type: 'bool', label: 'Sync to beat', default: false },
    { key: 'division', type: 'range', label: 'Beats per flash', default: 1, min: 0.125, max: 8, step: 0.125 },
    { key: 'decay', type: 'range', label: 'Fall-off', default: 0, min: 0, max: 1, step: 0.01 },
  ],
  draw({ g, p, shape, t, beat }) {
    const phase = p.sync
      ? (beat / Math.max(0.0625, p.division)) % 1
      : (t * p.rate) % 1;
    if (phase > p.duty) return;

    // Fall-off turns a square flash into a snap-and-fade, which suits lightning
    // and camera pops far better than a flat block.
    const alpha = p.decay > 0 ? Math.pow(1 - phase / p.duty, 1 + p.decay * 6) : 1;

    g.save();
    g.globalAlpha *= alpha;
    g.fillStyle = p.color;
    g.fill(shape.path);
    g.restore();
  },
};

const staticNoise = {
  id: 'static',
  name: 'TV Static',
  category: 'basic',
  scope: 'shape',
  description: 'Flickering broadcast snow. Good for windows that should look wrong.',
  params: [
    { key: 'color', type: 'color', label: 'Tint', default: '#9fd4ff' },
    { key: 'density', type: 'range', label: 'Density', default: 0.5, min: 0.02, max: 1, step: 0.01 },
    { key: 'cell', type: 'range', label: 'Grain size', default: 6, min: 1, max: 40, step: 1 },
    { key: 'rate', type: 'range', label: 'Refresh (Hz)', default: 18, min: 1, max: 60, step: 1 },
    { key: 'rolling', type: 'range', label: 'Roll bar', default: 0.3, min: 0, max: 1, step: 0.01 },
  ],
  /** A number of this instance's own, so two windows do not show one picture. */
  init({ layer, shape }) {
    return { salt: hashString(`static|${layer?.id || ''}|${shape?.id || ''}`) >>> 0 };
  },
  draw({ g, p, shape, t, state }) {
    const { bbox } = shape;
    /**
     * The seed is the frame number, and it used to be a draw-time draw.
     *
     * `rng` in `draw` is seeded from the *simulation step* the frame landed on,
     * which is a different clock from the one the static refreshes on — so the
     * step at which `frame` was seen to change depended on when each tab
     * happened to paint. Two projectors covering the same window at different
     * frame rates therefore took their seed from different steps and showed
     * different snow, on a wall where the whole point is that they agree. The
     * comment below has always claimed the frame number was enough; now it is
     * the only thing used.
     */
    const frame = Math.floor(t * p.rate);

    const cell = Math.max(1, p.cell);
    const cols = Math.max(1, Math.ceil(bbox.w / cell));
    const rows = Math.max(1, Math.ceil(bbox.h / cell));
    if (cols * rows > 60000) return; // guard against absurd grain on huge shapes

    g.save();
    g.clip(shape.path);

    /**
     * The grain is written into a cols×rows buffer and blown up once, rather
     * than drawn as one `fillRect` per cell.
     *
     * At the default grain over a whole frame that is nearly sixty thousand
     * fills, each with its own `globalAlpha` change: 4.6ms, against 2.7ms for
     * one image the size of the grid and one `drawImage`. Not a dramatic win —
     * most of what is left is the per-cell noise itself — but it takes the
     * effect from a quarter of the frame budget to a sixth, for a picture that
     * is pixel-for-pixel identical. The cell *is* the pixel, and smoothing is
     * left off so it scales up as hard squares.
     */
    const buffer = ensureField(state, 'grain', cols, rows);
    const { r, g: gg, b } = hexToRgb(p.color);
    const data = buffer.data;

    // Cheap deterministic hash, so the same frame number gives the same snow in
    // every tab without carrying a full RNG through the inner loop.
    let h = (Math.imul(frame + 1, 2654435761) ^ (state.salt || 0)) >>> 0;
    const next = () => {
      h = (Math.imul(h ^ (h >>> 15), 2246822519) + 0x9e3779b9) >>> 0;
      return h / 4294967296;
    };

    for (let i = 0, n = cols * rows; i < n; i++) {
      const v = next();
      const o = i * 4;
      data[o] = r;
      data[o + 1] = gg;
      data[o + 2] = b;
      data[o + 3] = v > p.density ? 0 : ((v / p.density) * 255) | 0;
    }

    const smoothing = g.imageSmoothingEnabled;
    g.imageSmoothingEnabled = false;
    buffer.ctx.putImageData(buffer.image, 0, 0);
    g.drawImage(buffer.canvas, bbox.x, bbox.y, cols * cell, rows * cell);
    g.imageSmoothingEnabled = smoothing;
    g.globalAlpha = 1;

    if (p.rolling > 0) {
      const barY = bbox.y + ((t * 0.35) % 1) * bbox.h;
      const grad = g.createLinearGradient(0, barY - bbox.h * 0.12, 0, barY + bbox.h * 0.12);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.5, `rgba(255,255,255,${0.35 * p.rolling})`);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.globalAlpha = 1;
      g.fillStyle = grad;
      g.fillRect(bbox.x, bbox.y - bbox.h * 0.12, bbox.w, bbox.h * 1.24);
    }
    g.restore();
  },
};

const mask = {
  id: 'mask',
  name: 'Mask (black out)',
  category: 'basic',
  scope: 'shape',
  description:
    'Paints the shape black, hiding whatever is underneath. Put it last to keep light off windows that should stay dark.',
  params: [
    { key: 'softness', type: 'range', label: 'Edge softness', default: 0, min: 0, max: 4, step: 0.05 },
    { key: 'strength', type: 'range', label: 'Strength', default: 1, min: 0, max: 1, step: 0.01 },
  ],
  draw({ g, p, shape, world }) {
    g.save();
    // destination-out removes light rather than painting black over it, so it
    // still works when the mask sits above additive layers.
    g.globalCompositeOperation = 'destination-out';
    g.globalAlpha = clamp(p.strength, 0, 1);
    softFilter(g, p.softness, world, shape.bbox);
    g.fillStyle = '#000';
    g.fill(shape.path);
    g.restore();
  },
};

/** Where a sweep puts its stops: up to eight bands, three wraps, five each, and the ends. */
const SWEEP_AT = new Float64Array(8 * 3 * 5 + 2);

/** How far gradient position `f` is from the nearest band centre, wrapping. */
function fromBand(f, offset, period) {
  const d = (((f - offset) % period) + period) % period;
  return Math.min(d, period - d);
}

const sweep = {
  id: 'sweep',
  name: 'Colour Sweep',
  category: 'basic',
  scope: 'shape',
  description: 'A band of colour travelling across the shape at any angle.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#7b5cff' },
    { key: 'color2', type: 'color', label: 'Background', default: '#000000' },
    { key: 'angle', type: 'range', label: 'Angle', default: 90, min: 0, max: 360, step: 1 },
    { key: 'speed', type: 'range', label: 'Speed', default: 0.25, min: -3, max: 3, step: 0.01 },
    { key: 'width', type: 'range', label: 'Band width', default: 0.3, min: 0.02, max: 1, step: 0.01 },
    { key: 'repeat', type: 'range', label: 'Repeats', default: 1, min: 1, max: 8, step: 1 },
    { key: 'soft', type: 'bool', label: 'Soft edges', default: true },
  ],
  draw({ g, p, shape, t }) {
    const { bbox } = shape;
    const a = (p.angle * Math.PI) / 180;
    const repeat = Math.max(1, Math.round(p.repeat));
    const period = 1 / repeat;
    /**
     * The gradient spans the shape as seen along the sweep — and a band's
     * width beyond it at each end.
     *
     * It used to span the bounding box's *diagonal* whatever the angle, which
     * for a vertical sweep over a wide bay is twice the window's height: half
     * of every pass was spent above or below the glass, where the band lit
     * nothing. Spanning the shape's own extent along the direction of travel
     * puts the whole pass on the shape; the margin at each end is where the
     * band goes to wrap round, so a single band leaves one side completely
     * before it comes in at the other rather than being cut in two.
     */
    const halfShape = clamp(p.width, 0.02, 1) / repeat / 2;
    const extent = Math.max(1, Math.abs(bbox.w * Math.cos(a)) + Math.abs(bbox.h * Math.sin(a)));
    const reach = extent * (0.5 + halfShape);
    const dx = Math.cos(a) * reach;
    const dy = Math.sin(a) * reach;

    const grad = g.createLinearGradient(
      bbox.cx - dx,
      bbox.cy - dy,
      bbox.cx + dx,
      bbox.cy + dy
    );

    /**
     * The bands as a pattern that repeats, not as stops that fall off the end.
     *
     * Each band used to be three stops round its centre, and any band whose
     * edge touched either end of the gradient was simply skipped — "clamping
     * would smear the wrap". So for the whole of the time a band spent
     * entering or leaving the shape it was not drawn at all: with the defaults
     * that is three-tenths of every pass, the window went black for it, and at
     * t = 8 exactly the one band there is was gone. Now the brightness is
     * worked out as a function of position — distance to the nearest band
     * centre, wrapping — and the gradient samples it, so a band crossing the
     * end of the gradient is half at one end and half at the other, as a
     * pattern that repeats should be.
     *
     * Soft bands are a raised cosine, sampled and mixed in linear light: a
     * swell of light with no visible edge and no muddy middle. Hard ones get
     * their edges placed exactly, a whisker wide, rather than sampled.
     */
    // The band's half-width in units of the (extended) gradient.
    const half = halfShape / (1 + 2 * halfShape);
    // Half a period on, so a pass starts with its band across the middle of
    // the shape rather than parked out of sight in the margin.
    const offset = frac(t * p.speed) + period * 0.5;

    if (p.soft) {
      /**
       * Stops only where the light changes — five across each band, plus an
       * end of the gradient when a band is passing over it — rather than a
       * comb along the whole length. Most of a sweep is a flat run of the
       * background, which the gradient's own padding provides for nothing,
       * and a canvas pays for every stop on every pixel: past seven or so it
       * leaves its fast path, and a sweep over the whole frame cost three
       * times as much for it.
       */
      let n = 0;
      if (fromBand(0, offset, period) < half) SWEEP_AT[n++] = 0;
      if (fromBand(1, offset, period) < half) SWEEP_AT[n++] = 1;
      for (let r = 0; r < repeat; r++) {
        for (let k = -1; k <= 1; k++) {
          const centre = offset + r * period + k;
          for (let j = 0; j <= 4; j++) {
            const f = centre - half + (2 * half * j) / 4;
            if (f > 0 && f < 1) SWEEP_AT[n++] = f;
          }
        }
      }
      if (n === 0) SWEEP_AT[n++] = 0;
      SWEEP_AT.fill(Infinity, n);
      SWEEP_AT.sort();
      for (let i = 0; i < n; i++) {
        const f = SWEEP_AT[i];
        const x = fromBand(f, offset, period) / half;
        const v = x >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * x);
        grad.addColorStop(f, mix(p.color2, p.color, v));
      }
    } else {
      // Every edge inside the gradient, then a flat run of the right colour
      // between each pair of them.
      let n = 0;
      SWEEP_AT[n++] = 0;
      SWEEP_AT[n++] = 1;
      for (let r = 0; r < repeat; r++) {
        for (let k = -1; k <= 1; k++) {
          const centre = offset + r * period + k;
          if (centre - half > 0 && centre - half < 1) SWEEP_AT[n++] = centre - half;
          if (centre + half > 0 && centre + half < 1) SWEEP_AT[n++] = centre + half;
        }
      }
      SWEEP_AT.fill(Infinity, n);
      SWEEP_AT.sort();
      const EPS = 0.0015;
      for (let i = 0; i < n - 1; i++) {
        const lo = SWEEP_AT[i];
        const hi = SWEEP_AT[i + 1];
        if (hi - lo <= 1e-6) continue;
        const colour = fromBand((lo + hi) / 2, offset, period) < half ? p.color : p.color2;
        grad.addColorStop(i === 0 ? 0 : Math.min(hi, lo + EPS), colour);
        grad.addColorStop(hi === 1 ? 1 : Math.max(lo, hi - EPS), colour);
      }
    }

    g.save();
    g.fillStyle = grad;
    g.fill(shape.path);
    g.restore();
  },
};

const wash = {
  id: 'wash',
  name: 'Full-frame Wash',
  category: 'basic',
  scope: 'global',
  description:
    'Covers everything the projector can reach, ignoring shapes. Use for ambient colour and whole-house lightning.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#0b1030' },
    { key: 'color2', type: 'color', label: 'Colour 2', default: '#000000' },
    { key: 'blend', type: 'range', label: 'Mix', default: 0, min: 0, max: 1, step: 0.01 },
    { key: 'level', type: 'range', label: 'Brightness', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'vignette', type: 'range', label: 'Vignette', default: 0, min: 0, max: 1, step: 0.01 },
  ],
  draw({ g, p, world }) {
    g.save();
    g.globalAlpha *= clamp(p.level, 0, 1);
    // Linear blend — this is two washes of light, not two tins of paint.
    g.fillStyle = mix(p.color, p.color2, p.blend);
    g.fillRect(0, 0, world.w, world.h);

    if (p.vignette > 0) {
      /**
       * An ellipse the shape of the frame, not a circle.
       *
       * A circular vignette on a wide frame darkens the two ends of the house
       * hard and barely touches the roof or the path, which reads as two dark
       * patches rather than as light falling off. Squashed to the frame, it
       * closes in evenly from every edge; eased rather than ramped, so there is
       * no visible ring where the darkening starts.
       */
      const v = clamp(p.vignette, 0, 1);
      g.translate(world.w / 2, world.h / 2);
      g.scale(world.w / 2, world.h / 2);
      const grad = g.createRadialGradient(0, 0, 0.3, 0, 0, 1.45);
      for (let i = 0; i <= 4; i++) {
        const f = i / 4;
        grad.addColorStop(f, `rgba(0,0,0,${(v * smoothstep(0, 1, f)).toFixed(4)})`);
      }
      g.fillStyle = grad;
      g.fillRect(-1, -1, 2, 2);
    }
    g.restore();
  },
};

/** A ripple's crest, out from its own radius in ring widths, and how bright. */
const CREST_AT = [-2.2, -1.1, -0.35, 0, 0.35, 1.1, 2.2];
const CREST_ALPHA = [0, 0.26, 0.8, 1, 0.8, 0.26, 0];

const ripple = {
  id: 'ripple',
  name: 'Ripple Rings',
  category: 'basic',
  scope: 'shape',
  description: 'Concentric rings expanding from the centre of the shape.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#66e0ff' },
    { key: 'speed', type: 'range', label: 'Speed', default: 0.4, min: -2, max: 2, step: 0.01 },
    { key: 'count', type: 'range', label: 'Rings', default: 4, min: 1, max: 16, step: 1 },
    { key: 'width', type: 'range', label: 'Ring width', default: 8, min: 1, max: 60, step: 1 },
    { key: 'fade', type: 'bool', label: 'Fade out', default: true },
  ],
  /**
   * Each ring is a crest of light rather than a drawn circle.
   *
   * A radial gradient over just the band the ring occupies: a bright crest,
   * pushed towards white at its very top, falling away smoothly on both sides
   * to nothing about two ring-widths out. A hard stroked circle reads as a
   * target painted on the glass; a crest with a falloff reads as a wave of
   * light moving across it. Born out of nothing at the centre, and with Fade
   * out on, dying into nothing at the edge, so no ring pops in or out.
   */
  draw({ g, p, shape, t }) {
    const { bbox } = shape;
    const maxR = Math.hypot(bbox.w, bbox.h) * 0.55;
    if (!(maxR > 0.5)) return;
    const count = Math.max(1, Math.round(p.count));
    const w = Math.max(1, p.width);
    const crest = mix(p.color, '#ffffff', 0.5);
    const { r: cr, g: cg, b: cb } = hexToRgb(p.color);
    const { r: hr, g: hg, b: hb } = hexToRgb(crest);
    const x = bbox.cx;
    const y = bbox.cy;

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < count; i++) {
      const phase = ((t * p.speed + i / count) % 1 + 1) % 1;
      const r = phase * maxR;
      const level = Math.min(1, phase / 0.06) * (p.fade ? (1 - phase) ** 1.2 : 1);
      if (r <= 0.5 || level <= 0.01) continue;
      const inner = Math.max(0, r - w * 2.2);
      const outer = r + w * 2.2;
      const span = outer - inner;
      const grad = g.createRadialGradient(x, y, inner, x, y, outer);
      let last = 0;
      for (let s = 0; s < CREST_AT.length; s++) {
        // Kept in order even for a ring still smaller than its own glow.
        last = Math.max(last, clamp((r + CREST_AT[s] * w - inner) / span, 0, 1));
        const a = clamp(CREST_ALPHA[s] * level, 0, 1);
        grad.addColorStop(last, s === 3 ? `rgba(${hr},${hg},${hb},${a})` : `rgba(${cr},${cg},${cb},${a})`);
      }
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, outer, 0, TAU);
      if (inner > 0.5) {
        g.moveTo(x + inner, y);
        g.arc(x, y, inner, 0, TAU, true);
      }
      g.fill();
    }
    g.restore();
  },
};

export default [fill, outline, strobe, staticNoise, mask, sweep, wash, ripple];
