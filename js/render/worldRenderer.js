/**
 * Draws the show into a 2D canvas in *world* coordinates.
 *
 * Both the control tab's preview and every projector tab use this same function,
 * which is the point: what you see while editing is produced by exactly the code
 * that drives the projectors. The only difference is the region of world space
 * being rendered — the preview shows all of it, a projector shows just the part
 * its lens can reach.
 *
 * Effects receive coordinates in world pixels (a virtual 1920-wide frame),
 * regardless of the actual canvas resolution, so a line width of 6 means the
 * same thing everywhere.
 */

import { boundingBox, buildPathSampler, smoothPolyline, polygonCentroid, makeRng } from '../core/math.js';
import { worldSize, resolveTargets } from '../core/state.js';
import { createNoise } from '../core/noise.js';
import { resolveParams } from '../core/modulators.js';
import { getEffect } from '../effects/registry.js';
import { effectiveLayers } from '../core/scenes.js';

/* ------------------------------------------------------------------ *
 * Geometry cache
 *
 * Path2D objects and arc-length tables are expensive relative to a frame, and a
 * shape usually changes only when someone drags a vertex. Cache on a cheap hash
 * of the geometry rather than on a revision counter, so nothing can go stale if
 * a caller forgets to bump it.
 * ------------------------------------------------------------------ */

function geometryHash(shape, w, h) {
  let hash = (shape.points.length * 2654435761) >>> 0;
  for (const pt of shape.points) {
    hash = (Math.imul(hash ^ ((pt.x * 65536) | 0), 2246822519) + 0x9e3779b9) >>> 0;
    hash = (Math.imul(hash ^ ((pt.y * 65536) | 0), 3266489917) + 0x85ebca6b) >>> 0;
  }
  return `${hash}|${shape.closed ? 1 : 0}|${shape.smooth ? 1 : 0}|${w}x${h}`;
}

export function createGeometryCache() {
  const cache = new Map();

  /** Resolve a stored shape into render-ready geometry in world pixels. */
  function get(shape, world) {
    const key = geometryHash(shape, world.w, world.h);
    const existing = cache.get(shape.id);
    if (existing && existing.key === key) return existing.geo;

    const raw = shape.points.map((p) => ({ x: p.x * world.w, y: p.y * world.h }));
    const points = shape.smooth && raw.length > 2 ? smoothPolyline(raw, shape.closed) : raw;

    const path = new Path2D();
    if (points.length) {
      path.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) path.lineTo(points[i].x, points[i].y);
      if (shape.closed) path.closePath();
    }

    const geo = {
      id: shape.id,
      name: shape.name,
      tags: shape.tags || [],
      closed: !!shape.closed,
      points,
      path,
      bbox: boundingBox(points),
      centroid: shape.closed ? polygonCentroid(points) : boundingBox(points),
      sampler: buildPathSampler(points, shape.closed),
    };

    cache.set(shape.id, { key, geo });
    return geo;
  }

  function prune(validIds) {
    for (const id of [...cache.keys()]) if (!validIds.has(id)) cache.delete(id);
  }

  return { get, prune, clear: () => cache.clear() };
}

/** A stand-in shape covering the whole frame, for global and untargeted layers. */
function frameShape(world) {
  const points = [
    { x: 0, y: 0 },
    { x: world.w, y: 0 },
    { x: world.w, y: world.h },
    { x: 0, y: world.h },
  ];
  const path = new Path2D();
  path.rect(0, 0, world.w, world.h);
  return {
    id: '__frame__',
    name: 'Whole frame',
    tags: [],
    closed: true,
    points,
    path,
    bbox: boundingBox(points),
    centroid: { x: world.w / 2, y: world.h / 2 },
    sampler: buildPathSampler(points, true),
  };
}

/* ------------------------------------------------------------------ *
 * Renderer
 * ------------------------------------------------------------------ */

