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
import { blackbodyCss, glow, mixLinear, curveThrough } from '../lib.js';
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

/**
 * How much of the top of each tier is seen: the half-height of its top
 * ellipse, over its width. A cake is looked at from a little above — it is on
 * a table, or on a door at eye level — and the sliver of iced top that shows
 * is the second most important thing about it after the drips.
 */
const TOP_TILT = 0.085;

/**
 * Scratch for tracing the icing — module-level so a frame allocates nothing,
 * and safe to share because one draw finishes before the next begins.
 */
const DRIP_SAMPLES = 44;
const DRIP_X = new Float64Array(DRIP_SAMPLES);
const DRIP_Y = new Float64Array(DRIP_SAMPLES);
const DRIPS_MAX = 18;
const DRIP_AT = new Float64Array(DRIPS_MAX);
const DRIP_LEN = new Float64Array(DRIPS_MAX);
const DRIP_HALF = new Float64Array(DRIPS_MAX);

/**
 * Shading across a cylinder lit from the front and a little to the left.
 *
 * The whole difference between a cake and a stack of rectangles is this one
 * gradient: dark at both edges where the side turns away, brightest a third of
 * the way across, and a shade darker on the far side than on the lit one.
 */
function cylinderShade(g, x, w, colour, lift = 0) {
  const grad = g.createLinearGradient(x, 0, x + w, 0);
  grad.addColorStop(0, mixHex(colour, '#000000', 0.66));
  grad.addColorStop(0.14, mixHex(colour, '#000000', 0.24));
  grad.addColorStop(0.36, lift > 0 ? mixHex(colour, '#ffffff', lift) : colour);
  grad.addColorStop(0.6, mixHex(colour, '#000000', 0.12));
  grad.addColorStop(0.86, mixHex(colour, '#000000', 0.45));
  grad.addColorStop(1, mixHex(colour, '#000000', 0.74));
  return grad;
}

/**
 * The icing over the front of one tier: a band round the rim, and drips off
 * it.
 *
 * Traced as one shape — along the front of the top ellipse, then back along a
 * lower edge that is the band's depth plus whichever drip is longest at that
 * point. Each drip is a finger with near-vertical sides and a round end (the
 * fourth root of a parabola), narrowed towards the sides of the cake because
 * that is where the curve of the tier turns it away from you. A straight edge
 * reads as a box; poured icing hanging off a rim reads as cake from across a
 * road.
 */
