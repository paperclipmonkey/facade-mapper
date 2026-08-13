/**
 * Name-and-tag a shape at the moment you draw it.
 *
 * Tagging is the feature that makes this app worth using — one layer pointed at
 * `window` lights every window, and stays correct when you trace another one.
 * It was also the feature nobody used, because tagging happened in a different
 * panel, after the fact, on a shape called "Area 3". A house traced in the dark
 * ends up as Area 2, Area 3, Area 4, and from that point on every effect has to
 * be aimed by hand at names that mean nothing.
 *
 * The fix is timing rather than a new feature: ask while you still know what you
 * just drew. One click on `window` both tags it *and* names it "Window 2", so
 * the fast path costs one click and produces a properly tagged, properly named
 * shape. Enter or a click elsewhere accepts, Escape leaves the default.
 *
 * It is deliberately skippable and deliberately not a modal — you are often
 * mid-flow tracing five windows in a row, and anything that blocks would be
 * worse than the problem it solves.
 */

import { el, clear } from './ui.js';
import { SHAPE_TAGS } from '../core/state.js';

/** Sentence-case a tag for use as a name: "window" -> "Window". */
const titleCase = (tag) => tag.charAt(0).toUpperCase() + tag.slice(1);

/**
 * "Window 3" — numbered within its own tag rather than globally, so the windows
 * are Window 1..4 instead of Area 2, 5, 6 and 9.
 */
function nameForTag(app, shapeId, tag) {
  const others = app.project.shapes.filter(
    (s) => s.id !== shapeId && (s.tags || []).includes(tag)
  ).length;
  return others ? `${titleCase(tag)} ${others + 1}` : titleCase(tag);
}

export function createShapeNamer({ host, app }) {
  let shapeId = null;

  const panel = el('div', { class: 'shape-namer', hidden: true });
  host.appendChild(panel);

  const hide = () => {
    shapeId = null;
    panel.hidden = true;
  };

  function shape() {
    return app.project.shapes.find((s) => s.id === shapeId) || null;
  }

  function build() {
    clear(panel);
    const target = shape();
    if (!target) return;

    const input = el('input', {
      type: 'text',
      class: 'input',
      value: target.name,
      'aria-label': 'Shape name',
    });

    const commitName = () => {
      const value = input.value.trim();
      if (value && value !== target.name) {
        target.name = value;
        app.commit();
      }
    };

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        commitName();
        hide();
        app.refreshPanels();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        hide();
      }
      // Everything else is typing, and must not reach the stage's tool
      // shortcuts — pressing "r" in a name box should not switch to Rect.
      ev.stopPropagation();
    });
    input.addEventListener('blur', commitName);

    const tags = el('div', { class: 'tag-picker' });
    // Paths are rooflines and gutters; areas are windows and doors. Offering the
    // likely half first is the difference between one click and a hunt.
    const ordered = target.closed === false
      ? ['roof', 'path', 'wall', ...SHAPE_TAGS]
      : ['window', 'door', ...SHAPE_TAGS];
    for (const tag of [...new Set(ordered)]) {
      const on = (target.tags || []).includes(tag);
      const button = el('button', {
        type: 'button',
        class: `tag-toggle${on ? ' on' : ''}`,
        text: tag,
      });
      button.addEventListener('click', () => {
        const current = shape();
        if (!current) return;
        app.pushUndo();
        current.tags = current.tags || [];
        const index = current.tags.indexOf(tag);
        if (index >= 0) {
          current.tags.splice(index, 1);
        } else {
          current.tags.push(tag);
          // Only rename while the name is still the auto-generated one. Someone
          // who typed "Front bay" and then tags it does not want it renamed.
          if (/^(Area|Path) \d+$/.test(current.name)) {
            current.name = nameForTag(app, current.id, tag);
            input.value = current.name;
          }
        }
        app.commit();
        build();
      });
      tags.appendChild(button);
    }

    const done = el('button', { type: 'button', class: 'btn small primary', text: 'Done' });
    done.addEventListener('click', () => {
      commitName();
      hide();
      app.refreshPanels();
    });

    panel.append(
      el('div', { class: 'shape-namer-row' }, [
        el('span', { class: 'shape-namer-label', text: 'Name it' }),
        input,
        done,
      ]),
      tags,
      el('p', {
        class: 'panel-note',
        text: 'A tag names it too. Effects can then target every shape carrying that tag, '
          + 'so "all the windows" keeps working as you trace more of them.',
      })
    );

    input.focus();
    input.select();
  }

  return {
    /** Show the prompt for a freshly drawn shape. */
    open(id) {
      shapeId = id;
      panel.hidden = false;
      build();
    },
    close: hide,
    get isOpen() {
      return !panel.hidden;
    },
  };
}
