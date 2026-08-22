/**
 * The house under water, held to the physics it claims.
 *
 * Everything in this set is driven from something real — absorption, the
 * dispersion relation, orbital decay, Boyle's law, jet propulsion — and every
 * one of those would fail *silently*. A wave that ignores dispersion still
 * looks like a wave in a still; kelp that sways uniformly still looks like
 * kelp until you notice the seabed is thrashing; a bubble that does not swell
 * is a bubble. You would find none of it out except by standing in front of a
 * house in the dark, wondering why it does not read as water and being unable
 * to say which part is wrong.
 *
 * So each of these is one checkable claim:
 *
 *   - water takes the red out first, and takes more of it the further light
 *     travels. That is the whole reason the deep end is blue.
 *   - every component of the surface obeys ω² = gk, so the long swell outruns
 *     the chop and the pattern never repeats.
 *   - wave motion dies at e^(−kz), which is why a frond thrashes at the tip
 *     and does not move at the holdfast.
 *   - bubbles rise, wander sideways, and grow by exactly the amount the water
 *     above them stops weighing on them.
 *   - a shoal does not swim through the bay window.
 *   - a jellyfish's pulse is asymmetric and adds no drift of its own, and its
 *     tentacles are where the bell was rather than where it is.
 *   - a porpoising dolphin leaves the water at the speed it comes back in at,
 *     and hangs up there for exactly as long as that height is worth.
 *
 *   node test/underwater.test.mjs
 */

import {
  waveTrain,
  orbitalDecay,
  contraction,
  bellAt,
  strandLag,
  porpoise,
  podPlacement,
  stratum,
} from '../js/effects/builtin/underwater.js';
import { waterAbsorb, waterTransmission } from '../js/effects/color.js';
import { getEffect, defaultParams } from '../js/effects/registry.js';
import { boundingBox, buildPathSampler, polygonCentroid, pointInPolygon, makeRng, hexToRgb }
  from '../js/core/math.js';
import { defaultNoise } from '../js/core/noise.js';

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

const G = 9.81;

/* ------------------------------------------------------------------ *
 * A 2D context that writes down where it drew and what with
 *
 * Gradients are recorded too, stops and all, because several of these effects
 * put their entire claim about depth into a gradient — a shaft that does not
 * get bluer down its length has not read the absorption at all, and nothing
 * else about the drawing would show it.
 * ------------------------------------------------------------------ */

function recordingContext() {
  const lines = [];
  const arcs = [];
  const gradients = [];
  const strokes = [];
  let at = null;
  let tx = 0;
  let ty = 0;
  const stack = [];

  const makeGradient = () => {
    const stops = [];
    gradients.push(stops);
    return { addColorStop: (offset, colour) => stops.push([offset, colour]) };
  };

  const ctx = {
    lines, arcs, gradients, strokes,
    fillStyle: '', strokeStyle: '', globalAlpha: 1, globalCompositeOperation: 'source-over',
    lineWidth: 1, lineCap: '', lineJoin: '', font: '', filter: 'none',
    shadowBlur: 0, shadowColor: '', lineDashOffset: 0,
    save() { stack.push([tx, ty]); },
    restore() { const s = stack.pop(); if (s) { [tx, ty] = s; } },
    clip() {}, rotate() {}, scale() {}, setTransform() {}, setLineDash() {}, rect() {},
    translate(x, y) { tx += x; ty += y; },
    beginPath() { at = null; },
    closePath() {},
    moveTo(x, y) { at = { x: x + tx, y: y + ty }; },
    lineTo(x, y) {
      const to = { x: x + tx, y: y + ty };
      if (at) lines.push({ x0: at.x, y0: at.y, x1: to.x, y1: to.y });
      at = to;
    },
    quadraticCurveTo(cx, cy, x, y) { at = { x: x + tx, y: y + ty }; },
    bezierCurveTo(a, b, c, d, x, y) { at = { x: x + tx, y: y + ty }; },
    arc(x, y, r) { arcs.push({ x: x + tx, y: y + ty, r }); },
    ellipse(x, y, rx, ry) { arcs.push({ x: x + tx, y: y + ty, r: Math.max(rx, ry) }); },
    fillRect() {}, strokeRect() {}, fill() {},
    stroke() { strokes.push({ upTo: lines.length, style: ctx.strokeStyle, width: ctx.lineWidth }); },
    fillText() {}, strokeText() {}, measureText: (s) => ({ width: String(s).length * 8 }),
    drawImage() {}, putImageData() {},
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w | 0) * Math.max(1, h | 0) * 4) }),
    createLinearGradient: makeGradient,
    createRadialGradient: makeGradient,
  };
  return ctx;
}

/** Path2D and a canvas element, which several of these ask for. */
globalThis.Path2D = class {
  moveTo() {} lineTo() {} rect() {} closePath() {} arc() {} ellipse() {} addPath() {}
  quadraticCurveTo() {} bezierCurveTo() {}
};
globalThis.document = {
  createElement: () => ({ width: 1, height: 1, getContext: () => recordingContext() }),
};

