/**
 * Brickwork, and what is behind it.
 *
 * Two effects that only make sense together. **Brickwork** lays a course of
 * bricks over a shape; **Breach** takes them out one at a time and lets
 * something reach through the hole. They are separate so you can have the wall
 * without the horror — a plain brick wall is the single most useful thing to
 * put on a rendered or painted facade, because it gives every other effect
 * somewhere to live.
 *
 * The design problem here is that a wall is thousands of small objects and a
 * projector frame is sixteen milliseconds. The answer is the same one the vine
 * uses: the intact wall never changes, so it is baked into a bitmap once and
 * blitted thereafter. Only the handful of bricks currently coming loose is ever
 * drawn as geometry. A wall of four hundred bricks and a wall of four thousand
 * cost the same per frame.
 *
 * The second design problem is resolution. This is aimed at a projector, and a
 * domestic one puts about half a pixel on the wall for every pixel an effect
 * draws in. Mortar lines at their true 10mm scale land under one projector
 * pixel and turn into grey haze. So everything structural here is deliberately
 * fatter than life — see the note on the four-pixel floor in docs/effects.md —
 * and what makes the wall read as masonry from the pavement is carried by
 * things that are big: every brick its own tone, the odd over-burnt one nearly
 * black, a shadow along the underside of every course where the joint is set
 * back, and staining that spreads across whole patches of the wall.
 *
 * The fine work — pitting, sand, a knocked corner, a lit arris — is under that
 * floor, and is drawn anyway, because it is baked once and costs nothing after.
 * On the wall it averages into the brick's tone, which is what fired clay does
 * at six metres; in a photograph of the house, or from the front path, it is
 * the difference between brick and a picture of brick.
 */

import { rgba, clamp, TAU, mixHex, makeRng, pointInPolygon, smoothstep, hexToRgb } from '../../core/math.js';
import { collectObstacles, isClear, nearestSurface } from '../obstacles.js';
import { offscreen, glow } from '../lib.js';

/** Shared with the facade family so the wording stays consistent. */
const OBSTACLE_PARAM = {
  key: 'obstacles',
  type: 'text',
  label: 'Solid tags',
  default: 'window, door',
};

/**
 * Does this brick come within `margin` of an opening?
 *
 * Rectangle against expanded bounding box — deliberately the bounding box and
 * not the outline, even for an arch. A hole that opens level with the top of a
 * window reads as damage to the window rather than to the wall, so keeping the
 * whole bounding area clear is both cheaper and more conservative than
 * following the shape exactly. The *brickwork* still cuts its reveals to the
 * true outline; this is only about where a breach may open.
 */
function nearObstacle(obstacles, x, y, w, h, margin) {
  for (const o of obstacles) {
    const b = o.bbox;
    if (x + w < b.x - margin || x > b.x + b.w + margin) continue;
    if (y + h < b.y - margin || y > b.y + b.h + margin) continue;
    return true;
  }
  return false;
}

/**
 * Every brick in the shape, in laying order.
 *
 * Running bond — alternate courses offset by half a brick — because it is what
 * almost every British house is, and because stack bond reads as tiling rather
 * than as masonry: the eye finds the continuous vertical joints immediately and
 * stops believing it.
 */
/**
 * Lay a running bond over a bounding box, on a lattice anchored in world space.
 *
 * Anchored in world space, not to the box, and that is the change that makes the
 * courses mean anything. Anchoring to each shape's own bounding box gave every
 * traced area its own private brick grid: two walls either side of a door
 * disagreed about where the courses were, and no combination of settings could
 * make them agree, because the disagreement was in the anchor rather than in the
 * numbers. One lattice across the whole building is both what masonry does and
 * the only arrangement that can be registered onto real brickwork.
 *
 * `origin` is that registration. Square the wall up first — otherwise the
 * courses are a constant size on the *camera picture* and no offset will hold
 * them on real courses across the whole facade — then nudge these two numbers
 * until the projected bed joints sit on the real ones.
 */
function layCourses(bbox, w, h, gap, origin = { x: 0, y: 0 }) {
  const bricks = [];
  const pitchY = h + gap;
  const pitchX = w + gap;

  const firstRow = Math.floor((bbox.y - origin.y) / pitchY);
  const rows = Math.ceil(bbox.h / pitchY) + 2;

  for (let i = 0; i < rows; i++) {
    const r = firstRow + i;
    const y = origin.y + r * pitchY;
    // Modulo that survives negative rows: a shape above the origin must stagger
    // the same way as one below it, or the bond breaks at y = 0.
    const offset = (((r % 2) + 2) % 2) ? -pitchX / 2 : 0;
    const firstCol = Math.floor((bbox.x - origin.x - offset) / pitchX);
    const cols = Math.ceil(bbox.w / pitchX) + 2;
    for (let j = 0; j < cols; j++) {
      const c = firstCol + j;
      const x = origin.x + offset + c * pitchX;
      if (x > bbox.x + bbox.w || x + w < bbox.x) continue;
      bricks.push({ x, y, cx: x + w / 2, cy: y + h / 2, row: r, col: c });
    }
  }
  return bricks;
}

/**
 * A brick's place in the lattice, as thirty-two well-mixed bits.
 *
 * Everything about how a brick looks is drawn from this rather than from one
 * generator run down the wall in laying order, and that is what lets two layers
 * agree about a single brick. In laying order, the colour of the brick at a
 * given course and column depended on how many bricks had been laid before it
 * — which depends on where the shape's bounding box starts — so Breach could
 * not know what colour the brick it was taking out had been, and retracing the
 * wall a pixel reshuffled every brick on it. Hashed from (row, col), a brick is
 * the same brick whichever layer asks and however the shape was traced.
 */
