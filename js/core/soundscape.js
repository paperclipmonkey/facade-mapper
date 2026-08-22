/**
 * The sound the house makes.
 *
 * A projection show is silent, and silence is most of the reason a very good
 * one still reads as a picture rather than as a place. Water lapping under a
 * flooded window, legs skittering behind a web, something wet moving in a hole
 * in the brickwork: each of those is a few seconds of work and it does more for
 * the illusion than any amount of extra light.
 *
 * **Synthesised, not sampled.** Every voice here is built out of noise and
 * filters at run time. Three reasons, in order of how much they matter:
 *
 * - It never repeats. A loop of rain is a loop, and a person standing in front
 *   of a house for ten minutes hears the seam. Noise through a moving filter
 *   has no seam to hear.
 * - It costs nothing to ship. The app is a folder of text files served off a
 *   static host with no build step; a sound library is tens of megabytes of
 *   binary in a git repository, and the first thing anybody would do is trim
 *   it and break the show.
 * - It can be *driven*. A voice is a graph with knobs on it, so thunder can
 *   crack when the lightning effect actually fires rather than on its own
 *   timetable. See `sync`.
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

/* ------------------------------------------------------------------ *
 * Noise
 * ------------------------------------------------------------------ */

/**
 * A few seconds of white noise, made once per context and shared.
 *
 * Every voice below is noise through something. Four seconds is long enough
 * that the loop point is not a rhythm and short enough to be a megabyte.
 */
const noiseCache = new WeakMap();

function noiseBuffer(ctx) {
  let buffer = noiseCache.get(ctx);
  if (buffer) return buffer;
  const seconds = 4;
  buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  noiseCache.set(ctx, buffer);
  return buffer;
}

/** A looping noise source, started. */
function noiseSource(ctx) {
  const node = ctx.createBufferSource();
  node.buffer = noiseBuffer(ctx);
  node.loop = true;
  // A random offset, so two voices sharing the buffer are not correlated —
  // which sounds like one louder voice rather than two.
  node.start(0, Math.random() * 3.5);
  return node;
}

/** A slow sine, for anything that should breathe. Returns the gain it drives. */
function lfo(ctx, hz, depth, centre) {
  const osc = ctx.createOscillator();
  osc.frequency.value = hz;
  const amount = ctx.createGain();
  amount.gain.value = depth;
  const out = ctx.createGain();
  out.gain.value = centre;
  osc.connect(amount).connect(out.gain);
  osc.start();
  return { node: out, stop: () => osc.stop() };
}

function filter(ctx, type, frequency, Q = 1) {
  const node = ctx.createBiquadFilter();
  node.type = type;
  node.frequency.value = frequency;
  node.Q.value = Q;
  return node;
}

function gain(ctx, value) {
  const node = ctx.createGain();
  node.gain.value = value;
  return node;
}

/** Somewhere between `a` and `b`. */
const between = (a, b) => a + Math.random() * (b - a);

/**
 * One short burst of filtered noise, scheduled.
 *
 * The workhorse behind every voice that is made of events rather than of a
 * texture — a pop in a fire, a leg on a wall, a drip. Built and thrown away
 * per event, which sounds extravagant and is not: a handful of nodes for a few
 * tens of milliseconds, a few times a second at most.
 */
function burst(ctx, out, at, { type = 'bandpass', frequency, Q = 1, level, attack, decay }) {
  const source = ctx.createBufferSource();
  source.buffer = noiseBuffer(ctx);
  source.loop = true;
  const band = filter(ctx, type, frequency, Q);
  const envelope = ctx.createGain();
  envelope.gain.setValueAtTime(0.0001, at);
  envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), at + attack);
  envelope.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  source.connect(band).connect(envelope).connect(out);
  source.start(at, Math.random() * 3.5);
  source.stop(at + attack + decay + 0.02);
}

/* ------------------------------------------------------------------ *
 * The voices
 * ------------------------------------------------------------------ *
 *
 * Each one builds a small graph into `out` and returns what is needed to run
 * and stop it. `schedule(until)` is optional and is how a voice made of events
 * queues them: the mixer calls it with a time a fraction of a second ahead, and
 * the voice fills in whatever falls before then. That is the standard way to
 * get steady timing out of the Web Audio clock rather than out of setInterval,
 * which on a busy tab stutters exactly when the show is at its most demanding.
 */

