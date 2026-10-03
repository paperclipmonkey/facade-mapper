/**
 * Christmas effects.
 *
 * Same engine as the Halloween set, different mood. Snow and stars are usually
 * pointed at a whole wall (leave a layer's targets empty and it covers the frame);
 * icicles and candy stripes want a specific edge or outline.
 */

import { rgba, clamp, lerp, TAU, frac, makeRng, hexToRgb, pointInPolygon } from '../../core/math.js';
import { mixLinear, srgbToLinear, linearToSrgb, blackbodyCss } from '../color.js';
import { offscreen } from '../lib.js';
import {
  ensureSurfaces,
  sweepLanding,
  settle,
  shedSlabs,
  advanceSlabs,
  driftProfile,
  traceDriftTop,
  DRIFT_MIN,
} from '../collide.js';

/**
 * This instance's own baked sprites, keyed by what they were baked from.
 *
 * Every sprite in this file is baked into its instance's `state` rather than
 * into a cache shared across layers. Shared would be cheaper, but then what an
 * instance bakes would depend on what else had happened to draw before it —
 * in this tab, ever — and the baking is part of the history two projector
 * tabs have to agree on.
 */
function bakedFor(state) {
  return state.baked || (state.baked = new Map());
}

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
 *
 * The ladder lives on plain `<canvas>` elements — see `fx.offscreen`. Baking it
 * onto `OffscreenCanvas` handed the entire saving straight back: the blit
 * itself became the bottleneck, and snow went from the cheapest particle effect
 * in the library to the most expensive thing in the show by a wide margin.
 */
const SPRITE_PX = 64;
const SPRITE_LEVELS = 6;

function buildFlakeSprites(colour) {
  const sprites = [];
  for (let i = 0; i < SPRITE_LEVELS; i++) {
    const softness = i / (SPRITE_LEVELS - 1);
    const canvas = offscreen(SPRITE_PX, SPRITE_PX);
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
    // The settled snow's three tones, worked out once per colour. Snow is lit
    // by the whole sky, so its body takes a blue cast and only the top sees
    // anything like direct light: the split between a cool shadowed face and
    // a lit crest is most of what makes a white band read as a rounded volume.
    state.tones = {
      shadow: rgba(mixLinear(colour, '#7f97bd', 0.36), 0.92),
      lit: rgba(mixLinear(colour, '#ffffff', 0.25), 0.8),
      crest: rgba(mixLinear(colour, '#ffffff', 0.7), 0.95),
      halo: rgba(colour, 0.12),
    };
  }
  return state.sprites;
}

/* ------------------------------------------------------------------ *
 * Settled snow
 *
 * The simulation keeps a depth per column of each ledge, and every landing
 * goes into the one column the flake hit. With a few hundred flakes that is a
 * sparse, spiky record — and drawn as it stands, each loaded run of columns
 * its own little shape, it came out as dashed white bars along every sill.
 *
 * Snow does not lie like that. On anything flat it settles evenly, rounds off
 * at the ends where it overhangs, and its surface undulates gently. So the
 * picture is drawn from a *display* profile, not from the raw columns: the
 * short gaps between loaded columns — which are only the statistics of a few
 * hundred flakes — are bridged, so a ledge that is receiving snow carries one
 * continuous drift; long bare stretches, where something above shelters the
 * ledge, stay bare. Then it is blurred along the ledge (never across a step to
 * a different ledge) and tapered into a rounded nose at each end. The
 * simulation is untouched — this is only how its state is painted.
 *
 * The profile itself lives in collide.js, `driftProfile` and `traceDriftTop`,
 * because `fx.drawDrift` paints from it too: a custom effect that lands
 * things on the house gets drifts rather than dashes.
 * ------------------------------------------------------------------ */

/**
 * Paint every ledge's snow: a cool shadowed body sitting on the ledge, a lit
 * band along its top, a bright crest, and a breath of glow above it so the
 * edge is soft rather than cut out.
 */
function paintDrifts(g, surfaces, tones, scratch) {
  g.lineJoin = 'round';
  g.lineCap = 'round';
  for (const { field, drift } of surfaces) {
    const { surface, cols, colW } = field;
    if (scratch.length < cols * 2) continue;
    const prof = scratch.subarray(0, cols);
    driftProfile(drift, field, prof, scratch.subarray(cols, cols * 2));
    let c = 0;
    while (c < cols) {
      if (!(prof[c] >= DRIFT_MIN) || !Number.isFinite(surface[c])) {
        c++;
        continue;
      }
      let end = c;
      let deepest = prof[c];
      while (end + 1 < cols && prof[end + 1] >= DRIFT_MIN && Number.isFinite(surface[end + 1])
        && Math.abs(surface[end + 1] - surface[end]) < colW * 2.5) {
        end++;
        deepest = Math.max(deepest, prof[end]);
      }

      // A dusting is a faint grey film, not a bright line: thin runs are drawn
      // weaker, and only a real drift gets the full white.
      g.globalAlpha = clamp(0.3 + deepest / 4.5, 0.3, 1);

      // The body, down to the ledge it sits on.
      g.beginPath();
      traceDriftTop(g, surface, prof, colW, c, end, true);
      for (let i = end; i >= c; i--) g.lineTo((i + 0.5) * colW, surface[i]);
      g.closePath();
      g.fillStyle = tones.shadow;
      g.fill();

      // The lit upper face and the crest, kept inside the body so the light
      // falls off downwards into the shadow rather than spilling over the edge.
      g.save();
      g.clip();
      g.beginPath();
      traceDriftTop(g, surface, prof, colW, c, end, true);
      g.strokeStyle = tones.lit;
      g.lineWidth = Math.max(1.5, Math.min(9, deepest * 0.9));
      g.stroke();
      g.strokeStyle = tones.crest;
      g.lineWidth = Math.max(1, Math.min(3, deepest * 0.35));
      g.stroke();
      g.restore();

      // A breath of light above the crest: soft, not cut out.
      g.beginPath();
      traceDriftTop(g, surface, prof, colW, c, end, true);
      g.strokeStyle = tones.halo;
      g.lineWidth = Math.max(2.5, Math.min(7, deepest * 0.6));
      g.stroke();

      c = end + 1;
    }
  }
  g.globalAlpha = 1;
}

/**
 * Snow coming off a ledge, breaking up as it falls.
 *
 * A slab is a run of drift that let go together, and it does not stay a slab:
 * it comes apart into lumps that tumble and spread, shedding powder. Drawn as
 * the one wide flat shape it starts as — which is what the shared slab drawing
 * does — it is a white dash sliding down the wall. So each is a few round
 * puffs spread across its width, drifting apart and swelling as it ages, with
 * the powder trailing above. Where each puff sits is a function of the slab's
 * own numbers, so it needs no memory of its own.
 */
function paintSlabs(g, surfaces, sprites) {
  const soft = sprites[Math.min(SPRITE_LEVELS - 1, 3)];
  const softer = sprites[SPRITE_LEVELS - 1];
  for (const { drift } of surfaces) {
    for (const slab of drift.slabs) {
      const alpha = slab.alpha ?? 1;
      if (alpha <= 0.01) continue;
      const stretch = slab.stretch ?? 1;
      const age = slab.age || 0;
      const h = Math.max(3, slab.h);
      const lumps = clamp(Math.round(slab.w / (h * 1.6)), 2, 6);
      const spread = 1 + age * 0.5;
      for (let k = 0; k < lumps; k++) {
        const j1 = frac(Math.sin(slab.w * 12.9898 + k * 78.233) * 43758.5453);
        const j2 = frac(Math.sin(slab.h * 39.3468 + k * 11.135) * 24634.6345);
        const j3 = frac(Math.sin(slab.w * 7.233 + slab.h * 3.17 + k * 51.71) * 15731.743);
        // Unevenly spaced across the slab, and each lump falls at its own
        // rate, so they open out downwards as well as sideways — a row of
        // evenly spaced beads is as much a pattern as the dash was.
        const slot = lumps > 1 ? (k + (j1 - 0.5) * 0.8) / (lumps - 1) - 0.5 : 0;
        const px = slab.x + slot * slab.w * 0.8 * spread;
        const py = slab.y + (j2 - 0.5) * h * 1.4 + (j3 - 0.4) * age * age * 160;
        // Mostly small, now and then a big one: snow breaks into a few chunks
        // and a lot of crumbs.
        const d = h * (1.1 + 1.9 * j3 * j3) * (1 + age * 0.4);
        g.globalAlpha = alpha * 0.8 * Math.max(0.4, 1 - age * 0.35);
        g.drawImage(soft, px - d / 2, py - (d * stretch) / 2, d, d * stretch);
      }
      // Powder shaken loose, trailing above the lumps and thinning out.
      const w = slab.w * spread;
      for (let k = 1; k <= 3; k++) {
        const pw = w * (1 - k * 0.15);
        const ph = h * (1.5 + k * 0.6) * stretch;
        g.globalAlpha = (alpha * 0.18) / k;
        g.drawImage(softer, slab.x - pw / 2, slab.y - h * 0.7 * k - ph / 2, pw, ph);
      }
    }
  }
  g.globalAlpha = 1;
}

const NO_SHAPES = [];
const hasEdges = (geo) => geo.points && geo.points.length > 1;

/**
 * The shapes snow settles on: every other traced shape, or only those carrying
 * one of the tags in `colliderTag`, which takes a single tag or a comma-separated
 * list of them.
 *
 * A list because a facade's ledges are not one kind of thing. Snow belongs on
 * the gutter, the sills, the chimney and the porch roof, and not on the shapes
 * traced as *places* rather than as objects — the clear panel a message goes
 * in, the space above a pot a plant grows into, the garden path — where a
 * drift is a white line across a flat wall. One tag could only ever choose one
 * of those kinds.
 *
 * Kept in the order of the project's own shape list whatever order the tags
 * are given in, so the surfaces built from it keep their identity frame to
 * frame.
 */
