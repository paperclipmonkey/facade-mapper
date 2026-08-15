/**
 * Motion detection, trigger gating, scheduling and colour grading.
 *
 * All pure functions over synthetic input, so this runs in plain Node with no
 * DOM and no dependencies. These are the parts that misbehave silently: a motion
 * detector that never fires looks identical to one that is simply waiting, and a
 * schedule that is off by a day only shows up a week later.
 *
 *   node test/runtime.test.mjs
 */

import { createMotionDetector, createMotionGate } from '../js/control/motion.js';
import { scheduleWantsOn, describeSchedule } from '../js/control/schedule.js';
import { temperatureTint, GRADE_PRESETS, DEFAULT_GRADE } from '../js/render/postfx.js';

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

const W = 160;
const H = 90;

/** A frame of gently uneven background, as a real camera would produce. */
function baseFrame(brightness = 40) {
  const luma = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      luma[y * W + x] = brightness + (x / W) * 12 + Math.sin(x * 0.4 + y * 0.2) * 1.5;
    }
  }
  return luma;
}

/** Paint a person-sized blob into a frame. */
function withBlob(luma, cx, cy, rx, ry, delta = 70) {
  const out = Float32Array.from(luma);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x - cx * W) / (rx * W);
      const dy = (y - cy * H) / (ry * H);
      if (dx * dx + dy * dy <= 1) out[y * W + x] += delta;
    }
  }
  return out;
}

const FULL = { x: 0, y: 0, w: 1, h: 1 };
const LOWER = { x: 0.2, y: 0.55, w: 0.6, h: 0.45 };

/* ---- Motion detection ---- */
{
  const detector = createMotionDetector();
  const base = baseFrame();

  // Warm-up: the model needs a few frames before its answers mean anything.
  let result = detector.update(base, W, H, FULL);
  ok('first frame is not ready', !result.ready);

  for (let i = 0; i < 20; i++) result = detector.update(base, W, H, FULL);
  ok('settles on a static scene', result.ready && result.activity < 0.001,
     `activity ${result.activity.toFixed(4)}`);

  // Someone walks into the lower part of the frame.
  const walker = withBlob(base, 0.5, 0.75, 0.09, 0.18);
  const seen = detector.update(walker, W, H, LOWER);
  ok('detects a person-sized blob', seen.activity > 0.05, `activity ${seen.activity.toFixed(3)}`);

  // The same blob measured in a region it isn't in should read as nothing.
  const detector2 = createMotionDetector();
  for (let i = 0; i < 20; i++) detector2.update(base, W, H, FULL);
  const elsewhere = detector2.update(walker, W, H, { x: 0, y: 0, w: 1, h: 0.3 });
  ok('ignores movement outside the watched region', elsewhere.activity < 0.01,
     `activity ${elsewhere.activity.toFixed(4)}`);
}

{
  // Something that stops and stays put should stop registering: otherwise a
  // parked car or a new decoration would hold a trigger down all night.
  const detector = createMotionDetector();
  const base = baseFrame();
  for (let i = 0; i < 20; i++) detector.update(base, W, H, FULL);

  const parked = withBlob(base, 0.5, 0.75, 0.12, 0.2);
  const first = detector.update(parked, W, H, LOWER);
  let latest = first;
  for (let i = 0; i < 200; i++) latest = detector.update(parked, W, H, LOWER);

  ok('a static newcomer fades into the background',
     first.activity > 0.05 && latest.activity < 0.01,
     `${first.activity.toFixed(3)} -> ${latest.activity.toFixed(4)}`);
}

{
  // A porch light coming on changes nearly everything. That must re-baseline
  // rather than fire, or every dusk would set off every trigger.
  const detector = createMotionDetector();
  const base = baseFrame(30);
  for (let i = 0; i < 20; i++) detector.update(base, W, H, FULL);

  const litUp = baseFrame(160);
  const flash = detector.update(litUp, W, H, FULL);
  ok('a whole-frame lighting change does not count as motion',
     flash.activity === 0 && !flash.ready, `activity ${flash.activity}`);

  for (let i = 0; i < 20; i++) detector.update(litUp, W, H, FULL);
  const settled = detector.update(litUp, W, H, FULL);
  ok('and it settles again on the new light level', settled.ready && settled.activity < 0.001);
}

