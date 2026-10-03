/**
 * A house to practise on.
 *
 * Everything this app does needs three things you probably do not have to hand
 * at the moment you first open it: a camera pointed at a building, a projector
 * plugged into a second display, and darkness. Until all three exist the app is
 * a black rectangle and a checklist, which is a poor way to find out whether it
 * is worth setting up at all.
 *
 * So: a synthetic facade, drawn here in code, installed as the tracing backdrop
 * with its windows, door, roofline and chimney already traced and tagged. It
 * makes the whole application explorable at two in the afternoon, indoors, with
 * no hardware — browse effects, build a look, learn where everything lives —
 * and the work carries over, because a real show differs only in which picture
 * is behind the shapes.
 *
 * The layout below is the single source of truth: the drawing code and the
 * traced shapes are both generated from it, so a window is traced exactly where
 * a window was painted. Move a number and both follow.
 */

import { makeRng, hexToRgb } from '../core/math.js';
import { createShape } from '../core/state.js';

/* ------------------------------------------------------------------ *
 * Layout
 *
 * Normalised 0..1 across a 16:9 frame, the same coordinate space shapes are
 * stored in — so these numbers are simultaneously the drawing plan and the
 * traced geometry.
 * ------------------------------------------------------------------ */

export const DEMO_ASPECT = 16 / 9;

/**
 * A 1930s rendered semi, because that is what most of the houses this gets
 * pointed at actually are.
 *
 * The layout is taken from a real one, and the details that matter are the ones
 * that change what the effects have to cope with: a **hipped** roof, so the
 * front eaves is a horizontal gutter line rather than a gable rake; a **bay**
 * on the ground floor, which is a wide low opening quite unlike a flat window;
 * a **flat-roofed store** stuck on one side; the **neighbour's half** carrying
 * on past the party wall, which is the single most useful thing about a semi to
 * practise on, because you must light your half and not theirs; and **white
 * render** rather than brick, which is why Brickwork exists at all.
 */
const L = {
  ground: 0.905,
  eaves: 0.245,
  ridge: 0.145,
  /** The traced half: from the corner to the party wall. */
  wallL: 0.255,
  wallR: 0.745,
  /** Roof overhangs, and the hip starts where the ridge does. */
  rakeL: 0.232,
  hip: 0.44,

  chimney: { x: 0.664, w: 0.062, top: 0.036, base: 0.186 },

  door: { x: 0.395, w: 0.078, top: 0.585 },
  /** The brick reveal round the door — one of the two real brick details. */
  surround: { x: 0.372, w: 0.124, top: 0.560 },

  /** Square bay, with its own flat roof and a brick plinth under the sill. */
  bay: { x: 0.545, w: 0.178, y: 0.607, h: 0.183 },

  upper: [
    { name: 'Landing window', x: 0.407, w: 0.053, y: 0.296, h: 0.126, cols: 1, rows: 2 },
    { name: 'Bedroom window', x: 0.559, w: 0.147, y: 0.296, h: 0.126, cols: 3, rows: 1 },
  ],

  /**
   * The clear panel across the middle of the wall.
   *
   * Every facade has one and it is the first thing to look for when you trace
   * your own: the largest rectangle of blank wall, which on a house like this
   * is the band between the bedroom windows and the ground floor. It is where
   * a name, a countdown or a message goes, and having it tagged means a preset
   * can put its biggest thing somewhere that was chosen rather than somewhere
   * that happened to be traced.
   */
  primary: { x: 0.305, w: 0.390, y: 0.428, h: 0.128 },

  /** A pot on the wall beside the door, of the sort everybody has. */
  planter: { x: 0.296, w: 0.064, y: 0.612, h: 0.186 },

  /** Flat-roofed side store, with its own little window and an open doorway. */
  store: { x: 0.055, w: 0.200, roof: 0.575, ground: 0.925 },
  storeWindow: { x: 0.100, w: 0.046, y: 0.652, h: 0.072 },
  storeDoor: { x: 0.172, w: 0.080, y: 0.618, h: 0.307 },
};

const rect = (x, y, w, h) => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

/**
 * The traced scene that ships with the demo.
 *
 * Tagged the way the starter presets expect (`window`, `door`, `roof`,
 * `chimney`, `wall`, `trim`, `sign`, `path`), which is what lets "Halloween
 * starter" land a complete look on it without a single click of setup.
 */
export function demoShapes() {
  const shapes = [];
  const add = (points, name, tags, overrides = {}) => {
    shapes.push(createShape(points, { name, tags, ...overrides }));
  };

  // Wall first so it sits behind everything in the shape list, which is also
  // the order you would have traced it in. A hipped roof means this is simply
  // a rectangle — no rake to follow, which is one fewer thing to get wrong.
  add(rect(L.wallL, L.eaves, L.wallR - L.wallL, L.ground - L.eaves), 'Front wall', ['wall']);

  add(
    rect(L.store.x, L.store.roof, L.store.w, L.store.ground - L.store.roof),
    'Side store',
    ['wall']
  );

  /**
   * The gutter line, traced as an open path.
   *
   * On a hipped roof this is horizontal all the way across the front, which is
   * the best thing that can happen to a string of fairy lights — a gable rake
   * makes them climb, and half the roofline ends up pointing at the sky.
   */
  add(
    [
      { x: L.wallL - 0.005, y: L.eaves + 0.004 },
      { x: L.wallR + 0.005, y: L.eaves + 0.004 },
    ],
    'Roofline',
    ['roof'],
    { type: 'path', closed: false }
  );

  add(
    rect(L.chimney.x, L.chimney.top, L.chimney.w, L.chimney.base - L.chimney.top),
    'Chimney',
    ['chimney']
  );

  for (const w of L.upper) add(rect(w.x, w.y, w.w, w.h), w.name, ['window']);

  add(rect(L.bay.x, L.bay.y, L.bay.w, L.bay.h), 'Bay window', ['window']);

  // The brick plinth under the bay. Traced because it is the one band of the
  // facade that already has a texture, so it is where a light strip or a line
  // of frost has something to sit on.
  add(
    rect(L.bay.x - 0.006, L.bay.y + L.bay.h, L.bay.w + 0.012, L.ground - (L.bay.y + L.bay.h)),
    'Bay plinth',
    ['trim']
  );

  add(rect(L.door.x, L.door.top, L.door.w, L.ground - L.door.top), 'Front door', ['door']);

  /**
   * The feature panel, and the pot beside the door.
   *
   * Neither is a thing the camera can see — the panel is bare render and the
   * pot is a dark blob — which is exactly why they are worth tracing. A show
   * needs somewhere deliberate to put its headline and somewhere for a plant
   * to grow out of, and on most houses both are places you have to *decide*
   * rather than places with an outline.
   */
  add(rect(L.primary.x, L.primary.y, L.primary.w, L.primary.h), 'Feature panel', ['primary']);
  add(rect(L.planter.x, L.planter.y, L.planter.w, L.planter.h), 'Wall pot', ['planter']);

  add(
    rect(L.storeWindow.x, L.storeWindow.y, L.storeWindow.w, L.storeWindow.h),
    'Store window',
    ['window']
  );

  /**
   * A shallow arch over the door, as an open path.
   *
   * Text laid along it reads as a sign hung over the porch rather than as a
   * caption floating on the wall, and it is the one shape here whose whole
   * purpose is to be written on — hence its own tag.
   *
   * Deliberately wider than the door. A sign has to hold a phrase, and the text
   * effect sizes itself from the shape it is given: an arch only as wide as the
   * door forces "MERRY CHRISTMAS" down to something you could not read from the
   * pavement, which is the one place it will ever be read from.
   */
  const archPad = 0.075;
  add(
    Array.from({ length: 11 }, (_, i) => {
      const u = i / 10;
      return {
        x: L.door.x - archPad + u * (L.door.w + archPad * 2),
        y: L.surround.top - 0.022 - Math.sin(u * Math.PI) * 0.05,
      };
    }),
    'Door arch',
    ['sign', 'trim'],
    { type: 'path', closed: false, smooth: true }
  );

  // The path is where you point a motion trigger, and where the leaves gather.
  add(
    [
      { x: L.door.x - 0.02, y: L.ground },
      { x: L.bay.x + L.bay.w, y: L.ground },
      { x: 0.80, y: 1.0 },
      { x: 0.22, y: 1.0 },
    ],
    'Garden path',
    ['path']
  );

  return shapes;
}

/**
 * Where a projector standing on the front lawn would land on this house.
 *
 * Slightly off-square, because a projector on the ground pointing up always is,
 * and deliberately not covering the neighbour's half — which is the thing to
 * notice about a semi. It exists so the coverage outline and the "aligned"
 * state in the checklist behave like a real show rather than being
 * special-cased away.
 */
export function demoWorldQuad() {
  return [
    { x: 0.045, y: 0.055 },
    { x: 0.815, y: 0.035 },
    { x: 0.855, y: 0.965 },
    { x: 0.015, y: 0.985 },
  ];
}