function brickHash(seed, row, col) {
  let h = (Math.imul(col | 0, 374761393) + Math.imul(row | 0, 668265263)
    + Math.imul((seed | 0) + 40503, 2246822519)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Which delivery a brick came from: a slow wander across the wall, in [0, 1].
 *
 * Value noise on a lattice four courses by three bricks. Real walls are not an
 * independent draw per brick — a pallet of slightly darker bricks goes into one
 * stretch and a paler one into the next — and per-brick noise alone reads as
 * television static at house scale, where the patches are the first thing the
 * eye finds.
 */
function batchAt(seed, row, col) {
  const fy = row / 4;
  const fx = col / 3;
  const y0 = Math.floor(fy);
  const x0 = Math.floor(fx);
  const ty = smoothstep(0, 1, fy - y0);
  const tx = smoothstep(0, 1, fx - x0);
  const v = (r, c) => (brickHash(seed + 7919, r, c) & 0xffff) / 0xffff;
  const top = v(y0, x0) + (v(y0, x0 + 1) - v(y0, x0)) * tx;
  const bottom = v(y0 + 1, x0) + (v(y0 + 1, x0 + 1) - v(y0 + 1, x0)) * tx;
  return top + (bottom - top) * ty;
}

/** Over-fired: the clinker end of the kiln, nearly black with a purple cast. */
const BURNT = '#2b1c22';
/** Under-fired: soft, sandy and salmon. */
const PALE = '#c4916d';

/**
 * The colour a brick was fired, and the generator its texture is drawn from.
 *
 * Three things vary, at three scales. Each brick takes its own mix of the two
 * colours, its own lean in hue and its own lightness — that is the difference
 * between masonry and graph paper. Patches of the wall lean one way together (`batchAt`). And a few
 * in a hundred are the odd ones out: over-burnt bricks, which go nearly black
 * and are the single most recognisable thing about an old brick wall seen from
 * across a road, and the occasional soft pale one.
 *
 * Variation scales all of it, so at nought every brick is exactly `color` and
 * the wall is the tidy diagram it used to be.
 */
function brickLook(p, row, col) {
  const v = clamp(Number(p.variation) || 0, 0, 1);
  const rng = makeRng(brickHash(p.seed, row, col));
  const batch = batchAt(p.seed, row, col) - 0.5;
  const mix = clamp(rng() * v * 0.9 + batch * v * 0.8, 0, 1);
  let tone = mixHex(p.color, p.color2, mix);
  // Hue as well as depth: some bricks come out of the kiln oranger, some
  // towards plum. Mixing only between the two chosen colours gives a wall in
  // one hue at several brightnesses, which is a print rather than a wall.
  const hue = (rng() - 0.5) * v * 0.5;
  tone = mixHex(tone, hue > 0 ? '#c0642f' : '#5b3440', Math.abs(hue));
  const shade = (rng() - 0.5) * v * 0.6 + batch * v * 0.24;
  tone = mixHex(tone, shade > 0 ? '#ffffff' : '#000000', Math.abs(shade));
  const fate = rng();
  if (fate < 0.09 * v) tone = mixHex(tone, BURNT, 0.4 + rng() * 0.28);
  else if (fate > 1 - 0.05 * v) tone = mixHex(tone, PALE, 0.16 + rng() * 0.2);
  return { tone, rng };
}

/**
 * One brick in the baked wall, lit from the top left, standing proud of a joint
 * that is set back from it.
 *
 * The face rectangle comes first and is exactly the brick, filled in its own
 * tone; everything after it is laid over that rectangle or into the joint
 * beside it, never over a neighbour. In order:
 *
 *  - **Clay.** A patch or two lighter or darker, and one end of some bricks
 *    darkened where the kiln flame reached it — fired clay is never one colour
 *    from end to end, and a face that is reads as plastic.
 *  - **Grain.** Pits and grains of sand, a couple of pixels each. Under the
 *    projector floor and deliberately so: see the note at the top.
 *  - **Light.** The face a touch brighter along the top and darker towards the
 *    bottom, as one soft gradient rather than the hard bands that were here
 *    before, which read as a bevel on a cartoon brick. The top arris catches
 *    the light in the brick's own colour; the right-hand one is turned away.
 *  - **The joint.** Recessed mortar is what makes brickwork look laid rather
 *    than printed. Each brick throws a shadow across the top of the bed joint
 *    under it, and the bottom of that joint, out of the shadow, is lit — so
 *    every joint is dark above and light below, and every course appears to
 *    stand forward of the one beneath it. Drawn in the joint, outside the face,
 *    so the face rectangle still tells Breach exactly where the brick is.
 *
 * And now and then a knocked corner, in the darker clay behind the face.
 */
function layBrick(c, x, y, w, h, gap, look, relief, variation, recess, fine) {
  const r = look.rng;
  c.fillStyle = look.tone;
  c.fillRect(x, y, w, h);
  if (relief <= 0) return;

  if (fine) {
    const blots = r() < 0.55 ? 2 : 1;
    for (let k = 0; k < blots; k++) {
      const bx = x + r() * w;
      const by = y + r() * h;
      const rad = h * (0.7 + r() * 1.2);
      const dark = r() < 0.62;
      const a = (dark ? 0.1 + r() * 0.14 : 0.05 + r() * 0.08) * (0.35 + variation);
      const ink = dark ? '34,12,8' : '255,226,196';
      const blot = c.createRadialGradient(bx, by, 0, bx, by, rad);
      blot.addColorStop(0, `rgba(${ink},${a})`);
      blot.addColorStop(1, `rgba(${ink},0)`);
      c.fillStyle = blot;
      c.fillRect(x, y, w, h);
    }

    if (r() < 0.45) {
      const fromLeft = r() < 0.5;
      const x0 = fromLeft ? x : x + w;
      const x1 = fromLeft ? x + w * (0.35 + r() * 0.3) : x + w * (0.65 - r() * 0.3);
      const flash = c.createLinearGradient(x0, 0, x1, 0);
      const a = (0.1 + r() * 0.18) * (0.3 + variation);
      flash.addColorStop(0, `rgba(30,12,16,${a})`);
      flash.addColorStop(1, 'rgba(30,12,16,0)');
      c.fillStyle = flash;
      c.fillRect(x, y, w, h);
    }

    // By area, so a big brick is as gritty as a small one, up to a ceiling
    // that keeps the bake of a large wall of large bricks quick.
    const specks = Math.min(150, Math.round(((w * h) / 46) * relief));
    if (specks > 0) {
      c.beginPath();
      for (let k = 0; k < specks; k++) {
        const s = 0.7 + r() * 1.4;
        c.rect(x + r() * (w - s), y + r() * (h - s), s, s);
      }
      c.fillStyle = 'rgba(18,6,4,0.34)';
      c.fill();
      c.beginPath();
      for (let k = 0; k < specks * 0.6; k++) {
        const s = 0.6 + r() * 1.1;
        c.rect(x + r() * (w - s), y + r() * (h - s), s, s);
      }
      c.fillStyle = 'rgba(255,232,206,0.22)';
      c.fill();
    }
  }

  const lit = c.createLinearGradient(0, y, 0, y + h);
  lit.addColorStop(0, `rgba(255,236,214,${0.14 * relief})`);
  lit.addColorStop(0.3, 'rgba(255,236,214,0)');
  lit.addColorStop(0.6, 'rgba(0,0,0,0)');
  lit.addColorStop(1, `rgba(0,0,0,${0.3 * relief})`);
  c.fillStyle = lit;
  c.fillRect(x, y, w, h);

  const edge = Math.max(1, Math.min(w, h) * 0.07);
  c.fillStyle = rgba(mixHex(look.tone, '#fff0dc', 0.55), 0.42 * relief);
  c.fillRect(x, y, w, edge);
  c.fillStyle = rgba(mixHex(look.tone, '#fff0dc', 0.4), 0.16 * relief);
  c.fillRect(x, y + edge, edge, h - edge);
  c.fillStyle = `rgba(0,0,0,${0.22 * relief})`;
  c.fillRect(x + w - edge, y + edge, edge, h - edge);

  if (fine && r() < 0.13 * relief) {
    const corner = Math.floor(r() * 4);
    const cw = Math.min(w * 0.2, h * (0.18 + r() * 0.22));
    const ch = cw * (0.6 + r() * 0.5);
    const cx = corner & 1 ? x + w : x;
    const cy = corner & 2 ? y + h : y;
    const sx = corner & 1 ? -1 : 1;
    const sy = corner & 2 ? -1 : 1;
    c.beginPath();
    c.moveTo(cx, cy);
    c.lineTo(cx + sx * cw, cy);
    c.lineTo(cx + sx * cw * 0.45, cy + sy * ch * 0.45);
    c.lineTo(cx, cy + sy * ch);
    c.closePath();
    c.fillStyle = mixHex(look.tone, recess, 0.55);
    c.fill();
  }

  if (gap > 0) {
    // Into the bed joint below: the shadow of this brick across the top of it,
    // and the bottom of it, out of that shadow, catching the light. With a dark
    // mortar the lit strip is what carries it — a projector cannot make the
    // shadow darker than a wall it is not lighting.
    c.fillStyle = `rgba(0,0,0,${0.55 * relief})`;
    c.fillRect(x, y + h, w + gap * 0.3, gap * 0.5);
    c.fillStyle = rgba(mixHex(recess, '#e9dccb', 0.3), 0.75 * relief);
    c.fillRect(x - gap * 0.5, y + h + gap * 0.66, w + gap, gap * 0.34);
    // And the end joint to the right, in shadow on its near side.
    c.fillStyle = `rgba(0,0,0,${0.4 * relief})`;
    c.fillRect(x + w, y, gap * 0.4, h + gap * 0.5);
  }
}

/**
 * A brick that is out of the wall, or on its way out — Breach's, drawn live.
 *
 * The same light as `layBrick` at a fraction of the cost: the face in the
 * brick's own tone, the soft top-to-bottom shading, the lit arris and a grain
 * stamped from one sprite rather than drawn speck by speck. A brick that is
 * rattling or tumbling is moving too fast for its pits to be told from the
 * wall's, and a dozen of them a frame have to fit in the budget.
 *
 * Drawn about its own centre, so the caller rotates rather than does
 * trigonometry.
 */
function paintLooseBrick(g, w, h, tone, grain) {
  const x = -w / 2;
  const y = -h / 2;
  g.fillStyle = tone;
  g.fillRect(x, y, w, h);
  if (grain) g.drawImage(grain, x, y, w, h);
  const edge = Math.max(1, Math.min(w, h) * 0.08);
  g.fillStyle = 'rgba(255,236,214,0.2)';
  g.fillRect(x, y, w, edge);
  g.fillStyle = 'rgba(0,0,0,0.32)';
  g.fillRect(x, y + h - edge * 1.6, w, edge * 1.6);
  g.fillStyle = 'rgba(0,0,0,0.18)';
  g.fillRect(x + w - edge, y, edge, h);
}

/**
 * The grain `paintLooseBrick` stamps: pits, sand, a soft patch and the face's
 * top-to-bottom light, on transparency, so one sprite serves every tone.
 */
function bakeGrain(w, h, seed) {
  const pw = Math.max(8, Math.round(w));
  const ph = Math.max(4, Math.round(h));
  const canvas = offscreen(pw, ph);
  const c = canvas.getContext('2d');
  const r = makeRng(`brick-grain:${seed}`);
  const lit = c.createLinearGradient(0, 0, 0, ph);
  lit.addColorStop(0, 'rgba(255,236,214,0.14)');
  lit.addColorStop(0.3, 'rgba(255,236,214,0)');
  lit.addColorStop(0.6, 'rgba(0,0,0,0)');
  lit.addColorStop(1, 'rgba(0,0,0,0.3)');
  c.fillStyle = lit;
  c.fillRect(0, 0, pw, ph);
  const bx = pw * (0.2 + r() * 0.6);
  const blot = c.createRadialGradient(bx, ph * 0.5, 0, bx, ph * 0.5, ph * 1.3);
  blot.addColorStop(0, 'rgba(34,12,8,0.2)');
  blot.addColorStop(1, 'rgba(34,12,8,0)');
  c.fillStyle = blot;
  c.fillRect(0, 0, pw, ph);
  const specks = Math.min(60, Math.round((pw * ph) / 40));
  c.beginPath();
  for (let k = 0; k < specks; k++) c.rect(r() * (pw - 1.5), r() * (ph - 1.5), 0.8 + r() * 1.2, 0.8 + r() * 1.2);
  c.fillStyle = 'rgba(18,6,4,0.34)';
  c.fill();
  c.beginPath();
  for (let k = 0; k < specks * 0.6; k++) c.rect(r() * (pw - 1.5), r() * (ph - 1.5), 0.7 + r(), 0.7 + r());
  c.fillStyle = 'rgba(255,232,206,0.22)';
  c.fill();
  return canvas;
}

/**
 * Weather the whole wall, once the bricks are in.
 *
 * Per-brick variation is texture; this is history, and it is what makes a wall
 * look like it has been standing in the rain rather than delivered this
 * morning. Three kinds, all soft and all large enough to read from the road:
 *
 *  - grime and the odd paler patch, spread across several bricks at a time;
 *  - the bottom few courses darkened, where rain splashes back off the ground;
 *  - and a stain running down from under every sill, darkest at the ends where
 *    the water drips off. That last one is cheap and does more than anything
 *    else here to make the projected wall belong to the house — it is the
 *    brickwork knowing where the real windows are.
 *
 * All scaled by Variation, so a wall asked to be uniform stays uniform.
 */
function weather(c, bbox, p, obstacles, rng, w, h, gap) {
  const v = clamp(Number(p.variation) || 0, 0, 1);
  if (v <= 0) return;
  const span = Math.max(w, h);

  const count = clamp(Math.round((bbox.w * bbox.h) / 60000), 2, 28);
  for (let i = 0; i < count; i++) {
    const cx = bbox.x + rng() * bbox.w;
    const cy = bbox.y + rng() * bbox.h;
    const rad = span * (1.4 + rng() * 3.4);
    const dark = rng() < 0.72;
    const a = (dark ? 0.09 + rng() * 0.13 : 0.04 + rng() * 0.06) * v;
    const ink = dark ? '22,10,8' : '255,228,200';
    const patch = c.createRadialGradient(cx, cy, 0, cx, cy, rad);
    patch.addColorStop(0, `rgba(${ink},${a})`);
    patch.addColorStop(0.55, `rgba(${ink},${a * 0.45})`);
    patch.addColorStop(1, `rgba(${ink},0)`);
    c.fillStyle = patch;
    c.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
  }

  const pitch = h + gap;
  if (bbox.h > pitch * 8) {
    const top = bbox.y + bbox.h - Math.min(bbox.h * 0.16, pitch * 6);
    const splash = c.createLinearGradient(0, top, 0, bbox.y + bbox.h);
    splash.addColorStop(0, 'rgba(14,8,6,0)');
    splash.addColorStop(1, `rgba(14,8,6,${0.32 * v})`);
    c.fillStyle = splash;
    c.fillRect(bbox.x, top, bbox.w, bbox.y + bbox.h - top);
  }

  // Under the sills. Paths rather than rectangles, and not for the look: the
  // count of rectangles laid is the count of bricks laid, and it should not
  // depend on how many windows there are.
  for (const o of obstacles) {
    const b = o.bbox;
    const top = b.y + b.h;
    const below = bbox.y + bbox.h - top;
    if (below < pitch * 3) continue;
    if (b.x + b.w < bbox.x || b.x > bbox.x + bbox.w || top < bbox.y) continue;
    const len = Math.min(below * 0.8, Math.max(b.h * 1.1, pitch * 4));
    const stain = c.createLinearGradient(0, top, 0, top + len);
    stain.addColorStop(0, `rgba(16,10,10,${0.26 * v})`);
    stain.addColorStop(0.35, `rgba(16,10,10,${0.12 * v})`);
    stain.addColorStop(1, 'rgba(16,10,10,0)');
    c.fillStyle = stain;
    c.beginPath();
    c.moveTo(b.x + b.w * 0.03, top);
    c.lineTo(b.x + b.w * 0.97, top);
    c.lineTo(b.x + b.w * (0.84 - rng() * 0.08), top + len);
    c.lineTo(b.x + b.w * (0.16 + rng() * 0.08), top + len);
    c.closePath();
    c.fill();
    for (const at of [0.05, 0.95]) {
      const run = len * (1.1 + rng() * 0.5);
      const wide = Math.max(3, span * 0.12);
      const drip = c.createLinearGradient(0, top, 0, top + run);
      drip.addColorStop(0, `rgba(12,8,8,${0.3 * v})`);
      drip.addColorStop(1, 'rgba(12,8,8,0)');
      c.fillStyle = drip;
      c.beginPath();
      c.rect(b.x + b.w * at - wide / 2, top, wide, run);
      c.fill();
    }
  }
}

/**
 * Bake the intact wall.
 *
 * Once, into a bitmap the size of the shape, capped so an enormous traced area
 * cannot allocate an enormous canvas. Everything after this is one drawImage.
 */
function bakeWall(bbox, p, obstacles, rng) {
  const scale = Math.min(1, 1400 / Math.max(bbox.w, bbox.h));
  const canvas = offscreen(bbox.w * scale, bbox.h * scale);
  const c = canvas.getContext('2d');
  c.setTransform(scale, 0, 0, scale, -bbox.x * scale, -bbox.y * scale);

  const w = Math.max(6, p.brickW);
  const h = Math.max(3, p.brickH);
  const gap = Math.max(0, p.gap);
  const relief = clamp(Number(p.relief) || 0, 0, 1);
  const variation = clamp(Number(p.variation) || 0, 0, 1);

  // The mortar is the background, showing through the joints. Drawing it as a
  // solid field and laying bricks on top is both simpler and more convincing
  // than stroking lines between them, because the joints then have real width
  // and take the shadow of the course above.
  c.fillStyle = p.mortar;
  c.fillRect(bbox.x, bbox.y, bbox.w, bbox.h);

  // The texture is skipped where it could not be seen: a brick under six
  // pixels tall on the baked bitmap — a huge traced area, or the smallest
  // bricks the slider allows — keeps its tone and its joint and loses the pits,
  // which also keeps the bake of forty thousand of them to a blink.
  const fine = h * scale >= 6;
  const recess = mixHex(p.mortar, '#000000', 0.4);
  const bricks = layCourses(bbox, w, h, gap, { x: p.originX || 0, y: p.originY || 0 });
  for (const brick of bricks) {
    layBrick(c, brick.x, brick.y, w, h, gap, brickLook(p, brick.row, brick.col), relief, variation, recess, fine);
  }

  weather(c, bbox, p, obstacles, rng, w, h, gap);

  /**
   * Then cut the openings out, as the shapes they actually are.
   *
   * The obvious implementation is to skip any brick whose centre falls in a
   * window, and it looks wrong for a reason worth writing down: running bond
   * staggers alternate courses, so "every brick centred inside this rectangle"
   * is a ragged scatter, not a rectangle. You get single bricks missing around
   * each opening like a bad tooth. Real masonry has a clean reveal because the
   * bricks are *cut* at the opening, which is exactly what erasing the polygon
   * after laying them does — and it follows an arched or angled opening for
   * free, which no brick-by-brick test can.
   */
  if (obstacles.length) {
    c.globalCompositeOperation = 'destination-out';
    c.fillStyle = '#000000';
    for (const o of obstacles) {
      c.beginPath();
      c.moveTo(o.points[0].x, o.points[0].y);
      for (let i = 1; i < o.points.length; i++) c.lineTo(o.points[i].x, o.points[i].y);
      c.closePath();
      c.fill();
    }
    c.globalCompositeOperation = 'source-over';
  }

  return { canvas, scale, bricks, w, h };
}

/* ------------------------------------------------------------------ *
 * Brickwork
 * ------------------------------------------------------------------ */

/** Seconds a brick rattles in its bed before it lets go. */
const SHUDDER = 0.9;

const brickwork = {
  id: 'brickwork',
  name: 'Brickwork',
  category: 'facade',
  scope: 'shape',
  description:
    'A course of brick laid over the shape, in running bond with per-brick colour variation. On a white or rendered wall this is what gives everything else something to sit on.',
  params: [
    { key: 'color', type: 'color', label: 'Brick', default: '#8d4a35' },
    { key: 'color2', type: 'color', label: 'Second brick', default: '#5e2f24' },
    { key: 'mortar', type: 'color', label: 'Mortar', default: '#2a2724' },
    { key: 'brickW', type: 'range', label: 'Brick width', default: 132, min: 20, max: 400, step: 2 },
    { key: 'brickH', type: 'range', label: 'Brick height', default: 44, min: 8, max: 160, step: 1 },
    { key: 'gap', type: 'range', label: 'Mortar', default: 7, min: 0, max: 30, step: 0.5 },
    /**
     * Where the lattice starts, for registering the projection onto brickwork
     * that is already there. A whole pitch in either direction is all that can
     * ever be needed: past that the courses repeat.
     */
    { key: 'originX', type: 'range', label: 'Course offset across', default: 0, min: -400, max: 400, step: 1 },
    { key: 'originY', type: 'range', label: 'Course offset up', default: 0, min: -160, max: 160, step: 1 },
    { key: 'variation', type: 'range', label: 'Colour variation', default: 0.55, min: 0, max: 1, step: 0.01 },
    { key: 'relief', type: 'range', label: 'Relief', default: 0.7, min: 0, max: 1, step: 0.01 },
    OBSTACLE_PARAM,
    { key: 'seed', type: 'range', label: 'Seed', default: 1, min: 1, max: 99, step: 1 },
  ],
  init() {
    return { key: '' };
  },
  /**
   * Publish the course this wall is laid to.
   *
   * From `stable`, because that is what gets baked — a mortar width bound to
   * the microphone changes `p` sixty times a second and changes the wall never.
   * Breach reads this so its holes land on real bricks without anybody typing
   * the same three numbers into two panels and keeping them in step.
   *
   * In `publish` rather than in `draw`, because Breach reads it from its
   * simulation, and a simulation runs before anything is painted — thousands of
   * steps of it, all at once, in a tab that has just opened. Published from the
   * paint, the reader in such a tab found nothing there and laid its holes to a
   * different course from every tab that had been running. See the notice board
   * in render/worldRenderer.js.
   */
  publish({ shape, stable, share }) {
    share?.set(`brickwork:${shape.id}`, {
      w: Math.max(6, stable.brickW),
      h: Math.max(3, stable.brickH),
      gap: Math.max(0, stable.gap),
      originX: stable.originX || 0,
      originY: stable.originY || 0,
      // And what the bricks look like, so the brick that falls out of the wall
      // is the brick that was in it. `brickLook` is a function of these and the
      // brick's place in the lattice, and of nothing else.
      color: stable.color,
      color2: stable.color2,
      variation: stable.variation,
      seed: stable.seed,
    });
  },
  draw({ g, p, shape, state, shapes, stable }) {
    const { bbox } = shape;
    if (bbox.w <= 2 || bbox.h <= 2) return;

    const obstacles = collectObstacles(shapes, p.obstacles, shape.id);
    const key = wallKey(shape, stable, obstacles);
    if (state.key !== key) {
      state.key = key;
      state.wall = bakeWall(bbox, stable, obstacles, makeRng(`brick:${stable.seed}:${shape.id}`));
    }

    g.save();
    g.clip(shape.path);
    g.drawImage(state.wall.canvas, bbox.x, bbox.y, bbox.w, bbox.h);
    g.restore();
  },
};

/**
 * What invalidates a baked wall.
 *
 * Built from `stable` — the parameter values *before* modulation — so that
 * binding the mortar width to the microphone re-lays the wall never rather than
 * sixty times a second. The obstacle list is in it because a window traced
 * after the wall was baked has to punch through it.
 */
function wallKey(shape, p, obstacles) {
  return [
    shape.id,
    Math.round(shape.bbox.x),
    Math.round(shape.bbox.y),
    Math.round(shape.bbox.w),
    Math.round(shape.bbox.h),
    p.color, p.color2, p.mortar,
    p.brickW, p.brickH, p.gap, p.originX, p.originY, p.variation, p.relief, p.seed,
    obstacles.map((o) => o.id).join(','),
  ].join('|');
}

/* ------------------------------------------------------------------ *
 * Breach
 * ------------------------------------------------------------------ */

/**
 * A tentacle: a centreline of joints, each with a width, drawn as a filled
 * ribbon rather than a stroked line.
 *
 * Stroking would be a third of the code, and wrong. A stroke has one width, so
 * a tentacle cannot taper; and `lineWidth` under a couple of pixels is exactly
 * the thing that vanishes on a projector. A ribbon tapers, and the skin is
 * built as ribbons nested inside one another on the same spine — `scale` is the
 * fraction of the fitted width each one takes — which is honest about what it
 * covers, because every one of them is inside the outline that was fitted.
 */
function tentacleRibbon(g, joints, widths, scale = 1, nx = null, ny = null) {
  if (!nx) {
    jointNormals(joints);
    nx = NX;
    ny = NY;
  }
  g.beginPath();
  for (let i = 0; i < joints.length; i++) {
    const wx = nx[i] * widths[i] * scale;
    const wy = ny[i] * widths[i] * scale;
    if (i === 0) g.moveTo(joints[i].x + wx, joints[i].y + wy);
    else g.lineTo(joints[i].x + wx, joints[i].y + wy);
  }
  for (let i = joints.length - 1; i >= 0; i--) {
    g.lineTo(joints[i].x - nx[i] * widths[i] * scale, joints[i].y - ny[i] * widths[i] * scale);
  }
  g.closePath();
  g.fill();
}

/**
 * The unit normal at every joint — from the joints either side, which is the
 * one `fitWidths` measures against — into `NX` and `NY`.
 *
 * Worked out once an arm and shared by every ribbon of its skin and its sheen,
 * which were each working out the same few hundred angles for themselves.
 */
let NX = new Float64Array(1024);
let NY = new Float64Array(1024);
function jointNormals(joints) {
  const n = joints.length;
  if (NX.length < n) {
    NX = new Float64Array(n * 2);
    NY = new Float64Array(n * 2);
  }
  for (let i = 0; i < n; i++) {
    const b = joints[Math.min(i + 1, n - 1)];
    const prev = joints[Math.max(i - 1, 0)];
    const tx = b.x - prev.x;
    const ty = b.y - prev.y;
    const len = Math.hypot(tx, ty);
    if (len > 0) {
      NX[i] = -ty / len;
      NY[i] = tx / len;
    } else {
      NX[i] = 0;
      NY[i] = 1;
    }
  }
}

/** A closed outline into the current path, for clipping. */
function traceRing(g, points) {
  if (!points || points.length < 3) return;
  g.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) g.lineTo(points[i].x, points[i].y);
  g.closePath();
}

/**
 * What the bricks in this wall look like, for the bricks Breach takes out of it.
 *
 * The Brickwork layer's own colours when the two are matched, so the brick that
 * rattles loose and falls is the brick that was there — `brickLook` is a pure
 * function of these and the brick's place in the lattice. Otherwise the Falling
 * brick colour, varied the same way, for a wall that is brick already.
 */
function wallLookFor(stable, share, shape) {
  const laid = stable.match ? share?.get(`brickwork:${shape.id}`) : null;
  if (laid && laid.color) return laid;
  return { color: stable.brick, color2: mixHex(stable.brick, '#000000', 0.3), variation: 0.55, seed: stable.seed };
}

/**
 * Sprites for the moving parts, baked once per brick size and colour.
 *
 * A grain for loose bricks, a soft puff for the dust, and the light on the end
 * of each arm. Keyed on `stable` and kept apart from the layout, so turning the
 * tip colour does not drop every hole in the wall.
 */
function spritesFor(state, stable, w, h) {
  const key = `${w}|${h}|${stable.armTip}|${stable.innerGlow}|${stable.seed}`;
  if (state.spriteKey === key) return state.sprites;
  state.spriteKey = key;

  const puff = offscreen(64, 64);
  {
    const c = puff.getContext('2d');
    const soft = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    soft.addColorStop(0, 'rgba(196,182,160,0.9)');
    soft.addColorStop(0.35, 'rgba(196,182,160,0.5)');
    soft.addColorStop(0.7, 'rgba(196,182,160,0.14)');
    soft.addColorStop(1, 'rgba(196,182,160,0)');
    c.fillStyle = soft;
    c.fillRect(0, 0, 64, 64);
  }

  // Inverse-square, like every other light in the library, in a colour between
  // the tip's own and the light inside the wall: whatever is behind the bricks,
  // the arms are lit by it.
  const tip = offscreen(64, 64);
  {
    const c = tip.getContext('2d');
    const { r, g: gr, b } = hexToRgb(mixHex(mixHex(stable.armTip, stable.innerGlow, 0.6), '#ffffff', 0.15));
    const light = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    for (const [at, fall] of [[0, 1], [0.08, 0.8], [0.18, 0.45], [0.35, 0.16], [0.6, 0.05], [1, 0]]) {
      light.addColorStop(at, `rgba(${r},${gr},${b},${fall})`);
    }
    c.fillStyle = light;
    c.fillRect(0, 0, 64, 64);
  }

  state.sprites = { grain: bakeGrain(w, h, stable.seed), puff, tip };
  return state.sprites;
}

/** Thirty-two bits, from a brick and a place on it, as a fraction in [0, 1]. */
function jag(brick, side, k) {
  return (brickHash(side * 131 + k + 17, brick.row, brick.col) & 1023) / 1023;
}

/** Is this point inside a gone brick other than `self`, grown by the joint? */
function inOtherGone(hole, self, x, y, w, h, gap) {
  for (const b of hole.gone) {
    if (b === self) continue;
    if (x > b.x - gap && x < b.x + w + gap && y > b.y - gap && y < b.y + h + gap) return true;
  }
  return false;
}

/**
 * The outline of a hole, into the current path.
 *
 * The gone bricks grown by their joint — which is what merges five removed
 * bricks into one hole rather than five letterboxes — and then, along the
 * edges that face wall rather than more hole, the odd shard out of a
 * neighbouring brick. Bricks do not come out of a wall cleanly at the joint:
 * they take corners of their neighbours with them, and a hole whose edge is a
 * perfect staircase reads as a rectangle somebody drew, not as damage.
 *
 * `grow` widens all of it at once, which is how the lit edge is drawn: the
 * grown outline in lit brick, then the outline itself in black over it, leaves
 * a band of exactly `grow` all the way round — following every bite.
 *
 * Bites are turned rectangles, each a subpath of its own: angular, because
 * broken brick is, and sparse, because a hole whose whole edge is nibbled
 * reads as a cloud. `rects` leaves the bricks out, for the one pass that fills
 * them one at a time instead.
 */
function holeOutline(g, hole, w, h, gap, bite, grow, rects = true) {
  if (rects) {
    for (const brick of hole.gone) {
      g.rect(brick.x - gap - grow, brick.y - gap - grow, w + (gap + grow) * 2, h + (gap + grow) * 2);
    }
  }
  if (bite <= 0) return;
  for (const brick of hole.gone) {
    const x0 = brick.x - gap;
    const y0 = brick.y - gap;
    const x1 = brick.x + w + gap;
    const y1 = brick.y + h + gap;
    const across = Math.max(1, Math.round((x1 - x0) / (bite * 3)));
    const down = Math.max(1, Math.round((y1 - y0) / (bite * 3)));
    for (let side = 0; side < 4; side++) {
      const n = side & 1 ? down : across;
      for (let k = 0; k < n; k++) {
        // Not every stretch of edge loses a piece: about half do.
        if (jag(brick, side + 8, k) < 0.48) continue;
        const u = (k + 0.2 + 0.6 * jag(brick, side + 4, k)) / n;
        let px;
        let py;
        let nx = 0;
        let ny = 0;
        if (side === 0) { px = x0 + (x1 - x0) * u; py = y0; ny = -1; }
        else if (side === 1) { px = x1; py = y0 + (y1 - y0) * u; nx = 1; }
        else if (side === 2) { px = x0 + (x1 - x0) * u; py = y1; ny = 1; }
        else { px = x0; py = y0 + (y1 - y0) * u; nx = -1; }
        if (inOtherGone(hole, brick, px + nx * 2, py + ny * 2, w, h, gap)) continue;
        // A shard: a rectangle turned off the line of the edge, so what is
        // left of the neighbour has a corner knocked off rather than a bite.
        const long = bite * (0.5 + 0.7 * jag(brick, side, k)) + grow;
        const deep = bite * (0.35 + 0.5 * jag(brick, side + 12, k)) + grow;
        const turn = Math.atan2(ny, nx) + Math.PI / 2 + (jag(brick, side + 16, k) - 0.5) * 1.2;
        g.save();
        g.translate(px, py);
        g.rotate(turn);
        g.rect(-long, -deep, long * 2, deep * 2);
        g.restore();
      }
    }
  }
}

/** How far a hole reaches from its centre: to the far corner of its furthest brick. */
function holeReach(hole, w, h, gap) {
  let reach = Math.max(w, h) * 0.5;
  for (const b of hole.gone) {
    const dx = Math.max(Math.abs(b.x - gap - hole.cx), Math.abs(b.x + w + gap - hole.cx));
    const dy = Math.max(Math.abs(b.y - gap - hole.cy), Math.abs(b.y + h + gap - hole.cy));
    reach = Math.max(reach, Math.hypot(dx, dy));
  }
  return reach;
}

/**
 * Brick size, mortar and the lattice of bricks a hole may take from.
 *
 * Wanted by `step`, which decides which of them let go, and by `draw`, which has
 * to know how big to paint them — and expensive enough that neither should be
 * working it out twice a frame. Cached on the geometry it depends on, so it is
 * rebuilt when a shape is retraced or a slider moves and not otherwise.
 *
 * Rebuilding drops the holes on the floor, which is correct: the bricks they
 * were made of no longer exist.
 *
 * Built from `stable` — the parameters before modulation — for exactly the
 * reason Brickwork bakes its wall from them. Bind the brick width to the
 * microphone and keying this on the modulated value rebuilds the lattice sixty
 * times a second, which drops every hole in the wall sixty times a second: the
 * breach stops happening at all and the machine works hard to show it.
 *
 * @returns {{w:number,h:number,gap:number}|null} null when there is no wall to
 *   take apart — a shape so small or so full of windows that no brick fits.
 */
function layoutFor({ stable, shape, shapes, share, state }) {
  const { bbox } = shape;
  const obstacles = collectObstacles(shapes, stable.obstacles, shape.id);

  // The course the Brickwork layer on this shape laid, if there is one. Both
  // effects build from the same bbox with the same maths, so agreeing on these
  // few numbers is all it takes to agree on every brick.
  const laid = stable.match ? share?.get(`brickwork:${shape.id}`) : null;
  const w = laid ? laid.w : Math.max(6, stable.brickW);
  const h = laid ? laid.h : Math.max(3, stable.brickH);
  const gap = laid ? laid.gap : Math.max(0, stable.gap);
  const origin = laid
    ? { x: laid.originX || 0, y: laid.originY || 0 }
    : { x: stable.originX || 0, y: stable.originY || 0 };

  const key = [shape.id, Math.round(bbox.x), Math.round(bbox.y), Math.round(bbox.w), Math.round(bbox.h),
    w, h, gap, origin.x, origin.y,
    obstacles.map((o) => o.id).join(',')].join('|');

  if (state.key !== key) {
    state.key = key;
    // Keep well clear of the openings: half a brick of margin, so a void never
    // bites into a window reveal the brickwork carefully cut.
    const margin = Math.min(w, h) * 0.5;
    state.grid = layCourses(bbox, w, h, gap, origin).filter((brick) => {
      if (nearObstacle(obstacles, brick.x, brick.y, w, h, margin)) return false;
      // And wholly inside the shape. A traced facade is a gable, not a
      // rectangle, so a good third of its bounding box is sky — without this
      // most holes open where nothing is drawn and the effect appears not to be
      // running. All four corners, not the centre: a brick straddling the
      // roofline leaves a void with one edge in mid-air.
      return (
        pointInPolygon({ x: brick.x, y: brick.y }, shape.points)
        && pointInPolygon({ x: brick.x + w, y: brick.y }, shape.points)
        && pointInPolygon({ x: brick.x, y: brick.y + h }, shape.points)
        && pointInPolygon({ x: brick.x + w, y: brick.y + h }, shape.points)
      );
    });
    state.holes = [];
    state.falling = [];
    state.motes = [];
    state.taken = new Set();
    state.layout = { w, h, gap };
  }

  return state.grid?.length ? state.layout : null;
}

const breach = {
  id: 'breach',
  name: 'Breach',
  category: 'halloween',
  scope: 'shape',
  description:
    'Bricks work loose, shudder, and drop out of the wall — and something reaches out through the hole they leave. Put it directly over Brickwork, matched to the same brick size.',
  params: [
    /**
     * Take the brick size from the Brickwork layer underneath, if there is one
     * on the same shape. On by default: two layers taking a wall apart together
     * that disagree about where the bricks are is never what anybody wanted,
     * and lining them up by hand is fiddly and goes stale the moment either is
     * touched. Turn it off to breach a wall that already has brick on it — a
     * real one, or a photograph.
     */
    { key: 'match', type: 'bool', label: 'Match the brickwork', default: true },
    { key: 'brickW', type: 'range', label: 'Brick width', default: 76, min: 20, max: 400, step: 2 },
    { key: 'brickH', type: 'range', label: 'Brick height', default: 24, min: 8, max: 160, step: 1 },
    { key: 'gap', type: 'range', label: 'Mortar', default: 5, min: 0, max: 30, step: 0.5 },
    { key: 'originX', type: 'range', label: 'Course offset across', default: 0, min: -400, max: 400, step: 1 },
    { key: 'originY', type: 'range', label: 'Course offset up', default: 0, min: -160, max: 160, step: 1 },
    { key: 'rate', type: 'range', label: 'Bricks a minute', default: 7, min: 0, max: 60, step: 1 },
    { key: 'cluster', type: 'range', label: 'Bricks per hole', default: 5, min: 1, max: 16, step: 1 },
    { key: 'holes', type: 'range', label: 'Holes at once', default: 3, min: 1, max: 10, step: 1 },
    { key: 'heal', type: 'range', label: 'Wall heals after (s)', default: 30, min: 0, max: 300, step: 5 },
    { key: 'brick', type: 'color', label: 'Falling brick', default: '#7d4130' },
    { key: 'void', type: 'color', label: 'Behind the wall', default: '#08040c' },
    { key: 'innerGlow', type: 'color', label: 'Light from inside', default: '#4bff8f' },
    { key: 'glowAmount', type: 'range', label: 'Inner glow', default: 0.8, min: 0, max: 3, step: 0.05 },
    { key: 'throat', type: 'range', label: 'Depth of the opening', default: 0.9, min: 0, max: 1, step: 0.01 },
    { key: 'arms', type: 'range', label: 'Tentacles per hole', default: 3, min: 0, max: 8, step: 1 },
    { key: 'armColor', type: 'color', label: 'Tentacle', default: '#243026' },
    { key: 'armTip', type: 'color', label: 'Tentacle tip', default: '#597a37' },
    { key: 'thickness', type: 'range', label: 'Tentacle thickness', default: 27, min: 4, max: 110, step: 1 },
    { key: 'suckers', type: 'range', label: 'Suckers', default: 0.85, min: 0, max: 1, step: 0.01 },
    { key: 'armGlow', type: 'range', label: 'Tip glow', default: 0.4, min: 0, max: 3, step: 0.05 },
    { key: 'reach', type: 'range', label: 'Reach', default: 0.9, min: 0.1, max: 3, step: 0.05 },
    { key: 'crawl', type: 'range', label: 'Crawl speed', default: 130, min: 10, max: 600, step: 5 },
    { key: 'wander', type: 'range', label: 'Wander', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'cling', type: 'range', label: 'Feel round frames', default: 0.75, min: 0, max: 1, step: 0.01 },
    { key: 'explore', type: 'range', label: 'Seek bare wall', default: 0.7, min: 0, max: 1, step: 0.01 },
    { key: 'writhe', type: 'range', label: 'Writhe', default: 1, min: 0, max: 3, step: 0.05 },
    { key: 'dust', type: 'range', label: 'Dust', default: 0.7, min: 0, max: 1, step: 0.01 },
    { key: 'gravity', type: 'range', label: 'Gravity', default: 1400, min: 100, max: 4000, step: 50 },
    OBSTACLE_PARAM,
    { key: 'seed', type: 'range', label: 'Seed', default: 1, min: 1, max: 99, step: 1 },
  ],
  init() {
    return { key: '', holes: [], falling: [], motes: [], since: 0, primed: false };
  },
  /**
   * The wall coming apart, as a function of the step number and nothing else.
   *
   * Split out of `draw` so it can run at a fixed rate. Where a brick has fallen
   * to has to be the same in every tab — two projectors lighting the same
   * brickwork are one picture, and a hole that is open in one and shut in the
   * other is the most visible way to break it. Integrating with whatever `dt` a
   * tab managed could not give that: a spawn test weighted by `dt` does not pick
   * the same brick from a different sequence of steps even when they add up to
   * the same elapsed time.
   *
   * So the renderer calls this exactly `floor(age * 60)` times by show time
   * `age`, with a constant `dt`, and seeds `rng` from the step index. Nothing in
   * here may look at the frame rate, and there is no canvas to draw on.
   */
  step({ p, shape, t, dt, rng, state, shapes, stable, share, i = 0 }) {
    const { bbox } = shape;
    if (bbox.w <= 2 || bbox.h <= 2) return;

    const obstacles = collectObstacles(shapes, p.obstacles, shape.id);
    const layout = layoutFor({ stable, shape, shapes, share, state });
    if (!layout) return;
    const { w, h, gap } = layout;
    const grid = state.grid;

    // Named for what it is. `dt` is a constant here — the renderer guarantees
    // it — but writing the integration against a local makes the guarantee
    // visible at every use.
    const step = dt;
    const maxHoles = Math.round(clamp(p.holes, 1, 10));

    /* --- open a new hole --- */

    const interval = p.rate > 0 ? 60 / p.rate : Infinity;
    /**
     * The first one comes early.
     *
     * Waiting a whole interval for it meant five a minute opened nothing for
     * the first twelve seconds and had nothing out of the wall for fifteen —
     * long enough for somebody who has just added the layer to decide it is
     * not working, and the whole of the first still anybody takes. So the
     * clock starts part-way round: a third of the interval for the first wall,
     * and a different fraction for each wall after it, stepped by the golden
     * ratio, so a layer on two walls does not open both at the same instant.
     */
    if (!state.primed) {
      state.primed = true;
      const wait = 0.3 + 0.7 * (((i || 0) * 0.618034) % 1);
      state.since = interval * (1 - wait);
    }
    state.since += step;
    if (state.since > interval && state.holes.length < maxHoles && state.taken.size < grid.length) {
      state.since = 0;
      // Somewhere that is not already open, and not touching an existing hole —
      // two holes side by side read as one big rectangle rather than as two
      // things pushing through.
      let seed = null;
      for (let attempt = 0; attempt < 24 && !seed; attempt++) {
        const candidate = grid[Math.floor(rng() * grid.length)];
        if (state.taken.has(candidate)) continue;
        const clear = state.holes.every(
          (hole) => Math.hypot(hole.cx - candidate.cx, hole.cy - candidate.cy) > Math.max(w, h) * 2.2
        );
        if (clear) seed = candidate;
      }

      if (seed) {
        // Grow the hole outwards from the seed by nearest neighbour, so a
        // three-brick breach is a rough patch rather than three separate bricks.
        const want = Math.round(clamp(p.cluster, 1, 16));
        const chosen = [seed];
        state.taken.add(seed);
        while (chosen.length < want) {
          let best = null;
          let bestD = Infinity;
          for (const brick of grid) {
            if (state.taken.has(brick)) continue;
            const d = Math.hypot(brick.cx - seed.cx, brick.cy - seed.cy);
            if (d < bestD) {
              bestD = d;
              best = brick;
            }
          }
          if (!best || bestD > Math.max(w, h) * 2.5) break;
          state.taken.add(best);
          chosen.push(best);
        }

        // What each of them looks like, worked out once, here, so the brick
        // that rattles and falls is drawn in the colour it had in the wall.
        const look = wallLookFor(stable, share, shape);
        const tones = new Map(chosen.map((b) => [b, brickLook(look, b.row, b.col).tone]));

        state.holes.push({
          /** Still in the wall, rattling. Bricks move from here to `gone`. */
          pending: chosen,
          tones,
          /** The colour of the broken brick round the edge. */
          edge: tones.get(seed),
          /** Out. These are the rectangles that read as hole. */
          gone: [],
          cx: seed.cx,
          cy: seed.cy,
          bornAt: t,
          nextDrop: t + SHUDDER,
          /** Seconds since the last brick left, once there are none pending. */
          openFor: 0,
          /** 0 open, ramping to 1 as the wall closes over it again. */
          closing: 0,
          arms: [],
        });
      }
    }

    /* --- age the holes --- */

    const armCount = Math.round(clamp(p.arms, 0, 8));

    for (let i = state.holes.length - 1; i >= 0; i--) {
      const hole = state.holes[i];

      // Bricks let go one at a time, a fifth of a second apart, rather than all
      // together — the difference between a wall failing and a trapdoor opening.
      if (hole.pending.length && t >= hole.nextDrop) {
        const brick = hole.pending.shift();
        hole.gone.push(brick);
        hole.nextDrop = t + 0.16 + rng() * 0.16;
        const tone = hole.tones?.get(brick) || p.brick;
        // Positions are centres from here on, so a brick and a fragment of one
        // are the same kind of thing to the fall and to the paint.
        state.falling.push({
          x: brick.cx, y: brick.cy, fw: w, fh: h,
          vx: (rng() - 0.5) * 90,
          vy: 20 + rng() * 60,
          spin: (rng() - 0.5) * 5,
          angle: 0,
          tone,
        });
        /**
         * And the bits that come with it.
         *
         * A brick shoved out of a wall from behind does not leave alone — it
         * takes the corners off itself and its neighbours, and a handful of
         * small, fast, spinning pieces falling with it is most of the
         * difference between a brick being knocked out and one being deleted.
         */
        const bits = 2 + Math.floor(rng() * 3);
        for (let k = 0; k < bits; k++) {
          state.falling.push({
            x: brick.cx + (rng() - 0.5) * w * 0.9,
            y: brick.cy + (rng() - 0.5) * h * 0.7,
            fw: w * (0.1 + rng() * 0.16),
            fh: h * (0.22 + rng() * 0.32),
            vx: (rng() - 0.5) * 200,
            vy: -30 + rng() * 110,
            spin: (rng() - 0.5) * 16,
            angle: rng() * TAU,
            tone: mixHex(tone, '#000000', 0.15 * rng()),
          });
        }
        if (p.dust > 0) {
          const puffs = 2 + Math.round(rng() * 4 * p.dust);
          for (let d = 0; d < puffs; d++) {
            state.motes.push({
              x: brick.cx + (rng() - 0.5) * w,
              y: brick.cy + (rng() - 0.5) * h,
              vx: (rng() - 0.5) * 40,
              vy: 30 + rng() * 90,
              life: 0.7 + rng() * 0.9,
              age: 0,
              r: Math.max(5, Math.min(w, h) * (0.09 + rng() * 0.14)),
            });
          }
        }
      }

      // Tentacles arrive once the hole is actually a hole.
      if (!hole.pending.length) {
        hole.openFor += step;
        while (hole.arms.length < armCount) {
          /**
           * Spread the origins across the hole rather than stacking every arm
           * on its centre, which produces a rosette — the most plant-like thing
           * a clutch of tentacles can do. But check the offset one: the crawl
           * validates every *step* and had no opinion about where the path
           * started, so an arm rooted near the edge of a hole by the roofline
           * had its first joint, and the whole width of ribbon drawn around it,
           * hanging off the side of the house.
           */
          const thick = Math.max(4, p.thickness);
          let ox = hole.cx + (rng() - 0.5) * w * 0.5;
          let oy = hole.cy + (rng() - 0.5) * h * 0.3;
          if (!stepClear(shape, obstacles, ox, oy, 0, thick)
            || !stepClear(shape, obstacles, ox, oy, Math.PI / 2, thick)) {
            ox = hole.cx;
            oy = hole.cy;
          }
          hole.arms.push({
            /** Where it comes out of the wall. Every fresh reach starts here. */
            origin: { x: ox, y: oy },
            /** The path it has actually crawled, in order. Grows and retracts. */
            path: [{ x: ox, y: oy }],
            angle: -Math.PI / 2 + (rng() - 0.5) * 2.2,
            phase: rng() * TAU,
            rate: 0.55 + rng() * 0.7,
            length: 0.7 + rng() * 0.6,
            girth: 0.65 + rng() * 0.7,
            turn: rng() < 0.5 ? 1 : -1,
            /**
             * How fast this one crawls, relative to the setting.
             *
             * There was no such thing until now: `arm.rate` existed and was
             * only ever used for the sway, so every tentacle on the house
             * extended at precisely the same speed. Three arms out of one hole
             * moving in lockstep is the sort of wrongness you feel before you
             * can name — nothing alive does that.
             */
            pace: 0.55 + rng() * 0.95,
            /**
             * Which flank the suckers are on. Fixed for the arm's whole life,
             * and deliberately *not* `turn`.
             *
             * `turn` is which way the crawl prefers to swerve, and it is
             * flipped whenever a step is blocked — which, for an arm holding
             * station against a window frame, is every single frame. Drawing
             * the suckers on `turn` therefore snapped them from one side of the
             * arm to the other at sixty hertz: a hard flicker on the brightest
             * detail of the brightest object on the wall.
             */
            side: rng() < 0.5 ? 1 : -1,
            carry: 0,
            /** 'out' reaching, 'feel' holding station and probing, 'back' retracting. */
            phase2: 'out',
            timer: 0,
            bornAt: t + hole.arms.length * 0.35,
          });
        }
      }

      /**
       * And then the wall closes over it again.
       *
       * Bricks do not climb back into a wall, and it does not matter: what
       * matters is that a show runs from dusk until the last group has gone.
       * Without this the wall opens `Holes at once` times and is then finished
       * — every hole permanent, every brick spent, nothing left to look at for
       * the next three hours. Healing costs a fade and buys an evening.
       *
       * Set it to zero if you want the damage to be permanent, which is the
       * right choice for a short scene fired from a trigger.
       */
      if (p.heal > 0 && !hole.pending.length && hole.openFor > p.heal) hole.retiring = true;

      if (hole.retiring) {
        /**
         * Arms first, then the bricks.
         *
         * Healing used to fade the whole hole out over about two seconds, arms
         * included — so a tentacle three metres up the wall went thin and then
         * simply stopped existing. It reads as a dropped frame rather than as
         * anything retreating. Sending them back the way they came takes the
         * same machinery the arms already have for giving up on a direction,
         * and the wall only starts closing once they are back inside it.
         */
        let out = false;
        for (const arm of hole.arms) {
          if (arm.path && arm.path.length > 2) {
            out = true;
            if (arm.phase2 !== 'back') {
              arm.phase2 = 'back';
              arm.carry = 0;
              arm.timer = 0;
            }
            // ...and stay back. Without this the arm reaches its stub, decides
            // it has finished retracting, and sets off again into a hole that
            // is trying to close behind it.
            arm.holdBack = true;
          }
        }
        if (!out) {
          hole.arms.length = 0;
          hole.closing = Math.min(1, hole.closing + step / 1.8);
          if (hole.closing >= 1) {
            for (const brick of hole.gone) state.taken.delete(brick);
            state.holes.splice(i, 1);
          }
        }
      }
    }

    /* --- fall --- */

    const floor = bbox.y + bbox.h;
    for (let i = state.falling.length - 1; i >= 0; i--) {
      const b = state.falling[i];
      b.vy += p.gravity * step;
      b.x += b.vx * step;
      b.y += b.vy * step;
      b.angle += b.spin * step;
      if (b.y > floor + h * 2) state.falling.splice(i, 1);
    }
    for (let i = state.motes.length - 1; i >= 0; i--) {
      const m = state.motes[i];
      m.age += step;
      m.vy += 120 * step;
      m.x += m.vx * step;
      m.y += m.vy * step;
      if (m.age > m.life) state.motes.splice(i, 1);
    }

    /* --- crawl --- */

    // Where the arms have been, coarsely. Shared by every arm on the wall, so
    // they avoid each other's ground as well as their own and the result is a
    // tangle spread over the brickwork rather than a bundle in one corner.
    if (!state.trail || state.trailCell !== Math.max(w, h)) {
      state.trailCell = Math.max(w, h);
      state.trailCols = Math.max(1, Math.ceil(bbox.w / state.trailCell));
      state.trailRows = Math.max(1, Math.ceil(bbox.h / state.trailCell));
      state.trail = new Uint16Array(state.trailCols * state.trailRows);
      state.trailAge = 0;
    }
    // And it forgets, or an arm that retracts leaves ground poisoned for ever.
    state.trailAge += step;
    if (state.trailAge > 3) {
      state.trailAge = 0;
      for (let i = 0; i < state.trail.length; i++) state.trail[i] = (state.trail[i] * 0.6) | 0;
    }

    if (armCount > 0) {
      for (const hole of state.holes) {
        for (const arm of hole.arms) {
          if (t >= arm.bornAt) crawl(arm, p, shape, obstacles, state, step, rng, w, h);
        }
      }
    }

  },

  /**
   * What that looks like. Reads state, never writes it.
   *
   * Called once per rendered frame with the frame's own time, so a tab drawing
   * at 120fps still gets 120 pictures of a simulation that ran at 60 — and two
   * tabs drawing at different rates get the same picture of the same wall.
   *
   * Clipped to the wall, and — around anything that comes near a window —
   * to the wall minus its openings as well, so that what is drawn there cannot
   * land on the glass whatever the geometry upstream decided: a cast shadow or
   * the light on a tip reaching a pixel past a fitted outline is still off the
   * window. Locally, because the wall alone is a rectangle the canvas clips to
   * for nothing, and the wall with its windows cut out is a mask the size of
   * the wall, every frame, which was most of what this layer cost once the
   * arms stopped being the dearest thing in it. What falls is never guarded: a
   * brick dropping past a window is in front of it, and clipping it to the
   * brickwork would make it fall behind the glass.
   */
  draw({ g, p, shape, t, rng, state, shapes, stable, share }) {
    const { bbox } = shape;
    if (bbox.w <= 2 || bbox.h <= 2) return;
    const layout = layoutFor({ stable, shape, shapes, share, state });
    if (!layout) return;
    const { w, h, gap } = layout;
    const armCount = Math.round(clamp(p.arms, 0, 8));
    const obstacles = collectObstacles(shapes, p.obstacles, shape.id);
    const sprites = spritesFor(state, stable, w, h);
    const bite = Math.max(1.5, Math.min(w, h) * 0.3);
    const rim = Math.max(2, Math.min(w, h) * 0.18);
    const glowing = clamp(p.glowAmount, 0, 3);
    // Multiplied into rather than assigned over, so the layer's opacity and the
    // master fader still reach a layer drawing straight into the frame.
    const alpha = g.globalAlpha;

    g.save();
    g.clip(shape.path);

    // The openings, then what is coming loose, then the tentacles over the top
    // — the only order in which an arm reads as coming *out* of the wall.
    for (const hole of state.holes) {
      if (!hole.gone.length) continue;
      // Out to the far corner of the largest shard, rim and all.
      const pad = gap + bite * 1.8 + rim * 1.5;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const b of hole.gone) {
        x0 = Math.min(x0, b.x - pad);
        y0 = Math.min(y0, b.y - pad);
        x1 = Math.max(x1, b.x + w + pad);
        y1 = Math.max(y1, b.y + h + pad);
      }
      const guarded = guardOpenings(g, obstacles, x0, y0, x1, y1);
      drawOpening(g, p, hole, t, w, h, gap, bite, rim, alpha);
      if (guarded) g.restore();
    }

    /**
     * Bricks still in the wall but on their way out.
     *
     * The joint opens up round each one as the mortar goes, and the brick
     * itself — in the colour it has in the wall, drawn loose over its own place
     * — rattles in it. A few pixels of jitter is most of what sells the effect:
     * something that falls without warning reads as a glitch, and something
     * that rattles first reads as a thing coming through.
     */
    for (const hole of state.holes) {
      if (!hole.pending.length) continue;
      const ready = clamp((t - hole.bornAt) / SHUDDER, 0, 1);
      const shake = ready * Math.max(1.5, Math.min(w, h) * 0.07);
      for (const brick of hole.pending) {
        g.fillStyle = rgba(p.void, 0.3 + 0.6 * ready);
        g.fillRect(brick.x - gap * 0.6, brick.y - gap * 0.6, w + gap * 1.2, h + gap * 1.2);
        g.save();
        g.translate(brick.cx + (rng() - 0.5) * shake * 2, brick.cy + (rng() - 0.5) * shake * 2);
        g.rotate((rng() - 0.5) * 0.06 * ready);
        paintLooseBrick(g, w, h, hole.tones?.get(brick) || p.brick, sprites.grain);
        g.restore();
      }
    }

    if (armCount > 0) {
      for (const hole of state.holes) {
        for (const arm of hole.arms) {
          drawArm(g, p, hole, arm, t, w, h, 1 - hole.closing, shape, obstacles, sprites);
        }
      }
    }

    /**
     * The mouth, over the roots of the arms.
     *
     * An arm is a ribbon, and a ribbon has to start somewhere — so its base was
     * a flat cut end sitting in the middle of the opening, which reads as a
     * length of something lying on the wall rather than as anything coming out
     * of it. No amount of work on the arm itself fixes that, because the fault
     * is that you can see where it begins.
     *
     * So the inside of the opening is drawn twice: once under the arms, as the
     * dark and the light behind it, and once over them, as depth — darkness
     * over the roots, and the light from inside laid over that, so they go
     * down into a glow rather than ending in a cut, and the parts of them still
     * in the wall are lit the colour of whatever is in there. Gone by the rim,
     * so everything that has come out stays itself.
     *
     * In the light's own colour, and never whitened: whitened, the haze turned
     * the whole opening grey on the wall, which reads as fog rather than as a
     * hole with something lit at the back of it.
     */
    for (const hole of state.holes) {
      if (!hole.gone.length) continue;
      const solidity = 1 - hole.closing;
      if (solidity <= 0.02 || p.throat <= 0) continue;
      const reach = holeReach(hole, w, h, gap);
      const pulse = openingPulse(t, hole);

      g.save();
      g.beginPath();
      holeOutline(g, hole, w, h, gap, bite, 0);
      g.clip();

      // Just the roots: they come out of the middle and are cut off within a
      // brick or so of it, and a shade any wider puts out the light behind.
      const r = Math.min(reach * 0.7, Math.max(w, h) * 1.15);
      const dark = p.throat * (1 - 0.35 * Math.min(1, glowing)) * solidity;
      if (dark > 0.01) {
        const shade = g.createRadialGradient(hole.cx, hole.cy, 0, hole.cx, hole.cy, r);
        shade.addColorStop(0, rgba(p.void, 0.95 * dark));
        shade.addColorStop(0.5, rgba(p.void, 0.65 * dark));
        shade.addColorStop(1, rgba(p.void, 0));
        g.fillStyle = shade;
        g.fillRect(hole.cx - r, hole.cy - r, r * 2, r * 2);
      }
      if (glowing > 0) {
        g.globalCompositeOperation = 'lighter';
        const haze = clamp(0.34 * glowing * pulse * solidity * p.throat, 0, 1);
        glow(g, hole.cx, hole.cy + h * 0.3, reach * 0.95, p.innerGlow, haze);
      }
      g.restore();
    }

    // No glow is spread over the bricks round the hole: the light inside is
    // bright enough for the bloom downstream to spill it onto them, which is
    // where spill on a wall comes from anyway — and a gradient two holes wide
    // was the dearest thing this layer drew.

    /**
     * What is falling: whole bricks, and the pieces that came with them.
     *
     * Each with a little of its own path behind it — two fainter copies a
     * quarter and a half of a frame back along its velocity — because a brick
     * a second into its fall is moving at the height of a course every frame,
     * and a perfectly sharp one reads as a sticker sliding down the wall rather
     * than as something dropping.
     */
    for (const b of state.falling) {
      const smear = Math.hypot(b.vx, b.vy) / 60;
      const ghosts = smear > b.fh * 0.4 ? 2 : 0;
      for (let k = ghosts; k >= 0; k--) {
        const back = k / 240;
        g.globalAlpha = alpha * (k === 0 ? 1 : 0.34 / k);
        g.save();
        g.translate(b.x - b.vx * back, b.y - b.vy * back);
        g.rotate(b.angle - b.spin * back);
        paintLooseBrick(g, b.fw, b.fh, b.tone || p.brick, sprites.grain);
        g.restore();
      }
    }

    if (p.dust > 0) {
      for (const m of state.motes) {
        const fade = 1 - m.age / m.life;
        const size = m.r * (1 + m.age * 1.4) * 2.6;
        g.globalAlpha = alpha * clamp(0.55 * fade * p.dust, 0, 1);
        g.drawImage(sprites.puff, m.x - size / 2, m.y - size / 2, size, size);
      }
    }
    g.globalAlpha = alpha;
    g.restore();
  },
};

