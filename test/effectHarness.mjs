/**
 * The stand-in browser every effect suite runs against.
 *
 * Shared by `robustness.test.mjs`, which holds the whole library to the rules
 * in docs/writing-effects.md, and `params.test.mjs`, which holds it to them
 * again with every slider pushed to its ends. Both need the same three things
 * and neither should own them: a 2D context that checks every number it is
 * handed, the set of shapes a real project can actually contain, and a runner
 * that drives one effect the way the renderer does.
 *
 * Importing this installs the stand-ins as globals — `Path2D`, `document`, a
 * `Math.random` that records who called it, and a stopped clock. That is
 * deliberate: an effect reaches for them by name and cannot be handed them.
 *
 * Not named `*.test.mjs`, so the suite runner does not try to run it.
 */

import { defaultParams } from '../js/effects/registry.js';
import { boundingBox, buildPathSampler, polygonCentroid, makeRng } from '../js/core/math.js';
import { defaultNoise } from '../js/core/noise.js';

/* ------------------------------------------------------------------ *
 * The stand-ins
 *
 * Enough DOM for an effect to do everything the contract allows: a 2D context
 * that checks its arguments, a Path2D, and a canvas factory that counts how
 * many it has been asked for.
 * ------------------------------------------------------------------ */

let canvasesMade = 0;

export function recordingContext(onBadNumber, journal) {
  const note = (name, args) => {
    for (const a of args) {
      if (typeof a === 'number' && !Number.isFinite(a)) onBadNumber(name, args);
    }
    if (journal) journal.push(`${name}(${args.map((a) => (typeof a === 'number' ? a.toFixed(6) : String(a))).join(',')})`);
  };
  const track = (name) => (...args) => note(name, args);

  const gradient = { addColorStop: (offset, colour) => note('addColorStop', [offset, colour]) };
  const state = { filter: 'none', shadowBlur: 0 };
  let filterSets = 0;
  let shadowSets = 0;

  const ctx = {
    canvas: { width: 1920, height: 1080 },
    fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', miterLimit: 10,
    font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic',
    shadowColor: 'transparent', lineDashOffset: 0, imageSmoothingEnabled: true,
    imageSmoothingQuality: 'low', direction: 'ltr', globalDebug: null,

    /** Counted, not merely stored — see the "per particle" rule. */
    get filter() { return state.filter; },
    set filter(v) { if (v && v !== 'none') filterSets++; state.filter = v; },
    get shadowBlur() { return state.shadowBlur; },
    set shadowBlur(v) { if (v > 0) shadowSets++; state.shadowBlur = v; },
    get expensiveSets() { return filterSets + shadowSets; },
    resetCounters() { filterSets = 0; shadowSets = 0; },

    save() { journal?.push('save'); },
    restore() { journal?.push('restore'); },
    beginPath() { journal?.push('beginPath'); },
    closePath() { journal?.push('closePath'); },
    fill() { journal?.push(`fill:${ctx.fillStyle}:${ctx.globalAlpha}:${ctx.globalCompositeOperation}`); },
    stroke() { journal?.push(`stroke:${ctx.strokeStyle}:${ctx.lineWidth}:${ctx.globalAlpha}`); },
    clip() {}, resetTransform() {}, setLineDash() {},

    translate: track('translate'), rotate: track('rotate'), scale: track('scale'),
    setTransform: track('setTransform'), transform: track('transform'),
    moveTo: track('moveTo'), lineTo: track('lineTo'),
    quadraticCurveTo: track('quadraticCurveTo'), bezierCurveTo: track('bezierCurveTo'),
    arc: track('arc'), arcTo: track('arcTo'), ellipse: track('ellipse'),
    rect: track('rect'), roundRect: track('roundRect'),
    fillRect: track('fillRect'), strokeRect: track('strokeRect'), clearRect: track('clearRect'),
    fillText: (s, ...rest) => note('fillText', [String(s), ...rest]),
    strokeText: (s, ...rest) => note('strokeText', [String(s), ...rest]),
    measureText: (s) => {
      const px = parseFloat((/(\d+(?:\.\d+)?)px/.exec(ctx.font) || [])[1]) || 10;
      return {
        width: String(s).length * px * 0.6,
        actualBoundingBoxAscent: px * 0.72,
        actualBoundingBoxDescent: px * 0.21,
      };
    },
    drawImage: (img, ...rest) => note('drawImage', rest),
    putImageData() {},
    getImageData: (x, y, w, h) => makeImageData(w, h),
    createImageData: (w, h) => makeImageData(w, h),
    createLinearGradient: (...a) => { note('createLinearGradient', a); return gradient; },
    createRadialGradient: (...a) => { note('createRadialGradient', a); return gradient; },
    createConicGradient: (...a) => { note('createConicGradient', a); return gradient; },
    createPattern: () => ({ setTransform() {} }),
    isPointInPath: () => false,
    isPointInStroke: () => false,
  };
  return ctx;
}

