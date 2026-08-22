/**
 * Scenes, and the two kinds of them.
 *
 * A scene is how a show changes: press 2 and the house is Halloween, press 4
 * and it is Christmas. That worked for one preset and quietly stopped working
 * for two, in a way nobody would think to test for, because each of the pieces
 * behaved exactly as documented on its own.
 *
 * Applying a starter preset appended its layers and left everything already
 * there switched on, then captured "the current look" — so a project with
 * Halloween and Christmas in it had two scenes that both said *everything on*,
 * and the hotkeys had nothing to switch between. The scene changed; the wall
 * did not.
 *
 * The other half is the opposite mistake. A one-shot on a trigger is a scene
 * that names exactly one layer, deliberately, so that firing it in the middle
 * of anything changes only that one thing. But a layer the incoming scene did
 * not mention was still taken down the crossfade path if the *outgoing* scene
 * had an opinion about it — so pressing X on the demo house blacked out the
 * entire show and left the bats flying over nothing.
 *
 * Both come from the same missing distinction: whether a scene describes the
 * whole show or only part of it. That cannot be recovered from its contents,
 * so it is recorded — see `full` in core/state.js — and these are the tests
 * that say what each kind does.
 *
 *   node test/scenes.test.mjs
 */

import { createProject, createLayer, createScene, migrateProject } from '../js/core/state.js';
import { applyPreset, addDemoBursts, PRESETS } from '../js/control/presets.js';
import {
  captureScene,
  activateScene,
  applySceneToLayers,
  effectiveLayers,
} from '../js/core/scenes.js';
import { demoShapes } from '../js/control/demoHouse.js';

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

/** A project with the demo house traced, so tag-targeted layers survive. */
function traced(name = 'test') {
  const project = createProject(name);
  project.shapes = demoShapes();
  return project;
}

/** Which preset each layer came from, recorded as the presets are applied. */
function applyPresets(project, ids) {
  const owner = new Map();
  for (const id of ids) {
    const before = new Set(project.layers.map((l) => l.id));
    applyPreset(project, id);
    for (const layer of project.layers) if (!before.has(layer.id)) owner.set(layer.id, id);
  }
  return owner;
}

const liveLayers = (project) => effectiveLayers(project).filter((l) => l.enabled !== false);

/* ------------------------------------------------------------------ *
 * Two presets, two looks
 * ------------------------------------------------------------------ */

console.log('— a show with more than one starter in it —');

{
  const project = traced();
  const owner = applyPresets(project, ['halloween', 'christmas', 'birthday']);

  ok('each preset added layers', owner.size === project.layers.length,
    `${project.layers.length} layers from 3 presets`);
  ok('and each saved a scene', project.scenes.length === 3,
    project.scenes.map((s) => s.name).join(', '));

  const seen = [];
  for (const scene of project.scenes) {
    activateScene(project, scene.id, { fade: 0 });
    applySceneToLayers(project, scene.id);
    const live = liveLayers(project);
    const from = new Set(live.map((l) => owner.get(l.id)));
    seen.push({ name: scene.name, live: live.length, from: [...from] });
  }

  for (const entry of seen) {
    ok(`"${entry.name}" lights only its own layers`,
      entry.live > 0 && entry.from.length === 1,
      `${entry.live} live, from ${entry.from.join(' + ')}`);
  }

  /**
   * The point of the whole exercise, stated as one assertion: the three scenes
   * are three different shows. Before this they were three identical ones.
   */
  const signatures = new Set();
  for (const scene of project.scenes) {
    activateScene(project, scene.id, { fade: 0 });
    signatures.add(liveLayers(project).map((l) => l.id).sort().join(','));
  }
  ok('so switching scenes actually changes the wall',
    signatures.size === project.scenes.length, `${signatures.size} distinct looks from ${project.scenes.length} scenes`);
}

