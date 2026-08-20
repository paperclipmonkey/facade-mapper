/**
 * Drawing on the house, live.
 *
 * The strokes come from a tablet somewhere on the link — see js/draw/ and
 * core/drawing.js — and this is the end of that wire: it paints whatever is on
 * the surface named by this layer into whatever shapes the layer targets.
 *
 * Two things are worth knowing about how it is drawn.
 *
 * **It accumulates.** Redrawing an evening's drawing from scratch sixty times a
 * second is a slideshow by about the thirtieth stroke. The ink goes into an
 * offscreen buffer, once, and every frame after that is one `drawImage`. Only
 * the points that arrived since the last frame are painted, which is why the
 * cost of drawing does not grow with how much has been drawn. Fading has to
 * repaint — a stroke that is dimmer this frame than last cannot be added to —
 * so that mode redraws, and the stroke cap in the store is what bounds it.
 *
 * **It is light, not paint.** A flat stroke reads as a sticker on the wall. A
 * bright core with a wider, dimmer pass under it reads as something glowing,
 * survives the bloom pass looking like a light source, and costs two strokes
 * rather than a per-stroke shadow blur — which the performance notes are
 * emphatic about, and rightly.
 */

import { clamp, hexToRgb } from '../../core/math.js';
import { drawingFor, strokeAge, DRAW_SCALE, PRESSURE_SCALE } from '../../core/drawing.js';
import { offscreen } from '../lib.js';

/**
 * Resolution of the ink buffer along its longest edge.
 *
 * The world frame is 1920 wide and a traced window is a fraction of that, so a
 * buffer matching the shape's own pixels is both small and exactly as sharp as
 * anything else drawn into that shape. The cap is for the case where the layer
 * has no targets and the "shape" is the whole frame.
 */
const MAX_BUFFER = 1600;

export function bufferSize(bbox) {
  const scale = Math.min(1, MAX_BUFFER / Math.max(bbox.w, bbox.h, 1));
  return {
    w: Math.max(1, Math.round(bbox.w * scale)),
    h: Math.max(1, Math.round(bbox.h * scale)),
  };
}

/**
 * The outline of a stroke, as one closed shape.
 *
 * The obvious way to draw a line that changes width is to stroke each segment
 * separately at its own width, and it is wrong in a way that is invisible until
 * you look at it on a wall: consecutive segments overlap at their round caps,
 * every overlap is composited twice, and a stroke comes out beaded like a
 * string of pearls. Additive blending makes it glaring, partial alpha makes it
 * subtle, and no amount of tuning the widths removes it, because the cause is
 * compositing rather than geometry.
 *
 * So the stroke becomes one path — up one side, round the end, back down the
 * other — and one fill. Overlaps inside a single fill do not exist: it is one
 * shape. Which also means the same code works at any opacity, so a stroke that
 * is fading looks like the stroke it was rather than like a different effect.
 *
 * The sides run through the midpoints of the offset points rather than corner
 * to corner, which is what keeps a fast stroke a curve rather than a polygon.
 */
