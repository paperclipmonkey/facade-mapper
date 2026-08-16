/**
 * Control tab.
 *
 * The only place the project is edited. Everything else — projector tabs, the
 * preview, the panels — is downstream of the single project object held here.
 * Edits mutate it, then `commit()` fans the result out: saved to local storage,
 * broadcast to the projector tabs, and re-rendered into the panels.
 *
 * Two commit flavours matter. `commit()` is for discrete changes and refreshes
 * the UI; `commitLive()` is for the middle of a drag, where rebuilding lists 60
 * times a second would fight the pointer. Both broadcast, because a slider
 * should move on the wall while you're still holding it.
 */

import { createBus, createPresence, MSG } from '../core/bus.js';
import { createClock, formatTime } from '../core/clock.js';
import {
  loadOrCreateProject,
  saveProject,
  listProjects,
  loadProject,
  deleteProject,
  exportProjectFile,
  importProjectFile,
  setCurrentProjectId,
  putBlob,
  getBlob,
  deleteBlob,
  estimateQuota,
  getPref,
  setPref,
} from '../core/storage.js';
import {
  createProject,
  createProjector,
  createLayer,
  createScene,
  createShape,
  createTrigger,
  migrateProject,
} from '../core/state.js';
import { createWorldRenderer } from '../render/worldRenderer.js';
import { createWarpRenderer, computeEdgeBlends, projectorsOverlap } from '../render/warp.js';
import { GRADE_PRESETS, DEFAULT_GRADE } from '../render/postfx.js';
import { createMediaPool, importMediaFile, removeMedia } from '../core/media.js';
import { loadUserEffects, listByCategory, defaultParams, getEffect, getCompileErrors } from '../effects/registry.js';
import { captureScene, activateScene as applyScene, applySceneToLayers, sceneDrift, tickPlaylist, transitionProgress } from '../core/scenes.js';
import { createCamera } from './camera.js';
import { feed as extraFeed, pruneFeeds } from './feeds.js';
import { runCalibration, checkDrift, solveFromCorners } from './calibration.js';
import { createStage, defaultWorldQuad } from './stage.js';
import { createAudioAnalyser } from './audio.js';
import { renderInspector } from './inspector.js';
import { renderSetupGuide } from './setup.js';
import { createPalette } from './palette.js';
import { createShapeNamer } from './shapeNamer.js';
import {
  renderProjectorList,
  renderShapeList,
  renderLayerList,
  renderSceneList,
  renderPlaylist,
  renderSceneButtons,
  renderMediaList,
  renderStorageInfo,
  renderTriggerList,
  renderMotionStatus,
} from './panels.js';
import { createMotionDetector } from './motion.js';
import { createSoundPlayer } from './sound.js';
import { createTriggerRuntime } from './triggers.js';
import { scheduleWantsOn, describeSchedule } from './schedule.js';
import { el, clear, toast, paramRow } from './ui.js';
import { HELP_SECTIONS, EFFECT_TEMPLATE } from './help.js';
import { PRESETS, applyPreset, addDemoBursts } from './presets.js';
import { demoShapes, demoWorldQuad, demoFacadeBlob, DEMO_ASPECT } from './demoHouse.js';

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

const bus = createBus('control');
const presence = createPresence(bus);
const clock = createClock();
const camera = createCamera();
const mediaPool = createMediaPool({ onError: (m) => toast(m, 'bad') });

const app = {
  project: loadOrCreateProject(),
  selection: { type: null, id: null },
  /** Shape ids lit up from the panels, linking a layer to what it draws into. */
  highlightedShapes: null,
  tool: 'select',
  showShapeNames: true,
  showEffectsPreview: true,
  cameraVisible: true,
  cameraOpacity: 0.45,
  presence,
  camera,
  bus,
};

const sound = createSoundPlayer({ onError: (m) => toast(m, 'bad') });
const motion = createMotionDetector();
let triggerRuntime = null;
/** Motion is measured a few times a second, not every frame — it costs a readback. */
let lastMotionAt = 0;
let scheduleState = null;

let audioAnalyser = null;
let audioLevels = { level: 0, low: 0, mid: 0, high: 0 };
let stillImage = null;
let calibrationAbort = null;
let dirty = false;
let saveTimer = null;
let broadcastTimer = null;
let lastBroadcast = 0;

const undoStack = [];
const redoStack = [];
const UNDO_LIMIT = 60;
/** The last plainly-clicked layer row, for shift-click ranges. */
let layerAnchor = null;

/* ------------------------------------------------------------------ *
 * Preview rendering
 * ------------------------------------------------------------------ */

/**
 * The preview runs the full pipeline, not a simplified one.
 *
 * `previewCanvas` is the 2D world render; `previewGL` warps it with an identity
 * homography and applies the same bloom and grade a projector would. Anything
 * less and the preview would lie about the look you are tuning.
 */
const previewCanvas = document.createElement('canvas');
const previewCtx = previewCanvas.getContext('2d');
const previewGL = document.createElement('canvas');
let previewWarp = null;
let previewWarpFailed = false;
let palette = null;

const worldRenderer = createWorldRenderer({
  mediaPool,
  /**
   * The video an effect should draw. No argument, or an empty one, means the
   * alignment camera — which is what every existing show asks for. A device id
   * means "open that one yourself", and is how you get a doorstep webcam into a
   * window without moving the camera the whole mapping depends on.
   */
  camera: (deviceId) => (deviceId
    ? extraFeed(deviceId)
    : (camera.isRunning() ? camera.video : null)),
  onEffectError: ({ effectId, message }) => toast(`Effect "${effectId}" threw: ${message}`, 'bad'),
});

const stage = createStage({ canvas: $('stage'), wrap: $('stageWrap'), app });

/**
 * Prompt for a name and a tag the moment a shape is drawn, while you still know
 * what it is. Tagging is what makes one layer light every window, and doing it
 * later — in another panel, on a shape called "Area 3" — is why it went unused.
 */
const shapeNamer = createShapeNamer({ host: $('stageWrap'), app });
app.nameNewShape = (id) => shapeNamer.open(id);

/* ------------------------------------------------------------------ *
 * Persistence + fan-out
 * ------------------------------------------------------------------ */

function markDirty() {
  dirty = true;
  $('saveState').textContent = 'saving…';
  $('saveState').classList.add('dirty');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 800);
}

function flushSave() {
  const result = saveProject(app.project);
  if (!result.ok) {
    $('saveState').textContent = 'not saved';
    toast(result.error, 'bad');
    return;
  }
  dirty = false;
  $('saveState').textContent = 'saved';
  $('saveState').classList.remove('dirty');
}

/**
 * Push the project to the projector tabs.
 *
 * Rate-limited rather than sent on every mutation: dragging a slider produces
 * hundreds of changes a second, and each broadcast is a structured clone of the
 * whole project. 12 updates a second is imperceptible on the wall and keeps the
 * main thread free for rendering.
 */
function broadcast(immediate = false) {
  const now = performance.now();
  const elapsed = now - lastBroadcast;
  clearTimeout(broadcastTimer);
  if (immediate || elapsed > 80) {
    lastBroadcast = now;
    bus.post(MSG.PROJECT, JSON.parse(JSON.stringify(app.project)));
  } else {
    broadcastTimer = setTimeout(() => broadcast(true), 80 - elapsed);
  }
}

function broadcastClock() {
  bus.post(MSG.CLOCK, clock.getTransport());
}

/**
 * Close any extra camera a layer no longer asks for.
 *
 * A camera left open holds its light on and lights the browser's recording
 * indicator, which is alarming when the layer that opened it was deleted an
 * hour ago. Cheap enough to do on every commit.
 */
function pruneCameraFeeds() {
  const wanted = new Set();
  for (const layer of app.project.layers) {
    if (layer.effect === 'camera-feed' && layer.params?.device) wanted.add(layer.params.device);
  }
  pruneFeeds(wanted);
}

app.commit = () => {
  pruneCameraFeeds();
  markDirty();
  broadcast();
  refreshPanels();
  refreshInspector();
};

app.commitLive = () => {
  markDirty();
  broadcast();
};

app.pushUndo = () => {
  undoStack.push(JSON.stringify(app.project));
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
};

function restore(json) {
  app.project = migrateProject(JSON.parse(json));
  mediaPool.sync(app.project.media || []);
  worldRenderer.gc(app.project);
  stage.resize();
  loadUserEffects(app.project.userEffects || []).then(refreshCodePanel);
  markDirty();
  broadcast(true);
  refreshPanels();
  refreshInspector();
  syncControlsFromProject();
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(JSON.stringify(app.project));
  restore(undoStack.pop());
  toast('Undone');
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify(app.project));
  restore(redoStack.pop());
  toast('Redone');
}

/* ------------------------------------------------------------------ *
 * Selection
 * ------------------------------------------------------------------ */

/**
 * Selection is one thing, or several layers.
 *
 * `id` stays the primary — it is what the inspector opens and what every
 * existing caller passes — and `ids` carries the whole set. Keeping both means
 * nothing that only knew about single selection had to change, while delete,
 * enable and bypass can act on a group. Only layers are multi-selectable;
 * shapes, projectors and triggers are edited one at a time and a set would buy
 * nothing.
 */
app.select = (selection) => {
  app.selection = selection || { type: null, id: null };
  if (!app.selection.ids) {
    app.selection.ids = app.selection.id ? [app.selection.id] : [];
  }
  // The primary follows the set, so deleting the group leaves nothing dangling.
  if (!app.selection.ids.includes(app.selection.id)) {
    app.selection.id = app.selection.ids[0] ?? null;
  }
  if (selection?.type === 'shape') switchPanel('shapes');
  else if (selection?.type === 'layer') switchPanel('layers');
  else if (selection?.type === 'projector') switchPanel('projectors');
  else if (selection?.type === 'trigger') switchPanel('triggers');
  refreshPanels();
  refreshInspector();
  updateStageStatus();
};

app.selectedProjector = () => {
  if (app.selection.type === 'projector') {
    return app.project.projectors.find((p) => p.id === app.selection.id) || null;
  }
  return app.project.projectors[0] || null;
};