/* ------------------------------------------------------------------ *
 * Painting the house
 *
 * Deliberately dim and blue. A projector cannot emit darkness, so a facade at
 * night is mostly a very dark picture with a few slightly-less-dark surfaces —
 * and an effect tuned against a bright daylight photo will be far too weak when
 * it meets a real wall. Practising against a plausible night exposure is most
 * of the point.
 *
 * Dim is not the same as flat, though. The first version of this was flat
 * fills and white rectangles, and two things about it were actively
 * misleading. White uPVC frames painted at full white read as *lit* — brighter
 * than anything an effect puts in the glass — so every window looked
 * outlined in neon before a single layer was on. And with no light falling
 * anywhere, nothing projected onto it looked like it was landing on a
 * building: a wall with no sills, no shadow under the eaves and no texture is
 * a sheet of card, and whatever goes on card looks like a sticker.
 *
 * So the picture is lit, the way a street at night is: a cold sky overhead,
 * a streetlight somewhere off to the right raking across the render, the porch
 * lamp, and whatever is on behind the curtains. Every surface that projects —
 * sills, lintel hoods, the bay, the gutter — catches the sky on top and throws
 * a shadow below. None of it is bright. All of it is the difference between a
 * drawing of a house and a photograph of one.
 * ------------------------------------------------------------------ */

/** Turn a list of normalised points into a Path2D in canvas pixels. */
function polyPath(points, W, H) {
  const p = new Path2D();
  p.moveTo(points[0].x * W, points[0].y * H);
  for (let i = 1; i < points.length; i++) p.lineTo(points[i].x * W, points[i].y * H);
  p.closePath();
  return p;
}

const rectPath = (x, y, w, h, W, H) => polyPath(rect(x, y, w, h), W, H);

function canvasOf(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/**
 * Grey relief noise, centred on mid-grey, for laying over a surface with
 * 'overlay' so it modulates whatever colour is underneath rather than
 * replacing it.
 *
 * Per-pixel random values, embossed: each pixel minus its neighbour down and
 * to the right. That is the cheapest thing that reads as a surface rather than
 * as noise — every grain gets a lit upper-left edge and a shadowed lower-right
 * one, which is what pebbledash does under a light from above. Two scales of
 * it: single-pixel speckle, because at six metres across a pebble is about a
 * pixel, and a gentler relief from a softened copy for the trowelled
 * undulation under the stones. A coarser grid of blotches is mixed in for the
 * weathering a real wall has: patches where the render was made good, damp.
 * All of it gentle — strong relief at this scale reads as crumpled paper.
 */
function reliefTexture(W, H, rng, { speckle = 20, relief = 52, mottle = 12, mottleCell = 46 }) {
  const n = W * H;
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) raw[i] = rng();
  // A copy softened by a 3x3 box blur, for the larger-scale relief.
  const tmp = new Float32Array(n);
  const soft = new Float32Array(n);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const l = row + Math.max(0, x - 1);
      const r = row + Math.min(W - 1, x + 1);
      tmp[row + x] = (raw[l] + raw[row + x] + raw[r]) / 3;
    }
  }
  for (let y = 0; y < H; y++) {
    const up = Math.max(0, y - 1) * W;
    const dn = Math.min(H - 1, y + 1) * W;
    for (let x = 0; x < W; x++) soft[y * W + x] = (tmp[up + x] + tmp[y * W + x] + tmp[dn + x]) / 3;
  }

  // Blotches: a coarse grid of random values, interpolated smoothly.
  const gw = Math.ceil(W / mottleCell) + 2;
  const gh = Math.ceil(H / mottleCell) + 2;
  const grid = new Float32Array(gw * gh);
  for (let i = 0; i < grid.length; i++) grid[i] = rng() - 0.5;

  const canvas = canvasOf(W, H);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  const d = img.data;
  for (let y = 0; y < H; y++) {
    const gy = y / mottleCell;
    const y0 = Math.floor(gy);
    const fy = gy - y0;
    const sy = fy * fy * (3 - 2 * fy);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const below = Math.min(n - 1, i + W + 1);
      const grain = (raw[i] - raw[below]) * speckle + (soft[i] - soft[below]) * relief;
      const gx = x / mottleCell;
      const x0 = Math.floor(gx);
      const fx = gx - x0;
      const sx = fx * fx * (3 - 2 * fx);
      const a = grid[y0 * gw + x0];
      const b = grid[y0 * gw + x0 + 1];
      const c = grid[(y0 + 1) * gw + x0];
      const e = grid[(y0 + 1) * gw + x0 + 1];
      const blot = (a + (b - a) * sx) + ((c + (e - c) * sx) - (a + (b - a) * sx)) * sy;
      const v = 128 + grain + blot * mottle * 2;
      const o = i * 4;
      d[o] = d[o + 1] = d[o + 2] = v;
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/* ------------------------------------------------------------------ *
 * Sky, the tree, the wires
 * ------------------------------------------------------------------ */

function sky(g, rng, W, H) {
  const grad = g.createLinearGradient(0, 0, 0, L.ground * H);
  grad.addColorStop(0, '#03050c');
  grad.addColorStop(0.45, '#08101f');
  grad.addColorStop(0.8, '#121a2e');
  grad.addColorStop(1, '#1e2234');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);

  // Town glow on the horizon, warm, which is what a suburban sky actually is.
  const glowY = L.ground * H;
  const town = g.createRadialGradient(W * 0.12, glowY, 0, W * 0.12, glowY, W * 0.5);
  town.addColorStop(0, 'rgba(92,64,52,0.30)');
  town.addColorStop(0.5, 'rgba(60,44,48,0.12)');
  town.addColorStop(1, 'rgba(40,34,48,0)');
  g.fillStyle = town;
  g.fillRect(0, 0, W, H);

  // High cloud, lit from below by that glow: a few soft banks, barely there.
  // Drawn as a small random canvas stretched wide, so it is smooth for free.
  const cw = 28;
  const ch = 10;
  const cloud = canvasOf(cw, ch);
  const cx = cloud.getContext('2d');
  const img = cx.createImageData(cw, ch);
  for (let i = 0; i < cw * ch; i++) {
    const y = Math.floor(i / cw);
    const v = Math.max(0, rng() - 0.55) * 2.2 * (y < 6 ? 1 : 0.4);
    img.data[i * 4] = 120;
    img.data[i * 4 + 1] = 112;
    img.data[i * 4 + 2] = 130;
    img.data[i * 4 + 3] = Math.round(v * 70);
  }
  cx.putImageData(img, 0, 0);
  g.save();
  g.imageSmoothingEnabled = true;
  g.globalAlpha = 0.35;
  g.drawImage(cloud, -W * 0.05, -H * 0.02, W * 1.1, H * 0.62);
  g.restore();

  // A handful of the brightest stars: a town sky shows almost none.
  for (let i = 0; i < 26; i++) {
    const x = rng() * W;
    const y = rng() * H * 0.42;
    const b = 0.18 + rng() * rng() * 0.5;
    g.fillStyle = `rgba(220,228,255,${b.toFixed(3)})`;
    g.fillRect(x, y, 1.2 * (H / 900), 1.2 * (H / 900));
  }
}

/**
 * A bare tree in next door's garden, off to the left.
 *
 * It is the one thing in the frame that is not a building, and it does two
 * jobs: it stops the left of the picture being a blank rectangle of sky, and
 * it puts something *in front of* the night that is not lit, which is what
 * makes the projected light read as light. Bare because most of the nights
 * this gets pointed at are October to January.
 */
function tree(g, rng, W, H) {
  const s = H / 900;
  g.save();
  g.lineCap = 'round';
  g.strokeStyle = '#05070b';
  g.fillStyle = '#05070b';

  const limb = (x, y, angle, length, width, depth) => {
    const bend = (rng() - 0.5) * 0.5;
    const x2 = x + Math.cos(angle) * length;
    const y2 = y + Math.sin(angle) * length;
    const mx = (x + x2) / 2 + Math.cos(angle + Math.PI / 2) * length * bend * 0.3;
    const my = (y + y2) / 2 + Math.sin(angle + Math.PI / 2) * length * bend * 0.3;
    g.lineWidth = Math.max(0.6 * s, width);
    g.globalAlpha = width < 1.2 * s ? 0.75 : 1;
    g.beginPath();
    g.moveTo(x, y);
    g.quadraticCurveTo(mx, my, x2, y2);
    g.stroke();
    if (depth <= 0 || width < 0.7 * s) return;
    const forks = depth > 5 ? 2 : 2 + (rng() < 0.45 ? 1 : 0);
    for (let i = 0; i < forks; i++) {
      const spread = (i - (forks - 1) / 2) * (0.42 + rng() * 0.25);
      // Branches lean back towards vertical: a tree grows towards the light.
      const a = angle + spread + (rng() - 0.5) * 0.35 + (-Math.PI / 2 - angle) * 0.12;
      limb(x2, y2, a, length * (0.66 + rng() * 0.18), width * (0.62 + rng() * 0.1), depth - 1);
    }
  };

  // Trunk, in two pieces so it has a kink in it.
  const baseX = W * 0.028;
  const baseY = H * 0.935;
  g.beginPath();
  g.moveTo(baseX - 9 * s, baseY);
  g.quadraticCurveTo(baseX - 4 * s, H * 0.7, baseX + 2 * s, H * 0.55);
  g.lineTo(baseX + 10 * s, H * 0.55);
  g.quadraticCurveTo(baseX + 6 * s, H * 0.72, baseX + 9 * s, baseY);
  g.closePath();
  g.fill();
  limb(baseX + 6 * s, H * 0.56, -Math.PI / 2 + 0.22, H * 0.12, 13 * s, 8);
  limb(baseX + 4 * s, H * 0.6, -Math.PI / 2 - 0.5, H * 0.08, 8 * s, 6);
  limb(baseX + 6 * s, H * 0.66, -Math.PI / 2 + 0.75, H * 0.09, 7 * s, 6);
  g.restore();
}

