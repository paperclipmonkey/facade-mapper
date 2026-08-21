/**
 * The rest of the year.
 *
 * Halloween and Christmas are the two nights everybody already projects onto a
 * house, and they are the two the library was built for. They are not the only
 * nights: a birthday is the one evening a year that belongs to one person in
 * the building, the Perseids peak in the second week of August whether anybody
 * is watching or not, and midnight on the 31st is the one moment the whole
 * street is outside at the same time.
 *
 * What those have in common is that they are all *occasions* rather than
 * seasons — they happen at a moment, they are about somebody, and the house has
 * to say so. So the effects here lean on three things the ambient library does
 * not: real objects that read at fifty metres (a cake is a cake or it is
 * nothing), a real clock (a countdown that is a minute out is worse than no
 * countdown), and physics that survives being stared at (a meteor that does not
 * come from the radiant is a firework).
 *
 * Bonfire Night lives in `bonfire.js`, because it is all fire and fire has its
 * own problems.
 */

import { rgba, clamp, lerp, TAU, frac, mixHex, makeRng, smoothstep } from '../../core/math.js';
import { blackbodyCss, glow } from '../lib.js';
import { now as linkNow } from '../../core/time.js';

/**
 * Party colours, shared by everything here that comes in a multipack.
 *
 * Saturated primaries on a wall at night turn into three indistinguishable
 * bright patches, so these are pulled towards the light end — a projector's red
 * is dim and its cyan is not, and a palette picked on a monitor always comes
 * out redder and darker than it looked.
 */
const PALETTES = {
  party: ['#ff3b6b', '#ffd166', '#4cc2ff', '#8aff80', '#c77dff', '#ff8a3d'],
  pastel: ['#ffb3c7', '#ffe3a3', '#a8e6ff', '#c8f7c5', '#e0c3ff'],
  gold: ['#ffd166', '#ffb347', '#fff3c4', '#ffe9b0'],
  cool: ['#7fd8ff', '#a0b8ff', '#c77dff', '#ffffff'],
  warm: ['#ff8a3d', '#ffd166', '#ff5c5c', '#ffe9b0'],
};

const paletteFor = (name, single) =>
  name === 'single' ? [single] : PALETTES[name] || PALETTES.party;

/* ------------------------------------------------------------------ *
 * Birthday cake
 * ------------------------------------------------------------------ */

