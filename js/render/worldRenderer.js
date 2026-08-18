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
 *
 * ## Why the same show looks the same in every tab
 *
 * Two projectors overlapping on one wall have to paint the same animation into
 * the shared band, and a tab is not allowed to have an opinion about what the
 * show is doing. Nothing here may depend on how fast the tab happens to be
 * rendering. Three things used to, and all three are dealt with below:
 *
 *  - **When a layer came on.** Was stamped from the first frame *this tab*
 *    drew the instance, so a projector tab opened ten minutes in thought every
 *    layer had just started. Now derived from the project, which every tab has
 *    the same copy of. See `sharedEnabledAt`.
 *  - **Where the random sequence is up to.** Was one free-running generator per
 *    instance, advanced by every call inside `draw` — so a 60fps tab was twice
 *    as far along it as a 30fps tab. Now reseeded from the simulation step, so
 *    the same show time draws the same numbers. See `SIM_HZ`.
 *  - **How the simulation advanced.** Was integrated with whatever `dt` the tab
 *    managed, and a spawn test like `rng() < rate * dt` does not give the same
 *    answers from a different sequence of steps even when they sum to the same
 *    elapsed time. Now effects may declare `step(ctx)`, which runs at a fixed
 *    rate: by show time t exactly `floor(age * SIM_HZ)` steps have been taken,
 *    in every tab, whatever its frame rate.
 *
 * An effect with no `step` is unaffected and runs exactly as before — which is
 * right for the great majority of them, because a function of `t`, `beat`,
 * `noise` and the shape is already identical everywhere.
 */

import { boundingBox, buildPathSampler, smoothPolyline, polygonCentroid, makeRng } from '../core/math.js';
import { worldSize, resolveTargets } from '../core/state.js';
import { createNoise } from '../core/noise.js';
import { resolveParams, baseParams } from '../core/modulators.js';
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

/**
 * The rate the simulation runs at, regardless of the frame rate.
 *
 * Sixty because that is what the effects were authored against, so migrating one
 * from a per-frame `dt` to a fixed step changes nothing about how it looks on a
 * machine that was keeping up.
 */
const SIM_HZ = 60;

/**
 * How far a frame is allowed to catch up, and where it restarts if it cannot.
 *
 * A tab opened an hour into a show is 216,000 steps behind, and there is no
 * honest way to run those: it starts cold instead, warms up for a second and a
 * half, and is out of phase with the tabs that have been running until that
 * layer next restarts. That is the one case this scheme does not cover, and
 * covering it would mean one tab broadcasting its state to the others.
 *
 * The catch-up allowance is generous enough to absorb a backgrounded tab
 * returning, a long paint, or a project reload — the cases where the tab really
 * is only a moment behind and should quietly close the gap rather than reset.
 */
const MAX_CATCHUP_STEPS = SIM_HZ * 10;
const COLD_START_STEPS = Math.round(SIM_HZ * 1.5);

/**
 * How far `enabledAt` may move before it counts as the layer being re-fired.
 *
 * Generous on purpose. The value comes from a wall-clock stamp carried in the
 * project, converted through the show clock, and a few milliseconds of drift
 * between the two is not somebody pressing a trigger.
 */
const RETRIGGER_SLACK = 0.05;

/**
 * Show-time seconds for a wall-clock stamp carried in the project.
 *
 * Scene changes and layer switch-ons are recorded as `Date.now()`, because that
 * is what the code doing the recording has to hand and it survives the show
 * clock being paused or scrubbed. Effects want show time. Every tab computes
 * the same answer because every tab agrees on both numbers.
 */
function showTimeOf(wallMs, time) {
  if (!wallMs) return null;
  return time.t - (time.wall - wallMs / 1000);
}

/* ------------------------------------------------------------------ *
 * Renderer
 * ------------------------------------------------------------------ */

