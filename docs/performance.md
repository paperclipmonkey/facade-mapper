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

## If a projector tab still struggles

- Drop **Render detail** in that projector's inspector. It supersamples the
  world buffer by default; 1.0 is noticeably cheaper than 1.25.
- Turn bloom down in **Look**. The mip chain is the most expensive thing in the
  post stage.
- Press <kbd>I</kbd> in the projector tab for a live frame rate and buffer size.
- If the driver refuses the bloom render targets, bloom is skipped and
  everything else carries on.

Each projector only renders the slice of world space its lens can reach, so a
projector covering the front door does far less work than one covering the whole
elevation. Two projectors each doing half the house is cheaper per tab than one
doing all of it.
