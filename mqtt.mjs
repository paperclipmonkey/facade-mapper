/**
 * The MQTT bridge: Home Assistant's buttons in, the dare game's state out.
 *
 * The house already has a broker, and Home Assistant already turns a Matter
 * button into an event it can publish. What it cannot do is reach a browser
 * tab, so this sits in the link server — the one process on the show machine
 * that stays up all evening whether or not a tab is hidden or reloaded — and
 * holds the broker connection for it.
 *
 * It decides nothing, like the rest of the server. A press comes in on
 * `<prefix>/press` and goes out on the link as the same `press` action the
 * remote's Game tab sends; the control tab's game runtime is what knows whether
 * it means anything. The game's state comes back the other way inside the
 * digest the control tab already publishes for remotes, and is republished on
 * `<prefix>/game` for Home Assistant to light buttons and run the fog from.
 *
 * Hand-written MQTT 3.1.1, for the same reason the WebSocket in server.mjs is:
 * a projection mapper you have to `npm install` on the night is one you do not
 * use on the night. It is the client half of the protocol and only the parts a
 * button needs — connect, subscribe, receive at QoS 0 or 1, publish at QoS 0,
 * keep alive, reconnect.
 *
 *   node server.mjs --mqtt mqtt://homeassistant.local:1883
 *   FACADE_MQTT_PASSWORD=… node server.mjs --mqtt mqtt://facade@homeassistant.local
 *
 * See docs/button-game.md for the Home Assistant side.
 */

import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

/* ------------------------------------------------------------------ *
 * Packets
 * ------------------------------------------------------------------ */

export const PACKET = {
  CONNECT: 1,
  CONNACK: 2,
  PUBLISH: 3,
  PUBACK: 4,
  PUBREC: 5,
  PUBREL: 6,
  PUBCOMP: 7,
  SUBSCRIBE: 8,
  SUBACK: 9,
  PINGREQ: 12,
  PINGRESP: 13,
  DISCONNECT: 14,
};

/** Nothing a button or a game state sends is anywhere near this. */
const MAX_PACKET = 256 * 1024;

/** MQTT's variable-length integer: seven bits a byte, high bit for "more". */
export function encodeLength(n) {
  const bytes = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    bytes.push(byte);
  } while (n > 0);
  return Buffer.from(bytes);
}

const str = (s) => {
  const body = Buffer.from(String(s), 'utf8');
  const head = Buffer.alloc(2);
  head.writeUInt16BE(body.length);
  return Buffer.concat([head, body]);
};

const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};

function packet(type, flags, body) {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), encodeLength(body.length), body]);
}

export function encodeConnect({ clientId, username, password, keepalive = 30, will = null }) {
  let flags = 0x02; // clean session: a reconnect must not be handed a backlog of presses
  const payload = [str(clientId)];
  if (will) {
    flags |= 0x04 | (will.retain ? 0x20 : 0);
    payload.push(str(will.topic), str(will.payload));
  }
  if (username) {
    flags |= 0x80;
    payload.push(str(username));
    if (password) {
      flags |= 0x40;
      payload.push(str(password));
    }
  }
  const header = Buffer.concat([str('MQTT'), Buffer.from([4, flags]), u16(keepalive)]);
  return packet(PACKET.CONNECT, 0, Buffer.concat([header, ...payload]));
}

