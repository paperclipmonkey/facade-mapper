/**
 * The MQTT bridge: Home Assistant's buttons onto the link, and the dare game's
 * state back out.
 *
 * Everything here happens between three machines that are not the one anybody
 * is looking at — the broker, Home Assistant and the show machine — so every
 * failure is silent on the night: a press that never arrives looks exactly
 * like a child who did not press anything. The packet code is checked byte by
 * byte, and then the whole path is run for real against a small broker written
 * in this file, through the actual link server, to a WebSocket standing in for
 * the control tab.
 *
 *   node test/mqtt.test.mjs
 */

import net from 'node:net';
import {
  encodeLength,
  encodeConnect,
  encodePublish,
  encodeSubscribe,
  createPacketReader,
  parsePress,
  createSkewEstimator,
  createGameWatcher,
  parseBrokerUrl,
  createMqttBridge,
  PACKET,
} from '../mqtt.mjs';
import { createLinkServer, parseArgs } from '../server.mjs';

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read every packet out of some bytes, fed in as awkwardly as TCP might. */
function readAll(buffer, chunk = 3) {
  const out = [];
  const push = createPacketReader((p) => out.push(p));
  for (let i = 0; i < buffer.length; i += chunk) push(buffer.subarray(i, i + chunk));
  return out;
}

/* ------------------------------------------------------------------ *
 * Packets
 * ------------------------------------------------------------------ */

console.log('— packets —');
{
  const cases = [
    [0, [0]],
    [127, [127]],
    [128, [0x80, 0x01]],
    [16383, [0xff, 0x7f]],
    [16384, [0x80, 0x80, 0x01]],
    [2097151, [0xff, 0xff, 0x7f]],
  ];
  for (const [n, bytes] of cases) {
    ok(`remaining length ${n} is ${bytes.length} byte${bytes.length === 1 ? '' : 's'}`, encodeLength(n).equals(Buffer.from(bytes)));
  }

  const publish = encodePublish({ topic: 'facade/press', payload: '{"button":"yes"}', qos: 1, id: 513 });
  const [decoded] = readAll(publish);
  ok('a QoS 1 publish reads back with its topic', decoded.type === PACKET.PUBLISH && decoded.topic === 'facade/press');
  ok('and its packet id', decoded.qos === 1 && decoded.id === 513);
  ok('and its payload', decoded.payload.toString() === '{"button":"yes"}');

  const big = encodePublish({ topic: 't', payload: 'x'.repeat(20000), retain: true });
  const [bigOut] = readAll(big, 777);
  ok('a publish needing a three-byte length survives being split', bigOut.payload.length === 20000 && bigOut.retain === true);

  const two = Buffer.concat([encodePublish({ topic: 'a', payload: '1' }), encodePublish({ topic: 'b', payload: '2' })]);
  const both = readAll(two, two.length);
  ok('two packets in one chunk are two packets', both.length === 2 && both[1].topic === 'b');

  const connect = encodeConnect({ clientId: 'c', username: 'u', password: 'p', keepalive: 30, will: { topic: 'w', payload: 'offline', retain: true } });
  ok('CONNECT asks for a clean session, a retained will, a user and a password',
    (connect[2 + 2 + 4 + 1] & 0xe6) === 0xe6, connect[2 + 2 + 4 + 1].toString(2));

  const subscribe = encodeSubscribe(7, [{ topic: 'facade/press', qos: 1 }]);
  ok('SUBSCRIBE carries the flags the spec insists on', subscribe[0] === 0x82);

  let threw = '';
  try {
    readAll(Buffer.from([0x30, 0xff, 0xff, 0xff, 0xff, 0x01]), 6);
  } catch (err) {
    threw = err.message;
  }
  ok('a five-byte length is refused, not believed', threw.includes('malformed'), threw);
  threw = '';
  try {
    readAll(Buffer.concat([Buffer.from([0x30]), encodeLength(10 * 1024 * 1024)]), 8);
  } catch (err) {
    threw = err.message;
  }
  ok('a ten-megabyte "button press" is refused before it is read', threw.includes('too large'), threw);
}

/* ------------------------------------------------------------------ *
 * What counts as a press
 * ------------------------------------------------------------------ */

