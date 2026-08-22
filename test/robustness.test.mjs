/**
 * Every effect in the library, against everything a traced shape can be.
 *
 * The rest of the test suite checks that particular effects make the claims
 * they say they make. This one is the opposite: it makes no claim about any
 * effect in particular, and instead holds all eighty-odd of them to the small
 * number of rules that apply to every one — the rules in
 * docs/writing-effects.md, which until now were enforced by nothing but the
 * author remembering them.
 *
 * The shapes matter as much as the rules. Real projects contain shapes nobody
 * would think to write a test for, because they are not shapes anybody *drew*:
 * a polygon whose points somebody dragged onto each other, an open path of one
 * point left behind by a mis-click, an outline traced against a camera frame
 * that has since been swapped for a portrait one. None of those are errors the
 * app should refuse — they are just geometry — and every one of them ends up
 * inside `draw` as a bounding box with a zero in it. An effect that divides by
 * that puts NaN into a path, and a canvas given NaN silently draws nothing at
 * all: the layer vanishes, the list says it is running, and there is no
 * message anywhere.
 *
 * What is checked, for every effect and every shape:
 *
 *   - it does not throw
 *   - nothing it hands the canvas is NaN or Infinity
 *   - it never calls `Math.random()`, which would make two projectors disagree
 *   - it does not set a filter or a shadow per particle, which costs a frame
 *   - it stops allocating canvases once it is warm
 *   - two runs of it draw exactly the same thing
 *
 * And the effect *schema* is checked too: ids unique, categories real, defaults
 * inside their own ranges. A select whose default is not one of its options is
 * a control that starts on a value it will not let you choose again.
 *
 *   node test/robustness.test.mjs
 */

import { listEffects, defaultParams, CATEGORIES } from '../js/effects/registry.js';
import { boundingBox, buildPathSampler, polygonCentroid, makeRng } from '../js/core/math.js';
import { defaultNoise } from '../js/core/noise.js';

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

/* ------------------------------------------------------------------ *
 * The stand-ins
 *
 * Enough DOM for an effect to do everything the contract allows: a 2D context
 * that checks its arguments, a Path2D, and a canvas factory that counts how
 * many it has been asked for.
 * ------------------------------------------------------------------ */

let canvasesMade = 0;