export function encodePublish({ topic, payload, retain = false, qos = 0, id = 0 }) {
  const parts = [str(topic)];
  if (qos > 0) parts.push(u16(id));
  parts.push(Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8'));
  return packet(PACKET.PUBLISH, (qos << 1) | (retain ? 1 : 0), Buffer.concat(parts));
}

export function encodeSubscribe(id, filters) {
  const body = [u16(id)];
  for (const { topic, qos = 1 } of filters) body.push(str(topic), Buffer.from([qos]));
  return packet(PACKET.SUBSCRIBE, 0x02, Buffer.concat(body));
}

export const encodePuback = (id) => packet(PACKET.PUBACK, 0, u16(id));
export const encodePingreq = () => Buffer.from([PACKET.PINGREQ << 4, 0]);
export const encodeDisconnect = () => Buffer.from([PACKET.DISCONNECT << 4, 0]);

/**
 * Incremental packet reader.
 *
 * TCP delivers bytes, not packets: two presses can arrive in one chunk and one
 * state message can arrive in three. Complete packets come off the front of a
 * buffer; anything malformed or absurdly large is the end of the connection,
 * because a broker that sends either is not a broker worth staying on.
 */
export function createPacketReader(onPacket) {
  let buffer = Buffer.alloc(0);
  return function push(chunk) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    for (;;) {
      if (buffer.length < 2) return true;
      let length = 0;
      let multiplier = 1;
      let at = 1;
      for (;;) {
        if (at >= buffer.length) return true;
        if (at > 4) throw new Error('malformed remaining length');
        const byte = buffer[at++];
        length += (byte & 0x7f) * multiplier;
        multiplier *= 128;
        if (!(byte & 0x80)) break;
      }
      if (length > MAX_PACKET) throw new Error('packet too large');
      if (buffer.length < at + length) return true;
      const type = buffer[0] >> 4;
      const flags = buffer[0] & 0x0f;
      const body = Buffer.from(buffer.subarray(at, at + length));
      buffer = buffer.subarray(at + length);
      onPacket(decode(type, flags, body));
    }
  };
}

function decode(type, flags, body) {
  if (type === PACKET.PUBLISH) {
    const qos = (flags >> 1) & 3;
    const topicLength = body.readUInt16BE(0);
    const topic = body.subarray(2, 2 + topicLength).toString('utf8');
    let at = 2 + topicLength;
    let id = 0;
    if (qos > 0) {
      id = body.readUInt16BE(at);
      at += 2;
    }
    return { type, qos, retain: !!(flags & 1), dup: !!(flags & 8), topic, id, payload: body.subarray(at) };
  }
  if (type === PACKET.CONNACK) return { type, sessionPresent: !!(body[0] & 1), code: body[1] };
  if (type === PACKET.SUBACK) return { type, id: body.readUInt16BE(0), granted: [...body.subarray(2)] };
  if (type === PACKET.PUBACK || type === PACKET.PUBREC || type === PACKET.PUBCOMP) return { type, id: body.readUInt16BE(0) };
  return { type, body };
}

const CONNACK_REASONS = {
  1: 'the broker does not speak MQTT 3.1.1',
  2: 'the broker refused the client id',
  3: 'the broker is unavailable',
  4: 'the username or password is wrong',
  5: 'not authorised — check the user is allowed to connect',
};

/* ------------------------------------------------------------------ *
 * What a press looks like
 * ------------------------------------------------------------------ */

/**
 * Home Assistant's Matter event types, and what each is to the game.
 *
 * `initial_press` is the moment the button goes down, and the only one that
 * does not wait for the multi-press window to close. `long_press` is the same
 * button still down — mercy, on NO. Everything else describes a press that has
 * already been counted, and passing it on would count it twice.
 */
const KINDS = {
  initial_press: 'press',
  press: 'press',
  long_press: 'long',
  long: 'long',
};

/**
 * Turn one MQTT message into a press, or a reason it is not one.
 *
 * Two shapes, because there are two easy ways to write the automation:
 *
 * - `<prefix>/press` with JSON: `{ "button": "event.path_left", "kind":
 *   "initial_press", "id": "…", "at": 1730404800000 }`. What the documented
 *   automation sends.
 * - `<prefix>/press/<button>` with the kind as a bare word, or JSON without a
 *   button. For anyone wiring a button by hand in a dashboard or Node-RED.
 */
