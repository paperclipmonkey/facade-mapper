/**
 * The Game panel: play the dare game, and get to its editor.
 *
 * The panel is narrow and the game is a tree, so editing happens in the game
 * editor (control/gameEditor.js), which opens over the stage with the tree big
 * enough to read and click. What stays here is what is wanted while the game
 * is running: on or off, where it is, the four buttons that play it, a
 * rehearsal, the tree in miniature, and the settings nobody needs every day.
 *
 * The helpers that say what a scene shows and what it says are here too, and
 * shared with the editor.
 */

import { el, clear } from './ui.js';
import { STATES, ROLES, ROLE_LABELS, gameProblems, sceneSlot } from '../core/game.js';
import { renderGameGraph, holdable } from '../core/gameGraph.js';
import { hasExampleGame } from './gameStarter.js';

const TIMINGS = [
  ['askTimeout', 'Question waits', 's', 'How long a question waits before asking whether anyone is there.'],
  ['nudgeTimeout', 'Then gives up', 's', 'How long "anyone there?" waits before the house resets.'],
  ['approachTimeout', 'Door waits', 's', 'How long the house waits for the door button.'],
  ['waitForTreat', 'Treat waits', 's', 'After saying no, or surviving: how long until the house moves on by itself.'],
  ['rewardHold', 'Reward', 's', 'How long the reward plays.'],
  ['cooldown', 'Between groups', 's', 'After one group leaves and before the house invites the next.'],
  ['decideHold', "Can't decide", 's', 'How long the "we will decide for you" moment lasts.'],
  ['earlyHold', 'Too soon', 's', 'How long the door shouts at somebody who ran straight to it.'],
  ['scareHold', 'Empty scare', 's', 'Hold for a scare with nothing to play, so the rhythm survives a gap.'],
  ['armMs', 'Ignore presses for', 'ms', 'A new question ignores presses for this long — a thumb still on YES from the last one.'],
  ['windowMs', 'Both buttons within', 'ms', 'YES and NO within this long of each other is "can’t decide".'],
  ['staleMs', 'Too late after', 'ms', 'A press older than this when it arrives is ignored, so a reconnect cannot replay it.'],
];

/* ------------------------------------------------------------------ *
 * What a scene is
 * ------------------------------------------------------------------ */

const sceneOf = (project, id) => (project.scenes || []).find((s) => s.id === id) || null;
const triggerOf = (project, id) => (project.triggers || []).find((t) => t.id === id) || null;

/** The effects a scene turns on, by name — what the house is doing then. */
export function sceneContents(project, sceneId) {
  const scene = sceneOf(project, sceneId);
  if (!scene) return [];
  const out = [];
  for (const layer of project.layers || []) {
    const stored = scene.state?.[layer.id];
    const on = stored ? stored.enabled : !scene.full && layer.enabled;
    if (on && layer.effect !== 'text') out.push(layer.name || layer.effect);
  }
  return out;
}

/**
 * The words a scene puts on the wall: the first text layer it switches on,
 * and what that layer says in this scene. Null if it says nothing.
 */
export function sceneMessage(project, sceneId) {
  const scene = sceneOf(project, sceneId);
  if (!scene) return null;
  for (const layer of project.layers || []) {
    if (layer.effect !== 'text') continue;
    const stored = scene.state?.[layer.id];
    if (!stored?.enabled) continue;
    return { layer, text: String(stored.params?.content ?? layer.params?.content ?? '') };
  }
  return null;
}

/**
 * Change what a scene says.
 *
 * Into the scene's own stored state, which is where its words live — and onto
 * the layer as well if this is the scene loaded for editing, so the inspector
 * and the wall agree. A scene the game or a preview has put up reads its words
 * from the scene, so it changes on the wall as you type either way.
 */
export function setSceneMessage(project, sceneId, layerId, text) {
  const scene = sceneOf(project, sceneId);
  const stored = scene?.state?.[layerId];
  if (!stored) return false;
  stored.params = { ...(stored.params || {}), content: text };
  if (project.show?.sceneLoaded === sceneId) {
    const layer = project.layers.find((l) => l.id === layerId);
    if (layer) layer.params = { ...layer.params, content: text };
  }
  return true;
}

