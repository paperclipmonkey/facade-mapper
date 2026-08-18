/**
 * Squaring up the wall.
 *
 * The claim being tested is a geometric one and can be checked exactly rather
 * than by eye: after rectification, world space must be a *similarity* of the
 * real wall — same shape everywhere, only scaled and shifted. That is precisely
 * the property the camera destroys and the whole point of putting it back.
 *
 * So the tests build a synthetic off-axis camera, mark a rectangle through it,
 * solve, and then measure the local Jacobian of world -> wall at points spread
 * across the frame. If squares stay square and stay the *same* square wherever
 * they are, the camera's perspective is gone.
 */

import { solveHomography, mat3Mul, mat3Inverse, applyH } from '../js/core/math.js';
import {
  solveRectify,
  rectifyMatrix,
  rectifyInverse,
  worldToProjector,
  remapPoints,
  createRectify,
  defaultRectifyQuad,
} from '../js/core/rectify.js';
import { resampleMesh, computeRegion } from '../js/render/warp.js';

let failures = 0;
const ok = (label, condition, detail = '') => {
  if (!condition) failures++;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ------------------------------------------------------------------ *
 * A camera looking at a wall from off to one side.
 * ------------------------------------------------------------------ */

/**
 * Wall (metric, y down) -> camera (normalised 0..1).
 *
 * Built from four correspondences rather than from a pose, because that is the
 * only thing the app ever has: the far edge of the wall is compressed towards
 * the top-right, which is what an oblique view of a facade looks like.
 */
const WALL_TO_CAMERA = solveHomography(
  [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 3 },
    { x: 0, y: 3 },
  ],
  [
    { x: 0.08, y: 0.14 },
    { x: 0.93, y: 0.30 },
    { x: 0.90, y: 0.82 },
    { x: 0.05, y: 0.95 },
  ]
);

const onCamera = (x, y) => applyH(WALL_TO_CAMERA, x, y);

console.log('\n— solving —');
ok('the synthetic camera is invertible', !!WALL_TO_CAMERA && !!mat3Inverse(WALL_TO_CAMERA));

// A window on that wall: 1.2 across, 0.9 up, somewhere off-centre. Seen through
// the camera it is a lopsided quadrilateral, which is the whole difficulty.
const markX = 1.1;
const markY = 0.7;
const markW = 1.2;
const markH = 0.9;
const quad = [
  onCamera(markX, markY),
  onCamera(markX + markW, markY),
  onCamera(markX + markW, markY + markH),
  onCamera(markX, markY + markH),
];

// Opposite edges of a real rectangle are parallel; opposite edges of one seen
// obliquely converge. That angle is the distortion, and comparing edge *lengths*
// would not find it — a trapezoid can easily have two equal parallel-ish sides.
const bearing = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
const converge = Math.abs(bearing(quad[0], quad[1]) - bearing(quad[3], quad[2])) * (180 / Math.PI);
ok('the marked rectangle really is distorted by the camera', converge > 2, `${converge.toFixed(1)}° of convergence`);

const solved = solveRectify({ quad, aspect: markW / markH, cameraAspect: 16 / 9 });
ok('it solves', !!solved);

/* ------------------------------------------------------------------ *
 * The property that matters: squares stay square, everywhere.
 * ------------------------------------------------------------------ */

console.log('\n— world space is a similarity of the wall —');

const toWall = mat3Mul(mat3Inverse(WALL_TO_CAMERA), solved.H); // world -> wall

/** The local 2x2 Jacobian of world -> wall at (u, v), by finite difference. */
function jacobian(u, v, eps = 1e-4) {
  const at = (a, b) => applyH(toWall, a, b);
  const p = at(u, v);
  const px = at(u + eps, v);
  const py = at(u, v + eps);
  if (!p || !px || !py) return null;
  return {
    ax: (px.x - p.x) / eps,
    ay: (px.y - p.y) / eps,
    bx: (py.x - p.x) / eps,
    by: (py.y - p.y) / eps,
  };
}

const samples = [];
for (const u of [0.15, 0.35, 0.5, 0.7, 0.9]) {
  for (const v of [0.15, 0.35, 0.5, 0.7, 0.9]) {
    const J = jacobian(u, v);
    if (J) samples.push({ u, v, J });
  }
}
ok('the whole frame maps finitely', samples.length === 25, `${samples.length} of 25`);

// Orthogonal columns: a right angle in world space is a right angle on the wall.
let worstAngle = 0;
for (const { J } of samples) {
  const dot = J.ax * J.bx + J.ay * J.by;
  const norm = Math.hypot(J.ax, J.ay) * Math.hypot(J.bx, J.by);
  worstAngle = Math.max(worstAngle, Math.abs(dot / norm));
}
ok('right angles survive', worstAngle < 1e-6, `worst cosine ${worstAngle.toExponential(1)}`);

