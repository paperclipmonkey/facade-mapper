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

const L = {
  ground: 0.9,
  eaves: 0.335,
  apex: 0.105,
  wallL: 0.155,
  wallR: 0.845,
  /** Roof overhangs the wall, as roofs do. */
  rakeL: 0.115,
  rakeR: 0.885,
  chimney: { x: 0.685, w: 0.07, top: 0.055, base: 0.27 },
  door: { x: 0.455, w: 0.09, top: 0.6 },
  lower: [
    { name: 'Left window', x: 0.205, w: 0.13, y: 0.575, h: 0.2, cols: 2, rows: 2 },
    { name: 'Right window', x: 0.665, w: 0.13, y: 0.575, h: 0.2, cols: 2, rows: 2 },
  ],
  upper: [
    { name: 'Left bedroom', x: 0.205, w: 0.11, y: 0.395, h: 0.125, cols: 2, rows: 1 },
    { name: 'Landing window', x: 0.445, w: 0.11, y: 0.395, h: 0.125, cols: 2, rows: 1 },
    { name: 'Right bedroom', x: 0.685, w: 0.11, y: 0.395, h: 0.125, cols: 2, rows: 1 },
  ],
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
 * `chimney`, `wall`, `path`), which is what lets "Halloween starter" land a
 * complete look on it without a single click of setup.
 */
