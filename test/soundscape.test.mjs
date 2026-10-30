/**
 * The sound the house makes.
 *
 * Two halves, and only one of them can be tested without ears. Whether a
 * recording of somebody squeezing a ball of slime, pitched down and overlapped
 * three deep, sounds like a tentacle is a judgement call made standing in a
 * garden. What *can* be pinned down is everything around it, and it is the
 * half that fails silently:
 *
 *   - every clip a voice asks for is a file that exists, because a typo in a
 *     filename is a voice that is mute all evening with one line in a console
 *     nobody is looking at;
 *   - every effect mapped to a voice is mapped to a voice that exists;
 *   - the plan follows what is on the wall — a disabled layer, a layer faded
 *     out by a crossfade, and a blacked-out show are all silent;
 *   - two layers asking for one voice play it once, because two copies of a
 *     wall coming down is not twice the wall, it is mud;
 *   - the mixer builds, retunes and drops exactly what the plan says, which is
 *     checkable against a stub context that records what it was asked for;
 *   - a clap lands on the sample it was given, codec padding and all.
 *
 *   node test/soundscape.test.mjs
 */

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CLIPS,
  VOICES,
  VOICE_OPTIONS,
  VOICE_FOR_EFFECT,
  loadClips,
  voicesForLayer,
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
 * The library on disk
 * ------------------------------------------------------------------ */

console.log('— the clips —');

{
  const dir = fileURLToPath(new URL('../audio/', import.meta.url));
  const files = new Set(readdirSync(dir));
  const missing = CLIPS.filter((name) => !files.has(`${name}.mp3`));
  ok('every clip a voice asks for is on disk', missing.length === 0, missing.join(', '));

  const spare = [...files].filter((f) => f.endsWith('.mp3') && !CLIPS.includes(f.replace(/\.mp3$/, '')));
  ok('and nothing is shipped that nothing plays', spare.length === 0, spare.join(', '));

  ok('the sources are written down', files.has('CREDITS.md'));
}

/* ------------------------------------------------------------------ *
 * Which effect sounds like what
 * ------------------------------------------------------------------ */

console.log('\n— which effect sounds like what —');

{
  const bad = Object.entries(VOICE_FOR_EFFECT)
    .filter(([, v]) => v !== null && ![].concat(v).every((id) => VOICES.has(id)))
    .map(([id, v]) => `${id} -> ${v}`);
  ok('every mapped voice exists', bad.length === 0, bad.join(', '));

  const known = new Set(listEffects().map((e) => e.id));
  const ghosts = Object.keys(VOICE_FOR_EFFECT).filter((id) => !known.has(id));
  ok('and every effect named in the table is a real effect', ghosts.length === 0, ghosts.join(', '));

  ok('the picker offers every voice', VOICE_OPTIONS.length === VOICES.size,
    `${VOICE_OPTIONS.length} of ${VOICES.size}`);
  ok('and each has a name somebody could pick from a list',
    VOICE_OPTIONS.every((v) => typeof v.name === 'string' && v.name.length > 2));

  /**
   * Named individually rather than counted, because "three voices exist" would
   * still pass with the wrong three.
   */
  for (const [effect, expected] of [
    ['lightning', 'thunder'],
    // Both, and this is the one that needs a test of its own: Breach draws a
    // wall coming apart *and* something reaching out through the hole, and
    // giving it only the bricks left the tentacles silent on screen.
    ['breach', 'bricks,writhe'],
    ['portal', 'writhe'],
    ['serpent', 'writhe'],
  ]) {
    ok(`${effect} sounds like ${expected}`,
      voicesForLayer({}, getEffect(effect)).join(',') === expected,
      voicesForLayer({}, getEffect(effect)).join(','));
  }

  /**
   * And nearly all of the library is silent, which is the part that needs
   * saying. The app used to have thirteen synthesised voices spread over sixty
   * effects, and the result was a show where everything made a noise and none
   * of it was any good.
   */
  const sounding = listEffects().filter((e) => voicesForLayer({}, e).length);
  ok('nearly every effect makes no sound at all', sounding.length <= 6,
    `${sounding.length} of ${listEffects().length} have a voice`);

  for (const gone of ['water', 'crawl', 'fire', 'firework', 'rain', 'wind', 'chime', 'hum']) {
    ok(`the synthesised ${gone} voice is gone`, !VOICES.has(gone));
  }
}