function snowColliders(p, shape, shapes) {
  if (!p.collide || typeof shapes !== 'function') return NO_SHAPES;
  const wanted = String(p.colliderTag || '');
  if (wanted.indexOf(',') < 0) return shapes(wanted, shape.id).filter(hasEdges);
  const allowed = new Set();
  let named = 0;
  for (const tag of wanted.split(',')) {
    const name = tag.trim();
    if (!name) continue;
    named++;
    for (const geo of shapes(name, shape.id)) allowed.add(geo.id);
  }
  // A list with nothing in it — a stray comma — means what an empty field does.
  if (!named) return shapes('', shape.id).filter(hasEdges);
  return shapes('', shape.id).filter((geo) => allowed.has(geo.id) && hasEdges(geo));
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
    { key: 'colliderTag', type: 'text', label: 'Settle on tags', default: '' },
    { key: 'buildUp', type: 'range', label: 'Build-up rate', default: 2.5, min: 0, max: 15, step: 0.1 },
    { key: 'maxDepth', type: 'range', label: 'Depth before it slides', default: 22, min: 2, max: 120, step: 1 },
    { key: 'shed', type: 'range', label: 'Slide-off chance', default: 0.3, min: 0, max: 3, step: 0.01 },
  ],
  init() {
    return { flakes: [], count: 0, sprites: null, spriteKey: null };
  },
  step({ p, shape, shapes, world, t, dt, rng, state, noise }) {
    const { bbox } = shape;
    if (bbox.w <= 0 || bbox.h <= 0) return;
    const target = Math.round(p.count);

    /**
     * Everything else in the scene is what snow lands on. Excluding the shape
     * we are drawing into matters: snow aimed at the whole frame should settle
     * on the house, not on the frame's own bottom edge — that edge is where
     * slabs are supposed to disappear.
     */
    const colliders = snowColliders(p, shape, shapes);
    const surfaces = colliders.length ? ensureSurfaces(state, 'surfaces', colliders, world, 260) : null;

    const spawn = (flake = {}, atTop = true) => {
      flake.x = bbox.x + rng() * bbox.w;
      flake.y = atTop ? bbox.y - rng() * bbox.h * 0.1 : bbox.y + rng() * bbox.h;
      // Depth drives size, speed, brightness *and* focus together, which is what
      // sells the parallax without needing separate layers. Weighted towards the
      // far end, because a slab of air holds more snow the further it is from
      // you: a uniform spread puts as many flakes at arm's length as at the
      // house, and the near ones, being the largest, swamp the picture.
      flake.z = 1 - p.depth * Math.pow(rng(), 0.75);
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

      // Landing. A flake that hits a drift adds its own volume to that column
      // and is recycled at the top, which keeps the flake count — and so the
      // cost — flat however long the show runs.
      if (surfaces && p.buildUp > 0) {
        const hit = sweepLanding(surfaces, flake.x, prevY, flake.y);
        if (hit) {
          const r = p.size * z * 0.5;
          const { field, drift } = hit.surface;
          // Volume in, depth out: a flake's area spread across the column it
          // landed in. Big near flakes therefore build a drift much faster than
          // distant specks, which is both correct and what you want to look at.
          //
          // Scaled well beyond one flake's own area, because each flake drawn
          // stands in for a great many real ones: at face value a few hundred
          // of them laid barely a pixel and a half on a sill in the first
          // fifteen seconds, which on the wall is a white hairline rather than
          // snow. At this rate the default lays a visible drift inside half a
          // minute and reaches its slide-off depth in about a minute.
          drift.depth[hit.col] += (Math.PI * r * r * p.buildUp * 2.6) / field.colW;
          spawn(flake, true);
        }
      }
    }

    if (surfaces) {
      // Slumping, shedding and falling all happen once per step per surface,
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
    }
  },
  draw({ g, p, shape, shapes, world, state, stable = p }) {
    const { bbox } = shape;
    if (bbox.w <= 0 || bbox.h <= 0) return;

    const colliders = snowColliders(p, shape, shapes);
    const surfaces = colliders.length ? ensureSurfaces(state, 'surfaces', colliders, world, 260) : null;
    const sprites = ensureFlakeSprites(state, stable.color);

    g.save();
    g.clip(shape.path);

    /**
     * Sorting back to front costs nothing at these counts and means near flakes
     * correctly occlude far ones.
     *
     * Into a list of its own, emphatically not in place. `state.flakes` is
     * simulation state, and the simulation shortens it from the end when the
     * flake count comes down — so sorting it here made *which flakes survive* a
     * question of how many times this tab had painted. Two tabs at different
     * frame rates then culled different flakes and snowed differently for the
     * rest of the evening, which only showed up with the count bound to
     * something, because nothing else ever shortens the list.
     *
     * The list is kept on the state and refilled rather than rebuilt, so a
     * couple of thousand flakes do not allocate an array a frame.
     */
    const order = state.order || (state.order = []);
    order.length = state.flakes.length;
    for (let i = 0; i < state.flakes.length; i++) order[i] = state.flakes[i];
    order.sort((a, b) => a.z - b.z);

    // The drift sits on the house, so it belongs between the flakes falling
    // behind it and the ones falling in front. Splitting the pass at the depth
    // where flakes stop landing is what stops the house looking pasted on.
    let drewDrift = !surfaces;
    const paintDrift = () => {
      drewDrift = true;
      g.globalAlpha = 1;
      let widest = 0;
      for (const { field } of surfaces) widest = Math.max(widest, field.cols);
      if (!state.profile || state.profile.length < widest * 2) state.profile = new Float32Array(widest * 2);
      paintDrifts(g, surfaces, state.tones, state.profile);
      paintSlabs(g, surfaces, sprites);
    };

    for (const flake of order) {
      const z = flake.z;
      /**
       * Perspective, not a linear scale. A flake at arm's length is ten times
       * the size of one at the house, not twice; drawn linearly every flake is
       * much the same speck and the fall has no depth at all. Cubed, the far
       * field stays a fine grain and the last few near flakes are big.
       */
      const r = p.size * 0.5 * (0.4 + 1.4 * z * z * z);

      if (surfaces && !drewDrift && z >= 0.62) paintDrift();

      // Presented area varies as the plate rocks: a flake edge-on nearly
      // disappears, which is the twinkle.
      const facing = 0.35 + 0.65 * Math.abs(Math.cos(flake.tilt));
      const alpha = clamp((0.25 + 0.75 * z) * facing, 0, 1);

      // Depth of field. A camera focused on the house renders flakes a metre
      // from the lens as soft discs; drawing every flake sharp is the single
      // most obvious tell that it is an overlay.
      const spread = p.blur * Math.max(0, z - 0.6) * 34;
      const level = Math.min(
        SPRITE_LEVELS - 1,
        Math.round((spread / (spread + Math.max(0.6, r))) * (SPRITE_LEVELS - 1) * 1.6)
      );
      // Blur spreads the same light over more area, so a soft flake is dimmer.
      const rx = Math.max(0.5, r) + spread;
      const ry = Math.max(0.5, r * facing) + spread;
      g.globalAlpha = alpha * Math.max(0.22, 1 - spread / (spread + r * 1.5));

      // Squashed along the tumble axis, so flakes read as plates not spheres.
      g.save();
      g.translate(flake.x, flake.y);
      g.rotate(flake.tilt);
      g.drawImage(sprites[level], -rx, -ry, rx * 2, ry * 2);
      g.restore();
    }

    g.globalAlpha = 1;
    if (surfaces && !drewDrift) paintDrift();
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
 *
 * `separator`, when given, is the colour of the thin gap stroked round Santa
 * so he stands apart from the sack behind him; leave it out for a solid cut.
 */
export function drawSleigh(g, s, t, lineWidth, separator = null) {
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

  /**
   * The sack, piled up behind him against the seat back. Its lumpy outline
   * and the knot at the neck are, after the hat, the most recognisable thing
   * in the whole silhouette — without it a figure in a sleigh could be anyone.
   */
  g.beginPath();
  g.moveTo(0.2 * s, 0.02 * s);
  g.bezierCurveTo(0.17 * s, -0.16 * s, 0.24 * s, -0.33 * s, 0.37 * s, -0.37 * s);
  g.quadraticCurveTo(0.43 * s, -0.4 * s, 0.47 * s, -0.36 * s);
  g.bezierCurveTo(0.56 * s, -0.3 * s, 0.56 * s, -0.12 * s, 0.5 * s, 0.02 * s);
  g.closePath();
  g.fill();
  // The knot, and the tied-off neck flaring above it.
  g.beginPath();
  g.moveTo(0.38 * s, -0.38 * s);
  g.quadraticCurveTo(0.39 * s, -0.46 * s, 0.34 * s, -0.5 * s);
  g.quadraticCurveTo(0.42 * s, -0.49 * s, 0.45 * s, -0.43 * s);
  g.quadraticCurveTo(0.47 * s, -0.5 * s, 0.52 * s, -0.49 * s);
  g.quadraticCurveTo(0.47 * s, -0.44 * s, 0.46 * s, -0.37 * s);
  g.closePath();
  g.fill();

  // Santa: leaning forward, one arm out on the reins, the other up mid-wave.
  const wave = Math.sin(t * 5.5);
  g.save();
  g.translate(0.12 * s, -0.14 * s);
  g.rotate(-0.12);
  // Seated, so the body is a heavy rounded wedge — broad at the seat, the
  // belly pushed forward towards the reins, narrowing to the shoulders. An
  // upright ellipse with a ball on top, which this was, is a snowman.
  g.beginPath();
  g.moveTo(0.1 * s, 0.17 * s);
  g.bezierCurveTo(-0.08 * s, 0.19 * s, -0.2 * s, 0.1 * s, -0.17 * s, -0.02 * s);
  g.bezierCurveTo(-0.15 * s, -0.12 * s, -0.08 * s, -0.17 * s, -0.04 * s, -0.19 * s);
  g.lineTo(0.08 * s, -0.19 * s);
  g.bezierCurveTo(0.14 * s, -0.14 * s, 0.17 * s, 0.02 * s, 0.1 * s, 0.17 * s);
  g.closePath();
  // A thin dark gap round him first, the way silhouette art separates a
  // figure from what is behind it: without it he and the sack are one lump.
  if (separator) {
    g.save();
    g.strokeStyle = separator;
    g.lineWidth = w * 1.6;
    g.stroke();
    g.restore();
  }
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

  // Head: smaller than the body suggests, sunk into the beard and the collar.
  g.beginPath();
  g.arc(-0.01 * s, -0.27 * s, 0.085 * s, 0, TAU);
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

const separatorCache = new Map();

/** The figure's own colour, nearly put out: a gap that reads as a gap on a lit sky. */
function separatorFor(colour) {
  let css = separatorCache.get(colour);
  if (!css) {
    css = rgba(mixLinear(colour, '#000000', 0.86), 1);
    separatorCache.set(colour, css);
  }
  return css;
}

/** A star-shaped glint in one colour, for glitter and sparkle. */
function glintSprite(store, colour) {
  const key = `glint|${colour}`;
  let sprite = store.get(key);
  if (!sprite) {
    sprite = bakeDrop(colour);
    store.set(key, sprite);
  }
  return sprite;
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
  draw({ g, p, shape, t, state, stable = p }) {
    const { bbox } = shape;
    const interval = Math.max(1, p.interval);
    const cycle = t % interval;
    if (cycle > p.crossing) return;

    const dir = p.direction === 'left' ? -1 : 1;
    const startX = dir > 0 ? bbox.x - bbox.w * 0.25 : bbox.x + bbox.w * 1.25;
    const baseY = bbox.y + bbox.h * clamp(p.height, 0, 1);
    // Where the rig is at any moment of its crossing — wanted for now, and for
    // the moments the glitter behind it was shed.
    const rigX = (at) => startX + dir * ((at % interval) / p.crossing) * bbox.w * 1.5;
    const rigY = (at) => baseY + Math.sin(at * 1.7) * bbox.h * p.bob;
    const x = rigX(t);
    const y = rigY(t);
    const s = bbox.h * p.size;

    g.save();
    g.clip(shape.path);

    /**
     * A trail of glitter shed from the runners: each fleck is let go at a
     * fixed rate, stays where the sleigh was when it let go, sinks and
     * twinkles out. Stamped from one baked glint rather than built from a
     * radial gradient per fleck per frame, and every fleck is a function of
     * its own release time, so two tabs shed the same glitter.
     */
    if (p.trail > 0) {
      const glint = glintSprite(bakedFor(state), stable.color);
      const rate = 70;
      const life = 2.4;
      const newest = Math.floor(t * rate);
      g.globalCompositeOperation = 'lighter';
      for (let k = 0; k < rate * life; k++) {
        const id = newest - k;
        const shed = id / rate;
        const age = t - shed;
        if (age < 0 || age > life) continue;
        const was = shed % interval;
        if (was < 0 || was > p.crossing) continue;
        const h1 = frac(Math.sin(id * 12.9898) * 43758.5453);
        const h2 = frac(Math.sin(id * 78.233) * 12543.123);
        // Off the back of the runners, spreading into a widening band as it
        // drifts and sinks.
        const fx = rigX(shed) - dir * s * (0.5 + 0.25 * h1) - dir * age * s * 0.3;
        const fy = rigY(shed) + s * 0.24 + (h2 - 0.5) * s * 0.3 * (0.4 + age) + age * age * s * 0.32;
        const fade = 1 - age / life;
        const twinkle = 0.5 + 0.5 * Math.sin(t * 17 + id * 2.3);
        const d = s * (0.07 + 0.12 * h1) * (0.6 + 0.6 * twinkle) * (0.6 + 0.4 * fade);
        g.globalAlpha = clamp(fade * (0.35 + 0.65 * twinkle) * p.trail, 0, 1);
        g.drawImage(glint, fx - d / 2, fy - d / 2, d, d);
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
    }

    g.translate(x, y);
    // The rig is drawn nose-left — the team sits at negative x, ahead of the
    // sleigh at the origin — so travelling right has to mirror it and
    // travelling left must not. Hence -dir: `dir` alone flew it backwards in
    // both directions, sleigh first and reindeer trailing.
    g.scale(-dir, 1);
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

    drawSleigh(g, s, t, s * 0.035, p.silhouette ? null : separatorFor(stable.color));

    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * Icicles
 *
 * An icicle is a long thin cone of clear ice, and almost everything that makes
 * it read as one is in how light gets through it rather than in its outline.
 * Seen at night it is mostly *not* bright: the body is clear and the wall shows
 * through it, the middle is darker than the edges because the edges are where
 * the surface turns away from you and reflects, and one shoulder carries a
 * hard specular streak from whatever lamp is lighting the street. Down its
 * length it is rippled where it froze in pulses, at the root it fattens into
 * the frosted lump it hangs from, and at the tip there is a drop.
 *
 * The old ones were flat light-blue triangles in a row at a fixed pitch, which
 * on a gutter reads as bunting. Two things fix that besides the drawing:
 *
 * - **Lengths are heavy-tailed.** Most icicles on a gutter are stubs; a few,
 *   where the meltwater happens to run, are very long. A uniform spread gives a
 *   comb; a skewed one gives ice.
 * - **They cluster.** Water does not run off a gutter evenly, so icicles form in
 *   clumps with bare stretches between, and the longest are in the middle of
 *   the clumps. Placing them by drawing from a lumpy density along the edge,
 *   rather than at equal steps, is what stops it being a sawtooth.
 *
 * The drawing itself is baked: a handful of canonical icicles per colour,
 * each a tall sprite with its own ripples and lean, stamped stretched to each
 * icicle's own length and thickness. One `drawImage` per icicle a frame, with
 * the glints and drips stamped on top.
 * ------------------------------------------------------------------ */

const ICICLE_W = 40;
const ICICLE_H = 220;
/** Where the root sits in the sprite, and how long and wide the canonical icicle is. */
const ICICLE_TOP = 8;
const ICICLE_LEN = 204;
const ICICLE_HALF = 12;
const ICICLE_VARIANTS = 8;

/**
 * One canonical icicle, root at the top of its sprite, tip at the bottom.
 *
 * Returned with the x offset of its tip, because each variant leans a little
 * and the drop has to land on the end of the ice rather than on its axis.
 */
function bakeIcicle(colour, tip, variant) {
  const canvas = offscreen(ICICLE_W, ICICLE_H);
  const c = canvas.getContext('2d');
  const r = makeRng(`icicle:${variant}`);
  const cx = ICICLE_W / 2;
  const len = ICICLE_LEN;
  const lean = (r() - 0.5) * 0.06;
  // Close to a straight cone: a strongly concave taper leaves the lower half
  // too thin to carry any light at house scale, and the icicle reads as half
  // its length.
  const taper = 0.72 + r() * 0.26;

  // Ripples: the ice froze in pulses, so its thickness wobbles down its length
  // at an irregular pitch, more strongly near the root where it is thick.
  const ripples = [];
  for (let s = 0.05 + r() * 0.05; s < 0.9; s += 0.05 + r() * 0.07) {
    ripples.push({ s, a: 0.04 + r() * 0.08, w: 0.01 + r() * 0.012 });
  }
  const rippleAt = (s) => {
    let v = 0;
    for (const k of ripples) v += k.a * Math.exp(-(((s - k.s) / k.w) ** 2));
    return v;
  };
  const halfAt = (s) =>
    ICICLE_HALF * Math.pow(Math.max(0, 1 - s), taper) * (1 + 0.55 * Math.exp(-s * 12)) * (1 + rippleAt(s));
  const xAt = (s) => cx + lean * s * s * len;

  /**
   * Shaded per pixel, once, rather than built from filled bands.
   *
   * Bands of flat colour down an icicle have edges, and at any size where the
   * ice is worth looking at those edges read as a mesh. Here every pixel knows
   * where it is across the cone (`u`, -1 to 1) and down it (`s`), and the
   * light is a smooth function of both: a cylinder's cross-section, so the
   * edges turn away and catch reflections while the middle stays clear and
   * dark; a specular streak down one shoulder as a narrow Gaussian; ripples as
   * ridges that curve round the surface rather than straight lines across it;
   * and rime at the root. Eight thousand pixels a variant, once per colour.
   */
  const [ir, ig, ib] = linearOf(colour);
  const [tr, tg, tb] = linearOf(tip);
  const image = c.createImageData(ICICLE_W, ICICLE_H);
  const data = image.data;
  for (let py = 0; py < ICICLE_H; py++) {
    const s = (py + 0.5 - ICICLE_TOP) / len;
    if (s < -0.02 || s > 1) continue;
    const sc = clamp(s, 0, 1);
    const half = halfAt(sc);
    const xc = xAt(sc);
    for (let px = 0; px < ICICLE_W; px++) {
      const dx = px + 0.5 - xc;
      // One pixel of anti-aliasing at the silhouette, and a soft start at the root.
      const cover = clamp(half - Math.abs(dx) + 0.5, 0, 1) * clamp((s + 0.02) / 0.03, 0, 1);
      if (cover <= 0) continue;
      const u = clamp(dx / Math.max(0.5, half), -1, 1);
      // Ridges sit lower at the edges than in the middle: they wrap the cone.
      const rip = rippleAt(sc - 0.012 * (1 - u * u));
      const body = lerp(0.38, 0.2, sc);
      const rim = Math.pow(Math.abs(u), 3.5) * (0.55 + 1.8 * rip) * (u < 0 ? 0.7 : 0.48);
      const spec = Math.exp(-(((u + 0.34) / 0.15) ** 2)) * lerp(1, 0.5, sc) * (0.85 + 2.4 * rip)
        + 0.32 * Math.exp(-(((u - 0.5) / 0.09) ** 2)) * (1 - 0.6 * sc);
      const rime = sc < 0.1 ? ((1 - sc / 0.1) ** 2) * 0.55 : 0;
      const light = body + rim + spec + rime;
      // Colour weighted by where the light came from: ice, its reflections,
      // and the white of the streak and the rime.
      const wIce = body + rim * 0.5;
      const wTip = spec + rim * 0.5 + rime;
      const lr = (ir * wIce + tr * wTip) / light;
      const lg = (ig * wIce + tg * wTip) / light;
      const lb = (ib * wIce + tb * wTip) / light;
      const o = (py * ICICLE_W + px) * 4;
      data[o] = Math.round(linearToSrgb(lr) * 255);
      data[o + 1] = Math.round(linearToSrgb(lg) * 255);
      data[o + 2] = Math.round(linearToSrgb(lb) * 255);
      data[o + 3] = Math.round(clamp(light, 0, 1) * cover * 255);
    }
  }
  c.putImageData(image, 0, 0);
  return { canvas, tipX: xAt(1) - cx };
}

/** A hex colour as linear-light components. */
function linearOf(hex) {
  const { r, g, b } = hexToRgb(hex);
  return [srgbToLinear(r / 255), srgbToLinear(g / 255), srgbToLinear(b / 255)];
}

function icicleSprites(store, colour, tip) {
  const key = `icicles|${colour}|${tip}`;
  let set = store.get(key);
  if (!set) {
    set = {
      variants: Array.from({ length: ICICLE_VARIANTS }, (_, v) => bakeIcicle(colour, tip, v)),
      drop: bakeDrop(tip),
      ridge: rgba(mixLinear(colour, tip, 0.4), 0.3),
    };
    store.set(key, set);
  }
  return set;
}

/**
 * A point of light for drops and glints: a hot core with a soft skirt, and a
 * faint four-way flare that is what a sparkle on wet ice actually looks like.
 */
function bakeDrop(colour) {
  const S = 64;
  const h = S / 2;
  const canvas = offscreen(S, S);
  const c = canvas.getContext('2d');
  c.globalCompositeOperation = 'lighter';
  const core = c.createRadialGradient(h, h, 0, h, h, h * 0.55);
  core.addColorStop(0, rgba('#ffffff', 1));
  core.addColorStop(0.2, rgba(colour, 0.85));
  core.addColorStop(0.5, rgba(colour, 0.25));
  core.addColorStop(1, rgba(colour, 0));
  c.fillStyle = core;
  c.fillRect(0, 0, S, S);
  for (const [w, hgt] of [[S, 3], [3, S]]) {
    const flare = c.createRadialGradient(h, h, 0, h, h, h);
    flare.addColorStop(0, rgba(colour, 0.55));
    flare.addColorStop(0.4, rgba(colour, 0.12));
    flare.addColorStop(1, rgba(colour, 0));
    c.fillStyle = flare;
    c.fillRect(h - w / 2, h - hgt / 2, w, hgt);
  }
  return canvas;
}

/**
 * Where a closed shape's top edge is at `x`: the highest edge crossing it.
 * Ice hangs from the lintel of an arched window, not from its bounding box.
 */
function topEdgeAt(points, x, fallback) {
  let best = Infinity;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const lo = Math.min(a.x, b.x);
    const hi = Math.max(a.x, b.x);
    if (x < lo || x > hi) continue;
    const y = hi - lo > 1e-6 ? a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x) : Math.min(a.y, b.y);
    if (y < best) best = y;
  }
  return Number.isFinite(best) ? best : fallback;
}

/**
 * Lay out one shape's icicles: where each hangs, how long and thick it is,
 * which canonical sprite it uses. Seeded from the shape, so every tab hangs
 * the same ice.
 */
function layIcicles(shape, stable) {
  const { bbox, sampler } = shape;
  const count = Math.max(1, Math.round(stable.count));
  const variation = clamp(stable.variation, 0, 1);
  const rng = makeRng(`icicles:${shape.id}:${count}:${variation.toFixed(2)}`);
  const onPath = !shape.closed && sampler.length > 0;
  const span = onPath ? Math.max(bbox.h, bbox.w * 0.3) : bbox.h;

  // A lumpy density along the edge: a few clumps on a low floor. Variation
  // controls how lumpy, so at zero this is an even row again.
  const lumps = [];
  const nLumps = 2 + Math.round(count / 14) + Math.floor(rng() * 2);
  for (let k = 0; k < nLumps; k++) {
    lumps.push({ c: rng(), w: 0.025 + rng() * 0.09, a: 0.5 + rng() });
  }
  const densityAt = (u) => {
    let d = 0;
    for (const l of lumps) d += l.a * Math.exp(-(((u - l.c) / l.w) ** 2));
    return 1 + variation * 2.6 * d;
  };
  const GRID = 256;
  const cdf = new Float32Array(GRID + 1);
  let peak = 0;
  for (let k = 0; k < GRID; k++) {
    const d = densityAt((k + 0.5) / GRID);
    peak = Math.max(peak, d);
    cdf[k + 1] = cdf[k] + d;
  }
  const total = cdf[GRID] || 1;

  const ice = [];
  for (let i = 0; i < count; i++) {
    // Stratified, so clumps fill without every icicle piling into one.
    const target = ((i + 0.5 + (rng() - 0.5) * 0.9 * variation) / count) * total;
    let k = 0;
    while (k < GRID - 1 && cdf[k + 1] < target) k++;
    const seg = cdf[k + 1] - cdf[k] || 1;
    const u = clamp((k + (target - cdf[k]) / seg) / GRID, 0.004, 0.996);
    const crowd = (densityAt(u) - 1) / Math.max(1e-6, peak - 1);

    // Most are stubs; a few, in the thick of the clumps, are long — up to
    // three times the typical length. The sixth power is what keeps the long
    // ones rare: a gentler curve gives a comb of medium spikes instead.
    const r = rng();
    const skew = 0.3 + 0.55 * r + 2.6 * Math.pow(r, 6) * (0.4 + 0.9 * crowd);
    const len = span * lerp(1, skew, variation) * 1.25;
    ice.push({ u, len, variant: Math.floor(rng() * ICICLE_VARIANTS), glint: rng(), drip: rng() });
  }
  ice.sort((a, b) => a.u - b.u);
  let longest = 0;
  for (const it of ice) longest = Math.max(longest, it.len);
  return { ice, onPath, longest };
}

const icicles = {
  id: 'icicles',
  name: 'Icicles',
  category: 'christmas',
  scope: 'shape',
  description:
    'Clear ice hanging from the top edge of the shape or along a traced gutter: clumped, rippled, tapering to a drip, and glinting.',
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
  draw({ g, p, shape, t, state, stable = p }) {
    const { bbox, sampler } = shape;
    if (!(bbox.w > 0) && !(sampler.length > 0)) return;

    // The layout is structural: rebuilt when the shape or a slider moves, from
    // the unmodulated values. Length and width are applied below as a scale,
    // so binding either to something still works without a rebuild.
    const key = `${Math.round(stable.count)}|${Number(stable.variation).toFixed(2)}`;
    if (state.layoutFor !== shape || state.layoutKey !== key) {
      state.layoutFor = shape;
      state.layoutKey = key;
      state.layout = layIcicles(shape, stable);
      state.tips = new Float32Array(state.layout.ice.length * 6);
    }
    const { ice, onPath, longest } = state.layout;
    if (!ice.length) return;
    const sprites = icicleSprites(bakedFor(state), stable.color, stable.tip);

    const lengthScale = Math.max(0, p.length);
    const widthScale = Math.sqrt(Math.max(0.05, p.width));
    // Long icicles take longer to form, so a growing fringe fills in from its
    // stubs rather than every spike extending in lockstep.
    const growFor = (it) => (p.grow > 0
      ? Math.pow(clamp(t / (p.grow * (0.45 + 0.55 * it.len / Math.max(1e-6, longest))), 0, 1), 0.8)
      : 1);

    g.save();
    if (!onPath) g.clip(shape.path);

    // A thin ridge of ice along the edge itself, which the roots grow out of.
    // Without it each icicle is a separate object stuck under the gutter.
    g.strokeStyle = sprites.ridge;
    g.lineWidth = Math.max(2, 2.4 * widthScale);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    if (onPath) {
      const pts = sampler.points;
      g.moveTo(pts[0].x, pts[0].y + 1);
      for (let k = 1; k < pts.length; k++) g.lineTo(pts[k].x, pts[k].y + 1);
    } else {
      for (let k = 0; k <= 24; k++) {
        const x = bbox.x + (bbox.w * k) / 24;
        const y = topEdgeAt(shape.points, x, bbox.y) + 1;
        if (k === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
    }
    g.stroke();

    // Where each drawn icicle ended up, for the light pass: x, root y, length,
    // root half-width, tip offset, and which icicle. Reused, never reallocated.
    const tips = state.tips;
    let drawn = 0;
    for (let i = 0; i < ice.length; i++) {
      const it = ice[i];
      const at = onPath ? sampler.at(it.u) : null;
      const x = onPath ? at.x : bbox.x + it.u * bbox.w;
      const y = onPath ? at.y : topEdgeAt(shape.points, x, bbox.y);
      const grown = growFor(it);
      const len = it.len * lengthScale * grown;
      if (!(len > 1.5)) continue;
      // Root thickness follows length, so long icicles are stout and stubs are
      // stubby — but never fatter than about a fifth of their length, which is
      // the point at which a cone stops being an icicle.
      const half = Math.min((1 + 0.045 * len) * widthScale, 0.8 + len * 0.085) * (0.6 + 0.4 * grown);
      const sprite = sprites.variants[it.variant];
      const sx = half / ICICLE_HALF;
      const sy = len / ICICLE_LEN;
      g.drawImage(sprite.canvas, x - (ICICLE_W / 2) * sx, y - ICICLE_TOP * sy, ICICLE_W * sx, ICICLE_H * sy);
      const o = drawn * 6;
      tips[o] = x;
      tips[o + 1] = y;
      tips[o + 2] = len;
      tips[o + 3] = half;
      tips[o + 4] = sprite.tipX * sx;
      tips[o + 5] = i;
      drawn++;
    }
    // Nothing left over from a frame that drew more, so the buffer is a
    // function of this frame alone.
    tips.fill(0, drawn * 6);

    /**
     * Light on the ice, additive: a drop hanging at each tip, a glint running
     * down the streak now and then, and every so often a drop letting go.
     *
     * All of it a function of show time and the icicle's own seed, so it needs
     * no memory and two tabs agree.
     */
    g.globalCompositeOperation = 'lighter';
    const glint = clamp(p.glint, 0, 1);
    for (let k = 0; k < drawn; k++) {
      const o = k * 6;
      const x = tips[o];
      const rootY = tips[o + 1];
      const len = tips[o + 2];
      const half = tips[o + 3];
      const tx = x + tips[o + 4];
      const ty = rootY + len;
      const it = ice[tips[o + 5]];
      const r = Math.max(1.6, half * 0.42);

      // The pendant drop swells over the drip's period and lets go. It sits
      // on the very end of the ice, which in the sprite is already thin and
      // faint — so it is drawn just above the tip rather than below it, where
      // it would read as a bead floating under the icicle.
      const period = 5 + it.drip * 9;
      const phase = frac(t / period + it.drip * 7.3);
      const swell = phase < 0.86 ? phase / 0.86 : 1;
      g.globalAlpha = 0.4 + 0.35 * swell;
      const d = r * (1.8 + swell * 1.4);
      g.drawImage(sprites.drop, tx - d / 2, ty - d / 2 - r * (0.8 - 0.5 * swell), d, d);

      // Falling: the last stretch of the period, and only from the longer ones
      // — stubs do not run.
      if (phase >= 0.86 && it.len > longest * 0.3) {
        const fall = (phase - 0.86) * period;
        const dy = 0.5 * 980 * fall * fall;
        // Stretched along its fall by its speed: the cheapest honest motion blur.
        const streak = Math.max(d, Math.min(980 * fall * 0.035, 40));
        g.globalAlpha = clamp(0.9 - dy / (len * 4 + 160), 0, 1) * 0.8;
        g.drawImage(sprites.drop, tx - d * 0.35, ty + dy - streak * 0.5, d * 0.7, streak);
      }

      // A glint sliding down the specular streak, now and then.
      if (glint > 0) {
        const rate = 0.09 + it.glint * 0.08;
        const gp = frac(t * rate + it.glint * 3.1);
        if (gp < 0.12) {
          const s = gp / 0.12;
          const flare = Math.sin(s * Math.PI);
          const along = 0.08 + s * 0.74;
          const gx = x + tips[o + 4] * along * along - half * 0.34 * (1 - along);
          const gy = rootY + len * along;
          g.globalAlpha = flare * glint;
          const gd = Math.max(8, half * 4) * (0.6 + flare * 0.6);
          g.drawImage(sprites.drop, gx - gd / 2, gy - gd / 2, gd, gd);
        }
      }
    }
    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * Stars
 *
 * A real sky is a handful of bright stars and a great many faint ones — the
 * count roughly triples with each step fainter — and they are not all the same
 * white: a few are amber, a few blue-white. Each is a point of light with a
 * hot centre and a soft skirt, and only the brightest throw diffraction
 * spikes. The old field was evenly sized white discs, every one of them with a
 * cross through it, which reads as a pattern rather than a sky.
 * ------------------------------------------------------------------ */

/** Colour temperatures the field is tinted towards, coolest star last. */
const STAR_KELVIN = [3300, 4600, 6200, 8500, 12000];

function starSprites(store, colour) {
  const key = `stars|${colour}`;
  let set = store.get(key);
  if (set) return set;
  // Small: no star is drawn much bigger than this, and a smaller source is a
  // cheaper blit for a field of a few hundred of them.
  const S = 40;
  const h = S / 2;
  const glows = STAR_KELVIN.map((k) => {
    const tint = mixLinear(colour, blackbodyCss(k), 0.4);
    const canvas = offscreen(S, S);
    const c = canvas.getContext('2d');
    const grad = c.createRadialGradient(h, h, 0, h, h, h);
    // A flat, hard core — a star is a point, crisp at any brightness — inside
    // a faint halo for the bloom to work on.
    grad.addColorStop(0, rgba(mixLinear(tint, '#ffffff', 0.85), 1));
    grad.addColorStop(0.24, rgba(mixLinear(tint, '#ffffff', 0.6), 1));
    grad.addColorStop(0.32, rgba(tint, 0.5));
    grad.addColorStop(0.45, rgba(tint, 0.12));
    grad.addColorStop(0.72, rgba(tint, 0.03));
    grad.addColorStop(1, rgba(tint, 0));
    c.fillStyle = grad;
    c.fillRect(0, 0, S, S);
    return canvas;
  });

  // Diffraction spikes: two hairlines through the centre, fading out along
  // their length. Baked per pixel so the taper is smooth at any scale.
  const spikes = offscreen(S, S);
  const c = spikes.getContext('2d');
  const image = c.createImageData(S, S);
  const { r, g: gr, b } = hexToRgb(mixLinear(colour, '#ffffff', 0.5));
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x + 0.5 - h) / h;
      const dy = (y + 0.5 - h) / h;
      const arm = (along, across) =>
        Math.exp(-(((across * h) / 0.7) ** 2)) * (1 - Math.min(1, Math.abs(along))) ** 2.2;
      const a = Math.max(arm(dx, dy), arm(dy, dx));
      const o = (y * S + x) * 4;
      image.data[o] = r;
      image.data[o + 1] = gr;
      image.data[o + 2] = b;
      image.data[o + 3] = Math.round(clamp(a, 0, 1) * 255);
    }
  }
  c.putImageData(image, 0, 0);
  set = { glows, spikes, train: rgba(mixLinear(colour, '#cfe0ff', 0.4), 1) };
  store.set(key, set);
  return set;
}

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
  /** Cast on step one, so every tab lays out the same sky. */
  step({ p, rng, state }) {
    const count = Math.round(p.count);
    if (state.count === count) return;
    state.count = count;
    state.stars = Array.from({ length: count }, () => ({
      x: rng(),
      y: rng(),
      // Mostly faint, a few bright: a steep power of a uniform number.
      s: 0.28 + 1.5 * Math.pow(rng(), 4),
      phase: rng() * TAU,
      rate: 0.7 + rng() * 1.1,
      tint: Math.floor(rng() * STAR_KELVIN.length),
    }));
  },
  draw({ g, p, shape, t, state, stable = p }) {
    const { bbox } = shape;
    if (!state.stars) return;
    const sprites = starSprites(bakedFor(state), stable.color);
    const size = Math.max(0.25, p.size);

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';

    for (const star of state.stars) {
      const x = bbox.x + star.x * bbox.w;
      const y = bbox.y + star.y * bbox.h;
      // Scintillation is not a slow breath: two rates beating against each
      // other give the irregular flicker of a star through moving air.
      const sp = t * p.twinkle * star.rate;
      const tw = p.twinkle > 0
        ? (0.55 + 0.45 * (0.5 + 0.5 * Math.sin(sp + star.phase))) * (0.8 + 0.2 * Math.sin(sp * 3.7 + star.phase * 2))
        : 1;
      // Never smaller than a visible point: a faint star is dimmer, not
      // sub-pixel, or the field empties out in all but its brightest few.
      // Magnitude goes mostly into size rather than alpha: added to a wall in
      // linear light, a dim point vanishes, where a small bright one is a star.
      const d = size * (0.45 + 0.9 * star.s) * 2.4 * (0.85 + 0.15 * tw);
      g.globalAlpha = clamp(tw * (0.78 + 0.22 * Math.min(1, star.s)), 0, 1);
      g.drawImage(sprites.glows[star.tint], x - d / 2, y - d / 2, d, d);

      // Only the bright ones throw spikes; on every star they are a pattern.
      if (p.spikes && star.s > 0.62) {
        const sd = d * (1.4 + 2.2 * (star.s - 0.62));
        g.globalAlpha = clamp(tw * 0.75 * (star.s - 0.5), 0, 1);
        g.drawImage(sprites.spikes, x - sd / 2, y - sd / 2, sd, sd);
      }
    }

    if (p.shooting > 0) {
      const interval = 60 / p.shooting;
      const index = Math.floor(t / interval);
      const local = (t % interval) / 1.1;
      if (local >= 0 && local < 1) {
        // Deterministic per shooting-star index, so all projectors agree.
        const sx = ((index * 9301 + 49297) % 233280) / 233280;
        const sy = ((index * 4523 + 12345) % 100000) / 100000;
        const x0 = bbox.x + sx * bbox.w;
        const y0 = bbox.y + sy * bbox.h * 0.5;
        const dx = bbox.w * 0.35;
        const dy = bbox.h * 0.22;
        // Quick in, slow out: a meteor flares and then fades along its track.
        const flare = Math.sin(Math.min(1, local * 1.6) * Math.PI * 0.5) * (1 - local * local);
        const x = x0 + dx * local;
        const y = y0 + dy * local;
        // A tapered train: three passes, each shorter, wider and brighter
        // towards the head, which is how a streak of light fades behind it.
        g.lineCap = 'round';
        g.strokeStyle = sprites.train;
        for (const [reach, width, alpha] of [[0.3, 0.3, 0.25], [0.16, 0.55, 0.45], [0.06, 0.85, 0.8]]) {
          g.globalAlpha = clamp(flare * alpha, 0, 1);
          g.lineWidth = Math.max(0.6, size * width);
          g.beginPath();
          g.moveTo(x - dx * reach, y - dy * reach);
          g.lineTo(x, y);
          g.stroke();
        }
        const hd = size * 4;
        g.globalAlpha = clamp(flare, 0, 1);
        g.drawImage(sprites.glows[3], x - hd / 2, y - hd / 2, hd, hd);
      }
    }
    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * Aurora
 *
 * The northern lights are curtains, and a curtain is made of rays. Each ray is
 * a column of glowing air lined up on the Earth's magnetic field, so from the
 * ground they stand vertical whatever the curtain's lower edge is doing — and
 * that lower edge is the sharpest, brightest part: green, from oxygen about a
 * hundred kilometres up, fading upwards into the red and violet of thinner air
 * at the tops. Where the curtain folds and you see it edge-on, it is brighter,
 * because you are looking through more of it.
 *
 * The old version filled wavy horizontal ribbons with a vertical gradient,
 * edged by forty-segment polylines: faceted, banded, and closer to coloured
 * hills than to anything in the sky. Here one soft ray is baked per colour
 * pair and stamped hundreds of times along each curtain's folding lower edge,
 * each ray's height and brightness taken from noise that drifts along the
 * curtain — which is the slow shimmer that makes an aurora look alive.
 * ------------------------------------------------------------------ */

const RAY_W = 24;
const RAY_H = 256;

/**
 * One ray, bottom of the canvas at the curtain's lower edge.
 *
 * Shaded per pixel, once: soft across (a Gaussian, so neighbouring rays merge
 * into a curtain rather than standing apart as stripes), and along its height
 * a sharp rise at the lower border — whitened a little, it is the brightest
 * thing in the sky — then a long fall, turning from the base colour to the top
 * colour as it goes, with a faint second glow high up where the red lives.
 */
function auroraRay(store, base, top) {
  const key = `ray|${base}|${top}`;
  let canvas = store.get(key);
  if (canvas) return canvas;
  canvas = offscreen(RAY_W, RAY_H);
  const c = canvas.getContext('2d');
  const image = c.createImageData(RAY_W, RAY_H);
  const data = image.data;
  const [br, bg, bb] = linearOf(base);
  const [tr, tg, tb] = linearOf(top);
  for (let y = 0; y < RAY_H; y++) {
    const v = 1 - (y + 0.5) / RAY_H; // 0 at the lower border, 1 at the top
    const rise = clamp(v / 0.05, 0, 1);
    const along = rise * (0.85 * Math.exp(-v * 3.2) + 0.34 * Math.exp(-(((v - 0.6) / 0.24) ** 2)));
    const mix = clamp((v - 0.14) / 0.46, 0, 1);
    const hot = 0.35 * Math.exp(-v / 0.05);
    const lr = lerp(br, tr, mix) + hot;
    const lg = lerp(bg, tg, mix) + hot;
    const lb = lerp(bb, tb, mix) + hot;
    for (let x = 0; x < RAY_W; x++) {
      const h = ((x + 0.5) / RAY_W) * 2 - 1;
      const a = along * Math.exp(-h * h * 3.6);
      const o = (y * RAY_W + x) * 4;
      data[o] = Math.round(linearToSrgb(lr) * 255);
      data[o + 1] = Math.round(linearToSrgb(lg) * 255);
      data[o + 2] = Math.round(linearToSrgb(lb) * 255);
      data[o + 3] = Math.round(clamp(a, 0, 1) * 255);
    }
  }
  c.putImageData(image, 0, 0);
  store.set(key, canvas);
  return canvas;
}

const aurora = {
  id: 'aurora',
  name: 'Aurora',
  category: 'christmas',
  scope: 'shape',
  description:
    'Slow curtains of northern lights: rays standing up from a bright lower edge, green fading to violet. Lovely across a whole wall.',
  params: [
    { key: 'color', type: 'color', label: 'Colour A', default: '#2bff88' },
    { key: 'color2', type: 'color', label: 'Colour B', default: '#7b5cff' },
    { key: 'bands', type: 'range', label: 'Curtains', default: 5, min: 1, max: 14, step: 1 },
    { key: 'speed', type: 'range', label: 'Speed', default: 0.12, min: 0, max: 1.5, step: 0.005 },
    { key: 'amplitude', type: 'range', label: 'Waviness', default: 0.2, min: 0, max: 0.8, step: 0.01 },
    { key: 'thickness', type: 'range', label: 'Thickness', default: 0.22, min: 0.02, max: 1, step: 0.01 },
    { key: 'level', type: 'range', label: 'Brightness', default: 0.7, min: 0, max: 1.5, step: 0.01 },
  ],
  draw({ g, p, shape, t, noise, state, stable = p }) {
    const { bbox } = shape;
    if (!(bbox.w > 0) || !(bbox.h > 0)) return;
    const ray = auroraRay(bakedFor(state), stable.color, stable.color2);

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';
    const level = clamp(p.level, 0, 2);
    const bands = Math.max(1, Math.round(p.bands));
    // About one ray every seventeen pixels, so they overlap into a curtain
    // but the structure still reads from across the road.
    const rays = clamp(Math.round(bbox.w / 17), 12, 128);
    const spacing = bbox.w / rays;
    const tt = t * p.speed;
    const wave = bbox.h * p.amplitude;

    for (let b = 0; b < bands; b++) {
      const f = bands > 1 ? b / (bands - 1) : 0.5;
      // Each curtain hangs across its own stretch of sky, with soft ends, and
      // that stretch wanders slowly.
      const centre = 0.5 + 0.42 * noise.noise2(b * 7.13 + 0.5, tt * 0.12);
      const half = 0.28 + 0.22 * (0.5 + 0.5 * noise.noise2(b * 3.31, 4.2));
      const baseY = bbox.y + bbox.h * (0.36 + 0.34 * f);
      const reach = bbox.h * p.thickness * (1.9 - 0.6 * f);
      // Fainter further back, so the curtains sit at different depths.
      const depth = 1 - 0.35 * f;

      for (let i = 0; i < rays; i++) {
        const u = (i + 0.5) / rays;
        const d = Math.abs(u - centre);
        if (d > half) continue;
        const ends = 1 - clamp((d - half * 0.55) / (half * 0.45), 0, 1);

        // The lower edge folds; where it is steep the curtain is edge-on.
        const k = u * 1.7 + b * 5.3;
        const y0 = baseY + wave * noise.noise2(k, tt);
        const slope = ((noise.noise2(k + 0.02, tt) - noise.noise2(k - 0.02, tt)) / 0.04) * 1.7
          * (wave / Math.max(1, bbox.w));
        const fold = 1 + Math.min(1.6, Math.abs(slope) * 2.2);

        // Ray structure: fine noise drifting along the curtain.
        const s = 0.5 + 0.5 * noise.noise2(u * 26 - tt * 2.2 + b * 11.7, b * 1.9 + tt * 0.5);
        const glow = ends * depth * fold * (0.22 + 0.78 * s * s);
        if (glow <= 0.04) continue;
        const h = reach * (0.55 + 0.75 * s);
        const w = spacing * 2.3;
        g.globalAlpha = clamp(glow * level * 0.62, 0, 1);
        g.drawImage(ray, bbox.x + u * bbox.w - w / 2, y0 - h, w, h * 1.03);
      }
    }
    g.restore();
  },
};

/**
 * The shading of a round pole, as strips laid across the shape's narrow side:
 * [start, end, style], in fractions of the width. Each strip stacks on the
 * ones under it, so the edges darken in steps too fine to see under the
 * stripes, and a highlight sits a third of the way across. Plain fills from
 * constant styles rather than a gradient: nothing to build per frame, and
 * nothing to cache.
 */
const POLE_SHADE = [
  [0, 0.34, 'rgba(10,4,14,0.1)'],
  [0, 0.22, 'rgba(10,4,14,0.12)'],
  [0, 0.13, 'rgba(10,4,14,0.14)'],
  [0, 0.06, 'rgba(10,4,14,0.16)'],
  [0.62, 1, 'rgba(10,4,14,0.1)'],
  [0.76, 1, 'rgba(10,4,14,0.12)'],
  [0.86, 1, 'rgba(10,4,14,0.14)'],
  [0.94, 1, 'rgba(10,4,14,0.18)'],
  [0.27, 0.37, 'rgba(255,255,255,0.08)'],
  [0.3, 0.34, 'rgba(255,255,255,0.1)'],
];

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
  draw({ g, p, shape, t, state, stable = p }) {
    const { bbox } = shape;
    if (bbox.w <= 0 || bbox.h <= 0) return;

    /**
     * A cane is round, and that is most of what makes the stripes read as
     * sugar rather than as tape.
     *
     * Each colour is a lit cylinder in cross-section: darker at both edges,
     * where the surface turns away; a shadowed side and a glossy side; the
     * body at full strength between them. The gloss and shadow are the same
     * outline stroked again, narrower, with the whole path nudged towards or
     * away from a light up and to the left — which puts the highlight on the
     * outer side of the top and left edges and the inner side of the bottom
     * and right ones, exactly where one lamp would put it on a bent tube.
     * Worked out once per colour pair, from `stable`.
     */
    const toneKey = `${stable.color}|${stable.color2}`;
    if (state.toneKey !== toneKey) {
      state.toneKey = toneKey;
      const tube = (c, shadow) => ({
        edge: rgba(mixLinear(c, shadow, 0.55), 1),
        body: rgba(c, 1),
        shade: rgba(mixLinear(c, shadow, 0.3), 1),
        gloss: rgba(mixLinear(c, '#ffffff', 0.62), 1),
      });
      state.tones = [tube(stable.color, '#1a0306'), tube(stable.color2, '#1d2638')];
    }
    const tube = (tone) => {
      const W = p.width;
      g.strokeStyle = tone.edge;
      g.lineWidth = W;
      g.stroke(shape.path);
      g.strokeStyle = tone.body;
      g.lineWidth = W * 0.7;
      g.stroke(shape.path);
      g.save();
      g.translate(W * 0.15, W * 0.15);
      g.strokeStyle = tone.shade;
      g.lineWidth = W * 0.3;
      g.stroke(shape.path);
      g.translate(W * -0.31, W * -0.31);
      g.strokeStyle = tone.gloss;
      g.lineWidth = W * 0.14;
      g.stroke(shape.path);
      g.restore();
    };

    const a = (p.angle * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const diag = Math.hypot(bbox.w, bbox.h) * 1.2;
    const period = diag / Math.max(2, Math.round(p.stripes));
    /**
     * Wrapped over *two* periods, not one.
     *
     * The obvious `frac(t * speed)` slides the bands along by one period and
     * then jumps back — and since a band's colour is its index's parity, and
     * the indices do not shift with it, every stripe swapped red for white at
     * the wrap. On a door at the default speed that is a visible flip roughly
     * every five seconds, which is exactly what a barber's pole must never do.
     *
     * A candy stripe repeats every two periods, so wrapping on two is the
     * period of the actual pattern: band `i` at the end of the cycle lands
     * where band `i + 2` sat at the start, same parity, same colour, no seam.
     * The rate is unchanged — two periods in twice the time.
     */
    const shift = frac(t * p.speed * 0.5) * 2;
    const bands = Math.ceil(diag / period) + 3;

    // Stripe corners are computed in world coordinates rather than by rotating
    // the context, so the same band can clip a stroke of the untransformed path.
    const toWorld = (u, v) => ({
      x: bbox.cx + u * cos - v * sin,
      y: bbox.cy + u * sin + v * cos,
    });

    const band = (i) => {
      const offset = (i + shift) * period;
      const c0 = toWorld(offset - period / 2, -diag);
      const c1 = toWorld(offset + period / 2, -diag);
      const c2 = toWorld(offset + period / 2, diag);
      const c3 = toWorld(offset - period / 2, diag);
      g.moveTo(c0.x, c0.y);
      g.lineTo(c1.x, c1.y);
      g.lineTo(c2.x, c2.y);
      g.lineTo(c3.x, c3.y);
      g.closePath();
    };

    g.save();
    g.lineJoin = 'round';
    g.lineCap = 'round';

    if (p.mode === 'outline') {
      /**
       * Colour B is laid as the whole cane first, then colour A is drawn over
       * it through one clip made of all its bands. Two passes instead of a
       * clip and a stroke per band, and no seam: two anti-aliased clip edges
       * meeting on the same line leave a hairline gap between the stripes,
       * where one drawn over a solid base does not.
       */
      tube(state.tones[1]);
      g.save();
      g.beginPath();
      for (let i = -bands; i <= bands; i++) if ((((i % 2) + 2) % 2) === 0) band(i);
      g.clip();
      tube(state.tones[0]);
      g.restore();
    } else {
      g.clip(shape.path);
      for (let i = -bands; i <= bands; i++) {
        g.beginPath();
        band(i);
        g.fillStyle = (((i % 2) + 2) % 2) === 0 ? p.color : p.color2;
        g.fill();
      }

      // Filled, the shape is the pole: shade across its narrow side, dark at
      // both edges with a highlight a third of the way across.
      const across = bbox.w <= bbox.h;
      for (const [from, to, style] of POLE_SHADE) {
        g.fillStyle = style;
        if (across) g.fillRect(bbox.x + bbox.w * from, bbox.y, bbox.w * (to - from), bbox.h);
        else g.fillRect(bbox.x, bbox.y + bbox.h * from, bbox.w, bbox.h * (to - from));
      }
    }
    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * Window frost
 *
 * Frost on a window pane is fern frost: feathers of ice. Each one is a main
 * stem, nearly straight, with side branches packed close along both sides at
 * about sixty degrees — the angle of the hexagonal lattice, which is why every
 * feather of it looks related — and those branches carry barbs of their own at
 * the same angle. Feathers nucleate where the glass is coldest, along the
 * frame and above all in the corners, and grow inward; now and then a branch
 * outgrows its parent and starts a feather of its own. Under all of it the
 * glass is fogged with a fine rime, densest at the edges and corners.
 *
 * The old version grew a few thick stems per edge with sparse forks, and on a
 * window it read as white worms, or as bare winter trees in silhouette.
 * Everything that says *frost* is in the density and the regularity of the
 * fine branching, and in the haze.
 *
 * That is a growth process, not a texture, so the structure is generated once
 * and each piece remembers how far along the growth it arrived: revealing
 * pieces in that order is the animation, and it creeps the way real frost
 * does, inward from every edge at once rather than fading up uniformly. The
 * reveal is drawn into a cached bitmap incrementally — only the pieces that
 * appeared this frame are stroked, and the rest is one blit — because a pane
 * of fern is several thousand hairlines, which would cost more than the whole
 * rest of the show to stroke every frame.
 * ------------------------------------------------------------------ */

const FROST_MAX_SEGMENTS = 16000;
const FROST_MAX_HAZE = 700;
/** The longest side of the cached bitmap. Finer than this is finer than the wall. */
const FROST_BITMAP = 460;
/** Sixty degrees: the angle every branch of an ice dendrite leaves its parent at. */
const FROST_ANGLE = Math.PI / 3;
/** The `level` that marks a record as a dab of rime rather than a branch. */
const FROST_RIME = 3;

/** The first corner fans and edge seeds: which way is into the pane from here. */
function inwardAngle(shape, at) {
  const { centroid } = shape;
  let normal = at.angle + Math.PI / 2;
  if ((centroid.x - at.x) * Math.cos(normal) + (centroid.y - at.y) * Math.sin(normal) < 0) {
    normal += Math.PI;
  }
  return normal;
}

/**
 * Grow the frost for one pane.
 *
 * Seeded from the shape id rather than the effect's own generator, so two
 * projector tabs covering the same window agree on the pattern no matter when
 * each of them first rendered it. Returns flat typed arrays, sorted by arrival,
 * so the reveal is a cursor walking forward through them.
 */
function buildFrost(shape, fronds, branch, sharpness) {
  const { bbox, sampler, points } = shape;
  const rng = makeRng(`frost:${shape.id}:${Math.round(fronds)}:${branch.toFixed(2)}:${sharpness.toFixed(2)}`);
  const minDim = Math.max(1, Math.min(bbox.w, bbox.h));
  const step = clamp(minDim * 0.015, 1, 7);
  const inside = (x, y) => points.length > 2 && pointInPolygon({ x, y }, points);

  const segs = [];
  const stems = [];
  // A main stem: sets off from (x, y) on `angle`, `len` long, and carries
  // feathers. `depth` 0 is a stem, 1 a side branch, 2 a barb.
  const seed = (x, y, angle, len, depth, dist, width) => {
    stems.push({ x, y, angle, len, depth, dist, width });
  };

  // Seeds along the frame, evenly spread with a jitter so they neither line up
  // nor clump.
  const count = Math.max(3, Math.round(fronds));
  for (let i = 0; i < count; i++) {
    const at = sampler.at((i + rng() * 0.85) / count);
    const angle = inwardAngle(shape, at) + (rng() - 0.5) * 1.1;
    seed(at.x, at.y, angle, minDim * (0.13 + rng() * 0.25), 0, rng() * minDim * 0.04, 1);
  }

  // And fans out of every real corner, where the glass is coldest and frost
  // starts first: three or four feathers splayed across the corner's bisector.
  const n = points.length;
  for (let i = 0; n > 2 && i < n; i++) {
    const a = points[(i + n - 1) % n];
    const b = points[i];
    const c = points[(i + 1) % n];
    const a1 = Math.atan2(b.y - a.y, b.x - a.x);
    const a2 = Math.atan2(c.y - b.y, c.x - b.x);
    let turn = a2 - a1;
    while (turn > Math.PI) turn -= TAU;
    while (turn < -Math.PI) turn += TAU;
    if (Math.abs(turn) < 0.5) continue;
    // Bisector, pointed into the pane.
    let bis = Math.atan2(Math.sin(a1 + Math.PI) + Math.sin(a2), Math.cos(a1 + Math.PI) + Math.cos(a2));
    const toward = Math.atan2(shape.centroid.y - b.y, shape.centroid.x - b.x);
    if (Math.cos(bis - toward) < 0) bis += Math.PI;
    const fan = 3 + Math.floor(rng() * 2);
    for (let k = 0; k < fan; k++) {
      const spread = (k / (fan - 1) - 0.5) * 1.15 + (rng() - 0.5) * 0.2;
      seed(b.x + Math.cos(bis) * 2, b.y + Math.sin(bis) * 2, bis + spread,
        minDim * (0.2 + rng() * 0.24), 0, rng() * minDim * 0.02, 1.1);
    }
  }

  // Grow every stem, breadth first so no one feather can use up the budget.
  //
  // Three orders. A stem throws a side branch every couple of steps; a side
  // branch throws a barb at nearly every step, alternating sides, so its vane
  // reads as a fine fur rather than as a few twigs. That density, at a fixed
  // sixty degrees, is the whole difference between a feather of frost and a
  // bare tree.
  const wobble = (0.16 - 0.13 * sharpness);
  const pitch = [Math.max(1, Math.round(2.6 - 1.2 * branch)), 1];
  const reachOf = [0.4, 0.46];
  const strideOf = [1, 0.8, 0.55];
  const budget = FROST_MAX_SEGMENTS * 7;
  for (let si = 0; si < stems.length && segs.length < budget; si++) {
    const stem = stems[si];
    // Finer orders take shorter steps, so a barb is still a few segments long
    // rather than one straight dash.
    const stride = step * strideOf[stem.depth];
    const steps = Math.max(2, Math.round(stem.len / stride));
    // A constant bend per stem: a dendrite is a family of gentle arcs, and a
    // random walk with the same total deviation reads as a scribble instead.
    const curl = (rng() - 0.5) * 0.05 * (1 - sharpness) / Math.max(1, stem.depth + 1);
    let { x, y, angle, dist } = stem;
    let side = rng() < 0.5 ? -1 : 1;
    for (let s = 0; s < steps && segs.length < budget; s++) {
      const f = s / steps;
      const nx = x + Math.cos(angle) * stride;
      const ny = y + Math.sin(angle) * stride;
      if (!inside(nx, ny)) break;
      // Tapers along its length, and each order is finer than the last.
      const width = stem.width * (1 - 0.6 * f);
      segs.push(x, y, nx, ny, dist, width, stem.depth);
      x = nx;
      y = ny;
      dist += stride;
      angle += curl + (rng() - 0.5) * wobble * 0.5;

      // Side branches at sixty degrees, longest a little way out and
      // shortening to the tip — the outline of a feather.
      if (stem.depth < 2 && s > 0 && s % pitch[stem.depth] === 0 && rng() < 0.55 + 0.4 * branch) {
        const envelope = Math.min(1, f * 4) * Math.pow(1 - f, stem.depth === 0 ? 0.45 : 0.7);
        const len = stem.len * reachOf[stem.depth] * envelope * (0.7 + rng() * 0.6);
        if (len > step * strideOf[stem.depth + 1] * 1.6) {
          // A stem branches on both sides at once; a side branch's barbs
          // alternate, which is what gives the vane its herringbone.
          const both = stem.depth === 0 && rng() < 0.8;
          for (const dir of both ? [side, -side] : [side]) {
            const outgrow = stem.depth === 0 && rng() < 0.015 + 0.04 * branch;
            seed(x, y, angle + dir * (FROST_ANGLE + (rng() - 0.5) * 0.16),
              outgrow ? stem.len * (0.5 + rng() * 0.3) : len,
              outgrow ? 0 : stem.depth + 1,
              dist, outgrow ? stem.width * 0.8 : stem.width * (stem.depth === 0 ? 0.5 : 0.55) * (1 - 0.5 * f));
          }
          side = -side;
        }
      }
    }
  }

  // Rime: a soft fog on the glass, dabbed in where it is coldest — close to
  // the frame, and thickest in the corners where two edges are close at once.
  const haze = [];
  const reach = minDim * 0.24;
  for (let k = 0; k < FROST_MAX_HAZE && points.length > 2; k++) {
    const at = sampler.at(rng());
    const inward = inwardAngle(shape, at);
    const d = reach * rng() * rng() * rng();
    const hx = at.x + Math.cos(inward) * d;
    const hy = at.y + Math.sin(inward) * d;
    if (!inside(hx, hy)) continue;
    const r = minDim * (0.035 + rng() * 0.05) * (1 - 0.3 * d / reach);
    haze.push(hx, hy, r, d / reach);
  }

  /**
   * Everything that grows, in one flat list ordered by when the growth
   * reaches it: the feathers and the rime under them alike.
   *
   * One list and one cursor, not one each. The reveal paints whatever arrived
   * since the last frame, so with two cursors the dabs and the strokes landed
   * in the bitmap interleaved by frame — a different order, and so a
   * different history, in a tab running at a different frame rate. With one,
   * the bitmap is built in the same order however the growth is sliced.
   *
   * Per record: x0, y0, x1, y1, then the width for a branch or the radius for a
   * dab of rime, whose x1, y1 repeat its centre so a sparkle can land on it.
   */
  const segCount = segs.length / 7;
  const dabCount = haze.length / 4;
  let maxDist = 1;
  for (let k = 0; k < segCount; k++) maxDist = Math.max(maxDist, segs[k * 7 + 4]);
  const total = segCount + dabCount;
  const arrival = new Float32Array(total);
  for (let k = 0; k < segCount; k++) arrival[k] = segs[k * 7 + 4] / maxDist;
  // The rime arrives a little ahead of the feathers it sits under.
  for (let k = 0; k < dabCount; k++) arrival[segCount + k] = haze[k * 4 + 3] * 0.7;
  const order = Array.from({ length: total }, (_, k) => k);
  order.sort((a, b) => arrival[a] - arrival[b] || a - b);

  const seg = new Float32Array(total * 6);
  const when = new Float32Array(total);
  const level = new Uint8Array(total);
  for (let k = 0; k < total; k++) {
    const i = order[k];
    const o = k * 6;
    when[k] = arrival[i];
    if (i < segCount) {
      const s = i * 7;
      seg[o] = segs[s];
      seg[o + 1] = segs[s + 1];
      seg[o + 2] = segs[s + 2];
      seg[o + 3] = segs[s + 3];
      seg[o + 4] = segs[s + 5];
      level[k] = segs[s + 6];
    } else {
      const h = (i - segCount) * 4;
      seg[o] = haze[h];
      seg[o + 1] = haze[h + 1];
      seg[o + 2] = haze[h];
      seg[o + 3] = haze[h + 1];
      seg[o + 4] = haze[h + 2];
      level[k] = FROST_RIME;
    }
  }

  return { seg, when, level, count: total };
}


/** Baked once per colour pair: a soft dab of rime, and a star glint. */
function frostSprites(store, colour, tip) {
  const key = `frost|${colour}|${tip}`;
  let set = store.get(key);
  if (!set) {
    const dab = offscreen(64, 64);
    const c = dab.getContext('2d');
    const grad = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, rgba(mixLinear(colour, '#ffffff', 0.4), 1));
    grad.addColorStop(0.35, rgba(colour, 0.55));
    grad.addColorStop(0.7, rgba(colour, 0.16));
    grad.addColorStop(1, rgba(colour, 0));
    c.fillStyle = grad;
    c.fillRect(0, 0, 64, 64);
    set = {
      dab,
      glint: bakeDrop(tip),
      // Each order of branch a step whiter and fainter: the stems carry the
      // colour of the ice, the finest barbs are just sparkle.
      inks: [colour, mixLinear(colour, tip, 0.4), mixLinear(colour, tip, 0.75)].map((ink) => rgba(ink, 1)),
    };
    store.set(key, set);
  }
  return set;
}

/** Stroke weight and strength for each order of branch, as fractions. */
const FROST_WEIGHT = [0.3, 0.2, 0.13];
const FROST_ALPHA = [0.62, 0.56, 0.46];

const frost = {
  id: 'frost',
  name: 'Window Frost',
  category: 'christmas',
  scope: 'shape',
  description:
    'Fern frost: feathers of ice nucleating at the edges and corners of the glass and branching inward over a fog of rime. Grows over time; freeze it part-grown for a cold snap.',
  params: [
    { key: 'color', type: 'color', label: 'Ice', default: '#bfe4ff' },
    { key: 'tip', type: 'color', label: 'Crystal tips', default: '#ffffff' },
    { key: 'coverage', type: 'range', label: 'Coverage', default: 0.85, min: 0, max: 1, step: 0.01 },
    { key: 'grow', type: 'range', label: 'Seconds to grow', default: 14, min: 0, max: 120, step: 0.5 },
    { key: 'fronds', type: 'range', label: 'Fronds', default: 26, min: 4, max: 90, step: 1 },
    { key: 'branch', type: 'range', label: 'Branching', default: 0.6, min: 0, max: 1, step: 0.01 },
    { key: 'sharpness', type: 'range', label: 'Straightness', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'thickness', type: 'range', label: 'Thickness', default: 2.2, min: 0.4, max: 8, step: 0.1 },
    { key: 'bloom', type: 'range', label: 'Haze on the glass', default: 0.35, min: 0, max: 1, step: 0.01 },
    { key: 'sparkle', type: 'range', label: 'Sparkle', default: 0.45, min: 0, max: 1, step: 0.01 },
  ],
  init() {
    return { key: '', drawn: -1, cursor: 0 };
  },
  draw({ g, p, shape, t, state, stable = p }) {
    const { bbox } = shape;
    if (bbox.w <= 1 || bbox.h <= 1) return;

    /**
     * Rebuild only when something structural moves.
     *
     * From `stable`, the unmodulated parameters — binding any of these to an
     * LFO or the microphone would otherwise regenerate thousands of segments
     * and repaint the whole pane every frame. Coverage, haze and sparkle are
     * deliberately absent from the key: those are the ones worth modulating,
     * and they cost nothing because they only change how much of the existing
     * structure is revealed, or how it is lit.
     */
    const key = [
      shape.id,
      Math.round(bbox.w),
      Math.round(bbox.h),
      Math.round(stable.fronds),
      Number(stable.branch).toFixed(2),
      Number(stable.sharpness).toFixed(2),
      stable.color,
      stable.tip,
      Number(stable.thickness).toFixed(2),
    ].join('|');

    if (state.key !== key) {
      state.key = key;
      state.built = buildFrost(shape, stable.fronds, stable.branch, stable.sharpness);
      // A pane on a facade is at most a few hundred pixels of projector; there
      // is no value in a frost bitmap finer than the thing it lands on.
      const scale = Math.min(1.25, FROST_BITMAP / Math.max(bbox.w, bbox.h));
      state.scale = scale;
      state.canvas = offscreen(bbox.w * scale, bbox.h * scale);
      state.ctx = state.canvas.getContext('2d');
      state.drawn = -1;
      state.cursor = 0;
    }

    const target = p.grow > 0
      ? clamp(p.coverage, 0, 1) * clamp(t / p.grow, 0, 1)
      : clamp(p.coverage, 0, 1);

    const built = state.built;
    const sprites = frostSprites(bakedFor(state), stable.color, stable.tip);
    const c = state.ctx;

    if (target < state.drawn) {
      // Thawing. Cheaper to start again than to un-draw, and it only happens
      // while somebody is dragging the slider.
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, state.canvas.width, state.canvas.height);
      state.cursor = 0;
      state.drawn = 0;
    }

    if (target > state.drawn) {
      c.setTransform(state.scale, 0, 0, state.scale, -bbox.x * state.scale, -bbox.y * state.scale);
      c.globalCompositeOperation = 'lighter';
      c.lineCap = 'round';
      const { seg, when, level } = built;
      // Floor at a third of a world pixel: finer than that is not a branch any
      // more, it is the haze, and the haze is drawn separately.
      const weight = Math.max(0.4, stable.thickness);
      while (state.cursor < built.count && when[state.cursor] <= target) {
        const k = state.cursor++;
        const lv = level[k];
        const o = k * 6;
        // The rime arrives just ahead of the feathers over it, so in this
        // order the frost is laid on the fog rather than under it.
        if (lv === FROST_RIME) {
          const r = seg[o + 4];
          c.globalAlpha = 0.05;
          c.drawImage(sprites.dab, seg[o] - r, seg[o + 1] - r, r * 2, r * 2);
          continue;
        }
        c.strokeStyle = sprites.inks[lv];
        c.lineWidth = Math.max(0.35, weight * FROST_WEIGHT[lv] * (0.45 + 0.55 * seg[o + 4]));
        c.globalAlpha = FROST_ALPHA[lv] * (0.55 + 0.45 * seg[o + 4]);
        c.beginPath();
        c.moveTo(seg[o], seg[o + 1]);
        c.lineTo(seg[o + 2], seg[o + 3]);
        c.stroke();
      }
      c.globalAlpha = 1;
      state.drawn = target;
    }

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';

    /**
     * The fog on the glass, from the frame inward.
     *
     * Stroking the outline itself, clipped to the pane, in a few widening
     * passes, is an inner glow: strongest at the frame, falling off inward,
     * and doubled in the corners where two edges overlap — which is exactly
     * where frost fogs a pane first. Its reach grows with the frost.
     */
    if (p.bloom > 0 && target > 0) {
      const reach = Math.min(bbox.w, bbox.h) * (0.08 + 0.32 * target);
      g.strokeStyle = sprites.inks[0];
      g.lineJoin = 'round';
      for (let k = 1; k <= 4; k++) {
        g.globalAlpha = clamp(p.bloom, 0, 1) * 0.11 * target;
        g.lineWidth = reach * (k / 4) * 2;
        g.stroke(shape.path);
      }
    }

    g.globalAlpha = 1;
    g.drawImage(state.canvas, bbox.x, bbox.y, bbox.w, bbox.h);

    // Sparkle rides on top rather than in the cache: it has to move, and there
    // are only ever a handful of points. Which crystal glints is a hash of the
    // sparkle's index and how many times it has cycled — deliberately not
    // `rng()`, which would advance the effect's generator every frame and make
    // two projector tabs disagree about everything downstream of it.
    if (p.sparkle > 0 && state.cursor > 8) {
      const count = Math.round(4 + p.sparkle * 12);
      const { seg } = built;
      for (let i = 0; i < count; i++) {
        const rate = 0.45 + i * 0.09;
        const cycle = Math.floor(t * rate);
        const flare = Math.sin(((t * rate) % 1) * Math.PI);
        if (flare <= 0.02) continue;
        const pick = (Math.imul(cycle + 1, 2246822519) ^ Math.imul(i + 1, 3266489917)) >>> 0;
        const o = (pick % state.cursor) * 6;
        const size = Math.max(6, p.thickness * 4) * (0.5 + flare);
        g.globalAlpha = flare * flare * clamp(p.sparkle, 0, 1);
        g.drawImage(sprites.glint, seg[o + 2] - size / 2, seg[o + 3] - size / 2, size, size);
      }
      g.globalAlpha = 1;
    }

    g.restore();
  },
};

export default [snow, santa, icicles, stars, aurora, candyStripe, frost];
