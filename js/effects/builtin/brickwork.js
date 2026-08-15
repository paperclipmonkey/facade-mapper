/**
 * Brickwork, and what is behind it.
 *
 * Two effects that only make sense together. **Brickwork** lays a course of
 * bricks over a shape; **Breach** takes them out one at a time and lets
 * something reach through the hole. They are separate so you can have the wall
 * without the horror — a plain brick wall is the single most useful thing to
 * put on a rendered or painted facade, because it gives every other effect
 * somewhere to live.
 *
 * The design problem here is that a wall is thousands of small objects and a
 * projector frame is sixteen milliseconds. The answer is the same one the vine
 * uses: the intact wall never changes, so it is baked into a bitmap once and
 * blitted thereafter. Only the handful of bricks currently coming loose is ever
 * drawn as geometry. A wall of four hundred bricks and a wall of four thousand
 * cost the same per frame.
 *
 * The second design problem is resolution. This is aimed at a projector, and a
 * domestic one puts about half a pixel on the wall for every pixel an effect
 * draws in. Mortar lines at their true 10mm scale land under one projector
 * pixel and turn into grey haze; brick bevels a pixel wide do nothing at all.
 * So everything structural here is deliberately fatter than life — see the note
 * on the four-pixel floor in docs/effects.md — and the shading is done with
 * whole-face tone steps rather than thin highlight lines, because a face that
 * covers twenty pixels survives being halved and a line that covers one does
 * not.
 */

import { rgba, clamp, TAU, mixHex, makeRng, pointInPolygon } from '../../core/math.js';
import { collectObstacles, isClear, nearestSurface } from '../obstacles.js';
import { offscreen, glow } from '../lib.js';

/** Shared with the facade family so the wording stays consistent. */
const OBSTACLE_PARAM = {
  key: 'obstacles',
  type: 'text',
  label: 'Solid tags',
  default: 'window, door',
};

/**
 * Does this brick come within `margin` of an opening?
 *
 * Rectangle against expanded bounding box — deliberately the bounding box and
 * not the outline, even for an arch. A hole that opens level with the top of a
 * window reads as damage to the window rather than to the wall, so keeping the
 * whole bounding area clear is both cheaper and more conservative than
 * following the shape exactly. The *brickwork* still cuts its reveals to the
 * true outline; this is only about where a breach may open.
 */
function nearObstacle(obstacles, x, y, w, h, margin) {
  for (const o of obstacles) {
    const b = o.bbox;
    if (x + w < b.x - margin || x > b.x + b.w + margin) continue;
    if (y + h < b.y - margin || y > b.y + b.h + margin) continue;
    return true;
  }
  return false;
}

/**
 * Every brick in the shape, in laying order.
 *
 * Running bond — alternate courses offset by half a brick — because it is what
 * almost every British house is, and because stack bond reads as tiling rather
 * than as masonry: the eye finds the continuous vertical joints immediately and
 * stops believing it.
 */
function layCourses(bbox, w, h, gap) {
  const bricks = [];
  const pitchY = h + gap;
  const pitchX = w + gap;
  const rows = Math.ceil(bbox.h / pitchY) + 1;

  for (let r = 0; r < rows; r++) {
    const y = bbox.y + r * pitchY;
    const offset = r % 2 ? -pitchX / 2 : 0;
    const cols = Math.ceil(bbox.w / pitchX) + 2;
    for (let c = 0; c < cols; c++) {
      const x = bbox.x + offset + c * pitchX;
      if (x > bbox.x + bbox.w || x + w < bbox.x) continue;
      bricks.push({ x, y, cx: x + w / 2, cy: y + h / 2, row: r, col: c });
    }
  }
  return bricks;
}

/**
 * One brick face, with the light coming from the top left.
 *
 * Three flat tones rather than a gradient and a hairline: the top and left
 * edges a step lighter, the bottom and right a step darker, the face itself in
 * between. Each of those bands is a good fraction of the brick, so all three
 * survive being scaled down to a projector. It is also about ten times cheaper
 * than a gradient per brick, which matters when there are four thousand of them
 * even if it only happens once.
 */
function drawBrick(c, x, y, w, h, face, relief) {
  const bevel = Math.max(1, Math.min(w, h) * 0.16);
  c.fillStyle = face;
  c.fillRect(x, y, w, h);
  if (relief <= 0) return;

  c.fillStyle = rgba('#ffffff', 0.16 * relief);
  c.fillRect(x, y, w, bevel);
  c.fillRect(x, y, bevel, h);
  c.fillStyle = rgba('#000000', 0.26 * relief);
  c.fillRect(x, y + h - bevel, w, bevel);
  c.fillRect(x + w - bevel, y, bevel, h);
}

/**
 * Bake the intact wall.
 *
 * Once, into a bitmap the size of the shape, capped so an enormous traced area
 * cannot allocate an enormous canvas. Everything after this is one drawImage.
 */
function bakeWall(bbox, p, obstacles, rng) {
  const scale = Math.min(1, 1400 / Math.max(bbox.w, bbox.h));
  const canvas = offscreen(bbox.w * scale, bbox.h * scale);
  const c = canvas.getContext('2d');
  c.setTransform(scale, 0, 0, scale, -bbox.x * scale, -bbox.y * scale);

  const w = Math.max(6, p.brickW);
  const h = Math.max(3, p.brickH);
  const gap = Math.max(0, p.gap);

  // The mortar is the background, showing through the joints. Drawing it as a
  // solid field and laying bricks on top is both simpler and more convincing
  // than stroking lines between them, because the joints then have real width
  // and pick up the brick shadows at their edges.
  c.fillStyle = p.mortar;
  c.fillRect(bbox.x, bbox.y, bbox.w, bbox.h);

  const bricks = layCourses(bbox, w, h, gap);
  for (const brick of bricks) {
    // Per-brick colour variation is the whole difference between masonry and
    // graph paper. Two independent draws — one towards the second colour, one
    // in overall lightness — so a wall does not read as two alternating tints.
    const mix = rng() * p.variation;
    const shade = 1 + (rng() - 0.5) * p.variation * 0.55;
    const face = mixHex(mixHex(p.color, p.color2, mix), shade > 1 ? '#ffffff' : '#000000', Math.abs(shade - 1));
    drawBrick(c, brick.x, brick.y, w, h, face, p.relief);
  }

  /**
   * Then cut the openings out, as the shapes they actually are.
   *
   * The obvious implementation is to skip any brick whose centre falls in a
   * window, and it looks wrong for a reason worth writing down: running bond
   * staggers alternate courses, so "every brick centred inside this rectangle"
   * is a ragged scatter, not a rectangle. You get single bricks missing around
   * each opening like a bad tooth. Real masonry has a clean reveal because the
   * bricks are *cut* at the opening, which is exactly what erasing the polygon
   * after laying them does — and it follows an arched or angled opening for
   * free, which no brick-by-brick test can.
   */
  if (obstacles.length) {
    c.globalCompositeOperation = 'destination-out';
    c.fillStyle = '#000000';
    for (const o of obstacles) {
      c.beginPath();
      c.moveTo(o.points[0].x, o.points[0].y);
      for (let i = 1; i < o.points.length; i++) c.lineTo(o.points[i].x, o.points[i].y);
      c.closePath();
      c.fill();
    }
    c.globalCompositeOperation = 'source-over';
  }

  return { canvas, scale, bricks, w, h };
}

/* ------------------------------------------------------------------ *
 * Brickwork
 * ------------------------------------------------------------------ */

/** Seconds a brick rattles in its bed before it lets go. */
const SHUDDER = 0.9;

