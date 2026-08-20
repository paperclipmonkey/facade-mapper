/**
 * Does a second device join the same show?
 *
 * Everything the app does across tabs rests on one assumption: that every tab
 * agrees what time it is. On one machine that is free — they all read one
 * system clock. Across two machines it is not free at all, and it is not a
 * small error either: a laptop that has been asleep in the shed is routinely a
 * second or more from the one in the hall, and a second of disagreement between
 * two projectors covering one wall is two different animations on the same
 * brickwork.
 *
 * So this covers the three things that have to hold for the second device to be
 * part of the same show rather than a copy of it:
 *
 *   the clock estimate is right, and right in the presence of a slow packet;
 *   the correction actually lands where show time is computed;
 *   the relay carries the messages, in one piece, to the right devices.
 *
 * Plus the two ways the server is exposed to whoever is on the wifi: what it
 * will serve off the disk, and what it does with a nonsense frame.
 *
 *   node test/link.test.mjs
 */

import { createLinkServer, encodeFrame, createFrameReader, acceptKey, resolveStaticPath, parseArgs } from '../server.mjs';
import { estimateOffset, setClockOffset, resetClockOffset, now, clockOffset, clockSync } from '../js/core/time.js';
import { createClock } from '../js/core/clock.js';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * The clock estimate
 * ------------------------------------------------------------------ */

console.log('\n— Estimating the offset —');

{
  // A machine 1500 ms behind the server, on a 20 ms round trip. The reply is
  // stamped in the middle of the trip, so the naive answer and the right answer
  // differ by 10 ms and both look plausible; only one of them is the offset.
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const t0 = 1000 + i * 100;
    const t1 = t0 + 20;
    samples.push({ t0, ts: t0 + 10 + 1500, t1 });
  }
  const estimate = estimateOffset(samples);
  ok('a symmetric round trip gives the true offset', near(estimate.offset, 1500, 0.001), `${estimate.offset}`);
  ok('and reports the trip it measured it over', estimate.rtt === 20, `${estimate.rtt} ms`);
}

{
  /**
   * One packet that sat in a queue on the way back.
   *
   * This is the case the "fastest trip wins" filter exists for. The slow sample
   * reports an offset 250 ms out; averaging every sample would carry a fifth of
   * that error into the answer and put the second projector a frame and a half
   * behind for as long as the sample stayed in the window.
   */
  const samples = [
    { t0: 0, ts: 500 + 5, t1: 10 },
    { t0: 100, ts: 600 + 5, t1: 110 },
    { t0: 200, ts: 700 + 5, t1: 210 },
    { t0: 300, ts: 300 + 5 + 500, t1: 800 }, // 500 ms trip, nearly all of it on the way back
  ];
  const estimate = estimateOffset(samples);
  ok('a slow packet does not drag the estimate with it', near(estimate.offset, 500, 1), `${estimate.offset}`);
  ok('and is left out of the sample count', estimate.samples === 3, `${estimate.samples} used`);

  const averaged = samples.reduce((sum, s) => sum + (s.ts + (s.t1 - s.t0) / 2 - s.t1), 0) / samples.length;
  ok('(averaging all four would have been wrong)', Math.abs(averaged - 500) > 30, `${averaged.toFixed(0)} ms`);
}

ok('nothing to go on is null, not zero', estimateOffset([]) === null && estimateOffset(null) === null);
ok(
  'malformed samples are discarded',
  estimateOffset([{ t0: NaN, ts: 1, t1: 2 }, { t0: 5, ts: 3, t1: 1 }]) === null
);

/* ------------------------------------------------------------------ *
 * Applying it
 * ------------------------------------------------------------------ */

console.log('\n— Correcting this machine —');

{
  const realNow = Date.now;
  let fake = 1_000_000_000_000;
  Date.now = () => fake;

  try {
    resetClockOffset();
    ok('unlinked, link time is simply the local clock', now() === fake);

    setClockOffset(1500, { rtt: 8, samples: 4 });
    ok('the first correction is taken whole', now() === fake + 1500, `${clockOffset()}`);
    ok('and is reported as synced', clockSync().synced === true);

    /**
     * A later, smaller correction is eased in.
     *
     * Stepping it would jump show time, and a jump in show time is every
     * particle in every effect teleporting at once — far more visible than the
     * 80 ms of error being corrected. Ten seconds of real time is enough to
     * absorb it, and nothing on the wall reads as a change.
     */
    setClockOffset(1580, { rtt: 8, samples: 4 });
    const before = now();
    fake += 1000;
    const after = now();
    ok('a small correction is slewed, not stepped', clockOffset() > 1500 && clockOffset() < 1580, `${clockOffset().toFixed(1)}`);
    ok('and time still only moves forwards', after > before, `${after - before} ms in 1000 ms`);

    fake += 20_000;
    now();
    ok('it gets there in the end', near(clockOffset(), 1580, 0.001), `${clockOffset()}`);

    // A big jump is a different animal: the machine woke up, or this is a fresh
    // connection. Easing 3 seconds in at 5% would mean a minute of wrong show.
    setClockOffset(4600, { rtt: 8, samples: 4 });
    ok('a large correction is taken immediately', clockOffset() === 4600);
  } finally {
    Date.now = realNow;
    resetClockOffset();
  }
}

