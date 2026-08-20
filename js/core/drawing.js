/**
 * Live drawing surfaces.
 *
 * Somebody stands in the garden with a tablet and draws on the house. The ink
 * is on the wall while the pencil is still moving.
 *
 * This is the store the strokes live in, and it is deliberately *not* part of
 * the project. The project is broadcast whole, a dozen times a second, and
 * saved to local storage on every change; a drawing is thousands of points
 * arriving sixty times a second, and putting it in there would rewrite the
 * entire show on every stroke of a pencil. So drawing travels as its own small
 * incremental messages — begin, some points, end — and every tab keeps an
 * identical copy of the result here. Same idea as the audio levels: show state
 * rather than show content.
 *
 * Coordinates are normalised to the *target shape's* box, 0..1, y down. That is
 * what lets one drawing land on the window it was drawn for whatever the camera
 * resolution is, follow the shape if it is later re-traced, and appear on all
 * four windows at once if the layer points at all four.
 *
 * Points are integers rather than floats — 0..10000 across the shape, pressure
 * 0..255 — because it halves the size of a message that is sent sixty times a
 * second, and a ten-thousandth of a window is a third of a millimetre.
 */

import { now } from './time.js';

export const DRAW_SCALE = 10000;
export const PRESSURE_SCALE = 255;

/**
 * How much drawing is kept.
 *
 * An evening of this would otherwise grow without limit, in every tab, and the
 * tab it hurts first is the projector one that has to redraw it. Oldest strokes
 * go first, which is also what somebody drawing would expect if they noticed at
 * all.
 */
const MAX_STROKES = 500;
const MAX_POINTS = 120000;

/** surfaceId -> surface. A surface is one layer's worth of drawing. */
const surfaces = new Map();

function makeSurface(id) {
  return {
    id,
    strokes: [],
    points: 0,
    /**
     * Bumped on every change, so a renderer can tell whether it needs to do
     * anything at all.
     */
    revision: 0,
    /**
     * Bumped only when something is *removed* — undone, cleared, or dropped for
     * age. An accumulating renderer can add to its buffer as long as this has
     * not moved, and has to start again when it has.
     */
    generation: 0,
    updatedAt: 0,
  };
}

export function surfaceFor(id) {
  const key = id || '__default__';
  let surface = surfaces.get(key);
  if (!surface) {
    surface = makeSurface(key);
    surfaces.set(key, surface);
  }
  return surface;
}

/** Read-only lookup: does not create the surface, so a renderer cannot leak one. */
export function drawingFor(id) {
  return surfaces.get(id || '__default__') || null;
}

export function surfaceIds() {
  return [...surfaces.keys()];
}

/** Seconds since a stroke was drawn, on the shared clock. */
export function strokeAge(stroke) {
  return Math.max(0, (now() - (stroke.at || 0)) / 1000);
}

function trim(surface) {
  let removed = false;
  while (surface.strokes.length > MAX_STROKES || surface.points > MAX_POINTS) {
    const dropped = surface.strokes.shift();
    if (!dropped) break;
    surface.points -= dropped.pts.length / 3;
    removed = true;
  }
  if (removed) surface.generation++;
}

/**
 * Apply one message from a drawing device.
 *
 * Every tab runs this over the same messages and lands on the same drawing,
 * which is the same reason effects use a seeded generator: two projectors
 * covering one wall have to agree about what is on it.
 *
 * Returns whether anything changed, so a caller can avoid pointless work.
 */
export function applyDrawMessage(msg) {
  if (!msg || typeof msg.kind !== 'string') return false;
  const surface = surfaceFor(msg.surface);

  switch (msg.kind) {
    case 'begin': {
      if (!msg.id) return false;
      surface.strokes.push({
        id: msg.id,
        color: typeof msg.color === 'string' ? msg.color : '#ffffff',
        width: Number(msg.width) > 0 ? Number(msg.width) : 1,
        erase: !!msg.erase,
        at: Number(msg.at) || now(),
        done: false,
        pts: [],
      });
      surface.revision++;
      surface.updatedAt = now();
      trim(surface);
      return true;
    }

    case 'points': {
      const stroke = findStroke(surface, msg.id);
      if (!stroke || !Array.isArray(msg.pts) || !msg.pts.length) return false;
      // Triples, or the renderer walks off the end of the last point.
      const usable = msg.pts.length - (msg.pts.length % 3);
      for (let i = 0; i < usable; i++) stroke.pts.push(msg.pts[i] | 0);
      surface.points += usable / 3;
      surface.revision++;
      surface.updatedAt = now();
      trim(surface);
      return true;
    }

    case 'end': {
      const stroke = findStroke(surface, msg.id);
      if (!stroke) return false;
      stroke.done = true;
      surface.revision++;
      return true;
    }

    case 'undo': {
      if (!surface.strokes.length) return false;
      const dropped = surface.strokes.pop();
      surface.points -= dropped.pts.length / 3;
      surface.revision++;
      surface.generation++;
      surface.updatedAt = now();
      return true;
    }

    case 'clear': {
      if (!surface.strokes.length) return false;
      surface.strokes = [];
      surface.points = 0;
      surface.revision++;
      surface.generation++;
      surface.updatedAt = now();
      return true;
    }

    /**
     * Everything at once, for a tab that arrived late.
     *
     * A projector tab opened halfway through the evening has missed every
     * stroke that made the drawing, and there is no replaying them — so the
     * control tab sends the lot and the tab adopts it wholesale.
     */
    case 'full': {
      surface.strokes = (msg.strokes || []).map((s) => ({
        id: s.id,
        color: typeof s.color === 'string' ? s.color : '#ffffff',
        width: Number(s.width) > 0 ? Number(s.width) : 1,
        erase: !!s.erase,
        at: Number(s.at) || now(),
        done: s.done !== false,
        pts: Array.isArray(s.pts) ? s.pts.map((v) => v | 0) : [],
      }));
      surface.points = surface.strokes.reduce((sum, s) => sum + s.pts.length / 3, 0);
      surface.revision++;
      surface.generation++;
      surface.updatedAt = now();
      trim(surface);
      return true;
    }

    default:
      return false;
  }
}

/**
 * Look for the stroke a message belongs to, newest first.
 *
 * Newest first because it is almost always the last one — the pencil that is
 * moving right now — and a linear scan from the other end of five hundred
 * strokes, sixty times a second, is a real cost for no reason.
 */
function findStroke(surface, id) {
  for (let i = surface.strokes.length - 1; i >= 0; i--) {
    if (surface.strokes[i].id === id) return surface.strokes[i];
  }
  return null;
}

/** Everything on a surface, in a form that survives JSON. */
export function snapshotOf(id) {
  const surface = drawingFor(id);
  return {
    kind: 'full',
    surface: id,
    strokes: (surface?.strokes || []).map((s) => ({
      id: s.id,
      color: s.color,
      width: s.width,
      erase: s.erase,
      at: s.at,
      done: s.done,
      pts: s.pts,
    })),
  };
}

/** For tests, and for a tab that is closing a show and opening another. */
export function resetDrawings() {
  surfaces.clear();
}
