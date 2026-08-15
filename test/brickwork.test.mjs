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
    // The withdrawal invariant, checked every frame rather than sampled: a hole
    // may not start closing while any of its arms is still out on the wall.
    for (const hole of state.holes || []) {
      if (hole.closing > 0 && (hole.arms || []).some((a) => a.path && a.path.length > 2)) {
        state.brokeWithdrawal = `closing at ${hole.closing.toFixed(2)} with an arm still out`;
      }
    }
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

/**
 * A tentacle is drawn as a ribbon: one edge out along the arm, the other edge
 * back. Point `i` of the first half and point `n-1-i` of the second are the two
 * flanks at the same joint, so their midpoint recovers the centreline.
 */
function spinesIn(g) {
  const out = [];
  for (const poly of g.fills) {
    if (poly.length < 8 || poly.length % 2) continue; // ribbons only
    const half = poly.length / 2;
    const spine = [];
    for (let i = 0; i < half; i++) {
      const a = poly[i];
      const b = poly[poly.length - 1 - i];
      spine.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    }
    out.push({ spine, poly });
  }
  return out;
}

function insidePoly(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

{
  // Everything drawn, at the top of every range, over half a minute of crawling.
  const { seen } = run(breach, {
    ...base, rate: 60, heal: 0, arms: 3, writhe: 3, reach: 3, crawl: 400, wander: 1,
  }, 1800);

  let ribbons = 0;
  let overGlass = 0;
  let offTheWall = 0;
  let sharpest = Infinity;

  for (const g of seen.slice(300)) {
    for (const { poly } of spinesIn(g)) {
      ribbons += 1;
      // The drawn outline, not the centreline: covering the glass is what
      // matters and the flanks are what cover it.
      for (const pt of poly) {
        for (const win of windows) if (insidePoly(win.points, pt.x, pt.y)) overGlass += 1;
        if (!insidePoly(wall.points, pt.x, pt.y)) offTheWall += 1;
      }
    }
    /**
     * And no bend is tight enough to turn the ribbon inside out.
     *
     * The bare turn angle is the wrong thing to bound: what matters is the
     * radius of the *inside* edge of the bend, which is the step length over
     * the turn, less the local half-width. Once that goes negative the inner
     * flank crosses the spine and the arm pinches shut into a bow-tie. Both
     * terms are recoverable from the drawn ribbon — the half-width is half the
     * distance between the two flanks at the same joint.
     */
    for (const { spine, poly } of spinesIn(g)) {
      // Turn and width taken at the *same* joint: the inner edge inverts where
      // the bend is, not one joint downstream of it.
      for (let i = 1; i < spine.length - 1; i++) {
        const a = Math.atan2(spine[i].y - spine[i - 1].y, spine[i].x - spine[i - 1].x);
        const b = Math.atan2(spine[i + 1].y - spine[i].y, spine[i + 1].x - spine[i].x);
        const turn = Math.abs(((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        const step = Math.hypot(spine[i].x - spine[i - 1].x, spine[i].y - spine[i - 1].y);
        const flank = poly[poly.length - 1 - i];
        const half = Math.hypot(flank.x - spine[i].x, flank.y - spine[i].y);
        // A segment with no length has no meaningful inner radius, and the
        // offset curve a highlight rides on does produce them at hairpins.
        if (turn < 1e-6 || !Number.isFinite(turn) || step < 0.5) continue;
        const innerRadius = step / turn - half;
        sharpest = Math.min(sharpest, innerRadius);
      }
    }
  }

  ok('arms were drawn', ribbons > 100, `${ribbons} ribbons`);
  ok('and none of them covers a window', overGlass === 0, `${overGlass} points on glass`);
  ok('and none of them leaves the wall', offTheWall === 0, `${offTheWall} points off it`);
  ok('and no bend turns a ribbon inside out', sharpest > 0,
    `tightest inner radius ${sharpest.toFixed(1)} px`);
}

{
  /**
   * Rooted. An arm holds station by probing from its far end, and the near end
   * has to stay in the breach it came out of — an earlier version retired the
   * *oldest* joint each step instead, so the base crept forward until the whole
   * arm had walked out of its own hole and was crawling the wall attached to
   * nothing.
   */
  const { seen, state } = run(breach, { ...base, rate: 60, heal: 0, arms: 2, holes: 1, reach: 0.4 }, 3000);
  ok('arms were drawn for the whole run', seen.length === 3000);
  let strayed = 0;
  for (const hole of state.holes) {
    for (const arm of hole.arms || []) {
      const drift = Math.hypot(arm.path[0].x - arm.origin.x, arm.path[0].y - arm.origin.y);
      if (drift > 1) strayed += 1;
    }
  }
  ok('and every one is still rooted where it came out', strayed === 0, `${strayed} adrift`);
}

{
  /**
   * Thickness is a fact about the limb, not about how far out it happens to be.
   * Taken as a fraction of the current length it rescales the whole arm as it
   * grows, and you can watch it slim down as it reaches.
   */
  const { seen } = run(breach, { ...base, rate: 60, heal: 0, arms: 1, holes: 1, writhe: 0 }, 1500);
  const nearBase = [];
  for (const g of seen.slice(400)) {
    const s0 = spinesIn(g)[0];
    // Long arms only. Thickness near the base is a fact about the limb, but the
    // last stretch of *any* arm is its growing point and is legitimately thin —
    // so on a short arm the sample point is inside that and the two properties
    // are not separable. Twenty joints puts it clear.
    if (!s0 || s0.spine.length < 20) continue;
    // Half-width three joints out from the hole, which is always the same
    // distance along the arm whatever the arm is doing.
    const i = 3;
    const flank = s0.poly[s0.poly.length - 1 - i];
    nearBase.push(Math.hypot(flank.x - s0.spine[i].x, flank.y - s0.spine[i].y));
  }
  const spread = Math.max(...nearBase) - Math.min(...nearBase);
  ok('a fixed point on the arm keeps a fixed thickness as it grows',
    nearBase.length > 100 && spread < 1.5, `${spread.toFixed(2)} px of variation`);
}

{
  // Explorative: an arm that grew, held and pulled back should have covered
  // ground rather than sat still, and should not be where it started.
  const { seen } = run(breach, { ...base, rate: 60, heal: 0, arms: 1, holes: 1 }, 2400);
  const lengths = seen.map((g) => {
    const s0 = spinesIn(g)[0];
    if (!s0) return 0;
    let len = 0;
    for (let i = 1; i < s0.spine.length; i++) {
      len += Math.hypot(s0.spine[i].x - s0.spine[i - 1].x, s0.spine[i].y - s0.spine[i - 1].y);
    }
    return len;
  });
  const grew = Math.max(...lengths);
  ok('an arm reaches out over the wall', grew > 200, `${grew.toFixed(0)} px`);
  const shortest = Math.min(...lengths.slice(600).filter((l) => l > 0));
  ok('and pulls back again to try elsewhere', shortest < grew * 0.5,
    `${shortest.toFixed(0)} px at its shortest, against ${grew.toFixed(0)}`);
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

console.log('\n— the two layers agree about the bricks —');

{
  /**
   * Brickwork lays a wall, Breach takes bricks out of it. If the two disagree
   * about the course, the holes land across brick faces and the whole thing
   * falls apart — and keeping three numbers in step by hand across two panels
   * is a chore with a wrong answer waiting in it.
   *
   * They are wired through the renderer's notice board, so the test drives both
   * effects with one shared Map exactly as the renderer does.
   */
  const share = new Map();
  const brickP = { ...defaultParams('brickwork'), brickW: 96, brickH: 30, gap: 6, obstacles: '' };
  const breachP = { ...defaultParams('breach'), obstacles: '', rate: 60, heal: 0, arms: 0,
    // Deliberately wrong, to prove they are not simply both on the defaults.
    brickW: 210, brickH: 70, gap: 14 };

  const bState = brickwork.init();
  const xState = breach.init();
  const rng = makeRng('pair');
  let g = null;
  let t = 0;
  for (let f = 0; f < 900; f++) {
    t += 1 / 60;
    const common = { stable: null, shape: wall, shapes: () => [], t, dt: 1 / 60, rng,
      i: 0, n: 1, beat: 0, beatPhase: 0, bpm: 120, audio: { level: 0, low: 0, mid: 0, high: 0 }, share };
    brickwork.draw({ ...common, g: recordingContext(), p: brickP, stable: brickP, state: bState });
    g = recordingContext();
    breach.draw({ ...common, g, p: breachP, stable: breachP, state: xState });
  }

  const published = share.get(`brickwork:${wall.id}`);
  ok('the wall publishes the course it laid', published?.w === 96 && published?.h === 30,
    JSON.stringify(published));

  const voids = g.rects.filter((r) => r.style === breachP.void);
  ok('bricks came out', voids.length > 0, `${voids.length}`);

  /**
   * Every void should be one brick of the *laid* course, grown by the mortar
   * joint — which is how neighbouring gaps merge into one hole. Against its own
   * setting of 210 × 70 it would be nowhere near.
   */
  const wrong = voids.filter((r) =>
    Math.abs(r.w - (96 + 6 * 2)) > 0.51 || Math.abs(r.h - (30 + 6 * 2)) > 0.51);
  ok('and every one is the size of a laid brick, not of its own setting',
    wrong.length === 0, `${wrong.length} of ${voids.length} the wrong size`);

  // And they sit on the course, not across it.
  const pitchY = 30 + 6;
  const offCourse = voids.filter((r) => {
    const rows = (r.y + 6 - wall.bbox.y) / pitchY;
    return Math.abs(rows - Math.round(rows)) > 0.02;
  });
  ok('and lands on a course rather than across two', offCourse.length === 0,
    `${offCourse.length} off the course`);
}

{
  // And it can still be told not to, for a wall that is already brick.
  const share = new Map();
  share.set(`brickwork:${wall.id}`, { w: 96, h: 30, gap: 6 });
  const p = { ...defaultParams('breach'), obstacles: '', rate: 60, heal: 0, arms: 0,
    match: false, brickW: 210, brickH: 70, gap: 14 };
  const state = breach.init();
  const rng = makeRng('nomatch');
  let g = null;
  let t = 0;
  for (let f = 0; f < 900; f++) {
    t += 1 / 60;
    g = recordingContext();
    breach.draw({ g, p, stable: p, shape: wall, shapes: () => [], t, dt: 1 / 60, rng, state,
      i: 0, n: 1, beat: 0, beatPhase: 0, bpm: 120, audio: { level: 0, low: 0, mid: 0, high: 0 }, share });
  }
  const voids = g.rects.filter((r) => r.style === p.void);
  ok('with matching off it uses its own brick size',
    voids.length > 0 && voids.every((r) => Math.abs(r.w - (210 + 14 * 2)) < 0.51),
    `${voids.length} gaps`);
}

console.log('\n— arms are individuals —');

{
  const { seen, state } = run(breach, { ...base, rate: 60, heal: 0, arms: 4, holes: 1 }, 1500);
  ok('the run produced frames', seen.length === 1500);
  const arm = state.holes[0]?.arms || [];
  const paces = arm.map((a) => a.pace);
  ok('every arm has its own pace', new Set(paces).size === paces.length, paces.map((x) => x?.toFixed(2)).join(', '));

  /**
   * And it shows. Pace existed nowhere before this — `arm.rate` was only ever
   * used by the sway — so every tentacle on the house extended at exactly the
   * same speed, which is the kind of wrongness you feel before you can name it.
   */
  const lengths = arm.map((a) => a.path.length);
  ok('so they are not all the same length at the same moment',
    new Set(lengths).size > 1, lengths.join(', '));
}

{
  /**
   * A healing hole pulls its arms back in before the bricks return. It used to
   * fade the whole thing out over a couple of seconds, arms included, so a
   * tentacle three metres up the wall went thin and then stopped existing —
   * which reads as a dropped frame rather than as anything retreating.
   */
  const { state } = run(breach, { ...base, rate: 60, heal: 5, holes: 1, arms: 3, cluster: 2 }, 4200);
  ok('nothing is left over at the end', Array.isArray(state.holes));
  ok('no hole ever starts closing with an arm still out',
    !state.brokeWithdrawal, state.brokeWithdrawal || '');
}

console.log(failures ? `\n${failures} failing` : '\nall good');
process.exit(failures ? 1 : 0);