{
  // Nothing is destroyed by applying a second starter — the layers are still
  // there, switched off, and the scene that owns them still turns them back on.
  const project = traced();
  applyPreset(project, 'halloween');
  const halloweenLayers = project.layers.length;
  const result = applyPreset(project, 'christmas');

  ok('a second starter keeps the first one in the project',
    project.layers.length > halloweenLayers,
    `${project.layers.length} layers, ${halloweenLayers} of them Halloween's`);
  ok('and says how much it switched off', result.replaced === halloweenLayers,
    `${result.replaced} replaced`);

  activateScene(project, project.scenes[0].id, { fade: 0 });
  applySceneToLayers(project, project.scenes[0].id);
  ok('and the first look comes back in one keypress',
    liveLayers(project).length === halloweenLayers,
    `${liveLayers(project).length} live`);
}

/* ------------------------------------------------------------------ *
 * A captured scene is authoritative
 * ------------------------------------------------------------------ */

console.log('\n— a captured look describes the whole show —');

{
  const project = traced();
  const a = createLayer('fill', { name: 'A', enabled: true });
  const b = createLayer('wash', { name: 'B', enabled: true });
  project.layers.push(a, b);

  const early = createScene({ name: 'Early', state: captureScene(project), full: true });
  project.scenes.push(early);

  // A layer added after the scene was saved is not part of it.
  const late = createLayer('snow', { name: 'C', enabled: true });
  project.layers.push(late);

  activateScene(project, early.id, { fade: 0 });
  const live = liveLayers(project).map((l) => l.name);
  ok('a layer added after it was saved is not in it',
    !live.includes('C') && live.includes('A') && live.includes('B'), live.join(', '));

  applySceneToLayers(project, early.id);
  ok('and loading the scene switches that layer off too, so the panel agrees',
    late.enabled === false);
}

{
  // Two full scenes crossfading: half way through, both are on their way.
  const project = traced();
  const a = createLayer('fill', { name: 'A', enabled: true });
  const b = createLayer('wash', { name: 'B', enabled: false });
  project.layers.push(a, b);
  const one = createScene({ name: 'One', state: captureScene(project), full: true });

  a.enabled = false;
  b.enabled = true;
  const two = createScene({ name: 'Two', state: captureScene(project), full: true });
  project.scenes.push(one, two);

  activateScene(project, one.id, { fade: 0 });
  activateScene(project, two.id, { fade: 4 });
  project.show.sceneChangeAt -= 2000; // half way through a four-second fade

  const mid = effectiveLayers(project);
  const opacityOf = (name) => mid.find((l) => l.name === name)?.opacity ?? 0;
  ok('a crossfade has both scenes part-way through',
    opacityOf('A') > 0.2 && opacityOf('A') < 0.8 && opacityOf('B') > 0.2 && opacityOf('B') < 0.8,
    `A ${opacityOf('A').toFixed(2)}, B ${opacityOf('B').toFixed(2)}`);

  project.show.sceneChangeAt -= 4000; // and now well past the end
  const done = liveLayers(project).map((l) => l.name);
  ok('and lands on the incoming one', done.join(',') === 'B', done.join(', ') || 'nothing');
}

/* ------------------------------------------------------------------ *
 * A one-shot speaks only for itself
 * ------------------------------------------------------------------ */

console.log('\n— firing a one-shot over a running show —');

{
  const project = traced();
  applyPreset(project, 'halloween');
  const bursts = addDemoBursts(project, 'halloween');
  ok('the demo ships one-shots', bursts.length > 0, bursts.map((b) => b.key).join(', '));

  const look = project.scenes[0];
  activateScene(project, look.id, { fade: 0 });
  const ambient = liveLayers(project).length;
  ok('the ambient look is running', ambient > 3, `${ambient} layers`);

  const burstScene = project.scenes.find((s) => s.name === bursts[0].name);
  ok('and a one-shot names exactly one layer',
    Object.keys(burstScene.state).length === 1 && burstScene.full === false);

  activateScene(project, burstScene.id, { fade: 0 });
  const during = liveLayers(project);

  /**
   * The regression this file exists for. Pressing X used to leave this at one.
   */
  ok('firing it leaves the rest of the show alone',
    during.length === ambient + 1,
    `${during.length} live, was ${ambient}`);
  ok('and the burst itself is on',
    during.some((l) => l.name === bursts[0].name));

  // The trigger's hold puts the previous scene back.
  activateScene(project, look.id, { fade: 0 });
  ok('and it goes away again when the trigger releases',
    liveLayers(project).length === ambient, `${liveLayers(project).length} live`);
}

