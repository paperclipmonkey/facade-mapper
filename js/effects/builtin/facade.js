/**
 * Effects that know where the windows are.
 *
 * Every other effect in the library is given a shape and fills it. These are
 * given a shape to move *around in*, and a list of shapes to treat as solid.
 * Point one at the wall, tell it the windows and the door are in the way, and
 * it will keep off them.
 *
 * That is a small change in plumbing and a large one in how the result reads.
 * A ball crossing a facade is a video; a ball that ricochets off the top of the
 * bay window is on the house. The brain will accept almost any amount of
 * stylisation as long as the light behaves as though the building is there, and
 * refuses the most photographic effect in the world when it does not. All three
 * effects here are built on that single observation.
 *
 * The collision model lives in js/effects/obstacles.js and is available to your
 * own effects through `fx`.
 */

import { rgba, clamp, lerp, TAU, mixHex } from '../../core/math.js';
import { blackbodyBytes } from '../color.js';
import {
  collectObstacles,
  deflect,
  isClear,
  findFreeSpot,
  nearestSurface,
} from '../obstacles.js';
import { glow, offscreen } from '../lib.js';

/** Where the obstacle list is spelled out. Shared so the wording stays consistent. */
const OBSTACLE_PARAM = {
  key: 'obstacles',
  type: 'text',
  label: 'Solid tags',
  default: 'window, door',
};

/** The point on a shape's outline furthest down — where things climb from. */
function groundPoint(container, rng, samples = 9) {
  let best = null;
  for (let i = 0; i < samples; i++) {
    const at = container.sampler.at(rng());
    if (!best || at.y > best.y) best = at;
  }
  return best || { x: container.bbox.cx, y: container.bbox.y + container.bbox.h };
}

