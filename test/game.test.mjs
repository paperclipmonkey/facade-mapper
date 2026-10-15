/**
 * The dare game: the table, the runtime that walks it, and the picture of it.
 *
 * Everything the game does happens in front of children, in the dark, from a
 * button nobody indoors can see being pressed. A question that never times out
 * strands the house mid-game for the rest of the evening; a press that queues
 * skips a group past the tricks they were promised; a rung whose `after` hook
 * never fires leaves the fog machine running. None of it is visible from the
 * laptop, so all of it is here.
 *
 * The clock is one this file moves by hand. Nothing sleeps.
 *
 *   node test/game.test.mjs
 */

import { STATES, TRANSITIONS, TREATABLE, EVENT_LABELS, ROLES, transitionFor, eventsFrom, sceneSlot, roleOf, gameProblems } from '../js/core/game.js';
import { renderGameGraph, graphEdges, LAYOUT } from '../js/core/gameGraph.js';
import { createGameRuntime } from '../js/control/game.js';
import { createGame, createProject, createScene, createTrigger, migrateProject } from '../js/core/state.js';

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
 * A game with a three-rung ladder and every scene slot filled, and a runtime
 * whose `io` writes down what it was asked to do.
 */
function setup(overrides = {}, { holds = { r1: 4, r2: 5, r3: 6, fin: 8 } } = {}) {
  const game = createGame({
    enabled: true,
    rungs: ['r1', 'r2', 'r3'],
    finale: 'fin',
    scenes: {
      attract: 'sAttract',
      ask: ['sAsk1', 'sAsk2'],
      persuade: [],
      approach: ['sTreat1', null, 'sTreat3', 'sOut'],
      waiting: 'sWaiting',
      reward: 'sBye',
    },
    ...overrides,
  });
  const calls = [];
  const io = {
    scene: (id, ctx) => calls.push(['scene', id, ctx.level]),
    cue: (id, ctx) => {
      calls.push(['cue', id, ctx.level]);
      return holds[id] ?? null;
    },
    cueEnd: (id) => calls.push(['cueEnd', id]),
    release: () => calls.push(['release']),
    changed: () => calls.push(['changed']),
  };
  const runtime = createGameRuntime({ getGame: () => game, io, now });
  const did = (kind) => calls.filter((c) => c[0] === kind);
  const lastOf = (kind) => did(kind).at(-1);
  return { game, runtime, calls, did, lastOf };
}

/** Wait out the arming delay of a fresh question, then answer it. */
function answer(runtime, button) {
  advance(0.5);
  return runtime.press({ button });
}

/** Let a trick, or a wait, run out. */
const through = (runtime, seconds = 10) => {
  advance(seconds);
  runtime.tick();
};

/* ------------------------------------------------------------------ *
 * The table
 * ------------------------------------------------------------------ */

