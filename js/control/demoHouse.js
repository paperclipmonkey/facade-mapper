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

import { makeRng } from '../core/math.js';
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
 * ------------------------------------------------------------------ */

/** Turn a list of normalised points into a Path2D in canvas pixels. */
function polyPath(points, W, H) {
  const p = new Path2D();
  p.moveTo(points[0].x * W, points[0].y * H);
  for (let i = 1; i < points.length; i++) p.lineTo(points[i].x * W, points[i].y * H);
  p.closePath();
  return p;
}

function skyAndGround(g, rng, W, H) {
  const sky = g.createLinearGradient(0, 0, 0, L.ground * H);
  sky.addColorStop(0, '#05070f');
  sky.addColorStop(0.62, '#0b1226');
  sky.addColorStop(1, '#1b2036');
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);

  // Sodium haze from the streetlight that is always just out of shot.
  const haze = g.createRadialGradient(W * 0.94, H * 0.82, 0, W * 0.94, H * 0.82, W * 0.42);
  haze.addColorStop(0, 'rgba(120,86,40,0.30)');
  haze.addColorStop(1, 'rgba(120,86,40,0)');
  g.fillStyle = haze;
  g.fillRect(0, 0, W, H);

  // Overhead lines. Every street like this has them, they cross the sky at an
  // angle, and they are a fair test of whether an effect aimed at the roofline
  // is actually following the roofline.
  g.strokeStyle = 'rgba(150,160,185,0.30)';
  g.lineWidth = Math.max(1, H * 0.0018);
  for (const [y0, y1] of [[0.055, 0.115], [0.10, 0.02]]) {
    g.beginPath();
    g.moveTo(0, y0 * H);
    g.quadraticCurveTo(W * 0.5, (y0 + y1) * 0.5 * H + H * 0.02, W, y1 * H);
    g.stroke();
  }

  g.fillStyle = '#0a1109';
  g.fillRect(0, L.ground * H, W, H - L.ground * H);

  // Brick-paved path in front of the door, which is what the photo has and
  // what a motion trigger wants to be pointed at.
  const path = polyPath([
    { x: L.door.x - 0.02, y: L.ground },
    { x: L.bay.x + L.bay.w, y: L.ground },
    { x: 0.80, y: 1.0 },
    { x: 0.22, y: 1.0 },
  ], W, H);
  g.save();
  g.clip(path);
  g.fillStyle = '#1d1a18';
  g.fill(path);
  g.strokeStyle = 'rgba(0,0,0,0.45)';
  g.lineWidth = Math.max(1, H * 0.0022);
  for (let i = 0; i <= 14; i++) {
    const y = (L.ground + (i / 14) * (1 - L.ground)) * H;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(W, y);
    g.stroke();
    const step = W * 0.035;
    for (let x = (i % 2 ? step / 2 : 0); x < W; x += step) {
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + (rng() - 0.5) * 4, y + (1 - L.ground) * H / 14);
      g.stroke();
    }
  }
  g.restore();
}

/**
 * Roughcast render.
 *
 * The wall this is a portrait of is pebbledashed, and that matters more than it
 * sounds: a flat fill reads as card, and every effect drawn on top of card
 * reads as a sticker. A dense stipple at low contrast is enough to make the eye
 * accept it as a surface, and it is also an honest rehearsal — a real rendered
 * wall scatters projected light in exactly this way.
 */
function render_(g, rng, clip, box, tint) {
  g.save();
  g.clip(clip);
  const wash = g.createLinearGradient(0, box.y, 0, box.y + box.h);
  wash.addColorStop(0, tint.top);
  wash.addColorStop(1, tint.bottom);
  g.fillStyle = wash;
  g.fill(clip);

  const grains = Math.round((box.w * box.h) / 90);
  for (let i = 0; i < grains; i++) {
    const v = rng();
    g.fillStyle = v > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)';
    g.fillRect(box.x + rng() * box.w, box.y + rng() * box.h, 1.6, 1.6);
  }
  g.restore();
}

/**
 * Brick, in running bond. Only two things on this house are brick — the door
 * reveal and the plinth under the bay — and both are worth painting properly,
 * because they are the reference the projected Brickwork is matched against.
 */
