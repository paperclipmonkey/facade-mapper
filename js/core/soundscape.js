/**
 * The sound the house makes.
 *
 * A projection show is silent, and silence is most of the reason a very good
 * one still reads as a picture rather than as a place. Bricks dropping out of
 * a wall, something wet moving behind the hole they left, thunder on the beat
 * of the flash: each of those is a few seconds of work and it does more for
 * the illusion than any amount of extra light.
 *
 * **Recorded, not synthesised.** Every voice here plays clips out of
 * `audio/`, which are real recordings in the public domain — see
 * `audio/CREDITS.md`. This used to be a rack of noise generators and filters,
 * and the argument for that was that it never repeated and cost nothing to
 * ship. Both were true and neither mattered, because filtered noise does not
 * sound like thunder. It sounds like filtered noise with a storm's shape, and
 * a person standing in a garden hears the difference immediately even if they
 * could not tell you what is wrong.
 *
 * Three things keep the old argument's good half:
 *
 * - **Three voices, not thirteen.** A library that covers every effect in the
 *   app is tens of megabytes and the first thing anybody would do is trim it
 *   and break the show. Thunder, bricks and tentacles is about 750 kB, which
 *   is less than one of the icons.
 * - **The variety is in the playing, not the library.** A clip is picked at
 *   random from a handful, pitched a little either way, overlapped with the
 *   last one and rolled off by distance. Six brick samples make a wall that
 *   comes apart differently every time; a loop of a wall coming apart is a
 *   loop, and you hear the seam.
 * - **It can still be driven.** A voice takes a `cue`, so thunder cracks when
 *   the lightning effect actually fires rather than on its own timetable. See
 *   `cue` below, and `cues` on the lightning effect.
 *
 * **It plays in one place: the control tab.** That is the machine with the
 * speakers, and it is the tab that is definitely running. Projector tabs are
 * often on a machine in a garage with no sound at all, and two of them making
 * the same noise a few milliseconds apart is worse than one making it.
 *
 * `Math.random` is used freely here, which is banned everywhere else in this
 * codebase — see docs/writing-effects.md. The ban is about tabs agreeing with
 * each other on the wall, and there is only ever one of these.
 */

const clamp01 = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

/** Somewhere between `a` and `b`. */
const between = (a, b) => a + Math.random() * (b - a);

/** One of them, evenly. */
const pick = (list) => list[Math.floor(Math.random() * list.length)];

/* ------------------------------------------------------------------ *
 * The clips
 * ------------------------------------------------------------------ */

/**
 * Every file in `audio/`, by the name the voices ask for it by.
 *
 * Listed here rather than gathered from the voices so that loading is one pass
 * over one array: turning the sound on fetches the lot, and a voice that comes
 * into the plan two hours into an evening is not waiting on a download.
 */
export const CLIPS = [
  'thunder-crack',
  'thunder-close',
  'thunder-roll',
  'brick-1',
  'brick-2',
  'brick-3',
  'brick-4',
  'rubble-1',
  'rubble-2',
  'slither-1',
  'slither-2',
  'slither-3',
  'slither-4',
  'slither-5',
];

/**
 * Resolved against this module rather than against the page, so the app works
 * from a subdirectory on a static host without anybody configuring a base URL.
 */
const CLIP_BASE = new URL('../../audio/', import.meta.url);

/** Decoded clips, per context. A test builds several; none of them share. */
const decoded = new WeakMap();

function shelf(ctx) {
  let store = decoded.get(ctx);
  if (!store) {
    store = { ready: new Map(), asked: new Set() };
    decoded.set(ctx, store);
  }
  return store;
}

/**
 * Where the sound actually starts, in seconds from the front of the buffer.
 *
 * Every lossy codec pads the front of what it decodes — a couple of dozen
 * milliseconds of silence that is not in the file and is not the same on every
 * browser. That is nothing for a noise bed and it is exactly the wrong amount
 * for a thunderclap scheduled against a flash drawn on the wall, which is the
 * one piece of timing in this app a person can hear. So the silence is
 * measured once, at load, and skipped at playback: `start(at, lead)` puts the
 * first audible sample on `at` whatever the decoder did.
 */
