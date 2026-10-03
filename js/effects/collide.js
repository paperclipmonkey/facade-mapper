/**
 * Surface collision for falling things.
 *
 * Snow that falls *past* the house is a screensaver. Snow that piles on the
 * window sills, rounds off, overloads and slides away in a slab is the house
 * being in the weather. This module is the difference.
 *
 * The model is a heightfield, not a physics engine. Everything the house
 * presents to falling snow is its *top* outline, so the traced shapes collapse
 * to one number per column: the highest surface at that x. Landing is then a
 * single array lookup per flake, piling is `depth[column] += a bit`, and slumping
 * is a couple of passes over a small array. That is fast enough to run per frame
 * at any flake count, and — more to the point — it produces the right shapes,
 * because a drift really is a height per position that flows downhill until it
 * is shallow enough to stay put.
 *
 * Coordinates are world pixels throughout, with y increasing downwards, so
 * "higher" means a *smaller* y. That inversion is easy to get backwards; the
 * comparisons below are written out longhand for that reason.
 */

import { clamp, lerp, frac } from '../core/math.js';

/* ------------------------------------------------------------------ *
 * The heightfield
 * ------------------------------------------------------------------ */

/**
 * Collapse a set of shapes into the top surface they present, sampled into
 * `columns` evenly spaced buckets across the world.
 *
 * Every edge of every shape is walked and rasterised across the columns it
 * spans, keeping the minimum y. Taking the minimum over *all* edges rather than
 * trying to identify upward-facing ones is deliberate: for a closed outline the
 * two give the same answer, and for an open path — a traced roofline or gutter,
 * which is exactly what you want snow to sit on — only the minimum is meaningful.
 *
 * `surface[c]` is `Infinity` where no shape covers that column, which reads
 * naturally as "nothing to land on here".
 */
export function buildHeightfield(shapes, world, columns = 260) {
  const cols = Math.max(16, Math.round(columns));
  const colW = world.w / cols;
  const surface = new Float32Array(cols).fill(Infinity);

  for (const geo of shapes) {
    const pts = geo.points;
    if (!pts || pts.length < 2) continue;
    const segments = geo.closed ? pts.length : pts.length - 1;

    for (let e = 0; e < segments; e++) {
      const a = pts[e];
      const b = pts[(e + 1) % pts.length];
      let x0 = a.x;
      let y0 = a.y;
      let x1 = b.x;
      let y1 = b.y;
      if (x1 < x0) {
        x0 = b.x; y0 = b.y;
        x1 = a.x; y1 = a.y;
      }

      const c0 = Math.max(0, Math.floor(x0 / colW));
      const c1 = Math.min(cols - 1, Math.floor(x1 / colW));
      if (c1 < c0) continue;

      const dx = x1 - x0;
      for (let c = c0; c <= c1; c++) {
        // A near-vertical edge spans one column and contributes its whole
        // extent to it, so take the higher end rather than interpolating.
        const y = dx > 1e-6
          ? y0 + (y1 - y0) * clamp(((c + 0.5) * colW - x0) / dx, 0, 1)
          : Math.min(y0, y1);
        if (y < surface[c]) surface[c] = y;
      }
    }
  }

  return { cols, colW, surface, worldW: world.w, worldH: world.h };
}

/**
 * One surface per shape, each with its own accumulation, rebuilt only when the
 * geometry behind it actually changed.
 *
 * Per shape, not one combined field, and that is the whole design decision. A
 * combined field keeps only the topmost surface in each column, so on a facade
 * — where a traced roofline spans the full width — every window and door below
 * it sits in the roof's shadow and never collects a flake. Real snow on a flat
 * elevation gathers on *every* ledge it can reach, so every shape gets its own
 * surface and they are tested independently.
 *
 * The renderer's geometry cache hands back the same object for a shape that has
 * not moved, so identity comparison over the list is both exact and free — no
 * hashing, and nothing can go stale if a caller forgets to invalidate.
 */
export function ensureSurfaces(store, key, shapes, world, columns = 260) {
  const previous = store[key];
  if (
    previous
    && previous.sources.length === shapes.length
    && previous.worldW === world.w
    && previous.worldH === world.h
    && previous.columns === columns
    && previous.sources.every((geo, i) => geo === shapes[i])
  ) {
    return previous.surfaces;
  }

  // Carry existing drifts across a rebuild where the shape is unchanged, so
  // editing one window does not dump the snow off all the others.
  const carried = new Map((previous?.surfaces || []).map((s) => [s.geo, s.drift]));
  const surfaces = shapes.map((geo) => {
    const field = buildHeightfield([geo], world, columns);
    const drift = carried.get(geo) || { depth: new Float32Array(field.cols), slabs: [] };
    return { geo, field, drift };
  });

  store[key] = {
    sources: shapes.slice(),
    surfaces,
    columns,
    worldW: world.w,
    worldH: world.h,
  };
  return surfaces;
}

