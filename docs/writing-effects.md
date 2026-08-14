# Writing your own effects

The **Code** panel compiles a real ES module. Export an object with a `params`
schema and a `draw(ctx)` function — the inspector builds the controls from the
schema, and every projector tab picks up the change without a reload.

```js
export default {
  name: 'Runner',
  category: 'custom',
  scope: 'shape',                     // or 'global' for the whole frame
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#ff7a18' },
    { key: 'speed', type: 'range', label: 'Speed', default: 1, min: 0, max: 8, step: 0.01 },
  ],
  init({ rng }) {
    return { offset: rng() };          // persists between frames
  },
  draw({ g, p, shape, t, state }) {
    const at = shape.sampler.at((t * p.speed * 0.1 + state.offset) % 1);
    g.fillStyle = p.color;
    g.beginPath();
    g.arc(at.x, at.y, shape.bbox.h * 0.05, 0, Math.PI * 2);
    g.fill();
  },
};
```

## What `draw` receives

| | |
| --- | --- |
| `g` | 2D context, already positioned in world pixels (a virtual 1920-wide frame). |
| `p` | Your parameters, with modulation already applied. |
| `shape` | `{ id, name, tags, closed, points, path, bbox, centroid, sampler }` |
| `t`, `dt` | Show time and frame delta in seconds. Both stop when the transport is paused. |
| `beat`, `beatPhase`, `bpm` | Musical time from the transport tempo. |
| `audio` | `{ level, low, mid, high }` from the microphone. |
| `i`, `n` | This target's index, and how many targets the layer has. |
| `state` | Yours, between frames. |
| `rng`, `noise` | Seeded generators — identical in every tab. |
| `media(id)` | A decoded video or image element from the library, or null. |
| `world` | `{ w, h }` of the virtual frame. |
| `shapes(tag, excludeId)` | Every other shape in the project, for collisions. Filter by tag, and pass `shape.id` so you don't collide with yourself. |
| `fx` | The helper namespace, below. |

Parameter types: `range`, `number`, `color`, `bool`, `select` (with `options`),
`text`, `media`.

## The `fx` namespace

Everything here is also reachable through the draw context; `fx` is a
convenience. Source: [`js/effects/lib.js`](../js/effects/lib.js).

**Maths and colour** — `clamp`, `lerp`, `smoothstep`, `frac`, `TAU`, `hexToRgb`,
`rgba`, `mixHex`, `makeRng`, `hashString`, `boundingBox`, `polygonCentroid`,
`pointInPolygon`, `buildPathSampler`, `smoothPolyline`, `createNoise`.

**Physical colour** — `blackbody`, `blackbodyCss`, `blackbodyBytes`, `mixLinear`,
`rampAt`, `luminance`, `srgbToLinear`, `linearToSrgb`. Reach for
`blackbodyCss(kelvin)` whenever something is hot.

**Density fields** — `createField`, `ensureField`, `curlNoise`. For anything
volumetric.

**Landing on things** — `buildHeightfield`, `ensureSurfaces`, `ensureDrift`,
`columnAt`, `sweepLanding`, `settle`, `shedSlabs`, `advanceSlabs`, `drawDrift`,
`drawSlabs`. For anything that falls and should stop when it meets the house.

**Getting round things** — `collectObstacles`, `surfaceNormal`, `deflect`,
`isClear`, `findFreeSpot`, `nearestSurface`. For anything that travels across
the facade and should treat the windows as solid.

**Drawing** — `tracePoints`, `glow`, `verticalGradient`, `withClip`,
`offscreen`.

## Three rules

> **Never use `Math.random()`.** Each projector tab runs its own copy of your
> code, and unseeded randomness makes overlapping projectors disagree. Use
> `rng()`, or `makeRng('some-stable-key')` when you need a structure to be
> identical no matter when each tab first rendered it.

> **Never set `ctx.filter` or `ctx.shadowBlur` per particle or per glyph.** Each
> one is rendered into its own layer and composited back. Bake a small ladder of
> pre-softened sprites with `fx.offscreen` and stamp them with `drawImage`
> instead, or approximate the halo with widening strokes. Both are two orders of
> magnitude faster. See [performance](performance.md).

> **Never allocate per frame.** Put buffers, sprite ladders and accumulation
> canvases in `state` and reuse them; `fx.ensureField` and `fx.ensureSurfaces`
> exist to make that the easy path.

## Accumulating rather than redrawing

If your effect only ever *adds* — growth, trails, accretion — draw into a canvas
from `fx.offscreen` once and blit it every frame thereafter. Redrawing the whole
history each frame turns a pleasing effect into a slideshow by about the
thirty-second mark.

`fx.offscreen` returns a detached `<canvas>` element and not an
`OffscreenCanvas`, deliberately: on the main thread an OffscreenCanvas source
makes `drawImage` around thirty times slower. See
[performance](performance.md#the-two-traps).

## Debugging

An effect that throws is caught, reported once as a toast, and skipped —
the show carries on. The message names the effect and the error. Compile errors
appear under the editor with real line numbers, because the module is compiled
through a `blob:` URL and imported, so you get proper ES module semantics rather
than `new Function`.