{
  /**
   * The whole point, end to end.
   *
   * The control machine broadcasts a transport: "the show started at epoch E".
   * A second laptop whose clock is 1.5 seconds fast computes show time from
   * that same number. Without the correction it is a second and a half into a
   * different frame of the animation; with it, the two agree.
   */
  const realNow = Date.now;
  let controlClockMs = 1_700_000_000_000;
  const SKEW = 1500;

  try {
    Date.now = () => controlClockMs;
    resetClockOffset();
    const control = createClock();
    control.play();
    controlClockMs += 8000;
    const transport = control.getTransport();
    const controlTime = control.tick().t;

    // Same instant, a clock 1.5 s fast, and the transport that came over the link.
    Date.now = () => controlClockMs + SKEW;
    const laptop = createClock();
    laptop.setTransport(transport);

    resetClockOffset();
    const uncorrected = laptop.tick().t;

    setClockOffset(-SKEW, { step: true });
    const corrected = laptop.tick().t;

    ok('an uncorrected second laptop runs a different show', near(uncorrected - controlTime, 1.5, 0.01), `${(uncorrected - controlTime).toFixed(3)}s out`);
    ok('correcting the clock puts it back in step', near(corrected, controlTime, 0.001), `${(corrected - controlTime).toFixed(4)}s out`);
  } finally {
    Date.now = realNow;
    resetClockOffset();
  }
}

/* ------------------------------------------------------------------ *
 * Frames
 * ------------------------------------------------------------------ */

console.log('\n— Speaking WebSocket —');

// The example handshake from RFC 6455 §1.3, which is the one thing in the
// protocol that is worth checking against somebody else's arithmetic.
ok('the handshake accept key matches the RFC', acceptKey('dGhlIHNhbXBsZSBub25jZQ==') === 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');

{
  const seen = [];
  const read = createFrameReader({ onMessage: (payload) => seen.push(payload.toString('utf8')) });

  // The three payload-length encodings, which is where a hand-written codec
  // gets it wrong: 7-bit, 16-bit and 64-bit.
  for (const size of [5, 125, 126, 700, 70000]) {
    seen.length = 0;
    const text = 'x'.repeat(size);
    read(encodeFrame(0x1, Buffer.from(text)));
    ok(`a ${size}-byte message survives the round trip`, seen[0] === text, `${seen[0]?.length ?? 0} back`);
  }

  // TCP does not deliver frames, it delivers whatever arrived. Both halves of
  // this happen constantly in practice.
  seen.length = 0;
  const frame = encodeFrame(0x1, Buffer.from('hello over a slow wire'));
  for (const byte of frame) read(Buffer.from([byte]));
  ok('a frame split across many chunks reassembles', seen[0] === 'hello over a slow wire');

  seen.length = 0;
  read(Buffer.concat([encodeFrame(0x1, Buffer.from('one')), encodeFrame(0x1, Buffer.from('two'))]));
  ok('two frames in one chunk both arrive', seen.join(',') === 'one,two');
}

{
  // A masked, fragmented message: the client half of the protocol, which is
  // what Node and every browser actually send.
  const seen = [];
  const read = createFrameReader({ onMessage: (payload) => seen.push(payload.toString('utf8')) });
  const mask = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);
  const maskedFrame = (opcode, fin, text) => {
    const body = Buffer.from(text, 'utf8');
    const masked = Buffer.from(body);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    const header = Buffer.alloc(2);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | masked.length;
    return Buffer.concat([header, mask, masked]);
  };
  read(maskedFrame(0x1, false, 'half a '));
  read(maskedFrame(0x0, true, 'message'));
  ok('a masked, fragmented message is unmasked and rejoined', seen[0] === 'half a message', seen[0]);
}

