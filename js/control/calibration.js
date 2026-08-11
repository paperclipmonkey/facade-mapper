/**
 * Structured-light auto-alignment.
 *
 * How it works, in one paragraph: the projector shows a black frame and the
 * camera remembers it. Then the projector lights up one bright dot at a time at
 * a known position in its own output, and for each dot the camera finds where
 * it landed on the house. Nine dots give nine pairs of "projector coordinate ->
 * camera coordinate", and because the wall is approximately a plane, those pairs
 * determine a homography exactly. From then on the app can take any point you
 * draw on the camera image and work out which projector pixel hits it.
 *
 * Why dots rather than gray-code or ArUco: dot detection needs no decoding, is
 * robust to a soft-focus projector and a noisy camera, and degrades in a way you
 * can see — a missed dot is reported, not silently mis-decoded.
 *
 * Practical notes for the user are in the README: dark-ish conditions, camera on
 * a tripod, and don't move it afterwards.
 */

import { MSG } from '../core/bus.js';
import { solveHomography, homographyError, mat3Inverse, applyH } from '../core/math.js';
import { findBrightestBlob } from './camera.js';

/** Where the calibration dots sit in the projector's own normalised output. */
export const MARKER_GRID = [0.12, 0.5, 0.88];

export function markerPositions(grid = MARKER_GRID) {
  const out = [];
  for (const t of grid) for (const s of grid) out.push([s, t]);
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a full calibration pass for one projector.
 *
 * @param {object} options
 *   bus, camera        - the message bus and camera controller
 *   projectorId        - which projector to light up
 *   settleMs           - wait after each frame lands, for projector + camera lag
 *   samples            - frames averaged per capture, to beat sensor noise
 *   onProgress         - ({ phase, index, total, message, detection }) => void
 * @returns {Promise<{H:number[], quality:object, markers:Array}>}
 */
export async function runCalibration({
  bus,
  camera,
  projectorId,
  settleMs = 320,
  samples = 3,
  markerRadius = 0.045,
  onProgress = () => {},
  signal,
}) {
  if (!camera.isRunning()) throw new Error('Start the camera before calibrating');

  const positions = markerPositions();
  const detections = [];

  const abortIfCancelled = () => {
    if (signal?.aborted) throw new Error('Calibration cancelled');
  };

  /** Show a frame on the projector and wait until it confirms it's on screen. */
  async function showFrame(payload) {
    const ack = bus
      .once(MSG.CALIB_ACK, (p) => p.projectorId === projectorId || !p.projectorId, 2500)
      .catch(() => null);
    bus.post(MSG.CALIB, { projectorId, ...payload });
    await ack;
    await sleep(settleMs);
  }

  /** Average several frames — a single frame is noisy enough to move a centroid. */
  async function captureAveraged() {
    let accumulator = null;
    let width = 0;
    let height = 0;
    for (let i = 0; i < samples; i++) {
      const frame = camera.captureLuma();
      if (!frame) throw new Error('Camera stopped during calibration');
      if (!accumulator) {
        accumulator = new Float32Array(frame.luma.length);
        width = frame.width;
        height = frame.height;
      }
      for (let p = 0; p < accumulator.length; p++) accumulator[p] += frame.luma[p];
      if (i < samples - 1) await sleep(45);
    }
    for (let p = 0; p < accumulator.length; p++) accumulator[p] /= samples;
    return { luma: accumulator, width, height };
  }

  try {
    onProgress({ phase: 'reference', index: 0, total: positions.length, message: 'Measuring ambient light…' });
    await showFrame({ kind: 'black', index: -1 });
    const reference = await captureAveraged();
    abortIfCancelled();

    // A quick sanity check: a fully white frame should be clearly brighter than
    // black. If it isn't, the camera isn't pointing at this projector at all,
    // and there's no sense running nine more captures to find that out.
    onProgress({ phase: 'check', index: 0, total: positions.length, message: 'Checking the camera can see this projector…' });
    await showFrame({ kind: 'white', index: -2 });
    const white = await captureAveraged();
    let brightestDelta = 0;
    for (let i = 0; i < white.luma.length; i++) {
      brightestDelta = Math.max(brightestDelta, white.luma[i] - reference.luma[i]);
    }
    if (brightestDelta < 12) {
      throw new Error(
        'The camera cannot see this projector. Check the projector tab is fullscreen on the right display, the camera is pointed at the house, and the scene is dark enough.'
      );
    }

    for (let i = 0; i < positions.length; i++) {
      abortIfCancelled();
      onProgress({
        phase: 'marker',
        index: i,
        total: positions.length,
        message: `Locating marker ${i + 1} of ${positions.length}…`,
      });

      await showFrame({ kind: 'marker', index: i, positions: [positions[i]], radius: markerRadius });
      const frame = await captureAveraged();
      const blob = findBrightestBlob(frame.luma, reference.luma, frame.width, frame.height);

      detections.push(
        blob
          ? { projector: positions[i], camera: [blob.x, blob.y], strength: blob.strength, pixels: blob.pixels }
          : { projector: positions[i], camera: null, strength: 0, pixels: 0 }
      );
      onProgress({
        phase: 'marker',
        index: i,
        total: positions.length,
        message: blob ? `Marker ${i + 1} found` : `Marker ${i + 1} not visible`,
        detection: detections[i],
      });
    }
  } finally {
    bus.post(MSG.CALIB, { projectorId, kind: 'end' });
  }

  const found = detections.filter((d) => d.camera);
  if (found.length < 4) {
    throw new Error(
      `Only ${found.length} of ${positions.length} markers were visible. Make sure the whole projected area is inside the camera view and the surroundings are dark.`
    );
  }

  const src = found.map((d) => ({ x: d.camera[0], y: d.camera[1] }));
  const dst = found.map((d) => ({ x: d.projector[0], y: d.projector[1] }));
  let H = solveHomography(src, dst);
  if (!H) throw new Error('Could not solve the alignment. The detected markers may be collinear.');

  let quality = assessQuality(H, src, dst);

  // One robustness pass: drop the worst correspondence and re-solve if that
  // clearly helps. A single bad detection (a reflection, a passing car) is the
  // common failure, and it's cheap to shrug off.
  if (found.length > 5 && quality.maxNorm > 0.012) {
    const errors = src.map((s, i) => {
      const p = applyH(H, s.x, s.y);
      return p ? Math.hypot(p.x - dst[i].x, p.y - dst[i].y) : Infinity;
    });
    const worst = errors.indexOf(Math.max(...errors));
    const trimmedSrc = src.filter((_, i) => i !== worst);
    const trimmedDst = dst.filter((_, i) => i !== worst);
    const retry = solveHomography(trimmedSrc, trimmedDst);
    if (retry) {
      const retryQuality = assessQuality(retry, trimmedSrc, trimmedDst);
      if (retryQuality.meanNorm < quality.meanNorm * 0.7) {
        H = retry;
        quality = { ...retryQuality, discarded: 1 };
      }
    }
  }

  if (!mat3Inverse(H)) {
    throw new Error('The alignment came out degenerate. Try again with the markers spread further apart.');
  }

  return {
    H,
    quality,
    markers: detections,
    calibratedAt: Date.now(),
  };
}

function assessQuality(H, src, dst) {
  const { mean, max, count } = homographyError(H, src, dst);
  return {
    meanNorm: mean,
    maxNorm: max,
    // Expressed against a nominal 1920-wide output, which is easier to reason
    // about than a fraction of the frame.
    meanPx: mean * 1920,
    maxPx: max * 1920,
    points: count,
    rating: mean < 0.004 ? 'excellent' : mean < 0.01 ? 'good' : mean < 0.02 ? 'usable' : 'poor',
  };
}

/**
 * Re-measure an already-calibrated projector to see whether anything moved.
 *
 * The point of this is the day-two problem: the mapping is saved, but did the
 * gardener knock the projector? Rather than recalibrating blind, this reports
 * how far off the existing homography now is, so you can decide.
 */
export async function checkDrift({ bus, camera, projector, settleMs = 300, samples = 3, onProgress = () => {}, signal }) {
  const H = projector?.calibration?.H;
  if (!H) throw new Error('This projector has not been aligned yet');

  const fresh = await runCalibration({
    bus,
    camera,
    projectorId: projector.id,
    settleMs,
    samples,
    onProgress,
    signal,
  });

  // Compare where the old mapping says the markers should be against where they
  // actually turned up this time.
  const deltas = [];
  for (const detection of fresh.markers) {
    if (!detection.camera) continue;
    const predicted = applyH(H, detection.camera[0], detection.camera[1]);
    if (!predicted) continue;
    deltas.push(Math.hypot(predicted.x - detection.projector[0], predicted.y - detection.projector[1]));
  }

  const mean = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : Infinity;
  const max = deltas.length ? Math.max(...deltas) : Infinity;

  return {
    fresh,
    drift: {
      meanNorm: mean,
      maxNorm: max,
      meanPx: mean * 1920,
      maxPx: max * 1920,
      points: deltas.length,
      moved: mean > 0.006,
    },
  };
}

/**
 * Manual fallback: you tell the app where the projector's four corners land in
 * the camera view, and it solves the same homography from those.
 *
 * Slower and less accurate than the automatic pass, but it works when the camera
 * can't see well enough — a bright evening, a distant projector, a phone camera
 * that insists on auto-exposing.
 */
export function solveFromCorners(worldQuad) {
  if (!Array.isArray(worldQuad) || worldQuad.length !== 4) return null;
  const src = worldQuad.map((p) => ({ x: p.x, y: p.y }));
  const dst = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  const H = solveHomography(src, dst);
  if (!H || !mat3Inverse(H)) return null;
  return { H, quality: { ...assessQuality(H, src, dst), rating: 'manual' } };
}

/** The projector's output boundary, expressed in world space, for the preview overlay. */
export function projectorOutline(H, steps = 1) {
  const inv = H ? mat3Inverse(H) : null;
  if (!inv) return null;
  const corners = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const out = [];
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    for (let s = 0; s < steps; s++) {
      const f = s / steps;
      // Sampling along the edges rather than just the corners keeps the outline
      // correct when the perspective is extreme enough to bow the edges.
      const p = applyH(inv, a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f);
      if (!p) return null;
      out.push(p);
    }
  }
  return out;
}
