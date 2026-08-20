/**
 * Flowers: one bunch of them, and two walls of them.
 *
 * Three effects that share a workshop rather than a purpose. **Flowers** is a
 * bunch growing out of the bottom of whatever you trace — put the shape over a
 * real window box or a wall-mounted pot and the plant appears to be growing in
 * it. **Ditsy Flowers** and **Paisley** are prints: a motif repeated over a
 * whole wall, cut around the windows the way wallpaper is cut around a reveal.
 *
 * They live together because they are all built from the same two pieces — a
 * petal, and a lattice — and because the interesting problem in each is the
 * same one: a print is thousands of small objects and a projector frame is
 * sixteen milliseconds.
 *
 * The answer is not brickwork's. A wall of brick is baked once into a bitmap
 * because it never moves; these do move, which is most of what makes them worth
 * projecting — a still print on a house reads as a photograph of a house with
 * wallpaper on it. So the motif is baked instead of the wall: each distinct
 * flower or teardrop is drawn once into a small canvas, and a frame is a few
 * hundred `drawImage` calls with a transform each. Cost scales with the number
 * of motifs on the wall rather than with their complexity, so a paisley with
 * forty hand-placed seeds in it costs exactly what a plain disc would.
 *
 * The second decision worth stating is that nothing here holds a list of where
 * the motifs are. Position, rotation, scale and species all come out of a hash
 * of the lattice cell's own coordinates, so the pattern can scroll, the shape
 * can be retraced, and two projector tabs can start an hour apart, and every
 * one of them puts the same flower in the same place. A cached list would have
 * to be rebuilt on all three of those, and the third one it would get wrong.
 */

import { rgba, clamp, TAU, mixHex, makeRng, smoothstep } from '../../core/math.js';
import { collectObstacles } from '../obstacles.js';
import { offscreen } from '../lib.js';

/** Shared with the facade family so the wording stays consistent. */
const OBSTACLE_PARAM = {
  key: 'obstacles',
  type: 'text',
  label: 'Solid tags',
  default: 'window, door',
};

/* ------------------------------------------------------------------ *
 * Petals
 * ------------------------------------------------------------------ */

/**
 * How far a petal's centre sits from the flower's, and how big it is.
 *
 * Both fall out of one requirement: that neighbouring petals touch. A flower
 * whose petals have a gap between them reads as a cog, and one whose petals
 * overlap heavily reads as a blob — the tidy round-petalled look of a printed
 * ditsy flower is precisely the case where each petal's circle is tangent to
 * its neighbours'. For `n` petals at centre distance `d`, that happens when the
 * petal radius is `d·sin(π/n)`, and the two together have to add up to the
 * flower's outer radius.
 *
 * The 1.08 is a deliberate hair of overlap, because tangent circles meet at a
 * single point and a projector puts half a pixel there.
 */
function petalGeometry(radius, petals) {
  const s = Math.sin(Math.PI / Math.max(3, petals)) * 1.08;
  const dist = radius / (1 + s);
  return { dist, petal: dist * s };
}

/**
 * One petal, as a lobe pointing away from the flower's centre.
 *
 * Slightly longer than it is wide, which is the difference between a daisy and
 * a bath mat, and drawn about the origin so the caller only has to say where
 * the flower is and which way this petal points.
 */
function tracePetal(c, dist, petal, angle, squash = 1) {
  c.beginPath();
  c.ellipse(
    Math.cos(angle) * dist,
    Math.sin(angle) * dist,
    petal * 1.22 * squash,
    petal * 0.94 * squash,
    angle,
    0,
    TAU
  );
  c.fill();
}

/**
 * A leaf: two curves bulging either side of the same pair of ends, which is all
 * any leaf has ever been. Laid from the origin along +x, so the caller rotates
 * rather than does trigonometry, and left as a path rather than filled — the
 * print's fronds want an outline round the same shape.
 */
function leafPath(c, len, wide) {
  c.beginPath();
  c.moveTo(0, 0);
  c.quadraticCurveTo(len * 0.45, -wide, len, 0);
  c.quadraticCurveTo(len * 0.45, wide, 0, 0);
  c.closePath();
}

/* ------------------------------------------------------------------ *
 * Flowers in a pot
 * ------------------------------------------------------------------ */

/** Joints per stem. Enough for a smooth bend, few enough to be free. */
const STEM_JOINTS = 9;
/** Petals a flower may have, so the per-petal tables never have to be rebuilt. */
const MAX_PETALS = 12;
/** Petals in the air at once. At the ceiling no more leave until some have gone. */
const MAX_FLYING = 260;

/**
 * The lowest point of the shape's outline directly above `x`.
 *
 * Where the stems are planted. The bounding box is nearly right and wrong in
 * the one case that matters: a shape traced round the *pot* rather than as a
 * rectangle above it is a bowl, and rooting a bunch along the bottom of a
 * bowl's bounding box plants the outer stems in mid-air either side of it.
 * Crossing the outline is barely more code and is right for both.
 */
function bottomAt(points, x, fallback) {
  let lowest = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if ((a.x <= x && b.x > x) || (b.x <= x && a.x > x)) {
      const y = a.y + ((x - a.x) / (b.x - a.x)) * (b.y - a.y);
      if (y > lowest) lowest = y;
    }
  }
  return lowest === -Infinity ? fallback : lowest;
}

/**
 * Plant a bunch.
 *
 * Everything here is either geometry or a per-flower draw from the seeded
 * generator, and deliberately *nothing* that a slider can move: sizes, lengths
 * and lean are stored as multipliers of one, and resolved against the live
 * parameters every frame. That is what lets Wilt, Sway and Flower size be bound
 * to an LFO or the microphone without replanting the pot sixty times a second.
 */
function plant(shape, count, seed) {
  const { bbox } = shape;
  const rng = makeRng(`flowers:${seed}:${shape.id}`);
  const n = clamp(Math.round(count), 1, 60);
  const flowers = [];

  for (let i = 0; i < n; i++) {
    // Across the pot, jittered within each flower's own slot so a bunch does
    // not come out as a row of fence posts.
    const u = clamp((i + 0.5) / n + (rng() - 0.5) * (0.8 / n), 0.05, 0.95);
    const x = bbox.x + u * bbox.w;
    const flower = {
      x,
      y: bottomAt(shape.points, x, bbox.y + bbox.h),
      /** Where it sits across the bunch, which is what makes the fan a fan. */
      u,
      lenVar: 0.66 + rng() * 0.44,
      sizeVar: 0.72 + rng() * 0.56,
      leanVar: (rng() - 0.5) * 0.5,
      phase: rng() * TAU,
      /** Between the two flower colours, so a bunch is not two tidy halves. */
      tint: rng(),
      /** Which way this head is turned, so the petals do not all line up. */
      spin: rng() * TAU,
      /** Joints of the current frame's stem. Allocated once, written per frame. */
      jx: new Float32Array(STEM_JOINTS + 1),
      jy: new Float32Array(STEM_JOINTS + 1),
      tipAngle: -Math.PI / 2,
      /**
       * The wilt each petal lets go at, and how big it is.
       *
       * A whole table per flower, filled to the maximum petal count rather than
       * to the current one, so turning the Petals dial does not reshuffle which
       * petals have already blown away.
       */
      drop: new Float32Array(MAX_PETALS),
      petalVar: new Float32Array(MAX_PETALS),
    };
    for (let k = 0; k < MAX_PETALS; k++) {
      // Spread through most of the slider's travel: the first petals go early,
      // the last hangs on almost to the end. Evenly spaced would shed the whole
      // flower in one movement of the hand.
      flower.drop[k] = 0.12 + rng() * 0.8;
      flower.petalVar[k] = 0.82 + rng() * 0.36;
    }
    flowers.push(flower);
  }

  // Tallest at the back. Two hundred years of still life agree about this, and
  // it costs one sort at planting time.
  flowers.sort((a, b) => b.lenVar - a.lenVar);
  return flowers;
}

/**
 * The gust, as one number in [-1, 1] shared by everything in the pot.
 *
 * Every stem and every airborne petal reads this same value, which is the whole
 * reason a bunch looks like it is standing in weather rather than like a dozen
 * independent things that happen to be wobbling. Each stem adds its own quicker
 * bob on top — see `bendOf` — because a gust moves the bunch and a stem answers
 * it at its own rate.
 */
function breezeAt(noise, t, gust) {
  return clamp(noise.noise2(t * (0.12 + gust * 0.22), 0) * 1.25, -1, 1);
}

/**
 * Walk a stem from its root to its tip, writing the joints into the flower.
 *
 * `bend` is the total turn from root to tip, and it is *distributed* along the
 * stem rather than applied at the base: the turn per joint rises with distance
 * from the root, so the bottom stays put and the top does the moving. That is
 * how a stalk bends, and it is also the difference between a flower swaying and
 * a flower being pushed over.
 */
function traceStem(f, len, lean, bend) {
  const seg = len / STEM_JOINTS;
  let angle = -Math.PI / 2 + lean;
  let x = f.x;
  let y = f.y;
  f.jx[0] = x;
  f.jy[0] = y;
  for (let k = 1; k <= STEM_JOINTS; k++) {
    // Weighted so the whole set of increments sums to `bend`.
    angle += (bend * 2 * (k / STEM_JOINTS)) / STEM_JOINTS;
    x += Math.cos(angle) * seg;
    y += Math.sin(angle) * seg;
    f.jx[k] = x;
    f.jy[k] = y;
  }
  f.tipAngle = angle;
}

/** How far this flower leans out of the pot, before the wind touches it. */
function leanOf(f, p) {
  return (f.u - 0.5) * 2 * p.spread * 0.7 + f.leanVar * p.spread + p.fly * 0.05;
}

/** The total bend of a stem this frame: the wind, plus the weight of a dying head. */
function bendOf(f, p, wilt, breeze, t) {
  const sway = Math.sin(t * (0.9 + p.gust * 1.6) + f.phase) * 0.35 + breeze * 0.9;
  // A limp stem answers the wind less and hangs more, so the two terms trade
  // places as the slider goes over rather than piling on top of each other.
  const wind = p.wind * 0.55 * sway * (1 - 0.45 * wilt);
  const droop = wilt * wilt * 1.5 * Math.sign(leanOf(f, p) || (f.tint - 0.5));
  return wind + droop;
}

