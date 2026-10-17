/**
 * The automation runtime.
 *
 * Walks the steps in the project. A press arrives — from a Matter button by
 * way of Home Assistant, from the remote, from the panel's buttons, all the
 * same message — and is either dropped for a reason or moves the show to the
 * step that button leads to. A step's timer moves it on too.
 *
 * Only the control tab runs this: one authority over what happens next. It
 * touches nothing directly. Everything it does to the show goes out through
 * `io`, which is what lets the tests drive a whole evening with a clock they
 * move by hand.
 *
 * ── Presses are the hard part ──────────────────────────────────────────────
 *
 * Buttons on a path are pressed by groups, by mashing, by toddlers holding them
 * down, and twice by the same child because nothing seemed to happen. Each rule
 * in `press` is one of those, and each drops rather than queues: a queued press
 * answers a question nobody has read yet.
 */

import { stepById, startStep, nextFor, roleOf, timerSeconds } from '../core/game.js';

/** Press ids remembered for de-duplication. A broker redelivers recent ones. */
const SEEN_LIMIT = 64;
/** Presses kept for the panel's log and for learning which button is which. */
const LOG_LIMIT = 16;
/** Guard against a chain of timers looping for ever within one tick. */
const MAX_HOPS = 16;

/**
 * @param {object} options
 * @param {() => object} options.getGame  The current automation. Read on every
 *   use, so an edit in the panel applies to the group already there.
 * @param {object} options.io  What the automation does to the show:
 *   - `scene(sceneId, step)` put a scene up
 *   - `caption(text | null)` write words over whatever is up, or stop
 *   - `sound(mediaId, step)` play a sound
 *   - `changed(snapshot)` something moved; repaint and publish
 * @param {() => number} options.now  Local milliseconds, for every duration.
 * @param {() => number} options.stamp  Link milliseconds, which is what a press's
 *   `at` is written in; only used to decide that a press is stale.
 */
export function createGameRuntime({ getGame, io = {}, now = () => Date.now(), stamp } = {}) {
  const linkStamp = stamp || now;

  /** The step the show is on, by id. Null until there are steps. */
  let current = null;
  let enteredAt = now();
  let deadline = null;
  /** The last move made, for the diagram to light up. */
  let last = null;

  const seen = [];
  const seenSet = new Set();
  const log = [];

  const game = () => getGame() || {};
  const ms = (key, fallback = 0) => {
    const value = Number(game().timing?.[key]);
    return Number.isFinite(value) ? Math.max(0, value) : fallback;
  };

  /** The step the show is on, falling back to the start if that one has gone. */
  function step() {
    return stepById(game(), current) || startStep(game());
  }

  /**
   * Put up what a step shows, and start its clock — from `at`, which for a
   * timer is when it was due rather than when it was noticed, so a tab that
   * missed a few seconds catches up through every timer it slept through.
   */
  function enter(next, at = now()) {
    current = next?.id ?? null;
    enteredAt = at;
    deadline = null;
    if (!next) return;
    if (next.sceneId) io.scene?.(next.sceneId, next);
    io.caption?.(String(next.words || '').trim() ? String(next.words) : null);
    if (next.sound) io.sound?.(next.sound, next);
    const seconds = timerSeconds(next);
    if (seconds) deadline = enteredAt + seconds * 1000;
  }

  /** Follow `event` out of the current step, if it leads anywhere. */
  function move(event, at = now()) {
    const g = game();
    const from = step();
    const to = nextFor(g, from, event);
    if (!to) return false;
    last = { from: from.id, on: event, to, at };
    enter(stepById(g, to), at);
    return true;
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
   *   after the press itself arrived; the press has already counted.
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

    if (!g.enabled) return finish('off');

    // A broker at QoS 1 may deliver a press twice after a reconnect, and the
    // second copy would answer the *next* question.
    if (id !== null && id !== undefined && id !== '') {
      if (seenSet.has(id)) return finish('duplicate');
      remember(id);
    }

    // And a restarted bridge must not replay the last three minutes into a
    // fresh show.
    if (at !== null && at !== undefined && Number.isFinite(Number(at))) {
      if (linkStamp() - Number(at) > ms('staleMs', 2000)) return finish('stale');
    }

    const role = roleOf(g, button);
    entry.role = role;
    if (!role) return finish('unmapped');
    // Held down: the press it belongs to has already been acted on.
    if (kind === 'long') return finish('held');

    if (!nextFor(g, step(), role)) return finish('not now');

    // The thumb still on YES from the last question must not answer this one.
    if (now() - enteredAt < ms('armMs', 400)) return finish('too soon');

    // The first answer wins. Two children pressing at once is one of them
    // being a little quicker, and the house answers whichever it heard.
    move(role);
    return finish(`→ ${step()?.name || ''}`);
  }

  /* ------------------------------------------------------------------ *
   * Time
   * ------------------------------------------------------------------ */

  /**
   * Let time move the show on. Cheap enough to call every frame; the control
   * tab also arms a timer for `nextDeadline`, because a hidden tab stops
   * drawing frames and a step still has to end.
   */
  function tick() {
    let changed = false;
    for (let hop = 0; hop < MAX_HOPS && deadline !== null && now() >= deadline; hop++) {
      if (!move('timeout', deadline)) {
        deadline = null;
        break;
      }
      changed = true;
    }
    if (changed) io.changed?.(snapshot());
    return changed;
  }

  /**
   * Back to the start, from anywhere: the group walked off, or it went wrong.
   * Switched off, it only takes its words down and leaves the house alone.
   */
  function reset() {
    const from = current;
    const start = startStep(game());
    last = start ? { from, on: 'reset', to: start.id, at: now() } : null;
    if (game().enabled) {
      enter(start);
    } else {
      current = start?.id ?? null;
      enteredAt = now();
      deadline = null;
      io.caption?.(null);
    }
    io.changed?.(snapshot());
  }

  function nextDeadline() {
    return deadline;
  }

  /** Everything the panel, the remote and the diagram need, and nothing live. */
  function snapshot() {
    const t = now();
    const g = game();
    const here = step();
    const start = startStep(g);
    return {
      enabled: !!g.enabled,
      step: here?.id ?? null,
      name: here?.name ?? '',
      words: here?.words ?? '',
      alert: !!here?.alert,
      atStart: !here || here === start,
      since: (t - enteredAt) / 1000,
      remaining: deadline !== null ? Math.max(0, (deadline - t) / 1000) : null,
      next: deadline !== null ? Math.max(0, deadline - t) : null,
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
    /** The step the show is on, by id. */
    get step() {
      return step()?.id ?? null;
    },
    /** Away from the start step: the playlist stands aside. */
    get active() {
      const here = step();
      return !!here && here !== startStep(game());
    },
  };
}
