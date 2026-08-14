/**
 * Facade collision, and automatic soft-edge blending.
 *
 * Both are geometry with no DOM in sight, and both are the kind of code where a
 * sign error produces something that still looks plausible on screen. A ball
 * that is ejected the *wrong* side of a window still bounces; a feather width
 * measured from the wrong edge still fades an edge. The tests below pin down
 * the direction of every result, not just its magnitude.
 *
 *   node test/obstacles.test.mjs
 */

import {
  surfaceNormal,
  deflect,
  isClear,
  findFreeSpot,
  nearestSurface,
  collectObstacles,
} from '../js/effects/obstacles.js';
import { computeEdgeBlends, projectorsOverlap } from '../js/render/warp.js';
import { solveHomography, pointInPolygon } from '../js/core/math.js';

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

const rect = (x, y, w, h) => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

/** A shape as the renderer's geometry cache hands it over. */
const geo = (points, id = 's') => {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const w = Math.max(...xs) - x;
  const h = Math.max(...ys) - y;
  return { id, points, closed: true, tags: [], bbox: { x, y, w, h, cx: x + w / 2, cy: y + h / 2 } };
};

/* ------------------------------------------------------------------ *
 * Surface geometry
 * ------------------------------------------------------------------ */

console.log('— surface normals —');
{
  const square = rect(0, 0, 100, 100);

  const right = surfaceNormal(square, 130, 50);
  ok('a point outside is normal to the nearest edge', near(right.px, 100) && near(right.py, 50));
  ok('  and the normal points away from the surface', near(right.nx, 1) && near(right.ny, 0), `(${right.nx}, ${right.ny})`);
  ok('  reporting the true distance', near(right.dist, 30));

  const inside = surfaceNormal(square, 90, 50);
  ok('a point inside meets the same edge', near(inside.px, 100) && near(inside.py, 50));
  ok(
    '  with the normal still pointing at the query point, i.e. inwards',
    near(inside.nx, -1) && near(inside.ny, 0),
    `(${inside.nx}, ${inside.ny})`
  );

  const onEdge = surfaceNormal(square, 100, 50);
  ok(
    'a point exactly on the edge still yields a unit normal',
    near(Math.hypot(onEdge.nx, onEdge.ny), 1),
    `(${onEdge.nx.toFixed(3)}, ${onEdge.ny.toFixed(3)})`
  );
}

/* ------------------------------------------------------------------ *
 * Deflection
 * ------------------------------------------------------------------ */

console.log('\n— deflection —');
{
  const room = rect(0, 0, 1000, 500);

  // Escaped through the right-hand wall, still travelling right.
  const m = { x: 1010, y: 250, vx: 200, vy: 0 };
  const hit = deflect(room, m, 10, 1, true);
  ok('a mover outside its container is reported as a hit', hit);
  ok('  and is put back inside, clear by its own radius', near(m.x, 990) && near(m.y, 250), `(${m.x}, ${m.y})`);
  ok('  travelling back the way it came', m.vx < 0, `vx ${m.vx}`);

  // Restitution takes energy out of the bounce rather than reversing it twice.
  const damped = { x: 1010, y: 250, vx: 200, vy: 0 };
  deflect(room, damped, 10, 0.5, true);
  ok('bounciness scales the outgoing speed', near(Math.abs(damped.vx), 100), `vx ${damped.vx}`);

  // Already moving away: reflecting again would fling it back at the wall.
  const leaving = { x: 1010, y: 250, vx: -200, vy: 0 };
  deflect(room, leaving, 10, 1, true);
  ok('a mover already heading back is not reflected a second time', near(leaving.vx, -200), `vx ${leaving.vx}`);

  const clear = { x: 500, y: 250, vx: 200, vy: 0 };
  ok('a mover in open space is left alone', !deflect(room, clear, 10, 1, true) && near(clear.x, 500));
}

console.log('\n— obstacles —');
{
  const window_ = rect(400, 200, 200, 150);

  // Just inside the left edge, heading right: the nearest surface is the one it
  // came through, so it goes back out of it. This is the sign that matters —
  // get it backwards and the ball is helped *through* the glass.
  const m = { x: 405, y: 275, vx: 300, vy: 0 };
  const hit = deflect(window_, m, 8, 1, false);
  ok('a mover inside an obstacle is a hit', hit);
  ok('  and ends up outside it', !pointInPolygon(m, window_), `(${m.x}, ${m.y})`);
  ok('  pushed clear by its radius', near(m.x, 392), `x ${m.x}`);
  ok('  and sent back the way it came', m.vx < 0, `vx ${m.vx}`);

  // The rule that stops a fast ball crossing a pane: approaching within the
  // radius counts, before the centre is ever inside. This is why the effect
  // substeps rather than relying on recovering from a deep penetration —
  // once a mover is past the middle of a pane the nearest way out is the far
  // side, and no local rule can tell that it should have bounced.
  const grazing = { x: 396, y: 275, vx: 300, vy: 0 };
  ok('an approach within the radius already counts as contact', deflect(window_, grazing, 10, 1, false));
  ok('  and turns it away', grazing.vx < 0, `vx ${grazing.vx}`);

  // Deep penetration is not recoverable, but it must at least not leave the
  // mover stuck inside, jittering on the boundary forever.
  const deep = { x: 590, y: 275, vx: 300, vy: 0 };
  deflect(window_, deep, 8, 1, false);
  ok('a deeply penetrating mover is still put outside', !pointInPolygon(deep, window_), `(${deep.x}, ${deep.y})`);
  ok('  and is not left heading back into it', deep.vx > 0, `vx ${deep.vx}`);
}

