/**
 * Surface collision: heightfields, landing, slumping and shedding.
 *
 * Pure functions over synthetic geometry, so this runs in plain Node with no
 * DOM and no dependencies.
 *
 * Worth testing carefully because every failure mode here is silent. World
 * coordinates run y-down, so "higher" is a smaller number and every comparison
 * in the module is one sign away from being exactly backwards — snow that
 * settles on the underside of a sill, or slumps uphill, still renders happily.
 * The accumulation is also stateful across frames, which is how the first
 * version came to strip every drift to bare surface as fast as it built: each
 * frame looked fine on its own.
 *
 *   node test/collide.test.mjs
 */

import {
  buildHeightfield,
  ensureSurfaces,
  sweepLanding,
  settle,
  shedSlabs,
  advanceSlabs,
} from '../js/effects/collide.js';

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

const WORLD = { w: 1920, h: 1080 };
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

/** A shape as the renderer's geometry cache would hand it over. */
const geo = (points, closed = true, id = 's') => ({ id, points, closed, tags: [] });

/* ------------------------------------------------------------------ *
 * Heightfield
 * ------------------------------------------------------------------ */

{
  console.log('\n— heightfield —');

  // A flat ledge across the left half of the world.
  const ledge = geo([{ x: 0, y: 400 }, { x: 960, y: 400 }], false);
  const field = buildHeightfield([ledge], WORLD, 240);

  ok('columns under the ledge carry its height',
     near(field.surface[10], 400) && near(field.surface[110], 400));
  ok('columns past the end carry nothing',
     !Number.isFinite(field.surface[150]) && !Number.isFinite(field.surface[239]));

  // A sloped roofline: y falls from 500 to 100 across the world.
  const roof = buildHeightfield(
    [geo([{ x: 0, y: 500 }, { x: 1920, y: 100 }], false)], WORLD, 240
  );
  ok('a slope interpolates across its columns',
     roof.surface[0] > roof.surface[120] && roof.surface[120] > roof.surface[239],
     `${roof.surface[0].toFixed(0)} → ${roof.surface[120].toFixed(0)} → ${roof.surface[239].toFixed(0)}`);
  ok('the slope midpoint is halfway down', Math.abs(roof.surface[120] - 300) < 6,
     roof.surface[120].toFixed(1));

  // A closed rectangle presents its *top* edge, not its bottom.
  const box = buildHeightfield(
    [geo([{ x: 400, y: 300 }, { x: 800, y: 300 }, { x: 800, y: 700 }, { x: 400, y: 700 }])],
    WORLD, 240
  );
  ok('a closed shape presents its top edge', near(box.surface[70], 300),
     String(box.surface[70]));

  // Several shapes in one field keep only the highest surface — which is why
  // snow uses one field per shape instead.
  const both = buildHeightfield([
    geo([{ x: 0, y: 200 }, { x: 1920, y: 200 }], false, 'a'),
    geo([{ x: 0, y: 600 }, { x: 1920, y: 600 }], false, 'b'),
  ], WORLD, 240);
  ok('a combined field keeps only the topmost surface', near(both.surface[100], 200));
}

/* ------------------------------------------------------------------ *
 * Per-shape surfaces
 * ------------------------------------------------------------------ */

{
  console.log('\n— per-shape surfaces —');

  const upper = geo([{ x: 0, y: 200 }, { x: 1920, y: 200 }], false, 'upper');
  const lower = geo([{ x: 0, y: 600 }, { x: 1920, y: 600 }], false, 'lower');
  const store = {};
  const surfaces = ensureSurfaces(store, 'k', [upper, lower], WORLD, 240);

  ok('every shape gets its own surface', surfaces.length === 2);
  ok('a shape below another is not shadowed by it',
     near(surfaces[1].field.surface[100], 600),
     String(surfaces[1].field.surface[100]));

  const again = ensureSurfaces(store, 'k', [upper, lower], WORLD, 240);
  ok('unchanged geometry is not rebuilt', again === surfaces);

  // Accumulate on the lower shape, then edit the upper one. The lower shape's
  // drift must survive: editing one window should not dump the snow off another.
  surfaces[1].drift.depth[100] = 12;
  const moved = geo([{ x: 0, y: 150 }, { x: 1920, y: 150 }], false, 'upper');
  const rebuilt = ensureSurfaces(store, 'k', [moved, lower], WORLD, 240);
  ok('an untouched shape keeps its accumulation across a rebuild',
     near(rebuilt[1].drift.depth[100], 12), String(rebuilt[1].drift.depth[100]));
  ok('the edited shape picks up its new height',
     near(rebuilt[0].field.surface[100], 150));
}

/* ------------------------------------------------------------------ *
 * Landing
 * ------------------------------------------------------------------ */

