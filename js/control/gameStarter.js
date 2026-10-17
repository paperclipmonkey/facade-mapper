/**
 * The example automation: a whole evening, built in one click.
 *
 * An empty automation is a blank page, and the fastest way to understand what
 * a step is for is to see some filled in. So this builds a complete, playable
 * one out of the built-in effects, to this script:
 *
 *   Trick or treat?             YES → Lightning and smoke · NO → Did you say trick?
 *   Did you say trick?          YES → Lightning and smoke · NO → But we love to scare
 *   But we love to scare        YES → Lightning and smoke · NO → Come and get your treat
 *   Lightning and smoke         after 6 s → Scared yet?
 *   Scared yet?                 NO → Flowers die, creature · YES → Come and get your treat
 *   Flowers die, creature       after 7 s → Scared yet? (again)
 *   Scared yet? (again)         NO → Tentacles · YES → Come and get your treat
 *   Tentacles                   after 8 s → Out of tricks
 *   Out of tricks               DOOR → At the door
 *   Come and get your treat     DOOR → At the door
 *   At the door                 after 10 s → Sweets
 *   Sweets                      after 30 s → Happy Halloween
 *   Happy Halloween             after 8 s → Trick or treat?
 *
 * Every question goes back to "Trick or treat?" after two minutes with
 * nothing pressed. The house keeps what each scare reveals, so the second
 * "Scared yet?" is asked over dead flowers and a creature in the window.
 *
 * The words are the steps', written over whatever is up on one **Message**
 * layer, so a step can say something new without changing the house, and
 * rewording a step is one field.
 *
 * Like the starter presets, everything here targets tags, so it lands on the
 * house that has been traced rather than on the demo's. Nothing is special-
 * cased: every layer, scene and step is one you could have made by hand, and
 * all of it is editable afterwards.
 */

import { createLayer, createScene, createStep } from '../core/state.js';
import { defaultParams } from '../effects/registry.js';
import { captureScene } from '../core/scenes.js';

/** Marks everything the example made, so it can be found and rebuilt. */
export const EXAMPLE = 'dare';

/** Seconds each scare plays before the next question. Climbing, like the dread. */
const HOLDS = [6, 7, 8];
const FINALE_HOLD = 10;

/**
 * The words. Short, because they are read in the dark from the end of a path
 * by people who are also deciding whether to run, and in capitals because
 * that is the only case that survives being projected onto brick.
 */
export const EXAMPLE_WORDS = {
  // The waiting screen is the first question. YES is the trick; it says so,
  // because a YES/NO button is otherwise no answer to "trick or treat?".
  attract: 'TRICK OR TREAT?\nYES FOR A TRICK',
  persuade: ['DID YOU SAY…\nTRICK?', 'BUT WE LOVE\nTO SCARE…'],
  // After a trick: NO, not scared yet, is another; YES is enough.
  more: 'SCARED\nYET?',
  treat: 'COME AND GET\nYOUR TREAT.',
  outOfTricks: "WE'RE ALL OUT OF TRICKS.\nCOME AND GET YOUR TREAT.",
  // Read on the way back down the path, so it can be words again.
  goodbye: 'HAPPY HALLOWEEN!',
}

function layer(effect, name, { tags = [], params = {}, ...rest } = {}) {
  return createLayer(effect, {
    name,
    targetTags: tags,
    params: { ...defaultParams(effect), ...params },
    enabled: false,
    example: EXAMPLE,
    ...rest,
  });
}

/** A hanging basket of something cheerful, before the house gets to it. */
const FLOWERS = {
  color: '#e4557a', color2: '#f0b33c', centre: '#ffe9a8', stem: '#4f8b3b', dry: '#7d5a33',
  count: 9, height: 0.8, size: 0.11, petals: 5, spread: 0.45, leaves: 0.6, wind: 0.5, gust: 0.6,
  wilt: 0, fly: 1.4, seed: 7,
};

