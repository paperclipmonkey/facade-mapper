/**
 * Opening the microphone, and the gap in the middle of it.
 *
 * `getUserMedia` does not resolve until somebody answers the browser's
 * permission prompt. That prompt does not freeze the page, so everything the
 * switch beside it can do — being clicked again, being clicked twice, being
 * switched back off — happens *while the microphone is neither open nor
 * closed*, and the guard on it (`if (analyser) return`) is looking at a
 * variable that is still null throughout.
 *
 * The two ways that ends badly are both silent, and both leave the recording
 * light on: a second click opens a whole second stream, context and interval
 * that the first set is then overwritten by and `stop` can never reach; and
 * switching it off before permission arrives stops nothing, so granting it
 * afterwards opens the microphone with the switch reading off.
 *
 * The browser here is a stand-in with a permission prompt you answer by hand,
 * which is the only way to be standing in the gap when the second click lands.
 *
 *   node test/mic.test.mjs
 */

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

/* ------------------------------------------------------------------ *
 * A microphone that only opens when this file says so
 * ------------------------------------------------------------------ */

let opened = 0;
let liveTracks = 0;
let contexts = 0;
let liveContexts = 0;
/** Resolvers for the permission prompts currently on screen. */
const prompts = [];

function fakeStream() {
  liveTracks++;
  const track = { stop() { liveTracks--; } };
  return { getTracks: () => [track] };
}

// Node ships a read-only `navigator`, so the stand-in is defined over it.
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    mediaDevices: {
      getUserMedia() {
        opened++;
        return new Promise((resolve, reject) => prompts.push({ resolve, reject }));
      },
    },
  },
});

globalThis.window = {
  AudioContext: class {
    constructor() {
      contexts++;
      liveContexts++;
      this.sampleRate = 48000;
    }
    createMediaStreamSource() {
      return { connect() {} };
    }
    createAnalyser() {
      return {
        fftSize: 0,
        smoothingTimeConstant: 0,
        frequencyBinCount: 512,
        getByteFrequencyData() {},
      };
    }
    close() {
      liveContexts--;
      return Promise.resolve();
    }
  },
};

/**
 * Answer every prompt currently on screen.
 *
 * All of them, deliberately: a regression that asks twice would otherwise
 * leave the second `start()` waiting on a prompt nobody answers, and this file
 * would hang instead of saying what went wrong.
 */
const grant = () => prompts.splice(0).forEach((p) => p.resolve(fakeStream()));
const deny = () => prompts.splice(0).forEach((p) => p.reject(new Error('Permission denied')));
/** Let the promise chain run to the end without advancing any timers. */
const settle = () => new Promise((r) => setImmediate(r));

const { createAudioAnalyser } = await import('../js/control/audio.js');

/* ------------------------------------------------------------------ *
 * Clicking it twice before the prompt is answered
 * ------------------------------------------------------------------ */

console.log('— two clicks, one prompt —');

{
  const mic = createAudioAnalyser({});
  const first = mic.start();
  const second = mic.start();
  ok('a second click while the prompt is up does not ask twice', opened === 1, `${opened} asked`);

  grant();
  await Promise.all([first, second]);
  await settle();

  ok('and only one microphone is open', liveTracks === 1, `${liveTracks} tracks`);
  ok('behind one audio context', liveContexts === 1, `${liveContexts} contexts`);
  ok('the analyser is running', mic.isRunning() === true);

  mic.stop();
  await settle();

  /**
   * The whole point. Two contexts and two streams meant `stop` could reach only
   * the second pair, and the recording light stayed on for the rest of the
   * evening with nothing on screen to explain it.
   */
  ok('and stopping it closes everything it opened',
    liveTracks === 0 && liveContexts === 0, `${liveTracks} tracks, ${liveContexts} contexts`);
  ok('and it says it is stopped', mic.isRunning() === false);
}

/* ------------------------------------------------------------------ *
 * Changing your mind while the prompt is up
 * ------------------------------------------------------------------ */

console.log('\n— switched off before permission arrives —');

{
  opened = 0;
  contexts = 0;
  const mic = createAudioAnalyser({});
  const attempt = mic.start();
  mic.stop();                    // the switch goes back off, prompt still up
  grant();                       // ...and only now is permission granted
  await attempt;
  await settle();

  ok('the microphone granted to a switch that is off is handed straight back',
    liveTracks === 0, `${liveTracks} tracks still open`);
  ok('and no audio context is built for it', contexts === 0, `${contexts} contexts`);
  ok('and it does not claim to be running', mic.isRunning() === false);

  // And it still works when you mean it.
  const again = mic.start();
  grant();
  await again;
  await settle();
  ok('while asking again opens it properly', mic.isRunning() === true && liveTracks === 1);
  mic.stop();
  await settle();
}

/* ------------------------------------------------------------------ *
 * Saying no
 * ------------------------------------------------------------------ */

console.log('\n— permission refused —');

{
  const mic = createAudioAnalyser({});
  const attempt = mic.start();
  deny();
  let message = '';
  try {
    await attempt;
  } catch (err) {
    message = err.message;
  }
  await settle();
  ok('a refusal reaches the caller, which is what puts the toast up',
    message === 'Permission denied', message || 'nothing thrown');
  ok('and leaves nothing open', mic.isRunning() === false && liveTracks === 0);

  // Refusing once must not wedge it: the prompt can be answered differently.
  const retry = mic.start();
  grant();
  await retry;
  await settle();
  ok('and asking again after a refusal still works', mic.isRunning() === true);
  mic.stop();
  await settle();
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
