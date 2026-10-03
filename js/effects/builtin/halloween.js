/**
 * Halloween effects.
 *
 * Three things recur in here, and all three are about the same fact: this is
 * light added to a wall at night, not paint.
 *
 * - **Dark is a hole in light.** Anything that should read as a *dark* shape on
 *   the house — a figure at a window, a ghost's eyes, the bottom of a candle —
 *   is cut out of a lit fill with `destination-out` or painted over it, never
 *   drawn in black. Projectors can't emit darkness, so a black silhouette on an
 *   unlit wall is invisible.
 * - **Faint is gone.** The grades every preset ships with have contrast in
 *   them, pivoting round mid grey, and Haunted sends anything in the world
 *   buffer below about 0.14 to black before it reaches the lens. An emitter
 *   that is a whisper — a fog at a tenth of an alpha, a ghost at a quarter —
 *   is not subtle on the night, it is absent. Atmosphere here is optical depth
 *   and real brightness, and where something should be dim it is dim *and
 *   shaped*: lit from one side, falling off from a source, never a flat wash.
 * - **Light has a source.** Emitters have a hot core and a long soft falloff,
 *   hot things take their colour from a temperature, and the shapes that
 *   matter — a flame, a pool of candlelight, an iris — are baked once into
 *   sprites from per-pixel maths and stamped, rather than approximated with a
 *   gradient that can only fall off along a line or a circle.
 *
 * Randomness is seeded per event (per lightning strike, per drip) or per shape
 * (where the candles stand, where a figure stops) so two projectors covering the
 * same wall draw the identical thing.
 */

import { rgba, clamp, lerp, TAU, frac, makeRng, smoothstep } from '../../core/math.js';
import { blackbody, blackbodyBytes, blackbodyCss, mixLinear, srgbToLinear, linearToSrgb } from '../color.js';
import { ensureField } from '../field.js';
import { offscreen, curveThrough } from '../lib.js';

/* ------------------------------------------------------------------ *
 * Light arithmetic for the per-cell loops.
 *
 * The field effects below build their colours a cell at a time, and the
 * colour helpers in color.js speak hex strings — right for a gradient stop,
 * ruinous in a loop that runs a few thousand times a frame. These do the same
 * sums on bare numbers: a colour parsed once into linear light, and a table
 * back to sRGB bytes.
 * ------------------------------------------------------------------ */

/** Parse `#rgb` / `#rrggbb` into `out` as linear-light components, 0..1. */
function linearRgb(hex, out) {
  const h = String(hex || '#000000').replace('#', '').trim();
  const full = h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h;
  const n = parseInt(full.slice(0, 6), 16) || 0;
  out[0] = srgbToLinear(((n >> 16) & 255) / 255);
  out[1] = srgbToLinear(((n >> 8) & 255) / 255);
  out[2] = srgbToLinear((n & 255) / 255);
  return out;
}

const TO_SRGB = new Uint8Array(4097);
for (let i = 0; i <= 4096; i++) TO_SRGB[i] = Math.round(linearToSrgb(i / 4096) * 255);
/** Linear light (clamped to 0..1) to an sRGB byte. */
const srgbByte = (v) => TO_SRGB[v <= 0 ? 0 : v >= 1 ? 4096 : (v * 4096) | 0];

/** Scratch colour, for code that parses one and uses it at once. */
const RGB = [0, 0, 0];

/**
 * `curlNoise`, without the array it returns.
 *
 * The field loops ask for one per cell; a two-element array per cell is
 * thousands of allocations a frame, which is exactly the garbage the effect
 * rules exist to keep out of a projector tab.
 */
const CURL = [0, 0];
function curlAt(noise, x, y, z) {
  const e = 0.35;
  const p1 = noise.noise3(x, y + e, z);
  const p2 = noise.noise3(x, y - e, z);
  const p3 = noise.noise3(x + e, y, z);
  const p4 = noise.noise3(x - e, y, z);
  CURL[0] = (p1 - p2) / (2 * e);
  CURL[1] = -(p3 - p4) / (2 * e);
  return CURL;
}

/** Blackbody at `kelvin`, into `out` as linear light. */
function blackbodyLinear(kelvin, out) {
  const c = blackbody(kelvin);
  out[0] = srgbToLinear(c[0] / 255);
  out[1] = srgbToLinear(c[1] / 255);
  out[2] = srgbToLinear(c[2] / 255);
  return out;
}

/**
 * Bake a sprite a pixel at a time.
 *
 * `shade(u, v, out)` is handed the pixel's centre, 0..1 across and down, and
 * writes linear-light red, green and blue and a coverage into `out`. Stored as
 * sRGB with the coverage as alpha, so the same sprite works stamped with
 * `lighter` — it adds colour × coverage — or laid over something with
 * `source-over`.
 *
 * Every emitter in this file that has a shape worth getting right is drawn
 * this way, once, when its parameters change, and stamped with `drawImage`
 * after that: a gradient can only fall off along a straight line or a circle,
 * and a flame or a pool of candlelight does neither.
 */
const PX = [0, 0, 0, 0];
function bakeSprite(w, h, shade) {
  const canvas = offscreen(w, h);
  const c = canvas.getContext('2d');
  const img = c.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      PX[0] = 0;
      PX[1] = 0;
      PX[2] = 0;
      PX[3] = 0;
      shade((x + 0.5) / w, (y + 0.5) / h, PX);
      const i = (y * w + x) * 4;
      d[i] = srgbByte(PX[0]);
      d[i + 1] = srgbByte(PX[1]);
      d[i + 2] = srgbByte(PX[2]);
      d[i + 3] = Math.round(clamp(PX[3], 0, 1) * 255);
    }
  }
  c.putImageData(img, 0, 0);
  return canvas;
}

/**
 * A candle flame, standing on its wick at the bottom centre of the sprite.
 *
 * Rounded at the foot and drawn out to a point, widest about a quarter of the
 * way up — the teardrop everybody recognises. Its colour is a temperature, not
 * a fill: hottest in a core low in the flame, where it burns near white, and
 * cooling towards the edges and the tip through yellow and orange. A wisp of
 * blue at the very foot, where the vapour first meets the air. Shared by the
 * candles and by anything else here that wants a small naked flame.
 */
function bakeFlame(kelvin) {
  const tmp = [0, 0, 0];
  return bakeSprite(24, 56, (u, v, out) => {
    const x = u * 2 - 1;
    const y = 1 - v;
    const w = y < 0.28
      ? 0.92 * Math.sqrt(Math.max(0, 1 - ((0.28 - y) / 0.28) ** 2))
      : 0.92 * ((1 - y) / 0.72) ** 0.85;
    if (w <= 0.001) return;
    const s = Math.abs(x) / w;
    if (s >= 1) return;
    const core = clamp((1 - s) * 1.35 - Math.abs(y - 0.3) * 1.6, 0, 1);
    blackbodyLinear(kelvin * (0.72 + 1.1 * core), tmp);
    const white = core * core * 0.85;
    out[0] = tmp[0] + (1 - tmp[0]) * white;
    out[1] = tmp[1] + (1 - tmp[1]) * white;
    out[2] = tmp[2] + (1 - tmp[2]) * white;
    if (y < 0.16) {
      const blue = ((0.16 - y) / 0.16) * 0.55;
      out[0] *= 1 - blue;
      out[1] *= 1 - blue * 0.6;
      out[2] = out[2] * (1 - blue) + 0.9 * blue;
    }
    out[3] = smoothstep(1, 0.45, s) * (y > 0.65 ? 1 - ((y - 0.65) / 0.35) * 0.55 : 1);
  });
}

/** A small warm halo for round a flame: a tight core and a long skirt. */
function bakeHalo(kelvin) {
  const tmp = [0, 0, 0];
  const edge = 0.6 * Math.exp(-1 / 0.1) + 0.4 / (1 + 100);
  return bakeSprite(64, 64, (u, v, out) => {
    const r = Math.hypot(u * 2 - 1, v * 2 - 1);
    if (r >= 1) return;
    const I = (0.6 * Math.exp(-(r * r) / 0.1) + 0.4 / (1 + (r / 0.1) ** 2) - edge) / (1 - edge);
    blackbodyLinear(kelvin * (0.85 + 0.45 * Math.sqrt(Math.max(0, I))), tmp);
    out[0] = tmp[0];
    out[1] = tmp[1];
    out[2] = tmp[2];
    out[3] = Math.max(0, I);
  });
}

const bloodDrip = {
  id: 'blood-drip',
  name: 'Blood Drip',
  category: 'halloween',
  scope: 'shape',
  description:
    'Glossy blood running out of a pool along the top edge: stop-start rivulets that meander, beads that glint, a puddle where each one lands.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#6b0008' },
    { key: 'highlight', type: 'color', label: 'Head colour', default: '#c41520' },
    { key: 'count', type: 'range', label: 'Drips', default: 9, min: 1, max: 60, step: 1 },
    { key: 'speed', type: 'range', label: 'Speed', default: 0.16, min: 0.01, max: 2, step: 0.005 },
    { key: 'width', type: 'range', label: 'Thickness', default: 16, min: 1, max: 90, step: 0.5 },
    { key: 'variation', type: 'range', label: 'Variation', default: 0.6, min: 0, max: 1, step: 0.01 },
    { key: 'stickSlip', type: 'range', label: 'Stop-start', default: 0.6, min: 0, max: 1, step: 0.01 },
    { key: 'pool', type: 'range', label: 'Pool at top', default: 0.05, min: 0, max: 0.3, step: 0.005 },
    { key: 'gloss', type: 'range', label: 'Wet sheen', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'droplets', type: 'bool', label: 'Shed droplets', default: true },
    { key: 'fade', type: 'range', label: 'Fade when it lands (s)', default: 2.2, min: 0, max: 10, step: 0.1 },
    { key: 'restart', type: 'bool', label: 'Loop', default: true },
  ],
  init() {
    return { drips: null, count: 0 };
  },
  step({ p, shape, t, dt, rng, state, noise }) {
    const { bbox } = shape;
    if (bbox.h <= 0) return;
    const count = Math.max(1, Math.round(p.count));

    if (state.count !== count) {
      state.count = count;
      state.drips = Array.from({ length: count }, (_, i) => ({
        // Jitter within the column so drips don't look like a comb.
        x: bbox.x + ((i + 0.5) / count + (rng() - 0.5) * 0.6 / count) * bbox.w,
        rate: 1 - p.variation * rng(),
        /** How far down, 0..1. Integrated, never assigned — see below. */
        pos: 0,
        wait: rng() * 4,
        alpha: 1,
        wobble: rng() * 10,
        thickness: 0.6 + rng() * 0.8,
        seed: rng() * 100,
      }));
    }

    for (const drip of state.drips) {
      if (drip.wait > 0) {
        drip.wait -= dt;
        continue;
      }

      /**
       * Down, and only down.
       *
       * Stick-slip used to be a factor multiplying the head's *position*: a
       * noise value either side of one, applied to how far down the wall the
       * bead had got. Which means that when the noise fell, the bead went back
       * up the door. That is the bounce — it was not a wobble on top of a
       * descent, it was a descent that reversed several times a second, and no
       * amount of tuning the amplitude would have fixed it.
       *
       * Surface tension does not lift a drip back up the wall; it holds it
       * still. So the noise now gates the *speed*, is clamped so it can never
       * go negative, and the position is integrated from it. Monotone by
       * construction, however the noise behaves.
       */
      const gate = p.stickSlip > 0
        ? clamp(1 - p.stickSlip * (0.5 + 0.5 * noise.noise2(t * 1.6 + drip.seed, 0)), 0.04, 1)
        : 1;
      // And it accelerates as it goes, because it is falling.
      drip.pos += p.speed * drip.rate * gate * (0.45 + 0.9 * drip.pos) * dt;

      if (drip.pos >= 1) {
        drip.pos = 1;
        // Landed. Fade out where it is, rather than snapping back to the top:
        // the old loop reset the position outright, so every drip vanished from
        // the bottom of the door and reappeared at the top in the same frame.
        if (p.fade > 0) drip.alpha -= dt / p.fade;
        else drip.alpha = 0;
        if (drip.alpha <= 0 && p.restart) {
          drip.pos = 0;
          drip.alpha = 1;
          drip.wait = rng() * 5;
          drip.rate = 1 - p.variation * rng();
          drip.thickness = 0.6 + rng() * 0.8;
          drip.seed = rng() * 100;
        }
      }
    }
  },
  /**
   * Wet, not painted.
   *
   * What makes a red streak read as blood rather than as red is almost
   * entirely the light on it, so that is most of what is drawn:
   *
   * - **The pool** along the top is a band with a ragged lower edge, and where
   *   each drip leaves it the edge sags into a meniscus — the drip is visibly
   *   the pool running out, not a line that starts under a gradient.
   * - **Each rivulet** is shaded like the cylinder of liquid it is: dark at the
   *   edges, where the film is thin and you see the surface through it, rich in
   *   the middle where it is thick, and a narrow specular streak down one side
   *   where it catches the light. Its edges wobble and it thins away from the
   *   pool, because the bead takes the liquid with it and leaves a film.
   * - **The bead** at the front is a teardrop, not a ball: drawn out at the top
   *   where it is still joined to its trail, full at the bottom where its
   *   weight is. A hot glint up one side and a faint one opposite are what say
   *   *wet*.
   * - **Where it lands** it spreads into a puddle along the bottom edge as it
   *   fades, instead of stopping dead in mid-air.
   *
   * As light the darks cannot be darker than the door, so the drama is in the
   * other direction: the body is the head colour, the edges and the film drop
   * back to the base colour, and the highlights go up towards white.
   */
  draw({ g, p, shape, t, state, noise }) {
    const { bbox } = shape;
    if (!(bbox.h > 0 && bbox.w > 0) || !state.drips) return;

    const base = p.color;
    const body = mixLinear(p.color, p.highlight, 0.75);
    const rich = p.highlight;
    const shine = clamp(p.gloss, 0, 1);
    const glint = mixLinear(p.highlight, '#ffffff', 0.7);

    g.save();
    g.clip(shape.path);
    const alpha = g.globalAlpha;

    // The pool, with a meniscus wherever a drip is running out of it.
    const poolH = bbox.h * clamp(p.pool, 0, 0.3);
    if (poolH > 0.5) {
      const steps = clamp(Math.round(bbox.w / 6), 4, BLOOD_EDGE - 2);
      let n = 0;
      for (let s = 0; s <= steps; s++) {
        const x = bbox.x + (s / steps) * bbox.w;
        let sag = 0;
        for (const drip of state.drips) {
          if (drip.wait > 0 || drip.alpha <= 0) continue;
          const w = p.width * drip.thickness;
          const d = (x - drip.x) / Math.max(1, w * 0.9);
          sag += Math.exp(-d * d) * w * 0.55 * drip.alpha;
        }
        BX[n] = x;
        BY[n] = bbox.y + poolH * (0.7 + 0.3 * noise.noise2(x * 0.03, 5.5)) + sag;
        n++;
      }
      const grad = g.createLinearGradient(0, bbox.y, 0, bbox.y + poolH * 1.6);
      grad.addColorStop(0, base);
      grad.addColorStop(0.55, body);
      grad.addColorStop(1, rich);
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(bbox.x - 2, bbox.y - 2);
      g.lineTo(bbox.x + bbox.w + 2, bbox.y - 2);
      g.lineTo(BX[n - 1], BY[n - 1]);
      for (let i = n - 1; i >= 0; i--) {
        BX2[n - 1 - i] = BX[i];
        BY2[n - 1 - i] = BY[i];
      }
      smoothLine(g, BX2, BY2, n, false);
      g.closePath();
      g.fill();
      if (shine > 0) {
        // The lip of the pool catches the light.
        g.strokeStyle = rgba(glint, 0.35 * shine);
        g.lineWidth = Math.max(1, poolH * 0.12);
        g.beginPath();
        for (let i = 0; i < n; i++) {
          BX2[i] = BX[i];
          BY2[i] = BY[i] - poolH * 0.18;
        }
        smoothLine(g, BX2, BY2, n, true);
        g.stroke();
      }
    }

    for (const drip of state.drips) {
      if (drip.wait > 0 || drip.alpha <= 0) continue;

      const headY = bbox.y + drip.pos * bbox.h;
      const w = p.width * drip.thickness;
      const sway = Math.sin(t * 0.5 + drip.wobble) * w * 0.15;
      const top = bbox.y + poolH * 0.6;
      const run = headY - top;
      // Liquid on a door finds its own way down: a slow meander, fixed to the
      // door rather than to the bead, so the trail stays where it ran.
      const wander = (f) => noise.noise2(((top + run * f) - bbox.y) / bbox.h * 2.2 + drip.seed, 9.1) * w * 0.45;
      const lead = drip.x + sway + wander(1);
      g.globalAlpha = alpha * drip.alpha;

      if (headY > top) {
        // The rivulet: thinning from the pool down to the bead, its edges
        // wobbling, and smooth — a curve, not a polygon.
        const steps = 12;
        let n = 0;
        for (let i = 0; i <= steps; i++) {
          const f = i / steps;
          const half = w * (0.38 - 0.16 * f + 0.06 * noise.noise2(f * 4 + drip.seed, 1.7));
          BX[n] = drip.x + sway * f + wander(f) - half;
          BY[n] = lerp(top, headY, f);
          n++;
        }
        for (let i = steps; i >= 0; i--) {
          const f = i / steps;
          const half = w * (0.38 - 0.16 * f + 0.06 * noise.noise2(f * 4 + drip.seed + 33, 2.9));
          BX[n] = drip.x + sway * f + wander(f) + half;
          BY[n] = lerp(top, headY, f);
          n++;
        }
        const mid = drip.x + sway * 0.5 + wander(0.5);
        const across = g.createLinearGradient(mid - w * 0.4, 0, mid + w * 0.4, 0);
        across.addColorStop(0, base);
        across.addColorStop(0.42, body);
        across.addColorStop(0.58, body);
        across.addColorStop(1, base);
        g.fillStyle = across;
        g.beginPath();
        smoothLine(g, BX, BY, n, true);
        g.closePath();
        g.fill();

        if (shine > 0 && headY - top > w) {
          // A specular streak down one side of the film.
          const streak = g.createLinearGradient(0, top, 0, headY);
          streak.addColorStop(0, rgba(glint, 0));
          streak.addColorStop(0.35, rgba(glint, 0.4 * shine));
          streak.addColorStop(1, rgba(glint, 0.15 * shine));
          g.strokeStyle = streak;
          g.lineWidth = Math.max(1, w * 0.09);
          g.lineCap = 'round';
          g.beginPath();
          g.moveTo(drip.x + wander(0) - w * 0.14, top + w * 0.5);
          quadLine(g, drip.x + wander(0) - w * 0.14, top + w * 0.5, mid - w * 0.12, (top + headY) / 2, lead - w * 0.12, headY - w * 0.5);
          g.stroke();
        }
      }

      // Landed: it spreads along the bottom as it fades.
      const landed = drip.pos >= 1 ? 1 - drip.alpha : 0;
      if (landed > 0) {
        const pw = w * (0.7 + landed * 2.2);
        const ph = w * (0.3 + landed * 0.15);
        const px = lead;
        const py = bbox.y + bbox.h - ph * 0.45;
        const puddle = g.createRadialGradient(px - pw * 0.2, py - ph * 0.3, 0, px, py, pw);
        puddle.addColorStop(0, rich);
        puddle.addColorStop(0.7, body);
        puddle.addColorStop(1, base);
        g.fillStyle = puddle;
        g.beginPath();
        g.ellipse(px, py, pw, ph, 0, 0, TAU);
        g.fill();
      }

      // The bead: a teardrop, drawn out where it joins its trail.
      const beadW = w * 0.5;
      const beadH = w * 0.66;
      const bx = lead;
      const by = Math.min(headY, bbox.y + bbox.h - beadH * 0.6 * (1 - landed));
      const bead = g.createRadialGradient(bx - beadW * 0.3, by - beadH * 0.15, 0, bx, by, beadH * 1.1);
      bead.addColorStop(0, mixLinear(rich, '#ffffff', 0.25 * shine));
      bead.addColorStop(0.45, rich);
      bead.addColorStop(0.8, body);
      bead.addColorStop(1, base);
      g.fillStyle = bead;
      g.beginPath();
      g.moveTo(bx - beadW * 0.32, by - beadH * 1.45);
      cubicLine(g, bx - beadW * 0.32, by - beadH * 1.45, bx - beadW * 0.5, by - beadH * 0.6, bx - beadW * 1.05, by - beadH * 0.1, bx - beadW, by + beadH * 0.12);
      cubicLine(g, bx - beadW, by + beadH * 0.12, bx - beadW * 0.95, by + beadH * 0.95, bx + beadW * 0.95, by + beadH * 0.95, bx + beadW, by + beadH * 0.12);
      cubicLine(g, bx + beadW, by + beadH * 0.12, bx + beadW * 1.05, by - beadH * 0.1, bx + beadW * 0.5, by - beadH * 0.6, bx + beadW * 0.32, by - beadH * 1.45);
      g.closePath();
      g.fill();

      if (shine > 0) {
        // The glint that says wet, and a faint bounce off the far side.
        g.fillStyle = rgba(glint, 0.75 * shine);
        g.beginPath();
        g.ellipse(bx - beadW * 0.38, by - beadH * 0.12, beadW * 0.17, beadH * 0.26, -0.3, 0, TAU);
        g.fill();
        g.fillStyle = rgba(glint, 0.22 * shine);
        g.beginPath();
        g.ellipse(bx + beadW * 0.45, by + beadH * 0.4, beadW * 0.12, beadH * 0.14, 0.4, 0, TAU);
        g.fill();
      }

      // Satellite drop: when a bead detaches it leaves a smaller one behind it,
      // trailing a thin thread. Cheap detail, very recognisable.
      if (p.droplets && drip.pos > 0.35) {
        // Chased off the same integrated position, so the satellite runs down
        // the wall with the bead rather than to its own clock.
        const dropPhase = frac(drip.pos * 2.3 + drip.wobble);
        const dropY = bbox.y + dropPhase * bbox.h * 1.1;
        if (dropY > headY + beadH * 2) {
          g.strokeStyle = rgba(base, 0.6);
          g.lineWidth = Math.max(0.6, w * 0.06);
          g.beginPath();
          g.moveTo(bx, headY + beadH);
          g.lineTo(bx, dropY - w * 0.3);
          g.stroke();
          g.fillStyle = body;
          g.beginPath();
          g.ellipse(bx, dropY, w * 0.2, w * 0.28, 0, 0, TAU);
          g.fill();
          if (shine > 0) {
            g.fillStyle = rgba(glint, 0.6 * shine);
            g.beginPath();
            g.ellipse(bx - w * 0.07, dropY - w * 0.08, w * 0.06, w * 0.09, 0, 0, TAU);
            g.fill();
          }
        }
      }
    }
    g.restore();
  },
};