{
  const only = (layer, effect) => voicesForLayer(layer, effect).join(',');
  ok('a layer can be silenced', only({ sound: 'none' }, getEffect('lightning')) === '');
  ok('and can be given a voice that is not its own',
    only({ sound: 'writhe' }, getEffect('lightning')) === 'writhe');
  // Which is also how you take half of a Breach away: one voice, not the pair.
  ok('and pointing one at a single voice drops the rest',
    only({ sound: 'writhe' }, getEffect('breach')) === 'writhe');
  ok('a voice that does not exist is silence, not a crash',
    only({ sound: 'kazoo' }, getEffect('lightning')) === '');
  /**
   * Including the ones that used to. A show saved when `fire` was a voice
   * loads, draws and is simply quiet on that layer, rather than throwing on
   * open or mapping itself onto whatever happens to be nearby.
   */
  ok('and neither is one that was retired',
    only({ sound: 'water' }, getEffect('lightning')) === '');
  ok('an effect may declare its own, and it wins',
    only({}, { id: 'lightning', sound: 'writhe' }) === 'writhe');
  ok('and may declare several', only({}, { id: 'x', sound: ['thunder', 'writhe'] }) === 'thunder,writhe');
  ok('an unknown effect is silent', only({}, undefined) === '');
}

/* ------------------------------------------------------------------ *
 * The plan
 * ------------------------------------------------------------------ */

console.log('\n— what should be playing —');

const layer = (effect, extra = {}) => ({ ...createLayer(effect), ...extra });

{
  const plan = planSoundscape(
    [layer('lightning'), layer('breach'), layer('fog'), layer('bats')],
    getEffect
  );
  const voices = plan.map((p) => p.voice).sort();
  ok('the layers that have a voice play, and the rest do not',
    voices.join(',') === 'bricks,thunder,writhe', voices.join(','));
}

{
  ok('a layer switched off is silent',
    planSoundscape([layer('lightning', { enabled: false })], getEffect).length === 0);

  /**
   * Faded out by a crossfade, too. The plan multiplies by opacity, so a scene
   * change fades what you hear along with what you see and nobody has to wire
   * that up per layer.
   */
  const half = planSoundscape([layer('lightning', { opacity: 0.5 })], getEffect);
  ok('and one faded half way is half as loud', Math.abs(half[0].level - 0.5) < 1e-9,
    half[0].level.toFixed(3));
  ok('and one faded to nothing is not playing at all',
    planSoundscape([layer('lightning', { opacity: 0 })], getEffect).length === 0);
  ok('its own level counts too',
    Math.abs(planSoundscape([layer('lightning', { soundLevel: 0.25 })], getEffect)[0].level - 0.25) < 1e-9);
  ok('and a blackout silences the lot',
    planSoundscape([layer('lightning'), layer('breach')], getEffect, { master: 0 }).length === 0);
}

