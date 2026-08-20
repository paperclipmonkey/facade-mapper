/**
 * The drawing page.
 *
 * An iPad in the garden, a pencil, and ink on the house while the pencil is
 * still moving. It is the same shape of thing as the remote — it holds no
 * project, it joins over the link, it sends small messages — except that what
 * it sends is drawing rather than button presses.
 *
 * Three decisions worth knowing about:
 *
 * **It draws in the target shape's box.** A stroke is stored 0..1 across
 * whatever shape the layer points at, so the same drawing lands on the window
 * it was drawn for whatever the camera resolution is, and on all four windows
 * at once if the layer points at four.
 *
 * **What you see under the pencil is painted by the code that paints the
 * house** — `syncInk` from the effect itself, not a second implementation that
 * would slowly stop agreeing with it. The same reason the control tab's preview
 * runs the projector's renderer.
 *
 * **It applies its own strokes locally before sending them.** The wire is a few
 * milliseconds over a garden, but a few milliseconds between the pencil and the
 * ink is the difference between drawing and operating a machine that draws.
 */

import { createBus, MSG } from '../core/bus.js';
import { createLink } from '../core/link.js';
import { migrateProject, worldSize } from '../core/state.js';
import { applyDrawMessage, drawingFor, snapshotOf, DRAW_SCALE, PRESSURE_SCALE } from '../core/drawing.js';
import { now } from '../core/time.js';
import { syncInk, surfaceIdFor } from '../effects/builtin/live.js';
import { boundingBox } from '../core/math.js';

const $ = (id) => document.getElementById(id);

const bus = createBus('draw');
const link = createLink(bus, {
  role: 'draw',
  label: 'Drawing pad',
  /**
   * The project as well as the ink.
   *
   * The pad needs the shapes to know what it is drawing into — the outline to
   * follow, the aspect to match, and the rest of the facade faintly behind it
   * for orientation. Asking for the project is the plain way to get that, and
   * it is dropped rather than queued when the link is behind, so a slider being
   * dragged on the laptop cannot fill a tablet's socket with stale shows.
   */
  subscribe: [MSG.PROJECT, MSG.DRAW, MSG.CLOCK, MSG.SHOW],
});

const canvas = $('pad');
const g = canvas.getContext('2d', { alpha: false });

let project = null;
/** The layer being drawn into, and the shape its ink is mapped onto. */
let layer = null;
let target = null;
/** Where the target's box sits on screen, in CSS pixels. */
let view = { x: 0, y: 0, w: 1, h: 1 };
const ink = {};

const tool = {
  color: '#ff7a18',
  /** Width as a percentage of the shape's short edge, matching the effect. */
  width: 8,
  erase: false,
  /** Once a pencil has been seen, fingers and palms stop drawing. */
  pencilOnly: false,
  sawPen: false,
};

/** The stroke in progress, and the points not yet sent. */
let stroke = null;
let pending = [];
let dirty = true;

const COLOURS = ['#ffffff', '#ff7a18', '#ff2d55', '#ffd60a', '#35d07f', '#4cc2ff', '#b06bff', '#ff8fd0'];

/* ------------------------------------------------------------------ *
 * Which layer, and which shape
 * ------------------------------------------------------------------ */

function drawLayers() {
  return (project?.layers || []).filter((l) => l.effect === 'live-draw');
}

/**
 * Pick a layer to draw into, keeping the one already chosen if it survives.
 *
 * The choice is remembered across reloads because a tablet in a coat pocket
 * locks itself, and coming back to the wrong layer halfway through a drawing
 * would be its own small disaster.
 */
const REMEMBERED = 'facade-mapper/draw-layer';

function remember(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    // Storage denied, which some tablets do in private browsing. The picker
    // still works; it just forgets which layer you were on.
  }
  return null;
}

function chooseLayer() {
  const layers = drawLayers();
  const wanted = layer?.id || remember(REMEMBERED);
  layer = layers.find((l) => l.id === wanted) || layers[0] || null;
  if (layer) {
    remember(REMEMBERED, layer.id);
    requestSnapshot();
  }
  resolveTarget();
  renderPicker();
}

