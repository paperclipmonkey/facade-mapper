/**
 * The celebration effects, driven through a recording 2D context.
 *
 * These effects each make a claim that is checkable rather than a matter of
 * taste, and every one of them is a claim that would fail *silently* — the
 * effect would still draw something plausible, and you would only find out by
 * standing in front of a house in the dark.
 *
 *   - meteors have to travel away from the radiant, and the ones near it have
 *     to be short. Get either backwards and you have drawn a firework.
 *   - sparks leave a catherine wheel tangentially, not radially. Radial is the
 *     thing everybody draws, and it is a sea urchin.
 *   - balloons go up. Confetti comes down. A sign error in either is a one
 *     character mistake that looks fine in a still.
 *   - a cake's tiers get narrower going up, and its candles get shorter as the
 *     evening goes on.
 *   - a clock's hands point where the time says they point.
 *
 * The context stub records the calls instead of rasterising, so this runs in
 * plain Node with no DOM.
 *
 *   node test/celebrations.test.mjs
 */

import { getEffect, defaultParams } from '../js/effects/registry.js';
import { boundingBox, buildPathSampler, makeRng } from '../js/core/math.js';
import { defaultNoise } from '../js/core/noise.js';

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

/* ------------------------------------------------------------------ *
 * A 2D context that writes down where it was asked to draw
 * ------------------------------------------------------------------ */

function recordingContext() {
  const lines = [];   // { x0, y0, x1, y1 } for each moveTo/lineTo pair
  const rects = [];   // { x, y, w, h }
  const arcs = [];    // { x, y, r }
  // One entry per stroke(), holding how many lines had been traced by then and
  // what it was stroked with — enough to tell one stroked path from the next
  // and to read the alpha off a neon pass.
  const strokes = [];
  const texts = [];   // { ch, x, y, style, stroked }
  let at = null;

  const ctx = {
    lines, rects, arcs, strokes, texts,
    fillStyle: '', strokeStyle: '', globalAlpha: 1, globalCompositeOperation: 'source-over',
    lineWidth: 1, lineCap: '', lineJoin: '', font: '', textAlign: '', textBaseline: '',
    filter: 'none', shadowBlur: 0, shadowColor: '',
    save() {}, restore() {}, clip() {}, rotate() {}, scale() {}, translate() {},
    setTransform() {}, resetTransform() {}, setLineDash() {}, rect() {},
    beginPath() { at = null; },
    closePath() {},
    moveTo(x, y) { at = { x, y }; },
    lineTo(x, y) {
      if (at) lines.push({ x0: at.x, y0: at.y, x1: x, y1: y });
      at = { x, y };
    },
    quadraticCurveTo(cx, cy, x, y) { at = { x, y }; },
    bezierCurveTo(a, b, c, d, x, y) { at = { x, y }; },
    arc(x, y, r) { arcs.push({ x, y, r }); },
    ellipse(x, y, rx, ry) { arcs.push({ x, y, r: Math.max(rx, ry) }); },
    fillRect(x, y, w, h) { rects.push({ x, y, w, h }); },
    strokeRect() {},
    fill() {},
    stroke() { strokes.push({ lines: lines.length, style: ctx.strokeStyle, width: ctx.lineWidth }); },
    fillText(ch, x, y) { texts.push({ ch, x, y, style: ctx.fillStyle, stroked: false }); },
    strokeText(ch, x, y) { texts.push({ ch, x, y, style: ctx.strokeStyle, stroked: true }); },
    measureText: (s) => ({ width: s.length * 8 }),
    drawImage() {}, putImageData() {},
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
  };
  return ctx;
}

function makeShape(points, closed = true, id = 's1') {
  return {
    id,
    name: id,
    tags: [],
    closed,
    points,
    path: {},
    bbox: boundingBox(points),
    centroid: boundingBox(points),
    sampler: buildPathSampler(points, closed),
  };
}