/** Currently selected layer ids, in project order. */
app.selectedLayerIds = () => (app.selection.type === 'layer' ? app.selection.ids || [] : []);

/**
 * Extend or toggle the layer selection, the way a file list does.
 *
 * `range` (shift) selects everything between the anchor and here; `toggle`
 * (ctrl/cmd) adds or removes one. The anchor is the last plainly-clicked row,
 * so shift-clicking repeatedly grows and shrinks from the same end rather than
 * walking the anchor along behind you.
 */
app.selectLayer = (id, { toggle = false, range = false } = {}) => {
  const ordered = [...app.project.layers].sort((a, b) => (a.order || 0) - (b.order || 0)).map((l) => l.id);
  const current = app.selection.type === 'layer' ? app.selection.ids || [] : [];

  if (range && layerAnchor && ordered.includes(layerAnchor)) {
    const from = ordered.indexOf(layerAnchor);
    const to = ordered.indexOf(id);
    const [lo, hi] = from < to ? [from, to] : [to, from];
    app.select({ type: 'layer', id, ids: ordered.slice(lo, hi + 1) });
    return;
  }

  if (toggle) {
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    layerAnchor = id;
    // Deselecting the last one leaves nothing selected rather than snapping
    // back to a single row you did not ask for.
    app.select(next.length ? { type: 'layer', id, ids: next } : null);
    return;
  }

  layerAnchor = id;
  app.select({ type: 'layer', id });
};

/** Bulk action over the selected layers, or over all of them. */
app.layersBulk = (action) => {
  const ids = new Set(app.selectedLayerIds());
  const targets = app.project.layers.filter((l) => ids.has(l.id));
  if (!targets.length) return;
  app.pushUndo();
  if (action === 'enable' || action === 'bypass') {
    for (const layer of targets) layer.enabled = action === 'enable';
  }
  app.commit();
};

/**
 * A new layer running `effectId`, optionally pointed at one shape.
 *
 * Lives here rather than in the inspector or the palette because creating a
 * layer touches ordering, selection, undo and the panel refresh, and neither of
 * those should have to know about any of that. With no shape it covers the
 * whole frame, which is what snow and fog want.
 */
app.addLayer = (effectId, shapeId = null) => {
  app.pushUndo();
  const layer = createLayer(effectId, {
    params: defaultParams(effectId),
    order: app.project.layers.length,
    name: getEffect(effectId)?.name || effectId,
    targets: shapeId ? [shapeId] : [],
  });
  app.project.layers.push(layer);
  app.select({ type: 'layer', id: layer.id });
  switchPanel('layers');
  app.commit();
  const name = getEffect(effectId)?.name || effectId;
  const shape = shapeId ? app.project.shapes.find((s) => s.id === shapeId) : null;
  toast(shape ? `${name} added on ${shape.name}.` : `${name} added over the whole frame.`, 'good');
  return layer;
};

/** Kept for the inspector's shape view, which always has a shape in hand. */
app.addLayerForShape = (effectId, shapeId) => app.addLayer(effectId, shapeId);

app.deleteSelection = () => deleteSelection();

app.clearLayers = () => {
  if (!app.project.layers.length) return;
  const count = app.project.layers.length;
  if (!confirm(`Remove all ${count} effect${count === 1 ? '' : 's'}? Scenes that referenced them are kept, and Ctrl+Z puts them back.`)) {
    return;
  }
  app.pushUndo();
  for (const layer of app.project.layers) {
    worldRenderer.resetLayer(layer.id);
    for (const scene of app.project.scenes) delete scene.state?.[layer.id];
  }
  app.project.layers = [];
  app.select(null);
  app.commit();
  toast(`Removed ${count} effect${count === 1 ? '' : 's'}. Ctrl+Z to undo.`);
};

app.resetLayerState = (layerId) => worldRenderer.resetLayer(layerId);

/* The setup walkthrough drives the app through these rather than reaching into
 * the DOM for other panels' buttons, so the two cannot drift apart. */
app.switchPanel = (name) => switchPanel(name);

app.addProjector = () => {
  app.pushUndo();
  const projector = createProjector(app.project.projectors.length);
  app.project.projectors.push(projector);
  app.select({ type: 'projector', id: projector.id });
  app.commit();
  return projector;
};

app.rollCall = () => {
  presence.rollCall();
  setTimeout(() => {
    refreshPanels();
    updateStageStatus();
  }, 400);
};

/**
 * Light up a set of shapes on the stage without selecting them.
 *
 * Selection is a commitment — it changes the inspector and what the keyboard
 * does. Answering "which shape is this layer pointed at?" should not cost you
 * the panel you are working in, so hovering only highlights.
 */
app.highlightShapes = (ids) => {
  const next = ids && ids.length ? ids : null;
  const same = next === app.highlightedShapes
    || (next && app.highlightedShapes && next.length === app.highlightedShapes.length
        && next.every((id, i) => id === app.highlightedShapes[i]));
  if (same) return;
  // No redraw needed: the stage repaints every frame and will pick this up on
  // the next one. Calling draw() here would also need the whole frame payload.
  app.highlightedShapes = next;
};

app.fireTrigger = (triggerId) => {
  const trigger = app.project.triggers.find((t) => t.id === triggerId);
  if (!trigger) return;
  if (!trigger.sceneId && !trigger.sound) {
    toast('This trigger has nothing to do yet — give it a scene or a sound.', 'bad');
    return;
  }
  triggerRuntime?.fire(trigger, { manual: true });
  app.commit();
};

app.triggerActivity = (id) => triggerRuntime?.activityFor(id) ?? 0;
app.triggerArmedIn = (id, cooldown) => triggerRuntime?.gate.armedIn(id, cooldown) ?? 0;
app.motionThreshold = (sensitivity) => triggerRuntime?.gate.threshold(sensitivity) ?? 0.05;
app.refreshInspector = () => refreshInspector();
app.refreshPanels = () => refreshPanels();
app.estimateQuota = estimateQuota;

/* ------------------------------------------------------------------ *
 * Panels
 * ------------------------------------------------------------------ */

function refreshPanels() {
  renderSetupGuide($('setupGuide'), app);
  renderProjectorList($('projectorList'), app);
  renderShapeList($('shapeList'), app, $('shapeFilter').value);
  renderLayerList($('layerList'), app);
  renderSceneList($('sceneList'), app);
  renderPlaylist($('playlist'), app);
  renderSceneButtons($('sceneButtons'), app);
  renderMediaList($('mediaList'), app);
  renderTriggerList($('triggerList'), app);
  refreshLookPanel();
  renderStorageInfo($('storageDetail'), app);
  updateScheduleNote();
  updateCalibrationNote();
  // The "point a camera at the house" placeholder covers the stage, so it has to
  // clear as soon as there is anything to look at.
  $('stageEmpty').hidden = !!(app.project.shapes.length || camera.isRunning() || stillImage);
}

function refreshInspector() {
  renderInspector($('inspector'), app);
}

function switchPanel(name) {
  for (const tab of document.querySelectorAll('.panel-tab')) {
    tab.classList.toggle('active', tab.dataset.panel === name);
  }
  for (const page of document.querySelectorAll('.panel-page')) {
    page.classList.toggle('active', page.dataset.page === name);
  }
}

function updateCalibrationNote() {
  const unaligned = app.project.projectors.filter((p) => !p.calibration?.H);
  const node = $('calibrationNote');
  const blendButton = $('btnAutoBlend');
  const overlaps = unaligned.length ? [] : unblendedOverlaps();
  blendButton.hidden = app.project.projectors.filter((p) => p.calibration?.H).length < 2;

  if (unaligned.length) {
    node.textContent = `${unaligned.length} projector${unaligned.length === 1 ? '' : 's'} still need aligning. Select one and use "Align with camera".`;
    return;
  }
  if (overlaps.length) {
    // Worth saying out loud: the doubled band is the most common "why does my
    // wall have a bright stripe down it" and it has a one-click answer.
    node.textContent = `${overlaps[0][0]} and ${overlaps[0][1]} light the same part of the wall, so that band is twice as bright. "Blend overlaps" fades each of them across it.`;
    return;
  }
  node.textContent = 'All projectors are aligned. Open their tabs and press F for fullscreen.';
}

function updateStageStatus() {
  const { type, id } = app.selection;
  let label = 'Nothing selected';
  if (type === 'shape') {
    const shape = app.project.shapes.find((s) => s.id === id);
    if (shape) label = `${shape.name} · ${shape.points.length} points`;
  } else if (type === 'layer') {
    const layer = app.project.layers.find((l) => l.id === id);
    if (layer) label = `${layer.name || getEffect(layer.effect)?.name || layer.effect}`;
  } else if (type === 'projector') {
    const projector = app.project.projectors.find((p) => p.id === id);
    if (projector) label = projector.name;
  }
  $('stageSelection').textContent = label;

  const tabs = presence.list().length;
  $('stagePeers').textContent = `${tabs} projector tab${tabs === 1 ? '' : 's'}`;
}

const TOOL_HINTS = {
  select: 'Click to select. Drag points to adjust. Alt-click an edge to add a point, alt-click a point to remove it.',
  polygon: 'Click round a window or door. Click the first point, double-click, or press Enter to close it.',
  path: 'Click along a roofline or gutter. Enter or double-click to finish. Great for chases and light strings.',
  rect: 'Drag out a rectangle.',
  corners: 'Drag the four yellow handles to where the selected projector’s corners land on the house.',
};

function setTool(tool) {
  app.tool = tool;
  for (const button of document.querySelectorAll('.tool')) {
    button.classList.toggle('active', button.dataset.tool === tool);
  }
  $('stage').className = `tool-${tool}`;
  $('stageHint').textContent = TOOL_HINTS[tool] || '';
  if (tool !== 'polygon' && tool !== 'path') stage.cancelDraft();
  if (tool === 'corners') {
    const projector = app.selectedProjector();
    if (projector && !projector.calibration?.worldQuad) {
      projector.calibration.worldQuad = defaultWorldQuad();
      app.commit();
    }
  }
}