/**
 * Curves for the blood, traced as short straight steps.
 *
 * The same curves `curveThrough`, `quadraticCurveTo` and `bezierCurveTo` would
 * draw, sampled finely enough that the steps are under a pixel or two at these
 * sizes — so they need nothing of a context but `lineTo`, which is all some of
 * the places this effect gets drawn into provide.
 */
function smoothLine(g, xs, ys, n, move) {
  if (n < 1) return;
  if (move) g.moveTo(xs[0], ys[0]);
  else g.lineTo(xs[0], ys[0]);
  let px = xs[0];
  let py = ys[0];
  for (let i = 1; i < n - 1; i++) {
    const ex = (xs[i] + xs[i + 1]) / 2;
    const ey = (ys[i] + ys[i + 1]) / 2;
    quadLine(g, px, py, xs[i], ys[i], ex, ey);
    px = ex;
    py = ey;
  }
  if (n > 1) g.lineTo(xs[n - 1], ys[n - 1]);
}

function quadLine(g, x0, y0, cx, cy, x1, y1) {
  for (let k = 1; k <= CURVE_STEPS; k++) {
    const f = k / CURVE_STEPS;
    const a = (1 - f) * (1 - f);
    const b = 2 * f * (1 - f);
    const c = f * f;
    g.lineTo(a * x0 + b * cx + c * x1, a * y0 + b * cy + c * y1);
  }
}

function cubicLine(g, x0, y0, c1x, c1y, c2x, c2y, x1, y1) {
  for (let k = 1; k <= CURVE_STEPS; k++) {
    const f = k / CURVE_STEPS;
    const u = 1 - f;
    const a = u * u * u;
    const b = 3 * u * u * f;
    const c = 3 * u * f * f;
    const d = f * f * f;
    g.lineTo(a * x0 + b * c1x + c * c2x + d * x1, a * y0 + b * c1y + c * c2y + d * y1);
  }
}

const CURVE_STEPS = 6;

/** Scratch outline for the pool's edge and a rivulet. */
const BLOOD_EDGE = 160;
const BX = new Array(BLOOD_EDGE).fill(0);
const BY = new Array(BLOOD_EDGE).fill(0);
const BX2 = new Array(BLOOD_EDGE).fill(0);
const BY2 = new Array(BLOOD_EDGE).fill(0);

/**
 * When strike `n` begins — its leader setting off — in show time.
 *
 * One strike per slot of `60 / rate` seconds, so the rate is exactly what it
 * says over any stretch of the show; where in its slot each one falls is
 * seeded by its index, so every tab and the soundscape agree. Two things about
 * the placing, both learned from stills that showed nothing:
 *
 * - **Not right at the edges of the slot.** A strike anywhere in its slot lets
 *   two land nearly together and then leaves twenty seconds of nothing, which
 *   at five a minute is a storm that seems to have stopped. Kept off the outer
 *   fifth of each slot, the gaps stay between about four tenths and one and
 *   six tenths of the interval.
 * - **The first one early.** A storm announces itself: the first strike comes
 *   between one and a half and four seconds in, rather than anywhere in the
 *   first slot — which at the preset's rate could be eleven seconds of a dark
 *   sky on the one stretch of show everybody watches, its start.
 */
function strikeStart(n, interval, duration, leader) {
  const slack = Math.max(0, interval - duration - leader);
  const r = makeRng(`when${n}`)();
  if (n === 0) return Math.min(slack, 1.5 + r * 2.5);
  return n * interval + slack * (0.2 + 0.6 * r);
}

const lightning = {
  id: 'lightning',
  name: 'Lightning',
  category: 'halloween',
  scope: 'global',
  description:
    'A stepped leader, then a blinding return stroke down a jagged branching channel and its restrikes, with the sky and the cloud base lit by it. Every projector draws the same bolt.',
  params: [
    { key: 'temperature', type: 'range', label: 'Channel temp (K)', default: 9000, min: 3000, max: 20000, step: 250 },
    { key: 'rate', type: 'range', label: 'Strikes / min', default: 6, min: 0.2, max: 60, step: 0.1 },
    { key: 'flash', type: 'range', label: 'Sky flash', default: 0.55, min: 0, max: 1, step: 0.01 },
    { key: 'bolt', type: 'bool', label: 'Draw bolt', default: true },
    { key: 'thickness', type: 'range', label: 'Channel thickness', default: 5, min: 1, max: 40, step: 0.5 },
    { key: 'branches', type: 'range', label: 'Branching', default: 3, min: 0, max: 5, step: 1 },
    { key: 'flickers', type: 'range', label: 'Return strokes', default: 3, min: 1, max: 8, step: 1 },
    { key: 'duration', type: 'range', label: 'Strike length (s)', default: 0.6, min: 0.05, max: 3, step: 0.01 },
    { key: 'leader', type: 'range', label: 'Leader time (s)', default: 0.09, min: 0, max: 0.5, step: 0.005 },
  ],
  /**
   * When this effect is about to be loud, in show time.
   *
   * The one hook an effect has into the soundscape. Thunder used to rumble on
   * its own timer, which is fine for weather happening somewhere else and
   * completely wrong for a bolt being drawn on the wall in front of you: a clap
   * a quarter-second off its flash is heard as a fault, and one on a separate
   * schedule entirely is heard as two different storms.
   *
   * The control tab asks every sounding layer for the events falling in a short
   * window just ahead of now and hands them to `cue` on the voice, so the audio
   * clock schedules the crack for the exact instant rather than for whichever
   * frame the ask happened on. Everything here comes from `strikeStart`, which
   * is also what `draw` uses, and that is what keeps the two in step.
   */
  cues(p, from, to) {
    const interval = 60 / Math.max(0.2, p.rate);
    const events = [];
    for (let strike = Math.max(0, Math.floor(from / interval)); strike <= Math.floor(to / interval); strike++) {
      // The return stroke, not the leader. The leader is the dim flicker on the
      // way down, and it is silent — the bang is the channel connecting.
      const at = strikeStart(strike, interval, p.duration, p.leader) + p.leader;
      if (at < from || at >= to) continue;
      // Zero distance: this is a strike on your own house, so the crack and the
      // rumble arrive together. The sky flash is how big the strike looks, so
      // it is also how loud it should be.
      events.push({ at, level: clamp(0.6 + p.flash * 0.4, 0, 1), distance: 0 });
    }
    return events;
  },
  /**
   * The strike itself.
   *
   * A real flash is a sequence, and modelling it is most of what separates
   * this from a white flicker: a dim, stuttering stepped leader feeling its way
   * down, a blinding return stroke back up the channel it found, then a few
   * weaker restrikes down the same channel, each a sharp attack and a fast
   * decay.
   *
   * The channel is built by midpoint displacement — each straight piece split
   * and its middle pushed sideways by a fraction of its own length, over and
   * over — which is what gives lightning its jaggedness at every scale: a kink
   * every few metres and a wander over the whole length, never a smooth curve
   * and never a zigzag of equal teeth. Branches leave the upper part of the
   * channel heading on down and out, built the same way at a smaller size, and
   * fade and thin towards their tips, where the leader that made them ran out
   * of charge.
   *
   * Drawn as light, five passes deep: two wide violet glows — the air round
   * the arc, and what a camera makes of a bolt — a tighter one, the channel,
   * and a white core. The sky flash is added, never painted: a flash brightens
   * everything under it, lit windows included, and the old one laid a
   * translucent wash over the scene that dimmed whatever was brighter than it.
   * The cloud base above the strike lights up in soft lumps, which is the storm
   * overhead.
   */
  draw({ g, p, world, t }) {
    const interval = 60 / Math.max(0.2, p.rate);
    const strike = Math.floor(t / interval);
    if (strike < 0) return;
    const local = t - strikeStart(strike, interval, p.duration, p.leader);
    if (local < 0 || local > p.duration + p.leader) return;

    const inLeader = local < p.leader;
    let intensity;
    let reach = 1;
    if (inLeader) {
      const f = p.leader > 0 ? local / p.leader : 1;
      // The leader is faint and steps downward, so only part of the channel is lit.
      reach = clamp(f, 0.05, 1);
      intensity = 0.1 + 0.14 * makeRng(`lead${strike}-${Math.floor(f * 9)}`)();
    } else {
      const phase = (local - p.leader) / Math.max(0.01, p.duration);
      const flickers = Math.max(1, Math.round(p.flickers));
      const sub = Math.floor(phase * flickers);
      const subPhase = frac(phase * flickers);
      // Each return stroke is a sharp attack and a fast decay, not a square gate.
      const stroke = Math.exp(-subPhase * 4.5);
      // Later strokes are weaker.
      const decay = Math.pow(1 - phase, 1.3);
      // Between strokes the channel does not go out: a continuing current
      // keeps it glowing, dimmer, for the length of the flash. Without it the
      // bolt was dark for two thirds of its own strike, and so was almost
      // every still that landed inside one.
      const continuing = 0.42 * Math.pow(1 - phase, 0.7);
      intensity = continuing + (1 - continuing) * stroke * decay * (0.6 + 0.4 * makeRng(`f${strike}-${sub}`)());
    }
    if (intensity <= 0.005) return;

    // The channel is hot enough to be blue-white. The glow round it is pushed
    // towards violet — what nitrogen in the air emits, and the colour every
    // photograph of lightning has round the core. The sky it lights is the same
    // light scattered, so bluer than the channel, never warmer.
    const channel = blackbodyCss(p.temperature);
    const glowColour = mixLinear(blackbodyCss(p.temperature * 1.2), '#8a5cff', 0.6);
    const skyGlow = mixLinear(blackbodyCss(p.temperature * 1.15), '#6f7dff', 0.2);

    const rng = makeRng(`bolt${strike}`);
    const x0 = (0.12 + rng() * 0.76) * world.w;
    const x1 = x0 + (rng() - 0.5) * world.w * 0.45;
    const y1 = world.h * (0.78 + rng() * 0.3);

    g.save();
    g.globalCompositeOperation = 'lighter';
    const alpha = g.globalAlpha;

    if (p.flash > 0) {
      const peak = intensity * p.flash;
      // The whole scene lifts a little...
      g.globalAlpha = alpha * clamp(peak * 0.2, 0, 1);
      g.fillStyle = skyGlow;
      g.fillRect(0, 0, world.w, world.h);
      // ...the sky near the strike a lot...
      const sky = g.createRadialGradient(x0, 0, 0, x0, 0, world.h * 1.3);
      sky.addColorStop(0, rgba(skyGlow, 1));
      sky.addColorStop(0.3, rgba(skyGlow, 0.38));
      sky.addColorStop(1, rgba(skyGlow, 0));
      g.globalAlpha = alpha * clamp(peak * 0.75, 0, 1);
      g.fillStyle = sky;
      g.fillRect(0, 0, world.w, world.h);
      // ...and the cloud base it came out of lights up in lumps.
      const clouds = makeRng(`cloud${strike}`);
      for (let k = 0; k < 4; k++) {
        const cx = x0 + (clouds() - 0.5) * world.w * 0.6;
        const cy = world.h * (0.02 + clouds() * 0.1);
        const cr = world.w * (0.1 + clouds() * 0.12);
        g.globalAlpha = alpha * clamp(peak * (0.4 + clouds() * 0.5), 0, 1);
        // Flattened by the transform rather than drawn as an ellipse, so the
        // gradient flattens with it and fades all the way out at the edge.
        g.save();
        g.translate(cx, cy);
        g.scale(1, 0.45);
        const lump = g.createRadialGradient(0, 0, 0, 0, 0, cr);
        lump.addColorStop(0, rgba(skyGlow, 0.55));
        lump.addColorStop(0.5, rgba(skyGlow, 0.18));
        lump.addColorStop(1, rgba(skyGlow, 0));
        g.fillStyle = lump;
        g.beginPath();
        g.arc(0, 0, cr, 0, TAU);
        g.fill();
        g.restore();
      }
    }

    if (p.bolt) {
      g.lineCap = 'round';
      g.lineJoin = 'round';
      const span = Math.hypot(x1 - x0, y1);
      const reachY = reach * y1;
      // The main channel.
      const n = boltPath(BOLT, 0, x0, -world.h * 0.02, x1, y1, 6, 0.24, rng);
      strokeBolt(g, BOLT, 0, n, reachY, p.thickness, intensity * alpha, 1, channel, glowColour);

      // Branches off the upper three quarters, and twigs off those.
      const count = clamp(Math.round(p.branches), 0, 5);
      const heading = Math.atan2(y1, x1 - x0);
      for (let b = 0; b < count; b++) {
        const at = Math.floor((0.08 + rng() * 0.62) * (n - 1));
        const bx = BOLT.x[at];
        const by = BOLT.y[at];
        const side = rng() < 0.5 ? -1 : 1;
        const angle = heading + side * (0.35 + rng() * 0.55);
        const length = span * (0.16 + rng() * 0.3) * (1 - at / n * 0.5);
        const ex = bx + Math.cos(angle) * length;
        const ey = by + Math.abs(Math.sin(angle)) * length;
        const m = boltPath(TWIG, 0, bx, by, ex, ey, 5, 0.26, rng);
        strokeBolt(g, TWIG, 0, m, reachY, p.thickness * 0.5, intensity * alpha, 0.7, channel, glowColour, true);
        const twigs = count >= 4 ? 2 : count >= 2 ? 1 : 0;
        for (let k = 0; k < twigs; k++) {
          const tat = Math.floor((0.15 + rng() * 0.5) * (m - 1));
          const tx = TWIG.x[tat];
          const ty = TWIG.y[tat];
          const ta = angle + (rng() < 0.5 ? -1 : 1) * (0.3 + rng() * 0.5);
          const tl = length * (0.25 + rng() * 0.3);
          const q = boltPath(SPRIG, 0, tx, ty, tx + Math.cos(ta) * tl, ty + Math.abs(Math.sin(ta)) * tl, 4, 0.28, rng);
          strokeBolt(g, SPRIG, 0, q, reachY, p.thickness * 0.3, intensity * alpha, 0.5, channel, glowColour, true);
        }
      }
    }
    g.restore();
  },
};

/** Scratch polylines for the channel, a branch and a twig. */
const BOLT = { x: new Array(80).fill(0), y: new Array(80).fill(0) };
const TWIG = { x: new Array(40).fill(0), y: new Array(40).fill(0) };
const SPRIG = { x: new Array(24).fill(0), y: new Array(24).fill(0) };

/**
 * A jagged channel from (ax, ay) to (bx, by), by `levels` rounds of midpoint
 * displacement, written into `out` from index `n`. Returns the new count.
 * Each round pushes the middle of every piece sideways by up to `rough` of
 * that piece's own length, so the kinks are in proportion at every scale.
 */
function boltPath(out, n, ax, ay, bx, by, levels, rough, rng) {
  out.x[n] = ax;
  out.y[n] = ay;
  return boltSplit(out, n + 1, ax, ay, bx, by, levels, rough, rng);
}

function boltSplit(out, n, ax, ay, bx, by, level, rough, rng) {
  if (level <= 0) {
    out.x[n] = bx;
    out.y[n] = by;
    return n + 1;
  }
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const off = (rng() * 2 - 1) * rough * len;
  const mx = (ax + bx) / 2 - (dy / len) * off;
  const my = (ay + by) / 2 + (dx / len) * off;
  n = boltSplit(out, n, ax, ay, mx, my, level - 1, rough, rng);
  return boltSplit(out, n, mx, my, bx, by, level - 1, rough, rng);
}

/**
 * Stroke one channel in its passes, cut off below `reachY` while the leader is
 * still on its way down. A branch thins and fades along its length in three
 * steps, because Canvas cannot vary a line's width along a path. `intensity`
 * carries the layer's own opacity in with the strike's.
 */
function strokeBolt(g, path, from, to, reachY, thickness, intensity, weight, channel, glow, taper = false) {
  let end = to;
  for (let i = from + 1; i < to; i++) {
    if (path.y[i] > reachY) {
      end = i;
      break;
    }
  }
  if (end - from < 2) return;
  const pieces = taper ? 3 : 1;
  const per = Math.ceil((end - from) / pieces);
  for (let piece = 0; piece < pieces; piece++) {
    const a = from + piece * per;
    const b = Math.min(end, a + per + 1);
    if (b - a < 2) break;
    const fade = taper ? 1 - piece * 0.3 : 1;
    const w = thickness * (taper ? 1 - piece * 0.28 : 1);
    const lit = intensity * weight * fade;
    for (const [width, opacity, colour] of BOLT_PASSES) {
      g.strokeStyle = colour === 0 ? glow : colour === 1 ? channel : '#ffffff';
      g.globalAlpha = clamp(lit * opacity, 0, 1);
      g.lineWidth = Math.max(0.6, w * width);
      g.beginPath();
      g.moveTo(path.x[a], path.y[a]);
      for (let i = a + 1; i < b; i++) g.lineTo(path.x[i], path.y[i]);
      g.stroke();
    }
  }
}

/** Width multiple, opacity and colour (0 glow, 1 channel, 2 white) per pass. */
const BOLT_PASSES = [
  [15, 0.05, 0],
  [6, 0.09, 0],
  [2.6, 0.22, 0],
  [1.3, 0.8, 1],
  [0.55, 2.2, 2],
];

