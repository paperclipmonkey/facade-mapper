/**
 * The automation editor: the diagram, big, and the step you clicked beside it.
 *
 * Opens over the stage. Each step is edited in one place — what goes on the
 * house, what it says, and where each button and its timer lead — so building
 * it is never a matter of making a scene in one tab, a trigger in another and
 * wiring them up in a third. The effects a step's scene shows are ticked off
 * right here; the scene is still an ordinary scene, and still in the Scenes
 * tab, but nobody has to go there to make a step.
 */

import { el, clear } from './ui.js';
import { ROLES, ROLE_LABELS, gameProblems, stepById, startStep } from '../core/game.js';
import { renderGameGraph } from '../core/gameGraph.js';
import { createStep, createScene } from '../core/state.js';
import { captureScene } from '../core/scenes.js';
import { stepSceneNames, describeSnapshot } from './gamePanel.js';

let root = null;
let appRef = null;
/** The step being edited, by id. */
let selected = null;
/**
 * Leaving a text field refreshes the rest of the app, which would rebuild this
 * side panel too — under the click that left the field, so the box just
 * clicked into was replaced and whatever was typed next went nowhere.
 */
let keepSide = false;

export function isGameEditorOpen() {
  return !!root && !root.hidden;
}

export function openGameEditor(app, stepId = null) {
  appRef = app;
  if (!root) build();
  if (stepId) selected = stepId;
  if (!stepById(app.project.game, selected)) selected = startStep(app.project.game)?.id ?? null;
  root.hidden = false;
  document.body.classList.add('geditor-open');
  refreshGameEditor();
}

export function closeGameEditor() {
  if (!root) return;
  root.hidden = true;
  document.body.classList.remove('geditor-open');
}

function build() {
  root = el('div', { class: 'geditor', hidden: true, role: 'dialog', 'aria-label': 'Automation editor' });
  root.innerHTML = `
    <header class="geditor-head">
      <strong>Automation</strong>
      <label class="glive-switch"><input type="checkbox" data-ge="on" /> <span>On</span></label>
      <span class="glive-status" data-ge="status"></span>
      <div class="glive-pad" data-ge="pad"></div>
      <button type="button" class="btn small" data-ge="restart" title="Back to the start step, at once">↺ Start again</button>
      <button type="button" class="btn small primary" data-ge="add">+ Add a step</button>
      <button type="button" class="btn small" data-ge="close" title="Close (Esc)">Close</button>
    </header>
    <div class="geditor-body">
      <div class="geditor-map">
        <div class="geditor-graph" data-ge="graph"></div>
        <p class="geditor-hint">Click a step to edit it. Arrows are the buttons and timers that move from one step to the next.</p>
        <ul class="game-problems" data-ge="problems" hidden></ul>
      </div>
      <aside class="geditor-side" data-ge="side"></aside>
    </div>`;
  document.body.appendChild(root);

  const q = (name) => root.querySelector(`[data-ge="${name}"]`);
  q('close').addEventListener('click', closeGameEditor);
  q('on').addEventListener('change', (ev) => {
    appRef.project.game.enabled = ev.target.checked;
    appRef.commit();
    appRef.game.reset();
  });
  q('restart').addEventListener('click', () => appRef.game.reset());
  q('add').addEventListener('click', () => addStep());
  q('graph').addEventListener('click', (ev) => {
    const node = ev.target.closest?.('[data-step]');
    if (node) select(node.dataset.step);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && isGameEditorOpen() && !ev.target.closest?.('textarea, input, select')) closeGameEditor();
  });

  const pad = q('pad');
  for (const role of ROLES) {
    pad.appendChild(
      el('button', {
        type: 'button',
        class: `btn game-btn game-${role}`,
        text: ROLE_LABELS[role],
        onclick: () => appRef.game.press({ button: role }),
      })
    );
  }
}

function select(stepId) {
  selected = stepId;
  refreshGameEditor();
}

/** Rebuild the side and repaint the diagram. After an edit, or a change from elsewhere. */
export function refreshGameEditor() {
  if (!isGameEditorOpen()) return;
  if (!stepById(appRef.project.game, selected)) selected = startStep(appRef.project.game)?.id ?? null;
  if (!keepSide) renderSide();
  paintGameEditor();
}

/** The moving parts only: the diagram and the status. Cheap; safe while typing. */
export function paintGameEditor() {
  if (!isGameEditorOpen()) return;
  const app = appRef;
  const game = app.project.game;
  const snapshot = app.game.snapshot();
  const q = (name) => root.querySelector(`[data-ge="${name}"]`);

  q('on').checked = !!game.enabled;
  const status = q('status');
  status.textContent = describeSnapshot(game, snapshot);
  status.classList.toggle('on', !!(game.enabled && !snapshot.atStart));

  q('graph').innerHTML = renderGameGraph({ game, snapshot, names: stepSceneNames(app.project, game), selected });

  const problems = game.steps.length ? gameProblems(game, app.project) : [];
  const list = q('problems');
  list.hidden = !problems.length;
  clear(list);
  for (const p of problems) list.appendChild(el('li', { text: p }));
}

