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

import { createLayer, createScene, createTrigger } from '../core/state.js';
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
      // No brick size here on purpose: it takes it from the Brickwork layer
      // above, so changing the wall changes what comes out of it.
      match: true, rate: 5, cluster: 8, holes: 3, heal: 40,
      brick: '#7d4130', void: '#08040c', innerGlow: '#4bff8f', glowAmount: 0.8,
      arms: 3, armColor: '#24402c', armTip: '#597a37', thickness: 27, suckers: 0.85, armGlow: 0.4,
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


/**
 * Birthdays.
 *
 * The one occasion here that is about a person rather than a date, which
 * changes what the house should do: everything points at the front door,
 * because that is where they will be standing when they see it. The cake goes
 * *on* the door for the same reason a cake goes in front of somebody at a
 * table — it is theirs, and it is at their height.
 */
const BIRTHDAY = () => [
  layer('wash', {
    name: 'Party night',
    params: { color: '#1b0a2e', color2: '#2d0b3d', blend: 0.45, level: 0.3, vignette: 0.35 },
  }),
  layer('bunting', {
    name: 'Bunting along the roofline',
    // The roofline only. The other `trim` shapes on a house are the bay plinth
    // and the arch over the door — bunting on the first hangs off the bottom of
    // the building, and on the second it is drawn straight through the sign.
    tags: ['roof'],
    params: {
      palette: 'party', color: '#ff3b6b', shape: 'triangle', spacing: 58, width: 52,
      drop: 70, sag: 40, wind: 0.7, speed: 0.6, cord: 0.3, level: 1,
    },
  }),
  // Warm rooms behind the front: somebody is in, and the party is inside.
  layer('fill', {
    name: 'Warm rooms',
    tags: ['window'],
    blend: 'lighter',
    opacity: 0.5,
    stagger: 0.8,
    params: { color: '#ffd08a', color2: '#5a2a00', gradient: 'radial', level: 0.8, softness: 0.45 },
  }),
  layer('fairy-lights', {
    name: 'Lights round the windows',
    tags: ['window'],
    stagger: 0.5,
    params: { pattern: 'twinkle', palette: 'multi', spacing: 40, size: 8, glow: 2.2, speed: 0.6, level: 0.9, wire: 0.1 },
  }),
  /**
   * The cake, on the door.
   *
   * "How many are lit" is bound to the microphone, inverted through an
   * expression: the louder the room, the fewer candles are burning. Stand in
   * front of the house and blow, and they go out — which is the one piece of
   * audience participation in the whole library that needs no hardware beyond
   * the laptop's own microphone. With no microphone the audio bands read zero,
   * so the expression returns 1 and every candle stays lit; the effect degrades
   * to exactly what it would have been without the binding.
   */
  layer('cake', {
    name: 'Cake on the door',
    tags: ['door'],
    // Not full brightness: a projector adds light to whatever is already there,
    // and a white cake at full level on a pale door is a white rectangle.
    opacity: 0.85,
    params: {
      tiers: 2, icing: '#ffdcea', sponge: '#c9873f', trim: '#ff4d88', drips: 0.75,
      candles: 8, palette: 'party', color: '#ff3b6b', lit: 1, flameTemp: 1850,
      flicker: 0.7, burn: 40, glow: 0.9,
    },
    bindings: { lit: { type: 'expr', code: 'clamp(1 - level * 2.2, 0, 1)' } },
  }),
  layer('balloons', {
    name: 'Balloons going up',
    params: {
      palette: 'party', color: '#ff3b6b', count: 16, size: 78, speed: 85, sway: 1,
      wind: 12, string: 1.7, shine: 0.8, spread: 1, pop: 0,
    },
  }),
  layer('confetti', {
    name: 'Confetti',
    opacity: 0.85,
    params: {
      palette: 'party', color: '#ffd166', kind: 'both', count: 200, size: 15,
      fall: 110, wind: 26, flutter: 1.1, tumble: 1, level: 1,
    },
  }),
  layer('text', {
    name: 'Sign over the door',
    tags: ['sign'],
    needsTag: 'sign',
    params: {
      content: 'HAPPY BIRTHDAY', mode: 'path', font: 'rounded', weight: '900', size: 0.85,
      tracking: 0.06, color: '#ffd166', stroke: '#ff3b6b', strokeWidth: 4, glow: 20,
      align: 'centre', animation: 'wave', speed: 0.7, amount: 0.3, pathOffset: 0,
    },
  }),
];

/**
 * The Perseids.
 *
 * The odd one out, and the reason it is worth having: this is the only preset
 * in the library where the house is *not* the show. The meteors are, and the
 * job of everything else is to get out of their way — a dark facade, one
 * landing light on, and a sky that is only just brighter than the wall. Turn
 * the brightness up and you have lost, because what you are competing with is
 * the actual sky behind it.
 */
