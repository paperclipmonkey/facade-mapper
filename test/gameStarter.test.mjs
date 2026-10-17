/**
 * The example automation.
 *
 * The example is what most people will play first, so it has to be one the
 * runtime can actually play end to end — every step showing something, every
 * link leading somewhere, the horror accumulating scare by scare — and
 * building it must not disturb the show it is built into. The last block plays
 * it, and checks what is on the wall and what it says at every step.
 *
 *   node test/gameStarter.test.mjs
 */

import { createProject, createLayer, createScene } from '../js/core/state.js';
import { demoShapes } from '../js/control/demoHouse.js';
import { buildExampleGame, removeExampleGame, hasExampleGame, EXAMPLE, EXAMPLE_WORDS } from '../js/control/gameStarter.js';
import { gameProblems, gameSceneIds, startStep, stepById, reachable } from '../js/core/game.js';
import { createGameRuntime } from '../js/control/game.js';
import { activateScene } from '../js/core/scenes.js';
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

/** The effects a scene turns on, by name — what the house is doing then. */
function sceneContents(project, sceneId) {
  const scene = project.scenes.find((s) => s.id === sceneId);
  const out = new Set();
  if (!scene) return out;
  for (const layer of project.layers) {
    const stored = scene.state?.[layer.id];
    if (stored ? stored.enabled : !scene.full && layer.enabled) out.add(layer.name);
  }
  return out;
}

const stepNamed = (project, name) => project.game.steps.find((s) => s.name === name);
const contents = (project, stepName) => sceneContents(project, stepNamed(project, stepName)?.sceneId);

