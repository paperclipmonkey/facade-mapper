/**
 * Show clock.
 *
 * All tabs derive show time from the same wall clock, so no tab has to ask
 * another what time it is. Pausing stores the elapsed time; resuming back-dates
 * the start epoch so the maths stays a single subtraction.
 */

export function createClock() {
  let transport = {
    running: false,
    /** Wall-clock ms such that showTime = (Date.now() - startEpoch) / 1000. */
    startEpoch: Date.now(),
    /** Where the clock was frozen, in seconds. */
    pausedAt: 0,
    bpm: 120,
  };

  let lastT = 0;
  let lastFrameWall = performance.now();

  function timeNow() {
    return transport.running ? (Date.now() - transport.startEpoch) / 1000 : transport.pausedAt;
  }

  /** Call once per rendered frame. Returns everything effects need about time. */
  function tick() {
    const t = timeNow();
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
      wall: Date.now() / 1000,
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
    transport.startEpoch = Date.now() - transport.pausedAt * 1000;
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
    transport.startEpoch = Date.now();
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
