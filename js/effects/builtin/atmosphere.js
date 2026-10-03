/**
 * Weather, light and depth.
 *
 * These lean on the post-processing stage rather than fighting it: they draw
 * relatively dim, and let bloom do the glowing. That is the main difference
 * between an effect that reads as "a bright shape" and one that reads as light
 * falling on brickwork.
 *
 * Rain, searchlights and projected caustics all give a facade a sense of
 * weather and depth that flat colour never will.
 */

import { rgba, clamp, TAU, frac, mixHex, hexToRgb } from '../../core/math.js';
import { offscreen, glow } from '../lib.js';
import { blackbodyCss, mixLinear } from '../color.js';
import { ensureField } from '../field.js';

const rain = {
  id: 'rain',
  name: 'Rain',
  category: 'atmosphere',
  scope: 'shape',
  description:
    'Falling rain with depth, wind and optional splashes where it lands. Leave targets empty to cover the house.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#bcd6ff' },
    { key: 'count', type: 'range', label: 'Drops', default: 450, min: 20, max: 3000, step: 10 },
    { key: 'speed', type: 'range', label: 'Fall speed', default: 900, min: 100, max: 3000, step: 10 },
    { key: 'angle', type: 'range', label: 'Angle', default: 12, min: -60, max: 60, step: 1 },
    { key: 'length', type: 'range', label: 'Streak length', default: 42, min: 4, max: 200, step: 1 },
    { key: 'width', type: 'range', label: 'Thickness', default: 1.6, min: 0.3, max: 8, step: 0.1 },
    { key: 'depth', type: 'range', label: 'Depth spread', default: 0.7, min: 0, max: 1, step: 0.01 },
    { key: 'opacity', type: 'range', label: 'Opacity', default: 0.5, min: 0.02, max: 1, step: 0.01 },
    { key: 'splash', type: 'range', label: 'Splashes', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'gust', type: 'range', label: 'Gustiness', default: 0.4, min: 0, max: 2, step: 0.05 },
  ],
  init() {
    return { drops: [], count: 0, splashes: [] };
  },
  step({ p, shape, t, dt, rng, state, noise }) {
    const { bbox } = shape;
    if (bbox.w <= 0 || bbox.h <= 0) return;

    const target = Math.round(p.count);
    const angle = (p.angle * Math.PI) / 180;
    const dirX = Math.sin(angle);
    const dirY = Math.cos(angle);

    const spawn = (drop = {}, atTop = true) => {
      // Spawn wider than the shape so wind-blown rain enters from the side.
      drop.x = bbox.x + (rng() * 1.6 - 0.3) * bbox.w;
      drop.y = atTop ? bbox.y - rng() * bbox.h * 0.2 : bbox.y + rng() * bbox.h;
      drop.z = 1 - p.depth * rng();
      return drop;
    };

    while (state.drops.length < target) state.drops.push(spawn({}, false));
    if (state.drops.length > target) state.drops.length = target;

    const gust = p.gust > 0 ? noise.noise2(t * 0.3, 0) * p.gust : 0;

    for (const drop of state.drops) {
      const z = drop.z;
      const fall = p.speed * z * dt;
      drop.x += (dirX * fall) + gust * 120 * z * dt;
      drop.y += dirY * fall;

      if (drop.y > bbox.y + bbox.h) {
        if (p.splash > 0 && rng() < p.splash * 0.5) {
          state.splashes.push({ x: drop.x, y: bbox.y + bbox.h, age: 0, z });
        }
        spawn(drop, true);
      } else if (drop.x < bbox.x - bbox.w * 0.35 || drop.x > bbox.x + bbox.w * 1.35) {
        spawn(drop, true);
      }
    }

    // Splashes are aged out even when the control is turned down to zero.
    // Skipping the whole block on `p.splash > 0` — as this used to — left up to
    // four hundred of them frozen in the array for the life of the layer, walked
    // by nothing and freed by nothing.
    if (!(p.splash > 0)) {
      state.splashes.length = 0;
    } else {
      for (let i = state.splashes.length - 1; i >= 0; i--) {
        const s = state.splashes[i];
        s.age += dt;
        if (s.age > 0.35) state.splashes.splice(i, 1);
      }
      // Runaway guard if the splash rate ever outpaces the lifetime.
      if (state.splashes.length > 400) state.splashes.length = 400;
    }
  },
  draw({ g, p, shape, state }) {
    const { bbox } = shape;
    if (bbox.w <= 0 || bbox.h <= 0) return;

    const angle = (p.angle * Math.PI) / 180;
    const dirX = Math.sin(angle);
    const dirY = Math.cos(angle);

    g.save();
    g.clip(shape.path);
    g.lineCap = 'round';

    /**
     * One gradient for the whole shower, not one per drop.
     *
     * Every streak is the same fade along the same direction — only its
     * position, length and brightness differ — so the gradient can be built
     * once at the origin and each drop drawn through a translate and a scale.
     * Depth then rides on the transform (length and thickness) and on
     * `globalAlpha` (brightness), which is what it meant anyway.
     *
     * At the default four hundred and fifty drops the old version allocated
     * four hundred and fifty `CanvasGradient` objects sixty times a second —
     * twenty-seven thousand a second, thrown away immediately. Rain was the
     * most expensive effect in the library and this was most of the reason.
     */
    const unit = p.length;
    const streak = g.createLinearGradient(0, 0, -dirX * unit, -dirY * unit);
    streak.addColorStop(0, rgba(p.color, 1));
    streak.addColorStop(1, rgba(p.color, 0));

    for (const drop of state.drops) {
      const z = drop.z;
      // Nearer drops are longer, thicker and brighter — the whole illusion of
      // depth in a rain effect comes from covarying those three.
      g.save();
      g.translate(drop.x, drop.y);
      g.scale(z, z);
      g.globalAlpha = p.opacity * z;
      g.strokeStyle = streak;
      g.lineWidth = Math.max(0.3 / z, p.width);
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(-dirX * unit, -dirY * unit);
      g.stroke();
      g.restore();
    }
    g.globalAlpha = 1;

    if (p.splash > 0 && state.splashes.length) {
      g.globalCompositeOperation = 'lighter';
      for (const s of state.splashes) {
        const f = s.age / 0.35;
        const r = p.length * 0.35 * s.z * (0.3 + f);
        g.globalAlpha = (1 - f) * p.opacity * p.splash;
        g.strokeStyle = p.color;
        g.lineWidth = Math.max(0.3, p.width * s.z * 0.7);
        g.beginPath();
        g.ellipse(s.x, s.y, r, r * 0.35, 0, Math.PI, TAU);
        g.stroke();
      }
    }
    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * Searchlight
 * ------------------------------------------------------------------ */

/**
 * The cones are drawn into a buffer a quarter of the size and blown up once.
 *
 * A beam in haze has no edge and no detail — it is scattered light, the
 * softest thing in the picture — so drawing it at full resolution spends the
 * budget on pixels nobody can see. One accumulator holds every cone; one
 * scratch builds each cone before it is added, because a cone is two
 * gradients multiplied together and the second one, applied with
 * `destination-in`, would cut into any cone already there. Both are
 * overwritten whole each time, so they carry nothing between frames.
 */
const BEAM_RESOLUTION = 0.25;
const BEAM_BUFFER_MAX = 720;
let beamSum = null;
let beamOne = null;

/** A buffer of at least `w × h`, grown rather than replaced, cleared over that much of it. */
function beamScratch(canvas, w, h) {
  const out = canvas || offscreen(w, h);
  if (out.width < w || out.height < h) {
    out.width = Math.max(out.width, w);
    out.height = Math.max(out.height, h);
  }
  const b = out.getContext('2d');
  b.setTransform(1, 0, 0, 1, 0, 0);
  b.globalAlpha = 1;
  b.globalCompositeOperation = 'copy';
  b.fillStyle = 'rgba(0,0,0,0)';
  b.fillRect(0, 0, w, h);
  b.globalCompositeOperation = 'source-over';
  return out;
}

/**
 * How far a ray from (ox, oy) heading (dx, dy) runs before it leaves `bbox`,
 * or 0 if it never enters it.
 */
function rayExit(ox, oy, dx, dy, bbox) {
  let near = 0;
  let far = Infinity;
  if (Math.abs(dx) < 1e-9) {
    if (ox < bbox.x || ox > bbox.x + bbox.w) return 0;
  } else {
    const a = (bbox.x - ox) / dx;
    const b = (bbox.x + bbox.w - ox) / dx;
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
  }
  if (Math.abs(dy) < 1e-9) {
    if (oy < bbox.y || oy > bbox.y + bbox.h) return 0;
  } else {
    const a = (bbox.y - oy) / dy;
    const b = (bbox.y + bbox.h - oy) / dy;
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
  }
  return far > near ? far : 0;
}

const searchlight = {
  id: 'searchlight',
  name: 'Searchlight',
  category: 'atmosphere',
  scope: 'shape',
  description:
    'A sweeping beam with a soft visible cone through the haze and a hot spot where it lands. Reads as a real light source raking across the front of the house.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#dbe9ff' },
    { key: 'beams', type: 'range', label: 'Beams', default: 1, min: 1, max: 6, step: 1 },
    { key: 'spread', type: 'range', label: 'Beam width', default: 14, min: 1, max: 90, step: 0.5 },
    { key: 'speed', type: 'range', label: 'Sweep speed', default: 0.12, min: -1.5, max: 1.5, step: 0.005 },
    { key: 'arc', type: 'range', label: 'Sweep arc', default: 70, min: 5, max: 360, step: 1 },
    { key: 'originX', type: 'range', label: 'Origin X', default: 0.5, min: -0.5, max: 1.5, step: 0.005 },
    { key: 'originY', type: 'range', label: 'Origin Y', default: 1.15, min: -0.5, max: 2, step: 0.005 },
    { key: 'aim', type: 'range', label: 'Aim', default: -90, min: -180, max: 180, step: 1 },
    /**
     * Where the beam meets the wall, as a fraction of the way across the
     * shape along the beam.
     *
     * A searchlight on the ground in front of a house throws its cone up
     * through the air and stops dead on the brickwork, and in the picture the
     * cone runs from the lamp to a bright footprint and no further. Where that
     * footprint falls is a composition decision with no right answer — the
     * middle of the wall, the roofline, past the top into the sky, which is
     * the premiere-night look and has no spot at all — so it is a slider.
     */
    { key: 'throw', type: 'range', label: 'Lands at', default: 0.62, min: 0.1, max: 1.3, step: 0.01 },
    { key: 'intensity', type: 'range', label: 'Intensity', default: 0.55, min: 0, max: 2, step: 0.01 },
    { key: 'haze', type: 'range', label: 'Haze', default: 0.4, min: 0, max: 1, step: 0.01 },
    { key: 'flicker', type: 'range', label: 'Flicker', default: 0.08, min: 0, max: 1, step: 0.01 },
  ],
  draw({ g, p, shape, t, noise, world }) {
    const { bbox } = shape;
    if (bbox.w <= 2 || bbox.h <= 2 || p.intensity <= 0) return;
    const ox = bbox.x + p.originX * bbox.w;
    const oy = bbox.y + p.originY * bbox.h;
    const half = Math.max(0.004, (p.spread * Math.PI) / 360);
    const arc = (p.arc * Math.PI) / 180;
    const aim = (p.aim * Math.PI) / 180;
    const beams = Math.round(p.beams);

    // Only the part of the shape a projector can show is worth a buffer.
    const left = Math.max(bbox.x, -world.w * 0.1);
    const right = Math.min(bbox.x + bbox.w, world.w * 1.1);
    const high = Math.max(bbox.y, -world.h * 0.1);
    const low = Math.min(bbox.y + bbox.h, world.h * 1.1);
    if (right - left < 2 || low - high < 2) return;
    const res = Math.min(BEAM_RESOLUTION, BEAM_BUFFER_MAX / (right - left), BEAM_BUFFER_MAX / (low - high));
    const bw = Math.ceil((right - left) * res) + 2;
    const bh = Math.ceil((low - high) * res) + 2;
    beamSum = beamScratch(beamSum, bw, bh);
    beamOne = beamScratch(beamOne, bw, bh);
    const sum = beamSum.getContext('2d');
    const one = beamOne.getContext('2d');
    const hot = mixHex(p.color, '#ffffff', 0.65);

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';

    // The part of the buffer the cones actually reach, so only that is blown
    // up: a single narrow beam is a sliver of the frame, and the blit is most
    // of what the effect costs.
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;

    for (let b = 0; b < beams; b++) {
      /**
       * The sweep, eased at the ends.
       *
       * A triangle wave reverses instantly, which no motor-driven lamp on a
       * pedestal does; it slows into the end of its travel and comes away
       * again. A sine has the same period and the same arc and does that.
       */
      const phase = t * p.speed + b / Math.max(1, beams);
      const centre = aim + Math.sin(phase * TAU) * arc * 0.5;
      const wobble = p.flicker > 0 ? 1 - p.flicker * Math.abs(noise.noise2(t * 6 + b * 10, 0)) : 1;
      const level = clamp(p.intensity * wobble, 0, 3);
      if (level <= 0.002) continue;

      const dx = Math.cos(centre);
      const dy = Math.sin(centre);
      // Where it lands: along the beam, the given fraction of the way to
      // where the beam would leave the shape.
      const exit = rayExit(ox, oy, dx, dy, bbox);
      const reach = exit > 0 ? exit * p.throw : Math.hypot(bbox.w, bbox.h) * p.throw;
      const lands = p.throw <= 1 && exit > 0;
      if (reach <= 1) continue;

      /**
       * The cone: light scattered out of the beam by the air, so it is a
       * Gaussian across the beam — a conic gradient about the lamp, which is
       * exactly a profile in angle — times a falloff with distance. Near the
       * lamp the same light is squeezed into a narrow beam and the haze in it
       * is brightest; further out it is spread across a wider one, so the
       * cone dims as it goes, and it stops dead at the wall.
       */
      if (p.haze > 0) {
        /**
         * The cone's own corner of the buffer: the lamp and the three far
         * points of the fan bound it, and every operation below — the clear,
         * the multiply, the add — is confined to it, so a narrow beam costs a
         * sliver of the buffer rather than all of it.
         */
        const span = half * 1.9;
        const far = reach * 1.02;
        let cx0 = ox;
        let cx1 = ox;
        let cy0 = oy;
        let cy1 = oy;
        for (let k = -1; k <= 1; k++) {
          const fx = ox + Math.cos(centre + k * span) * far;
          const fy = oy + Math.sin(centre + k * span) * far;
          cx0 = Math.min(cx0, fx);
          cx1 = Math.max(cx1, fx);
          cy0 = Math.min(cy0, fy);
          cy1 = Math.max(cy1, fy);
        }
        const bx0 = clamp(Math.floor((cx0 - left) * res), 0, bw);
        const by0 = clamp(Math.floor((cy0 - high) * res), 0, bh);
        const bx1 = clamp(Math.ceil((cx1 - left) * res) + 3, 0, bw);
        const by1 = clamp(Math.ceil((cy1 - high) * res) + 3, 0, bh);
        if (bx1 > bx0 && by1 > by0) {
          one.setTransform(1, 0, 0, 1, 0, 0);
          one.globalCompositeOperation = 'copy';
          one.globalAlpha = 1;
          one.fillStyle = 'rgba(0,0,0,0)';
          one.fillRect(bx0, by0, bx1 - bx0, by1 - by0);
          one.setTransform(res, 0, 0, res, 1 - left * res, 1 - high * res);
          one.globalCompositeOperation = 'source-over';
          const cone = typeof one.createConicGradient === 'function'
            ? one.createConicGradient(centre - span, ox, oy)
            : null;
          const strength = clamp(level * (0.6 + 1.2 * p.haze), 0, 1);
          if (cone) {
            // Nine stops across the cone, a Gaussian in angle that is under a
            // third of its peak at the stated beam width and nothing at the
            // edge of the fan.
            for (let k = 0; k <= 8; k++) {
              const a = (k / 8) * 2 - 1;
              cone.addColorStop(((a + 1) * span) / TAU, rgba(p.color, strength * Math.exp(-1.25 * (a * 1.9) ** 2)));
            }
            cone.addColorStop(Math.min(1, (2 * span) / TAU + 1e-4), rgba(p.color, 0));
            one.fillStyle = cone;
          } else {
            one.fillStyle = rgba(p.color, strength * 0.5);
          }
          one.beginPath();
          one.moveTo(ox, oy);
          one.arc(ox, oy, far, centre - span, centre + span);
          one.closePath();
          one.fill();

          const fall = one.createRadialGradient(ox, oy, 0, ox, oy, far);
          fall.addColorStop(0, 'rgba(255,255,255,0)');
          fall.addColorStop(0.03, 'rgba(255,255,255,1)');
          fall.addColorStop(0.25, 'rgba(255,255,255,0.75)');
          fall.addColorStop(0.55, 'rgba(255,255,255,0.52)');
          fall.addColorStop(0.92, 'rgba(255,255,255,0.4)');
          fall.addColorStop(1, `rgba(255,255,255,${lands ? 0 : 0.25})`);
          one.globalCompositeOperation = 'destination-in';
          one.fillStyle = fall;
          // Over the cone's corner only, in the world coordinates the
          // gradient is in.
          one.fillRect(left + (bx0 - 1) / res, high + (by0 - 1) / res, (bx1 - bx0) / res, (by1 - by0) / res);

          sum.globalCompositeOperation = 'lighter';
          sum.drawImage(beamOne, bx0, by0, bx1 - bx0, by1 - by0, bx0, by0, bx1 - bx0, by1 - by0);
          x0 = Math.min(x0, cx0);
          x1 = Math.max(x1, cx1);
          y0 = Math.min(y0, cy0);
          y1 = Math.max(y1, cy1);
        }
      }

      /**
       * The footprint, where the beam meets the brickwork.
       *
       * The brightest thing a searchlight makes: the same light the haze only
       * scatters a little of, all of it, on a surface facing it. The beam
       * arrives slanting, so its circle is drawn out into an ellipse along the
       * direction it came from, with a hot white middle and a soft edge that
       * is the beam's own Gaussian, not a rim.
       */
      if (lands) {
        const across = Math.max(4, reach * Math.tan(half) * 1.3);
        const along = across * 1.45;
        const sx = ox + dx * reach;
        const sy = oy + dy * reach;
        // The same light over a bigger footprint is dimmer: a wide beam lands
        // as a broad glow, a narrow one as a hot spot.
        const focus = clamp((0.12 / Math.max(0.02, Math.tan(half))) ** 0.6, 0.35, 1.2);
        const spot = g.createRadialGradient(0, 0, 0, 0, 0, across);
        spot.addColorStop(0, rgba(hot, clamp(level * 1.1 * focus, 0, 1)));
        spot.addColorStop(0.18, rgba(hot, clamp(level * 0.85 * focus, 0, 1)));
        spot.addColorStop(0.5, rgba(p.color, clamp(level * 0.36 * focus, 0, 1)));
        spot.addColorStop(0.8, rgba(p.color, clamp(level * 0.08 * focus, 0, 1)));
        spot.addColorStop(1, rgba(p.color, 0));
        g.save();
        g.translate(sx, sy);
        g.rotate(centre);
        g.scale(along / across, 1);
        g.fillStyle = spot;
        g.beginPath();
        g.arc(0, 0, across, 0, TAU);
        g.fill();
        g.restore();
      }

      // The lamp itself, if it happens to be inside the shape.
      glow(g, ox, oy, Math.min(bbox.w, bbox.h) * 0.12, hot, clamp(level, 0, 1));
    }

    if (x1 > x0 && y1 > y0) {
      // In buffer pixels, a pixel of margin, clamped to the buffer.
      const bx0 = clamp(Math.floor((x0 - left) * res), 0, bw);
      const by0 = clamp(Math.floor((y0 - high) * res), 0, bh);
      const bx1 = clamp(Math.ceil((x1 - left) * res) + 2, 0, bw);
      const by1 = clamp(Math.ceil((y1 - high) * res) + 2, 0, bh);
      if (bx1 > bx0 && by1 > by0) {
        g.drawImage(beamSum, bx0, by0, bx1 - bx0, by1 - by0,
          left - 1 / res + bx0 / res, high - 1 / res + by0 / res, (bx1 - bx0) / res, (by1 - by0) / res);
      }
    }
    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * Water caustics
 * ------------------------------------------------------------------ */

/**
 * What a caustic actually is, and how this one is made.
 *
 * Sunlight through a wavy surface is refracted by every bump in it, and each
 * convex patch of water is a weak lens. Where those lenses bring the light to
 * a focus on the floor — or on a wall — there is a *fold*: a curve along which
 * the light piles up, very bright on the line and dark immediately beside it.
 * Neighbouring lenses make neighbouring folds, so what lands on the wall is a
 * web of bright filaments round dim, rounded cells. The filaments are wavy,
 * never straight; they are thin and faint where the focus is poor and thick
 * and hot where two of them converge, with a near-white knot where three
 * meet; and some cells hold a soft pool of light of their own, where a broad
 * lens has gathered the light without quite focusing it. The whole web crawls
 * and re-forms as the surface moves. That is the thing everybody recognises
 * from the bottom of a swimming pool.
 *
 * The old version evaluated ridged noise on a sixty-four-cell grid and
 * stretched it over the wall: soft cyan noodles that never closed into cells,
 * blurred by a twenty-fold magnification into something nearer smoke than
 * light. The shape was wrong, and the resolution threw away the one property
 * — sharpness — that makes a caustic a caustic.
 *
 * Now the web is a cellular field, computed per texel into a small tile that
 * wraps at its edges: the distance to the nearest of a lattice of wandering
 * points minus the distance to the second nearest (F2 − F1) is zero exactly on
 * the boundaries between their territories, so a sharp falloff on it draws a
 * web of filaments, and F3 − F1 is zero where three territories meet, which is
 * where the knots go. Two things make it light through water rather than
 * cracked mud. The domain is warped by smooth waves before the lookup, which
 * bends every boundary into a curve and rounds every cell; and the falloff's
 * width and brightness each wander on a noise of their own, so a filament
 * thins to a thread in one place and swells and burns in another.
 *
 * The tile is drawn at a few dozen moments round a loop, each the first time
 * it is needed and never again. Each frame cross-fades the two nearest
 * moments and stamps the result over the shape: two layers of it, at
 * different scales and drifting apart, because the light under real water is
 * two webs — the swell makes the big cells and the chop on it a finer, fainter
 * mesh — and because two tiles that repeat at sizes which never line up hide
 * each other's repetition. Two stamps of a small tile a frame is about what
 * the old version's one blit cost.
 */

/** Cells across one tile, and moments round the loop. */
const TILE_CELLS = 4;
const CAUSTIC_FRAMES = 24;
const SITES = TILE_CELLS * TILE_CELLS;

/** A stable 0..1 for lattice site `s`, so a point keeps its character all the way round the loop. */
function siteHash(s, salt) {
  let h = Math.imul(s + 1, 374761393) ^ Math.imul(salt, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * The smooth waves the tile is built from, as `[a, b, q, c]`: `a` and `b`
 * whole cycles across the tile in each direction, `q` whole turns round the
 * loop, `c` a phase. Whole numbers are what make the tile wrap and the loop
 * close. The first three bend the domain sideways, the next three up and
 * down, then two that set how wide the filaments are and two how bright.
 */
const CAUSTIC_WAVES = [
  [1, 2, 1, 0.3], [3, -1, -1, 1.7], [2, 3, 2, 4.1],
  [2, -1, -1, 2.2], [-1, 3, 1, 0.9], [3, 2, -2, 5.3],
  [2, 1, 1, 0.5], [-1, 3, -1, 2.6],
  [1, -2, -1, 1.1], [3, 1, 1, 3.7],
];
const WAVE_COUNT = CAUSTIC_WAVES.length;

/** `exp(−x)` for `x` in 0..16, from a table: the bake asks for three of them per texel. */
const FALLOFF_STEPS = 64;
const FALLOFF = new Float32Array(FALLOFF_STEPS * 16 + 2);
for (let i = 0; i < FALLOFF.length; i++) FALLOFF[i] = Math.exp(-i / FALLOFF_STEPS);
const falloff = (x) => (x >= 16 ? 0 : FALLOFF[(x * FALLOFF_STEPS) | 0]);

/** Scratch for one bake: the points, the candidates per cell and the wave tables. */
const siteX = new Float64Array(SITES);
const siteY = new Float64Array(SITES);
const sitePool = new Float64Array(SITES);
const NEAR = TILE_CELLS + 2;
const nearX = new Float64Array(NEAR * NEAR * 9);
const nearY = new Float64Array(NEAR * NEAR * 9);
const nearSite = new Int32Array(NEAR * NEAR * 9);
let waveSize = 0;
let colSin = null;
let colCos = null;
let rowSin = null;
let rowCos = null;

/**
 * Bake the web at `phase` (0..1 round the loop) into `out`, an RGBA tile
 * `size` texels square that wraps at its edges.
 *
 * The lattice is periodic — the site in cell (i, j) is the site in cell
 * (i mod 4, j mod 4), moved by a whole tile — and every point goes once round
 * its own small loop as the phase goes from 0 to 1, which is what closes the
 * animation. Each wave term is split into a part that depends only on the
 * column and a part that depends only on the row, so a texel costs a few
 * multiplies instead of ten sines.
 */
function bakeCausticTile(out, size, phase, sharpness, rgb, hot) {
  const cell = size / TILE_CELLS;
  const turn = phase * TAU;
  for (let s = 0; s < SITES; s++) {
    const i = s % TILE_CELLS;
    const j = (s / TILE_CELLS) | 0;
    const dir = siteHash(s, 7) < 0.5 ? -1 : 1;
    siteX[s] = (i + 0.5 + (siteHash(s, 1) - 0.5) * 0.5 + Math.sin(turn * dir + siteHash(s, 5) * TAU) * 0.13) * cell;
    siteY[s] = (j + 0.5 + (siteHash(s, 2) - 0.5) * 0.5 + Math.cos(turn * dir + siteHash(s, 6) * TAU) * 0.13) * cell;
    // About half the cells hold a pool of light, breathing round the loop.
    const p = siteHash(s, 9);
    sitePool[s] = p > 0.45 ? ((p - 0.45) / 0.55) * (0.75 + 0.25 * Math.sin(turn + siteHash(s, 10) * TAU)) : 0;
  }
  // The nine candidate points for every cell a warped texel can land in.
  for (let cy = -1; cy < NEAR - 1; cy++) {
    for (let cx = -1; cx < NEAR - 1; cx++) {
      let n = ((cy + 1) * NEAR + (cx + 1)) * 9;
      for (let dj = -1; dj <= 1; dj++) {
        const wrapY = Math.floor((cy + dj) / TILE_CELLS);
        const sj = cy + dj - wrapY * TILE_CELLS;
        for (let di = -1; di <= 1; di++) {
          const wrapX = Math.floor((cx + di) / TILE_CELLS);
          const s = sj * TILE_CELLS + (cx + di - wrapX * TILE_CELLS);
          nearX[n] = siteX[s] + wrapX * size;
          nearY[n] = siteY[s] + wrapY * size;
          nearSite[n] = s;
          n++;
        }
      }
    }
  }
  if (waveSize !== size) {
    waveSize = size;
    colSin = new Float64Array(WAVE_COUNT * size);
    colCos = new Float64Array(WAVE_COUNT * size);
    rowSin = new Float64Array(WAVE_COUNT * size);
    rowCos = new Float64Array(WAVE_COUNT * size);
  }
  for (let k = 0; k < WAVE_COUNT; k++) {
    const [a, b, q, c] = CAUSTIC_WAVES[k];
    for (let x = 0; x < size; x++) {
      const u = ((x + 0.5) / size) * TAU;
      colSin[k * size + x] = Math.sin(u * a);
      colCos[k * size + x] = Math.cos(u * a);
      rowSin[k * size + x] = Math.sin(u * b + q * turn + c);
      rowCos[k * size + x] = Math.cos(u * b + q * turn + c);
    }
  }

  const bend = cell * 0.09;
  // Sharpness narrows the filaments.
  const width = cell * 0.05 * Math.pow(3.5 / clamp(sharpness, 1, 10), 0.6);
  const nearScale = 1 / (cell * 0.18);
  const poolScale = 1 / (cell * 0.5);
  for (let y = 0; y < size; y++) {
    // The row halves of the ten terms, hoisted out of the inner loop.
    const c0 = rowCos[y], s0 = rowSin[y], c1 = rowCos[size + y], s1w = rowSin[size + y];
    const c2 = rowCos[2 * size + y], s2 = rowSin[2 * size + y], c3 = rowCos[3 * size + y], s3 = rowSin[3 * size + y];
    const c4 = rowCos[4 * size + y], s4 = rowSin[4 * size + y], c5 = rowCos[5 * size + y], s5 = rowSin[5 * size + y];
    const c6 = rowCos[6 * size + y], s6 = rowSin[6 * size + y], c7 = rowCos[7 * size + y], s7 = rowSin[7 * size + y];
    const c8 = rowCos[8 * size + y], s8 = rowSin[8 * size + y], c9 = rowCos[9 * size + y], s9 = rowSin[9 * size + y];
    for (let x = 0; x < size; x++) {
      // sin(u + v) = sin u cos v + cos u sin v, for each of the ten waves.
      const px = x + 0.5 + bend * (colSin[x] * c0 + colCos[x] * s0
        + colSin[size + x] * c1 + colCos[size + x] * s1w
        + colSin[2 * size + x] * c2 + colCos[2 * size + x] * s2);
      const py = y + 0.5 + bend * (colSin[3 * size + x] * c3 + colCos[3 * size + x] * s3
        + colSin[4 * size + x] * c4 + colCos[4 * size + x] * s4
        + colSin[5 * size + x] * c5 + colCos[5 * size + x] * s5);
      const thick = 0.5 + 0.25 * (colSin[6 * size + x] * c6 + colCos[6 * size + x] * s6
        + colSin[7 * size + x] * c7 + colCos[7 * size + x] * s7);
      const bright = 0.5 + 0.25 * (colSin[8 * size + x] * c8 + colCos[8 * size + x] * s8
        + colSin[9 * size + x] * c9 + colCos[9 * size + x] * s9);
      const cx = clamp(Math.floor(px / cell), -1, NEAR - 2);
      const cy = clamp(Math.floor(py / cell), -1, NEAR - 2);
      const base = ((cy + 1) * NEAR + (cx + 1)) * 9;
      let d1 = Infinity;
      let d2 = Infinity;
      let d3 = Infinity;
      let s1 = 0;
      for (let n = base; n < base + 9; n++) {
        const dx = px - nearX[n];
        const dy = py - nearY[n];
        const d = dx * dx + dy * dy;
        if (d < d1) { d3 = d2; d2 = d1; d1 = d; s1 = nearSite[n]; } else if (d < d2) { d3 = d2; d2 = d; } else if (d < d3) d3 = d;
      }
      const f1 = Math.sqrt(d1);
      const gap = Math.sqrt(d3) - f1;
      // How close this is to a junction, where filaments converge and swell.
      const near = falloff(gap * nearScale);
      // Never much under a texel: thinner than that and a filament breaks into dots.
      const w = Math.max(1.1, width * (0.4 + 1.2 * thick) * (1 + 1.4 * near));
      const e = (Math.sqrt(d2) - f1) / w;
      const k = gap / (w * 1.5);
      const r = f1 * poolScale;
      const light = falloff(e * e) * (0.3 + bright) * (1 + 0.7 * near)
        + falloff(k * k) * 0.8
        + sitePool[s1] * falloff(r * r) * 0.3;
      // Past full alpha the extra light goes into whiteness: the hottest knots burn white.
      const white = clamp((light - 0.75) / 0.85, 0, 1);
      const o = (y * size + x) * 4;
      out[o] = rgb.r + (hot.r - rgb.r) * white;
      out[o + 1] = rgb.g + (hot.g - rgb.g) * white;
      out[o + 2] = rgb.b + (hot.b - rgb.b) * white;
      out[o + 3] = (light > 1 ? 1 : light) * 255;
    }
  }
}

/**
 * The loop of tiles for one colour, sharpness and resolution, shared by every
 * layer and shape that asks for the same.
 *
 * All of its canvases are made on first use, so a warm layer never allocates;
 * each moment is *baked* only the first time the show reaches it, a few
 * milliseconds a time over the first trip round rather than a stall of a few
 * hundred at the start. What a moment looks like depends on nothing but the
 * key and its index, so it does not matter which tab baked it when.
 *
 * Keyed on `stable`, never on `p`: Sharpness bound to the microphone would
 * otherwise throw the loop away every frame.
 */
const causticLoops = new Map();

function causticLoop(colour, sharpness, size) {
  const key = `${colour}|${sharpness}|${size}`;
  let loop = causticLoops.get(key);
  if (loop) return loop;
  // Two looks in memory at once is plenty: each is a couple of megabytes.
  if (causticLoops.size >= 2) causticLoops.delete(causticLoops.keys().next().value);
  const frames = [];
  for (let f = 0; f < CAUSTIC_FRAMES; f++) frames.push(offscreen(size, size));
  const rgb = hexToRgb(colour);
  loop = {
    size,
    sharpness,
    frames,
    baked: new Uint8Array(CAUSTIC_FRAMES),
    image: frames[0].getContext('2d').createImageData(size, size),
    rgb,
    hot: hexToRgb(mixHex(colour, '#ffffff', 0.85)),
  };
  causticLoops.set(key, loop);
  return loop;
}

/** Moment `f` of `loop`, baked if this is the first time anybody has asked. */
function causticMoment(loop, f) {
  const tile = loop.frames[f];
  if (!loop.baked[f]) {
    bakeCausticTile(loop.image.data, loop.size, f / CAUSTIC_FRAMES, loop.sharpness, loop.rgb, loop.hot);
    tile.getContext('2d').putImageData(loop.image, 0, 0);
    loop.baked[f] = 1;
  }
  return tile;
}

/**
 * Two scratch tiles, one per layer, each the cross-fade of two moments of the
 * loop. Overwritten whole every time they are used, so they carry nothing from
 * one frame to the next.
 */
const blendTiles = [null, null];

function blendedTile(slot, loop, position) {
  let tile = blendTiles[slot];
  if (!tile) {
    tile = offscreen(loop.size, loop.size);
    blendTiles[slot] = tile;
  }
  if (tile.width !== loop.size) {
    tile.width = loop.size;
    tile.height = loop.size;
  }
  const g = tile.getContext('2d');
  const at = ((position % CAUSTIC_FRAMES) + CAUSTIC_FRAMES) % CAUSTIC_FRAMES;
  const f0 = Math.floor(at) % CAUSTIC_FRAMES;
  const mix = at - Math.floor(at);
  g.globalCompositeOperation = 'copy';
  g.globalAlpha = 1 - mix;
  g.drawImage(causticMoment(loop, f0), 0, 0);
  g.globalCompositeOperation = 'lighter';
  g.globalAlpha = mix;
  g.drawImage(causticMoment(loop, (f0 + 1) % CAUSTIC_FRAMES), 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  return tile;
}

/**
 * Cover `bbox` with `tile` repeated at `scale` world pixels per texel, slid by
 * `ox, oy`.
 *
 * Stamped as a grid of `drawImage`s rather than filled with a repeating
 * pattern, which would be the obvious way to write it: measured on the demo
 * wall the stamps cost about three fifths of the pattern fill for the same
 * pixels, and the tile wraps cleanly enough that the joins cannot be found.
 */
function fillTiled(g, tile, bbox, scale, ox, oy) {
  const span = tile.width * scale;
  if (!(span > 1)) return;
  const x0 = ox + Math.floor((bbox.x - ox) / span) * span;
  const y0 = oy + Math.floor((bbox.y - oy) / span) * span;
  for (let y = y0; y < bbox.y + bbox.h; y += span) {
    for (let x = x0; x < bbox.x + bbox.w; x += span) g.drawImage(tile, x, y, span, span);
  }
}

const caustics = {
  id: 'caustics',
  name: 'Water Caustics',
  category: 'atmosphere',
  scope: 'shape',
  description:
    'The web of light that sun through moving water throws on whatever is under it: thin sharp folds closing into cells, brightest where they meet, re-forming as the surface moves. Slow it right down and it becomes a very good "something is wrong" wash.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#7fe8ff' },
    { key: 'color2', type: 'color', label: 'Deep colour', default: '#04203a' },
    { key: 'scale', type: 'range', label: 'Scale', default: 3.2, min: 0.5, max: 12, step: 0.1 },
    { key: 'speed', type: 'range', label: 'Speed', default: 0.35, min: 0, max: 3, step: 0.01 },
    { key: 'sharpness', type: 'range', label: 'Sharpness', default: 3.5, min: 1, max: 10, step: 0.1 },
    { key: 'level', type: 'range', label: 'Brightness', default: 0.8, min: 0, max: 2, step: 0.01 },
    { key: 'resolution', type: 'range', label: 'Detail', default: 56, min: 12, max: 130, step: 2 },
  ],
  draw({ g, p, stable, shape, t }) {
    const { bbox } = shape;
    if (bbox.w <= 2 || bbox.h <= 2 || p.level <= 0) return;

    /**
     * Detail is how finely the tile is drawn: crisper filaments for more
     * memory and a longer bake. A hundred and ninety-two texels at the
     * Sunken preset's 64, which puts a texel at about two world pixels on the
     * demo wall — as fine as a projector at that distance resolves.
     */
    const size = clamp(Math.round((stable.resolution * 3) / 16) * 16, 96, 320);
    const loop = causticLoop(stable.color, stable.sharpness, size);

    /**
     * How big a cell is on the wall: Scale of them across the shape, roughly,
     * and the fine web a little under half that, at a ratio that keeps the
     * two tiles from ever repeating in step.
     */
    const span = (bbox.w + bbox.h) / 2;
    const cell = Math.max(8, span / Math.max(0.5, p.scale * 2.2));
    const coarse = (cell * TILE_CELLS) / size;
    const fine = coarse * 0.453;

    // Round the loop at a rate the Speed slider sets, the fine web faster
    // because chop is quicker than swell; and drifting, the two webs in
    // different directions, because the surface is going somewhere.
    const clock = t * p.speed;
    const slide = clock * cell * 0.22;

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';

    /**
     * The water between the folds: not black — the light that was not
     * gathered into a fold is still arriving, spread thin — but dim and the
     * deep colour, so the web has something to be brighter than.
     */
    g.fillStyle = rgba(p.color2, clamp(0.6 * p.level, 0, 1));
    g.fillRect(bbox.x, bbox.y, bbox.w, bbox.h);

    /**
     * Brightness above one is a second stamp of the same web, because the
     * tile's hot core is already at full alpha and `globalAlpha` stops at one:
     * clamping instead would leave the top half of the slider doing nothing.
     */
    const near = blendedTile(0, loop, clock * 2.6);
    const far = blendedTile(1, loop, clock * 3.7 + CAUSTIC_FRAMES * 0.37);
    for (let level = p.level; level > 0.004; level -= 1) {
      g.globalAlpha = clamp(level, 0, 1);
      fillTiled(g, near, bbox, coarse, bbox.x + slide * 0.88, bbox.y + slide * 0.47);
      g.globalAlpha = clamp(level * 0.5, 0, 1);
      fillTiled(g, far, bbox, fine, bbox.x - slide * 0.61 + cell * 0.31, bbox.y + slide * 0.35 + cell * 0.77);
    }
    g.globalAlpha = 1;
    g.restore();
  },
};

/** Temperature falls fast at first, then levels off — Newtonian cooling. */
function lerpTemp(hot, cool, f) {
  return cool + (hot - cool) * Math.exp(-3.2 * f);
}

const embers = {
  id: 'embers',
  name: 'Drifting Embers',
  category: 'atmosphere',
  scope: 'shape',
  description:
    'Slow motes rising through the frame with turbulence. Costs almost nothing and adds enormous depth behind other effects.',
  params: [
    { key: 'hotTemp', type: 'range', label: 'Hot temperature (K)', default: 2000, min: 900, max: 3500, step: 25 },
    { key: 'coolTemp', type: 'range', label: 'Cooled temperature (K)', default: 1050, min: 800, max: 2500, step: 25 },
    { key: 'count', type: 'range', label: 'Motes', default: 90, min: 5, max: 600, step: 5 },
    { key: 'rise', type: 'range', label: 'Rise speed', default: 34, min: -200, max: 200, step: 1 },
    { key: 'drift', type: 'range', label: 'Drift', default: 22, min: -200, max: 200, step: 1 },
    { key: 'turbulence', type: 'range', label: 'Turbulence', default: 26, min: 0, max: 200, step: 1 },
    { key: 'size', type: 'range', label: 'Size', default: 3.4, min: 0.5, max: 20, step: 0.1 },
    { key: 'twinkle', type: 'range', label: 'Twinkle', default: 0.6, min: 0, max: 1, step: 0.01 },
    { key: 'opacity', type: 'range', label: 'Opacity', default: 0.8, min: 0.02, max: 1, step: 0.01 },
  ],
  init() {
    return { motes: [], count: 0 };
  },
  step({ p, shape, t, dt, rng, state, noise }) {
    const { bbox } = shape;
    if (bbox.w <= 0 || bbox.h <= 0) return;
    const target = Math.round(p.count);

    const spawn = (mote = {}, fresh = false) => {
      mote.x = bbox.x + rng() * bbox.w;
      mote.y = fresh ? bbox.y + bbox.h + rng() * bbox.h * 0.1 : bbox.y + rng() * bbox.h;
      mote.seed = rng() * 100;
      mote.scale = 0.4 + rng() * 1.1;
      mote.life = 0;
      mote.span = 4 + rng() * 8;
      return mote;
    };

    while (state.motes.length < target) state.motes.push(spawn({}, false));
    if (state.motes.length > target) state.motes.length = target;

    for (const mote of state.motes) {
      mote.life += dt;
      const turb = noise.noise3(mote.x * 0.003, mote.y * 0.003, t * 0.25 + mote.seed);
      mote.x += (p.drift + turb * p.turbulence) * dt;
      mote.y -= p.rise * dt;

      if (mote.y < bbox.y - bbox.h * 0.1 || mote.y > bbox.y + bbox.h * 1.1 || mote.life > mote.span) {
        spawn(mote, true);
      }
    }
  },
  draw({ g, p, shape, t, state }) {
    const { bbox } = shape;
    if (bbox.w <= 0 || bbox.h <= 0) return;

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';

    for (const mote of state.motes) {
      // Fade in and out over the mote's life so nothing pops.
      const f = clamp(mote.life / mote.span, 0, 1);
      let alpha = Math.sin(f * Math.PI) * p.opacity;
      if (p.twinkle > 0) alpha *= 1 - p.twinkle * (0.5 + 0.5 * Math.sin(t * 5 + mote.seed * 3));
      if (alpha <= 0.01) continue;

      const r = p.size * mote.scale;
      // An ember cools as it travels, so its colour is a temperature rather
      // than a fade between two chosen hexes. That is what makes a dying one go
      // deep red instead of merely dim.
      const colour = blackbodyCss(lerpTemp(p.hotTemp, p.coolTemp, clamp(f, 0, 1)));
      const grad = g.createRadialGradient(mote.x, mote.y, 0, mote.x, mote.y, r * 3);
      grad.addColorStop(0, rgba(colour, alpha));
      grad.addColorStop(1, rgba(colour, 0));
      g.fillStyle = grad;
      g.beginPath();
      g.arc(mote.x, mote.y, r * 3, 0, TAU);
      g.fill();
    }
    g.restore();
  },
};

const shatter = {
  id: 'shatter',
  name: 'Cracking Glass',
  category: 'atmosphere',
  scope: 'shape',
  description:
    'A crack spreading from an impact point, on a timer. Point it at a window and time it with a bang.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#dff0ff' },
    { key: 'interval', type: 'range', label: 'Every (s)', default: 25, min: 2, max: 600, step: 1 },
    { key: 'grow', type: 'range', label: 'Spread time (s)', default: 0.35, min: 0.05, max: 5, step: 0.01 },
    { key: 'hold', type: 'range', label: 'Hold (s)', default: 4, min: 0, max: 60, step: 0.5 },
    { key: 'branches', type: 'range', label: 'Main cracks', default: 9, min: 3, max: 24, step: 1 },
    { key: 'depth', type: 'range', label: 'Branching', default: 3, min: 0, max: 5, step: 1 },
    { key: 'width', type: 'range', label: 'Thickness', default: 2.4, min: 0.4, max: 12, step: 0.1 },
    { key: 'impactX', type: 'range', label: 'Impact X', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'impactY', type: 'range', label: 'Impact Y', default: 0.45, min: 0, max: 1, step: 0.01 },
    { key: 'flash', type: 'range', label: 'Impact flash', default: 0.7, min: 0, max: 1, step: 0.01 },
  ],
  draw({ g, p, shape, t, rng }) {
    const { bbox } = shape;
    const cycle = t % Math.max(1, p.interval);
    const total = p.grow + p.hold;
    if (cycle > total) return;

    const progress = clamp(cycle / Math.max(0.01, p.grow), 0, 1);
    // Fade the whole thing out over the last second of the hold.
    const fade = cycle > p.grow ? clamp(1 - (cycle - p.grow) / Math.max(0.01, p.hold), 0, 1) : 1;
    const eased = 1 - (1 - progress) ** 3;

    const cx = bbox.x + p.impactX * bbox.w;
    const cy = bbox.y + p.impactY * bbox.h;
    const reach = Math.hypot(bbox.w, bbox.h) * 0.6;

    // Seeded per impact so the same crack pattern persists while it is on
    // screen, and a different one appears next time.
    const impact = Math.floor(t / Math.max(1, p.interval));
    const seeded = (() => {
      let a = (impact * 2654435761) >>> 0;
      return () => {
        a = (Math.imul(a ^ (a >>> 15), 2246822519) + 0x9e3779b9) >>> 0;
        return a / 4294967296;
      };
    })();

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';
    g.globalAlpha = fade;

    const drawCrack = (x, y, angle, length, width, depth) => {
      if (length < 4 || width < 0.15) return;
      let px = x;
      let py = y;
      let a = angle;
      const steps = 6;
      g.strokeStyle = rgba(p.color, 0.85);
      g.lineWidth = width;
      g.beginPath();
      g.moveTo(px, py);
      for (let i = 1; i <= steps; i++) {
        a += (seeded() - 0.5) * 0.5;
        const seg = (length / steps) * eased;
        px += Math.cos(a) * seg;
        py += Math.sin(a) * seg;
        g.lineTo(px, py);
        if (depth > 0 && seeded() < 0.4) {
          drawCrack(px, py, a + (seeded() - 0.5) * 1.8, length * 0.45, width * 0.55, depth - 1);
        }
      }
      g.stroke();
    };

    for (let i = 0; i < Math.round(p.branches); i++) {
      const angle = (i / p.branches) * TAU + seeded() * 0.4;
      drawCrack(cx, cy, angle, reach * (0.5 + seeded() * 0.6), p.width, Math.round(p.depth));
    }

    if (p.flash > 0 && progress < 0.3) {
      const punch = (1 - progress / 0.3) * p.flash;
      const r = reach * 0.5 * (0.3 + progress * 2);
      const grad = g.createRadialGradient(cx, cy, 0, cx, cy, r);
      grad.addColorStop(0, rgba('#ffffff', punch));
      grad.addColorStop(1, rgba(p.color, 0));
      g.fillStyle = grad;
      g.beginPath();
      g.arc(cx, cy, r, 0, TAU);
      g.fill();
    }
    g.restore();
  },
};

