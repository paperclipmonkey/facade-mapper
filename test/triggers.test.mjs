/**
 * The trigger runtime: what happens between somebody walking up the path and
 * the house going back to what it was doing.
 *
 * This is the piece with the least margin for error in the whole app and it had
 * no tests at all. Everything it does happens once, in the dark, in front of
 * people, and every failure mode is silent: a scare that does not end leaves
 * the house stuck in it for the rest of the evening, a timer pointing at a
 * deleted scene re-enters the firing path on every frame for ever, and a hook
 * that does not fire leaves the gutter red and the fog machine running with
 * nothing on screen to say so.
 *
 * All of it is driven off `Date.now()`, so the clock is replaced with one this
 * file moves by hand. Nothing here sleeps.
 *
 *   node test/triggers.test.mjs
 */

import { createProject, createScene, createTrigger } from '../js/core/state.js';
import { createTriggerRuntime } from '../js/control/triggers.js';

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

/* ------------------------------------------------------------------ *
 * A clock that only moves when this file says so
 * ------------------------------------------------------------------ */

let clock = Date.UTC(2026, 9, 31, 19, 0, 0);
Date.now = () => clock;
/** Seconds of wall time, which is what a hold and a cooldown are measured in. */
const advance = (seconds) => {
  clock += seconds * 1000;
};

/**
 * The control tab, reduced to the one thing the runtime touches.
 *
 * It reads `app.project` and nothing else — which is the property that lets the
 * runtime be tested at all, and is worth keeping.
 */
function show({ triggers = [], activeScene = 'amb' } = {}) {
  const project = createProject('test');
  project.scenes = [
    createScene({ id: 'amb', name: 'Ambient', fade: 0.6 }),
    createScene({ id: 'scare', name: 'Scare' }),
    createScene({ id: 'other', name: 'Other' }),
  ];
  project.show.activeScene = activeScene;
  project.triggers = triggers;
  return { project };
}

/** Hooks are fire-and-forget, so a check has to let the microtask queue drain. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/* ------------------------------------------------------------------ *
 * A scare, and the end of one
 * ------------------------------------------------------------------ */

console.log('— a scare holds, and then puts back what was playing —');
{
  const trigger = createTrigger({ id: 'T', source: 'manual', sceneId: 'scare', hold: 6 });
  const app = show({ triggers: [trigger] });
  const runtime = createTriggerRuntime({ app });

  ok('firing it returns true', runtime.fire(trigger) === true);
  ok('and the scare is up', app.project.show.activeScene === 'scare');
  ok('with the ambient loop remembered', runtime.holding?.restoreTo === 'amb');

  advance(3);
  ok('nothing happens half way through the hold', runtime.tick() === false);
  ok('and the scare is still up', app.project.show.activeScene === 'scare');

  advance(4);
  ok('the hold expiring is a change', runtime.tick() === true);
  ok('and the ambient loop is back', app.project.show.activeScene === 'amb');
  ok('with nothing left holding', runtime.holding === null);
}

{
  // The other ending: there was no scene up when the trigger fired, so there is
  // nothing to go back *to* and the authored layer state has to return instead.
  const trigger = createTrigger({ id: 'T', source: 'manual', sceneId: 'scare', hold: 2 });
  const app = show({ triggers: [trigger], activeScene: null });
  const runtime = createTriggerRuntime({ app });

  runtime.fire(trigger);
  advance(3);
  runtime.tick();
  ok('a scare fired over no scene clears the scene rather than restoring one',
    app.project.show.activeScene === null);
  ok('and stamps the change so every tab fades in step',
    app.project.show.sceneChangeAt > 0);
}

{
  const trigger = createTrigger({ id: 'T', source: 'manual', sceneId: 'gone', hold: 2 });
  const app = show({ triggers: [trigger] });
  const runtime = createTriggerRuntime({ app });
  ok('a trigger pointing at a scene somebody deleted refuses to fire',
    runtime.fire(trigger) === false);
  ok('and leaves the show alone', app.project.show.activeScene === 'amb');
}