const PERSEIDS = () => [
  layer('plasma', {
    name: 'Night sky',
    params: { colorA: '#03081c', colorB: '#071634', colorC: '#0a0a28', scale: 1.6, speed: 0.03, level: 0.3, resolution: 24, contrast: 1.15 },
  }),
  layer('stars', {
    name: 'Stars',
    opacity: 0.8,
    // Shooting stars off: the Meteor Shower layer below is doing that job
    // properly, and two systems of them disagree about where the radiant is.
    params: { color: '#ffffff', count: 150, size: 6, twinkle: 0.8, spikes: false, shooting: 0 },
  }),
  layer('meteors', {
    name: 'Perseids',
    params: {
      radiantX: 0.18, radiantY: -0.12, rate: 140, tint: 'perseid', speed: 1.1,
      length: 1.3, width: 3.5, fireballs: 3, train: 7, showRadiant: false, level: 1.1,
    },
  }),
  /**
   * Sporadics.
   *
   * A second shower, with its radiant somewhere else entirely and a rate of a
   * few an hour. Real: on any night of the year there are meteors that belong
   * to no shower at all, and during a peak they are the ones that catch you out
   * because they arrive from the wrong direction. Leaving them out is the sort
   * of tidiness that makes a sky look generated.
   */
  layer('meteors', {
    name: 'Sporadics',
    opacity: 0.8,
    params: {
      radiantX: 1.1, radiantY: 0.7, rate: 20, tint: 'iron', speed: 0.8,
      length: 1, width: 2.8, fireballs: 0.6, train: 3, showRadiant: false, level: 0.9,
    },
  }),
  layer('fill', {
    name: 'One light left on',
    tags: ['window'],
    blend: 'lighter',
    opacity: 0.22,
    stagger: 1.6,
    params: { color: '#ffcf8a', color2: '#1a0f00', gradient: 'radial', level: 0.5, softness: 0.5 },
  }),
  layer('text', {
    name: 'Sign over the door',
    tags: ['sign'],
    needsTag: 'sign',
    params: {
      content: 'LOOK UP', mode: 'path', font: 'mono', weight: '600', size: 0.7,
      tracking: 0.22, color: '#9dffc4', stroke: '#000000', strokeWidth: 2, glow: 12,
      align: 'centre', animation: 'fade', speed: 0.25, amount: 0.4, pathOffset: 0,
    },
  }),
];

/**
 * New Year's Eve.
 *
 * Built round one instant. Everything here is either counting towards midnight
 * or celebrating it, and the two things that carry the count — the clock on the
 * door and the countdown over it — read the *wall* clock rather than show time,
 * so they are right whatever time the show was started and agree with every
 * phone in the street.
 *
 * The target date wants changing each year, which is why it is a text field on
 * two layers rather than something clever: on the night, you set it once.
 */
const NEW_YEAR = () => [
  layer('wash', {
    name: 'Midnight',
    params: { color: '#04091f', color2: '#0a1a3a', blend: 0.5, level: 0.3, vignette: 0.4 },
  }),
  layer('fireworks', {
    name: 'Fireworks over the house',
    params: {
      palette: 'multi', color: '#ffd166', rate: 52, sparks: 110, power: 0.38,
      gravity: 0.28, life: 2.2, trail: true, level: 1,
    },
  }),
  layer('clock-face', {
    name: 'Clock on the door',
    tags: ['door'],
    params: {
      target: '2027-01-01 00:00', face: '#0a1430', rim: '#ffd166', hands: '#ffffff',
      numerals: 'roman', size: 0.94, thickness: 0.05, second: 'tick', glow: 1.1,
      pulse: true, flare: 8, flareColor: '#ffe9b0',
    },
  }),
  layer('countdown', {
    name: 'Countdown over the door',
    tags: ['sign'],
    needsTag: 'sign',
    params: {
      // Sized against the arch, which is a wide, *shallow* shape: text takes
      // its size from the smaller dimension, so the number needs to be several
      // times the height of the shape it is hung on to read from the road.
      target: '2027-01-01 00:00', prefix: '', expired: 'HAPPY NEW YEAR', units: 'auto',
      font: 'mono', weight: '700', size: 1.25, color: '#ffe9b0', glow: 20,
      stroke: '#000000', strokeWidth: 2, tracking: 0.06, offsetY: 0, pulse: true,
    },
  }),
  layer('sparkler', {
    name: 'Sparklers along the roofline',
    tags: ['roof'],
    params: {
      count: 2, speed: 0.13, hotTemp: 3200, coolTemp: 1400, rate: 220, life: 0.45,
      throw: 260, gravity: 240, fork: 0.7, head: 14, trail: 0.8, size: 2.8,
    },
  }),
  layer('fill', {
    name: 'Warm rooms',
    tags: ['window'],
    blend: 'lighter',
    opacity: 0.45,
    stagger: 0.9,
    params: { color: '#ffcf8a', color2: '#5a2a00', gradient: 'radial', level: 0.8, softness: 0.4 },
  }),
  layer('confetti', {
    name: 'Confetti',
    opacity: 0.8,
    params: {
      palette: 'gold', color: '#ffd166', kind: 'both', count: 240, size: 14,
      fall: 130, wind: 30, flutter: 1.2, tumble: 1.2, level: 1,
    },
  }),
];