/**
 * Overhead lines. Every street like this has them, they cross the sky at an
 * angle, and they are a fair test of whether an effect aimed at the roofline
 * is actually following the roofline.
 */
function wires(g, W, H) {
  g.save();
  g.strokeStyle = 'rgba(120,128,150,0.28)';
  g.lineWidth = Math.max(1, H * 0.0016);
  for (const [y0, y1] of [[0.055, 0.115], [0.10, 0.02]]) {
    g.beginPath();
    g.moveTo(0, y0 * H);
    g.quadraticCurveTo(W * 0.5, (y0 + y1) * 0.5 * H + H * 0.02, W, y1 * H);
    g.stroke();
  }
  g.restore();
}

/* ------------------------------------------------------------------ *
 * The ground
 * ------------------------------------------------------------------ */

function garden(g, rng, W, H, tex) {
  const s = H / 900;
  const top = L.ground * H;

  // Lawn, falling off into the dark towards the camera.
  const lawn = g.createLinearGradient(0, top, 0, H);
  lawn.addColorStop(0, '#111a13');
  lawn.addColorStop(1, '#070b08');
  g.fillStyle = lawn;
  g.fillRect(0, top, W, H - top);
  // Blades: short dark and light ticks, denser further away.
  for (let i = 0; i < W * 1.6; i++) {
    const x = rng() * W;
    const y = top + rng() ** 1.6 * (H - top);
    const h = (2 + rng() * 4) * s * (0.6 + (y - top) / (H - top));
    g.strokeStyle = rng() < 0.5 ? 'rgba(52,70,50,0.35)' : 'rgba(0,0,0,0.35)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (rng() - 0.5) * 2 * s, y - h);
    g.stroke();
  }

  // A strip of gravel along the foot of the walls, where the lawn stops.
  const strip = rectPath(L.store.x - 0.01, L.ground - 0.004, 1.03 - L.store.x, 0.022, W, H);
  g.save();
  g.clip(strip);
  g.fillStyle = '#1c1d1f';
  g.fill(strip);
  for (let i = 0; i < W * 1.2; i++) {
    g.fillStyle = rng() < 0.5 ? 'rgba(120,118,112,0.22)' : 'rgba(0,0,0,0.4)';
    g.fillRect(L.store.x * W + rng() * W, top - 4 * s + rng() * 0.024 * H, 1.6 * s, 1.3 * s);
  }
  g.restore();

  // Brick-paved path in front of the door, which is what the photo has and
  // what a motion trigger wants to be pointed at. Courses get deeper towards
  // the camera, and the porch lamp lays a warm pool on the near end of it.
  const pts = [
    { x: L.door.x - 0.02, y: L.ground },
    { x: L.bay.x + L.bay.w, y: L.ground },
    { x: 0.80, y: 1.0 },
    { x: 0.22, y: 1.0 },
  ];
  const path = polyPath(pts, W, H);
  g.save();
  g.clip(path);
  g.fillStyle = '#100d0c';
  g.fill(path);
  const courses = 13;
  let y = top;
  for (let i = 0; i < courses; i++) {
    const u0 = i / courses;
    const u1 = (i + 1) / courses;
    // Perspective: each course a little deeper than the one behind it.
    const y0 = top + (H - top) * (u0 * u0 * 0.45 + u0 * 0.55);
    const y1 = top + (H - top) * (u1 * u1 * 0.45 + u1 * 0.55);
    const leftAt = (yy) => {
      const v = (yy / H - L.ground) / (1 - L.ground);
      return ((L.door.x - 0.02) + (0.22 - (L.door.x - 0.02)) * v) * W;
    };
    const rightAt = (yy) => {
      const v = (yy / H - L.ground) / (1 - L.ground);
      return ((L.bay.x + L.bay.w) + (0.80 - (L.bay.x + L.bay.w)) * v) * W;
    };
    const xl = leftAt(y1) - 20 * s;
    const xr = rightAt(y1) + 20 * s;
    const n = 9;
    const off = i % 2 ? 0.5 : 0;
    for (let j = -1; j <= n; j++) {
      const a = (j + off) / n;
      const b = (j + 1 + off) / n;
      const xa0 = leftAt(y0) + (rightAt(y0) - leftAt(y0)) * a;
      const xb0 = leftAt(y0) + (rightAt(y0) - leftAt(y0)) * b;
      const xa1 = leftAt(y1) + (rightAt(y1) - leftAt(y1)) * a;
      const xb1 = leftAt(y1) + (rightAt(y1) - leftAt(y1)) * b;
      const v = rng();
      g.fillStyle = `rgb(${(46 + v * 18) | 0},${(32 + v * 10) | 0},${(28 + v * 8) | 0})`;
      const gap = 1.1 * s;
      g.beginPath();
      g.moveTo(xa0 + gap, y0 + gap);
      g.lineTo(xb0 - gap, y0 + gap);
      g.lineTo(xb1 - gap, y1 - gap);
      g.lineTo(xa1 + gap, y1 - gap);
      g.closePath();
      g.fill();
    }
    void xl;
    void xr;
    y = y1;
  }
  void y;
  // Distance haze on the far end, and the lamp's pool on it.
  const fall = g.createLinearGradient(0, top, 0, H);
  fall.addColorStop(0, 'rgba(0,0,0,0)');
  fall.addColorStop(1, 'rgba(0,0,0,0.45)');
  g.fillStyle = fall;
  g.fill(path);
  const lampX = (L.surround.x - 0.012) * W;
  const pool = g.createRadialGradient(lampX + W * 0.03, top + 8 * s, 0, lampX + W * 0.03, top + 8 * s, W * 0.13);
  pool.addColorStop(0, 'rgba(255,190,120,0.16)');
  pool.addColorStop(1, 'rgba(255,190,120,0)');
  g.fillStyle = pool;
  g.fill(path);
  g.restore();

  // The doorstep: a stone slab proud of the wall, its top catching the lamp.
  const d = L.door;
  const sx = (d.x - 0.012) * W;
  const sw = (d.w + 0.024) * W;
  g.fillStyle = '#4a4744';
  g.fillRect(sx, top - 3 * s, sw, 5 * s);
  g.fillStyle = '#2a2826';
  g.fillRect(sx, top + 2 * s, sw, 6 * s);
  g.fillStyle = 'rgba(0,0,0,0.5)';
  g.fillRect(sx, top + 8 * s, sw, 3 * s);

  // A clipped hedge across the bottom corners, the boundary with the road.
  g.fillStyle = '#060a07';
  for (const [x0, x1] of [[-0.02, 0.2], [0.82, 1.03]]) {
    g.beginPath();
    g.moveTo(x0 * W, H);
    const bumps = 9;
    for (let i = 0; i <= bumps; i++) {
      const x = (x0 + (x1 - x0) * (i / bumps)) * W;
      const yy = H * (0.962 + rng() * 0.012);
      g.lineTo(x, yy);
    }
    g.lineTo(x1 * W, H);
    g.closePath();
    g.fill();
  }
  // Leaves on the hedge top, catching the street light.
  for (let i = 0; i < 260; i++) {
    const right = rng() < 0.5;
    const x = (right ? 0.82 + rng() * 0.2 : rng() * 0.2) * W;
    const yy = H * (0.962 + rng() * 0.03);
    g.fillStyle = right ? 'rgba(70,82,60,0.25)' : 'rgba(46,56,44,0.22)';
    g.fillRect(x, yy, 2 * s, 1.4 * s);
  }
  void tex;
}

/* ------------------------------------------------------------------ *
 * Walls
 * ------------------------------------------------------------------ */

/**
 * Roughcast render.
 *
 * The wall this is a portrait of is pebbledashed, and that matters more than it
 * sounds: a flat fill reads as card, and every effect drawn on top of card
 * reads as a sticker. The relief texture is laid over the base colour with
 * 'overlay', so it shades whatever light is on the wall rather than painting
 * grey dots on it — and it is also an honest rehearsal, because a real
 * rendered wall scatters projected light in exactly this way.
 *
 * The base colour carries the light: colder and darker at the top under the
 * eaves, a little warmer towards the right where the street light is.
 */
function renderWall(g, clip, box, tint, tex, W, H, { warm = 0.12 } = {}) {
  g.save();
  g.clip(clip);
  const wash = g.createLinearGradient(0, box.y, 0, box.y + box.h);
  wash.addColorStop(0, tint.top);
  wash.addColorStop(1, tint.bottom);
  g.fillStyle = wash;
  g.fill(clip);

  // The street light, off to the right and below the eaves.
  const sl = g.createRadialGradient(W * 1.08, H * 0.78, 0, W * 1.08, H * 0.78, W * 0.75);
  sl.addColorStop(0, `rgba(255,196,140,${warm})`);
  sl.addColorStop(0.6, `rgba(255,196,140,${warm * 0.35})`);
  sl.addColorStop(1, 'rgba(255,196,140,0)');
  g.fillStyle = sl;
  g.fill(clip);

  g.globalCompositeOperation = 'overlay';
  g.drawImage(tex, 0, 0, W, H);
  g.restore();
}

