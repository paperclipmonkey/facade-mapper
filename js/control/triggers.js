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
 */

import { activateScene } from '../core/scenes.js';
import { createMotionGate } from './motion.js';

export function createTriggerRuntime({ app, sound, onFired } = {}) {
  const gate = createMotionGate();

  /** Scene to restore when the current hold expires, and when. */
  let holding = null;
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

    if (trigger.sceneId) activateScene(app.project, trigger.sceneId, { fade: 0.12 });

    if (trigger.sound) {
      sound?.play(trigger.sound, { volume: trigger.soundVolume ?? 1 });
    }

    const hold = Math.max(0, trigger.hold ?? 0);
    if (hold > 0) {
      holding = { until: Date.now() + hold * 1000, restoreTo, triggerId: trigger.id };
    } else {
      holding = null;
    }

    gate.markFired(trigger.id);
    if (!manual) scheduleTimer(trigger);
    onFired?.(trigger, { manual });
    return true;
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
   * Called once per frame from the control tab.
   *
   * @param {object} motionSample { activityFor(trigger) => number|null }
   */
  function tick(motionSample) {
    const now = Date.now();
    let changed = false;

    // Release an expired hold before evaluating anything new, so a trigger can
    // fire again the instant the previous one finishes.
    if (holding && now >= holding.until) {
      const scenes = scenesById();
      if (holding.restoreTo && scenes.has(holding.restoreTo)) {
        activateScene(app.project, holding.restoreTo, { fade: 0.8 });
      } else {
        // Nothing to go back to: clear the scene so authored layer state returns.
        const show = app.project.show || {};
        show.previousScene = show.activeScene ?? null;
        show.activeScene = null;
        show.sceneChangeAt = now;
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
  }

  return {
    tick,
    fire,
    fireByKey,
    cancelHold,
    gate,
    activityFor: (id) => activity.get(id) ?? 0,
    get holding() {
      return holding;
    },
  };
}