export function parsePress(topic, payload, prefix) {
  const base = `${prefix}/press`;
  if (topic !== base && !topic.startsWith(`${base}/`)) return { skip: 'not a press topic' };
  const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload ?? '');

  let data = {};
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      data = JSON.parse(trimmed);
    } catch {
      return { skip: 'payload is not valid JSON' };
    }
    if (!data || typeof data !== 'object') return { skip: 'payload is not an object' };
  } else if (trimmed) {
    data = { kind: trimmed };
  }

  const fromTopic = topic.length > base.length ? topic.slice(base.length + 1) : '';
  const button = String(data.button ?? data.entity_id ?? fromTopic ?? '').trim();
  if (!button) return { skip: 'no button named' };
  if (button.length > 200) return { skip: 'button name too long' };

  const rawKind = String(data.kind ?? data.event_type ?? 'initial_press');
  const kind = KINDS[rawKind];
  if (!kind) return { skip: `${rawKind} is not a press` };

  const id = data.id === undefined || data.id === null || data.id === '' ? null : String(data.id).slice(0, 120);
  const at = Number(data.at);
  return { press: { button, kind, id, at: Number.isFinite(at) && at > 0 ? at : null } };
}

/**
 * How old a press is, in the server's own time, whatever Home Assistant's
 * clock says.
 *
 * The game drops presses older than a couple of seconds, so that a reconnect
 * cannot replay a minute of them into a fresh game — but the stamp on a press
 * is Home Assistant's clock, and Home Assistant runs on a different machine.
 * Two seconds of disagreement would make every press look stale, or none.
 *
 * So the bridge learns the disagreement the way the link learns a device's: the
 * smallest gap between "pressed at" and "arrived at" over recent presses is the
 * clock difference plus the fastest delivery there is, and anything slower than
 * that by more than a little was held up somewhere. The press is restamped in
 * server time — the time every tab on the link already shares — so the game's
 * own rule works unchanged.
 */
export function createSkewEstimator({ window = 24 } = {}) {
  const gaps = [];
  return {
    /** Returns the press's `at` in server time. */
    restamp(at, arrived = Date.now()) {
      if (!Number.isFinite(at)) return arrived;
      const gap = arrived - at;
      gaps.push(gap);
      if (gaps.length > window) gaps.shift();
      const fastest = Math.min(...gaps);
      return arrived - Math.max(0, gap - fastest);
    },
    get skew() {
      return gaps.length ? Math.min(...gaps) : null;
    },
  };
}

/* ------------------------------------------------------------------ *
 * The game, for Home Assistant
 * ------------------------------------------------------------------ */

/**
 * Watch digests go by and say what changed.
 *
 * The control tab publishes a digest several times a second while anything is
 * happening, and Home Assistant wants to hear about the game twice: once as the
 * current state, retained, for dashboards and for button lights that connect
 * late; and once per move, not retained, for the fog machine. A digest that
 * changes nothing about the game produces neither.
 */
export function createGameWatcher() {
  let lastState = '';
  return function watch(game) {
    if (!game || typeof game !== 'object') return null;
    const snap = game.snapshot || {};
    const state = {
      enabled: !!game.enabled,
      state: String(snap.state || 'attract'),
      level: Number(snap.level) || 0,
      of: Number(snap.of) || 1,
      zone: String(snap.zone || ''),
      active: !!snap.active,
      door: !!game.door,
    };
    const key = JSON.stringify(state);
    if (key === lastState) return null;
    const previous = lastState ? JSON.parse(lastState) : null;
    lastState = key;
    const moved = previous && (previous.state !== state.state || previous.level !== state.level);
    const cue = moved
      ? {
          cue: state.state,
          level: state.level,
          from: previous.state,
          on: snap.last?.to === state.state ? String(snap.last.on || '') : '',
        }
      : null;
    return { state, cue };
  };
}

/* ------------------------------------------------------------------ *
 * The connection
 * ------------------------------------------------------------------ */

