/**
 * Putting a depth scan into a show.
 *
 * `depth.test.mjs` covers turning a mesh into a relief map. This covers the
 * three things the app then does with one, and each of them fails silently
 * rather than loudly when it is wrong:
 *
 *  - **Storing it.** A relief map is signed metres with NaN holes in it. Round
 *    trip it through anything that assumes unsigned bytes and the windows come
 *    back as wall.
 *  - **Placing it.** The scan and the camera have never met. Four points settle
 *    it, and the matrix has to survive the wall being squared up afterwards —
 *    which moves world space and must not move the scan.
 *  - **Handing it to effects.** The field is resampled into world space, but
 *    the normals and the metres in it belong to the wall. Recomputing either
 *    from the resampled raster gives plausible, wrong answers everywhere the
 *    camera is off-axis, which is everywhere.
 *
 *   node test/scan.test.mjs
 */

import { bakeRelief, levelRelief, occlusion, isSeen } from '../js/core/depth.js';
import {
  createScan,
  encodeRelief,
  decodeRelief,
  solveScanPlacement,
  scanMatrix,
  reliefToWorld,
  buildDepthField,
  createDepthHandle,
  createScanSource,
  scanKey,
} from '../js/core/scan.js';
import { createProject, migrateProject, worldSize } from '../js/core/state.js';
import { solveRectify } from '../js/core/rectify.js';

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ------------------------------------------------------------------ *
 * A wall with one window in it
 * ------------------------------------------------------------------ */

const WALL_W = 6;
const WALL_H = 4;
const WINDOW = { x: 2.4, y: 1.4, w: 1.2, h: 1.4 };
const SILL = { x: 2.3, y: 1.26, w: 1.4, h: 0.14 };
const inBox = (x, y, b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;

function height(x, y) {
  if (inBox(x, y, WINDOW)) return -0.1;
  if (inBox(x, y, SILL)) return 0.08;
  return 0;
}

function buildMesh(step = 0.02) {
  const cols = Math.round(WALL_W / step) + 1;
  const rows = Math.round(WALL_H / step) + 1;
  const positions = new Float32Array(cols * rows * 3);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = (j * cols + i) * 3;
      positions[k] = i * step;
      positions[k + 1] = j * step;
      positions[k + 2] = height(i * step, j * step);
    }
  }
  const indices = [];
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i;
      indices.push(a, a + 1, a + cols, a + 1, a + cols + 1, a + cols);
    }
  }
  return { positions, indices: new Uint32Array(indices) };
}

const plane = { n: [0, 0, 1], d: 0 };
const relief = levelRelief(bakeRelief(buildMesh(), plane, { resolution: 300 }));

/** Sample the relief in metres from its bottom-left, for the assertions below. */
const sampleMetres = (mx, my) =>
  relief.at(Math.round(mx / relief.scale), Math.round(relief.h - 1 - my / relief.scale));

ok('the fixture has a window in it', near(sampleMetres(3, 2), -0.1, 0.01), `${sampleMetres(3, 2).toFixed(3)}m`);

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

{
  // A hole where the glass was, so the NaN path is exercised rather than assumed.
  relief.data[relief.w * 4 + 4] = NaN;

  const blob = encodeRelief(relief);
  const back = await decodeRelief(blob);

  ok('a relief map survives the round trip', !!back && back.w === relief.w && back.h === relief.h, `${back?.w}x${back?.h}`);
  ok('and keeps its scale', near(back.scale, relief.scale, 1e-7), `${back.scale}`);

  let worst = 0;
  let holes = 0;
  for (let i = 0; i < relief.data.length; i++) {
    if (!isSeen(relief.data[i])) {
      if (!isSeen(back.data[i])) holes++;
      continue;
    }
    worst = Math.max(worst, Math.abs(relief.data[i] - back.data[i]));
  }
  ok('signed metres come back exactly', worst === 0, `worst ${worst}`);
  ok('and so do the holes', holes === 1, `${holes} kept`);

  ok('rubbish is refused rather than half-read', (await decodeRelief(new Blob([new Uint8Array(8)]))) === null);
  ok('and so is nothing at all', (await decodeRelief(null)) === null);
}

/* ------------------------------------------------------------------ *
 * Placement
 * ------------------------------------------------------------------ */

const project = createProject('Test');
project.scan = {
  ...createScan(),
  enabled: true,
  w: relief.w,
  h: relief.h,
  scale: relief.scale,
  importedAt: 1,
};

// The scan sits in the middle of the camera picture, seen slightly from the left
// so the quad is a genuine perspective view rather than a rectangle.
const QUAD = [
  { x: 0.18, y: 0.16 },
  { x: 0.86, y: 0.22 },
  { x: 0.86, y: 0.80 },
  { x: 0.18, y: 0.88 },
];
project.scan.quad = QUAD;
project.scan.H = solveScanPlacement(QUAD);

