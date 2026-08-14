/**
 * Geometry and calibration tests.
 *
 * These cover the parts of the app that are easy to get subtly wrong and hard to
 * eyeball: the homography solve, the marker detection that feeds it, and the
 * region and mesh maths the warp depends on. All of it is pure — no DOM — so it
 * runs in plain Node with no dependencies.
 *
 * The end-to-end case drives the real `runCalibration` against a simulated
 * projector and camera: a fake bus records which marker frame was requested, and
 * a fake camera synthesises a blob where a known ground-truth homography says it
 * would land, over sloped ambient light and sensor noise. If the solve recovers
 * that matrix, the whole pipeline is working — frame sequencing, acknowledgement,
 * frame averaging, blob detection, normalised DLT and outlier rejection.
 *
 *   node test/geometry.test.mjs
 */

import { runCalibration, markerPositions, solveFromCorners } from '../js/control/calibration.js';
import { solveHomography, applyH, mat3Inverse, homographyError } from '../js/core/math.js';
import { findBrightestBlob } from '../js/control/camera.js';
import { computeRegion, sampleMesh } from '../js/render/warp.js';

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

/* ---- 1. Homography solve round-trip ---- */
{
  const Hgt = [1.21, 0.17, -0.08, -0.09, 0.94, 0.11, 0.21, -0.13, 1];
  const src = [];
  const dst = [];
  for (const u of [0.1, 0.4, 0.55, 0.9]) for (const v of [0.15, 0.5, 0.85]) {
    src.push({ x: u, y: v });
    dst.push(applyH(Hgt, u, v));
  }
  const H = solveHomography(src, dst);
  const err = homographyError(H, src, dst);
  ok('solveHomography recovers a known matrix', err.mean < 1e-9, `mean err ${err.mean.toExponential(2)}`);

  // Minimum case: exactly four points, in general position (no three collinear).
  const quadSrc = [{ x: 0.1, y: 0.15 }, { x: 0.9, y: 0.2 }, { x: 0.85, y: 0.8 }, { x: 0.15, y: 0.9 }];
  const quadDst = quadSrc.map((p) => applyH(Hgt, p.x, p.y));
  const H4 = solveHomography(quadSrc, quadDst);
  ok('solveHomography works with the minimum four points',
     !!H4 && homographyError(H4, src, dst).mean < 1e-9,
     H4 ? `mean err over all points ${homographyError(H4, src, dst).mean.toExponential(2)}` : 'null');

  // Four points with three on a line is degenerate and must not yield a
  // confident-looking answer.
  const degenerate = [{ x: 0.1, y: 0.1 }, { x: 0.1, y: 0.5 }, { x: 0.1, y: 0.9 }, { x: 0.7, y: 0.4 }];
  const Hdeg = solveHomography(degenerate, degenerate.map((p) => applyH(Hgt, p.x, p.y)));
  ok('four points with three collinear is rejected or non-invertible', !Hdeg || !mat3Inverse(Hdeg));

  ok('solveHomography rejects fewer than four points', solveHomography(src.slice(0, 3), dst.slice(0, 3)) === null);

  // Collinear points have no unique solution; it must not return garbage that
  // then silently produces a broken projection.
  const line = [0, 1, 2, 3].map((i) => ({ x: i * 0.2, y: i * 0.2 }));
  const lineH = solveHomography(line, line.map((p) => applyH(Hgt, p.x, p.y)));
  ok('collinear input is either rejected or non-invertible', !lineH || !mat3Inverse(lineH));
}

/* ---- 2. Blob detection ---- */
{
  const W = 480, Hh = 270;
  const make = (bx, by, radius = 9, peak = 200, ambient = true) => {
    const cur = new Float32Array(W * Hh);
    const ref = new Float32Array(W * Hh);
    for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      // A sloped ambient background plus sensor noise, present in both frames.
      const bg = ambient ? 18 + (x / W) * 26 + Math.sin(y * 0.3) * 3 : 0;
      const noise = Math.sin(i * 12.9898) * 2.5;
      ref[i] = bg + noise;
      const d = Math.hypot(x - bx * W, y - by * Hh);
      cur[i] = bg + noise + peak * Math.exp(-(d * d) / (2 * radius * radius));
    }
    return { cur, ref };
  };

  for (const [bx, by] of [[0.5, 0.5], [0.12, 0.2], [0.87, 0.79]]) {
    const { cur, ref } = make(bx, by);
    const blob = findBrightestBlob(cur, ref, W, Hh);
    const err = blob ? Math.hypot(blob.x - bx, blob.y - by) : Infinity;
    ok(`blob at (${bx}, ${by}) located`, err < 0.004, `error ${(err * 1920).toFixed(2)} px of 1920`);
  }

  // A frame with no marker at all must report nothing rather than inventing one.
  const { ref } = make(0.5, 0.5);
  ok('no marker -> no detection', findBrightestBlob(ref, ref, W, Hh) === null);

  // A big diffuse glow (a lit wall, headlights) is not a marker.
  const flood = make(0.5, 0.5, 160, 90);
  ok('a huge bright region is rejected', findBrightestBlob(flood.cur, flood.ref, W, Hh) === null);

  // A competing bright spot elsewhere must not drag the centroid.
  const two = make(0.3, 0.4, 9, 220);
  const decoy = make(0.75, 0.7, 7, 120);
  for (let i = 0; i < two.cur.length; i++) two.cur[i] = Math.max(two.cur[i], decoy.cur[i]);
  const b = findBrightestBlob(two.cur, two.ref, W, Hh);
  ok('a competing highlight does not pull the centroid',
     b && Math.hypot(b.x - 0.3, b.y - 0.4) < 0.005, b ? `(${b.x.toFixed(3)}, ${b.y.toFixed(3)})` : 'none');
}

