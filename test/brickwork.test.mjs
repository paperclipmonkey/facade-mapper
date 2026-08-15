/**
 * Brickwork and Breach.
 *
 * These are the first effects in the library complicated enough to have
 * invariants rather than just an appearance, and each of the ones tested here
 * is something that was actually wrong at some point while writing them:
 *
 *  - holes opened outside the traced wall, where nothing is drawn, so the
 *    effect looked as though it were not running;
 *  - holes opened over the windows, which reads as damage to the glass rather
 *    than to the masonry;
 *  - tentacles coiled into hairpins, because a per-joint turn that is summed
 *    does not cancel;
 *  - and nothing ever closed, so the wall was spent after the first minute and
 *    stayed spent for the rest of the evening.
 *
 * All of it is driven through the real `draw`, against a recording canvas, so
 * the thing under test is the code that runs on the wall.
 *
 *   node test/brickwork.test.mjs
 */

import { getEffect, defaultParams } from '../js/effects/registry.js';
import { boundingBox, buildPathSampler, makeRng } from '../js/core/math.js';

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

/* ------------------------------------------------------------------ *
 * A canvas that remembers what it was asked to draw
 * ------------------------------------------------------------------ */

function recordingContext() {
  const rects = [];
  const fills = [];
  let current = null;
  const ctx = {
    rects, fills,
    fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', filter: 'none', shadowBlur: 0,
    save() {}, restore() {}, clip() {}, translate() {}, rotate() {}, scale() {},
    setTransform() {}, resetTransform() {}, closePath() {}, arc() {}, ellipse() {},
    drawImage() { ctx.drew = (ctx.drew || 0) + 1; },
    rect() {},
    fillRect(x, y, w, h) { rects.push({ x, y, w, h, style: ctx.fillStyle, alpha: ctx.globalAlpha }); },
    strokeRect() {},
    beginPath() { current = []; },
    moveTo(x, y) { current = [{ x, y }]; },
    lineTo(x, y) { if (current) current.push({ x, y }); },
    fill() { if (current && current.length > 2) fills.push([...current]); },
    stroke() {},
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
  };
  return ctx;
}

// `offscreen()` asks the document for a canvas. Everything the bake does lands
// in the returned context, which is worth capturing: it is how we know a wall
// was laid at all.
const baked = [];
globalThis.document = {
  createElement() {
    const c = recordingContext();
    baked.push(c);
    return { width: 0, height: 0, getContext: () => c };
  },
};

/* ------------------------------------------------------------------ *
 * A facade to draw on
 * ------------------------------------------------------------------ */

const rect = (x, y, w, h) => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];

function geo(points, id, tags = []) {
  return {
    id, name: id, tags, closed: true, points, path: {},
    bbox: boundingBox(points),
    centroid: boundingBox(points),
    sampler: buildPathSampler(points, true),
  };
}

// A gable: the bounding box has a lot of sky in it, which is the whole point.
const wall = geo(
  [{ x: 0, y: 200 }, { x: 500, y: 0 }, { x: 1000, y: 200 }, { x: 1000, y: 800 }, { x: 0, y: 800 }],
  'wall', ['wall']
);
const windows = [
  geo(rect(120, 320, 200, 180), 'w1', ['window']),
  geo(rect(680, 320, 200, 180), 'w2', ['window']),
];
const shapesFor = (tag) => (tag === 'window' ? windows : []);

/** Run an effect for `frames` frames and hand back the last frame's context. */
function run(effect, params, frames, { dt = 1 / 60 } = {}) {
  const state = effect.init ? effect.init() : {};
  const rng = makeRng('test');
  let g = null;
  let t = 0;
  const seen = [];
  for (let f = 0; f < frames; f++) {
    t += dt;
    g = recordingContext();
    effect.draw({
      g, p: params, stable: params, shape: wall, shapes: shapesFor,
      t, dt, rng, state, i: 0, n: 1, beat: 0, beatPhase: 0, bpm: 120,
      audio: { level: 0, low: 0, mid: 0, high: 0 },
    });
    seen.push(g);
  }
  return { g, state, seen };
}