function makeImageData(w, h) {
  const width = Math.max(1, Math.round(Number.isFinite(w) ? w : 1));
  const height = Math.max(1, Math.round(Number.isFinite(h) ? h : 1));
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

globalThis.Path2D = class {
  moveTo() {} lineTo() {} rect() {} roundRect() {} closePath() {}
  arc() {} arcTo() {} ellipse() {} addPath() {}
  quadraticCurveTo() {} bezierCurveTo() {}
};

globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') return { style: {} };
    canvasesMade++;
    const canvas = { width: 300, height: 150, style: {} };
    canvas.getContext = () => recordingContext(() => {}, null);
    return canvas;
  },
};

/**
 * `Math.random` is a trap laid deliberately.
 *
 * The first rule of writing an effect here is not to call it: each projector
 * tab runs its own copy of the code, so an unseeded number makes two projectors
 * covering the same wall draw two different animations onto it. That is
 * invisible on one machine, invisible in review, and glaring on the night. So
 * rather than trusting the rule, this replaces the function and writes down who
 * touched it.
 */
export const randomCallers = new Set();

/**
 * And the wall clock, stopped.
 *
 * Two effects here read the actual time of day on purpose — a clock face that
 * is a minute out is worse than no clock face — and two tabs reading the same
 * wall clock is exactly how they agree on the night. What they cannot agree on
 * is two runs of a test a few microseconds apart, so the clock is pinned for
 * the duration and "two tabs draw the same frame" goes back to meaning what it
 * is supposed to mean. Pinned at a minute to midnight on New Year's Eve, which
 * is the moment those two effects have the most to say.
 */
const FROZEN_CLOCK = Date.UTC(2026, 11, 31, 23, 59, 2);
Date.now = () => FROZEN_CLOCK;

let currentEffect = '';
const realRandom = Math.random;
Math.random = () => {
  randomCallers.add(currentEffect);
  return realRandom();
};

/* ------------------------------------------------------------------ *
 * The shapes
 * ------------------------------------------------------------------ */

export function makeShape(points, { closed = true, id = 's1', tags = ['window'], smooth = false } = {}) {
  return {
    id,
    name: id,
    tags,
    closed,
    smooth,
    points,
    path: new globalThis.Path2D(),
    bbox: boundingBox(points),
    centroid: closed && points.length > 2 ? polygonCentroid(points) : boundingBox(points),
    sampler: buildPathSampler(points, closed),
  };
}

export const box = (x, y, w, h) => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];

/**
 * Every shape a project can actually contain, including the ones nobody meant.
 *
 * The names are the case each one stands for. `frame` is what the renderer
 * substitutes for a layer with no targets, so it is the commonest shape in the
 * library by a distance and it is here to make sure the awkward ones are being
 * compared against something that definitely works.
 */
export const SHAPES = {
  frame: makeShape(box(0, 0, 1920, 1080), { id: 'frame', tags: [] }),
  window: makeShape(box(300, 200, 400, 500)),
  /** A gutter line: full width, almost no height. */
  gutter: makeShape(box(0, 240, 1920, 3), { id: 'gutter', tags: ['roof'] }),
  /** A downpipe: almost no width. */
  pipe: makeShape(box(880, 0, 4, 1080), { id: 'pipe', tags: ['trim'] }),
  /** Traced at one zoom level and looked at from another. */
  tiny: makeShape(box(500, 500, 1, 1), { id: 'tiny' }),
  /** Every point dragged onto the same spot. */
  collapsed: makeShape(box(500, 500, 0, 0), { id: 'collapsed' }),
  /** An open path, which has no inside at all. */
  path: makeShape([{ x: 100, y: 900 }, { x: 900, y: 940 }, { x: 1700, y: 900 }],
    { closed: false, id: 'path', tags: ['path'] }),
  /** A path somebody started and did not finish. */
  stub: makeShape([{ x: 100, y: 100 }], { closed: false, id: 'stub' }),
  /** A shape whose points were all deleted but which is still in the project. */
  empty: makeShape([], { closed: false, id: 'empty' }),
  /** Three points on a line: closed, but with no area. */
  collinear: makeShape([{ x: 0, y: 500 }, { x: 400, y: 500 }, { x: 800, y: 500 }],
    { id: 'collinear' }),
  /** Off the top-left of the frame, which is legal — world space is unbounded. */
  offscreen: makeShape(box(-800, -600, 300, 300), { id: 'offscreen' }),
  /** Traced against a much larger camera frame. */
  huge: makeShape(box(-2000, -2000, 9000, 7000), { id: 'huge' }),
  /** Wound the other way round, which a right-to-left trace produces. */
  reversed: makeShape(box(300, 200, 400, 500).reverse(), { id: 'reversed' }),
  /** Smoothed, so the renderer would hand over a resampled outline. */
  smoothed: makeShape(box(600, 300, 500, 300), { id: 'smoothed', smooth: true }),
};

