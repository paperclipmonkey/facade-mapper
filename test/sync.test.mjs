/**
 * Do two tabs paint the same show?
 *
 * A projector tab and the control tab render the same project from the same
 * broadcast clock, but at whatever frame rate each can manage — and where two
 * projectors overlap on one wall, any disagreement between them is visible as
 * two animations fighting over the same brickwork.
 *
 * So this drives the *real* renderer to the same show time at several frame
 * rates and compares what came out of the far end. Not the internal state: the
 * sequence of drawing operations, because that is the thing the wall sees.
 *
 * Three mechanisms used to make this fail, and there is a test below for each:
 * a random generator whose position was a count of frames drawn, a simulation
 * integrated with whatever `dt` the tab managed, and a layer age measured from
 * the first frame that particular tab happened to draw.
 *
 *   node test/sync.test.mjs
 */

import { createWorldRenderer } from '../js/render/worldRenderer.js';
import { createProject, createLayer, createShape } from '../js/core/state.js';
import { defaultParams, listEffects } from '../js/effects/registry.js';

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

/* ------------------------------------------------------------------ *
 * A canvas that writes down everything it is told to do
 * ------------------------------------------------------------------ */

const round = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);

function recordingContext(log, label) {
  const note = (op, ...args) => log.push(`${label}:${op}(${args.map(round).join(',')})`);
  const ctx = {
    canvas: { width: 640, height: 360 },
    fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1, filter: 'none',
    globalCompositeOperation: 'source-over', lineWidth: 1, lineCap: 'butt',
    lineJoin: 'miter', shadowBlur: 0, shadowColor: '', font: '', textAlign: 'start',
    textBaseline: 'alphabetic', lineDashOffset: 0, miterLimit: 10,
    save() {}, restore() {}, clip() {}, beginPath() {}, closePath() {},
    setLineDash() {}, resetTransform() {}, setTransform() {}, transform() {},
    save2() {},
    translate: (...a) => note('translate', ...a),
    rotate: (...a) => note('rotate', ...a),
    scale: (...a) => note('scale', ...a),
    moveTo: (...a) => note('moveTo', ...a),
    lineTo: (...a) => note('lineTo', ...a),
    quadraticCurveTo: (...a) => note('quadTo', ...a),
    bezierCurveTo: (...a) => note('bezTo', ...a),
    arc: (...a) => note('arc', ...a),
    arcTo: (...a) => note('arcTo', ...a),
    ellipse: (...a) => note('ellipse', ...a),
    rect: (...a) => note('rect', ...a),
    roundRect: (...a) => note('roundRect', ...a),
    fillRect: (...a) => note('fillRect', ...a, ctx.fillStyle, round(ctx.globalAlpha)),
    strokeRect: (...a) => note('strokeRect', ...a, ctx.strokeStyle),
    clearRect() {},
    fill: () => note('fill', ctx.fillStyle, round(ctx.globalAlpha)),
    stroke: () => note('stroke', ctx.strokeStyle, round(ctx.lineWidth)),
    fillText: (...a) => note('fillText', ...a),
    strokeText: (...a) => note('strokeText', ...a),
    measureText: () => ({ width: 42 }),
    drawImage: () => note('drawImage'),
    putImageData() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    createImageData: () => ({ data: new Uint8ClampedArray(4) }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createPattern: () => null,
  };
  return ctx;
}

/**
 * The bits of the DOM the renderer and the effects reach for.
 *
 * Offscreen canvases are given their own log, because several effects bake into
 * one and a difference there is a difference on the wall just as much.
 */
function installDom(bakeLog) {
  let offscreen = 0;
  globalThis.document = {
    createElement(tag) {
      if (tag !== 'canvas') return {};
      const id = `off${offscreen++}`;
      const c = recordingContext(bakeLog, id);
      return { width: 0, height: 0, getContext: () => c, tagName: 'CANVAS' };
    },
  };
  globalThis.Path2D = class Path2D {
    moveTo() {} lineTo() {} closePath() {} rect() {} arc() {} ellipse() {}
    quadraticCurveTo() {} bezierCurveTo() {} addPath() {}
  };
  globalThis.OffscreenCanvas = undefined;
}

/* ------------------------------------------------------------------ *
 * One tab
 * ------------------------------------------------------------------ */

const SHAPE = [
  { x: 0.08, y: 0.2 }, { x: 0.62, y: 0.2 }, { x: 0.62, y: 0.86 }, { x: 0.08, y: 0.86 },
];

function projectWith(effectId, params, extra = {}) {
  const project = createProject('sync');
  const shape = createShape(SHAPE, { name: 'Wall' });
  shape.tags = ['wall'];
  project.shapes = [shape];
  const layer = createLayer(effectId, {
    targets: [shape.id],
    params: { ...defaultParams(effectId), ...params },
    ...extra,
  });
  project.layers = [layer];
  return project;
}

/**
 * Render a project from show time zero to `until` in steps of 1/fps, and hand
 * back everything the last frame drew.
 *
 * `startAt` simulates a tab opened part-way through: the renderer is created
 * fresh at that point, exactly as a projector tab opened mid-show would be, but
 * the clock carries on from where the show actually is.
 */
function runTab(project, { until = 5, fps = 60, jitterSeed = null, startAt = 0 } = {}) {
  /**
   * Two logs, compared differently, because they answer different questions.
   *
   * `frame` is what the projector puts on the wall this instant, so only the
   * last frame's worth of it is compared — that is the picture two tabs have to
   * agree on.
   *
   * `bake` is everything written into an offscreen cache, and it accumulates
   * across the whole run. Which *frame* a cache gets filled on legitimately
   * depends on the frame rate — an effect painting frost onto a bitmap a few
   * strokes at a time will land more strokes per frame on a slower tab. What may
   * not differ is the strokes themselves, in order, over the run.
   */
  const frame = [];
  const bake = [];
  installDom(bake);
  const renderer = createWorldRenderer({});
  const main = recordingContext(frame, 'main');

  /**
   * The instants this tab happens to render at.
   *
   * The last one is pinned to `until` for every frame rate, and that is not a
   * dodge — two real tabs never paint at the same instant either, and a picture
   * that differs by a third of a frame of animation is nobody's bug. What has to
   * match is the state they have both arrived at. Measuring them all at one
   * instant is what isolates that from the sub-frame offset.
   */
  const times = [];
  let jitter = jitterSeed;
  const rand = () => {
    jitter = (jitter * 1103515245 + 12345) & 0x7fffffff;
    return jitter / 0x7fffffff;
  };
  if (jitterSeed === null) {
    const frames = Math.round((until - startAt) * fps);
    for (let i = 1; i <= frames; i++) times.push(startAt + (i / fps) * ((until - startAt) * fps) / frames);
  } else {
    // Clamped, because a dropped frame that overshoots `until` and is then
    // followed by the measurement frame would run the show backwards — which no
    // tab does, and which some effects quite reasonably treat as a retrigger.
    let t = startAt;
    while (t < until) {
      t = Math.min(until, t + (1 / fps) * (rand() < 0.12 ? 2 : 1));
      times.push(t);
    }
  }
  if (times[times.length - 1] !== until) times.push(until);

  let last = startAt;
  for (const t of times) {
    const dt = t - last;
    last = t;
    frame.length = 0; // only the final frame's drawing is compared
    renderer.render(main, {
      project,
      time: { t, dt, beat: (t * 120) / 60, beatPhase: ((t * 2) % 1), bpm: 120, wall: t },
      audio: { level: 0, low: 0, mid: 0, high: 0 },
      region: { x: 0, y: 0, w: 1, h: 1 },
      pixelSize: { w: 640, h: 360 },
    });
  }
  return [...frame, ...bake].join('\n');
}

const firstDifference = (a, b) => {
  const x = a.split('\n');
  const y = b.split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) return `line ${i + 1}: ${JSON.stringify(x[i] ?? '—')} vs ${JSON.stringify(y[i] ?? '—')}`;
  }
  return '';
};

