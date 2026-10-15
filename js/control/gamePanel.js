/**
 * The Game panel: the dare game, told as the visit it is.
 *
 * The first version of this panel was the machine's settings in the machine's
 * order — a diagram, then a dropdown per state — and it was hard to use for the
 * reason that kind of panel always is: nobody thinks of a game as states. They
 * think of it as what happens to a group of children walking up the path. So
 * this is a timeline of that walk, a card for each moment in the order they
 * meet it, and everything about a moment is on its card:
 *
 * - what the house shows then, as the names of the effects in it;
 * - the **words**, editable right there, because rewording a question is the
 *   thing people most want to do and it used to mean finding a text layer,
 *   loading a scene, editing a parameter and saving the scene again;
 * - whether it happens on the path or at the door, because words at the door
 *   cannot be read and the card says so if there are any;
 * - **▶**, which puts that moment on the wall so it can be seen from outside.
 *
 * While a game is playing, the moment it is in lights up on the timeline, so
 * the same cards are the live view. The things that happen off the main line —
 * saying no, being scared, going quiet — are their own short list underneath,
 * and the buttons, the timings and the machine's diagram fold away below that.
 *
 * An empty game starts with one button that builds a complete example, because
 * a filled-in game explains itself and an empty one explains nothing.
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

const ZONE_LABEL = { path: 'PATH', door: 'DOOR', street: 'STREET' };
const ZONE_HINT = {
  path: 'They are on the path, far enough back to read the wall.',
  door: 'They are at the door — too close to read anything on the house.',
  street: 'Seen from the street, coming or going.',
};

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
 * The visit, as steps
 * ------------------------------------------------------------------ */

/**
 * Every moment of a visit, in order, and the ones off to the side.
 *
 * Each step says which state and level it is (so the live view can find it),
 * and where its content lives: a scene slot, or a trigger.
 */
export function visitSteps(game) {
  const levels = Math.max(1, game.rungs.length);
  const main = [
    { state: 'attract', title: 'Waiting for visitors', hint: 'Between groups: the dare that invites the first press.', slot: ['attract'] },
  ];
  for (let i = 1; i <= levels; i++) {
    main.push({
      state: 'ask',
      level: i,
      title: `Question ${i}`,
      hint: i === 1 ? 'Asked the moment somebody presses a button.' : 'Asked over everything they have seen so far.',
      slot: ['ask', i - 1],
      inherits: i > 1 ? `Question ${i - 1}` : null,
    });
    main.push({ state: 'scare', level: i, title: `Scare ${i}`, hint: 'Their YES, answered.', rung: i - 1 });
  }
  if (game.door) {
    main.push({ state: 'approach', title: 'Come to the door', hint: 'The last words they will read: an invitation up the path.', slot: ['approach'] });
  }
  main.push({
    state: 'finale',
    title: game.door ? 'At the door: the finale' : 'The finale',
    hint: game.door ? 'They pressed the door button. Sound and light — no words.' : 'The top of the ladder, where they stand.',
    finale: true,
  });
  main.push({ state: 'waiting', title: 'Waiting for a treat', hint: 'The door opens. If nobody presses TREAT the reward plays anyway.', slot: ['waiting'] });
  main.push({ state: 'reward', title: 'Reward', hint: 'Read on the walk back down the path.', slot: ['reward'] });

  const side = [];
  for (let i = 1; i <= levels; i++) {
    side.push({
      state: 'chicken',
      level: i,
      title: `Said NO at question ${i}`,
      hint: i === 1 ? 'Before anything happened.' : `After ${i - 1} scare${i === 2 ? '' : 's'}.`,
      slot: ['chicken', i - 1],
      inherits: i > 1 ? `Said NO at question ${i - 1}` : null,
    });
  }
  side.push({ state: 'mercy', title: 'Held NO down during a scare', hint: 'Somebody is frightened. Stop at once, kindly.', slot: ['mercy'] });
  side.push({ state: 'nudge', title: 'Went quiet', hint: 'Nobody answered the question.', slot: ['nudge'] });
  side.push({ state: 'decide', title: 'Pressed YES and NO together', hint: 'Two children disagreed — the house picks YES.', slot: ['decide'] });
  side.push({ state: 'early', title: 'Ran straight to the door', hint: 'Before playing. Send them back to the path.', slot: ['early'] });
  return { main, side };
}

