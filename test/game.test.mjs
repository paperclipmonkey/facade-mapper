/**
 * The automation: steps, the runtime that walks them, and the picture of them.
 *
 * Everything it does happens in front of children, in the dark, from a button
 * nobody indoors can see being pressed. A question that never times out
 * strands the house for the rest of the evening; a press that queues answers a
 * question nobody has read. None of it is visible from the laptop, so all of
 * it is here.
 *
 * The clock is one this file moves by hand. Nothing sleeps.
 *
 *   node test/game.test.mjs
 */

import { ROLES, EVENT_LABELS, stepById, startStep, nextFor, exitsOf, roleOf, gameProblems, gameSceneIds, reachable } from '../js/core/game.js';
import { renderGameGraph, graphEdges, layoutSteps, formatSeconds } from '../js/core/gameGraph.js';
import { createGameRuntime } from '../js/control/game.js';
import { createGame, createStep, createProject, createScene, migrateProject } from '../js/core/state.js';

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

/* ------------------------------------------------------------------ *
 * A clock, a show, and a record of everything done to it
 * ------------------------------------------------------------------ */

let clock = Date.UTC(2026, 9, 31, 19, 0, 0);
const now = () => clock;
const advance = (seconds) => {
  clock += seconds * 1000;
};

/**
 * A small automation: a question, a scare on a timer, a question asked over
 * the scare with words alone, and the way to the door.
 *
 *   ask      "TRICK OR TREAT?"  YES → scare · NO → treat
 *   scare    scene, 5 s → more
 *   more     words only "MORE?" NO → scare · YES → treat · 120 s → ask
 *   treat    words only, DOOR → door · 120 s → ask
 *   door     scene, 4 s → ask
 */
function makeGame(overrides = {}) {
  const steps = [
    createStep({ id: 'ask', name: 'Trick or treat?', sceneId: 'sHouse', words: 'TRICK OR TREAT?', on: { yes: 'scare', no: 'treat' } }),
    createStep({ id: 'scare', name: 'Scare', sceneId: 'sScare', sound: 'scream', after: { seconds: 5, to: 'more' } }),
    createStep({ id: 'more', name: 'More?', words: 'MORE?', on: { no: 'scare', yes: 'treat' }, after: { seconds: 120, to: 'ask' } }),
    createStep({ id: 'treat', name: 'Come and get your treat', words: 'TREAT', alert: true, on: { door: 'door' }, after: { seconds: 120, to: 'ask' } }),
    createStep({ id: 'door', name: 'At the door', sceneId: 'sDoor', after: { seconds: 4, to: 'ask' } }),
  ];
  return createGame({ enabled: true, start: 'ask', steps, ...overrides });
}

function setup(overrides = {}) {
  const game = makeGame(overrides);
  const calls = [];
  const io = {
    scene: (id) => calls.push(['scene', id]),
    caption: (text) => calls.push(['caption', text]),
    sound: (id) => calls.push(['sound', id]),
    changed: () => {},
  };
  const runtime = createGameRuntime({ getGame: () => game, io, now });
  const lastOf = (kind) => calls.filter((c) => c[0] === kind).at(-1);
  const count = (kind) => calls.filter((c) => c[0] === kind).length;
  return { game, runtime, calls, lastOf, count };
}

/** Press a button once the step has been up long enough to be armed. */
function answer(runtime, button) {
  advance(0.5);
  return runtime.press({ button });
}

/** Let time run, ticking the way the control tab does. */
function through(runtime, seconds, step = 0.25) {
  for (let t = 0; t < seconds; t += step) {
    advance(step);
    runtime.tick();
  }
}

/* ------------------------------------------------------------------ *
 * The model
 * ------------------------------------------------------------------ */