/**
 * The shape the ink is mapped onto.
 *
 * A layer with several targets paints the same drawing into all of them; the
 * first is the one worth showing an outline of. A layer with no targets covers
 * the whole frame, which is a perfectly good thing to draw on.
 */
function resolveTarget() {
  if (!project || !layer) {
    target = null;
    return;
  }
  const byId = new Map(project.shapes.map((s) => [s.id, s]));
  const wanted = [
    ...(layer.targets || []).map((id) => byId.get(id)),
    ...(layer.targetTags?.length
      ? project.shapes.filter((s) =>
          s.tags?.some((t) => layer.targetTags.map((x) => String(x).toLowerCase()).includes(String(t).toLowerCase()))
        )
      : []),
  ].filter((s) => s && s.visible !== false);

  const world = worldSize(project);
  if (!wanted.length) {
    target = {
      name: 'the whole frame',
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
      bbox: { x: 0, y: 0, w: 1, h: 1 },
      aspect: world.aspect,
      count: 1,
    };
    return;
  }

  const shape = wanted[0];
  const bbox = boundingBox(shape.points);
  // World coordinates are normalised to the camera frame, so a shape's box is
  // only the right shape on screen once the frame's own aspect is put back.
  target = {
    name: shape.name,
    points: shape.points,
    bbox,
    aspect: Math.max(0.05, (bbox.w * world.aspect) / Math.max(bbox.h, 1e-6)),
    count: wanted.length,
  };
}

function renderPicker() {
  const picker = $('surfacePicker');
  const layers = drawLayers();
  picker.replaceChildren();
  for (const l of layers) {
    const option = document.createElement('option');
    option.value = l.id;
    option.textContent = l.name || 'Live drawing';
    option.selected = l.id === layer?.id;
    picker.appendChild(option);
  }
  picker.hidden = layers.length < 2;
  $('targetName').textContent = target
    ? target.count > 1
      ? `${target.name} and ${target.count - 1} more`
      : target.name
    : '';
}

/* ------------------------------------------------------------------ *
 * Sending ink
 * ------------------------------------------------------------------ */

function surfaceId() {
  return layer ? surfaceIdFor(layer, layer.params) : null;
}

/**
 * Apply a message here and send it on.
 *
 * Locally first: `bus.post` deliberately does not deliver to the tab that sent
 * it, and waiting for the wire to tell us what we just drew would put the
 * round trip between the pencil and the ink.
 */
function send(message) {
  const id = surfaceId();
  if (!id) return;
  const full = { ...message, surface: id };
  applyDrawMessage(full);
  bus.post(MSG.DRAW, full);
  dirty = true;
}

function requestSnapshot() {
  const id = surfaceId();
  if (id) bus.post(MSG.DRAW, { kind: 'request', surface: id });
}

/** Screen pixels to 0..1 in the target's box, quantised for the wire. */
function toSurface(clientX, clientY) {
  return [
    Math.round(((clientX - view.x) / view.w) * DRAW_SCALE),
    Math.round(((clientY - view.y) / view.h) * DRAW_SCALE),
  ];
}

function pressureOf(event) {
  // A finger reports 0 or a flat 0.5 depending on the browser; a pencil reports
  // what it is actually being leant on with. Treat the flat cases as a firm
  // press so a finger draws a solid line rather than a faint one.
  if (event.pointerType === 'pen' && event.pressure > 0) return event.pressure;
  return 0.62;
}

function accepts(event) {
  if (event.pointerType === 'pen') return true;
  if (event.pointerType === 'mouse') return true;
  return !(tool.pencilOnly || tool.sawPen);
}

function beginStroke(event) {
  const id = `st_${Math.random().toString(36).slice(2, 9)}${now().toString(36).slice(-4)}`;
  stroke = { id, pointerId: event.pointerId };
  pending = [];
  send({
    kind: 'begin',
    id,
    color: tool.color,
    width: tool.width,
    erase: tool.erase,
    at: now(),
  });
  addPoint(event);
  document.body.classList.add('drawing');
}