ok('four points place the scan', !!scanMatrix(project));
{
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const placed = corners.every(([u, v], i) => {
    const w = reliefToWorld(project, u, v);
    return w && near(w.x, QUAD[i].x, 1e-6) && near(w.y, QUAD[i].y, 1e-6);
  });
  // With no rectification, world space *is* the camera image, so the corners of
  // the relief map land exactly on the marked quad.
  ok('the corners land on the marked quad', placed);
}

ok('a scan with no matrix is refused on load', (() => {
  const raw = JSON.parse(JSON.stringify(project));
  raw.scan.H = null;
  return migrateProject(raw).scan.enabled === false;
})());

/* ------------------------------------------------------------------ *
 * The field effects see
 * ------------------------------------------------------------------ */

const world = worldSize(project);
const field = buildDepthField(relief, project, world);
ok('a field is built', !!field && field.w > 0, `${field?.w}x${field?.h}`);
ok('and covers about the marked quad', near(field.coverage, 0.45, 0.12), `${(field.coverage * 100).toFixed(0)}%`);

const depth = createDepthHandle(relief, field, world);

/** Where a point given in relief coordinates lands, in world pixels. */
const worldPixel = (u, v) => {
  const w = reliefToWorld(project, u, v);
  return { x: w.x * world.w, y: w.y * world.h };
};

{
  const centre = worldPixel(
    (WINDOW.x + WINDOW.w / 2) / WALL_W,
    1 - (WINDOW.y + WINDOW.h / 2) / WALL_H
  );
  ok('the window is set back where the window is', near(depth.reliefAt(centre.x, centre.y), -0.1, 0.012), `${depth.reliefAt(centre.x, centre.y).toFixed(3)}m`);

  const wall = depth.wallAt(centre.x, centre.y, [0, 0, 0]);
  ok(
    'wall coordinates are metres, y down from the top',
    near(wall[0], WINDOW.x + WINDOW.w / 2, 0.05) && near(wall[1], WALL_H - (WINDOW.y + WINDOW.h / 2), 0.05),
    `(${wall[0].toFixed(2)}, ${wall[1].toFixed(2)})`
  );

  const bare = worldPixel(0.08, 0.2);
  ok('bare wall reads flat', Math.abs(depth.reliefAt(bare.x, bare.y)) < 0.006);
  ok('and outside the scan reads as nothing seen', !depth.sees(-40, -40));
}

{
  // The head of the window: a surface that steps back as you travel down the
  // wall, so its normal tilts towards the ground. This is the assertion that
  // catches a y-flip anywhere in the chain from the bake to the field.
  const head = worldPixel(
    (WINDOW.x + WINDOW.w / 2) / WALL_W,
    1 - (WINDOW.y + WINDOW.h + 0.01) / WALL_H
  );
  const n = depth.normalAt(head.x, head.y, [0, 0, 1]);
  ok('a window head faces downwards', n[1] > 0.25, `ny = ${n[1].toFixed(3)}`);

  const sill = worldPixel((SILL.x + SILL.w / 2) / WALL_W, 1 - (SILL.y + SILL.h + 0.005) / WALL_H);
  const ns = depth.normalAt(sill.x, sill.y, [0, 0, 1]);
  ok('a sill top faces upwards', ns[1] < -0.2, `ny = ${ns[1].toFixed(3)}`);

  const flat = worldPixel(0.08, 0.2);
  const nf = depth.normalAt(flat.x, flat.y, [0, 0, 1]);
  ok('flat wall faces the viewer', nf[2] > 0.99, `nz = ${nf[2].toFixed(3)}`);
}

/* ------------------------------------------------------------------ *
 * Squaring the wall afterwards must not move the scan
 * ------------------------------------------------------------------ */

{
  const before = reliefToWorld(project, 0.5, 0.5);
  const squared = { ...project, rectify: { ...project.rectify } };
  const solved = solveRectify({ quad: QUAD, aspect: WALL_W / WALL_H, cameraAspect: 16 / 9 });
  squared.rectify = {
    ...squared.rectify,
    enabled: true,
    quad: QUAD,
    aspect: WALL_W / WALL_H,
    H: solved.H,
    worldAspect: solved.worldAspect,
  };

  const after = reliefToWorld(squared, 0.5, 0.5);
  ok(
    'squaring up moves the scan in world space',
    !near(before.x, after.x, 1e-4) || !near(before.y, after.y, 1e-4),
    `${before.x.toFixed(3)} -> ${after.x.toFixed(3)}`
  );

  // ...but to the same place on the building, which is the point: the quad is
  // stored against the camera, so re-squaring re-expresses it rather than
  // invalidating it. The centre of the scan is still the centre of the scan.
  const field2 = buildDepthField(relief, squared, worldSize(squared));
  const depth2 = createDepthHandle(relief, field2, worldSize(squared));
  const w2 = worldSize(squared);
  const centre = depth2.wallAt(after.x * w2.w, after.y * w2.h, [0, 0, 0]);
  ok(
    'and it still describes the same point on the wall',
    near(centre[0], WALL_W / 2, 0.08) && near(centre[1], WALL_H / 2, 0.08),
    `(${centre[0].toFixed(2)}, ${centre[1].toFixed(2)})`
  );
}

