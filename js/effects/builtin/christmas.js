/**
 * Christmas effects.
 *
 * Same engine as the Halloween set, different mood. Snow and stars are usually
 * pointed at a whole wall (leave a layer's targets empty and it covers the frame);
 * icicles and candy stripes want a specific edge or outline.
 */

import { rgba, clamp, lerp, TAU, frac } from '../../core/math.js';
import { mixLinear } from '../color.js';
import {
  ensureSurfaces,
  sweepLanding,
  settle,
  shedSlabs,
  advanceSlabs,
  drawDrift,
  drawSlabs,
} from '../collide.js';

/**
 * Depth of field, cheaply.
 *
 * Setting `ctx.filter` before each flake gives a correct blur and costs about
 * 180µs per flake, because every filtered draw is rendered into its own layer
 * and composited back — 320 flakes came to 59ms a frame on its own. Instead we
 * bake a small ladder of pre-softened discs once and stamp them with drawImage,
 * which is a plain textured blit. The softness is a radial falloff rather than a
 * true Gaussian; at the size a flake occupies on a wall the difference is not
 * visible, and it is roughly two hundred times faster.
 */
const SPRITE_PX = 64;
const SPRITE_LEVELS = 6;

function buildFlakeSprites(colour) {
  const sprites = [];
  for (let i = 0; i < SPRITE_LEVELS; i++) {
    const softness = i / (SPRITE_LEVELS - 1);
    const canvas =
      typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(SPRITE_PX, SPRITE_PX)
        : Object.assign(document.createElement('canvas'), { width: SPRITE_PX, height: SPRITE_PX });
    const c = canvas.getContext('2d');
    const half = SPRITE_PX / 2;
    // The solid core shrinks as softness rises, so the same stamp reads as a
    // sharp grain at level 0 and a diffuse blob at the top of the ladder.
    const core = half * (0.9 - 0.86 * softness);
    const grad = c.createRadialGradient(half, half, core, half, half, half);
    grad.addColorStop(0, rgba(colour, 1));
    grad.addColorStop(0.45, rgba(colour, 0.52 - 0.12 * softness));
    grad.addColorStop(1, rgba(colour, 0));
    c.fillStyle = grad;
    c.fillRect(0, 0, SPRITE_PX, SPRITE_PX);
    sprites.push(canvas);
  }
  return sprites;
}

function ensureFlakeSprites(state, colour) {
  if (state.spriteKey !== colour) {
    state.sprites = buildFlakeSprites(colour);
    state.spriteKey = colour;
  }
  return state.sprites;
}