/**
 * Breathing rather than blinking: two slow sines a third of the way apart, so
 * the light in a hole swells and settles without ever going out.
 */
function openingPulse(t, hole) {
  const s = Math.sin(t * 1.7 + hole.cx * 0.01) * 0.6 + Math.sin(t * 0.63 + hole.cy * 0.013) * 0.4;
  return 0.72 + 0.28 * s;
}

/**
 * One opening in the wall, under everything that comes out of it.
 *
 * Three passes, and their order is the trick:
 *
 *  1. The hole's outline grown by a rim, in brick lit from inside — the broken
 *     faces of the neighbouring bricks catching the light behind the wall,
 *     brightest nearest the middle of the hole. Green when the light inside is
 *     green; with the inner glow off, just brick in shadow.
 *  2. The outline itself, in the dark. What survives of pass one is a lit edge
 *     exactly `rim` wide, following every bite out of every neighbour.
 *  3. The light behind, inside the outline only: a hot, nearly white core low
 *     in the hole, falling off as an inverse square to nothing at the rim. The
 *     dark edge that leaves is what reads as depth — the opening is lit at the
 *     back and in shadow at the sides, which is how a hole in a wall with a
 *     lamp behind it looks.
 *
 * The rectangles in pass two are filled one per brick in the void colour, and
 * stay that way: they are where the wall actually is open, and the tests that
 * keep the holes off the windows and on the bricks read them.
 */
