/**
 * The dare game: the table, the runtime that walks it, and the picture of it.
 *
 * Everything the game does happens in front of children, in the dark, from a
 * button nobody indoors can see being pressed. A question that never times out
 * strands the house mid-game for the rest of the evening; a press that queues
 * skips a group past the scares they were promised; a rung whose `after` hook
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
      early: 'sEarly',
      ask: ['sAsk1', 'sAsk2'],
      nudge: 'sNudge',
      decide: 'sDecide',
      approach: 'sApproach',
      chicken: ['sChicken1', null, 'sChicken3'],
      mercy: 'sMercy',
      waiting: 'sWaiting',
      reward: 'sReward',
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

/** Press, then let the decision window close — what a single child does. */
function answer(runtime, button) {
  const result = runtime.press({ button });
  advance(0.2);
  runtime.tick();
  return result;
}

/** Wait out the arming delay of a fresh question. */
const settle = () => advance(0.5);

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
  ok('every state can be reached from Attract', states.every((s) => fromAttract.has(s)),
    states.filter((s) => !fromAttract.has(s)).join(','));

  // Without any presses at all — nobody comes back, nobody presses TREAT — the
  // house must still find its way home from every state.
  const timeouts = TRANSITIONS.filter((t) => t.on === 'timeout');
  const stuck = states.filter((s) => s !== 'attract' && !reach(s, timeouts).has('attract'));
  ok('every state gets back to Attract on time alone', !stuck.length, stuck.join(','));

  const timed = states.filter((s) => s !== 'attract' && !STATES[s].timer && !STATES[s].cue);
  ok('every state but Attract has a timer or a cue to end it', !timed.length, timed.join(','));

  ok('TREAT works everywhere a group is playing',
    TREATABLE.every((s) => TRANSITIONS.some((t) => t.from === s && t.on === 'treat' && t.to === 'reward')));
  ok('and not in Attract, where nobody is', !transitionFor('attract', 'treat', createGame(), 0));

  const game = createGame({ rungs: ['a', 'b'] });
  ok('the ladder climbs while there are rungs left', transitionFor('scare', 'timeout', game, 1)?.to === 'ask');
  ok('and at the top, with the door on, invites them up the path',
    transitionFor('scare', 'timeout', { ...game, door: true }, 2)?.to === 'approach');
  ok('and with it off, plays the finale where they stand',
    transitionFor('scare', 'timeout', { ...game, door: false }, 2)?.to === 'finale');
  ok('an empty ladder is one rung, not none', transitionFor('scare', 'timeout', createGame({ door: false }), 1)?.to === 'finale');

  const fromAsk = eventsFrom('ask', game, 1);
  ok('the question listens to YES, NO, both, TREAT and time',
    ['yes', 'no', 'both', 'treat', 'timeout'].every((e) => fromAsk.has(e)) && !fromAsk.has('door'));
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

  ok('it starts in Attract', runtime.state === 'attract' && !runtime.active);
  ok('YES starts the game', runtime.press({ button: 'yes' }) === '→ ask');
  ok('at level 1, with the first question', runtime.level === 1 && lastOf('scene')?.[1] === 'sAsk1');
  ok('and is now playing', runtime.active);

  settle();
  ok('YES opens the decision window rather than acting', runtime.press({ button: 'yes' }) === 'deciding');
  ok('still asking while the window is open', runtime.state === 'ask');
  advance(0.2);
  runtime.tick();
  ok('the window closing plays the first rung', runtime.state === 'scare' && lastOf('cue')?.[1] === 'r1');

  advance(3.9);
  runtime.tick();
  ok('the rung holds for its own hold', runtime.state === 'scare');
  advance(0.2);
  runtime.tick();
  ok('and then asks again, one level up', runtime.state === 'ask' && runtime.level === 2);
  ok("with the rung's after hook sent", lastOf('cueEnd')?.[1] === 'r1');
  ok('and the second question', lastOf('scene')?.[1] === 'sAsk2');

  settle();
  answer(runtime, 'yes');
  advance(5.1);
  runtime.tick();
  ok('level 3 asks the last question written again', runtime.level === 3 && lastOf('scene')?.[1] === 'sAsk2');
  settle();
  answer(runtime, 'yes');
  ok('the third rung', lastOf('cue')?.[1] === 'r3');
  advance(6.1);
  runtime.tick();
  ok('the top of the ladder invites them to the door', runtime.state === 'approach' && lastOf('scene')?.[1] === 'sApproach');

  ok('YES at the approach does nothing — they have been asked to walk', runtime.press({ button: 'yes' }) === 'not now');
  ok('the door button plays the finale', runtime.press({ button: 'door' }) === '→ finale' && lastOf('cue')?.[1] === 'fin');
  advance(8.1);
  runtime.tick();
  ok('the finale ends in waiting for a treat', runtime.state === 'waiting');
  ok("with the finale's after hook sent", lastOf('cueEnd')?.[1] === 'fin');

  ok('TREAT plays the reward', runtime.press({ button: 'treat' }) === '→ reward' && lastOf('scene')?.[1] === 'sReward');
  ok('nothing handed back yet', did('release').length === 0);
  advance(8.1);
  runtime.tick();
  ok('the reward ends in cooldown', runtime.state === 'cooldown');
  ok('which hands the stage back', did('release').length === 1);
  advance(6.1);
  runtime.tick();
  ok('and cooldown ends in Attract', runtime.state === 'attract' && runtime.level === 0);
  ok('showing the prompt again', lastOf('scene')?.[1] === 'sAttract');
  ok('without handing back twice', did('release').length === 1);
  ok('every cue was ended exactly once', did('cue').length === did('cueEnd').length);
}