{
  const trigger = createTrigger({ id: 'T', source: 'manual', sceneId: 'scare', hold: 6 });
  const app = show({ triggers: [trigger] });
  const runtime = createTriggerRuntime({ app });
  runtime.fire(trigger);
  runtime.cancelHold();
  advance(10);
  ok('a cancelled hold never restores', runtime.tick() === false);
  ok('and the scene it left up stays up', app.project.show.activeScene === 'scare');
}

/* ------------------------------------------------------------------ *
 * One scare inside another
 * ------------------------------------------------------------------ */

console.log('\n— a second scare during the first —');
{
  const first = createTrigger({ id: 'A', source: 'manual', sceneId: 'scare', hold: 6 });
  const second = createTrigger({ id: 'B', source: 'manual', sceneId: 'other', hold: 6 });
  const app = show({ triggers: [first, second] });
  const runtime = createTriggerRuntime({ app });

  runtime.fire(first);
  advance(1);
  runtime.fire(second);
  ok('the second scare is up', app.project.show.activeScene === 'other');
  ok('and it still goes back to the ambient loop, not to the first scare',
    runtime.holding?.restoreTo === 'amb');

  advance(7);
  runtime.tick();
  ok('which is where it ends up', app.project.show.activeScene === 'amb');
}

/* ------------------------------------------------------------------ *
 * The hooks
 * ------------------------------------------------------------------ */

console.log('\n— the HTTP hooks, which are the rest of the house —');
{
  globalThis.location = { protocol: 'http:' };
  const sent = [];
  globalThis.fetch = (url) => {
    sent.push(String(url));
    return Promise.resolve({ status: 200 });
  };

  const hooked = (id, extra) => createTrigger({
    id,
    source: 'manual',
    hold: 6,
    http: {
      before: { url: `http://wled.local/${id}-on`, method: 'GET', body: '', mode: 'no-cors' },
      after: { url: `http://wled.local/${id}-off`, method: 'GET', body: '', mode: 'no-cors' },
    },
    ...extra,
  });

  {
    const trigger = hooked('h1', { sceneId: 'scare' });
    const app = show({ triggers: [trigger] });
    const runtime = createTriggerRuntime({ app });
    runtime.fire(trigger);
    await settle();
    ok('firing sends the "before" hook', sent.includes('http://wled.local/h1-on'));
    ok('and not the "after" one yet', !sent.includes('http://wled.local/h1-off'));

    advance(7);
    runtime.tick();
    await settle();
    ok('the hold expiring sends "after"', sent.includes('http://wled.local/h1-off'));
  }

  {
    /**
     * The one that was missing.
     *
     * A trigger with no hold means "go there and stay", so firing one during
     * somebody else's scare ends that scare — and the scare's `after` hook is
     * not about the scene. It is what puts the gutter back, and the moment
     * that would have fired it never arrives. Without this the rest of the
     * house stayed in the scare state for the remainder of the evening.
     */
    sent.length = 0;
    const scare = hooked('h2', { sceneId: 'scare' });
    const stay = hooked('h3', { sceneId: 'other', hold: 0 });
    const app = show({ triggers: [scare, stay] });
    const runtime = createTriggerRuntime({ app });

    runtime.fire(scare);
    advance(1);
    runtime.fire(stay);
    await settle();

    ok('cutting a hold short still sends the outgoing trigger its "after"',
      sent.includes('http://wled.local/h2-off'), sent.join(' '));
    ok('and the incoming one its "before"', sent.includes('http://wled.local/h3-on'));
    ok('with nothing left holding', runtime.holding === null);
  }

  {
    // Re-firing the same trigger is a scare being extended. Sending its own
    // reset in the middle of that would be an off and an on nobody asked for.
    sent.length = 0;
    const trigger = hooked('h4', { sceneId: 'scare' });
    const app = show({ triggers: [trigger] });
    const runtime = createTriggerRuntime({ app });

    runtime.fire(trigger);
    advance(1);
    runtime.fire(trigger);
    await settle();
    ok('a trigger re-firing during its own hold does not send its "after"',
      !sent.includes('http://wled.local/h4-off'), sent.join(' '));
  }

  {
    // A hook with no url is not a hook, and must not become a request for the
    // page's own address.
    sent.length = 0;
    const trigger = createTrigger({ id: 'h5', source: 'manual', sceneId: 'scare', hold: 1 });
    const app = show({ triggers: [trigger] });
    const runtime = createTriggerRuntime({ app });
    runtime.fire(trigger);
    advance(2);
    runtime.tick();
    await settle();
    ok('a trigger with no hooks configured sends nothing', sent.length === 0, sent.join(' '));
  }
}

