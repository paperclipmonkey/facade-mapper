/**
 * The renderer's clock, and the promise it makes to every tab.
 *
 * One sentence holds this whole file together: **what the show is doing is a
 * function of show time, and of nothing else.** Not of how fast a tab is
 * painting, not of when it opened, not of whether somebody paused it and went
 * to get a ladder. Two projectors overlapping on one wall have to paint the
 * same animation into the shared band, and there is nobody to ask.
 *
 * Everything below is that promise, stated as something checkable — because
 * every way of breaking it is silent. A layer that stops stepping still draws;
 * it draws the *same frame* for ever, which on a wall reads as "the fish have
 * stopped" and in a screenshot reads as fine. A layer that restarts its
 * simulation looks like a layer that was just switched on. A tab that is
 * quietly ten seconds behind looks perfect until you stand where you can see
 * both projectors at once.
 *
 * The three faults these were written for, all found on a real projector:
 *
 *   - the frame's catch-up allowance was taken by whichever layer asked first,
 *     so with four layers behind, three of them got *zero* steps per frame for
 *     as long as it lasted, went undrawn because they were behind, and were
 *     then cold-started ten seconds later. Stopping, and then jumping.
 *   - the show clock froze on pause but the wall clock it is compared against
 *     did not, so every layer's switch-on time slid a second per second and the
 *     renderer read the slide as the layer being re-triggered — sixteen times a
 *     second, for as long as the show was paused.
 *   - a simulation cannot be run backwards, so seeking to an earlier point left
 *     every stateful layer sitting still until the show caught up with it.
 *
 *   node test/renderer.test.mjs
 */

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

/* ------------------------------------------------------------------ *
 * A controllable wall clock, installed before anything reads it
 *
 * `core/time.js` samples `Date.now()` at import, so the stub has to be in
 * place first — hence the dynamic imports. Every test below moves time by
 * hand, which is the only way to ask what happens across a five second pause
 * without waiting five seconds.
 * ------------------------------------------------------------------ */

let wallMs = 1_700_000_000_000;
Date.now = () => wallMs;
/** Advance the wall clock, in seconds. */
const passes = (seconds) => { wallMs += seconds * 1000; };

const { createClock } = await import('../js/core/clock.js');
const { createWorldRenderer } = await import('../js/render/worldRenderer.js');
const { createProject } = await import('../js/core/state.js');
const { getEffect } = await import('../js/effects/registry.js');

/* ------------------------------------------------------------------ *
 * Enough canvas for the effects to draw into
 * ------------------------------------------------------------------ */

globalThis.Path2D = class {
  moveTo() {} lineTo() {} rect() {} closePath() {} arc() {} ellipse() {}
  addPath() {} quadraticCurveTo() {} bezierCurveTo() {}
};

function context2d() {
  const g = {
    canvas: { width: 1920, height: 1080 },
    fillStyle: '', strokeStyle: '', globalAlpha: 1, globalCompositeOperation: 'source-over',
    lineWidth: 1, lineCap: '', lineJoin: '', font: '', filter: 'none',
    shadowBlur: 0, shadowColor: '', lineDashOffset: 0, textAlign: '', textBaseline: '',
    save() {}, restore() {}, clip() {}, rotate() {}, scale() {}, translate() {},
    setTransform() {}, resetTransform() {}, setLineDash() {}, rect() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {},
    bezierCurveTo() {}, arc() {}, ellipse() {}, fill() {}, stroke() {},
    fillRect() {}, strokeRect() {}, clearRect() {}, fillText() {}, strokeText() {},
    measureText: (s) => ({ width: String(s).length * 8 }),
    drawImage() {}, putImageData() {},
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w | 0) * Math.max(1, h | 0) * 4) }),
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w | 0) * Math.max(1, h | 0) * 4) }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createPattern: () => null,
  };
  return g;
}
globalThis.document = {
  createElement: () => ({ width: 1, height: 1, getContext: () => context2d() }),
};

/* ------------------------------------------------------------------ *
 * A show, and a tab rendering it
 * ------------------------------------------------------------------ */

