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

import { rgba, clamp, lerp, TAU, mixHex, hexToRgb } from '../../core/math.js';
import { blackbodyBytes } from '../color.js';
import {
  collectObstacles,
  deflect,
  isClear,
  findFreeSpot,
  nearestSurface,
} from '../obstacles.js';
import { glow, offscreen, curveThrough } from '../lib.js';

/** Where the obstacle list is spelled out. Shared so the wording stays consistent. */
const OBSTACLE_PARAM = {
  key: 'obstacles',
  type: 'text',
  label: 'Solid tags',
  default: 'window, door',
};

/**
 * How long between one runner emerging and the next.
 *
 * Long enough that a full-strength plant visibly builds up rather than arriving,
 * short enough that the default six are all working inside ten seconds — which
 * matters because somebody who has just added the layer is watching it.
 */
const EMERGE_SECONDS = 1.4;

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
    { key: 'size', type: 'range', label: 'Radius', default: 17, min: 2, max: 90, step: 0.5 },
    { key: 'speed', type: 'range', label: 'Speed', default: 260, min: 20, max: 1400, step: 10 },
    { key: 'gravity', type: 'range', label: 'Gravity', default: 0, min: 0, max: 2500, step: 10 },
    { key: 'restitution', type: 'range', label: 'Bounciness', default: 0.96, min: 0.3, max: 1, step: 0.01 },
    { key: 'liveliness', type: 'range', label: 'Liveliness', default: 0.3, min: 0, max: 1, step: 0.01 },
    OBSTACLE_PARAM,
    { key: 'trail', type: 'range', label: 'Trail', default: 0.45, min: 0, max: 1, step: 0.01 },
    { key: 'glow', type: 'range', label: 'Glow', default: 1.6, min: 0, max: 4, step: 0.05 },
  ],
  init() {
    return { balls: [], hits: [] };
  },
  step({ p, shape, t, dt, rng, state, shapes }) {
    const container = shape;
    if (container.bbox.w <= 2 || container.bbox.h <= 2) return;
    if (!state.hits) state.hits = [];

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

        const vx0 = b.vx;
        const vy0 = b.vy;
        let hit = deflect(container.points, b, radius, p.restitution, true);
        for (const o of obstacles) {
          const { bbox } = o;
          // Cheap rejection first: most balls are nowhere near most windows.
          if (
            b.x < bbox.x - radius
            || b.x > bbox.x + bbox.w + radius
            || b.y < bbox.y - radius
            || b.y > bbox.y + bbox.h + radius
          ) continue;
          hit = deflect(o.points, b, radius, p.restitution, false) || hit;
        }
        /**
         * Where it struck, and how hard.
         *
         * The surface normal is the direction the velocity was pushed in, so
         * the contact is a radius back along it from the ball. Recorded here,
         * in the simulation, so every tab flashes the same impacts; and only
         * for a real blow, not for a ball resting on a sill with gravity
         * pressing it down on every substep.
         */
        if (hit) {
          const dvx = b.vx - vx0;
          const dvy = b.vy - vy0;
          const blow = Math.hypot(dvx, dvy);
          if (blow > Math.max(40, p.speed * 0.25)) {
            const nx = dvx / blow;
            const ny = dvy / blow;
            b.hitAt = t;
            b.hitNx = nx;
            b.hitNy = ny;
            state.hits.push({ x: b.x - nx * radius, y: b.y - ny * radius, nx, ny, t, tint: b.tint, blow });
            if (state.hits.length > 48) state.hits.shift();
          }
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
    // A flash outlives its own drawing by a little, and no more.
    while (state.hits.length && t - state.hits[0].t > 1) state.hits.shift();
  },
  /**
   * Balls of light, and what they do when they hit something.
   *
   * Each ball is an emitter: a bright sphere with a near-white highlight and,
   * round it, a halo falling off as an inverse square — both baked once per
   * tint and stamped, rather than two gradients built for every ball every
   * frame. Behind it, its path as a tapering streak of the same light, which
   * is what a bright thing moving fast looks like on a photograph and what a
   * line of constant width did not.
   *
   * And every ricochet shows. The simulation records where and how hard each
   * ball struck, and here that becomes a burst of light at the contact with a
   * half-ring thrown off the surface, and the ball squashed against it for a
   * moment. Without it a ball turning round beside a window frame looks like a
   * ball that changed its mind; with it, it bounced *off the window*, which is
   * the whole idea of the effect.
   */
  draw({ g, p, shape, t, state, stable }) {
    const container = shape;
    if (container.bbox.w <= 2 || container.bbox.h <= 2) return;
    const radius = Math.max(1, p.size);
    const sprites = ballSprites(state, stable);
    const alpha = g.globalAlpha;
    const tintOf = (v) => sprites[Math.round(clamp(v, 0, 1) * (BALL_TINTS - 1))];

    g.save();
    g.clip(container.path);
    g.globalCompositeOperation = 'lighter';

    for (const hit of state.hits || []) {
      const age = t - hit.t;
      if (age < 0 || age > 0.4) continue;
      const k = age / 0.4;
      const strength = clamp(hit.blow / (Math.max(20, p.speed) * 1.4), 0.35, 1);
      const sp = tintOf(hit.tint);
      const fade = (1 - k) * (1 - k) * strength;
      const cx = hit.x + hit.nx * radius * 0.4;
      const cy = hit.y + hit.ny * radius * 0.4;
      const burst = radius * (1.6 + 2.4 * k);
      g.globalAlpha = alpha * fade;
      g.drawImage(sp.halo, cx - burst, cy - burst, burst * 2, burst * 2);
      const facing = Math.atan2(hit.ny, hit.nx);
      g.strokeStyle = sp.ring;
      g.lineWidth = Math.max(1.5, radius * 0.2 * (1 - k));
      g.beginPath();
      g.arc(hit.x, hit.y, radius * (0.8 + 3.2 * k), facing - 1.25, facing + 1.25);
      g.stroke();
    }

    for (const b of state.balls) {
      const sp = tintOf(b.tint);

      // Every other point of the path: a stamp is wider than the gap between
      // two, so the streak is still continuous, at half the fill.
      if (p.trail > 0 && b.trail.length >= 4) {
        const n = b.trail.length / 2;
        for (let i = (n - 2) % 2; i < n - 1; i += 2) {
          const k = (i + 1) / n;
          const s = radius * (0.5 + 1.1 * k);
          g.globalAlpha = alpha * clamp(p.trail * 0.85 * k ** 1.5, 0, 1);
          g.drawImage(sp.halo, b.trail[i * 2] - s, b.trail[i * 2 + 1] - s, s * 2, s * 2);
        }
      }

      // The halo is an inverse square, all but gone six tenths of the way out
      // across its sprite, so it is stamped only as wide as the light it
      // carries: any wider and the rest of the square pays for nothing.
      if (p.glow > 0) {
        const s = radius * (1.2 + p.glow * 1.5);
        g.globalAlpha = alpha * Math.min(1, 0.55 + 0.12 * p.glow);
        g.drawImage(sp.halo, b.x - s, b.y - s, s * 2, s * 2);
      }

      // Over its own light rather than added to it: added, the peak of the
      // halo underneath took every ball to white, whatever its colour.
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = alpha;
      const since = b.hitAt === undefined ? 1 : t - b.hitAt;
      const squash = since >= 0 && since < 0.14 ? 0.3 * (1 - since / 0.14) : 0;
      const r = radius * 1.08;
      if (squash > 0) {
        g.save();
        g.translate(b.x, b.y);
        g.rotate(Math.atan2(b.hitNy, b.hitNx));
        g.scale(1 - squash, 1 + squash * 0.6);
        g.drawImage(sp.ball, -r, -r, r * 2, r * 2);
        g.restore();
      } else {
        g.drawImage(sp.ball, b.x - r, b.y - r, r * 2, r * 2);
      }
      g.globalCompositeOperation = 'lighter';
    }

    g.globalAlpha = alpha;
    g.restore();
  },
};

