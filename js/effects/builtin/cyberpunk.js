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
 * them every frame. Concentric strokes of decreasing width and increasing
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
import { mixLinear } from '../color.js';
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
 * Lay a neon tube down along the current path.
 *
 * Widest and faintest first, so the passes read outwards-in as a photograph
 * of a lit tube does:
 *
 *   - the light the tube throws on the wall round it, a long soft skirt in the
 *     gas colour — the part the Light on the wall slider scales;
 *   - the tube's own glow, tighter and stronger and properly saturated, which
 *     is where the colour of a neon sign actually lives;
 *   - the glass, the width of the tube, in the gas colour;
 *   - the core, nearly white, because the column of gas down the middle is
 *     bright enough to saturate any eye and any camera;
 *   - and a hairline highlight off-centre, the reflection a round glass tube
 *     always carries, which is the cue that it is a tube and not a stripe.
 *
 * Reversing that order or dropping the core is the difference between neon and
 * a coloured line. Six or seven passes rather than the old four, because the
 * halo was two hard-edged bands that read as outlines; geometric steps of width
 * between them approximate a smooth falloff, and the bloom does the rest.
 */
function strokeNeon(g, width, colour, core, bright, level, spill = 1) {
  if (bright <= 0.01) return;
  const halo = clamp(spill, 0, 3);
  const passes = [
    [width * 10, 0.016 * halo],
    [width * 5.2, 0.036 * halo],
    [width * 2.8, 0.1],
    [width * 1.7, 0.24],
    [width * 1.08, 0.62],
  ];
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const [w, a] of passes) {
    if (a <= 0) continue;
    g.lineWidth = w;
    g.strokeStyle = rgba(colour, Math.min(1, a * bright * level));
    g.stroke();
  }
  g.lineWidth = Math.max(1, width * 0.5);
  g.strokeStyle = rgba(core, Math.min(1, 0.9 * bright * level));
  g.stroke();
  g.lineWidth = Math.max(0.6, width * 0.18);
  g.strokeStyle = rgba('#ffffff', Math.min(1, 0.85 * bright * level));
  g.stroke();
}

/**
 * The glass highlight, along the current path, offset up and to the left — the
 * way a tube on a wall catches the light of the street. Faint, and only ever on
 * one side of the tube, which is the whole cue.
 */
function strokeGlint(g, width, bright, level) {
  if (bright <= 0.01) return;
  g.save();
  g.translate(-width * 0.26, -width * 0.26);
  g.lineWidth = Math.max(0.5, width * 0.12);
  g.strokeStyle = rgba('#ffffff', Math.min(1, 0.32 * bright * level));
  g.stroke();
  g.restore();
}

/**
 * Trace a shape's outline as bent glass: the same path, with every corner
 * rounded off to the radius a glass-bender can actually make.
 *
 * Neon is a tube heated and bent by hand, and the tightest bend it takes is a
 * couple of tube widths. A traced window has dead-square corners, and a tube
 * drawn into them comes out as a stroked rectangle with mitred joins — a
 * graphic, not glass. Rounding each corner to the bend radius (or to the most
 * the neighbouring edges allow, on a short edge) is a quadratic through the
 * corner, which costs what the corner did.
 *
 * `inset` pulls every point towards the middle of the shape first, for the
 * second tube inside the first. Done to the points, not to the context, so the
 * inner tube keeps the width it was given in both directions — scaling the
 * context to inset it stretched its strokes along whichever side was longer.
 *
 * Returns the length of the traced tube, for laying a dash pattern along it.
 */