const fire = {
  id: 'fire',
  name: 'Fire',
  category: 'halloween',
  scope: 'shape',
  description:
    'Volumetric flame with blackbody colour: tongues licking up from a white-hot root and cooling to deep red at the tips, the glow it throws, and sparks streaking off it.',
  params: [
    { key: 'coreTemp', type: 'range', label: 'Core temperature (K)', default: 2100, min: 900, max: 4000, step: 25 },
    { key: 'tipTemp', type: 'range', label: 'Tip temperature (K)', default: 1050, min: 800, max: 2600, step: 25 },
    { key: 'height', type: 'range', label: 'Flame height', default: 0.8, min: 0.1, max: 1.5, step: 0.01 },
    { key: 'width', type: 'range', label: 'Flame width', default: 0.42, min: 0.05, max: 1.2, step: 0.01 },
    { key: 'speed', type: 'range', label: 'Speed', default: 1, min: 0.05, max: 4, step: 0.05 },
    { key: 'turbulence', type: 'range', label: 'Turbulence', default: 0.55, min: 0, max: 2, step: 0.01 },
    { key: 'detail', type: 'range', label: 'Detail', default: 56, min: 16, max: 130, step: 2 },
    { key: 'intensity', type: 'range', label: 'Intensity', default: 1, min: 0, max: 2, step: 0.01 },
    { key: 'wander', type: 'range', label: 'Base wander', default: 0.35, min: 0, max: 1, step: 0.01 },
    { key: 'sparks', type: 'range', label: 'Sparks', default: 40, min: 0, max: 400, step: 5 },
    { key: 'downward', type: 'bool', label: 'Burn downward', default: false },
  ],
  init() {
    return { parts: [], count: 0 };
  },
  /**
   * The sparks, and only the sparks.
   *
   * The flame itself is a density field sampled from noise at time `t` — a pure
   * function, identical in every tab, with nothing to carry between frames.
   * These are the one part that genuinely is discrete, and so the one part that
   * had to move here.
   */
  step({ p, shape, t, dt, rng, state, noise }) {
    const { bbox } = shape;
    if (bbox.w <= 2 || bbox.h <= 2) return;
    if (!(p.sparks > 0)) {
      state.parts.length = 0;
      return;
    }

    const target = Math.round(p.sparks);
    const spawn = (part = {}) => {
      part.x = bbox.cx + (rng() - 0.5) * bbox.w * p.width;
      part.y = p.downward ? bbox.y : bbox.y + bbox.h;
      part.vx = (rng() - 0.5) * bbox.w * 0.12;
      part.vy = (p.downward ? 1 : -1) * bbox.h * (0.25 + rng() * 0.4);
      part.life = 0.6 + rng() * 1.4;
      part.age = rng() * part.life;
      part.seed = rng() * 100;
      return part;
    };
    while (state.parts.length < target) state.parts.push(spawn({}));
    if (state.parts.length > target) state.parts.length = target;

    const step = dt * p.speed;
    for (const part of state.parts) {
      part.age += step;
      if (part.age >= part.life) {
        spawn(part);
        part.age = 0;
      }
      const turb = noise.noise3(part.x * 0.006, part.y * 0.006, t * 0.6 + part.seed);
      // Where it was a step ago, so `draw` can streak it back along its path.
      part.lx = part.x;
      part.ly = part.y;
      part.x += (part.vx + turb * bbox.w * 0.35) * step;
      part.y += part.vy * step;
      // Sparks decelerate as they rise, then fall back.
      part.vy *= 1 - 0.9 * step;
    }
  },
  /**
   * The flame is a density field sampled on a coarse grid, not a cloud of
   * sprites. Sprites read as discs no matter how they are blurred; a field
   * gives connected tongues that split and rejoin the way flame actually does.
   *
   * Three things it did not do, which are most of why it read as a fireball
   * rather than a fire:
   *
   * - **Tongues.** Flame is buoyant: it goes up in licks that are taller than
   *   they are wide, and only the tips curl. The noise is stretched upright to
   *   match, and the sideways warp — which was rolling the whole flame over
   *   like smoke — is pulled back to something that bends a tongue rather than
   *   folding the fire.
   * - **A white-hot root.** The densest part, low down, burns hotter than the
   *   blackbody ramp alone reaches on a projector; it is pushed towards white,
   *   which is the one bit of a real fire you cannot look at.
   * - **Light.** A fire lights the room it is in. A soft spill of its own colour
   *   sits behind it and breathes with the flames, so the window glows rather
   *   than having a flame stuck to it.
   *
   * Sparks are streaks now, drawn back along the way they were going over about
   * a thirtieth of a second — what a spark looks like to an eye or a camera.
   */
  draw({ g, p, stable, shape, t, state, noise }) {
    const { bbox } = shape;
    if (!(bbox.w > 2 && bbox.h > 2)) return;

    // Sized from `stable`, so a modulated Detail does not reallocate the field.
    const cols = clamp(Math.round(stable?.detail ?? p.detail), 8, 200);
    const rows = clamp(Math.round((cols * bbox.h) / bbox.w), 8, 300);
    const field = ensureField(state, 'field', cols, rows);
    field.clear();

    const scroll = t * p.speed;
    // The root of a fire never sits still; without this the base looks welded on.
    const baseWander = noise.noise2(t * 0.6, 0) * 0.12 * p.wander;
    const height = Math.max(0.05, p.height);
    const intensity = clamp(p.intensity, 0, 2);
    let heat = 0;

    for (let y = 0; y < rows; y++) {
      const v = (y + 0.5) / rows;
      // 0 at the base, 1 at the tip, whichever way it burns.
      const hh = p.downward ? v : 1 - v;
      if (hh > height * 1.35) continue;

      // Flame narrows and leans as it rises.
      const taper = Math.max(0.05, 1 - hh * 0.7);
      const halfWidth = p.width * 0.5 * taper;
      const root = clamp(1 - (hh * 1.6) / height, 0, 1);

      for (let x = 0; x < cols; x++) {
        const u = (x + 0.5) / cols;
        const dx = (u - 0.5 - baseWander * hh) / Math.max(0.02, halfWidth);
        if (dx * dx > 6) continue;

        // Gaussian column profile — a hard-edged flame looks like a triangle.
        const profile = Math.exp(-dx * dx * 1.6);

        // Domain warp: enough to bend a tongue, not enough to roll the fire.
        const warpX = noise.noise3(u * 2.2, hh * 1.4 - scroll * 0.35, 11.3) * p.turbulence * 0.22;
        const warpY = noise.noise3(u * 2.0 + 5.1, hh * 1.6 - scroll * 0.4, 3.7) * p.turbulence * 0.2;

        // Two octaves of upward-scrolling detail, stretched upright so their
        // peaks are tongues. More would be wasted at this resolution.
        const n1 = noise.noise3((u + warpX) * 6.5, (hh + warpY) * 2.2 - scroll, scroll * 0.25);
        const n2 = noise.noise3((u + warpX) * 13, (hh + warpY) * 4.6 - scroll * 1.6, scroll * 0.4);
        const detail = 0.5 + 0.38 * n1 + 0.18 * n2;

        // Fuel runs out with height; subtracting a height term is what lets the
        // tip break into detached pockets instead of fading as a solid block.
        const fuel = profile * Math.pow(Math.max(0, 1 - hh / height), 0.75);
        let density = fuel * detail * 1.9 - hh * 0.28;
        if (density <= 0.02) continue;
        density = clamp(density, 0, 1);
        heat += density;

        // Temperature is highest where the flame is densest and lowest at the
        // tips, which is why the colour ramp comes out right without a palette.
        const kelvin = lerp(p.tipTemp, p.coreTemp, clamp(density * 1.25 - hh * 0.35, 0, 1));
        const [r, gg, b] = blackbodyBytes(kelvin);
        const white = clamp((density - 0.6) * 2.4, 0, 1) * root * 0.8;
        // A flame has a front — a thin sheet where it burns — not a fog
        // round it, so opacity rises steeply rather than with the density:
        // the faint fringe drops out and the tongues get their edges.
        const cover = smoothstep(0.04, 0.42, density);
        field.set(
          x, y,
          r + (255 - r) * white, gg + (255 - gg) * white, b + (255 - b) * white,
          cover * intensity
        );
      }
    }

    g.save();
    g.clip(shape.path);
    // Additive, because flame emits light rather than covering what is behind it.
    g.globalCompositeOperation = 'lighter';
    const alpha = g.globalAlpha;

    // The light it throws, behind the flames, breathing with them.
    const spill = fireSpill(state, stable ?? p);
    const amount = clamp(heat / Math.max(1, cols * rows * 0.08), 0, 1.5);
    const sr = Math.max(bbox.w * p.width * 1.6, bbox.h * height * 1.1);
    const sx = bbox.cx;
    const sy = p.downward ? bbox.y + bbox.h * height * 0.35 : bbox.y + bbox.h * (1 - height * 0.35);
    g.globalAlpha = alpha * clamp(0.45 * amount * intensity, 0, 1);
    g.drawImage(spill, sx - sr, sy - sr, sr * 2, sr * 2);

    g.globalAlpha = alpha;
    field.blit(g, bbox.x, bbox.y, bbox.w, bbox.h);

    // Sparks are the one part that genuinely is discrete, so they stay
    // particles — streaked back along their last step and a half.
    if (p.sparks > 0 && state.parts.length) {
      g.lineCap = 'round';
      for (const part of state.parts) {
        const f = clamp(part.age / part.life, 0, 1);
        // A spark cools as it flies: white-hot down to a dull red.
        const kelvin = lerp(2600, 1000, f);
        g.lineWidth = Math.max(1, bbox.w * 0.005 * (1 - f * 0.5));
        g.globalAlpha = alpha * (1 - f) * 0.95;
        g.strokeStyle = blackbodyCss(kelvin);
        const lx = part.lx ?? part.x;
        const ly = part.ly ?? part.y;
        g.beginPath();
        g.moveTo(part.x, part.y);
        g.lineTo(part.x + (lx - part.x) * 2.5, part.y + (ly - part.y) * 2.5);
        g.stroke();
      }
    }
    g.restore();
  },
};

/** The glow a fire throws round itself, baked per core temperature. */
function fireSpill(state, base) {
  const kelvin = clamp(Number(base.coreTemp) || 2100, 900, 4000);
  if (state.spillKey === kelvin) return state.spill;
  const tmp = [0, 0, 0];
  const edge = 1 / (1 + 1 / 0.09);
  state.spill = bakeSprite(64, 64, (u, v, out) => {
    const r = Math.hypot(u * 2 - 1, v * 2 - 1);
    if (r >= 1) return;
    const I = (1 / (1 + (r * r) / 0.09) - edge) / (1 - edge);
    blackbodyLinear(kelvin * (0.75 + 0.2 * I), tmp);
    out[0] = tmp[0];
    out[1] = tmp[1];
    out[2] = tmp[2];
    out[3] = I;
  });
  state.spillKey = kelvin;
  return state.spill;
}

/**
 * Candles on the sill, seen from the street.
 *
 * The old one filled the window with orange and put a radial hotspot in the
 * middle of it, which is a lit rectangle: the light was a property of the glass
 * rather than of anything behind it. What you actually see through a
 * candlelit window is a room lit from *below* — a few small flames standing on
 * the sill, a pool of warm light round them on whatever is behind, and the top
 * of the window and its corners falling away into the dark because nothing up
 * there is lit. So that is what is drawn, in that order:
 *
 * - **The room**, a dim fill that is warmest at the bottom and darkest in the
 *   top corners, in the Shadow colour where no candle reaches.
 * - **A pool of light per candle**, centred just above its flame, added rather
 *   than painted. It falls off like a small source does — a bright core and a
 *   long skirt, inverse-square with a soft centre — and its colour falls with
 *   it: near white-yellow right by the flame, through the candle's own orange,
 *   to a deep red at the fringe where there is hardly any light left. That is
 *   blackbody colour driven by brightness, and it is most of why it reads as
 *   firelight rather than as an orange gel.
 * - **The candles**, wax columns of different heights glowing at the top where
 *   the flame lights them through, and darker than the wall behind lower
 *   down — a candle in front of its own light.
 * - **The flames**, small and bright with a near-white core, each with a halo
 *   for the bloom to work on. They are what tells you from across the road
 *   that this is candlelight and not a lamp.
 *
 * Each candle flickers on its own, a slow wander with sharper dips; a draught
 * catches every candle in the window at once, leans the flames and pulls the
 * light down. When a flame dips it also cools, so the room reddens as it
 * gutters rather than just dimming. Everything with a shape is baked once and
 * stamped, so a frame is a handful of `drawImage` calls per window.
 */
const candle = {
  id: 'candle',
  name: 'Candle Flicker',
  category: 'halloween',
  scope: 'shape',
  description:
    'Candles on the sill behind the glass: small bright flames, warm light pooling low in the window and falling away to the corners, reddening as they gutter.',
  params: [
    { key: 'temperature', type: 'range', label: 'Temperature (K)', default: 1850, min: 1200, max: 3200, step: 25 },
    { key: 'shadow', type: 'color', label: 'Shadow', default: '#2a0d00' },
    { key: 'level', type: 'range', label: 'Brightness', default: 0.85, min: 0, max: 1.5, step: 0.01 },
    { key: 'jitter', type: 'range', label: 'Flicker depth', default: 0.35, min: 0, max: 1, step: 0.01 },
    { key: 'rate', type: 'range', label: 'Flicker speed', default: 3.5, min: 0.2, max: 20, step: 0.1 },
    { key: 'gust', type: 'range', label: 'Gusts', default: 0.25, min: 0, max: 1, step: 0.01 },
    { key: 'hotspot', type: 'range', label: 'Hotspot', default: 0.6, min: 0, max: 1, step: 0.01 },
    { key: 'candles', type: 'range', label: 'Candles on the sill', default: 3, min: 0, max: 6, step: 1 },
  ],
  draw({ g, p, stable, shape, t, noise, state }) {
    const { bbox } = shape;
    if (!(bbox.w > 2 && bbox.h > 2)) return;
    const base = stable ?? p;
    const sprites = candleSprites(state, base);
    const items = candleLayout(state, shape, Math.round(base.candles ?? 3));
    const n = items.length;

    const h = bbox.h;
    const sill = bbox.y + h * 0.985;
    const seed0 = items.seed;

    // A draught takes every candle in the window at once: the light dips and
    // the flames lean away from it.
    const gustField = noise.noise2(t * 0.35 + seed0, 41.1);
    const gust = p.gust > 0 && gustField > 0.55 ? 1 - p.gust * ((gustField - 0.55) / 0.45) : 1;
    const lean = (1 - gust) * 1.6 * (noise.noise2(t * 0.2 + seed0, 7.7) > 0 ? 1 : -1);

    // Each flame's own flicker. Real candle flicker is not white noise: mostly
    // a slow wander, with occasional sharp dips as the flame is pulled about,
    // so the fast and slow parts are weighted very differently.
    let total = 0;
    const lights = Math.max(1, n);
    for (let k = 0; k < lights; k++) {
      const s = n ? items[k].seed : seed0;
      const fast = noise.noise2(t * p.rate + s, 0);
      const slow = noise.noise2(t * p.rate * 0.13 + s, 11.3);
      const lv = clamp(p.level * (1 + p.jitter * (fast * 0.7 + slow * 0.3)) * gust, 0, 2);
      CANDLE_LEVEL[k] = lv;
      CANDLE_FAST[k] = fast;
      total += lv;
    }
    const average = total / lights;
    if (average <= 0.005) return;

    g.save();
    g.clip(shape.path);
    const alpha = g.globalAlpha;

    // The room. Painted, not added: the window is whatever the room is.
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = alpha * clamp(average / Math.max(0.05, p.level), 0, 1);
    g.drawImage(sprites.room, bbox.x, bbox.y, bbox.w, bbox.h);

    // The pools of light, added. Wider and flatter as the hotspot comes down.
    g.globalCompositeOperation = 'lighter';
    const R = h * lerp(1.7, 0.72, clamp(p.hotspot, 0, 1));
    const share = 0.7 / Math.sqrt(lights);
    for (let k = 0; k < lights; k++) {
      const lv = CANDLE_LEVEL[k];
      if (lv <= 0.005) continue;
      const it = n ? items[k] : null;
      const cx = bbox.x + bbox.w * (it ? it.x : 0.5);
      const cy = it ? sill - h * it.height - h * 0.05 : sill - h * 0.12;
      // A guttering flame cools, so the light reddens as it dips. The ladder
      // was baked either side of the set temperature; pick the nearest rung.
      const kelvin = p.temperature * (0.78 + 0.22 * clamp(lv / Math.max(0.01, p.level), 0, 1.4));
      const rung = clamp(Math.round((kelvin / Math.max(1, base.temperature) - CANDLE_LADDER[0]) / CANDLE_LADDER_STEP), 0, CANDLE_LADDER.length - 1);
      g.globalAlpha = alpha * clamp(lv * share, 0, 1);
      g.drawImage(sprites.pools[rung], cx - R, cy - R, R * 2, R * 2);
    }

    if (n) {
      // The candles, in front of their own light.
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = alpha;
      const girth = Math.min(h * 0.07, (bbox.w * 0.7) / (n + 1));
      for (const it of items) {
        const bw = Math.max(2, girth * it.width);
        const bh = h * it.height;
        g.drawImage(sprites.wax, bbox.x + bbox.w * it.x - bw / 2, sill - bh, bw, bh);
      }

      // Halos, then the flames themselves.
      g.globalCompositeOperation = 'lighter';
      const flameH = clamp(h * 0.105, 6, 70);
      for (let k = 0; k < n; k++) {
        const it = items[k];
        const lv = CANDLE_LEVEL[k];
        if (lv <= 0.005) continue;
        const fx = bbox.x + bbox.w * it.x;
        const fy = sill - h * it.height - flameH * 0.08;
        // The flame stretches as it brightens and shrinks as it dips.
        const fh = flameH * it.flame * (0.8 + 0.28 * (0.5 + 0.5 * CANDLE_FAST[k])) * Math.sqrt(clamp(lv / Math.max(0.05, p.level), 0.2, 1.3));
        const fw = fh * 0.42;
        const hr = fh * 2.4;
        g.globalAlpha = alpha * clamp(lv * 0.75, 0, 1);
        g.drawImage(sprites.halo, fx - hr, fy - fh * 0.45 - hr, hr * 2, hr * 2);
        // A small sway of its own, and the draught's lean on top.
        const sway = noise.noise2(t * p.rate * 0.45 + it.seed, 77.7) * 0.12 + lean * 0.35;
        g.globalAlpha = alpha * clamp(0.55 + lv * 0.5, 0, 1);
        g.save();
        g.translate(fx, fy);
        g.transform(1, 0, -sway, 1, 0, 0);
        g.drawImage(sprites.flame, -fw / 2, -fh, fw, fh);
        g.restore();
      }
    }
    g.restore();
  },
};

/** Rungs of colour temperature the light pools are baked at, around the set one. */
const CANDLE_LADDER = [0.78, 0.86, 0.94, 1.02, 1.1];
const CANDLE_LADDER_STEP = 0.08;
/** Per-candle scratch for one frame — at most six candles, or one hidden one. */
const CANDLE_LEVEL = new Array(8).fill(0);
const CANDLE_FAST = new Array(8).fill(0);

/**
 * Where the candles stand, decided once per window and remembered.
 *
 * Seeded from the shape, so every window gets its own arrangement and every
 * tab agrees on it. Fewer in a narrow window: three candles in a landing
 * window a foot wide is a crowd. Heights, girths and flame sizes all vary — a
 * row of identical candles is a row of copies.
 */
function candleLayout(state, shape, wanted) {
  const { bbox } = shape;
  const count = clamp(wanted, 0, 6);
  const key = `${shape.id}|${count}|${Math.round(bbox.w)}|${Math.round(bbox.h)}`;
  if (state.layoutKey === key) return state.layout;
  const rng = makeRng(`candle:${shape.id}:${count}`);
  const n = count <= 0 ? 0 : clamp(Math.round((count * bbox.w) / (bbox.h * 1.6)), 1, count);
  const items = [];
  for (let k = 0; k < n; k++) {
    items.push({
      // Spaced at the middles of equal shares of the sill, which on a window
      // of two or three lights is the middle of each pane rather than behind
      // a glazing bar, give or take a little.
      x: (k + 0.5) / n + (rng() - 0.5) * (0.16 / n),
      height: 0.11 + rng() * 0.2,
      width: 0.8 + rng() * 0.4,
      flame: 0.88 + rng() * 0.25,
      seed: rng() * 1000,
    });
  }
  items.seed = rng() * 1000;
  state.layout = items;
  state.layoutKey = key;
  return items;
}