{
  const { runtime, lastOf } = setup({ door: false });
  runtime.press({ button: 'yes' });
  for (let rung = 1; rung <= 3; rung++) {
    settle();
    answer(runtime, 'yes');
    advance(7);
    runtime.tick();
  }
  ok('without the door stage the finale plays at the top of the ladder', lastOf('cue')?.[1] === 'fin');
  ok('and the approach never happens', runtime.state === 'finale');
}

{
  const { runtime } = setup();
  runtime.press({ button: 'yes' });
  settle();
  answer(runtime, 'yes');
  advance(4.1);
  runtime.tick();
  settle();
  answer(runtime, 'yes');
  advance(5.1);
  runtime.tick();
  settle();
  answer(runtime, 'yes');
  advance(6.1);
  runtime.tick();
  advance(25.1);
  runtime.tick();
  ok('nobody coming to the door is a NO', runtime.state === 'chicken');
}

{
  const { runtime, lastOf } = setup();
  runtime.press({ button: 'yes' });
  settle();
  answer(runtime, 'yes');
  advance(4.1);
  runtime.tick();
  settle();
  answer(runtime, 'yes');
  advance(5.1);
  runtime.tick();
  settle();
  answer(runtime, 'yes');
  advance(6.1);
  runtime.tick();
  runtime.press({ button: 'door' });
  advance(8.1);
  runtime.tick();
  advance(30.1);
  runtime.tick();
  ok('a forgotten TREAT still gets them the reward on the way back', runtime.state === 'reward' && lastOf('scene')?.[1] === 'sReward');
}

/* ------------------------------------------------------------------ *
 * Saying no
 * ------------------------------------------------------------------ */

console.log('— NO, at every level, and for being scared —');
{
  const { runtime, lastOf, did } = setup();
  runtime.press({ button: 'no' });
  ok('NO in Attract starts the game too', runtime.state === 'ask');
  settle();
  answer(runtime, 'no');
  ok('NO at the first question is Chicken', runtime.state === 'chicken');
  ok('with the level-1 send-off', lastOf('scene')?.[1] === 'sChicken1');
  ok('TREAT plays the reward from there', runtime.press({ button: 'treat' }) === '→ reward');
  advance(8.1);
  runtime.tick();
  ok('and hands the stage back afterwards', did('release').length === 1);
}