const cake = {
  id: 'cake',
  name: 'Birthday Cake',
  category: 'celebration',
  scope: 'shape',
  description:
    'A tiered cake with lit candles, drawn to fill the shape. The candles burn down over the evening, and “How many are lit” can be bound to the microphone so blowing at the house puts them out.',
  params: [
    { key: 'tiers', type: 'range', label: 'Tiers', default: 2, min: 1, max: 4, step: 1 },
    { key: 'icing', type: 'color', label: 'Icing', default: '#fff0f5' },
    { key: 'sponge', type: 'color', label: 'Sponge', default: '#e0a45c' },
    { key: 'trim', type: 'color', label: 'Ribbon', default: '#ff4d88' },
    { key: 'drips', type: 'range', label: 'Icing drips', default: 0.7, min: 0, max: 1, step: 0.01 },
    { key: 'candles', type: 'range', label: 'Candles', default: 7, min: 0, max: 40, step: 1 },
    { key: 'palette', type: 'select', label: 'Candle colours', default: 'party', options: ['party', 'pastel', 'gold', 'cool', 'warm', 'single'] },
    { key: 'color', type: 'color', label: 'Single candle colour', default: '#ff3b6b' },
    { key: 'lit', type: 'range', label: 'How many are lit', default: 1, min: 0, max: 1, step: 0.01 },
    { key: 'flameTemp', type: 'range', label: 'Flame (K)', default: 1850, min: 1200, max: 3000, step: 25 },
    { key: 'flicker', type: 'range', label: 'Flicker', default: 0.6, min: 0, max: 2, step: 0.01 },
    { key: 'burn', type: 'range', label: 'Burns down over (min)', default: 25, min: 0, max: 240, step: 1 },
    { key: 'glow', type: 'range', label: 'Candlelight on the wall', default: 1, min: 0, max: 3, step: 0.05 },
  ],
  draw({ g, p, shape, t, noise }) {
    const { bbox } = shape;
    if (bbox.w <= 4 || bbox.h <= 4) return;

    /**
     * The cake sits in the bottom two-thirds and the candles stand in the rest.
     *
     * Fixed proportions rather than a slider, because the thing this has to
     * survive is being pointed at a bay window (wide and low) and at a front
     * door (narrow and tall) without anybody adjusting it. Working from the
     * *smaller* dimension for every thickness, and the bbox for placement, is
     * what keeps a cake in a doorway from becoming a column.
     */
    const tiers = Math.max(1, Math.round(p.tiers));
    const cakeTop = bbox.y + bbox.h * 0.42;
    const cakeBottom = bbox.y + bbox.h * 0.94;
    const cakeH = cakeBottom - cakeTop;
    const widest = Math.min(bbox.w * 0.86, cakeH * 2.2);
    const rng = makeRng(`cake:${shape.id}`);

    g.save();

    // Plate first: an ellipse a little wider than the bottom tier, which is
    // most of what stops the cake looking like it is floating.
    const plateW = widest * 1.16;
    g.fillStyle = rgba('#ffffff', 0.16);
    g.beginPath();
    g.ellipse(bbox.cx, cakeBottom, plateW * 0.5, cakeH * 0.07, 0, 0, TAU);
    g.fill();

    const tierH = cakeH / tiers;
    for (let i = 0; i < tiers; i++) {
      // Bottom tier widest, each one above it stepped in by a constant ratio
      // rather than a constant inset, so it stays a wedding-cake silhouette at
      // any number of tiers. `i` counts up from the bottom, which is also the
      // order they have to be drawn in for the icing of one to overlap the
      // sponge of the next.
      const w = widest * Math.pow(0.76, i);
      const top = cakeBottom - tierH * (i + 1);
      const x = bbox.cx - w * 0.5;

      // Sponge body, with the front face slightly darker at the bottom: a flat
      // fill reads as a rectangle, a vertical ramp reads as a cylinder.
      const body = g.createLinearGradient(0, top, 0, top + tierH);
      body.addColorStop(0, mixHex(p.sponge, '#ffffff', 0.25));
      body.addColorStop(1, mixHex(p.sponge, '#000000', 0.45));
      g.fillStyle = body;
      g.fillRect(x, top, w, tierH);

      // Icing: a slab across the top with drips down the front. The drips are
      // the whole trick — a straight edge reads as a box, and three teardrops
      // hanging off it read as icing that was poured.
      const icingH = tierH * 0.3;
      // Shaded down towards the drips. Flat white icing under a bloom pass is a
      // white rectangle with a glow round it, and no amount of drawing the
      // drips correctly survives that.
      const ice = g.createLinearGradient(0, top, 0, top + icingH * 2.2);
      ice.addColorStop(0, p.icing);
      ice.addColorStop(1, mixHex(p.icing, '#000000', 0.4));
      g.fillStyle = ice;
      g.beginPath();
      g.moveTo(x, top + icingH);
      g.lineTo(x, top);
      g.lineTo(x + w, top);
      g.lineTo(x + w, top + icingH);
      if (p.drips > 0) {
        const drips = 3 + Math.round(w / Math.max(12, widest * 0.14));
        for (let d = drips; d >= 0; d--) {
          const u = d / drips;
          const dx = x + u * w;
          const drop = icingH * (0.4 + rng() * 1.9) * p.drips;
          g.quadraticCurveTo(dx + w / drips * 0.25, top + icingH + drop, dx, top + icingH);
        }
      }
      g.closePath();
      g.fill();

      // A ribbon round the base of each tier, which is the one piece of colour
      // that survives being halved by distance.
      g.fillStyle = p.trim;
      g.fillRect(x, top + tierH - tierH * 0.12, w, tierH * 0.12);
    }

    /* --- Candles --- */

    const count = Math.round(clamp(p.candles, 0, 40));
    if (count > 0) {
      const palette = paletteFor(p.palette, p.color);
      const topW = widest * Math.pow(0.76, tiers - 1);
      const candleW = Math.max(2, Math.min(topW / (count * 1.9), bbox.w * 0.02));
      // Capped against its own width as well as the shape: a candle is about
      // eight times as tall as it is thick, and eight of them across a narrow
      // door otherwise come out as a picket fence.
      const fullH = Math.min(bbox.h * 0.16, candleW * 8.5);

      /**
       * Candles shorten as the evening goes on.
       *
       * A function of show time rather than anything remembered, so a projector
       * tab opened at ten o'clock draws the same stubs as the one that has been
       * running since six — the alternative is two projectors covering the same
       * window disagreeing about how long the party has been going. They stop
       * at a third of their height rather than vanishing: a cake with no
       * candles left is a sad thing to leave on a wall for four hours.
       */
      const burnt = p.burn > 0 ? clamp(t / (p.burn * 60), 0, 1) : 0;
      const candleH = fullH * lerp(1, 0.34, burnt);
      const stand = cakeTop - candleH;
      const litCount = Math.round(count * clamp(p.lit, 0, 1));

      for (let i = 0; i < count; i++) {
        // Spread across the top tier, inset so the outermost pair are standing
        // on cake rather than on the edge of it.
        const u = count === 1 ? 0.5 : 0.12 + (i / (count - 1)) * 0.76;
        const x = bbox.cx - topW * 0.5 + u * topW;
        const colour = palette[i % palette.length];

        // The candle: a striped wax cylinder, wick, then the flame above it.
        g.fillStyle = colour;
        g.fillRect(x - candleW * 0.5, stand, candleW, candleH);
        g.fillStyle = rgba('#ffffff', 0.5);
        for (let s = 0; s < 3; s++) {
          const sy = stand + candleH * (0.2 + s * 0.28);
          g.fillRect(x - candleW * 0.5, sy, candleW, candleH * 0.07);
        }

        const lit = i < litCount;
        if (!lit) {
          // A wisp, so a candle that has just been blown out says so. Drawn for
          // as long as it is out — the alternative needs to remember when it
          // went out, and remembering is what makes two tabs disagree.
          if (p.lit < 1) drawWisp(g, x, stand, candleH, bbox, t, i, noise);
          continue;
        }

        /**
         * The flame.
         *
         * Two blobs: a wide dim envelope and a small bright core, both leaning
         * with the same noise. A candle flame is a diffusion flame — it is
         * coolest at the outside where it is starved of fuel and hottest just
         * above the wick, and drawing that as two temperatures rather than one
         * is the whole difference between a flame and an orange dot.
         */
        const wobble = noise.noise2(t * 2.6 + i * 3.1, 0) * p.flicker;
        const flare = 1 + noise.noise2(t * 5.5 + i * 1.7, 9.2) * 0.22 * p.flicker;
        const fh = candleW * 4.2 * flare;
        const fx = x + wobble * candleW * 0.5;
        const fy = stand - fh * 0.55;

        g.globalCompositeOperation = 'lighter';
        g.fillStyle = blackbodyCss(p.flameTemp * 0.72);
        g.beginPath();
        g.ellipse(fx, fy, candleW * 0.72, fh * 0.62, wobble * 0.25, 0, TAU);
        g.fill();
        g.fillStyle = blackbodyCss(p.flameTemp);
        g.beginPath();
        g.ellipse(fx, fy + fh * 0.12, candleW * 0.36, fh * 0.36, wobble * 0.25, 0, TAU);
        g.fill();
        if (p.glow > 0) {
          // Eight candles is eight halos on top of each other, and then the
          // bloom pass adds its own: keep each one small and weak or the cake
          // disappears inside its own light.
          glow(g, fx, fy, candleW * 5.5 * p.glow, blackbodyCss(p.flameTemp), 0.07 * p.glow * flare);
        }
        g.globalCompositeOperation = 'source-over';
      }
    }

    g.restore();
  },
};