const snow = {
  id: 'snow',
  name: 'Snow',
  category: 'christmas',
  scope: 'shape',
  description:
    'Falling snow with real depth, that settles on whatever you have traced. Piles round off, overload, and slide away down the wall.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#ffffff' },
    { key: 'count', type: 'range', label: 'Flakes', default: 320, min: 10, max: 2000, step: 10 },
    { key: 'speed', type: 'range', label: 'Fall speed', default: 90, min: 5, max: 600, step: 1 },
    { key: 'wind', type: 'range', label: 'Wind', default: 20, min: -300, max: 300, step: 1 },
    { key: 'gust', type: 'range', label: 'Gustiness', default: 0.5, min: 0, max: 3, step: 0.05 },
    { key: 'size', type: 'range', label: 'Flake size', default: 5, min: 0.5, max: 30, step: 0.25 },
    { key: 'depth', type: 'range', label: 'Depth spread', default: 0.7, min: 0, max: 1, step: 0.01 },
    { key: 'blur', type: 'range', label: 'Near-flake blur', default: 0.7, min: 0, max: 1, step: 0.01 },
    { key: 'flutter', type: 'range', label: 'Flutter', default: 0.6, min: 0, max: 2, step: 0.01 },
    { key: 'collide', type: 'bool', label: 'Settle on shapes', default: true },
    { key: 'colliderTag', type: 'text', label: 'Settle on tag', default: '' },
    { key: 'buildUp', type: 'range', label: 'Build-up rate', default: 2.5, min: 0, max: 15, step: 0.1 },
    { key: 'maxDepth', type: 'range', label: 'Depth before it slides', default: 22, min: 2, max: 120, step: 1 },
    { key: 'shed', type: 'range', label: 'Slide-off chance', default: 0.3, min: 0, max: 3, step: 0.01 },
  ],
  init() {
    return { flakes: [], count: 0, sprites: null, spriteKey: null };
  },
  draw({ g, p, shape, shapes, world, t, dt, rng, state, noise }) {
    const { bbox } = shape;
    if (bbox.w <= 0 || bbox.h <= 0) return;
    const target = Math.round(p.count);

    /**
     * Everything else in the scene is what snow lands on. Excluding the shape
     * we are drawing into matters: snow aimed at the whole frame should settle
     * on the house, not on the frame's own bottom edge — that edge is where
     * slabs are supposed to disappear.
     */
    const colliders = p.collide && typeof shapes === 'function'
      ? shapes(p.colliderTag, shape.id).filter((geo) => geo.points && geo.points.length > 1)
      : [];
    const surfaces = colliders.length ? ensureSurfaces(state, 'surfaces', colliders, world, 260) : null;

    const spawn = (flake = {}, atTop = true) => {
      flake.x = bbox.x + rng() * bbox.w;
      flake.y = atTop ? bbox.y - rng() * bbox.h * 0.1 : bbox.y + rng() * bbox.h;
      // Depth drives size, speed, brightness *and* focus together, which is what
      // sells the parallax without needing separate layers.
      flake.z = 1 - p.depth * rng();
      flake.phase = rng() * TAU;
      // Flakes are flat plates: they rock and present more or less area to the
      // viewer as they tumble, which is why real snow twinkles as it falls.
      flake.tumble = 0.6 + rng() * 2.4;
      flake.tilt = rng() * TAU;
      return flake;
    };

    while (state.flakes.length < target) state.flakes.push(spawn({}, false));
    if (state.flakes.length > target) state.flakes.length = target;

    const gust = p.gust > 0 ? noise.noise2(t * 0.12, 0) * p.gust : 0;
    const sprites = ensureFlakeSprites(state, p.color);

    g.save();
    g.clip(shape.path);

    // Sorting back to front costs nothing at these counts and means near flakes
    // correctly occlude far ones. Sorted once per frame, in place.
    state.flakes.sort((a, b) => a.z - b.z);

    // The drift sits on the house, so it belongs between the flakes falling
    // behind it and the ones falling in front. Splitting the pass at the depth
    // where flakes stop landing is what stops the house looking pasted on.
    let drewDrift = !surfaces;
    const paintDrift = () => {
      drewDrift = true;
      g.globalAlpha = 1;
      // Snow is lit by the whole sky, so its body takes a blue cast and only the
      // top edge sees anything like a direct light. That split is most of what
      // makes a white shape read as a rounded volume rather than a cut-out.
      const style = {
        fill: mixLinear(p.color, '#8fa8c8', 0.28),
        crest: mixLinear(p.color, '#ffffff', 0.6),
      };
      for (const { field, drift } of surfaces) {
        drawDrift(g, drift, field, style);
        drawSlabs(g, drift, style);
      }
    };

    for (const flake of state.flakes) {
      const z = flake.z;
      const prevY = flake.y;
      flake.y += p.speed * z * dt;
      // Flutter is a sideways drift that reverses — a flake does not fall
      // straight, it slips from side to side as it rocks.
      flake.tilt += flake.tumble * dt;
      const flutter = Math.sin(flake.tilt) * 26 * p.flutter * z;
      flake.x += (p.wind * z + flutter + gust * 60) * dt;

      if (flake.y > bbox.y + bbox.h + 10) spawn(flake, true);
      if (flake.x < bbox.x - 20) flake.x = bbox.x + bbox.w + 10;
      if (flake.x > bbox.x + bbox.w + 20) flake.x = bbox.x - 10;

      const r = p.size * z * 0.5;

      if (surfaces && !drewDrift && z >= 0.62) paintDrift();

      // Landing. A flake that hits a drift adds its own volume to that column
      // and is recycled at the top, which keeps the flake count — and so the
      // cost — flat however long the show runs.
      if (surfaces && p.buildUp > 0) {
        const hit = sweepLanding(surfaces, flake.x, prevY, flake.y);
        if (hit) {
          const { field, drift } = hit.surface;
          // Volume in, depth out: a flake's area spread across the column it
          // landed in. Big near flakes therefore build a drift much faster than
          // distant specks, which is both correct and what you want to look at.
          drift.depth[hit.col] += (Math.PI * r * r * p.buildUp * 0.6) / field.colW;
          spawn(flake, true);
          continue;
        }
      }

      // Presented area varies as the plate rocks: a flake edge-on nearly
      // disappears, which is the twinkle.
      const facing = 0.35 + 0.65 * Math.abs(Math.cos(flake.tilt));
      const alpha = clamp((0.3 + 0.7 * z) * facing, 0, 1);

      // Depth of field. A camera focused on the house renders flakes a metre
      // from the lens as soft discs; drawing every flake sharp is the single
      // most obvious tell that it is an overlay.
      const spread = p.blur * Math.max(0, z - 0.55) * 26;
      const level = Math.min(
        SPRITE_LEVELS - 1,
        Math.round((spread / (spread + Math.max(0.6, r))) * (SPRITE_LEVELS - 1) * 1.6)
      );
      // Blur spreads the same light over more area, so a soft flake is dimmer.
      const rx = Math.max(0.5, r) + spread;
      const ry = Math.max(0.5, r * facing) + spread;
      g.globalAlpha = alpha * Math.max(0.25, 1 - spread / (spread + r * 1.5));

      // Squashed along the tumble axis, so flakes read as plates not spheres.
      g.save();
      g.translate(flake.x, flake.y);
      g.rotate(flake.tilt);
      g.drawImage(sprites[level], -rx, -ry, rx * 2, ry * 2);
      g.restore();
    }

    g.globalAlpha = 1;

    if (surfaces) {
      // Slumping, shedding and falling all happen once per frame per surface,
      // regardless of how many flakes landed, so the cost does not scale with
      // the weather. 38° is roughly the angle settled snow holds before it
      // slumps, and it is what rounds a column of landings into a drift.
      for (const { field, drift } of surfaces) {
        settle(drift, field, 0.66, 4);
        shedSlabs(drift, field, {
          maxDepth: p.maxDepth,
          gustChance: p.shed,
          dt,
          rng,
          minDepth: 1,
        });
        advanceSlabs(drift, field, dt, 620);
      }
      if (!drewDrift) paintDrift();
    }

    g.restore();
  },
};

