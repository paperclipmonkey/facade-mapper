/**
 * Somebody small, out in the evening.
 *
 * Every other effect in this library is weather, or decoration, or something
 * happening *to* the house. This one is a character living on it, and the
 * difference is entirely in the parts nobody asks for: an animal that only
 * walks is a sprite, and an animal that walks, stops, looks back the way it
 * came, pushes a headphone cup back onto its ear, puts its hands in its pouch
 * and sits down on the gutter for a while is somebody. The walk is about a
 * tenth of the code below. The rest is why it works.
 *
 * Two effects, meant to be run together:
 *
 * - **Wanderer** walks along a shape you point it at — a traced roofline is
 *   the one to reach for — and is the thing people watch.
 * - **Lofi Vista** is the world behind: a dusk sky, a city in three bands of
 *   depth that drift at three different rates, and a branch across the near
 *   corner. Point it at the wall and the wall stops being a wall.
 *
 * Three decisions worth stating, because each one is the difference between
 * this reading as an animal and reading as a cartoon of one:
 *
 * **The walk has ground contact.** A leg swung on a sine wave slides along the
 * surface for the whole cycle, and a foot that slides is the single loudest
 * tell that something is animated rather than moving. The cycle here is the
 * real one — half of it is stance, where the foot is planted and the *body*
 * travels over it, and half is swing, where the foot arcs forward through the
 * air. It costs four lines more than the sine and it is the whole effect.
 *
 * **Secondary motion is simulated, not keyframed.** The tail is a chain of
 * damped springs, so it lags the hips, overshoots when they stop, and settles.
 * A tail wagged on a sine wave is a metronome tied to an animal. Which means
 * the tail is state, which means it belongs in `step` — see the note there.
 *
 * **Nothing here is exactly periodic.** Blinks, ear flicks, the decision to
 * stop, and which idle thing to do when stopped are all drawn from the seeded
 * generator. Anything that repeats on a period the eye can measure stops being
 * alive at about the fourth repetition, which is roughly when somebody
 * standing on your path has decided whether to keep watching.
 *
 * Projected, the thing to know is that a projector adds light and cannot take
 * any away: the silhouette has to be *lit* rather than dark. Hence the rim —
 * a warm edge down the side facing the sunset — which is what stops a filled
 * orange shape reading as a sticker on the brickwork.
 */

import {
  clamp, lerp, smoothstep, frac, TAU, rgba, mixHex, makeRng, buildPathSampler,
} from '../../core/math.js';
import { mixLinear } from '../color.js';
import { glow, curveThrough } from '../lib.js';

/* ------------------------------------------------------------------ *
 * The line they walk on
 * ------------------------------------------------------------------ */

/**
 * What counts as ground, for whatever somebody pointed the layer at.
 *
 * A traced roofline is an open path and is the obvious answer — walk along it.
 * A window is not: its outline goes up the jambs and back across the head, and
 * an animal that walked it would spend two thirds of its time on a wall. So a
 * closed shape gets its sill instead, which is the edge of it anybody would
 * have meant.
 *
 * Returns null rather than a degenerate sampler when there is nothing to walk
 * on — a single-point path, a shape whose points were all dragged together —
 * and every caller checks. A sampler over a zero-length path answers every
 * query with the same point, which draws the animal on the spot, treadmilling,
 * forever, with no clue anywhere as to why.
 */
function buildLane(shape, mode) {
  const { bbox } = shape;
  const wanted = mode === 'auto' ? (shape.closed ? 'bottom' : 'path') : mode;

  if (wanted === 'path') {
    const sampler = shape.sampler;
    if (!sampler || !(sampler.length > 1)) return null;
    return { at: sampler.at, length: sampler.length, closed: !!shape.closed };
  }

  if (!(bbox.w > 1)) return null;
  const y = wanted === 'top' ? bbox.y : bbox.y + bbox.h;
  const sampler = buildPathSampler(
    [{ x: bbox.x, y }, { x: bbox.x + bbox.w, y }],
    false
  );
  return { at: sampler.at, length: sampler.length, closed: false };
}

/** Rebuild the lane only when the shape or the choice actually changed. */
function ensureLane(state, shape, mode) {
  const key = `${shape.id}:${mode}:${shape.closed}:${Math.round(shape.bbox.x)}:${Math.round(shape.bbox.y)}:${Math.round(shape.bbox.w)}:${Math.round(shape.bbox.h)}`;
  if (state.laneKey !== key) {
    state.laneKey = key;
    state.lane = buildLane(shape, mode);
  }
  return state.lane;
}

/* ------------------------------------------------------------------ *
 * The walk cycle
 * ------------------------------------------------------------------ */

/**
 * Where one foot is, at phase `s` of its own cycle.
 *
 * The first half is stance: the foot is on the ground and travels backwards
 * through the body at a constant rate, which is what makes the *body* appear
 * to travel forwards over it. The second half is swing: it arcs forward
 * through the air on a half-sine.
 *
 * `x` is in stride half-widths, `lift` in leg lengths. Both in the body's own
 * frame, so the caller can lay them onto a slope without knowing any of this.
 */
