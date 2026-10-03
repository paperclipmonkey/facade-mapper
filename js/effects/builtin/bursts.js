/**
 * One-shots: effects that happen *at* a moment rather than carrying on.
 *
 * Everything else in the library loops. That is right for a house that has to
 * look alive from dusk until the last group has gone, and it is exactly wrong
 * for the thing you want when somebody actually reaches the door. A swarm that
 * is always crossing the wall is scenery; a swarm that erupts out of the porch
 * the instant the bell goes is an event, and the difference is entirely in the
 * timing.
 *
 * They all work the same way: `ctx.age` is seconds since the layer was switched
 * on, they play once over `duration`, and they draw nothing afterwards. Wire one
 * to a trigger — a key, the doorbell wired to a key, motion on the path — and
 * the trigger's scene switches the layer on, which restarts the clock. Press it
 * again and it plays again.
 *
 * The origin is the middle of whatever shape the layer is pointed at, so
 * pointing one at the door makes things come out of the door. Point it at the
 * whole frame and it comes out of the middle of the house, which is rarely what
 * anybody wants — these are effects that want a target.
 */

import { rgba, clamp, lerp, TAU, frac, mixHex, makeRng, hexToRgb } from '../../core/math.js';
import { glow, blackbodyCss, mixLinear } from '../lib.js';

/**
 * A colour mixed in linear light, remembered.
 *
 * The rings and sparks here want a few tints of their own colours every frame —
 * the colour pushed towards white for a hot edge, two colours blended along a
 * wake — and `mixLinear` is a parse, six powers and a string build each time
 * for what is the same handful of answers. The mix is quantised to a
 * thirty-second, which nobody can see, so the answers repeat; and the memo is
 * bounded, because a colour is somebody's own typing and should not grow it.
 * A pure function's memo, so it cannot make two tabs disagree.
 */
const tints = new Map();
function tint(a, b, t) {
  const f = Math.round(clamp(t, 0, 1) * 32) / 32;
  const key = `${a}|${b}|${f}`;
  let hex = tints.get(key);
  if (!hex) {
    if (tints.size > 512) tints.clear();
    hex = mixLinear(a, b, f);
    tints.set(key, hex);
  }
  return hex;
}

/**
 * Scratch points for positions worked out in a loop, so drawing a few hundred
 * sparks, stars or bats allocates nothing.
 */
const HEAD = { x: 0, y: 0 };
const MID = { x: 0, y: 0 };
const TAIL = { x: 0, y: 0 };

/**
 * Fade in fast, hold, fade out over the last third — the swarm's envelope.
 * The others shape their own: a flash and a shell are a spike with a tail,
 * not a fade, and each spark and star burns out on its own clock.
 */
function envelope(age, duration) {
  if (age < 0 || age > duration) return 0;
  const u = age / duration;
  if (u < 0.06) return u / 0.06;
  if (u > 0.7) return 1 - (u - 0.7) / 0.3;
  return 1;
}

/** Where a burst comes from, and how big the thing it comes out of is. */
function origin(shape) {
  const { bbox } = shape;
  return { x: bbox.cx, y: bbox.cy, r: Math.max(8, Math.min(bbox.w, bbox.h) * 0.5) };
}

/* ------------------------------------------------------------------ *
 * Bats out of the door
 * ------------------------------------------------------------------ */

/**
 * Air drag on a bat, per second.
 *
 * A bat bursting out of a doorway is fast for the first few wingbeats and then
 * flying, not still travelling at the speed it was flung: without this the
 * whole swarm was off the top of the frame inside a second, and a still taken
 * at any moment anybody would choose showed an empty wall.
 */
const BAT_DRAG = 1.1;

/** Where each bat is this frame, worked out once and drawn twice. */
const BAT_X = new Float64Array(200);
const BAT_Y = new Float64Array(200);
const BAT_SPAN = new Float64Array(200);
const BAT_BANK = new Float64Array(200);
const BAT_BEAT = new Float64Array(200);

const batBurst = {
  id: 'bat-burst',
  name: 'Bat Burst',
  category: 'halloween',
  scope: 'shape',
  description:
    'A swarm erupts out of the shape and scatters across the house. Plays once each time the layer is switched on, so put it on a trigger and point it at the door.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#120a14' },
    { key: 'count', type: 'range', label: 'Bats', default: 40, min: 4, max: 200, step: 1 },
    { key: 'duration', type: 'range', label: 'Lasts (s)', default: 2.6, min: 0.3, max: 12, step: 0.1 },
    { key: 'speed', type: 'range', label: 'Speed', default: 900, min: 100, max: 4000, step: 25 },
    { key: 'spread', type: 'range', label: 'Spread', default: 1, min: 0.05, max: 1, step: 0.01 },
    { key: 'aim', type: 'range', label: 'Aim (degrees)', default: -90, min: -180, max: 180, step: 5 },
    { key: 'size', type: 'range', label: 'Wingspan', default: 46, min: 8, max: 200, step: 1 },
    { key: 'flap', type: 'range', label: 'Flap rate', default: 9, min: 0, max: 30, step: 0.5 },
    { key: 'rise', type: 'range', label: 'Climb', default: -260, min: -1500, max: 1500, step: 20 },
    { key: 'wander', type: 'range', label: 'Wander', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'glow', type: 'range', label: 'Backlight', default: 0.5, min: 0, max: 3, step: 0.05 },
    { key: 'glowColor', type: 'color', label: 'Backlight colour', default: '#8b00ff' },
  ],
  init() {
    return { swarm: null, born: -1 };
  },
  /**
   * Cast the swarm — once, at a moment every tab agrees on.
   *
   * This is the only stateful thing a burst does, and it has to happen here
   * rather than on the first frame that gets drawn. `rng` is seeded from the
   * simulation step, and the first frame lands on a different step depending on
   * the frame rate: a tab at 60fps would cast from step one and a tab at 30fps
   * from step two, so two projectors threw two different swarms out of the same
   * window. `step` always runs from step one, whatever the frame rate.
   *
   * Sorted smallest first, so the nearer, bigger bats are drawn over the far
   * ones — sorting is writing, so it belongs here and not in `draw`.
   */
  step({ p, age, rng, state }) {
    const count = Math.round(clamp(p.count, 4, 200));

    /**
     * Keyed on the age going backwards, which is what a retrigger looks like
     * from in here — the layer was switched off and on, the clock restarted,
     * and this needs a fresh swarm rather than the tail of the last one.
     */
    if (!state.swarm || state.swarm.length !== count || age < state.born) {
      state.born = age;
      const aim = (p.aim * Math.PI) / 180;
      state.swarm = Array.from({ length: count }, () => {
        // Spread of 1 is the full circle; anything less is a cone about `aim`.
        const a = aim + (rng() - 0.5) * Math.PI * 2 * p.spread;
        const v = 0.35 + rng() * 0.65;
        const size = 0.6 + rng() * 0.7;
        return {
          a,
          v,
          // Staggered, so they pour out rather than appearing as a ring.
          delay: rng() * 0.32,
          size,
          phase: rng() * TAU,
          drift: rng() * 100,
          // Out of the doorway, not out of one point in the middle of it.
          ox: rng() - 0.5,
          oy: rng() - 0.5,
          // Small bats beat faster than big ones, and no two quite together.
          beat: 1.3 - 0.45 * ((size - 0.6) / 0.7) + (rng() - 0.5) * 0.12,
        };
      }).sort((x, y) => x.size - y.size);
    }
    state.born = Math.min(state.born, age);
  },
  /**
   * Silhouettes, and the light that makes them silhouettes.
   *
   * A dark bat projected on to a dark house is nothing at all: a projector
   * cannot paint black, it can only leave a hole in its own light. So the
   * effect brings the light with it. The doorway flares as the swarm comes out
   * of it, every bat carries a halo of the backlight colour, and the bats are
   * then cut out of that light in their own dark colour with a thin rim of it
   * left round the edge — which is exactly how a bat against a lit window
   * reads, and the only way one can read at all on a wall at night.
   *
   * Two passes over one set of positions, so no bat is lit by a halo drawn
   * after it.
   */
  draw({ g, p, shape, age, state, noise }) {
    const fade = envelope(age, p.duration);
    if (fade <= 0 || !state.swarm) return;
    const at = origin(shape);
    const { bbox } = shape;
    const backlight = clamp(p.glow, 0, 3);
    const base = g.globalAlpha;
    const n = Math.min(state.swarm.length, BAT_X.length);

    for (let i = 0; i < n; i++) {
      const b = state.swarm[i];
      const life = age - b.delay;
      BAT_SPAN[i] = 0;
      if (life <= 0) continue;
      const x0 = at.x + b.ox * bbox.w * 0.55;
      const y0 = at.y + b.oy * bbox.h * 0.45;
      batAt(HEAD, b, life, x0, y0, p, noise);
      batAt(TAIL, b, Math.max(0, life - 0.05), x0, y0, p, noise);
      BAT_X[i] = HEAD.x;
      BAT_Y[i] = HEAD.y;
      // Coming out of the doorway towards you, so they grow as they leave it.
      BAT_SPAN[i] = p.size * b.size * (0.55 + 0.45 * Math.min(1, life / 0.35));
      // Banking into the turn: upright, leaning with the sideways speed.
      BAT_BANK[i] = clamp((HEAD.x - TAIL.x) / 0.05 / 900, -0.65, 0.65);
      BAT_BEAT[i] = Math.sin(life * p.flap * b.beat * TAU + b.phase);
    }

    g.save();

    /* --- The light --- */

    if (backlight > 0) {
      g.globalCompositeOperation = 'lighter';
      // The doorway flaring as it opens, and dying back as they clear it.
      const flare = backlight * Math.min(1, age / 0.06) * Math.exp(-age / 0.9);
      if (flare > 0.01) {
        if (shape.closed) {
          g.globalAlpha = base * clamp(0.45 * flare, 0, 1);
          g.fillStyle = p.glowColor;
          g.fill(shape.path);
          g.globalAlpha = base;
        }
        glow(g, at.x, at.y, at.r * 2.2 + 210, p.glowColor, clamp(0.85 * flare, 0, 1));
      }
      /**
       * Each bat's own patch of backlight: broad and fairly even under the
       * body, so there is enough light behind the whole silhouette for it to
       * be cut out of, and only then falling away — a spotlight's profile
       * rather than a candle's, because what matters here is the light the
       * bat is *in front of*, not the light it gives off.
       */
      const halo = clamp(0.8 * backlight * fade, 0, 1);
      const { r: hr, g: hg, b: hb } = hexToRgb(p.glowColor);
      for (let i = 0; i < n; i++) {
        const span = BAT_SPAN[i];
        if (span <= 0) continue;
        const R = span * 1.3;
        const grad = g.createRadialGradient(BAT_X[i], BAT_Y[i], 0, BAT_X[i], BAT_Y[i], R);
        grad.addColorStop(0, `rgba(${hr},${hg},${hb},${halo})`);
        grad.addColorStop(0.38, `rgba(${hr},${hg},${hb},${halo * 0.78})`);
        grad.addColorStop(0.65, `rgba(${hr},${hg},${hb},${halo * 0.3})`);
        grad.addColorStop(1, `rgba(${hr},${hg},${hb},0)`);
        g.fillStyle = grad;
        g.beginPath();
        g.arc(BAT_X[i], BAT_Y[i], R, 0, TAU);
        g.fill();
      }
    }

    /* --- The bats --- */

    g.globalCompositeOperation = 'source-over';
    g.lineJoin = 'round';
    const rim = clamp(backlight * 1.5, 0, 1);
    const rimColour = tint(p.glowColor, '#ffffff', 0.35);
    for (let i = 0; i < n; i++) {
      const span = BAT_SPAN[i];
      if (span <= 0) continue;
      g.save();
      g.translate(BAT_X[i], BAT_Y[i]);
      g.rotate(BAT_BANK[i]);
      g.beginPath();
      batOutline(g, span * 0.5, BAT_BEAT[i]);
      if (rim > 0) {
        // The rim: what the backlight catches of the edge before the body
        // is cut out over the inner half of it.
        g.globalAlpha = base * fade * rim;
        g.strokeStyle = rimColour;
        g.lineWidth = Math.max(1.2, span * 0.05);
        g.stroke();
      }
      g.globalAlpha = base * fade;
      g.fillStyle = p.color;
      g.fill();
      g.restore();
    }
    g.restore();
  },
};

