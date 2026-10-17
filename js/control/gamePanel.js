/**
 * The Automation panel: run it, start again, and get to its editor.
 *
 * The panel is narrow and an automation is a diagram, so editing happens in
 * the editor (control/gameEditor.js), which opens over the stage with the
 * diagram big enough to read and click. What stays here is what is wanted
 * while it runs: on or off, which step it is on, the buttons that drive it,
 * the two ways to start again, and the settings nobody needs every day.
 */

import { el, clear } from './ui.js';
import { ROLES, ROLE_LABELS, gameProblems } from '../core/game.js';
import { renderGameGraph } from '../core/gameGraph.js';
import { hasExampleGame } from './gameStarter.js';
import { createStep } from '../core/state.js';

const TIMINGS = [
  ['armMs', 'Ignore presses for', 'ms', 'A new step ignores presses for this long — a thumb still on YES from the last one.'],
  ['staleMs', 'Too late after', 'ms', 'A press older than this when it arrives is ignored, so a reconnect cannot replay it.'],
];

/** Per step, the name of the scene it shows — the diagram's second line when there are no words. */
export function stepSceneNames(project, game) {
  const scenes = new Map((project.scenes || []).map((s) => [s.id, s]));
  const names = {};
  for (const step of game?.steps || []) {
    const scene = scenes.get(step.sceneId);
    if (scene) names[step.id] = scene.name.replace(/^Example · /, '');
  }
  return names;
}

/* ------------------------------------------------------------------ *
 * The panel
 * ------------------------------------------------------------------ */

export function renderGamePanel(node, app) {
  // Folds that were open stay open across a rebuild, which happens on every edit.
  const open = new Set([...node.querySelectorAll('details[data-fold][open]')].map((d) => d.dataset.fold));
  clear(node);
  const project = app.project;
  const game = project.game;
  const commit = () => {
    app.commit();
    app.refreshPanels();
  };

  node.appendChild(liveBar(app));

  if (!game.steps.length) node.appendChild(starterCard(app));

  const editor = el('div', { class: 'gopen' }, [
    el('div', { class: 'game-graph gopen-graph', id: 'gameGraph', title: 'Open the editor' }),
    el('button', { type: 'button', class: 'btn primary', text: 'Open the editor', onclick: () => app.openGameEditor() }),
    el('p', {
      class: 'panel-note',
      text: 'Each box is a step: what the house shows and says. Arrows are the buttons and timers that move it on. Click a step to change it.',
    }),
  ]);
  editor.querySelector('#gameGraph').addEventListener('click', (ev) => {
    app.openGameEditor(ev.target.closest?.('[data-step]')?.dataset.step || null);
  });
  if (game.steps.length) node.appendChild(editor);

  const problems = gameProblems(game, project);
  if (problems.length && game.steps.length) {
    node.appendChild(el('ul', { class: 'game-problems' }, problems.map((p) => el('li', { text: p }))));
  }

  node.appendChild(fold('setup', 'Buttons', open, (body) => buttonsSection(app, body, commit)));
  node.appendChild(fold('timing', 'Press handling', open, (body) => timingSection(app, body)));
  node.appendChild(fold('log', 'Recent presses', open, (body) => body.appendChild(el('div', { class: 'game-log', id: 'gameLog' }))));

  if (hasExampleGame(project)) {
    node.appendChild(
      el('div', { class: 'panel-actions gtl-footer' }, [
        el('button', {
          type: 'button',
          class: 'btn',
          text: 'Put the example back',
          title: 'Throw away the example’s steps, scenes and effects, and build them again as new',
          onclick: () => {
            if (!confirm('Put the example back as it was built? Its steps, scenes, effects and words go back to how they started. Ctrl+Z undoes it.')) return;
            app.buildExampleGame();
          },
        }),
      ])
    );
  }

  paintGameLive(node, app);
}

function fold(key, title, open, fill) {
  const details = el('details', { class: 'game-fold', dataset: { fold: key } }, [el('summary', { text: title })]);
  if (open.has(key)) details.open = true;
  const body = el('div', { class: 'game-fold-body' });
  fill(body);
  details.appendChild(body);
  return details;
}

/**
 * The strip along the top: on or off, which step it is on, the buttons that
 * drive it, and Start again — big, because it is the one you need in a hurry.
 */
function liveBar(app) {
  const game = app.project.game;
  const toggle = el('input', { type: 'checkbox' });
  toggle.checked = !!game.enabled;
  toggle.addEventListener('change', () => {
    game.enabled = toggle.checked;
    app.commit();
    app.game.reset();
    app.refreshPanels();
  });

  const pad = el('div', { class: 'glive-pad' });
  for (const role of ROLES) {
    pad.appendChild(
      el('button', {
        type: 'button',
        class: `btn game-btn game-${role}`,
        text: ROLE_LABELS[role],
        onclick: () => app.game.press({ button: role }),
      })
    );
  }

  return el('div', { class: 'glive' }, [
    el('label', { class: 'glive-switch' }, [toggle, el('span', { text: 'Automation on' })]),
    el('div', { class: 'glive-status', id: 'gameStatus' }),
    pad,
    el('button', {
      type: 'button',
      class: 'btn glive-restart',
      text: '↺ Start again',
      title: 'Back to the start step, at once',
      onclick: () => app.game.reset(),
    }),
  ]);
}