/** Tints baked along the two ball colours: enough that nobody sees the steps. */
const BALL_TINTS = 8;

/**
 * Each tint's ball and halo, baked once per pair of colours.
 *
 * The halo is the inverse-square falloff every light in the library uses, so
 * a ball, its streak and its flashes all come from one sprite. The ball is a
 * lit sphere of light — a near-white highlight up and to the left, its own
 * colour across the middle, a little deeper at the rim — so it is a ball and
 * not a dot.
 */
function ballSprites(state, stable) {
  const key = `${stable.color}|${stable.color2}`;
  if (state.spriteKey === key && state.sprites) return state.sprites;
  state.spriteKey = key;
  const sprites = [];
  for (let k = 0; k < BALL_TINTS; k++) {
    const colour = mixHex(stable.color, stable.color2, k / (BALL_TINTS - 1));
    const { r, g: gr, b } = hexToRgb(colour);

    const halo = offscreen(128, 128);
    {
      const c = halo.getContext('2d');
      const light = c.createRadialGradient(64, 64, 0, 64, 64, 64);
      for (const [at, fall] of [[0, 1], [0.08, 0.807], [0.18, 0.446], [0.35, 0.163], [0.6, 0.046], [1, 0]]) {
        light.addColorStop(at, `rgba(${r},${gr},${b},${fall})`);
      }
      c.fillStyle = light;
      c.fillRect(0, 0, 128, 128);
    }

    const ball = offscreen(64, 64);
    {
      const c = ball.getContext('2d');
      const body = c.createRadialGradient(22, 21, 0, 32, 32, 31);
      body.addColorStop(0, '#ffffff');
      body.addColorStop(0.22, mixHex(colour, '#ffffff', 0.6));
      body.addColorStop(0.65, colour);
      body.addColorStop(1, mixHex(colour, '#000000', 0.3));
      c.fillStyle = body;
      c.beginPath();
      c.arc(32, 32, 31, 0, TAU);
      c.fill();
    }

    sprites.push({ halo, ball, ring: rgba(mixHex(colour, '#ffffff', 0.35), 0.7) });
  }
  state.sprites = sprites;
  return sprites;
}

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

/**
 * One snake's body this frame: points along it from the snout, their normals,
 * widths and distances. Module scratch rather than state — it is rebuilt from
 * nothing every frame and remembers nothing — grown when a longer snake needs
 * it.
 */