const box = (x, y, w, h) => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];

/**
 * Run an effect for a while and hand back the state and the last frame's calls.
 *
 * `step` at a fixed 60 Hz and `draw` once at the end, which is the order and
 * the rate the renderer uses. `rng` is a fresh generator seeded from the step
 * index, exactly as the renderer reseeds it, so anything cast in `step` is
 * reproducible here.
 */
function run(effectId, { shape, params = {}, seconds = 1, seed = 'test' }) {
  const effect = getEffect(effectId);
  if (!effect) throw new Error(`no effect ${effectId}`);
  const p = { ...defaultParams(effectId), ...params };
  const state = {};
  const base = {
    p, stable: p, shape, shapes: () => [], i: 0, n: 1,
    dt: 1 / 60, beat: 0, beatPhase: 0, bpm: 120,
    audio: { level: 0, low: 0, mid: 0, high: 0 },
    world: { w: 1920, h: 1080 }, layer: {}, state,
    noise: defaultNoise, media: () => null, camera: () => null, preview: false,
    share: new Map(), depth: null,
  };
  if (effect.init) Object.assign(state, effect.init({ ...base, rng: makeRng(seed), t: 0, age: 0 }) || {});

  const steps = Math.round(seconds * 60);
  for (let i = 1; i <= steps; i++) {
    const t = i / 60;
    effect.step?.({ ...base, g: null, t, age: t, rng: makeRng(`${seed}:${i}`) });
  }

  const g = recordingContext();
  const t = steps / 60;
  effect.draw({ ...base, g, t, age: t, rng: makeRng(`${seed}:${steps}`) });
  return { g, state, p };
}

/* ------------------------------------------------------------------ *
 * Meteors
 * ------------------------------------------------------------------ */

console.log('— meteor shower —');

{
  const shape = makeShape(box(0, 0, 1920, 1080));
  const radiantX = 0.2;
  const radiantY = -0.1;
  const rx = radiantX * 1920;
  const ry = radiantY * 1080;

  // Fireballs off and trains off, so every stroke recorded is a meteor rather
  // than the wavy line of a train, which is drawn radiant-outwards in segments
  // and would make the "away from the radiant" test vacuous.
  const { g } = run('meteors', {
    shape,
    seconds: 4,
    params: { radiantX, radiantY, rate: 240, fireballs: 0, train: 0, showRadiant: false },
  });

  ok('draws meteors', g.lines.length > 0, `${g.lines.length} streaks`);

  const outward = g.lines.filter((l) => {
    const headD = Math.hypot(l.x1 - rx, l.y1 - ry);
    const tailD = Math.hypot(l.x0 - rx, l.y0 - ry);
    return headD > tailD;
  });
  ok('every streak points away from the radiant', outward.length === g.lines.length,
    `${outward.length} / ${g.lines.length}`);

  const aligned = g.lines.filter((l) => {
    // The streak has to lie *along* the ray from the radiant, not merely end
    // further out: a meteor at right angles to the radiant is not a Perseid.
    const ax = l.x1 - rx;
    const ay = l.y1 - ry;
    const bx = l.x1 - l.x0;
    const by = l.y1 - l.y0;
    const cos = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1);
    return cos > 0.999;
  });
  ok('and lies along the ray from it', aligned.length === g.lines.length,
    `${aligned.length} / ${g.lines.length}`);
}

