/**
 * Bees, and the line each one leaves behind it.
 *
 * The effect is not really about the animal — nobody at the end of a garden can
 * resolve a striped body two inches long. What carries is the *flight*, and the
 * flight is drawn as a dashed line of where the bee has just been. Which makes
 * the trail the whole effect, and the trail is *remembered* rather than derived
 * from `t`, so it is exactly the kind of thing that goes wrong quietly:
 *
 *   - a ring buffer that is not really bounded is a leak on the machine driving
 *     the projectors, and nothing on screen ever says so;
 *   - a bee that flies out of frame and is teleported back leaves a seam
 *     straight across the wall, which looks like a bug in the clip rather than
 *     a bug in the bee;
 *   - a dash pattern that restarts at each fade band draws five dashed lines
 *     that happen to touch, rather than one stitched line;
 *   - and a flock cast on the first frame *drawn* rather than the first frame
 *     *simulated* puts a different swarm on every projector covering the same
 *     wall, which is invisible until there are two of them.
 *
 * Each of those is one check below. Finiteness, determinism and the no-canvas
 * rule are `robustness.test.mjs` and `params.test.mjs`; this is about what the
 * bees actually do.
 *
 *   node test/bees.test.mjs
 */

import { getEffect, defaultParams } from '../js/effects/registry.js';
import { makeRng } from '../js/core/math.js';
import { defaultNoise } from '../js/core/noise.js';
import { SHAPES, context } from './effectHarness.mjs';

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

const bees = getEffect('bees');

/* ------------------------------------------------------------------ *
 * A context that writes down the trail it was asked to stroke
 * ------------------------------------------------------------------ */

function tracer() {
  /** One entry per `stroke()`: its points and the dash phase it began at. */
  const strokes = [];
  let dash = [];
  let at = null;
  let current = null;

  const start = () => {
    current = { points: [], offset: ctx.lineDashOffset, dash: dash.slice() };
  };

  const ctx = {
    canvas: { width: 1920, height: 1080 },
    fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1, lineWidth: 1,
    globalCompositeOperation: 'source-over', lineCap: 'butt', lineJoin: 'miter',
    lineDashOffset: 0, filter: 'none', shadowBlur: 0, font: '10px sans-serif',
    /** Everything drawn while the transform is pushed, so bees are separable. */
    translations: [],

    save() {}, restore() {}, clip() {},
    setLineDash(pattern) { dash = pattern.slice(); },
    beginPath() { start(); },
    closePath() {},
    moveTo(x, y) { at = { x, y }; current?.points.push({ x, y, move: true }); },
    lineTo(x, y) { at = { x, y }; current?.points.push({ x, y, move: false }); },
    stroke() {
      if (current && current.points.length) strokes.push(current);
      start();
    },
    fill() {},
    translate(x, y) { ctx.translations.push({ x, y }); },
    rotate() {}, scale() {},
    ellipse() {}, arc() {}, rect() {}, roundRect() {},
    quadraticCurveTo(cx, cy, x, y) { at = { x, y }; },
    bezierCurveTo(a, b, c, d, x, y) { at = { x, y }; },
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    drawImage() {}, fillText() {}, fillRect() {},
    get here() { return at; },
    get strokes() { return strokes; },
    reset() { strokes.length = 0; ctx.translations.length = 0; },
  };
  return ctx;
}

/** Run the effect the way the renderer does and hand back what happened. */
function fly(shape, { seconds = 6, p: overrides = {}, seed = 'bee' } = {}) {
  const p = { ...defaultParams('bees'), ...overrides };
  const g = tracer();
  const state = {};
  const at = (t, gg, step) =>
    Object.assign(context(bees, shape, { g: gg, t, state, rng: makeRng(`${seed}#${step}`), p }), { p, stable: p });

  Object.assign(state, bees.init(at(0, null, 0)) || {});
  const steps = Math.round(seconds * 60);
  /** Where each bee was on each step, so a departure can be seen. */
  const track = [];
  for (let i = 1; i <= steps; i++) {
    bees.step(at(i / 60, null, i));
    if (state.bees) track.push(state.bees.map((b) => ({ x: b.x, y: b.y })));
  }
  g.reset();
  bees.draw(at(seconds, g, steps));
  return { state, g, track, p };
}

/* ------------------------------------------------------------------ *
 * The flock is cast where every tab agrees about it
 * ------------------------------------------------------------------ */

console.log('— casting the flock —');

{
  const p = { ...defaultParams('bees') };
  const state = bees.init({ p });
  ok('nothing exists before the first step', !state.bees);

  const shape = SHAPES.window;
  const ctx = Object.assign(
    context(bees, shape, { g: null, t: 1 / 60, state, rng: makeRng('cast#1') }),
    { p, stable: p }
  );
  bees.step(ctx);

  /**
   * On step one, not on the first frame painted. `rng` is seeded from the
   * simulation step, so a flock cast from `draw` is cast from whichever step
   * that tab's first frame happened to land on — and two projectors covering
   * one wall then show two different swarms.
   */
  ok('and the whole flock is there after one step',
    state.bees?.length === Math.round(p.count), `${state.bees?.length} bees`);
  ok('each with its own ring buffer, already at full size',
    state.bees.every((b) => b.xs.length === b.ys.length && b.xs.length > 1),
    `${state.bees[0].xs.length} samples`);
}

/* ------------------------------------------------------------------ *
 * The buffer is bounded, whatever the evening does
 * ------------------------------------------------------------------ */

console.log('\n— an evening of it —');

