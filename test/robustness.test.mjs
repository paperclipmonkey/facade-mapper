/**
 * Every effect in the library, against everything a traced shape can be.
 *
 * The rest of the test suite checks that particular effects make the claims
 * they say they make. This one is the opposite: it makes no claim about any
 * effect in particular, and instead holds all eighty-odd of them to the small
 * number of rules that apply to every one — the rules in
 * docs/writing-effects.md, which until now were enforced by nothing but the
 * author remembering them.
 *
 * The shapes matter as much as the rules. Real projects contain shapes nobody
 * would think to write a test for, because they are not shapes anybody *drew*:
 * a polygon whose points somebody dragged onto each other, an open path of one
 * point left behind by a mis-click, an outline traced against a camera frame
 * that has since been swapped for a portrait one. None of those are errors the
 * app should refuse — they are just geometry — and every one of them ends up
 * inside `draw` as a bounding box with a zero in it. An effect that divides by
 * that puts NaN into a path, and a canvas given NaN silently draws nothing at
 * all: the layer vanishes, the list says it is running, and there is no
 * message anywhere.
 *
 * What is checked, for every effect and every shape:
 *
 *   - it does not throw
 *   - nothing it hands the canvas is NaN or Infinity
 *   - it never calls `Math.random()`, which would make two projectors disagree
 *   - it does not set a filter or a shadow per particle, which costs a frame
 *   - it stops allocating canvases once it is warm
 *   - two runs of it draw exactly the same thing
 *
 * And the effect *schema* is checked too: ids unique, categories real, defaults
 * inside their own ranges. A select whose default is not one of its options is
 * a control that starts on a value it will not let you choose again.
 *
 *   node test/robustness.test.mjs
 */

import { listEffects, defaultParams, CATEGORIES } from '../js/effects/registry.js';
import { makeRng } from '../js/core/math.js';
import { EFFECT_TEMPLATE } from '../js/control/help.js';
/**
 * The stand-in browser, the shapes and the runner.
 *
 * Lifted out of this file when `params.test.mjs` needed the same three things:
 * a copy each would have been a copy that drifted, and the shapes in
 * particular are the part worth having in one place — every one of them stands
 * for a project somebody actually has.
 */
import {
  SHAPES,
  context,
  exercise,
  recordingContext,
  randomCallers,
  canvasCount,
  trackEffect,
  restoreRandom,
  EXPENSIVE_LIMIT,
} from './effectHarness.mjs';

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};


/* ------------------------------------------------------------------ *
 * The schema
 * ------------------------------------------------------------------ */

console.log('— the effect schema —');

const effects = listEffects();
ok('there are effects to check', effects.length > 50, `${effects.length} effects`);

{
  const ids = effects.map((e) => e.id);
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  ok('every id is unique', duplicates.length === 0, duplicates.join(', '));

  const nameless = effects.filter((e) => !e.name || e.name === e.id);
  ok('every effect has a name a human would pick it by', nameless.length === 0,
    nameless.map((e) => e.id).join(', '));

  const undescribed = effects.filter((e) => !e.description);
  ok('and a description, since the gallery is how anybody finds it',
    undescribed.length === 0, undescribed.map((e) => e.id).join(', '));

  const uncategorised = effects.filter((e) => !CATEGORIES.includes(e.category));
  ok('and a category the list will actually show it under',
    uncategorised.length === 0, uncategorised.map((e) => `${e.id}:${e.category}`).join(', '));

  const badScope = effects.filter((e) => e.scope !== 'shape' && e.scope !== 'global');
  ok('and a scope the renderer understands', badScope.length === 0,
    badScope.map((e) => `${e.id}:${e.scope}`).join(', '));
}

{
  const problems = [];
  for (const effect of effects) {
    const keys = new Set();
    for (const param of effect.params) {
      if (keys.has(param.key)) problems.push(`${effect.id}.${param.key} is declared twice`);
      keys.add(param.key);
      if (!param.label) problems.push(`${effect.id}.${param.key} has no label`);
      if (param.default === undefined) problems.push(`${effect.id}.${param.key} has no default`);

      if (param.type === 'range' || param.type === 'number') {
        if (typeof param.default !== 'number') {
          problems.push(`${effect.id}.${param.key} defaults to ${typeof param.default}`);
        } else if (param.min !== undefined && param.default < param.min) {
          problems.push(`${effect.id}.${param.key} defaults below its own minimum`);
        } else if (param.max !== undefined && param.default > param.max) {
          problems.push(`${effect.id}.${param.key} defaults above its own maximum`);
        }
        if (param.type === 'range' && (param.min === undefined || param.max === undefined)) {
          problems.push(`${effect.id}.${param.key} is a slider with no ends`);
        }
      }

      /**
       * A select whose default is not one of its options is a control that
       * starts on a value you cannot get back to once you have moved it, and
       * the inspector shows the dropdown with nothing selected.
       */
      if (param.type === 'select' && !(param.options || []).includes(param.default)) {
        problems.push(`${effect.id}.${param.key} defaults to "${param.default}", not in its options`);
      }
      /**
       * The same complaint about a slider.
       *
       * A range control walks from its minimum in whole steps, so a default
       * that does not sit on one of them is a value the slider cannot produce
       * — you can leave it but never get back to it. Sparkler's spark size
       * defaulted to 2.6 from a minimum of 0.5 in steps of 0.2, which lands on
       * 2.5 and 2.7 and never on where it started.
       */
      if ((param.type === 'range' || param.type === 'number')
          && typeof param.default === 'number' && param.step > 0 && param.min !== undefined) {
        const steps = (param.default - param.min) / param.step;
        const off = Math.abs(steps - Math.round(steps));
        // A millionth of a step, because these are decimals in binary floats.
        if (off > 1e-6 && off < 1 - 1e-6) {
          problems.push(
            `${effect.id}.${param.key} defaults to ${param.default}, which its own step of `
            + `${param.step} from ${param.min} never lands on`
          );
        }
      }
      if (param.type === 'color' && !/^#[0-9a-fA-F]{3,8}$/.test(String(param.default))) {
        problems.push(`${effect.id}.${param.key} defaults to "${param.default}", which is not a hex colour`);
      }
    }
  }
  ok('every parameter is one the inspector can build a control for',
    problems.length === 0, problems.slice(0, 6).join('; '));
}