/* ------------------------------------------------------------------ *
 * Steps
 * ------------------------------------------------------------------ */

function addStep() {
  const app = appRef;
  const game = app.project.game;
  app.pushUndo();
  const step = createStep({ name: `Step ${game.steps.length + 1}` });
  game.steps.push(step);
  if (!game.start) game.start = step.id;
  selected = step.id;
  app.commit();
}

function deleteStep(step) {
  const app = appRef;
  const game = app.project.game;
  if (!confirm(`Delete the step "${step.name}"? Anything leading to it will lead nowhere. Ctrl+Z puts it back.`)) return;
  app.pushUndo();
  game.steps = game.steps.filter((s) => s !== step);
  for (const other of game.steps) {
    for (const role of ROLES) if (other.on?.[role] === step.id) other.on[role] = null;
    if (other.after?.to === step.id) other.after.to = null;
  }
  if (game.start === step.id) game.start = game.steps[0]?.id ?? null;
  selected = game.start;
  app.commit();
}

/**
 * A text field that edits as you type without rebuilding the panel under
 * your cursor: one undo step per visit to the field, the diagram repainted
 * as it changes, and the full refresh left until you leave it.
 */
function liveField(input, apply) {
  input.addEventListener('focus', () => appRef.pushUndo());
  input.addEventListener('input', () => {
    apply(input.value);
    appRef.commitLive();
    paintGameEditor();
  });
  input.addEventListener('change', () => {
    keepSide = true;
    try {
      appRef.refreshPanels();
    } finally {
      keepSide = false;
    }
  });
  return input;
}

/** A select of steps, with "nothing" first. */
function stepSelect(game, value, onChange, { none = '— nothing —' } = {}) {
  const select = el('select', {}, [
    el('option', { value: '', text: none }),
    ...game.steps.map((s) => el('option', { value: s.id, text: s.name || 'Untitled' })),
  ]);
  select.value = value || '';
  select.addEventListener('change', () => onChange(select.value || null));
  return select;
}

function renderSide() {
  const app = appRef;
  const project = app.project;
  const game = project.game;
  const side = root.querySelector('[data-ge="side"]');
  const scroll = side.scrollTop;
  clear(side);

  const step = stepById(game, selected);
  if (!step) {
    side.append(
      el('h2', { text: 'No steps yet' }),
      el('p', { class: 'ge-help', text: 'Add a step, or build the example from the Automation panel and change it.' })
    );
    return;
  }
  const commit = () => {
    app.commit();
  };
  const edit = (fn) => {
    app.pushUndo();
    fn();
    commit();
  };
  const isStart = startStep(game) === step;

  // Name, and whether this is where it starts.
  const name = liveField(el('input', { type: 'text', class: 'ge-name', value: step.name }), (v) => {
    step.name = v;
  });
  side.appendChild(el('div', { class: 'ge-title' }, [name]));
  side.appendChild(
    el('p', { class: 'ge-note' }, [
      isStart
        ? el('span', { class: 'chip on', text: 'Start: the show waits here, and Start again comes back here' })
        : el('button', { type: 'button', class: 'btn small', text: 'Make this the start', onclick: () => edit(() => { game.start = step.id; }) }),
    ])
  );

  side.appendChild(houseSection(app, step, edit));
  side.appendChild(wordsSection(app, step));
  side.appendChild(nextSection(app, step, edit));

  // Sound and the alert indoors.
  const extra = el('section', { class: 'ge-section' }, [el('h3', { text: 'Also' })]);
  const sounds = (project.media || []).filter((m) => m.kind === 'audio');
  const sound = el('select', {}, [
    el('option', { value: '', text: sounds.length ? '— no sound —' : '— no sounds uploaded (Media tab) —' }),
    ...sounds.map((m) => el('option', { value: m.id, text: m.name || m.id })),
  ]);
  sound.value = step.sound || '';
  sound.addEventListener('change', () => edit(() => { step.sound = sound.value || null; }));
  extra.appendChild(el('label', { class: 'field' }, [el('span', { text: 'Play' }), sound]));
  const alert = el('input', { type: 'checkbox' });
  alert.checked = !!step.alert;
  alert.addEventListener('change', () => edit(() => { step.alert = alert.checked; }));
  extra.appendChild(el('label', { class: 'inline-check' }, [alert, 'Alert me indoors — the remote rings and flashes']));
  side.appendChild(extra);

  side.appendChild(
    el('div', { class: 'panel-actions' }, [
      el('button', { type: 'button', class: 'btn small danger', text: 'Delete this step', onclick: () => deleteStep(step) }),
    ])
  );

  side.scrollTop = scroll;
}

