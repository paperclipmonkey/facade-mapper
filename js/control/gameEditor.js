/**
 * The game editor: the tree, and whatever you click on it.
 *
 * The diagram is the clearest picture of the game there is — every moment,
 * every press and where it goes — and it used to be only a picture. Here it is
 * the editor. Click a moment on it and the side shows everything about that
 * moment, in the order it happens:
 *
 *   1. **Words first** — lines said over whatever is already on the wall, each
 *      for a few seconds, before anything else happens. Like a dare: "SO… YOU
 *      DARE." and then the question; "YOU ASKED FOR IT…" and then the scare.
 *      Nobody presses anything; the game moves on by itself.
 *   2. **Then it shows** — the scene (or for a scare, the trigger), what is in
 *      it, and the words it puts on the wall, editable in place.
 *   3. **Then** — every way out of this moment: which press, or how long, and
 *      where it leads. Each one is a link to that moment, so the tree can be
 *      walked from here as well as clicked.
 *
 * It opens over the stage rather than living in the side panel, because the
 * tree is wide and is the point. The side panel keeps the buttons to play the
 * game and a button that opens this.
 */

import { el, clear } from './ui.js';
import { STATES, ROLE_LABELS, EVENT_LABELS, eventsFrom, sceneSlot, cueSlot, beatsFor, gameProblems } from '../core/game.js';
import { renderGameGraph, holdable } from '../core/gameGraph.js';
import { sceneContents, sceneMessage, setSceneMessage, gameNames, gameMissing } from './gamePanel.js';

let root = null;
let current = { state: 'attract', level: 1 };
let appRef = null;

const ZONE = {
  path: ['PATH', 'On the path, far enough back to read the wall.'],
  door: ['DOOR', 'At the door: too close to read anything on the house.'],
  street: ['STREET', 'Seen from the street, coming or going.'],
};

/** Every press or timer, as somebody would say it. */
const EVENT_WORDS = {
  yes: 'YES',
  no: 'NO',
  door: 'DOOR',
  treat: 'TREAT',
  both: 'YES and NO together',
  'long-no': 'NO held down',
};

export function isGameEditorOpen() {
  return !!root && !root.hidden;
}

export function openGameEditor(app, state = null, level = 1) {
  appRef = app;
  if (!root) build();
  if (state) current = { state, level };
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
  root = el('div', { class: 'geditor', hidden: true, role: 'dialog', 'aria-label': 'Game editor' });
  root.innerHTML = `
    <header class="geditor-head">
      <strong>Dare game</strong>
      <label class="glive-switch"><input type="checkbox" data-ge="on" /> <span>Game on</span></label>
      <span class="glive-status" data-ge="status"></span>
      <div class="glive-pad" data-ge="pad"></div>
      <button type="button" class="btn small" data-ge="rehearse"></button>
      <button type="button" class="btn small" data-ge="close" title="Close (Esc)">Close</button>
    </header>
    <div class="geditor-body">
      <div class="geditor-map">
        <div class="geditor-graph" data-ge="graph"></div>
        <p class="geditor-hint">Click any moment to edit it. Orange edges happen on the path, where words can be read; blue ones at the door, where they cannot.</p>
        <ul class="game-problems" data-ge="problems" hidden></ul>
      </div>
      <aside class="geditor-side" data-ge="side"></aside>
    </div>`;
  document.body.appendChild(root);

  const q = (name) => root.querySelector(`[data-ge="${name}"]`);
  q('close').addEventListener('click', closeGameEditor);
  q('on').addEventListener('change', (ev) => {
    appRef.project.game.enabled = ev.target.checked;
    if (!ev.target.checked) appRef.game.reset();
    appRef.commit();
  });
  q('rehearse').addEventListener('click', () => appRef.rehearse());
  q('graph').addEventListener('click', (ev) => {
    const node = ev.target.closest?.('[data-state]');
    if (!node) return;
    select(node.dataset.state, current.state === node.dataset.state ? current.level : 1);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && isGameEditorOpen() && !ev.target.closest?.('textarea, input, select')) closeGameEditor();
  });

  const pad = q('pad');
  for (const role of ['yes', 'no', 'door', 'treat']) {
    const button = el('button', { type: 'button', class: `btn game-btn game-${role}`, text: ROLE_LABELS[role], dataset: { role } });
    if (role === 'no') holdable(button, () => appRef.game.press({ button: 'no' }), () => appRef.game.press({ button: 'no', kind: 'long' }));
    else button.addEventListener('click', () => appRef.game.press({ button: role }));
    pad.appendChild(button);
  }
  pad.appendChild(el('button', { type: 'button', class: 'btn game-reset', text: '↺', title: 'Back to the start', onclick: () => appRef.game.reset() }));
}