/* ------------------------------------------------------------------ *
 * Accumulation
 * ------------------------------------------------------------------ */

/** Depth of settled material per column, plus any slabs currently falling. */
export function ensureDrift(state, key, field) {
  let drift = state[key];
  if (!drift || drift.depth.length !== field.cols) {
    drift = { depth: new Float32Array(field.cols), slabs: [] };
    state[key] = drift;
  }
  return drift;
}

/** Which column an x falls in, or -1 if it is off the field. */
export function columnAt(field, x) {
  const c = Math.floor(x / field.colW);
  return c < 0 || c >= field.cols ? -1 : c;
}

/**
 * Find where a point that moved from `prevY` to `y` first meets a surface.
 *
 * A swept test rather than a "was I below it" test, for two reasons. It cannot
 * miss a thin ledge that a fast flake stepped straight over between frames, and
 * — the one that matters with several surfaces stacked up a facade — a flake
 * that starts life below a window top does not teleport up onto it. Only a
 * surface genuinely crossed this frame counts.
 *
 * Returns `{ surface, col }` or null.
 */
export function sweepLanding(surfaces, x, prevY, y) {
  let best = null;
  let bestTop = Infinity;
  for (const entry of surfaces) {
    const { field, drift } = entry;
    const c = columnAt(field, x);
    if (c < 0) continue;
    const base = field.surface[c];
    if (!Number.isFinite(base)) continue;
    const top = base - drift.depth[c];
    // Crossed downwards this frame, and the highest such surface wins — that
    // is the first thing the flake would actually have hit on the way down.
    if (prevY < top && y >= top && top < bestTop) {
      bestTop = top;
      best = { surface: entry, col: c };
    }
  }
  return best;
}

/**
 * Let the drift flow downhill until no neighbouring pair is steeper than the
 * angle of repose.
 *
 * Without this, snow lands in vertical spikes wherever the flakes happened to
 * fall, which looks like a bar chart. Snow has a repose angle of roughly 35–40°
 * — steeper than that and it slumps — so equalising towards that slope is what
 * turns a histogram into a drift. Note it operates on the *combined* top
 * (surface minus depth), not on depth alone: material flows downhill in the
 * world, so a sloped sill correctly drifts to its low end.
 *
 * A large step between neighbouring surfaces is a cliff — the edge of a sill,
 * the end of a roofline — and material must not flow across it into thin air.
 * Those columns are left alone; `shedSlabs` is what takes snow over an edge.
 */
export function settle(drift, field, reposeRad, passes = 2) {
  const { depth } = drift;
  const { surface, cols, colW } = field;
  const maxDrop = Math.tan(clamp(reposeRad, 0.05, 1.4)) * colW;
  const cliff = colW * 6;

  for (let pass = 0; pass < passes; pass++) {
    for (let c = 0; c < cols - 1; c++) {
      const s0 = surface[c];
      const s1 = surface[c + 1];
      if (!Number.isFinite(s0) || !Number.isFinite(s1)) continue;
      if (Math.abs(s0 - s1) > cliff) continue;

      const top0 = s0 - depth[c];
      const top1 = s1 - depth[c + 1];
      // Smaller y is higher, so a positive excess means column c stands too
      // far above its neighbour and must give material away.
      const excess = top1 - top0 - maxDrop;
      if (excess > 0) {
        if (depth[c] <= 0) continue;
        const move = Math.min(depth[c], excess * 0.5);
        depth[c] -= move;
        depth[c + 1] += move;
      } else {
        const other = top0 - top1 - maxDrop;
        if (other > 0 && depth[c + 1] > 0) {
          const move = Math.min(depth[c + 1], other * 0.5);
          depth[c + 1] -= move;
          depth[c] += move;
        }
      }
    }
  }
}

/**
 * Detach overloaded runs of drift as falling slabs.
 *
 * Two things dislodge settled snow: it gets too heavy for what it is sitting
 * on, and something knocks it. Both are here — a depth threshold, and a random
 * per-second chance standing in for a gust — because a pure threshold makes
 * every sill shed at the same moment, which reads as scripted. The gust chance
 * is cubed in the load so a shallow crust is essentially safe and only a heavily
 * laden ledge is at real risk; a linear chance strips drifts as fast as they
 * form and nothing ever visibly builds.
 *
 * A slab takes the contiguous run of *laden* columns around the trigger point,
 * since snow lets go in sheets — but it takes only the material above `retain`,
 * leaving the crust that in reality stays frozen to the ledge. Stripping to bare
 * surface is what turns accumulation into a sawtooth that never looks like
 * anything.
 */