function leadIn(buffer) {
  if (typeof buffer?.getChannelData !== 'function') return 0;
  const rate = buffer.sampleRate || 44100;
  const data = buffer.getChannelData(0);
  const limit = Math.min(data.length, Math.floor(rate * 0.15));
  for (let i = 0; i < limit; i++) {
    // A hair before it, so a fast attack keeps its leading edge.
    if (Math.abs(data[i]) > 0.0025) return Math.max(0, i - 64) / rate;
  }
  return 0;
}

/**
 * Fetch and decode the library into one context.
 *
 * Failures are warned about and then forgotten: a missing file makes its voice
 * quieter, and a show that refuses to start because one brick sample 404ed
 * would be a worse evening than one that is down a brick. Called once from
 * `start`; asking twice for the same clip does nothing.
 *
 * A context with no `decodeAudioData` is the test stub, and there is nothing
 * to fetch from a file path anyway, so it is handed back empty.
 */
export function loadClips(ctx, names = CLIPS) {
  const store = shelf(ctx);
  if (typeof ctx?.decodeAudioData !== 'function' || typeof fetch !== 'function') {
    return Promise.resolve(store.ready);
  }
  const jobs = [];
  for (const name of names) {
    if (store.asked.has(name)) continue;
    store.asked.add(name);
    jobs.push(
      fetch(new URL(`${name}.mp3`, CLIP_BASE))
        .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(`HTTP ${res.status}`))))
        .then((bytes) => ctx.decodeAudioData(bytes))
        .then((buffer) => {
          store.ready.set(name, { buffer, lead: leadIn(buffer) });
        })
        .catch((err) => {
          console.warn(`[sound] no ${name}.mp3:`, err.message);
        })
    );
  }
  return Promise.all(jobs).then(() => store.ready);
}

/**
 * One clip, once, at a known instant.
 *
 * `at` is on the audio clock, not the frame clock, and may be a fraction of a
 * second ahead — everything here is queued rather than fired, which is what
 * lets a clap land on its flash and a run of bricks land evenly spaced rather
 * than on whichever frames happened to tick.
 *
 * `rate` is the one liberty taken with a recording: the same brick played at
 * four tenths either side of its own pitch is four bricks, and six samples
 * that way cover a wall coming down for twenty minutes without anybody hearing
 * the same brick twice in a row. `tone` is a lowpass, and it is how distance
 * is drawn: air eats the top of a sound long before it eats the bottom, which
 * is why a storm a mile off is all rumble and no snap.
 *
 * Returns null when the clip is not loaded — too early in the evening, or the
 * file is missing. Silence, not a crash.
 */
function playClip(ctx, out, name, at, { level = 1, rate = 1, tone = 0 } = {}) {
  const clip = shelf(ctx).ready.get(name);
  if (!clip) return null;

  const source = ctx.createBufferSource();
  source.buffer = clip.buffer;
  if (source.playbackRate) source.playbackRate.value = rate;

  const amp = ctx.createGain();
  amp.gain.value = Math.max(0, level);
  source.connect(amp);

  if (tone > 0) {
    const muffle = ctx.createBiquadFilter();
    muffle.type = 'lowpass';
    muffle.frequency.value = tone;
    muffle.Q.value = 0.7;
    amp.connect(muffle);
    muffle.connect(out);
  } else {
    amp.connect(out);
  }

  source.start(Math.max(0, at), clip.lead);
  return source;
}

/* ------------------------------------------------------------------ *
 * The voices
 * ------------------------------------------------------------------ */

/**
 * Two near strikes rather than one.
 *
 * At six flashes a minute a single recording comes round every ten seconds and
 * is recognisable by the third, which is worse than no sound: a storm that
 * repeats is a tape. Both of these are cut so the crack is on the first
 * sample — the whole point of cueing the clap to the flash is lost if the file
 * opens with half a second of approaching weather, and both of these
 * originally did.
 */
const THUNDER_NEAR = ['thunder-crack', 'thunder-close'];
const BRICKS = ['brick-1', 'brick-2', 'brick-3', 'brick-4'];
const RUBBLE = ['rubble-1', 'rubble-2'];
const SLITHERS = ['slither-1', 'slither-2', 'slither-3', 'slither-4', 'slither-5'];