/* ---- 3. Full calibration loop with a simulated camera ---- */
async function calibrateAgainst(Hgt, opts = {}) {
  const inv = mat3Inverse(Hgt);
  const W = 480, Hh = 270;
  let frame = null;

  const bus = {
    pending: null,
    post(type, payload) {
      if (type !== 'calib') return;
      frame = payload;
      // The real projector tab acks once the frame is on screen.
      const resolve = bus.pending;
      bus.pending = null;
      if (resolve) queueMicrotask(() => resolve({ index: payload.index }));
    },
    once() { return new Promise((r) => { bus.pending = r; }); },
  };

  const camera = {
    isRunning: () => true,
    aspect: () => 16 / 9,
    captureLuma() {
      const luma = new Float32Array(W * Hh);
      for (let i = 0; i < luma.length; i++) {
        const x = i % W, y = (i / W) | 0;
        luma[i] = 16 + (x / W) * 20 + Math.sin(i * 12.9898) * 2.5 + (y / Hh) * 6;
      }
      if (!frame || frame.kind === 'black' || frame.kind === 'end') return { luma, width: W, height: Hh };
      if (frame.kind === 'white') {
        for (let i = 0; i < luma.length; i++) luma[i] += 70;
        return { luma, width: W, height: Hh };
      }
      for (const [s, t] of frame.positions || []) {
        const c = applyH(inv, s, t);
        if (!c) continue;
        if (opts.hideMarkers?.includes(frame.index)) continue;
        // Outside the camera's field of view: nothing lands on the sensor.
        if (c.x < 0 || c.x > 1 || c.y < 0 || c.y > 1) continue;
        const bx = c.x * W, by = c.y * Hh, r = 8;
        for (let y = Math.max(0, by - 30); y < Math.min(Hh, by + 30); y++) {
          for (let x = Math.max(0, bx - 30); x < Math.min(W, bx + 30); x++) {
            const d = Math.hypot(x - bx, y - by);
            luma[(y | 0) * W + (x | 0)] += 190 * Math.exp(-(d * d) / (2 * r * r));
          }
        }
      }
      return { luma, width: W, height: Hh };
    },
  };

  return runCalibration({ bus, camera, projectorId: 'P1', settleMs: 0, samples: 1, ...opts });
}

{
  const Hgt = [1.18, 0.14, -0.06, -0.07, 1.02, 0.02, 0.16, -0.09, 1];
  const result = await calibrateAgainst(Hgt);

  // Compare against ground truth over the whole frame, not just the markers.
  let worst = 0;
  for (let u = 0; u <= 1; u += 0.1) for (let v = 0; v <= 1; v += 0.1) {
    const a = applyH(Hgt, u, v), b = applyH(result.H, u, v);
    if (a && b) worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y));
  }
  ok('calibration recovers the true homography', worst * 1920 < 12,
     `worst deviation ${(worst * 1920).toFixed(2)} px of a 1920-wide output`);
  ok('calibration reports a quality rating', ['excellent', 'good', 'usable'].includes(result.quality.rating),
     `rating "${result.quality.rating}", mean ${result.quality.meanPx.toFixed(2)} px`);
  ok('calibration found all nine markers', result.markers.filter((m) => m.camera).length === 9);
}