function brickwork(g, rng, clip, box, base, course) {
  const brick = course * 3.1;
  g.save();
  g.clip(clip);
  g.fillStyle = '#171310';
  g.fill(clip);
  for (let row = 0, cy = box.y; cy < box.y + box.h + course; row++, cy += course) {
    const offset = row % 2 ? -brick / 2 : 0;
    for (let cx = box.x + offset - brick; cx < box.x + box.w + brick; cx += brick) {
      const v = rng();
      g.fillStyle = `rgb(${(base[0] + v * 26 - 10) | 0},${(base[1] + v * 18 - 7) | 0},${(base[2] + v * 14 - 5) | 0})`;
      g.fillRect(cx + 1, cy + 1, brick - 2, course - 2);
    }
  }
  g.restore();
}

/**
 * A clay pantile roof, hipped.
 *
 * Drawn as courses of rounded tile ends rather than a flat slab, because the
 * roof is the largest single area in frame and a flat one drags the whole
 * picture back towards vector art. The hip — the sloping end on the left — is
 * the reason the front eaves is horizontal, and the reason this is not the same
 * shape as the old gabled demo.
 */
function roof(g, rng, W, H) {
  const topAt = (x) => {
    if (x >= L.hip) return L.ridge;
    const u = (x - L.rakeL) / (L.hip - L.rakeL);
    return L.eaves + (L.ridge - L.eaves) * Math.max(0, u);
  };

  const outline = new Path2D();
  outline.moveTo(L.rakeL * W, L.eaves * H);
  outline.lineTo(L.hip * W, L.ridge * H);
  outline.lineTo(W, L.ridge * H);
  outline.lineTo(W, (L.eaves + 0.006) * H);
  outline.lineTo(L.rakeL * W, (L.eaves + 0.006) * H);
  outline.closePath();

  g.save();
  g.clip(outline);
  const clay = g.createLinearGradient(0, L.ridge * H, 0, L.eaves * H);
  clay.addColorStop(0, '#2a1410');
  clay.addColorStop(1, '#4a1f16');
  g.fillStyle = clay;
  g.fill(outline);

  const course = (L.eaves - L.ridge) * H / 5.5;
  const tileW = course * 1.5;
  for (let row = 0, cy = L.ridge * H; cy < L.eaves * H + course; row++, cy += course) {
    for (let cx = -tileW; cx < W + tileW; cx += tileW) {
      const v = rng();
      g.fillStyle = `rgb(${(76 + v * 34) | 0},${(34 + v * 16) | 0},${(25 + v * 12) | 0})`;
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + tileW - 1.5, cy);
      g.lineTo(cx + tileW - 1.5, cy + course * 0.72);
      // The roll along the bottom edge that makes a pantile a pantile.
      g.quadraticCurveTo(cx + tileW * 0.5, cy + course * 1.05, cx, cy + course * 0.72);
      g.closePath();
      g.fill();
    }
  }
  // Ridge tiles.
  g.fillStyle = '#3a1a13';
  g.fillRect(L.hip * W, L.ridge * H, W - L.hip * W, course * 0.32);
  g.restore();

  // Fascia and gutter along the front, which is what the traced roofline is.
  g.fillStyle = '#cfd3d6';
  g.fillRect(L.rakeL * W, L.eaves * H, W - L.rakeL * W, H * 0.010);
  g.fillStyle = '#15181b';
  g.fillRect(L.rakeL * W, (L.eaves + 0.010) * H, W - L.rakeL * W, H * 0.007);
  return topAt;
}

/**
 * A window: white uPVC frame, dark glass, and a warm sliver of somebody's
 * hallway light where the curtains do not quite meet.
 */
