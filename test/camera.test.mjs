/**
 * Opening the camera, and the same gap the microphone has.
 *
 * `getUserMedia` does not resolve until somebody answers the browser's
 * permission prompt, and the page stays live underneath it. The Start camera
 * button is right there, the device list beside it is a `<select>` that starts
 * the camera again on change, and both are clickable throughout — which means
 * everything they can do happens while the camera is neither open nor closed,
 * and the `stop()` at the top of `start` has nothing yet to stop.
 *
 * Both requests were then granted, both assigned the stream, and whichever
 * lost the race was never let go of: a second capture pipeline running for the
 * rest of the evening with the recording light on and nothing on screen to
 * explain it. And switching the camera off while the prompt was up stopped
 * nothing, so granting it afterwards opened the camera anyway.
 *
 * The browser here is a stand-in with a prompt this file answers by hand,
 * which is the only way to be standing in the gap when the second click lands.
 *
 *   node test/camera.test.mjs
 */

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

/* ------------------------------------------------------------------ *
 * A camera that only opens when this file says so
 * ------------------------------------------------------------------ */

let asked = 0;
let liveTracks = 0;
/** The permission prompts currently on screen, oldest first. */
const prompts = [];

function fakeStream(deviceId) {
  liveTracks++;
  let stopped = false;
  const track = {
    label: `Camera ${deviceId || 'default'}`,
    stop() { if (!stopped) { stopped = true; liveTracks--; } },
    getSettings: () => ({ deviceId: deviceId || 'default' }),
    getCapabilities: () => ({}),
  };
  return { getTracks: () => [track], getVideoTracks: () => [track] };
}

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    mediaDevices: {
      getUserMedia(constraints) {
        asked++;
        const wanted = constraints?.video?.deviceId?.exact || null;
        return new Promise((resolve, reject) => prompts.push({ resolve, reject, wanted }));
      },
      enumerateDevices: async () => [],
    },
  },
});

/** Answer every prompt on screen, so a regression that asks twice cannot hang. */
const grant = () => prompts.splice(0).forEach((p) => p.resolve(fakeStream(p.wanted)));
const deny = () => prompts.splice(0).forEach((p) => p.reject(new Error('Permission denied')));
const settle = () => new Promise((r) => setImmediate(r));

/** Enough DOM for a `<video>` and the analysis canvas. */
globalThis.document = {
  createElement(tag) {
    if (tag === 'canvas') {
      return { width: 0, height: 0, getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(4) }) }) };
    }
    const el = {
      tagName: 'VIDEO', playsInline: false, muted: false, autoplay: false,
      srcObject: null, videoWidth: 1920, videoHeight: 1080, readyState: 4,
      play: () => Promise.resolve(),
      addEventListener() {}, removeEventListener() {},
    };
    return el;
  },
};

const { createCamera } = await import('../js/control/camera.js');

/* ------------------------------------------------------------------ *
 * Two clicks, one prompt
 * ------------------------------------------------------------------ */

console.log('— clicked twice before permission arrives —');

{
  const camera = createCamera();
  const first = camera.start();
  const second = camera.start();
  grant();
  const [a, b] = await Promise.all([first, second]);
  await settle();

  ok('both clicks are answered', a !== undefined && b !== undefined);
  ok('but only one of them owns the camera',
    (a === null) !== (b === null), `${a === null ? 'first' : 'second'} superseded`);
  ok('and only one capture is open', liveTracks === 1, `${liveTracks} tracks`);
  ok('the camera is running', camera.isRunning() === true);

  camera.stop();
  await settle();
  ok('stopping it closes everything it opened', liveTracks === 0, `${liveTracks} tracks`);
}

/* ------------------------------------------------------------------ *
 * Switching device while the prompt is up
 * ------------------------------------------------------------------ */

console.log('\n— a different camera picked mid-prompt —');

{
  asked = 0;
  const camera = createCamera();
  const front = camera.start('front');
  const back = camera.start('back');
  grant();
  const [a, b] = await Promise.all([front, back]);
  await settle();

  /**
   * The one that made a second pipeline. Both were granted, both assigned the
   * stream, and the loser was never stopped — so the light stayed on for a
   * camera nothing was reading.
   */
  ok('the first request is superseded rather than left running',
    a === null && b?.deviceId === 'back', `${JSON.stringify(a)} / ${JSON.stringify(b?.deviceId)}`);
  ok('and the camera it opened is handed straight back',
    liveTracks === 1, `${liveTracks} tracks open`);

  camera.stop();
  await settle();
  ok('and nothing is left over', liveTracks === 0, `${liveTracks} tracks`);
}

/* ------------------------------------------------------------------ *
 * Switched off before permission arrives
 * ------------------------------------------------------------------ */

console.log('\n— switched off before permission arrives —');

{
  const camera = createCamera();
  const attempt = camera.start();
  camera.stop();
  grant();
  const info = await attempt;
  await settle();

  ok('the camera granted to a switch that is off is handed straight back',
    liveTracks === 0, `${liveTracks} tracks still open`);
  ok('and it says the attempt is stale', info === null, JSON.stringify(info));
  ok('and it does not claim to be running', camera.isRunning() === false);

  const again = camera.start();
  grant();
  const ok2 = await again;
  await settle();
  ok('while asking again opens it properly', ok2 !== null && liveTracks === 1);
  camera.stop();
  await settle();
}

/* ------------------------------------------------------------------ *
 * Saying no
 * ------------------------------------------------------------------ */

console.log('\n— permission refused —');

{
  const camera = createCamera();
  const attempt = camera.start();
  deny();
  let message = '';
  try { await attempt; } catch (err) { message = err.message; }
  await settle();
  ok('a refusal reaches the caller, which is what puts the toast up',
    message === 'Permission denied', message || 'nothing thrown');
  ok('and leaves nothing open', liveTracks === 0 && camera.isRunning() === false);

  const retry = camera.start();
  grant();
  await retry;
  await settle();
  ok('and asking again after a refusal still works', camera.isRunning() === true);
  camera.stop();
  await settle();
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
