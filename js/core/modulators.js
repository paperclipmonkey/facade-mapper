/**
 * Parameter modulation.
 *
 * Any effect parameter can be left as a fixed value or bound to something that
 * moves: an LFO, the beat, the microphone, or an arbitrary JS expression. This is
 * where "highly programmable" mostly lives — you rarely need to write a whole
 * effect, you need the existing one's brightness to breathe, or its hue to chase
 * across a row of windows.
 */

import { clamp, lerp, smoothstep, frac, TAU, makeRng } from './math.js';
import { defaultNoise } from './noise.js';

export const BINDING_TYPES = ['const', 'lfo', 'audio', 'random', 'env', 'expr'];

export const WAVES = ['sine', 'triangle', 'saw', 'ramp', 'square', 'pulse', 'noise'];

/** All waves return -1..1 for a phase in 0..1. */
function waveform(kind, phase, shapeAmt = 0.5) {
  const p = frac(phase);
  switch (kind) {
    case 'triangle':
      return 4 * Math.abs(p - 0.5) - 1;
    case 'saw':
      return 1 - 2 * p;
    case 'ramp':
      return 2 * p - 1;
    case 'square':
      return p < 0.5 ? 1 : -1;
    case 'pulse':
      return p < clamp(shapeAmt, 0.01, 0.99) ? 1 : -1;
    case 'noise':
      return defaultNoise.noise2(p * 64, 0);
    case 'sine':
    default:
      return Math.sin(p * TAU);
  }
}

/* ------------------------------------------------------------------ *
 * Expression bindings
 * ------------------------------------------------------------------ */

const exprCache = new Map();
/**
 * Bounded because the key is the expression *text*, and text is typed.
 *
 * Every keystroke in an expression field compiles and caches a new, distinct,
 * usually-broken fragment: typing `sin(t * 2)` leaves eleven compiled functions
 * behind, ten of them syntax errors nobody will ask for again. Nothing evicts
 * them and nothing owns the map. A few hundred entries is far more than any
 * show has distinct expressions.
 */
const EXPR_LIMIT = 500;

/**
 * Compile an expression into a function of a scope object.
 *
 * The body is built with `with`, which is legal because `new Function` bodies are
 * sloppy-mode. That buys a big ergonomic win: you write `0.5 + 0.5 * sin(t * 2)`
 * instead of `s.base + s.Math.sin(s.t * 2)`.
 */
export function compileExpression(code) {
  const key = String(code);
  if (exprCache.has(key)) return exprCache.get(key);
  if (exprCache.size >= EXPR_LIMIT) exprCache.clear();

  let fn;
  try {
    // eslint-disable-next-line no-new-func
    const raw = new Function(
      '$scope',
      `with ($scope) { "use strict"; return ( ${key} ); }`
    );
    fn = { call: raw, error: null };
  } catch (err) {
    fn = { call: null, error: err.message };
  }
  exprCache.set(key, fn);
  return fn;
}

const exprRng = makeRng('expr');

function expressionScope(ctx, base, def) {
  const shape = ctx.shape || null;
  return {
    t: ctx.t,
    time: ctx.t,
    dt: ctx.dt,
    beat: ctx.beat,
    beatPhase: ctx.beatPhase,
    bpm: ctx.bpm,
    audio: ctx.audio,
    level: ctx.audio?.level ?? 0,
    low: ctx.audio?.low ?? 0,
    mid: ctx.audio?.mid ?? 0,
    high: ctx.audio?.high ?? 0,
    i: ctx.i ?? 0,
    n: ctx.n ?? 1,
    base,
    min: def?.min ?? 0,
    max: def?.max ?? 1,
    shape: shape
      ? {
          name: shape.name,
          tags: shape.tags || [],
          w: shape.bbox?.w ?? 0,
          h: shape.bbox?.h ?? 0,
          cx: shape.bbox?.cx ?? 0,
          cy: shape.bbox?.cy ?? 0,
          area: (shape.bbox?.w ?? 0) * (shape.bbox?.h ?? 0),
        }
      : { name: '', tags: [], w: 0, h: 0, cx: 0, cy: 0, area: 0 },
    // Maths, unprefixed.
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    abs: Math.abs,
    floor: Math.floor,
    ceil: Math.ceil,
    round: Math.round,
    pow: Math.pow,
    sqrt: Math.sqrt,
    exp: Math.exp,
    log: Math.log,
    atan2: Math.atan2,
    hypot: Math.hypot,
    sign: Math.sign,
    PI: Math.PI,
    TAU,
    E: Math.E,
    clamp,
    lerp,
    mix: lerp,
    smoothstep,
    frac,
    saw: (p) => waveform('saw', p),
    tri: (p) => waveform('triangle', p),
    square: (p) => waveform('square', p),
    pulse: (p, w) => waveform('pulse', p, w),
    noise: (x, y = 0, z = 0) => defaultNoise.noise3(x, y, z),
    fbm: (x, y = 0, z = 0, o = 4) => defaultNoise.fbm(x, y, z, o),
    rand: exprRng,
    min2: Math.min,
    max2: Math.max,
  };
}

