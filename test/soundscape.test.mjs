/**
 * The sound the house makes.
 *
 * Two halves, and only one of them can be tested without ears. The synthesis is
 * a graph of Web Audio nodes and whether it sounds like water is a judgement
 * call made standing in a garden. What *can* be pinned down is everything
 * around it, and it is the half that fails silently:
 *
 *   - every effect mapped to a voice is mapped to a voice that exists, so a
 *     typo in the table is not a layer that is quietly mute all evening;
 *   - the plan follows what is on the wall — a disabled layer, a layer faded
 *     out by a crossfade, and a blacked-out show are all silent;
 *   - two layers asking for one voice play it once, because two copies of a
 *     noise bed is not twice the water, it is mud;
 *   - the mixer builds, retunes and drops exactly what the plan says, which is
 *     checkable against a stub context that records what it was asked for.
 *
 *   node test/soundscape.test.mjs
 */

import {
  VOICES,
  VOICE_OPTIONS,
  VOICE_FOR_EFFECT,
  voiceForLayer,
  planSoundscape,
  soundOwners,
  soundFaders,
  createSoundscape,
} from '../js/core/soundscape.js';
import { listEffects, getEffect } from '../js/effects/registry.js';
import { createProject, createLayer, migrateProject } from '../js/core/state.js';
import { PRESETS, applyPreset } from '../js/control/presets.js';
import { baseParams } from '../js/core/modulators.js';

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

/* ------------------------------------------------------------------ *
 * The table
 * ------------------------------------------------------------------ */

console.log('— which effect sounds like what —');

{
  const bad = Object.entries(VOICE_FOR_EFFECT)
    .filter(([, voice]) => voice !== null && !VOICES.has(voice))
    .map(([id, voice]) => `${id} -> ${voice}`);
  ok('every mapped voice exists', bad.length === 0, bad.join(', '));

  const known = new Set(listEffects().map((e) => e.id));
  const ghosts = Object.keys(VOICE_FOR_EFFECT).filter((id) => !known.has(id));
  ok('and every effect named in the table is a real effect', ghosts.length === 0, ghosts.join(', '));

  ok('the picker offers every voice', VOICE_OPTIONS.length === VOICES.size,
    `${VOICE_OPTIONS.length} of ${VOICES.size}`);
  ok('and each has a name somebody could pick from a list',
    VOICE_OPTIONS.every((v) => typeof v.name === 'string' && v.name.length > 2));

  /**
   * The examples that started this off. Named individually rather than counted,
   * because "twelve voices exist" would still pass with the wrong twelve.
   */
  for (const [effect, expected] of [
    ['waterline', 'water'],
    ['web', 'crawl'],
    ['breach', 'writhe'],
    ['lightning', 'thunder'],
    ['bonfire', 'fire'],
    ['rain', 'rain'],
    ['bats', 'wings'],
    ['neon', 'hum'],
  ]) {
    ok(`${effect} sounds like ${expected}`,
      voiceForLayer({}, getEffect(effect)) === expected,
      String(voiceForLayer({}, getEffect(effect))));
  }

  /**
   * And most of the library is silent, which is the part that needs saying.
   * A show where every layer makes a noise is not atmospheric, it is a mess —
   * five underwater effects share one water voice rather than each adding its
   * own lapping.
   */
  const sounding = listEffects().filter((e) => voiceForLayer({}, e));
  ok('most effects make no sound at all', sounding.length < listEffects().length * 0.5,
    `${sounding.length} of ${listEffects().length} have a voice`);
}

{
  ok('a layer can be silenced', voiceForLayer({ sound: 'none' }, getEffect('waterline')) === null);
  ok('and can be given a voice that is not its own',
    voiceForLayer({ sound: 'thunder' }, getEffect('waterline')) === 'thunder');
  ok('a voice that does not exist is silence, not a crash',
    voiceForLayer({ sound: 'kazoo' }, getEffect('waterline')) === null);
  ok('an effect may declare its own, and it wins',
    voiceForLayer({}, { id: 'waterline', sound: 'chime' }) === 'chime');
  ok('an unknown effect is silent', voiceForLayer({}, undefined) === null);
}

/* ------------------------------------------------------------------ *
 * The plan
 * ------------------------------------------------------------------ */

