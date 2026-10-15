/**
 * The dare game, as data.
 *
 * Trick-or-treaters press buttons on the path, the house asks "trick or
 * treat?", and every YES gets a trick, each scarier than the last. The design and the reasoning are in
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
 *   by level (or by try, for `byAttempt`), so the words can change as the
 *   visit goes on.
 * - `cue` plays a trigger instead — scene, sound, hooks and its hold.
 * - `timer` names the `game.timing` entry after which `timeout` happens.
 * - `armed` states ignore presses for `armMs` after they appear, so the thumb
 *   still on YES from the last question cannot answer this one.
 */
export const STATES = {
  attract: {
    label: 'Trick or treat?',
    zone: 'street',
    scene: 'attract',
    note: 'The house waits for somebody to press a button',
  },
  persuade: {
    label: 'Talk them round',
    zone: 'path',
    scene: 'persuade',
    timer: 'askTimeout',
    armed: true,
    byAttempt: true,
    note: 'They said NO to the first question, so the house asks again',
  },
  ask: {
    label: 'More?',
    zone: 'path',
    scene: 'ask',
    timer: 'askTimeout',
    armed: true,
    levelled: true,
    note: 'Asked after each trick: do you want another?',
  },
  scare: {
    label: 'Trick',
    zone: 'path',
    cue: 'rung',
    levelled: true,
    note: 'One rung of the ladder',
  },
  approach: {
    label: 'Come and get your treat',
    zone: 'path',
    scene: 'approach',
    timer: 'approachTimeout',
    levelled: true,
    // By how far they got, not a step of its own: not numbered like one.
    staged: true,
    note: 'Out of tricks, or they have had enough: the invitation up to the door',
  },
  finale: {
    label: 'At the door',
    zone: 'door',
    cue: 'finale',
    note: 'They pressed DOOR to say they are coming forward: sound and light, no words',
  },
  waiting: {
    label: 'Waiting for the treat',
    zone: 'door',
    scene: 'waiting',
    timer: 'waitForTreat',
    note: 'At the door; the goodbye plays anyway if nobody presses TREAT',
  },
  reward: {
    label: 'Happy Halloween',
    zone: 'street',
    scene: 'reward',
    timer: 'rewardHold',
    note: 'The goodbye, read as they walk away',
  },
  cooldown: {
    label: 'Cooldown',
    zone: 'street',
    timer: 'cooldown',
    note: 'The house goes back to what it was doing',
  },
};

/** Where TREAT is honoured: everywhere somebody is actually playing. */
export const TREATABLE = ['ask', 'persuade', 'scare', 'approach', 'finale', 'waiting'];

/**
 * Every transition the game can take.
 *
 * `on` is a role, `long-no` (NO held down) or `timeout`. `when` is a guard,
 * `do` an effect on the level and the tries. The first match wins, so guarded
 * rows come before their fallbacks.
 *
 * `quiet` rows are real but are summarised on the diagram rather than drawn —
 * an arrow into the goodbye from every moment says less than a line of text.
 */
export const TRANSITIONS = [
  /**
   * The first press. Either the waiting screen *is* the first question — "TRICK
   * OR TREAT?", and YES goes straight to the first trick — or it only invites
   * a press, and the first question comes after it.
   */
  { from: 'attract', on: 'yes', to: 'scare', when: 'opening', do: 'start' },
  { from: 'attract', on: 'no', to: 'persuade', when: 'opening-plead', do: 'start+plead' },
  { from: 'attract', on: 'no', to: 'approach', when: 'opening', do: 'start' },
  { from: 'attract', on: 'yes', to: 'ask', when: 'closed', do: 'start' },
  { from: 'attract', on: 'no', to: 'ask', when: 'closed', do: 'start' },

  { from: 'ask', on: 'yes', to: 'scare' },
  { from: 'ask', on: 'no', to: 'persuade', when: 'first-plead', do: 'plead' },
  { from: 'ask', on: 'no', to: 'approach' },
  // Nobody answered for a long time: they have gone. Back to the start.
  { from: 'ask', on: 'timeout', to: 'attract' },

  /**
   * NO to the first question need not be the end of it: the house can ask
   * again — "DID YOU SAY TRICK?", "BUT WE LOVE TO SCARE…" — as many times as
   * `persuade` says, before it gives up and sends them for their treat.
   */
  { from: 'persuade', on: 'yes', to: 'scare' },
  { from: 'persuade', on: 'no', to: 'persuade', when: 'plead', do: 'plead' },
  { from: 'persuade', on: 'no', to: 'approach' },
  { from: 'persuade', on: 'timeout', to: 'attract' },

  // NO held down during a trick: somebody is frightened. Stop, and send them
  // for their treat.
  { from: 'scare', on: 'long-no', to: 'approach' },
  { from: 'scare', on: 'timeout', to: 'ask', when: 'more', do: 'next' },
  // Out of tricks. One past the top, so "come and get your treat" can say so.
  { from: 'scare', on: 'timeout', to: 'approach', do: 'next' },

  /**
   * The door is theirs to press, and only now: it means "I'm coming up". With
   * no DOOR button the adult's TREAT does the same job, and if nobody does
   * anything for long enough the house starts again for the next group.
   */
  { from: 'approach', on: 'door', to: 'finale', when: 'door' },
  { from: 'approach', on: 'timeout', to: 'attract' },

  { from: 'finale', on: 'timeout', to: 'waiting' },
  // They have been to the door; if nobody remembered TREAT they still get the
  // goodbye on the way back down the path.
  { from: 'waiting', on: 'timeout', to: 'reward' },

  ...TREATABLE.map((from) => ({
    from,
    on: 'treat',
    to: 'reward',
    quiet: !['approach', 'waiting'].includes(from),
  })),

  { from: 'reward', on: 'timeout', to: 'cooldown' },
  { from: 'cooldown', on: 'timeout', to: 'attract' },
];