function makeShape(points, { closed = true, id = 's1', tags = [] } = {}) {
  return {
    id,
    name: id,
    tags,
    closed,
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

const WORLD = { w: 1920, h: 1080 };

/**
 * Run an effect the way the renderer does: `step` at a fixed 60 Hz with a
 * generator reseeded from the step index, then one `draw`.
 */
function run(effectId, { shape, params = {}, seconds = 1, seed = 'test', others = [] }) {
  const effect = getEffect(effectId);
  if (!effect) throw new Error(`no effect ${effectId}`);
  const p = { ...defaultParams(effectId), ...params };
  const state = {};
  const shapes = (tag, exclude) => {
    const wanted = String(tag || '').trim().toLowerCase();
    return others
      .filter((o) => !wanted || (o.tags || []).some((v) => String(v).toLowerCase() === wanted))
      .filter((o) => o.id !== exclude);
  };
  const base = {
    p, stable: p, shape, shapes, i: 0, n: 1,
    dt: 1 / 60, beat: 0, beatPhase: 0, bpm: 120,
    audio: { level: 0, low: 0, mid: 0, high: 0 },
    world: WORLD, layer: { id: 'L1' }, state,
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
  effect.draw({ ...base, g, t, age: t, rng: makeRng(`${seed}~${steps}`) });
  return { g, state, p };
}

/** Just the drawing, at a chosen show time, for the effects with no `step`. */
function frame(effectId, { shape, params = {}, t = 0, others = [] }) {
  return run(effectId, { shape, params, seconds: 0, others }).g === null
    ? null
    : (() => {
      const effect = getEffect(effectId);
      const p = { ...defaultParams(effectId), ...params };
      const g = recordingContext();
      effect.draw({
        g, p, stable: p, shape, shapes: () => others, i: 0, n: 1,
        t, age: t, dt: 1 / 60, beat: t * 2, beatPhase: (t * 2) % 1, bpm: 120,
        audio: { level: 0, low: 0, mid: 0, high: 0 }, world: WORLD, layer: { id: 'L1' },
        state: {}, noise: defaultNoise, media: () => null, camera: () => null,
        preview: false, share: new Map(), depth: null, rng: makeRng(`f${t}`),
      });
      return g;
    })();
}

/* ------------------------------------------------------------------ *
 * Absorption
 * ------------------------------------------------------------------ */

console.log('— what water does to light —');

{
  ok('no water changes nothing', waterAbsorb('#ffffff', 0) === '#ffffff', waterAbsorb('#ffffff', 0));

  const shallow = waterTransmission(1);
  const deep = waterTransmission(10);

  ok('red goes first, then green, then blue',
    shallow[0] < shallow[1] && shallow[1] < shallow[2],
    shallow.map((v) => v.toFixed(3)).join(' > '));

  ok('and every channel keeps falling with depth',
    deep.every((v, i) => v < shallow[i]),
    deep.map((v) => v.toFixed(3)).join(' '));

  /**
   * The number that makes the whole look work: ten metres of water removes
   * ninety-five per cent of the red and ten per cent of the blue. Anything that
   * merely darkens cannot produce that, which is why depth here is a spectrum
   * rather than a brightness.
   */
  ok('ten metres takes nearly all the red and hardly any of the blue',
    deep[0] < 0.08 && deep[2] > 0.85,
    `red ${deep[0].toFixed(3)}, blue ${deep[2].toFixed(3)}`);

  ok('murkiness is more water, not different water',
    waterAbsorb('#ffffff', 5, 2) === waterAbsorb('#ffffff', 10, 1),
    `${waterAbsorb('#ffffff', 5, 2)} vs ${waterAbsorb('#ffffff', 10, 1)}`);

  // The hex path and the multiplier path have to agree, or an effect that uses
  // one in its gradient and the other in a per-pixel loop is two colours.
  const viaHex = hexToRgb(waterAbsorb('#ffffff', 6, 1.5));
  const viaFactors = waterTransmission(6, 1.5);
  const srgb = (lin) => (lin <= 0.0031308 ? lin * 12.92 : 1.055 * lin ** (1 / 2.4) - 0.055);
  const expected = viaFactors.map((f) => Math.round(srgb(f) * 255));
  ok('the hex and the multiplier agree',
    Math.abs(viaHex.r - expected[0]) <= 1
    && Math.abs(viaHex.g - expected[1]) <= 1
    && Math.abs(viaHex.b - expected[2]) <= 1,
    `${[viaHex.r, viaHex.g, viaHex.b].join(',')} vs ${expected.join(',')}`);

  ok('a colour with no red in it barely notices the depth',
    hexToRgb(waterAbsorb('#00ffff', 8)).b > 220,
    waterAbsorb('#00ffff', 8));
}

/* ------------------------------------------------------------------ *
 * The surface
 * ------------------------------------------------------------------ */

console.log('\n— the wave train —');

/**
 * Pull one component's phase out of the summed profile.
 *
 * Projection onto sin(kx) and cos(kx) over a long window. Each component of the
 * train is `a·sin(kx + θ)`, so the two projections come back as `a·cos θ` and
 * `a·sin θ` and the phase falls straight out of an atan2. The other components
 * are not exactly orthogonal over the window — their wavenumbers are not
 * integer multiples of each other — but four hundred cycles is long enough that
 * what leaks in leaves every measurement within a third of a per cent.
 */
function componentPhase(k, t, amp, lambda, cycles = 400, samples = 200000) {
  const length = ((2 * Math.PI) / k) * cycles;
  let sine = 0;
  let cosine = 0;
  for (let i = 0; i < samples; i++) {
    const x = ((i + 0.5) / samples) * length;
    const h = waveTrain(x, t, amp, lambda).height;
    sine += h * Math.sin(k * x);
    cosine += h * Math.cos(k * x);
  }
  return { theta: Math.atan2(cosine, sine), amp: (Math.hypot(sine, cosine) * 2) / samples };
}

{
  const lambda = 8;
  const dt = 0.005;
  const speeds = [];

  // The three components the train is built from, as harmonics of the primary.
  for (const harmonic of [1, 2.7, 6.3]) {
    const k = (2 * Math.PI * harmonic) / lambda;
    const a = componentPhase(k, 0, 1, lambda);
    const b = componentPhase(k, dt, 1, lambda);
    let delta = b.theta - a.theta;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;

    const measured = -delta / dt;
    const expected = Math.sqrt(G * k);
    speeds.push(measured / k);
    ok(`the ${harmonic === 1 ? 'swell' : `${harmonic}× harmonic`} obeys ω² = gk`,
      Math.abs(measured / expected - 1) < 0.01,
      `ω measured ${measured.toFixed(3)}, √(gk) = ${expected.toFixed(3)}`);
  }

  /**
   * And therefore the pattern is dispersive.
   *
   * This is the point of the previous three: because each component travels at
   * its own speed, the sum is never a rigid translation of itself, so the
   * surface never settles into a repeating comb. Fix the speeds equal — which
   * is what picking three frequencies by eye does — and it does, within a
   * second, and it looks like corduroy for the rest of the evening.
   */
  ok('so the long swell outruns the chop',
    speeds[0] > speeds[1] && speeds[1] > speeds[2],
    speeds.map((c) => `${c.toFixed(2)} m/s`).join(' > '));
}

console.log('\n— how far down a wave is felt —');

{
  ok('orbital motion dies at e^(−kz)',
    Math.abs(orbitalDecay(4, 8) - Math.exp(-Math.PI)) < 1e-9,
    `${orbitalDecay(4, 8).toFixed(5)} at half a wavelength, e^−π = ${Math.exp(-Math.PI).toFixed(5)}`);

  // Equal steps in depth give equal ratios: that is what "exponential" means,
  // and it is the property a hand-tuned taper never quite has.
  const ratios = [1, 2, 3, 4].map((i) => orbitalDecay(i, 6) / orbitalDecay(i - 1, 6));
  const spread = Math.max(...ratios) - Math.min(...ratios);
  ok('and does so at a constant rate per metre', spread < 1e-9,
    ratios.map((r) => r.toFixed(4)).join(' '));

  ok('a long swell is felt deeper than a short one',
    orbitalDecay(5, 30) > orbitalDecay(5, 3) * 100,
    `${orbitalDecay(5, 30).toFixed(4)} vs ${orbitalDecay(5, 3).toExponential(2)}`);
}

/* ------------------------------------------------------------------ *
 * Kelp
 * ------------------------------------------------------------------ */

console.log('\n— kelp —');

/**
 * The stipe of a single frond, as its node positions.
 *
 * Blades, bladders and the current are switched off so that the only geometry
 * on the context is the one polyline this is about, and the only thing moving
 * it is the wave term under test.
 */
function stipe(t, extra = {}) {
  const shape = makeShape(box(0, 0, WORLD.w, WORLD.h), { id: 'wall' });
  const g = frame('kelp', {
    shape,
    t,
    params: {
      fronds: 1, blades: 0, bladders: 0, current: 0, sway: 0.5,
      surface: -0.02, metres: 14, wavelength: 9, height: 0.9, ...extra,
    },
  });
  return g.lines;
}

{
  const times = [0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75];
  const shots = times.map((t) => stipe(t));
  const nodes = shots[0].length;
  ok('a frond is one polyline', nodes >= 12, `${nodes} segments`);

  const travel = (index) => {
    const xs = shots.map((s) => s[index].x1);
    return Math.max(...xs) - Math.min(...xs);
  };

  ok('the holdfast does not move', travel(0) < 0.01, `${travel(0).toFixed(4)} px`);
  ok('the tip does', travel(nodes - 1) > 20, `${travel(nodes - 1).toFixed(1)} px`);
  ok('and it moves far more than the middle does',
    travel(nodes - 1) > travel(Math.floor(nodes / 2)) * 5,
    `${travel(nodes - 1).toFixed(1)} vs ${travel(Math.floor(nodes / 2)).toFixed(1)}`);

  /**
   * The profile up the frond follows the exponential rather than a taper
   * somebody liked the look of.
   *
   * Measured against `orbitalDecay` at the depth of each node, times the
   * holdfast taper the effect also applies. Getting this right is the
   * difference between weed and a flag.
   */
  const surface = -0.02;
  const metres = 14;
  const lambda = 9;
  const depthOf = (y) => Math.max(0, (y / WORLD.h - surface) * metres);
  const tipDepth = depthOf(shots[0][nodes - 1].y1);
  let worst = 0;
  for (let i = Math.floor(nodes * 0.6); i < nodes; i++) {
    const u = (i + 1) / nodes;
    const anchored = u * u * (3 - 2 * u);
    const predicted = (orbitalDecay(depthOf(shots[0][i].y1), lambda) / orbitalDecay(tipDepth, lambda))
      * anchored;
    const measured = travel(i) / travel(nodes - 1);
    worst = Math.max(worst, Math.abs(measured - predicted));
  }
  ok('every node moves by e^(−kz) times its distance from the holdfast',
    worst < 0.06, `worst node off by ${worst.toFixed(3)}`);

  // Two fronds a long way apart are at different points in the wave, because
  // the wave is travelling along the wall rather than pumping it up and down.
  const wide = frame('kelp', {
    shape: makeShape(box(0, 0, WORLD.w, WORLD.h), { id: 'wall' }),
    t: 0.4,
    params: { fronds: 12, blades: 0, bladders: 0, current: 0, sway: 0.5, wavelength: 3, height: 0.9 },
  });
  const tips = [];
  for (let i = 0; i < 12; i++) {
    const seg = wide.lines[(i + 1) * 14 - 1];
    if (seg) tips.push(seg.x1 - wide.lines[i * 14].x0);
  }
  ok('the wave travels along the wall rather than pumping it',
    new Set(tips.map((v) => Math.round(v))).size > 4,
    `${new Set(tips.map((v) => Math.round(v))).size} distinct tip offsets across 12 fronds`);
}

/* ------------------------------------------------------------------ *
 * Bubbles
 * ------------------------------------------------------------------ */

console.log('\n— bubbles —');

{
  const wall = makeShape(box(0, 0, WORLD.w, WORLD.h), { id: 'wall' });
  const { state } = run('bubbles', {
    shape: wall,
    seconds: 7,
    params: { vents: 6, rate: 14, size: 10, surface: -0.05, metres: 16, expand: 1 },
  });

  ok('bubbles are released', state.bubbles.length > 20, `${state.bubbles.length} in the water`);
  ok('and every one of them is going up',
    state.bubbles.every((b) => b.vy < 0),
    `${state.bubbles.filter((b) => b.vy >= 0).length} going the wrong way`);

  /**
   * Boyle's law, checked against the effect rather than restated.
   *
   * The absolute pressure on a bubble is one atmosphere plus the water above
   * it, an atmosphere being 10.33 m of water. Halve the pressure and the volume
   * doubles, so the radius goes up by the cube root — which for a bubble that
   * has climbed ten metres is about a quarter again.
   */
  const risen = state.bubbles.filter((b) => b.r0 > 0 && b.depth0 > 2);
  let worst = 0;
  for (const b of risen) {
    const metres = Math.max(0, (b.y / WORLD.h + 0.05) * 16);
    const predicted = b.r0 * Math.cbrt((10.33 + b.depth0) / (10.33 + metres));
    worst = Math.max(worst, Math.abs(b.r / predicted - 1));
  }
  ok('and swells by exactly what the pressure drop says', worst < 0.01,
    `worst ${(worst * 100).toFixed(2)}% off across ${risen.length} bubbles`);

  const grown = state.bubbles.filter((b) => b.r > b.r0 * 1.02);
  ok('so the ones near the surface are visibly bigger than they started',
    grown.length > 3, `${grown.length} of ${state.bubbles.length}`);

  /**
   * And they do not go straight up. A bubble above about a millimetre and a
   * half sheds vortices off alternate sides and zigzags, which is why a stream
   * from one crack in a wall arrives spread over a metre.
   */
  const wandered = state.bubbles.filter((b) => Math.abs(b.vx) > 1);
  ok('nor does any of them go straight up',
    wandered.length > state.bubbles.length * 0.7,
    `${wandered.length} of ${state.bubbles.length} moving sideways`);

  // Bigger bubbles outrun small ones: terminal velocity goes as the square root
  // of the radius in the large-bubble limit.
  const fast = state.bubbles.filter((b) => b.r0 > 10).map((b) => -b.vy);
  const slow = state.bubbles.filter((b) => b.r0 < 6).map((b) => -b.vy);
  const mean = (xs) => xs.reduce((s, v) => s + v, 0) / (xs.length || 1);
  ok('and the big ones outrun the small ones',
    fast.length && slow.length && mean(fast) > mean(slow) * 1.15,
    `${mean(fast).toFixed(0)} px/s vs ${mean(slow).toFixed(0)}`);
}

{
  // With a window in the way, a bubble presses against the underside of it and
  // slides out — it never ends up inside the glass.
  const wall = makeShape(box(0, 0, WORLD.w, WORLD.h), { id: 'wall' });
  const window1 = makeShape(box(400, 300, 500, 300), { id: 'w1', tags: ['window'] });
  const window2 = makeShape(box(1100, 500, 400, 250), { id: 'w2', tags: ['window'] });
  const { state } = run('bubbles', {
    shape: wall,
    seconds: 10,
    others: [window1, window2],
    params: { vents: 10, rate: 30, size: 12, obstacles: 'window' },
  });
  const trapped = state.bubbles.filter(
    (b) => pointInPolygon({ x: b.x, y: b.y }, window1.points)
      || pointInPolygon({ x: b.x, y: b.y }, window2.points)
  );
  ok('none of them ends up inside a window',
    trapped.length === 0, `${trapped.length} of ${state.bubbles.length} inside the glass`);
}

/* ------------------------------------------------------------------ *
 * The shoal
 * ------------------------------------------------------------------ */

console.log('\n— the shoal —');

{
  const wall = makeShape(box(100, 100, 1720, 880), { id: 'wall' });
  const openings = [
    makeShape(box(400, 300, 300, 250), { id: 'w1', tags: ['window'] }),
    makeShape(box(1100, 300, 300, 250), { id: 'w2', tags: ['window'] }),
    makeShape(box(800, 620, 200, 360), { id: 'd1', tags: ['door'] }),
  ];

  const { state } = run('shoal', {
    shape: wall,
    seconds: 25,
    others: openings,
    params: { count: 40, size: 26, obstacles: 'window, door' },
  });

  ok('the shoal is the size it was asked for', state.fish.length === 40, `${state.fish.length}`);

  const inOpening = state.fish.filter((f) =>
    openings.some((o) => pointInPolygon({ x: f.x, y: f.y }, o.points)));
  ok('and after twenty-five seconds not one of them is in a window',
    inOpening.length === 0, `${inOpening.length} through the glass`);

  const escaped = state.fish.filter((f) => !pointInPolygon({ x: f.x, y: f.y }, wall.points));
  ok('nor has any of them left the wall', escaped.length === 0, `${escaped.length} off the wall`);

  /**
   * It is a shoal rather than a scatter.
   *
   * The three boid rules are all relative, so a flock with no attractor mills
   * about and one with too strong an attractor collapses to a point. Somewhere
   * between the two is a ball a few body-lengths across, and that is the thing
   * worth measuring: the spread has to be bounded above *and* below.
   */
  const cx = state.fish.reduce((s, f) => s + f.x, 0) / state.fish.length;
  const cy = state.fish.reduce((s, f) => s + f.y, 0) / state.fish.length;
  const rms = Math.sqrt(
    state.fish.reduce((s, f) => s + (f.x - cx) ** 2 + (f.y - cy) ** 2, 0) / state.fish.length
  );
  ok('they stay together without piling up',
    rms > 26 * 1.5 && rms < 26 * 22, `rms spread ${rms.toFixed(0)} px at 26 px long`);

  const speeds = state.fish.map((f) => Math.hypot(f.vx, f.vy));
  ok('and none of them stalls or runs away',
    speeds.every((s) => s > 190 * 0.4 && s < 190 * 2.7),
    `${Math.min(...speeds).toFixed(0)}–${Math.max(...speeds).toFixed(0)} px/s`);

  // A fish flashes when it banks, so at any instant some of them are turning
  // and some are not. All zero would mean the term never fires; all high would
  // mean the shoal is thrashing.
  const turning = state.fish.filter((f) => f.turn > 0.5).length;
  ok('some of them are banking and some are not',
    turning > 0 && turning < state.fish.length,
    `${turning} of ${state.fish.length} banking`);
}

{
  // Two tabs, one shoal. Every projector covering the same wall has to agree
  // about where each fish is, or the overlap shows two of it.
  const wall = makeShape(box(0, 0, WORLD.w, WORLD.h), { id: 'wall' });
  const a = run('shoal', { shape: wall, seconds: 6, params: { count: 20 } });
  const b = run('shoal', { shape: wall, seconds: 6, params: { count: 20 } });
  const key = (s) => s.fish.map((f) => `${f.x.toFixed(6)},${f.y.toFixed(6)}`).join('|');
  ok('two tabs draw the same shoal', key(a.state) === key(b.state));
  ok('and the same fish', JSON.stringify(a.g.lines) === JSON.stringify(b.g.lines),
    `${a.g.lines.length} segments`);
}

/* ------------------------------------------------------------------ *
 * Jellyfish
 * ------------------------------------------------------------------ */

console.log('\n— jellyfish —');

{
  ok('the bell is open at the start of a pulse', contraction(0) < 0.001, contraction(0).toFixed(4));
  ok('shut a quarter of the way through', contraction(0.28) > 0.999, contraction(0.28).toFixed(4));
  ok('and open again by the end', contraction(0.999) < 0.01, contraction(0.999).toFixed(4));

  /**
   * The stroke is asymmetric, which is the whole of jellyfish locomotion: all
   * of the thrust is in a squeeze that takes a quarter of the cycle, and the
   * other three quarters are the bell refilling and producing almost none.
   */
  const half = contraction(0.5);
  ok('the squeeze is faster than the refill', contraction(0.14) > 0.4 && half < 0.85,
    `half open at 14% (${contraction(0.14).toFixed(2)}), still ${half.toFixed(2)} shut at 50%`);

  // Zero-mean, or the pulse would quietly add a rise of its own on top of the
  // one the slider asks for.
  let sum = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) sum += contraction((i + 0.5) / N);
  ok('and averages exactly a half over a cycle, so it adds no drift',
    Math.abs(sum / N - 0.5) < 1e-4, (sum / N).toFixed(6));
}

{
  const bbox = { x: 0, y: 0, w: 1920, h: 1080, cx: 960, cy: 540 };
  const p = { pulse: 2, thrust: 1, size: 120, drift: 0, rise: 40 };
  const j = { x0: 500, y0: 600, phase: 0, periodScale: 1, driftScale: 1, scale: 1 };

  const rest = bellAt(0, j, p, WORLD, bbox);
  const shut = bellAt(2 * 0.28, j, p, WORLD, bbox);
  ok('the bell surges upward on the squeeze', shut.y < rest.y - 40,
    `${(rest.y - shut.y).toFixed(1)} px in ${(2 * 0.28).toFixed(2)} s, of which ${(40 * 2 * 0.28).toFixed(1)} is the steady rise`);

  /**
   * And a slider called Rise raises it.
   *
   * Screen `y` runs down, the drawn position wraps, and the pulse is a much
   * bigger number than a second's worth of drift — three separate reasons a
   * sign error here reads as "hmm, they seem to sink a bit" rather than as
   * anything obviously wrong. Sample whole pulses so the surge is out of it.
   */
  const climb = [];
  for (let n = 0; n <= 4; n++) climb.push(bellAt(2 * n, j, p, WORLD, bbox).cy);
  ok('and positive Rise takes it up the wall, not down it',
    climb.every((cy, n) => n === 0 || cy < climb[n - 1]),
    climb.map((cy) => cy.toFixed(0)).join(' -> '));

  // Over a whole number of pulses the surge cancels and what is left is the
  // rise, exactly.
  const cycles = 6;
  const later = bellAt(2 * cycles, j, p, WORLD, bbox);
  ok('and over whole pulses the surge cancels out',
    Math.abs((rest.cy - later.cy) - 40 * 2 * cycles) < 1e-6,
    `${(rest.cy - later.cy).toFixed(3)} px vs ${(40 * 2 * cycles).toFixed(3)} of rise`);

  ok('the unwrapped track is continuous even where the drawn one wraps', (() => {
    let biggest = 0;
    let previous = bellAt(0, j, { ...p, rise: 300 }, WORLD, bbox).cy;
    for (let i = 1; i <= 2000; i++) {
      const cy = bellAt(i * 0.02, j, { ...p, rise: 300 }, WORLD, bbox).cy;
      biggest = Math.max(biggest, Math.abs(cy - previous));
      previous = cy;
    }
    return biggest < 20;
  })(), 'no jump in cy over forty seconds of rising');
}

{
  /**
   * The tentacles are where the bell was.
   *
   * Not a metaphor — the drawn point at arc-length `u` along a tentacle is the
   * bell's own position `trail × u` seconds ago, offset by the sag. So it can
   * be checked against `bellAt` directly, and the check is exact rather than
   * approximate.
   */
  const shape = makeShape(box(0, 0, WORLD.w, WORLD.h), { id: 'w' });
  const params = {
    count: 1, tentacles: 1, trail: 1.5, rise: 0, drift: 180, size: 120,
    pulse: 2, glow: 0, thrust: 1,
  };
  const t = 9;
  const g = frame('jellyfish', { shape, t, params });
  ok('a tentacle is drawn', g.lines.length >= 12, `${g.lines.length} segments`);

  // Rebuild the jellyfish the effect seeded, so the expected track can be
  // computed from the same numbers it drew from.
  const rng = makeRng(`jellyfish:${shape.id}:0`);
  const j = {
    x0: rng() * (shape.bbox.w + params.size * 4),
    y0: rng() * (shape.bbox.h + params.size * 5),
    phase: rng(),
    periodScale: 0.8 + rng() * 0.45,
    driftScale: 0.7 + rng() * 0.7,
    scale: 0.65 + rng() * 0.7,
    hue: rng(),
  };
  const now = bellAt(t, j, params, WORLD, shape.bbox);
  const segments = 12;
  const lag = strandLag(0, params.trail);

  /**
   * Every vertex, not only the last one: the whole strand has to lie on the
   * track, or it is a curve that merely happens to end in the right place.
   */
  let worstVertex = 0;
  for (let k = 1; k <= segments; k++) {
    const past = bellAt(t - lag * (k / segments), j, params, WORLD, shape.bbox);
    const expected = now.x - (now.cx - past.cx);
    worstVertex = Math.max(worstVertex, Math.abs(g.lines[k - 1].x1 - expected));
  }
  // The only thing between a vertex and the track is the splay, which fans the
  // strands apart and is bounded by a small fraction of the bell.
  ok('and every point along it is where the bell was that long ago',
    worstVertex < params.size * 0.1, `worst vertex ${worstVertex.toFixed(2)} px off the track`);

  const tip = g.lines[segments - 1];
  ok('which puts its far end behind the bell, not under it',
    Math.abs(tip.x1 - now.x) > params.size * 0.5,
    `${Math.abs(tip.x1 - now.x).toFixed(1)} px behind, at ${params.drift} px/s over ${lag.toFixed(2)} s`);

  // A bell that has just wrapped round the frame must not drag its tentacles
  // across the whole house.
  let longest = 0;
  for (let step = 0; step < 400; step++) {
    const shot = frame('jellyfish', { shape, t: step * 0.25, params: { ...params, drift: 400 } });
    for (const l of shot.lines) longest = Math.max(longest, Math.hypot(l.x1 - l.x0, l.y1 - l.y0));
  }
  ok('and no tentacle is ever stretched across the frame by a wrap',
    longest < WORLD.w * 0.35, `longest segment ${longest.toFixed(0)} px`);
}

{
  /**
   * A tentacle hangs. It never climbs into the animal.
   *
   * Which sounds too obvious to test, and is exactly the bug that was here:
   * trailing a strand through the bell's *whole* past motion hands every point
   * on it the jet as well as the swim, and the jet is by far the larger of the
   * two. Through the squeeze that is fine — the bell leaves, the strands
   * stream out behind. Through the refill it is not: the bell sinks back, and
   * a strand drawn from where the bell was a second ago is drawn from a second
   * ago's *higher* position, so it whips up through the bell. Nobody notices
   * it as a sign error; it reads as a jellyfish that occasionally eats its own
   * tentacles.
   *
   * The fix is two physical facts — drag damps the jet out along the strand,
   * and a strand cannot be flung further than the length it hangs — so this
   * checks the consequence, over the whole pulse and at the ends of every
   * slider that feeds it.
   */
  const shape = makeShape(box(0, 0, WORLD.w, WORLD.h), { id: 'w' });
  const segments = 12;

  /** The worst height any strand vertex reaches above the point it hangs from. */
  const worstClimb = (params) => {
    let worst = 0;
    let where = '';
    for (let n = 0; n < 90; n++) {
      const t = 6 + n * ((params.pulse * 2.2) / 90);
      const g = frame('jellyfish', { shape, t, params });
      for (let v = 0; v < g.lines.length; v++) {
        // Every strand is one moveTo and `segments` lineTos, in order, so the
        // vertex a strand hangs from is the start of its first segment.
        const anchorY = g.lines[Math.floor(v / segments) * segments].y0;
        const climb = anchorY - g.lines[v].y1;
        if (climb > worst) { worst = climb; where = `t=${t.toFixed(2)}`; }
      }
    }
    return { worst, where };
  };

  const cases = [
    ['at rest', { count: 1, tentacles: 12, glow: 0 }],
    ['at full surge', { count: 1, tentacles: 12, glow: 0, thrust: 3 }],
    ['with long tentacles', { count: 1, tentacles: 12, glow: 0, trail: 6 }],
    ['on a big slow one', { count: 1, tentacles: 12, glow: 0, size: 320, pulse: 6, thrust: 3 }],
    ['on a small fast one', { count: 1, tentacles: 12, glow: 0, size: 20, pulse: 0.4, thrust: 3 }],
    ['hanging still', { count: 1, tentacles: 12, glow: 0, rise: 0, drift: 0, thrust: 3 }],
  ];

  let worstOfAll = 0;
  for (const [label, extra] of cases) {
    const params = { pulse: 2.4, trail: 1.6, thrust: 1, rise: 26, drift: 14, size: 70, ...extra };
    const { worst, where } = worstClimb(params);
    worstOfAll = Math.max(worstOfAll, worst);
    ok(`no tentacle climbs above the bell ${label}`, worst <= 0.001,
      worst > 0.001 ? `${worst.toFixed(1)} px above its anchor at ${where}` : 'never');
  }
  ok('over every stroke and every extreme of the sliders', worstOfAll <= 0.001,
    `worst ${worstOfAll.toFixed(3)} px`);

  /**
   * And the clamp has not simply frozen them. A strand that no longer responds
   * to the pulse at all would pass everything above and look like string.
   */
  const params = { count: 1, tentacles: 12, glow: 0, size: 70, thrust: 3, rise: 0, drift: 0, pulse: 2 };
  const tips = [];
  for (let n = 0; n < 60; n++) {
    const g = frame('jellyfish', { shape, t: 6 + (n / 60) * params.pulse, params });
    // Where the first strand's tip is relative to where that strand hangs from,
    // so a bell that is merely translating does not count as a swing.
    tips.push(g.lines[segments - 1].y1 - g.lines[0].y0);
  }
  const swing = Math.max(...tips) - Math.min(...tips);
  ok('but the strands still swing through the stroke', swing > params.size * 0.25,
    `tip moves ${swing.toFixed(0)} px against the bell over a pulse`);

  /**
   * And a big jellyfish gets big tentacles. Hanging them at a fixed number of
   * pixels per second of trail puts a 320-pixel bell on 70-pixel strings.
   */
  const reach = (size) => {
    const g = frame('jellyfish', { shape, t: 6, params: { count: 1, tentacles: 12, glow: 0, thrust: 0, size } });
    let deepest = 0;
    for (const l of g.lines) deepest = Math.max(deepest, l.y1 - g.lines[0].y0);
    return deepest;
  };
  const small = reach(40);
  const big = reach(320);
  ok('and a strand is as long as the animal it hangs off', big > small * 2.5,
    `${small.toFixed(0)} px on a 40 px bell, ${big.toFixed(0)} px on a 320 px one`);
}

/* ------------------------------------------------------------------ *
 * Dolphins
 * ------------------------------------------------------------------ */

console.log('\n— dolphins —');

{
  const p = { leap: 1.1, between: 2.4, dive: 1 };
  const first = porpoise(0, p);

  /**
   * The leap is a projectile, and that is the whole claim.
   *
   * Everything checkable about it follows from `−4H·s(1−s)` with a hang time of
   * `2√(2H/g)`: it reaches exactly the height asked for, it stays up as the
   * square root of that height, and it comes back down at the speed it went up
   * at. An arc drawn to look right passes none of these, and the failure is
   * invisible — a leap that hangs a little too long is only ever "hmm, that
   * looks a bit floaty", which nobody can act on.
   */
  let peak = 0;
  let deepest = 0;
  let jump = 0;
  let previous = first.z;
  for (let i = 1; i <= 120000; i++) {
    const at = porpoise(i * 0.0001, p);
    peak = Math.min(peak, at.z);
    deepest = Math.max(deepest, at.z);
    jump = Math.max(jump, Math.abs(at.z - previous));
    previous = at.z;
  }
  ok('it leaps exactly as high as it was asked to', Math.abs(-peak - p.leap) < 1e-6,
    `${(-peak).toFixed(4)} m against ${p.leap}`);
  ok('and the path never jumps', jump < 0.002, `worst step ${jump.toFixed(5)} m per 0.1 ms`);
  ok('and it goes down as well as up', deepest > p.dive, `${deepest.toFixed(2)} m at the bottom`);

  const hang = (height) => porpoise(0, { ...p, leap: height }).tAir;
  const ratios = [0.5, 2, 4].map((k) => hang(k) / hang(1) / Math.sqrt(k));
  ok('hang time goes as the square root of the height',
    ratios.every((r) => Math.abs(r - 1) < 1e-9),
    [0.5, 1, 2, 4].map((k) => `${k}m:${hang(k).toFixed(3)}s`).join(' '));

  /**
   * Continuous *velocity* through the surface, not just position — which is
   * what makes the animal enter nose-down at the angle it left nose-up, since
   * the pitch is read off the velocity.
   */
  const G = 9.81;
  const expected = Math.sqrt(2 * G * p.leap);
  const e = 1e-7;
  const inBefore = porpoise(first.tAir - e, p).vz;
  const inAfter = porpoise(first.tAir + e, p).vz;
  const outBefore = porpoise(first.period - e, p).vz;
  const outAfter = porpoise(e, p).vz;
  ok('it hits the water at √(2gH), going down',
    Math.abs(inBefore - expected) < 1e-4 && Math.abs(inAfter - expected) < 1e-4,
    `${inBefore.toFixed(4)} then ${inAfter.toFixed(4)} against ${expected.toFixed(4)} m/s`);
  ok('and left it at the same speed, going up',
    Math.abs(outBefore + expected) < 1e-4 && Math.abs(outAfter + expected) < 1e-4,
    `${outBefore.toFixed(4)} then ${outAfter.toFixed(4)}`);

  ok('it is under the water for the rest of the cycle', (() => {
    for (let i = 0; i <= 2000; i++) {
      const at = porpoise(first.tAir + (i / 2000) * first.tUnder * 0.999, p);
      if (at.airborne || at.z < -1e-9) return false;
    }
    return true;
  })(), `${first.tUnder.toFixed(2)} s under, ${first.tAir.toFixed(2)} s over`);

  /**
   * And with the leap turned off it still comes up to breathe, because a
   * dolphin has to. The cycle becomes a dive from the surface and back.
   */
  const flat = porpoise(0, { ...p, leap: 0 });
  let highest = Infinity;
  for (let i = 0; i <= 4000; i++) highest = Math.min(highest, porpoise((i / 4000) * flat.period, { ...p, leap: 0 }).z);
  ok('with no leap it still surfaces to breathe',
    flat.tAir === 0 && Math.abs(highest) < 1e-9, `reaches ${highest.toFixed(6)} m`);
}

{
  /**
   * The beat rate is the Strouhal number, not a slider.
   *
   * St = fA/U sits between about 0.2 and 0.4 in every animal anybody has
   * measured it in, which means the frequency is a *consequence* of the speed
   * and the fluke amplitude rather than something to pick. Checking it here is
   * checking that a dolphin told to swim faster beats faster, by the right
   * amount, without anything being tied together by hand.
   *
   * Measured off the drawing: count the fluke's own vertical swing over a
   * cycle and time how long it takes to come back.
   */
  const shape = makeShape(box(0, 0, WORLD.w, WORLD.h), { id: 'w' });
  const base = {
    count: 1, length: 4, leap: 0, dive: 0, between: 20, spray: 0,
    together: 1, surface: 0.5, metres: 14,
  };

  /** The fluke's offset from the body axis, sampled from the drawn outline. */
  const fluke = (params, t) => {
    const g = frame('dolphins', { shape, t, params });
    let lowest = -Infinity;
    let highest = Infinity;
    for (const l of g.lines) {
      lowest = Math.max(lowest, l.y1);
      highest = Math.min(highest, l.y1);
    }
    return { lowest, highest };
  };

  /** Time from `t` until the beat comes back round, by sampling the tail. */
  const beatPeriod = (params) => {
    const at = (t) => {
      const g = frame('dolphins', { shape, t, params });
      // The body outline is drawn nose to tail along the top and back along
      // the bottom, so the last vertex of the upper pass is the peduncle.
      return g.lines[21] ? g.lines[21].y1 : 0;
    };
    const start = at(4);
    const slope = at(4.002) - start;
    for (let i = 1; i <= 4000; i++) {
      const t = 4 + i * 0.002;
      const here = at(t);
      const next = at(t + 0.002);
      if (Math.abs(here - start) < 0.4 && (next - here) * slope > 0 && i > 40) return i * 0.002;
    }
    return NaN;
  };

  const slow = beatPeriod({ ...base, speed: 120, strouhal: 0.3 });
  const fast = beatPeriod({ ...base, speed: 240, strouhal: 0.3 });
  ok('the fluke beat is real and periodic', Number.isFinite(slow) && Number.isFinite(fast),
    `${slow?.toFixed(3)} s at 120 px/s, ${fast?.toFixed(3)} s at 240`);
  ok('and doubling the speed doubles the beat rate, which is what holds St fixed',
    Math.abs(slow / fast - 2) < 0.05, `${(slow / fast).toFixed(3)}× against 2`);

  const swing = fluke({ ...base, speed: 200 }, 4);
  ok('and the fluke swings across the body axis rather than along it',
    swing.lowest - swing.highest > 0, `${(swing.lowest - swing.highest).toFixed(1)} px of body drawn`);
}

{
  /**
   * A dolphin surfaces where the waterline is drawn, which is the only reason
   * it shares the surface parameters at all — and it has to work when the
   * layer is pointed at a traced wall, for exactly the reason the waterline
   * did not.
   *
   * Checked on the top of the leap, which is the one height that is known
   * exactly: `leap` metres above the surface, wherever the surface is. Moving
   * the anchor from the frame to the wall moves the surface by a known number
   * of pixels, and it has to move the animal by the same number.
   */
  const wall = makeShape(box(300, 240, 900, 600), { id: 'wall' });
  const params = {
    count: 1, length: 3, leap: 2, between: 1.6, dive: 0, spray: 0, together: 1,
    speed: 260, surface: 0.2,
  };

  /** The highest point anything is drawn at, over a few leaps. */
  const ceiling = (anchor) => {
    let top = Infinity;
    for (let i = 0; i < 400; i++) {
      const g = frame('dolphins', { shape: wall, t: 4 + i * 0.02, params: { ...params, anchor } });
      for (const l of g.lines) top = Math.min(top, l.y1, l.y0);
    }
    return top;
  };

  const onWall = ceiling('shape');
  const onFrame = ceiling('frame');
  const shift = (wall.bbox.y + 0.2 * wall.bbox.h) - 0.2 * WORLD.h;

  ok('aimed at a wall, it leaps out of that wall',
    Number.isFinite(onWall) && Math.abs(onWall - (wall.bbox.y + 0.2 * wall.bbox.h)) < params.length * 90,
    `peaks at y=${onWall.toFixed(0)}, wall surface at ${(wall.bbox.y + 0.2 * wall.bbox.h).toFixed(0)}`);
  ok('and measured against the frame instead, it moves by exactly the offset',
    Math.abs((onWall - onFrame) - shift) < 0.5,
    `${(onWall - onFrame).toFixed(1)} px against ${shift.toFixed(1)}`);

  // And it does leave the water: the peak is above the surface it measures.
  ok('and the top of the leap is out of the water',
    onWall < wall.bbox.y + 0.2 * wall.bbox.h,
    `${((wall.bbox.y + 0.2 * wall.bbox.h) - onWall).toFixed(0)} px of air`);
}

{
  /**
   * A pod is several animals, not one drawn several times.
   *
   * Placing four dolphins with a free `rng()` each puts two of them on top of
   * one another often enough to see it every evening — and when they are also
   * a few thousandths of a cycle apart in their stroke, what is on the wall is
   * unmistakably one dolphin with a small offset. So each animal is given its
   * own band of the frame, of the cycle and of the depth, and jitters inside
   * it: placed rather than ruled, but never coincident.
   */
  const bandsOf = (n, fill) => Array.from({ length: n }, (_, i) => {
    const rng = makeRng(`band:${i}`);
    return stratum(i, n, rng, fill);
  });

  for (const n of [2, 4, 8, 16]) {
    const bands = bandsOf(n, 0.7);
    let closest = Infinity;
    for (let a = 1; a < bands.length; a++) closest = Math.min(closest, bands[a] - bands[a - 1]);
    ok(`${n} of them never share a band`, closest > 0.25 / n,
      `closest ${closest.toFixed(4)}, band ${(1 / n).toFixed(4)}`);
  }

  /**
   * And the consequence, measured the way the eye measures it: the smallest
   * gap between any two animals over a whole leap cycle, in body lengths.
   * Before this was stratified it was 0.42 of a body length at the defaults.
   */
  const WORLD_H = 1080;
  const closestApproach = (count, together) => {
    const p = {
      count, length: 3, speed: 210, leap: 1.1, between: 2.4, dive: 1,
      together, metres: 14, surface: 0.08,
    };
    const perMetre = WORLD_H / p.metres;
    const length = p.length * perMetre;
    const spanX = 1920 + length * 2.5;
    const pod = Array.from({ length: count }, (_, i) => {
      const at = podPlacement(i, count, together, spanX, length);
      return { ...at, len: length * at.scale };
    });

    const period = porpoise(0, p).period;
    let worst = Infinity;
    for (let n = 0; n <= 300; n++) {
      const t = (n / 300) * period;
      const at = pod.map((d) => {
        const swim = porpoise(t, p, d.phase);
        return {
          d,
          x: d.x0 + t * p.speed,
          y: p.surface * WORLD_H + (swim.z + d.lane * Math.min(1, Math.max(0, swim.z))) * perMetre,
        };
      });
      for (let a = 0; a < at.length; a++) {
        for (let b = a + 1; b < at.length; b++) {
          const gap = Math.hypot(at[a].x - at[b].x, at[a].y - at[b].y)
            / Math.max(at[a].d.len, at[b].d.len);
          worst = Math.min(worst, gap);
        }
      }
    }
    return worst;
  };

  const atDefaults = closestApproach(4, 0.7);
  ok('at the defaults no two of them are ever within a body length',
    atDefaults > 1, `closest approach ${atDefaults.toFixed(2)} body lengths`);

  let worstAnywhere = Infinity;
  let worstAt = '';
  for (const count of [2, 3, 4, 6, 8]) {
    for (const together of [0, 0.25, 0.5, 0.7, 0.9, 1]) {
      const gap = closestApproach(count, together);
      if (gap < worstAnywhere) { worstAnywhere = gap; worstAt = `${count} at together ${together}`; }
    }
  }
  ok('and that holds across the pod size and the formation slider',
    worstAnywhere > 0.8, `worst ${worstAnywhere.toFixed(2)} body lengths, with ${worstAt}`);
}

{
  /**
   * Three body plans, and the one thing that stops them being three skins: a
   * deep-bodied fish is a worse cruiser. If they all swim at the same speed
   * the shapes are a costume.
   */
  const wall = makeShape(box(0, 0, WORLD.w, WORLD.h), { id: 'w' });
  const speedOf = (species) => {
    const { state } = run('shoal', {
      shape: wall, seconds: 8,
      params: { count: 12, species, speed: 200, startle: 0, wander: 0.3 },
    });
    return state.fish.reduce((sum, f) => sum + Math.hypot(f.vx, f.vy), 0) / state.fish.length;
  };
  const sardine = speedOf('sardine');
  const angel = speedOf('angelfish');
  ok('a sardine out-cruises an angelfish', sardine > angel * 1.2,
    `${sardine.toFixed(0)} px/s against ${angel.toFixed(0)}`);

  const effect = getEffect('shoal');
  const options = effect.params.find((param) => param.key === 'species').options;
  ok('and every body plan is offered', options.includes('mixed') && options.length === 4,
    options.join(', '));
}

/* ------------------------------------------------------------------ *
 * Shafts, and the waterline
 * ------------------------------------------------------------------ */

console.log('\n— light through the surface —');

/** How blue a `#rrggbb` or `rgba(...)` string is, as blue minus red. */
function blueness(css) {
  const rgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(css);
  if (rgb) return Number(rgb[3]) - Number(rgb[1]);
  const hex = hexToRgb(css);
  return hex.b - hex.r;
}

{
  const shape = makeShape(box(0, 0, WORLD.w, WORLD.h), { id: 'w' });
  const g = frame('godrays', {
    shape,
    t: 4,
    params: { shafts: 4, surface: 0, metres: 30, turbidity: 1, haze: 0 },
  });

  ok('the shafts are drawn', g.gradients.length >= 4, `${g.gradients.length} gradients`);

  const along = g.gradients.filter((stops) => stops.length >= 4);
  const bluer = along.filter((stops) => blueness(stops[stops.length - 1][1]) > blueness(stops[0][1]));
  ok('and every one of them gets bluer down its length',
    bluer.length === along.length, `${bluer.length} of ${along.length}`);

  /**
   * The absorption really is the thing driving it, and not a gradient towards a
   * blue somebody picked: thirty metres of water leaves the deep end of a shaft
   * with essentially no red in it, and a hand-chosen "deep colour" would have
   * to have been chosen to match.
   */
  const deepest = along[0][along[0].length - 1][1];
  ok('the far end has had the red taken out of it rather than tinted',
    blueness(deepest) > 100, `${deepest}`);
}

{
  const shape = makeShape(box(0, 0, WORLD.w, WORLD.h), { id: 'w' });
  const g = frame('waterline', { shape, t: 3, params: { surface: 0.4, metres: 20, wave: 30 } });

  // The meniscus is the longest polyline on the context, and it has to lie
  // about where the surface parameter says and to be wavy rather than straight.
  const near = g.lines.filter((l) => Math.abs(l.y0 - WORLD.h * 0.4) < WORLD.h * 0.06);
  ok('there is a surface across the frame', near.length > 60, `${near.length} segments near 0.4`);

  const ys = near.map((l) => l.y0);
  const swing = Math.max(...ys) - Math.min(...ys);
  ok('and it is a wave rather than a ruled line', swing > 2, `${swing.toFixed(1)} px of relief`);

  const sloping = near.filter((l) => Math.abs(l.y1 - l.y0) > 1e-9).length;
  ok('so most of its segments are sloping', sloping > near.length * 0.8,
    `${sloping} of ${near.length}`);

  const flat = frame('waterline', { shape, t: 3, params: { surface: 0.4, metres: 20, wave: 0 } });
  // Everything but the two vertical edges that close the water body off at the
  // sides of the frame, which are not part of the surface.
  const across = flat.lines.filter((l) => l.x1 !== l.x0);
  ok('and with the wave height at zero every one of them is exactly level',
    across.length > 200 && across.every((l) => l.y1 === l.y0),
    `${across.length} of ${flat.lines.length} segments run along the surface`);

  const body = g.gradients.find((stops) => stops.length >= 6);
  ok('the water below it is absorbed with depth',
    body && blueness(body[body.length - 1][1]) > blueness(body[0][1]),
    body ? `${body[0][1]} -> ${body[body.length - 1][1]}` : 'no body gradient');
}

/* ------------------------------------------------------------------ *
 * Everything agrees about the water
 * ------------------------------------------------------------------ */

console.log('\n— one body of water —');

{
  /**
   * All six share the surface parameters, and they have to mean the same thing
   * in each — otherwise a show has a waterline at one height with shafts
   * arriving at another, which is the sort of thing nobody can see and everyone
   * can feel.
   */
  const ids = ['godrays', 'waterline', 'shoal', 'dolphins', 'bubbles', 'kelp', 'jellyfish'];
  const atSurface = ['waterline', 'dolphins'];
  const missing = [];
  for (const id of ids) {
    const effect = getEffect(id);
    for (const key of ['surface', 'metres', 'turbidity']) {
      const def = effect.params.find((param) => param.key === key);
      if (!def) missing.push(`${id}.${key}`);
    }
  }
  ok('every underwater effect takes the same three water parameters',
    missing.length === 0, missing.join(', '));

  /**
   * The *scale* of the water has to match out of the box, because that is what
   * a show inherits when somebody adds a second underwater layer without
   * touching anything: metres top to bottom, and how murky it is.
   */
  const scale = ids.map((id) => {
    const effect = getEffect(id);
    return ['metres', 'turbidity']
      .map((key) => effect.params.find((param) => param.key === key).default)
      .join('/');
  });
  ok('and defaults them to the same depth of water',
    new Set(scale).size === 1, scale[0]);

  /**
   * The surface height is the one that does not, and deliberately.
   *
   * Most of them read depth as a gradient, so the shared −0.2 — the surface
   * off the top of the picture, which is what a sunk house wants — simply
   * makes them deeper. The two that work *at* the surface, drawing it or
   * crossing it, would draw nothing at all from up there. They start with the
   * surface in shot instead.
   */
  const surfaceOf = (id) => getEffect(id).params.find((param) => param.key === 'surface').default;
  const gradients = ids.filter((id) => !atSurface.includes(id));
  ok('every effect that reads depth as a gradient starts fully under',
    new Set(gradients.map(surfaceOf)).size === 1 && surfaceOf(gradients[0]) < 0,
    `${surfaceOf(gradients[0])}`);
  ok('and the ones that work at the surface start with it in shot',
    atSurface.every((id) => surfaceOf(id) > 0),
    atSurface.map((id) => `${id} ${surfaceOf(id)}`).join(', '));

  // Both of those also have to agree about what the height is measured from,
  // or a leaping animal surfaces somewhere the waterline is not.
  const anchorOf = (id) => getEffect(id).params.find((param) => param.key === 'anchor');
  ok('and both offer the same choice of what to measure it from',
    atSurface.every((id) => anchorOf(id)?.default === 'auto'
      && anchorOf(id).options.join() === anchorOf(atSurface[0]).options.join()),
    anchorOf('dolphins')?.options.join(', '));
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