const VOICE_LIST = [
  {
    id: 'thunder',
    name: 'Thunder',
    /**
     * Three real strikes, chosen by how big the one on the wall is.
     *
     * A near flash gets the sharp one, a middling flash the crack with ten
     * seconds of roll behind it, a distant one the long dying rumble — and
     * then distance rolls the top off whatever was picked, so the same three
     * recordings cover a storm from overhead to the far side of the valley.
     *
     * Left to itself it still rumbles, on its own loose timetable, because a
     * thunder layer somebody wired up by hand with no lightning in the scene
     * should not be silent all evening. The moment something starts cueing it,
     * that stops: two storms, one of them attached to nothing you can see, is
     * worse than none.
     */
    build(ctx, out) {
      let lastCue = -Infinity;
      let next = 0;

      const strike = (at, { level = 0.8, distance = 0 } = {}) => {
        const near = clamp01(level) * (1 - clamp01(distance));
        const clip = near > 0.35 ? pick(THUNDER_NEAR) : 'thunder-roll';
        playClip(ctx, out, clip, at, {
          level: 0.4 + near * 0.6,
          rate: between(0.93, 1.07),
          tone: distance > 0.05 ? 1100 - clamp01(distance) * 800 : 0,
        });
      };

      return {
        cue(at, detail = {}) {
          // A firework going up is not thunder. The break might be, if somebody
          // has pointed the voice at it by hand, but the rush is not.
          if (detail.kind === 'rise') return;
          lastCue = ctx.currentTime;
          strike(at, detail);
        },
        schedule(until) {
          if (ctx.currentTime - lastCue < 45) {
            next = 0;
            return;
          }
          if (!next) next = ctx.currentTime + between(3, 12);
          while (next < until) {
            // Weather happening somewhere else: quiet, far off, and never the
            // sharp one.
            strike(next, { level: between(0.3, 0.6), distance: between(0.45, 0.9) });
            next += between(11, 34);
          }
        },
      };
    },
  },

  {
    id: 'bricks',
    name: 'Bricks falling',
    /**
     * One brick per brick.
     *
     * This has no timetable of its own at all. Breach says when a brick leaves
     * the wall and when the last one of a hole has gone, and each of those is
     * a clip — so what you hear is the wall you are looking at rather than a
     * loop of a wall running alongside it. Getting that wrong is very
     * noticeable: the effect drops a cluster and then leaves the wall alone
     * for several seconds, and a sound on its own clock spends most of the
     * evening rattling at a wall that is doing nothing.
     *
     * Unlike thunder, the events are *not* known in advance. Breach picks the
     * next brick from state it accumulates step by step, so it cannot say what
     * it will do half a second from now; it says what it has just done, and
     * the clip goes out on the same frame. For a brick that is right. A tenth
     * of a second out is a brick landing; a clap a tenth of a second out is a
     * fault, which is why lightning gets the other mechanism.
     *
     * See `sound` in render/worldRenderer.js for the channel, and
     * docs/writing-effects.md for the two ways round.
     */
    build(ctx, out) {
      /**
       * Two bricks landing inside a twentieth of a second are not two bricks,
       * they are one louder thud with a flam on it. A Breach layer pointed at
       * six windows can easily put that many in a frame.
       */
      let lastAt = -Infinity;
      return {
        cue(at, detail = {}) {
          if (at - lastAt < 0.05) return;
          lastAt = at;
          const level = clamp01(detail.level ?? 1) || 1;
          if (detail.kind === 'rubble') {
            // What comes down after the bricks: a brick shoved out of a wall
            // from behind takes the corners off its neighbours on the way.
            playClip(ctx, out, pick(RUBBLE), at + between(0.02, 0.2), {
              level: between(0.22, 0.5) * level,
              rate: between(0.85, 1.15),
              // Heard through the hole it came out of.
              tone: 5200,
            });
            return;
          }
          playClip(ctx, out, pick(BRICKS), at, {
            level: between(0.4, 0.82) * level,
            rate: between(0.8, 1.25),
          });
        },
        stop() {},
      };
    },
  },

  {
    id: 'writhe',
    name: 'Tentacles slithering',
    /**
     * Something big and wet moving against stone.
     *
     * Five recordings of slime and flesh being squeezed, laid over each other
     * two or three deep and pitched down — the source is a hand on a ball of
     * slime, which at its own speed is a small sound, and dropping it half an
     * octave is most of what turns it into something the size of an arm.
     * Rolled off at the top as well, because the thing is on the far side of a
     * wall and a hole in brickwork is a filter.
     *
     * Overlapping is the whole trick. One wet noise at a time is a wet noise;
     * three of them at different pitches, starting and ending at times with no
     * common multiple, is a thing that never stops moving and never repeats.
     */
    build(ctx, out) {
      let next = 0;
      return {
        schedule(until) {
          if (!next) next = ctx.currentTime + between(0.1, 0.8);
          while (next < until) {
            playClip(ctx, out, pick(SLITHERS), next, {
              level: between(0.25, 0.7),
              rate: between(0.55, 1),
              tone: between(2200, 5000),
            });
            next += between(0.8, 2.8);
          }
        },
        stop() {},
      };
    },
  },
];

