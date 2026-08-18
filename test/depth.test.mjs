/**
 * Reading a facade off a depth scan.
 *
 * The thing under test is a chain, and a chain is worth testing end to end: a
 * synthetic house is built as a heightfield in wall coordinates, triangulated,
 * and then rotated and shoved somewhere arbitrary in space — exactly what a
 * scan of a real building is, an object at an unknown pose whose windows nobody
 * has told you about. If the pipeline is right, what comes back out the far end
 * is the wall's own plane, a relief map square on the building, and the same
 * windows and door that went in, measured in metres.
 *
 * That last part is the point of testing it this way rather than in pieces. A
 * sign error in the basis, a transposed axis in the rasteriser or a normal
 * pointing into the building all produce a plausible-looking relief map and a
 * completely wrong set of shapes, and each of them was in here at some point.
 *
 *   node test/depth.test.mjs
 */

import {
  fitPlane,
  orientPlane,
  bakeRelief,
  levelRelief,
  fillHoles,
  findOpenings,
  normalsFromRelief,
  traceOutline,
  simplifyClosed,
  isSeen,
} from '../js/core/depth.js';
import { meanNormal } from '../js/core/glb.js';

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ------------------------------------------------------------------ *
 * A house, as a heightfield
 * ------------------------------------------------------------------ */

const WALL_W = 8;
const WALL_H = 6;
const STEP = 0.03;

/** Openings, in metres from the bottom-left of the facade. */
const WINDOWS = [
  { x: 1.0, y: 3.6, w: 1.2, h: 1.4 },
  { x: 5.8, y: 3.6, w: 1.2, h: 1.4 },
  { x: 1.0, y: 1.1, w: 1.2, h: 1.4 },
  { x: 5.8, y: 1.1, w: 1.2, h: 1.4 },
];
const DOOR = { x: 3.5, y: 0, w: 0.9, h: 2.05 };
const inBox = (x, y, b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;

/** Relief in metres at a point on the facade: back for glass, proud for a sill. */
function facadeHeight(x, y) {
  for (const win of WINDOWS) {
    if (inBox(x, y, win)) return -0.11;
    // A sill under each window, standing proud of the brickwork.
    if (inBox(x, y, { x: win.x - 0.1, y: win.y - 0.14, w: win.w + 0.2, h: 0.14 })) return 0.07;
  }
  if (inBox(x, y, DOOR)) return -0.09;
  return 0;
}

/**
 * Put the house somewhere arbitrary: facing an arbitrary compass direction, a
 * long way from the origin.
 *
 * Yaw and translation only, which is not a shortcut — it is the pose a real
 * facade has. Walls are vertical and a phone's scan is gravity-aligned, so the
 * one thing the pipeline may assume is which way is up. It uses that to pick a
 * level basis on the wall, and levelness is worth having: window heads and
 * brick courses are horizontal, and a relief map baked three degrees off makes
 * every opening a very slight diamond.
 */
function pose(p) {
  const yaw = 0.62;
  const [x, y, z] = p;
  return [
    x * Math.cos(yaw) + z * Math.sin(yaw) + 12.5,
    y - 3.25,
    -x * Math.sin(yaw) + z * Math.cos(yaw) + 40,
  ];
}

function buildMesh() {
  const cols = Math.round(WALL_W / STEP) + 1;
  const rows = Math.round(WALL_H / STEP) + 1;
  const positions = new Float32Array(cols * rows * 3);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = i * STEP;
      const y = j * STEP;
      const [px, py, pz] = pose([x, y, facadeHeight(x, y)]);
      const k = (j * cols + i) * 3;
      positions[k] = px;
      positions[k + 1] = py;
      positions[k + 2] = pz;
    }
  }

  const indices = [];
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  return { positions, indices: new Uint32Array(indices), cols, rows };
}

const mesh = buildMesh();

/* ------------------------------------------------------------------ *
 * The plane
 * ------------------------------------------------------------------ */

const cloud = [];
for (let i = 0; i < mesh.positions.length; i += 3) {
  cloud.push([mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]);
}