console.log('\n— what should be playing —');

const layer = (effect, extra = {}) => ({ ...createLayer(effect), ...extra });

{
  const plan = planSoundscape(
    [layer('waterline'), layer('web'), layer('kelp'), layer('shoal')],
    getEffect
  );
  const voices = plan.map((p) => p.voice).sort();
  ok('the layers that have a voice play, and the rest do not',
    voices.join(',') === 'crawl,water', voices.join(','));
}

{
  ok('a layer switched off is silent',
    planSoundscape([layer('waterline', { enabled: false })], getEffect).length === 0);

  /**
   * Faded out by a crossfade, too. The plan multiplies by opacity, so a scene
   * change fades what you hear along with what you see and nobody has to wire
   * that up per layer.
   */
  const half = planSoundscape([layer('waterline', { opacity: 0.5 })], getEffect);
  ok('and one faded half way is half as loud', Math.abs(half[0].level - 0.5) < 1e-9,
    half[0].level.toFixed(3));
  ok('and one faded to nothing is not playing at all',
    planSoundscape([layer('waterline', { opacity: 0 })], getEffect).length === 0);
  ok('its own level counts too',
    Math.abs(planSoundscape([layer('waterline', { soundLevel: 0.25 })], getEffect)[0].level - 0.25) < 1e-9);
  ok('and a blackout silences the lot',
    planSoundscape([layer('waterline'), layer('web')], getEffect, { master: 0 }).length === 0);
}

{
  /**
   * Two layers, one voice, one instance. A show with a preset applied twice —
   * or simply a waterline and the caustics that go with it — must not stack
   * two beds of the same noise.
   *
   * The *first* of them plays it, not the loudest. Ownership decided by level
   * moves from layer to layer as the faders do, which makes a volume slider
   * that changes which slider is live — see `soundOwners`.
   */
  const first = layer('waterline', { soundLevel: 0.3 });
  const second = layer('caustics', { soundLevel: 0.9 });
  const plan = planSoundscape([first, second], getEffect);
  ok('two layers wanting the same voice play it once', plan.length === 1, `${plan.length}`);
  ok('and it is the first of them that plays it', plan[0].layerId === first.id);
  ok('at its own level, not the other one\'s', Math.abs(plan[0].level - 0.3) < 1e-9,
    plan[0].level.toFixed(2));

  const owners = soundOwners([first, second], getEffect);
  ok('so only one of the two gets a fader', owners.size === 1 && owners.get(first.id) === 'water',
    [...owners].map(([id, v]) => `${id}=${v}`).join(' '));

  /**
   * Unless the first is faded to nothing — then it hands the voice on rather
   * than taking the show silent with it, which is what keeps a crossfade
   * between two scenes that both contain water lapping the whole way through.
   */
  const muted = layer('waterline', { soundLevel: 0 });
  const handed = planSoundscape([muted, second], getEffect);
  ok('a layer faded to nothing hands its voice to the next one',
    handed.length === 1 && handed[0].layerId === second.id,
    handed.map((h) => h.layerId).join(','));

  /**
   * A layer switched off keeps its fader, as long as nothing else has taken
   * the voice — setting the level of a layer you are about to switch on is the
   * whole point of the fader, and a control that disappears when you turn the
   * layer off is one you cannot set up in daylight.
   */
  const off = layer('waterline', { enabled: false });
  ok('a layer switched off keeps its fader', soundFaders([off], getEffect).get(off.id) === 'water');
  ok('but not when another layer has the voice',
    soundFaders([layer('caustics'), off], getEffect).get(off.id) === undefined);
  ok('and it is not playing either way', planSoundscape([off], getEffect).length === 0);

  /**
   * The case that started this: a scene should not ask for one sound several
   * times over. Every preset in the app, checked, because the table is easy to
   * add to and this is the failure you only hear standing outside.
   */
  for (const preset of PRESETS) {
    const project = createProject();
    applyPreset(project, preset.id);
    const voices = planSoundscape(project.layers, getEffect).map((p) => p.voice);
    ok(`${preset.id} asks for each sound once`, new Set(voices).size === voices.length,
      voices.join(','));
  }
}