console.log('— presses —');
{
  const json = (o) => Buffer.from(JSON.stringify(o));
  const a = parsePress('facade/press', json({ button: 'event.path_left', kind: 'initial_press', id: 'ctx1', at: 1000 }), 'facade');
  ok('the documented automation\'s message is a press', a.press?.button === 'event.path_left' && a.press.kind === 'press');
  ok('with its id and stamp', a.press.id === 'ctx1' && a.press.at === 1000);
  ok('long_press is a hold', parsePress('facade/press', json({ button: 'b', kind: 'long_press' }), 'facade').press?.kind === 'long');
  ok('Home Assistant\'s own field names work too',
    parsePress('facade/press', json({ entity_id: 'event.x', event_type: 'initial_press' }), 'facade').press?.button === 'event.x');
  ok('short_release is not a second press', parsePress('facade/press', json({ button: 'b', kind: 'short_release' }), 'facade').skip?.includes('short_release'));
  ok('nor is multi_press_complete', !!parsePress('facade/press', json({ button: 'b', kind: 'multi_press_complete' }), 'facade').skip);
  ok('no kind means a press', parsePress('facade/press', json({ button: 'b' }), 'facade').press?.kind === 'press');
  ok('the button can be the end of the topic', parsePress('facade/press/yes', Buffer.from(''), 'facade').press?.button === 'yes');
  ok('with the kind as a bare word', parsePress('facade/press/no', Buffer.from('long_press'), 'facade').press?.kind === 'long');
  ok('a body without a button is refused', parsePress('facade/press', json({ kind: 'initial_press' }), 'facade').skip === 'no button named');
  ok('so is broken JSON', !!parsePress('facade/press', Buffer.from('{"button":'), 'facade').skip);
  ok('and a topic that is not ours', !!parsePress('facade/pressure', json({ button: 'b' }), 'facade').skip);
  ok('a numeric id becomes a string', parsePress('facade/press', json({ button: 'b', id: 42 }), 'facade').press?.id === '42');
  ok('a nonsense stamp is no stamp', parsePress('facade/press', json({ button: 'b', at: 'soon' }), 'facade').press?.at === null);
}

console.log('— another machine\'s clock —');
{
  // Home Assistant five seconds behind the show machine.
  const skew = createSkewEstimator();
  let arrived = 1_000_000;
  let at = skew.restamp(arrived - 5000 - 40, arrived);
  ok('the first press from a slow clock is not stale', arrived - at === 0);
  arrived += 10_000;
  at = skew.restamp(arrived - 5000 - 60, arrived);
  ok('an ordinary press after it is a few milliseconds old', arrived - at === 20);
  arrived += 10_000;
  at = skew.restamp(arrived - 5000 - 3040, arrived);
  ok('a press held up three seconds on the way is three seconds old', arrived - at === 3000);

  // And five seconds ahead: every press would otherwise look like the future.
  const ahead = createSkewEstimator();
  arrived = 2_000_000;
  ahead.restamp(arrived + 5000 - 30, arrived);
  arrived += 1000;
  at = ahead.restamp(arrived + 5000 - 2530, arrived);
  ok('a fast clock\'s late press is still caught', arrived - at === 2500);
  ok('a press with no stamp is stamped on arrival', createSkewEstimator().restamp(null, 5) === 5);
}

console.log('— the game, for Home Assistant —');
{
  const watch = createGameWatcher();
  const digest = (step, name, last = null) => ({ enabled: true, snapshot: { step, name, atStart: step === 's1', alert: false, last } });
  const first = watch(digest('s1', 'Trick or treat?'));
  ok('the first digest is a state', first?.state.step === 'Trick or treat?' && first.state.enabled);
  ok('but not a move', first.cue === null);
  ok('the same digest again is nothing', watch(digest('s1', 'Trick or treat?')) === null);
  const moved = watch(digest('s2', 'Lightning and smoke', { from: 's1', on: 'yes', to: 's2' }));
  ok('a move is a state and a cue', moved.state.step === 'Lightning and smoke' && moved.cue?.step === 'Lightning and smoke');
  ok('saying where from and why', moved.cue.from === 'Trick or treat?' && moved.cue.on === 'yes');
  const timed = watch(digest('s3', 'Scared yet?', { from: 's2', on: 'timeout', to: 's3' }));
  ok('a step moved on by its timer is a move too', timed?.cue?.on === 'timeout');
  ok('nothing that is not a game is anything', watch(null) === null && watch('x') === null);
}