/* ------------------------------------------------------------------ *
 * Shadows
 * ------------------------------------------------------------------ */

{
  const sillX = SILL.x + SILL.w / 2;
  /**
   * Wall metres, y measured *down* from the top of the relief — so a point
   * below the sill on the building has the larger y. Getting this the wrong way
   * round is the whole reason these two assertions exist as a pair.
   */
  const belowSill = WALL_H - SILL.y + 0.06;
  // Close in to the wall, which is where a lamp throws a shadow worth having.
  const lampAbove = [sillX, 0.2, 0.5];
  const lampBelow = [sillX, WALL_H - 0.1, 0.5];

  const shaded = occlusion(relief, sillX, belowSill, 0, ...lampAbove);
  ok('a sill shadows the wall below it when lit from above', shaded > 0.5, `${shaded.toFixed(2)}`);

  const lit = occlusion(relief, sillX, belowSill, 0, ...lampBelow);
  ok('and does not when lit from below', lit === 0, `${lit.toFixed(2)}`);

  /**
   * The other side of the same sill. The ray has to start at the real surface,
   * which here is the glass a hundred millimetres back — starting it at the
   * wall plane would launch it from in front of the geometry it is meant to be
   * shadowed by, and quietly weaken every answer.
   */
  const aboveSill = WALL_H - SILL.y - SILL.h - 0.06;
  const surface = relief.at(Math.round(sillX / relief.scale), Math.round(aboveSill / relief.scale));
  const backlit = occlusion(relief, sillX, aboveSill, surface, ...lampBelow);
  ok('and shadows the wall above it when lit from below', backlit > 0.5, `${backlit.toFixed(2)} at z=${surface.toFixed(3)}`);

  const open = occlusion(relief, 0.4, 1.0, 0, 0.4, 0.2, 3);
  ok('bare wall is never in shadow', open === 0);

  const offEdge = occlusion(relief, 0.05, 0.05, 0, -6, -6, 2);
  ok('walking off the edge of the scan is not a blocker', offEdge === 0);
}

/* ------------------------------------------------------------------ *
 * The per-tab source
 * ------------------------------------------------------------------ */

{
  const store = new Map([[scanKey(project.id), encodeRelief(relief)]]);
  const errors = [];
  const source = createScanSource({ onError: (m) => errors.push(m) });

  source.sync(project, world, (key) => store.get(key) ?? null);
  ok('the first sync starts a load rather than blocking', source.get() === null);

  await new Promise((r) => setTimeout(r, 0));
  source.sync(project, world, (key) => store.get(key) ?? null);
  ok('and the next one has the field', !!source.get(), errors.join(' '));

  const first = source.get();
  source.sync(project, world, (key) => store.get(key) ?? null);
  ok('an unchanged project does not rebuild it', source.get() === first);

  const moved = { ...project, scan: { ...project.scan, H: solveScanPlacement(QUAD.map((p) => ({ x: p.x + 0.02, y: p.y }))) } };
  source.sync(moved, world, (key) => store.get(key) ?? null);
  ok('re-placing it does', source.get() !== first);

  source.sync({ ...project, scan: createScan() }, world, () => null);
  ok('and removing the scan drops it', source.get() === null);
}

{
  // A show exported to a file and opened elsewhere: the project says there is a
  // scan and the bytes are not on this machine. It has to complain once, not
  // once a frame.
  const errors = [];
  const source = createScanSource({ onError: (m) => errors.push(m) });
  const orphan = { ...project, id: 'proj_elsewhere' };

  for (let i = 0; i < 5; i++) {
    source.sync(orphan, world, () => null);
    await new Promise((r) => setTimeout(r, 0));
  }
  ok('a missing relief map is reported once, not every frame', errors.length === 1, `${errors.length} times`);
  ok('and leaves no handle behind', source.get() === null);
  ok('and the message says what to do', /import the scan again/i.test(errors[0] || ''), errors[0]);
}

console.log(failures ? `\n${failures} failing` : '\nAll passing');
process.exit(failures ? 1 : 0);