const brickwork = {
  id: 'brickwork',
  name: 'Brickwork',
  category: 'facade',
  scope: 'shape',
  description:
    'A course of brick laid over the shape, in running bond with per-brick colour variation. On a white or rendered wall this is what gives everything else something to sit on.',
  params: [
    { key: 'color', type: 'color', label: 'Brick', default: '#8d4a35' },
    { key: 'color2', type: 'color', label: 'Second brick', default: '#5e2f24' },
    { key: 'mortar', type: 'color', label: 'Mortar', default: '#2a2724' },
    { key: 'brickW', type: 'range', label: 'Brick width', default: 132, min: 20, max: 400, step: 2 },
    { key: 'brickH', type: 'range', label: 'Brick height', default: 44, min: 8, max: 160, step: 1 },
    { key: 'gap', type: 'range', label: 'Mortar', default: 7, min: 0, max: 30, step: 0.5 },
    { key: 'variation', type: 'range', label: 'Colour variation', default: 0.55, min: 0, max: 1, step: 0.01 },
    { key: 'relief', type: 'range', label: 'Relief', default: 0.7, min: 0, max: 1, step: 0.01 },
    OBSTACLE_PARAM,
    { key: 'seed', type: 'range', label: 'Seed', default: 1, min: 1, max: 99, step: 1 },
  ],
  init() {
    return { key: '' };
  },
  draw({ g, p, shape, state, shapes, stable }) {
    const { bbox } = shape;
    if (bbox.w <= 2 || bbox.h <= 2) return;

    const obstacles = collectObstacles(shapes, p.obstacles, shape.id);
    const key = wallKey(shape, stable, obstacles);
    if (state.key !== key) {
      state.key = key;
      state.wall = bakeWall(bbox, stable, obstacles, makeRng(`brick:${stable.seed}:${shape.id}`));
    }

    g.save();
    g.clip(shape.path);
    g.drawImage(state.wall.canvas, bbox.x, bbox.y, bbox.w, bbox.h);
    g.restore();
  },
};

/**
 * What invalidates a baked wall.
 *
 * Built from `stable` — the parameter values *before* modulation — so that
 * binding the mortar width to the microphone re-lays the wall never rather than
 * sixty times a second. The obstacle list is in it because a window traced
 * after the wall was baked has to punch through it.
 */
function wallKey(shape, p, obstacles) {
  return [
    shape.id,
    Math.round(shape.bbox.w),
    Math.round(shape.bbox.h),
    p.color, p.color2, p.mortar,
    p.brickW, p.brickH, p.gap, p.variation, p.relief, p.seed,
    obstacles.map((o) => o.id).join(','),
  ].join('|');
}

/* ------------------------------------------------------------------ *
 * Breach
 * ------------------------------------------------------------------ */

/**
 * A tentacle: a centreline of joints, each with a width, drawn as a filled
 * ribbon rather than a stroked line.
 *
 * Stroking would be a third of the code, and wrong. A stroke has one width, so
 * a tentacle cannot taper; and `lineWidth` under a couple of pixels is exactly
 * the thing that vanishes on a projector. A ribbon tapers, takes a highlight
 * down one side as a second filled shape, and is honest about what it covers.
 */
function tentacleRibbon(g, joints, widths) {
  g.beginPath();
  for (let i = 0; i < joints.length; i++) {
    const a = joints[i];
    const b = joints[Math.min(i + 1, joints.length - 1)];
    const prev = joints[Math.max(i - 1, 0)];
    const angle = Math.atan2(b.y - prev.y, b.x - prev.x) + Math.PI / 2;
    const wx = Math.cos(angle) * widths[i];
    const wy = Math.sin(angle) * widths[i];
    if (i === 0) g.moveTo(a.x + wx, a.y + wy);
    else g.lineTo(a.x + wx, a.y + wy);
  }
  for (let i = joints.length - 1; i >= 0; i--) {
    const a = joints[i];
    const b = joints[Math.min(i + 1, joints.length - 1)];
    const prev = joints[Math.max(i - 1, 0)];
    const angle = Math.atan2(b.y - prev.y, b.x - prev.x) + Math.PI / 2;
    g.lineTo(a.x - Math.cos(angle) * widths[i], a.y - Math.sin(angle) * widths[i]);
  }
  g.closePath();
  g.fill();
}