function addPoint(event) {
  if (!stroke) return;
  const [x, y] = toSurface(event.clientX, event.clientY);
  pending.push(x, y, Math.round(Math.min(1, Math.max(0, pressureOf(event))) * PRESSURE_SCALE));
}

/**
 * Push whatever the pencil has produced since the last frame.
 *
 * Once per frame rather than per event: an Apple Pencil reports at up to 240 Hz
 * and each of those as its own message would be four times the packets for no
 * more drawing. The points themselves are all kept — `getCoalescedEvents` is
 * what makes a fast stroke a curve rather than a polygon.
 */
function flush() {
  if (!stroke || !pending.length) return;
  send({ kind: 'points', id: stroke.id, pts: pending });
  pending = [];
}

function endStroke() {
  if (!stroke) return;
  flush();
  send({ kind: 'end', id: stroke.id });
  stroke = null;
  document.body.classList.remove('drawing');
}

/* ------------------------------------------------------------------ *
 * Drawing it
 * ------------------------------------------------------------------ */

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(window.innerWidth * dpr);
  const h = Math.round(window.innerHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    dirty = true;
  }
  layoutView();
}

/** Fit the target's box into the screen, leaving room for the bars. */
function layoutView() {
  const margin = 16;
  const top = 56;
  const bottom = 84;
  const availableW = Math.max(40, window.innerWidth - margin * 2);
  const availableH = Math.max(40, window.innerHeight - top - bottom);
  const aspect = target?.aspect || 16 / 9;

  let w = availableW;
  let h = w / aspect;
  if (h > availableH) {
    h = availableH;
    w = h * aspect;
  }
  view = { x: (window.innerWidth - w) / 2, y: top + (availableH - h) / 2, w, h };
  dirty = true;
}

function frame() {
  requestAnimationFrame(frame);
  flush();
  // Where the drawable box ended up, for anybody debugging a tablet they
  // cannot attach an inspector to.
  window.__drawView = view;

  const surface = layer ? drawingFor(surfaceId()) : null;
  if (surface && (surface.revision !== ink.revision || surface.generation !== ink.generation)) dirty = true;
  if (!dirty) return;
  dirty = false;

  const dpr = canvas.width / Math.max(1, window.innerWidth);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#07080b';
  g.fillRect(0, 0, window.innerWidth, window.innerHeight);

  if (!target) return;
  drawGuides();

  if (surface?.strokes.length) {
    const buffer = syncInk(ink, surface, { w: Math.round(view.w), h: Math.round(view.h) }, {
      width: layer?.params?.width ?? 2.2,
      glow: layer?.params?.glow ?? 0.7,
      blend: 'lighter',
      fade: layer?.params?.fade ?? 0,
    });
    if (buffer) g.drawImage(buffer, view.x, view.y, view.w, view.h);
  }
}

/**
 * The house, faintly, and the shape being drawn on.
 *
 * Without this a drawing surface is a black rectangle, and everything drawn on
 * it lands somewhere the person drawing did not expect. The other shapes are
 * positioned relative to the target's box, so a window drawn on has the door
 * and the roofline in the right places around it even though they are off the
 * edge of what can be drawn.
 */
