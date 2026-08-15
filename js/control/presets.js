/**
 * Starter effect sets.
 *
 * These exist because the gap between "I have traced my house" and "it looks
 * like something" is otherwise a lot of fiddling. Each preset builds a complete,
 * coherent look out of the built-in effects, targeted by tag — so it lands on
 * whatever you have actually tagged, and adding another window later picks up
 * the same treatment automatically.
 *
 * Nothing here is special-cased in the engine. Every layer these produce is one
 * you could have built by hand in the inspector, and all of it is editable
 * afterwards.
 */

import { createLayer, createScene } from '../core/state.js';
import { defaultParams } from '../effects/registry.js';
import { captureScene } from '../core/scenes.js';
import { GRADE_PRESETS } from '../render/postfx.js';

/**
 * Build a layer with sensible defaults filled in for anything unspecified.
 *
 * `needsTag` marks a layer that is pointless without a particular tag, and
 * `applyPreset` drops it when the project has none. Most layers do not want
 * that — a Candle Flicker with no `window` traced is a layer waiting for you to
 * trace one, and dropping it would be unhelpful. But an effect whose no-targets
 * fallback is "cover the whole frame" turns actively wrong: text laid along a
 * path with nothing to lay it along wraps itself round the edge of the picture.
 */
function layer(effect, { name, targets = [], tags = [], params = {}, bindings = {}, needsTag, ...rest }) {
  const built = createLayer(effect, {
    name,
    targets,
    targetTags: tags,
    params: { ...defaultParams(effect), ...params },
    bindings,
    ...rest,
  });
  if (needsTag) built.__needsTag = needsTag;
  return built;
}

const HALLOWEEN = () => [
  layer('wash', {
    name: 'Night wash',
    params: { color: '#12061f', color2: '#000814', blend: 0.4, level: 0.35, vignette: 0.4 },
  }),
  layer('fog', {
    name: 'Ground fog',
    softness: 6,
    params: { color: '#7a8ba0', density: 0.22, scale: 2.4, speed: 0.04, swirl: 0.6, height: 0.45 },
  }),
  // Embers, candles and lightning take a blackbody temperature rather than a
  // colour — see docs/effects.md. 2200 K is a bright ember, 1050 K a dying one.
  layer('embers', {
    name: 'Drifting embers',
    opacity: 0.7,
    params: { hotTemp: 2200, coolTemp: 1050, count: 70, rise: 30, drift: 18, turbulence: 24, size: 5, twinkle: 0.6, opacity: 0.7 },
  }),
  layer('blood-drip', {
    name: 'Blood down the door',
    tags: ['door'],
    params: { color: '#7a0008', highlight: '#d61c22', count: 7, speed: 0.13, width: 18, variation: 0.65, pool: 0.06 },
  }),
  /**
   * The door breathes rather than having lights run round it.
   *
   * A chase is busy and reads as decoration. A slow pulse on the one opening
   * people are deciding whether to walk up to is a call to action — it says
   * *this* door, and it says it without competing with anything else on the
   * wall. Warm rather than red, for the same reason: it should look like a
   * porch light somebody left on for you.
   */
  layer('pulse', {
    name: 'Doorway pulse',
    tags: ['door'],
    blend: 'lighter',
    params: { color: '#ff8a2b', mode: 'both', rate: 0.34, wave: 'sine', min: 0.12, max: 0.85, width: 16, grow: 0.012 },
  }),
  layer('pulse', {
    name: 'Window pulse',
    tags: ['window'],
    blend: 'lighter',
    opacity: 0.5,
    stagger: 0.35,
    params: { color: '#8b00ff', mode: 'outline', rate: 0.5, wave: 'heartbeat', min: 0, max: 0.9, width: 8 },
  }),
  // Brick, then the thing behind the brick, then the rot growing over both.
  // The order is the whole point: Breach has to draw after the wall it is
  // taking apart, and the vine has to draw after the wall it is climbing.
  //
  // On a rendered or painted house this bottom layer is doing more work than
  // anything else in the preset — it is what turns a flat pale wall into a
  // surface, and every effect above it stops looking like a slide projected
  // onto a sheet.
  layer('brickwork', {
    name: 'Brick',
    tags: ['wall'],
    params: {
      /**
       * Matched to the real brick a 1930s semi already has — the reveal round
       * the door and the plinth under the bay. Getting those two to agree with
       * the projected wall is most of why this reads as masonry rather than as
       * a pattern: the eye has a reference two feet away from it.
       *
       * Size is about 1.4× life, and that is a compromise rather than a
       * mistake. A real brick is 215 × 65mm with a 10mm joint; on a 6-metre
       * wall through an XGA projector that joint lands at under two projector
       * pixels and turns into grey haze — under the four-pixel floor. Since the
       * joint has to be exaggerated, the brick is exaggerated with it, or you
       * get thin bricks with cartoon mortar.
       */
      color: '#8f4a33', color2: '#5f3024', mortar: '#2b2621',
      brickW: 76, brickH: 24, gap: 5, variation: 0.6, relief: 0.7,
      obstacles: 'window, door', seed: 1,
    },
  }),
  layer('breach', {
    name: 'Something behind the wall',
    tags: ['wall'],
    params: {
      brickW: 76, brickH: 24, gap: 5, rate: 5, cluster: 8, holes: 3, heal: 40,
      brick: '#7d4130', void: '#08040c', innerGlow: '#4bff8f', glowAmount: 0.8,
      arms: 3, armColor: '#24402c', armTip: '#8ccc52', thickness: 34, suckers: 0.9,
      reach: 0.9, writhe: 1, dust: 0.7, gravity: 1400,
      obstacles: 'window, door', seed: 1,
    },
  }),
  layer('bats', {
    name: 'Bats',
    params: { color: '#12040f', silhouette: false, count: 12, size: 0.07, speed: 0.16, flap: 7, spread: 0.6, wander: 0.4, direction: 'right', interval: 70, crossing: 9 },
  }),
  layer('text', {
    name: 'Sign over the door',
    tags: ['sign'],
    needsTag: 'sign',
    params: {
      content: 'TRICK OR TREAT', mode: 'path', font: 'impact', weight: '900', size: 1.05,
      tracking: 0.06, color: '#ff7a18', stroke: '#1a0500', strokeWidth: 5, glow: 22,
      align: 'centre', animation: 'flicker', speed: 1.1, amount: 0.6, pathOffset: 0,
    },
  }),
  layer('lightning', {
    name: 'Storm',
    params: { temperature: 9000, rate: 5, flash: 0.5, bolt: true, thickness: 5, branches: 4, flickers: 3, duration: 0.5 },
  }),
];