/* ------------------------------------------------------------------ *
 * Projector control
 * ------------------------------------------------------------------ */

app.openProjectorTab = (projectorId) => {
  const url = new URL('projector.html', location.href);
  if (projectorId) url.searchParams.set('p', projectorId);
  const win = window.open(url.href, '_blank');
  if (!win) toast('Your browser blocked the new tab. Allow pop-ups for this site.', 'bad');
  else toast('Drag the new tab to the projector display and press F.');
};

app.identifyProjector = (projectorId) => {
  bus.post(MSG.COMMAND, { projectorId, action: 'identify', ms: 4000 });
};

app.commandProjector = (projectorId, action) => {
  bus.post(MSG.COMMAND, { projectorId, action });
};

app.beginManualCorners = (projectorId) => {
  const projector = app.project.projectors.find((p) => p.id === projectorId);
  if (!projector) return;
  app.pushUndo();
  projector.calibration.worldQuad = projector.calibration.worldQuad || defaultWorldQuad();
  projector.testPattern = 'corners';
  app.select({ type: 'projector', id: projectorId });
  setTool('corners');
  app.commit();
  toast('Drag the yellow handles onto the projected corners, then switch the test pattern off.');
};

/**
 * Set every projector's soft edges from where they actually overlap.
 *
 * Overlap is not handled for you at render time and cannot be: two projectors
 * are two lamps, and the wall sums them. Each has to fade its own contribution
 * across the shared band so the two ramps add back to one. The widths for that
 * are pure geometry — both homographies are known — so measuring them by eye in
 * the dark was always avoidable work.
 */
app.autoBlend = () => {
  const aligned = app.project.projectors.filter((p) => p.calibration?.H);
  if (aligned.length < 2) {
    toast('Edge blending needs at least two aligned projectors.', 'bad');
    return;
  }
  app.pushUndo();
  let touched = 0;
  for (const projector of aligned) {
    const others = aligned.filter((p) => p !== projector).map((p) => p.calibration.H);
    const blend = computeEdgeBlends(projector.calibration.H, others);
    const changed = ['top', 'right', 'bottom', 'left'].some(
      (edge) => Math.abs((projector.blend?.[edge] || 0) - blend[edge]) > 0.002
    );
    if (changed) touched++;
    projector.blend = { ...projector.blend, ...blend };
  }
  app.commit();
  toast(
    touched
      ? `Soft edges set on ${touched} projector${touched === 1 ? '' : 's'}. Adjust the blend gamma if the seam still shows.`
      : 'These projectors do not overlap, so there is nothing to blend.',
    'good'
  );
};

/** Aligned projectors that share wall but have no soft edge set on either side. */
function unblendedOverlaps() {
  const aligned = app.project.projectors.filter((p) => p.calibration?.H);
  const pairs = [];
  for (let i = 0; i < aligned.length; i++) {
    for (let j = i + 1; j < aligned.length; j++) {
      const a = aligned[i];
      const b = aligned[j];
      if (!projectorsOverlap(a.calibration.H, b.calibration.H)) continue;
      const feathered = [a, b].some((p) => ['top', 'right', 'bottom', 'left'].some((e) => (p.blend?.[e] || 0) > 0.01));
      if (!feathered) pairs.push([a.name, b.name]);
    }
  }
  return pairs;
}

app.onCornersChanged = (projector) => {
  const solved = solveFromCorners(projector.calibration.worldQuad);
  if (!solved) return;
  projector.calibration.H = solved.H;
  projector.calibration.mode = 'manual';
  projector.calibration.quality = solved.quality;
  projector.calibration.calibratedAt = Date.now();
};

/* ------------------------------------------------------------------ *
 * Calibration
 * ------------------------------------------------------------------ */

function calibrationProgressPanel() {
  const existing = document.getElementById('calibPanel');
  if (existing) return existing;
  const panel = el('div', { class: 'calib-progress', id: 'calibPanel' }, [
    el('div', { id: 'calibMessage', text: 'Starting…' }),
    el('div', { class: 'calib-bar' }, [el('span', { id: 'calibBar' })]),
  ]);
  const cancel = el('button', { type: 'button', class: 'btn small danger', text: 'Cancel' });
  cancel.style.marginTop = '8px';
  cancel.addEventListener('click', () => calibrationAbort?.abort());
  panel.appendChild(cancel);
  $('inspector').prepend(panel);
  return panel;
}

function updateCalibrationProgress({ message, index, total }) {
  calibrationProgressPanel();
  const messageNode = document.getElementById('calibMessage');
  const bar = document.getElementById('calibBar');
  if (messageNode) messageNode.textContent = message;
  if (bar && total) bar.style.width = `${Math.round(((index + 1) / total) * 100)}%`;
}

function clearCalibrationProgress() {
  document.getElementById('calibPanel')?.remove();
}

app.startCalibration = async (projectorId) => {
  const projector = app.project.projectors.find((p) => p.id === projectorId);
  if (!projector) return;

  if (!camera.isRunning()) {
    toast('Start the camera first (Setup panel)', 'bad');
    switchPanel('settings');
    return;
  }
  if (!presence.forProjector(projectorId)) {
    toast('No tab is open for this projector. Open it and drag it to the projector display.', 'bad');
    return;
  }

  // Record the aspect the shapes are authored against; changing camera later
  // would otherwise silently stretch everything.
  const aspect = camera.aspect();
  if (Math.abs((app.project.worldAspect || 0) - aspect) > 0.01) {
    if (app.project.shapes.length) {
      toast('Camera aspect ratio changed — existing shapes may need adjusting.', 'bad');
    }
    app.project.worldAspect = aspect;
    stage.resize();
  }

  calibrationAbort = new AbortController();
  app.pushUndo();

  try {
    const gridSize = Math.max(3, Math.round(projector.calibration?.gridSize || 3));
    const result = await runCalibration({
      bus,
      camera,
      projectorId,
      gridSize,
      onProgress: updateCalibrationProgress,
      signal: calibrationAbort.signal,
    });

    projector.calibration = {
      mode: 'auto',
      H: result.H,
      worldQuad: projector.calibration?.worldQuad || null,
      quality: result.quality,
      calibratedAt: result.calibratedAt,
      gridSize: result.gridSize,
      markers: result.markers,
    };
    // A denser pass measures how far the wall departs from the plane the
    // homography assumes and hands back a correction for it. On a flat wall it
    // hands back nothing, so an existing hand-tuned mesh is left alone.
    if (result.mesh) projector.mesh = result.mesh;
    projector.testPattern = 'off';
    app.commit();

    const found = result.markers.filter((m) => m.camera).length;
    const shaped = result.mesh
      ? ` Surface correction applied — the wall is not flat, so ${result.gridSize}×${result.gridSize} control points now carry the difference.`
      : '';
    toast(
      `${projector.name} aligned — ${result.quality.rating}, ${result.quality.meanPx.toFixed(1)} px average error from ${found} markers.${shaped}`,
      result.quality.rating === 'poor' ? 'bad' : 'good'
    );
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    calibrationAbort = null;
    clearCalibrationProgress();
    refreshInspector();
  }
};

app.checkProjectorDrift = async (projectorId) => {
  const projector = app.project.projectors.find((p) => p.id === projectorId);
  if (!projector) return;
  if (!camera.isRunning()) {
    toast('Start the camera first (Setup panel)', 'bad');
    return;
  }
  if (!presence.forProjector(projectorId)) {
    toast('No tab is open for this projector.', 'bad');
    return;
  }

  calibrationAbort = new AbortController();
  try {
    const { fresh, drift } = await checkDrift({
      bus,
      camera,
      projector,
      onProgress: updateCalibrationProgress,
      signal: calibrationAbort.signal,
    });

    clearCalibrationProgress();

    if (!drift.moved) {
      toast(`${projector.name} has not moved (${drift.meanPx.toFixed(1)} px). Nothing to do.`, 'good');
      return;
    }

    const accept = confirm(
      `${projector.name} appears to have moved by about ${drift.meanPx.toFixed(0)} px ` +
        `(worst ${drift.maxPx.toFixed(0)} px).\n\nApply the fresh alignment just measured?`
    );
    if (!accept) return;

    app.pushUndo();
    projector.calibration = {
      mode: 'auto',
      H: fresh.H,
      worldQuad: projector.calibration?.worldQuad || null,
      quality: fresh.quality,
      calibratedAt: fresh.calibratedAt,
      markers: fresh.markers,
    };
    app.commit();
    toast(`${projector.name} re-aligned.`, 'good');
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    calibrationAbort = null;
    clearCalibrationProgress();
    refreshInspector();
  }
};

/* ------------------------------------------------------------------ *
 * Scenes
 * ------------------------------------------------------------------ */

/**
 * Go to a scene, and load it into the editor.
 *
 * Loading is the part that was missing. Scenes are render-time overrides, so
 * switching used to change the projection and change nothing in the panels —
 * the inspector went on showing the authored values while the wall showed the
 * scene's, and building a series of scenes that evolve from one another meant
 * editing numbers you could not see.
 *
 * Undo first, because this overwrites whatever was in the layers. If you had
 * unsaved changes, Ctrl+Z brings them back.
 *
 * Triggers and the playlist deliberately do *not* come through here — they use
 * the core `activateScene` alone. An evening of scares must not slowly rewrite
 * the show as it runs.
 */
app.activateScene = (sceneId) => {
  const scene = app.project.scenes.find((s) => s.id === sceneId);
  if (!scene) return;
  const drifted = sceneDrift(app.project, app.project.show?.activeScene).length;
  app.pushUndo();
  applyScene(app.project, sceneId);
  applySceneToLayers(app.project, sceneId);
  app.select(null);
  app.commit();
  toast(
    drifted
      ? `${scene.name}. The ${drifted} unsaved change${drifted === 1 ? '' : 's'} to the last scene ${drifted === 1 ? 'is' : 'are'} still in Ctrl+Z.`
      : scene.name
  );
};

/** Layers whose current values differ from the scene that is live. */
app.sceneDrift = (sceneId) => sceneDrift(app.project, sceneId);

