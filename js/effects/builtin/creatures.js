/**
 * Things that move across the house.
 *
 * A flock, a firework, a face in a window. These are the moments people
 * actually point at, and they work because they are *events* — something
 * happens, then it stops, then later it happens again. An effect that runs
 * continuously becomes wallpaper within a minute; one that appears every couple
 * of minutes keeps a crowd watching.
 *
 * That is why most of these have an interval rather than just a speed.
 */

import { rgba, clamp, lerp, TAU, frac, mixHex } from '../../core/math.js';
import { blackbodyCss, mixLinear } from '../color.js';
import { offscreen } from '../lib.js';

/**
 * A small integer hash to [0, 1).
 *
 * Everything below that has to be the same in every tab — which star of which
 * shell goes where, which frame a glint lands on — is a function of a couple of
 * integers. A seeded generator per shell per frame would do the same job with a
 * closure and a string allocated each time; this does it with four multiplies.
 */
function hash01(a, b) {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * A round soft light: a white-hot centre, the colour round it, and a long
 * faint skirt, baked once and stamped.
 *
 * The stops follow the same inverse-square falloff as `fx.glow`, with the core
 * pushed to white, because that is what a small bright source looks like: so
 * bright in the middle that it clips past its colour, and only the scattered
 * light round it shows the hue. A disc of flat colour is a sticker.
 */
function lightSprite(colour, size = 64, core = 0.16) {
  const canvas = offscreen(size, size);
  const c = canvas.getContext('2d');
  const h = size / 2;
  const grad = c.createRadialGradient(h, h, 0, h, h, h);
  const hot = mixLinear(colour, '#ffffff', 0.75);
  grad.addColorStop(0, rgba('#ffffff', 1));
  grad.addColorStop(core * 0.55, rgba(hot, 1));
  grad.addColorStop(core, rgba(colour, 0.9));
  grad.addColorStop(core + 0.14, rgba(colour, 0.46));
  grad.addColorStop(core + 0.34, rgba(colour, 0.16));
  grad.addColorStop(0.78, rgba(colour, 0.04));
  grad.addColorStop(1, rgba(colour, 0));
  c.fillStyle = grad;
  c.fillRect(0, 0, size, size);
  return canvas;
}

/* ------------------------------------------------------------------ *
 * Bats
 * ------------------------------------------------------------------ */

const bats = {
  id: 'bats',
  name: 'Bat Swarm',
  category: 'halloween',
  scope: 'shape',
  description:
    'A flock crossing the frame with flapping wings and a bit of flocking wander. Set an interval so they arrive, then leave.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#12040f' },
    { key: 'silhouette', type: 'bool', label: 'Cut out of light', default: false },
    { key: 'count', type: 'range', label: 'Bats', default: 14, min: 1, max: 80, step: 1 },
    { key: 'size', type: 'range', label: 'Wingspan', default: 0.09, min: 0.01, max: 0.5, step: 0.005 },
    { key: 'speed', type: 'range', label: 'Speed', default: 0.16, min: 0.01, max: 1.5, step: 0.005 },
    { key: 'flap', type: 'range', label: 'Flap rate', default: 7, min: 0.5, max: 24, step: 0.1 },
    { key: 'spread', type: 'range', label: 'Flock spread', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'wander', type: 'range', label: 'Wander', default: 0.35, min: 0, max: 1, step: 0.01 },
    { key: 'direction', type: 'select', label: 'Direction', default: 'right', options: ['right', 'left'] },
    { key: 'interval', type: 'range', label: 'Every (s)', default: 0, min: 0, max: 600, step: 1 },
    { key: 'crossing', type: 'range', label: 'Crossing time (s)', default: 12, min: 1, max: 120, step: 0.5 },
  ],
  init() {
    return { flock: null, count: 0 };
  },
  /**
   * Cast the flock, at a moment every tab agrees on.
   *
   * Everything else here is a function of `t`, so the flock is the only thing
   * that could differ between two tabs — and it would have, because it used to
   * be cast on the first frame *drawn* and `rng` is seeded from the simulation
   * step the frame landed on. Casting from `step` puts it on step one always.
   */
  step({ p, rng, state }) {
    const count = Math.round(p.count);
    if (state.count === count) return;
    state.count = count;
    state.flock = Array.from({ length: count }, () => ({
      lane: rng(),
      lead: rng(),
      scale: 0.6 + rng() * 0.8,
      seed: rng() * 100,
      flapOffset: rng() * TAU,
    }));
  },
  draw({ g, p, shape, t, state, noise }) {
    const { bbox } = shape;
    if (!state.flock) return;

    // interval 0 means "always flying"; otherwise they arrive on a schedule.
    let phaseT = t;
    if (p.interval > 0) {
      const cycle = t % Math.max(1, p.interval);
      if (cycle > p.crossing) return;
      phaseT = cycle;
    }

    const dir = p.direction === 'left' ? -1 : 1;
    const span = p.interval > 0 ? phaseT / Math.max(0.1, p.crossing) : frac(phaseT * p.speed);

    g.save();
    g.clip(shape.path);
    const alpha = g.globalAlpha;
    if (p.silhouette) {
      g.globalCompositeOperation = 'destination-out';
      g.fillStyle = '#000';
    } else {
      g.fillStyle = p.color;
    }

    for (const bat of state.flock) {
      // Each bat trails the leader by its own amount, so the flock is strung out.
      const progress = span - bat.lead * p.spread * 0.5;
      if (progress < -0.2 || progress > 1.2) continue;

      const baseX = dir > 0 ? bbox.x - bbox.w * 0.15 : bbox.x + bbox.w * 1.15;
      const x = baseX + dir * progress * bbox.w * 1.3;
      const laneY = bbox.y + lerp(0.15, 0.85, bat.lane) * bbox.h;
      const wanderY = noise.noise2(phaseT * 0.5 + bat.seed, 0) * bbox.h * 0.12 * p.wander;
      const wanderX = noise.noise2(phaseT * 0.4 + bat.seed + 50, 0) * bbox.w * 0.05 * p.wander;
      const y = laneY + wanderY;
      // Which way the wander is taking it, for the bank: a bat climbing tips its
      // nose up, one dropping tips it down. Read off the same noise a moment on.
      const ahead = noise.noise2(phaseT * 0.5 + 0.08 + bat.seed, 0) * bbox.h * 0.12 * p.wander;
      const bank = clamp((ahead - wanderY) / Math.max(1, bbox.h * 0.004), -1, 1) * 0.28;

      const phase = phaseT * p.flap * TAU * 0.5 + bat.flapOffset;
      drawBat(g, x + wanderX, y, bbox.h * p.size * bat.scale, phase, dir, bank * dir, alpha);
    }
    g.restore();
  },
};

/**
 * One wing, as the membrane between the fingers.
 *
 * A bat's wing is a hand: four long fingers with skin stretched between them,
 * so the trailing edge is a run of scallops, each hanging between two
 * fingertips — and that scalloped edge, with the hooked thumb and the pointed
 * ears, is what reads as "bat" rather than "bird" from the pavement. Smooth
 * curves throughout, because a silhouette is nothing *but* its edge.
 *
 * `up` is how far the wing is raised (-1 down, 1 up) and `fold` how far it is
 * closed: on the upstroke a bat folds its wing half shut to slip it back
 * through the air, which is the other half of why the flight looks like a bat.
 * A wing raised or lowered hard is also seen nearly edge-on, so its membrane
 * is shallower then than when it is spread flat towards the street — which
 * keeps the downstroke a pair of slim drooping blades rather than a heavy arch.
 * Slim throughout, in fact: a bat's wing is long and narrow, a sixth or so of
 * its span from front to back, and a stubby one reads as a moth.
 * Drawn for the right-hand wing; the caller mirrors it.
 */
function traceWing(g, s, up, fold) {
  const reach = s * (0.5 - 0.17 * fold);
  const lift = up * s * 0.3;
  const deep = s * (0.55 + 0.45 * (1 - Math.abs(up)));
  const sx = s * 0.05;
  const sy = -s * 0.03;
  const wx = reach * 0.42;
  const wy = -s * 0.1 - lift * 0.55;
  const tip = { x: reach, y: -lift * 1.05 + s * 0.02 };
  const f2 = { x: reach * 0.8, y: deep * 0.1 - lift * 0.74 };
  const f3 = { x: reach * 0.56, y: deep * 0.15 - lift * 0.48 };
  const hip = { x: s * 0.07, y: deep * 0.11 };

  g.moveTo(sx, sy);
  // Leading edge: forearm out to the wrist, a slight bump for the thumb, then
  // the long finger out to the tip.
  g.quadraticCurveTo(wx * 0.5, wy - s * 0.03, wx, wy);
  g.lineTo(wx + s * 0.012, wy - s * 0.028);
  g.quadraticCurveTo(lerp(wx, tip.x, 0.55), lerp(wy, tip.y, 0.55) - s * 0.03, tip.x, tip.y);
  // The scallops, each sagging in towards the body between two fingertips.
  g.quadraticCurveTo(lerp(tip.x, f2.x, 0.5) - s * 0.05, lerp(tip.y, f2.y, 0.5) - deep * 0.01, f2.x, f2.y);
  g.quadraticCurveTo(lerp(f2.x, f3.x, 0.5) - s * 0.02, lerp(f2.y, f3.y, 0.5) - deep * 0.06, f3.x, f3.y);
  g.quadraticCurveTo(lerp(f3.x, hip.x, 0.5) + s * 0.01, lerp(f3.y, hip.y, 0.5) - deep * 0.06, hip.x, hip.y);
  g.closePath();
}

/**
 * One bat: body, ears and two wings, with the wings smeared through the flap.
 *
 * At several beats a second, over the thirtieth of a second a camera or an eye
 * integrates across, a bat's wing is never in one place: the body is sharp and
 * the wings are a fan of everywhere they have just been. So each wing is drawn
 * at three moments across that interval, faintest at the ends — the same
 * shape the eye actually gets, and a still that shows the motion instead of
 * freezing it into a paper cut-out. `phase` is the flap's angle, in radians.
 */
