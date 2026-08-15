# Setting up a house

Everything in this file is about getting light onto the right bricks. The
[Start here](../index.html) panel in the app is a live version of it — it reads
what is actually true right now, ticks off what is done and carries the button
that does the next thing. Read that in preference to this; this is the reasoning
behind it.

- [The short version](#the-short-version)
- [Before you have a projector](#before-you-have-a-projector)
- [The picture you trace on](#the-picture-you-trace-on)
- [Projector tabs](#projector-tabs)
- [Alignment](#alignment)
- [When the wall is not flat](#when-the-wall-is-not-flat)
- [Several projectors](#several-projectors)
- [Tracing](#tracing)
- [Running it every night](#running-it-every-night)
- [Where everything is stored](#where-everything-is-stored)

## The short version

1. Open the control page on the machine driving the projectors.
2. Get a picture of the house into it — a camera on a tripod, or a photograph.
3. Add a projector, open its tab, drag it to that projector's display, press
   <kbd>F</kbd>.
4. **Align it with the camera.** After dark.
5. Trace the windows, the door and the roofline, tagging as you go.
6. **Effects → Halloween starter** (or Christmas), then take it apart.
7. **Export.** That JSON file is your backup.

The order matters at exactly one point: **align before you trace**. Shapes are
stored in camera coordinates, so tracing first and aligning afterwards is not a
different order, it is work you will lose.

<kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>K</kbd> does any of the above without
hunting for the panel it lives in — "align", "projector", "demo", "blackout",
the name of any effect or shape. It is worth learning before you are outside in
the cold.

## Before you have a projector

**Try it on a demo house.** The button is on the empty stage and at the top of
the Start here panel, or open the app with [`?demo`](../index.html?demo)
appended to the URL.

That loads a complete show: a facade to trace on, five windows and a door
already traced and tagged, a projector already aligned, and a Halloween look
running. Nothing about it is a mock-up — the shapes, the effects, the alignment
and the preview are all the same code a real show runs, so anything you learn
there is directly transferable. It opens as its own show, so it never costs you
one you were working on.

This exists because the honest answer to "what does this do?" used to require a
projector, a camera, a second display and darkness. Now it requires a browser
tab.

## The picture you trace on

Everything you draw is drawn on a picture of the house, and every shape is
stored in that picture's coordinates. There are three ways to get one, and they
are not equivalent:

| | Trace on it | Align projectors with it |
| --- | --- | --- |
| **Live camera** | yes | yes |
| **Captured still** (Setup → Capture still) | yes | no — restart the camera |
| **Photograph** (Setup → Use a photo) | yes | no |

A live camera is doing two jobs: it is the surface you draw on, *and* it is the
sensor that watches the alignment dots. Only it can do the second.

A photograph is for the first job alone, and it is genuinely useful for it —
tracing is the slow, fiddly part of the whole process, and there is no reason to
do it outdoors in the cold. Photograph the house in daylight from roughly where
the camera will stand, trace it on the sofa, and on the night start the camera
and nudge the shapes into place. The closer the two framings, the less nudging.

Put the camera on a tripod. Everything you draw is in camera coordinates, so if
the camera moves after you have aligned, the entire mapping moves with it.

## Projector tabs

One browser tab per physical projector, dragged onto that projector's display
and put fullscreen with <kbd>F</kbd>. The control tab talks to them through the
browser, so they stay in step without a server.

The tabs are stateless apart from "which projector am I?" — they load the
project, find their own entry and render. Close one mid-show and reopen it and
it picks up where it was.

Two tabs reporting the same screen origin means one projector is showing the
other's output. The checklist flags that, because it is invisible from the
control tab and maddening to diagnose from the garden.

## Alignment

A projector aimed at a wall and a camera looking at that same wall are two views
of one flat surface. Any two views of a plane are related by a single 3×3
projective matrix — a homography. The projector flashes nine dots one at a time,
the camera finds each one, and nine known "projector pixel ↔ camera pixel" pairs
is more than enough to solve for it. After that, any point you draw on the
camera picture converts to the projector pixel that hits it.

The app reports the solve quality in pixels of a nominal 1920-wide output. Under
about 5 px is good. It also throws away a single bad detection — a reflection, a
passing car — and re-solves if that clearly helps.

**Getting a good solve:**

- Do it after dark. The dots have to out-shine everything else in frame.
- Get the whole projected area inside the camera view before you start.
- Don't move the camera afterwards.
- The app tries to pin exposure and white balance, but browser support is
  patchy. If your camera app can lock them, do that first.

If the camera can't manage it — too bright, too far, a phone that insists on
auto-exposing — put a test grid up and drag the four corners by hand with the
**Corners** tool. Same maths, worse input.

## When the wall is not flat

A homography describes a plane, so a flat front elevation is exactly right and a
corner is exactly wrong. Where two or three faces meet, no single plane fits:
you can line one face up and the others go out, and re-running the alignment
does not help, because the problem is the model rather than the fit.

**Wall shape**, on the projector, is the answer. Set it to a denser grid and the
alignment runs 25 or 49 dots instead of 9. The extra dots are not there to fit a
better plane — they measure how far the wall departs from one. The homography
still does the global mapping; the leftover error at each dot is exactly the
surface bending away, and that goes into the warp mesh as a correction.

A corner is a discontinuity in slope and the mesh interpolates smoothly, so the
correction rounds the seam off slightly rather than reproducing it exactly. It
takes the bulk of the misalignment out; if the crease itself still reads as
soft, nudge those control points by hand with **Surface warp**.

On a genuinely flat wall the residuals come out at nothing and the mesh stays
flat, so there is no cost to using a denser grid beyond the time it takes to
step through the dots.

## Several projectors

Every tab shares one project through the browser, so the control tab is the only
place you edit. Shapes live in camera coordinates, so a window covered by two
projectors is drawn correctly by both — each converts world coordinates through
its own homography.

### Where they overlap

**Both projectors draw it, and light adds.** There is no shared frame buffer to
composite into — there are two lamps pointed at a wall — so the region they
share comes out at twice the brightness with a hard seam down each side of it.
Nothing in the renderer can prevent that.

What fixes it is each projector fading its own output out across the shared
band, by exactly the amount the other fades in. Two complementary ramps sum to
one and the seam disappears. That is what **Edge blending** does, and the fade
is applied in linear light — attenuating gamma-encoded values leaves a visible
bright stripe no matter how carefully the widths are set.

Setting the widths used to be a job for the garden: nudge four numbers per
projector, walk out, look, walk back. It never needed to be, because both
homographies already say precisely where each projector lands on the wall.
**Projectors → Blend overlaps** walks in from each edge asking "is anybody else
covering this?" and sets every width from the answer. The panel tells you when
two aligned projectors overlap with no blending set, which is the usual cause of
a bright stripe down an otherwise good mapping.

Adjust **blend gamma** if the seam still reads slightly bright or slightly dark
after that — that one depends on the projector's own response curve and cannot
be derived from geometry.

### Keeping them in step

Effects use seeded random number generators rather than `Math.random()`,
specifically so two projectors covering the same wall produce the identical
flame, the identical snowflake and the identical lightning bolt.

## Tracing

The **Area** tool for windows and doors, **Path** for rooflines and gutters,
**Rect** to drag a quick rectangle.

As each shape closes you are asked to name it, and clicking a tag both tags
*and* names it — one click turns a new rectangle into "Window 2" tagged
`window`. Worth doing: an effect pointed at the `window` tag lights every
window, and keeps working as you trace more.

The tags the starter presets look for are `window`, `door`, `roof`, `trim`,
`wall` and `sign`. The facade-aware effects treat `window` and `door` as solid
by default, so tagging is also what tells a bouncing ball where the glass is;
`sign` marks an open path meant to be written along, like an arch over the door.

While drawing: <kbd>Enter</kbd> finishes, <kbd>Esc</kbd> cancels,
<kbd>Backspace</kbd> removes the last point. Afterwards, <kbd>Alt</kbd>-click an
edge to add a point or a point to remove it, and <kbd>Shift</kbd>-drag to line a
point up with its neighbour.

## Running it every night

**Setup → Nightly schedule** gives on/off times and which days. It drives the
same blackout the <kbd>B</kbd> key does, so a scheduled "off" leaves the
projectors awake and aligned — they simply stop emitting.

Windows that end before they start run past midnight, and the day filter applies
to the day the window *opened*, so a Friday 20:00–01:00 slot is still running at
half past midnight on Saturday.

## Where everything is stored

| | |
| --- | --- |
| Shapes, alignment, effects, scenes, triggers, schedule | `localStorage` — small, and the thing worth keeping |
| Video, images, sounds, the traced camera still | IndexedDB — too big for `localStorage`, and shared across tabs so projector tabs read the same files |

Nothing is uploaded anywhere. Clearing site data deletes all of it, so
**Export** once your alignment is right.

## Requirements

A Chromium-based browser or Firefox, on the machine driving the projectors.
Needs `BroadcastChannel`, `getUserMedia` and WebGL. Camera access requires a
secure context, which GitHub Pages provides and `file://` does not.