/**
 * Read `--mqtt` into connection options, or say what is wrong with it.
 *
 * The password may come from the URL, but it is better in the environment:
 * a URL on a command line is visible to anyone on the machine who lists
 * processes, and ends up in shell history.
 */
export function parseBrokerUrl(raw, env = process.env) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { error: `Not a broker address: ${raw}. It looks like mqtt://homeassistant.local:1883` };
  }
  if (url.protocol !== 'mqtt:' && url.protocol !== 'mqtts:') {
    return { error: `${url.protocol} is not MQTT — use mqtt:// or mqtts://` };
  }
  if (!url.hostname) return { error: `No host in ${raw}` };
  const secure = url.protocol === 'mqtts:';
  const port = url.port ? Number(url.port) : secure ? 8883 : 1883;
  return {
    host: url.hostname,
    port,
    secure,
    username: decodeURIComponent(url.username) || env.FACADE_MQTT_USERNAME || '',
    password: decodeURIComponent(url.password) || env.FACADE_MQTT_PASSWORD || '',
    /** For printing: never the password. */
    display: `${url.protocol}//${url.username ? `${decodeURIComponent(url.username)}@` : ''}${url.hostname}:${port}`,
  };
}

/**
 * Keep a broker connection up for as long as the server runs.
 *
 * @param {object} options
 * @param {object} options.broker  From `parseBrokerUrl`.
 * @param {string} [options.prefix]  Topic prefix, `facade` by default.
 * @param {(press) => number} options.onPress  Hand a press to the link; returns
 *   how many control tabs it reached.
 * @param {(message: string) => void} [options.log]
 */
