# How it fits together

No build step. Plain ES modules, served exactly as they sit in the repository.

```
index.html          control tab
projector.html      output tab, one per projector
remote.html         phone or second-laptop remote
draw.html           tablet drawing surface
server.mjs          optional: static files + the cross-device link
js/core/            project model, storage, cross-tab bus, maths, clock, modulation
js/effects/         effect registry and the built-in library
js/render/          world renderer (2D), projective warp and post-processing (WebGL)
js/control/         camera, calibration, motion, sound, triggers, UI
js/projector/       the output tab
js/remote/          the remote
js/draw/            the drawing surface
docs/               this
test/               plain Node tests, no dependencies, plus a browser benchmark
```

## One project object

Everything a show is — shapes, projectors, layers, scenes, triggers, schedule,
settings, the source of any custom effects — lives in a single serialisable
object, defined in [`js/core/state.js`](../js/core/state.js).

The control tab is the only place it is edited. A mutation is followed by
`commit()`, which does three things: saves to `localStorage`, broadcasts the
whole object to the projector tabs, and re-renders the panels. There is a
`commitLive()` for the middle of a drag, which skips rebuilding the lists so the
UI does not fight the pointer.

Broadcasts are rate-limited to about twelve a second. Dragging a slider produces
hundreds of changes a second and each broadcast is a structured clone of the
whole project; twelve is imperceptible on the wall and leaves the main thread
free to render.

A projector tab is therefore stateless apart from "which projector am I?" — it
receives the project, finds its own entry, and renders. That is what makes tabs
cheap to open, close and reopen mid-show.

## Coordinate spaces

Three, and most confusion about this codebase is confusion between them.

| Space | Range | What lives in it |
| --- | --- | --- |
| **World** | 0..1 across the camera frame | Everything stored: shape points, projector quads, trigger regions |
| **World pixels** | a virtual 1920-wide frame | What effects draw in, so a line width of 6 means the same thing everywhere |
| **Projector** | 0..1 across one projector's output | What the homography produces |

Storing geometry normalised rather than in pixels is what lets a project survive
a change of camera resolution: swap a webcam for a better one and the shapes
stay where they were.

`worldSize(project)` turns the stored camera aspect into the virtual pixel frame.
A projector's homography `H` maps world 0..1 to projector 0..1; its inverse
gives the region of world space worth rendering for that projector, which is why
a projector covering the front door does not pay to render the roof.

## The render path

Both the control tab's preview and every projector tab call the same
`createWorldRenderer().render()`. That is the point: what you see while editing
is produced by exactly the code that drives the projectors. The only difference
is the region of world space being asked for.

1. **World render (2D).** Layers in order; for each, resolve its targets and
   call the effect once per target. Opacity, blend and softness are *layer*
   properties, so a layer that uses any of them is drawn into a scratch buffer
   and blitted once — Canvas has no group opacity, and setting `globalAlpha`
   before `draw()` only works for effects that multiply into it rather than
   assign, which most do not.
2. **Warp (WebGL).** The world canvas is uploaded and drawn through the
   projector's homography. Each vertex's clip-space `w` is set to the
   homography's own denominator, so GL's perspective divide makes the texture
   coordinates exact rather than approximate — which means subdividing the mesh
   costs nothing in accuracy and buys the optional per-point warp for walls that
   are not flat.
3. **Bloom and grade.** A bright pass, a five-level blur chain, then accumulate
   back up, all in linear light, applied in the same pass as the warp.
4. **Edge blend.** A per-edge ramp in real output pixels, in linear light, so
   two overlapping projectors sum back to the brightness of one.

## Cross-tab

A `BroadcastChannel` carries four message types: the project, the transport
clock, media-store invalidation, and commands to a specific projector (identify,
test pattern). Presence is a roll-call: the control tab asks, tabs answer with
their projector id, screen origin and fullscreen state — which is how the
checklist can tell you that two tabs are sharing a display.

Projector tabs derive show time from the wall clock plus the broadcast transport
state, rather than counting their own frames, so a tab that drops frames or is
reopened mid-show stays in step with the others.

## Off this machine