/**
 * Bonfire Night.
 *
 * The one night this application was arguably invented for, and the one where
 * restraint matters most: a real bonfire is the brightest thing for a street in
 * every direction, so the fire has to dominate and everything else has to sit
 * underneath it. Hence one wheel rather than four, fireworks at a low rate, and
 * a wash cold enough that the firelight has something to be warm against.
 */
const BONFIRE_NIGHT = () => [
  layer('wash', {
    name: 'Cold November',
    params: { color: '#070a14', color2: '#101826', blend: 0.5, level: 0.28, vignette: 0.45 },
  }),
  layer('fog', {
    name: 'Smoke across the garden',
    softness: 6,
    params: { color: '#8a8f98', density: 0.2, scale: 2.6, speed: 0.05, swirl: 0.5, height: 0.4 },
  }),
  /**
   * The fire, in the doorway.
   *
   * The obvious target is the front wall, and it is wrong twice over: this
   * house has *two* shapes tagged `wall` — the front and the side store — so a
   * fire aimed at the tag lights two of them, complete with two guys. And a
   * fire spread across the whole front of a building reads as a building on
   * fire rather than as a bonfire in front of one. The doorway is a tall
   * opening at ground level with the fire's own light spilling out of it, which
   * is exactly the shape of the thing.
   */
  layer('bonfire', {
    name: 'The bonfire',
    tags: ['door'],
    params: {
      coreTemp: 1950, tipTemp: 1000, height: 0.95, width: 0.8, speed: 1, turbulence: 0.75,
      detail: 64, logs: 12, logColor: '#2a1a12', embers: 130, smoke: 0.7, spill: 1.3,
      guy: true, burn: 300, seed: 3,
    },
  }),
  layer('embers', {
    name: 'Embers over the garden',
    opacity: 0.75,
    params: { hotTemp: 2000, coolTemp: 1000, count: 60, rise: 34, drift: 20, turbulence: 26, size: 5, twinkle: 0.6, opacity: 0.7 },
  }),
  // Wheels pinned to the windows, staggered so they do not all light at once —
  // half the pleasure of a wheel is watching it wind up while another one dies.
  layer('catherine-wheel', {
    name: 'Wheels on the windows',
    tags: ['window'],
    stagger: 3.5,
    params: {
      radius: 0.42, nozzles: 2, hotTemp: 3000, coolTemp: 1100, tint: '#ffe9b0',
      sparks: 150, speed: 520, life: 0.7, gravity: 520, spin: 3.2, spinUp: 1.4,
      duration: 9, repeat: 12, size: 3.2,
    },
  }),
  layer('sparkler', {
    name: 'Sparkler along the gutter',
    tags: ['roof'],
    params: {
      count: 1, speed: 0.12, hotTemp: 3200, coolTemp: 1400, rate: 190, life: 0.42,
      throw: 240, gravity: 260, fork: 0.75, head: 12, trail: 0.7, size: 2.6,
    },
  }),
  layer('fireworks', {
    name: 'Fireworks over the rooftops',
    opacity: 0.9,
    params: {
      palette: 'warm', color: '#ffd166', rate: 34, sparks: 90, power: 0.32,
      gravity: 0.3, life: 2.2, trail: true, level: 0.9,
    },
  }),
  layer('text', {
    name: 'Sign over the door',
    tags: ['sign'],
    needsTag: 'sign',
    params: {
      // Seventeen characters on an arch that is four hundred pixels wide: any
      // bigger and the ends of it climb off the end of the path.
      content: 'REMEMBER REMEMBER', mode: 'path', font: 'serif', weight: '700', size: 0.6,
      tracking: 0.05, color: '#ffb347', stroke: '#1a0500', strokeWidth: 4, glow: 18,
      /**
       * Breathing rather than guttering.
       *
       * `flicker` is the obvious animation for a sign over a fire and it is
       * the wrong one: it takes a glyph's alpha to near zero and back — which
       * is the point of it on a bad neon tube — and it ignores Animation
       * amount entirely, so there is no dialling it down. On lettering
       * somebody has to *read*, from the pavement, at night, it reads as
       * missing letters rather than as atmosphere.
       */
      align: 'centre', animation: 'fade', speed: 0.4, amount: 0.4, pathOffset: 0,
    },
  }),
];