/**
 * One reindeer, facing -x, drawn around the origin at unit scale `s`.
 *
 * The old one was an ellipse, a stick neck, a circle head, two lines for legs
 * and a pair of forked twigs. Read at any size it was a balloon animal. What
 * actually makes a quadruped silhouette land:
 *
 * - **A body with a front and a back.** Deep chest, dip behind the withers,
 *   rising croup, tucked belly. An ellipse has none of those and so has no
 *   direction — it reads the same drawn backwards.
 * - **Four legs, jointed, out of phase.** Two legs is a hobby horse. The hock
 *   bends the opposite way to the knee, and a galloping leg tucks hard on the
 *   recovery and straightens on the reach; that contrast is the motion.
 * - **Antlers with a beam.** Real antlers sweep back from the skull and throw
 *   tines *forward* off that beam. Two forked twigs read as a stick.
 */
export function drawReindeer(g, s, gallop, lineWidth) {
  const w = lineWidth;

  // A leg as thigh plus shank. The shank tucks under on the recovery stroke and
  // swings out straight on the reach, which is most of what says "running".
  const leg = (hx, hy, upper, lower, phase, flip) => {
    const swing = Math.sin(phase);
    const thigh = swing * 0.85;
    const shank = thigh - flip * (0.55 + 0.75 * Math.max(0, -swing));
    const kx = hx + Math.sin(thigh) * upper;
    const ky = hy + Math.cos(thigh) * upper;
    const fx = kx + Math.sin(shank) * lower;
    const fy = ky + Math.cos(shank) * lower;
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(hx, hy);
    g.lineTo(kx, ky);
    g.stroke();
    g.lineWidth = w * 0.72;
    g.beginPath();
    g.moveTo(kx, ky);
    g.lineTo(fx, fy);
    g.stroke();
  };

  // Far side of the body first, dimmer, so the near legs read as nearer.
  g.save();
  g.globalAlpha *= 0.55;
  leg(-0.26 * s, 0.06 * s, 0.2 * s, 0.22 * s, gallop + 0.5, 1);
  leg(0.24 * s, 0.04 * s, 0.22 * s, 0.23 * s, gallop + 2.1, -1);
  g.restore();

  // Body: deep chest, a dip behind the withers, rising croup, tucked flank.
  // Drawn as one closed curve so the silhouette stays clean when it is only a
  // few pixels tall — and short enough in the barrel that it reads as a deer
  // rather than a dachshund.
  g.beginPath();
  g.moveTo(-0.34 * s, -0.04 * s);
  g.quadraticCurveTo(-0.32 * s, -0.21 * s, -0.14 * s, -0.20 * s);
  g.quadraticCurveTo(0.06 * s, -0.15 * s, 0.22 * s, -0.22 * s);
  g.quadraticCurveTo(0.38 * s, -0.26 * s, 0.38 * s, -0.04 * s);
  g.quadraticCurveTo(0.37 * s, 0.08 * s, 0.22 * s, 0.09 * s);
  g.quadraticCurveTo(0.02 * s, 0.14 * s, -0.16 * s, 0.11 * s);
  g.quadraticCurveTo(-0.32 * s, 0.09 * s, -0.34 * s, -0.04 * s);
  g.closePath();
  g.fill();

  /**
   * Neck and head as one continuous outline.
   *
   * Drawn as separate pieces they never quite join: a stroked neck is a stick,
   * and a head built from an ellipse plus a muzzle reads as two blobs touching.
   * One path that leaves the shoulder wide, tapers up the neck, swells slightly
   * at the skull and runs out to a blunt nose is the whole silhouette, and it
   * survives being three pixels tall.
   */
  g.beginPath();
  g.moveTo(-0.28 * s, 0.03 * s);                                     // throat, at the chest
  g.quadraticCurveTo(-0.42 * s, -0.06 * s, -0.52 * s, -0.19 * s);    // up the underside
  g.quadraticCurveTo(-0.62 * s, -0.22 * s, -0.72 * s, -0.20 * s);    // along the jaw
  g.quadraticCurveTo(-0.79 * s, -0.19 * s, -0.77 * s, -0.25 * s);    // round the blunt nose
  g.quadraticCurveTo(-0.72 * s, -0.29 * s, -0.62 * s, -0.30 * s);    // back over the muzzle
  g.quadraticCurveTo(-0.54 * s, -0.32 * s, -0.44 * s, -0.27 * s);    // the brow and poll
  g.quadraticCurveTo(-0.30 * s, -0.24 * s, -0.16 * s, -0.19 * s);    // down the crest to the withers
  g.lineTo(-0.20 * s, 0.02 * s);                                     // into the chest
  g.closePath();
  g.fill();

  // Ear, off the back of the skull.
  g.lineWidth = w * 1.2;
  g.beginPath();
  g.moveTo(-0.53 * s, -0.29 * s);
  g.quadraticCurveTo(-0.50 * s, -0.37 * s, -0.43 * s, -0.38 * s);
  g.stroke();

  /**
   * Antlers: a beam sweeping back over the shoulders, with tines thrown off it
   * at genuinely different angles — one low over the brow, one forward-up, one
   * near-vertical. Evenly spaced parallel tines are what made the old pair read
   * as a garden rake; a real rack fans. Sized to about a third of the body, and
   * rooted on the skull rather than floating above it.
   */
  const rack = (ox, oy, alpha) => {
    g.save();
    g.globalAlpha *= alpha;
    g.lineWidth = w * 1.3;
    g.beginPath();
    g.moveTo(ox, oy);
    g.bezierCurveTo(
      ox + 0.02 * s, oy - 0.14 * s,
      ox + 0.10 * s, oy - 0.21 * s,
      ox + 0.20 * s, oy - 0.21 * s
    );
    g.stroke();

    g.lineWidth = w * 0.9;
    // Brow tine, out over the face.
    g.beginPath();
    g.moveTo(ox + 0.005 * s, oy - 0.06 * s);
    g.quadraticCurveTo(ox - 0.07 * s, oy - 0.09 * s, ox - 0.11 * s, oy - 0.14 * s);
    g.stroke();
    // Two off the top of the beam, splaying apart as they rise.
    g.beginPath();
    g.moveTo(ox + 0.07 * s, oy - 0.18 * s);
    g.quadraticCurveTo(ox + 0.04 * s, oy - 0.26 * s, ox + 0.005 * s, oy - 0.32 * s);
    g.stroke();
    g.beginPath();
    g.moveTo(ox + 0.16 * s, oy - 0.21 * s);
    g.quadraticCurveTo(ox + 0.17 * s, oy - 0.28 * s, ox + 0.14 * s, oy - 0.34 * s);
    g.stroke();
    g.restore();
  };
  // The far rack is only hinted. Two fully drawn racks at the size a reindeer
  // actually occupies on a wall is eight overlapping strokes in the space of a
  // few pixels, which resolves to a smear.
  rack(-0.52 * s, -0.30 * s, 0.3);
  rack(-0.60 * s, -0.32 * s, 1);

  // Tail.
  g.lineWidth = w * 1.4;
  g.beginPath();
  g.moveTo(0.37 * s, -0.10 * s);
  g.quadraticCurveTo(0.47 * s, -0.16 * s, 0.46 * s, -0.03 * s);
  g.stroke();

  // Near legs, at full strength.
  leg(-0.28 * s, 0.06 * s, 0.2 * s, 0.22 * s, gallop, 1);
  leg(0.26 * s, 0.04 * s, 0.22 * s, 0.23 * s, gallop + 1.6, -1);
}