function traceIcing(g, cx, top, rx, ry, band, rng, amount) {
  const n = amount > 0 ? Math.min(DRIPS_MAX, Math.max(4, Math.round(6 + rx / Math.max(6, band * 2.4)))) : 0;
  for (let k = 0; k < n; k++) {
    // Spaced round the front with some jitter, never quite evenly, and mostly
    // short with the odd long one — which is how poured icing actually runs.
    const s = -0.94 + ((k + 0.5 + (rng() - 0.5) * 0.8) / n) * 1.88;
    DRIP_AT[k] = s;
    DRIP_LEN[k] = band * (0.8 + rng() * 1.6 + rng() * rng() * 3.6) * amount;
    DRIP_HALF[k] = (0.05 + rng() * 0.045) * Math.sqrt(Math.max(0.05, 1 - s * s));
  }
  for (let i = 0; i < DRIP_SAMPLES; i++) {
    const s = 1 - (2 * i) / (DRIP_SAMPLES - 1);
    let hang = 0;
    for (let k = 0; k < n; k++) {
      const d = (s - DRIP_AT[k]) / DRIP_HALF[k];
      if (d > -1 && d < 1) hang = Math.max(hang, DRIP_LEN[k] * Math.pow(1 - d * d, 0.25));
    }
    DRIP_X[i] = cx + rx * s;
    DRIP_Y[i] = top + ry * Math.sqrt(Math.max(0, 1 - s * s)) + band + hang;
  }
  g.beginPath();
  g.ellipse(cx, top, rx, ry, 0, Math.PI, 0, true);
  curveThrough(g, DRIP_X, DRIP_Y, DRIP_SAMPLES);
  g.closePath();
}

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
    { key: 'trim', type: 'color', label: 'Piping', default: '#ff4d88' },
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

    const tiers = Math.max(1, Math.round(p.tiers));
    const count = Math.round(clamp(p.candles, 0, 40));
    const cx = bbox.cx;

    /**
     * Proportions first, from whichever way the shape is short.
     *
     * The thing this has to survive is being pointed at a bay window (wide and
     * low) and at a front door (narrow and tall) without anybody adjusting
     * it. So the cake is as wide as the shape allows, or a little wider than
     * the height allows, whichever runs out first; two thirds of the height
     * is cake and the rest is candles; and the tiers take whatever depth that
     * leaves them, between a sheet cake's and a tall layer cake's. A tall
     * shape also gets the cake stood on a cake stand, rather than the cake
     * stretched into a column.
     */
    const floorY = bbox.y + bbox.h * 0.965;
    const standH = bbox.h * clamp((bbox.h / bbox.w - 1) * 0.12, 0, 0.13);
    const plateY = floorY - standH;
    const room = plateY - (bbox.y + bbox.h * 0.05);
    let span = 0;
    for (let i = 0; i < tiers; i++) span += Math.pow(0.76, i);
    const widest = Math.max(4, Math.min(bbox.w * 0.84, room * 1.25));
    const depth = clamp((room * 0.64) / (widest * span), 0.3, 0.72);
    const rng = makeRng(`cake:${shape.id}`);

    g.save();
    g.globalCompositeOperation = 'source-over';

    /* --- Stand and plate --- */

    // Most of what stops a cake looking like it is floating. Pale, but kept
    // down in the middle of the range: on a projector it is a pale shape added
    // to a door, and at full white it is the brightest thing in the picture.
    const plateRx = widest * 0.62;
    const plateRy = Math.max(1, plateRx * TOP_TILT * 1.25);
    const china = '#d8d0e4';
    if (standH > 2) {
      const footRx = widest * 0.3;
      const footRy = Math.max(1, footRx * TOP_TILT * 1.4);
      g.fillStyle = cylinderShade(g, cx - footRx, footRx * 2, mixHex(china, '#000000', 0.25));
      g.beginPath();
      g.ellipse(cx, floorY - footRy, footRx, footRy * 1.6, 0, 0, TAU);
      g.fill();
      // The stem, waisted, as a curve rather than a trapezoid.
      const stemTop = widest * 0.05;
      const stemFoot = widest * 0.1;
      g.fillStyle = cylinderShade(g, cx - stemFoot, stemFoot * 2, mixHex(china, '#000000', 0.2));
      g.beginPath();
      g.moveTo(cx - stemFoot, floorY - footRy * 1.5);
      g.quadraticCurveTo(cx - stemTop * 0.6, (plateY + floorY) / 2, cx - stemTop, plateY + plateRy);
      g.lineTo(cx + stemTop, plateY + plateRy);
      g.quadraticCurveTo(cx + stemTop * 0.6, (plateY + floorY) / 2, cx + stemFoot, floorY - footRy * 1.5);
      g.closePath();
      g.fill();
    }
    // The plate: its rim, then its top.
    g.fillStyle = cylinderShade(g, cx - plateRx, plateRx * 2, mixHex(china, '#000000', 0.3));
    g.beginPath();
    g.ellipse(cx, plateY + plateRy * 0.55, plateRx, plateRy, 0, 0, TAU);
    g.fill();
    const plateTop = g.createRadialGradient(cx - plateRx * 0.3, plateY - plateRy * 0.5, 0, cx, plateY, plateRx);
    plateTop.addColorStop(0, mixHex(china, '#ffffff', 0.15));
    plateTop.addColorStop(1, mixHex(china, '#000000', 0.35));
    g.fillStyle = plateTop;
    g.beginPath();
    g.ellipse(cx, plateY, plateRx, plateRy, 0, 0, TAU);
    g.fill();

    /* --- Tiers, bottom up --- */

    // Muted rather than pure: icing is the lightest thing on the cake, and a
    // projector adding near-white to a door at full strength blooms it into a
    // featureless glow. The highlights carry the white; the body of the icing
    // sits well below it, so there is shading left to see.
    const icing = mixHex(p.icing, '#000000', 0.16);
    const sponge = mixHex(p.sponge, '#000000', 0.08);
    const cream = mixHex(p.icing, p.sponge, 0.25);
    let bottom = plateY;
    let topY = plateY;
    let topRx = widest / 2;
    let topRy = 1;
    for (let i = 0; i < tiers; i++) {
      // Bottom tier widest, each above it stepped in by a constant ratio rather
      // than a constant inset, so it stays a wedding-cake silhouette at any
      // number of tiers. `i` counts up from the bottom, which is also the
      // order they have to be drawn in for the icing of one to overlap the
      // sponge of the next.
      const w = widest * Math.pow(0.76, i);
      const h = w * depth;
      const rx = w / 2;
      const ry = Math.max(0.5, w * TOP_TILT);
      const x = cx - rx;
      const top = bottom - h;

      // Sponge: the front of the cylinder, and its rounded bottom edge.
      g.fillStyle = cylinderShade(g, x, w, sponge, 0.1);
      g.fillRect(x, top, w, h);
      g.beginPath();
      g.ellipse(cx, bottom, rx, ry, 0, 0, Math.PI);
      g.fill();

      // Two layers of sponge and the cream between them, following the curve
      // of the side — which is what says "cake" rather than "box" once the
      // icing is on top of it.
      g.strokeStyle = cylinderShade(g, x, w, cream, 0.1);
      g.lineWidth = Math.max(1, h * 0.07);
      g.beginPath();
      g.ellipse(cx, top + h * 0.56, rx, ry, 0, 0, Math.PI);
      g.stroke();

      // The iced top, catching the light at the back-left.
      const sheen = g.createRadialGradient(cx - rx * 0.35, top - ry * 0.6, 0, cx, top, rx * 1.1);
      sheen.addColorStop(0, mixHex(p.icing, '#ffffff', 0.25));
      sheen.addColorStop(0.5, icing);
      sheen.addColorStop(1, mixHex(icing, '#000000', 0.3));
      g.fillStyle = sheen;
      g.beginPath();
      g.ellipse(cx, top, rx, ry, 0, 0, TAU);
      g.fill();

      // Poured icing over the rim.
      traceIcing(g, cx, top, rx, ry, Math.max(1, h * 0.12), rng, p.drips);
      g.fillStyle = cylinderShade(g, x, w, icing, 0.18);
      g.fill();
      // A lit edge along the rim, where the icing turns over the top.
      g.strokeStyle = rgba(mixHex(p.icing, '#ffffff', 0.35), 0.75);
      g.lineWidth = Math.max(0.8, ry * 0.22);
      g.beginPath();
      g.ellipse(cx, top, rx * 0.985, ry * 0.94, 0, Math.PI * 0.92, Math.PI * 0.32, true);
      g.stroke();

      /**
       * Piped beads round the foot of the tier.
       *
       * The one piece of strong colour that survives being halved by distance,
       * and the thing that turns a stack of cylinders into something a person
       * made. Spaced evenly round the cake rather than evenly across the
       * picture, so they crowd together at the sides as the tier turns away.
       * Every bead in one path and one fill, then every highlight in another.
       */
      const bead = clamp(w * 0.034, 1, 9);
      const beads = Math.max(6, Math.round((Math.PI * rx) / (bead * 1.9)));
      for (let pass = 0; pass < 2; pass++) {
        g.beginPath();
        for (let b = 0; b <= beads; b++) {
          const a = (b / beads) * Math.PI;
          const bx = cx + Math.cos(a) * rx * 0.995;
          const by = bottom + Math.sin(a) * ry - bead * 0.35;
          const r = bead * (0.75 + 0.25 * Math.sin(a));
          if (pass === 0) {
            g.moveTo(bx + r, by);
            g.arc(bx, by, r, 0, TAU);
          } else {
            g.moveTo(bx - r * 0.3 + r * 0.32, by - r * 0.35);
            g.arc(bx - r * 0.3, by - r * 0.35, r * 0.32, 0, TAU);
          }
        }
        g.fillStyle = pass === 0 ? mixHex(p.trim, '#000000', 0.15) : rgba(mixHex(p.trim, '#ffffff', 0.55), 0.8);
        g.fill();
      }

      bottom = top;
      topY = top;
      topRx = rx;
      topRy = ry;
    }

    /* --- Candles --- */

    if (count > 0) {
      const palette = paletteFor(p.palette, p.color);
      const topW = topRx * 2;
      // Stood in a ring on the top tier, inset from its edge.
      const ringRx = topRx * (count === 1 ? 0 : 0.64);
      const ringRy = topRy * (count === 1 ? 0 : 0.64);
      // As wide as a candle is, unless that many would not fit round the ring;
      // never more than a sliver of the shape, so a cake in a doorway gets
      // candles rather than posts.
      const candleW = Math.max(1.2, Math.min(topW * 0.05, bbox.w * 0.035, (TAU * Math.max(ringRx, topRx * 0.3)) / (count * 2.4)));
      // Capped against its own width as well as the shape: a candle is about
      // seven times as tall as it is thick, and eight of them across a narrow
      // door otherwise come out as a picket fence.
      const fullH = Math.min(bbox.h * 0.16, candleW * 7);

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
      const litCount = Math.round(count * clamp(p.lit, 0, 1));

      // The candlelight falling on the top of the cake, before the candles
      // that make it: warm, pooled round the ring, as strong as the number
      // still burning.
      if (litCount > 0 && p.glow > 0) {
        g.globalCompositeOperation = 'lighter';
        const pool = g.createRadialGradient(cx, topY, 0, cx, topY, topW * 0.95);
        const warmth = blackbodyCss(p.flameTemp);
        const strength = 0.22 * Math.min(1.5, p.glow) * (litCount / count);
        pool.addColorStop(0, rgba(warmth, strength));
        pool.addColorStop(0.5, rgba(warmth, strength * 0.4));
        pool.addColorStop(1, rgba(warmth, 0));
        g.fillStyle = pool;
        g.beginPath();
        g.arc(cx, topY, topW * 0.95, 0, TAU);
        g.fill();
        g.globalCompositeOperation = 'source-over';
      }

      // Back of the ring first, then the front, so the near candles stand in
      // front of the far ones.
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < count; i++) {
          const a = ((i + 0.5) / count) * TAU + 0.4;
          const back = Math.sin(a) < 0;
          if ((pass === 0) !== back) continue;
          const x = cx + Math.cos(a) * ringRx;
          const foot = topY + Math.sin(a) * ringRy;
          const stand = foot - candleH;
          const colour = palette[i % palette.length];

          // The candle: a waxy cylinder with a twist of stripe round it.
          g.globalCompositeOperation = 'source-over';
          g.fillStyle = cylinderShade(g, x - candleW / 2, candleW, colour, 0.25);
          g.fillRect(x - candleW / 2, stand, candleW, candleH);
          g.fillStyle = rgba('#ffffff', 0.45);
          g.beginPath();
          const pitch = candleW * 1.5;
          for (let y = foot - pitch * 0.4; y - pitch * 0.72 > stand; y -= pitch) {
            g.moveTo(x - candleW / 2, y);
            g.lineTo(x + candleW / 2, y - pitch * 0.45);
            g.lineTo(x + candleW / 2, y - pitch * 0.72);
            g.lineTo(x - candleW / 2, y - pitch * 0.27);
            g.closePath();
          }
          g.fill();
          // The wick.
          g.strokeStyle = 'rgba(30,20,14,0.9)';
          g.lineWidth = Math.max(0.6, candleW * 0.18);
          g.beginPath();
          g.moveTo(x, stand);
          g.lineTo(x, stand - candleW * 0.45);
          g.stroke();

          if (i >= litCount) {
            // A wisp, so a candle that has just been blown out says so. Drawn
            // for as long as it is out — the alternative needs to remember when
            // it went out, and remembering is what makes two tabs disagree.
            if (p.lit < 1) drawWisp(g, x, stand, candleH, bbox, t, i, noise);
            continue;
          }
          drawFlame(g, p, x, stand - candleW * 0.35, candleW, t, i, noise);
        }
      }
    }

    g.restore();
  },
};

