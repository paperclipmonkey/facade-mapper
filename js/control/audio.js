/**
 * Microphone analysis for audio-reactive effects.
 *
 * Only the control tab opens the microphone; it broadcasts band levels to the
 * projector tabs several times a second. One permission prompt, one analyser,
 * and — more importantly — every projector reacts to exactly the same numbers,
 * so a bass hit lands on all of them in the same frame.
 */

const BANDS = {
  low: [20, 250],
  mid: [250, 2000],
  high: [2000, 12000],
};

export function createAudioAnalyser({ onLevels } = {}) {
  let context = null;
  let analyser = null;
  let stream = null;
  let data = null;
  let timer = null;
  let gain = 1;

  /**
   * The gap between asking for the microphone and getting it.
   *
   * `getUserMedia` does not resolve until somebody answers the browser's
   * permission prompt, which can be a while, and the page stays live
   * underneath it — so the checkbox that started this can be clicked again,
   * twice, or switched back off before the answer arrives. `analyser` is still
   * null throughout, so it guarded none of that:
   *
   *   - A second click opened a second stream, context and interval. The first
   *     set was overwritten and leaked, and `stop` could then only ever close
   *     one of them, leaving the recording light on for the rest of the
   *     evening.
   *   - Switching it back off while the prompt was up stopped nothing, because
   *     there was nothing yet to stop. Granting permission afterwards started
   *     the microphone anyway, with the switch reading *off*.
   *
   * `starting` collapses concurrent calls onto one attempt; `wanted` is the
   * switch's own position, checked again on the far side of the await so an
   * attempt nobody is waiting for any more tidies itself away.
   */
  let starting = null;
  let wanted = false;

  const levels = { level: 0, low: 0, mid: 0, high: 0 };

  async function open() {
    const media = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Echo cancellation and noise suppression are tuned for speech and will
        // happily gate out exactly the music we want to follow.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    if (!wanted) {
      for (const track of media.getTracks()) track.stop();
      return false;
    }
    stream = media;
    context = new (window.AudioContext || window.webkitAudioContext)();
    const source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.75;
    source.connect(analyser);
    data = new Uint8Array(analyser.frequencyBinCount);

    timer = setInterval(sample, 33);
    return true;
  }

  async function start() {
    wanted = true;
    if (analyser) return true;
    if (!starting) {
      starting = open().finally(() => {
        starting = null;
      });
    }
    return starting;
  }

  function binRange(loHz, hiHz) {
    const nyquist = context.sampleRate / 2;
    const bins = analyser.frequencyBinCount;
    return [
      Math.max(0, Math.floor((loHz / nyquist) * bins)),
      Math.min(bins - 1, Math.ceil((hiHz / nyquist) * bins)),
    ];
  }

  function sample() {
    if (!analyser) return;
    analyser.getByteFrequencyData(data);

    let total = 0;
    for (let i = 0; i < data.length; i++) total += data[i];
    const overall = total / data.length / 255;

    const next = { level: overall * gain, low: 0, mid: 0, high: 0 };
    for (const [name, [lo, hi]] of Object.entries(BANDS)) {
      const [start, end] = binRange(lo, hi);
      let sum = 0;
      for (let i = start; i <= end; i++) sum += data[i];
      next[name] = Math.min(2, (sum / Math.max(1, end - start + 1) / 255) * gain);
    }
    next.level = Math.min(2, next.level);

    // Light extra smoothing on top of the analyser's own: raw frames are jumpy
    // enough that a brightness bound to `level` visibly flickers.
    for (const key of Object.keys(levels)) {
      levels[key] = levels[key] * 0.55 + next[key] * 0.45;
    }
    onLevels?.({ ...levels });
  }

  function stop() {
    wanted = false;
    clearInterval(timer);
    timer = null;
    if (stream) for (const track of stream.getTracks()) track.stop();
    stream = null;
    analyser = null;
    context?.close().catch(() => {});
    context = null;
    for (const key of Object.keys(levels)) levels[key] = 0;
    onLevels?.({ ...levels });
  }

  return {
    start,
    stop,
    isRunning: () => !!analyser,
    setGain: (value) => {
      gain = Math.max(0.05, value || 1);
    },
    get levels() {
      return { ...levels };
    },
  };
}
