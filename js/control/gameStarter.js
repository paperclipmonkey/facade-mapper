/**
 * The example dare game: a whole evening, built in one click.
 *
 * An empty game is a long form of dropdowns that all say "— nothing —", and
 * the fastest way to understand what each one is for is to see it filled in.
 * So this builds a complete, playable game out of the built-in effects:
 *
 *   waiting   brick and smoke, and the dare
 *   rung 1    blood down the door, and the flowers beside it wilt and die
 *   rung 2    people at the windows
 *   rung 3    tentacles out of the brickwork
 *   the door  everything at once — and no words, because they are too close
 *
 * The house *keeps* what each rung reveals. The second question is asked over
 * the blood that is still running from the first scare, the third over the
 * blood and the figures, so the horror accumulates the way it should and the
 * group can see how far they have come.
 *
 * Every question, send-off and reward is the same **Message** layer with
 * different words: each scene stores the text it shows, so rewording a moment
 * is editing one field on its card in the Game panel, and nothing has to be
 * restyled to match.
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
 * The words. Short, because they are read in the dark from the end of a path
 * by people who are also deciding whether to run, and in capitals because
 * that is the only case that survives being projected onto brick.
 */
/**
 * Words first: lines said over whatever is already on the wall, each for a
 * moment, before the next thing happens by itself — the dare before the
 * question, the warning before the scare. Nothing at the door: they could not
 * read it from there.
 */
export const EXAMPLE_BEATS = {
  ask: [[{ text: 'SO…', seconds: 1.4 }, { text: 'YOU DARE.', seconds: 2 }], [], []],
  scare: [
    [{ text: 'YOU ASKED FOR IT…', seconds: 2.2 }],
    [{ text: "DON'T SAY WE\nDIDN'T WARN YOU…", seconds: 2.4 }],
    [{ text: 'TOO LATE', seconds: 1.2 }, { text: 'TO RUN…', seconds: 1.6 }],
  ],
  reward: [[{ text: 'THE HOUSE\nLETS YOU GO…', seconds: 2.4 }]],
};

export const EXAMPLE_WORDS = {
  attract: 'DARE YOU?\nPRESS YES',
  ask: ['SOMETHING LIVES HERE.\nLOOK CLOSER?', "IT'S BLEEDING.\nKEEP GOING?", "THEY'VE SEEN YOU.\nCLOSER?"],
  approach: 'NOW…\nCOME TO THE DOOR',
  chicken: ['WISE CHOICE.', 'SO CLOSE…', 'ALMOST HAD YOU!'],
  nudge: 'HELLO…?\nANYONE THERE?',
  decide: "CAN'T DECIDE?\nWE'LL DECIDE FOR YOU…",
  mercy: "IT'S ONLY A HOUSE.\nYOU'RE SAFE.",
  reward: 'YOU SURVIVED!',
};

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