/**
 * The tag the flowers grow from. `planter` is the one the docs ask for, but a
 * hanging basket traced as `basket` or `flowers` is the same thing, and an
 * empty pot on the night because of a word is a poor reason.
 */
export const PLANTER_TAGS = ['planter', 'basket', 'hanging-basket', 'flowers', 'pot', 'plant'];

export function planterTag(tagsPresent) {
  return PLANTER_TAGS.find((t) => tagsPresent.has(t)) || null;
}

/** The cast. Every scene below is some of these, switched on. */
function buildLayers(tagsPresent) {
  // A flat panel tagged `primary` is the best place for words; the whole wall
  // is the fallback, and still readable from the path.
  const messageTags = tagsPresent.has('primary') ? ['primary'] : ['wall'];
  const planter = planterTag(tagsPresent) || 'planter';
  return {
    wash: layer('wash', 'Night', { params: { color: '#12061f', color2: '#000814', blend: 0.4, level: 0.35, vignette: 0.45 } }),
    brick: layer('brickwork', 'Brick', {
      tags: ['wall'],
      params: {
        color: '#8f4a33', color2: '#5f3024', mortar: '#2b2621',
        brickW: 76, brickH: 24, gap: 5, variation: 0.6, relief: 0.7, obstacles: 'window, door', seed: 1,
      },
    }),
    candles: layer('candle', 'Candles in the windows', {
      tags: ['window'],
      params: { temperature: 1850, level: 0.7, jitter: 0.35, rate: 3.5, candles: 3 },
    }),
    // Something in every window that is not a person: the creature walks
    // the lamplit room, stops, and looks out.
    creature: layer('silhouette', 'Creature at the windows', {
      tags: ['window'],
      params: { color: '#ff9b4a', figure: 'creature', speed: 0.14, size: 0.95, direction: 'pace', pause: 0.6, level: 0.85 },
    }),
    tentacles: layer('breach', 'Tentacles through the brick', {
      tags: ['wall'],
      params: {
        // A scare, not an ambience: a hole every few seconds, so something is
        // out of the wall well inside the eight seconds the scare lasts, but
        // slow and deliberate as it comes. Faster than this was frantic: a
        // wall boiling with arms reads as a glitch, one arm feeling its way
        // out reads as something alive.
        match: true, rate: 20, cluster: 8, holes: 3, heal: 60, crawl: 140, wander: 0.35,
        brick: '#7d4130', void: '#08040c', innerGlow: '#4bff8f', glowAmount: 0.9,
        arms: 3, armColor: '#24402c', armTip: '#597a37', thickness: 30, suckers: 0.85, armGlow: 0.5,
        reach: 1, writhe: 0.55, dust: 0.8, gravity: 1400, obstacles: 'window, door', seed: 3,
      },
    }),
    eyes: layer('eyes', 'Eyes in every window', {
      tags: ['window'],
      params: { color: '#ffe74c', pupil: '#1a0000', pairs: 2, size: 0.18, blink: 0.25, wander: 0.2, glow: 1.4 },
    }),
    // Down the door with the tentacles, and running within a second: the
    // default pace is a slow ooze for a house that is just creepy.
    blood: layer('blood-drip', 'Blood down the door', {
      tags: ['door'],
      params: { color: '#7a0008', highlight: '#d61c22', count: 8, speed: 0.32, width: 18, variation: 0.55, pool: 0.06 },
    }),
    doorGlow: layer('pulse', 'Door glow', {
      tags: ['door'],
      blend: 'lighter',
      params: { color: '#ff8a2b', mode: 'both', rate: 0.34, wave: 'sine', min: 0.12, max: 0.85, width: 16, grow: 0.012 },
    }),
    bats: layer('bats', 'Bats', {
      params: { color: '#12040f', count: 24, size: 0.08, speed: 0.3, flap: 8, spread: 0.8, wander: 0.5, direction: 'right', interval: 4, crossing: 4 },
    }),
    fireworks: layer('fireworks', 'Fireworks'),
    /**
     * Flowers, twice: the same bunch, fresh and dying.
     *
     * The dying one wilts as it ages — `age` is seconds since the layer came
     * on — so the scene that swaps one for the other is the moment they die:
     * six seconds of drooping heads, greying stems and petals blowing down the
     * wall, and then dead for the rest of the visit. Same seed and the same
     * values, so at its first instant the dying bunch *is* the fresh one and
     * the swap itself is invisible.
     */
    flowers: layer('flowers', 'Hanging flowers', { tags: [planter], params: FLOWERS }),
    flowersDying: layer('flowers', 'Hanging flowers dying', {
      tags: [planter],
      params: FLOWERS,
      bindings: { wilt: { type: 'expr', code: 'clamp(age / 6, 0, 1)' } },
    }),
    smoke: layer('smoke', 'Smoke', {
      tags: tagsPresent.has('chimney') ? ['chimney'] : [],
      opacity: 0.8,
      params: { color: '#9aa3ad', shadow: '#2c3138', density: 0.45, rise: 0.3, spread: 0.6, swirl: 0.8, scale: 2.6 },
    }),
    fog: layer('fog', 'Ground fog', { softness: 6, params: { color: '#7a8ba0', density: 0.18, scale: 2.4, speed: 0.05, swirl: 0.6, height: 0.4 } }),
    lightning: layer('lightning', 'Lightning', {
      params: { temperature: 9000, rate: 9, flash: 0.6, bolt: true, thickness: 5, branches: 4, flickers: 3, duration: 0.5 },
    }),
    message: layer('text', 'Message', {
      tags: messageTags,
      params: {
        content: EXAMPLE_WORDS.attract, mode: 'box', font: 'impact', weight: '900', size: 0.55,
        tracking: 0.05, color: '#ff7a18', stroke: '#1a0500', strokeWidth: 5, glow: 24,
        align: 'centre', animation: 'flicker', speed: 0.8, amount: 0.35, fit: true,
      },
    }),
  };
}