{
  console.log('\n— landing —');

  const store = {};
  const surfaces = ensureSurfaces(store, 'k', [
    geo([{ x: 0, y: 200 }, { x: 1920, y: 200 }], false, 'upper'),
    geo([{ x: 0, y: 600 }, { x: 1920, y: 600 }], false, 'lower'),
  ], WORLD, 240);

  ok('a flake that crosses a surface lands on it',
     sweepLanding(surfaces, 500, 190, 210) !== null);
  ok('a flake still in free air does not land',
     sweepLanding(surfaces, 500, 100, 150) === null);

  // The one that matters on a facade: a flake released between two ledges must
  // fall to the lower one, not snap up to the one it started beneath.
  const between = sweepLanding(surfaces, 500, 590, 610);
  ok('a flake below a surface does not teleport up to it',
     between !== null && between.surface.geo.id === 'lower',
     between ? between.surface.geo.id : 'null');

  // Crossing both in a single step lands on the higher — the first thing it
  // would actually have hit on the way down.
  const swept = sweepLanding(surfaces, 500, 100, 900);
  ok('crossing two surfaces in one step lands on the upper',
     swept !== null && swept.surface.geo.id === 'upper',
     swept ? swept.surface.geo.id : 'null');

  ok('a flake beyond the shape lands on nothing',
     sweepLanding(
       ensureSurfaces({}, 'k', [geo([{ x: 0, y: 200 }, { x: 100, y: 200 }], false)], WORLD, 240),
       1500, 190, 210
     ) === null);

  // Already-settled snow raises the surface, so the next flake lands on top.
  surfaces[0].drift.depth[62] = 40;
  const onDrift = sweepLanding(surfaces, 500, 150, 170);
  ok('a flake lands on the accumulated snow, not the bare surface',
     onDrift !== null && onDrift.surface.geo.id === 'upper');
}

/* ------------------------------------------------------------------ *
 * Slumping
 * ------------------------------------------------------------------ */

{
  console.log('\n— slumping —');

  const field = buildHeightfield(
    [geo([{ x: 0, y: 400 }, { x: 1920, y: 400 }], false)], WORLD, 240
  );
  const drift = { depth: new Float32Array(240), slabs: [] };
  drift.depth[120] = 60;
  const before = drift.depth.reduce((a, b) => a + b, 0);

  settle(drift, field, 0.66, 6);
  const after = drift.depth.reduce((a, b) => a + b, 0);

  ok('slumping conserves material', Math.abs(before - after) < 1e-3,
     `${before.toFixed(3)} → ${after.toFixed(3)}`);
  ok('a spike spreads to its neighbours',
     drift.depth[120] < 60 && drift.depth[119] > 0 && drift.depth[121] > 0,
     `peak ${drift.depth[120].toFixed(1)}`);
  ok('the pile stays centred on where it landed',
     drift.depth[120] >= drift.depth[119] && drift.depth[119] >= drift.depth[115]);

  // Slumping is against the *repose angle*, not against any slope at all, so
  // which way a drift moves depends on how steep the thing under it is.

  // 17°, shallower than snow's ~38° repose: a laid layer stays where it is.
  const gentle = buildHeightfield(
    [geo([{ x: 0, y: 200 }, { x: 1920, y: 800 }], false)], WORLD, 240
  );
  const onGentle = { depth: new Float32Array(240), slabs: [] };
  for (let i = 100; i < 140; i++) onGentle.depth[i] = 20;
  settle(onGentle, gentle, 0.66, 8);
  ok('a layer on a shallow slope holds', near(onGentle.depth[120], 20, 0.01),
     `${onGentle.depth[120].toFixed(2)} in the middle of the band`);

  // 55°, steeper than repose: the same layer migrates down the slope. Measured
  // as centre of mass, since the leading edge runs off past any fixed column.
  const centre = (d) => {
    let mass = 0;
    let moment = 0;
    for (let i = 0; i < d.length; i++) { mass += d[i]; moment += d[i] * i; }
    return mass > 0 ? moment / mass : 0;
  };
  const steep = buildHeightfield(
    [geo([{ x: 0, y: 0 }, { x: 1920, y: 2740 }], false)], WORLD, 240
  );
  const onSteep = { depth: new Float32Array(240), slabs: [] };
  for (let i = 100; i < 140; i++) onSteep.depth[i] = 20;
  const startedAt = centre(onSteep.depth);
  settle(onSteep, steep, 0.66, 8);
  ok('a layer on a slope steeper than repose slides downhill',
     centre(onSteep.depth) > startedAt + 1,
     `centre of mass ${startedAt.toFixed(1)} → ${centre(onSteep.depth).toFixed(1)}`);
  ok('and the shallow slope barely moves its centre of mass',
     Math.abs(centre(onGentle.depth) - startedAt) < 0.5,
     `centre of mass ${centre(onGentle.depth).toFixed(2)}`);
}

