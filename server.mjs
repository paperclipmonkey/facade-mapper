#!/usr/bin/env node
/**
 * The link server.
 *
 * Facade Mapper is a static app: one browser, one BroadcastChannel, no server,
 * which is what lets it live on GitHub Pages and keep working with the wifi
 * off. This is the one thing that cannot be done that way — putting a *second
 * device* on the same show. A phone in your pocket while you stand at the end
 * of the path, or a second laptop driving the projectors on the other side of
 * the house, are on the far side of a network from the tab holding the project.
 *
 * So: a static file server, so a phone can load the app at all, and a WebSocket
 * relay, so the messages that already move between tabs can move between
 * machines as well. Deliberately not an application server. It has no idea what
 * a scene is, never parses a project, and stores nothing — it forwards frames
 * and answers the question "what time do you make it?". Everything that decides
 * anything stays in the browser, which is where the show is.
 *
 * No dependencies, because the rest of the project has none, and a projection
 * mapper you have to `npm install` on the night is a projection mapper you do
 * not use on the night.
 *
 *   node server.mjs                # http://localhost:8000, link on
 *   node server.mjs --port 9000
 *   node server.mjs --key back-gate  # require ?key=back-gate to join the link
 *
 * Run it from the repository root.
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ *
 * Static files
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Turn a request path into a file inside the served root, or null.
 *
 * The null cases are the whole point: `/../../.ssh/id_rsa` has to come back as
 * "no such page" rather than as a key. Decoding first and resolving afterwards
 * is what makes `%2e%2e%2f` fail too, and the final `startsWith` is the check
 * that actually holds — everything before it is just getting to a real path to
 * check.
 */
export function resolveStaticPath(urlPath, root = ROOT) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  if (decoded.endsWith('/')) decoded += 'index.html';
  // Nothing the app loads starts with a dot, and this folder is a git
  // checkout — `/.git/config` is a list of somewhere to push to, served to
  // whoever else is on the wifi.
  if (decoded.split('/').some((part) => part.startsWith('.') && part !== '.' && part !== '..')) return null;

  const resolved = path.resolve(root, `.${path.posix.normalize(decoded)}`);
  const base = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(base)) return null;
  return resolved;
}

async function serveStatic(req, res, root) {
  const file = resolveStaticPath(req.url || '/', root);
  if (!file) return send(res, 403, 'Forbidden');

  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return send(res, 404, `Not found: ${req.url}`);
  }
  if (stat.isDirectory()) {
    const index = path.join(file, 'index.html');
    try {
      await fsp.stat(index);
      return streamFile(req, res, index);
    } catch {
      return send(res, 404, 'Not found');
    }
  }
  return streamFile(req, res, file);
}

function streamFile(req, res, file) {
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    // The whole appeal of no build step is editing a file and reloading. A
    // cached module in a projector tab you cannot see the address bar of is a
    // horrible way to spend twenty minutes.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  return stream.pipe(res);
}

/**
 * The URL of a request, or null if it is not one.
 *
 * `new URL` throws on a request target it cannot make sense of, and there are
 * two of those a stranger can send from a terminal: `GET //`, which reads as a
 * protocol-relative URL with no host, and any `Host:` header with a space or a
 * bracket in it. A throw inside a request handler is an uncaught exception, and
 * an uncaught exception ends the process — so one malformed line from a port
 * scanner used to take the show off every phone and every second machine in the
 * garden. The only sensible answer to a request that cannot be parsed is to say
 * so and carry on.
 */
function requestUrl(req) {
  try {
    return new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  } catch {
    return null;
  }
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

/* ------------------------------------------------------------------ *
 * WebSocket, by hand
 *
 * RFC 6455 is a short protocol and this is the short half of it: accept the
 * handshake, unmask incoming frames, send unmasked ones back. Text frames
 * only, because everything the app sends is JSON.
 * ------------------------------------------------------------------ */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

/** A project with a depth scan and a few custom effects is large, but not this large. */
const MAX_MESSAGE = 32 * 1024 * 1024;

export function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

export function encodeFrame(opcode, data) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN, never fragmented on the way out
  return Buffer.concat([header, payload]);
}

/**
 * Incremental frame parser.
 *
 * TCP hands over whatever arrived, which is not frames: a 300 KB project turns
 * up as a couple of hundred chunks, and four small messages can turn up as one.
 * So this keeps a buffer, takes complete frames off the front of it, and
 * reassembles the fragments a client is entitled to split a message into.
 */