/**
 * Where bat `b` is `tt` seconds after it left the doorway at (x0, y0).
 *
 * Flung out, slowing to a flying speed, climbing, and wandering. The travel is
 * drag's closed form and the climb an acceleration that drag turns into a
 * steady rate, so neither needs anything remembered. The wander is noise
 * across the line of flight, growing with distance from the door — tight as
 * they come out, ragged once they are flying.
 */
function batAt(out, b, tt, x0, y0, p, noise) {
  const k = BAT_DRAG;
  const ex = (1 - Math.exp(-k * tt)) / k;
  const travel = p.speed * b.v * ex;
  const wobble = p.wander > 0
    ? noise.noise2(tt * 1.3 + b.drift, b.drift * 0.37) * (30 + travel * 0.4) * p.wander
    : 0;
  out.x = x0 + Math.cos(b.a) * travel - Math.sin(b.a) * wobble;
  out.y = y0 + Math.sin(b.a) * travel + Math.cos(b.a) * wobble + (p.rise / k) * (tt - ex);
  return out;
}

/**
 * One bat, seen from the front, as a single closed outline: the scalloped
 * trailing edge of each wing, the leading edge up to the wrist and out to the
 * tip, a body, a head and two pointed ears.
 *
 * Every part of that is the silhouette everybody knows, and every part earns
 * its place at house scale — the three scallops and the ears are what make it
 * a bat rather than a bird or a moth from the pavement. One outline rather
 * than wings and body as separate pieces, so the overlaps cannot cancel out
 * under the fill rule and leave a hole where the wing meets the body.
 *
 * `beat` runs from -1 (wings down) to 1 (wings up). The wing turns about the
 * shoulder and foreshortens as it leaves the horizontal, which is all a
 * wingbeat is from in front.
 */
function batOutline(g, half, beat) {
  const squash = 1 - 0.34 * Math.abs(beat);
  const lift = beat * 0.62;
  // Wing points turn about the shoulder at x = 0.1; the body does not move.
  const wx = (side, x) => side * (0.1 + (x - 0.1) * squash) * half;
  const wy = (x, y) => (y - lift * (x - 0.1)) * half;

  g.moveTo(0, 0.36 * half);
  // Right wing, out along the trailing edge and back along the leading one.
  g.quadraticCurveTo(0.08 * half, 0.32 * half, wx(1, 0.13), wy(0.13, 0.25));
  g.quadraticCurveTo(wx(1, 0.3), wy(0.3, 0.1), wx(1, 0.47), wy(0.47, 0.27));
  g.quadraticCurveTo(wx(1, 0.6), wy(0.6, 0.08), wx(1, 0.74), wy(0.74, 0.2));
  g.quadraticCurveTo(wx(1, 0.83), wy(0.83, 0.03), wx(1, 1), wy(1, -0.04));
  g.quadraticCurveTo(wx(1, 0.8), wy(0.8, -0.3), wx(1, 0.52), wy(0.52, -0.37));
  g.quadraticCurveTo(wx(1, 0.28), wy(0.28, -0.4), wx(1, 0.1), wy(0.1, -0.13));
  // Head and ears.
  g.lineTo(0.09 * half, -0.25 * half);
  g.lineTo(0.12 * half, -0.47 * half);
  g.lineTo(0.03 * half, -0.33 * half);
  g.quadraticCurveTo(0, -0.31 * half, -0.03 * half, -0.33 * half);
  g.lineTo(-0.12 * half, -0.47 * half);
  g.lineTo(-0.09 * half, -0.25 * half);
  // Left wing, the same in mirror.
  g.lineTo(wx(-1, 0.1), wy(0.1, -0.13));
  g.quadraticCurveTo(wx(-1, 0.28), wy(0.28, -0.4), wx(-1, 0.52), wy(0.52, -0.37));
  g.quadraticCurveTo(wx(-1, 0.8), wy(0.8, -0.3), wx(-1, 1), wy(1, -0.04));
  g.quadraticCurveTo(wx(-1, 0.83), wy(0.83, 0.03), wx(-1, 0.74), wy(0.74, 0.2));
  g.quadraticCurveTo(wx(-1, 0.6), wy(0.6, 0.08), wx(-1, 0.47), wy(0.47, 0.27));
  g.quadraticCurveTo(wx(-1, 0.3), wy(0.3, 0.1), wx(-1, 0.13), wy(0.13, 0.25));
  g.quadraticCurveTo(-0.08 * half, 0.32 * half, 0, 0.36 * half);
  g.closePath();
}

/* ------------------------------------------------------------------ *
 * Shockwave
 * ------------------------------------------------------------------ */

/**
 * One ring of a shockwave: a radial gradient laid over just the band it lights.
 *
 * The profile is what makes it energy rather than a hoop. Read outwards from
 * the centre: a long faint wake in the trailing colour, brightening into the
 * ring's own colour, a thin edge pushed half way to white, and a short
 * halo in front that is gone within a couple of edge-widths. Asymmetric on
 * purpose — a wavefront has a sharp front and a smeared back, because the front
 * is where the energy is arriving and the back is where it is draining away —
 * and the asymmetry, more than the brightness, is what makes a still of it read
 * as travelling outwards.
 *
 * Filled as an annulus rather than a disc, so the cost is the band and not the
 * whole circle inside it: a ring two thousand pixels across is a thin hoop of
 * pixels, not four million of them.
 *
 * The stops are kept in order by construction (each is clamped to be no nearer
 * the centre than the last), because a ring only a few pixels old has a wake
 * longer than its radius and its stops would otherwise arrive out of order.
 * And there are seven of them, no more: a ring can cover a million pixels,
 * and past seven or eight stops the canvas leaves its fast path for gradients
 * and pays several times as much for every one of those pixels.
 */
const RING_AT = new Float64Array(7);
const RING_COLOUR = new Array(7).fill('#ffffff');
const RING_ALPHA = [0, 0.14, 0.42, 0.86, 1, 0.38, 0];