/**
 * The candle's sprites, baked from the base parameters and kept until one of
 * them changes: the room, a ladder of light pools across a span of colour
 * temperature, a flame, a halo and a stick of wax.
 */
function candleSprites(state, base) {
  const kelvin = clamp(Number(base.temperature) || 1850, 1000, 4000);
  const key = `${kelvin}|${base.shadow}`;
  if (state.spriteKey === key) return state.sprites;
  const tmp = [0, 0, 0];
  const shadow = linearRgb(base.shadow, [0, 0, 0]);
  const warm = blackbodyLinear(kelvin * 0.9, [0, 0, 0]);

  // The room: lit from the sill, so warmest along the bottom and darkest in
  // the top corners.
  const room = bakeSprite(48, 48, (u, v, out) => {
    const vert = 0.06 + 0.94 * v ** 1.8;
    const horiz = 1 - 0.6 * Math.abs(u * 2 - 1) ** 2.4;
    const I = vert * horiz;
    out[0] = shadow[0] + warm[0] * I * 0.22;
    out[1] = shadow[1] + warm[1] * I * 0.22;
    out[2] = shadow[2] + warm[2] * I * 0.22;
    out[3] = 1;
  });

  // One pool of light, inverse-square with a soft core, its colour falling
  // with its brightness.
  const core = 0.26;
  const edge = 1 / (1 + 1 / (core * core));
  const pools = CANDLE_LADDER.map((rung) => bakeSprite(128, 128, (u, v, out) => {
    const r = Math.hypot(u * 2 - 1, v * 2 - 1);
    if (r >= 1) return;
    const I = (1 / (1 + (r / core) ** 2) - edge) / (1 - edge);
    blackbodyLinear(kelvin * rung * (0.7 + 0.55 * Math.sqrt(I)), tmp);
    out[0] = tmp[0];
    out[1] = tmp[1];
    out[2] = tmp[2];
    out[3] = I;
  }));

  // Wax: glowing where the flame shines through the top, darker below, and
  // rounded across like the cylinder it is.
  const waxLit = blackbodyLinear(kelvin * 1.15, [0, 0, 0]);
  const wax = bakeSprite(16, 64, (u, v, out) => {
    const x = u * 2 - 1;
    const y = 1 - v;
    const glowTop = smoothstep(0.55, 1, y) ** 2;
    const b = (0.06 + 1.1 * glowTop) * (1 - 0.5 * x * x);
    out[0] = waxLit[0] * b + shadow[0];
    out[1] = waxLit[1] * b * 0.92 + shadow[1];
    out[2] = waxLit[2] * b * 0.8 + shadow[2];
    out[3] = smoothstep(1, 0.75, Math.abs(x)) * (y > 0.96 ? (1 - y) / 0.04 : 1);
  });

  state.sprites = { room, pools, wax, flame: bakeFlame(kelvin * 1.05), halo: bakeHalo(kelvin) };
  state.spriteKey = key;
  return state.sprites;
}

/**
 * Eyes in the dark window.
 *
 * The old ones were two yellow discs with a round black dot in each — the
 * eyes of a cartoon owl — a few pixels across, sitting in the same place all
 * evening. What makes eyes in the dark frightening is that they are looking at
 * you, that they are not a person's, and that they were not there a moment
 * ago. So:
 *
 * - **A shape that means it.** Almond, not round, and tilted so the inner
 *   corners sit lower than the outer — the angle a brow makes when it frowns,
 *   which the eye reads as hostile before it has decided what it is looking at.
 * - **Lit from inside.** The iris is a glow, not a fill: near white round the
 *   pupil, the set colour through the body of it, darkening to a deep rim at
 *   the edge of the lids, with a halo outside for the bloom to take further.
 *   Eyeshine, in other words — light coming back out of the eye.
 * - **A slit pupil**, which is the single detail that makes them not human.
 * - **Lids.** A blink closes them from the top, quickly, and sometimes twice.
 * - **Attention.** Both eyes of a pair look about together; every so often
 *   they stop and look straight out of the window, and hold it.
 * - **They come and go.** Each pair opens somewhere in the window, watches for
 *   a while, closes, and opens again somewhere else. Pairs keep their own
 *   clocks, so a still nearly always has one in it.
 *
 * The iris and the halo are baked once per colour and stamped; a frame is a
 * clip, two images and a pupil per eye.
 */
const eyes = {
  id: 'eyes',
  name: 'Watching Eyes',
  category: 'halloween',
  scope: 'shape',
  description: 'Glowing slit-pupilled eyes that open in the dark window, look about, stare straight out at the street, blink, close and open again somewhere else.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#ffe74c' },
    { key: 'pupil', type: 'color', label: 'Pupil', default: '#1a0000' },
    { key: 'pairs', type: 'range', label: 'Pairs', default: 2, min: 1, max: 12, step: 1 },
    { key: 'size', type: 'range', label: 'Eye size', default: 0.16, min: 0.01, max: 0.4, step: 0.005 },
    { key: 'blink', type: 'range', label: 'Blink rate', default: 0.35, min: 0, max: 2, step: 0.01 },
    { key: 'wander', type: 'range', label: 'Wander', default: 0.3, min: 0, max: 1, step: 0.01 },
    { key: 'glow', type: 'range', label: 'Glow', default: 1.2, min: 0, max: 4, step: 0.05 },
  ],
  draw({ g, p, stable, shape, t, state, noise }) {
    const { bbox } = shape;
    if (!(bbox.w > 2 && bbox.h > 2)) return;
    const sprites = eyeSprites(state, (stable ?? p).color);
    const pairs = clamp(Math.round(p.pairs), 1, 12);
    const eyeR = Math.min(bbox.w, bbox.h) * clamp(p.size, 0.005, 0.5) * 0.5;
    const alpha = g.globalAlpha;
    const id = shape.id;
    // Each pair's rhythm, worked out once per window and kept.
    const clocksKey = `${id}|${pairs}`;
    if (state.clocksKey !== clocksKey) {
      state.clocks = Array.from({ length: pairs }, (_, k) => ({
        period: 8 + 5 * hashUnit(`${id}:${k}:period`),
        offset: hashUnit(`${id}:${k}`) + k / pairs,
        dark: 1.2 + 1.5 * hashUnit(`${id}:${k}:dark`),
        blink: hashUnit(`${id}:${k}:blink`) * 10,
      }));
      state.clocksKey = clocksKey;
    }

    g.save();
    g.clip(shape.path);

    for (let k = 0; k < pairs; k++) {
      // This pair's appearances: open, watch, close, a moment of dark.
      const clock = state.clocks[k];
      const period = clock.period;
      const phase = t / period + clock.offset;
      const index = Math.floor(phase);
      const local = (phase - index) * period;
      const shownFor = period - clock.dark;
      if (local > shownFor) continue;
      // Lids: opening slowly at first, closing faster at the end.
      let open = smoothstep(0, 0.9, local) * (1 - smoothstep(shownFor - 0.35, shownFor, local));

      // Where it opens this time, kept clear of the edges and spread between
      // the pairs so two do not land on top of each other.
      const where = makeRng(`eyes:${id}:${k}:${index}`);
      const r = eyeR * (0.75 + where() * 0.5);
      const lane = (k + 0.15 + where() * 0.7) / pairs;
      const cx0 = bbox.x + bbox.w * clamp(lane, 0.2, 0.8);
      const cy0 = bbox.y + bbox.h * (0.28 + where() * 0.4);
      const drift = clamp(p.wander, 0, 1);
      const cx = cx0 + noise.noise2(t * 0.12, k * 13.1 + index) * drift * bbox.w * 0.08;
      const cy = cy0 + noise.noise2(t * 0.1, k * 17.3 + index) * drift * bbox.h * 0.06;
      if (open <= 0.02) continue;

      // Blinks, on the pair's own rhythm, and now and then a double.
      if (p.blink > 0) {
        const bt = local * p.blink * 0.35 + clock.blink;
        const cycle = frac(bt);
        const twice = frac(Math.floor(bt) * 0.618) < 0.3;
        const span = 0.05;
        if (cycle < span) open *= Math.abs(cycle / (span / 2) - 1);
        else if (twice && cycle > 0.075 && cycle < 0.075 + span) open *= Math.abs((cycle - 0.075) / (span / 2) - 1);
      }
      if (open <= 0.02) continue;

      // Gaze: wandering together, and every so often locked on the street.
      const lock = smoothstep(0.55, 0.75, noise.noise2(t * 0.15, k * 7.7 + 40));
      const gazeX = noise.noise2(t * 0.35, k * 5.3 + 200) * (1 - lock) * r * 0.42;
      const gazeY = noise.noise2(t * 0.3, k * 5.3 + 300) * (1 - lock) * r * 0.18;
      // The slit opens a little in the dark and narrows as it stares.
      const slit = 0.2 + 0.08 * noise.noise2(t * 0.2, k + 9.9) - lock * 0.05;

      const gap = r * 2.55;
      for (const side of [-1, 1]) {
        const ex = cx + (side * gap) / 2;
        if (p.glow > 0) {
          const hr = r * (1.6 + p.glow * 1.1);
          g.globalCompositeOperation = 'lighter';
          g.globalAlpha = alpha * clamp(0.35 + 0.15 * p.glow, 0, 1) * Math.min(1, open * 1.5);
          g.drawImage(sprites.halo, ex - hr, cy - hr, hr * 2, hr * 2);
        }
        g.save();
        g.translate(ex, cy);
        eyeOpening(g, r, open, side);
        g.clip();
        g.globalCompositeOperation = 'lighter';
        g.globalAlpha = alpha;
        g.drawImage(sprites.iris, -r + gazeX * 0.35, -r + gazeY * 0.35, r * 2, r * 2);
        g.globalCompositeOperation = 'source-over';
        g.fillStyle = p.pupil;
        g.beginPath();
        g.ellipse(gazeX, gazeY, r * slit, r * 0.72, 0, 0, TAU);
        g.fill();
        g.restore();
      }
    }
    g.restore();
  },
};

/**
 * The visible part of an eye, `r` either side of centre and `open` of the way
 * open: a near-straight upper lid slanting down towards the nose over a deep
 * curve of lower lid. That slant is the frown — the inner corner low, the
 * outer one high — and it is the whole difference between watching and
 * looking. `side` is which eye, so the nose is on the right side of it. Both
 * lids close onto the line between the corners.
 */
function eyeOpening(g, r, open, side) {
  const ix = -side * r;
  const iy = r * 0.16;
  const ox = side * r;
  const oy = -r * 0.3;
  const mid = (iy + oy) / 2;
  g.beginPath();
  g.moveTo(ix, iy);
  g.bezierCurveTo(-side * r * 0.4, mid - r * 0.42 * open, side * r * 0.45, oy - r * 0.32 * open, ox, oy);
  g.bezierCurveTo(side * r * 0.55, oy + r * 0.95 * open, -side * r * 0.45, iy + r * 0.85 * open, ix, iy);
  g.closePath();
}

/** An iris glowing from the pupil out, and a halo, for one colour. */
function eyeSprites(state, colour) {
  if (state.eyeKey === colour) return state.eyeSprites;
  const base = linearRgb(colour, [0, 0, 0]);
  const iris = bakeSprite(64, 64, (u, v, out) => {
    const rr = Math.hypot(u * 2 - 1, v * 2 - 1);
    // Near white at the middle, the colour through the body, and a darker
    // rim towards the lids.
    const hot = Math.max(0, 1 - rr / 0.45) ** 2;
    const rim = smoothstep(0.55, 1, rr);
    for (let c = 0; c < 3; c++) {
      const body = base[c] * (1 - 0.7 * rim) * (c === 0 ? 1 : 1 - 0.35 * rim);
      out[c] = body + (1 - body) * hot * 0.85;
    }
    out[3] = 1;
  });
  const halo = bakeSprite(64, 64, (u, v, out) => {
    const rr = Math.hypot(u * 2 - 1, v * 2 - 1);
    if (rr >= 1) return;
    const I = Math.max(0, 1 / (1 + (rr / 0.18) ** 2) - 0.03) / 0.97;
    out[0] = base[0];
    out[1] = base[1];
    out[2] = base[2];
    out[3] = I;
  });
  state.eyeSprites = { iris, halo };
  state.eyeKey = colour;
  return state.eyeSprites;
}

/**
 * Somebody in the window.
 *
 * Two things were wrong with the old one, and the second was why it was easy
 * to miss the first. The room was a flat fill of bright yellow — a window-
 * shaped sticker — and the figure was a stick man: a ball on a line with lines
 * for limbs, which at house scale is a few pixels of shadow and reads as a
 * crack in the glass if it reads at all. And it spent a third of every cycle
 * off the edge of the window, so a still had a fair chance of catching nothing
 * but the sticker.
 *
 * Now the window is a lit room seen through drawn-back curtains: a lamp inside,
 * the light falling away to the corners, heavy curtains either side glowing in
 * their folds where the lamp shines through them, a pelmet across the top, and
 * a sheer across the middle. The figure is the shadow the lamp throws on that
 * sheer, which is the shot everybody knows — and the reason it can be dark at
 * all. A projector cannot paint black on an unlit wall; it can only leave a
 * hole in the light, so the figure is punched out of the room.
 *
 * It is a body, not a diagram. A head with a neck under it, shoulders that
 * slope and are wider than anything else, arms hanging clear of the waist with
 * light between — the gaps are as much the silhouette as the solid parts.
 * Seen from the street a window only shows somebody from the waist up, so that
 * is what is drawn, and it is big: Size is how much of the window's height the
 * figure fills, from the sill up to the crown of its head.
 *
 * It walks in, stops, turns to face the street — the shoulders broadening as it
 * comes round — stands there, head cocked, then turns back and walks off. The
 * stop is somewhere different each time and every window keeps its own clock,
 * and the walk is most of the cycle on screen: a still catches somebody there
 * far more often than not.
 *
 * The figure is built from overlapping solid pieces — head, neck, torso, arms
 * — punched out of the room at full strength, which is what lets them overlap
 * without the joins showing, and then a tenth of the room is put back into the
 * hole from behind, so the shadow has the faint warmth a real one on a lit
 * sheer has rather than being a hole to nowhere.
 */
const silhouette = {
  id: 'silhouette',
  name: 'Shadow in the Window',
  category: 'halloween',
  scope: 'shape',
  description:
    'A lamplit room behind drawn curtains, and a figure whose shadow crosses the blind, stops, turns to look out at the street and moves on. At light level zero it is cut out of whatever light is already in the window — put it over Candle Flicker.',
  params: [
    { key: 'color', type: 'color', label: 'Window light', default: '#ffbe6f' },
    { key: 'figure', type: 'select', label: 'Figure', default: 'person', options: ['person', 'creature', 'cat', 'reaper'] },
    { key: 'speed', type: 'range', label: 'Speed', default: 0.12, min: 0.01, max: 1.5, step: 0.005 },
    { key: 'size', type: 'range', label: 'Size', default: 0.85, min: 0.2, max: 1.6, step: 0.01 },
    { key: 'direction', type: 'select', label: 'Direction', default: 'right', options: ['right', 'left', 'pace'] },
    { key: 'pause', type: 'range', label: 'Pause & stare', default: 0.3, min: 0, max: 1, step: 0.01 },
    { key: 'level', type: 'range', label: 'Light level', default: 0.9, min: 0, max: 1.5, step: 0.01 },
  ],
  draw({ g, p, stable, shape, t, state }) {
    const { bbox } = shape;
    if (!(bbox.w > 2 && bbox.h > 2)) return;
    const level = clamp(p.level, 0, 2);
    /**
     * At zero the room is dark — and the figure is still there, cut out of
     * whatever light is already in the window. Put this layer straight above a
     * Candle Flicker on the same windows, at full opacity, and somebody walks
     * across in front of the candles: the one way to get candlelight and a
     * figure into a window when a preset can only say "every window".
     */
    const lit = level > 0.003;
    const room = silhouetteRoom(state, shape, (stable ?? p).color);
    const alpha = g.globalAlpha;

    g.save();
    g.clip(shape.path);
    if (lit) {
      g.globalAlpha = alpha * Math.min(1, level);
      g.drawImage(room, bbox.x, bbox.y, bbox.w, bbox.h);
      if (level > 1) {
        g.globalCompositeOperation = 'lighter';
        g.globalAlpha = alpha * (level - 1);
        g.drawImage(room, bbox.x, bbox.y, bbox.w, bbox.h);
      }
    }

    const pose = figurePose(SIL_POSE, p, shape, t);
    if (pose.visible) {
      // Punched out at the layer's full strength, so the pieces it is built
      // from can overlap freely: a part removed twice is still just removed.
      g.globalCompositeOperation = 'destination-out';
      g.globalAlpha = alpha;
      g.fillStyle = '#000';
      g.strokeStyle = '#000';
      g.lineCap = 'round';
      g.lineJoin = 'round';
      drawFigure(g, p.figure, pose, bbox, clamp(p.size, 0.1, 2));
      if (lit) {
        // Then a little of the room put back behind it. Not quite black: the
        // lamp is not the only light in the room, and a shadow on a lit sheer
        // always has some of the room in it. `destination-over` only lands
        // where the figure left nothing.
        g.globalCompositeOperation = 'destination-over';
        g.globalAlpha = alpha * Math.min(1, level) * 0.1;
        g.drawImage(room, bbox.x, bbox.y, bbox.w, bbox.h);
      }
    }
    g.restore();
  },
};

/** Scratch pose, filled in each frame. */
const SIL_POSE = { visible: false, u: 0, facing: 1, turn: 0, dist: 0, stride: 0, walking: 0, tilt: 0, lean: 0 };

/**
 * Where the figure is and what it is doing, as a pure function of show time.
 *
 * A cycle is: walk in from just out of sight on one side, stop somewhere
 * across the window, turn to face out, stare, turn back, walk off the other
 * side, and a moment of empty room. The cycle has a fixed length, so which one
 * we are in is a division; the stopping place changes every cycle, but the walk
 * in and the walk out always add up to the same distance, so the length does
 * not change with it. Pacing is a lap instead — across, stop and look out,
 * back, stop and look out — between two turning points that belong to the
 * window rather than to the lap, so one lap ends exactly where the next starts.
 *
 * Every window is offset by a hash of its shape, so a row of them is never in
 * step; Stagger on the layer shifts them further, as it does everything.
 */
function figurePose(pose, p, shape, t) {
  const { bbox } = shape;
  const aspect = bbox.w / bbox.h;
  // Walking speed in widths of the window per second, so a narrow window is
  // crossed in the same few steps as a wide one would take proportionally.
  const walk = Math.max(0.005, p.speed) * 1.5 * Math.min(1.6, Math.max(0.6, 1.4 / aspect));
  const pauseOn = p.pause > 0.001;
  const turnTime = 0.7;
  const stare = 0.8 + p.pause * 9;
  // In from just out of sight and off to just out of sight, with only a
  // moment of empty room between: the figure is what the effect is for.
  const gap = 0.6;
  const enter = -0.2;
  const exit = 1.2;
  const pace = p.direction === 'pace';
  const walkTime = (exit - enter) / walk;
  const hold = pauseOn ? turnTime * 2 + stare : 0;
  // Pacing keeps two turning points of its own for the whole show, so one
  // lap ends exactly where the next begins.
  const lane = makeRng(`pace:${shape.id}`);
  const a = 0.22 + lane() * 0.1;
  const b = 0.68 + lane() * 0.1;
  const lap = (b - a) / walk;
  const period = pace ? 2 * (lap + hold) : walkTime + hold + gap;
  // Every window keeps its own clock.
  const offset = hashUnit(shape.id) * period;
  const time = t + offset;
  const cycle = Math.floor(time / period);
  let local = time - cycle * period;
  const rng = makeRng(`sil:${shape.id}:${cycle}`);
  const stop = 0.32 + rng() * 0.36;
  const side = p.direction === 'left' ? -1 : 1;
  pose.tilt = 0;
  pose.lean = 0;
  pose.visible = true;

  if (pace) {
    // Back and forth across the room, never leaving it, stopping at each end
    // to turn and look out.
    for (const dir of [1, -1]) {
      const from = dir > 0 ? a : b;
      if (local < lap) {
        pose.u = from + dir * local * walk;
        pose.facing = dir;
        pose.turn = 0;
        pose.walking = 1;
        pose.dist = local * walk + (dir > 0 ? 0 : b - a);
        return pose;
      }
      local -= lap;
      if (local < hold) {
        pose.u = dir > 0 ? b : a;
        pose.facing = dir;
        staring(pose, local, turnTime, stare, rng);
        return pose;
      }
      local -= hold;
    }
    pose.u = a;
    pose.facing = 1;
    pose.turn = 0;
    pose.walking = 0;
    pose.dist = 0;
    return pose;
  }

  const toStop = stop - enter;
  const tIn = toStop / walk;
  const from = side > 0 ? enter : 1 - enter;
  const at = side > 0 ? stop : 1 - stop;
  pose.facing = side;
  if (local < tIn || !pauseOn) {
    const d = Math.min(local, walkTime) * walk;
    pose.u = from + side * d;
    pose.turn = 0;
    pose.walking = 1;
    pose.dist = d;
    pose.visible = local < walkTime;
    return pose;
  }
  local -= tIn;
  if (local < hold) {
    pose.u = at;
    staring(pose, local, turnTime, stare, rng);
    return pose;
  }
  local -= hold;
  const d = local * walk;
  pose.u = at + side * d;
  pose.turn = 0;
  pose.walking = 1;
  pose.dist = toStop + d;
  pose.visible = pose.u > -0.5 && pose.u < 1.5;
  return pose;
}

