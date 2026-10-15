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
import { sceneContents, sceneMessage, setSceneMessage } from '../js/control/gamePanel.js';
import { gameProblems, gameSceneIds, sceneSlot } from '../js/core/game.js';
import { createGameRuntime } from '../js/control/game.js';
import { activateScene, applySceneToLayers } from '../js/core/scenes.js';
import { resolveParams } from '../js/core/modulators.js';
import { getEffect } from '../js/effects/registry.js';

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

  console.log('— the flowers —');
  ok('the flowers are in bloom while the house waits',
    waiting.has('Hanging flowers') && !waiting.has('Hanging flowers dying'));
  ok('and still at the first question', contents(project, 'Question 1').has('Hanging flowers'));
  const scare1 = contents(project, 'Scare: blood on the door');
  ok('the first scare swaps in the dying bunch', scare1.has('Hanging flowers dying') && !scare1.has('Hanging flowers'));
  ok('and they stay dead to the end',
    ['Question 2', 'Question 3', 'Scare: tentacles', 'Finale: the house wakes up', 'Waiting for a treat']
      .every((n) => contents(project, n).has('Hanging flowers dying') && !contents(project, n).has('Hanging flowers')));
  const dying = project.layers.find((l) => l.name === 'Hanging flowers dying');
  const fresh = project.layers.find((l) => l.name === 'Hanging flowers');
  const wiltAt = (age) => resolveParams(getEffect('flowers'), dying, { t: 100 + age, age, beat: 0, bpm: 120 }).wilt;
  ok('dying, they wilt as the layer ages', wiltAt(0) === 0 && Math.abs(wiltAt(3) - 0.5) < 1e-9 && wiltAt(6) === 1 && wiltAt(60) === 1,
    [0, 3, 6, 60].map(wiltAt).join(','));
  ok('and start exactly as the fresh bunch is, so the swap cannot be seen',
    JSON.stringify(fresh.params) === JSON.stringify(dying.params) && JSON.stringify(fresh.targetTags) === JSON.stringify(dying.targetTags));

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

console.log('— a house with nowhere for flowers —');
{
  const project = createProject('bare');
  project.shapes = demoShapes().filter((sh) => !(sh.tags || []).includes('planter'));
  buildExampleGame(project);
  ok('no planter, no flowers — they would fill the whole picture', !project.layers.some((l) => l.effect === 'flowers'));
  ok('and the game is still whole', gameProblems(project.game, project).length === 0);
}

console.log('— the game\'s own scenes —');
{
  const { project } = house();
  buildExampleGame(project);
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
  const said = [];
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
      caption: (text) => {
        if (text) said.push(text);
      },
      release: () => activateScene(project, 'mine', { fade: 0 }),
    },
  });
  const wait = (s) => {
    clock += s * 1000;
    runtime.tick();
  };
  /** Let any words being said finish, a tenth of a second at a time. */
  const hearOut = () => {
    for (let i = 0; i < 200 && runtime.snapshot().saying; i++) wait(0.1);
  };
  const yes = () => {
    runtime.press({ button: 'yes' });
    wait(0.2);
  };

  const seen = [];
  runtime.press({ button: 'yes' });
  ok('the first YES is answered with words before the question', runtime.snapshot().saying?.text === 'SO…');
  ok('and a press while they are said is dropped, not saved up', runtime.press({ button: 'yes' }) === 'wait for the words');
  hearOut();
  seen.push(name());
  for (let rung = 0; rung < 3; rung++) {
    wait(1);
    yes();
    hearOut();
    seen.push(name());
    wait(10);
    hearOut();
    seen.push(name());
  }
  runtime.press({ button: 'door' });
  seen.push(name());
  wait(11);
  seen.push(name());
  runtime.press({ button: 'treat' });
  hearOut();
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
  ok('with every line said, in order, on the way',
    said.join(' | ') === ['SO…', 'YOU DARE.', 'YOU ASKED FOR IT…', "DON'T SAY WE\nDIDN'T WARN YOU…", 'TOO LATE', 'TO RUN…', 'THE HOUSE\nLETS YOU GO…'].join(' | '),
    said.join(' | ').replace(/\n/g, ' '));
  ok('and the message layer is the one that says them', project.game.messageLayer === project.layers.find((l) => l.name === 'Message')?.id);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