/**
 * One candle flame, and the light it throws.
 *
 * A candle flame is a diffusion flame: coolest at the outside, where it is
 * starved of fuel, and hottest in the luminous core just above the wick —
 * drawing that as two temperatures rather than one is the whole difference
 * between a flame and an orange dot. The outer envelope is a teardrop leaning
 * with the draught, and it is traced as one rather than as an ellipse, because
 * a flame is pointed at the top and round at the bottom and an ellipse is
 * neither.
 */
function drawFlame(g, p, x, y, candleW, t, i, noise) {
  const wobble = noise.noise2(t * 2.6 + i * 3.1, 0) * p.flicker;
  const flare = 1 + noise.noise2(t * 5.5 + i * 1.7, 9.2) * 0.22 * p.flicker;
  const fh = candleW * 3.4 * flare;
  const fw = candleW * 0.78;
  const lean = wobble * candleW * 0.9;
  const outer = blackbodyCss(p.flameTemp * 0.95);
  const core = mixLinear(blackbodyCss(p.flameTemp * 1.35), '#ffffff', 0.45);

  g.globalCompositeOperation = 'lighter';
  if (p.glow > 0) {
    // Small and weak each: eight candles are eight halos on top of each other,
    // and the bloom adds its own. Any more and the cake disappears inside its
    // own light.
    glow(g, x + lean * 0.5, y - fh * 0.45, candleW * 6 * p.glow, blackbodyCss(p.flameTemp), 0.1 * p.glow * flare);
  }
  g.fillStyle = rgba(outer, 0.9);
  g.beginPath();
  g.moveTo(x + lean, y - fh);
  g.bezierCurveTo(x + lean * 0.4 + fw * 0.55, y - fh * 0.62, x + fw * 1.05, y - fh * 0.08, x, y);
  g.bezierCurveTo(x - fw * 1.05, y - fh * 0.08, x + lean * 0.4 - fw * 0.55, y - fh * 0.62, x + lean, y - fh);
  g.fill();
  g.fillStyle = rgba(core, 0.95);
  g.beginPath();
  g.ellipse(x + lean * 0.25, y - fh * 0.3, fw * 0.42, fh * 0.26, wobble * 0.15, 0, TAU);
  g.fill();
  g.globalCompositeOperation = 'source-over';
}

/**
 * Smoke off a candle that is out.
 *
 * Drawn for as long as it is unlit rather than for a couple of seconds after
 * the moment it went out, and that is a deliberate trade: knowing when it went
 * out means remembering, remembering means fixed-rate state, and this effect is
 * otherwise a pure function of show time that any tab can join halfway through.
 * A wisp that persists is a candle that is still smoking; it costs one stroke.
 */
function drawWisp(g, x, top, candleH, bbox, t, i, noise) {
  const h = candleH * 1.6;
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = rgba('#c8d4e0', 0.22);
  g.lineWidth = Math.max(1, bbox.w * 0.003);
  g.lineCap = 'round';
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
  draw({ g, p, state }) {
    if (!state.balloons?.length) return;
    const palette = paletteFor(p.palette, p.color);

    g.save();
    // The small ones first: they read as further away, and the near ones
    // should pass in front of them. Two passes rather than a sort, because
    // sorting `state.balloons` from `draw` is a write — and a write from draw
    // is a different order in every tab.
    for (let pass = 0; pass < 2; pass++) {
      for (const b of state.balloons) {
        if ((b.size >= 1) !== (pass === 1)) continue;
        const colour = palette[b.hue % palette.length];
        const size = p.size * b.size;
        if (b.popped > 0) drawPop(g, b, size, colour);
        else drawBalloon(g, b, size, colour, p);
      }
    }
    g.restore();
  },
};