/**
 * The whole point, as one assertion: the same project at the same show time
 * must paint the same picture however many frames the tab got through.
 */
function agreesAcrossFrameRates(label, project, { until = 5, rates = [60, 50, 30, 24], quiet = false } = {}) {
  const reference = runTab(project, { until, fps: rates[0] });
  const runs = [
    ...rates.slice(1).map((fps) => [`${fps}fps`, runTab(project, { until, fps })]),
    ['frames dropped', runTab(project, { until, fps: rates[0], jitterSeed: 7 })],
  ];
  const bad = runs.find(([, out]) => out !== reference);

  if (quiet) {
    const ops = reference ? reference.split('\n').length : 0;
    ok(`${label} (${ops} ops)`, !bad, bad ? `differs at ${bad[0]} — ${firstDifference(reference, bad[1])}` : '');
    return;
  }
  ok(`${label}: draws something at all`, reference.length > 0);
  for (const [name, out] of runs) {
    ok(`${label}: ${rates[0]}fps === ${name}`, out === reference, firstDifference(reference, out));
  }
}

/* ------------------------------------------------------------------ *
 * The effects that carry state
 * ------------------------------------------------------------------ */

/**
 * Every effect in the library, not a chosen few.
 *
 * A list of the ones known to accumulate would be a list that goes stale the
 * first time somebody writes an effect and forgets to add it — and the failure
 * mode is invisible on one screen and only shows up outdoors, on a house, where
 * two projectors overlap. Sweeping the registry means a new effect is covered by
 * this test on the day it is written.
 */