const SNAKE = { cap: 0 };
function snakeScratch(n) {
  if (SNAKE.cap < n) {
    const cap = Math.max(128, n * 2);
    SNAKE.cap = cap;
    for (const k of ['bx', 'by', 'nx', 'ny', 'w', 's', 'xs', 'ys']) SNAKE[k] = new Float64Array(cap);
  }
  return SNAKE;
}

/**
 * How wide a snake is, `s` along it from the snout, in pixels.
 *
 * A head, a neck and a body. The head is its own bulge — round at the snout,
 * widest a little behind the eyes and wider than the neck behind it — because
 * a snake whose front end is the same width as the rest of it is a hose with
 * one end cut off. The body holds its girth for nearly half its length and
 * then thins over the rest to a fine tail. Proportioned off the body's own
 * length as well as its thickness, so a short fat snake still has a head
 * rather than being all head.
 */
function snakeWidth(s, L, half) {
  const hh = Math.min(half, L / 7);
  const head = s < hh * 2.8 ? 1.28 * hh * Math.sin(Math.PI * (s / (hh * 2.8))) ** 0.62 : 0;
  const u = s / Math.max(1, L);
  const tail = u < 0.45 ? 1 : Math.max(0.04, (1 - (u - 0.45) / 0.55) ** 1.15);
  const body = half * clamp((s - hh * 1.4) / (hh * 3), 0, 1) ** 0.5 * tail;
  return Math.max(head, body);
}

/**
 * The outline between two points on the body, at a fraction of its width:
 * down one flank and back up the other, as curves through the points rather
 * than straight segments between them, so at two metres across a wall it is a
 * body and not a polygon.
 */
function traceSnake(g, S, i0, i1, f, ox = 0, oy = 0) {
  let k = 0;
  for (let i = i0; i <= i1; i++, k++) {
    S.xs[k] = S.bx[i] + S.nx[i] * S.w[i] * f + ox;
    S.ys[k] = S.by[i] + S.ny[i] * S.w[i] * f + oy;
  }
  curveThrough(g, S.xs, S.ys, k, { move: true });
  k = 0;
  for (let i = i1; i >= i0; i--, k++) {
    S.xs[k] = S.bx[i] - S.nx[i] * S.w[i] * f + ox;
    S.ys[k] = S.by[i] - S.ny[i] * S.w[i] * f + oy;
  }
  curveThrough(g, S.xs, S.ys, k);
  g.closePath();
}

