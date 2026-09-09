/**
 * The wanderer, and the world behind it.
 *
 * `robustness.test.mjs` and `params.test.mjs` already hold both of these to the
 * rules every effect keeps — finite numbers, no `Math.random`, no canvas once
 * warm, the same frame in two tabs. This file is about the handful of things
 * that are specific to an *animal*, and every one of them fails silently:
 *
 *   - a gait whose stride length does not match how far the body travels puts
 *     the planted foot on a conveyor belt. It looks fine frame by frame and
 *     wrong the moment it moves, and there is no number anywhere that says so;
 *   - a tail made of springs is a differential equation with a step size, and
 *     an unstable one does not throw — it quietly leaves the frame;
 *   - a character that never stops is a patrol, not somebody, and the whole
 *     effect rests on it having somewhere else to be;
 *   - a lane picked wrongly walks an animal up the jamb of a window;
 *   - and a parallax band whose tiling period is not its own width leaves a
 *     sliver of sky sliding across the wall once a loop.
 *
 *   node test/lofi.test.mjs
 */

import { getEffect, defaultParams } from '../js/effects/registry.js';
import { gait } from '../js/effects/builtin/lofi.js';
import { makeRng, buildPathSampler, boundingBox } from '../js/core/math.js';
import { SHAPES, context } from './effectHarness.mjs';

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

const wanderer = getEffect('wanderer');
const vista = getEffect('vista');

/** A long, gently sloping gutter — the shape this is actually for. */
function gutter(y0 = 300, y1 = 320) {
  const points = [{ x: 40, y: y0 }, { x: 1880, y: y1 }];
  return {
    id: 'gutter', name: 'Roofline', tags: ['roof'], closed: false, points,
    bbox: boundingBox(points), centroid: { x: 960, y: (y0 + y1) / 2 },
    sampler: buildPathSampler(points, false), path: new Path2D(),
  };
}

/**
 * Drive `step` the way the renderer does, and hand back the state.
 *
 * `moved` and `cycles` accumulate only over the steps the animal was actually
 * walking. That is not bookkeeping for its own sake: they stop on their own
 * schedule, so totals taken over the whole run measure how long they happened
 * to stand about, and the gait check below would pass or fail on the seed.
 */
function walk(p, { shape = gutter(), steps = 600, world = { w: 1920, h: 1080 } } = {}) {
  const state = wanderer.init ? wanderer.init({}) : {};
  state.moved = 0;
  state.cycles = 0;
  for (let i = 1; i <= steps; i++) {
    const wasU = state.u;
    const wasStride = state.stride;
    wanderer.step({
      p, dt: 1 / 60, t: i / 60, state, shape, world,
      rng: makeRng(`lofi#${i}`), i: 0, n: 1, stable: p,
    });
    const paced = state.stride - wasStride;
    // Not the first step: that is the one where `start` puts them on the lane,
    // which is a jump rather than a pace.
    if (paced > 0 && i > 1) {
      state.cycles += paced;
      state.moved += Math.abs(state.u - wasU) * shape.sampler.length;
    }
  }
  return state;
}

const base = defaultParams('wanderer');

/* ------------------------------------------------------------------ *
 * The walk
 * ------------------------------------------------------------------ */

console.log('— the walk —');

{
  const { footAt } = gait;
  const out = { x: 0, lift: 0 };

  // Stance: planted, travelling backwards through the body at a constant rate.
  footAt(0, out);
  const atContact = out.x;
  footAt(0.25, out);
  const atMid = out.x;
  const midLift = out.lift;
  footAt(0.499, out);
  const atLift = out.x;

  ok('the foot is planted for the first half of the cycle', midLift === 0);
  ok('and travels backwards at a constant rate while it is',
    Math.abs(atContact - 1) < 1e-9
    && Math.abs(atMid - 0) < 1e-9
    && atLift < -0.99,
    `${atContact.toFixed(3)} -> ${atMid.toFixed(3)} -> ${atLift.toFixed(3)}`);

  footAt(0.75, out);
  ok('and lifts off the ground for the second half', out.lift > 0.99);
  footAt(0.999, out);
  ok('arriving back where it started', out.x > 0.99 && out.lift < 0.01);
}

ok('one gait cycle is exactly the ground the two feet cover',
  Math.abs(gait.GAIT_CYCLE - 4 * gait.STRIDE) < 1e-12,
  `${gait.GAIT_CYCLE} vs 4 x ${gait.STRIDE}`);

{
  /**
   * The one that matters: no slip, measured off the simulation rather than off
   * the constant.
   *
   * How far along the gutter they got, divided by how many gait cycles they
   * took to do it, has to be `GAIT_CYCLE` body heights. Anything else and the
   * planted foot is sliding — forwards if the stride is short, backwards if it
   * is long, and moonwalking either way.
   */
  const shape = gutter();
  const p = { ...base, speed: 40, size: 0.12, restless: 0, sitting: 0 };
  const state = walk(p, { shape, steps: 900 });
  const height = p.size * 1080;
  const perCycle = state.moved / state.cycles / height;

  ok('and the body covers exactly that much ground per cycle, so nothing skates',
    state.cycles > 1 && Math.abs(perCycle - gait.GAIT_CYCLE) < 1e-9,
    `${perCycle.toFixed(6)} body heights per cycle`);
}