/* ------------------------------------------------------------------ *
 * Sample-and-hold + envelope state
 *
 * `random` and `env` bindings need memory between frames, keyed per
 * (layer, param, target index) so staggered instances stay independent.
 * ------------------------------------------------------------------ */

const holdState = new Map();

/**
 * Bounded, because the keys outlive the things they describe.
 *
 * A key is `layerId|paramKey|targetIndex`, so every layer you delete, every
 * binding you remove and every shape you stop targeting leaves an entry that
 * nothing will ever look up again. This map is module-level — one per tab, not
 * one per renderer — so nothing owns it and nothing can be told to clear it.
 * Over an evening of editing that is a slow leak of small objects, each holding
 * its own seeded generator.
 *
 * Dropping the oldest quarter when it gets large is enough: entries are only
 * worth keeping between consecutive frames, and a show large enough to hold two
 * thousand live bindings at once does not exist.
 */
const HOLD_LIMIT = 2000;

function getHold(key) {
  let s = holdState.get(key);
  if (!s) {
    if (holdState.size >= HOLD_LIMIT) {
      // Map iterates in insertion order, so this drops the least recently
      // created rather than an arbitrary quarter.
      let drop = Math.floor(HOLD_LIMIT / 4);
      for (const k of holdState.keys()) {
        holdState.delete(k);
        if (--drop <= 0) break;
      }
    }
    s = { value: 0, target: 0, nextAt: -1, rng: makeRng(key), env: 0, lastTrig: -1 };
    holdState.set(key, s);
  }
  return s;
}

/* ------------------------------------------------------------------ *
 * Evaluation
 * ------------------------------------------------------------------ */

/**
 * Resolve one bound parameter to a concrete value.
 *
 * @param {object} binding  the binding descriptor from layer.bindings[key]
 * @param {*} base          the parameter's static value, used as the centre
 * @param {object} def      the effect's param definition (for min/max/type)
 * @param {object} ctx      { t, dt, beat, beatPhase, bpm, audio, i, n, shape, key }
 */
export function evaluateBinding(binding, base, def, ctx, bindingKey) {
  if (!binding || binding.type === 'const' || !binding.type) return base;
  const stateKey = bindingKey ?? ctx.key;

  const numericBase = typeof base === 'number' ? base : 0;
  const depth = binding.depth ?? 1;

  switch (binding.type) {
    case 'lfo': {
      // `sync` measures rate in beats-per-cycle rather than Hz, so a pulse can
      // sit on the music instead of near it.
      const phase =
        (binding.sync
          ? ctx.beat / Math.max(0.01, binding.rate ?? 1)
          : ctx.t * (binding.rate ?? 0.5)) +
        (binding.phase ?? 0) +
        (ctx.i ?? 0) * (binding.spread ?? 0);
      let w = waveform(binding.wave || 'sine', phase, binding.width ?? 0.5);
      if (binding.unipolar) w = w * 0.5 + 0.5;
      return numericBase + depth * w;
    }

    case 'audio': {
      const band = ctx.audio?.[binding.band || 'level'] ?? 0;
      return numericBase + depth * band;
    }

    case 'random': {
      const key = `${stateKey}|${ctx.i ?? 0}`;
      const s = getHold(key);
      const rate = Math.max(0.01, binding.rate ?? 2);
      if (s.nextAt < 0 || ctx.t < s.nextAt - 1 / rate - 0.001 || ctx.t >= s.nextAt) {
        s.target = s.rng() * 2 - 1;
        s.nextAt = ctx.t + 1 / rate;
      }
      const smooth = clamp(binding.smooth ?? 0, 0, 0.999);
      s.value = smooth > 0 ? lerp(s.target, s.value, smooth) : s.target;
      const v = binding.unipolar ? s.value * 0.5 + 0.5 : s.value;
      return numericBase + depth * v;
    }

    case 'env': {
      const key = `${stateKey}|${ctx.i ?? 0}`;
      const s = getHold(key);
      const div = Math.max(0.0625, binding.division ?? 1);
      const trig = Math.floor(ctx.beat / div);
      if (trig !== s.lastTrig) {
        s.lastTrig = trig;
        s.env = 1;
      }
      const decay = Math.max(0.01, binding.decay ?? 0.4);
      s.env *= Math.exp(-(ctx.dt || 0) / decay);
      const attack = binding.attack ?? 0;
      const shaped = attack > 0 ? Math.pow(s.env, 1 / (1 + attack * 4)) : s.env;
      return numericBase + depth * shaped;
    }

    case 'expr': {
      const compiled = compileExpression(binding.code || '0');
      if (!compiled.call) return numericBase;
      try {
        const v = compiled.call(expressionScope(ctx, numericBase, def));
        if (typeof v === 'number' && isFinite(v)) return v;
        if (typeof v === 'string' || typeof v === 'boolean') return v;
        return numericBase;
      } catch (err) {
        // A broken expression shouldn't stop the show — fall back to the base
        // and let the control tab report it.
        binding.__error = err.message;
        return numericBase;
      }
    }

    default:
      return base;
  }
}

