/**
 * The Game panel: build the dare game, and watch it play.
 *
 * Two halves that change at different speeds. The form — the ladder, a scene
 * for every moment, which button is which, the timings — is rebuilt when the
 * project changes, like every other panel. The live half — the diagram, the
 * status line, the press log — is repainted whenever the game moves, which can
 * be several times a second while somebody is testing, and must not rebuild a
 * dropdown out from under the pointer while it does.
 *
 * The diagram is the builder's map. Click a state on it and the panel scrolls
 * to what that state shows; press a test button and the diagram shows where it
 * went. That is most of what a visual builder buys, without the half of one
 * that lets you draw a transition the runtime does not have.
 */

import { el, clear } from './ui.js';
import { STATES, ROLES, ROLE_LABELS, gameProblems, sceneSlot } from '../core/game.js';
import { renderGameGraph, holdable } from '../core/gameGraph.js';

/** The scene slots, in the order a group meets them. */
const SCENE_SLOTS = ['attract', 'ask', 'nudge', 'decide', 'approach', 'chicken', 'mercy', 'waiting', 'reward', 'early'];

const TIMINGS = [
  ['askTimeout', 'Question', 's', 'How long a question waits before asking whether anyone is there.'],
  ['nudgeTimeout', 'Anyone there?', 's', 'How long that waits before giving up on the group.'],
  ['approachTimeout', 'Come closer', 's', 'How long the house waits for the door button.'],
  ['waitForTreat', 'Wait for treat', 's', 'After saying no, or surviving: how long until the house resets on its own.'],
  ['rewardHold', 'Reward', 's', 'How long the reward plays.'],
  ['cooldown', 'Cooldown', 's', 'Between one group leaving and the house inviting the next.'],
  ['decideHold', "Can't decide", 's', 'How long the "we will decide for you" moment lasts.'],
  ['earlyHold', 'Too soon', 's', 'How long the door telling them to start at the path lasts.'],
  ['scareHold', 'Empty rung', 's', 'Hold for a rung with nothing to play, so the rhythm survives a gap.'],
  ['armMs', 'Arming', 'ms', 'A new question ignores presses for this long — a thumb still on YES from the last one.'],
  ['windowMs', 'Decision', 'ms', 'YES and NO within this long of each other is both.'],
  ['staleMs', 'Stale after', 'ms', 'A press older than this when it arrives is ignored, so a reconnect cannot replay it.'],
];

/** Which states are worth a warning when they show nothing. */
export function gameMissing(game) {
  return {
    ask: !sceneSlot(game, 'ask', 1),
    scare: !game.rungs?.length,
    finale: !game.finale,
    approach: !!game.door && !game.scenes?.approach,
  };
}

/** Per state, what this show puts in it — the second line of each box. */
export function gameNames(project, game, level = 0) {
  const sceneName = (id) => (project.scenes || []).find((s) => s.id === id)?.name || '';
  const triggerName = (id) => (project.triggers || []).find((t) => t.id === id)?.name || '';
  const names = {};
  for (const state of Object.keys(STATES)) {
    const id = sceneSlot(game, state, Math.max(1, level));
    if (id) names[state] = sceneName(id);
  }
  const rungs = game.rungs || [];
  names.scare = level > 0 && rungs[level - 1] ? triggerName(rungs[level - 1]) : rungs.length ? `${rungs.length} rung${rungs.length === 1 ? '' : 's'}` : '';
  names.finale = triggerName(game.finale);
  return names;
}

/**
 * Build the panel. `app.game` is the runtime's face: press, reset, snapshot.
 */
