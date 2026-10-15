/**
 * The example dare game: a whole evening, built in one click.
 *
 * An empty game is a long form of dropdowns that all say "— nothing —", and
 * the fastest way to understand what each one is for is to see it filled in.
 * So this builds a complete, playable game out of the built-in effects, to this
 * script:
 *
 *   TRICK OR TREAT?
 *     NO   → DID YOU SAY… TRICK?
 *              NO → BUT WE LOVE TO SCARE…
 *                     NO → COME AND GET YOUR TREAT.
 *     YES  → lightning and smoke                       → SCARED YET?
 *                                                          YES → COME AND GET YOUR TREAT.
 *     NO   → the flowers die, a creature at the windows → SCARED YET?
 *     NO   → tentacles out of the walls
 *          → WE'RE ALL OUT OF TRICKS. COME AND GET YOUR TREAT.
 *   DOOR, when they are ready to come forward → the house wakes up at the door
 *   sweets, then HAPPY HALLOWEEN!, read as they walk away
 *
 * YES at any of the NO questions goes straight to the first scare. The house
 * keeps what each scare reveals, so the second "scared yet?" is asked over dead
 * flowers and a creature in the window, and the group can see how far they have
 * come. "Scared yet?" turns the buttons round: NO, not yet, is another trick,
 * and YES is the treat. The DOOR button only does anything once
 * they have been invited up: it is them saying they are coming forward.
 *
 * Every question, send-off and reward is the same **Message** layer with
 * different words: each scene stores the text it shows, so rewording a moment
 * is editing one field in the game editor, and nothing has to be restyled to
 * match.
 *
 * Like the starter presets, everything here targets tags, so it lands on the
 * house that has been traced rather than on the demo's. Nothing is special-
 * cased: every layer, scene and trigger is one you could have made by hand,
 * and all of it is editable afterwards.
 */

import { createLayer, createScene, createTrigger } from '../core/state.js';
import { defaultParams } from '../effects/registry.js';
import { captureScene } from '../core/scenes.js';

/** Marks everything the example made, so it can be found and rebuilt. */
export const EXAMPLE = 'dare';

/** Seconds each scare holds before the next question. Climbing, like the dread. */
const HOLDS = [6, 7, 8];
const FINALE_HOLD = 10;

/**
 * Words first: lines said over whatever is already on the wall before the next
 * thing happens by itself. The script has none — every line in it is a
 * question or an answer — but the editor makes them a click away.
 */
