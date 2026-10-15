/**
 * The example dare game, and the helpers the Game panel tells a visit with.
 *
 * The example is what most people will play first, so it has to be a game the
 * runtime can actually play end to end — every slot filled, every scare
 * pointing at a scene, the horror accumulating rung by rung — and building it
 * must not disturb the show it is built into. The last block plays it, with a
 * group that says YES to everything, and checks what is on the wall at every
 * step of the walk.
 *
 *   node test/gameStarter.test.mjs
 */

import { createProject, createLayer, createScene } from '../js/core/state.js';
import { demoShapes } from '../js/control/demoHouse.js';
import { buildExampleGame, removeExampleGame, hasExampleGame, EXAMPLE, EXAMPLE_WORDS } from '../js/control/gameStarter.js';
import { sceneContents, sceneMessage, setSceneMessage, visitSteps } from '../js/control/gamePanel.js';
import { gameProblems, gameSceneIds, sceneSlot } from '../js/core/game.js';
import { createGameRuntime } from '../js/control/game.js';
import { activateScene, applySceneToLayers } from '../js/core/scenes.js';

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

function house() {
  const project = createProject('test');
  project.shapes = demoShapes();
  // Something already in the show, which the example must leave alone.
  const mine = createLayer('fill', { name: 'My own layer', enabled: true });
  project.layers.push(mine);
  project.scenes.push(createScene({ id: 'mine', name: 'My scene', state: { [mine.id]: { enabled: true, opacity: 1, params: {} } } }));
  project.show.activeScene = 'mine';
  return { project, mine };
}

const sceneByName = (project, name) => project.scenes.find((s) => s.name === `Dare · ${name}`);
const contents = (project, name) => new Set(sceneContents(project, sceneByName(project, name)?.id));

console.log('— building it —');
{
  const { project, mine } = house();
  const result = buildExampleGame(project);
  const game = project.game;

  ok('it builds a ladder of three scares and a finale', game.rungs.length === 3 && !!game.finale);
  ok('and switches the game on, ending at the door', game.enabled && game.door);
  ok('every scare points at a trigger that exists',
    [...game.rungs, game.finale].every((id) => project.triggers.some((t) => t.id === id)));
  ok('and every trigger at a scene that exists',
    project.triggers.filter((t) => t.example === EXAMPLE).every((t) => project.scenes.some((s) => s.id === t.sceneId)));
  ok('every moment of the visit has a scene', Object.values(game.scenes).flat().every(Boolean) && game.scenes.ask.length === 3 && game.scenes.chicken.length === 3);
  ok('so the game has nothing to complain about', gameProblems(game, project).length === 0, gameProblems(game, project).join(' | '));
  ok('nothing the demo needs is missing', result.missing.length === 0, result.missing.join(','));

  ok('building it changes nothing on the wall', project.show.activeScene === 'mine' && mine.enabled === true);
  ok('and its layers are all off outside its own scenes',
    project.layers.filter((l) => l.example === EXAMPLE).every((l) => l.enabled === false));
  ok('it says what it made', result.scenes === 18 && result.triggers === 4, `${result.scenes} scenes, ${result.triggers} scares`);

  console.log('— the story it tells —');
  const waiting = contents(project, 'Waiting for visitors');
  ok('the house waits with just brick and smoke', ['Brick', 'Smoke'].every((n) => waiting.has(n)) &&
    !['Blood down the door', 'People at the windows', 'Tentacles through the brick'].some((n) => waiting.has(n)), [...waiting].join(','));
  ok('the first scare is blood on the door', contents(project, 'Scare: blood on the door').has('Blood down the door'));
  ok('the second, people at the windows', contents(project, 'Scare: people at the windows').has('People at the windows'));
  ok('the third, tentacles', contents(project, 'Scare: tentacles').has('Tentacles through the brick'));
  ok('and the house keeps what it has shown: the second question is asked over the blood',
    contents(project, 'Question 2').has('Blood down the door') && !contents(project, 'Question 2').has('People at the windows'));
  ok('the third over the blood and the people',
    ['Blood down the door', 'People at the windows'].every((n) => contents(project, 'Question 3').has(n)));
  const finale = contents(project, 'Finale: the house wakes up');
  ok('the finale is everything at once',
    ['Blood down the door', 'People at the windows', 'Tentacles through the brick', 'Eyes in every window', 'Lightning', 'Bats'].every((n) => finale.has(n)));
  ok('my own layer is in none of it', !finale.has('My own layer') && !waiting.has('My own layer'));

  console.log('— the words —');
  ok('the dare is on the wall while it waits', sceneMessage(project, game.scenes.attract)?.text === EXAMPLE_WORDS.attract);
  ok('each question has its own words', game.scenes.ask.map((id) => sceneMessage(project, id)?.text).join('|') === EXAMPLE_WORDS.ask.join('|'));
  ok('each send-off too', game.scenes.chicken.map((id) => sceneMessage(project, id)?.text).join('|') === EXAMPLE_WORDS.chicken.join('|'));
  ok('the reward says so', sceneMessage(project, game.scenes.reward)?.text === EXAMPLE_WORDS.reward);
  const finaleTrigger = project.triggers.find((t) => t.id === game.finale);
  ok('nothing at the door has words — they could not read them',
    [game.scenes.waiting, game.scenes.early, finaleTrigger.sceneId].every((id) => sceneMessage(project, id) === null));
  ok('and nor does a scare', game.rungs.every((id) => sceneMessage(project, project.triggers.find((t) => t.id === id).sceneId) === null));

  const q1 = game.scenes.ask[0];
  const { layer } = sceneMessage(project, q1);
  setSceneMessage(project, q1, layer.id, 'BOO?');
  ok('rewording a question changes that question', sceneMessage(project, q1).text === 'BOO?');
  ok('and no other', sceneMessage(project, game.scenes.ask[1]).text === EXAMPLE_WORDS.ask[1]);
  ok('and not the layer, while the scene is only shown', layer.params.content !== 'BOO?');
  activateScene(project, q1);
  applySceneToLayers(project, q1);
  setSceneMessage(project, q1, layer.id, 'BOO!');
  ok('but the layer as well, when the scene is loaded for editing', layer.params.content === 'BOO!');

  console.log('— building it again, and taking it away —');
  const counts = () => [project.layers.length, project.scenes.length, project.triggers.length].join('/');
  const before = counts();
  buildExampleGame(project);
  ok('building it twice replaces the first, rather than doubling it', counts() === before, `${before} -> ${counts()}`);
  ok('the rebuilt question has its words back', sceneMessage(project, project.game.scenes.ask[0]).text === EXAMPLE_WORDS.ask[0]);

  removeExampleGame(project);
  ok('removing it removes all of it', !hasExampleGame(project) && !project.scenes.some((s) => s.example) && !project.triggers.some((t) => t.example));
  ok('and the game forgets it', project.game.rungs.length === 0 && !project.game.finale && !sceneSlot(project.game, 'ask', 1));
  ok('leaving my own work where it was', project.layers.includes(mine) && project.scenes.some((s) => s.id === 'mine'));
  ok('and no scene pointing at a layer that is gone', project.scenes.every((s) => Object.keys(s.state || {}).every((id) => project.layers.some((l) => l.id === id))));
}

