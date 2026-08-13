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

export function openEffectPicker({ current, closed = true, onPick }) {
  const dialog = document.getElementById('effectDialog');
  const body = document.getElementById('effectDialogBody');
  clear(body);

  const renderer = createWorldRenderer({});
  const project = previewProject(closed);
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
        const canvas = el('canvas', { width: CARD_W, height: CARD_H, class: 'effect-thumb' });
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
        const layer = createLayer(def.id, {
          targets: ['preview-shape'],
          params: defaultParams(def.id),
          order: 0,
        });
        layer.id = `preview-${def.id}`;

        const entry = { def, ctx: canvas.getContext('2d'), layer };
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
    const t = (performance.now() - start) / 1000;
    for (const entry of visible) {
      project.layers = [entry.layer];
      entry.ctx.clearRect(0, 0, CARD_W, CARD_H);
      try {
        renderer.render(entry.ctx, {
          project,
          time: { t, dt: 1 / 30, beat: t * 2, beatPhase: (t * 2) % 1, bpm: 120 },
          audio: { level: 0.4, low: 0.5, mid: 0.35, high: 0.25 },
          region: { x: 0, y: 0, w: 1, h: 1 },
          pixelSize: { w: CARD_W, h: CARD_H },
          preview: true,
        });
      } catch {
        // A preview that throws is not worth taking the dialog down for; the
        // card just stays dark and the inspector reports it if it is chosen.
      }
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
