/**
 * The remote.
 *
 * A phone at the end of the path, or the second laptop in the hall. It holds no
 * project, renders nothing, and cannot edit the show — it is a set of buttons
 * that says what was pressed, and a digest that says what is lit. Everything it
 * knows arrives as `MSG.SHOW` from the control tab; everything it does leaves
 * as `MSG.ACTION`, and the control tab runs it through the same code as its own
 * buttons.
 *
 * That is deliberately less than the control tab can do, and the reason is not
 * screen size. One authority over the project is the invariant the whole design
 * rests on: two editors would need conflict resolution, and a show running in
 * front of people has no appetite for a merge conflict. So the phone gets the
 * verbs you want out in the garden — scene, blackout, trigger, brightness — and
 * none of the ones you want at a desk.
 *
 * Designed for the dark: big targets, no small text on anything you have to
 * press, and the button that turns everything off is the one you can hit
 * without looking.
 */

import { createBus, MSG } from '../core/bus.js';
import { createClock, formatTime } from '../core/clock.js';
import { createLink } from '../core/link.js';
import { now as linkNow } from '../core/time.js';

const $ = (id) => document.getElementById(id);

const bus = createBus('remote');
const clock = createClock();
const link = createLink(bus, {
  role: 'remote',
  label: 'Remote',
  /**
   * The two message types a remote can act on.
   *
   * The server sends nothing else, which is what keeps a 300 KB project
   * broadcast — twelve times a second while somebody drags a slider — off a
   * phone that has no use for it and may be on one bar of signal.
   */
  subscribe: [MSG.SHOW, MSG.CLOCK],
});

/** The last digest, and the moment it arrived, on this device's own clock. */
let show = null;
let showAt = 0;
/** Structure of the last digest, so the DOM is rebuilt only when it changes. */
let structure = '';
let draggingMaster = false;

/** Nodes built from the digest, kept so a repaint is a class change. */
const sceneNodes = new Map();
const triggerNodes = new Map();
const layerNodes = new Map();
const projectorNodes = new Map();

/* ------------------------------------------------------------------ *
 * Talking to the show
 * ------------------------------------------------------------------ */

function act(action, extra = {}) {
  bus.post(MSG.ACTION, { action, ...extra });
  // A phone in a coat pocket at the end of a garden gives no other feedback
  // that the press registered at all.
  navigator.vibrate?.(8);
}

/**
 * Apply what we expect to happen, before the answer comes back.
 *
 * The round trip is a few milliseconds over a garden, and the control tab
 * answers every action with a fresh digest immediately rather than on its next
 * tick — but "immediately" still means after a frame or two, and a blackout
 * button that lights up a beat after you hit it feels broken in a way that a
 * wrong guess corrected 20 ms later does not.
 */
function expect(change) {
  if (!show) return;
  Object.assign(show, change);
  paint();
}

/* ------------------------------------------------------------------ *
 * Building the controls
 * ------------------------------------------------------------------ */

function structureOf(digest) {
  const ids = (list) => (list || []).map((x) => `${x.id}:${x.name}`).join(',');
  return [ids(digest.scenes), ids(digest.triggers), ids(digest.layers), ids(digest.projectors)].join('|');
}

function bigButton({ label, sub, onPress, extra = '' }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `big ${extra}`.trim();
  const name = document.createElement('span');
  name.className = 'big-label';
  name.textContent = label;
  button.appendChild(name);
  if (sub !== undefined) {
    const note = document.createElement('span');
    note.className = 'big-sub';
    note.textContent = sub;
    button.appendChild(note);
  }
  button.addEventListener('click', onPress);
  return button;
}

function toggleRow({ name, sub, onPress }) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'toggle-row';
  const pip = document.createElement('span');
  pip.className = 'pip';
  const title = document.createElement('span');
  title.className = 'name';
  title.textContent = name;
  const note = document.createElement('span');
  note.className = 'sub';
  note.textContent = sub || '';
  row.append(pip, title, note);
  row.addEventListener('click', onPress);
  row.pip = pip;
  row.note = note;
  return row;
}