/**
 * One balloon: string, envelope, the light through it, knot, highlight.
 *
 * The envelope is not an ellipse. A latex balloon is a fat teardrop — wide and
 * round at the top, pulled to a point at the neck — and drawing an ellipse with
 * a triangle stuck on the bottom is exactly what makes cheap balloon graphics
 * look like cheap balloon graphics.
 *
 * And it is lit, not lit up. A balloon is a surface: most of it sits well down
 * in the middle of its colour, darker towards the edges where it turns away,
 * with one hard specular highlight where the light catches it and a warmer
 * glow low down where light has come through the rubber and out of the neck.
 * Painted at the full brightness of its colour, a projector turns every one of
 * them into a coloured light bulb and the bloom puts a halo round it.
 */
function drawBalloon(g, b, size, colour, p) {
  const w = size * 0.5;
  const h = size * 0.62;

  g.save();
  g.translate(b.x, b.y);
  g.rotate(b.lean);

  if (p.string > 0) {
    // The string hangs from the knot and trails behind the swing, so it curves
    // rather than pointing straight down — with a little S in it, because
    // ribbon off a reel never quite straightens.
    const len = size * p.string;
    const trail = -b.lean * len;
    g.strokeStyle = rgba('#e8e6f0', 0.42);
    g.lineWidth = Math.max(0.8, size * 0.012);
    g.beginPath();
    g.moveTo(0, h * 1.12);
    g.bezierCurveTo(trail * 0.5 + w * 0.18, h + len * 0.35, trail * 1.5 - w * 0.18, h + len * 0.68, trail * 2.2, h + len);
    g.stroke();
  }

  // The envelope, shaded round from the light at the upper left.
  g.beginPath();
  g.moveTo(0, -h);
  g.bezierCurveTo(w, -h, w * 1.05, h * 0.35, 0, h);
  g.bezierCurveTo(-w * 1.05, h * 0.35, -w, -h, 0, -h);
  const shade = g.createRadialGradient(-w * 0.3, -h * 0.36, w * 0.04, -w * 0.06, -h * 0.04, w * 1.32);
  shade.addColorStop(0, mixHex(colour, '#ffffff', 0.1));
  shade.addColorStop(0.3, mixHex(colour, '#000000', 0.26));
  shade.addColorStop(0.7, mixHex(colour, '#000000', 0.5));
  shade.addColorStop(1, mixHex(colour, '#000000', 0.7));
  g.fillStyle = shade;
  g.fill();
  // Light through the rubber, pooling at the neck where the latex is thick.
  const through = g.createRadialGradient(w * 0.08, h * 0.5, 0, w * 0.08, h * 0.5, w * 0.8);
  through.addColorStop(0, rgba(mixHex(colour, '#ffffff', 0.08), 0.45));
  through.addColorStop(1, rgba(colour, 0));
  g.fillStyle = through;
  g.fill();

  // The knot: a pinched lip of rubber, darker than the balloon.
  g.fillStyle = mixHex(colour, '#000000', 0.5);
  g.beginPath();
  g.moveTo(-w * 0.1, h * 0.97);
  g.quadraticCurveTo(0, h * 1.03, w * 0.1, h * 0.97);
  g.quadraticCurveTo(w * 0.08, h * 1.15, 0, h * 1.14);
  g.quadraticCurveTo(-w * 0.08, h * 1.15, -w * 0.1, h * 0.97);
  g.fill();

  if (p.shine > 0) {
    // The highlight: a reflection of the light, so added rather than painted,
    // and small and hard — on a balloon that is the brightest thing there is,
    // and the only part of it that should bloom.
    const s = clamp(p.shine, 0, 2);
    g.globalCompositeOperation = 'lighter';
    const spec = g.createRadialGradient(-w * 0.36, -h * 0.47, 0, -w * 0.36, -h * 0.47, w * 0.26);
    spec.addColorStop(0, rgba('#ffffff', Math.min(1, 0.8 * s)));
    spec.addColorStop(0.4, rgba('#ffffff', 0.28 * s));
    spec.addColorStop(1, rgba('#ffffff', 0));
    g.fillStyle = spec;
    g.beginPath();
    g.ellipse(-w * 0.36, -h * 0.47, w * 0.22, h * 0.15, -0.6, 0, TAU);
    g.fill();
    // A second, fainter one low on the far side: the light bouncing back off
    // the wall behind.
    g.fillStyle = rgba(mixHex(colour, '#ffffff', 0.6), 0.14 * s);
    g.beginPath();
    g.ellipse(w * 0.5, h * 0.05, w * 0.07, h * 0.2, 0.15, 0, TAU);
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
  g.lineCap = 'round';
  g.beginPath();
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * TAU + b.phase;
    g.moveTo(b.x + Math.cos(a) * r * 0.5, b.y + Math.sin(a) * r * 0.5);
    g.lineTo(b.x + Math.cos(a) * r, b.y + Math.sin(a) * r);
  }
  g.stroke();
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

    // Each flag cut and hung a little differently — a string of identical
    // triangles at identical angles is a row of icons. Seeded from the shape,
    // so every tab hangs the same string.
    const cut = makeRng(`bunting:${shape.id}`);
    const length2 = Math.max(1, length);
    for (let i = 0; i < count; i++) {
      const u = (i + 0.5) / count;
      const at = shape.sampler.at(u);
      const x = at.x;
      const y = at.y + sagAt(u);
      const scale = 0.93 + cut() * 0.14;
      const lag = (cut() - 0.5) * 0.7;
      const tone = cut();

      /**
       * Wind as a wave travelling along the string, not as each flag doing its
       * own thing.
       *
       * Gusts move. A row of flags where every flag flutters independently
       * reads as noise; the same row with a phase offset proportional to
       * position reads as a breeze coming from one end, and you can watch it
       * arrive.
       */
      const phase = u * 6.2 - t * p.speed * TAU + lag;
      const swing = Math.sin(phase) * p.wind * 0.35;
      // Turning edge-on is a *width* change, not a rotation. Cloth twists about
      // its own hanging edge, and squeezing the flag horizontally is what sells
      // it — a flag that only rotates looks like a metal pendulum.
      const face = 0.35 + 0.65 * Math.abs(Math.cos(phase * 0.5));
      const colour = palette[i % palette.length];

      /**
       * Hung from the cord, at the cord's own angle.
       *
       * The top edge is sewn to the string, so on the slope of the sag it
       * slopes with it, while the cloth below hangs to gravity — which is what
       * makes the string look as if it is carrying the flags rather than as if
       * the flags were stuck on a curve. The tip swings out with the wind and
       * the sides belly a little either way of straight.
       */
      const slope = Math.atan2(Math.sin(at.angle) * length2 + p.sag * 4 * (1 - 2 * u), Math.cos(at.angle) * length2);
      const w = p.width * 0.5 * scale * face;
      const d = p.drop * scale;
      const cx = Math.cos(slope) * w;
      const cy = Math.sin(slope) * w;
      const lx = x - cx;
      const ly = y - cy;
      const rx = x + cx;
      const ry = y + cy;
      const tx = x + Math.sin(swing) * d * 0.55;
      const ty = y + d * (0.9 + 0.1 * face) * Math.cos(swing * 0.5);
      const belly = Math.sin(phase + 1.3) * p.wind * w * 0.22;

      g.beginPath();
      g.moveTo(lx, ly);
      g.lineTo(rx, ry);
      if (p.shape === 'square') {
        g.quadraticCurveTo(rx + belly, (ry + ty) / 2, tx + cx, ty);
        g.lineTo(tx - cx, ty);
        g.quadraticCurveTo(lx + belly, (ly + ty) / 2, lx, ly);
      } else if (p.shape === 'swallowtail') {
        g.quadraticCurveTo(rx + belly, (ry + ty) / 2, tx + cx, ty);
        g.lineTo(tx, y + (ty - y) * 0.62);
        g.lineTo(tx - cx, ty);
        g.quadraticCurveTo(lx + belly, (ly + ty) / 2, lx, ly);
      } else {
        g.quadraticCurveTo((rx + tx) / 2 + belly, (ry + ty) / 2, tx, ty);
        g.quadraticCurveTo((lx + tx) / 2 + belly, (ly + ty) / 2, lx, ly);
      }
      g.closePath();

      /**
       * Cloth, not light.
       *
       * Shaded across the flag, dark edge into the swing, so the cloth reads as
       * curved rather than as coloured paper — and kept down in the middle of
       * its colour. A flag is lit by the house; painted at the full brightness
       * of its colour, a projector turns a string of bunting into a string of
       * coloured neon tubes.
       */
      const body = mixHex(colour, '#000000', 0.16 + tone * 0.1);
      const lit = mixHex(colour, '#ffffff', 0.12);
      const shade = mixHex(colour, '#000000', 0.58);
      const grad = g.createLinearGradient(lx, ly, rx, ry);
      grad.addColorStop(0, swing > 0 ? shade : lit);
      grad.addColorStop(0.5, body);
      grad.addColorStop(1, swing > 0 ? lit : shade);
      g.fillStyle = grad;
      g.fill();

      // The hem where the cloth folds over the cord: a darker band along the
      // top, which is the detail that says "sewn" from the pavement. Cut down
      // the flag's own sides so it stays inside the cloth.
      const k = Math.min(0.3, Math.max(1, d * 0.07) / Math.max(1, ty - y));
      g.fillStyle = rgba(mixHex(colour, '#000000', 0.45), 0.85);
      g.beginPath();
      g.moveTo(lx, ly);
      g.lineTo(rx, ry);
      g.lineTo(rx + (tx - rx) * k, ry + (ty - ry) * k);
      g.lineTo(lx + (tx - lx) * k, ly + (ty - ly) * k);
      g.closePath();
      g.fill();
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
  draw({ g, p, state }) {
    if (!state.bits?.length) return;
    const palette = paletteFor(p.palette, p.color);
    const wantPaper = p.kind !== 'streamers';
    const wantStreamers = p.kind !== 'paper';
    // Gold confetti is foil, and foil does not so much catch the light as
    // throw it back: its glints are the whole look of it.
    const sheen = p.palette === 'gold' ? 1 : 0.5;

    g.save();
    g.globalAlpha *= clamp(p.level, 0, 3);
    for (const b of state.bits) {
      if (b.streamer ? !wantStreamers : !wantPaper) continue;
      const colour = palette[b.hue % palette.length];
      const size = p.size * b.size;
      /**
       * Two axes of tumble, from the one spin.
       *
       * Width collapses as the piece turns edge-on, and the back of the paper
       * is darker than the front — so each piece flashes twice a revolution,
       * which is exactly what a room full of confetti does. A second, slower
       * roll about the other axis shortens it too, so a piece is never the
       * same rectangle twice: a sheet of identical cards turning about one
       * axis reads as a pattern, not as paper.
       */
      const facing = Math.cos(b.spin);
      const roll = 0.3 + 0.7 * Math.abs(Math.cos(b.spin * 0.63 + b.phase));
      const front = facing >= 0;
      const w = Math.max(0.6, Math.abs(facing) * size * (b.streamer ? 0.3 : 1));
      // Paper is lit, not lit up: its colour sits down in the middle of the
      // range, so that the moment it faces the light is a flash.
      const tone = front ? mixHex(colour, '#000000', 0.12) : mixHex(colour, '#000000', 0.5);

      g.save();
      g.translate(b.x, b.y);
      g.rotate(b.tilt + Math.sin(b.phase) * 0.4);
      if (b.streamer) {
        /**
         * A curled ribbon, unwinding as it falls: its centre line is a sine
         * down its length, and its width follows its own twist — full where it
         * faces you, a thread where it turns edge-on — which is what makes a
         * strip of paper read as a curl rather than as a wiggly line.
         */
        const len = size * 4;
        const STEPS = 8;
        g.beginPath();
        for (let s = 0; s <= STEPS; s++) {
          const f = s / STEPS;
          const half = w * 0.5 * (0.2 + 0.8 * Math.abs(Math.cos(b.phase * 1.3 + f * 6)));
          const x = Math.sin(b.phase + f * 5) * size * 0.5 - half;
          if (s === 0) g.moveTo(x, f * len);
          else g.lineTo(x, f * len);
        }
        for (let s = STEPS; s >= 0; s--) {
          const f = s / STEPS;
          const half = w * 0.5 * (0.2 + 0.8 * Math.abs(Math.cos(b.phase * 1.3 + f * 6)));
          g.lineTo(Math.sin(b.phase + f * 5) * size * 0.5 + half, f * len);
        }
        g.closePath();
        const band = g.createLinearGradient(0, 0, 0, len);
        band.addColorStop(0, tone);
        band.addColorStop(0.45, front ? mixHex(colour, '#ffffff', 0.1) : tone);
        band.addColorStop(1, mixHex(colour, '#000000', 0.4));
        g.fillStyle = band;
        g.fill();
      } else {
        const h = size * 0.7 * roll;
        g.fillStyle = tone;
        g.fillRect(-w * 0.5, -h * 0.5, w, h);
        // The glint: square on to the light, for an instant, it throws it back.
        const square = Math.abs(facing) * roll;
        if (front && square > 0.86) {
          g.globalCompositeOperation = 'lighter';
          g.fillStyle = rgba('#fff6e0', ((square - 0.86) / 0.14) * 0.85 * sheen);
          g.fillRect(-w * 0.5, -h * 0.5, w, h);
          g.globalCompositeOperation = 'source-over';
        }
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
 * the yellow is sodium at 589, the orange-red at the back of the streak is
 * atmospheric nitrogen and oxygen recombining behind the head, and the green
 * of a train left hanging after a fireball is oxygen's forbidden line at 557.7,
 * which takes seconds to give up its light.
 *
 * So the colours are by composition rather than by temperature: `body` is the
 * streak just behind the head (one of two, picked per meteor), `tail` is what
 * it fades through, and `train` is the afterglow. The head is always the
 * whitest part, because it is all of them at once.
 */
const METEOR_INKS = {
  perseid: { body: ['#c4ffd8', '#fff1c4'], tail: '#ffae7a', train: '#7dffb2' },
  sodium: { body: ['#ffe39a', '#fff0c8'], tail: '#ff9a4a', train: '#ffd27a' },
  iron: { body: ['#ffd2b0', '#fff2e6'], tail: '#ff8a5c', train: '#ffb08a' },
  cool: { body: ['#c8dcff', '#eef4ff'], tail: '#9fb6ff', train: '#9fc2ff' },
};

/**
 * One streak, head first: how far back along the streak each pass reaches, how
 * wide it is (in `width`s) and how bright.
 *
 * A wide faint pass the whole length for the glow, a narrower one over the
 * front half, and a thin white core only near the head — so the streak tapers
 * from a hot point to nothing in width as well as in brightness. Every pass is
 * a line along the ray from the radiant, which is the one geometric fact a
 * shower has to get right.
 */
const METEOR_PASSES = [
  [1, 2.6, 0.32],
  [0.55, 1.2, 0.75],
  [0.22, 0.5, 1],
];

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

    const ink = METEOR_INKS[p.tint] || METEOR_INKS.perseid;
    const rx = bbox.x + p.radiantX * bbox.w;
    const ry = bbox.y + p.radiantY * bbox.h;
    const reach = Math.hypot(bbox.w, bbox.h);

    const interval = 60 / Math.max(1, p.rate);
    const flight = 1.1 / clamp(p.speed, 0.1, 5);
    /**
     * The wake every meteor leaves, however faint.
     *
     * Not only fireballs: the air a meteor has ionised goes on glowing for a
     * few tenths of a second after the head has gone, so the whole path hangs
     * there briefly and fades. It is most of why a still of a real shower
     * catches meteors at all — the head is there for a fraction of a second,
     * the line it drew for rather longer. Scaled off "Train lingers" so that a
     * shower set to leave nothing behind leaves nothing behind.
     */
    const wake = p.train > 0 ? Math.min(0.8, 0.12 * p.train) : 0;
    const linger = flight + Math.max(wake, Math.max(0, p.train));
    const overlap = Math.min(400, Math.ceil(linger / interval) + 1);
    const current = Math.floor(t / interval);

    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';
    const level = clamp(p.level, 0, 3);
    g.globalAlpha *= Math.min(1, level);
    // Above full brightness, the extra goes on width and glow rather than
    // being lost to an alpha that cannot go past one.
    const boost = Math.max(1, level);
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
      const body = ink.body[rng() < 0.5 ? 0 : 1];
      // Meteors come in every brightness, and the occasional bright one is
      // what makes people point. Not *too* faint, though: anything much below
      // half strength is lost in the grade before it reaches the wall.
      const magnitude = fireball ? 1 : 0.6 + rng() * rng() * 0.4;
      const scale = (fireball ? 2.2 : 0.8 + magnitude * 0.4) * boost;

      const travel = clamp(age / flight, 0, 1);
      const headAt = from + travel * span;
      /**
       * Brightness along the flight: up fast as ablation takes hold, steady
       * through most of it, and gone at the end when the rock runs out — a
       * light curve with shoulders, rather than a sine wave that spends half
       * the flight too faint to see.
       */
      const bright = Math.pow(Math.sin(travel * Math.PI), 0.35) * magnitude;
      const hx = rx + dirX * headAt;
      const hy = ry + dirY * headAt;

      if (age <= flight && bright > 0.01) {
        // Never longer than the distance actually travelled: the fixed padding
        // that softens the tail used to be added *after* the clamp, so a meteor
        // caught in its first frames had a streak reaching back past where it
        // appeared and, with the radiant in frame, straight through it.
        const tail = Math.min(headAt - from, span * 0.5 + reach * 0.02);
        if (tail > 0.5) {
          for (let pass = 0; pass < METEOR_PASSES.length; pass++) {
            const [back, wide, strength] = METEOR_PASSES[pass];
            const tx = hx - dirX * tail * back;
            const ty = hy - dirY * tail * back;
            const grad = g.createLinearGradient(tx, ty, hx, hy);
            if (pass === 0) {
              grad.addColorStop(0, rgba(ink.tail, 0));
              grad.addColorStop(0.5, rgba(ink.tail, 0.35 * strength * bright));
              grad.addColorStop(1, rgba(body, strength * bright));
            } else if (pass === 1) {
              grad.addColorStop(0, rgba(body, 0));
              grad.addColorStop(0.7, rgba(body, 0.7 * strength * bright));
              grad.addColorStop(1, rgba('#ffffff', strength * bright));
            } else {
              grad.addColorStop(0, rgba('#ffffff', 0));
              grad.addColorStop(1, rgba('#ffffff', strength * bright));
            }
            g.strokeStyle = grad;
            g.lineWidth = Math.max(0.6, p.width * wide * scale * (0.55 + 0.45 * bright));
            g.beginPath();
            g.moveTo(tx, ty);
            g.lineTo(hx, hy);
            g.stroke();
          }
        }

        // The head: a hard white point in a halo of its own colour.
        glow(g, hx, hy, p.width * 7 * scale, body, 0.55 * bright);
        glow(g, hx, hy, p.width * 2.2 * scale, '#ffffff', 0.95 * bright);

        // A fireball ends in a terminal flare — the last of it breaking up.
        if (fireball && travel > 0.82) {
          const punch = 1 - (travel - 0.82) / 0.18;
          glow(g, hx, hy, p.width * 26 * boost, '#ffffff', 0.55 * punch * punch);
        }
      }

      // The wake along the whole path drawn so far, holding while the head is
      // still going and fading after it has gone.
      if (wake > 0) {
        const fade = age <= flight ? 1 : 1 - (age - flight) / wake;
        const reached = Math.min(headAt, from + span) - from;
        if (fade > 0.01 && reached > 0.5) {
          g.strokeStyle = rgba(ink.tail, 0.3 * magnitude * fade * fade);
          g.lineWidth = Math.max(0.6, p.width * 0.9 * scale);
          g.beginPath();
          g.moveTo(rx + dirX * from, ry + dirY * from);
          g.lineTo(rx + dirX * (from + reached), ry + dirY * (from + reached));
          g.stroke();
        }
      }

      /**
       * The train.
       *
       * The bright ones leave a glowing wake of ionised air that hangs there
       * for seconds after the meteor has gone, and — because it is sitting in
       * the jet stream at eighty kilometres — visibly distorts as it fades:
       * bending first, then spreading into a soft band. Almost nobody draws
       * this, and it is the thing that makes people who have actually lain in
       * a field watching a shower say "yes, that".
       */
      if (p.train > 0 && fireball && age > flight * 0.3) {
        const since = age - flight * 0.3;
        const fade = clamp(1 - since / p.train, 0, 1);
        if (fade > 0.01) {
          const spread = 1 - fade;
          const trail = Math.min(headAt, from + span);
          // Shear grows with time, slowly at first: the train is being pulled
          // apart by wind, and it starts out as straight as the meteor was. No
          // more bend than a fraction of its own length, or a short train near
          // the radiant curls up into a worm.
          const shear = Math.min(reach * 0.035, (trail - from) * 0.22) * spread * spread;
          for (let s = 0; s <= 10; s++) {
            const f = s / 10;
            const at = from + f * (trail - from);
            const drift = noise.noise2(index * 0.7 + f * 1.3, since * 0.15) * shear;
            TRAIN_X[s] = rx + dirX * at - dirY * drift;
            TRAIN_Y[s] = ry + dirY * at + dirX * drift;
          }
          g.lineJoin = 'round';
          // A broad faint band, and a brighter thread down the middle of it
          // that dims first as the band diffuses.
          g.strokeStyle = rgba(ink.train, 0.16 * fade);
          g.lineWidth = p.width * boost * (2 + 6 * spread);
          g.beginPath();
          curveThrough(g, TRAIN_X, TRAIN_Y, 11, { move: true });
          g.stroke();
          g.strokeStyle = rgba(ink.train, 0.42 * fade * fade);
          g.lineWidth = p.width * boost * (0.7 + 0.8 * spread);
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

/** Scratch for a train's points — module-level, so a frame allocates nothing. */
const TRAIN_X = new Float64Array(11);
const TRAIN_Y = new Float64Array(11);

/* ------------------------------------------------------------------ *
 * Clock face
 * ------------------------------------------------------------------ */

const ROMAN = ['XII', 'I', 'II', 'III', 'IIII', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'];

/**
 * A hand's outline, in units of its own length along +x: a slim leaf that
 * swells a third of the way out and runs to a point, with a short tail behind
 * the arbor.
 *
 * Traced with curves alone, deliberately. A hand is the one thing on a clock
 * face that has to be read from the far side of a road, and a stroked line
 * with a round end reads as a stick; a hand with a shape to it reads as a hand.
 */
function traceHand(g, length, width, a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  // Local (along, across) to the face's coordinates.
  const X = (u, v) => c * u * length - s * v * width;
  const Y = (u, v) => s * u * length + c * v * width;
  g.beginPath();
  g.moveTo(X(-0.17, 0), Y(-0.17, 0));
  g.quadraticCurveTo(X(-0.15, 0.7), Y(-0.15, 0.7), X(0.05, 0.55), Y(0.05, 0.55));
  g.quadraticCurveTo(X(0.38, 1.25), Y(0.38, 1.25), X(1, 0), Y(1, 0));
  g.quadraticCurveTo(X(0.38, -1.25), Y(0.38, -1.25), X(0.05, -0.55), Y(0.05, -0.55));
  g.quadraticCurveTo(X(-0.15, -0.7), Y(-0.15, -0.7), X(-0.17, 0), Y(-0.17, 0));
  g.closePath();
}

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

    // The light it throws on the wall, behind everything: a clock lit from
    // inside, as a station clock is at night. Pulses with the count.
    if (p.glow > 0) {
      g.globalCompositeOperation = 'lighter';
      glow(g, cx, cy, radius * 1.9, p.rim, 0.14 * p.glow * (1 + beat * 1.5));
      g.globalCompositeOperation = 'source-over';
    }

    g.translate(cx, cy);
    g.scale(swell, swell);

    /**
     * The dial.
     *
     * A projector cannot paint dark, so a dark face is not a colour so much
     * as a hole: it lets the wall show through and takes away whatever other
     * layers were throwing at that patch of it. That is exactly what a clock
     * hung on a lit wall looks like — a disc that the fireworks' light does
     * not land on — and a slightly lighter middle gives it a dome of glass.
     */
    const dial = g.createRadialGradient(-radius * 0.25, -radius * 0.3, 0, 0, 0, radius);
    dial.addColorStop(0, mixHex(p.face, '#ffffff', 0.08));
    dial.addColorStop(1, p.face);
    g.fillStyle = dial;
    g.beginPath();
    g.arc(0, 0, radius, 0, TAU);
    g.fill();

    /**
     * The bezel: a turned brass ring, lit from above.
     *
     * A flat stroke of one colour is a line drawn round a circle. The same ring
     * shaded from a highlight at the top left to shadow at the bottom right,
     * with a fine bright edge inside it, reads as a solid thing with a curved
     * face — and it is the outline of the bezel, more than any numeral, that
     * says "clock" from the end of the street.
     */
    const brass = g.createLinearGradient(-radius, -radius, radius, radius);
    brass.addColorStop(0, mixHex(p.rim, '#ffffff', 0.5));
    brass.addColorStop(0.3, p.rim);
    brass.addColorStop(0.55, mixHex(p.rim, '#000000', 0.45));
    brass.addColorStop(0.8, p.rim);
    brass.addColorStop(1, mixHex(p.rim, '#000000', 0.35));
    g.strokeStyle = brass;
    g.lineWidth = ring;
    g.beginPath();
    g.arc(0, 0, radius - ring * 0.5, 0, TAU);
    g.stroke();
    g.strokeStyle = rgba(mixHex(p.rim, '#ffffff', 0.4), 0.8);
    g.lineWidth = Math.max(0.6, ring * 0.16);
    g.beginPath();
    g.arc(0, 0, radius - ring * 1.25, 0, TAU);
    g.stroke();

    /* --- Chapter ring and numerals --- */

    if (p.numerals !== 'none') {
      // The minute track: two fine circles with the minutes between them, the
      // fives heavier and longer. On a face this size it is the minutes, not
      // the numerals, that make the hands readable to the second.
      const outer = radius - ring * 1.6;
      const inner = radius * 0.86 - ring * 0.6;
      g.strokeStyle = rgba(p.rim, 0.55);
      g.lineWidth = Math.max(0.5, ring * 0.12);
      g.beginPath();
      g.arc(0, 0, outer, 0, TAU);
      g.moveTo(inner, 0);
      g.arc(0, 0, inner, 0, TAU);
      g.stroke();
      g.strokeStyle = p.rim;
      g.lineCap = 'butt';
      for (let pass = 0; pass < 2; pass++) {
        g.lineWidth = pass === 0 ? Math.max(0.5, ring * 0.16) : Math.max(1, ring * 0.42);
        g.beginPath();
        for (let i = 0; i < 60; i++) {
          const major = i % 5 === 0;
          if ((pass === 1) !== major) continue;
          const a = (i / 60) * TAU - Math.PI / 2;
          const from = major ? inner - ring * 0.5 : inner;
          g.moveTo(Math.cos(a) * from, Math.sin(a) * from);
          g.lineTo(Math.cos(a) * outer, Math.sin(a) * outer);
        }
        g.stroke();
      }

      if (p.numerals !== 'ticks') {
        /**
         * Numerals big enough to be read, haloed so they carry.
         *
         * Upright rather than turned round the dial: a clock face on a house is
         * read once, quickly, from an angle, and VI upside down is a puzzle.
         * The halo is two widening strokes of the same colour at low strength,
         * not a shadow blur — twelve glyphs a frame through `shadowBlur` is a
         * twelve-layer composite, and the bloom downstream does the rest.
         */
        const roman = p.numerals === 'roman';
        const px = radius * (roman ? 0.2 : 0.24);
        const at = inner - px * (roman ? 0.85 : 0.8);
        g.font = `700 ${px}px ui-serif, Georgia, 'Times New Roman', serif`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.lineJoin = 'round';
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * TAU - Math.PI / 2;
          const label = roman ? ROMAN[i] : String(i === 0 ? 12 : i);
          const x = Math.cos(a) * at;
          const y = Math.sin(a) * at + px * 0.04;
          // Wide numerals at three and nine sit further in, so VIII and IIII
          // do not run into the minute track.
          const squeeze = roman ? 1 - 0.18 * Math.abs(Math.cos(a)) * (label.length > 2 ? 1 : 0.4) : 1;
          g.save();
          g.translate(x * squeeze, y);
          if (p.glow > 0) {
            g.strokeStyle = rgba(p.rim, 0.12 * Math.min(2, p.glow));
            g.lineWidth = px * 0.32;
            g.strokeText(label, 0, 0);
            g.lineWidth = px * 0.14;
            g.strokeText(label, 0, 0);
          }
          g.fillStyle = p.rim;
          g.fillText(label, 0, 0);
          g.restore();
        }
      }
    }

    /**
     * The hands.
     *
     * Each is one line from its tail to its tip, stroked twice — wide and faint
     * for the glow round it, then narrow — and then the shaped blade filled
     * over it. The line is what a hand *is*, geometrically: it is where it
     * points, and it is what the tests check. The rest is so that it reads as a
     * hand from across the street.
     */
    const hand = (turns, length, width, colour) => {
      const a = turns * TAU - Math.PI / 2;
      g.lineCap = 'round';
      g.beginPath();
      // A short counterweight past the centre — every real hand has one, and
      // its absence is one of those things you feel rather than notice.
      g.moveTo(-Math.cos(a) * length * 0.17, -Math.sin(a) * length * 0.17);
      g.lineTo(Math.cos(a) * length, Math.sin(a) * length);
      if (p.glow > 0) {
        g.globalCompositeOperation = 'lighter';
        g.strokeStyle = rgba(colour, 0.09 * Math.min(2, p.glow) * (1 + beat));
        g.lineWidth = width * 2.3;
        g.stroke();
        g.globalCompositeOperation = 'source-over';
      }
      g.strokeStyle = colour;
      g.lineWidth = Math.max(0.8, width * 0.45);
      g.stroke();
      traceHand(g, length, width * 0.75, a);
      g.fillStyle = colour;
      g.fill();
    };

    hand(hours / 12, radius * 0.52, ring * 1.6, p.hands);
    hand(minutes / 60, radius * 0.78, ring * 1.2, p.hands);
    if (p.second !== 'none') {
      // A quartz clock steps; a mechanical one sweeps. The step is worth having
      // through a countdown, because the eye catches the jump and the crowd
      // counts with it.
      const s = p.second === 'sweep' ? seconds : Math.floor(seconds);
      const a = (s / 60) * TAU - Math.PI / 2;
      const length = radius * 0.86;
      g.strokeStyle = p.rim;
      g.lineWidth = Math.max(0.8, ring * 0.32);
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(-Math.cos(a) * length * 0.22, -Math.sin(a) * length * 0.22);
      g.lineTo(Math.cos(a) * length, Math.sin(a) * length);
      g.stroke();
      // Its counterweight, as a disc.
      g.fillStyle = p.rim;
      g.beginPath();
      g.arc(-Math.cos(a) * length * 0.16, -Math.sin(a) * length * 0.16, ring * 0.55, 0, TAU);
      g.fill();
    }

    // The arbor: a brass boss over all three.
    g.fillStyle = p.rim;
    g.beginPath();
    g.arc(0, 0, ring * 1.05, 0, TAU);
    g.fill();
    g.fillStyle = mixHex(p.rim, '#ffffff', 0.55);
    g.beginPath();
    g.arc(-ring * 0.25, -ring * 0.25, ring * 0.35, 0, TAU);
    g.fill();

    g.restore();

    /* --- The moment itself --- */

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
      g.save();
      g.globalCompositeOperation = 'lighter';
      const f = 1 - (-remaining) / p.flare;
      glow(g, cx, cy, radius * 4.5, p.flareColor, 0.9 * f * f);
      const ringR = radius * (1 + (1 - f) * 3);
      g.strokeStyle = rgba(p.flareColor, 0.7 * f);
      g.lineWidth = ring * 2 * f;
      g.beginPath();
      g.arc(cx, cy, ringR, 0, TAU);
      g.stroke();
      g.restore();
    }
  },
};

export default [cake, balloons, bunting, confetti, meteors, clockFace];
