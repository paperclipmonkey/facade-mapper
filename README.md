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
- **Effects.** Around fifty built in — blood drips, lightning, fire, candlelit
  windows, figures moving behind glass, bats, rain, searchlights, fog, snow,
  Santa, icicles, fairy lights, fireworks.
- **A proper look.** Bloom, filmic highlight roll-off and colour grading are
  applied after everything, by every projector identically, and the whole chain
  runs in linear light. This is the difference between light that appears to
  fall on brickwork and shapes that look stuck to it.
- **Effects that model light, not paint.** Anything hot — fire, embers, sparks,
  candles, lightning, firework stars — takes its colour from a temperature on
  the blackbody curve, so it reddens correctly as it cools. Anything
  volumetric — fire, smoke, fog — is a density field rather than a pile of
  additive circles. See [How the effects are built](#how-the-effects-are-built).
- **It reacts.** Point a motion trigger at the path and the house does something
  when somebody walks up it — jump to a scene, play a sound, then go back to
  what it was doing.
- **It runs itself.** A nightly schedule turns the show on at dusk and off at
  bedtime, every night, without you going near the laptop.
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

The **Start here** panel is a live checklist of everything below. It reads the
actual state — whether the camera is running, which projector tabs have checked
in, what is aligned — ticks off what is done, expands the step you are on, and
carries the button that does it. If you only read one thing, read that panel
instead of this list.

1. **Open the [control page](https://paperclipmonkey.github.io/facade-mapper/)**
   on the machine driving the projectors.
2. **Setup → Start camera.** Point it at the house from roughly where people will
   stand. Put it on a tripod: everything you draw is in camera coordinates, so if
   the camera moves afterwards, the mapping moves with it.
3. **Open projector tab** for each projector. Drag each to its display and press
   <kbd>F</kbd>.
4. **Projectors → select one → Align with camera.** It shows nine dots one at a
   time and finds them. Do this after dark. Repeat for each projector.

   If the surface is not flat — a corner where two or three faces meet, a bay,
   a porch that stands proud of the wall — set **Wall shape** to a denser grid
   first. A homography is exactly the right model for a flat elevation and
   exactly the wrong one for a corner: line one face up and the others go out,
   and no amount of re-aligning fixes it, because the problem is the model
   rather than the fit. A denser pass measures how far the wall departs from a
   plane and bends the output to match.
5. **Trace the house.** The **Area** tool for windows and doors, the **Path**
   tool for rooflines and gutters. Tag each shape (`window`, `door`, `roof`…) so
   effects can target groups rather than individual shapes.
6. **Effects → Halloween starter** (or Christmas). That builds a complete look
   out of what you have tagged, grading included. Then take it apart and make it
   yours.
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

### When the wall is not flat

A homography describes a plane, so a flat front elevation is exactly right and a
corner is exactly wrong. Where two or three faces meet, no single plane fits: you
can line one face up and the others go out, and re-running the alignment does not
help, because the problem is the model rather than the fit.

**Wall shape**, on the projector, is the answer. Set it to a denser grid and the
alignment runs 25 or 49 dots instead of 9. The extra dots are not there to fit a
better plane — they measure how far the wall departs from one. The homography
still does the global mapping; the leftover error at each dot is exactly the
surface bending away, and that goes into the warp mesh as a correction.

On a genuinely flat wall the residuals come out at nothing and the mesh stays
flat, so there is no cost to using a denser grid other than the time it takes to
step through the dots. Anything left over after that can still be nudged by hand
with the **Surface warp** grid.

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

## The look

Everything an effect draws goes through one post-processing stage before it
reaches the wall, in the **Look** panel:

- **Bloom** — bright areas spill light into their surroundings, using a mip
  chain so the halo is wide and smooth rather than a tight ring. Real light
  spills; without this, every projected edge reads as a cutout.
- **Filmic roll-off** — stacked layers and lightning routinely push past white.
  Clipping turns those into flat blobs; a filmic curve keeps their shape and
  colour.
- **Exposure, contrast, saturation, temperature, gamma** — applied globally, so
  you can push a whole show warm and moody without touching forty sliders.

Six starting looks are provided (Neutral, Haunted, Ember, Frost, Saturated,
Flat). **Flat** switches the whole stage off, which is what you want while
checking alignment.

Contrast and gamma matter more here than in most rendering, because a projector
cannot emit darkness: whatever grey it puts in the "black" parts of the frame
lands on your brickwork and greys the whole wall. Crushing the low end is how
you get the surrounding wall to disappear.

Per layer there is also a **Softness** control, which blurs that layer alone —
useful when a hard-edged fill looks like a sticker rather than like light.

## Triggers

A trigger jumps to a scene, optionally plays a sound, holds it for a few
seconds, then puts back whatever was playing. That last part is what makes it a
scare rather than a scene change: the ambient loop resumes on its own and the
next group gets the same surprise.

| Source | Fires when |
| --- | --- |
| **Motion** | Something moves in a region of the camera view. |
| **Key** | You press a key. |
| **Timer** | On an interval, with randomness so it doesn't become predictable. |
| **Manual** | Only when you press the button. |

### Getting motion triggers right

The camera is pointed at a building you are actively projecting onto, so the
fastest-moving thing in frame is your own show. Three things stop that firing
the trigger constantly, and one of them is your choice:

1. **Watch ground your projectors don't light** — the path, the drive, the gate.
   Aimed at the house itself it will fire on your own effects.
2. The background model adapts continuously, so anything that changes slowly or
   repeats becomes "normal" within a few seconds. A parked car stops registering.
3. A change covering nearly the whole region is treated as a light switching on,
   not a person, and re-baselines instead of firing.

The Triggers panel shows a live reading of how much of the region is moving and
the level it has to beat, which is the only sane way to aim one.

**Sounds** are imported into the media library like anything else, and play from
the control tab only — projector tabs usually drive displays with no speakers,
and four copies a few milliseconds apart sounds like a flanger, not a thunderclap.

## Running it every night

**Setup → Nightly schedule** gives on/off times and which days. It drives the
same blackout the <kbd>B</kbd> key does, so a scheduled "off" leaves the
projectors awake and aligned — they simply stop emitting. Windows that end
before they start run past midnight, and the day filter applies to the day the
window opened, so a Friday 20:00–01:00 slot is still running at half past
midnight on Saturday.

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

## How the effects are built

Three ideas do most of the work of making the built-in effects read as light
falling on a wall rather than as graphics stuck to it. They are all available to
effects you write yourself.

**Linear light.** sRGB values are gamma-encoded, so adding or blending them
directly is not the same as adding light. The post chain decodes to linear
before bloom and tonemapping and re-encodes at the end, and `fx.mixLinear` does
the same for a two-colour blend. The difference shows up most in gradients: a
yellow-to-red flame lerped in sRGB travels through a muddy brown middle, and in
linear it does not. Soft-edge blending between overlapping projectors is done in
linear for the same reason — that is the only way two feathered edges sum to the
brightness of one unfeathered one.

**Colour from temperature.** Fire, embers, sparks, candle flames, lightning
channels and firework stars are thermal emitters, so their colour is a function
of how hot they are, not an arbitrary hex. `fx.blackbodyCss(kelvin)` returns the
colour of a blackbody at that temperature. Driving an effect from a temperature
and letting it cool is what makes a dying ember go deep red instead of merely
dim — which is the thing your eye actually reads as "that is burning". Useful
landmarks: 1000 K dull red embers, 1500 K orange flame, 1850 K candle, 2400 K
bright yellow flame, 3000 K tungsten, 9000 K and up the blue-white of a
lightning channel.

**Volumes as fields.** Fire, smoke and fog are volumes of stuff, and drawing
them as a few hundred additive circles reads as a bag of marbles no matter how
they are tuned. Instead they evaluate a density on a coarse grid — around a
hundred cells across — and let the browser's bilinear upscale turn it into a
continuous volume. `fx.ensureField` allocates and caches one; `fx.curlNoise`
gives a divergence-free velocity to advect it with, which is what makes smoke
curl and billow instead of drifting. It also happens to be several times faster
than the particle version it replaced.

**Things land on the house.** Snow does not fall past your windows, it settles on
them. Every shape you have traced presents a top surface; falling flakes test
against those surfaces, pile up where they land, slump to a natural angle, and
when a ledge gets too loaded the excess breaks away as slabs that slide down the
wall and fade out at the bottom. Turn it off with **Settle on shapes**, aim it at
one group of shapes with **Settle on tag**, and control how fast it gathers and
how deep it gets before it lets go. `fx.ensureSurfaces` and friends are available
to your own effects — `js/effects/collide.js` explains the model.

One thing worth knowing about the surfaces: they are built *per shape*, not as
one combined heightfield. That matters on a facade, where a traced roofline spans
the whole width — with one shared surface every window under it would sit in the
roof's shadow and never collect a flake. Snow on a flat elevation gathers on
every ledge it can reach, so each shape collects independently.

There is a fourth, less principled rule that matters just as much: **never set
`ctx.filter` per particle**. Each filtered draw is rendered into its own layer
and composited back, so a few hundred of them will cost tens of milliseconds a
frame on their own. Bake a small ladder of pre-softened sprites once and stamp
them with `drawImage` instead — the snow effect does this for its depth of
field, and it is about thirty times faster than the filter it replaced.

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
| `shapes(tag, excludeId)` | Every other shape in the project, for collisions. Filter by tag, and pass `shape.id` so you don't collide with yourself. |
| `fx` | Helpers: `fx.rgba`, `fx.glow`, `fx.mixHex`, `fx.TAU`, plus the physical set — `fx.blackbodyCss`, `fx.mixLinear`, `fx.rampAt`, `fx.ensureField`, `fx.curlNoise`. |

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
| Shapes, alignment, effects, scenes, triggers, schedule | `localStorage` — small, and the thing worth keeping |
| Video, images, sounds, the traced camera still | IndexedDB — too big for `localStorage`, and shared across tabs so projector tabs can read the same files |

Nothing is uploaded anywhere. Clearing site data deletes it all, so **Export**
once your alignment is right.

## Requirements

A Chromium-based browser or Firefox, on the machine driving the projectors.
Needs `BroadcastChannel`, `getUserMedia` and WebGL. Camera access requires a
secure context, which GitHub Pages provides.

Performance depends on your GPU. Each projector tab uploads one frame-sized
texture per frame, builds a small bloom chain from it and warps the result,
which is cheap on real hardware. If a tab struggles, drop **Render detail** in
that projector's inspector, or turn bloom down in **Look** — both trade
sharpness for frame rate. The projector status panel (<kbd>I</kbd>) shows the
live frame rate and buffer size. If the driver refuses the bloom render targets,
bloom is skipped and everything else carries on.

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
node test/geometry.test.mjs   # homography, marker detection, region and mesh maths
node test/runtime.test.mjs    # motion detection, trigger gating, scheduling, grading
```

The motion tests are worth a look if you plan to rely on triggers: they cover a
person walking into frame, a parked car fading into the background, and a porch
light coming on, which are the three cases that decide whether the feature is
usable in a real garden.

## Layout

```
index.html          control tab
projector.html      output tab, one per projector
js/core/            project model, storage, cross-tab bus, maths, clock, modulation
js/effects/         effect registry and the built-in library
js/render/          world renderer (2D), projective warp and post-processing (WebGL)
js/control/         camera, calibration, motion, sound, triggers, schedule, UI
js/projector/       the output tab
test/               plain Node tests, no dependencies
```

The interesting files are `js/render/warp.js`, which explains how the
perspective-correct warp works, `js/render/postfx.js` for the bloom and grading,
`js/control/calibration.js` for the structured-light alignment, and
`js/control/motion.js` for how the house decides somebody is there.

## Licence

MIT. See [LICENSE](LICENSE).
