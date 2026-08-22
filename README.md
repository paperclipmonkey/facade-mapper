<p align="center">
  <img src="docs/assets/logo.svg" alt="Facade Mapper" width="260" />
</p>

<h1 align="center">Facade Mapper</h1>

<p align="center">
  Projection mapping for your house, in a browser tab.<br />
  No install, no server, no account.
</p>

<p align="center">
  <a href="https://paperclipmonkey.github.io/facade-mapper/"><b>Open it →</b></a>
  &nbsp;·&nbsp;
  <a href="https://paperclipmonkey.github.io/facade-mapper/?demo"><b>Try the demo house →</b></a>
</p>

<p align="center">
  <img src="docs/assets/demo-house.jpg" alt="A house under snow: chasing lights along the roofline, icicles, frost creeping across the window glass, warm rooms behind it and a candy-cane doorway" width="820" />
</p>

Point a camera at the front of the house, let each projector find itself, trace
the windows and the door, and put light on them. Built for Halloween and
Christmas, but there is nothing seasonal in the engine — it maps shapes to
projectors and runs programmable effects on them.

**No projector to hand?** The
[demo house](https://paperclipmonkey.github.io/facade-mapper/?demo) is a whole
show — facade, traced windows, aligned projector, effects running — so you can
learn the app indoors in daylight and set the real one up knowing what each step
is for.

## What it does

- **Several projectors, one browser.** Each projector is its own tab, dragged to
  its own display. One control tab drives them all, and works out the soft-edge
  blending where they overlap. Every tab renders independently and they all show
  the *same* show: the simulation runs on a fixed clock rather than on the frame
  rate, so two projectors covering the same brickwork paint the same animation
  onto it rather than two.
- **Camera auto-alignment.** Each projector flashes a grid of dots; the camera
  watches where they land and solves the projector-to-camera mapping. You then
  draw on the camera picture and it appears on the right part of the house.
- **Or align by pointing**, when the camera can't manage it. Click a window
  corner on the camera view, then walk a projected crosshair onto that same
  corner of the real house and click. Four of those and the show snaps onto the
  building — no camera solve, and no need to see where the corners of the beam
  land.
- **Square up the wall.** The projector being off-axis is solved by alignment;
  the *camera* being off-axis is not, and it is the one you can see — generated
  texture like brickwork comes out regular from where the camera stands and fans
  out from everywhere else. Mark something you know is rectangular, say what
  shape it really is, and the app works in wall coordinates instead. Brick
  courses then have a constant size on the building, and a pair of offsets slides
  the lattice onto the real ones.
- **Draw over the real view** — a live camera, or a photograph of the house
  taken in daylight so you can trace indoors.
- **Over eighty effects.** Blood drips, lightning, fire, candlelit
  windows, figures behind glass, bats, rain, searchlights, fog, snow, Santa,
  icicles, window frost, fairy lights, fireworks, wallpaper, and a pot of
  flowers that wilts and blows its petals down the wall. **Browse…** on any
  layer renders all of them live, on a shape like the one you are pointing at,
  so you pick by eye.
- **Not just the two nights.** A cake with candles that burn down and go out
  when you blow at the house, balloons, bunting and confetti for a birthday; a
  meteor shower that radiates properly for the Perseids; a clock counting down
  to midnight on New Year's Eve; a pyre with a guy on it, catherine wheels and
  sparklers for the fifth of November; and neon, Japanese signage and a
  holographic advert for a house that would rather be in Blade Runner. Each one
  is a starter preset and a demo you can open right now — see
  [nights to point it at](#nights-to-point-it-at).
- **Or no night at all: put the house under water.** The surface across the top
  of the frame with shafts coming down through it, caustics on the brickwork,
  weed swaying up the front, a shoal that keeps off the windows, jellyfish going
  past the roof, bubbles off the wall and a pod of dolphins porpoising out
  through the surface above the chimneys. The colour is not a blue gel — water
  absorbs red about thirty times faster than blue, so the light is *taken apart*
  with depth the way it really is, and the bottom of the wall goes deep blue
  because there is no red left in what reaches it.
- **It can read the building.** Walk round the front with a scanning app and
  drop the `.glb` in. The app fits the wall's own plane, builds a metric relief
  map of it — how far every point stands in front of or behind that plane — and
  traces the windows, the door, the sills and the porch off it, in metres,
  tagged. A window is not a shape somebody drew; it is the part of the wall that
  is a hundred millimetres further away, which is still true in the dark, under
  ivy, and behind a hedge.
- **Light that lands on the real surface.** With a scan in, the **Relight**
  effect shades the actual geometry: a virtual lantern carried past the house
  lights each reveal from the side, and the porch throws its shadow across the
  path. No artwork and no hand-built model — the shape of the light is entirely
  the shape of the building. Bind the lamp's position to an LFO and somebody
  walks it past.
- **Effects that know the building is there.** Balls that ricochet off the
  windows, a snake that steers round the door, ivy that creeps *around* the
  frames instead of over them. Your eye accepts almost any amount of stylisation
  as long as the light behaves as though the house exists.
- **Effects that model light, not paint.** Anything hot takes its colour from a
  temperature on the blackbody curve, so it reddens correctly as it cools.
  Anything volumetric is a density field rather than a pile of additive circles.
  Anything that falls settles on the ledges it lands on.
- **A proper look.** Bloom, filmic highlight roll-off and colour grading applied
  after everything, by every projector identically, in linear light. This is the
  difference between light that appears to fall on brickwork and shapes that
  look stuck to it.
- **It reacts.** Point a motion trigger at the path and the house does something
  when somebody walks up it.
- **Run it from your pocket.** `node server.mjs` puts a phone or a second laptop
  on the same show — big scene buttons, blackout and triggers in your hand,
  where the show is actually seen. The same link lets a second computer drive
  projectors of its own, on a clock shared with the first, so two machines paint
  the same frame of the same animation rather than two.
- **It runs itself.** A nightly schedule turns the show on at dusk and off at
  bedtime, without you going near the laptop.
- **Programmable.** Any numeric parameter can be driven by an LFO, the beat, the
  microphone, or a JavaScript expression. And you can write whole effects in the
  app; they go live in every projector tab without a reload.
- **It remembers.** Everything is stored in the browser, and nothing is uploaded
  anywhere.

<p align="center">
  <img src="docs/assets/screenshot.png" alt="The control tab: effect list on the left, the camera view with traced shapes in the middle, inspector on the right" width="900" />
</p>

## Nights to point it at

Each of these is a starter preset — one click on a traced house — and a demo you
can open in a browser tab with no camera, no projector and no darkness. Every
picture below is the demo running: one frame of the real thing, rendered through
the same bloom and colour grade a projector tab uses, generated by
`node tools/screenshots.mjs`.

| | |
| --- | --- |
| [![Halloween](docs/assets/demos/halloween.jpg)](https://paperclipmonkey.github.io/facade-mapper/?demo=halloween) | [![Christmas](docs/assets/demos/christmas.jpg)](https://paperclipmonkey.github.io/facade-mapper/?demo=christmas) |
| **[Halloween →](https://paperclipmonkey.github.io/facade-mapper/?demo=halloween)** Candlelit windows with something looking out, blood down the door, rot creeping over the brickwork, ground fog and a storm overhead. | **[Christmas →](https://paperclipmonkey.github.io/facade-mapper/?demo=christmas)** Chasing lights along the roofline, warm windows behind frosted glass, icicles, a candy-cane door, snow and a Santa fly-past. |
| [![Birthday](docs/assets/demos/birthday.jpg)](https://paperclipmonkey.github.io/facade-mapper/?demo=birthday) | [![Perseid night](docs/assets/demos/perseids.jpg)](https://paperclipmonkey.github.io/facade-mapper/?demo=perseids) |
| **[Birthday →](https://paperclipmonkey.github.io/facade-mapper/?demo=birthday)** Bunting along the roofline, a cake on the door whose candles burn down over the evening — and go out if you blow at the house — balloons going up the front and confetti over the lot. | **[Perseid night →](https://paperclipmonkey.github.io/facade-mapper/?demo=perseids)** A dark house under a meteor shower. Everything radiates from one point, the ones near it are short because they are coming at you, and the bright ones leave a train hanging in the air. |
| [![New Year's Eve](docs/assets/demos/new-year.jpg)](https://paperclipmonkey.github.io/facade-mapper/?demo=new-year) | [![Bonfire Night](docs/assets/demos/bonfire-night.jpg)](https://paperclipmonkey.github.io/facade-mapper/?demo=bonfire-night) |
| **[New Year's Eve →](https://paperclipmonkey.github.io/facade-mapper/?demo=new-year)** A working clock on the door counting down to midnight, the time over it, sparklers along the gutter, fireworks and confetti. Both counting layers read the wall clock, so the house agrees with every phone in the street. | **[Bonfire Night →](https://paperclipmonkey.github.io/facade-mapper/?demo=bonfire-night)** A pyre burning in the doorway with a guy on top, catherine wheels pinned to the windows throwing sparks off the rim the way real ones do, and rockets over the rooftops. |
| [![Night city](docs/assets/demos/cyberpunk.jpg)](https://paperclipmonkey.github.io/facade-mapper/?demo=cyberpunk) | [![Under the sea](docs/assets/demos/sunken.jpg)](https://paperclipmonkey.github.io/facade-mapper/?demo=sunken) |
| **[Night city →](https://paperclipmonkey.github.io/facade-mapper/?demo=cyberpunk)** Neon tube round every opening, a Japanese sign on the chimney, a holographic advert over the brickwork, code falling in the windows and rain through the lot. | **[Under the sea →](https://paperclipmonkey.github.io/facade-mapper/?demo=sunken)** The house fourteen metres down. Three wave components on the real dispersion relation make a surface that never repeats, and every colour under it has had its red taken out by however far the light travelled to get there. |

Each demo also wires one to three one-shots to keys — **X**, **G**, **F** — so
there is something to press: confetti out of the door, a rocket over the roof, a
wheel going off, the power failing, something breathing out of a flooded
doorway. Perseid night gets a single one, because under a shower the event worth
a keypress is one fireball rather than three.

## Quick start

1. **Open the [control page](https://paperclipmonkey.github.io/facade-mapper/)**
   on the machine driving the projectors.
2. **Get a picture of the house into it** — start a camera on a tripod, or
   import a photograph to trace on.
3. **Open a projector tab**, drag it to that projector's display, press
   <kbd>F</kbd>.
4. **Align it with the camera**, after dark.
5. **Trace** the windows, the door and the roofline, tagging as you go — and
   mark the biggest clear panel of wall `primary`, which is where the starters
   put anything that has to be read from the road.
6. **Effects → Halloween starter** (or any of the others above), then take it
   apart.
7. **Export.** That JSON file is your backup.

The **Start here** panel in the app is a live version of this list: it reads what
is actually true right now, ticks off what is done, expands the step you are on
and carries the button that does it.

The order matters at exactly one point: **align before you trace**. Shapes are
stored in camera coordinates, so tracing first and aligning afterwards is not a
different order, it is work you will lose.

## Documentation

| | |
| --- | --- |
| [Setting up a house](docs/setting-up.md) | Cameras, projector tabs, alignment, walls that aren't flat, overlapping projectors, running it every night |
| [More than one device](docs/multi-device.md) | The phone remote, a second computer driving projectors, and the shared clock |
| [The effect library](docs/effects.md) | Targeting, paths, the look, modulation, triggers, and how the effects are built |
| [Writing your own effects](docs/writing-effects.md) | The `draw` contract, the `fx` helpers, and the three rules |
| [Performance](docs/performance.md) | The budget, the benchmark, and the traps that cost more than a frame |
| [How it fits together](docs/architecture.md) | The project model, coordinate spaces, the render path, cross-tab |

## Keyboard

| | |
| --- | --- |
| <kbd>V</kbd> <kbd>P</kbd> <kbd>L</kbd> <kbd>R</kbd> <kbd>C</kbd> | Select, Area, Path, Rectangle, Corners |
| <kbd>Enter</kbd> / <kbd>Esc</kbd> | Finish / cancel the shape being drawn |
| <kbd>Backspace</kbd> | Remove last point while drawing; delete the selection otherwise |
| <kbd>Alt</kbd>-click | On an edge adds a point, on a point removes it |
| <kbd>Shift</kbd>-drag | Line a point up with its neighbour |
| <kbd>Ctrl</kbd>/<kbd>Shift</kbd>-click | In the effect list: add to, or extend, the selection |
| <kbd>Space</kbd> | Play / pause |
| <kbd>B</kbd> | Blackout |
| <kbd>1</kbd>–<kbd>9</kbd> | Jump to a scene |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> | Undo (<kbd>Shift</kbd> to redo) |

In a projector tab: <kbd>F</kbd> fullscreen, <kbd>I</kbd> status, <kbd>T</kbd>
cycle test patterns.

## Requirements

A Chromium-based browser or Firefox, on the machine driving the projectors.
Needs `BroadcastChannel`, `getUserMedia` and WebGL. Camera access requires a
secure context, which GitHub Pages provides.

Putting a phone or a second computer on the show additionally needs Node 18 or
newer on the show machine, for `server.mjs` — nothing else, and nothing to
install. See [more than one device](docs/multi-device.md).

## Running locally

Plain ES modules with no build step, but module imports need a real HTTP server —
opening `index.html` from disk will not work.

```bash
git clone https://github.com/paperclipmonkey/facade-mapper.git
cd facade-mapper
node server.mjs
# then open http://localhost:8000
```

That is also the server that puts a phone or a second laptop on the show — it
prints the addresses to use. It has no dependencies; `python3 -m http.server
8000` still serves the app perfectly well if you only ever want one machine.

Tests are plain Node, no dependencies:

```bash
(for t in test/*.test.mjs; do node "$t" || exit 1; done)
```

The subshell is not decoration: without it a failing test would stop the loop
and still leave `$?` at zero, so a script wrapping this would call a red suite
green.

And `test/bench.html`, served over HTTP, benchmarks every effect on your own
hardware.

Every picture in this file is generated rather than taken — the demos and the
picture under the title are one frame each through the real renderer and the
real colour grade, and the screenshot of the app is the real app, driven in a
browser. Nothing here is drawn *for* the README, which is the point: a
hand-taken screenshot goes out of date the day after it is taken and never says
so. Regenerating them is the one thing in the repository that needs anything
installed:

```bash
npm i -D playwright && npx playwright install chromium
node tools/screenshots.mjs             # every demo, and the picture up top
node tools/screenshots.mjs birthday    # just one
node tools/appshots.mjs                # the control tab
```

## Licence

MIT. See [LICENSE](LICENSE).
