/**
 * Automation: steps, and what moves between them.
 *
 * A step is one moment of the show. It can put a scene up, put words on the
 * wall, or both — words alone keep the house as it is and only change what it
 * says. From each step a button press (YES, NO, DOOR) or a timer moves to
 * another step. That is the whole model: no ladders, levels or counters, so
 * what the diagram shows is exactly what will happen, step by step.
 *
 * The buttons are Matter buttons by way of Home Assistant, the remote, or the
 * panel's own test buttons — all the same press. The rules for handling them
 * (duplicates, stale presses, a press too soon after a step appears) are in
 * control/game.js; this file is the data and the questions asked of it, and
 * touches nothing, so the control tab, the remote and the tests share it.
 */

/**
 * The buttons a step can listen for.
 *
 * Physical buttons are mapped to these, so two YES buttons either side of the
 * path is a mapping rather than a change here. DOOR is for the front door: a
 * press there says somebody has come up.
 */
export const ROLES = ['yes', 'no', 'door'];

export const ROLE_LABELS = {
  yes: 'YES',
  no: 'NO',
  door: 'DOOR',
};

/** Every way out of a step: a button, or its timer running out. */
export const EVENTS = [...ROLES, 'timeout'];

export const EVENT_LABELS = {
  ...ROLE_LABELS,
  timeout: 'time',
};

/** The step with this id, or null. */
export function stepById(game, id) {
  return (game?.steps || []).find((s) => s.id === id) || null;
}

/** Where the show waits, and where it goes back to: the start step, or the first. */
export function startStep(game) {
  return stepById(game, game?.start) || game?.steps?.[0] || null;
}

/** Seconds a step waits before its timer moves it on, or 0 for never. */
export function timerSeconds(step) {
  const seconds = Number(step?.after?.seconds);
  return step?.after?.to && Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

/**
 * Where `event` leads from `step`, as a step id, or null if nowhere.
 *
 * A link to a step that has since been deleted leads nowhere, rather than to
 * an id the runtime would then have to guess about.
 */
export function nextFor(game, step, event) {
  if (!step) return null;
  const to = event === 'timeout' ? (timerSeconds(step) ? step.after.to : null) : step.on?.[event] || null;
  return to && stepById(game, to) ? to : null;
}

/** Every way out of a step that leads somewhere: `[{ on, to }]`, buttons first. */
export function exitsOf(game, step) {
  const out = [];
  for (const on of EVENTS) {
    const to = nextFor(game, step, on);
    if (to) out.push({ on, to });
  }
  return out;
}

/**
 * Which button a press from this button id is.
 *
 * Mapped buttons first. A press naming a role directly — which is what the
 * remote and the panel's buttons send — is honoured as that role, so it all
 * works before any hardware is mapped.
 */
export function roleOf(game, button) {
  const id = String(button ?? '');
  const buttons = game?.buttons || {};
  if (Object.hasOwn(buttons, id) && ROLES.includes(buttons[id])) return buttons[id];
  return ROLES.includes(id) ? id : null;
}

/**
 * Every scene a step shows.
 *
 * These belong to the automation the way a slide belongs to a deck, so they
 * are kept off the transport's scene buttons and the remote's.
 */
export function gameSceneIds(game) {
  const ids = new Set();
  for (const step of game?.steps || []) if (step.sceneId) ids.add(step.sceneId);
  return ids;
}

/** Step ids reachable from the start, following every button and timer. */
export function reachable(game) {
  const seen = new Set();
  const start = startStep(game);
  if (!start) return seen;
  const queue = [start.id];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const { to } of exitsOf(game, stepById(game, id))) queue.push(to);
  }
  return seen;
}

/**
 * What is wrong with an automation, worded for the person building it.
 *
 * Nothing here stops it running — each gap just means a moment on the night
 * where the house does nothing, which is worth knowing at the desk.
 */
export function gameProblems(game, project) {
  const problems = [];
  const steps = game?.steps || [];
  if (!steps.length) return ['There are no steps yet. Add one, or build the example.'];
  const scenes = new Set((project?.scenes || []).map((s) => s.id));
  const start = startStep(game);
  const reach = reachable(game);

  for (const step of steps) {
    const name = `"${step.name || 'Untitled'}"`;
    if (step.sceneId && !scenes.has(step.sceneId)) problems.push(`${name} shows a scene that no longer exists.`);
    for (const on of EVENTS) {
      const to = on === 'timeout' ? step.after?.to : step.on?.[on];
      if (to && !stepById(game, to)) problems.push(`${name} leads to a step that no longer exists.`);
    }
    if (step !== start && !exitsOf(game, step).length) {
      problems.push(`Nothing moves on from ${name} — give it a button or a timer, or the show stops there.`);
    }
    if (!reach.has(step.id)) problems.push(`Nothing leads to ${name}, so it never plays.`);
  }

  const used = new Set(steps.flatMap((s) => ROLES.filter((r) => s.on?.[r])));
  const mapped = new Set(Object.values(game.buttons || {}));
  if (Object.keys(game.buttons || {}).length) {
    for (const role of used) {
      if (!mapped.has(role)) problems.push(`A step listens for ${ROLE_LABELS[role]}, but no button is mapped to it.`);
    }
  }
  return problems;
}