export const VOICES = new Map(VOICE_LIST.map((v) => [v.id, v]));

/** For a picker: id and name, in the order they are defined. */
export const VOICE_OPTIONS = VOICE_LIST.map(({ id, name }) => ({ id, name }));

/* ------------------------------------------------------------------ *
 * Which effect sounds like what
 * ------------------------------------------------------------------ */

/**
 * The default voice for each effect, as one table rather than a field on each
 * effect object.
 *
 * A field per effect would be tidier by one measure and much worse by the one
 * that matters: sound is an *ensemble*. The question you are answering when you
 * set this up is not "what does a portal sound like" but "what does this show
 * sound like when eight of its layers are on at once", and you cannot answer
 * that reading eight files. Here it is four lines, and the fact that almost
 * everything in the library is silent is visible at a glance.
 *
 * It is four lines on purpose. The app had thirteen voices and a mapping for
 * sixty-odd effects, and the result was a show where everything made a noise
 * and none of it was any good. Three sounds done properly beat thirteen done
 * out of filtered noise, and most effects are better off with nothing under
 * them at all.
 *
 * **An effect may want more than one of them**, and Breach is the reason the
 * value here can be a list. It draws two things happening at once — a wall
 * coming apart, and something reaching out through the hole — and giving it
 * only the bricks left the tentacles silent, which is the one thing everybody
 * notices. One voice per effect is a tidy rule that was wrong about the only
 * effect in the app that needed it to be.
 *
 * An effect may still declare `sound` on itself and that wins; nothing built in
 * does, and a user effect that wants a noise of its own should not have to come
 * back here to get one. A layer may also be pointed at a single voice by hand,
 * which is how you silence half of a Breach: `"sound": "writhe"` on the layer.
 */
export const VOICE_FOR_EFFECT = {
  lightning: 'thunder',
  breach: ['bricks', 'writhe'],
  portal: 'writhe',
  serpent: 'writhe',
};

/**
 * What a layer would play, resolving `auto` against the table above.
 *
 * Always a list, possibly empty — most layers are silent. `sound` on the layer
 * takes a single voice rather than a list, because it is a control somebody
 * sets by hand to override the default and "all of it or one of it" is the
 * only choice anybody has wanted.
 */
export function voicesForLayer(layer, effect) {
  const choice = layer?.sound ?? 'auto';
  if (choice === 'none') return [];
  if (choice !== 'auto') return VOICES.has(choice) ? [choice] : [];
  const declared = effect?.sound;
  const mapped = declared === undefined ? VOICE_FOR_EFFECT[effect?.id] : declared;
  if (mapped == null) return [];
  return (Array.isArray(mapped) ? mapped : [mapped]).filter((id) => VOICES.has(id));
}

/**
 * Who owns each voice.
 *
 * A scene is not a list of sounds, it is *one* soundscape, and a preset with
 * two breaching walls in it asks for the brick voice twice. Playing it twice is
 * not twice the wall, it is one louder, muddier wall — so a voice is played
 * once, by one layer, and the others are silent under it.
 *
 * Which one? The first that asks, in layer order. Not the loudest: ownership
 * decided by level hops from layer to layer as the faders move, and a volume
 * slider that changes *which* slider is live is a slider nobody can use. The
 * one concession is that a layer faded to nothing hands the voice on rather
 * than taking the whole show silent with it, which is what makes a crossfade
 * between two scenes that both contain a breach keep crumbling throughout.
 *
 * Returned as layer id -> the voices it carries, because both the callers —
 * the plan below and the two places that draw a volume fader — are asking the
 * same question about a layer they already have. A list, because a Breach
 * carries two and they can be split across two layers.
 */
