/**
 * A depth scan, as part of a show.
 *
 * `core/depth.js` turns a phone scan into a relief map: an orthographic, metric
 * picture of how far each point of the facade stands in front of or behind the
 * wall's own plane. This file is the other half — what the app does with one.
 * Three jobs, and they are separate on purpose:
 *
 *  - **Keeping it.** The relief map is half a megabyte of floats, which is two
 *    orders of magnitude past what belongs in localStorage. It goes to IndexedDB
 *    beside the traced still, and every tab reads its own copy. See `encodeRelief`.
 *
 *  - **Placing it.** The scan knows the wall's shape but not where that wall is
 *    in the camera's picture, and nothing in a mesh can tell you. Four points do.
 *    The quad is marked on the camera image and stored there — camera space is
 *    the one frame of reference that does not move when the wall is squared up,
 *    which is the same reason calibration lives there. See `scanMatrix`.
 *
 *  - **Handing it to effects.** Effects work in world pixels and know nothing of
 *    metres or wall planes. `buildDepthField` resamples the relief into world
 *    space once, carrying the surface normal and the wall coordinates of every
 *    pixel with it, so an effect can ask "what is the surface doing here" with
 *    an array lookup rather than a matrix multiply. See `depthField`.
 *
 * The third one is where the subtlety is. World space is only metric once the
 * wall has been squared up; before that it is the camera image, and a normal
 * differentiated from a perspective-warped heightfield is wrong by a factor that
 * varies across the picture. So normals are computed in the relief's own metric
 * frame and *resampled* rather than recomputed, and each world pixel carries the
 * wall coordinates it came from. Lighting then happens in metres whatever world
 * space happens to be this week.
 */

import { mat3Inverse, applyH, solveHomography } from './math.js';
import { rectifyInverse, rectifyMatrix } from './rectify.js';
import { createRelief, normalsFromRelief, isSeen, occlusion } from './depth.js';

/** IndexedDB key. One scan per show, like the still. */
export const scanKey = (projectId) => `scan/${projectId}`;

export function createScan() {
  return {
    /** False until a relief map has been imported and placed. */
    enabled: false,
    /** Relief raster size and metres per pixel, mirrored here so the panel can
     *  describe the scan without loading half a megabyte to do it. */
    w: 0,
    h: 0,
    scale: 0,
    /** Where the relief map's corners sit on the camera picture, clockwise from
     *  top-left. Camera space, for the reason in the header. */
    quad: null,
    /** relief (0..1) -> camera (0..1), solved from `quad`. */
    H: null,
    /** Relief threshold for tracing openings, in metres. */
    threshold: 0.02,
    /** Provenance, for the panel and for knowing whether the blob is stale. */
    name: '',
    triangles: 0,
    importedAt: 0,
  };
}

