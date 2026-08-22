# The effect library

Over eighty effects, and a **Browse…** button on every layer that
renders all of them live, on a shape like the one you are pointing at. Pick by
eye; this file is for the ideas behind them.

- [Targeting](#targeting)
- [Effects that know where the windows are](#effects-that-know-where-the-windows-are)
- [Effects that happen once](#effects-that-happen-once)
- [The rest of the year](#the-rest-of-the-year)
- [Night city](#night-city)
- [Under the sea](#under-the-sea)
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

Two of the tags are worth tracing even though there is nothing on the house to
trace *around*, and both are decisions rather than outlines:

- **`primary`** is the one flat panel the show's headline goes on. `sign` is a
  *path* and text follows its curve, which is right over a porch and wrong for
  anything that has to be square to be read — a countdown, a clock, a symbol.
  Find the largest clear rectangle of wall, usually the band between the
  first-floor windows and the ground floor, and mark it. New Year's Eve puts
  its figures there and leaves the clock face on the door; Birthday puts the
  name there. It is the difference between a message hung off whatever happened
  to be traced and one placed where you decided it should go.
- **`planter`** is a pot, a window box, or a bed at the foot of the wall.
  Flowers grows a bunch out of the bottom edge of it and Creeping Vine will
  start from one. Trace the space the plant should *occupy*, not the pot —
  the pot is a dark blob at night and the flowers are the point.

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
group. **Clear all** empties the list in one go. <kbd>Ctrl</kbd>+<kbd>Z</kbd>
puts any of it back.

You do not need **Clear all** to swap one look for another, though. A starter
preset *replaces* what is lit rather than adding to it: the layers already on
the house are switched off, not deleted, and the scene that preset saves is
that look on its own. So applying Halloween and then Christmas leaves you with
both in the project, one scene each, and the two hotkeys genuinely switch
between them.

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
| **Flowers** | A bunch growing out of the bottom edge of the shape and swaying, with one slider from fresh to dead and the petals blowing away. |
| **Ditsy Flowers** | A small floral print over the whole wall, cut around the openings rather than hung over them. |
| **Paisley** | Botehs in a half-drop repeat, with rosettes, fronds, tendrils, suns and dots packed in between them. |

**How it comes up.** Growing tips is what the plant grows *to*, not what it
starts with: one runner sets off, another every second or so after it, until
the full complement is working. That matters more than it sounds. Each shoot
carries a glow several times the vine's own width and they all start from the
bottom edge, so six arriving in the same instant — which is what used to happen
the moment you added the layer — read as one thick bar of light across the foot
of the wall rather than as anything growing. A tab that joins the show an hour
in skips the wind-up and has the whole plant immediately.

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

### Papering the wall

**Ditsy Flowers** and **Paisley** are prints: one motif repeated over the whole
of whatever you point them at. They are here rather than in *basic* because they
treat the openings the way a decorator does — the paper is *cut* at the reveal,
not hung over the glass — and because on a pale rendered wall they do the same
job Brickwork does, which is to give the wall a surface so that everything above
them stops looking like a slide on a sheet.

A few things are worth knowing.

**The lattice is anchored to the building, not to the shape.** Two walls either
side of a door are laid on one grid and cannot disagree about where the pattern
is. This is the same decision as Brickwork's course offsets and it is there for
the same reason: anchoring to each shape's own bounding box gives every traced
area its own private pattern, and no combination of settings will bring them
into line, because the disagreement is in the anchor rather than in the numbers.

**Nothing overlaps.** A print is a layout, not a scatter: two teardrops crossing
read as one unrecognisable object, and a filler dropped on top of the motif it
was meant to set off reads as damage. So the motifs ask for more room than the
lattice has and are then *shrunk to fit* — where two would collide they divide
the distance between them and end up exactly touching. That is why the sizes
vary the way they do: what decides how big a motif is is the layout around it
rather than a number somebody typed.

Two consequences follow, and both are deliberate. Anything already on the wall
stays exactly where and as it is when something new arrives beside it — a bold
motif never gives way to a filler — so **Density** can be swept without the
pattern rearranging itself. And a motif's footprint follows the *shape* of its
artwork rather than a circle round it: a boteh is long, thin and bent, and
reserving a circle for it would leave four fifths of a cell of ground nothing
could ever get into.

**It is layered.** A print is not one motif repeated. Paisley puts bold
teardrops on every other cell of a half-drop repeat, middling ones on the cells
between, and a fine ground of small botehs, fronds, tendrils, suns and dots
scattered round both — that last layer is **Density**, and at nought you get the
bare repeat. Ditsy Flowers is deliberately a scatter instead, one bag of motifs
in every cell, which is what a ditsy is; its Density adds buds and leaves into
the gaps. Half of every print is stamped mirrored, because a boteh has a hand
and a wall of teardrops all hooking the same way is a rubber stamp.

**Ground** is a colour and a level, and the level is the interesting one. At the
top the wall is painted out and you get the printed article. At nought only the
motifs are lit, and the ground of the print is the actual wall — brick, render,
whatever is there — which is usually the better answer outdoors and always the
cheaper one in light. The flower centres are cut out rather than painted for the
same reason: they are the ground showing through, so they stay right whichever
way you set it.

**It moves, and it is meant to be driven.** One travelling wave crosses the whole
building, and each motif reads it where it stands, so neighbours rock nearly
together and the far end of the house is half a beat behind — a gust going
across a wall rather than a few hundred things that happen to be wobbling.

| | |
| --- | --- |
| **Sway** | How far the gust leans each motif. |
| **Swell** | How much it breathes them in and out as it passes. |
| **Breeze speed** | How fast the gust travels. Set it to nought and the wall holds still until something else moves it. |
| **Gust phase** | Where the gust is, in turns. This is the one to bind: a saw LFO across it drives the whole wall from the beat instead of from the clock, and comes round to where it started rather than jumping. |
| **Shimmer** | A second wave, crossing in brightness rather than in angle. |
| **Fill** | How much of its packed space each motif takes. One is a tessellation — everything exactly touching — and anything less opens the ground up without moving a thing. Bind it to the level and the whole print tightens and loosens with the music. |
| **Density** | How much fine ground there is between the bold motifs. Bound to an envelope, the pattern fills in on the beat and thins out after it. |
| **Turn** | Every motif, turned together, in turns. Paisley only; a rosette does not care which way up it is. |
| **Drift** | Slides the whole print, which is a good deal stranger and worth trying once. |

Fill and Swell only ever take *less* than the packing allowed, which is what
keeps the no-overlap guarantee true at every instant rather than on average — a
print bound to the microphone can pulse as hard as you like and still never put
one teardrop through another.

**Motif size** sets the repeat, and everything scales with it: turn Paisley's up
past 600 and one boteh covers the front of the house. Cost is the number of
motifs on the wall rather than what is in them, and the pitch quietly opens out
rather than letting a very small setting on a very large wall put forty thousand
of them in a frame. The layout is worked out once and kept until something that
shapes it moves, so a wall that is only breathing costs nothing to keep
breathing.

### Flowers, and letting them die

**Flowers** grows a bunch out of the bottom edge of the shape it is given. It is
meant to be traced directly above something real — a window box, a wall pot, the
top of a hedge — so that the plant appears to be growing in it; the stems root on
the outline you drew rather than on the floor of its bounding box, so a shape
traced round the pot itself works as well as a rectangle above it. Nothing is
clipped: the flowers lean out over the brickwork and the petals blow across it,
which is the point.

**Wilt** is the control worth binding to something. At nought it is a fresh
bunch; at one the stems have gone over, the leaves hang, the colour has gone to
the **Withered** hue and every petal has left. In between, petals let go one at a
time and blow away on the same wind the stems are answering.

It is a *position* rather than a process, which has two consequences that are
easy to miss and both wanted. Sliding it back down puts the petals back, so a
slow LFO gives you a bunch that dies and recovers all evening rather than one
that is spent after the first pass. And what the flower looks like depends only
on where the slider is — so a projector tab opened at ten o'clock shows the same
half-bare flower as the one that has been running since dusk, which a shedding
*rate* could not do.

For Halloween, bind it to an LFO at a couple of minutes a cycle, or to a motion
trigger: the flowers are fine until somebody walks up the path.

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
| **Rocket** | One shell: it lifts on a plume, hangs, and breaks. Peony, willow, palm or crossette, and the star colours are the metal salts rather than a palette somebody liked. |
| **Confetti Cannon** | A cone of paper out of the shape, tumbling and settling into a drift. |

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

Each demo house ships with its own, on **X**, **G** and **F** — bats and a knock
at the door on Halloween, a rocket and a confetti cannon on New Year's Eve, a
wheel and a collapsing log on Bonfire Night. Those keys avoid the
ones the editor already uses — the first draft used **B** for bats, which is
Blackout, so pressing it blacked the show out and never reached the trigger at
all. It looked configured and did nothing. The trigger inspector now says so if
you pick one of those.

Anything that can type can press a key, which includes a doorbell wired to a USB
button.


## The rest of the year

Halloween and Christmas are the two nights everybody already projects onto a
house. They are not the only ones, and the four below each ask the library for
something it did not previously have.

Each is a starter preset, and each has a demo you can open without any hardware
at all:
[birthday](https://paperclipmonkey.github.io/facade-mapper/?demo=birthday) ·
[Perseids](https://paperclipmonkey.github.io/facade-mapper/?demo=perseids) ·
[New Year's Eve](https://paperclipmonkey.github.io/facade-mapper/?demo=new-year) ·
[Bonfire Night](https://paperclipmonkey.github.io/facade-mapper/?demo=bonfire-night).

### Birthdays

| | |
| --- | --- |
| **Birthday Cake** | Tiers, icing that drips, and candles that burn down over the evening. |
| **Balloons** | Helium balloons rising, swaying, on strings. |
| **Bunting** | Triangular flags along a path, sagging between the ends and lifting in a travelling gust. |
| **Confetti** | Paper falling over the whole house, flashing as it turns edge-on. |

The cake is the one effect in the library that can be *interacted with* without
any hardware: **How many are lit** is a normal parameter, so bind it to the
microphone and blowing at the house puts the candles out. The starter preset
does exactly that, through an expression binding — `clamp(1 - level * 2.2, 0, 1)`
— and it degrades correctly on a machine with no microphone, where the audio
bands read zero, the expression returns one, and every candle stays lit.

Two details worth knowing about, because both are what stop the effects looking
generated. Candles shorten as a function of show time rather than of anything
remembered, so a projector tab opened at ten o'clock draws the same stubs as the
one that has been running since six. And balloons rock as they climb at a rate
that depends on their size, because a rising balloon sheds vortices off
alternate sides and a big one does it more slowly than a small one — without it,
a screenful of balloons reads as a screenful of bubbles.

### The Perseids

| | |
| --- | --- |
| **Meteor Shower** | Meteors radiating from a point, with fireballs and lingering trains. |

The whole effect is one idea: everything in a shower comes from the **radiant**,
and how long a meteor looks depends on how far from it you see it. A meteor near
the radiant is coming almost straight at you and hardly moves; the same rock
ninety degrees away crosses half the sky. Getting that backwards — or leaving it
out — is what makes drawn meteor showers read as fireworks.

The colour is the other half, and it is the one place in this library where
colour is deliberately *not* blackbody. Embers and sparks are thermal emitters
and cool down the curve; a meteor is a millimetre of rock being stripped atom by
atom at eighty kilometres up, and what you see is line emission — the green so
many Perseids show is neutral magnesium at 518 nm, the yellow is sodium at 589.
No hot body ever glows those colours, which is exactly why a shower drawn with a
fire palette looks wrong without anybody being able to say why.

The bright ones leave a **train**: a wake of ionised air that hangs for seconds
after the meteor has gone and visibly shears as the wind at that altitude pulls
it apart. It is the detail people who have actually lain in a field watching a
shower recognise.

The preset also runs a second, much slower shower with its radiant somewhere
else entirely. Those are **sporadics** — on any night there are meteors that
belong to no shower at all, and during a peak they are the ones that catch you
out. Leaving them out is the kind of tidiness that makes a sky look generated.

### New Year's Eve

| | |
| --- | --- |
| **Clock Face** | A working clock, counting down to a moment, that flares when it arrives. |
| **Countdown** | The number, in text, on a sign over the door. |

Both read the **wall clock** rather than show time, through the link — so they
do not pause when the transport does, they are right whatever time the show was
started, and a second machine driving its own projectors agrees to the
millisecond. The hands show the true time even through the last minute, and that
is deliberate: half the street is holding a phone showing the same time, and a
house that disagrees with it is a house with a broken clock on it.

Set the date on both counting layers on the night. It is a text field rather
than anything clever, and it wants changing once a year.

### Bonfire Night

| | |
| --- | --- |
| **Bonfire** | A built pyre with a flame column, embers on the thermal, smoke, firelight on the wall, and optionally a guy who burns down over the evening. |
| **Catherine Wheel** | A wheel that spins up, throws sparks and burns out. Relights on a timer, or once when triggered. |
| **Sparkler** | A sparkler head running round a path, throwing forked iron sparks and leaving the after-image you get writing your name with one. |

The wheel is the one to look closely at. Sparks leave it **tangentially** — a
spark on the rim is travelling along the rim at ωR, and when the casing lets go
it carries straight on at ninety degrees to the spoke. Sparks that fly outwards
along the spoke give you a sea urchin; tangential ones give you the curved,
lopsided wheel everybody has actually stood in front of. There is a test for it.

The sparkler's forks are not decoration either: the wire is coated in iron
filings, each filing burns from the outside in, and when the molten shell fails
the trapped gas blows it apart — which is why the sparks divide *partway along
their flight* rather than at the wire.

## Night city

Blade Runner and everything downstream of it. It is worth noticing how little of
that look is science fiction: it is a wet street at night lit entirely by
signage, and a projector pointed at a house is already most of the way there.

| | |
| --- | --- |
| **Neon Tube** | A glass tube bent round the shape — halo, white-hot core, mains buzz, a dead section, and the stutter a cold tube makes when it strikes. |
| **Neon Sign** | Lettering as tube, stacked vertically and framed like signage bolted to a wall. |
| **Hologram** | An advert over the brickwork: scrolling lettering, scanlines, colour fringing and the occasional tear. |

Three things make neon read as neon rather than as a coloured line. It is drawn
as concentric strokes — widest and faintest first, then a core that is nearly
white, because a real tube's core saturates your eye. It **strikes**: a cold
tube stutters, catches, drops out and catches again over about a third of a
second, and a sign that simply sits there lit is the thing that reads as a
graphic. And it throws light on the wall around it, which is what stops a
projected sign floating in front of the building instead of being bolted to it.

None of it uses `shadowBlur` or `filter`, though a glow is exactly what those
are for: both are per-draw-call full-layer compositing operations, and a sign
with twenty glyphs would pay for twenty of them a frame. See
[performance](performance.md).

This is a starter preset like the rest, with its own demo:
[night city](https://paperclipmonkey.github.io/facade-mapper/?demo=cyberpunk).

**Where to point it.** A chimney is a tall narrow rectangle standing above the
roofline, which is the shape and the position of every vertical sign in every
one of these films — it is the best thing on an ordinary British house for this
and it is not obvious until you try it. The demo puts one there.

**Japanese lettering needs a Japanese font.** Current macOS, Windows and Android
all have one; a bare Linux box may not, and there is no webfont to fall back on
because the app ships none at all — it has to keep working on a static host with
no network. Boxes instead of glyphs means the machine, not the effect: install
Noto Sans CJK, or type something else into the field, which works perfectly
well.

## Under the sea

Not a night of the year, and the only look here that changes what the building
*is* rather than what is on it. Everything else in this file decorates a facade;
this one puts it fourteen metres down.

| | |
| --- | --- |
| **Waterline** | The surface crossing the house, the water below it absorbed towards blue, and the light of the surface dancing on the wall above the line. |
| **Shafts from the Surface** | Sunlight coming down in beams, swaying with the swell, reddening out of existence as it goes deeper. |
| **Shoal** | Fish working their way across the wall, steering round the windows and the door. |
| **Kelp** | Weed rooted along the bottom edge of a shape, thrashing at the tip and still at the holdfast. |
| **Bubbles** | Rising out of the brickwork, zigzagging, swelling, and collecting under any sill they meet. |
| **Jellyfish** | Bells pulsing up the wall, trailing tentacles that follow where the bell has been. |
| **Dolphins** | A pod crossing the wall and porpoising through the surface, on the ballistics that go with the height you asked for. |

All seven take the same three parameters — **Surface at**, **Metres top to
bottom** and **Murkiness** — and that is not repetition, it is the mechanism.
They are what makes seven independent effects agree about one body of water. Set
the surface once and the shafts arrive at the height the waterline is drawn at,
the kelp sways hardest where the shafts are brightest, and a jellyfish at the
eaves is tinted for the depth it is actually at. Change one layer's and the look
comes apart in a way that is hard to point at and easy to feel.

**The colour is absorption, not a tint.** This is the part worth understanding,
because it is why the look survives being stared at. Water absorbs red about
thirty times faster than blue: ten metres of it removes ninety-five per cent of
the red in a beam of white light and about a tenth of the blue. So depth is a
*spectral* effect, not a brightness one — warm things lose their colour with
distance while blue-green things barely change, and you can read how far away
something is from its hue alone.

That matters more on a house than it does in a photograph, because a projector
cannot make anything darker. Depth done as a dimmer switch has nowhere to go on
a wall that is already as dark as it gets; depth done as `fx.waterAbsorb` is
still legible at the bottom of the frame, where there is no red left in anything
and the wall has gone deep blue. See
[writing your own effects](writing-effects.md#the-fx-namespace).

**The surface obeys the dispersion relation.** Three wave components, each with
ω² = gk — so the long swell genuinely outruns the short chop and the pattern
never repeats itself. Pick three frequencies by eye instead and they lock into a
repeating comb within a second, which reads as corduroy. It costs one square
root and it is the difference between water and a graphic.

**And wave motion dies off exponentially with depth**, at e^(−kz): essentially
gone half a wavelength down. That single term is why the kelp thrashes at the
tip and does not stir at the holdfast, and why a frond drawn with a uniform sine
wave up its length — which is what everyone draws first — reads as a flag. The
plants also lean on a slow, depth-uniform **Current**, because a tidal stream is
not a wave and does not care how deep you are; between the two, the whole plant
is alive and only the top of it is whipping.

**Bubbles are not balls with the gravity turned round.** Above about a
millimetre and a half across, a rising bubble sheds vortices off alternate sides
and zigzags — more slowly the bigger it is — which is why a stream of them from
one crack arrives at the surface spread over a metre. They also *swell*: the
absolute pressure on a bubble ten metres down is twice what it is at the
surface, so by Boyle's law it has half the volume, and the radius grows by the
cube root of the ratio on the way up. And they are drawn as a **rim**, not a
disc: under water a bubble is a lens of air with nothing in the middle of it, so
what you see is a bright ring and a hard highlight. Drawn filled, it is a pearl.

**A jellyfish's tentacles are its own history.** The bell's position is a closed
form of show time rather than an integration, which buys two things: a projector
tab opened at eleven o'clock has nothing to catch up on, and the position can be
asked for at times other than now. So a tentacle point is simply *where the bell
was* a moment ago — it curls through the surges by itself, lags on the fast part
of the stroke and gathers back under the bell as it coasts, and none of that is
drawn. The stroke it is following is deliberately asymmetric: the bell squeezes
shut in a quarter of the cycle and refills over the other three, and all of the
thrust is in the squeeze. Make the halves equal and you get a balloon on a
spring.

**Fish flash when they bank**, not when they are fast. A fish's flank is a
mirror; swimming straight it faces sideways and throws the light away from you,
and rolling into a turn it presents that mirror to the surface for a fraction of
a second. That silver flicker running through a shoal as it changes direction is
the most recognisable thing a shoal does, and it comes out of one term keyed to
the turn rate.

**A fish's shape is a choice, and Shoal's Body plan is that choice.** Fast open
water wants a fusiform body and a deeply forked tail — a long thin foil that
shed little energy sideways, superb over distance and hopeless at turning. A
reef wants the opposite: a deep disc with a rounded paddle, which cannot cruise
and can pivot inside its own length, because the food and the thing eating you
are both one body length away. So the three plans differ in how fast they
cruise as well as in outline, and `mixed` gives you all three in one shoal —
without that, three silhouettes swimming at one speed are three costumes.

**Porpoising is economy, not showing off.** A body moving at the surface makes
waves, and wave drag there runs to several times the drag on the same body a
couple of diameters down — so above a threshold speed the cheapest way to
breathe is to leave the water entirely, and that is why fast dolphins leap and
slow ones do not. The arc is not a shape chosen to look like a leap: it is
constant gravity, with the hang time `2√(2H/g)` that goes with the height. Ask
for twice the height and the animal stays up √2 times as long, enters at
`√(2gH)` nose down at the same angle it left nose up, and throws spray that is
itself on the same ballistics. **Leap height** and **Extra dive** are in metres,
like everything else here, and so is **Length** — a three metre animal in
fourteen metres of water is the right size for that water however big the wall
is.

**And the beat rate is not a slider.** St = fA/U — beat frequency times fluke
amplitude over speed — comes out between about 0.2 and 0.4 in dolphins, sharks,
tuna, bats and hummingbirds alike, because that is the band in which a flapping
foil sheds its vortices in the arrangement that makes thrust. So **Strouhal
number** is the parameter and the frequency is a consequence: tell a dolphin to
swim faster and it beats faster, by exactly the right amount, with nothing tied
together by hand. The flukes are horizontal, too, and beat up and down rather
than side to side, because a whale is a land mammal that went back and the spine
it took with it bends that way. It is the one silhouette cue that says mammal.

Point Shoal, Kelp and Bubbles at the shape tagged `wall` and tell them the
windows are solid, exactly as with the [facade effects](#effects-that-know-where-the-windows-are)
above. Waterline, Shafts and Jellyfish want the whole frame.

Waterline and Dolphins both draw *at* the surface rather than reading depth off
it, so both carry **Surface measured from**. On `auto` — the default — a layer
covering the whole frame measures the height from the frame, and one pointed at
a traced shape measures it inside that shape, so half way down means half way
down the thing you aimed it at. Force it to `frame` when the waterline and the
pod have to agree with the shafts to the metre.

This is a starter preset like the rest, with its own demo:
[under the sea](https://paperclipmonkey.github.io/facade-mapper/?demo=sunken).

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

### Drawing on it by hand

**Live drawing** is a layer whose content is a person with a tablet. Add it,
point it at a wall or a window, and open `draw.html` on an iPad from the address
in **Devices** — whatever is drawn there is on the house while the pencil is
still moving. See [more than one device](multi-device.md) for the server that
carries it.

Strokes are stored 0..1 across the target's box rather than in camera pixels, so
they follow the shape if it is re-traced, survive a change of camera, and appear
on every window at once if the layer points at every window. Width follows pen
pressure, which is most of the difference between a drawn line and a plotted
one.

The nib belongs to the *stroke*, picked on the tablet and different for every
stroke in a drawing, so the layer has no width of its own — **Line weight** is a
multiplier over all of them, for a drawing that wants to be heavier on the wall
than it looked on the glass. Both are a percentage of the shape's short edge, so
a stroke is the same weight relative to a window whatever size the window is.

**Fade after** is the parameter worth knowing about. At zero the ink stays until
somebody clears it, and the layer costs one blit a frame however much has been
drawn on it. Above zero every stroke fades out over that many seconds, and the
layer repaints instead — still cheap at the few hundred strokes the store keeps,
and the difference between a mural and writing in light.

The **Surface** box is normally empty, which means "this layer's own drawing".
Naming one makes two layers show the same drawing: the same hand on two walls.

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