/**
 * Equal column lengths — but measured in world *pixels*, not in the normalised
 * 0..1 the matrix works in.
 *
 * Those are different spaces and the difference is exactly `worldAspect`.
 * Normalised world space runs 0..1 on both axes whatever shape the wall is, so
 * its two axes are deliberately at different scales; `worldSize` divides that
 * back out and hands effects a frame whose pixels are square. It is the pixels
 * that have to be isotropic, because they are what a brick is measured in.
 */
let worstRatio = 0;
for (const { J } of samples) {
  const sx = Math.hypot(J.ax, J.ay) / solved.worldAspect;
  const sy = Math.hypot(J.bx, J.by);
  worstRatio = Math.max(worstRatio, Math.abs(sx / sy - 1));
}
ok('and a square of world pixels is a square on the wall', worstRatio < 1e-9,
  `worst ${worstRatio.toExponential(1)} off`);

// And the same scale at both ends of the wall — the thing the camera destroys.
const scales = samples.map(({ J }) => Math.hypot(J.ax, J.ay));
const spread = Math.max(...scales) / Math.min(...scales);
ok('at one scale across the whole wall', near(spread, 1, 1e-6), `${spread.toFixed(9)}x spread`);

// The unrectified case, for contrast: this is what the bug looked like.
const rawScales = [];
for (const u of [0.15, 0.9]) {
  const eps = 1e-4;
  const inv = mat3Inverse(WALL_TO_CAMERA);
  const p = applyH(inv, u, 0.5);
  const px = applyH(inv, u + eps, 0.5);
  rawScales.push(Math.hypot(px.x - p.x, px.y - p.y) / eps);
}
const rawSpread = Math.max(...rawScales) / Math.min(...rawScales);
ok('whereas camera space is not', rawSpread > 1.3, `${rawSpread.toFixed(2)}x across the frame`);

console.log('\n— the world aspect describes the wall —');
// World space covers some rectangle of wall; its reported aspect must be that
// rectangle's, or every effect measuring in world pixels is off by the error.
const corners = [applyH(toWall, 0, 0), applyH(toWall, 1, 0), applyH(toWall, 0, 1)];
const measured = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y)
  / Math.hypot(corners[2].x - corners[0].x, corners[2].y - corners[0].y);
ok('worldAspect matches the wall it covers', near(measured, solved.worldAspect, 1e-6),
  `${measured.toFixed(4)} vs ${solved.worldAspect.toFixed(4)}`);
ok('and the marked rectangle is inside it', (() => {
  const inv = mat3Inverse(solved.H);
  return [
    [markX, markY],
    [markX + markW, markY + markH],
  ].every(([x, y]) => {
    const w = applyH(inv, ...Object.values(onCamera(x, y)).slice(0, 2));
    return w && w.x > -0.01 && w.x < 1.01 && w.y > -0.01 && w.y < 1.01;
  });
})());

/* ------------------------------------------------------------------ *
 * Composition, which is what the renderer actually consumes.
 * ------------------------------------------------------------------ */

console.log('\n— the projector matrix —');