/**
 * The sleigh, facing -x, with Santa in it. Origin is the middle of the hull.
 *
 * The shape people actually recognise is the *runner* — one continuous line that
 * sweeps up into a scroll at the prow — and a hull whose back rises into a high
 * curved seat. The previous version had a straight runner and a flat seat, which
 * is a shopping trolley.
 */
export function drawSleigh(g, s, t, lineWidth) {
  const w = lineWidth;

  // Hull: low curved prow, deep body, tall sweeping seat back.
  g.beginPath();
  g.moveTo(-0.52 * s, 0.06 * s);
  g.quadraticCurveTo(-0.55 * s, 0.20 * s, -0.36 * s, 0.22 * s);
  g.lineTo(0.30 * s, 0.22 * s);
  g.quadraticCurveTo(0.52 * s, 0.20 * s, 0.56 * s, -0.02 * s);
  g.quadraticCurveTo(0.60 * s, -0.30 * s, 0.44 * s, -0.34 * s);
  g.quadraticCurveTo(0.46 * s, -0.12 * s, 0.30 * s, 0.02 * s);
  g.lineTo(-0.30 * s, 0.02 * s);
  g.quadraticCurveTo(-0.46 * s, 0.02 * s, -0.52 * s, 0.06 * s);
  g.closePath();
  g.fill();

  // Runner: back along the ground, then up and over into the scroll at the prow.
  g.lineWidth = w * 1.2;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(0.46 * s, 0.30 * s);
  g.lineTo(-0.40 * s, 0.30 * s);
  g.quadraticCurveTo(-0.66 * s, 0.30 * s, -0.68 * s, 0.12 * s);
  g.quadraticCurveTo(-0.69 * s, 0.00 * s, -0.58 * s, 0.02 * s);
  g.quadraticCurveTo(-0.52 * s, 0.03 * s, -0.54 * s, 0.10 * s);
  g.stroke();
  // Stanchions tying the runner to the hull.
  g.lineWidth = w * 0.8;
  for (const x of [-0.3, 0.1, 0.4]) {
    g.beginPath();
    g.moveTo(x * s, 0.22 * s);
    g.lineTo(x * s, 0.30 * s);
    g.stroke();
  }

  // Santa: leaning forward, one arm out on the reins, the other up mid-wave.
  const wave = Math.sin(t * 5.5);
  g.save();
  g.translate(0.16 * s, -0.16 * s);
  g.rotate(-0.12);
  g.beginPath();
  g.ellipse(0, 0, 0.15 * s, 0.19 * s, 0, 0, TAU);
  g.fill();

  // Rein arm, forward and low.
  g.lineWidth = w * 1.5;
  g.beginPath();
  g.moveTo(-0.06 * s, -0.04 * s);
  g.quadraticCurveTo(-0.22 * s, -0.02 * s, -0.34 * s, -0.08 * s);
  g.stroke();
  // Waving arm.
  g.beginPath();
  g.moveTo(0.06 * s, -0.08 * s);
  g.quadraticCurveTo(0.20 * s, -0.20 * s, 0.16 * s + wave * 0.05 * s, -0.34 * s);
  g.stroke();

  // Beard — a wedge under the face, which is what makes the head read as Santa
  // rather than as a person in a hat.
  g.beginPath();
  g.moveTo(-0.10 * s, -0.20 * s);
  g.quadraticCurveTo(-0.14 * s, -0.02 * s, 0.0, -0.04 * s);
  g.quadraticCurveTo(0.10 * s, -0.06 * s, 0.09 * s, -0.20 * s);
  g.closePath();
  g.fill();

  // Head.
  g.beginPath();
  g.arc(-0.01 * s, -0.27 * s, 0.10 * s, 0, TAU);
  g.fill();

  // Hat: a cone flopping backwards off the crown, with the bobble on the end.
  g.beginPath();
  g.moveTo(-0.11 * s, -0.31 * s);
  g.lineTo(0.09 * s, -0.33 * s);
  g.quadraticCurveTo(0.14 * s, -0.46 * s, 0.24 * s, -0.50 * s);
  g.quadraticCurveTo(0.10 * s, -0.44 * s, -0.06 * s, -0.38 * s);
  g.closePath();
  g.fill();
  g.beginPath();
  g.arc(0.26 * s, -0.51 * s, 0.045 * s, 0, TAU);
  g.fill();
  g.restore();
}