/** Shortest signed difference between two angles. */
function angleDelta(from, to) {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/* ------------------------------------------------------------------ *
 * Bouncing balls
 * ------------------------------------------------------------------ */

const bounce = {
  id: 'bounce',
  name: 'Bouncing Balls',
  category: 'facade',
  scope: 'shape',
  description:
    'Balls loose on the wall, ricocheting off the windows and doors and kept inside the shape you point them at. Add gravity and they fall, bounce off the sills and settle.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#ff9d3c' },
    { key: 'color2', type: 'color', label: 'Second colour', default: '#4cc2ff' },
    { key: 'count', type: 'range', label: 'Balls', default: 12, min: 1, max: 60, step: 1 },
    { key: 'size', type: 'range', label: 'Radius', default: 14, min: 2, max: 90, step: 0.5 },
    { key: 'speed', type: 'range', label: 'Speed', default: 260, min: 20, max: 1400, step: 10 },
    { key: 'gravity', type: 'range', label: 'Gravity', default: 0, min: 0, max: 2500, step: 10 },
    { key: 'restitution', type: 'range', label: 'Bounciness', default: 0.96, min: 0.3, max: 1, step: 0.01 },
    { key: 'liveliness', type: 'range', label: 'Liveliness', default: 0.3, min: 0, max: 1, step: 0.01 },
    OBSTACLE_PARAM,
    { key: 'trail', type: 'range', label: 'Trail', default: 0.45, min: 0, max: 1, step: 0.01 },
    { key: 'glow', type: 'range', label: 'Glow', default: 1.6, min: 0, max: 4, step: 0.05 },
  ],
  init() {
    return { balls: [] };
  },
  step({ p, shape, dt, rng, state, shapes }) {
    const container = shape;
    if (container.bbox.w <= 2 || container.bbox.h <= 2) return;

    const obstacles = collectObstacles(shapes, p.obstacles, container.id);
    const radius = Math.max(1, p.size);
    const target = Math.round(clamp(p.count, 1, 60));

    while (state.balls.length < target) {
      const spot = findFreeSpot(container, obstacles, rng);
      const a = rng() * TAU;
      state.balls.push({
        x: spot.x,
        y: spot.y,
        vx: Math.cos(a) * p.speed,
        vy: Math.sin(a) * p.speed,
        tint: rng(),
        trail: [],
      });
    }
    if (state.balls.length > target) state.balls.length = target;

    // Fixed by the renderer, so a ball can no longer be teleported through a
    // window by a tab that was backgrounded — the step is the same length every
    // time regardless of how long the frame took.
    const step = dt;
    const trailLength = Math.round(2 + p.trail * 16);

    /**
     * Enough substeps that no ball moves further than its own radius between
     * collision tests.
     *
     * Contact is detected as "within a radius of the surface", so a ball that
     * covers more than that in one step can arrive on the far side of a pane
     * having never been near it, and sails straight through the window — the
     * exact thing this effect exists not to do. Recovering afterwards is not
     * possible in general: once it is deep inside, the nearest way out is not
     * the way it came in. So it is prevented instead, and only at the speeds
     * that need it.
     */
    const fastest = state.balls.reduce((max, b) => Math.max(max, Math.hypot(b.vx, b.vy)), 0)
      + p.gravity * step;
    const sub = Math.min(8, Math.max(1, Math.ceil((fastest * step) / (radius * 0.6))));
    const h = step / sub;

    for (const b of state.balls) {
      for (let s = 0; s < sub; s++) {
        b.vy += p.gravity * h;
        b.x += b.vx * h;
        b.y += b.vy * h;

        deflect(container.points, b, radius, p.restitution, true);
        for (const o of obstacles) {
          const { bbox } = o;
          // Cheap rejection first: most balls are nowhere near most windows.
          if (
            b.x < bbox.x - radius
            || b.x > bbox.x + bbox.w + radius
            || b.y < bbox.y - radius
            || b.y > bbox.y + bbox.h + radius
          ) continue;
          deflect(o.points, b, radius, p.restitution, false);
        }
      }

      // Bounciness below 1 plus gravity means everything eventually parks on a
      // sill, which is correct physics and dull to look at. A nudge now and
      // then keeps the wall alive without pretending the collisions are elastic.
      const speed = Math.hypot(b.vx, b.vy);
      if (p.liveliness > 0 && rng() < p.liveliness * step * 2.5) {
        const kick = p.speed * (0.3 + rng() * 0.5);
        const a = rng() * TAU;
        b.vx += Math.cos(a) * kick;
        b.vy += Math.sin(a) * kick * (p.gravity > 0 ? -0.8 : 1);
      }
      // Runaway guard: repeated kicks and near-elastic bounces can compound.
      const cap = p.speed * 3;
      if (speed > cap) {
        b.vx *= cap / speed;
        b.vy *= cap / speed;
      }

      b.trail.push(b.x, b.y);
      if (b.trail.length > trailLength * 2) b.trail.splice(0, b.trail.length - trailLength * 2);
    }
  },
  draw({ g, p, shape, state }) {
    const container = shape;
    if (container.bbox.w <= 2 || container.bbox.h <= 2) return;
    const radius = Math.max(1, p.size);

    g.save();
    g.clip(container.path);
    g.globalCompositeOperation = 'lighter';

    for (const b of state.balls) {
      const colour = mixHex(p.color, p.color2, b.tint);

      if (p.trail > 0 && b.trail.length >= 4) {
        g.strokeStyle = rgba(colour, 0.22 * p.trail);
        g.lineWidth = radius * 0.9;
        g.lineCap = 'round';
        g.lineJoin = 'round';
        g.beginPath();
        g.moveTo(b.trail[0], b.trail[1]);
        for (let i = 2; i < b.trail.length; i += 2) g.lineTo(b.trail[i], b.trail[i + 1]);
        g.stroke();
      }

      if (p.glow > 0) glow(g, b.x, b.y, radius * (1.8 + p.glow * 2.2), colour, 0.55);

      const core = g.createRadialGradient(
        b.x - radius * 0.3,
        b.y - radius * 0.3,
        0,
        b.x,
        b.y,
        radius
      );
      core.addColorStop(0, '#ffffff');
      core.addColorStop(0.35, colour);
      core.addColorStop(1, rgba(colour, 0.15));
      g.fillStyle = core;
      g.beginPath();
      g.arc(b.x, b.y, radius, 0, TAU);
      g.fill();
    }

    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * Serpent
 * ------------------------------------------------------------------ */

/**
 * How far a ray gets before it leaves the wall or meets a window, as a fraction
 * of the distance looked. Sampled rather than solved: the region is a traced
 * polygon minus several other traced polygons, and marching it is both simpler
 * and easier to reason about than intersecting it.
 */
function rayClearance(container, obstacles, x, y, angle, look, steps = 5) {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  for (let i = 1; i <= steps; i++) {
    const f = i / steps;
    if (!isClear(container, obstacles, x + dx * look * f, y + dy * look * f)) {
      return (i - 1) / steps;
    }
  }
  return 1;
}

const serpent = {
  id: 'serpent',
  name: 'Serpent',
  category: 'facade',
  scope: 'shape',
  description:
    'A snake that explores the wall, steering around the windows and doors rather than crossing them. Long and slow reads as a python; short and quick as something scuttling.',
  params: [
    { key: 'color', type: 'color', label: 'Head', default: '#7bf58a' },
    { key: 'color2', type: 'color', label: 'Tail', default: '#0b3a1c' },
    { key: 'count', type: 'range', label: 'Snakes', default: 2, min: 1, max: 8, step: 1 },
    { key: 'length', type: 'range', label: 'Length', default: 380, min: 60, max: 1600, step: 10 },
    { key: 'thickness', type: 'range', label: 'Thickness', default: 22, min: 2, max: 90, step: 0.5 },
    { key: 'speed', type: 'range', label: 'Speed', default: 190, min: 20, max: 900, step: 5 },
    { key: 'wander', type: 'range', label: 'Wander', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'slither', type: 'range', label: 'Slither', default: 0.6, min: 0, max: 2, step: 0.01 },
    { key: 'look', type: 'range', label: 'Look ahead', default: 120, min: 20, max: 500, step: 5 },
    OBSTACLE_PARAM,
    { key: 'glow', type: 'range', label: 'Glow', default: 1, min: 0, max: 4, step: 0.05 },
    { key: 'eyes', type: 'bool', label: 'Eyes', default: true },
  ],
  init() {
    return { snakes: [] };
  },
  step({ p, shape, t, dt, rng, state, shapes, noise }) {
    const container = shape;
    if (container.bbox.w <= 2 || container.bbox.h <= 2) return;

    const obstacles = collectObstacles(shapes, p.obstacles, container.id);
    const target = Math.round(clamp(p.count, 1, 8));
    const half = Math.max(1, p.thickness) / 2;
    const sample = Math.max(3, half * 0.55);
    const samples = Math.max(4, Math.round(p.length / sample));

    while (state.snakes.length < target) {
      const spot = findFreeSpot(container, obstacles, rng);
      state.snakes.push({
        x: spot.x,
        y: spot.y,
        angle: rng() * TAU,
        seed: rng() * 1000,
        /** Which way it decided to go round the thing in front of it. */
        turn: 0,
        hist: [{ x: spot.x, y: spot.y }],
      });
    }
    if (state.snakes.length > target) state.snakes.length = target;

    // Fixed by the renderer, so the path a snake crawls is a property of the
    // show rather than of how fast the tab happened to be drawing.
    const step = dt;

    for (const s of state.snakes) {
      /* --- steer --- */
      // Wall-following rather than best-of-N headings. Picking the best of a
      // fan of candidate rays every frame looks reasonable and behaves badly:
      // in a corner the best candidate flips from side to side, the snake
      // oscillates on the spot and folds back over its own body. Committing to
      // one turn direction for the whole encounter and holding it until the way
      // ahead is clear is both simpler and what an animal does.
      const look = Math.max(p.look, half * 3);
      const ahead = rayClearance(container, obstacles, s.x, s.y, s.angle, look);
      if (ahead > 0.99) {
        s.turn = 0;
        s.angle += noise.noise2(t * 0.35 + s.seed, s.seed) * p.wander * step * 2.5;
      } else {
        if (!s.turn) {
          const left = rayClearance(container, obstacles, s.x, s.y, s.angle - 0.9, look);
          const right = rayClearance(container, obstacles, s.x, s.y, s.angle + 0.9, look);
          s.turn = right >= left ? 1 : -1;
        }
        // Turn harder the closer the obstruction, so a glancing approach curves
        // away and a head-on one whips round.
        s.angle += s.turn * (1.2 + (1 - ahead) * 3.6) * step;
      }

      /* --- move --- */
      // The lateral wave is applied to the path, not to the body, so the whole
      // snake follows the same track — which is what makes it look like one
      // animal rather than a wobbling worm. Kept modest: a big swing steers the
      // head into walls the clearance probe just said were clear.
      const wave = Math.sin(t * 4 + s.seed) * p.slither * 0.35;
      const heading = s.angle + wave;
      s.x += Math.cos(heading) * p.speed * step;
      s.y += Math.sin(heading) * p.speed * step;

      const m = { x: s.x, y: s.y, vx: Math.cos(heading), vy: Math.sin(heading) };
      let hit = deflect(container.points, m, half, 1, true);
      for (const o of obstacles) hit = deflect(o.points, m, half, 1, false) || hit;
      if (hit) {
        s.x = m.x;
        s.y = m.y;
        s.angle = Math.atan2(m.vy, m.vx);
      }

      const last = s.hist[0];
      if (!last || Math.hypot(s.x - last.x, s.y - last.y) >= sample) {
        s.hist.unshift({ x: s.x, y: s.y });
        if (s.hist.length > samples) s.hist.length = samples;
      }
    }
  },
  draw({ g, p, shape, t, state }) {
    const container = shape;
    if (container.bbox.w <= 2 || container.bbox.h <= 2) return;
    const half = Math.max(1, p.thickness) / 2;

    g.save();
    g.clip(container.path);

    for (const s of state.snakes) {
      const body = s.hist;
      if (body.length < 3) continue;
      const n = body.length;

      const outline = [];
      const back = [];
      for (let i = 0; i < n; i++) {
        const a = body[Math.max(0, i - 1)];
        const b = body[Math.min(n - 1, i + 1)];
        const tx = b.x - a.x;
        const ty = b.y - a.y;
        const len = Math.hypot(tx, ty) || 1;
        const nx = -ty / len;
        const ny = tx / len;
        const u = i / (n - 1);
        // Elliptical taper: full at the head, to a point at the tail.
        const w = half * Math.sqrt(Math.max(0, 1 - u * u));
        outline.push({ x: body[i].x + nx * w, y: body[i].y + ny * w });
        back.push({ x: body[i].x - nx * w, y: body[i].y - ny * w });
      }

      const path = new Path2D();
      path.moveTo(outline[0].x, outline[0].y);
      for (let i = 1; i < outline.length; i++) path.lineTo(outline[i].x, outline[i].y);
      for (let i = back.length - 1; i >= 0; i--) path.lineTo(back[i].x, back[i].y);
      path.closePath();

      const tail = body[n - 1];
      const skin = g.createLinearGradient(body[0].x, body[0].y, tail.x, tail.y);
      skin.addColorStop(0, p.color);
      skin.addColorStop(1, p.color2);

      if (p.glow > 0) {
        g.save();
        g.globalCompositeOperation = 'lighter';
        g.strokeStyle = rgba(p.color, 0.1 * p.glow);
        g.lineWidth = half * 2 + p.thickness * p.glow * 0.5;
        g.lineJoin = 'round';
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(body[0].x, body[0].y);
        for (let i = 1; i < n; i++) g.lineTo(body[i].x, body[i].y);
        g.stroke();
        g.restore();
      }

      g.fillStyle = skin;
      g.fill(path);

      if (p.eyes) {
        const a = body[0];
        const b = body[Math.min(n - 1, 2)];
        const len = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const fx = (a.x - b.x) / len;
        const fy = (a.y - b.y) / len;
        const ex = -fy;
        const ey = fx;
        g.fillStyle = '#0b0006';
        for (const sideSign of [1, -1]) {
          g.beginPath();
          g.arc(
            a.x + fx * half * 0.15 + ex * half * 0.42 * sideSign,
            a.y + fy * half * 0.15 + ey * half * 0.42 * sideSign,
            Math.max(0.8, half * 0.17),
            0,
            TAU
          );
          g.fill();
        }
      }
    }

    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * Creeping vine
 * ------------------------------------------------------------------ */

const VINE_STEPS_PER_FRAME = 26;

/**
 * Growth that spreads across a wall and goes *round* the openings.
 *
 * Three things make it read as something living on the building rather than a
 * pattern projected onto it.
 *
 * A tip that comes near a window does not merely turn away from it — it turns
 * onto the window's tangent and runs along the frame, letting go as the surface
 * curves out from under it. That is what mould and ivy actually do at a
 * boundary, and it is why the result traces the joinery you traced.
 *
 * It knows where it has already been. A pure wander plus a climb bias produces
 * a rope of growth up one part of the wall and along the roofline, with the
 * rest left bare — every tip follows the same bias into the same corner, and
 * nothing ever pulls it back to the empty parts. A coarse visit grid fixes
 * that: tips steer towards the emptiest ground within reach, dead tips are
 * replaced from wherever the existing growth borders bare wall, and untouched
 * openings exert a weak pull until something has wrapped them. That is the
 * difference between ivy on one corner of a house and ivy over a house.
 *
 * And growth is permanent, so it accumulates into a bitmap: only the few
 * centimetres added this frame are ever stroked. A wall covered in ivy costs
 * one drawImage, which is the only reason this can run alongside everything
 * else in a show.
 */
const vine = {
  id: 'vine',
  name: 'Creeping Vine',
  category: 'facade',
  scope: 'shape',
  description:
    'Ivy — or mould, or veins — spreading over the whole wall and creeping around the window frames instead of over them. Seeks out bare brick and wraps every opening it finds.',
  params: [
    { key: 'color', type: 'color', label: 'Growth', default: '#2f6b32' },
    { key: 'tip', type: 'color', label: 'New shoots', default: '#8fe36b' },
    { key: 'tips', type: 'range', label: 'Growing tips', default: 6, min: 1, max: 24, step: 1 },
    { key: 'speed', type: 'range', label: 'Growth speed', default: 90, min: 5, max: 400, step: 5 },
    { key: 'thickness', type: 'range', label: 'Thickness', default: 3.5, min: 0.5, max: 20, step: 0.1 },
    { key: 'branch', type: 'range', label: 'Branching', default: 0.45, min: 0, max: 1, step: 0.01 },
    { key: 'wander', type: 'range', label: 'Wander', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'climb', type: 'range', label: 'Climb', default: 0.3, min: -1, max: 1, step: 0.01 },
    { key: 'spread', type: 'range', label: 'Seek bare wall', default: 0.7, min: 0, max: 1, step: 0.01 },
    { key: 'cling', type: 'range', label: 'Cling to frames', default: 0.75, min: 0, max: 1, step: 0.01 },
    { key: 'seek', type: 'range', label: 'Seek out openings', default: 0.6, min: 0, max: 1, step: 0.01 },
    { key: 'coverage', type: 'range', label: 'Coverage', default: 0.5, min: 0.02, max: 1, step: 0.01 },
    // The two that make it a living thing rather than a texture. Wither is the
    // one to reach for: it turns the coverage budget into a level the plant
    // lives at, with new shoots replacing the oldest growth for ever.
    { key: 'wither', type: 'range', label: 'Wither', default: 0.25, min: 0, max: 1, step: 0.01 },
    { key: 'regrow', type: 'range', label: 'Start again after (s)', default: 0, min: 0, max: 600, step: 5 },
    { key: 'leaves', type: 'range', label: 'Leaves', default: 0.4, min: 0, max: 1, step: 0.01 },
    OBSTACLE_PARAM,
    { key: 'shootGlow', type: 'range', label: 'Shoot glow', default: 1, min: 0, max: 4, step: 0.05 },
  ],
  init() {
    return { key: '', tips: [], grown: 0 };
  },
  step({ p, shape, t, dt, rng, state, shapes, stable }) {
    const container = shape;
    const { bbox } = container;
    if (bbox.w <= 2 || bbox.h <= 2) return;

    const obstacles = collectObstacles(shapes, p.obstacles, container.id);

    /**
     * Only geometry and drawing width invalidate what has already been grown;
     * speed, branching and the rest can change mid-show without starting over.
     *
     * Built from `stable` — the parameters *before* modulation — and not from
     * `p`. Bind thickness to the microphone and `p.thickness` is a different
     * number every frame, so a key that included it would throw away a
     * megabyte of grown ivy and start again sixty times a second. That is not a
     * hypothetical: it is what "the app goes very slowly after linking an
     * effect to the microphone" turned out to be.
     */
    const key = [
      container.id,
      Math.round(bbox.w),
      Math.round(bbox.h),
      stable.color,
      stable.tip,
      Number(stable.thickness).toFixed(1),
    ].join('|');
    if (state.key !== key) {
      state.key = key;
      const scale = Math.min(1, 900 / Math.max(bbox.w, bbox.h));
      state.scale = scale;
      state.canvas = offscreen(bbox.w * scale, bbox.h * scale);
      state.ctx = state.canvas.getContext('2d');
      state.ctx.setTransform(scale, 0, 0, scale, -bbox.x * scale, -bbox.y * scale);
      state.ctx.lineCap = 'round';
      state.tips = [];
      state.grown = 0;

      // Where it has been. Cells are a few vine-widths across — fine enough to
      // tell "covered" from "bare", coarse enough that a whole facade is a few
      // thousand bytes and scanning it for the emptiest spot is free.
      const cellSize = Math.max(10, stable.thickness * 5);
      state.cell = cellSize;
      state.cols = Math.max(1, Math.ceil(bbox.w / cellSize));
      state.rows = Math.max(1, Math.ceil(bbox.h / cellSize));
      state.visits = new Uint16Array(state.cols * state.rows);
      /** Points on existing growth, as candidates to sprout a new runner from. */
      state.seeds = [];
      state.sinceSeed = 0;
      /** Sub-step growth carried over from the last frame. */
      state.carry = 0;
      /** Openings something has already reached, so the pull towards them stops. */
      state.wrapped = new Set();
      state.plantedAt = t;
    }

    const c = state.ctx;

    /**
     * Start again from bare wall.
     *
     * Everything that remembers where the plant has been has to go together —
     * the bitmap, the length grown, the live tips, the visit grid, the sprout
     * candidates and the set of openings already wrapped. Miss one and the new
     * growth inherits the old one's opinions: tips that think the wall is
     * already covered, or that every window has been visited.
     */
    const replant = () => {
      c.save();
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, state.canvas.width, state.canvas.height);
      c.restore();
      state.tips.length = 0;
      state.grown = 0;
      state.visits.fill(0);
      state.seeds.length = 0;
      state.sinceSeed = 0;
      state.carry = 0;
      state.wrapped.clear();
      state.plantedAt = t;
    };

    // A hard cycle, for a show that wants the wall to be taken over, cleared,
    // and taken over again. Off by default; `wither` is the gentler version.
    if (p.regrow > 0 && t - state.plantedAt > p.regrow) replant();

    /**
     * Withering.
     *
     * Without it the vine grows to its coverage budget and then simply stops,
     * which is the one thing a living thing never does — you get a static
     * texture that happens to have arrived by animation. Fading the accumulated
     * bitmap continuously turns the same machinery into a steady state: new
     * shoots add at the head while the oldest growth dies back, so the wall
     * keeps changing all evening without ever filling in solid.
     *
     * `grown` decays at the same rate as the picture, which is what makes the
     * coverage budget behave as a ceiling the plant lives at rather than a
     * finish line it crosses once. Tips retired at the ceiling are respawned by
     * the block below as soon as decay makes room, so the cycle needs no
     * bookkeeping of its own.
     */
    if (p.wither > 0) {
      const lost = clamp(p.wither * 0.06 * Math.min(dt, 1 / 30), 0, 0.2);
      c.save();
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalCompositeOperation = 'destination-out';
      c.fillStyle = `rgba(0,0,0,${lost})`;
      c.fillRect(0, 0, state.canvas.width, state.canvas.height);
      c.restore();
      state.grown *= 1 - lost;

      // The visit grid has to forget too, or tips keep avoiding wall that has
      // long since gone bare again.
      state.sinceForget = (state.sinceForget || 0) + dt;
      if (state.sinceForget > 2) {
        state.sinceForget = 0;
        for (let i = 0; i < state.visits.length; i++) state.visits[i] = (state.visits[i] * 0.7) | 0;
        if (state.seeds.length > 120) state.seeds.splice(0, state.seeds.length - 120);
      }
    }
    const stepPx = Math.max(2, p.thickness * 0.7);
    // A length budget rather than an area test: how much vine it takes to cover
    // a wall is length × width, so dividing the area by the width gives a
    // coverage control that means the same thing at any thickness.
    const budget = (clamp(p.coverage, 0.02, 1) * bbox.w * bbox.h) / Math.max(2, p.thickness * 2.4);

    const cellIndex = (x, y) => {
      const cx = Math.floor((x - bbox.x) / state.cell);
      const cy = Math.floor((y - bbox.y) / state.cell);
      if (cx < 0 || cy < 0 || cx >= state.cols || cy >= state.rows) return -1;
      return cy * state.cols + cx;
    };
    /**
     * How thoroughly a spot has been grown over, capped.
     *
     * Capped because the raw count keeps climbing wherever the vine doubles
     * back, and an uncapped score would make one heavily-worked corner
     * outweigh every genuinely bare cell put together. Off the grid reads as
     * "busy" so nothing steers off the wall, but with a finite value — an
     * infinity there would swamp the comparison the same way.
     */
    const visitsAt = (x, y) => {
      const i = cellIndex(x, y);
      return i < 0 ? 40 : Math.min(24, state.visits[i]);
    };

    // Runners are deliberately short-lived. A tip that lives forever keeps
    // thickening the patch it is already in; retiring it and sprouting a
    // replacement from the barest edge of the growth is what moves the plant
    // onto new wall.
    const newTip = (x, y, angle, width = 1) => ({
      x,
      y,
      angle,
      width,
      life: (bbox.w + bbox.h) * (0.15 + rng() * 0.35),
      sinceLeaf: 0,
      tint: rng(),
      /** How brightly this shoot is lit, eased so it never pops on or off. */
      glow: 0,
      /** Finished growing. Kept in the list until it has faded out. */
      dead: false,
      retiring: false,
    });

    /**
     * A new runner, from the bare-est piece of wall the growth already touches.
     *
     * Sprouting from existing growth rather than teleporting somewhere empty is
     * both how a plant actually spreads and what keeps the result connected;
     * choosing the emptiest of a handful of candidates is what stops it piling
     * up where it already is.
     */
    const spawn = () => {
      if (!state.seeds.length || rng() < 0.25) {
        const at = groundPoint(container, rng);
        return newTip(at.x, at.y, -Math.PI / 2 + (rng() - 0.5) * 1.2);
      }
      let best = null;
      let bestScore = Infinity;
      for (let i = 0; i < 12; i++) {
        const seed = state.seeds[Math.floor(rng() * state.seeds.length)];
        const score = visitsAt(seed.x, seed.y);
        if (score < bestScore) {
          bestScore = score;
          best = seed;
        }
      }
      // Head for whichever neighbour of that seed has seen the least growth.
      let angle = rng() * TAU;
      let lowest = Infinity;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * TAU;
        const v = visitsAt(best.x + Math.cos(a) * state.cell * 1.5, best.y + Math.sin(a) * state.cell * 1.5);
        if (v < lowest) {
          lowest = v;
          angle = a;
        }
      }
      return newTip(best.x, best.y, angle);
    };

    /**
     * How many shoots the plant can support, as a continuous quantity.
     *
     * The old rule was a switch: below the coverage budget, run every tip;
     * at it, `tips.length = 0`. Withering pins `grown` to the budget, so that
     * switch flipped every frame or two — measured on the demo wall, the tip
     * list emptied and refilled about twenty-one times a second, for the rest
     * of the evening. Once the wall is full the accumulated bitmap barely
     * changes, so that strobe was the *only* thing moving: seven bright shoots
     * blinking at 21 Hz, which is exactly "it stops glowing and just flickers".
     *
     * Making it proportional removes the switch rather than damping it. As the
     * plant approaches its budget the shoots wind down one at a time, and as
     * decay makes room they come back one at a time. There is no threshold to
     * sit on top of, so there is nothing to oscillate: a full wall keeps one or
     * two shoots working rather than alternating between seven and none.
     */
    const headroom = clamp((budget - state.grown) / (budget * 0.15), 0, 1);
    // A floor of one while there is any room at all. Rounding a small headroom
    // still toggles between zero and one shoot, about once a second, and one
    // shoot that keeps creeping reads far better than one that keeps returning.
    // Only a plant with no room left — coverage reached and no withering to
    // make more — goes down to none, and even that one fades out.
    const wanted = headroom <= 0
      ? 0
      : Math.max(1, Math.round(clamp(p.tips, 1, 24) * headroom));

    /**
     * Shoots fade in and out rather than appearing and vanishing.
     *
     * A tip is both the thing that draws and the thing that glows, and the glow
     * is by far the brightest object on the wall — retiring one instantly is a
     * hard cut on the brightest pixels in the frame. Easing over about a third
     * of a second costs nothing and makes the wind-down invisible.
     *
     * This covers ordinary deaths too — a runner reaching the end of its life,
     * or walking into a corner it cannot leave. Those were removed outright at
     * full brightness, which is a blip when seven shoots are lit and the entire
     * glow vanishing when the plant is at its ceiling and running one.
     *
     * A retiring tip stops growing immediately: it is being switched off, and a
     * shoot that carries on stroking while it fades leaves a line going nowhere.
     */
    const ease = Math.min(1, dt * 3.5);
    let live = 0;
    for (const tip of state.tips) {
      if (!tip.dead && live < wanted) {
        tip.retiring = false;
        live += 1;
      } else {
        tip.retiring = true;
      }
    }
    for (let i = state.tips.length - 1; i >= 0; i--) {
      const tip = state.tips[i];
      tip.glow += ((tip.retiring ? 0 : 1) - tip.glow) * ease;
      // Once dark, a parked tip is pure cost — a gradient and a fill per frame
      // for something invisible — so this is also what keeps a finished wall
      // down to one drawImage.
      if (tip.retiring && tip.glow < 0.02) state.tips.splice(i, 1);
    }
    while (live < wanted) {
      state.tips.push(spawn());
      live += 1;
    }

    /* --- grow --- */

    /**
     * Whole steps only, with the remainder carried to the next frame.
     *
     * The old form took `min(speed * dt, cap)` as a *length* and then ran the
     * step loop while it was positive, so any speed below one step per frame
     * still bought a full step: everything from 5 to 189 px/s grew at exactly
     * the same rate. The preset's "slow creep" at 40 px/s was really running at
     * 189, which is most of why it reached its budget in half a minute and
     * spent the rest of the evening strobing.
     */
    state.carry = (state.carry || 0) + p.speed * Math.min(dt, 1 / 30);
    let steps = Math.floor(state.carry / stepPx);
    if (steps > VINE_STEPS_PER_FRAME) {
      steps = VINE_STEPS_PER_FRAME;
      state.carry = 0;
    } else {
      state.carry -= steps * stepPx;
    }

    while (steps > 0 && state.grown < budget && state.tips.length) {
      steps -= 1;
      for (let i = state.tips.length - 1; i >= 0; i--) {
        const tip = state.tips[i];
        if (tip.retiring) continue;

        tip.angle += (rng() - 0.5) * p.wander * 0.55;
        // Climb: a steady pull towards up (or down, if you want it dripping).
        if (p.climb !== 0) {
          const goal = p.climb > 0 ? -Math.PI / 2 : Math.PI / 2;
          tip.angle += angleDelta(tip.angle, goal) * Math.abs(p.climb) * 0.06;
        }

        // Towards bare wall.
        //
        // Sampled at three distances along each candidate heading, not one.
        // A single short probe only sees the cell in front of the tip, which is
        // enough to stop it retracing its own stem and nothing like enough to
        // find the empty half of the wall — the vine wanders locally and the
        // bare parts stay bare. Weighting the near samples more keeps it from
        // charging off in a straight line at the first distant gap.
        if (p.spread > 0) {
          let bestAngle = tip.angle;
          let bestScore = Infinity;
          for (const offset of [0, 0.6, -0.6, 1.2, -1.2]) {
            const a = tip.angle + offset;
            const dx = Math.cos(a);
            const dy = Math.sin(a);
            let score = Math.abs(offset) * 0.6; // all else equal, carry straight on
            for (const r of [1.5, 4, 8]) {
              score += visitsAt(tip.x + dx * state.cell * r, tip.y + dy * state.cell * r) / r;
            }
            if (score < bestScore) {
              bestScore = score;
              bestAngle = a;
            }
          }
          tip.angle += angleDelta(tip.angle, bestAngle) * p.spread * 0.25;
        }

        // Towards any opening nothing has reached yet, so the vine ends up on
        // every window rather than the two nearest the ground.
        if (p.seek > 0 && state.wrapped.size < obstacles.length) {
          let target = null;
          let nearest = Infinity;
          for (const o of obstacles) {
            if (state.wrapped.has(o.id)) continue;
            const d = Math.hypot(o.bbox.cx - tip.x, o.bbox.cy - tip.y);
            if (d < nearest) {
              nearest = d;
              target = o;
            }
          }
          if (target) {
            const toward = Math.atan2(target.bbox.cy - tip.y, target.bbox.cx - tip.x);
            tip.angle += angleDelta(tip.angle, toward) * p.seek * 0.05;
          }
        }

        // Follow whatever frame it has found, fading the hold out with distance
        // so it releases at the corner instead of orbiting forever.
        const range = Math.max(6, p.thickness * 5);
        const near = nearestSurface(obstacles, tip.x, tip.y, range);
        if (near) {
          state.wrapped.add(near.shape.id);
          if (p.cling > 0) {
            const tangent = Math.atan2(near.nx, -near.ny);
            const alt = tangent + Math.PI;
            const pick = Math.abs(angleDelta(tip.angle, tangent)) < Math.abs(angleDelta(tip.angle, alt))
              ? tangent
              : alt;
            const hold = p.cling * (1 - near.dist / range);
            tip.angle += angleDelta(tip.angle, pick) * hold * 0.7;
            // And a little push off the glass so it hugs rather than grazes.
            if (near.dist < p.thickness) {
              const away = Math.atan2(near.ny, near.nx);
              tip.angle += angleDelta(tip.angle, away) * 0.25;
            }
          }
        }

        // Somewhere to put the next segment. Sweeping outwards from the
        // intended heading finds the smallest turn that stays on the wall.
        let placed = false;
        let nx = tip.x;
        let ny = tip.y;
        for (const swerve of [0, 0.4, -0.4, 0.9, -0.9, 1.6, -1.6, 2.4, -2.4]) {
          const a = tip.angle + swerve;
          const tx = tip.x + Math.cos(a) * stepPx;
          const ty = tip.y + Math.sin(a) * stepPx;
          if (isClear(container, obstacles, tx, ty)) {
            tip.angle = a;
            nx = tx;
            ny = ty;
            placed = true;
            break;
          }
        }
        if (!placed) {
          tip.dead = true;
          tip.retiring = true;
          continue;
        }

        c.strokeStyle = mixHex(p.color, '#000000', tip.tint * 0.35);
        c.lineWidth = Math.max(0.4, p.thickness * tip.width);
        c.beginPath();
        c.moveTo(tip.x, tip.y);
        c.lineTo(nx, ny);
        c.stroke();

        tip.sinceLeaf += stepPx;
        const leafGap = lerp(200, 26, p.leaves);
        if (p.leaves > 0 && tip.sinceLeaf > leafGap) {
          tip.sinceLeaf = 0;
          const side = rng() < 0.5 ? 1 : -1;
          const a = tip.angle + side * (0.7 + rng() * 0.5);
          const r = p.thickness * (1.6 + rng() * 1.4);
          c.save();
          c.translate(nx, ny);
          c.rotate(a);
          c.fillStyle = mixHex(p.color, p.tip, 0.25 + rng() * 0.3);
          c.beginPath();
          c.ellipse(r * 0.9, 0, r, r * 0.55, 0, 0, TAU);
          c.fill();
          c.restore();
        }

        tip.x = nx;
        tip.y = ny;
        tip.width *= 0.9985;
        tip.life -= stepPx;
        state.grown += stepPx;

        const cell = cellIndex(nx, ny);
        if (cell >= 0 && state.visits[cell] < 65535) state.visits[cell]++;
        state.sinceSeed += stepPx;
        if (state.sinceSeed > state.cell) {
          state.sinceSeed = 0;
          state.seeds.push({ x: nx, y: ny });
          // A bounded reservoir: drop a random old one rather than the oldest,
          // so the candidates stay spread over the whole plant.
          if (state.seeds.length > 500) state.seeds.splice(Math.floor(rng() * 400), 1);
        }

        // Branching is bounded by the tip count, not by an absolute ceiling:
        // left to itself it doubles the population in place, and the spawner —
        // the only thing that ever puts a runner on fresh wall — never gets a
        // turn, because there is always a live tip to keep the count up.
        if (rng() < p.branch * 0.03 && tip.width > 0.35 && state.tips.length < wanted * 2) {
          state.tips.push({
            ...newTip(tip.x, tip.y, tip.angle + (rng() < 0.5 ? -1 : 1) * (0.6 + rng() * 0.7), tip.width * 0.72),
            life: tip.life * (0.4 + rng() * 0.4),
          });
        }

        if (tip.life <= 0 || tip.width < 0.18) {
          tip.dead = true;
          tip.retiring = true;
        }
      }
    }

  },
  /**
   * The plant is grown into an offscreen bitmap by `step` and blitted here.
   *
   * That division was already most of the way there — growth accumulates into a
   * canvas and the frame is one `drawImage` — so all that moved is where the
   * growing happens. Which matters: a runner's path is a chain of decisions, and
   * a tab taking bigger steps than another grows a different plant.
   */
  draw({ g, p, shape, state }) {
    const container = shape;
    const { bbox } = container;
    if (bbox.w <= 2 || bbox.h <= 2 || !state.canvas) return;

    g.save();
    g.clip(container.path);
    g.drawImage(state.canvas, bbox.x, bbox.y, bbox.w, bbox.h);

    if (p.shootGlow > 0) {
      g.globalCompositeOperation = 'lighter';
      for (const tip of state.tips) {
        if (tip.glow < 0.02) continue;
        glow(g, tip.x, tip.y, p.thickness * (3 + p.shootGlow * 4), p.tip, 0.5 * p.shootGlow * tip.glow);
      }
      g.fillStyle = p.tip;
      for (const tip of state.tips) {
        if (tip.glow < 0.02) continue;
        g.globalAlpha = tip.glow;
        g.beginPath();
        g.arc(tip.x, tip.y, Math.max(0.6, p.thickness * tip.width * 0.7), 0, TAU);
        g.fill();
      }
      g.globalAlpha = 1;
    }
    g.restore();
  },
};


/**
 * Relight — light the building's actual surface, rather than paint on it.
 *
 * Every other effect in this file reasons about the facade as outlines: a ball
 * bounces off the top of the bay because somebody traced the top of the bay.
 * This one reasons about it as a surface, and it is the one effect in the
 * library that cannot work without a depth scan, because there is nowhere else
 * for a surface normal to come from.
 *
 * What it draws is one term: N·L, against the normal the scan measured, with
 * the shadow ray-marched through the same heightfield. That is all. There is no
 * artwork, no gradient, no sprite — the shape of the light is entirely the shape
 * of the building, which is exactly why it reads as a lamp that is really there.
 * The reveals darken on one side and catch on the other because the reveals
 * catch and darken; the porch throws its shadow across the path because the
 * porch is in the way.
 *
 * Both lamp coordinates are ordinary numeric parameters, which means the whole
 * modulation system already applies to them: bind X to an LFO and somebody walks
 * a lantern past the house, bind the brightness to the beat and the house
 * flickers in time, bind either to the microphone and it answers the doorbell.
 * None of that needed writing.
 *
 * Alpha carries the light and the colour is left at full strength, so the layer
 * composites as light falling on the scene rather than as a picture laid over
 * it — and anywhere the scan saw nothing comes out fully transparent instead of
 * as a black rectangle with the outline of somebody's front garden in it.
 */
const relight = {
  id: 'relight',
  name: 'Relight',
  category: 'facade',
  description: 'A virtual lamp, shading the real surface of the building. Needs a depth scan.',
  /** Declared so the layer list can say why nothing is happening. */
  needs: 'depth',
  params: [
    { key: 'x', type: 'range', label: 'Lamp across', default: 0.5, min: -0.5, max: 1.5, step: 0.005 },
    { key: 'y', type: 'range', label: 'Lamp height', default: 0.35, min: -0.5, max: 1.5, step: 0.005 },
    { key: 'standOff', type: 'range', label: 'Distance out', default: 1.1, min: 0.05, max: 14, step: 0.05 },
    { key: 'kelvin', type: 'range', label: 'Temperature', default: 2000, min: 1000, max: 9000, step: 25 },
    { key: 'intensity', type: 'range', label: 'Brightness', default: 2.2, min: 0, max: 10, step: 0.05 },
    { key: 'reach', type: 'range', label: 'Reach', default: 2.6, min: 0.2, max: 40, step: 0.1 },
    { key: 'ambient', type: 'range', label: 'Fill', default: 0.04, min: 0, max: 0.8, step: 0.005 },
    { key: 'shadows', type: 'bool', label: 'Cast shadows', default: true },
    { key: 'detail', type: 'range', label: 'Detail', default: 1, min: 0.3, max: 2.5, step: 0.05 },
  ],

  draw({ g, p, shape, depth, state }) {
    // No scan, or a scan that does not reach this part of the frame. Drawing
    // nothing is right: the layer diagnostics say why, and a placeholder glow
    // would be a lie about where the building is.
    if (!depth?.ready) return;
    const { bbox } = shape;
    if (bbox.w < 2 || bbox.h < 2) return;

    /**
     * One cell per few world pixels.
     *
     * The shadow march is the cost and it is per cell, so this is the knob that
     * decides whether the effect runs at sixty frames a second on a laptop that
     * is also driving two projectors. Six world pixels is about three
     * millimetres on a real facade — far finer than the bloom downstream, which
     * is why the default looks no softer than a full-resolution version.
     */
    const step = Math.max(2, Math.round(6 / clamp(p.detail, 0.3, 2.5)));
    const cols = clamp(Math.ceil(bbox.w / step), 2, 512);
    const rows = clamp(Math.ceil(bbox.h / step), 2, 512);

    let buffer = state.buffer;
    if (!buffer || buffer.width !== cols || buffer.height !== rows) {
      const canvas = offscreen(cols, rows);
      buffer = {
        canvas,
        ctx: canvas.getContext('2d'),
        width: cols,
        height: rows,
      };
      buffer.image = buffer.ctx.createImageData(cols, rows);
      state.buffer = buffer;
    }
    const data = buffer.image.data;

    const extent = depth.extent;
    // Height reads upwards, because that is how anybody placing a lamp thinks
    // about it. Wall metres run down from the top of the scan, like everything
    // else on a canvas, so the flip happens once, here.
    const lx = p.x * extent.width;
    const ly = (1 - p.y) * extent.height;
    const lz = Math.max(0.02, p.standOff);

    const [cr, cg, cb] = blackbodyBytes(p.kelvin);
    const reach = Math.max(0.05, p.reach);
    const intensity = Math.max(0, p.intensity);
    const ambient = Math.max(0, p.ambient);
    const shadows = p.shadows !== false;

    const wall = [0, 0, 0];
    const normal = [0, 0, 1];

    for (let row = 0; row < rows; row++) {
      const wy = bbox.y + ((row + 0.5) / rows) * bbox.h;
      for (let col = 0; col < cols; col++) {
        const i = (row * cols + col) * 4;
        const wx = bbox.x + ((col + 0.5) / cols) * bbox.w;

        depth.wallAt(wx, wy, wall);
        if (!(wall[2] === wall[2])) {
          data[i + 3] = 0;
          continue;
        }
        depth.normalAt(wx, wy, normal);

        const dx = lx - wall[0];
        const dy = ly - wall[1];
        const dz = lz - wall[2];
        const dist = Math.hypot(dx, dy, dz) || 1e-4;
        const ndotl = (normal[0] * dx + normal[1] * dy + normal[2] * dz) / dist;

        let amount = ambient;
        if (ndotl > 0) {
          // Inverse-square, softened at the origin so a lamp resting against
          // the wall is bright rather than infinite.
          const falloff = 1 / (1 + (dist * dist) / (reach * reach));
          let lit = ndotl * falloff * intensity;
          if (lit > 0.002 && shadows) lit *= 1 - depth.shadow(wall[0], wall[1], wall[2], lx, ly, lz);
          amount += lit;
        }

        data[i] = cr;
        data[i + 1] = cg;
        data[i + 2] = cb;
        // Rolled off rather than clipped, and carried on alpha so the layer
        // adds light to the scene instead of covering it.
        data[i + 3] = (255 * (amount / (1 + amount))) | 0;
      }
    }

    buffer.ctx.putImageData(buffer.image, 0, 0);

    g.save();
    g.clip(shape.path);
    g.imageSmoothingEnabled = true;
    g.drawImage(buffer.canvas, bbox.x, bbox.y, bbox.w, bbox.h);
    g.restore();
  },
};

export default [bounce, serpent, vine, relight];