function drawGuides() {
  const { bbox } = target;
  const toView = (pt) => ({
    x: view.x + ((pt.x - bbox.x) / Math.max(bbox.w, 1e-6)) * view.w,
    y: view.y + ((pt.y - bbox.y) / Math.max(bbox.h, 1e-6)) * view.h,
  });

  g.save();
  g.lineJoin = 'round';

  if (project?.shapes?.length && target.name !== 'the whole frame') {
    g.strokeStyle = 'rgba(150,165,195,0.16)';
    g.lineWidth = 1;
    for (const shape of project.shapes) {
      if (!shape.points?.length || shape.visible === false) continue;
      g.beginPath();
      const pts = shape.points.map(toView);
      g.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
      if (shape.closed !== false) g.closePath();
      g.stroke();
    }
  }

  // The drawable area, and its edge.
  g.fillStyle = 'rgba(255,255,255,0.028)';
  g.fillRect(view.x, view.y, view.w, view.h);
  g.strokeStyle = 'rgba(255,122,24,0.5)';
  g.lineWidth = 1.5;
  g.setLineDash([6, 6]);
  g.strokeRect(view.x, view.y, view.w, view.h);
  g.setLineDash([]);

  if (target.points?.length && target.name !== 'the whole frame') {
    g.strokeStyle = 'rgba(255,255,255,0.45)';
    g.lineWidth = 2;
    g.beginPath();
    const pts = target.points.map(toView);
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
    g.closePath();
    g.stroke();
  }

  g.restore();
}

/* ------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------ */

canvas.addEventListener('pointerdown', (event) => {
  if (!layer || !target) return;
  if (event.pointerType === 'pen') tool.sawPen = true;
  if (!accepts(event)) return;
  event.preventDefault();
  try {
    // Keeps a stroke that wanders over the toolbar coming here rather than
    // ending at the edge. Throws if the pointer has already gone, which is not
    // a reason to lose the stroke.
    canvas.setPointerCapture(event.pointerId);
  } catch {
    /* carry on */
  }
  beginStroke(event);
});

canvas.addEventListener('pointermove', (event) => {
  if (!stroke || event.pointerId !== stroke.pointerId) return;
  event.preventDefault();
  /**
   * Every sample the device took since the last event, not just the latest.
   *
   * This is what makes a fast stroke a curve rather than a polygon: a pencil
   * reports at up to 240 Hz and the browser delivers one event per frame with
   * the rest folded into it. An *empty* list is not "no samples", though — it
   * is a browser that has nothing coalesced to give, and taking it at its word
   * throws away the event itself, which is every point of a synthetic or
   * simulated stroke and, on some browsers, of a slow real one.
   */
  const coalesced = event.getCoalescedEvents?.();
  const samples = coalesced?.length ? coalesced : [event];
  for (const sample of samples) addPoint(sample);
});

for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
  canvas.addEventListener(type, (event) => {
    if (!stroke || event.pointerId !== stroke.pointerId) return;
    if (type === 'pointerup') addPoint(event);
    endStroke();
  });
}

// A pencil that leaves the glass mid-stroke, or a tablet that loses the app.
window.addEventListener('blur', endStroke);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') endStroke();
  else announce();
});

/* ------------------------------------------------------------------ *
 * Tools
 * ------------------------------------------------------------------ */

function buildSwatches() {
  const host = $('swatches');
  host.replaceChildren();
  for (const colour of COLOURS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'swatch';
    button.style.background = colour;
    button.setAttribute('aria-pressed', String(colour === tool.color));
    button.setAttribute('aria-label', `Colour ${colour}`);
    button.addEventListener('click', () => {
      tool.color = colour;
      tool.erase = false;
      $('btnErase').setAttribute('aria-pressed', 'false');
      for (const node of host.children) node.setAttribute('aria-pressed', String(node === button));
      updateNib();
    });
    host.appendChild(button);
  }
}

function updateNib() {
  const nib = $('nib');
  nib.style.setProperty('--nib', `${Math.max(4, Math.min(26, tool.width * 0.9))}px`);
  nib.style.setProperty('--nib-color', tool.erase ? '#666' : tool.color);
}

$('width').addEventListener('input', (event) => {
  tool.width = Number(event.target.value);
  updateNib();
});

$('btnErase').addEventListener('click', () => {
  tool.erase = !tool.erase;
  $('btnErase').setAttribute('aria-pressed', String(tool.erase));
  updateNib();
});

$('btnUndo').addEventListener('click', () => send({ kind: 'undo' }));

