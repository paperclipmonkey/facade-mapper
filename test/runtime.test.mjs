/**
 * Scheduling, the show clock, colour grading and camera feeds.
 *
 * All pure functions over synthetic input, so this runs in plain Node with no
 * DOM and no dependencies. These are the parts that misbehave silently: a
 * schedule that is off by a day only shows up a week later.
 *
 *   node test/runtime.test.mjs
 */

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

  /**
   * A window of no length.
   *
   * `scheduleWantsOn` returns null for it — there is no answer to give, so
   * blackout is left alone — and the panel used to describe it as "Lit
   * 18:00–18:00, every day", which is a schedule that reads as configured,
   * looks configured, and does nothing at all.
   */
  const zero = { enabled: true, on: '18:00', off: '18:00', days: every };
  ok('a window that opens and shuts at the same minute has no answer',
    scheduleWantsOn(zero, at(1, 18, 0)) === null);
  ok('and the panel says so rather than claiming the house is lit',
    !/Lit/.test(describeSchedule(zero)), describeSchedule(zero));

  ok('describes a plain window', describeSchedule(evening).includes('18:00–22:30'));
  ok('flags an overnight window', describeSchedule(overnight).includes('past midnight'));
  ok('names weekends', describeSchedule(weekend).includes('weekends'));
  ok('and names the days when it is neither', describeSchedule({
    enabled: true, on: '18:00', off: '22:00', days: [6, 1, 0],
  }).includes('Sun, Mon, Sat'));
  ok('a schedule switched off says the show simply runs',
    /whenever/.test(describeSchedule({ enabled: false })));
  ok('and a mistyped time says which shape it wanted',
    describeSchedule({ enabled: true, on: 'dusk', off: '22:00' }).includes('18:00'));
}

/* ------------------------------------------------------------------ *
 * The show clock
 * ------------------------------------------------------------------ */

console.log('\n— the show clock —');
{
  const { createClock, formatTime } = await import('../js/core/clock.js');

  ok('a fresh clock is stopped at zero', formatTime(0) === '00:00.0');
  ok('it counts in tenths', formatTime(5.04) === '00:05.0' && formatTime(5.06) === '00:05.1');
  /**
   * The readout used to show `00:60.0`.
   *
   * The minutes came off the unrounded number and the seconds off the rounded
   * one, so for the last twentieth of every minute the two disagreed — in the
   * control tab and on the phone, once a minute, all evening.
   */
  ok('the last twentieth of a minute reads as the next minute, not as sixty seconds',
    formatTime(59.96) === '01:00.0', formatTime(59.96));
  ok('and the tenth before it still reads as fifty-nine',
    formatTime(59.94) === '00:59.9', formatTime(59.94));
  ok('which holds at every minute boundary',
    formatTime(119.99) === '02:00.0' && formatTime(3599.99) === '60:00.0');
  ok('no readout ever shows a seconds field of sixty',
    Array.from({ length: 4000 }, (_, i) => formatTime(i * 0.03))
      .every((text) => !/:60/.test(text)));
  ok('and nothing before the start of the show is negative', formatTime(-5) === '00:00.0');

  const clock = createClock();
  ok('a new clock is not running', clock.getTransport().running === false);
  clock.play();
  ok('playing starts it', clock.getTransport().running === true);
  clock.pause();
  const paused = clock.getTransport();
  ok('pausing freezes it', paused.running === false);
  ok('and remembers where it got to', clock.timeNow() === paused.t);
  clock.stop();
  ok('stopping sends it back to the beginning',
    clock.getTransport().running === false && clock.timeNow() === 0);

  /**
   * `tick` while paused reports the instant show time *is*, not the instant it
   * is being asked. Everything that turns a stored wall-clock stamp into a show
   * time subtracts one from the other, and a pause slides them apart.
   */
  clock.play();
  const running = clock.tick();
  ok('a running clock reports a wall instant alongside the show time',
    Math.abs(running.wall - Date.now() / 1000) < 1, `${running.wall}`);
  clock.pause();
  const a = clock.tick();
  const b = clock.tick();
  ok('a paused clock does not move', a.t === b.t && a.wall === b.wall);
  ok('and its dt is zero, so nothing simulates while it is stopped', b.dt === 0);
  ok('while frame time keeps running, for the UI', b.frameDt >= 0);
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
 * Camera feeds, and letting go of them
 * ------------------------------------------------------------------ */

console.log('\n— extra camera feeds —');
{
  /**
   * A camera left open holds its light on and shows in the browser's tab
   * indicator, which is alarming if the layer that opened it was deleted an
   * hour ago. An MJPEG `<img>` is worse: it holds a connection open, pulling
   * frames, for the rest of the evening.
   *
   * Stopping the tracks is not enough on its own — the element goes on holding
   * the dead stream — and there are two shapes of entry here, a device feed
   * and a network one, which is how one of them came to be missed.
   */
  const made = [];
  const element = (tag) => {
    const el = {
      tag, src: '', srcObject: null, attributes: new Set(), loaded: 0,
      playsInline: false, muted: false, autoplay: false, loop: false, crossOrigin: '',
      addEventListener() {},
      removeAttribute(name) { el.attributes.add(name); el.src = ''; },
      load() { el.loaded++; },
      play: () => Promise.resolve(),
    };
    made.push(el);
    return el;
  };

  globalThis.document = { createElement: element };
  globalThis.Image = function Image() {
    const img = { src: '', attributes: new Set(), addEventListener() {}, removeAttribute(name) { img.attributes.add(name); img.src = ''; } };
    made.push(img);
    return img;
  };

  const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => tracks }) } },
    configurable: true,
    writable: true,
  });

  const { feed, streamFeed, releaseFeed, pruneFeeds, releaseAllFeeds } =
    await import('../js/control/feeds.js');

  ok('a feed is not ready on the frame it is asked for', feed('cam-1') === null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const camera = feed('cam-1');
  ok('and is there once the camera has opened', camera !== null && camera.tag === 'video');
  ok('asking again does not open a second stream', feed('cam-1') === camera && made.filter((m) => m.tag === 'video').length === 1);

  releaseFeed('cam-1');
  ok('releasing it stops the camera', tracks[0].stopped === true);
  ok('and lets the element go of the stream too',
    camera.srcObject === null && camera.attributes.has('src'), JSON.stringify([...camera.attributes]));
  ok('after which it is opened afresh rather than handed back', feed('cam-1') === null);
  releaseAllFeeds();

  const url = 'http://192.168.1.9/video.cgi?action=stream';
  ok('a network stream is not ready either', streamFeed(url) === null);
  const img = made[made.length - 1];
  ok('an MJPEG url goes in an image, which is drawable and needs no library', img.src === url);
  releaseFeed(url);
  ok('and releasing it drops the connection', img.attributes.has('src') && img.src === '');

  streamFeed('http://example.invalid/loop.mp4');
  const video = made[made.length - 1];
  ok('anything else goes in a video', video.tag === 'video');
  pruneFeeds(new Set());
  ok('pruning closes what nothing points at any more', video.attributes.has('src'));

  delete globalThis.document;
  delete globalThis.Image;
}