export function demoShapes() {
  const shapes = [];
  const add = (points, name, tags, overrides = {}) => {
    shapes.push(createShape(points, { name, tags, ...overrides }));
  };

  // Wall first so it sits behind everything in the shape list, which is also
  // the order you would have traced it in.
  add(
    [
      { x: L.wallL, y: L.eaves },
      { x: 0.5, y: L.apex + 0.012 },
      { x: L.wallR, y: L.eaves },
      { x: L.wallR, y: L.ground },
      { x: L.wallL, y: L.ground },
    ],
    'Front wall',
    ['wall']
  );

  add(
    [
      { x: L.rakeL, y: L.eaves },
      { x: 0.5, y: L.apex },
      { x: L.rakeR, y: L.eaves },
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

  for (const w of [...L.upper, ...L.lower]) {
    add(rect(w.x, w.y, w.w, w.h), w.name, ['window']);
  }

  add(rect(L.door.x, L.door.top, L.door.w, L.ground - L.door.top), 'Front door', ['door']);

  /**
   * A shallow arch over the door, as an open path.
   *
   * Text laid along it reads as a sign hung over the porch rather than as a
   * caption floating on brickwork, and it is the one shape here whose whole
   * purpose is to be written on — hence its own tag.
   *
   * Deliberately wider than the door. A sign has to hold a phrase, and the
   * text effect sizes itself from the shape it is given: an arch only as wide
   * as the door forces "MERRY CHRISTMAS" down to something you could not read
   * from the pavement, which is the one place it will ever be read from.
   */
  const archPad = 0.085;
  add(
    Array.from({ length: 11 }, (_, i) => {
      const u = i / 10;
      return {
        x: L.door.x - archPad + u * (L.door.w + archPad * 2),
        y: L.door.top - 0.03 - Math.sin(u * Math.PI) * 0.055,
      };
    }),
    'Door arch',
    ['sign', 'trim'],
    { type: 'path', closed: false, smooth: true }
  );

  // The path is where you point a motion trigger, and where the leaves gather.
  add(
    [
      { x: L.door.x - 0.01, y: L.ground },
      { x: L.door.x + L.door.w + 0.01, y: L.ground },
      { x: 0.68, y: 1.0 },
      { x: 0.32, y: 1.0 },
    ],
    'Garden path',
    ['path']
  );

  return shapes;
}

/**
 * Where a projector standing on the lawn would land on this house.
 *
 * Slightly off-square, because a projector on the ground pointing up always is.
 * It exists so the coverage outline and the "aligned" state in the checklist
 * behave like a real show rather than being special-cased away.
 */
export function demoWorldQuad() {
  return [
    { x: 0.075, y: 0.045 },
    { x: 0.925, y: 0.03 },
    { x: 0.965, y: 0.965 },
    { x: 0.035, y: 0.98 },
  ];
}

/* ------------------------------------------------------------------ *
 * Painting the house
 *
 * Deliberately dim and blue. A projector cannot emit darkness, so a facade at
 * night is mostly a very dark picture with a few slightly-less-dark surfaces —
 * and an effect tuned against a bright daylight photo will be far too weak when
 * it meets real brickwork. Practising against a plausible night exposure is
 * most of the point.
 * ------------------------------------------------------------------ */

function skyAndGround(g, W, H) {
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

  g.fillStyle = '#0a1109';
  g.fillRect(0, L.ground * H, W, H - L.ground * H);

  const path = new Path2D();
  path.moveTo((L.door.x - 0.012) * W, L.ground * H);
  path.lineTo((L.door.x + L.door.w + 0.012) * W, L.ground * H);
  path.lineTo(0.685 * W, H);
  path.lineTo(0.315 * W, H);
  path.closePath();
  const paving = g.createLinearGradient(0, L.ground * H, 0, H);
  paving.addColorStop(0, '#191c1e');
  paving.addColorStop(1, '#24282a');
  g.fillStyle = paving;
  g.fill(path);
}

/** Turn a list of normalised points into a Path2D in canvas pixels. */
function polyPath(points, W, H) {
  const p = new Path2D();
  p.moveTo(points[0].x * W, points[0].y * H);
  for (let i = 1; i < points.length; i++) p.lineTo(points[i].x * W, points[i].y * H);
  p.closePath();
  return p;
}

/**
 * Brick, drawn course by course with per-brick variation so it is not a flat
 * slab. Courses are laid across the whole clip region and cut by it, which is
 * how a gable end gets brickwork that runs into the rake without any per-row
 * trigonometry.
 */
function brickwork(g, rng, clip, box, base, courseFraction = 0.013) {
  const course = Math.max(3, box.h * courseFraction);
  const brick = course * 2.7;
  g.save();
  g.clip(clip);

  g.fillStyle = '#15100e'; // mortar
  g.fill(clip);

  for (let row = 0, cy = box.y; cy < box.y + box.h; row++, cy += course) {
    const offset = row % 2 ? -brick / 2 : 0;
    for (let cx = box.x + offset; cx < box.x + box.w; cx += brick) {
      const v = rng();
      g.fillStyle = `rgb(${(base[0] + v * 22 - 8) | 0},${(base[1] + v * 18 - 7) | 0},${(base[2] + v * 16 - 6) | 0})`;
      g.fillRect(cx + 0.9, cy + 0.9, brick - 1.8, course - 1.8);
    }
  }
  g.restore();
}

/**
 * The rake: the slate edge that overhangs a gable end.
 *
 * Not a filled triangle. On a gable end you are looking at the *wall*, and the
 * roof shows only as a band along the two top edges — filling the triangle
 * would bury the brickwork the whole demo is meant to show off, and would put a
 * roof where the traced `#roof` path expects an edge.
 */
function rake(g, W, H) {
  const line = (width, style) => {
    g.strokeStyle = style;
    g.lineWidth = width;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(L.rakeL * W, L.eaves * H);
    g.lineTo(0.5 * W, L.apex * H);
    g.lineTo(L.rakeR * W, L.eaves * H);
    g.stroke();
  };

  line(H * 0.03, '#1a1e26');
  // A thinner, paler pass along the same line reads as the top edge of the
  // slate catching the sky.
  g.save();
  g.translate(0, -H * 0.009);
  line(H * 0.008, 'rgba(146,166,196,0.22)');
  g.restore();

  // The eaves overhang, carrying on past the wall at each side.
  g.fillStyle = '#1a1e26';
  g.fillRect(L.rakeL * W, L.eaves * H - H * 0.012, (L.wallL - L.rakeL) * W + 2, H * 0.024);
  g.fillRect(L.wallR * W - 2, L.eaves * H - H * 0.012, (L.rakeR - L.wallR) * W + 2, H * 0.024);
}

/**
 * A window: reveal, dark glass with a sky reflection, then the frame on top.
 *
 * The reflection matters more than it sounds. Flat black rectangles read as
 * holes, and an effect drawn into a hole looks pasted on; a faint gradient with
 * a slightly brighter top gives the glass a surface for light to sit on.
 */
function window_(g, rng, w, W, H) {
  const x = w.x * W;
  const y = w.y * H;
  const ww = w.w * W;
  const wh = w.h * H;
  const reveal = Math.max(2, ww * 0.035);

  g.fillStyle = '#2a2119';
  g.fillRect(x - reveal, y - reveal, ww + reveal * 2, wh + reveal * 2);

  const glass = g.createLinearGradient(0, y, 0, y + wh);
  glass.addColorStop(0, '#141c2b');
  glass.addColorStop(0.45, '#0a0e17');
  glass.addColorStop(1, '#070a10');
  g.fillStyle = glass;
  g.fillRect(x, y, ww, wh);

  // A cold sliver of sky on the upper panes. Kept faint on purpose: glass that
  // is already bright leaves projected light nowhere to go.
  g.save();
  g.globalAlpha = 0.07 + rng() * 0.05;
  const sheen = g.createLinearGradient(x, y, x + ww, y + wh * 0.7);
  sheen.addColorStop(0, 'rgba(150,180,225,0.9)');
  sheen.addColorStop(0.5, 'rgba(150,180,225,0)');
  g.fillStyle = sheen;
  g.fillRect(x, y, ww, wh);
  g.restore();

  g.strokeStyle = '#cfd4d8';
  g.lineWidth = Math.max(1.5, ww * 0.022);
  g.globalAlpha = 0.4;
  g.strokeRect(x, y, ww, wh);
  for (let c = 1; c < w.cols; c++) {
    const gx = x + (ww * c) / w.cols;
    g.beginPath();
    g.moveTo(gx, y);
    g.lineTo(gx, y + wh);
    g.stroke();
  }
  for (let r = 1; r < w.rows; r++) {
    const gy = y + (wh * r) / w.rows;
    g.beginPath();
    g.moveTo(x, gy);
    g.lineTo(x + ww, gy);
    g.stroke();
  }
  g.globalAlpha = 1;

  // Sill.
  g.fillStyle = '#3b3831';
  g.fillRect(x - reveal * 1.6, y + wh + reveal * 0.4, ww + reveal * 3.2, reveal * 1.3);
}

function door(g, W, H) {
  const x = L.door.x * W;
  const y = L.door.top * H;
  const w = L.door.w * W;
  const h = (L.ground - L.door.top) * H;

  g.fillStyle = '#2a2119';
  g.fillRect(x - w * 0.05, y - h * 0.02, w * 1.1, h * 1.02);

  const face = g.createLinearGradient(x, y, x + w, y + h);
  face.addColorStop(0, '#10201c');
  face.addColorStop(1, '#0a1613');
  g.fillStyle = face;
  g.fillRect(x, y, w, h);

  g.strokeStyle = 'rgba(180,200,190,0.16)';
  g.lineWidth = Math.max(1.2, w * 0.02);
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 2; c++) {
      g.strokeRect(
        x + w * (0.14 + c * 0.43),
        y + h * (0.1 + r * 0.42),
        w * 0.29,
        h * 0.34
      );
    }
  }

  g.fillStyle = 'rgba(210,190,140,0.5)';
  g.beginPath();
  g.arc(x + w * 0.86, y + h * 0.52, Math.max(1.5, w * 0.035), 0, Math.PI * 2);
  g.fill();

  // Step.
  g.fillStyle = '#2c2f30';
  g.fillRect(x - w * 0.16, L.ground * H, w * 1.32, H * 0.014);
}

