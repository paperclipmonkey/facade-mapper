/**
 * Effects, driven through a recording 2D context.
 *
 * Most of the library can only really be judged by eye, but some of it makes
 * claims that are checkable: a stripe that is supposed to travel continuously
 * must not jump, and text laid along a path must not fall off the end of it.
 * Both of those shipped broken, and both are the kind of fault you see once,
 * fail to reproduce on demand, and then argue about.
 *
 * The context stub records the calls instead of rasterising, so this runs in
 * plain Node with no DOM.
 *
 *   node test/effects.test.mjs
 */

import { getEffect, defaultParams } from '../js/effects/registry.js';
import { buildPathSampler, boundingBox, makeRng } from '../js/core/math.js';
import { defaultNoise } from '../js/core/noise.js';
import { resolveParams, baseParams } from '../js/core/modulators.js';

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

/* ------------------------------------------------------------------ *
 * A 2D context that writes down what it was asked to draw
 * ------------------------------------------------------------------ */

function recordingContext() {
  const calls = [];
  const state = { fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1 };
  let current = null;

  /**
   * Translation only, but tracked.
   *
   * Effects that place things — text on a path especially — do it by
   * translating the context and drawing at a local offset, so a stub that
   * throws `translate` away records every glyph at the same coordinate and any
   * assertion about placement is vacuous. Rotation is ignored on purpose: it
   * turns a glyph about the origin the translate just established, so it does
   * not move where the glyph *is*.
   */
  let tx = 0;
  let ty = 0;
  const stack = [];

  const ctx = {
    calls,
    get fillStyle() { return state.fillStyle; },
    set fillStyle(v) { state.fillStyle = v; },
    get strokeStyle() { return state.strokeStyle; },
    set strokeStyle(v) { state.strokeStyle = v; },
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    lineWidth: 1,
    lineJoin: 'miter',
    lineCap: 'butt',
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    filter: 'none',
    shadowBlur: 0,
    shadowColor: '',
    lineDashOffset: 0,

    clip() {}, rotate() {}, scale() {}, rect() {},
    setTransform() {}, resetTransform() {}, setLineDash() {}, closePath() {},
    fillRect() {}, strokeRect() {}, arc() {}, ellipse() {}, drawImage() {},
    putImageData() {}, createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    // Widths must track the font size, or a shrink-to-fit loop can never
    // converge and the test measures the stub rather than the code.
    measureText: (s) => {
      const px = parseFloat((/(\d+(?:\.\d+)?)px/.exec(ctx.font) || [])[1]) || 10;
      return { width: s.length * px * 0.6 };
    },

    save() { stack.push([tx, ty]); },
    restore() { const p = stack.pop(); if (p) { [tx, ty] = p; } },
    translate(x, y) { tx += x; ty += y; },

    beginPath() { current = []; },
    moveTo(x, y) { current = [{ x: x + tx, y: y + ty }]; },
    lineTo(x, y) { if (current) current.push({ x: x + tx, y: y + ty }); },
    fill() { calls.push({ op: 'fill', style: state.fillStyle, points: current ? [...current] : [] }); },
    stroke() { calls.push({ op: 'stroke', style: state.strokeStyle, points: current ? [...current] : [] }); },
    fillText(text, x, y) { calls.push({ op: 'fillText', text, x: x + tx, y: y + ty, font: ctx.font }); },
    strokeText() {},
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createConicGradient: () => ({ addColorStop() {} }),
  };
  return ctx;
}