{
  /**
   * Foreshortening: a meteor that appears close to the radiant is coming almost
   * straight at you and hardly moves, and one out at ninety degrees crosses the
   * sky. Same rock, same speed. This is the detail that makes a shower read as
   * a shower, so it is worth a test rather than a comment.
   */
  const shape = makeShape(box(0, 0, 1920, 1080));
  const rx = 0.2 * 1920;
  const ry = -0.1 * 1080;
  const near = [];
  const far = [];

  for (let frame = 0; frame < 240; frame++) {
    const effect = getEffect('meteors');
    const p = { ...defaultParams('meteors'), radiantX: 0.2, radiantY: -0.1, rate: 240, fireballs: 0, train: 0 };
    const g = recordingContext();
    effect.draw({
      g, p, stable: p, shape, shapes: () => [], t: frame / 30, age: frame / 30, dt: 1 / 30,
      beat: 0, beatPhase: 0, bpm: 120, audio: { level: 0, low: 0, mid: 0, high: 0 },
      i: 0, n: 1, world: { w: 1920, h: 1080 }, layer: {}, state: {},
      rng: makeRng('m'), noise: defaultNoise, media: () => null, share: new Map(),
    });
    for (const l of g.lines) {
      const d = Math.hypot(l.x1 - rx, l.y1 - ry);
      const len = Math.hypot(l.x1 - l.x0, l.y1 - l.y0);
      (d < 500 ? near : far).push(len);
    }
  }

  const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  ok('meteors are seen both near the radiant and away from it', near.length > 5 && far.length > 5,
    `${near.length} near, ${far.length} far`);
  ok('and the ones near the radiant are the short ones',
    mean(near) < mean(far),
    `${mean(near).toFixed(0)}px vs ${mean(far).toFixed(0)}px`);
}

/* ------------------------------------------------------------------ *
 * Catherine wheel
 * ------------------------------------------------------------------ */

console.log('\n— catherine wheel —');

{
  const shape = makeShape(box(400, 300, 400, 400));
  // A generator that always returns a half kills the jitter — every random term
  // in the spawn is `rng() - 0.5` — so what is left is the physics.
  const effect = getEffect('catherine-wheel');
  // Gravity off, so what is left in a spark's velocity is what the wheel gave
  // it. With gravity on, one step of falling has already bent it by the time
  // anything can be measured.
  const p = { ...defaultParams('catherine-wheel'), repeat: 0, gravity: 0 };
  const state = effect.init();
  const dt = 1 / 60;
  const base = {
    p, stable: p, shape, shapes: () => [], dt, state,
    noise: defaultNoise, rng: () => 0.5, i: 0, n: 1,
    audio: { level: 0, low: 0, mid: 0, high: 0 }, world: { w: 1920, h: 1080 },
    layer: {}, media: () => null, share: new Map(),
  };
  for (let i = 1; i <= 120; i++) effect.step({ ...base, g: null, t: i / 60, age: i / 60 });

  const cx = shape.bbox.cx;
  const cy = shape.bbox.cy;
  const R = Math.min(shape.bbox.w, shape.bbox.h) * 0.5 * p.radius;
  /**
   * Only the sparks cast on the last step are worth reading, and even those
   * have had one step of drag and one step of travel applied — `step` spawns
   * and then integrates in the same pass. Undoing that step recovers where the
   * spark left the casing and how fast it was going when it did.
   */
  const drag = 1 - 2.2 * dt;
  const fresh = state.sparks
    .filter((s) => s.age <= dt + 1e-9)
    .map((s) => {
      const vx = s.vx / drag;
      const vy = s.vy / drag;
      return { x: s.x - vx * dt, y: s.y - vy * dt, vx, vy };
    });
  ok('the wheel is throwing sparks', fresh.length > 0, `${fresh.length} this step`);

  const tangential = fresh.filter((s) => {
    const rxv = s.x - cx;
    const ryv = s.y - cy;
    const dot = (rxv * s.vx + ryv * s.vy) / (Math.hypot(rxv, ryv) * Math.hypot(s.vx, s.vy) || 1);
    return Math.abs(dot) < 0.02;
  });
  ok('and they leave at right angles to the spoke', tangential.length === fresh.length,
    `${tangential.length} / ${fresh.length}`);

  const onRim = fresh.every((s) => Math.abs(Math.hypot(s.x - cx, s.y - cy) - R) < 1);
  ok('and they leave from the rim', onRim);

  // It burns out: past `duration` the wheel stops driving and the shower dies.
  for (let i = 121; i <= 60 * 14; i++) effect.step({ ...base, g: null, t: i / 60, age: i / 60 });
  ok('and it burns out at the end', state.lit === 0 && state.sparks.length === 0,
    `lit ${state.lit}, ${state.sparks.length} sparks left`);
}