const breach = {
  id: 'breach',
  name: 'Breach',
  category: 'halloween',
  scope: 'shape',
  description:
    'Bricks work loose, shudder, and drop out of the wall — and something reaches out through the hole they leave. Put it directly over Brickwork, matched to the same brick size.',
  params: [
    { key: 'brickW', type: 'range', label: 'Brick width', default: 132, min: 20, max: 400, step: 2 },
    { key: 'brickH', type: 'range', label: 'Brick height', default: 44, min: 8, max: 160, step: 1 },
    { key: 'gap', type: 'range', label: 'Mortar', default: 7, min: 0, max: 30, step: 0.5 },
    { key: 'rate', type: 'range', label: 'Bricks a minute', default: 7, min: 0, max: 60, step: 1 },
    { key: 'cluster', type: 'range', label: 'Bricks per hole', default: 5, min: 1, max: 16, step: 1 },
    { key: 'holes', type: 'range', label: 'Holes at once', default: 3, min: 1, max: 10, step: 1 },
    { key: 'heal', type: 'range', label: 'Wall heals after (s)', default: 30, min: 0, max: 300, step: 5 },
    { key: 'brick', type: 'color', label: 'Falling brick', default: '#7d4130' },
    { key: 'void', type: 'color', label: 'Behind the wall', default: '#08040c' },
    { key: 'innerGlow', type: 'color', label: 'Light from inside', default: '#4bff8f' },
    { key: 'glowAmount', type: 'range', label: 'Inner glow', default: 0.8, min: 0, max: 3, step: 0.05 },
    { key: 'arms', type: 'range', label: 'Tentacles per hole', default: 3, min: 0, max: 8, step: 1 },
    { key: 'armColor', type: 'color', label: 'Tentacle', default: '#243026' },
    { key: 'armTip', type: 'color', label: 'Tentacle tip', default: '#79994a' },
    { key: 'thickness', type: 'range', label: 'Tentacle thickness', default: 27, min: 4, max: 110, step: 1 },
    { key: 'suckers', type: 'range', label: 'Suckers', default: 0.55, min: 0, max: 1, step: 0.01 },
    { key: 'reach', type: 'range', label: 'Reach', default: 0.9, min: 0.1, max: 3, step: 0.05 },
    { key: 'crawl', type: 'range', label: 'Crawl speed', default: 130, min: 10, max: 600, step: 5 },
    { key: 'wander', type: 'range', label: 'Wander', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'cling', type: 'range', label: 'Feel round frames', default: 0.75, min: 0, max: 1, step: 0.01 },
    { key: 'explore', type: 'range', label: 'Seek bare wall', default: 0.7, min: 0, max: 1, step: 0.01 },
    { key: 'writhe', type: 'range', label: 'Writhe', default: 1, min: 0, max: 3, step: 0.05 },
    { key: 'dust', type: 'range', label: 'Dust', default: 0.7, min: 0, max: 1, step: 0.01 },
    { key: 'gravity', type: 'range', label: 'Gravity', default: 1400, min: 100, max: 4000, step: 50 },
    OBSTACLE_PARAM,
    { key: 'seed', type: 'range', label: 'Seed', default: 1, min: 1, max: 99, step: 1 },
  ],
  init() {
    return { key: '', holes: [], falling: [], motes: [], since: 0 };
  },
  draw({ g, p, shape, t, dt, rng, state, shapes, stable }) {
    const { bbox } = shape;
    if (bbox.w <= 2 || bbox.h <= 2) return;

    const obstacles = collectObstacles(shapes, p.obstacles, shape.id);
    const w = Math.max(6, p.brickW);
    const h = Math.max(3, p.brickH);
    const gap = Math.max(0, p.gap);

    // The same grid the Brickwork layer under this one laid, recomputed rather
    // than shared: two layers cannot see each other's state, and matching the
    // maths is both simpler and more robust than a channel between them. Cached
    // on geometry, because it is the one expensive thing here.
    const key = [shape.id, Math.round(bbox.w), Math.round(bbox.h), w, h, gap,
      obstacles.map((o) => o.id).join(',')].join('|');
    if (state.key !== key) {
      state.key = key;
      // Keep well clear of the openings: half a brick of margin, so a void
      // never bites into a window reveal the brickwork carefully cut.
      const margin = Math.min(w, h) * 0.5;
      state.grid = layCourses(bbox, w, h, gap).filter((brick) => {
        if (nearObstacle(obstacles, brick.x, brick.y, w, h, margin)) return false;
        // And wholly inside the shape. A traced facade is a gable, not a
        // rectangle, so a good third of its bounding box is sky — without this
        // most holes open where nothing is drawn and the effect appears not to
        // be running. All four corners, not the centre: a brick straddling the
        // roofline leaves a void with one edge in mid-air.
        return (
          pointInPolygon({ x: brick.x, y: brick.y }, shape.points)
          && pointInPolygon({ x: brick.x + w, y: brick.y }, shape.points)
          && pointInPolygon({ x: brick.x, y: brick.y + h }, shape.points)
          && pointInPolygon({ x: brick.x + w, y: brick.y + h }, shape.points)
        );
      });
      state.holes = [];
      state.falling = [];
      state.motes = [];
      state.taken = new Set();
    }
    const grid = state.grid;
    if (!grid.length) return;

    const step = Math.min(dt, 1 / 30);
    const maxHoles = Math.round(clamp(p.holes, 1, 10));

    /* --- open a new hole --- */

    state.since += step;
    const interval = p.rate > 0 ? 60 / p.rate : Infinity;
    if (state.since > interval && state.holes.length < maxHoles && state.taken.size < grid.length) {
      state.since = 0;
      // Somewhere that is not already open, and not touching an existing hole —
      // two holes side by side read as one big rectangle rather than as two
      // things pushing through.
      let seed = null;
      for (let attempt = 0; attempt < 24 && !seed; attempt++) {
        const candidate = grid[Math.floor(rng() * grid.length)];
        if (state.taken.has(candidate)) continue;
        const clear = state.holes.every(
          (hole) => Math.hypot(hole.cx - candidate.cx, hole.cy - candidate.cy) > Math.max(w, h) * 2.2
        );
        if (clear) seed = candidate;
      }

      if (seed) {
        // Grow the hole outwards from the seed by nearest neighbour, so a
        // three-brick breach is a rough patch rather than three separate bricks.
        const want = Math.round(clamp(p.cluster, 1, 16));
        const chosen = [seed];
        state.taken.add(seed);
        while (chosen.length < want) {
          let best = null;
          let bestD = Infinity;
          for (const brick of grid) {
            if (state.taken.has(brick)) continue;
            const d = Math.hypot(brick.cx - seed.cx, brick.cy - seed.cy);
            if (d < bestD) {
              bestD = d;
              best = brick;
            }
          }
          if (!best || bestD > Math.max(w, h) * 2.5) break;
          state.taken.add(best);
          chosen.push(best);
        }

        state.holes.push({
          /** Still in the wall, rattling. Bricks move from here to `gone`. */
          pending: chosen,
          /** Out. These are the rectangles that read as hole. */
          gone: [],
          cx: seed.cx,
          cy: seed.cy,
          bornAt: t,
          nextDrop: t + SHUDDER,
          /** Seconds since the last brick left, once there are none pending. */
          openFor: 0,
          /** 0 open, ramping to 1 as the wall closes over it again. */
          closing: 0,
          arms: [],
        });
      }
    }

    /* --- age the holes --- */

    const armCount = Math.round(clamp(p.arms, 0, 8));

    for (let i = state.holes.length - 1; i >= 0; i--) {
      const hole = state.holes[i];

      // Bricks let go one at a time, a fifth of a second apart, rather than all
      // together — the difference between a wall failing and a trapdoor opening.
      if (hole.pending.length && t >= hole.nextDrop) {
        const brick = hole.pending.shift();
        hole.gone.push(brick);
        hole.nextDrop = t + 0.16 + rng() * 0.16;
        state.falling.push({
          x: brick.x, y: brick.y,
          vx: (rng() - 0.5) * 90,
          vy: 20 + rng() * 60,
          spin: (rng() - 0.5) * 5,
          angle: 0,
          tint: rng(),
        });
        if (p.dust > 0) {
          const puffs = 2 + Math.round(rng() * 4 * p.dust);
          for (let d = 0; d < puffs; d++) {
            state.motes.push({
              x: brick.cx + (rng() - 0.5) * w,
              y: brick.cy + (rng() - 0.5) * h,
              vx: (rng() - 0.5) * 40,
              vy: 30 + rng() * 90,
              life: 0.7 + rng() * 0.9,
              age: 0,
              r: Math.max(5, Math.min(w, h) * (0.09 + rng() * 0.14)),
            });
          }
        }
      }

      // Tentacles arrive once the hole is actually a hole.
      if (!hole.pending.length) {
        hole.openFor += step;
        while (hole.arms.length < armCount) {
          /**
           * Spread the origins across the hole rather than stacking every arm
           * on its centre, which produces a rosette — the most plant-like thing
           * a clutch of tentacles can do. But check the offset one: the crawl
           * validates every *step* and had no opinion about where the path
           * started, so an arm rooted near the edge of a hole by the roofline
           * had its first joint, and the whole width of ribbon drawn around it,
           * hanging off the side of the house.
           */
          const thick = Math.max(4, p.thickness);
          let ox = hole.cx + (rng() - 0.5) * w * 0.5;
          let oy = hole.cy + (rng() - 0.5) * h * 0.3;
          if (!stepClear(shape, obstacles, ox, oy, 0, thick)
            || !stepClear(shape, obstacles, ox, oy, Math.PI / 2, thick)) {
            ox = hole.cx;
            oy = hole.cy;
          }
          hole.arms.push({
            /** Where it comes out of the wall. Every fresh reach starts here. */
            origin: { x: ox, y: oy },
            /** The path it has actually crawled, in order. Grows and retracts. */
            path: [{ x: ox, y: oy }],
            angle: -Math.PI / 2 + (rng() - 0.5) * 2.2,
            phase: rng() * TAU,
            rate: 0.55 + rng() * 0.7,
            length: 0.7 + rng() * 0.6,
            girth: 0.65 + rng() * 0.7,
            turn: rng() < 0.5 ? 1 : -1,
            /**
             * How fast this one crawls, relative to the setting.
             *
             * There was no such thing until now: `arm.rate` existed and was
             * only ever used for the sway, so every tentacle on the house
             * extended at precisely the same speed. Three arms out of one hole
             * moving in lockstep is the sort of wrongness you feel before you
             * can name — nothing alive does that.
             */
            pace: 0.55 + rng() * 0.95,
            /**
             * Which flank the suckers are on. Fixed for the arm's whole life,
             * and deliberately *not* `turn`.
             *
             * `turn` is which way the crawl prefers to swerve, and it is
             * flipped whenever a step is blocked — which, for an arm holding
             * station against a window frame, is every single frame. Drawing
             * the suckers on `turn` therefore snapped them from one side of the
             * arm to the other at sixty hertz: a hard flicker on the brightest
             * detail of the brightest object on the wall.
             */
            side: rng() < 0.5 ? 1 : -1,
            carry: 0,
            /** 'out' reaching, 'feel' holding station and probing, 'back' retracting. */
            phase2: 'out',
            timer: 0,
            bornAt: t + hole.arms.length * 0.35,
          });
        }
      }

      /**
       * And then the wall closes over it again.
       *
       * Bricks do not climb back into a wall, and it does not matter: what
       * matters is that a show runs from dusk until the last group has gone.
       * Without this the wall opens `Holes at once` times and is then finished
       * — every hole permanent, every brick spent, nothing left to look at for
       * the next three hours. Healing costs a fade and buys an evening.
       *
       * Set it to zero if you want the damage to be permanent, which is the
       * right choice for a short scene fired from a trigger.
       */
      if (p.heal > 0 && !hole.pending.length && hole.openFor > p.heal) hole.retiring = true;

      if (hole.retiring) {
        /**
         * Arms first, then the bricks.
         *
         * Healing used to fade the whole hole out over about two seconds, arms
         * included — so a tentacle three metres up the wall went thin and then
         * simply stopped existing. It reads as a dropped frame rather than as
         * anything retreating. Sending them back the way they came takes the
         * same machinery the arms already have for giving up on a direction,
         * and the wall only starts closing once they are back inside it.
         */
        let out = false;
        for (const arm of hole.arms) {
          if (arm.path && arm.path.length > 2) {
            out = true;
            if (arm.phase2 !== 'back') {
              arm.phase2 = 'back';
              arm.timer = 0;
            }
            // ...and stay back. Without this the arm reaches its stub, decides
            // it has finished retracting, and sets off again into a hole that
            // is trying to close behind it.
            arm.holdBack = true;
          }
        }
        if (!out) {
          hole.arms.length = 0;
          hole.closing = Math.min(1, hole.closing + step / 1.8);
          if (hole.closing >= 1) {
            for (const brick of hole.gone) state.taken.delete(brick);
            state.holes.splice(i, 1);
          }
        }
      }
    }

    /* --- fall --- */

    const floor = bbox.y + bbox.h;
    for (let i = state.falling.length - 1; i >= 0; i--) {
      const b = state.falling[i];
      b.vy += p.gravity * step;
      b.x += b.vx * step;
      b.y += b.vy * step;
      b.angle += b.spin * step;
      if (b.y > floor + h * 2) state.falling.splice(i, 1);
    }
    for (let i = state.motes.length - 1; i >= 0; i--) {
      const m = state.motes[i];
      m.age += step;
      m.vy += 120 * step;
      m.x += m.vx * step;
      m.y += m.vy * step;
      if (m.age > m.life) state.motes.splice(i, 1);
    }

    /* --- crawl --- */

    // Where the arms have been, coarsely. Shared by every arm on the wall, so
    // they avoid each other's ground as well as their own and the result is a
    // tangle spread over the brickwork rather than a bundle in one corner.
    if (!state.trail || state.trailCell !== Math.max(w, h)) {
      state.trailCell = Math.max(w, h);
      state.trailCols = Math.max(1, Math.ceil(bbox.w / state.trailCell));
      state.trailRows = Math.max(1, Math.ceil(bbox.h / state.trailCell));
      state.trail = new Uint16Array(state.trailCols * state.trailRows);
      state.trailAge = 0;
    }
    // And it forgets, or an arm that retracts leaves ground poisoned for ever.
    state.trailAge += step;
    if (state.trailAge > 3) {
      state.trailAge = 0;
      for (let i = 0; i < state.trail.length; i++) state.trail[i] = (state.trail[i] * 0.6) | 0;
    }

    if (armCount > 0) {
      for (const hole of state.holes) {
        for (const arm of hole.arms) {
          if (t >= arm.bornAt) crawl(arm, p, shape, obstacles, state, step, rng, w, h);
        }
      }
    }

    /* --- draw --- */

    g.save();
    g.clip(shape.path);

    // The voids, then whatever is inside them, then the tentacles over the top
    // — the only order in which an arm reads as coming *out* of the wall.
    for (const hole of state.holes) {
      if (!hole.gone.length) continue;
      const solidity = 1 - hole.closing;
      // Grown by the mortar joint, so neighbouring gaps merge. Without this
      // the mortar between two removed bricks survives as a line across the
      // opening, and a five-brick breach reads as five letterboxes rather than
      // as one hole with something behind it.
      g.globalAlpha = solidity;
      g.fillStyle = p.void;
      for (const brick of hole.gone) {
        g.fillRect(brick.x - gap, brick.y - gap, w + gap * 2, h + gap * 2);
      }
      g.globalAlpha = 1;

      if (p.glowAmount > 0 && solidity > 0.02) {
        const pulse = 0.55 + 0.45 * Math.sin(t * 1.7 + hole.cx * 0.01);
        g.save();
        g.beginPath();
        for (const brick of hole.gone) g.rect(brick.x - gap, brick.y - gap, w + gap * 2, h + gap * 2);
        g.clip();
        g.globalCompositeOperation = 'lighter';
        glow(g, hole.cx, hole.cy, Math.max(w, h) * 1.6, p.innerGlow, 0.5 * p.glowAmount * pulse * solidity);
        g.restore();
      }
    }

    // Bricks that are still in the wall but on their way out get a shudder and
    // darken as the mortar goes. It is a few pixels of jitter and it is most of
    // what sells the effect: something that falls without warning reads as a
    // glitch, and something that rattles first reads as a thing coming through.
    for (const hole of state.holes) {
      if (!hole.pending.length) continue;
      const ready = clamp((t - hole.bornAt) / SHUDDER, 0, 1);
      const shake = ready * Math.max(1.5, Math.min(w, h) * 0.06);
      g.fillStyle = rgba('#000000', 0.2 + 0.35 * ready);
      for (const brick of hole.pending) {
        g.fillRect(
          brick.x + (rng() - 0.5) * shake * 2,
          brick.y + (rng() - 0.5) * shake * 2,
          w,
          h
        );
      }
    }

    if (armCount > 0) {
      for (const hole of state.holes) {
        for (const arm of hole.arms) {
          drawArm(g, p, hole, arm, t, w, h, 1 - hole.closing, shape, obstacles);
        }
      }
    }

    for (const b of state.falling) {
      g.save();
      g.translate(b.x + w / 2, b.y + h / 2);
      g.rotate(b.angle);
      drawBrick(g, -w / 2, -h / 2, w, h, mixHex(p.brick, '#000000', b.tint * 0.35), 0.8);
      g.restore();
    }

    if (p.dust > 0 && state.motes.length) {
      for (const m of state.motes) {
        const fade = 1 - m.age / m.life;
        g.fillStyle = rgba('#b9a893', 0.4 * fade * p.dust);
        g.beginPath();
        g.arc(m.x, m.y, m.r * (1 + m.age), 0, TAU);
        g.fill();
      }
    }

    g.restore();
  },
};