console.log('— the table is a machine you cannot get stuck in —');
{
  const states = Object.keys(STATES);
  ok('every transition starts and ends at a state that exists',
    TRANSITIONS.every((t) => STATES[t.from] && STATES[t.to]));
  ok('every event has a label for the diagram', TRANSITIONS.every((t) => EVENT_LABELS[t.on]));
  ok('every state is placed on the diagram', states.every((s) => LAYOUT[s]));
  ok('and nothing is placed that is not a state', Object.keys(LAYOUT).every((s) => STATES[s]));
  ok('nine moments, no more', states.length === 9, states.join(','));

  const reach = (start, edges) => {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const s = queue.shift();
      for (const t of edges) {
        if (t.from === s && !seen.has(t.to)) {
          seen.add(t.to);
          queue.push(t.to);
        }
      }
    }
    return seen;
  };
  const fromAttract = reach('attract', TRANSITIONS);
  ok('every state can be reached from the waiting screen', states.every((s) => fromAttract.has(s)),
    states.filter((s) => !fromAttract.has(s)).join(','));

  // Without any presses at all — nobody comes back, nobody presses TREAT — the
  // house must still find its way home from every state.
  const timeouts = TRANSITIONS.filter((t) => t.on === 'timeout');
  const stuck = states.filter((s) => s !== 'attract' && !reach(s, timeouts).has('attract'));
  ok('every state gets back to the start on time alone', !stuck.length, stuck.join(','));

  ok('TREAT works everywhere a group is playing',
    TREATABLE.every((s) => TRANSITIONS.some((t) => t.from === s && t.on === 'treat' && t.to === 'reward')));
  ok('and not on the waiting screen, where nobody is', !transitionFor('attract', 'treat', createGame(), 0));

  const game = createGame({ rungs: ['a', 'b'] });
  ok('the ladder climbs while there are tricks left', transitionFor('scare', 'timeout', game, 1)?.to === 'ask');
  ok('and at the top, sends them for their treat', transitionFor('scare', 'timeout', game, 2)?.to === 'approach');
  ok('an empty ladder is one rung, not none', transitionFor('scare', 'timeout', createGame(), 1)?.to === 'approach');

  ok('DOOR does nothing until they are invited up',
    ['attract', 'ask', 'persuade', 'scare', 'waiting'].every((s) => !transitionFor(s, 'door', { ...game, door: true }, 1)));
  ok('and then it is them coming forward', transitionFor('approach', 'door', { ...game, door: true }, 1)?.to === 'finale');
  ok('without a DOOR button, it does nothing even then', !transitionFor('approach', 'door', { ...game, door: false }, 1));

  const fromAsk = eventsFrom('ask', game, 1);
  ok('a question listens to YES, NO, TREAT and time — nothing else',
    [...fromAsk.keys()].sort().join(',') === 'no,timeout,treat,yes', [...fromAsk.keys()].join(','));
  ok('and an unanswered one starts the house again', transitionFor('ask', 'timeout', game, 1)?.to === 'attract');
  ok('after two minutes, by default', createGame().timing.askTimeout === 120);
}

console.log('— scenes by level, and buttons by role —');
{
  const game = createGame({ scenes: { ...createGame().scenes, ask: ['a1', null, 'a3'], reward: 'r' } });
  ok('level 1 asks the first question', sceneSlot(game, 'ask', 1) === 'a1');
  ok('a gap in the list repeats the one before it', sceneSlot(game, 'ask', 2) === 'a1');
  ok('level 3 asks the third', sceneSlot(game, 'ask', 3) === 'a3');
  ok('and beyond the list, the last one again', sceneSlot(game, 'ask', 7) === 'a3');
  ok('single slots are just themselves', sceneSlot(game, 'reward', 4) === 'r');
  ok('an empty list is nothing, not undefined', sceneSlot(createGame(), 'ask', 1) === null);

  const mapped = createGame({ buttons: { 'event.path_left': 'yes', 'event.front': 'door', 'event.odd': 'banana' } });
  ok('a mapped button has its role', roleOf(mapped, 'event.path_left') === 'yes');
  ok('a role name is its own role, so the remote needs no mapping', roleOf(mapped, 'no') === 'no');
  ok('an unknown button has none', roleOf(mapped, 'event.unknown') === null);
  ok('a mapping to something that is not a role is ignored', roleOf(mapped, 'event.odd') === null);
  ok('the prototype is not a button', roleOf(mapped, 'constructor') === null && roleOf(mapped, '__proto__') === null);
  ok('there are exactly four roles', ROLES.join() === 'yes,no,door,treat');
}

/* ------------------------------------------------------------------ *
 * A group that goes all the way
 * ------------------------------------------------------------------ */