function drawOpening(g, p, hole, t, w, h, gap, bite, rim, alpha) {
  const solidity = 1 - hole.closing;
  if (solidity <= 0.005) return;
  const reach = holeReach(hole, w, h, gap);
  const glowing = clamp(p.glowAmount, 0, 3);
  const lift = Math.min(1, glowing);
  const edge = hole.edge || p.brick;

  g.globalAlpha = alpha * solidity;
  const lit = g.createRadialGradient(hole.cx, hole.cy, reach * 0.25, hole.cx, hole.cy, reach + bite + rim);
  lit.addColorStop(0, mixHex(mixHex(edge, '#fff2df', 0.4), p.innerGlow, 0.6 * lift));
  lit.addColorStop(0.6, mixHex(mixHex(edge, '#fff2df', 0.1), p.innerGlow, 0.32 * lift));
  lit.addColorStop(1, mixHex(mixHex(edge, '#000000', 0.35), p.innerGlow, 0.14 * lift));
  g.fillStyle = lit;
  g.beginPath();
  holeOutline(g, hole, w, h, gap, bite, rim);
  g.fill();

  g.fillStyle = p.void;
  g.beginPath();
  holeOutline(g, hole, w, h, gap, bite, 0, false);
  g.fill();
  for (const brick of hole.gone) g.fillRect(brick.x - gap, brick.y - gap, w + gap * 2, h + gap * 2);
  g.globalAlpha = alpha;

  if (glowing <= 0) return;
  g.save();
  g.beginPath();
  holeOutline(g, hole, w, h, gap, bite, 0);
  g.clip();
  g.globalCompositeOperation = 'lighter';
  const gx = hole.cx;
  const gy = hole.cy + h * 0.35;
  const r = reach * 1.05;
  const a = clamp(1.05 * glowing * openingPulse(t, hole) * solidity, 0, 1);
  const light = g.createRadialGradient(gx, gy, 0, gx, gy, r);
  light.addColorStop(0, rgba(mixHex(p.innerGlow, '#ffffff', 0.35), a));
  light.addColorStop(0.12, rgba(p.innerGlow, a * 0.9));
  light.addColorStop(0.35, rgba(p.innerGlow, a * 0.55));
  light.addColorStop(0.7, rgba(p.innerGlow, a * 0.2));
  light.addColorStop(1, rgba(p.innerGlow, 0));
  g.fillStyle = light;
  g.fillRect(gx - r, gy - r, r * 2, r * 2);
  g.restore();
}