$('btnClear').addEventListener('click', () => {
  const surface = drawingFor(surfaceId());
  if (!surface?.strokes.length) return;
  if (!confirm('Clear everything on this layer?')) return;
  send({ kind: 'clear' });
});

$('btnPencilOnly').addEventListener('click', () => {
  tool.pencilOnly = !tool.pencilOnly;
  $('btnPencilOnly').setAttribute('aria-pressed', String(tool.pencilOnly));
});

$('surfacePicker').addEventListener('change', (event) => {
  layer = drawLayers().find((l) => l.id === event.target.value) || layer;
  ink.key = '';
  chooseLayer();
});

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

bus.on(MSG.PROJECT, (payload) => {
  project = migrateProject(payload);
  const had = layer?.id;
  chooseLayer();
  if (layer?.id !== had) ink.key = '';
  layoutView();
  updateNotice();
});

/**
 * Answering, as a fallback.
 *
 * The control tab is what normally tells a newly-opened projector what is
 * already drawn, because it holds a copy of everything. But it is also the tab
 * most likely to have been reloaded during the evening, and after that its copy
 * is empty — while this tablet, the thing that drew the picture, still has it.
 *
 * So: wait a beat, and answer only if nobody else did. One extra message on the
 * rare occasion it is needed, none at all the rest of the time.
 */
const answering = new Map();

bus.on(MSG.DRAW, (payload) => {
  if (!payload) return;

  if (payload.kind === 'request') {
    if (payload.surface !== surfaceId() || answering.has(payload.surface)) return;
    if (!drawingFor(payload.surface)?.strokes.length) return;
    answering.set(
      payload.surface,
      setTimeout(() => {
        answering.delete(payload.surface);
        bus.post(MSG.DRAW, snapshotOf(payload.surface));
      }, 500)
    );
    return;
  }

  if (payload.kind === 'full' && answering.has(payload.surface)) {
    clearTimeout(answering.get(payload.surface));
    answering.delete(payload.surface);
  }

  if (applyDrawMessage(payload)) dirty = true;
});

function updateNotice() {
  const notice = $('notice');
  const status = link.status;
  $('linkDot').dataset.link = status;

  let message = '';
  if (!project) {
    if (status === 'unavailable' || status === 'off') {
      message =
        'No show here. Run "node server.mjs" on the machine driving the projectors and open the ' +
        'address it prints.';
    } else if (status === 'checking') message = 'Looking for the show…';
    else if (status !== 'linked') message = 'Reconnecting to the show…';
    else message = 'Linked. Waiting for the control tab…';
  } else if (!layer) {
    message =
      'No drawing layer yet. On the control tab, add the “Live drawing” effect and point it at ' +
      'the wall or window you want to draw on.';
  }

  notice.hidden = !message;
  $('noticeText').textContent = message;
  // Asking the control tab for somewhere to draw beats walking back indoors to
  // press a button before you can start.
  $('btnAddLayer').hidden = !(project && !layer);
  $('head').hidden = !!message;
  $('bar').hidden = !!message;
}

$('btnAddLayer').addEventListener('click', () => {
  bus.post(MSG.ACTION, { action: 'add-draw-layer' });
  $('noticeText').textContent = 'Asking the control tab for a drawing layer…';
  $('btnAddLayer').hidden = true;
});

let introduced = false;
function announce() {
  bus.post(MSG.HELLO, { role: 'draw', requestState: !introduced });
  introduced = true;
  requestSnapshot();
}

/**
 * Keep the screen on.
 *
 * A tablet that locks itself between strokes is not a drawing surface.
 */
async function keepAwake() {
  if (document.visibilityState !== 'visible') return;
  try {
    // Held deliberately: some implementations drop the lock when the sentinel
    // is collected.
    window.__wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    /* Denied, unsupported, or the battery is low. Not worth saying. */
  }
}

window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 200));

buildSwatches();
updateNib();
resize();
updateNotice();
announce();
setInterval(announce, 4000);
keepAwake();
requestAnimationFrame(frame);
