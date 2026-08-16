# The effect library

Around fifty effects, and a **Browse…** button on every layer that renders all
of them live, on a shape like the one you are pointing at. Pick by eye; this
file is for the ideas behind them.

- [Targeting](#targeting)
- [Effects that know where the windows are](#effects-that-know-where-the-windows-are)
- [Effects that happen once](#effects-that-happen-once)
- [Paths and animation](#paths-and-animation)
- [Drawing for a projector](#drawing-for-a-projector)
- [The look](#the-look)
- [Modulating parameters](#modulating-parameters)
- [Triggers](#triggers)
- [How the effects are built](#how-the-effects-are-built)

## Targeting

A layer draws into the shapes it targets. Point it at specific shapes, or at a
**tag** — `window`, `door`, `roof` — and it lights everything with that tag,
including shapes you trace later.

A layer with no targets covers the whole frame. That is how snow, fog, bats and
lightning work, and it is also the sensible fallback for the facade-aware
effects below.

**Stagger** offsets each targeted shape a little further back in time. Point one
Pulse layer at the `window` tag, add half a second of stagger, and the windows
light in sequence rather than together. It is the single cheapest way to stop a
row of windows looking like one rectangle.

### Working with the list

Click an effect to select it, <kbd>Ctrl</kbd>-click (or <kbd>Cmd</kbd>-click) to
add one to the selection, <kbd>Shift</kbd>-click to take a range —
the conventions of any file list. <kbd>Backspace</kbd> deletes everything
selected, and the inspector offers **Enable all** and **Bypass all** for the
group. **Clear all** empties the list in one go, which is what you want when
swapping a Halloween look for a Christmas one. <kbd>Ctrl</kbd>+<kbd>Z</kbd> puts
any of it back.

Selecting a *shape* is the other way in. The inspector lists what is currently
lighting it, adds a new effect straight onto it from the gallery, or points one
you already have at it — so tracing a window and lighting it is one panel rather
than three.

<kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>K</kbd> skips the list entirely. Type three
letters and press Enter: `snow` adds Snow, `door` selects the door, `black`
blacks the show out, a scene name plays it. It reaches every effect, shape,
layer, scene, look and panel in the app, and it works from inside a text field,
which matters when the laptop is balanced on a wall in the dark and you would
rather not go looking for a tab.

### Why can't I see it?

There are about eight reasons a layer puts no light on the wall, and until you
know which one it is you are guessing. The list now says so on the row, and the
inspector says it in a sentence: bypassed, soloed out by something else, opacity
left at zero, pointed at a tag no shape carries, pointed at a shape that has
since been hidden or deleted, or running an effect that no longer compiles. The
show-wide ones — blacked out, master down, nothing aligned yet — sit at the top
of the Effects panel.

The one that catches everybody is the fourth: a layer aimed at `#window` before
any window has been tagged looks completely normal in the list, because it *is*
completely normal. It just has nothing to draw into.

## Effects that know where the windows are

Most effects are handed a shape and fill it. The **facade** category is given a
shape to move *around in*, and a list of tags to treat as solid — `window, door`
by default.

| | |
| --- | --- |
| **Bouncing Balls** | Loose on the wall, ricocheting off the windows and doors. Add gravity and they fall, bounce off the sills and settle. |
| **Serpent** | A snake that explores the wall, steering round the openings rather than across them. |
| **Creeping Vine** | Ivy, mould or veins spreading over the brickwork and creeping *around* the frames. Seeks out bare wall and wraps every opening it finds. |
| **Brickwork** | A course of brick laid over the shape, in running bond, with openings cut cleanly where the windows are. |
| **Breach** | Bricks work loose, shudder, and drop out — and something reaches through the hole they leave. Goes directly over Brickwork. |

**Keeping the vine alive.** Growth is permanent by construction — that is what
makes a wall of ivy cost one `drawImage` a frame — so left alone it fills to its
coverage budget and then stops, which is the one thing a living thing never
does. **Wither** fades the accumulated growth continuously, so new shoots
replace the oldest and the budget becomes a level the plant lives at rather than
a finish line. Measured on the demo wall with wither at 0.3, coverage climbs
past 22% over four minutes and is still moving; with wither off it stops dead.

The number of live shoots is scaled by how much room is left under the budget,
rather than switched off when it runs out, and every shoot fades in and out over
about a third of a second rather than appearing and vanishing. Both of those
matter more than they sound: the shoots carry the brightest pixels on the wall,
so anything that removes one abruptly reads as a flash. The earlier
switch-at-the-budget version emptied and refilled the whole shoot list about
twenty-one times a second once the wall was full — measured, not estimated — and
since the grown bitmap barely changes at that point, that strobe was the only
thing moving. It now measures zero such transitions over four minutes.

One thing to know about **Growth speed**: it is px/s and now means it. Until
recently every tip took at least one step per frame regardless, so anything
below about 190 px/s ran at 190 — the slow settings were not slow, they were
identical. If you have a saved show from before, its vines will genuinely creep
now, and may want the speed raising.

**Start again after** clears the wall completely every N seconds, for a show
that wants the house taken over, cleaned, and taken over again. And **Restart**,
on any layer in the inspector, wipes whatever that effect has built up right
now — ivy, frost, a drift of snow on a sill — which is also how you re-roll one
you do not like the shape of.

Point one at the shape tagged `wall` and it stays on the wall; leave the targets
empty and it uses the whole frame. Either way the windows are in the way.

This is a small change in plumbing and a large one in how the result reads. A
ball crossing a facade is a video; a ball that ricochets off the top of the bay
window is *on the house*. Your eye will accept almost any amount of stylisation
as long as the light behaves as though the building is there, and refuses the
most photographic effect in the world when it does not.

The collision model is in [`js/effects/obstacles.js`](../js/effects/obstacles.js)
and is available to effects you write yourself.

### Brick, and what is behind it

**Sizing the bricks.** The starter is set to about 1.4× life, and that is a
compromise rather than an oversight. A real brick is 215 × 65mm with a 10mm
joint; on a 6-metre wall through an XGA projector that joint lands at under two
projector pixels and turns into grey haze — under the four-pixel floor. Since
the joint has to be exaggerated, the brick has to be exaggerated with it, or you
get thin bricks with cartoon mortar. To work it out for your own wall: divide
1920 by the width in metres to get drawing-pixels per metre, and keep the mortar
above 4 of them.

If the house already has some real brick on it — a reveal round the door, a
plinth under a bay — sample those colours for the projected wall. Having the two
agree is most of what makes it read as masonry rather than as a pattern, because
the eye has a reference two feet away from it.

**Brickwork** exists for one situation and solves it completely: a rendered,
painted or pale wall has no surface of its own, so everything projected onto it
reads as a slide on a sheet. Give it masonry first and every effect above it
starts to look like light falling on a building. Openings are *cut* rather than
left unlaid — running bond staggers alternate courses, so "skip any brick
centred in this window" leaves a ragged scatter round each opening like a bad
tooth, where a real wall has a clean reveal.

**Breach** takes it apart, and takes the brick size from the Brickwork layer
under it automatically — the two are drawing the same wall, so they agree about
where the bricks are without anybody typing the same three numbers into two
panels and keeping them in step. Change the course on the Brickwork layer and
the holes follow. Turn **Match the brickwork** off to breach a wall that is
already brick: a real one, or a photograph. Bricks rattle in their beds for the best part
of a second before they go, one at a time, tumbling down the wall with a puff of
dust; the gap left behind is lit from inside by something you cannot see, and
tentacles push out of it and feel their way over the brickwork. Put it directly
above Brickwork with the same brick dimensions.

**The arms crawl rather than wave.** Each one owns the path it has actually
travelled and extends it a step at a time, exactly as the vine does — so it
steers round the windows instead of across them, stays inside the wall you
traced, follows a sill when it finds one, and prefers ground the other arms have
not used. Reaching its limit it holds station and probes with its far end — the near end
stays in the breach it came out of — then pulls back and sets off somewhere
else, so the tangle on the wall goes on changing all evening. Wedging against a
window frame early is not fatal: it gives up a third of what it has grown and
tries another way, rather than settling for a stub.

Thickness at a point is a fact about the limb — the same distance from the hole
is the same thickness whether the arm is half out or fully extended — so it is
measured from the base rather than as a fraction of however long the arm
currently happens to be. Measured the other way, which is the obvious way, every
joint changes thickness as the arm grows and you can watch the whole thing slim
down as it reaches out.

That the path is *remembered* is what makes it read as alive. An arm computed
from a wave function each frame has no memory: it can be swung across a window
and off the side of the house, and nothing it does in one frame has any bearing
on the next. An arm that found its way round a window frame a minute ago is
still round it now, and the snarl on the brickwork is the record of where it has
been. What is still computed per frame is a sway — two travelling waves at different
rates, applied *sideways* to the stored path and growing along it, so the base
stays put in its hole while the rest of the arm thrashes. Two waves rather than
one because a single sine is a skipping rope: one belly, swinging like a
pendulum. An arm that has reached its full extent goes on moving along its whole
length; only the part in the hole is still.

Where the sway would take the arm somewhere the crawl refused to go, it is wound
in until it fits, and where even that leaves an edge over a window the arm is
*thinned* there rather than moved. A tentacle that narrows as it squeezes past a
frame is invisible; one that covers the glass is the only thing anybody
notices.

Each arm has its own pace, girth, reach and lean, so a clutch out of one hole
never moves in lockstep — which is the kind of wrongness you feel before you can
name it. And when a hole heals, the arms are pulled back inside it before the
bricks return, rather than fading out where they stand.

**Crawl speed**, **Wander**, **Feel round frames** and **Seek bare wall** are the
steering. Turn Seek bare wall down and a clutch of arms will pile up on top of
one another; turn Feel round frames down and they cross open wall instead of
tracing the edges of things.

Three more settings are worth knowing:

- **Wall heals after (s)** puts the wall back and lets it be broken somewhere
  else. Without it the effect spends its holes in the first minute and then has
  nothing left to do for the rest of the evening. Set it to zero when firing a
  short scene from a trigger, where permanence is the point.
- **Holes at once** and **Bricks per hole** decide whether this is one enormous
  breach or a wall coming apart everywhere. Neighbouring gaps merge into a
  single opening, mortar and all.
- **Tentacle** and **Tentacle tip** are the two ends of a gradient down the
  arm, so keep the tip lighter than the body or the whole thing flattens into a
  silhouette. Thickness is two separate things: a taper that is a property of
  the limb — how thick it is a given distance from the hole — and a point that
  is a property of the *end*, so whatever is currently the leading few
  centimetres is thin and stops being thin once it is no longer the end. Without
  the second, every arm finishes in a club the same width as its middle.
- **Suckers** is what stops the tentacles reading as foliage. Turn them off and
  you have vines coming out of a hole, which is also a good look, just a
  different one. They sit on a fixed flank of each arm — an earlier version put
  them on whichever side the crawl was currently favouring, which flips every
  time a step is blocked, so an arm holding station against a window frame
  strobed its suckers from one side to the other at sixty hertz.
- **Tentacle thickness** is not free. An arm needs a corridor about three times
  its thickness to pass through, and can only change course on a radius set by
  its own step length, so a very thick arm cannot navigate a facade at all — it
  wedges against the first window frame and spends the evening as a stub. If
  yours are not going anywhere, that is why.

## Effects that happen once

Everything above loops, which is right for a house that has to hold up from dusk
until the last group has gone and wrong for the moment somebody actually reaches
the door. A swarm always crossing the wall is scenery; a swarm that erupts out
of the porch the instant the bell goes is an event, and the difference is
entirely in the timing.

| | |
| --- | --- |
| **Bat Burst** | A swarm pours out of the shape and scatters across the house. |
| **Shockwave** | Rings of light race outwards and fade. The cheapest way to make a house react to something. |
| **Spark Burst** | A shower of embers thrown out, falling and burning out — blackbody-coloured, so they cool as they go. |

They play once over their **Lasts** and then draw nothing. The origin is the
middle of whatever shape you point them at, so aim one at the door and things
come out of the door.

**Setting one off.** A trigger fires a scene, the scene switches the layer on,
and switching on is what restarts the clock. Firing the same trigger again
replays it immediately, part-way through or after it has finished — a scene
activation restarts everything that scene *enables*, whether or not it was
already the active scene. Only layers it enables, so re-firing cannot wipe the
ivy or the frost that something else has spent the evening accumulating. Build one as: a layer with the burst, **bypassed**; a scene whose only
entry is that layer, enabled; a trigger on a key pointing at that scene, with a
hold a little longer than the burst. After the hold the show goes back to
whatever it was doing, by itself.

Build the scene by hand rather than capturing it. A captured scene freezes the
entire show as it happened to be at that instant, so firing a burst mid-evening
would quietly revert everything else with it; a scene that names one layer
leaves the rest alone, because a layer a scene says nothing about keeps its
authored state.

The demo house ships with three, on **X**, **G** and **F**. Those keys avoid the
ones the editor already uses — the first draft used **B** for bats, which is
Blackout, so pressing it blacked the show out and never reached the trigger at
all. It looked configured and did nothing. The trigger inspector now says so if
you pick one of those.

Anything that can type can press a key, which includes a doorbell wired to a USB
button.

## Paths and animation

Any shape — closed area or open line — carries an arc-length path. Chase, Fairy
Lights, Comet, Trace and Sparks all walk it, which is why a chase takes as long
crossing a short edge as a long one.

Text can follow it too: set Placement to `path` and the lettering wraps round an
arch or along a roofline. Trace a shallow arch over the door, tag it `sign`, and
the starter presets will hang a lit sign on it — "MERRY CHRISTMAS" with a white
outline that thickens with the room, or "TRICK OR TREAT" guttering like a bad
neon tube. Text longer than its path is shrunk to fit rather than running off
the end; turn **Shrink to fit path** off if you meant to scroll it along with
**Position on path**.

### A second camera

**Live Camera** has its own **Camera** setting, and it defaults to *not* the one
doing the alignment. That default is the point.

The alignment camera is a measuring instrument. It sits on a tripod pointed at
the wall you are projecting onto, its exposure is pinned so the calibration dots
read consistently, and every shape you have ever traced is stored in its
coordinates — move it and the whole mapping moves. It is also, by definition,
looking at your own projection, so feeding it back into the show is a feedback
loop and looks like one.

A camera you point at *people* is a different job: a webcam on the doorstep for a
delayed mirror in an upstairs window, a spare one watching the gate. Plug it in,
pick it from the layer's Camera list, and that layer opens it on its own. Streams
are shared between layers asking for the same device and closed when the last
layer stops asking, so the recording light goes out when it should.

### RTSP, and what to do instead

**A browser cannot open an RTSP URL.** There is no RTSP client in any of them,
and `<video>` speaks HTTP progressive, HLS, DASH and WebRTC and nothing else.
That is a platform limit; no amount of work in this app changes it. So a Eufy,
Reolink or any other camera whose only output is `rtsp://…` cannot be pointed at
directly, basic auth or not.

What does work is putting something on the network that pulls the RTSP and
republishes it in a form a browser accepts. Both of these are one line:

```
# MJPEG — works in every browser, no library, ~0.3s behind
ffmpeg -rtsp_transport tcp -i rtsp://user:pass@camera/live0 \
  -f mpjpeg -q:v 6 -r 12 listen=1 http://0.0.0.0:8090/cam.mjpg
```

```
# Or MediaMTX, a single binary: RTSP in, WebRTC and HLS out
mediamtx   # with paths: cam: source: rtsp://user:pass@camera/live0
```

Then put the published URL in the **Camera** box on a Live Camera layer, in
place of picking a device. MJPEG is detected from the URL and loaded as an
image, which is drawable exactly like a video and needs nothing else; anything
else goes to a `<video>`, so progressive MP4 and WebM work everywhere and HLS
works on Safari.

Two caveats. The page must be served over **http** for it to reach an http
stream on your own network — the same mixed-content rule as the trigger
webhooks. And credentials in the URL are stored in the project file in clear,
so think before putting a camera password in one and exporting it.

**This is for effects, not for alignment.** The alignment camera has to see a
dot flash and report it back within a fraction of a second, and it wants its
exposure pinned; a restreamed feed is a second or more behind and re-encoded on
the way. Align with a webcam on a tripod, and use the network cameras for the
picture you put *on* the house.

Two related things worth knowing. The picture behind your shapes in the editor is
the *tracing backdrop* — it is never projected, and no projector tab has a camera
at all. And the **Camera** tick in the stage toolbar means "show the live view
*instead of* the captured still", so turning it off puts the still (or the demo
facade) back rather than leaving you with a black stage: trace against a
photograph while a camera runs for an effect to use.

## Drawing for a projector

Effects draw in a virtual space 1920 pixels wide, and a domestic projector is
usually narrower than that. On XGA — 1024 across — one drawing pixel is a bit
over half a projector pixel, and on a 6-metre wall a projector pixel is about
6mm. Two numbers follow from that, and they are worth knowing before you spend
an evening wondering why something looks like haze.

**Nothing thinner than about 4.** Any width, thickness or size setting is in
drawing pixels, so 4 is roughly two projector pixels on a 1024-wide output —
about 12mm on a 6-metre wall. Below that a line does not vanish (the render is
supersampled, so it fades rather than flickers), but it goes dim, loses its
colour, and stops reading as a line at all. The starter presets were all raised
to that floor: cobwebs went from 1.6 to 5, star size from 3.5 to 7, icicle
edges from 0.8 to 4, frost branches from 2 to 4, text outlines from 2–3 to 4–5.
If you are writing an effect, treat 4 as the minimum feature and let bloom do
the rest — spreading a bright thin thing over several pixels is exactly what it
is for.

**Turn Render detail up.** It is a per-projector slider, default 1.25, and it
sets how much bigger than the output the intermediate buffer is. At 1.25 an XGA
projector renders at 1280 wide; at 2.0 it renders at 2048 and downsamples, which
visibly cleans up thin strokes, text edges and anything moving slowly. It costs
GPU upload bandwidth per frame and nothing else, and a single XGA output has
plenty of headroom for it.

**Black is the hard part, not white.** A projector cannot emit darkness, and
real ANSI contrast on a domestic machine is nearer 200:1 than the 2000:1 on the
box. Whatever grey lands in the "black" parts of your frame lands on the wall,
and a white or rendered wall reflects three or four times as much of it as brick
does. Hence the **White wall** look: gamma below one and a firm contrast, to
pull the low end down to where the wall disappears, and saturation left near
neutral because a pale surface already reproduces colour properly. Trace the
wall and mask to it; a lit rectangle with a visible edge gives the whole thing
away faster than any amount of pixel structure.

## The look

Everything an effect draws goes through one post-processing stage before it
reaches the wall, in the **Look** panel, applied identically by every projector:

- **Bloom** — bright areas spill light into their surroundings, using a mip
  chain so the halo is wide and smooth rather than a tight ring. Real light
  spills; without this, every projected edge reads as a cutout.
- **Filmic roll-off** — stacked layers and lightning routinely push past white.
  Clipping turns those into flat blobs; a filmic curve keeps their shape and
  colour.
- **Exposure, contrast, saturation, temperature, gamma** — global, so you can
  push a whole show warm and moody without touching forty sliders.

Six starting looks are provided (Neutral, Haunted, Ember, Frost, Saturated,
Flat). **Flat** switches the whole stage off, which is what you want while
checking alignment.

Contrast and gamma matter more here than in most rendering, because a projector
cannot emit darkness: whatever grey it puts in the "black" parts of the frame
lands on your brickwork and greys the whole wall. Crushing the low end is how
you get the surrounding wall to disappear.

Per layer there is also a **Softness** control, which blurs that layer alone —
useful when a hard-edged fill looks like a sticker rather than like light.

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
slider value), `level low mid high` from audio, `shape`, and the usual maths
plus `noise`, `fbm`, `clamp`, `lerp`, `smoothstep`, `saw`, `tri`, `square`,
`rand` and `TAU`:

```js
base + 0.4 * sin(t * TAU * 0.5 + i)      // each target a little out of phase
clamp(low * 2, 0, 1)                     // follow the bass
base * (0.6 + 0.4 * noise(t * 0.5, i))   // wander
```

## Scenes that evolve from each other

Switching to a scene **loads** it — the layers take on its stored values, so the
inspector shows the numbers you can see on the wall. Without that, a scene is a
render-time override: switching changes the projection and changes nothing in
the panels, and building 1, 2, 3 that evolve from one another means editing
values you cannot see.

The scene you are in is marked *live*, and gains an **edited** chip and a
**Save** button the moment anything differs from what was stored. Nothing else
can drift, because going to a scene loads it. Switching away discards unsaved
changes; <kbd>Ctrl</kbd>+<kbd>Z</kbd> brings them back.

Triggers and the playlist deliberately do *not* load, because an evening of
scares must not slowly rewrite the show with whatever the last one looked like.

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
   repeats becomes "normal" within a few seconds. A parked car stops
   registering.
3. A change covering nearly the whole region is treated as a light switching on,
   not a person, and re-baselines instead of firing.

The Triggers panel shows a live reading of how much of the region is moving and
the level it has to beat, which is the only sane way to aim one.

### Driving the rest of the house

Most houses that get projected on already have something else running — WLED on
the gutter, a smart plug on the inflatable, a relay on the fog machine — and all
of them speak HTTP. Every trigger can call two URLs: **before**, at the instant
it fires, and **after**, when the hold expires and the show goes back to what it
was doing. Wire the ambient state into *after* and the whole house resets itself
for the next group without anyone touching anything.

WLED's classic API is all GET, so a hook is usually just a URL:

```
http://wled.local/win&T=1&A=255&FX=45      before — everything red, strobing
http://wled.local/win&PL=1                 after  — back to the ambient playlist
```

POST and a body are there for JSON APIs. There is a **Test** button beside each.

**The thing that will catch you out:** a page served over **https** may not call
**http**. Browsers block it as mixed content, silently, before the request
leaves — and WLED and friends are all plain http on the local network. So a show
driven from the GitHub Pages copy cannot talk to them at all. The fix is not a
proxy or a certificate: serve the control page the same way as everything it is
talking to, over http from the machine running the show. It is static files, so
anything that serves a directory will do. The URL box says so if you are in that
situation rather than leaving you to find out in the dark.

Calls default to **no-cors**, which means the reply is discarded. That sounds
like a loss and is not: these are commands, nobody is waiting on the answer, and
the alternative is configuring CORS headers on every device you own. Tick *wait
for a reply* when you want to know why one is failing.

Only the control tab fires them. Projector tabs have no concept of triggers, and
four copies of the same call arriving a few milliseconds apart is not what any
of these devices expects.

**Sounds** are imported into the media library like anything else, and play from
the control tab only — projector tabs usually drive displays with no speakers,
and four copies a few milliseconds apart sounds like a flanger, not a
thunderclap.

## How the effects are built

Five ideas do most of the work of making the built-in effects read as light
falling on a wall rather than as graphics stuck to it. They are all available to
effects you write yourself — see [writing effects](writing-effects.md).

### Linear light

sRGB values are gamma-encoded, so adding or blending them directly is not the
same as adding light. The post chain decodes to linear before bloom and
tonemapping and re-encodes at the end, and `fx.mixLinear` does the same for a
two-colour blend.

The difference shows up most in gradients: a yellow-to-red flame lerped in sRGB
travels through a muddy brown middle, and in linear it does not. Soft-edge
blending between overlapping projectors is done in linear for the same reason —
that is the only way two feathered edges sum to the brightness of one
unfeathered one.

### Colour from temperature

Fire, embers, sparks, candle flames, lightning channels and firework stars are
thermal emitters, so their colour is a function of how hot they are, not an
arbitrary hex. `fx.blackbodyCss(kelvin)` returns the colour of a blackbody at
that temperature. Driving an effect from a temperature and letting it cool is
what makes a dying ember go deep red instead of merely dim — which is the thing
your eye actually reads as "that is burning".

Useful landmarks: 1000 K dull red embers, 1500 K orange flame, 1850 K candle,
2400 K bright yellow flame, 3000 K tungsten, 9000 K and up the blue-white of a
lightning channel.

### Volumes as fields

Fire, smoke and fog are volumes of stuff, and drawing them as a few hundred
additive circles reads as a bag of marbles no matter how they are tuned. Instead
they evaluate a density on a coarse grid — around a hundred cells across — and
let the browser's bilinear upscale turn it into a continuous volume.
`fx.ensureField` allocates and caches one; `fx.curlNoise` gives a
divergence-free velocity to advect it with, which is what makes smoke curl and
billow instead of drifting. It also happens to be several times faster than the
particle version it replaced.

### Growth as growth

Frost on a pane and ivy on a wall are not textures, they are processes: they
nucleate somewhere, they spread, and they branch as they go. Both are generated
as a structure with an *order* — which segment appeared when — and revealed in
that order, so the animation is the growth rather than a fade.

Both accumulate into a cached bitmap, so only the few centimetres added this
frame are ever stroked and a fully-grown pane costs one `drawImage`. That is the
only reason a wall covered in ivy can run alongside everything else.

### Things land on the house

Snow does not fall past your windows, it settles on them. Every shape you have
traced presents a top surface; falling flakes test against those surfaces, pile
up where they land, slump to a natural angle, and when a ledge gets too loaded
the excess breaks away as slabs that slide down the wall and fade out at the
bottom.

Turn it off with **Settle on shapes**, aim it at one group of shapes with
**Settle on tag**, and control how fast it gathers and how deep it gets before
it lets go. `fx.ensureSurfaces` and friends are available to your own effects —
[`js/effects/collide.js`](../js/effects/collide.js) explains the model.

One thing worth knowing about the surfaces: they are built *per shape*, not as
one combined heightfield. That matters on a facade, where a traced roofline
spans the whole width — with one shared surface every window under it would sit
in the roof's shadow and never collect a flake.

### And one unprincipled rule

**Never set `ctx.filter` or `ctx.shadowBlur` per particle or per glyph.** Each
such draw is rendered into its own layer and composited back, so a few hundred
of them will cost tens of milliseconds a frame on their own. See
[performance](performance.md), where this is measured.