function traceTube(g, shape, bend, inset = 0) {
  const pts = shape.points;
  const n = pts.length;
  g.beginPath();
  if (!n) return 0;
  const { bbox } = shape;
  const sx = inset > 0 ? Math.max(0.05, 1 - (inset * 2) / Math.max(1, bbox.w)) : 1;
  const sy = inset > 0 ? Math.max(0.05, 1 - (inset * 2) / Math.max(1, bbox.h)) : 1;
  const X = (i) => bbox.cx + (pts[i].x - bbox.cx) * sx;
  const Y = (i) => bbox.cy + (pts[i].y - bbox.cy) * sy;
  const closed = shape.closed && n > 2;

  if (!closed) {
    g.moveTo(X(0), Y(0));
    let length = 0;
    for (let i = 1; i < n; i++) {
      g.lineTo(X(i), Y(i));
      length += Math.hypot(X(i) - X(i - 1), Y(i) - Y(i - 1));
    }
    return length;
  }

  let length = 0;
  let started = false;
  for (let i = 0; i <= n; i++) {
    const c = i % n;
    const a = (c - 1 + n) % n;
    const b = (c + 1) % n;
    const ax = X(a) - X(c);
    const ay = Y(a) - Y(c);
    const bx = X(b) - X(c);
    const by = Y(b) - Y(c);
    const la = Math.hypot(ax, ay);
    const lb = Math.hypot(bx, by);
    if (la < 1e-6 || lb < 1e-6) continue;
    const r = Math.min(bend, la * 0.45, lb * 0.45);
    const inX = X(c) + (ax / la) * r;
    const inY = Y(c) + (ay / la) * r;
    const outX = X(c) + (bx / lb) * r;
    const outY = Y(c) + (by / lb) * r;
    if (!started) {
      g.moveTo(outX, outY);
      started = true;
      continue;
    }
    g.lineTo(inX, inY);
    g.quadraticCurveTo(X(c), Y(c), outX, outY);
    length += la - r * 2 + r * 1.6;
  }
  g.closePath();
  return length;
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

    const width = Math.max(0.5, p.width);
    const bend = width * 2.2;

    g.save();
    g.globalCompositeOperation = 'lighter';

    const length = traceTube(g, shape, bend) || shape.sampler.length || Math.max(shape.bbox.w, shape.bbox.h);
    const offset = hashString(`${shape.id}`) / 4294967296;

    /**
     * Where the tube is broken, as a dash pattern rather than as a gap in the
     * geometry.
     *
     * One dash the length of the live part and one gap the length of the dead
     * part gives exactly one break in the tube, wherever the offset puts it —
     * which is what a broken sign looks like. A conventional dash pattern gives
     * a dotted line, which looks like a design decision instead of a fault.
     *
     * A tube with nothing dead in it is still broken once, and that is not a
     * fault: a neon tube is a length of glass with an electrode sealed into
     * each end, so a tube that goes all the way round a window has to start and
     * stop somewhere. Glass-benders hide the join with a painted-out bend; what
     * shows from the street is a short dark gap with two rounded ends either
     * side of it, glowing a little where the light from the ends spills into
     * it. A closed loop of light with no join in it is the tell of a graphic.
     */
    let dashed = false;
    if (p.dead > 0) {
      const live = length * (1 - p.dead);
      g.setLineDash([live, length - live]);
      g.lineDashOffset = -length * frac(offset + t * p.chase);
      dashed = true;
    } else if (p.chase !== 0) {
      // A chase is the same trick with a short lit run travelling round.
      const lit = length * 0.22;
      g.setLineDash([lit, length - lit]);
      g.lineDashOffset = -length * frac(t * p.chase);
      dashed = true;
    } else if (shape.closed && length > width * 12) {
      const gap = width * 1.9;
      g.setLineDash([length - gap, gap]);
      g.lineDashOffset = (length - gap) - length * frac(offset * 7.31);
      dashed = true;
    }

    strokeNeon(g, width, p.color, p.core, bright, level, p.spill);
    strokeGlint(g, width, bright, level);

    if (p.inset > 0) {
      /**
       * A second tube inside the first, which is how real double-line signage
       * is made — and the cheapest way to get two gases into one shape. Its own
       * electrode break, somewhere else, because it is its own length of glass.
       *
       * Never closer to the first than two pieces of glass can be. An inset
       * smaller than the tubes are wide put the second tube *inside* the first,
       * and the two white cores ran together into one fat white band: the
       * door read as a single thick tube instead of a double one.
       */
      const inner = width * 0.7;
      const inset = Math.max(p.inset, (width + inner) * 0.62);
      const innerLength = traceTube(g, shape, inner * 2.2, inset) || length;
      if (dashed && p.dead <= 0 && p.chase === 0) {
        const gap = inner * 1.9;
        g.setLineDash([innerLength - gap, gap]);
        g.lineDashOffset = (innerLength - gap) - innerLength * frac(offset * 3.7 + 0.5);
      }
      strokeNeon(g, inner, p.color2, p.core, bright, level * 0.9, p.spill * 0.6);
      strokeGlint(g, inner, bright, level * 0.9);
    }

    g.setLineDash([]);

    /**
     * And the light the sign throws onto the opening it surrounds.
     *
     * The tube's own outer passes are the light on the wall beside it; this is
     * the faint wash it puts across the glass and the reveal inside the shape,
     * which is what makes a lit window frame read as lighting the window
     * rather than as a line drawn round it.
     */
    if (p.spill > 0) {
      glow(
        g, shape.bbox.cx, shape.bbox.cy,
        Math.max(shape.bbox.w, shape.bbox.h) * 1.1,
        p.color, 0.07 * p.spill * bright * level
      );
    }

    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * Neon sign
 * ------------------------------------------------------------------ */

/**
 * A rounded rectangle, as bent glass, into the current path. Returns its length.
 */
function traceFrame(g, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + rr, y);
  g.lineTo(x + w - rr, y);
  g.quadraticCurveTo(x + w, y, x + w, y + rr);
  g.lineTo(x + w, y + h - rr);
  g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  g.lineTo(x + rr, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - rr);
  g.lineTo(x, y + rr);
  g.quadraticCurveTo(x, y, x + rr, y);
  g.closePath();
  return 2 * (w + h) - rr * 1.7;
}

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
     * The sign is bolted *to* the shape, so it fits inside it.
     *
     * The frame used to be sized round the lettering, which was sized to the
     * shape — so a framed sign was always bigger than the thing it was bolted
     * to, and on the chimney the box hung off the top and down over the roof.
     * Now the frame is the shape less a margin, and the lettering is sized to
     * the inside of the frame. One character per cell along whichever way it
     * runs, so the same sign works on a chimney (tall, narrow, one column) and
     * along a bay window (wide, short, one row) without being told which.
     */
    const minSide = Math.min(bbox.w, bbox.h);
    const framed = p.frame > 0;
    const margin = framed ? minSide * 0.05 : minSide * 0.03;
    const boxW = Math.max(4, bbox.w - margin * 2);
    const boxH = Math.max(4, bbox.h - margin * 2);
    const pad = framed ? Math.min(boxW, boxH) * 0.05 : 0;
    const along = (down ? boxH : boxW) - pad * 2;
    const across = (down ? boxW : boxH) - pad * 2;
    const cell = Math.max(4, Math.min(along / (chars.length * p.spacing), across * 0.92));
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
    // The rim colour: the gas, lifted a little, so the edge of each stroke is
    // the most saturated bright thing on the sign.
    const rim = mixLinear(p.color, '#ffffff', 0.12);

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

      /**
       * A character as tube, inside out.
       *
       * The halo first, wide and faint and in the gas colour. Then the face of
       * the character in the core colour — the white-hot gas. Then, painted
       * *over* the face rather than added to it, a narrow band of the gas
       * colour along every edge, which leaves the white only down the middle
       * of each stroke. That is the cross-section of a lit tube: white where
       * you look through the most glowing gas, coloured at the walls, colour
       * again in the air round it. Filling the character white and stopping
       * there is a white letter with a pink glow, which is what this was.
       */
      const halos = [
        [px * 0.34, 0.04],
        [px * 0.19, 0.08],
        [px * 0.1, 0.18],
      ];
      for (const [w, a] of halos) {
        g.lineWidth = w;
        g.strokeStyle = rgba(p.color, Math.min(1, a * charBright * level));
        g.strokeText(chars[i], x, y);
      }
      g.fillStyle = rgba(p.core, Math.min(1, 0.95 * charBright * level));
      g.fillText(chars[i], x, y);
      g.globalCompositeOperation = 'source-over';
      g.lineWidth = Math.max(1, px * 0.024);
      g.strokeStyle = rgba(rim, Math.min(1, 0.92 * charBright * level));
      g.strokeText(chars[i], x, y);
      g.globalCompositeOperation = 'lighter';
    }

    /* --- The box it is bolted into --- */

    if (framed) {
      const fw = Math.max(1.5, px * 0.06 * p.frame);
      const fx = bbox.cx - boxW / 2;
      const fy = bbox.cy - boxH / 2;
      const length = traceFrame(g, fx, fy, boxW, boxH, fw * 2.2);
      // The frame is one length of glass too, with its join on the bottom edge.
      const gap = fw * 1.9;
      g.setLineDash([length - gap, gap]);
      g.lineDashOffset = (length - gap) - (boxW * 1.7 + boxH);
      strokeNeon(g, fw, p.frameColor, p.core, bright, level * 0.8, p.spill * 0.7);
      g.setLineDash([]);
    }

    if (p.subtitle) {
      // A Latin line under the sign, small, in the frame's colour. Every one of
      // these signs in every one of these films has one.
      const small = px * 0.26;
      g.font = `600 ${small}px system-ui, sans-serif`;
      const y = bbox.cy + (down ? span / 2 + small * 1.6 : cell * 0.9);
      g.lineWidth = small * 0.3;
      g.strokeStyle = rgba(p.frameColor, 0.22 * bright * level);
      g.strokeText(p.subtitle, bbox.cx, y);
      g.fillStyle = rgba(p.core, 0.85 * bright * level);
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

    /**
     * The projector's own flicker: a hologram is a picture being *made*, so its
     * brightness is never quite still — a slow wobble, and every so often a
     * dip of a few frames as if the beam had stuttered. A function of `t`, so
     * every tab dips together.
     */
    const dip = makeRng(`holo-dip:${shape.id}:${Math.floor(t * 5)}`)() < 0.04 ? 0.55 : 1;
    const wobble = (0.9 + 0.1 * Math.sin(t * 2.3) * Math.sin(t * 5.1 + 1.3)) * dip;
    const lit = level * wobble;

    // The volume the thing is supposed to be hanging in. A hologram in a film
    // is always in slightly foggy air, because otherwise there is nothing for
    // it to be projected *onto* and it reads as a sticker.
    if (p.haze > 0) {
      const haze = g.createLinearGradient(0, bbox.y, 0, bbox.y + bbox.h);
      haze.addColorStop(0, rgba(p.color, 0.05 * p.haze * lit));
      haze.addColorStop(0.5, rgba(p.color, 0.12 * p.haze * lit));
      haze.addColorStop(1, rgba(p.color, 0.02 * p.haze * lit));
      g.fillStyle = haze;
      g.fillRect(bbox.x, bbox.y, bbox.w, bbox.h);
    }

    /**
     * The refresh band: a soft bright bar rolling slowly down the picture, the
     * way a scanned display shows its refresh to a camera. It is the one moving
     * thing in the picture that is not the content, and it is what says
     * "display" rather than "lettering".
     */
    const roll = frac(t * 0.11 + (hashString(`${shape.id}`) % 997) / 997);
    const bandY = bbox.y - bbox.h * 0.15 + roll * bbox.h * 1.3;
    const band = g.createLinearGradient(0, bandY - bbox.h * 0.12, 0, bandY + bbox.h * 0.12);
    band.addColorStop(0, rgba(p.color, 0));
    band.addColorStop(0.5, rgba(p.color, 0.06 * lit));
    band.addColorStop(1, rgba(p.color, 0));
    g.fillStyle = band;
    g.fillRect(bbox.x, bandY - bbox.h * 0.12, bbox.w, bbox.h * 0.24);

    g.font = `600 ${px}px ${JP_STACK}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';

    const step = px * 1.12;
    const rows = Math.ceil(bbox.h / step) + 2;
    const scroll = t * p.speed;
    // The lettering's own colour: the projector's colour pushed most of the way
    // to white, so the characters are the brightest thing in it and readable,
    // but still unmistakably that colour rather than print on a wall.
    const face = mixLinear(p.color, '#ffffff', 0.55);

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
            const band2 = Math.floor(rng() * rows);
            if (Math.abs(r - band2) < 2) tear = (rng() - 0.5) * bbox.w * 0.25;
          }
        }

        // Fringing: the same glyph drawn twice more, pulled apart horizontally
        // in two opposed colours. It is the cheapest possible chromatic
        // aberration and it is the single strongest "this is a projection"
        // cue there is. Fainter than the face, so it reads as fringing round a
        // character rather than as two more characters.
        if (p.split > 0) {
          g.fillStyle = rgba(p.fringe, 0.26 * lit);
          g.fillText(ch, x + tear - p.split, y);
          g.fillStyle = rgba(p.color, 0.3 * lit);
          g.fillText(ch, x + tear + p.split, y);
        }
        g.fillStyle = rgba(face, 0.72 * lit);
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
     * Thinner than the gaps between them — a comb of half-and-half bars took
     * half the light out of the lettering, and a hologram nobody can read is
     * not advertising anything.
     */
    if (p.scanlines > 0 && level > 0) {
      g.globalCompositeOperation = 'source-over';
      // Scaled by Brightness like everything else here. These are the one part
      // of the effect that *subtracts*, so at zero they have to go: a layer
      // turned down to nothing that still paints black bands across the
      // brickwork is not off, it is a mask.
      g.fillStyle = rgba('#000000', 0.38 * Math.min(1, level));
      const gap = Math.max(2, p.scanlines);
      const line = Math.max(1, gap * 0.7);
      for (let y = bbox.y; y < bbox.y + bbox.h; y += gap * 2) {
        g.fillRect(bbox.x, y, bbox.w, line);
      }
    }

    g.restore();
  },
};

export default [neon, neonSign, hologram];