/* ------------------------------------------------------------------ *
 * Balloons and confetti — which way is up
 * ------------------------------------------------------------------ */

console.log('\n— up and down —');

{
  const shape = makeShape(box(0, 0, 1920, 1080));
  const { state } = run('balloons', { shape, seconds: 2, params: { count: 12, pop: 0 } });
  ok('balloons exist', state.balloons.length === 12, `${state.balloons.length}`);

  // Every one of them, one step at a time, must go up.
  const effect = getEffect('balloons');
  const p = { ...defaultParams('balloons'), count: 12, pop: 0 };
  const before = state.balloons.map((b) => b.y);
  effect.step({
    p, stable: p, shape, dt: 1 / 60, state, rng: makeRng('x'), noise: defaultNoise,
    t: 2, age: 2, g: null, shapes: () => [], i: 0, n: 1, world: { w: 1920, h: 1080 },
    audio: { level: 0, low: 0, mid: 0, high: 0 }, layer: {}, media: () => null, share: new Map(),
  });
  const rising = state.balloons.filter((b, i) => b.y < before[i]);
  ok('and every one of them rises', rising.length === state.balloons.length,
    `${rising.length} / ${state.balloons.length}`);
}

{
  const shape = makeShape(box(0, 0, 1920, 1080));
  const { state } = run('confetti', { shape, seconds: 2, params: { count: 40, wind: 0 } });
  const effect = getEffect('confetti');
  const p = { ...defaultParams('confetti'), count: 40, wind: 0 };
  const before = state.bits.map((b) => b.y);
  effect.step({
    p, stable: p, shape, dt: 1 / 60, state, rng: makeRng('x'), noise: defaultNoise,
    t: 2, age: 2, g: null, shapes: () => [], i: 0, n: 1, world: { w: 1920, h: 1080 },
    audio: { level: 0, low: 0, mid: 0, high: 0 }, layer: {}, media: () => null, share: new Map(),
  });
  const falling = state.bits.filter((b, i) => b.y > before[i]);
  ok('confetti falls', falling.length === state.bits.length,
    `${falling.length} / ${state.bits.length}`);
}

/* ------------------------------------------------------------------ *
 * Cake
 * ------------------------------------------------------------------ */

console.log('\n— birthday cake —');