/** Turn to face out, stand and stare with the head cocked, turn back. */
function staring(pose, local, turnTime, stare, rng) {
  pose.walking = 0;
  pose.dist = 0;
  if (local < turnTime) {
    pose.turn = smoothstep(0, 1, local / turnTime);
  } else if (local < turnTime + stare) {
    pose.turn = 1;
    const s = local - turnTime;
    // The head goes over slowly, once, the way a person regards something.
    const dir = rng() < 0.5 ? -1 : 1;
    pose.tilt = dir * 0.2 * smoothstep(0.4, 1.6, s) * (1 - smoothstep(stare - 1.2, stare - 0.2, s));
    pose.lean = 0.5 * smoothstep(0, 1.2, s);
  } else {
    pose.turn = 1 - smoothstep(0, 1, (local - turnTime - stare) / turnTime);
  }
}

/** A stable 0..1 number from a string. */
function hashUnit(str) {
  return makeRng(`u:${str}`)();
}

/**
 * The lit room, baked per window and colour.
 *
 * A lamp a little off centre, high up; its light falls away towards every
 * edge and hardest into the corners. Curtains drawn back to either side,
 * lit through, so their folds alternate bright and dark and their inner edges
 * catch the light; a pelmet across the top; a sheer across the middle with a
 * faint weave of its own, which is the surface the shadow lands on.
 */
function silhouetteRoom(state, shape, colour) {
  const { bbox } = shape;
  const w = clamp(Math.round(bbox.w / 2), 16, 256);
  const h = clamp(Math.round(bbox.h / 2), 16, 256);
  const key = `${colour}|${w}|${h}|${shape.id}`;
  if (state.roomKey === key) return state.room;
  const light = linearRgb(colour, [0, 0, 0]);
  const rng = makeRng(`room:${shape.id}`);
  const lampX = 0.5 + (rng() - 0.5) * 0.3;
  const lampY = 0.22 + rng() * 0.1;
  const aspect = bbox.w / bbox.h;
  // Narrow windows get narrower curtains, or there is no room left between them.
  const drape = clamp(0.13 / Math.max(0.7, aspect / 1.6), 0.08, 0.2);
  const folds = 2.5 + rng() * 1.5;
  const phase = rng() * TAU;
  const weave = 9 * Math.max(1, aspect);
  state.room = bakeSprite(w, h, (u, v, out) => {
    const dx = (u - lampX) * aspect;
    const dy = v - lampY;
    // The lamp: a soft-cored falloff, and a floor of light bounced round the room.
    let I = 0.18 + 0.82 / (1 + (dx * dx + dy * dy) / 0.16);
    // Darker into the corners.
    I *= 1 - 0.45 * Math.abs(u * 2 - 1) ** 3;
    let r = light[0];
    let gg = light[1];
    let b = light[2];
    const inDrape = Math.min(u, 1 - u);
    if (inDrape < drape) {
      // Folds: light comes through the thin part of each fold and not the
      // thick, so a backlit curtain is a run of bright and dark stripes.
      const f = inDrape / drape;
      const fold = 0.5 + 0.5 * Math.cos((u < 0.5 ? f : f + 0.37) * folds * TAU + phase);
      const edge = smoothstep(0.75, 1, f);
      I *= 0.3 + 0.28 * fold * fold + 0.25 * edge;
      // The fabric takes the colour: a deep warm red.
      r *= 1;
      gg *= 0.55;
      b *= 0.4;
    } else {
      // The sheer: soft vertical gathers across the glass, irregular, as a
      // net curtain hangs.
      const gathers = Math.cos(u * weave * TAU + 1.7 * Math.sin(u * weave * 0.37 * TAU + phase));
      I *= 0.95 + 0.05 * gathers;
    }
    if (v < 0.08) {
      // The pelmet, with a soft lower edge.
      I *= 0.35 + 0.65 * smoothstep(0.05, 0.08, v);
    }
    out[0] = r * I;
    out[1] = gg * I;
    out[2] = b * I;
    out[3] = 1;
  });
  state.roomKey = key;
  return state.room;
}

/**
 * The figures, as solid pieces punched out of the room.
 *
 * Proportions are of the whole figure's height, feet to crown, with the feet
 * below the sill: a window shows the top half of somebody, so Size says how
 * much of the window's height the figure fills and the rest of the body is
 * simply out of sight. `turn` runs from profile (0) to facing out (1), and every width
 * blends between the two — so turning round reads as the shoulders broadening,
 * which is how you see somebody turn to face you.
 */
function drawFigure(g, kind, pose, bbox, size) {
  const face = pose.facing;
  const turn = pose.turn;
  const cx = bbox.x + pose.u * bbox.w;

  if (kind === 'cat') {
    drawCat(g, cx, bbox, size, pose);
    return;
  }

  // The figure's full height, from how much of the window it fills: the sill
  // cuts it at a little under half way up.
  const H = (bbox.h * size) / 0.53;
  // A step is about four tenths of the body's height, two steps a stride.
  pose.stride = ((pose.dist * bbox.w) / (H * 0.42)) * Math.PI;
  const feet = bbox.y + bbox.h * (1 - size) + H;
  const Y = (f) => feet - f * H;
  const walking = pose.walking;
  const swing = Math.sin(pose.stride) * walking;
  const bob = Math.abs(Math.cos(pose.stride)) * walking * 0.008 * H;
  const lean = pose.lean * 0.01 * H;
  const W = (frontal, profile) => lerp(profile, frontal, turn) * H;

  if (kind === 'reaper') {
    drawReaper(g, cx, Y, H, face, turn, swing, bob);
    return;
  }

  const creature = kind === 'creature';
  // A creature stoops: head down and forward of its shoulders.
  const stoop = creature ? 1 : 0;
  const headY = Y(0.935 - 0.07 * stoop) + bob + lean;
  const headX = cx + face * (1 - turn) * (0.012 + 0.07 * stoop) * H;
  // A shade larger than life. Silhouettes read by their heads, and the
  // eye takes a head of true proportion at this size for a pinhead.
  const headRX = W(creature ? 0.05 : 0.058, creature ? 0.058 : 0.064);
  const headRY = H * (creature ? 0.062 : 0.071);

  g.save();
  g.translate(headX, headY);
  g.rotate(pose.tilt + face * (1 - turn) * stoop * 0.25);
  g.beginPath();
  g.ellipse(0, 0, headRX, headRY, 0, 0, TAU);
  g.fill();
  if (turn < 0.9) {
    // In profile: brow, nose, lips and chin down the front of the face, below
    // the middle of the head — set any higher and it reads as the peak of a
    // cap. Fades as the head comes round.
    const k = (1 - turn / 0.9) * H;
    g.beginPath();
    g.moveTo(face * headRX * 0.82, -headRY * 0.2);
    g.quadraticCurveTo(face * (headRX + 0.004 * k), -headRY * 0.02, face * (headRX + 0.016 * k), headRY * 0.2);
    g.lineTo(face * (headRX + 0.002 * k), headRY * 0.34);
    g.quadraticCurveTo(face * (headRX + 0.006 * k), headRY * 0.55, face * (headRX * 0.96), headRY * 0.78);
    g.quadraticCurveTo(face * headRX * 0.8, headRY * 1.02, face * headRX * 0.2, headRY * 0.95);
    g.lineTo(0, 0);
    g.closePath();
    g.fill();
  }
  if (turn > 0.3 && !creature) {
    // Facing out: the ears. Small, but a head without them is an egg.
    const k = (turn - 0.3) / 0.7;
    for (const s of [-1, 1]) {
      g.beginPath();
      g.ellipse(s * headRX * 0.98, headRY * 0.05, H * 0.011 * k, H * 0.02, 0, 0, TAU);
      g.fill();
    }
  }
  if (creature) {
    // Something growing out of the skull. It is not a hat.
    for (const s of [-1, 1]) {
      g.beginPath();
      g.moveTo(s * headRX * 0.5, -headRY * 0.6);
      g.quadraticCurveTo(s * headRX * 1.3, -headRY * 1.4, s * headRX * 1.6, -headRY * 2.1);
      g.quadraticCurveTo(s * headRX * 1.0, -headRY * 1.2, s * headRX * 0.05, -headRY * 0.8);
      g.closePath();
      g.fill();
    }
  }
  g.restore();

  // The neck: narrower than the head, which is the whole point of drawing one.
  const neckW = W(0.026, 0.03);
  const neckTop = headY + headRY * 0.6;
  const shoulderY = Y(0.815 - 0.05 * stoop) + bob + lean;
  g.beginPath();
  g.rect(cx - neckW + face * (1 - turn) * 0.004 * H, neckTop, neckW * 2, shoulderY - neckTop + H * 0.02);
  g.fill();

  // The torso, as one smooth outline: shoulders, chest, waist, hips. In
  // profile the chest pushes forward and the back is flatter.
  const sh = W(creature ? 0.11 : 0.128, 0.068);
  const chest = W(0.108, 0.075);
  const waist = W(0.084, 0.062);
  const hip = W(0.1, 0.07);
  const fwd = face * (1 - turn) * H;
  const yChest = Y(0.72) + bob + lean;
  const yWaist = Y(0.6) + bob;
  const yHip = Y(0.5) + bob;
  // Hunched: the shoulders ride up round the neck.
  const hunch = stoop * H * 0.035;
  g.beginPath();
  g.moveTo(cx - neckW, shoulderY - H * 0.012 - hunch);
  g.quadraticCurveTo(cx - sh * 0.75 + fwd * 0.004, shoulderY - H * 0.008 - hunch, cx - sh + fwd * 0.004, shoulderY + H * 0.02);
  g.quadraticCurveTo(cx - sh * 1.04 + fwd * 0.004, shoulderY + H * 0.05, cx - chest + fwd * 0.012, yChest);
  g.quadraticCurveTo(cx - waist + fwd * 0.005, yWaist - H * 0.04, cx - waist, yWaist);
  g.quadraticCurveTo(cx - hip * 1.02, yHip - H * 0.03, cx - hip, yHip + H * 0.02);
  g.lineTo(cx - hip * 0.9, Y(0.3));
  g.lineTo(cx + hip * 0.9, Y(0.3));
  g.lineTo(cx + hip, yHip + H * 0.02);
  g.quadraticCurveTo(cx + hip * 1.02, yHip - H * 0.03, cx + waist, yWaist);
  g.quadraticCurveTo(cx + waist + fwd * 0.005, yWaist - H * 0.04, cx + chest + fwd * 0.012, yChest);
  g.quadraticCurveTo(cx + sh * 1.04 + fwd * 0.004, shoulderY + H * 0.05, cx + sh + fwd * 0.004, shoulderY + H * 0.02);
  g.quadraticCurveTo(cx + sh * 0.75 + fwd * 0.004, shoulderY - H * 0.008 - hunch, cx + neckW, shoulderY - H * 0.012 - hunch);
  g.closePath();
  g.fill();

  // Legs, for the rare window low enough to show them.
  g.lineWidth = H * 0.07;
  for (const s of [-1, 1]) {
    const stride = Math.sin(pose.stride + (s > 0 ? 0 : Math.PI)) * walking;
    g.beginPath();
    g.moveTo(cx + s * hip * 0.5 * turn, Y(0.45));
    g.quadraticCurveTo(cx + s * hip * 0.5 * turn + face * stride * H * 0.06, Y(0.25), cx + s * hip * 0.45 * turn + face * stride * H * 0.13, Y(0.03));
    g.stroke();
  }

  // Arms: hanging clear of the waist when facing out — the light between arm
  // and body is a large part of what makes it a person — and swinging when it
  // walks. A creature's reach past its knees and end in something.
  const armLen = creature ? 0.5 : 0.36;
  for (const s of [-1, 1]) {
    // In profile the far arm is hidden behind the body; draw it anyway, it
    // only shows where it swings clear.
    const a = (s > 0 ? swing : -swing) * 0.38;
    const sx = cx + s * (sh - W(0.018, 0.035)) + fwd * 0.004;
    const sy = shoulderY + H * 0.035;
    // Out from the body a little more the more it faces out.
    const splay = s * lerp(0.02, 0.07, turn) + face * a * (1 - turn);
    const ex = sx + Math.sin(splay) * H * armLen * 0.5;
    const ey = sy + Math.cos(splay) * H * armLen * 0.5;
    const fore = splay + face * (1 - turn) * Math.max(0, a) * 0.7 + s * turn * -0.04;
    const hx = ex + Math.sin(fore) * H * armLen * 0.48;
    const hy = ey + Math.cos(fore) * H * armLen * 0.48;
    g.lineWidth = H * (creature ? 0.038 : 0.052);
    g.beginPath();
    g.moveTo(sx, sy);
    g.lineTo(ex, ey);
    g.stroke();
    g.lineWidth = H * (creature ? 0.03 : 0.043);
    g.beginPath();
    g.moveTo(ex, ey);
    g.lineTo(hx, hy);
    g.stroke();
    if (creature) {
      // Fingers. Too many of them, too long.
      g.lineWidth = H * 0.009;
      for (let f = -1.5; f <= 1.5; f += 1) {
        const fa = fore + f * 0.14;
        g.beginPath();
        g.moveTo(hx, hy);
        g.quadraticCurveTo(hx + Math.sin(fa) * H * 0.05, hy + Math.cos(fa) * H * 0.05,
          hx + Math.sin(fa + s * 0.25) * H * 0.1, hy + Math.cos(fa + s * 0.25) * H * 0.1);
        g.stroke();
      }
    } else {
      g.beginPath();
      g.ellipse(hx, hy + H * 0.012, H * 0.024, H * 0.034, fore, 0, TAU);
      g.fill();
    }
  }
}

/** A hooded robe with a scythe. Turns like the others; has no face to turn. */
function drawReaper(g, cx, Y, H, face, turn, swing, bob) {
  const hoodW = lerp(0.07, 0.085, turn) * H;
  const top = Y(1.0) + bob;
  // The cowl comes to a point that hangs forward of the head.
  const tipX = cx + face * (1 - turn) * 0.05 * H;
  g.beginPath();
  g.moveTo(tipX, top - H * 0.02);
  g.quadraticCurveTo(cx + hoodW * 1.3, top + H * 0.02, cx + hoodW, Y(0.86) + bob);
  // Shoulders under the robe, then the robe flaring to the floor.
  g.quadraticCurveTo(cx + H * 0.15, Y(0.82), cx + H * 0.16, Y(0.74));
  g.quadraticCurveTo(cx + H * 0.17, Y(0.4), cx + H * 0.22 + swing * 0.01 * H, Y(0));
  g.lineTo(cx - H * 0.22 + swing * 0.01 * H, Y(0));
  g.quadraticCurveTo(cx - H * 0.17, Y(0.4), cx - H * 0.16, Y(0.74));
  g.quadraticCurveTo(cx - H * 0.15, Y(0.82), cx - hoodW, Y(0.86) + bob);
  g.quadraticCurveTo(cx - hoodW * 1.3, top + H * 0.02, tipX, top - H * 0.02);
  g.closePath();
  g.fill();
  // The scythe: a long snath held at the side, the blade sweeping over the top.
  const side = turn > 0.5 ? 1 : face;
  const px = cx + side * H * 0.19;
  g.lineWidth = H * 0.016;
  g.beginPath();
  g.moveTo(px - side * H * 0.02, Y(0.02));
  g.lineTo(px + side * H * 0.025, Y(1.08));
  g.stroke();
  g.beginPath();
  g.moveTo(px + side * H * 0.025, Y(1.08));
  g.quadraticCurveTo(px - side * H * 0.12, Y(1.17), px - side * H * 0.3, Y(1.0));
  g.quadraticCurveTo(px - side * H * 0.13, Y(1.1), px + side * H * 0.02, Y(1.04));
  g.closePath();
  g.fill();
  // A hand on the snath.
  g.beginPath();
  g.ellipse(px, Y(0.62), H * 0.03, H * 0.035, 0, 0, TAU);
  g.fill();
}

/**
 * A cat on the sill: walks along it, and when it stops it sits, tail round its
 * feet, ears up — the silhouette on every Halloween card ever printed.
 */
function drawCat(g, cx, bbox, size, pose) {
  const s = bbox.h * size * 0.32;
  pose.stride = ((pose.dist * bbox.w) / (s * 1.4)) * Math.PI;
  const sill = bbox.y + bbox.h * 0.995;
  const face = pose.facing;
  const sit = pose.turn;
  const walk = pose.walking;
  const swing = Math.sin(pose.stride * 1.6) * walk;

  // Body: a long low ellipse walking, an upright pear sitting.
  const bodyW = lerp(s * 1.05, s * 0.5, sit);
  const bodyH = lerp(s * 0.36, s * 0.62, sit);
  const bodyY = sill - lerp(s * 0.62, s * 0.62, sit);
  g.beginPath();
  g.ellipse(cx, bodyY, bodyW, bodyH, 0, 0, TAU);
  g.fill();
  if (sit > 0.01) {
    // Haunches.
    g.beginPath();
    g.ellipse(cx, sill - s * 0.32, s * 0.58 * sit, s * 0.32 * sit, 0, 0, TAU);
    g.fill();
  }
  // Head, sitting up on the body when seated, out in front when walking.
  const headX = cx + face * lerp(bodyW * 0.95, 0, sit);
  const headY = lerp(bodyY - s * 0.32, bodyY - bodyH - s * 0.18, sit);
  const headR = s * 0.27;
  g.beginPath();
  g.ellipse(headX, headY, headR * 1.05, headR * 0.92, 0, 0, TAU);
  g.fill();
  for (const e of [-1, 1]) {
    g.beginPath();
    g.moveTo(headX + e * headR * 0.85, headY - headR * 0.25);
    g.lineTo(headX + e * headR * 0.78, headY - headR * 1.55);
    g.lineTo(headX + e * headR * 0.15, headY - headR * 0.75);
    g.closePath();
    g.fill();
  }
  // Legs, walking.
  if (walk > 0) {
    g.lineWidth = s * 0.12;
    for (const [off, ph] of [[-0.75, 0], [-0.55, Math.PI], [0.6, Math.PI], [0.8, 0]]) {
      const lx = cx + off * bodyW;
      g.beginPath();
      g.moveTo(lx, bodyY + bodyH * 0.4);
      g.lineTo(lx + Math.sin(pose.stride * 1.6 + ph) * s * 0.16, sill);
      g.stroke();
    }
  }
  // Tail: up and curling when walking, wrapped round the feet when sitting.
  g.lineWidth = s * 0.11;
  g.beginPath();
  const tx = cx - face * lerp(bodyW * 0.95, bodyW * 0.6, sit);
  const ty = lerp(bodyY - bodyH * 0.2, sill - s * 0.08, sit);
  g.moveTo(tx, ty);
  if (sit < 0.5) {
    g.quadraticCurveTo(tx - face * s * 0.55, ty - s * (0.2 + swing * 0.08), tx - face * s * 0.4, ty - s * 0.85);
  } else {
    g.quadraticCurveTo(cx - face * s * 0.1, sill + s * 0.02, cx + face * s * 0.55, sill - s * 0.08);
  }
  g.stroke();
}

