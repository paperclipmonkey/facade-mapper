/**
 * Show clock.
 *
 * All tabs derive show time from the same wall clock, so no tab has to ask
 * another what time it is. Pausing stores the elapsed time; resuming back-dates
 * the start epoch so the maths stays a single subtraction.
 *
 * The wall clock is `now()` from core/time.js rather than `Date.now()`, which
 * is the same number on one machine and the *link server's* number on a second
 * one. That is what lets a laptop in the garage and a laptop in the hall run
 * one show: they subtract the same start epoch from the same idea of now.
 */

import { now } from './time.js';

export function createClock() {
  let transport = {
    running: false,
    /** Wall-clock ms such that showTime = (now() - startEpoch) / 1000. */
    startEpoch: now(),
    /** Where the clock was frozen, in seconds. */
    pausedAt: 0,
    bpm: 120,
  };

  let lastT = 0;
  let lastFrameWall = performance.now();

  function timeNow() {
    return transport.running ? (now() - transport.startEpoch) / 1000 : transport.pausedAt;
  }

  /** Call once per rendered frame. Returns everything effects need about time. */
  function tick() {
    /**
     * One reading of the wall clock, used for both `t` and `wall`.
     *
     * They are two views of the same instant and consumers subtract one from the
     * other — that is how a switch-on time recorded on the wall clock becomes a
     * show time. Reading the clock twice put a millisecond of noise into that
     * difference, so the answer wobbled frame to frame instead of being a
     * constant, and anything comparing it against a stored value saw a change
     * every single frame.
     */
    const nowMs = now();
    const running = transport.running;
    const t = running ? (nowMs - transport.startEpoch) / 1000 : transport.pausedAt;
    const wallNow = performance.now();

    // dt comes from show time when running so it goes to zero on pause; but a
    // paused tab still repaints, and a zero dt there is exactly what we want.
    let dt = t - lastT;
    if (!isFinite(dt) || dt < 0) dt = 0;
    // Guard against a backgrounded tab returning with a huge dt and teleporting
    // every particle off screen.
    if (dt > 0.25) dt = 0.25;

    lastT = t;
    const frameDt = Math.min(0.25, Math.max(0, (wallNow - lastFrameWall) / 1000));
    lastFrameWall = wallNow;

    const beat = (t * transport.bpm) / 60;
    return {
      t,
      dt,
      /** Real elapsed time regardless of pause — for UI animation. */
      frameDt,
      running: transport.running,
      bpm: transport.bpm,
      beat,
      beatPhase: beat - Math.floor(beat),
      /**
       * The wall-clock instant that show time `t` *is* — which is the clock
       * now while the show is running, and the moment the clock was frozen
       * while it is paused.
       *
       * Not simply "now", which is what this used to be, and which was only
       * right by coincidence: the one consumer subtracts it from `t` to turn a
       * stored wall-clock stamp into a show time, and that subtraction is only
       * meaningful if the two describe the same instant. Paused they do not —
       * `t` stops and the clock does not — so the difference slid by a second
       * every second, and every switch-on time in the show slid with it. Fifty
       * milliseconds of slide was enough for the renderer to conclude that
       * every layer had just been switched on again, which it then did sixteen
       * times a second: measured, one paused layer restarted its simulation
       * eighty times in five seconds and ran fifty-nine thousand steps to do
       * it, while showing nothing at all on the wall.
       */
      wall: (running ? nowMs : transport.startEpoch + transport.pausedAt * 1000) / 1000,
    };
  }

  function setTransport(next) {
    transport = { ...transport, ...next };
    return getTransport();
  }

  function getTransport() {
    return { ...transport, t: timeNow() };
  }

  function play() {
    if (transport.running) return getTransport();
    transport.startEpoch = now() - transport.pausedAt * 1000;
    transport.running = true;
    return getTransport();
  }

  function pause() {
    if (!transport.running) return getTransport();
    transport.pausedAt = timeNow();
    transport.running = false;
    return getTransport();
  }

  function stop() {
    transport.running = false;
    transport.pausedAt = 0;
    transport.startEpoch = now();
    lastT = 0;
    return getTransport();
  }

  return { tick, setTransport, getTransport, play, pause, stop, timeNow };
}

export function formatTime(seconds) {
  const s = Math.max(0, seconds || 0);
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${String(m).padStart(2, '0')}:${rem.toFixed(1).padStart(4, '0')}`;
}
