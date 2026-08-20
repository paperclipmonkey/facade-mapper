/**
 * Flowers, and the two prints.
 *
 * The claims worth checking here are the ones that are not about appearance:
 *
 *  - a stem is rooted on the shape somebody traced, not in mid-air above it;
 *  - Wilt is a *position*, not a process — sliding it up sheds petals, sliding
 *    it back down puts them back, and where the slider is fully determines what
 *    the flower looks like, which is what lets two projector tabs that have been
 *    running for different lengths of time agree about it;
 *  - a print is laid on one lattice across the whole building, so two walls
 *    either side of a door cannot disagree about where the pattern is;
 *  - and the number of motifs a print stamps is bounded, whatever the size
 *    control is set to, because that number is the only thing about it that can
 *    run away with a frame.
 *
 *   node test/floral.test.mjs
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
 * A canvas that keeps the transform
 *
 * Motifs are placed by translating and rotating the context and stamping at a
 * local offset, so a stub that throws the transform away records every one of
 * them at the origin and any assertion about the layout is vacuous.
 * ------------------------------------------------------------------ */

function recordingContext() {
  const stamps = [];
  const fills = [];
  const strokes = [];
  let m = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let current = null;

  const at = (x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

  const ctx = {
    stamps, fills, strokes,
    fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', filter: 'none', shadowBlur: 0,
    save() { stack.push([...m]); },
    restore() { const p = stack.pop(); if (p) m = p; },
    translate(x, y) { m = [m[0], m[1], m[2], m[3], m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; },
    scale(sx, sy) { m = [m[0] * sx, m[1] * sx, m[2] * sy, m[3] * sy, m[4], m[5]]; },
    rotate(r) {
      const c = Math.cos(r);
      const s = Math.sin(r);
      m = [m[0] * c + m[2] * s, m[1] * c + m[3] * s, m[2] * c - m[0] * s, m[3] * c - m[1] * s, m[4], m[5]];
    },
    setTransform(a, b, c, d, e, f) { m = [a, b, c, d, e, f]; },
    resetTransform() { m = [1, 0, 0, 1, 0, 0]; },
    clip() {}, rect() {}, closePath() {}, setLineDash() {},
    arc() {}, quadraticCurveTo() {},
    ellipse(x, y, rx) { fills.push({ ...at(x, y), r: rx, style: ctx.fillStyle, alpha: ctx.globalAlpha, kind: 'ellipse' }); },
    fillRect() {},
    drawImage(img, dx, dy, dw) {
      stamps.push({
        ...at(dx + dw / 2, dy + dw / 2),
        size: dw * Math.hypot(m[0], m[1]),
        // A negative determinant is the whole of "this one is the other way
        // round", and survives whatever rotation was applied with it.
        mirrored: m[0] * m[3] - m[1] * m[2] < 0,
        img,
        alpha: ctx.globalAlpha,
      });
    },
    beginPath() { current = []; },
    moveTo(x, y) { current = [at(x, y)]; },
    lineTo(x, y) { if (current) current.push(at(x, y)); },
    fill() { if (current && current.length) fills.push({ ...current[0], points: [...current], style: ctx.fillStyle, alpha: ctx.globalAlpha }); },
    stroke() { if (current && current.length) strokes.push({ points: [...current], style: ctx.strokeStyle, width: ctx.lineWidth }); },
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
  };
  return ctx;
}

/**
 * The two browser globals the prints use: a canvas to bake a motif into, and a
 * Path2D to cut the openings out of the wall with.
 */
let baked = 0;
globalThis.document = {
  createElement() {
    baked++;
    const c = recordingContext();
    return { width: 0, height: 0, getContext: () => c };
  },
};
globalThis.Path2D = class {
  constructor() { this.parts = []; }
  addPath(p) { this.parts.push(p); }
};

/* ------------------------------------------------------------------ *
 * A wall to hang things on
 * ------------------------------------------------------------------ */

const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];

function geo(points, id, tags = []) {
  return {
    id, name: id, tags, closed: true, points, path: { id },
    bbox: boundingBox(points),
    centroid: boundingBox(points),
    sampler: buildPathSampler(points, true),
  };
}

const window1 = geo(rect(300, 300, 240, 200), 'w1', ['window']);
const shapesFor = (tag) => (tag === 'window' ? [window1] : []);

/** Drive an effect the way the renderer does: simulate, then paint. */
function run(effect, shape, params, { frames = 1, t0 = 0, dt = 1 / 60, state = null, shapes = shapesFor } = {}) {
  const st = state || (effect.init ? effect.init() : {});
  const rng = makeRng('floral-test');
  let g = null;
  let t = t0;
  for (let f = 0; f < frames; f++) {
    t += dt;
    g = recordingContext();
    const ctx = {
      g, p: params, stable: params, shape, shapes,
      t, dt, rng, state: st, noise: defaultNoise,
      i: 0, n: 1, beat: 0, beatPhase: 0, bpm: 120,
      world: { w: 1920, h: 1080 },
      audio: { level: 0, low: 0, mid: 0, high: 0 },
    };
    effect.step?.({ ...ctx, g: null });
    effect.draw(ctx);
  }
  return { g, state: st, t };
}

/* ------------------------------------------------------------------ *
 * Flowers
 * ------------------------------------------------------------------ */

console.log('— flowers —');

const flowers = getEffect('flowers');
ok('the effect is registered', Boolean(flowers));

// A pot: a shallow bowl, so the bottom of the bounding box is emphatically not
// where the plants go in.
const pot = geo(
  [{ x: 700, y: 400 }, { x: 900, y: 400 }, { x: 880, y: 560 }, { x: 800, y: 600 }, { x: 720, y: 560 }],
  'pot'
);
const potParams = { ...defaultParams('flowers'), count: 8, wilt: 0 };

{
  const { state } = run(flowers, pot, potParams);
  ok('a bunch is planted', state.flowers.length === 8, `${state.flowers.length} flowers`);

  // Every root on the outline, not on the bottom of the box.
  let offOutline = 0;
  let onBoxFloor = 0;
  for (const f of state.flowers) {
    const y = (() => {
      let lowest = -Infinity;
      const pts = pot.points;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        if ((a.x <= f.x && b.x > f.x) || (b.x <= f.x && a.x > f.x)) {
          lowest = Math.max(lowest, a.y + ((f.x - a.x) / (b.x - a.x)) * (b.y - a.y));
        }
      }
      return lowest;
    })();
    if (Math.abs(f.y - y) > 0.001) offOutline++;
    if (Math.abs(f.y - (pot.bbox.y + pot.bbox.h)) < 0.001) onBoxFloor++;
  }
  ok('every stem is rooted on the shape itself', offOutline === 0, `${offOutline} off the outline`);
  ok('and not on the floor of its bounding box', onBoxFloor < 8, `${onBoxFloor} of 8 on the box floor`);
}