/* ------------------------------------------------------------------ *
 * The panel
 * ------------------------------------------------------------------ */

/**
 * Build the panel. `app.game` is the runtime's face (press, reset, snapshot);
 * `app.previewScene`, `app.fireTrigger` and `app.buildExampleGame` do the rest.
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
  if (empty) {
    node.appendChild(starterCard(app));
  }

  const problems = gameProblems(game, project);
  if (problems.length && !empty) {
    node.appendChild(el('ul', { class: 'game-problems' }, problems.map((p) => el('li', { text: p }))));
  }

  /* --- The visit --- */

  const { main, side } = visitSteps(game);
  const timeline = el('ol', { class: 'gtl' });
  main.forEach((step, i) => {
    timeline.appendChild(stepCard(app, step, i + 1, commit));
    // The ladder's own controls sit after its last scare.
    if (step.state === 'scare' && step.level === Math.max(1, game.rungs.length)) {
      timeline.appendChild(addScareRow(app, commit));
    }
  });
  node.append(el('h3', { class: 'panel-heading', text: 'The visit' }), timeline);

  node.append(el('h3', { class: 'panel-heading', text: 'If they…' }));
  const branches = el('ol', { class: 'gtl gtl-side' });
  for (const step of side) branches.appendChild(stepCard(app, step, null, commit));
  node.appendChild(branches);

  /* --- Folded away --- */

  node.appendChild(fold('setup', 'How it ends, and the buttons', open, (body) => buttonsSection(app, body, commit)));
  node.appendChild(fold('timing', 'Timing', open, (body) => timingSection(app, body)));
  node.appendChild(
    fold('flow', 'The whole thing as a diagram', open, (body) => {
      const graph = el('div', { class: 'game-graph', id: 'gameGraph', title: 'Click a state to find its card' });
      graph.addEventListener('click', (ev) => {
        const target = ev.target.closest?.('[data-state]');
        if (!target) return;
        const card = node.querySelector(`.gstep[data-state="${target.dataset.state}"]`);
        if (!card) return;
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.remove('flash');
        void card.offsetWidth;
        card.classList.add('flash');
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
      body.append(el('div', { class: 'panel-actions' }, [enlarge]), graph);
    })
  );
  node.appendChild(fold('log', 'Recent presses', open, (body) => body.appendChild(el('div', { class: 'game-log', id: 'gameLog' }))));

  if (hasExampleGame(project)) {
    node.appendChild(
      el('div', { class: 'panel-actions gtl-footer' }, [
        el('button', {
          type: 'button',
          class: 'btn small',
          text: 'Rebuild the example',
          title: 'Throw away the example game’s scenes and scares, and build them again as new',
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
        'A complete game built from your tagged shapes. The house waits with just <em>brick and smoke</em>; ' +
        'each YES adds a horror and keeps it — <em>blood down the door</em>, then <em>people at the windows</em>, ' +
        'then <em>tentacles through the brick</em> — and the door button sets off everything at once. ' +
        'Every question, send-off and reward is filled in, ready to reword.',
    }),
    el('button', { type: 'button', class: 'btn primary', text: 'Build the example game', onclick: () => app.buildExampleGame() }),
  ]);
}

/** One moment of the visit. */
function stepCard(app, step, number, commit) {
  const project = app.project;
  const game = project.game;
  const def = STATES[step.state];
  const zone = def.zone;

  const card = el('li', {
    class: `gstep zone-${zone}`,
    dataset: { state: step.state, ...(step.level ? { level: String(step.level) } : {}) },
  });

  let sceneId = null;
  let trigger = null;
  if (step.slot) {
    const [key, index] = step.slot;
    const value = game.scenes[key];
    sceneId = Array.isArray(value) ? value[index] || null : value || null;
  } else if (step.rung !== undefined) {
    trigger = triggerOf(project, game.rungs[step.rung]);
    sceneId = trigger?.sceneId || null;
  } else if (step.finale) {
    trigger = triggerOf(project, game.finale);
    sceneId = trigger?.sceneId || null;
  }
  // A blank per-level slot shows the one before it, and says so.
  const effective = step.slot ? sceneSlot(game, step.state, step.level || 1) : sceneId;

  const preview = el('button', {
    type: 'button',
    class: 'icon-btn gstep-play',
    title: trigger ? 'Play this scare on the wall' : 'Show this on the wall',
    text: '▶',
    disabled: !(trigger || effective),
    onclick: () => (trigger ? app.fireTrigger(trigger.id) : app.previewScene(effective)),
  });

  card.appendChild(
    el('div', { class: 'gstep-head' }, [
      number ? el('span', { class: 'gstep-num', text: String(number) }) : el('span', { class: 'gstep-num side', text: '↳' }),
      el('span', { class: 'gstep-title', text: step.title }),
      el('span', { class: 'gstep-zone', text: ZONE_LABEL[zone], title: ZONE_HINT[zone] }),
      preview,
    ])
  );
  card.appendChild(el('div', { class: 'gstep-hint', text: step.hint }));

  // What the house is doing.
  const contents = effective ? sceneContents(project, effective) : [];
  const what = el('div', { class: 'gstep-what' });
  if (!effective && !trigger) {
    what.appendChild(el('span', { class: 'chip warn', text: 'nothing chosen' }));
  } else if (trigger && !trigger.sceneId) {
    what.appendChild(el('span', { class: 'chip', text: trigger.sound ? 'a sound only' : 'nothing to play' }));
  } else {
    for (const name of contents) what.appendChild(el('span', { class: 'chip', text: name }));
    if (!sceneId && step.inherits) what.appendChild(el('span', { class: 'gstep-same', text: `same as ${step.inherits}` }));
  }
  card.appendChild(what);

  // The words, editable in place — for the scene this step actually uses.
  const message = effective && (sceneId || !step.inherits) ? sceneMessage(project, effective) : null;
  if (message) {
    // Sized to its content where the browser can (field-sizing), and given
    // room for a wrapped line where it cannot.
    const words = el('textarea', { class: 'gstep-words', rows: String(Math.min(4, message.text.split('\n').length + 1)), spellcheck: 'false', title: 'What the wall says. A new line here is a new line there.' });
    words.value = message.text;
    // Saved and broadcast as you type. Deliberately no full commit when it
    // loses focus: that rebuilds the panel, and the click that took the focus
    // away would land on a button that no longer exists.
    words.addEventListener('focus', () => app.pushUndo());
    words.addEventListener('input', () => {
      setSceneMessage(project, effective, message.layer.id, words.value);
      app.commitLive();
    });
    card.appendChild(words);
    if (zone === 'door') {
      card.appendChild(el('div', { class: 'gstep-warn', text: 'They are at the door: these words will be too close to read.' }));
    }
  }

  // Choosing what it is.
  const choose = el('div', { class: 'gstep-choose' });
  if (step.slot) {
    const [key, index] = step.slot;
    const select = el('select', { title: 'Which scene this moment shows' }, [
      el('option', { value: '', text: step.inherits ? `— same as ${step.inherits} —` : '— nothing —' }),
      ...(project.scenes || []).map((s) => el('option', { value: s.id, text: s.name })),
    ]);
    select.value = sceneId || '';
    select.addEventListener('change', () => {
      const value = select.value || null;
      if (Array.isArray(game.scenes[key])) {
        while (game.scenes[key].length <= index) game.scenes[key].push(null);
        game.scenes[key][index] = value;
      } else {
        game.scenes[key] = value;
      }
      commit();
    });
    choose.append(el('span', { text: 'Scene' }), select);
  } else {
    const select = el('select', { title: 'Which trigger plays here' }, [
      el('option', { value: '', text: '— nothing —' }),
      ...(project.triggers || []).map((t) => el('option', { value: t.id, text: t.name })),
    ]);
    select.value = trigger?.id || '';
    select.addEventListener('change', () => {
      const value = select.value || null;
      if (step.finale) game.finale = value;
      else if (value) game.rungs[step.rung] = value;
      else game.rungs.splice(step.rung, 1);
      commit();
    });
    choose.append(el('span', { text: 'Scare' }), select);
    card.appendChild(choose);

    // How long it lasts, and where it sits on the ladder: a row of its own, so
    // the name of the scare keeps the whole width above it.
    const tools = el('div', { class: 'gstep-choose gstep-tools' });
    if (trigger) {
      const hold = el('input', { type: 'number', min: '1', max: '60', step: '0.5', title: 'How long it lasts, in seconds' });
      hold.value = trigger.hold ?? 6;
      hold.addEventListener('change', () => {
        const value = Number(hold.value);
        if (!Number.isFinite(value) || value <= 0) return;
        trigger.hold = value;
        app.commit();
      });
      tools.append(el('span', { text: 'Lasts' }), hold, el('span', { class: 'unit', text: 's' }));
    }
    if (step.rung !== undefined && game.rungs.length) {
      const move = (delta) => {
        const i = step.rung;
        const j = i + delta;
        if (j < 0 || j >= game.rungs.length) return;
        [game.rungs[i], game.rungs[j]] = [game.rungs[j], game.rungs[i]];
        commit();
      };
      tools.append(
        el('span', { class: 'gstep-spacer' }),
        el('button', { type: 'button', class: 'icon-btn', title: 'Earlier in the ladder', text: '↑', disabled: step.rung === 0, onclick: () => move(-1) }),
        el('button', { type: 'button', class: 'icon-btn', title: 'Later in the ladder', text: '↓', disabled: step.rung >= game.rungs.length - 1, onclick: () => move(1) }),
        el('button', {
          type: 'button',
          class: 'icon-btn',
          title: 'Take this scare out of the ladder',
          text: '✕',
          onclick: () => {
            game.rungs.splice(step.rung, 1);
            commit();
          },
        })
      );
    }
    if (tools.childNodes.length) card.appendChild(tools);
    return card;
  }
  card.appendChild(choose);
  return card;
}

/** "Add a scare", at the end of the ladder. */
function addScareRow(app, commit) {
  const project = app.project;
  const select = el('select', {}, [
    el('option', { value: '', text: project.triggers?.length ? '+ add a scare…' : '+ make a trigger first' }),
    ...(project.triggers || []).map((t) => el('option', { value: t.id, text: t.name })),
  ]);
  select.addEventListener('change', () => {
    if (!select.value) return;
    project.game.rungs.push(select.value);
    commit();
  });
  return el('li', { class: 'gstep-add' }, [select]);
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
      if (snapshot.remaining !== null) text += ` · ${Math.ceil(snapshot.remaining)} s`;
      if (snapshot.deciding) text += ' · listening for the other button…';
    }
    status.textContent = text;
    status.classList.toggle('on', playing);
  }

  // Light the card for the moment the game is in.
  for (const card of node.querySelectorAll('.gstep')) {
    const sameState = card.dataset.state === snapshot.state;
    const sameLevel = !card.dataset.level || Number(card.dataset.level) === snapshot.level ||
      // A level beyond the cards written falls on the last one.
      (sameState && !node.querySelector(`.gstep[data-state="${snapshot.state}"][data-level="${snapshot.level}"]`) &&
        card === [...node.querySelectorAll(`.gstep[data-state="${snapshot.state}"]`)].at(-1));
    const live = !!(game.enabled && sameState && sameLevel && (snapshot.active || snapshot.state === 'attract'));
    // During a rehearsal nobody is editing, so the timeline follows the game.
    if (live && !card.classList.contains('live') && app.rehearsing?.()) {
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    card.classList.toggle('live', live);
  }

  const graph = node.querySelector('#gameGraph');
  if (graph && graph.closest('details')?.open) {
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