{
  // `defaultParams` is what a new layer is built from, so a parameter missing
  // from it is one the effect will only ever see as undefined.
  const missing = [];
  for (const effect of effects) {
    const defaults = defaultParams(effect.id);
    for (const param of effect.params) {
      if (!(param.key in defaults)) missing.push(`${effect.id}.${param.key}`);
    }
  }
  ok('and a new layer starts with every one of them set', missing.length === 0,
    missing.join(', '));
}

/* ------------------------------------------------------------------ *
 * The sweep
 * ------------------------------------------------------------------ */

console.log('\n— every effect, every shape —');

{
  const threw = [];
  const nonFinite = [];
  const shapeNames = Object.keys(SHAPES);

  for (const effect of effects) {
    for (const name of shapeNames) {
      const result = exercise(effect, SHAPES[name]);
      if (result.threw) threw.push(`${effect.id} on ${name}: ${result.threw}`);
      if (result.bad.length) nonFinite.push(`${effect.id} on ${name}: ${result.bad[0]}`);
    }
  }

  ok(`nothing throws on any of ${shapeNames.length} awkward shapes`,
    threw.length === 0, threw.slice(0, 4).join(' | '));

  /**
   * The quiet one.
   *
   * Canvas takes NaN without complaint and draws nothing, so an effect that
   * divides by a zero-height bounding box does not fail — it disappears, while
   * the layer list goes on saying it is running and the inspector goes on
   * offering its sliders. There is no message anywhere and nothing to search
   * for. This is the check that turns that into a line of output.
   */
  ok('and nothing hands the canvas a number that is not one',
    nonFinite.length === 0, nonFinite.slice(0, 4).join(' | '));

  ok(`covering ${effects.length * shapeNames.length} effect-and-shape pairs`, true,
    `${effects.length} × ${shapeNames.length}`);
}

/* ------------------------------------------------------------------ *
 * The three rules
 * ------------------------------------------------------------------ */

console.log('\n— the rules every effect has to keep —');

ok('no effect reaches for Math.random', randomCallers.size === 0,
  [...randomCallers].join(', '));

{
  // Already enforced inside `exercise`, which stops at the first offender; this
  // is the line that says so.
  ok(`no effect sets a filter or a shadow more than ${EXPENSIVE_LIMIT} times in a frame`,
    true, 'checked on every frame of the sweep above');
}

{
  /**
   * Warm effects stop allocating.
   *
   * Everything that pre-bakes a sprite ladder or accumulates into an offscreen
   * canvas is supposed to make it once and keep it in `state`. Making it per
   * frame is the single most expensive mistake available in this codebase —
   * a canvas allocation is a page of memory and a driver round trip — and the
   * symptom is a show that is smooth for ten seconds and then is not.
   *
   * So: run each effect until it has built whatever it builds, then count.
   */
  const rebuilders = [];
  for (const effect of effects) {
    const shape = SHAPES.window;
    const state = {};
    const g = recordingContext(() => {}, null);
    trackEffect(effect.id);
    try {
      if (effect.init) {
        Object.assign(state, effect.init(
          context(effect, shape, { g: null, t: 0, state, rng: makeRng('warm#0') })
        ) || {});
      }
      for (let i = 1; i <= 120; i++) {
        effect.step?.(context(effect, shape, {
          g: null, t: i / 60, state, rng: makeRng(`warm#${i}`),
        }));
      }
      // Warm-up draws: whatever is going to be built, build it.
      for (let i = 0; i < 4; i++) {
        effect.draw(context(effect, shape, {
          g, t: 2 + i / 60, state, rng: makeRng(`warm~${i}`),
        }));
      }
      const before = canvasCount();
      for (let i = 0; i < 10; i++) {
        effect.draw(context(effect, shape, {
          g, t: 2.1 + i / 60, state, rng: makeRng(`warm~b${i}`),
        }));
      }
      const made = canvasCount() - before;
      if (made > 0) rebuilders.push(`${effect.id} made ${made} canvases in 10 frames`);
    } catch {
      // Throwing is the sweep's business, not this check's.
    }
    trackEffect('');
  }
  ok('and none of them allocates a canvas once it is warm',
    rebuilders.length === 0, rebuilders.slice(0, 4).join('; '));
}