/** Soft shadow band under a projecting edge, falling down the wall. */
function shadowBelow(g, x, y, w, depth, alpha = 0.5) {
  const grad = g.createLinearGradient(0, y, 0, y + depth);
  grad.addColorStop(0, `rgba(0,0,0,${alpha})`);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(x, y, w, depth);
}

/**
 * Brick, in running bond. Only two things on this house are brick — the door
 * reveal and the plinth under the bay — and both are worth painting properly,
 * because they are the reference the projected Brickwork is matched against.
 *
 * Each brick is shaded on its own: a slightly lighter top face, a darker
 * bottom edge where it overhangs the recessed joint, and its own tone, a few
 * of them over-burnt. Mortar is a step back and in shadow, which is what makes
 * a brick wall look laid rather than printed.
 */
function brickwork(g, rng, clip, box, base, course) {
  const brick = course * 3.1;
  const joint = Math.max(1, course * 0.12);
  g.save();
  g.clip(clip);
  g.fillStyle = '#16120f';
  g.fill(clip);
  for (let row = 0, cy = box.y; cy < box.y + box.h + course; row++, cy += course) {
    const offset = row % 2 ? -brick / 2 : 0;
    for (let cx = box.x + offset - brick; cx < box.x + box.w + brick; cx += brick) {
      const v = rng();
      const burnt = rng() < 0.12 ? 0.62 : 1;
      const r = (base[0] + v * 26 - 10) * burnt;
      const gr = (base[1] + v * 18 - 7) * burnt;
      const b = (base[2] + v * 14 - 5) * burnt;
      const x0 = cx + joint * 0.5;
      const y0 = cy + joint * 0.5;
      const bw = brick - joint;
      const bh = course - joint;
      g.fillStyle = `rgb(${r | 0},${gr | 0},${b | 0})`;
      g.fillRect(x0, y0, bw, bh);
      // Arris catching the light along the top, shadow along the bottom.
      g.fillStyle = 'rgba(255,220,190,0.09)';
      g.fillRect(x0, y0, bw, Math.max(1, bh * 0.16));
      g.fillStyle = 'rgba(0,0,0,0.28)';
      g.fillRect(x0, y0 + bh * 0.8, bw, bh * 0.2);
      // A little surface texture: a couple of pits per brick.
      g.fillStyle = 'rgba(0,0,0,0.18)';
      for (let k = 0; k < 2; k++) g.fillRect(x0 + rng() * bw, y0 + rng() * bh, 1.4, 1.2);
    }
  }
  g.restore();
}

/* ------------------------------------------------------------------ *
 * Roof, gutter, chimney
 * ------------------------------------------------------------------ */

/**
 * A clay tile roof, hipped.
 *
 * Drawn as courses of tiles rather than a flat slab, because the roof is the
 * largest single area in frame and a flat one drags the whole picture back
 * towards vector art. Each course overlaps the one below, so each casts a thin
 * shadow on it; courses shrink a little towards the ridge, because the slope
 * is leaning away from the camera; and the tiles weather unevenly, a few dark
 * and a few with lichen on them. The hip — the sloping end on the left — is
 * the reason the front eaves is horizontal, and it carries its own capping.
 */
function roof(g, rng, W, H) {
  const s = H / 900;
  const outline = new Path2D();
  outline.moveTo(L.rakeL * W, L.eaves * H);
  outline.lineTo(L.hip * W, L.ridge * H);
  outline.lineTo(W, L.ridge * H);
  outline.lineTo(W, (L.eaves + 0.006) * H);
  outline.lineTo(L.rakeL * W, (L.eaves + 0.006) * H);
  outline.closePath();

  g.save();
  g.clip(outline);
  g.fillStyle = '#1e0f0c';
  g.fill(outline);

  const top = L.ridge * H;
  const bottom = (L.eaves + 0.006) * H;
  const rows = 8;
  // Course depths shrinking geometrically towards the ridge.
  const ratio = 0.93;
  let sum = 0;
  for (let i = 0; i < rows; i++) sum += ratio ** i;
  let y1 = bottom;
  for (let i = 0; i < rows; i++) {
    const depth = ((bottom - top) * ratio ** i) / sum;
    const y0 = y1 - depth;
    const tileW = depth * 1.9;
    const shift = (i % 2) * tileW * 0.5 + rng() * tileW * 0.2;
    // Further up the slope reflects more of the sky: a touch lighter, cooler.
    const lift = i / rows;
    for (let x = -tileW + shift; x < W + tileW; x += tileW) {
      const v = rng();
      const dark = rng() < 0.08 ? 0.8 : 1;
      const r = (50 + v * 9 + lift * 6) * dark;
      const gg = (27 + v * 4 + lift * 5) * dark;
      const b = (25 + v * 3 + lift * 8) * dark;
      const tile = g.createLinearGradient(0, y0, 0, y1);
      tile.addColorStop(0, `rgb(${(r * 0.6) | 0},${(gg * 0.6) | 0},${(b * 0.66) | 0})`);
      tile.addColorStop(0.7, `rgb(${r | 0},${gg | 0},${b | 0})`);
      tile.addColorStop(1, `rgb(${(r * 1.1) | 0},${(gg * 1.06) | 0},${(b * 1.04) | 0})`);
      g.fillStyle = tile;
      g.fillRect(x, y0, tileW, depth);
      // The joint between neighbours: a hairline, not a mortar course.
      g.fillStyle = 'rgba(0,0,0,0.32)';
      g.fillRect(x, y0, Math.max(1, 0.8 * s), depth * 0.8);
      if (rng() < 0.06) {
        // Lichen: a dull grey-green smudge low on the tile.
        g.fillStyle = 'rgba(80,88,70,0.12)';
        g.beginPath();
        g.ellipse(x + tileW * (0.3 + rng() * 0.4), y0 + depth * 0.72, tileW * 0.3, depth * 0.14, 0, 0, Math.PI * 2);
        g.fill();
      }
    }
    // The course above overlaps this one: its leading edge throws a shadow.
    shadowBelow(g, 0, y0, W, depth * 0.45, 0.7);
    // And the leading edge of this course catches a little light.
    g.fillStyle = 'rgba(255,190,160,0.05)';
    g.fillRect(0, y1 - 1.2 * s, W, 1.2 * s);
    y1 = y0;
  }

  // Ridge tiles along the top, half-round, a highlight along the crown.
  const ridgeH = 9 * s;
  const rTop = top - ridgeH * 0.2;
  const ridge = g.createLinearGradient(0, rTop, 0, rTop + ridgeH);
  ridge.addColorStop(0, '#6a3a2c');
  ridge.addColorStop(0.35, '#4a2419');
  ridge.addColorStop(1, '#1f0e0a');
  g.fillStyle = ridge;
  g.fillRect(L.hip * W, rTop, W, ridgeH);
  for (let x = L.hip * W; x < W; x += 34 * s) {
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.fillRect(x, rTop, 1.2 * s, ridgeH);
  }
  g.restore();

  // Hip capping along the sloping edge, the same half-round tiles.
  g.save();
  g.lineCap = 'round';
  g.strokeStyle = '#3e1f16';
  g.lineWidth = 9 * s;
  g.beginPath();
  g.moveTo(L.rakeL * W + 6 * s, L.eaves * H - 1 * s);
  g.lineTo(L.hip * W, L.ridge * H + 1 * s);
  g.stroke();
  g.strokeStyle = 'rgba(160,96,74,0.35)';
  g.lineWidth = 2 * s;
  g.beginPath();
  g.moveTo(L.rakeL * W + 6 * s, L.eaves * H - 4 * s);
  g.lineTo(L.hip * W, L.ridge * H - 2 * s);
  g.stroke();
  g.restore();

  // Gutter: black half-round, with the sky caught along its lip.
  const gTop = (L.eaves - 0.001) * H;
  const gH = 0.009 * H;
  const gut = g.createLinearGradient(0, gTop, 0, gTop + gH);
  gut.addColorStop(0, '#5d6268');
  gut.addColorStop(0.18, '#23262b');
  gut.addColorStop(0.7, '#121418');
  gut.addColorStop(1, '#08090b');
  g.fillStyle = gut;
  g.fillRect((L.rakeL - 0.004) * W, gTop, W, gH);
  // Fascia board under it, white uPVC gone grey in the dark.
  const fTop = gTop + gH;
  const fH = 0.009 * H;
  const fascia = g.createLinearGradient(0, fTop, 0, fTop + fH);
  fascia.addColorStop(0, '#6f747b');
  fascia.addColorStop(1, '#53575d');
  g.fillStyle = fascia;
  g.fillRect(L.rakeL * W, fTop, W - L.rakeL * W, fH);
  // Its end, and the return of the gutter round the hip.
  g.fillStyle = '#0c0d10';
  g.fillRect((L.rakeL - 0.004) * W, gTop, 0.006 * W, gH * 1.2);
}

/**
 * The stack on the party wall: brick, with an oversailing course near the top,
 * a cement cap, two clay pots, and an aerial strapped to it — which every
 * house on a street like this still has, and which is the one silhouette that
 * says "a house" against the sky better than anything else.
 */
