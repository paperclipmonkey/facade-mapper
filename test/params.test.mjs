/**
 * Every effect, at both ends of every slider it has.
 *
 * `robustness.test.mjs` runs the whole library the way a new layer arrives with
 * it — every parameter at its default — against every shape a project can
 * contain. That is the commonest case and it is not the interesting one. The
 * defaults are the values the author was looking at while writing the effect;
 * the ends of the sliders are the values nobody has ever seen, and they are one
 * drag away in the inspector.
 *
 * What goes wrong there is specific and quiet. A count of zero leaves an empty
 * array and a `total / count`. A scale of zero becomes a divisor. A "sparks per
 * shell" at three hundred, on a shape one pixel wide, is a spacing of a
 * three-hundredth of a pixel. None of it throws in a way anybody sees: canvas
 * takes NaN without complaint and draws nothing, so the layer disappears while
 * the list goes on saying it is running. That is precisely the failure the
 * robustness sweep exists to catch, checked at the one set of values it does
 * not check.
 *
 * Three sweeps, in order of how much they are asking for:
 *
 *   1. **One at a time.** Every parameter pushed to its own minimum and
 *      maximum — every option of every dropdown, both states of every switch —
 *      with the rest left at their defaults. This is what somebody dragging a
 *      single slider does, and it says which parameter is at fault when it
 *      fails.
 *   2. **All at once.** Every parameter at its minimum together, and every one
 *      at its maximum together, over the whole awkward-shape set. Ends
 *      interact: a count of zero and a size of zero are each survivable and the
 *      pair is a different question.
 *   3. **Still the same in two tabs.** The property the renderer is built
 *      around, re-checked at the extremes rather than at the defaults, because
 *      a `Math.random()` or a captured `Date.now()` reached for only in the
 *      biggest branch of an effect is exactly the sort that hides behind a
 *      default.
 *
 *   node test/params.test.mjs
 */

import { listEffects, defaultParams } from '../js/effects/registry.js';
import { SHAPES, exercise, restoreRandom } from './effectHarness.mjs';

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

const effects = listEffects();

/**
 * The values worth trying for one parameter.
 *
 * Only what the inspector can actually produce: a slider stops at its ends, a
 * dropdown offers its options and a switch has two states. A colour has no
 * extremes to speak of and a text field is somebody's own words, so both are
 * left where the effect's author put them — the sweep is about the values the
 * *control* can reach, not about arbitrary input.
 */
function endsOf(param) {
  if (param.type === 'range' || param.type === 'number') {
    const out = [];
    if (param.min !== undefined) out.push(['min', param.min]);
    if (param.max !== undefined) out.push(['max', param.max]);
    return out;
  }
  if (param.type === 'bool') return [['off', false], ['on', true]];
  if (param.type === 'select') return (param.options || []).map((o) => [`"${o}"`, o]);
  return [];
}

/** One end of every parameter at once — the value a "reset to nothing" would give. */
function allAt(effect, which) {
  const p = defaultParams(effect.id);
  for (const param of effect.params) {
    const ends = endsOf(param);
    if (!ends.length) continue;
    p[param.key] = which === 'min' ? ends[0][1] : ends[ends.length - 1][1];
  }
  return p;
}

/* ------------------------------------------------------------------ *
 * One slider at a time
 * ------------------------------------------------------------------ */

console.log('— every parameter, at both of its ends —');

{
  const threw = [];
  const nonFinite = [];
  /** A shape with room in it, and the whole frame, which is what most layers get. */
  const shapes = [SHAPES.window, SHAPES.frame];
  let combinations = 0;

  for (const effect of effects) {
    const base = defaultParams(effect.id);
    for (const param of effect.params) {
      for (const [label, value] of endsOf(param)) {
        for (const shape of shapes) {
          combinations++;
          const result = exercise(effect, shape, {
            p: { ...base, [param.key]: value },
            seed: `end:${param.key}`,
          });
          const where = `${effect.id}.${param.key}=${label} on ${shape.id}`;
          if (result.threw) threw.push(`${where}: ${result.threw}`);
          else if (result.bad.length) nonFinite.push(`${where}: ${result.bad[0]}`);
        }
      }
    }
  }

  ok('no slider end makes an effect throw', threw.length === 0, threw.slice(0, 4).join(' | '));
  ok('and none of them puts a number that is not one on the canvas',
    nonFinite.length === 0, nonFinite.slice(0, 4).join(' | '));
  ok('across every control the inspector can move', combinations > 2000,
    `${combinations} parameter-value-and-shape combinations`);
}

/* ------------------------------------------------------------------ *
 * Every slider at once
 * ------------------------------------------------------------------ */

console.log('\n— everything at one end together, on every awkward shape —');

{
  const threw = [];
  const nonFinite = [];
  const shapeNames = Object.keys(SHAPES);
  let combinations = 0;

  for (const effect of effects) {
    for (const which of ['min', 'max']) {
      const p = allAt(effect, which);
      for (const name of shapeNames) {
        combinations++;
        const result = exercise(effect, SHAPES[name], { p, seed: `all:${which}` });
        const where = `${effect.id} all-${which} on ${name}`;
        if (result.threw) threw.push(`${where}: ${result.threw}`);
        else if (result.bad.length) nonFinite.push(`${where}: ${result.bad[0]}`);
      }
    }
  }

  ok('nothing throws with every parameter at one end', threw.length === 0,
    threw.slice(0, 4).join(' | '));
  ok('and nothing draws with a NaN in it either', nonFinite.length === 0,
    nonFinite.slice(0, 4).join(' | '));
  ok(`covering ${combinations} extreme-and-shape pairs`, true,
    `${effects.length} effects × 2 ends × ${shapeNames.length} shapes`);
}

/* ------------------------------------------------------------------ *
 * Two tabs, at the extremes
 * ------------------------------------------------------------------ */

console.log('\n— two tabs still draw the same frame —');

{
  const differ = [];
  for (const effect of effects) {
    for (const which of ['min', 'max']) {
      const p = allAt(effect, which);
      const a = [];
      const b = [];
      exercise(effect, SHAPES.window, { seconds: 2, seed: 'twin', journal: a, p });
      exercise(effect, SHAPES.window, { seconds: 2, seed: 'twin', journal: b, p });
      if (a.length !== b.length) {
        differ.push(`${effect.id} all-${which}: ${a.length} calls vs ${b.length}`);
        continue;
      }
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
          differ.push(`${effect.id} all-${which}: call ${i} is "${a[i]}" then "${b[i]}"`);
          break;
        }
      }
    }
  }
  ok('every effect agrees with itself at both extremes', differ.length === 0,
    differ.slice(0, 4).join(' | '));
}

restoreRandom();

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
