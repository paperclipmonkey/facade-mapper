/**
 * Which way the drawn figures face.
 *
 * Orientation bugs are invisible to every other kind of test. The effect runs,
 * draws, throws nothing and costs the same either way — it is just wrong, and
 * only wrong to someone looking at it. The Santa rig flew backwards, sleigh
 * first and reindeer trailing, in *both* directions for as long as the effect
 * has existed, and survived a complete redraw of the reindeer without anyone
 * noticing until it was pointed out.
 *
 * So these run the real draw functions against a recording context that tracks
 * the canvas transform and captures where the geometry actually lands in world
 * space. No DOM, no canvas, no dependencies.
 *
 *   node test/figures.test.mjs
 */

import christmas from '../js/effects/builtin/christmas.js';
import { createNoise } from '../js/core/noise.js';
import { makeRng } from '../js/core/math.js';

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

/**
 * A 2D context that draws nothing and remembers everywhere it was asked to.
 *
 * Every path command is pushed through the current transform, so what comes out
 * is world-space geometry — which is the only level at which "is it facing the
 * right way" is a meaningful question. A mirrored rig looks identical in local
 * coordinates.
 */
function recordingContext() {
  // [a, b, c, d, e, f] as canvas orders them.
  let m = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const points = [];

  const apply = (x, y) => {
    points.push({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
  };
  const mul = (n) => {
    m = [
      m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
    ];
  };

  const noopGradient = { addColorStop() {} };

  return {
    points,
    save() { stack.push(m.slice()); },
    restore() { if (stack.length) m = stack.pop(); },
    translate(x, y) { mul([1, 0, 0, 1, x, y]); },
    scale(x, y) { mul([x, 0, 0, y, 0, 0]); },
    rotate(a) { mul([Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]); },

    beginPath() {}, closePath() {}, fill() {}, stroke() {}, clip() {},
    moveTo: apply,
    lineTo: apply,
    quadraticCurveTo(cx, cy, x, y) { apply(cx, cy); apply(x, y); },
    bezierCurveTo(c1x, c1y, c2x, c2y, x, y) { apply(c1x, c1y); apply(c2x, c2y); apply(x, y); },
    arc(x, y) { apply(x, y); },
    ellipse(x, y) { apply(x, y); },
    // Deliberately not recorded: it is the full-frame sky flash, not the figure.
    fillRect() {},
    createRadialGradient: () => noopGradient,
    createLinearGradient: () => noopGradient,

    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '#000', strokeStyle: '#000',
    lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
    filter: 'none',
  };
}

const santa = christmas.find((e) => e.id === 'santa');
const defaults = Object.fromEntries(santa.params.map((p) => [p.key, p.default]));

/** Run the effect once and return the mean x of everything it drew. */
function centroidX(overrides, t) {
  const g = recordingContext();
  santa.draw({
    g,
    p: { ...defaults, ...overrides },
    shape: {
      id: 'frame',
      path: {},
      bbox: { x: 0, y: 0, w: 1920, h: 1080, cx: 960, cy: 540 },
    },
    t,
    dt: 1 / 60,
    rng: makeRng('figures'),
    noise: createNoise('figures'),
    state: {},
    world: { w: 1920, h: 1080 },
  });
  if (!g.points.length) return null;
  return g.points.reduce((sum, pt) => sum + pt.x, 0) / g.points.length;
}

console.log('— Santa flies nose-first —');

// The sleigh alone fixes where the rig *is*; adding the team shows which side
// of it they are harnessed to. They must be on the side it is heading towards.
for (const [direction, sign] of [['right', 1], ['left', -1]]) {
  const base = { direction, reindeer: 0, trail: 0, size: 0.25, crossing: 9, interval: 45 };
  const t = 4;
  const sleighOnly = centroidX(base, t);
  const withTeam = centroidX({ ...base, reindeer: 4 }, t);

  ok(`the rig draws something (${direction})`, sleighOnly !== null && withTeam !== null);

  const lead = (withTeam - sleighOnly) * sign;
  ok(`the reindeer lead the sleigh travelling ${direction}`, lead > 0,
     `team is ${Math.abs(lead).toFixed(0)}px ${lead > 0 ? 'ahead of' : 'BEHIND'} the sleigh`);
}

// And the rig has to be mirrored between the two, not merely translated: if the
// scale factor loses its sign the team ends up trailing in one direction and
// leading in the other, which is half-right and reads as a bug either way.
{
  const t = 4;
  const shape = { reindeer: 4, trail: 0, size: 0.25, crossing: 9, interval: 45 };
  const right = centroidX({ ...shape, direction: 'right' }, t);
  const rightSleigh = centroidX({ ...shape, direction: 'right', reindeer: 0 }, t);
  const left = centroidX({ ...shape, direction: 'left' }, t);
  const leftSleigh = centroidX({ ...shape, direction: 'left', reindeer: 0 }, t);

  ok('the rig is mirrored between the two directions, not just moved',
     Math.sign(right - rightSleigh) === -Math.sign(left - leftSleigh),
     `offset ${(right - rightSleigh).toFixed(0)} going right, ${(left - leftSleigh).toFixed(0)} going left`);
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
process.exit(failures ? 1 : 0);