{
  const { runtime, lastOf } = setup();
  runtime.press({ button: 'yes' });
  settle();
  answer(runtime, 'yes');
  advance(4.1);
  runtime.tick();
  settle();
  answer(runtime, 'no');
  ok('NO at level 2 repeats the first send-off where the second is blank', lastOf('scene')?.[1] === 'sChicken1');
  advance(30.1);
  runtime.tick();
  ok('nobody pressing TREAT ends in cooldown, not the reward', runtime.state === 'cooldown');
}

{
  const { runtime, lastOf } = setup();
  runtime.press({ button: 'yes' });
  settle();
  answer(runtime, 'yes');
  ok('NO pressed during a scare is dropped', runtime.press({ button: 'no' }) === 'not now');
  ok('YES too — nothing queues', runtime.press({ button: 'yes' }) === 'not now');
  ok('the scare carries on', runtime.state === 'scare');
  ok('NO held down during a scare is mercy', runtime.press({ button: 'no', kind: 'long' }) === '→ mercy');
  ok('which ends the rung straight away', lastOf('cueEnd')?.[1] === 'r1');
  ok('and goes somewhere calm', lastOf('scene')?.[1] === 'sMercy');
  advance(4.1);
  runtime.tick();
  ok("the rung's hold running out later changes nothing", runtime.state === 'mercy');
}

{
  const { runtime } = setup();
  runtime.press({ button: 'yes' });
  settle();
  ok('a held YES means nothing more than the YES itself', runtime.press({ button: 'yes', kind: 'long' }) === 'held');
  ok('a held NO outside a scare is not mercy', runtime.press({ button: 'no', kind: 'long' }) === 'not now');
}

/* ------------------------------------------------------------------ *
 * The presses a path actually gets
 * ------------------------------------------------------------------ */

console.log('— mashing, disagreeing, and thumbs left on buttons —');
{
  const { runtime } = setup();
  runtime.press({ button: 'yes' });
  ok('a press the instant a question appears is ignored', runtime.press({ button: 'yes' }) === 'not armed');
  advance(0.3);
  ok('and still, just before it arms', runtime.press({ button: 'yes' }) === 'not armed');
  advance(0.15);
  ok('once armed it counts', runtime.press({ button: 'yes' }) === 'deciding');
  ok('the same answer again adds nothing', runtime.press({ button: 'yes' }) === 'same answer');
  advance(0.2);
  runtime.tick();
  ok('and one rung plays, not two', runtime.state === 'scare' && runtime.level === 1);
}

{
  const { runtime, lastOf } = setup();
  runtime.press({ button: 'yes' });
  settle();
  runtime.press({ button: 'no' });
  advance(0.05);
  ok('YES arriving inside the window after NO is both', runtime.press({ button: 'yes' }) === 'both → decide');
  ok('the house says it cannot decide', lastOf('scene')?.[1] === 'sDecide');
  advance(2.6);
  runtime.tick();
  ok('and decides YES', runtime.state === 'scare');
}

{
  const { runtime } = setup({ timing: { ...createGame().timing, windowMs: 0 } });
  runtime.press({ button: 'yes' });
  settle();
  ok('with the window set to nothing the first answer acts at once', runtime.press({ button: 'no' }) === '→ chicken');
}

{
  const { runtime } = setup();
  ok('a press with an id counts once', runtime.press({ button: 'yes', id: 'ctx-1' }) === '→ ask');
  settle();
  ok('the same id again is a redelivery', runtime.press({ button: 'yes', id: 'ctx-1' }) === 'duplicate');
  ok('and does not answer the question', runtime.state === 'ask');
  ok('stamped two and a half seconds ago, it is stale', runtime.press({ button: 'yes', at: clock - 2500 }) === 'stale');
  ok('stamped just now, it is fine', runtime.press({ button: 'yes', at: clock - 300 }) === 'deciding');
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
  const { runtime, lastOf } = setup();
  ok('the door button before anyone has played is too soon', runtime.press({ button: 'door' }) === '→ early');
  ok('with its own scene', lastOf('scene')?.[1] === 'sEarly');
  advance(5.1);
  runtime.tick();
  ok('and then back to Attract', runtime.state === 'attract');
}