export function shedSlabs(drift, field, opts) {
  const { depth, slabs } = drift;
  const { surface, cols, colW } = field;
  const {
    maxDepth, gustChance = 0, dt = 0, rng,
    minDepth = 1.2, maxSlabs = 24, retain = 0.3,
  } = opts;

  const heavy = maxDepth * 0.55;
  const keep = maxDepth * clamp(retain, 0, 0.9);

  for (let c = 0; c < cols; c++) {
    if (depth[c] < Math.max(minDepth, keep)) continue;
    const load = clamp(depth[c] / Math.max(1, maxDepth), 0, 1);
    const overloaded = depth[c] >= maxDepth;
    const knocked = gustChance > 0 && rng() < gustChance * dt * load * load * load;
    if (!overloaded && !knocked) continue;
    if (slabs.length >= maxSlabs) break;

    // Walk out over the neighbouring columns that are also carrying weight.
    let lo = c;
    let hi = c;
    while (lo > 0 && depth[lo - 1] > heavy && Number.isFinite(surface[lo - 1])) lo--;
    while (hi < cols - 1 && depth[hi + 1] > heavy && Number.isFinite(surface[hi + 1])) hi++;

    let total = 0;
    let topY = Infinity;
    for (let i = lo; i <= hi; i++) {
      const released = Math.max(0, depth[i] - keep);
      total += released;
      topY = Math.min(topY, surface[i] - depth[i]);
      depth[i] -= released;
    }
    const width = (hi - lo + 1) * colW;
    const mean = total / (hi - lo + 1);
    if (mean < minDepth * 0.5) {
      c = hi;
      continue;
    }

    // A wide run does not come away as one rigid sheet — it cracks. Splitting
    // it into chunks that fall at slightly different speeds is what turns a
    // sliding rectangle into snow coming off a ledge.
    const chunks = Math.max(1, Math.min(6, Math.round(width / 70)));
    const chunkW = width / chunks;
    for (let k = 0; k < chunks; k++) {
      slabs.push({
        x: lo * colW + chunkW * (k + 0.5),
        y: topY + mean * 0.5,
        w: chunkW * (0.82 + rng() * 0.22),
        h: Math.max(2, mean * (0.75 + rng() * 0.5)),
        vx: (rng() - 0.5) * 26,
        vy: 6 + rng() * 26,
        angle: 0,
        spin: (rng() - 0.5) * 1.4,
        age: 0,
      });
      if (slabs.length >= maxSlabs) break;
    }
    c = hi;
  }
}

/**
 * Advance falling slabs and drop the ones that have left the frame.
 *
 * They stretch as they accelerate, which is the cheapest honest substitute for
 * motion blur, and fade over the last stretch of the drop rather than winking
 * out at the bottom edge.
 */
export function advanceSlabs(drift, field, dt, gravity, fadeFrom = 0.72) {
  const { slabs } = drift;
  const floor = field.worldH;
  for (let i = slabs.length - 1; i >= 0; i--) {
    const slab = slabs[i];
    slab.age += dt;
    slab.vy += gravity * dt;
    slab.x += slab.vx * dt;
    slab.y += slab.vy * dt;
    slab.angle += slab.spin * dt;

    const fadeStart = floor * fadeFrom;
    slab.alpha = slab.y <= fadeStart
      ? 1
      : clamp(1 - (slab.y - fadeStart) / Math.max(1, floor - fadeStart), 0, 1);
    // A little vertical smear with speed, as the cheapest honest stand-in for
    // motion blur. Kept mild: past about half again its own height a falling
    // lump stops reading as snow and starts reading as a scratch on the lens.
    slab.stretch = 1 + clamp(slab.vy / 1600, 0, 0.5);

    if (slab.alpha <= 0.01 || slab.y - slab.h > floor) slabs.splice(i, 1);
  }
}

/* ------------------------------------------------------------------ *
 * Drawing
 * ------------------------------------------------------------------ */