/**
 * Replant when the pot or the number of flowers changes, and not otherwise.
 *
 * Keyed on `stable`, the parameters before modulation — binding Flowers to the
 * microphone is a strange thing to do, but it should give you a bunch that
 * grows and shrinks, not a bunch that is dug up and replanted sixty times a
 * second. Called from `step` and from `draw`, because either can be the first
 * to run and neither can work without it.
 */
function ensureBunch(shape, stable, state) {
  const key = [
    shape.id,
    Math.round(shape.bbox.x), Math.round(shape.bbox.y),
    Math.round(shape.bbox.w), Math.round(shape.bbox.h),
    Math.round(stable.count), stable.seed,
  ].join('|');
  if (state.key !== key) {
    state.key = key;
    state.flowers = plant(shape, stable.count, stable.seed);
    state.flying = [];
    state.wilt = null;
  }
  return state.flowers;
}

const flowers = {
  id: 'flowers',
  name: 'Flowers',
  category: 'facade',
  scope: 'shape',
  description:
    'A bunch of flowers growing out of the bottom of the shape and swaying in the wind. Trace an area just above a real window box or wall pot and they grow in it. Wilt takes them from fresh to dead and blows the petals off down the wall.',
  params: [
    { key: 'color', type: 'color', label: 'Flower', default: '#e4557a' },
    { key: 'color2', type: 'color', label: 'Second flower', default: '#f0b33c' },
    { key: 'centre', type: 'color', label: 'Centre', default: '#ffe9a8' },
    { key: 'stem', type: 'color', label: 'Stem and leaves', default: '#4f8b3b' },
    { key: 'dry', type: 'color', label: 'Withered', default: '#7d5a33' },
    { key: 'count', type: 'range', label: 'Flowers', default: 9, min: 1, max: 40, step: 1 },
    { key: 'height', type: 'range', label: 'Stem height', default: 0.8, min: 0.15, max: 1.1, step: 0.01 },
    { key: 'size', type: 'range', label: 'Flower size', default: 0.1, min: 0.02, max: 0.5, step: 0.005 },
    { key: 'petals', type: 'range', label: 'Petals', default: 5, min: 3, max: MAX_PETALS, step: 1 },
    { key: 'spread', type: 'range', label: 'Fan out', default: 0.35, min: 0, max: 1.5, step: 0.01 },
    { key: 'leaves', type: 'range', label: 'Leaves', default: 0.6, min: 0, max: 1, step: 0.01 },
    { key: 'wind', type: 'range', label: 'Sway', default: 0.5, min: 0, max: 2, step: 0.01 },
    { key: 'gust', type: 'range', label: 'Gustiness', default: 0.6, min: 0, max: 3, step: 0.01 },
    /**
     * The one to bind to something. Nought is a fresh bunch, one is a dead
     * one with every petal gone; on a trigger or a slow LFO it is a whole
     * evening's worth of decay, and it is what makes this useful in October
     * rather than only in June.
     */
    { key: 'wilt', type: 'range', label: 'Wilt', default: 0, min: 0, max: 1, step: 0.01 },
    /** Signed: the direction the petals go, and which way the plant leans. */
    { key: 'fly', type: 'range', label: 'Petals blow', default: 1, min: -3, max: 3, step: 0.05 },
    { key: 'seed', type: 'range', label: 'Seed', default: 1, min: 1, max: 99, step: 1 },
  ],
  init() {
    return { key: '', flowers: [], flying: [], wilt: null };
  },

  step({ p, shape, t, dt, rng, state, stable, noise, world }) {
    const { bbox } = shape;
    if (bbox.w <= 2 || bbox.h <= 2) return;
    const bunch = ensureBunch(shape, stable, state);

    const wilt = clamp(p.wilt, 0, 1);
    const breeze = breezeAt(noise, t, p.gust);
    const petals = clamp(Math.round(p.petals), 3, MAX_PETALS);
    const headR = Math.max(3, p.size * bbox.h);

    /**
     * Petals leave when the slider passes the value they were born holding on
     * to.
     *
     * A threshold crossing rather than a rate, which buys two things. Sliding
     * the control back down puts the petals back — the bunch recovers, which
     * for a light show is the right answer and for a simulation would not be —
     * and where the slider *is* fully determines how bare the flowers are, so
     * two projector tabs that have been running for different lengths of time
     * still show the same flower. A spawn rate gets both of those wrong.
     */
    const was = state.wilt === null ? wilt : state.wilt;
    state.wilt = wilt;
    if (wilt > was) {
      for (const f of bunch) {
        let shedding = false;
        for (let k = 0; k < petals; k++) {
          if (f.drop[k] > was && f.drop[k] <= wilt) { shedding = true; break; }
        }
        if (!shedding) continue;

        // Only now is it worth working out where this head actually is.
        const len = Math.max(6, p.height * bbox.h * f.lenVar);
        traceStem(f, len, leanOf(f, p), bendOf(f, p, wilt, breeze, t));
        const r = headR * f.sizeVar;
        const { dist, petal } = petalGeometry(r, petals);
        const nod = f.tipAngle + Math.PI / 2 + wilt * 0.8;

        for (let k = 0; k < petals; k++) {
          if (f.drop[k] <= was || f.drop[k] > wilt) continue;
          if (state.flying.length >= MAX_FLYING) break;
          const a = nod + f.spin + (k / petals) * TAU;
          state.flying.push({
            x: f.jx[STEM_JOINTS] + Math.cos(a) * dist,
            y: f.jy[STEM_JOINTS] + Math.sin(a) * dist,
            vx: Math.cos(a) * 12,
            vy: Math.sin(a) * 12 - 8,
            r: petal * f.petalVar[k],
            tilt: a,
            /** Where it is in its own tumble, which is what makes it flutter. */
            flutter: rng() * TAU,
            spin: (0.8 + rng() * 2.6) * (rng() < 0.5 ? -1 : 1),
            colour: mixHex(mixHex(p.color, p.color2, f.tint), p.dry, wilt * 0.55),
            life: 0,
            span: 5 + rng() * 6,
          });
        }
      }
    }

    /**
     * A petal falls at terminal velocity and slides sideways as it tumbles.
     *
     * Both come out of the same rotation: the drag on a flat thing depends on
     * how much of it is facing the way it is going, so a petal that is rocking
     * shoves itself from side to side while it comes down. Integrating it that
     * way rather than adding a sine to the position is what gives the drifting,
     * settling-leaf motion instead of a bead on a wire.
     */
    const wind = p.fly * (28 + 46 * breeze);
    for (let i = state.flying.length - 1; i >= 0; i--) {
      const q = state.flying[i];
      q.life += dt;
      q.flutter += q.spin * dt;
      q.tilt += q.spin * 0.55 * dt;
      q.vx += (wind + Math.cos(q.flutter) * 70 * Math.abs(p.fly) - q.vx) * 2.2 * dt;
      q.vy += (74 + Math.sin(q.flutter * 0.5) * 26 - q.vy) * 2.6 * dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;

      const gone = q.life > q.span
        || q.y > (world?.h ?? bbox.y + bbox.h * 4) + 40
        || q.x < -60 || q.x > (world?.w ?? bbox.x + bbox.w * 4) + 60;
      if (gone) state.flying.splice(i, 1);
    }
  },

  draw({ g, p, shape, t, state, stable, noise }) {
    const { bbox } = shape;
    if (bbox.w <= 2 || bbox.h <= 2) return;
    const bunch = ensureBunch(shape, stable, state);

    const wilt = clamp(p.wilt, 0, 1);
    const breeze = breezeAt(noise, t, p.gust);
    const petals = clamp(Math.round(p.petals), 3, MAX_PETALS);
    const headR = Math.max(3, p.size * bbox.h);
    const green = mixHex(p.stem, p.dry, wilt * 0.85);

    g.save();
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const alpha = g.globalAlpha;

    // Airborne petals go down first, so they blow away behind the bunch rather
    // than across the front of it.
    for (const q of state.flying) {
      const fade = clamp(q.span - q.life, 0, 1) * clamp(q.life * 6, 0, 1);
      if (fade <= 0.01) continue;
      g.globalAlpha = alpha * fade;
      g.fillStyle = q.colour;
      g.save();
      g.translate(q.x, q.y);
      g.rotate(q.tilt);
      // A tumbling petal presents an edge to you twice a turn and all but
      // disappears. One scale is the whole of that.
      g.scale(1, 0.2 + 0.8 * Math.abs(Math.cos(q.flutter)));
      g.beginPath();
      g.ellipse(0, 0, q.r * 1.2, q.r * 0.92, 0, 0, TAU);
      g.fill();
      g.restore();
    }
    g.globalAlpha = alpha;

    // Every stem, then every head: a head must never be behind the stem of the
    // flower in front of it.
    for (const f of bunch) {
      const len = Math.max(6, p.height * bbox.h * f.lenVar);
      traceStem(f, len, leanOf(f, p), bendOf(f, p, wilt, breeze, t));

      g.strokeStyle = green;
      g.lineWidth = Math.max(2.5, headR * f.sizeVar * 0.13);
      g.beginPath();
      g.moveTo(f.jx[0], f.jy[0]);
      for (let k = 1; k <= STEM_JOINTS; k++) g.lineTo(f.jx[k], f.jy[k]);
      g.stroke();

      if (p.leaves > 0) {
        g.fillStyle = green;
        // Two leaves, on opposite sides, a third and two thirds of the way up.
        for (const [at, side] of [[3, 1], [6, -1]]) {
          const along = Math.atan2(f.jy[at] - f.jy[at - 1], f.jx[at] - f.jx[at - 1]);
          const leafLen = len * 0.3 * p.leaves * (1 - wilt * 0.4);
          if (leafLen < 2) continue;
          // Held out from the stem while it is alive and hanging off it when it
          // is not — a dying leaf lets go and points at the ground, and the
          // difference between that and one that keeps sticking out is most of
          // what "wilted" looks like at a distance.
          const held = along + side * 1.0;
          const hangs = Math.PI / 2 + side * 0.25;
          g.save();
          g.translate(f.jx[at], f.jy[at]);
          g.rotate(held + (hangs - held) * wilt * 0.85);
          leafPath(g, leafLen, leafLen * 0.34);
          g.fill();
          g.restore();
        }
      }
    }

    for (const f of bunch) {
      const r = headR * f.sizeVar;
      const { dist, petal } = petalGeometry(r, petals);
      const colour = mixHex(mixHex(p.color, p.color2, f.tint), p.dry, wilt);

      g.save();
      // The head hangs off the end of the stem, so it points where the stem
      // points — and nods further forward the more it wilts.
      g.translate(f.jx[STEM_JOINTS], f.jy[STEM_JOINTS]);
      g.rotate(f.tipAngle + Math.PI / 2 + wilt * 0.8);
      g.fillStyle = colour;

      for (let k = 0; k < petals; k++) {
        if (wilt >= f.drop[k]) continue;
        // The last of the travel before a petal lets go is spent curling: it
        // shrinks and turns out of the plane, so petals leave the flower rather
        // than blinking out of it.
        const curl = smoothstep(f.drop[k] - 0.16, f.drop[k], wilt);
        const squash = f.petalVar[k] * (1 - curl * 0.55);
        tracePetal(g, dist, petal, f.spin + (k / petals) * TAU, squash);
      }

      g.fillStyle = mixHex(p.centre, p.dry, wilt * 0.8);
      g.beginPath();
      g.arc(0, 0, Math.max(1, r * 0.3), 0, TAU);
      g.fill();
      g.restore();
    }

    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * Prints
 *
 * The machinery under Ditsy Flowers and Paisley. A print is a lattice, a bag
 * of motifs, and a rule for which motif goes in which cell — and the rule is
 * the part that has to be got right, because it is what stops the pattern
 * being a list.
 * ------------------------------------------------------------------ */

/**
 * Motifs a single layer may stamp in one frame.
 *
 * Each is one `drawImage` with a transform, which is cheap but not free, and
 * the number of them is the only thing about a print that can run away: a whole
 * facade at the smallest motif size would be forty thousand of them. Rather
 * than clamp the size control — a print of tiny flowers is a perfectly
 * reasonable thing to want on a small window — the pitch is opened out until
 * the count fits. You lose density at extreme settings and keep the frame rate.
 */
const MAX_MOTIFS = 900;

/**
 * Small motifs a cell may scatter round its own, at **Density** 1.
 *
 * A print is not one motif repeated, it is two or three sizes of motif layered:
 * a bold one on the repeat, a middling one between, and a fine ground of small
 * things filling what is left. Without that last layer the ground reads as
 * empty paper with objects on it, which is exactly what a scatter of one size
 * looks like from the road.
 *
 * They sit in fixed directions round the cell rather than being spread evenly
 * over however many there currently are — so turning Density up adds one in a
 * gap instead of shuffling the ones already there, which is the difference
 * between a control you can bind to the music and one you cannot.
 */
const MAX_SATELLITES = 6;

/**
 * Everything about the motif in a given cell, from the cell's own coordinates.
 *
 * The alternative is a list built once and cached, and the reason not to have
 * one is scrolling: with a list, a drifting pattern either rebuilds itself
 * every time it moves a whole cell — which is a visible reshuffle — or wraps,
 * which puts a seam across the wall. Deriving everything from `(col, row)`
 * means a motif belongs to its place on the building rather than to its index
 * in an array, so the lattice can slide, the shape can be retraced and a second
 * projector can join an hour late, and the same flower is in the same place.
 *
 * A plain integer mix rather than `makeRng`: this runs several hundred times a
 * frame and a generator per cell would mean a string and an object per cell.
 */
function cellHash(col, row, seed) {
  let h = (Math.imul(col | 0, 374761393) + Math.imul(row | 0, 668265263) + Math.imul(seed | 0, 2246822519)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Another 32 well-mixed bits out of the ones we already have. One multiply.
 *
 * Cheaper than hashing the cell again, and it is what keeps rotation from being
 * a function of position jitter: thirty-two bits is not enough for everything a
 * motif needs to know about itself, and packing two fields into the same bits
 * means every motif tilted a particular way is also nudged the same way. That
 * is the sort of correlation nobody sees until the day they can see nothing
 * else.
 */
function remix(h) {
  return Math.imul(h ^ 0x85ebca6b, 2246822519) >>> 0;
}

/** Bits `count` wide out of a hash, as a fraction in [0, 1). */
function bits(h, shift, count) {
  return ((h >>> shift) & ((1 << count) - 1)) / (1 << count);
}

/**
 * The lattice pitch, opened out if the shape would hold more motifs than we
 * are prepared to draw in one frame.
 *
 * The ring of cells drawn past each edge — so a motif straddling the boundary
 * is not simply missing — is counted, because at a coarse pitch over a small
 * shape that ring is most of the work rather than a rounding error. Solved by
 * repetition rather than algebra: opening the pitch shrinks the ring as well as
 * the interior, so the first estimate always overshoots and two passes settle
 * it to within a few per cent.
 */
function pitchFor(bbox, size, perCell = 1) {
  let pitch = Math.max(18, size);
  for (let i = 0; i < 3; i++) {
    const motifs = (bbox.w / pitch + 3) * (bbox.h / pitch + 3) * perCell;
    if (motifs <= MAX_MOTIFS) break;
    pitch *= Math.sqrt(motifs / MAX_MOTIFS);
  }
  return pitch;
}

/**
 * The shape with the openings taken out of it, as one path.
 *
 * Wallpaper is cut at a window reveal, not hung over the glass, and this is the
 * whole of that: the wall's outline and every opening's outline in a single
 * Path2D, filled even-odd, so anything inside an opening falls in a hole.
 *
 * Brickwork solves the same problem by erasing the openings out of the bitmap
 * it baked, which is not available here — a print is stamped live, and erasing
 * on the shared canvas would take out whatever is underneath this layer as
 * well. Clipping costs nothing per motif and cuts the ground fill too.
 *
 * The geometry cache hands back the same `Path2D` object for a shape nobody has
 * moved, so identity is a sound and very cheap key.
 */
function ensureMask(state, shape, obstacles) {
  const parts = state.maskParts;
  const same = parts
    && parts.length === obstacles.length + 1
    && parts[0] === shape.path
    && obstacles.every((o, i) => parts[i + 1] === o.path);
  if (same) return state.mask;

  const mask = new Path2D();
  mask.addPath(shape.path);
  for (const o of obstacles) mask.addPath(o.path);
  state.mask = mask;
  state.maskParts = [shape.path, ...obstacles.map((o) => o.path)];
  return mask;
}

/**
 * The openings that can actually cut this wall: the ones that overlap it.
 *
 * Correctness would not care — an opening somewhere else takes nothing out of
 * this shape either way — but cost does, and by more than anything else here.
 * A clip path is rasterised into a mask the size of its own bounds, so a layer
 * pointed at five windows that dutifully added every *other* window to each
 * one's mask was building five full-facade masks a frame to cut five window-
 * sized holes. Measured at 2.1 ms against 0.4 ms for the same picture.
 */
function overlapping(obstacles, bbox) {
  return obstacles.filter((o) => {
    const b = o.bbox;
    return b.x < bbox.x + bbox.w && b.x + b.w > bbox.x && b.y < bbox.y + bbox.h && b.y + b.h > bbox.y;
  });
}

/* ------------------------------------------------------------------ *
 * Packing
 * ------------------------------------------------------------------ */

/**
 * How much of a motif's cell its artwork actually occupies, as a radius.
 *
 * The sprites are square and their drawing is inscribed in them, so half the
 * stamped size is a circle that provably contains the ink whichever way the
 * motif is turned. It is generous for a boteh, which is long and thin and
 * mostly air out at that radius — but a circle is the only footprint that does
 * not change as a motif rotates, and rotating footprints would mean re-packing
 * the wall every time the breeze moved.
 */
const FOOTPRINT = 0.46;

/**
 * A motif's footprint: where its ink actually is, as a few circles.
 *
 * One circle round the whole sprite is the obvious choice and it is what makes
 * a print of teardrops look like a page of stickers. A boteh is long, thin and
 * bent, so the circle that contains it is four fifths air — pack by that and
 * every motif keeps half a cell of empty ground it was never using, and no
 * amount of filler can get in there because the space is spoken for.
 *
 * Two or three circles down the length of the shape cost almost nothing and
 * describe it well enough that motifs nestle: a curl sits in the hook of a
 * teardrop, a dot sits under its belly, and the ground fills in the way a
 * printed one does. Round motifs still take a single circle, which is exact.
 *
 * Coordinates are fractions of the stamped size, measured from its centre, so
 * they rotate and scale with the motif and never need rebaking.
 */
const ROUND_FOOTPRINT = [[0, 0, FOOTPRINT]];

/**
 * Everything the print wants to draw this frame, and what has to happen to it
 * so that no two of them sit on top of each other.
 *
 * A print is a *layout*: motifs interlock, they do not overlap. Two teardrops
 * crossing read as one unrecognisable object, and a filler dropped on top of
 * the motif it is meant to be setting off reads as damage. But a scatter that
 * refuses to place anything it cannot fit leaves holes, and — worse for
 * something meant to be bound to the music — makes motifs blink in and out as
 * whatever they are competing with changes size.
 *
 * So nothing is ever rejected: everything is placed, and anything crowded is
 * *shrunk to fit*. Where two motifs would overlap, they divide the distance
 * between them in proportion to how big each wanted to be, so the pair ends up
 * exactly touching. That rule is worth stating precisely because three of its
 * properties are what make the whole thing work:
 *
 *  - **Motifs of equal standing divide the space between them**, in proportion
 *    to what each asked for, so the pair ends up exactly touching and neither
 *    of them needed to know which was placed first.
 *  - **Anything later yields to what is already there.** The bold repeat is
 *    laid down, the middling motifs fit round it, the fine ground fits round
 *    them; a filler squeezed against a teardrop gives way entirely rather than
 *    taking a bite out of it.
 *  - **It is continuous**, which is the property the whole thing is for. Move a
 *    motif a pixel and every size changes by a pixel's worth; turn Density up
 *    and the new arrivals grow out of nothing while nothing already on the wall
 *    so much as flinches. That is what lets these controls be driven from an
 *    LFO or the microphone instead of only set by hand.
 *
 * The rank is what buys the second and third of those, and it is not
 * decoration. Divide the distance proportionally between a bold motif and a
 * filler that has just started to exist, and the filler's radius is nearly
 * nought — so the "fair" share leaves the *bold* motif shrunk to the distance
 * between them. A speck appearing in the middle of a teardrop would halve it.
 * Ranking says the teardrop was there first, so it does not move and the speck
 * simply has nowhere to be.
 *
 * What the whole scheme gives up is that a long thin teardrop reserves a round
 * space, so botehs lying side by side keep more distance than their ink needs.
 * The fine ground fills that space, which is what the fine ground is for.
 */
/**
 * Is the layout in hand still the layout we want?
 *
 * Packing is the most expensive thing either print does, and on a wall that is
 * only breathing it is the same answer every frame — the gust rocks and swells
 * the motifs, and the footprint already has room for that. So it is worked out
 * once and kept until something that actually shapes the layout moves: the
 * lattice, the shape, the openings, the seed, how many fillers there are.
 *
 * Every field here is a number or an identity, compared rather than hashed into
 * a string, because this runs every frame and a string per frame per layer is
 * a string per frame per layer.
 */
function packUnchanged(pack, fields) {
  const held = pack.fields;
  if (!held) return false;
  for (let i = 0; i < fields.length; i++) if (held[i] !== fields[i]) return false;
  return true;
}

function ensurePack(state, capacity) {
  let pack = state.pack;
  if (!pack || pack.cap < capacity) {
    const cap = Math.max(128, 1 << Math.ceil(Math.log2(capacity)));
    pack = {
      cap,
      /** Motifs. */
      n: 0,
      mx: new Float64Array(cap),
      my: new Float64Array(cap),
      size: new Float64Array(cap),
      angle: new Float64Array(cap),
      mirror: new Uint8Array(cap),
      hash: new Uint32Array(cap),
      motif: new Array(cap),
      /** Nought for the bold repeat, and up from there. Later yields to earlier. */
      rank: new Uint8Array(cap),
      /** How much of what it asked for it ended up with. */
      shrink: new Float64Array(cap),
      /** Where this motif's footprint circles start, and how many it has. */
      first: new Int32Array(cap),
      spots: new Int32Array(cap),
      /** Footprint circles, several per motif. */
      c: 0,
      ccap: cap * 3,
      cx: new Float64Array(cap * 3),
      cy: new Float64Array(cap * 3),
      /** The radius it asked for, and the one it got. */
      cwant: new Float64Array(cap * 3),
      cradius: new Float64Array(cap * 3),
      cowner: new Int32Array(cap * 3),
      next: new Int32Array(cap * 3),
      head: new Int32Array(0),
      /** What the layout in here was built from. See `packUnchanged`. */
      fields: null,
    };
    state.pack = pack;
  }
  return pack;
}

/**
 * Room for one more.
 *
 * Guessing the capacity from the lattice bounds is close but not exact — the
 * loop runs a ring of cells past each edge and how many that is depends on
 * where the shape falls between two cells — and being one short is not a
 * missing motif at the edge, it is a motif dropped from wherever the count ran
 * out, which moves as the controls move. Growing on demand costs one copy the
 * first time a layout is drawn and cannot be wrong.
 */
function packGrow(pack) {
  const cap = pack.cap * 2;
  const ccap = cap * 3;
  const wider = (arr, Type, size) => {
    const next = new Type(size);
    next.set(arr);
    return next;
  };
  pack.mx = wider(pack.mx, Float64Array, cap);
  pack.my = wider(pack.my, Float64Array, cap);
  pack.size = wider(pack.size, Float64Array, cap);
  pack.angle = wider(pack.angle, Float64Array, cap);
  pack.mirror = wider(pack.mirror, Uint8Array, cap);
  pack.hash = wider(pack.hash, Uint32Array, cap);
  pack.rank = wider(pack.rank, Uint8Array, cap);
  pack.shrink = wider(pack.shrink, Float64Array, cap);
  pack.first = wider(pack.first, Int32Array, cap);
  pack.spots = wider(pack.spots, Int32Array, cap);
  pack.motif.length = cap;
  pack.cx = wider(pack.cx, Float64Array, ccap);
  pack.cy = wider(pack.cy, Float64Array, ccap);
  pack.cwant = wider(pack.cwant, Float64Array, ccap);
  pack.cradius = wider(pack.cradius, Float64Array, ccap);
  pack.cowner = wider(pack.cowner, Int32Array, ccap);
  pack.next = wider(pack.next, Int32Array, ccap);
  pack.cap = cap;
  pack.ccap = ccap;
}

/**
 * One motif, with its footprint laid out in world coordinates.
 *
 * The footprint turns and scales with the motif, which is why the sprites
 * describe theirs in their own units: a teardrop lying along the wall reserves
 * a long thin region, and the same teardrop stood on end reserves a tall one.
 */
function packAdd(pack, x, y, size, angle, mirror, wobble, rank, motif, hash) {
  if (pack.n >= pack.cap) packGrow(pack);
  const i = pack.n++;
  pack.mx[i] = x;
  pack.my[i] = y;
  pack.size[i] = size;
  pack.angle[i] = angle;
  pack.mirror[i] = mirror ? 1 : 0;
  pack.rank[i] = rank;
  pack.shrink[i] = 1;
  pack.motif[i] = motif;
  pack.hash[i] = hash;

  const spots = motif.spots || ROUND_FOOTPRINT;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  pack.first[i] = pack.c;
  pack.spots[i] = spots.length;
  for (let s = 0; s < spots.length; s++) {
    const u = spots[s][0] * (mirror ? -1 : 1) * size;
    const v = spots[s][1] * size;
    const k = pack.c++;
    pack.cx[k] = x + u * cos - v * sin;
    pack.cy[k] = y + u * sin + v * cos;
    /**
     * Room for the rock, added here rather than left to the painter.
     *
     * The sway turns a motif a few degrees either way as the gust crosses it,
     * which sweeps every circle in its footprint through an arc — and a circle
     * `d` from the centre swinging `w` radians stays inside a circle `d·w`
     * wider. Paying that here means the packing is a fact about the *layout*
     * and not about this instant, which is what lets it be worked out once and
     * used for as long as nothing moves.
     */
    const swept = spots[s][2] * size + Math.hypot(u, v) * wobble;
    pack.cwant[k] = swept;
    pack.cradius[k] = swept;
    pack.cowner[k] = i;
  }
  return i;
}

/**
 * Shrink whatever overlaps, in one pass per rank.
 *
 * Bucketed on a grid a lattice pitch across, and each circle only searches as
 * far as it could possibly reach — its own radius plus the largest on the wall.
 * A dot therefore looks at the bucket it is in and little else, which matters
 * because most of a dense print is dots.
 */
/**
 * Half a lattice pitch.
 *
 * The area a circle has to search is fixed by how far it can reach, but the
 * *bucket* it searches in squares is not: coarse buckets round that area up to
 * something several times too big, and every circle in the surplus is a
 * distance test that was never going to hit. Halving the pitch roughly halves
 * the candidates. Going finer than this stops paying, because the grid walk
 * starts costing more than the tests it saves.
 */
const BUCKET = 0.5;

function packResolve(pack, bucket, gap) {
  const n = pack.n;
  const c = pack.c;
  if (n < 2) return;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxWant = 0;
  for (let k = 0; k < c; k++) {
    if (pack.cx[k] < minX) minX = pack.cx[k];
    if (pack.cx[k] > maxX) maxX = pack.cx[k];
    if (pack.cy[k] < minY) minY = pack.cy[k];
    if (pack.cy[k] > maxY) maxY = pack.cy[k];
    if (pack.cwant[k] > maxWant) maxWant = pack.cwant[k];
  }

  const cols = Math.max(1, Math.floor((maxX - minX) / bucket) + 1);
  const rows = Math.max(1, Math.floor((maxY - minY) / bucket) + 1);
  if (pack.head.length < cols * rows) pack.head = new Int32Array(cols * rows);
  pack.head.fill(-1, 0, cols * rows);

  const bucketX = (k) => Math.min(cols - 1, Math.max(0, Math.floor((pack.cx[k] - minX) / bucket)));
  const bucketY = (k) => Math.min(rows - 1, Math.max(0, Math.floor((pack.cy[k] - minY) / bucket)));

  for (let k = 0; k < c; k++) {
    const b = bucketY(k) * cols + bucketX(k);
    pack.next[k] = pack.head[b];
    pack.head[b] = k;
  }

  let maxRank = 0;
  for (let i = 0; i < n; i++) if (pack.rank[i] > maxRank) maxRank = pack.rank[i];

  // Rank by rank, so that by the time a motif is placed everything it has to
  // give way to has already settled on a size.
  for (let rank = 0; rank <= maxRank; rank++) {
    for (let i = 0; i < n; i++) {
      if (pack.rank[i] !== rank) continue;
      let held = 1;

      for (let k = pack.first[i]; k < pack.first[i] + pack.spots[i]; k++) {
        const wi = pack.cwant[k];
        if (wi <= 0) continue;
        const span = Math.ceil((wi + maxWant + gap) / bucket);
        const gx0 = bucketX(k);
        const gy0 = bucketY(k);

        for (let gy = Math.max(0, gy0 - span); gy <= Math.min(rows - 1, gy0 + span); gy++) {
          for (let gx = Math.max(0, gx0 - span); gx <= Math.min(cols - 1, gx0 + span); gx++) {
            for (let j = pack.head[gy * cols + gx]; j >= 0; j = pack.next[j]) {
              const owner = pack.cowner[j];
              if (owner === i || pack.rank[owner] > rank) continue;
              const senior = pack.rank[owner] < rank;
              // Against a senior motif, the room it actually took; against an
              // equal, what it asked for — which is symmetric, and is what
              // makes the split need no order.
              const wj = senior ? pack.cradius[j] : pack.cwant[j];
              const dx = pack.cx[k] - pack.cx[j];
              const dy = pack.cy[k] - pack.cy[j];
              const reach = wi + wj + gap;
              const d2 = dx * dx + dy * dy;
              // The square test first: most candidates are clear, and this is
              // the one line in the effect that runs tens of thousands of times.
              if (d2 >= reach * reach) continue;
              const d = Math.sqrt(d2) - gap;
              // Give way entirely to a senior; divide the room with an equal.
              const share = senior ? d - wj : d * (wi / (wi + wj));
              if (share < held * wi) held = Math.max(0, share) / wi;
            }
          }
        }
      }

      if (held < 1) {
        pack.shrink[i] = held;
        pack.size[i] *= held;
        for (let k = pack.first[i]; k < pack.first[i] + pack.spots[i]; k++) pack.cradius[k] *= held;
      }
    }
  }
}

/** Is this motif wholly inside an opening, and so pure cost? */
function hiddenByOpening(obstacles, x, y, r) {
  for (const o of obstacles) {
    const b = o.bbox;
    if (x - r > b.x && x + r < b.x + b.w && y - r > b.y && y + r < b.y + b.h) return true;
  }
  return false;
}

/**
 * Lay a print over a shape.
 *
 * The lattice is anchored in world space rather than to the shape's own
 * bounding box, for the reason brickwork's courses are: two walls either side
 * of a door with their own private lattices disagree about where the pattern
 * is, and no combination of settings can make them agree, because the
 * disagreement is in the anchor rather than in the numbers.
 *
 * Three layers come off one lattice. Cells take turns between the bold motifs
 * and the middling ones — the half-drop alternation a paisley is built on — and
 * every cell scatters a few small ones round its own. A print with one bag of
 * motifs passes `pick` alone and gets a plain scatter, which is what a ditsy is.
 *
 * @param {object} sheet  Baked motifs: `{ list, pick, second, filler }` — see
 *   the bakers. `second` and `filler` may be null.
 */
function stampPrint(g, { shape, obstacles: all, sheet, state, t, p, perCell = 1, halfDrop = false, facets = 0, vary = 0.66 }) {
  const { bbox } = shape;
  const obstacles = overlapping(all, bbox);

  const want = clamp(p.density ?? 0, 0, 1) * MAX_SATELLITES * (sheet.filler ? 1 : 0);
  const satellites = Math.ceil(want);
  /**
   * The budget is taken from `perCell`, which the caller works out from the
   * *unmodulated* density, rather than from how many satellites this frame
   * happens to want.
   *
   * Otherwise Density and the pitch are wired together, and the one control
   * most worth binding to the music would drag the whole lattice in and out
   * with it every time the budget bound — the pattern jumping about while the
   * ground fills in. Overshooting the budget by a few motifs on the loud beats
   * is the cheaper mistake by a long way.
   */
  const pitch = pitchFor(bbox, p.size, perCell);
  const seed = Math.round(p.seed);
  const scatter = clamp(p.scatter ?? 0.5, 0, 1);
  /**
   * How much of the room it was given each motif actually takes.
   *
   * The packing settles what space a motif *has*; Fill and Swell decide how
   * much of it to use, and both of them only ever take less. That is what keeps
   * the no-overlap guarantee true at every instant rather than on average — a
   * print bound to the microphone can pulse as hard as you like and still never
   * put one teardrop through another, because full is exactly touching.
   */
  const fill = clamp(p.fill ?? 1, 0.05, 1);
  const sway = clamp(p.sway, 0, 1);
  const swell = clamp(p.swell ?? 0, 0, 1);
  const shimmer = clamp(p.shimmer, 0, 1);
  const breeze = p.breeze;
  /**
   * Where the gust is, and which way everything is turned, as plain numbers.
   *
   * Both are in turns rather than radians or degrees, and that is the point of
   * them: a saw LFO sweeping one of these from 0 to 1 comes back exactly where
   * it started, so the wave can be driven from the beat, the microphone or an
   * expression instead of only from the clock. Set Breeze speed to zero and
   * Phase becomes the only thing moving the wall.
   */
  const phase = (p.phase ?? 0) * TAU;
  const turn = (p.turn ?? 0) * TAU;

  const heldMask = state.mask;
  const mask = ensureMask(state, shape, obstacles);

  g.save();
  g.clip(mask, 'evenodd');

  // Multiplied into rather than assigned over, so the master fader still
  // reaches a layer that is drawing straight into the frame.
  const alpha = g.globalAlpha;

  if (p.groundLevel > 0) {
    g.fillStyle = rgba(p.ground, clamp(p.groundLevel, 0, 1) * alpha);
    g.fillRect(bbox.x, bbox.y, bbox.w, bbox.h);
  }

  /**
   * Which way a motif faces before the gust touches it.
   *
   * The packing has to know, because a teardrop lying along the wall reserves a
   * different region from one stood on end — but it must not depend on *when*,
   * or the layout would have to be worked out again every frame.
   */
  const facing = (h) => {
    const spin = bits(h, 0, 12);
    // A print's motifs point in a handful of directions rather than in every
    // direction; free rotation reads as clip art tipped over.
    return turn + (facets > 0
      ? Math.floor(spin * facets) * (TAU / facets) + (bits(h, 12, 6) - 0.5) * 0.3
      : spin * TAU);
  };

  /**
   * Where a motif stands in the travelling wave.
   *
   * One wave does all the moving, and every motif reads it at its own position
   * on the wall. That is the difference between a wall that breathes and a wall
   * of things that each happen to be wobbling: neighbours are nearly in phase
   * with each other and the far end of the house is not, so what crosses the
   * brickwork is a gust rather than a screensaver.
   */
  const waveAt = (x, y, h) => Math.sin(
    x * 0.0068 + y * 0.0049 - t * breeze * 1.5 + phase + bits(h, 18, 8) * TAU
  );

  // How far the whole lattice has slid. Whole cells of it are absorbed into the
  // row index below, so this never grows without bound and the pattern never
  // has to wrap.
  const slide = p.drift * t;
  const firstRow = Math.floor((bbox.y - slide) / pitch) - 1;
  const lastRow = Math.ceil((bbox.y + bbox.h - slide) / pitch) + 1;
  /**
   * How far past the shape motifs are still collected.
   *
   * Wider than it needs to be for *drawing* — the clip cuts anything past the
   * edge — because a motif just inside the edge has to pack against the ones
   * just outside it. Leave them out and a wall packs its edge differently from
   * the way the wall next to it packs the same place, which is exactly the
   * disagreement the world-anchored lattice exists to prevent.
   */
  const margin = pitch * 1.6;

  const cols = Math.ceil(bbox.w / pitch) + 3;
  const rows = lastRow - firstRow + 1;
  const pack = ensurePack(state, (cols + 1) * (rows + 1) * (1 + satellites));

  /**
   * The sway, as the widest angle it reaches rather than the angle it is at.
   *
   * The layout has to hold for the whole swing, not for this instant, or it
   * would have to be worked out again every time the gust moved — which is the
   * whole cost of the effect.
   */
  const wobble = sway * 0.38;
  const layout = [
    sheet, pitch, seed, scatter, vary, satellites, want, slide, turn, wobble,
    halfDrop ? 1 : 0, facets, bbox.x, bbox.y, bbox.w, bbox.h,
    mask === heldMask ? 1 : 0,
  ];

  if (!packUnchanged(pack, layout)) {
    pack.fields = layout;
    // Whatever was in hand was packed round the openings as they were; if the
    // mask has just been rebuilt they have moved.
    pack.fields[16] = 1;
    pack.n = 0;
    pack.c = 0;
    collect();
    packResolve(pack, pitch * BUCKET, pitch * 0.02);
  }

  paint();
  g.globalAlpha = alpha;
  g.restore();

  /** Every motif the lattice asks for, and the space each of them wants. */
  function collect() {
    /** Collect one, unless it has landed where nobody could see it. */
    const put = (motif, x, y, size, rank, h) => {
      if (size < 1.5 || hiddenByOpening(obstacles, x, y, size * 0.5)) return;
      // Half of them handed the other way. A boteh has a hand, and a wall of
      // teardrops all hooking the same way is a rubber stamp; mirroring doubles
      // the variety for one call and no memory.
      packAdd(pack, x, y, size, facing(h), (h & 0x20000000) !== 0, wobble, rank, motif, h);
    };

    for (let row = firstRow; row <= lastRow; row++) {
      const y0 = row * pitch + slide;
      const drop = halfDrop && (((row % 2) + 2) % 2) ? pitch / 2 : 0;
      const firstCol = Math.floor((bbox.x - drop) / pitch) - 1;
      const lastCol = Math.ceil((bbox.x + bbox.w - drop) / pitch) + 1;

      for (let col = firstCol; col <= lastCol; col++) {
        const h = cellHash(col, row, seed);

        const x = col * pitch + drop + (bits(h, 4, 8) - 0.5) * pitch * scatter;
        const y = y0 + (bits(h, 12, 8) - 0.5) * pitch * scatter;
        if (x < bbox.x - margin || x > bbox.x + bbox.w + margin) continue;
        if (y < bbox.y - margin || y > bbox.y + bbox.h + margin) continue;

        // Bold motif, middling motif, bold motif — the alternation a formal print
        // is laid out on. One bag for both cells is a scatter instead.
        const bag = sheet.second && ((col + row) & 1) ? sheet.second : sheet.pick;
        const motif = sheet.list[bag[h % bag.length]];
        put(motif, x, y, pitch * motif.scale * (1 - vary / 2 + bits(h, 20, 8) * vary), 0, remix(h));

        for (let s = 0; s < satellites; s++) {
          const hs = remix(h ^ Math.imul(s + 1, 0x9e3779b9));
          /**
           * The newest one grows in rather than appearing.
           *
           * Density is meant to be bound to something, and a satellite that
           * switches on at full size is a pop on every beat. A fractional density
           * scales whichever satellite is currently on the edge of existing.
           */
          const grow = clamp(want - s, 0, 1);
          const filler = sheet.list[sheet.filler[hs % sheet.filler.length]];
          /**
           * Out at the corners of the cell, where the gaps are.
           *
           * A bold motif is packed until it touches the cells north, south, east
           * and west of it, so the space left over on a lattice is the diagonals
           * — and a filler aimed anywhere else is squeezed to nothing by the very
           * motif it was supposed to be setting off. The quarter-turn offset puts
           * the first one in a corner rather than on a neighbour's nose.
           */
          const around = Math.PI / 4 + (s / MAX_SATELLITES) * TAU
            + bits(hs, 16, 4) * (TAU / MAX_SATELLITES);
          const out = pitch * (0.62 + bits(hs, 0, 8) * 0.33);
          put(
            filler,
            x + Math.cos(around) * out,
            y + Math.sin(around) * out,
            pitch * filler.scale * grow * (0.78 + bits(hs, 8, 8) * 0.5),
            s + 1,
            remix(hs)
          );
        }
      }
    }
  }

  /**
   * The layout, at this moment.
   *
   * Everything time does to a print happens here: the gust rocks each motif,
   * the swell breathes it in and out, the shimmer takes the light across. None
   * of it moves anything, which is exactly why the packing above can be worked
   * out once and left alone.
   */
  function paint() {
    for (let i = 0; i < pack.n; i++) {
      const x = pack.mx[i];
      const y = pack.my[i];
      const wave = waveAt(x, y, pack.hash[i]);
      // Full is exactly touching, so Fill and the swell breathe *inwards* from
      // there and the guarantee holds at every moment rather than on average.
      const drawn = pack.size[i] * fill * ((1 + wave * swell) / (1 + swell));
      if (drawn < 1.5) continue;
      /**
       * Tested on what is about to be drawn rather than on what was collected.
       *
       * The packing has shrunk it since, and the swell has shrunk it again, so
       * a motif that reached out past a window reveal when it asked for its
       * place can be entirely behind the glass by the time it is stamped, and
       * that is the one thing this effect is not allowed to do.
       */
      if (hiddenByOpening(obstacles, x, y, drawn * 0.5)) continue;

      if (shimmer > 0) g.globalAlpha = alpha * (1 - shimmer * 0.5 * (1 - glintAt(x, y, t, breeze)));

      g.save();
      g.translate(x, y);
      g.rotate(pack.angle[i] + wave * wobble);
      if (pack.mirror[i]) g.scale(-1, 1);
      g.drawImage(pack.motif[i].canvas, -drawn / 2, -drawn / 2, drawn, drawn);
      g.restore();
    }
  }
}

/** Motifs a cell draws at the density somebody actually set, for the budget. */
function perCellFor(stable) {
  return 1 + Math.ceil(clamp(stable.density ?? 0, 0, 1) * MAX_SATELLITES);
}

/** The shimmer: a second wave, crossing in brightness rather than in angle. */
function glintAt(x, y, t, breeze) {
  return Math.sin(x * 0.0031 - y * 0.0057 + t * breeze * 0.9);
}

/**
 * Sprite resolution.
 *
 * Matched to how big the motif will be on the wall, then capped: a print is
 * stamped at whatever size the lattice asks for, and a 64-pixel flower blown up
 * to fill a 300-pixel cell is a soft flower. Rebaking on every nudge of the
 * size slider would be worse, so it is quantised — a motif never rebakes for a
 * change it could not show.
 */
function spritePx(size) {
  return clamp(Math.round((size * 1.5) / 32) * 32, 64, 256);
}

/**
 * The resolution to bake one motif at, given how much of a cell it fills.
 *
 * A dot is not baked at the resolution of a flower. Sizing each sprite to what
 * it will actually be drawn at is worth more than it looks: `drawImage` is a
 * filtered blit, so a sprite twice the size it is drawn costs four times the
 * fill rate for a picture nobody can tell apart, and a print is several hundred
 * of them a frame.
 */
function motifPx(px, scale) {
  return clamp(Math.round(px * scale), 16, 256);
}

/* ------------------------------------------------------------------ *
 * Ditsy flowers
 * ------------------------------------------------------------------ */

/**
 * One flower, filling its sprite.
 *
 * The centre is cut out rather than painted, which is worth a sentence. A
 * printed ditsy flower's centre is the ground showing through, not a white
 * disc — so a hole is both what the pattern is and what behaves correctly when
 * somebody turns the ground off to project onto bare brick, where a painted
 * centre would be a cream spot in mid-air and a hole is the wall.
 */
function flowerSprite(px, colour, petals) {
  const canvas = offscreen(px, px);
  const c = canvas.getContext('2d');
  const half = px / 2;
  const { dist, petal } = petalGeometry(half * 0.94, petals);
  c.translate(half, half);
  c.fillStyle = colour;
  for (let k = 0; k < petals; k++) tracePetal(c, dist, petal, (k / petals) * TAU);
  c.globalCompositeOperation = 'destination-out';
  c.beginPath();
  c.arc(0, 0, half * 0.3, 0, TAU);
  c.fill();
  return { canvas, spots: ROUND_FOOTPRINT };
}

/** One leaf, lying along the sprite's width. */
function leafSprite(px, colour) {
  const canvas = offscreen(px, px);
  const c = canvas.getContext('2d');
  c.translate(px * 0.06, px / 2);
  c.fillStyle = colour;
  leafPath(c, px * 0.88, px * 0.3);
  c.fill();
  return { canvas, spots: [[-0.24, 0, 0.16], [0.02, 0, 0.2], [0.28, 0, 0.14]] };
}

function bakeDitsy(stable) {
  const px = spritePx(stable.size);
  const list = [];
  // Three colours, and each of them big, middling and small — a real ditsy is
  // not one flower at one size, and the eye picks a single repeated size out of
  // a wall immediately.
  for (const colour of [stable.color, stable.color2, stable.color3]) {
    for (const scale of [1.02, 0.74, 0.46]) {
      list.push({ ...flowerSprite(motifPx(px, scale), colour, scale > 0.85 ? 5 : 6), scale });
    }
  }
  for (const scale of [0.78, 0.5]) {
    list.push({ ...leafSprite(motifPx(px, scale), stable.leaf), scale });
  }

  // Weighted by repetition: nine parts flower to two parts leaf, which is about
  // what the printed article does. Anything more even reads as foliage.
  //
  // One bag for every cell, because a ditsy is a scatter and not a layout — but
  // the small end of it is offered as filler too, so Density sprinkles buds and
  // leaves into the gaps without changing the flowers already there.
  return {
    list,
    pick: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    second: null,
    filler: [2, 5, 8, 10, 2, 5, 8],
  };
}

const ditsy = {
  id: 'ditsy',
  name: 'Ditsy Flowers',
  category: 'facade',
  scope: 'shape',
  description:
    'A small-scale floral print over a whole wall, scattered and rotated the way a real one is, cut around the windows rather than hung over them and packed so that no two flowers overlap. The breeze runs across the building as one wave, so the wall breathes.',
  params: [
    { key: 'color', type: 'color', label: 'Flower', default: '#b0553c' },
    { key: 'color2', type: 'color', label: 'Second flower', default: '#dda56b' },
    { key: 'color3', type: 'color', label: 'Third flower', default: '#e0c0b7' },
    { key: 'leaf', type: 'color', label: 'Leaves', default: '#93a37c' },
    { key: 'ground', type: 'color', label: 'Ground', default: '#f7f0e6' },
    /** Nought leaves the wall as it is and prints on it; one paints it out. */
    { key: 'groundLevel', type: 'range', label: 'Ground', default: 0.85, min: 0, max: 1, step: 0.01 },
    { key: 'size', type: 'range', label: 'Motif size', default: 120, min: 20, max: 600, step: 2 },
    /**
     * How much of its packed space a motif takes. One is a tessellation —
     * every motif exactly touching its neighbours — and anything less opens the
     * ground up without moving anything. The other one to bind to the level.
     */
    { key: 'fill', type: 'range', label: 'Fill', default: 1, min: 0.2, max: 1, step: 0.01 },
    /**
     * The fine ground between the bold motifs. Bind it to the level and the
     * pattern fills in as the music does.
     */
    { key: 'density', type: 'range', label: 'Density', default: 0.25, min: 0, max: 1, step: 0.01 },
    { key: 'scatter', type: 'range', label: 'Scatter', default: 0.55, min: 0, max: 1, step: 0.01 },
    { key: 'sway', type: 'range', label: 'Sway', default: 0.35, min: 0, max: 1, step: 0.01 },
    { key: 'swell', type: 'range', label: 'Swell', default: 0.12, min: 0, max: 1, step: 0.01 },
    { key: 'breeze', type: 'range', label: 'Breeze speed', default: 0.5, min: 0, max: 4, step: 0.01 },
    /** In turns, so a saw LFO across it comes round to where it started. */
    { key: 'phase', type: 'range', label: 'Gust phase', default: 0, min: 0, max: 1, step: 0.005 },
    { key: 'shimmer', type: 'range', label: 'Shimmer', default: 0.3, min: 0, max: 1, step: 0.01 },
    { key: 'drift', type: 'range', label: 'Drift', default: 0, min: -80, max: 80, step: 1 },
    OBSTACLE_PARAM,
    { key: 'seed', type: 'range', label: 'Seed', default: 1, min: 1, max: 99, step: 1 },
  ],
  init() {
    return { key: '', sheet: null };
  },
  draw({ g, p, shape, t, state, stable, shapes }) {
    const { bbox } = shape;
    if (bbox.w <= 2 || bbox.h <= 2) return;

    const key = [stable.color, stable.color2, stable.color3, stable.leaf, spritePx(stable.size)].join('|');
    if (state.key !== key) {
      state.key = key;
      state.sheet = bakeDitsy(stable);
    }

    stampPrint(g, {
      shape,
      obstacles: collectObstacles(shapes, p.obstacles, shape.id),
      sheet: state.sheet,
      state,
      t,
      p,
      perCell: perCellFor(stable),
    });
  },
};

/* ------------------------------------------------------------------ *
 * Paisley
 *
 * The boteh — the teardrop with the hooked tip — built as a centreline and a
 * width rather than as a path somebody nudged into shape by hand. That is not
 * purity: it is the only version where the curl of the tip and the fatness of
 * the body are two numbers you can turn, and where the row of seeds inside the
 * border can be *placed against the border* instead of being drawn to match it.
 * ------------------------------------------------------------------ */

const BOTEH_JOINTS = 26;

/**
 * The spine of a boteh, and how wide it is along its length.
 *
 * Unit length, starting at the middle of the bulb and pointing up. Two details
 * are the whole shape, and getting either wrong produces a bean:
 *
 * **The turn accelerates.** Curvature goes as the square of the distance from
 * the bulb, so the lower half stands almost straight and all of the hook
 * happens in the last third. Spreading the same total turn evenly bends the
 * body as well as the tip, and a boteh with a bent body is a comma.
 *
 * **The taper is late.** The body holds most of its width to halfway and then
 * runs out quickly. A linear taper is a carrot.
 */
function botehSpine(jx, jy, jw, curl, girth) {
  const n = jx.length;
  const step = 1 / (n - 1);
  let angle = -Math.PI / 2;
  let x = 0;
  let y = 0;
  for (let i = 0; i < n; i++) {
    const s = i / (n - 1);
    jx[i] = x;
    jy[i] = y;
    jw[i] = girth * Math.pow(1 - Math.pow(s, 1.7), 0.62);
    angle += 2 * curl * s * step;
    x += Math.cos(angle) * step;
    y += Math.sin(angle) * step;
  }
}

/** Unit normal at joint `i`, from the segment either side of it. */
function botehNormal(jx, jy, i, out) {
  const a = Math.max(0, i - 1);
  const b = Math.min(jx.length - 1, i + 1);
  const tx = jx[b] - jx[a];
  const ty = jy[b] - jy[a];
  const len = Math.hypot(tx, ty) || 1;
  out[0] = -ty / len;
  out[1] = tx / len;
}

/**
 * The outline: up one side, round the bottom, down the other.
 *
 * The bulb is an arc rather than more ribbon, because a ribbon whose width goes
 * to zero at both ends is a leaf. A boteh is a drop: round at one end, pointed
 * at the other.
 */
function traceBoteh(c, jx, jy, jw, n = jx.length) {
  const out = [0, 0];
  c.beginPath();
  c.moveTo(jx[n - 1], jy[n - 1]);
  for (let i = n - 2; i >= 0; i--) {
    botehNormal(jx, jy, i, out);
    c.lineTo(jx[i] + out[0] * jw[i], jy[i] + out[1] * jw[i]);
  }
  // The base normal points along +x, so the cap sweeps from there round the
  // bottom to -x — half a turn, in the direction that puts it below the bulb.
  c.arc(jx[0], jy[0], jw[0], 0, Math.PI, false);
  for (let i = 1; i < n; i++) {
    botehNormal(jx, jy, i, out);
    c.lineTo(jx[i] - out[0] * jw[i], jy[i] - out[1] * jw[i]);
  }
  c.closePath();
}

/** Where a traced boteh actually lies, so the sprite can be fitted to it. */
function botehBounds(jx, jy, jw) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < jx.length; i++) {
    const w = Math.max(jw[i], i === 0 ? jw[0] : 0);
    minX = Math.min(minX, jx[i] - w);
    maxX = Math.max(maxX, jx[i] + w);
    minY = Math.min(minY, jy[i] - w);
    maxY = Math.max(maxY, jy[i] + w);
  }
  return { minX, minY, maxX, maxY };
}

/**
 * A boteh with everything inside it.
 *
 * Two variants, and they are the two the printed article has: one open, where
 * the ground shows through the body, and one solid. Both take the same row of
 * seeds hugging the inside of the border, because that row is what your eye
 * reads as "paisley" from across a road — the silhouette alone reads as a
 * teardrop, and a teardrop is a raindrop.
 */
function botehSprite(px, { ink, light, filled, curl = 2.3, girth = 0.27 }) {
  const canvas = offscreen(px, px);
  const c = canvas.getContext('2d');
  const jx = new Float32Array(BOTEH_JOINTS);
  const jy = new Float32Array(BOTEH_JOINTS);
  const jw = new Float32Array(BOTEH_JOINTS);
  botehSpine(jx, jy, jw, curl, girth);

  const box = botehBounds(jx, jy, jw);
  const scale = px / Math.max(box.maxX - box.minX, box.maxY - box.minY);
  c.translate(px / 2, px / 2);
  c.scale(scale * 0.9, scale * 0.9);
  c.translate(-(box.minX + box.maxX) / 2, -(box.minY + box.maxY) / 2);

  // Line widths are in pre-scale units; dividing by the fit keeps every stroke
  // the same number of sprite pixels whatever shape it is drawn round.
  const hair = 3.4 / (scale * 0.9);
  const detail = filled ? ink : light;

  traceBoteh(c, jx, jy, jw);
  if (filled) {
    c.fillStyle = light;
    c.fill();
  }
  c.strokeStyle = ink;
  c.lineWidth = hair * 1.5;
  c.lineJoin = 'round';
  c.stroke();

  /**
   * The seeds: a row of little drops following the border all the way round,
   * one either side of the spine.
   *
   * This is what your eye actually reads as paisley from across a road — the
   * silhouette on its own is a raindrop, and a raindrop the size of a window is
   * a blob. Placing them against the *outline* rather than at a fixed radius is
   * the whole reason the spine exists: they thin out and close in as the body
   * narrows, which is what makes the row look drawn rather than stamped.
   */
  const out = [0, 0];
  c.fillStyle = ink;
  for (const side of [1, -1]) {
    let lastX = null;
    let lastY = null;
    for (let i = 1; i < BOTEH_JOINTS - 2; i++) {
      botehNormal(jx, jy, i, out);
      const r = jw[i] * 0.2;
      if (r < hair * 0.3) continue;
      const inset = jw[i] - r * 1.5 - hair * 0.6;
      const x = jx[i] + out[0] * inset * side;
      const y = jy[i] + out[1] * inset * side;
      /**
       * Spaced by how far apart they land, not by how many joints apart they
       * are.
       *
       * The inside of a hook is shorter than the outside — offset a curve
       * towards its centre and the points crowd together, and where the tip
       * turns hardest they cross over each other entirely. One seed per joint
       * therefore gives a tidy dotted line down the outer edge and a solid
       * black bar down the inner one, which is exactly what it looked like.
       */
      if (lastX !== null && Math.hypot(x - lastX, y - lastY) < r * 2.6) continue;
      lastX = x;
      lastY = y;
      c.beginPath();
      c.ellipse(x, y, r * 1.25, r, Math.atan2(out[1], out[0]) + Math.PI / 2, 0, TAU);
      c.fill();
    }
  }

  /**
   * And a small one of itself in the belly, which is what fills a real one — a
   * paisley is a paisley all the way down. In the reverse colour, so it reads
   * against the body whichever way round this variant is.
   */
  c.save();
  c.translate(jx[0], jy[0] + girth * 0.5);
  c.scale(0.26, 0.26);
  c.rotate(0.18);
  traceBoteh(c, jx, jy, jw);
  c.fillStyle = detail;
  c.fill();
  c.strokeStyle = ink;
  c.lineWidth = hair / 0.26;
  c.stroke();
  c.restore();

  /**
   * And its own footprint, taken off the spine it was drawn from rather than
   * guessed: three points down the length, each with the width the body
   * actually has there, in fractions of the stamped size.
   */
  const spots = [];
  const centreX = (box.minX + box.maxX) / 2;
  const centreY = (box.minY + box.maxY) / 2;
  const unit = (scale * 0.9) / px;
  for (const at of [0.06, 0.4, 0.72]) {
    const i = Math.round(at * (BOTEH_JOINTS - 1));
    spots.push([
      (jx[i] - centreX) * unit * 0.9,
      (jy[i] - centreY) * unit * 0.9,
      Math.max(jw[i], girth * 0.5) * unit * 1.15,
    ]);
  }

  return { canvas, spots };
}

/** The little rayed disc that fills the gaps between botehs. */
function sunSprite(px, ink, light) {
  const canvas = offscreen(px, px);
  const c = canvas.getContext('2d');
  const half = px / 2;
  c.translate(half, half);
  c.fillStyle = light;
  c.beginPath();
  c.arc(0, 0, half * 0.45, 0, TAU);
  c.fill();
  c.strokeStyle = ink;
  c.lineWidth = px * 0.055;
  c.stroke();
  c.lineCap = 'round';
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * TAU;
    c.beginPath();
    c.moveTo(Math.cos(a) * half * 0.6, Math.sin(a) * half * 0.6);
    c.lineTo(Math.cos(a) * half * 0.88, Math.sin(a) * half * 0.88);
    c.stroke();
  }
  c.fillStyle = ink;
  c.beginPath();
  c.ellipse(0, 0, half * 0.2, half * 0.28, 0, 0, TAU);
  c.fill();
  return { canvas, spots: ROUND_FOOTPRINT };
}

/** A dot. The quietest thing in the pattern and half of what makes it read. */
function dotSprite(px, colour) {
  const canvas = offscreen(px, px);
  const c = canvas.getContext('2d');
  c.fillStyle = colour;
  c.beginPath();
  c.arc(px / 2, px / 2, px * 0.42, 0, TAU);
  c.fill();
  return { canvas, spots: [[0, 0, 0.42]] };
}

/**
 * A rosette: the flower head a paisley print sets between its teardrops.
 *
 * Every print of this kind has one. The boteh is all curve and hook, and a page
 * of nothing but hooks reads as one motif photocopied — the rosette is radial
 * and symmetrical, so it gives the eye somewhere to rest and makes the
 * teardrops look chosen rather than repeated.
 */
function rosetteSprite(px, ink, light) {
  const canvas = offscreen(px, px);
  const c = canvas.getContext('2d');
  const half = px / 2;
  const hair = Math.max(1, px * 0.032);
  c.translate(half, half);
  c.lineJoin = 'round';
  c.lineWidth = hair;
  c.strokeStyle = ink;
  c.fillStyle = light;

  /**
   * Fat, round petals rather than thin pointed ones.
   *
   * A petal narrow enough to be a spike is mostly its own outline, so a rosette
   * drawn that way is a black cog with some cream showing through it — which is
   * what this was. The bulge has to be wide enough that the fill is the thing
   * you see and the ink is a line round it.
   */
  const petals = 8;
  for (let k = 0; k < petals; k++) {
    c.save();
    c.rotate((k / petals) * TAU);
    c.beginPath();
    c.moveTo(half * 0.2, 0);
    c.quadraticCurveTo(half * 0.5, -half * 0.44, half * 0.94, 0);
    c.quadraticCurveTo(half * 0.5, half * 0.44, half * 0.2, 0);
    c.closePath();
    c.fill();
    c.stroke();
    c.restore();
  }

  // The centre goes on last, over the inner ends of the petals, so they meet a
  // disc rather than each other.
  c.fillStyle = ink;
  c.beginPath();
  c.arc(0, 0, half * 0.26, 0, TAU);
  c.fill();
  c.fillStyle = light;
  c.beginPath();
  c.arc(0, 0, half * 0.11, 0, TAU);
  c.fill();
  return { canvas, spots: ROUND_FOOTPRINT };
}

/** A frond: the same leaf the bunch grows, given an outline and its veins. */
function frondSprite(px, ink, light) {
  const canvas = offscreen(px, px);
  const c = canvas.getContext('2d');
  const len = px * 0.9;
  const wide = px * 0.21;
  const hair = Math.max(1, px * 0.05);
  c.translate(px * 0.05, px / 2);
  c.lineJoin = 'round';
  c.lineCap = 'round';
  c.fillStyle = light;
  c.strokeStyle = ink;
  c.lineWidth = hair;
  leafPath(c, len, wide);
  c.fill();
  c.stroke();

  c.lineWidth = hair * 0.5;
  c.beginPath();
  c.moveTo(len * 0.05, 0);
  c.lineTo(len * 0.93, 0);
  for (let k = 1; k <= 3; k++) {
    const at = len * (0.2 + k * 0.18);
    const rib = wide * (1 - k * 0.2) * 0.6;
    c.moveTo(at, 0);
    c.lineTo(at + len * 0.12, -rib);
    c.moveTo(at, 0);
    c.lineTo(at + len * 0.12, rib);
  }
  c.stroke();
  // Along the leaf, which is half as wide as it is long.
  return { canvas, spots: [[-0.22, 0, 0.19], [0.05, 0, 0.24], [0.3, 0, 0.17]] };
}

/** A tendril: a curl of vine, and the quietest thing in the bag. */
function tendrilSprite(px, ink) {
  const canvas = offscreen(px, px);
  const c = canvas.getContext('2d');
  const half = px / 2;
  c.translate(half, half);
  c.strokeStyle = ink;
  c.fillStyle = ink;
  c.lineWidth = Math.max(1, px * 0.075);
  c.lineCap = 'round';
  c.beginPath();
  for (let i = 0; i <= 36; i++) {
    const s = i / 36;
    const a = s * TAU * 1.35;
    const r = half * (0.08 + s * 0.76);
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) c.moveTo(x, y);
    else c.lineTo(x, y);
  }
  c.stroke();
  c.beginPath();
  c.arc(half * 0.08, 0, px * 0.055, 0, TAU);
  c.fill();
  return { canvas, spots: ROUND_FOOTPRINT };
}