{
  // A project loaded from before any of this existed must not be silent-by-
  // absence or crash on a missing field.
  const project = createProject('old');
  project.layers = [{ id: 'l1', effect: 'waterline', enabled: true }];
  const loaded = migrateProject(JSON.parse(JSON.stringify(project)));
  ok('a show saved before sound existed still gets it',
    loaded.layers[0].sound === 'auto' && loaded.layers[0].soundLevel === 1,
    `${loaded.layers[0].sound} / ${loaded.layers[0].soundLevel}`);
  ok('and its settings come with the ambience off',
    loaded.settings.soundEnabled === false && loaded.settings.soundMaster === 0.7);
}

/* ------------------------------------------------------------------ *
 * The mixer
 * ------------------------------------------------------------------ */

console.log('\n— building, retuning and dropping —');

/**
 * Enough of a Web Audio context to build every voice against.
 *
 * Not a mock of a few methods the voices happen to use: a stub that answers
 * everything, so a voice added later is exercised by this file without anybody
 * remembering to come back. `started` and `stopped` are what the assertions
 * are made of.
 */
function stubContext() {
  const log = { built: [], started: 0, startedAt: [], stopped: 0 };
  const param = () => ({
    value: 0,
    setValueAtTime() {},
    setTargetAtTime() {},
    exponentialRampToValueAtTime() {},
    linearRampToValueAtTime() {},
    cancelScheduledValues() {},
  });
  const node = (kind) => {
    log.built.push(kind);
    const self = {
      kind,
      frequency: param(),
      detune: param(),
      Q: param(),
      gain: param(),
      type: '',
      buffer: null,
      loop: false,
      connect: (to) => to,
      disconnect() {},
      start(when = 0) { log.started++; log.startedAt.push(when); },
      stop() { log.stopped++; },
    };
    return self;
  };
  return {
    log,
    // Real contexts suspend and resume, and `running` is read off this — a stub
    // that is permanently 'running' would be testing itself.
    state: 'suspended',
    currentTime: 0,
    sampleRate: 48000,
    destination: node('destination'),
    createGain: () => node('gain'),
    createOscillator: () => node('oscillator'),
    createBiquadFilter: () => node('filter'),
    createBufferSource: () => node('source'),
    createBuffer: (channels, length) => ({
      length,
      getChannelData: () => new Float32Array(length),
    }),
    resume() {
      this.state = 'running';
      return Promise.resolve();
    },
    suspend() {
      this.state = 'suspended';
      return Promise.resolve();
    },
  };
}

{
  // Every voice, built and scheduled, against the stub. A voice that throws on
  // build is a layer that is silent for the whole evening with a line in a
  // console nobody is looking at.
  let broke = '';
  for (const [id, voice] of VOICES) {
    const ctx = stubContext();
    try {
      const out = ctx.createGain();
      const instance = voice.build(ctx, out);
      // Twice, because a voice that queues events has to cope with being asked
      // again for a window it has already filled.
      instance.schedule?.(0.5);
      instance.schedule?.(1.2);
      instance.stop?.();
    } catch (err) {
      broke = `${id}: ${err.message}`;
      break;
    }
  }
  ok('every voice builds, schedules and stops', !broke, broke || `${VOICES.size} voices`);
}

{
  const ctx = stubContext();
  const scape = createSoundscape({ createContext: () => ctx });
  await scape.start();

  scape.sync([{ voice: 'water', level: 0.8, name: 'The water' }]);
  ok('the mixer starts what the plan asks for',
    scape.voices().map((v) => v.voice).join(',') === 'water',
    scape.voices().map((v) => v.voice).join(','));

  scape.sync([
    { voice: 'water', level: 0.4, name: 'The water' },
    { voice: 'crawl', level: 1, name: 'Web' },
  ]);
  const now = scape.voices();
  ok('adds one without rebuilding the other',
    now.length === 2 && now.find((v) => v.voice === 'water')?.level === 0.4,
    now.map((v) => `${v.voice}@${v.level}`).join(' '));

  scape.sync([{ voice: 'crawl', level: 1, name: 'Web' }]);
  ok('and drops what is no longer wanted',
    scape.voices().map((v) => v.voice).join(',') === 'crawl',
    scape.voices().map((v) => v.voice).join(','));

  scape.sync([]);
  ok('an empty plan is silence', scape.voices().length === 0);

  scape.stop();
  ok('and stopping leaves nothing running', scape.voices().length === 0 && !scape.running);
}