const OVERRIDES = {
  // Turned up so the interesting machinery actually fires inside the window.
  breach: { rate: 40, holes: 4, match: false, arms: 2 },
  'bat-burst': { duration: 6 },
  'spark-burst': { duration: 6 },
};

console.log('— every effect, at four frame rates —\n');
/**
 * Effects that read the wall clock rather than the show clock.
 *
 * A countdown to Hallowe'en is counting down to a real moment, so `Date.now()`
 * is the right thing for it to read — and it means two runs of this harness,
 * milliseconds apart, are legitimately counting down to slightly different
 * numbers. There is nothing here to hold still, so comparing two runs of it
 * measures the harness rather than the effect.
 *
 * Worth stating rather than quietly skipping: these do differ very slightly
 * between tabs, by however far apart the two tabs read the clock. That is
 * sub-frame and it is what a countdown is supposed to do.
 */
const WALL_CLOCK = new Set(['countdown']);

const skipped = [];
for (const effect of listEffects().sort((a, b) => a.id.localeCompare(b.id))) {
  // Media and camera effects need a source this harness has no way to provide,
  // and report themselves as drawing nothing rather than as disagreeing.
  if (effect.category === 'media' || WALL_CLOCK.has(effect.id)) {
    skipped.push(effect.id);
    continue;
  }
  agreesAcrossFrameRates(effect.id, projectWith(effect.id, OVERRIDES[effect.id] || {}), { quiet: true });
}
if (skipped.length) console.log(`\n  (skipped — no source to draw from, or driven by the wall clock: ${skipped.join(', ')})`);

/* ------------------------------------------------------------------ *
 * A tab that opened late
 * ------------------------------------------------------------------ */

console.log('— a layer that has been on since the show started —\n');
{
  /**
   * A one-shot is the sharpest instrument for this. Its whole behaviour is a
   * function of `age`, and it has an `duration` after which it is over — so a
   * tab that thinks the layer just came on paints a burst, and a tab that knows
   * it fired twenty seconds ago paints nothing.
   *
   * That was exactly the failure: open a projector tab mid-evening and every
   * one-shot in the show went off again, on the house, for no reason.
   */
  const project = projectWith('shockwave', { duration: 2 });
  const throughout = runTab(project, { until: 20, fps: 60, startAt: 0 });
  const justOpened = runTab(project, { until: 20, fps: 60, startAt: 19.8 });

  ok('a burst has finished by t=20 in a tab that watched it fire',
    throughout.length === 0, `${throughout.split('\n').filter(Boolean).length} ops`);
  ok('and a tab opened at t=19.8 does not replay it',
    justOpened === throughout, firstDifference(throughout, justOpened));

  // And the same burst, seen from the start, does draw — otherwise the test
  // above would pass on an effect that never draws anything at all.
  const during = runTab(project, { until: 1, fps: 60, startAt: 0 });
  ok('while it is still running, it draws', during.length > 0,
    `${during.split('\n').filter(Boolean).length} ops at t=1`);
}