/* ------------------------------------------------------------------ *
 * Timers
 * ------------------------------------------------------------------ */

console.log('\n— a timed scare —');
{
  const trigger = createTrigger({
    id: 'T', source: 'timer', sceneId: 'scare', hold: 2, every: 30, jitter: 0,
  });
  const app = show({ triggers: [trigger] });
  const runtime = createTriggerRuntime({ app });

  ok('the first tick only schedules it', runtime.tick() === false);
  ok('and does not fire it', app.project.show.activeScene === 'amb');

  advance(10);
  ok('nor does one before it is due', runtime.tick() === false);

  advance(25);
  ok('it fires once it is due', runtime.tick() === true);
  ok('and the scare is up', app.project.show.activeScene === 'scare');

  advance(3);
  runtime.tick();
  ok('then it ends like any other', app.project.show.activeScene === 'amb');

  advance(1);
  ok('and does not fire straight back', runtime.tick() === false);
}

{
  /**
   * A timer pointing at a scene somebody deleted.
   *
   * `fire` refuses, and if the due time were left in the past the runtime would
   * re-enter it on every frame, for ever, building a map of the project's
   * scenes each time. Nothing on screen would say so.
   */
  const trigger = createTrigger({
    id: 'T', source: 'timer', sceneId: 'gone', hold: 2, every: 10, jitter: 0,
  });
  const app = show({ triggers: [trigger] });
  const runtime = createTriggerRuntime({ app });

  runtime.tick();
  advance(11);
  let fired = 0;
  const onFired = () => { fired++; };
  const watched = createTriggerRuntime({ app, onFired });
  watched.tick();
  advance(11);
  watched.tick();
  ok('a timer aimed at a missing scene never fires', fired === 0);

  // And the original runtime does not report a change on every frame either.
  const changes = [runtime.tick(), runtime.tick(), runtime.tick()];
  ok('nor does it report a change on every frame', changes.every((c) => c === false));
}

{
  /**
   * An interval below the floor.
   *
   * `every` is minutes-ish in spirit and seconds in fact, and a project that
   * has been hand-edited — or a slider that will one day go lower — can ask for
   * one a second. The runtime raises it to five, and the point of the floor is
   * that a scare firing continuously is not a scare.
   */
  const trigger = createTrigger({
    id: 'T', source: 'timer', sceneId: 'scare', hold: 0, every: 1, jitter: 0,
  });
  const app = show({ triggers: [trigger] });
  const runtime = createTriggerRuntime({ app });
  let fired = 0;
  const counted = createTriggerRuntime({ app, onFired: () => { fired++; } });

  counted.tick();
  // Twenty seconds, a frame at a time, against a floor of five.
  for (let frame = 0; frame < 20 * 60; frame++) {
    advance(1 / 60);
    counted.tick();
  }
  ok('an interval below the floor is raised to it rather than firing every frame',
    fired >= 3 && fired <= 5, `${fired} firings in 20 seconds`);
  ok('and the runtime is still usable afterwards', runtime.tick() === false);
}

