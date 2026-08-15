/**
 * The command palette's matcher and command list.
 *
 * The matching is the part worth testing: a palette that puts the right answer
 * third is worse than no palette, because you have to read the list every time
 * rather than typing three letters and pressing Enter. So the tests are mostly
 * of the form "for this query, this command is first".
 *
 * The panel list is checked against index.html, because it is duplicated there
 * and nothing else would catch a renamed tab.
 *
 *   node test/palette.test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fuzzyScore, rankCommands, buildCommands, PANELS } from '../js/control/palette.js';
import { listEffects } from '../js/effects/registry.js';

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

/* ------------------------------------------------------------------ *
 * fuzzyScore
 * ------------------------------------------------------------------ */

console.log('— matching —');

ok('an empty query matches everything neutrally', fuzzyScore('', 'Anything') === 0);
ok('letters not present do not match', fuzzyScore('zzz', 'Candle Flicker') === -1);
ok('out-of-order letters do not match', fuzzyScore('els', 'Snow') === -1);
ok('initials match', fuzzyScore('bb', 'Bouncing Balls') > 0);
ok('a fragment matches', fuzzyScore('cand', 'Candle Flicker') > 0);

ok(
  'a run beats the same letters scattered',
  fuzzyScore('snow', 'Snow') > fuzzyScore('snow', 'Set the number of windows'),
  `${fuzzyScore('snow', 'Snow').toFixed(1)} vs ${fuzzyScore('snow', 'Set the number of windows').toFixed(1)}`
);

ok(
  'a match at the start beats one in the middle',
  fuzzyScore('fog', 'Fog Bank') > fuzzyScore('fog', 'Rolling seafog'),
  `${fuzzyScore('fog', 'Fog Bank').toFixed(1)} vs ${fuzzyScore('fog', 'Rolling seafog').toFixed(1)}`
);

ok(
  'a word boundary beats mid-token',
  fuzzyScore('bat', 'Flying Bats') > fuzzyScore('bat', 'Acrobatics'),
  `${fuzzyScore('bat', 'Flying Bats').toFixed(1)} vs ${fuzzyScore('bat', 'Acrobatics').toFixed(1)}`
);

ok(
  'the shorter of two equal matches wins',
  fuzzyScore('snow', 'Snow') > fuzzyScore('snow', 'Snow settling on every sill you traced')
);

ok('matching is case-insensitive', fuzzyScore('SNOW', 'snow') > 0 && fuzzyScore('snow', 'SNOW') > 0);

/* ------------------------------------------------------------------ *
 * The command list
 * ------------------------------------------------------------------ */

console.log('\n— commands —');

const shapes = [
  { id: 's1', name: 'Front door', tags: ['door'] },
  { id: 's2', name: 'Left window', tags: ['window'] },
];
const app = {
  project: {
    shapes,
    layers: [{ id: 'l1', effect: 'snow', name: 'Blizzard' }],
    scenes: [{ id: 'sc1', name: 'Jump scare', hotkey: '1' }],
  },
  selection: { type: null, id: null },
  switchPanel() {},
  select() {},
  selectLayer() {},
  activateScene() {},
  addLayer() {},
};

const commands = buildCommands(app, { blackout: () => {}, looks: [['Haunted', 'Haunted']] });

ok('every effect can be added from the palette', listEffects().every((e) => commands.some((c) => c.id === `effect:${e.id}`)));
ok('every shape is selectable', shapes.every((s) => commands.some((c) => c.id === `shape:${s.id}`)));
ok('scenes are listed', commands.some((c) => c.id === 'scene:sc1'));
ok('layers are listed by their own name', commands.some((c) => c.id === 'layer:l1' && c.label === 'Blizzard'));
ok('looks are listed', commands.some((c) => c.id === 'look:Haunted'));
ok('every panel is reachable', PANELS.every(([key]) => commands.some((c) => c.id === `panel:${key}`)));
ok('every command can actually run', commands.every((c) => typeof c.run === 'function'));

ok(
  'actions that were not supplied are left out rather than left broken',
  !commands.some((c) => c.id === 'do:Help'),
  'no help handler was passed'
);

ok(
  'commands have unique ids',
  new Set(commands.map((c) => c.id)).size === commands.length
);

/* ------------------------------------------------------------------ *
 * Ranking end to end — the queries somebody actually types
 * ------------------------------------------------------------------ */

console.log('\n— ranking —');

const top = (query) => rankCommands(commands, query, 5)[0];

const cases = [
  ['snow', 'effect:snow'],
  ['door', 'shape:s1'],
  ['blackout', 'do:Blackout'],
  ['jump scare', 'scene:sc1'],
  ['haunted', 'look:Haunted'],
];
for (const [query, expected] of cases) {
  const first = top(query);
  ok(`"${query}" finds ${expected}`, first?.id === expected, `got ${first?.id || 'nothing'}`);
}

ok('an empty query still offers something to do', rankCommands(commands, '', 8).length > 0);
ok('nonsense matches nothing', rankCommands(commands, 'qqqqzzz', 8).length === 0);
ok('the limit is respected', rankCommands(commands, 'e', 4).length <= 4);

/* ------------------------------------------------------------------ *
 * The duplicated panel list
 * ------------------------------------------------------------------ */

console.log('\n— panels match the markup —');

const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const inMarkup = [...html.matchAll(/data-panel="([a-z]+)"/g)].map((m) => m[1]);
ok('the palette knows every panel in index.html', inMarkup.every((key) => PANELS.some(([k]) => k === key)), inMarkup.join(', '));
ok('and invents none', PANELS.every(([key]) => inMarkup.includes(key)));

console.log(failures ? `\n${failures} failing` : '\nall good');
process.exit(failures ? 1 : 0);