/**
 * Settled snow, as it should be painted.
 *
 * The simulation keeps a depth per column, and every landing goes into the
 * one column the particle hit. With a few hundred flakes that is a sparse,
 * spiky record, and drawn as it stands — each loaded run of columns its own
 * little shape — it comes out as dashed white bars along every sill.
 *
 * Snow does not lie like that. On anything flat it settles evenly, rounds off
 * at the ends where it overhangs, and its surface undulates gently. So it is
 * painted from a *display* profile rather than from the raw columns: short
 * gaps between loaded columns — the statistics of a few hundred flakes — are
 * bridged, so a ledge that is receiving snow carries one continuous drift;
 * long bare stretches, where something above shelters the ledge, stay bare.
 * Then it is blurred along the ledge (never across a step to a different
 * ledge) and tapered into a rounded nose at each end.
 */
/** Columns either side the display profile is blurred over. */
const DRIFT_REACH = 4;
/** The widest gap, in columns, that is the luck of the flakes rather than shelter. */
const DRIFT_BRIDGE = 7;
/** Shallower than this, in pixels, and there is no snow to draw. */
export const DRIFT_MIN = 0.45;

/**
 * The drift as it should be painted, into `out`, one depth per column.
 *
 * `filled` is scratch of the same length. Both are the caller's, so a draw
 * allocates nothing; the simulation's own `depth` is only read.
 */
export function driftProfile(drift, field, out, filled) {
  const { depth } = drift;
  const { surface, cols, colW } = field;
  const cliff = colW * 2.5;
  let c = 0;
  while (c < cols) {
    if (!Number.isFinite(surface[c])) {
      out[c] = 0;
      c++;
      continue;
    }
    let end = c;
    while (end + 1 < cols && Number.isFinite(surface[end + 1])
      && Math.abs(surface[end + 1] - surface[end]) < cliff) end++;

    // Bridge short gaps: a bare column with loaded ones close on both sides
    // takes the interpolation between them.
    let last = -1;
    for (let i = c; i <= end; i++) {
      filled[i] = depth[i];
      if (depth[i] > 0.2) {
        if (last >= 0 && i - last > 1 && i - last <= DRIFT_BRIDGE + 1) {
          for (let j = last + 1; j < i; j++) {
            filled[j] = lerp(depth[last], depth[i], (j - last) / (i - last));
          }
        }
        last = i;
      }
    }

    for (let i = c; i <= end; i++) {
      let s = 0;
      let w = 0;
      for (let k = -DRIFT_REACH; k <= DRIFT_REACH; k++) {
        const j = i + k;
        if (j < c || j > end) continue;
        const wt = DRIFT_REACH + 1 - Math.abs(k);
        s += filled[j] * wt;
        w += wt;
      }
      // Rounded at the ends of the ledge: a square root of a ramp is a
      // bullnose, not a wedge.
      const fromEnd = Math.min(i - c, end - i) + 0.5;
      out[i] = (s / w) * Math.sqrt(Math.min(1, fromEnd / 2.4));
    }
    c = end + 1;
  }
}

/** The top of a run of drift, left to right, into the current path. */
export function traceDriftTop(g, surface, prof, colW, c, end, start) {
  const xAt = (i) => (i + 0.5) * colW;
  const topAt = (i) => surface[i] - prof[i];
  const x0 = xAt(c) - colW * 0.5;
  if (start) g.moveTo(x0, surface[c]);
  else g.lineTo(x0, surface[c]);
  // Up over a rounded nose at the left end...
  g.quadraticCurveTo(x0, topAt(c), xAt(c), topAt(c));
  // ...along the top through the midpoints, which rounds the profile...
  for (let i = c; i < end; i++) {
    g.quadraticCurveTo(xAt(i), topAt(i), (xAt(i) + xAt(i + 1)) / 2, (topAt(i) + topAt(i + 1)) / 2);
  }
  // ...and down over the nose at the right.
  const x1 = xAt(end) + colW * 0.5;
  g.quadraticCurveTo(xAt(end), topAt(end), x1, topAt(end));
  g.quadraticCurveTo(x1 + colW * 0.15, (topAt(end) + surface[end]) / 2, x1, surface[end]);
}


/** Scratch for `drawDrift`, grown when a wider field turns up and otherwise reused. */
let driftScratch = new Float32Array(0);

/**
 * Fill the settled drift: a body sitting on the surface, and a crest.
 *
 * Drawn from the display profile above. The top edge passes through the
 * midpoints of adjacent columns with quadratic segments, which rounds it the
 * way a real drift is rounded without needing a finer field; the underside
 * follows the surface exactly, so the snow sits *on* the sill rather than
 * floating above it. A thin run — a dusting — is drawn fainter than a deep
 * one, because a film of snow is a grey veil and not a bright line.
 *
 * `style.minDepth` is the shallowest snow worth drawing, in pixels.
 */