const santa = {
  id: 'santa',
  name: 'Santa Fly-past',
  category: 'christmas',
  scope: 'shape',
  description:
    'A sleigh and reindeer silhouette crossing the sky, on a timer so it stays a surprise.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#ffe9b0' },
    { key: 'reindeer', type: 'range', label: 'Reindeer', default: 4, min: 0, max: 9, step: 1 },
    { key: 'size', type: 'range', label: 'Size', default: 0.25, min: 0.03, max: 1, step: 0.005 },
    { key: 'interval', type: 'range', label: 'Every (s)', default: 45, min: 3, max: 600, step: 1 },
    { key: 'crossing', type: 'range', label: 'Crossing time (s)', default: 9, min: 1, max: 60, step: 0.5 },
    { key: 'direction', type: 'select', label: 'Direction', default: 'right', options: ['right', 'left'] },
    { key: 'height', type: 'range', label: 'Height', default: 0.3, min: 0, max: 1, step: 0.01 },
    { key: 'bob', type: 'range', label: 'Bob', default: 0.03, min: 0, max: 0.2, step: 0.005 },
    { key: 'trail', type: 'range', label: 'Sparkle trail', default: 0.6, min: 0, max: 1, step: 0.01 },
    { key: 'silhouette', type: 'bool', label: 'Dark silhouette', default: false },
  ],
  draw({ g, p, shape, t, noise }) {
    const { bbox } = shape;
    const cycle = t % Math.max(1, p.interval);
    if (cycle > p.crossing) return;

    const f = cycle / p.crossing;
    const dir = p.direction === 'left' ? -1 : 1;
    const startX = dir > 0 ? bbox.x - bbox.w * 0.25 : bbox.x + bbox.w * 1.25;
    const x = startX + dir * f * bbox.w * 1.5;
    const baseY = bbox.y + bbox.h * clamp(p.height, 0, 1);
    const y = baseY + Math.sin(t * 1.7) * bbox.h * p.bob;
    const s = bbox.h * p.size;

    g.save();
    g.clip(shape.path);

    if (p.trail > 0) {
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 40; i++) {
        const tf = i / 40;
        const tx = x - dir * tf * s * 6;
        const ty = y + noise.noise2(i * 0.5, t) * s * 0.25 + tf * s * 0.2;
        g.globalAlpha = (1 - tf) * 0.5 * p.trail;
        const r = s * 0.06 * (1 - tf * 0.6);
        const grad = g.createRadialGradient(tx, ty, 0, tx, ty, r * 3);
        grad.addColorStop(0, rgba(p.color, 0.9));
        grad.addColorStop(1, rgba(p.color, 0));
        g.fillStyle = grad;
        g.beginPath();
        g.arc(tx, ty, r * 3, 0, TAU);
        g.fill();
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
    }

    g.translate(x, y);
    g.scale(dir, 1);
    if (p.silhouette) {
      g.globalCompositeOperation = 'destination-out';
      g.fillStyle = '#000';
      g.strokeStyle = '#000';
    } else {
      g.fillStyle = p.color;
      g.strokeStyle = p.color;
    }
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.lineWidth = s * 0.035;

    const team = Math.round(p.reindeer);
    const spacing = s * 1.15;
    const lead = (i) => -s * 1.5 - i * spacing;
    // Each deer rises and falls a little out of phase with the one ahead, so the
    // team undulates down its length instead of pumping in unison.
    const lift = (i) => Math.sin(t * 2.6 - i * 0.9) * s * 0.05;

    // Traces first, so the team is drawn over its own harness.
    if (team > 0) {
      g.lineWidth = s * 0.014;
      g.beginPath();
      g.moveTo(-s * 0.34, -s * 0.2);
      for (let i = 0; i < team; i++) g.lineTo(lead(i) + s * 0.3, lift(i) - s * 0.12);
      g.lineTo(lead(team - 1) - s * 0.4, lift(team - 1) - s * 0.2);
      g.stroke();
      g.lineWidth = s * 0.035;
    }

    for (let i = 0; i < team; i++) {
      // Alternate deer lead with the opposite pair of legs, which is what stops
      // the team looking like one animal copied along a line.
      const gallop = t * 9.5 - i * 1.9 + (i % 2) * Math.PI;
      g.save();
      g.translate(lead(i), lift(i));
      drawReindeer(g, s, gallop, s * 0.035);
      g.restore();
    }

    drawSleigh(g, s, t, s * 0.035);

    g.restore();
  },
};