console.log('— steps, and where they lead —');
{
  const game = makeGame();
  ok('three buttons: YES, NO and DOOR', ROLES.join() === 'yes,no,door');
  ok('and a timer is the fourth way out', EVENT_LABELS.timeout === 'time');
  ok('the start is the step named as the start', startStep(game).id === 'ask');
  ok('or the first, when none is named', startStep({ ...game, start: null }).id === 'ask');
  ok('and still the first when the named one has gone', startStep({ ...game, start: 'gone' }).id === 'ask');

  ok('a button leads where it says', nextFor(game, stepById(game, 'ask'), 'yes') === 'scare');
  ok('a button with nothing set leads nowhere', nextFor(game, stepById(game, 'ask'), 'door') === null);
  ok('a timer leads where it says', nextFor(game, stepById(game, 'scare'), 'timeout') === 'more');
  ok('a timer with no seconds is no timer',
    nextFor(game, createStep({ after: { seconds: 0, to: 'ask' } }), 'timeout') === null);
  ok('a link to a deleted step leads nowhere', nextFor(game, createStep({ on: { yes: 'gone' } }), 'yes') === null);
  ok('the ways out are listed buttons first',
    exitsOf(game, stepById(game, 'more')).map((e) => e.on).join() === 'yes,no,timeout');

  ok('every step is reachable from the start', reachable(game).size === 5);
  ok('the scenes the steps show are the automation’s', [...gameSceneIds(game)].sort().join() === 'sDoor,sHouse,sScare');
}

console.log('— buttons by role —');
{
  const game = makeGame({ buttons: { 'event.left': 'yes', 'event.front': 'door' } });
  ok('a mapped button plays its role', roleOf(game, 'event.front') === 'door');
  ok('a role pressed by name is that role', roleOf(game, 'no') === 'no');
  ok('an unknown button is nobody', roleOf(game, 'event.kitchen') === null);
  ok('and TREAT, which there no longer is, is nobody too', roleOf(game, 'treat') === null);
}

console.log('— problems, worded for the person building it —');
{
  const project = createProject('t');
  project.scenes = [createScene({ id: 'sHouse' }), createScene({ id: 'sScare' })];
  const game = makeGame({ buttons: { b: 'yes' } });
  game.steps.push(createStep({ id: 'stuck', name: 'Stuck' }));
  stepById(game, 'treat').on.door = 'stuck';
  stepById(game, 'more').after.to = 'gone';
  const problems = gameProblems(game, project);
  ok('a step that shows a deleted scene', problems.some((p) => p.includes('"At the door" shows a scene')));
  ok('a link to a deleted step', problems.some((p) => p.includes('"More?" leads to a step')));
  ok('a dead end', problems.some((p) => p.includes('Nothing moves on from "Stuck"')));
  ok('a step nothing reaches', problems.some((p) => p.includes('Nothing leads to "At the door"')));
  ok('a button listened for that nothing is mapped to', problems.some((p) => p.includes('listens for DOOR')));
  ok('an empty automation says so', gameProblems(createGame(), project)[0].includes('no steps'));
}

/* ------------------------------------------------------------------ *
 * The runtime
 * ------------------------------------------------------------------ */

console.log('— a group, all the way through —');
{
  const { runtime, lastOf, count } = setup();
  runtime.reset();
  ok('it starts at the start, showing its scene', runtime.step === 'ask' && lastOf('scene')?.[1] === 'sHouse');
  ok('and its words', lastOf('caption')?.[1] === 'TRICK OR TREAT?');
  ok('and is not yet away from the start', !runtime.active && runtime.snapshot().atStart);

  ok('a press straight away is too soon', runtime.press({ button: 'yes' }) === 'too soon');
  ok('YES once it has been read is the scare', answer(runtime, 'yes') === '→ Scare' && lastOf('scene')?.[1] === 'sScare');
  ok('with its sound', lastOf('sound')?.[1] === 'scream');
  ok('and no words over it', lastOf('caption')?.[1] === null);
  ok('away from the start now', runtime.active);
  ok('a button that leads nowhere from here is dropped', answer(runtime, 'yes') === 'not now');

  through(runtime, 4);
  ok('the scare runs for its time', runtime.step === 'scare');
  through(runtime, 1);
  ok('and then moves on by itself', runtime.step === 'more');
  const scenes = count('scene');
  ok('words alone keep the house as it is', lastOf('caption')?.[1] === 'MORE?' && count('scene') === scenes);

  ok('NO goes round again', answer(runtime, 'no') === '→ Scare');
  through(runtime, 5.2);
  ok('YES is the treat', answer(runtime, 'yes') === '→ Come and get your treat');
  ok('which is an alert step', runtime.snapshot().alert === true);
  ok('DOOR is them coming up', answer(runtime, 'door') === '→ At the door' && lastOf('scene')?.[1] === 'sDoor');
  through(runtime, 4.2);
  ok('and the show goes back to the start', runtime.step === 'ask' && lastOf('scene')?.[1] === 'sHouse');
}