function footAt(s, out) {
  const u = frac(s);
  if (u < 0.5) {
    out.x = 1 - 4 * u;              // +1 (heel strike) to -1 (toe off)
    out.lift = 0;
  } else {
    const k = (u - 0.5) * 2;        // 0..1 through the swing
    out.x = -1 + 2 * k;
    out.lift = Math.sin(Math.PI * k);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Wanderer
 * ------------------------------------------------------------------ */

/** What the animal can be doing with itself while it is not going anywhere. */
const IDLES = ['look', 'headphones', 'pockets', 'stretch', 'yawn'];

const wanderer = {
  id: 'wanderer',
  name: 'Wanderer',
  category: 'atmosphere',
  scope: 'shape',
  description:
    'A small hooded animal in headphones, walking slowly along a roofline or a sill, stopping to look back, push a headphone cup on, put its hands in its pouch, stretch, and sit down for a while. Point it at a traced roofline.',
  params: [
    { key: 'hoodie', type: 'color', label: 'Hoodie', default: '#e08a3c' },
    { key: 'fur', type: 'color', label: 'Fur', default: '#f7dcae' },
    { key: 'ink', type: 'color', label: 'Ink', default: '#2c1a2a' },
    { key: 'rim', type: 'color', label: 'Rim light', default: '#ffcf83' },
    { key: 'rimAmount', type: 'range', label: 'Rim strength', default: 0.6, min: 0, max: 1, step: 0.01 },
    { key: 'size', type: 'range', label: 'Height (of frame)', default: 0.115, min: 0.02, max: 0.4, step: 0.005 },
    { key: 'speed', type: 'range', label: 'Walk speed (px/s)', default: 26, min: 0, max: 160, step: 1 },
    { key: 'ledge', type: 'select', label: 'Walks on', default: 'auto', options: ['auto', 'path', 'bottom', 'top'] },
    { key: 'patrol', type: 'select', label: 'At the end', default: 'turn back', options: ['turn back', 'carry on'] },
    { key: 'start', type: 'range', label: 'Starts along', default: 0.15, min: 0, max: 1, step: 0.01 },
    { key: 'raise', type: 'range', label: 'Lift off the line', default: 0, min: -1, max: 1, step: 0.01 },
    { key: 'restless', type: 'range', label: 'How often they stop', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'sitting', type: 'range', label: 'Chance of sitting down', default: 0.35, min: 0, max: 1, step: 0.01 },
    { key: 'nod', type: 'range', label: 'Nods to the beat', default: 0.45, min: 0, max: 1, step: 0.01 },
    { key: 'headphones', type: 'bool', label: 'Headphones', default: true },
    { key: 'hood', type: 'bool', label: 'Hood up', default: true },
    { key: 'line', type: 'range', label: 'Outline', default: 2, min: 0, max: 12, step: 0.5 },
  ],

  init() {
    return {
      /** Where along the lane, 0..1, and which way round. */
      u: 0,
      dir: 1,
      /** Which way they are *facing*, springing through zero on a turn. */
      face: 1,
      /** Distance walked, in body heights. Drives the gait, so a slow walk
       *  takes the same number of strides per metre as a fast one. */
      stride: 0,
      mode: 'walk',
      modeT: 0,
      modeFor: 6,
      sit: 0,
      idle: '',
      idleT: 0,
      idleFor: 0,
      blink: 0,
      blinkIn: 2,
      blinkAgain: 0,
      flick: 0,
      flickIn: 4,
      tail: null,
      started: false,
      laneKey: '',
      lane: null,
    };
  },

  /**
   * Everything that remembers.
   *
   * The position, the errand they are on, when they next blink, and the tail —
   * which is seven damped springs and therefore the one part of this that
   * genuinely cannot be a function of `t`. All of it here rather than in
   * `draw`, so a projector tab opened halfway through the evening replays the
   * same walk and arrives at the same place on the gutter as the tab that has
   * been running since dusk. See docs/writing-effects.md.
   */
  step({ p, dt, rng, state, shape, world }) {
    const lane = ensureLane(state, shape, p.ledge);
    if (!lane) return;

    if (!state.tail) {
      state.tail = Array.from({ length: 7 }, () => ({ a: 2.5, v: 0 }));
    }
    if (!state.started) {
      state.started = true;
      state.u = clamp(p.start, 0, 1);
      state.modeFor = 3 + rng() * 6;
    }

    /* -- the errand ------------------------------------------------- */

    state.modeT += dt;
    if (state.modeT >= state.modeFor) {
      state.modeT = 0;
      if (state.mode === 'walk') {
        state.mode = rng() < p.sitting ? 'sit' : 'stand';
        state.modeFor = state.mode === 'sit' ? 7 + rng() * 16 : 2 + rng() * 4;
      } else {
        state.mode = 'walk';
        // Restless at 1 is a stop every few seconds; at 0 they never stop at
        // all, and the layer is a patrol rather than a character.
        const settled = 1 - clamp(p.restless, 0, 1);
        state.modeFor = 4 + settled * 90 + rng() * (6 + settled * 40);
      }
    }

    // Sitting down and getting up are the same eased move run both ways, which
    // is why `sit` is a number rather than the mode itself.
    const wantSit = state.mode === 'sit' ? 1 : 0;
    state.sit += clamp(wantSit - state.sit, -1, 1) * Math.min(1, dt * 3.2);

    /* -- the idle they are in the middle of ------------------------- */

    if (state.idle) {
      state.idleT += dt;
      if (state.idleT >= state.idleFor) state.idle = '';
    } else {
      // Far likelier to fidget while stopped than while walking, and the two
      // sets differ: nobody stretches mid-stride.
      const walking = state.mode === 'walk';
      const chance = (walking ? 0.09 : 0.55) * dt;
      if (rng() < chance) {
        const pool = walking ? IDLES.slice(0, 3) : IDLES;
        state.idle = pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
        state.idleT = 0;
        state.idleFor = { look: 2.6, headphones: 1.9, pockets: 5 + rng() * 9, stretch: 2.4, yawn: 1.7 }[state.idle];
      }
    }

    /* -- blinking and ear flicks ------------------------------------ */

    state.blink = Math.max(0, state.blink - dt * 5);
    state.blinkIn -= dt;
    if (state.blinkIn <= 0) {
      state.blink = 1;
      // Roughly one blink in four is a double, which is the detail that stops
      // the eye reading a metronome behind the eyelid.
      if (state.blinkAgain > 0) {
        state.blinkAgain -= 1;
        state.blinkIn = 0.22;
      } else {
        state.blinkAgain = rng() < 0.25 ? 1 : 0;
        state.blinkIn = 1.6 + rng() * 5;
      }
    }

    state.flick = Math.max(0, state.flick - dt * 4);
    state.flickIn -= dt;
    if (state.flickIn <= 0) {
      state.flick = 1;
      state.flickIn = 2.5 + rng() * 9;
    }

    /* -- going somewhere -------------------------------------------- */

    const moving = state.mode === 'walk' && state.sit < 0.02;
    /**
     * The gait advances with *distance*, not with time.
     *
     * A slow walk and a fast one then take the same number of paces per metre
     * of gutter and only the cadence differs, which is what stops the speed
     * slider turning the walk into a scuttle — and it is what lets `GAIT_CYCLE`
     * be the one number that keeps the planted foot still.
     */
    const heightPx = Math.max(4, p.size * Math.max(1, world?.h || 1080));
    if (moving && p.speed > 0 && lane.length > 0) {
      state.u += ((p.speed * dt) / lane.length) * state.dir;
      state.stride += (p.speed * dt) / (heightPx * GAIT_CYCLE);

      if (lane.closed) {
        state.u = frac(state.u);
      } else if (p.patrol === 'carry on') {
        state.u = frac(state.u);
      } else if (state.u > 1 || state.u < 0) {
        state.u = clamp(state.u, 0, 1);
        state.dir = -state.dir;
      }
    }

    // The turn itself: `face` crosses zero, so they are briefly edge-on and
    // genuinely turn round rather than flipping between two mirror images.
    state.face += clamp(state.dir - state.face, -1, 1) * Math.min(1, dt * 4.5);

    /* -- the tail ---------------------------------------------------- */

    /**
     * Seven damped springs, each chasing the one in front of it.
     *
     * The base angle is set by what the hips are doing — swinging with the
     * gait while walking, curled round while sitting — and every segment after
     * the first only ever hears about that through its neighbour. That delay is
     * the whole point: the tip is still going the way the hips were going a
     * third of a second ago, so it lags into a turn, overshoots when they stop,
     * and settles by itself.
     */
    const hipSway = Math.sin(state.stride * TAU) * (moving ? 0.28 : 0);
    const base = lerp(2.15, 2.55, clamp(state.sit, 0, 1)) + hipSway
      + Math.sin(state.modeT * 0.9) * 0.05;
    /**
     * How tight the curl is, and it has a ceiling for a reason.
     *
     * Seven segments times the curl is how far round the whole tail comes.
     * Past about two radians the tip has gone behind the hips and under the
     * body, and the animal appears to have no tail at all — which is what a
     * sitting pose did until this was pulled back.
     */
    const curl = lerp(0.2, 0.27, clamp(state.sit, 0, 1));
    let target = base;
    for (const seg of state.tail) {
      const diff = target - seg.a;
      seg.v += (diff * 150 - seg.v * 17) * dt;
      seg.v = clamp(seg.v, -40, 40);
      seg.a += seg.v * dt;
      target = seg.a + curl;
    }
  },

  draw({ g, p, shape, t, beat, state, world }) {
    const lane = ensureLane(state, shape, p.ledge);
    if (!lane || !state.tail) return;

    const H = Math.max(4, p.size * Math.max(1, world?.h || shape.bbox.h || 1080));
    const here = lane.at(clamp(state.u, 0, 1));
    if (!Number.isFinite(here.x) || !Number.isFinite(here.y)) return;

    // Fade in and out at the ends of an open lane in "carry on" mode, where
    // the walk wraps: without it they vanish off one end and appear at the
    // other in the same frame.
    let alpha = 1;
    if (!lane.closed && p.patrol === 'carry on') {
      const edge = clamp(H / Math.max(1, lane.length), 0.01, 0.4);
      alpha = smoothstep(0, edge, state.u) * smoothstep(0, edge, 1 - state.u);
    }
    if (alpha <= 0.004) return;

    const pose = posture(p, state, t, beat);

    g.save();
    g.globalAlpha = alpha;
    g.translate(here.x, here.y);
    // Stand square to the ground rather than to the frame, so they lean into a
    // sloping gutter instead of hovering over it.
    g.rotate(clamp(here.angle, -1.2, 1.2));
    g.translate(0, -p.raise * H);
    g.scale(H, H);
    // Facing. Held off zero because a scale of exactly zero is a degenerate
    // transform, and half a frame of nothing at all reads as a dropped frame.
    const face = Math.abs(state.face) < 0.07 ? Math.sign(state.face || 1) * 0.07 : state.face;
    g.scale(face, 1);

    drawWanderer(g, p, pose, 1 / H);
    g.restore();
  },
};

/**
 * Every animated number for one frame, in one place.
 *
 * Split out from the drawing because the drawing is long, and because a pose
 * is the thing worth reading on its own: what the gait is doing, what the
 * errand is doing on top of it, and what the involuntary bits are doing on top
 * of that. All of it derived from `state` and `t` and nothing else, so `draw`
 * writes nothing — see the two-tabs rule in docs/writing-effects.md.
 */
function posture(p, state, t, beat) {
  const sit = clamp(state.sit, 0, 1);
  const moving = state.mode === 'walk' && sit < 0.02 && p.speed > 0;
  const phase = frac(state.stride);

  const idle = state.idle;
  // Every idle is one bump in and out, so nothing snaps on or off.
  const idleAmt = idle
    ? smoothstep(0, 0.22, state.idleT / Math.max(0.01, state.idleFor))
      * smoothstep(0, 0.22, 1 - state.idleT / Math.max(0.01, state.idleFor))
    : 0;

  /**
   * Where each foot actually is, in body heights.
   *
   * Three poses blended in one place rather than three branches: the gait,
   * a stance with the feet apart, and a sit with both feet forward of the
   * hips. Blending is what makes sitting down and getting up an *action* —
   * switching between them is a cut, and a cut in the middle of a body is the
   * one thing an audience always notices.
   */
  const scratch = { x: 0, lift: 0 };
  const feet = [];
  for (let k = 0; k < 2; k++) {
    footAt(phase + k * 0.5, scratch);
    const walkX = scratch.x * STRIDE;
    const walkY = -scratch.lift * 0.14;
    const standX = k ? -0.07 : 0.06;
    feet.push({
      x: lerp(moving ? walkX : standX, k ? 0.17 : 0.21, sit),
      y: lerp(moving ? walkY : 0, 0, sit),
    });
  }

  // The body rises over the planted foot twice a cycle and drops at each
  // contact. Small — a couple of percent of height — and its absence is what
  // makes a walk look like a slide.
  const bob = moving ? Math.cos(phase * TAU * 2) * 0.022 : 0;
  // The head arrives a little after the body, and the ears after the head:
  // the same bob, read a few percent of a cycle late, twice over. Lag is
  // what turns a rigid rig into a thing with mass in it.
  const bobLate = moving ? Math.cos((phase - 0.06) * TAU * 2) * 0.022 : 0;
  const flop = moving ? Math.sin((phase - 0.1) * TAU * 2) * 0.13 : 0;
  const breathe = Math.sin(t * (sit > 0.5 ? 0.75 : 1.15)) * (moving ? 0.004 : 0.012);

  /**
   * The eyelid, which is where most of the expression lives.
   *
   * At rest it sits a third of the way down — the relaxed, half-lidded look
   * of somebody listening to something — and lower still when they sit. A
   * blink closes over it fast and opens slowly, the way a real one does; a
   * blink that closes and opens at the same rate reads as a shutter.
   */
  const blinkT = clamp(state.blink, 0, 1);
  const closing = blinkT > 0.7 ? (1 - blinkT) / 0.3 : blinkT / 0.7;
  const rest = 0.24 + sit * 0.14 + (idle === 'stretch' ? -0.2 : 0) * idleAmt;
  const lid = idle === 'yawn' ? Math.max(closing, idleAmt) : Math.max(rest, closing);

  // The one thing they are actually here for.
  const groove = clamp(p.nod, 0, 1) * (0.5 + 0.5 * (1 - sit))
    * Math.sin(frac(beat * 0.5) * TAU) * 0.055;

  return {
    sit,
    moving,
    feet,
    // Sitting drops the hips most of the way to the ledge, which is what puts
    // the knees up by the chest without a single extra number.
    bodyY: bob + breathe + sit * 0.2,
    squash: moving ? -Math.cos(phase * TAU * 2) * 0.016 : 0,
    lean: (moving ? 0.05 : 0.012) + sit * 0.05 - (idle === 'stretch' ? idleAmt * 0.14 : 0),
    headBob: -bobLate * 0.6 + groove,
    flop,
    lid,
    headTurn: idle === 'look' ? -idleAmt : (moving ? 0.08 : 0) + groove * 0.5,
    // A little nose-down at rest. Somebody looking at the gutter in front
    // of them rather than at the horizon, which is what a slouch is.
    headTilt: 0.07 + (idle === 'headphones' ? -0.16 : 0) * idleAmt
      + (idle === 'stretch' ? -0.3 : 0) * idleAmt
      + groove * 1.6,
    // Hands: the arms swing against the legs unless they are busy.
    reach: idle === 'headphones' ? idleAmt : 0,
    pocket: idle === 'pockets' ? idleAmt : 0,
    stretch: idle === 'stretch' ? idleAmt : 0,
    mouth: idle === 'yawn' ? idleAmt : 0,
    flick: state.flick * state.flick,
    swing: moving ? Math.sin(phase * TAU) : Math.sin(t * 0.6) * 0.06,
    tail: state.tail,
  };
}

/* ------------------------------------------------------------------ *
 * The animal itself
 *
 * Drawn in body heights with the feet at the origin and y running up the
 * page as a negative — so every number below is a fraction of how tall they
 * are, and the whole rig scales to a shoebox on a sill or two metres of
 * gable without a single thing being re-tuned.
 *
 * The proportions are the cartoonist's, not the zoologist's: two and a half
 * heads tall, the legs a third of the height, the tail three quarters of it.
 * A correctly proportioned animal at this size on a wall is a smudge — the
 * head has to be big enough that an eye and a muzzle survive being forty
 * pixels of projector, and the tail has to be big enough to read as a
 * separate thing from the body when both are the same colour.
 *
 * Four things keep it out of the uncanny valley, and the first draft of this
 * rig had none of them. **One point of view**: the head is a profile, with
 * the snout in the outline, not a front-on circle with a muzzle pasted to
 * one side of it. **No perfect circles**: every silhouette is a hand-drawn
 * curve with a heavy side and a light side. **Volume from shading, not
 * outline**: each part is a top-lit gradient with an edge in its own darker
 * colour, rather than a flat fill in a uniform black line, which is what
 * makes clip-art look like clip-art. And **a relaxed face**: the eye rests
 * half-lidded, which is the single cheapest way to make a face look calm
 * rather than startled, and a blink closes fast and opens slow the way a
 * real one does.
 * ------------------------------------------------------------------ */

const HIP_Y = -0.30;
const HEM_Y = -0.24;
const SHOULDER_Y = -0.56;
const HEAD_Y = -0.78;
const HEAD_R = 0.2;
/** How far a foot travels either side of the hip, in body heights. */
const STRIDE = 0.11;
/**
 * How far the animal travels in one full gait cycle — and it is not a free
 * parameter.
 *
 * Each leg is planted for half the cycle, and over that half the foot travels
 * from `+STRIDE` to `-STRIDE` relative to the hip. For the planted foot to
 * stay put on the gutter, the body must cover exactly that `2 * STRIDE` in the
 * same half cycle. So the distance per cycle is `4 * STRIDE` and nothing else:
 * any other number and the feet skate, which is the single loudest tell that
 * something is being animated rather than moving. `test/lofi.test.mjs` holds
 * the simulation to it.
 */
const GAIT_CYCLE = 4 * STRIDE;
const TAIL_SEG = 0.078;

/** The edge of a part is that part's own colour, taken down — never plain ink. */
function edgeOf(colour, ink) {
  return mixLinear(colour, ink, 0.55);
}

/** A top-lit fill between two heights, in the current transform. */
function litFill(g, colour, ink, top, bottom, lift = 0.12, drop = 0.3) {
  const grad = g.createLinearGradient(0, top, 0, bottom);
  grad.addColorStop(0, mixLinear(colour, '#ffffff', lift));
  grad.addColorStop(0.55, colour);
  grad.addColorStop(1, mixLinear(colour, ink, drop));
  return grad;
}

function drawWanderer(g, p, a, unit) {
  const ink = p.ink;
  const line = p.line * unit;

  const dark = mixLinear(p.hoodie, ink, 0.45);

  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.lineWidth = line;

  // Squash on the contact and stretch through the swing, about the feet.
  // Two percent — invisible as a shape, unmistakable as weight.
  g.save();
  g.scale(1 + a.squash, 1 - a.squash);

  // Behind everything, and the first thing the eye finds.
  drawTail(g, a, p.hoodie, dark, line, ink);

  // The far side of them, in shadow. Drawn before the body so it is behind
  // it, which is the whole of why an animal drawn flat still has a near side
  // and a far side.
  drawLeg(g, a, 1, dark, ink, line * 0.7);
  drawArm(g, a, 1, dark, ink, line * 0.7);

  g.save();
  g.translate(0, a.bodyY);
  g.rotate(-a.lean);
  drawBody(g, a, p, ink, line);
  g.restore();

  drawLeg(g, a, 0, p.hoodie, ink, line);

  g.save();
  g.translate(0, a.bodyY + a.headBob);
  // The head turns about the neck, not about its own centre, or a look back
  // over the shoulder detaches it.
  g.translate(0, SHOULDER_Y);
  g.rotate(a.headTilt + a.headTurn * 0.5);
  g.translate(0, -SHOULDER_Y);
  drawHead(g, p, a, ink, line);
  g.restore();

  drawArm(g, a, 0, p.hoodie, ink, line);

  if (p.rimAmount > 0) drawRim(g, p, a, line);
  g.restore();
}

/**
 * The hoodie: a slouched torso, rounded at the back, with a pouch on it.
 *
 * Rounded at the *back* specifically. A symmetrical bell reads as a toy;
 * the curve of a spine under a hoodie is convex behind and nearly straight
 * in front, and that one asymmetry is most of what makes it a body.
 */
function drawBody(g, a, p, ink, line) {
  const hem = HEM_Y + a.sit * 0.05;
  const sh = SHOULDER_Y;
  const flare = 1 + a.sit * 0.18;
  const back = -0.22 * flare;
  const front = 0.19 * flare;

  g.beginPath();
  g.moveTo(-0.13, sh + 0.01);
  g.bezierCurveTo(-0.25, sh + 0.05, -0.27, hem - 0.1, back, hem);
  g.quadraticCurveTo(-0.02, hem + 0.045, front, hem);
  g.bezierCurveTo(0.21, hem - 0.1, 0.17, sh + 0.08, 0.12, sh + 0.01);
  g.quadraticCurveTo(0, sh - 0.025, -0.13, sh + 0.01);
  g.closePath();
  g.fillStyle = litFill(g, p.hoodie, ink, sh, hem);
  g.fill();
  if (line > 0) {
    g.strokeStyle = edgeOf(p.hoodie, ink);
    g.lineWidth = line;
    g.stroke();
  }

  // The pouch. Two things hang off it: the hands, when they go in, and the
  // fact that a flat orange shape has no scale to it until something crosses it.
  g.beginPath();
  g.moveTo(-0.15, hem - 0.095);
  g.quadraticCurveTo(0, hem - 0.055, 0.15, hem - 0.095);
  g.strokeStyle = mixLinear(p.hoodie, ink, 0.32);
  g.lineWidth = Math.max(line * 0.9, 0.01);
  g.stroke();

  // Drawstrings, which swing a beat behind the body.
  const swing = a.swing * 0.03;
  for (const side of [-0.04, 0.05]) {
    g.beginPath();
    g.moveTo(side, sh + 0.035);
    g.quadraticCurveTo(side + swing * 0.5, sh + 0.085, side + swing, sh + 0.125);
    g.strokeStyle = mixLinear(p.fur, ink, 0.12);
    g.lineWidth = Math.max(line * 0.6, 0.008);
    g.stroke();
  }
  g.lineWidth = line;
}

/**
 * One leg, from the hip to wherever the pose has put the foot.
 *
 * The knee is the midpoint pushed forward, which is not anatomy — it is the
 * cheapest thing that bends the right way at every point of the cycle and in
 * the fold of a sit, and at this size on a wall nothing else survives.
 */
function drawLeg(g, a, which, colour, ink, line) {
  const foot = a.feet[which];
  const hip = { x: which ? -0.035 : 0.035, y: HIP_Y + a.bodyY };
  const knee = {
    x: lerp(hip.x, foot.x, 0.5) + 0.035 + a.sit * 0.05,
    y: lerp(hip.y, foot.y, 0.52),
  };
  const edge = edgeOf(colour, ink);

  if (line > 0) {
    g.beginPath();
    g.moveTo(hip.x, hip.y);
    g.quadraticCurveTo(knee.x, knee.y, foot.x, foot.y - 0.03);
    g.strokeStyle = edge;
    g.lineWidth = 0.062 + line * 2;
    g.stroke();
  }
  g.beginPath();
  g.moveTo(hip.x, hip.y);
  g.quadraticCurveTo(knee.x, knee.y, foot.x, foot.y - 0.03);
  g.strokeStyle = colour;
  g.lineWidth = 0.062;
  g.stroke();

  // A paw: a rounded shape with the heel behind and the toes ahead, rather
  // than an ellipse, which has neither.
  g.beginPath();
  g.moveTo(foot.x - 0.035, foot.y - 0.005);
  g.quadraticCurveTo(foot.x - 0.04, foot.y - 0.048, foot.x + 0.005, foot.y - 0.045);
  g.quadraticCurveTo(foot.x + 0.075, foot.y - 0.042, foot.x + 0.07, foot.y - 0.005);
  g.closePath();
  g.fillStyle = mixLinear(colour, ink, 0.12);
  g.fill();
  if (line > 0) {
    g.strokeStyle = edge;
    g.lineWidth = line;
    g.stroke();
  }
}

/**
 * One arm, and what the hand has been asked to do with itself.
 *
 * Four destinations: swinging against the legs, tucked into the pouch, up at
 * the headphone cup, or stretched over the head. Blended rather than switched,
 * so a hand that comes out of a pocket to push a headphone back on travels
 * there instead of appearing there.
 */
function drawArm(g, a, which, colour, ink, line) {
  /**
   * The shoulder sits on the *edge* of the torso, not in the middle of it.
   *
   * An arm the same colour as the hoodie, drawn down the middle of the
   * hoodie, is not an arm — it is nothing at all, which is exactly what the
   * first version of this drew. Hanging it off the silhouette and edging it
   * is what makes it a limb.
   */
  const side = which ? -1 : 1;
  const sh = { x: side * 0.13, y: SHOULDER_Y + a.bodyY + 0.06 };
  const swing = which ? -a.swing : a.swing;

  const free = { x: sh.x + side * 0.03 + swing * 0.075, y: HEM_Y + a.bodyY - 0.01 };
  const pouch = { x: side * 0.07, y: HEM_Y + a.bodyY - 0.08 };
  const cup = { x: -0.04, y: HEAD_Y + a.bodyY - 0.01 };
  const over = { x: -0.04 + side * 0.02, y: sh.y - 0.37 };

  let hx = lerp(free.x, pouch.x, a.pocket);
  let hy = lerp(free.y, pouch.y, a.pocket);
  // Only the near arm reaches for the cup; the far one stays where it was,
  // which is what an arm on the other side of a body does.
  const reach = which ? 0 : a.reach;
  hx = lerp(hx, cup.x, reach);
  hy = lerp(hy, cup.y, reach);
  hx = lerp(hx, over.x, a.stretch);
  hy = lerp(hy, over.y, a.stretch);

  const elbow = {
    x: lerp(sh.x, hx, 0.5) + side * (0.045 + reach * 0.05),
    y: lerp(sh.y, hy, 0.55),
  };
  const edge = edgeOf(colour, ink);

  if (line > 0) {
    g.beginPath();
    g.moveTo(sh.x, sh.y);
    g.quadraticCurveTo(elbow.x, elbow.y, hx, hy);
    g.strokeStyle = edge;
    g.lineWidth = 0.058 + line * 2;
    g.stroke();
  }
  g.beginPath();
  g.moveTo(sh.x, sh.y);
  g.quadraticCurveTo(elbow.x, elbow.y, hx, hy);
  g.strokeStyle = colour;
  g.lineWidth = 0.058;
  g.stroke();

  // A cuff where the sleeve ends, then the paw out of it. The cuff is a
  // single short dark stroke and it is what turns a tube into a sleeve.
  const cx = lerp(elbow.x, hx, 0.8);
  const cy = lerp(elbow.y, hy, 0.8);
  g.beginPath();
  g.moveTo(cx, cy);
  g.lineTo(lerp(cx, hx, 0.5), lerp(cy, hy, 0.5));
  g.strokeStyle = mixLinear(colour, ink, 0.3);
  g.lineWidth = 0.062;
  g.stroke();

  g.beginPath();
  g.arc(hx, hy, 0.037, 0, TAU);
  g.fillStyle = mixLinear(colour, ink, 0.1);
  g.fill();
  if (line > 0) {
    g.strokeStyle = edge;
    g.lineWidth = line;
    g.stroke();
  }
}

/**
 * The ringed tail, drawn as one tapering stroke per spring segment.
 *
 * Alternating the colour segment by segment is the whole of the ringing, and
 * it costs nothing: the rings are the joints, so they bend where a real one
 * would rather than sliding along a painted shape.
 */
function tailPoints(a, xs, ys) {
  let x = -0.1;
  let y = HIP_Y + a.bodyY - 0.02;
  xs[0] = x;
  ys[0] = y;
  for (let i = 0; i < a.tail.length; i++) {
    x += Math.cos(a.tail[i].a) * TAIL_SEG;
    y -= Math.sin(a.tail[i].a) * TAIL_SEG;
    xs[i + 1] = x;
    ys[i + 1] = y;
  }
  return a.tail.length + 1;
}

function drawTail(g, a, light, dark, line, ink) {
  const xs = [];
  const ys = [];
  const n = tailPoints(a, xs, ys);

  // Edge first, as one fat stroke under the lot, so the rings do not each
  // get an outline of their own and read as a caterpillar.
  if (line > 0) {
    g.beginPath();
    curveThrough(g, xs, ys, n, { move: true });
    g.strokeStyle = edgeOf(dark, ink);
    g.lineWidth = 0.185 + line * 2;
    g.stroke();
  }

  for (let i = 0; i < n - 1; i++) {
    const w = lerp(0.18, 0.07, i / Math.max(1, n - 2));
    g.beginPath();
    g.moveTo(xs[i], ys[i]);
    g.lineTo(xs[i + 1], ys[i + 1]);
    g.strokeStyle = i % 2 ? dark : light;
    g.lineWidth = w;
    g.stroke();
  }

  // A pale tip, which every ringed tail has and which is the bit the eye
  // follows when it whips round on a turn.
  g.beginPath();
  g.arc(xs[n - 1], ys[n - 1], 0.042, 0, TAU);
  g.fillStyle = mixLinear(light, '#ffffff', 0.4);
  g.fill();
}

/**
 * The head, in profile.
 *
 * One closed curve with the snout in it — back of the skull, crown, brow,
 * down the nose, round under the chin. Everything else on the face is laid
 * *inside* that outline: the pale muzzle and cheek, the tear stripe, a
 * half-lidded eye. Nothing is pasted on the outside of a circle, which is
 * what a face has to avoid to be looked at for more than a second.
 */
function headPath(g, cx, cy) {
  g.moveTo(cx - 0.12, cy + 0.17);
  g.bezierCurveTo(cx - 0.25, cy + 0.11, cx - 0.25, cy - 0.19, cx - 0.06, cy - 0.215);
  g.bezierCurveTo(cx + 0.03, cy - 0.235, cx + 0.1, cy - 0.2, cx + 0.14, cy - 0.15);
  g.bezierCurveTo(cx + 0.21, cy - 0.1, cx + 0.28, cy - 0.01, cx + 0.265, cy + 0.045);
  g.bezierCurveTo(cx + 0.26, cy + 0.12, cx + 0.2, cy + 0.165, cx + 0.1, cy + 0.175);
  g.quadraticCurveTo(cx, cy + 0.19, cx - 0.12, cy + 0.17);
  g.closePath();
}

function drawHead(g, p, a, ink, line) {
  const cx = 0.03;
  const cy = HEAD_Y;
  const hood = p.hood;
  const fur = p.fur;
  const furEdge = edgeOf(fur, ink);
  const pale = mixLinear(fur, '#ffffff', 0.5);
  const shade = mixLinear(fur, ink, 0.4);

  /* -- the far ear ---------------------------------------------------- */
  drawEar(g, cx - 0.14, cy - 0.16, 0.068, -0.55 - a.flick * 0.3 - a.flop,
    mixLinear(fur, ink, 0.45), ink, line * 0.7);

  /* -- the hood, as a bigger head behind the head ---------------------- */
  if (hood) {
    // The collar first: a skirt from the back of the head down onto the
    // shoulders, so the head cannot detach on a frame where the neck turn
    // and the body bob pull in opposite directions.
    g.beginPath();
    g.moveTo(cx - 0.22, cy + 0.06);
    g.quadraticCurveTo(cx - 0.21, SHOULDER_Y - 0.01, cx - 0.1, SHOULDER_Y + 0.02);
    g.lineTo(cx + 0.11, SHOULDER_Y + 0.02);
    g.quadraticCurveTo(cx + 0.17, cy + 0.16, cx + 0.14, cy + 0.06);
    g.closePath();
    g.fillStyle = mixLinear(p.hoodie, ink, 0.3);
    g.fill();

    g.save();
    g.translate(cx - 0.035, cy + 0.005);
    g.scale(1.22, 1.2);
    g.translate(-cx, -cy);
    g.beginPath();
    headPath(g, cx, cy);
    g.restore();
    g.fillStyle = litFill(g, mixLinear(p.hoodie, ink, 0.08), ink, cy - 0.27, cy + 0.2, 0.1, 0.35);
    g.fill();
    if (line > 0) {
      g.strokeStyle = edgeOf(p.hoodie, ink);
      g.lineWidth = line;
      g.stroke();
    }
  }

  /* -- the face ---------------------------------------------------------- */
  g.beginPath();
  headPath(g, cx, cy);
  g.fillStyle = litFill(g, fur, ink, cy - 0.22, cy + 0.18, 0.1, 0.22);
  g.fill();

  // Markings, clipped to the head: a pale muzzle running back into a pale
  // cheek, and the tear stripe from the eye down through it. These are the
  // three marks that say which animal this is, and they are values on the
  // face rather than shapes stuck to it.
  g.save();
  g.clip();
  g.fillStyle = pale;
  g.beginPath();
  g.ellipse(cx + 0.19, cy + 0.075, 0.12, 0.085, -0.15, 0, TAU);
  g.fill();
  g.beginPath();
  g.ellipse(cx + 0.04, cy + 0.09, 0.09, 0.07, 0.2, 0, TAU);
  g.fill();
  g.globalAlpha *= 0.45;
  g.fillStyle = shade;
  g.beginPath();
  g.ellipse(cx + 0.12, cy + 0.03, 0.028, 0.06, 0.35, 0, TAU);
  g.fill();
  g.restore();

  if (line > 0) {
    g.beginPath();
    headPath(g, cx, cy);
    g.strokeStyle = furEdge;
    g.lineWidth = line;
    g.stroke();
  }

  /* -- the eye ------------------------------------------------------------ */
  const ex = cx + 0.145;
  const ey = cy - 0.045;
  const lid = clamp(a.lid, 0, 1);
  // The eye itself: an almond, heavier below than above.
  g.beginPath();
  g.moveTo(ex - 0.042, ey + 0.002);
  g.quadraticCurveTo(ex, ey - 0.05, ex + 0.04, ey);
  g.quadraticCurveTo(ex, ey + 0.04, ex - 0.042, ey + 0.002);
  g.closePath();
  g.fillStyle = ink;
  g.fill();
  if (lid < 0.85) {
    g.beginPath();
    g.arc(ex + 0.013, ey - 0.006 + lid * 0.02, 0.012, 0, TAU);
    g.fillStyle = '#ffffff';
    g.save();
    g.globalAlpha *= 0.85;
    g.fill();
    g.restore();
  }
  // The lid comes down over it in the face colour, and its edge is a line.
  // At rest it sits a third of the way down, which is the whole of the
  // difference between a face that is calm and a face that is alarmed.
  const lidY = ey - 0.048 + lid * 0.088;
  g.save();
  g.beginPath();
  g.moveTo(ex - 0.05, ey - 0.05);
  g.lineTo(ex + 0.05, ey - 0.05);
  g.lineTo(ex + 0.05, lidY + 0.004);
  g.quadraticCurveTo(ex, lidY - 0.012 * (1 - lid), ex - 0.05, lidY + 0.004);
  g.closePath();
  g.fillStyle = fur;
  g.fill();
  g.restore();
  g.beginPath();
  g.moveTo(ex - 0.046, lidY + 0.004);
  g.quadraticCurveTo(ex, lidY - 0.012 * (1 - lid), ex + 0.046, lidY + 0.004);
  g.strokeStyle = furEdge;
  g.lineWidth = Math.max(line * 0.9, 0.011);
  g.stroke();

  /* -- nose and mouth ------------------------------------------------------ */
  g.beginPath();
  g.ellipse(cx + 0.252, cy + 0.03, 0.024, 0.018, 0.2, 0, TAU);
  g.fillStyle = ink;
  g.fill();

  if (a.mouth > 0.02) {
    g.beginPath();
    g.ellipse(cx + 0.19, cy + 0.11, 0.035, 0.045 * a.mouth, -0.1, 0, TAU);
    g.fillStyle = mixLinear(ink, '#7a2436', 0.55);
    g.fill();
  } else {
    g.beginPath();
    g.moveTo(cx + 0.24, cy + 0.065);
    g.quadraticCurveTo(cx + 0.21, cy + 0.085, cx + 0.18, cy + 0.075);
    g.strokeStyle = shade;
    g.lineWidth = Math.max(line * 0.6, 0.008);
    g.stroke();
  }

  /* -- the near ear, on the crown ------------------------------------------ */
  drawEar(g, cx + 0.01, cy - 0.2, 0.068, 0.12 + a.flick * 0.55 + a.flop, fur, ink, line);

  /* -- headphones ----------------------------------------------------------- */
  if (p.headphones) {
    const push = a.reach * 0.012;
    const metal = mixLinear(ink, '#ffffff', 0.3);
    g.beginPath();
    g.arc(cx - 0.04, cy + push, HEAD_R * (hood ? 1.32 : 1.1), Math.PI * 1.15, Math.PI * 1.92);
    g.strokeStyle = metal;
    g.lineWidth = 0.032;
    g.stroke();

    // Over the ear — behind and a little below the eye. Any further forward
    // and it reads as a second, larger eye.
    const kx = cx - 0.075;
    const ky = cy - 0.045 + push;
    g.beginPath();
    g.ellipse(kx, ky, 0.052, 0.068, 0.05, 0, TAU);
    g.fillStyle = litFill(g, mixLinear(ink, '#ffffff', 0.2), ink, ky - 0.07, ky + 0.07, 0.15, 0.3);
    g.fill();
    if (line > 0) {
      g.strokeStyle = mixLinear(ink, '#ffffff', 0.08);
      g.lineWidth = line;
      g.stroke();
    }
    g.beginPath();
    g.ellipse(kx + 0.006, ky, 0.028, 0.04, 0.05, 0, TAU);
    g.fillStyle = mixLinear(ink, '#ffffff', 0.38);
    g.fill();
  }
}

/** One ear: a rounded lobe, the pale rim a red panda has, and a darker inside. */
function drawEar(g, x, y, r, tilt, colour, ink, line) {
  g.save();
  g.translate(x, y);
  g.rotate(tilt);
  g.beginPath();
  g.moveTo(-r, r * 0.8);
  g.bezierCurveTo(-r * 1.1, -r * 0.6, -r * 0.45, -r * 1.15, 0, -r * 1.1);
  g.bezierCurveTo(r * 0.5, -r * 1.05, r * 1.05, -r * 0.5, r * 0.95, r * 0.8);
  g.quadraticCurveTo(0, r * 0.45, -r, r * 0.8);
  g.closePath();
  g.fillStyle = mixLinear(colour, '#ffffff', 0.25);
  g.fill();
  if (line > 0) {
    g.strokeStyle = edgeOf(colour, ink);
    g.lineWidth = line;
    g.stroke();
  }
  g.beginPath();
  g.moveTo(-r * 0.5, r * 0.5);
  g.bezierCurveTo(-r * 0.55, -r * 0.35, -r * 0.2, -r * 0.6, 0, -r * 0.55);
  g.bezierCurveTo(r * 0.25, -r * 0.5, r * 0.55, -r * 0.3, r * 0.5, r * 0.5);
  g.quadraticCurveTo(0, r * 0.25, -r * 0.5, r * 0.5);
  g.closePath();
  g.fillStyle = mixLinear(colour, '#40161f', 0.55);
  g.fill();
  g.restore();
}

/**
 * The sunset behind them.
 *
 * A projector adds light and cannot subtract any, so a silhouette on a wall
 * has to be made of light or it is not there at all. This is one stroke along
 * the trailing edge — crown, back, hem, tail — and it is what stops the
 * whole thing reading as a sticker.
 */
function drawRim(g, p, a, line) {
  const amount = clamp(p.rimAmount, 0, 1);
  const width = Math.max(line, 0.018);
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = rgba(p.rim, 0.42 * amount);
  g.lineWidth = width;
  g.lineCap = 'round';

  // Down the back of the hoodie.
  const hem = HEM_Y + a.bodyY;
  const sh = SHOULDER_Y + a.bodyY;
  g.beginPath();
  g.moveTo(-0.13, sh + 0.01);
  g.bezierCurveTo(-0.25, sh + 0.05, -0.27, hem - 0.1, -0.22, hem);
  g.stroke();

  // Over the back of the head, hood or not.
  const cx = 0.03;
  const cy = HEAD_Y + a.bodyY + a.headBob;
  const k = p.hood ? 1.21 : 1;
  g.beginPath();
  g.moveTo(cx - 0.12 * k, cy + 0.17 * k);
  g.bezierCurveTo(cx - 0.25 * k, cy + 0.11 * k, cx - 0.25 * k, cy - 0.19 * k, cx - 0.06 * k, cy - 0.215 * k);
  g.bezierCurveTo(cx + 0.03 * k, cy - 0.235 * k, cx + 0.1 * k, cy - 0.2 * k, cx + 0.14 * k, cy - 0.15 * k);
  g.strokeStyle = rgba(p.rim, 0.3 * amount);
  g.stroke();

  const xs = [];
  const ys = [];
  const n = tailPoints(a, xs, ys);
  g.beginPath();
  curveThrough(g, xs, ys, n, { move: true });
  g.strokeStyle = rgba(p.rim, 0.24 * amount);
  g.stroke();
  g.restore();
}

/* ------------------------------------------------------------------ *
 * Lofi Vista
 * ------------------------------------------------------------------ */

/**
 * The world behind them, in bands that move at different rates.
 *
 * Parallax is the whole effect and it is not decoration: two silhouettes
 * sliding past each other at different speeds is the only cue a flat picture
 * has for depth, and the eye reads it instantly and involuntarily. Three bands
 * is enough; four is better and costs almost nothing, since a band is a few
 * hundred `lineTo`s.
 *
 * The colours are not chosen per band. Each is the band's own colour mixed
 * towards the *sky at its own height*, by how far away it is — which is
 * aerial perspective, and is the reason distant hills are the colour of the
 * sky rather than a paler green. Mixed in linear light, because mixing two
 * gamma-encoded colours travels through a muddy middle and the far band is
 * mostly middle.
 */
const vista = {
  id: 'vista',
  name: 'Lofi Vista',
  category: 'atmosphere',
  scope: 'shape',
  description:
    'A dusk city in parallax: a sunset gradient, three bands of rooftops drifting at three speeds with windows coming on, a branch across the near corner and birds going over. The world for Wanderer to walk through.',
  params: [
    { key: 'sky', type: 'color', label: 'Sky', default: '#2b2757' },
    { key: 'horizon', type: 'color', label: 'Horizon', default: '#f0916b' },
    { key: 'sun', type: 'color', label: 'Sun', default: '#ffd7a1' },
    { key: 'city', type: 'color', label: 'City', default: '#3b2547' },
    { key: 'lit', type: 'color', label: 'Lit windows', default: '#ffc978' },
    { key: 'skyline', type: 'range', label: 'Horizon height', default: 0.62, min: 0.1, max: 0.95, step: 0.01 },
    { key: 'sunHeight', type: 'range', label: 'Sun height', default: 0.58, min: 0, max: 1, step: 0.01 },
    { key: 'bands', type: 'range', label: 'Bands of depth', default: 3, min: 1, max: 4, step: 1 },
    { key: 'density', type: 'range', label: 'Buildings', default: 1, min: 0.2, max: 3, step: 0.05 },
    { key: 'haze', type: 'range', label: 'Distance haze', default: 0.62, min: 0, max: 1, step: 0.01 },
    { key: 'pan', type: 'range', label: 'Drift (px/s)', default: 5, min: 0, max: 60, step: 0.5 },
    { key: 'lights', type: 'range', label: 'Windows lit', default: 0.45, min: 0, max: 1, step: 0.01 },
    { key: 'clouds', type: 'range', label: 'Cloud', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'birds', type: 'range', label: 'Birds', default: 0.35, min: 0, max: 1, step: 0.01 },
    { key: 'branch', type: 'bool', label: 'Branch in the corner', default: true },
    { key: 'sway', type: 'range', label: 'Sway', default: 1, min: 0, max: 3, step: 0.05 },
    { key: 'seed', type: 'range', label: 'Shuffle the city', default: 7, min: 0, max: 999, step: 1 },
    { key: 'level', type: 'range', label: 'Brightness', default: 1, min: 0, max: 1, step: 0.01 },
  ],

  init() {
    return { key: '', bands: null };
  },

  draw({ g, p, shape, t, state, noise }) {
    const { bbox } = shape;
    if (!(bbox.w > 0.5) || !(bbox.h > 0.5) || p.level <= 0) return;

    const horizon = bbox.y + bbox.h * clamp(p.skyline, 0, 1);
    const bands = ensureCity(state, p, bbox);

    g.save();
    g.globalAlpha *= clamp(p.level, 0, 1);
    g.clip(shape.path);

    drawSky(g, p, bbox, horizon);
    drawSun(g, p, bbox, horizon);
    if (p.clouds > 0) drawClouds(g, p, bbox, horizon, t, noise);

    /**
     * Back to front, and slowest to fastest.
     *
     * The rate ratio is what carries the depth — a band twice as near moving
     * twice as fast — so the speeds are derived from the band index rather
     * than being four numbers somebody would have to keep in proportion.
     */
    for (let b = 0; b < bands.length; b++) {
      const near = (b + 1) / bands.length;
      drawBand(g, p, bands[b], bbox, horizon, t, near, b === bands.length - 1);
    }

    if (p.birds > 0) drawBirds(g, p, bbox, horizon, t);
    if (p.branch) drawBranch(g, p, bbox, t, noise);

    g.restore();
  },
};

/**
 * The city, cast once and kept.
 *
 * Keyed on `stable` — the parameters *before* modulation — because any of them
 * can be bound to an LFO, and a key built from the modulated value misses on
 * every frame the moment somebody does. See docs/writing-effects.md.
 */
function ensureCity(state, stable, bbox) {
  const count = Math.max(1, Math.round(clamp(stable.bands, 1, 4)));
  const key = `${stable.seed}:${count}:${stable.density}:${Math.round(bbox.w)}:${Math.round(bbox.h)}`;
  if (state.key === key && state.bands) return state.bands;

  state.key = key;
  state.bands = [];
  for (let b = 0; b < count; b++) {
    const rng = makeRng(`vista:${stable.seed}:${b}`);
    const near = (b + 1) / count;
    // Nearer bands are taller and sparser, which is what perspective does to a
    // city of roughly similar buildings.
    const width = lerp(0.035, 0.1, near) / Math.max(0.2, stable.density);
    const n = Math.max(2, Math.min(220, Math.ceil(1.6 / width)));
    const blocks = [];
    /**
     * Laid from zero, so `span` is exactly the period.
     *
     * The band is drawn twice, one span apart, and anything else leaves a
     * sliver of sky between the copies that slides across the wall once every
     * loop — which is far more visible than a seam has any right to be.
     */
    let x = 0;
    for (let i = 0; i < n; i++) {
      const w = width * (0.55 + rng() * 0.9);
      const h = lerp(0.05, 0.34, near) * (0.35 + rng() * 1.3);
      const roof = rng();
      blocks.push({
        x, w, h,
        // A water tower on one roof in fifteen, and an aerial on one in six.
        tower: roof > 0.94,
        aerial: roof > 0.72 && roof <= 0.94,
        // Windows are laid out once and only their brightness changes, so a lit
        // window stays in the same place on the same building for ever.
        cols: Math.max(1, Math.round(w / 0.016)),
        rows: Math.max(1, Math.round(h / 0.028)),
        phase: rng(),
      });
      x += w + width * 0.12 * rng();
    }
    state.bands.push({ blocks, span: x, near });
  }
  return state.bands;
}

function drawSky(g, p, bbox, horizon) {
  const grad = g.createLinearGradient(0, bbox.y, 0, horizon);
  grad.addColorStop(0, p.sky);
  grad.addColorStop(0.55, mixLinear(p.sky, p.horizon, 0.35));
  grad.addColorStop(1, p.horizon);
  g.fillStyle = grad;
  g.fillRect(bbox.x, bbox.y, bbox.w, Math.max(0, horizon - bbox.y));

  // Below the horizon the ground is the horizon colour taken well down, which
  // is what the far side of a city does at dusk: it is lighter than the ground
  // but it is not sky.
  if (horizon < bbox.y + bbox.h) {
    g.fillStyle = mixLinear(p.horizon, p.city, 0.75);
    g.fillRect(bbox.x, horizon, bbox.w, bbox.y + bbox.h - horizon);
  }
}

function drawSun(g, p, bbox, horizon) {
  const r = Math.min(bbox.w, bbox.h) * 0.11;
  const x = bbox.x + bbox.w * 0.68;
  const y = lerp(horizon + r * 0.4, bbox.y + bbox.h * 0.12, clamp(p.sunHeight, 0, 1));
  g.save();
  g.globalCompositeOperation = 'lighter';
  glow(g, x, y, r * 5.5, p.sun, 0.38);
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
  g.fillStyle = rgba(p.sun, 0.7);
  g.fill();
  g.restore();
}

/**
 * Cloud, as three bands of soft lozenges rather than a noise field.
 *
 * A field would be more correct and is what `fx.createField` is for; at dusk,
 * on a wall, at this size, it is indistinguishable from six ellipses and costs
 * a great deal more. The gradient does all the work.
 */
function drawClouds(g, p, bbox, horizon, t, noise) {
  const amount = clamp(p.clouds, 0, 1);
  const top = bbox.y;
  const span = Math.max(1, horizon - top);
  g.save();
  for (let i = 0; i < 7; i++) {
    const lane = (i % 3) / 3;
    const y = top + span * (0.12 + lane * 0.42);
    const drift = frac((t * (0.0035 + lane * 0.004) + i * 0.37));
    const x = bbox.x + drift * (bbox.w + bbox.w * 0.6) - bbox.w * 0.3;
    const w = bbox.w * (0.16 + (i % 4) * 0.06);
    const h = span * 0.055 * (1 + (i % 3) * 0.35);
    const puff = noise.noise2(i * 3.1, t * 0.05) * 0.3 + 0.7;
    const grad = g.createRadialGradient(x, y, 0, x, y, Math.max(1, w));
    const tint = mixLinear(p.horizon, p.sky, lane * 0.6);
    grad.addColorStop(0, rgba(tint, 0.5 * amount * puff));
    grad.addColorStop(1, rgba(tint, 0));
    g.fillStyle = grad;
    g.beginPath();
    g.ellipse(x, y, w, Math.max(0.5, h), 0, 0, TAU);
    g.fill();
  }
  g.restore();
}

/**
 * One band of rooftops, drawn twice so it wraps without a seam.
 *
 * The blocks cover rather more than the shape is wide, and the second copy is
 * one span along — so whichever part of the loop is on screen, the join is off
 * it. Cheaper than tiling into a canvas and it survives the shape changing
 * size, which a baked tile does not.
 */
function drawBand(g, p, band, bbox, horizon, t, near, isNearest) {
  const haze = clamp(p.haze, 0, 1) * (1 - near);
  const colour = mixLinear(p.city, p.horizon, haze * 0.85);
  const base = horizon + bbox.h * 0.02 * near;
  const span = band.span * bbox.w;
  if (!(span > 1)) return;

  const shift = -((t * p.pan * (0.25 + near)) % span);

  /**
   * The ground in front of the nearest band, with a little fall-off.
   *
   * Below the last skyline there is nothing left to draw and the shape is
   * often most of a wall, so a flat fill there is a large dead rectangle in
   * the middle of the picture. One gradient, and it reads as ground going away
   * under the city instead.
   */
  if (isNearest && bbox.y + bbox.h > base + 1) {
    const grad = g.createLinearGradient(0, base, 0, bbox.y + bbox.h);
    grad.addColorStop(0, colour);
    grad.addColorStop(1, mixLinear(colour, '#000000', 0.45));
    g.fillStyle = grad;
    g.fillRect(bbox.x, base, bbox.w, bbox.y + bbox.h - base);
  }

  g.fillStyle = colour;
  for (let copy = 0; copy < 2; copy++) {
    const ox = bbox.x + shift + copy * span;
    if (ox > bbox.x + bbox.w) continue;
    if (ox + span < bbox.x) continue;

    g.beginPath();
    /**
     * The ground the band stands on, filled solid.
     *
     * Each block used to be extended downwards on its own, which left the gaps
     * between them open all the way to the bottom of the shape — a picket
     * fence of sky below the horizon. A band is a *silhouette*: everything
     * behind its skyline is behind it, gaps included.
     */
    g.rect(bbox.x, base, bbox.w, Math.max(0, bbox.y + bbox.h - base));
    for (const block of band.blocks) {
      const x = ox + block.x * bbox.w;
      const w = block.w * bbox.w;
      if (x + w < bbox.x || x > bbox.x + bbox.w) continue;
      const h = block.h * bbox.h;
      g.rect(x, base - h, w, h);

      if (block.tower) {
        g.rect(x + w * 0.25, base - h - bbox.h * 0.035, w * 0.5, bbox.h * 0.035);
      }
      if (block.aerial) {
        const ax = x + w * 0.7;
        g.rect(ax, base - h - bbox.h * 0.03, Math.max(0.5, bbox.w * 0.0015), bbox.h * 0.03);
      }
    }
    g.fill();

    if (p.lights > 0 && near > 0.4) drawWindows(g, p, band, bbox, base, ox, t, near);
  }
}

/**
 * Windows coming on.
 *
 * Which ones are lit is fixed for the life of the layer — a window that
 * flickers on and off is a fault, not a city — and the only thing that moves
 * is a slow, per-window brightness wander, so a few of them are visibly
 * brighter than the rest at any moment. Anything faster reads as twinkling,
 * and twinkling reads as stars.
 */
function drawWindows(g, p, band, bbox, base, ox, t, near) {
  const cell = bbox.h * 0.026;
  if (!(cell > 0.6)) return;
  const fraction = clamp(p.lights, 0, 1);
  g.save();
  g.globalCompositeOperation = 'lighter';

  for (const block of band.blocks) {
    const x = ox + block.x * bbox.w;
    const w = block.w * bbox.w;
    if (x + w < bbox.x || x > bbox.x + bbox.w) continue;
    const h = block.h * bbox.h;
    const cols = Math.min(8, block.cols);
    const rows = Math.min(14, block.rows);
    const gapX = w / (cols + 1);
    const gapY = h / (rows + 1);
    if (!(gapX > 0.4) || !(gapY > 0.4)) continue;
    const size = Math.min(gapX * 0.45, gapY * 0.4);
    if (!(size > 0.3)) continue;

    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        // A stable hash of the cell, not a generator: the same window is the
        // same window in every tab and on every frame.
        const k = frac(Math.sin((block.phase + c * 12.9898 + r * 78.233) * 43758.5453));
        if (k > fraction) continue;
        const wander = 0.6 + 0.4 * Math.sin(t * 0.11 + k * TAU * 3);
        g.fillStyle = rgba(p.lit, 0.55 * wander * near);
        g.fillRect(x + gapX * (c + 1) - size / 2, base - h + gapY * (r + 1) - size / 2, size, size);
      }
    }
  }
  g.restore();
}

