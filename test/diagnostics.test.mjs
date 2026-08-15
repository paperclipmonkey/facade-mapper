/**
 * The "why can't I see it?" checks.
 *
 * These have to be right in both directions. A missed reason leaves somebody
 * outside in the dark clicking things at random, and a false alarm is worse
 * still: a warning chip that shows on a layer which is working perfectly well
 * teaches you to ignore the chips, and then the real one does nothing.
 *
 *   node test/diagnostics.test.mjs
 */

import { layerIssues, showIssues } from '../js/control/diagnostics.js';
import { createProject, createLayer, createShape } from '../js/core/state.js';
import { getEffect } from '../js/effects/registry.js';

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

const snow = getEffect('snow');
const keys = (issues) => issues.map((i) => i.key);

/** A project with one window, one door, and a layer over the whole frame. */
function scene() {
  const project = createProject('test');
  const window = createShape([[0.1, 0.1], [0.2, 0.1], [0.2, 0.2]], { name: 'Left window', tags: ['window'] });
  const door = createShape([[0.4, 0.5], [0.5, 0.5], [0.5, 0.8]], { name: 'Front door', tags: ['door'] });
  project.shapes = [window, door];
  const layer = createLayer('snow', { params: {} });
  project.layers = [layer];
  return { project, layer, window, door };
}

/* ------------------------------------------------------------------ *
 * Nothing wrong is reported as nothing wrong
 * ------------------------------------------------------------------ */

console.log('— quiet when it should be —');

{
  const { project, layer } = scene();
  ok('a plain whole-frame layer is clean', layerIssues(project, layer, snow).length === 0, keys(layerIssues(project, layer, snow)).join(','));
}

{
  const { project, layer, window } = scene();
  layer.targets = [window.id];
  ok('a layer on a real shape is clean', layerIssues(project, layer, snow).length === 0);
}

{
  const { project, layer } = scene();
  layer.targetTags = ['window'];
  ok('a layer on a tag something carries is clean', layerIssues(project, layer, snow).length === 0);
}

{
  const { project, layer } = scene();
  layer.solo = true;
  ok('the soloed layer is not warned about its own solo', !keys(layerIssues(project, layer, snow)).includes('solo'));
}

/* ------------------------------------------------------------------ *
 * Each way a layer goes dark
 * ------------------------------------------------------------------ */

console.log('\n— and loud when it should be —');

{
  const { project, layer } = scene();
  layer.enabled = false;
  ok('bypassed', keys(layerIssues(project, layer, snow)).includes('bypassed'));
}

{
  const { project, layer } = scene();
  const other = createLayer('snow');
  other.solo = true;
  project.layers.push(other);
  ok('soloed out by another layer', keys(layerIssues(project, layer, snow)).includes('solo'));
}

{
  const { project, layer } = scene();
  const other = createLayer('snow');
  other.solo = true;
  other.enabled = false;
  project.layers.push(other);
  ok('a bypassed solo does not count', !keys(layerIssues(project, layer, snow)).includes('solo'));
}

{
  const { project, layer } = scene();
  layer.opacity = 0;
  ok('opacity at zero', keys(layerIssues(project, layer, snow)).includes('opacity'));
}

{
  const { project, layer } = scene();
  layer.targetTags = ['gargoyle'];
  const issues = layerIssues(project, layer, snow);
  ok('a tag nothing carries', keys(issues).includes('no-tag'));
  ok('and it says which tag', issues.some((i) => i.text.includes('#gargoyle')));
}

{
  const { project, layer, window } = scene();
  layer.targets = [window.id];
  window.visible = false;
  const issues = layerIssues(project, layer, snow);
  ok('every target hidden', keys(issues).includes('hidden'));
  ok('and it names the shape', issues.some((i) => i.text.includes('Left window')));
}

{
  const { project, layer, window, door } = scene();
  layer.targets = [window.id, door.id];
  window.visible = false;
  ok('one of two hidden is not a problem', layerIssues(project, layer, snow).length === 0);
}

{
  // The case the demo house actually hits: presets point at a tag, not an id,
  // so hiding the only shape carrying it must read as hidden rather than as
  // "nothing carries that tag" — two different fixes.
  const { project, layer, window } = scene();
  layer.targetTags = ['window'];
  window.visible = false;
  const issues = layerIssues(project, layer, snow);
  ok('a hidden shape reached by tag reads as hidden', keys(issues).includes('hidden'), keys(issues).join(','));
  ok('and not as a missing tag', !keys(issues).includes('no-tag'));
}

{
  const { project, layer } = scene();
  layer.targets = ['shape_that_went_away'];
  ok('targets deleted since', keys(layerIssues(project, layer, snow)).includes('deleted'));
}

{
  const { project, layer } = scene();
  layer.effect = 'no_such_effect';
  const issues = layerIssues(project, layer, null);
  ok('a missing effect', keys(issues).includes('missing'));
  ok('and nothing else is guessed at on top of it', issues.length === 1);
}

{
  const { project, layer, window } = scene();
  layer.enabled = false;
  layer.targets = [window.id];
  window.visible = false;
  ok(
    'the most actionable reason comes first',
    layerIssues(project, layer, snow)[0].key === 'bypassed'
  );
}

/* ------------------------------------------------------------------ *
 * Tag matching is case-insensitive, which is the point of the fix
 * ------------------------------------------------------------------ */

console.log('\n— tags —');

{
  const { project, layer, window } = scene();
  window.tags = ['Window'];
  layer.targetTags = ['window'];
  ok('a tag typed with a capital still matches', layerIssues(project, layer, snow).length === 0);
}

/* ------------------------------------------------------------------ *
 * Show-wide
 * ------------------------------------------------------------------ */

console.log('\n— the whole show —');

{
  const { project } = scene();
  project.settings.blackout = true;
  ok('blackout', showIssues(project).some((i) => i.key === 'blackout'));
}

{
  const { project } = scene();
  project.settings.master = 0;
  ok('master down', showIssues(project).some((i) => i.key === 'master'));
}

{
  const { project } = scene();
  ok('paused', showIssues(project, { playing: false }).some((i) => i.key === 'paused'));
  ok('playing is not a problem', !showIssues(project, { playing: true }).some((i) => i.key === 'paused'));
}

{
  const { project } = scene();
  ok('no projector aligned yet', showIssues(project).some((i) => i.key === 'unaligned'));
  project.projectors[0].calibration = { H: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
  ok('and quiet once one is', !showIssues(project).some((i) => i.key === 'unaligned'));
}

{
  const { project, layer } = scene();
  layer.enabled = false;
  ok('everything bypassed', showIssues(project).some((i) => i.key === 'all-bypassed'));
}

{
  const project = createProject('empty');
  ok('an empty show does not claim everything is bypassed', !showIssues(project).some((i) => i.key === 'all-bypassed'));
}

console.log(failures ? `\n${failures} failing` : '\nall good');
process.exit(failures ? 1 : 0);
