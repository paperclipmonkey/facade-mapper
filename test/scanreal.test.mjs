/**
 * A scan of a real front garden, and the four ways it used to defeat this.
 *
 * `depth.test.mjs` builds a clean wall and checks the geometry comes back. That
 * is the right test for the arithmetic and the wrong one for the pipeline,
 * because nothing it contains is what actually arrives. A phone scan of the
 * front of a house contains:
 *
 *  - **the ground**, which is bigger and flatter than the facade and scanned
 *    from closer, so it wins a plain largest-plane search;
 *  - **a hedge**, standing further out of the wall than the bay window does;
 *  - **the neighbour's wall**, well behind the plane;
 *  - **windows with no glass in them**, because photogrammetry has nothing to
 *    match on a pane and returns a hole the size of the window.
 *
 * Each of those produced a plausible-looking relief map and a completely useless
 * set of shapes. This builds all four and insists the wall still comes out.
 *
 *   node test/scanreal.test.mjs
 */

import {
  fitPlane,
  orientPlane,
  bakeRelief,
  levelRelief,
  fillHoles,
  findOpenings,
  meanNormalNear,
  planeExtent,
  isSeen,
} from '../js/core/depth.js';

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ------------------------------------------------------------------ *
 * The scene
 *
 * Wall coordinates: x across the facade, y up it, z out of it. The whole scene
 * is then yawed and shoved somewhere arbitrary, as a scan is.
 * ------------------------------------------------------------------ */

const WALL_W = 9;
const WALL_H = 6.4;
const WINDOWS = [
  { x: 1.1, y: 3.6, w: 1.25, h: 1.45 },
  { x: 4.0, y: 3.6, w: 1.25, h: 1.45 },
  { x: 6.9, y: 3.6, w: 1.25, h: 1.45 },
];
const DOOR = { x: 4.2, y: 0, w: 0.95, h: 2.05 };
/** A bay standing well proud — the thing that was being missed. */
const BAY = { x: 0.8, y: 0.25, w: 2.7, h: 2.4, out: 0.75 };
const inBox = (x, y, b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;

const noise = (x, y, f, seed) => {
  const s = Math.sin((x * f + seed) * 12.9898 + (y * f + seed) * 78.233) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
};

/** Relief of the facade itself, in metres. */
function facade(x, y) {
  if (inBox(x, y, BAY)) {
    // Panes set back into the bay's own front.
    const inset = 0.2;
    if (y > BAY.y + 0.45 && y < BAY.y + BAY.h - inset && x > BAY.x + inset && x < BAY.x + BAY.w - inset) {
      return BAY.out - 0.12;
    }
    return BAY.out;
  }
  if (y > WALL_H - 0.3) return 0.14;
  for (const win of WINDOWS) {
    if (inBox(x, y, win)) return -0.12;
    if (inBox(x, y, { x: win.x - 0.1, y: win.y - 0.14, w: win.w + 0.2, h: 0.14 })) return 0.07;
  }
  if (inBox(x, y, DOOR)) return -0.11;
  return noise(x, y, 30, 3) * 0.004;
}

/** Is this part of the facade glass the scanner got nothing back from? */
function isGlass(x, y) {
  for (const win of WINDOWS) {
    // The pane, inside its reveal. The frame is opaque and does come back.
    if (inBox(x, y, { x: win.x + 0.08, y: win.y + 0.08, w: win.w - 0.16, h: win.h - 0.16 })) return true;
  }
  if (inBox(x, y, { x: BAY.x + 0.3, y: BAY.y + 0.55, w: BAY.w - 0.6, h: BAY.h - 0.85 })) return true;
  return false;
}

const YAW = 0.83;
const place = (x, y, z) => [
  x * Math.cos(YAW) + z * Math.sin(YAW) + 22.4,
  y - 2.1,
  -x * Math.sin(YAW) + z * Math.cos(YAW) + 61.5,
];

function buildScan() {
  const positions = [];
  const indices = [];
  const step = 0.045;

  /** Add a grid of quads, skipping cells a predicate rejects. */
  const addSheet = (cols, rows, at, skip) => {
    const base = positions.length / 3;
    const index = new Int32Array((cols + 1) * (rows + 1)).fill(-1);
    let next = base;
    for (let j = 0; j <= rows; j++) {
      for (let i = 0; i <= cols; i++) {
        const p = at(i, j);
        if (!p) continue;
        index[j * (cols + 1) + i] = next++;
        positions.push(p[0], p[1], p[2]);
      }
    }
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        if (skip && skip(i, j)) continue;
        const a = index[j * (cols + 1) + i];
        const b = index[j * (cols + 1) + i + 1];
        const c = index[(j + 1) * (cols + 1) + i];
        const d = index[(j + 1) * (cols + 1) + i + 1];
        if (a < 0 || b < 0 || c < 0 || d < 0) continue;
        // Wound so the normals face out of the building, as a scanner winds
        // the surfaces it can see.
        indices.push(a, b, c, b, d, c);
      }
    }
  };

  // The facade, with the glass missing.
  const cols = Math.round(WALL_W / step);
  const rows = Math.round(WALL_H / step);
  addSheet(
    cols,
    rows,
    (i, j) => {
      const x = i * step;
      const y = j * step;
      return place(x, y, facade(x, y));
    },
    (i, j) => isGlass((i + 0.5) * step, (j + 0.5) * step)
  );

  /**
   * The ground: eight metres of it, running away from the wall, and
   * deliberately larger than the facade. This is what a plain largest-plane
   * search picks.
   */
  const gCols = Math.round(WALL_W / step) + 40;
  const gRows = Math.round(8 / step);
  addSheet(gCols, gRows, (i, j) => {
    const x = i * step - 1;
    const out = j * step;
    return place(x, -0.02 + noise(x, out, 6, 9) * 0.01, out);
  });

  /**
   * A hedge along the right-hand side, at the same depth as the bay window and
   * deliberately so. Anything further out is thrown away by the depth band and
   * proves nothing; this one is exactly as proud as a legitimate feature, the
   * same size, and the same sign. Only its shape gives it away.
   */
  const hCols = Math.round(2.4 / step);
  const hRows = Math.round(2.2 / step);
  addSheet(hCols, hRows, (i, j) => {
    const x = 6.4 + i * step;
    const y = 0.1 + j * step;
    const bulge = 0.62 + noise(x, y, 14, 21) * 0.3 + noise(x, y, 45, 5) * 0.14;
    return place(x, y, bulge);
  });

  // The neighbour, set back behind the plane.
  const nCols = Math.round(3 / step);
  const nRows = Math.round(5 / step);
  addSheet(nCols, nRows, (i, j) => place(WALL_W + 0.4 + i * step, j * step, -2.6));

  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

