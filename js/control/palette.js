/**
 * Command palette — one box that reaches everything.
 *
 * The app has ten panels, fifty-odd effects and however many shapes you have
 * traced, and the honest problem with that is not that any one of them is hard
 * to find, it is that finding *anything* costs a tab click and a scan. On a
 * laptop balanced on a wall outside in the dark, that is the whole interaction.
 *
 * So: <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>K</kbd>, type three letters, press
 * Enter. "cand" adds Candle Flicker. "door" selects the door. "black" blacks
 * the show out. Nothing here is new capability — every command is something a
 * button already does — it is the same app with the search that a list of fifty
 * things has always needed.
 *
 * `fuzzyScore` and `buildCommands` are deliberately free of any DOM so they can
 * be tested directly; `createPalette` is the thin layer that draws them.
 */

import { el, clear } from './ui.js';
import { listEffects, getEffect } from '../effects/registry.js';

/**
 * The left-hand panels, by the `data-panel` key in the markup.
 *
 * Duplicated from index.html so this module stays testable without a DOM;
 * `test/palette.test.mjs` reads the markup and fails if the two drift.
 */
export const PANELS = [
  ['start', 'Start here'],
  ['projectors', 'Projectors'],
  ['shapes', 'Shapes'],
  ['layers', 'Effects'],
  ['scenes', 'Scenes'],
  ['triggers', 'Triggers'],
  ['look', 'Look'],
  ['media', 'Media'],
  ['code', 'Code'],
  ['settings', 'Setup'],
];

/* ------------------------------------------------------------------ *
 * Matching
 * ------------------------------------------------------------------ */

/**
 * Subsequence match with the usual bonuses: -1 for no match, higher is better.
 *
 * Plain `includes` is not enough here because the useful queries are initials
 * and fragments — "bb" should find Bouncing Balls, "canfl" Candle Flicker. The
 * bonuses are what stop that from being useless: a letter at the start of the
 * string or of a word counts for several times one buried mid-token, and a run
 * of consecutive letters compounds, so an exact substring always beats a
 * scattered subsequence of the same letters.
 */
export function fuzzyScore(query, text) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return 0;
  const t = String(text || '').toLowerCase();
  if (!t) return -1;

  let qi = 0;
  let score = 0;
  let run = 0;
  let last = -2;

  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] !== q[qi]) continue;
    let bonus = 1;
    if (i === 0) bonus += 8;
    else if (!/[a-z0-9]/.test(t[i - 1])) bonus += 5;
    if (last === i - 1) {
      // Compounding, and steeply. A long label made of many words gives one
      // word-boundary bonus per letter, so unless a contiguous run outgrows
      // that, "snow" ranks "Set the number of windows" above "Snow".
      run += 1;
      bonus += 3 + run * 2;
    } else {
      run = 0;
    }
    score += bonus;
    last = i;
    qi += 1;
  }

  if (qi < q.length) return -1;
  // Between two matches of equal quality, prefer the shorter label: "Snow"
  // should outrank "Snow settling on the sills" for the query "snow".
  return score - Math.min(t.length - q.length, 40) * 0.1;
}

/** Best `limit` commands for a query, already sorted. Empty query → the defaults. */
export function rankCommands(commands, query, limit = 12) {
  const q = String(query || '').trim();
  if (!q) return commands.filter((c) => c.common).slice(0, limit);

  const scored = [];
  for (const command of commands) {
    // The group name is searchable too, so "go effects" and "add snow" both
    // work without anyone having to learn the vocabulary.
    const best = Math.max(
      fuzzyScore(q, command.label),
      fuzzyScore(q, `${command.group} ${command.label}`) - 4,
      command.keywords ? fuzzyScore(q, command.keywords) - 6 : -1
    );
    if (best > 0) scored.push({ command, score: best });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.command);
}

/* ------------------------------------------------------------------ *
 * What there is to do
 * ------------------------------------------------------------------ */

/**
 * Every command, rebuilt each time the palette opens.
 *
 * `actions` carries the handful of things that live as private functions in
 * app.js rather than on `app` — blackout, transport, the file dialogs. Passing
 * them in keeps this module from reaching into another module's internals, and
 * keeps it constructible from a test with a stub.
 */
