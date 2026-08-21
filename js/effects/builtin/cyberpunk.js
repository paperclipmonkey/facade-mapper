/**
 * Neon, and the city it belongs to.
 *
 * The look everybody means by "cyberpunk" — Blade Runner, Altered Carbon,
 * Cyberpunk 2077 — is not really about the future. It is about a *wet* street
 * at night lit entirely by signage: no daylight, no sky, and every surface
 * taking its colour from something advertising at it. That is very close to
 * what a projector on a house is already doing, which is why it works so well
 * here and why these three effects are all about light hitting a wall rather
 * than about robots.
 *
 * Three pieces, because that is what the look is made of:
 *
 *   - **Neon** round the openings. Real neon is a glass tube: a saturated
 *     coloured halo around a core so bright it reads white, and it *strikes*
 *     rather than switching on.
 *   - **A sign** with Japanese lettering, vertical, high up. The lettering is
 *     doing the same job the Blade Runner signage does — it says the city is
 *     bigger and older than the shot, and you are not the intended reader.
 *   - **A hologram** over the brickwork: a projected advert with scanlines,
 *     colour fringing and the occasional tear.
 *
 * Two practical notes, both learned the hard way.
 *
 * Neither `ctx.shadowBlur` nor `ctx.filter` appears anywhere below, though a
 * glow is exactly what they are for. Both are per-draw-call full-layer
 * compositing operations, and a sign with twenty glyphs would pay for twenty of
 * them every frame. Three concentric strokes of decreasing width and increasing
 * alpha give a better tube anyway — a real one has a hard core, and a Gaussian
 * blur does not.
 *
 * And the Japanese lettering needs a font with Japanese in it. Every current
 * macOS, Windows and Android has one; a bare Linux box may not, and there is no
 * webfont to fall back on because the app ships no webfonts at all — it has to
 * keep working on a static host with no network. If the glyphs come out as
 * empty boxes, that is the machine, not the effect: install Noto Sans CJK, or
 * type Latin text into the same field, which works perfectly well.
 */

import { rgba, clamp, frac, makeRng, hashString } from '../../core/math.js';
import { glow } from '../lib.js';

/**
 * A font stack with Japanese in it, in the order the platforms actually ship.
 *
 * Hiragino is macOS, Yu Gothic and Meiryo are Windows, Noto is Android and most
 * Linux distributions, IPAGothic is what Debian installs with the Japanese
 * language pack. The Latin fallbacks at the end are not decoration: they are
 * what makes the effect still readable when somebody types English into it.
 */
const JP_STACK = '"Hiragino Kaku Gothic ProN", "Yu Gothic", Meiryo, "Noto Sans CJK JP", "Noto Sans JP", IPAGothic, "MS Gothic", system-ui, sans-serif';

/**
 * How a neon tube behaves over time, as one number.
 *
 * Three things are going on and they are all worth having:
 *
 *   - **Strike.** A cold tube does not light; it stutters, catches, drops out
 *     and catches again over about a third of a second. It is the single most
 *     recognisable thing neon does, and a sign that simply sits there lit is
 *     the thing that reads as a graphic rather than as a light.
 *   - **Buzz.** A lit tube is running on mains AC, so its output ripples at
 *     twice the mains frequency. Far too fast to see directly, but a small
 *     ripple stops the brightness being mathematically constant, which the eye
 *     does notice.
 *   - **Age.** An old tube is dimmer at one end and flickers at random.
 *
 * Derived entirely from `t` and a key, so nothing is remembered and every tab
 * strikes at the same instant.
 */
function tubeBrightness(t, p, key) {
  const buzz = 1 - 0.04 * p.buzz * (0.5 + 0.5 * Math.sin(t * 30.2));
  if (p.flicker <= 0) return buzz;

  // One attempt to strike every few seconds; most of them are uneventful.
  const period = 6.5;
  const cycle = Math.floor(t / period);
  const rng = makeRng(`${key}:${cycle}`);
  const chance = clamp(p.flicker, 0, 1);
  if (rng() > chance) return buzz;

  const at = rng() * (period - 0.6);
  const into = (t - cycle * period) - at;
  if (into < 0 || into > 0.42) return buzz;

  // A ragged square wave: on, off, on-on, off, on. Not a sine — a gas discharge
  // is either struck or it is not, and the in-between is what makes a fade
  // look like a dimmer rather than a fault.
  const beats = [1, 0, 1, 1, 0, 0.6, 1, 0, 1];
  const i = Math.min(beats.length - 1, Math.floor((into / 0.42) * beats.length));
  return buzz * beats[i];
}