console.log('— the broker address —');
{
  const plain = parseBrokerUrl('mqtt://homeassistant.local', {});
  ok('mqtt:// defaults to 1883', plain.port === 1883 && !plain.secure && plain.host === 'homeassistant.local');
  ok('mqtts:// defaults to 8883', parseBrokerUrl('mqtts://b', {}).port === 8883);
  const env = parseBrokerUrl('mqtt://facade@b:1884', { FACADE_MQTT_PASSWORD: 's3cret' });
  ok('the password can come from the environment', env.username === 'facade' && env.password === 's3cret' && env.port === 1884);
  const inUrl = parseBrokerUrl('mqtt://u:hunter2@b', {});
  ok('a password in the URL works', inUrl.password === 'hunter2');
  ok('but is never printed', !inUrl.display.includes('hunter2'), inUrl.display);
  ok('http:// is not a broker', !!parseBrokerUrl('http://b', {}).error);
  ok('nor is nonsense', !!parseBrokerUrl('broker', {}).error);

  ok('--mqtt is an option', parseArgs(['--mqtt', 'mqtt://b']).mqtt === 'mqtt://b');
  ok('with = too', parseArgs(['--mqtt=mqtt://b']).mqtt === 'mqtt://b');
  ok('a bad broker address is refused at startup', parseArgs(['--mqtt', 'b:1883']).errors.length === 1);
  ok('the topic prefix can be changed', parseArgs(['--mqtt-topic', 'house/front']).mqttTopic === 'house/front');
  ok('but not to a wildcard', parseArgs(['--mqtt-topic', 'house/#']).errors.length === 1);
  ok('or with a trailing slash', parseArgs(['--mqtt-topic', 'house/']).errors.length === 1);
}

/* ------------------------------------------------------------------ *
 * A broker, for real
 * ------------------------------------------------------------------ */

/**
 * Enough of a broker to be talked to: accepts or refuses CONNECT, records
 * SUBSCRIBE and PUBLISH, acknowledges what needs acknowledging, and can send
 * a publish to whoever is connected.
 */