export const SCENE = [
  makeShape(box(320, 220, 120, 140), { id: 'other1', tags: ['window'] }),
  makeShape(box(900, 640, 160, 300), { id: 'other2', tags: ['door'] }),
  makeShape(box(0, 300, 1920, 600), { id: 'other3', tags: ['wall'] }),
  makeShape([{ x: 0, y: 240 }, { x: 1920, y: 236 }], { closed: false, id: 'other4', tags: ['roof'] }),
];

/**
 * The whole of a draw context, with the awkward values in it rather than the
 * comfortable ones: a live microphone, a beat, a shape that is one of several.
 */
export function context(effect, shape, { g, t, state, rng, journal, p: override }) {
  /**
   * The defaults, unless the caller has something else in mind.
   *
   * `robustness` runs every effect as a new layer would arrive with it, which
   * is the case that matters most and is not the only one: `params` runs the
   * same effects with each slider at its own ends, where a divisor that is
   * merely small at the default is zero.
   */
  const p = override ? { ...override } : { ...defaultParams(effect.id) };
  return {
    g, p, stable: p, shape,
    shapes: (tag, exclude) => {
      const wanted = String(tag || '').trim().toLowerCase();
      return SCENE
        .filter((s) => !wanted || (s.tags || []).some((v) => String(v).toLowerCase() === wanted))
        .filter((s) => s.id !== exclude);
    },
    i: 1, n: 3,
    t, age: t, dt: 1 / 60,
    beat: t * 2, beatPhase: (t * 2) % 1, bpm: 120,
    audio: { level: 0.42, low: 0.6, mid: 0.3, high: 0.15 },
    world: { w: 1920, h: 1080 },
    layer: { id: 'L1', name: 'test' },
    state,
    noise: defaultNoise,
    rng,
    media: () => null,
    camera: () => null,
    preview: false,
    share: new Map(),
    depth: null,
  };
}

/**
 * Run one effect over one shape the way the renderer does, and hand back what
 * it did wrong.
 *
 * `journal` records the drawing calls when asked, which is what the determinism
 * check compares. Off by default: it is a string per call and the sweep below
 * makes a few hundred thousand of them.
 */
export function exercise(effect, shape, { seconds = 1.5, seed = 'rob', journal = null, p = null } = {}) {
  const bad = [];
  const seen = new Set();
  const g = recordingContext((fn, args) => {
    if (seen.has(fn)) return;
    seen.add(fn);
    bad.push(`${fn}(${args.join(',')})`);
  }, journal);

  const state = {};
  let threw = null;
  currentEffect = effect.id;

  try {
    if (effect.init) {
      Object.assign(state, effect.init(
        context(effect, shape, { g: null, t: 0, state, rng: makeRng(`${seed}#0`) })
      ) || {});
    }
    const steps = Math.round(seconds * 60);
    if (effect.step) {
      for (let i = 1; i <= steps; i++) {
        effect.step(context(effect, shape, {
          g: null, t: i / 60, state, rng: makeRng(`${seed}#${i}`), p,
        }));
      }
    }
    for (const t of [0, 1 / 60, seconds, seconds + 7.77]) {
      g.resetCounters();
      effect.draw(context(effect, shape, {
        g, t, state, rng: makeRng(`${seed}~${t}`), journal, p,
      }));
      if (g.expensiveSets > EXPENSIVE_LIMIT) {
        bad.push(`${g.expensiveSets} filter/shadow changes in one frame`);
        break;
      }
    }
  } catch (err) {
    threw = `${err.message} (${(err.stack || '').split('\n')[1]?.trim() || '?'})`;
  }
  currentEffect = '';
  return { bad, threw, state, g };
}

/**
 * How many times one draw may set `filter` or `shadowBlur` to something.
 *
 * Both are per-*layer* operations in every browser: each one renders the thing
 * it applies to into its own surface and composites it back, at a cost of
 * roughly a third of a millisecond. That is fine once for a whole effect and
 * catastrophic once per particle — twenty a frame is already most of a frame's
 * budget. Sixteen leaves room for an effect that softens a handful of passes
 * and still catches anything doing it inside a loop.
 */
export const EXPENSIVE_LIMIT = 16;

/* ------------------------------------------------------------------ *
 * Handles on the things the stand-ins count
 * ------------------------------------------------------------------ */

/** Canvases handed out by the stand-in `document`, since the module opened. */
export function canvasCount() {
  return canvasesMade;
}

/**
 * Whose fault the next `Math.random()` is.
 *
 * `exercise` sets this itself; a suite driving an effect by hand — the warm
 * allocation check — has to say so, or an unseeded call is filed against
 * whichever effect ran last.
 */
export function trackEffect(id) {
  currentEffect = id || '';
}

/** Put `Math.random` back, once a suite has finished with the library. */
export function restoreRandom() {
  Math.random = realRandom;
}