const icicles = {
  id: 'icicles',
  name: 'Icicles',
  category: 'christmas',
  scope: 'shape',
  description: 'Ice hanging from the top edge of the shape, growing and glinting.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#bfe9ff' },
    { key: 'tip', type: 'color', label: 'Tip colour', default: '#ffffff' },
    { key: 'count', type: 'range', label: 'Icicles', default: 16, min: 2, max: 90, step: 1 },
    { key: 'length', type: 'range', label: 'Length', default: 0.25, min: 0.02, max: 1, step: 0.005 },
    { key: 'variation', type: 'range', label: 'Variation', default: 0.6, min: 0, max: 1, step: 0.01 },
    { key: 'width', type: 'range', label: 'Width', default: 1, min: 0.2, max: 3, step: 0.05 },
    { key: 'grow', type: 'range', label: 'Grow time (s)', default: 0, min: 0, max: 60, step: 0.5 },
    { key: 'glint', type: 'range', label: 'Glint', default: 0.5, min: 0, max: 1, step: 0.01 },
  ],
  init() {
    return { spikes: null, count: 0 };
  },
  draw({ g, p, shape, t, rng, state }) {
    const { bbox } = shape;
    const count = Math.round(p.count);
    if (state.count !== count) {
      state.count = count;
      state.spikes = Array.from({ length: count }, () => ({
        len: 1 - p.variation * rng(),
        w: 0.6 + rng() * 0.8,
        glint: rng() * TAU,
      }));
    }

    const growth = p.grow > 0 ? clamp(t / p.grow, 0, 1) : 1;

    // Two placements. On a closed area, ice hangs from the top edge and is
    // clipped to the shape. On an open path — a gutter or a roofline, which is
    // what you actually trace for this — each icicle hangs from the path itself,
    // following its slope, with no clipping.
    const onPath = !shape.closed && shape.sampler.length > 0;
    const slot = onPath ? shape.sampler.length / count : bbox.w / count;
    const span = onPath ? Math.max(bbox.h, bbox.w * 0.3) : bbox.h;

    g.save();
    if (!onPath) g.clip(shape.path);

    for (let i = 0; i < count; i++) {
      const spike = state.spikes[i];
      const anchor = onPath
        ? shape.sampler.at((i + 0.5) / count)
        : { x: bbox.x + (i + 0.5) * slot, y: bbox.y };
      const x = anchor.x;
      const topY = anchor.y;
      const len = span * p.length * spike.len * growth;
      // Cap the width against the length. Spacing alone would let a sparse
      // string produce squat blue triangles rather than anything icicle-shaped.
      const w = Math.min(slot * 0.45 * p.width * spike.w, len * 0.3 * p.width);
      if (len <= 1 || w <= 0.2) continue;

      const grad = g.createLinearGradient(0, topY, 0, topY + len);
      grad.addColorStop(0, rgba(p.color, 0.9));
      grad.addColorStop(0.7, rgba(p.color, 0.55));
      grad.addColorStop(1, rgba(p.tip, 0.95));
      g.fillStyle = grad;

      g.beginPath();
      g.moveTo(x - w, topY);
      g.quadraticCurveTo(x - w * 0.35, topY + len * 0.65, x, topY + len);
      g.quadraticCurveTo(x + w * 0.35, topY + len * 0.65, x + w, topY);
      g.closePath();
      g.fill();

      if (p.glint > 0) {
        const sparkle = Math.max(0, Math.sin(t * 2 + spike.glint));
        if (sparkle > 0.9) {
          g.save();
          g.globalCompositeOperation = 'lighter';
          g.globalAlpha = (sparkle - 0.9) * 10 * p.glint;
          const gy = topY + len * 0.85;
          const grd = g.createRadialGradient(x, gy, 0, x, gy, w * 2.5);
          grd.addColorStop(0, '#ffffff');
          grd.addColorStop(1, 'rgba(255,255,255,0)');
          g.fillStyle = grd;
          g.beginPath();
          g.arc(x, gy, w * 2.5, 0, TAU);
          g.fill();
          g.restore();
        }
      }
    }
    g.restore();
  },
};

