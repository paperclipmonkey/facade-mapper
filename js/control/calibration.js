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
// The mesh spans the projector's coverage region exactly as the renderer
// computes it, so the same function has to define it in both places.
import { computeRegion } from '../render/warp.js';

/** Where the calibration dots sit in the projector's own normalised output. */
export const MARKER_GRID = [0.12, 0.5, 0.88];

const clampIdx = (i, n) => Math.max(0, Math.min(n - 1, i));

/**
 * An n×n grid of dot positions, inset from the edges.
 *
 * The inset matters: a dot right on the edge of the output is the one most
 * likely to land off the end of the wall, on a hedge, or outside the camera's
 * view — and a marker that cannot be found is worth less than no marker.
 *
 * Three is enough to pin down a homography with margin to spare, and a
 * homography is all a flat wall needs. Denser grids are not there to fit a
 * better plane; they are there so the *residuals* can be measured, which is
 * what corrects a surface no single plane describes.
 */
export function gridAxis(n) {
  const size = Math.max(3, Math.round(n));
  if (size === 3) return MARKER_GRID.slice();
  const inset = 0.1;
  return Array.from({ length: size }, (_, i) => inset + (i / (size - 1)) * (1 - inset * 2));
}

export function markerPositions(grid = MARKER_GRID) {
  const out = [];
  for (const t of grid) for (const s of grid) out.push([s, t]);
  return out;
}

/**
 * Turn the error left over after the homography solve into a correction mesh.
 *
 * A homography is exactly the right model for a *flat* wall and exactly the
 * wrong one for anything else. Where three faces of a house meet, no single
 * plane fits: you can line up two faces and the third is out, and no amount of
 * extra dots fixes that, because the problem is the model rather than the fit.
 *
 * So let the homography do what it is good at — the global projective mapping —
 * and measure what it gets wrong. Every dot was projected at a known position
 * and seen by the camera somewhere; the gap between where the homography says it
 * should have landed and where it actually landed *is* the surface departing
 * from flat. Feed those residuals into the warp mesh and the departure is
 * corrected. On a genuinely flat wall they are all ~0 and the mesh does nothing.
 *
 * **The mesh is indexed in camera space, not projector space.** That is the
 * whole subtlety here, and getting it wrong produces a spectacular mess rather
 * than a small error. The renderer walks a grid across its region of the *world*
 * (which is camera space), maps each point through H to get a projector
 * coordinate, and adds the mesh offset it finds at that world position:
 *
 *     s, t = H(worldU, worldV)      // projector space
 *     s += dx; t += dy              // offset looked up at (worldU, worldV)
 *
 * So the offsets are *valued* in projector space but *addressed* by world
 * position. The dots are laid out on a regular grid in projector space and land
 * on an irregular quadrilateral in camera space, so their residuals have to be
 * resampled onto a regular grid in camera space before they mean anything to the
 * renderer. Indexing them by their projector positions instead scatters every
 * correction to the wrong part of the wall.
 *
 * Resampling is inverse-distance weighting over the nearest few dots. The
 * samples are scattered and irregular by definition, the field they describe is
 * smooth, and IDW extrapolates sensibly past the outermost dot rather than
 * falling off a cliff at the edge of the grid.
 *
 * @param {Array} detections markers from a calibration pass
 * @param {number[]} H the solved camera→projector homography
 * @param {number[]} axis the grid coordinates the dots were placed on
 * @param {{x:number,y:number,w:number,h:number}} region the world-space area the
 *   projector covers, as the renderer computes it — the mesh spans exactly this
 */
export function residualMesh(detections, H, axis, region) {
  const n = axis.length;
  if (n < 3 || !region || !(region.w > 0) || !(region.h > 0)) return null;

  // Each usable dot becomes a sample: where it was seen (in mesh index space)
  // and how far the homography was wrong about it (in projector space).
  const samples = [];
  let offPlane = false;
  for (const d of detections) {
    if (!d?.camera) continue;
    const p = applyH(H, d.camera[0], d.camera[1]);
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const dx = d.projector[0] - p.x;
    const dy = d.projector[1] - p.y;
    samples.push({
      u: (d.camera[0] - region.x) / region.w,
      v: (d.camera[1] - region.y) / region.h,
      dx,
      dy,
    });
    // ~4px of a 1920-wide output. Below that it is detection noise, and baking
    // noise into the mesh makes a flat wall worse rather than better.
    if (Math.hypot(dx, dy) > 0.002) offPlane = true;
  }
  if (!offPlane || samples.length < 4) return null;

  const NEIGHBOURS = 6;
  const offsets = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const u = c / (n - 1);
      const v = r / (n - 1);
      const near = samples
        .map((s) => ({ s, d2: (s.u - u) ** 2 + (s.v - v) ** 2 }))
        .sort((a, b) => a.d2 - b.d2)
        .slice(0, NEIGHBOURS);

      // Sitting exactly on a dot: take it rather than dividing by ~zero.
      if (near[0].d2 < 1e-9) {
        offsets.push(near[0].s.dx, near[0].s.dy);
        continue;
      }
      let wsum = 0;
      let dx = 0;
      let dy = 0;
      for (const { s, d2 } of near) {
        const w = 1 / d2;
        wsum += w;
        dx += s.dx * w;
        dy += s.dy * w;
      }
      offsets.push(dx / wsum, dy / wsum);
    }
  }

  return { enabled: true, cols: n, rows: n, offsets };
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
  gridSize = 3,
  onProgress = () => {},
  signal,
}) {
  if (!camera.isRunning()) throw new Error('Start the camera before calibrating');

  const axis = gridAxis(gridSize);
  const positions = markerPositions(axis);
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

  // With a denser grid there is enough information to measure how far the wall
  // departs from the single plane the homography assumes, and correct it.
  const mesh = axis.length > 3
    ? residualMesh(detections, H, axis, computeRegion(H))
    : null;

  return {
    H,
    quality,
    mesh,
    markers: detections,
    gridSize: axis.length,
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
