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

import { clamp } from '../core/math.js';

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
 * Fill the settled drift as one shape per contiguous loaded run.
 *
 * The top edge is drawn through the midpoints of adjacent columns with
 * quadratic segments, which rounds the profile the way a real drift is rounded
 * without needing a finer field. The underside follows the surface exactly, so
 * the snow sits *on* the sill rather than floating above it.
 */
export function drawDrift(g, drift, field, style) {
  const { depth } = drift;
  const { surface, cols, colW } = field;
  const { fill, crest, minDepth = 0.15 } = style;

  let c = 0;
  while (c < cols) {
    if (depth[c] < minDepth || !Number.isFinite(surface[c])) {
      c++;
      continue;
    }
    let end = c;
    while (end + 1 < cols && depth[end + 1] >= minDepth && Number.isFinite(surface[end + 1])) end++;

    const topAt = (i) => surface[i] - depth[i];
    const xAt = (i) => (i + 0.5) * colW;

    g.beginPath();
    // Down to the surface at the left edge of the run, so it meets the sill.
    g.moveTo(xAt(c) - colW * 0.5, surface[c]);
    g.lineTo(xAt(c) - colW * 0.5, topAt(c));
    for (let i = c; i < end; i++) {
      const mx = (xAt(i) + xAt(i + 1)) / 2;
      const my = (topAt(i) + topAt(i + 1)) / 2;
      g.quadraticCurveTo(xAt(i), topAt(i), mx, my);
    }
    g.lineTo(xAt(end) + colW * 0.5, topAt(end));
    g.lineTo(xAt(end) + colW * 0.5, surface[end]);
    for (let i = end; i >= c; i--) g.lineTo(xAt(i), surface[i]);
    g.closePath();
    g.fillStyle = fill;
    g.fill();

    if (crest) {
      // Snow catches the light along its top edge and nowhere else, which is
      // most of what makes a white shape read as a rounded volume.
      g.beginPath();
      g.moveTo(xAt(c) - colW * 0.5, topAt(c));
      for (let i = c; i < end; i++) {
        const mx = (xAt(i) + xAt(i + 1)) / 2;
        const my = (topAt(i) + topAt(i + 1)) / 2;
        g.quadraticCurveTo(xAt(i), topAt(i), mx, my);
      }
      g.lineTo(xAt(end) + colW * 0.5, topAt(end));
      g.strokeStyle = crest;
      g.lineWidth = Math.max(0.75, colW * 0.35);
      g.lineCap = 'round';
      g.stroke();
    }

    c = end + 1;
  }
}

/** Draw the falling slabs. Rounded, stretched by speed, fading out low down. */
export function drawSlabs(g, drift, style) {
  const { fill, crest } = style;
  for (const slab of drift.slabs) {
    g.save();
    g.globalAlpha *= slab.alpha ?? 1;
    g.translate(slab.x, slab.y);
    g.rotate(slab.angle);
    g.beginPath();
    g.ellipse(0, 0, slab.w * 0.5, Math.max(1.5, slab.h * 0.6 * (slab.stretch ?? 1)), 0, 0, Math.PI * 2);
    g.fillStyle = fill;
    g.fill();
    if (crest) {
      g.beginPath();
      g.ellipse(0, -slab.h * 0.18, slab.w * 0.34, Math.max(1, slab.h * 0.24), 0, Math.PI, Math.PI * 2);
      g.strokeStyle = crest;
      g.lineWidth = Math.max(0.6, slab.h * 0.16);
      g.stroke();
    }
    g.restore();
  }
}