/* ---- Trigger gate ---- */
{
  const gate = createMotionGate();
  const config = { sensitivity: 0.5, cooldown: 20 };
  const threshold = gate.threshold(0.5);

  const t0 = 1_000_000;
  ok('one frame over threshold is not enough',
     gate.shouldFire('a', threshold * 2, config, t0) === false);
  ok('two consecutive frames fire',
     gate.shouldFire('a', threshold * 2, config, t0 + 100) === true);
  ok('cooldown blocks an immediate re-fire',
     gate.shouldFire('a', threshold * 2, config, t0 + 200) === false &&
     gate.shouldFire('a', threshold * 2, config, t0 + 300) === false);
  ok('it re-arms once the cooldown elapses',
     gate.shouldFire('a', threshold * 2, config, t0 + 21_000) === false &&
     gate.shouldFire('a', threshold * 2, config, t0 + 21_100) === true);

  const gate2 = createMotionGate();
  ok('a broken streak resets',
     gate2.shouldFire('b', threshold * 2, config, t0) === false &&
     gate2.shouldFire('b', 0, config, t0 + 100) === false &&
     gate2.shouldFire('b', threshold * 2, config, t0 + 200) === false);

  ok('higher sensitivity means a lower bar', gate.threshold(0.9) < gate.threshold(0.2));
  ok('thresholds stay in a sane range', gate.threshold(1) > 0 && gate.threshold(0) < 0.2,
     `${gate.threshold(1).toFixed(4)}..${gate.threshold(0).toFixed(3)}`);
}

/* ---- Schedule ---- */
{
  const at = (day, hour, minute = 0) => {
    // 2026-08-09 was a Sunday, so day 0..6 maps onto the 9th..15th.
    const d = new Date(2026, 7, 9 + day, hour, minute, 0);
    return d;
  };
  const every = [0, 1, 2, 3, 4, 5, 6];

  ok('disabled schedule returns null', scheduleWantsOn({ enabled: false }) === null);
  ok('unparseable times return null',
     scheduleWantsOn({ enabled: true, on: 'dusk', off: '22:00', days: every }, at(1, 20)) === null);

  const evening = { enabled: true, on: '18:00', off: '22:30', days: every };
  ok('before the window: off', scheduleWantsOn(evening, at(1, 17, 59)) === false);
  ok('at the start: on', scheduleWantsOn(evening, at(1, 18, 0)) === true);
  ok('mid-window: on', scheduleWantsOn(evening, at(1, 20, 0)) === true);
  ok('at the end: off', scheduleWantsOn(evening, at(1, 22, 30)) === false);
  ok('after: off', scheduleWantsOn(evening, at(1, 23, 0)) === false);

  const overnight = { enabled: true, on: '20:00', off: '01:00', days: every };
  ok('overnight window covers late evening', scheduleWantsOn(overnight, at(1, 23, 0)) === true);
  ok('overnight window covers past midnight', scheduleWantsOn(overnight, at(2, 0, 30)) === true);
  ok('overnight window is off in the afternoon', scheduleWantsOn(overnight, at(2, 15, 0)) === false);

  // Day filtering on an overnight window applies to the day it opened, so a
  // Friday-night slot is still running at 00:30 on Saturday.
  const fridayNight = { enabled: true, on: '20:00', off: '01:00', days: [5] };
  ok('Friday-only overnight runs on Friday evening', scheduleWantsOn(fridayNight, at(5, 22, 0)) === true);
  ok('and still runs after midnight on Saturday', scheduleWantsOn(fridayNight, at(6, 0, 30)) === true);
  ok('but not on Saturday evening', scheduleWantsOn(fridayNight, at(6, 22, 0)) === false);

  const weekend = { enabled: true, on: '18:00', off: '22:00', days: [0, 6] };
  ok('weekend-only skips a Tuesday', scheduleWantsOn(weekend, at(2, 20, 0)) === false);
  ok('weekend-only runs on a Saturday', scheduleWantsOn(weekend, at(6, 20, 0)) === true);

  ok('describes a plain window', describeSchedule(evening).includes('18:00–22:30'));
  ok('flags an overnight window', describeSchedule(overnight).includes('past midnight'));
  ok('names weekends', describeSchedule(weekend).includes('weekends'));
}

