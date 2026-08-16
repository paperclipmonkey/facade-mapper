/**
 * One-shot effects, and the loop that makes them repeatable.
 *
 * The interesting thing about a burst is not how it draws, it is that it starts
 * when something happens and can start again. That runs through four pieces
 * that know nothing about each other — a trigger, a scene, the layer's enabled
 * flag, and `ctx.age` — so the test drives the whole chain rather than the
 * effect alone.
 *
 *   node test/bursts.test.mjs
 */

import { getEffect, defaultParams } from '../js/effects/registry.js';
import { boundingBox, buildPathSampler, makeRng } from '../js/core/math.js';
import { defaultNoise } from '../js/core/noise.js';
import { createProject } from '../js/core/state.js';
import { addDemoBursts, DEMO_BURSTS } from '../js/control/presets.js';
import { effectiveLayers } from '../js/core/scenes.js';
import { RESERVED_KEYS } from '../js/core/state.js';

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

function recordingContext() {
  const calls = [];
  const ctx = {
    calls, fillStyle: '', strokeStyle: '', globalAlpha: 1, globalCompositeOperation: 's',
    lineWidth: 1, lineCap: '', lineJoin: '',
    save() {}, restore() {}, clip() {}, translate() {}, rotate() {}, scale() {},
    setTransform() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    quadraticCurveTo() {}, bezierCurveTo() {}, rect() {}, fillRect() {}, strokeRect() {},
    arc() { calls.push('arc'); }, ellipse() { calls.push('ellipse'); },
    fill() { calls.push('fill'); }, stroke() { calls.push('stroke'); },
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
  };
  return ctx;
}

const pts = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 400 }, { x: 0, y: 400 }];
const shape = {
  id: 'door', name: 'door', tags: ['door'], closed: true, points: pts, path: {},
  bbox: boundingBox(pts), centroid: boundingBox(pts), sampler: buildPathSampler(pts, true),
};

/** Draw one burst at a given age and report how much it put on the canvas. */
function drawAt(effect, p, age, state, rng) {
  const g = recordingContext();
  effect.draw({
    g, p, stable: p, shape, shapes: () => [], age,
    t: age, dt: 1 / 60, rng, state, noise: defaultNoise,
    i: 0, n: 1, beat: 0, beatPhase: 0, bpm: 120,
    audio: { level: 0, low: 0, mid: 0, high: 0 },
  });
  return g.calls.length;
}

console.log('— they happen once —');

for (const id of ['bat-burst', 'shockwave', 'spark-burst']) {
  const effect = getEffect(id);
  ok(`${id} is registered`, Boolean(effect));
  const p = { ...defaultParams(id) };
  const state = effect.init ? effect.init() : {};
  const rng = makeRng(id);

  ok(`${id} draws nothing before it starts`, drawAt(effect, p, -0.5, state, rng) === 0);
  const early = drawAt(effect, p, p.duration * 0.25, state, rng);
  ok(`${id} draws while it is playing`, early > 0, `${early} operations`);
  ok(`${id} draws nothing once it is over`,
    drawAt(effect, p, p.duration + 0.5, state, rng) === 0);

  /**
   * And it starts again. A retrigger reaches the effect as the age going
   * backwards — the layer was switched off and on, and the clock restarted —
   * which has to produce a fresh cast rather than the tail of the last one.
   */
  const after = drawAt(effect, p, p.duration * 0.25, state, rng);
  ok(`${id} plays again when the clock restarts`, after > 0, `${after} operations`);
}

console.log('\n— the chain from key to burst —');

{
  const project = createProject('t');
  project.shapes = [{ ...shape, id: 'door', tags: ['door'] }];
  const added = addDemoBursts(project);

  ok('every demo burst is wired up', added.length === DEMO_BURSTS.length);
  ok('each has a key', added.every((a) => a.key));
  ok('the keys are all different', new Set(added.map((a) => a.key)).size === added.length,
    added.map((a) => a.key).join(', '));

  /**
   * And none of them is one the editor has already taken. The first draft used
   * B for bats, which is Blackout — the editor's handler runs first and does
   * not fall through, so pressing it blacked the show out and never reached the
   * trigger. It looked configured and did nothing.
   */
  const clash = added.filter((a) => RESERVED_KEYS[a.key]);
  ok('and none is a key the editor already uses', clash.length === 0,
    clash.map((a) => `${a.key} = ${RESERVED_KEYS[a.key]}`).join(', '));

  const burstLayers = project.layers.filter((l) => DEMO_BURSTS.some((b) => b.effect === l.effect));
  ok('the layers are off in the authored show', burstLayers.every((l) => l.enabled === false));

  // Nothing playing: every burst layer is filtered out of the render.
  const idle = effectiveLayers(project).filter((l) => l.enabled !== false);
  ok('so nothing bursts on its own', !idle.some((l) => burstLayers.includes(l)));

  // Fire the first trigger's scene.
  const trigger = project.triggers[0];
  const scene = project.scenes.find((s) => s.id === trigger.sceneId);
  project.show.activeScene = scene.id;
  project.show.sceneChangeAt = Date.now();
  project.show.fade = 0;
  const live = effectiveLayers(project).filter((l) => l.enabled !== false);

  ok('firing the scene switches its burst on',
    live.some((l) => l.id === burstLayers[0].id));

  /**
   * And only its own. A scene built by hand names one layer; a captured one
   * would freeze the whole show as it happened to be at that moment, so firing
   * a burst mid-evening would silently revert everything else with it.
   */
  ok('and changes nothing else', Object.keys(scene.state).length === 1);

  // The hold ends and the show goes back to what it was doing.
  project.show.activeScene = null;
  const back = effectiveLayers(project).filter((l) => l.enabled !== false);
  ok('and it goes away again afterwards', !back.some((l) => burstLayers.includes(l)));
}

console.log(failures ? `\n${failures} failing` : '\nall good');
process.exit(failures ? 1 : 0);