export function createFrameReader({ onMessage, onClose, onPing, onPong, onError }) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragmentOp = 0;
  let fragmentBytes = 0;

  const fail = (why) => {
    onError?.(new Error(why));
    return false;
  };

  return function push(chunk) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;

    for (;;) {
      if (buffer.length < 2) return true;
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let len = buffer[1] & 0x7f;
      let at = 2;

      const control = opcode >= 0x8;
      if (control && (!fin || len > 125)) return fail('fragmented or oversized control frame');

      if (len === 126) {
        if (buffer.length < at + 2) return true;
        len = buffer.readUInt16BE(at);
        at += 2;
      } else if (len === 127) {
        if (buffer.length < at + 8) return true;
        const big = buffer.readBigUInt64BE(at);
        at += 8;
        if (big > BigInt(MAX_MESSAGE)) return fail('message too large');
        len = Number(big);
      }
      if (len > MAX_MESSAGE) return fail('message too large');

      let mask = null;
      if (masked) {
        if (buffer.length < at + 4) return true;
        mask = buffer.subarray(at, at + 4);
        at += 4;
      }
      if (buffer.length < at + len) return true;

      let payload = Buffer.from(buffer.subarray(at, at + len));
      if (masked) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      buffer = buffer.subarray(at + len);

      if (opcode === OP.CLOSE) {
        onClose?.(payload);
        return true;
      }
      if (opcode === OP.PING) {
        onPing?.(payload);
        continue;
      }
      if (opcode === OP.PONG) {
        onPong?.(payload);
        continue;
      }

      if (opcode === OP.CONTINUATION) {
        if (!fragmentOp) return fail('continuation with nothing to continue');
      } else {
        if (fragmentOp) return fail('new message while one was still arriving');
        fragmentOp = opcode;
      }

      fragmentBytes += payload.length;
      if (fragmentBytes > MAX_MESSAGE) return fail('message too large');
      fragments.push(payload);

      if (fin) {
        const whole = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments, fragmentBytes);
        const op = fragmentOp;
        fragments = [];
        fragmentOp = 0;
        fragmentBytes = 0;
        onMessage?.(whole, op);
      }
    }
  };
}

/* ------------------------------------------------------------------ *
 * The relay
 * ------------------------------------------------------------------ */

/**
 * Message types worth dropping rather than queueing when a client is behind.
 *
 * Dragging a slider on the control laptop rebroadcasts the whole project a
 * dozen times a second. A phone on weak wifi cannot take that, and the wrong
 * answer is to let it queue: the queue becomes a growing delay, so the phone
 * ends up showing a slider position from thirty seconds ago and the memory to
 * hold every step in between. Every one of these types is a complete statement
 * of the current state, so the newest is the only one worth having and an
 * un-sent old one has cost nobody anything.
 */
const DROPPABLE = new Set(['project', 'show', 'audio', 'clock']);

/** Bytes already waiting on a socket before we start dropping the above. */
const BACKLOG_LIMIT = 512 * 1024;

let nextClientId = 1;