/**
 * Night city.
 *
 * The look is Blade Runner and everything downstream of it, and the thing worth
 * noticing is how little of it is science fiction: it is a wet street at night
 * with too much signage, and a projector on a house is already most of the way
 * there. What makes it work is the *absence* of white light. Nothing here is
 * lit; every surface takes its colour from something advertising at it, so the
 * wash is nearly black and the neon does all the work.
 *
 * Two gases, and only two, used consistently — magenta for the openings and
 * cyan for everything structural. Neon signage in real cities is a riot of
 * colour and it reads as a riot; a pair of complementary gases reads as a
 * *place*.
 */
const CYBERPUNK = () => [
  layer('wash', {
    name: 'Wet night',
    params: { color: '#05060f', color2: '#120a2a', blend: 0.55, level: 0.3, vignette: 0.5 },
  }),
  // The hologram goes on before the neon: it is behind everything, on the wall,
  // and the tubes have to read as being in front of it.
  layer('hologram', {
    name: 'Advert on the wall',
    tags: ['wall'],
    opacity: 0.7,
    params: {
      text: '新東京 · 電脳 · 未来 · 記憶', color: '#05d9e8', fringe: '#ff2a6d', size: 0.12,
      columns: 4, speed: 34, scanlines: 4, split: 4, glitch: 0.5, haze: 0.35, level: 1,
    },
  }),
  layer('runes', {
    name: 'Code in the windows',
    tags: ['window'],
    opacity: 0.55,
    stagger: 1.3,
    params: {
      color: '#05d9e8', head: '#eafcff', alphabet: 'アイウエオカキクケコサシスセソタチツテト0123456789',
      columns: 8, speed: 7, tail: 10, churn: 8, level: 1,
    },
  }),
  layer('neon', {
    name: 'Tubes round the windows',
    tags: ['window'],
    stagger: 0.7,
    params: {
      color: '#05d9e8', core: '#eafcff', width: 7, inset: 0, color2: '#ff2a6d',
      flicker: 0.3, buzz: 1, dead: 0, chase: 0, spill: 0.5, level: 1,
    },
  }),
  layer('neon', {
    name: 'Tube round the door',
    tags: ['door'],
    params: {
      color: '#ff2a6d', core: '#fff0f6', width: 10, inset: 7, color2: '#05d9e8',
      flicker: 0.45, buzz: 1.2, dead: 0, chase: 0, spill: 0.9, level: 1,
    },
  }),
  layer('neon', {
    name: 'Strip along the gutter',
    tags: ['roof', 'trim'],
    params: {
      color: '#c400ff', core: '#f7e6ff', width: 6, inset: 0, color2: '#05d9e8',
      flicker: 0.15, buzz: 0.8, dead: 0, chase: 0.12, spill: 0.4, level: 0.9,
    },
  }),
  /**
   * The sign on the chimney.
   *
   * A chimney is a tall narrow rectangle standing above the roofline, which is
   * exactly the shape and exactly the position of every vertical sign in every
   * one of these films. It is the single best thing on an ordinary British
   * house for this, and it is not obvious until you try it.
   */
  layer('neon-sign', {
    name: 'Sign on the chimney',
    tags: ['chimney'],
    params: {
      text: '電脳', orientation: 'down', color: '#ff2a6d', core: '#fff0f6', size: 0.78,
      weight: '700', spacing: 1.08, frame: 0.5, frameColor: '#05d9e8', flicker: 0.5,
      buzz: 1, broken: 0, subtitle: '', spill: 0.9, level: 1,
    },
  }),
  layer('neon-sign', {
    name: 'Sign over the door',
    tags: ['sign'],
    needsTag: 'sign',
    params: {
      text: '不夜城', orientation: 'across', color: '#05d9e8', core: '#eafcff', size: 0.9,
      weight: '700', spacing: 1.3, frame: 0, frameColor: '#ff2a6d', flicker: 0.35,
      buzz: 1, broken: 0.3, subtitle: 'OPEN ALL NIGHT', spill: 0.6, level: 1,
    },
  }),
  layer('rain', {
    name: 'Rain',
    params: {
      color: '#9fd6ff', count: 700, speed: 1150, angle: 14, length: 60, width: 1.4,
      depth: 0.8, opacity: 0.35, splash: 0.6, gust: 0.5,
    },
  }),
  layer('fog', {
    name: 'Steam off the street',
    softness: 6,
    opacity: 0.7,
    params: { color: '#4a6f8c', density: 0.24, scale: 2.8, speed: 0.05, swirl: 0.7, height: 0.42 },
  }),
];