/** Which states are worth a warning when they show nothing. */
export function gameMissing(game) {
  return {
    ask: !sceneSlot(game, 'ask', 1),
    scare: !game.rungs?.length,
    finale: !game.finale,
    approach: !!game.door && !game.scenes?.approach,
  };
}

/** Per state, what this show puts in it — the second line of each box on the diagram. */
export function gameNames(project, game, level = 0) {
  const names = {};
  for (const state of Object.keys(STATES)) {
    const id = sceneSlot(game, state, Math.max(1, level));
    if (id) names[state] = sceneOf(project, id)?.name?.replace(/^Dare · /, '') || '';
  }
  const rungs = game.rungs || [];
  const triggerName = (id) => triggerOf(project, id)?.name?.replace(/^Dare · /, '') || '';
  names.scare = level > 0 && rungs[level - 1] ? triggerName(rungs[level - 1]) : rungs.length ? `${rungs.length} scare${rungs.length === 1 ? '' : 's'}` : '';
  names.finale = triggerName(game.finale);
  return names;
}

/* ------------------------------------------------------------------ *
 * The panel
 * ------------------------------------------------------------------ */

/**
 * Build the panel: the strip that plays the game, the tree in miniature (which
 * opens the editor), and the settings nobody needs every day, folded away.
 * Editing happens in the game editor (control/gameEditor.js), where the tree
 * is big enough to read and every moment on it can be clicked.
 */
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

  const empty = !game.rungs.length && !sceneSlot(game, 'ask', 1);
  if (empty) node.appendChild(starterCard(app));

  const editor = el('div', { class: 'gopen' }, [
    el('div', { class: 'game-graph gopen-graph', id: 'gameGraph', title: 'Open the game editor' }),
    el('button', { type: 'button', class: 'btn primary', text: 'Open the game editor', onclick: () => app.openGameEditor() }),
    el('p', {
      class: 'panel-note',
      text: 'The whole game as a tree. Click any moment in it to change what it says, what it shows, the words said first, and where it goes next.',
    }),
  ]);
  editor.querySelector('#gameGraph').addEventListener('click', (ev) => {
    const target = ev.target.closest?.('[data-state]');
    app.openGameEditor(target?.dataset.state || null);
  });
  node.appendChild(editor);

  const problems = gameProblems(game, project);
  if (problems.length && !empty) {
    node.appendChild(el('ul', { class: 'game-problems' }, problems.map((p) => el('li', { text: p }))));
  }

  node.appendChild(fold('setup', 'How it ends, and the buttons', open, (body) => buttonsSection(app, body, commit)));
  node.appendChild(fold('timing', 'Timing', open, (body) => timingSection(app, body)));
  node.appendChild(fold('log', 'Recent presses', open, (body) => body.appendChild(el('div', { class: 'game-log', id: 'gameLog' }))));

  if (hasExampleGame(project)) {
    node.appendChild(
      el('div', { class: 'panel-actions gtl-footer' }, [
        el('button', {
          type: 'button',
          class: 'btn small',
          text: 'Rebuild the example',
          title: 'Throw away the example game\u2019s scenes and scares, and build them again as new',
          onclick: () => {
            if (!confirm('Rebuild the example game? Its scenes, scares and words go back to how they started.')) return;
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

/** The strip along the top: on or off, where the game is, and the four buttons to play it. */
function liveBar(app) {
  const game = app.project.game;
  const toggle = el('input', { type: 'checkbox' });
  toggle.checked = !!game.enabled;
  toggle.addEventListener('change', () => {
    game.enabled = toggle.checked;
    if (!game.enabled) app.game.reset();
    app.commit();
    app.refreshPanels();
  });

  const pad = el('div', { class: 'glive-pad' });
  for (const role of ROLES) {
    const button = el('button', { type: 'button', class: `btn game-btn game-${role}`, text: ROLE_LABELS[role] });
    if (role === 'no') {
      // Held down it is mercy, the same as the real button's long press.
      holdable(button, () => app.game.press({ button: 'no' }), () => app.game.press({ button: 'no', kind: 'long' }));
      button.title = 'Hold it down during a scare for mercy';
    } else {
      button.addEventListener('click', () => app.game.press({ button: role }));
    }
    if (role === 'door' && !game.door) button.hidden = true;
    pad.appendChild(button);
  }
  pad.appendChild(el('button', { type: 'button', class: 'btn game-reset', text: '↺', title: 'Back to the start', onclick: () => app.game.reset() }));

  const rehearse = el('button', {
    type: 'button',
    class: 'btn small glive-rehearse',
    id: 'gameRehearse',
    title: 'Play a brave group through the whole visit, so you can go outside and watch it',
    onclick: () => app.rehearse(),
  });

  return el('div', { class: 'glive' }, [
    el('label', { class: 'glive-switch' }, [toggle, el('span', { text: 'Game on' })]),
    el('div', { class: 'glive-status', id: 'gameStatus' }),
    pad,
    rehearse,
  ]);
}

/** For a game with nothing in it: one button that makes all of it. */
function starterCard(app) {
  return el('div', { class: 'gstarter' }, [
    el('strong', { text: 'Start with the example' }),
    el('p', {
      html:
        'A complete game built from your tagged shapes. The house waits with <em>brick, smoke and a basket of flowers</em>; ' +
        'each YES is answered with a dare — <em>"YOU ASKED FOR IT…"</em> — and a horror it keeps: <em>blood down the door</em> as the flowers die, ' +
        'then <em>people at the windows</em>, then <em>tentacles through the brick</em>. The door button sets off everything at once.',
    }),
    el('button', { type: 'button', class: 'btn primary', text: 'Build the example game', onclick: () => app.buildExampleGame() }),
  ]);
}

function buttonsSection(app, body, commit) {
  const game = app.project.game;
  const door = el('input', { type: 'checkbox' });
  door.checked = !!game.door;
  door.addEventListener('change', () => {
    game.door = door.checked;
    commit();
  });
  body.append(
    el('label', { class: 'inline-check' }, [door, 'End at the front door, with a DOOR button there']),
    el('p', {
      class: 'panel-note',
      text: 'Press a real button and it appears below — say which it is. YES and NO go on the path, DOOR at the front door. TREAT is for the adult: the remote has one.',
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
    const input = el('input', { type: 'number', min: '0', step: unit === 'ms' ? '50' : '0.5', title: help });
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

/**
 * The parts that move: the status, the card that is live, the press log, the
 * buttons waiting to be named and the diagram if it is open. Cheap, and safe to
 * call while somebody is typing elsewhere in the panel.
 */
export function paintGameLive(node, app) {
  if (!node?.querySelector('.glive')) return;
  const game = app.project.game;
  const snapshot = app.game.snapshot();
  const playing = game.enabled && snapshot.active;

  const rehearse = node.querySelector('#gameRehearse');
  if (rehearse) {
    const on = !!app.rehearsing?.();
    rehearse.textContent = on ? '■ Stop rehearsing' : '▶ Rehearse the whole visit';
    rehearse.classList.toggle('on', on);
  }

  const status = node.querySelector('#gameStatus');
  if (status) {
    const def = STATES[snapshot.state];
    let text;
    if (!game.enabled) text = 'Off — presses do nothing.';
    else if (!snapshot.active) text = 'Waiting for somebody to press a button.';
    else {
      text = `${def.label}${def.levelled ? ` ${snapshot.level} of ${snapshot.of}` : ''}`;
      if (snapshot.saying) text += ` · saying “${snapshot.saying.text.replace(/\s*\n\s*/g, ' ')}”`;
      else if (snapshot.remaining !== null) text += ` · ${Math.ceil(snapshot.remaining)} s`;
      if (snapshot.deciding) text += ' · listening for the other button…';
    }
    status.textContent = text;
    status.classList.toggle('on', playing);
  }

  // The tree in miniature, lit like the big one.
  const graph = node.querySelector('#gameGraph');
  if (graph) {
    graph.innerHTML = renderGameGraph({
      game,
      snapshot,
      names: gameNames(app.project, game, snapshot.active ? snapshot.level : 0),
      missing: gameMissing(game),
    });
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