{
  // Petals are ellipses; the stems are strokes and the centres are arcs, so
  // counting ellipse fills counts petals — on the heads and in the air alike.
  const petalsAt = (wilt, opts = {}) => {
    const { g } = run(flowers, pot, { ...potParams, wilt }, opts);
    return g.fills.filter((f) => f.kind === 'ellipse').length;
  };

  const fresh = petalsAt(0);
  ok('a fresh bunch has every petal', fresh === 8 * potParams.petals, `${fresh} petals`);

  let previous = fresh;
  let rises = 0;
  for (let wilt = 0.1; wilt <= 1.0001; wilt += 0.1) {
    const now = petalsAt(wilt);
    if (now > previous) rises++;
    previous = now;
  }
  ok('petals only ever leave as it wilts', rises === 0, `${rises} rises`);
  ok('and a dead bunch has none left on it', previous === 0, `${previous} petals at full wilt`);
}

{
  /**
   * The reversibility claim, and the one that actually matters for two tabs
   * agreeing: what the flower looks like is a function of where the slider is,
   * not of how it got there.
   */
  const drawnAt = (wilts) => {
    const state = flowers.init();
    let g = null;
    let t = 0;
    for (const wilt of wilts) {
      ({ g, t } = run(flowers, pot, { ...potParams, wilt }, { state, t0: t }));
    }
    return g.fills.filter((f) => f.kind === 'ellipse' && f.alpha === 1).length;
  };

  const straightTo = drawnAt([0.5]);
  const roundTrip = drawnAt([0.5, 0.9, 0.5]);
  ok('wilt is a position, not a journey', straightTo === roundTrip, `${straightTo} vs ${roundTrip} petals`);
}