export function soundOwners(layers, getEffect) {
  const held = new Map();
  for (const layer of layers || []) {
    if (layer.enabled === false) continue;
    const audible = clamp01(layer.soundLevel ?? 1) * clamp01(layer.opacity ?? 1) > 0.0005;
    for (const voice of voicesForLayer(layer, getEffect?.(layer.effect))) {
      const incumbent = held.get(voice);
      if (!incumbent || (!incumbent.audible && audible)) held.set(voice, { id: layer.id, audible });
    }
  }
  const owners = new Map();
  for (const [voice, entry] of held) {
    const mine = owners.get(entry.id) || [];
    mine.push(voice);
    owners.set(entry.id, mine);
  }
  return owners;
}

/**
 * Which layer gets a volume fader, which is not quite the same question.
 *
 * `soundOwners` answers "what is audible"; this answers "what should have a
 * control on it", and the two differ for a layer that is simply switched off.
 * Nothing is playing its voice, but nothing else has claimed it either, so it
 * keeps its fader — setting the level of a layer you are about to turn on is
 * exactly what the fader is for, and a control that vanishes when you switch a
 * layer off is a control you cannot set up in daylight.
 *
 * Used by both places that draw one — the inspector and the remote — so they
 * cannot drift apart and disagree about which slider is the live one.
 */
export function soundFaders(layers, getEffect) {
  const faders = new Map([...soundOwners(layers, getEffect)].map(([id, voices]) => [id, [...voices]]));
  const taken = new Set([...faders.values()].flat());
  for (const layer of layers || []) {
    for (const voice of voicesForLayer(layer, getEffect?.(layer.effect))) {
      if (taken.has(voice)) continue;
      const mine = faders.get(layer.id) || [];
      mine.push(voice);
      faders.set(layer.id, mine);
      taken.add(voice);
    }
  }
  return faders;
}

/**
 * What should be playing, given the layers that are actually on the wall.
 *
 * Pure, and separate from the audio graph on purpose: this is the part with the
 * decisions in it — which layers count and how loud — and it is the part worth
 * testing. The mixer below only does what this says.
 */
export function planSoundscape(layers, getEffect, { master = 1 } = {}) {
  const owners = soundOwners(layers, getEffect);
  const plan = [];
  for (const layer of layers || []) {
    const voices = owners.get(layer.id);
    if (!voices?.length) continue;
    // Silent layers are silent: the opacity fader takes the sound with it, so
    // a crossfade between two scenes fades what you hear as well as what you
    // see, without anybody wiring that up per layer.
    const level = clamp01(layer.soundLevel ?? 1) * clamp01(layer.opacity ?? 1) * clamp01(master);
    if (level <= 0.0005) continue;
    const effect = getEffect?.(layer.effect);
    for (const voice of voices) {
      plan.push({
        voice,
        level,
        layerId: layer.id,
        name: layer.name || effect?.name || layer.effect,
      });
    }
  }
  return plan;
}

/* ------------------------------------------------------------------ *
 * The mixer
 * ------------------------------------------------------------------ */

/** How far ahead events are queued, and how often the queue is topped up. */
const SCHEDULE_AHEAD = 0.35;
const SCHEDULE_EVERY = 120;
/** Long enough that a level change is not a click, short enough to feel live. */
const RAMP = 0.25;

/**
 * A live set of voices, reconciled against a plan.
 *
 * Nothing starts until `start()` is called from a user gesture, because every
 * browser refuses to make noise before one — and quite right too, for a page
 * that might be a projector left running in a garage.
 */