export function createWorldRenderer({ mediaPool, onEffectError, camera } = {}) {
  const geometry = createGeometryCache();
  const instanceState = new Map(); // "layerId:shapeId" -> { state, rng, noise }
  const reportedErrors = new Set();
  let frameShapeCache = null;
  let frameShapeKey = '';

  function getInstance(layerId, shapeId) {
    const key = `${layerId}:${shapeId}`;
    let inst = instanceState.get(key);
    if (!inst) {
      // Seeded from the identity of the pairing, so the same window shows the
      // same flame in every tab and across reloads.
      inst = { state: {}, rng: makeRng(key), noise: createNoise(key), initialised: false };
      instanceState.set(key, inst);
    }
    return inst;
  }

  /** Reset an effect's accumulated state, e.g. after its effect type changes. */
  function resetLayer(layerId) {
    for (const key of [...instanceState.keys()]) {
      if (key.startsWith(`${layerId}:`)) instanceState.delete(key);
    }
  }

  function reportError(layerId, effectId, err) {
    const key = `${layerId}:${err.message}`;
    if (reportedErrors.has(key)) return;
    reportedErrors.add(key);
    console.error(`[effect ${effectId}]`, err);
    onEffectError?.({ layerId, effectId, message: err.message });
  }

  /**
   * @param {CanvasRenderingContext2D} g
   * @param {object} opts
   *   project    - the project to draw
   *   time       - { t, dt, beat, beatPhase, bpm }
   *   audio      - { level, low, mid, high }
   *   region     - { x, y, w, h } in normalised world units; defaults to the full frame
   *   pixelSize  - { w, h } of the target canvas
   *   preview    - true in the control tab (skips blackout so you can still work)
   */
  function render(g, { project, time, audio, region, pixelSize, preview = false }) {
    const world = worldSize(project);
    const settings = project.settings || {};

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, pixelSize.w, pixelSize.h);

    if (settings.blackout && !preview) return;

    const roi = region || { x: 0, y: 0, w: 1, h: 1 };
    // World pixels -> canvas pixels for this projector's slice of the frame.
    const scaleX = pixelSize.w / (roi.w * world.w);
    const scaleY = pixelSize.h / (roi.h * world.h);
    g.setTransform(scaleX, 0, 0, scaleY, -roi.x * world.w * scaleX, -roi.y * world.h * scaleY);

    if (frameShapeKey !== `${world.w}x${world.h}`) {
      frameShapeCache = frameShape(world);
      frameShapeKey = `${world.w}x${world.h}`;
    }

    const layers = effectiveLayers(project).filter((l) => l.enabled !== false);
    const soloed = layers.filter((l) => l.solo);
    const ordered = (soloed.length ? soloed : layers)
      .slice()
      .sort((a, b) => (a.order || 0) - (b.order || 0));

    const master = preview ? 1 : (settings.master ?? 1);
    const validShapeIds = new Set(project.shapes.map((s) => s.id));
    geometry.prune(validShapeIds);

    for (const layer of ordered) {
      const effect = getEffect(layer.effect);
      if (!effect) continue;

      const shapes = project.shapes.length ? resolveTargets(project, layer) : [];
      // Global effects always paint the whole frame; a shape effect with no
      // targets does too, which is how "snow over everything" works.
      const targets =
        effect.scope === 'global' || !shapes.length
          ? [frameShapeCache]
          : shapes.map((s) => geometry.get(s, world));

      const n = targets.length;
      for (let i = 0; i < n; i++) {
        const shape = targets[i];
        const inst = getInstance(layer.id, shape.id);

        // Stagger shifts each instance back in time, so a row of windows pulses
        // in sequence instead of together.
        const stagger = (layer.stagger || 0) * i;
        const t = time.t - stagger;
        const beat = time.beat - (stagger * (time.bpm || 120)) / 60;

        const ctx = {
          g,
          t,
          dt: time.dt,
          beat,
          beatPhase: beat - Math.floor(beat),
          bpm: time.bpm,
          audio: audio || { level: 0, low: 0, mid: 0, high: 0 },
          i,
          n,
          shape,
          world,
          layer,
          state: inst.state,
          rng: inst.rng,
          noise: inst.noise,
          media: (id) => mediaPool?.get(id) ?? null,
          camera: () => camera?.() ?? null,
          preview,
        };

        ctx.p = resolveParams(effect, layer, ctx);

        if (!inst.initialised) {
          inst.initialised = true;
          if (effect.init) {
            try {
              const initial = effect.init(ctx);
              if (initial && typeof initial === 'object') Object.assign(inst.state, initial);
            } catch (err) {
              reportError(layer.id, effect.id, err);
              continue;
            }
          }
        }

        g.save();
        g.globalAlpha = (layer.opacity ?? 1) * master;
        g.globalCompositeOperation = layer.blend || 'source-over';
        // Reset the drawing state effects tend to assume is fresh.
        g.lineWidth = 1;
        g.lineCap = 'butt';
        g.lineJoin = 'miter';
        g.textAlign = 'start';
        g.textBaseline = 'alphabetic';
        g.setLineDash([]);
        g.lineDashOffset = 0;
        g.shadowBlur = 0;
        g.shadowColor = 'transparent';
        if ('filter' in g) g.filter = 'none';

        try {
          effect.draw(ctx);
        } catch (err) {
          reportError(layer.id, effect.id, err);
        }
        g.restore();
      }
    }

    g.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Drop cached state for layers and shapes that no longer exist. */
  function gc(project) {
    const layerIds = new Set(project.layers.map((l) => l.id));
    const shapeIds = new Set(project.shapes.map((s) => s.id));
    shapeIds.add('__frame__');
    for (const key of [...instanceState.keys()]) {
      const [layerId, shapeId] = key.split(':');
      if (!layerIds.has(layerId) || !shapeIds.has(shapeId)) instanceState.delete(key);
    }
    if (reportedErrors.size > 200) reportedErrors.clear();
  }

  return { render, gc, resetLayer, geometry, clearErrors: () => reportedErrors.clear() };
}