console.log('— all the way up the ladder, to the door, and home —');
{
  const { runtime, did, lastOf } = setup();

  ok('it starts on the waiting screen', runtime.state === 'attract' && !runtime.active);
  ok('YES starts the game', runtime.press({ button: 'yes' }) === '→ ask');
  ok('at level 1, with the first question', runtime.level === 1 && lastOf('scene')?.[1] === 'sAsk1');
  ok('and is now playing', runtime.active);

  ok('YES plays the first trick at once', answer(runtime, 'yes') === '→ scare' && lastOf('cue')?.[1] === 'r1');
  advance(3.9);
  runtime.tick();
  ok('the trick holds for its own hold', runtime.state === 'scare');
  advance(0.2);
  runtime.tick();
  ok('and then asks again, one level up', runtime.state === 'ask' && runtime.level === 2);
  ok("with the trick's after hook sent", lastOf('cueEnd')?.[1] === 'r1');
  ok('and the second question', lastOf('scene')?.[1] === 'sAsk2');

  answer(runtime, 'yes');
  through(runtime, 5.1);
  ok('level 3 asks the last question written again', runtime.level === 3 && lastOf('scene')?.[1] === 'sAsk2');
  answer(runtime, 'yes');
  ok('the third trick', lastOf('cue')?.[1] === 'r3');
  through(runtime, 6.1);
  ok('out of tricks, they are sent for their treat', runtime.state === 'approach' && lastOf('scene')?.[1] === 'sOut');

  ok('YES now does nothing — they have been asked to walk', runtime.press({ button: 'yes' }) === 'not now');
  ok('DOOR is them coming forward', runtime.press({ button: 'door' }) === '→ finale' && lastOf('cue')?.[1] === 'fin');
  through(runtime, 8.1);
  ok('the door moment ends in waiting for a treat', runtime.state === 'waiting');
  ok('with its after hook sent', lastOf('cueEnd')?.[1] === 'fin');

  ok('TREAT says goodbye', runtime.press({ button: 'treat' }) === '→ reward' && lastOf('scene')?.[1] === 'sBye');
  ok('nothing handed back yet', did('release').length === 0);
  through(runtime, 8.1);
  ok('the goodbye ends in cooldown', runtime.state === 'cooldown');
  ok('which hands the stage back', did('release').length === 1);
  through(runtime, 6.1);
  ok('and then the waiting screen again', runtime.state === 'attract' && runtime.level === 0);
  ok('showing the question again', lastOf('scene')?.[1] === 'sAttract');
  ok('without handing back twice', did('release').length === 1);
  ok('every cue was ended exactly once', did('cue').length === did('cueEnd').length);
}

{
  const { runtime, lastOf } = setup({ door: false });
  runtime.press({ button: 'yes' });
  for (let rung = 1; rung <= 3; rung++) {
    answer(runtime, 'yes');
    through(runtime, 7);
  }
  ok('without a DOOR button the house still sends them for their treat', runtime.state === 'approach');
  ok('DOOR does nothing', runtime.press({ button: 'door' }) === 'not now');
  ok('and TREAT from indoors says goodbye', runtime.press({ button: 'treat' }) === '→ reward' && lastOf('scene')?.[1] === 'sBye');
}

{
  const { runtime } = setup();
  runtime.press({ button: 'yes' });
  for (let rung = 1; rung <= 3; rung++) {
    answer(runtime, 'yes');
    through(runtime, 7);
  }
  through(runtime, 120.1);
  ok('nobody coming for the treat starts the house again, after two minutes', runtime.state === 'attract');
}

{
  const { runtime, lastOf } = setup();
  runtime.press({ button: 'yes' });
  for (let rung = 1; rung <= 3; rung++) {
    answer(runtime, 'yes');
    through(runtime, 7);
  }
  runtime.press({ button: 'door' });
  through(runtime, 8.1);
  through(runtime, 30.1);
  ok('a forgotten TREAT still gets them the goodbye on the way back', runtime.state === 'reward' && lastOf('scene')?.[1] === 'sBye');
}

/* ------------------------------------------------------------------ *
 * Saying no
 * ------------------------------------------------------------------ */

console.log('— NO, and being frightened —');
{
  const { runtime, lastOf } = setup();
  runtime.press({ button: 'no' });
  ok('NO on the waiting screen starts the game too', runtime.state === 'ask');
  answer(runtime, 'no');
  ok('NO to the first question sends them for their treat', runtime.state === 'approach' && runtime.level === 1);
  ok('with the words for having seen nothing', lastOf('scene')?.[1] === 'sTreat1');
}