/**
 * Feel forward one step at a time, over the wall and around whatever is on it.
 *
 * The previous version computed the whole arm from a wave function every frame,
 * which is cheap and has one fatal property: the arm has no memory, so it can
 * be waved straight across a window and off the side of the house, and nothing
 * it does one frame has any bearing on the next. What reads as *alive* is
 * precisely the memory — a limb that found its way round a window frame is
 * still round it a minute later, and the tangle on the wall is the record of
 * where it has been.
 *
 * So an arm now owns a path and extends it, exactly as the vine does. Four
 * things decide each step, in the order they are applied:
 *
 *  1. **Wander.** A slow drift, so nothing travels in a straight line.
 *  2. **Bare wall.** Of five candidate headings, prefer the one leading to
 *     ground the arms have used least. This is what spreads a clutch out over
 *     the brickwork instead of bundling it in one corner.
 *  3. **Frames.** Near a window or a door, swing towards the tangent of its
 *     edge, more strongly the closer it is — so an arm runs *along* a sill
 *     rather than bouncing off it. The hold falls away with distance so it lets
 *     go at the corner instead of orbiting the opening for ever.
 *  4. **Somewhere to put it.** Sweep outwards from the intended heading and
 *     take the smallest turn that is still on the wall and off the glass. If
 *     nothing within a right angle works, the arm is wedged: it gives up and
 *     pulls back, which is what stops one dying in a corner with its tip
 *     jammed in the brickwork.
 */
function crawl(arm, p, container, obstacles, state, dt, rng, w, h) {
  const thickness = Math.max(4, p.thickness) * arm.girth;
  // Long enough that the ribbon cannot pinch on a tight turn: the inside edge
  // of a bend has radius `step / turn - halfWidth`, and that has to stay
  // positive. Hence a step near the arm's own width and a hard cap on the turn.
  // Well under the arm's own width. Step length only has to clear the pinch
  // condition below; tying it to thickness one-for-one made a thick arm both
  // fat *and* unable to turn, which is why the last version had to be thinned
  // to the point of looking like string.
  const stepPx = Math.max(7, thickness * 0.55);
  /**
   * How sharply it can turn, and therefore whether it can get anywhere.
   *
   * These three numbers are one design, not three settings. An arm needs a
   * corridor `2 × ARM_MARGIN × thickness` wide to pass, and can only change
   * course on a radius of `stepPx / MAX_TURN`. Get the ratio wrong and the
   * arms wedge against the first window they meet and spend the evening as
   * stubs — which is exactly what a thickness of 34 did here: a 134-pixel
   * corridor requirement against a 107-pixel turning circle, on a facade whose
   * gaps are about 200 pixels wide.
   */
  const MAX_TURN = 0.26;
  const maxLen = Math.max(w, h) * 7 * p.reach * arm.length;
  const maxJoints = Math.max(4, Math.round(maxLen / stepPx));

  arm.timer += dt;

  // Reaching, then holding station and probing, then pulling back to try
  // somewhere else. Without the last two an arm reaches its full length in the
  // first ten seconds and is a fixed piece of scenery for the rest of the show.
  // Wedged is not the same as finished. An arm that cannot place its next
  // joint rotates and tries again for a third of a second before giving up on
  // this direction entirely; giving up on the first blocked step leaves it a
  // stub against the first window frame it meets.
  if (arm.phase2 === 'out' && arm.stuck > 20 && arm.path.length < maxJoints * 0.6) {
    /**
     * Wedged early: back off and try another way, rather than settling for it.
     *
     * An arm that meets a window frame in its first few steps would otherwise
     * hold station there for ten seconds, so three arms out of one breach near
     * the roofline — where there is least room — become three permanent stubs.
     *
     * It backs off by *withdrawing*, at the speed it withdraws at. The first
     * version of this popped a third of the joints in a single frame, which is
     * the arm visibly restarting half way back along itself several times a
     * minute. Nothing about a limb changes length instantaneously; setting a
     * target and letting the existing retract machinery reach it costs one
     * field and looks like the thing pulling back to try again.
     */
    arm.stuck = 0;
    arm.phase2 = 'back';
    arm.carry = 0;
    arm.backTo = Math.max(2, Math.floor(arm.path.length * 0.62));
    arm.timer = 0;
  } else if (arm.phase2 === 'out' && (arm.path.length >= maxJoints || arm.stuck > 20)) {
    arm.phase2 = 'feel';
    arm.carry = 0;
    arm.stuck = 0;
    // A probe is part of holding station, not a fresh arrival, so it does not
    // wind the clock back — otherwise an arm that probes every few seconds
    // never reaches the point of giving up and moving on at all.
    if (arm.probing) arm.probing = false;
    else arm.timer = 0;
  } else if (arm.phase2 === 'feel' && arm.timer > 6 + arm.girth * 6) {
    arm.phase2 = 'back';
    arm.carry = 0;
    arm.timer = 0;
  } else if (arm.phase2 === 'feel' && arm.timer > (arm.probeAt || 0)) {
    // A short withdraw and reach, every few seconds, so an arm at full extent
    // is feeling about rather than parked. Uses the same target-and-retract as
    // everything else, so nothing jumps.
    arm.probeAt = arm.timer + 2 + rng() * 3;
    arm.stuck = 0;
    arm.phase2 = 'back';
    arm.carry = 0;
    arm.backTo = Math.max(2, arm.path.length - (3 + Math.floor(rng() * 5)));
    arm.probing = true;
  } else if (arm.phase2 === 'back' && arm.backTo && arm.path.length <= arm.backTo) {
    // Far enough back. Set off again on a new heading, from where it stopped —
    // the part of the arm still on the wall stays exactly where it was.
    arm.backTo = null;
    arm.phase2 = 'out';
    arm.carry = 0;
    arm.stuck = 0;
    arm.turn *= -1;
    arm.angle += (rng() < 0.5 ? -1 : 1) * (0.7 + rng() * 0.9);
    // A probe keeps its clock, so the arm still gives up on this spot on
    // schedule; a genuine wedge starts the clock again.
    if (!arm.probing) arm.timer = 0;
  } else if (arm.phase2 === 'back' && arm.path.length <= 2 && !arm.holdBack) {
    arm.phase2 = 'out';
    arm.carry = 0;
    arm.timer = 0;
    // Back to a single joint at the hole, not to the two-joint stub retraction
    // happens to leave. Keeping the stub and setting off in a new direction
    // puts a fold of up to half a turn in the path, and the ribbon drawn over
    // that fold pinches shut and reads as a crease in the arm.
    arm.path.length = 0;
    arm.path.push({ x: arm.origin.x, y: arm.origin.y });
    // A fresh heading, so the next reach explores rather than retracing.
    arm.angle = -Math.PI / 2 + (rng() - 0.5) * 2.4;
  }

  // Published for the drawing, which interpolates the leading end between
  // joints rather than letting it sit on them.
  /**
   * Published for the drawing, which interpolates the leading end between
   * joints rather than letting it sit on one.
   *
   * The remainder is spent to zero at every change of phase. It points forward
   * while the arm is growing and backward while it is withdrawing, so carrying
   * an unspent one across the transition flips its sign and steps the drawn
   * length by twice it — which is a thirty-pixel jump at the exact moment an
   * arm decides to pull back, and therefore the most conspicuous one left.
   */
  arm.stepPx = stepPx;
  arm.growing = arm.phase2 !== 'back';

  const speed = Math.max(1, p.crawl) * (arm.pace ?? 1) * (arm.phase2 === 'back' ? 1.6 : 1);
  /**
   * At rest: either fully extended, or holding station against something it
   * cannot get past.
   *
   * The second case used to keep trying a step every single frame for as long
   * as the arm stayed there — failing, nudging the search heading, and failing
   * again — which is the vibration. There is nothing to be gained from
   * retrying sixty times a second what has failed twenty times in a row; the
   * probe and give-up timers will move it along soon enough. The remainder has
   * to stay put too, or it overflows and steps the drawn length.
   */
  const atFull = arm.phase2 === 'feel' && (arm.path.length >= maxJoints || arm.stuck > 6);
  if (atFull) return;

  arm.carry += speed * dt;
  let steps = Math.floor(arm.carry / stepPx);
  if (steps > 6) {
    steps = 6;
    arm.carry = 0;
  } else {
    arm.carry -= steps * stepPx;
  }

  const cellOf = (x, y) => {
    const cx = Math.floor((x - container.bbox.x) / state.trailCell);
    const cy = Math.floor((y - container.bbox.y) / state.trailCell);
    if (cx < 0 || cy < 0 || cx >= state.trailCols || cy >= state.trailRows) return -1;
    return cy * state.trailCols + cx;
  };
  // Off the wall reads as thoroughly used, so nothing steers that way — but as
  // a finite number, because an infinity there would swamp every comparison.
  const usedAt = (x, y) => {
    const i = cellOf(x, y);
    return i < 0 ? 30 : Math.min(20, state.trail[i]);
  };

  for (let s = 0; s < steps; s++) {
    if (arm.phase2 === 'back') {
      arm.path.pop();
      if (arm.path.length <= 2) break;
      continue;
    }
    if (arm.path.length < 2) {
      // Just replanted: nothing to take a heading from yet, so step straight
      // out on the one it was given.
      const o = arm.path[0];
      const nx = o.x + Math.cos(arm.angle) * stepPx;
      const ny = o.y + Math.sin(arm.angle) * stepPx;
      if (stepClear(container, obstacles, nx, ny, arm.angle, thickness)) arm.path.push({ x: nx, y: ny });
      else arm.angle += 0.7;
      continue;
    }
    /**
     * At full extent it simply stops growing.
     *
     * It used to retire the newest joint here and immediately try to place a
     * replacement, which keeps the length constant only when the replacement
     * succeeds — and at full extent an arm is usually pressed against something,
     * so it often did not. Every failure then cost a whole step in a single
     * frame: measured over three minutes, nine hundred of them. The probing it
     * was there to provide is now done by the withdraw cycle below, which goes
     * through the same machinery as everything else that changes length and is
     * therefore smooth by construction.
     */

    const tip = arm.path[arm.path.length - 1];
    let angle = arm.angle + (rng() - 0.5) * p.wander * 0.5;

    if (p.explore > 0) {
      let best = angle;
      let bestScore = Infinity;
      for (const offset of [0, 0.35, -0.35, 0.75, -0.75]) {
        const a = angle + offset;
        const dx = Math.cos(a);
        const dy = Math.sin(a);
        let score = Math.abs(offset) * 0.5; // all else equal, carry straight on
        for (const r of [1.2, 3, 6]) {
          score += usedAt(tip.x + dx * state.trailCell * r, tip.y + dy * state.trailCell * r) / r;
        }
        if (score < bestScore) {
          bestScore = score;
          best = a;
        }
      }
      angle += angleDelta(angle, best) * p.explore * 0.4;
    }

    const range = Math.max(10, thickness * 2.2);
    const near = nearestSurface(obstacles, tip.x, tip.y, range);
    if (near && p.cling > 0) {
      const tangent = Math.atan2(near.nx, -near.ny);
      const alt = tangent + Math.PI;
      const pick = Math.abs(angleDelta(angle, tangent)) < Math.abs(angleDelta(angle, alt))
        ? tangent
        : alt;
      const hold = p.cling * (1 - near.dist / range);
      angle += angleDelta(angle, pick) * hold * 0.8;
    }

    // The smallest turn that keeps the tip on the wall and off the glass.
    // Committing to one direction — `arm.turn` — rather than taking the best of
    // each side stops an arm oscillating in a corner, which is a lesson the
    // serpent learned the hard way.
    let placed = false;
    for (const swerve of [0, 0.12, 0.25, 0.4]) {
      for (const dir of swerve === 0 ? [1] : [arm.turn, -arm.turn]) {
        // Clamp *before* testing, not after.
        //
        // The first version picked a heading, tested the point it led to, and
        // then stepped in a different direction because the turn cap moved it —
        // so the point it actually landed on had never been checked, and arms
        // walked over windows and off the side of the house at a low rate. The
        // tested point and the placed point have to be the same point.
        const a = clampTurn(arm.angle, angle + swerve * dir, MAX_TURN);
        const nx = tip.x + Math.cos(a) * stepPx;
        const ny = tip.y + Math.sin(a) * stepPx;
        // Clear of the frames by the arm's own half-width, not just at the
        // centreline: a ribbon whose spine skims a sill still covers the glass.
        if (!isClear(container, obstacles, nx, ny)) continue;
        // Both flanks too, at the widest the drawn ribbon ever gets — spine
        // clearance alone is not clearance, because a ribbon whose centreline
        // skims a sill still covers the glass either side of it. `ARM_MARGIN`
        // is that widest half-width, swell and sway included; see drawArm.
        const px = Math.cos(a + Math.PI / 2) * thickness * ARM_MARGIN;
        const py = Math.sin(a + Math.PI / 2) * thickness * ARM_MARGIN;
        if (!isClear(container, obstacles, nx + px, ny + py)) continue;
        if (!isClear(container, obstacles, nx - px, ny - py)) continue;

        arm.angle = a;
        arm.path.push({ x: nx, y: ny });
        const cell = cellOf(nx, ny);
        if (cell >= 0 && state.trail[cell] < 65000) state.trail[cell] += 1;
        placed = true;
        break;
      }
      if (placed) break;
    }
    if (!placed) {
      /**
       * Give the step back.
       *
       * The distance for this step was taken out of `carry` before the attempt,
       * and the attempt added no length — so a blocked step silently shortened
       * the drawn arm by a whole step, in one frame, every time. An arm pressed
       * against a window frame is blocked constantly, which is why this was the
       * largest remaining source of the jumping: four hundred of them in three
       * minutes, each a clean fifteen pixels.
       *
       * Refunded, the leading end simply stays where it is and the wind-in
       * below trims it to whatever will fit, which is a nudge rather than a
       * step.
       */
      arm.carry = Math.min(arm.carry + stepPx, stepPx * 1.5);
      arm.stuck = (arm.stuck || 0) + 1;
      // Sweep the search heading a quarter as often as it used to. Nudging on
      // every failed attempt rocks between two blocked directions at frame
      // rate, and now that the drawing follows the arm rather than the search
      // that is merely wasted work — but it was visible as a shaking tip for a
      // long time, and there is no reason to hunt that fast.
      if (arm.stuck % 4 === 0) {
        arm.turn *= -1;
        arm.angle += MAX_TURN * arm.turn;
      }
      break;
    }
    arm.stuck = 0;
  }
}