console.log('— building it —');
{
  const { project, mine } = house();
  const result = buildExampleGame(project);
  const game = project.game;

  ok('it builds thirteen steps, and switches them on', game.steps.length === 13 && game.enabled, String(game.steps.length));
  ok('starting at "Trick or treat?"', startStep(game).name === 'Trick or treat?');
  ok('every step can be reached', reachable(game).size === 13);
  ok('so there is nothing to complain about', gameProblems(game, project).length === 0, gameProblems(game, project).join(' | '));
  ok('nothing the demo needs is missing', result.missing.length === 0, result.missing.join(','));
  ok('it says what it made', result.steps === 13 && result.scenes === 8, `${result.steps} steps, ${result.scenes} scenes`);
  ok('the steps’ scenes are all the example’s', [...gameSceneIds(game)].every((id) => project.scenes.find((s) => s.id === id)?.example === EXAMPLE));

  ok('building it changes nothing on the wall', project.show.activeScene === 'mine' && mine.enabled === true);
  ok('and its layers are all off outside its own scenes',
    project.layers.filter((l) => l.example === EXAMPLE).every((l) => l.enabled === false));

  console.log('— the story it tells —');
  const link = (from, on) => stepById(game, stepNamed(project, from).on[on])?.name;
  ok('YES to "Trick or treat?" is lightning and smoke', link('Trick or treat?', 'yes') === 'Lightning and smoke');
  ok('NO is "did you say trick?", then "but we love to scare"',
    link('Trick or treat?', 'no') === 'Did you say trick?' && link('Did you say trick?', 'no') === 'But we love to scare');
  ok('and a third NO is "come and get your treat"', link('But we love to scare', 'no') === 'Come and get your treat');
  ok('"Scared yet?" turns them round: NO is another scare', link('Scared yet?', 'no') === 'Flowers die, creature' && link('Scared yet? (again)', 'no') === 'Tentacles');
  ok('and YES is the treat', link('Scared yet?', 'yes') === 'Come and get your treat');
  ok('DOOR is only listened for once they are invited up',
    game.steps.filter((s) => s.on.door).map((s) => s.name).sort().join('|') === 'Come and get your treat|Out of tricks');
  ok('the invitations ring indoors', ['Come and get your treat', 'Out of tricks', 'At the door'].every((n) => stepNamed(project, n).alert));
  ok('every question goes back to the start after two minutes',
    game.steps.filter((s) => Object.values(s.on).some(Boolean) && s !== startStep(game))
      .every((s) => s.after.seconds === 120 && s.after.to === game.start));

  const waiting = contents(project, 'Trick or treat?');
  ok('the house waits with brick and flowers, nothing scary yet', ['Brick', 'Hanging flowers'].every((n) => waiting.has(n)) &&
    !['Lightning', 'Creature at the windows', 'Tentacles through the brick'].some((n) => waiting.has(n)), [...waiting].join(','));
  const s1 = contents(project, 'Lightning and smoke');
  ok('the first scare is lightning and smoke', s1.has('Lightning') && s1.has('Smoke'));
  const s2 = contents(project, 'Flowers die, creature');
  ok('the second, the flowers die and a creature is at the windows', s2.has('Hanging flowers dying') && s2.has('Creature at the windows') && !s2.has('Hanging flowers'));
  const s3 = contents(project, 'Tentacles');
  ok('the third, tentacles from the walls and blood down the door', s3.has('Tentacles through the brick') && s3.has('Blood down the door'));
  ok('and it keeps what it has shown', s3.has('Creature at the windows') && s3.has('Hanging flowers dying'));
  const door = contents(project, 'At the door');
  ok('the door is everything at once', ['Creature at the windows', 'Tentacles through the brick', 'Eyes in every window', 'Lightning', 'Bats'].every((n) => door.has(n)));
  ok('my own layer is in none of it', !door.has('My own layer') && !waiting.has('My own layer'));

  console.log('— the words —');
  const words = (name) => stepNamed(project, name).words;
  ok('it asks trick or treat', words('Trick or treat?') === EXAMPLE_WORDS.attract);
  ok('argues with a NO', words('Did you say trick?') === EXAMPLE_WORDS.persuade[0] && words('But we love to scare') === EXAMPLE_WORDS.persuade[1]);
  ok('asks "scared yet?" with words alone, over whatever the scare left',
    words('Scared yet? (again)') === EXAMPLE_WORDS.more && !stepNamed(project, 'Scared yet? (again)').sceneId);
  ok('and says goodbye with Happy Halloween', words('Happy Halloween') === EXAMPLE_WORDS.goodbye);
  ok('nothing at the door has words — they could not read them', !words('At the door') && !words('Sweets'));
  ok('no scene has words of its own: they are the steps’',
    [...gameSceneIds(game)].every((id) => !project.scenes.find((s) => s.id === id).state[game.messageLayer]?.enabled));

  console.log('— the flowers —');
  ok('in bloom while the house waits, and through the first scare', waiting.has('Hanging flowers') && s1.has('Hanging flowers') && !s1.has('Hanging flowers dying'));
  const dying = project.layers.find((l) => l.name === 'Hanging flowers dying');
  const fresh = project.layers.find((l) => l.name === 'Hanging flowers');
  const wiltAt = (age) => resolveParams(getEffect('flowers'), dying, { t: 100 + age, age, beat: 0, bpm: 120 }).wilt;
  ok('dying, they wilt as the layer ages', wiltAt(0) === 0 && Math.abs(wiltAt(3) - 0.5) < 1e-9 && wiltAt(6) === 1 && wiltAt(60) === 1,
    [0, 3, 6, 60].map(wiltAt).join(','));
  ok('and start exactly as the fresh bunch is, so the swap cannot be seen',
    JSON.stringify(fresh.params) === JSON.stringify(dying.params) && JSON.stringify(fresh.targetTags) === JSON.stringify(dying.targetTags));

  console.log('— building it again, and taking it away —');
  const counts = () => [project.layers.length, project.scenes.length, project.game.steps.length].join('/');
  const before = counts();
  buildExampleGame(project);
  ok('building it twice replaces the first, rather than doubling it', counts() === before, `${before} -> ${counts()}`);

  removeExampleGame(project);
  ok('removing it removes all of it', !hasExampleGame(project) && !project.scenes.some((s) => s.example) && project.game.steps.length === 0);
  ok('and forgets where it started', project.game.start === null && project.game.messageLayer === null);
  ok('leaving my own work where it was', project.layers.includes(mine) && project.scenes.some((s) => s.id === 'mine'));
  ok('and no scene pointing at a layer that is gone', project.scenes.every((s) => Object.keys(s.state || {}).every((id) => project.layers.some((l) => l.id === id))));
}

