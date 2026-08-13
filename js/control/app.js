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
import { createWarpRenderer } from '../render/warp.js';
import { GRADE_PRESETS, DEFAULT_GRADE } from '../render/postfx.js';
import { createMediaPool, importMediaFile, removeMedia } from '../core/media.js';
import { loadUserEffects, listByCategory, defaultParams, getEffect, getCompileErrors } from '../effects/registry.js';
import { captureScene, activateScene as applyScene, tickPlaylist, transitionProgress } from '../core/scenes.js';
import { createCamera } from './camera.js';
import { runCalibration, checkDrift, solveFromCorners } from './calibration.js';
import { createStage, defaultWorldQuad } from './stage.js';
import { createAudioAnalyser } from './audio.js';
import { renderInspector } from './inspector.js';
import { renderSetupGuide } from './setup.js';
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
import { HELP_HTML, EFFECT_TEMPLATE } from './help.js';
import { PRESETS, applyPreset } from './presets.js';

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

const worldRenderer = createWorldRenderer({
  mediaPool,
  camera: () => (camera.isRunning() ? camera.video : null),
  onEffectError: ({ effectId, message }) => toast(`Effect "${effectId}" threw: ${message}`, 'bad'),
});

const stage = createStage({ canvas: $('stage'), wrap: $('stageWrap'), app });

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

app.commit = () => {
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

app.select = (selection) => {
  app.selection = selection || { type: null, id: null };
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
  if (!unaligned.length) {
    node.textContent = 'All projectors are aligned. Open their tabs and press F for fullscreen.';
    return;
  }
  node.textContent = `${unaligned.length} projector${unaligned.length === 1 ? '' : 's'} still need aligning. Select one and use "Align with camera".`;
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

app.activateScene = (sceneId) => {
  applyScene(app.project, sceneId);
  app.commit();
};

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
  await putBlob(`still/${app.project.id}`, blob);
  app.project.settings.hasStill = true;
  await loadStill();
  app.commit();
  toast('Still captured — you can now trace with the camera switched off.', 'good');
}

async function loadStill() {
  if (!app.project.settings?.hasStill) {
    stillImage = null;
    return;
  }
  const blob = await getBlob(`still/${app.project.id}`);
  if (!blob) {
    stillImage = null;
    return;
  }
  const url = URL.createObjectURL(blob);
  const image = new Image();
  await new Promise((resolve) => {
    image.onload = resolve;
    image.onerror = resolve;
    image.src = url;
  });
  stillImage = image;
  $('stageEmpty').hidden = true;
}

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

function frame() {
  requestAnimationFrame(frame);

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

  const { cssWidth, cssHeight, dpr } = stage.size;
  const targetW = Math.max(64, Math.round(cssWidth * dpr));
  const targetH = Math.max(64, Math.round(cssHeight * dpr));
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
    stillImage: app.cameraVisible ? stillImage : null,
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

  previewWarp.buildMesh({
    H: null,
    region: { x: 0, y: 0, w: 1, h: 1 },
    mesh: null,
    subdivisions: 2,
  });
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
    $('helpBody').innerHTML = HELP_HTML;
    $('helpDialog').showModal();
  });

  $('btnEffectDocs').addEventListener('click', () => {
    $('helpBody').innerHTML = HELP_HTML;
    $('helpDialog').showModal();
    $('helpBody').querySelector('h2:nth-of-type(5)')?.scrollIntoView();
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

  document.addEventListener('keydown', onKeyDown);
}

function onAudioLevels(levels) {
  audioLevels = levels;
  bus.post(MSG.AUDIO, levels);
  const meter = $('audioMeter').firstElementChild;
  if (meter) meter.style.width = `${Math.min(100, levels.level * 100)}%`;
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
    app.pushUndo();
    app.project.layers = app.project.layers.filter((l) => l.id !== id);
    for (const scene of app.project.scenes) delete scene.state?.[id];
    worldRenderer.resetLayer(id);
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
  });

  mediaPool.sync(app.project.media || []);
  sound.warm(app.project.media || []);
  await loadStill();
  await refreshCameraDevices();

  stage.resize();
  refreshPanels();
  refreshInspector();
  refreshCodePanel();
  updateStageStatus();
  updateTransportUI();

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

boot();