/** The cast. Every scene below is some of these, switched on. */
function buildLayers(tagsPresent) {
  // A flat panel tagged `primary` is the best place for words; the whole wall
  // is the fallback, and still readable from the path.
  const messageTags = tagsPresent.has('primary') ? ['primary'] : ['wall'];
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
    people: layer('silhouette', 'People at the windows', {
      tags: ['window'],
      params: { color: '#ff9b4a', figure: 'person', speed: 0.14, size: 0.9, direction: 'pace', pause: 0.5, level: 0.85 },
    }),
    blood: layer('blood-drip', 'Blood down the door', {
      tags: ['door'],
      params: { color: '#7a0008', highlight: '#d61c22', count: 9, speed: 0.16, width: 20, variation: 0.65, pool: 0.08 },
    }),
    tentacles: layer('breach', 'Tentacles through the brick', {
      tags: ['wall'],
      params: {
        // A scare, not an ambience: a hole every second and a half, the first
        // within a second, so something is out of the wall well inside the
        // eight seconds the scare lasts. The Breach default opens one every
        // twelve, which is the right pace for a house that is just creepy.
        match: true, rate: 40, cluster: 8, holes: 4, heal: 60, crawl: 260,
        brick: '#7d4130', void: '#08040c', innerGlow: '#4bff8f', glowAmount: 0.9,
        arms: 4, armColor: '#24402c', armTip: '#597a37', thickness: 30, suckers: 0.85, armGlow: 0.5,
        reach: 1, writhe: 1.2, dust: 0.8, gravity: 1400, obstacles: 'window, door', seed: 3,
      },
    }),
    eyes: layer('eyes', 'Eyes in every window', {
      tags: ['window'],
      params: { color: '#ffe74c', pupil: '#1a0000', pairs: 2, size: 0.18, blink: 0.25, wander: 0.2, glow: 1.4 },
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
    flowers: layer('flowers', 'Hanging flowers', { tags: ['planter'], params: FLOWERS }),
    flowersDying: layer('flowers', 'Hanging flowers dying', {
      tags: ['planter'],
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
 * @returns {{ scenes: number, triggers: number, layers: number, missing: string[] }}
 */
export function buildExampleGame(project) {
  removeExampleGame(project);

  const tagsPresent = new Set((project.shapes || []).flatMap((s) => s.tags || []));
  const cast = buildLayers(tagsPresent);
  const maxOrder = project.layers.reduce((max, l) => Math.max(max, l.order || 0), -1);
  // Draw order: the wash first and the words last, everything else as listed.
  // Flowers only where something is tagged to grow them from: with nothing to
  // target they would fill the whole frame.
  const hasPlanter = tagsPresent.has('planter');
  const order = ['wash', 'brick', 'candles', 'people', 'blood', 'tentacles', 'eyes', 'doorGlow', 'bats', 'fireworks',
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
  const fresh = hasPlanter ? ['flowers'] : [];
  const dead = hasPlanter ? ['flowersDying'] : [];
  const base = ['wash', 'brick', 'smoke', 'fog', ...fresh];
  const ruined = ['wash', 'brick', 'smoke', 'fog', ...dead];
  const afterRung = [base, [...ruined, 'blood'], [...ruined, 'blood', 'people'], [...ruined, 'blood', 'people', 'tentacles']];
  const W = EXAMPLE_WORDS;

  const scenes = {
    attract: scene('Waiting for visitors', base, { words: W.attract, fade: 1.2 }),
    ask: W.ask.map((words, i) => scene(`Question ${i + 1}`, afterRung[i], { words })),
    approach: scene('Come to the door', [...afterRung[3], 'doorGlow'], { words: W.approach }),
    waiting: scene('Waiting for a treat', [...ruined, 'candles', 'doorGlow', 'eyes'], { fade: 1 }),
    reward: scene('You survived', ['wash', 'brick', 'candles', 'fireworks'], { words: W.reward, fade: 0.4, tweak: { message: { animation: 'pop', color: '#ffd23a' } } }),
    chicken: W.chicken.map((words, i) => scene(`Said no ${i + 1}`, afterRung[i], { words, tweak: { message: { animation: 'wave' } } })),
    nudge: scene('Anyone there?', base, { words: W.nudge, tweak: { message: { animation: 'typewriter' } } }),
    decide: scene("Can't decide", [...base, 'lightning'], { words: W.decide, fade: 0.2 }),
    mercy: scene("You're safe", ['brick', 'candles'], { words: W.mercy, fade: 0.3, tweak: { message: { color: '#ffd9a8', animation: 'fade' } } }),
    // Somebody ran straight to the door: no words — they could not read them —
    // just the door going red and fast, and then back to waiting.
    early: scene('Too soon', [...base, 'doorGlow'], { fade: 0.2, tweak: { doorGlow: { color: '#ff1a1a', rate: 3, min: 0.3, max: 1 } } }),
  };

  const scares = [
    // Blood down the door, and the flowers beside it die: the dying bunch
    // comes on here, so its six seconds of wilting start with the scare.
    scene('Scare: blood on the door', afterRung[1], { fade: 0.15 }),
    scene('Scare: people at the windows', [...afterRung[2], 'lightning'], { fade: 0.15 }),
    scene('Scare: tentacles', afterRung[3], { fade: 0.15 }),
  ];
  const finaleScene = scene('Finale: the house wakes up', [...afterRung[3], 'eyes', 'bats', 'lightning', 'doorGlow'], {
    fade: 0.1,
    tweak: { doorGlow: { color: '#ff1a1a', rate: 2.2, min: 0.4, max: 1 }, lightning: { rate: 18 } },
  });

  const trigger = (name, sceneId, hold) =>
    createTrigger({ name: `Dare · ${name}`, source: 'manual', sceneId, hold, cooldown: 0, example: EXAMPLE });
  const rungs = [
    trigger('Blood on the door', scares[0].id, HOLDS[0]),
    trigger('People at the windows', scares[1].id, HOLDS[1]),
    trigger('Tentacles', scares[2].id, HOLDS[2]),
  ];
  const finale = trigger('The house wakes up', finaleScene.id, FINALE_HOLD);
  project.triggers = project.triggers || [];
  project.triggers.push(...rungs, finale);

  for (const { l, enabled } of before) l.enabled = enabled;

  const game = project.game;
  game.enabled = true;
  game.door = true;
  game.rungs = rungs.map((t) => t.id);
  game.finale = finale.id;
  game.scenes = {
    attract: scenes.attract.id,
    early: scenes.early.id,
    ask: scenes.ask.map((s) => s.id),
    nudge: scenes.nudge.id,
    decide: scenes.decide.id,
    approach: scenes.approach.id,
    chicken: scenes.chicken.map((s) => s.id),
    mercy: scenes.mercy.id,
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
