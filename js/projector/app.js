/**
 * Projector output tab.
 *
 * Deliberately dumb: it holds no authoritative state. It reads the project from
 * localStorage, listens for updates on the bus, and renders. That means you can
 * close it, reopen it, or drag it to a different display mid-show and lose
 * nothing — which matters when you're outside in the dark on a ladder.
 *
 * Two canvases: the WebGL output carries the warped show; a 2D overlay on top
 * carries calibration markers, test patterns and status, all in raw projector
 * pixels so nothing distorts them.
 */

import { createBus, MSG } from '../core/bus.js';
import { createClock } from '../core/clock.js';
import { createLink } from '../core/link.js';
import { applyDrawMessage } from '../core/drawing.js';
import { loadProject, getBlob } from '../core/storage.js';
import { migrateProject, worldSize } from '../core/state.js';
import { worldToProjector } from '../core/rectify.js';
import { createWorldRenderer } from '../render/worldRenderer.js';
import { createWarpRenderer, computeRegion } from '../render/warp.js';
import { createMediaPool } from '../core/media.js';
import { createScanSource } from '../core/scan.js';
import { loadUserEffects } from '../effects/registry.js';

const output = document.getElementById('output');
const overlay = document.getElementById('overlay');
const overlayCtx = overlay.getContext('2d');
const statusEl = document.getElementById('status');
const noticeEl = document.getElementById('notice');
const pickerEl = document.getElementById('picker');

const bus = createBus('projector');
const clock = createClock();

/**
 * Joining the show from wherever this tab happens to be.
 *
 * Opened from the control machine's own browser this finds a link server and
 * uses it for nothing much — BroadcastChannel already reached this tab. Opened
 * on a second laptop it is the only reason this tab knows there is a show at
 * all: the project, the transport and, crucially, the clock all arrive over it.
 * Opened from GitHub Pages it finds nothing and stays quiet.
 */
const link = createLink(bus, { role: 'projector', label: 'Projector' });

let project = null;
let projectorId = new URLSearchParams(location.search).get('p');
let projector = null;
let warp = null;
let worldRenderer = null;
let mediaPool = null;
let scanSource = null;

/** Intermediate canvas holding the world render for this projector's region. */
const worldCanvas = document.createElement('canvas');
const worldCtx = worldCanvas.getContext('2d', { alpha: true, desynchronized: true });

let region = { x: 0, y: 0, w: 1, h: 1 };
let regionKey = '';
let audio = { level: 0, low: 0, mid: 0, high: 0 };

/** Calibration takes over the screen entirely while it runs. */
let calibFrame = null;

/**
 * Click-to-align: a crosshair the operator drives onto a real feature.
 *
 * Null unless the control tab has asked for a point. `pointAt` outlives the
 * asking, because the pairs are collected one after another and the second
 * feature is rarely on the other side of the house from the first — starting
 * each pick where the last one finished saves crossing the wall every time.
 */
let pointing = null;
let pointAt = { x: 0.5, y: 0.5 };
let identifyUntil = 0;
let statusVisible = false;
/**
 * What the last frame was still winding forward, as `{ layers, behind }`.
 *
 * Read from the renderer after each frame rather than asked for on demand, so
 * the status panel and the frame loop are looking at the same instant.
 */
let syncState = { layers: 0, behind: 0 };
let noticeTimer = null;

let frames = 0;
let fpsAt = performance.now();
let fps = 0;

/* ------------------------------------------------------------------ *
 * Setup
 * ------------------------------------------------------------------ */

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(window.innerWidth * dpr);
  const h = Math.round(window.innerHeight * dpr);
  for (const canvas of [output, overlay]) {
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }
  // The intermediate buffer is sized against the output, so it has to be
  // recomputed whenever the window changes (dragging the tab to a 4K projector).
  updateRegion();
  announce();
  updateStatus();
}

function announce() {
  bus.post(MSG.HELLO, {
    tabId: bus.tabId,
    projectorId,
    width: output.width,
    height: output.height,
    cssWidth: window.innerWidth,
    cssHeight: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
    fullscreen: !!document.fullscreenElement,
    // Which physical display this tab is on. Two projector tabs reporting the
    // same screen origin are sharing a monitor, which means one projector is
    // showing the other's output — invisible from the control tab, and the
    // setup checklist calls it out.
    screenX: window.screenX,
    screenY: window.screenY,
    screenW: window.screen?.width,
    screenH: window.screen?.height,
  });
}

