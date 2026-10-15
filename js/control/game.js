/**
 * The dare game runtime.
 *
 * Walks the table in core/game.js. A press arrives — from a Matter button by
 * way of Home Assistant, from the remote, from the panel's test buttons, all
 * the same message — and is either dropped for a reason or turned into an
 * event that moves the game along. Time moves it too: questions time out,
 * scares end, the house resets itself for the next group.
 *
 * Only the control tab runs this, like the trigger runtime, and for the same
 * reason: one authority over what happens next. It touches nothing directly.
 * Everything it does to the show goes out through `io`, which is what lets the
 * tests drive a whole evening of visitors with a clock they move by hand.
 *
 * ── Presses are the hard part ──────────────────────────────────────────────
 *
 * Buttons on a path are pressed by groups, by mashing, by toddlers holding them
 * down, and twice by the same child because nothing seemed to happen. Each rule
 * in `press` is one of those, and each drops rather than queues: a queued press
 * answers a question nobody has read yet, and a group mashing YES would climb
 * from the first rung to the fourth without seeing the two in between.
 */

import { STATES, transitionFor, sceneSlot, cueSlot, roleOf, topLevel, beatsFor, slotIndex } from '../core/game.js';

/** Press ids remembered for de-duplication. A broker redelivers recent ones. */
const SEEN_LIMIT = 64;
/** Presses kept for the panel's log and for learning which button is which. */
const LOG_LIMIT = 16;
/** Guard against a chain of zero-length timers looping for ever. */
const MAX_HOPS = 8;

/**
 * @param {object} options
 * @param {() => object} options.getGame  The current game config. Read on every
 *   use, so an edit in the panel applies to the group already playing.
 * @param {object} options.io  What the game does to the show:
 *   - `scene(sceneId, { state, level })` put a scene up
 *   - `cue(triggerId, { state, level })` play a trigger; returns its hold in
 *     seconds, or null if it could not be played
 *   - `cueEnd(triggerId)` the trigger's hold is over (its `after` hook)
 *   - `caption(text | null)` say a line over whatever is up, or stop saying it
 *   - `release()` hand the stage back to whatever was on before the game
 *   - `changed(snapshot)` something moved; repaint and publish
 * @param {() => number} options.now  Local milliseconds, for every duration.
 * @param {() => number} options.stamp  Link milliseconds, which is what a press's
 *   `at` is written in; only used to decide that a press is stale.
 */
