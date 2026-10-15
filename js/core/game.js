/**
 * The dare game, as data.
 *
 * Trick-or-treaters press buttons on the path, the house asks "do you dare?",
 * and every YES gets something scarier. The design and the reasoning are in
 * docs/button-game.md; this file is the machine itself, written as a table
 * rather than as code, for one reason: the diagram has to be the truth.
 *
 * The control tab's Game panel and the remote both draw this machine, and the
 * runtime in control/game.js walks it. If those were two descriptions of the
 * same thing — a switch statement and a picture of one — they would agree on
 * the day they were written and on no day after. Read from one table, a
 * transition that is on the diagram is a transition the game will take, and a
 * press the diagram shows going nowhere is a press the game will drop.
 *
 * Nothing in here touches the DOM, the clock or the project, so it is shared by
 * the control tab, the remote and the tests.
 */

/**
 * What a physical button can mean.
 *
 * Buttons are mapped to roles rather than the game knowing about devices, so
 * two YES buttons on either side of the path is a mapping, not a change here.
 *
 * - **yes** / **no** — on the path, far enough back to read the wall.
 * - **door** — at the front door, for the last dare. Close enough to touch the
 *   house is too close to read anything on it, so nothing that needs reading
 *   happens while somebody is standing there.
 * - **treat** — the adult with the sweets. A phone, a hidden fourth button, or
 *   the remote; never a child's button.
 */
export const ROLES = ['yes', 'no', 'door', 'treat'];

export const ROLE_LABELS = {
  yes: 'YES',
  no: 'NO',
  door: 'DOOR',
  treat: 'TREAT',
};

/**
 * The states.
 *
 * - `zone` is where the visitors are standing while it plays, which decides
 *   what kind of content belongs in it: `path` can carry words, `door` cannot.
 * - `scene` names the slot in `game.scenes` it shows. An array slot is chosen
 *   by level, so the question can get worse as the ladder goes up.
 * - `cue` plays a trigger instead — scene, sound, hooks and its hold.
 * - `timer` names the `game.timing` entry after which `timeout` happens.
 * - `armed` states ignore presses for `armMs` after they appear, so the thumb
 *   still on YES from the last question cannot answer this one.
 */
export const STATES = {
  attract: {
    label: 'Attract',
    zone: 'street',
    scene: 'attract',
    note: 'The house idles and invites a press',
  },
  early: {
    label: 'Too soon',
    zone: 'door',
    scene: 'early',
    timer: 'earlyHold',
    note: 'Somebody went straight to the door',
  },
  ask: {
    label: 'Ask',
    zone: 'path',
    scene: 'ask',
    timer: 'askTimeout',
    armed: true,
    levelled: true,
    note: '"Do you dare?" — worse at every level',
  },
  nudge: {
    label: 'Anyone there?',
    zone: 'path',
    scene: 'nudge',
    timer: 'nudgeTimeout',
    armed: true,
    note: 'Nobody answered the question',
  },
  decide: {
    label: "Can't decide",
    zone: 'path',
    scene: 'decide',
    timer: 'decideHold',
    note: 'YES and NO together — the house picks YES',
  },
  scare: {
    label: 'Scare',
    zone: 'path',
    cue: 'rung',
    levelled: true,
    note: 'One rung of the ladder',
  },
  mercy: {
    label: 'Mercy',
    zone: 'path',
    scene: 'mercy',
    timer: 'waitForTreat',
    note: 'NO held down during a scare',
  },
  approach: {
    label: 'Come closer',
    zone: 'path',
    scene: 'approach',
    timer: 'approachTimeout',
    note: 'Invited to the door — the last words they will read',
  },
  finale: {
    label: 'Finale',
    zone: 'door',
    cue: 'finale',
    note: 'At the door: sound and light, no words',
  },
  chicken: {
    label: 'Chicken',
    zone: 'path',
    scene: 'chicken',
    timer: 'waitForTreat',
    levelled: true,
    note: 'Said NO — kindly, by how far they got',
  },
  waiting: {
    label: 'Waiting',
    zone: 'door',
    scene: 'waiting',
    timer: 'waitForTreat',
    note: 'Survived the finale; the reward plays anyway if nobody presses TREAT',
  },
  reward: {
    label: 'Reward',
    zone: 'street',
    scene: 'reward',
    timer: 'rewardHold',
    note: 'Read on the way back down the path',
  },
  cooldown: {
    label: 'Cooldown',
    zone: 'street',
    timer: 'cooldown',
    note: 'The house goes back to what it was doing',
  },
};