/**
 * Feel forward one step at a time, over the wall and around whatever is on it.
 *
 * The previous version computed the whole arm from a wave function every frame,
 * which is cheap and has one fatal property: the arm has no memory, so it can
 * be waved straight across a window and off the side of the house, and nothing
 * it does one frame has any bearing on the next. What reads as *alive* is
 * precisely the memory — a limb that found its way round a window frame is
 * still round it a minute later, and the tangle on the wall is the record of
 * where it has been.
 *
 * So an arm now owns a path and extends it, exactly as the vine does. Four
 * things decide each step, in the order they are applied:
 *
 *  1. **Wander.** A slow drift, so nothing travels in a straight line.
 *  2. **Bare wall.** Of five candidate headings, prefer the one leading to
 *     ground the arms have used least. This is what spreads a clutch out over
 *     the brickwork instead of bundling it in one corner.
 *  3. **Frames.** Near a window or a door, swing towards the tangent of its
 *     edge, more strongly the closer it is — so an arm runs *along* a sill
 *     rather than bouncing off it. The hold falls away with distance so it lets
 *     go at the corner instead of orbiting the opening for ever.
 *  4. **Somewhere to put it.** Sweep outwards from the intended heading and
 *     take the smallest turn that is still on the wall and off the glass. If
 *     nothing within a right angle works, the arm is wedged: it gives up and
 *     pulls back, which is what stops one dying in a corner with its tip
 *     jammed in the brickwork.
 */