/* ---- Grading ---- */
{
  const neutral = temperatureTint(0);
  ok('neutral temperature is a no-op', neutral.every((v) => Math.abs(v - 1) < 1e-9));

  const warm = temperatureTint(1);
  ok('warm keeps red and drops blue', warm[0] >= warm[1] && warm[1] > warm[2], JSON.stringify(warm));

  const cool = temperatureTint(-1);
  ok('cool keeps blue and drops red', cool[2] >= cool[1] && cool[1] > cool[0], JSON.stringify(cool));

  ok('every grade preset is complete',
     GRADE_PRESETS.every((preset) => Object.keys(DEFAULT_GRADE).every((k) => k in preset.values)),
     GRADE_PRESETS.map((p) => p.id).join(', '));

  const flat = GRADE_PRESETS.find((p) => p.id === 'flat');
  ok('the flat preset really is flat',
     flat.values.bloom === 0 && flat.values.contrast === 1 && flat.values.tonemap === false);
}

/* ------------------------------------------------------------------ *
 * Trigger webhooks
 * ------------------------------------------------------------------ */

console.log('\n— trigger webhooks —');
{
  const { checkReachable, fireWebhook } = await import('../js/control/webhooks.js');

  // The one that catches everybody, and the reason this is checked up front
  // rather than left to fail silently at eight o'clock on the thirty-first.
  globalThis.location = { protocol: 'https:' };
  const blocked = checkReachable('http://wled.local/win&T=1');
  ok('an http call from an https page is refused before it is sent', Boolean(blocked));
  ok('and the message says what to do about it', /http/i.test(blocked) && /serve/i.test(blocked), blocked);

  globalThis.location = { protocol: 'http:' };
  ok('the same call from an http page is allowed', checkReachable('http://wled.local/win&T=1') === null);
  ok('https is always allowed', checkReachable('https://example.invalid/x') === null);
  ok('nonsense is caught', Boolean(checkReachable('wled.local/win')));
  ok('a scheme a browser cannot call is caught', Boolean(checkReachable('mqtt://broker/x')));
  ok('an empty hook is not an error', checkReachable('') === null);

  // Nothing may throw. This runs mid-scare, and a device that has been
  // unplugged must not take the trigger runtime down with it.
  const calls = [];
  globalThis.fetch = (url, init) => {
    calls.push({ url, init });
    return Promise.reject(new Error('ECONNREFUSED'));
  };
  const dead = await fireWebhook({ url: 'http://192.0.2.1/win&T=1' }, { key: 'k1' });
  ok('a refused connection resolves rather than throwing', dead.ok === false, dead.error);

  globalThis.fetch = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve({ status: 200 });
  };
  const sent = await fireWebhook({ url: 'http://wled.local/win&T=1' }, { key: 'k2' });
  ok('a good call reports ok', sent.ok === true);
  ok('and defaults to no-cors', calls[calls.length - 1].init.mode === 'no-cors');
  ok('and to GET', calls[calls.length - 1].init.method === 'GET');
  ok('with no body', calls[calls.length - 1].init.body === undefined);

  await fireWebhook({ url: 'http://wled.local/json', method: 'POST', body: '{"on":true}' }, { key: 'k3' });
  const post = calls[calls.length - 1];
  ok('a POST carries its body', post.init.body === '{"on":true}');
  ok('and a content type no-cors will actually allow',
    post.init.headers['Content-Type'] === 'text/plain', post.init.headers['Content-Type']);

  await fireWebhook({ url: 'http://wled.local/json', method: 'POST', body: '{}', mode: 'cors' }, { key: 'k4' });
  ok('cors mode sends real JSON',
    calls[calls.length - 1].init.headers['Content-Type'] === 'application/json');

  // A motion trigger can retrigger fast; a device should not be machine-gunned.
  const before = calls.length;
  await fireWebhook({ url: 'http://wled.local/a' }, { key: 'same' });
  const throttled = await fireWebhook({ url: 'http://wled.local/a' }, { key: 'same' });
  ok('a second call on the same hook straight away is dropped',
    throttled.throttled === true && calls.length === before + 1);

  ok('an empty url does nothing at all',
    (await fireWebhook({ url: '' }, { key: 'k5' })).skipped === true);
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
process.exit(failures ? 1 : 0);