/* ------------------------------------------------------------------ *
 * Brickwork
 * ------------------------------------------------------------------ */

console.log('— brickwork —');

const brickwork = getEffect('brickwork');
ok('the effect is registered', Boolean(brickwork));

{
  baked.length = 0;
  const p = { ...defaultParams('brickwork'), obstacles: 'window, door' };
  const { g } = run(brickwork, p, 3);
  const bake = baked[0];

  ok('a wall is baked once, not every frame', baked.length === 1, `${baked.length} canvases`);
  ok('and blitted thereafter', g.drew === 1);

  // Mortar field, then a face plus four bevel bands per brick.
  ok('bricks were laid', bake.rects.length > 100, `${bake.rects.length} rects`);

  // Running bond: alternate courses start half a brick to the left. Take the
  // left-most face rect on each of two adjacent rows and compare.
  const faces = bake.rects.filter((r) => Math.abs(r.w - p.brickW) < 0.01 && Math.abs(r.h - p.brickH) < 0.01);
  const rowY = [...new Set(faces.map((r) => Math.round(r.y)))].sort((a, b) => a - b);
  const leftOf = (y) => Math.min(...faces.filter((r) => Math.round(r.y) === y).map((r) => r.x));
  const offset = Math.abs(leftOf(rowY[0]) - leftOf(rowY[1]));
  ok('courses are offset half a brick', Math.abs(offset - (p.brickW + p.gap) / 2) < 1, `${offset.toFixed(1)}`);

  // The openings are cut, not skipped, so the count of laid bricks does not
  // depend on where the windows are.
  baked.length = 0;
  run(brickwork, { ...p, obstacles: '' }, 1);
  const withoutWindows = baked[0].rects.length;
  baked.length = 0;
  run(brickwork, p, 1);
  ok('openings are erased rather than left unlaid', baked[0].rects.length === withoutWindows,
    `${baked[0].rects.length} vs ${withoutWindows}`);
}

{
  // The cache key must not include anything a modulator can move, or a wall
  // bound to the microphone is re-laid sixty times a second.
  baked.length = 0;
  const stable = { ...defaultParams('brickwork'), obstacles: 'window, door' };
  const state = brickwork.init();
  const rng = makeRng('k');
  for (let f = 0; f < 30; f++) {
    brickwork.draw({
      g: recordingContext(), p: { ...stable, gap: 7 + f }, stable,
      shape: wall, shapes: shapesFor, t: f / 60, dt: 1 / 60, rng, state,
      i: 0, n: 1, beat: 0, beatPhase: 0, bpm: 120,
      audio: { level: 0, low: 0, mid: 0, high: 0 },
    });
  }
  ok('a modulated parameter does not re-lay the wall', baked.length === 1, `${baked.length} bakes`);
}

/* ------------------------------------------------------------------ *
 * Breach
 * ------------------------------------------------------------------ */

console.log('\n— breach —');

const breach = getEffect('breach');
ok('the effect is registered', Boolean(breach));

const base = { ...defaultParams('breach'), obstacles: 'window, door' };
const voidsIn = (g) => g.rects.filter((r) => r.style === base.void);

{
  const { seen } = run(breach, { ...base, rate: 0 }, 400);
  ok('no bricks a minute means no holes, ever',
    seen.every((g) => voidsIn(g).length === 0));
}