console.log('— a house with nowhere for flowers —');
{
  const project = createProject('bare');
  project.shapes = demoShapes().filter((sh) => !(sh.tags || []).includes('planter'));
  const result = buildExampleGame(project);
  ok('no planter, no flowers — they would fill the whole picture', !project.layers.some((l) => l.effect === 'flowers'));
  ok('and building it says so', result.flowers === false);
  ok('and the automation is still whole', gameProblems(project.game, project).length === 0);

  // A hanging basket traced as a basket is a planter.
  project.shapes = demoShapes().map((sh) => ({ ...sh, tags: (sh.tags || []).map((t) => (t === 'planter' ? 'basket' : t)) }));
  const basket = buildExampleGame(project);
  ok('a shape tagged basket grows them just the same',
    basket.flowers && project.layers.filter((l) => l.effect === 'flowers').every((l) => l.targetTags.join() === 'basket'));
}

console.log('— playing the script —');
{
  const { project } = house();
  buildExampleGame(project);
  let clock = 1_000_000;
  const now = () => clock;
  const said = [];
  const runtime = createGameRuntime({
    getGame: () => project.game,
    now,
    io: {
      scene: (id) => activateScene(project, id, { fade: 0 }),
      caption: (text) => said.push(text),
    },
  });
  const scene = () => project.scenes.find((s) => s.id === project.show.activeScene)?.name?.replace('Example · ', '');
  const wait = (s) => {
    clock += s * 1000;
    runtime.tick();
  };
  const press = (button) => {
    wait(1);
    return runtime.press({ button });
  };
  const at = () => `${runtime.snapshot().name} [${scene()}]`;

  runtime.reset();
  const seen = [at()];
  press('no'); seen.push(at());
  press('no'); seen.push(at());
  press('yes'); seen.push(at());
  wait(6); seen.push(at());
  press('no'); seen.push(at());
  wait(7); seen.push(at());
  press('no'); seen.push(at());
  wait(8); seen.push(at());
  press('door'); seen.push(at());
  wait(10); seen.push(at());
  wait(30); seen.push(at());
  wait(8); seen.push(at());

  const expected = [
    'Trick or treat? [The house]',
    'Did you say trick? [The house]',
    'But we love to scare [The house]',
    'Lightning and smoke [Lightning and smoke]',
    'Scared yet? [Smoke]',
    'Flowers die, creature [Flowers die, creature at the windows]',
    'Scared yet? (again) [Flowers die, creature at the windows]',
    'Tentacles [Tentacles from the walls]',
    'Out of tricks [Tentacles from the walls]',
    'At the door [The house wakes up]',
    'Sweets [Sweets]',
    'Happy Halloween [Goodbye]',
    'Trick or treat? [The house]',
  ];
  ok('every step shows what it should, and keeps the house where it says nothing new',
    seen.join(' > ') === expected.join(' > '), seen.join(' > '));
  ok('and says what it should', said.includes(EXAMPLE_WORDS.outOfTricks) && said.at(-1) === EXAMPLE_WORDS.attract);

  // A group that will not be talked round.
  press('no');
  press('no');
  press('no');
  ok('three NOs and it sends them for their treat', runtime.snapshot().name === 'Come and get your treat');
  ok('over the house as it was, since nothing happened', scene() === 'The house');
  press('door');
  ok('and DOOR is them coming up for it', runtime.snapshot().name === 'At the door');

  // And a group that walks off.
  runtime.reset();
  press('no');
  wait(121);
  ok('a question nobody answers goes back to the start', runtime.snapshot().name === 'Trick or treat?');
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