const mesh = buildScan();
const cloud = [];
for (let i = 0; i < mesh.positions.length; i += 3) {
  cloud.push([mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]);
}
console.log(`  scene: ${cloud.length.toLocaleString()} vertices, ${(mesh.indices.length / 3).toLocaleString()} triangles\n`);

/* ------------------------------------------------------------------ *
 * Finding the wall rather than the drive
 * ------------------------------------------------------------------ */

const UP = [0, 1, 0];
const wanted = (() => {
  const a = place(0, 0, 0);
  const b = place(0, 0, 1);
  return [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
})();

{
  // What the old behaviour did, kept as the control: with no up vector the
  // ground is the biggest plane in the scene and duly wins.
  const blind = fitPlane(cloud, { tolerance: 0.025, iterations: 260 });
  const vertical = Math.abs(blind.n[1]) < 0.35;
  ok('unconstrained, the largest plane is the ground', !vertical, `n·up = ${blind.n[1].toFixed(3)}`);
}

const fitted = fitPlane(cloud, { tolerance: 0.025, iterations: 260, up: UP });
ok('constrained to vertical, it finds a wall', !!fitted && Math.abs(fitted.n[1]) < 0.2, `n·up = ${fitted?.n[1].toFixed(3)}`);

const plane = orientPlane(fitted, { meshNormal: meanNormalNear(mesh, fitted, 0.05), points: cloud });
const facing = plane.n[0] * wanted[0] + plane.n[1] * wanted[1] + plane.n[2] * wanted[2];
ok('and it is the front of the house', facing > 0.99, `cos = ${facing.toFixed(4)}`);

/* ------------------------------------------------------------------ *
 * Cropping to the wall
 * ------------------------------------------------------------------ */

const crop = planeExtent(cloud, plane, fitted.inlierIndices, { up: UP });
const relief = levelRelief(fillHoles(bakeRelief(mesh, plane, {
  resolution: 460, up: UP, crop, band: 1.2, margin: 0.05,
})));

const across = relief.w * relief.scale;
const high = relief.h * relief.scale;
ok('the relief map is the wall, not the garden', near(across, WALL_W, 1.2) && near(high, WALL_H, 1.2), `${across.toFixed(2)} × ${high.toFixed(2)} m, wall is ${WALL_W} × ${WALL_H}`);

{
  // Without the crop it is the whole scene, which is the bug the user hit: the
  // corners you drag onto the house are the corners of something much larger.
  const uncropped = bakeRelief(mesh, plane, { resolution: 460, up: UP, band: 1.2 });
  const wide = uncropped.w * uncropped.scale;
  ok('uncropped, it would have been far larger', wide > across * 1.3, `${wide.toFixed(1)} m vs ${across.toFixed(1)} m`);
}

/* ------------------------------------------------------------------ *
 * Glass, hedge and neighbour
 * ------------------------------------------------------------------ */

const sample = (mx, my) => relief.at(Math.round(mx / relief.scale), Math.round((high - my) / relief.scale));

ok('brickwork is flat', Math.abs(sample(4.0, 2.9)) < 0.02, `${sample(4.0, 2.9).toFixed(3)} m`);
ok('the glass filled in from its reveals', near(sample(1.7, 4.3), -0.12, 0.04), `${sample(1.7, 4.3).toFixed(3)} m`);
ok('the bay stands proud', near(sample(2.1, 1.4), BAY.out - 0.12, 0.06), `${sample(2.1, 1.4).toFixed(3)} m`);
ok('the neighbour is outside the band', !isSeen(sample(WALL_W + 0.8, 2)) || Math.abs(sample(WALL_W + 0.8, 2)) < 1.2);

{
  let holes = 0;
  let seen = 0;
  for (const v of relief.data) (isSeen(v) ? seen++ : holes++);
  ok('almost all of the wall came back', seen / (seen + holes) > 0.9, `${((seen / (seen + holes)) * 100).toFixed(0)}% filled`);
}

/* ------------------------------------------------------------------ *
 * What it finds
 * ------------------------------------------------------------------ */

const found = findOpenings(relief, { threshold: 0.02 });
const windows = found.filter((o) => o.tag === 'window');
const doors = found.filter((o) => o.tag === 'door');

console.log(`  found: ${found.map((f) => `${f.tag || '?'} ${f.width.toFixed(2)}×${f.height.toFixed(2)}`).join(', ')}\n`);

ok('the three windows are found', windows.length === 3, `${windows.length} found`);
ok('the door is found', doors.length === 1, `${doors.length} found`);
if (windows.length === 3) {
  ok(
    'and they measure about 1.25 × 1.45 m',
    windows.every((w) => near(w.width, 1.25, 0.18) && near(w.height, 1.45, 0.18)),
    windows.map((w) => `${w.width.toFixed(2)}×${w.height.toFixed(2)}`).join(' ')
  );
}

/** Where a region's centre sits on the wall, in metres. */
const centreOf = (o) => ({
  x: (o.bbox.x + o.bbox.w / 2) * across,
  y: high - (o.bbox.y + o.bbox.h / 2) * high,
});
const near2 = (o, x, y, tol) => Math.abs(centreOf(o).x - x) < tol && Math.abs(centreOf(o).y - y) < tol;

{
  const bay = found.filter((o) => o.depth > 0.3 && near2(o, BAY.x + BAY.w / 2, BAY.y + BAY.h / 2, 0.8));
  ok('the bay comes back, as one feature', bay.length === 1, `${bay.length} regions over the bay`);
  if (bay.length === 1) {
    ok(
      'sized about right',
      near(bay[0].width, BAY.w, 0.45) && near(bay[0].height, BAY.h, 0.6),
      `${bay[0].width.toFixed(2)} × ${bay[0].height.toFixed(2)} m, bay is ${BAY.w} × ${BAY.h}`
    );
    ok('and reads as a made surface', bay[0].roughness < 0.01, `roughness ${(bay[0].roughness * 1000).toFixed(1)} mm`);
  }
}

{
  // The hedge is at the bay's own depth and nearly its shape. The only thing
  // that separates them is that one of them is a plant.
  const hedgeish = found.filter((o) => centreOf(o).x > 6.2 && o.depth > 0.3);
  ok('the hedge is not reported as a feature', hedgeish.length === 0, `${hedgeish.length} survived`);

  const unchecked = findOpenings(relief, { threshold: 0.02, maxRoughness: 99, minFill: 0 });
  const hedgeUnchecked = unchecked.filter((o) => {
    const cx = (o.bbox.x + o.bbox.w / 2) * across;
    return cx > 6.2 && o.depth > 0.3;
  });
  ok('and without the surface test it is', hedgeUnchecked.length > 0, `${hedgeUnchecked.length} found`);
  if (hedgeUnchecked.length) {
    // About six times the bay's and an order of magnitude past brickwork's,
    // which is the whole of the distinction being drawn.
    ok(
      'because it wobbles by an order of magnitude more than anything built',
      hedgeUnchecked[0].roughness > 0.04,
      `roughness ${(hedgeUnchecked[0].roughness * 1000).toFixed(0)} mm`
    );
  }
}

{
  // The gutter runs along the eaves, standing proud of the last course of
  // brickwork — so it is not an inlier, and cropping tight to the inliers used
  // to shave it off the top of the map entirely.
  const gutter = found.filter((o) => o.width > across * 0.9 && centreOf(o).y > high - 0.9);
  ok('the gutter survives the crop', gutter.length === 1, `${gutter.length} full-width features along the eaves`);
}

console.log(failures ? `\n${failures} failing` : '\nAll passing');
process.exit(failures ? 1 : 0);