function drawBat(g, x, y, span, phase, dir, bank, alpha) {
  g.save();
  g.translate(x, y);
  g.rotate(bank);
  g.scale(dir, 1);

  const smear = [[-0.42, 0.2], [0.42, 0.2], [0, 1]];
  for (const [shift, a] of smear) {
    const ph = phase + shift;
    const up = Math.sin(ph);
    // Folded on the way up (wing rising), spread on the way down.
    const fold = clamp(0.5 + 0.5 * Math.cos(ph), 0, 1) * 0.85;
    g.globalAlpha = alpha * a;
    g.beginPath();
    traceWing(g, span, up, fold);
    g.save();
    g.scale(-1, 1);
    traceWing(g, span, up, fold);
    g.restore();
    g.fill();
  }

  g.globalAlpha = alpha;
  // Body: a furred torso tapering to the tail, and a head with two tall ears.
  g.beginPath();
  g.ellipse(0, span * 0.03, span * 0.055, span * 0.11, 0, 0, TAU);
  g.moveTo(-span * 0.045, -span * 0.06);
  g.quadraticCurveTo(-span * 0.06, -span * 0.12, -span * 0.05, -span * 0.16);
  g.quadraticCurveTo(-span * 0.025, -span * 0.13, -span * 0.012, -span * 0.105);
  g.lineTo(span * 0.012, -span * 0.105);
  g.quadraticCurveTo(span * 0.025, -span * 0.13, span * 0.05, -span * 0.16);
  g.quadraticCurveTo(span * 0.06, -span * 0.12, span * 0.045, -span * 0.06);
  g.closePath();
  g.fill();

  g.restore();
}

/* ------------------------------------------------------------------ *
 * Fireworks
 * ------------------------------------------------------------------ */

/**
 * How long a shell takes to reach apogee, in seconds.
 *
 * Up here rather than inside `draw` because `cues` needs the same number to
 * tell the soundscape when the break happens, and two copies of it would drift
 * the bang off the flash the first time anybody tuned one of them.
 */
const SHELL_RISE = 0.9;

/**
 * When shell `index` leaves the ground.
 *
 * On the beat Shells/min sets, nudged off it by up to a fifth of an
 * interval either way. A display fired on a metronome looks like a screensaver;
 * a real one comes in uneven volleys, which is also what puts several shells at
 * *different* stages into any one moment — one breaking, one hanging, one
 * burning out. Never enough to swap two shells round, never before the show
 * starts, and a function of the index alone, so `cues` hears exactly the
 * launches `draw` shows.
 */
function launchOf(index, interval) {
  const nudge = index === 0 ? hash01(index, 0x51) * 0.2 : (hash01(index, 0x51) - 0.5) * 0.4;
  return (index + nudge) * interval;
}

/**
 * The kinds of shell, as physics.
 *
 * Every one is the same thing — a sphere of burning stars thrown out at the
 * break, slowed hard by the air and pulled down by gravity — with different
 * numbers. `drag` is how quickly a star loses its speed (per second), `fall`
 * scales gravity, `life` the burn time, `tail` how many seconds of path each
 * star drags behind it. A peony is short sharp streaks of colour; a
 * chrysanthemum's stars shed glittering gold as they go; a willow's burn long
 * and slow and droop like the tree; a crackle shell's stars end by bursting
 * into white crackle; a ring is a sphere flattened to a hoop.
 */
const KINDS = {
  peony: { drag: 2.6, fall: 1, life: 1, tail: 0.32, jitter: 0.07, glitter: 0, crackle: 0, ring: 0, width: 1 },
  chrysanthemum: { drag: 2.3, fall: 1, life: 1.05, tail: 0.85, jitter: 0.1, glitter: 0.24, crackle: 0, ring: 0, width: 0.9 },
  willow: { drag: 1.75, fall: 1.4, life: 1.6, tail: 1.6, jitter: 0.14, glitter: 0.14, crackle: 0, ring: 0, width: 0.8 },
  crackle: { drag: 2.6, fall: 1, life: 0.62, tail: 0.3, jitter: 0.08, glitter: 0, crackle: 1, ring: 0, width: 1 },
  ring: { drag: 2.6, fall: 1, life: 0.95, tail: 0.28, jitter: 0.04, glitter: 0, crackle: 0, ring: 1, width: 1 },
};

/** Which kinds each palette fires, and how often. Cumulative odds. */
const MIX = {
  multi: [['peony', 0.34], ['chrysanthemum', 0.58], ['willow', 0.72], ['crackle', 0.88], ['ring', 1]],
  warm: [['peony', 0.3], ['chrysanthemum', 0.6], ['willow', 0.84], ['crackle', 1]],
  cool: [['peony', 0.42], ['chrysanthemum', 0.62], ['crackle', 0.8], ['ring', 1]],
  gold: [['chrysanthemum', 0.42], ['willow', 0.82], ['crackle', 1]],
  single: [['peony', 0.45], ['chrysanthemum', 0.75], ['ring', 1]],
};

const PALETTES = {
  multi: ['#ff3b6b', '#ffd166', '#4cc2ff', '#8aff80', '#c77dff'],
  warm: ['#ff8a3d', '#ffd166', '#ff5c5c'],
  cool: ['#7fd8ff', '#a0b8ff', '#c77dff'],
  gold: ['#ffd166', '#ffb347', '#fff3c4'],
};

/** Gold for the charcoal tails and the willows: burning iron and carbon, so blackbody. */
const GOLD = blackbodyCss(2250);
const EMBER = blackbodyCss(1600);

/**
 * The trail is stroked in `TRAIL_BANDS` fading pieces, and sampled twice per
 * piece so that each can be a curve through its middle sample rather than a
 * straight chord: a willow's trail is a long droop, and four straight pieces of
 * it are four visible facets.
 */
const TRAIL_BANDS = 4;
const SAMPLES = TRAIL_BANDS * 2 + 1;

/** Star positions along their trails, for the shell being drawn. Grown, never per frame. */
let SX = new Float64Array(0);
let SY = new Float64Array(0);
/** Each star's own burn time, and whether it is drawn this frame. */
let SLIFE = new Float64Array(0);
let SLIVE = new Uint8Array(0);
/** Each star's direction and launch speed, for the crackle at the end of its burn. */
let SUX = new Float64Array(0);
let SUY = new Float64Array(0);
let SV = new Float64Array(0);

function reserveStars(n) {
  if (SLIFE.length >= n) return;
  const cap = Math.max(64, n);
  SX = new Float64Array(cap * SAMPLES);
  SY = new Float64Array(cap * SAMPLES);
  SLIFE = new Float64Array(cap);
  SLIVE = new Uint8Array(cap);
  SUX = new Float64Array(cap);
  SUY = new Float64Array(cap);
  SV = new Float64Array(cap);
}

/** The shell being drawn, written per shell and reused. */
const SHELL = {
  kind: KINDS.peony, x: 0, y: 0, launchX: 0, ground: 0, a: '#fff', b: '#fff', c: null, d: null,
  twoTone: false, changeAt: 1, size: 1, spin: 0, tilt: 0, roll: 0, flat: 1, seed: 0,
};

function castShell(index, p, bbox, palette) {
  const h = (salt) => hash01(index, salt);
  const mix = MIX[p.palette] || MIX.multi;
  const roll = h(1);
  let name = mix[mix.length - 1][0];
  for (const [kind, upTo] of mix) {
    if (roll < upTo) {
      name = kind;
      break;
    }
  }
  const sh = SHELL;
  sh.kind = KINDS[name];
  sh.seed = (index * 7919) | 0;
  sh.x = bbox.x + (0.1 + 0.8 * h(2)) * bbox.w;
  sh.y = bbox.y + (0.07 + 0.36 * h(3)) * bbox.h;
  sh.launchX = sh.x + (h(4) - 0.5) * bbox.w * 0.08;
  sh.ground = bbox.y + bbox.h;
  const n = palette.length;
  const first = Math.floor(h(5) * n) % n;
  const second = n > 1 ? (first + 1 + Math.floor(h(6) * (n - 1))) % n : first;
  sh.a = palette[first];
  sh.b = palette[second];
  sh.twoTone = name === 'peony' && n > 1 && h(7) < 0.3;
  // Colour-changing stars: a layer of a second composition under the first,
  // so the whole sphere switches colour together part way through its burn.
  const changes = (name === 'peony' || name === 'ring') && n > 1 && h(8) < 0.45;
  sh.c = changes ? palette[(first + 2) % n] : null;
  sh.d = changes ? palette[(second + 2) % n] : null;
  sh.changeAt = 0.42 + 0.2 * h(9);
  // Mixed calibres: a display is not all the same size of shell.
  sh.size = 0.72 + 0.42 * h(10);
  sh.spin = h(11) * TAU;
  sh.tilt = (h(12) - 0.5) * 1.3;
  sh.roll = (h(13) - 0.5) * 1.6;
  sh.flat = 0.25 + 0.5 * h(14);
  return sh;
}

/** A star's colour at `tau` seconds after the break. */
function starColour(sh, group, tau, life) {
  if (sh.kind === KINDS.willow) return GOLD;
  if (sh.c && tau > life * sh.changeAt) return group ? sh.d : sh.c;
  return group ? sh.b : sh.a;
}

/**
 * Bake every sprite a layer of fireworks can use, all at once.
 *
 * All at once because a shell of a new colour can turn up on any frame, and a
 * sprite baked the first time one does is a canvas allocated in the middle of
 * the show. Keyed on the palette from `stable`, so nothing modulated can force
 * a rebake.
 */
