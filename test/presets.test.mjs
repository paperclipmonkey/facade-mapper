/**
 * The starter presets, checked against the effects they configure.
 *
 * A preset is a pile of literal parameter objects, and nothing at runtime
 * complains when a key in one does not exist on the effect it is aimed at — the
 * value is simply dropped and the effect quietly runs on its default. That is
 * the worst kind of bug: the preset looks configured, reads as configured in
 * review, and is not. The Christmas starter carried `settle: 0` on the snow
 * layer for exactly that reason; snow has no `settle` parameter, so the setting
 * did nothing at all and the effect ran with collision fully enabled.
 *
 * These tests are all of the form "the preset says what it means".
 *
 *   node test/presets.test.mjs
 */

import { PRESETS, applyPreset, addDemoBursts } from '../js/control/presets.js';
import { createProject } from '../js/core/state.js';
import { getEffect } from '../js/effects/registry.js';
import { BINDING_TYPES, WAVES, compileExpression } from '../js/core/modulators.js';
import { GRADE_PRESETS } from '../js/render/postfx.js';
import { SHAPE_TAGS } from '../js/core/state.js';
import { demoShapes } from '../js/control/demoHouse.js';

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

/* ------------------------------------------------------------------ *
 * Every parameter a preset sets must exist on the effect
 * ------------------------------------------------------------------ */

console.log('— parameter names —');

for (const preset of PRESETS) {
  const layers = preset.build();
  const unknown = [];
  const missingEffect = [];

  for (const layer of layers) {
    const effect = getEffect(layer.effect);
    if (!effect) {
      missingEffect.push(layer.effect);
      continue;
    }
    const keys = new Set(effect.params.map((p) => p.key));
    for (const key of Object.keys(layer.params || {})) {
      if (!keys.has(key)) unknown.push(`${preset.id}/${layer.name}: ${layer.effect}.${key}`);
    }
  }

  ok(`${preset.id} only names effects that exist`, missingEffect.length === 0, missingEffect.join(', '));
  ok(
    `${preset.id} sets only parameters its effects have`,
    unknown.length === 0,
    unknown.join('; ')
  );
}

/* ------------------------------------------------------------------ *
 * Bindings, which have the same failure mode
 * ------------------------------------------------------------------ */

console.log('\n— modulation bindings —');

for (const preset of PRESETS) {
  const bad = [];
  for (const layer of preset.build()) {
    const effect = getEffect(layer.effect);
    if (!effect) continue;
    const keys = new Set(effect.params.map((p) => p.key));
    for (const [key, binding] of Object.entries(layer.bindings || {})) {
      if (!keys.has(key)) bad.push(`${layer.name}: no ${layer.effect}.${key} to modulate`);
      if (!binding?.type) bad.push(`${layer.name}.${key}: binding has no type`);
    }
  }
  ok(`${preset.id} only modulates parameters that exist`, bad.length === 0, bad.join('; '));
}

/* ------------------------------------------------------------------ *
 * The rest of the preset contract
 * ------------------------------------------------------------------ */

console.log('\n— preset shape —');

for (const preset of PRESETS) {
  const layers = preset.build();
  ok(`${preset.id} builds layers`, layers.length > 0, `${layers.length}`);
  ok(
    `${preset.id} names a grade that exists`,
    GRADE_PRESETS.some((g) => g.id === preset.grade),
    preset.grade
  );

  // Every layer either targets a tag, targets shapes, or deliberately covers
  // the whole frame. A layer whose only targeting is an empty tag list is a
  // typo that silently becomes a full-frame effect.
  const emptyTags = layers.filter((l) => Array.isArray(l.targetTags) && l.targetTags.some((t) => !t));
  ok(`${preset.id} has no blank tags`, emptyTags.length === 0, emptyTags.map((l) => l.name).join(', '));

  const unnamed = layers.filter((l) => !l.name);
  ok(`${preset.id} names every layer`, unnamed.length === 0, `${unnamed.length} unnamed`);
}

/* ------------------------------------------------------------------ *
 * Layers that would misbehave without their tag
 *
 * A preset layer marked `needsTag` is one whose no-targets fallback is
 * actively wrong — text laid along a path with no path wraps itself round the
 * edge of the picture. `applyPreset` drops those when the tag is absent, so
 * the marker has to actually be set on them.
 * ------------------------------------------------------------------ */

console.log('\n— tag-dependent layers —');