/** The four corners of the relief map, as a starting quad to drag. */
export function defaultScanQuad(aspect = 1.3, cameraAspect = 16 / 9) {
  // Sized to sit inside the frame at the scan's own aspect, so the first drag is
  // a nudge rather than a reshape.
  const h = 0.62;
  const w = Math.min(0.86, (h * aspect) / cameraAspect);
  const x = (1 - w) / 2;
  const y = (1 - h) / 2;
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

/** Solve relief (0..1) -> camera (0..1) from a marked quad. */
export function solveScanPlacement(quad) {
  if (!Array.isArray(quad) || quad.length !== 4) return null;
  if (quad.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
  const H = solveHomography(
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
    quad.map((p) => ({ x: p.x, y: p.y }))
  );
  return H && mat3Inverse(H) ? H : null;
}

/** The project's relief -> camera matrix, or null when there is no placed scan. */
export function scanMatrix(project) {
  const scan = project?.scan;
  return scan?.enabled && Array.isArray(scan.H) && scan.H.length === 9 ? scan.H : null;
}

/** A point in relief coordinates (0..1), expressed in world coordinates (0..1). */
export function reliefToWorld(project, x, y) {
  const H = scanMatrix(project);
  if (!H) return null;
  const cam = applyH(H, x, y);
  if (!cam) return null;
  const inv = rectifyInverse(project);
  if (!inv) return cam;
  return applyH(inv, cam.x, cam.y) || cam;
}

/* ------------------------------------------------------------------ *
 * Storage
 *
 * A raw little-endian header and then the floats. Not a PNG: the values are
 * signed metres over a range nobody can predict, NaN is load-bearing for "the
 * scan saw nothing here", and quantising to eight bits would put the noise floor
 * at about a millimetre — the same order as the brickwork this is supposed to
 * see past. Half a megabyte in IndexedDB is not worth being clever about.
 * ------------------------------------------------------------------ */

const MAGIC = 0x464d524c; // 'FMRL'
const FORMAT = 1;
const HEADER_BYTES = 20;

export function encodeRelief(relief) {
  const buffer = new ArrayBuffer(HEADER_BYTES + relief.data.byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, FORMAT, true);
  view.setUint32(8, relief.w, true);
  view.setUint32(12, relief.h, true);
  view.setFloat32(16, relief.scale, true);
  new Float32Array(buffer, HEADER_BYTES).set(relief.data);
  return new Blob([buffer], { type: 'application/octet-stream' });
}

export async function decodeRelief(blob) {
  if (!blob) return null;
  const buffer = await blob.arrayBuffer();
  if (buffer.byteLength < HEADER_BYTES) return null;
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== FORMAT) return null;

  const w = view.getUint32(8, true);
  const h = view.getUint32(12, true);
  const scale = view.getFloat32(16, true);
  if (!(w > 1) || !(h > 1) || !(scale > 0)) return null;
  if (buffer.byteLength < HEADER_BYTES + w * h * 4) return null;

  const relief = createRelief(w, h, { scale });
  relief.data.set(new Float32Array(buffer, HEADER_BYTES, w * h));
  return relief;
}

/* ------------------------------------------------------------------ *
 * The field effects see
 * ------------------------------------------------------------------ */

/** Working resolution of the world-space field, in pixels across. */
const FIELD_WIDTH = 480;

/**
 * Resample the relief into world space, carrying its normals and its metres.
 *
 * Bilinear on the relief and nearest on the normals, which sounds
 * inconsistent and is deliberate: interpolating a relief across the lip of a
 * window reveal produces a plausible ramp, and interpolating the normals across
 * the same lip produces a direction that points nowhere on the building. The
 * reveal is one pixel of the field wide and the normal there should be the
 * reveal's, not an average of the reveal's and the glass's.
 */
export function buildDepthField(relief, project, world) {
  const H = scanMatrix(project);
  if (!relief || !H) return null;

  // world (0..1) -> camera -> relief.
  const toCamera = rectifyMatrix(project);
  const fromCamera = mat3Inverse(H);
  if (!fromCamera) return null;

  const aspect = world.w / world.h;
  const w = FIELD_WIDTH;
  const h = Math.max(2, Math.round(FIELD_WIDTH / aspect));

  const depth = new Float32Array(w * h);
  const normal = new Float32Array(w * h * 3);
  const wallX = new Float32Array(w * h);
  const wallY = new Float32Array(w * h);
  const normals = normalsFromRelief(relief);
  let seen = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      depth[i] = NaN;

      // Centre of the field cell, in world 0..1.
      let u = (x + 0.5) / w;
      let v = (y + 0.5) / h;
      if (toCamera) {
        const cam = applyH(toCamera, u, v);
        if (!cam) continue;
        u = cam.x;
        v = cam.y;
      }
      const r = applyH(fromCamera, u, v);
      if (!r || r.x < 0 || r.y < 0 || r.x >= 1 || r.y >= 1) continue;

      const fx = r.x * relief.w - 0.5;
      const fy = r.y * relief.h - 0.5;
      const value = sampleBilinear(relief, fx, fy);
      if (!isSeen(value)) continue;

      const nx = Math.min(relief.w - 1, Math.max(0, Math.round(fx)));
      const ny = Math.min(relief.h - 1, Math.max(0, Math.round(fy)));
      const n = (ny * relief.w + nx) * 3;

      depth[i] = value;
      normal[i * 3] = normals[n];
      // Relief normals are y-up on the wall; everything downstream of here is a
      // canvas, where y runs down. Flipping once, here, is what stops every
      // effect having to remember to.
      normal[i * 3 + 1] = -normals[n + 1];
      normal[i * 3 + 2] = normals[n + 2];
      wallX[i] = r.x * relief.w * relief.scale;
      wallY[i] = r.y * relief.h * relief.scale;
      seen++;
    }
  }

  return {
    w,
    h,
    depth,
    normal,
    wallX,
    wallY,
    seen,
    coverage: seen / (w * h),
    /** World pixels per field cell, so an effect can step at the right rate. */
    stepX: world.w / w,
    stepY: world.h / h,
  };
}