function fireworkSprites(state, stable) {
  const palette = stable.palette === 'single' ? [stable.color] : PALETTES[stable.palette] || PALETTES.multi;
  const key = `${stable.palette}|${stable.color}`;
  if (state.sprites && state.spriteKey === key) return state.sprites;
  const stars = new Map();
  for (const colour of [...palette, GOLD, EMBER, '#ffffff']) {
    if (!stars.has(colour)) stars.set(colour, lightSprite(colour, 48, 0.14));
  }
  state.sprites = {
    palette,
    stars,
    flash: lightSprite('#ffe2a8', 128, 0.1),
    fleck: lightSprite('#fff6e0', 24, 0.2),
  };
  state.spriteKey = key;
  return state.sprites;
}

/**
 * Where star `s` of the shell is, `tau` seconds after the break, into SX/SY.
 *
 * The exact motion of something thrown out against air resistance and
 * gravity: velocity decays as e^(-k t), so the position approaches its
 * terminal distance `v0 / k`, while gravity pulls it towards a terminal fall
 * speed `g / k`. Out fast, stop, then droop — which is the shape of every
 * firework ever photographed, and the one thing an ease-out and a parabola
 * stuck together never quite get.
 */
function starPath(sh, ux, uy, speed, k, fall, tail, head, at) {
  for (let j = 0; j < SAMPLES; j++) {
    const tau = tail + ((head - tail) * j) / (SAMPLES - 1);
    const d = (1 - Math.exp(-k * tau)) / k;
    SX[at + j] = sh.x + ux * speed * d;
    SY[at + j] = sh.y + uy * speed * d + (fall * (tau - d)) / k;
  }
}

function drawShell(g, base, sh, tau, sprites, p, bbox, t) {
  const kind = sh.kind;
  const scale = Math.min(bbox.w, bbox.h);
  const n = Math.max(8, Math.round(kind.ring ? Math.min(p.sparks, 72) : p.sparks));
  reserveStars(n);

  const k = kind.drag;
  const reach = scale * p.power * sh.size;
  const v0 = reach * k;
  const fall = p.gravity * bbox.h * kind.fall;
  const life = p.life * kind.life;
  const tailSec = kind.tail;
  const gain = clamp(p.level, 0, 2);

  // The shell's own envelope: full until most of the stars are burning out.
  const envelope = tau < life * 0.8 ? 1 : clamp(1 - (tau - life * 0.8) / (life * 0.45), 0, 1);
  const cosT = Math.cos(sh.tilt);
  const sinT = Math.sin(sh.tilt);
  const cosR = Math.cos(sh.roll);
  const sinR = Math.sin(sh.roll);

  let any = false;
  for (let s = 0; s < n; s++) {
    // Even cover of the sphere: a golden-angle spiral, turned to a random
    // attitude. Random directions clump and leave holes, and a real shell's
    // stars are packed round its bursting charge by hand.
    let ux;
    let uy;
    if (kind.ring) {
      const a = (s / n) * TAU + sh.spin;
      const rx = Math.cos(a);
      const ry = Math.sin(a) * sh.flat;
      ux = rx * cosR - ry * sinR;
      uy = rx * sinR + ry * cosR;
    } else {
      const z = 1 - (2 * s + 1) / n;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      const phi = s * 2.399963229728653 + sh.spin;
      ux = r * Math.cos(phi);
      const y0 = r * Math.sin(phi);
      uy = y0 * cosT - z * sinT;
    }
    const speed = v0 * (1 + (hash01(sh.seed + s, 1) - 0.5) * 2 * kind.jitter);
    const own = life * (0.84 + 0.3 * hash01(sh.seed + s, 2));
    SLIFE[s] = own;
    SUX[s] = ux;
    SUY[s] = uy;
    SV[s] = speed;
    const head = Math.min(tau, own);
    const tail = Math.max(0, tau - tailSec);
    if (tail >= head) {
      SLIVE[s] = 0;
      continue;
    }
    SLIVE[s] = 1;
    any = true;
    starPath(sh, ux, uy, speed, k, fall, tail, head, s * SAMPLES);
  }
  if (!any && !(kind.crackle && tau < life * 1.9)) return;

  const width = Math.max(1, scale * 0.0036 * kind.width * (0.8 + 0.4 * sh.size));

  /**
   * The trails, stroked in bands from the tail up to the head.
   *
   * Each band is one path holding that piece of every star's trail, so a
   * hundred stars cost a handful of strokes rather than hundreds — and each
   * band is brighter and wider than the one behind it, so a trail tapers and
   * fades into the dark rather than ending in a blunt line. A peony's trail is
   * the star's own colour, motion blur and nothing more; a chrysanthemum's and
   * a willow's are the gold of the charcoal the star sheds as it burns, cooling
   * to red towards the far end.
   */
  g.lineJoin = 'round';
  const groups = sh.twoTone ? 2 : 1;
  const glittery = kind.glitter > 0;
  // A short trail is a chord whatever it is drawn with; only a long one shows
  // its droop, and only that is worth a curve.
  const curved = tailSec > 0.5;
  for (let b = 0; b < TRAIL_BANDS; b++) {
    const toward = (b + 1) / TRAIL_BANDS;
    // Seconds before now that this band's head end was laid down.
    const ago = tailSec * (1 - toward);
    const core = width * (0.3 + 0.7 * toward) * (glittery ? 0.8 : 1);
    const bright = envelope * (glittery ? 0.85 : 0.8) * toward ** 1.3;
    for (let grp = 0; grp < groups; grp++) {
      if (glittery) g.strokeStyle = b < TRAIL_BANDS - 1 ? blackbodyCss(1500 + 700 * toward) : GOLD;
      else g.strokeStyle = starColour(sh, grp, Math.max(0, tau - ago), life);
      g.beginPath();
      for (let s = grp; s < n; s += groups) {
        if (!SLIVE[s]) continue;
        const at = s * SAMPLES + b * 2;
        g.moveTo(SX[at], SY[at]);
        if (curved) {
          // The control point that puts the curve through the middle sample.
          g.quadraticCurveTo(
            2 * SX[at + 1] - (SX[at] + SX[at + 2]) / 2,
            2 * SY[at + 1] - (SY[at] + SY[at + 2]) / 2,
            SX[at + 2], SY[at + 2],
          );
        } else {
          g.lineTo(SX[at + 2], SY[at + 2]);
        }
      }
      // The newest two bands twice: a wide faint pass for the glow of the
      // trail and a narrow bright one for the trail itself, from the same path.
      // Butt-ended except at the head, or the overlapping caps of neighbouring
      // bands add up into beads.
      g.lineCap = b === TRAIL_BANDS - 1 ? 'round' : 'butt';
      if (b >= TRAIL_BANDS - 2) {
        g.lineWidth = core * 3.2;
        g.globalAlpha = base * Math.min(1, gain * bright * 0.2);
        g.stroke();
      }
      g.lineWidth = core;
      g.globalAlpha = base * Math.min(1, gain * bright);
      g.stroke();
    }
  }

  /**
   * The stars themselves, each a sprite with a white-hot core.
   *
   * White for the first instants after the break, when the stars have only
   * just been lit by the burst charge; then their colour; then a strobing
   * burn-out, each on its own clock, so a shell does not switch off all at
   * once like a lamp. A willow's stars are burning charcoal, and cool from gold
   * to a dull red as they go.
   */
  const dot = Math.max(4, scale * 0.017 * (0.8 + 0.35 * sh.size) * (kind === KINDS.willow ? 0.75 : 1));
  const strobeTick = Math.floor(t * 24);
  for (let s = 0; s < n; s++) {
    if (!SLIVE[s] || tau >= SLIFE[s]) continue;
    const own = SLIFE[s];
    const at = s * SAMPLES + SAMPLES - 1;
    let a = envelope;
    if (tau > own * 0.72) {
      const left = 1 - (tau - own * 0.72) / (own * 0.28);
      a *= left * (hash01(sh.seed + s, strobeTick) < 0.6 ? 1 : 0.25);
    }
    let colour = tau < 0.06 ? '#ffffff' : starColour(sh, sh.twoTone ? s & 1 : 0, tau, life);
    if (kind === KINDS.willow && tau > own * 0.7) colour = EMBER;
    const sprite = sprites.stars.get(colour) || sprites.stars.get('#ffffff');
    const r = dot * (tau < 0.12 ? 1.35 - tau * 2.9 : 1) * (kind === KINDS.willow ? 0.8 : 1);
    g.globalAlpha = base * Math.min(1, a * gain);
    g.drawImage(sprite, SX[at] - r, SY[at] - r, r * 2, r * 2);
  }

  /**
   * Glitter and crackle: the sparkle that makes a still look like fire rather
   * than like a diagram of it. Tiny white flashes along the trails, each alive
   * for a twenty-fourth of a second and chosen by hash, so they twinkle.
   */
  if (kind.glitter > 0) {
    const r = dot * 0.42;
    for (let s = 0; s < n; s++) {
      if (!SLIVE[s]) continue;
      for (let j = 1; j < SAMPLES - 1; j += 2) {
        if (hash01(sh.seed + s * 7 + j, strobeTick) >= kind.glitter) continue;
        const at = s * SAMPLES + j;
        g.globalAlpha = base * Math.min(1, envelope * gain * 0.9);
        g.drawImage(sprites.fleck, SX[at] - r, SY[at] - r, r * 2, r * 2);
      }
    }
  }
  if (kind.crackle) {
    // Each star ends by breaking into a cluster of white reports, scattered
    // round where it died and dropping as they go.
    const r = dot * 0.55;
    for (let s = 0; s < n; s++) {
      const own = SLIFE[s];
      if (tau < own || tau > own + 0.75) continue;
      const since = tau - own;
      const d = (1 - Math.exp(-k * own)) / k;
      const x = sh.x + SUX[s] * SV[s] * d;
      const y = sh.y + SUY[s] * SV[s] * d + (fall * (own - d)) / k + since * since * fall * 0.5;
      for (let q = 0; q < 3; q++) {
        const pop = hash01(sh.seed + s, 40 + q) * 0.6;
        const age = since - pop;
        if (age < 0 || age > 0.07) continue;
        const ox = (hash01(sh.seed + s, 50 + q) - 0.5) * dot * 2.6;
        const oy = (hash01(sh.seed + s, 60 + q) - 0.5) * dot * 2.6;
        g.globalAlpha = base * Math.min(1, gain * (1 - age / 0.07));
        g.drawImage(sprites.fleck, x + ox - r, y + oy - r, r * 2, r * 2);
      }
    }
  }

  /**
   * The break. A flash far brighter than any star, gone in a sixth of a
   * second, and the lit cloud of the burst charge's smoke round it, which
   * hangs on a little longer — the moment the whole sky lights up.
   */
  if (tau < 0.7) {
    const flash = tau < 0.16 ? (1 - tau / 0.16) ** 2 : 0;
    if (flash > 0) {
      const r = reach * 0.36;
      g.globalAlpha = base * Math.min(1, flash * gain);
      g.drawImage(sprites.flash, sh.x - r, sh.y - r, r * 2, r * 2);
    }
    const smoke = (1 - tau / 0.7) ** 2 * 0.26;
    const sprite = sprites.stars.get(starColour(sh, 0, 0, life)) || sprites.flash;
    const r = reach * 0.85;
    g.globalAlpha = base * Math.min(1, smoke * gain);
    g.drawImage(sprite, sh.x - r, sh.y - r, r * 2, r * 2);
  }
}