/**
 * A skein of birds, every so often.
 *
 * On a timetable rather than continuously, for the reason given at the top of
 * creatures.js: something always happening is wallpaper, and something that
 * happens every ninety seconds is the thing somebody points at.
 */
function drawBirds(g, p, bbox, horizon, t) {
  const period = lerp(240, 40, clamp(p.birds, 0, 1));
  const cycle = t / period;
  const index = Math.floor(cycle);
  const u = frac(cycle);
  const cross = 0.22;
  if (u > cross) return;

  const rng = makeRng(`vista-birds:${index}`);
  const count = 3 + Math.floor(rng() * 5);
  const lane = 0.18 + rng() * 0.45;
  const dir = rng() < 0.5 ? 1 : -1;
  const y0 = lerp(bbox.y, horizon, lane);
  const size = Math.max(1, bbox.w * 0.008);
  const progress = u / cross;

  g.save();
  g.strokeStyle = rgba(mixLinear(p.city, '#000000', 0.4), 0.75);
  g.lineWidth = Math.max(0.8, size * 0.22);
  g.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    const lead = i * 0.035;
    const q = progress - lead;
    if (q < -0.1 || q > 1.1) continue;
    const x = dir > 0
      ? bbox.x - bbox.w * 0.1 + q * bbox.w * 1.2
      : bbox.x + bbox.w * 1.1 - q * bbox.w * 1.2;
    const y = y0 + Math.sin(q * 6 + i) * bbox.h * 0.02 + i * size * 0.9;
    const flap = Math.sin(t * 7 + i * 1.7) * 0.5 + 0.5;
    g.beginPath();
    g.moveTo(x - size, y + size * 0.5 * flap);
    g.quadraticCurveTo(x - size * 0.3, y - size * 0.35, x, y);
    g.quadraticCurveTo(x + size * 0.3, y - size * 0.35, x + size, y + size * 0.5 * flap);
    g.stroke();
  }
  g.restore();
}

