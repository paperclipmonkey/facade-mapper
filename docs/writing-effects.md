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
| `stable` | Your parameters **without** modulation. Build cache keys from this. |
| `rng`, `noise` | Seeded generators — identical in every tab. |
| `media(id)` | A decoded video or image element from the library, or null. |
| `world` | `{ w, h }` of the virtual frame. |
| `shapes(tag, excludeId)` | Every other shape in the project, for collisions. Filter by tag, and pass `shape.id` so you don't collide with yourself. |
| `depth` | The building's real surface, from an imported depth scan, or `null`. See below. |
| `fx` | The helper namespace, below. |

Parameter types: `range`, `number`, `color`, `bool`, `select` (with `options`),
`text`, `media`.


## The building's real surface

`ctx.depth` is `null` unless the show has a depth scan imported and placed
(Setup → Depth scan). When it is there, it answers questions about the actual
front of the house rather than about the outlines somebody traced on it.

| | |
|---|---|
| `sees(x, y)` | Did the scan cover this world pixel at all? |
| `reliefAt(x, y)` | How far the surface stands out of the wall, in metres. Negative is set back — window glass, a doorway. `NaN` where the scan saw nothing. |
| `normalAt(x, y, out)` | Unit surface normal, `x` right, `y` **down**, `z` out of the wall. Written into `out` so a per-pixel loop allocates nothing. |
| `wallAt(x, y, out)` | Where this pixel is on the building, in metres from the top-left corner of the scan, with the relief as `z`. |
| `shadow(x, y, z, lx, ly, lz)` | 0 lit, 1 shadowed. Wall metres throughout — feed it `wallAt` and a lamp position. |
| `extent` | `{ width, height }` of the scan, in metres. |

Two conventions are worth stating plainly, because getting either wrong produces
something that looks almost right:

- **World pixels in, metres out.** You ask in the coordinates you are drawing
  in; everything the answer contains is metric, and belongs to the wall rather
  than to the camera. That separation is deliberate — world space is only square
  on the building once the wall has been squared up, and lighting has to be
  correct either way.
- **`y` runs down**, in the normals and in the wall coordinates, like every
  other `y` in the app. A lamp *above* a sill has the *smaller* `y`.

The whole of `relight` in `js/effects/builtin/facade.js` is one `N·L` term
against those normals plus a `shadow()` call, and that is genuinely all it is —
if you want a lantern that swings, bind its `x` to an LFO and the modulation
system does the rest.

```js
const wall = [0, 0, 0];
const n = [0, 0, 1];
depth.wallAt(x, y, wall);
depth.normalAt(x, y, n);

const dx = lampX - wall[0];
const dy = lampY - wall[1];
const dz = lampZ - wall[2];
const dist = Math.hypot(dx, dy, dz);
const facing = (n[0] * dx + n[1] * dy + n[2] * dz) / dist;
const light = Math.max(0, facing) * (1 - depth.shadow(...wall, lampX, lampY, lampZ));
```

If your effect cannot do anything useful without a scan, declare `needs: 'depth'`
on the effect object. The layer list will then say so instead of leaving somebody
to work out why nothing is on the wall.
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

> **Never build a cache key from `p`.** Use `stable`. Any parameter can be bound
> to an LFO or the microphone, and a bound parameter is a different number every
> frame by definition — so a key built from `p.thickness` misses on every frame
> the moment somebody modulates it, and your carefully cached structure is
> rebuilt sixty times a second. `stable` holds the same values before
> modulation: identical every frame until a slider actually moves.

## Simulating at a fixed rate

`draw` is called once per rendered frame, at whatever rate the tab manages. That
is fine for anything that is a function of `t` — but not for anything that
*remembers*, because two tabs drawing at different rates then take different
numbers of steps and drift apart on the wall.

So an effect that carries a simulation splits it in two: a `step(ctx)` that
changes `state` and never touches the canvas, and a `draw(ctx)` that paints
`state` and never changes it.

```js
  step({ p, dt, rng, state }) { /* dt is always 1/60. No `g` here. */ },
  draw({ g, p, state }) { /* paints what step decided. Writes nothing. */ },
```

The renderer calls `step` exactly `floor(age * 60)` times by show time `age`, in
every tab, with a constant `dt` and `rng` reseeded from the step index. The whole
simulation is therefore a function of the step number, which is what lets two
projectors agree about where a brick has fallen to.

Two consequences worth designing for:

- **`step` is replayed.** A projector tab opened three hours into the evening
  runs the three hours of steps it missed, spread over the next second or so of
  frames, and arrives exactly where the other tabs are. Keep a step cheap, and
  keep it free of anything that grows without bound.
- **Anything that writes to `state` belongs in `step`.** Including drawing into
  an accumulation canvas — that canvas *is* state. A `draw` that also grows the
  plant paints a different plant in every tab.

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

## Talking to another layer

`ctx.share` is a `Map` every effect can read and write. Effects are otherwise
completely independent, which is almost always right — but two of them drawing
the same brick wall have to agree about where the bricks are, and the only
alternative is asking somebody to keep two panels in step by hand.

Key it with your own effect id so it cannot become a general-purpose global by
accident, and publish the values you actually drew with rather than the ones you
were given — `stable` rather than `p`, if a modulator can move them:

```js
share.set(`brickwork:${shape.id}`, { w, h, gap });   // publisher
const laid = share.get(`brickwork:${shape.id}`);     // reader
```

It is not cleared between frames. A publisher normally draws first because it
sits lower in the stack, but nothing enforces that, and a reader that finds the
previous frame's values is right about everything that matters.
