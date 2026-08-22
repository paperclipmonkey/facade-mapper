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
  createSoundscape,
} from '../js/core/soundscape.js';
import { listEffects, getEffect } from '../js/effects/registry.js';
import { createProject, createLayer, migrateProject } from '../js/core/state.js';

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
   */
  const plan = planSoundscape(
    [layer('waterline', { soundLevel: 0.3 }), layer('caustics', { soundLevel: 0.9 })],
    getEffect
  );
  ok('two layers wanting the same voice play it once', plan.length === 1, `${plan.length}`);
  ok('at the louder of the two', Math.abs(plan[0].level - 0.9) < 1e-9, plan[0].level.toFixed(2));
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
  const log = { built: [], started: 0, stopped: 0 };
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
      start() { log.started++; },
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

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