function chimney(g, rng, W, H) {
  const s = H / 900;
  const c = L.chimney;
  const x = c.x * W;
  const w = c.w * W;
  const top = c.top * H;
  const base = c.base * H;
  brickwork(
    g, rng,
    rectPath(c.x, c.top, c.w, c.base - c.top, W, H),
    { x, y: top, w, h: base - top },
    [70, 40, 32],
    H * 0.0125
  );
  // Light from the right; the left face of the stack falls into shadow.
  const shade = g.createLinearGradient(x, 0, x + w, 0);
  shade.addColorStop(0, 'rgba(0,0,0,0.45)');
  shade.addColorStop(0.5, 'rgba(0,0,0,0.12)');
  shade.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = shade;
  g.fillRect(x, top, w, base - top);
  // Oversailing course and the cement cap above it.
  g.fillStyle = '#3a2219';
  g.fillRect(x - 3 * s, top + 10 * s, w + 6 * s, 6 * s);
  shadowBelow(g, x, top + 16 * s, w, 8 * s, 0.5);
  const cap = g.createLinearGradient(0, top - 2 * s, 0, top + 6 * s);
  cap.addColorStop(0, '#5a5c60');
  cap.addColorStop(1, '#2c2e31');
  g.fillStyle = cap;
  g.fillRect(x - 2 * s, top - 2 * s, w + 4 * s, 8 * s);
  // Lead flashing where it meets the roof.
  g.fillStyle = '#2c2f33';
  g.fillRect(x - 2 * s, base - 5 * s, w + 4 * s, 6 * s);

  for (const u of [0.3, 0.7]) {
    const px = x + w * u;
    const potW = w * 0.2;
    const potH = 0.024 * H;
    const pot = g.createLinearGradient(px - potW, 0, px + potW, 0);
    pot.addColorStop(0, '#24130e');
    pot.addColorStop(0.6, '#5a3020');
    pot.addColorStop(1, '#3a1f15');
    g.fillStyle = pot;
    g.beginPath();
    g.moveTo(px - potW * 0.5, top - 1 * s);
    g.lineTo(px - potW * 0.38, top - potH);
    g.lineTo(px + potW * 0.38, top - potH);
    g.lineTo(px + potW * 0.5, top - 1 * s);
    g.closePath();
    g.fill();
    g.fillStyle = '#4a2a1d';
    g.fillRect(px - potW * 0.48, top - potH - 3 * s, potW * 0.96, 3.5 * s);
  }

  // The aerial: a pole up the side of the stack and a Yagi on top of it.
  g.save();
  g.strokeStyle = '#0a0c10';
  g.lineCap = 'round';
  g.lineWidth = 2.2 * s;
  const poleX = x + w + 4 * s;
  const poleTop = Math.max(5 * s, top - 0.03 * H);
  g.beginPath();
  g.moveTo(poleX, base - 0.06 * H);
  g.lineTo(poleX, poleTop);
  g.stroke();
  g.lineWidth = 1.6 * s;
  for (const yy of [base - 0.05 * H, top + 0.03 * H]) {
    g.beginPath();
    g.moveTo(poleX, yy);
    g.lineTo(x + w, yy);
    g.stroke();
  }
  const boomL = poleX - 0.03 * W;
  const boomR = poleX + 0.012 * W;
  g.beginPath();
  g.moveTo(boomL, poleTop + 2 * s);
  g.lineTo(boomR, poleTop + 2 * s);
  g.stroke();
  g.lineWidth = 1.2 * s;
  for (let i = 0; i < 8; i++) {
    const ex = boomL + (boomR - boomL) * (i / 7);
    const half = (i === 6 ? 12 : 7 - i * 0.4) * s;
    g.beginPath();
    g.moveTo(ex, poleTop + 2 * s - half);
    g.lineTo(ex, poleTop + 2 * s + half);
    g.stroke();
  }
  g.restore();
}

/* ------------------------------------------------------------------ *
 * Openings
 * ------------------------------------------------------------------ */

/**
 * A window: the opening, a reveal in shadow, a grey-white uPVC frame, glass
 * with the sky in it, and curtains — drawn, mostly, with somebody's light on
 * behind them.
 *
 * `lit` is how much of the room's light reaches the street: through the
 * curtain fabric, which glows, and through the gap where they do not quite
 * meet, which is the one properly bright thing in the window. Zero is a room
 * with nobody in it.
 */
function window_(g, rng, x, y, w, h, W, H, opts = {}) {
  const { cols = 2, rows = 1, lit = 0.35, hood = true, curtain = '#5a4a3a', gap = 0.5 } = opts;
  const s = H / 900;
  const px = x * W;
  const py = y * H;
  const pw = w * W;
  const ph = h * H;
  const frame = Math.max(2, pw * 0.045, ph * 0.05);

  // The reveal: the wall returns into the opening, and with the light from
  // above-right its top and left sides are in shadow.
  const rv = frame * 1.1;
  g.fillStyle = 'rgba(6,8,11,0.85)';
  g.fillRect(px - frame - rv * 0.4, py - frame - rv, pw + frame * 2 + rv * 0.4, rv);
  g.fillRect(px - frame - rv * 0.4, py - frame - rv, rv * 0.4, ph + frame * 2 + rv);

  // Glass, with the room behind it.
  const glass = g.createLinearGradient(0, py, 0, py + ph);
  glass.addColorStop(0, '#161d29');
  glass.addColorStop(1, '#090c11');
  g.fillStyle = glass;
  g.fillRect(px, py, pw, ph);

  // Curtains: two panels, folds as vertical stripes of light and shade, the
  // gap between them a little off-centre the way they are always left.
  const gapX = px + pw * (gap + (rng() - 0.5) * 0.12);
  const gapW = pw * (0.04 + rng() * 0.05);
  const c = hexToRgb(curtain);
  const warmth = 0.18 + lit * 0.9;
  for (const [x0, x1] of [[px, gapX - gapW / 2], [gapX + gapW / 2, px + pw]]) {
    if (x1 <= x0) continue;
    const folds = Math.max(3, Math.round((x1 - x0) / (14 * s)));
    const fold = g.createLinearGradient(x0, 0, x1, 0);
    for (let i = 0; i <= folds * 2; i++) {
      const k = i / (folds * 2);
      const light = i % 2 ? 0.55 : 1;
      const v = warmth * light;
      fold.addColorStop(k, `rgb(${Math.min(255, c.r * v + lit * 40) | 0},${Math.min(255, c.g * v + lit * 22) | 0},${Math.min(255, c.b * v * 0.8) | 0})`);
    }
    g.fillStyle = fold;
    g.globalAlpha = 0.55;
    g.fillRect(x0, py, x1 - x0, ph);
    g.globalAlpha = 1;
  }
  if (lit > 0) {
    // The gap: warm, and bright enough to bloom a little.
    const slit = g.createLinearGradient(gapX - gapW, 0, gapX + gapW, 0);
    slit.addColorStop(0, 'rgba(255,190,110,0)');
    slit.addColorStop(0.5, `rgba(255,198,120,${0.55 * lit})`);
    slit.addColorStop(1, 'rgba(255,190,110,0)');
    g.fillStyle = slit;
    g.fillRect(gapX - gapW, py, gapW * 2, ph);
    const room = g.createRadialGradient(gapX, py + ph * 0.6, 0, gapX, py + ph * 0.6, pw * 0.7);
    room.addColorStop(0, `rgba(240,170,96,${0.22 * lit})`);
    room.addColorStop(1, 'rgba(240,170,96,0)');
    g.fillStyle = room;
    g.fillRect(px, py, pw, ph);
  }

  // The sky reflected in the glass: a soft diagonal sheen, strongest up top.
  g.save();
  g.beginPath();
  g.rect(px, py, pw, ph);
  g.clip();
  const sheen = g.createLinearGradient(px, py, px + pw * 0.6, py + ph);
  sheen.addColorStop(0, 'rgba(120,140,180,0.16)');
  sheen.addColorStop(0.35, 'rgba(120,140,180,0.05)');
  sheen.addColorStop(0.5, 'rgba(120,140,180,0.10)');
  sheen.addColorStop(0.6, 'rgba(120,140,180,0.02)');
  sheen.addColorStop(1, 'rgba(120,140,180,0)');
  g.fillStyle = sheen;
  g.fillRect(px, py, pw, ph);
  g.restore();

  // Frame: grey, not white — white uPVC at night is the colour of the wall
  // it sits in, a shade lighter because it is smooth.
  const outer = g.createLinearGradient(0, py - frame, 0, py + ph + frame);
  outer.addColorStop(0, '#8a9098');
  outer.addColorStop(1, '#646970');
  g.fillStyle = outer;
  const bars = [];
  bars.push([px - frame, py - frame, pw + frame * 2, frame]);
  bars.push([px - frame, py + ph, pw + frame * 2, frame]);
  bars.push([px - frame, py - frame, frame, ph + frame * 2]);
  bars.push([px + pw, py - frame, frame, ph + frame * 2]);
  for (let ci = 1; ci < cols; ci++) bars.push([px + (pw / cols) * ci - frame * 0.4, py, frame * 0.8, ph]);
  for (let r = 1; r < rows; r++) bars.push([px, py + (ph / rows) * r - frame * 0.4, pw, frame * 0.8]);
  for (const [bx, by, bw, bh] of bars) g.fillRect(bx, by, bw, bh);
  // Bevels: a lit upper edge, a dark lower edge, and the bead against the glass.
  g.fillStyle = 'rgba(255,255,255,0.12)';
  for (const [bx, by, bw] of bars) g.fillRect(bx, by, bw, Math.max(1, frame * 0.18));
  g.fillStyle = 'rgba(0,0,0,0.28)';
  for (const [bx, by, bw, bh] of bars) g.fillRect(bx, by + bh - Math.max(1, frame * 0.2), bw, Math.max(1, frame * 0.2));
  g.strokeStyle = 'rgba(0,0,0,0.45)';
  g.lineWidth = Math.max(1, frame * 0.18);
  const paneW = pw / cols;
  const paneH = ph / rows;
  for (let ci = 0; ci < cols; ci++) {
    for (let r = 0; r < rows; r++) {
      const inset = frame * (ci === 0 ? 0 : 0.4);
      const insetR = frame * (ci === cols - 1 ? 0 : 0.4);
      const insetT = frame * (r === 0 ? 0 : 0.4);
      const insetB = frame * (r === rows - 1 ? 0 : 0.4);
      g.strokeRect(
        px + paneW * ci + inset, py + paneH * r + insetT,
        paneW - inset - insetR, paneH - insetT - insetB
      );
    }
  }

  // The sill: a concrete nosing proud of the wall, sky on its top, shadow under.
  const sillY = py + ph + frame;
  const sillX = px - frame * 2.2;
  const sillW = pw + frame * 4.4;
  const sillH = Math.max(3 * s, frame * 1.3);
  g.fillStyle = '#585b61';
  g.fillRect(sillX, sillY, sillW, sillH * 0.35);
  g.fillStyle = '#303338';
  g.fillRect(sillX, sillY + sillH * 0.35, sillW, sillH * 0.65);
  shadowBelow(g, sillX + 2 * s, sillY + sillH, sillW, sillH * 2.2, 0.5);
  // Rain stain run off the ends of the sill over the years.
  for (const ex of [sillX + sillW * 0.08, sillX + sillW * 0.92]) {
    const stain = g.createLinearGradient(0, sillY + sillH, 0, sillY + sillH + ph * 0.6);
    stain.addColorStop(0, 'rgba(0,0,0,0.16)');
    stain.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = stain;
    g.fillRect(ex - frame * 0.8, sillY + sillH, frame * 1.6, ph * 0.6);
  }

  if (hood) {
    // The dark tiled hood over every opening on this house: a slim projecting
    // band, its top catching the sky and a soft shadow on the frame below.
    const hx = px - frame * 2.4;
    const hw = pw + frame * 4.8;
    const hy = py - frame * 3.4;
    const hh = frame * 1.7;
    const band = g.createLinearGradient(0, hy, 0, hy + hh);
    band.addColorStop(0, '#454a52');
    band.addColorStop(0.25, '#1a1d22');
    band.addColorStop(1, '#0e1013');
    g.fillStyle = band;
    g.fillRect(hx, hy, hw, hh);
    shadowBelow(g, hx + 3 * s, hy + hh, hw - 3 * s, frame * 2.6, 0.55);
  }
}

