/**
 * The project model: the single serialisable object that describes an entire show.
 *
 * Everything the control tab and every projector tab needs lives in here, so a
 * projector tab is stateless apart from "which projector am I?" — it loads the
 * project, finds its own entry, and renders. That's what makes the tabs cheap to
 * open, close and reopen mid-show.
 *
 * Geometry is stored in normalised world coordinates (0..1 across the camera
 * frame) rather than pixels. That way a project survives changing camera
 * resolution, and shapes stay put when you swap a webcam for a better one.
 */

export const PROJECT_VERSION = 3;

/** Virtual pixel size handed to effects, so line widths and speeds feel natural. */
export const WORLD_WIDTH = 1920;

export function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
}

export const SHAPE_TAGS = [
  'window',
  'door',
  'wall',
  'roof',
  'chimney',
  'garage',
  'path',
  'trim',
  'mask',
];

export function createProjector(index = 0) {
  const n = index + 1;
  return {
    id: uid('proj'),
    name: `Projector ${n}`,
    enabled: true,
    blackout: false,
    /** Output resolution hint. The tab reports its real size back on connect. */
    resolution: { w: 1920, h: 1080 },
    calibration: {
      /** 'none' | 'auto' | 'manual' — how `H` was arrived at. */
      mode: 'none',
      /** Row-major 3x3 mapping world (0..1) -> projector (0..1). */
      H: null,
      /** Manual fallback: where the projector's own corners land in world space. */
      worldQuad: null,
      /** Reprojection stats from the last auto-calibration. */
      quality: null,
      calibratedAt: null,
      /** Marker centroids from the last successful solve, for drift checking. */
      markers: null,
    },
    /** Optional fine correction on top of H, for non-planar walls. */
    mesh: {
      enabled: false,
      cols: 3,
      rows: 3,
      /** (cols*rows) offsets in normalised projector units. */
      offsets: null,
    },
    /** Soft-edge blending for overlapping projectors. */
    blend: { top: 0, right: 0, bottom: 0, left: 0, gamma: 1.8 },
    brightness: 1,
    /** Rendering supersample factor for the intermediate world buffer. */
    quality: 1.25,
    testPattern: 'off',
  };
}

export function createShape(points = [], overrides = {}) {
  return {
    id: uid('shape'),
    name: 'Shape',
    /** 'polygon' (closed area) or 'path' (open polyline). */
    type: 'polygon',
    closed: true,
    smooth: false,
    /** Normalised world coordinates. */
    points,
    tags: [],
    /** Draw order within the world buffer; higher renders later. */
    z: 0,
    visible: true,
    locked: false,
    ...overrides,
  };
}

export function createLayer(effectId, overrides = {}) {
  return {
    id: uid('layer'),
    name: '',
    effect: effectId,
    /** Shape ids this layer draws into. Empty = the whole frame. */
    targets: [],
    /** Optional tag filter, applied on top of `targets`. */
    targetTags: [],
    enabled: true,
    solo: false,
    opacity: 1,
    blend: 'source-over',
    /** Effect parameter values, keyed by param id. */
    params: {},
    /** Per-param modulation. See core/modulators.js. */
    bindings: {},
    /** Stagger multi-target instances so a row of windows doesn't pulse in unison. */
    stagger: 0,
    order: 0,
    ...overrides,
  };
}

export function createScene(overrides = {}) {
  return {
    id: uid('scene'),
    name: 'Scene',
    /** Hotkey digit 1-9, or null. */
    hotkey: null,
    /** Crossfade seconds when switching to this scene. */
    fade: 0.6,
    /** layerId -> { enabled, opacity, params } overrides. */
    state: {},
    ...overrides,
  };
}

