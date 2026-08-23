/**
 * Every project this app has ever saved, arriving at a newer copy of it.
 *
 * `migrateProject` is the narrowest gate in the codebase: nothing reaches the
 * renderer without going through it. Everything on the other side of it —
 * effects, panels, the projector tabs — is written against a project that is
 * *complete*, because filling the gaps is this function's whole job. When it
 * leaves one, the failure surfaces a long way from here and never says what it
 * is: a layer that renders nothing while the list says it is on, a hook that
 * fires for one half of a trigger and throws for the other.
 *
 * It also has to survive being handed something that is not a project at all.
 * The import path takes any JSON file somebody drags in, and a file that was
 * hand-edited, truncated by a full disk, or written by an older version is not
 * an error the app should refuse — it is a project with holes in it.
 *
 *   node test/migrate.test.mjs
 */

import {
  migrateProject,
  createProject,
  createLayer,
  createShape,
  createTrigger,
  createScene,
  PROJECT_VERSION,
  resolveTargets,
  worldSize,
} from '../js/core/state.js';

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

/** Whatever comes back has to be usable, so every check runs against that. */
const migrated = (raw) => migrateProject(raw);

/* ------------------------------------------------------------------ *
 * A round trip
 * ------------------------------------------------------------------ */

console.log('— a project that has been saved and loaded again —');
{
  const original = createProject('Front of the house');
  original.shapes.push(createShape([{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.1 }, { x: 0.4, y: 0.5 }], {
    id: 'w1', name: 'Window 1', tags: ['window'],
  }));
  original.layers.push(createLayer('fill', { id: 'l1', targets: ['w1'], params: { level: 0.8 } }));
  original.triggers.push(createTrigger({ id: 't1' }));
  original.scenes.push(createScene({ id: 's1', state: { l1: { enabled: true, opacity: 1, params: {} } } }));

  const back = migrated(JSON.parse(JSON.stringify(original)));
  ok('a round trip through JSON changes nothing that matters',
    back.name === original.name
      && back.shapes.length === 1
      && back.layers[0].params.level === 0.8
      && back.triggers.length === 1);
  ok('and stamps the current version', back.version === PROJECT_VERSION);
  ok('a show left running does not restart itself on load', back.show.running === false);
}

/* ------------------------------------------------------------------ *
 * The holes
 * ------------------------------------------------------------------ */

console.log('\n— a file with holes in it —');
{
  ok('nothing at all is a new project', migrated(null).layers.length === 0);
  ok('so is a string', migrated('nope').shapes.length === 0);
  ok('and a number', migrated(7).projectors.length === 1);
  ok('an empty object comes back complete',
    Object.keys(createProject()).every((key) => key in migrated({})));

  const wrong = migrated({
    projectors: 'nope', shapes: null, layers: 42, scenes: {}, triggers: 'x',
    media: 1, userEffects: false, settings: 'bad', show: null, schedule: [],
  });
  ok('every list that is not a list becomes an empty one',
    Array.isArray(wrong.shapes) && Array.isArray(wrong.layers)
      && Array.isArray(wrong.scenes) && Array.isArray(wrong.triggers)
      && Array.isArray(wrong.media) && Array.isArray(wrong.userEffects));
  ok('and there is always at least one projector to render into',
    wrong.projectors.length === 1 && wrong.projectors[0].calibration.mode === 'none');
  ok('the settings come back whole', wrong.settings.master === 1 && wrong.settings.grade !== undefined);
  ok('so does the schedule', wrong.schedule.on === '18:00' && Array.isArray(wrong.schedule.days));
}

{
  const half = migrated({
    projectors: [{ id: 'p1', name: 'Garage', calibration: { mode: 'auto' }, blend: { left: 0.2 } }],
  });
  const projector = half.projectors[0];
  ok('a projector keeps what it had', projector.name === 'Garage' && projector.calibration.mode === 'auto');
  ok('and gains what it never had', projector.mesh.cols === 3 && projector.blend.gamma === 1.8);
  ok('with the half it did have left alone', projector.blend.left === 0.2);
}

{
  const dropped = migrated({
    shapes: [
      { id: 'a', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] },
      { id: 'b', points: [{ x: 0, y: 0 }] },
      { id: 'c', points: [] },
      { id: 'd' },
    ],
  });
  ok('a shape with too few points to be one is dropped',
    dropped.shapes.map((s) => s.id).join(',') === 'a', dropped.shapes.map((s) => s.id).join(','));
  ok('and the survivor is a whole shape', dropped.shapes[0].visible === true && dropped.shapes[0].z === 0);
}

/* ------------------------------------------------------------------ *
 * The two that were silent
 * ------------------------------------------------------------------ */