/**
 * Resolve every parameter of a layer for one target instance.
 *
 * @param {object} effectDef effect module (for its `params` schema)
 * @param {object} layer     the layer holding static values + bindings
 * @param {object} ctx       evaluation context
 * @returns {object} plain params object ready to hand to the effect
 */
/**
 * The layer's parameters with no modulation applied.
 *
 * This is what an effect should build a cache key from. A bound parameter is,
 * by definition, a different number every frame, so any structure cached
 * against the *resolved* value is rebuilt every frame the moment somebody
 * points a microphone at it — which is how binding a slider to audio could take
 * a wall of ivy from one `drawImage` a frame to regrowing itself sixty times a
 * second, and the machine with it.
 *
 * It is the same for every target of a layer and changes only when somebody
 * moves a slider, so callers should resolve it once per layer per frame.
 */
export function baseParams(effectDef, layer) {
  const out = {};
  for (const def of effectDef?.params || []) {
    out[def.key] = layer.params?.[def.key] !== undefined ? layer.params[def.key] : def.default;
  }
  return out;
}

export function resolveParams(effectDef, layer, ctx) {
  const out = {};
  const defs = effectDef?.params || [];
  for (const def of defs) {
    const base = layer.params?.[def.key] !== undefined ? layer.params[def.key] : def.default;
    const binding = layer.bindings?.[def.key];
    // The key is passed alongside rather than spread into a copy of ctx: this
    // runs once per bound parameter per target per frame, and cloning a
    // twenty-key context object each time is pure waste.
    let value = binding
      ? evaluateBinding(binding, base, def, ctx, `${layer.id}:${def.key}`)
      : base;

    if (def.type === 'range' || def.type === 'number') {
      if (typeof value !== 'number' || !isFinite(value)) value = def.default ?? 0;
      if (def.min !== undefined) value = Math.max(def.min, value);
      if (def.max !== undefined) value = Math.min(def.max, value);
    } else if (def.type === 'bool') {
      value = typeof value === 'number' ? value > 0.5 : !!value;
    } else if (binding && typeof base === 'string') {
      // Modulation is arithmetic, and there is no arithmetic on a colour or a
      // string. The UI only offers bindings on numeric parameters, but an
      // imported project or a hand-edited one can carry a stray one — and the
      // result was a colour that evaluated to a bare number, which every
      // consumer then failed to parse into something different every frame.
      value = base;
    }
    out[def.key] = value;
  }
  return out;
}

/** Human-readable one-liner for the binding chip in the inspector. */
export function describeBinding(binding) {
  if (!binding || binding.type === 'const') return null;
  switch (binding.type) {
    case 'lfo':
      return `${binding.wave || 'sine'} ${binding.sync ? `1/${binding.rate ?? 1} bar` : `${(binding.rate ?? 0.5).toFixed(2)} Hz`}`;
    case 'audio':
      return `audio ${binding.band || 'level'}`;
    case 'random':
      return `random ${(binding.rate ?? 2).toFixed(1)}/s`;
    case 'env':
      return `env 1/${binding.division ?? 1}`;
    case 'expr':
      return `= ${String(binding.code || '').slice(0, 24)}`;
    default:
      return binding.type;
  }
}