/**
 * Build the example into a project: layers, the scenes they make, and the
 * steps that move between them. Replaces an earlier example if there is one,
 * and leaves everything else in the show alone.
 *
 * @returns {{ scenes: number, steps: number, layers: number, missing: string[], flowers: boolean, start: string }}
 */
export function buildExampleGame(project) {
  removeExampleGame(project);

  const tagsPresent = new Set((project.shapes || []).flatMap((s) => s.tags || []));
  const cast = buildLayers(tagsPresent);
  const maxOrder = project.layers.reduce((max, l) => Math.max(max, l.order || 0), -1);
  // Draw order: the wash first and the words last, everything else as listed.
  // Flowers only where something is tagged to grow them from: with nothing to
  // target they would fill the whole frame.
  const hasPlanter = !!planterTag(tagsPresent);
  const order = ['wash', 'brick', 'candles', 'creature', 'tentacles', 'blood', 'eyes', 'doorGlow', 'bats', 'fireworks',
    ...(hasPlanter ? ['flowers', 'flowersDying'] : []), 'smoke', 'fog', 'lightning', 'message'];
  order.forEach((key, i) => {
    cast[key].order = maxOrder + 1 + i;
    project.layers.push(cast[key]);
  });

  // Remember the show as it is, so building the example changes nothing on
  // the wall: every scene is captured from a state set up and then undone.
  const before = project.layers.map((l) => ({ l, enabled: l.enabled }));

  /**
   * One look of the house: these layers on and everything else off, with any
   * per-scene tweaks to a layer's parameters. No words: those belong to the
   * steps, so one look can carry several different questions.
   */
  const scene = (name, on, { fade = 0.6, tweak = {} } = {}) => {
    for (const l of project.layers) l.enabled = false;
    for (const key of on) cast[key].enabled = true;
    const saved = {};
    for (const [key, params] of Object.entries(tweak)) {
      saved[key] = { ...cast[key].params };
      Object.assign(cast[key].params, params);
    }
    const built = createScene({ name: `Example · ${name}`, fade, full: true, state: captureScene(project), example: EXAMPLE });
    for (const [key, params] of Object.entries(saved)) cast[key].params = params;
    project.scenes.push(built);
    return built;
  };

  // Before anything has happened the flowers are in bloom; the second scare
  // kills them, and every look after it keeps them dead.
  const fresh = hasPlanter ? ['flowers'] : [];
  const dead = hasPlanter ? ['flowersDying'] : [];
  const house = ['wash', 'brick', 'fog', ...fresh];
  const smoky = [...house, 'smoke'];
  const ruined = ['wash', 'brick', 'fog', 'smoke', ...dead];
  const tentacled = [...ruined, 'creature', 'tentacles', 'blood'];

  const looks = {
    house: scene('The house', house, { fade: 1.2 }),
    // Lightning, and the smoke rolls in. A real smoke machine can join in from
    // Home Assistant: it is told every step the show moves to.
    lightning: scene('Lightning and smoke', [...smoky, 'lightning'], { fade: 0.15, tweak: { lightning: { rate: 16, flash: 0.7 }, smoke: { density: 0.7 } } }),
    smoky: scene('Smoke', smoky, { fade: 1 }),
    // The flowers die — the dying bunch comes on here, so its six seconds of
    // wilting start with it — and the creature appears at the windows.
    creature: scene('Flowers die, creature at the windows', [...ruined, 'creature'], { fade: 0.15 }),
    tentacles: scene('Tentacles from the walls', tentacled, { fade: 0.15 }),
    door: scene('The house wakes up', [...tentacled, 'eyes', 'bats', 'lightning', 'doorGlow'], {
      fade: 0.1,
      tweak: { doorGlow: { color: '#ff1a1a', rate: 2.2, min: 0.4, max: 1 }, lightning: { rate: 18 } },
    }),
    sweets: scene('Sweets', [...ruined, 'candles', 'doorGlow', 'eyes'], { fade: 1 }),
    goodbye: scene('Goodbye', ['wash', 'brick', 'candles', 'fireworks'], { fade: 0.4 }),
  };

  for (const { l, enabled } of before) l.enabled = enabled;

  /**
   * The script, as steps.
   *
   * A step with words and no scene keeps the house as it is and only changes
   * what it says — which is how "Scared yet?" is asked over whatever the last
   * scare left behind. Every question goes back to the start after two
   * minutes with nothing pressed; the remote can do the same at once.
   */
  const W = EXAMPLE_WORDS;
  const QUESTION_WAIT = 120;
  const ids = {};
  const names = [
    'trickOrTreat', 'didYouSay', 'loveToScare', 'lightning', 'scared', 'creature', 'scaredAgain',
    'tentacles', 'outOfTricks', 'treat', 'door', 'sweets', 'goodbye',
  ];
  for (const name of names) ids[name] = createStep().id;
  const step = (key, fields) => createStep({ id: ids[key], example: EXAMPLE, ...fields });
  const back = { seconds: QUESTION_WAIT, to: ids.trickOrTreat };
  const steps = [
    step('trickOrTreat', { name: 'Trick or treat?', sceneId: looks.house.id, words: W.attract, on: { yes: ids.lightning, no: ids.didYouSay } }),
    step('didYouSay', { name: 'Did you say trick?', words: W.persuade[0], on: { yes: ids.lightning, no: ids.loveToScare }, after: back }),
    step('loveToScare', { name: 'But we love to scare', words: W.persuade[1], on: { yes: ids.lightning, no: ids.treat }, after: back }),
    step('lightning', { name: 'Lightning and smoke', sceneId: looks.lightning.id, after: { seconds: HOLDS[0], to: ids.scared } }),
    step('scared', { name: 'Scared yet?', sceneId: looks.smoky.id, words: W.more, on: { yes: ids.treat, no: ids.creature }, after: back }),
    step('creature', { name: 'Flowers die, creature', sceneId: looks.creature.id, after: { seconds: HOLDS[1], to: ids.scaredAgain } }),
    step('scaredAgain', { name: 'Scared yet? (again)', words: W.more, on: { yes: ids.treat, no: ids.tentacles }, after: back }),
    step('tentacles', { name: 'Tentacles', sceneId: looks.tentacles.id, after: { seconds: HOLDS[2], to: ids.outOfTricks } }),
    step('outOfTricks', { name: 'Out of tricks', words: W.outOfTricks, alert: true, on: { door: ids.door }, after: back }),
    step('treat', { name: 'Come and get your treat', words: W.treat, alert: true, on: { door: ids.door }, after: back }),
    step('door', { name: 'At the door', sceneId: looks.door.id, alert: true, after: { seconds: FINALE_HOLD, to: ids.sweets } }),
    step('sweets', { name: 'Sweets', sceneId: looks.sweets.id, after: { seconds: 30, to: ids.goodbye } }),
    step('goodbye', { name: 'Happy Halloween', sceneId: looks.goodbye.id, words: W.goodbye, after: { seconds: 8, to: ids.trickOrTreat } }),
  ];

  const game = project.game;
  game.steps = [...game.steps.filter((s) => s.example !== EXAMPLE), ...steps];
  game.start = ids.trickOrTreat;
  game.enabled = true;
  game.messageLayer = cast.message.id;

  const missing = ['wall', 'door', 'window'].filter((t) => !tagsPresent.has(t));
  return {
    scenes: Object.keys(looks).length,
    steps: steps.length,
    layers: order.length,
    missing,
    // No flowers without something to grow them from: worth saying, because
    // a scare that is only a creature looks like a bug rather than a choice.
    flowers: hasPlanter,
    start: looks.house.id,
  };
}

