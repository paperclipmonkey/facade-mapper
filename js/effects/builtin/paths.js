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
 * difference is what happens at the ends. Round a closed shape everything simply
 * goes round; along an open one a chase or a comet runs off the end and comes in
 * again from the start, like a marquee, or bounces if asked to.
 */

import { rgba, clamp, lerp, TAU, frac } from '../../core/math.js';
import { blackbodyCss, mixLinear } from '../color.js';
import { offscreen } from '../lib.js';

/** Position along a path, wrapping for closed shapes and clamping for open ones. */
function sampleAt(shape, u) {
  return shape.sampler.at(shape.closed ? frac(u) : clamp(u, 0, 1));
}

/**
 * Rotate a hex colour's hue by `degrees`, keeping its saturation and value.
 *
 * Only ever called while baking sprites, so the string work is paid once per
 * colour rather than per bulb per frame.
 */
function hueShift(hex, degrees) {
  const n = parseInt(String(hex).replace('#', '').slice(0, 6), 16) || 0;
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 1e-6) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  h = (((h * 60 + degrees) % 360) + 360) % 360;
  const s = max > 0 ? d / max : 0;
  const c = max * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = max - c;
  const [r1, g1, b1] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const to = (v) => Math.round(clamp(v + m, 0, 1) * 255).toString(16).padStart(2, '0');
  return `#${to(r1)}${to(g1)}${to(b1)}`;
}

/* ------------------------------------------------------------------ *
 * Baked light
 *
 * Every point of light in this file — a bulb, a chase head, a comet, a spark —
 * is stamped from sprites baked once per colour, never built from a gradient
 * per particle per frame. A radial gradient is an allocation and a fresh
 * rasterisation every time; a `drawImage` of a canvas that already holds the
 * falloff is a textured blit. The falloff in each one is the shape a small
 * source scattering in air actually has — a tight hot core and a long faint
 * skirt — rather than a linear ramp, which reads as a painted disc with a
 * visible edge.
 *
 * Each instance keeps its own, in its `state`, keyed by what they were baked
 * from. Shared between instances they would be cheaper, but then what an
 * instance bakes depends on what else happened to draw before it — in this
 * tab, ever — and the baking is part of the history two projector tabs are
 * supposed to agree on. Colours cannot be modulated (there is no arithmetic on
 * a colour), and the sparks' temperatures go through `blackbodyCss`, which
 * quantises to 25 K, so the set of keys stays small.
 * ------------------------------------------------------------------ */

/** This instance's own baked sprites. */
function bakedFor(state) {
  return state.baked || (state.baked = new Map());
}

const SPRITE_PX = 64;

/** Inverse-square-ish falloff: [offset, alpha] from the centre outwards. */
const SKIRT = [
  [0, 1],
  [0.08, 0.78],
  [0.18, 0.42],
  [0.34, 0.16],
  [0.56, 0.05],
  [0.8, 0.012],
  [1, 0],
];

function radialSprite(colour, stops, peak = 1) {
  const canvas = offscreen(SPRITE_PX, SPRITE_PX);
  const c = canvas.getContext('2d');
  const h = SPRITE_PX / 2;
  const grad = c.createRadialGradient(h, h, 0, h, h, h);
  for (const [offset, alpha] of stops) grad.addColorStop(offset, rgba(colour, alpha * peak));
  c.fillStyle = grad;
  c.fillRect(0, 0, SPRITE_PX, SPRITE_PX);
  return canvas;
}

/**
 * A pool of light thrown on the wall: broader in the shoulder than `SKIRT`.
 *
 * The stills — and the eye on the night — add the projector's light to the
 * wall in *linear* light, where anything below about a third of full scale in
 * sRGB all but vanishes. A falloff that looks right as a sprite on black is a
 * faint smudge on the house, so the pools a lamp throws have to carry real
 * energy well away from the lamp to read as a pool at all.
 */
const POOL = [
  [0, 1],
  [0.1, 0.82],
  [0.22, 0.52],
  [0.38, 0.27],
  [0.56, 0.11],
  [0.78, 0.032],
  [1, 0],
];

/** A soft point of light in one colour, centred in its canvas. */
function glowSprite(store, colour) {
  const key = `glow|${colour}`;
  let sprite = store.get(key);
  if (!sprite) {
    sprite = radialSprite(colour, SKIRT);
    store.set(key, sprite);
  }
  return sprite;
}

/** The broad pool of light a lamp throws on the wall around it. */
function poolSprite(store, colour) {
  const key = `pool|${colour}`;
  let sprite = store.get(key);
  if (!sprite) {
    sprite = radialSprite(colour, POOL);
    store.set(key, sprite);
  }
  return sprite;
}