/** The square bay: three lights, its own flat roof, brick plinth beneath. */
function bay(g, rng, W, H) {
  const s = H / 900;
  const b = L.bay;
  const bx = (b.x - 0.008) * W;
  const bw = (b.w + 0.016) * W;
  const by = (b.y - 0.026) * H;
  const bh = 0.020 * H;

  // The bay stands proud of the wall; with the light from the right it throws
  // a long soft shadow back across the render on its left.
  const shade = g.createLinearGradient(bx - 0.035 * W, 0, bx, 0);
  shade.addColorStop(0, 'rgba(0,0,0,0)');
  shade.addColorStop(1, 'rgba(0,0,0,0.42)');
  g.fillStyle = shade;
  g.fillRect(bx - 0.035 * W, by, 0.035 * W, L.ground * H - by);

  window_(g, rng, b.x, b.y, b.w, b.h, W, H, { cols: 3, rows: 1, lit: 0.55, hood: false, curtain: '#6a4a3c', gap: 0.52 });

  // Its flat roof: lead flashing catching the sky, a deep fascia, and the
  // overhang's shadow on the window heads.
  g.fillStyle = '#5b5f66';
  g.fillRect(bx - 2 * s, by - 3 * s, bw + 4 * s, 4 * s);
  const fascia = g.createLinearGradient(0, by, 0, by + bh);
  fascia.addColorStop(0, '#24272c');
  fascia.addColorStop(1, '#14161a');
  g.fillStyle = fascia;
  g.fillRect(bx, by, bw, bh);
  g.fillStyle = 'rgba(255,255,255,0.06)';
  g.fillRect(bx, by, bw, 1.5 * s);
  shadowBelow(g, bx, by + bh, bw, 0.02 * H, 0.6);

  brickwork(
    g, rng,
    rectPath(b.x - 0.006, b.y + b.h, b.w + 0.012, L.ground - (b.y + b.h), W, H),
    { x: (b.x - 0.006) * W, y: (b.y + b.h) * H, w: (b.w + 0.012) * W, h: (L.ground - (b.y + b.h)) * H },
    [96, 52, 38],
    H * 0.0165
  );
  // The sill sits on the brick, so its shadow falls on the brick too.
  shadowBelow(g, (b.x - 0.006) * W, (b.y + b.h) * H + 12 * s, (b.w + 0.012) * W, 10 * s, 0.4);
}

/**
 * The porch lamp, which is the one thing on this facade that emits.
 *
 * A lantern on a bracket, its glass warm, and the light it lays on the wall
 * around it — which is most of what a lamp looks like at night, and which the
 * old version drew as a soft disc floating in front of the house.
 */
function lamp(g, W, H) {
  const s = H / 900;
  const lx = (L.surround.x - 0.016) * W;
  const ly = (L.surround.top + 0.02) * H;

  // Wall wash: brightest just above and below, scalloped by the lantern's cap.
  const wash = g.createRadialGradient(lx, ly + 6 * s, 0, lx, ly + 6 * s, 0.11 * W);
  wash.addColorStop(0, 'rgba(255,200,140,0.42)');
  wash.addColorStop(0.2, 'rgba(255,190,130,0.20)');
  wash.addColorStop(0.5, 'rgba(255,190,130,0.06)');
  wash.addColorStop(1, 'rgba(255,190,130,0)');
  g.save();
  g.globalCompositeOperation = 'screen';
  g.fillStyle = wash;
  g.fillRect(lx - 0.12 * W, ly - 0.12 * W, 0.24 * W, 0.24 * W);
  g.restore();

  // Bracket and lantern.
  g.fillStyle = '#0b0c0e';
  g.fillRect(lx - 1.5 * s, ly - 16 * s, 3 * s, 8 * s);
  g.fillRect(lx - 5 * s, ly - 16 * s, 10 * s, 3 * s);
  const lw = 15 * s;
  const lh = 20 * s;
  g.beginPath();
  g.moveTo(lx - lw * 0.62, ly - lh * 0.5);
  g.lineTo(lx, ly - lh * 0.82);
  g.lineTo(lx + lw * 0.62, ly - lh * 0.5);
  g.closePath();
  g.fill();
  const glassG = g.createLinearGradient(0, ly - lh * 0.5, 0, ly + lh * 0.5);
  glassG.addColorStop(0, '#ffe6b8');
  glassG.addColorStop(1, '#e09a4c');
  g.fillStyle = glassG;
  g.fillRect(lx - lw * 0.42, ly - lh * 0.48, lw * 0.84, lh * 0.9);
  g.fillStyle = '#0b0c0e';
  g.fillRect(lx - 1 * s, ly - lh * 0.48, 2 * s, lh * 0.9);
  g.fillRect(lx - lw * 0.5, ly + lh * 0.42, lw, 3 * s);
  // Halo in the air around it — small, because the air is clear.
  const halo = g.createRadialGradient(lx, ly, 0, lx, ly, 26 * s);
  halo.addColorStop(0, 'rgba(255,214,160,0.5)');
  halo.addColorStop(1, 'rgba(255,214,160,0)');
  g.save();
  g.globalCompositeOperation = 'screen';
  g.fillStyle = halo;
  g.fillRect(lx - 26 * s, ly - 26 * s, 52 * s, 52 * s);
  g.restore();
}