/**
 * The house goes under.
 *
 * The only preset here that is not a night of the year, and it earns its place
 * because it is the one that changes what the building *is* rather than what is
 * on it. Everything else in this file decorates a facade; this one puts it
 * fourteen metres down.
 *
 * The order the layers go on in is the order the light actually arrives in, and
 * it is not negotiable. The water body first, because it is the medium and
 * everything else is seen through it. Then the shafts coming down through the
 * surface, then the caustics they throw onto the brickwork, then the things
 * living in it — weed on the wall, a shoal off it, jellyfish drifting up past
 * the roof. Bubbles last, because they are the nearest thing to the camera.
 *
 * Every layer shares the same three numbers — surface at 0.045 down the frame,
 * fourteen metres of water to the bottom of it, murkiness 1.4 — and that is
 * what makes it read as one body of water rather than six effects that happen
 * to be blue. Change them in one layer and it stops working, which is worth
 * knowing before you start: they are a *scene* setting that happens to live on
 * each effect.
 *
 * The surface is deliberately inside the frame, just below the top, rather than
 * off the top of it. It costs a little of the sky and it buys the single thing
 * that makes the whole look land — you can see the underside of the surface,
 * with the light breaking on it and the glints running along the waves, and
 * once the eye has found the surface it knows exactly what is going on
 * everywhere below it.
 */