function ribbon(pts, count, sx, sy, halfWidth, from) {
  const path = new Path2D();
  const first = Math.max(0, from);
  const last = count - 1;

  const px = (i) => pts[i * 3] * sx;
  const py = (i) => pts[i * 3 + 1] * sy;

  // Offsets of both sides at each point, from the direction through it.
  const left = [];
  const right = [];
  for (let i = first; i <= last; i++) {
    const ax = px(Math.max(first, i - 1));
    const ay = py(Math.max(first, i - 1));
    const bx = px(Math.min(last, i + 1));
    const by = py(Math.min(last, i + 1));
    let dx = bx - ax;
    let dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) {
      // A stationary sample — a pencil resting. Borrow the previous direction
      // so the ribbon does not collapse to nothing at that point.
      dx = left.length ? left[left.length - 1].dx : 1;
      dy = left.length ? left[left.length - 1].dy : 0;
    } else {
      dx /= len;
      dy /= len;
    }
    const hw = halfWidth(i);
    left.push({ x: px(i) - dy * hw, y: py(i) + dx * hw, dx, dy });
    right.push({ x: px(i) + dy * hw, y: py(i) - dx * hw });
  }

  const side = (list, reverse) => {
    const n = list.length;
    const at = (i) => list[reverse ? n - 1 - i : i];
    path.lineTo(at(0).x, at(0).y);
    for (let i = 1; i < n; i++) {
      const a = at(i - 1);
      const b = at(i);
      path.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
    }
    path.lineTo(at(n - 1).x, at(n - 1).y);
  };

  path.moveTo(left[0].x, left[0].y);
  side(left, false);
  side(right, true);
  path.closePath();

  /**
   * Round ends, as extra subpaths — wound the same way round as the ribbon.
   *
   * That last part is not a detail. A non-zero fill adds up winding numbers, so
   * a circle traced the other way round from the shape it sits on top of
   * subtracts from it: the caps came out as neat dark holes at both ends of
   * every stroke. The ribbon runs up one side and back down the other, which is
   * always negatively wound, so the caps have to be too.
   */
  const cap = (i) => {
    const r = halfWidth(i);
    if (r <= 0.2) return;
    path.moveTo(px(i) + r, py(i));
    path.arc(px(i), py(i), r, 0, Math.PI * 2, true);
  };
  cap(first);
  cap(last);

  return path;
}

/**
 * Paint one stroke into the ink buffer.
 *
 * `from` is where to start, so a stroke still being drawn is continued rather
 * than repainted — which is what stops the cost of drawing growing with how
 * much has been drawn. One segment of overlap, because a fill that begins
 * exactly where the last one ended leaves a seam.
 *
 * Width follows pressure, which is the entire reason for using a pencil rather
 * than a mouse.
 */