for (const preset of PRESETS) {
  const pathText = preset.build().filter((l) => l.effect === 'text' && l.params?.mode === 'path');
  const unguarded = pathText.filter((l) => !l.__needsTag);
  ok(
    `${preset.id} guards its path text against having no path`,
    unguarded.length === 0,
    unguarded.map((l) => l.name).join(', ')
  );
}

/* ------------------------------------------------------------------ *
 * The tags a preset asks for have to exist
 *
 * A preset targets by tag, and a tag is just a string — so a preset aimed at
 * `#planter` on a house with no planter traced is not an error anywhere. It is
 * a layer that draws nothing, or worse, one whose no-targets fallback covers
 * the whole frame. Two things stop that being silent: the tag has to be one
 * the tag picker offers, and the demo house has to carry it, or the demo that
 * exists to show the preset off shows it off with the layer missing.
 * ------------------------------------------------------------------ */

console.log('\n— tags that have to exist —');

{
  const traced = new Set(demoShapes().flatMap((s) => s.tags || []));
  const offered = new Set(SHAPE_TAGS);

  for (const preset of PRESETS) {
    const wanted = new Set(preset.build().flatMap((l) => l.targetTags || []));
    const unknown = [...wanted].filter((t) => !offered.has(t));
    ok(`${preset.id} targets only tags the picker offers`, unknown.length === 0, unknown.join(', '));

    const untraced = [...wanted].filter((t) => !traced.has(t));
    ok(`${preset.id} targets only tags the demo house has`, untraced.length === 0, untraced.join(', '));
  }

  // And the other direction, because `tagsUsed` is what the toast reports as
  // missing: it must name the tags the preset actually points at.
  for (const preset of PRESETS) {
    const wanted = new Set(preset.build().flatMap((l) => l.targetTags || []));
    const overclaimed = (preset.tagsUsed || []).filter((t) => !wanted.has(t));
    ok(`${preset.id} claims only tags it uses`, overclaimed.length === 0, overclaimed.join(', '));
  }
}

/* ------------------------------------------------------------------ *
 * And the values must be values the control can produce
 * ------------------------------------------------------------------ */

/**
 * The other half of "the preset says what it means".
 *
 * The checks above make sure a preset only names parameters that exist. This
 * one makes sure the *values* are ones the inspector's control could have
 * produced, which is a different failure with the same shape: `resolveParams`
 * clamps a number to the slider's ends and every consumer of a `select`
 * falls back when it does not recognise the option, so a preset asking for
 * something out of range is not an error anywhere — it is a stored value that
 * differs from the one on the wall, with a slider pinned at its end or a
 * dropdown showing nothing selected.
 *
 * Both were in here. The Christmas icicles asked for a width of 4 against a
 * slider that stops at 3, and the birthday headline asked for a font called
 * `rounded`, which the Text effect has never had — so it rendered in the
 * system face while the dropdown showed no selection at all.
 *
 * Run against the *applied* project rather than `build()`, so anything the
 * demo bursts add is covered by the same rule.
 */
console.log('\n— parameter values —');

const HEX = /^#[0-9a-fA-F]{3,8}$/;

function appliedProject(presetId) {
  const project = createProject('test');
  project.shapes = demoShapes();
  applyPreset(project, presetId);
  addDemoBursts(project);
  return project;
}

for (const preset of PRESETS) {
  const project = appliedProject(preset.id);
  const wrong = [];

  for (const layer of project.layers) {
    const effect = getEffect(layer.effect);
    if (!effect) continue;
    const byKey = new Map(effect.params.map((p) => [p.key, p]));

    for (const [key, value] of Object.entries(layer.params || {})) {
      const def = byKey.get(key);
      if (!def) continue; // Named above; not this check's business.
      const where = `${layer.name}.${key}`;

      if (def.type === 'range' || def.type === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          wrong.push(`${where} = ${JSON.stringify(value)} for a ${def.type}`);
        } else if (def.min !== undefined && value < def.min) {
          wrong.push(`${where} = ${value}, below its minimum of ${def.min}`);
        } else if (def.max !== undefined && value > def.max) {
          wrong.push(`${where} = ${value}, above its maximum of ${def.max}`);
        }
      } else if (def.type === 'select' && !(def.options || []).includes(value)) {
        wrong.push(`${where} = ${JSON.stringify(value)}, not one of ${JSON.stringify(def.options)}`);
      } else if (def.type === 'color' && !HEX.test(String(value))) {
        wrong.push(`${where} = ${JSON.stringify(value)}, which is not a hex colour`);
      } else if (def.type === 'bool' && typeof value !== 'boolean') {
        wrong.push(`${where} = ${JSON.stringify(value)} for a switch`);
      }
    }
  }

  ok(`${preset.id} sets only values its controls can produce`, wrong.length === 0,
    wrong.slice(0, 3).join('; '));
}