{
  const { runtime, lastOf } = setup();
  runtime.press({ button: 'yes' });
  answer(runtime, 'yes');
  through(runtime, 4.1);
  answer(runtime, 'no');
  ok('NO after a trick is a treat too', runtime.state === 'approach' && runtime.level === 2);
  ok('repeating the words before it where this level has none', lastOf('scene')?.[1] === 'sTreat1');
}

{
  const { runtime, lastOf } = setup();
  runtime.press({ button: 'yes' });
  answer(runtime, 'yes');
  ok('NO pressed during a trick is dropped', runtime.press({ button: 'no' }) === 'not now');
  ok('YES too — nothing queues', runtime.press({ button: 'yes' }) === 'not now');
  ok('the trick carries on', runtime.state === 'scare');
  ok('NO held down stops it, and sends them for their treat', runtime.press({ button: 'no', kind: 'long' }) === '→ approach');
  ok('ending the trick straight away', lastOf('cueEnd')?.[1] === 'r1');
  through(runtime, 4.1);
  ok('its hold running out later changes nothing', runtime.state === 'approach');
}

{
  const { runtime } = setup();
  runtime.press({ button: 'yes' });
  advance(0.5);
  ok('a held YES means nothing more than the YES itself', runtime.press({ button: 'yes', kind: 'long' }) === 'held');
  ok('a held NO outside a trick is nothing', runtime.press({ button: 'no', kind: 'long' }) === 'not now');
}

console.log('— the waiting screen asks, and NO is not the end of it —');
{
  const { runtime, lastOf } = setup({
    openingQuestion: true,
    persuade: 2,
    scenes: { ...createGame().scenes, attract: 'sAttract', ask: ['sAsk1', 'sAsk2'], persuade: ['sTrick', 'sLove'], approach: ['sTreat'] },
  });
  ok('with the waiting screen as the question, YES is the first trick', runtime.press({ button: 'yes' }) === '→ scare' && runtime.level === 1 && lastOf('cue')?.[1] === 'r1');
  through(runtime, 4.1);
  ok('and the next question is question 2', runtime.state === 'ask' && runtime.level === 2 && lastOf('scene')?.[1] === 'sAsk2');
  runtime.reset();

  ok('NO to it asks again', runtime.press({ button: 'no' }) === '→ persuade' && runtime.attempt === 1);
  ok('"did you say trick?"', lastOf('scene')?.[1] === 'sTrick');
  answer(runtime, 'no');
  ok('NO again asks once more', runtime.state === 'persuade' && runtime.attempt === 2 && lastOf('scene')?.[1] === 'sLove');
  answer(runtime, 'no');
  ok('and a third NO sends them for their treat', runtime.state === 'approach' && lastOf('scene')?.[1] === 'sTreat');
  runtime.reset();

  runtime.press({ button: 'no' });
  answer(runtime, 'yes');
  ok('talked round, YES is the first trick', runtime.state === 'scare' && runtime.level === 1 && lastOf('cue')?.[1] === 'r1');
  through(runtime, 4.1);
  answer(runtime, 'no');
  ok('a NO later on is not argued with', runtime.state === 'approach');
  ok('reset clears the tries', (runtime.reset(), runtime.attempt === 0));

  runtime.press({ button: 'no' });
  through(runtime, 120.1);
  ok('an unanswered "did you say trick?" starts the house again', runtime.state === 'attract');
}

{
  const { runtime } = setup({ openingQuestion: true });
  ok('with nobody to talk them round, NO to the opening question is a treat', runtime.press({ button: 'no' }) === '→ approach');
}

{
  const { runtime } = setup({ persuade: 1 });
  runtime.press({ button: 'yes' });
  answer(runtime, 'no');
  ok('without an opening question, NO at question 1 can be argued with too', runtime.state === 'persuade');
  answer(runtime, 'yes');
  ok('and YES from there is trick 1', runtime.state === 'scare' && runtime.level === 1);
}