{
  const { seen } = run(breach, { ...base, rate: 60, heal: 0 }, 900);
  const last = seen[seen.length - 1];
  ok('bricks do come out', voidsIn(last).length > 0, `${voidsIn(last).length} gaps`);

  // Every void, over the whole run, against both windows.
  let trespass = 0;
  for (const g of seen) {
    for (const r of voidsIn(g)) {
      for (const win of windows) {
        const b = win.bbox;
        if (r.x + r.w > b.x && r.x < b.x + b.w && r.y + r.h > b.y && r.y < b.y + b.h) trespass++;
      }
    }
  }
  ok('and never out of a window', trespass === 0, `${trespass} overlaps`);

  // Every void, against the traced outline. A gable's bounding box is a third
  // sky, and a hole up there is invisible — the effect looks broken.
  const inWall = (x, y) => {
    let inside = false;
    const pts = wall.points;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  let outside = 0;
  for (const r of voidsIn(last)) {
    if (!inWall(r.x + r.w / 2, r.y + r.h / 2)) outside++;
  }
  ok('and never outside the traced wall', outside === 0, `${outside} in the sky`);
}

{
  const holes = 2;
  const { seen } = run(breach, { ...base, rate: 60, heal: 0, holes, cluster: 1 }, 1200);
  const most = Math.max(...seen.map((g) => voidsIn(g).length));
  ok('the hole limit is respected', most <= holes, `${most} of ${holes}`);
}

{
  // Heals, so the wall is not spent after the first minute.
  const { seen } = run(breach, { ...base, rate: 30, heal: 6, holes: 1, cluster: 2 }, 1800);
  const counts = seen.map((g) => voidsIn(g).length);
  ok('the wall opens', Math.max(...counts) > 0);
  ok('and closes again', counts.slice(400).some((n) => n === 0));
  const opened = counts.filter((n, i) => n > 0 && counts[i - 1] === 0).length;
  ok('more than once', opened >= 2, `${opened} times`);
}

{
  const { seen } = run(breach, { ...base, rate: 30, heal: 0, holes: 1, cluster: 2 }, 1800);
  const counts = seen.slice(600).map((g) => voidsIn(g).length);
  ok('and stays open for good when healing is off', counts.every((n) => n > 0));
}

/* ------------------------------------------------------------------ *
 * The arms
 * ------------------------------------------------------------------ */

console.log('\n— tentacles —');

{
  const { seen } = run(breach, { ...base, rate: 60, heal: 0, arms: 3, writhe: 3, reach: 3 }, 1500);

  /**
   * A tentacle is drawn as a ribbon: one edge out, the other edge back. The
   * first half of the point list is therefore the centreline's left edge, which
   * is close enough to the arm's path to measure its shape.
   *
   * The number that matters is end-to-end distance against path length. A limb
   * reaching out of a wall scores near one; the hairpin the first version
   * produced scores near zero, because it doubles back on itself. Anything
   * under about a half is visibly a bent drinking straw.
   */
  let worst = 1;
  let samples = 0;
  for (const g of seen.slice(600)) {
    for (const poly of g.fills) {
      if (poly.length < 24) continue; // ribbons only, not suckers or bricks
      const edge = poly.slice(0, Math.floor(poly.length / 2));
      let path = 0;
      for (let i = 1; i < edge.length; i++) {
        path += Math.hypot(edge[i].x - edge[i - 1].x, edge[i].y - edge[i - 1].y);
      }
      if (path < 1) continue;
      const span = Math.hypot(
        edge[edge.length - 1].x - edge[0].x,
        edge[edge.length - 1].y - edge[0].y
      );
      worst = Math.min(worst, span / path);
      samples += 1;
    }
  }
  ok('arms were drawn', samples > 20, `${samples} ribbons`);
  ok('and none of them coils back on itself', worst > 0.5, `worst straightness ${worst.toFixed(2)}`);
}

{
  // Writhe at zero should be still, not straight-and-vibrating.
  const { seen } = run(breach, { ...base, rate: 60, heal: 0, arms: 2, writhe: 0 }, 1200);
  const ribbon = (g) => g.fills.filter((f) => f.length >= 24)[0];
  const a = ribbon(seen[1000]);
  const b = ribbon(seen[1001]);
  ok('no writhe means no movement', Boolean(a) && Boolean(b)
    && Math.hypot(a[5].x - b[5].x, a[5].y - b[5].y) < 0.001);
}

console.log(failures ? `\n${failures} failing` : '\nall good');
process.exit(failures ? 1 : 0);