/** Yellow front door in a brick reveal, six panes of obscured glass on top. */
function door(g, rng, W, H) {
  const s = H / 900;
  const sur = L.surround;
  brickwork(
    g, rng,
    rectPath(sur.x, sur.top, sur.w, L.ground - sur.top, W, H),
    { x: sur.x * W, y: sur.top * H, w: sur.w * W, h: (L.ground - sur.top) * H },
    [104, 56, 40],
    H * 0.0165
  );
  // A soldier course over the reveal, and a shadow down its left return.
  const sx = sur.x * W;
  const sw = sur.w * W;
  const sy = sur.top * H;
  for (let i = 0; i < 14; i++) {
    const v = rng();
    g.fillStyle = `rgb(${(92 + v * 24) | 0},${(48 + v * 14) | 0},${(34 + v * 10) | 0})`;
    g.fillRect(sx + (sw / 14) * i + 0.8 * s, sy - 0.024 * H, sw / 14 - 1.6 * s, 0.024 * H - 1 * s);
  }
  shadowBelow(g, sx, sy, sw, 6 * s, 0.35);

  const d = L.door;
  const px = d.x * W;
  const py = d.top * H;
  const pw = d.w * W;
  const ph = (L.ground - d.top) * H;

  // The door sits back in the reveal: a deep shadow on the left and top.
  g.fillStyle = '#0a0806';
  g.fillRect(px - 7 * s, py - 6 * s, pw + 10 * s, ph + 6 * s);

  const paint = g.createLinearGradient(px, py, px + pw, py + ph);
  paint.addColorStop(0, '#9a7522');
  paint.addColorStop(1, '#5e4410');
  g.fillStyle = paint;
  g.fillRect(px, py, pw, ph);
  // The lamp is up and to the left, so the door is lit from there.
  const lampLight = g.createRadialGradient(px - pw * 0.4, py - ph * 0.05, 0, px - pw * 0.4, py - ph * 0.05, ph * 0.9);
  lampLight.addColorStop(0, 'rgba(255,200,120,0.22)');
  lampLight.addColorStop(1, 'rgba(255,200,120,0)');
  g.fillStyle = lampLight;
  g.fillRect(px, py, pw, ph);

  // Six panes, top third, with the hall light behind the obscured glass.
  const gx = px + pw * 0.14;
  const gy = py + ph * 0.07;
  const gw = pw * 0.72;
  const gh = ph * 0.26;
  const hall = g.createRadialGradient(gx + gw * 0.5, gy + gh * 0.6, 0, gx + gw * 0.5, gy + gh * 0.6, gw * 0.8);
  hall.addColorStop(0, '#f4cf8a');
  hall.addColorStop(1, '#a8803e');
  g.fillStyle = hall;
  g.fillRect(gx, gy, gw, gh);
  // Obscured glass: a reeded texture, faint vertical streaks.
  for (let i = 0; i < 26; i++) {
    g.fillStyle = i % 2 ? 'rgba(255,255,255,0.06)' : 'rgba(80,50,10,0.08)';
    g.fillRect(gx + (gw / 26) * i, gy, gw / 26, gh);
  }
  g.strokeStyle = '#7d5e1a';
  g.lineWidth = Math.max(1.5, pw * 0.04);
  g.beginPath();
  g.moveTo(gx + gw / 2, gy);
  g.lineTo(gx + gw / 2, gy + gh);
  for (let r = 1; r < 3; r++) {
    g.moveTo(gx, gy + (gh / 3) * r);
    g.lineTo(gx + gw, gy + (gh / 3) * r);
  }
  g.stroke();
  g.strokeRect(gx, gy, gw, gh);

  // Four raised panels below: lit upper-left bevel, dark lower-right.
  const bevel = Math.max(1.5, pw * 0.025);
  for (let r = 0; r < 2; r++) {
    for (let ci = 0; ci < 2; ci++) {
      const x0 = px + pw * (0.14 + ci * 0.42);
      const y0 = py + ph * (0.44 + r * 0.26);
      const w0 = pw * 0.30;
      const h0 = ph * 0.20;
      g.fillStyle = 'rgba(255,230,160,0.14)';
      g.fillRect(x0, y0, w0, bevel);
      g.fillRect(x0, y0, bevel, h0);
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(x0, y0 + h0 - bevel, w0, bevel);
      g.fillRect(x0 + w0 - bevel, y0, bevel, h0);
    }
  }
  // Letterbox, knocker and handle: brass, catching the lamp.
  g.fillStyle = '#2a2013';
  g.fillRect(px + pw * 0.28, py + ph * 0.375, pw * 0.44, ph * 0.028);
  g.fillStyle = 'rgba(255,214,140,0.55)';
  g.fillRect(px + pw * 0.28, py + ph * 0.375, pw * 0.44, Math.max(1, ph * 0.006));
  g.fillStyle = '#c8a050';
  g.beginPath();
  g.arc(px + pw * 0.86, py + ph * 0.52, Math.max(2, pw * 0.035), 0, Math.PI * 2);
  g.fill();
  g.fillStyle = 'rgba(255,240,200,0.8)';
  g.beginPath();
  g.arc(px + pw * 0.855, py + ph * 0.515, Math.max(1, pw * 0.012), 0, Math.PI * 2);
  g.fill();
}

/* ------------------------------------------------------------------ *
 * The rest of the frame
 * ------------------------------------------------------------------ */

/** The flat-roofed store on the side, and its open doorway. */
function store(g, rng, W, H, tex) {
  const s = H / 900;
  const st = L.store;
  renderWall(
    g,
    rectPath(st.x, st.roof, st.w, st.ground - st.roof, W, H),
    { x: st.x * W, y: st.roof * H, w: st.w * W, h: (st.ground - st.roof) * H },
    { top: '#2f333a', bottom: '#24272c' },
    tex, W, H, { warm: 0.05 }
  );
  // Flat roof: felt, with an aluminium drip trim catching the sky.
  const rx = (st.x - 0.008) * W;
  const rw = (st.w + 0.016) * W;
  const ry = (st.roof - 0.018) * H;
  const rh = 0.020 * H;
  g.fillStyle = '#121418';
  g.fillRect(rx, ry, rw, rh);
  g.fillStyle = '#5c6066';
  g.fillRect(rx, ry, rw, 2 * s);
  g.fillStyle = 'rgba(255,255,255,0.05)';
  g.fillRect(rx, ry + rh * 0.4, rw, 1 * s);
  shadowBelow(g, st.x * W, st.roof * H + 2 * s, st.w * W, 0.035 * H, 0.5);
  // Where it meets the house there is an inside corner, and it is dark.
  const corner = g.createLinearGradient((st.x + st.w - 0.03) * W, 0, (st.x + st.w) * W, 0);
  corner.addColorStop(0, 'rgba(0,0,0,0)');
  corner.addColorStop(1, 'rgba(0,0,0,0.4)');
  g.fillStyle = corner;
  g.fillRect((st.x + st.w - 0.03) * W, st.roof * H, 0.03 * W, (st.ground - st.roof) * H);

  const foot = g.createLinearGradient(0, (st.ground - 0.07) * H, 0, st.ground * H);
  foot.addColorStop(0, 'rgba(0,0,0,0)');
  foot.addColorStop(1, 'rgba(0,0,0,0.45)');
  g.fillStyle = foot;
  g.fillRect(st.x * W, (st.ground - 0.07) * H, st.w * W, 0.07 * H);

  // The doorway: a timber frame, the door swung in against the inside wall,
  // and the dark of the store behind it, a little lighter at the floor where
  // the street light reaches in.
  const d = L.storeDoor;
  const dx = d.x * W;
  const dy = d.y * H;
  const dw = d.w * W;
  const dh = d.h * H;
  const inside = g.createLinearGradient(0, dy, 0, dy + dh);
  inside.addColorStop(0, '#030304');
  inside.addColorStop(0.75, '#08090b');
  inside.addColorStop(1, '#141517');
  g.fillStyle = inside;
  g.fillRect(dx, dy, dw, dh);
  g.fillStyle = '#1d1a16';
  g.fillRect(dx + dw * 0.04, dy + dh * 0.02, dw * 0.16, dh * 0.98);
  for (let i = 0; i < 3; i++) {
    g.fillStyle = 'rgba(0,0,0,0.5)';
    g.fillRect(dx + dw * (0.06 + i * 0.05), dy + dh * 0.02, 1 * s, dh * 0.98);
  }
  g.strokeStyle = '#2c2a27';
  g.lineWidth = 4 * s;
  g.beginPath();
  g.moveTo(dx, dy + dh);
  g.lineTo(dx, dy);
  g.lineTo(dx + dw, dy);
  g.lineTo(dx + dw, dy + dh);
  g.stroke();
  g.fillStyle = 'rgba(0,0,0,0.6)';
  g.fillRect(dx, dy, dw, 5 * s);

  window_(g, rng, L.storeWindow.x, L.storeWindow.y, L.storeWindow.w, L.storeWindow.h, W, H,
    { cols: 1, rows: 2, lit: 0, curtain: '#3a3632' });
}

/**
 * The pot on the wall beside the door.
 *
 * Painted dark and small, because that is what one looks like at night: a
 * bracket, a bowl, and whatever is in it reduced to a silhouette. It matters
 * that it is barely visible — the traced `planter` shape is deliberately much
 * larger than the pot, because what you are marking is not the pot but the
 * space above it that a plant will occupy.
 */