/**
 * Is there room for the whole width of the arm here, not just its centreline?
 *
 * A ribbon whose spine skims a sill still covers the glass either side of it,
 * so both flanks are tested as well — at the widest the drawn arm ever gets.
 */
function stepClear(container, obstacles, x, y, angle, thickness) {
  if (!isClear(container, obstacles, x, y)) return false;
  const px = Math.cos(angle + Math.PI / 2) * thickness * ARM_MARGIN;
  const py = Math.sin(angle + Math.PI / 2) * thickness * ARM_MARGIN;
  return isClear(container, obstacles, x + px, y + py)
    && isClear(container, obstacles, x - px, y - py);
}

/**
 * How far out from the centreline an arm can ever be drawn, in units of its own
 * base half-width.
 *
 * Width peaks at the base at `swell` (1.16) and falls away; the sway peaks at
 * the tip and is scaled by u², where the width has dropped to about a fifth, so
 * the two are never both large and their sum stays near 1.16.
 *
 * The rest of the allowance is for a mismatch that is easy to miss. Clearance
 * is tested along the normal to the *step*, and the ribbon is built along the
 * normal to the *joint* — the average of two consecutive steps. On a bend those
 * differ by half the turn, which swings the flank by about width × 0.15. Left
 * at 1.2 that put roughly one drawn point in two thousand over a window: rare
 * enough to look like an accident and frequent enough to see all evening.
 *
 * The crawl keeps this much clear of every opening, which is the only reason a
 * tentacle can hug a frame without covering it.
 */
const ARM_MARGIN = 1.45;

/** Move `from` towards `to` by at most `limit` radians. */
function clampTurn(from, to, limit) {
  const d = angleDelta(from, to);
  return from + clamp(d, -limit, limit);
}

/** Shortest signed difference between two angles. */
function angleDelta(from, to) {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/**
 * Interpolate a smoother spine through the crawled one.
 *
 * The crawl steps about two thirds of the arm's width at a time and the ribbon
 * joins those with straight lines, so the outline is visibly faceted — a
 * tentacle made of flat panels. The obvious fix is to draw curves between the
 * joints instead, and it is a trap: `fitWidths` validates *vertices*, and a
 * curve bulges away from them into space nothing has checked. Two separate
 * rounds of this file have been spent on exactly that class of mistake.
 *
 * Adding vertices has no such problem. A Catmull-Rom pass through the existing
 * joints puts a point every few pixels, the outline is straight between them so
 * it stays where it is drawn, and the clearance pass then validates all of them
 * — smoother *and* still provably off the glass.
 */
function subdivide(joints, widths, k, container, obstacles) {
  // Copies, not the arrays that were passed in. The caller empties its own
  // arrays before refilling them from this result, so handing back the same
  // references leaves it refilling from something it has just cleared. Latent
  // until an arm was allowed to be two joints long, and then instantly fatal.
  if (k < 2 || joints.length < 3) return { joints: joints.slice(), widths: widths.slice() };
  const n = joints.length;
  const at = (i) => joints[Math.max(0, Math.min(n - 1, i))];
  const wAt = (i) => widths[Math.max(0, Math.min(n - 1, i))];
  const outJ = [];
  const outW = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    for (let s = 0; s < k; s++) {
      const t = s / k;
      const t2 = t * t;
      const t3 = t2 * t;
      // Standard Catmull-Rom. Passes through every original joint, so the
      // crawl's own path is preserved exactly and only the gaps are filled.
      let x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      let y = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
      /**
       * A spline overshoots on the outside of a tight bend, and a point that
       * lands inside a window cannot be rescued by thinning the arm there —
       * thinning pulls the flanks in towards a spine that is already on the
       * glass. So an interpolated point that is not clear falls back to the
       * straight line between the two crawled joints, and failing that to the
       * nearer of the two, both of which the crawl validated when it placed
       * them. The smoothing is a nicety; the containment is not.
       */
      if (container && !isClear(container, obstacles, x, y)) {
        x = p1.x + (p2.x - p1.x) * t;
        y = p1.y + (p2.y - p1.y) * t;
        if (!isClear(container, obstacles, x, y)) {
          const near = t < 0.5 ? p1 : p2;
          x = near.x;
          y = near.y;
        }
      }
      outJ.push({ x, y });
      outW.push(wAt(i) + (wAt(i + 1) - wAt(i)) * t);
    }
  }
  outJ.push(at(n - 1));
  outW.push(wAt(n - 1));
  return { joints: outJ, widths: outW };
}

/**
 * Is every point within `r` of (x, y) clear — not just the few `isClear` would
 * be asked about?
 *
 * Deliberately pessimistic: a disc that so much as touches an opening's
 * bounding box, or comes within `r` of the container's edge, is "not known to
 * be clear" and goes on to the exact tests. What it buys is the common case.
 * Fitting a width is up to thirty-six containment tests a vertex, three rounds
 * of it, on several hundred vertices an arm — and was most of what the arms
 * cost — while nearly all of those vertices sit in open brickwork where one
 * look at the disc answers every radius on both flanks at once.
 */
function discClear(container, obstacles, x, y, r) {
  for (const o of obstacles) {
    const b = o.bbox;
    if (x + r > b.x && x - r < b.x + b.w && y + r > b.y && y - r < b.y + b.h) return false;
  }
  if (!container) return true;
  const b = container.bbox;
  if (x - r < b.x || x + r > b.x + b.w || y - r < b.y || y + r > b.y + b.h) return false;
  const pts = container.points;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const ax = pts[j].x;
    const ay = pts[j].y;
    const dx = pts[i].x - ax;
    const dy = pts[i].y - ay;
    const len2 = dx * dx + dy * dy;
    const u = len2 > 0 ? clamp(((x - ax) * dx + (y - ay) * dy) / len2, 0, 1) : 0;
    const ex = x - (ax + dx * u);
    const ey = y - (ay + dy * u);
    if (ex * ex + ey * ey < r * r) return false;
    if ((pts[i].y > y) !== (ay > y) && x < (dx * (y - pts[i].y)) / (dy || 1e-12) + pts[i].x) inside = !inside;
  }
  return inside;
}

/**
 * Pull in the half-width anywhere the ribbon's own outline would not fit.
 *
 * Uses exactly the normal `tentacleRibbon` uses, because the whole point is to
 * measure the outline that gets drawn rather than an approximation of it.
 */
function fitWidths(container, obstacles, joints, widths) {
  const n = joints.length;
  for (let i = 0; i < n; i++) {
    const a = joints[i];
    const b = joints[Math.min(i + 1, n - 1)];
    const prev = joints[Math.max(i - 1, 0)];
    const angle = Math.atan2(b.y - prev.y, b.x - prev.x) + Math.PI / 2;
    const cx = Math.cos(angle);
    const cy = Math.sin(angle);

    /**
     * There is deliberately no cap on width from the bend here.
     *
     * There used to be. The reasoning was that on the inside of a turn the
     * flank sits at radius `step / turn − width`, and once that goes negative
     * the inner edge has crossed the centreline — so the ribbon must be thinned
     * or it draws itself inside out as a bow-tie.
     *
     * The premise was wrong, and I never checked it. A canvas fill uses nonzero
     * winding, so a ribbon that overlaps itself at a fold fills *solid* — the
     * union, which is exactly the shape a real tube makes when you bend it back
     * on itself. Drawn side by side against a deliberate 180-degree hairpin,
     * the uncapped ribbon comes out at constant width all the way round and the
     * capped one comes to a point in the middle of the bend.
     *
     * So the cap was not preventing an artefact, it *was* the artefact, and the
     * fix is to delete it. What stays is the clearance fitting below, which is
     * about windows rather than geometry, and the slope limiter after it, which
     * stops that fitting leaving square-cut notches.
     */
    let w = widths[i];
    let fits = false;
    /**
     * Halve until it fits, down to a sixty-fourth of the width.
     *
     * Four halvings was not enough at the tip, and the reason is worth keeping:
     * the corridor the crawl reserves is a *line* either side of the step
     * direction, not a disc, and it checks nothing ahead of the last joint. So
     * a tip can legitimately sit a pixel short of a window edge, and the sway —
     * which is at its largest exactly there — can swing the ribbon's normal far
     * enough round to point the flank straight at it. Six halvings puts the
     * flank inside a fifth of a pixel of the spine, which is clear.
     */
    /**
     * Sampled along the ray, not just at its end.
     *
     * Testing the outermost point only is not enough, and the reason is a nice
     * one: clearance is not convex. The rim is drawn at the full width and the
     * body inside it at 85%, and a ray that leaves the spine, crosses a window
     * and comes out the far side has a *clear* endpoint and an obscured middle
     * — so the wider ribbon passed and the narrower one drawn inside it landed
     * on the glass. Every radius that actually gets drawn is checked.
     */
    // Most of an arm is nowhere near a window or an edge, and for those
    // vertices one test of the whole disc settles every radius at once.
    if (discClear(container, obstacles, a.x, a.y, w)) fits = true;
    for (let tries = 0; tries < 6 && !fits; tries++) {
      let clear = true;
      for (const f of [1, 0.85, 0.45]) {
        if (!isClear(container, obstacles, a.x + cx * w * f, a.y + cy * w * f)
          || !isClear(container, obstacles, a.x - cx * w * f, a.y - cy * w * f)) {
          clear = false;
          break;
        }
      }
      if (clear) {
        fits = true;
        break;
      }
      w *= 0.5;
    }
    // And if even a sixty-fourth does not fit, pinch to the centreline. The
    // spine is clear by construction, so a flank *on* it is clear too — which
    // makes this the one width that is guaranteed correct rather than merely
    // very likely, and it is the difference between four stray pixels an
    // evening and none. It costs a nick a fraction of a pixel wide.
    widths[i] = Math.min(widths[i], fits ? w : 0);
  }

  /**
   * And no sudden steps in the result.
   *
   * Both of the rules above act on one vertex at a time, so a single tight spot
   * — a bend against a window reveal, a spline point that had to be pulled back
   * — takes that vertex to nothing while its neighbours stay full width. The
   * ribbon then has a notch cut out of it, which after all this work is the one
   * thing that still looked machine-made.
   *
   * Two passes limit how fast the width may fall away, forwards and backwards.
   * Both only ever *reduce* a width, so everything above still holds: a pinch
   * becomes a smooth taper into it and out the other side, which is what a limb
   * squeezing past something looks like anyway.
   */
  /**
   * Smooth, verify, smooth, verify.
   *
   * The limiter bounds how fast the width may fall away; the verify then trims
   * whatever still does not fit, and in doing so can undo the limiter at that
   * one vertex. One round therefore leaves the occasional step — measured at
   * around one per px of arc against a limit of 0.55, always within a few
   * pixels of the tip where the arm is thinnest.
   *
   * A second round smooths that trim and re-checks the result, which converges
   * because each round can only reduce. Two is enough; a third changes nothing
   * measurable and this runs per arm per frame.
   */
  for (let round = 0; round < 2; round++) {
    const SLOPE = 0.55;
    for (let i = 1; i < n; i++) {
      const step = Math.hypot(joints[i].x - joints[i - 1].x, joints[i].y - joints[i - 1].y);
      widths[i] = Math.min(widths[i], widths[i - 1] + SLOPE * step);
    }
    for (let i = n - 2; i >= 0; i--) {
      const step = Math.hypot(joints[i + 1].x - joints[i].x, joints[i + 1].y - joints[i].y);
      widths[i] = Math.min(widths[i], widths[i + 1] + SLOPE * step);
    }

    /**
     * Then check the smoothed widths, because *reducing* one is not safe either.
     *
     * That reads as nonsense and is the third time this exact property has bitten
     * this file: clearance is not convex, so a flank pulled *in* can land inside
     * a window that the wider one cleared by passing over it and out the far
     * side. The fit above samples a few radii along each ray for exactly that
     * reason, and the smoothing then moves the width to one it never sampled.
     *
     * So the final answer is verified, and pinches to the centreline if it has
     * to. A notch here is rare — it needs the smoothing to have lowered a width
     * into an obstructed band — and its neighbours are already tapered, so what
     * survives is a narrowing rather than the square-cut gap this pass exists to
     * remove.
     */
    for (let i = 0; i < n; i++) {
      const a = joints[i];
      const b = joints[Math.min(i + 1, n - 1)];
      const prev = joints[Math.max(i - 1, 0)];
      const angle = Math.atan2(b.y - prev.y, b.x - prev.x) + Math.PI / 2;
      const cx = Math.cos(angle);
      const cy = Math.sin(angle);
      let w = widths[i];
      // Only a width of exactly nothing is accepted unchecked. A fifth of a pixel
      // sounds like nothing and is still a pixel wide once it is projected.
      let fits = w <= 0 || discClear(container, obstacles, a.x, a.y, w);
      for (let tries = 0; tries < 6 && !fits; tries++) {
        // Every radius that gets drawn, not just the outermost: the rim goes at
        // the full width and the body inside it at 85%, and a ray that crosses a
        // window and comes out the far side clears at one and not the other.
        let clear = true;
        for (const f of [1, 0.85, 0.45]) {
          if (!isClear(container, obstacles, a.x + cx * w * f, a.y + cy * w * f)
            || !isClear(container, obstacles, a.x - cx * w * f, a.y - cy * w * f)) {
            clear = false;
            break;
          }
        }
        if (clear) fits = true;
        else w *= 0.6;
      }
      widths[i] = fits ? w : 0;
    }
  }
}

