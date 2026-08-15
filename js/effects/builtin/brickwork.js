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

import { rgba, clamp, TAU, mixHex, makeRng, pointInPolygon, smoothstep } from '../../core/math.js';
import { collectObstacles } from '../obstacles.js';
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
    { key: 'armColor', type: 'color', label: 'Tentacle', default: '#24402c' },
    { key: 'armTip', type: 'color', label: 'Tentacle tip', default: '#8ccc52' },
    { key: 'thickness', type: 'range', label: 'Tentacle thickness', default: 34, min: 4, max: 110, step: 1 },
    { key: 'suckers', type: 'range', label: 'Suckers', default: 0.9, min: 0, max: 1, step: 0.01 },
    { key: 'reach', type: 'range', label: 'Reach', default: 0.9, min: 0.1, max: 3, step: 0.05 },
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
          hole.arms.push({
            phase: rng() * TAU,
            lean: (rng() - 0.5) * 1.5,
            rate: 0.55 + rng() * 0.7,
            length: 0.7 + rng() * 0.6,
            bend: (rng() - 0.5) * 0.9,
            curl: (rng() < 0.5 ? -1 : 1) * (0.8 + rng() * 0.8),
            offset: (rng() - 0.5) * 0.8,
            girth: 0.65 + rng() * 0.7,
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
      if (p.heal > 0 && !hole.pending.length && hole.openFor > p.heal) {
        hole.closing = Math.min(1, hole.closing + step / 1.8);
        if (hole.closing >= 1) {
          for (const brick of hole.gone) state.taken.delete(brick);
          state.holes.splice(i, 1);
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
          drawArm(g, p, hole, arm, t, w, h, 1 - hole.closing);
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
 * One tentacle, from the hole out into the room.
 *
 * A travelling wave along the arm rather than a wobble applied to the whole of
 * it: the base stays put in the hole and each joint lags the one before, which
 * is what makes it look like something pushing itself out rather than a piece
 * of rope being shaken. The emergence is the same curve run on the length, so
 * an arm grows out of the wall instead of appearing at full extent.
 *
 * The first version of this read as a blade of grass, and the reasons are worth
 * keeping: it was one flat colour, it tapered linearly to a point, and it swung
 * in a smooth arc. A limb is none of those. So the taper is now a curve that
 * keeps the base fat and thins late; the girth breathes along its length so it
 * reads as muscle rather than as a triangle; the outer half is painted a second
 * time towards the tip colour, which does the work of a gradient for the price
 * of a fill; and there is a droop, so the far end has weight.
 */
function drawArm(g, p, hole, arm, t, w, h, alive = 1) {
  const age = t - arm.bornAt;
  if (age < 0 || alive <= 0.02) return;
  const out = clamp(age / 1.6, 0, 1) * alive;
  const emerge = out * out * (3 - 2 * out); // smoothstep
  if (emerge < 0.01) return;

  const JOINTS = 17;
  // Shorter and fatter than the first version. A tentacle that is eight times
  // longer than it is wide is a blade of grass whatever else you do to it; the
  // ones that read are nearer five.
  const span = Math.max(w, h) * 2.6 * p.reach * arm.length * emerge;
  const base = Math.max(4, p.thickness) * arm.girth;
  const wave = t * p.writhe * arm.rate + arm.phase;
  const writhe = clamp(p.writhe, 0, 3);

  const joints = [];
  const widths = [];
  // Spread the origins across the hole rather than stacking every arm on its
  // centre, which produces a rosette — the single most plant-like thing a
  // clutch of tentacles can do.
  let x = hole.cx + arm.offset * w * 0.5;
  let y = hole.cy + arm.offset * h * 0.3;
  // Out of the hole and generally upward-ish, leaning by a per-arm amount so a
  // clutch of them fans out rather than stacking on one another.
  let angle = -Math.PI / 2 + arm.lean;
  const heading = angle;

  for (let i = 0; i < JOINTS; i++) {
    const u = i / (JOINTS - 1);
    joints.push({ x, y });

    // Taper: held wide down most of the arm, falling away late, and stopping
    // at a fifth of the base rather than at a point. `1 - u` gives a triangle,
    // and a triangle is a leaf; a point with a bright dot on it is a reed.
    const taper = 1 - 0.8 * Math.pow(u, 2.2);
    // And a slow swell along the length, so it is a limb rather than a cone.
    const swell = 1 + 0.16 * Math.sin(u * 7.5 + arm.phase);
    widths.push(Math.max(1.5, base * taper * swell * (0.5 + 0.5 * emerge)));

    const seg = span / (JOINTS - 1);
    /**
     * The heading at each joint, set outright rather than accumulated.
     *
     * Integrating a per-joint turn is the obvious way to do this and it is a
     * trap: the increments do not cancel, so the arm coils into a hairpin and
     * reads as a bent drinking straw. Clamping the running total fixes the
     * coiling and costs all the character — a clamped arm is a straight reed.
     *
     * Setting the angle directly cannot drift, because it is a bounded function
     * of position along the arm rather than a sum of anything. The wave fits
     * about two thirds of a cycle, which is one lazy S; each joint further out
     * lags further behind it and swings wider, so the tip does most of the
     * moving, as it should.
     */
    // And bounded, because the terms can otherwise sum to more than a full
    // turn at the top of the Writhe and Reach ranges — which puts the coiling
    // straight back, just only for people who move the sliders. Ninety-odd
    // degrees off the launch heading is as far as anything needs to bend, and
    // the clamp is on the deviation rather than on a running total, so it never
    // flattens an arm that is merely sinuous.
    const bend = clamp(
      Math.sin(wave - u * 4.2) * 0.6 * (0.1 + u * 1.1) * writhe
      + arm.bend * u                 // a fixed lean of its own, so a clutch differs
      + 0.5 * u * u                  // weight: the far end knows which way is down
      // And a curl in the last third. This is the single strongest signal that
      // a thing is a limb and not a leaf: leaves do not hook.
      + arm.curl * emerge * smoothstep(0.55, 1, u) * 1.5,
      -1.6,
      1.6
    );
    angle = heading + bend;
    x += Math.cos(angle) * seg;
    y += Math.sin(angle) * seg;
  }

  /**
   * Base to tip as one gradient down the arm's own axis.
   *
   * The cheap version of this — fill the whole arm dark, then fill the outer
   * half light — puts a hard tonal step across the middle of every tentacle,
   * and the eye reads that step as a joint in the limb. A gradient object per
   * arm per frame is a few microseconds and there are never more than a couple
   * of dozen arms; this is not the expensive part of anything.
   */
  const tip0 = joints[JOINTS - 1];
  const ramp = g.createLinearGradient(joints[0].x, joints[0].y, tip0.x, tip0.y);
  ramp.addColorStop(0, mixHex(p.armColor, '#000000', 0.35));
  ramp.addColorStop(0.45, p.armColor);
  ramp.addColorStop(1, mixHex(p.armColor, p.armTip, 0.75));
  g.fillStyle = ramp;
  tentacleRibbon(g, joints, widths);

  // A highlight down one side, as a narrower ribbon rather than a stroked line.
  // At projector resolution a one-pixel specular line is not there at all; a
  // shape a third the width of the arm survives being halved.
  const lit = joints.map((j, i) => ({ x: j.x - widths[i] * 0.32, y: j.y - widths[i] * 0.32 }));
  g.fillStyle = rgba('#ffffff', 0.1);
  tentacleRibbon(g, lit, widths.map((v) => v * 0.28));

  /**
   * Suckers, down the inside of the curve.
   *
   * The thing that finally stops this reading as foliage. They are placed on
   * whichever side the tip curls towards, which is where they would be, and
   * sized off the local width so they thin out with the arm. At the resolution
   * this is aimed at, the smallest of them is still a couple of projector
   * pixels across — which is exactly why they are drawn as discs rather than as
   * the ring-and-centre a photograph would show.
   */
  if (p.suckers > 0) {
    const side = arm.curl >= 0 ? 1 : -1;
    g.fillStyle = rgba(mixHex(p.armTip, '#ffffff', 0.2), 0.4 * p.suckers);
    for (let i = 2; i < JOINTS - 1; i++) {
      const a = joints[i];
      const b = joints[i + 1];
      const n = Math.atan2(b.y - a.y, b.x - a.x) + (Math.PI / 2) * side;
      const r = widths[i] * 0.25;
      if (r < 1.2) continue;
      g.beginPath();
      g.arc(a.x + Math.cos(n) * widths[i] * 0.42, a.y + Math.sin(n) * widths[i] * 0.42, r, 0, TAU);
      g.fill();
    }
  }

  // A blunt, rounded end rather than a point with a light on it — that version
  // read as a firefly sitting on a stalk.
  const tip = tip0;
  const tipR = Math.max(2, widths[JOINTS - 1]);
  g.fillStyle = mixHex(p.armColor, p.armTip, 0.75);
  g.beginPath();
  g.arc(tip.x, tip.y, tipR, 0, TAU);
  g.fill();
  g.save();
  g.globalCompositeOperation = 'lighter';
  glow(g, tip.x, tip.y, tipR * 3, p.armTip, 0.22 * emerge);
  g.restore();
}

export default [brickwork, breach];