const plasma = {
  id: 'plasma',
  name: 'Plasma Wash',
  category: 'atmosphere',
  scope: 'shape',
  description:
    'Smooth drifting colour fields. A far better ambient base than a flat wash — the wall never looks static.',
  params: [
    { key: 'colorA', type: 'color', label: 'Colour A', default: '#2a0060' },
    { key: 'colorB', type: 'color', label: 'Colour B', default: '#00306b' },
    { key: 'colorC', type: 'color', label: 'Colour C', default: '#5c0030' },
    { key: 'scale', type: 'range', label: 'Scale', default: 1.6, min: 0.2, max: 8, step: 0.05 },
    { key: 'speed', type: 'range', label: 'Speed', default: 0.09, min: 0, max: 1.5, step: 0.005 },
    { key: 'level', type: 'range', label: 'Brightness', default: 0.75, min: 0, max: 2, step: 0.01 },
    { key: 'resolution', type: 'range', label: 'Detail', default: 40, min: 8, max: 100, step: 2 },
    { key: 'contrast', type: 'range', label: 'Contrast', default: 1.3, min: 0.2, max: 4, step: 0.05 },
  ],
  draw({ g, p, shape, t, state, noise }) {
    const { bbox } = shape;
    if (bbox.w <= 2 || bbox.h <= 2) return;

    const cols = Math.max(6, Math.round(p.resolution));
    const rows = Math.max(6, Math.round((cols * bbox.h) / bbox.w));
    const field = ensureField(state, 'field', cols, rows);
    field.clear();

    // Two precomputed ramps, blended per cell. Mixing in linear light is what
    // keeps the transitions from passing through a muddy grey.
    const STEPS = 20;
    const rampAB = [];
    const rampC = [];
    for (let i = 0; i < STEPS; i++) {
      const f = i / (STEPS - 1);
      for (const [target, from, to] of [[rampAB, p.colorA, p.colorB], [rampC, p.colorA, p.colorC]]) {
        const hex = mixLinear(from, to, f).replace('#', '');
        const n = parseInt(hex, 16) || 0;
        target.push([(n >> 16) & 255, (n >> 8) & 255, n & 255]);
      }
    }

    for (let y = 0; y < rows; y++) {
      const v = (y + 0.5) / rows;
      for (let x = 0; x < cols; x++) {
        const u = (x + 0.5) / cols;
        // Two offset noise samples act as weights for three colours, which
        // gives smooth blends without ever computing a hue.
        const a = noise.noise3(u * p.scale, v * p.scale, t * p.speed) * 0.5 + 0.5;
        const b = noise.noise3(u * p.scale + 9.1, v * p.scale - 3.7, t * p.speed * 1.3) * 0.5 + 0.5;

        const shaped = clamp((a - 0.5) * p.contrast + 0.5, 0, 1);
        const shapedB = clamp((b - 0.5) * p.contrast + 0.5, 0, 1);

        const base = rampAB[Math.min(STEPS - 1, (shaped * STEPS) | 0)];
        const tint = rampC[Math.min(STEPS - 1, (shapedB * 0.6 * STEPS) | 0)];
        const mix = shapedB * 0.6;

        field.set(
          x, y,
          base[0] * (1 - mix) + tint[0] * mix,
          base[1] * (1 - mix) + tint[1] * mix,
          base[2] * (1 - mix) + tint[2] * mix,
          clamp(p.level * (0.35 + 0.65 * shaped), 0, 1)
        );
      }
    }

    g.save();
    g.clip(shape.path);
    field.blit(g, bbox.x, bbox.y, bbox.w, bbox.h);
    g.restore();
  },
};