{
  /**
   * Two layers, one voice, one instance. A wall breached in two places — which
   * is what you get the moment somebody duplicates the layer to cover a second
   * elevation — must not stack two copies of the same rubble.
   *
   * The *first* of them plays it, not the loudest. Ownership decided by level
   * moves from layer to layer as the faders do, which makes a volume slider
   * that changes which slider is live — see `soundOwners`.
   */
  const first = layer('portal', { soundLevel: 0.3 });
  const second = layer('serpent', { soundLevel: 0.9 });
  const plan = planSoundscape([first, second], getEffect);
  ok('two layers wanting the same voice play it once', plan.length === 1, `${plan.length}`);
  ok('and it is the first of them that plays it', plan[0].layerId === first.id);
  ok('at its own level, not the other one\'s', Math.abs(plan[0].level - 0.3) < 1e-9,
    plan[0].level.toFixed(2));

  const owners = soundOwners([first, second], getEffect);
  ok('so only one of the two gets a fader',
    owners.size === 1 && owners.get(first.id).join(',') === 'writhe',
    [...owners].map(([id, v]) => `${id}=${v}`).join(' '));

  /**
   * Unless the first is faded to nothing — then it hands the voice on rather
   * than taking the show silent with it, which is what keeps a crossfade
   * between two scenes that both writhe going the whole way through.
   */
  const muted = layer('portal', { soundLevel: 0 });
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
  const off = layer('portal', { enabled: false });
  ok('a layer switched off keeps its fader',
    soundFaders([off], getEffect).get(off.id)?.join(',') === 'writhe');
  ok('but not when another layer has the voice',
    soundFaders([layer('serpent'), off], getEffect).get(off.id) === undefined);
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
  project.layers = [{ id: 'l1', effect: 'lightning', enabled: true }];
  const loaded = migrateProject(JSON.parse(JSON.stringify(project)));
  ok('a show saved before sound existed still gets it',
    loaded.layers[0].sound === 'auto' && loaded.layers[0].soundLevel === 1,
    `${loaded.layers[0].sound} / ${loaded.layers[0].soundLevel}`);
  ok('and its settings come with the ambience off',
    loaded.settings.soundEnabled === false && loaded.settings.soundMaster === 0.7);
}

/* ------------------------------------------------------------------ *
 * The stub, and a library to feed it
 * ------------------------------------------------------------------ */

/**
 * Enough of a Web Audio context to build every voice against.
 *
 * Not a mock of a few methods the voices happen to use: a stub that answers
 * everything, so a voice added later is exercised by this file without anybody
 * remembering to come back. `startedAt` and `offsets` are what most of the
 * assertions below are made of — a sampled voice says everything it has to say
 * in when it starts a buffer and how far into it.
 */
