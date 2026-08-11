# Facade Mapper

Projection mapping for your house, in a browser tab. No install, no server, no
account. Point a camera at the front of the house, let each projector find
itself, trace the windows and door, and put light on them.

Built for Halloween and Christmas, but there is nothing seasonal in the engine —
it maps shapes to projectors and runs programmable effects on them.

**[Open it →](https://paperclipmonkey.github.io/facade-mapper/)**

---

## What it does

- **Several projectors, one browser.** Each projector is its own tab, dragged to
  its own display. One control tab drives them all.
- **Camera auto-alignment.** Each projector flashes a grid of dots; the camera
  watches where they land and solves the projector-to-camera mapping. You then
  draw on the camera picture and it appears on the right part of the house.
- **Draw over the real view.** Trace windows, the door, the roofline and the
  gutter directly on the camera image.
- **Effects.** Around forty built in — blood drips, lightning, fire, candlelit
  windows, figures moving behind glass, fog, snow, Santa, icicles, fairy lights.
- **Paths, not just areas.** Any traced line carries an evenly-spaced path, so
  chases, light strings, comets and text can travel round a window frame or
  along a roofline at constant speed.
- **Text**, placed in a shape or wrapped along its path, with typewriter, wave,
  flicker and other animations.
- **Video and images** mapped onto shapes, kept on your machine.
- **Programmable.** Any numeric parameter can be driven by an LFO, the beat, the
  microphone, or a JavaScript expression. And you can write whole effects in the
  app; they go live in every projector tab without a reload.
- **It remembers.** Everything is stored in the browser. Come back the next
  night, reopen the tabs, and the mapping is still there.

## Quick start

1. **Open the [control page](https://paperclipmonkey.github.io/facade-mapper/)**
   on the machine driving the projectors.
2. **Setup → Start camera.** Point it at the house from roughly where people will
   stand. Put it on a tripod: everything you draw is in camera coordinates, so if
   the camera moves afterwards, the mapping moves with it.
3. **Open projector tab** for each projector. Drag each to its display and press
   <kbd>F</kbd>.
4. **Projectors → select one → Align with camera.** It shows nine dots one at a
   time and finds them. Do this after dark. Repeat for each projector.
5. **Trace the house.** The **Area** tool for windows and doors, the **Path**
   tool for rooflines and gutters. Tag each shape (`window`, `door`, `roof`…) so
   effects can target groups rather than individual shapes.
6. **Effects → Halloween starter** (or Christmas). That builds a complete look
   out of what you have tagged. Then take it apart and make it yours.
7. **Export** once the alignment is right. That JSON file is your backup.

## How the alignment works

A projector aimed at a wall and a camera looking at that same wall are two views
of one flat surface. Any two views of a plane are related by a single 3×3
projective matrix — a homography. The nine dots give nine known
"projector pixel ↔ camera pixel" pairs, which is more than enough to solve for
it. After that, any point you draw on the camera picture can be converted into
the projector pixel that hits it.

The app reports the solve quality in pixels of a nominal 1920-wide output. Under
about 5 px is good. It also throws away a single bad detection — a reflection, a
passing car — and re-solves if that clearly helps.

**The important caveat: it assumes a flat surface.** A flat front elevation is
fine. A bay window, a porch roof or a deep reveal sticks out of that plane and
will land slightly off. Two ways round it: the per-projector **Surface warp**
grid, which lets you drag control points until it sits right, or give the
protruding part its own projector.

If the camera can't manage it — too bright, too far, a phone that insists on
auto-exposing — put a test grid up and drag the four corners by hand with the
**Corners** tool. Same maths, worse input.

### Getting a good solve

- Do it after dark. The dots have to out-shine everything else in frame.
- Get the whole projected area inside the camera view before you start.
- Don't move the camera afterwards.
- The app tries to pin exposure and white balance, but browser support is patchy.
  If your camera app can lock them, do that first.

## Several projectors

Every tab shares one project through the browser, so the control tab is the only
place you edit. Shapes are stored in camera coordinates, so a window covered by
two projectors is drawn correctly by both — each converts world coordinates
through its own homography.

Where two projectors overlap, use **Edge blending** on both to fade the
overlapping edges into each other. Set the same width on the facing edges of
each and adjust gamma until the seam disappears.

Effects use seeded random number generators rather than `Math.random()`,
specifically so two projectors covering the same wall produce the identical
flame, the identical snowflake, and the identical lightning bolt.

## Paths and animation

Any shape — closed area or open line — carries an arc-length path. Chase, Fairy
Lights, Comet, Trace and Sparks all walk it, which is why a chase takes as long
crossing a short edge as a long one. Text can follow it too: set Placement to
`path` and the lettering wraps round an arch or along a roofline.

**Stagger** on a layer offsets each targeted shape a little further back in time.
Point one Pulse layer at the `window` tag, add half a second of stagger, and the
windows light in sequence rather than together.

## Modulating parameters

The `+` beside any numeric parameter binds it to something that moves:

| Type | What it does |
| --- | --- |
| **LFO** | Sine, triangle, square and friends. Lock to the beat or set a rate in Hz. *Spread per shape* phases each target apart. |
| **Audio** | Follows the microphone — overall level, or bass/mid/treble separately. |
| **Random** | Sample-and-hold with optional smoothing. Good for flicker and unease. |
| **Envelope** | Snaps to a value on each beat and decays. Good for hits. |
| **Expression** | Any JavaScript expression. |

Expressions get `t`, `beat`, `i` (which target), `n` (how many), `base` (the
slider value), `level low mid high` from audio, `shape`, and the usual maths plus
`noise`, `fbm`, `clamp`, `lerp`, `smoothstep`, `saw`, `tri`, `square`, `rand` and
`TAU`:

```js
base + 0.4 * sin(t * TAU * 0.5 + i)      // each target a little out of phase
clamp(low * 2, 0, 1)                     // follow the bass
base * (0.6 + 0.4 * noise(t * 0.5, i))   // wander
```

## Writing your own effects

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

What `draw` receives:

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
| `fx` | Helpers: `fx.rgba`, `fx.glow`, `fx.mixHex`, `fx.TAU`… |

Parameter types: `range`, `number`, `color`, `bool`, `select` (with `options`),
`text`, `media`.

> **Never use `Math.random()` in an effect.** Each projector tab runs its own
> copy of your code, and unseeded randomness makes overlapping projectors
> disagree. Use `rng()`.

## Keyboard

| | |
| --- | --- |
| <kbd>V</kbd> <kbd>P</kbd> <kbd>L</kbd> <kbd>R</kbd> <kbd>C</kbd> | Select, Area, Path, Rectangle, Corners |
| <kbd>Enter</kbd> / <kbd>Esc</kbd> | Finish / cancel the shape being drawn |
| <kbd>Backspace</kbd> | Remove last point while drawing; delete the selection otherwise |
| <kbd>Alt</kbd>-click | On an edge adds a point, on a point removes it |
| <kbd>Shift</kbd>-drag | Line a point up with its neighbour |
| <kbd>Space</kbd> | Play / pause |
| <kbd>B</kbd> | Blackout |
| <kbd>1</kbd>–<kbd>9</kbd> | Jump to a scene |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> | Undo (<kbd>Shift</kbd> to redo) |

In a projector tab: <kbd>F</kbd> fullscreen, <kbd>I</kbd> status, <kbd>T</kbd>
cycle test patterns.

## Where things are stored

| | |
| --- | --- |
| Shapes, alignment, effects, scenes | `localStorage` — small, and the thing worth keeping |
| Video, images, the traced camera still | IndexedDB — too big for `localStorage`, and shared across tabs so projector tabs can read the same files |

Nothing is uploaded anywhere. Clearing site data deletes it all, so **Export**
once your alignment is right.

## Requirements

A Chromium-based browser or Firefox, on the machine driving the projectors.
Needs `BroadcastChannel`, `getUserMedia` and WebGL. Camera access requires a
secure context, which GitHub Pages provides.

Performance depends on your GPU. Each projector tab uploads one frame-sized
texture per frame and warps it, which is cheap on real hardware. If a tab
struggles, drop **Render detail** in that projector's inspector — it trades
sharpness for frame rate. The projector status panel (<kbd>I</kbd>) shows the
live frame rate and buffer size.

## Running locally

It is plain ES modules with no build step, but module imports need a real HTTP
server — opening `index.html` from disk will not work.

```bash
git clone https://github.com/paperclipmonkey/facade-mapper.git
cd facade-mapper
python3 -m http.server 8000
# then open http://localhost:8000
```

## Tests

The geometry that matters — the homography solve, the marker detection feeding
it, and the region and mesh maths — is covered by dependency-free tests,
including an end-to-end calibration run against a simulated projector and
camera:

```bash
node test/geometry.test.mjs
```

## Layout

```
index.html          control tab
projector.html      output tab, one per projector
js/core/            project model, storage, cross-tab bus, maths, clock, modulation
js/effects/         effect registry and the built-in library
js/render/          world renderer (2D) and the projective warp (WebGL)
js/control/         camera, calibration, stage editing, panels, inspector
js/projector/       the output tab
test/               geometry and calibration tests (plain Node, no dependencies)
```

The two interesting files are `js/render/warp.js`, which explains how the
perspective-correct warp works, and `js/control/calibration.js`, which explains
the structured-light alignment.

## Licence

MIT. See [LICENSE](LICENSE).