console.log('\n— the layer with no effect, and the half-configured hook —');
{
  /**
   * `createLayer(l.effect || 'fill')` covers a layer with no `effect` key. It
   * does not cover one whose `effect` is null, because the spread that follows
   * puts the null straight back. The registry answers null for that, the
   * renderer skips the layer, and the layer list goes on saying it is on: the
   * one failure mode with no message anywhere.
   */
  const project = migrated({
    layers: [
      { id: 'a' },
      { id: 'b', effect: null },
      { id: 'c', effect: '' },
      { id: 'd', effect: 'snow' },
    ],
  });
  ok('every layer comes out with an effect the registry can look up',
    project.layers.every((l) => typeof l.effect === 'string' && l.effect.length > 0),
    project.layers.map((l) => `${l.id}:${l.effect}`).join(' '));
  ok('and one that named an effect keeps it', project.layers[3].effect === 'snow');
  ok('with its parameters and bindings present even when the file had neither',
    project.layers.every((l) => l.params && l.bindings));
}

{
  /**
   * A trigger saved with one hook configured used to carry only that one: the
   * spread replaces `http` wholesale rather than filling the gap. The
   * inspector rebuilds the missing half when you open it, which means the hole
   * is invisible right up until somebody fires the trigger without having
   * opened it.
   */
  const project = migrated({
    triggers: [
      { id: 't1', http: { before: { url: 'http://wled.local/on' } } },
      { id: 't2', http: {} },
      { id: 't3' },
    ],
  });
  for (const trigger of project.triggers) {
    ok(`${trigger.id} has both hooks`,
      typeof trigger.http?.before?.url === 'string' && typeof trigger.http?.after?.url === 'string',
      JSON.stringify(trigger.http));
  }
  ok('the half that was configured is the half that survives',
    project.triggers[0].http.before.url === 'http://wled.local/on');
  ok('and the half that was not gets the defaults',
    project.triggers[0].http.after.method === 'GET' && project.triggers[0].http.after.mode === 'no-cors');
  ok('the watch region is filled in the same way',
    project.triggers[1].region.w === 0.5 && project.triggers[1].region.h === 0.45);
}

/* ------------------------------------------------------------------ *
 * The two matrices, which are worse than useless half-applied
 * ------------------------------------------------------------------ */

console.log('\n— a rectification and a scan without their maths —');
{
  const noMatrix = migrated({ rectify: { enabled: true, H: null } });
  ok('a rectification with no matrix is switched off rather than half applied',
    noMatrix.rectify.enabled === false && noMatrix.rectify.H === null);

  const shortMatrix = migrated({ rectify: { enabled: true, H: [1, 0, 0, 0, 1, 0] } });
  ok('and so is one with the wrong number of numbers in it',
    shortMatrix.rectify.enabled === false);

  const good = migrated({ rectify: { enabled: true, H: [1, 0, 0, 0, 1, 0, 0, 0, 1], worldAspect: 2 } });
  ok('a solved one is kept', good.rectify.enabled === true && good.rectify.H.length === 9);
  ok('and world space follows it', worldSize(good).aspect === 2);

  const scan = migrated({ scan: { enabled: true, H: [1, 0, 0, 0, 1, 0, 0, 0, 1], w: 0, h: 0 } });
  ok('a scan with no size behind it is switched off', scan.scan.enabled === false);
}

/* ------------------------------------------------------------------ *
 * What comes out is what the rest of the app is written against
 * ------------------------------------------------------------------ */

console.log('\n— and the result is usable —');
{
  const project = migrated({
    shapes: [
      { id: 'w1', points: [{ x: 0, y: 0 }, { x: 0.2, y: 0 }, { x: 0.2, y: 0.2 }], tags: ['Window'] },
      { id: 'w2', points: [{ x: 0.3, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 0.2 }], tags: ['window'] },
      { id: 'd1', points: [{ x: 0.6, y: 0 }, { x: 0.8, y: 0 }, { x: 0.8, y: 0.2 }], tags: ['door'], visible: false },
    ],
    layers: [{ id: 'l1', effect: 'fill', targetTags: ['window'] }],
  });
  const targets = resolveTargets(project, project.layers[0]);
  ok('a tag filter matches whatever case the tag was typed in',
    targets.map((s) => s.id).join(',') === 'w1,w2', targets.map((s) => s.id).join(','));

  const both = resolveTargets(project, { targets: ['w1'], targetTags: ['window'] });
  ok('and a shape named twice is only resolved once', both.length === 2);
  ok('a hidden shape is never a target',
    resolveTargets(project, { targetTags: ['door'] }).length === 0);
}

{
  const project = migrated({ worldAspect: 0 });
  ok('a world with no aspect ratio falls back to 16:9 rather than dividing by nothing',
    Math.abs(worldSize(project).aspect - 16 / 9) < 1e-9);
  ok('and has a height a canvas can be', worldSize(project).h > 0);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
