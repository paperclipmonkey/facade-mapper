/**
 * Treating the traced house as terrain.
 *
 * Every effect up to now draws *into* a shape: you point it at a window and it
 * lights that window. This module is for the opposite relationship — effects
 * that move across the wall and treat the other shapes as things in the way.
 * A ball that bounces off the windows, a snake that will not cross the door,
 * ivy that creeps around a frame instead of over it.
 *
 * That difference is the whole trick. Anything that ignores the facade reads as
 * a video playing on a building; anything that collides with it reads as being
 * *on* the building, because your eye gets the one cue it cannot get from
 * brightness alone — that the light knows where the window is.
 *
 * `collide.js` is the vertical counterpart: it answers "what does this land
 * on?" for things falling out of the sky. This one answers "what is in my way?"
 * for things travelling across a wall. Both work from the shapes you traced and
 * need no extra authoring.
 *
 * Coordinates are world pixels throughout, y down.
 */

import { clamp, pointInPolygon } from '../core/math.js';

/* ------------------------------------------------------------------ *
 * Gathering
 * ------------------------------------------------------------------ */

/**
 * Resolve a comma-separated tag list into the shapes to collide with.
 *
 * Written as text rather than a picker because the interesting answer is almost
 * always more than one tag — "window, door" — and because it keeps working when
 * you trace another window next week and tag it the same way.
 */
export function collectObstacles(shapesFor, tags, excludeId) {
  const wanted = String(tags || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!wanted.length) return [];

  const seen = new Set();
  const out = [];
  for (const tag of wanted) {
    for (const geo of shapesFor(tag, excludeId)) {
      // An open path has no inside, so there is nothing to be in the way of.
      if (!geo.closed || !geo.points || geo.points.length < 3) continue;
      if (seen.has(geo.id)) continue;
      seen.add(geo.id);
      out.push(geo);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

/**
 * The nearest point on a polygon outline, and the unit vector from that point
 * towards the query point.
 *
 * Deliberately *not* an inside/outside normal: which way is "out" depends on
 * whether the caller is treating this polygon as a wall to stay inside or an
 * obstacle to stay outside, and the winding order of a hand-traced shape is
 * anybody's guess. Returning the direction away from the surface lets the
 * caller settle that with one point-in-polygon test and a sign.
 */
export function surfaceNormal(points, x, y) {
  let bestD2 = Infinity;
  let px = x;
  let py = y;
  let ex = 1;
  let ey = 0;

  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 1e-9 ? clamp(((x - a.x) * dx + (y - a.y) * dy) / len2, 0, 1) : 0;
    const qx = a.x + dx * t;
    const qy = a.y + dy * t;
    const d2 = (x - qx) * (x - qx) + (y - qy) * (y - qy);
    if (d2 < bestD2) {
      bestD2 = d2;
      px = qx;
      py = qy;
      ex = dx;
      ey = dy;
    }
  }

  const dist = Math.sqrt(bestD2);
  let nx;
  let ny;
  if (dist > 1e-6) {
    nx = (x - px) / dist;
    ny = (y - py) / dist;
  } else {
    // Sitting exactly on the edge: any direction away from it will do, so use
    // the edge perpendicular rather than dividing by zero.
    const len = Math.hypot(ex, ey) || 1;
    nx = -ey / len;
    ny = ex / len;
  }
  return { px, py, dist, nx, ny, ex, ey };
}

/**
 * Push a mover off a polygon boundary and reflect it.
 *
 * One routine for both jobs, because a container and an obstacle differ only in
 * which side the mover belongs on. `wantInside` picks: true keeps it within the
 * shape it is drawn into, false keeps it off a window.
 *
 * Mutates `m` ({ x, y, vx, vy }) and returns true if it touched.
 */
export function deflect(points, m, radius, restitution, wantInside) {
  const inside = pointInPolygon(m, points);
  if (inside === wantInside) {
    // On the right side already — only a near miss needs handling, and only
    // when the mover has a radius worth respecting.
    if (radius <= 0) return false;
    const s = surfaceNormal(points, m.x, m.y);
    if (s.dist >= radius) return false;
    return resolve(m, s, inside, radius, restitution, wantInside);
  }
  const s = surfaceNormal(points, m.x, m.y);
  return resolve(m, s, inside, radius, restitution, wantInside);
}

function resolve(m, s, inside, radius, restitution, wantInside) {
  // `s.n` points from the surface towards the mover. Where the mover *should*
  // be is the same direction when it is already on the right side, and the
  // opposite when it has strayed through.
  const sign = inside === wantInside ? 1 : -1;
  const nx = s.nx * sign;
  const ny = s.ny * sign;

  m.x = s.px + nx * radius;
  m.y = s.py + ny * radius;

  const along = m.vx * nx + m.vy * ny;
  if (along < 0) {
    m.vx = (m.vx - 2 * along * nx) * restitution;
    m.vy = (m.vy - 2 * along * ny) * restitution;
  }
  return true;
}

/** Is this point clear of every obstacle, and inside the container? */
export function isClear(container, obstacles, x, y) {
  if (container && !pointInPolygon({ x, y }, container.points)) return false;
  for (const o of obstacles) {
    const { bbox } = o;
    if (x < bbox.x || x > bbox.x + bbox.w || y < bbox.y || y > bbox.y + bbox.h) continue;
    if (pointInPolygon({ x, y }, o.points)) return false;
  }
  return true;
}

/**
 * A free spot inside the container and clear of the obstacles.
 *
 * Rejection sampling, because the region is whatever is left after subtracting
 * the windows from a hand-traced outline and there is no closed form for that.
 * Gives up rather than looping forever — a wall entirely covered by obstacles
 * is a legitimate thing to have traced.
 */
export function findFreeSpot(container, obstacles, rng, tries = 40) {
  const { bbox } = container;
  for (let i = 0; i < tries; i++) {
    const x = bbox.x + rng() * bbox.w;
    const y = bbox.y + rng() * bbox.h;
    if (isClear(container, obstacles, x, y)) return { x, y };
  }
  return { x: bbox.cx, y: bbox.cy };
}

/**
 * The nearest obstacle surface within `range`, or null.
 *
 * This is what lets a growing tip *follow* a window frame rather than merely
 * avoid it: knowing how far away the surface is and which way it runs, a tip
 * can be steered along the tangent, and the strength of that steering can be
 * faded with distance so it lets go naturally at the corner.
 */
export function nearestSurface(obstacles, x, y, range) {
  let best = null;
  for (const o of obstacles) {
    const { bbox } = o;
    if (
      x < bbox.x - range
      || x > bbox.x + bbox.w + range
      || y < bbox.y - range
      || y > bbox.y + bbox.h + range
    ) continue;
    const s = surfaceNormal(o.points, x, y);
    if (s.dist < range && (!best || s.dist < best.dist)) {
      best = { ...s, shape: o, inside: pointInPolygon({ x, y }, o.points) };
    }
  }
  return best;
}