console.log('— time —');
{
  const { runtime } = setup();
  runtime.reset();
  answer(runtime, 'no');
  ok('an unanswered question waits a good while', (through(runtime, 100), runtime.step === 'treat'));
  through(runtime, 20.5);
  ok('and then goes back to the start', runtime.step === 'ask');

  answer(runtime, 'yes');
  advance(200);
  runtime.tick();
  ok('a very late tick catches up through every timer it missed', runtime.step === 'ask');
  ok('and the last move is the one into the start', runtime.snapshot().last?.to === 'ask');

  runtime.reset();
  answer(runtime, 'yes');
  const snap = runtime.snapshot();
  ok('the snapshot says where it is and how long is left', snap.step === 'scare' && snap.name === 'Scare' && Math.abs(snap.remaining - 5) < 1e-9);
  ok('and the move that got it there', snap.last?.from === 'ask' && snap.last.on === 'yes' && snap.last.to === 'scare');
}

console.log('— presses are the hard part —');
{
  const { runtime } = setup({ buttons: { 'event.path_left': 'yes' } });
  runtime.reset();
  advance(1);
  ok('a press with an id counts once', runtime.press({ button: 'yes', id: 'ctx-1' }) === '→ Scare');
  through(runtime, 5.2);
  advance(1);
  ok('the same id again is a duplicate', runtime.press({ button: 'no', id: 'ctx-1' }) === 'duplicate');
  ok('a mapped button plays its role', runtime.press({ button: 'event.path_left' }) === '→ Come and get your treat');
  advance(1);
  ok('an unknown button is logged and dropped', runtime.press({ button: 'event.kitchen' }) === 'unmapped');
  ok('and stays in the log for naming', runtime.snapshot().log.some((e) => e.button === 'event.kitchen'));
  ok('a press from minutes ago is stale', runtime.press({ button: 'door', at: clock - 5 * 60 * 1000 }) === 'stale');
  ok('a held button has already counted', runtime.press({ button: 'door', kind: 'long' }) === 'held');
  ok('and none of that moved anything', runtime.step === 'treat');

  const off = setup({ enabled: false });
  off.runtime.reset();
  advance(1);
  ok('switched off, every press is dropped', off.runtime.press({ button: 'yes' }) === 'off' && off.runtime.step === 'ask');
}

console.log('— edited while it runs —');
{
  const { game, runtime } = setup();
  runtime.reset();
  answer(runtime, 'yes');
  game.steps = game.steps.filter((s) => s.id !== 'scare');
  ok('a step deleted while the show is on it falls back to the start', runtime.step === 'ask');
  stepById(game, 'ask').on.yes = 'treat';
  ok('and a link changed takes effect at once', answer(runtime, 'yes') === '→ Come and get your treat');

  const empty = createGameRuntime({ getGame: () => createGame({ enabled: true }), io: {}, now });
  empty.reset();
  ok('with no steps at all, nothing breaks', empty.step === null && empty.press({ button: 'yes' }) === 'not now');
}

/* ------------------------------------------------------------------ *
 * Saved shows
 * ------------------------------------------------------------------ */