/* ------------------------------------------------------------------ *
 * The presses a path actually gets
 * ------------------------------------------------------------------ */

console.log('— mashing, and thumbs left on buttons —');
{
  const { runtime } = setup();
  runtime.press({ button: 'yes' });
  ok('a press the instant a question appears is ignored', runtime.press({ button: 'yes' }) === 'not armed');
  advance(0.3);
  ok('and still, just before it arms', runtime.press({ button: 'yes' }) === 'not armed');
  advance(0.15);
  ok('once armed the first answer wins, at once', runtime.press({ button: 'no' }) === '→ approach');
  ok('and the other one, a moment later, is too late', runtime.press({ button: 'yes' }) === 'not now');
}

{
  const { runtime } = setup();
  ok('a press with an id counts once', runtime.press({ button: 'yes', id: 'ctx-1' }) === '→ ask');
  advance(0.5);
  ok('the same id again is a redelivery', runtime.press({ button: 'yes', id: 'ctx-1' }) === 'duplicate');
  ok('and does not answer the question', runtime.state === 'ask');
  ok('stamped two and a half seconds ago, it is stale', runtime.press({ button: 'yes', at: clock - 2500 }) === 'stale');
  ok('stamped just now, it is fine', runtime.press({ button: 'yes', at: clock - 300 }) === '→ scare');
}

{
  const { runtime } = setup({ buttons: { 'event.path_left': 'yes', 'event.front': 'door' } });
  ok('a mapped button plays its role', runtime.press({ button: 'event.path_left' }) === '→ ask');
  ok('an unmapped button is logged and dropped', runtime.press({ button: 'event.shed' }) === 'unmapped');
  const log = runtime.snapshot().log;
  ok('the log keeps it, newest first, for learning which button is which',
    log[0].button === 'event.shed' && log[0].result === 'unmapped' && log[1].role === 'yes');
}

{
  const { runtime } = setup({ enabled: false });
  ok('a switched-off game ignores everything', runtime.press({ button: 'yes' }) === 'game off' && runtime.state === 'attract');
}

{
  const { runtime } = setup();
  ok('DOOR on the waiting screen does nothing at all', runtime.press({ button: 'door' }) === 'not now' && runtime.state === 'attract');
  runtime.press({ button: 'yes' });
  ok('TREAT skips the arming delay — an adult means it', runtime.press({ button: 'treat' }) === '→ reward');
  ok('TREAT on the waiting screen has nobody to say goodbye to', setup().runtime.press({ button: 'treat' }) === 'not now');
}

/* ------------------------------------------------------------------ *
 * Time, and the group that walked off
 * ------------------------------------------------------------------ */

console.log('— nobody answering, and resetting —');
{
  const { runtime, did } = setup();
  runtime.press({ button: 'yes' });
  through(runtime, 119);
  ok('a question waits a good while', runtime.state === 'ask');
  through(runtime, 1.1);
  ok('then starts the house again', runtime.state === 'attract');
  ok('handing the stage back', did('release').length === 1);
}

{
  const { runtime, lastOf, did } = setup();
  runtime.press({ button: 'yes' });
  answer(runtime, 'yes');
  runtime.reset();
  ok('reset mid-trick goes straight to the start', runtime.state === 'attract');
  ok('ending the trick', lastOf('cueEnd')?.[1] === 'r1');
  ok('and handing the stage back', did('release').length === 1);
  ok('and the diagram is told why', runtime.snapshot().last.on === 'reset');
}

{
  // A hidden tab is ticked late, not on time. One late tick must make one move,
  // not replay the whole evening at once.
  const { runtime } = setup();
  runtime.press({ button: 'yes' });
  answer(runtime, 'yes');
  through(runtime, 100);
  ok('a very late tick moves one step', runtime.state === 'ask' && runtime.level === 2);
}