const VOICE_LIST = [
  {
    id: 'water',
    name: 'Water lapping',
    /**
     * Two bands, because water is two sounds: the body of a wave, which is low
     * and slow, and the top of it, which is a hiss. Moving them on separate
     * slow oscillators at frequencies with no common multiple is what stops the
     * pair falling into a rhythm.
     */
    build(ctx, out) {
      const body = noiseSource(ctx);
      const low = filter(ctx, 'lowpass', 420, 0.8);
      const swell = lfo(ctx, 0.11, 0.4, 0.5);
      const bodyLevel = gain(ctx, 0.5);
      body.connect(low).connect(swell.node).connect(bodyLevel).connect(out);

      const tops = noiseSource(ctx);
      const band = filter(ctx, 'bandpass', 1700, 0.9);
      const wash = lfo(ctx, 0.19, 0.09, 0.1);
      const topLevel = gain(ctx, 0.5);
      tops.connect(band).connect(wash.node).connect(topLevel).connect(out);

      return {
        stop() {
          body.stop();
          tops.stop();
          swell.stop();
          wash.stop();
        },
      };
    },
  },

  {
    id: 'bubbles',
    name: 'Bubbles rising',
    /**
     * A bubble is a resonance whose pitch *rises* as it leaves — the cavity
     * shrinks as it detaches. That upward chirp is the whole sound; a bubble
     * drawn as a click at a fixed pitch is a click.
     */
    build(ctx, out) {
      let next = 0;
      return {
        schedule(until) {
          if (!next) next = ctx.currentTime;
          while (next < until) {
            const osc = ctx.createOscillator();
            const start = between(320, 900);
            osc.frequency.setValueAtTime(start, next);
            osc.frequency.exponentialRampToValueAtTime(start * between(1.6, 2.6), next + 0.055);
            const env = ctx.createGain();
            env.gain.setValueAtTime(0.0001, next);
            env.gain.exponentialRampToValueAtTime(between(0.05, 0.16), next + 0.006);
            env.gain.exponentialRampToValueAtTime(0.0001, next + 0.07);
            osc.connect(env).connect(out);
            osc.start(next);
            osc.stop(next + 0.09);
            next += between(0.05, 0.42);
          }
        },
        stop() {},
      };
    },
  },

  {
    id: 'writhe',
    name: 'Tentacles writhing',
    /**
     * Wet, low and unhurried. A band sweeping slowly through the range a big
     * soft thing moving against stone occupies, a sub under it so you feel the
     * mass, and the occasional slap of something letting go.
     */
    build(ctx, out) {
      const body = noiseSource(ctx);
      const band = filter(ctx, 'bandpass', 300, 1.6);
      const sweep = ctx.createOscillator();
      sweep.frequency.value = 0.09;
      const sweepAmount = gain(ctx, 220);
      sweep.connect(sweepAmount).connect(band.frequency);
      sweep.start();
      const breathe = lfo(ctx, 0.16, 0.4, 0.45);
      body.connect(band).connect(breathe.node).connect(out);

      const sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.value = 46;
      const subSweep = ctx.createOscillator();
      subSweep.frequency.value = 0.07;
      const subAmount = gain(ctx, 9);
      subSweep.connect(subAmount).connect(sub.frequency);
      subSweep.start();
      const subLevel = gain(ctx, 0.22);
      sub.connect(subLevel).connect(out);
      sub.start();

      let next = 0;
      return {
        schedule(until) {
          if (!next) next = ctx.currentTime + 1;
          while (next < until) {
            burst(ctx, out, next, {
              type: 'lowpass',
              frequency: between(300, 900),
              Q: 0.9,
              level: between(0.06, 0.18),
              attack: 0.006,
              decay: between(0.08, 0.22),
            });
            next += between(1.1, 4.5);
          }
        },
        stop() {
          body.stop();
          sub.stop();
          sweep.stop();
          subSweep.stop();
          breathe.stop();
        },
      };
    },
  },

  {
    id: 'crawl',
    name: 'Spiders crawling',
    /**
     * Skittering is not a steady patter, it is *bursts*: several legs in
     * quick succession, then stillness, then more. The stillness is what makes
     * it sound alive — something that moves continuously is a machine, and
     * something that moves in short runs is deciding where to go.
     */
    build(ctx, out) {
      let next = 0;
      return {
        schedule(until) {
          if (!next) next = ctx.currentTime + 0.4;
          while (next < until) {
            const legs = 3 + Math.floor(Math.random() * 6);
            const gap = between(0.028, 0.055);
            for (let i = 0; i < legs; i++) {
              burst(ctx, out, next + i * gap, {
                frequency: between(2400, 6200),
                Q: between(1.5, 4),
                level: between(0.02, 0.07),
                attack: 0.0015,
                decay: between(0.008, 0.02),
              });
            }
            next += legs * gap + between(0.18, 1.4);
          }
        },
        stop() {},
      };
    },
  },

  {
    id: 'thunder',
    name: 'Thunder crackling',
    /**
     * A crack and then a rumble, with a gap between them, because that is what
     * distance does to a lightning strike: the sharp part is high frequency and
     * the air eats it, the low part travels. The gap is randomised over a range
     * that reads as "somewhere over there" rather than "on the roof".
     */
    build(ctx, out) {
      let next = 0;
      return {
        schedule(until) {
          if (!next) next = ctx.currentTime + between(2, 8);
          while (next < until) {
            const near = Math.random() < 0.3;
            // The crack, only when it is close enough to have survived.
            if (near) {
              burst(ctx, out, next, {
                type: 'highpass',
                frequency: 1800,
                Q: 0.7,
                level: 0.5,
                attack: 0.002,
                decay: 0.09,
              });
            }
            const at = next + (near ? 0.05 : between(0.2, 0.6));
            const source = noiseSource(ctx);
            const low = filter(ctx, 'lowpass', near ? 260 : 130, 1.1);
            const env = ctx.createGain();
            const length = between(1.8, near ? 4.5 : 6.5);
            env.gain.setValueAtTime(0.0001, at);
            env.gain.exponentialRampToValueAtTime(near ? 0.8 : 0.35, at + between(0.05, 0.3));
            env.gain.exponentialRampToValueAtTime(0.0001, at + length);
            source.connect(low).connect(env).connect(out);
            source.stop(at + length + 0.1);
            next += between(7, 26);
          }
        },
        stop() {},
      };
    },
  },

  {
    id: 'fire',
    name: 'Fire crackling',
    /**
     * A bed of roar with pops on top. The pops are what people hear as fire —
     * the bed alone is a hairdryer — and they have to be sparse and irregular,
     * because a pop every half second is a Geiger counter.
     */
    build(ctx, out) {
      const bed = noiseSource(ctx);
      const low = filter(ctx, 'lowpass', 700, 0.8);
      const breathe = lfo(ctx, 0.23, 0.1, 0.16);
      bed.connect(low).connect(breathe.node).connect(out);

      let next = 0;
      return {
        schedule(until) {
          if (!next) next = ctx.currentTime;
          while (next < until) {
            burst(ctx, out, next, {
              frequency: between(700, 3400),
              Q: between(1, 3),
              level: between(0.04, 0.22),
              attack: 0.001,
              decay: between(0.01, 0.05),
            });
            next += between(0.03, 0.5);
          }
        },
        stop() {
          bed.stop();
          breathe.stop();
        },
      };
    },
  },

  {
    id: 'wind',
    name: 'Wind',
    build(ctx, out) {
      const source = noiseSource(ctx);
      const band = filter(ctx, 'bandpass', 520, 0.7);
      const sweep = ctx.createOscillator();
      sweep.frequency.value = 0.06;
      const amount = gain(ctx, 260);
      sweep.connect(amount).connect(band.frequency);
      sweep.start();
      // Gusts on a slower cycle than the pitch, or it reads as one wobble.
      const gust = lfo(ctx, 0.037, 0.32, 0.36);
      source.connect(band).connect(gust.node).connect(out);
      return {
        stop() {
          source.stop();
          sweep.stop();
          gust.stop();
        },
      };
    },
  },

  {
    id: 'rain',
    name: 'Rain',
    /**
     * Rain is high, flat and *dense* — thousands of impacts a second, which is
     * noise. What stops it being a hiss is a little movement in the filter and
     * the occasional heavier drop close by.
     */
    build(ctx, out) {
      const source = noiseSource(ctx);
      const high = filter(ctx, 'highpass', 1100, 0.6);
      const shape = filter(ctx, 'lowpass', 7000, 0.5);
      const level = lfo(ctx, 0.05, 0.06, 0.2);
      source.connect(high).connect(shape).connect(level.node).connect(out);

      let next = 0;
      return {
        schedule(until) {
          if (!next) next = ctx.currentTime;
          while (next < until) {
            burst(ctx, out, next, {
              frequency: between(900, 2600),
              Q: between(3, 9),
              level: between(0.02, 0.08),
              attack: 0.001,
              decay: between(0.01, 0.035),
            });
            next += between(0.04, 0.3);
          }
        },
        stop() {
          source.stop();
          level.stop();
        },
      };
    },
  },

  {
    id: 'drip',
    name: 'Dripping',
    build(ctx, out) {
      let next = 0;
      return {
        schedule(until) {
          if (!next) next = ctx.currentTime + 1;
          while (next < until) {
            // A drip is a short pitched blip with a fast downward bend, into a
            // resonant tail — the tail is the container it landed in.
            const osc = ctx.createOscillator();
            const top = between(700, 1500);
            osc.frequency.setValueAtTime(top, next);
            osc.frequency.exponentialRampToValueAtTime(top * 0.55, next + 0.04);
            const env = ctx.createGain();
            env.gain.setValueAtTime(0.0001, next);
            env.gain.exponentialRampToValueAtTime(between(0.06, 0.16), next + 0.004);
            env.gain.exponentialRampToValueAtTime(0.0001, next + 0.12);
            osc.connect(env).connect(out);
            osc.start(next);
            osc.stop(next + 0.14);
            next += between(0.6, 3.2);
          }
        },
        stop() {},
      };
    },
  },

  {
    id: 'wings',
    name: 'Wings',
    /**
     * Leathery rather than feathery: a beat is a short low whoomph, and a bat
     * beats about ten times a second, in flurries.
     */
    build(ctx, out) {
      let next = 0;
      return {
        schedule(until) {
          if (!next) next = ctx.currentTime + 0.5;
          while (next < until) {
            const beats = 4 + Math.floor(Math.random() * 8);
            const period = between(0.085, 0.13);
            for (let i = 0; i < beats; i++) {
              burst(ctx, out, next + i * period, {
                type: 'lowpass',
                frequency: between(220, 520),
                Q: 0.8,
                level: between(0.05, 0.14),
                attack: 0.008,
                decay: between(0.03, 0.06),
              });
            }
            next += beats * period + between(0.4, 2.6);
          }
        },
        stop() {},
      };
    },
  },

  {
    id: 'hum',
    name: 'Neon hum',
    /**
     * Mains hum is the fundamental *and* its harmonics — a pure 50 Hz sine is
     * inaudible on a laptop speaker and sounds like nothing on a big one. The
     * buzz that says "tube" is up at the top, and it flickers.
     */
    build(ctx, out) {
      const mains = ctx.createOscillator();
      mains.type = 'sawtooth';
      mains.frequency.value = 50;
      const shape = filter(ctx, 'lowpass', 900, 1.4);
      const level = gain(ctx, 0.07);
      mains.connect(shape).connect(level).connect(out);
      mains.start();

      const buzz = noiseSource(ctx);
      const band = filter(ctx, 'bandpass', 7200, 6);
      const flicker = lfo(ctx, 3.1, 0.02, 0.03);
      buzz.connect(band).connect(flicker.node).connect(out);

      return {
        stop() {
          mains.stop();
          buzz.stop();
          flicker.stop();
        },
      };
    },
  },

  {
    id: 'chime',
    name: 'Glisten',
    /**
     * For anything that twinkles. Sine partials at intervals from a pentatonic
     * scale, which has no semitones in it and therefore no wrong note — the
     * one bit of music theory that earns its keep in an effects library.
     */
    build(ctx, out) {
      const scale = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
      let next = 0;
      return {
        schedule(until) {
          if (!next) next = ctx.currentTime + 0.6;
          while (next < until) {
            const step = scale[Math.floor(Math.random() * scale.length)];
            const hz = 523.25 * 2 ** (step / 12);
            for (const [mult, level] of [[1, 0.1], [2.76, 0.03], [5.4, 0.012]]) {
              const osc = ctx.createOscillator();
              osc.type = 'sine';
              osc.frequency.value = hz * mult;
              const env = ctx.createGain();
              const length = between(1.2, 2.8) / mult;
              env.gain.setValueAtTime(0.0001, next);
              env.gain.exponentialRampToValueAtTime(level, next + 0.006);
              env.gain.exponentialRampToValueAtTime(0.0001, next + length);
              osc.connect(env).connect(out);
              osc.start(next);
              osc.stop(next + length + 0.05);
            }
            next += between(0.4, 2.4);
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
 * set this up is not "what does kelp sound like" but "what does the underwater
 * look sound like when eight of its layers are on at once", and you cannot
 * answer that reading eight files. Here it is one screen, and the fact that
 * five underwater effects share a single water voice — rather than each adding
 * its own lapping until the show is mush — is visible at a glance.
 *
 * An effect may still declare `sound` on itself and that wins; nothing built in
 * does, and a user effect that wants a noise of its own should not have to come
 * back here to get one.
 */
export const VOICE_FOR_EFFECT = {
  // Under the sea. One water, deliberately: the waterline is the layer that
  // owns the sound of water, and the rest of the set is silent under it.
  waterline: 'water',
  bubbles: 'bubbles',
  caustics: 'water',
  kelp: null,
  godrays: null,
  shoal: null,
  dolphins: null,
  jellyfish: null,

  // Halloween.
  breach: 'writhe',
  portal: 'writhe',
  web: 'crawl',
  lightning: 'thunder',
  fire: 'fire',
  candle: 'fire',
  bonfire: 'fire',
  embers: 'fire',
  sparkler: 'fire',
  'blood-drip': 'drip',
  fog: 'wind',
  smoke: 'wind',
  bats: 'wings',
  'bat-burst': 'wings',
  serpent: 'writhe',
  ghost: 'wind',

  // Weather and the sky.
  rain: 'rain',
  snow: 'wind',
  aurora: 'wind',
  icicles: 'drip',
  frost: 'chime',
  stars: 'chime',
  'fairy-lights': 'chime',

  // Electric.
  neon: 'hum',
  'neon-sign': 'hum',
  hologram: 'hum',
  'scan-lines': 'hum',
  static: 'hum',
  plasma: 'hum',
};

/** What a layer would play, resolving `auto` against the table above. */
export function voiceForLayer(layer, effect) {
  const choice = layer?.sound ?? 'auto';
  if (choice === 'none') return null;
  if (choice !== 'auto') return VOICES.has(choice) ? choice : null;
  const declared = effect?.sound;
  if (declared !== undefined) return VOICES.has(declared) ? declared : null;
  const mapped = VOICE_FOR_EFFECT[effect?.id];
  return mapped && VOICES.has(mapped) ? mapped : null;
}

/**
 * What should be playing, given the layers that are actually on the wall.
 *
 * Pure, and separate from the audio graph on purpose: this is the part with the
 * decisions in it — which layers count, how loud, and what happens when three
 * of them ask for the same voice — and it is the part worth testing. The mixer
 * below only does what this says.
 *
 * Two layers wanting the same voice get *one* instance at the loudest of their
 * levels rather than two. Two copies of a noise bed is not twice the water, it
 * is one louder and muddier water, and a show with a preset applied twice would
 * otherwise be unlistenable.
 */
export function planSoundscape(layers, getEffect, { master = 1 } = {}) {
  const byVoice = new Map();
  for (const layer of layers || []) {
    if (layer.enabled === false) continue;
    const effect = getEffect(layer.effect);
    const voice = voiceForLayer(layer, effect);
    if (!voice) continue;
    // Silent layers are silent: the opacity fader takes the sound with it, so
    // a crossfade between two scenes fades what you hear as well as what you
    // see, without anybody wiring that up per layer.
    const level = clamp01(layer.soundLevel ?? 1) * clamp01(layer.opacity ?? 1) * clamp01(master);
    if (level <= 0.0005) continue;
    const existing = byVoice.get(voice);
    if (!existing || level > existing.level) {
      byVoice.set(voice, {
        voice,
        level,
        layerId: layer.id,
        name: layer.name || effect?.name || layer.effect,
      });
    }
  }
  return [...byVoice.values()];
}

const clamp01 = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

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
      const node = gain(ctx, 0.0001);
      node.connect(master);
      let instance;
      try {
        instance = voice.build(ctx, node) || {};
      } catch (err) {
        console.warn('[sound] voice failed to build', entry.voice, err);
        node.disconnect();
        continue;
      }
      // Faded in rather than switched on: a noise bed that appears at full
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
    /** The plan. Cheap to call every frame; only differences do any work. */
    sync(plan) {
      wanted = plan || [];
      apply();
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