function crawl(arm, p, container, obstacles, state, dt, rng, w, h) {
  const thickness = Math.max(4, p.thickness) * arm.girth;
  // Long enough that the ribbon cannot pinch on a tight turn: the inside edge
  // of a bend has radius `step / turn - halfWidth`, and that has to stay
  // positive. Hence a step near the arm's own width and a hard cap on the turn.
  // Well under the arm's own width. Step length only has to clear the pinch
  // condition below; tying it to thickness one-for-one made a thick arm both
  // fat *and* unable to turn, which is why the last version had to be thinned
  // to the point of looking like string.
  const stepPx = Math.max(7, thickness * 0.55);
  /**
   * How sharply it can turn, and therefore whether it can get anywhere.
   *
   * These three numbers are one design, not three settings. An arm needs a
   * corridor `2 × ARM_MARGIN × thickness` wide to pass, and can only change
   * course on a radius of `stepPx / MAX_TURN`. Get the ratio wrong and the
   * arms wedge against the first window they meet and spend the evening as
   * stubs — which is exactly what a thickness of 34 did here: a 134-pixel
   * corridor requirement against a 107-pixel turning circle, on a facade whose
   * gaps are about 200 pixels wide.
   */
  const MAX_TURN = 0.26;
  const maxLen = Math.max(w, h) * 7 * p.reach * arm.length;
  const maxJoints = Math.max(4, Math.round(maxLen / stepPx));

  arm.timer += dt;

  // Reaching, then holding station and probing, then pulling back to try
  // somewhere else. Without the last two an arm reaches its full length in the
  // first ten seconds and is a fixed piece of scenery for the rest of the show.
  // Wedged is not the same as finished. An arm that cannot place its next
  // joint rotates and tries again for a third of a second before giving up on
  // this direction entirely; giving up on the first blocked step leaves it a
  // stub against the first window frame it meets.
  if (arm.phase2 === 'out' && arm.stuck > 20 && arm.path.length < maxJoints * 0.6) {
    /**
     * Wedged early: back off and try another way, rather than settling for it.
     *
     * An arm that meets a window frame in its first few steps used to go
     * straight to holding station, and hold it for ten seconds — so three arms
     * out of one breach near the roofline, where there is least room, were
     * three permanent stubs. Giving up a third of what it has grown and setting
     * off on a new heading costs nothing and is what something feeling its way
     * would do.
     */
    arm.stuck = 0;
    const drop = Math.max(1, Math.floor(arm.path.length / 3));
    for (let k = 0; k < drop && arm.path.length > 1; k++) arm.path.pop();
    arm.angle += (rng() < 0.5 ? -1 : 1) * (0.9 + rng() * 1.2);
  } else if (arm.phase2 === 'out' && (arm.path.length >= maxJoints || arm.stuck > 20)) {
    arm.phase2 = 'feel';
    arm.timer = 0;
    arm.stuck = 0;
  } else if (arm.phase2 === 'feel' && arm.timer > 6 + arm.girth * 6) {
    arm.phase2 = 'back';
    arm.timer = 0;
  } else if (arm.phase2 === 'back' && arm.path.length <= 2 && !arm.holdBack) {
    arm.phase2 = 'out';
    arm.timer = 0;
    // Back to a single joint at the hole, not to the two-joint stub retraction
    // happens to leave. Keeping the stub and setting off in a new direction
    // puts a fold of up to half a turn in the path, and the ribbon drawn over
    // that fold pinches shut and reads as a crease in the arm.
    arm.path.length = 0;
    arm.path.push({ x: arm.origin.x, y: arm.origin.y });
    // A fresh heading, so the next reach explores rather than retracing.
    arm.angle = -Math.PI / 2 + (rng() - 0.5) * 2.4;
  }

  const speed = Math.max(1, p.crawl) * (arm.pace ?? 1) * (arm.phase2 === 'back' ? 1.6 : 1);
  arm.carry += speed * dt;
  let steps = Math.floor(arm.carry / stepPx);
  if (steps > 6) {
    steps = 6;
    arm.carry = 0;
  } else {
    arm.carry -= steps * stepPx;
  }

  const cellOf = (x, y) => {
    const cx = Math.floor((x - container.bbox.x) / state.trailCell);
    const cy = Math.floor((y - container.bbox.y) / state.trailCell);
    if (cx < 0 || cy < 0 || cx >= state.trailCols || cy >= state.trailRows) return -1;
    return cy * state.trailCols + cx;
  };
  // Off the wall reads as thoroughly used, so nothing steers that way — but as
  // a finite number, because an infinity there would swamp every comparison.
  const usedAt = (x, y) => {
    const i = cellOf(x, y);
    return i < 0 ? 30 : Math.min(20, state.trail[i]);
  };

  for (let s = 0; s < steps; s++) {
    if (arm.phase2 === 'back') {
      arm.path.pop();
      if (arm.path.length <= 2) break;
      continue;
    }
    if (arm.path.length < 2) {
      // Just replanted: nothing to take a heading from yet, so step straight
      // out on the one it was given.
      const o = arm.path[0];
      const nx = o.x + Math.cos(arm.angle) * stepPx;
      const ny = o.y + Math.sin(arm.angle) * stepPx;
      if (stepClear(container, obstacles, nx, ny, arm.angle, thickness)) arm.path.push({ x: nx, y: ny });
      else arm.angle += 0.7;
      continue;
    }
    if (arm.phase2 === 'feel' && arm.path.length >= maxJoints) {
      /**
       * Probe from the far end, keeping the near end where it is.
       *
       * This used to drop the *oldest* joint as a new one was added, which does
       * keep the length constant and has an obvious consequence I missed: the
       * base creeps forward a step at a time until the whole arm has walked out
       * of its own hole and is crawling around the wall attached to nothing.
       * Retiring the newest joint instead lets the tip feel about while the arm
       * stays rooted in the breach it came out of.
       */
      arm.path.pop();
    }

    const tip = arm.path[arm.path.length - 1];
    let angle = arm.angle + (rng() - 0.5) * p.wander * 0.5;

    if (p.explore > 0) {
      let best = angle;
      let bestScore = Infinity;
      for (const offset of [0, 0.35, -0.35, 0.75, -0.75]) {
        const a = angle + offset;
        const dx = Math.cos(a);
        const dy = Math.sin(a);
        let score = Math.abs(offset) * 0.5; // all else equal, carry straight on
        for (const r of [1.2, 3, 6]) {
          score += usedAt(tip.x + dx * state.trailCell * r, tip.y + dy * state.trailCell * r) / r;
        }
        if (score < bestScore) {
          bestScore = score;
          best = a;
        }
      }
      angle += angleDelta(angle, best) * p.explore * 0.4;
    }

    const range = Math.max(10, thickness * 2.2);
    const near = nearestSurface(obstacles, tip.x, tip.y, range);
    if (near && p.cling > 0) {
      const tangent = Math.atan2(near.nx, -near.ny);
      const alt = tangent + Math.PI;
      const pick = Math.abs(angleDelta(angle, tangent)) < Math.abs(angleDelta(angle, alt))
        ? tangent
        : alt;
      const hold = p.cling * (1 - near.dist / range);
      angle += angleDelta(angle, pick) * hold * 0.8;
    }

    // The smallest turn that keeps the tip on the wall and off the glass.
    // Committing to one direction — `arm.turn` — rather than taking the best of
    // each side stops an arm oscillating in a corner, which is a lesson the
    // serpent learned the hard way.
    let placed = false;
    for (const swerve of [0, 0.12, 0.25, 0.4]) {
      for (const dir of swerve === 0 ? [1] : [arm.turn, -arm.turn]) {
        // Clamp *before* testing, not after.
        //
        // The first version picked a heading, tested the point it led to, and
        // then stepped in a different direction because the turn cap moved it —
        // so the point it actually landed on had never been checked, and arms
        // walked over windows and off the side of the house at a low rate. The
        // tested point and the placed point have to be the same point.
        const a = clampTurn(arm.angle, angle + swerve * dir, MAX_TURN);
        const nx = tip.x + Math.cos(a) * stepPx;
        const ny = tip.y + Math.sin(a) * stepPx;
        // Clear of the frames by the arm's own half-width, not just at the
        // centreline: a ribbon whose spine skims a sill still covers the glass.
        if (!isClear(container, obstacles, nx, ny)) continue;
        // Both flanks too, at the widest the drawn ribbon ever gets — spine
        // clearance alone is not clearance, because a ribbon whose centreline
        // skims a sill still covers the glass either side of it. `ARM_MARGIN`
        // is that widest half-width, swell and sway included; see drawArm.
        const px = Math.cos(a + Math.PI / 2) * thickness * ARM_MARGIN;
        const py = Math.sin(a + Math.PI / 2) * thickness * ARM_MARGIN;
        if (!isClear(container, obstacles, nx + px, ny + py)) continue;
        if (!isClear(container, obstacles, nx - px, ny - py)) continue;

        arm.angle = a;
        arm.path.push({ x: nx, y: ny });
        const cell = cellOf(nx, ny);
        if (cell >= 0 && state.trail[cell] < 65000) state.trail[cell] += 1;
        placed = true;
        break;
      }
      if (placed) break;
    }
    if (!placed) {
      arm.stuck = (arm.stuck || 0) + 1;
      // Try the other way round every few frames rather than every frame:
      // alternating on each attempt just rocks between two blocked headings.
      if (arm.stuck % 4 === 0) arm.turn *= -1;
      arm.angle += MAX_TURN * arm.turn;
      break;
    }
    arm.stuck = 0;
  }
}

/**
 * Is there room for the whole width of the arm here, not just its centreline?
 *
 * A ribbon whose spine skims a sill still covers the glass either side of it,
 * so both flanks are tested as well — at the widest the drawn arm ever gets.
 */