export function createWorldRenderer({ mediaPool, onEffectError, camera, depth } = {}) {
  const geometry = createGeometryCache();
  /**
   * Scratch buffer for layers that ask to be softened.
   *
   * Blurring by setting ctx.filter around the effect's draw would blur every
   * individual draw call — hundreds of them for a particle effect, and each one
   * a separate filter pass. Rendering the layer here first means exactly one
   * blur per layer regardless of how it is drawn.
   */
  let scratch = null;
  let scratchCtx = null;

  function getScratch(w, h) {
    if (!scratch) {
      scratch = document.createElement('canvas');
      scratchCtx = scratch.getContext('2d');
    }
    if (scratch.width !== w || scratch.height !== h) {
      scratch.width = w;
      scratch.height = h;
    }
    return scratchCtx;
  }

  const instanceState = new Map(); // "layerId:effectId:shapeId" -> { state, rng, noise }
  const reportedErrors = new Set();
  /** Values effects publish for each other. See `share` in the draw context. */
  const share = new Map();
  /** `show.sceneChangeAt` as of the last frame, to spot a scene being re-fired. */
  let lastSceneAt = null;
  let frameShapeCache = null;
  let frameShapeKey = '';

  /**
   * Per-instance state, keyed by the layer, the effect *and* the shape.
   *
   * The effect id belongs in the key. Without it, switching a layer from Snow
   * to Fire hands Fire the pile of flakes Snow left behind — the control tab
   * calls `resetLayer` to paper over that, but a projector tab only ever
   * receives the new project and has nothing to call. Including the effect
   * makes the state unreachable the moment the effect changes, in every tab,
   * with no bookkeeping.
   */
  function getInstance(layerId, shapeId, effectId) {
    const key = `${layerId}:${effectId}:${shapeId}`;
    let inst = instanceState.get(key);
    if (!inst) {
      // Seeded from the identity of the pairing, so the same window shows the
      // same flame in every tab and across reloads.
      //
      // No `rng` here any more. A generator created once and left to run is a
      // position in a sequence, and the position depends on how many frames the
      // tab has drawn — which is the one thing tabs disagree about. It is
      // reseeded per simulation step instead, from `key` and the step index.
      inst = { key, state: {}, noise: createNoise(key), initialised: false,
        /** Show time at which this layer was last switched on. See `age`. */
        enabledAt: null,
        /** Simulation steps taken since then. See `SIM_HZ`. */
        step: 0 };
      instanceState.set(key, inst);
    }
    inst.usedAt = generation;
    return inst;
  }

  /** Reset an effect's accumulated state, e.g. after its effect type changes. */
  function resetLayer(layerId) {
    for (const key of [...instanceState.keys()]) {
      if (key.startsWith(`${layerId}:`)) instanceState.delete(key);
    }
  }

  /**
   * Frames rendered, used to age out instance state.
   *
   * The control tab prunes explicitly when the project changes, but a projector
   * tab has no such hook — it is handed a new project several times a second
   * and renders it. Every layer you delete, every effect you swap, every shape
   * you retrace leaves its instance behind, holding whatever that effect
   * allocated: particle arrays, a frost bitmap, an ivy canvas. Over an evening
   * of tweaking that is the one thing here that grows without limit and never
   * comes back. Anything untouched for a few seconds of frames is gone.
   */
  let generation = 0;
  const STALE_AFTER = 600;

  function sweepInstances() {
    if (generation % 300 !== 0) return;
    for (const [key, inst] of instanceState) {
      if (generation - (inst.usedAt ?? 0) > STALE_AFTER) instanceState.delete(key);
    }
  }

  /**
   * Report an effect that threw, once.
   *
   * Bounded, and deliberately so. The dedupe key includes the message, and an
   * effect whose message varies — anything interpolating a number — would
   * otherwise add an entry, log to the console and raise a notification on
   * *every frame*, which turns one broken effect into a tab that grinds to a
   * halt. The cap is what stops a slow leak becoming a fast one; the trim used
   * to live in `gc()`, which a running show never calls.
   */
  function reportError(layerId, effectId, err) {
    const key = `${layerId}:${err.message}`;
    if (reportedErrors.has(key)) return;
    if (reportedErrors.size > 200) reportedErrors.clear();
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
    generation++;
    sweepInstances();

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, pixelSize.w, pixelSize.h);

    if (settings.blackout && !preview) return;

    const roi = region || { x: 0, y: 0, w: 1, h: 1 };
    // World pixels -> canvas pixels for this projector's slice of the frame.
    const scaleX = pixelSize.w / (roi.w * world.w);
    const scaleY = pixelSize.h / (roi.h * world.h);
    const worldTransform = [
      scaleX, 0, 0, scaleY, -roi.x * world.w * scaleX, -roi.y * world.h * scaleY,
    ];
    g.setTransform(...worldTransform);

    if (frameShapeKey !== `${world.w}x${world.h}`) {
      frameShapeCache = frameShape(world);
      frameShapeKey = `${world.w}x${world.h}`;
    }

    /**
     * A scene firing replays whatever it switches on.
     *
     * Without this, pressing the same trigger twice does nothing the second
     * time: the scene is already active, so the layer never goes off and never
     * comes back on, so its clock never restarts. You had to switch to another
     * scene and back to get a burst to play again, which is not how anybody
     * expects a doorbell to behave.
     *
     * Driven from `show.sceneChangeAt`, which `activateScene` stamps on every
     * activation including a repeat, and which is part of the broadcast — so
     * the projector tabs replay in step rather than needing to be told
     * separately by a runtime only the control tab runs.
     *
     * Only layers the scene explicitly *enables*, so re-firing a scene cannot
     * quietly wipe the ivy or the frost that some other layer has spent the
     * evening accumulating.
     */
    const sceneAt = project.show?.sceneChangeAt ?? null;
    lastSceneAt = sceneAt;
    const active = (project.scenes || []).find((s) => s.id === project.show?.activeScene);
    const sceneEnables = new Set(
      Object.entries(active?.state || {})
        .filter(([, layerState]) => layerState?.enabled)
        .map(([layerId]) => layerId)
    );

    /**
     * When a layer came on, in show time, as every tab computes it.
     *
     * Read out of the project rather than remembered locally, which is the whole
     * point: a projector tab opened halfway through the evening has no history
     * to remember, and used to conclude that everything had just started — so
     * every one-shot fired again and every fade-in played again, on the wall,
     * while the control tab showed a show that had settled long ago.
     *
     * Two stamps can say a layer came on, and the later one wins. `layer.onAt`
     * is the control tab noticing the layer's own switch go up;
     * `show.sceneChangeAt` is a scene being fired, which counts as a switch-on
     * for the layers that scene enables — and counts again when the same scene
     * is re-fired, which is what makes pressing a trigger twice replay it.
     *
     * A layer that has simply always been on has neither stamp and gets zero:
     * its age is the age of the show, in every tab, rather than the age of
     * whichever window happens to be looking at it.
     */
    const enabledAtFor = (layer) => {
      const own = layer.onAt || 0;
      const scene = sceneEnables.has(layer.id) ? (sceneAt || 0) : 0;
      const wall = Math.max(own, scene);
      return wall ? (showTimeOf(wall, time) ?? 0) : 0;
    };

    const depthHandle = depth?.() ?? null;

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

      /**
       * The rest of the scene, for effects that have to know what else is out
       * there — collisions, mainly. Resolved lazily and memoised per layer,
       * because most effects never ask and the resolve is not free.
       *
       * The geometry cache hands back the same object for a shape that has not
       * moved, so callers can compare by identity to know when to rebuild
       * whatever they derived from it.
       */
      const sceneCache = new Map();
      const sceneShapes = (tag, exclude) => {
        const key = tag || '';
        let list = sceneCache.get(key);
        if (!list) {
          const wanted = key.trim().toLowerCase();
          list = project.shapes
            .filter((s) => !wanted || (s.tags || []).some((v) => String(v).toLowerCase() === wanted))
            .map((s) => geometry.get(s, world));
          sceneCache.set(key, list);
        }
        return exclude ? list.filter((geo) => geo.id !== exclude) : list;
      };

      /**
       * Opacity, blend and softness are *layer* properties, so they have to
       * survive whatever the effect does to the context.
       *
       * Setting `globalAlpha` before calling draw() only works for effects that
       * multiply into it. Most do not — they assign, because that is the
       * obvious thing to write — and the moment one does, the layer's Opacity
       * slider stops doing anything at all. Same for Blend against any effect
       * that sets its own composite operation, which every additive effect
       * does. Both controls looked broken, and were.
       *
       * The fix is to composite the layer as a *group*: draw it into a scratch
       * buffer where it can do as it likes, then blit that once with the
       * layer's alpha and blend. Canvas has no group opacity, so the buffer is
       * the mechanism.
       *
       * Once per *layer*, emphatically not once per target. Clearing and
       * blitting inside the target loop is the same picture and a completely
       * different cost: a Cobwebs layer pointed at five windows paid five
       * full-canvas clears and five full-canvas blits a frame instead of one,
       * and the bill grew every time you traced another window. On a facade
       * with a dozen windows and three such layers that is over sixty
       * full-frame operations a frame, for nothing. It is also *wrong* per
       * target when the blend is additive: five separate blits let the
       * overlapping parts of one layer add to themselves.
       */
      const softness = layer.softness || 0;
      const opacity = layer.opacity ?? 1;
      const blend = layer.blend || 'source-over';
      const useScratch = softness > 0 || opacity < 1 || blend !== 'source-over';
      let target = g;

      if (useScratch) {
        const sg = getScratch(pixelSize.w, pixelSize.h);
        sg.setTransform(1, 0, 0, 1, 0, 0);
        sg.clearRect(0, 0, pixelSize.w, pixelSize.h);
        sg.setTransform(...worldTransform);
        target = sg;
      }

      /**
       * The layer's parameters before modulation, for cache keys.
       *
       * Identical for every target and unchanged between frames unless somebody
       * moves a slider, so it is resolved once per layer rather than per shape.
       * See `baseParams` for why an effect must never key a cache on `p`.
       */
      const stable = baseParams(effect, layer);

      const n = targets.length;
      for (let i = 0; i < n; i++) {
        const shape = targets[i];
        const inst = getInstance(layer.id, shape.id, effect.id);

        // Stagger shifts each instance back in time, so a row of windows pulses
        // in sequence instead of together.
        const stagger = (layer.stagger || 0) * i;
        const t = time.t - stagger;
        const beat = time.beat - (stagger * (time.bpm || 120)) / 60;

        const ctx = {
          g: target,
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
          /** Reseeded per simulation step, just below. Never a running stream. */
          rng: null,
          noise: inst.noise,
          media: (id) => mediaPool?.get(id) ?? null,
          camera: () => camera?.() ?? null,
          /**
           * The building's actual surface, when a depth scan has been imported
           * and placed, and null otherwise.
           *
           * Every other way an effect can know about the facade — `shapes`,
           * `collide`, the obstacle helpers — knows its *outline*. This knows
           * its shape: how far each point stands out of the wall, which way it
           * faces, and where it is in metres. That is the difference between an
           * effect drawn on a wall and one that appears to be lit on it.
           *
           * Resolved once per frame rather than per instance: the handle is
           * rebuilt only when the scan or the world moves, and every layer
           * pointed at every window would otherwise ask for it again.
           *
           * See core/scan.js for the shape of it.
           */
          depth: depthHandle,
          // Every shape in the project, optionally filtered to one tag. Pass
          // the current shape's id as `exclude` so an effect does not collide
          // with the thing it is being drawn into.
          shapes: (tag, exclude) => sceneShapes(tag, exclude),
          /**
           * A notice board between layers.
           *
           * Effects are otherwise entirely independent, which is almost always
           * right — but two of them drawing the same brick wall have to agree
           * about where the bricks are, and making somebody type the same three
           * numbers into two panels and keep them in step is not a design, it
           * is a chore with a wrong answer waiting in it.
           *
           * Deliberately not cleared between frames. A publisher normally draws
           * first because it sits lower in the stack, but nothing enforces
           * that, and a reader that finds last frame's values is right about
           * everything that matters. Keyed by the publisher, so this cannot
           * become a general-purpose global by accident.
           */
          share,
          preview,
          /**
           * Seconds since this layer was switched on.
           *
           * The primitive that makes a one-shot possible. A trigger fires a
           * scene, the scene enables a layer, and the layer needs to know that
           * it has just started rather than that it has been running all
           * evening — otherwise a burst of bats is a swarm that has already
           * flown away by the time anyone rings the bell.
           *
           * It restarts every time the layer goes from off to on, so pressing
           * the key again replays it, which is the whole point of an
           * interactive effect. A layer that has simply always been on gets its
           * age from the first frame it drew, which is what an ambient effect
           * would want anyway.
           *
           * Set properly a few lines below, once the instance has been checked
           * for a gap and for a scene re-fire; this is only here so the shape of
           * the context object is obvious from reading it.
           */
          age: 0,
          /** Parameters *without* modulation. Key caches on this, never on `p`. */
          stable,
        };

        ctx.p = resolveParams(effect, layer, ctx);

        /**
         * The moment it came on — shifted by the stagger, like `t` itself, so a
         * row of windows still comes up in sequence.
         *
         * A change here means the layer was switched off and on again, or its
         * scene was re-fired. That restarts the simulation from step zero, which
         * is what makes pressing the same trigger twice replay the burst.
         */
        const enabledAt = enabledAtFor(layer) - stagger;
        /**
         * A slack tolerance, not an exact compare.
         *
         * This is derived from a wall-clock stamp and the show clock, and a
         * couple of milliseconds of disagreement between them means nothing.
         * Treating that as "the layer was switched on again" would restart the
         * simulation from step zero on every frame, so a stateful effect
         * switched on mid-show would never accumulate anything at all — it would
         * sit at one sixtieth of a second old for as long as it ran.
         */
        if (inst.enabledAt === null || Math.abs(inst.enabledAt - enabledAt) > RETRIGGER_SLACK) {
          inst.enabledAt = enabledAt;
          inst.step = 0;
        }
        inst.lastSeen = generation;
        ctx.age = Math.max(0, t - inst.enabledAt);

        if (!inst.initialised) {
          inst.initialised = true;
          ctx.rng = makeRng(`${inst.key}#0`);
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

        /**
         * Advance the simulation to where show time says it should be.
         *
         * The number of steps taken by a given show time is a property of the
         * show, not of the machine: `floor(age * SIM_HZ)`, every tab, whatever
         * frame rate it manages. That plus a generator reseeded from the step
         * index makes the whole simulation a pure function of the step number,
         * which is the only way two projectors can agree about where a brick
         * has fallen to.
         *
         * `draw` is still called exactly once, afterwards, with the real frame's
         * time — so nothing pays for extra painting, and an effect that
         * interpolates between steps still can.
         */
        const targetStep = Math.floor(ctx.age * SIM_HZ);
        if (!effect.step) {
          // Nothing to simulate, but the cursor still tracks show time — it is
          // what indexes the generator below, and an effect whose sparks stopped
          // moving because its seed stopped changing would be a poor trade.
          inst.step = targetStep;
        } else {
          if (targetStep - inst.step > MAX_CATCHUP_STEPS) {
            // Too far behind to run honestly. Start cold with a short warm-up.
            inst.step = Math.max(0, targetStep - COLD_START_STEPS);
          }
          const stepDt = 1 / SIM_HZ;
          ctx.dt = stepDt;
          // No canvas during simulation: `step` decides what happens, `draw`
          // decides what it looks like, and an effect that blurs the two would
          // paint its catch-up frames on top of each other.
          ctx.g = null;
          while (inst.step < targetStep) {
            inst.step++;
            ctx.age = inst.step * stepDt;
            ctx.t = inst.enabledAt + ctx.age;
            ctx.beat = (ctx.t * (time.bpm || 120)) / 60;
            ctx.beatPhase = ctx.beat - Math.floor(ctx.beat);
            ctx.rng = makeRng(`${inst.key}#${inst.step}`);
            try {
              effect.step(ctx);
            } catch (err) {
              reportError(layer.id, effect.id, err);
              break;
            }
          }
          // Back to the frame's own view of time, and its canvas, for the paint.
          ctx.g = target;
          ctx.t = t;
          ctx.dt = time.dt;
          ctx.beat = beat;
          ctx.beatPhase = beat - Math.floor(beat);
          ctx.age = Math.max(0, t - inst.enabledAt);
        }

        /**
         * Draw-time randomness is indexed too.
         *
         * An effect that scatters sparks without remembering them still has to
         * scatter the *same* sparks in both tabs. Seeding from the step index
         * rather than letting a stream run means the same show time produces the
         * same numbers, and the sequence still moves on frame to frame because
         * the step index does.
         */
        ctx.rng = makeRng(`${inst.key}~${inst.step}`);

        target.save();
        target.globalAlpha = useScratch ? 1 : opacity * master;
        target.globalCompositeOperation = useScratch ? 'source-over' : blend;
        // Reset the drawing state effects tend to assume is fresh.
        target.lineWidth = 1;
        target.lineCap = 'butt';
        target.lineJoin = 'miter';
        target.textAlign = 'start';
        target.textBaseline = 'alphabetic';
        target.setLineDash([]);
        target.lineDashOffset = 0;
        target.shadowBlur = 0;
        target.shadowColor = 'transparent';
        if ('filter' in target) target.filter = 'none';

        try {
          effect.draw(ctx);
        } catch (err) {
          reportError(layer.id, effect.id, err);
        }
        target.restore();
      }

      if (useScratch) {
        g.save();
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalAlpha = opacity * master;
        g.globalCompositeOperation = blend;
        // Softness is authored in world pixels so it means the same thing
        // regardless of the projector's buffer resolution.
        if (softness > 0 && 'filter' in g) {
          g.filter = `blur(${(softness * pixelSize.w) / (roi.w * world.w)}px)`;
        }
        g.drawImage(scratch, 0, 0);
        if ('filter' in g) g.filter = 'none';
        g.restore();
      }
    }

    g.setTransform(1, 0, 0, 1, 0, 0);
  }

  /**
   * Drop cached state for layers and shapes that no longer exist.
   *
   * Called by the control tab when it swaps the whole project. The per-frame
   * sweep above covers the projector tabs, which have no such moment; this is
   * the immediate version for the tab that knows something changed.
   */
  function gc(project) {
    const layerIds = new Set(project.layers.map((l) => l.id));
    const shapeIds = new Set(project.shapes.map((s) => s.id));
    shapeIds.add('__frame__');
    for (const key of [...instanceState.keys()]) {
      // "layerId:effectId:shapeId" — the shape is the last field, and ids
      // never contain a colon (see `uid` in core/state.js).
      const parts = key.split(':');
      const layerId = parts[0];
      const shapeId = parts[parts.length - 1];
      if (!layerIds.has(layerId) || !shapeIds.has(shapeId)) instanceState.delete(key);
    }
    reportedErrors.clear();
  }

  return { render, gc, resetLayer, geometry, clearErrors: () => reportedErrors.clear() };
}