function select(state, level = 1) {
  current = { state, level };
  refreshGameEditor();
}

/** Rebuild the side and repaint the tree. After an edit, or a change from elsewhere. */
export function refreshGameEditor() {
  if (!isGameEditorOpen()) return;
  renderSide();
  paintGameEditor();
}

/** The moving parts only: the tree, the status, the buttons. Cheap; safe while typing. */
export function paintGameEditor() {
  if (!isGameEditorOpen()) return;
  const app = appRef;
  const game = app.project.game;
  const snapshot = app.game.snapshot();
  const q = (name) => root.querySelector(`[data-ge="${name}"]`);

  q('on').checked = !!game.enabled;
  q('rehearse').textContent = app.rehearsing?.() ? '■ Stop rehearsing' : '▶ Rehearse';
  q('rehearse').classList.toggle('on', !!app.rehearsing?.());
  root.querySelector('[data-role="door"]').hidden = !game.door;

  const def = STATES[snapshot.state];
  const status = q('status');
  if (!game.enabled) status.textContent = 'Off — presses do nothing.';
  else if (!snapshot.active) status.textContent = 'Waiting for somebody to press a button.';
  else {
    let text = `${def.label}${def.levelled ? ` ${snapshot.level} of ${snapshot.of}` : ''}`;
    if (snapshot.saying) text += ` · saying “${snapshot.saying.text.replace(/\s*\n\s*/g, ' ')}”`;
    else if (snapshot.remaining !== null) text += ` · ${Math.ceil(snapshot.remaining)} s`;
    status.textContent = text;
  }
  status.classList.toggle('on', !!(game.enabled && snapshot.active));

  q('graph').innerHTML = renderGameGraph({
    game,
    snapshot,
    names: gameNames(app.project, game, snapshot.active ? snapshot.level : 0),
    missing: gameMissing(game),
    words: graphWords(app.project, game),
    notes: graphNotes(game),
    selected: current.state,
  });

  const problems = gameProblems(game, app.project);
  const list = q('problems');
  list.hidden = !problems.length;
  clear(list);
  for (const p of problems) list.appendChild(el('li', { text: p }));
}

/** Per state, the words it puts on the wall at level 1 — the tree's second line. */
export function graphWords(project, game) {
  const words = {};
  for (const state of Object.keys(STATES)) {
    const sceneId = STATES[state].cue ? project.triggers?.find((t) => t.id === cueSlot(game, state, 1))?.sceneId : sceneSlot(game, state, 1);
    const message = sceneId ? sceneMessage(project, sceneId) : null;
    if (message?.text) words[state] = message.text;
  }
  return words;
}

/** Per state, a note that it says something first. */
export function graphNotes(game) {
  const notes = {};
  for (const state of Object.keys(STATES)) {
    const levels = Math.max(1, STATES[state].levelled ? game.rungs.length : 1);
    let lines = 0;
    for (let l = 1; l <= levels; l++) lines += beatsFor(game, state, l).length;
    if (lines) notes[state] = `💬 words first (${lines})`;
  }
  return notes;
}

/* ------------------------------------------------------------------ *
 * The side: one moment
 * ------------------------------------------------------------------ */