/** A shape as the renderer's geometry cache hands it over. */
function geo(points, { closed = true, id = 's' } = {}) {
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

function drawAt(effect, shape, params, t) {
  const g = recordingContext();
  const state = {};
  const ctx = {
    g,
    t,
    dt: 1 / 60,
    beat: t * 2,
    beatPhase: (t * 2) % 1,
    bpm: 120,
    audio: { level: 0, low: 0, mid: 0, high: 0 },
    i: 0,
    n: 1,
    shape,
    world: { w: 1920, h: 1080 },
    layer: {},
    state,
    rng: () => 0.5,
    noise: { noise2: () => 0, noise3: () => 0 },
    media: () => null,
    camera: () => null,
    shapes: () => [],
    preview: false,
    p: { ...defaultParams(effect.id), ...params },
  };
  if (effect.init) Object.assign(state, effect.init(ctx) || {});
  // Simulation first, then paint — the order the renderer uses.
  effect.step?.({ ...ctx, g: null });
  effect.draw(ctx);
  return g.calls;
}

/* ------------------------------------------------------------------ *
 * Candy stripe: a barber's pole must never jump
 * ------------------------------------------------------------------ */

console.log('— candy stripe —');
{
  const effect = getEffect('candy-stripe');
  const door = geo([
    { x: 800, y: 600 }, { x: 1000, y: 600 }, { x: 1000, y: 1000 }, { x: 800, y: 1000 },
  ]);
  const params = { color: '#e01b24', color2: '#ffffff', stripes: 16, angle: 0, speed: 0.18, mode: 'fill', width: 20 };

  /**
   * The leading edge of the first red band. If the pattern is continuous this
   * advances smoothly and wraps by exactly one *pair* of stripes; if the
   * colours flip at the wrap — which is what a one-period wrap does, because a
   * band's colour comes from the parity of its index — it jumps by one stripe
   * and every stripe changes colour at once.
   */
  const redEdge = (t) => {
    const reds = drawAt(effect, door, params, t)
      .filter((c) => c.op === 'fill' && c.style === params.color && c.points.length)
      .map((c) => Math.min(...c.points.map((pt) => pt.x)))
      .sort((a, b) => a - b);
    return reds;
  };

  // One full cycle of the *pattern* is two stripe periods, so at 0.18 stripes
  // per second that is 2 / 0.18 seconds. Sample densely across the moment the
  // old code jumped — one period in, at t = 1 / 0.18.
  const step = 0.02;
  const around = 1 / params.speed;
  let worstJump = 0;
  let previous = redEdge(around - 0.4);
  for (let t = around - 0.4 + step; t <= around + 0.4; t += step) {
    const now = redEdge(t);
    if (previous.length && now.length) {
      // Match each red band to its nearest neighbour a frame later. Continuous
      // motion means the nearest is close; a colour flip means every band is
      // half a period away.
      for (const edge of previous) {
        const nearest = Math.min(...now.map((x) => Math.abs(x - edge)));
        worstJump = Math.max(worstJump, nearest);
      }
    }
    previous = now;
  }

  const period = (Math.hypot(200, 400) * 1.2) / 16;
  ok(
    'stripes never jump across the wrap',
    worstJump < period * 0.35,
    `worst step ${worstJump.toFixed(1)}px against a ${period.toFixed(1)}px stripe`
  );

  // And the pattern really does repeat over two periods, not one.
  const sig = (t) => redEdge(t).map((x) => x.toFixed(2)).join(',');
  ok(
    'the pattern repeats every two stripe periods',
    sig(3) === sig(3 + 2 / params.speed),
    'same red edges one full cycle later'
  );
  ok(
    'and is genuinely different half a cycle in',
    sig(3) !== sig(3 + 1 / params.speed),
    'a one-period wrap would have made these identical'
  );
}

/* ------------------------------------------------------------------ *
 * Text on something flat: the Size control has to do something
 * ------------------------------------------------------------------ */

console.log('\n— text on a flat shape —');
{
  const effect = getEffect('text');
  /**
   * A guide line traced across the wall to write along — an open polyline, dead
   * horizontal, which is how anybody would draw one. Its bounding box has no
   * height whatsoever, and the size was taken as a multiple of that height.
   */
  const line = geo(
    [{ x: 300, y: 620 }, { x: 1500, y: 620 }],
    { closed: false, id: 'wall-text' }
  );

  const sizeOf = (calls) => {
    const drawn = calls.find((c) => c.op === 'fillText');
    return drawn ? parseFloat((/(\d+(?:\.\d+)?)px/.exec(drawn.font) || [])[1]) : 0;
  };

  const small = sizeOf(drawAt(effect, line, { content: 'BOO', mode: 'box', size: 0.2 }, 1));
  const large = sizeOf(drawAt(effect, line, { content: 'BOO', mode: 'box', size: 1.5 }, 1));

  ok('text on a flat path is not stuck at the minimum', small > 4, `${small.toFixed(1)}px at size 0.2`);
  ok('and Size actually changes it', large > small * 3, `${small.toFixed(1)}px -> ${large.toFixed(1)}px`);
  ok('at a size worth reading from the road', large > 300, `${large.toFixed(1)}px on a 1200px line`);

  // An area is still measured by its box, so nothing that worked has moved.
  const window = geo(
    [{ x: 400, y: 300 }, { x: 700, y: 300 }, { x: 700, y: 700 }, { x: 400, y: 700 }],
    { id: 'window' }
  );
  // Capped by the narrower of the height and nine tenths of the width, as it
  // always was: min(400, 300 * 0.9) * 0.5.
  const inWindow = sizeOf(drawAt(effect, window, { content: 'BOO', mode: 'box', size: 0.5 }, 1));
  ok('text in a window is still measured by the window', Math.abs(inWindow - 135) < 1, `${inWindow.toFixed(1)}px in a 300x400 box`);
}

/* ------------------------------------------------------------------ *
 * Text on a path: it has to fit on the path
 * ------------------------------------------------------------------ */

console.log('\n— text on a path —');
{
  const effect = getEffect('text');
  // A short arch, and a phrase far too long for it at the requested size.
  const arch = geo(
    [{ x: 800, y: 500 }, { x: 900, y: 460 }, { x: 1000, y: 500 }],
    { closed: false, id: 'arch' }
  );
  const pathLen = arch.sampler.length;
  const base = { content: 'MERRY CHRISTMAS', mode: 'path', size: 2, tracking: 0.1, align: 'centre' };

  const fitted = drawAt(effect, arch, { ...base, fit: true }, 1).filter((c) => c.op === 'fillText');
  const overflowing = drawAt(effect, arch, { ...base, fit: false }, 1).filter((c) => c.op === 'fillText');

  ok('every glyph is drawn', fitted.length === [...base.content].length, `${fitted.length} glyphs`);

  /**
   * The symptom of overflow is glyphs landing on top of each other.
   *
   * `sampler.at` clamps at the ends of an open path, so everything past the end
   * stacks on the final point — which is why the sign read "ERRY CHRISTM": the
   * M and the A-S were all sitting on the last vertex on top of one another.
   */
  const distinct = (calls) => new Set(calls.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`)).size;

  ok(
    'overflowing text really does stack glyphs on the end of the path',
    distinct(overflowing) < overflowing.length,
    `${distinct(overflowing)} distinct positions for ${overflowing.length} glyphs`
  );
  ok(
    'fitted text gives every glyph its own place',
    distinct(fitted) === fitted.length,
    `${distinct(fitted)} distinct positions for ${fitted.length} glyphs`
  );

  // Turning it off has to still work, for scrolling text along a path.
  ok('fit can be switched off', overflowing.length === [...base.content].length);

  // Text that already fits is left alone.
  const roomy = geo([{ x: 0, y: 500 }, { x: 1900, y: 500 }], { closed: false, id: 'wide' });
  const small = { ...base, size: 0.2 };
  const a = drawAt(effect, roomy, { ...small, fit: true }, 1).filter((c) => c.op === 'fillText');
  const b = drawAt(effect, roomy, { ...small, fit: false }, 1).filter((c) => c.op === 'fillText');
  ok(
    'text that already fits is untouched',
    a.length === b.length && a.every((c, i) => Math.abs(c.x - b[i].x) < 1e-9),
    `path ${roomy.sampler.length}px, arch ${pathLen.toFixed(0)}px`
  );
}

/* ------------------------------------------------------------------ *
 * Modulation must not invalidate a cache
 *
 * The rule effects rely on: `stable` is the parameters before modulation, so a
 * cache key built from it survives a slider being bound to the microphone.
 * Building the key from `p` instead is what made binding an audio modulator
 * bring the whole machine to a crawl — every frame a different number, every
 * frame a megabyte of cached growth thrown away and regenerated.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Blood only runs downhill
 * ------------------------------------------------------------------ */

console.log('\n— blood drip —');
{
  const effect = getEffect('blood-drip');
  const shape = geo([{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 600 }, { x: 0, y: 600 }]);
  const p = { ...defaultParams('blood-drip'), speed: 0.4 };
  const state = effect.init();
  const rng = makeRng('blood');
  let t = 0;
  let back = 0;
  let landed = false;
  let faded = 0;
  let restarts = 0;
  let prev = null;

  for (let f = 0; f < 7200; f++) {
    t += 1 / 60;
    const ctx = {
      g: recordingContext(), p, stable: p, shape, shapes: () => [],
      t, dt: 1 / 60, rng, state, noise: defaultNoise,
      i: 0, n: 1, beat: 0, beatPhase: 0, bpm: 120,
      audio: { level: 0, low: 0, mid: 0, high: 0 },
    };
    effect.step?.({ ...ctx, g: null });
    effect.draw(ctx);
    const d = state.drips[0];
    if (prev !== null) {
      if (d.pos < prev - 1e-9 && d.pos !== 0) back += 1;
      if (d.pos === 0 && prev > 0.9) restarts += 1;
    }
    if (d.alpha < 1 && d.alpha > 0) faded += 1;
    if (d.pos >= 1) landed = true;
    prev = d.pos;
  }

  /**
   * The one that matters. Stick-slip used to be a factor on the head's
   * *position*, so when the noise fell the bead climbed back up the door — a
   * visible bounce two or three times a second. Surface tension holds a drip
   * still; it does not lift it. The noise gates the speed now, and the position
   * is integrated, so this is monotone by construction.
   */
  ok('a drip never travels back up the door', back === 0, `${back} upward frames`);
  ok('it reaches the bottom', landed);
  ok('and fades there rather than snapping back', faded > 100, `${faded} fading frames`);
  ok('then starts again', restarts > 0, `${restarts} cycles`);
}

console.log('\n— modulation and caches —');
{
  const effect = getEffect('vine');
  const layer = {
    id: 'L1',
    params: { thickness: 4, color: '#2f6b32', tip: '#8fe36b' },
    bindings: { thickness: { type: 'audio', band: 'level', depth: 8 } },
  };

  const at = (level) => {
    const ctx = {
      t: 1, dt: 1 / 60, beat: 2, beatPhase: 0, bpm: 120,
      audio: { level, low: level, mid: level, high: level },
      i: 0, n: 1, shape: null,
    };
    return {
      p: resolveParams(effect, layer, ctx),
      stable: baseParams(effect, layer),
    };
  };

  const quiet = at(0);
  const loud = at(0.9);

  ok('a bound parameter really does move', Math.abs(quiet.p.thickness - loud.p.thickness) > 1,
    `${quiet.p.thickness} vs ${loud.p.thickness}`);
  ok('the stable value does not', quiet.stable.thickness === loud.stable.thickness,
    `${quiet.stable.thickness}`);
  ok('stable keeps the layer value, not the effect default',
    quiet.stable.thickness === 4, `${quiet.stable.thickness}`);

  // The key the vine actually builds. If any of these move with the audio, the
  // offscreen canvas is thrown away every frame.
  const keyOf = (r) => [Math.round(1000), Math.round(500), r.stable.color, r.stable.tip,
    Number(r.stable.thickness).toFixed(1)].join('|');
  ok('the cache key is identical loud and quiet', keyOf(quiet) === keyOf(loud), keyOf(quiet));
}

console.log('\n— bindings on non-numeric parameters —');
{
  const effect = getEffect('vine');
  const layer = {
    id: 'L2',
    // Not reachable through the UI, but an imported or hand-edited project can
    // carry one, and the old code turned the colour into a bare number.
    params: { color: '#2f6b32' },
    bindings: { color: { type: 'audio', band: 'level', depth: 5 } },
  };
  const p = resolveParams(effect, layer, {
    t: 1, dt: 1 / 60, beat: 0, beatPhase: 0, bpm: 120,
    audio: { level: 0.7, low: 0, mid: 0, high: 0 }, i: 0, n: 1, shape: null,
  });
  ok('a colour with a stray binding stays a colour', p.color === '#2f6b32', String(p.color));
}

console.log('\n— rand() inside an expression binding —');
{
  /**
   * Two properties, and they pull in opposite directions.
   *
   * It must give the *same* answer in two tabs at the same show time, or the
   * projectors disagree — that is why it is seeded rather than left to run as a
   * stream. But it must give *different* answers to two different bindings, or
   * every slider driven by `rand()` across the whole show moves as one, which is
   * a stream's one virtue and easy to lose while fixing the other thing.
   */
  const effect = getEffect('vine');
  const at = (layerId, key, t) => {
    const layer = { id: layerId, params: { [key]: 0 }, bindings: { [key]: { type: 'expr', code: 'rand()' } } };
    return resolveParams(effect, layer, {
      t, dt: 1 / 60, beat: 0, beatPhase: 0, bpm: 120,
      audio: { level: 0, low: 0, mid: 0, high: 0 }, i: 0, n: 1, shape: null,
    })[key];
  };

  // Both parameters span 0..1, so the resolved value is the draw itself rather
  // than the draw clamped to a range — which would compare equal for the wrong
  // reason and quietly make three of these four assertions vacuous.
  ok('the same binding at the same show time agrees between tabs',
    at('L1', 'branch', 3) === at('L1', 'branch', 3),
    `${at('L1', 'branch', 3)}`);

  ok('and it moves on as the show does',
    at('L1', 'branch', 3) !== at('L1', 'branch', 9));

  ok('two layers do not draw the same number',
    at('L1', 'branch', 3) !== at('L2', 'branch', 3),
    `${at('L1', 'branch', 3)} vs ${at('L2', 'branch', 3)}`);

  ok('nor do two parameters of one layer',
    at('L1', 'branch', 3) !== at('L1', 'cling', 3),
    `${at('L1', 'branch', 3)} vs ${at('L1', 'cling', 3)}`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