/**
 * The shell going up: a bright comet with a short tail of gold sparks, slowing
 * as it climbs to where it breaks.
 */
function drawRise(g, base, sh, age, sprites, p, bbox, t) {
  const f = age / SHELL_RISE;
  const ease = (u) => 1 - (1 - u) * (1 - u);
  const scale = Math.min(bbox.w, bbox.h);
  const sway = Math.sin(age * 9 + sh.seed) * scale * 0.002;
  const at = (u) => ({
    x: lerp(sh.launchX, sh.x, u) + sway,
    y: lerp(sh.ground, sh.y, ease(u)),
  });
  const gain = clamp(p.level, 0, 2);
  const head = at(f);
  const back = at(Math.max(0, f - 0.13));

  g.lineCap = 'round';
  for (let b = 0; b < 3; b++) {
    const u0 = lerp(Math.max(0, f - 0.13), f, b / 3);
    const u1 = lerp(Math.max(0, f - 0.13), f, (b + 1) / 3);
    const a = at(u0);
    const c = at(u1);
    g.strokeStyle = blackbodyCss(1500 + 450 * b);
    g.lineWidth = Math.max(1, scale * 0.0022 * (0.5 + 0.35 * b));
    g.globalAlpha = base * Math.min(1, gain * (0.25 + 0.3 * b) * (1 - f * 0.3));
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(c.x, c.y);
    g.stroke();
  }
  // Sparks falling off the tail.
  const tick = Math.floor(t * 20);
  const r = Math.max(2, scale * 0.006);
  for (let q = 0; q < 4; q++) {
    if (hash01(sh.seed + q, tick) > 0.55) continue;
    const u = hash01(sh.seed + q, tick + 999);
    const x = lerp(back.x, head.x, u) + (hash01(q, tick) - 0.5) * r * 3;
    const y = lerp(back.y, head.y, u) + hash01(q + 9, tick) * r * 4;
    g.globalAlpha = base * Math.min(1, gain * 0.8);
    g.drawImage(sprites.fleck, x - r, y - r, r * 2, r * 2);
  }
  const d = Math.max(3, scale * 0.012);
  g.globalAlpha = base * Math.min(1, gain);
  g.drawImage(sprites.stars.get(GOLD), head.x - d, head.y - d, d * 2, d * 2);
}