{
  const trigger = createTrigger({
    id: 'T', source: 'timer', sceneId: 'scare', hold: 0, every: 20, jitter: 0, enabled: false,
  });
  const app = show({ triggers: [trigger] });
  const runtime = createTriggerRuntime({ app });
  runtime.tick();
  advance(60);
  ok('a disabled trigger is never evaluated', runtime.tick() === false);
  ok('and the show is untouched', app.project.show.activeScene === 'amb');
}

/* ------------------------------------------------------------------ *
 * Hotkeys
 * ------------------------------------------------------------------ */

console.log('\n— hotkeys —');
{
  const trigger = createTrigger({ id: 'T', source: 'hotkey', key: 'q', sceneId: 'scare', hold: 4 });
  const off = createTrigger({ id: 'U', source: 'hotkey', key: 'w', sceneId: 'other', enabled: false });
  const timed = createTrigger({ id: 'V', source: 'timer', key: 'e', sceneId: 'other' });
  const app = show({ triggers: [trigger, off, timed] });
  const runtime = createTriggerRuntime({ app });

  ok('an unbound key does nothing', runtime.fireByKey('z') === false);
  ok('a bound one fires', runtime.fireByKey('q') === true);
  ok('and case does not matter', app.project.show.activeScene === 'scare');

  advance(5);
  runtime.tick();
  ok('a disabled hotkey trigger does not fire', runtime.fireByKey('w') === false);
  ok('nor does a key on a trigger that is not a hotkey', runtime.fireByKey('e') === false);

  ok('shift-Q is still Q', runtime.fireByKey('Q') === true);
}

/* ------------------------------------------------------------------ *
 * Motion
 * ------------------------------------------------------------------ */

console.log('\n— motion —');
{
  const trigger = createTrigger({
    id: 'T', source: 'motion', sceneId: 'scare', hold: 2, cooldown: 20, sensitivity: 0.5,
  });
  const app = show({ triggers: [trigger] });
  const runtime = createTriggerRuntime({ app });

  const quiet = { activityFor: () => 0 };
  const busy = { activityFor: () => 0.9 };
  const blind = { activityFor: () => null };

  ok('a quiet path does not fire', runtime.tick(quiet) === false);
  ok('one frame of activity is noise, and does not fire', runtime.tick(busy) === false);
  ok('two in a row is somebody, and does', runtime.tick(busy) === true);
  ok('the scare is up', app.project.show.activeScene === 'scare');

  advance(3);
  runtime.tick(quiet);
  ok('it ends on its own', app.project.show.activeScene === 'amb');

  ok('and the cooldown holds it off', runtime.tick(busy) === false && runtime.tick(busy) === false);
  advance(30);
  ok('until the cooldown is up', runtime.tick(busy) === false && runtime.tick(busy) === true);

  advance(60);
  // Let that last firing's hold expire before asking anything else, or the
  // change being reported is the hold ending rather than the trigger.
  runtime.tick(quiet);
  runtime.tick(busy);
  ok('the meter in the panel follows the camera', runtime.activityFor('T') === 0.9);
  ok('a camera that is not ready yet reports nothing rather than reporting quiet',
    runtime.tick(blind) === false);
  ok('and leaves the last real reading in place', runtime.activityFor('T') === 0.9);
}

{
  // A manual firing is somebody pressing the button, so it bypasses the
  // cooldown — but it still records the time, or a motion event a frame later
  // doubles it up.
  const trigger = createTrigger({ id: 'T', source: 'motion', sceneId: 'scare', hold: 1, cooldown: 30 });
  const app = show({ triggers: [trigger] });
  const runtime = createTriggerRuntime({ app });
  const busy = { activityFor: () => 0.9 };

  runtime.fire(trigger, { manual: true });
  ok('a manual firing works whatever the cooldown says', app.project.show.activeScene === 'scare');
  advance(2);
  runtime.tick(busy);
  ok('and holds motion off afterwards', runtime.tick(busy) === false);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