/** Smoke off a candle that has just gone out. Two seconds of curl, then air. */
function drawWisp(g, x, top, candleH, bbox, t, i, noise) {
  const h = candleH * 1.6;
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = rgba('#c8d4e0', 0.16);
  g.lineWidth = Math.max(1, bbox.w * 0.002);
  g.beginPath();
  g.moveTo(x, top);
  for (let s = 1; s <= 6; s++) {
    const f = s / 6;
    // Widening as it rises, because a thermal plume entrains air and spreads.
    const sway = noise.noise2(t * 0.9 + i * 2.3, f * 2.4) * candleH * 0.5 * f;
    g.lineTo(x + sway, top - h * f);
  }
  g.stroke();
  g.restore();
}

/* ------------------------------------------------------------------ *
 * Balloons
 * ------------------------------------------------------------------ */

const balloons = {
  id: 'balloons',
  name: 'Balloons',
  category: 'celebration',
  scope: 'shape',
  description:
    'Helium balloons rise up the house, swaying the way a real one does, trailing string. Point it at the whole frame for a release, or at the door for a bunch coming out of it.',
  params: [
    { key: 'palette', type: 'select', label: 'Palette', default: 'party', options: ['party', 'pastel', 'gold', 'cool', 'warm', 'single'] },
    { key: 'color', type: 'color', label: 'Single colour', default: '#ff3b6b' },
    { key: 'count', type: 'range', label: 'Balloons', default: 14, min: 1, max: 80, step: 1 },
    { key: 'size', type: 'range', label: 'Size', default: 70, min: 10, max: 320, step: 1 },
    { key: 'speed', type: 'range', label: 'Rise (px/s)', default: 90, min: 5, max: 600, step: 5 },
    { key: 'sway', type: 'range', label: 'Sway', default: 1, min: 0, max: 3, step: 0.01 },
    { key: 'wind', type: 'range', label: 'Wind', default: 10, min: -200, max: 200, step: 2 },
    { key: 'string', type: 'range', label: 'String length', default: 1.6, min: 0, max: 5, step: 0.05 },
    { key: 'shine', type: 'range', label: 'Shine', default: 0.8, min: 0, max: 2, step: 0.01 },
    { key: 'spread', type: 'range', label: 'Spread across the shape', default: 1, min: 0.02, max: 1, step: 0.01 },
    { key: 'pop', type: 'range', label: 'Pops / min', default: 0, min: 0, max: 60, step: 1 },
  ],
  init() {
    return { balloons: [], count: 0 };
  },
  /**
   * Positions, at a fixed rate.
   *
   * Everything here is remembered between frames, so it all belongs in `step`:
   * a balloon's height is the sum of every step it has taken, and two tabs
   * drawing at different frame rates would take different numbers of them.
   */
  step({ p, shape, dt, rng, state }) {
    const { bbox } = shape;
    if (bbox.w <= 2 || bbox.h <= 2) return;

    const target = Math.round(clamp(p.count, 1, 80));
    const release = (b, initial) => {
      b.x = bbox.cx + (rng() - 0.5) * bbox.w * p.spread;
      // Started below the bottom edge so they rise *into* the shape rather than
      // appearing in it — except on the very first fill, where a shape empty of
      // balloons for twenty seconds is what everybody would call broken.
      b.y = bbox.y + bbox.h + (initial ? -rng() * bbox.h : rng() * bbox.h * 0.3);
      b.size = 0.65 + rng() * 0.7;
      b.hue = Math.floor(rng() * 64);
      b.phase = rng() * TAU;
      /**
       * How fast it swings, in Hz.
       *
       * A rising balloon does not go straight up: it sheds vortices off
       * alternate sides and rocks between them, and a big one rocks more slowly
       * than a small one. Scaling the rate by the inverse of the size is a
       * crude version of that, and it is the single detail that stops a screen
       * full of balloons looking like a screen full of bubbles.
       */
      b.rock = 0.55 / b.size;
      b.lean = 0;
      b.popped = 0;
      return b;
    };

    if (state.count !== target) {
      while (state.balloons.length < target) state.balloons.push(release({}, true));
      state.balloons.length = target;
      state.count = target;
    }

    // Per-balloon chance per step, from a rate per minute over the whole bunch.
    const popChance = p.pop > 0 ? (p.pop / 60) * dt / Math.max(1, target) : 0;

    for (const b of state.balloons) {
      if (b.popped > 0) {
        b.popped += dt;
        if (b.popped > 0.45) release(b, false);
        continue;
      }
      if (popChance > 0 && rng() < popChance) {
        b.popped = 0.0001;
        continue;
      }

      const size = p.size * b.size;
      // Bigger balloons carry more helium relative to their drag, so they climb
      // faster; the exponent is a fudge, but the ordering is real.
      const rise = p.speed * Math.pow(b.size, 0.4);
      b.phase += b.rock * TAU * dt;
      const swing = Math.sin(b.phase) * p.sway * size * 1.1;
      b.x += (swing * dt + p.wind * dt) ;
      b.y -= rise * dt;
      // The envelope tilts into the swing, and the string lags behind it.
      b.lean = lerp(b.lean, Math.cos(b.phase) * p.sway * 0.22, clamp(dt * 4, 0, 1));

      if (b.y + size * 1.4 < bbox.y) release(b, false);
    }
  },
  draw({ g, p, shape, state }) {
    if (!state.balloons?.length) return;
    const palette = paletteFor(p.palette, p.color);

    g.save();
    for (const b of state.balloons) {
      const colour = palette[b.hue % palette.length];
      const size = p.size * b.size;
      if (b.popped > 0) {
        drawPop(g, b, size, colour);
        continue;
      }
      drawBalloon(g, b, size, colour, p);
    }
    g.restore();
  },
};

/**
 * One balloon: envelope, knot, string, highlight.
 *
 * The envelope is not an ellipse. A latex balloon is a fat teardrop — wide and
 * round at the top, pulled to a point at the neck — and drawing an ellipse with
 * a triangle stuck on the bottom is exactly what makes cheap balloon graphics
 * look like cheap balloon graphics.
 */