export function buildCommands(app, actions = {}) {
  const commands = [];
  const add = (command) => commands.push(command);
  const shapes = app.project?.shapes || [];
  const scenes = app.project?.scenes || [];
  const selectedShape = app.selection?.type === 'shape'
    ? shapes.find((s) => s.id === app.selection.id)
    : null;

  /* --- things you do most nights --- */
  const doAction = (label, run, { common = false, keywords = '', detail = '' } = {}) => {
    if (typeof run !== 'function') return;
    add({ id: `do:${label}`, group: 'Do', label, detail, keywords, common, run });
  };

  doAction('Open a projector tab', actions.openProjector, { common: true, keywords: 'display screen window second monitor' });
  doAction('Blackout', actions.blackout, { common: true, keywords: 'dark off panic kill' });
  doAction('Play or pause', actions.togglePlay, { common: true, keywords: 'transport space start stop' });
  doAction('Run the unattended show', actions.runShow, { keywords: 'playlist loop evening' });
  doAction('Add a projector', () => app.addProjector?.(), { keywords: 'second another' });
  doAction('Align the selected projector with the camera', actions.calibrate, { keywords: 'calibrate homography corners map' });
  doAction('Start the camera', actions.startCamera, { keywords: 'webcam video see house' });
  doAction('Trace on a photo of the house', actions.usePhoto, { keywords: 'backdrop image picture plan indoors' });
  doAction('Load the demo house', actions.loadDemo, { common: true, keywords: 'example try practise learn' });
  doAction('Remove every effect', () => app.clearLayers?.(), { keywords: 'clear all delete wipe start over' });
  doAction('Save the current look as a scene', actions.captureScene, { keywords: 'snapshot store cue' });
  doAction('Export this show to a file', actions.exportShow, { keywords: 'backup save json download' });
  doAction('Import a show from a file', actions.importShow, { keywords: 'restore load json' });
  doAction('Help', actions.help, { keywords: 'docs manual keys shortcuts' });

  /* --- panels --- */
  for (const [key, label] of PANELS) {
    add({
      id: `panel:${key}`,
      group: 'Go to',
      label,
      common: key === 'layers' || key === 'shapes',
      run: () => app.switchPanel?.(key),
    });
  }

  /* --- effects --- *
   * Adding one is the single most common thing anybody does in here, and the
   * gallery is a good way to choose when you do not know what you want and a
   * slow one when you do. If a shape is selected the new layer lands on it,
   * which matches what the Add effect button already does. */
  for (const effect of listEffects()) {
    add({
      id: `effect:${effect.id}`,
      group: 'Add effect',
      label: effect.name,
      detail: selectedShape ? `on ${selectedShape.name}` : effect.category,
      keywords: `${effect.category} ${effect.description || ''}`,
      run: () => app.addLayer?.(effect.id, selectedShape?.id || null),
    });
  }

  /* --- shapes --- */
  for (const shape of shapes) {
    add({
      id: `shape:${shape.id}`,
      group: 'Select',
      label: shape.name,
      detail: (shape.tags || []).map((t) => `#${t}`).join(' '),
      keywords: (shape.tags || []).join(' '),
      run: () => {
        app.select?.({ type: 'shape', id: shape.id });
        app.switchPanel?.('shapes');
      },
    });
  }

  /* --- layers, so you can jump to one by name in a list of thirty --- */
  for (const layer of app.project?.layers || []) {
    const effectName = getEffect(layer.effect)?.name || layer.effect;
    add({
      id: `layer:${layer.id}`,
      group: 'Edit effect',
      label: layer.name || effectName,
      detail: layer.name && layer.name !== effectName ? effectName : '',
      keywords: effectName,
      run: () => {
        app.selectLayer?.(layer.id);
        app.switchPanel?.('layers');
      },
    });
  }

  /* --- scenes --- */
  for (const scene of scenes) {
    add({
      id: `scene:${scene.id}`,
      group: 'Play scene',
      label: scene.name,
      detail: scene.hotkey ? `key ${scene.hotkey}` : '',
      common: true,
      run: () => app.activateScene?.(scene.id),
    });
  }

  /* --- looks --- */
  for (const [id, label] of actions.looks || []) {
    add({
      id: `look:${id}`,
      group: 'Look',
      label,
      keywords: 'grade bloom colour grading',
      run: () => actions.applyLook?.(id),
    });
  }

  return commands;
}

/* ------------------------------------------------------------------ *
 * The box itself
 * ------------------------------------------------------------------ */

export function createPalette(app, actions = {}) {
  const dialog = document.getElementById('paletteDialog');
  if (!dialog) return { open() {}, close() {} };

  const input = dialog.querySelector('#paletteInput');
  const list = dialog.querySelector('#paletteList');
  let commands = [];
  let shown = [];
  let active = 0;

  function render() {
    shown = rankCommands(commands, input.value);
    active = Math.min(active, Math.max(shown.length - 1, 0));
    clear(list);

    if (!shown.length) {
      list.appendChild(el('p', { class: 'panel-note', text: 'Nothing matches that.' }));
      return;
    }

    shown.forEach((command, index) => {
      const row = el('div', {
        class: `palette-row${index === active ? ' active' : ''}`,
        role: 'option',
      }, [
        el('span', { class: 'palette-group', text: command.group }),
        el('span', { class: 'palette-label', text: command.label }),
        command.detail ? el('span', { class: 'palette-detail', text: command.detail }) : null,
      ]);
      // Mousedown rather than click: the dialog closes on run, and a click
      // that lands after the element is gone does nothing.
      row.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        choose(index);
      });
      row.addEventListener('mousemove', () => {
        if (active === index) return;
        active = index;
        for (const [i, node] of [...list.children].entries()) {
          node.classList?.toggle('active', i === active);
        }
      });
      list.appendChild(row);
    });
  }

  function choose(index) {
    const command = shown[index];
    close();
    // After the dialog is gone, so a command that opens another dialog (help,
    // the file picker) is not fighting this one for the modal slot.
    if (command) setTimeout(() => command.run(), 0);
  }

  function move(delta) {
    if (!shown.length) return;
    active = (active + delta + shown.length) % shown.length;
    render();
    list.children[active]?.scrollIntoView({ block: 'nearest' });
  }

  function open() {
    commands = buildCommands(app, actions);
    input.value = '';
    active = 0;
    render();
    if (!dialog.open) dialog.showModal();
    input.focus();
  }

  function close() {
    if (dialog.open) dialog.close();
  }

  input.addEventListener('input', () => {
    active = 0;
    render();
  });

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      move(1);
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      move(-1);
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      choose(active);
    }
  });

  // Clicking the backdrop closes it, which is what every palette does.
  dialog.addEventListener('mousedown', (ev) => {
    if (ev.target === dialog) close();
  });

  return { open, close, isOpen: () => dialog.open };
}
