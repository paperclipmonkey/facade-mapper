/**
 * The link: this tab, on the network.
 *
 * BroadcastChannel ends at the edge of the browser. Everything past that edge —
 * a phone in your pocket at the end of the path, a second laptop driving the
 * projectors round the side of the house — needs the same messages carried over
 * a wire, and that is all this is. It is a *transport*, not a second bus: it
 * mirrors what this tab posts onto a WebSocket, and feeds what arrives back in
 * through `bus.receive`. No handler anywhere in the app knows which side of the
 * wire a message came from, which is the property worth having.
 *
 * Three things make it more than a pipe:
 *
 * **It asks first.** Published to GitHub Pages there is no server to link to,
 * and a tab that spends the evening retrying a socket that will never exist is
 * a tab wasting battery. So it probes `/link/info` once and stays quiet unless
 * something answers.
 *
 * **It syncs the clock.** Two machines disagree about the time by however long
 * it has been since either last checked, and show time is a subtraction from a
 * shared wall clock. Without this the second laptop paints a different frame of
 * the same animation, which on overlapping projectors is not subtle. See
 * core/time.js.
 *
 * **It subscribes.** A phone asks for the two small message types it can act
 * on. The full project — every shape, every parameter, the source of every
 * custom effect — never goes near it.
 */

import { now, setClockOffset, estimateOffset, clockSync } from './time.js';

const DEVICE_KEY = 'facade-mapper/device';
const SECRET_KEY = 'facade-mapper/link-key';

/** Same list as the server's: state-of-the-world messages, safe to drop when behind. */
const DROPPABLE = new Set(['project', 'show', 'audio', 'clock']);

/** Stop queueing droppable messages once this much is already waiting to go out. */
const BACKLOG_LIMIT = 256 * 1024;

/** Round trips kept for the offset estimate. At one every 15s, about two minutes. */
const SAMPLE_WINDOW = 8;

/**
 * This browser profile's identity on the link.
 *
 * Not a machine id and not trying to be. Its one job is letting the server skip
 * sending a message back to the tabs it already reached over BroadcastChannel,
 * so opening four projector tabs on the control machine does not put four
 * copies of every project broadcast on the network.
 */