/* ------------------------------------------------------------------ *
 * Editing a series of scenes
 * ------------------------------------------------------------------ */

console.log('\n— scenes load, and say when they have drifted —');
{
  const { createProject, createLayer, createScene } = await import('../js/core/state.js');
  const { captureScene, applySceneToLayers, sceneDrift } = await import('../js/core/scenes.js');

  const project = createProject('t');
  const a = createLayer('fill', { params: { level: 0.2 }, opacity: 1, enabled: true });
  const b = createLayer('fill', { params: { level: 0.9 }, opacity: 1, enabled: true });
  project.layers = [a, b];

  const one = createScene({ name: 'One', state: captureScene(project) });
  project.scenes.push(one);
  ok('a scene just saved has not drifted', sceneDrift(project, one.id).length === 0);

  a.params.level = 0.75;
  b.enabled = false;
  ok('and says so once both are changed', sceneDrift(project, one.id).length === 2);

  const two = createScene({ name: 'Two', state: captureScene(project) });
  project.scenes.push(two);
  ok('a second scene saved from here has not drifted', sceneDrift(project, two.id).length === 0);

  /**
   * The bit that was missing. A scene is a render-time override, so switching
   * changed the projection and changed nothing in the panels — the inspector
   * went on showing the authored values while the wall showed the scene's.
   * Building a series of scenes that evolve from one another meant editing
   * numbers you could not see.
   */
  applySceneToLayers(project, one.id);
  ok('loading a scene puts its values back on the layers',
    a.params.level === 0.2 && b.enabled === true);
  ok('and there is nothing left to save', sceneDrift(project, one.id).length === 0);
  ok('while the other scene is untouched', two.state[a.id].params.level === 0.75);

  // A layer a scene says nothing about keeps what it has — the same rule the
  // renderer follows, so loading cannot silently reset a layer added later.
  const c = createLayer('fill', { params: { level: 0.4 } });
  project.layers.push(c);
  applySceneToLayers(project, one.id);
  ok('a layer the scene predates is left alone', c.params.level === 0.4);
  ok('and is not counted as drift', sceneDrift(project, one.id).length === 0);

  /**
   * Saving the look back into the scene it came from.
   *
   * This is what Ctrl+S and the transport's Save button do, and it is the
   * whole point of noticing drift in the first place: a run of good changes
   * used to be one scene button away from gone, with nothing on screen saying
   * so louder than a chip in a panel you may not have open.
   */
  a.params.level = 0.11;
  b.enabled = false;
  ok('editing after a load drifts again', sceneDrift(project, one.id).length === 2);
  ok('and the scene still holds what was stored', one.state[a.id].params.level === 0.2);

  one.state = captureScene(project);
  ok('recapturing clears the drift', sceneDrift(project, one.id).length === 0);
  ok('and the scene now holds what is on the wall', one.state[a.id].params.level === 0.11);
  ok('while the other scene is untouched by any of it', two.state[a.id].params.level === 0.75);

  /**
   * Only the live scene can have drifted, which is what lets the transport
   * mark exactly one button. Every other scene is what it was stored as,
   * because going to one loads it.
   */
  applySceneToLayers(project, two.id);
  ok('going to another scene leaves nothing drifted there',
    sceneDrift(project, two.id).length === 0);
  ok('and the one just left still holds exactly what was saved into it',
    one.state[a.id].params.level === 0.11);
  // It "differs" from the layers now, of course — but it is not the live one,
  // so nobody asks and nothing is marked.
  ok('which is not the same as the live scene having drifted',
    sceneDrift(project, one.id).length > 0 && sceneDrift(project, two.id).length === 0);
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
process.exit(failures ? 1 : 0);