const WALL = [{ x: 0.1, y: 0.2 }, { x: 0.9, y: 0.2 }, { x: 0.9, y: 0.85 }, { x: 0.1, y: 0.85 }];

/** A project with `count` stateful layers, all pointed at one traced wall. */
function makeShow(count = 1, params = {}) {
  const project = createProject();
  project.shapes = [{ id: 'wall', name: 'Wall', tags: ['wall'], closed: true, points: WALL }];
  project.layers = Array.from({ length: count }, (_, i) => ({
    id: `L${i}`, name: `Shoal ${i}`, effect: 'shoal', enabled: true, order: i,
    target: { mode: 'tag', tag: 'wall' }, opacity: 1,
    params: { count: 16, startle: 0, ...params },
  }));
  return project;
}

/**
 * One tab: its own clock, its own renderer, its own idea of how fast it is
 * painting. Frames are asked for explicitly, so a slow tab is modelled by
 * asking for fewer of them over the same stretch of wall-clock time.
 */
function openTab(project) {
  const clock = createClock();
  const renderer = createWorldRenderer({});
  const g = context2d();
  clock.play();
  return {
    clock,
    renderer,
    /** Render one frame at whatever the clock now says. */
    frame() {
      const time = clock.tick();
      renderer.render(g, {
        project,
        time,
        audio: { level: 0, low: 0, mid: 0, high: 0 },
        region: { x: 0, y: 0, w: 1, h: 1 },
        pixelSize: { w: 1920, h: 1080 },
      });
      return time;
    },
    /** Run `seconds` of show at `fps`, advancing the wall clock as it goes. */
    run(seconds, fps = 60) {
      const frames = Math.round(seconds * fps);
      for (let i = 0; i < frames; i++) {
        passes(1 / fps);
        this.frame();
      }
    },
  };
}

/**
 * Watch an effect's `step` without changing what it does.
 *
 * `cost` busy-waits, which is the only way to make a step expensive enough for
 * the frame allowance to matter — the whole point of the allowance is that it
 * is a wall-clock budget, so a test of it has to spend wall-clock time.
 */
function watch(effectId, cost = 0) {
  const effect = getEffect(effectId);
  const original = effect.step;
  const ages = new Map();
  const steps = new Map();
  let calls = 0;
  effect.step = function step(ctx) {
    calls += 1;
    const id = ctx.layer.id;
    ages.set(id, ctx.age);
    steps.set(id, (steps.get(id) || 0) + 1);
    if (cost > 0) {
      const until = performance.now() + cost;
      while (performance.now() < until);
    }
    return original.call(this, ctx);
  };
  return {
    ages,
    steps,
    get calls() { return calls; },
    reset() { calls = 0; steps.clear(); },
    restore() { effect.step = original; },
  };
}

const spread = (map) => {
  const values = [...map.values()];
  return values.length ? Math.max(...values) - Math.min(...values) : 0;
};

/* ------------------------------------------------------------------ *
 * The simulation tracks show time, whatever the tab is doing
 * ------------------------------------------------------------------ */

console.log('— the simulation is a function of show time —');

{
  const probe = watch('shoal');
  const project = makeShow(1);

  const fast = openTab(project);
  fast.run(10, 60);
  const fastAge = probe.ages.get('L0');
  const fastSteps = probe.steps.get('L0');

  probe.reset();
  const slow = openTab(project);
  slow.run(10, 12);
  const slowAge = probe.ages.get('L0');
  const slowSteps = probe.steps.get('L0');
  probe.restore();

  /**
   * Both tabs ran ten seconds of show. One painted six hundred frames and the
   * other a hundred and twenty, and the simulation must not be able to tell.
   */
  ok('a 60fps tab and a 12fps tab take the same number of steps',
    Math.abs(fastSteps - slowSteps) <= 1, `${fastSteps} against ${slowSteps}`);
  ok('and arrive at the same show time',
    Math.abs(fastAge - slowAge) < 0.05, `${fastAge.toFixed(3)} s against ${slowAge.toFixed(3)} s`);
  ok('which is 60 steps for every second of it',
    Math.abs(fastSteps - fastAge * 60) < 2, `${fastSteps} steps at ${fastAge.toFixed(2)} s`);
}