export function createProject(name = 'Untitled show') {
  const projector = createProjector(0);
  return {
    version: PROJECT_VERSION,
    id: uid('proj'),
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),

    /** Aspect ratio of the camera the shapes were drawn against (w/h). */
    worldAspect: 16 / 9,

    projectors: [projector],
    shapes: [],
    layers: [],
    scenes: [],
    /** User-authored effect modules: { id, name, code, updatedAt }. */
    userEffects: [],
    /** Media entries: { id, name, kind, size, duration }. Bytes live in IndexedDB. */
    media: [],

    show: {
      /** Ordered scene ids with durations, for unattended running. */
      playlist: [],
      loop: true,
      shuffle: false,
      running: false,
      activeScene: null,
    },

    settings: {
      master: 1,
      blackout: false,
      bpm: 120,
      /** Mic-reactive effects read levels broadcast by the control tab. */
      audioEnabled: false,
      audioGain: 1,
      /** Camera device id, remembered between sessions. */
      cameraId: null,
      showSafeArea: true,
      previewFps: 60,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Migration
 *
 * Projects live in localStorage across app updates, so anything loaded from
 * disk goes through here before use. Missing fields are filled from a fresh
 * project rather than assumed present.
 * ------------------------------------------------------------------ */

export function migrateProject(raw) {
  if (!raw || typeof raw !== 'object') return createProject();
  const base = createProject(raw.name || 'Untitled show');
  const p = { ...base, ...raw };

  p.settings = { ...base.settings, ...(raw.settings || {}) };
  p.show = { ...base.show, ...(raw.show || {}) };
  p.version = PROJECT_VERSION;

  p.projectors = (Array.isArray(raw.projectors) ? raw.projectors : []).map((proj, i) => {
    const d = createProjector(i);
    const merged = { ...d, ...proj };
    merged.calibration = { ...d.calibration, ...(proj.calibration || {}) };
    merged.mesh = { ...d.mesh, ...(proj.mesh || {}) };
    merged.blend = { ...d.blend, ...(proj.blend || {}) };
    merged.resolution = { ...d.resolution, ...(proj.resolution || {}) };
    return merged;
  });
  if (!p.projectors.length) p.projectors = [createProjector(0)];

  p.shapes = (Array.isArray(raw.shapes) ? raw.shapes : [])
    .map((s) => ({ ...createShape([], {}), ...s }))
    .filter((s) => Array.isArray(s.points) && s.points.length >= 2);

  p.layers = (Array.isArray(raw.layers) ? raw.layers : []).map((l) => ({
    ...createLayer(l.effect || 'fill'),
    ...l,
    params: { ...(l.params || {}) },
    bindings: { ...(l.bindings || {}) },
  }));

  p.scenes = (Array.isArray(raw.scenes) ? raw.scenes : []).map((s) => ({
    ...createScene(),
    ...s,
    state: { ...(s.state || {}) },
  }));

  p.userEffects = Array.isArray(raw.userEffects) ? raw.userEffects : [];
  p.media = Array.isArray(raw.media) ? raw.media : [];

  // A show that was left running when the tab closed should not auto-start.
  p.show.running = false;

  return p;
}

/* ------------------------------------------------------------------ *
 * Derived helpers
 * ------------------------------------------------------------------ */

/** World buffer dimensions in virtual pixels, from the stored camera aspect. */
export function worldSize(project) {
  const aspect = project?.worldAspect > 0.1 ? project.worldAspect : 16 / 9;
  return { w: WORLD_WIDTH, h: Math.round(WORLD_WIDTH / aspect), aspect };
}

/** Shapes a layer applies to, resolving both explicit ids and tag filters. */
export function resolveTargets(project, layer) {
  const byId = new Map(project.shapes.map((s) => [s.id, s]));
  const out = [];
  const seen = new Set();

  const push = (s) => {
    if (s && s.visible !== false && !seen.has(s.id)) {
      seen.add(s.id);
      out.push(s);
    }
  };

  if (layer.targets?.length) {
    for (const id of layer.targets) push(byId.get(id));
  }
  if (layer.targetTags?.length) {
    for (const s of project.shapes) {
      if (s.tags?.some((t) => layer.targetTags.includes(t))) push(s);
    }
  }
  return out;
}