const scanner = {
  id: 'scan-lines',
  name: 'Scan Sweep',
  category: 'atmosphere',
  scope: 'shape',
  description: 'A bright line sweeping across the shape, leaving a decaying trail. Clean, technical, very readable.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#00ffc8' },
    { key: 'axis', type: 'select', label: 'Direction', default: 'down', options: ['down', 'up', 'right', 'left'] },
    { key: 'speed', type: 'range', label: 'Speed', default: 0.35, min: 0.01, max: 4, step: 0.01 },
    { key: 'thickness', type: 'range', label: 'Line thickness', default: 5, min: 0.5, max: 60, step: 0.5 },
    { key: 'trail', type: 'range', label: 'Trail', default: 0.3, min: 0, max: 1, step: 0.01 },
    { key: 'lines', type: 'range', label: 'Lines', default: 1, min: 1, max: 8, step: 1 },
    { key: 'grid', type: 'range', label: 'Grid behind', default: 0.12, min: 0, max: 1, step: 0.01 },
    { key: 'level', type: 'range', label: 'Brightness', default: 1, min: 0, max: 2, step: 0.01 },
  ],
  draw({ g, p, shape, t }) {
    const { bbox } = shape;
    const vertical = p.axis === 'down' || p.axis === 'up';
    const reversed = p.axis === 'up' || p.axis === 'left';
    const span = vertical ? bbox.h : bbox.w;
    if (span <= 0) return;

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = clamp(p.level, 0, 3);

    if (p.grid > 0) {
      g.strokeStyle = rgba(p.color, p.grid);
      g.lineWidth = 1;
      const step = span / 14;
      g.beginPath();
      for (let i = 0; i <= 14; i++) {
        if (vertical) {
          g.moveTo(bbox.x, bbox.y + i * step);
          g.lineTo(bbox.x + bbox.w, bbox.y + i * step);
        } else {
          g.moveTo(bbox.x + i * step, bbox.y);
          g.lineTo(bbox.x + i * step, bbox.y + bbox.h);
        }
      }
      g.stroke();
    }

    for (let i = 0; i < Math.round(p.lines); i++) {
      let f = frac(t * p.speed + i / Math.max(1, p.lines));
      if (reversed) f = 1 - f;
      const pos = (vertical ? bbox.y : bbox.x) + f * span;
      const trailLen = span * p.trail;

      if (trailLen > 1) {
        const from = reversed ? pos + trailLen : pos - trailLen;
        const grad = vertical
          ? g.createLinearGradient(0, from, 0, pos)
          : g.createLinearGradient(from, 0, pos, 0);
        grad.addColorStop(0, rgba(p.color, 0));
        grad.addColorStop(1, rgba(p.color, 0.4));
        g.fillStyle = grad;
        if (vertical) {
          g.fillRect(bbox.x, Math.min(from, pos), bbox.w, Math.abs(pos - from));
        } else {
          g.fillRect(Math.min(from, pos), bbox.y, Math.abs(pos - from), bbox.h);
        }
      }

      g.fillStyle = p.color;
      if (vertical) g.fillRect(bbox.x, pos - p.thickness / 2, bbox.w, p.thickness);
      else g.fillRect(pos - p.thickness / 2, bbox.y, p.thickness, bbox.h);
    }
    g.restore();
  },
};

export default [rain, searchlight, caustics, embers, shatter, plasma, scanner];
