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

import { PRESETS } from '../js/control/presets.js';
import { getEffect } from '../js/effects/registry.js';
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

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