const project = { rectify: { ...createRectify(), enabled: true, H: solved.H } };
// A projector aimed at part of that wall, calibrated the usual way: camera in,
// projector out.
const cameraToProjector = solveHomography(
  [onCamera(0.5, 0.5), onCamera(3.5, 0.6), onCamera(3.4, 2.6), onCamera(0.4, 2.7)],
  [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
);
const projector = { calibration: { H: cameraToProjector } };

const M = worldToProjector(project, projector);
ok('composes world -> camera -> projector', !!M);
{
  // A point picked in world space must land where the camera-space chain says.
  const viaComposed = applyH(M, 0.42, 0.61);
  const midway = applyH(solved.H, 0.42, 0.61);
  const viaChain = applyH(cameraToProjector, midway.x, midway.y);
  ok('and agrees with doing it in two steps',
    near(viaComposed.x, viaChain.x, 1e-9) && near(viaComposed.y, viaChain.y, 1e-9));
}
ok('returns the same array twice, so the warp mesh is not rebuilt every frame',
  worldToProjector(project, projector) === M);
ok('and the bare calibration when nothing is rectified',
  worldToProjector({ rectify: createRectify() }, projector) === cameraToProjector);

ok('rectifyMatrix is null unless enabled', rectifyMatrix({ rectify: createRectify() }) === null);
ok('and the inverse round-trips', (() => {
  const inv = rectifyInverse(project);
  const there = applyH(solved.H, 0.3, 0.8);
  const back = applyH(inv, there.x, there.y);
  return near(back.x, 0.3, 1e-9) && near(back.y, 0.8, 1e-9);
})());

/* ------------------------------------------------------------------ *
 * Moving a traced show between world spaces.
 * ------------------------------------------------------------------ */

console.log('\n— nothing traced moves on the building —');

const traced = [
  { x: 0.2, y: 0.3 },
  { x: 0.6, y: 0.31 },
  { x: 0.61, y: 0.7 },
];

// Camera space is the invariant: a shape traced before squaring up must sit on
// the same pixels of the photograph afterwards.
const intoWorld = remapPoints(traced, null, solved.H);
const backToCamera = remapPoints(intoWorld, solved.H, null);
let worstDrift = 0;
traced.forEach((p, i) => {
  worstDrift = Math.max(worstDrift, Math.hypot(p.x - backToCamera[i].x, p.y - backToCamera[i].y));
});
ok('remapping in and out is lossless', worstDrift < 1e-9, `${worstDrift.toExponential(1)} of frame`);
ok('and the remapped points really did move in world terms',
  Math.hypot(traced[0].x - intoWorld[0].x, traced[0].y - intoWorld[0].y) > 0.01);

ok('extra fields on a point survive the trip',
  remapPoints([{ x: 0.5, y: 0.5, tag: 'sill' }], null, solved.H)[0].tag === 'sill');

/* ------------------------------------------------------------------ *
 * The surface-correction mesh follows world space too.
 * ------------------------------------------------------------------ */

console.log('\n— the correction mesh is re-addressed, not thrown away —');

const mesh = {
  enabled: true,
  cols: 5,
  rows: 5,
  offsets: Array.from({ length: 25 * 2 }, (_, i) => (i % 2 ? 0.004 : -0.003) * ((i % 7) - 3)),
};
const region = { x: 0, y: 0, w: 1, h: 1 };

const unchanged = resampleMesh(mesh, region, region, (p) => p);
let worstSelf = 0;
mesh.offsets.forEach((v, i) => {
  worstSelf = Math.max(worstSelf, Math.abs(v - unchanged.offsets[i]));
});
ok('an identity remap leaves it alone', worstSelf < 1e-9, `${worstSelf.toExponential(1)}`);

{
  // A real one: the same physical wall, addressed two ways. The offset read at a
  // given place on the building has to be the same offset either way.
  const before = computeRegion(cameraToProjector);
  const after = computeRegion(M);
  const inv = rectifyInverse(project);
  const moved = resampleMesh(mesh, before, after, (p) => applyH(solved.H, p.x, p.y));
  ok('a real remap keeps the grid shape', moved.cols === 5 && moved.rows === 5
    && moved.offsets.length === 50);
  ok('and changes the values, because the addresses moved',
    moved.offsets.some((v, i) => Math.abs(v - mesh.offsets[i]) > 1e-6));
  ok('and stays finite', moved.offsets.every(Number.isFinite));
  ok('with the inverse available for the other direction', !!inv);
}

/* ------------------------------------------------------------------ *
 * Refusals
 * ------------------------------------------------------------------ */

console.log('\n— things that should not solve —');

ok('a collapsed quad', solveRectify({
  quad: [{ x: 0.2, y: 0.2 }, { x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.8, y: 0.8 }],
  aspect: 1,
}) === null);
ok('a nonsense aspect', solveRectify({ quad: defaultRectifyQuad(), aspect: 0 }) === null);
ok('a missing corner', solveRectify({ quad: defaultRectifyQuad().slice(0, 3), aspect: 1 }) === null);
ok('a corner that is not a number', solveRectify({
  quad: [{ x: 0.2, y: 0.2 }, { x: NaN, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 }],
  aspect: 1,
}) === null);

{
  // A quad seen so obliquely that the wall's horizon crosses the frame. It must
  // still produce a usable, finite world space rather than a strip.
  const extreme = solveRectify({
    quad: [{ x: 0.30, y: 0.44 }, { x: 0.94, y: 0.16 }, { x: 0.95, y: 0.86 }, { x: 0.31, y: 0.56 }],
    aspect: 1.4,
  });
  ok('a near-horizon view still solves', !!extreme);
  ok('and does not blow world space up', extreme
    && extreme.worldAspect > 0.05 && extreme.worldAspect < 20
    && extreme.H.every(Number.isFinite),
    extreme ? `${extreme.worldAspect.toFixed(2)}:1` : '');
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
