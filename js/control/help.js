/**
 * In-app help. Kept as a template string rather than a separate page so it is
 * available on a laptop in a dark garden with no network.
 */

export const EFFECT_TEMPLATE = `/**
 * A custom effect.
 *
 * `+'`draw`'+` runs once per target shape, per frame, per projector tab. Coordinates are
 * in world pixels: a virtual frame 1920 wide, matching the camera's aspect ratio.
 * Keep drawing inside ctx.shape and the same code works on a window, a door or
 * the whole house.
 */
export default {
  name: 'My Effect',
  category: 'custom',
  // 'shape' draws once per target; 'global' always covers the whole frame.
  scope: 'shape',
  description: 'Says what it does in the inspector.',

  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#ff7a18' },
    { key: 'speed', type: 'range', label: 'Speed', default: 1, min: 0, max: 8, step: 0.01 },
    { key: 'count', type: 'range', label: 'Count', default: 12, min: 1, max: 60, step: 1 },
  ],

  // Optional. Returns the starting state object; use it for particles and
  // anything else that has to persist between frames.
  init({ rng }) {
    return { seeded: rng() };
  },

  // Optional, and required for anything that carries state between frames.
  // Runs at a fixed 60 steps a second whatever the frame rate, with a constant
  // \`dt\` and no canvas — which is what makes two projectors covering the same
  // wall paint the same animation. Move particles here; paint them in \`draw\`.
  step({ p, shape, t, dt, state, rng, noise }) {
    state.phase = (state.phase || 0) + p.speed * dt;
  },

  draw({ g, p, shape, t, dt, i, n, state, rng, noise }) {
    const { bbox, path, sampler } = shape;

    g.save();
    g.clip(path);

    for (let k = 0; k < p.count; k++) {
      // sampler.at(u) walks the outline at constant speed, wrapping on closed
      // shapes. This is how chases and light strings work.
      const at = sampler.at((t * p.speed * 0.1 + k / p.count) % 1);
      g.fillStyle = p.color;
      g.beginPath();
      g.arc(at.x, at.y, bbox.h * 0.02, 0, Math.PI * 2);
      g.fill();
    }

    g.restore();
  },
};
`;

/**
 * Help, in sections rather than as one long scroll.
 *
 * It had grown to fourteen headings covering everything from where a tripod
 * goes to the signature of `draw`, in one column, in the order the features
 * happened to be written. Somebody trying to remember which key blacks the show
 * out had to scroll past the blackbody-colour explanation to find out, and
 * nobody who was not writing an effect ever needed the second half at all.
 *
 * Five tabs, ordered by when you need them: setting a house up, making it look
 * like something, making it react, the keys, and — last, because most people
 * never open it — the API for writing your own effects. The Code panel's
 * reference button opens that one directly, which is the only reason it was
 * ever near the front.
 */