{
  const shape = makeShape(box(200, 100, 600, 800));
  const params = { tiers: 3, candles: 6, burn: 1, drips: 0 };

  const fresh = run('cake', { shape, seconds: 0.01, params });
  // The tiers are the wide fills; the candles are the narrow ones.
  const wide = fresh.g.rects.filter((r) => r.w > shape.bbox.w * 0.1).map((r) => r.w);
  const tiers = [...new Set(wide.map((w) => Math.round(w)))].sort((a, b) => b - a);
  ok('the cake has as many widths as it has tiers', tiers.length === 3, tiers.join(', '));

  // Bottom tier widest. Drawn bottom-up, so the first wide fill is the base.
  const first = fresh.g.rects.find((r) => r.w > shape.bbox.w * 0.1);
  ok('and the bottom one is the widest', Math.round(first.w) === tiers[0],
    `${Math.round(first.w)} vs ${tiers[0]}`);

  const candleHeight = (frame) => {
    const rects = frame.g.rects.filter((r) => r.w < shape.bbox.w * 0.05 && r.h > 1);
    return Math.max(...rects.map((r) => r.h));
  };
  const later = run('cake', { shape, seconds: 0.01, params });
  // Same show time in, same cake out — nothing is remembered between frames, so
  // a tab that joins late draws the same stubs as one that has been running.
  ok('the cake is the same in every tab at the same moment',
    candleHeight(fresh) === candleHeight(later));

  // `burn: 1` is one minute, so at forty seconds they are two thirds gone.
  const effect = getEffect('cake');
  const p = { ...defaultParams('cake'), ...params };
  const g = recordingContext();
  effect.draw({
    g, p, stable: p, shape, t: 40, age: 40, dt: 1 / 60, shapes: () => [], i: 0, n: 1,
    beat: 0, beatPhase: 0, bpm: 120, audio: { level: 0, low: 0, mid: 0, high: 0 },
    world: { w: 1920, h: 1080 }, layer: {}, state: {}, rng: makeRng('c'),
    noise: defaultNoise, media: () => null, share: new Map(),
  });
  const burnt = Math.max(...g.rects.filter((r) => r.w < shape.bbox.w * 0.05 && r.h > 1).map((r) => r.h));
  ok('and the candles burn down', burnt < candleHeight(fresh),
    `${burnt.toFixed(1)} vs ${candleHeight(fresh).toFixed(1)}`);
}

{
  // Blowing them out. `lit` is what a microphone binding drives, and at zero
  // there must be no flame left anywhere on the cake.
  const shape = makeShape(box(200, 100, 600, 800));
  const litUp = run('cake', { shape, seconds: 0.01, params: { candles: 6, lit: 1, glow: 0 } });
  const out = run('cake', { shape, seconds: 0.01, params: { candles: 6, lit: 0, glow: 0 } });
  ok('blowing the candles out removes the flames', out.g.arcs.length < litUp.g.arcs.length,
    `${out.g.arcs.length} vs ${litUp.g.arcs.length} rounded shapes`);
}

/* ------------------------------------------------------------------ *
 * Clock face
 * ------------------------------------------------------------------ */

console.log('\n— clock face —');

{
  /**
   * The hands, against a frozen wall clock.
   *
   * `Date.now` is stubbed rather than the effect being given a time, because
   * reading the real clock is the whole point of this effect — a countdown that
   * pauses with the transport is a decoration. If the reading path ever changes
   * to show time, this test starts failing, which is correct.
   */
  const realNow = Date.now;
  try {
    // 03:00:00 local, so the hour hand points at three: straight to the right.
    const at = new Date(2027, 0, 1, 3, 0, 0);
    Date.now = () => at.getTime();

    const shape = makeShape(box(0, 0, 400, 400));
    const effect = getEffect('clock-face');
    const p = { ...defaultParams('clock-face'), numerals: 'none', second: 'none', target: '2027-01-01 04:00' };
    const g = recordingContext();
    effect.draw({
      g, p, stable: p, shape, t: 5, age: 5, dt: 1 / 60, shapes: () => [], i: 0, n: 1,
      beat: 0, beatPhase: 0, bpm: 120, audio: { level: 0, low: 0, mid: 0, high: 0 },
      world: { w: 1920, h: 1080 }, layer: {}, state: {}, rng: makeRng('k'),
      noise: defaultNoise, media: () => null, share: new Map(),
    });

    // The hands are the only lines drawn once numerals are off, and they are
    // drawn about a translated origin, so the recorded coordinates are relative
    // to the middle of the face.
    const hands = g.lines;
    ok('the clock draws two hands', hands.length === 2, `${hands.length} lines`);
    const angle = (l) => Math.atan2(l.y1, l.x1) * 180 / Math.PI;
    const hour = hands.reduce((a, b) => (Math.hypot(a.x1, a.y1) < Math.hypot(b.x1, b.y1) ? a : b));
    ok('and at three o’clock the hour hand points right', Math.abs(angle(hour)) < 1,
      `${angle(hour).toFixed(1)}°`);

    // And the minute hand, at zero minutes, points straight up.
    const minute = hands.find((l) => l !== hour);
    ok('while the minute hand points up', Math.abs(angle(minute) + 90) < 1,
      `${angle(minute).toFixed(1)}°`);
  } finally {
    Date.now = realNow;
  }
}