console.log('— the visit as the panel tells it —');
{
  const { project } = house();
  buildExampleGame(project);
  const { main, side } = visitSteps(project.game);
  ok('it starts with the house waiting', main[0].state === 'attract');
  ok('then a question and a scare for each rung, in turn',
    main.slice(1, 7).map((s) => `${s.state}${s.level}`).join(',') === 'ask1,scare1,ask2,scare2,ask3,scare3');
  ok('then the door, the finale, the wait and the reward',
    main.slice(7).map((s) => s.state).join(',') === 'approach,finale,waiting,reward');
  ok('saying no is told once per question', side.filter((s) => s.state === 'chicken').length === 3);
  ok('alongside mercy, going quiet, both buttons and rushing the door',
    ['mercy', 'nudge', 'decide', 'early'].every((st) => side.some((s) => s.state === st)));
  project.game.door = false;
  ok('without the door stage there is no invitation to it', !visitSteps(project.game).main.some((s) => s.state === 'approach'));
  ok('an empty game still has a first question and a first scare to fill in',
    visitSteps({ ...project.game, rungs: [] }).main.map((s) => s.state).slice(0, 3).join(',') === 'attract,ask,scare');

  const ids = gameSceneIds(project.game, project);
  ok('the game knows which scenes are its own', ids.size === 18, String(ids.size));
  ok('and that mine is not', !ids.has('mine'));
}

console.log('— playing it, with a brave group —');
{
  const { project } = house();
  buildExampleGame(project);
  let clock = 1_000_000;
  const now = () => clock;
  const name = () => project.scenes.find((s) => s.id === project.show.activeScene)?.name?.replace('Dare · ', '');
  const runtime = createGameRuntime({
    getGame: () => project.game,
    now,
    io: {
      scene: (id) => activateScene(project, id, { fade: 0 }),
      cue: (id) => {
        const t = project.triggers.find((x) => x.id === id);
        activateScene(project, t.sceneId, { fade: 0 });
        return t.hold;
      },
      cueEnd: () => {},
      release: () => activateScene(project, 'mine', { fade: 0 }),
    },
  });
  const wait = (s) => {
    clock += s * 1000;
    runtime.tick();
  };
  const yes = () => {
    runtime.press({ button: 'yes' });
    wait(0.2);
  };

  const seen = [];
  runtime.press({ button: 'yes' });
  seen.push(name());
  for (let rung = 0; rung < 3; rung++) {
    wait(1);
    yes();
    seen.push(name());
    wait(10);
    seen.push(name());
  }
  runtime.press({ button: 'door' });
  seen.push(name());
  wait(11);
  seen.push(name());
  runtime.press({ button: 'treat' });
  seen.push(name());
  wait(9);
  seen.push(name());
  wait(7);
  seen.push(name());

  const expected = [
    'Question 1',
    'Scare: blood on the door', 'Question 2',
    'Scare: people at the windows', 'Question 3',
    'Scare: tentacles', 'Come to the door',
    'Finale: the house wakes up', 'Waiting for a treat',
    'You survived', 'My scene', 'Waiting for visitors',
  ];
  ok('every step of the walk shows the scene it should', seen.join(' > ') === expected.join(' > '), seen.join(' > '));
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