function build(digest) {
  sceneNodes.clear();
  triggerNodes.clear();
  layerNodes.clear();
  projectorNodes.clear();

  const scenes = $('scenes');
  scenes.replaceChildren();
  for (const scene of digest.scenes || []) {
    const button = bigButton({
      label: scene.name,
      sub: scene.hotkey ? `key ${scene.hotkey}` : ' ',
      onPress: () => {
        act('scene', { id: scene.id });
        expect({ activeScene: scene.id });
      },
    });
    sceneNodes.set(scene.id, button);
    scenes.appendChild(button);
  }
  $('scenesSection').hidden = !(digest.scenes || []).length;

  const triggers = $('triggers');
  triggers.replaceChildren();
  for (const trigger of digest.triggers || []) {
    const button = bigButton({
      label: trigger.name,
      sub: trigger.scene || trigger.source,
      onPress: () => act('trigger', { id: trigger.id }),
    });
    const bar = document.createElement('span');
    bar.className = 'cooldown';
    bar.style.transform = 'scaleX(0)';
    button.appendChild(bar);
    button.bar = bar;
    triggerNodes.set(trigger.id, button);
    triggers.appendChild(button);
  }
  $('triggersSection').hidden = !(digest.triggers || []).length;

  const layers = $('layers');
  layers.replaceChildren();
  for (const layer of digest.layers || []) {
    const row = toggleRow({
      name: layer.name,
      onPress: () => {
        const wanted = !row.classList.contains('on');
        act('layer', { id: layer.id, enabled: wanted });
        row.classList.toggle('on', wanted);
        row.pip.classList.toggle('on', wanted);
      },
    });
    layerNodes.set(layer.id, row);
    layers.appendChild(row);
  }

  const projectors = $('projectors');
  projectors.replaceChildren();
  for (const projector of digest.projectors || []) {
    const row = toggleRow({
      name: projector.name,
      onPress: () => act('projector-blackout', { id: projector.id }),
    });
    // Standing outside with three projectors running, the useful question is
    // which one is which — so the row that turns one off also has the button
    // that makes it say so.
    const identify = document.createElement('button');
    identify.type = 'button';
    identify.className = 'chip';
    identify.textContent = 'Flash';
    identify.addEventListener('click', (ev) => {
      ev.stopPropagation();
      act('identify', { id: projector.id });
    });
    row.appendChild(identify);
    projectorNodes.set(projector.id, row);
    projectors.appendChild(row);
  }
}

/* ------------------------------------------------------------------ *
 * Painting the state onto it
 * ------------------------------------------------------------------ */

function paint() {
  if (!show) return;

  $('showName').textContent = show.name || 'Facade Mapper';

  const blackout = !!show.blackout;
  $('btnBlackout').classList.toggle('on', blackout);
  $('blackoutSub').textContent = blackout ? 'the show is dark — press to bring it back' : 'everything off';

  const running = !!show.transport?.running;
  $('btnPlay').querySelector('.big-label').textContent = running ? '❚❚' : '▶';
  $('btnPlay').classList.toggle('on', running);

  const playlist = show.playlist || {};
  $('btnRunShow').classList.toggle('on', !!playlist.running);
  $('btnRunShow').querySelector('.big-label').textContent = playlist.running ? 'Stop show' : 'Run show';
  $('btnRunShow').disabled = !playlist.length;

  if (!draggingMaster) {
    $('master').value = show.master ?? 1;
    $('masterOut').textContent = `${Math.round((show.master ?? 1) * 100)}%`;
  }

  for (const [id, node] of sceneNodes) node.classList.toggle('on', show.activeScene === id);

  for (const layer of show.layers || []) {
    const row = layerNodes.get(layer.id);
    if (!row) continue;
    row.classList.toggle('on', layer.enabled);
    row.pip.classList.toggle('on', layer.enabled);
    row.note.textContent = layer.solo ? 'solo' : '';
  }

  for (const projector of show.projectors || []) {
    const row = projectorNodes.get(projector.id);
    if (!row) continue;
    row.pip.className = `pip${projector.live ? ' live' : ''}`;
    row.note.textContent = [
      projector.live ? 'on screen' : 'no tab',
      projector.blackout ? 'blacked out' : null,
      projector.aligned ? null : 'not aligned',
    ]
      .filter(Boolean)
      .join(' · ');
  }

  const health = show.health || {};
  $('linkNote').textContent = [
    link.status === 'linked'
      ? `Linked to ${link.state().server || 'the show'}.`
      : 'No link server — this is the show machine\u2019s own browser.',
    `${health.tabs || 0} projector tab${health.tabs === 1 ? '' : 's'} open, control tab at ${health.fps || 0} fps.`,
    show.schedule?.enabled ? show.schedule.note : 'No nightly schedule.',
  ].join(' ');
}

/**
 * What to say when there is nothing to show.
 *
 * Several different silences, and telling them apart is the difference between
 * "walk back to the laptop" and "wait ten seconds": no server, no control tab,
 * or a link that has dropped.
 *
 * A digest arriving is the end of the question, whichever way it came. Opened
 * as a second tab on the show machine this page works over BroadcastChannel
 * with no server at all — telling somebody to go and start one while their
 * buttons are visibly working would be nonsense.
 */