{
  // The flare: for a few seconds after the target it puts an expanding ring on
  // the wall that is not there before it.
  const realNow = Date.now;
  try {
    const shape = makeShape(box(0, 0, 400, 400));
    const effect = getEffect('clock-face');
    const target = new Date(2027, 0, 1, 0, 0, 0);
    const draw = (nowMs) => {
      Date.now = () => nowMs;
      const p = { ...defaultParams('clock-face'), target: '2027-01-01 00:00', numerals: 'none', second: 'none' };
      const g = recordingContext();
      effect.draw({
        g, p, stable: p, shape, t: 1, age: 1, dt: 1 / 60, shapes: () => [], i: 0, n: 1,
        beat: 0, beatPhase: 0, bpm: 120, audio: { level: 0, low: 0, mid: 0, high: 0 },
        world: { w: 1920, h: 1080 }, layer: {}, state: {}, rng: makeRng('k'),
        noise: defaultNoise, media: () => null, share: new Map(),
      });
      return g;
    };
    const before = draw(target.getTime() - 30000);
    const after = draw(target.getTime() + 1000);
    ok('midnight puts a ring on the house', after.arcs.length > before.arcs.length,
      `${after.arcs.length} vs ${before.arcs.length}`);
  } finally {
    Date.now = realNow;
  }
}

/* ------------------------------------------------------------------ *
 * Bunting
 * ------------------------------------------------------------------ */

console.log('\n— bunting —');

{
  // A level string of flags, which must not come out level: the cord sags.
  const shape = makeShape([{ x: 100, y: 200 }, { x: 1100, y: 200 }], false);
  const { g } = run('bunting', { shape, seconds: 0.01, params: { sag: 80, cord: 1, spacing: 100 } });

  // The cord is the first stroked path; everything after it is flags, drawn in
  // their own rotated and squeezed coordinates.
  const cord = g.lines.slice(0, g.strokes[0].lines);
  ok('the cord is drawn', cord.length > 4, `${cord.length} segments`);
  const ys = cord.map((l) => l.y1);
  const deepest = Math.max(...ys);
  const ends = Math.min(ys[0], ys[ys.length - 1]);
  ok('and it hangs lowest in the middle', deepest - ends > 60, `${(deepest - ends).toFixed(0)}px of sag`);

  const flat = run('bunting', { shape, seconds: 0.01, params: { sag: 0, cord: 1, spacing: 100 } });
  const flatYs = flat.g.lines.slice(0, flat.g.strokes[0].lines).map((l) => l.y1);
  ok('and with the sag off it is level', Math.max(...flatYs) - Math.min(...flatYs) < 1);
}

/* ------------------------------------------------------------------ *
 * Sparkler
 * ------------------------------------------------------------------ */

console.log('\n— sparkler —');

{
  const shape = makeShape(box(300, 300, 400, 400));
  const { state } = run('sparkler', { shape, seconds: 2, params: { trail: 0.5, count: 1 } });

  ok('the after-image is a bounded ring', state.trail && state.trail.len <= state.trail.cap,
    `${state.trail.len} / ${state.trail.cap}`);
  ok('and it holds about half a second of it', state.trail.cap <= 34,
    `${state.trail.cap} samples`);

  ok('it is throwing sparks', state.sparks.length > 0, `${state.sparks.length}`);
  // Forking is the signature of a sparkler: some sparks must have divided.
  ok('and some of them have forked', state.sparks.some((s) => s.forked && s.burst === -1));
}

/* ------------------------------------------------------------------ *
 * The one-shots
 * ------------------------------------------------------------------ */

console.log('\n— rocket and cannon —');