function renderSide() {
  const app = appRef;
  const project = app.project;
  const game = project.game;
  const side = root.querySelector('[data-ge="side"]');
  // Keep the scroll where it was across a rebuild after an edit.
  const scroll = side.scrollTop;
  clear(side);

  const { state } = current;
  const def = STATES[state];
  const levels = def.levelled ? Math.max(1, game.rungs.length) : 1;
  const level = Math.min(Math.max(1, current.level), levels);
  current.level = level;
  const [zoneName, zoneHint] = ZONE[def.zone];

  const rebuild = () => {
    app.commit();
    refreshGameEditor();
  };

  side.appendChild(
    el('div', { class: `ge-title zone-${def.zone}` }, [
      el('h2', { text: def.label }),
      el('span', { class: 'gstep-zone', text: zoneName, title: zoneHint }),
    ])
  );
  side.appendChild(el('p', { class: 'ge-note', text: `${def.note}.` }));

  if (def.levelled) {
    const tabs = el('div', { class: 'ge-levels' });
    for (let l = 1; l <= levels; l++) {
      tabs.appendChild(
        el('button', {
          type: 'button',
          class: `chip${l === level ? ' on' : ''}`,
          text: state === 'scare' ? `Scare ${l}` : state === 'ask' ? `Question ${l}` : `After ${l - 1}`,
          onclick: () => select(state, l),
        })
      );
    }
    side.appendChild(tabs);
  }

  if (state === 'cooldown') {
    side.appendChild(el('p', { class: 'panel-note', text: 'The house goes back to what it was doing before the group arrived, and waits a moment before inviting the next one.' }));
  }

  /* --- 1. Words first --- */

  if (state !== 'attract' && state !== 'cooldown') {
    const section = el('section', { class: 'ge-section' }, [
      el('h3', { text: '1 · Words first' }),
      el('p', { class: 'ge-help', text: 'Said over whatever is already on the wall, one after another — then it moves on by itself. Nobody presses anything.' }),
    ]);
    const list = beatList(game, state, level);
    list.forEach((beat, i) => {
      const words = el('textarea', { class: 'gstep-words', rows: String(beat.text.split('\n').length + 1), spellcheck: 'false' });
      words.value = beat.text;
      words.addEventListener('focus', () => app.pushUndo());
      words.addEventListener('input', () => {
        beat.text = words.value;
        app.commitLive();
        paintGameEditor();
      });
      const seconds = el('input', { type: 'number', min: '0.5', max: '20', step: '0.1', title: 'How long this line stays up' });
      seconds.value = beat.seconds;
      seconds.addEventListener('change', () => {
        const v = Number(seconds.value);
        if (Number.isFinite(v) && v > 0) beat.seconds = v;
        app.commit();
      });
      section.appendChild(
        el('div', { class: 'ge-beat' }, [
          el('span', { class: 'ge-beat-n', text: String(i + 1) }),
          words,
          el('div', { class: 'ge-beat-tools' }, [
            seconds,
            el('span', { class: 'unit', text: 's' }),
            el('button', { type: 'button', class: 'icon-btn', title: 'Say it on the wall now', text: '▶', onclick: () => app.previewCaption(beat.text) }),
            el('button', {
              type: 'button',
              class: 'icon-btn',
              title: 'Remove this line',
              text: '✕',
              onclick: () => {
                app.pushUndo();
                list.splice(i, 1);
                rebuild();
              },
            }),
          ]),
        ])
      );
    });
    section.appendChild(
      el('button', {
        type: 'button',
        class: 'btn small',
        text: list.length ? '+ Another line' : '+ Say something first',
        onclick: () => {
          app.pushUndo();
          list.push({ text: list.length ? '' : defaultLine(state), seconds: 2.2 });
          rebuild();
        },
      })
    );
    if (def.zone === 'door' && list.length) {
      section.appendChild(el('div', { class: 'gstep-warn', text: 'They are at the door: words here will be too close to read.' }));
    }
    side.appendChild(section);
  }

  /* --- 2. Then it shows --- */

  const shows = el('section', { class: 'ge-section' }, [el('h3', { text: state === 'attract' ? 'It shows' : '2 · Then it shows' })]);
  if (def.cue) shows.appendChild(cueEditor(app, state, level, rebuild));
  else if (def.scene) shows.appendChild(sceneEditor(app, state, level, rebuild));
  else shows.appendChild(el('p', { class: 'ge-help', text: 'Nothing of its own.' }));
  side.appendChild(shows);

  /* --- 3. Then --- */

  side.appendChild(nextSection(app, state, level));

  side.scrollTop = scroll;
}

/** The beats list for a state and level, created if it is not there yet, so it can be edited in place. */
function beatList(game, state, level) {
  game.beats = game.beats || {};
  const levels = (game.beats[state] = game.beats[state] || []);
  const index = STATES[state].levelled ? level - 1 : 0;
  while (levels.length <= index) levels.push([]);
  return levels[index];
}

function defaultLine(state) {
  return { ask: 'SO…\nYOU DARE.', scare: 'YOU ASKED FOR IT…', reward: 'YOU MADE IT…', approach: 'ONE LAST THING…', chicken: 'OH WELL…' }[state] || '…';
}