{
  let error = null;
  const read = createFrameReader({ onMessage: () => {}, onError: (err) => (error = err) });
  // A control frame claiming a 300-byte payload. Nonsense, and the sort of
  // nonsense that arrives from a port scanner rather than from a phone.
  const bad = Buffer.from([0x89, 0x7e, 0x01, 0x2c]);
  const result = read(bad);
  ok('a malformed control frame is refused rather than parsed', result === false && !!error, error?.message);
}

/* ------------------------------------------------------------------ *
 * What the server will hand out
 * ------------------------------------------------------------------ */

console.log('\n— Serving files —');

ok('an ordinary path resolves inside the root', resolveStaticPath('/js/core/link.js', ROOT) === path.join(ROOT, 'js/core/link.js'));
ok('a bare slash means the index', resolveStaticPath('/', ROOT) === path.join(ROOT, 'index.html'));
ok('a query string is not part of the path', resolveStaticPath('/index.html?demo', ROOT) === path.join(ROOT, 'index.html'));
for (const attempt of ['/../../../etc/passwd', '/js/../../etc/passwd', '/%2e%2e%2f%2e%2e%2fetc/passwd', '/..%2f..%2fetc/passwd']) {
  const resolved = resolveStaticPath(attempt, ROOT);
  ok(`"${attempt}" cannot escape the folder`, resolved === null || resolved.startsWith(ROOT + path.sep), String(resolved));
}
ok('a null byte is refused outright', resolveStaticPath('/index.html\0.png', ROOT) === null);
// This folder is a git checkout, and the server binds to the whole network.
ok('.git is not served', resolveStaticPath('/.git/config', ROOT) === null);
ok('nor is any other dotfile', resolveStaticPath('/.env', ROOT) === null);
ok('a dot inside a name is still fine', resolveStaticPath('/js/core/link.js', ROOT) !== null);

ok('--port is read', parseArgs(['--port', '9123']).port === 9123);
ok('--port=n is read too', parseArgs(['--port=9123']).port === 9123);
ok('a key can be required', parseArgs(['--key', 'boo']).key === 'boo');
// Zero is how you ask the operating system for a free port, so it has to
// survive the validation rather than being mistaken for nothing.
ok('--port 0 means "pick one"', parseArgs(['--port', '0']).port === 0);
ok('a key with an "=" in it survives', parseArgs(['--key=a=b']).key === 'a=b');
for (const bad of [['--port', 'eight'], ['--port', '-5'], ['--port', '99999'], ['--port'], ['--port', '80.5']]) {
  const parsed = parseArgs(bad);
  ok(`"${bad.join(' ')}" is refused rather than ignored`, parsed.errors.length === 1 && parsed.port === 8000, parsed.errors[0]);
}
ok('an unknown option is refused', parseArgs(['--colour']).errors.length === 1);
ok('valid arguments produce no complaints', parseArgs(['--port=1', '--host=127.0.0.1', '--key=x']).errors.length === 0);

/* ------------------------------------------------------------------ *
 * The relay, for real
 * ------------------------------------------------------------------ */