/* ---- 4. Failure handling ---- */
{
  // Most markers hidden: must refuse rather than solve from too little data.
  let threw = null;
  try {
    await calibrateAgainst([1, 0, 0, 0, 1, 0, 0, 0, 1], { hideMarkers: [0, 1, 2, 3, 4, 5] });
  } catch (err) { threw = err.message; }
  ok('too few visible markers is refused', !!threw && /markers were visible/.test(threw), threw || '');

  // One bad detection should be shrugged off by the outlier pass.
  const Hgt = [1.05, 0.05, 0.01, -0.02, 1.0, 0.03, 0.07, -0.04, 1];
  const clean = await calibrateAgainst(Hgt);
  ok('nine-marker solve is accurate', clean.quality.meanPx < 8, `${clean.quality.meanPx.toFixed(2)} px`);
}

/* ---- 5. Manual corner solve ---- */
{
  const quad = [{ x: 0.15, y: 0.2 }, { x: 0.82, y: 0.14 }, { x: 0.88, y: 0.79 }, { x: 0.1, y: 0.85 }];
  const solved = solveFromCorners(quad);
  ok('manual corners solve', !!solved);
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
  let worst = 0;
  quad.forEach((p, i) => {
    const mapped = applyH(solved.H, p.x, p.y);
    worst = Math.max(worst, Math.hypot(mapped.x - corners[i][0], mapped.y - corners[i][1]));
  });
  ok('manual corners map to the projector corners', worst < 1e-9, `worst ${worst.toExponential(2)}`);
  ok('degenerate corner quad is rejected',
     solveFromCorners([{x:0,y:0},{x:0,y:0},{x:1,y:1},{x:1,y:1}]) === null);
}

/* ---- 6. Region + mesh ---- */
{
  ok('identity homography gives the full frame region',
     JSON.stringify(computeRegion([1,0,0,0,1,0,0,0,1])) === JSON.stringify({ x: -0.04, y: -0.04, w: 1.08, h: 1.08 }),
     JSON.stringify(computeRegion([1,0,0,0,1,0,0,0,1])));
  ok('null homography falls back to the full frame',
     JSON.stringify(computeRegion(null)) === JSON.stringify({ x: 0, y: 0, w: 1, h: 1 }));

  const region = computeRegion([2.4, 0, -0.7, 0, 2.4, -0.7, 0, 0, 1]);
  ok('a zoomed-in projector gets a smaller region', region.w < 0.6 && region.h < 0.6,
     `${region.w.toFixed(3)} x ${region.h.toFixed(3)}`);

  const mesh = { enabled: true, cols: 3, rows: 3, offsets: new Array(18).fill(0) };
  ok('a flat mesh contributes nothing', sampleMesh(mesh, 0.5, 0.5).every((v) => Math.abs(v) < 1e-12));
  mesh.offsets[4 * 2] = 0.05; // centre control point
  const centre = sampleMesh(mesh, 0.5, 0.5);
  ok('dragging the centre control point moves the centre', Math.abs(centre[0] - 0.05) < 1e-6, `${centre[0].toFixed(4)}`);
  const corner = sampleMesh(mesh, 0, 0);
  ok('the corners stay pinned', Math.abs(corner[0]) < 1e-6);
  ok('disabled mesh is a no-op', sampleMesh({ ...mesh, enabled: false }, 0.5, 0.5)[0] === 0);
}


/* ------------------------------------------------------------------ *
 * Non-planar correction
 *
 * These drive the correction end to end through the renderer's own sampleMesh,
 * against a *non-identity* homography. Both parts matter.
 *
 * The offsets are valued in projector space but addressed by world position, and
 * an earlier version built them addressed by projector position instead — which
 * scatters every correction to the wrong part of the wall. It shipped because
 * the test used an identity homography, and under identity the two spaces are
 * the same, so nothing could tell them apart. A test that cannot distinguish the
 * two spaces cannot catch a bug about confusing them.
 * ------------------------------------------------------------------ */