/* ------------------------------------------------------------------ *
 * A layer switched on part-way through the show
 * ------------------------------------------------------------------ */

console.log('\n— a layer switched on mid-show —\n');
{
  /**
   * `onAt` is a wall-clock stamp and `age` is derived from it against the show
   * clock. Those are two different measurements of the same instant, and the
   * difference between them jitters by a millisecond or so every frame.
   *
   * Treated strictly, that jitter reads as "the layer was just switched on
   * again" — so the simulation restarts from step zero on every single frame and
   * a stateful effect never gets past its first sixtieth of a second. It draws
   * nothing, for ever, and nothing in the interface explains why.
   */
  const project = projectWith('breach', { rate: 40, holes: 4, match: false, arms: 2 });
  const layer = project.layers[0];

  // Switched on ten seconds into the show, recorded the way the control tab
  // records it — and then read back through a clock that disagrees very slightly
  // about what time it is, frame to frame, as two clocks do.
  const EPOCH = 1_780_000_000;
  layer.onAt = (EPOCH + 10) * 1000;

  const log = [];
  const bake = [];
  installDom(bake);
  const renderer = createWorldRenderer({});
  const main = recordingContext(log, 'main');
  let jitter = 12345;
  const wobble = () => {
    jitter = (jitter * 1103515245 + 12345) & 0x7fffffff;
    return ((jitter / 0x7fffffff) - 0.5) * 0.004;   // ±2ms, as two clocks drift
  };
  for (let i = 1; i <= 60 * 20; i++) {
    const t = i / 60;
    log.length = 0;
    renderer.render(main, {
      project,
      time: { t, dt: 1 / 60, beat: t * 2, beatPhase: (t * 2) % 1, bpm: 120, wall: EPOCH + t + wobble() },
      audio: { level: 0, low: 0, mid: 0, high: 0 },
      region: { x: 0, y: 0, w: 1, h: 1 },
      pixelSize: { w: 640, h: 360 },
    });
  }
  /**
   * Compared against the same layer on since the start, seen at the same age.
   *
   * A bare "did it draw anything" would not have caught this: with the
   * simulation resetting every frame the effect still paints its first frame
   * over and over, so it draws a little and looks alive. What it cannot do is
   * accumulate — and against a reference that has run the same ten seconds
   * properly, that shows up as an order of magnitude.
   */
  const reference = runTab(projectWith('breach', { rate: 40, holes: 4, match: false, arms: 2 }),
    { until: 10, fps: 60 }).split('\n').filter(Boolean).length;
  ok('it accumulates like a layer that has run the same ten seconds',
    log.length > reference * 0.4,
    `${log.length} ops against ${reference} for an equally old layer`);
}

/* ------------------------------------------------------------------ *
 * A tab opened long after the show started
 * ------------------------------------------------------------------ */

console.log('\n— a projector tab opened hours into the evening —\n');
{
  /**
   * The case the fixed-step scheme used to give up on.
   *
   * Catching up was allowed ten seconds and no more; past that the instance
   * started cold, a second and a half old. For a one-shot that is invisible —
   * it has nothing to remember. For anything that accumulates it is the entire
   * picture, and it is what "the preview looks great but the projector tab is
   * doing something different" turned out to be: the projector grew its own
   * ivy from bare brick, hours behind the wall the control tab was showing, and
   * the two never converged because nothing ever brought them back together.
   *
   * Both effects here are chosen for having a history rather than a state: a
   * vine is *only* where it has been, and a breach opens its first hole nine
   * seconds in, so a cold-started tab paints nothing at all to begin with.
   */
  for (const [id, params] of [['vine', {}], ['breach', { rate: 30, holes: 2, arms: 1 }]]) {
    const project = projectWith(id, params);
    const throughout = runTab(project, { until: 45, fps: 60, startAt: 0 });
    const justOpened = runTab(project, { until: 45, fps: 60, startAt: 43 });
    ok(`${id}: a tab opened two seconds ago paints the same wall as one open all along`,
      justOpened === throughout, firstDifference(throughout, justOpened));
    ok(`${id}: and there is something on the wall to compare`,
      throughout.split('\n').filter(Boolean).length > 50,
      `${throughout.split('\n').filter(Boolean).length} ops`);
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