{
  // Every preset's own one-shots, not just the fallback set — a burst wired to
  // a look it does not belong to would still pass the test above.
  const broken = [];
  for (const preset of PRESETS) {
    const project = traced();
    applyPreset(project, preset.id);
    const bursts = addDemoBursts(project, preset.id);
    const look = project.scenes[0];
    activateScene(project, look.id, { fade: 0 });
    const ambient = liveLayers(project).length;

    for (const burst of bursts) {
      const scene = project.scenes.find((s) => s.name === burst.name);
      activateScene(project, scene.id, { fade: 0 });
      const live = liveLayers(project);
      if (live.length !== ambient + 1) {
        broken.push(`${preset.id}/${burst.key}: ${live.length} live, ambient is ${ambient}`);
      }
      activateScene(project, look.id, { fade: 0 });
    }
  }
  ok('every demo, every key', broken.length === 0, broken.slice(0, 3).join('; '));
}

/* ------------------------------------------------------------------ *
 * Shows saved before any of this existed
 * ------------------------------------------------------------------ */

console.log('\n— a project saved before scenes recorded which kind they were —');

{
  const project = traced();
  applyPreset(project, 'halloween');
  addDemoBursts(project, 'halloween');

  // Strip the flag, as an exported show from an older version would have it.
  const exported = JSON.parse(JSON.stringify(project));
  for (const scene of exported.scenes) delete scene.full;

  const loaded = migrateProject(exported);
  const look = loaded.scenes[0];
  const burst = loaded.scenes[1];

  ok('a captured look is recognised as one', look.full === true,
    `${Object.keys(look.state).length} layers named`);
  ok('and a one-shot is not', burst.full === false,
    `${Object.keys(burst.state).length} layer named`);

  activateScene(loaded, look.id, { fade: 0 });
  const ambient = liveLayers(loaded).length;
  activateScene(loaded, burst.id, { fade: 0 });
  ok('so an old show behaves like a new one',
    liveLayers(loaded).length === ambient + 1,
    `${liveLayers(loaded).length} live, was ${ambient}`);
}

{
  // The dangerous misreading, stated as a test: a one-shot must never be taken
  // for a captured look, because that would black the show out when it fired.
  const project = createProject('single');
  project.layers.push(createLayer('fill', { name: 'only', enabled: false }));
  const scene = createScene({ name: 'burst', state: { [project.layers[0].id]: { enabled: true, opacity: 1, params: {} } } });
  delete scene.full;
  project.scenes.push(scene);
  const loaded = migrateProject(JSON.parse(JSON.stringify(project)));
  ok('a one-layer scene is never inferred to be a whole show',
    loaded.scenes[0].full === false);
}

/* ------------------------------------------------------------------ *
 * The panel and the hotkey have to agree
 * ------------------------------------------------------------------ */

console.log('\n— clicking a scene and pressing its key are the same thing —');

{
  const project = traced();
  applyPresets(project, ['halloween', 'christmas']);

  for (const scene of project.scenes) {
    // The hotkey path: activate for the renderer, then load onto the layers.
    activateScene(project, scene.id, { fade: 0 });
    const rendered = liveLayers(project).map((l) => l.id).sort().join(',');
    applySceneToLayers(project, scene.id);
    const onLayers = project.layers.filter((l) => l.enabled !== false).map((l) => l.id).sort().join(',');
    ok(`"${scene.name}" renders what the layer list says it does`,
      rendered === onLayers,
      `${rendered.split(',').filter(Boolean).length} vs ${onLayers.split(',').filter(Boolean).length}`);
  }
}

/* ------------------------------------------------------------------ *
 * A scene you loaded is a starting point, not a cage
 * ------------------------------------------------------------------ */

