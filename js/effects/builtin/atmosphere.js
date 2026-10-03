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

import { rgba, clamp, lerp, TAU, frac, mixHex, hexToRgb, hashString } from '../../core/math.js';
import { offscreen, glow } from '../lib.js';
import { blackbodyCss, mixLinear } from '../color.js';
import { ensureField } from '../field.js';

/**
 * How many depths the shower is drawn at.
 *
 * Every drop at one depth is the same width and brightness, so a depth is one
 * path holding every streak at it, stroked twice — a soft wide pass and a
 * bright core. Four depths is enough that the eye reads a continuous range
 * from the far curtain to the near streaks, and it is eight strokes a frame
 * instead of seven hundred.
 */
const RAIN_DEPTHS = 4;

/** How long a splash lives, in seconds. */
const SPLASH_LIFE = 0.42;

const rain = {
  id: 'rain',
  name: 'Rain',
  category: 'atmosphere',
  scope: 'shape',
  description:
    'Falling rain catching the light, from a fine far curtain to bright near streaks, blown by the wind and splashing where it lands. Leave targets empty to cover the house.',
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
      // Its own length and catch of the light, so no two streaks are clones.
      drop.v = rng();
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

      /**
       * Where this drop meets the ground, which depends on how far away it is.
       *
       * The ground is a plane running away from you, so in the picture the
       * near rain lands at the bottom of the frame and the far rain lands
       * higher up, against the foot of the wall. Landing them all on the
       * bottom edge put every splash half out of shot.
       */
      const ground = bbox.y + bbox.h - (bbox.h * 0.12 * (1 - z)) / Math.max(1e-3, p.depth);
      if (drop.y > ground) {
        if (p.splash > 0 && rng() < p.splash * 0.5) {
          state.splashes.push({ x: drop.x, y: ground, age: 0, z, seed: rng() });
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
        if (s.age > SPLASH_LIFE) state.splashes.splice(i, 1);
      }
      // Runaway guard if the splash rate ever outpaces the lifetime.
      if (state.splashes.length > 400) state.splashes.length = 400;
    }
  },
  draw({ g, p, shape, state }) {
    const { bbox } = shape;
    if (bbox.w <= 0 || bbox.h <= 0 || !state.drops?.length) return;

    const angle = (p.angle * Math.PI) / 180;
    const dirX = Math.sin(angle);
    const dirY = Math.cos(angle);
    const near = mixHex(p.color, '#ffffff', 0.45);

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';

    /**
     * Rain is only visible where it catches light, and what a camera — or an
     * eye — sees of a falling drop is the streak it draws in the time it is
     * looked at: a line of even brightness with soft ends, not a dot with a
     * comet's tail. So every streak is a plain round-capped line along the
     * fall.
     *
     * Depth is three things moving together, which is the whole illusion: a
     * near drop is longer (it crosses more of the view in the same time),
     * wider and brighter, and slightly whiter, because it is catching the
     * light rather than being lit by the haze; a far one is a short faint
     * thread in the colour of the night. The old version had the covariance
     * right and drew every drop as a single faint pixel line through its own
     * transform and its own gradient, which at the Night City preset's
     * settings was rain nobody could see.
     */
    for (let d = 0; d < RAIN_DEPTHS; d++) {
      const lo = d / RAIN_DEPTHS;
      const hi = (d + 1) / RAIN_DEPTHS;
      const z = 1 - p.depth * (1 - (lo + hi) / 2);
      const colour = mixHex(p.color, near, (lo + hi) / 2);
      const bright = p.opacity * (0.45 + 1.1 * ((lo + hi) / 2) ** 1.5);
      for (const [wide, alpha] of [[3.2, 0.16], [1, 1]]) {
        g.strokeStyle = rgba(colour, clamp(bright * alpha, 0, 1));
        g.lineWidth = Math.max(0.5, p.width * (0.45 + 0.75 * z) * wide);
        g.beginPath();
        for (const drop of state.drops) {
          // Which depth bucket: drop.z runs from 1 − depth to 1.
          const at = p.depth > 0 ? (drop.z - (1 - p.depth)) / p.depth : 1;
          if (at < lo || at >= hi + (d === RAIN_DEPTHS - 1 ? 1e-9 : 0)) continue;
          const len = p.length * drop.z * (0.7 + 0.6 * (drop.v ?? 0.5));
          g.moveTo(drop.x, drop.y);
          g.lineTo(drop.x - dirX * len, drop.y - dirY * len);
        }
        g.stroke();
      }
    }

    /**
     * Splashes, where the rain meets the ground.
     *
     * A drop hitting a hard surface throws a crown — a ring of droplets flung
     * up and out, which rise, slow and fall back on real ballistics — and
     * leaves a ring of water spreading flat around where it struck. The
     * droplets catch the light as short bright streaks along their flight;
     * the ring is a fading ellipse, flat because it is lying on the ground
     * and we are looking along it. Both in one path each, for every splash at
     * once.
     */
    if (p.splash > 0 && state.splashes.length) {
      const reach = p.length * 0.6;
      // Three ages, so a splash fades as it goes: a stroke has one alpha.
      for (let band = 0; band < 3; band++) {
        const from = band / 3;
        const to = (band + 1) / 3;
        const fade = (1 - (from + to) / 2) ** 2;
        g.strokeStyle = rgba(near, clamp(p.opacity * p.splash * 2.2 * fade, 0, 1));
        g.lineWidth = Math.max(0.6, p.width * 1.1);
        g.beginPath();
        for (const s of state.splashes) {
          const f = s.age / SPLASH_LIFE;
          if (f < from || f >= to) continue;
          const seed = s.seed ?? 0.5;
          const size = reach * s.z;
          // Four droplets: out at a spread of angles, up and back down under
          // gravity scaled to the splash, each drawn along its own velocity.
          for (let k = 0; k < 4; k++) {
            const side = (k < 2 ? -1 : 1) * (0.45 + 0.55 * frac(seed * (7 + k * 3)));
            const up = 0.75 + 0.5 * frac(seed * (13 + k * 5));
            const x = s.x + side * size * f * 1.6;
            const y = s.y - size * up * 4 * f * (1 - f);
            const vx = side * size * 1.6;
            const vy = -size * up * 4 * (1 - 2 * f);
            const speed = Math.hypot(vx, vy) || 1;
            const tail = Math.max(0.6, size * 0.14);
            g.moveTo(x, y);
            g.lineTo(x - (vx / speed) * tail, y - (vy / speed) * tail);
          }
        }
        g.stroke();

        g.strokeStyle = rgba(p.color, clamp(p.opacity * p.splash * 1.2 * fade, 0, 1));
        g.lineWidth = Math.max(0.5, p.width * 0.8);
        g.beginPath();
        for (const s of state.splashes) {
          const f = s.age / SPLASH_LIFE;
          if (f < from || f >= to) continue;
          const r = reach * s.z * (0.25 + f * 1.1);
          g.moveTo(s.x + r, s.y);
          g.ellipse(s.x, s.y, r, r * 0.22, 0, 0, TAU);
        }
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

/* ------------------------------------------------------------------ *
 * Drifting embers
 * ------------------------------------------------------------------ */

/**
 * Temperature falls fast at first, then levels off — Newtonian cooling — over
 * an ember's life, `f` from 0 to 1. Two time constants in a lifetime: by the
 * end it has lost most of its heat, but it is still glowing for most of the
 * climb, which is what makes a column of them read as a fire somewhere below.
 */
function lerpTemp(hot, cool, f) {
  return cool + (hot - cool) * Math.exp(-2 * f);
}

/**
 * The sprite ladder: one baked ember per step of temperature.
 *
 * An ember is a point of incandescence with a glow round it, and both take
 * their colour from how hot it is — so the sprite is a white-hot pinpoint
 * fading through the blackbody colour of its temperature to nothing, and a
 * cooling ember is stamped from a cooler rung of the ladder. Twelve rungs
 * between the layer's hot and cooled temperatures is finer than the eye can
 * tell apart, and it means a show of a few hundred embers is a few hundred
 * `drawImage`s rather than a few hundred gradients built and thrown away
 * every frame.
 */
const EMBER_RUNGS = 12;
const EMBER_SPRITE = 64;
const emberLadders = new Map();

function emberLadder(hot, cool) {
  const key = `${hot}|${cool}`;
  let ladder = emberLadders.get(key);
  if (ladder) return ladder;
  if (emberLadders.size > 8) emberLadders.clear();
  ladder = [];
  for (let r = 0; r < EMBER_RUNGS; r++) {
    const kelvin = lerp(cool, hot, r / (EMBER_RUNGS - 1));
    const colour = blackbodyCss(kelvin);
    // The core goes whiter the hotter the ember: the same blackbody,
    // overexposed, which is what a camera and an eye both make of it.
    const core = mixHex(colour, '#ffffff', 0.25 + 0.5 * (r / (EMBER_RUNGS - 1)));
    const sprite = offscreen(EMBER_SPRITE, EMBER_SPRITE);
    const g = sprite.getContext('2d');
    const m = EMBER_SPRITE / 2;
    const grad = g.createRadialGradient(m, m, 0, m, m, m);
    grad.addColorStop(0, rgba(core, 1));
    grad.addColorStop(0.13, rgba(core, 0.92));
    grad.addColorStop(0.28, rgba(colour, 0.6));
    grad.addColorStop(0.52, rgba(colour, 0.18));
    grad.addColorStop(0.78, rgba(colour, 0.04));
    grad.addColorStop(1, rgba(colour, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, EMBER_SPRITE, EMBER_SPRITE);
    ladder.push(sprite);
  }
  emberLadders.set(key, ladder);
  return ladder;
}

const embers = {
  id: 'embers',
  name: 'Drifting Embers',
  category: 'atmosphere',
  scope: 'shape',
  description:
    'Hot motes rising on the air and tumbling as they go, white-gold when they leave and cooling to a dull red as they climb. Costs almost nothing and adds enormous depth behind other effects.',
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

    /**
     * Where an ember starts, and how long it has.
     *
     * Most come up from below, where the fire is; a third flare up in mid-air,
     * because an ember that has been smouldering dark in the smoke catches a
     * breath of air and lights again. And each lives long enough to climb a
     * good part of the shape: the old lifetime of four to twelve seconds, at
     * the thirty pixels a second the presets rise at, meant no ember ever got
     * out of the bottom third of the house.
     */
    const spawn = (mote = {}, fresh = false) => {
      const flare = !fresh || rng() < 0.35;
      mote.x = bbox.x + rng() * bbox.w;
      mote.y = flare
        ? bbox.y + bbox.h * (0.25 + rng() * 0.8)
        : bbox.y + bbox.h + rng() * bbox.h * 0.1;
      mote.seed = rng() * 100;
      mote.scale = 0.4 + rng() * 1.1;
      mote.life = 0;
      const climb = bbox.h / Math.max(8, Math.abs(p.rise));
      mote.span = clamp(climb * (0.45 + rng() * 0.75), 3, 60);
      // Some burn hotter than others: a spark off a resinous knot is not a
      // flake of ash.
      mote.heat = 0.55 + rng() * 0.45;
      mote.vx = 0;
      mote.vy = -p.rise;
      return mote;
    };

    while (state.motes.length < target) state.motes.push(spawn({}, false));
    if (state.motes.length > target) state.motes.length = target;

    for (const mote of state.motes) {
      mote.life += dt;
      const turb = noise.noise3(mote.x * 0.003, mote.y * 0.003, t * 0.25 + mote.seed);
      mote.vx = p.drift + turb * p.turbulence;
      mote.vy = -p.rise;
      mote.x += mote.vx * dt;
      mote.y += mote.vy * dt;

      if (mote.y < bbox.y - bbox.h * 0.1 || mote.y > bbox.y + bbox.h * 1.1 || mote.life > mote.span) {
        spawn(mote, true);
      }
    }
  },
  draw({ g, p, shape, t, state, stable }) {
    const { bbox } = shape;
    if (bbox.w <= 0 || bbox.h <= 0 || !state.motes?.length) return;
    const ladder = emberLadder(stable.hotTemp, stable.coolTemp);
    const span = Math.max(1, p.hotTemp - p.coolTemp);

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';

    for (const mote of state.motes) {
      const f = clamp(mote.life / Math.max(0.01, mote.span), 0, 1);
      /**
       * Hot, then cooling: the colour is a temperature, and so is the
       * brightness. A blackbody's output climbs as the fourth power of its
       * temperature, so an ember at twice the temperature is sixteen times
       * as bright — which is why a fresh spark is a point of white-gold and a
       * dying one is a dull red. Drawn far gentler than the fourth power,
       * because the eye is logarithmic, the projector has a ceiling and a
       * dull red ember still has to be seen from the pavement; but drawn
       * rising with the heat: the old embers kept one brightness from birth
       * to death and every one of them was a dim red dot.
       */
      const kelvin = lerpTemp(p.hotTemp * mote.heat + p.coolTemp * (1 - mote.heat), p.coolTemp, f);
      const warmth = clamp((kelvin - p.coolTemp) / span, 0, 1);
      // In and out over the first and last moments of its life, so nothing pops.
      let alpha = p.opacity * clamp(f * 12, 0, 1) * clamp((1 - f) * 6, 0, 1) * (0.8 + 0.5 * warmth ** 1.3);
      /**
       * The twinkle is the ember tumbling: a flake hot on one face and cooled
       * on the other shows each in turn, several times a second, and no two
       * at the same rate.
       */
      if (p.twinkle > 0) {
        const spin = 7 + (mote.seed % 7);
        alpha *= 1 - p.twinkle * 0.55 * (0.5 + 0.5 * Math.sin(t * spin + mote.seed * 3)) ** 2;
      }
      if (alpha <= 0.01) continue;

      const sprite = ladder[Math.round(warmth * (EMBER_RUNGS - 1))];
      const r = p.size * mote.scale * (0.8 + 0.5 * warmth);
      const size = r * 8.5;
      g.globalAlpha = clamp(alpha, 0, 1);
      g.drawImage(sprite, mote.x - size / 2, mote.y - size / 2, size, size);

      /**
       * And a fainter, smaller echo a little way back along its path, the way
       * it is drawn by an eye following the fire rather than the ember, so a
       * hot mote reads as a moving spark rather than as a point.
       */
      const speed = Math.hypot(mote.vx, mote.vy);
      if (speed > 1 && warmth > 0.15) {
        const back = Math.min(r * 3, speed * 0.12);
        const shrink = size * 0.7;
        g.globalAlpha = clamp(alpha * 0.4, 0, 1);
        g.drawImage(sprite, mote.x - (mote.vx / speed) * back - shrink / 2,
          mote.y - (mote.vy / speed) * back - shrink / 2, shrink, shrink);
      }
    }
    g.globalAlpha = 1;
    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * Cracking glass
 * ------------------------------------------------------------------ */

/**
 * How glass breaks, which is the whole of this effect.
 *
 * A pane struck at a point fails in two families of crack, and the pattern
 * anybody recognises — the spider's web in a car windscreen — is the two
 * together. First the radial cracks: the blow bends the pane, the far face
 * stretches, and cracks race outward from the impact in every direction,
 * nearly straight, kinking a little where they meet a flaw, now and then
 * forking. Then the concentric ones: the sectors of glass between the radials
 * bend as hinged flaps, and they fail in tension across their width, in rough
 * chords from one radial to the next, a few of them at widening intervals.
 * Right at the impact the glass is crushed to a frosted rosette of tiny
 * cracks.
 *
 * Every crack is a thin bright line because a crack in glass is a mirror —
 * two faces a hair apart, each catching the light — and where cracks cross
 * the faces are tilted every way at once, so those are where it glints.
 *
 * The old version drew random branching walks from the impact: a bramble,
 * with no rings, so it read as frost or lightning rather than as a broken
 * window, and its hold faded out from the moment the cracks stopped growing,
 * so most of the time there was nothing there at all.
 */

/** Scratch for the radial cracks: up to 24 of them, nine points each. */
const RADIAL_POINTS = 9;
const crackX = new Float64Array(24 * RADIAL_POINTS);
const crackY = new Float64Array(24 * RADIAL_POINTS);
const crackLength = new Float64Array(24);

/**
 * Three small seeded generators — the radials, the finer cracks, the glints —
 * reseeded from the impact's index on every frame, so the same window breaks
 * the same way in every tab and stays broken the same way while it is up.
 * Separate streams so that moving Branching does not reshape the radials.
 */
const crackStreams = new Uint32Array(3);

function seedCracks(stream, seed) {
  crackStreams[stream] = (Math.imul(seed + 1, 2654435761) + 0x9e3779b9) >>> 0;
}

function crackRand(stream) {
  const a = crackStreams[stream];
  crackStreams[stream] = (Math.imul(a ^ (a >>> 15), 2246822519) + 0x9e3779b9) >>> 0;
  return crackStreams[stream] / 4294967296;
}

/** Where radial `i` is at distance `r` from the impact, walking its own kinked path. */
function alongCrack(i, r, out) {
  const base = i * RADIAL_POINTS;
  const step = crackLength[i] / (RADIAL_POINTS - 1);
  const at = clamp(r / Math.max(1e-6, step), 0, RADIAL_POINTS - 1);
  const k = Math.min(RADIAL_POINTS - 2, Math.floor(at));
  const f = at - k;
  out.x = crackX[base + k] + (crackX[base + k + 1] - crackX[base + k]) * f;
  out.y = crackY[base + k] + (crackY[base + k + 1] - crackY[base + k]) * f;
}
const CRACK_A = { x: 0, y: 0 };
const CRACK_B = { x: 0, y: 0 };

/** A glint: a hot point with four fine rays, baked once per colour. */
const glassGlints = new Map();

function glassGlint(colour) {
  let sprite = glassGlints.get(colour);
  if (sprite) return sprite;
  if (glassGlints.size > 16) glassGlints.clear();
  const S = 48;
  sprite = offscreen(S, S);
  const g = sprite.getContext('2d');
  const m = S / 2;
  g.globalCompositeOperation = 'lighter';
  const core = g.createRadialGradient(m, m, 0, m, m, m * 0.45);
  core.addColorStop(0, rgba('#ffffff', 1));
  core.addColorStop(0.18, rgba('#ffffff', 0.65));
  core.addColorStop(0.5, rgba(colour, 0.18));
  core.addColorStop(1, rgba(colour, 0));
  g.fillStyle = core;
  g.fillRect(0, 0, S, S);
  for (const [w, h] of [[S, 2], [2, S]]) {
    const ray = w > h ? g.createLinearGradient(0, 0, S, 0) : g.createLinearGradient(0, 0, 0, S);
    ray.addColorStop(0, rgba(colour, 0));
    ray.addColorStop(0.5, rgba('#ffffff', 0.8));
    ray.addColorStop(1, rgba(colour, 0));
    g.fillStyle = ray;
    g.fillRect(m - w / 2, m - h / 2, w, h);
  }
  glassGlints.set(colour, sprite);
  return sprite;
}

const shatter = {
  id: 'shatter',
  name: 'Cracking Glass',
  category: 'atmosphere',
  scope: 'shape',
  description:
    'A pane breaking from an impact point, on a timer: radial cracks racing out, concentric ones between them, a crushed rosette at the strike and glints where the cracks cross. Point it at a window and time it with a bang.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#dff0ff' },
    { key: 'interval', type: 'range', label: 'Every (s)', default: 25, min: 2, max: 600, step: 1 },
    { key: 'grow', type: 'range', label: 'Spread time (s)', default: 0.35, min: 0.05, max: 5, step: 0.01 },
    /**
     * How long the broken pane stays, once it has broken.
     *
     * Glass does not heal, so this is really how long the show leaves it
     * there. Fifteen of the twenty-five seconds by default: the old four
     * meant the window was whole five times out of six, and a still taken at
     * almost any moment showed nothing.
     */
    { key: 'hold', type: 'range', label: 'Hold (s)', default: 15, min: 0, max: 60, step: 0.5 },
    { key: 'branches', type: 'range', label: 'Main cracks', default: 9, min: 3, max: 24, step: 1 },
    { key: 'depth', type: 'range', label: 'Branching', default: 3, min: 0, max: 5, step: 1 },
    { key: 'width', type: 'range', label: 'Thickness', default: 2.4, min: 0.4, max: 12, step: 0.1 },
    { key: 'impactX', type: 'range', label: 'Impact X', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'impactY', type: 'range', label: 'Impact Y', default: 0.45, min: 0, max: 1, step: 0.01 },
    { key: 'flash', type: 'range', label: 'Impact flash', default: 0.7, min: 0, max: 1, step: 0.01 },
  ],
  draw({ g, p, shape, t }) {
    const { bbox } = shape;
    if (bbox.w <= 1 || bbox.h <= 1) return;
    const interval = Math.max(1, p.interval);
    const cycle = t % interval;
    const total = p.grow + p.hold;
    if (cycle > total) return;

    const progress = clamp(cycle / Math.max(0.01, p.grow), 0, 1);
    // Out over the last second and a half of the hold, not across all of it.
    const fade = clamp((total - cycle) / Math.min(1.5, Math.max(0.01, p.hold)), 0, 1);
    // Cracks run fast and slow down: a crack front decelerates as the energy
    // the blow put into the pane is spent.
    const eased = 1 - (1 - progress) ** 3;

    const cx = bbox.x + p.impactX * bbox.w;
    const cy = bbox.y + p.impactY * bbox.h;
    const reach = Math.hypot(bbox.w, bbox.h) * 0.62;
    // Each pane breaks its own way: seeded by which impact this is and by
    // which shape, so four windows struck at once are four different breaks.
    const impact = (Math.floor(t / interval) * 7919 + hashString(String(shape.id))) >>> 0;
    seedCracks(0, impact);
    const radials = clamp(Math.round(p.branches), 3, 24);
    const width = Math.max(0.4, p.width);

    // The radial cracks, as kinked paths from the impact outwards.
    for (let i = 0; i < radials; i++) {
      const base = i * RADIAL_POINTS;
      let angle = ((i + (crackRand(0) - 0.5) * 0.55) / radials) * TAU;
      crackLength[i] = reach * (0.45 + crackRand(0) * 0.7);
      const step = crackLength[i] / (RADIAL_POINTS - 1);
      crackX[base] = cx;
      crackY[base] = cy;
      for (let k = 1; k < RADIAL_POINTS; k++) {
        angle += (crackRand(0) - 0.5) * 0.13;
        crackX[base + k] = crackX[base + k - 1] + Math.cos(angle) * step;
        crackY[base + k] = crackY[base + k - 1] + Math.sin(angle) * step;
      }
    }

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';
    g.lineJoin = 'round';

    /**
     * Two paths — the radials, and everything finer: forks, rings and the
     * crushed rosette — each stroked twice, a faint wide glow and a bright
     * hairline. Four strokes for the whole pane.
     */
    const front = eased * reach;
    for (const [wide, alpha] of [[3.4, 0.13], [1, 0.85]]) {
      // Radials, each as far as the front has got.
      g.strokeStyle = rgba(p.color, alpha * fade);
      g.lineWidth = width * wide;
      g.beginPath();
      for (let i = 0; i < radials; i++) {
        const base = i * RADIAL_POINTS;
        const shown = Math.min(front, crackLength[i]);
        if (shown <= 0) continue;
        g.moveTo(crackX[base], crackY[base]);
        const step = crackLength[i] / (RADIAL_POINTS - 1);
        for (let k = 1; k < RADIAL_POINTS; k++) {
          if (k * step <= shown) {
            g.lineTo(crackX[base + k], crackY[base + k]);
          } else {
            alongCrack(i, shown, CRACK_A);
            g.lineTo(CRACK_A.x, CRACK_A.y);
            break;
          }
        }
      }
      g.stroke();

      // The finer cracks, from their own stream, restarted for each pass so
      // the glow and the hairline trace the same cracks.
      seedCracks(1, impact);
      g.lineWidth = width * wide * 0.6;
      g.strokeStyle = rgba(p.color, alpha * 0.85 * fade);
      g.beginPath();
      /**
       * The concentric cracks: a few rings at widening radii, each a broken
       * chain of chords from one radial to the next — nearly straight, each
       * at its own distance out, many of them missing — because each is the
       * hinge line of a flap of glass that bent away from the blow and failed
       * where it was weakest. They form once the radial front has gone past.
       * Drawn as continuous rings they make a cobweb, which is what the eye
       * reads first and the one thing a broken window must not look like.
       */
      const rings = 2 + Math.round(p.depth * 0.6);
      let radius = reach * (0.1 + crackRand(1) * 0.05);
      for (let ring = 0; ring < rings; ring++) {
        if (front > radius * 1.15) {
          for (let i = 0; i < radials; i++) {
            const j = (i + 1) % radials;
            const keep = crackRand(1);
            const r1 = radius * (0.85 + 0.3 * crackRand(1));
            const r2 = radius * (0.85 + 0.3 * crackRand(1));
            const kink = (crackRand(1) - 0.5) * 0.12;
            if (keep > 0.5 - ring * 0.05 || crackLength[i] < r1 || crackLength[j] < r2) continue;
            alongCrack(i, r1, CRACK_A);
            alongCrack(j, r2, CRACK_B);
            const mx = (CRACK_A.x + CRACK_B.x) / 2;
            const my = (CRACK_A.y + CRACK_B.y) / 2;
            g.moveTo(CRACK_A.x, CRACK_A.y);
            g.lineTo(mx + (cx - mx) * kink, my + (cy - my) * kink);
            g.lineTo(CRACK_B.x, CRACK_B.y);
          }
        }
        radius *= 1.6 + crackRand(1) * 0.4;
      }
      /**
       * Forks: a radial now and then splits, the branch leaving at a shallow
       * angle and running a fraction of the way out. More of them, further
       * out, the more Branching is turned up.
       */
      for (let i = 0; i < radials; i++) {
        for (let f = 0; f < Math.round(p.depth); f++) {
          if (crackRand(1) > 0.45) continue;
          const at = crackLength[i] * (0.25 + crackRand(1) * 0.55);
          if (front <= at) continue;
          alongCrack(i, at, CRACK_A);
          alongCrack(i, at + 4, CRACK_B);
          const heading = Math.atan2(CRACK_B.y - CRACK_A.y, CRACK_B.x - CRACK_A.x) + (crackRand(1) < 0.5 ? -1 : 1) * (0.3 + crackRand(1) * 0.4);
          const run = Math.min(front - at, crackLength[i] * (0.18 + crackRand(1) * 0.25));
          let x = CRACK_A.x;
          let y = CRACK_A.y;
          let h = heading;
          g.moveTo(x, y);
          for (let k = 0; k < 4; k++) {
            h += (crackRand(1) - 0.5) * 0.3;
            x += Math.cos(h) * run * 0.25;
            y += Math.sin(h) * run * 0.25;
            g.lineTo(x, y);
          }
        }
      }
      // The crushed rosette at the strike: a tight star of short cracks.
      const crush = reach * 0.045;
      for (let k = 0; k < 14; k++) {
        const a = crackRand(1) * TAU;
        const r0 = crush * crackRand(1) * 0.4;
        const r1 = crush * (0.6 + crackRand(1) * 0.8);
        g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        g.lineTo(cx + Math.cos(a + 0.2) * r1, cy + Math.sin(a + 0.2) * r1);
      }
      g.stroke();
    }

    /**
     * Glints where the cracks cross, and the hot white heart of the strike.
     * They come and go slowly as the light finds each facet, but every one
     * is a fixed place on the pane, so the twinkle is in the brightness and
     * never in the position.
     */
    const sprite = glassGlint(p.color);
    seedCracks(2, impact);
    let radius = reach * 0.13;
    for (let ring = 0; ring < 3; ring++) {
      for (let i = 0; i < radials; i++) {
        const chance = crackRand(2);
        const phase = crackRand(2) * TAU;
        if (chance > 0.35 || crackLength[i] < radius || front < radius) continue;
        alongCrack(i, radius, CRACK_A);
        const twinkle = 0.55 + 0.45 * Math.sin(t * (1.3 + chance * 2) + phase);
        const size = width * (7 + 7 * twinkle);
        g.globalAlpha = clamp(0.9 * twinkle * fade, 0, 1);
        g.drawImage(sprite, CRACK_A.x - size / 2, CRACK_A.y - size / 2, size, size);
      }
      radius *= 1.75;
    }
    const heart = width * 12;
    g.globalAlpha = clamp(fade, 0, 1);
    g.drawImage(sprite, cx - heart / 2, cy - heart / 2, heart, heart);
    g.globalAlpha = 1;

    // The flash of the blow itself, over in the first third of the spread.
    if (p.flash > 0 && progress < 0.3) {
      const punch = (1 - progress / 0.3) * p.flash;
      const r = reach * 0.5 * (0.3 + progress * 2);
      const grad = g.createRadialGradient(cx, cy, 0, cx, cy, r);
      grad.addColorStop(0, rgba('#ffffff', punch));
      grad.addColorStop(0.3, rgba(p.color, punch * 0.35));
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