/**
 * One tentacle, drawn along the path it has crawled.
 *
 * The shape is no longer computed here — `crawl` owns that, and it owns it over
 * time. What is left is the two things that have to happen every frame: a sway,
 * and a skin.
 *
 * The sway is a travelling wave applied as a *lateral offset* to the stored
 * path, scaled by the square of the distance along it. That scaling is the
 * whole trick: it is zero at the base, so the arm stays planted in its hole and
 * whatever it has wrapped itself around stays wrapped; and it is largest at the
 * tip, which is the part that should look like it is feeling for something. An
 * arm that has snarled itself over three metres of brickwork still breathes,
 * without any of it sliding across the wall.
 */
function drawArm(g, p, hole, arm, t, w, h, alive = 1, container = null, obstacles = [], sprites = null) {
  const age = t - arm.bornAt;
  if (age < 0 || alive <= 0.02 || !arm.path || arm.path.length < 2) return;

  /**
   * The leading end, between joints rather than on one.
   *
   * A tentacle's tip could previously only be where a joint was, and joints are
   * placed two thirds of a width apart — so it advanced and withdrew in visible
   * lumps of fifteen pixels, fourteen times a second. Measured over three
   * minutes that is a thousand step changes in length, and it is most of what
   * still read as mechanical about the motion.
   *
   * The crawl already tracks the sub-step remainder it has not spent yet; using
   * it here puts the end exactly where it should be at this instant. Growing,
   * that is a little beyond the last joint along the current heading; drawing
   * back, a little short of it. Both are new positions, so both are checked —
   * the extended one has not been through the crawl's own placement test yet,
   * and the interpolated one sits on a line between two cleared joints, which
   * as established several times over is not the same as being clear.
   */
  const path = arm.path.slice();

  /**
   * A root that carries on back into the hole.
   *
   * The spine starts at the origin, so without this the ribbon's first vertex
   * is the flat end of a tube, sitting right at the point where the opening is
   * widest and best lit. Continuing it backwards by a couple of widths — along
   * the reverse of its own first segment, so it looks like the same limb — puts
   * that end deep in the shadow the mouth pass lays over the middle of the
   * hole, and what you see is an arm coming out of somewhere rather than an arm
   * that begins.
   *
   * It goes into the void, which is not an obstacle and is inside the wall, so
   * there is nothing to check it against.
   */
  if (path.length >= 2) {
    const a = path[0];
    const b = path[1];
    const back = Math.atan2(a.y - b.y, a.x - b.x);
    const girth = Math.max(4, p.thickness) * arm.girth;
    // As far back as fits. A hole near the eaves or a corner has wall behind it
    // for only part of that, and a root point outside the shape gets its width
    // pinched to nothing by the clearance pass, which is a notch at the base —
    // the exact thing this is here to remove.
    let reach = girth * 2.2;
    // Both points, not just the far one. Clearance is not convex — the outer
    // one can clear a window by passing over it and out the far side while the
    // one between is inside it — and a root point that gets its width pinched
    // to nothing is a notch at the base, the exact thing this is here to remove.
    const rootFits = (d) => {
      if (!container) return true;
      for (const at of [d, d * 0.55]) {
        if (!stepClear(container, obstacles,
          a.x + Math.cos(back) * at, a.y + Math.sin(back) * at, back, girth)) return false;
      }
      return true;
    };
    while (reach > girth * 0.4 && !rootFits(reach)) reach *= 0.6;
    if (reach > girth * 0.4) {
      path.unshift({ x: a.x + Math.cos(back) * reach * 0.55, y: a.y + Math.sin(back) * reach * 0.55 });
      path.unshift({ x: a.x + Math.cos(back) * reach, y: a.y + Math.sin(back) * reach });
    }
  }

  const f = clamp((arm.carry || 0) / Math.max(1, arm.stepPx || 1), 0, 1);
  if (f > 0.02 && path.length >= 2) {
    const last = path[path.length - 1];
    const before = path[path.length - 2];
    const reach = Math.max(4, p.thickness) * arm.girth;
    if (arm.growing) {
      /**
       * Along the last segment it actually laid, not along `arm.angle`.
       *
       * `arm.angle` is the crawl's *search* heading, and a blocked arm swings
       * it by a fifth of a radian every frame looking for a way past. Drawing
       * the leading end along it therefore whipped the tip back and forth
       * several times a second wherever an arm came to rest against something —
       * measured at 4.8 direction reversals per arm-second. The direction the
       * arm is actually pointing changes only when a joint is placed, which is
       * exactly as often as the drawn end should turn.
       */
      const dir = Math.atan2(last.y - before.y, last.x - before.x);
      for (let d = f; d > 0.04; d *= 0.72) {
        const ex = last.x + Math.cos(dir) * d * arm.stepPx;
        const ey = last.y + Math.sin(dir) * d * arm.stepPx;
        if (!container || stepClear(container, obstacles, ex, ey, dir, reach)) {
          path.push({ x: ex, y: ey });
          break;
        }
      }
    } else {
      const rx = last.x + (before.x - last.x) * f;
      const ry = last.y + (before.y - last.y) * f;
      if (!container || isClear(container, obstacles, rx, ry)) {
        path[path.length - 1] = { x: rx, y: ry };
      }
    }
  }
  const out = clamp(age / 1.2, 0, 1) * alive;
  const emerge = out * out * (3 - 2 * out); // smoothstep
  if (emerge < 0.01) return;

  let n = path.length;
  const base = Math.max(4, p.thickness) * arm.girth;
  const wave = t * p.writhe * arm.rate + arm.phase;
  const writhe = clamp(p.writhe, 0, 3);

  /**
   * Two different measures of "how far along", because they answer two
   * different questions.
   *
   * How *thick* the arm is at a point is a fact about the limb: a place a metre
   * from the body is the same thickness whether the arm is half out or fully
   * extended. Taken as a fraction of the current length — which is what this
   * did — every joint's thickness changes as the arm grows, so the whole thing
   * visibly slims down as it reaches out, and thickens again as it retracts.
   * That is the "width seems a bit odd" of it. Distance from the base, against
   * the arm's own full reach, is the honest measure.
   *
   * How much a point *moves*, on the other hand, really is about position
   * relative to the free end — the last stretch of a half-grown arm waves as
   * freely as the last stretch of a fully grown one. So the sway keeps the
   * fractional measure.
   */
  const along = [0];
  for (let i = 1; i < n; i++) {
    along.push(along[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
  }
  const fullReach = Math.max(1, Math.max(w, h) * 7 * p.reach * arm.length);

  const joints = [];
  const widths = [];
  for (let i = 0; i < n; i++) {
    const u = Math.min(1, along[i] / fullReach);
    const v = i / (n - 1);
    const a = path[i];
    const b = path[Math.min(i + 1, n - 1)];
    const prev = path[Math.max(i - 1, 0)];
    const dir = Math.atan2(b.y - prev.y, b.x - prev.x);
    // Sideways, and only sideways: pushing along the path would make the arm
    // appear to slide in and out of its own hole.
    // Capped at 0.3 of the base half-width and scaled by u², which is what
    // keeps the drawn arm inside the clearance the crawl reserved for it.
    /**
     * The whole body moves, not just the last few centimetres.
     *
     * The first version capped the sway at a third of the arm's width and
     * scaled it by u², which meant a limb that had reached its full extent sat
     * dead still with a twitching tip. That is the opposite of alive. It is now
     * a little over a whole width at the far end, falling off close to linearly
     * rather than quadratically, so an arm holding station against a wall is
     * visibly thrashing along its length while its base stays put in the hole.
     *
     * Two waves rather than one, at different rates and wavelengths, because a
     * single sine is a skipping rope: it has one belly and it swings like a
     * pendulum. Beating two against each other gives the irregular, muscular
     * motion the thing is supposed to have.
     */
    const smooth = Math.min(1, (n - 3) / 6);
    const amp = base * 1.15 * Math.min(writhe, 2) * Math.pow(v, 1.15) * emerge * smooth;
    const swing = (Math.sin(wave - v * 2.7) * 0.68 + Math.sin(wave * 1.63 - v * 5.6 + arm.phase) * 0.32) * amp;

    /**
     * Thickness, from two things that are not the same.
     *
     * The **taper** is a property of the limb: how thick it is a given distance
     * from the body. Held wide down most of it and falling away late, because
     * `1 - u` gives a triangle and a triangle is a leaf. Measured against a
     * little over half the arm's full reach rather than all of it — an arm that
     * only ever grows to a third of its limit otherwise never thins at all, and
     * comes out a uniform tube, which is what these were.
     *
     * The **tip** is a property of the end: whatever is currently the leading
     * few centimetres is thin, and stops being thin once it is no longer the
     * end. That is not a contradiction of the above, it is the difference
     * between a limb and its growing point, and without it every arm finishes
     * in a club the same width as its middle — which is the single thing that
     * still read as wrong. Its length scales with the arm's own girth, so a fat
     * tentacle gets a proportionally long point rather than a stubbed one.
     */
    /**
     * Thinning from the hole outwards, all the way along.
     *
     * The exponent is doing the real work, and it has been wrong in both
     * directions. At 1.9 against half the reach the width was down to a fifth
     * by the halfway point — a fat shoulder and a long whip. At 3.2 against
     * most of it the arm held its full width for two thirds of its reach and
     * then pinched: fine for an arm at full stretch, but an arm only a little
     * way out is all shoulder, and a short fat lozenge with a point on the end
     * is a leaf. 1.5 thins it steadily from the moment it leaves the wall, so
     * whatever length of it is out reads as the base of something longer.
     */
    const taperScale = Math.max(1, fullReach * 0.85);
    const d = along[i];
    const taper = 1 - 0.72 * Math.pow(Math.min(1, d / taperScale), 1.5);
    const fromTip = along[n - 1] - d;
    /**
     * Floored, not run to zero. A point that tapers all the way out spends its
     * last eighty pixels under one projector pixel — which is the four-pixel
     * floor, and it comes out as a hair that flickers rather than a tip. A
     * sixth of the base width is fine enough to read as a point and thick
     * enough to survive being projected. Drawn out over three widths rather
     * than two, so it is a tapering tip and not a nib.
     */
    const point = 0.16 + 0.84 * smoothstep(0, base * 3.2, fromTip);
    /**
     * A slow swell along the length, so it is a limb rather than a cone — but
     * gently. At a sixth either way over a 180-pixel period it was beading the
     * arm, and near the end, where the taper is already falling, a swell maximum
     * behind a thin tip is exactly the bulb it looked like.
     */
    const swell = 1 + 0.07 * Math.sin(d * 0.018 + arm.phase);
    /**
     * And floored against the *base* width rather than against a pixel.
     *
     * Taper and point multiply, so at the far end of a long arm the two
     * together reached 0.048 of the base — a two-and-a-half pixel ribbon, which
     * is one projector pixel and well under the four-pixel floor. That is the
     * thin section, and the soft bloom sitting on the end of it is what made it
     * read as a bulb on a hair.
     */
    const width = Math.max(base * 0.14, base * taper * swell * point) * (0.5 + 0.5 * emerge);
    widths.push(width);

    /**
     * The sway must not put the arm where the crawl refused to go.
     *
     * The crawl reserves a corridor around the path, and it is tempting to
     * argue that the sway is small enough to stay inside it — the sum peaks
     * around 1.1 of the base half-width against a reserved 1.45, so on paper it
     * cannot reach a window. On paper. In practice this leaked about one drawn
     * point in a thousand onto the glass, and an argument that predicts zero
     * and delivers hundreds is an argument with a hole in it, not a margin that
     * needs widening.
     *
     * So the drawn position is checked rather than reasoned about: if the
     * swayed joint is not clear at its own width, the arm is drawn at the joint
     * the crawl actually validated. It costs one containment test per joint and
     * it is true regardless of what any of the constants are set to.
     */
    let sx = a.x;
    let sy = a.y;
    if (container && swing !== 0) {
      // Wound in until it fits, rather than dropped to nothing the moment it
      // does not. Snapping a joint back to the path while its neighbours stay
      // swung out puts a kink in the arm; halving lets it lie against a window
      // frame instead — which is also what it should look like.
      let reach = swing;
      for (let tries = 0; tries < 4; tries++) {
        const tx = a.x + Math.cos(dir + Math.PI / 2) * reach;
        const ty = a.y + Math.sin(dir + Math.PI / 2) * reach;
        if (stepClear(container, obstacles, tx, ty, dir, width)) {
          sx = tx;
          sy = ty;
          break;
        }
        reach *= 0.5;
      }
    } else {
      sx = a.x + Math.cos(dir + Math.PI / 2) * swing;
      sy = a.y + Math.sin(dir + Math.PI / 2) * swing;
    }
    joints.push({ x: sx, y: sy });
  }

  /**
   * The tip curls.
   *
   * The last few widths of the arm are turned progressively further towards
   * the belly — a little at first and a lot at the very end, so it spirals
   * rather than bending at a hinge — by an amount that breathes with the
   * writhe. It is the one gesture that is unmistakably a tentacle, and a
   * straight point, however well shaded, is half a leaf.
   *
   * Every curled joint is a new position, so each is checked like the sway
   * is, and a curl that would put the tip anywhere it should not be is tried
   * at half and a quarter before being given up for this frame. Still at no
   * writhe, like everything else.
   */
  if (n > 8) {
    const curlLen = base * 2.8;
    let acc = 0;
    let start = n - 1;
    while (start > 1 && acc < curlLen) {
      acc += Math.hypot(joints[start].x - joints[start - 1].x, joints[start].y - joints[start - 1].y);
      start--;
    }
    const span = n - 1 - start;
    if (CURL.length < n * 2) CURL = new Float64Array(n * 4);
    if (span >= 2) {
      const want = (arm.side ?? 1) * (1.5 + 0.9 * Math.sin(wave * 0.55 + arm.phase * 1.7)) * emerge;
      for (const scale of [1, 0.5, 0.25]) {
        const total = want * scale;
        let px = joints[start].x;
        let py = joints[start].y;
        let ok = true;
        for (let i = start + 1; i < n; i++) {
          const turn = total * ((i - start) / span) ** 1.6;
          const dx = joints[i].x - joints[i - 1].x;
          const dy = joints[i].y - joints[i - 1].y;
          const c = Math.cos(turn);
          const s = Math.sin(turn);
          px += dx * c - dy * s;
          py += dx * s + dy * c;
          if (container && !stepClear(container, obstacles, px, py, Math.atan2(dy, dx) + turn, widths[i])) {
            ok = false;
            break;
          }
          CURL[i * 2] = px;
          CURL[i * 2 + 1] = py;
        }
        if (ok) {
          for (let i = start + 1; i < n; i++) {
            joints[i].x = CURL[i * 2];
            joints[i].y = CURL[i * 2 + 1];
          }
          break;
        }
      }
    }
  }

  /**
   * Take the sharpest corners out of the swayed spine before anything is drawn.
   *
   * A ribbon of half-width `w` following a curve of radius `R` turns inside out
   * once `w > R` — that is geometry, not a tuning choice, and it is why the
   * width has to be pinched at tight bends. Which is visible as a neck in the
   * arm exactly where it turns hardest.
   *
   * The right end to fix it at is the curve, not the width. The crawl's own
   * path is gentle enough (a 0.26 radian cap over a 15-pixel step is a 58-pixel
   * radius against a 27-pixel half-width), but the sway is applied on top of it
   * and can fold that into something much tighter. Two Laplacian passes pull
   * each joint a little towards the line between its neighbours, which costs
   * nothing visible in the motion and lifts the radius back above the width, so
   * the pinch cap stops firing and the arm keeps its thickness round a bend.
   *
   * Moving a joint means it needs checking again, so a smoothed position that
   * is not clear is simply not taken.
   */
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < n - 1; i++) {
      const mx = (joints[i - 1].x + joints[i + 1].x) * 0.5;
      const my = (joints[i - 1].y + joints[i + 1].y) * 0.5;
      const sx = joints[i].x + (mx - joints[i].x) * 0.34;
      const sy = joints[i].y + (my - joints[i].y) * 0.34;
      // In place: these are this frame's own points, never the crawl's, and
      // the pass already reads the neighbour behind it after moving it.
      if (!container || stepClear(container, obstacles, sx, sy, 0, widths[i] * 0.7)) {
        joints[i].x = sx;
        joints[i].y = sy;
      }
    }
  }

  // Smooth first, then fit: every vertex the smoothing introduces has to be
  // checked like any other, and checking before adding them would be checking
  // the wrong outline.
  const dense = subdivide(joints, widths, 3, container, obstacles);
  joints.length = 0;
  widths.length = 0;
  joints.push(...dense.joints);
  widths.push(...dense.widths);
  n = joints.length;

  /**
   * And where even the reduced sway leaves a flank over a window or off the
   * gable, thin the arm there instead.
   *
   * The flanks are laid out along the normal at each *joint* — the bisector of
   * two adjacent segments — which is not the direction anything upstream tested
   * against. Rather than add a third approximation, the outline is measured
   * where it will actually be drawn and the half-width halved until it fits.
   * A tentacle that narrows slightly as it squeezes past a window frame is
   * invisible; one that covers the glass is the only thing anybody notices.
   */
  if (container) fitWidths(container, obstacles, joints, widths);

  /**
   * The skin: one fitted outline, and everything inside it.
   *
   * What makes a dark ribbon on a lit wall read as a tentacle rather than as a
   * leaf is that it is *round* and that it has an underside — so the shading
   * goes across the limb as much as along it, and the suckers are on one flank
   * only. In order:
   *
   *  1. **Its shadow on the wall**, the same outline moved down and to the
   *     right, away from the light the bricks are lit by. A projector cannot
   *     darken the wall beside the arm by much, but by enough: it is the one
   *     cue that says the arm is lying *on* the brickwork rather than printed
   *     into it, and it costs one fill.
   *  2. **The silhouette**, nearly black, at the full fitted width. A limb on a
   *     lit wall needs an edge or it reads as a decal, and a stroked outline is
   *     not an option — two pixels of line is nothing on a projector — so the
   *     rest is drawn at fractions of the width inside it and the edge is what
   *     is left. Nothing is drawn wider than `widths`: that is the contract
   *     the fitting above exists to keep.
   *  3. **The body** at 85%, darkest at the root and lightening towards the tip
   *     as one gradient down the arm's axis — a hard tonal step anywhere along
   *     it reads as a joint in the limb.
   *  4. **The round of it** at 45%, lighter again and translucent: with the
   *     edge band and the body, a cylinder in three soft steps.
   *  5. **Markings and suckers.** Soft dark blotches along the top; pale,
   *     cupped suckers down the belly, in a staggered double row where the arm
   *     is thick and a single one as it thins.
   *  6. **A wet sheen** down the back, broken into glints that come and go as
   *     it writhes. Strokes, not another fitted ribbon: they ride inside the
   *     body, and the clip keeps them off the glass.
   *  7. **A light at the tip**, from a sprite in the colour of whatever is in
   *     the wall — not a disc on the end, which read as a firefly on a stalk,
   *     but light along the last stretch of the arm.
   *
   * 1, 2 and 3–4 are fills of the same nested outline at fractions the fitting
   * has measured (1, 0.85, 0.45), so every one of them is clear of the glass on
   * its own merits.
   */
  const tip0 = joints[n - 1];
  const root = joints[0];
  const fade = g.globalAlpha;

  // Everything below stays within a few widths of the spine — the shadow is
  // moved by half of one, the light on the tip reaches four — so that box is
  // all that has to be kept off the glass, and only if there is glass in it.
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  for (let i = 0; i < n; i++) {
    bx0 = Math.min(bx0, joints[i].x);
    by0 = Math.min(by0, joints[i].y);
    bx1 = Math.max(bx1, joints[i].x);
    by1 = Math.max(by1, joints[i].y);
  }
  const pad = base * 4.2;
  const guarded = container
    ? guardOpenings(g, obstacles, bx0 - pad, by0 - pad, bx1 + pad, by1 + pad)
    : false;

  jointNormals(joints);
  const nx = NX;
  const ny = NY;

  const drop = base * 0.42 * emerge;
  if (drop > 0.5) {
    g.save();
    g.translate(drop * 0.5, drop * 0.86);
    g.fillStyle = 'rgba(0,0,0,0.34)';
    tentacleRibbon(g, joints, widths, 1, nx, ny);
    g.restore();
  }

  g.fillStyle = mixHex(p.armColor, '#040604', 0.78);
  tentacleRibbon(g, joints, widths, 1, nx, ny);

  const ramp = g.createLinearGradient(root.x, root.y, tip0.x, tip0.y);
  ramp.addColorStop(0, mixHex(p.armColor, '#000000', 0.5));
  ramp.addColorStop(0.45, p.armColor);
  ramp.addColorStop(1, mixHex(p.armColor, p.armTip, 0.45));
  g.fillStyle = ramp;
  tentacleRibbon(g, joints, widths, 0.85, nx, ny);

  const round = g.createLinearGradient(root.x, root.y, tip0.x, tip0.y);
  round.addColorStop(0, rgba(mixHex(p.armColor, p.armTip, 0.4), 0));
  round.addColorStop(0.35, rgba(mixHex(p.armColor, p.armTip, 0.5), 0.22));
  round.addColorStop(1, rgba(p.armTip, 0.32));
  g.fillStyle = round;
  tentacleRibbon(g, joints, widths, 0.45, nx, ny);

  const side = arm.side ?? 1;

  /**
   * Markings down the back, spaced by distance from the root with a draw per
   * spot, so they belong to the limb and stay put on it as it grows.
   */
  {
    g.beginPath();
    let travelled = 0;
    let next = base * 0.8;
    let k = 0;
    for (let i = 1; i < n - 2; i++) {
      travelled += Math.hypot(joints[i].x - joints[i - 1].x, joints[i].y - joints[i - 1].y);
      if (travelled < next) continue;
      const r = widths[i] * (0.16 + 0.16 * spot(k, arm.phase));
      next += base * (0.9 + 1.1 * spot(k + 7, arm.phase));
      k++;
      if (r < 1) continue;
      const a = Math.atan2(joints[i + 1].y - joints[i - 1].y, joints[i + 1].x - joints[i - 1].x) - (Math.PI / 2) * side;
      const off = widths[i] * (0.2 * spot(k + 3, arm.phase) - 0.12);
      const x = joints[i].x + Math.cos(a) * off;
      const y = joints[i].y + Math.sin(a) * off;
      g.moveTo(x + r, y);
      g.arc(x, y, r, 0, TAU);
    }
    g.fillStyle = rgba(mixHex(p.armColor, '#000000', 0.6), 0.24);
    g.fill();
  }

  if (p.suckers > 0) {
    /**
     * Spaced along the arm by distance, not one per joint.
     *
     * Per joint they came out as a solid overlapping chain, because the joint
     * spacing is the crawl step tripled by the smoothing. By distance, and a
     * couple of diameters apart, they thin out towards the tip with the arm.
     *
     * Each one a pale rim with a dark cup in it, foreshortened across the arm
     * because it is a disc on the side of a cylinder — and gathered into one
     * path per colour, so a long arm's thirty suckers are two fills rather than
     * sixty with a save and a restore round each.
     */
    let count = 0;
    let since = Infinity;
    for (let i = 1; i < n - 1 && count < MAX_SUCKERS; i++) {
      const a = joints[i];
      const b = joints[i + 1];
      since += Math.hypot(b.x - a.x, b.y - a.y);
      const r = widths[i] * 0.2;
      if (r < 1.3 || since < r * 2.9) continue;
      since = 0;
      const along = Math.atan2(b.y - a.y, b.x - a.x);
      const nrm = along + (Math.PI / 2) * side;
      const vary = 0.75 + 0.5 * Math.abs(Math.sin(i * 1.7 + arm.phase));
      // Two rows, staggered, while there is room for two — down the underside,
      // towards the edge, where a sucker shows as a rim rather than a target.
      const row = widths[i] > base * 0.55 ? (count & 1 ? 0.46 : 0.68) : 0.62;
      SUCKERS[count * 4] = a.x + Math.cos(nrm) * widths[i] * row;
      SUCKERS[count * 4 + 1] = a.y + Math.sin(nrm) * widths[i] * row;
      SUCKERS[count * 4 + 2] = r * vary;
      SUCKERS[count * 4 + 3] = along;
      count++;
    }
    if (count) {
      g.beginPath();
      for (let k = 0; k < count; k++) {
        const x = SUCKERS[k * 4];
        const y = SUCKERS[k * 4 + 1];
        const r = SUCKERS[k * 4 + 2];
        const a = SUCKERS[k * 4 + 3];
        g.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
        g.ellipse(x, y, r, r * 0.78, a, 0, TAU);
      }
      g.fillStyle = rgba(mixHex(p.armTip, '#dccbab', 0.35), 0.62 * clamp(p.suckers, 0, 1));
      g.fill();
      g.beginPath();
      for (let k = 0; k < count; k++) {
        const x = SUCKERS[k * 4];
        const y = SUCKERS[k * 4 + 1];
        const r = SUCKERS[k * 4 + 2] * 0.46;
        const a = SUCKERS[k * 4 + 3];
        g.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
        g.ellipse(x, y, r, r * 0.74, a, 0, TAU);
      }
      g.fillStyle = rgba(mixHex(p.armColor, '#000000', 0.5), 0.6 * clamp(p.suckers, 0, 1));
      g.fill();
    }
  }

  /**
   * The sheen, down the back of the arm: the flank without the suckers.
   *
   * It followed the light at first, offset by how squarely each flank faced
   * it — right for a plain cylinder, and wrong for this one, because an arm
   * reaching up towards the light put its highlight on the centreline, where
   * it read as the midrib of a leaf. On the back it says which side is which,
   * and it never crosses the arm.
   */
  {
    const glints = 5;
    const first = Math.floor(n * 0.06);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (let s = 0; s < glints; s++) {
      const i0 = first + Math.floor(((n - first) * s) / glints);
      const i1 = first + Math.floor(((n - first) * (s + 0.55)) / glints);
      if (i1 - i0 < 2) continue;
      let sum = 0;
      g.beginPath();
      for (let i = i0; i <= i1; i++) {
        const off = -side * widths[i] * 0.38;
        if (i === i0) g.moveTo(joints[i].x + nx[i] * off, joints[i].y + ny[i] * off);
        else g.lineTo(joints[i].x + nx[i] * off, joints[i].y + ny[i] * off);
        sum += widths[i];
      }
      const glint = 0.5 + 0.5 * Math.sin(wave * 1.3 + s * 2.1 + arm.phase);
      g.lineWidth = Math.max(1.2, (sum / (i1 - i0 + 1)) * 0.13);
      g.strokeStyle = rgba('#f4ffe8', (0.1 + 0.34 * glint) * emerge);
      g.stroke();
    }
  }

  if (p.armGlow > 0 && sprites?.tip) {
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 3; k++) {
      const i = Math.max(0, n - 1 - Math.round(k * n * 0.05));
      const at = joints[i];
      const size = Math.max(8, widths[i] * (8 - k * 2));
      g.globalAlpha = fade * clamp(0.34 * p.armGlow * emerge * (1 - k * 0.25), 0, 1);
      g.drawImage(sprites.tip, at.x - size / 2, at.y - size / 2, size, size);
    }
    g.restore();
  }
  if (guarded) g.restore();
}