/** Where TREAT is honoured: everywhere somebody is actually playing. */
export const TREATABLE = ['ask', 'nudge', 'decide', 'scare', 'mercy', 'approach', 'finale', 'chicken', 'waiting'];

/**
 * Every transition the game can take.
 *
 * `on` is a role, `both` (YES and NO inside the decision window), `long-no`
 * (NO held down) or `timeout`. `when` is a guard, `do` an effect on the level.
 * The first match wins, so guarded rows come before their fallbacks.
 *
 * `quiet` rows are real but are summarised on the diagram rather than drawn —
 * nine arrows into Reward say less than one line of text does.
 */
export const TRANSITIONS = [
  { from: 'attract', on: 'yes', to: 'ask', do: 'start' },
  { from: 'attract', on: 'no', to: 'ask', do: 'start' },
  { from: 'attract', on: 'door', to: 'early' },
  { from: 'early', on: 'timeout', to: 'attract' },

  { from: 'ask', on: 'yes', to: 'scare' },
  { from: 'ask', on: 'no', to: 'chicken' },
  { from: 'ask', on: 'both', to: 'decide' },
  { from: 'ask', on: 'timeout', to: 'nudge' },

  // No decision window here: a group that has gone quiet for fifteen seconds
  // is not about to press both buttons inside 150 ms of each other.
  { from: 'nudge', on: 'yes', to: 'scare' },
  { from: 'nudge', on: 'no', to: 'chicken' },
  { from: 'nudge', on: 'timeout', to: 'cooldown' },

  { from: 'decide', on: 'timeout', to: 'scare' },

  { from: 'scare', on: 'long-no', to: 'mercy' },
  { from: 'scare', on: 'timeout', to: 'ask', when: 'more', do: 'next' },
  { from: 'scare', on: 'timeout', to: 'approach', when: 'top-door' },
  { from: 'scare', on: 'timeout', to: 'finale', when: 'top' },

  { from: 'approach', on: 'door', to: 'finale' },
  { from: 'approach', on: 'no', to: 'chicken' },
  { from: 'approach', on: 'timeout', to: 'chicken' },

  { from: 'finale', on: 'timeout', to: 'waiting' },

  { from: 'chicken', on: 'timeout', to: 'cooldown' },
  { from: 'mercy', on: 'timeout', to: 'cooldown' },
  // They survived the finale and the door has been opened; if nobody
  // remembered to press TREAT they still get the ending on the way back down.
  { from: 'waiting', on: 'timeout', to: 'reward' },

  ...TREATABLE.map((from) => ({
    from,
    on: 'treat',
    to: 'reward',
    quiet: !['chicken', 'mercy', 'waiting'].includes(from),
  })),

  { from: 'reward', on: 'timeout', to: 'cooldown' },
  { from: 'cooldown', on: 'timeout', to: 'attract' },
];

export const GUARD_LABELS = {
  more: 'more rungs',
  'top-door': 'top rung, door on',
  top: 'top rung, no door',
};

export const EVENT_LABELS = {
  yes: 'YES',
  no: 'NO',
  door: 'DOOR',
  treat: 'TREAT',
  both: 'YES+NO',
  'long-no': 'hold NO',
  timeout: 'time',
};

/** How many rungs the ladder has, never less than one. */
export function topLevel(game) {
  return Math.max(1, game?.rungs?.length || 0);
}

/** Does a guard let this transition through, at this level? */
export function guardPasses(when, game, level) {
  if (!when) return true;
  const top = topLevel(game);
  if (when === 'more') return level < top;
  if (when === 'top-door') return level >= top && !!game?.door;
  if (when === 'top') return level >= top && !game?.door;
  return false;
}

/** The transition `event` takes out of `state`, or null if it goes nowhere. */
export function transitionFor(state, event, game, level) {
  return TRANSITIONS.find((t) => t.from === state && t.on === event && guardPasses(t.when, game, level)) || null;
}

/** Which events do anything in this state right now — what the buttons will do. */
export function eventsFrom(state, game, level) {
  const out = new Map();
  for (const t of TRANSITIONS) {
    if (t.from !== state || out.has(t.on)) continue;
    if (guardPasses(t.when, game, level)) out.set(t.on, t);
  }
  return out;
}

/**
 * The scene a state shows, at a level.
 *
 * Array slots are by level, and run out gracefully: a ladder of five with three
 * questions written asks the third one three times, which is a better failure
 * than asking nothing.
 */