const stars = {
  id: 'stars',
  name: 'Twinkling Stars',
  category: 'christmas',
  scope: 'shape',
  description: 'A field of twinkling stars, with optional occasional shooting stars.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#ffffff' },
    { key: 'count', type: 'range', label: 'Stars', default: 140, min: 5, max: 900, step: 5 },
    { key: 'size', type: 'range', label: 'Size', default: 4, min: 0.5, max: 24, step: 0.25 },
    { key: 'twinkle', type: 'range', label: 'Twinkle speed', default: 1, min: 0, max: 8, step: 0.05 },
    { key: 'spikes', type: 'bool', label: 'Four-point spikes', default: true },
    { key: 'shooting', type: 'range', label: 'Shooting stars / min', default: 4, min: 0, max: 60, step: 1 },
  ],
  init() {
    return { stars: null, count: 0 };
  },
  draw({ g, p, shape, t, rng, state }) {
    const { bbox } = shape;
    const count = Math.round(p.count);
    if (state.count !== count) {
      state.count = count;
      state.stars = Array.from({ length: count }, () => ({
        x: rng(),
        y: rng(),
        s: 0.3 + rng() * 0.9,
        phase: rng() * TAU,
      }));
    }

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';

    for (const star of state.stars) {
      const x = bbox.x + star.x * bbox.w;
      const y = bbox.y + star.y * bbox.h;
      const tw = p.twinkle > 0 ? 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * p.twinkle + star.phase)) : 1;
      const r = p.size * star.s * 0.5 * tw;
      g.globalAlpha = tw;
      g.fillStyle = p.color;
      g.beginPath();
      g.arc(x, y, r, 0, TAU);
      g.fill();

      if (p.spikes && r > 1) {
        g.strokeStyle = rgba(p.color, 0.5 * tw);
        g.lineWidth = Math.max(0.5, r * 0.35);
        g.beginPath();
        g.moveTo(x - r * 3.2, y);
        g.lineTo(x + r * 3.2, y);
        g.moveTo(x, y - r * 3.2);
        g.lineTo(x, y + r * 3.2);
        g.stroke();
      }
    }

    if (p.shooting > 0) {
      const interval = 60 / p.shooting;
      const index = Math.floor(t / interval);
      const local = (t % interval) / 1.1;
      if (local < 1) {
        // Deterministic per shooting-star index, so all projectors agree.
        const sx = ((index * 9301 + 49297) % 233280) / 233280;
        const sy = ((index * 4523 + 12345) % 100000) / 100000;
        const x0 = bbox.x + sx * bbox.w;
        const y0 = bbox.y + sy * bbox.h * 0.5;
        const dx = bbox.w * 0.35;
        const dy = bbox.h * 0.22;
        const x = x0 + dx * local;
        const y = y0 + dy * local;
        const alpha = Math.sin(local * Math.PI);
        const grad = g.createLinearGradient(x - dx * 0.22, y - dy * 0.22, x, y);
        grad.addColorStop(0, rgba(p.color, 0));
        grad.addColorStop(1, rgba(p.color, alpha));
        g.globalAlpha = 1;
        g.strokeStyle = grad;
        g.lineWidth = p.size * 0.5;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(x - dx * 0.22, y - dy * 0.22);
        g.lineTo(x, y);
        g.stroke();
      }
    }
    g.restore();
  },
};