function drawRing(g, x, y, r, edge, wake, front, back, level, seed) {
  const halo = edge * 2.2;
  const inner = Math.max(0, r - wake);
  const outer = r + halo;
  const span = outer - inner;
  if (span < 1 || level <= 0.003) return;

  // Hot, not white: pushed far enough towards white to read as the hottest
  // part, and not so far that an orange ring turns into a white one.
  const hot = tint(front, '#ffffff', 0.5);
  RING_AT[0] = inner;
  RING_AT[1] = r - wake * 0.6;
  RING_AT[2] = r - wake * 0.27;
  RING_AT[3] = r - edge * 0.9;
  RING_AT[4] = r;
  RING_AT[5] = r + edge * 0.6;
  RING_AT[6] = outer;
  RING_COLOUR[0] = back;
  RING_COLOUR[1] = back;
  RING_COLOUR[2] = tint(back, front, 0.5);
  RING_COLOUR[3] = front;
  RING_COLOUR[4] = hot;
  RING_COLOUR[5] = front;
  RING_COLOUR[6] = front;
  const grad = g.createRadialGradient(x, y, inner, x, y, outer);
  let last = 0;
  for (let i = 0; i < RING_AT.length; i++) {
    last = Math.max(last, clamp((RING_AT[i] - inner) / span, 0, 1));
    grad.addColorStop(last, rgba(RING_COLOUR[i], clamp(RING_ALPHA[i] * level, 0, 1)));
  }

  g.fillStyle = grad;
  g.beginPath();
  g.arc(x, y, outer, 0, TAU);
  if (inner > 0.5) {
    // Wound the other way, so the inside of the band is a hole rather than
    // a second helping of the wake.
    g.moveTo(x + inner, y);
    g.arc(x, y, inner, 0, TAU, true);
  }
  g.fill();

  /**
   * An uneven front.
   *
   * A perfectly even hoop is the giveaway of something drawn with a compass.
   * A real front is brighter wherever more of the energy happens to be going,
   * so the edge gets a second, thinner pass whose brightness wanders round the
   * circumference — three slow lobes and a faster ripple, phased per ring so
   * no two rings agree. A conic gradient does that in one stroke; a browser
   * without one simply gets an even ring.
   */
  if (g.createConicGradient) {
    const cone = g.createConicGradient(seed, x, y);
    for (let k = 0; k <= 24; k++) {
      const a = (k / 24) * TAU;
      const v = 0.5 + 0.3 * Math.sin(3 * a + seed * 1.7) + 0.2 * Math.sin(7 * a + seed * 4.1);
      cone.addColorStop(k / 24, rgba(hot, clamp(v * 0.6 * level, 0, 1)));
    }
    g.strokeStyle = cone;
    g.lineWidth = Math.max(1, edge * 0.6);
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.stroke();
  }
}