function recordingContext(onBadNumber, journal) {
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
const randomCallers = new Set();

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

function makeShape(points, { closed = true, id = 's1', tags = ['window'], smooth = false } = {}) {
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

const box = (x, y, w, h) => [
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
const SHAPES = {
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

const SCENE = [
  makeShape(box(320, 220, 120, 140), { id: 'other1', tags: ['window'] }),
  makeShape(box(900, 640, 160, 300), { id: 'other2', tags: ['door'] }),
  makeShape(box(0, 300, 1920, 600), { id: 'other3', tags: ['wall'] }),
  makeShape([{ x: 0, y: 240 }, { x: 1920, y: 236 }], { closed: false, id: 'other4', tags: ['roof'] }),
];

/**
 * The whole of a draw context, with the awkward values in it rather than the
 * comfortable ones: a live microphone, a beat, a shape that is one of several.
 */
function context(effect, shape, { g, t, state, rng, journal }) {
  const p = { ...defaultParams(effect.id) };
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
function exercise(effect, shape, { seconds = 1.5, seed = 'rob', journal = null } = {}) {
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
          g: null, t: i / 60, state, rng: makeRng(`${seed}#${i}`),
        }));
      }
    }
    for (const t of [0, 1 / 60, seconds, seconds + 7.77]) {
      g.resetCounters();
      effect.draw(context(effect, shape, {
        g, t, state, rng: makeRng(`${seed}~${t}`), journal,
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
const EXPENSIVE_LIMIT = 16;

/* ------------------------------------------------------------------ *
 * The schema
 * ------------------------------------------------------------------ */

console.log('— the effect schema —');

const effects = listEffects();
ok('there are effects to check', effects.length > 50, `${effects.length} effects`);

{
  const ids = effects.map((e) => e.id);
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  ok('every id is unique', duplicates.length === 0, duplicates.join(', '));

  const nameless = effects.filter((e) => !e.name || e.name === e.id);
  ok('every effect has a name a human would pick it by', nameless.length === 0,
    nameless.map((e) => e.id).join(', '));

  const undescribed = effects.filter((e) => !e.description);
  ok('and a description, since the gallery is how anybody finds it',
    undescribed.length === 0, undescribed.map((e) => e.id).join(', '));

  const uncategorised = effects.filter((e) => !CATEGORIES.includes(e.category));
  ok('and a category the list will actually show it under',
    uncategorised.length === 0, uncategorised.map((e) => `${e.id}:${e.category}`).join(', '));

  const badScope = effects.filter((e) => e.scope !== 'shape' && e.scope !== 'global');
  ok('and a scope the renderer understands', badScope.length === 0,
    badScope.map((e) => `${e.id}:${e.scope}`).join(', '));
}

{
  const problems = [];
  for (const effect of effects) {
    const keys = new Set();
    for (const param of effect.params) {
      if (keys.has(param.key)) problems.push(`${effect.id}.${param.key} is declared twice`);
      keys.add(param.key);
      if (!param.label) problems.push(`${effect.id}.${param.key} has no label`);
      if (param.default === undefined) problems.push(`${effect.id}.${param.key} has no default`);

      if (param.type === 'range' || param.type === 'number') {
        if (typeof param.default !== 'number') {
          problems.push(`${effect.id}.${param.key} defaults to ${typeof param.default}`);
        } else if (param.min !== undefined && param.default < param.min) {
          problems.push(`${effect.id}.${param.key} defaults below its own minimum`);
        } else if (param.max !== undefined && param.default > param.max) {
          problems.push(`${effect.id}.${param.key} defaults above its own maximum`);
        }
        if (param.type === 'range' && (param.min === undefined || param.max === undefined)) {
          problems.push(`${effect.id}.${param.key} is a slider with no ends`);
        }
      }

      /**
       * A select whose default is not one of its options is a control that
       * starts on a value you cannot get back to once you have moved it, and
       * the inspector shows the dropdown with nothing selected.
       */
      if (param.type === 'select' && !(param.options || []).includes(param.default)) {
        problems.push(`${effect.id}.${param.key} defaults to "${param.default}", not in its options`);
      }
      if (param.type === 'color' && !/^#[0-9a-fA-F]{3,8}$/.test(String(param.default))) {
        problems.push(`${effect.id}.${param.key} defaults to "${param.default}", which is not a hex colour`);
      }
    }
  }
  ok('every parameter is one the inspector can build a control for',
    problems.length === 0, problems.slice(0, 6).join('; '));
}

{
  // `defaultParams` is what a new layer is built from, so a parameter missing
  // from it is one the effect will only ever see as undefined.
  const missing = [];
  for (const effect of effects) {
    const defaults = defaultParams(effect.id);
    for (const param of effect.params) {
      if (!(param.key in defaults)) missing.push(`${effect.id}.${param.key}`);
    }
  }
  ok('and a new layer starts with every one of them set', missing.length === 0,
    missing.join(', '));
}

/* ------------------------------------------------------------------ *
 * The sweep
 * ------------------------------------------------------------------ */

console.log('\n— every effect, every shape —');

{
  const threw = [];
  const nonFinite = [];
  const shapeNames = Object.keys(SHAPES);

  for (const effect of effects) {
    for (const name of shapeNames) {
      const result = exercise(effect, SHAPES[name]);
      if (result.threw) threw.push(`${effect.id} on ${name}: ${result.threw}`);
      if (result.bad.length) nonFinite.push(`${effect.id} on ${name}: ${result.bad[0]}`);
    }
  }

  ok(`nothing throws on any of ${shapeNames.length} awkward shapes`,
    threw.length === 0, threw.slice(0, 4).join(' | '));

  /**
   * The quiet one.
   *
   * Canvas takes NaN without complaint and draws nothing, so an effect that
   * divides by a zero-height bounding box does not fail — it disappears, while
   * the layer list goes on saying it is running and the inspector goes on
   * offering its sliders. There is no message anywhere and nothing to search
   * for. This is the check that turns that into a line of output.
   */
  ok('and nothing hands the canvas a number that is not one',
    nonFinite.length === 0, nonFinite.slice(0, 4).join(' | '));

  ok(`covering ${effects.length * shapeNames.length} effect-and-shape pairs`, true,
    `${effects.length} × ${shapeNames.length}`);
}

/* ------------------------------------------------------------------ *
 * The three rules
 * ------------------------------------------------------------------ */

console.log('\n— the rules every effect has to keep —');

ok('no effect reaches for Math.random', randomCallers.size === 0,
  [...randomCallers].join(', '));

{
  // Already enforced inside `exercise`, which stops at the first offender; this
  // is the line that says so.
  ok(`no effect sets a filter or a shadow more than ${EXPENSIVE_LIMIT} times in a frame`,
    true, 'checked on every frame of the sweep above');
}

{
  /**
   * Warm effects stop allocating.
   *
   * Everything that pre-bakes a sprite ladder or accumulates into an offscreen
   * canvas is supposed to make it once and keep it in `state`. Making it per
   * frame is the single most expensive mistake available in this codebase —
   * a canvas allocation is a page of memory and a driver round trip — and the
   * symptom is a show that is smooth for ten seconds and then is not.
   *
   * So: run each effect until it has built whatever it builds, then count.
   */
  const rebuilders = [];
  for (const effect of effects) {
    const shape = SHAPES.window;
    const state = {};
    const g = recordingContext(() => {}, null);
    currentEffect = effect.id;
    try {
      if (effect.init) {
        Object.assign(state, effect.init(
          context(effect, shape, { g: null, t: 0, state, rng: makeRng('warm#0') })
        ) || {});
      }
      for (let i = 1; i <= 120; i++) {
        effect.step?.(context(effect, shape, {
          g: null, t: i / 60, state, rng: makeRng(`warm#${i}`),
        }));
      }
      // Warm-up draws: whatever is going to be built, build it.
      for (let i = 0; i < 4; i++) {
        effect.draw(context(effect, shape, {
          g, t: 2 + i / 60, state, rng: makeRng(`warm~${i}`),
        }));
      }
      const before = canvasesMade;
      for (let i = 0; i < 10; i++) {
        effect.draw(context(effect, shape, {
          g, t: 2.1 + i / 60, state, rng: makeRng(`warm~b${i}`),
        }));
      }
      const made = canvasesMade - before;
      if (made > 0) rebuilders.push(`${effect.id} made ${made} canvases in 10 frames`);
    } catch {
      // Throwing is the sweep's business, not this check's.
    }
    currentEffect = '';
  }
  ok('and none of them allocates a canvas once it is warm',
    rebuilders.length === 0, rebuilders.slice(0, 4).join('; '));
}

/* ------------------------------------------------------------------ *
 * Two tabs, one show
 * ------------------------------------------------------------------ */

console.log('\n— two tabs draw the same frame —');

{
  /**
   * The property the whole renderer is built around.
   *
   * Two projectors covering one wall have to paint the same animation into the
   * shared band. The renderer guarantees the *inputs* are identical — the same
   * project, the same show time, a generator reseeded from the same step index
   * — so anything that differs between two runs from those inputs is the
   * effect's own doing: a captured `Date.now()`, a counter that survives a
   * reload, an iteration over a Set built from object identity.
   *
   * Checked at a show time deliberately not zero, because half of these fade in
   * over their first second and every one of them agrees at t = 0.
   */
  const differ = [];
  for (const effect of effects) {
    const a = [];
    const b = [];
    exercise(effect, SHAPES.window, { seconds: 2, seed: 'twin', journal: a });
    exercise(effect, SHAPES.window, { seconds: 2, seed: 'twin', journal: b });
    if (a.length !== b.length) {
      differ.push(`${effect.id}: ${a.length} calls vs ${b.length}`);
      continue;
    }
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        differ.push(`${effect.id}: call ${i} is "${a[i]}" then "${b[i]}"`);
        break;
      }
    }
  }
  ok('every effect draws identically in two tabs at the same show time',
    differ.length === 0, differ.slice(0, 4).join(' | '));
}

Math.random = realRandom;

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