/**
 * Keep what is drawn next off the glass — but only inside a box, and only if
 * there is glass in the box. Returns whether it saved a clip for the caller to
 * restore.
 *
 * The box is part of the clip, and that is the point of it: the mask a canvas
 * builds for a clip covers the clip's extent, so the wall with every opening
 * cut out of it costs a mask the size of the wall, while one arm's box with
 * the one window it is lying beside costs a mask the size of the arm. Even-odd
 * against the box makes each opening a hole in it.
 */
function guardOpenings(g, obstacles, x0, y0, x1, y1) {
  let any = false;
  for (const o of obstacles) {
    const b = o.bbox;
    if (b.x < x1 && b.x + b.w > x0 && b.y < y1 && b.y + b.h > y0) {
      any = true;
      break;
    }
  }
  if (!any) return false;
  g.save();
  g.beginPath();
  g.rect(x0, y0, x1 - x0, y1 - y0);
  for (const o of obstacles) {
    const b = o.bbox;
    if (b.x < x1 && b.x + b.w > x0 && b.y < y1 && b.y + b.h > y0) traceRing(g, o.points);
  }
  g.clip('evenodd');
  return true;
}

/** Suckers an arm can carry, and a scratch table for them: x, y, radius, angle. */
const MAX_SUCKERS = 160;
const SUCKERS = new Float64Array(MAX_SUCKERS * 4);

/** Trial positions for a curling tip, grown if an arm is ever longer than this. */
let CURL = new Float64Array(2048);

/** A draw in [0, 1] for the k-th marking on an arm, the same every frame. */
function spot(k, phase) {
  const s = Math.sin(k * 12.9898 + phase * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

export default [brickwork, breach];