{
  // The one that matters on the night: a voice that throws must not take the
  // rest of the show's sound with it.
  const ctx = stubContext();
  const scape = createSoundscape({ createContext: () => ctx });
  await scape.start();
  const water = VOICES.get('water');
  const build = water.build;
  water.build = () => {
    throw new Error('deliberate');
  };
  try {
    scape.sync([
      { voice: 'water', level: 1, name: 'bad' },
      { voice: 'crawl', level: 1, name: 'good' },
    ]);
    ok('a voice that fails to build does not silence the others',
      scape.voices().map((v) => v.voice).join(',') === 'crawl',
      scape.voices().map((v) => v.voice).join(','));
  } finally {
    water.build = build;
    scape.stop();
  }
}

/* ------------------------------------------------------------------ *
 * Cues
 * ------------------------------------------------------------------ */

console.log('\n— sounds cued from the picture —');

/**
 * Every effect that declares `cues`, against the contract, rather than the two
 * that exist today named individually. The contract is easy to get subtly
 * wrong — an event emitted at both ends of adjacent windows is a stutter, one
 * missed at a boundary is a silent flash — and the failure is inaudible until
 * somebody is standing in the garden.
 */
{
  const cueing = listEffects()
    .map((e) => getEffect(e.id))
    .filter((e) => typeof e.cues === 'function');

  ok('at least the effects that bang have a cue hook', cueing.length >= 2,
    cueing.map((e) => e.id).join(', '));

  for (const effect of cueing) {
    const p = baseParams(effect, createLayer(effect.id));
    const span = 240;
    const all = effect.cues(p, 0, span);

    ok(`${effect.id}: says when it is going to be loud`, Array.isArray(all) && all.length > 0,
      `${all.length} in ${span}s`);
    ok(`${effect.id}: every event inside the window it was asked for`,
      all.every((e) => e.at >= 0 && e.at < span && Number.isFinite(e.at)));
    ok(`${effect.id}: in order`, all.every((e, i) => i === 0 || e.at >= all[i - 1].at));
    ok(`${effect.id}: with a level between none and all of it`,
      all.every((e) => e.level === undefined || (e.level > 0 && e.level <= 1)));

    /**
     * The one that matters. The control tab asks in short windows, one per
     * frame, and the union of those must be exactly what one long ask gives.
     */
    const sliced = [];
    for (let at = 0; at < span; at += 0.4) sliced.push(...effect.cues(p, at, at + 0.4));
    ok(`${effect.id}: asked frame by frame, exactly the same events`,
      sliced.length === all.length && sliced.every((e, i) => Math.abs(e.at - all[i].at) < 1e-9),
      `${sliced.length} sliced vs ${all.length} whole`);

    // And at a frame rate that is struggling, which is when a show is at its
    // most demanding and least able to afford a dropped bang. Windows clamped
    // to the span, or the last one reaches past the end and legitimately finds
    // an event the single long ask never asked for.
    const coarse = [];
    for (let at = 0; at < span; at += 1.7) coarse.push(...effect.cues(p, at, Math.min(at + 1.7, span)));
    ok(`${effect.id}: and on a stuttering frame rate`,
      coarse.length === all.length, `${coarse.length} vs ${all.length}`);
  }
}

{
  const lightning = getEffect('lightning');
  const p = baseParams(lightning, createLayer('lightning'));
  const strikes = lightning.cues(p, 0, 600);
  ok('lightning claps as often as it flashes',
    Math.abs(strikes.length - (600 * p.rate) / 60) <= 1,
    `${strikes.length} in 600s at ${p.rate}/min`);
  ok('and every strike is a distinct instant',
    new Set(strikes.map((e) => e.at)).size === strikes.length);
}