/** Is there an example in this show already? */
export function hasExampleGame(project) {
  return (project.layers || []).some((l) => l.example === EXAMPLE);
}

/** Take the example out again: its layers, scenes and steps, and anything pointing at them. */
export function removeExampleGame(project) {
  const sceneIds = new Set((project.scenes || []).filter((s) => s.example === EXAMPLE).map((s) => s.id));
  const layerIds = new Set((project.layers || []).filter((l) => l.example === EXAMPLE).map((l) => l.id));
  const game = project.game;
  const stepIds = new Set((game?.steps || []).filter((s) => s.example === EXAMPLE).map((s) => s.id));
  if (!sceneIds.size && !layerIds.size && !stepIds.size) return false;

  project.layers = project.layers.filter((l) => !layerIds.has(l.id));
  project.scenes = project.scenes.filter((s) => !sceneIds.has(s.id));
  // Other scenes captured while the example existed name its layers; harmless,
  // but tidier gone.
  for (const s of project.scenes) for (const id of layerIds) delete s.state?.[id];

  const show = project.show || {};
  if (sceneIds.has(show.activeScene)) show.activeScene = null;
  if (sceneIds.has(show.previousScene)) show.previousScene = null;
  if (sceneIds.has(show.sceneLoaded)) show.sceneLoaded = null;
  show.caption = null;

  if (game) {
    game.steps = game.steps.filter((s) => !stepIds.has(s.id));
    for (const step of game.steps) {
      if (sceneIds.has(step.sceneId)) step.sceneId = null;
      for (const role of Object.keys(step.on || {})) if (stepIds.has(step.on[role])) step.on[role] = null;
      if (stepIds.has(step.after?.to)) step.after.to = null;
    }
    if (stepIds.has(game.start)) game.start = null;
    if (layerIds.has(game.messageLayer)) game.messageLayer = null;
  }
  return true;
}