if (typeof WebSocket === 'undefined') {
  console.log('\n— Relaying — skipped, this Node has no WebSocket client —');
} else {
  console.log('\n— Relaying —');

  const link = createLinkServer({ root: ROOT, name: 'test-house' });
  link.setQuiet(true);
  const address = await link.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;

  const info = await (await fetch(`${base}/link/info`)).json();
  ok('the app can tell this is a link server', info.service === 'facade-mapper-link' && info.name === 'test-house');

  const page = await fetch(`${base}/remote.html`);
  ok('the remote page is served, as HTML', page.status === 200 && page.headers.get('content-type').startsWith('text/html'));
  const module = await fetch(`${base}/js/remote/app.js`);
  ok(
    'and modules with a type the browser will execute',
    module.status === 200 && module.headers.get('content-type').startsWith('text/javascript')
  );
  ok('missing files are a 404, not a crash', (await fetch(`${base}/nope.js`)).status === 404);

  const join = (role, device, subscribe) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/link?role=${role}&device=${device}`);
      ws.inbox = [];
      ws.onmessage = (ev) => ws.inbox.push(JSON.parse(ev.data));
      ws.onerror = reject;
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'link/hello', role, device, subscribe }));
        resolve(ws);
      };
    });

  const control = await join('control', 'laptop-hall', null);
  const projector = await join('projector', 'laptop-garage', null);
  const phone = await join('remote', 'phone', ['show', 'clock']);
  const sameMachine = await join('projector', 'laptop-hall', null);
  await wait(120);

  const project = { type: 'project', payload: { shapes: Array.from({ length: 400 }, (_, i) => ({ i })) }, device: 'laptop-hall' };
  control.send(JSON.stringify(project));
  control.send(JSON.stringify({ type: 'show', payload: { activeScene: 'scene_1' }, device: 'laptop-hall' }));
  await wait(150);

  const typesFor = (ws) => ws.inbox.map((m) => m.type);

  ok('the other laptop gets the project', typesFor(projector).includes('project'));
  ok(
    'the project reaches it intact',
    projector.inbox.find((m) => m.type === 'project')?.payload.shapes.length === 400
  );
  ok('the phone gets the digest', typesFor(phone).includes('show'));
  ok('and is spared the project it did not ask for', !typesFor(phone).includes('project'));
  ok('the sender does not hear its own message back', !typesFor(control).includes('project'));
  ok(
    'nor does another tab on the same machine, which already had it',
    !typesFor(sameMachine).includes('project'),
    typesFor(sameMachine).join(',')
  );

  /**
   * The requests that used to end the evening.
   *
   * `GET //` is a protocol-relative URL with no host and `new URL` throws on
   * it; so does any Host header with a space in it. Thrown inside a request
   * handler that is an uncaught rejection, which takes the process with it —
   * and with it the phone remote and every second machine. One line from a
   * port scanner should cost a 400, not the show.
   */
  const rawRequest = (lines) =>
    new Promise((resolve) => {
      const socket = net.connect(address.port, '127.0.0.1', () => socket.write(`${lines}\r\n\r\n`));
      let data = '';
      socket.on('data', (chunk) => (data += chunk));
      socket.on('close', () => resolve(data.split('\r\n')[0]));
      socket.on('error', () => resolve('(no answer)'));
      setTimeout(() => {
        socket.destroy();
        resolve(data.split('\r\n')[0] || '(no answer)');
      }, 800);
    });

  ok('"GET //" is answered, not fatal', (await rawRequest('GET // HTTP/1.1\r\nHost: 127.0.0.1')).includes('400'));
  ok('a Host header with a space in it is too', (await rawRequest('GET / HTTP/1.1\r\nHost: a b')).includes('400'));
  ok(
    'and an upgrade with a broken target',
    (await rawRequest('GET // HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13')).includes('400')
  );
  const stillThere = await fetch(`${base}/link/info`);
  ok('the server is still serving afterwards', stillThere.status === 200);

  const peers = control.inbox.filter((m) => m.type === 'link/peers').pop();
  ok('everyone is told who else is here', peers?.peers.length === 4, `${peers?.peers.length}`);

  const t0 = Date.now();
  phone.send(JSON.stringify({ type: 'link/ping', t0 }));
  await wait(120);
  const pong = phone.inbox.find((m) => m.type === 'link/pong');
  ok('the server answers what time it makes it', !!pong && pong.t0 === t0 && near(pong.ts, Date.now(), 5000));

  // The estimate, over a real socket, on one machine: the two clocks are the
  // same clock, so the answer has to be about zero.
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const sent = Date.now();
    phone.send(JSON.stringify({ type: 'link/ping', t0: sent }));
    await wait(30);
    const reply = phone.inbox.filter((m) => m.type === 'link/pong').pop();
    samples.push({ t0: reply.t0, ts: reply.ts, t1: Date.now() });
  }
  const local = estimateOffset(samples);
  ok('measured against itself, the offset is nothing', Math.abs(local.offset) < 25, `${local.offset.toFixed(1)} ms`);

  // Nonsense on the wire is a thing a relay meets. It must not take the show
  // down with it.
  control.send('this is not json');
  control.send(JSON.stringify({ nope: true }));
  await wait(60);
  phone.inbox.length = 0;
  control.send(JSON.stringify({ type: 'show', payload: { activeScene: 'scene_2' }, device: 'laptop-hall' }));
  await wait(120);
  ok('rubbish is ignored and the link carries on', typesFor(phone).includes('show'));

  projector.close();
  await wait(150);
  const after = control.inbox.filter((m) => m.type === 'link/peers').pop();
  ok('a device leaving is noticed', after?.peers.length === 3, `${after?.peers.length}`);

  for (const ws of [control, phone, sameMachine]) ws.close();
  await link.close();
}

console.log(`\n${failures ? `${failures} failed` : 'All passed'}`);
process.exit(failures ? 1 : 0);