function sceneEditor(app, state, level, rebuild) {
  const project = app.project;
  const game = project.game;
  const box = el('div');
  const key = STATES[state].scene;
  const slot = game.scenes[key];
  const own = Array.isArray(slot) ? slot[level - 1] || null : slot || null;
  const effective = sceneSlot(game, state, level);

  const select = el('select', {}, [
    el('option', { value: '', text: Array.isArray(slot) && level > 1 ? '— same as the one before —' : '— nothing —' }),
    ...(project.scenes || []).map((s) => el('option', { value: s.id, text: s.name })),
  ]);
  select.value = own || '';
  select.addEventListener('change', () => {
    app.pushUndo();
    const value = select.value || null;
    if (Array.isArray(game.scenes[key])) {
      while (game.scenes[key].length < level) game.scenes[key].push(null);
      game.scenes[key][level - 1] = value;
    } else {
      game.scenes[key] = value;
    }
    rebuild();
  });
  box.appendChild(
    el('div', { class: 'gstep-choose' }, [
      el('span', { text: 'Scene' }),
      select,
      el('button', { type: 'button', class: 'icon-btn gstep-play', title: 'Show it on the wall', text: '▶', disabled: !effective, onclick: () => app.previewScene(effective) }),
    ])
  );
  box.appendChild(contentsRow(project, effective));
  box.appendChild(wordsEditor(app, effective, STATES[state].zone));
  return box;
}

function cueEditor(app, state, level, rebuild) {
  const project = app.project;
  const game = project.game;
  const box = el('div');
  const id = cueSlot(game, state, level);
  const trigger = project.triggers?.find((t) => t.id === id) || null;

  const select = el('select', {}, [
    el('option', { value: '', text: '— nothing —' }),
    ...(project.triggers || []).map((t) => el('option', { value: t.id, text: t.name })),
  ]);
  select.value = trigger?.id || '';
  select.addEventListener('change', () => {
    app.pushUndo();
    const value = select.value || null;
    if (state === 'finale') game.finale = value;
    else if (value) game.rungs[level - 1] = value;
    else game.rungs.splice(level - 1, 1);
    rebuild();
  });
  box.appendChild(
    el('div', { class: 'gstep-choose' }, [
      el('span', { text: 'Scare' }),
      select,
      el('button', { type: 'button', class: 'icon-btn gstep-play', title: 'Play it on the wall', text: '▶', disabled: !trigger, onclick: () => app.fireTrigger(trigger.id) }),
    ])
  );
  if (trigger) {
    const hold = el('input', { type: 'number', min: '1', max: '60', step: '0.5' });
    hold.value = trigger.hold ?? 6;
    hold.addEventListener('change', () => {
      const v = Number(hold.value);
      if (Number.isFinite(v) && v > 0) trigger.hold = v;
      rebuild();
    });
    box.appendChild(el('div', { class: 'gstep-choose gstep-tools' }, [el('span', { text: 'Lasts' }), hold, el('span', { class: 'unit', text: 's' })]));
    box.appendChild(contentsRow(project, trigger.sceneId));
    box.appendChild(wordsEditor(app, trigger.sceneId, STATES[state].zone));
  }

  if (state === 'scare') {
    const ladder = el('div', { class: 'ge-ladder' }, [el('div', { class: 'ge-help', text: 'The ladder, mildest first:' })]);
    game.rungs.forEach((rungId, i) => {
      const t = project.triggers?.find((x) => x.id === rungId);
      const move = (delta) => {
        const j = i + delta;
        if (j < 0 || j >= game.rungs.length) return;
        app.pushUndo();
        [game.rungs[i], game.rungs[j]] = [game.rungs[j], game.rungs[i]];
        current.level = j + 1;
        rebuild();
      };
      ladder.appendChild(
        el('div', { class: `ge-rung${i === level - 1 ? ' on' : ''}` }, [
          el('button', { type: 'button', class: 'ge-rung-name', text: `${i + 1}. ${t?.name?.replace(/^Dare · /, '') || 'missing'}`, onclick: () => select('scare', i + 1) }),
          el('button', { type: 'button', class: 'icon-btn', text: '↑', title: 'Earlier', disabled: i === 0, onclick: () => move(-1) }),
          el('button', { type: 'button', class: 'icon-btn', text: '↓', title: 'Later', disabled: i === game.rungs.length - 1, onclick: () => move(1) }),
          el('button', {
            type: 'button',
            class: 'icon-btn',
            text: '✕',
            title: 'Take it out of the ladder',
            onclick: () => {
              app.pushUndo();
              game.rungs.splice(i, 1);
              current.level = Math.max(1, Math.min(current.level, game.rungs.length));
              rebuild();
            },
          }),
        ])
      );
    });
    const add = el('select', {}, [
      el('option', { value: '', text: '+ add a scare…' }),
      ...(project.triggers || []).map((t) => el('option', { value: t.id, text: t.name })),
    ]);
    add.addEventListener('change', () => {
      if (!add.value) return;
      app.pushUndo();
      game.rungs.push(add.value);
      current.level = game.rungs.length;
      rebuild();
    });
    ladder.appendChild(add);
    box.appendChild(ladder);
  }
  return box;
}