/**
 * Something drifting past inside.
 *
 * The old ghost was a cartoon sheet a quarter of the window high at half
 * opacity, which through the grade came out as a faint smudge with three dots
 * in it. A ghost in a window has to be the thing you see from the gate: most of
 * the window tall, glowing from inside, and unmistakably a figure — a head, a
 * pair of sleeves lifted a little from its sides, a body that does not end so
 * much as come apart into tails, and those tails streaming out behind it as it
 * drifts, each wave travelling down to a tip that frays into wisps.
 *
 * Its edge does not stop: the outline is stroked wide and faint under the body
 * so it glows outward, which is the softness of something not entirely there.
 * The fill is brightest in the head and chest and thins to nothing at the
 * tails, an inner glow sits in the chest, and the face — two hollow eyes and an
 * open mouth — is a set of holes in that fill, left by the even-odd rule, so it
 * is dark within the ghost without punching a hole in whatever else is lit in
 * the window. It is all added to the window as light: you can see the room
 * through it.
 *
 * It does not walk on and off like a figure. It fades up out of nothing
 * somewhere in the window, drifts a stretch — rising and settling, leaning into
 * its own motion — and fades away again, and next time it is somewhere else,
 * going the other way. Most of every cycle it is there, so the window is rarely
 * caught empty.
 */
const ghost = {
  id: 'ghost',
  name: 'Ghost',
  category: 'halloween',
  scope: 'shape',
  description:
    'A glowing apparition most of the window high: hollow-eyed, lit from within, its tails streaming into wisps as it drifts across, fading in and away.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#cfe8ff' },
    { key: 'count', type: 'range', label: 'Ghosts', default: 1, min: 1, max: 8, step: 1 },
    { key: 'size', type: 'range', label: 'Size', default: 0.85, min: 0.1, max: 1.5, step: 0.01 },
    { key: 'speed', type: 'range', label: 'Speed', default: 0.06, min: 0.005, max: 1, step: 0.005 },
    { key: 'opacity', type: 'range', label: 'Opacity', default: 0.8, min: 0.02, max: 1, step: 0.01 },
    { key: 'wobble', type: 'range', label: 'Wobble', default: 1, min: 0, max: 3, step: 0.05 },
    { key: 'fade', type: 'bool', label: 'Fade in/out', default: true },
  ],
  draw({ g, p, shape, t, state, noise }) {
    const { bbox } = shape;
    if (!(bbox.w > 2 && bbox.h > 2)) return;
    const count = clamp(Math.round(p.count), 1, 8);
    const G = bbox.h * clamp(p.size, 0.05, 1.5);
    const seed0 = hashUnit(shape.id) * 100;

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';
    const alpha = g.globalAlpha;

    for (let k = 0; k < count; k++) {
      const seed = seed0 + k * 91.7;
      // Each appearance is a cycle: it fades up somewhere in the window,
      // drifts a stretch, and is gone again — and the next time it is
      // somewhere else, going the other way. Every window on its own clock.
      const phase = t * p.speed + k / count + seed0 * 0.01;
      const index = Math.floor(phase);
      const cycle = phase - index;
      const where = makeRng(`ghost:${shape.id}:${k}:${index}`);
      const dir = where() < 0.5 ? -1 : 1;
      const from = 0.2 + where() * 0.25;
      const travel = 0.3 + where() * 0.25;
      const u = dir > 0 ? from + travel * cycle : 1 - from - travel * cycle;
      const fadeIn = p.fade ? smoothstep(0, 0.16, cycle) * (1 - smoothstep(0.8, 0.97, cycle)) : 1;
      // Never quite steady: a slow breathing of the glow.
      const breathe = 0.82 + 0.18 * noise.noise2(t * 0.6 + seed, 3.3);
      const a = clamp(p.opacity, 0, 1) * fadeIn * breathe;
      if (a <= 0.01) continue;

      const x = bbox.x + bbox.w * u;
      const y = bbox.y + bbox.h * 0.06 + G * 0.05 * noise.noise2(t * 0.25 + seed, 0) + G * 0.025 * Math.sin(t * 1.1 + seed);

      g.save();
      g.translate(x, y);
      // Lean into the drift.
      g.rotate(-dir * 0.07);
      g.globalAlpha = alpha * a;
      drawGhostBody(g, G, t, seed, dir, p.wobble, p.color);
      g.restore();
    }
    g.restore();
  },
};

/** The face, as holes: two eyes and a mouth, centre, radii and tilt, in ghost heights. */
const GHOST_FACE = [
  [-0.058, 0.135, 0.032, 0.048, 0.2],
  [0.058, 0.135, 0.032, 0.048, -0.2],
  [0, 0.255, 0.028, 0.068, 0],
];

/** Scratch for the outline: x and y for each side, head to tail. */
const GX = new Array(48).fill(0);
const GY = new Array(48).fill(0);
/** And for one wisp. */
const WX = new Array(8).fill(0);
const WY = new Array(8).fill(0);

/**
 * One ghost, at the origin, head at y = 0, `G` tall, drifting towards `dir`.
 *
 * The outline goes round once — crown, right sleeve, right side, the tails
 * left to right along the hem, left side, left sleeve — and is drawn with
 * `curveThrough`, so its curves are curves. The hem is three tails, each a
 * wave travelling down from the body to its tip and swept back from the
 * direction of travel; the longest frays into wisps.
 */
function drawGhostBody(c, G, t, seed, dir, wobble, colour) {
  const wave = (f, k) => Math.sin(t * 2.2 + seed + k * 1.9 - f * 4.2) * wobble;
  let n = 0;
  const pt = (x, y) => {
    GX[n] = x * G;
    GY[n] = y * G;
    n++;
  };
  // Crown and the right side of the hood.
  pt(0, -0.005);
  pt(0.1, 0.02);
  pt(0.165, 0.12);
  pt(0.17, 0.24);
  // Right sleeve, lifted a little, its cuff hanging.
  pt(0.24, 0.3 + 0.01 * wave(0, 4));
  pt(0.34, 0.36 + 0.02 * wave(0.2, 4));
  pt(0.36, 0.45 + 0.02 * wave(0.5, 4));
  pt(0.27, 0.43);
  pt(0.2, 0.47);
  // Down the right side to the hem.
  pt(0.2 - dir * 0.02, 0.62);
  // The tails, right to left: out to a tip and back up into the crotch
  // between it and the next.
  const tails = [
    [0.13, 0.94, 0],
    [0.0, 1.1, 1],
    [-0.13, 0.98, 2],
  ];
  for (let k = 0; k < tails.length; k++) {
    const [tx, len, id] = tails[k];
    const sweep = -dir * 0.12;
    const wv = 0.04 * wave(1, id);
    pt(tx + 0.06 + sweep * 0.3 + wv * 0.4, 0.62 + (len - 0.62) * 0.45);
    pt(tx + sweep + wv, len);
    pt(tx - 0.05 + sweep * 0.35 + wv * 0.4, 0.62 + (len - 0.62) * 0.5);
    if (k < tails.length - 1) pt(tx - 0.065 + sweep * 0.1, 0.66);
  }
  // Up the left side, the left sleeve, and back to the crown.
  pt(-0.2 - dir * 0.02, 0.62);
  pt(-0.2, 0.47);
  pt(-0.27, 0.43);
  pt(-0.36, 0.45 + 0.02 * wave(0.5, 5));
  pt(-0.34, 0.36 + 0.02 * wave(0.2, 5));
  pt(-0.24, 0.3 + 0.01 * wave(0, 5));
  pt(-0.17, 0.24);
  pt(-0.165, 0.12);
  pt(-0.1, 0.02);
  pt(0, -0.005);

  // Brightest in the head, thinning to nothing at the tails.
  const body = c.createLinearGradient(0, 0, 0, G * 1.08);
  body.addColorStop(0, rgba(colour, 0.95));
  body.addColorStop(0.35, rgba(colour, 0.8));
  body.addColorStop(0.6, rgba(colour, 0.55));
  body.addColorStop(0.85, rgba(colour, 0.24));
  body.addColorStop(1, rgba(colour, 0));
  const a0 = c.globalAlpha;

  // An aura first, under the body: the outline stroked wide and faint, twice,
  // so the edge glows outward rather than stopping — the softness of
  // something not entirely there.
  c.beginPath();
  curveThrough(c, GX, GY, n, { move: true });
  c.closePath();
  c.strokeStyle = body;
  c.lineJoin = 'round';
  c.globalAlpha = a0 * 0.12;
  c.lineWidth = G * 0.12;
  c.stroke();
  c.globalAlpha = a0 * 0.2;
  c.lineWidth = G * 0.05;
  c.stroke();
  c.globalAlpha = a0;

  // The body with its face in it. The eyes and the open mouth are holes left
  // in the fill by the even-odd rule, so they are dark inside the ghost
  // without cutting into anything else lit in the window.
  ghostFace(c, G);
  c.fillStyle = body;
  c.fill('evenodd');

  // The glow inside it, kept out of the face the same way.
  c.save();
  c.clip('evenodd');
  const core = c.createRadialGradient(0, G * 0.2, 0, 0, G * 0.24, G * 0.36);
  core.addColorStop(0, 'rgba(255,255,255,0.75)');
  core.addColorStop(0.5, rgba(colour, 0.35));
  core.addColorStop(1, rgba(colour, 0));
  c.fillStyle = core;
  c.fillRect(-G * 0.4, -G * 0.15, G * 0.8, G * 0.8);
  c.restore();

  // Wisps off the tails: thin, fading strands.
  c.lineCap = 'round';
  for (let k = 0; k < 3; k++) {
    const [tx, len] = tails[k];
    const sweep = -dir * 0.12;
    let m = 0;
    for (let s = 0; s < 6; s++) {
      const f = s / 5;
      WX[m] = (tx + sweep * (1 + f * 1.8) + 0.06 * wave(1 + f, k + 7)) * G;
      WY[m] = (len - 0.16 + f * 0.36) * G;
      m++;
    }
    c.strokeStyle = rgba(colour, 0.45);
    c.lineWidth = G * 0.026;
    c.beginPath();
    curveThrough(c, WX, WY, m, { move: true });
    c.stroke();
  }

  /** The outline again, with the face added to it as subpaths. */
  function ghostFace(ctx, size) {
    ctx.beginPath();
    curveThrough(ctx, GX, GY, n, { move: true });
    ctx.closePath();
    // Each hole is its own subpath, started exactly where its ellipse
    // begins so no stray edge joins it to the last one.
    for (const [ex, ey, rx, ry, rot] of GHOST_FACE) {
      ctx.moveTo((ex + rx * Math.cos(rot)) * size, (ey + rx * Math.sin(rot)) * size);
      ctx.ellipse(ex * size, ey * size, rx * size, ry * size, rot, 0, TAU);
    }
  }
}

/**
 * A spider, drawn the way a spider is actually built.
 *
 * The old one was eight identical spokes on a single ellipse, which reads as a
 * sun symbol. Three things separate that from something your eye accepts:
 *
 * - **Two body segments.** A big abdomen behind a small cephalothorax, joined by
 *   a narrow waist. Every leg hangs off the *front* segment, not the middle of
 *   the whole animal.
 * - **Legs that arch.** A spider leg goes out and *outward* to a raised knee,
 *   then back in to the foot. That outward bow is the single most recognisable
 *   thing about the silhouette, and a straight line has none of it.
 * - **Four different pairs.** Legs I and II reach forward, III sideways, IV
 *   backward and longest. Eight evenly spaced legs is a wheel; unevenly spaced
 *   ones are an animal.
 *
 * `gait` runs 0..1 and walks it, alternate tetrapod — the diagonal groups swing
 * out of phase, which is how eight legs stay coordinated without tripping.
 *
 * Drawn facing +x at the origin; rotate before calling to aim it.
 */
export function drawSpider(g, size, gait, colour, lineWidth) {
  // Per pair: angle away from forward (degrees, toward that leg's own side),
  // reach in body units, and where along the cephalothorax the hip sits. All
  // angles are positive and mirrored by `side` — a negative here would put the
  // leg on the opposite flank and the two sides would sit on top of each other.
  // Leg I reaches forward, IV trails behind and is the longest.
  const PAIRS = [
    [32, 2.45, 0.74],
    [68, 2.3, 0.55],
    [108, 2.15, 0.34],
    [143, 2.8, 0.16],
  ];
  const s = size;
  const RAD = Math.PI / 180;

  g.strokeStyle = colour;
  g.fillStyle = colour;
  g.lineCap = 'round';
  g.lineJoin = 'round';

  for (let pair = 0; pair < 4; pair++) {
    const [baseDeg, reach, along] = PAIRS[pair];
    for (const side of [-1, 1]) {
      // Alternate tetrapod: diagonal legs swing together, so the body is always
      // held up by four feet spread around it.
      const group = (pair + (side > 0 ? 1 : 0)) % 2;
      const swing = Math.sin((gait + group * 0.5) * TAU);

      const hip = { x: s * along, y: side * s * 0.26 };
      const theta = side * (baseDeg + swing * 11) * RAD;
      const len = s * reach * (1 + swing * 0.06);
      // The knee is pulled towards straight-out-sideways, so the leg bows away
      // from the body and comes back in to the foot. Pulling *towards* 90°
      // rather than adding a fixed offset is what keeps the rear legs arching
      // outward too instead of folding under the abdomen.
      const kneeA = side * (baseDeg + (90 - baseDeg) * 0.5) * RAD;
      const kneeR = len * (0.56 + Math.max(0, swing) * 0.07);
      const knee = { x: hip.x + Math.cos(kneeA) * kneeR, y: hip.y + Math.sin(kneeA) * kneeR };
      const foot = { x: hip.x + Math.cos(theta) * len, y: hip.y + Math.sin(theta) * len };

      g.lineWidth = lineWidth;
      g.beginPath();
      g.moveTo(hip.x, hip.y);
      g.lineTo(knee.x, knee.y);
      g.stroke();
      // The lower half of the leg is visibly finer than the thigh, and curves
      // down to the foot rather than meeting it in a straight line.
      g.lineWidth = lineWidth * 0.6;
      g.beginPath();
      g.moveTo(knee.x, knee.y);
      g.quadraticCurveTo(
        (knee.x + foot.x) / 2 + Math.cos(kneeA) * len * 0.1,
        (knee.y + foot.y) / 2 + Math.sin(kneeA) * len * 0.1,
        foot.x, foot.y
      );
      g.stroke();
    }
  }

  // Waist first, so the two segments read as joined rather than overlapping.
  g.lineWidth = s * 0.22;
  g.beginPath();
  g.moveTo(-s * 0.25, 0);
  g.lineTo(s * 0.3, 0);
  g.stroke();

  g.beginPath();
  g.ellipse(-s * 0.72, 0, s * 0.78, s * 0.62, 0, 0, TAU);
  g.fill();
  g.beginPath();
  g.ellipse(s * 0.46, 0, s * 0.5, s * 0.42, 0, 0, TAU);
  g.fill();

  // Pedipalps — the short pair under the face. Small, but their absence is why
  // a spider without them looks like it is missing something at the front.
  g.lineWidth = lineWidth * 0.7;
  for (const side of [-1, 1]) {
    g.beginPath();
    g.moveTo(s * 0.75, side * s * 0.16);
    g.quadraticCurveTo(s * 1.15, side * s * 0.3, s * 1.3, side * s * 0.14);
    g.stroke();
  }
}

/**
 * An orb web across the corner of the window, caught in the light.
 *
 * The old one was clip art: spokes ruled out of the exact corner at even
 * angles, rings that were perfect scallops at even spacing, every thread the
 * same white. A real web is none of those, and the differences are what the
 * eye uses to believe it:
 *
 * - **The hub is in the web, not on the frame.** It sits a little way in from
 *   the corner, and the radials leave it at uneven angles, each anchored where
 *   it happened to meet the frame.
 * - **The capture thread is laid, not ruled.** It goes round in one long
 *   thread — back and forth across a corner web — so each turn is a little
 *   further out than the last rather than a ring of its own; the spacing
 *   varies, and every span sags towards the hub between the radials holding it.
 * - **It is not new.** A few spans have broken and a few loose ends hang down
 *   from where they snapped.
 * - **It shines where it lies across the light.** Silk is a thread, so it
 *   glints only where it runs square to the light, and a web in a beam is a
 *   bright band across a dark one — not a white drawing. Each span is as
 *   bright as its angle to a slowly swinging light says, and beads of dew
 *   along the spiral flash where they catch it.
 *
 * The geometry is built once per window and kept; a frame is a few strokes in
 * buckets of brightness, the dew, and the spider, all swaying a little on the
 * air.
 */
const web = {
  id: 'web',
  name: 'Spider Web',
  category: 'halloween',
  scope: 'shape',
  description: 'An orb web across a corner of the shape, glinting where its threads catch the light, beaded with dew and a little torn, with a spider that comes and goes.',
  params: [
    { key: 'color', type: 'color', label: 'Web colour', default: '#e8f0ff' },
    { key: 'corner', type: 'select', label: 'Anchor', default: 'top-left', options: ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'centre'] },
    { key: 'rings', type: 'range', label: 'Rings', default: 9, min: 2, max: 16, step: 1 },
    { key: 'spokes', type: 'range', label: 'Spokes', default: 11, min: 3, max: 28, step: 1 },
    { key: 'width', type: 'range', label: 'Thread width', default: 2, min: 0.5, max: 12, step: 0.25 },
    { key: 'scale', type: 'range', label: 'Size', default: 0.85, min: 0.2, max: 2, step: 0.01 },
    { key: 'spider', type: 'bool', label: 'Spider', default: true },
    { key: 'spiderSpeed', type: 'range', label: 'Spider speed', default: 0.12, min: 0.01, max: 1, step: 0.005 },
    { key: 'sway', type: 'range', label: 'Sway', default: 0.4, min: 0, max: 2, step: 0.01 },
  ],
  draw({ g, p, stable, shape, t, state, noise }) {
    const { bbox } = shape;
    if (!(bbox.w > 2 && bbox.h > 2)) return;
    const W = webGeometry(state, shape, stable ?? p);
    const { hubX, hubY, a0, a1, maxR } = W;

    // The whole web breathes on the air: a small rotation and stretch about
    // the hub, so the rim moves and the middle barely does.
    const swayA = noise.noise2(t * 0.35, 1.3) * p.sway * 0.012;
    const swayS = 1 + noise.noise2(t * 0.3, 7.7) * p.sway * 0.008;
    // The light swings slowly, so the glints travel round the web.
    const light = 0.9 + noise.noise2(t * 0.07, 3.1) * 1.4;

    g.save();
    g.clip(shape.path);
    g.translate(hubX, hubY);
    g.rotate(swayA);
    g.scale(swayS, swayS);
    g.translate(-hubX, -hubY);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const alpha = g.globalAlpha;
    const lw = Math.max(0.5, p.width);

    // Frame lines and radials: the strong silk, drawn first and a touch wider.
    g.strokeStyle = p.color;
    g.globalAlpha = alpha * 0.5;
    g.lineWidth = lw * 1.15;
    g.beginPath();
    for (let i = 0; i < W.radials.length; i += 4) {
      g.moveTo(W.radials[i], W.radials[i + 1]);
      g.lineTo(W.radials[i + 2], W.radials[i + 3]);
    }
    g.stroke();

    // The capture spiral, in buckets of brightness by how squarely each span
    // lies across the light: a thread only glints when it is side-on to it.
    const spans = W.spans;
    const count = spans.length / 7;
    if (!state.shine || state.shine.length < count) state.shine = new Array(count).fill(0);
    const shineOf = state.shine;
    for (let k = 0; k < count; k++) {
      const sn = Math.sin(spans[k * 7 + 6] - light);
      const s2 = sn * sn;
      shineOf[k] = Math.min(WEB_BUCKETS - 1, (s2 * s2 * s2 * WEB_BUCKETS) | 0);
    }
    g.lineWidth = lw * 0.85;
    for (let bucket = 0; bucket < WEB_BUCKETS; bucket++) {
      g.beginPath();
      let any = false;
      for (let k = 0; k < count; k++) {
        if (shineOf[k] !== bucket) continue;
        const i = k * 7;
        g.moveTo(spans[i], spans[i + 1]);
        g.quadraticCurveTo(spans[i + 2], spans[i + 3], spans[i + 4], spans[i + 5]);
        any = true;
      }
      if (!any) continue;
      g.globalAlpha = alpha * (0.32 + 0.68 * (bucket + 0.5) / WEB_BUCKETS);
      g.stroke();
    }

    // Loose ends, hanging where a span has broken.
    g.globalAlpha = alpha * 0.45;
    g.lineWidth = lw * 0.75;
    g.beginPath();
    for (let i = 0; i < W.loose.length; i += 6) {
      const swing = noise.noise2(t * 0.5 + i, 4.4) * p.sway * 6;
      g.moveTo(W.loose[i], W.loose[i + 1]);
      g.quadraticCurveTo(W.loose[i + 2] + swing * 0.5, W.loose[i + 3], W.loose[i + 4] + swing, W.loose[i + 5]);
    }
    g.stroke();

    // Dew: beads along the spiral, brightest where their span glints.
    g.fillStyle = p.color;
    for (let pass = 0; pass < 2; pass++) {
      g.beginPath();
      for (let i = 0; i < W.dew.length; i += 4) {
        const sn = Math.sin(W.dew[i + 3] - light);
        const s2 = sn * sn;
        if ((s2 * s2 * s2 > 0.5) !== (pass === 1)) continue;
        const r = W.dew[i + 2] * (pass === 1 ? 1.3 : 1);
        g.moveTo(W.dew[i] + r, W.dew[i + 1]);
        g.arc(W.dew[i], W.dew[i + 1], r, 0, TAU);
      }
      g.globalAlpha = alpha * (pass === 1 ? 1 : 0.5);
      g.fill();
    }

    if (p.spider) {
      const phase = frac(t * p.spiderSpeed);
      // Out along a thread, pause, back again.
      const out = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
      const sa = lerp(a0, a1, 0.5 + noise.noise2(Math.floor(t * p.spiderSpeed), 0) * 0.3);
      const sr = 0.12 * maxR + out * maxR * 0.6;
      const sx = hubX + Math.cos(sa) * sr;
      const sy = hubY + Math.sin(sa) * sr;
      const bodyR = Math.max(2, maxR * 0.032);

      // It faces the way it is going, and it is going backwards on the way in —
      // a spider that slides down its own thread nose-first and then reverses up
      // it without turning round is the tell that this is a sprite on a rail.
      const heading = phase < 0.5 ? sa : sa + Math.PI;
      // Legs only cycle while it is actually travelling. The pause at full
      // stretch is a pause, not a moonwalk.
      const moving = Math.abs(phase - 0.5) > 0.03;
      const gait = moving ? frac(t * p.spiderSpeed * 9) : 0.25;

      g.globalAlpha = alpha;
      g.save();
      g.translate(sx, sy);
      g.rotate(heading);
      drawSpider(g, bodyR, gait, p.color, Math.max(1, lw * 0.9));
      g.restore();
    }
    g.restore();
  },
};

