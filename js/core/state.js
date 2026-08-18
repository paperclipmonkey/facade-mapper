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

import { DEFAULT_GRADE } from '../render/postfx.js';
import { createRectify } from './rectify.js';
import { createScan } from './scan.js';

export const PROJECT_VERSION = 5;

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
  /** An open path meant to be written along — an arch over the door, a banner. */
  'sign',
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
    /**
     * Wall-clock ms at which this layer's switch last went up, or 0 for "it has
     * simply always been on".
     *
     * Stamped by the control tab and read by every tab, so `age` — and with it
     * every one-shot — means the same thing in all of them. See
     * `stampLayerSwitchOns` and `enabledAtFor`.
     */
    onAt: 0,
    solo: false,
    opacity: 1,
    blend: 'source-over',
    /** Effect parameter values, keyed by param id. */
    params: {},
    /** Per-param modulation. See core/modulators.js. */
    bindings: {},
    /** Stagger multi-target instances so a row of windows doesn't pulse in unison. */
    stagger: 0,
    /** Blur applied to this layer alone, in world pixels. Softens hard cutouts. */
    softness: 0,
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

/**
 * A trigger fires a scene for a while and then puts the previous one back.
 *
 * The interesting source is 'motion': the control tab watches a region of the
 * camera view and fires when something moves through it. That is what turns the
 * house from a loop into something that reacts to whoever walks up the path.
 */
/**
 * Single keys the editor itself uses, which a trigger therefore cannot have.
 *
 * The editor's own handler runs first and does not fall through, so a trigger
 * on one of these is simply dead — it looks configured, reads as configured,
 * and never fires. Worth a warning rather than a puzzle in the dark.
 */
export const RESERVED_KEYS = {
  v: 'the Select tool',
  p: 'the Area tool',
  l: 'the Path tool',
  r: 'the Rectangle tool',
  c: 'the Corners tool',
  b: 'Blackout',
  ' ': 'play/pause',
  0: 'zoom the stage back to fit',
  1: 'scene 1', 2: 'scene 2', 3: 'scene 3', 4: 'scene 4', 5: 'scene 5',
  6: 'scene 6', 7: 'scene 7', 8: 'scene 8', 9: 'scene 9',
};

export function createTrigger(overrides = {}) {
  return {
    id: uid('trig'),
    name: 'Scare',
    enabled: true,
    /** 'motion' | 'hotkey' | 'timer' | 'manual' */
    source: 'motion',
    /** Scene to jump to. */
    sceneId: null,
    /** Seconds to hold it before returning to what was playing. 0 = stay. */
    hold: 6,
    /** Media id of a sound to play with it. */
    sound: null,
    soundVolume: 1,
    /** Minimum seconds between firings, so one visitor doesn't retrigger it. */
    cooldown: 20,

    /** source: 'motion' — which part of the camera view to watch. */
    region: { x: 0.25, y: 0.55, w: 0.5, h: 0.45 },
    sensitivity: 0.5,

    /** source: 'hotkey' — a single key. */
    key: 'q',

    /** source: 'timer' — average seconds between firings, with jitter. */
    every: 180,
    jitter: 0.5,

    /**
     * HTTP calls fired around this trigger, for WLED and anything else on the
     * network that takes a URL. `before` goes at the instant it fires; `after`
     * when the hold expires and the show returns to what it was doing.
     */
    http: {
      before: { url: '', method: 'GET', body: '', mode: 'no-cors' },
      after: { url: '', method: 'GET', body: '', mode: 'no-cors' },
    },

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

    /** Aspect ratio of the space the shapes were drawn against (w/h). */
    worldAspect: 16 / 9,

    /**
     * The camera's point of view, factored out.
     *
     * Off by default, in which case world space is the camera image and nothing
     * below this line matters. Switched on, world space is the wall seen
     * square-on and `rectify.H` is how you get from one to the other. See
     * core/rectify.js for why that is worth doing.
     */
    rectify: createRectify(),

    /**
     * A depth scan of the building, if one has been imported.
     *
     * The relief map itself is far too big for localStorage and lives in
     * IndexedDB; this is the metadata and, crucially, where the scan sits on the
     * camera picture. See core/scan.js.
     */
    scan: createScan(),

    projectors: [projector],
    shapes: [],
    layers: [],
    scenes: [],
    /** User-authored effect modules: { id, name, code, updatedAt }. */
    userEffects: [],
    /** Media entries: { id, name, kind, size, duration }. Bytes live in IndexedDB. */
    media: [],

    /** Reactive and timed one-shots. See createTrigger. */
    triggers: [],

    /** Unattended on/off times, so the show runs itself all evening. */
    schedule: {
      enabled: false,
      on: '18:00',
      off: '22:30',
      /** Days of the week it runs, 0 = Sunday. */
      days: [0, 1, 2, 3, 4, 5, 6],
    },

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
      /** A still is stored in IndexedDB for this project, to trace on. */
      hasStill: false,
      /** This show is the built-in demo house rather than somebody's building. */
      isDemo: false,
      /** Which starter look the demo was built with, so ?demo=x can switch. */
      demoPreset: null,
      showSafeArea: true,
      previewFps: 60,
      /** Bloom and colour grading, applied identically by every projector. */
      grade: { ...DEFAULT_GRADE },
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

  p.rectify = { ...base.rectify, ...(raw.rectify || {}) };
  // A rectification without a solved matrix cannot be applied, and half-applying
  // it would put every shape in the wrong place.
  if (!Array.isArray(p.rectify.H) || p.rectify.H.length !== 9) {
    p.rectify.enabled = false;
    p.rectify.H = null;
  }

  p.scan = { ...base.scan, ...(raw.scan || {}) };
  // A scan without a placement cannot be drawn or sampled, and half-applying one
  // would light the wrong part of the wall. Same reasoning as `rectify` above.
  if (!Array.isArray(p.scan.H) || p.scan.H.length !== 9 || !(p.scan.w > 1) || !(p.scan.h > 1)) {
    p.scan.enabled = false;
  }

  p.settings = { ...base.settings, ...(raw.settings || {}) };
  p.settings.grade = { ...DEFAULT_GRADE, ...(raw.settings?.grade || {}) };
  p.show = { ...base.show, ...(raw.show || {}) };
  p.schedule = { ...base.schedule, ...(raw.schedule || {}) };
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

  p.triggers = (Array.isArray(raw.triggers) ? raw.triggers : []).map((t) => ({
    ...createTrigger(),
    ...t,
    region: { ...createTrigger().region, ...(t.region || {}) },
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
  const rectified = project?.rectify?.enabled ? project.rectify.worldAspect : 0;
  const stored = rectified > 0.1 ? rectified : project?.worldAspect;
  const aspect = stored > 0.1 ? stored : 16 / 9;
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
    // Case-insensitively, because the tag picker offers a canonical list but
    // nothing stops a typed tag being "Window". The panels have always matched
    // that way; when this did not, a layer read as pointing at four windows in
    // the list and drew on none of them, which is a horrible thing to debug in
    // the dark.
    const wanted = layer.targetTags.map((t) => String(t).toLowerCase());
    for (const s of project.shapes) {
      if (s.tags?.some((t) => wanted.includes(String(t).toLowerCase()))) push(s);
    }
  }
  return out;
}