/* ------------------------------------------------------------------ *
 * Shedding
 * ------------------------------------------------------------------ */

{
  console.log('\n— shedding —');

  const field = buildHeightfield(
    [geo([{ x: 0, y: 400 }, { x: 1920, y: 400 }], false)], WORLD, 240
  );
  const drift = { depth: new Float32Array(240), slabs: [] };
  for (let i = 100; i < 130; i++) drift.depth[i] = 40;

  shedSlabs(drift, field, { maxDepth: 20, gustChance: 0, dt: 1 / 60, rng: () => 0.5, retain: 0.3 });

  ok('an overloaded run sheds', drift.slabs.length > 0, `${drift.slabs.length} slabs`);
  ok('it leaves a crust rather than stripping to bare surface',
     drift.depth[110] > 0, String(drift.depth[110].toFixed(2)));
  ok('the crust is the retained fraction', near(drift.depth[110], 6, 0.01),
     String(drift.depth[110].toFixed(2)));
  ok('a wide run breaks into several chunks', drift.slabs.length > 1);

  // A shallow drift must survive a gust, or nothing ever visibly accumulates.
  const shallow = { depth: new Float32Array(240), slabs: [] };
  for (let i = 100; i < 130; i++) shallow.depth[i] = 8;
  for (let f = 0; f < 600; f++) {
    shedSlabs(shallow, field, { maxDepth: 40, gustChance: 0.5, dt: 1 / 60, rng: () => 0.02, retain: 0.3 });
  }
  ok('a shallow drift is not stripped by gusts over ten seconds',
     shallow.slabs.length === 0 && near(shallow.depth[110], 8),
     `depth ${shallow.depth[110].toFixed(1)}, ${shallow.slabs.length} slabs`);

  ok('an empty field sheds nothing', (() => {
    const empty = { depth: new Float32Array(240), slabs: [] };
    shedSlabs(empty, field, { maxDepth: 20, gustChance: 1, dt: 1, rng: () => 0, retain: 0.3 });
    return empty.slabs.length === 0;
  })());
}

/* ------------------------------------------------------------------ *
 * Falling slabs
 * ------------------------------------------------------------------ */

{
  console.log('\n— falling slabs —');

  const field = buildHeightfield(
    [geo([{ x: 0, y: 400 }, { x: 1920, y: 400 }], false)], WORLD, 240
  );
  const drift = {
    depth: new Float32Array(240),
    slabs: [{ x: 900, y: 400, w: 60, h: 10, vx: 0, vy: 0, angle: 0, spin: 0, age: 0 }],
  };

  advanceSlabs(drift, field, 1 / 60, 620);
  ok('a slab accelerates downwards', drift.slabs[0].y > 400 && drift.slabs[0].vy > 0);
  ok('a slab high in the frame is at full opacity', near(drift.slabs[0].alpha, 1));

  drift.slabs[0].y = WORLD.h * 0.9;
  advanceSlabs(drift, field, 1 / 60, 620);
  ok('it fades on the way to the bottom',
     drift.slabs[0].alpha > 0 && drift.slabs[0].alpha < 1,
     String(drift.slabs[0].alpha.toFixed(2)));

  // Run it out and it must clean itself up, or the array grows all night.
  for (let f = 0; f < 600 && drift.slabs.length; f++) advanceSlabs(drift, field, 1 / 60, 620);
  ok('a slab that leaves the frame is removed', drift.slabs.length === 0);
}

/* ------------------------------------------------------------------ *
 * The fx namespace
 * ------------------------------------------------------------------ */

{
  console.log('\n— fx namespace —');

  // effects/lib.js re-exports this module by name for user effects. A rename
  // here leaves a re-export pointing at a symbol that no longer exists, which
  // `node --check` cannot see — it is valid syntax — and which does not break
  // any built-in effect, because those import from collide.js directly. The
  // only thing it breaks is the Code panel, at the moment someone uses it.
  const fx = await import('../js/effects/lib.js');
  const dangling = Object.entries(fx).filter(([, v]) => v === undefined).map(([k]) => k);
  ok('every fx re-export resolves', dangling.length === 0,
     dangling.length ? dangling.join(', ') : `${Object.keys(fx).length} exports`);
  ok('the collision helpers are reachable from fx',
     ['ensureSurfaces', 'sweepLanding', 'settle', 'shedSlabs', 'drawDrift']
       .every((name) => typeof fx[name] === 'function'));
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`);
process.exit(failures ? 1 : 0);