export function paintStroke(g, stroke, size, params, alpha, from = 0) {
  const pts = stroke.pts;
  const count = pts.length / 3;
  if (count === 0 || alpha <= 0.002) return;

  const sx = size.w / DRAW_SCALE;
  const sy = size.h / DRAW_SCALE;
  const base = (params.width * Math.min(size.w, size.h)) / 100;
  const halfWidth = (i) => Math.max(0.25, (base * (0.35 + (0.65 * pts[i * 3 + 2]) / PRESSURE_SCALE)) / 2);

  const rgb = hexToRgb(stroke.color);

  /**
   * Inside the buffer everything is ordinary painting, whatever the layer's
   * blend is set to. The blend belongs to the moment the finished ink meets the
   * rest of the show, not to the moment one stroke meets another — additive
   * ink over itself is how a drawing ends up with bright seams everywhere its
   * own strokes cross.
   */
  g.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';

  // A tap of the pencil is a dot: there is no ribbon to build.
  if (count === 1) {
    g.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
    g.beginPath();
    g.arc(pts[0] * sx, pts[1] * sy, halfWidth(0), 0, Math.PI * 2);
    g.fill();
    return;
  }

  if (!stroke.erase && params.glow > 0) {
    const spread = 1 + params.glow * 2.2;
    g.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha * 0.16})`;
    g.fill(ribbon(pts, count, sx, sy, (i) => halfWidth(i) * spread, from));
  }

  g.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
  g.fill(ribbon(pts, count, sx, sy, halfWidth, from));
}

const liveDraw = {
  id: 'live-draw',
  name: 'Live drawing',
  category: 'basic',
  scope: 'shape',
  description:
    'Ink drawn from a tablet, in real time. Open the drawing page on an iPad and whatever you draw lands inside this layer’s shapes.',
  params: [
    { key: 'width', type: 'range', label: 'Line width', default: 2.2, min: 0.2, max: 12, step: 0.1 },
    { key: 'glow', type: 'range', label: 'Glow', default: 0.7, min: 0, max: 2, step: 0.05 },
    { key: 'level', type: 'range', label: 'Brightness', default: 1, min: 0, max: 3, step: 0.01 },
    {
      key: 'fade',
      type: 'range',
      label: 'Fade after (s)',
      default: 0,
      min: 0,
      max: 120,
      step: 1,
    },
    {
      key: 'blend',
      type: 'select',
      label: 'Blend',
      default: 'lighter',
      options: ['lighter', 'source-over'],
    },
    {
      key: 'surface',
      type: 'text',
      label: 'Surface',
      default: '',
      // Blank means "this layer", which is what anybody who never opens this
      // field wants. Naming one lets two layers show the same drawing — the
      // same hand on two walls — which is worth the field existing.
    },
  ],

  draw({ g, p, stable, shape, layer, state }) {
    const { bbox } = shape;
    if (bbox.w <= 0 || bbox.h <= 0) return;

    const surface = drawingFor(surfaceIdFor(layer, stable));
    if (!surface || !surface.strokes.length) return;

    const canvas = syncInk(state, surface, bufferSize(bbox), {
      width: p.width,
      glow: p.glow,
      blend: p.blend,
      fade: p.fade,
    });
    if (!canvas) return;

    const previous = g.globalAlpha;
    g.globalAlpha = previous * clamp(p.level, 0, 3);
    g.globalCompositeOperation = p.blend;
    g.drawImage(canvas, bbox.x, bbox.y, bbox.w, bbox.h);
    g.globalAlpha = previous;
    g.globalCompositeOperation = 'source-over';
  },
};

/**
 * Which surface a layer draws.
 *
 * Its own id unless somebody named one, which is the only way two layers can
 * show the same hand.
 */
export function surfaceIdFor(layer, params) {
  return (params?.surface || '').trim() || layer.id;
}

/**
 * Bring an ink buffer up to date with a surface, and hand it back.
 *
 * The drawing page uses this as well as the wall does, so what somebody sees
 * under the pencil is produced by the code that paints the house rather than by
 * a second implementation that will drift from it — the same reason the control
 * tab's preview goes through the projector's own renderer.
 *
 * `state` is whatever object the caller wants to keep the buffer in: an
 * effect's per-instance state, or a plain object on the drawing page.
 */
export function syncInk(state, surface, size, params) {
  const fading = params.fade > 0;
  const key = `${size.w}x${size.h}|${params.width}|${params.glow}|${params.blend}|${fading}`;

  // Rebuilt when the buffer changes size, or when a parameter that affects
  // every stroke moves — and never otherwise, because that is the costly path.
  if (!state.canvas || state.key !== key) {
    state.canvas = offscreen(size.w, size.h);
    state.g = state.canvas.getContext('2d');
    state.key = key;
    state.generation = -1;
    state.revision = -1;
  }

  const ink = state.g;
  const remember = () => {
    state.generation = surface.generation;
    state.revision = surface.revision;
    state.strokeIndex = Math.max(0, surface.strokes.length - 1);
    state.pointIndex = surface.strokes[surface.strokes.length - 1]?.pts.length / 3 || 0;
  };

  if (fading) {
    // Every stroke is a shade dimmer than it was last frame, so there is
    // nothing to add to: repaint. The stroke cap in the store bounds it.
    ink.clearRect(0, 0, size.w, size.h);
    for (const stroke of surface.strokes) {
      const alpha = 1 - clamp(strokeAge(stroke) / params.fade, 0, 1);
      if (alpha > 0.002) paintStroke(ink, stroke, size, params, alpha);
    }
    remember();
  } else if (state.generation !== surface.generation) {
    // Something was undone, cleared or aged out. Start again.
    ink.clearRect(0, 0, size.w, size.h);
    for (const stroke of surface.strokes) paintStroke(ink, stroke, size, params, 1);
    remember();
  } else if (state.revision !== surface.revision) {
    // The ordinary case, sixty times a second while a pencil is moving: paint
    // only the points that have arrived since the last frame.
    const startStroke = state.strokeIndex ?? 0;
    for (let i = startStroke; i < surface.strokes.length; i++) {
      const from = i === startStroke ? Math.max(0, (state.pointIndex ?? 1) - 1) : 0;
      paintStroke(ink, surface.strokes[i], size, params, 1, from);
    }
    remember();
  }

  return state.canvas;
}

export default [liveDraw];