/**
 * The branch across the near corner.
 *
 * Pure framing, and it does two jobs: it is the nearest thing in the picture,
 * so it settles the parallax the bands only imply, and it breaks the top edge
 * of the shape — which on a window stops the whole thing reading as a
 * rectangle with a picture in it.
 */
function drawBranch(g, p, bbox, t, noise) {
  const ink = mixLinear(p.city, '#000000', 0.55);
  const sway = clamp(p.sway, 0, 3);
  const s = Math.min(bbox.w, bbox.h);
  const x0 = bbox.x - s * 0.05;
  const y0 = bbox.y + bbox.h * 0.06;

  g.save();
  g.strokeStyle = ink;
  g.lineCap = 'round';
  g.lineWidth = Math.max(1, s * 0.016);
  g.beginPath();
  g.moveTo(x0, y0);
  g.bezierCurveTo(
    x0 + bbox.w * 0.2, y0 + bbox.h * 0.06,
    x0 + bbox.w * 0.34, y0 - bbox.h * 0.02,
    x0 + bbox.w * 0.52, y0 + bbox.h * 0.05
  );
  g.stroke();

  // Twigs and leaves, hung off the limb at fixed fractions along it so they
  // stay put, and swung by a noise field so no two move together.
  for (let i = 0; i < 9; i++) {
    const u = 0.15 + (i / 9) * 0.8;
    const bx = x0 + bbox.w * 0.52 * u;
    const by = y0 + bbox.h * (0.05 * u + 0.02 * Math.sin(u * 4));
    const wobble = noise.noise2(i * 2.3, t * 0.35) * sway;
    const len = s * (0.05 + (i % 3) * 0.02);
    const ang = 1.2 + wobble * 0.28 + (i % 2 ? 0.3 : -0.2);
    const tx = bx + Math.cos(ang) * len;
    const ty = by + Math.sin(ang) * len;

    g.lineWidth = Math.max(0.6, s * 0.005);
    g.beginPath();
    g.moveTo(bx, by);
    g.lineTo(tx, ty);
    g.stroke();

    g.beginPath();
    g.ellipse(tx, ty, len * 0.42, len * 0.2, ang + 0.4 + wobble * 0.1, 0, TAU);
    g.fillStyle = ink;
    g.fill();
  }
  g.restore();
}

/**
 * The gait, for the test that holds it to no slip. Not part of the effect
 * contract — the registry only ever looks at the default export.
 */
export const gait = { footAt, STRIDE, GAIT_CYCLE };

export default [wanderer, vista];