function planter(g, rng, W, H) {
  const s = H / 900;
  const pot = L.planter;
  const cx = (pot.x + pot.w * 0.5) * W;
  const lip = (pot.y + pot.h) * H;
  const potW = pot.w * 0.78 * W;
  const potH = pot.h * 0.3 * H;

  // Bracket: two arms back to the wall, which is what stops it floating.
  g.strokeStyle = '#0d0e10';
  g.lineWidth = Math.max(1.5, W * 0.0014);
  g.beginPath();
  g.moveTo(cx - potW * 0.42, lip);
  g.lineTo(cx - potW * 0.3, lip + potH * 0.7);
  g.moveTo(cx + potW * 0.42, lip);
  g.lineTo(cx + potW * 0.3, lip + potH * 0.7);
  g.stroke();
  shadowBelow(g, cx - potW * 0.45, lip + potH * 0.6, potW * 0.95, potH * 0.6, 0.35);

  // The bowl, tapered, lit from the lamp on its right shoulder.
  const body = g.createLinearGradient(cx - potW * 0.5, 0, cx + potW * 0.5, 0);
  body.addColorStop(0, '#1d2024');
  body.addColorStop(0.7, '#3a3e45');
  body.addColorStop(1, '#2a2d32');
  g.fillStyle = body;
  g.beginPath();
  g.moveTo(cx - potW * 0.5, lip - potH * 0.35);
  g.lineTo(cx + potW * 0.5, lip - potH * 0.35);
  g.lineTo(cx + potW * 0.34, lip + potH * 0.65);
  g.lineTo(cx - potW * 0.34, lip + potH * 0.65);
  g.closePath();
  g.fill();
  g.fillStyle = '#50555d';
  g.fillRect(cx - potW * 0.54, lip - potH * 0.45, potW * 1.08, potH * 0.14);
  g.fillStyle = 'rgba(255,220,170,0.18)';
  g.fillRect(cx - potW * 0.54, lip - potH * 0.45, potW * 1.08, 1.2 * s);

  // Something already growing in it, as a dark clump of leaves. The Flowers
  // effect draws over this, and having *something* there stops the pot
  // reading as empty in the daylight photograph somebody traces against.
  for (let i = 0; i < 22; i++) {
    const u = rng();
    const lx = cx + (u - 0.5) * potW * 0.9;
    const ly = lip - potH * 0.4 - rng() * potH * 1.1;
    const r = potW * (0.07 + rng() * 0.06);
    g.fillStyle = rng() < 0.3 ? '#2a3a2a' : '#162017';
    g.beginPath();
    g.ellipse(lx, ly, r, r * 0.6, (rng() - 0.5) * 1.6, 0, Math.PI * 2);
    g.fill();
  }
}

/** A cast-iron downpipe from the gutter to the ground, at the corner. */
function downpipe(g, x, W, H) {
  const s = H / 900;
  const px = x * W;
  const top = (L.eaves + 0.012) * H;
  const bottom = L.ground * H;
  const pw = 7 * s;
  const pipe = g.createLinearGradient(px - pw / 2, 0, px + pw / 2, 0);
  pipe.addColorStop(0, '#08090b');
  pipe.addColorStop(0.65, '#1a1c20');
  pipe.addColorStop(0.8, '#3a3e44');
  pipe.addColorStop(1, '#101114');
  g.fillStyle = pipe;
  g.fillRect(px - pw / 2, top, pw, bottom - top);
  // Brackets, and the shoe at the bottom.
  for (let y = top + 0.08 * H; y < bottom - 0.02 * H; y += 0.16 * H) {
    g.fillStyle = '#121316';
    g.fillRect(px - pw * 0.8, y, pw * 1.6, 4 * s);
  }
  g.fillStyle = '#111215';
  g.fillRect(px - pw * 0.6, bottom - 8 * s, pw * 1.6, 8 * s);
  // Its shadow on the wall, off to the left.
  g.fillStyle = 'rgba(0,0,0,0.3)';
  g.fillRect(px - pw * 1.6, top, pw * 0.9, bottom - top);
}

/**
 * The neighbour's half, past the party wall. Never lit; that is the point.
 *
 * They are in, though: a lamp on upstairs behind a blind, and the television
 * going in the front room, which is a cold flickering blue that nothing on
 * your side of the wall should ever match.
 */
function neighbour(g, rng, W, H, tex) {
  renderWall(
    g,
    rectPath(L.wallR, L.eaves, 1.02 - L.wallR, L.ground - L.eaves, W, H),
    { x: L.wallR * W, y: L.eaves * H, w: (1.02 - L.wallR) * W, h: (L.ground - L.eaves) * H },
    { top: '#2c3037', bottom: '#2a2d33' },
    tex, W, H, { warm: 0.16 }
  );
  shadowBelow(g, L.wallR * W, (L.eaves + 0.018) * H, (1.02 - L.wallR) * W, 0.06 * H, 0.55);
  window_(g, rng, 0.845, 0.296, 0.125, 0.126, W, H, { cols: 3, rows: 1, lit: 0.45, curtain: '#7a6a58', gap: 0.3 });
  window_(g, rng, 0.845, 0.607, 0.140, 0.183, W, H, { cols: 3, rows: 1, lit: 0.2, curtain: '#3d4a5a', gap: 0.6 });
  // The television: cold, on the back wall, through the gap.
  const tvX = (0.845 + 0.140 * 0.6) * W;
  const tvY = (0.607 + 0.183 * 0.55) * H;
  const tv = g.createRadialGradient(tvX, tvY, 0, tvX, tvY, 0.06 * W);
  tv.addColorStop(0, 'rgba(120,160,255,0.22)');
  tv.addColorStop(1, 'rgba(120,160,255,0)');
  g.fillStyle = tv;
  g.fillRect(0.845 * W, 0.607 * H, 0.140 * W, 0.183 * H);
  // A hint of the party wall, so it is obvious where your half stops.
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.fillRect(L.wallR * W, L.eaves * H, W * 0.0035, (L.ground - L.eaves) * H);
}

/** Ambient occlusion and the soffit: the light the eaves and the ground keep off the wall. */
function occlusion(g, W, H) {
  // Under the eaves, all the way across both halves.
  shadowBelow(g, L.wallL * W, (L.eaves + 0.018) * H, (L.wallR - L.wallL) * W, 0.07 * H, 0.6);
  // The foot of every wall, where it meets the ground.
  const foot = g.createLinearGradient(0, (L.ground - 0.06) * H, 0, L.ground * H);
  foot.addColorStop(0, 'rgba(0,0,0,0)');
  foot.addColorStop(1, 'rgba(0,0,0,0.35)');
  g.fillStyle = foot;
  g.fillRect(L.wallL * W, (L.ground - 0.06) * H, W, 0.06 * H);
  // The corner of the house: the side wall is turned away from every light.
  const corner = g.createLinearGradient(L.wallL * W, 0, (L.wallL + 0.02) * W, 0);
  corner.addColorStop(0, 'rgba(0,0,0,0.35)');
  corner.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = corner;
  g.fillRect(L.wallL * W, L.eaves * H, 0.02 * W, (L.store.roof - L.eaves) * H);
}

/** Photographic grain and a vignette, so it reads as a picture and not as vector art. */
function finish(g, rng, W, H) {
  // Atmosphere: the faintest veil of street light in the air on the right.
  const air = g.createRadialGradient(W * 1.05, H * 0.75, 0, W * 1.05, H * 0.75, W * 0.6);
  air.addColorStop(0, 'rgba(150,120,90,0.10)');
  air.addColorStop(1, 'rgba(150,120,90,0)');
  g.save();
  g.globalCompositeOperation = 'screen';
  g.fillStyle = air;
  g.fillRect(0, 0, W, H);
  g.restore();

  const grains = Math.round((W * H) / 600);
  for (let i = 0; i < grains; i++) {
    const v = rng();
    g.fillStyle = v > 0.5 ? 'rgba(255,255,255,0.022)' : 'rgba(0,0,0,0.045)';
    g.fillRect(rng() * W, rng() * H, 1.4, 1.4);
  }
  const vig = g.createRadialGradient(W * 0.5, H * 0.5, H * 0.28, W * 0.5, H * 0.5, W * 0.72);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.6)');
  g.fillStyle = vig;
  g.fillRect(0, 0, W, H);
}

/** Paint the demo facade into a fresh canvas. Deterministic — same house every time. */
export function renderDemoFacade(W = 1600, H = Math.round(1600 / DEMO_ASPECT)) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  const rng = makeRng('demo-house-semi');
  const tex = reliefTexture(W, H, makeRng('demo-house-render'), {});

  sky(g, rng, W, H);
  tree(g, rng, W, H);
  wires(g, W, H);
  garden(g, rng, W, H, tex);
  roof(g, rng, W, H);
  neighbour(g, rng, W, H, tex);
  store(g, rng, W, H, tex);

  renderWall(
    g,
    rectPath(L.wallL, L.eaves, L.wallR - L.wallL, L.ground - L.eaves, W, H),
    { x: L.wallL * W, y: L.eaves * H, w: (L.wallR - L.wallL) * W, h: (L.ground - L.eaves) * H },
    { top: '#2b313c', bottom: '#30333a' },
    tex, W, H, { warm: 0.13 }
  );
  occlusion(g, W, H);

  chimney(g, rng, W, H);
  downpipe(g, L.wallL + 0.008, W, H);
  for (const w of L.upper) {
    window_(g, rng, w.x, w.y, w.w, w.h, W, H, {
      cols: w.cols, rows: w.rows, lit: w.cols === 1 ? 0.5 : 0.3,
      curtain: w.cols === 1 ? '#6b5a48' : '#4a3f5a', gap: w.cols === 1 ? 0.5 : 0.62,
    });
  }
  bay(g, rng, W, H);
  door(g, rng, W, H);
  lamp(g, W, H);
  planter(g, rng, W, H);
  finish(g, rng, W, H);

  return canvas;
}

/** The facade as a JPEG blob, ready for the same store a captured still uses. */
export function demoFacadeBlob() {
  const canvas = renderDemoFacade();
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.82);
  });
}
