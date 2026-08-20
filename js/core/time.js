/**
 * One clock for every device.
 *
 * Every tab in one browser reads the same system clock, so `Date.now()` is all
 * the show has ever needed: a projector tab computes
 * `(Date.now() - showStartEpoch) / 1000` and lands on the same frame as its
 * neighbours without anyone negotiating anything.
 *
 * A second laptop breaks that assumption. Two machines agree about the time to
 * within whatever their last NTP sync left them at, which on a laptop that has
 * been asleep in a shed is routinely a second or more — and a second is a very
 * long time when two projectors are painting the same wall. It is not drift you
 * can see as drift, either: it looks like one projector running a different
 * show.
 *
 * So a linked device stops reading its own clock directly and reads this one
 * instead: the local clock plus an offset onto the *link server's* clock, which
 * every device measures for itself. Unlinked, the offset is zero and this is
 * `Date.now()` with extra steps, which is exactly the point — nothing about the
 * single-machine case changes.
 *
 * Everything that crosses a tab boundary as a wall-clock stamp goes through
 * here: the transport's start epoch, scene change times, layer switch-ons. See
 * `showTimeOf` in the world renderer for what those stamps are eventually for.
 */

/** Milliseconds to add to `Date.now()` to get link time. */
let offset = 0;
/** Where `offset` is heading, when a correction is being eased in. */
let target = 0;
/** `Date.now()` at the last slew step, so the rate is per real second. */
let slewFrom = Date.now();

/** Diagnostics for the UI: how well we know the offset, and when we last checked. */
let quality = { synced: false, rtt: 0, samples: 0, at: 0 };

/**
 * How fast a correction is eased in, as a fraction of real time.
 *
 * A step correction is a jump in show time, which is a visible glitch — every
 * particle teleports. Below `STEP_THRESHOLD` the correction is slewed in at 5%
 * of real time instead: 500 ms of error disappears over ten seconds, slowly
 * enough that nothing on the wall reads as a jump. Above it, the clock is
 * simply wrong (a fresh connection, or the machine woke up and NTP moved it)
 * and easing in a two-second correction at 5% would take forty seconds of
 * running the wrong show.
 */
const SLEW_RATE = 0.05;
const STEP_THRESHOLD = 400;

/**
 * Link time in milliseconds.
 *
 * Advances the slew as a side effect, which is why it is a function rather than
 * a value. The step is proportional to elapsed real time, so it converges at
 * the same rate whether this is called once a second or a thousand times a
 * frame. `offset` never moves faster than real time, so the result stays
 * monotonic — a rewinding clock would restart every one-shot in the show.
 */
export function now() {
  const real = Date.now();
  if (offset !== target) {
    const elapsed = Math.max(0, real - slewFrom);
    const remaining = target - offset;
    const step = Math.sign(remaining) * Math.min(Math.abs(remaining), elapsed * SLEW_RATE);
    offset += step;
  }
  slewFrom = real;
  return real + offset;
}

/** The offset in force right now, in milliseconds. */
export function clockOffset() {
  return offset;
}

/** For the link indicator: are we synced, how far off, and how noisy was it. */
export function clockSync() {
  return { ...quality, offset, settling: offset !== target };
}

/**
 * Adopt a measured offset.
 *
 * The first one is stepped rather than slewed: it arrives within a second of
 * the page loading, before there is anything on the wall to glitch, and easing
 * a cold start in over a minute would mean a minute of the wrong show.
 */
export function setClockOffset(ms, { rtt = 0, samples = 0, step = false } = {}) {
  const next = Number.isFinite(ms) ? ms : 0;
  target = next;
  if (step || !quality.synced || Math.abs(next - offset) > STEP_THRESHOLD) {
    offset = next;
    slewFrom = Date.now();
  }
  quality = { synced: true, rtt, samples, at: Date.now() };
  return offset;
}

/** Go back to reading the local clock — the link dropped, or was switched off. */
export function resetClockOffset() {
  offset = 0;
  target = 0;
  slewFrom = Date.now();
  quality = { synced: false, rtt: 0, samples: 0, at: 0 };
}

/**
 * Turn a set of round trips into one offset, NTP-style.
 *
 * Each sample is a request sent at `t0`, stamped `ts` by the server, and
 * answered at `t1`, all read from the clock that took the reading. If the trip
 * were symmetric the server's clock at `t1` would read `ts + (t1 - t0) / 2`, so
 * the offset onto its clock is that minus `t1`.
 *
 * Wi-Fi makes that assumption false often enough to matter — a packet that sat
 * in a queue on the way back reports an offset skewed by half the delay it
 * suffered. Averaging spreads that error over every sample; taking the *fastest*
 * round trip discards it, because a fast trip has little room to be asymmetric.
 * So: filter to the trips close to the best one, then take their median, which
 * keeps a little averaging without letting one slow packet in.
 */
export function estimateOffset(samples) {
  const usable = (samples || [])
    .filter((s) => s && Number.isFinite(s.t0) && Number.isFinite(s.ts) && Number.isFinite(s.t1) && s.t1 >= s.t0)
    .map((s) => ({ rtt: s.t1 - s.t0, offset: s.ts + (s.t1 - s.t0) / 2 - s.t1 }));
  if (!usable.length) return null;

  usable.sort((a, b) => a.rtt - b.rtt);
  const best = usable[0].rtt;
  // 1.5x rather than a fixed millisecond figure: on a wired LAN "close to the
  // best" is a fraction of a millisecond, over Wi-Fi it is several, and a
  // constant would be wrong on one of them.
  const close = usable.filter((s) => s.rtt <= Math.max(best * 1.5, best + 1));
  const offsets = close.map((s) => s.offset).sort((a, b) => a - b);
  const mid = Math.floor(offsets.length / 2);
  const median = offsets.length % 2 ? offsets[mid] : (offsets[mid - 1] + offsets[mid]) / 2;

  return { offset: median, rtt: best, samples: close.length };
}