const raw = fitPlane(cloud, { tolerance: 0.025, iterations: 240 });
// Oriented from the triangle winding, which is the route a real scan takes:
// a scanner captures surfaces facing it and winds them accordingly.
const plane = orientPlane(raw, { meshNormal: meanNormal(mesh), points: cloud });
const expected = (() => {
  // The facade's own outward normal, put through the same pose.
  const a = pose([0, 0, 0]);
  const b = pose([0, 0, 1]);
  return [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
})();

const alignment = plane.n[0] * expected[0] + plane.n[1] * expected[1] + plane.n[2] * expected[2];
ok('plane fit recovers the wall', alignment > 0.9995, `cos = ${alignment.toFixed(5)}`);
ok('normal faces out of the building', alignment > 0, `${plane.n.map((v) => v.toFixed(3))}`);
ok(
  'the wall is the consensus, not the openings',
  plane.inliers / plane.total > 0.7,
  `${plane.inliers}/${plane.total}`
);

/* ------------------------------------------------------------------ *
 * The relief map
 * ------------------------------------------------------------------ */

const relief = levelRelief(bakeRelief(mesh, plane, { resolution: 420 }));
ok(
  'relief is square on the wall',
  near((relief.w * relief.scale) / (relief.h * relief.scale), WALL_W / WALL_H, 0.02),
  `${(relief.w * relief.scale).toFixed(2)}m x ${(relief.h * relief.scale).toFixed(2)}m`
);

/** Sample the relief at a point given in metres from the bottom-left. */
function sampleMetres(mx, my) {
  const x = Math.round(mx / relief.scale);
  const y = Math.round(relief.h - 1 - my / relief.scale);
  return relief.at(x, y);
}

ok('brickwork reads as flat', Math.abs(sampleMetres(4, 5.5)) < 0.005, `${sampleMetres(4, 5.5).toFixed(4)}m`);
ok('window glass reads as set back', near(sampleMetres(1.6, 4.3), -0.11, 0.008), `${sampleMetres(1.6, 4.3).toFixed(3)}m`);
ok('the sill reads as proud', near(sampleMetres(1.6, 3.53), 0.07, 0.012), `${sampleMetres(1.6, 3.53).toFixed(3)}m`);
ok('the door reads as set back', near(sampleMetres(3.95, 1), -0.09, 0.008), `${sampleMetres(3.95, 1).toFixed(3)}m`);

/* ------------------------------------------------------------------ *
 * Normals
 * ------------------------------------------------------------------ */

const normals = normalsFromRelief(relief);
const normalAt = (mx, my) => {
  const x = Math.round(mx / relief.scale);
  const y = Math.round(relief.h - 1 - my / relief.scale);
  const i = (y * relief.w + x) * 3;
  return [normals[i], normals[i + 1], normals[i + 2]];
};

ok('flat brickwork faces the viewer', normalAt(4, 5.5)[2] > 0.999, `${normalAt(4, 5.5)[2].toFixed(4)}`);
// The top face of a sill is a step up as you travel down the wall, so its
// normal tilts towards the sky. This is the assertion that catches the y-flip.
ok('a sill top faces upwards', normalAt(1.6, 3.6)[1] > 0.3, `ny = ${normalAt(1.6, 3.6)[1].toFixed(3)}`);
ok('a window head faces downwards', normalAt(1.6, 5.0)[1] < -0.3, `ny = ${normalAt(1.6, 5.0)[1].toFixed(3)}`);

/* ------------------------------------------------------------------ *
 * The openings
 * ------------------------------------------------------------------ */

const openings = findOpenings(relief, { threshold: 0.02 });
const windows = openings.filter((o) => o.tag === 'window');
const doors = openings.filter((o) => o.tag === 'door');
const trim = openings.filter((o) => o.tag === 'trim');

ok('four windows found', windows.length === 4, `found ${windows.length}`);
ok('one door found', doors.length === 1, `found ${doors.length}`);
ok('the sills came back as trim', trim.length === 4, `found ${trim.length}`);
ok('nothing else was invented', openings.length === 9, `${openings.length} regions`);

if (windows.length === 4) {
  const sized = windows.every((s) => near(s.width, 1.2, 0.06) && near(s.height, 1.4, 0.06));
  ok('windows measure 1.2m x 1.4m', sized, windows.map((s) => `${s.width.toFixed(2)}x${s.height.toFixed(2)}`).join(' '));
  ok('windows squared off', windows.every((s) => s.squared && s.points.length === 4));
  ok('windows are set back about 110mm', windows.every((s) => near(s.depth, -0.11, 0.01)));
}
if (doors.length === 1) {
  const d = doors[0];
  ok('the door measures 0.9m x 2.05m', near(d.width, 0.9, 0.06) && near(d.height, 2.05, 0.06), `${d.width.toFixed(2)}x${d.height.toFixed(2)}`);
  ok('the door sits on the ground', d.bbox.y + d.bbox.h > 0.99, `bottom at ${(d.bbox.y + d.bbox.h).toFixed(3)}`);
}

// Where they landed, not just how many: a pipeline that mirrors the wall finds
// exactly the right four windows in exactly the wrong places.
if (windows.length === 4) {
  const centres = windows
    .map((s) => ({
      x: (s.bbox.x + s.bbox.w / 2) * relief.w * relief.scale,
      y: (1 - (s.bbox.y + s.bbox.h / 2)) * relief.h * relief.scale,
    }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const wanted = WINDOWS
    .map((win) => ({ x: win.x + win.w / 2, y: win.y + win.h / 2 }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const placed = centres.every((c, i) => near(c.x, wanted[i].x, 0.05) && near(c.y, wanted[i].y, 0.05));
  ok('windows are where the house put them', placed, centres.map((c) => `(${c.x.toFixed(2)},${c.y.toFixed(2)})`).join(' '));
}

/* ------------------------------------------------------------------ *
 * The pieces, on their own
 * ------------------------------------------------------------------ */

{
  // A rectangle with a hole in it: the outline is the outside, and the winding
  // of the hole must not win the largest-area test.
  const w = 12;
  const h = 10;
  const pixels = [];
  for (let y = 2; y < 8; y++) {
    for (let x = 3; x < 9; x++) {
      if (x >= 5 && x < 7 && y >= 4 && y < 6) continue;
      pixels.push(y * w + x);
    }
  }
  const outline = traceOutline(pixels, w, h);
  const xs = outline.map((p) => p.x);
  const ys = outline.map((p) => p.y);
  ok(
    'an outline is the outside of the region',
    outline.length === 4 && Math.min(...xs) === 3 && Math.max(...xs) === 9 && Math.min(...ys) === 2 && Math.max(...ys) === 8,
    `${outline.length} vertices`
  );
}

{
  // A one-pixel sliver still has a boundary; it used to trace to nothing.
  const outline = traceOutline([5 * 9 + 4], 9, 9);
  ok('a single pixel has an outline', outline.length === 4);
}

{
  const ring = [];
  for (let i = 0; i < 40; i++) {
    const t = (i / 40) * Math.PI * 2;
    ring.push({ x: 50 + 20 * Math.cos(t), y: 50 + 20 * Math.sin(t) });
  }
  const simple = simplifyClosed(ring, 1.5);
  ok('simplify keeps a circle a circle', simple.length > 5 && simple.length < 20, `${simple.length} vertices`);
}

{
  // Holes in the scan where the glass was, which is how every real one arrives.
  const holed = bakeRelief(mesh, plane, { resolution: 420 });
  levelRelief(holed);
  const punched = [];
  for (let i = 0; i < holed.data.length; i++) {
    if (holed.data[i] < -0.05 && i % 5 === 0) {
      holed.data[i] = NaN;
      punched.push(i);
    }
  }
  fillHoles(holed, 6);
  const remaining = punched.filter((i) => !isSeen(holed.data[i])).length;
  ok('holes in the glass fill from their own reveals', remaining === 0, `punched ${punched.length}, ${remaining} left`);
  const stillThere = findOpenings(holed, { threshold: 0.02 }).filter((o) => o.tag === 'window').length;
  ok('and the windows survive it', stillThere === 4, `found ${stillThere}`);
}

console.log(failures ? `\n${failures} failing` : '\nAll passing');
process.exit(failures ? 1 : 0);