const aurora = {
  id: 'aurora',
  name: 'Aurora',
  category: 'christmas',
  scope: 'shape',
  description: 'Slow curtains of northern-lights colour. Lovely across a whole wall.',
  params: [
    { key: 'color', type: 'color', label: 'Colour A', default: '#2bff88' },
    { key: 'color2', type: 'color', label: 'Colour B', default: '#7b5cff' },
    { key: 'bands', type: 'range', label: 'Curtains', default: 5, min: 1, max: 14, step: 1 },
    { key: 'speed', type: 'range', label: 'Speed', default: 0.12, min: 0, max: 1.5, step: 0.005 },
    { key: 'amplitude', type: 'range', label: 'Waviness', default: 0.2, min: 0, max: 0.8, step: 0.01 },
    { key: 'thickness', type: 'range', label: 'Thickness', default: 0.22, min: 0.02, max: 1, step: 0.01 },
    { key: 'level', type: 'range', label: 'Brightness', default: 0.7, min: 0, max: 1.5, step: 0.01 },
  ],
  draw({ g, p, shape, t, noise }) {
    const { bbox } = shape;
    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha *= clamp(p.level, 0, 2);

    const bands = Math.round(p.bands);
    const cols = 40;
    for (let b = 0; b < bands; b++) {
      const f = b / Math.max(1, bands - 1 || 1);
      // Linear blend: two light sources mixing, not two pigments.
      const colour = mixLinear(p.color, p.color2, f);
      const yBase = bbox.y + bbox.h * (0.15 + f * 0.55);
      const thickness = bbox.h * p.thickness * (0.6 + 0.6 * (1 - f));

      g.beginPath();
      for (let i = 0; i <= cols; i++) {
        const u = i / cols;
        const x = bbox.x + u * bbox.w;
        const y = yBase + noise.noise3(u * 2.2, b * 3.7, t * p.speed) * bbox.h * p.amplitude;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      for (let i = cols; i >= 0; i--) {
        const u = i / cols;
        const x = bbox.x + u * bbox.w;
        const y =
          yBase +
          noise.noise3(u * 2.2, b * 3.7, t * p.speed) * bbox.h * p.amplitude +
          thickness * (0.6 + 0.4 * noise.noise2(u * 3, b));
        g.lineTo(x, y);
      }
      g.closePath();

      const grad = g.createLinearGradient(0, yBase - thickness * 0.3, 0, yBase + thickness);
      grad.addColorStop(0, rgba(colour, 0));
      grad.addColorStop(0.35, rgba(colour, 0.45));
      grad.addColorStop(1, rgba(colour, 0));
      g.fillStyle = grad;
      g.fill();
    }
    g.restore();
  },
};

const candyStripe = {
  id: 'candy-stripe',
  name: 'Candy Cane Stripes',
  category: 'christmas',
  scope: 'shape',
  description: 'Diagonal barber stripes that travel along the shape. Made for door frames.',
  params: [
    { key: 'color', type: 'color', label: 'Colour A', default: '#ff2d2d' },
    { key: 'color2', type: 'color', label: 'Colour B', default: '#ffffff' },
    { key: 'stripes', type: 'range', label: 'Stripes', default: 14, min: 2, max: 80, step: 1 },
    { key: 'angle', type: 'range', label: 'Angle', default: 35, min: 0, max: 180, step: 1 },
    { key: 'speed', type: 'range', label: 'Speed', default: 0.25, min: -3, max: 3, step: 0.01 },
    { key: 'mode', type: 'select', label: 'Mode', default: 'fill', options: ['fill', 'outline'] },
    { key: 'width', type: 'range', label: 'Outline width', default: 18, min: 1, max: 90, step: 0.5 },
  ],
  draw({ g, p, shape, t }) {
    const { bbox } = shape;
    if (bbox.w <= 0 || bbox.h <= 0) return;

    const a = (p.angle * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const diag = Math.hypot(bbox.w, bbox.h) * 1.2;
    const period = diag / Math.max(2, Math.round(p.stripes));
    const shift = frac(t * p.speed);
    const bands = Math.ceil(diag / period) + 2;

    // Stripe corners are computed in world coordinates rather than by rotating
    // the context, so the same band can clip a stroke of the untransformed path.
    const toWorld = (u, v) => ({
      x: bbox.cx + u * cos - v * sin,
      y: bbox.cy + u * sin + v * cos,
    });

    g.save();
    g.lineWidth = p.width;
    g.lineJoin = 'round';
    if (p.mode === 'fill') g.clip(shape.path);

    for (let i = -bands; i <= bands; i++) {
      const colour = (((i % 2) + 2) % 2) === 0 ? p.color : p.color2;
      const offset = (i + shift) * period;

      const c0 = toWorld(offset - period / 2, -diag);
      const c1 = toWorld(offset + period / 2, -diag);
      const c2 = toWorld(offset + period / 2, diag);
      const c3 = toWorld(offset - period / 2, diag);

      g.save();
      g.beginPath();
      g.moveTo(c0.x, c0.y);
      g.lineTo(c1.x, c1.y);
      g.lineTo(c2.x, c2.y);
      g.lineTo(c3.x, c3.y);
      g.closePath();

      if (p.mode === 'outline') {
        g.clip();
        g.strokeStyle = colour;
        g.stroke(shape.path);
      } else {
        g.fillStyle = colour;
        g.fill();
      }
      g.restore();
    }
    g.restore();
  },
};

export default [snow, santa, icicles, stars, aurora, candyStripe];