export const GUARD_LABELS = {
  more: 'more tricks',
  door: 'there is a DOOR button',
  opening: 'the waiting screen asks',
  closed: 'the waiting screen only invites',
  'opening-plead': 'asks again after NO',
  'first-plead': 'asks again after NO',
  plead: 'more tries left',
};

export const EVENT_LABELS = {
  yes: 'YES',
  no: 'NO',
  door: 'DOOR',
  treat: 'TREAT',
  'long-no': 'hold NO',
  timeout: 'time',
};

/** How many rungs the ladder has, never less than one. */
export function topLevel(game) {
  return Math.max(1, game?.rungs?.length || 0);
}

/** How many more times the house asks after a NO at the first question. */
export function persuadeCount(game) {
  return Math.max(0, Math.round(Number(game?.persuade) || 0));
}

/**
 * Does a guard let this transition through, at this level and try?
 *
 * `attempt` is how many times the house has asked again after a NO — a count
 * of its own, because talking somebody round does not climb the ladder.
 */
export function guardPasses(when, game, level, attempt = 0) {
  if (!when) return true;
  const top = topLevel(game);
  const opening = !!game?.openingQuestion;
  const tries = persuadeCount(game);
  if (when === 'more') return level < top;
  if (when === 'door') return !!game?.door;
  if (when === 'opening') return opening;
  if (when === 'closed') return !opening;
  if (when === 'opening-plead') return opening && tries > 0;
  if (when === 'first-plead') return !opening && level <= 1 && tries > 0;
  if (when === 'plead') return attempt < tries;
  return false;
}

/**
 * Could a guard ever pass in this game, at any level? For the diagram, which
 * draws a route this game will never take faint and dashed.
 */
export function guardPossible(when, game) {
  if (!when) return true;
  const tries = persuadeCount(game);
  const opening = !!game?.openingQuestion;
  if (when === 'more') return topLevel(game) > 1;
  if (when === 'first-plead') return !opening && tries > 0;
  if (when === 'plead') return tries > 1;
  return guardPasses(when, game, topLevel(game), 0);
}

/** The transition `event` takes out of `state`, or null if it goes nowhere. */
export function transitionFor(state, event, game, level, attempt = 0) {
  return TRANSITIONS.find((t) => t.from === state && t.on === event && guardPasses(t.when, game, level, attempt)) || null;
}

/** Which events do anything in this state right now — what the buttons will do. */
export function eventsFrom(state, game, level, attempt = 0) {
  const out = new Map();
  for (const t of TRANSITIONS) {
    if (t.from !== state || out.has(t.on)) continue;
    if (guardPasses(t.when, game, level, attempt)) out.set(t.on, t);
  }
  return out;
}

/** Which count picks a state's scene and words: its try, its level, or neither. */
export function slotIndex(state, level, attempt) {
  if (STATES[state]?.byAttempt) return Math.max(1, attempt || 1);
  return Math.max(1, level || 1);
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
  const counted = STATES[state]?.levelled || STATES[state]?.byAttempt;
  const list = counted ? levels[Math.max(1, level) - 1] : levels[0];
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
  if (game.door && !game.finale) problems.push('Nothing happens at the door — pick a trigger for it, or switch the DOOR button off.');
  if (!game.openingQuestion && !sceneSlot(game, 'ask', 1)) problems.push('No question scene — nobody will know there is a question.');
  if (!sceneSlot(game, 'attract', 1)) problems.push('Nothing on the wall while the house waits — nobody will know there is a game.');

  for (const [key, slot] of Object.entries(game.scenes || {})) {
    for (const id of Array.isArray(slot) ? slot : [slot]) {
      if (id && !scenes.has(id)) problems.push(`The ${key} scene no longer exists.`);
    }
  }

  const roles = new Set(Object.values(game.buttons || {}));
  if (Object.keys(game.buttons || {}).length) {
    if (!roles.has('yes')) problems.push('No button is mapped to YES.');
    if (game.door && !roles.has('door')) problems.push('The DOOR button is on, but no button is mapped to DOOR.');
  }
  return problems;
}