export function renderGamePanel(node, app) {
  clear(node);
  const project = app.project;
  const game = project.game;
  const commit = () => {
    app.commit();
    app.refreshPanels();
  };

  /* --- On, and how it ends --- */

  const enabled = el('input', { type: 'checkbox' });
  enabled.checked = !!game.enabled;
  enabled.addEventListener('change', () => {
    game.enabled = enabled.checked;
    if (!game.enabled) app.game.reset();
    commit();
  });
  const door = el('input', { type: 'checkbox' });
  door.checked = !!game.door;
  door.addEventListener('change', () => {
    game.door = door.checked;
    commit();
  });

  node.append(
    el('p', {
      class: 'panel-note',
      html:
        'Buttons on the path ask <strong>do you dare?</strong> and every YES climbs a ladder of scares. ' +
        'Keep the words on the path, where people stand far enough back to read the wall; at the door ' +
        'they are too close, so the finale is sound and light. The remote has the same buttons for testing.',
    }),
    el('label', { class: 'inline-check' }, [enabled, 'Game on — presses start it, and it holds the stage while it plays']),
    el('label', { class: 'inline-check' }, [door, 'End at the door — the top of the ladder invites them up to the DOOR button']),
  );

  /* --- Try it, and watch it --- */

  const status = el('div', { class: 'game-status', id: 'gameStatus' });
  const tryRow = el('div', { class: 'panel-actions game-try' });
  for (const role of ROLES) {
    const button = el('button', { type: 'button', class: `btn small game-btn game-${role}`, text: ROLE_LABELS[role] });
    if (role === 'no') {
      // Held down it is mercy, the same as the real button's long press.
      holdable(button, () => app.game.press({ button: 'no' }), () => app.game.press({ button: 'no', kind: 'long' }));
    } else {
      button.addEventListener('click', () => app.game.press({ button: role }));
    }
    tryRow.appendChild(button);
  }
  tryRow.appendChild(el('button', { type: 'button', class: 'btn small', text: 'Reset', onclick: () => app.game.reset() }));

  const graph = el('div', { class: 'game-graph', id: 'gameGraph', title: 'Click a state to see what it shows' });
  graph.addEventListener('click', (ev) => {
    const target = ev.target.closest?.('[data-state]');
    if (!target) return;
    const section = node.querySelector(`[data-game-state="${target.dataset.state}"]`);
    if (!section) return;
    section.scrollIntoView({ behavior: 'smooth', block: 'center' });
    section.classList.remove('flash');
    void section.offsetWidth;
    section.classList.add('flash');
  });
  const enlarge = el('button', {
    type: 'button',
    class: 'btn small',
    text: 'Enlarge',
    onclick: () => {
      const wide = graph.classList.toggle('wide');
      enlarge.textContent = wide ? 'Shrink' : 'Enlarge';
    },
  });

  node.append(
    el('h3', { class: 'panel-heading', text: 'Try it' }),
    tryRow,
    status,
    el('div', { class: 'panel-actions' }, [enlarge, el('span', { class: 'panel-note inline', text: 'Hold NO for mercy. Click a state to edit it.' })]),
    graph,
  );

  const problems = gameProblems(game, project);
  if (problems.length) {
    node.appendChild(el('ul', { class: 'game-problems' }, problems.map((p) => el('li', { text: p }))));
  }

  /* --- The ladder --- */

  const triggers = project.triggers || [];
  const triggerSelect = (value, onChange, empty = '— nothing —') => {
    const select = el('select', {}, [
      el('option', { value: '', text: empty }),
      ...triggers.map((t) => el('option', { value: t.id, text: t.name })),
    ]);
    select.value = value || '';
    select.addEventListener('change', () => onChange(select.value || null));
    return select;
  };

  const ladder = el('div', { class: 'game-section', dataset: { gameState: 'scare' } });
  ladder.appendChild(el('h3', { class: 'panel-heading', text: 'The ladder' }));
  ladder.appendChild(
    el('p', {
      class: 'panel-note',
      text: 'One trigger per rung, mildest first. A trigger already is a scare — a scene, a sound, a hold and its hooks — so build them in Triggers and line them up here.',
    })
  );
  game.rungs.forEach((id, i) => {
    const move = (delta) => {
      const j = i + delta;
      if (j < 0 || j >= game.rungs.length) return;
      [game.rungs[i], game.rungs[j]] = [game.rungs[j], game.rungs[i]];
      commit();
    };
    ladder.appendChild(
      el('div', { class: 'field game-rung' }, [
        el('span', { text: `Rung ${i + 1}` }),
        triggerSelect(id, (value) => {
          if (value) game.rungs[i] = value;
          else game.rungs.splice(i, 1);
          commit();
        }),
        el('button', { type: 'button', class: 'icon-btn', title: 'Earlier', text: '↑', onclick: () => move(-1) }),
        el('button', { type: 'button', class: 'icon-btn', title: 'Later', text: '↓', onclick: () => move(1) }),
        el('button', {
          type: 'button',
          class: 'icon-btn',
          title: 'Remove',
          text: '✕',
          onclick: () => {
            game.rungs.splice(i, 1);
            commit();
          },
        }),
      ])
    );
  });
  ladder.appendChild(
    el('div', { class: 'field' }, [
      el('span', { text: 'Add a rung' }),
      triggerSelect(null, (value) => {
        if (!value) return;
        game.rungs.push(value);
        commit();
      }, triggers.length ? '— choose a trigger —' : '— make a trigger first —'),
    ])
  );
  node.appendChild(ladder);

  const finale = el('div', { class: 'game-section', dataset: { gameState: 'finale' } }, [
    el('div', { class: 'field' }, [
      el('span', { text: 'Finale' }),
      triggerSelect(game.finale, (value) => {
        game.finale = value;
        commit();
      }),
    ]),
    el('p', {
      class: 'panel-note',
      text: game.door
        ? 'Played when they press the door button. They are on the doorstep: make it sound, light and something looming over them — they cannot read anything from there.'
        : 'Played at the top of the ladder, where they stand.',
    }),
  ]);
  node.appendChild(finale);

  /* --- What each moment shows --- */

  node.appendChild(el('h3', { class: 'panel-heading', text: 'What each moment shows' }));
  const scenes = project.scenes || [];
  const sceneSelect = (value, onChange, empty = '— leave it as it is —') => {
    const select = el('select', {}, [
      el('option', { value: '', text: empty }),
      ...scenes.map((s) => el('option', { value: s.id, text: s.name })),
    ]);
    select.value = value || '';
    select.addEventListener('change', () => onChange(select.value || null));
    return select;
  };

  for (const slot of SCENE_SLOTS) {
    const def = STATES[slot];
    if (slot === 'approach' && !game.door) continue;
    const section = el('div', { class: 'game-section', dataset: { gameState: slot } });
    const zoneNote = def.zone === 'door' ? ' At the door — no words.' : '';
    section.appendChild(el('div', { class: 'game-slot-head' }, [
      el('strong', { text: def.label }),
      el('span', { class: 'panel-note inline', text: ` ${def.note}.${zoneNote}` }),
    ]));

    if (Array.isArray(game.scenes[slot])) {
      // One per level, as many as there are rungs. A blank repeats the one above.
      const levels = Math.max(1, game.rungs.length);
      for (let i = 0; i < levels; i++) {
        section.appendChild(
          el('div', { class: 'field' }, [
            el('span', { text: `Level ${i + 1}` }),
            sceneSelect(game.scenes[slot][i], (value) => {
              game.scenes[slot][i] = value;
              commit();
            }, i ? '— same as the level above —' : '— nothing —'),
          ])
        );
      }
    } else {
      section.appendChild(
        el('div', { class: 'field' }, [
          el('span', { text: 'Scene' }),
          sceneSelect(game.scenes[slot], (value) => {
            game.scenes[slot] = value;
            commit();
          }),
        ])
      );
    }
    node.appendChild(section);
  }

  /* --- Buttons --- */

  node.appendChild(el('h3', { class: 'panel-heading', text: 'Buttons' }));
  node.appendChild(
    el('p', {
      class: 'panel-note',
      text: 'Press a real button and it appears below; say what it is. Two or three is plenty: YES and NO on the path, DOOR at the front door. TREAT is for the adult — the remote has one.',
    })
  );
  const roleSelect = (value, onChange) => {
    const select = el('select', {}, ROLES.map((r) => el('option', { value: r, text: ROLE_LABELS[r] })));
    select.value = value;
    select.addEventListener('change', () => onChange(select.value));
    return select;
  };
  for (const [id, role] of Object.entries(game.buttons)) {
    node.appendChild(
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
  node.appendChild(el('div', { id: 'gameLearn' }));

  /* --- Timing --- */

  const timing = el('details', { class: 'game-timing' }, [el('summary', { text: 'Timing' })]);
  for (const [key, label, unit, help] of TIMINGS) {
    const input = el('input', { type: 'number', min: '0', step: unit === 'ms' ? '50' : '0.5', title: help });
    input.value = game.timing[key];
    input.addEventListener('change', () => {
      const value = Number(input.value);
      if (!Number.isFinite(value) || value < 0) return;
      game.timing[key] = value;
      app.commit();
    });
    timing.appendChild(el('label', { class: 'field', title: help }, [el('span', { text: label }), input, el('span', { class: 'unit', text: unit })]));
  }
  node.appendChild(timing);

  node.append(el('h3', { class: 'panel-heading', text: 'Presses' }), el('div', { class: 'game-log', id: 'gameLog' }));

  paintGameLive(node, app);
}

/**
 * The parts that move: the diagram, the status line, the press log and the
 * buttons waiting to be named. Cheap, and safe to call while somebody is using
 * a dropdown elsewhere in the panel.
 */
export function paintGameLive(node, app) {
  const graph = node.querySelector('#gameGraph');
  if (!graph) return;
  const game = app.project.game;
  const snapshot = app.game.snapshot();

  graph.innerHTML = renderGameGraph({
    game,
    snapshot,
    names: gameNames(app.project, game, snapshot.active ? snapshot.level : 0),
    missing: gameMissing(game),
  });

  const status = node.querySelector('#gameStatus');
  if (status) {
    const def = STATES[snapshot.state];
    let text;
    if (!game.enabled) text = 'The game is off. The test buttons do nothing until it is on.';
    else if (!snapshot.active) text = 'Waiting for somebody to press a button.';
    else {
      text = `${def.label}${def.levelled ? ` ${snapshot.level} of ${snapshot.of}` : ''}`;
      if (snapshot.remaining !== null) text += ` · ${Math.ceil(snapshot.remaining)} s`;
      if (snapshot.deciding) text += ` · ${ROLE_LABELS[snapshot.deciding]} pressed, listening for the other button`;
    }
    status.textContent = text;
    status.classList.toggle('on', snapshot.active && game.enabled);
  }

  const log = node.querySelector('#gameLog');
  if (log) {
    clear(log);
    if (!snapshot.log.length) log.appendChild(el('p', { class: 'panel-note', text: 'Nothing pressed yet.' }));
    for (const entry of snapshot.log.slice(0, 10)) {
      const acted = entry.result.startsWith('→') || entry.result.startsWith('both');
      log.appendChild(
        el('div', { class: `game-log-row${acted ? ' acted' : ''}` }, [
          el('span', { class: 'ago', text: `${Math.round(entry.ago)}s` }),
          el('span', { class: 'who', text: entry.role ? ROLE_LABELS[entry.role] + (entry.kind === 'long' ? ' held' : '') : entry.button }),
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