for (const id of ['rocket', 'confetti-cannon']) {
  const shape = makeShape(box(800, 700, 200, 200));
  const effect = getEffect(id);
  const p = { ...defaultParams(id) };
  const at = (age) => {
    const g = recordingContext();
    const state = effect.init ? effect.init({ rng: makeRng('r') }) : {};
    effect.step?.({
      p, stable: p, shape, age, t: age, dt: 1 / 60, state, rng: makeRng('r'),
      noise: defaultNoise, g: null, shapes: () => [], i: 0, n: 1,
      world: { w: 1920, h: 1080 }, layer: {}, audio: { level: 0, low: 0, mid: 0, high: 0 },
      media: () => null, share: new Map(),
    });
    effect.draw({
      g, p, stable: p, shape, age, t: age, dt: 1 / 60, state, rng: makeRng('r'),
      noise: defaultNoise, shapes: () => [], i: 0, n: 1,
      world: { w: 1920, h: 1080 }, layer: {}, beat: 0, beatPhase: 0, bpm: 120,
      audio: { level: 0, low: 0, mid: 0, high: 0 }, media: () => null, share: new Map(),
    });
    return g.rects.length + g.arcs.length + g.lines.length;
  };

  ok(`${id} plays`, at(p.duration * 0.5) > 0, `${at(p.duration * 0.5)} operations`);
  ok(`${id} is over when it says it is`, at(p.duration + 0.5) === 0);
}

{
  // The rocket lifts before it breaks, and the shell is where the lift ended.
  const shape = makeShape(box(800, 700, 200, 200));
  const effect = getEffect('rocket');
  const p = { ...defaultParams('rocket') };
  const g = recordingContext();
  effect.draw({
    g, p, stable: p, shape, age: p.lift * 0.6, t: 0, dt: 1 / 60, state: {}, rng: makeRng('r'),
    noise: defaultNoise, shapes: () => [], i: 0, n: 1, world: { w: 1920, h: 1080 },
    layer: {}, beat: 0, beatPhase: 0, bpm: 120,
    audio: { level: 0, low: 0, mid: 0, high: 0 }, media: () => null, share: new Map(),
  });
  ok('while it is climbing there is a trail and no stars',
    g.lines.length === 1 && g.rects.length === 0,
    `${g.lines.length} lines, ${g.arcs.length} arcs`);
  ok('and the trail goes upwards', g.lines[0].y1 < g.lines[0].y0);
}


/* ------------------------------------------------------------------ *
 * Neon
 * ------------------------------------------------------------------ */

console.log('\n— neon —');

/** The alpha out of an `rgba(r,g,b,a)` string. */
const alphaOf = (style) => {
  const m = /rgba?\([^)]*,\s*([\d.]+)\s*\)/.exec(String(style));
  return m ? Number(m[1]) : 1;
};