console.log('\n— and a loaded scene lets go of the layers —');

{
  /**
   * The switches have to work while a scene is up.
   *
   * A scene arrives one of two ways and they mean different things. A trigger
   * or a playlist fires one *at* the layers — the values are applied at render
   * time, every frame, and the project is deliberately left alone, or an
   * evening of scares would slowly overwrite the show with the last scare. A
   * person pressing a scene gets it copied *onto* the layers instead, so the
   * inspector shows what is on the wall and editing works normally.
   *
   * The second kind used to keep being applied at render time as well, and the
   * effect was a control surface with dead switches: turn a layer off, the
   * project changes, the panel agrees, and the next frame puts the scene's own
   * value back. Which layers it happened to was whichever ones the scene named,
   * so a preset's captured look froze every switch and a hand-built one froze
   * some — two scenes behaving differently for a reason nothing on screen could
   * explain.
   */
  const project = traced();
  applyPresets(project, ['halloween']);
  const scene = project.scenes[0];
  ok('the preset saved a whole-show scene', scene.full === true, `full: ${scene.full}`);

  // Pressed by a person: activated, then loaded onto the layers.
  activateScene(project, scene.id, { fade: 0 });
  applySceneToLayers(project, scene.id);

  const target = project.layers.find((l) => l.enabled !== false);
  ok('something is on to turn off', !!target, target?.name);

  target.enabled = false;
  const afterOff = effectiveLayers(project).find((l) => l.id === target.id);
  ok('turning a layer off while a loaded scene is up turns it off',
    afterOff.enabled === false, `renderer says enabled: ${afterOff.enabled}`);

  target.enabled = true;
  const afterOn = effectiveLayers(project).find((l) => l.id === target.id);
  ok('and turning it back on turns it back on', afterOn.enabled === true);

  // The other direction: a parameter edit has to survive too, since the same
  // override was replacing those.
  const [first] = project.layers;
  first.opacity = 0.25;
  ok('and an opacity edit is not put back either',
    effectiveLayers(project).find((l) => l.id === first.id).opacity === 0.25);
}

{
  /**
   * The other kind still holds, which is the half that must not regress: a
   * trigger fires a scene without rewriting the project, so its values *are*
   * the override, and they have to keep being applied.
   */
  const project = traced();
  applyPresets(project, ['halloween']);
  const scene = project.scenes[0];

  activateScene(project, scene.id, { fade: 0 });    // as a trigger does: no load
  const target = project.layers.find((l) => scene.state[l.id]?.enabled);
  target.enabled = false;                            // somebody edits at the desk

  ok('a scene fired by a trigger still overrides the layers',
    effectiveLayers(project).find((l) => l.id === target.id).enabled === true,
    'the project is left alone and the wall shows the scene');
}

{
  /**
   * And loading a scene does not break the crossfade, which is the thing the
   * render-time override exists for. Half way through a fade the blend still
   * has to run, whatever the layers now say.
   */
  const project = traced();
  applyPresets(project, ['halloween', 'christmas']);
  const [a, b] = project.scenes;

  activateScene(project, a.id, { fade: 0 });
  applySceneToLayers(project, a.id);
  activateScene(project, b.id, { fade: 4 });
  applySceneToLayers(project, b.id);

  // Half way: `sceneChangeAt` is on the shared clock, so ask for a moment two
  // seconds after it rather than waiting two seconds.
  const half = project.show.sceneChangeAt + 2000;
  const mid = effectiveLayers(project, half);
  const ended = effectiveLayers(project, project.show.sceneChangeAt + 9000);

  const faded = mid.filter((l) => (l.opacity ?? 1) > 0.001 && (l.opacity ?? 1) < 0.999);
  ok('a crossfade still blends after the scene has been loaded',
    faded.length > 0, `${faded.length} layers part way`);
  ok('and once it is over the layers are back in charge',
    ended.length === project.layers.length
      && ended.every((l, i) => l === project.layers[i]),
    'the same objects, not copies');
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