export function drawDrift(g, drift, field, style) {
  const { surface, cols, colW } = field;
  const { fill, crest, minDepth = DRIFT_MIN } = style;
  if (driftScratch.length < cols * 2) driftScratch = new Float32Array(cols * 2);
  const prof = driftScratch.subarray(0, cols);
  driftProfile(drift, field, prof, driftScratch.subarray(cols, cols * 2));

  const alpha = g.globalAlpha;
  let c = 0;
  while (c < cols) {
    if (!(prof[c] >= minDepth) || !Number.isFinite(surface[c])) {
      c++;
      continue;
    }
    let end = c;
    let deepest = prof[c];
    while (end + 1 < cols && prof[end + 1] >= minDepth && Number.isFinite(surface[end + 1])
      && Math.abs(surface[end + 1] - surface[end]) < colW * 2.5) {
      end++;
      deepest = Math.max(deepest, prof[end]);
    }
    g.globalAlpha = alpha * clamp(0.3 + deepest / 4.5, 0.3, 1);

    g.beginPath();
    traceDriftTop(g, surface, prof, colW, c, end, true);
    for (let i = end; i >= c; i--) g.lineTo((i + 0.5) * colW, surface[i]);
    g.closePath();
    g.fillStyle = fill;
    g.fill();

    if (crest) {
      // Snow catches the light along its top edge and nowhere else, which is
      // most of what makes a white shape read as a rounded volume. Clipped to
      // the body, so the light falls off downwards rather than spilling over.
      g.save();
      g.clip();
      g.beginPath();
      traceDriftTop(g, surface, prof, colW, c, end, true);
      g.strokeStyle = crest;
      g.lineWidth = Math.max(1, Math.min(4, deepest * 0.45));
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.stroke();
      g.restore();
    }
    c = end + 1;
  }
  g.globalAlpha = alpha;
}

/**
 * Draw the falling slabs.
 *
 * A slab is a run of drift that let go together, and it does not stay a slab:
 * it comes apart as it falls. Drawn as the one wide flat shape it starts as,
 * it is a white dash sliding down the wall — so each is a few rounded lumps
 * spread unevenly across its width, opening out as it ages, stretched by its
 * speed and fading out low down. Where each lump sits is a function of the
 * slab's own numbers, so this needs no memory of its own. Snow, which has
 * baked sprites to hand, paints its slabs softer still; see christmas.js.
 */
export function drawSlabs(g, drift, style) {
  const { fill, crest } = style;
  const alpha = g.globalAlpha;
  for (const slab of drift.slabs) {
    const fade = slab.alpha ?? 1;
    if (fade <= 0.01) continue;
    const stretch = slab.stretch ?? 1;
    const age = slab.age || 0;
    const h = Math.max(1.5, slab.h);
    const lumps = clamp(Math.round(slab.w / (h * 1.6)), 2, 6);
    // Opening out more gently than Snow's soft sprites do: these are hard-edged
    // lumps, and spread as far they read as a scatter of beads.
    const spread = 1 + age * 0.28;
    g.globalAlpha = alpha * fade;
    for (let k = 0; k < lumps; k++) {
      const j1 = frac(Math.sin(slab.w * 12.9898 + k * 78.233) * 43758.5453);
      const j2 = frac(Math.sin(slab.h * 39.3468 + k * 11.135) * 24634.6345);
      const j3 = frac(Math.sin(slab.w * 7.233 + slab.h * 3.17 + k * 51.71) * 15731.743);
      const slot = (k + (j1 - 0.5) * 0.8) / (lumps - 1) - 0.5;
      const x = slab.x + slot * slab.w * 0.8 * spread;
      const y = slab.y + (j2 - 0.5) * h * 1.4 + (j3 - 0.4) * age * age * 70;
      const r = h * (0.55 + 0.95 * j3 * j3);
      g.beginPath();
      g.ellipse(x, y, r, Math.max(1, r * 0.8 * stretch), slab.angle || 0, 0, Math.PI * 2);
      g.fillStyle = fill;
      g.fill();
      if (crest) {
        g.beginPath();
        g.ellipse(x, y - r * 0.25, r * 0.6, Math.max(0.6, r * 0.32), 0, Math.PI, Math.PI * 2);
        g.strokeStyle = crest;
        g.lineWidth = Math.max(0.6, r * 0.18);
        g.stroke();
      }
    }
  }
  g.globalAlpha = alpha;
}