function chimney(g, rng, W, H) {
  const c = L.chimney;
  const box = { x: c.x * W, y: c.top * H, w: c.w * W, h: (c.base - c.top) * H };
  const stack = new Path2D();
  stack.rect(box.x, box.y, box.w, box.h);
  brickwork(g, rng, stack, box, [58, 42, 36], 0.055);
  g.fillStyle = '#20242b';
  g.fillRect((c.x - 0.004) * W, c.top * H, (c.w + 0.008) * W, H * 0.012);
  g.fillStyle = '#141317';
  g.fillRect((c.x + c.w * 0.28) * W, (c.top - 0.022) * H, c.w * 0.44 * W, H * 0.026);
}

/** Photographic grain and a vignette, so it reads as a picture and not as vector art. */
function finish(g, rng, W, H) {
  const vignette = g.createRadialGradient(W / 2, H * 0.55, H * 0.25, W / 2, H * 0.55, W * 0.72);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.55)');
  g.fillStyle = vignette;
  g.fillRect(0, 0, W, H);

  const grain = g.createImageData(W, H);
  const d = grain.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * 26;
    d[i] = d[i + 1] = d[i + 2] = 128 + n;
    d[i + 3] = 26;
  }
  const tile = document.createElement('canvas');
  tile.width = W;
  tile.height = H;
  tile.getContext('2d').putImageData(grain, 0, 0);
  g.save();
  g.globalCompositeOperation = 'overlay';
  g.drawImage(tile, 0, 0);
  g.restore();
}

/** Paint the demo facade into a fresh canvas. Deterministic — same house every time. */
export function renderDemoFacade(W = 1600, H = Math.round(1600 / DEMO_ASPECT)) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  const rng = makeRng('facade-mapper-demo-house');

  // Back to front, exactly as the real thing was built: sky, wall, chimney,
  // roof over the top of both, then the joinery.
  skyAndGround(g, W, H);

  const facade = [
    { x: L.wallL, y: L.eaves },
    { x: 0.5, y: L.apex + 0.012 },
    { x: L.wallR, y: L.eaves },
    { x: L.wallR, y: L.ground },
    { x: L.wallL, y: L.ground },
  ];
  brickwork(
    g,
    rng,
    polyPath(facade, W, H),
    {
      x: L.wallL * W,
      y: L.apex * H,
      w: (L.wallR - L.wallL) * W,
      h: (L.ground - L.apex) * H,
    },
    [62, 45, 38]
  );

  chimney(g, rng, W, H);
  rake(g, W, H);

  for (const w of [...L.upper, ...L.lower]) window_(g, rng, w, W, H);
  door(g, W, H);
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