export function createMqttBridge({
  broker,
  prefix = 'facade',
  onPress,
  log = () => {},
  keepalive = 30,
  retryMin = 1000,
  retryMax = 30000,
  connect = null,
} = {}) {
  const topics = {
    press: `${prefix}/press`,
    pressEach: `${prefix}/press/+`,
    game: `${prefix}/game`,
    cue: `${prefix}/game/cue`,
    bridge: `${prefix}/bridge`,
  };
  const clientId = `facade-mapper-${crypto.randomBytes(4).toString('hex')}`;
  const skew = createSkewEstimator();
  const watch = createGameWatcher();

  let socket = null;
  let connected = false;
  let stopped = false;
  let retryDelay = retryMin;
  let retryTimer = null;
  let pingTimer = null;
  let lastGame = null;
  let lastWarned = '';
  let nextId = 1;

  const status = { state: 'connecting', error: '', presses: 0, skipped: 0, lastPressAt: 0 };

  /** Say a thing once, not once per press. */
  const warn = (message) => {
    if (message === lastWarned) return;
    lastWarned = message;
    log(message);
  };

  function write(buffer) {
    if (socket && !socket.destroyed) socket.write(buffer);
  }

  function publish(topic, payload, { retain = false } = {}) {
    if (!connected) return false;
    write(encodePublish({ topic, payload: typeof payload === 'string' ? payload : JSON.stringify(payload), retain }));
    return true;
  }

  function open() {
    if (stopped) return;
    status.state = 'connecting';
    const options = { host: broker.host, port: broker.port };
    socket = connect
      ? connect(options)
      : broker.secure
        ? tls.connect({ ...options, servername: broker.host })
        : net.connect(options);
    const mine = socket;
    socket.setNoDelay?.(true);

    const read = createPacketReader((p) => handle(p));
    const hello = () =>
      write(
        encodeConnect({
          clientId,
          username: broker.username,
          password: broker.password,
          keepalive,
          // If this process dies without saying goodbye, the broker says it
          // for us — Home Assistant can show the buttons as not connected.
          will: { topic: topics.bridge, payload: 'offline', retain: true },
        })
      );
    // TLS is ready to write once its handshake is done, which is
    // `secureConnect`; its plain `connect` fires earlier, mid-handshake.
    socket.on(broker.secure && !connect ? 'secureConnect' : 'connect', hello);
    socket.on('data', (chunk) => {
      try {
        read(chunk);
      } catch (err) {
        fail(`broker sent something unreadable (${err.message})`);
      }
    });
    socket.on('error', (err) => {
      if (socket === mine) fail(err.code === 'ECONNREFUSED' ? `nothing listening at ${broker.display}` : err.message);
    });
    socket.on('close', () => {
      if (socket === mine) fail(status.error || 'connection closed');
    });
  }

  function handle(p) {
    if (p.type === PACKET.CONNACK) {
      if (p.code !== 0) {
        // A wrong password does not get better by retrying every second.
        retryDelay = retryMax;
        fail(`refused: ${CONNACK_REASONS[p.code] || `code ${p.code}`}`);
        return;
      }
      connected = true;
      retryDelay = retryMin;
      status.state = 'connected';
      status.error = '';
      lastWarned = '';
      log(`MQTT connected to ${broker.display} — listening on ${topics.press}`);
      write(encodeSubscribe(nextId++, [{ topic: topics.press, qos: 1 }, { topic: topics.pressEach, qos: 1 }]));
      publish(topics.bridge, 'online', { retain: true });
      if (lastGame) publish(topics.game, lastGame, { retain: true });
      clearInterval(pingTimer);
      pingTimer = setInterval(() => write(encodePingreq()), (keepalive * 1000) / 2);
      pingTimer.unref?.();
      return;
    }
    if (p.type === PACKET.PUBLISH) {
      if (p.qos === 1) write(encodePuback(p.id));
      receive(p);
    }
  }

  function receive(p) {
    // A retained press is a press from the past, handed to every subscriber
    // that ever connects. It would start a game on its own every time the
    // server restarted, so it is never a press.
    if (p.retain) {
      status.skipped++;
      warn(`Ignoring a retained message on ${p.topic} — presses must be published with retain: false.`);
      return;
    }
    const result = parsePress(p.topic, p.payload, prefix);
    if (result.skip) {
      status.skipped++;
      warn(`Ignoring a message on ${p.topic}: ${result.skip}.`);
      return;
    }
    const press = result.press;
    press.at = skew.restamp(press.at);
    status.presses++;
    status.lastPressAt = Date.now();
    const reached = onPress?.(press) ?? 0;
    if (!reached) warn('A button was pressed but no control tab is on the link to hear it. Is Facade Mapper open on this machine?');
  }

  function fail(why) {
    const wasConnected = connected;
    connected = false;
    clearInterval(pingTimer);
    status.state = stopped ? 'stopped' : 'waiting';
    status.error = why;
    if (socket && !socket.destroyed) socket.destroy();
    socket = null;
    if (stopped) return;
    warn(`MQTT ${wasConnected ? 'lost' : 'could not connect'}: ${why}. Trying again in ${Math.round(retryDelay / 1000)} s.`);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(open, retryDelay);
    retryTimer.unref?.();
    retryDelay = Math.min(retryMax, retryDelay * 2);
  }

  open();

  return {
    topics,
    status,
    get connected() {
      return connected;
    },
    get skew() {
      return skew.skew;
    },
    /** A digest went past on the link. Publish what changed about the game. */
    digest(game) {
      const change = watch(game);
      if (!change) return;
      lastGame = JSON.stringify(change.state);
      publish(topics.game, lastGame, { retain: true });
      if (change.cue) publish(topics.cue, change.cue);
    },
    close() {
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(pingTimer);
      if (connected) {
        // Say goodbye properly, so the will is not sent, and set the status by
        // hand instead.
        publish(topics.bridge, 'offline', { retain: true });
        write(encodeDisconnect());
      }
      connected = false;
      status.state = 'stopped';
      socket?.end();
      socket = null;
    },
  };
}