{
  /**
   * A shell is two events, and the gap between them is the shell going up. If
   * that drifts from the picture the bang belongs to a different firework.
   */
  const fireworks = getEffect('fireworks');
  const p = baseParams(fireworks, createLayer('fireworks'));
  const events = fireworks.cues(p, 0, 120);
  const rises = events.filter((e) => e.kind === 'rise');
  const bangs = events.filter((e) => e.kind === 'burst');
  // One more launch than break, always: the last shell of the window is still
  // in the air when the window ends, and its bang belongs to the next one.
  ok('every shell that breaks was heard going up first',
    bangs.every((b) => rises.some((r) => Math.abs(b.at - r.at - 0.9) < 1e-9)),
    `${rises.length} up, ${bangs.length} down`);
  ok('and none of them breaks twice', new Set(bangs.map((b) => b.at)).size === bangs.length);
  ok('a shell with no visible trail is silent on the way up',
    fireworks.cues({ ...p, trail: false }, 0, 120).every((e) => e.kind === 'burst'));
}

{
  const ctx = stubContext();
  const scape = createSoundscape({ createContext: () => ctx });
  await scape.start();
  scape.sync([{ voice: 'thunder', level: 1, name: 'Storm' }]);

  ctx.currentTime = 10;
  ctx.log.startedAt.length = 0;
  scape.cue('thunder', { in: 0.25, level: 1, distance: 0 });
  ok('a cued clap is scheduled, not fired on the spot', ctx.log.startedAt.length > 0);
  ok('and every part of it lands on the instant it was given, to the sample',
    ctx.log.startedAt.every((at) => Math.abs(at - 10.25) < 0.01),
    ctx.log.startedAt.map((n) => n.toFixed(3)).join(' '));

  ok('and it says so, so a caller can count sounds rather than intentions',
    scape.cue('thunder', { in: 0.1 }) === true);
  ok('cueing a voice that is not playing is a no-op, and says so',
    scape.cue('water', { in: 0.1 }) === false);
  scape.stop();
  ok('as is cueing anything at all once the sound is off',
    scape.cue('thunder', { in: 0.1 }) === false);
}

{
  /**
   * The firework voice has no timetable of its own at all — it exists only to
   * be cued — so the thing to check is that a bang starts where it was put and
   * the sizzle after it does not run on past the picture.
   */
  const ctx = stubContext();
  ctx.state = 'running';
  ctx.currentTime = 5;
  const out = ctx.createGain();
  const shells = VOICES.get('firework').build(ctx, out);
  ok('the firework voice runs on cues alone', typeof shells.schedule !== 'function');

  ctx.log.startedAt.length = 0;
  shells.cue(6, { kind: 'burst', level: 1 });
  const at = ctx.log.startedAt;
  ok('a break starts on its instant', Math.min(...at) >= 6 - 1e-9, `${Math.min(...at)}`);
  // Bounded, so that at 240 shells a minute they do not pile into a hiss.
  ok('and its sizzle has died inside a second and a bit', Math.max(...at) < 7.1,
    `${(Math.max(...at) - 6).toFixed(2)}s tail`);

  ctx.log.startedAt.length = 0;
  shells.cue(9, { kind: 'rise', duration: 0.9, level: 1 });
  ok('a launch is heard going up, not banging', ctx.log.startedAt.length > 0 &&
    Math.min(...ctx.log.startedAt) >= 9 - 1e-9);
}

{
  /**
   * And having been cued, thunder stops inventing storms of its own. Two of
   * them, one attached to nothing you can see, is worse than none — but a
   * thunder voice with no lightning driving it still has to rumble, or a layer
   * somebody wired up by hand goes silent for the evening.
   */
  const ctx = stubContext();
  ctx.state = 'running';
  const out = ctx.createGain();
  const storm = VOICES.get('thunder').build(ctx, out);

  const run = (from, to, step = 0.3) => {
    ctx.log.startedAt.length = 0;
    for (ctx.currentTime = from; ctx.currentTime < to; ctx.currentTime += step) {
      storm.schedule(ctx.currentTime + 0.35);
    }
    return ctx.log.startedAt.length;
  };

  ok('left to itself, thunder rumbles', run(0, 60) > 0);
  storm.cue(ctx.currentTime + 0.2, { level: 1, distance: 0 });
  ok('once something is cueing it, it adds nothing of its own', run(ctx.currentTime, ctx.currentTime + 30) === 0);
  ok('and it picks up again when the lightning goes away',
    run(ctx.currentTime + 60, ctx.currentTime + 180) > 0);
}


console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