export function sceneSlot(game, state, level = 1) {
  const key = STATES[state]?.scene;
  if (!key) return null;
  const slot = game?.scenes?.[key];
  if (Array.isArray(slot)) {
    const filled = slot.filter(Boolean);
    if (!filled.length) return null;
    for (let i = Math.min(level, slot.length) - 1; i >= 0; i--) if (slot[i]) return slot[i];
    return filled[0];
  }
  return slot || null;
}

/**
 * The lines said as a state begins, at a level: "words first". By level for a
 * levelled state, and the first list for any other. An empty list is none —
 * unlike scenes these do not carry on from the level before, because a line
 * like "YOU ASKED FOR IT…" said before every scare stops meaning anything.
 */
export function beatsFor(game, state, level = 1) {
  const levels = game?.beats?.[state];
  if (!Array.isArray(levels)) return [];
  const list = STATES[state]?.levelled ? levels[Math.max(1, level) - 1] : levels[0];
  return Array.isArray(list) ? list.filter((b) => b && String(b.text || '').trim()) : [];
}

/** The trigger a cue state plays, at a level. */
export function cueSlot(game, state, level = 1) {
  const cue = STATES[state]?.cue;
  if (cue === 'rung') return game?.rungs?.[level - 1] || null;
  if (cue === 'finale') return game?.finale || null;
  return null;
}

/**
 * Which role a press from this button has.
 *
 * Mapped buttons first. A press naming a role directly — which is what the
 * remote and the panel's test buttons send — is honoured as that role, so the
 * game can be played without any hardware mapped at all.
 */
export function roleOf(game, button) {
  const id = String(button ?? '');
  const buttons = game?.buttons || {};
  if (Object.hasOwn(buttons, id) && ROLES.includes(buttons[id])) return buttons[id];
  return ROLES.includes(id) ? id : null;
}

/**
 * Every scene the game plays: its own slots, and the scenes of its scares.
 *
 * These are the game's, the way a slide belongs to a deck. They are played by
 * the game and edited from its panel, so they are kept off the transport's
 * scene buttons and the remote's — eighteen buttons nobody should press by
 * hand would bury the four somebody does.
 */
export function gameSceneIds(game, project) {
  const ids = new Set();
  if (!game) return ids;
  for (const slot of Object.values(game.scenes || {})) {
    for (const id of Array.isArray(slot) ? slot : [slot]) if (id) ids.add(id);
  }
  const triggers = new Map((project?.triggers || []).map((t) => [t.id, t]));
  for (const id of [...(game.rungs || []), game.finale]) {
    const sceneId = triggers.get(id)?.sceneId;
    if (sceneId) ids.add(sceneId);
  }
  return ids;
}

/**
 * What is wrong with a game, worded for the person building it.
 *
 * Nothing here stops the game running — every gap has a fallback — but each one
 * is a moment on the night where the house does nothing visible, and those are
 * worth knowing about at the desk rather than on the path.
 */
export function gameProblems(game, project) {
  const problems = [];
  if (!game) return problems;
  const scenes = new Set((project?.scenes || []).map((s) => s.id));
  const triggers = new Set((project?.triggers || []).map((t) => t.id));

  if (!game.rungs?.length) problems.push('The ladder is empty — every YES will hold for a few seconds and show nothing.');
  (game.rungs || []).forEach((id, i) => {
    if (id && !triggers.has(id)) problems.push(`Rung ${i + 1} points at a trigger that no longer exists.`);
  });
  if (game.finale && !triggers.has(game.finale)) problems.push('The finale points at a trigger that no longer exists.');
  if (!game.finale) problems.push('No finale — the top of the ladder will hold for a few seconds and show nothing.');
  if (!sceneSlot(game, 'ask', 1)) problems.push('No question scene — nobody will know there is a question.');

  for (const [key, slot] of Object.entries(game.scenes || {})) {
    for (const id of Array.isArray(slot) ? slot : [slot]) {
      if (id && !scenes.has(id)) problems.push(`The ${key} scene no longer exists.`);
    }
  }

  const roles = new Set(Object.values(game.buttons || {}));
  if (Object.keys(game.buttons || {}).length) {
    if (!roles.has('yes')) problems.push('No button is mapped to YES.');
    if (game.door && !roles.has('door')) problems.push('The door stage is on, but no button is mapped to DOOR.');
  }
  return problems;
}