{
  // Cadence scales with speed; stride length does not. Two speeds, same
  // distance, must be the same number of paces.
  const shape = gutter();
  const slow = walk({ ...base, speed: 20, restless: 0, sitting: 0 }, { shape, steps: 1200 });
  const fast = walk({ ...base, speed: 40, restless: 0, sitting: 0 }, { shape, steps: 600 });
  const pacePerPixel = (s) => s.cycles / s.moved;
  ok('a fast walk takes the same paces per metre as a slow one',
    Math.abs(pacePerPixel(slow) - pacePerPixel(fast)) < 1e-9,
    `${pacePerPixel(slow).toFixed(6)} vs ${pacePerPixel(fast).toFixed(6)}`);
}

/* ------------------------------------------------------------------ *
 * Where they are allowed to walk
 * ------------------------------------------------------------------ */

console.log('\n— the lane —');

{
  const shape = gutter();
  const state = walk({ ...base, speed: 400, restless: 0, sitting: 0, patrol: 'turn back' },
    { shape, steps: 1800 });
  ok('an open path is walked end to end and turned round at',
    state.u >= 0 && state.u <= 1 && Number.isFinite(state.u),
    `u=${state.u.toFixed(3)} dir=${state.dir}`);
}

{
  const state = walk({ ...base, speed: 400, restless: 0, sitting: 0, patrol: 'carry on' },
    { steps: 1800 });
  ok('and wrapped instead when it is told to carry on',
    state.u >= 0 && state.u <= 1);
}

{
  // A window is a closed outline, and its bottom edge is the sill. Walking the
  // outline itself would take them up the jamb and across the head.
  const state = walk({ ...base, speed: 30 }, { shape: SHAPES.window, steps: 300 });
  const sill = SHAPES.window.bbox.y + SHAPES.window.bbox.h;
  const at = state.lane.at(state.u);
  ok('a closed shape is walked along its sill, not round its outline',
    Math.abs(at.y - sill) < 1e-6, `y=${at.y} sill=${sill}`);
}

{
  // Nothing to walk on is not an error; it is a layer waiting for a shape.
  const empty = walk({ ...base }, { shape: SHAPES.empty, steps: 60 });
  const stub = walk({ ...base }, { shape: SHAPES.stub, steps: 60 });
  ok('and a shape with nothing to walk on gets no lane rather than a bad one',
    empty.lane === null && stub.lane === null);
}

/* ------------------------------------------------------------------ *
 * Being somebody rather than a sprite
 * ------------------------------------------------------------------ */

console.log('\n— the behaviour —');

{
  // Twenty minutes of show, sampled: they must do more than one thing.
  const shape = gutter();
  const state = wanderer.init({});
  const p = { ...base, restless: 1, sitting: 0.5 };
  const modes = new Set();
  const idles = new Set();
  for (let i = 1; i <= 60 * 60 * 20; i++) {
    wanderer.step({
      p, dt: 1 / 60, t: i / 60, state, shape, world: { w: 1920, h: 1080 },
      rng: makeRng(`lofi#${i}`), i: 0, n: 1, stable: p,
    });
    modes.add(state.mode);
    if (state.idle) idles.add(state.idle);
  }

  ok('over twenty minutes they walk, stand and sit', modes.size === 3,
    [...modes].join(', '));
  ok('and get through every idle they have', idles.size === 5, [...idles].join(', '));
  ok('and the tail is still where a tail goes',
    state.tail.every((s) => Number.isFinite(s.a) && Number.isFinite(s.v)
      && Math.abs(s.a) < 20 && Math.abs(s.v) < 40),
    state.tail.map((s) => s.a.toFixed(2)).join(' '));
}

{
  /**
   * The tail lags, which is the whole reason it is springs rather than a sine.
   *
   * Checked as a fact about the chain rather than about any one frame: while
   * they are walking, no two segments may be at the same angle, because each
   * one is chasing the one in front through a delay.
   */
  const state = walk({ ...base, speed: 60, restless: 0, sitting: 0 }, { steps: 400 });
  const angles = state.tail.map((s) => s.a);
  const spread = Math.max(...angles) - Math.min(...angles);
  ok('and it lags the hips rather than following them exactly',
    spread > 0.3, `spread ${spread.toFixed(3)} rad`);
}

{
  // A layer switched on at dusk and a tab opened at nine o'clock have to agree
  // about where on the gutter the animal is. Same steps, same state.
  const a = walk({ ...base, speed: 33 }, { steps: 1500 });
  const b = walk({ ...base, speed: 33 }, { steps: 1500 });
  ok('two tabs that ran the same simulation are in the same place',
    a.u === b.u && a.stride === b.stride && a.mode === b.mode
    && a.tail.every((s, i) => s.a === b.tail[i].a));
}


/* ------------------------------------------------------------------ *
 * Walking on the spot, with the world behind
 * ------------------------------------------------------------------ */