export const EXAMPLE_BEATS = {};

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
 * Build the example into a project: layers, scenes, triggers, and the game
 * pointed at all of them. Replaces an earlier example if there is one, and
 * leaves everything else in the show alone.
 *
 * @returns {{ scenes: number, triggers: number, layers: number, missing: string[], flowers: boolean }}
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
   * One scene: these layers on and everything else off, the message saying
   * `words` (or switched off when there are none), and any per-scene tweaks to
   * a layer's parameters.
   */
  const scene = (name, on, { words = null, fade = 0.6, tweak = {} } = {}) => {
    for (const l of project.layers) l.enabled = false;
    for (const key of on) cast[key].enabled = true;
    const saved = {};
    for (const [key, params] of Object.entries(tweak)) {
      saved[key] = { ...cast[key].params };
      Object.assign(cast[key].params, params);
    }
    if (words) {
      cast.message.enabled = true;
      cast.message.params.content = words;
    }
    const built = createScene({ name: `Dare · ${name}`, fade, full: true, state: captureScene(project), example: EXAMPLE });
    for (const [key, params] of Object.entries(saved)) cast[key].params = params;
    cast.message.params.content = EXAMPLE_WORDS.attract;
    project.scenes.push(built);
    return built;
  };

  // The house before anything has happened — flowers in bloom — and after the
  // first scare, when they have died. Every later scene keeps them dead.
  // Before anything has happened the flowers are in bloom; the second scare
  // kills them, and every scene after it keeps them dead.
  const fresh = hasPlanter ? ['flowers'] : [];
  const dead = hasPlanter ? ['flowersDying'] : [];
  const base = ['wash', 'brick', 'fog', ...fresh];
  const smoky = [...base, 'smoke'];
  const ruined = ['wash', 'brick', 'fog', 'smoke', ...dead];
  // What the house looks like after each scare: it keeps what it has shown.
  const afterRung = [base, smoky, [...ruined, 'creature'], [...ruined, 'creature', 'tentacles', 'blood']];
  const W = EXAMPLE_WORDS;

  const attract = scene('Trick or treat?', base, { words: W.attract, fade: 1.2 });
  const scenes = {
    attract,
    // The waiting screen is question 1; the questions after it are "scared yet?",
    // each over everything shown so far.
    ask: [attract, scene('Scared yet? (after the lightning)', afterRung[1], { words: W.more }), scene('Scared yet? (after the creature)', afterRung[2], { words: W.more })],
    persuade: W.persuade.map((words, i) => scene(`Said no ${i + 1}`, base, { words, tweak: { message: { animation: i ? 'jitter' : 'wave' } } })),
    /**
     * Come and get your treat, by how far they got: said over whatever the
     * house had become when they said NO — or, after the last trick, the house
     * owning up that it has nothing left. The door glows: that is where to go.
     */
    approach: [
      ...afterRung.slice(0, 3).map((look, i) => scene(`Come and get your treat ${i + 1}`, [...look, 'doorGlow'], { words: W.treat, tweak: { message: { animation: 'fade', color: '#ffd23a' } } })),
      scene('Out of tricks', [...afterRung[3], 'doorGlow', 'candles'], { words: W.outOfTricks }),
    ],
    waiting: scene('Waiting for a treat', [...ruined, 'candles', 'doorGlow', 'eyes'], { fade: 1 }),
    reward: scene('Happy Halloween', ['wash', 'brick', 'candles', 'fireworks'], { words: W.goodbye, fade: 0.4, tweak: { message: { animation: 'pop', color: '#ffd23a' } } }),
  };

  const scares = [
    // Lightning, and the smoke rolls in. A real smoke machine can join in from
    // Home Assistant on the cue for this scare: facade/game/cue, level 1.
    scene('Scare: lightning and smoke', [...afterRung[1], 'lightning'], { fade: 0.15, tweak: { lightning: { rate: 16, flash: 0.7 }, smoke: { density: 0.7 } } }),
    // The flowers die — the dying bunch comes on here, so its six seconds of
    // wilting start with the scare — and the creature appears at the windows.
    scene('Scare: the flowers die, a creature at the windows', afterRung[2], { fade: 0.15 }),
    scene('Scare: tentacles from the walls', afterRung[3], { fade: 0.15 }),
  ];
  const finaleScene = scene('Finale: the house wakes up', [...afterRung[3], 'eyes', 'bats', 'lightning', 'doorGlow'], {
    fade: 0.1,
    tweak: { doorGlow: { color: '#ff1a1a', rate: 2.2, min: 0.4, max: 1 }, lightning: { rate: 18 } },
  });

  const trigger = (name, sceneId, hold) =>
    createTrigger({ name: `Dare · ${name}`, source: 'manual', sceneId, hold, cooldown: 0, example: EXAMPLE });
  const rungs = [
    trigger('Lightning and smoke', scares[0].id, HOLDS[0]),
    trigger('Flowers die, creature at the windows', scares[1].id, HOLDS[1]),
    trigger('Tentacles from the walls', scares[2].id, HOLDS[2]),
  ];
  const finale = trigger('The house wakes up', finaleScene.id, FINALE_HOLD);
  project.triggers = project.triggers || [];
  project.triggers.push(...rungs, finale);

  for (const { l, enabled } of before) l.enabled = enabled;

  const game = project.game;
  game.enabled = true;
  game.door = true;
  game.openingQuestion = true;
  game.persuade = W.persuade.length;
  game.rungs = rungs.map((t) => t.id);
  game.finale = finale.id;
  game.scenes = {
    attract: scenes.attract.id,
    ask: scenes.ask.map((s) => s.id),
    persuade: scenes.persuade.map((s) => s.id),
    approach: scenes.approach.map((s) => s.id),
    waiting: scenes.waiting.id,
    reward: scenes.reward.id,
  };


  game.beats = JSON.parse(JSON.stringify(EXAMPLE_BEATS));
  game.messageLayer = cast.message.id;

  const missing = ['wall', 'door', 'window'].filter((t) => !tagsPresent.has(t));
  return {
    scenes: project.scenes.filter((s) => s.example === EXAMPLE).length,
    triggers: rungs.length + 1,
    layers: order.length,
    missing,
    // No flowers without something to grow them from: worth saying, because
    // a scare that is only a creature looks like a bug rather than a choice.
    flowers: hasPlanter,
    attract: scenes.attract.id,
  };
}

/** Is there an example game in this show already? */
export function hasExampleGame(project) {
  return (project.layers || []).some((l) => l.example === EXAMPLE);
}

/** Take the example out again: its layers, scenes and triggers, and the game's references to them. */
export function removeExampleGame(project) {
  const sceneIds = new Set((project.scenes || []).filter((s) => s.example === EXAMPLE).map((s) => s.id));
  const triggerIds = new Set((project.triggers || []).filter((t) => t.example === EXAMPLE).map((t) => t.id));
  const layerIds = new Set((project.layers || []).filter((l) => l.example === EXAMPLE).map((l) => l.id));
  if (!sceneIds.size && !triggerIds.size && !layerIds.size) return false;

  project.layers = project.layers.filter((l) => !layerIds.has(l.id));
  project.scenes = project.scenes.filter((s) => !sceneIds.has(s.id));
  project.triggers = (project.triggers || []).filter((t) => !triggerIds.has(t.id));
  // Other scenes captured while the example existed name its layers; harmless,
  // but tidier gone.
  for (const s of project.scenes) for (const id of layerIds) delete s.state?.[id];

  const show = project.show || {};
  if (sceneIds.has(show.activeScene)) show.activeScene = null;
  if (sceneIds.has(show.previousScene)) show.previousScene = null;
  if (sceneIds.has(show.sceneLoaded)) show.sceneLoaded = null;

  const game = project.game;
  if (game) {
    game.rungs = game.rungs.filter((id) => !triggerIds.has(id));
    if (triggerIds.has(game.finale)) game.finale = null;
    if (layerIds.has(game.messageLayer)) {
      game.messageLayer = null;
      game.beats = {};
    }
    for (const [key, slot] of Object.entries(game.scenes)) {
      if (Array.isArray(slot)) game.scenes[key] = slot.filter((id) => !sceneIds.has(id));
      else if (sceneIds.has(slot)) game.scenes[key] = null;
    }
  }
  return true;
}