async function startBroker({ refuse = 0 } = {}) {
  const broker = { connects: [], subscribes: [], published: [], pubacks: [], disconnects: 0, sockets: new Set() };
  const server = net.createServer((socket) => {
    broker.sockets.add(socket);
    socket.on('close', () => broker.sockets.delete(socket));
    socket.on('error', () => {});
    const push = createPacketReader((p) => {
      if (p.type === PACKET.CONNECT) {
        broker.connects.push(parseConnectBody(p.body));
        socket.write(Buffer.from([0x20, 2, 0, refuse]));
        if (refuse) socket.end();
      } else if (p.type === PACKET.SUBSCRIBE) {
        const id = p.body.readUInt16BE(0);
        const filters = [];
        let at = 2;
        while (at < p.body.length) {
          const len = p.body.readUInt16BE(at);
          filters.push({ topic: p.body.subarray(at + 2, at + 2 + len).toString(), qos: p.body[at + 2 + len] });
          at += 3 + len;
        }
        broker.subscribes.push(...filters);
        socket.write(Buffer.from([0x90, 2 + filters.length, id >> 8, id & 255, ...filters.map(() => 1)]));
      } else if (p.type === PACKET.PUBLISH) {
        broker.published.push({ topic: p.topic, payload: p.payload.toString(), retain: p.retain, qos: p.qos });
      } else if (p.type === PACKET.PUBACK) {
        broker.pubacks.push(p.id);
      } else if (p.type === PACKET.PINGREQ) {
        socket.write(Buffer.from([0xd0, 0]));
      } else if (p.type === PACKET.DISCONNECT) {
        broker.disconnects++;
      }
    });
    socket.on('data', (chunk) => push(chunk));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  broker.port = server.address().port;
  broker.send = (packet) => {
    for (const socket of broker.sockets) socket.write(packet);
  };
  broker.dropAll = () => {
    for (const socket of broker.sockets) socket.destroy();
  };
  broker.close = () =>
    new Promise((resolve) => {
      broker.dropAll();
      server.close(resolve);
    });
  return broker;
}

/** CONNECT's body, as far as this file cares about it. */
function parseConnectBody(body) {
  let at = 2 + body.readUInt16BE(0); // protocol name
  const level = body[at++];
  const flags = body[at++];
  const keepalive = body.readUInt16BE(at);
  at += 2;
  const next = () => {
    const len = body.readUInt16BE(at);
    const value = body.subarray(at + 2, at + 2 + len).toString();
    at += 2 + len;
    return value;
  };
  const out = { level, flags, keepalive, clientId: next() };
  if (flags & 0x04) {
    out.willTopic = next();
    out.willPayload = next();
    out.willRetain = !!(flags & 0x20);
  }
  if (flags & 0x80) out.username = next();
  if (flags & 0x40) out.password = next();
  return out;
}

const until = async (check, ms = 2000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (check()) return true;
    await wait(15);
  }
  return false;
};

if (typeof WebSocket === 'undefined') {
  console.log('\n— end to end — skipped, this Node has no WebSocket client —');
} else {
  console.log('\n— a button in Home Assistant, to the control tab —');

  const broker = await startBroker();
  let bridge = null;
  const link = createLinkServer({
    key: 'back-gate',
    onShow: (digest) => bridge?.digest(digest.game),
  });
  link.setQuiet(true);
  const address = await link.listen(0, '127.0.0.1');
  const logs = [];
  bridge = createMqttBridge({
    broker: { host: '127.0.0.1', port: broker.port, username: 'facade', password: 'pw', display: 'test-broker' },
    onPress: (press) => link.injectPress(press),
    log: (m) => logs.push(m),
    retryMin: 50,
    retryMax: 200,
  });

  ok('the bridge connects', await until(() => bridge.connected));
  const hello = broker.connects[0];
  ok('as MQTT 3.1.1, with the user and password', hello?.level === 4 && hello.username === 'facade' && hello.password === 'pw');
  ok('leaving a retained "offline" will for if it dies', hello?.willTopic === 'facade/bridge' && hello.willPayload === 'offline' && hello.willRetain);
  ok('it subscribes to presses at QoS 1, both shapes',
    await until(() => broker.subscribes.length === 2) && broker.subscribes.every((f) => f.qos === 1) &&
      broker.subscribes.map((f) => f.topic).join() === 'facade/press,facade/press/+');
  ok('and says it is online, retained', await until(() => broker.published.some((m) => m.topic === 'facade/bridge' && m.payload === 'online' && m.retain)));

  const control = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/link?role=control&device=laptop&key=back-gate`);
    ws.inbox = [];
    ws.onmessage = (ev) => ws.inbox.push(JSON.parse(ev.data));
    ws.onerror = reject;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'link/hello', role: 'control', device: 'laptop' }));
      resolve(ws);
    };
  });
  await wait(80);
  const actions = () => control.inbox.filter((m) => m.type === 'action').map((m) => m.payload);

  broker.send(encodePublish({ topic: 'facade/press', qos: 1, id: 9, payload: JSON.stringify({ button: 'event.path_left', kind: 'initial_press', id: 'ctx-a', at: Date.now() - 30 }) }));
  ok('a press published by Home Assistant reaches the control tab', await until(() => actions().length === 1));
  const press = actions()[0];
  ok('as the same press action the remote sends', press?.action === 'press' && press.button === 'event.path_left' && press.kind === 'press');
  ok('carrying its id', press?.id === 'ctx-a');
  ok('and a stamp in the server\'s time', Math.abs(press.at - Date.now()) < 1000, String(Date.now() - press.at));
  ok('the broker\'s QoS 1 delivery is acknowledged', await until(() => broker.pubacks.includes(9)));

  broker.send(encodePublish({ topic: 'facade/press', payload: JSON.stringify({ button: 'event.path_right', kind: 'long_press' }) }));
  broker.send(encodePublish({ topic: 'facade/press', payload: JSON.stringify({ button: 'event.path_right', kind: 'short_release' }) }));
  broker.send(encodePublish({ topic: 'facade/press/door', payload: 'initial_press' }));
  await until(() => actions().length >= 3);
  await wait(60);
  ok('a long press arrives as a hold', actions()[1]?.kind === 'long');
  ok('a release does not arrive at all', actions().length === 3, actions().map((a) => a.kind).join());
  ok('a press on a per-button topic arrives with its button', actions()[2]?.button === 'door');

  broker.send(encodePublish({ topic: 'facade/press', retain: true, payload: JSON.stringify({ button: 'yes' }) }));
  await wait(120);
  ok('a retained press is never a press', actions().length === 3);
  ok('and the log says why, once', logs.filter((l) => l.includes('retained')).length === 1);

  console.log('— the automation, back to Home Assistant —');
  const digest = (step, name, last = null) =>
    JSON.stringify({ type: 'show', payload: { name: 'house', game: { enabled: true, snapshot: { step, name, atStart: step === 's1', last } } }, device: 'laptop' });
  control.send(digest('s1', 'Trick or treat?'));
  ok('the game state is published, retained', await until(() => broker.published.some((m) => m.topic === 'facade/game' && m.retain)));
  const published = () => broker.published.filter((m) => m.topic.startsWith('facade/game'));
  control.send(digest('s1', 'Trick or treat?'));
  await wait(100);
  ok('the same state is not published again', published().length === 1);
  control.send(digest('s2', 'Lightning and smoke', { from: 's1', on: 'yes', to: 's2' }));
  ok('a move publishes the new state and a cue', await until(() => published().length === 3));
  const cue = published().find((m) => m.topic === 'facade/game/cue');
  ok('the cue is not retained — it is a moment', cue && !cue.retain);
  ok('and says what happened', JSON.parse(cue.payload).step === 'Lightning and smoke' && JSON.parse(cue.payload).on === 'yes');

  // A remote cannot speak for the game: only the control tab's digests count.
  const remote = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/link?role=remote&device=phone&key=back-gate`);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'link/hello', role: 'remote', device: 'phone', subscribe: ['show'] }));
      resolve(ws);
    };
  });
  await wait(60);
  remote.send(JSON.stringify({ type: 'show', payload: { game: { enabled: true, snapshot: { step: 's9', name: 'At the door' } } }, device: 'phone' }));
  await wait(120);
  ok('a digest from anything but the control tab is not the automation', !published().some((m) => m.payload.includes('At the door')));

  console.log('— presses over HTTP —');
  const base = `http://127.0.0.1:${address.port}`;
  const post = (body, { key = 'back-gate', method = 'POST' } = {}) =>
    fetch(`${base}/link/press${key ? `?key=${key}` : ''}`, { method, body: method === 'POST' ? body : undefined });
  const before = actions().length;
  const res = await post(JSON.stringify({ button: 'yes' }));
  const answer = await res.json();
  ok('POST /link/press is accepted', res.status === 200 && answer.ok && answer.delivered === 1, JSON.stringify(answer));
  ok('and reaches the control tab', await until(() => actions().length === before + 1) && actions().at(-1).button === 'yes');
  ok('without the key it is refused', (await post('{"button":"yes"}', { key: null })).status === 401);
  ok('the key can be a header instead',
    (await fetch(`${base}/link/press`, { method: 'POST', headers: { 'x-facade-key': 'back-gate' }, body: '{"button":"no"}' })).status === 200);
  ok('GET is not a press', (await post(null, { method: 'GET' })).status === 405);
  ok('a body with no button is a 400', (await post('{"kind":"initial_press"}')).status === 400);
  ok('a huge body is refused with a 413', (await post('x'.repeat(10000))).status === 413);

  console.log('— losing the broker, and finding it again —');
  const connectsBefore = broker.connects.length;
  broker.dropAll();
  ok('a dropped connection is noticed', await until(() => !bridge.connected));
  ok('and the bridge reconnects on its own', await until(() => bridge.connected && broker.connects.length === connectsBefore + 1, 3000));
  ok('republishing the last game state for whoever missed it',
    await until(() => broker.published.filter((m) => m.topic === 'facade/game').length >= 3));

  bridge.close();
  ok('closing says offline, retained, and disconnects properly',
    await until(() => broker.disconnects === 1) && broker.published.at(-1)?.payload === 'offline');

  control.close();
  remote.close();
  await link.close();
  await broker.close();

  console.log('— a broker that says no —');
  const strict = await startBroker({ refuse: 4 });
  const refusedLogs = [];
  const refused = createMqttBridge({
    broker: { host: '127.0.0.1', port: strict.port, username: 'x', password: 'wrong', display: 'strict' },
    onPress: () => 0,
    log: (m) => refusedLogs.push(m),
    retryMin: 50,
    retryMax: 60000,
  });
  ok('a wrong password is reported as one', await until(() => refusedLogs.some((l) => l.includes('password is wrong'))), refusedLogs.join(' | '));
  ok('and not retried every second', /Trying again in 60 s/.test(refusedLogs.join(' ')), refusedLogs.join(' | '));
  refused.close();
  await strict.close();

  const nobody = createMqttBridge({
    broker: { host: '127.0.0.1', port: 1, display: 'nowhere' },
    onPress: () => 0,
    log: (m) => refusedLogs.push(m),
    retryMin: 5000,
  });
  ok('a broker that is not there is said plainly', await until(() => refusedLogs.some((l) => l.includes('nothing listening at nowhere'))));
  nobody.close();
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
