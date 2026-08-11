/**
 * Unattended on/off times.
 *
 * The practical problem this solves: you want the house lit from dusk until
 * bedtime, every night for a fortnight, without going out to the laptop twice a
 * day. Leave the tabs open and the schedule blacks the show out and brings it
 * back on its own.
 *
 * It drives the existing blackout flag rather than anything new, so a scheduled
 * "off" is exactly the same state as pressing B — the projectors stay awake and
 * aligned, they just stop emitting.
 */

/** Minutes since midnight for an "HH:MM" string, or null if unparseable. */
function parseTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

/**
 * Should the show be lit right now?
 *
 * @returns {boolean|null} null when the schedule is off or misconfigured, in
 *   which case the caller should leave blackout alone.
 */
export function scheduleWantsOn(schedule, now = new Date()) {
  if (!schedule?.enabled) return null;

  const on = parseTime(schedule.on);
  const off = parseTime(schedule.off);
  if (on === null || off === null || on === off) return null;

  const minutes = now.getHours() * 60 + now.getMinutes();
  const days = Array.isArray(schedule.days) && schedule.days.length ? schedule.days : [0, 1, 2, 3, 4, 5, 6];

  // A window that ends before it starts runs past midnight. In that case the
  // day-of-week test applies to the day the window *opened*, so a Friday
  // 18:00–01:00 slot is still running at half past midnight on Saturday.
  const overnight = off < on;
  const withinWindow = overnight ? minutes >= on || minutes < off : minutes >= on && minutes < off;
  if (!withinWindow) return false;

  const today = now.getDay();
  const openedYesterday = overnight && minutes < off;
  const relevantDay = openedYesterday ? (today + 6) % 7 : today;

  return days.includes(relevantDay);
}

/** Human-readable summary for the settings panel. */
export function describeSchedule(schedule) {
  if (!schedule?.enabled) return 'Off — the show runs whenever the tabs are open.';
  const on = parseTime(schedule.on);
  const off = parseTime(schedule.off);
  if (on === null || off === null) return 'Times must look like 18:00.';

  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = Array.isArray(schedule.days) ? schedule.days : [];
  const dayText =
    days.length === 7 || !days.length
      ? 'every day'
      : days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))
        ? 'weekdays'
        : days.length === 2 && [0, 6].every((d) => days.includes(d))
          ? 'weekends'
          : days.slice().sort().map((d) => names[d]).join(', ');

  const overnight = off < on;
  return `Lit ${schedule.on}–${schedule.off}${overnight ? ' (past midnight)' : ''}, ${dayText}.`;
}