app.recaptureScene = (sceneId) => {
  const scene = app.project.scenes.find((s) => s.id === sceneId);
  if (!scene) return;
  app.pushUndo();
  scene.state = captureScene(app.project);
  app.commit();
  toast(`"${scene.name}" updated from the current look.`, 'good');
};

/* ------------------------------------------------------------------ *
 * Media
 * ------------------------------------------------------------------ */

app.removeMedia = async (id) => {
  app.pushUndo();
  app.project.media = app.project.media.filter((m) => m.id !== id);
  for (const layer of app.project.layers) {
    if (layer.params?.source === id) layer.params.source = '';
  }
  await removeMedia(id);
  mediaPool.sync(app.project.media);
  bus.post(MSG.MEDIA, { removed: id });
  app.commit();
};

async function addMediaFiles(files) {
  for (const file of files) {
    try {
      const entry = await importMediaFile(file);
      app.project.media.push(entry);
      toast(`Added ${entry.name}`, 'good');
    } catch (err) {
      toast(`${file.name}: ${err.message}`, 'bad');
    }
  }
  mediaPool.sync(app.project.media);
  sound.warm(app.project.media);
  bus.post(MSG.MEDIA, { added: true });
  app.commit();
}

/* ------------------------------------------------------------------ *
 * Camera + still
 * ------------------------------------------------------------------ */

async function refreshCameraDevices() {
  const select = $('cameraSelect');
  const devices = await camera.listDevices();
  clear(select);
  select.appendChild(el('option', { value: '', text: 'Default camera' }));
  devices.forEach((device, index) => {
    select.appendChild(
      el('option', {
        value: device.deviceId,
        text: device.label || `Camera ${index + 1}`,
        selected: device.deviceId === app.project.settings.cameraId,
      })
    );
  });
  if (!devices.some((d) => d.label)) {
    $('cameraInfo').textContent = 'Camera names appear after you grant permission once.';
  }
}

async function startCamera() {
  try {
    const info = await camera.start($('cameraSelect').value || app.project.settings.cameraId || null);
    app.project.settings.cameraId = info.deviceId;
    const aspect = info.width / info.height;
    if (!app.project.shapes.length) {
      app.project.worldAspect = aspect;
    } else if (Math.abs(app.project.worldAspect - aspect) > 0.02) {
      toast(
        `This camera is ${aspect.toFixed(2)}:1 but the show was traced at ${app.project.worldAspect.toFixed(2)}:1. Shapes will be stretched.`,
        'bad'
      );
    }
    $('cameraInfo').textContent = `${info.label} — ${info.width}×${info.height}`;
    $('stageEmpty').hidden = true;
    stage.resize();
    app.commit();
    await refreshCameraDevices();
  } catch (err) {
    toast(`Could not start the camera: ${err.message}`, 'bad');
  }
}

async function captureStill() {
  const blob = await camera.captureStill();
  if (!blob) {
    toast('Start the camera first', 'bad');
    return;
  }
  await adoptBackdrop(blob, { aspect: camera.aspect(), quiet: true });
  toast('Still captured — you can now trace with the camera switched off.', 'good');
}

/**
 * Object URL for the current backdrop, so it can be released.
 *
 * A blob URL pins its blob for the lifetime of the document. This one is a
 * multi-megabyte still, and it was re-created on every project switch, every
 * new photo and every demo load without the previous one ever being revoked —
 * so an evening of swapping shows quietly accumulated backdrops nothing could
 * reach and nothing would free.
 */
let stillUrl = null;

async function loadStill() {
  const release = () => {
    if (stillUrl) URL.revokeObjectURL(stillUrl);
    stillUrl = null;
  };

  if (!app.project.settings?.hasStill) {
    release();
    stillImage = null;
    return;
  }
  const blob = await getBlob(`still/${app.project.id}`);
  if (!blob) {
    release();
    stillImage = null;
    return;
  }

  release();
  stillUrl = URL.createObjectURL(blob);
  const image = new Image();
  await new Promise((resolve) => {
    image.onload = resolve;
    image.onerror = resolve;
    image.src = stillUrl;
  });
  stillImage = image;
  $('stageEmpty').hidden = true;
}

/**
 * Adopt an image as the backdrop shapes are traced on.
 *
 * The same slot the camera's own "capture still" writes to, which is the point:
 * a photograph of the house taken on a phone in daylight is a perfectly good
 * surface to trace on, and tracing is the slow part. Do it on the sofa, align
 * the projectors on the night.
 *
 * The aspect ratio comes with it, and shapes are stored normalised, so the
 * mapping only stays true if the photo and the camera end up framed alike —
 * hence the warning when it does not match a show already traced.
 */
async function adoptBackdrop(blob, { aspect, quiet = false } = {}) {
  await putBlob(`still/${app.project.id}`, blob);
  app.project.settings.hasStill = true;
  if (aspect > 0.1) {
    if (!app.project.shapes.length) {
      app.project.worldAspect = aspect;
    } else if (Math.abs(app.project.worldAspect - aspect) > 0.02) {
      toast(
        `That picture is ${aspect.toFixed(2)}:1 but the show was traced at ${app.project.worldAspect.toFixed(2)}:1. Shapes will be stretched.`,
        'bad'
      );
    }
  }
  await loadStill();
  stage.resize();
  app.commit();
  if (!quiet) {
    toast('Backdrop set. Trace the windows, the door and the roofline on it.', 'good');
  }
}