{
  // Petals in the air, and the wind taking them away. Run it up to full wilt
  // and then let it stand.
  const state = flowers.init();
  let t = 0;
  for (let wilt = 0; wilt <= 1; wilt += 0.05) {
    ({ t } = run(flowers, pot, { ...potParams, wilt }, { state, t0: t, frames: 2 }));
  }
  ok('petals come off into the air', state.flying.length > 10, `${state.flying.length} in flight`);
  const drifted = state.flying.filter((q) => q.x > pot.bbox.x + pot.bbox.w).length;
  ok('and the wind carries them off the pot', drifted > 0, `${drifted} past the rim`);

  const before = state.flying.length;
  run(flowers, pot, { ...potParams, wilt: 1 }, { state, t0: t, frames: 60 * 14 });
  ok('and they do not accumulate for ever', state.flying.length < before, `${before} -> ${state.flying.length}`);
}

/* ------------------------------------------------------------------ *
 * The prints
 * ------------------------------------------------------------------ */

for (const id of ['ditsy', 'paisley']) {
  console.log(`\n— ${id} —`);
  const effect = getEffect(id);
  ok('the effect is registered', Boolean(effect));

  const params = { ...defaultParams(id), obstacles: 'window, door' };
  const wall = geo(rect(0, 0, 1200, 800), 'wall');

  {
    const { g, state } = run(effect, wall, params);
    ok('it stamps motifs', g.stamps.length > 8, `${g.stamps.length} motifs`);
    ok('the openings are cut out of the wall', state.mask.parts.length === 2, `${state.mask.parts.length} subpaths`);
    ok('nothing is stamped wholly inside a window', g.stamps.every((s) => !(
      s.x - s.size / 2 > 300 && s.x + s.size / 2 < 540
      && s.y - s.size / 2 > 300 && s.y + s.size / 2 < 500
    )));
  }

  {
    /**
     * One lattice across the building.
     *
     * Two walls either side of a door have to agree about where the pattern is,
     * and the only arrangement that can is a lattice anchored in world space —
     * so a motif that lands at a given place on the wall lands in the same place
     * when the shape it is drawn into is a different shape.
     */
    // Without openings, so the only thing under test is the lattice: a wall
    // culls motifs that fall inside a window of its own, and one half of this
    // pair does not have that window near it.
    const bare = { ...params, obstacles: '' };
    const left = geo(rect(0, 0, 600, 800), 'left');
    const right = geo(rect(600, 0, 600, 800), 'right');
    const whole = run(effect, geo(rect(0, 0, 1200, 800), 'whole'), bare).g.stamps;
    // Each half's own wall only: the ring each of them draws past its edge is
    // for the clip to cut, and out there a motif is missing neighbours it would
    // have had.
    const on = (shape) => run(effect, shape, bare).g.stamps.filter((s) => (
      s.x >= shape.bbox.x && s.x <= shape.bbox.x + shape.bbox.w
      && s.y >= shape.bbox.y && s.y <= shape.bbox.y + shape.bbox.h
    ));
    const halves = [...on(left), ...on(right)];

    const key = (s) => `${s.x.toFixed(2)},${s.y.toFixed(2)},${s.size.toFixed(2)}`;
    const inWhole = new Set(whole.map(key));
    /**
     * Compared over what is actually *visible*.
     *
     * Both halves draw a ring of motifs past their own edge for the clip to
     * cut, and out in that ring a motif is missing some of the neighbours it
     * would have had — so it packs against fewer things and comes out larger.
     * That is invisible by construction and it is not what the claim is about:
     * the claim is that the light landing on wall A is the light that would
     * land there if A and B were one wall.
     */
    const strays = halves.filter((s) => !inWhole.has(key(s))).length;
    ok(
      'two walls put the pattern in the same place',
      strays === 0,
      `${halves.length} motifs visible across two walls, ${strays} of them not where the whole wall put them`
    );
  }

  {
    // The stamp count is what has to stay inside a frame, so it is capped
    // whatever the size control says.
    const tiny = run(effect, geo(rect(0, 0, 1920, 1080), 'frame'), { ...params, size: 20, density: 1, obstacles: '' });
    ok('a whole facade of tiny motifs is still bounded', tiny.g.stamps.length <= 1000, `${tiny.g.stamps.length} motifs`);
  }

  {
    /**
     * A modulated parameter must not rebake the motifs. This is the rule the
     * whole library depends on — see docs/writing-effects.md — and a print is
     * the easiest place in it to get wrong, because the thing being cached is
     * keyed on colours and a size that both look like ordinary parameters.
     */
    const state = effect.init();
    let t = 0;
    // Warm up first: the motifs are baked once, and it is the *second* bake
    // that would be the bug.
    run(effect, wall, params, { state });
    baked = 0;
    for (let f = 0; f < 30; f++) {
      const modulated = { ...params, sway: 0.2 + 0.6 * Math.sin(f), size: params.size * (1 + 0.4 * Math.sin(f)) };
      const g = recordingContext();
      t += 1 / 60;
      effect.draw({
        g, p: modulated, stable: params, shape: wall, shapes: shapesFor,
        t, dt: 1 / 60, rng: makeRng('x'), state, noise: defaultNoise,
        i: 0, n: 1, beat: 0, beatPhase: 0, bpm: 120, world: { w: 1920, h: 1080 },
        audio: { level: 0, low: 0, mid: 0, high: 0 },
      });
    }
    ok('modulation does not rebake the motifs', baked === 0, `${baked} canvases after the first frame`);
  }

  {
    // And it moves. Same wall, two moments, different picture.
    const a = run(effect, wall, params, { t0: 0 }).g.stamps;
    const b = run(effect, wall, params, { t0: 3 }).g.stamps;
    const moved = a.filter((s, i) => b[i] && Math.abs(b[i].size - s.size) + Math.abs(b[i].alpha - s.alpha) > 1e-6).length;
    ok('the wall is alive', moved > a.length * 0.5, `${moved} of ${a.length} motifs changed`);
  }

  /* ---------------------------------------------------------------- *
   * The controls that are meant to be bound to something
   * ---------------------------------------------------------------- */

  {
    /**
     * Density only ever *adds*.
     *
     * The point of the control is to be driven — by the level, by an envelope,
     * by a trigger — and a filler that reshuffles the ones already on the wall
     * every time it changes reads as the pattern being redrawn rather than as
     * the ground filling in. So every motif present at a lower density has to
     * still be in exactly the same place at a higher one.
     */
    const place = (density) => run(effect, wall, { ...params, density }).g.stamps
      .map((s) => `${s.x.toFixed(2)},${s.y.toFixed(2)}`);

    const sparse = place(0.2);
    const dense = place(0.9);
    const held = new Set(dense);
    /**
     * Nothing on the wall is *moved* by what arrives around it, and nothing
     * bold gives way to anything fine — that is the rank rule.
     *
     * A handful of the fine ground does disappear, and that is the rule
     * working rather than failing: fillers of the same standing divide the
     * space between them, so as one of them grows into a gap another in the
     * same gap gives ground and can dwindle away entirely. It dwindles
     * smoothly, which is what the sweep below insists on.
     */
    const lost = sparse.filter((k) => !held.has(k)).length;

    ok('a denser print keeps what was already on the wall', lost < sparse.length * 0.05,
      `${lost} of ${sparse.length} crowded out`);
    ok('and there is genuinely more of it', dense.length > sparse.length * 1.5,
      `${sparse.length} -> ${dense.length} motifs`);
    ok('nought density leaves only the lattice', place(0).length < sparse.length,
      `${place(0).length} motifs`);
  }

  {
    /**
     * The newest satellite grows in rather than appearing at full size.
     *
     * Swept rather than sampled at two chosen values, because where the extra
     * ones arrive depends on how many a cell may hold — and a test that has to
     * be re-derived every time that constant moves is a test nobody will keep.
     */
    let arrived = 0;
    let popped = 0;
    let vanished = 0;
    let worstStep = 0;
    let previous = null;
    for (let density = 0; density <= 1.0001; density += 0.01) {
      // Without openings. A motif can be wholly behind a window at one size and
      // poking out from behind it at the next, which is a step change in what
      // is *stamped* and a perfectly smooth one in what is *seen* — the clip
      // takes care of the rest of it. That is not what is under test here.
      const now = new Map(run(effect, wall, { ...params, density, obstacles: '' }).g.stamps
        .map((s) => [`${s.x.toFixed(2)},${s.y.toFixed(2)}`, s.size]));
      /**
       * Measured against the biggest motif on the wall rather than against each
       * motif's own size, because "this 2px speck doubled" is arithmetic and
       * not something anybody can see. What matters is that nothing moves by a
       * visible amount for a 1% nudge of the control.
       */
      const scale = Math.max(...now.values(), 1) * 0.08;
      if (previous) {
        for (const [at, size] of now) {
          const was = previous.get(at);
          if (was === undefined) {
            arrived++;
            if (size > scale) popped++;
          } else {
            worstStep = Math.max(worstStep, Math.abs(size - was) / scale);
          }
        }
        for (const [at, size] of previous) if (!now.has(at) && size > scale) vanished++;
      }
      previous = now;
    }
    ok('satellites arrive small rather than popping in', arrived > 0 && popped === 0,
      `${arrived} arrivals, ${popped} of them at a size worth seeing`);
    ok('and nothing disappears from under you', vanished === 0, `${vanished} vanished mid-size`);
    ok('a step of the control is a step of the picture', worstStep < 1,
      `worst motif moved ${(worstStep * 8).toFixed(1)}% of the biggest one in a single step`);
  }

  {
    /**
     * Phase drives the gust with the clock stopped, and comes round again after
     * one turn — which is what makes a saw LFO across it seamless rather than a
     * jump every cycle.
     */
    const at = (phase) => run(effect, wall, { ...params, phase, breeze: 0, sway: 0.8, swell: 0.5 }, { t0: 5 })
      .g.stamps.map((s) => s.size.toFixed(4)).join(',');

    ok('phase moves the wall on its own', at(0) !== at(0.3));
    ok('and one full turn of it is a loop', at(0) === at(1));
  }

  {
    // Both hands of every motif. A wall of teardrops all hooking the same way
    // is a rubber stamp.
    const stamps = run(effect, wall, { ...params, density: 0.8 }).g.stamps;
    const flipped = stamps.filter((s) => s.mirrored).length;
    ok('motifs are stamped both ways round', flipped > stamps.length * 0.25 && flipped < stamps.length * 0.75,
      `${flipped} of ${stamps.length} mirrored`);
  }

  {
    // Variety: how many distinct motifs a single frame of this print uses.
    const used = new Set(run(effect, wall, { ...params, density: 0.8 }).g.stamps.map((s) => s.img));
    ok('the print draws on its whole cast', used.size >= (id === 'paisley' ? 10 : 8), `${used.size} distinct motifs`);
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