`BroadcastChannel` is same-origin *and* same-browser, so a phone or a second
computer needs a wire. [`server.mjs`](../server.mjs) is a static file server with
a hand-written WebSocket relay on it, and [`js/core/link.js`](../js/core/link.js)
is a *transport* rather than a second bus: it mirrors what a tab posts onto the
socket and feeds what arrives back in through `bus.receive`. No handler anywhere
knows which side of the wire a message came from.

Three details carry the design:

- **It asks first.** A tab probes `/link/info` once. On GitHub Pages nothing
  answers and it stays quiet, rather than retrying a socket all evening.
- **Subscriptions.** Each connection says which message types it wants. A
  remote asks for `SHOW` and `CLOCK`, so the whole-project broadcast — which
  goes out a dozen times a second while a slider moves — never reaches a phone.
  Messages are also not sent back to the device they came from, which already
  had them over BroadcastChannel.
- **One clock.** Two machines disagree about the time by however long it has
  been since either checked, and show time is a subtraction from a shared wall
  clock. Every device measures its offset from the server the way NTP does and
  routes every cross-tab stamp through [`js/core/time.js`](../js/core/time.js).
  Unlinked, the offset is zero and nothing about the single-machine case
  changes. See [more than one device](multi-device.md).

The remote holds no project. The control tab publishes a small digest of what
the show is doing and accepts a fixed list of verbs back, each delegating to the
function its own button calls — so the control tab remains the only place the
project is edited, and there is nothing to reconcile.

Drawing from a tablet goes the same way and for the same reason. What travels is
a stroke beginning, a handful of points and a stroke ending; every tab applies
them through [`js/core/drawing.js`](../js/core/drawing.js) and arrives at the
same picture, and the ink never enters the project — the project is broadcast
whole and saved on every change, which is the wrong path for a pencil. A tab
that opens later asks for the drawing and is sent all of it at once.

## Determinism

Effects are seeded per (layer, shape) pairing rather than globally, so the same
window shows the same flame in every tab and across reloads, and two projectors
covering one wall agree about it. `Math.random()` in an effect breaks this;
`rng()` and `makeRng(key)` do not.

## Storage

`localStorage` holds the project — small, and the part worth keeping. IndexedDB
holds media and the traced camera still, because they are too big for
`localStorage` and because it is shared across tabs, so projector tabs read the
same files without them being sent over the bus.

Nothing leaves the machine, and nothing leaves the network: with the link
running, the project crosses to whatever devices you joined to it, over your own
wifi, and no further. Media stays put even then — it is in IndexedDB on the
machine it was imported to.

## Tests

Dependency-free Node tests over the parts where a sign error still produces
plausible-looking output:

```bash
node test/geometry.test.mjs    # homography, marker detection, region and mesh maths
node test/runtime.test.mjs     # motion detection, trigger gating, scheduling, grading
node test/collide.test.mjs     # heightfields, landing, slumping, shedding
node test/obstacles.test.mjs   # facade collision, automatic edge blending
node test/figures.test.mjs     # the drawn figures
node test/link.test.mjs        # clock offset, WebSocket framing, the relay
node test/drawing.test.mjs     # live drawing: strokes, undo, late joiners
```

`geometry.test.mjs` includes an end-to-end calibration against a simulated
projector and camera. The motion tests are worth reading if you plan to rely on
triggers: they cover a person walking into frame, a parked car fading into the
background, and a porch light coming on, which are the three cases that decide
whether the feature is usable in a real garden.

[`test/bench.html`](../test/bench.html) is the effect benchmark — see
[performance](performance.md).

## The interesting files

| | |
| --- | --- |
| [`js/render/warp.js`](../js/render/warp.js) | The perspective-correct warp, and automatic edge blending |
| [`js/render/postfx.js`](../js/render/postfx.js) | Bloom and grading |
| [`js/control/calibration.js`](../js/control/calibration.js) | Structured-light alignment, and the non-planar correction |
| [`js/control/motion.js`](../js/control/motion.js) | How the house decides somebody is there |
| [`js/effects/collide.js`](../js/effects/collide.js) | What falling things land on |
| [`js/effects/obstacles.js`](../js/effects/obstacles.js) | What travelling things get in the way of |
| [`js/control/demoHouse.js`](../js/control/demoHouse.js) | The demo facade, drawn in code |