/**
 * The white-hot centre of a coloured source.
 *
 * Anything bright enough to see from the street saturates the eye and the
 * camera at its middle, so the centre of a red bulb is not red — it is nearly
 * white with a red rim, and the colour lives in the glass and the halo. Drawing
 * the whole bulb in its own colour is what made the old string look like
 * coloured dots rather than lamps.
 */
function hotSprite(store, colour) {
  const key = `hot|${colour}`;
  let sprite = store.get(key);
  if (!sprite) {
    const canvas = offscreen(SPRITE_PX, SPRITE_PX);
    const c = canvas.getContext('2d');
    const h = SPRITE_PX / 2;
    const grad = c.createRadialGradient(h, h, 0, h, h, h);
    grad.addColorStop(0, rgba(mixLinear(colour, '#ffffff', 0.9), 1));
    grad.addColorStop(0.18, rgba(mixLinear(colour, '#ffffff', 0.62), 0.92));
    grad.addColorStop(0.42, rgba(mixLinear(colour, '#ffffff', 0.2), 0.42));
    grad.addColorStop(0.7, rgba(colour, 0.1));
    grad.addColorStop(1, rgba(colour, 0));
    c.fillStyle = grad;
    c.fillRect(0, 0, SPRITE_PX, SPRITE_PX);
    sprite = canvas;
    store.set(key, sprite);
  }
  return sprite;
}

/* ------------------------------------------------------------------ *
 * Bulbs
 * ------------------------------------------------------------------ */

/** Three tilts of the glass, so a string does not hang like a row of soldiers. */
const BULB_TILTS = [-0.2, 0, 0.17];
/** And two tints per colour: no two bulbs off a real reel are quite the same. */
const BULB_TINTS = [0, 9];

/**
 * One coloured bulb: the glass, lit from inside, in its own halo.
 *
 * A C9 or festoon lamp seen from across the road is three things, and the old
 * flat disc was none of them. A **glass envelope** — a short cone with a round
 * end, hanging from its socket — saturated in its own colour, brightest where
 * the filament is and dimmer at the rim. A **halo** of the same colour round
 * it, where the light scatters in the glass and the air. And the **hot centre**,
 * which is a separate sprite so it can fade faster than the glass as a bulb
 * dims: a twinkling lamp loses its white-hot middle first, exactly as a
 * filament does, and that is most of what makes a dip read as a twinkle rather
 * than as the whole bulb being turned down.
 *
 * Baked pointing down — bulbs hang — in three tilts and two slightly different
 * tints, chosen per bulb.
 */
function bulbSprites(store, colour) {
  const key = `bulb|${colour}`;
  let set = store.get(key);
  if (set) return set;
  const S = SPRITE_PX;
  const h = S / 2;
  set = { glass: [], hot: [], spill: poolSprite(store, colour) };
  for (const tint of BULB_TINTS) {
    const hue = tint ? hueShift(colour, tint) : colour;
    for (const tilt of BULB_TILTS) {
      const canvas = offscreen(S, S);
      const c = canvas.getContext('2d');
      c.globalCompositeOperation = 'lighter';

      // Halo first, centred on the filament.
      const halo = c.createRadialGradient(h, h, 0, h, h, h);
      halo.addColorStop(0, rgba(hue, 0.7));
      halo.addColorStop(0.16, rgba(hue, 0.52));
      halo.addColorStop(0.3, rgba(hue, 0.27));
      halo.addColorStop(0.5, rgba(hue, 0.1));
      halo.addColorStop(0.75, rgba(hue, 0.025));
      halo.addColorStop(1, rgba(hue, 0));
      c.fillStyle = halo;
      c.fillRect(0, 0, S, S);

      // The envelope: a cone from the socket, swelling and closing to a round
      // tip. Brightest just below the socket, where the filament sits.
      c.save();
      c.translate(h, h);
      c.rotate(tilt);
      const top = -0.2 * S;
      const tip = 0.25 * S;
      c.beginPath();
      c.moveTo(-0.075 * S, top);
      c.bezierCurveTo(-0.17 * S, top + 0.13 * S, -0.15 * S, tip - 0.09 * S, 0, tip);
      c.bezierCurveTo(0.15 * S, tip - 0.09 * S, 0.17 * S, top + 0.13 * S, 0.075 * S, top);
      c.closePath();
      const glass = c.createRadialGradient(0, -0.02 * S, 0, 0, 0.02 * S, 0.24 * S);
      glass.addColorStop(0, rgba(mixLinear(hue, '#ffffff', 0.55), 1));
      glass.addColorStop(0.3, rgba(hue, 1));
      glass.addColorStop(0.75, rgba(hue, 0.85));
      glass.addColorStop(1, rgba(hue, 0.55));
      c.fillStyle = glass;
      c.fill();
      // A sliver of reflection down one shoulder: it is glass, not a dot.
      c.beginPath();
      c.ellipse(-0.07 * S, 0.01 * S, 0.018 * S, 0.075 * S, 0.25, 0, TAU);
      c.fillStyle = rgba('#ffffff', 0.28);
      c.fill();
      c.restore();
      set.glass.push(canvas);
    }
    set.hot.push(hotSprite(store, hue));
  }
  store.set(key, set);
  return set;
}

