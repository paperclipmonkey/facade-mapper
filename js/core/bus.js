/**
 * Cross-tab messaging.
 *
 * One control tab drives N projector tabs on the same machine. BroadcastChannel
 * gives us a same-origin bus with no server, which is what keeps this deployable
 * to GitHub Pages as plain static files. A localStorage-event fallback covers
 * browsers without BroadcastChannel.
 *
 * Timing note: every tab uses Date.now() as the shared clock. Tabs in one browser
 * on one machine read the same system clock, so "show time" needs no negotiation —
 * each tab computes `(Date.now() - showStartEpoch) / 1000` and lands on the same
 * frame without drift.
 */

const CHANNEL = 'facade-mapper';
const FALLBACK_KEY = 'facade-mapper/bus';

export const MSG = {
  /** Control -> all: the full project object changed. */
  PROJECT: 'project',
  /** Projector -> control: I exist, here's my size. */
  HELLO: 'hello',
  /** Control -> all: who's out there? */
  ROLL_CALL: 'roll-call',
  /** Projector -> control: I'm closing. */
  BYE: 'bye',
  /** Control -> all: transport state (running, showStart, bpm). */
  CLOCK: 'clock',
  /** Control -> all: audio band levels for reactive effects. */
  AUDIO: 'audio',
  /** Control -> one projector: display a calibration frame. */
  CALIB: 'calib',
  /** Projector -> control: the requested calibration frame is on screen. */
  CALIB_ACK: 'calib-ack',
  /** Control -> one/all: imperative actions (identify, fullscreen, reload). */
  COMMAND: 'command',
  /** Projector -> control: runtime error, so failures aren't invisible on a dark tab. */
  ERROR: 'error',
  /** Either way: a media blob was added/removed in IndexedDB. */
  MEDIA: 'media',
};

export function createBus(role = 'unknown') {
  const tabId = `${role}-${Math.random().toString(36).slice(2, 9)}`;
  const listeners = new Map();
  let channel = null;

  const dispatch = (msg) => {
    if (!msg || msg.from === tabId) return;
    const forType = listeners.get(msg.type);
    if (forType) for (const fn of forType) safeCall(fn, msg);
    const wildcard = listeners.get('*');
    if (wildcard) for (const fn of wildcard) safeCall(fn, msg);
  };

  const safeCall = (fn, msg) => {
    try {
      fn(msg.payload, msg);
    } catch (err) {
      console.error('[bus] handler failed for', msg.type, err);
    }
  };

  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (ev) => dispatch(ev.data);
  } else {
    window.addEventListener('storage', (ev) => {
      if (ev.key !== FALLBACK_KEY || !ev.newValue) return;
      try {
        dispatch(JSON.parse(ev.newValue));
      } catch {
        /* ignore malformed */
      }
    });
  }

  function post(type, payload, to = null) {
    const msg = { type, payload, from: tabId, to, at: Date.now() };
    if (channel) {
      channel.postMessage(msg);
    } else {
      try {
        // The value must differ each time or the storage event won't fire.
        localStorage.setItem(FALLBACK_KEY, JSON.stringify({ ...msg, n: Math.random() }));
      } catch (err) {
        console.warn('[bus] fallback post failed', err);
      }
    }
    return msg;
  }

  function on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
    return () => listeners.get(type)?.delete(fn);
  }

  /** Wait for a single matching message, with a timeout. */
  function once(type, predicate, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`Timed out waiting for "${type}"`));
      }, timeoutMs);
      const off = on(type, (payload, msg) => {
        if (predicate && !predicate(payload, msg)) return;
        clearTimeout(timer);
        off();
        resolve(payload);
      });
    });
  }

  function close() {
    channel?.close();
    listeners.clear();
  }

  return { tabId, post, on, once, close, role };
}

/**
 * Tracks which projector tabs are alive.
 *
 * Tabs announce themselves on open and say goodbye on unload, but a crashed or
 * force-closed tab does neither — so entries also expire if they stop
 * re-announcing. That keeps the control tab's projector list honest.
 */
export function createPresence(bus, { staleMs = 9000 } = {}) {
  const peers = new Map();
  const changeHandlers = new Set();

  const notify = () => {
    for (const fn of changeHandlers) fn(list());
  };

  const touch = (info) => {
    if (!info?.tabId) return;
    const existing = peers.get(info.tabId);
    const next = { ...existing, ...info, lastSeen: Date.now() };
    peers.set(info.tabId, next);
    // Anything the setup walkthrough shows has to be in here, or the checklist
    // sits on a stale answer until something else happens to trigger a redraw.
    const changed =
      !existing ||
      existing.projectorId !== next.projectorId ||
      existing.width !== next.width ||
      existing.height !== next.height ||
      existing.fullscreen !== next.fullscreen ||
      existing.screenX !== next.screenX ||
      existing.screenY !== next.screenY;
    if (changed) notify();
  };

  bus.on(MSG.HELLO, (payload) => touch(payload));
  bus.on(MSG.BYE, (payload) => {
    if (payload?.tabId && peers.delete(payload.tabId)) notify();
  });

  const sweep = setInterval(() => {
    const cutoff = Date.now() - staleMs;
    let dirty = false;
    for (const [id, p] of peers) {
      if (p.lastSeen < cutoff) {
        peers.delete(id);
        dirty = true;
      }
    }
    if (dirty) notify();
  }, 2000);

  function list() {
    return [...peers.values()];
  }

  function forProjector(projectorId) {
    return list().find((p) => p.projectorId === projectorId) || null;
  }

  return {
    list,
    forProjector,
    onChange(fn) {
      changeHandlers.add(fn);
      return () => changeHandlers.delete(fn);
    },
    rollCall: () => bus.post(MSG.ROLL_CALL, {}),
    dispose: () => clearInterval(sweep),
  };
}