export function createGameRuntime({ getGame, io = {}, now = () => Date.now(), stamp } = {}) {
  const linkStamp = stamp || now;

  let state = 'attract';
  let level = 0;
  /** How many times the house has asked again after a NO. */
  let attempt = 0;
  let enteredAt = now();
  let deadline = null;
  /** The trigger a cue state is playing, so its `after` hook fires on the way out. */
  let playing = null;
  /** First answer inside the decision window, waiting to see if it has company. */
  let pending = null;
  /** The last transition taken, for the diagram to light up. */
  let last = null;
  /** Whether the game has put anything on the stage that needs handing back. */
  let holding = false;
  /**
   * Words first: the lines being said before this state shows what it shows,
   * and which one is up. Null once they are done, or when there are none.
   */
  let saying = null;

  const seen = [];
  const seenSet = new Set();
  const log = [];

  const game = () => getGame() || {};
  const timing = () => game().timing || {};
  const ms = (key, fallback = 0) => {
    const value = Number(timing()[key]);
    return Number.isFinite(value) ? Math.max(0, value) : fallback;
  };

  /* ------------------------------------------------------------------ *
   * Moving between states
   * ------------------------------------------------------------------ */

  function leave() {
    if (saying) {
      saying = null;
      io.caption?.(null);
    }
    if (playing) {
      io.cueEnd?.(playing);
      playing = null;
    }
    pending = null;
  }

  function enter(next) {
    state = next;
    enteredAt = now();
    deadline = null;

    if (next === 'attract' || next === 'cooldown') {
      if (holding) io.release?.();
      holding = false;
      if (next === 'attract') {
        level = 0;
        attempt = 0;
      }
    }

    /**
     * Words first. Like a dare — "SO… YOU DARE." and then the question, or
     * "YOU ASKED FOR IT…" and then the scare — the line is said over the
     * picture that is already up, held for its few seconds, and the game moves
     * on by itself. Nobody presses anything for it; presses during it are
     * dropped, the same as during a scare.
     */
    const lines = next === 'attract' || next === 'cooldown' ? [] : beatsFor(game(), next, slotIndex(next, level, attempt));
    if (lines.length) {
      saying = { lines, index: 0 };
      say();
      return;
    }
    show();
  }

  function say() {
    const line = saying.lines[saying.index];
    holding = true;
    io.caption?.(String(line.text));
    deadline = now() + Math.max(0.3, Number(line.seconds) || 2.5) * 1000;
  }

  /** The next line, or — after the last — what the state is actually for. */
  function sayNext() {
    saying.index += 1;
    if (saying.index < saying.lines.length) {
      say();
      return;
    }
    saying = null;
    io.caption?.(null);
    enteredAt = now();
    deadline = null;
    show();
  }

  /** Put up what this state shows, and start its clock. */
  function show() {
    const next = state;
    const def = STATES[next];
    const g = game();

    if (def.cue) {
      const id = cueSlot(g, next, level);
      const hold = id ? io.cue?.(id, { state: next, level }) : null;
      if (id && hold !== null && hold !== undefined) {
        playing = id;
        holding = true;
      }
      // A rung with nothing to play still takes time, so the ladder keeps its
      // rhythm and the next question does not land on top of the last one.
      const seconds = Number(hold) > 0 ? Number(hold) : ms('scareHold', 5);
      deadline = enteredAt + seconds * 1000;
      return;
    }

    const scene = sceneSlot(g, next, slotIndex(next, level, attempt));
    if (scene && next !== 'cooldown') {
      io.scene?.(scene, { state: next, level, attempt });
      // The attract prompt is the house's idle look, not the game holding the
      // stage — a playlist is free to move on from it.
      if (next !== 'attract') holding = true;
    }
    if (def.timer) {
      const seconds = ms(def.timer, 0);
      deadline = seconds > 0 ? enteredAt + seconds * 1000 : null;
    }
  }

  /** Take the transition `event` leads to from here, if there is one. */
  function dispatch(event) {
    const t = transitionFor(state, event, game(), level, attempt);
    if (!t) return null;
    const from = state;
    leave();
    for (const step of String(t.do || '').split('+')) {
      if (step === 'start') {
        level = 1;
        attempt = 0;
      }
      if (step === 'next') level += 1;
      if (step === 'plead') attempt += 1;
    }
    last = { from, on: event, to: t.to, at: now() };
    enter(t.to);
    return t;
  }

  /* ------------------------------------------------------------------ *
   * Presses
   * ------------------------------------------------------------------ */

  function remember(id) {
    seen.push(id);
    seenSet.add(id);
    while (seen.length > SEEN_LIMIT) seenSet.delete(seen.shift());
  }

  function record(entry) {
    log.unshift(entry);
    if (log.length > LOG_LIMIT) log.length = LOG_LIMIT;
  }

  /**
   * A button was pressed.
   *
   * @param {object} press
   * @param {string} press.button  A mapped button id, or a role name directly.
   * @param {'press'|'long'} [press.kind]  `long` is the button still held down
   *   after the press itself has already arrived — Matter's `long_press`.
   * @param {string} [press.id]  Unique per physical press, for de-duplication.
   * @param {number} [press.at]  When it was pressed, in link milliseconds.
   * @returns {string} What became of it, which is also what the log shows.
   */
  function press({ button, kind = 'press', id = null, at = null } = {}) {
    const g = game();
    const entry = { at: now(), button: String(button ?? ''), kind, role: null, result: '' };
    const finish = (result) => {
      entry.result = result;
      record(entry);
      io.changed?.(snapshot());
      return result;
    };

    if (!g.enabled) return finish('game off');

    // A broker at QoS 1 may deliver a press twice after a reconnect, and the
    // second copy would answer the *next* question.
    if (id !== null && id !== undefined && id !== '') {
      if (seenSet.has(id)) return finish('duplicate');
      remember(id);
    }

    // And a restarted bridge must not replay the last three minutes into a
    // fresh game.
    if (at !== null && at !== undefined && Number.isFinite(Number(at))) {
      if (linkStamp() - Number(at) > ms('staleMs', 2000)) return finish('stale');
    }

    const role = roleOf(g, button);
    entry.role = role;
    if (!role) return finish('unmapped');

    // A long press arrives *after* the press it belongs to, which has already
    // been acted on. Only NO means anything more for being held.
    const event = kind === 'long' ? (role === 'no' ? 'long-no' : null) : role;
    if (!event) return finish('held');

    if (!transitionFor(state, event, g, level, attempt)) return finish('not now');

    // TREAT is an adult who means it, once; it skips both windows, and the
    // words being said.
    if (saying && event !== 'treat') return finish('wait for the words');
    if (event === 'treat') {
      dispatch(event);
      return finish(`→ ${state}`);
    }

    if (STATES[state].armed && now() - enteredAt < ms('armMs', 400)) return finish('not armed');

    // The first answer opens a short window. If the other answer arrives in
    // it, two children disagreed, and the house says so rather than picking
    // whichever packet happened to win.
    const answers = event === 'yes' || event === 'no';
    const window = ms('windowMs', 150);
    if (answers && window > 0 && transitionFor(state, 'both', g, level, attempt)) {
      if (pending) {
        if (pending.event === event) return finish('same answer');
        pending = null;
        dispatch('both');
        return finish(`both → ${state}`);
      }
      pending = { event, until: now() + window };
      return finish('deciding');
    }

    dispatch(event);
    return finish(`→ ${state}`);
  }

  /* ------------------------------------------------------------------ *
   * Time
   * ------------------------------------------------------------------ */

  /**
   * Let time move the game. Cheap enough to call every frame; the control tab
   * also arms a timer for `nextDeadline`, because a hidden tab stops drawing
   * frames and a scare still has to end.
   */
  function tick() {
    let changed = false;
    if (pending && now() >= pending.until) {
      const { event } = pending;
      pending = null;
      if (dispatch(event)) changed = true;
    }
    for (let hop = 0; hop < MAX_HOPS && deadline !== null && now() >= deadline; hop++) {
      if (saying) {
        sayNext();
        changed = true;
        continue;
      }
      if (!dispatch('timeout')) {
        deadline = null;
        break;
      }
      changed = true;
    }
    if (changed) io.changed?.(snapshot());
    return changed;
  }

  /** Back to the start, from anywhere: the group walked off, or it went wrong. */
  function reset() {
    const from = state;
    leave();
    last = { from, on: 'reset', to: 'attract', at: now() };
    enter('attract');
    io.changed?.(snapshot());
  }

  function nextDeadline() {
    const times = [deadline, pending?.until].filter((t) => t !== null && t !== undefined);
    return times.length ? Math.min(...times) : null;
  }

  /** Everything the panel, the remote and the diagram need, and nothing live. */
  function snapshot() {
    const t = now();
    const next = nextDeadline();
    return {
      state,
      level,
      attempt,
      of: topLevel(game()),
      zone: STATES[state].zone,
      active: state !== 'attract',
      enabled: !!game().enabled,
      since: (t - enteredAt) / 1000,
      remaining: deadline !== null ? Math.max(0, (deadline - t) / 1000) : null,
      deciding: pending ? pending.event : null,
      saying: saying ? { text: String(saying.lines[saying.index].text), index: saying.index, of: saying.lines.length } : null,
      next: next !== null ? Math.max(0, next - t) : null,
      last: last ? { from: last.from, on: last.on, to: last.to, ago: (t - last.at) / 1000 } : null,
      log: log.map((e) => ({ ...e, ago: (t - e.at) / 1000 })),
    };
  }

  return {
    press,
    tick,
    reset,
    snapshot,
    nextDeadline,
    get state() {
      return state;
    },
    get level() {
      return level;
    },
    get attempt() {
      return attempt;
    },
    /** Playing, rather than idling in Attract: playlist and triggers stand aside. */
    get active() {
      return state !== 'attract';
    },
  };
}