{
  const { runtime } = setup({}, { holds: {} });
  runtime.press({ button: 'yes' });
  answer(runtime, 'yes');
  ok('a trick whose trigger cannot play still takes time', runtime.state === 'scare');
  through(runtime, 4.9);
  ok('the fallback hold, five seconds', runtime.state === 'scare');
  through(runtime, 0.2);
  ok('and then the next question', runtime.state === 'ask');
}

{
  const { runtime, game } = setup();
  runtime.press({ button: 'yes' });
  game.rungs = ['r1'];
  answer(runtime, 'yes');
  through(runtime, 4.1);
  ok('editing the ladder mid-game applies to the group already playing', runtime.state === 'approach');
}

{
  const { runtime } = setup();
  ok('nothing is due on the waiting screen', runtime.nextDeadline() === null);
  runtime.press({ button: 'yes' });
  ok('a question is due when it times out', runtime.nextDeadline() === clock + 120000);
  advance(0.5);
  const snap = runtime.snapshot();
  ok('the snapshot says where it is', snap.state === 'ask' && snap.of === 3 && snap.level === 1);
  ok('and how long is left on the question', Math.abs(snap.remaining - 119.5) < 1e-9);
}

console.log('— words first, like a dare —');
{
  const beats = { ask: [[{ text: 'SO…', seconds: 1 }, { text: 'YOU DARE.', seconds: 2 }]], scare: [[], [{ text: 'TOO LATE', seconds: 1.5 }]] };
  const { runtime, lastOf } = setup({ beats });
  runtime.press({ button: 'yes' });
  ok('a question with words first says them before it asks', runtime.snapshot().saying?.text === 'SO…');
  ok('over whatever was up, without changing the scene yet', lastOf('scene')?.[1] !== 'sAsk1');
  ok('presses are dropped while it speaks', runtime.press({ button: 'yes' }) === 'wait for the words');
  through(runtime, 1.05);
  ok('then the next line, by itself', runtime.snapshot().saying?.text === 'YOU DARE.');
  through(runtime, 2.05);
  ok('then the question itself', runtime.snapshot().saying === null && lastOf('scene')?.[1] === 'sAsk1');
  ok('armed from when it appeared, not from when the words began', runtime.press({ button: 'yes' }) === 'not armed');
  ok('and its own clock started then too', Math.abs(runtime.snapshot().remaining - 120) < 1e-9);
  answer(runtime, 'yes');
  ok('a level with no words goes straight to its trick', runtime.state === 'scare' && runtime.snapshot().saying === null && lastOf('cue')?.[1] === 'r1');
  through(runtime, 4.1);
  answer(runtime, 'yes');
  ok('the next level has its own words', runtime.snapshot().saying?.text === 'TOO LATE');
  ok('and TREAT does not wait for them', runtime.press({ button: 'treat' }) === '→ reward' && runtime.snapshot().saying === null);
}

{
  const said = [];
  const game = createGame({ enabled: true, rungs: ['r1'], beats: { ask: [[{ text: 'HELLO', seconds: 1 }]] } });
  const runtime = createGameRuntime({
    getGame: () => game,
    now,
    io: { caption: (text) => said.push(text), cue: () => 3, scene: () => {}, release: () => {} },
  });
  runtime.press({ button: 'yes' });
  runtime.reset();
  ok('the line is put up as a caption', said[0] === 'HELLO');
  ok('and taken down when the game moves on, even by a reset', said.at(-1) === null);
}

/* ------------------------------------------------------------------ *
 * Saved shows
 * ------------------------------------------------------------------ */