export function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = `dev_${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    // Private browsing with storage denied. A per-session id still works; it
    // just costs a little duplicate traffic if two tabs are open.
    return `dev_${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * The key, if the server was started with one.
 *
 * Remembered so that a phone bookmarking `/remote.html?key=…` still joins after
 * a reload, and so the key does not have to stay in the address bar of a device
 * somebody else might pick up.
 */
function linkSecret() {
  const fromUrl = new URLSearchParams(location.search).get('key');
  try {
    if (fromUrl) localStorage.setItem(SECRET_KEY, fromUrl);
    return fromUrl || localStorage.getItem(SECRET_KEY) || '';
  } catch {
    return fromUrl || '';
  }
}

export function createLink(bus, { role = 'unknown', subscribe = null, label = '', onStatus } = {}) {
  const device = deviceId();
  const secret = linkSecret();
  /** What this device currently asks the server for. Widened and narrowed at
   *  runtime by `setSubscribe`; see it for why. */
  let subs = subscribe;

  let socket = null;
  let unmirror = null;
  let closed = false;
  let attempt = 0;
  let reconnectTimer = null;
  let pingTimer = null;
  let burstTimer = null;
  let samples = [];

  const state = {
    /** 'off' | 'checking' | 'unavailable' | 'connecting' | 'linked' */
    status: 'checking',
    server: '',
    /** What the server calls this connection, so we can leave ourselves out of the peer list. */
    id: '',
    peers: [],
    device,
    /** Every address the server can be reached on, for showing to a phone. */
    addresses: [],
    needsKey: false,
    key: secret,
    error: '',
    sync: clockSync(),
  };

  const publish = () => {
    state.sync = clockSync();
    onStatus?.({ ...state, peers: [...state.peers] });
  };

  const wsUrl = () => {
    const url = new URL('/link', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('role', role);
    url.searchParams.set('device', device);
    if (label) url.searchParams.set('label', label);
    if (secret) url.searchParams.set('key', secret);
    return url.toString();
  };

  const send = (payload) => {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    if (DROPPABLE.has(payload?.type) && socket.bufferedAmount > BACKLOG_LIMIT) return false;
    socket.send(JSON.stringify(payload));
    return true;
  };

  /* --- Clock ------------------------------------------------------- */

  const ping = () => send({ type: 'link/ping', t0: Date.now() });

  const onPong = (msg) => {
    const t1 = Date.now();
    if (!Number.isFinite(msg.t0) || !Number.isFinite(msg.ts)) return;
    samples.push({ t0: msg.t0, ts: msg.ts, t1 });
    if (samples.length > SAMPLE_WINDOW) samples.shift();
    const estimate = estimateOffset(samples);
    if (!estimate) return;
    setClockOffset(estimate.offset, { rtt: estimate.rtt, samples: estimate.samples });
    publish();
  };

  /**
   * Measure hard for the first second, then keep an eye on it.
   *
   * A burst at the start is what gets the show onto the right clock before it
   * matters; after that, the pair of crystals are drifting apart at parts per
   * million and once every fifteen seconds is more than enough to follow it.
   */
  const startSync = () => {
    samples = [];
    let burst = 0;
    stopSync();
    ping();
    burstTimer = setInterval(() => {
      ping();
      if (++burst >= 4) {
        clearInterval(burstTimer);
        burstTimer = null;
        pingTimer = setInterval(ping, 15000);
      }
    }, 250);
  };

  const stopSync = () => {
    clearInterval(pingTimer);
    clearInterval(burstTimer);
    pingTimer = null;
    burstTimer = null;
  };

  /* --- Connection -------------------------------------------------- */

  const connect = () => {
    if (closed) return;
    state.status = 'connecting';
    publish();

    let ws;
    try {
      ws = new WebSocket(wsUrl());
    } catch (err) {
      state.error = err.message;
      return retry();
    }
    socket = ws;

    ws.addEventListener('open', () => {
      attempt = 0;
      state.status = 'linked';
      state.error = '';
      publish();
      send({ type: 'link/hello', role, device, label, subscribe: subs });
      startSync();
      // Everything this tab says from here on goes out as well as round the
      // browser. Only posts, never messages that arrived from elsewhere — see
      // `mirror` in core/bus.js for why that matters.
      unmirror?.();
      unmirror = bus.mirror((msg) => send({ ...msg, device }));
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;

      switch (msg.type) {
        case 'link/welcome':
          state.server = msg.name || '';
          state.id = msg.id || '';
          publish();
          return;
        case 'link/peers':
          // By connection id rather than by device: two projector tabs on this
          // machine are two devices as far as anyone counting screens cares,
          // and only one of them is us.
          state.peers = (msg.peers || []).filter((p) => p.id !== state.id);
          publish();
          return;
        case 'link/pong':
          onPong(msg);
          return;
        default:
          break;
      }

      // Our own tabs are reached over BroadcastChannel; anything the server
      // sends us from this device is a copy of something we already have. The
      // server filters these too — this is the half that still works when two
      // browsers on one machine share a profile-less device id.
      if (msg.device && msg.device === device) return;
      bus.receive(msg);
    });

    const dropped = () => {
      unmirror?.();
      unmirror = null;
      stopSync();
      if (socket === ws) socket = null;
      retry();
    };
    ws.addEventListener('close', dropped);
    ws.addEventListener('error', () => {
      state.error = 'connection failed';
    });
  };

  /**
   * Reconnect, backing off.
   *
   * The offset is deliberately *not* reset here. A dropped link is usually wifi
   * blinking, and the last measured offset is still the best guess going — far
   * better than snapping back to this machine's own clock and jumping the show
   * a second sideways in front of everyone.
   */
  const retry = () => {
    if (closed) return;
    state.status = 'connecting';
    publish();
    clearTimeout(reconnectTimer);
    const wait = Math.min(15000, 500 * 2 ** Math.min(attempt++, 5));
    reconnectTimer = setTimeout(connect, wait);
  };

  /* --- Is there a server at all? ----------------------------------- */

  const probe = async () => {
    try {
      const response = await fetch(new URL('/link/info', location.href), { cache: 'no-store' });
      if (!response.ok) throw new Error(String(response.status));
      const info = await response.json();
      if (info.service !== 'facade-mapper-link') throw new Error('not a link server');
      state.server = info.name || '';
      state.needsKey = !!info.needsKey;
      state.addresses = Array.isArray(info.addresses) ? info.addresses : [];
      connect();
    } catch {
      // A plain static host: GitHub Pages, python -m http.server, a file:// URL.
      // Nothing is wrong, there is simply nothing to join.
      state.status = 'unavailable';
      publish();
    }
  };

  if (typeof WebSocket === 'undefined' || new URLSearchParams(location.search).get('link') === 'off') {
    state.status = 'off';
    queueMicrotask(publish);
  } else {
    probe();
  }

  return {
    get status() {
      return state.status;
    },
    state: () => ({ ...state, peers: [...state.peers], addresses: [...state.addresses], sync: clockSync() }),
    /** Post to the link only, bypassing BroadcastChannel. Used for keepalives. */
    send,
    /**
     * Change what this device asks the server to send it, while connected.
     *
     * The subscription is a bandwidth decision, and on a phone it is the
     * difference between a page that works on one bar and one that does not:
     * the project is a few hundred kilobytes and is broadcast a dozen times a
     * second while somebody drags a slider, and a remote has no use for it.
     *
     * A page that can *also* draw does have a use for it — but only while
     * somebody is drawing, because that is when it needs the shapes. So rather
     * than choosing once at startup between a cheap remote and a capable one,
     * it asks for more when the drawing surface opens and less when it closes.
     * The server keeps one subscription per connection and replaces it on
     * every hello, so re-announcing is the whole mechanism.
     *
     * A no-op when nothing changed, so this is safe to call on every open.
     */
    setSubscribe(next) {
      const before = subs ? [...subs].sort().join(',') : '*';
      const after = next ? [...next].sort().join(',') : '*';
      if (before === after) return false;
      subs = next;
      if (state.status === 'linked') send({ type: 'link/hello', role, device, label, subscribe: subs });
      return true;
    },
    now,
    close() {
      closed = true;
      clearTimeout(reconnectTimer);
      stopSync();
      unmirror?.();
      socket?.close();
      socket = null;
      state.status = 'off';
      publish();
    },
  };
}