const serpent = {
  id: 'serpent',
  name: 'Serpent',
  category: 'facade',
  scope: 'shape',
  description:
    'A snake that explores the wall, steering around the windows and doors rather than crossing them. Long and slow reads as a python; short and quick as something scuttling.',
  params: [
    { key: 'color', type: 'color', label: 'Head', default: '#a9c95b' },
    { key: 'color2', type: 'color', label: 'Tail', default: '#4b5a26' },
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
  /**
   * A snake, seen from above on the wall.
   *
   * The body is laid out afresh each frame at fixed distances back from the
   * *live* head, along the path the head has taken. Drawing the recorded path
   * itself moved the whole snake forward in jumps of one sample every time a
   * sample was recorded; laid out from the head, every point of it slides
   * along continuously — and a mark a fixed distance behind the snout is the
   * same scale of the same snake from one frame to the next, so the markings
   * travel with the body instead of sliding along it.
   *
   * Then it is drawn the way the tentacles are, as fills of one outline at
   * fractions of its width: a shadow on the wall, a dark edge, the body in its
   * colours from head to tail, dark saddles across the back, a paler ridge down
   * the spine and a sheen on the side towards the light. Then the head: eyes
   * with a glint in them, and a forked tongue that flicks out every few
   * seconds, which is the one gesture nothing but a snake makes. The glow, if
   * any, is a soft halo in the head colour — enough to lift it off a dark wall,
   * not so much that it reads as a lit tube.
   */
  draw({ g, p, shape, t, state }) {
    const container = shape;
    if (container.bbox.w <= 2 || container.bbox.h <= 2) return;
    const half = Math.max(1, p.thickness) / 2;
    const want = Math.max(10, p.length);
    // Points a fraction of the width apart: close enough that the curves
    // through them are smooth at any thickness, and no more.
    const gap = Math.max(2.5, half * 0.5);

    g.save();
    g.clip(container.path);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const alpha = g.globalAlpha;

    for (const s of state.snakes) {
      const hist = s.hist;
      if (!hist.length) continue;
      const S = snakeScratch(Math.ceil(want / gap) + 2);

      // Walk back along the path from the live head, a point every `gap`.
      let n = 0;
      let px = s.x;
      let py = s.y;
      let carried = 0;
      S.bx[0] = px;
      S.by[0] = py;
      S.s[0] = 0;
      n = 1;
      for (let i = 0; i < hist.length && n < S.cap; i++) {
        const qx = hist[i].x;
        const qy = hist[i].y;
        let seg = Math.hypot(qx - px, qy - py);
        while (seg > 0 && carried + seg >= gap && n < S.cap) {
          const f = (gap - carried) / seg;
          px += (qx - px) * f;
          py += (qy - py) * f;
          seg -= gap - carried;
          carried = 0;
          S.bx[n] = px;
          S.by[n] = py;
          S.s[n] = S.s[n - 1] + gap;
          n++;
          if (S.s[n - 1] >= want) break;
        }
        if (S.s[n - 1] >= want) break;
        carried += seg;
        px = qx;
        py = qy;
      }
      if (n < 4) continue;
      const L = S.s[n - 1];
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - 1);
        const b = Math.min(n - 1, i + 1);
        const tx = S.bx[b] - S.bx[a];
        const ty = S.by[b] - S.by[a];
        const len = Math.hypot(tx, ty) || 1;
        S.nx[i] = -ty / len;
        S.ny[i] = tx / len;
        S.w[i] = snakeWidth(S.s[i], L, half);
      }
      const hx = S.bx[0];
      const hy = S.by[0];
      const tx = S.bx[n - 1];
      const ty = S.by[n - 1];

      // Its shadow on the wall, down and to the right of the light.
      g.fillStyle = 'rgba(0,0,0,0.32)';
      g.beginPath();
      traceSnake(g, S, 0, n - 1, 1, half * 0.3, half * 0.5);
      g.fill();

      if (p.glow > 0) {
        g.globalCompositeOperation = 'lighter';
        g.strokeStyle = rgba(p.color, Math.min(1, 0.07 * p.glow));
        g.lineWidth = half * 2 + half * p.glow * 0.8;
        g.beginPath();
        g.moveTo(hx, hy);
        for (let i = 1; i < n; i++) g.lineTo(S.bx[i], S.by[i]);
        g.stroke();
        g.globalCompositeOperation = 'source-over';
      }

      g.fillStyle = mixHex(mixHex(p.color, p.color2, 0.5), '#000000', 0.72);
      g.beginPath();
      traceSnake(g, S, 0, n - 1, 1);
      g.fill();

      const skin = g.createLinearGradient(hx, hy, tx, ty);
      skin.addColorStop(0, mixHex(p.color, '#000000', 0.12));
      skin.addColorStop(0.4, mixHex(p.color, p.color2, 0.35));
      skin.addColorStop(1, p.color2);
      g.fillStyle = skin;
      g.beginPath();
      traceSnake(g, S, 0, n - 1, 0.84);
      g.fill();

      /**
       * Saddles across the back, a little over a body-width apart and each
       * its own length, from just behind the head to most of the way down
       * the tail. Placed by distance from the snout, so each one stays on its
       * own stretch of the snake as it slides along its path.
       */
      {
        const hh = Math.min(half, L / 7);
        g.beginPath();
        let at = hh * 3.6;
        let k = 0;
        while (at < L * 0.92) {
          const long = half * (0.85 + 0.5 * marking(k, s.seed));
          const mid = at + long / 2;
          // A saddle rather than a band: longest down the spine and shorter
          // towards the flanks, as two overlapping stretches of the outline.
          // Square-ended bands right across made a barber's pole.
          for (const [reach, f] of [[0.66, 0.3], [0.5, 0.58], [0.3, 0.82]]) {
            const i0 = Math.max(1, Math.round((mid - long * reach) / gap));
            const i1 = Math.min(n - 2, Math.round((mid + long * reach) / gap));
            if (i1 > i0) traceSnake(g, S, i0, i1, f);
          }
          at += long + half * (1.1 + 0.6 * marking(k + 11, s.seed));
          k++;
        }
        g.fillStyle = rgba(mixHex(p.color2, '#000000', 0.5), 0.72);
        g.fill();
      }

      const ridge = g.createLinearGradient(hx, hy, tx, ty);
      ridge.addColorStop(0, rgba(mixHex(p.color, '#fffbe6', 0.35), 0.4));
      ridge.addColorStop(1, rgba(mixHex(p.color2, '#fffbe6', 0.2), 0.2));
      g.fillStyle = ridge;
      g.beginPath();
      traceSnake(g, S, 0, n - 1, 0.3);
      g.fill();

      // A sheen, on whichever flank faces the light more squarely.
      g.beginPath();
      const stop = Math.floor(n * 0.82);
      for (let i = 2; i < stop; i++) {
        const off = S.w[i] * 0.42 * (S.nx[i] * -0.53 + S.ny[i] * -0.85);
        const x = S.bx[i] + S.nx[i] * off;
        const y = S.by[i] + S.ny[i] * off;
        if (i === 2) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.strokeStyle = rgba('#fbfff0', 0.3);
      g.lineWidth = Math.max(1.2, half * 0.16);
      g.stroke();

      // The head: forwards is from the second point to the snout.
      const fx0 = hx - S.bx[1];
      const fy0 = hy - S.by[1];
      const flen = Math.hypot(fx0, fy0) || 1;
      const fx = fx0 / flen;
      const fy = fy0 / flen;
      const hh = Math.min(half, L / 7);

      /**
       * The tongue: out for a third of a second every two or three, as a pure
       * function of the clock so every tab flicks it together, forked at the
       * end. Thin, but not under the projector floor.
       */
      const period = 2.2 + 1.3 * marking(3, s.seed);
      const phase = (t + s.seed * 0.37) % period;
      if (phase < 0.34) {
        const out = Math.sin((phase / 0.34) * Math.PI);
        const len = hh * 1.9 * out;
        const ex = hx + fx * len;
        const ey = hy + fy * len;
        const flick = Math.sin(t * 40 + s.seed) * 0.25;
        g.strokeStyle = '#c8203c';
        g.lineWidth = Math.max(1.6, hh * 0.12);
        g.beginPath();
        g.moveTo(hx, hy);
        g.lineTo(ex, ey);
        for (const side of [1, -1]) {
          const a = Math.atan2(fy, fx) + side * 0.45 + flick;
          g.moveTo(ex, ey);
          g.lineTo(ex + Math.cos(a) * hh * 0.45 * out, ey + Math.sin(a) * hh * 0.45 * out);
        }
        g.stroke();
      }

      if (p.eyes) {
        const at = Math.min(n - 1, Math.max(1, Math.round((hh * 0.85) / gap)));
        const r = Math.max(1.6, hh * 0.21);
        const glint = Math.max(0.6, r * 0.32);
        const ox = S.nx[at] * S.w[at] * 0.55;
        const oy = S.ny[at] * S.w[at] * 0.55;
        g.fillStyle = '#0b0a06';
        g.beginPath();
        g.moveTo(S.bx[at] + ox + r, S.by[at] + oy);
        g.arc(S.bx[at] + ox, S.by[at] + oy, r, 0, TAU);
        g.moveTo(S.bx[at] - ox + r, S.by[at] - oy);
        g.arc(S.bx[at] - ox, S.by[at] - oy, r, 0, TAU);
        g.fill();
        g.fillStyle = rgba('#fffbe0', 0.85);
        g.beginPath();
        for (const side of [1, -1]) {
          const gx = S.bx[at] + ox * side - r * 0.3;
          const gy = S.by[at] + oy * side - r * 0.35;
          g.moveTo(gx + glint, gy);
          g.arc(gx, gy, glint, 0, TAU);
        }
        g.fill();
      }
      g.globalAlpha = alpha;
    }

    g.restore();
  },
};