const CHRISTMAS = () => [
  layer('plasma', {
    name: 'Cold night',
    params: { colorA: '#041a3a', colorB: '#0b2f52', colorC: '#1a0b3a', scale: 1.3, speed: 0.05, level: 0.42, resolution: 26, contrast: 1.2 },
  }),
  layer('stars', {
    name: 'Stars',
    opacity: 0.7,
    params: { color: '#ffffff', count: 120, size: 7, twinkle: 0.9, spikes: true, shooting: 3 },
  }),
  // Icicles go on before the lights: they are the solid thing hanging off the
  // gutter, and the bulbs need to read as sitting in front of them.
  layer('icicles', {
    name: 'Icicles',
    tags: ['roof', 'trim'],
    opacity: 0.8,
    params: { color: '#bfe9ff', tip: '#ffffff', count: 26, length: 0.1, variation: 0.65, width: 4, grow: 0, glint: 0.45 },
  }),
  layer('fairy-lights', {
    name: 'Roofline lights',
    tags: ['roof', 'trim'],
    // 'cycle' keeps every bulb lit and rotates the colours. A chase looks
    // livelier close up but leaves most of the roofline dark from the street.
    params: { pattern: 'cycle', palette: 'multi', spacing: 44, size: 11, glow: 2.6, speed: 0.35, level: 1, wire: 0.12 },
  }),
  layer('fairy-lights', {
    name: 'Window lights',
    tags: ['window'],
    stagger: 0.4,
    params: { pattern: 'twinkle', palette: 'warm', spacing: 42, size: 8, glow: 2.2, speed: 0.5, level: 0.9, wire: 0.1 },
  }),
  layer('candy-stripe', {
    name: 'Candy cane door',
    tags: ['door'],
    params: { color: '#e01b24', color2: '#ffffff', stripes: 16, angle: 35, speed: 0.18, mode: 'outline', width: 20 },
  }),
  layer('fill', {
    name: 'Warm rooms',
    tags: ['window'],
    blend: 'lighter',
    opacity: 0.45,
    stagger: 0.9,
    params: { color: '#ffcf8a', color2: '#5a2a00', gradient: 'radial', level: 0.8, softness: 0.4 },
    // A slow, gentle breath so the rooms feel occupied rather than lit by a lamp.
    bindings: { level: { type: 'lfo', wave: 'sine', rate: 0.08, depth: 0.15, spread: 0.2 } },
  }),
  // Under the warm rooms rather than over them: frost is on the glass, the
  // light is behind it.
  layer('frost', {
    name: 'Frosted glass',
    tags: ['window'],
    opacity: 0.75,
    stagger: 2.5,
    params: {
      color: '#bfe4ff', tip: '#ffffff', coverage: 0.8, grow: 40, fronds: 24,
      branch: 0.6, sharpness: 0.5, thickness: 4, bloom: 0.4, sparkle: 0.5,
    },
  }),
  // Settling is stated rather than left to the defaults. This layer used to
  // carry `settle: 0`, which is not a parameter snow has, so it did nothing and
  // the effect ran with collision on regardless — the right look, arrived at by
  // accident. `buildUp` and `maxDepth` are what actually control it.
  layer('snow', {
    name: 'Snowfall',
    params: {
      color: '#ffffff', count: 420, speed: 80, wind: 24, gust: 0.6, size: 5, depth: 0.75,
      blur: 0.7, flutter: 0.6, collide: true, buildUp: 2.2, maxDepth: 20, shed: 0.35,
    },
  }),
  /**
   * "MERRY CHRISTMAS" arched over the door, with a white outline that thickens
   * with the room.
   *
   * The outline width is bound to the microphone rather than the fill: a
   * brightness that pumps reads as a fault in the projector, whereas an edge
   * that thickens reads as the lettering catching more light. And the binding
   * degrades correctly — with no microphone the audio bands sit at zero, so
   * what is left is the base width, a clean 2px white edge, rather than
   * nothing at all.
   */
  layer('text', {
    name: 'Merry Christmas',
    tags: ['sign'],
    needsTag: 'sign',
    params: {
      content: 'MERRY CHRISTMAS', mode: 'path', font: 'serif', weight: '700', size: 0.95,
      tracking: 0.1, color: '#ffe9b0', stroke: '#ffffff', strokeWidth: 4, glow: 16,
      align: 'centre', animation: 'wave', speed: 0.5, amount: 0.25, pathOffset: 0,
    },
    bindings: {
      strokeWidth: { type: 'audio', band: 'level', depth: 9 },
      glow: { type: 'audio', band: 'high', depth: 26 },
    },
  }),
  layer('santa', {
    name: 'Santa fly-past',
    params: { color: '#ffe9b0', reindeer: 4, size: 0.16, interval: 90, crossing: 11, direction: 'right', height: 0.18, bob: 0.03, trail: 0.7 },
  }),
];