function notify(message, ms = 4000) {
  noticeEl.textContent = message;
  noticeEl.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    noticeEl.hidden = true;
  }, ms);
}

function reportError(message) {
  console.error('[projector]', message);
  notify(message, 8000);
  bus.post(MSG.ERROR, { tabId: bus.tabId, projectorId, message });
}

/* ------------------------------------------------------------------ *
 * Camera, on demand
 *
 * The control tab owns the camera for tracing and alignment, and for a long
 * time it was the only tab that had one. That quietly meant every camera-driven
 * effect worked in the control preview and drew nothing on the actual wall —
 * `ctx.camera()` returned null out here, so a Live Camera layer simply never
 * appeared, with no error to say why.
 *
 * A projector tab now opens the camera itself, but only when something asks:
 * the stream starts on the first `ctx.camera()` call and returns null until it
 * is ready. Nothing pays for a camera it does not use, and a show with no
 * camera effects never touches the device. Opening the same device from several
 * tabs is fine — same origin, so the permission is already granted.
 * ------------------------------------------------------------------ */

let cameraVideo = null;
let cameraState = 'idle'; // idle | starting | ready | failed

function cameraFrame() {
  if (cameraState === 'ready') {
    return cameraVideo && cameraVideo.readyState >= 2 ? cameraVideo : null;
  }
  // One attempt only. A denied permission or an absent device must not turn
  // into a getUserMedia call on every frame for the rest of the night.
  if (cameraState !== 'idle') return null;
  cameraState = 'starting';

  const deviceId = project?.settings?.cameraId || null;
  const constraints = {
    audio: false,
    video: deviceId
      ? { deviceId: { ideal: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
      : { width: { ideal: 1280 }, height: { ideal: 720 } },
  };

  navigator.mediaDevices?.getUserMedia(constraints)
    .then(async (stream) => {
      cameraVideo = document.createElement('video');
      cameraVideo.playsInline = true;
      cameraVideo.muted = true;
      cameraVideo.autoplay = true;
      cameraVideo.srcObject = stream;
      await cameraVideo.play().catch(() => {});
      cameraState = 'ready';
    })
    .catch((err) => {
      cameraState = 'failed';
      reportError(
        `A layer wants the camera but this tab could not open it (${err.name || err.message}). `
        + 'Allow camera access for this tab, or remove the camera layer.'
      );
    });

  return null;
}

/* ------------------------------------------------------------------ *
 * Project handling
 * ------------------------------------------------------------------ */

/**
 * Ask for whatever has already been drawn.
 *
 * A tab opened at nine o'clock has missed every stroke that made the picture,
 * and there is no replaying them — so it asks, once per surface, and is sent
 * the lot. Done from here rather than at boot because the project usually
 * arrives after this tab does, and until it has there is nothing to ask about.
 */
const askedForDrawings = new Set();
function requestDrawings() {
  for (const layer of project?.layers || []) {
    if (layer.effect !== 'live-draw') continue;
    const surface = (layer.params?.surface || '').trim() || layer.id;
    if (askedForDrawings.has(surface)) continue;
    askedForDrawings.add(surface);
    bus.post(MSG.DRAW, { kind: 'request', surface });
  }
}

async function setProject(next) {
  const previousEffectSignature = signatureOfUserEffects(project);
  project = next;
  requestDrawings();

  if (signatureOfUserEffects(project) !== previousEffectSignature) {
    const errors = await loadUserEffects(project.userEffects || []);
    for (const [id, message] of Object.entries(errors)) {
      reportError(`Custom effect "${id}" failed to compile: ${message}`);
    }
  }

  mediaPool.sync(project.media || []);
  scanSource.sync(project, worldSize(project), getBlob);
  projector = resolveProjector();

  if (projector) {
    // The tab may have opened before the project existed, or with `?p=2` meaning
    // "the second projector". Settle on the real id so presence tracking in the
    // control tab matches, and drop the picker if it was showing.
    if (projectorId !== projector.id) {
      projectorId = projector.id;
      const url = new URL(location.href);
      url.searchParams.set('p', projector.id);
      history.replaceState(null, '', url);
      announce();
    }
    pickerEl.hidden = true;
  } else if (!pickerEl.hidden || !projectorId) {
    showPicker();
  }

  updateRegion();
  updateStatus();
}

function signatureOfUserEffects(p) {
  return (p?.userEffects || []).map((e) => `${e.id}:${(e.code || '').length}:${e.updatedAt || 0}`).join('|');
}

function resolveProjector() {
  if (!project?.projectors?.length) return null;
  if (!projectorId) return null;
  return (
    project.projectors.find((p) => p.id === projectorId) ||
    project.projectors[Number(projectorId) - 1] ||
    null
  );
}

function updateRegion() {
  if (!projector) return;
  // The stored matrix is camera -> projector; world space may no longer be the
  // camera image, so compose in the rectification before anything geometric.
  const H = worldToProjector(project, projector);
  region = computeRegion(H);

  const world = worldSize(project);
  const quality = Math.max(0.5, Math.min(2.5, projector.quality ?? 1.25));

  // Size the intermediate buffer to the region, so a projector covering one
  // window doesn't pay for the resolution of the whole camera frame.
  const targetW = Math.round(region.w * world.w * quality);
  const targetH = Math.round(region.h * world.h * quality);

  // Then cap it against the projector's own output. This buffer is uploaded to
  // the GPU every single frame, so pixels beyond what the lens can resolve cost
  // real bandwidth and buy nothing. `quality` above 1 still buys supersampling.
  const scale = Math.min(
    1,
    (output.width * quality) / targetW,
    (output.height * quality) / targetH,
    4096 / Math.max(targetW, targetH)
  );
  const w = Math.max(64, Math.round(targetW * scale));
  const h = Math.max(64, Math.round(targetH * scale));

  if (worldCanvas.width !== w || worldCanvas.height !== h) {
    worldCanvas.width = w;
    worldCanvas.height = h;
  }

  const key = JSON.stringify({ H, region, mesh: projector.mesh });
  if (key !== regionKey) {
    regionKey = key;
    warp?.buildMesh({ H, region, mesh: projector.mesh });
  }
}

/* ------------------------------------------------------------------ *
 * Projector picker (when the tab was opened without a target)
 * ------------------------------------------------------------------ */

function showPicker() {
  const list = document.getElementById('pickerList');
  const empty = document.getElementById('pickerEmpty');
  list.innerHTML = '';

  if (!project?.projectors?.length) {
    empty.hidden = false;
  } else {
    empty.hidden = true;
    for (const p of project.projectors) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'picker-item';
      button.innerHTML = `<strong>${escapeHtml(p.name)}</strong><span>${
        p.calibration?.H ? 'aligned' : 'not aligned yet'
      }</span>`;
      button.addEventListener('click', () => {
        projectorId = p.id;
        const url = new URL(location.href);
        url.searchParams.set('p', p.id);
        history.replaceState(null, '', url);
        pickerEl.hidden = true;
        projector = resolveProjector();
        updateRegion();
        announce();
        updateStatus();
        statusVisible = true;
        setTimeout(() => {
          statusVisible = false;
        }, 6000);
      });
      list.appendChild(button);
    }
  }
  pickerEl.hidden = false;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

/* ------------------------------------------------------------------ *
 * Calibration + test patterns (drawn in raw projector pixels)
 * ------------------------------------------------------------------ */

function drawOverlay(now) {
  const g = overlayCtx;
  const w = overlay.width;
  const h = overlay.height;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, w, h);

  if (calibFrame) {
    drawCalibrationFrame(g, w, h, calibFrame);
    overlay.style.opacity = '1';
    return;
  }

  const pattern = projector?.testPattern || 'off';
  const identifying = now < identifyUntil;

  if (pointing) {
    // Pointing is exclusive. You are being asked to find a corner of the real
    // building through the projected light, so the least light on it the
    // better — a test pattern or the show underneath is glare on the very
    // thing you are aiming at.
    overlay.style.opacity = '1';
    drawPointing(g, w, h, now);
    return;
  }

  if (pattern === 'off' && !identifying) {
    overlay.style.opacity = '0';
    return;
  }
  overlay.style.opacity = '1';

  if (pattern !== 'off') drawTestPattern(g, w, h, pattern);
  if (identifying) drawIdentify(g, w, h, now);
}

function drawCalibrationFrame(g, w, h, frame) {
  g.fillStyle = '#000';
  g.fillRect(0, 0, w, h);
  if (frame.kind === 'black') return;

  if (frame.kind === 'white') {
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    return;
  }

  // A single filled disc with a soft core. The control tab finds its centroid in
  // the camera image, so a simple high-contrast blob beats any coded pattern.
  const radius = Math.max(6, Math.min(w, h) * (frame.radius ?? 0.045));
  for (const [s, t] of frame.positions || []) {
    const x = s * w;
    const y = t * h;
    const grad = g.createRadialGradient(x, y, 0, x, y, radius);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.65, '#ffffff');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, radius, 0, Math.PI * 2);
    g.fill();
  }
}