/* ------------------------------------------------------------------ *
 * Two tabs, one show
 * ------------------------------------------------------------------ */

console.log('\n— two tabs draw the same frame —');

{
  /**
   * The property the whole renderer is built around.
   *
   * Two projectors covering one wall have to paint the same animation into the
   * shared band. The renderer guarantees the *inputs* are identical — the same
   * project, the same show time, a generator reseeded from the same step index
   * — so anything that differs between two runs from those inputs is the
   * effect's own doing: a captured `Date.now()`, a counter that survives a
   * reload, an iteration over a Set built from object identity.
   *
   * Checked at a show time deliberately not zero, because half of these fade in
   * over their first second and every one of them agrees at t = 0.
   */
  const differ = [];
  for (const effect of effects) {
    const a = [];
    const b = [];
    exercise(effect, SHAPES.window, { seconds: 2, seed: 'twin', journal: a });
    exercise(effect, SHAPES.window, { seconds: 2, seed: 'twin', journal: b });
    if (a.length !== b.length) {
      differ.push(`${effect.id}: ${a.length} calls vs ${b.length}`);
      continue;
    }
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        differ.push(`${effect.id}: call ${i} is "${a[i]}" then "${b[i]}"`);
        break;
      }
    }
  }
  ok('every effect draws identically in two tabs at the same show time',
    differ.length === 0, differ.slice(0, 4).join(' | '));
}

/* ------------------------------------------------------------------ *
 * The one everybody starts from
 * ------------------------------------------------------------------ */

console.log('\n— the starter template —');

{
  /**
   * Nothing checked this at all, and it is the first line of every custom
   * effect anybody writes. It is a plain module with no imports of its own —
   * the registry appends the `fx` namespace, which the template does not use —
   * so it loads here from a data: URL and faces the same rules as the eighty
   * built-ins.
   *
   * The rule it was breaking is the one the whole `step`/`draw` split exists
   * for. Its `step` advanced `state.phase` and its `draw` ignored it, animating
   * straight off `t` — so the state was dead, and the example taught the shape
   * that makes two projectors disagree. It also meant every effect started from
   * this template declared a `step`, which puts it on the catch-up path: a tab
   * joining an hour in runs 216,000 no-op steps before it draws anything.
   */
  let def = null;
  let loadError = null;
  try {
    const url = `data:text/javascript;base64,${Buffer.from(EFFECT_TEMPLATE).toString('base64')}`;
    def = (await import(url)).default;
  } catch (err) {
    loadError = err.message;
  }

  ok('the starter template is a module that loads', !!def, loadError || '');

  if (def) {
    ok('and exports the shape the registry insists on',
      typeof def.draw === 'function' && Array.isArray(def.params) && !!def.name);

    const declared = new Set(def.params.map((p) => p.key));
    const used = new Set(
      [...`${def.draw}${def.step || ''}${def.init || ''}`.matchAll(/\bp\.([A-Za-z_$][\w$]*)/g)]
        .map((m) => m[1])
    );
    const unused = [...declared].filter((key) => !used.has(key));
    const undeclared = [...used].filter((key) => !declared.has(key));
    ok('every parameter it declares is one it uses', unused.length === 0, unused.join(', '));
    ok('and every one it uses is declared', undeclared.length === 0, undeclared.join(', '));

    /**
     * The whole point of the example. `draw` paints what `step` decided, so
     * somebody copying it copies the split rather than the thing that looks
     * like it works on one machine.
     */
    if (def.step) {
      const written = [...`${def.step}`.matchAll(/\bstate\.([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]);
      const read = new Set([...`${def.draw}`.matchAll(/\bstate\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
      const ignored = written.filter((key) => !read.has(key));
      ok('what its `step` writes is what its `draw` paints', ignored.length === 0,
        ignored.length ? `draw never reads state.${ignored.join(', state.')}` : '');
      ok('and its `draw` does not animate off `t` behind `step`\'s back',
        !/\bt\b\s*[*+\-/%]|[*+\-/%]\s*\bt\b/.test(`${def.draw}`.replace(/\/\/[^\n]*/g, '')));
    }

    // And it has to survive what every other effect survives.
    const template = {
      id: 'starter-template',
      params: def.params,
      init: def.init,
      step: def.step,
      draw: def.draw,
    };
    const broken = [];
    for (const name of Object.keys(SHAPES)) {
      const result = exercise(template, SHAPES[name], { p: Object.fromEntries(def.params.map((p) => [p.key, p.default])) });
      if (result.threw) broken.push(`${name}: ${result.threw}`);
      else if (result.bad.length) broken.push(`${name}: ${result.bad[0]}`);
    }
    ok('and it runs on every shape a project can contain', broken.length === 0,
      broken.slice(0, 2).join(' | '));
  }
}

restoreRandom();

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