function window_(g, rng, x, y, w, h, W, H, { cols = 2, rows = 1, lit = 0.35 } = {}) {
  const px = x * W;
  const py = y * H;
  const pw = w * W;
  const ph = h * H;
  const frame = Math.max(2, pw * 0.045);

  g.fillStyle = '#0d0f12';
  g.fillRect(px - frame * 0.6, py - frame * 0.6, pw + frame * 1.2, ph + frame * 1.2);

  const glass = g.createLinearGradient(px, py, px + pw * 0.4, py + ph);
  glass.addColorStop(0, '#141a22');
  glass.addColorStop(1, '#0a0d12');
  g.fillStyle = glass;
  g.fillRect(px, py, pw, ph);

  if (lit > 0) {
    const warm = g.createRadialGradient(px + pw * 0.5, py + ph * 0.62, 0, px + pw * 0.5, py + ph * 0.62, pw * 0.8);
    warm.addColorStop(0, `rgba(232,178,96,${0.30 * lit})`);
    warm.addColorStop(1, 'rgba(232,178,96,0)');
    g.fillStyle = warm;
    g.fillRect(px, py, pw, ph);
  }

  g.fillStyle = '#e8ebee';
  g.fillRect(px - frame, py - frame, pw + frame * 2, frame);
  g.fillRect(px - frame, py + ph, pw + frame * 2, frame);
  g.fillRect(px - frame, py - frame, frame, ph + frame * 2);
  g.fillRect(px + pw, py - frame, frame, ph + frame * 2);
  for (let c = 1; c < cols; c++) g.fillRect(px + (pw / cols) * c - frame / 2, py, frame, ph);
  for (let r = 1; r < rows; r++) g.fillRect(px, py + (ph / rows) * r - frame / 2, pw, frame);

  // The dark painted lintel over every opening on this house.
  g.fillStyle = '#101315';
  g.fillRect(px - frame * 2.2, py - frame * 3.4, pw + frame * 4.4, frame * 2.2);
  void rng;
}

/** The square bay: three lights, its own flat roof, brick plinth beneath. */
function bay(g, rng, W, H) {
  const b = L.bay;
  g.fillStyle = '#101315';
  g.fillRect((b.x - 0.008) * W, (b.y - 0.026) * H, (b.w + 0.016) * W, 0.020 * H);
  window_(g, rng, b.x, b.y, b.w, b.h, W, H, { cols: 3, rows: 1, lit: 0.55 });
  brickwork(
    g, rng,
    polyPath(rect(b.x - 0.006, b.y + b.h, b.w + 0.012, L.ground - (b.y + b.h)), W, H),
    { x: (b.x - 0.006) * W, y: (b.y + b.h) * H, w: (b.w + 0.012) * W, h: (L.ground - (b.y + b.h)) * H },
    [96, 52, 38],
    H * 0.0165
  );
}

/** Yellow front door in a brick reveal, six panes of obscured glass on top. */
function door(g, rng, W, H) {
  const sur = L.surround;
  brickwork(
    g, rng,
    polyPath(rect(sur.x, sur.top, sur.w, L.ground - sur.top), W, H),
    { x: sur.x * W, y: sur.top * H, w: sur.w * W, h: (L.ground - sur.top) * H },
    [104, 56, 40],
    H * 0.0165
  );

  const d = L.door;
  const px = d.x * W;
  const py = d.top * H;
  const pw = d.w * W;
  const ph = (L.ground - d.top) * H;

  const paint = g.createLinearGradient(px, py, px + pw, py + ph);
  paint.addColorStop(0, '#8d6a1c');
  paint.addColorStop(1, '#6d4f12');
  g.fillStyle = paint;
  g.fillRect(px, py, pw, ph);

  // Six panes, top third.
  const gx = px + pw * 0.14;
  const gy = py + ph * 0.07;
  const gw = pw * 0.72;
  const gh = ph * 0.26;
  g.fillStyle = 'rgba(228,196,132,0.30)';
  g.fillRect(gx, gy, gw, gh);
  g.strokeStyle = '#8d6a1c';
  g.lineWidth = Math.max(1.5, pw * 0.035);
  for (let c = 1; c < 2; c++) {
    g.beginPath();
    g.moveTo(gx + (gw / 2) * c, gy);
    g.lineTo(gx + (gw / 2) * c, gy + gh);
    g.stroke();
  }
  for (let r = 1; r < 3; r++) {
    g.beginPath();
    g.moveTo(gx, gy + (gh / 3) * r);
    g.lineTo(gx + gw, gy + (gh / 3) * r);
    g.stroke();
  }
  g.strokeRect(gx, gy, gw, gh);

  // Four panels below, and a letterbox.
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.lineWidth = Math.max(1, pw * 0.02);
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 2; c++) {
      g.strokeRect(px + pw * (0.14 + c * 0.42), py + ph * (0.44 + r * 0.26), pw * 0.30, ph * 0.20);
    }
  }
  g.fillStyle = '#2a2013';
  g.fillRect(px + pw * 0.28, py + ph * 0.375, pw * 0.44, ph * 0.028);

  // Porch light, which is the one thing on this facade that emits.
  const lamp = g.createRadialGradient(
    (sur.x - 0.012) * W, (sur.top + 0.012) * H, 0,
    (sur.x - 0.012) * W, (sur.top + 0.012) * H, W * 0.055
  );
  lamp.addColorStop(0, 'rgba(255,214,150,0.32)');
  lamp.addColorStop(1, 'rgba(255,214,150,0)');
  g.fillStyle = lamp;
  g.fillRect(0, 0, W, H);
}

