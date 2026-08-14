# The effect library

Around fifty effects, and a **Browse…** button on every layer that renders all
of them live, on a shape like the one you are pointing at. Pick by eye; this
file is for the ideas behind them.

- [Targeting](#targeting)
- [Effects that know where the windows are](#effects-that-know-where-the-windows-are)
- [Paths and animation](#paths-and-animation)
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

## Effects that know where the windows are

Most effects are handed a shape and fill it. The **facade** category is given a
shape to move *around in*, and a list of tags to treat as solid — `window, door`
by default.

| | |
| --- | --- |
| **Bouncing Balls** | Loose on the wall, ricocheting off the windows and doors. Add gravity and they fall, bounce off the sills and settle. |
| **Serpent** | A snake that explores the wall, steering round the openings rather than across them. |
| **Creeping Vine** | Ivy, mould or veins spreading over the brickwork and creeping *around* the frames. Seeks out bare wall and wraps every opening it finds. |

Point one at the shape tagged `wall` and it stays on the wall; leave the targets
empty and it uses the whole frame. Either way the windows are in the way.

This is a small change in plumbing and a large one in how the result reads. A
ball crossing a facade is a video; a ball that ricochets off the top of the bay
window is *on the house*. Your eye will accept almost any amount of stylisation
as long as the light behaves as though the building is there, and refuses the
most photographic effect in the world when it does not.

The collision model is in [`js/effects/obstacles.js`](../js/effects/obstacles.js)
and is available to effects you write yourself.

## Paths and animation

Any shape — closed area or open line — carries an arc-length path. Chase, Fairy
Lights, Comet, Trace and Sparks all walk it, which is why a chase takes as long
crossing a short edge as a long one.

Text can follow it too: set Placement to `path` and the lettering wraps round an
arch or along a roofline.

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