/** Bilinear sample of a relief, refusing to interpolate across an unseen cell. */
function sampleBilinear(relief, fx, fy) {
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  let total = 0;
  let weight = 0;
  for (let dy = 0; dy <= 1; dy++) {
    for (let dx = 0; dx <= 1; dx++) {
      const x = Math.min(relief.w - 1, Math.max(0, x0 + dx));
      const y = Math.min(relief.h - 1, Math.max(0, y0 + dy));
      const v = relief.data[y * relief.w + x];
      if (!isSeen(v)) continue;
      const wgt = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty);
      total += v * wgt;
      weight += wgt;
    }
  }
  // Mostly-unseen neighbourhoods are the ragged edge of the scan, and inventing
  // a surface there is how a wall grows a fringe of light along its own outline.
  return weight > 0.5 ? total / weight : NaN;
}

/**
 * The object handed to effects as `ctx.depth`.
 *
 * Deliberately a small set of questions rather than the arrays: an effect wants
 * to know what the surface is doing at a world pixel, and every one that reached
 * past this to the raster would have to know about the field's resolution, its
 * y convention and its unseen cells. Nothing stops them — `field` is right
 * there — but nothing requires it either.
 */
export function createDepthHandle(relief, field, world) {
  const cell = (x, y) => {
    const fx = (x / world.w) * field.w;
    const fy = (y / world.h) * field.h;
    if (fx < 0 || fy < 0 || fx >= field.w || fy >= field.h) return -1;
    return (fy | 0) * field.w + (fx | 0);
  };

  return {
    ready: true,
    relief,
    field,
    /** Metres the scan covers, across and down. */
    extent: { width: relief.w * relief.scale, height: relief.h * relief.scale },

    /** How far the surface stands out of the wall at a world pixel, in metres. */
    reliefAt(x, y) {
      const i = cell(x, y);
      return i < 0 ? NaN : field.depth[i];
    },

    /** Did the scan see this part of the world at all? */
    sees(x, y) {
      const i = cell(x, y);
      return i >= 0 && isSeen(field.depth[i]);
    },

    /**
     * Unit surface normal at a world pixel, y down, z out of the wall.
     * Written into `out` to keep this allocation-free in a per-pixel loop.
     */
    normalAt(x, y, out = [0, 0, 1]) {
      const i = cell(x, y);
      if (i < 0 || !isSeen(field.depth[i])) {
        out[0] = 0;
        out[1] = 0;
        out[2] = 1;
        return out;
      }
      out[0] = field.normal[i * 3];
      out[1] = field.normal[i * 3 + 1];
      out[2] = field.normal[i * 3 + 2];
      return out;
    },

    /**
     * Where this world pixel is on the wall, in metres from the scan's top-left
     * corner. The frame everything metric happens in — light positions, throw
     * distances, the shadow march.
     */
    wallAt(x, y, out = [0, 0, 0]) {
      const i = cell(x, y);
      if (i < 0) {
        out[0] = out[1] = out[2] = NaN;
        return out;
      }
      out[0] = field.wallX[i];
      out[1] = field.wallY[i];
      out[2] = field.depth[i];
      return out;
    },

    /** 0 lit, 1 shadowed. Wall metres throughout. See depth.occlusion. */
    shadow(x, y, z, lx, ly, lz, options) {
      return occlusion(relief, x, y, z, lx, ly, lz, options);
    },
  };
}