/* ------------------------------------------------------------------ *
 * The modulation a preset ships with
 * ------------------------------------------------------------------ */

console.log('\n— bindings —');

const BANDS = ['level', 'low', 'mid', 'high'];

for (const preset of PRESETS) {
  const project = appliedProject(preset.id);
  const wrong = [];

  for (const layer of project.layers) {
    const effect = getEffect(layer.effect);
    if (!effect) continue;
    const byKey = new Map(effect.params.map((p) => [p.key, p]));

    for (const [key, binding] of Object.entries(layer.bindings || {})) {
      const where = `${layer.name}.${key}`;
      const def = byKey.get(key);
      if (!def) { wrong.push(`${where} modulates a parameter that does not exist`); continue; }
      if (!BINDING_TYPES.includes(binding.type)) {
        wrong.push(`${where} is a "${binding.type}" binding, which is not a kind`);
        continue;
      }
      /**
       * Modulation is arithmetic, and there is no arithmetic on a colour or a
       * string. The inspector only offers a binding on the numeric kinds, so a
       * preset carrying one anywhere else is a preset the UI could not have
       * produced — and `resolveParams` has to catch it at render time.
       */
      if (!['range', 'number', 'bool'].includes(def.type)) {
        wrong.push(`${where} modulates a ${def.type}, which cannot be modulated`);
      }
      if (binding.type === 'lfo' && binding.wave && !WAVES.includes(binding.wave)) {
        wrong.push(`${where} asks for a "${binding.wave}" wave`);
      }
      if (binding.type === 'audio' && binding.band && !BANDS.includes(binding.band)) {
        wrong.push(`${where} listens to a band called "${binding.band}"`);
      }
      if (binding.type === 'expr' && !compileExpression(binding.code || '').call) {
        wrong.push(`${where} has an expression that will not compile`);
      }
      if (binding.rate !== undefined && !(Number.isFinite(binding.rate) && binding.rate > 0)) {
        wrong.push(`${where} has a rate of ${binding.rate}`);
      }
      if (binding.depth !== undefined && !Number.isFinite(binding.depth)) {
        wrong.push(`${where} has a depth of ${binding.depth}`);
      }
    }
  }

  ok(`${preset.id} ships modulation the app can actually run`, wrong.length === 0,
    wrong.slice(0, 3).join('; '));
}

/* ------------------------------------------------------------------ *
 * What a preset leaves behind, once it has been applied
 * ------------------------------------------------------------------ */

console.log('\n— the show a preset builds —');

for (const preset of PRESETS) {
  const project = appliedProject(preset.id);
  const layerIds = new Set(project.layers.map((l) => l.id));
  const sceneIds = new Set(project.scenes.map((s) => s.id));

  const orphaned = project.scenes.flatMap((scene) =>
    Object.keys(scene.state || {})
      .filter((id) => !layerIds.has(id))
      .map((id) => `${scene.name} names a layer that is not here`)
  );
  ok(`${preset.id} builds scenes over its own layers`, orphaned.length === 0, orphaned[0] || '');

  const dangling = (project.triggers || [])
    .filter((t) => t.sceneId && !sceneIds.has(t.sceneId))
    .map((t) => t.name);
  ok(`${preset.id} builds triggers over its own scenes`, dangling.length === 0, dangling.join(', '));

  /**
   * A second trigger on a key another one already has is dead: `fireByKey`
   * takes the first that matches and does not look further. Same for two
   * scenes on one digit.
   */
  const keys = (project.triggers || []).filter((t) => t.source === 'hotkey').map((t) => t.key);
  const sharedKeys = [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];
  ok(`${preset.id} gives every hotkey trigger a key of its own`, sharedKeys.length === 0,
    sharedKeys.join(', '));

  const digits = project.scenes.map((s) => s.hotkey).filter(Boolean);
  const sharedDigits = [...new Set(digits.filter((k, i) => digits.indexOf(k) !== i))];
  ok(`${preset.id} gives every scene a digit of its own`, sharedDigits.length === 0,
    sharedDigits.join(', '));
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
