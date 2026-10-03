/**
 * The effect browser.
 *
 * Choosing from forty-nine names in a dropdown is choosing blind. "Glyph Rain"
 * and "Scan Sweep" mean nothing until you have seen them, so picking an effect
 * used to be: guess, apply, look, undo, guess again — with the added problem
 * that applying one overwrites the parameters of whatever was there.
 *
 * So: a gallery where every card renders the effect *live*, through the real
 * renderer, on the shape the layer actually targets. What you see in the card is
 * what will land on the wall, because it is produced by the same code.
 *
 * Rendering forty-nine live canvases would be silly, so cards only animate while
 * they are on screen (an IntersectionObserver drives that) and they share a
 * single renderer and a single rAF loop. Off-screen cards cost nothing.
 */

import { el, clear } from './ui.js';
import { listByCategory, defaultParams, getEffect } from '../effects/registry.js';
import { createWorldRenderer } from '../render/worldRenderer.js';
import { createProject, createShape, createLayer } from '../core/state.js';

const CARD_W = 168;
const CARD_H = 94;
/**
 * Pixels per card unit. The grid stretches a card to anything up to about
 * twice its nominal width, and a 168-pixel canvas stretched to 300 on a
 * high-density screen is a smear — every fine effect in the library looked
 * worse in its own preview than on the wall.
 */
const SCALE = 2;
const PX_W = CARD_W * SCALE;
const PX_H = CARD_H * SCALE;

/**
 * What a card needs in order to show its effect at all.
 *
 * A gallery that renders every effect live is only as good as what is on a
 * card at the moment you look at it, and three kinds were blank boxes.
 * One-shots play once when their layer comes on — which is when the dialog
 * opened — and then sit empty for ever: they loop here. Timers that come round
 * once a minute (Santa, cracking glass, a storm) would almost never be caught:
 * they come round every few seconds. And Mask paints black, which on black is
 * nothing at all: it gets a lit wall to cut its hole in.
 *
 * Preview-only. Nothing here touches the parameters a layer is created with.
 */
const PREVIEW = {
  'bat-burst': { loop: 3.6 },
  shockwave: { loop: 2.6 },
  'spark-burst': { loop: 3.2 },
  rocket: { loop: 5.5 },
  'confetti-cannon': { loop: 5.5 },
  santa: { params: { interval: 7, crossing: 6 } },
  shatter: { params: { interval: 5 } },
  lightning: { params: { rate: 24 } },
  mask: { under: { effect: 'wash', params: { color: '#ff9a3c', color2: '#7a2a8a', level: 0.75 } } },
};

/**
 * A miniature project holding one shape, reused for every card.
 *
 * The shape mirrors what the layer targets — a window-shaped rectangle for a
 * closed shape, a line for a path — so a preview of a path effect looks like a
 * path effect rather than an empty box.
 */
function previewProject(closed) {
  const project = createProject('preview');
  project.worldAspect = CARD_W / CARD_H;
  const shape = closed
    ? createShape([
      { x: 0.22, y: 0.18 }, { x: 0.78, y: 0.18 },
      { x: 0.78, y: 0.82 }, { x: 0.22, y: 0.82 },
    ])
    : createShape([{ x: 0.1, y: 0.72 }, { x: 0.5, y: 0.24 }, { x: 0.9, y: 0.72 }]);
  shape.closed = closed;
  shape.id = 'preview-shape';
  project.shapes = [shape];
  return project;
}

/**
 * The house behind a card: a dim wall with the target shape as a window in
 * it, or for a path, a gable end against the sky with the path as its
 * bargeboard.
 *
 * The cards used to render on bare black, which is how a projector sees the
 * world and not how anybody choosing an effect does. Light on black has no
 * scale and no surface; the same light on a window in a wall is immediately
 * "that is what my window will look like". It is painted dark, as the demo
 * house is, so the effect is what you see.
 */