/**
 * A depth source for a tab: keeps one decoded relief and one resampled field,
 * and rebuilds only when something it depends on has actually changed.
 *
 * Both tabs need exactly this and neither should own it. The rebuild is a few
 * milliseconds over a quarter of a million cells, which is nothing once and
 * ruinous every frame — and `get()` is called every frame, by every layer.
 */
export function createScanSource({ onError = () => {}, onLoaded = () => {} } = {}) {
  let loadedFor = null;
  let relief = null;
  let handle = null;
  let signature = '';
  let pending = null;

  const describe = (project, world) => {
    const scan = project?.scan;
    if (!scan?.enabled) return '';
    // The matrix by identity rather than by value: `rectifyMatrix` memoises, so
    // identity changes exactly when the wall is re-squared.
    return `${scan.importedAt}|${JSON.stringify(scan.H)}|${world.w}x${world.h}|${rectifyMatrix(project) ? 'r' : '-'}`;
  };

  return {
    /**
     * Bring the source into line with a project. Cheap and idempotent; call it
     * whenever the project changes.
     */
    sync(project, world, load) {
      const scan = project?.scan;
      if (!scan?.enabled) {
        loadedFor = null;
        relief = null;
        handle = null;
        signature = '';
        return;
      }

      const key = `${project.id}|${scan.importedAt}`;
      if (loadedFor !== key && !pending) {
        pending = Promise.resolve(load(scanKey(project.id)))
          .then(async (blob) => {
            relief = await decodeRelief(blob);
            /**
             * Remembered as attempted either way.
             *
             * A show exported to a file and opened somewhere else says it has a
             * scan and has no blob to go with it — the JSON travels and half a
             * megabyte of IndexedDB does not. Recording only successes would
             * leave `sync` trying again on every frame, which is a failed read
             * and an error message sixty times a second. `reload()` is the way
             * back for the case where the bytes really have arrived since.
             */
            loadedFor = key;
            signature = '';
            if (!relief) {
              onError('This show expects a depth scan, but its relief map is not on this machine. Import the scan again.');
            }
            // Half a megabyte comes back from IndexedDB some frames after the
            // project said there was a scan, and anything that described the
            // scan in the meantime described it as still loading. The renderer
            // does not care — it asks again next frame — but a panel drawn once
            // would say "loading" until something else happened to redraw it.
            else onLoaded(relief);
          })
          .catch((err) => onError(`Could not load the depth scan: ${err.message}`))
          .finally(() => {
            pending = null;
          });
        return;
      }
      if (!relief) return;

      const next = describe(project, world);
      if (next !== signature) {
        signature = next;
        const field = buildDepthField(relief, project, world);
        handle = field ? createDepthHandle(relief, field, world) : null;
      }
    },

    /**
     * Forget what is loaded and pick it up again.
     *
     * For the case `sync` cannot see: the blob under a key changed while the
     * key did not. That is what a re-import in another tab looks like.
     */
    reload(project, world, load) {
      loadedFor = null;
      relief = null;
      handle = null;
      signature = '';
      this.sync(project, world, load);
    },

    /** The handle for effects, or null when this show has no usable scan. */
    get: () => handle,
    /** The decoded relief, for the control tab's own overlays. */
    reliefMap: () => relief,
  };
}