/** How many brightness buckets the spiral is stroked in. */
const WEB_BUCKETS = 4;

/**
 * The web for a window, built once and kept until the window or a parameter
 * that shapes it changes. Seeded from the shape, so every tab spins the same
 * web and every window gets its own.
 *
 * Stored flat: radials as `x0 y0 x1 y1`, spiral spans as start, sag control
 * and end plus the span's own angle (for the glint), loose ends as a hanging
 * curve, dew as `x y r angle`.
 */
function webGeometry(state, shape, base) {
  const { bbox } = shape;
  const key = [shape.id, bbox.x, bbox.y, bbox.w, bbox.h, base.corner, base.rings, base.spokes, base.scale].join('|');
  if (state.webKey === key) return state.web;
  const rng = makeRng(`web:${shape.id}`);
  const corners = {
    'top-left': [bbox.x, bbox.y, 0, 90],
    'top-right': [bbox.x + bbox.w, bbox.y, 90, 180],
    'bottom-left': [bbox.x, bbox.y + bbox.h, 270, 360],
    'bottom-right': [bbox.x + bbox.w, bbox.y + bbox.h, 180, 270],
    centre: [bbox.cx, bbox.cy, 0, 360],
  };
  const [cx, cy, d0, d1] = corners[base.corner] || corners['top-left'];
  const centre = base.corner === 'centre';
  const a0 = (d0 * Math.PI) / 180;
  const a1 = (d1 * Math.PI) / 180;
  const scale = clamp(Number(base.scale) || 1, 0.05, 3);
  const maxR = Math.hypot(bbox.w, bbox.h) * (centre ? 0.45 : 0.85) * scale;
  // The hub sits in from the corner, along the corner's diagonal.
  const inset = centre ? 0 : Math.min(bbox.w, bbox.h) * 0.07 * Math.min(1, scale);
  const mid = (a0 + a1) / 2;
  const hubX = cx + Math.cos(mid) * inset * 1.41;
  const hubY = cy + Math.sin(mid) * inset * 1.41;

  // Radials at uneven angles. A corner web's outermost two run along the
  // frame; the rest fan between.
  const spokes = clamp(Math.round(base.spokes), 3, 28);
  const angles = [];
  for (let s = 0; s <= spokes; s++) {
    if (centre && s === spokes) break;
    const f = s / spokes;
    const jitter = s === 0 || s === spokes ? 0 : (rng() - 0.5) * 0.55 / spokes;
    angles.push(lerp(a0, a1, f + jitter));
  }
  const lengths = angles.map(() => maxR * (0.85 + rng() * 0.3));
  const radials = [];
  for (let s = 0; s < angles.length; s++) {
    radials.push(
      hubX, hubY,
      hubX + Math.cos(angles[s]) * lengths[s], hubY + Math.sin(angles[s]) * lengths[s]
    );
  }

  // The capture thread: round and round (or back and forth across a corner),
  // a little further out at every span, sagging towards the hub between the
  // radials that hold it.
  const rings = clamp(Math.round(base.rings), 2, 16);
  const spans = [];
  const loose = [];
  const dew = [];
  const n = angles.length;
  const segments = centre ? n : n - 1;
  const inner = maxR * 0.12;
  const pitch = (maxR * 0.92 - inner) / rings;
  let r = inner;
  for (let ring = 0; ring < rings; ring++) {
    const spacing = pitch * (0.75 + rng() * 0.5);
    const forward = centre || ring % 2 === 0;
    for (let k = 0; k < segments; k++) {
      const i0 = forward ? k : segments - 1 - k;
      const i1 = centre ? (i0 + 1) % n : i0 + 1;
      const ra = Math.min(r, lengths[i0] * 0.97);
      const rb = Math.min(r + spacing / segments, lengths[i1] * 0.97);
      r += spacing / segments;
      const xa = hubX + Math.cos(angles[i0]) * ra;
      const ya = hubY + Math.sin(angles[i0]) * ra;
      const xb = hubX + Math.cos(angles[i1]) * rb;
      const yb = hubY + Math.sin(angles[i1]) * rb;
      const am = (angles[i0] + angles[i1] + (centre && i1 === 0 ? TAU : 0)) / 2;
      // Silk under tension: the sag is slight, and the chord between the
      // radials is already nearer the hub than either end.
      const sag = ((ra + rb) / 2) * Math.cos((angles[i1] - angles[i0] + (centre && i1 === 0 ? TAU : 0)) / 2) * (0.975 + rng() * 0.02);
      const mx = hubX + Math.cos(am) * sag;
      const my = hubY + Math.sin(am) * sag;
      if (rng() < 0.07) {
        // Broken: a loose end hangs from one side instead.
        const fromA = rng() < 0.5;
        const hx = fromA ? xa : xb;
        const hy = fromA ? ya : yb;
        const drop = Math.hypot(xb - xa, yb - ya) * (0.4 + rng() * 0.4);
        loose.push(hx, hy, hx + (fromA ? 1 : -1) * drop * 0.15, hy + drop * 0.5, hx + (fromA ? 1 : -1) * drop * 0.05, hy + drop);
        continue;
      }
      // The span's direction, for working out when it glints.
      spans.push(xa, ya, mx, my, xb, yb, Math.atan2(yb - ya, xb - xa));
      const beads = rng() < 0.5 ? 1 : rng() < 0.4 ? 2 : 0;
      for (let b = 0; b < beads; b++) {
        const f = 0.2 + rng() * 0.6;
        const x = (1 - f) * (1 - f) * xa + 2 * f * (1 - f) * mx + f * f * xb;
        const y = (1 - f) * (1 - f) * ya + 2 * f * (1 - f) * my + f * f * yb;
        dew.push(x, y, 0.9 + rng() * 1.1, Math.atan2(yb - ya, xb - xa));
      }
    }
  }
  state.web = { hubX, hubY, a0, a1, maxR, radials, spans, loose, dew };
  state.webKey = key;
  return state.web;
}

/**
 * Ground fog.
 *
 * It used to be invisible, and not because it was badly shaped. It mapped its
 * density straight to an alpha that topped out near 0.12, so the brightest
 * mist it could put on the wall was about a twentieth of the fog colour — and
 * the projector, the grade and the eye all work in light. That is under half a
 * per cent of white in linear terms, and every grade with any contrast in it
 * pivots it below zero before it leaves the building. Haunted clips anything
 * under about 0.14 to black, so the fog was being computed, uploaded and blitted
 * into a value that was then discarded.
 *
 * So density is now an optical depth, not an alpha. What the eye sees through a
 * fog bank is `1 - e^(-τ)`, and τ is the density times how much of the bank the
 * line of sight crosses — which at the foot of the bank is all of it. The
 * preset's 0.22 lands at about four-fifths opaque at ground level and thins to
 * nothing at the top, which is what ground fog actually looks like: you cannot
 * see the bottom of the door through it, and you can see straight over it.
 * Height is how far up the mist reaches; the body of the bank is the lower two
 * thirds of that, and the rest is its broken top.
 *
 * Three things make it a bank rather than a gradient:
 *
 * - **A cloud top.** The bank is wherever a falling gradient plus a warped
 *   noise is above zero — the way the top of a cloud is drawn. That one rule
 *   gives the surface its rounded lumps, the overhangs where the warp has
 *   rolled a billow forward, and the scraps lifting away from it, without any
 *   of them being placed. The noise counts for less near the ground, so the
 *   foot of the bank is solid rather than holed.
 * - **A swell.** How high the bank stands rises and falls along the street, a
 *   long slow swell with a shorter one on it, so the top is never ruled.
 * - **Wisps.** Over the surface, a noise squashed flat along the ground and
 *   lifting gives thin veils peeling off the bank, curled at their ends by the
 *   same divergence-free flow and torn along their length by another, so they
 *   come and go rather than running the width of the house — faint, because
 *   they are the bank coming apart, not more of it.
 *
 * And it is lit. Each column is walked from the top down, adding up the fog a
 * short way above each cell; what light gets through that is what the cell
 * scatters back. The top of every billow catches the light and goes paler, and
 * the inside of the bank is the fog colour in shade — which is the one cue that
 * turns a pale band into a volume with a top to it.
 */
const fog = {
  id: 'fog',
  name: 'Rolling Fog',
  category: 'halloween',
  scope: 'shape',
  description:
    'A low bank of mist hugging the ground: thickest at the foot, rolling along, breaking into curling wisps at the top and lit from above.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#8ea6c0' },
    { key: 'density', type: 'range', label: 'Density', default: 0.35, min: 0, max: 1, step: 0.01 },
    { key: 'scale', type: 'range', label: 'Scale', default: 2.2, min: 0.3, max: 10, step: 0.05 },
    { key: 'speed', type: 'range', label: 'Drift speed', default: 0.06, min: -0.6, max: 0.6, step: 0.005 },
    { key: 'swirl', type: 'range', label: 'Swirl', default: 0.5, min: 0, max: 2, step: 0.01 },
    { key: 'height', type: 'range', label: 'Height', default: 0.55, min: 0.05, max: 1, step: 0.01 },
    { key: 'detail', type: 'range', label: 'Detail', default: 64, min: 12, max: 120, step: 2 },
    { key: 'softness', type: 'range', label: 'Top softness', default: 0.6, min: 0, max: 1, step: 0.01 },
  ],
  draw({ g, p, stable, shape, t, state, noise }) {
    const { bbox } = shape;
    if (!(bbox.w > 2 && bbox.h > 2) || !(p.density > 0.001)) return;

    // Sized from `stable`, so a modulated Detail slider does not reallocate the
    // field every frame.
    const cols = clamp(Math.round(stable?.detail ?? p.detail), 8, 160);
    const rows = clamp(Math.round((cols * bbox.h) / bbox.w), 8, 400);
    const field = ensureField(state, 'field', cols, rows);
    field.clear();
    const cells = cols * rows;
    if (!state.dens || state.dens.length !== cells) {
      state.dens = new Array(cells).fill(0);
      state.wisp = new Array(cells).fill(0);
    }
    const dens = state.dens;
    const wisp = state.wisp;

    // Height is how far up the mist reaches. The body of the bank — the part
    // you cannot see through — is the lower two-thirds of that, and the rest
    // is its broken top and what lifts off it.
    const height = clamp(p.height, 0.02, 1) * 0.68;
    const reach = Math.min(1, height * 1.75);
    const first = clamp(Math.floor(rows * (1 - reach)), 0, rows - 1);
    const soft = clamp(p.softness, 0, 1);
    const scale = Math.max(0.05, p.scale);
    const drift = t * p.speed;
    // Isotropic noise coordinates, then flattened: a fog bank's billows are
    // wider than they are tall, which is half of what makes it lie down.
    const aspect = bbox.h / bbox.w;
    const yScale = scale * aspect * 1.5;
    const warp = p.swirl * 0.35;
    const rise = t * (0.035 + Math.abs(p.speed) * 0.6);
    // How fast the bank thins with height. Steep is a crisp top the noise can
    // only nibble at; shallow lets it eat a long way down.
    const steep = 2.1 - soft * 1.2;

    // The swirl is smooth on a scale much bigger than a cell, so it is worked
    // out on a lattice of every other cell and interpolated: a quarter of the
    // curl evaluations for a warp nobody could tell apart from the full one.
    const lw = (cols >> 1) + 2;
    const lh = (rows >> 1) + 2;
    if (!state.warpX || state.warpX.length !== lw * lh) {
      state.warpX = new Array(lw * lh).fill(0);
      state.warpY = new Array(lw * lh).fill(0);
    }
    const warpX = state.warpX;
    const warpY = state.warpY;
    for (let ly = first >> 1; ly < lh; ly++) {
      const hgt = 1 - (ly * 2 + 0.5) / rows;
      for (let lx = 0; lx < lw; lx++) {
        const u = (lx * 2 + 0.5) / cols;
        const curl = curlAt(noise, u * scale * 0.6 + drift * 0.5, hgt * yScale * 0.6, t * 0.06);
        warpX[ly * lw + lx] = curl[0] * warp;
        warpY[ly * lw + lx] = curl[1] * warp;
      }
    }

    for (let x = 0; x < cols; x++) {
      const u = (x + 0.5) / cols;
      const X = u * scale;
      // How high the bank stands in this column, as a fraction of the shape:
      // a long slow swell with a shorter one on it, so the surface rises and
      // falls along the street in every frame rather than only in some.
      const top = height * (1 + 0.2 * noise.noise2(X * 0.45 + drift * 0.6, t * 0.03)
        + 0.13 * noise.noise2(X * 1.3 - drift * 0.3 + 4.4, t * 0.05 + 2.2));

      for (let y = first; y < rows; y++) {
        const hgt = 1 - (y + 0.5) / rows;
        const rel = hgt / top;
        if (rel > 1.6) {
          dens[y * cols + x] = 0;
          wisp[y * cols + x] = 0;
          continue;
        }
        // Bilinear in the warp lattice.
        const gx = x * 0.5;
        const gy = y * 0.5;
        const ix = gx | 0;
        const iy = gy | 0;
        const fx = gx - ix;
        const fy = gy - iy;
        const i00 = iy * lw + ix;
        const wx = (warpX[i00] * (1 - fx) + warpX[i00 + 1] * fx) * (1 - fy)
          + (warpX[i00 + lw] * (1 - fx) + warpX[i00 + lw + 1] * fx) * fy;
        const wy = (warpY[i00] * (1 - fx) + warpY[i00 + 1] * fx) * (1 - fy)
          + (warpY[i00 + lw] * (1 - fx) + warpY[i00 + lw + 1] * fx) * fy;
        const sx = X + drift + wx;
        const sy = hgt * yScale + wy;

        /**
         * The bank is where a falling gradient plus a warped noise is above
         * zero — the way a cloud top is drawn. Full at the ground, gone a
         * little above the bank's nominal top, and the noise decides where
         * round that the edge actually is. That one rule gives the surface its rounded lumps, the
         * overhangs where the warp has rolled a billow forward, and the
         * scraps that have come away from the top and are lifting off as
         * wisps, without any of them being drawn on purpose.
         *
         * The second octave is stretched along the ground and lifts as it
         * goes, so what tears off the top tears into flat veils.
         */
        const n1 = noise.noise3(sx, sy, t * 0.04);
        const n2 = noise.noise3(sx * 1.9 + 4.1, sy * 3.6 - rise * yScale * 2 - 1.7, t * 0.07);
        const fbm = 0.68 * n1 + 0.32 * n2;
        // The noise matters less the nearer the ground: the foot of a bank is
        // solid, and holes punched through it read as dirt on the lens.
        const d = (1 - rel) * steep + fbm * (0.28 + 0.42 * Math.min(1, rel)) - 0.08;
        let v = 0;
        if (rel > 0.75) {
          // Wisps over the surface: a noise squashed along the ground and
          // lifting, so its peaks are long thin veils rather than blobs, and
          // faint — they are the bank coming apart, not more of it. Squashed
          // only so far: much thinner than two cells and the grid shows
          // through as a string of beads.
          const w = noise.noise3(sx * 0.9 + 71.3, sy * 3.3 - rise * yScale * 3, t * 0.06) - 0.22;
          if (w > 0) {
            // And torn along their length by a second noise, so a veil comes
            // and goes across the street. Left whole, the warp could bend one
            // into a single smooth ribbon the width of the house, which reads
            // as a stage effect rather than as mist.
            const torn = clamp(0.45 + 1.3 * noise.noise3(sx * 1.6 - 9.1, sy * 1.4 + 2.3, t * 0.08), 0, 1);
            v = w * 0.95 * torn * Math.min(1, (rel - 0.75) * 4) * Math.exp(-(rel - 1) * 2.2);
          }
        }
        dens[y * cols + x] = d > 0 ? d : 0;
        wisp[y * cols + x] = v;
      }
    }

    // The fog colour, in linear light: in shade inside the bank, and paler and
    // pushed towards white where it catches the light.
    linearRgb(p.color, RGB);
    const fr = RGB[0];
    const fg = RGB[1];
    const fb = RGB[2];

    // Optical depth: how much of the bank one cell's worth of density is.
    const tauCell = clamp(p.density, 0, 1) * 7.2;
    // The shading only looks a short way up. Light inside fog is diffuse, so a
    // billow is shadowed by the fog just above it and not by a wisp half the
    // wall away — and a running total that never forgot turned every wisp into
    // a dark stripe down the whole column under it.
    const shadeCell = 9 / Math.max(1, rows * reach);
    const forget = Math.exp(-6 / Math.max(1, rows * reach));
    for (let x = 0; x < cols; x++) {
      let above = 0;
      for (let y = first; y < rows; y++) {
        const i = y * cols + x;
        const d = dens[i];
        const total = d + wisp[i];
        above *= forget;
        if (total <= 0.004) continue;
        const alpha = 1 - Math.exp(-total * tauCell);
        if (alpha < 0.006) continue;
        // Light reaching this cell through the fog just above it. Only the
        // bank casts shade: a wisp is too thin to, and letting it drew a dark
        // halo on the bank under every one.
        const light = Math.exp(-above);
        above += d * shadeCell;
        // Worked out exactly per cell rather than looked up in a short ramp:
        // sixteen steps of shading showed as contour lines inside the bank.
        const white = 0.2 * light * light;
        const keep = (0.84 + 0.36 * light) * (1 - white);
        field.set(x, y, srgbByte(fr * keep + white), srgbByte(fg * keep + white), srgbByte(fb * keep + white), alpha);
      }
    }

    g.save();
    g.clip(shape.path);
    field.blit(g, bbox.x, bbox.y, bbox.w, bbox.h);
    g.restore();
  },
};