export function createLinkServer({ root = ROOT, key = null, name = os.hostname() } = {}) {
  const clients = new Set();

  /**
   * Nothing a stranger sends gets to end the evening.
   *
   * The handler is async, so anything it throws becomes an unhandled rejection
   * — which modern Node treats as fatal. This server sits there unattended for
   * hours with a phone and a second machine depending on it, so every request
   * ends in a response or a log line, never in a dead process.
   */
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('[link] request failed', err);
      if (res.headersSent) res.destroy();
      else send(res, 500, 'Something went wrong serving that');
    });
  });

  async function handleRequest(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

    const url = requestUrl(req);
    if (!url) return send(res, 400, 'Bad request');

    /**
     * How a page finds out whether it is being served by this, or by GitHub
     * Pages, or by `python3 -m http.server`. All three are ordinary static
     * hosts and only one of them has a link to join, so the app asks before it
     * tries — otherwise every tab on the published site spends its life
     * retrying a WebSocket to a server that does not exist.
     */
    if (url.pathname === '/link/info') {
      return send(
        res,
        200,
        JSON.stringify({
          ok: true,
          service: 'facade-mapper-link',
          name,
          time: Date.now(),
          clients: clients.size,
          needsKey: !!key,
          addresses: localAddresses(server.address()?.port),
        }),
        'application/json; charset=utf-8'
      );
    }

    return serveStatic(req, res, root);
  }

  server.on('upgrade', (req, socket) => {
    try {
      handleUpgrade(req, socket);
    } catch (err) {
      console.error('[link] upgrade failed', err);
      socket.destroy();
    }
  });

  function handleUpgrade(req, socket) {
    const url = requestUrl(req);
    if (!url) return reject(socket, 400, 'Bad request');
    if (url.pathname !== '/link') return reject(socket, 404, 'No such endpoint');

    const wsKey = req.headers['sec-websocket-key'];
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !wsKey) {
      return reject(socket, 400, 'Not a WebSocket upgrade');
    }
    if (key && url.searchParams.get('key') !== key) {
      return reject(socket, 401, 'Wrong or missing key');
    }

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(wsKey)}\r\n\r\n`
    );
    socket.setNoDelay(true);

    const client = {
      id: `c${nextClientId++}`,
      socket,
      role: url.searchParams.get('role') || 'unknown',
      device: url.searchParams.get('device') || '',
      label: url.searchParams.get('label') || '',
      /** Types this client wants. `null` means everything. */
      subs: null,
      since: Date.now(),
      alive: true,
    };

    client.send = (text) => {
      if (socket.destroyed) return false;
      socket.write(encodeFrame(OP.TEXT, text));
      return true;
    };

    clients.add(client);

    client.send(
      JSON.stringify({
        type: 'link/welcome',
        id: client.id,
        name,
        time: Date.now(),
        clients: clients.size,
      })
    );
    announcePeers();

    const drop = (why) => {
      if (!clients.delete(client)) return;
      socket.destroy();
      announcePeers();
      if (why) log(`${client.role} ${client.id} left (${why})`);
    };

    const read = createFrameReader({
      onMessage: (payload, opcode) => {
        if (opcode !== OP.TEXT) return; // binary is not a thing the app sends
        handleMessage(client, payload.toString('utf8'));
      },
      onPing: (payload) => socket.write(encodeFrame(OP.PONG, payload)),
      onPong: () => {
        client.alive = true;
      },
      onClose: () => {
        if (!socket.destroyed) socket.write(encodeFrame(OP.CLOSE, Buffer.alloc(0)));
        drop('closed');
      },
      onError: (err) => drop(err.message),
    });

    socket.on('data', (chunk) => {
      if (read(chunk) === false) drop('protocol error');
    });
    socket.on('error', () => drop('socket error'));
    socket.on('close', () => drop(null));

    log(`${client.role} ${client.id} joined — ${clients.size} on the link`);
  }

  function handleMessage(client, text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return; // not ours; a relay has no opinion about malformed JSON
    }
    if (!msg || typeof msg.type !== 'string') return;

    /**
     * The one question the server answers itself.
     *
     * `ts` is stamped here, between reading the request and writing the reply,
     * so the client can put a bound on how wrong its own clock is. See
     * `estimateOffset` in js/core/time.js for what it does with it.
     */
    if (msg.type === 'link/ping') {
      client.send(JSON.stringify({ type: 'link/pong', t0: msg.t0, ts: Date.now() }));
      return;
    }

    if (msg.type === 'link/hello') {
      client.role = msg.role || client.role;
      client.device = msg.device || client.device;
      client.label = msg.label || client.label;
      client.subs = Array.isArray(msg.subscribe) ? new Set(msg.subscribe) : null;
      announcePeers();
      return;
    }

    relay(client, msg, text);
  }

  /**
   * Forward one message to everyone entitled to it.
   *
   * Two filters, and both save real bandwidth rather than being tidiness. A
   * phone asks for the two small message types it can act on, so the 300 KB
   * project broadcast never goes near it; and tabs on the machine that sent the
   * message already had it over BroadcastChannel, so sending it back over the
   * network would be paying twice for a message they have.
   */
  function relay(from, msg, text) {
    for (const client of clients) {
      if (client === from) continue;
      if (client.device && from.device && client.device === from.device) continue;
      if (client.subs && !client.subs.has(msg.type)) continue;
      if (DROPPABLE.has(msg.type) && client.socket.writableLength > BACKLOG_LIMIT) continue;
      client.send(text);
    }
  }

  /**
   * Tell everyone who is on the link.
   *
   * Coalesced onto a timer because joining is two events — the socket opens,
   * then the client says what it is — and a room of six devices reconnecting
   * after the wifi blinked should not produce a dozen round-robin broadcasts.
   */
  let peersPending = null;
  function announcePeers() {
    if (peersPending) return;
    peersPending = setTimeout(() => {
      peersPending = null;
      sendPeers();
    }, 50);
    peersPending.unref?.();
  }

  function sendPeers() {
    const peers = [...clients].map((c) => ({
      id: c.id,
      role: c.role,
      device: c.device,
      label: c.label,
      since: c.since,
    }));
    const text = JSON.stringify({ type: 'link/peers', peers, time: Date.now() });
    for (const client of clients) client.send(text);
  }

  /**
   * Heartbeat.
   *
   * A laptop lid closing, or a phone leaving the garden, does not close a TCP
   * connection — it stops answering, and the socket sits there looking alive
   * for as long as the operating system will let it. The control tab's list of
   * devices would then be a list of devices that were here once.
   */
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        clients.delete(client);
        client.socket.destroy();
        announcePeers();
        continue;
      }
      client.alive = false;
      if (!client.socket.destroyed) client.socket.write(encodeFrame(OP.PING, Buffer.alloc(0)));
    }
  }, 15000);
  heartbeat.unref?.();

  let quiet = false;
  const log = (message) => {
    if (!quiet) console.log(`  ${message}`);
  };

  server.on('close', () => clearInterval(heartbeat));

  return {
    server,
    clients,
    setQuiet: (value) => {
      quiet = value;
    },
    listen: (port, host) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address()));
      }),
    close: () =>
      new Promise((resolve) => {
        clearInterval(heartbeat);
        clearTimeout(peersPending);
        for (const client of clients) client.socket.destroy();
        clients.clear();
        server.close(resolve);
      }),
  };
}

function reject(socket, status, message) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/* ------------------------------------------------------------------ *
 * Command line
 * ------------------------------------------------------------------ */

/** Every address a phone might reach this machine on. */
export function localAddresses(port) {
  const out = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      out.push(port ? `http://${entry.address}:${port}` : entry.address);
    }
  }
  return out;
}