{
  const { runtime } = setup();
  runtime.press({ button: 'yes' });
  ok('TREAT skips the arming delay — an adult means it', runtime.press({ button: 'treat' }) === '→ reward');
  ok('TREAT in Attract has nobody to reward', setup().runtime.press({ button: 'treat' }) === 'not now');
}

/* ------------------------------------------------------------------ *
 * Time, and the group that walked off
 * ------------------------------------------------------------------ */

console.log('— nobody answering, and resetting —');
{
  const { runtime, lastOf, did } = setup();
  runtime.press({ button: 'yes' });
  advance(15.1);
  runtime.tick();
  ok('an unanswered question nudges', runtime.state === 'nudge' && lastOf('scene')?.[1] === 'sNudge');
  settle();
  ok('the nudge has no decision window', runtime.press({ button: 'yes' }) === '→ scare');
  const second = setup();
  second.runtime.press({ button: 'yes' });
  advance(15.1);
  second.runtime.tick();
  advance(10.1);
  second.runtime.tick();
  ok('an unanswered nudge gives up', second.runtime.state === 'cooldown');
  ok('and hands the stage back', second.did('release').length === 1);
  ok('(the first group is still playing)', runtime.state === 'scare' && !did('release').length);
}

{
  const { runtime, lastOf, did } = setup();
  runtime.press({ button: 'yes' });
  settle();
  answer(runtime, 'yes');
  runtime.reset();
  ok('reset mid-scare goes straight to Attract', runtime.state === 'attract');
  ok('ending the rung', lastOf('cueEnd')?.[1] === 'r1');
  ok('and handing the stage back', did('release').length === 1);
  ok('and the diagram is told why', runtime.snapshot().last.on === 'reset');
}

{
  // A hidden tab is ticked late, not on time. One late tick must make one move,
  // not replay the whole evening at once.
  const { runtime } = setup();
  runtime.press({ button: 'yes' });
  settle();
  answer(runtime, 'yes');
  advance(120);
  runtime.tick();
  ok('a very late tick moves one step', runtime.state === 'ask' && runtime.level === 2);
}

{
  const { runtime } = setup({}, { holds: {} });
  runtime.press({ button: 'yes' });
  settle();
  answer(runtime, 'yes');
  ok('a rung whose trigger cannot play still takes time', runtime.state === 'scare');
  advance(4.9);
  runtime.tick();
  ok('the fallback hold, five seconds', runtime.state === 'scare');
  advance(0.2);
  runtime.tick();
  ok('and then the next question', runtime.state === 'ask');
}

{
  const { runtime, game } = setup();
  runtime.press({ button: 'yes' });
  settle();
  game.rungs = ['r1'];
  answer(runtime, 'yes');
  advance(4.1);
  runtime.tick();
  ok('editing the ladder mid-game applies to the group already playing', runtime.state === 'approach');
}

{
  const { runtime } = setup();
  ok('nothing is due in Attract', runtime.nextDeadline() === null);
  runtime.press({ button: 'yes' });
  ok('a question is due when it times out', runtime.nextDeadline() === clock + 15000);
  settle();
  runtime.press({ button: 'yes' });
  ok('an open decision window is due sooner', runtime.nextDeadline() === clock + 150);
  const snap = runtime.snapshot();
  ok('the snapshot says what is pending', snap.deciding === 'yes' && snap.state === 'ask' && snap.of === 3);
  ok('and how long is left on the question', Math.abs(snap.remaining - 14.5) < 1e-9);
}

/* ------------------------------------------------------------------ *
 * Saved shows
 * ------------------------------------------------------------------ */

