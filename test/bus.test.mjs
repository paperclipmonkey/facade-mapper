/**
 * The bus, and the moment before it reaches the network.
 *
 * One control tab drives N projector tabs through a BroadcastChannel, and a
 * second machine joins by way of a transport that *mirrors* what this tab
 * posts onto a WebSocket. Every handler in the app is written once and neither
 * knows nor cares which side of the wire a message came from, which is the
 * property worth having and the reason this file is small.
 *
 * The interesting behaviour is all in the corners:
 *
 *  - A tab never hears its own post. Both sides of every conversation are in
 *    the same module, so a control tab that heard its own project broadcast
 *    would apply it, mark the project dirty, and broadcast again.
 *  - Only *posts* are mirrored, never messages that arrived from elsewhere,
 *    which is what stops two linked tabs on one machine echoing each other
 *    round the network for ever.
 *  - **A post made before the mirror is installed goes nowhere off-machine.**
 *    That is not a quirk, it is a bug that has now been shipped twice: a page
 *    that introduces itself during boot does so a few hundred milliseconds
 *    before its socket finishes opening, so on a second machine the
 *    introduction is simply never heard. The remote found this the hard way
 *    and answers it by asking again when its digest goes stale; the projector
 *    tab did not, and sat on "no project found in this browser yet" until
 *    somebody went indoors and changed something. Both now keep asking until
 *    they have been answered, and this is the test that says why they have to.
 *
 * BroadcastChannel is a Node global, so all of this runs for real rather than
 * against a stand-in.
 *
 *   node test/bus.test.mjs
 */

import { createBus, createPresence, MSG } from '../js/core/bus.js';

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

/** A BroadcastChannel hop is a task, not a microtask. */
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

const open = [];
const bus = (role) => {
  const made = createBus(role);
  open.push(made);
  return made;
};

/* ------------------------------------------------------------------ *
 * Between tabs
 * ------------------------------------------------------------------ */

console.log('— between tabs on one machine —');
{
  const control = bus('control');
  const projector = bus('projector');

  ok('every tab has an id of its own', control.tabId !== projector.tabId);
  ok('and knows what it is', control.role === 'control' && projector.role === 'projector');

  const heard = [];
  const wildcard = [];
  projector.on(MSG.PROJECT, (payload, msg) => heard.push([payload, msg.from]));
  projector.on('*', (payload, msg) => wildcard.push(msg.type));

  const ownEcho = [];
  control.on(MSG.PROJECT, (payload) => ownEcho.push(payload));

  control.post(MSG.PROJECT, { shapes: 3 });
  await settle();

  ok('a post reaches the other tab', heard.length === 1 && heard[0][0].shapes === 3);
  ok('stamped with who sent it', heard[0][1] === control.tabId);
  ok('and a wildcard listener hears it too', wildcard.includes(MSG.PROJECT));
  /**
   * The sender is deliberately deaf to itself. Both ends of every conversation
   * live in the same module, and a control tab that applied its own project
   * broadcast would mark the project changed and broadcast it again.
   */
  ok('the tab that sent it does not hear it back', ownEcho.length === 0);

  const off = projector.on(MSG.CLOCK, () => heard.push('clock'));
  off();
  control.post(MSG.CLOCK, { running: true });
  await settle();
  ok('unsubscribing works', !heard.includes('clock'));
}

/* ------------------------------------------------------------------ *
 * Waiting for one answer
 * ------------------------------------------------------------------ */

console.log('\n— waiting for one answer —');
{
  const asker = bus('control');
  const answerer = bus('projector');

  const wanted = asker.once(MSG.CALIB_ACK, (p) => p.projectorId === 'P2', 500);
  answerer.post(MSG.CALIB_ACK, { projectorId: 'P1' });
  await settle();
  answerer.post(MSG.CALIB_ACK, { projectorId: 'P2', index: 4 });
  const answer = await wanted;
  ok('`once` waits for the message it was asked for', answer.index === 4);

  let timedOut = false;
  await asker.once(MSG.CALIB_ACK, () => false, 60).catch(() => { timedOut = true; });
  ok('and gives up rather than waiting for ever', timedOut);
}

/* ------------------------------------------------------------------ *
 * A handler that throws
 * ------------------------------------------------------------------ */

console.log('\n— one broken handler —');
{
  const sender = createBus('control');
  const receiver = createBus('projector');
  const after = [];
  // The bus is supposed to say so, and this is the assertion rather than noise
  // in the middle of the run.
  const complaints = [];
  const realError = console.error;
  console.error = (...args) => complaints.push(args.join(' '));

  receiver.on(MSG.SHOW, () => { throw new Error('boom'); });
  receiver.on(MSG.SHOW, (payload) => after.push(payload));
  sender.post(MSG.SHOW, { ok: true });
  await settle();
  console.error = realError;

  ok('does not stop the handler behind it', after.length === 1);
  ok('and is reported rather than swallowed',
    complaints.some((line) => /handler failed/.test(line)), complaints.join(' | '));

  // Closed here rather than at the end, or the throwing handler goes on
  // shouting through the sections below.
  sender.close();
  receiver.close();
}