function cardBackdrop(closed) {
  const canvas = document.createElement('canvas');
  canvas.width = PX_W;
  canvas.height = PX_H;
  const g = canvas.getContext('2d');
  const W = PX_W;
  const H = PX_H;
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#05070d');
  sky.addColorStop(1, '#0d1220');
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);

  const wall = g.createLinearGradient(0, 0, 0, H);
  wall.addColorStop(0, '#1a1e26');
  wall.addColorStop(1, '#14171d');
  if (closed) {
    g.fillStyle = wall;
    g.fillRect(0, 0, W, H);
    const x = 0.22 * W;
    const y = 0.18 * H;
    const w = 0.56 * W;
    const h = 0.64 * H;
    const f = 3 * SCALE;
    g.fillStyle = '#0b0d11';
    g.fillRect(x - f - 2, y - f - 2, w + f * 2 + 4, h + f * 2 + 4);
    const glass = g.createLinearGradient(0, y, 0, y + h);
    glass.addColorStop(0, '#121824');
    glass.addColorStop(1, '#07090d');
    g.fillStyle = glass;
    g.fillRect(x, y, w, h);
    g.strokeStyle = '#3a3f48';
    g.lineWidth = f;
    g.strokeRect(x - f / 2, y - f / 2, w + f, h + f);
    g.fillStyle = '#2c3037';
    g.fillRect(x - f * 2, y + h + f, w + f * 4, f * 1.2);
  } else {
    // The path is a gable: wall under it, sky over it.
    g.fillStyle = wall;
    g.beginPath();
    g.moveTo(0.1 * W, 0.72 * H);
    g.lineTo(0.5 * W, 0.24 * H);
    g.lineTo(0.9 * W, 0.72 * H);
    g.lineTo(0.9 * W, H);
    g.lineTo(0.1 * W, H);
    g.closePath();
    g.fill();
    g.strokeStyle = '#2e333c';
    g.lineWidth = 3 * SCALE;
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(0.08 * W, 0.735 * H);
    g.lineTo(0.5 * W, 0.225 * H);
    g.lineTo(0.92 * W, 0.735 * H);
    g.stroke();
  }
  return canvas;
}