/**
 * Patterns that replace the show with a flat field, rather than drawing over it.
 *
 * White, the primaries and the greyscale ramp are measurements: you are reading
 * the lamp, the colour and the black level off the wall, so anything else in the
 * frame is contamination. The grid and the corner marks are the opposite kind of
 * thing — they exist to be lined up against the building, and on a manual
 * alignment the show is what you are lining up. Blacking it out hid the very
 * animation that tells you the shapes have landed on the right windows, so the
 * alignment patterns now draw on top of it.
 */
const OPAQUE_PATTERNS = new Set(['white', 'red', 'green', 'blue', 'greyscale']);

/**
 * Stroke a path twice: a dark casing first, then the bright line inside it.
 *
 * Alignment marks sit over the running show now rather than over a black field,
 * and a white line across a lit window is not a line. One extra stroke keeps
 * every mark readable whatever is underneath it.
 */
function haloStroke(g, colour, width, trace) {
  g.strokeStyle = 'rgba(0,0,0,0.85)';
  g.lineWidth = width * 2.2;
  g.beginPath();
  trace(g);
  g.stroke();
  g.strokeStyle = colour;
  g.lineWidth = width;
  g.beginPath();
  trace(g);
  g.stroke();
}

function drawTestPattern(g, w, h, pattern) {
  if (OPAQUE_PATTERNS.has(pattern)) {
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, h);
  }

  if (pattern === 'white' || pattern === 'red' || pattern === 'green' || pattern === 'blue') {
    g.fillStyle = { white: '#fff', red: '#f00', green: '#0f0', blue: '#00f' }[pattern];
    g.fillRect(0, 0, w, h);
    return;
  }

  if (pattern === 'grid') {
    const step = Math.round(Math.min(w, h) / 16);
    g.lineCap = 'butt';
    g.lineJoin = 'miter';

    haloStroke(g, '#00ff88', Math.max(1, step / 40), (c) => {
      for (let x = 0; x <= w; x += step) {
        c.moveTo(x, 0);
        c.lineTo(x, h);
      }
      for (let y = 0; y <= h; y += step) {
        c.moveTo(0, y);
        c.lineTo(w, y);
      }
    });

    // The border is the frame edge itself, so it is drawn half a width inside:
    // centred on the edge, a projector would only ever show you half of it.
    const border = Math.max(2, step / 12);
    haloStroke(g, '#ff0055', border, (c) => {
      c.rect(border / 2, border / 2, w - border, h - border);
      c.moveTo(0, 0);
      c.lineTo(w, h);
      c.moveTo(w, 0);
      c.lineTo(0, h);
    });

    const label = `${w} × ${h}`;
    g.font = `${Math.round(Math.min(w, h) / 22)}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = Math.max(3, Math.min(w, h) / 160);
    g.strokeStyle = 'rgba(0,0,0,0.85)';
    g.strokeText(label, w / 2, h / 2);
    g.fillStyle = '#fff';
    g.fillText(label, w / 2, h / 2);
    return;
  }

  if (pattern === 'corners') {
    const size = Math.min(w, h) * 0.15;
    const width = Math.max(3, size / 14);

    /*
     * Every leg used to be laid down the frame edge itself, and a stroke is
     * centred on its path: half of each mark was outside the canvas and never
     * reached the lamp. What survived was a couple of pixels in the outermost
     * row of the panel — the row a projector's own overscan eats first, and the
     * row that most often lands past the end of the wall. The corners were being
     * drawn and were still not there to line anything up against.
     *
     * Offsetting each apex inward by half the line width puts the *outer* edge
     * of the stroke on the frame edge, so the mark still says exactly where the
     * corner of the output falls, at its full thickness.
     */
    const inset = width / 2;
    g.lineCap = 'butt';
    g.lineJoin = 'miter';
    for (const [cx, cy, dx, dy] of [
      [inset, inset, 1, 1],
      [w - inset, inset, -1, 1],
      [w - inset, h - inset, -1, -1],
      [inset, h - inset, 1, -1],
    ]) {
      haloStroke(g, '#fff', width, (c) => {
        c.moveTo(cx, cy + dy * size);
        c.lineTo(cx, cy);
        c.lineTo(cx + dx * size, cy);
      });
    }

    haloStroke(g, '#fff', width, (c) => {
      c.moveTo(w / 2 - size / 2, h / 2);
      c.lineTo(w / 2 + size / 2, h / 2);
      c.moveTo(w / 2, h / 2 - size / 2);
      c.lineTo(w / 2, h / 2 + size / 2);
    });
    haloStroke(g, '#fff', width, (c) => {
      c.arc(w / 2, h / 2, size / 2, 0, Math.PI * 2);
    });
    return;
  }

  if (pattern === 'greyscale') {
    const steps = 11;
    for (let i = 0; i < steps; i++) {
      const v = Math.round((i / (steps - 1)) * 255);
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect((i * w) / steps, h * 0.3, w / steps + 1, h * 0.4);
    }
  }
}

/**
 * The crosshair, drawn to be found from the end of the path.
 *
 * Full-frame hairlines rather than a compact reticle: a small mark on a house
 * at night is genuinely hard to locate, and two lines that cross the whole
 * output can be picked up anywhere along their length and followed in. The
 * bright core at the intersection is the part you actually place, and it is
 * the only part drawn at full brightness so that it stays the thing your eye
 * goes to.
 */
function drawPointing(g, w, h, now) {
  g.fillStyle = '#000';
  g.fillRect(0, 0, w, h);

  const x = pointAt.x * w;
  const y = pointAt.y * h;
  const unit = Math.min(w, h);
  const pulse = 0.5 + 0.5 * Math.sin(now / 260);

  g.lineCap = 'butt';
  g.lineJoin = 'miter';
  g.strokeStyle = `rgba(0,255,136,${0.5 + 0.3 * pulse})`;
  g.lineWidth = Math.max(2, unit / 450);
  g.beginPath();
  g.moveTo(0, y);
  g.lineTo(w, y);
  g.moveTo(x, 0);
  g.lineTo(x, h);
  g.stroke();

  // The core: a gap at the centre so the thing being aimed at is not covered
  // by the mark aiming at it.
  const gap = unit * 0.012;
  const arm = unit * 0.05;
  haloStroke(g, '#ffffff', Math.max(2, unit / 420), (c) => {
    c.moveTo(x - arm, y);
    c.lineTo(x - gap, y);
    c.moveTo(x + gap, y);
    c.lineTo(x + arm, y);
    c.moveTo(x, y - arm);
    c.lineTo(x, y - gap);
    c.moveTo(x, y + gap);
    c.lineTo(x, y + arm);
  });
  haloStroke(g, '#ffffff', Math.max(1.5, unit / 700), (c) => {
    c.arc(x, y, gap, 0, Math.PI * 2);
  });

  const label = pointing?.label || 'Put the cross on the feature and click';
  const size = Math.round(unit / 34);
  g.font = `600 ${size}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = Math.max(3, size / 4);
  g.strokeStyle = 'rgba(0,0,0,0.9)';
  const lines = [label, 'Arrow keys nudge · Enter places it · Esc cancels'];
  lines.forEach((line, i) => {
    const ly = h - size * (2.6 - i * 1.4);
    g.strokeText(line, w / 2, ly);
    g.fillStyle = i ? 'rgba(255,255,255,0.6)' : '#00ff88';
    g.fillText(line, w / 2, ly);
  });
}

