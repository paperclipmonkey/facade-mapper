# Performance

A projector tab has 16.7 ms a frame for everything: the 2D world render, the
bloom chain, the warp, and the browser's own compositing. A show is a dozen
layers. So the working budget is about **1 ms per effect**, and anything over
about 4 ms will cost frames on its own.

## Measuring it

Open [`test/bench.html`](../test/bench.html) on the machine that will drive the
projectors — it needs the app served over HTTP, so a local server or the
deployed site.

It runs every built-in effect through the real renderer into a 1920×1080 world
buffer, over the demo house's traced geometry. Each is measured twice, pointed
at five windows and again covering the whole frame, because the same effect can
cost very different amounts depending on how much of the wall it has to fill.

Two details in the harness matter, and both were got wrong first:

- **Warm up.** The first frames allocate density fields, sprite ladders and
  accumulation buffers. Timing those as if they recurred every frame libels half
  the library.
- **Batch the readback.** Reading a pixel back after every frame forces the
  drawing to finish, which is what you want from a stopwatch — but it also tells
  the browser this canvas is read constantly, and it drops the whole surface to
  software rendering. Every effect then looks several times slower than it is in
  a projector tab, which never reads back. Batching keeps the synchronisation
  without paying that.

Get the second one wrong and you will "optimise" things that were never slow.

## Where it stands

On a base-model Apple Silicon MacBook, everything in the library lands under
about 3 ms, and all but eight effects under 1 ms. The dearest are the ones that
fill large areas: rain, smoke, snow, fire, caustics, static, fog and frost. A
typical twelve-layer show comes to five or six milliseconds.

That is after fixing three things, each of which was costing more than the
entire frame budget on its own.

## The two traps

Both are the same mistake — asking the browser for a general facility when a
specific one was wanted — and both are invisible until measured, because the
output looks correct either way.

### `OffscreenCanvas` as a sprite source

Effects run on the main thread and blit into a main-thread 2D context. On that
path, `drawImage` from an `OffscreenCanvas` is **about thirty times slower** than
from a detached `<canvas>` element — 71 ms against 2.0 ms for sixteen hundred
stamps — because the source's backing store is not the one the destination is
compositing into, and every blit pays to bridge them.

Snow bakes a ladder of pre-softened flake sprites specifically to avoid a
per-particle `filter`, and then handed the entire saving back by baking it onto
an OffscreenCanvas. It went from the cheapest particle effect in the library to
the most expensive thing in the show.

`fx.offscreen` returns a plain `<canvas>` for this reason. OffscreenCanvas earns
its keep inside a worker; on this path it is a trap.

### `imageSmoothingQuality: 'high'` on an upscale

The density-field effects evaluate on a coarse grid and let the browser
interpolate it up to full size. Asking for `'high'` on that blit cost **3.1 ms
against 0.56 ms**, because it is a twenty-fold *magnification* and the better
resampler earns its keep on downscales. Fire, smoke, fog, plasma and caustics
all paid it, for nothing visible: the whole design is a coarse grid relying on
linear interpolation, and there is nothing in a smoke plume for a sharper filter
to preserve.

## The one that cost the most

Everything above is about a single effect. The largest win by far was in the
renderer, and it was not an effect at all.

Opacity, blend and softness are *layer* properties, so a layer that uses any of
them is drawn into a scratch buffer and blitted once — Canvas has no group
opacity, so the buffer is the mechanism. The comment saying so was correct. The
code was not: the clear and the blit were both inside the loop over the layer's
*targets*, so a Cobwebs layer pointed at five windows cleared and blitted the
whole canvas five times a frame instead of once.

The presets set opacity on nearly every layer, so this was the normal case, and
the bill grew every time you traced another window.

The other half of the same story is resolution. The control preview rendered at
`cssWidth × devicePixelRatio` — four and a half megapixels on a Retina laptop —
for a picture shown at half that size beside the panels. The projectors are
what has to be sharp; the preview is a thumbnail of a light show that is soft by
construction. It is capped now.

Measured on the demo house with the Halloween starter, one control-tab frame:

| | ms per frame | fps |
| --- | --- | --- |
| Before | 60.0 | 17 |
| Group composite hoisted out of the target loop | 34.7 | 29 |
| Preview buffer capped as well | 15.1 | 66 |

The last two rows are rendering *more* than the first — a layer and a shape
were added in between. Each open tab paid the first row separately, which is
why a laptop driving a projector alongside the control tab could feel like the
whole machine had slowed down. It had.

The compositing bug was also a *correctness* bug. Compositing per target
instead of per layer means an additive layer's overlapping targets add to
themselves, which is precisely what group opacity exists to prevent.

## Modulation, and the microphone

Binding parameters is cheap; opening the microphone is not free. Measured on the
demo house with the Halloween starter, with **every** numeric parameter on every
layer bound to the audio level — ninety-three of them, far more than any real
show:

| | CPU | render |
| --- | --- | --- |
| Microphone off | 16.4% | 1.4 ms |
| Microphone on | 24.6% | 3.2 ms |

Both hold 60 fps. The extra is the analyser, thirty band measurements a second
broadcast to the projector tabs, and the bindings themselves being evaluated per
parameter per target per frame. That is inherent, and at three milliseconds it
is affordable — but it is real, and if a show is already at the edge, turning
the microphone on is what tips it over.

What is *not* affordable, and used to happen, is a bound parameter invalidating
a cache. Effects receive `stable` — their parameters before modulation —
precisely so a key can never be built from a number that changes every frame.
Frost and Creeping Vine both cache large bitmaps; keyed on the resolved value, a
single audio binding would have thrown away a megabyte of grown ivy and
regenerated it sixty times a second. `docs/writing-effects.md` states the rule;
`test/effects.test.mjs` enforces it.

## The one rule

**Never set `ctx.filter` or `ctx.shadowBlur` per particle or per glyph.**

Each such draw is rendered into its own layer and composited back. The Countdown
effect glowed its text with `shadowBlur`: fifty-five glyphs across five windows
measured at **19.6 ms a frame** — more than the whole budget, for one line of
text. The same glyphs haloed with two widening strokes come to **0.16 ms**, and
read almost identically on a wall, because the bloom in the post stage is what
actually produces the spill your eye responds to. This only has to give it
something bright and slightly spread to work with.

Trading an exact Gaussian for a hundredfold speed-up in front of a real bloom is
not a close call.

Bulk fills are a milder version of the same thing. TV Static drew one `fillRect`
per cell — nearly sixty thousand of them over a whole frame, each with its own
`globalAlpha` change, at 4.6 ms. Writing the grain into a cols×rows `ImageData`
and blowing it up once comes to 2.7 ms for a picture that is pixel-for-pixel
identical: the cell *is* the pixel. Not dramatic — most of what is left is
generating the noise — but it is the difference between a quarter of the frame
budget and a sixth.

## If it still struggles

The control tab shows its own frame rate and render cost in the status bar
under the stage, and the projector tab shows the same behind <kbd>I</kbd>. Two
numbers, because they answer different questions: frames per second says
whether the browser is keeping up, and the millisecond figure says how much of
the budget that tab's own rendering is using. If the frame rate falls while the
millisecond figure does not, the cost is somewhere other than the render —
another tab, the compositor, or the machine.

In rough order of how much they buy:

- **Turn off "Show effects in preview"** in Setup once the projectors are
  running. The control tab is then drawing the camera view and your shapes and
  nothing else. On a laptop driving two projectors this is the single largest
  saving available, because it removes a whole renderer.
- **Drop Render detail** in a projector's inspector. It supersamples the world
  buffer by 1.25 by default; 1.0 is 1.6× fewer pixels and, after bloom, close
  to indistinguishable.
- **Turn bloom down** in Look. The mip chain is the most expensive thing in the
  post stage.
- **Trace fewer, bigger shapes.** Cost scales with targeted shapes, not with
  wall area.
- If the driver refuses the bloom render targets, bloom is skipped and
  everything else carries on.

Each projector only renders the slice of world space its lens can reach, so two
projectors each doing half the house is cheaper *per tab* than one doing all of
it — but it is two tabs, so the machine does more work overall. A laptop driving
several projectors is doing several full renders at once, and that is the
budget to think in.