const shockwave = {
  id: 'shockwave',
  name: 'Shockwave',
  category: 'basic',
  scope: 'shape',
  description:
    'Rings of light race outwards from the shape and fade. Plays once each time the layer is switched on — the cheapest way to make a house react to something.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#7cf3ff' },
    { key: 'color2', type: 'color', label: 'Trailing colour', default: '#8b00ff' },
    { key: 'rings', type: 'range', label: 'Rings', default: 3, min: 1, max: 10, step: 1 },
    { key: 'duration', type: 'range', label: 'Lasts (s)', default: 1.6, min: 0.2, max: 10, step: 0.1 },
    // Fifteen hundred rather than twenty-two: from a door, a ring that has to
    // travel twenty-two hundred pixels has left the frame inside half a second
    // and spends the rest of the effect lighting nothing but its corners.
    { key: 'reach', type: 'range', label: 'Reach', default: 1500, min: 100, max: 6000, step: 50 },
    { key: 'width', type: 'range', label: 'Ring thickness', default: 26, min: 4, max: 200, step: 1 },
    { key: 'flash', type: 'range', label: 'Flash at the centre', default: 1, min: 0, max: 3, step: 0.05 },
    { key: 'gap', type: 'range', label: 'Gap between rings', default: 0.12, min: 0, max: 1, step: 0.01 },
  ],
  init() {
    return {};
  },
  draw({ g, p, shape, age }) {
    if (age < 0 || age > p.duration) return;
    const at = origin(shape);
    const rings = Math.round(clamp(p.rings, 1, 10));
    const width = Math.max(1, p.width);
    const flash = clamp(p.flash, 0, 3);
    const base = g.globalAlpha;

    /**
     * Every ring finishes inside the time the layer says it lasts.
     *
     * Each ring used to live for the whole duration and start `gap` of it after
     * the one before, so the later rings never finished: the last of four was
     * only two-thirds of the way out when the clock ran out, and what put it
     * out was the effect's own fade rather than the ring spreading thin.
     * Sharing the duration out instead keeps Lasts meaning what it says and
     * lets every ring travel all the way and thin out to nothing on its own.
     */
    const life = p.duration / (1 + (rings - 1) * clamp(p.gap, 0, 1));

    g.save();
    g.globalCompositeOperation = 'lighter';

    /**
     * The flash, and the shape it comes out of.
     *
     * The fastest thing in the effect and mostly over before the first ring
     * has gone anywhere, which is what reads as an impact. The shape itself
     * lights first — the door the knock came through, the gutter the pressure
     * wave broke along — so the eye has the source before it has the rings,
     * and the rings are then plainly *from* something. An exponential rather
     * than a ramp: a real flash is a spike with a tail, and a linear fade
     * reads as a dimmer being turned down.
     */
    const punch = Math.exp(-age / 0.085) * flash;
    if (punch > 0.01) {
      const hot = tint(p.color, '#ffffff', 0.6);
      g.globalAlpha = base * clamp(0.8 * punch, 0, 1);
      if (shape.closed) {
        g.fillStyle = hot;
        g.fill(shape.path);
      } else {
        g.strokeStyle = hot;
        g.lineWidth = Math.max(3, width * 0.45);
        g.lineCap = 'round';
        g.stroke(shape.path);
      }
      g.globalAlpha = base;
      glow(g, at.x, at.y, at.r * 1.3 + width * 2.5, tint(p.color, '#ffffff', 0.85), clamp(punch, 0, 1));
      glow(g, at.x, at.y, at.r * 4 + width * 9, p.color, clamp(0.5 * punch, 0, 1));
    }
    // What is left at the source once the flash has gone: a dull glow in the
    // trailing colour, draining away over the life of the first ring.
    const ember = flash * Math.exp(-age / (0.2 + life * 0.25)) * (1 - age / p.duration);
    if (ember > 0.01) glow(g, at.x, at.y, at.r * 2.4 + width * 5, p.color2, clamp(0.32 * ember, 0, 1));

    for (let i = 0; i < rings; i++) {
      const u = (age - i * p.gap * life) / life;
      if (u <= 0 || u >= 1) continue;
      // Fast at first and slowing, which is how a wavefront in anything reads.
      const r = at.r * 0.6 + p.reach * (1 - Math.pow(1 - u, 2.4));
      /**
       * Thinning and fading as it spreads.
       *
       * The same energy over an ever longer circumference: the edge narrows,
       * the wake behind it stretches out and dims, and the colour drifts
       * towards the trailing one. A quick attack over the first two percent
       * so a ring is not born as a single bright pixel at the centre.
       */
      const edge = width * 0.4 * (1 - 0.6 * u);
      const wake = edge * (4.5 + 8 * u) + width * 0.7;
      const level = Math.min(1, u / 0.02) * Math.pow(1 - u, 1.35);
      const front = tint(p.color, p.color2, u * 0.55);
      drawRing(g, at.x, at.y, r, edge, wake, front, p.color2, level, 1.3 + i * 2.39);
    }
    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * Sparks
 * ------------------------------------------------------------------ */

/**
 * Air drag on a spark, per second.
 *
 * A spark is a speck of burning metal with a great deal of surface for its
 * mass, so the air takes its speed off it quickly — and that is the whole shape
 * of a shower: a fast burst out of the source, then a droop as each one gives
 * up and falls. Without it they fly clean parabolas like thrown stones, and
 * most of them have left the frame long before they have finished burning.
 *
 * Gentler than a real spark's, deliberately: the same effect throws bubbles in
 * the underwater preset (gravity turned round), where the speed is meant as
 * the steady rate they rise at, and a spark's full drag would stop them dead
 * in the doorway.
 */
const SPARK_DRAG = 0.85;

/**
 * Where something thrown at (vx, vy) is after `t` seconds, under drag `k` and
 * gravity `grav`.
 *
 * The closed form of exactly that motion, so a burst is a function of its age
 * and nothing is integrated or remembered between frames. Writes into `out` so
 * a loop over a few hundred sparks allocates nothing.
 */
function flight(out, x0, y0, vx, vy, grav, k, t) {
  const ex = (1 - Math.exp(-k * t)) / k;
  out.x = x0 + vx * ex;
  out.y = y0 + vy * ex + (grav / k) * (t - ex);
  return out;
}

/**
 * One tapered streak, added to the current path: round and full at the head
 * (`hx`, `hy`), drawn to a point at the tail, along a curve that passes
 * through `mx`, `my` on the way.
 *
 * This is what a fast spark looks like to anything with a shutter, an eye
 * included — not a dot, but the stretch of path it covered while you looked,
 * fattest and brightest where it is now. The sides are quadratics aimed to
 * pass through the midpoint of the real path, so a spark curving over the top
 * of its arc leaves a curved streak rather than a straight stick. Built from
 * path commands rather than a sprite so the one fill can be any length and
 * any bend.
 */
function streak(g, tx, ty, mx, my, hx, hy, R) {
  let dx = hx - mx;
  let dy = hy - my;
  const len = Math.hypot(dx, dy);
  if (len < 0.25 || Math.hypot(hx - tx, hy - ty) < R * 0.6) {
    // Barely moving: a streak shorter than the spark is wide is just the spark.
    g.moveTo(hx + R, hy);
    g.arc(hx, hy, R, 0, TAU);
    return;
  }
  dx /= len;
  dy /= len;
  const nx = -dy;
  const ny = dx;
  // The control point that makes a quadratic from tail to head pass through
  // the middle sample, rather than merely bend towards it.
  const cx = 2 * mx - (tx + hx) / 2;
  const cy = 2 * my - (ty + hy) / 2;
  const side = Math.atan2(ny, nx);
  g.moveTo(tx, ty);
  g.quadraticCurveTo(cx + nx * R * 0.85, cy + ny * R * 0.85, hx + nx * R, hy + ny * R);
  g.arc(hx, hy, R, side, side - Math.PI, true);
  g.quadraticCurveTo(cx - nx * R * 0.85, cy - ny * R * 0.85, tx, ty);
  g.closePath();
}

const sparkBurst = {
  id: 'spark-burst',
  name: 'Spark Burst',
  category: 'basic',
  scope: 'shape',
  description:
    'A shower of sparks thrown out of the shape, streaking, falling under gravity and cooling from white-hot to a dull red as they burn out. Plays once each time the layer is switched on.',
  params: [
    { key: 'hotTemp', type: 'range', label: 'Hot (K)', default: 2600, min: 1000, max: 9000, step: 50 },
    { key: 'coolTemp', type: 'range', label: 'Cool (K)', default: 1100, min: 800, max: 4000, step: 50 },
    { key: 'count', type: 'range', label: 'Sparks', default: 90, min: 5, max: 400, step: 1 },
    { key: 'duration', type: 'range', label: 'Lasts (s)', default: 2, min: 0.2, max: 10, step: 0.1 },
    { key: 'speed', type: 'range', label: 'Speed', default: 700, min: 50, max: 3000, step: 25 },
    { key: 'spread', type: 'range', label: 'Spread', default: 1, min: 0.05, max: 1, step: 0.01 },
    { key: 'aim', type: 'range', label: 'Aim (degrees)', default: -90, min: -180, max: 180, step: 5 },
    { key: 'gravity', type: 'range', label: 'Gravity', default: 900, min: -1000, max: 3000, step: 25 },
    { key: 'size', type: 'range', label: 'Size', default: 7, min: 2, max: 40, step: 0.5 },
    { key: 'trail', type: 'range', label: 'Trail', default: 0.6, min: 0, max: 1, step: 0.01 },
  ],
  init() {
    return { sparks: null, born: -1 };
  },
  /**
   * Cast the swarm — once, at a moment every tab agrees on.
   *
   * This is the only stateful thing a burst does, and it has to happen here
   * rather than on the first frame that gets drawn. `rng` is seeded from the
   * simulation step, and the first frame lands on a different step depending on
   * the frame rate: a tab at 60fps would cast from step one and a tab at 30fps
   * from step two, so two projectors threw two different swarms out of the same
   * window. `step` always runs from step one, whatever the frame rate.
   *
   * Everything that makes one spark unlike the next is decided here: how hard
   * it was thrown, how big and how hot it is, how long it burns, how fast it
   * twinkles, and where in the source it came from. About one in eight is a
   * heavier fleck — bigger, slower, longer-lived — because a real shower is
   * never all one size, and the few fat ones lazily falling after the rest have
   * gone are what make it read as metal rather than as a particle system.
   */
  step({ p, age, rng, state }) {
    const count = Math.round(clamp(p.count, 5, 400));

    // Recast on a retrigger, which from in here is the age going backwards.
    if (!state.sparks || state.sparks.length !== count || age < state.born) {
      state.born = age;
      const aim = (p.aim * Math.PI) / 180;
      state.sparks = Array.from({ length: count }, () => {
        const heavy = rng() < 0.12;
        const a = aim + (rng() - 0.5) * Math.PI * 2 * p.spread;
        const v = p.speed * (0.3 + rng() * 0.95) * (heavy ? 0.65 : 1);
        return {
          vx: Math.cos(a) * v,
          vy: Math.sin(a) * v,
          size: (0.55 + rng() * 0.8) * (heavy ? 1.7 : 1),
          // Each burns out at its own rate, so they do not all die together.
          life: Math.min(1, (0.4 + rng() * 0.6) * (heavy ? 1.3 : 1)),
          heat: 0.88 + rng() * 0.22,
          smear: 0.7 + rng() * 0.6,
          phase: rng() * TAU,
          rate: 14 + rng() * 22,
          ox: rng() - 0.5,
          oy: rng() - 0.5,
        };
      });
    }
    state.born = Math.min(state.born, age);
  },
  draw({ g, p, shape, age, state }) {
    if (!state.sparks || age < 0 || age > p.duration) return;
    const at = origin(shape);
    const hot = Math.max(p.hotTemp, p.coolTemp);
    const cool = Math.min(p.hotTemp, p.coolTemp);
    const grav = p.gravity;
    const k = SPARK_DRAG;
    const size = Math.max(0.5, p.size);
    /**
     * How much of its own path each spark drags behind it, in seconds of
     * flight — a shutter speed, in effect. A sixth of a second at full Trail is
     * about what a long exposure of a grinder's sparks shows; at the bottom of
     * the slider the streaks shrink to round motes, which is what the bubbles
     * in the underwater preset want.
     */
    const shutter = clamp(p.trail, 0, 1) * 0.16;
    const base = g.globalAlpha;

    g.save();
    g.globalCompositeOperation = 'lighter';

    /**
     * The flash it starts with: white-hot and gone in a tenth of a second,
     * with a wider warm bloom under it. Most of the impression that something
     * went *bang*, rather than that some sparks appeared.
     */
    const punch = Math.exp(-age / 0.08);
    if (punch > 0.02) {
      glow(g, at.x, at.y, size * 6 + 40, blackbodyCss(hot + 3000), punch);
      glow(g, at.x, at.y, size * 24 + 160, blackbodyCss(hot), 0.5 * punch);
    }

    for (const s of state.sparks) {
      const life = p.duration * s.life;
      if (age >= life) continue;
      const u = age / life;
      /**
       * Cooling as it goes, down the blackbody curve, and dimming with it.
       *
       * The colour is the temperature, so a spark goes white, yellow, orange,
       * then a dull red rather than merely fading; and a body that radiates
       * as fiercely as the fourth power of its temperature does not stay as
       * bright as it was while it cools, so the brightness falls with it. The
       * last eighth of its life is the burn-out.
       */
      const temp = cool + (hot * s.heat - cool) * Math.pow(1 - u, 1.15);
      const twinkle = 0.8 + 0.2 * Math.sin(age * s.rate + s.phase);
      const bright = Math.pow(temp / hot, 1.5) * Math.min(1, (1 - u) / 0.12) * twinkle;
      if (bright < 0.008) continue;

      const r = size * s.size * 0.6 * (1 - 0.35 * u);
      const x0 = at.x + s.ox * at.r * 0.6;
      const y0 = at.y + s.oy * at.r * 0.6;
      const back = Math.min(age, shutter * s.smear);
      flight(HEAD, x0, y0, s.vx, s.vy, grav, k, age);
      flight(MID, x0, y0, s.vx, s.vy, grav, k, age - back * 0.5);
      flight(TAIL, x0, y0, s.vx, s.vy, grav, k, age - back);

      /**
       * Three passes, wide to narrow: a faint halo over the whole streak, the
       * body in the spark's own colour, and a white-hot core only along the
       * front of it. The core being shorter than the body is what puts the
       * heat at the head and lets the tail cool to orange, without a gradient
       * per spark.
       */
      const colour = blackbodyCss(temp);
      g.fillStyle = colour;
      g.globalAlpha = base * clamp(0.12 * bright, 0, 1);
      g.beginPath();
      streak(g, TAIL.x, TAIL.y, MID.x, MID.y, HEAD.x, HEAD.y, r * 3);
      g.fill();
      g.globalAlpha = base * clamp(0.8 * bright, 0, 1);
      g.beginPath();
      streak(g, TAIL.x, TAIL.y, MID.x, MID.y, HEAD.x, HEAD.y, r);
      g.fill();

      flight(MID, x0, y0, s.vx, s.vy, grav, k, age - back * 0.2);
      flight(TAIL, x0, y0, s.vx, s.vy, grav, k, age - back * 0.42);
      g.fillStyle = blackbodyCss(temp + 1800);
      g.globalAlpha = base * clamp(bright, 0, 1);
      g.beginPath();
      streak(g, TAIL.x, TAIL.y, MID.x, MID.y, HEAD.x, HEAD.y, r * 0.5);
      g.fill();
    }
    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * Rocket
 * ------------------------------------------------------------------ */

/**
 * The colours a firework star actually comes in.
 *
 * Not a palette somebody liked: these are the metal salts. Strontium burns red,
 * barium green, copper blue, sodium yellow, and the white is magnesium burning
 * hot enough to be off the top of the visible curve. It matters here because
 * the *blue* is the tell — copper is the hardest colour to make and the dimmest
 * to burn, so a blue shell on a wall wants to be paler and weaker than the red
 * next to it, and a palette that treats them as equals looks like a screensaver.
 * `STAR_LEVEL` is that difference, as a brightness.
 */
const STAR_COLOURS = {
  strontium: '#ff3b4d',
  barium: '#7dff8a',
  copper: '#5aa8ff',
  sodium: '#ffd166',
  magnesium: '#ffffff',
};
const STAR_LEVEL = { strontium: 1, barium: 0.9, copper: 0.72, sodium: 1, magnesium: 1.1 };

const SHELL_TYPES = ['peony', 'willow', 'palm', 'crossette'];

/**
 * How each kind of shell's stars move and burn.
 *
 * `drag` is how fast the air takes a star's speed (per second) — the reason a
 * shell opens fast and then *hangs*. `droop` scales gravity: heavy charcoal
 * willow stars sag into long strands, a peony's light metal stars barely do.
 * `burn` is the share of the time after the break that the stars stay lit, and
 * `tail` how many seconds of path each one drags behind it.
 */
const SHELL_KINDS = {
  peony: { drag: 2.1, droop: 0.45, burn: 0.62, tail: 0.12 },
  willow: { drag: 1.5, droop: 1, burn: 0.95, tail: 1.1 },
  palm: { drag: 1.15, droop: 0.85, burn: 0.75, tail: 0.5 },
  crossette: { drag: 1.7, droop: 0.5, burn: 0.7, tail: 0.12 },
};

/** Willow and palm burn charcoal and iron, not a salt: gold, at about this temperature. */
const CHARCOAL_K = 1900;

/** This frame's climb: how long it takes, and where it starts and ends. */
const CLIMB = { lift: 1, x0: 0, y0: 0, x1: 0, y1: 0 };

/**
 * Where the shell is `tau` seconds into its climb.
 *
 * Decelerating all the way up, because it is: the motor burns for a moment and
 * the rest of the climb is coasting against gravity. A shell that rises at a
 * constant speed reads as a bubble going up a tube. Straight, because the drift
 * is a lean rather than a curve.
 */
function climbTo(out, tau) {
  const e = 1 - (1 - clamp(tau / CLIMB.lift, 0, 1)) ** 2;
  out.x = CLIMB.x0 + (CLIMB.x1 - CLIMB.x0) * e;
  out.y = CLIMB.y0 + (CLIMB.y1 - CLIMB.y0) * e;
  return out;
}

const rocket = {
  id: 'rocket',
  name: 'Rocket',
  category: 'celebration',
  scope: 'shape',
  description:
    'One shell, launched from the shape: it lifts on a plume, hangs, and breaks. Plays once each time the layer is switched on, so put it on a trigger and point it at the roofline.',
  params: [
    { key: 'shell', type: 'select', label: 'Shell', default: 'peony', options: SHELL_TYPES },
    { key: 'star', type: 'select', label: 'Star', default: 'strontium', options: [...Object.keys(STAR_COLOURS), 'single'] },
    { key: 'color', type: 'color', label: 'Single colour', default: '#ffd166' },
    { key: 'duration', type: 'range', label: 'Lasts (s)', default: 4.5, min: 1, max: 20, step: 0.1 },
    { key: 'lift', type: 'range', label: 'Lift (s)', default: 1.1, min: 0.2, max: 5, step: 0.05 },
    { key: 'height', type: 'range', label: 'Apogee', default: 900, min: 100, max: 3000, step: 25 },
    { key: 'drift', type: 'range', label: 'Drift', default: 120, min: -800, max: 800, step: 10 },
    { key: 'stars', type: 'range', label: 'Stars', default: 90, min: 8, max: 400, step: 1 },
    { key: 'power', type: 'range', label: 'Burst size', default: 520, min: 50, max: 2500, step: 10 },
    { key: 'gravity', type: 'range', label: 'Gravity', default: 260, min: 0, max: 2000, step: 10 },
    { key: 'size', type: 'range', label: 'Star size', default: 4, min: 1, max: 20, step: 0.5 },
    { key: 'flash', type: 'range', label: 'Report', default: 1, min: 0, max: 3, step: 0.05 },
    { key: 'seed', type: 'range', label: 'Shell number', default: 1, min: 1, max: 99, step: 1 },
  ],
  init() {
    return {};
  },
  /**
   * No `step`, and no particles.
   *
   * A shell is fully determined by the moment it was fired: every star is the
   * same star it was going to be, on a closed-form path from the same point. So
   * the whole thing is a function of `age`, seeded off the shell number — which
   * means a projector tab that joins the show a second after the trigger fired
   * draws the burst already half open, in the right place, rather than starting
   * it again from the ground.
   */
  draw({ g, p, shape, age, world }) {
    if (age < 0 || age > p.duration) return;
    const { bbox } = shape;
    const frameH = world?.h || 1080;
    const shellKind = SHELL_KINDS[p.shell] ? p.shell : 'peony';
    const kind = SHELL_KINDS[shellKind];
    const rng = makeRng(`rocket:${p.seed}:${shellKind}`);
    const salt = p.star === 'single' ? p.color : (STAR_COLOURS[p.star] || STAR_COLOURS.strontium);
    const saltLevel = p.star === 'single' ? 1 : (STAR_LEVEL[p.star] ?? 1);
    const power = Math.max(10, p.power);
    const size = Math.max(0.5, p.size);
    const flash = clamp(p.flash, 0, 3);
    const base = g.globalAlpha;

    /**
     * The climb, capped so it always leaves room for the break.
     *
     * Lift and Lasts are independent sliders and nothing stops the first
     * exceeding the second — at which point the shell is still rising when its
     * time runs out, and the effect draws a trail going up and nothing else.
     * That is not a shell that failed to burst, it is a shell that looks
     * broken, so the lift gets at most a third of the run.
     */
    const lift = Math.min(p.lift, p.duration * 0.34);

    /**
     * Where it breaks, kept inside the picture.
     *
     * The shell goes up by Apogee from the shape, which is right until the
     * shape is the roofline: that is a quarter of the way down a frame whose
     * top is just above the chimney, and nine hundred pixels above it is off
     * the top of the projector altogether. Every rocket in every preset broke
     * up there, where there is no wall to land on, and the effect drew nothing
     * anyone could see. So the break is held at least a little way inside the
     * frame — lower for a bigger shell, so the sphere has room to open — and
     * when that is lower than Apogee allows for, the *launch* moves down
     * instead, so the shell still climbs the full height: up the front of the
     * house from the garden, past the gutter, and over the roof. Which is where
     * a rocket fired in somebody's garden would have been seen anyway.
     */
    const ceiling = clamp(frameH * 0.08 + power * 0.3, frameH * 0.1, frameH * 0.45);
    const apexY = Math.max(bbox.cy - p.height, ceiling);
    const launchY = Math.min(apexY + p.height, Math.max(bbox.cy, frameH));
    const launchX = bbox.cx;
    const apexX = bbox.cx + p.drift * lift;
    CLIMB.lift = lift;
    CLIMB.x0 = launchX;
    CLIMB.y0 = launchY;
    CLIMB.x1 = apexX;
    CLIMB.y1 = apexY;

    g.save();
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';

    /* --- Lift --- */

    // The motor burns for the first four-fifths of the climb; the rest is the
    // shell coasting up to the top, dark, which is the moment of waiting for it.
    const burnOut = lift * 0.82;
    const tau = Math.min(age, lift);
    climbTo(HEAD, tau);
    const hx = HEAD.x;
    const hy = HEAD.y;

    /**
     * One straight path from the launch to wherever the shell is, stroked three
     * times: the smoke it leaves, which lingers the whole way down and fades
     * once the shell has broken; the glow of its tail; and a white-hot core
     * only along the last stretch. The gradients put each pass where it
     * belongs on the one line, so a long faint trail and a short hot one are
     * both drawn without a second path.
     */
    const smokeFade = age < lift ? 1 : Math.max(0, 1 - (age - lift) / 1.6);
    const motor = age < burnOut ? 1 : Math.max(0, 1 - (age - burnOut) / (lift - burnOut + 0.05));
    const runLength = Math.hypot(hx - launchX, hy - launchY);
    if (runLength > 1 && (smokeFade > 0.01 || motor > 0.01)) {
      g.beginPath();
      g.moveTo(launchX, launchY);
      g.lineTo(hx, hy);
      if (smokeFade > 0.01) {
        const smoke = g.createLinearGradient(launchX, launchY, hx, hy);
        smoke.addColorStop(0, rgba('#c9b8a6', 0));
        smoke.addColorStop(0.55, rgba('#c9b8a6', 0.09 * smokeFade));
        smoke.addColorStop(1, rgba('#e0c4a4', 0.2 * smokeFade));
        g.strokeStyle = smoke;
        g.lineWidth = 12 + 16 * Math.min(1, Math.max(0, age - lift * 0.5));
        g.stroke();
      }
      if (motor > 0.01) {
        const tailLen = Math.min(1, 260 / runLength);
        const glowGrad = g.createLinearGradient(launchX, launchY, hx, hy);
        glowGrad.addColorStop(0, rgba(blackbodyCss(1500), 0));
        glowGrad.addColorStop(1 - tailLen, rgba(blackbodyCss(1500), 0));
        glowGrad.addColorStop(1, rgba(blackbodyCss(2300), 0.7 * motor));
        g.strokeStyle = glowGrad;
        g.lineWidth = 9;
        g.stroke();
        const coreGrad = g.createLinearGradient(launchX, launchY, hx, hy);
        coreGrad.addColorStop(0, rgba(blackbodyCss(2600), 0));
        coreGrad.addColorStop(1 - tailLen * 0.45, rgba(blackbodyCss(2600), 0));
        coreGrad.addColorStop(1, rgba(blackbodyCss(4200), motor));
        g.strokeStyle = coreGrad;
        g.lineWidth = 3;
        g.stroke();
      }
    }

    /**
     * The sparks the motor sheds.
     *
     * A rocket's tail is not a line, it is a spray of burning motor falling
     * away behind it — each one thrown off at the rocket's speed less a little,
     * nudged sideways, slowing in the air and dropping as it cools. Seventy of
     * them over the burn, each a function of when it left, so the plume is the
     * same plume in every tab. They carry on falling after the break, which is
     * the one thing that joins the climb to the burst in a still.
     */
    const SHED = 70;
    for (let i = 0; i < SHED; i++) {
      // Every number drawn whether or not this one is showing, so the stars
      // after it get the same numbers on every frame.
      const born = ((i + rng()) / SHED) * burnOut;
      const side = (rng() - 0.5) * 220;
      const drop = (rng() - 0.3) * 90;
      const lifeSpan = 0.35 + rng() * 0.6;
      const heat = 2100 + rng() * 600;
      const t = age - born;
      if (t <= 0 || t >= lifeSpan) continue;
      climbTo(TAIL, born);
      climbTo(MID, born + 0.02);
      // The rocket's own velocity at that moment, from two nearby points.
      const vx = ((MID.x - TAIL.x) / 0.02) * 0.25 + side;
      const vy = ((MID.y - TAIL.y) / 0.02) * 0.25 + drop;
      const f = t / lifeSpan;
      const ox = TAIL.x;
      const oy = TAIL.y;
      const temp = lerp(heat, 1150, f);
      const bright = (1 - f) * Math.pow(temp / heat, 1.5);
      const r = 1.4 + 1.4 * (1 - f);
      flight(HEAD, ox, oy, vx, vy, 520, 3, t);
      flight(MID, ox, oy, vx, vy, 520, 3, Math.max(0, t - 0.025));
      flight(TAIL, ox, oy, vx, vy, 520, 3, Math.max(0, t - 0.05));
      g.fillStyle = blackbodyCss(temp);
      g.globalAlpha = base * clamp(0.9 * bright, 0, 1);
      g.beginPath();
      streak(g, TAIL.x, TAIL.y, MID.x, MID.y, HEAD.x, HEAD.y, r);
      g.fill();
    }
    g.globalAlpha = base;

    if (age < lift) {
      // The head: a hot point while the motor burns, a dull coasting ember
      // after it goes out, and the halo it throws on the wall around it.
      const ember = 0.25 + 0.75 * motor;
      glow(g, hx, hy, 18 + 22 * motor, blackbodyCss(lerp(1700, 5000, motor)), ember);
      if (motor > 0.01) glow(g, hx, hy, 170, blackbodyCss(2200), 0.4 * motor);
      g.restore();
      return;
    }

    /* --- Break --- */

    const burst = age - lift;
    const span = Math.max(0.2, p.duration - lift);
    const fadeOut = clamp((p.duration - age) / Math.min(0.6, span * 0.3), 0, 1);

    /**
     * The report: the flash you see before you hear it, over in a fraction of
     * a second and responsible for most of the impression that something
     * exploded — a white core, and the whole neighbourhood of the break lit
     * for an instant.
     */
    const report = Math.exp(-burst / 0.07) * flash;
    if (report > 0.01) {
      glow(g, apexX, apexY, 30 + power * 0.12, '#ffffff', clamp(report, 0, 1));
      glow(g, apexX, apexY, power * 1.3, tint(salt, '#ffffff', 0.6), clamp(0.55 * report, 0, 1));
    }

    const k = kind.drag;
    const grav = p.gravity * kind.droop;
    // Launch speed that carries a star `power` pixels before the air stops it.
    const v0 = power * k;
    const burnTime = span * kind.burn;

    const stars = Math.round(clamp(p.stars, 8, 400));
    const tilt = rng() * TAU;
    const charcoal = shellKind === 'willow' || shellKind === 'palm';
    starCount = 0;

    if (shellKind === 'palm') {
      /**
       * A palm is a handful of heavy comets, not a sphere: thick, bright,
       * glittering trails that arc out and droop like fronds. One for every
       * dozen stars asked for, between five and fourteen of them.
       */
      const fronds = Math.round(clamp(stars / 12, 5, 14));
      const gold = blackbodyCss(CHARCOAL_K + 400);
      for (let s = 0; s < fronds; s++) {
        const a = tilt + (s / fronds) * TAU + (rng() - 0.5) * 0.35;
        const speed = v0 * (0.85 + rng() * 0.25);
        const life = burnTime * (0.85 + rng() * 0.15);
        addStar(apexX, apexY, Math.cos(a), Math.sin(a), speed, burst, life, kind.tail,
          gold, size * 3, 1.15, rng() * 977);
      }
      drawStars(g, base, grav, k, fadeOut, blackbodyCss(1300), true, 24);
    } else if (shellKind === 'crossette') {
      /**
       * Crossette stars fly out together, then each splits once into four that
       * leave at right angles to one another — the one shell that changes shape
       * halfway. A quarter as many parents as stars asked for, so the picture
       * holds about the number of lights the slider says.
       */
      const parents = Math.round(clamp(stars / 5, 5, 32));
      const split = burnTime * 0.3;
      for (let s = 0; s < parents; s++) {
        // On a sphere, like a peony's stars, so the crosses fill a ball
        // rather than lining up round a hoop.
        const z = 1 - (2 * (s + 0.5)) / parents;
        const ring = Math.sqrt(Math.max(0, 1 - z * z));
        const a = tilt + s * 2.399963 + (rng() - 0.5) * 0.3;
        const speed = v0 * 0.62 * (0.35 + 0.65 * ring) * (0.9 + rng() * 0.2);
        const dx = Math.cos(a);
        const dy = Math.sin(a);
        const turn = (rng() - 0.5) * 0.5;
        if (burst < split) {
          addStar(apexX, apexY, dx, dy, speed, burst, burnTime, 0.22, salt, size * 1.3, saltLevel, s);
          continue;
        }
        // Where it was when it broke, and how fast it was still going.
        flight(TAIL, apexX, apexY, dx * speed, dy * speed, grav, k, split);
        const carry = Math.exp(-k * split);
        const bx = TAIL.x;
        const by = TAIL.y;
        const t = burst - split;
        const pop = Math.exp(-t / 0.05);
        if (pop > 0.02) glow(g, bx, by, 12 + size * 5, tint(salt, '#ffffff', 0.7), pop * saltLevel);
        for (let q = 0; q < 4; q++) {
          const b = a + turn + Math.PI / 4 + (q * Math.PI) / 2;
          const piece = v0 * 0.5;
          // The pieces inherit what is left of the parent's speed: a cross that
          // is still travelling, not one pinned to the spot where it broke.
          const pvx = Math.cos(b) * piece + dx * speed * carry * 0.6;
          const pvy = Math.sin(b) * piece + dy * speed * carry * 0.6;
          const pv = Math.hypot(pvx, pvy) || 1;
          addStar(bx, by, pvx / pv, pvy / pv, pv, t, burnTime - split, 0.3, salt, size, saltLevel * 1.15, s * 4 + q);
        }
      }
      drawStars(g, base, grav, k, fadeOut, blackbodyCss(1200), false, 0);
    } else {
      /**
       * An even sphere, seen flat.
       *
       * The stars are laid on a Fibonacci sphere — as evenly as points can be
       * spread over a ball — and projected, so the burst has the dense rim and
       * the scattering of slow stars in the middle that a real shell has: the
       * ones you see edge-on are crossing your view at full speed and the ones
       * coming at you hardly seem to move. Random directions instead clump,
       * and equal speeds in a flat circle make a ring.
       */
      for (let s = 0; s < stars; s++) {
        const z = 1 - (2 * (s + 0.5)) / stars;
        const ring = Math.sqrt(Math.max(0, 1 - z * z));
        const phi = tilt + s * 2.399963 + (rng() - 0.5) * 0.25;
        const speed = v0 * ring * (0.9 + rng() * 0.16);
        const life = burnTime * (0.78 + rng() * 0.22);
        const colour = charcoal ? blackbodyCss(CHARCOAL_K + rng() * 300) : salt;
        addStar(apexX, apexY, Math.cos(phi), Math.sin(phi), speed, burst, life, kind.tail,
          colour, size * (charcoal ? 0.75 : 1), charcoal ? 0.95 : saltLevel, rng() * TAU);
      }
      drawStars(g, base, grav, k, fadeOut, blackbodyCss(charcoal ? 1250 : 1150), charcoal, 0);
    }

    g.restore();
  },
};

/**
 * The stars of one shell, as a list rather than as objects.
 *
 * A shell is a few hundred stars a frame, and a little object for each of them
 * every frame is exactly the allocation the effect contract asks you not to
 * make. So the star loop writes each one into these columns and `drawStars`
 * paints the lot. Sized for the most a shell can hold: four hundred stars, or
 * forty crossette parents in four pieces each.
 */
const STAR_MAX = 400;
const ST_AX = new Float64Array(STAR_MAX);
const ST_AY = new Float64Array(STAR_MAX);
const ST_DX = new Float64Array(STAR_MAX);
const ST_DY = new Float64Array(STAR_MAX);
const ST_SPEED = new Float64Array(STAR_MAX);
const ST_T = new Float64Array(STAR_MAX);
const ST_LIFE = new Float64Array(STAR_MAX);
const ST_TAIL = new Float64Array(STAR_MAX);
const ST_WIDTH = new Float64Array(STAR_MAX);
const ST_LEVEL = new Float64Array(STAR_MAX);
const ST_GLITTER = new Float64Array(STAR_MAX);
const ST_SALT = new Array(STAR_MAX).fill('#ffffff');
// Worked out by `drawStars` for each star this frame.
const ST_BRIGHT = new Float64Array(STAR_MAX);
const ST_W = new Float64Array(STAR_MAX);
let starCount = 0;

function addStar(ax, ay, dx, dy, speed, t, life, tail, salt, width, level, glitter) {
  if (starCount >= STAR_MAX) return;
  const i = starCount++;
  ST_AX[i] = ax;
  ST_AY[i] = ay;
  ST_DX[i] = dx;
  ST_DY[i] = dy;
  ST_SPEED[i] = speed;
  ST_T[i] = t;
  ST_LIFE[i] = life;
  ST_TAIL[i] = tail;
  ST_SALT[i] = salt;
  ST_WIDTH[i] = width;
  ST_LEVEL[i] = level;
  ST_GLITTER[i] = glitter;
}

/**
 * Paint the shell's stars, at their own ages.
 *
 * A short star (peony, crossette) is drawn like a spark: a tapered streak of
 * the last tenth of a second or so of its flight, led by a round head that is
 * white-hot while it is fresh, inside a halo — round, not stretched, because it
 * is the light the star throws rather than the path it took. A long one
 * (willow, palm) drags a whole second of its path behind it as two tapered
 * streaks — the full length thin and faint, the front stretch fuller and
 * brighter — so the strand fades towards where the star has been; a palm's
 * comets glitter along it besides.
 *
 * The colour is the salt while the star burns and goes down the blackbody
 * curve as the composition runs out, so the last of a red shell is a deep
 * ember and the last of a gold one a dull orange.
 *
 * Painted in batches, not star by star. A shell is a hundred-odd stars that
 * all left at the same instant, so at any moment they are nearly all the same
 * colour at nearly the same brightness — and one fill per star per pass was
 * most of what the effect cost. So each star is sorted into one of a few
 * steps of brightness and of burn-out, and each step goes down as one path:
 * the faintest passes (the halos, a willow's full strands) as one fill for the
 * whole shell, the rest as at most a score of fills, whatever the star count.
 */
function drawStars(g, base, grav, k, fade, ember, long, sparkle) {
  let total = 0;
  let alive = 0;
  let fresh = 0;
  BUCKET_COUNT.fill(0);
  for (let i = 0; i < starCount; i++) {
    ST_BRIGHT[i] = 0;
    const t = ST_T[i];
    if (t <= 0 || t >= ST_LIFE[i]) continue;
    const f = t / ST_LIFE[i];
    // The salt, and the ember over the last quarter of the burn.
    const dying = clamp((f - 0.72) / 0.28, 0, 1);
    const twinkle = 0.82 + 0.18 * Math.sin(t * 31 + ST_GLITTER[i] * 7.3);
    const bright = ST_LEVEL[i] * twinkle * Math.min(1, t / 0.03) * (1 - 0.35 * f) * (1 - dying * 0.85) * fade;
    if (bright < 0.01) continue;
    ST_BRIGHT[i] = bright;
    ST_W[i] = ST_WIDTH[i] * 1.4 * (1 - 0.3 * f);
    const step = Math.round(dying * (BURN_STEPS - 1)) * BRIGHT_STEPS
      + Math.min(BRIGHT_STEPS - 1, Math.floor((bright / BRIGHT_TOP) * BRIGHT_STEPS));
    ST_STEP[i] = step;
    BUCKET_COUNT[step]++;
    // White for the first instant — everything is white in the report.
    if (!alive) fresh = Math.exp(-t / 0.06);
    total += bright;
    alive++;
  }
  if (!alive) return;
  const mean = total / alive;
  const salt = ST_SALT[0];

  if (long) {
    // Every strand's full length, faint, as one fill: a tapered streak from
    // the head back along the curve the star has flown.
    g.fillStyle = salt;
    g.globalAlpha = base * clamp(0.32 * mean, 0, 1);
    g.beginPath();
    for (let i = 0; i < starCount; i++) {
      if (ST_BRIGHT[i] <= 0) continue;
      starPoints(i, grav, k, ST_TAIL[i]);
      streak(g, TAIL.x, TAIL.y, MID.x, MID.y, HEAD.x, HEAD.y, Math.max(0.8, ST_W[i] * 0.6));
    }
    g.fill();
  } else {
    // The halos, two steps of falloff, one path each for the whole shell.
    g.fillStyle = salt;
    for (let h = 0; h < HALO_STEPS.length; h += 2) {
      const reach = HALO_STEPS[h];
      g.globalAlpha = base * clamp(HALO_STEPS[h + 1] * mean, 0, 1);
      g.beginPath();
      for (let i = 0; i < starCount; i++) {
        if (ST_BRIGHT[i] <= 0) continue;
        flight(HEAD, ST_AX[i], ST_AY[i], ST_DX[i] * ST_SPEED[i], ST_DY[i] * ST_SPEED[i], grav, k, ST_T[i]);
        const r = ST_W[i] * reach;
        g.moveTo(HEAD.x + r, HEAD.y);
        g.arc(HEAD.x, HEAD.y, r, 0, TAU);
      }
      g.fill();
    }
  }

  // The streaks — the front stretch of a long star, all of a short one's —
  // and then the heads over them, a batch per step of brightness and burn.
  const reach = long ? 0.4 : 1;
  const body = long ? 0.55 : 0.5;
  const head = long ? 0.8 : 0.62;
  for (let step = 0; step < BUCKET_COUNT.length; step++) {
    if (!BUCKET_COUNT[step]) continue;
    const burn = Math.floor(step / BRIGHT_STEPS) / (BURN_STEPS - 1);
    const level = (((step % BRIGHT_STEPS) + 0.5) / BRIGHT_STEPS) * BRIGHT_TOP;
    const colour = burn > 0 ? tint(salt, ember, burn) : salt;
    g.fillStyle = colour;
    g.globalAlpha = base * clamp((long ? 0.62 : 0.7) * level, 0, 1);
    g.beginPath();
    for (let i = 0; i < starCount; i++) {
      if (ST_BRIGHT[i] <= 0 || ST_STEP[i] !== step) continue;
      starPoints(i, grav, k, ST_TAIL[i] * reach);
      streak(g, TAIL.x, TAIL.y, MID.x, MID.y, HEAD.x, HEAD.y, Math.max(long ? 0.9 : 0.5, ST_W[i] * body));
    }
    g.fill();
    g.fillStyle = tint(colour, '#ffffff', 0.45 + 0.45 * fresh);
    g.globalAlpha = base * clamp((long ? 0.9 : 1) * level, 0, 1);
    g.beginPath();
    for (let i = 0; i < starCount; i++) {
      if (ST_BRIGHT[i] <= 0 || ST_STEP[i] !== step) continue;
      flight(HEAD, ST_AX[i], ST_AY[i], ST_DX[i] * ST_SPEED[i], ST_DY[i] * ST_SPEED[i], grav, k, ST_T[i]);
      const r = Math.max(long ? 0.8 : 0.6, ST_W[i] * head);
      g.moveTo(HEAD.x + r, HEAD.y);
      g.arc(HEAD.x, HEAD.y, r, 0, TAU);
    }
    g.fill();
  }

  if (!sparkle) return;
  /**
   * Glitter: the burning flecks a comet sheds, hanging along its trail and
   * flashing on and off as they go. Which of them is lit is a hash of the fleck
   * and a twentieth of a second, so it twinkles at the same rate in every tab
   * and the strand reads as a spray rather than a rope.
   */
  for (let i = 0; i < starCount; i++) {
    const bright = ST_BRIGHT[i];
    if (bright <= 0) continue;
    const w = ST_W[i];
    const t = ST_T[i];
    const vx = ST_DX[i] * ST_SPEED[i];
    const vy = ST_DY[i] * ST_SPEED[i];
    g.fillStyle = tint(salt, '#ffffff', 0.35);
    g.globalAlpha = base * clamp(0.75 * bright, 0, 1);
    g.beginPath();
    for (let j = 1; j <= sparkle; j++) {
      const along = j / sparkle;
      const seed = ST_GLITTER[i] + j * 12.9898;
      const on = frac(Math.sin(seed + Math.floor(t * 20) * 78.233) * 43758.5453);
      if (on < 0.45) continue;
      flight(HEAD, ST_AX[i], ST_AY[i], vx, vy, grav, k, Math.max(0, t - ST_TAIL[i] * along * 0.95));
      // Scattered either side of the line, wider towards the tail, as flecks
      // drifting off a comet are.
      const off = (frac(Math.sin(seed * 3.7) * 24634.6345) - 0.5) * w * (0.6 + 2.2 * along);
      const rr = Math.max(0.7, w * 0.3 * (1 - along * 0.6));
      const px = HEAD.x - ST_DY[i] * off;
      const py = HEAD.y + ST_DX[i] * off;
      g.moveTo(px + rr, py);
      g.arc(px, py, rr, 0, TAU);
    }
    g.fill();
  }
}

/** Head, middle and tail of star `i`'s last `back` seconds, into the scratch points. */
function starPoints(i, grav, k, back) {
  const t = ST_T[i];
  const b = Math.min(t, back);
  const vx = ST_DX[i] * ST_SPEED[i];
  const vy = ST_DY[i] * ST_SPEED[i];
  flight(HEAD, ST_AX[i], ST_AY[i], vx, vy, grav, k, t);
  flight(MID, ST_AX[i], ST_AY[i], vx, vy, grav, k, t - b * 0.5);
  flight(TAIL, ST_AX[i], ST_AY[i], vx, vy, grav, k, t - b);
}

/** A short star's halo, as pairs: how far out in head widths, and how strong. */
const HALO_STEPS = [3, 0.07, 1.7, 0.12];

/** Steps of brightness and of burn-out the stars are batched into. */
const BRIGHT_STEPS = 5;
const BURN_STEPS = 4;
const BRIGHT_TOP = 1.2;
const BUCKET_COUNT = new Int16Array(BRIGHT_STEPS * BURN_STEPS);
const ST_STEP = new Int16Array(STAR_MAX);

/* ------------------------------------------------------------------ *
 * Confetti cannon
 * ------------------------------------------------------------------ */

const CANNON_COLOURS = ['#ff3b6b', '#ffd166', '#4cc2ff', '#8aff80', '#c77dff', '#ff8a3d'];
/** The same papers from behind, in the shade of their own tumble. */
const CANNON_BACKS = CANNON_COLOURS.map((c) => mixHex(c, '#000000', 0.45));
/** And face-on, catching the light: the flash that makes a cloud of it glitter. */
const CANNON_GLINTS = CANNON_COLOURS.map((c) => mixLinear(c, '#ffffff', 0.62));

const confettiCannon = {
  id: 'confetti-cannon',
  name: 'Confetti Cannon',
  category: 'celebration',
  scope: 'shape',
  description:
    'A cone of paper fired out of the shape, tumbling as it goes and drifting down. Plays once each time the layer is switched on — point it at the door and put it on the bell.',
  params: [
    { key: 'count', type: 'range', label: 'Pieces', default: 160, min: 10, max: 600, step: 10 },
    { key: 'duration', type: 'range', label: 'Lasts (s)', default: 5, min: 0.5, max: 20, step: 0.1 },
    { key: 'speed', type: 'range', label: 'Muzzle speed', default: 1100, min: 100, max: 4000, step: 25 },
    { key: 'aim', type: 'range', label: 'Aim (degrees)', default: -90, min: -180, max: 180, step: 5 },
    { key: 'spread', type: 'range', label: 'Spread', default: 0.16, min: 0.02, max: 1, step: 0.01 },
    { key: 'gravity', type: 'range', label: 'Gravity', default: 420, min: 0, max: 2000, step: 10 },
    { key: 'drag', type: 'range', label: 'Air drag', default: 1.6, min: 0, max: 6, step: 0.05 },
    { key: 'size', type: 'range', label: 'Size', default: 18, min: 3, max: 90, step: 1 },
    { key: 'tumble', type: 'range', label: 'Tumble', default: 1, min: 0, max: 4, step: 0.05 },
    { key: 'streamers', type: 'range', label: 'Streamers', default: 0.3, min: 0, max: 1, step: 0.01 },
    { key: 'seed', type: 'range', label: 'Charge', default: 1, min: 1, max: 99, step: 1 },
  ],
  init() {
    return {};
  },
  /**
   * Also stateless, and for the same reason as the rocket — but the physics is
   * the opposite one. A confetti cannon is the clearest demonstration of drag
   * there is: the paper leaves the barrel at the speed of a thrown ball and is
   * down to a drift within a metre, because a scrap of paper has an enormous
   * area for its mass. Modelled as exponential decay towards terminal velocity,
   * which is the closed form of exactly that, so no integration is needed and
   * every tab agrees without remembering anything.
   */
  draw({ g, p, shape, age }) {
    if (age < 0 || age > p.duration) return;
    const { bbox } = shape;
    const rng = makeRng(`cannon:${p.seed}`);
    const aim = (p.aim * Math.PI) / 180;
    const k = Math.max(0.05, p.drag);
    const terminal = p.gravity / k;
    const base = g.globalAlpha;
    const fade = clamp((p.duration - age) / (p.duration * 0.25), 0, 1);
    /**
     * How far a body launched at v0 has travelled in `elapsed`, with drag ~ -k v.
     *
     * `elapsed` is a parameter rather than the enclosing `age` because the
     * pieces leave the barrel staggered: closing over `age` made the horizontal
     * position count from the shot and the vertical one from the piece's own
     * launch, so a delayed piece appeared already displaced sideways — very
     * visible at the muzzle speeds the presets use.
     */
    const travel = (v0, elapsed) => (v0 / k) * (1 - Math.exp(-k * elapsed));

    g.save();

    /**
     * The pop: a flash at the muzzle, over in a twentieth of a second, and
     * the faint puff the charge leaves hanging in front of the door after
     * the paper has gone. Light, both of them — the smoke is only there to the
     * extent that the flash and the house light it.
     */
    const pop = Math.exp(-age / 0.05);
    const puff = Math.exp(-age / 0.9) * Math.min(1, age / 0.08);
    if (pop > 0.02 || puff > 0.02) {
      g.globalCompositeOperation = 'lighter';
      if (pop > 0.02) glow(g, bbox.cx, bbox.cy, 70 + p.size * 3, '#fff1d6', clamp(pop, 0, 1));
      const reach = 60 + age * 90;
      glow(g, bbox.cx + Math.cos(aim) * reach * 0.6, bbox.cy + Math.sin(aim) * reach * 0.6,
        reach + 40, '#b9b2c6', 0.14 * puff);
      g.globalCompositeOperation = 'source-over';
    }

    g.lineCap = 'round';
    for (let i = 0; i < Math.round(clamp(p.count, 10, 600)); i++) {
      const a = aim + (rng() - 0.5) * Math.PI * p.spread * 2;
      const v = p.speed * (0.4 + rng() * 0.9);
      const hue = Math.floor(rng() * CANNON_COLOURS.length);
      const streamer = rng() < p.streamers;
      const size = p.size * (0.6 + rng() * 0.8);
      const spin = rng() * TAU;
      const rate = (0.8 + rng() * 2.4) * (rng() < 0.5 ? -1 : 1);
      const delay = rng() * 0.08;
      const life = age - delay;
      if (life <= 0) continue;

      const decay = Math.exp(-k * life);
      const x = bbox.cx + travel(Math.cos(a) * v, life);
      // Vertical is the same decay plus the terminal fall it settles into.
      const y = bbox.cy + travel(Math.sin(a) * v, life) + terminal * (life - (1 - decay) / k);
      // Its velocity now, for the blur on the way out of the barrel.
      const vx = Math.cos(a) * v * decay;
      const vy = Math.sin(a) * v * decay + terminal * (1 - decay);

      const turn = spin + rate * p.tumble * life * 4;
      const facing = Math.cos(turn);
      const shown = Math.abs(facing);
      g.globalAlpha = base * fade;

      if (streamer) {
        /**
         * A streamer is a ribbon, and a ribbon curls: a short run of curve
         * with a wave travelling down it, its width the face it is showing.
         * A rigid strip reads as a stick of something.
         */
        const L = size * 3.2;
        const wave = life * 8 + spin;
        const lean = Math.atan2(vy, vx) - Math.PI / 2 + Math.sin(life * 2 + spin) * 0.6;
        g.save();
        g.translate(x, y);
        g.rotate(lean);
        g.strokeStyle = facing >= 0 ? CANNON_COLOURS[hue] : CANNON_BACKS[hue];
        g.lineWidth = Math.max(1, shown * size * 0.32);
        g.beginPath();
        g.moveTo(Math.sin(wave) * size * 0.4, -L / 2);
        g.quadraticCurveTo(Math.sin(wave + 1.4) * size * 0.75, -L / 6, Math.sin(wave + 2.1) * size * 0.4, 0);
        g.quadraticCurveTo(Math.sin(wave + 2.8) * size * 0.75, L / 6, Math.sin(wave + 4.2) * size * 0.4, L / 2);
        g.stroke();
        g.restore();
        continue;
      }

      /**
       * A scrap of paper, tumbling — and on its way out of the barrel, a blur.
       *
       * For the first fraction of a second each piece is crossing several
       * times its own length every frame, and drawn sharp it reads as a
       * still of a cloud rather than a shot. So a fast piece is laid along its
       * own velocity and stretched by the distance it covers in a sixtieth of
       * a second; by the time the air has slowed it the stretch has gone and
       * it is tumbling end over end like any other bit of paper.
       */
      const speed = Math.hypot(vx, vy);
      const smear = speed / 60;
      const blur = clamp((smear - size * 0.25) / (size * 0.75), 0, 1);
      const w = Math.max(0.6, shown * size);
      const h = size * 0.7;
      const angle = blur > 0
        ? Math.atan2(vy, vx) + Math.PI / 2
        : a + Math.sin(life * 3 + spin) * 0.5;
      const length = h + smear * blur;
      const width = blur > 0 ? Math.max(0.8, w * (1 - 0.5 * blur) + size * 0.25 * blur) : w;
      g.save();
      g.translate(x, y);
      g.rotate(angle);
      g.fillStyle = facing >= 0 ? CANNON_COLOURS[hue] : CANNON_BACKS[hue];
      g.fillRect(-width * 0.5, -length * 0.5, width, length);
      if (shown > 0.86 && blur < 1) {
        // Face-on to you, it catches the light — the glitter of a cloud of it.
        g.globalAlpha = base * fade * ((shown - 0.86) / 0.14) ** 1.5 * (1 - blur);
        g.fillStyle = CANNON_GLINTS[hue];
        g.fillRect(-width * 0.5, -length * 0.5, width, length);
      }
      g.restore();
    }
    g.restore();
  },
};

export default [batBurst, shockwave, sparkBurst, rocket, confettiCannon];