export const HELP_SECTIONS = [
  {
    id: 'setup',
    label: 'Set up',
    html: `
<h2>Getting a house mapped</h2>
<p>
  The <strong>Start here</strong> panel walks you through all of this and knows how far you have
  got — it ticks off what is done, expands the step you are on, and gives you the button for it.
  What follows is the same sequence in prose.
</p>
<p>
  <strong>No projector, no camera, and it is the middle of the afternoon?</strong> Load the demo
  house — the button is on the empty stage and at the top of <strong>Start here</strong>. It is a
  complete show, with a facade to trace on, windows and a door already traced and tagged, a
  projector already aligned and effects running. None of it is a mock-up: it is the same code a
  real show runs, so anything you work out on it transfers directly. It opens as its own show, so
  it never costs you one you were working on.
</p>
<ol>
  <li><strong>Point a camera at the house</strong> from roughly where people will stand. Setup &rarr; Start camera. A tripod matters more than a good camera — everything below assumes the camera does not move. No camera yet? Setup &rarr; <em>Use a photo of the house</em> lets you do all the tracing on a photograph indoors, which is the slow part.</li>
  <li><strong>Open a projector tab</strong> for each projector, drag each to its own display and press <kbd>F</kbd> for fullscreen.</li>
  <li><strong>Align each projector.</strong> Select it, then <em>Align with camera</em>. It flashes nine dots one at a time and watches where they land. Works best after dark.</li>
  <li><strong>Trace the house</strong> on the camera view with the Area and Path tools. As each shape closes you are asked to name it — clicking a tag both tags <em>and</em> names it, so one click turns a new rectangle into "Window 2" tagged <code>window</code>. That is what lets one effect light every window.</li>
  <li><strong>Add effects</strong> and point them at shapes or tags. <em>Browse&hellip;</em> on a layer shows every effect rendered live on a shape like yours, which beats picking from a list of names you have never seen.</li>
  <li><strong>Save scenes</strong> for the looks you want, and give them hotkeys.</li>
</ol>
<p>
  Everything is stored in this browser. Come back tomorrow, open the same page, reopen the projector
  tabs and it all returns — as long as nothing has been physically moved. If a projector has been
  nudged, use <em>Check for drift</em> rather than guessing.
</p>

<h2>Getting a good alignment</h2>
<ul>
  <li>Do it after dark. The dots have to out-shine everything else in frame.</li>
  <li>Make sure the whole projected area is inside the camera view before starting.</li>
  <li>Turn off the camera's auto-exposure if your browser exposes the control — the app tries, but support varies.</li>
  <li>Don't move the camera afterwards. The shapes you trace are relative to what it can see.</li>
  <li>Point it square-on to the wall if you can — not at the projector. See <em>Squaring up the wall</em> below for why that is worth walking round the garden for.</li>
  <li>An average error under about 5 px is good; over 20 px means something moved mid-run.</li>
  <li>No camera, or too bright? Put a test grid up and drag the four corners with the Corners tool.</li>
</ul>

<h2>When the wall is not flat</h2>
<p>
  The alignment solves a homography, which describes a <em>plane</em>. A flat front elevation is
  exactly right for that. A corner where two or three faces meet is exactly wrong for it — no single
  plane fits, so you can line one face up and the others go out, and re-aligning will not help
  because the problem is the model rather than the fit.
</p>
<p>
  Set <strong>Wall shape</strong> on the projector to a denser grid. The alignment then steps through
  25 or 49 dots instead of 9. The extra dots are not fitting a better plane; they are measuring how
  far the wall departs from one. The homography still does the global mapping, and the error left
  over at each dot — which <em>is</em> the surface bending away — goes into the warp mesh as a
  correction. On a flat wall those residuals come out at nothing and the mesh stays flat, so the only
  cost is the time it takes to step through the dots.
</p>

<h2>Squaring up the wall</h2>
<p>
  The projector being off to one side is handled for you: alignment measures exactly where its
  output lands and the warp undoes it. <strong>The camera being off to one side is not</strong>, and
  it is the one that shows. Everything is drawn in camera coordinates, so a texture the app
  generates — brickwork, a grid, anything that tiles — comes out regular <em>as seen from where the
  camera is standing</em> and nowhere else. Look at it from the pavement and the courses fan out
  across the building, growing towards the near end.
</p>
<p>
  Anything you <em>traced</em> is fine, and always was. A window outline drawn over the picture of a
  window lands on that window from every angle, because both are features of the same wall. Only
  generated geometry inherits the camera's point of view.
</p>
<p>
  The cheapest fix costs nothing: <strong>take the camera square-on to the wall</strong>. It does not
  have to be anywhere near the projector — alignment absorbs that — so a photograph taken from
  straight in front, traced indoors, solves the problem before it starts. Failing that, put the
  camera where people will stand, and the distortion at least works out right from there.
</p>
<p>
  When neither is possible, tell the app the shape of the wall. Press <kbd>W</kbd> or pick
  <strong>Square up</strong> from the toolbar, drag the four handles onto something you know is
  rectangular — a window, the door, a run of brick courses — and type its real width and height into
  Setup. Any units, as long as they match; only the ratio is used. The grid ruled inside the quad is
  what to judge by: get the marking right and its lines lie along the courses.
</p>
<p>
  Applying it moves every traced point, every manual corner quad and every surface-correction mesh
  into the new coordinates at once, so nothing you have already done is lost and no projector needs
  re-aligning. Nothing moves on the building — it moves in the numbers. <em>Remove</em> puts it back.
</p>
<p>
  One thing worth knowing: a photograph of a plane does not determine that plane's shape. Any
  four-sided figure in a picture is some rectangle seen from somewhere, and there is no way to work
  out which without being told. That is the whole reason it asks for two numbers.
</p>

<h2>Lining up with real brickwork</h2>
<p>
  Square the wall up first, or this cannot work: until you do, the courses are a constant size on
  the <em>picture</em>, which means a changing size on the <em>wall</em>, and no offset will hold
  them on the real ones all the way across.
</p>
<p>
  Then set <strong>Brick width</strong> and <strong>Brick height</strong> until the projected
  courses are the same pitch as the real ones, and use <strong>Course offset across</strong> and
  <strong>Course offset up</strong> to slide the whole lattice onto them. The lattice is anchored to
  the show rather than to each shape, so two walls either side of a door agree about where the
  courses are, and one pair of offsets registers all of them at once.
</p>

<h2>Why every tab shows the same thing</h2>
<p>
  Every tab renders the show for itself, from the same project and the same broadcast clock, at
  whatever frame rate it can manage. Which is fine for an effect that is a function of the
  time — a wash, a pulse, anything driven by noise — and was quietly not fine for anything that
  <em>remembers</em>: particles, things that fall, things that spawn at a rate. Those depended on
  how many frames the tab had drawn, so a projector and the control preview drifted apart, and two
  projectors covering the same brickwork painted two different animations onto it.
</p>
<p>
  Three things are pinned down so that cannot happen. <strong>When a layer came on</strong> is
  recorded in the project rather than measured by each tab, so a projector opened halfway through
  the evening no longer believes every one-shot has just been fired. <strong>Randomness</strong> is
  seeded from the simulation step rather than running as a stream, so the same show time draws the
  same numbers however many frames got there first. And <strong>the simulation</strong> runs at a
  fixed sixty steps a second: by any given show time exactly the same number of steps has been
  taken, in every tab.
</p>
<p>
  Writing an effect, that means one rule: anything that changes <code>state</code> belongs in
  <code>step</code>, and <code>draw</code> only paints. An effect with no <code>step</code> is
  treated as a pure function of time and left alone, which is right for most of them.
</p>
<p>
  <strong>The one gap.</strong> A tab opened — or left unrendered — for more than about ten seconds
  cannot honestly replay the steps it missed, so it starts that effect cold and warms up over a
  second and a half. It will be out of phase with the others until that layer next restarts.
  Projector tabs are fullscreen and always drawing, so this is really only the control preview
  after the window has been buried behind something else.
</p>

<h2>Multiple projectors</h2>
<p>
  Every tab shares one project through the browser, so the control tab is the only place you edit.
  Shapes live in camera coordinates, so a shape covered by two projectors is drawn correctly by
  both.
</p>
<p>
  <strong>Where they overlap, both of them draw it, and light adds.</strong> There is no shared
  frame buffer to composite into — there are two lamps pointed at a wall — so the shared band comes
  out at twice the brightness with a hard seam down each side. Nothing in the renderer can prevent
  that. What fixes it is each projector fading its own output out across the band by exactly the
  amount the other fades in: two complementary ramps sum to one and the seam disappears. That is
  <em>Edge blending</em>, and it is applied in linear light, which is the part that has to be right.
</p>
<p>
  You do not have to measure the widths. Both homographies already say precisely where each
  projector lands on the wall, so <strong>Projectors &rarr; Blend overlaps</strong> works them out
  and sets them. Adjust <em>blend gamma</em> afterwards if the seam still reads slightly bright or
  dark — that one depends on the projector's own response curve and cannot be derived from geometry.
</p>

<h2>How the alignment works</h2>
<p>
  A projector aimed at a wall and a camera looking at that same wall are two views of one flat
  surface, and any two views of a plane are related by a single 3&times;3 projective matrix. The
  nine dots give the app nine known correspondences, which is more than enough to solve for that
  matrix. After that it can convert anything you draw on the camera picture into the right projector
  pixels.
</p>
<p>
  The consequence worth knowing: a homography describes a <strong>plane</strong>. A flat front
  elevation is fine. A bay window, a porch roof, a deep reveal or a corner where faces meet sticks
  out of that plane — see below.
</p>

<h2>Storage and backups</h2>
<p>
  The show lives in this browser's local storage: same machine, same browser, same site. Clearing
  site data will delete it. <strong>Export</strong> writes a JSON file — worth doing once the
  alignment is right, because that file is the only copy that survives a wiped browser.
</p>
`,
  },
  {
    id: 'effects',
    label: 'Effects',
    html: `
<h2>Effects that know where the windows are</h2>
<p>
  Most effects are handed a shape and fill it. The ones in the <strong>facade</strong> category are
  handed a shape to move <em>around in</em>, and a list of tags to treat as solid —
  <code>window, door</code> by default. <strong>Bouncing Balls</strong> ricochet off the glass,
  <strong>Serpent</strong> steers round the door rather than across it, and
  <strong>Creeping Vine</strong> spreads over the brickwork and creeps <em>around</em> the frames,
  seeking out bare wall and wrapping every opening it finds. <strong>Ditsy Flowers</strong> and
  <strong>Paisley</strong> paper the wall with a repeating print, cut at the openings the way a
  decorator cuts it rather than hung over the glass.
</p>
<p>
  Point one at the shape tagged <code>wall</code> and it stays on the wall; leave the targets empty
  and it uses the whole frame. Either way the windows are in the way — which is the entire point. A
  ball crossing a facade is a video; a ball that ricochets off the top of the bay window is on the
  house.
</p>

<h2>Paths and animation</h2>
<p>
  Any shape — closed or open — carries an arc-length path. Effects like Chase, Fairy Lights, Comet
  and Trace walk that path at constant speed, so a chase takes as long crossing a short edge as a
  long one. Text can follow it too: set Placement to <em>path</em> and lettering wraps round an arch
  or along a roofline.
</p>
<p>
  <strong>Stagger</strong> on a layer offsets each targeted shape a little further back in time. Point
  one Pulse layer at the <code>window</code> tag, add half a second of stagger, and the windows light
  up in sequence.
</p>

<h2>Modulating parameters</h2>
<p>
  The <code>+</code> beside any numeric parameter binds it to something moving:
</p>
<table>
  <tr><th>LFO</th><td>Sine, triangle, square and friends. Lock to the beat, or set a rate in Hz. <em>Spread per shape</em> phases each target apart.</td></tr>
  <tr><th>Audio</th><td>Follows the microphone. Overall level, or bass/mid/treble separately.</td></tr>
  <tr><th>Random</th><td>Sample-and-hold with optional smoothing. Good for flicker and unease.</td></tr>
  <tr><th>Envelope</th><td>Snaps to a value on every beat and decays. Good for hits.</td></tr>
  <tr><th>Expression</th><td>Any JavaScript expression. <code>base + 0.4 * sin(t * TAU * 0.5 + i)</code></td></tr>
</table>
<p>
  Expressions get <code>t</code>, <code>beat</code>, <code>i</code> (which target), <code>n</code>
  (how many), <code>base</code> (the slider value), <code>level low mid high</code> from audio,
  <code>shape</code>, and the usual maths plus <code>noise</code>, <code>fbm</code>,
  <code>clamp</code>, <code>lerp</code>, <code>smoothstep</code>, <code>saw</code>, <code>tri</code>,
  <code>square</code>, <code>rand</code> and <code>TAU</code>.
</p>

<h2>The look</h2>
<p>
  Everything an effect draws goes through one post-processing stage before it reaches the wall,
  set in the <strong>Look</strong> panel. Bloom spreads light out of bright areas; a filmic curve
  rolls off anything past white so stacked layers keep their shape instead of clipping to flat
  blobs; and exposure, contrast, saturation and temperature grade the whole show at once.
</p>
<p>
  Contrast and gamma matter more here than in ordinary rendering, because a projector cannot emit
  darkness. Whatever grey it puts in the black parts of the frame lands on your brickwork and greys
  the whole wall. Crushing the low end is how the surrounding wall disappears.
</p>
<p>
  Six looks are supplied. <strong>Flat</strong> switches the stage off entirely, which is what you
  want while checking alignment. Each layer also has its own <strong>Softness</strong>, which blurs
  that layer alone — useful when a hard-edged fill reads as a sticker rather than as light.
</p>
`,
  },
  {
    id: 'react',
    label: 'Make it react',
    html: `
<h2>Triggers</h2>
<p>
  A trigger jumps to a scene, optionally plays a sound, holds it for a few seconds, then puts back
  whatever was playing. That last part is what makes it a scare rather than a scene change: the
  ambient loop resumes on its own and the next group gets the same surprise.
</p>
<table>
  <tr><th>Motion</th><td>Something moves in a region of the camera view.</td></tr>
  <tr><th>Key</th><td>You press a key.</td></tr>
  <tr><th>Timer</th><td>On an interval, with randomness so it does not become predictable.</td></tr>
  <tr><th>Manual</th><td>Only when you press the button.</td></tr>
</table>
<h3>Aiming a motion trigger</h3>
<p>
  The camera is pointed at a building you are actively projecting onto, so the fastest-moving thing
  in frame is your own show. <strong>Watch ground your projectors do not light</strong> — the path,
  the drive, the gate. The background model adapts continuously, so a parked car stops registering
  within seconds, and a change covering nearly the whole region is treated as a light switching on
  rather than a person.
</p>
<p>
  The Triggers panel shows a live reading of how much of the region is moving and the level it has
  to beat. That is the only sane way to aim one.
</p>
<p class="muted">
  Sounds are imported into the media library like anything else and play from this tab only —
  projector tabs usually drive displays with no speakers, and four copies a few milliseconds apart
  sounds like a flanger rather than a thunderclap.
</p>

<h2>Building a series of scenes</h2>
<p>
  Switching to a scene <strong>loads</strong> it: the layers take on its values, so the inspector
  shows the numbers you can actually see on the wall. That is what makes 1, 2, 3 that evolve from one
  another editable — go to 1, change a few things, save; go to 2, change a few more, save.
</p>
<p>
  The scene you are in is marked <em>live</em>, and picks up an <strong>edited</strong> chip and a
  <strong>Save</strong> button the moment anything differs from what was stored. Nothing else can
  drift, because going to a scene loads it. Switching away discards unsaved changes &mdash;
  <kbd>Ctrl</kbd>+<kbd>Z</kbd> brings them back.
</p>
<p>
  Triggers and the playlist deliberately do <em>not</em> load: an evening of scares must not slowly
  rewrite the show with whatever the last one happened to look like.
</p>

<h2>Running it every night</h2>
<p>
  <strong>Setup &rarr; Nightly schedule</strong> gives on and off times and which days. It drives
  the same blackout the <kbd>B</kbd> key does, so a scheduled "off" leaves the projectors awake and
  aligned — they simply stop emitting. A window that ends before it starts runs past midnight, and
  the day filter applies to the day it opened: a Friday 20:00–01:00 slot is still going at half past
  midnight on Saturday.
</p>
`,
  },
  {
    id: 'devices',
    label: 'More than one device',
    html: `
<h2>A phone, or a second computer</h2>
<p>
  Everything normally happens inside one browser — the control tab, the projector tabs, and a
  channel between them that never leaves the machine. That is what makes this a static site with
  no account and no server. It also stops at the edge of the laptop.
</p>
<p>
  To get past it, run this in the project folder on the machine driving the projectors:
</p>
<pre>node server.mjs</pre>
<p>
  It prints the addresses to use, and the <strong>Devices</strong> button in the top bar repeats
  them. No install and no dependencies — it is a static file server with a socket on it.
</p>
<p class="muted">
  Open the control page at <code>localhost</code>, not at the network address. Camera access needs
  HTTPS or localhost, so the alignment camera will not start on a LAN address. Everything else is
  happy on either.
</p>

<h2>The remote</h2>
<p>
  <code>remote.html</code> on a phone is the show in your hand: blackout big enough to hit without
  looking, one tap per scene, a button per trigger with its cooldown counting down, transport and
  master. Behind a disclosure it also carries effects on and off, and per-projector blackout with a
  <strong>Flash</strong> button — which is the only practical way to tell three projectors apart
  from the end of the path.
</p>
<p>
  It holds no project and cannot edit one. This tab stays the only place the show is written, so
  there is nothing to reconcile if the phone goes flat halfway through the evening.
</p>

<h2>Drawing on the house</h2>
<p>
  Add the <strong>Live drawing</strong> effect, point it at a wall or a window — or at nothing,
  which covers the whole facade — and open the remote on an iPad, then press <b>Draw</b>. What you draw with the
  pencil is on the wall while the pencil is still moving, pressure and all.
</p>
<p>
  The page shows the area you are drawing into as a dashed box with the rest of the traced facade
  faint around it, so a window you are drawing on has the door and the roofline in the right places
  off its edges. The heel of your hand stops drawing the first time a stylus is seen.
</p>
<p class="muted">
  <strong>Fade after</strong> is the parameter worth knowing about: at zero the ink stays until
  somebody clears it, and above zero every stroke fades over that many seconds — the difference
  between a mural and writing in light. Drawing is not saved with the show; it lives as long as the
  tabs do.
</p>

<h2>A second computer driving projectors</h2>
<p>
  Open <code>projector.html</code> on it from the same address and pick a projector. It receives the
  project, the transport and the clock over the link and renders identically. Alignment and tracing
  stay here, on the machine with the camera.
</p>

<h2>The clock</h2>
<p>
  Show time is a subtraction from a shared wall clock, and two machines do not agree about what time
  it is — a laptop that has been in a shed since last autumn is routinely a second out. A second is
  enough for two projectors on one wall to paint different frames of the same animation, which does
  not look like a timing fault; it looks like one projector running the wrong show.
</p>
<p>
  So each device measures its offset from the server, the way NTP does, and every wall-clock stamp
  that crosses a machine is written and read in that shared time. The <strong>Devices</strong>
  dialog shows the measurement, and so does a projector tab's status overlay (<kbd>I</kbd>). If two
  projectors disagree, that is the number to look at.
</p>

<h2>What does not cross</h2>
<p>
  Media stays in the browser it was imported to, so a video effect on a second computer draws
  nothing and says so. The camera belongs to the tab that opened it. Trigger sounds play from this
  tab only. And <strong>leave this tab visible</strong> — a browser stops rendering a hidden tab,
  and this is what advances the playlist and watches for motion. Buttons on a remote work either
  way; it is the show's own clockwork that stops.
</p>
<p class="muted">
  Anything on your network can join. If that is not what you want — a venue, a shared network —
  start it with <code>node server.mjs --key something</code> and the address becomes
  <code>…/remote.html?key=something</code>. A remote can only ever do the things on its list; it
  cannot edit the show, whatever it sends.
</p>
`,
  },
  {
    id: 'keys',
    label: 'Keyboard',
    html: `
<h2>Keyboard</h2>
<table>
  <tr><th><kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>K</kbd></th><td>Search everything — add an effect, jump to a shape, play a scene, black the show out. Works from any panel and from inside a text field.</td></tr>
  <tr><th><kbd>V</kbd> <kbd>P</kbd> <kbd>L</kbd> <kbd>R</kbd> <kbd>C</kbd></th><td>Select, Area, Path, Rectangle, Corners</td></tr>
  <tr><th><kbd>W</kbd></th><td>Square up the wall</td></tr>
  <tr><th><kbd>Enter</kbd> / <kbd>Esc</kbd></th><td>Finish / cancel the shape being drawn</td></tr>
  <tr><th><kbd>Backspace</kbd></th><td>Remove the last point while drawing; delete the selection otherwise</td></tr>
  <tr><th><kbd>Alt</kbd>-click</th><td>On an edge adds a point, on a point removes it</td></tr>
  <tr><th><kbd>Shift</kbd>-drag</th><td>Line a point up with its neighbour</td></tr>
  <tr><th><kbd>Space</kbd></th><td>Play / pause</td></tr>
  <tr><th><kbd>B</kbd></th><td>Blackout everything</td></tr>
  <tr><th><kbd>1</kbd>–<kbd>9</kbd></th><td>Jump to a scene</td></tr>
  <tr><th>Pinch / <kbd>Ctrl</kbd>-wheel</th><td>Zoom the stage, about the pointer. Two-finger scroll or a middle-button drag pans. Nothing else on the page moves, and nothing about the show changes — it is only where you are looking.</td></tr>
  <tr><th><kbd>0</kbd></th><td>Zoom the stage back to fit</td></tr>
  <tr><th><kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd></th><td>Undo / redo</td></tr>
</table>
<p>In a projector tab: <kbd>F</kbd> fullscreen, <kbd>I</kbd> status, <kbd>T</kbd> cycle test patterns.</p>
<p class="muted">
  Any other single key can be bound to a trigger — the ones above and 1–9 are taken, and the trigger
  inspector says so if you pick one. Anything that can type can press a key, including a doorbell
  wired to a USB button.
</p>
<p>
  Each demo house ships with one to three one-shots on <kbd>X</kbd>, <kbd>G</kbd> and <kbd>F</kbd>,
  chosen to suit the night it is: bats out of the door on Halloween, a rocket over the roof and
  confetti out of the door on New Year's Eve, a catherine wheel and a collapsing log on Bonfire
  Night. Each is a bypassed layer, a scene that switches only that layer on, and a key trigger
  pointed at the scene — copy the pattern for your own.
</p>
`,
  },
  {
    id: 'api',
    label: 'Write an effect',
    html: `
<h2>Writing your own effects</h2>
<p>
  The Code panel compiles a real ES module. Export an object with a
  <code>params</code> schema and a <code>draw(ctx)</code> function; the inspector builds the controls
  from the schema, and every projector tab picks up the change without a reload.
</p>
<h3>What draw receives</h3>
<table>
  <tr><th><code>g</code></th><td>2D context, already positioned in world pixels.</td></tr>
  <tr><th><code>p</code></th><td>Your parameters, with any modulation already applied.</td></tr>
  <tr><th><code>shape</code></th><td><code>{ id, name, tags, closed, points, path, bbox, centroid, sampler }</code>.</td></tr>
  <tr><th><code>t, dt</code></th><td>Show time and frame delta, in seconds. Both stop when the transport is paused.</td></tr>
  <tr><th><code>beat, beatPhase, bpm</code></th><td>Musical time from the transport tempo.</td></tr>
  <tr><th><code>audio</code></th><td><code>{ level, low, mid, high }</code> from the microphone.</td></tr>
  <tr><th><code>i, n</code></th><td>This target's index, and how many targets the layer has.</td></tr>
  <tr><th><code>state</code></th><td>Yours to keep between frames. Survives as long as the layer does.</td></tr>
  <tr><th><code>rng, noise</code></th><td>Seeded generators — identical in every tab, so overlapping projectors agree.</td></tr>
  <tr><th><code>media(id)</code></th><td>A decoded video or image element from the library, or null.</td></tr>
  <tr><th><code>world</code></th><td><code>{ w, h }</code> of the virtual frame.</td></tr>
  <tr><th><code>shapes(tag, excludeId)</code></th><td>Every other shape in the project, for collisions. Filter to one tag, and pass <code>shape.id</code> so you do not collide with the thing you are drawing into.</td></tr>
  <tr><th><code>depth</code></th><td>The building's real surface, if a depth scan has been imported, and <code>null</code> otherwise. See below.</td></tr>
  <tr><th><code>fx</code></th><td>Module-level helper namespace: <code>fx.rgba</code>, <code>fx.glow</code>, <code>fx.mixHex</code>, <code>fx.TAU</code>…</td></tr>
</table>
<p class="muted">
  Never use <code>Math.random()</code> in an effect. Two projectors covering the same wall each run
  their own copy of your code, and unseeded randomness makes them disagree. Use <code>rng()</code>.
</p>

<h3>The building's real surface</h3>
<p>
  Everything above knows the facade as <em>outlines</em> — the shapes you traced. With a depth scan
  imported and placed (Setup &rsaquo; Depth scan), <code>ctx.depth</code> knows its shape: how far
  each point stands out of the wall, which way it faces, and where it is in metres. You ask in the
  world pixels you are drawing in; the answers are metric and belong to the wall.
</p>
<table class="api">
  <tr><th><code>sees(x, y)</code></th><td>Did the scan cover this pixel at all?</td></tr>
  <tr><th><code>reliefAt(x, y)</code></th><td>Metres out of the wall. Negative is set back — glass, a doorway. <code>NaN</code> where nothing was seen.</td></tr>
  <tr><th><code>normalAt(x, y, out)</code></th><td>Unit surface normal: x right, y <strong>down</strong>, z out of the wall. Written into <code>out</code>.</td></tr>
  <tr><th><code>wallAt(x, y, out)</code></th><td>Where this pixel is on the building, in metres from the scan's top-left, with the relief as z.</td></tr>
  <tr><th><code>shadow(x, y, z, lx, ly, lz)</code></th><td>0 lit, 1 shadowed. Wall metres — feed it <code>wallAt</code> and a lamp.</td></tr>
  <tr><th><code>extent</code></th><td><code>{ width, height }</code> of the scan, in metres.</td></tr>
</table>
<p class="muted">
  A lamp <em>above</em> a sill has the <em>smaller</em> y, because y runs down here as it does
  everywhere else in the app. Declare <code>needs: 'depth'</code> on your effect and the layer list
  will explain itself when there is no scan, rather than drawing nothing.
</p>

<h3>Making it look like light</h3>
<p>
  A handful of helpers do most of the work of separating "light falling on brick" from "a shape stuck
  to it", and the built-in effects lean on all of them.
</p>
<table>
  <tr>
    <th><code>fx.blackbodyCss(k)</code></th>
    <td>
      The colour of something at <code>k</code> kelvin. Anything hot — flame, embers, sparks, a
      filament, a lightning channel — has a colour that follows its temperature, so drive it from one
      and let it cool. That is what makes a dying ember go deep red rather than just dim.
      1000&nbsp;K dull embers, 1850&nbsp;K candle, 2400&nbsp;K bright flame, 9000&nbsp;K lightning.
    </td>
  </tr>
  <tr>
    <th><code>fx.waterAbsorb(hex, m)</code></th>
    <td>
      What is left of a colour after <code>m</code> metres of water, by Beer&ndash;Lambert. Water
      absorbs red about thirty times faster than blue, so ten metres of it takes ninety-five per cent
      of the red and a tenth of the blue &mdash; which is the whole reason the deep end is blue, and
      why depth reads off the colour rather than only off the brightness. That matters on a house,
      where you cannot make the wall any darker. <code>fx.waterTransmission(m)</code> is the same
      thing as three bare multipliers, for a per-pixel loop.
    </td>
  </tr>
  <tr>
    <th><code>fx.mixLinear(a, b, t)</code></th>
    <td>
      Blend two colours through linear light instead of through sRGB. An sRGB lerp from yellow to red
      dips through a muddy brown; this one does not. <code>fx.rampAt(stops, t)</code> is the
      multi-stop version.
    </td>
  </tr>
  <tr>
    <th><code>fx.ensureSurfaces(...)</code></th>
    <td>
      Collision against the house. <code>ctx.shapes()</code> gives you the rest of the scene;
      this collapses each shape to the top surface it presents, and <code>sweepLanding</code>,
      <code>settle</code>, <code>shedSlabs</code> and <code>drawDrift</code> accumulate material on
      it, let it slump to a natural angle, and break it off when it gets too deep. Snow uses the
      whole set to settle on your sills and slide off them.
    </td>
  </tr>
  <tr>
    <th><code>fx.ensureField(state, key, w, h)</code></th>
    <td>
      A low-resolution density grid, for anything volumetric. Write a density per cell, then
      <code>blit()</code> it into the shape — the browser's bilinear upscale turns the grid into a
      continuous volume. Fire, smoke and fog all work this way; it looks far better than a few hundred
      additive circles, and it is faster too. <code>fx.curlNoise</code> gives you a divergence-free
      velocity to advect it with, which is where the billowing comes from.
    </td>
  </tr>
  <tr>
    <th><code>fx.deflect(...)</code></th>
    <td>
      Collision against the <em>openings</em> rather than the ledges, for anything that travels
      across the facade. <code>fx.collectObstacles</code> resolves a tag list like
      <code>"window, door"</code> into shapes to treat as solid; <code>deflect</code> bounces a
      mover off one, or keeps it inside the shape you are drawing into.
      <code>fx.nearestSurface</code> is what lets growth <em>follow</em> a window frame rather than
      merely avoid it. Bouncing Balls, Serpent and Creeping Vine are built on these.
    </td>
  </tr>
  <tr>
    <th><code>fx.offscreen(w, h)</code></th>
    <td>
      A scratch canvas, for effects that only ever add — growth, trails, accretion. Stroke into it
      once and blit it thereafter, rather than redrawing the whole history every frame. Note it is
      a plain <code>&lt;canvas&gt;</code> and not an <code>OffscreenCanvas</code>: on the main
      thread, blitting from the latter is about thirty times slower.
    </td>
  </tr>
</table>
<p class="muted">
  One performance trap worth knowing: never set <code>g.filter</code> or <code>g.shadowBlur</code>
  per particle or per glyph. Every such draw becomes its own composited layer — a line of glowing
  text measured at 19.6&nbsp;ms a frame that way, against 0.16&nbsp;ms haloed with plain strokes.
  Bake a handful of pre-softened sprites once and stamp them with <code>drawImage</code>, or fake
  the halo and let the bloom in the post stage do the real work. Open
  <code>test/bench.html</code> to measure your own.
</p>
`,
  },
];

/** One section's markup, or the first if the id is unknown. */
export function helpSection(id) {
  return HELP_SECTIONS.find((s) => s.id === id) || HELP_SECTIONS[0];
}