/** For an automation with nothing in it: one button that makes all of it. */
function starterCard(app) {
  return el('div', { class: 'gstarter' }, [
    el('strong', { text: 'Start with the example' }),
    el('p', {
      html:
        'Thirteen steps built from your tagged shapes. The house asks <em>TRICK OR TREAT?</em> and argues with a NO. ' +
        'YES brings <em>lightning and smoke</em>; NO to <em>SCARED YET?</em> brings the flowers dying and a creature at the windows, ' +
        'then tentacles from the walls. DOOR at the front door, sweets, and <em>HAPPY HALLOWEEN!</em>',
    }),
    el('div', { class: 'panel-actions' }, [
      el('button', { type: 'button', class: 'btn primary', text: 'Build the example', onclick: () => app.buildExampleGame() }),
      el('button', {
        type: 'button',
        class: 'btn',
        text: 'Start from scratch',
        title: 'One empty step to build on, in the editor',
        onclick: () => {
          const game = app.project.game;
          app.pushUndo();
          const step = createStep({ name: 'Waiting' });
          game.steps.push(step);
          game.start = step.id;
          game.enabled = true;
          app.commit();
          app.game.reset();
          app.openGameEditor(step.id);
        },
      }),
    ]),
  ]);
}

function buttonsSection(app, body, commit) {
  const game = app.project.game;
  body.appendChild(
    el('p', {
      class: 'panel-note',
      text: 'Press a real button and it appears below — say which it is. YES and NO on the path, DOOR at the front door.',
    })
  );
  const roleSelect = (value, onChange) => {
    const select = el('select', {}, ROLES.map((r) => el('option', { value: r, text: ROLE_LABELS[r] })));
    select.value = value;
    select.addEventListener('change', () => onChange(select.value));
    return select;
  };
  for (const [id, role] of Object.entries(game.buttons)) {
    body.appendChild(
      el('div', { class: 'field game-button' }, [
        el('code', { text: id, title: id }),
        roleSelect(role, (value) => {
          game.buttons[id] = value;
          commit();
        }),
        el('button', {
          type: 'button',
          class: 'icon-btn',
          title: 'Forget this button',
          text: '✕',
          onclick: () => {
            delete game.buttons[id];
            commit();
          },
        }),
      ])
    );
  }
  body.appendChild(el('div', { id: 'gameLearn' }));
}

function timingSection(app, body) {
  const game = app.project.game;
  for (const [key, label, unit, help] of TIMINGS) {
    const input = el('input', { type: 'number', min: '0', step: '50', title: help });
    input.value = game.timing[key];
    input.addEventListener('change', () => {
      const value = Number(input.value);
      if (!Number.isFinite(value) || value < 0) return;
      game.timing[key] = value;
      app.commit();
    });
    body.appendChild(el('label', { class: 'field', title: help }, [el('span', { text: label }), input, el('span', { class: 'unit', text: unit })]));
  }
}

/* ------------------------------------------------------------------ *
 * Live
 * ------------------------------------------------------------------ */

/** Where it is, in a line. */
export function describeSnapshot(game, snapshot) {
  if (!game.enabled) return 'Off — presses do nothing.';
  if (!snapshot.step) return 'No steps yet.';
  let text = snapshot.name || 'Untitled';
  if (snapshot.atStart) text += ' · waiting for a press';
  if (snapshot.remaining !== null && snapshot.remaining !== undefined) text += ` · ${Math.ceil(snapshot.remaining)} s`;
  return text;
}

/**
 * The parts that move: the status, the diagram, the press log and the buttons
 * waiting to be named. Cheap, and safe to call while somebody is typing
 * elsewhere in the panel.
 */
export function paintGameLive(node, app) {
  if (!node?.querySelector('.glive')) return;
  const game = app.project.game;
  const snapshot = app.game.snapshot();

  const status = node.querySelector('#gameStatus');
  if (status) {
    status.textContent = describeSnapshot(game, snapshot);
    status.classList.toggle('on', game.enabled && !snapshot.atStart);
  }

  const graph = node.querySelector('#gameGraph');
  if (graph) graph.innerHTML = renderGameGraph({ game, snapshot, names: stepSceneNames(app.project, game) });

  const log = node.querySelector('#gameLog');
  if (log) {
    clear(log);
    if (!snapshot.log.length) log.appendChild(el('p', { class: 'panel-note', text: 'Nothing pressed yet.' }));
    for (const entry of snapshot.log.slice(0, 10)) {
      const acted = entry.result.startsWith('→');
      log.appendChild(
        el('div', { class: `game-log-row${acted ? ' acted' : ''}` }, [
          el('span', { class: 'ago', text: `${Math.round(entry.ago)}s` }),
          el('span', { class: 'who', text: entry.role ? ROLE_LABELS[entry.role] : entry.button }),
          el('span', { class: 'what', text: entry.result }),
        ])
      );
    }
  }

  // Buttons that pressed and are not known yet, newest first, once each.
  const learn = node.querySelector('#gameLearn');
  if (learn) {
    const known = new Set([...Object.keys(game.buttons), ...ROLES]);
    const fresh = [...new Set(snapshot.log.filter((e) => !known.has(e.button)).map((e) => e.button))].filter(Boolean);
    const key = fresh.join('|');
    if (learn.dataset.key !== key) {
      learn.dataset.key = key;
      clear(learn);
      for (const id of fresh) {
        learn.appendChild(
          el('div', { class: 'field game-learn' }, [
            el('code', { text: id, title: id }),
            ...ROLES.map((role) =>
              el('button', {
                type: 'button',
                class: 'btn small',
                text: ROLE_LABELS[role],
                onclick: () => {
                  game.buttons[id] = role;
                  app.commit();
                  app.refreshPanels();
                },
              })
            ),
          ])
        );
      }
    }
  }
}