function drawBalloon(g, b, size, colour, p) {
  const w = size * 0.5;
  const h = size * 0.62;

  g.save();
  g.translate(b.x, b.y);
  g.rotate(b.lean);

  if (p.string > 0) {
    // The string hangs from the knot and trails behind the swing, so it curves
    // rather than pointing straight down.
    const len = size * p.string;
    g.strokeStyle = rgba('#ffffff', 0.28);
    g.lineWidth = Math.max(1, size * 0.012);
    g.beginPath();
    g.moveTo(0, h);
    g.quadraticCurveTo(-b.lean * len * 0.9, h + len * 0.55, -b.lean * len * 2.2, h + len);
    g.stroke();
  }

  g.beginPath();
  g.moveTo(0, -h);
  g.bezierCurveTo(w, -h, w * 1.05, h * 0.35, 0, h);
  g.bezierCurveTo(-w * 1.05, h * 0.35, -w, -h, 0, -h);

  // Lit from the upper left, like everything else the app draws. The gradient
  // is offset into that corner rather than centred, which is what turns a flat
  // disc into something inflated.
  const grad = g.createRadialGradient(-w * 0.35, -h * 0.4, 0, 0, 0, w * 1.6);
  grad.addColorStop(0, mixHex(colour, '#ffffff', 0.45));
  grad.addColorStop(0.55, colour);
  grad.addColorStop(1, mixHex(colour, '#000000', 0.55));
  g.fillStyle = grad;
  g.fill();

  // Knot.
  g.fillStyle = mixHex(colour, '#000000', 0.35);
  g.beginPath();
  g.moveTo(-w * 0.1, h);
  g.lineTo(w * 0.1, h);
  g.lineTo(0, h * 1.12);
  g.closePath();
  g.fill();

  if (p.shine > 0) {
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = rgba('#ffffff', 0.3 * clamp(p.shine, 0, 2));
    g.beginPath();
    g.ellipse(-w * 0.38, -h * 0.42, w * 0.18, h * 0.24, -0.5, 0, TAU);
    g.fill();
    g.globalCompositeOperation = 'source-over';
  }
  g.restore();
}

/** A pop: the latex tears back into a ragged ring and is gone in a third of a second. */
function drawPop(g, b, size, colour) {
  const f = clamp(b.popped / 0.45, 0, 1);
  const r = size * (0.3 + f * 0.9);
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = rgba(colour, (1 - f) * 0.9);
  g.lineWidth = Math.max(1, size * 0.09 * (1 - f));
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * TAU + b.phase;
    g.beginPath();
    g.moveTo(b.x + Math.cos(a) * r * 0.5, b.y + Math.sin(a) * r * 0.5);
    g.lineTo(b.x + Math.cos(a) * r, b.y + Math.sin(a) * r);
    g.stroke();
  }
  g.restore();
}

/* ------------------------------------------------------------------ *
 * Bunting
 * ------------------------------------------------------------------ */