function contentsRow(project, sceneId) {
  const row = el('div', { class: 'gstep-what' });
  const names = sceneId ? sceneContents(project, sceneId) : [];
  if (!sceneId) row.appendChild(el('span', { class: 'chip warn', text: 'nothing chosen' }));
  for (const name of names) row.appendChild(el('span', { class: 'chip', text: name }));
  return row;
}

function wordsEditor(app, sceneId, zone) {
  const box = el('div');
  const message = sceneId ? sceneMessage(app.project, sceneId) : null;
  if (!message) {
    if (sceneId) box.appendChild(el('p', { class: 'ge-help', text: 'No words on the wall here.' }));
    return box;
  }
  const words = el('textarea', { class: 'gstep-words', rows: String(message.text.split('\n').length + 1), spellcheck: 'false', title: 'What the wall says. A new line is a new line.' });
  words.value = message.text;
  words.addEventListener('focus', () => app.pushUndo());
  words.addEventListener('input', () => {
    setSceneMessage(app.project, sceneId, message.layer.id, words.value);
    app.commitLive();
    paintGameEditor();
  });
  box.appendChild(el('div', { class: 'ge-help', text: 'And the wall says:' }));
  box.appendChild(words);
  if (zone === 'door') box.appendChild(el('div', { class: 'gstep-warn', text: 'They are at the door: these words will be too close to read.' }));
  return box;
}

/** Every way out of this moment, as links along the tree. */
function nextSection(app, state, level) {
  const game = app.project.game;
  const section = el('section', { class: 'ge-section' }, [el('h3', { text: state === 'attract' ? 'Then' : '3 · Then' })]);
  const list = el('ul', { class: 'ge-next' });
  const timing = game.timing || {};

  for (const [event, t] of eventsFrom(state, game, level)) {
    let when;
    if (event === 'timeout') {
      const key = STATES[state].timer;
      if (STATES[state].cue) when = 'When it ends';
      else if (key && Number(timing[key]) > 0) when = `After ${timing[key]} s with nothing pressed`;
      else continue;
    } else {
      when = `${EVENT_WORDS[event] || EVENT_LABELS[event] || event}`;
    }
    const nextLevel = t.do === 'start' ? 1 : t.do === 'next' ? level + 1 : level;
    const target = STATES[t.to];
    const label = `${target.label}${target.levelled ? ` ${nextLevel}` : ''}`;
    list.appendChild(
      el('li', {}, [
        el('span', { class: `ge-when ev-${event}`, text: when }),
        el('span', { class: 'ge-arrow', text: '→' }),
        el('button', { type: 'button', class: 'ge-to', text: label, onclick: () => select(t.to, nextLevel) }),
      ])
    );
  }
  if (!list.children.length) list.appendChild(el('li', { class: 'ge-help', text: 'Nothing leads on from here.' }));
  section.appendChild(list);

  // The timer that decides the "after N s" line, editable where it is read.
  const key = STATES[state].timer;
  if (key && state !== 'attract') {
    const input = el('input', { type: 'number', min: '0', step: '0.5' });
    input.value = timing[key];
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (!Number.isFinite(v) || v < 0) return;
      game.timing[key] = v;
      app.commit();
      refreshGameEditor();
    });
    section.appendChild(el('label', { class: 'gstep-choose gstep-tools' }, [el('span', { text: 'Wait' }), input, el('span', { class: 'unit', text: 's before moving on by itself' })]));
  }
  return section;
}