/* ------------------------------------------------------------------ *
 * Catching up, and the way it used to starve everything but one layer
 * ------------------------------------------------------------------ */

console.log('\n— catching up —');

{
  const probe = watch('shoal');
  const project = makeShow(1);
  const tab = openTab(project);
  tab.run(2, 60);

  // The tab is blocked for three seconds: a long paint, a garbage collection,
  // the window being dragged to another display.
  passes(3);
  const before = probe.steps.get('L0');
  tab.run(2, 60);
  probe.restore();

  const after = probe.steps.get('L0');
  ok('a three second hitch is made up, not lost',
    after - before > 60 * 4.5, `${after - before} steps over ${(3 + 2).toFixed(0)} s of show`);
  ok('and the layer lands exactly where show time says',
    Math.abs(probe.ages.get('L0') - 7) < 0.1, `${probe.ages.get('L0').toFixed(2)} s`);
}

{
  /**
   * The one this file exists for.
   *
   * Four stateful layers, all a long way behind — a projector tab opened into
   * a show that has been running, or one that came back from being throttled
   * in the background. The allowance is a wall-clock budget for the whole
   * frame, and layers are walked in order, so "shared" used to mean "taken by
   * layer one". Measured before the fix: layer one caught up at sixty times
   * real speed and layers two, three and four took **zero** steps per frame,
   * for four hundred frames, until the stall detector cold-started them.
   *
   * On the wall that is three quarters of the show stopping dead and then
   * jumping. So: every layer must move, every layer must keep moving, and the
   * gap must actually close.
   */
  const probe = watch('shoal', 0.15);
  const project = makeShow(4);
  const tab = openTab(project);
  tab.run(2, 60);

  // Half an hour of show goes past without a frame being painted.
  passes(1800);
  probe.reset();
  tab.run(4, 60);
  probe.restore();

  const moved = [...probe.steps.values()];
  /**
   * Six hundred is ten seconds of show, and the threshold is machine-independent
   * on purpose: each step here spends its time in a busy-wait, so how many fit
   * in a three millisecond slice is a property of the slice rather than of the
   * hardware. With the allowance shared out, each layer manages a few thousand;
   * with it taken by whoever asked first, the other three managed eight.
   */
  ok('every layer behind gets steps, not just the first in the list',
    moved.length === 4 && moved.every((n) => n > 600),
    `steps per layer: ${[...probe.steps.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}`);

  const least = Math.min(...moved);
  const most = Math.max(...moved);
  ok('and they are within sight of each other rather than one taking the lot',
    least > most / 3, `slowest ${least}, fastest ${most}`);

  const behind = tab.renderer.catchingUp();
  ok('so the backlog shrinks rather than growing',
    behind.behind < 1800, `${behind.behind.toFixed(0)} s still owed of 1800`);
}

{
  /**
   * And the ordinary frame is untouched by any of it: nothing is behind, so
   * nothing queues, nothing claims a slice, and no clock is read.
   */
  const probe = watch('shoal');
  const project = makeShow(6);
  const tab = openTab(project);
  tab.run(3, 60);
  probe.restore();

  ok('with nothing behind, every layer is exactly in step',
    spread(probe.steps) === 0, `${[...new Set(probe.steps.values())].join(', ')} steps each`);
}

/* ------------------------------------------------------------------ *
 * Pause, resume and seek
 * ------------------------------------------------------------------ */

console.log('\n— the transport —');