export function createSoundscape({ createContext } = {}) {
  let ctx = null;
  let master = null;
  let timer = null;
  let wanted = [];
  let volume = 0.7;
  let ready = Promise.resolve(new Map());
  const playing = new Map();

  const make = createContext || (() => new (window.AudioContext || window.webkitAudioContext)());

  async function start() {
    if (!ctx) {
      ctx = make();
      master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);
    }
    // Suspended is the normal state for a context made before a gesture, and
    // resuming it is the whole of "turning the sound on".
    if (ctx.state === 'suspended') await ctx.resume();
    // Kicked off, not waited for. Three quarters of a megabyte on a village
    // broadband connection is a second or two, and a button that hangs for a
    // second or two is a button somebody presses twice. The voices play what
    // has landed and stay quiet about the rest.
    ready = loadClips(ctx);
    if (!timer) timer = setInterval(pump, SCHEDULE_EVERY);
    apply();
    return true;
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    for (const [key, entry] of playing) {
      try {
        entry.instance.stop?.();
      } catch {
        /* already stopped, or a node that was never started */
      }
      entry.gain.disconnect();
      playing.delete(key);
    }
    ctx?.suspend?.();
  }

  function pump() {
    if (!ctx || ctx.state !== 'running') return;
    const until = ctx.currentTime + SCHEDULE_AHEAD;
    for (const entry of playing.values()) {
      try {
        entry.instance.schedule?.(until);
      } catch (err) {
        console.warn('[sound] voice failed to schedule', entry.voice, err);
      }
    }
  }

  /** Build what is missing, retune what is playing, drop what is not wanted. */
  function apply() {
    if (!ctx) return;
    const keep = new Set();
    for (const entry of wanted) {
      const voice = VOICES.get(entry.voice);
      if (!voice) continue;
      keep.add(entry.voice);
      const live = playing.get(entry.voice);
      if (live) {
        live.gain.gain.setTargetAtTime(entry.level, ctx.currentTime, RAMP / 3);
        live.name = entry.name;
        live.level = entry.level;
        continue;
      }
      const node = ctx.createGain();
      node.gain.value = 0.0001;
      node.connect(master);
      let instance;
      try {
        instance = voice.build(ctx, node) || {};
      } catch (err) {
        console.warn('[sound] voice failed to build', entry.voice, err);
        node.disconnect();
        continue;
      }
      // Faded in rather than switched on: a bed of sound that appears at full
      // level is a click, and on a wall of speakers it is a bang.
      node.gain.setTargetAtTime(entry.level, ctx.currentTime, RAMP / 3);
      playing.set(entry.voice, { voice: entry.voice, gain: node, instance, name: entry.name, level: entry.level });
    }

    for (const [key, entry] of playing) {
      if (keep.has(key)) continue;
      entry.gain.gain.setTargetAtTime(0.0001, ctx.currentTime, RAMP / 3);
      const dying = entry;
      playing.delete(key);
      setTimeout(() => {
        try {
          dying.instance.stop?.();
        } catch {
          /* already gone */
        }
        dying.gain.disconnect();
      }, RAMP * 1000 * 4);
    }
  }

  return {
    start,
    stop,
    get running() {
      return !!ctx && ctx.state === 'running';
    },
    /**
     * Settles when the library has finished downloading — or finished failing
     * to. For a test that wants to assert on sound rather than on intentions,
     * and for anything that would rather not start a show mid-download.
     */
    get ready() {
      return ready;
    },
    /** The plan. Cheap to call every frame; only differences do any work. */
    sync(plan) {
      wanted = plan || [];
      apply();
    },
    /**
     * Something on the wall is about to make a noise, at a known instant.
     *
     * `detail.in` is how many seconds ahead of now that instant is — a fraction
     * of a second, handed over by the effect that is drawing it, so the audio
     * clock can put the sound on exactly the right sample rather than on
     * whichever frame the message happened to arrive in. That is the whole
     * difference between thunder that belongs to the lightning and thunder that
     * merely follows it around.
     *
     * A voice that is not currently playing is not cued: it is inaudible, and
     * building it for one clap would fade a whole bed in behind it. Returns
     * whether the cue actually landed, so a caller counting them is counting
     * sounds rather than intentions — during a blackout every voice is dropped
     * and every cue is a no-op.
     */
    cue(voiceId, detail = {}) {
      if (!ctx || ctx.state !== 'running') return false;
      const live = playing.get(voiceId);
      if (!live?.instance?.cue) return false;
      const at = ctx.currentTime + Math.max(0, detail.in || 0);
      try {
        live.instance.cue(at, detail);
        return true;
      } catch (err) {
        console.warn('[sound] voice failed to cue', voiceId, err);
        return false;
      }
    },
    setMaster(value) {
      volume = clamp01(value);
      if (master && ctx) master.gain.setTargetAtTime(volume, ctx.currentTime, RAMP / 3);
    },
    /** What is audible right now, for a meter or a test. */
    voices() {
      return [...playing.values()].map(({ voice, name, level }) => ({ voice, name, level }));
    },
  };
}