function stepClear(container, obstacles, x, y, angle, thickness) {
  if (!isClear(container, obstacles, x, y)) return false;
  const px = Math.cos(angle + Math.PI / 2) * thickness * ARM_MARGIN;
  const py = Math.sin(angle + Math.PI / 2) * thickness * ARM_MARGIN;
  return isClear(container, obstacles, x + px, y + py)
    && isClear(container, obstacles, x - px, y - py);
}

/**
 * How far out from the centreline an arm can ever be drawn, in units of its own
 * base half-width.
 *
 * Width peaks at the base at `swell` (1.16) and falls away; the sway peaks at
 * the tip and is scaled by u², where the width has dropped to about a fifth, so
 * the two are never both large and their sum stays near 1.16.
 *
 * The rest of the allowance is for a mismatch that is easy to miss. Clearance
 * is tested along the normal to the *step*, and the ribbon is built along the
 * normal to the *joint* — the average of two consecutive steps. On a bend those
 * differ by half the turn, which swings the flank by about width × 0.15. Left
 * at 1.2 that put roughly one drawn point in two thousand over a window: rare
 * enough to look like an accident and frequent enough to see all evening.
 *
 * The crawl keeps this much clear of every opening, which is the only reason a
 * tentacle can hug a frame without covering it.
 */
const ARM_MARGIN = 1.45;

/** Move `from` towards `to` by at most `limit` radians. */
function clampTurn(from, to, limit) {
  const d = angleDelta(from, to);
  return from + clamp(d, -limit, limit);
}

/** Shortest signed difference between two angles. */
function angleDelta(from, to) {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/**
 * Interpolate a smoother spine through the crawled one.
 *
 * The crawl steps about two thirds of the arm's width at a time and the ribbon
 * joins those with straight lines, so the outline is visibly faceted — a
 * tentacle made of flat panels. The obvious fix is to draw curves between the
 * joints instead, and it is a trap: `fitWidths` validates *vertices*, and a
 * curve bulges away from them into space nothing has checked. Two separate
 * rounds of this file have been spent on exactly that class of mistake.
 *
 * Adding vertices has no such problem. A Catmull-Rom pass through the existing
 * joints puts a point every few pixels, the outline is straight between them so
 * it stays where it is drawn, and the clearance pass then validates all of them
 * — smoother *and* still provably off the glass.
 */
function subdivide(joints, widths, k, container, obstacles) {
  if (k < 2 || joints.length < 3) return { joints, widths };
  const n = joints.length;
  const at = (i) => joints[Math.max(0, Math.min(n - 1, i))];
  const wAt = (i) => widths[Math.max(0, Math.min(n - 1, i))];
  const outJ = [];
  const outW = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    for (let s = 0; s < k; s++) {
      const t = s / k;
      const t2 = t * t;
      const t3 = t2 * t;
      // Standard Catmull-Rom. Passes through every original joint, so the
      // crawl's own path is preserved exactly and only the gaps are filled.
      let x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      let y = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
      /**
       * A spline overshoots on the outside of a tight bend, and a point that
       * lands inside a window cannot be rescued by thinning the arm there —
       * thinning pulls the flanks in towards a spine that is already on the
       * glass. So an interpolated point that is not clear falls back to the
       * straight line between the two crawled joints, and failing that to the
       * nearer of the two, both of which the crawl validated when it placed
       * them. The smoothing is a nicety; the containment is not.
       */
      if (container && !isClear(container, obstacles, x, y)) {
        x = p1.x + (p2.x - p1.x) * t;
        y = p1.y + (p2.y - p1.y) * t;
        if (!isClear(container, obstacles, x, y)) {
          const near = t < 0.5 ? p1 : p2;
          x = near.x;
          y = near.y;
        }
      }
      outJ.push({ x, y });
      outW.push(wAt(i) + (wAt(i + 1) - wAt(i)) * t);
    }
  }
  outJ.push(at(n - 1));
  outW.push(wAt(n - 1));
  return { joints: outJ, widths: outW };
}

/**
 * Pull in the half-width anywhere the ribbon's own outline would not fit.
 *
 * Uses exactly the normal `tentacleRibbon` uses, because the whole point is to
 * measure the outline that gets drawn rather than an approximation of it.
 */
