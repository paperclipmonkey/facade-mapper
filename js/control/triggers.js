/**
 * Trigger runtime.
 *
 * A trigger jumps to a scene, optionally plays a sound, holds for a few seconds
 * and then puts back whatever was playing before. That "and then puts it back"
 * is what makes it a scare rather than a scene change — the ambient loop resumes
 * on its own and the next visitor gets the same surprise.
 *
 * Only the control tab runs this. It fires by activating a scene through the
 * normal path, which broadcasts like any other change, so the projector tabs
 * need no concept of triggers at all.
 *
 * Its own timing — cooldowns, holds, the next timer firing — is local to this
 * tab and stays on the local clock. The one number that leaves the machine is
 * the scene change stamp, which every tab reads, and that one is link time.
 */

import { activateScene, restoreScene } from '../core/scenes.js';
import { now as linkNow } from '../core/time.js';
import { createMotionGate } from './motion.js';
import { fireWebhook } from './webhooks.js';

export function createTriggerRuntime({ app, sound, onFired, onWebhook, onChange } = {}) {
  const gate = createMotionGate();

  /** Scene to restore when the current hold expires, and when. */
  let holding = null;
  /** Wake-up for the end of a hold. See `armWake`. */
  let wakeTimer = null;
  /** Next scheduled firing per timer trigger. */
  const timerNext = new Map();
  /** Latest measured activity per trigger, for the UI meters. */
  const activity = new Map();

  function scenesById() {
    return new Map((app.project.scenes || []).map((s) => [s.id, s]));
  }

  /**
   * Fire a trigger now.
   *
   * `manual` firings from the UI bypass the cooldown — if you press the button
   * you mean it — but still record the time so an immediately following motion
   * event doesn't double up.
   */
  function fire(trigger, { manual = false } = {}) {
    if (!trigger) return false;
    const scenes = scenesById();
    if (trigger.sceneId && !scenes.has(trigger.sceneId)) return false;

    const show = app.project.show || (app.project.show = {});

    // Remember what to go back to. If a hold is already running, keep the
    // original scene rather than nesting one scare inside another.
    const restoreTo = holding ? holding.restoreTo : show.activeScene ?? null;
    // And whether it was loaded: a scene somebody was editing comes back as
    // their edits, not as its stored values. See `restoreScene`.
    const restoreLoaded = holding ? holding.restoreLoaded : !!restoreTo && show.sceneLoaded === restoreTo;

    if (trigger.sceneId) activateScene(app.project, trigger.sceneId, { fade: 0.12 });

    if (trigger.sound) {
      sound?.play(trigger.sound, { volume: trigger.soundVolume ?? 1 });
    }

    /**
     * A hold this firing is cutting short.
     *
     * Its scene is superseded either way — that is what firing a second
     * trigger means — but its `after` hook is not about the scene. That hook
     * is what puts the *rest* of the house back: the gutter off red, the fog
     * machine off, the inflatable back on. Dropping the hold without it left
     * every one of those in the scare state for the remainder of the evening,
     * with nothing on screen to say so, because the moment that would have
     * fired it never arrives.
     *
     * Only for a different trigger. The same one firing again is a scare being
     * extended, and sending its own reset in the middle of that would be an
     * off and an on that nobody asked for.
     */
    const superseded =
      holding && holding.triggerId !== trigger.id
        ? (app.project.triggers || []).find((t) => t.id === holding.triggerId)
        : null;

    const hold = Math.max(0, trigger.hold ?? 0);
    if (hold > 0) {
      holding = { until: Date.now() + hold * 1000, restoreTo, restoreLoaded, triggerId: trigger.id };
      armWake(hold * 1000 + 60);
    } else {
      holding = null;
      clearTimeout(wakeTimer);
    }

    if (superseded) call(superseded, 'after');
    call(trigger, 'before');

    gate.markFired(trigger.id);
    if (!manual) scheduleTimer(trigger);
    onFired?.(trigger, { manual });
    return true;
  }

  /**
   * Play a trigger without holding or restoring: its scene, its sound and its
   * `before` hook, and back comes the hold it asked for.
   *
   * This is how the dare game plays a rung. A rung is a scare in every way but
   * one — when it ends, the house goes on to the next question, not back to
   * whatever was on before — so the game owns the timing and this owns
   * everything else, and a scare built as a trigger plays the same either way.
   *
   * @returns {number|null} The hold in seconds, or null if it could not play.
   */
  function cue(trigger) {
    if (!trigger) return null;
    if (trigger.sceneId && !scenesById().has(trigger.sceneId)) return null;
    if (!trigger.sceneId && !trigger.sound) return null;
    if (trigger.sceneId) activateScene(app.project, trigger.sceneId, { fade: 0.12 });
    if (trigger.sound) sound?.play(trigger.sound, { volume: trigger.soundVolume ?? 1 });
    call(trigger, 'before');
    return Math.max(0, trigger.hold ?? 0);
  }

  /** The other half of `cue`: the game has moved on, so put the house back. */
  function cueEnd(trigger) {
    call(trigger, 'after');
  }

  /**
   * Finish a hold now, without putting anything back.
   *
   * For the game starting in the middle of a scare: the scene is about to be
   * replaced anyway, but the scare's `after` hook is what turns the fog off,
   * and the restore must not land later on top of a question.
   */
  function endHold() {
    if (!holding) return;
    const trigger = (app.project.triggers || []).find((t) => t.id === holding.triggerId);
    holding = null;
    clearTimeout(wakeTimer);
    call(trigger, 'after');
  }

  /**
   * Fire one of a trigger's HTTP hooks.
   *
   * Deliberately not awaited. This runs in the middle of a scare, and a plug
   * that has been unplugged must not hold up the scene change by so much as a
   * frame — so the call is launched and the result reported whenever it turns
   * up. `fireWebhook` never rejects, so there is nothing here to catch.
   */
  function call(trigger, when) {
    const hook = trigger?.http?.[when];
    if (!hook?.url) return;
    fireWebhook(hook, { key: `${trigger.id}:${when}` }).then((result) => {
      if (!result.skipped) onWebhook?.(trigger, when, result);
    });
  }

  function scheduleTimer(trigger) {
    if (trigger.source !== 'timer') return;
    const every = Math.max(5, trigger.every ?? 180);
    const jitter = Math.max(0, Math.min(1, trigger.jitter ?? 0));
    // Spread firings around the interval so a timed scare doesn't become
    // predictable to anyone standing there for a while.
    const spread = every * jitter;
    const next = every - spread / 2 + Math.random() * spread;
    timerNext.set(trigger.id, Date.now() + next * 1000);
  }

  /**
   * Make sure the end of a hold happens even if nothing is drawing.
   *
   * `tick` is normally called once per frame, and a browser stops calling
   * `requestAnimationFrame` altogether in a tab that is not visible. That used
   * not to matter: nobody was looking. A phone in the garden changes it — you
   * fire a scare from the path with the control tab behind something on the
   * laptop, and without this the house stays mid-scare until somebody goes back
   * inside and clicks on the window. Timers are throttled in a hidden tab but
   * they do still run, which is all a six-second hold needs.
   */
  function armWake(ms) {
    clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => {
      if (tick()) onChange?.();
    }, ms);
  }

  /**
   * Called once per frame from the control tab.
   *
   * @param {object} motionSample { activityFor(trigger) => number|null }
   * @param {object} [options]
   * @param {boolean} [options.quiet]  Measure, but fire nothing — the dare game
   *   has the stage, and a timed lightning strike landing in the middle of
   *   "are you SURE?" is a question answered by nobody. Timers that come due
   *   are pushed on rather than saved up, so the game ending is not followed
   *   by every scare that was due during it.
   */
  function tick(motionSample, { quiet = false } = {}) {
    const now = Date.now();
    let changed = false;

    // Release an expired hold before evaluating anything new, so a trigger can
    // fire again the instant the previous one finishes.
    if (holding && now >= holding.until) {
      const scenes = scenesById();
      call((app.project.triggers || []).find((t) => t.id === holding.triggerId), 'after');
      if (holding.restoreTo && scenes.has(holding.restoreTo)) {
        restoreScene(app.project, holding.restoreTo, { fade: 0.8, wasLoaded: holding.restoreLoaded });
      } else {
        // Nothing to go back to: clear the scene so authored layer state returns.
        const show = app.project.show || {};
        show.previousScene = show.activeScene ?? null;
        show.activeScene = null;
        // Link time: every tab reads this stamp to work out how far through the
        // fade it is, including tabs on another machine.
        show.sceneChangeAt = linkNow();
        show.fade = 0.8;
      }
      holding = null;
      changed = true;
    }

    for (const trigger of app.project.triggers || []) {
      if (!trigger.enabled) continue;

      if (trigger.source === 'timer') {
        if (!timerNext.has(trigger.id)) {
          scheduleTimer(trigger);
          continue;
        }
        if (now >= timerNext.get(trigger.id)) {
          if (quiet) {
            scheduleTimer(trigger);
            continue;
          }
          // Reschedule whether or not it fired. `fire` returns false when the
          // scene has been deleted, and without this the due time stays in the
          // past — so a timer pointing at a missing scene re-enters `fire` on
          // every frame, for ever, building a scene map each time.
          if (fire(trigger)) changed = true;
          else scheduleTimer(trigger);
        }
        continue;
      }

      if (trigger.source === 'motion') {
        const level = motionSample?.activityFor?.(trigger);
        if (level === null || level === undefined) continue;
        activity.set(trigger.id, level);
        if (quiet) continue;
        if (gate.shouldFire(trigger.id, level, trigger, now)) {
          if (fire(trigger)) changed = true;
        }
      }
    }

    return changed;
  }

  /** Hotkeys are handled by the control tab's key handler, which calls this. */
  function fireByKey(key) {
    const trigger = (app.project.triggers || []).find(
      (t) => t.enabled && t.source === 'hotkey' && (t.key || '').toLowerCase() === key.toLowerCase()
    );
    if (!trigger) return false;
    return fire(trigger, { manual: true });
  }

  function cancelHold() {
    holding = null;
    clearTimeout(wakeTimer);
  }

  return {
    tick,
    fire,
    cue,
    cueEnd,
    endHold,
    fireByKey,
    cancelHold,
    gate,
    activityFor: (id) => activity.get(id) ?? 0,
    get holding() {
      return holding;
    },
  };
}