export function openEffectPicker({ current, closed = true, onPick }) {
  const dialog = document.getElementById('effectDialog');
  const body = document.getElementById('effectDialogBody');
  clear(body);

  const renderer = createWorldRenderer({});
  const project = previewProject(closed);
  // Painted on the first frame that needs it, not on open: the dialog's
  // search and cards have to exist before anything is drawn on them.
  let backdrop = null;
  // Each card's light is drawn here first and then added onto the house, the
  // way the stage adds the preview onto the camera picture.
  const light = document.createElement('canvas');
  light.width = PX_W;
  light.height = PX_H;
  const lightCtx = light.getContext('2d');
  const cards = [];
  const visible = new Set();
  let raf = 0;
  let filter = '';

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target.__card);
      else visible.delete(entry.target.__card);
    }
  }, { root: body, rootMargin: '120px' });

  const search = el('input', {
    type: 'search',
    class: 'input',
    placeholder: 'Search effects — try "fire", "snow", "text"',
    value: '',
  });
  const grid = el('div', { class: 'effect-grid' });

  function buildCards() {
    /**
     * Let go of the cards that are about to be thrown away.
     *
     * An IntersectionObserver holds its targets, so removing a card from the
     * DOM does not end the observation — and this runs on every keystroke in
     * the search box. Typing "fire" left four sets of eighty-odd detached
     * cards, each with its own canvas, observed and unreachable for as long as
     * the dialog stayed open. `disconnect` is the pair to the `observe` below;
     * the observer is reusable afterwards.
     */
    observer.disconnect();
    clear(grid);
    cards.length = 0;
    visible.clear();
    const query = filter.trim().toLowerCase();

    for (const [category, effects] of listByCategory()) {
      const matches = effects.filter((def) => !query
        || def.name.toLowerCase().includes(query)
        || def.id.includes(query)
        || (def.description || '').toLowerCase().includes(query)
        || category.toLowerCase().includes(query));
      if (!matches.length) continue;

      grid.appendChild(el('h4', { class: 'effect-group', text: category }));
      const row = el('div', { class: 'effect-row' });

      for (const def of matches) {
        const canvas = el('canvas', { width: PX_W, height: PX_H, class: 'effect-thumb' });
        const card = el('div', {
          class: `effect-card${def.id === current ? ' current' : ''}`,
          title: def.description || def.name,
        }, [
          canvas,
          el('span', { class: 'effect-name', text: def.name }),
        ]);

        // Each card gets its own layer so effect state does not bleed between
        // previews — a stateful effect would otherwise inherit the last one's
        // particles.
        const hint = PREVIEW[def.id] || {};
        const layer = createLayer(def.id, {
          targets: ['preview-shape'],
          params: { ...defaultParams(def.id), ...(hint.params || {}) },
          order: 1,
        });
        layer.id = `preview-${def.id}`;
        const layers = [layer];
        if (hint.under) {
          const under = createLayer(hint.under.effect, {
            params: { ...defaultParams(hint.under.effect), ...hint.under.params },
            order: 0,
          });
          under.id = `preview-${def.id}-under`;
          layers.unshift(under);
        }

        const entry = { def, ctx: canvas.getContext('2d'), layer, layers, loop: hint.loop || 0, t0: null };
        card.__card = entry;
        cards.push(entry);
        observer.observe(card);

        card.addEventListener('click', () => {
          close();
          onPick(def.id);
        });
        row.appendChild(card);
      }
      grid.appendChild(row);
    }

    if (!cards.length) {
      grid.appendChild(el('p', { class: 'panel-note', text: 'Nothing matches that.' }));
    }
  }

  const start = performance.now();
  function frame() {
    const now = (performance.now() - start) / 1000;
    if (visible.size) backdrop ??= cardBackdrop(closed);
    for (const entry of visible) {
      // A card's clock starts when it first scrolls into view, so a one-shot
      // further down the list has not already gone off by the time you get
      // there; a looping one goes round again from a clean slate.
      if (entry.t0 === null) entry.t0 = now;
      if (entry.loop && now - entry.t0 > entry.loop) {
        for (const l of entry.layers) renderer.resetLayer(l.id);
        entry.t0 = now;
      }
      const t = now - entry.t0;
      project.layers = entry.layers;
      lightCtx.clearRect(0, 0, PX_W, PX_H);
      try {
        renderer.render(lightCtx, {
          project,
          time: { t, dt: 1 / 30, beat: t * 2, beatPhase: (t * 2) % 1, bpm: 120 },
          audio: { level: 0.4, low: 0.5, mid: 0.35, high: 0.25 },
          region: { x: 0, y: 0, w: 1, h: 1 },
          pixelSize: { w: PX_W, h: PX_H },
          preview: true,
        });
      } catch {
        // A preview that throws is not worth taking the dialog down for; the
        // card just stays dark and the inspector reports it if it is chosen.
      }
      const g = entry.ctx;
      g.globalCompositeOperation = 'source-over';
      g.drawImage(backdrop, 0, 0);
      g.globalCompositeOperation = 'lighter';
      g.drawImage(light, 0, 0);
      g.globalCompositeOperation = 'source-over';
    }
    raf = requestAnimationFrame(frame);
  }

  function close() {
    cancelAnimationFrame(raf);
    observer.disconnect();
    dialog.close();
  }

  search.addEventListener('input', () => {
    filter = search.value;
    buildCards();
  });

  body.appendChild(el('div', { class: 'effect-search' }, [search]));
  body.appendChild(grid);
  buildCards();

  dialog.addEventListener('close', () => {
    cancelAnimationFrame(raf);
    observer.disconnect();
  }, { once: true });

  dialog.showModal();
  raf = requestAnimationFrame(frame);
  search.focus();
}

/** Name of an effect, for buttons that stand in for the old dropdown. */
export function effectLabel(id) {
  return getEffect(id)?.name || id;
}