/**
 * A port number, or null.
 *
 * Zero is a real answer — it is how you ask the operating system for whatever
 * port is free, which is what the tests do — so this cannot be the usual
 * `Number(x) || fallback`, where zero is indistinguishable from nonsense.
 * Everything that is not a whole number in range is nonsense, and saying so
 * beats quietly listening somewhere other than where you were told.
 */
function parsePort(raw) {
  const port = Number(raw);
  if (raw === undefined || raw === '' || !Number.isInteger(port) || port < 0 || port > 65535) return null;
  return port;
}

export function parseArgs(argv) {
  const options = { port: 8000, host: '0.0.0.0', key: null, help: false, errors: [] };

  const setPort = (raw) => {
    const port = parsePort(raw);
    if (port === null) options.errors.push(`Not a port number: ${raw ?? '(nothing)'}`);
    else options.port = port;
  };
  const setHost = (raw) => {
    if (!raw) options.errors.push('--host needs an address');
    else options.host = raw;
  };
  const setKey = (raw) => {
    if (!raw) options.errors.push('--key needs a value');
    else options.key = raw;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => argv[++i];
    if (arg === '--port' || arg === '-p') setPort(value());
    else if (arg === '--host') setHost(value());
    else if (arg === '--key') setKey(value());
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (/^--port=/.test(arg)) setPort(arg.slice('--port='.length));
    else if (/^--host=/.test(arg)) setHost(arg.slice('--host='.length));
    else if (/^--key=/.test(arg)) setKey(arg.slice('--key='.length));
    else options.errors.push(`Unknown option: ${arg}`);
  }
  return options;
}

const HELP = `Facade Mapper link server

  node server.mjs [options]

  --port, -p <n>   Port to listen on (default 8000; 0 picks a free one)
  --host <addr>    Interface to bind (default 0.0.0.0, i.e. the whole network)
  --key <secret>   Require ?key=<secret> to join the link
  --help, -h       This

Serves the app and relays show messages between devices. Run it from the
repository root.`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  if (options.errors.length) {
    for (const message of options.errors) console.error(message);
    console.error('\n' + HELP);
    process.exitCode = 1;
    return;
  }

  const link = createLinkServer({ key: options.key });
  try {
    await link.listen(options.port, options.host);
  } catch (err) {
    console.error(
      err.code === 'EADDRINUSE'
        ? `Port ${options.port} is already busy. Try: node server.mjs --port ${options.port + 1}`
        : err.code === 'EACCES'
          ? `Not allowed to listen on port ${options.port}. Ports below 1024 need root; try --port 8000.`
          : `Could not start: ${err.message}`
    );
    process.exitCode = 1;
    return;
  }

  const port = link.server.address().port;
  const network = localAddresses(port);
  const suffix = options.key ? `?key=${encodeURIComponent(options.key)}` : '';

  console.log(`
Facade Mapper — serving this folder, link open.

  Control (this machine)   http://localhost:${port}/
  Phone remote             ${network[0] ? `${network[0]}/remote.html${suffix}` : `http://localhost:${port}/remote.html${suffix}`}
  Second laptop            ${network[0] ? `${network[0]}/projector.html` : `http://localhost:${port}/projector.html`}
${network.length > 1 ? `\n  Other addresses          ${network.slice(1).join('\n                           ')}\n` : ''}
Drive the show from this machine's own tab at localhost — camera access needs
localhost or HTTPS, and a LAN address is neither. Ctrl+C to stop.
`);

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      console.log('\nStopping.');
      link.close().then(() => process.exit(0));
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