/** 1 · What goes on the house: a scene, or nothing (keep it as it is), and its effects ticked off. */
function houseSection(app, step, edit) {
  const project = app.project;
  const game = project.game;
  const section = el('section', { class: 'ge-section' }, [el('h3', { text: '1 · On the house' })]);

  const select = el('select', {}, [
    el('option', { value: '', text: '— keep what is on —' }),
    ...(project.scenes || []).map((s) => el('option', { value: s.id, text: s.name })),
  ]);
  select.value = step.sceneId || '';
  select.addEventListener('change', () => edit(() => { step.sceneId = select.value || null; }));
  const show = el('button', {
    type: 'button',
    class: 'btn small',
    text: '▶',
    title: 'Show it on the house',
    disabled: !step.sceneId,
    onclick: () => app.previewScene(step.sceneId),
  });
  section.appendChild(el('div', { class: 'ge-scene-row' }, [select, show]));

  const scene = project.scenes.find((s) => s.id === step.sceneId);
  if (!scene) {
    section.appendChild(el('p', { class: 'ge-help', text: 'The house stays as the step before left it; only the words change.' }));
    section.appendChild(
      el('button', {
        type: 'button',
        class: 'btn small',
        text: 'Make a scene from what is on the wall now',
        onclick: () =>
          edit(() => {
            const made = createScene({ name: step.name || 'Step', fade: 0.6, full: true, state: captureScene(project) });
            // Without the step's words: those are the step's, written over it.
            const message = game.messageLayer && made.state[game.messageLayer];
            if (message) message.enabled = false;
            project.scenes.push(made);
            step.sceneId = made.id;
          }),
      })
    );
    return section;
  }

  section.appendChild(el('p', { class: 'ge-help', text: 'Tick what this step shows. It changes the scene, which every step using it shares.' }));
  const list = el('div', { class: 'ge-effects' });
  for (const layer of project.layers) {
    if (layer.id === game.messageLayer) continue;
    const stored = scene.state?.[layer.id];
    const on = stored ? stored.enabled !== false : !scene.full && layer.enabled !== false;
    const box = el('input', { type: 'checkbox' });
    box.checked = on;
    box.addEventListener('change', () =>
      edit(() => {
        scene.state = scene.state || {};
        scene.state[layer.id] = {
          opacity: layer.opacity ?? 1,
          params: { ...(layer.params || {}) },
          ...(scene.state[layer.id] || {}),
          enabled: box.checked,
        };
        // Seen as it changes, when it is the scene on the wall.
        if (project.show?.activeScene === scene.id) app.previewScene(scene.id);
      })
    );
    list.appendChild(el('label', { class: 'inline-check' }, [box, layer.name || layer.effect]));
  }
  section.appendChild(list);
  return section;
}

/** 2 · What it says, written over whatever is on the house. */
function wordsSection(app, step) {
  const section = el('section', { class: 'ge-section' }, [el('h3', { text: '2 · Words on the wall' })]);
  const words = liveField(el('textarea', { class: 'gstep-words', rows: '3', placeholder: 'Nothing — no words' }), (v) => {
    step.words = v;
  });
  words.value = step.words || '';
  section.append(
    words,
    el('div', { class: 'ge-row' }, [
      el('span', { class: 'ge-help', text: 'A new line is a new line on the wall.' }),
      el('button', {
        type: 'button',
        class: 'btn small',
        text: '▶ Show',
        onclick: () => {
          if (String(step.words || '').trim()) app.previewCaption(step.words);
        },
      }),
    ])
  );
  return section;
}

/** 3 · Where each button leads, and the timer. */
function nextSection(app, step, edit) {
  const game = app.project.game;
  const section = el('section', { class: 'ge-section' }, [el('h3', { text: '3 · Then' })]);
  const list = el('ul', { class: 'ge-next' });
  for (const role of ROLES) {
    const to = step.on?.[role] || null;
    list.appendChild(
      el('li', {}, [
        el('span', { class: `ge-when ev-${role}`, text: ROLE_LABELS[role] }),
        el('span', { class: 'ge-arrow', text: '→' }),
        stepSelect(game, to, (value) => edit(() => { step.on = { ...(step.on || {}), [role]: value }; })),
        to ? el('button', { type: 'button', class: 'ge-to', text: 'Go', title: 'Edit that step', onclick: () => select(to) }) : null,
      ].filter(Boolean))
    );
  }

  const seconds = el('input', { type: 'number', min: '0', step: '0.5', class: 'ge-seconds' });
  seconds.value = step.after?.seconds || '';
  seconds.placeholder = 'never';
  seconds.addEventListener('change', () =>
    edit(() => {
      const value = Number(seconds.value);
      step.after = { ...(step.after || {}), seconds: Number.isFinite(value) && value > 0 ? value : 0 };
    })
  );
  const to = step.after?.to || null;
  list.appendChild(
    el('li', {}, [
      el('span', { class: 'ge-when', text: 'After' }),
      seconds,
      el('span', { class: 'ge-when', text: 's' }),
      el('span', { class: 'ge-arrow', text: '→' }),
      stepSelect(game, to, (value) => edit(() => { step.after = { ...(step.after || {}), to: value }; })),
      to ? el('button', { type: 'button', class: 'ge-to', text: 'Go', title: 'Edit that step', onclick: () => select(to) }) : null,
    ].filter(Boolean))
  );
  section.appendChild(list);
  section.appendChild(
    el('p', {
      class: 'ge-help',
      text: 'A step with words and no timer waits for a button. Leave the seconds empty and it never moves on by itself.',
    })
  );
  return section;
}