function drawIdentify(g, w, h, now) {
  const pulse = 0.5 + 0.5 * Math.sin(now / 120);
  g.fillStyle = `rgba(0,0,0,${0.4 + 0.3 * pulse})`;
  g.fillRect(0, 0, w, h);
  g.fillStyle = `rgba(255,255,255,${0.6 + 0.4 * pulse})`;
  g.font = `700 ${Math.round(Math.min(w, h) / 6)}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(projector?.name || 'Projector', w / 2, h / 2);
}

/* ------------------------------------------------------------------ *
 * Main loop
 * ------------------------------------------------------------------ */

function frame(now) {
  requestAnimationFrame(frame);

  frames++;
  if (now - fpsAt > 500) {
    fps = (frames * 1000) / (now - fpsAt);
    frames = 0;
    fpsAt = now;
    if (statusVisible) updateStatus();
  } else if (statusVisible && syncState.layers) {
    // Twice a second is the right rate for a frame counter and far too slow to
    // watch a catch-up close, which is over in a second or two.
    updateStatus();
  }

  drawOverlay(now);

  if (calibFrame) {
    // Nothing but the calibration pattern should be on screen.
    warp?.clear();
    if (calibFrame.pendingAck) {
      // Ack a frame late so the compositor has actually put it on the wall.
      calibFrame.pendingAck = false;
      requestAnimationFrame(() => {
        bus.post(MSG.CALIB_ACK, { tabId: bus.tabId, projectorId, index: calibFrame?.index ?? -1 });
      });
    }
    return;
  }

  if (pointing) {
    // Same reasoning as the black field behind the crosshair: the operator is
    // looking for a real edge on a real building, and the show is light on it.
    warp?.clear();
    return;
  }

  if (!project || !projector) return;

  const time = clock.tick();
  mediaPool.syncPlayback(time.t, time.running);
  // The relief map is loaded asynchronously and the field is rebuilt when the
  // scan is re-placed, so this cannot be a one-shot at project load. It costs a
  // string compare on the frames where nothing has moved.
  if (project) scanSource.sync(project, worldSize(project), getBlob);

  if (!projector.enabled || projector.blackout || project.settings?.blackout) {
    warp?.clear();
    return;
  }

  worldRenderer.render(worldCtx, {
    project,
    time,
    audio,
    region,
    pixelSize: { w: worldCanvas.width, h: worldCanvas.height },
  });
  syncState = worldRenderer.catchingUp();

  try {
    warp.draw(worldCanvas, {
      feather: projector.blend,
      gamma: projector.blend?.gamma ?? 1.8,
      brightness: projector.brightness ?? 1,
      // Grading lives on the project, not the projector, so every output
      // applies the same curve and overlapping projectors still match.
      grade: project.settings?.grade,
    });
  } catch (err) {
    reportError(`Warp failed: ${err.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * Status panel
 * ------------------------------------------------------------------ */

function updateStatus() {
  statusEl.hidden = !statusVisible;
  if (!statusVisible) return;

  const calib = projector?.calibration;
  document.getElementById('statusName').textContent = projector?.name || 'Unassigned';
  document.getElementById('statusRes').textContent = `${output.width} × ${output.height}`;
  document.getElementById('statusCalib').textContent = calib?.H
    ? `${calib.mode === 'auto' ? 'auto' : 'manual'}${
        calib.quality ? ` · ${(calib.quality.meanPx ?? 0).toFixed(1)} px error` : ''
      }`
    : 'not aligned';
  document.getElementById('statusBuffer').textContent = `${worldCanvas.width} × ${worldCanvas.height}`;
  document.getElementById('statusFps').textContent = `${fps.toFixed(0)} fps`;
  const transport = clock.getTransport();
  document.getElementById('statusShow').textContent = transport.running
    ? `running · ${transport.t.toFixed(1)}s`
    : 'paused';

  /**
   * Whether anything is still winding forward to where the show actually is.
   *
   * A tab reloaded mid-evening runs the simulation it missed before it paints
   * anything — the effects that carry a history are held back rather than shown
   * racing — so for a second or two after a reload some of the wall is
   * deliberately dark. This is the line that says so, and this is exactly when
   * somebody is looking at it: the panel shows itself for six seconds on load.
   */
  document.getElementById('statusSync').textContent = syncState.layers
    ? `catching up · ${syncState.layers} layer${syncState.layers === 1 ? '' : 's'}, ${
        syncState.behind < 60
          ? `${syncState.behind.toFixed(0)}s`
          : `${Math.round(syncState.behind / 60)} min`
      } behind`
    : 'in step';

  /**
   * How far this machine's clock has been corrected, and how well it is known.
   *
   * On the machine running the server this reads as a millisecond or two. On a
   * second laptop it is however wrong that laptop's clock is — and when two
   * projectors on one wall disagree, this is the first line to look at, from
   * the ladder, by pressing I.
   */
  const state = link.state();
  const sync = state.sync;
  const drift = Math.abs(sync.offset);
  document.getElementById('statusLink').textContent =
    state.status === 'linked'
      ? sync.synced
        ? `${state.server || 'linked'} · ${
            drift < 1 ? 'in step' : `${sync.offset > 0 ? '+' : '-'}${Math.round(drift)} ms`
          } (±${sync.rtt < 2 ? '<1' : Math.round(sync.rtt / 2)} ms)`
        : `${state.server || 'linked'} · syncing`
      : state.status === 'connecting'
        ? 'reconnecting'
        : 'this browser only';
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

bus.on(MSG.PROJECT, (payload) => {
  setProject(migrateProject(payload));
});

bus.on(MSG.ROLL_CALL, () => announce());

bus.on(MSG.CLOCK, (payload) => {
  clock.setTransport(payload);
});

bus.on(MSG.AUDIO, (payload) => {
  audio = payload || audio;
});

bus.on(MSG.CALIB, (payload) => {
  if (payload.projectorId && payload.projectorId !== projectorId) return;
  if (payload.kind === 'end') {
    calibFrame = null;
    return;
  }
  calibFrame = { ...payload, pendingAck: true };
});

bus.on(MSG.POINT, (payload) => {
  if (payload.projectorId && payload.projectorId !== projectorId) return;
  setPointing(payload.active ? { label: payload.label || '' } : null);
});

bus.on(MSG.COMMAND, (payload) => {
  if (payload.projectorId && payload.projectorId !== projectorId) return;
  switch (payload.action) {
    case 'identify':
      identifyUntil = performance.now() + (payload.ms || 3000);
      break;
    case 'fullscreen':
      requestFullscreen();
      break;
    case 'reload':
      location.reload();
      break;
    case 'status':
      statusVisible = !statusVisible;
      updateStatus();
      break;
    default:
      break;
  }
});

bus.on(MSG.MEDIA, () => {
  if (project) mediaPool.sync(project.media || []);
});

/**
 * Ink from a drawing tablet.
 *
 * Applied here rather than sent as pixels: every tab runs the same messages
 * through the same store and paints the same drawing, which is the same reason
 * effects use a seeded generator. Two projectors overlapping on one wall have
 * to agree about what is drawn on it.
 */
bus.on(MSG.DRAW, (payload) => {
  if (payload?.kind === 'request') return;
  applyDrawMessage(payload);
});

/**
 * The relief map lives in IndexedDB and the project only carries its metadata,
 * so a re-import with the same `importedAt` would not be noticed. Dropping what
 * we have makes the next frame re-read it.
 */
bus.on(MSG.SCAN, () => {
  if (project) scanSource.reload(project, worldSize(project), getBlob);
});

window.addEventListener('beforeunload', () => {
  bus.post(MSG.BYE, { tabId: bus.tabId, projectorId });
});

window.addEventListener('resize', resize);
document.addEventListener('fullscreenchange', () => {
  announce();
  resize();
});

function requestFullscreen() {
  document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch((err) => {
    notify(`Could not go fullscreen: ${err.message}`);
  });
}

/* ------------------------------------------------------------------ *
 * Click-to-align
 *
 * The overlay is `pointer-events: none` for the whole of the rest of the
 * night — a projector tab that can be clicked is a projector tab somebody
 * accidentally drags a selection across — so it is turned on only while a
 * point is being asked for, and off again the moment one is given.
 * ------------------------------------------------------------------ */

function setPointing(next) {
  pointing = next;
  overlay.style.pointerEvents = next ? 'auto' : 'none';
  document.body.classList.toggle('pointing', !!next);
}

function movePointTo(clientX, clientY) {
  const rect = overlay.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  pointAt = {
    x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
  };
}

/**
 * Nudge, in whole output pixels.
 *
 * A mouse on a trestle table in the dark does not place a point on a window
 * reveal thirty feet away, and the error it leaves is a couple of pixels. The
 * arrow keys are the part of this that makes the alignment better than the one
 * you get by dragging corners: they move the mark by exactly one pixel of the
 * thing being aligned.
 */
function nudgePoint(dx, dy, coarse) {
  const step = coarse ? 10 : 1;
  pointAt = {
    x: Math.min(1, Math.max(0, pointAt.x + (dx * step) / Math.max(1, output.width))),
    y: Math.min(1, Math.max(0, pointAt.y + (dy * step) / Math.max(1, output.height))),
  };
}

function placePoint() {
  if (!pointing) return;
  bus.post(MSG.POINTED, { tabId: bus.tabId, projectorId, x: pointAt.x, y: pointAt.y });
  setPointing(null);
}

function cancelPoint() {
  if (!pointing) return;
  bus.post(MSG.POINTED, { tabId: bus.tabId, projectorId, cancel: true });
  setPointing(null);
}

overlay.addEventListener('pointermove', (ev) => {
  if (!pointing) return;
  movePointTo(ev.clientX, ev.clientY);
});

overlay.addEventListener('pointerdown', (ev) => {
  if (!pointing) return;
  ev.preventDefault();
  movePointTo(ev.clientX, ev.clientY);
  placePoint();
});

window.addEventListener('keydown', (ev) => {
  if (!pointing || ev.metaKey || ev.ctrlKey) return;
  const nudges = {
    arrowleft: [-1, 0],
    arrowright: [1, 0],
    arrowup: [0, -1],
    arrowdown: [0, 1],
  };
  const key = ev.key.toLowerCase();
  const nudge = nudges[key];
  if (nudge) {
    ev.preventDefault();
    nudgePoint(nudge[0], nudge[1], ev.shiftKey);
    return;
  }
  if (key === 'enter' || key === ' ') {
    ev.preventDefault();
    placePoint();
  } else if (key === 'escape') {
    ev.preventDefault();
    cancelPoint();
  }
});

window.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  switch (ev.key.toLowerCase()) {
    case 'f':
      if (document.fullscreenElement) document.exitFullscreen();
      else requestFullscreen();
      break;
    case 'i':
      statusVisible = !statusVisible;
      updateStatus();
      break;
    case 't': {
      // Local test-pattern cycling, so you can check a projector without
      // walking back to the control machine.
      if (!projector) break;
      const patterns = ['off', 'grid', 'corners', 'white', 'greyscale'];
      const next = patterns[(patterns.indexOf(projector.testPattern || 'off') + 1) % patterns.length];
      projector.testPattern = next;
      notify(`Test pattern: ${next}`);
      break;
    }
    default:
      break;
  }
});

// Hide the cursor once it stops moving — a mouse pointer on the house is not
// part of the show.
let cursorTimer = null;
window.addEventListener('mousemove', () => {
  document.body.classList.remove('hide-cursor');
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => document.body.classList.add('hide-cursor'), 2500);
});

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

async function boot() {
  try {
    warp = createWarpRenderer(output);
  } catch (err) {
    reportError(err.message);
    return;
  }

  mediaPool = createMediaPool({ onError: reportError });
  scanSource = createScanSource({ onError: reportError });
  worldRenderer = createWorldRenderer({
    mediaPool,
    camera: cameraFrame,
    depth: () => scanSource.get(),
    onEffectError: ({ effectId, message }) => reportError(`Effect "${effectId}": ${message}`),
  });

  const stored = loadProject();
  if (stored) await setProject(stored);

  resize();
  if (!projector) showPicker();
  else {
    statusVisible = true;
    updateStatus();
    setTimeout(() => {
      statusVisible = false;
      updateStatus();
    }, 6000);
  }

  announce();
  // The control tab may have started before this tab; ask it to resend state.
  bus.post(MSG.HELLO, { tabId: bus.tabId, projectorId, requestState: true, width: output.width, height: output.height });

  requestAnimationFrame(frame);
  setInterval(announce, 4000);
}

boot();