/** A draw in [0, 1] for the k-th marking on the snake seeded `seed`. */
function marking(k, seed) {
  const v = Math.sin(k * 12.9898 + seed * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

/* ------------------------------------------------------------------ *
 * Creeping vine
 * ------------------------------------------------------------------ */

const VINE_STEPS_PER_FRAME = 26;

/* ------------------------------------------------------------------ *
 * Ivy, baked
 * ------------------------------------------------------------------ */

/** Sprite size, and the leaf's length inside it, in sprite pixels. */
const LEAF_PX = 80;
const LEAF_L = 60;
/** Where the stalk meets the stem, in the sprite: the stamp's origin. */
const LEAF_ORIGIN_X = 6;

/**
 * Ages at which a stretch of stem is gone over again, wider and woodier.
 *
 * Ivy's runners go out as green shoots the width of a pencil lead and are
 * wrist-thick grey wood by the time anybody notices the plant, and the
 * thickening is most of what says *old* about it. In seconds, because a show
 * is an evening: a stem a minute old has had its whole life.
 */
const STEM_AGES = [5, 16, 40];
const STEM_WIDEN = [1.5, 2.1, 2.7];
const STEM_WOOD = [0.45, 0.65, 0.85];
/** Stretches of stem remembered for that, and how long one is before it is logged. */
const STEM_LOG = 8192;
const STEM_LOG_PX = 10;

/** Log a stretch of new stem, for `step` to thicken as it ages. */
function logStem(state, x0, y0, x1, y1, width, t) {
  const i = state.logHead;
  const o = i * 6;
  state.log[o] = x0;
  state.log[o + 1] = y0;
  state.log[o + 2] = x1;
  state.log[o + 3] = y1;
  state.log[o + 4] = width;
  state.log[o + 5] = t;
  state.logStage[i] = 0;
  state.logHead = (i + 1) % STEM_LOG;
  if (state.logCount < STEM_LOG) state.logCount++;
}

/**
 * One leaf into the plant's bitmap: its shadow a fixed way down and to the
 * right, then the leaf, both turned to `angle` about the point the stalk meets
 * the stem.
 */
function stampLeaf(c, ivy, x, y, angle, len, kind, tone) {
  const s = len / LEAF_L;
  const size = LEAF_PX * s;
  const ox = LEAF_ORIGIN_X * s;
  const drop = len * 0.13;
  c.save();
  c.translate(x + drop * 0.55, y + drop * 0.85);
  c.rotate(angle);
  c.drawImage(ivy.shadows[kind], -ox, -size / 2, size, size);
  c.restore();
  c.save();
  c.translate(x, y);
  c.rotate(angle);
  c.drawImage(ivy.leaves[kind * 3 + tone].canvas, -ox, -size / 2, size, size);
  c.restore();
}

/**
 * An ivy leaf's outline into the current path: stalk at the origin, blade
 * pointing along +x, `len` from stalk to tip.
 *
 * Polar about the point where the veins meet, as a sum of lobes — which is
 * what a palmate leaf is — sampled into straight segments fine enough at
 * sprite scale not to show. Three kinds: the five-lobed juvenile leaf
 * everybody draws, a three-lobed one, and the unlobed heart of the adult
 * plant. A wall of only the first reads as a pattern.
 */
function ivyOutline(c, kind, len) {
  const cx = len * 0.36;
  const R = len - cx;
  // Broad lobes and shallow sinuses. Narrow ones with deep cuts between them
  // were the first attempt, and every leaf on the wall came out a star.
  const lobes = kind === 0
    ? [[0, 1, 0.55], [1.2, 0.84, 0.5], [-1.2, 0.84, 0.5], [2.25, 0.58, 0.5], [-2.25, 0.58, 0.5]]
    : kind === 1
      ? [[0, 1, 0.62], [1.3, 0.78, 0.58], [-1.3, 0.78, 0.58]]
      : null;
  const N = 64;
  for (let k = 0; k <= N; k++) {
    const th = -Math.PI + (k / N) * TAU;
    let f;
    if (lobes) {
      f = kind === 0 ? 0.42 : 0.46;
      for (const [at, amp, wide] of lobes) {
        let d = th - at;
        if (d > Math.PI) d -= TAU;
        if (d < -Math.PI) d += TAU;
        // A broad triangle with a blunt tip, which is what an ivy lobe is. A
        // bell made every lobe a spike, and a leaf of five spikes is a star;
        // a round cap made them clubs, and the wall turned to clover.
        const u = Math.abs(d / (wide * 1.5));
        if (u < 1) f = Math.max(f, amp * (1 - u ** 1.5));
      }
      // Pulled in towards the stalk, where the two basal lobes meet it.
      const back = Math.PI - Math.abs(th);
      f *= 1 - 0.5 * Math.exp(-((back / 0.3) ** 2));
    } else {
      // The adult leaf: no lobes, a long point, and a notch where the stalk
      // goes in.
      const back = Math.PI - Math.abs(th);
      f = (0.2 + 0.8 * ((1 + Math.cos(th)) / 2) ** 2) * (1 - 0.5 * Math.exp(-((back / 0.32) ** 2)));
      f = Math.max(f, 0.52 * Math.exp(-(((Math.abs(th) - 1.85) / 0.85) ** 2)));
    }
    const x = cx + Math.cos(th) * R * f;
    const y = Math.sin(th) * R * f * 0.92;
    if (k === 0) c.moveTo(x, y);
    else c.lineTo(x, y);
  }
  c.closePath();
}

/**
 * The leaves the plant is grown from: three shapes in three ages, and a soft
 * shadow for each shape.
 *
 * Every leaf is shaded rather than flat — a lit half and a darker half, as if
 * folded slightly along the midrib, a gloss, pale veins and a darker edge —
 * because a mat of flat green shapes is a camouflage print, and a mat of
 * leaves each with its own light and dark is a plant. Lighter for younger:
 * ivy comes out a bright fresh green and darkens to nearly black as it ages.
 *
 * The shadow is a sprite of its own rather than part of the leaf, so it can
 * be stamped a fixed distance down and to the right whichever way the leaf is
 * turned. Baked into the leaf, it would turn with it, and a plant whose every
 * leaf casts its shadow a different way reads as noise.
 */
function bakeIvy(color, tip) {
  const tones = [mixHex(color, '#000000', 0.3), mixHex(color, '#000000', 0.08), mixHex(color, tip, 0.45)];
  const leaves = [];
  const shadows = [];
  for (let kind = 0; kind < 3; kind++) {
    const shadow = offscreen(LEAF_PX, LEAF_PX);
    {
      const c = shadow.getContext('2d');
      c.translate(LEAF_ORIGIN_X, LEAF_PX / 2);
      // Four nested copies, each a little bigger and fainter: a soft edge
      // without a filter.
      for (const [grow, a] of [[1.12, 0.12], [1.06, 0.16], [1, 0.22], [0.92, 0.26]]) {
        c.save();
        c.translate(LEAF_L * 0.36, 0);
        c.scale(grow, grow);
        c.translate(-LEAF_L * 0.36, 0);
        c.beginPath();
        ivyOutline(c, kind, LEAF_L);
        c.fillStyle = `rgba(0,0,0,${a})`;
        c.fill();
        c.restore();
      }
    }
    shadows.push(shadow);

    for (const tone of tones) {
      const canvas = offscreen(LEAF_PX, LEAF_PX);
      const c = canvas.getContext('2d');
      c.translate(LEAF_ORIGIN_X, LEAF_PX / 2);
      const R = LEAF_L * 0.64;
      const cx = LEAF_L * 0.36;

      // The stalk, from the stem into the blade.
      c.strokeStyle = mixHex(tone, '#3d3324', 0.35);
      c.lineWidth = 2.2;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(-LEAF_ORIGIN_X + 1, 0);
      c.lineTo(cx, 0);
      c.stroke();

      c.beginPath();
      ivyOutline(c, kind, LEAF_L);
      c.fillStyle = tone;
      c.fill();

      const fold = c.createLinearGradient(0, -R, 0, R);
      fold.addColorStop(0, 'rgba(255,255,226,0.2)');
      fold.addColorStop(0.48, 'rgba(255,255,226,0.04)');
      fold.addColorStop(0.52, 'rgba(0,0,0,0.06)');
      fold.addColorStop(1, 'rgba(0,0,0,0.3)');
      c.fillStyle = fold;
      c.fill();

      const gloss = c.createRadialGradient(cx + R * 0.25, -R * 0.28, 0, cx + R * 0.25, -R * 0.28, R * 0.6);
      gloss.addColorStop(0, 'rgba(255,255,240,0.24)');
      gloss.addColorStop(1, 'rgba(255,255,240,0)');
      c.fillStyle = gloss;
      c.fill();

      c.strokeStyle = rgba(mixHex(tone, '#000000', 0.5), 0.8);
      c.lineWidth = 1.6;
      c.lineJoin = 'round';
      c.stroke();

      // Veins, from where the stalk meets the blade out towards each lobe.
      c.strokeStyle = rgba(mixHex(tone, '#e9f2cf', 0.5), 0.75);
      c.lineWidth = 1.3;
      c.beginPath();
      const veins = kind === 0 ? [0, 1.15, -1.15, 2.2, -2.2] : kind === 1 ? [0, 1.25, -1.25] : [0, 0.8, -0.8, 1.7, -1.7];
      for (const a of veins) {
        const reach = a === 0 ? 0.9 : kind === 2 ? 0.55 : 0.72;
        c.moveTo(cx, 0);
        c.lineTo(cx + Math.cos(a) * R * reach, Math.sin(a) * R * reach * 0.92);
      }
      c.stroke();
      leaves.push({ canvas, kind });
    }
  }
  return { leaves, shadows };
}

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
 *
 * What it accumulates is a plant, not a line drawing of one. A thin green
 * stroke with the odd green oval beside it is, at house scale, scribble:
 * nothing about it says leaf, and nothing about it changes with age. So the
 * leaves are baked once — ivy's three shapes in three ages of green,
 * each shaded, veined and edged — and stamped in alternating clusters along
 * every runner with a soft shadow under each, so where runners cross and
 * recross, the leaves pile into a mat with depth in it. And the stems age: a
 * runner goes out as a thin green-brown shoot and is gone over again, wider
 * and woodier, at a few ages, from *behind* everything already drawn, so the
 * oldest runners — the ones that came up from the ground first — end up as the
 * thick bare trunks the rest of the plant hangs off. Every bit of that is a
 * stroke or a stamp into the same bitmap, so a frame still costs one
 * drawImage plus the few centimetres it adds.
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
    { key: 'leaves', type: 'range', label: 'Leaves', default: 0.65, min: 0, max: 1, step: 0.01 },
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

      state.ivy = bakeIvy(stable.color, stable.tip);
      /**
       * Every stretch of stem laid, and when — so it can be gone over again,
       * wider and woodier, as it ages. A ring: on a plant that has covered the
       * wall the oldest stretches drop off the end, by which time they have
       * had every thickening they are going to get.
       */
      state.log = new Float32Array(STEM_LOG * 6);
      state.logStage = new Uint8Array(STEM_LOG);
      state.logCount = 0;
      state.logHead = 0;
      state.logScan = 0;
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
      state.logCount = 0;
      state.logHead = 0;
      state.logScan = 0;
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
      /** Which side the next leaf comes off: they alternate, as ivy's do. */
      leafSide: rng() < 0.5 ? 1 : -1,
      /** Where the stretch of stem being logged began, and how long it is. */
      segX: x,
      segY: y,
      segLen: 0,
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

    /**
     * Shoots emerge one at a time, not all together.
     *
     * The tip count is what the plant grows *to*, and it used to be what it
     * started at: the first simulation step found an empty tip list, wanted six
     * of them, and pushed six — so the instant you added the layer, six runners
     * set off along the bottom of the wall at once. Each one carries a glow of
     * several times the vine's own width and they all start from the same edge,
     * so six of them arriving together on bare brick, through the bloom, is a
     * bar of light across the foot of the house. It reads as one massively
     * thick thing rather than as six thin ones, and nothing about it reads as
     * something growing.
     *
     * One shoot every `EMERGE_SECONDS` instead, from the moment the plant was
     * planted. A wall of ivy takes a minute to get going and then keeps its
     * full complement for the rest of the evening, which is both what a plant
     * does and what makes the first thirty seconds worth watching.
     *
     * A pure function of show time and `plantedAt`, so every tab agrees, and a
     * tab that joins an hour in skips straight to the full count.
     */
    const emerged = 1 + Math.floor(Math.max(0, t - state.plantedAt) / EMERGE_SECONDS);
    // A floor of one while there is any room at all. Rounding a small headroom
    // still toggles between zero and one shoot, about once a second, and one
    // shoot that keeps creeping reads far better than one that keeps returning.
    // Only a plant with no room left — coverage reached and no withering to
    // make more — goes down to none, and even that one fades out.
    const wanted = headroom <= 0
      ? 0
      : Math.max(1, Math.min(emerged, Math.round(clamp(p.tips, 1, 24) * headroom)));

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

    /** Which openings a leaf this step was stamped close enough to hang over, as bits. */
    let overhang = 0;
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

        // A new shoot, only as wide as this runner is, and already halfway to
        // bark: the wood thickens out from behind it later — see below the
        // loop — and a bright green line down the middle of a brown stem
        // reads as a tube rather than a branch.
        const width = Math.max(0.4, p.thickness * tip.width);
        c.strokeStyle = mixHex(mixHex(p.color, '#5d4b3a', 0.35), '#000000', tip.tint * 0.25);
        c.lineWidth = width;
        c.beginPath();
        c.moveTo(tip.x, tip.y);
        c.lineTo(nx, ny);
        c.stroke();
        tip.segLen += stepPx;
        if (tip.segLen >= STEM_LOG_PX) {
          logStem(state, tip.segX, tip.segY, nx, ny, width, t);
          tip.segX = nx;
          tip.segY = ny;
          tip.segLen = 0;
        }

        /**
         * Leaves, a few at a node, alternating sides.
         *
         * Stamped from the baked set, each with its shadow first — so a leaf
         * laid over an older one darkens it, and the mat builds up in depth
         * rather than in flat green — and each turned out from the stem and
         * then let droop a little, because a leaf on a wall hangs.
         */
        tip.sinceLeaf += stepPx;
        const leafGap = lerp(64, 9, p.leaves) * Math.sqrt(Math.max(0.5, p.thickness) / 3.5);
        if (p.leaves > 0 && tip.sinceLeaf > leafGap) {
          tip.sinceLeaf = rng() * leafGap * 0.4;
          const count = 1 + (rng() < 0.4 ? 1 : 0) + (rng() < 0.12 ? 1 : 0);
          for (let k = 0; k < count; k++) {
            tip.leafSide = -tip.leafSide;
            let a = tip.angle + tip.leafSide * (0.8 + rng() * 0.8);
            a += angleDelta(a, Math.PI / 2) * 0.3;
            const len = p.thickness * (6 + rng() * 4) * (k ? 0.72 : 1);
            const pick = rng();
            const kind = pick < 0.5 ? 0 : pick < 0.8 ? 1 : 2;
            const age = rng();
            const tone = age < 0.55 ? 0 : age < 0.86 ? 1 : 2;
            stampLeaf(c, state.ivy, nx, ny, a, len, kind, tone);
            for (let o = 0; o < obstacles.length && o < 31; o++) {
              const b = obstacles[o].bbox;
              if (nx > b.x - len && nx < b.x + b.w + len && ny > b.y - len && ny < b.y + b.h + len) {
                overhang |= 1 << o;
              }
            }
          }
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

    /**
     * Age the wood.
     *
     * A few stretches of logged stem a step, round-robin, and any that have
     * reached their next age are drawn again — wider, browner — *behind*
     * everything already on the bitmap, with `destination-over`. So the stem
     * thickens out from under its own leaves rather than being painted across
     * them, and the oldest runners, the ones that came up from the ground
     * first, end up as the thick grey trunks the rest of the plant hangs off.
     *
     * Drawn at the strength the withering would have left that stretch at by
     * now, so wood laid behind old, faded growth does not come back brighter
     * than the growth it belongs to.
     */
    if (state.logCount) {
      const checks = Math.min(state.logCount, 160);
      c.save();
      c.globalCompositeOperation = 'destination-over';
      c.lineCap = 'round';
      for (let k = 0; k < checks; k++) {
        const i = state.logScan;
        state.logScan = (state.logScan + 1) % state.logCount;
        const stage = state.logStage[i];
        if (stage >= STEM_AGES.length) continue;
        const o = i * 6;
        const age = t - state.log[o + 5];
        if (age < STEM_AGES[stage]) continue;
        state.logStage[i] = stage + 1;
        const left = p.wither > 0 ? Math.exp(-0.06 * p.wither * age) : 1;
        c.strokeStyle = rgba(mixHex(p.color, '#5d4b3a', STEM_WOOD[stage]), left);
        c.lineWidth = state.log[o + 4] * STEM_WIDEN[stage];
        c.beginPath();
        c.moveTo(state.log[o], state.log[o + 1]);
        c.lineTo(state.log[o + 2], state.log[o + 3]);
        c.stroke();
      }
      c.restore();
    }

    /**
     * And cut the openings back out, when a leaf may have reached one.
     *
     * The runners keep off the glass by construction; a leaf hangs a leaf's
     * length off its runner, so one laid beside a frame lies across it. Erasing
     * the opening from the bitmap leaves the leaf cut cleanly at the frame,
     * which reads as ivy growing up to a window rather than over it — and
     * costs one fill of the openings actually reached, on the steps that
     * reach one, rather than a clip every frame.
     */
    if (overhang) {
      c.save();
      c.globalCompositeOperation = 'destination-out';
      c.fillStyle = '#000000';
      c.beginPath();
      for (let o = 0; o < obstacles.length && o < 31; o++) {
        const pts = obstacles[o].points;
        if (!(overhang & (1 << o)) || pts.length < 3) continue;
        c.moveTo(pts[0].x, pts[0].y);
        for (let k = 1; k < pts.length; k++) c.lineTo(pts[k].x, pts[k].y);
        c.closePath();
      }
      c.fill();
      c.restore();
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