{
  const shape = makeShape(box(200, 200, 400, 300));
  const effect = getEffect('neon');
  const draw = (t, params = {}) => {
    const p = { ...defaultParams('neon'), ...params };
    const g = recordingContext();
    effect.draw({
      g, p, stable: p, shape, t, age: t, dt: 1 / 60, state: {}, rng: makeRng('n'),
      noise: defaultNoise, shapes: () => [], i: 0, n: 1, world: { w: 1920, h: 1080 },
      layer: {}, beat: 0, beatPhase: 0, bpm: 120,
      audio: { level: 0, low: 0, mid: 0, high: 0 }, media: () => null, share: new Map(),
    });
    return g;
  };

  const steady = draw(1, { flicker: 0, buzz: 0 });
  ok('a tube is drawn as several passes', steady.strokes.length >= 4,
    `${steady.strokes.length} strokes`);

  // Widest and faintest first, then a nearly-white core. Reverse that and it is
  // a coloured line with a rim, not neon.
  const widths = steady.strokes.map((s) => s.width);
  ok('and they narrow as they go', widths[0] > widths[1] && widths[1] > widths[2],
    widths.map((w) => w.toFixed(1)).join(' > '));
  const alphas = steady.strokes.map((s) => alphaOf(s.style));
  ok('while getting brighter', alphas[0] < alphas[1] && alphas[1] < alphas[2],
    alphas.map((a) => a.toFixed(2)).join(' < '));

  /**
   * And it strikes. Over a minute of a badly-striking tube there has to be at
   * least one moment where it is properly out — a "flicker" that only ever
   * dims is a dimmer, which is exactly what this parameter used to be.
   */
  let dark = 0;
  let lit = 0;
  for (let i = 0; i < 6000; i++) {
    const g = draw(i / 100, { flicker: 1, buzz: 0 });
    if (!g.strokes.length) dark++;
    else lit++;
  }
  ok('a badly-striking tube goes right out sometimes', dark > 0, `${dark} frames of ${dark + lit}`);
  ok('but is lit almost all of the time', lit / (dark + lit) > 0.9,
    `${((lit / (dark + lit)) * 100).toFixed(1)}% lit`);

  // Deterministic: the same show time gives the same tube in every tab.
  const a = draw(12.34, { flicker: 1 });
  const b = draw(12.34, { flicker: 1 });
  ok('and every tab strikes at the same instant',
    JSON.stringify(a.strokes) === JSON.stringify(b.strokes));
}

{
  const shape = makeShape(box(100, 100, 120, 400));
  const effect = getEffect('neon-sign');
  const p = { ...defaultParams('neon-sign'), text: 'ABCD', broken: 1, flicker: 0, buzz: 0, frame: 0, subtitle: '' };
  const g = recordingContext();
  effect.draw({
    g, p, stable: p, shape, t: 3, age: 3, dt: 1 / 60, state: {}, rng: makeRng('s'),
    noise: defaultNoise, shapes: () => [], i: 0, n: 1, world: { w: 1920, h: 1080 },
    layer: {}, beat: 0, beatPhase: 0, bpm: 120,
    audio: { level: 0, low: 0, mid: 0, high: 0 }, media: () => null, share: new Map(),
  });

  const cores = g.texts.filter((entry) => !entry.stroked);
  ok('every character in the sign is drawn', cores.length === 4, `${cores.length}`);

  const ys = cores.map((c) => c.y);
  ok('and they run down the shape', ys.every((y, i) => i === 0 || y > ys[i - 1]), ys.join(', '));

  // One of them is out — and stays out, rather than a different one each frame.
  const dim = cores.filter((c) => alphaOf(c.style) < 0.3);
  ok('with one of them out', dim.length === 1, `${dim.length} dark`);
}

{
  // The hologram's tear has to be the same tear in every tab, or two projectors
  // covering one wall disturb different parts of the same picture.
  const shape = makeShape(box(0, 0, 900, 600));
  const effect = getEffect('hologram');
  const p = { ...defaultParams('hologram'), glitch: 1 };
  const render = () => {
    const g = recordingContext();
    effect.draw({
      g, p, stable: p, shape, t: 7.77, age: 7.77, dt: 1 / 60, state: {}, rng: makeRng('h'),
      noise: defaultNoise, shapes: () => [], i: 0, n: 1, world: { w: 1920, h: 1080 },
      layer: {}, beat: 0, beatPhase: 0, bpm: 120,
      audio: { level: 0, low: 0, mid: 0, high: 0 }, media: () => null, share: new Map(),
    });
    return g;
  };
  const one = render();
  const two = render();
  ok('the hologram draws', one.texts.length > 0, `${one.texts.length} glyphs`);
  ok('and it tears identically in every tab',
    JSON.stringify(one.texts) === JSON.stringify(two.texts));
  ok('and it has scanlines over it', one.rects.length > 0, `${one.rects.length} bands`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