/* ------------------------------------------------------------------ *
 * Free space
 * ------------------------------------------------------------------ */

console.log('\n— free space —');
{
  const wall = geo(rect(0, 0, 1000, 600), 'wall');
  const windows = [geo(rect(100, 100, 200, 200), 'w1'), geo(rect(600, 100, 200, 200), 'w2')];

  ok('a point on bare wall is clear', isClear(wall, windows, 450, 200));
  ok('a point in a window is not', !isClear(wall, windows, 200, 200));
  ok('a point off the wall entirely is not', !isClear(wall, windows, 1200, 200));

  // Deterministic generator, so the result is reproducible.
  let seed = 1;
  const rng = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let allClear = true;
  for (let i = 0; i < 200; i++) {
    const spot = findFreeSpot(wall, windows, rng);
    if (!isClear(wall, windows, spot.x, spot.y)) allClear = false;
  }
  ok('every spawn point found is on bare wall', allClear);

  const near1 = nearestSurface(windows, 320, 200, 60);
  ok('the nearest window is found within range', near1 && near1.shape.id === 'w1', near1?.shape.id);
  ok('  at the right distance', near1 && near(near1.dist, 20), `${near1?.dist}`);
  ok('and nothing is found beyond the range', !nearestSurface(windows, 450, 200, 60));
}

console.log('\n— tag resolution —');
{
  const shapes = {
    window: [geo(rect(0, 0, 10, 10), 'w')],
    door: [geo(rect(20, 0, 10, 10), 'd')],
    roof: [{ id: 'r', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], closed: false, bbox: {} }],
  };
  const lookup = (tag) => shapes[tag] || [];

  ok('several tags resolve into one list', collectObstacles(lookup, 'window, door').length === 2);
  ok('an empty tag list means nothing is solid', collectObstacles(lookup, '  ').length === 0);
  ok('unknown tags are ignored rather than throwing', collectObstacles(lookup, 'window, chimney').length === 1);
  ok('an open path has no inside, so it is not an obstacle', collectObstacles(lookup, 'roof').length === 0);
  ok(
    'the same shape under two tags is only listed once',
    collectObstacles((tag) => (tag === 'a' || tag === 'b' ? shapes.window : []), 'a, b').length === 1
  );
}

/* ------------------------------------------------------------------ *
 * Automatic edge blending
 *
 * The case that matters: two projectors side by side with a known overlap.
 * Each has to fade out across exactly the band the other fades in across, or
 * the wall gets a bright stripe down the middle of the seam.
 * ------------------------------------------------------------------ */

console.log('\n— edge blending —');

/** World -> projector homography for a projector covering [x0..x1] of the world. */
function projectorOver(x0, x1, y0 = 0, y1 = 1) {
  return solveHomography(
    [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ],
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]
  );
}

{
  // Left projector covers 0.0–0.6, right covers 0.4–1.0: they share 0.4–0.6,
  // which is a third of each projector's own width.
  const left = projectorOver(0, 0.6);
  const right = projectorOver(0.4, 1);

  const l = computeEdgeBlends(left, [right]);
  const r = computeEdgeBlends(right, [left]);

  ok('the overlapped edge is feathered', l.right > 0.25, `right ${l.right.toFixed(3)}`);
  ok('  by the true depth of the overlap', Math.abs(l.right - 1 / 3) < 0.05, `${l.right.toFixed(3)} vs 0.333`);
  ok('the far edge is left alone', l.left === 0, `left ${l.left}`);
  ok('and so are the edges with nothing beyond them', l.top === 0 && l.bottom === 0);

  ok('the other projector feathers its facing edge', r.left > 0.25, `left ${r.left.toFixed(3)}`);
  ok('  by a matching amount, so the two ramps sum to one', Math.abs(l.right - r.left) < 0.03);
  ok('  and not its far edge', r.right === 0);
}

{
  // Butted up against each other with no overlap at all.
  const a = projectorOver(0, 0.5);
  const b = projectorOver(0.5, 1);
  const blends = computeEdgeBlends(a, [b]);
  ok(
    'projectors that merely touch are not feathered',
    blends.left === 0 && blends.right === 0 && blends.top === 0 && blends.bottom === 0,
    JSON.stringify(blends)
  );
  ok('and they do not report as overlapping', !projectorsOverlap(a, b));
}

{
  const a = projectorOver(0, 0.6);
  const b = projectorOver(0.4, 1);
  ok('overlapping projectors are detected', projectorsOverlap(a, b) && projectorsOverlap(b, a));

  ok('a projector with no peers is never feathered', computeEdgeBlends(a, []).right === 0);
  ok('an unaligned projector yields no feather rather than throwing', computeEdgeBlends(null, [b]).right === 0);
}

{
  // Stacked rather than side by side, to catch a transposed top/bottom.
  const top = projectorOver(0, 1, 0, 0.6);
  const bottom = projectorOver(0, 1, 0.4, 1);
  const t = computeEdgeBlends(top, [bottom]);
  const b = computeEdgeBlends(bottom, [top]);
  ok('a projector overlapped from below feathers its bottom', t.bottom > 0.25 && t.top === 0, JSON.stringify(t));
  ok('and the one below feathers its top', b.top > 0.25 && b.bottom === 0, JSON.stringify(b));
  ok('neither touches its left or right', t.left === 0 && t.right === 0 && b.left === 0 && b.right === 0);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