/**
 * Lay a neon tube down along the current path or a supplied one.
 *
 * Four passes, widest and faintest first: outer bloom, inner bloom, the glass
 * tube itself in a lighter version of the gas colour, and a core that is nearly
 * white because a real tube's core is saturating your eye. Reversing that order
 * or dropping the core is the difference between neon and a coloured line.
 */
function strokeNeon(g, path, width, colour, core, bright, level) {
  if (bright <= 0.01) return;
  const passes = [
    [width * 4.5, 0.06 * level],
    [width * 2.2, 0.14 * level],
    [width * 1.0, 0.55 * level],
  ];
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const [w, a] of passes) {
    g.lineWidth = w;
    g.strokeStyle = rgba(colour, a * bright);
    if (path) g.stroke(path);
    else g.stroke();
  }
  g.lineWidth = Math.max(1, width * 0.4);
  g.strokeStyle = rgba(core, 0.95 * bright * level);
  if (path) g.stroke(path);
  else g.stroke();
}

/* ------------------------------------------------------------------ *
 * Neon tube
 * ------------------------------------------------------------------ */

const neon = {
  id: 'neon',
  name: 'Neon Tube',
  category: 'cyberpunk',
  scope: 'shape',
  description:
    'A glass neon tube bent round the shape, with the halo, the white-hot core and the stutter a cold tube makes when it strikes. Aim it at every window and the house turns into a shopfront.',
  params: [
    { key: 'color', type: 'color', label: 'Gas colour', default: '#ff2a6d' },
    { key: 'core', type: 'color', label: 'Core', default: '#ffe9f4' },
    { key: 'width', type: 'range', label: 'Tube width', default: 9, min: 1, max: 60, step: 0.5 },
    { key: 'inset', type: 'range', label: 'Second tube inside', default: 0, min: 0, max: 60, step: 1 },
    { key: 'color2', type: 'color', label: 'Second gas', default: '#05d9e8' },
    { key: 'flicker', type: 'range', label: 'Strikes badly', default: 0.35, min: 0, max: 1, step: 0.01 },
    { key: 'buzz', type: 'range', label: 'Mains buzz', default: 1, min: 0, max: 3, step: 0.05 },
    { key: 'dead', type: 'range', label: 'Dead section', default: 0, min: 0, max: 0.8, step: 0.01 },
    { key: 'chase', type: 'range', label: 'Chase (laps/s)', default: 0, min: -2, max: 2, step: 0.01 },
    { key: 'spill', type: 'range', label: 'Light on the wall', default: 0.6, min: 0, max: 3, step: 0.05 },
    { key: 'level', type: 'range', label: 'Brightness', default: 1, min: 0, max: 2, step: 0.01 },
  ],
  draw({ g, p, shape, t }) {
    const bright = tubeBrightness(t, p, `neon:${shape.id}`);
    const level = clamp(p.level, 0, 3);
    if (bright <= 0.01 || level <= 0) return;

    const length = shape.sampler.length || Math.max(shape.bbox.w, shape.bbox.h);

    g.save();
    g.globalCompositeOperation = 'lighter';

    /**
     * A dead section, as a dash pattern rather than as a gap in the geometry.
     *
     * One dash the length of the live part and one gap the length of the dead
     * part gives exactly one break in the tube, wherever the offset puts it —
     * which is what a broken sign looks like. A conventional dash pattern gives
     * a dotted line, which looks like a design decision instead of a fault.
     */
    if (p.dead > 0) {
      const live = length * (1 - p.dead);
      g.setLineDash([live, length - live]);
      g.lineDashOffset = -length * frac(hashString(`${shape.id}`) / 4294967296 + t * p.chase);
    } else if (p.chase !== 0) {
      // A chase is the same trick with a short lit run travelling round.
      const lit = length * 0.22;
      g.setLineDash([lit, length - lit]);
      g.lineDashOffset = -length * frac(t * p.chase);
    }

    strokeNeon(g, shape.path, p.width, p.color, p.core, bright, level);

    if (p.inset > 0) {
      // A second tube inside the first, which is how real double-line signage
      // is made — and the cheapest way to get two gases into one shape.
      g.save();
      g.translate(shape.bbox.cx, shape.bbox.cy);
      const sx = Math.max(0.05, 1 - (p.inset * 2) / Math.max(1, shape.bbox.w));
      const sy = Math.max(0.05, 1 - (p.inset * 2) / Math.max(1, shape.bbox.h));
      g.scale(sx, sy);
      g.translate(-shape.bbox.cx, -shape.bbox.cy);
      strokeNeon(g, shape.path, p.width * 0.7, p.color2, p.core, bright, level * 0.9);
      g.restore();
    }

    g.setLineDash([]);

    /**
     * And the light the sign throws onto the wall around it.
     *
     * A sign is a light source, and the thing that makes a projected one sit on
     * a building rather than float in front of it is that the brickwork near it
     * picks up its colour. One soft radial does it.
     */
    if (p.spill > 0) {
      glow(
        g, shape.bbox.cx, shape.bbox.cy,
        Math.max(shape.bbox.w, shape.bbox.h) * 1.2,
        p.color, 0.1 * p.spill * bright * level
      );
    }

    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * Neon sign
 * ------------------------------------------------------------------ */

const neonSign = {
  id: 'neon-sign',
  name: 'Neon Sign',
  category: 'cyberpunk',
  scope: 'shape',
  description:
    'Lettering as neon tube, stacked vertically by default and framed like signage bolted to a wall. Type Japanese into it and point it at the chimney; a machine with no Japanese font will show boxes, so type anything you like instead.',
  params: [
    { key: 'text', type: 'text', label: 'Text', default: '電脳' },
    { key: 'orientation', type: 'select', label: 'Runs', default: 'down', options: ['down', 'across'] },
    { key: 'color', type: 'color', label: 'Gas colour', default: '#ff2a6d' },
    { key: 'core', type: 'color', label: 'Core', default: '#fff0f6' },
    { key: 'size', type: 'range', label: 'Size', default: 0.8, min: 0.05, max: 2, step: 0.01 },
    { key: 'weight', type: 'select', label: 'Weight', default: '700', options: ['400', '600', '700', '900'] },
    { key: 'spacing', type: 'range', label: 'Spacing', default: 1.08, min: 0.6, max: 2.5, step: 0.01 },
    { key: 'frame', type: 'range', label: 'Frame', default: 0.5, min: 0, max: 3, step: 0.05 },
    { key: 'frameColor', type: 'color', label: 'Frame gas', default: '#05d9e8' },
    { key: 'flicker', type: 'range', label: 'Strikes badly', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'buzz', type: 'range', label: 'Mains buzz', default: 1, min: 0, max: 3, step: 0.05 },
    { key: 'broken', type: 'range', label: 'One character out', default: 0.25, min: 0, max: 1, step: 0.01 },
    { key: 'subtitle', type: 'text', label: 'Small line', default: '' },
    { key: 'spill', type: 'range', label: 'Light on the wall', default: 0.8, min: 0, max: 3, step: 0.05 },
    { key: 'level', type: 'range', label: 'Brightness', default: 1, min: 0, max: 2, step: 0.01 },
  ],
  draw({ g, p, shape, t }) {
    const chars = [...String(p.text || '')].filter((c) => c.trim());
    const { bbox } = shape;
    if (!chars.length || bbox.w < 6 || bbox.h < 6) return;

    const down = p.orientation !== 'across';
    const level = clamp(p.level, 0, 3);
    const bright = tubeBrightness(t, p, `sign:${shape.id}`);
    if (level <= 0) return;

    /**
     * One character per cell down the shape, sized to fit whichever way it is
     * running — so the same sign works on a chimney (tall, narrow, one column)
     * and along a bay window (wide, short, one row) without being told which.
     */
    const along = down ? bbox.h : bbox.w;
    const across = down ? bbox.w : bbox.h;
    const cell = Math.min(along / (chars.length * p.spacing), across * 0.92);
    const px = Math.max(6, cell * clamp(p.size, 0.05, 2));

    g.save();
    g.globalCompositeOperation = 'lighter';
    g.font = `${p.weight} ${px}px ${JP_STACK}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.miterLimit = 2;

    /**
     * The dead character.
     *
     * Every neon sign that has been up for more than a year has one letter out,
     * and it is always the same letter until somebody fixes it — so it is
     * chosen from the sign's own identity rather than re-rolled, and it stays
     * dark rather than flickering. A sign where a *different* character drops
     * out each time reads as an animation; one with a permanent hole in it
     * reads as a sign nobody has maintained, which is the entire genre.
     */
    const pick = makeRng(`broken:${shape.id}:${p.text}`);
    const brokenIndex = pick() < p.broken ? Math.floor(pick() * chars.length) : -1;

    const span = chars.length * cell * p.spacing;
    const start = -span / 2 + (cell * p.spacing) / 2;

    for (let i = 0; i < chars.length; i++) {
      const offset = start + i * cell * p.spacing;
      const x = bbox.cx + (down ? 0 : offset);
      const y = bbox.cy + (down ? offset : 0);

      let charBright = bright;
      if (i === brokenIndex) {
        // Not quite dead: a tube on its way out glows faintly at the electrodes
        // and catches for a moment now and then.
        const gasp = makeRng(`gasp:${shape.id}:${Math.floor(t * 3)}`)() < 0.06 ? 1 : 0;
        charBright = 0.06 + gasp * 0.5;
      }
      if (charBright <= 0.01) continue;

      const passes = [
        [px * 0.34, 0.05 * level],
        [px * 0.16, 0.13 * level],
        [px * 0.07, 0.5 * level],
      ];
      for (const [w, a] of passes) {
        g.lineWidth = w;
        g.strokeStyle = rgba(p.color, a * charBright);
        g.strokeText(chars[i], x, y);
      }
      g.fillStyle = rgba(p.core, 0.95 * charBright * level);
      g.fillText(chars[i], x, y);
    }

    /* --- The box it is bolted into --- */

    if (p.frame > 0) {
      const pad = cell * 0.34;
      const w = (down ? cell : span) + pad * 2;
      const h = (down ? span : cell) + pad * 2;
      g.beginPath();
      g.rect(bbox.cx - w / 2, bbox.cy - h / 2, w, h);
      strokeNeon(g, null, Math.max(1.5, px * 0.06 * p.frame), p.frameColor, p.core, bright, level * 0.8);
    }

    if (p.subtitle) {
      // A Latin line under the sign, half the size, in the frame's colour.
      // Every one of these signs in every one of these films has one.
      const small = px * 0.26;
      g.font = `600 ${small}px system-ui, sans-serif`;
      const y = bbox.cy + (down ? span / 2 + small * 1.6 : cell * 0.9);
      g.lineWidth = small * 0.22;
      g.strokeStyle = rgba(p.frameColor, 0.16 * level);
      g.strokeText(p.subtitle, bbox.cx, y);
      g.fillStyle = rgba(p.core, 0.8 * bright * level);
      g.fillText(p.subtitle, bbox.cx, y);
    }

    if (p.spill > 0) {
      glow(g, bbox.cx, bbox.cy, Math.max(bbox.w, bbox.h) * 1.5, p.color, 0.12 * p.spill * bright * level);
    }

    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * Hologram
 * ------------------------------------------------------------------ */

const hologram = {
  id: 'hologram',
  name: 'Hologram',
  category: 'cyberpunk',
  scope: 'shape',
  description:
    'A projected advert over the brickwork: scrolling lettering, scanlines, colour fringing and the occasional tear. Point it at the wall.',
  params: [
    { key: 'text', type: 'text', label: 'Text', default: '新東京 · 電脳 · 未来' },
    { key: 'color', type: 'color', label: 'Colour', default: '#05d9e8' },
    { key: 'fringe', type: 'color', label: 'Fringe', default: '#ff2a6d' },
    { key: 'size', type: 'range', label: 'Size', default: 0.16, min: 0.02, max: 1, step: 0.005 },
    { key: 'columns', type: 'range', label: 'Columns', default: 3, min: 1, max: 12, step: 1 },
    { key: 'speed', type: 'range', label: 'Scroll (px/s)', default: 40, min: -400, max: 400, step: 5 },
    { key: 'scanlines', type: 'range', label: 'Scanlines', default: 4, min: 0, max: 40, step: 1 },
    { key: 'split', type: 'range', label: 'Colour fringing', default: 4, min: 0, max: 40, step: 0.5 },
    { key: 'glitch', type: 'range', label: 'Tearing', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'haze', type: 'range', label: 'Haze', default: 0.35, min: 0, max: 2, step: 0.01 },
    { key: 'level', type: 'range', label: 'Brightness', default: 1, min: 0, max: 2, step: 0.01 },
  ],
  draw({ g, p, shape, t }) {
    const { bbox } = shape;
    const chars = [...String(p.text || '')];
    if (!chars.length || bbox.w < 8 || bbox.h < 8) return;

    const level = clamp(p.level, 0, 3);
    const px = Math.max(6, Math.min(bbox.w, bbox.h) * clamp(p.size, 0.02, 1));
    const columns = Math.round(clamp(p.columns, 1, 12));

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';

    // The volume the thing is supposed to be hanging in. A hologram in a film
    // is always in slightly foggy air, because otherwise there is nothing for
    // it to be projected *onto* and it reads as a sticker.
    if (p.haze > 0) {
      const haze = g.createLinearGradient(0, bbox.y, 0, bbox.y + bbox.h);
      haze.addColorStop(0, rgba(p.color, 0.05 * p.haze * level));
      haze.addColorStop(0.5, rgba(p.color, 0.12 * p.haze * level));
      haze.addColorStop(1, rgba(p.color, 0.02 * p.haze * level));
      g.fillStyle = haze;
      g.fillRect(bbox.x, bbox.y, bbox.w, bbox.h);
    }

    g.font = `600 ${px}px ${JP_STACK}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';

    const step = px * 1.12;
    const rows = Math.ceil(bbox.h / step) + 2;
    const scroll = t * p.speed;

    for (let c = 0; c < columns; c++) {
      const x = bbox.x + ((c + 0.5) / columns) * bbox.w;
      // Each column runs at its own rate, or the whole panel reads as one
      // texture being dragged past rather than as separate strips of signage.
      const rate = 0.6 + ((c * 37) % 11) / 11;
      for (let r = -1; r < rows; r++) {
        const y = bbox.y + frac((r * step + scroll * rate) / (rows * step)) * (rows * step) - step;
        /**
         * Wrapped the long way round, because `%` in JavaScript keeps the sign
         * of its left operand: scrolling *downwards* makes the index negative,
         * `chars[-1]` is undefined, and the panel silently loses glyphs rather
         * than showing the same lettering running backwards.
         */
        const slot = r + c * 3 + Math.floor(scroll / (step * 4));
        const ch = chars[((slot % chars.length) + chars.length) % chars.length];
        if (!ch || !ch.trim()) continue;

        /**
         * The tear.
         *
         * A band of the image, a few characters tall, jumps sideways for a
         * couple of frames and snaps back. Chosen from a time bucket rather
         * than from a random number, so every tab tears the same band at the
         * same instant — a glitch that is different in each projector is a
         * glitch that stops reading as one image being disturbed.
         */
        let tear = 0;
        if (p.glitch > 0) {
          const bucket = Math.floor(t * 7);
          const rng = makeRng(`tear:${shape.id}:${bucket}`);
          if (rng() < p.glitch * 0.35) {
            const band = Math.floor(rng() * rows);
            if (Math.abs(r - band) < 2) tear = (rng() - 0.5) * bbox.w * 0.25;
          }
        }

        // Fringing: the same glyph drawn twice more, pulled apart horizontally
        // in two opposed colours. It is the cheapest possible chromatic
        // aberration and it is the single strongest "this is a projection"
        // cue there is.
        if (p.split > 0) {
          g.fillStyle = rgba(p.fringe, 0.35 * level);
          g.fillText(ch, x + tear - p.split, y);
          g.fillStyle = rgba(p.color, 0.35 * level);
          g.fillText(ch, x + tear + p.split, y);
        }
        g.fillStyle = rgba('#ffffff', 0.55 * level);
        g.fillText(ch, x + tear, y);
      }
    }

    /**
     * Scanlines, drawn last and over everything.
     *
     * Dark lines rather than bright ones, and the reason they work is that they
     * are the only part of the effect that does not move with the content: the
     * lettering scrolls *behind* a fixed comb, which is what your eye reads as
     * "this is being displayed on something" rather than "this is painted on".
     */
    if (p.scanlines > 0 && level > 0) {
      g.globalCompositeOperation = 'source-over';
      // Scaled by Brightness like everything else here. These are the one part
      // of the effect that *subtracts*, so at zero they have to go: a layer
      // turned down to nothing that still paints black bands across the
      // brickwork is not off, it is a mask.
      g.fillStyle = rgba('#000000', 0.35 * Math.min(1, level));
      const gap = Math.max(2, p.scanlines);
      for (let y = bbox.y; y < bbox.y + bbox.h; y += gap * 2) {
        g.fillRect(bbox.x, y, bbox.w, gap);
      }
    }

    g.restore();
  },
};

export default [neon, neonSign, hologram];