const fireworks = {
  id: 'fireworks',
  name: 'Fireworks',
  category: 'christmas',
  scope: 'shape',
  description:
    'Shells that rise, burst and fall with gravity and trails. Good for New Year, or a big finish.',
  params: [
    { key: 'palette', type: 'select', label: 'Palette', default: 'multi', options: ['multi', 'warm', 'cool', 'gold', 'single'] },
    { key: 'color', type: 'color', label: 'Single colour', default: '#ffd166' },
    { key: 'rate', type: 'range', label: 'Shells / min', default: 26, min: 1, max: 240, step: 1 },
    { key: 'sparks', type: 'range', label: 'Sparks per shell', default: 70, min: 8, max: 300, step: 1 },
    { key: 'power', type: 'range', label: 'Burst size', default: 0.32, min: 0.03, max: 1.2, step: 0.01 },
    { key: 'gravity', type: 'range', label: 'Gravity', default: 0.28, min: 0, max: 2, step: 0.01 },
    { key: 'life', type: 'range', label: 'Spark life (s)', default: 1.8, min: 0.3, max: 8, step: 0.05 },
    { key: 'trail', type: 'bool', label: 'Rising trail', default: true },
    { key: 'level', type: 'range', label: 'Brightness', default: 1, min: 0, max: 2, step: 0.01 },
  ],
  init() {
    return { sprites: null, spriteKey: null };
  },
  /**
   * When each shell leaves the ground and when it breaks, in show time.
   *
   * Two events per shell: the lift, which the sound follows up as a rush, and
   * the break, which is the bang. Both derive from the shell index the same way
   * `draw` derives the picture from it — `launchOf`, and the fixed rise — so the
   * report lands on the flash rather than near it; see `cue` in
   * core/soundscape.js. Sorted, because a nudged launch can fall between an
   * earlier shell's lift and its break.
   *
   * Once per layer, not once per target. A layer pointed at four windows draws
   * four bursts but they are the same four shells on the same clock, and four
   * copies of one bang is one muddy bang.
   */
  cues(p, from, to) {
    const interval = 60 / Math.max(1, p.rate);
    const events = [];
    const first = Math.max(0, Math.floor((from - SHELL_RISE) / interval - 0.3) - 1);
    const last = Math.floor(to / interval + 0.3) + 1;
    for (let index = first; index <= last; index++) {
      const launch = launchOf(index, interval);
      // Only when the rising trail is actually drawn: a sound for something
      // invisible is a sound coming from nowhere.
      if (p.trail && launch >= from && launch < to) {
        events.push({ at: launch, kind: 'rise', duration: SHELL_RISE, level: 1 });
      }
      const breaks = launch + SHELL_RISE;
      if (breaks >= from && breaks < to) {
        events.push({ at: breaks, kind: 'burst', level: clamp(0.45 + p.power * 0.55, 0.15, 1) });
      }
    }
    events.sort((a, b) => a.at - b.at);
    return events;
  },
  draw({ g, p, stable, shape, t, state }) {
    const { bbox } = shape;
    if (bbox.w <= 0 || bbox.h <= 0) return;
    const sprites = fireworkSprites(state, stable || p);

    const interval = 60 / Math.max(1, p.rate);
    // The longest anything can still be on the wall after its launch: a
    // willow's burn, its trail, and a crackle's last reports.
    const longest = SHELL_RISE + Math.max(0.3, p.life) * 1.75 + 1.2;
    const newest = Math.floor(t / interval + 0.3) + 1;
    const oldest = Math.max(0, Math.floor((t - longest) / interval - 0.3) - 1);
    if (newest < 0) return;

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';
    const base = g.globalAlpha;

    // Oldest first, so the shell that has just broken is drawn over the ones
    // already falling.
    for (let index = oldest; index <= newest; index++) {
      const launch = launchOf(index, interval);
      const age = t - launch;
      if (age < 0 || age > longest) continue;

      // Everything about this shell derives from its index, so all tabs agree
      // and no per-shell state has to be kept between frames.
      const sh = castShell(index, p, bbox, sprites.palette);
      if (age < SHELL_RISE) {
        if (p.trail) drawRise(g, base, sh, age, sprites, p, bbox, t);
        continue;
      }
      drawShell(g, base, sh, age - SHELL_RISE, sprites, p, bbox, t);
    }
    g.globalAlpha = base;
    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * Jack-o'-lantern
 * ------------------------------------------------------------------ */

/**
 * The pumpkin itself, baked: a ribbed orange body lit from inside, and a stem.
 *
 * A carved pumpkin at night is two lights, not one. The holes are the candle
 * seen directly, near white; the body is the same candle seen *through* an
 * inch of pumpkin, a deep orange glow that is brightest where the wall is
 * thinnest — the middle of each rib — and falls off to almost nothing in the
 * creases between them and round the rim. Those ribs and creases are what make
 * a round orange shape read as a pumpkin from across the road; without them it
 * is a ball. Baked once per window, because it is a lot of gradients and none
 * of it moves: the candle's flicker is applied as a brightness when it is
 * stamped.
 */
function bakePumpkin(w, h, colour) {
  const pad = Math.ceil(h * 0.22);
  const canvas = offscreen(Math.ceil(w) + 2, Math.ceil(h) + pad + 2);
  const c = canvas.getContext('2d');
  const cx = canvas.width / 2;
  const cy = pad + h / 2 + 1;

  const deep = mixLinear(colour, '#2a0600', 0.82);
  const skin = mixLinear(colour, '#3a0c00', 0.38);
  const hot = mixLinear(colour, '#ffc469', 0.22);

  // Five ribs, outermost first, each its own glowing lobe.
  const ribs = [[-0.66, 0.36], [0.66, 0.36], [-0.36, 0.42], [0.36, 0.42], [0, 0.44]];
  for (const [at, rx] of ribs) {
    const x = cx + at * w * 0.5;
    const rw = rx * w * 0.5;
    const rh = h * (0.5 - Math.abs(at) * 0.06);
    const grad = c.createRadialGradient(x, cy + h * 0.06, 0, x, cy + h * 0.06, Math.max(rw, rh) * 1.05);
    const edge = Math.abs(at) > 0.5 ? 0.72 : 1;
    grad.addColorStop(0, rgba(hot, 0.85 * edge));
    grad.addColorStop(0.45, rgba(skin, 0.85 * edge));
    grad.addColorStop(0.85, rgba(deep, 0.85));
    grad.addColorStop(1, rgba(deep, 0.6));
    c.fillStyle = grad;
    c.beginPath();
    c.ellipse(x, cy, rw, rh, 0, 0, TAU);
    c.fill();
  }

  // The creases between the ribs, as darker seams the light cannot get through.
  c.globalCompositeOperation = 'source-atop';
  c.lineCap = 'round';
  for (const at of [-0.5, -0.17, 0.17, 0.5]) {
    const x = cx + at * w * 0.5;
    const bow = at * w * 0.08;
    c.strokeStyle = rgba('#140300', 0.55);
    c.lineWidth = Math.max(1, w * 0.018);
    c.beginPath();
    c.moveTo(x - bow * 0.4, cy - h * 0.47);
    c.quadraticCurveTo(x + bow, cy, x - bow * 0.4, cy + h * 0.47);
    c.stroke();
  }
  // And the rim, where the curve turns away from the light.
  const rim = c.createRadialGradient(cx, cy + h * 0.05, Math.min(w, h) * 0.25, cx, cy, w * 0.56);
  rim.addColorStop(0, rgba('#000000', 0));
  rim.addColorStop(0.7, rgba('#000000', 0.15));
  rim.addColorStop(1, rgba('#000000', 0.6));
  c.fillStyle = rim;
  c.fillRect(0, 0, canvas.width, canvas.height);
  c.globalCompositeOperation = 'source-over';

  // The stem: dark, a little crooked, standing in a dimple at the top.
  c.fillStyle = rgba('#3b3a12', 0.95);
  c.beginPath();
  c.moveTo(cx - w * 0.045, cy - h * 0.45);
  c.quadraticCurveTo(cx - w * 0.05, cy - h * 0.58, cx - w * 0.01, cy - h * 0.66);
  c.lineTo(cx + w * 0.05, cy - h * 0.63);
  c.quadraticCurveTo(cx + w * 0.02, cy - h * 0.56, cx + w * 0.05, cy - h * 0.45);
  c.closePath();
  c.fill();

  return { canvas, x: -canvas.width / 2, y: -cy };
}

/**
 * The carved holes, in a -1..1 box across the pumpkin's face.
 *
 * Authored rather than generated, because a carving is a drawing: eyes that
 * are triangles with a slight curve to their sides, a nose, and a grin that is
 * a crescent with square teeth left in it. Every face is traced into the
 * current path; the caller fills it.
 */
function traceFace(g, face, open) {
  const eye = (side) => {
    const x = side * 0.38;
    const y = -0.3;
    switch (face) {
      case 'angry':
        g.moveTo(x - side * 0.25, y - 0.2);
        g.quadraticCurveTo(x, y - 0.02, x + side * 0.2, y + 0.06);
        g.quadraticCurveTo(x - side * 0.02, y + 0.12 * open + 0.03, x - side * 0.24, y + 0.1 * open);
        g.closePath();
        break;
      case 'surprised':
        g.moveTo(x + 0.17, y);
        g.ellipse(x, y, 0.17, 0.19 * open + 0.01, 0, 0, TAU);
        break;
      case 'grin':
        g.moveTo(x - 0.22, y + 0.08 * open);
        g.quadraticCurveTo(x, y - 0.3, x + 0.22, y + 0.08 * open);
        g.quadraticCurveTo(x, y - 0.1 * open, x - 0.22, y + 0.08 * open);
        g.closePath();
        break;
      case 'classic':
      default:
        g.moveTo(x, y - 0.24);
        g.quadraticCurveTo(x + 0.13, y - 0.04, x + 0.22, y + 0.15 * open + 0.01);
        g.quadraticCurveTo(x, y + 0.11 * open + 0.03, x - 0.22, y + 0.15 * open + 0.01);
        g.quadraticCurveTo(x - 0.13, y - 0.04, x, y - 0.24);
        g.closePath();
        break;
    }
  };
  eye(-1);
  eye(1);

  // The nose.
  if (face !== 'surprised') {
    g.moveTo(0, -0.05);
    g.lineTo(0.09, 0.11);
    g.lineTo(-0.09, 0.11);
    g.closePath();
  }

  // The mouth.
  if (face === 'surprised') {
    g.moveTo(0.2, 0.5);
    g.ellipse(0, 0.5, 0.2, 0.25, 0, 0, TAU);
    return;
  }
  const wide = face === 'grin' ? 0.74 : 0.64;
  const top = face === 'angry' ? 0.3 : 0.22;
  const drop = face === 'grin' ? 0.62 : 0.56;
  // Upper lip, left to right, with teeth hanging from it.
  g.moveTo(-wide, top - 0.06);
  const teeth = face === 'grin' ? [-0.38, 0.1] : face === 'angry' ? [-0.3, 0.12] : [-0.2];
  let x = -wide;
  const lipY = (u) => top + 0.12 * (1 - u * u);
  for (const at of teeth) {
    const u0 = at / wide;
    g.quadraticCurveTo((x + at) / 2, lipY(((x + at) / 2) / wide) + 0.02, at, lipY(u0));
    g.lineTo(at, lipY(u0) + 0.13);
    g.lineTo(at + 0.15, lipY((at + 0.15) / wide) + 0.13);
    g.lineTo(at + 0.15, lipY((at + 0.15) / wide));
    x = at + 0.15;
  }
  g.quadraticCurveTo((x + wide) / 2, lipY(((x + wide) / 2) / wide) + 0.02, wide, top - 0.06);
  // Lower lip back, right to left, with a tooth standing up from it.
  const lowY = (u) => top + drop * (1 - u * u) * 0.9;
  const up = face === 'angry' ? [0.28, -0.5] : [0.18];
  x = wide;
  for (const at of up) {
    const right = at + 0.15;
    g.quadraticCurveTo((x + right) / 2, lowY(((x + right) / 2) / wide) + 0.04, right, lowY(right / wide));
    g.lineTo(right, lowY(right / wide) - 0.13);
    g.lineTo(at, lowY(at / wide) - 0.13);
    g.lineTo(at, lowY(at / wide));
    x = at;
  }
  g.quadraticCurveTo((x - wide) / 2, lowY(((x - wide) / 2) / wide) + 0.04, -wide, top - 0.06);
  g.closePath();
}

const pumpkin = {
  id: 'pumpkin',
  name: 'Jack-o’-lantern',
  category: 'halloween',
  scope: 'shape',
  description:
    'A carved pumpkin glowing in the shape, with candle flicker behind its face. Put it in a window and it looks like somebody left one on the sill.',
  params: [
    { key: 'color', type: 'color', label: 'Glow colour', default: '#ff8c1a' },
    { key: 'inner', type: 'color', label: 'Inner colour', default: '#fff0a8' },
    { key: 'face', type: 'select', label: 'Face', default: 'classic', options: ['classic', 'grin', 'angry', 'surprised'] },
    { key: 'scale', type: 'range', label: 'Size', default: 0.92, min: 0.2, max: 1.4, step: 0.01 },
    { key: 'flicker', type: 'range', label: 'Flicker', default: 0.35, min: 0, max: 1, step: 0.01 },
    { key: 'rate', type: 'range', label: 'Flicker speed', default: 4, min: 0.2, max: 20, step: 0.1 },
    { key: 'level', type: 'range', label: 'Brightness', default: 1, min: 0, max: 2, step: 0.01 },
    { key: 'blink', type: 'range', label: 'Blink rate', default: 0.12, min: 0, max: 2, step: 0.01 },
    { key: 'glowSpill', type: 'range', label: 'Glow spill', default: 0.5, min: 0, max: 1, step: 0.01 },
  ],
  init() {
    return { body: null, bodyKey: null, inks: null };
  },
  draw({ g, p, stable, shape, t, noise, i, state }) {
    const { bbox } = shape;
    const base = stable || p;

    /**
     * As big as the window will take. A pumpkin is wider than it is tall, so
     * it is sized to whichever of the window's height and its width (over the
     * pumpkin's aspect) runs out first — and Size is that fraction of it. The
     * old face was sized to the smaller of width and height and then drew a
     * mouth only two thirds of that across, which in a bay window was a small
     * grin in a lot of glass.
     */
    const aspect = 1.28;
    const tall = Math.min(bbox.h * 0.92, bbox.w / aspect) * p.scale;
    const wide = tall * aspect;
    if (tall <= 4) return;

    // The candle: a fast flutter on a slower sway, and the odd gutter.
    const seed = i * 31.7;
    const flutter = noise.noise2(t * p.rate + seed, 0);
    const sway = noise.noise2(t * p.rate * 0.23 + seed, 7);
    const flick = 1 + p.flicker * (flutter * 0.45 + sway * 0.35);
    const level = clamp(p.level * flick, 0, 3);
    if (level <= 0.01) return;

    // Eyes shut briefly on their own slow cycle.
    let open = 1;
    if (p.blink > 0) {
      const cycle = frac(t * p.blink + seed);
      if (cycle < 0.05) open = Math.abs(cycle / 0.025 - 1);
    }

    const cx = bbox.cx;
    const cy = bbox.y + bbox.h * 0.5 + tall * 0.06;

    /**
     * The body, baked at the size the unmodulated Size gives and stamped at
     * this frame's — so an LFO on Size does not rebake it every frame — and
     * never baked bigger than a projector can show a pumpkin, because a shape
     * traced round a whole wall would otherwise ask for a canvas the size of
     * the wall. It is all soft gradients; scaled up, nothing is lost.
     *
     * The colours the carving is lit in are kept with it, since they are
     * mixes of two colour parameters and do not change from frame to frame.
     */
    const tallStable = Math.min(bbox.h * 0.92, bbox.w / aspect) * clamp(base.scale, 0.2, 1.4);
    const bakeTall = Math.max(8, Math.min(tallStable, 560));
    const key = `${Math.round(bakeTall)}|${base.color}|${base.inner}`;
    if (state.bodyKey !== key) {
      state.body = bakePumpkin(bakeTall * aspect, bakeTall, base.color);
      state.bodyKey = key;
      state.inks = [
        mixLinear(base.color, base.inner, 0.45),
        mixLinear(base.inner, base.color, 0.55),
        mixLinear(base.inner, base.color, 0.2),
        mixLinear(base.inner, '#ffffff', 0.3),
      ];
    }
    const body = state.body;
    const k = tall / bakeTall;

    g.save();
    g.clip(shape.path);
    const alpha = g.globalAlpha;

    // Light thrown round the window by the candle, on the reveal and the glass.
    if (p.glowSpill > 0) {
      const r = Math.max(bbox.w, bbox.h) * 0.75;
      const spill = g.createRadialGradient(cx, cy + tall * 0.1, 0, cx, cy + tall * 0.1, r);
      spill.addColorStop(0, rgba(p.color, 0.3 * Math.min(1.5, level) * p.glowSpill));
      spill.addColorStop(0.35, rgba(p.color, 0.1 * Math.min(1.5, level) * p.glowSpill));
      spill.addColorStop(1, rgba(p.color, 0));
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = spill;
      g.fillRect(bbox.x, bbox.y, bbox.w, bbox.h);
      g.globalCompositeOperation = 'source-over';
    }

    // The body glows with the candle too, but less: it is the same light
    // through a wall of pumpkin.
    if (body) {
      g.globalAlpha = alpha * clamp(0.55 + 0.45 * level, 0, 1);
      g.drawImage(body.canvas, cx + body.x * k, cy + body.y * k, body.canvas.width * k, body.canvas.height * k);
      g.globalAlpha = alpha;
    }

    g.translate(cx, cy);
    g.scale(wide / 2, tall / 2);

    /**
     * The carving, in two passes. First the cut wall of the pumpkin seen at an
     * angle round each hole — the inch of flesh the knife went through, lit hard
     * by the candle and showing as an orange rim on the far side of every cut.
     * Then the hole itself, the candle seen straight through it: near white at
     * the bottom of the mouth where the flame is, cooling to yellow at the top
     * of the eyes.
     */
    const [flesh, deepIn, midIn, hotIn] = state.inks;
    g.globalAlpha = alpha * clamp(level, 0, 1);
    g.fillStyle = flesh;
    g.beginPath();
    g.save();
    g.translate(0, 0.045);
    g.scale(1.04, 1.06);
    traceFace(g, p.face, open);
    g.restore();
    g.fill();

    const light = g.createLinearGradient(0, -0.6, 0, 0.8);
    light.addColorStop(0, deepIn);
    light.addColorStop(0.55, midIn);
    light.addColorStop(1, hotIn);
    g.fillStyle = light;
    g.beginPath();
    traceFace(g, p.face, open);
    g.fill();

    // And the glow the holes throw into the air in front of them.
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = alpha;
    const halo = g.createRadialGradient(0, 0.25, 0, 0, 0.25, 1.1);
    halo.addColorStop(0, rgba(p.inner, 0.1 * clamp(level, 0, 1.5)));
    halo.addColorStop(0.5, rgba(p.color, 0.05 * clamp(level, 0, 1.5)));
    halo.addColorStop(1, rgba(p.color, 0));
    g.fillStyle = halo;
    g.beginPath();
    g.arc(0, 0.25, 1.1, 0, TAU);
    g.fill();

    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * Glyph rain
 * ------------------------------------------------------------------ */

/**
 * The alphabet, drawn once into an atlas: every character twice, once in the
 * trail colour and once in the head colour, each with a soft glow baked round
 * it.
 *
 * Two reasons. A rain of characters on a wall reads as *light* only if each
 * one glows a little — screen phosphor, not print — and a glow per glyph per
 * frame is exactly the filter-per-particle trap. And `fillText` is one of the
 * dearer calls a canvas has: five windows of rain was four hundred of them a
 * frame, where a stamp from an atlas costs what any sprite costs.
 */
function bakeRuneAtlas(chars, cellW, cellH, colour, head) {
  // Room for the glow and no more: every stamp is the whole cell, so padding
  // is paid for on every character of every column every frame.
  const pad = Math.ceil(cellH * 0.12);
  const w = Math.ceil(cellW + pad * 2);
  const h = Math.ceil(cellH + pad * 2);
  // A grid rather than a strip, so a long alphabet in wide cells cannot run
  // past the largest canvas a browser will make.
  const across = Math.ceil(Math.sqrt(chars.length));
  const down = Math.ceil(chars.length / across);
  if (w * across > 4096 || h * down * 2 > 4096) return null;
  const canvas = offscreen(w * across, h * down * 2);
  const c = canvas.getContext('2d');
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.font = `${cellH * 0.85}px "SF Mono", Consolas, monospace`;
  const blur = Math.max(1, cellH * 0.05);
  for (const [ink, block] of [[colour, 0], [head, h * down]]) {
    for (let n = 0; n < chars.length; n++) {
      const x = (n % across) * w + w / 2;
      const y = block + Math.floor(n / across) * h + h / 2;
      // The glow, then the glyph sharp on top of it.
      if ('filter' in c) {
        c.filter = `blur(${blur.toFixed(2)}px)`;
        c.fillStyle = ink;
        c.fillText(chars[n], x, y);
        c.globalCompositeOperation = 'lighter';
        c.fillText(chars[n], x, y);
        c.globalCompositeOperation = 'source-over';
        c.filter = 'none';
      }
      c.fillStyle = ink;
      c.fillText(chars[n], x, y);
    }
  }

  /**
   * The streak: the column's own glow, a soft bar of light fading up from the
   * head. A rain of characters seen from across a road is a rain of *streaks*
   * — the characters are what you find when you walk up to it — so each falling
   * drop is laid over a faint stripe of its colour, brightest where it is now.
   */
  const streak = offscreen(16, 128);
  const sc = streak.getContext('2d');
  const along = sc.createLinearGradient(0, 0, 0, 128);
  along.addColorStop(0, rgba(colour, 0));
  along.addColorStop(0.75, rgba(colour, 0.5));
  along.addColorStop(1, rgba(head, 1));
  sc.fillStyle = along;
  sc.fillRect(0, 0, 16, 128);
  sc.globalCompositeOperation = 'destination-in';
  const across2 = sc.createLinearGradient(0, 0, 16, 0);
  across2.addColorStop(0, rgba('#ffffff', 0));
  across2.addColorStop(0.5, rgba('#ffffff', 1));
  across2.addColorStop(1, rgba('#ffffff', 0));
  sc.fillStyle = across2;
  sc.fillRect(0, 0, 16, 128);

  return { canvas, w, h, across, down, streak };
}

const runes = {
  id: 'runes',
  name: 'Glyph Rain',
  category: 'halloween',
  scope: 'shape',
  description:
    'Columns of falling characters with a bright leading edge. Set the alphabet to anything — numbers, letters, symbols.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#3dff88' },
    { key: 'head', type: 'color', label: 'Leading colour', default: '#eaffef' },
    { key: 'alphabet', type: 'text', label: 'Characters', default: 'アイウエオカキクケコサシスセソ0123456789' },
    { key: 'columns', type: 'range', label: 'Columns', default: 22, min: 3, max: 90, step: 1 },
    { key: 'speed', type: 'range', label: 'Speed', default: 6, min: 0.5, max: 40, step: 0.1 },
    { key: 'tail', type: 'range', label: 'Tail length', default: 12, min: 2, max: 40, step: 1 },
    { key: 'churn', type: 'range', label: 'Character churn', default: 6, min: 0, max: 30, step: 0.5 },
    { key: 'level', type: 'range', label: 'Brightness', default: 1, min: 0, max: 2, step: 0.01 },
  ],
  init() {
    return { columns: null, count: 0, atlas: null, atlasKey: null };
  },
  /** The columns' offsets and rates, cast on step one so every tab agrees. */
  step({ p, rng, state }) {
    const cols = Math.round(p.columns);
    if (state.count === cols) return;
    state.count = cols;
    state.columns = Array.from({ length: cols }, () => ({
      offset: rng() * 40,
      rate: 0.6 + rng() * 0.8,
      seed: Math.floor(rng() * 100000),
    }));
  },
  draw({ g, p, stable, shape, t, state }) {
    const { bbox } = shape;
    const chars = [...String(p.alphabet || 'X')];
    if (!chars.length || bbox.w <= 0 || bbox.h <= 0 || !state.columns) return;

    const cols = state.count;
    const cellW = bbox.w / cols;
    const cellH = cellW * 1.25;
    const rows = Math.ceil(bbox.h / cellH) + 1;
    const base = stable || p;

    /**
     * Baked for the column count the slider is set to, not the one this frame
     * happens to have: Columns can be bound to an LFO, the live count follows
     * it through `step`, and an atlas keyed on that would be rebaked at a
     * different moment in every tab. A modulated count stamps the same
     * characters at its own cell size instead.
     */
    const cellWStable = bbox.w / Math.max(1, Math.round(base.columns));
    const key = `${chars.join('')}|${cellWStable.toFixed(1)}|${base.color}|${base.head}`;
    if (state.atlasKey !== key) {
      state.atlas = cellWStable * 1.25 >= 3 && typeof document !== 'undefined'
        ? bakeRuneAtlas(chars, cellWStable, cellWStable * 1.25, base.color, base.head)
        : null;
      state.atlasKey = key;
    }
    const atlas = state.atlas;
    const stamp = cellW / cellWStable;

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';
    const alpha = g.globalAlpha;
    if (!atlas) {
      g.font = `${cellH * 0.85}px "SF Mono", Consolas, monospace`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
    }

    /**
     * The streaks first, all of them, then all the characters: two passes over
     * two textures rather than alternating between them, which is the
     * difference between the stamps batching together and not.
     */
    if (atlas) {
      g.globalAlpha = alpha * clamp(0.32 * p.level, 0, 1);
      const length = p.tail * cellH * 0.8;
      for (let c = 0; c < cols; c++) {
        const col = state.columns[c];
        const x = bbox.x + (c + 0.5) * cellW;
        for (let drop = 0; drop < 2; drop++) {
          const cycle = rows + p.tail;
          const head = (t * p.speed * col.rate + col.offset + drop * cycle * 0.5) % cycle;
          const bottom = bbox.y + (Math.floor(head) + 1) * cellH;
          if (bottom - length > bbox.y + bbox.h || bottom < bbox.y) continue;
          g.drawImage(atlas.streak, x - cellW * 0.35, bottom - length, cellW * 0.7, length);
        }
      }
    }

    for (let c = 0; c < cols; c++) {
      const col = state.columns[c];
      const x = bbox.x + (c + 0.5) * cellW;
      /**
       * Two drops a column, half a cycle apart. One left most columns empty
       * most of the time — at eight columns to a window that was a window with
       * three characters in it, which reads as a fault rather than as rain.
       */
      for (let drop = 0; drop < 2; drop++) {
        const cycle = rows + p.tail;
        const head = (t * p.speed * col.rate + col.offset + drop * cycle * 0.5) % cycle;
        for (let k = 0; k < p.tail; k++) {
          const row = Math.floor(head) - k;
          if (row < 0 || row > rows) continue;
          const y = bbox.y + (row + 0.5) * cellH;

          // Deterministic per (column, row, churn tick) so glyphs flicker in
          // place rather than the whole column re-rolling every frame.
          const churnTick = p.churn > 0 ? Math.floor(t * p.churn + row * 0.7) : 0;
          const hash = (col.seed + row * 2654435761 + churnTick * 40503 + drop * 977) >>> 0;
          const n = hash % chars.length;

          // A long fade rather than a steep one, so the column reads as a
          // streak; the head is the brightest thing in it by a distance.
          const fade = (1 - k / p.tail) ** 1.1;
          // A glyph that has just changed flashes, the way a refreshed cell does.
          const fresh = p.churn > 0 && frac(t * p.churn + row * 0.7) < 0.12 ? 1.3 : 1;
          const a = clamp((k === 0 ? 1 : fade * 0.95 * fresh) * p.level, 0, 1);
          if (a <= 0.01) continue;
          g.globalAlpha = alpha * a;
          if (atlas) {
            const sx = (n % atlas.across) * atlas.w;
            const sy = (Math.floor(n / atlas.across) + (k === 0 ? atlas.down : 0)) * atlas.h;
            g.drawImage(atlas.canvas, sx, sy, atlas.w, atlas.h,
              x - (atlas.w * stamp) / 2, y - (atlas.h * stamp) / 2, atlas.w * stamp, atlas.h * stamp);
          } else {
            g.fillStyle = k === 0 ? p.head : p.color;
            g.fillText(chars[n], x, y);
          }
        }
      }
    }
    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * Bees
 *
 * The thing that makes a bee a bee is the *path*, not the animal. Nobody at the
 * far side of a garden can resolve a striped body two inches long; what reads
 * from thirty feet is the flight — a dart, a hover, a right-angle turn, another
 * dart — and the dashed line is that flight made visible. So the drawing here
 * is mostly bookkeeping about where each bee has been, and the bee itself is a
 * few ellipses on the end of it.
 *
 * Which means the trail is state, and state has to be simulated rather than
 * derived from `t`: two tabs drawing at different rates would otherwise file
 * different numbers of points and draw two different lines on the same wall.
 * Hence `step`, a ring buffer per bee, and nothing allocated after the flock is
 * cast. See docs/writing-effects.md.
 * ------------------------------------------------------------------ */

/**
 * Steps between trail samples. Two is thirty a second — finer than the dashes
 * are long, so the line reads as a curve rather than as the polygon it is.
 */
const BEE_TRAIL_EVERY = 2;
/**
 * Samples kept per bee. A hundred and eighty at thirty a second is six seconds
 * exactly — chosen to be exact, because the Trail slider's top is this number
 * and a maximum that is not a whole number of steps above the minimum is a
 * value the control cannot produce.
 */
const BEE_TRAIL_SAMPLES = 180;
const BEE_TRAIL_SECONDS = (BEE_TRAIL_SAMPLES * BEE_TRAIL_EVERY) / 60;
/**
 * How many alpha steps the trail fades over.
 *
 * A canvas gradient runs along a *line*, not along a path, so a trail that
 * fades behind the bee has to be stroked in pieces. Five is enough that the
 * steps are not visible on a wall and few enough that the dash phase — carried
 * across the joins in `strokeTrail` so the stitch stays continuous — is only
 * carried four times.
 */
const BEE_TRAIL_BANDS = 5;

/** A bee, with its own ring buffer. Allocated once, when the flock is cast. */
function castBee(rng, bbox, linger) {
  return {
    x: bbox.x + rng() * bbox.w,
    y: bbox.y + rng() * bbox.h,
    vx: 0,
    vy: 0,
    /** Where it is heading, and when it will lose interest in going there. */
    tx: bbox.x + rng() * bbox.w,
    ty: bbox.y + rng() * bbox.h,
    dwell: 0,
    /**
     * 0 exploring, 1 climbing out, 2 coming back.
     *
     * Three rather than two, because "on the wall" has to mean on the wall: with
     * only *here* and *gone*, the seconds it spends crossing the empty air on
     * either side come out of its time among the flowers, and on a big shape
     * that is all of them — it turns for home, runs out of clock before it
     * arrives, and turns straight back round. One bee, permanently in the sky.
     */
    mode: 0,
    /** Seconds left in this mode. Staggered, so they do not all leave together. */
    timer: 0.5 + rng() * Math.max(0.5, linger),
    pace: 0.7 + rng() * 0.6,
    seed: rng() * 100,
    xs: new Float64Array(BEE_TRAIL_SAMPLES),
    ys: new Float64Array(BEE_TRAIL_SAMPLES),
    /** One past the newest sample, and how many of the buffer are real. */
    head: 0,
    filled: 0,
  };
}

/** Pick somewhere new to be: a flower on the wall, or the sky. */
function beeTarget(bee, bbox, rng) {
  if (bee.mode === 1) {
    /**
     * A point on a circle round the shape, in the direction it is already
     * flying. Measured from the middle of the shape rather than from the bee,
     * so asking again while it is on its way out gives the same answer instead
     * of moving the goalposts a shape's width further off every time.
     *
     * Far enough to be past the clip and therefore invisible, which is what
     * lets the trail stay one unbroken polyline: the bee genuinely flies away
     * and genuinely flies back, so there is no teleport to hide and no seam in
     * the dashes where one visit ends and the next begins.
     */
    const cx = bbox.x + bbox.w / 2;
    const cy = bbox.y + bbox.h / 2;
    const dx = bee.x - cx;
    const dy = bee.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    const reach = Math.hypot(bbox.w, bbox.h) * 0.8;
    bee.tx = cx + (dx / len) * reach;
    bee.ty = cy + (dy / len) * reach;
    return;
  }
  bee.tx = bbox.x + (0.06 + rng() * 0.88) * bbox.w;
  bee.ty = bbox.y + (0.06 + rng() * 0.88) * bbox.h;
  bee.dwell = 0.35 + rng() * 1.6;
}

/** Is it over the shape at all? What decides that it has arrived. */
function overWall(bee, bbox) {
  return bee.x >= bbox.x && bee.x <= bbox.x + bbox.w
    && bee.y >= bbox.y && bee.y <= bbox.y + bbox.h;
}

/**
 * One band of trail, continuing the dash pattern where the last one stopped.
 *
 * Returns the length stroked, so the caller can carry the phase on. Without
 * that the pattern restarts at every band and the line reads as five separate
 * dashed lines that happen to touch.
 */
function strokeTrail(g, bee, from, to, start, travelled, period) {
  let idx = (start + from) % BEE_TRAIL_SAMPLES;
  let px = bee.xs[idx];
  let py = bee.ys[idx];
  g.lineDashOffset = period > 0 ? travelled % period : 0;
  g.beginPath();
  g.moveTo(px, py);
  let run = 0;
  for (let i = from + 1; i <= to; i++) {
    idx = (start + i) % BEE_TRAIL_SAMPLES;
    const x = bee.xs[idx];
    const y = bee.ys[idx];
    g.lineTo(x, y);
    run += Math.hypot(x - px, y - py);
    px = x;
    py = y;
  }
  g.stroke();
  return run;
}

/**
 * A bee, nose-first along the direction of travel.
 *
 * Projected, a bee is light, so it is drawn the way light behaves: a soft warm
 * glow first, which is most of what anybody at the gate actually sees, then
 * the wings as a blurred fan — at two hundred beats a second they are never
 * anywhere, only a translucent smear the size of where they could be — and
 * then a body with real stripes, a fuzzy thorax and a head. The stripes are the
 * stripe colour painted over the body rather than gaps in it, so on a dark wall
 * they read as bands across a lit body and not as a body in pieces.
 */
function drawBee(g, x, y, angle, len, flap, colour, ink, glowSprite, alpha) {
  const w = len * 0.46;
  g.save();
  g.translate(x, y);

  if (glowSprite) {
    const r = len * 1.5;
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = alpha * 0.55;
    g.drawImage(glowSprite, -r, -r, r * 2, r * 2);
    g.globalCompositeOperation = 'source-over';
  }
  g.rotate(angle);

  for (const [a, spread] of [[0.16, 1.25], [0.26, 0.65]]) {
    g.globalAlpha = alpha * a;
    g.fillStyle = '#ffffff';
    for (const side of [-1, 1]) {
      g.beginPath();
      g.ellipse(-len * 0.02, side * w * 0.62, len * 0.3, Math.max(0.01, w * 0.42 * flap * spread), side * -0.45, 0, TAU);
      g.fill();
    }
  }

  g.globalAlpha = alpha;
  // Abdomen, thorax, head: three overlapping ovals, the abdomen the biggest.
  g.fillStyle = colour;
  g.beginPath();
  g.ellipse(-len * 0.14, 0, len * 0.34, w * 0.5, 0, 0, TAU);
  g.fill();
  g.fillStyle = mixHex(colour, '#3a2408', 0.35);
  g.beginPath();
  g.ellipse(len * 0.17, 0, len * 0.15, w * 0.4, 0, 0, TAU);
  g.fill();

  g.fillStyle = ink;
  for (const at of [-0.32, -0.15, 0.02]) {
    g.beginPath();
    g.ellipse(len * at, 0, len * 0.05, w * 0.47 * (1 - Math.abs(at + 0.14) * 1.1), 0, 0, TAU);
    g.fill();
  }
  // The head, at the front, which is the only thing saying which way it faces.
  g.beginPath();
  g.ellipse(len * 0.38, 0, len * 0.11, w * 0.3, 0, 0, TAU);
  g.fill();

  g.restore();
}

const bees = {
  id: 'bees',
  name: 'Bees',
  category: 'atmosphere',
  scope: 'shape',
  description:
    'Bees exploring the wall, each drawing the dashed line of its own flight behind it. They dart, hover, turn, and after a while fly off — the line they left fades out after them.',
  params: [
    { key: 'color', type: 'color', label: 'Bee', default: '#f7c545' },
    { key: 'ink', type: 'color', label: 'Stripes', default: '#2a1a07' },
    { key: 'trailColor', type: 'color', label: 'Trail', default: '#ffe9ad' },
    { key: 'count', type: 'range', label: 'Bees', default: 6, min: 1, max: 40, step: 1 },
    { key: 'size', type: 'range', label: 'Bee size', default: 0.05, min: 0.008, max: 0.25, step: 0.002 },
    { key: 'speed', type: 'range', label: 'Speed', default: 0.5, min: 0.05, max: 2.5, step: 0.01 },
    /** How hard it corners. Low is a lazy drift, high is the right-angle dart. */
    { key: 'dart', type: 'range', label: 'Dartiness', default: 0.6, min: 0, max: 1, step: 0.01 },
    { key: 'wander', type: 'range', label: 'Wander', default: 0.45, min: 0, max: 1, step: 0.01 },
    { key: 'memory', type: 'range', label: 'Trail (s)', default: 2.4, min: 0.2, max: BEE_TRAIL_SECONDS, step: 0.1 },
    { key: 'dash', type: 'range', label: 'Dash', default: 8, min: 1, max: 60, step: 0.5 },
    { key: 'gap', type: 'range', label: 'Gap', default: 7, min: 1, max: 60, step: 0.5 },
    { key: 'trailWidth', type: 'range', label: 'Trail width', default: 2.5, min: 0.5, max: 12, step: 0.25 },
    { key: 'linger', type: 'range', label: 'Time on the wall (s)', default: 18, min: 2, max: 300, step: 1 },
    { key: 'away', type: 'range', label: 'Time away (s)', default: 8, min: 0, max: 300, step: 1 },
  ],
  /**
   * Silent, deliberately.
   *
   * There is no bee in the voice list, and the nearest thing to one is the
   * neon hum, which is mains at fifty hertz and sounds like a substation.
   */
  sound: null,
  init() {
    return { bees: null, count: 0, tick: 0, glow: null, glowKey: null };
  },
  step({ p, shape, dt, rng, state, noise }) {
    const { bbox } = shape;
    if (bbox.w <= 2 || bbox.h <= 2) return;

    const count = clamp(Math.round(p.count), 1, 64);
    if (state.count !== count || !state.bees) {
      state.count = count;
      state.bees = Array.from({ length: count }, () => castBee(rng, bbox, p.linger));
      for (const bee of state.bees) beeTarget(bee, bbox, rng);
      state.tick = 0;
    }

    state.tick++;
    const file = state.tick % BEE_TRAIL_EVERY === 0;

    const cruise = Math.max(1, p.speed) * bbox.h * 0.25;
    // Dartiness is how fast it can change its mind, which on a bee is most of
    // the character: the same top speed with a slack turn is a bumblebee and
    // with a hard one is a honeybee working a hedge.
    const turn = lerp(1.4, 9, clamp(p.dart, 0, 1));

    for (const bee of state.bees) {
      bee.timer -= dt;
      if (bee.mode === 0) {
        // Exploring: a new flower every so often, and away when its time is up.
        bee.dwell -= dt;
        if (bee.dwell <= 0) beeTarget(bee, bbox, rng);
        if (bee.timer <= 0) {
          bee.mode = 1;
          bee.timer = Math.max(0.4, p.away);
          beeTarget(bee, bbox, rng);
        }
      } else if (bee.mode === 1) {
        // Out in the sky, holding one destination rather than a series of them.
        if (bee.timer <= 0) {
          bee.mode = 2;
          // Generous, and only a backstop: it is how long a bee is allowed to
          // spend failing to find its way back before it is simply here again.
          bee.timer = 20;
          beeTarget(bee, bbox, rng);
        }
      } else if (overWall(bee, bbox) || bee.timer <= 0) {
        // Home. The clock on its stay starts now, not when it turned round.
        bee.mode = 0;
        bee.timer = Math.max(0.5, p.linger);
        beeTarget(bee, bbox, rng);
      }

      const dx = bee.tx - bee.x;
      const dy = bee.ty - bee.y;
      const range = Math.hypot(dx, dy);
      if (range > 0.001) {
        bee.vx += (dx / range) * turn * cruise * dt;
        bee.vy += (dy / range) * turn * cruise * dt;
      }

      // The jitter that stops a dart being a straight line. Noise rather than
      // rng so it is smooth in time, and keyed on the bee so no two share it.
      const jitter = clamp(p.wander, 0, 1) * cruise * 3;
      bee.vx += noise.noise2(bee.seed, state.tick * 0.05) * jitter * dt;
      bee.vy += noise.noise2(bee.seed + 40, state.tick * 0.05) * jitter * dt;

      // Drag, so the two forces above settle at a speed instead of running away.
      const drag = Math.exp(-2.6 * dt);
      bee.vx *= drag;
      bee.vy *= drag;

      // Crossing the empty air is a commute, not a search: a bee on its way out
      // or on its way back travels, and only slows down once it is working.
      const top = cruise * bee.pace * (bee.mode === 0 ? 1 : 2.6);
      const speed = Math.hypot(bee.vx, bee.vy);
      if (speed > top && speed > 0) {
        bee.vx *= top / speed;
        bee.vy *= top / speed;
      }

      bee.x += bee.vx * dt;
      bee.y += bee.vy * dt;

      if (file) {
        bee.xs[bee.head] = bee.x;
        bee.ys[bee.head] = bee.y;
        bee.head = (bee.head + 1) % BEE_TRAIL_SAMPLES;
        if (bee.filled < BEE_TRAIL_SAMPLES) bee.filled++;
      }
    }
  },
  draw({ g, p, stable, shape, t, state }) {
    const { bbox } = shape;
    if (!state.bees || bbox.w <= 2 || bbox.h <= 2) return;
    const base = stable || p;

    // The bee's own glow, baked once in its colour; see drawBee.
    const glowKey = base.color;
    if (state.glowKey !== glowKey) {
      state.glow = typeof document !== 'undefined' ? lightSprite(mixLinear(base.color, '#ffb000', 0.3), 48, 0.05) : null;
      state.glowKey = glowKey;
    }

    const dash = Math.max(0.5, p.dash);
    const gap = Math.max(0.5, p.gap);
    const period = dash + gap;
    const keep = clamp(Math.round(p.memory * (60 / BEE_TRAIL_EVERY)), 2, BEE_TRAIL_SAMPLES);

    g.save();
    g.clip(shape.path);
    const alpha = g.globalAlpha;

    g.setLineDash([dash, gap]);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.lineWidth = Math.max(0.25, p.trailWidth);
    g.strokeStyle = p.trailColor;

    for (const bee of state.bees) {
      const n = Math.min(keep, bee.filled);
      if (n < 2) continue;
      const start = (bee.head - n + BEE_TRAIL_SAMPLES * 2) % BEE_TRAIL_SAMPLES;
      const bands = Math.min(BEE_TRAIL_BANDS, n - 1);
      let travelled = 0;
      let from = 0;
      for (let b = 0; b < bands; b++) {
        const to = Math.round(((b + 1) * (n - 1)) / bands);
        if (to <= from) continue;
        // Fading out behind the bee, and never quite as bright as the bee: the
        // line is where it has been, the bee is where it is.
        g.globalAlpha = alpha * 0.85 * ((b + 1) / bands) ** 1.3;
        travelled += strokeTrail(g, bee, from, to, start, travelled, period);
        from = to;
      }
    }

    g.setLineDash([]);
    g.lineDashOffset = 0;
    g.globalAlpha = alpha;

    const len = Math.max(1, bbox.h * clamp(p.size, 0.001, 1));
    for (const bee of state.bees) {
      const angle = Math.atan2(bee.vy, bee.vx);
      // Not a flap — see drawBee. Something small and fast so the wing is never
      // quite a fixed shape.
      const flap = 0.45 + 0.55 * Math.abs(Math.sin(t * 26 + bee.seed));
      drawBee(g, bee.x, bee.y, angle, len, flap, p.color, p.ink, state.glow, alpha);
    }

    g.restore();
  },
};

export default [bats, bees, fireworks, pumpkin, runes];