/**
 * A plume of smoke, lit.
 *
 * The old one could not be seen, for a reason worth spelling out because it is
 * so easy to get backwards: it shaded its dense core *darker* — the right
 * instinct for paint, where smoke in front of a white wall is grey — and then
 * handed that to a projector, which cannot make anything darker. Its thickest,
 * most important part came out as the least light it emitted, the thin edges
 * were too faint to clear the grade, and the plume vanished from the middle
 * outwards.
 *
 * Smoke you can see at night is smoke that is *lit*. So this one is: there is a
 * light above it and a little to one side, and each cell is as bright as the
 * light that reaches it through the rest of the plume. A short march from every
 * cell towards the lamp adds up the smoke in the way, and `e^(-τ)` of that is
 * what gets through. The top of every puff catches it and goes pale; the
 * underside sits in the plume's own shadow, in the dense colour. That one term
 * is what makes a volume out of a smudge — it is how the eye reads the
 * roundness of a puff — and it costs a handful of array reads per cell, no
 * noise at all.
 *
 * Opacity is optical depth again, as with the fog, and the shape is a plume in
 * the strict sense: narrow and dense at the mouth, widening as it climbs, bent
 * by a slow crosswind. Its puffs rise with it, small and tight near the source
 * and larger and lazier higher up — two octaves at fixed sizes, cross-faded
 * with height, so they can scroll upwards together without being stretched —
 * and a fine octave tears their edges into wisps as it thins out.
 */
const smoke = {
  id: 'smoke',
  name: 'Smoke',
  category: 'halloween',
  scope: 'shape',
  description:
    'A rising plume, lit from above and shadowed by itself: dense and billowing at the source, widening, bending and tearing into wisps as it climbs.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#b7bfca' },
    { key: 'shadow', type: 'color', label: 'Dense colour', default: '#3c424b' },
    { key: 'density', type: 'range', label: 'Density', default: 0.6, min: 0, max: 1.5, step: 0.01 },
    { key: 'rise', type: 'range', label: 'Rise speed', default: 0.35, min: 0.01, max: 2, step: 0.01 },
    { key: 'spread', type: 'range', label: 'Spread', default: 0.5, min: 0.05, max: 1.5, step: 0.01 },
    { key: 'swirl', type: 'range', label: 'Swirl', default: 0.8, min: 0, max: 3, step: 0.01 },
    { key: 'scale', type: 'range', label: 'Scale', default: 2.6, min: 0.3, max: 10, step: 0.05 },
    { key: 'sourceX', type: 'range', label: 'Source X', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'detail', type: 'range', label: 'Detail', default: 72, min: 12, max: 120, step: 2 },
    { key: 'lift', type: 'range', label: 'Dissipation', default: 0.85, min: 0.05, max: 1, step: 0.01 },
  ],
  draw({ g, p, stable, shape, t, state, noise }) {
    const { bbox } = shape;
    if (!(bbox.w > 2 && bbox.h > 2) || !(p.density > 0.001)) return;

    // `detail` cells along the longer side, so a doorway gets square cells
    // rather than fifty slivers across and a hundred and twenty down — the old
    // grid spent five times the work on a door for detail nobody could see.
    const long = Math.max(bbox.w, bbox.h);
    const detail = clamp(Math.round(stable?.detail ?? p.detail), 8, 200);
    const cols = clamp(Math.round((detail * bbox.w) / long), 6, 200);
    const rows = clamp(Math.round((detail * bbox.h) / long), 6, 200);
    const field = ensureField(state, 'field', cols, rows);
    field.clear();
    const cells = cols * rows;
    if (!state.dens || state.dens.length !== cells) state.dens = new Array(cells).fill(0);
    const dens = state.dens;

    // Everything in units of the longer side, so the plume keeps its shape on
    // a tall door and a wide wall alike.
    const W = bbox.w / long;
    const Hh = bbox.h / long;
    const top = Hh * clamp(p.lift, 0.05, 1);
    const scale = Math.max(0.05, p.scale);
    const spread = Math.max(0.02, p.spread);
    const climb = t * p.rise * 0.55;
    const warp = p.swirl * 0.22;
    const sourceX = clamp(p.sourceX, 0, 1) * W;

    // The swirl on a lattice of every other cell, as the fog does it: the warp
    // is far smoother than a cell, and this is most of the noise calls saved.
    const lw = (cols >> 1) + 2;
    const lh = (rows >> 1) + 2;
    if (!state.warpX || state.warpX.length !== lw * lh) {
      state.warpX = new Array(lw * lh).fill(0);
      state.warpY = new Array(lw * lh).fill(0);
    }
    const warpX = state.warpX;
    const warpY = state.warpY;
    for (let ly = 0; ly < lh; ly++) {
      const sy = ((1 - (ly * 2 + 0.5) / rows) * Hh - climb) * scale;
      for (let lx = 0; lx < lw; lx++) {
        const sx = ((lx * 2 + 0.5) / cols) * W * scale;
        const curl = curlAt(noise, sx * 0.7, sy * 0.7, t * 0.08);
        warpX[ly * lw + lx] = curl[0] * warp;
        warpY[ly * lw + lx] = curl[1] * warp;
      }
    }

    for (let y = 0; y < rows; y++) {
      const hy = (1 - (y + 0.5) / rows) * Hh;
      const s = hy / top;
      if (s >= 1) {
        for (let x = 0; x < cols; x++) dens[y * cols + x] = 0;
        continue;
      }
      // Wider as it climbs, and bent by a slow crosswind that pushes the upper
      // part about more than the root.
      const half = spread * (0.08 + 0.36 * s);
      const bend = spread * 0.45 * s * s * noise.noise2(s * 1.1 - climb * 0.7, t * 0.12 + 3.3);
      const fade = (1 - s) ** 0.6;
      // Dense at the mouth: it has not mixed with any air yet.
      const mouth = 1 + 0.6 * (1 - s) ** 4;
      // The puffs grow with the plume: small and tight at the source, large
      // and lazy high up. Two octaves at fixed sizes, cross-faded with height,
      // so they can scroll upwards at one speed without being stretched.
      const small = 1 - s;

      for (let x = 0; x < cols; x++) {
        const px = ((x + 0.5) / cols) * W;
        const dx = (px - sourceX - bend) / half;
        if (dx * dx > 7) {
          dens[y * cols + x] = 0;
          continue;
        }
        const profile = Math.exp(-dx * dx * 0.7);

        const gx = x * 0.5;
        const gy = y * 0.5;
        const ix = gx | 0;
        const iy = gy | 0;
        const fx = gx - ix;
        const fy = gy - iy;
        const i00 = iy * lw + ix;
        const wx = (px - bend * 0.5) * scale
          + (warpX[i00] * (1 - fx) + warpX[i00 + 1] * fx) * (1 - fy)
          + (warpX[i00 + lw] * (1 - fx) + warpX[i00 + lw + 1] * fx) * fy;
        const wy = (hy - climb) * scale
          + (warpY[i00] * (1 - fx) + warpY[i00 + 1] * fx) * (1 - fy)
          + (warpY[i00 + lw] * (1 - fx) + warpY[i00 + lw + 1] * fx) * fy;
        const nSmall = noise.noise3(wx * 1.9 + 7.3, wy * 1.9, t * 0.14);
        const nBig = noise.noise3(wx, wy, t * 0.07);
        const nFine = noise.noise3(wx * 4.3 - 3.1, wy * 4.3 + 5.9, t * 0.2);
        // Round puffs come from the tops of a smooth noise, cut off by the
        // erosion below — not from |n|, whose creases leave every puff the
        // shape of a leaf. The fine octave is what tears the edges.
        const billow = small * (0.5 + 0.5 * nSmall + 0.22 * nBig) + (1 - small) * (0.5 + 0.55 * nBig)
          + 0.2 * nFine;
        // The noise eats the edges, so the outline is a run of lumps rather
        // than the side of a Gaussian.
        const d = (profile * (0.25 + 1.1 * billow) - (1 - billow) * (1 - profile) * 0.7) * fade * mouth;
        dens[y * cols + x] = d > 0 ? d : 0;
      }
    }

    // Lit and shadow colours in linear light, mixed per cell by how much light
    // gets through.
    linearRgb(p.color, RGB);
    const lr = RGB[0];
    const lg = RGB[1];
    const lb = RGB[2];
    linearRgb(p.shadow, RGB);
    const sr = RGB[0];
    const sg = RGB[1];
    const sb = RGB[2];

    const tau = clamp(p.density, 0, 2) * 2.8;
    // The lamp is above and a little to the left. March towards it a cell up
    // at a time and a third of a cell across, reading between columns, so the
    // shading follows the puffs rather than stepping along a diagonal.
    const marchK = 6 / Math.max(6, rows * 0.12);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const d = dens[y * cols + x];
        if (d <= 0.004) continue;
        const alpha = 1 - Math.exp(-d * tau);
        if (alpha < 0.006) continue;
        let inWay = 0;
        for (let k = 1; k <= SMOKE_MARCH; k++) {
          const my = y - k;
          const mxf = x - k * 0.35;
          if (my < 0 || mxf < 0) break;
          const mx = mxf | 0;
          const f = mxf - mx;
          const row = my * cols;
          inWay += dens[row + mx] * (1 - f) + (mx + 1 < cols ? dens[row + mx + 1] : 0) * f;
        }
        // A floor of sky light, so the shadow side is dim rather than gone.
        const lit = 0.24 + 0.76 * Math.exp(-inWay * marchK * tau * 0.26);
        field.set(
          x, y,
          srgbByte(sr + (lr - sr) * lit),
          srgbByte(sg + (lg - sg) * lit),
          srgbByte(sb + (lb - sb) * lit),
          alpha
        );
      }
    }

    g.save();
    g.clip(shape.path);
    field.blit(g, bbox.x, bbox.y, bbox.w, bbox.h);
    g.restore();
  },
};

/** How far each smoke cell looks towards its lamp. */
const SMOKE_MARCH = 6;

/**
 * A door that has become somewhere else.
 *
 * The old portal was five thick translucent strokes round a white dot — a
 * pinwheel, and a flat one. What reads as a hole in the world is depth and
 * flow: a whirlpool of light whose arms wind tighter and spin faster towards
 * the middle, everything in it being drawn inwards, a bright rim where it meets
 * the door, and a throat at the centre too bright to see into.
 *
 * So it is a field, worked out per cell like the fog, in the coordinates a
 * whirlpool actually has. Around the centre the angle is twisted by the log of
 * the distance — the spiral every vortex makes, from a bath plug to a galaxy —
 * and turned with time, so the inner part goes round faster than the outer.
 * The distance itself is a log too, scrolling inwards, so whatever is in the
 * swirl is carried down into the throat and shrinks as it goes. A turbulent
 * noise sampled in those coordinates gives ragged, streaming arms rather than
 * ruled ones; the set number of arms comes from a cosine on the twisted angle.
 *
 * Colour runs from the outer colour at the rim, through the inner colour, to
 * white at the core, mixed in linear light; the rim is a bright, ragged ring,
 * and a little of the light spills past it onto the frame. It is added to the
 * door, as light — the door is still faintly there behind it.
 */
const portal = {
  id: 'portal',
  name: 'Portal',
  category: 'halloween',
  scope: 'shape',
  description: 'A whirlpool of light filling the shape: streaming arms winding into a white-hot throat, a ragged bright rim, everything drawn inwards. Doors become somewhere else.',
  params: [
    { key: 'color', type: 'color', label: 'Inner', default: '#8a2be2' },
    { key: 'color2', type: 'color', label: 'Outer', default: '#00ffc8' },
    { key: 'arms', type: 'range', label: 'Arms', default: 5, min: 1, max: 16, step: 1 },
    { key: 'twist', type: 'range', label: 'Twist', default: 3, min: 0, max: 12, step: 0.1 },
    { key: 'speed', type: 'range', label: 'Speed', default: 0.5, min: -3, max: 3, step: 0.01 },
    { key: 'detail', type: 'range', label: 'Detail', default: 72, min: 12, max: 200, step: 1 },
    { key: 'core', type: 'range', label: 'Core size', default: 0.15, min: 0, max: 0.8, step: 0.01 },
  ],
  draw({ g, p, stable, shape, t, state, noise }) {
    const { bbox } = shape;
    if (!(bbox.w > 2 && bbox.h > 2)) return;

    // `detail` cells along the longer side, square cells.
    const long = Math.max(bbox.w, bbox.h);
    const detail = clamp(Math.round(stable?.detail ?? p.detail), 8, 200);
    const cols = clamp(Math.round((detail * bbox.w) / long), 6, 200);
    const rows = clamp(Math.round((detail * bbox.h) / long), 6, 200);
    const field = ensureField(state, 'field', cols, rows);
    field.clear();

    // Colours in linear light: outer, inner, and the core's white.
    const outer = linearRgb(p.color2, [0, 0, 0]);
    const inner = linearRgb(p.color, [0, 0, 0]);
    const arms = Math.max(1, Math.round(p.arms));
    const twist = p.twist;
    const spin = t * p.speed;
    const inflow = t * (0.25 + Math.abs(p.speed) * 0.35);
    const core = clamp(p.core, 0, 0.8);
    // The portal is an ellipse inscribed in the shape, a little inside it so
    // the rim's glow has somewhere to spill.
    const rx = bbox.w * 0.46;
    const ry = bbox.h * 0.46;
    // The whirlpool: the angle twisted by the log of the distance. Turning the
    // whole of it and scrolling the log inwards are the same motion on a log
    // spiral — the arms wind in — and neither winds it any tighter with time.
    // Spinning the middle faster than the rim did, and after a few seconds the
    // arms had been wound into a stack of rings.
    const swirlAt = (dx, dy, rho) => Math.atan2(dy, dx) + twist * (Math.log(rho + 0.04) + inflow) * 0.6 + spin;

    // The turbulence in the arms, on a lattice of every other cell and
    // interpolated: it is smooth on the scale of a cell, and it is where nearly
    // all the time went.
    const lw = (cols >> 1) + 2;
    const lh = (rows >> 1) + 2;
    if (!state.swirl || state.swirl.length !== lw * lh) state.swirl = new Array(lw * lh).fill(0);
    const lattice = state.swirl;
    for (let ly = 0; ly < lh; ly++) {
      const dy = ((((ly * 2 + 0.5) / rows) * bbox.h) - bbox.h / 2) / ry;
      for (let lx = 0; lx < lw; lx++) {
        const dx = ((((lx * 2 + 0.5) / cols) * bbox.w) - bbox.w / 2) / rx;
        const rho = Math.sqrt(dx * dx + dy * dy);
        if (rho > 1.6) {
          lattice[ly * lw + lx] = 0;
          continue;
        }
        const swirl = swirlAt(dx, dy, rho);
        const c = Math.cos(swirl);
        const s = Math.sin(swirl);
        const lr = Math.log(rho + 0.04);
        lattice[ly * lw + lx] = noise.noise3(c * 1.6, s * 1.6, lr * 1.8 + inflow)
          + 0.5 * noise.noise3(c * 3.4 + 5.2, s * 3.4, lr * 3.6 + inflow * 1.7);
      }
    }

    for (let y = 0; y < rows; y++) {
      const dy = (((y + 0.5) / rows) * bbox.h - bbox.h / 2) / ry;
      for (let x = 0; x < cols; x++) {
        const dx = (((x + 0.5) / cols) * bbox.w - bbox.w / 2) / rx;
        const rho = Math.sqrt(dx * dx + dy * dy);
        if (rho > 1.35) continue;
        const swirl = swirlAt(dx, dy, rho);
        const gx = x * 0.5;
        const gy = y * 0.5;
        const ix = gx | 0;
        const iy = gy | 0;
        const fx = gx - ix;
        const fy = gy - iy;
        const i00 = iy * lw + ix;
        const n = (lattice[i00] * (1 - fx) + lattice[i00 + 1] * fx) * (1 - fy)
          + (lattice[i00 + lw] * (1 - fx) + lattice[i00 + lw + 1] * fx) * fy;
        const arm = 0.5 + 0.5 * Math.cos(arms * swirl + n * 1.3);
        let I;
        if (rho <= 1) {
          // Streaming arms, brighter as they go down, and a glow that fills
          // in under the rim.
          const depth = 1 - rho;
          I = (0.08 + 0.92 * arm * arm) * (0.5 + 0.8 * depth) * (0.8 + 0.4 * n)
            + 0.35 * Math.exp(-(((rho - 0.9) / 0.12) ** 2));
          // The throat.
          if (core > 0) I += Math.exp(-((rho / Math.max(0.03, core)) ** 2)) * 1.6;
        } else {
          // Spill past the rim onto whatever is round the door.
          I = Math.exp(-(rho - 1) * 7) * 0.4 * (0.8 + 0.3 * n);
        }
        if (I <= 0.01) continue;
        // Outer colour at the rim, inner deeper in, white at the core.
        const k = smoothstep(0.25, 0.95, rho);
        const white = clamp(I - 1, 0, 1) * 0.7 + (core > 0 ? Math.exp(-((rho / Math.max(0.03, core * 1.3)) ** 2)) * 0.9 : 0);
        const level = Math.min(1, I);
        const r = (inner[0] + (outer[0] - inner[0]) * k) * level;
        const gg = (inner[1] + (outer[1] - inner[1]) * k) * level;
        const b = (inner[2] + (outer[2] - inner[2]) * k) * level;
        field.set(
          x, y,
          srgbByte(r + (1 - r) * white),
          srgbByte(gg + (1 - gg) * white),
          srgbByte(b + (1 - b) * white),
          clamp(level + white, 0, 1)
        );
      }
    }

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';
    field.blit(g, bbox.x, bbox.y, bbox.w, bbox.h);

    // The rim, drawn as a line rather than in the field: it is the one sharp
    // thing in the picture, and a cell-wide ring blown up twenty times comes
    // out in steps. Frayed by a noise round its length that crawls with the
    // spin, and stroked as light — wide and faint, then tight and bright.
    const cx = bbox.cx;
    const cy = bbox.cy;
    for (let i = 0; i < PORTAL_RIM; i++) {
      const a = (i / PORTAL_RIM) * TAU;
      const fray = 1 + 0.035 * noise.noise2(Math.cos(a) * 2 + spin * 0.7, Math.sin(a) * 2 + 3.3)
        + 0.02 * noise.noise2(a * 3 + spin * 2.1, 9.1);
      RIM_X[i] = cx + Math.cos(a) * rx * 0.93 * fray;
      RIM_Y[i] = cy + Math.sin(a) * ry * 0.93 * fray;
    }
    RIM_X[PORTAL_RIM] = RIM_X[0];
    RIM_Y[PORTAL_RIM] = RIM_Y[0];
    RIM_X[PORTAL_RIM + 1] = RIM_X[1];
    RIM_Y[PORTAL_RIM + 1] = RIM_Y[1];
    const rimW = Math.min(bbox.w, bbox.h) * 0.02;
    const bright = mixLinear(p.color2, '#ffffff', 0.55);
    g.lineJoin = 'round';
    const alpha = g.globalAlpha;
    for (const [width, opacity, colour] of [[6, 0.12, p.color2], [2.6, 0.35, p.color2], [1, 0.9, bright]]) {
      g.strokeStyle = colour;
      g.globalAlpha = alpha * opacity;
      g.lineWidth = Math.max(1, rimW * width);
      g.beginPath();
      curveThrough(g, RIM_X, RIM_Y, PORTAL_RIM + 2, { move: true });
      g.stroke();
    }
    g.restore();
  },
};

/** Points round the portal's rim, and scratch for them. */
const PORTAL_RIM = 64;
const RIM_X = new Array(PORTAL_RIM + 2).fill(0);
const RIM_Y = new Array(PORTAL_RIM + 2).fill(0);

export default [bloodDrip, lightning, fire, candle, eyes, silhouette, ghost, web, fog, smoke, portal];