console.log('— the automation in a saved show —');
{
  const project = createProject('t');
  ok('a new show has an automation, switched off and empty', project.game.enabled === false && project.game.steps.length === 0);

  project.game = makeGame({ buttons: { left: 'yes' } });
  const back = migrateProject(JSON.parse(JSON.stringify(project))).game;
  ok('steps survive a save', back.steps.length === 5 && back.start === 'ask' && back.enabled === true);
  ok('with where every button leads', stepById(back, 'more').on.no === 'scare' && stepById(back, 'more').after.seconds === 120);

  const old = JSON.parse(JSON.stringify(createProject('old')));
  old.game = {
    enabled: true,
    rungs: ['t1'],
    scenes: { attract: 's', ask: ['a'] },
    buttons: { left: 'yes', pocket: 'treat' },
    timing: { askTimeout: 9, armMs: 250 },
  };
  old.triggers = [{ id: 't1', name: 'Scare' }];
  const migrated = migrateProject(old);
  ok('the old ladder game arrives as an empty automation, switched off', migrated.game.steps.length === 0 && migrated.game.enabled === false);
  ok('keeping which button is which', migrated.game.buttons.left === 'yes');
  ok('but not a button mapped to TREAT', !('pocket' in migrated.game.buttons));
  ok('and the press handling it had', migrated.game.timing.armMs === 250 && !('askTimeout' in migrated.game.timing));
  ok('and triggers are gone', !('triggers' in migrated));
}

/* ------------------------------------------------------------------ *
 * The picture
 * ------------------------------------------------------------------ */

console.log('— the diagram draws the steps, and lights up the show —');
{
  const game = makeGame();
  const cells = layoutSteps(game);
  ok('the start is on the left', cells.ask[0] === 0);
  ok('each column is one move further along', cells.scare[0] === 1 && cells.treat[0] === 1 && cells.more[0] === 2 && cells.door[0] === 2);
  game.steps.push(createStep({ id: 'lost', name: 'Lost' }));
  ok('a step nothing reaches is put at the end', layoutSteps(game).lost[0] === 3);

  const svg = renderGameGraph({ game, names: { scare: 'A <scary> scene' } });
  ok('it is an svg', svg.startsWith('<svg') && svg.endsWith('</svg>'));
  ok('with a box for every step', game.steps.every((s) => svg.includes(`data-step="${s.id}"`)));
  const edges = graphEdges(game);
  ok('and an arrow for every way out except back to the start', edges.length === (svg.match(/class="gg-edge[ "]/g) || []).length
    && !edges.some((e) => e.to === 'ask'));
  ok('YES and NO to the same place are one arrow', edges.filter((e) => e.from === 'more' && e.to === 'scare').length === 1);
  ok('going back to the start is a note on the box instead', svg.includes('to the start after 2 min'));
  ok('a timer’s arrow says how long', svg.includes('>5 s<'));
  ok('words are shown in quotes', svg.includes('“MORE?”'));
  ok('names are escaped', svg.includes('A &lt;scary&gt; scene') && !svg.includes('<scary>'));
  ok('no NaN anywhere in the geometry', !/NaN|undefined|Infinity/.test(svg));
  ok('seconds read as people say them', formatSeconds(120) === '2 min' && formatSeconds(6) === '6 s' && formatSeconds(2.5) === '2.5 s');

  const { runtime } = setup();
  runtime.reset();
  answer(runtime, 'yes');
  const lit = renderGameGraph({ game, snapshot: runtime.snapshot() });
  ok('the current step is lit', /class="gg-node[^"]*gg-current[^"]*" data-step="scare"/.test(lit));
  ok('its way out is live', /class="gg-edge[^"]*gg-live[^"]*" data-from="scare"/.test(lit));
  ok('and the move that got there is marked', /class="gg-edge[^"]*gg-last[^"]*" data-from="ask" data-to="scare"/.test(lit));
  ok('an empty automation draws without failing', renderGameGraph({ game: createGame() }).includes('No steps yet'));
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