console.log('— words first, like a dare —');
{
  const beats = { ask: [[{ text: 'SO…', seconds: 1 }, { text: 'YOU DARE.', seconds: 2 }]], scare: [[], [{ text: 'TOO LATE', seconds: 1.5 }]] };
  const { runtime, calls, lastOf } = setup({ beats });
  runtime.press({ button: 'yes' });
  ok('a question with words first says them before it asks', runtime.snapshot().saying?.text === 'SO…');
  ok('over whatever was up, without changing the scene yet', lastOf('scene')?.[1] !== 'sAsk1');
  ok('presses are dropped while it speaks', runtime.press({ button: 'yes' }) === 'wait for the words');
  advance(1.05);
  runtime.tick();
  ok('then the next line, by itself', runtime.snapshot().saying?.text === 'YOU DARE.');
  advance(2.05);
  runtime.tick();
  ok('then the question itself', runtime.snapshot().saying === null && lastOf('scene')?.[1] === 'sAsk1');
  ok('armed from when it appeared, not from when the words began', runtime.press({ button: 'yes' }) === 'not armed');
  ok('and its own clock started then too', Math.abs(runtime.snapshot().remaining - 15) < 1e-9);
  settle();
  answer(runtime, 'yes');
  ok('a level with no words goes straight to its scare', runtime.state === 'scare' && runtime.snapshot().saying === null && lastOf('cue')?.[1] === 'r1');
  advance(4.1);
  runtime.tick();
  settle();
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

console.log('— the game in a saved show —');
{
  const project = createProject('t');
  ok('a new show has a game, switched off', project.game && project.game.enabled === false);
  const old = JSON.parse(JSON.stringify(project));
  delete old.game;
  ok('a show from before the game gets one', migrateProject(old).game?.timing?.askTimeout === 15);
  const partial = JSON.parse(JSON.stringify(project));
  partial.game = { enabled: true, timing: { askTimeout: 9 }, scenes: { ask: 'single' }, rungs: ['a', null, 'b'] };
  const migrated = migrateProject(partial).game;
  ok('a saved timing is kept and the missing ones filled in', migrated.timing.askTimeout === 9 && migrated.timing.armMs === 400);
  ok('a single question becomes a list of one', Array.isArray(migrated.scenes.ask) && migrated.scenes.ask[0] === 'single');
  ok('gaps in the ladder close up', migrated.rungs.join() === 'a,b');
  ok('scene slots that were never saved are there', migrated.scenes.reward === null && Array.isArray(migrated.scenes.chicken));
}

{
  const project = createProject('t');
  project.scenes = [createScene({ id: 'q' })];
  project.triggers = [createTrigger({ id: 'T1' })];
  const game = createGame({ rungs: ['T1', 'gone'], scenes: { ...createGame().scenes, ask: ['q'] }, buttons: { b: 'no' } });
  const problems = gameProblems(game, project);
  ok('a rung pointing at a deleted trigger is reported', problems.some((p) => p.includes('Rung 2')));
  ok('so is a missing finale', problems.some((p) => p.includes('finale')));
  ok('and buttons with no YES among them', problems.some((p) => p.includes('YES')));
  ok('and a door stage with no door button', problems.some((p) => p.includes('DOOR')));
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
  ok('levelled states show the ladder height', svg.includes('Ask ×3'));
  ok('nothing is lit without a game running', !svg.includes('gg-current'));

  const { runtime } = setup();
  runtime.press({ button: 'yes' });
  settle();
  answer(runtime, 'yes');
  const live = renderGameGraph({ game, snapshot: runtime.snapshot() });
  ok('live, the current state is lit', /class="gg-node[^"]*gg-current[^"]*" data-state="scare"/.test(live));
  ok('with its level', live.includes('Scare 1/3'));
  ok('the move just made is marked', /class="gg-edge[^"]*gg-last[^"]*" data-from="ask" data-to="scare"/.test(live));
  ok('and the ways out of here are bright', /class="gg-edge[^"]*gg-live[^"]*" data-from="scare" data-to="mercy"/.test(live));
  ok('but not a way out that needs the top rung',
    !/class="gg-edge[^"]*gg-live[^"]*" data-from="scare" data-to="approach"/.test(live));

  const noDoor = renderGameGraph({ game: { ...game, door: false } });
  ok('with the door off, its arrows are drawn as not applying',
    /class="gg-edge[^"]*gg-off[^"]*" data-from="scare" data-to="approach"/.test(noDoor));
  ok('and the finale route at the top of the ladder is not',
    !/class="gg-edge[^"]*gg-off[^"]*" data-from="scare" data-to="finale"/.test(noDoor));
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