console.log('\n— on the spot —');

{
  /**
   * The treadmill: the animal stays where it was put and the distance goes
   * into `walked`, which is what the backdrop scrolls by. Both halves matter
   * — a walker that also drifted along the wall would leave its own world
   * behind, and a `walked` that kept counting while they sat would make the
   * woods slide past somebody sitting still.
   */
  const shape = SHAPES.window;
  const p = { ...base, travel: 'on the spot', speed: 40, start: 0.5, restless: 0, sitting: 0 };
  const state = walk(p, { shape, steps: 600 });
  ok('on the spot, they stay where they were put', Math.abs(state.u - 0.5) < 1e-9, `u=${state.u}`);
  // Paces times the ground each pace covers is the distance, and that is
  // what the world has to have scrolled by.
  // (`cycles` skips the placement step, which `walked` counts: one step's
  // worth of slack.)
  const paced = state.cycles * gait.GAIT_CYCLE * p.size * 1080;
  ok('and the distance walked goes into the scroll instead',
    state.walked > 0 && Math.abs(state.walked - paced) <= p.speed / 60 + 1e-6,
    `walked ${state.walked.toFixed(1)} px, paced ${paced.toFixed(1)} px`);

  // Sit them down and the world must stop with them.
  state.mode = 'sit';
  state.sit = 1;
  state.modeT = 0;
  state.modeFor = 1000;
  const before = state.walked;
  for (let i = 601; i <= 900; i++) {
    wanderer.step({
      p, dt: 1 / 60, t: i / 60, state, shape, world: { w: 1920, h: 1080 },
      rng: makeRng(`lofi#${i}`), i: 0, n: 1, stable: p,
    });
  }
  ok('and stops scrolling while they sit', state.walked === before);
}

{
  // The world behind is drawn by the same effect, so it needs a closed shape
  // with an area — on a roofline there is nothing to draw it into, and it
  // must simply not be there rather than be a smear along the gutter.
  const p = { ...base, backdrop: 'woods', travel: 'on the spot' };
  const state = wanderer.init({});
  wanderer.step({ p, dt: 1 / 60, t: 0.1, state, shape: SHAPES.window, world: { w: 1920, h: 1080 }, rng: makeRng('bd#1'), i: 0, n: 1, stable: p });
  wanderer.draw(context(wanderer, SHAPES.window, { g: quiet(), t: 1, state, rng: makeRng('bd~1'), p }));
  ok('a backdrop is cast behind a closed shape', !!state.scene?.bands, `${state.scene?.bands?.length} bands`);

  const open = wanderer.init({});
  wanderer.step({ p, dt: 1 / 60, t: 0.1, state: open, shape: SHAPES.path, world: { w: 1920, h: 1080 }, rng: makeRng('bd#2'), i: 0, n: 1, stable: p });
  wanderer.draw(context(wanderer, SHAPES.path, { g: quiet(), t: 1, state: open, rng: makeRng('bd~2'), p }));
  ok('and not behind an open path', !open.scene);
}

/* ------------------------------------------------------------------ *
 * The world behind
 * ------------------------------------------------------------------ */

console.log('\n— the vista —');

{
  const p = defaultParams('vista');
  const shape = SHAPES.frame;
  const state = vista.init({});
  vista.draw(context(vista, shape, { g: quiet(), t: 4, state, rng: makeRng('v#1') }));

  ok('the city is cast once, into state', Array.isArray(state.bands) && state.bands.length === p.bands,
    `${state.bands?.length} bands`);

  const first = state.bands;
  for (let i = 0; i < 8; i++) {
    vista.draw(context(vista, shape, { g: quiet(), t: 4 + i, state, rng: makeRng(`v#${i}`) }));
  }
  ok('and not re-cast on every frame', state.bands === first);

  /**
   * Modulate a parameter and the city must stay put.
   *
   * The cache is keyed on `stable`, which is what makes a brightness bound to
   * the microphone a brightness rather than a city rebuilt sixty times a
   * second. Keyed on `p` this check fails on the first frame.
   */
  for (let i = 0; i < 4; i++) {
    vista.draw(context(vista, shape, {
      g: quiet(), t: 12 + i, state, rng: makeRng(`vm#${i}`),
      p: { ...p, level: 0.4 + i * 0.1, pan: p.pan + i },
    }));
  }
  ok('even while a parameter of it is being modulated', state.bands === first);

  ok('every band is wider than the shape, so two copies cover it seamlessly',
    state.bands.every((b) => b.span * shape.bbox.w > shape.bbox.w),
    state.bands.map((b) => b.span.toFixed(2)).join(', '));

  ok('and each is laid from zero, so its span really is its tiling period',
    state.bands.every((b) => b.blocks[0].x === 0));
}

/** A context that accepts everything and remembers nothing. */
function quiet() {
  const gradient = { addColorStop() {} };
  const noop = () => {};
  return new Proxy({
    canvas: { width: 1920, height: 1080 },
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    measureText: () => ({ width: 10 }),
  }, {
    get(target, key) {
      if (key in target) return target[key];
      return noop;
    },
    set() { return true; },
  });
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
