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

export const HELP_HTML = `
<h2>Getting a house mapped</h2>
<ol>
  <li><strong>Point a camera at the house</strong> from roughly where people will stand. Setup &rarr; Start camera. A tripod matters more than a good camera — everything below assumes the camera does not move.</li>
  <li><strong>Open a projector tab</strong> for each projector, drag each to its own display and press <kbd>F</kbd> for fullscreen.</li>
  <li><strong>Align each projector.</strong> Select it, then <em>Align with camera</em>. It flashes nine dots one at a time and watches where they land. Works best after dark.</li>
  <li><strong>Trace the house</strong> on the camera view with the Area and Path tools. Tag things (<code>window</code>, <code>door</code>, <code>roof</code>) so effects can target groups.</li>
  <li><strong>Add effects</strong> and point them at shapes or tags.</li>
  <li><strong>Save scenes</strong> for the looks you want, and give them hotkeys.</li>
</ol>
<p>
  Everything is stored in this browser. Come back tomorrow, open the same page, reopen the projector
  tabs and it all returns — as long as nothing has been physically moved. If a projector has been
  nudged, use <em>Check for drift</em> rather than guessing.
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
  The consequence worth knowing: <strong>it assumes a flat surface</strong>. A flat front elevation
  is fine. A bay window, a porch roof or a deep reveal sticks out of that plane and will land
  slightly off. Fix those with the per-projector <em>Surface warp</em> grid, or give the protruding
  part its own projector.
</p>

<h2>Multiple projectors</h2>
<p>
  Every tab shares one project through the browser, so the control tab is the only place you edit.
  Shapes live in camera coordinates, so a shape covered by two projectors is drawn correctly by
  both. Where two projectors overlap on the same wall, use <em>Edge blending</em> on both to fade
  the overlapping edges into each other.
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
  <tr><th><code>fx</code></th><td>Module-level helper namespace: <code>fx.rgba</code>, <code>fx.glow</code>, <code>fx.mixHex</code>, <code>fx.TAU</code>…</td></tr>
</table>
<p class="muted">
  Never use <code>Math.random()</code> in an effect. Two projectors covering the same wall each run
  their own copy of your code, and unseeded randomness makes them disagree. Use <code>rng()</code>.
</p>

<h2>Keyboard</h2>
<table>
  <tr><th><kbd>V</kbd> <kbd>P</kbd> <kbd>L</kbd> <kbd>R</kbd> <kbd>C</kbd></th><td>Select, Area, Path, Rectangle, Corners</td></tr>
  <tr><th><kbd>Enter</kbd> / <kbd>Esc</kbd></th><td>Finish / cancel the shape being drawn</td></tr>
  <tr><th><kbd>Backspace</kbd></th><td>Remove the last point while drawing; delete the selection otherwise</td></tr>
  <tr><th><kbd>Alt</kbd>-click</th><td>On an edge adds a point, on a point removes it</td></tr>
  <tr><th><kbd>Shift</kbd>-drag</th><td>Line a point up with its neighbour</td></tr>
  <tr><th><kbd>Space</kbd></th><td>Play / pause</td></tr>
  <tr><th><kbd>B</kbd></th><td>Blackout everything</td></tr>
  <tr><th><kbd>1</kbd>–<kbd>9</kbd></th><td>Jump to a scene</td></tr>
  <tr><th><kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd></th><td>Undo / redo</td></tr>
</table>
<p>In a projector tab: <kbd>F</kbd> fullscreen, <kbd>I</kbd> status, <kbd>T</kbd> cycle test patterns.</p>

<h2>Getting a good alignment</h2>
<ul>
  <li>Do it after dark. The dots have to out-shine everything else in frame.</li>
  <li>Make sure the whole projected area is inside the camera view before starting.</li>
  <li>Turn off the camera's auto-exposure if your browser exposes the control — the app tries, but support varies.</li>
  <li>Don't move the camera afterwards. The shapes you trace are in camera coordinates.</li>
  <li>An average error under about 5 px is good; over 20 px means something moved mid-run.</li>
  <li>No camera, or too bright? Put a test grid up and drag the four corners with the Corners tool.</li>
</ul>

<h2>Storage and backups</h2>
<p>
  The show lives in this browser's local storage: same machine, same browser, same site. Clearing
  site data will delete it. <strong>Export</strong> writes a JSON file — worth doing once the
  alignment is right, because that file is the only copy that survives a wiped browser.
</p>
`;