const bunting = {
  id: 'bunting',
  name: 'Bunting',
  category: 'celebration',
  scope: 'shape',
  description:
    'A string of triangular flags along the path, sagging between its ends and lifting in the wind. Aim it at the roofline or across the front of the house.',
  params: [
    { key: 'palette', type: 'select', label: 'Palette', default: 'party', options: ['party', 'pastel', 'gold', 'cool', 'warm', 'single'] },
    { key: 'color', type: 'color', label: 'Single colour', default: '#ff3b6b' },
    { key: 'shape', type: 'select', label: 'Flag shape', default: 'triangle', options: ['triangle', 'swallowtail', 'square'] },
    { key: 'spacing', type: 'range', label: 'Spacing (px)', default: 62, min: 12, max: 400, step: 1 },
    { key: 'width', type: 'range', label: 'Flag width', default: 54, min: 6, max: 300, step: 1 },
    { key: 'drop', type: 'range', label: 'Flag length', default: 74, min: 8, max: 400, step: 1 },
    { key: 'sag', type: 'range', label: 'Sag', default: 46, min: 0, max: 400, step: 1 },
    { key: 'wind', type: 'range', label: 'Wind', default: 0.6, min: 0, max: 3, step: 0.01 },
    { key: 'speed', type: 'range', label: 'Wind speed', default: 0.7, min: 0, max: 4, step: 0.01 },
    { key: 'cord', type: 'range', label: 'Cord opacity', default: 0.3, min: 0, max: 1, step: 0.01 },
    { key: 'level', type: 'range', label: 'Brightness', default: 1, min: 0, max: 2, step: 0.01 },
  ],
  draw({ g, p, shape, t }) {
    const length = shape.sampler.length;
    if (length <= 0) return;

    const count = clamp(Math.round(length / Math.max(8, p.spacing)), 1, 200);
    const palette = paletteFor(p.palette, p.color);

    /**
     * The sag.
     *
     * A cord between two fixings hangs in a catenary, and over the span of a
     * roofline a parabola is indistinguishable from one — `4u(1-u)` is that
     * parabola, zero at both ends and deepest in the middle. It matters more
     * than it sounds: bunting stapled dead level along a gutter looks like a
     * row of icons, and the same flags on a curve look like they are hanging
     * off something.
     */
    const sagAt = (u) => p.sag * 4 * u * (1 - u);

    g.save();
    g.globalAlpha *= clamp(p.level, 0, 3);

    if (p.cord > 0) {
      g.strokeStyle = rgba('#ffffff', p.cord);
      g.lineWidth = Math.max(1, p.width * 0.03);
      g.beginPath();
      for (let i = 0; i <= count * 2; i++) {
        const u = i / (count * 2);
        const at = shape.sampler.at(u);
        const y = at.y + sagAt(u);
        if (i === 0) g.moveTo(at.x, y);
        else g.lineTo(at.x, y);
      }
      g.stroke();
    }

    for (let i = 0; i < count; i++) {
      const u = (i + 0.5) / count;
      const at = shape.sampler.at(u);
      const x = at.x;
      const y = at.y + sagAt(u);

      /**
       * Wind as a wave travelling along the string, not as each flag doing its
       * own thing.
       *
       * Gusts move. A row of flags where every flag flutters independently
       * reads as noise; the same row with a phase offset proportional to
       * position reads as a breeze coming from one end, and you can watch it
       * arrive.
       */
      const phase = u * 6.2 - t * p.speed * TAU;
      const swing = Math.sin(phase) * p.wind * 0.35;
      // Turning edge-on is a *width* change, not a rotation. Cloth twists about
      // its own hanging edge, and squeezing the flag horizontally is what sells
      // it — a flag that only rotates looks like a metal pendulum.
      const face = 0.35 + 0.65 * Math.abs(Math.cos(phase * 0.5));
      const colour = palette[i % palette.length];

      g.save();
      g.translate(x, y);
      g.rotate(swing);
      g.scale(face, 1);

      const w = p.width * 0.5;
      const d = p.drop;
      g.beginPath();
      g.moveTo(-w, 0);
      g.lineTo(w, 0);
      if (p.shape === 'square') {
        g.lineTo(w, d);
        g.lineTo(-w, d);
      } else if (p.shape === 'swallowtail') {
        g.lineTo(w, d);
        g.lineTo(0, d * 0.6);
        g.lineTo(-w, d);
      } else {
        g.lineTo(0, d);
      }
      g.closePath();

      // Shaded across the flag, dark edge into the swing: one gradient, and the
      // cloth reads as curved rather than as coloured paper.
      const grad = g.createLinearGradient(-w, 0, w, 0);
      const bright = mixHex(colour, '#ffffff', 0.3);
      const dark = mixHex(colour, '#000000', 0.5);
      grad.addColorStop(0, swing > 0 ? dark : bright);
      grad.addColorStop(0.5, colour);
      grad.addColorStop(1, swing > 0 ? bright : dark);
      g.fillStyle = grad;
      g.fill();
      g.restore();
    }
    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * Confetti
 * ------------------------------------------------------------------ */

const confetti = {
  id: 'confetti',
  name: 'Confetti',
  category: 'celebration',
  scope: 'shape',
  description:
    'Paper falling over the whole house, tumbling and flashing as it turns edge-on. Streamers unwind with it.',
  params: [
    { key: 'palette', type: 'select', label: 'Palette', default: 'party', options: ['party', 'pastel', 'gold', 'cool', 'warm', 'single'] },
    { key: 'color', type: 'color', label: 'Single colour', default: '#ffd166' },
    { key: 'kind', type: 'select', label: 'Kind', default: 'both', options: ['paper', 'streamers', 'both'] },
    { key: 'count', type: 'range', label: 'Pieces', default: 220, min: 10, max: 900, step: 10 },
    { key: 'size', type: 'range', label: 'Size', default: 16, min: 3, max: 90, step: 1 },
    { key: 'fall', type: 'range', label: 'Fall speed', default: 120, min: 10, max: 900, step: 5 },
    { key: 'wind', type: 'range', label: 'Wind', default: 24, min: -300, max: 300, step: 2 },
    { key: 'flutter', type: 'range', label: 'Flutter', default: 1, min: 0, max: 3, step: 0.01 },
    { key: 'tumble', type: 'range', label: 'Tumble', default: 1, min: 0, max: 4, step: 0.01 },
    { key: 'level', type: 'range', label: 'Brightness', default: 1, min: 0, max: 2, step: 0.01 },
  ],
  init() {
    return { bits: [], count: 0 };
  },
  step({ p, shape, dt, rng, state }) {
    const { bbox } = shape;
    if (bbox.w <= 2 || bbox.h <= 2) return;

    const target = Math.round(clamp(p.count, 10, 900));
    const drop = (b, initial) => {
      b.x = bbox.x + rng() * bbox.w;
      b.y = bbox.y - (initial ? -rng() * bbox.h : rng() * bbox.h * 0.4);
      b.size = 0.5 + rng() * 1.1;
      b.hue = Math.floor(rng() * 64);
      b.spin = rng() * TAU;
      // Signed, so half of it tumbles the other way; a sheet of confetti all
      // rotating the same way reads as a texture scrolling.
      b.rate = (0.6 + rng() * 2.2) * (rng() < 0.5 ? -1 : 1);
      b.phase = rng() * TAU;
      b.swing = 0.4 + rng() * 1.2;
      b.tilt = rng() * TAU;
      b.streamer = rng() < 0.35;
      return b;
    };

    if (state.count !== target) {
      while (state.bits.length < target) state.bits.push(drop({}, true));
      state.bits.length = target;
      state.count = target;
    }

    for (const b of state.bits) {
      b.spin += b.rate * p.tumble * dt;
      b.phase += b.swing * dt * 2.4;
      /**
       * Paper does not fall; it stalls and slips.
       *
       * A flat piece falling flat-on builds a pressure cushion, slides off one
       * edge, picks up speed, turns, and stalls again — which is why confetti
       * comes down in a zig-zag and a stone does not. Modelled as a lateral
       * oscillation whose speed follows the tumble, plus a vertical speed that
       * *drops* while the piece is broadside, which is what gives the flutter
       * its characteristic hesitation.
       */
      const broadside = Math.abs(Math.cos(b.spin));
      b.x += (Math.sin(b.phase) * 40 * p.flutter * b.swing + p.wind) * dt;
      b.y += p.fall * (1 - 0.45 * broadside * p.flutter) * dt * (0.7 + b.size * 0.4);

      if (b.y - bbox.y > bbox.h * 1.05) drop(b, false);
      // Wrapping sideways rather than respawning: a piece blown off the right
      // edge has to come back somewhere, and a wind strong enough to matter
      // would otherwise empty that side of the house.
      if (b.x < bbox.x - bbox.w * 0.05) b.x += bbox.w * 1.1;
      if (b.x > bbox.x + bbox.w * 1.05) b.x -= bbox.w * 1.1;
    }
  },
  draw({ g, p, shape, state }) {
    if (!state.bits?.length) return;
    const palette = paletteFor(p.palette, p.color);
    const wantPaper = p.kind !== 'streamers';
    const wantStreamers = p.kind !== 'paper';

    g.save();
    g.globalAlpha *= clamp(p.level, 0, 3);
    for (const b of state.bits) {
      if (b.streamer ? !wantStreamers : !wantPaper) continue;
      const colour = palette[b.hue % palette.length];
      const size = p.size * b.size;
      // Width collapses as the piece turns edge-on, and the back of the paper
      // is darker than the front — so each piece flashes twice a revolution,
      // which is exactly what a room full of confetti does.
      const facing = Math.cos(b.spin);
      const front = facing >= 0;
      const w = Math.max(0.6, Math.abs(facing) * size * (b.streamer ? 0.3 : 1));

      g.save();
      g.translate(b.x, b.y);
      g.rotate(b.tilt + Math.sin(b.phase) * 0.4);
      g.fillStyle = front ? colour : mixHex(colour, '#000000', 0.45);
      if (b.streamer) {
        // A curled ribbon: three segments of a sine, so it unwinds as it falls.
        const len = size * 4;
        g.beginPath();
        g.moveTo(-w * 0.5, 0);
        for (let s = 0; s <= 6; s++) {
          const f = s / 6;
          g.lineTo(-w * 0.5 + Math.sin(b.phase + f * 5) * size * 0.5, f * len);
        }
        for (let s = 6; s >= 0; s--) {
          const f = s / 6;
          g.lineTo(w * 0.5 + Math.sin(b.phase + f * 5) * size * 0.5, f * len);
        }
        g.closePath();
        g.fill();
      } else {
        g.fillRect(-w * 0.5, -size * 0.35, w, size * 0.7);
      }
      g.restore();
    }
    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * Meteor shower
 * ------------------------------------------------------------------ */

/**
 * Meteor colour, which is emphatically *not* blackbody.
 *
 * Everything else hot in this library takes its colour from a temperature,
 * because embers and sparks and filaments are thermal emitters. A meteor is
 * not: it is a millimetre of rock being stripped atom by atom at eighty
 * kilometres up, and what you see is line emission from the atoms it sheds and
 * from the air it is ionising. That is why meteors come in colours no hot body
 * ever glows — the green so many Perseids show is neutral magnesium at 518 nm,
 * the yellow is sodium at 589, the orange-red in the wake is atmospheric
 * nitrogen and oxygen recombining behind the head.
 *
 * So the ramp is by composition rather than by temperature, and the head is
 * always the whitest part because it is all of them at once.
 */
const METEOR_TINTS = {
  perseid: ['#eafff0', '#9dffc4', '#ffe9a8'],
  sodium: ['#fff6e0', '#ffd166', '#ff9a3d'],
  iron: ['#fff2e8', '#ffc9a8', '#ff8a5c'],
  cool: ['#f2f8ff', '#bcd8ff', '#8fb4ff'],
};

const meteors = {
  id: 'meteors',
  name: 'Meteor Shower',
  category: 'celebration',
  scope: 'shape',
  description:
    'Meteors streaking away from a radiant, the way a real shower does — short near the radiant, long across the sky, with fireballs that leave a train hanging. Set the radiant high and to one side for the Perseids.',
  params: [
    { key: 'radiantX', type: 'range', label: 'Radiant across', default: 0.2, min: -0.5, max: 1.5, step: 0.01 },
    { key: 'radiantY', type: 'range', label: 'Radiant up/down', default: -0.15, min: -1, max: 1.5, step: 0.01 },
    { key: 'rate', type: 'range', label: 'Meteors / min', default: 40, min: 1, max: 400, step: 1 },
    { key: 'tint', type: 'select', label: 'Composition', default: 'perseid', options: ['perseid', 'sodium', 'iron', 'cool'] },
    { key: 'speed', type: 'range', label: 'Speed', default: 1, min: 0.1, max: 5, step: 0.05 },
    { key: 'length', type: 'range', label: 'Streak length', default: 1, min: 0.1, max: 4, step: 0.05 },
    { key: 'width', type: 'range', label: 'Thickness', default: 3, min: 0.5, max: 20, step: 0.5 },
    { key: 'fireballs', type: 'range', label: 'Fireballs (in 10)', default: 1, min: 0, max: 10, step: 0.5 },
    { key: 'train', type: 'range', label: 'Train lingers (s)', default: 3, min: 0, max: 20, step: 0.5 },
    { key: 'showRadiant', type: 'bool', label: 'Mark the radiant', default: false },
    { key: 'level', type: 'range', label: 'Brightness', default: 1, min: 0, max: 2, step: 0.01 },
  ],
  /**
   * No `step`, on purpose.
   *
   * Every meteor is derived from its index and the clock — where it starts, how
   * fast it goes, whether it is a fireball — so nothing is remembered and there
   * is nothing to get out of step. A projector tab opened in the middle of the
   * shower draws the meteor that is in the sky at that instant, in the right
   * place, on its first frame; the same trick the fireworks use.
   */
  draw({ g, p, shape, t, noise }) {
    const { bbox } = shape;
    if (bbox.w <= 4 || bbox.h <= 4) return;

    const tints = METEOR_TINTS[p.tint] || METEOR_TINTS.perseid;
    const rx = bbox.x + p.radiantX * bbox.w;
    const ry = bbox.y + p.radiantY * bbox.h;
    const reach = Math.hypot(bbox.w, bbox.h);

    const interval = 60 / Math.max(1, p.rate);
    const flight = 1.1 / clamp(p.speed, 0.1, 5);
    const linger = flight + Math.max(0, p.train);
    const overlap = Math.min(400, Math.ceil(linger / interval) + 1);
    const current = Math.floor(t / interval);

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = clamp(p.level, 0, 3);
    g.lineCap = 'round';

    for (let k = 0; k <= overlap; k++) {
      const index = current - k;
      if (index < 0) continue;
      const age = t - index * interval;
      if (age < 0 || age > linger) continue;

      const rng = makeRng(`meteor${index}`);

      /**
       * Where it appears — a point in the frame — and the direction follows.
       *
       * The obvious way round is to pick a direction from the radiant and send
       * a meteor down it, and it is wrong in a way that is invisible in the
       * code and glaring on a wall: the sky is a full circle round the radiant
       * and the frame is not, so most of the meteors are drawn off the side of
       * the picture and the Rate slider means something different depending on
       * where the radiant is put. Aiming for a point that is *in* the frame is
       * also the more faithful model — meteors appear uniformly over the sky,
       * and the part of the sky you are painting is this rectangle — and it
       * makes Rate mean meteors you can actually see.
       */
      const px = bbox.x + rng() * bbox.w;
      const py = bbox.y + rng() * bbox.h;
      const dx = px - rx;
      const dy = py - ry;
      const from = Math.hypot(dx, dy) || 1;
      const dirX = dx / from;
      const dirY = dy / from;

      /**
       * How long it looks, from how far from the radiant it appeared.
       *
       * Meteors near the radiant are foreshortened — you are looking straight
       * down the barrel of the path, so it hardly moves — and the same meteor
       * ninety degrees away crosses half the sky. Both are the same rock going
       * the same speed. Tying the drawn length to the distance from the radiant
       * is what makes a shower read as a shower rather than as streaks pointed
       * at a dot, and it costs one multiply.
       */
      const span = Math.min(from, reach * 0.5) * 0.55 * p.length * (0.6 + rng() * 0.7);
      const fireball = rng() * 10 < p.fireballs;
      const tint = tints[Math.floor(rng() * tints.length)];

      const travel = clamp(age / flight, 0, 1);
      // Meteors are not accelerating in any way the eye can see over a second,
      // so this is linear — but they brighten to a peak partway down and fade,
      // as ablation runs away and then runs out of rock.
      const headAt = from + travel * span;
      const bright = Math.sin(Math.min(1, travel) * Math.PI) ** 0.6;

      const hx = rx + dirX * headAt;
      const hy = ry + dirY * headAt;

      if (age <= flight && bright > 0.01) {
        const tail = Math.min(headAt - from, span * 0.45) + reach * 0.02;
        const tx = hx - dirX * tail;
        const ty = hy - dirY * tail;
        const scale = fireball ? 2.4 : 1;

        const grad = g.createLinearGradient(tx, ty, hx, hy);
        grad.addColorStop(0, rgba(tints[tints.length - 1], 0));
        grad.addColorStop(0.55, rgba(tint, 0.35 * bright));
        grad.addColorStop(1, rgba('#ffffff', 0.95 * bright));
        g.strokeStyle = grad;
        g.lineWidth = p.width * scale * (0.4 + bright * 0.8);
        g.beginPath();
        g.moveTo(tx, ty);
        g.lineTo(hx, hy);
        g.stroke();

        glow(g, hx, hy, p.width * 6 * scale, tint, 0.5 * bright);

        // A fireball ends in a terminal flare — the last of it breaking up.
        if (fireball && travel > 0.82) {
          const punch = 1 - (travel - 0.82) / 0.18;
          glow(g, hx, hy, p.width * 26, '#ffffff', 0.5 * punch * punch);
        }
      }

      /**
       * The train.
       *
       * The bright ones leave a glowing wake of ionised air that hangs there
       * for seconds after the meteor has gone, and — because it is sitting in
       * the jet stream at eighty kilometres — visibly distorts as it fades.
       * Almost nobody draws this, and it is the thing that makes people who
       * have actually lain in a field watching a shower say "yes, that".
       */
      if (p.train > 0 && fireball && age > flight * 0.4) {
        const fade = clamp(1 - (age - flight * 0.4) / p.train, 0, 1);
        if (fade > 0.01) {
          g.strokeStyle = rgba(tints[1], 0.28 * fade * fade);
          g.lineWidth = p.width * 1.4 * fade;
          g.beginPath();
          for (let s = 0; s <= 8; s++) {
            const f = s / 8;
            const at = from + f * span;
            // Shear grows with time: the train is being pulled apart by wind.
            const drift = noise.noise2(index * 0.7 + f * 2.2, age * 0.25) * reach * 0.02 * (1 - fade);
            const x = rx + dirX * at - dirY * drift;
            const y = ry + dirY * at + dirX * drift;
            if (s === 0) g.moveTo(x, y);
            else g.lineTo(x, y);
          }
          g.stroke();
        }
      }
    }

    if (p.showRadiant) {
      // A setting-up aid: it puts the point on the wall so you can aim it at
      // the bit of sky Perseus is actually in, then turn it off.
      g.strokeStyle = rgba('#7fd8ff', 0.5);
      g.lineWidth = 2;
      g.beginPath();
      g.arc(rx, ry, reach * 0.03, 0, TAU);
      g.moveTo(rx - reach * 0.05, ry);
      g.lineTo(rx + reach * 0.05, ry);
      g.moveTo(rx, ry - reach * 0.05);
      g.lineTo(rx, ry + reach * 0.05);
      g.stroke();
    }

    g.restore();
  },
};

/* ------------------------------------------------------------------ *
 * Clock face
 * ------------------------------------------------------------------ */

const ROMAN = ['XII', 'I', 'II', 'III', 'IIII', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'];

const clockFace = {
  id: 'clock-face',
  name: 'Clock Face',
  category: 'celebration',
  scope: 'shape',
  description:
    'A working clock on the front of the house, counting down to a moment. The last minute pulses, and it flares when the hands meet at the top. Point it at a window and set the target to midnight on the 31st.',
  params: [
    { key: 'target', type: 'text', label: 'Moment (YYYY-MM-DD HH:MM)', default: '2027-01-01 00:00' },
    { key: 'face', type: 'color', label: 'Face', default: '#0a1430' },
    { key: 'rim', type: 'color', label: 'Rim and numerals', default: '#ffd166' },
    { key: 'hands', type: 'color', label: 'Hands', default: '#ffffff' },
    { key: 'numerals', type: 'select', label: 'Numerals', default: 'roman', options: ['roman', 'arabic', 'ticks', 'none'] },
    { key: 'size', type: 'range', label: 'Size', default: 0.92, min: 0.2, max: 1.4, step: 0.01 },
    { key: 'thickness', type: 'range', label: 'Rim thickness', default: 0.05, min: 0.005, max: 0.2, step: 0.005 },
    { key: 'second', type: 'select', label: 'Second hand', default: 'tick', options: ['tick', 'sweep', 'none'] },
    { key: 'glow', type: 'range', label: 'Glow', default: 1, min: 0, max: 3, step: 0.05 },
    { key: 'pulse', type: 'bool', label: 'Pulse through the last minute', default: true },
    { key: 'flare', type: 'range', label: 'Flare at the moment (s)', default: 6, min: 0, max: 30, step: 0.5 },
    { key: 'flareColor', type: 'color', label: 'Flare colour', default: '#ffe9b0' },
  ],
  draw({ g, p, shape }) {
    const { bbox } = shape;
    const radius = Math.min(bbox.w, bbox.h) * 0.5 * clamp(p.size, 0.1, 1.5);
    if (radius < 4) return;

    /**
     * The wall clock, through the link, exactly as the Countdown effect does.
     *
     * Not show time: a clock that pauses when you pause the transport is a
     * decoration, and the entire point of this one is that when it says
     * midnight it *is* midnight. Going through `linkNow` rather than
     * `Date.now()` means the machine driving the second projector agrees to the
     * millisecond, which matters rather a lot when both are drawing the same
     * second hand onto the same window.
     */
    const now = linkNow();
    const target = Date.parse(String(p.target).replace(' ', 'T'));
    const remaining = isFinite(target) ? (target - now) / 1000 : Infinity;

    /**
     * Which time the hands show.
     *
     * The real one, always. It is tempting to fake the last minute so the hands
     * arrive at twelve exactly when the countdown does, and it is wrong: on the
     * one night of the year anybody is looking at this, half the street is
     * holding a phone showing the true time, and a house that disagrees with it
     * is a house with a broken clock on it.
     */
    const date = new Date(now);
    const seconds = date.getSeconds() + date.getMilliseconds() / 1000;
    const minutes = date.getMinutes() + seconds / 60;
    const hours = (date.getHours() % 12) + minutes / 60;

    const cx = bbox.cx;
    const cy = bbox.cy;
    const ring = radius * clamp(p.thickness, 0.005, 0.3);

    // The last minute: the whole face swells on each second, and harder as it
    // runs out. Ten to zero is the bit everybody counts out loud.
    const counting = p.pulse && remaining > 0 && remaining <= 60;
    const beat = counting ? 1 - clamp(frac(remaining) * 3, 0, 1) : 0;
    const urgency = counting ? smoothstep(60, 0, remaining) : 0;
    const swell = 1 + beat * 0.05 * (0.4 + urgency);

    g.save();
    g.translate(cx, cy);
    g.scale(swell, swell);

    g.fillStyle = p.face;
    g.beginPath();
    g.arc(0, 0, radius, 0, TAU);
    g.fill();

    g.strokeStyle = p.rim;
    g.lineWidth = ring;
    g.beginPath();
    g.arc(0, 0, radius - ring * 0.5, 0, TAU);
    g.stroke();

    /* --- Numerals and ticks --- */

    if (p.numerals !== 'none') {
      g.fillStyle = p.rim;
      g.strokeStyle = p.rim;
      for (let i = 0; i < 60; i++) {
        const a = (i / 60) * TAU - Math.PI / 2;
        const major = i % 5 === 0;
        const inner = radius * (major ? 0.82 : 0.88);
        const outer = radius - ring;
        g.lineWidth = major ? ring * 0.5 : ring * 0.2;
        g.globalAlpha = major ? 1 : 0.5;
        g.beginPath();
        g.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
        g.lineTo(Math.cos(a) * outer, Math.sin(a) * outer);
        g.stroke();
      }
      g.globalAlpha = 1;

      if (p.numerals !== 'ticks') {
        const px = radius * 0.17;
        g.font = `600 ${px}px ui-serif, Georgia, serif`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * TAU - Math.PI / 2;
          const label = p.numerals === 'roman' ? ROMAN[i] : String(i === 0 ? 12 : i);
          g.fillText(label, Math.cos(a) * radius * 0.68, Math.sin(a) * radius * 0.68);
        }
      }
    }

    /* --- Hands --- */

    const hand = (turns, length, width, colour, alpha = 1) => {
      const a = turns * TAU - Math.PI / 2;
      g.strokeStyle = rgba(colour, alpha);
      g.lineWidth = width;
      g.lineCap = 'round';
      g.beginPath();
      // A short counterweight past the centre — every real hand has one, and
      // its absence is one of those things you feel rather than notice.
      g.moveTo(-Math.cos(a) * length * 0.16, -Math.sin(a) * length * 0.16);
      g.lineTo(Math.cos(a) * length, Math.sin(a) * length);
      g.stroke();
    };

    hand(hours / 12, radius * 0.5, ring * 1.5, p.hands);
    hand(minutes / 60, radius * 0.76, ring * 1, p.hands);
    if (p.second !== 'none') {
      // A quartz clock steps; a mechanical one sweeps. The step is worth having
      // through a countdown, because the eye catches the jump and the crowd
      // counts with it.
      const s = p.second === 'sweep' ? seconds : Math.floor(seconds);
      hand(s / 60, radius * 0.86, ring * 0.45, p.rim);
    }

    g.fillStyle = p.hands;
    g.beginPath();
    g.arc(0, 0, ring * 0.9, 0, TAU);
    g.fill();

    g.restore();

    /* --- The moment itself --- */

    g.save();
    g.globalCompositeOperation = 'lighter';
    if (p.glow > 0) {
      glow(g, cx, cy, radius * 1.9, p.rim, 0.12 * p.glow * (1 + beat * 1.5));
    }
    if (p.flare > 0 && remaining <= 0 && remaining > -p.flare) {
      /**
       * Midnight.
       *
       * A hard white flash that decays over several seconds, plus a ring
       * expanding off the rim. It is doing the job a cymbal does: marking the
       * instant so nobody has to be told it happened. Squared decay rather than
       * linear, because a flash that fades evenly reads as a light being turned
       * down and one that falls away fast reads as an event.
       */
      const f = 1 - (-remaining) / p.flare;
      glow(g, cx, cy, radius * 4.5, p.flareColor, 0.9 * f * f);
      const ringR = radius * (1 + (1 - f) * 3);
      g.strokeStyle = rgba(p.flareColor, 0.7 * f);
      g.lineWidth = ring * 2 * f;
      g.beginPath();
      g.arc(cx, cy, ringR, 0, TAU);
      g.stroke();
    }
    g.restore();
  },
};

export default [cake, balloons, bunting, confetti, meteors, clockFace];