function fitWidths(container, obstacles, joints, widths) {
  const n = joints.length;
  for (let i = 0; i < n; i++) {
    const a = joints[i];
    const b = joints[Math.min(i + 1, n - 1)];
    const prev = joints[Math.max(i - 1, 0)];
    const angle = Math.atan2(b.y - prev.y, b.x - prev.x) + Math.PI / 2;
    const cx = Math.cos(angle);
    const cy = Math.sin(angle);

    /**
     * No wider than the bend can carry.
     *
     * On the inside of a turn the flank sits at radius `step / turn − width`;
     * once that goes negative the inner edge has crossed the centreline and the
     * ribbon is drawn inside out, as a bow-tie. Bounding the *turn* to keep it
     * positive is the tempting fix and it costs all the movement, because the
     * turn is mostly the sway and the sway is the life in the thing. Bounding
     * the *width* costs nothing anybody can see: an arm thins slightly where it
     * flexes hardest, which is what a limb does.
     */
    if (i > 0 && i < n - 1) {
      const inA = Math.atan2(a.y - prev.y, a.x - prev.x);
      const outA = Math.atan2(b.y - a.y, b.x - a.x);
      const turn = Math.abs(((outA - inA + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      const step = Math.hypot(a.x - prev.x, a.y - prev.y);
      // No floor worth speaking of: on a hairpin in an offset curve `step` can
      // be very nearly zero, and a floor there is precisely the case that
      // inverts. A tentacle with a sub-pixel pinch point is invisible; one
      // drawn as a bow-tie is not.
      if (turn > 1e-4) widths[i] = Math.min(widths[i], Math.max(0.15, (step / turn) * 0.8));
    }

    let w = widths[i];
    let fits = false;
    /**
     * Halve until it fits, down to a sixty-fourth of the width.
     *
     * Four halvings was not enough at the tip, and the reason is worth keeping:
     * the corridor the crawl reserves is a *line* either side of the step
     * direction, not a disc, and it checks nothing ahead of the last joint. So
     * a tip can legitimately sit a pixel short of a window edge, and the sway —
     * which is at its largest exactly there — can swing the ribbon's normal far
     * enough round to point the flank straight at it. Six halvings puts the
     * flank inside a fifth of a pixel of the spine, which is clear.
     */
    /**
     * Sampled along the ray, not just at its end.
     *
     * Testing the outermost point only is not enough, and the reason is a nice
     * one: clearance is not convex. The rim is drawn at the full width and the
     * body inside it at 85%, and a ray that leaves the spine, crosses a window
     * and comes out the far side has a *clear* endpoint and an obscured middle
     * — so the wider ribbon passed and the narrower one drawn inside it landed
     * on the glass. Every radius that actually gets drawn is checked.
     */
    for (let tries = 0; tries < 6; tries++) {
      let clear = true;
      for (const f of [1, 0.85, 0.45]) {
        if (!isClear(container, obstacles, a.x + cx * w * f, a.y + cy * w * f)
          || !isClear(container, obstacles, a.x - cx * w * f, a.y - cy * w * f)) {
          clear = false;
          break;
        }
      }
      if (clear) {
        fits = true;
        break;
      }
      w *= 0.5;
    }
    // And if even a sixty-fourth does not fit, pinch to the centreline. The
    // spine is clear by construction, so a flank *on* it is clear too — which
    // makes this the one width that is guaranteed correct rather than merely
    // very likely, and it is the difference between four stray pixels an
    // evening and none. It costs a nick a fraction of a pixel wide.
    widths[i] = Math.min(widths[i], fits ? w : 0);
  }

  /**
   * And no sudden steps in the result.
   *
   * Both of the rules above act on one vertex at a time, so a single tight spot
   * — a bend against a window reveal, a spline point that had to be pulled back
   * — takes that vertex to nothing while its neighbours stay full width. The
   * ribbon then has a notch cut out of it, which after all this work is the one
   * thing that still looked machine-made.
   *
   * Two passes limit how fast the width may fall away, forwards and backwards.
   * Both only ever *reduce* a width, so everything above still holds: a pinch
   * becomes a smooth taper into it and out the other side, which is what a limb
   * squeezing past something looks like anyway.
   */
  const SLOPE = 0.55;
  for (let i = 1; i < n; i++) {
    const step = Math.hypot(joints[i].x - joints[i - 1].x, joints[i].y - joints[i - 1].y);
    widths[i] = Math.min(widths[i], widths[i - 1] + SLOPE * step);
  }
  for (let i = n - 2; i >= 0; i--) {
    const step = Math.hypot(joints[i + 1].x - joints[i].x, joints[i + 1].y - joints[i].y);
    widths[i] = Math.min(widths[i], widths[i + 1] + SLOPE * step);
  }

  /**
   * Then check the smoothed widths, because *reducing* one is not safe either.
   *
   * That reads as nonsense and is the third time this exact property has bitten
   * this file: clearance is not convex, so a flank pulled *in* can land inside
   * a window that the wider one cleared by passing over it and out the far
   * side. The fit above samples a few radii along each ray for exactly that
   * reason, and the smoothing then moves the width to one it never sampled.
   *
   * So the final answer is verified, and pinches to the centreline if it has
   * to. A notch here is rare — it needs the smoothing to have lowered a width
   * into an obstructed band — and its neighbours are already tapered, so what
   * survives is a narrowing rather than the square-cut gap this pass exists to
   * remove.
   */
  for (let i = 0; i < n; i++) {
    const a = joints[i];
    const b = joints[Math.min(i + 1, n - 1)];
    const prev = joints[Math.max(i - 1, 0)];
    const angle = Math.atan2(b.y - prev.y, b.x - prev.x) + Math.PI / 2;
    const cx = Math.cos(angle);
    const cy = Math.sin(angle);
    let w = widths[i];
    // Only a width of exactly nothing is accepted unchecked. A fifth of a pixel
    // sounds like nothing and is still a pixel wide once it is projected.
    let fits = w <= 0;
    for (let tries = 0; tries < 6 && !fits; tries++) {
      // Every radius that gets drawn, not just the outermost: the rim goes at
      // the full width and the body inside it at 85%, and a ray that crosses a
      // window and comes out the far side clears at one and not the other.
      let clear = true;
      for (const f of [1, 0.85, 0.45]) {
        if (!isClear(container, obstacles, a.x + cx * w * f, a.y + cy * w * f)
          || !isClear(container, obstacles, a.x - cx * w * f, a.y - cy * w * f)) {
          clear = false;
          break;
        }
      }
      if (clear) fits = true;
      else w *= 0.6;
    }
    widths[i] = fits ? w : 0;
  }
}

/**
 * One tentacle, drawn along the path it has crawled.
 *
 * The shape is no longer computed here — `crawl` owns that, and it owns it over
 * time. What is left is the two things that have to happen every frame: a sway,
 * and a skin.
 *
 * The sway is a travelling wave applied as a *lateral offset* to the stored
 * path, scaled by the square of the distance along it. That scaling is the
 * whole trick: it is zero at the base, so the arm stays planted in its hole and
 * whatever it has wrapped itself around stays wrapped; and it is largest at the
 * tip, which is the part that should look like it is feeling for something. An
 * arm that has snarled itself over three metres of brickwork still breathes,
 * without any of it sliding across the wall.
 */
function drawArm(g, p, hole, arm, t, w, h, alive = 1, container = null, obstacles = []) {
  const age = t - arm.bornAt;
  if (age < 0 || alive <= 0.02 || !arm.path || arm.path.length < 3) return;
  const out = clamp(age / 1.2, 0, 1) * alive;
  const emerge = out * out * (3 - 2 * out); // smoothstep
  if (emerge < 0.01) return;

  let n = arm.path.length;
  const base = Math.max(4, p.thickness) * arm.girth;
  const wave = t * p.writhe * arm.rate + arm.phase;
  const writhe = clamp(p.writhe, 0, 3);

  /**
   * Two different measures of "how far along", because they answer two
   * different questions.
   *
   * How *thick* the arm is at a point is a fact about the limb: a place a metre
   * from the body is the same thickness whether the arm is half out or fully
   * extended. Taken as a fraction of the current length — which is what this
   * did — every joint's thickness changes as the arm grows, so the whole thing
   * visibly slims down as it reaches out, and thickens again as it retracts.
   * That is the "width seems a bit odd" of it. Distance from the base, against
   * the arm's own full reach, is the honest measure.
   *
   * How much a point *moves*, on the other hand, really is about position
   * relative to the free end — the last stretch of a half-grown arm waves as
   * freely as the last stretch of a fully grown one. So the sway keeps the
   * fractional measure.
   */
  const along = [0];
  for (let i = 1; i < n; i++) {
    along.push(along[i - 1] + Math.hypot(arm.path[i].x - arm.path[i - 1].x, arm.path[i].y - arm.path[i - 1].y));
  }
  const fullReach = Math.max(1, Math.max(w, h) * 7 * p.reach * arm.length);

  const joints = [];
  const widths = [];
  for (let i = 0; i < n; i++) {
    const u = Math.min(1, along[i] / fullReach);
    const v = i / (n - 1);
    const a = arm.path[i];
    const b = arm.path[Math.min(i + 1, n - 1)];
    const prev = arm.path[Math.max(i - 1, 0)];
    const dir = Math.atan2(b.y - prev.y, b.x - prev.x);
    // Sideways, and only sideways: pushing along the path would make the arm
    // appear to slide in and out of its own hole.
    // Capped at 0.3 of the base half-width and scaled by u², which is what
    // keeps the drawn arm inside the clearance the crawl reserved for it.
    /**
     * The whole body moves, not just the last few centimetres.
     *
     * The first version capped the sway at a third of the arm's width and
     * scaled it by u², which meant a limb that had reached its full extent sat
     * dead still with a twitching tip. That is the opposite of alive. It is now
     * a little over a whole width at the far end, falling off close to linearly
     * rather than quadratically, so an arm holding station against a wall is
     * visibly thrashing along its length while its base stays put in the hole.
     *
     * Two waves rather than one, at different rates and wavelengths, because a
     * single sine is a skipping rope: it has one belly and it swings like a
     * pendulum. Beating two against each other gives the irregular, muscular
     * motion the thing is supposed to have.
     */
    const smooth = Math.min(1, (n - 3) / 6);
    const amp = base * 1.15 * Math.min(writhe, 2) * Math.pow(v, 1.15) * emerge * smooth;
    const swing = (Math.sin(wave - v * 2.7) * 0.68 + Math.sin(wave * 1.63 - v * 5.6 + arm.phase) * 0.32) * amp;

    // Held wide down most of the arm, falling away late, and stopping at a
    // fifth of the base rather than at a point. `1 - u` gives a triangle, and a
    // triangle is a leaf.
    const taper = 1 - 0.8 * Math.pow(u, 2.2);
    const swell = 1 + 0.16 * Math.sin(along[i] * 0.035 + arm.phase);
    const width = Math.max(1.5, base * taper * swell * (0.5 + 0.5 * emerge));
    widths.push(width);

    /**
     * The sway must not put the arm where the crawl refused to go.
     *
     * The crawl reserves a corridor around the path, and it is tempting to
     * argue that the sway is small enough to stay inside it — the sum peaks
     * around 1.1 of the base half-width against a reserved 1.45, so on paper it
     * cannot reach a window. On paper. In practice this leaked about one drawn
     * point in a thousand onto the glass, and an argument that predicts zero
     * and delivers hundreds is an argument with a hole in it, not a margin that
     * needs widening.
     *
     * So the drawn position is checked rather than reasoned about: if the
     * swayed joint is not clear at its own width, the arm is drawn at the joint
     * the crawl actually validated. It costs one containment test per joint and
     * it is true regardless of what any of the constants are set to.
     */
    let sx = a.x;
    let sy = a.y;
    if (container && swing !== 0) {
      // Wound in until it fits, rather than dropped to nothing the moment it
      // does not. Snapping a joint back to the path while its neighbours stay
      // swung out puts a kink in the arm; halving lets it lie against a window
      // frame instead — which is also what it should look like.
      let reach = swing;
      for (let tries = 0; tries < 4; tries++) {
        const tx = a.x + Math.cos(dir + Math.PI / 2) * reach;
        const ty = a.y + Math.sin(dir + Math.PI / 2) * reach;
        if (stepClear(container, obstacles, tx, ty, dir, width)) {
          sx = tx;
          sy = ty;
          break;
        }
        reach *= 0.5;
      }
    } else {
      sx = a.x + Math.cos(dir + Math.PI / 2) * swing;
      sy = a.y + Math.sin(dir + Math.PI / 2) * swing;
    }
    joints.push({ x: sx, y: sy });
  }

  // Smooth first, then fit: every vertex the smoothing introduces has to be
  // checked like any other, and checking before adding them would be checking
  // the wrong outline.
  const dense = subdivide(joints, widths, 3, container, obstacles);
  joints.length = 0;
  widths.length = 0;
  joints.push(...dense.joints);
  widths.push(...dense.widths);
  n = joints.length;

  /**
   * And where even the reduced sway leaves a flank over a window or off the
   * gable, thin the arm there instead.
   *
   * The flanks are laid out along the normal at each *joint* — the bisector of
   * two adjacent segments — which is not the direction anything upstream tested
   * against. Rather than add a third approximation, the outline is measured
   * where it will actually be drawn and the half-width halved until it fits.
   * A tentacle that narrows slightly as it squeezes past a window frame is
   * invisible; one that covers the glass is the only thing anybody notices.
   */
  if (container) fitWidths(container, obstacles, joints, widths);

  /**
   * Base to tip as one gradient down the arm's own axis.
   *
   * The cheap version of this — fill the whole arm dark, then fill the outer
   * half light — puts a hard tonal step across the middle of every tentacle,
   * and the eye reads that step as a joint in the limb.
   */
  const tip0 = joints[n - 1];
  const ramp = g.createLinearGradient(joints[0].x, joints[0].y, tip0.x, tip0.y);
  ramp.addColorStop(0, mixHex(p.armColor, '#000000', 0.35));
  ramp.addColorStop(0.45, p.armColor);
  ramp.addColorStop(1, mixHex(p.armColor, p.armTip, 0.75));
  /**
   * A dark rim, then the body inside it.
   *
   * A limb on a lit brick wall needs an edge or it reads as a decal, and a
   * stroked outline is not an option — two pixels of line is nothing on a
   * projector. So the rim is the full fitted width and the body is drawn at
   * 85% of it, which leaves a band of shadow all the way round.
   *
   * The obvious way round — body at full width, rim *wider* — puts the rim
   * outside the width that was fitted to the space available, and the arm goes
   * straight back to painting the windows. Nothing may be drawn wider than
   * `widths`; that is the whole contract.
   */
  g.fillStyle = rgba('#000000', 0.5);
  tentacleRibbon(g, joints, widths);

  g.fillStyle = ramp;
  tentacleRibbon(g, joints, widths.map((v) => v * 0.85));

  /**
   * A highlight down one side, as a narrower ribbon rather than a stroked line.
   * At projector resolution a one-pixel specular line is not there at all; a
   * shape a third the width of the arm survives being halved.
   *
   * Offset along the arm's own normal, and kept inside the width that has
   * already been fitted to the space available — 0.32 out plus 0.3 of its own
   * is 0.62 of the main ribbon, so it cannot reach anywhere the main ribbon has
   * not already been cleared for. The previous version offset it along a fixed
   * diagonal, which took no account of which way the arm was pointing and put
   * it outside the fitted envelope wherever the arm ran at forty-five degrees.
   */
  const lit = joints.map((j, i) => {
    const b = joints[Math.min(i + 1, n - 1)];
    const prev = joints[Math.max(i - 1, 0)];
    const nrm = Math.atan2(b.y - prev.y, b.x - prev.x) + Math.PI / 2;
    const lx = j.x + Math.cos(nrm) * widths[i] * 0.28;
    const ly = j.y + Math.sin(nrm) * widths[i] * 0.28;
    // `fitWidths` bounds a ribbon's flanks against its own spine; it cannot
    // rescue a spine that is itself somewhere it should not be. The main one is
    // clear by construction — the crawl put it there — but this one is offset
    // from it, so it gets checked.
    // With room for its own width, not merely on the right side of the line:
    // a spine cleared to the last pixel leaves its flanks over the edge.
    if (container && !stepClear(container, obstacles, lx, ly, nrm - Math.PI / 2, widths[i] * 0.4)) {
      return { x: j.x, y: j.y };
    }
    return { x: lx, y: ly };
  });
  const litWidths = widths.map((v) => v * 0.26);
  // The highlight is a second polygon with its own spine and its own bends, so
  // it needs the same treatment as the first. Fitting the main ribbon and
  // assuming the smaller one inside it must be fine is exactly the kind of
  // reasoning that has been wrong twice already in this file.
  if (container) fitWidths(container, obstacles, lit, litWidths);
  g.fillStyle = rgba('#ffffff', 0.09);
  tentacleRibbon(g, lit, litWidths);

  /**
   * Suckers, down one side.
   *
   * The thing that finally stops this reading as foliage. Sized off the local
   * width so they thin out with the arm, and spaced by index rather than by
   * distance because the path is already evenly stepped. At the resolution this
   * is aimed at, the smallest of them is still a couple of projector pixels
   * across — which is why they are discs rather than the ring-and-centre a
   * photograph would show.
   */
  if (p.suckers > 0) {
    /**
     * Spaced along the arm, not one per joint.
     *
     * They used to be placed per joint, and the joint spacing is set by the
     * crawl step and then tripled by the smoothing — so they came out as a
     * solid overlapping chain, which is most of what read as blocky. Walking
     * the arm by distance and dropping one every couple of diameters puts them
     * where they belong regardless of how finely the spine happens to be
     * divided, and they thin out towards the tip with the arm.
     *
     * Ellipses rather than circles, squashed along the arm's own axis: a sucker
     * is a disc on the side of a cylinder, so from any angle worth drawing it
     * is foreshortened. That one detail does more than the size or the spacing.
     */
    const side = arm.side ?? 1;
    let since = Infinity;
    for (let i = 1; i < n - 1; i++) {
      const a = joints[i];
      const b = joints[i + 1];
      const seg = Math.hypot(b.x - a.x, b.y - a.y);
      since += seg;
      const r = widths[i] * 0.22;
      if (r < 1.2) continue;
      if (since < r * 4.4) continue;
      since = 0;

      const along = Math.atan2(b.y - a.y, b.x - a.x);
      const nrm = along + (Math.PI / 2) * side;
      // A little variation in size and offset, or a row of identical discs
      // reads as machined rather than grown.
      const vary = 0.82 + 0.36 * Math.abs(Math.sin(i * 1.7 + arm.phase));
      g.fillStyle = rgba(mixHex(p.armTip, '#ffffff', 0.12), 0.3 * p.suckers);
      g.save();
      g.translate(a.x + Math.cos(nrm) * widths[i] * 0.4, a.y + Math.sin(nrm) * widths[i] * 0.4);
      g.rotate(along);
      g.beginPath();
      g.ellipse(0, 0, r * vary * 0.62, r * vary, 0, 0, TAU);
      g.fill();
      // The rim, a shade darker, which is what stops them looking like paint.
      g.fillStyle = rgba(mixHex(p.armColor, '#000000', 0.4), 0.3 * p.suckers);
      g.beginPath();
      g.ellipse(0, r * vary * 0.22, r * vary * 0.34, r * vary * 0.42, 0, 0, TAU);
      g.fill();
      g.restore();
    }
  }

  // A blunt, rounded end rather than a point with a light on it — that version
  // read as a firefly sitting on a stalk.
  // Inside the fitted width like everything else — this is a disc centred on
  // the tip, and the tip is exactly where the fitting is tightest.
  const tipR = Math.max(0.5, widths[n - 1] * 0.95);
  g.fillStyle = mixHex(p.armColor, p.armTip, 0.75);
  g.beginPath();
  g.arc(tip0.x, tip0.y, tipR, 0, TAU);
  g.fill();
  g.save();
  g.globalCompositeOperation = 'lighter';
  glow(g, tip0.x, tip0.y, tipR * 3, p.armTip, 0.22 * emerge);
  g.restore();
}

export default [brickwork, breach];