{
  /**
   * A paused show is a still. Not "almost still" — the layer must take no
   * steps at all, and above all must not conclude that it has been switched on
   * again, which is what a switch-on time measured against a clock that was
   * still running used to make it do.
   */
  const probe = watch('shoal');
  const project = makeShow(1);
  // A layer with a switch-on time, which is what firing a scene or flipping a
  // layer records — and the case that broke, since a layer that has always
  // been on has no stamp to slide.
  const tab = openTab(project);
  tab.run(3, 60);
  project.layers[0].onAt = Date.now() - 1000;
  tab.run(3, 60);

  const atPause = probe.steps.get('L0');
  const ageAtPause = probe.ages.get('L0');
  tab.clock.pause();

  for (let i = 0; i < 300; i++) { passes(1 / 60); tab.frame(); }

  ok('a paused show takes no simulation steps at all',
    probe.steps.get('L0') === atPause,
    `${probe.steps.get('L0') - atPause} steps over five paused seconds`);
  ok('and nothing on it is left waiting to catch up',
    tab.renderer.catchingUp().layers === 0,
    JSON.stringify(tab.renderer.catchingUp()));

  /**
   * And resuming carries on rather than starting again. The layer is older
   * than it was, never younger, and it did not go back to zero.
   */
  tab.clock.play();
  tab.run(2, 60);
  const ageAfter = probe.ages.get('L0');
  probe.restore();

  ok('and resuming continues the same simulation',
    ageAfter > ageAtPause, `${ageAtPause.toFixed(2)} s before, ${ageAfter.toFixed(2)} s after`);
  ok('rather than restarting it from zero',
    ageAfter > 2.5, `${ageAfter.toFixed(2)} s old`);
}

{
  /**
   * Switching a layer on again *is* a re-trigger, and must still restart it —
   * that is what makes pressing the same key twice replay a burst. The fix
   * above narrows what counts as one; it must not remove it.
   */
  const probe = watch('shoal');
  const project = makeShow(1);
  project.layers[0].onAt = Date.now();
  const tab = openTab(project);
  tab.run(4, 60);
  const before = probe.ages.get('L0');

  project.layers[0].onAt = Date.now();   // pressed again
  tab.run(1, 60);
  const after = probe.ages.get('L0');
  probe.restore();

  ok('switching a layer on again does restart it',
    before > 3.5 && after < 1.5, `${before.toFixed(2)} s, then ${after.toFixed(2)} s`);
}

{
  /**
   * Seeking backwards. A step function cannot be run in reverse, so the only
   * honest answer is to replay it — and the wrong answer, sitting still until
   * show time catches back up, is indistinguishable on the wall from the
   * effect being broken.
   */
  const probe = watch('shoal');
  const project = makeShow(1);
  const tab = openTab(project);
  tab.run(20, 60);

  // Seeking is a new start epoch: show time is dragged back to four seconds.
  tab.clock.setTransport({ startEpoch: Date.now() - 4000 });
  probe.reset();
  tab.run(2, 60);
  probe.restore();

  ok('after seeking backwards the simulation runs again',
    (probe.steps.get('L0') || 0) > 60,
    `${probe.steps.get('L0') || 0} steps in the two seconds after a 16 s rewind`);
  ok('and it is running from the show time seeked to',
    probe.ages.get('L0') < 8, `${probe.ages.get('L0').toFixed(2)} s`);
}

/* ------------------------------------------------------------------ *
 * Two tabs, one wall
 * ------------------------------------------------------------------ */

console.log('\n— two projectors agree —');

{
  /**
   * The end the rest of this is a means to. Two tabs, one painting five times
   * as often as the other, one of them opened late — and the same show on the
   * wall at the same instant.
   */
  const probe = watch('shoal');
  const project = makeShow(1);

  const early = openTab(project);
  early.run(6, 60);

  // A second projector is plugged in six seconds in and has to catch up.
  const late = openTab(project);

  probe.reset();
  for (let i = 0; i < 240; i++) {
    passes(1 / 60);
    early.frame();
    if (i % 5 === 0) late.frame();      // a much slower tab
  }
  const earlyAge = probe.ages.get('L0');
  probe.restore();

  ok('a tab that joined late is not left behind',
    early.renderer.catchingUp().layers === 0 && late.renderer.catchingUp().layers === 0,
    `${JSON.stringify(early.renderer.catchingUp())} / ${JSON.stringify(late.renderer.catchingUp())}`);
  ok('and both are at the show time the clock says',
    Math.abs(earlyAge - 10) < 0.1, `${earlyAge.toFixed(2)} s`);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