function bakePaisley(stable) {
  const px = spritePx(stable.size);
  const { ink, light } = stable;
  const boteh = (scale, extra) => ({ ...botehSprite(motifPx(px, scale), { ink, light, ...extra }), scale });
  const rosette = (scale) => ({ ...rosetteSprite(motifPx(px, scale), ink, light), scale });
  const frond = (scale) => ({ ...frondSprite(motifPx(px, scale), ink, light), scale });

  /**
   * Sizes that reach each other.
   *
   * A motif is measured against the pitch, and these are deliberately over one
   * — a bold teardrop is wider than the cell it belongs to. That is what makes
   * the print a print: the packing takes the excess back and leaves every motif
   * exactly touching its neighbours, so what decides the size is the layout
   * rather than a number somebody typed. Ask for less than the lattice can hold
   * and nothing ever meets, which reads as a page of stickers.
   */
  const list = [
    /* 0 */ boteh(1.34, { filled: false }),
    /* 1 */ boteh(1.34, { filled: true, curl: 2.6, girth: 0.25 }),
    /* 2 */ rosette(0.86),
    /* 3 */ boteh(0.88, { filled: false, curl: 2, girth: 0.3 }),
    /* 4 */ boteh(0.8, { filled: true }),
    /* 5 */ frond(0.94),
    /* 6 */ rosette(0.48),
    /* 7 */ boteh(0.46, { filled: false }),
    /* 8 */ boteh(0.4, { filled: true, curl: 2.6, girth: 0.25 }),
    /* 9 */ frond(0.48),
    /* 10 */ { ...tendrilSprite(motifPx(px, 0.42), ink), scale: 0.42 },
    /* 11 */ { ...sunSprite(motifPx(px, 0.36), ink, light), scale: 0.36 },
    /* 12 */ { ...dotSprite(motifPx(px, 0.12), ink), scale: 0.12 },
    /* 13 */ { ...dotSprite(motifPx(px, 0.07), ink), scale: 0.07 },
  ];

  /**
   * Three tiers off one lattice.
   *
   * The bold teardrops take every other cell with the odd rosette among them,
   * the middling ones take the cells between, and the fine ground — small
   * botehs, fronds, tendrils, suns and dots — is scattered round all of them by
   * **Density**. That layering is the whole difference between a paisley and a
   * page of teardrops: at any distance you are meant to read a bold repeat
   * first and find that the space between it is not empty.
   */
  return {
    list,
    pick: [0, 1, 0, 1, 2, 0],
    second: [3, 4, 2, 5, 3, 4],
    filler: [6, 7, 8, 9, 10, 11, 12, 13, 12, 13, 7, 10],
  };
}