const SUNKEN = () => [
  // Surface, depth and murkiness, repeated on every layer because they are
  // per-effect parameters. Kept in one object so they cannot drift apart.
  ...(() => {
    const water = { surface: 0.045, metres: 14, turbidity: 1.4 };
    return [
      layer('waterline', {
        name: 'The water',
        params: {
          ...water, color: '#dff2ff', body: 0.55, wave: 26, wavelength: 6,
          tide: 0.022, tidePeriod: 48, glint: 0.9, spill: 0.55, level: 0.9,
        },
      }),
      layer('godrays', {
        name: 'Shafts through the surface',
        opacity: 0.9,
        params: {
          ...water, color: '#eaf7ff', shafts: 13, tilt: -11, spread: 34,
          width: 0.05, sway: 0.7, swell: 7, shimmer: 0.75, haze: 0.4, intensity: 1,
        },
      }),
      /**
       * Caustics on the brickwork, and only on the brickwork.
       *
       * The dancing light belongs on a surface. Run over the whole frame it
       * lands on the sky as well, which is water, and water does not have
       * caustics on it — it *makes* them. Pointed at the wall it is the
       * strongest single cue in the look, because it is the thing everybody has
       * stood next to a swimming pool and watched.
       */
      layer('caustics', {
        name: 'Caustics on the wall',
        tags: ['wall'],
        needsTag: 'wall',
        opacity: 0.55,
        params: {
          color: '#8fe4ff', color2: '#031c33', scale: 3.6, speed: 0.22,
          sharpness: 5.4, level: 0.7, resolution: 64,
        },
      }),
      // Windows read as glass by being *dimmer* and greener than the render
      // around them, which is what a pane of glass with a flooded room behind
      // it looks like. A bright window would read as a lit house.
      layer('fill', {
        name: 'Water behind the glass',
        tags: ['window'],
        needsTag: 'window',
        opacity: 0.55,
        params: { color: '#0d5f6e', color2: '#04202f', gradient: 'vertical', level: 0.9, softness: 0.6, inset: 0.02 },
      }),
      layer('kelp', {
        name: 'Weed up the front',
        tags: ['wall'],
        needsTag: 'wall',
        params: {
          ...water, color: '#2f6b45', tip: '#96cf5e', fronds: 11, height: 0.55,
          thickness: 7, blades: 1, sway: 0.4, current: 0.4, wavelength: 9,
          bladders: 0.6, level: 0.9,
        },
      }),
      layer('shoal', {
        name: 'A shoal off the wall',
        tags: ['wall'],
        needsTag: 'wall',
        params: {
          ...water, color: '#2c6f8c', belly: '#e2f7ff', count: 46, size: 26,
          speed: 175, cohesion: 0.8, alignment: 1.1, separation: 1, wander: 0.65,
          obstacles: 'window, door', startle: 0.3, flash: 1.2,
        },
      }),
      layer('jellyfish', {
        name: 'Jellyfish going up',
        opacity: 0.85,
        params: {
          ...water, color: '#a6dcff', rim: '#ff7ad9', count: 5, size: 78,
          pulse: 2.6, thrust: 1, rise: 22, drift: 12, tentacles: 12,
          trail: 1.8, glow: 1.1, level: 1,
        },
      }),
      /**
       * Marine snow, which is Snow with the temperature taken out of it.
       *
       * Detritus falling out of the water column, and it does the same job here
       * as dust in a beam of light: it is what the shafts have to catch. It
       * settles on the ledges too, which is not a liberty — it is the one thing
       * that genuinely accumulates on a wreck.
       */
      layer('snow', {
        name: 'Marine snow',
        opacity: 0.42,
        params: {
          color: '#cfeaf5', count: 260, speed: 22, wind: 9, gust: 0.8, size: 4,
          depth: 0.85, blur: 0.8, flutter: 1.4, collide: true, colliderTag: '',
          // A thin film on the ledges rather than a drift. Silt on a wreck is a
          // dusting; anything deeper reads as snow, which is the one thing it
          // must not, and the slabs that shed off a deep pile read as dashes.
          buildUp: 0.3, maxDepth: 5, shed: 0.35,
        },
      }),
      layer('bubbles', {
        name: 'Bubbles off the brickwork',
        tags: ['wall'],
        needsTag: 'wall',
        params: {
          ...water, color: '#e4f8ff', vents: 6, rate: 11, size: 9, variation: 0.75,
          rise: 155, wobble: 1.1, expand: 1.2, spread: 0.07,
          obstacles: 'window, door', level: 1,
        },
      }),
    ];
  })(),
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
  {
    id: 'birthday',
    name: 'Birthday',
    description:
      'Bunting along the roofline, a cake with lit candles on the door, balloons going up the front of the house and confetti over the lot.',
    tagsUsed: ['roof', 'window', 'door'],
    grade: 'saturated',
    build: BIRTHDAY,
  },
  {
    id: 'perseids',
    name: 'Perseid night',
    description:
      'A dark house under a meteor shower: Perseids streaking away from a radiant off the top corner, fireballs leaving trains, and a few sporadics from the wrong direction.',
    tagsUsed: ['window'],
    grade: 'frost',
    build: PERSEIDS,
  },
  {
    id: 'new-year',
    name: "New Year's Eve",
    description:
      'A working clock counting down to midnight on the door, the time over it, sparklers along the roofline, fireworks and confetti. Set the date on both counting layers.',
    tagsUsed: ['roof', 'window', 'door'],
    grade: 'saturated',
    build: NEW_YEAR,
  },
  {
    id: 'cyberpunk',
    name: 'Night city',
    description:
      'Neon tube round every opening, a Japanese sign on the chimney, a holographic advert over the brickwork, code in the windows and rain through the lot.',
    tagsUsed: ['window', 'door', 'chimney', 'wall'],
    grade: 'saturated',
    build: CYBERPUNK,
  },
  {
    id: 'sunken',
    name: 'Under the sea',
    description:
      'The house fourteen metres down: the surface across the top of the frame with shafts coming through it, caustics on the brickwork, weed up the front, a shoal that keeps off the windows, jellyfish going past the roof and bubbles off the wall.',
    tagsUsed: ['wall', 'window'],
    grade: 'deep',
    build: SUNKEN,
  },
  {
    id: 'bonfire-night',
    name: 'Bonfire Night',
    description:
      'A pyre burning in the doorway with a guy on top, catherine wheels pinned to the windows, a sparkler along the gutter and fireworks over the rooftops.',
    tagsUsed: ['door', 'window', 'roof'],
    grade: 'ember',
    build: BONFIRE_NIGHT,
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

/* ------------------------------------------------------------------ *
 * One-shots on keys
 * ------------------------------------------------------------------ */

/**
 * The three interactive effects the demo ships with, and their keys.
 *
 * Everything else in a show loops, which is right for a house that has to hold
 * up from dusk until the last group has gone and wrong for the moment somebody
 * actually reaches the door. These are the other kind: they happen once, and
 * something has to set them off.
 *
 * Each is a layer that is **off** in the authored show, a scene that switches
 * exactly that one on, and a trigger that fires the scene from a key. The
 * trigger holds it for a moment and then restores whatever was playing, so the
 * ambient look comes back by itself and the next visitor gets the same thing.
 * Pressing the key again re-enables the layer, which restarts its clock — that
 * is what makes them repeatable rather than a one-off.
 *
 * A key rather than motion because a key can be pressed by hand, by a doorbell
 * wired to a USB button, or by anything else that can type — and because it is
 * the one trigger that works indoors while you are still learning the app.
 *
 * The keys avoid the ones the editor has already taken. That is not a detail:
 * the first draft of this used B for bats, which is Blackout, so pressing it
 * blacked the show out and never reached the trigger at all. `RESERVED_KEYS`
 * in core/state.js is the list, and the trigger inspector warns if you pick one.
 */
export const DEMO_BURSTS = [
  {
    key: 'x',
    name: 'Bats out of the door',
    effect: 'bat-burst',
    tags: ['door'],
    hold: 3.2,
    params: {
      color: '#140a16', count: 46, duration: 2.8, speed: 950, spread: 0.62, aim: -90,
      size: 44, flap: 9, rise: -240, wander: 0.55, glow: 0.6, glowColor: '#8b00ff',
    },
  },
  {
    key: 'g',
    name: 'Something knocks',
    effect: 'shockwave',
    tags: ['door'],
    hold: 2,
    params: {
      color: '#ff7a18', color2: '#8b00ff', rings: 4, duration: 1.7,
      reach: 1500, width: 30, flash: 1.3, gap: 0.11,
    },
  },
  {
    key: 'f',
    name: 'Sparks off the roof',
    effect: 'spark-burst',
    tags: ['roof'],
    hold: 2.6,
    params: {
      hotTemp: 2800, coolTemp: 1100, count: 120, duration: 2.2, speed: 780,
      spread: 0.5, aim: -90, gravity: 950, size: 8, trail: 0.7,
    },
  },
];

/**
 * The one-shots each demo ships with.
 *
 * Keyed by preset, because a burst is only interactive if it belongs to what is
 * already on the wall: bats out of the door are the right answer on Halloween
 * and a non-sequitur under a meteor shower. Anything without an entry falls
 * back to the list above, which is also what a project that names no preset at
 * all gets.
 *
 * The keys repeat across presets on purpose — only one preset's bursts are ever
 * added to a project, so X is always "the big one" and the toast that tells you
 * which keys to press stays short.
 */
const PRESET_BURSTS = {
  birthday: [
    {
      key: 'x',
      name: 'Confetti out of the door',
      effect: 'confetti-cannon',
      tags: ['door'],
      hold: 5.5,
      params: {
        count: 200, duration: 5, speed: 1200, aim: -90, spread: 0.2,
        gravity: 420, drag: 1.6, size: 18, tumble: 1, streamers: 0.35, seed: 1,
      },
    },
    {
      key: 'f',
      name: 'A rocket for the birthday',
      effect: 'rocket',
      tags: ['roof'],
      hold: 5,
      params: {
        shell: 'peony', star: 'magnesium', color: '#ffd166', duration: 4.5, lift: 1.1,
        height: 820, drift: 90, stars: 100, power: 520, gravity: 260, size: 4,
        flash: 1.1, seed: 7,
      },
    },
  ],
  perseids: [
    {
      /**
       * A fireball, and the only burst here that is a *smaller* thing than the
       * layer it interrupts. Under a shower running at forty an hour, the event
       * worth pressing a key for is the one meteor in a thousand that comes in
       * slowly, breaks up, and lights the garden.
       */
      key: 'x',
      name: 'A fireball breaks up',
      effect: 'spark-burst',
      tags: ['roof'],
      hold: 3.5,
      params: {
        hotTemp: 4600, coolTemp: 1400, count: 70, duration: 2.8, speed: 620,
        spread: 0.16, aim: 25, gravity: 90, size: 6, trail: 0.9,
      },
    },
  ],
  'new-year': [
    {
      key: 'x',
      name: 'Rocket over the roof',
      effect: 'rocket',
      tags: ['roof'],
      hold: 6,
      params: {
        shell: 'crossette', star: 'copper', color: '#ffd166', duration: 5, lift: 1.2,
        height: 980, drift: 140, stars: 120, power: 600, gravity: 240, size: 4.5,
        flash: 1.3, seed: 3,
      },
    },
    {
      key: 'g',
      name: 'Confetti out of the door',
      effect: 'confetti-cannon',
      tags: ['door'],
      hold: 5.5,
      params: {
        count: 220, duration: 5, speed: 1300, aim: -90, spread: 0.22,
        gravity: 420, drag: 1.7, size: 16, tumble: 1.2, streamers: 0.4, seed: 2,
      },
    },
  ],
  cyberpunk: [
    {
      /**
       * The power going out and coming back, which is the one event this look
       * has: every tube on the house drops out, a wave crosses the front, and
       * the signs strike again. Aimed at the door because that is where the
       * pulse should look like it came from.
       */
      key: 'x',
      name: 'Something takes the power out',
      effect: 'shockwave',
      tags: ['door'],
      hold: 2.4,
      params: {
        color: '#05d9e8', color2: '#ff2a6d', rings: 4, duration: 2,
        reach: 2000, width: 22, flash: 1.6, gap: 0.09,
      },
    },
    {
      key: 'g',
      name: 'A transformer blows',
      effect: 'spark-burst',
      tags: ['roof'],
      hold: 3,
      params: {
        hotTemp: 6500, coolTemp: 2000, count: 130, duration: 2.4, speed: 900,
        spread: 0.6, aim: -90, gravity: 1100, size: 5, trail: 0.8,
      },
    },
  ],
  sunken: [
    {
      /**
       * A gout of bubbles out of the doorway, which is Spark Burst with the
       * gravity turned round.
       *
       * Nothing about that effect is specifically fire — it throws particles
       * out of a shape, colours them off the blackbody curve and lets them
       * cool. Ask it for nine thousand Kelvin and it hands back blue-white;
       * ask it for negative gravity and they rise. Which is a bubble.
       */
      key: 'x',
      name: 'Something breathes out',
      effect: 'spark-burst',
      tags: ['door'],
      hold: 5,
      params: {
        /**
         * Nine thousand Kelvin is off the top of the blackbody curve, where the
         * colour stops being flame and becomes the blue-white of a lightning
         * channel — which, dimmed and rounded, is a bubble.
         *
         * The gravity is the other half of it, and it is small on purpose. A
         * bubble reaches its terminal velocity within a few centimetres and
         * then holds it, so the honest shape is nearly constant speed; the
         * gentle negative here is the small acceleration a real bubble does
         * get as it swells on the way up. Turn it up and they fly off the
         * roof like sparks in reverse, which is what it looks like.
         */
        hotTemp: 9000, coolTemp: 4500, count: 150, duration: 4.5, speed: 170,
        spread: 0.3, aim: -90, gravity: -110, size: 11, trail: 0.15,
      },
    },
    {
      /**
       * A pressure wave down the front of the house, from something large
       * going over the roof that you never see.
       *
       * Aimed at the roofline rather than at the door on purpose: the thing
       * worth suggesting under water is scale, and scale is a wave arriving
       * from above and off the top of the picture.
       */
      key: 'g',
      name: 'Something big goes past',
      effect: 'shockwave',
      tags: ['roof'],
      hold: 4,
      params: {
        color: '#a8f0ff', color2: '#0b4a72', rings: 3, duration: 3.4,
        reach: 2600, width: 60, flash: 0.5, gap: 0.22,
      },
    },
  ],
  'bonfire-night': [
    {
      key: 'x',
      name: 'Rocket over the rooftops',
      effect: 'rocket',
      tags: ['roof'],
      hold: 7,
      params: {
        shell: 'willow', star: 'sodium', color: '#ffd166', duration: 6, lift: 1.3,
        height: 1050, drift: 120, stars: 110, power: 560, gravity: 300, size: 4,
        flash: 1.4, seed: 5,
      },
    },
    {
      key: 'g',
      name: 'A wheel goes off',
      effect: 'catherine-wheel',
      tags: ['wall'],
      hold: 11,
      params: {
        radius: 0.16, nozzles: 3, hotTemp: 3200, coolTemp: 1100, tint: '#ffe9b0',
        sparks: 420, speed: 700, life: 0.85, gravity: 520, spin: 4, spinUp: 1.2,
        // Relights after nothing: fired by hand, it should burn once and stop.
        duration: 9, repeat: 0, size: 3.5,
      },
    },
    {
      key: 'f',
      name: 'A log collapses',
      effect: 'spark-burst',
      tags: ['door'],
      hold: 3,
      params: {
        hotTemp: 2600, coolTemp: 1000, count: 140, duration: 2.4, speed: 520,
        spread: 0.45, aim: -90, gravity: 620, size: 6, trail: 0.6,
      },
    },
  ],
};

/** The one-shots a given demo gets. See `PRESET_BURSTS`. */
export function burstsFor(presetId) {
  return PRESET_BURSTS[presetId] || DEMO_BURSTS;
}

/**
 * Add the one-shots to a project, wired to their keys.
 *
 * Scenes here are built by hand rather than captured, and deliberately name
 * only the one layer they switch on: a layer a scene says nothing about keeps
 * its authored state, so a captured scene would freeze the entire show as it
 * happened to be at that instant and a hand-built one leaves everything else
 * alone. Fire it in the middle of anything and only the burst changes.
 */
export function addDemoBursts(project, presetId = null) {
  let order = project.layers.reduce((max, l) => Math.max(max, l.order || 0), 0);
  const added = [];

  for (const spec of burstsFor(presetId)) {
    const layer = createLayer(spec.effect, {
      name: spec.name,
      targetTags: spec.tags,
      params: { ...defaultParams(spec.effect), ...spec.params },
      order: ++order,
      // Off in the authored show. The scene is the only thing that turns it on.
      enabled: false,
    });
    project.layers.push(layer);

    const scene = createScene({
      name: spec.name,
      fade: 0,
      state: { [layer.id]: { enabled: true, opacity: 1, params: { ...layer.params } } },
    });
    project.scenes.push(scene);

    project.triggers.push(createTrigger({
      name: `${spec.name} (${spec.key.toUpperCase()})`,
      source: 'hotkey',
      key: spec.key,
      sceneId: scene.id,
      hold: spec.hold,
      // No cooldown: these are meant to be pressed again the moment they finish.
      cooldown: 0,
    }));

    added.push({ key: spec.key, name: spec.name });
  }

  return added;
}