/** The rendered stack on the party wall, with two pots. */
function chimney(g, rng, W, H) {
  const c = L.chimney;
  render_(
    g, rng,
    polyPath(rect(c.x, c.top, c.w, c.base - c.top), W, H),
    { x: c.x * W, y: c.top * H, w: c.w * W, h: (c.base - c.top) * H },
    { top: '#2e3138', bottom: '#23262c' }
  );
  g.fillStyle = '#1a1c20';
  g.fillRect(c.x * W, c.top * H, c.w * W, H * 0.008);
  for (const u of [0.28, 0.66]) {
    g.fillStyle = '#15171a';
    g.fillRect((c.x + c.w * u) * W, (c.top - 0.016) * H, c.w * 0.24 * W, 0.018 * H);
  }
}

/** The flat-roofed store on the side, and its open doorway. */
function store(g, rng, W, H) {
  const st = L.store;
  render_(
    g, rng,
    polyPath(rect(st.x, st.roof, st.w, st.ground - st.roof), W, H),
    { x: st.x * W, y: st.roof * H, w: st.w * W, h: (st.ground - st.roof) * H },
    { top: '#3d4149', bottom: '#2a2d33' }
  );
  // Flat roof and its overhanging edge.
  g.fillStyle = '#101215';
  g.fillRect((st.x - 0.008) * W, (st.roof - 0.018) * H, (st.w + 0.016) * W, 0.020 * H);

  const d = L.storeDoor;
  g.fillStyle = '#07080a';
  g.fillRect(d.x * W, d.y * H, d.w * W, d.h * H);
  window_(g, rng, L.storeWindow.x, L.storeWindow.y, L.storeWindow.w, L.storeWindow.h, W, H,
    { cols: 1, rows: 2, lit: 0 });
}

/** The neighbour's half, past the party wall. Never lit; that is the point. */
function neighbour(g, rng, W, H) {
  render_(
    g, rng,
    polyPath(rect(L.wallR, L.eaves, 1.02 - L.wallR, L.ground - L.eaves), W, H),
    { x: L.wallR * W, y: L.eaves * H, w: (1.02 - L.wallR) * W, h: (L.ground - L.eaves) * H },
    { top: '#3f444c', bottom: '#2c2f35' }
  );
  window_(g, rng, 0.845, 0.296, 0.125, 0.126, W, H, { cols: 3, rows: 1, lit: 0.5 });
  window_(g, rng, 0.845, 0.607, 0.140, 0.183, W, H, { cols: 3, rows: 1, lit: 0.7 });
  // A hint of the party wall, so it is obvious where your half stops.
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.fillRect(L.wallR * W, L.eaves * H, W * 0.0035, (L.ground - L.eaves) * H);
}

/** Photographic grain and a vignette, so it reads as a picture and not as vector art. */
function finish(g, rng, W, H) {
  const grains = Math.round((W * H) / 700);
  for (let i = 0; i < grains; i++) {
    const v = rng();
    g.fillStyle = v > 0.5 ? 'rgba(255,255,255,0.024)' : 'rgba(0,0,0,0.045)';
    g.fillRect(rng() * W, rng() * H, 1.4, 1.4);
  }
  const vig = g.createRadialGradient(W * 0.5, H * 0.52, H * 0.30, W * 0.5, H * 0.52, W * 0.72);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.55)');
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

  skyAndGround(g, rng, W, H);
  roof(g, rng, W, H);
  neighbour(g, rng, W, H);
  store(g, rng, W, H);

  render_(
    g, rng,
    polyPath(rect(L.wallL, L.eaves, L.wallR - L.wallL, L.ground - L.eaves), W, H),
    { x: L.wallL * W, y: L.eaves * H, w: (L.wallR - L.wallL) * W, h: (L.ground - L.eaves) * H },
    { top: '#484d56', bottom: '#31353c' }
  );

  chimney(g, rng, W, H);
  for (const w of L.upper) {
    window_(g, rng, w.x, w.y, w.w, w.h, W, H, { cols: w.cols, rows: w.rows, lit: 0.4 });
  }
  bay(g, rng, W, H);
  door(g, rng, W, H);
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