function updateNotice() {
  const notice = $('notice');
  const status = link.status;
  const fresh = show && Date.now() - showAt < 6000;

  $('linkDot').dataset.link = status;

  let message = '';
  if (fresh) {
    message = '';
  } else if (status === 'unavailable' || status === 'off') {
    message =
      'No show here. Run "node server.mjs" on the machine driving the projectors and open the ' +
      'address it prints, or open this page on that machine.';
  } else if (status === 'checking') {
    message = 'Looking for the show…';
  } else if (status !== 'linked') {
    message = 'Reconnecting to the show…';
  } else if (!show) {
    message = 'Linked. Waiting for the control tab — is Facade Mapper open on the show machine?';
  } else {
    message = 'The control tab has gone quiet. It may have been closed, or the machine may be asleep.';
  }

  notice.hidden = !message;
  notice.textContent = message;
  $('main').hidden = !show;
}

/* ------------------------------------------------------------------ *
 * The tick
 * ------------------------------------------------------------------ */

function tick() {
  requestAnimationFrame(tick);
  const time = clock.tick();
  $('showTime').textContent = formatTime(time.t);

  // Cooldowns run off `armedAt`, an instant on the shared clock, so this is
  // smooth between digests instead of stepping twice a second.
  if (show?.triggers) {
    const at = linkNow();
    for (const trigger of show.triggers) {
      const node = triggerNodes.get(trigger.id);
      if (!node) continue;
      const left = (trigger.armedAt || 0) - at;
      const cooling = left > 200;
      node.classList.toggle('cooling', cooling);
      node.bar.style.transform = `scaleX(${cooling ? Math.min(1, left / 20000) : 0})`;
    }
  }

  refreshIfStale();
  updateNotice();
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

bus.on(MSG.SHOW, (digest) => {
  if (!digest) return;
  show = digest;
  showAt = Date.now();
  const next = structureOf(digest);
  if (next !== structure) {
    structure = next;
    build(digest);
  }
  paint();
  updateNotice();
});

bus.on(MSG.CLOCK, (transport) => {
  if (transport) clock.setTransport(transport);
});

$('btnBlackout').addEventListener('click', () => {
  act('blackout');
  expect({ blackout: !show?.blackout });
});

$('btnPlay').addEventListener('click', () => {
  act('toggle-play');
  if (show?.transport) expect({ transport: { ...show.transport, running: !show.transport.running } });
});

$('btnStop').addEventListener('click', () => act('stop'));
$('btnRunShow').addEventListener('click', () => act('run-show'));

/**
 * The master fader.
 *
 * Sent continuously while it moves, because a brightness control you cannot see
 * the result of until you let go is not a brightness control. Each message is a
 * few dozen bytes, and the control tab rate-limits what it does with them.
 */
const master = $('master');
master.addEventListener('input', () => {
  draggingMaster = true;
  const value = Number(master.value);
  $('masterOut').textContent = `${Math.round(value * 100)}%`;
  act('master', { value });
});
for (const event of ['pointerup', 'pointercancel', 'change', 'blur']) {
  master.addEventListener(event, () => {
    draggingMaster = false;
  });
}

/**
 * Keep the screen on.
 *
 * A phone that locks itself after thirty seconds is a remote you have to unlock
 * every time something happens in the garden. The lock is dropped by the
 * browser whenever the page is hidden, so it is taken again on the way back.
 */
let wakeLock = null;
async function keepAwake() {
  if (document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    /* Denied, unsupported, or the battery is too low. Not worth saying. */
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    keepAwake();
    announce();
  }
});

/**
 * Say we are here.
 *
 * The control tab only assembles and posts a digest while something is
 * listening, so this is both an introduction and a heartbeat. Only the first
 * one asks for state — `requestState` makes the control tab rebroadcast
 * everything it has, which is not something to ask for every four seconds.
 */
let introduced = false;
function announce(askForState = false) {
  bus.post(MSG.HELLO, { role: 'remote', requestState: askForState || !introduced });
  introduced = true;
}

/**
 * How long a digest may go without being replaced before this page assumes it
 * is looking at an old show and asks again.
 *
 * The control tab publishes on every change and on a heartbeat, so in normal
 * running a digest is never more than half a second old. Anything past a few
 * seconds means the other end has stopped telling us things — the first
 * announcement was posted before the socket finished opening and was never
 * heard, the window it uses to decide somebody is listening has lapsed, the
 * link dropped and came back. The remote is the only device in a position to
 * notice, since it is the one holding the stale copy, so it is the one that
 * asks: the alternative is a phone showing last hour's scenes with no way to
 * find out, which is exactly what it did.
 */
const STALE_DIGEST_MS = 4000;
let askedAt = 0;

function refreshIfStale() {
  if (link.status !== 'linked' && link.status !== 'off') return;
  const now = Date.now();
  if (show && now - showAt < STALE_DIGEST_MS) return;
  if (now - askedAt < STALE_DIGEST_MS) return;
  askedAt = now;
  announce(true);
}

announce();
setInterval(announce, 4000);
keepAwake();
updateNotice();
requestAnimationFrame(tick);