/* ------------------------------------------------------------------ *
 * The mirror, which is how a message leaves the machine
 * ------------------------------------------------------------------ */

console.log('\n— what reaches the wire —');
{
  const local = bus('control');
  const other = bus('projector');
  const wire = [];

  local.post(MSG.HELLO, { before: true });
  const unmirror = local.mirror((msg) => wire.push(msg));
  local.post(MSG.HELLO, { after: true });
  await settle();

  /**
   * The whole of the projector bug, in two lines.
   *
   * A page that introduces itself during boot does so before its socket has
   * finished opening — measured, the socket opens about four hundred
   * milliseconds after the page does — so the introduction goes round this
   * machine and stops. On the control machine that costs nothing, because
   * BroadcastChannel got there first. On a second laptop it was the show: the
   * project is only broadcast when it *changes*, so a projector tab whose one
   * request for it was never heard waited for somebody to go indoors and move
   * something.
   */
  ok('a post made before the mirror was installed never reaches the wire',
    !wire.some((m) => m.payload?.before), JSON.stringify(wire.map((m) => m.payload)));
  ok('one made after it does', wire.some((m) => m.payload?.after));
  ok('and carries its type and sender with it',
    wire[0].type === MSG.HELLO && wire[0].from === local.tabId);

  /**
   * Only posts. A message that arrived over the wire must not go back out, and
   * one that arrived over BroadcastChannel is already on the wire courtesy of
   * the tab that posted it — which is what stops two linked tabs on one machine
   * echoing each other round the network for ever.
   */
  wire.length = 0;
  other.post(MSG.SHOW, { from: 'the other tab' });
  await settle();
  local.receive({ type: MSG.SHOW, payload: { from: 'the network' }, from: 'somewhere-else' });
  await settle();
  ok('nothing that merely arrived is mirrored back out', wire.length === 0,
    JSON.stringify(wire.map((m) => m.payload)));

  const delivered = [];
  local.on(MSG.DRAW, (payload) => delivered.push(payload));
  local.receive({ type: MSG.DRAW, payload: { kind: 'end' }, from: 'a-tablet' });
  ok('but it is delivered here exactly as a local one would be',
    delivered.length === 1 && delivered[0].kind === 'end');

  unmirror();
  wire.length = 0;
  local.post(MSG.HELLO, { later: true });
  await settle();
  ok('and the mirror can be taken off again', wire.length === 0);
}

/* ------------------------------------------------------------------ *
 * Who is out there
 * ------------------------------------------------------------------ */

console.log('\n— which projector tabs are alive —');
{
  const control = bus('control');
  const presence = createPresence(control, { staleMs: 120 });
  const changes = [];
  presence.onChange((list) => changes.push(list.length));

  const one = bus('projector');
  const two = bus('projector');
  one.post(MSG.HELLO, { tabId: one.tabId, projectorId: 'P1', width: 1920, height: 1080 });
  two.post(MSG.HELLO, { tabId: two.tabId, projectorId: 'P2', width: 1280, height: 720 });
  await settle();

  ok('both tabs are counted', presence.list().length === 2, `${presence.list().length}`);
  ok('and can be found by which projector they are',
    presence.forProjector('P2')?.width === 1280);
  ok('one that has not said anything is not there', presence.forProjector('P9') === null);
  ok('the list said so as they arrived', changes.length >= 2, changes.join(','));

  /**
   * Re-announcing the same thing is not a change. The control tab redraws its
   * checklist on every one of these, and a tab saying hello every four seconds
   * would redraw it every four seconds for nothing.
   */
  const before = changes.length;
  one.post(MSG.HELLO, { tabId: one.tabId, projectorId: 'P1', width: 1920, height: 1080 });
  await settle();
  ok('a heartbeat that says nothing new is not a change', changes.length === before);

  const moved = changes.length;
  one.post(MSG.HELLO, { tabId: one.tabId, projectorId: 'P1', width: 1920, height: 1080, fullscreen: true });
  await settle();
  ok('but going fullscreen is', changes.length > moved);

  two.post(MSG.BYE, { tabId: two.tabId });
  await settle();
  ok('a tab that says goodbye is dropped', presence.list().length === 1);

  /**
   * A crashed or force-closed tab says nothing at all, so the list has to
   * expire it or the control tab keeps offering a projector that is not there.
   */
  await settle(2600);
  ok('and one that simply stops answering expires', presence.list().length === 0,
    `${presence.list().length}`);

  presence.dispose();
}

for (const b of open) b.close();

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