export const PRESETS = [
  {
    id: 'halloween',
    name: 'Halloween starter',
    description:
      'Candlelit windows with something looking out, blood down the door, rot creeping over the brickwork, ground fog and a storm overhead.',
    tagsUsed: ['window', 'door'],
    grade: 'haunted',
    build: HALLOWEEN,
  },
  {
    id: 'christmas',
    name: 'Christmas starter',
    description:
      'Chasing lights along the roofline, warm windows behind frosted glass, icicles, a candy-cane door, snow and a Santa fly-past.',
    tagsUsed: ['roof', 'window', 'door'],
    grade: 'frost',
    build: CHRISTMAS,
  },
];

/**
 * Append a preset's layers to the project and save the result as a scene.
 *
 * Returns a summary so the caller can tell the user which tags were missing —
 * a preset aimed at `#roof` on a house with no roofline traced is not broken,
 * it just has nothing to draw on yet.
 */
export function applyPreset(project, presetId) {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) return null;

  const present = new Set(project.shapes.flatMap((s) => s.tags || []));
  const maxOrder = project.layers.reduce((max, l) => Math.max(max, l.order || 0), -1);
  const layers = preset.build().filter((l) => {
    const needed = l.__needsTag;
    delete l.__needsTag;
    return !needed || present.has(needed);
  });
  layers.forEach((l, i) => {
    l.order = maxOrder + 1 + i;
  });
  project.layers.push(...layers);

  // Each preset carries a grade, because half of what makes these looks work is
  // the bloom and colour treatment rather than the effects themselves.
  const look = GRADE_PRESETS.find((g) => g.id === preset.grade);
  if (look) {
    project.settings = project.settings || {};
    project.settings.grade = { ...project.settings.grade, ...look.values };
  }

  const missing = preset.tagsUsed.filter((t) => !present.has(t));

  const scene = createScene({
    name: preset.name.replace(' starter', ''),
    hotkey: nextFreeHotkey(project),
    fade: 1.2,
    state: captureScene(project),
  });
  project.scenes.push(scene);

  return { preset, added: layers.length, missing, scene, look: look?.name ?? null };
}

function nextFreeHotkey(project) {
  const used = new Set(project.scenes.map((s) => String(s.hotkey)));
  for (let i = 1; i <= 9; i++) if (!used.has(String(i))) return String(i);
  return null;
}
