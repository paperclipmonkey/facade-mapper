/**
 * Cross-tab messaging.
 *
 * One control tab drives N projector tabs on the same machine. BroadcastChannel
 * gives us a same-origin bus with no server, which is what keeps this deployable
 * to GitHub Pages as plain static files. A localStorage-event fallback covers
 * browsers without BroadcastChannel.
 *
 * Timing note: every tab uses the clock in core/time.js. Tabs in one browser on
 * one machine read the same system clock, so "show time" needs no negotiation —
 * each tab computes `(now() - showStartEpoch) / 1000` and lands on the same
 * frame without drift.
 *
 * Off this machine, BroadcastChannel is the wrong shape entirely: it is
 * same-origin *and* same-browser. A second laptop or a phone joins by way of
 * core/link.js, which is a transport rather than a second bus — it mirrors what
 * this tab posts onto a WebSocket and feeds what arrives back in through
 * `receive`, so every handler below is written once and neither knows nor cares
 * which side of the wire a message came from.
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
  /** Control -> all: the depth scan was imported, re-placed or removed. */
  SCAN: 'scan',
  /**
   * Control -> remotes: a small digest of what the show is doing.
   *
   * The project itself is far too big to push at a phone several times a second
   * — it carries every shape, every parameter and the source of any custom
   * effect. A remote needs scene names and what is lit, which is a couple of
   * kilobytes. See `showDigest` in the control tab.
   */
  SHOW: 'show',
  /** Remote -> control: do something (go to a scene, black out, fire a trigger). */
  ACTION: 'action',
  /**
   * Drawing tablet -> everyone: ink.
   *
   * Small and incremental — a stroke beginning, a handful of points, a stroke
   * ending — rather than anything the size of a drawing. The strokes are show
   * state and never enter the project; see core/drawing.js for why.
   */
  DRAW: 'draw',
};

export function createBus(role = 'unknown') {
  const tabId = `${role}-${Math.random().toString(36).slice(2, 9)}`;
  const listeners = new Map();
  const mirrors = new Set();
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
    for (const fn of mirrors) {
      try {
        fn(msg);
      } catch (err) {
        console.warn('[bus] mirror failed for', type, err);
      }
    }
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

  /**
   * Watch everything this tab posts, so a transport can carry it off the machine.
   *
   * Only *posts* are mirrored, never messages arriving from elsewhere. A message
   * that came in over the link is not re-sent, and one that came in over
   * BroadcastChannel is already on the link courtesy of the tab that posted it —
   * which is what stops two linked tabs on one machine from echoing each other
   * round the network forever.
   */
  function mirror(fn) {
    mirrors.add(fn);
    return () => mirrors.delete(fn);
  }

  /** Deliver a message that arrived from off-machine, as though it were local. */
  function receive(msg) {
    dispatch(msg);
  }

  function close() {
    channel?.close();
    listeners.clear();
    mirrors.clear();
  }

  return { tabId, post, on, once, mirror, receive, close, role };
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
