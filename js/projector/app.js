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
import { loadProject } from '../core/storage.js';
import { migrateProject, worldSize } from '../core/state.js';
import { createWorldRenderer } from '../render/worldRenderer.js';
import { createWarpRenderer, computeRegion } from '../render/warp.js';
import { createMediaPool } from '../core/media.js';
import { loadUserEffects } from '../effects/registry.js';

const output = document.getElementById('output');
const overlay = document.getElementById('overlay');
const overlayCtx = overlay.getContext('2d');
const statusEl = document.getElementById('status');
const noticeEl = document.getElementById('notice');
const pickerEl = document.getElementById('picker');

const bus = createBus('projector');
const clock = createClock();

let project = null;
let projectorId = new URLSearchParams(location.search).get('p');
let projector = null;
let warp = null;
let worldRenderer = null;
let mediaPool = null;

/** Intermediate canvas holding the world render for this projector's region. */
const worldCanvas = document.createElement('canvas');
const worldCtx = worldCanvas.getContext('2d', { alpha: true, desynchronized: true });

let region = { x: 0, y: 0, w: 1, h: 1 };
let regionKey = '';
let audio = { level: 0, low: 0, mid: 0, high: 0 };

/** Calibration takes over the screen entirely while it runs. */
let calibFrame = null;
let identifyUntil = 0;
let statusVisible = false;
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
 * Project handling
 * ------------------------------------------------------------------ */

async function setProject(next) {
  const previousEffectSignature = signatureOfUserEffects(project);
  project = next;

  if (signatureOfUserEffects(project) !== previousEffectSignature) {
    const errors = await loadUserEffects(project.userEffects || []);
    for (const [id, message] of Object.entries(errors)) {
      reportError(`Custom effect "${id}" failed to compile: ${message}`);
    }
  }

  mediaPool.sync(project.media || []);
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
  const H = projector.calibration?.H || null;
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

function drawTestPattern(g, w, h, pattern) {
  g.fillStyle = '#000';
  g.fillRect(0, 0, w, h);

  if (pattern === 'white' || pattern === 'red' || pattern === 'green' || pattern === 'blue') {
    g.fillStyle = { white: '#fff', red: '#f00', green: '#0f0', blue: '#00f' }[pattern];
    g.fillRect(0, 0, w, h);
    return;
  }

  if (pattern === 'grid') {
    const step = Math.round(Math.min(w, h) / 16);
    g.strokeStyle = '#00ff88';
    g.lineWidth = Math.max(1, step / 40);
    g.beginPath();
    for (let x = 0; x <= w; x += step) {
      g.moveTo(x, 0);
      g.lineTo(x, h);
    }
    for (let y = 0; y <= h; y += step) {
      g.moveTo(0, y);
      g.lineTo(w, y);
    }
    g.stroke();

    g.strokeStyle = '#ff0055';
    g.lineWidth = Math.max(2, step / 12);
    g.strokeRect(g.lineWidth / 2, g.lineWidth / 2, w - g.lineWidth, h - g.lineWidth);
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(w, h);
    g.moveTo(w, 0);
    g.lineTo(0, h);
    g.stroke();

    g.fillStyle = '#fff';
    g.font = `${Math.round(Math.min(w, h) / 22)}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(`${w} × ${h}`, w / 2, h / 2);
    return;
  }

  if (pattern === 'corners') {
    const size = Math.min(w, h) * 0.14;
    g.strokeStyle = '#fff';
    g.lineWidth = Math.max(2, size / 18);
    for (const [cx, cy, dx, dy] of [
      [0, 0, 1, 1],
      [w, 0, -1, 1],
      [w, h, -1, -1],
      [0, h, 1, -1],
    ]) {
      g.beginPath();
      g.moveTo(cx, cy + dy * size);
      g.lineTo(cx, cy);
      g.lineTo(cx + dx * size, cy);
      g.stroke();
    }
    g.beginPath();
    g.arc(w / 2, h / 2, size / 2, 0, Math.PI * 2);
    g.stroke();
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

  if (!project || !projector) return;

  const time = clock.tick();
  mediaPool.syncPlayback(time.t, time.running);

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

  try {
    warp.draw(worldCanvas, {
      feather: projector.blend,
      gamma: projector.blend?.gamma ?? 1.8,
      brightness: projector.brightness ?? 1,
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
  worldRenderer = createWorldRenderer({
    mediaPool,
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