/**
 * The bulbs' own colours.
 *
 * Saturated and bright rather than pastel: on a dark wall the eye reads colour
 * from the glass and the halo, and anything pale goes white the moment the
 * bloom gets hold of it. Warm white is a filament at two and a half to three
 * thousand kelvin, so it takes its colour from the blackbody curve like every
 * other hot thing here.
 */
const PALETTES = {
  multi: ['#ff2418', '#ffa21a', '#1fe35a', '#2b62ff', '#ff3cc8'],
  warm: [blackbodyCss(2350), blackbodyCss(2650), blackbodyCss(2950)],
  cool: ['#7fd8ff', '#a0b8ff', '#d0e8ff'],
  halloween: ['#ff7a18', '#8b00ff', '#39ff14'],
  christmas: ['#ff2418', '#1fd35a', '#ffbf1a', blackbodyCss(2900)],
};

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
  draw({ g, p, shape, t, state, stable = p }) {
    if (!shape.sampler.length) return;
    const count = Math.max(1, Math.round(p.count));
    const bouncing = p.bounce && !shape.closed;
    // Ping-pong along an open path instead of teleporting back to the start.
    const base = bouncing ? Math.abs(frac(t * p.speed * 0.5) * 2 - 1) : t * p.speed;
    const level = clamp(p.level, 0, 4);
    const size = Math.max(0.5, p.size);
    const back = p.speed >= 0 ? 1 : -1;

    // Colours worked out once, not per light per frame.
    const key = `${stable.color}|${stable.trail}`;
    if (state.key !== key) {
      state.key = key;
      const store = bakedFor(state);
      state.glow = poolSprite(store, stable.color);
      state.hot = hotSprite(store, stable.color);
      state.trail = rgba(stable.trail, 1);
      state.haze = glowSprite(store, stable.trail);
    }

    g.save();
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';
    g.lineJoin = 'round';

    // Wrapping along an open path rather than parking at its end: a lap ends
    // and the next begins at the start, the way a marquee runs. Clamping, as
    // this used to, stacked every light on the last point after one pass.
    const along = (u) => (shape.closed ? frac(u) : bouncing ? clamp(u, 0, 1) : frac(u));
    const tailSteps = p.tail > 0 ? clamp(Math.round((p.tail * shape.sampler.length) / 6), 3, 40) : 0;

    for (let i = 0; i < count; i++) {
      // Bouncing lights travel as a tight cluster; wrapping ones space evenly,
      // offset half a slot so they are not all sitting on the corners of a
      // window whenever a lap comes round.
      const u = bouncing
        ? clamp(base + (i - (count - 1) / 2) * 0.025, 0, 1)
        : base + (i + 0.5) / count;
      const head = shape.sampler.at(along(u));

      /**
       * The trail, as a smooth tapered streak along the path rather than a
       * row of shrinking dots: segments that narrow and fade behind the head.
       * On an open path it stops at the start rather than wrapping round to
       * the far end.
       */
      if (tailSteps) {
        g.strokeStyle = state.trail;
        let prev = head;
        for (let s = 1; s <= tailSteps; s++) {
          const f = s / tailSteps;
          const ut = u - p.tail * f * back;
          if (!shape.closed && !bouncing && Math.floor(ut) !== Math.floor(u)) break;
          const pt = shape.sampler.at(along(ut));
          const fade = 1 - f;
          g.globalAlpha = clamp(level * 0.45 * fade * fade, 0, 1);
          g.lineWidth = size * (0.15 + 0.45 * fade);
          g.beginPath();
          g.moveTo(prev.x, prev.y);
          g.lineTo(pt.x, pt.y);
          g.stroke();
          // A soft glow along it, so the streak is light rather than a wedge.
          const r = size * (0.6 + 1.1 * fade);
          g.globalAlpha = clamp(level * 0.3 * fade, 0, 1);
          g.drawImage(state.haze, pt.x - r, pt.y - r, r * 2, r * 2);
          prev = pt;
        }
      }

      // The light itself: a halo in its own colour, then a white-hot centre.
      if (p.glow > 0) {
        const r = size * (1 + p.glow) * 1.2;
        g.globalAlpha = clamp(level * 0.85, 0, 1);
        g.drawImage(state.glow, head.x - r, head.y - r, r * 2, r * 2);
      }
      const d = size * 2;
      g.globalAlpha = clamp(level, 0, 1);
      g.drawImage(state.hot, head.x - d / 2, head.y - d / 2, d, d);
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
  draw({ g, p, shape, t, beat, state, stable = p }) {
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
    const { bbox } = shape;

    // Colours for the cross-section, worked out once per colour.
    if (state.colour !== stable.color) {
      state.colour = stable.color;
      state.ink = rgba(stable.color, 1);
      state.hot = rgba(mixLinear(stable.color, '#ffffff', 0.55), 1);
    }

    g.save();
    g.globalCompositeOperation = 'lighter';
    g.lineJoin = 'round';
    g.lineCap = 'round';
    const strength = clamp(level, 0, 4);

    if (p.grow > 0) {
      const s = 1 + p.grow * (w - 0.5) * 2;
      g.translate(bbox.cx, bbox.cy);
      g.scale(s, s);
      g.translate(-bbox.cx, -bbox.cy);
    }

    /**
     * The fill is light gathered at the edges, never a flat coat.
     *
     * A flat fill turns a door into a glowing orange slab: there is nothing on
     * a real facade that emits evenly over its whole area, so the eye reads
     * it as paint. What a lit opening actually does is glow most strongly round
     * its edges — light leaking past the frame — and fall away towards the
     * middle. Stroking the outline in a few widening passes, clipped to the
     * shape, is exactly that: the passes overlap most at the outline and least
     * at the centre, and corners, where two edges are close, gather more.
     * A faint soft wash under it keeps the middle from going dead.
     */
    if ((p.mode === 'fill' || p.mode === 'both') && bbox.w > 0 && bbox.h > 0) {
      g.save();
      g.clip(shape.path);
      const reach = Math.min(bbox.w, bbox.h) * 0.42;
      g.strokeStyle = state.ink;
      for (let k = 1; k <= 4; k++) {
        g.globalAlpha = clamp(strength * 0.18, 0, 1);
        g.lineWidth = reach * (k / 4) * 2;
        g.stroke(shape.path);
      }
      g.globalAlpha = clamp(strength * 0.1, 0, 1);
      g.fillStyle = state.ink;
      g.fill(shape.path);
      g.restore();
    }

    /**
     * The outline as light: a hot, slightly whitened core inside a soft
     * coloured falloff on both sides. Nested strokes, each narrower and
     * brighter than the last, approximate the cross-section of a glowing tube;
     * one solid band of colour with a faint wider one round it, which this
     * used to be, has a hard edge either side and reads as a painted frame.
     */
    if (p.mode === 'outline' || p.mode === 'both') {
      const width = Math.max(0.5, p.width);
      const passes = [[2.8, 0.1], [1.9, 0.16], [1.25, 0.24], [0.8, 0.36]];
      g.strokeStyle = state.ink;
      for (const [scale, alpha] of passes) {
        g.globalAlpha = clamp(strength * alpha, 0, 1);
        g.lineWidth = width * scale;
        g.stroke(shape.path);
      }
      g.strokeStyle = state.hot;
      g.globalAlpha = clamp(strength * 0.7, 0, 1);
      g.lineWidth = width * 0.32;
      g.stroke(shape.path);
    }
    g.restore();
  },
};

/**
 * How many bulbs hang in each swag between two pins. Three is what a festoon
 * string clipped up every metre or so actually does at the spacing people use;
 * fewer and the scallops are too small to read, more and they droop.
 */
const BULBS_PER_SWAG = 3;
/** Points per swag when drawing the wire — it is smoothed through them. */
const WIRE_STEPS = 8;

const fairyLights = {
  id: 'fairy-lights',
  name: 'Fairy Lights',
  category: 'path',
  scope: 'shape',
  description:
    'A string of glass bulbs hung along the path, sagging between its pins, with twinkle, chase and colour-cycle patterns.',
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
    { key: 'sag', type: 'range', label: 'Sag between pins', default: 0.45, min: 0, max: 1, step: 0.01 },
  ],
  init() {
    return { phases: null, count: 0 };
  },
  /**
   * Everything that makes one bulb not quite like its neighbour, cast once per
   * bulb and regenerated only when the count changes — so bulbs keep their
   * identity while you drag the spacing slider.
   *
   * A real string is never a stamped row: the bulbs slip a little along the
   * wire, hang at slightly different angles, are not quite the same tint, and
   * differ in brightness by more than you would think. Each of those is small;
   * together they are the difference between lamps and a dotted line.
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
    state.rates = new Float32Array(count);
    state.slip = new Float32Array(count);
    state.gain = new Float32Array(count);
    state.scale = new Float32Array(count);
    state.look = new Uint8Array(count);
    state.xs = new Float32Array(count);
    state.ys = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      state.phases[i] = rng();
      state.rates[i] = 0.7 + rng() * 0.6;
      state.slip[i] = (rng() - 0.5) * 0.24;
      state.gain[i] = 0.8 + rng() * 0.32;
      state.scale[i] = 0.88 + rng() * 0.24;
      state.look[i] = Math.floor(rng() * BULB_TINTS.length * BULB_TILTS.length);
    }
    state.wx = new Float32Array(WIRE_STEPS + 1);
    state.wy = new Float32Array(WIRE_STEPS + 1);
  },
  draw({ g, p, shape, t, state, stable = p }) {
    const { sampler } = shape;
    const length = sampler.length;
    if (length <= 0 || !state.phases) return;
    const count = state.count;
    const closed = shape.closed;

    // Sprites per palette entry, rebuilt only when the palette itself changes.
    const key = `${stable.palette}|${stable.color}`;
    if (state.spriteKey !== key) {
      state.spriteKey = key;
      const palette = stable.palette === 'single'
        ? [stable.color]
        : (PALETTES[stable.palette] || PALETTES.multi);
      const store = bakedFor(state);
      state.sets = palette.map((colour) => bulbSprites(store, colour));
    }
    const sets = state.sets;
    const colours = sets.length;

    const size = Math.max(0.5, p.size);
    const level = clamp(p.level, 0, 4);

    /**
     * The wire, and where the bulbs hang on it.
     *
     * Pinned every few bulbs and sagging between the pins as a parabola, which
     * is a catenary to within a pixel at this depth. The sag is gravity, so it
     * is always straight down and scaled by how level the span is: a run up the
     * side of a window frame hangs flat against it, a run along the top dips.
     * Measured from the chord between the pins rather than from the local
     * slope of the path, so a swag that turns a corner does not kink.
     */
    const per = BULBS_PER_SWAG;
    const swags = Math.max(1, Math.ceil(count / per));
    const sway = (k) => 1 + 0.07 * Math.sin(t * 0.8 + k * 1.9);
    const sagDepth = (k) => {
      const ua = (k * per) / count;
      const ub = Math.min(1, ((k + 1) * per) / count);
      const a = sampler.at(ua);
      const b = sampler.at(closed ? frac(ub) : ub);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const chord = Math.hypot(dx, dy);
      const level01 = chord > 1e-6 ? Math.abs(dx) / chord : 0;
      return clamp(p.sag, 0, 1) * chord * 0.2 * level01 * sway(k);
    };
    // Sag offset at `u`, inside swag `k`.
    const dip = (u, k, depth) => {
      const ua = (k * per) / count;
      const ub = Math.min(1, ((k + 1) * per) / count);
      const f = clamp((u - ua) / Math.max(1e-9, ub - ua), 0, 1);
      return depth * 4 * f * (1 - f);
    };

    g.save();
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';
    g.lineJoin = 'round';

    // Bulb positions first: the wire is drawn under them but needs the same sag.
    const { xs, ys, slip, scale } = state;
    for (let k = 0; k < swags; k++) {
      const depth = sagDepth(k);
      const last = Math.min(count, (k + 1) * per);
      for (let i = k * per; i < last; i++) {
        const u = clamp((i + 0.5 + slip[i]) / count, 0, 1);
        const at = sampler.at(u);
        xs[i] = at.x;
        // The glass hangs from its socket on the wire.
        ys[i] = at.y + dip(u, k, depth) + size * 0.62 * scale[i];
      }
    }

    // A thin, dim line: the flex is dark, and what you see of it at night is
    // the light of its own bulbs catching it. Scaled up from the slider because
    // a line this thin added to the wall in linear light needs the energy to
    // survive at all; 0.1 still reads as a faint wire, not a white rule.
    if (p.wire > 0) {
      g.globalAlpha = clamp(level * p.wire * 2.2, 0, 1);
      g.strokeStyle = '#ab9f8a';
      g.lineWidth = Math.max(1.5, size * 0.16);
      const { wx, wy } = state;
      g.beginPath();
      for (let k = 0; k < swags; k++) {
        const depth = sagDepth(k);
        const ua = (k * per) / count;
        const ub = Math.min(1, ((k + 1) * per) / count);
        for (let s = 0; s <= WIRE_STEPS; s++) {
          const u = ua + ((ub - ua) * s) / WIRE_STEPS;
          const at = sampler.at(closed ? frac(u) : u);
          wx[s] = at.x;
          wy[s] = at.y + dip(u, k, depth);
        }
        if (k === 0) g.moveTo(wx[0], wy[0]);
        else g.lineTo(wx[0], wy[0]);
        for (let s = 1; s < WIRE_STEPS; s++) {
          g.quadraticCurveTo(wx[s], wy[s], (wx[s] + wx[s + 1]) / 2, (wy[s] + wy[s + 1]) / 2);
        }
        g.lineTo(wx[WIRE_STEPS], wy[WIRE_STEPS]);
      }
      g.stroke();
    }

    // How lit each bulb is, and in which colour — the pattern.
    const cycleAt = t * p.speed * 2;
    const cycleStep = Math.floor(cycleAt);
    // A colour change is a short crossfade rather than a cut: every bulb on the
    // house switching at the same instant reads as a fault. Running backwards,
    // the step being approached is the previous one.
    const cycleDir = p.speed >= 0 ? 1 : -1;
    const ahead = cycleDir > 0 ? frac(cycleAt) : 1 - frac(cycleAt);
    const cycleMix = p.pattern === 'cycle' ? clamp((ahead - 0.72) / 0.28, 0, 1) : 0;
    const chaseHead = frac(t * p.speed * 0.25);
    const alternateOn = frac(t * p.speed * 0.5) < 0.5;
    const brightnessOf = (i, u) => {
      switch (p.pattern) {
        case 'twinkle': {
          // Mostly up, with a dip now and then at each bulb's own rate.
          const s = 0.5 + 0.5 * Math.sin((t * p.speed * state.rates[i] + state.phases[i]) * TAU * 1.7);
          return 0.3 + 0.7 * Math.pow(s, 0.6);
        }
        case 'chase': {
          // The lit run is a fixed fraction of the string, so changing the bulb
          // spacing changes the density rather than the length of the chase.
          // Unlit bulbs keep a glimmer, or the string itself disappears.
          const d = Math.abs(frac(u - chaseHead + 0.5) - 0.5);
          return Math.max(0.06, clamp(1 - d / 0.14, 0, 1));
        }
        case 'alternate':
          return (i % 2 === 0) === alternateOn ? 1 : 0.07;
        case 'wave':
          return 0.2 + 0.8 * (0.5 + 0.5 * Math.sin((u * 3 - t * p.speed) * TAU));
        default:
          return 1;
      }
    };

    /**
     * Three passes, back to front: the light each bulb throws on the wall,
     * then the glass in its halo, then the white-hot centres. Passes rather
     * than bulb by bulb so that one bulb's spill never lands on top of its
     * neighbour's glass — it adds, but it would still wash the colour out of
     * the glass it lands on.
     */
    const glowAmount = Math.max(0, p.glow);
    const spillR = size * (1.2 + glowAmount * 1.6);
    const spillA = Math.min(1, 0.34 + glowAmount * 0.2);
    const glassD = size * 3;
    const hotD = size * 1.3;

    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < count; i++) {
        const u = (i + 0.5) / count;
        const b = brightnessOf(i, u) * state.gain[i] * level;
        if (b <= 0.01) continue;
        let ci = ((i + (p.pattern === 'cycle' ? cycleStep : 0)) % colours + colours) % colours;
        // During a crossfade each bulb is drawn twice, once in each colour.
        for (let layer = 0; layer < (cycleMix > 0 ? 2 : 1); layer++) {
          const weight = cycleMix > 0 ? (layer === 0 ? 1 - cycleMix : cycleMix) : 1;
          if (layer === 1) ci = (((ci + cycleDir) % colours) + colours) % colours;
          const set = sets[ci];
          const a = clamp(b * weight, 0, 1);
          const x = xs[i];
          const y = ys[i];
          const sc = scale[i];
          if (pass === 0) {
            if (p.glow <= 0) continue;
            const r = spillR * sc;
            g.globalAlpha = clamp(a * spillA, 0, 1);
            g.drawImage(set.spill, x - r, y - r, r * 2, r * 2);
          } else if (pass === 1) {
            const look = state.look[i];
            const d = glassD * sc;
            g.globalAlpha = a;
            g.drawImage(set.glass[look], x - d / 2, y - d / 2, d, d);
          } else {
            // The hot centre fades faster than the glass, and anything past
            // full brightness goes into it rather than being clipped away.
            const tint = Math.floor(state.look[i] / BULB_TILTS.length);
            const over = Math.max(0, b * weight - 1);
            const d = hotD * sc * (1 + over * 0.6);
            g.globalAlpha = clamp(a * a + over * 0.5, 0, 1);
            g.drawImage(set.hot[tint], x - d / 2, y - d * 0.6, d, d);
          }
        }
      }
    }
    g.restore();
  },
};