const paisley = {
  id: 'paisley',
  name: 'Paisley',
  category: 'facade',
  scope: 'shape',
  description:
    'Botehs in a half-drop repeat, with rosettes, fronds, tendrils and dots packed into the ground between them. Nothing overlaps: the motifs are sized by the space around them, so what fills a wall is a layout rather than a scatter. Turn the size right up and one teardrop covers the front of the house.',
  params: [
    { key: 'ink', type: 'color', label: 'Ink', default: '#171310' },
    { key: 'light', type: 'color', label: 'Highlight', default: '#faf3e7' },
    { key: 'ground', type: 'color', label: 'Ground', default: '#d9c8a7' },
    { key: 'groundLevel', type: 'range', label: 'Ground', default: 0.9, min: 0, max: 1, step: 0.01 },
    { key: 'size', type: 'range', label: 'Motif size', default: 300, min: 40, max: 900, step: 5 },
    /**
     * How much of its packed space a motif takes. One is a tessellation —
     * every motif exactly touching its neighbours — and anything less opens the
     * ground up without moving anything. The other one to bind to the level.
     */
    { key: 'fill', type: 'range', label: 'Fill', default: 1, min: 0.2, max: 1, step: 0.01 },
    /**
     * The fine ground between the bold motifs. Bind it to the level and the
     * pattern fills in as the music does.
     */
    { key: 'density', type: 'range', label: 'Density', default: 0.75, min: 0, max: 1, step: 0.01 },
    { key: 'scatter', type: 'range', label: 'Scatter', default: 0.22, min: 0, max: 1, step: 0.01 },
    { key: 'sway', type: 'range', label: 'Sway', default: 0.3, min: 0, max: 1, step: 0.01 },
    { key: 'swell', type: 'range', label: 'Swell', default: 0.12, min: 0, max: 1, step: 0.01 },
    { key: 'breeze', type: 'range', label: 'Breeze speed', default: 0.4, min: 0, max: 4, step: 0.01 },
    /** In turns, so a saw LFO across it comes round to where it started. */
    { key: 'phase', type: 'range', label: 'Gust phase', default: 0, min: 0, max: 1, step: 0.005 },
    /** Also in turns: every motif, turned together. */
    { key: 'turn', type: 'range', label: 'Turn', default: 0, min: -1, max: 1, step: 0.005 },
    { key: 'shimmer', type: 'range', label: 'Shimmer', default: 0.35, min: 0, max: 1, step: 0.01 },
    { key: 'drift', type: 'range', label: 'Drift', default: 0, min: -80, max: 80, step: 1 },
    OBSTACLE_PARAM,
    { key: 'seed', type: 'range', label: 'Seed', default: 1, min: 1, max: 99, step: 1 },
  ],
  init() {
    return { key: '', sheet: null };
  },
  draw({ g, p, shape, t, state, stable, shapes }) {
    const { bbox } = shape;
    if (bbox.w <= 2 || bbox.h <= 2) return;

    const key = [stable.ink, stable.light, spritePx(stable.size)].join('|');
    if (state.key !== key) {
      state.key = key;
      state.sheet = bakePaisley(stable);
    }

    stampPrint(g, {
      shape,
      obstacles: collectObstacles(shapes, p.obstacles, shape.id),
      sheet: state.sheet,
      state,
      t,
      p,
      perCell: perCellFor(stable),
      halfDrop: true,
      // Six directions and a little jitter: deliberate rather than tossed.
      facets: 6,
      // And nearly all one size. A print this formal is not a scatter.
      vary: 0.26,
    });
  },
};

export default [flowers, ditsy, paisley];
