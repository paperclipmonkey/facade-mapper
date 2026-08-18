/**
 * Wall space: undoing the camera's own point of view.
 *
 * Everything drawn in this app lives in *world* coordinates, and until now world
 * space was simply the camera image. That is exactly right for anything traced —
 * a window outline drawn over the picture of a window lands on that window, from
 * every angle, because both are features of the same plane. It is exactly wrong
 * for anything *generated*: a brick laid out on a regular grid in camera space is
 * a regular grid **as seen from the camera's optical centre** and nowhere else.
 * Stand anywhere but there and the courses fan out, because the camera's
 * foreshortening has been baked into the texture.
 *
 * The projector being off-axis was never the problem — calibration solves a
 * homography for that and the warp applies it exactly. The camera being off-axis
 * is the problem, and nothing was undoing it.
 *
 * So: interpose a plane. The user marks one thing they know to be rectangular on
 * the building — a window, the door, a run of brick courses — and says what shape
 * it really is. Four point correspondences determine a homography, and that
 * homography is the camera's viewpoint, expressed as a matrix. World space
 * becomes the wall seen square-on, and every projector's matrix becomes
 *
 *     world -> camera -> projector
 *
 * which is one 3x3 multiply. The renderer does not change at all; it is handed a
 * different matrix and carries on.
 *
 * There is one thing you cannot get around: a single photograph of a plane does
 * not determine that plane's shape. Any quadrilateral in the image is the
 * projection of infinitely many rectangles at infinitely many angles. Somebody
 * has to supply one fact from outside the picture, and asking for the aspect
 * ratio of something the user can point at is the cheapest honest way to ask.
 */

import { solveHomography, mat3Mul, mat3Inverse, applyH, applyH3, clamp } from './math.js';

/** How far past the marked rectangle world space is allowed to run, in reference widths. */
const MAX_SPAN = 4;

/** A starting quad to drag, sitting comfortably inside the frame. */
export function defaultRectifyQuad() {
  return [
    { x: 0.34, y: 0.32 },
    { x: 0.66, y: 0.32 },
    { x: 0.66, y: 0.68 },
    { x: 0.34, y: 0.68 },
  ];
}

export function createRectify() {
  return {
    enabled: false,
    /** The marked rectangle, in normalised camera coordinates, clockwise from top-left. */
    quad: null,
    /** What that rectangle really is, as width / height. */
    aspect: 1,
    /** The two numbers the user actually typed, so the fields round-trip. */
    width: 1,
    height: 1,
    /**
     * world (0..1 in both axes) -> camera (0..1 in both axes).
     *
     * Stored rather than recomputed on load, and deliberately so: every shape in
     * the project is expressed against this matrix. Re-deriving it from the quad
     * at load time would mean a change to the solver silently moving somebody's
     * traced windows.
     */
    H: null,
    /** Aspect ratio of world space once rectified, for `worldSize`. */
    worldAspect: 16 / 9,
    /** The camera's aspect when the quad was marked, so the tool can letterbox it. */
    cameraAspect: 16 / 9,
  };
}

/* ------------------------------------------------------------------ *
 * Solving
 * ------------------------------------------------------------------ */

/**
 * How much of the wall the camera can see, in metric wall units.
 *
 * Walking the camera frame's border through the inverse rather than just its
 * four corners, because the border bows: at any real obliquity the straight
 * edges of the image are straight lines on the wall, but which part of them
 * bounds the footprint is not a corner question.
 *
 * The horizon is the hazard. The wall plane's vanishing line can cross the
 * camera frame — it does at anything past about 45 degrees — and points near it
 * map arbitrarily far away. Sampling with a sign test drops the part of the
 * image that is looking at the back of the plane, and the clamp afterwards stops
 * the surviving part from stretching world space into a strip in which the
 * building occupies four pixels.
 */
function footprint(inv, aspect) {
  const reference = { x: 0, y: 0, w: aspect, h: 1 };
  const fallback = {
    x: -aspect * 0.35,
    y: -0.35,
    w: aspect * 1.7,
    h: 1.7,
  };
  if (!inv) return fallback;

  const centre = applyH3(inv, 0.5, 0.5);
  if (!Number.isFinite(centre[2]) || Math.abs(centre[2]) < 1e-9) return fallback;
  const sign = Math.sign(centre[2]);

  const STEPS = 40;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let kept = 0;

  const consider = (u, v) => {
    const [hx, hy, hw] = applyH3(inv, u, v);
    // Same side of the horizon as the centre, and not sitting on it.
    if (!Number.isFinite(hw) || hw * sign < 1e-4) return;
    const x = hx / hw;
    const y = hy / hw;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    kept++;
  };

  for (let i = 0; i <= STEPS; i++) {
    const f = i / STEPS;
    consider(f, 0);
    consider(f, 1);
    consider(0, f);
    consider(1, f);
  }
  if (kept < 3) return fallback;

  // Never let a near-horizon sample push the frame out to where the marked
  // rectangle is a speck. Four reference widths each way is already generous.
  minX = clamp(minX, reference.x - MAX_SPAN * reference.w, reference.x);
  maxX = clamp(maxX, reference.x + reference.w, reference.x + (1 + MAX_SPAN) * reference.w);
  minY = clamp(minY, reference.y - MAX_SPAN * reference.h, reference.y);
  maxY = clamp(maxY, reference.y + reference.h, reference.y + (1 + MAX_SPAN) * reference.h);

  const w = maxX - minX;
  const h = maxY - minY;
  if (!(w > 1e-6) || !(h > 1e-6)) return fallback;
  return { x: minX, y: minY, w, h };
}

