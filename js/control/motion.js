/**
 * Motion detection from the camera.
 *
 * The point of this is trick-or-treaters: watch the path, and when someone
 * walks up it, fire a scare. The house stops being a loop and starts reacting.
 *
 * The hard part is that the camera is pointed at a building you are actively
 * projecting onto, so the brightest, fastest-changing thing in frame is your own
 * show. Three things keep that from triggering constantly:
 *
 *   1. You choose the watch region, and the sensible choice is ground the
 *      projectors don't reach — the path, the driveway, the gate.
 *   2. The background model adapts continuously, so anything that changes slowly
 *      or repeats becomes "normal" within a few seconds.
 *   3. A change covering almost the whole region is treated as the lights going
 *      on or off, not as a person, and re-baselines instead of firing.
 *
 * Detection is deliberately crude — no tracking, no classification. It answers
 * one question: has a decent-sized patch of this region changed in a way it
 * hasn't been changing lately?
 */

import { clamp } from '../core/math.js';

/** Sensitivity 0..1 mapped to the fraction of the region that must change. */
function activityThreshold(sensitivity) {
  const s = clamp(sensitivity ?? 0.5, 0, 1);
  // Deliberately non-linear: the useful range is all down at the low end, since
  // a person at the gate is a small part of the frame.
  return 0.11 * (1 - s) ** 2 + 0.004;
}

export function createMotionDetector({
  /** How fast the background forgets. Higher adapts quicker but misses slow movers. */
  adaptRate = 0.035,
  /** Per-pixel luma difference that counts as changed. */
  pixelThreshold = 16,
} = {}) {
  let background = null;
  let width = 0;
  let height = 0;
  /** Frames seen since the last re-baseline; the model is useless before it settles. */
  let warmup = 0;

  function reset() {
    background = null;
    warmup = 0;
  }

  /**
   * Feed a frame and measure activity inside a region.
   *
   * @param {Float32Array} luma      current frame
   * @param {number} w
   * @param {number} h
   * @param {{x,y,w,h}} region       normalised 0..1 rectangle to watch
   * @returns {{activity:number, ready:boolean, changed:number, total:number}}
   */
  function update(luma, w, h, region) {
    if (!background || width !== w || height !== h) {
      background = Float32Array.from(luma);
      width = w;
      height = h;
      warmup = 0;
      return { activity: 0, ready: false, changed: 0, total: 0 };
    }

    const x0 = Math.max(0, Math.floor((region?.x ?? 0) * w));
    const y0 = Math.max(0, Math.floor((region?.y ?? 0) * h));
    const x1 = Math.min(w, Math.ceil(((region?.x ?? 0) + (region?.w ?? 1)) * w));
    const y1 = Math.min(h, Math.ceil(((region?.y ?? 0) + (region?.h ?? 1)) * h));

    let changed = 0;
    let total = 0;

    for (let y = y0; y < y1; y++) {
      const row = y * w;
      for (let x = x0; x < x1; x++) {
        const i = row + x;
        if (Math.abs(luma[i] - background[i]) > pixelThreshold) changed++;
        total++;
      }
    }

    // The background adapts over the whole frame, not just the watched region,
    // so switching regions doesn't need a fresh warm-up.
    for (let i = 0; i < luma.length; i++) {
      background[i] += (luma[i] - background[i]) * adaptRate;
    }

    const activity = total > 0 ? changed / total : 0;

    // Near-total change is a light switch, a car's headlights sweeping past, or
    // the camera being knocked — none of which is somebody at the gate. Snap the
    // model to the new reality and sit out a few frames.
    if (activity > 0.85) {
      background = Float32Array.from(luma);
      warmup = 0;
      return { activity: 0, ready: false, changed, total };
    }

    warmup = Math.min(warmup + 1, 60);
    return { activity, ready: warmup >= 12, changed, total };
  }

  return { update, reset, get ready() { return warmup >= 12; } };
}

/**
 * Decides when a run of activity counts as a firing.
 *
 * Kept separate from the detector because one camera feeds every trigger, and
 * each trigger has its own region, sensitivity and cooldown.
 */
export function createMotionGate() {
  const state = new Map();

  /**
   * @returns {boolean} true on the frame the trigger should fire
   */
  function shouldFire(triggerId, activity, { sensitivity, cooldown = 20 }, now = Date.now()) {
    let s = state.get(triggerId);
    if (!s) {
      s = { streak: 0, lastFired: 0 };
      state.set(triggerId, s);
    }

    if (now - s.lastFired < cooldown * 1000) {
      s.streak = 0;
      return false;
    }

    // Two consecutive frames over threshold. One frame is sensor noise; two is
    // something that is actually there.
    if (activity >= activityThreshold(sensitivity)) {
      s.streak++;
      if (s.streak >= 2) {
        s.streak = 0;
        s.lastFired = now;
        return true;
      }
    } else {
      s.streak = 0;
    }
    return false;
  }

  function armedIn(triggerId, cooldown = 20, now = Date.now()) {
    const s = state.get(triggerId);
    if (!s?.lastFired) return 0;
    return Math.max(0, cooldown - (now - s.lastFired) / 1000);
  }

  function markFired(triggerId, now = Date.now()) {
    const s = state.get(triggerId) || { streak: 0, lastFired: 0 };
    s.lastFired = now;
    s.streak = 0;
    state.set(triggerId, s);
  }

  return { shouldFire, armedIn, markFired, forget: (id) => state.delete(id), threshold: activityThreshold };
}