/** Downscale and re-encode an imported photo, so it fits in the browser's store. */
async function photoToBackdrop(file, maxWidth = 1600) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('That file is not an image the browser can read.'));
      image.src = url;
    });
    const scale = Math.min(1, maxWidth / image.naturalWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    return { blob, aspect: canvas.width / canvas.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ------------------------------------------------------------------ *
 * The demo house
 *
 * A whole show — facade, traced shapes, an aligned projector and a look — with
 * no hardware and no darkness required. It opens as its own show rather than
 * overwriting the current one, so trying it costs nothing.
 * ------------------------------------------------------------------ */

app.loadDemoHouse = async (presetId = 'halloween') => {
  flushSave();
  const project = createProject('Demo house');
  project.worldAspect = DEMO_ASPECT;
  project.shapes = demoShapes();
  project.settings.isDemo = true;
  project.settings.demoPreset = presetId;
  project.settings.hasStill = true;

  // A plausible manual alignment, so coverage outlines, edge blending and the
  // checklist all behave exactly as they would on a real wall.
  const projector = project.projectors[0];
  projector.name = 'Demo projector';
  projector.calibration.worldQuad = demoWorldQuad();
  const solved = solveFromCorners(projector.calibration.worldQuad);
  if (solved) {
    projector.calibration.H = solved.H;
    projector.calibration.mode = 'manual';
    projector.calibration.quality = solved.quality;
    projector.calibration.calibratedAt = Date.now();
  }

  applyPreset(project, presetId);
  const bursts = addDemoBursts(project);

  app.project = project;
  setCurrentProjectId(project.id);
  await putBlob(`still/${project.id}`, await demoFacadeBlob());

  restore(JSON.stringify(project));
  await loadStill();
  stage.resize();
  clock.play();
  updateTransportUI();
  switchPanel('layers');
  toast(
    `Demo house loaded. Press ${bursts.map((b) => b.key.toUpperCase()).join(', ')} to set things off.`,
    'good'
  );
};

/** Leave the demo behind for an empty show of your own. */
app.startRealShow = () => {
  flushSave();
  const next = createProject('My house');
  app.project = next;
  setCurrentProjectId(next.id);
  restore(JSON.stringify(next));
  stillImage = null;
  switchPanel('start');
  toast('New show. The demo house is still in Shows if you want it back.');
};

/* ------------------------------------------------------------------ *
 * Code panel
 * ------------------------------------------------------------------ */

let currentEffectId = null;

function refreshCodePanel() {
  const picker = $('effectPicker');
  clear(picker);
  const effects = app.project.userEffects || [];
  if (!effects.length) {
    picker.appendChild(el('option', { value: '', text: 'No custom effects yet' }));
    $('codeEditor').value = '';
    updateGutter();
    currentEffectId = null;
    return;
  }
  for (const effect of effects) {
    picker.appendChild(el('option', { value: effect.id, text: effect.name || effect.id }));
  }
  if (!currentEffectId || !effects.some((e) => e.id === currentEffectId)) {
    currentEffectId = effects[0].id;
  }
  picker.value = currentEffectId;
  const record = effects.find((e) => e.id === currentEffectId);
  $('codeEditor').value = record?.code ?? '';
  updateGutter();
  showCompileStatus();
}

function showCompileStatus() {
  const errors = getCompileErrors();
  const node = $('codeStatus');
  if (currentEffectId && errors[currentEffectId]) {
    node.textContent = errors[currentEffectId];
    node.className = 'code-status bad';
  } else if (currentEffectId) {
    node.textContent = 'Compiled.';
    node.className = 'code-status good';
  } else {
    node.textContent = '';
    node.className = 'code-status';
  }
}

function updateGutter() {
  const lines = $('codeEditor').value.split('\n').length;
  $('codeGutter').textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
}

async function applyCode() {
  if (!currentEffectId) return;
  const record = app.project.userEffects.find((e) => e.id === currentEffectId);
  if (!record) return;
  app.pushUndo();
  record.code = $('codeEditor').value;
  record.updatedAt = Date.now();

  // Pull the display name out of the source so the effect list matches what the
  // module actually calls itself.
  const nameMatch = record.code.match(/name\s*:\s*['"`]([^'"`]+)['"`]/);
  if (nameMatch) record.name = nameMatch[1];

  const errors = await loadUserEffects(app.project.userEffects);
  showCompileStatus();
  if (errors[currentEffectId]) {
    toast(`"${record.name}" did not compile — see the Code panel.`, 'bad');
  } else {
    toast(`"${record.name}" is live in every projector tab.`, 'good');
  }
  app.commit();
  refreshCodePanel();
}

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

function togglePlay() {
  const transport = clock.getTransport();
  if (transport.running) clock.pause();
  else clock.play();
  updateTransportUI();
  broadcastClock();
}

function updateTransportUI() {
  const transport = clock.getTransport();
  $('btnPlay').textContent = transport.running ? '❚❚' : '▶';
  $('btnPlay').classList.toggle('active', transport.running);
}

function toggleBlackout() {
  app.project.settings.blackout = !app.project.settings.blackout;
  $('btnBlackout').classList.toggle('active', app.project.settings.blackout);
  app.commitLive();
}

/* ------------------------------------------------------------------ *
 * Main loop
 * ------------------------------------------------------------------ */

/**
 * Preview frame rate and render cost, in the status bar.
 *
 * A show runs for hours unattended, and "it feels like it is slowing down" is
 * almost impossible to act on without a number. Two numbers, in fact, because
 * they mean different things: frames per second says whether the browser is
 * keeping up, and the millisecond figure says how much of the budget this tab's
 * own rendering is using. If fps falls while the millisecond figure does not,
 * the cost is somewhere other than the render — another tab, the compositor, or
 * the machine.
 *
 * Sampled over half a second, because a per-frame readout is unreadable and a
 * per-frame DOM write is itself a cost.
 */
const health = { frames: 0, renderMs: 0, since: performance.now() };

function reportHealth(renderMs) {
  health.frames++;
  health.renderMs += renderMs;
  const now = performance.now();
  const elapsed = now - health.since;
  if (elapsed < 500) return;
  const fps = (health.frames * 1000) / elapsed;
  const perFrame = health.renderMs / health.frames;
  const node = $('stageFps');
  node.textContent = `${fps.toFixed(0)} fps · ${perFrame.toFixed(1)} ms`;
  node.classList.toggle('warn', fps < 45);
  health.frames = 0;
  health.renderMs = 0;
  health.since = now;
}

function frame() {
  requestAnimationFrame(frame);
  const frameStart = performance.now();

  const time = clock.tick();
  $('showTime').textContent = formatTime(time.t);

  // The playlist and trigger runtimes mutate show state on their own. Both need
  // saving as well as broadcasting, or closing the tab mid-scare would reopen
  // stuck in it.
  if (tickPlaylist(app.project)) {
    markDirty();
    broadcast(true);
    renderSceneButtons($('sceneButtons'), app);
    renderSceneList($('sceneList'), app);
  }

  if (tickTriggers()) {
    markDirty();
    broadcast(true);
    renderSceneButtons($('sceneButtons'), app);
  }

  mediaPool.syncPlayback(time.t, time.running);

  /**
   * The preview renders at its own resolution, capped.
   *
   * It was rendering at `cssWidth * devicePixelRatio`, which on a Retina laptop
   * is 2800×1600 — four and a half megapixels of full 2D scene plus a WebGL
   * bloom chain, sixty times a second, for a picture displayed at half that
   * size next to the panels. The projectors are what has to be sharp; this is a
   * thumbnail of a light show that is soft by construction, and the only thing
   * the extra pixels bought was heat.
   *
   * Capping the long edge cuts the work by about three times on exactly the
   * machines that need it and changes nothing you can see: the result is scaled
   * to fit the same box either way, and bloom has already thrown away detail
   * finer than this.
   */
  const { cssWidth, cssHeight, dpr } = stage.size;
  const previewScale = Math.min(dpr, PREVIEW_MAX_EDGE / Math.max(1, cssWidth));
  const targetW = Math.max(64, Math.round(cssWidth * previewScale));
  const targetH = Math.max(64, Math.round(cssHeight * previewScale));
  if (previewCanvas.width !== targetW || previewCanvas.height !== targetH) {
    previewCanvas.width = targetW;
    previewCanvas.height = targetH;
  }

  if (app.showEffectsPreview) {
    worldRenderer.render(previewCtx, {
      project: app.project,
      time,
      audio: audioLevels,
      region: { x: 0, y: 0, w: 1, h: 1 },
      pixelSize: { w: previewCanvas.width, h: previewCanvas.height },
      preview: true,
    });
    renderPreviewPost(targetW, targetH);
  }

  stage.draw({
    previewCanvas: app.showEffectsPreview ? (previewWarp ? previewGL : previewCanvas) : null,
    cameraElement: app.cameraVisible && camera.isRunning() ? camera.video : null,
    /**
     * The still stays whether or not the live view is on.
     *
     * These used to be one switch, so turning the camera view off left a black
     * stage — and that made one perfectly reasonable arrangement impossible:
     * tracing against the captured still (or the demo facade) while a camera is
     * running for an effect to use. The checkbox means "show me the live camera
     * *instead of* the still", which is what it looks like it means.
     */
    stillImage,
    cameraOpacity: app.cameraOpacity,
    showEffects: app.showEffectsPreview,
  });

  // A scene crossfade changes what the buttons should show, but only while it
  // is actually running.
  if (app.project.show?.sceneChangeAt && transitionProgress(app.project.show) < 1) {
    renderSceneButtons($('sceneButtons'), app);
  }

  const world = stage.pointerWorld;
  $('stageCoords').textContent = world ? `${world.x.toFixed(3)}, ${world.y.toFixed(3)}` : '—';

  reportHealth(performance.now() - frameStart);
}

/**
 * Sample the camera for motion and let the trigger runtime act on it.
 *
 * Deliberately not every frame: reading pixels back from the camera stalls the
 * pipeline, and a person walking up a path is not a sub-100ms event.
 */
function tickTriggers() {
  if (!triggerRuntime) return false;
  const now = performance.now();

  let sample = null;
  const wantsMotion = (app.project.triggers || []).some((t) => t.enabled && t.source === 'motion');

  if (wantsMotion && camera.isRunning() && now - lastMotionAt > 120) {
    lastMotionAt = now;
    const frame = camera.captureLuma();
    if (frame) {
      // One frame, measured per trigger region — several triggers can watch
      // different parts of the same view without extra readbacks.
      const readings = new Map();
      for (const trigger of app.project.triggers) {
        if (!trigger.enabled || trigger.source !== 'motion') continue;
        const result = motion.update(frame.luma, frame.width, frame.height, trigger.region);
        readings.set(trigger.id, result.ready ? result.activity : null);
      }
      sample = { activityFor: (trigger) => readings.get(trigger.id) ?? null };
    }
  }

  return triggerRuntime.tick(sample);
}

/**
 * Apply the nightly schedule.
 *
 * Only acts on transitions, so pressing B mid-evening isn't immediately undone
 * by the scheduler on the next tick.
 */
function tickSchedule() {
  const wanted = scheduleWantsOn(app.project.schedule);
  if (wanted === null) {
    scheduleState = null;
    return;
  }
  if (scheduleState === wanted) return;

  scheduleState = wanted;
  app.project.settings.blackout = !wanted;
  $('btnBlackout').classList.toggle('active', !wanted);
  app.commitLive();
  toast(wanted ? 'Scheduled: show on.' : 'Scheduled: show off for the night.', 'good');
}

const GRADE_CONTROLS = [
  { key: 'bloom', label: 'Bloom', min: 0, max: 2, step: 0.01, note: 'How much the halo adds. This is the single biggest look control.' },
  { key: 'bloomThreshold', label: 'Bloom from', min: 0, max: 1.5, step: 0.01, note: 'Brightness at which things start to glow. Lower = more of the frame blooms.' },
  { key: 'bloomKnee', label: 'Bloom knee', min: 0.01, max: 1, step: 0.01, note: 'Softens the threshold so slow fades do not pop into bloom.' },
  { key: 'bloomRadius', label: 'Bloom spread', min: 0.2, max: 4, step: 0.05 },
  { key: 'exposure', label: 'Exposure', min: 0.2, max: 3, step: 0.01 },
  { key: 'contrast', label: 'Contrast', min: 0.4, max: 2.5, step: 0.01 },
  { key: 'saturation', label: 'Saturation', min: 0, max: 2.5, step: 0.01 },
  { key: 'temperature', label: 'Temperature', min: -1, max: 1, step: 0.01, note: 'Negative is colder, positive warmer.' },
  { key: 'gamma', label: 'Gamma', min: 0.4, max: 2.5, step: 0.01 },
];

function refreshLookPanel() {
  const presets = $('gradePresets');
  const controls = $('gradeControls');
  if (!presets || !controls) return;
  const grade = app.project.settings.grade || (app.project.settings.grade = { ...DEFAULT_GRADE });

  clear(presets);
  for (const preset of GRADE_PRESETS) {
    const button = el('button', { type: 'button', class: 'btn small', text: preset.name, title: preset.description });
    button.addEventListener('click', () => {
      app.pushUndo();
      Object.assign(app.project.settings.grade, preset.values);
      app.commit();
      refreshLookPanel();
      toast(`Look: ${preset.name}`);
    });
    presets.appendChild(button);
  }

  clear(controls);
  for (const def of GRADE_CONTROLS) {
    controls.appendChild(
      paramRow({ ...def, type: 'range', default: DEFAULT_GRADE[def.key] }, grade[def.key] ?? DEFAULT_GRADE[def.key], null, {
        onChange: (value) => {
          grade[def.key] = value;
          app.commitLive();
        },
      })
    );
    if (def.note) controls.appendChild(el('p', { class: 'panel-note', text: def.note }));
  }

  const tonemap = el('input', { type: 'checkbox' });
  tonemap.checked = grade.tonemap !== false;
  tonemap.addEventListener('change', () => {
    app.pushUndo();
    grade.tonemap = tonemap.checked;
    app.commit();
  });
  controls.appendChild(el('label', { class: 'inline-check' }, [tonemap, 'Filmic highlight roll-off']));
  controls.appendChild(
    el('p', {
      class: 'panel-note',
      text: 'With this off, anything brighter than white clips flat. With it on, stacked layers and lightning keep their shape.',
    })
  );
}

function updateScheduleNote() {
  const node = $('scheduleNote');
  if (node) node.textContent = describeSchedule(app.project.schedule);
}

function syncScheduleDays() {
  const days = app.project.schedule?.days || [];
  for (const button of document.querySelectorAll('#scheduleDays .tag-toggle')) {
    button.classList.toggle('on', days.includes(Number(button.dataset.day)));
  }
  updateScheduleNote();
}

/**
 * Push the preview through bloom and grading with an identity warp.
 *
 * Falls back to the plain 2D buffer if WebGL is unavailable — the preview loses
 * the glow but editing still works, which is the right trade.
 */
/** Longest edge the preview buffer is allowed to reach, in device pixels. */
const PREVIEW_MAX_EDGE = 1400;

const PREVIEW_MESH = Object.freeze({
  H: null,
  region: Object.freeze({ x: 0, y: 0, w: 1, h: 1 }),
  mesh: null,
  subdivisions: 2,
});

function renderPreviewPost(width, height) {
  if (previewWarpFailed) return;

  if (previewGL.width !== width || previewGL.height !== height) {
    previewGL.width = width;
    previewGL.height = height;
  }

  if (!previewWarp) {
    try {
      previewWarp = createWarpRenderer(previewGL, { preserveDrawingBuffer: true });
    } catch (err) {
      previewWarpFailed = true;
      console.warn('[preview] falling back to ungraded preview:', err.message);
      return;
    }
  }

  // The same object every frame, so `buildMesh` can reject it on identity
  // rather than by serialising it. The preview always shows the whole frame
  // unwarped, so there is nothing here that ever changes.
  previewWarp.buildMesh(PREVIEW_MESH);
  previewWarp.draw(previewCanvas, {
    feather: null,
    gamma: 1,
    brightness: 1,
    grade: app.project.settings?.grade,
  });
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

function syncControlsFromProject() {
  $('projectName').value = app.project.name;
  $('bpm').value = app.project.settings.bpm ?? 120;
  $('master').value = app.project.settings.master ?? 1;
  $('showSafeArea').checked = app.project.settings.showSafeArea !== false;
  $('audioEnabled').checked = !!app.project.settings.audioEnabled;
  $('audioGain').value = app.project.settings.audioGain ?? 1;
  $('scheduleEnabled').checked = !!app.project.schedule?.enabled;
  $('scheduleOn').value = app.project.schedule?.on ?? '18:00';
  $('scheduleOff').value = app.project.schedule?.off ?? '22:30';
  syncScheduleDays();
  $('playlistLoop').checked = app.project.show?.loop !== false;
  $('playlistShuffle').checked = !!app.project.show?.shuffle;
  $('btnBlackout').classList.toggle('active', !!app.project.settings.blackout);
  clock.setTransport({ bpm: app.project.settings.bpm ?? 120 });
}

function wire() {
  for (const tab of document.querySelectorAll('.panel-tab')) {
    tab.addEventListener('click', () => switchPanel(tab.dataset.panel));
  }
  for (const button of document.querySelectorAll('.tool')) {
    button.addEventListener('click', () => setTool(button.dataset.tool));
  }

  $('projectName').addEventListener('change', (ev) => {
    app.pushUndo();
    app.project.name = ev.target.value;
    app.commit();
  });

  $('btnOpenProjector').addEventListener('click', () => {
    const projector = app.selectedProjector();
    app.openProjectorTab(projector?.id);
  });

  $('btnExport').addEventListener('click', () => {
    flushSave();
    exportProjectFile(app.project);
  });

  $('btnImport').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    try {
      const imported = await importProjectFile(file);
      app.pushUndo();
      app.project = imported;
      setCurrentProjectId(imported.id);
      restore(JSON.stringify(imported));
      await loadStill();
      toast(`Loaded "${imported.name}".`, 'good');
    } catch (err) {
      toast(`Could not read that file: ${err.message}`, 'bad');
    }
    ev.target.value = '';
  });

  $('btnHelp').addEventListener('click', () => {
    openHelp('setup');
  });

  $('btnEffectDocs').addEventListener('click', () => {
    // Straight to the API, because that is what the button beside the code
    // editor is for. It used to open the same fourteen-heading scroll as the
    // Help button and leave you to find the reference in it.
    openHelp('api');
  });

  $('btnShows').addEventListener('click', () => {
    renderShowsDialog();
    $('showsDialog').showModal();
  });

  $('btnNewShow').addEventListener('click', () => {
    if (!confirm('Start a new, empty show? The current one stays saved and can be reopened from this list.')) return;
    flushSave();
    const next = createProject('New show');
    app.project = next;
    setCurrentProjectId(next.id);
    restore(JSON.stringify(next));
    $('showsDialog').close();
  });

  /* --- Projectors --- */

  $('btnAddProjector').addEventListener('click', () => app.addProjector());
  $('btnRollCall').addEventListener('click', () => app.rollCall());
  $('btnAutoBlend').addEventListener('click', () => app.autoBlend());

  /* --- Shapes --- */

  $('btnAddRect').addEventListener('click', () => {
    app.pushUndo();
    const shape = createShape(
      [
        { x: 0.35, y: 0.35 },
        { x: 0.65, y: 0.35 },
        { x: 0.65, y: 0.65 },
        { x: 0.35, y: 0.65 },
      ],
      { name: `Area ${app.project.shapes.length + 1}` }
    );
    app.project.shapes.push(shape);
    app.select({ type: 'shape', id: shape.id });
    app.commit();
  });

  $('btnDuplicateShape').addEventListener('click', () => {
    const shape = app.project.shapes.find((s) => s.id === app.selection.id);
    if (!shape) return;
    app.pushUndo();
    const copy = createShape(
      shape.points.map((p) => ({ x: p.x + 0.02, y: p.y + 0.02 })),
      { ...shape, name: `${shape.name} copy` }
    );
    copy.id = createShape([]).id;
    app.project.shapes.push(copy);
    app.select({ type: 'shape', id: copy.id });
    app.commit();
  });

  $('btnDeleteShape').addEventListener('click', deleteSelection);
  $('shapeFilter').addEventListener('input', () => renderShapeList($('shapeList'), app, $('shapeFilter').value));

  /* --- Layers --- */

  $('btnAddLayer').addEventListener('click', () => {
    const [firstCategory] = listByCategory();
    const effectId = firstCategory?.[1]?.[0]?.id || 'fill';
    app.pushUndo();
    const layer = createLayer(effectId, {
      params: defaultParams(effectId),
      order: app.project.layers.length,
      name: getEffect(effectId)?.name || effectId,
      targets: app.selection.type === 'shape' ? [app.selection.id] : [],
    });
    app.project.layers.push(layer);
    app.select({ type: 'layer', id: layer.id });
    app.commit();
  });

  $('btnDuplicateLayer').addEventListener('click', () => {
    const layer = app.project.layers.find((l) => l.id === app.selection.id);
    if (!layer) return;
    app.pushUndo();
    const copy = createLayer(layer.effect, {
      ...layer,
      name: `${layer.name || layer.effect} copy`,
      params: { ...layer.params },
      bindings: JSON.parse(JSON.stringify(layer.bindings || {})),
      targets: [...(layer.targets || [])],
      targetTags: [...(layer.targetTags || [])],
      order: app.project.layers.length,
    });
    copy.id = createLayer('x').id;
    app.project.layers.push(copy);
    app.select({ type: 'layer', id: copy.id });
    app.commit();
  });

  $('btnDeleteLayer').addEventListener('click', deleteSelection);
  $('btnClearLayers').addEventListener('click', () => app.clearLayers());

  const presetActions = $('presetActions');
  for (const preset of PRESETS) {
    const button = el('button', { type: 'button', class: 'btn small', text: preset.name, title: preset.description });
    button.addEventListener('click', () => {
      if (!app.project.shapes.length) {
        toast('Trace and tag some shapes first — the presets target tags like #window and #door.', 'bad');
        switchPanel('shapes');
        return;
      }
      app.pushUndo();
      const result = applyPreset(app.project, preset.id);
      app.commit();
      if (!result) return;
      toast(
        result.missing.length
          ? `Added ${result.added} effects. Nothing is tagged ${result.missing.map((t) => `#${t}`).join(' or ')} yet, so those layers have nothing to draw on.`
          : `Added ${result.added} effects, the "${result.look}" look, and saved it all as the "${result.scene.name}" scene.`,
        result.missing.length ? 'bad' : 'good'
      );
    });
    presetActions.appendChild(button);
  }

  /* --- Scenes --- */

  $('btnCaptureScene').addEventListener('click', () => {
    app.pushUndo();
    const used = new Set(app.project.scenes.map((s) => String(s.hotkey)));
    let hotkey = null;
    for (let i = 1; i <= 9; i++) {
      if (!used.has(String(i))) {
        hotkey = String(i);
        break;
      }
    }
    const scene = createScene({
      name: `Scene ${app.project.scenes.length + 1}`,
      hotkey,
      state: captureScene(app.project),
    });
    app.project.scenes.push(scene);
    /**
     * And you are now in it.
     *
     * Saving a look as a scene and then not being in that scene is a state
     * nobody wants: the panel has no live scene, so it cannot tell you whether
     * what you go on to change has drifted from what you just saved — and the
     * first thing anybody does after saving is keep tweaking.
     */
    applyScene(app.project, scene.id, { fade: 0 });
    app.select({ type: 'scene', id: scene.id });
    app.commit();
    toast(`Saved as "${scene.name}"${hotkey ? ` — press ${hotkey} to recall it.` : '.'}`, 'good');
  });

  $('btnPlaylistAdd').addEventListener('click', () => {
    if (!app.project.scenes.length) {
      toast('Save a scene first.', 'bad');
      return;
    }
    app.pushUndo();
    app.project.show.playlist = app.project.show.playlist || [];
    const scene = app.project.scenes.find((s) => s.id === app.selection.id) || app.project.scenes[0];
    app.project.show.playlist.push({ sceneId: scene.id, duration: 30 });
    app.commit();
  });

  $('playlistLoop').addEventListener('change', (ev) => {
    app.project.show.loop = ev.target.checked;
    app.commitLive();
  });
  $('playlistShuffle').addEventListener('change', (ev) => {
    app.project.show.shuffle = ev.target.checked;
    app.commitLive();
  });

  $('btnRunShow').addEventListener('click', () => {
    const show = app.project.show;
    show.running = !show.running;
    show.playlistStartedAt = null;
    show.playlistIndex = 0;
    $('btnRunShow').textContent = show.running ? 'Stop show' : 'Run show';
    $('btnRunShow').classList.toggle('active', show.running);
    if (show.running && !clock.getTransport().running) {
      clock.play();
      updateTransportUI();
      broadcastClock();
    }
    app.commit();
  });

  /* --- Triggers --- */

  $('btnAddTrigger').addEventListener('click', () => {
    app.pushUndo();
    const trigger = createTrigger({
      name: `Trigger ${(app.project.triggers?.length || 0) + 1}`,
      sceneId: app.project.scenes[0]?.id ?? null,
    });
    app.project.triggers = app.project.triggers || [];
    app.project.triggers.push(trigger);
    app.select({ type: 'trigger', id: trigger.id });
    app.commit();
    if (!app.project.scenes.length) {
      toast('Build the scare you want, save it as a scene, then point this trigger at it.');
    }
  });

  $('btnDeleteTrigger').addEventListener('click', () => {
    if (app.selection.type !== 'trigger') return;
    app.pushUndo();
    app.project.triggers = app.project.triggers.filter((t) => t.id !== app.selection.id);
    app.select(null);
    app.commit();
  });

  /* --- Schedule --- */

  $('scheduleEnabled').addEventListener('change', (ev) => {
    app.project.schedule.enabled = ev.target.checked;
    // Re-evaluate immediately rather than waiting for the next minute tick.
    scheduleState = null;
    app.commit();
    if (!ev.target.checked) {
      app.project.settings.blackout = false;
      $('btnBlackout').classList.remove('active');
      app.commitLive();
    }
  });

  for (const [id, key] of [['scheduleOn', 'on'], ['scheduleOff', 'off']]) {
    $(id).addEventListener('change', (ev) => {
      app.pushUndo();
      app.project.schedule[key] = ev.target.value.trim();
      scheduleState = null;
      app.commit();
    });
  }

  const dayWrap = $('scheduleDays');
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  dayNames.forEach((name, index) => {
    const button = el('button', { type: 'button', class: 'tag-toggle', text: name, dataset: { day: String(index) } });
    button.addEventListener('click', () => {
      app.pushUndo();
      const days = app.project.schedule.days || [];
      app.project.schedule.days = days.includes(index) ? days.filter((d) => d !== index) : [...days, index];
      scheduleState = null;
      app.commit();
      syncScheduleDays();
    });
    dayWrap.appendChild(button);
  });

  /* --- Media --- */

  $('btnAddMedia').addEventListener('click', () => $('mediaFile').click());
  $('mediaFile').addEventListener('change', async (ev) => {
    const files = [...(ev.target.files || [])];
    ev.target.value = '';
    if (files.length) await addMediaFiles(files);
  });

  /* --- Code --- */

  $('btnNewEffect').addEventListener('click', async () => {
    app.pushUndo();
    const record = {
      id: `custom_${Math.random().toString(36).slice(2, 8)}`,
      name: 'My Effect',
      code: EFFECT_TEMPLATE,
      updatedAt: Date.now(),
    };
    app.project.userEffects = app.project.userEffects || [];
    app.project.userEffects.push(record);
    currentEffectId = record.id;
    await loadUserEffects(app.project.userEffects);
    app.commit();
    refreshCodePanel();
    switchPanel('code');
  });

  $('btnDeleteEffect').addEventListener('click', async () => {
    if (!currentEffectId) return;
    const record = app.project.userEffects.find((e) => e.id === currentEffectId);
    if (!record || !confirm(`Delete "${record.name}"? Layers using it will stop drawing.`)) return;
    app.pushUndo();
    app.project.userEffects = app.project.userEffects.filter((e) => e.id !== currentEffectId);
    currentEffectId = null;
    await loadUserEffects(app.project.userEffects);
    app.commit();
    refreshCodePanel();
  });

  $('effectPicker').addEventListener('change', (ev) => {
    currentEffectId = ev.target.value;
    refreshCodePanel();
  });

  $('btnApplyCode').addEventListener('click', applyCode);
  $('codeEditor').addEventListener('input', updateGutter);
  $('codeEditor').addEventListener('scroll', () => {
    $('codeGutter').scrollTop = $('codeEditor').scrollTop;
  });
  $('codeEditor').addEventListener('keydown', (ev) => {
    if (ev.key === 'Tab') {
      ev.preventDefault();
      const area = ev.target;
      const start = area.selectionStart;
      area.value = `${area.value.slice(0, start)}  ${area.value.slice(area.selectionEnd)}`;
      area.selectionStart = area.selectionEnd = start + 2;
      updateGutter();
    } else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      applyCode();
    }
  });

  /* --- Setup --- */

  $('btnStartCamera').addEventListener('click', startCamera);
  $('btnStopCamera').addEventListener('click', () => camera.stop());
  $('cameraSelect').addEventListener('change', () => {
    if (camera.isRunning()) startCamera();
  });
  $('btnFreeze').addEventListener('click', captureStill);
  $('btnClearStill').addEventListener('click', async () => {
    await deleteBlob(`still/${app.project.id}`);
    app.project.settings.hasStill = false;
    stillImage = null;
    app.commit();
    toast('Still cleared.');
  });

  $('btnUsePhoto').addEventListener('click', () => $('photoFile').click());
  $('photoFile').addEventListener('change', async (ev) => {
    const [file] = ev.target.files || [];
    ev.target.value = '';
    if (!file) return;
    try {
      const { blob, aspect } = await photoToBackdrop(file);
      await adoptBackdrop(blob, { aspect });
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

  $('btnEmptyDemo').addEventListener('click', () => app.loadDemoHouse());
  $('btnEmptyPhoto').addEventListener('click', () => $('btnUsePhoto').click());
  $('btnEmptyCamera').addEventListener('click', () => {
    switchPanel('settings');
    startCamera();
  });

  $('audioEnabled').addEventListener('change', async (ev) => {
    app.project.settings.audioEnabled = ev.target.checked;
    if (ev.target.checked) {
      audioAnalyser = audioAnalyser || createAudioAnalyser({ onLevels: onAudioLevels });
      audioAnalyser.setGain(Number($('audioGain').value));
      try {
        await audioAnalyser.start();
      } catch (err) {
        toast(`Microphone unavailable: ${err.message}`, 'bad');
        ev.target.checked = false;
        app.project.settings.audioEnabled = false;
      }
    } else {
      audioAnalyser?.stop();
    }
    app.commit();
  });

  $('audioGain').addEventListener('input', (ev) => {
    app.project.settings.audioGain = Number(ev.target.value);
    audioAnalyser?.setGain(Number(ev.target.value));
    app.commitLive();
  });

  $('showSafeArea').addEventListener('change', (ev) => {
    app.project.settings.showSafeArea = ev.target.checked;
    app.commitLive();
  });
  $('showShapeNames').addEventListener('change', (ev) => {
    app.showShapeNames = ev.target.checked;
    setPref('showShapeNames', ev.target.checked);
  });
  $('showPreviewRender').addEventListener('change', (ev) => {
    app.showEffectsPreview = ev.target.checked;
    setPref('showPreviewRender', ev.target.checked);
  });

  $('btnResetProject').addEventListener('click', () => $('btnNewShow').click());

  $('toggleCamera').addEventListener('change', (ev) => {
    app.cameraVisible = ev.target.checked;
  });
  $('cameraDim').addEventListener('input', (ev) => {
    app.cameraOpacity = Number(ev.target.value);
  });

  /* --- Transport --- */

  $('btnPlay').addEventListener('click', togglePlay);
  $('btnStop').addEventListener('click', () => {
    clock.stop();
    updateTransportUI();
    broadcastClock();
  });
  $('bpm').addEventListener('change', (ev) => {
    const bpm = Math.max(20, Math.min(300, Number(ev.target.value) || 120));
    app.project.settings.bpm = bpm;
    clock.setTransport({ bpm });
    broadcastClock();
    app.commitLive();
  });
  $('master').addEventListener('input', (ev) => {
    app.project.settings.master = Number(ev.target.value);
    app.commitLive();
  });
  $('btnBlackout').addEventListener('click', toggleBlackout);

  window.addEventListener('resize', () => stage.resize());
  window.addEventListener('beforeunload', () => {
    if (dirty) flushSave();
  });

  presence.onChange(() => {
    refreshPanels();
    updateStageStatus();
  });

  bus.on(MSG.HELLO, (payload) => {
    // A projector tab that just opened needs the current state immediately.
    if (payload?.requestState) {
      broadcast(true);
      broadcastClock();
    }
  });

  bus.on(MSG.ERROR, (payload) => {
    toast(`Projector: ${payload.message}`, 'bad');
  });

  /* --- Command palette --- *
   * Almost every action delegates to the button that already does the job
   * rather than reimplementing it, so there is exactly one copy of each
   * behaviour and the palette cannot drift away from the UI it fronts. */
  palette = createPalette(app, {
    openProjector: () => $('btnOpenProjector').click(),
    blackout: () => toggleBlackout(),
    togglePlay: () => togglePlay(),
    runShow: () => $('btnRunShow').click(),
    captureScene: () => $('btnCaptureScene').click(),
    startCamera: () => $('btnStartCamera').click(),
    usePhoto: () => $('btnUsePhoto').click(),
    loadDemo: () => app.loadDemoHouse(),
    exportShow: () => $('btnExport').click(),
    importShow: () => $('btnImport').click(),
    help: () => $('btnHelp').click(),
    calibrate: () => {
      const projector = app.selectedProjector() || app.project.projectors[0];
      if (projector) app.startCalibration(projector.id);
    },
    looks: GRADE_PRESETS.map((p) => [p.name, p.name]),
    applyLook: (name) => {
      const preset = GRADE_PRESETS.find((p) => p.name === name);
      if (!preset) return;
      app.pushUndo();
      Object.assign(app.project.settings.grade, preset.values);
      app.commit();
      refreshLookPanel();
      toast(`Look: ${preset.name}`);
    },
  });
  $('btnPalette').addEventListener('click', () => palette.open());

  document.addEventListener('keydown', onKeyDown);
}

/**
 * The help dialog, opened at a section.
 *
 * Tabs rather than one column: the reference for writing an effect and the list
 * of keyboard shortcuts have nothing to do with each other, and putting them in
 * the same scroll means everybody pages past most of it every time. The tab
 * strip is the same control as the left panel's, so it needs no explaining.
 */
function openHelp(sectionId = 'setup') {
  const body = $('helpBody');
  clear(body);

  const pane = el('div', { class: 'help-pane' });
  const tabs = el('nav', { class: 'panel-tabs help-tabs', role: 'tablist' });

  const show = (id) => {
    const section = HELP_SECTIONS.find((s) => s.id === id) || HELP_SECTIONS[0];
    pane.innerHTML = section.html;
    // Back to the top on every switch, or a long section leaves the next one
    // scrolled to somewhere arbitrary.
    pane.scrollTop = 0;
    for (const button of tabs.children) {
      button.classList.toggle('active', button.dataset.section === section.id);
    }
  };

  for (const section of HELP_SECTIONS) {
    const button = el('button', {
      type: 'button',
      class: 'panel-tab',
      role: 'tab',
      text: section.label,
      dataset: { section: section.id },
    });
    button.addEventListener('click', () => show(section.id));
    tabs.appendChild(button);
  }

  body.append(tabs, pane);
  show(sectionId);
  $('helpDialog').showModal();
}

function onAudioLevels(levels) {
  audioLevels = levels;
  bus.post(MSG.AUDIO, levels);

  // Only while somebody can see it. This fires thirty times a second for as
  // long as the microphone is open — all evening — and there is no reason to
  // touch the DOM at all when the Setup panel is not the one on screen.
  const page = document.querySelector('.panel-page[data-page="settings"]');
  if (!page?.classList.contains('active')) return;
  const meter = $('audioMeter').firstElementChild;
  if (meter) meter.style.transform = `scaleX(${Math.min(1, levels.level)})`;
}

function deleteSelection() {
  const { type, id } = app.selection;
  if (type === 'shape') {
    const shape = app.project.shapes.find((s) => s.id === id);
    if (!shape) return;
    app.pushUndo();
    app.project.shapes = app.project.shapes.filter((s) => s.id !== id);
    for (const layer of app.project.layers) {
      layer.targets = (layer.targets || []).filter((t) => t !== id);
    }
    app.select(null);
    app.commit();
  } else if (type === 'layer') {
    // The whole selection, not just the primary — otherwise multi-select would
    // let you gather ten layers and then delete one of them.
    const ids = new Set(app.selectedLayerIds());
    if (!ids.size) return;
    app.pushUndo();
    app.project.layers = app.project.layers.filter((l) => !ids.has(l.id));
    for (const layerId of ids) {
      for (const scene of app.project.scenes) delete scene.state?.[layerId];
      worldRenderer.resetLayer(layerId);
    }
    app.select(null);
    app.commit();
  }
}

function onKeyDown(ev) {
  const target = ev.target;
  const typing =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement;

  // Ahead of the typing guard on purpose: the whole point of Ctrl+K is that it
  // works from wherever your hands already are, including the middle of a name
  // field. It is also how you get *out* of the palette's own input.
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') {
    ev.preventDefault();
    if (palette?.isOpen?.()) palette.close();
    else palette?.open();
    return;
  }

  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') {
    if (typing) return;
    ev.preventDefault();
    if (ev.shiftKey) redo();
    else undo();
    return;
  }
  if (typing) return;

  switch (ev.key) {
    case 'v':
    case 'V':
      setTool('select');
      break;
    case 'p':
    case 'P':
      setTool('polygon');
      break;
    case 'l':
    case 'L':
      setTool('path');
      break;
    case 'r':
    case 'R':
      setTool('rect');
      break;
    case 'c':
    case 'C':
      setTool('corners');
      break;
    case 'b':
    case 'B':
      toggleBlackout();
      break;
    case ' ':
      ev.preventDefault();
      togglePlay();
      break;
    case 'Enter':
      stage.finishDraft();
      break;
    case 'Escape':
      stage.cancelDraft();
      break;
    case 'Backspace':
    case 'Delete':
      ev.preventDefault();
      if (!stage.undoDraftPoint()) deleteSelection();
      break;
    default: {
      if (/^[1-9]$/.test(ev.key)) {
        const scene = app.project.scenes.find((s) => String(s.hotkey) === ev.key);
        if (scene) app.activateScene(scene.id);
        return;
      }
      // Anything else falls through to the trigger hotkeys.
      if (ev.key.length === 1 && triggerRuntime?.fireByKey(ev.key)) {
        app.commit();
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Shows dialog
 * ------------------------------------------------------------------ */

function renderShowsDialog() {
  const list = $('showsList');
  clear(list);
  const entries = listProjects();
  if (!entries.length) {
    list.appendChild(el('p', { class: 'panel-note', text: 'No saved shows yet.' }));
    return;
  }
  for (const entry of entries) {
    const open = el('button', { type: 'button', class: 'btn small', text: 'Open' });
    open.addEventListener('click', () => {
      flushSave();
      const loaded = loadProject(entry.id);
      if (!loaded) {
        toast('That show could not be loaded.', 'bad');
        return;
      }
      app.project = loaded;
      setCurrentProjectId(loaded.id);
      restore(JSON.stringify(loaded));
      loadStill();
      $('showsDialog').close();
      toast(`Opened "${loaded.name}".`, 'good');
    });

    const remove = el('button', { type: 'button', class: 'btn small danger', text: 'Delete' });
    remove.disabled = entry.id === app.project.id;
    remove.addEventListener('click', () => {
      if (!confirm(`Delete "${entry.name}" permanently?`)) return;
      deleteProject(entry.id);
      renderShowsDialog();
    });

    list.appendChild(
      el('div', { class: 'list-item' }, [
        el('span', { class: 'item-title', text: entry.name }),
        el('span', {
          class: 'item-sub',
          text: new Date(entry.updatedAt).toLocaleString(),
        }),
        open,
        remove,
      ])
    );
  }
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function boot() {
  app.showShapeNames = getPref('showShapeNames', true);
  app.showEffectsPreview = getPref('showPreviewRender', true);
  $('showShapeNames').checked = app.showShapeNames;
  $('showPreviewRender').checked = app.showEffectsPreview;

  wire();
  syncControlsFromProject();
  setTool('select');

  const errors = await loadUserEffects(app.project.userEffects || []);
  for (const [id, message] of Object.entries(errors)) {
    console.warn(`[custom effect ${id}]`, message);
  }

  triggerRuntime = createTriggerRuntime({
    app,
    sound,
    onFired: (trigger) => {
      toast(`${trigger.name} fired`, 'good');
      renderSceneButtons($('sceneButtons'), app);
    },
    /**
     * Report a failed call, and only a failed one.
     *
     * A working webhook should be silent — you will see the lights. A failing
     * one is otherwise completely invisible, because `no-cors` throws away the
     * response, so this is the only place anybody finds out that the URL is
     * wrong or the page is on https.
     */
    onWebhook: (trigger, when, result) => {
      if (!result.ok) toast(`${trigger.name} (${when}): ${result.error}`, 'bad');
    },
  });

  mediaPool.sync(app.project.media || []);
  sound.warm(app.project.media || []);
  await loadStill();

  /**
   * Deliberately not awaited.
   *
   * All this does is fill one dropdown, and `enumerateDevices()` does not
   * always come back — in a headless browser, and occasionally in a background
   * tab, it neither resolves nor rejects. Awaiting it meant the whole control
   * tab stopped there: buttons wired, every panel empty, no error anywhere,
   * because nothing had thrown. A camera list is not worth the rest of the
   * application, and there is nothing below that needs it.
   */
  refreshCameraDevices().catch((err) => {
    console.warn('[facade-mapper] could not list cameras', err);
  });

  stage.resize();
  refreshPanels();
  refreshInspector();
  refreshCodePanel();
  updateStageStatus();
  updateTransportUI();

  // `?demo` opens straight into the demo house, so the app can be linked to
  // rather than described, and `?demo=christmas` picks the look. It creates its
  // own show, so following such a link never costs anybody the one they were
  // working on.
  const params = new URLSearchParams(location.search);
  if (params.has('demo')) {
    const asked = params.get('demo');
    const wanted = PRESETS.some((p) => p.id === asked) ? asked : 'halloween';
    // A link that names a look has to produce that look. Being already on
    // *some* demo is not close enough — following `?demo=christmas` from the
    // Halloween demo and getting Halloween is simply a broken link.
    const already = app.project.settings?.isDemo && app.project.settings?.demoPreset === wanted;
    if (!already) await app.loadDemoHouse(wanted);
  }

  if (app.project.shapes.length || stillImage) $('stageEmpty').hidden = true;

  // Start running. A show controller that opens paused shows a dead frame for
  // every animated effect, which reads as "nothing works" rather than "press
  // play" — and on a Halloween night the thing should just be going.
  clock.play();
  updateTransportUI();

  broadcast(true);
  broadcastClock();
  presence.rollCall();

  // Projector tabs derive time from the wall clock, so they need reminding of
  // the transport state whenever it might have changed underneath them.
  setInterval(broadcastClock, 3000);

  // The schedule only needs checking about as often as the minute changes.
  tickSchedule();
  setInterval(tickSchedule, 20000);

  // Motion readouts are only worth redrawing while you are looking at them.
  setInterval(() => {
    if (document.querySelector('.panel-page[data-page="triggers"]')?.classList.contains('active')) {
      renderMotionStatus($('motionStatus'), app);
    }
  }, 400);

  requestAnimationFrame(frame);
}

/**
 * Boot is a long async chain touching storage, the camera list and IndexedDB,
 * and if any link throws the rest silently never runs — you get a control tab
 * with working buttons, empty panels and no clue why. Say so instead.
 */
boot().catch((err) => {
  console.error('[facade-mapper] startup failed', err);
  toast(`Could not finish starting up: ${err.message}. Reload, or check the browser console.`, 'bad');
});