console.log('— the game in a saved show —');
{
  const project = createProject('t');
  ok('a new show has a game, switched off', project.game && project.game.enabled === false);
  const old = JSON.parse(JSON.stringify(project));
  delete old.game;
  ok('a show from before the game gets one', migrateProject(old).game?.timing?.askTimeout === 120);
  const partial = JSON.parse(JSON.stringify(project));
  partial.game = {
    enabled: true,
    timing: { askTimeout: 9, nudgeTimeout: 10, windowMs: 150 },
    scenes: { ask: 'single', chicken: ['x'], nudge: 'y', approach: 'z' },
    rungs: ['a', null, 'b'],
  };
  const migrated = migrateProject(partial).game;
  ok('a saved timing is kept and the missing ones filled in', migrated.timing.askTimeout === 9 && migrated.timing.armMs === 400);
  ok('timings for moments that are gone are dropped', !('nudgeTimeout' in migrated.timing) && !('windowMs' in migrated.timing));
  ok('and so are the moments themselves', !('chicken' in migrated.scenes) && !('nudge' in migrated.scenes));
  ok('a single question becomes a list of one', Array.isArray(migrated.scenes.ask) && migrated.scenes.ask[0] === 'single');
  ok('and a single treat invitation too', Array.isArray(migrated.scenes.approach) && migrated.scenes.approach[0] === 'z');
  ok('gaps in the ladder close up', migrated.rungs.join() === 'a,b');
  ok('scene slots that were never saved are there', migrated.scenes.reward === null && Array.isArray(migrated.scenes.persuade));
}

{
  const project = createProject('t');
  project.scenes = [createScene({ id: 'q' })];
  project.triggers = [createTrigger({ id: 'T1' })];
  const game = createGame({ door: true, rungs: ['T1', 'gone'], scenes: { ...createGame().scenes, ask: ['q'] }, buttons: { b: 'no' } });
  const problems = gameProblems(game, project);
  ok('a rung pointing at a deleted trigger is reported', problems.some((p) => p.includes('Rung 2')));
  ok('so is nothing to happen at the door', problems.some((p) => p.includes('Nothing happens at the door')));
  ok('and nothing on the waiting screen', problems.some((p) => p.includes('waits')));
  ok('and buttons with no YES among them', problems.some((p) => p.includes('YES')));
  ok('and a DOOR button that is on but not mapped', problems.some((p) => p.includes('mapped to DOOR')));
}

/* ------------------------------------------------------------------ *
 * The picture
 * ------------------------------------------------------------------ */

console.log('— the diagram draws the table, and lights up the game —');
{
  const game = createGame({ rungs: ['a', 'b', 'c'] });
  const svg = renderGameGraph({ game, names: { ask: 'Do you <dare>?' } });
  ok('it is an svg', svg.startsWith('<svg') && svg.endsWith('</svg>'));
  ok('with a box for every state', Object.keys(STATES).every((s) => svg.includes(`data-state="${s}"`)));
  const edges = graphEdges();
  ok('and an arrow for every transition it does not summarise',
    edges.length === (svg.match(/class="gg-edge[ "]/g) || []).length);
  ok('every drawn transition is in one of them',
    TRANSITIONS.filter((t) => !t.quiet).every((t) => edges.some((e) => e.from === t.from && e.to === t.to && e.rows.includes(t))));
  ok('no NaN anywhere in the geometry', !/NaN|undefined|Infinity/.test(svg));
  ok('scene names are escaped', svg.includes('Do you &lt;dare&gt;?') && !svg.includes('<dare>'));
  ok('levelled states show the ladder height', svg.includes('More? ×3'));
  ok('nothing is lit without a game running', !svg.includes('gg-current'));

  const { runtime } = setup();
  runtime.press({ button: 'yes' });
  answer(runtime, 'yes');
  const live = renderGameGraph({ game, snapshot: runtime.snapshot() });
  ok('live, the current state is lit', /class="gg-node[^"]*gg-current[^"]*" data-state="scare"/.test(live));
  ok('with its level', live.includes('Trick 1/3'));
  ok('the move just made is marked', /class="gg-edge[^"]*gg-last[^"]*" data-from="ask" data-to="scare"/.test(live));
  ok('and the ways out of here are bright', /class="gg-edge[^"]*gg-live[^"]*" data-from="scare" data-to="approach"/.test(live));

  const noDoor = renderGameGraph({ game: { ...game, door: false } });
  ok('with no DOOR button, its arrow is drawn as not applying',
    /class="gg-edge[^"]*gg-off[^"]*" data-from="approach" data-to="finale"/.test(noDoor));
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