{
  const short = fly(SHAPES.frame, { seconds: 4 });
  const size = short.state.bees[0].xs.length;
  const long = fly(SHAPES.frame, { seconds: 90 });

  ok('the trail buffer does not grow with the length of the show',
    long.state.bees.every((b) => b.xs.length === size && b.ys.length === size),
    `${long.state.bees[0].xs.length} vs ${size}`);
  ok('and neither does the count of live samples',
    long.state.bees.every((b) => b.filled <= size),
    `${long.state.bees[0].filled} filled`);
  ok('the buffer does fill up, so the trail is as long as it claims',
    long.state.bees.every((b) => b.filled === size));
  ok('and the write head stays inside it',
    long.state.bees.every((b) => b.head >= 0 && b.head < size));
}

/* ------------------------------------------------------------------ *
 * They explore, then they go, then they come back
 * ------------------------------------------------------------------ */

console.log('\n— leaving —');

{
  const shape = SHAPES.window;
  const { bbox } = shape;
  const reach = Math.hypot(bbox.w, bbox.h);
  const { track } = fly(shape, { seconds: 30, p: { count: 1, linger: 4, away: 4, speed: 1 } });

  const inside = (pt) =>
    pt.x >= bbox.x && pt.x <= bbox.x + bbox.w && pt.y >= bbox.y && pt.y <= bbox.y + bbox.h;
  const far = (pt) =>
    Math.hypot(pt.x - (bbox.x + bbox.w / 2), pt.y - (bbox.y + bbox.h / 2)) > reach * 0.75;

  const home = track.filter((f) => inside(f[0])).length;
  const gone = track.filter((f) => far(f[0])).length;
  ok('a bee spends time on the wall', home > track.length * 0.2, `${home} of ${track.length} steps`);
  ok('and time well clear of it', gone > track.length * 0.1, `${gone} of ${track.length} steps`);

  /**
   * It flies out and flies back rather than being put back. A teleport is the
   * cheap way to do this and it draws a straight line across the whole wall the
   * moment the trail is longer than the gap.
   */
  const hop = track.slice(1).reduce((worst, frame, i) =>
    Math.max(worst, Math.hypot(frame[0].x - track[i][0].x, frame[0].y - track[i][0].y)), 0);
  ok('with no step big enough to be a teleport',
    hop < reach * 0.2, `biggest single step ${hop.toFixed(1)}px against a ${reach.toFixed(0)}px shape`);

  const returned = track.slice(Math.floor(track.length * 0.6)).some((f) => inside(f[0]));
  ok('and it comes back', returned);
}

/* ------------------------------------------------------------------ *
 * The line itself
 * ------------------------------------------------------------------ */

console.log('\n— the dashed line —');

{
  const { g, state, p } = fly(SHAPES.frame, { seconds: 8, p: { count: 1, memory: 3 } });
  const strokes = g.strokes;
  ok('the trail is stroked in fading bands', strokes.length > 1, `${strokes.length} bands`);

  /**
   * Each band picks up where the last one left off. A gap here is a visible
   * break in the line; an overlap is a double-stroked segment that reads as a
   * blob at every band boundary.
   */
  let joined = true;
  for (let i = 1; i < strokes.length; i++) {
    const end = strokes[i - 1].points.at(-1);
    const begin = strokes[i].points[0];
    if (Math.hypot(end.x - begin.x, end.y - begin.y) > 1e-9) joined = false;
  }
  ok('and the bands meet exactly, so the line has no break in it', joined);

  const period = Math.max(0.5, p.dash) + Math.max(0.5, p.gap);
  let phase = 0;
  let carried = true;
  for (const band of strokes) {
    if (Math.abs(band.offset - (phase % period)) > 1e-6) carried = false;
    for (let i = 1; i < band.points.length; i++) {
      phase += Math.hypot(
        band.points[i].x - band.points[i - 1].x,
        band.points[i].y - band.points[i - 1].y
      );
    }
  }
  /**
   * The stitch is one pattern along the whole trail. Without carrying the phase
   * across the bands each one restarts on a dash, and five dashed lines that
   * happen to touch is not a dashed line.
   */
  ok('the dash pattern carries across the joins rather than restarting', carried);

  const dashes = strokes.every((s) => s.dash.length === 2 && s.dash.every((n) => n > 0));
  ok('and it is dashed at all', dashes, JSON.stringify(strokes[0]?.dash));

  const drawn = strokes.reduce((n, s) => n + s.points.length, 0) - (strokes.length - 1);
  const wanted = Math.min(state.bees[0].filled, Math.round(p.memory * 30));
  ok('the drawn line is as many seconds long as Trail says',
    Math.abs(drawn - wanted) <= strokes.length, `${drawn} points, wanted about ${wanted}`);

  const head = strokes.at(-1).points.at(-1);
  const bee = state.bees[0];
  ok('and its head is where the bee is',
    Math.hypot(head.x - bee.x, head.y - bee.y) < 60,
    `${Math.hypot(head.x - bee.x, head.y - bee.y).toFixed(1)}px behind`);
}

{
  // Trail shorter than the buffer: the line is trimmed rather than the buffer.
  const brief = fly(SHAPES.frame, { seconds: 8, p: { count: 1, memory: 0.5 } });
  const longer = fly(SHAPES.frame, { seconds: 8, p: { count: 1, memory: 3 } });
  const points = (r) => r.g.strokes.reduce((n, s) => n + s.points.length, 0);
  ok('a shorter Trail draws less of the same buffer',
    points(brief) < points(longer)
      && brief.state.bees[0].filled === longer.state.bees[0].filled,
    `${points(brief)} vs ${points(longer)} points`);
}

{
  // A shape with no room in it draws nothing rather than a line through zero.
  const flat = fly(SHAPES.collapsed, { seconds: 2 });
  ok('a collapsed shape gets no bees and no line',
    flat.g.strokes.length === 0 && !flat.state.bees);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