function stubContext() {
  const log = { built: [], started: 0, startedAt: [], offsets: [], played: [], stopped: 0 };
  let tag = 0;
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
    return {
      kind,
      frequency: param(),
      detune: param(),
      playbackRate: param(),
      Q: param(),
      gain: param(),
      type: '',
      buffer: null,
      loop: false,
      connect: (to) => to,
      disconnect() {},
      start(when = 0, offset = 0) {
        log.started++;
        log.startedAt.push(when);
        log.offsets.push(offset);
        // Which recording it was. Tagged at decode, so an assertion can say
        // "the near crack, not the long roll" rather than only "something".
        log.played.push(this.buffer?.tag ?? null);
      },
      stop() { log.stopped++; },
    };
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
    /**
     * A clip with a tenth of a second of nothing on the front, which is what a
     * lossy decoder hands back and what `leadIn` exists to measure.
     */
    decodeAudioData: async () => ({
      tag: tag++,
      sampleRate: 44100,
      length: 44100,
      duration: 1,
      getChannelData: () => {
        const data = new Float32Array(44100);
        for (let i = 4410; i < data.length; i++) data[i] = Math.sin(i * 0.01) * 0.5;
        return data;
      },
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

/** Nothing reaches the network from a test. Every clip "downloads" instantly. */
const served = [];
globalThis.fetch = async (url) => {
  served.push(String(url));
  return { ok: true, arrayBuffer: async () => new ArrayBuffer(64) };
};

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

console.log('\n— fetching and decoding —');

{
  const ctx = stubContext();
  const ready = await loadClips(ctx);
  ok('every clip is fetched once', served.length === CLIPS.length, `${served.length} requests`);
  ok('and they come from the audio folder beside the code',
    served.every((u) => u.includes('/audio/')), served[0]);
  ok('and every one of them decodes', ready.size === CLIPS.length, `${ready.size} ready`);

  const before = served.length;
  await loadClips(ctx);
  ok('asking twice downloads nothing twice', served.length === before);

  /**
   * The silence a decoder pads onto the front, measured so it can be skipped.
   * A tenth of a second of it, less the few samples of run-up `leadIn` leaves
   * so a fast attack keeps its leading edge.
   */
  const lead = ready.get('thunder-crack').lead;
  ok('and the codec padding on the front is measured', Math.abs(lead - 0.0985) < 0.003,
    `${(lead * 1000).toFixed(1)} ms`);
}

{
  const ctx = stubContext();
  const good = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const ready = await loadClips(ctx);
    ok('a missing file is a quieter show, not a broken one', ready.size === 0);
  } finally {
    console.warn = warn;
    globalThis.fetch = good;
  }
}

/* ------------------------------------------------------------------ *
 * The voices
 * ------------------------------------------------------------------ */

console.log('\n— building, retuning and dropping —');

{
  // Every voice, built and scheduled, against the stub — twice, because a voice
  // that queues events has to cope with being asked again for a window it has
  // already filled. Once with no clips at all, which is the first second of
  // every evening while the library is still coming down the wire.
  let broke = '';
  for (const withClips of [false, true]) {
    for (const [id, voice] of VOICES) {
      const ctx = stubContext();
      if (withClips) await loadClips(ctx);
      try {
        const out = ctx.createGain();
        const instance = voice.build(ctx, out);
        instance.schedule?.(0.5);
        instance.schedule?.(1.2);
        instance.cue?.(0.8, { level: 1, distance: 0 });
        instance.stop?.();
      } catch (err) {
        broke = `${id}${withClips ? '' : ' (no clips)'}: ${err.message}`;
        break;
      }
    }
  }
  ok('every voice builds, schedules and stops', !broke, broke || `${VOICES.size} voices`);
}

{
  // And makes no noise at all until its clips have landed. A buffer source with
  // no buffer is a click in some browsers and an exception in others.
  const ctx = stubContext();
  ctx.state = 'running';
  const out = ctx.createGain();
  for (const [, voice] of VOICES) {
    const instance = voice.build(ctx, out);
    for (ctx.currentTime = 0; ctx.currentTime < 60; ctx.currentTime += 0.3) instance.schedule?.(ctx.currentTime + 0.35);
  }
  ok('a voice with nothing loaded yet is simply silent', ctx.log.started === 0, `${ctx.log.started} started`);
}

{
  const ctx = stubContext();
  const scape = createSoundscape({ createContext: () => ctx });
  await scape.start();
  await scape.ready;

  scape.sync([{ voice: 'thunder', level: 0.8, name: 'The storm' }]);
  ok('the mixer starts what the plan asks for',
    scape.voices().map((v) => v.voice).join(',') === 'thunder',
    scape.voices().map((v) => v.voice).join(','));

  scape.sync([
    { voice: 'thunder', level: 0.4, name: 'The storm' },
    { voice: 'bricks', level: 1, name: 'Breach' },
  ]);
  const now = scape.voices();
  ok('adds one without rebuilding the other',
    now.length === 2 && now.find((v) => v.voice === 'thunder')?.level === 0.4,
    now.map((v) => `${v.voice}@${v.level}`).join(' '));

  scape.sync([{ voice: 'bricks', level: 1, name: 'Breach' }]);
  ok('and drops what is no longer wanted',
    scape.voices().map((v) => v.voice).join(',') === 'bricks',
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
  const bricks = VOICES.get('bricks');
  const build = bricks.build;
  bricks.build = () => {
    throw new Error('deliberate');
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    scape.sync([
      { voice: 'bricks', level: 1, name: 'bad' },
      { voice: 'writhe', level: 1, name: 'good' },
    ]);
    ok('a voice that fails to build does not silence the others',
      scape.voices().map((v) => v.voice).join(',') === 'writhe',
      scape.voices().map((v) => v.voice).join(','));
  } finally {
    console.warn = warn;
    bricks.build = build;
    scape.stop();
  }
}

/* ------------------------------------------------------------------ *
 * What the sampled voices actually do
 * ------------------------------------------------------------------ */

console.log('\n— bricks and tentacles —');

/** Which clip a start refers to, by name, using the tags planted at decode. */
async function clipNames(ctx) {
  const ready = await loadClips(ctx);
  const byTag = new Map([...ready].map(([name, clip]) => [clip.buffer.tag, name]));
  return () => ctx.log.played.map((t) => byTag.get(t));
}

{
  /**
   * The wall has no clock of its own any more. It used to invent a burst every
   * few seconds, which is roughly the right *rate* and the wrong *moments* —
   * and the wrong moments is the whole of what somebody standing in front of
   * the house notices.
   */
  const ctx = stubContext();
  ctx.state = 'running';
  const named = await clipNames(ctx);
  const out = ctx.createGain();
  const wall = VOICES.get('bricks').build(ctx, out);

  for (ctx.currentTime = 0; ctx.currentTime < 120; ctx.currentTime += 0.3) wall.schedule?.(ctx.currentTime + 0.35);
  ok('a wall nobody is breaching is silent', ctx.log.started === 0, `${ctx.log.started} started`);

  // Breach drops the bricks of one hole about a fifth of a second apart, then
  // leaves the wall alone. One clip each, and the slide of rubble after.
  ctx.currentTime = 10;
  for (let i = 0; i < 5; i++) wall.cue(10 + i * 0.2, { level: 0.7 });
  wall.cue(11, { kind: 'rubble' });
  const names = named();
  ok('every brick that leaves the wall is heard', names.length === 6, names.join(' '));
  ok('each of them a brick', names.slice(0, 5).every((n) => n.startsWith('brick-')), names.join(' '));
  ok('and the last of them followed by the rubble it loosened',
    names[5].startsWith('rubble-'), names[5]);
  ok('the rubble lands just after the brick, not on it',
    ctx.log.startedAt[5] > 11, ctx.log.startedAt[5].toFixed(3));
  ok('and every brick on the instant it was given',
    ctx.log.startedAt.slice(0, 5).every((at, i) => Math.abs(at - (10 + i * 0.2)) < 1e-9),
    ctx.log.startedAt.slice(0, 5).map((n) => n.toFixed(2)).join(' '));

  /**
   * A Breach pointed at eight windows can drop that many bricks inside one
   * frame, and eight transients inside a twentieth of a second is not eight
   * bricks, it is one thud with a flam on it.
   */
  ctx.log.played.length = 0;
  for (let i = 0; i < 8; i++) wall.cue(20 + i * 0.004, {});
  ok('bricks landing in the same instant are one brick', named().length === 1,
    `${named().length}`);
}

{
  const ctx = stubContext();
  ctx.state = 'running';
  await loadClips(ctx);
  const out = ctx.createGain();
  const arms = VOICES.get('writhe').build(ctx, out);

  for (ctx.currentTime = 0; ctx.currentTime < 60; ctx.currentTime += 0.3) arms.schedule(ctx.currentTime + 0.35);
  const at = ctx.log.startedAt;
  ok('something is always moving', at.length > 25, `${at.length} in a minute`);
  const gaps = at.slice(1).map((v, i) => v - at[i]);
  ok('and it never stops for long', Math.max(...gaps) < 3.5, `longest gap ${Math.max(...gaps).toFixed(2)}s`);
  // The clips are one to five seconds long, so a new one every second or two is
  // two or three of them sounding at once. That overlap is the whole effect.
  ok('closely enough that they lie over each other',
    gaps.reduce((s, g) => s + g, 0) / gaps.length < 2.2,
    `${(gaps.reduce((s, g) => s + g, 0) / gaps.length).toFixed(2)}s apart on average`);
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
  const ctx = stubContext();
  const scape = createSoundscape({ createContext: () => ctx });
  await scape.start();
  await scape.ready;
  scape.sync([{ voice: 'thunder', level: 1, name: 'Storm' }]);

  ctx.currentTime = 10;
  ctx.log.startedAt.length = 0;
  ctx.log.offsets.length = 0;
  scape.cue('thunder', { in: 0.25, level: 1, distance: 0 });
  ok('a cued clap is scheduled, not fired on the spot', ctx.log.startedAt.length > 0);
  ok('and every part of it lands on the instant it was given, to the sample',
    ctx.log.startedAt.every((at) => Math.abs(at - 10.25) < 0.01),
    ctx.log.startedAt.map((n) => n.toFixed(3)).join(' '));
  /**
   * Which is the whole reason the padding is measured at load. Scheduling the
   * buffer at 10.25 and letting it play from zero would put the crack a
   * hundred milliseconds behind its own flash on every browser that pads.
   */
  ok('starting past the decoder\'s silence rather than at the front of the buffer',
    ctx.log.offsets.every((o) => o > 0.09), ctx.log.offsets.map((n) => n.toFixed(4)).join(' '));

  ok('and it says so, so a caller can count sounds rather than intentions',
    scape.cue('thunder', { in: 0.1 }) === true);
  ok('cueing a voice that is not playing is a no-op, and says so',
    scape.cue('bricks', { in: 0.1 }) === false);
  scape.stop();
  ok('as is cueing anything at all once the sound is off',
    scape.cue('thunder', { in: 0.1 }) === false);
}

{
  /**
   * How big the flash is, is how loud the clap is and which of the three
   * recordings it comes from — and distance is a lowpass and nothing else,
   * because air eats the top of a strike long before it eats the bottom.
   */
  const ctx = stubContext();
  ctx.state = 'running';
  const named = await clipNames(ctx);
  const out = ctx.createGain();
  const storm = VOICES.get('thunder').build(ctx, out);

  ctx.currentTime = 1;
  ctx.log.built.length = 0;
  storm.cue(1.2, { level: 1, distance: 0 });
  ok('a strike on the house is heard dry', !ctx.log.built.includes('filter'),
    ctx.log.built.join(','));

  ctx.log.built.length = 0;
  storm.cue(1.4, { level: 0.4, distance: 0.9 });
  ok('and one across the valley is heard through the air between',
    ctx.log.built.includes('filter'), ctx.log.built.join(','));

  /**
   * And a near strike is one of the two sharp recordings rather than always
   * the same one. At six flashes a minute a single clap comes round every ten
   * seconds, and by the third everybody has heard that it is a tape.
   */
  ctx.log.played.length = 0;
  for (let i = 0; i < 40; i++) storm.cue(2 + i, { level: 0.9, distance: 0 });
  const near = new Set(named());
  ok('a strike on the house is one of the sharp ones',
    [...near].every((n) => n === 'thunder-crack' || n === 'thunder-close'), [...near].join(' '));
  ok('and not always the same one', near.size === 2, [...near].join(' '));

  ctx.log.played.length = 0;
  for (let i = 0; i < 10; i++) storm.cue(100 + i, { level: 0.3, distance: 0.8 });
  ok('and a far one is the long roll', new Set(named()).size === 1 && named()[0] === 'thunder-roll',
    [...new Set(named())].join(' '));
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
  await loadClips(ctx);
  const out = ctx.createGain();
  const storm = VOICES.get('thunder').build(ctx, out);

  const run = (from, to, step = 0.3) => {
    ctx.log.startedAt.length = 0;
    for (ctx.currentTime = from; ctx.currentTime < to; ctx.currentTime += step) {
      storm.schedule(ctx.currentTime + 0.35);
    }
    return ctx.log.startedAt.length;
  };

  ok('left to itself, thunder rumbles', run(0, 90) > 0);
  storm.cue(ctx.currentTime + 0.2, { level: 1, distance: 0 });
  ok('once something is cueing it, it adds nothing of its own',
    run(ctx.currentTime, ctx.currentTime + 30) === 0);
  ok('and it picks up again when the lightning goes away',
    run(ctx.currentTime + 60, ctx.currentTime + 240) > 0);

  // A shell on its way up is not thunder, whatever a layer pointed by hand at
  // this voice happens to send it.
  ctx.log.startedAt.length = 0;
  storm.cue(ctx.currentTime + 0.2, { kind: 'rise', level: 1 });
  ok('and a firework going up is not a thunderclap', ctx.log.startedAt.length === 0);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