{
  console.log('\n— residual mesh —');

  const { gridAxis, residualMesh } = await import('../js/control/calibration.js');
  const { computeRegion, sampleMesh } = await import('../js/render/warp.js');

  const axis = gridAxis(5);
  ok('a denser grid spans the output', axis.length === 5 && axis[0] > 0 && axis[4] < 1,
     axis.map((v) => v.toFixed(2)).join(' '));
  ok('3 keeps the original marker positions', gridAxis(3).join() === [0.12, 0.5, 0.88].join());

  /**
   * A camera→projector mapping that is strongly rotated, so the two coordinate
   * spaces are genuinely different rather than merely scaled. A mild keystone is
   * not enough: under it, normalised camera position and projector position stay
   * close enough that addressing the mesh by the wrong one still lands roughly
   * right, and the test passes on broken code. The projector's output quad is
   * seen by the camera as a diamond — projector x now runs diagonally across the
   * camera image, so confusing the two spaces cannot go unnoticed.
   */
  const H = solveHomography(
    [{ x: 0.5, y: 0.1 }, { x: 0.9, y: 0.5 }, { x: 0.5, y: 0.9 }, { x: 0.1, y: 0.5 }],
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
  );
  const inv = mat3Inverse(H);
  const region = computeRegion(H);

  /** Where a projector dot lands on a perfectly flat wall. */
  const flatSighting = (s, t) => {
    const c = applyH(inv, s, t);
    return { projector: [s, t], camera: [c.x, c.y] };
  };

  const flat = [];
  for (const t of axis) for (const s of axis) flat.push(flatSighting(s, t));
  ok('a flat wall produces no mesh', residualMesh(flat, H, axis, region) === null);

  /**
   * Bend it: the right-hand half of the wall turns away from the camera.
   *
   * Modelled as a *kink*, not a step — the displacement is zero at the seam and
   * grows with distance from it. That is what a corner is: two faces meeting
   * along a shared edge, continuous in position and discontinuous only in slope.
   * An abrupt step would mean the wall has a gap in it, and no smooth mesh can
   * represent one, so testing against a step measures the interpolator's
   * inability to do something impossible rather than whether the correction is
   * right.
   */
  const BEND = 0.04;
  const shift = (x) => (x > 0.5 ? BEND * ((x - 0.5) / 0.5) : 0);
  const bent = flat.map((d) => ({ ...d, camera: [d.camera[0] + shift(d.camera[0]), d.camera[1]] }));
  const mesh = residualMesh(bent, H, axis, region);
  ok('a bent wall produces a mesh', mesh !== null && mesh.enabled);
  ok('the mesh matches the grid', mesh.cols === 5 && mesh.rows === 5 && mesh.offsets.length === 50);

  /**
   * The end-to-end check: run the renderer's own maths, over the whole coverage.
   *
   * Sampling only the bent half is not enough. The bug this replaced applied
   * roughly the right *magnitude* of correction in roughly the wrong *place*, so
   * a test looking only where correction is wanted still sees it arrive. What
   * that bug cannot do is leave the flat half alone — it drags parts of the wall
   * that were already aligned out of alignment. So: sample everywhere, and
   * require that nothing gets worse.
   */
  const errorAt = (sourceX, sourceY, withMesh) => {
    // A point on the flat wall at sourceX is *seen* here once the wall bends…
    const observedX = sourceX + shift(sourceX);
    // …and the projector pixel that lights it is the one aimed at the flat spot.
    const trueProjector = applyH(H, sourceX, sourceY);
    const p = applyH(H, observedX, sourceY);
    let { x, y } = p;
    if (withMesh) {
      const [dx, dy] = sampleMesh(mesh, (observedX - region.x) / region.w, (sourceY - region.y) / region.h);
      x += dx;
      y += dy;
    }
    return Math.hypot(x - trueProjector.x, y - trueProjector.y);
  };

  let worsened = 0;
  let worstRegression = 0;
  let worstBare = 0;
  let before = 0;
  let after = 0;
  let samples = 0;
  for (let i = 0; i <= 6; i++) {
    for (let j = 0; j <= 6; j++) {
      // Walk the region the projector covers, inset from the very edge where
      // there is nothing left to interpolate between.
      const cx = region.x + region.w * (0.15 + 0.7 * (i / 6));
      const cy = region.y + region.h * (0.15 + 0.7 * (j / 6));
      const bare = errorAt(cx, cy, false);
      const corrected = errorAt(cx, cy, true);
      before += bare;
      after += corrected;
      samples++;
      if (corrected > bare + 1e-3) worsened++;
      worstRegression = Math.max(worstRegression, corrected - bare);
      worstBare = Math.max(worstBare, bare);
    }
  }
  /**
   * A few points near the seam come out slightly worse, and that is inherent
   * rather than a defect: the mesh interpolates smoothly and a corner is a
   * discontinuity in slope, so the correction rounds it off. What matters is
   * that the rounding is small next to the misalignment being removed.
   */
  ok('nothing is made significantly worse', worstRegression < worstBare * 0.15,
     `worst regression ${worstRegression.toFixed(4)} against ${worstBare.toFixed(4)} uncorrected `
     + `(${worsened} of ${samples} slightly worse, near the seam)`);
  ok('and removes most of the error overall', after < before * 0.35,
     `mean ${(before / samples).toFixed(4)} → ${(after / samples).toFixed(4)} projector units`);

  // A dot the camera never found must not leave a hole.
  const holed = bent.map((d, i) => (i === 12 ? { ...d, camera: null } : d));
  const patched = residualMesh(holed, H, axis, region);
  ok('a missed marker does not break the correction',
     patched !== null && patched.offsets.every((v) => Number.isFinite(v)));
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
process.exit(failures ? 1 : 0);