/** Steps in the comet's head-to-tail colour ramp. */
const COMET_RAMP = 12;

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
  draw({ g, p, shape, t, state, stable = p }) {
    const { sampler } = shape;
    if (!sampler.length) return;
    const level = clamp(p.level, 0, 4);
    const width = Math.max(1, p.width);
    const tail = clamp(p.tail, 0.005, 1);
    const back = p.speed >= 0 ? 1 : -1;
    const heads = Math.max(1, Math.round(p.heads));

    /**
     * The tail's colour runs from the head's back to the tail colour through
     * linear light — a white-hot head cooling into its trail — rather than
     * switching from one to the other a short way back, which left a hard
     * seam across the tail. Ramp and sprites worked out once per colour pair.
     */
    const key = `${stable.color}|${stable.tailColor}`;
    if (state.key !== key) {
      state.key = key;
      state.ramp = [];
      for (let k = 0; k < COMET_RAMP; k++) {
        state.ramp.push(rgba(mixLinear(stable.color, stable.tailColor, Math.min(1, (k / (COMET_RAMP - 1)) * 2.5)), 1));
      }
      const store = bakedFor(state);
      state.glow = glowSprite(store, stable.color);
      state.hot = hotSprite(store, stable.color);
      state.haze = glowSprite(store, stable.tailColor);
    }

    g.save();
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';

    const steps = clamp(Math.round((tail * sampler.length) / 5), 16, 96);
    // Where a point `f` of the way down the tail sits, or -1 off an open end.
    const spot = (uh, f) => {
      const u = uh - back * tail * f;
      if (shape.closed) return frac(u);
      return u < 0 || u > 1 ? -1 : u;
    };

    for (let c = 0; c < heads; c++) {
      const phase = t * p.speed + c / heads;
      /**
       * Round and round a closed shape. Along an open one the comet runs off
       * the end, tail and all, and then comes in again from the start —
       * where it used to stop dead at the end of the first lap, because the
       * position was clamped and never wrapped.
       */
      const run = frac(back * phase) * (1 + tail);
      const uh = shape.closed ? phase : back > 0 ? run : 1 - run;

      // Tail first, so the head paints over it: short segments, so the width
      // and the colour can change down its length.
      for (let s = steps - 1; s >= 0; s--) {
        const f0 = s / steps;
        const f1 = (s + 1) / steps;
        const ua = spot(uh, f0);
        const ub = spot(uh, f1);
        if (ua < 0 || ub < 0) continue;
        const a = sampler.at(ua);
        const b = sampler.at(ub);
        const fade = 1 - f0;
        g.globalAlpha = clamp(level * fade * fade * 0.85, 0, 1);
        g.strokeStyle = state.ramp[Math.min(COMET_RAMP - 1, Math.floor(f0 * COMET_RAMP))];
        g.lineWidth = width * (0.15 + 0.85 * Math.pow(fade, 1.3));
        g.beginPath();
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
        g.stroke();
        // A soft breath of the tail colour round it now and then, so the
        // streak has a glow rather than a hard edge.
        if (s % 4 === 0) {
          const r = width * 1.4 * fade;
          g.globalAlpha = clamp(level * fade * 0.18, 0, 1);
          g.drawImage(state.haze, a.x - r, a.y - r, r * 2, r * 2);
        }
      }

      const hu = shape.closed ? frac(uh) : uh;
      if (hu < 0 || hu > 1) continue;
      const h = sampler.at(hu);
      const r = width * 2.2;
      g.globalAlpha = clamp(level * 0.9, 0, 1);
      g.drawImage(state.glow, h.x - r, h.y - r, r * 2, r * 2);
      const d = width * 1.3;
      g.globalAlpha = clamp(level, 0, 1);
      g.drawImage(state.hot, h.x - d / 2, h.y - d / 2, d, d);
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
  draw({ g, p, shape, t, state, stable = p }) {
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

    if (state.key !== stable.color) {
      state.key = stable.color;
      state.ink = rgba(stable.color, 1);
      state.hot = rgba(mixLinear(stable.color, '#ffffff', 0.6), 1);
      state.tip = hotSprite(bakedFor(state), stable.color);
      state.halo = glowSprite(bakedFor(state), stable.color);
    }

    g.save();
    g.lineCap = 'round';
    g.lineJoin = 'round';
    // A dash pattern of [visible, rest] with the right offset reveals the path
    // in order, which is far cheaper than re-tracing it point by point.
    const shown = total * visible;
    g.setLineDash([shown, total]);
    g.lineDashOffset = p.reverse ? shown - total : 0;

    /**
     * The line as light: a soft glow in three widening passes that add up to a
     * falloff, the line itself, and a thin hotter core. One wide stroke at a
     * fixed alpha, which this used to be, is a flat band with a hard edge on
     * each side.
     */
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = state.ink;
    if (p.glow > 0) {
      for (const [spread, alpha] of [[1, 0.07], [0.6, 0.11], [0.3, 0.16]]) {
        g.globalAlpha = alpha;
        g.lineWidth = p.width + p.glow * spread * 1.6;
        g.stroke(shape.path);
      }
    }
    g.globalAlpha = 1;
    g.lineWidth = p.width;
    g.stroke(shape.path);
    g.strokeStyle = state.hot;
    g.globalAlpha = 0.7;
    g.lineWidth = Math.max(0.5, p.width * 0.35);
    g.stroke(shape.path);

    // While it is drawing or wiping, the moving end is the pen: a bright point
    // leading the line, which is what makes it read as being drawn.
    if (visible < 0.999) {
      g.setLineDash([]);
      const end = p.reverse ? 1 - visible : visible;
      const at = shape.sampler.at(shape.closed ? frac(end) : clamp(end, 0, 1));
      const r = (p.width + p.glow * 0.8) * 1.4;
      g.globalAlpha = 0.85;
      g.drawImage(state.halo, at.x - r, at.y - r, r * 2, r * 2);
      const d = p.width * 2.2;
      g.globalAlpha = 1;
      g.drawImage(state.tip, at.x - d / 2, at.y - d / 2, d, d);
    }
    g.restore();
  },
};

/** Rungs in the sparks' temperature ladder. */
const SPARK_RUNGS = 12;

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
  draw({ g, p, t, state, stable = p }) {
    /**
     * A ladder of glows across the temperature range, baked when the range
     * changes rather than per spark: a spark is drawn with the rung nearest
     * its own temperature. Built all at once, so a spark cooling into a
     * temperature nobody has asked for yet never builds a sprite mid-show.
     */
    const key = `${stable.hotTemp}|${stable.coolTemp}`;
    if (state.key !== key) {
      state.key = key;
      state.ladder = [];
      for (let k = 0; k < SPARK_RUNGS; k++) {
        const kelvin = lerp(stable.coolTemp, stable.hotTemp, k / (SPARK_RUNGS - 1));
        state.ladder.push(glowSprite(bakedFor(state), blackbodyCss(kelvin)));
      }
    }
    const level = clamp(p.level, 0, 4);
    const span = p.hotTemp - p.coolTemp;

    g.save();
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';

    for (const part of state.parts) {
      const f = part.age / part.life;
      const alpha = Math.sin(f * Math.PI); // fade in and out
      if (alpha <= 0.01) continue;
      // Sparks cool as they fly, so colour comes from temperature.
      const heat = Math.exp(-3.5 * f);
      const kelvin = p.coolTemp + span * heat;
      const size = part.size * (1 - f * 0.6);

      /**
       * Each spark is a short streak along its own velocity — what a spark
       * looks like to an eye or a camera, which never sees a fast bright
       * point as a dot — with a soft glow at its head. Hotter sparks are
       * moving faster and burning brighter, so they streak further.
       */
      const vx = part.vx + p.drift;
      const vy = part.vy;
      const exposure = 0.03 + 0.04 * heat;
      g.strokeStyle = blackbodyCss(kelvin);
      g.globalAlpha = clamp(level * alpha * 0.85, 0, 1);
      g.lineWidth = Math.max(0.8, size);
      g.beginPath();
      g.moveTo(part.x - vx * exposure, part.y - vy * exposure);
      g.lineTo(part.x, part.y);
      g.stroke();

      // And a glow round the head, flickering the way a burning fleck does
      // as it tumbles.
      const flicker = 0.75 + 0.25 * Math.sin(t * 13 + part.seed * 7);
      const rung = state.ladder[Math.round(clamp(heat, 0, 1) * (SPARK_RUNGS - 1))];
      const d = size * (4.5 + 3.5 * heat);
      g.globalAlpha = clamp(level * alpha * flicker * (0.7 + 0.3 * heat), 0, 1);
      g.drawImage(rung, part.x - d / 2, part.y - d / 2, d, d);
    }
    g.restore();
  },
};


export default [chase, pulse, fairyLights, comet, trace, sparks];