/**
 * Turn a marked rectangle into a world -> camera homography.
 *
 * @param {object} options
 *   quad         four points in normalised camera coordinates, clockwise from top-left
 *   aspect       the real width / height of the thing those points sit on
 *   cameraAspect the camera's own aspect, carried through for the editing tool
 * @returns {{H:number[], worldAspect:number, extent:object}|null}
 */
export function solveRectify({ quad, aspect = 1, cameraAspect = 16 / 9 } = {}) {
  if (!Array.isArray(quad) || quad.length !== 4) return null;
  if (!(aspect > 0.02) || !(aspect < 50)) return null;
  if (quad.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;

  // Metric wall units: the marked rectangle is `aspect` wide and 1 high, which
  // makes the units square — the whole point of the exercise.
  const src = [
    { x: 0, y: 0 },
    { x: aspect, y: 0 },
    { x: aspect, y: 1 },
    { x: 0, y: 1 },
  ];
  const metric = solveHomography(src, quad.map((p) => ({ x: p.x, y: p.y })));
  if (!metric) return null;
  const inv = mat3Inverse(metric);
  if (!inv) return null;

  const extent = footprint(inv, aspect);

  // world (0..1) -> metric wall. A plain scale-and-offset, but it has to travel
  // as a matrix so it can be composed with the rest.
  const place = [extent.w, 0, extent.x, 0, extent.h, extent.y, 0, 0, 1];
  const H = mat3Mul(metric, place);
  if (!mat3Inverse(H)) return null;

  return {
    H,
    // Metric units are square, so the ratio of the extents is the true aspect
    // of the wall world space now covers.
    worldAspect: extent.w / extent.h,
    extent,
    cameraAspect,
  };
}

/* ------------------------------------------------------------------ *
 * Lookups
 * ------------------------------------------------------------------ */

/** The project's world -> camera matrix, or null when world space *is* camera space. */
export function rectifyMatrix(project) {
  const r = project?.rectify;
  return r?.enabled && Array.isArray(r.H) && r.H.length === 9 ? r.H : null;
}

/**
 * The inverse, memoised.
 *
 * Inverting a 3x3 is not expensive, but this is asked for per point while
 * remapping a whole project and per frame while the squaring tool is open.
 */
const inverses = new WeakMap();
export function rectifyInverse(project) {
  const H = rectifyMatrix(project);
  if (!H) return null;
  let inv = inverses.get(H);
  if (inv === undefined) {
    inv = mat3Inverse(H);
    inverses.set(H, inv);
  }
  return inv;
}

/**
 * The matrix a projector actually renders with: world -> projector.
 *
 * Calibration measures camera -> projector and that is what gets stored, because
 * it is a property of where the lamp is standing and has nothing to do with how
 * world space happens to be defined this week. Re-squaring the wall must not
 * invalidate an alignment somebody stood in the dark for.
 *
 * Memoised on the stored matrix's identity, and that is load-bearing rather than
 * an optimisation: `warp.buildMesh` rejects a rebuild by comparing its arguments
 * by identity, so handing it a freshly multiplied array every frame would rebuild
 * the warp mesh sixty times a second.
 */
const composed = new WeakMap();
export function worldToProjector(project, projector) {
  const H = projector?.calibration?.H;
  if (!Array.isArray(H) || H.length !== 9) return null;
  const R = rectifyMatrix(project);
  if (!R) return H;

  let entry = composed.get(H);
  if (!entry || entry.R !== R) {
    entry = { R, M: mat3Mul(H, R) };
    composed.set(H, entry);
  }
  return entry.M;
}

/* ------------------------------------------------------------------ *
 * Moving points between the two spaces
 * ------------------------------------------------------------------ */

export function worldToCamera(project, point) {
  const H = rectifyMatrix(project);
  if (!H) return { x: point.x, y: point.y };
  return applyH(H, point.x, point.y) || { x: point.x, y: point.y };
}

export function cameraToWorld(project, point) {
  const inv = rectifyInverse(project);
  if (!inv) return { x: point.x, y: point.y };
  return applyH(inv, point.x, point.y) || { x: point.x, y: point.y };
}

/**
 * Re-express a point that was authored against one world space in another.
 *
 * `from` and `to` are world -> camera matrices, either of which may be null for
 * "world space was the camera image". Camera space is the common ground: it is
 * the one frame of reference that does not move when the wall is re-squared.
 */
export function remapPoint(point, from, to) {
  let x = point.x;
  let y = point.y;
  if (from) {
    const c = applyH(from, x, y);
    if (!c) return { x, y };
    x = c.x;
    y = c.y;
  }
  if (to) {
    const inv = mat3Inverse(to);
    if (!inv) return { x, y };
    const w = applyH(inv, x, y);
    if (!w) return { x, y };
    x = w.x;
    y = w.y;
  }
  return { x, y };
}

/** `remapPoint` over a list, with the inverse taken once. */
export function remapPoints(points, from, to) {
  const inv = to ? mat3Inverse(to) : null;
  return points.map((p) => {
    let x = p.x;
    let y = p.y;
    if (from) {
      const c = applyH(from, x, y);
      if (c) {
        x = c.x;
        y = c.y;
      }
    }
    if (inv) {
      const w = applyH(inv, x, y);
      if (w) {
        x = w.x;
        y = w.y;
      }
    }
    return { ...p, x, y };
  });
}
