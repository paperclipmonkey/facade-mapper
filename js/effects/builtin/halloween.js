/**
 * Halloween effects.
 *
 * A recurring trick in here: anything that should read as a *dark* shape on the
 * house is drawn with `destination-out` on top of a lit fill, not with black
 * paint. Projectors can't emit darkness, so a black silhouette on an unlit wall
 * is invisible — the figure has to be a hole punched in light.
 *
 * Randomness is seeded per event (per lightning strike, per drip) so two
 * projectors covering the same wall draw the identical bolt.
 */

import { rgba, clamp, lerp, TAU, frac, makeRng } from '../../core/math.js';
import { blackbodyBytes, blackbodyCss, mixLinear } from '../color.js';
import { ensureField, curlNoise } from '../field.js';

const bloodDrip = {
  id: 'blood-drip',
  name: 'Blood Drip',
  category: 'halloween',
  scope: 'shape',
  description:
    'Runs blood down from the top edge, with the stop-start motion and irregular trail real liquid leaves on a vertical surface.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#6b0008' },
    { key: 'highlight', type: 'color', label: 'Head colour', default: '#c41520' },
    { key: 'count', type: 'range', label: 'Drips', default: 9, min: 1, max: 60, step: 1 },
    { key: 'speed', type: 'range', label: 'Speed', default: 0.16, min: 0.01, max: 2, step: 0.005 },
    { key: 'width', type: 'range', label: 'Thickness', default: 16, min: 1, max: 90, step: 0.5 },
    { key: 'variation', type: 'range', label: 'Variation', default: 0.6, min: 0, max: 1, step: 0.01 },
    { key: 'stickSlip', type: 'range', label: 'Stop-start', default: 0.6, min: 0, max: 1, step: 0.01 },
    { key: 'pool', type: 'range', label: 'Pool at top', default: 0.05, min: 0, max: 0.3, step: 0.005 },
    { key: 'gloss', type: 'range', label: 'Wet sheen', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'droplets', type: 'bool', label: 'Shed droplets', default: true },
    { key: 'fade', type: 'range', label: 'Fade when it lands (s)', default: 2.2, min: 0, max: 10, step: 0.1 },
    { key: 'restart', type: 'bool', label: 'Loop', default: true },
  ],
  init() {
    return { drips: null, count: 0 };
  },
  step({ p, shape, t, dt, rng, state, noise }) {
    const { bbox } = shape;
    if (bbox.h <= 0) return;
    const count = Math.max(1, Math.round(p.count));

    if (state.count !== count) {
      state.count = count;
      state.drips = Array.from({ length: count }, (_, i) => ({
        // Jitter within the column so drips don't look like a comb.
        x: bbox.x + ((i + 0.5) / count + (rng() - 0.5) * 0.6 / count) * bbox.w,
        rate: 1 - p.variation * rng(),
        /** How far down, 0..1. Integrated, never assigned — see below. */
        pos: 0,
        wait: rng() * 4,
        alpha: 1,
        wobble: rng() * 10,
        thickness: 0.6 + rng() * 0.8,
        seed: rng() * 100,
      }));
    }

    for (const drip of state.drips) {
      if (drip.wait > 0) {
        drip.wait -= dt;
        continue;
      }

      /**
       * Down, and only down.
       *
       * Stick-slip used to be a factor multiplying the head's *position*: a
       * noise value either side of one, applied to how far down the wall the
       * bead had got. Which means that when the noise fell, the bead went back
       * up the door. That is the bounce — it was not a wobble on top of a
       * descent, it was a descent that reversed several times a second, and no
       * amount of tuning the amplitude would have fixed it.
       *
       * Surface tension does not lift a drip back up the wall; it holds it
       * still. So the noise now gates the *speed*, is clamped so it can never
       * go negative, and the position is integrated from it. Monotone by
       * construction, however the noise behaves.
       */
      const gate = p.stickSlip > 0
        ? clamp(1 - p.stickSlip * (0.5 + 0.5 * noise.noise2(t * 1.6 + drip.seed, 0)), 0.04, 1)
        : 1;
      // And it accelerates as it goes, because it is falling.
      drip.pos += p.speed * drip.rate * gate * (0.45 + 0.9 * drip.pos) * dt;

      if (drip.pos >= 1) {
        drip.pos = 1;
        // Landed. Fade out where it is, rather than snapping back to the top:
        // the old loop reset the position outright, so every drip vanished from
        // the bottom of the door and reappeared at the top in the same frame.
        if (p.fade > 0) drip.alpha -= dt / p.fade;
        else drip.alpha = 0;
        if (drip.alpha <= 0 && p.restart) {
          drip.pos = 0;
          drip.alpha = 1;
          drip.wait = rng() * 5;
          drip.rate = 1 - p.variation * rng();
          drip.thickness = 0.6 + rng() * 0.8;
          drip.seed = rng() * 100;
        }
      }
    }
  },
  draw({ g, p, shape, t, state, noise }) {
    const { bbox } = shape;
    if (bbox.h <= 0 || !state.drips) return;

    g.save();
    g.clip(shape.path);

    if (p.pool > 0) {
      const poolH = bbox.h * p.pool;
      const grad = g.createLinearGradient(0, bbox.y, 0, bbox.y + poolH * 1.6);
      grad.addColorStop(0, p.color);
      grad.addColorStop(1, rgba(p.color, 0));
      g.fillStyle = grad;
      g.fillRect(bbox.x, bbox.y, bbox.w, poolH * 1.6);
    }

    for (const drip of state.drips) {
      if (drip.wait > 0 || drip.alpha <= 0) continue;

      const progress = drip.pos;
      const headY = bbox.y + drip.pos * bbox.h;
      const w = p.width * drip.thickness;
      const sway = Math.sin(t * 0.5 + drip.wobble) * w * 0.18;

      g.globalAlpha = drip.alpha;

      // The trail is thinner and darker than the head: most of the liquid is in
      // the bead, and what is left behind is a thin film.
      const trailGrad = g.createLinearGradient(0, bbox.y, 0, headY);
      trailGrad.addColorStop(0, rgba(p.color, 0.85));
      trailGrad.addColorStop(0.7, p.color);
      trailGrad.addColorStop(1, mixLinear(p.color, p.highlight, 0.5));
      g.fillStyle = trailGrad;

      // Trail edges wobble with noise rather than being a clean quadratic, so
      // the ribbon has the uneven width liquid actually leaves.
      const steps = 10;
      g.beginPath();
      g.moveTo(drip.x - w * 0.5, bbox.y);
      for (let i = 1; i <= steps; i++) {
        const f = i / steps;
        const y = lerp(bbox.y, headY, f);
        const taper = 0.5 - 0.18 * f;
        const jitter = noise.noise2(f * 4 + drip.seed, 1.7) * 0.09;
        g.lineTo(drip.x - w * (taper + jitter) + sway * f, y);
      }
      for (let i = steps; i >= 0; i--) {
        const f = i / steps;
        const y = lerp(bbox.y, headY, f);
        const taper = 0.5 - 0.18 * f;
        const jitter = noise.noise2(f * 4 + drip.seed + 33, 2.9) * 0.09;
        g.lineTo(drip.x + w * (taper + jitter) + sway * f, y);
      }
      g.closePath();
      g.fill();

      // Bead: elongated by its own weight, brightest where it is thickest.
      const beadW = w * 0.52;
      const beadH = w * 0.68;
      const bead = g.createRadialGradient(
        drip.x + sway - beadW * 0.25, headY - beadH * 0.3, 0,
        drip.x + sway, headY, beadH
      );
      bead.addColorStop(0, mixLinear(p.highlight, '#ffffff', 0.25 * p.gloss));
      bead.addColorStop(0.6, p.highlight);
      bead.addColorStop(1, p.color);
      g.fillStyle = bead;
      g.beginPath();
      g.ellipse(drip.x + sway, headY, beadW, beadH, 0, 0, TAU);
      g.fill();

      // A single specular dot, offset from centre. This is what reads as "wet".
      if (p.gloss > 0) {
        g.fillStyle = rgba('#ffffff', 0.35 * p.gloss);
        g.beginPath();
        g.ellipse(drip.x + sway - beadW * 0.3, headY - beadH * 0.35, beadW * 0.16, beadH * 0.2, 0, 0, TAU);
        g.fill();
      }

      // Satellite drop: when a bead detaches it leaves a smaller one behind it,
      // trailing a thin thread. Cheap detail, very recognisable.
      if (p.droplets && progress > 0.35) {
        // Chased off the same integrated position, so the satellite runs down
        // the wall with the bead rather than to its own clock.
        const dropPhase = frac(drip.pos * 2.3 + drip.wobble);
        const dropY = bbox.y + dropPhase * bbox.h * 1.1;
        if (dropY > headY + beadH * 2) {
          g.fillStyle = p.color;
          g.beginPath();
          g.ellipse(drip.x + sway, dropY, w * 0.22, w * 0.3, 0, 0, TAU);
          g.fill();
          g.strokeStyle = rgba(p.color, 0.5);
          g.lineWidth = Math.max(0.5, w * 0.06);
          g.beginPath();
          g.moveTo(drip.x + sway, dropY - w * 0.3);
          g.lineTo(drip.x + sway, headY + beadH);
          g.stroke();
        }
      }
      g.globalAlpha = 1;
    }
    g.restore();
  },
};

const lightning = {
  id: 'lightning',
  name: 'Lightning',
  category: 'halloween',
  scope: 'global',
  description:
    'A stepped leader, then a bright return stroke, then flickering afterglow — the sequence a real strike actually follows. Every projector draws the same bolt.',
  params: [
    { key: 'temperature', type: 'range', label: 'Channel temp (K)', default: 9000, min: 3000, max: 20000, step: 250 },
    { key: 'rate', type: 'range', label: 'Strikes / min', default: 6, min: 0.2, max: 60, step: 0.1 },
    { key: 'flash', type: 'range', label: 'Sky flash', default: 0.55, min: 0, max: 1, step: 0.01 },
    { key: 'bolt', type: 'bool', label: 'Draw bolt', default: true },
    { key: 'thickness', type: 'range', label: 'Channel thickness', default: 5, min: 1, max: 40, step: 0.5 },
    { key: 'branches', type: 'range', label: 'Branching', default: 3, min: 0, max: 5, step: 1 },
    { key: 'flickers', type: 'range', label: 'Return strokes', default: 3, min: 1, max: 8, step: 1 },
    { key: 'duration', type: 'range', label: 'Strike length (s)', default: 0.6, min: 0.05, max: 3, step: 0.01 },
    { key: 'leader', type: 'range', label: 'Leader time (s)', default: 0.09, min: 0, max: 0.5, step: 0.005 },
  ],
  /**
   * When this effect is about to be loud, in show time.
   *
   * The one hook an effect has into the soundscape. Thunder used to rumble on
   * its own timer, which is fine for weather happening somewhere else and
   * completely wrong for a bolt being drawn on the wall in front of you: a clap
   * a quarter-second off its flash is heard as a fault, and one on a separate
   * schedule entirely is heard as two different storms.
   *
   * The control tab asks every sounding layer for the events falling in a short
   * window just ahead of now and hands them to `cue` on the voice, so the audio
   * clock schedules the crack for the exact instant rather than for whichever
   * frame the ask happened on. Everything here is derived from the strike index
   * the same way `draw` derives it, which is what keeps the two in step.
   */
  cues(p, from, to) {
    const interval = 60 / Math.max(0.2, p.rate);
    const events = [];
    for (let strike = Math.max(0, Math.floor(from / interval)); strike <= Math.floor(to / interval); strike++) {
      const slack = Math.max(0, interval - p.duration - p.leader);
      const offset = makeRng(`when${strike}`)() * slack;
      // The return stroke, not the leader. The leader is the dim flicker on the
      // way down, and it is silent — the bang is the channel connecting.
      const at = strike * interval + offset + p.leader;
      if (at < from || at >= to) continue;
      // Zero distance: this is a strike on your own house, so the crack and the
      // rumble arrive together. The sky flash is how big the strike looks, so
      // it is also how loud it should be.
      events.push({ at, level: clamp(0.6 + p.flash * 0.4, 0, 1), distance: 0 });
    }
    return events;
  },
  draw({ g, p, world, t }) {
    const interval = 60 / Math.max(0.2, p.rate);
    const strike = Math.floor(t / interval);

    // Offset each strike randomly within its slot. A metronomic flash reads as
    // an effect on a timer; this reads as weather. It also stops every projector
    // firing a bolt the instant the show is loaded.
    const slack = Math.max(0, interval - p.duration - p.leader);
    const offset = makeRng(`when${strike}`)() * slack;
    const local = t - strike * interval - offset;
    if (local < 0 || local > p.duration + p.leader) return;

    // Everything about this strike derives from its index, so all tabs agree.
    const rng = makeRng(`bolt${strike}`);

    // A real flash is: a dim, stuttering stepped leader feeling its way down,
    // then a very bright return stroke back up the channel, then two or three
    // dimmer restrikes. Modelling that sequence is most of what separates this
    // from a white flicker.
    const inLeader = local < p.leader;
    let intensity;
    let channelReach = 1;

    if (inLeader) {
      const f = p.leader > 0 ? local / p.leader : 1;
      // The leader is faint and steps downward, so only part of the channel is lit.
      channelReach = clamp(f, 0.05, 1);
      intensity = 0.1 + 0.14 * makeRng(`lead${strike}-${Math.floor(f * 9)}`)();
    } else {
      const phase = (local - p.leader) / Math.max(0.01, p.duration);
      const flickers = Math.max(1, Math.round(p.flickers));
      const sub = Math.floor(phase * flickers);
      const subPhase = frac(phase * flickers);
      // Each return stroke is a sharp attack and a fast decay, not a square gate.
      const stroke = Math.exp(-subPhase * 7) * (subPhase < 0.9 ? 1 : 0);
      // Later strokes are weaker.
      const decay = Math.pow(1 - phase, 1.3);
      intensity = stroke * decay * (0.6 + 0.4 * makeRng(`f${strike}-${sub}`)());
    }
    if (intensity <= 0.005) return;

    // The channel is hot enough to be blue-white; the sky flash it throws is the
    // same light scattered, so it shares the colour rather than being picked.
    // Rayleigh scattering shifts what comes back to you *bluer* than the source,
    // never warmer — which is why a real flash lights the sky blue-white even
    // though the arc itself is not quite. Nudging the temperature up rather than
    // down keeps that true while still following a warm channel if one is
    // deliberately dialled in.
    const channel = blackbodyCss(p.temperature);
    const skyGlow = blackbodyCss(p.temperature * 1.15);

    g.save();

    if (p.flash > 0) {
      // Sky flash is brightest near the channel, not uniform across the frame,
      // and falls off fast — the mid stop is what stops it reading as a flat
      // wash over the whole facade.
      const seedX = makeRng(`x${strike}`)() * world.w;
      const peak = intensity * p.flash;
      const grad = g.createRadialGradient(seedX, 0, 0, seedX, 0, world.h * 1.6);
      grad.addColorStop(0, rgba(skyGlow, peak));
      grad.addColorStop(0.4, rgba(skyGlow, peak * 0.42));
      grad.addColorStop(1, rgba(skyGlow, peak * 0.12));
      g.fillStyle = grad;
      g.fillRect(0, 0, world.w, world.h);
    }

    if (p.bolt) {
      g.globalAlpha = clamp(intensity * 1.6, 0, 1);
      g.globalCompositeOperation = 'lighter';
      g.lineCap = 'round';
      g.lineJoin = 'round';

      const startX = rng() * world.w;
      const endX = startX + (rng() - 0.5) * world.w * 0.5;

      /**
       * One channel, drawn as three passes: a wide dim halo (the air glowing
       * around the arc), the channel itself, and a white core. A single stroke
       * looks like a drawn line; the layering is what makes it look hot.
       */
      const drawChannel = (pts, thickness) => {
        const trace = () => {
          g.beginPath();
          g.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
          g.stroke();
        };
        g.strokeStyle = rgba(channel, 0.16);
        g.lineWidth = thickness * 5;
        trace();
        g.strokeStyle = rgba(channel, 0.6);
        g.lineWidth = thickness * 1.8;
        trace();
        g.strokeStyle = '#ffffff';
        g.lineWidth = thickness * 0.55;
        trace();
      };

      const drawBolt = (x0, y0, x1, y1, thickness, depth, reach) => {
        // Step size and wander are both properties of the channel, so they scale
        // with its own length rather than with the frame. Fixing them to the
        // world width made short branches fold back on themselves and read as
        // scribble instead of as a smaller version of the same thing.
        const span = Math.hypot(x1 - x0, y1 - y0);
        const segments = clamp(Math.round(span / (world.h * 0.07)), 4, 16);
        const wander = span * 0.13;
        const pts = [{ x: x0, y: y0 }];
        const limit = Math.max(2, Math.round(segments * reach));
        for (let i = 1; i <= limit; i++) {
          const f = i / segments;
          // Jitter shrinks towards the far end: a channel wanders most where it
          // is still searching, and straightens as it commits.
          const jitter = (1 - f * 0.7) * wander * (rng() - 0.5) * 2;
          pts.push({ x: lerp(x0, x1, f) + jitter, y: lerp(y0, y1, f) });
        }
        drawChannel(pts, thickness);

        if (depth > 0) {
          const branchCount = Math.max(0, Math.round(p.branches) - (Math.round(p.branches) - depth));
          for (let b = 0; b < branchCount; b++) {
            // Branches leave partway down and are markedly thinner, which is
            // what stops the bolt reading as a symmetrical tree. They also keep
            // travelling roughly the way the parent was going — a branch that
            // doubles back uphill is the giveaway that this is drawn, not lit.
            const at = pts[2 + Math.floor(rng() * Math.max(1, pts.length - 3))];
            if (!at) continue;
            const length = span * (0.3 + rng() * 0.35);
            const angle = Math.atan2(y1 - y0, x1 - x0) + (rng() - 0.5) * 1.1;
            drawBolt(
              at.x, at.y,
              at.x + Math.cos(angle) * length,
              at.y + Math.abs(Math.sin(angle)) * length,
              thickness * 0.45, depth - 1, reach
            );
          }
        }
      };

      drawBolt(
        startX, 0,
        endX, world.h * (0.7 + rng() * 0.45),
        p.thickness,
        Math.min(3, Math.round(p.branches)),
        channelReach
      );
    }
    g.restore();
  },
};

const fire = {
  id: 'fire',
  name: 'Fire',
  category: 'halloween',
  scope: 'shape',
  description:
    'Volumetric flame with blackbody colour. Colour comes from temperature, so it goes deep red as it cools rather than just dimming.',
  params: [
    { key: 'coreTemp', type: 'range', label: 'Core temperature (K)', default: 2100, min: 900, max: 4000, step: 25 },
    { key: 'tipTemp', type: 'range', label: 'Tip temperature (K)', default: 1050, min: 800, max: 2600, step: 25 },
    { key: 'height', type: 'range', label: 'Flame height', default: 0.8, min: 0.1, max: 1.5, step: 0.01 },
    { key: 'width', type: 'range', label: 'Flame width', default: 0.42, min: 0.05, max: 1.2, step: 0.01 },
    { key: 'speed', type: 'range', label: 'Speed', default: 1, min: 0.05, max: 4, step: 0.05 },
    { key: 'turbulence', type: 'range', label: 'Turbulence', default: 0.55, min: 0, max: 2, step: 0.01 },
    { key: 'detail', type: 'range', label: 'Detail', default: 56, min: 16, max: 130, step: 2 },
    { key: 'intensity', type: 'range', label: 'Intensity', default: 1, min: 0, max: 2, step: 0.01 },
    { key: 'wander', type: 'range', label: 'Base wander', default: 0.35, min: 0, max: 1, step: 0.01 },
    { key: 'sparks', type: 'range', label: 'Sparks', default: 40, min: 0, max: 400, step: 5 },
    { key: 'downward', type: 'bool', label: 'Burn downward', default: false },
  ],
  init() {
    return { parts: [], count: 0 };
  },
  /**
   * The sparks, and only the sparks.
   *
   * The flame itself is a density field sampled from noise at time `t` — a pure
   * function, identical in every tab, with nothing to carry between frames.
   * These are the one part that genuinely is discrete, and so the one part that
   * had to move here.
   */
  step({ p, shape, t, dt, rng, state, noise }) {
    const { bbox } = shape;
    if (bbox.w <= 2 || bbox.h <= 2) return;
    if (!(p.sparks > 0)) {
      state.parts.length = 0;
      return;
    }

    const target = Math.round(p.sparks);
    const spawn = (part = {}) => {
      part.x = bbox.cx + (rng() - 0.5) * bbox.w * p.width;
      part.y = p.downward ? bbox.y : bbox.y + bbox.h;
      part.vx = (rng() - 0.5) * bbox.w * 0.12;
      part.vy = (p.downward ? 1 : -1) * bbox.h * (0.25 + rng() * 0.4);
      part.life = 0.6 + rng() * 1.4;
      part.age = rng() * part.life;
      part.seed = rng() * 100;
      return part;
    };
    while (state.parts.length < target) state.parts.push(spawn({}));
    if (state.parts.length > target) state.parts.length = target;

    const step = dt * p.speed;
    for (const part of state.parts) {
      part.age += step;
      if (part.age >= part.life) {
        spawn(part);
        part.age = 0;
      }
      const turb = noise.noise3(part.x * 0.006, part.y * 0.006, t * 0.6 + part.seed);
      part.x += (part.vx + turb * bbox.w * 0.35) * step;
      part.y += part.vy * step;
      // Sparks decelerate as they rise, then fall back.
      part.vy *= 1 - 0.9 * step;
    }
  },
  draw({ g, p, shape, t, state, noise }) {
    const { bbox } = shape;
    if (bbox.w <= 2 || bbox.h <= 2) return;

    // The flame is a density field sampled on a coarse grid, not a cloud of
    // sprites. Sprites read as discs no matter how they are blurred; a field
    // gives connected tongues that split and rejoin the way flame actually does.
    const cols = Math.max(8, Math.round(p.detail));
    const rows = Math.max(8, Math.round((cols * bbox.h) / bbox.w));
    const field = ensureField(state, 'field', cols, rows);
    field.clear();

    const scroll = t * p.speed;
    // The root of a fire never sits still; without this the base looks welded on.
    const baseWander = noise.noise2(t * 0.6, 0) * 0.12 * p.wander;

    for (let y = 0; y < rows; y++) {
      const v = (y + 0.5) / rows;
      // 0 at the base, 1 at the tip, whichever way it burns.
      const hh = p.downward ? v : 1 - v;
      if (hh > p.height * 1.35) continue;

      // Flame narrows and leans as it rises.
      const taper = Math.max(0.05, 1 - hh * 0.7);
      const halfWidth = p.width * 0.5 * taper;

      for (let x = 0; x < cols; x++) {
        const u = (x + 0.5) / cols;
        const dx = (u - 0.5 - baseWander * hh) / Math.max(0.02, halfWidth);
        if (dx * dx > 6) continue;

        // Gaussian column profile — a hard-edged flame looks like a triangle.
        const profile = Math.exp(-dx * dx * 1.6);

        // Domain warp: displace the sample point with a slow field so tongues
        // curl over rather than rising as straight columns.
        const warpX = noise.noise3(u * 2.2, hh * 1.6 - scroll * 0.35, 11.3) * p.turbulence * 0.35;
        const warpY = noise.noise3(u * 2.0 + 5.1, hh * 1.8 - scroll * 0.4, 3.7) * p.turbulence * 0.25;

        // Two octaves of upward-scrolling detail. More would be wasted at the
        // resolution this is drawn back at.
        const n1 = noise.noise3((u + warpX) * 3.4, (hh + warpY) * 2.6 - scroll, scroll * 0.25);
        const n2 = noise.noise3((u + warpX) * 7.5, (hh + warpY) * 5.2 - scroll * 1.7, scroll * 0.4);
        const detail = 0.5 + 0.36 * n1 + 0.18 * n2;

        // Fuel runs out with height; subtracting a height term is what lets the
        // tip break into detached pockets instead of fading as a solid block.
        const fuel = profile * Math.pow(Math.max(0, 1 - hh / Math.max(0.05, p.height)), 0.75);
        let density = fuel * detail * 1.9 - hh * 0.28;
        if (density <= 0.02) continue;
        density = clamp(density, 0, 1);

        // Temperature is highest where the flame is densest and lowest at the
        // tips, which is why the colour ramp comes out right without a palette.
        const kelvin = lerp(p.tipTemp, p.coreTemp, clamp(density * 1.25 - hh * 0.35, 0, 1));
        const [r, gg, b] = blackbodyBytes(kelvin);
        field.set(x, y, r, gg, b, clamp(density * 1.3, 0, 1) * clamp(p.intensity, 0, 2));
      }
    }

    g.save();
    g.clip(shape.path);
    // Additive, because flame emits light rather than covering what is behind it.
    g.globalCompositeOperation = 'lighter';
    field.blit(g, bbox.x, bbox.y, bbox.w, bbox.h);

    // Sparks are the one part that genuinely is discrete, so they stay particles.
    if (p.sparks > 0 && state.parts.length) {
      for (const part of state.parts) {
        const f = clamp(part.age / part.life, 0, 1);
        // A spark cools as it flies: 2400K white-hot down to 1000K dull red.
        const kelvin = lerp(2400, 1000, f);
        const radius = Math.max(0.6, bbox.w * 0.004 * (1 - f * 0.5));
        g.globalAlpha = (1 - f) * 0.9;
        g.fillStyle = blackbodyCss(kelvin);
        g.beginPath();
        g.arc(part.x, part.y, radius, 0, TAU);
        g.fill();
      }
    }
    g.restore();
  },
};

const candle = {
  id: 'candle',
  name: 'Candle Flicker',
  category: 'halloween',
  scope: 'shape',
  description:
    'Warm, unsteady light with blackbody colour, so it reddens as it dips rather than just dimming. The "somebody is home" look for windows.',
  params: [
    { key: 'temperature', type: 'range', label: 'Temperature (K)', default: 1850, min: 1200, max: 3200, step: 25 },
    { key: 'shadow', type: 'color', label: 'Shadow', default: '#2a0d00' },
    { key: 'level', type: 'range', label: 'Brightness', default: 0.85, min: 0, max: 1.5, step: 0.01 },
    { key: 'jitter', type: 'range', label: 'Flicker depth', default: 0.35, min: 0, max: 1, step: 0.01 },
    { key: 'rate', type: 'range', label: 'Flicker speed', default: 3.5, min: 0.2, max: 20, step: 0.1 },
    { key: 'gust', type: 'range', label: 'Gusts', default: 0.25, min: 0, max: 1, step: 0.01 },
    { key: 'hotspot', type: 'range', label: 'Hotspot', default: 0.6, min: 0, max: 1, step: 0.01 },
  ],
  draw({ g, p, shape, t, noise, i }) {
    const { bbox } = shape;
    // Offsetting the noise field per instance keeps a row of windows from
    // flickering in lockstep, which instantly reads as fake.
    const seedOffset = i * 37.7;

    // Real candle flicker is not white noise. It is mostly a slow wander with
    // occasional sharp dips as the flame is pulled about, so the fast and slow
    // components are weighted very differently.
    const fast = noise.noise2(t * p.rate + seedOffset, 0);
    const slow = noise.noise2(t * p.rate * 0.13 + seedOffset, 11.3);
    const gustField = noise.noise2(t * 0.35 + seedOffset, 41.1);
    const gust = p.gust > 0 && gustField > 0.55 ? 1 - p.gust * ((gustField - 0.55) / 0.45) : 1;

    const level = clamp(p.level * (1 + p.jitter * (fast * 0.7 + slow * 0.3)) * gust, 0, 2);
    if (level <= 0.005) return;

    // A guttering flame cools. Tying temperature to output means the colour
    // shifts red as it dips, which is the cue that sells it as a real flame
    // rather than an opacity animation.
    const kelvin = p.temperature * (0.78 + 0.22 * clamp(level / Math.max(0.01, p.level), 0, 1.4));
    const core = blackbodyCss(kelvin);

    g.save();
    g.globalAlpha *= level;

    if (p.hotspot > 0) {
      const cx = bbox.cx + slow * bbox.w * 0.08;
      const cy = bbox.cy + fast * bbox.h * 0.05;
      const grad = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(bbox.w, bbox.h) * 0.75);
      grad.addColorStop(0, core);
      // Mixed in linear light, so the falloff to shadow stays warm instead of
      // passing through a muddy brown.
      grad.addColorStop(clamp(1 - p.hotspot, 0.05, 0.95), mixLinear(core, p.shadow, 0.55));
      grad.addColorStop(1, p.shadow);
      g.fillStyle = grad;
    } else {
      g.fillStyle = core;
    }
    g.fill(shape.path);
    g.restore();
  },
};

const eyes = {
  id: 'eyes',
  name: 'Watching Eyes',
  category: 'halloween',
  scope: 'shape',
  description: 'Pairs of glowing eyes that blink and track around inside the shape.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#ffe74c' },
    { key: 'pupil', type: 'color', label: 'Pupil', default: '#1a0000' },
    { key: 'pairs', type: 'range', label: 'Pairs', default: 2, min: 1, max: 12, step: 1 },
    { key: 'size', type: 'range', label: 'Eye size', default: 0.1, min: 0.01, max: 0.4, step: 0.005 },
    { key: 'blink', type: 'range', label: 'Blink rate', default: 0.35, min: 0, max: 2, step: 0.01 },
    { key: 'wander', type: 'range', label: 'Wander', default: 0.3, min: 0, max: 1, step: 0.01 },
    { key: 'glow', type: 'range', label: 'Glow', default: 1.2, min: 0, max: 4, step: 0.05 },
  ],
  init() {
    return { eyes: null, count: 0 };
  },
  /** Placed on step one, so the same eyes are in the same window in every tab. */
  step({ p, rng, state }) {
    const pairs = Math.max(1, Math.round(p.pairs));
    if (state.count === pairs) return;
    state.count = pairs;
    state.eyes = Array.from({ length: pairs }, () => ({
      x: 0.15 + rng() * 0.7,
      y: 0.15 + rng() * 0.7,
      scale: 0.7 + rng() * 0.6,
      phase: rng() * 100,
      blinkOffset: rng() * 10,
    }));
  },
  draw({ g, p, shape, t, state, noise }) {
    const { bbox } = shape;
    if (!state.eyes) return;

    const eyeR = Math.min(bbox.w, bbox.h) * p.size * 0.5;
    g.save();
    g.clip(shape.path);

    for (const eye of state.eyes) {
      const driftX = noise.noise2(t * 0.12, eye.phase) * p.wander * bbox.w * 0.12;
      const driftY = noise.noise2(t * 0.1, eye.phase + 50) * p.wander * bbox.h * 0.08;
      const cx = bbox.x + eye.x * bbox.w + driftX;
      const cy = bbox.y + eye.y * bbox.h + driftY;
      const gap = eyeR * 2.6 * eye.scale;
      const r = eyeR * eye.scale;

      // Blink: a short closure on a slow, per-eye offset cycle.
      let open = 1;
      if (p.blink > 0) {
        const cycle = frac(t * p.blink * 0.35 + eye.blinkOffset);
        if (cycle < 0.07) open = Math.abs(cycle / 0.035 - 1);
      }
      if (open <= 0.02) continue;

      // Gaze direction wanders slowly, both eyes together.
      const gazeX = noise.noise2(t * 0.3, eye.phase + 200) * r * 0.35;
      const gazeY = noise.noise2(t * 0.28, eye.phase + 300) * r * 0.25;

      for (const side of [-1, 1]) {
        const ex = cx + (side * gap) / 2;
        if (p.glow > 0) {
          g.globalCompositeOperation = 'lighter';
          const grad = g.createRadialGradient(ex, cy, 0, ex, cy, r * (2 + p.glow));
          grad.addColorStop(0, rgba(p.color, 0.5));
          grad.addColorStop(1, rgba(p.color, 0));
          g.fillStyle = grad;
          g.beginPath();
          g.arc(ex, cy, r * (2 + p.glow), 0, TAU);
          g.fill();
          g.globalCompositeOperation = 'source-over';
        }
        g.fillStyle = p.color;
        g.beginPath();
        g.ellipse(ex, cy, r, r * 0.62 * open, 0, 0, TAU);
        g.fill();

        g.fillStyle = p.pupil;
        g.beginPath();
        g.ellipse(ex + gazeX, cy + gazeY, r * 0.3, r * 0.42 * open, 0, 0, TAU);
        g.fill();
      }
    }
    g.restore();
  },
};

const silhouette = {
  id: 'silhouette',
  name: 'Shadow in the Window',
  category: 'halloween',
  scope: 'shape',
  description:
    'A lit window with a figure walking past. The figure is cut out of the light, so it reads as a real shadow.',
  params: [
    { key: 'color', type: 'color', label: 'Window light', default: '#ffbe6f' },
    { key: 'figure', type: 'select', label: 'Figure', default: 'person', options: ['person', 'creature', 'cat', 'reaper'] },
    { key: 'speed', type: 'range', label: 'Speed', default: 0.12, min: 0.01, max: 1.5, step: 0.005 },
    { key: 'size', type: 'range', label: 'Size', default: 0.85, min: 0.2, max: 1.6, step: 0.01 },
    { key: 'direction', type: 'select', label: 'Direction', default: 'right', options: ['right', 'left', 'pace'] },
    { key: 'pause', type: 'range', label: 'Pause & stare', default: 0.3, min: 0, max: 1, step: 0.01 },
    { key: 'level', type: 'range', label: 'Light level', default: 0.9, min: 0, max: 1.5, step: 0.01 },
  ],
  draw({ g, p, shape, t }) {
    const { bbox } = shape;
    if (bbox.w <= 0 || bbox.h <= 0) return;

    g.save();
    g.globalAlpha *= clamp(p.level, 0, 2);
    g.fillStyle = p.color;
    g.fill(shape.path);
    g.globalAlpha = 1;
    g.clip(shape.path);

    // Where along the window the figure is, 0..1 with generous margins so it
    // enters and leaves off-frame.
    let u;
    let facing = 1;
    const cycle = frac(t * p.speed);
    if (p.direction === 'pace') {
      const tri = Math.abs(cycle * 2 - 1);
      u = -0.25 + tri * 1.5;
      facing = cycle < 0.5 ? 1 : -1;
    } else if (p.direction === 'left') {
      u = 1.25 - cycle * 1.5;
      facing = -1;
    } else {
      u = -0.25 + cycle * 1.5;
    }

    // Optional hesitation in the middle: freeze the walk and turn to face out.
    let stride = t * p.speed * 14;
    let staring = 0;
    if (p.pause > 0) {
      const holdWindow = 0.18 * p.pause;
      const d = Math.abs(cycle - 0.5);
      if (d < holdWindow) {
        staring = 1 - d / holdWindow;
        u = p.direction === 'left' ? 1.25 - 0.5 * 1.5 : -0.25 + 0.5 * 1.5;
        stride = 0;
      }
    }

    const h = bbox.h * p.size;
    const x = bbox.x + u * bbox.w;
    const groundY = bbox.y + bbox.h * 1.02;

    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = '#000';
    g.strokeStyle = '#000';
    g.lineCap = 'round';
    g.lineJoin = 'round';

    drawFigure(g, p.figure, x, groundY, h, stride, facing, staring);
    g.restore();
  },
};

/** Procedural silhouettes. Crude by design — a sharp shadow reads better than detail. */
function drawFigure(g, kind, x, groundY, h, stride, facing, staring) {
  const swing = Math.sin(stride) * (staring > 0 ? 0 : 1);
  const swing2 = Math.sin(stride + Math.PI) * (staring > 0 ? 0 : 1);
  const bob = Math.abs(Math.sin(stride)) * h * 0.015;

  if (kind === 'cat') {
    const bodyH = h * 0.28;
    const y = groundY - bodyH;
    g.beginPath();
    g.ellipse(x, y, bodyH * 1.5, bodyH * 0.55, 0, 0, TAU);
    g.fill();
    // Head, ears and a curling tail.
    g.beginPath();
    g.arc(x + facing * bodyH * 1.5, y - bodyH * 0.5, bodyH * 0.45, 0, TAU);
    g.fill();
    g.beginPath();
    g.moveTo(x + facing * bodyH * 1.2, y - bodyH * 0.75);
    g.lineTo(x + facing * bodyH * 1.35, y - bodyH * 1.35);
    g.lineTo(x + facing * bodyH * 1.6, y - bodyH * 0.85);
    g.closePath();
    g.fill();
    g.lineWidth = bodyH * 0.22;
    g.beginPath();
    g.moveTo(x - facing * bodyH * 1.5, y);
    g.quadraticCurveTo(x - facing * bodyH * 2.6, y - bodyH * 0.4, x - facing * bodyH * 2.2, y - bodyH * 1.4);
    g.stroke();
    g.lineWidth = bodyH * 0.18;
    for (const off of [-0.7, 0.7]) {
      g.beginPath();
      g.moveTo(x + off * bodyH, y + bodyH * 0.4);
      g.lineTo(x + off * bodyH + swing * bodyH * 0.3, groundY);
      g.stroke();
    }
    return;
  }

  const headR = h * 0.075;
  const shoulderY = groundY - h * 0.72;
  const hipY = groundY - h * 0.42;
  const headY = groundY - h * 0.85 + bob;

  if (kind === 'reaper') {
    // A hooded robe: one big flared shape plus a dark hollow where a face isn't.
    g.beginPath();
    g.moveTo(x, headY - headR * 1.6);
    g.quadraticCurveTo(x + h * 0.16, shoulderY, x + h * 0.2, groundY);
    g.lineTo(x - h * 0.2, groundY);
    g.quadraticCurveTo(x - h * 0.16, shoulderY, x, headY - headR * 1.6);
    g.closePath();
    g.fill();
    g.lineWidth = h * 0.02;
    g.beginPath();
    g.moveTo(x + facing * h * 0.16, groundY - h * 0.05);
    g.lineTo(x + facing * h * 0.2, headY - h * 0.12);
    g.stroke();
    g.beginPath();
    g.moveTo(x + facing * h * 0.2, headY - h * 0.12);
    g.quadraticCurveTo(x + facing * h * 0.36, headY - h * 0.06, x + facing * h * 0.28, headY + h * 0.06);
    g.stroke();
    return;
  }

  const lean = kind === 'creature' ? facing * h * 0.06 : 0;

  g.beginPath();
  g.arc(x + lean, headY, headR * (kind === 'creature' ? 0.85 : 1), 0, TAU);
  g.fill();

  g.lineWidth = h * (kind === 'creature' ? 0.05 : 0.075);
  g.beginPath();
  g.moveTo(x + lean, headY + headR);
  g.lineTo(x, hipY);
  g.stroke();

  // Arms.
  g.lineWidth = h * 0.038;
  for (const [s, dir] of [[swing, 1], [swing2, -1]]) {
    g.beginPath();
    g.moveTo(x + lean * 0.5, shoulderY);
    const elbowX = x + lean * 0.5 + dir * h * 0.06 + s * h * 0.05;
    g.quadraticCurveTo(elbowX, shoulderY + h * 0.12, elbowX + s * h * 0.06, shoulderY + h * 0.24);
    g.stroke();
  }
  if (kind === 'creature') {
    // Longer, wrong-jointed arms hanging past the knees.
    g.lineWidth = h * 0.03;
    for (const dir of [-1, 1]) {
      g.beginPath();
      g.moveTo(x + lean * 0.5, shoulderY + h * 0.02);
      g.quadraticCurveTo(x + dir * h * 0.12, hipY, x + dir * h * 0.09 + swing * h * 0.04, groundY - h * 0.1);
      g.stroke();
    }
  }

  // Legs.
  g.lineWidth = h * 0.045;
  for (const s of [swing, swing2]) {
    g.beginPath();
    g.moveTo(x, hipY);
    g.quadraticCurveTo(x + s * h * 0.07, hipY + h * 0.2, x + s * h * 0.12, groundY);
    g.stroke();
  }
}

const ghost = {
  id: 'ghost',
  name: 'Ghost',
  category: 'halloween',
  scope: 'shape',
  description: 'A translucent apparition drifting through the shape, fading in and out.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#cfe8ff' },
    { key: 'count', type: 'range', label: 'Ghosts', default: 1, min: 1, max: 8, step: 1 },
    { key: 'size', type: 'range', label: 'Size', default: 0.55, min: 0.1, max: 1.5, step: 0.01 },
    { key: 'speed', type: 'range', label: 'Speed', default: 0.08, min: 0.005, max: 1, step: 0.005 },
    { key: 'opacity', type: 'range', label: 'Opacity', default: 0.45, min: 0.02, max: 1, step: 0.01 },
    { key: 'wobble', type: 'range', label: 'Wobble', default: 1, min: 0, max: 3, step: 0.05 },
    { key: 'fade', type: 'bool', label: 'Fade in/out', default: true },
  ],
  draw({ g, p, shape, t, noise }) {
    const { bbox } = shape;
    g.save();
    g.clip(shape.path);
    g.globalCompositeOperation = 'lighter';

    for (let k = 0; k < Math.round(p.count); k++) {
      const seed = k * 91.7;
      const cycle = frac(t * p.speed + k / Math.max(1, p.count));
      const x = bbox.x + bbox.w * (-0.2 + cycle * 1.4);
      const y = bbox.cy + noise.noise2(t * 0.25 + seed, 0) * bbox.h * 0.25;
      const h = bbox.h * p.size;
      const w = h * 0.6;

      const alpha = p.fade ? Math.sin(cycle * Math.PI) * p.opacity : p.opacity;
      if (alpha <= 0.01) continue;

      g.globalAlpha = alpha;
      const grad = g.createRadialGradient(x, y - h * 0.15, 0, x, y, h * 0.8);
      grad.addColorStop(0, rgba(p.color, 0.95));
      grad.addColorStop(0.55, rgba(p.color, 0.35));
      grad.addColorStop(1, rgba(p.color, 0));
      g.fillStyle = grad;

      // Body: a dome with a ragged, waving hem.
      g.beginPath();
      g.moveTo(x - w / 2, y + h * 0.35);
      g.quadraticCurveTo(x - w / 2, y - h * 0.5, x, y - h * 0.5);
      g.quadraticCurveTo(x + w / 2, y - h * 0.5, x + w / 2, y + h * 0.35);
      const tails = 5;
      for (let i = tails; i >= 0; i--) {
        const f = i / tails;
        const tx = x - w / 2 + f * w;
        const wave = Math.sin(f * Math.PI * tails + t * 3 * p.wobble + seed) * h * 0.07 * p.wobble;
        g.lineTo(tx, y + h * 0.35 + wave + (i % 2 ? h * 0.05 : 0));
      }
      g.closePath();
      g.fill();

      // Hollow eyes, subtracted from the glow.
      g.globalCompositeOperation = 'destination-out';
      g.globalAlpha = alpha * 1.6;
      for (const side of [-1, 1]) {
        g.beginPath();
        g.ellipse(x + side * w * 0.17, y - h * 0.18, w * 0.09, h * 0.08, 0, 0, TAU);
        g.fill();
      }
      g.beginPath();
      g.ellipse(x, y - h * 0.02, w * 0.08, h * 0.06, 0, 0, TAU);
      g.fill();
      g.globalCompositeOperation = 'lighter';
    }
    g.restore();
  },
};

/**
 * A spider, drawn the way a spider is actually built.
 *
 * The old one was eight identical spokes on a single ellipse, which reads as a
 * sun symbol. Three things separate that from something your eye accepts:
 *
 * - **Two body segments.** A big abdomen behind a small cephalothorax, joined by
 *   a narrow waist. Every leg hangs off the *front* segment, not the middle of
 *   the whole animal.
 * - **Legs that arch.** A spider leg goes out and *outward* to a raised knee,
 *   then back in to the foot. That outward bow is the single most recognisable
 *   thing about the silhouette, and a straight line has none of it.
 * - **Four different pairs.** Legs I and II reach forward, III sideways, IV
 *   backward and longest. Eight evenly spaced legs is a wheel; unevenly spaced
 *   ones are an animal.
 *
 * `gait` runs 0..1 and walks it, alternate tetrapod — the diagonal groups swing
 * out of phase, which is how eight legs stay coordinated without tripping.
 *
 * Drawn facing +x at the origin; rotate before calling to aim it.
 */
export function drawSpider(g, size, gait, colour, lineWidth) {
  // Per pair: angle away from forward (degrees, toward that leg's own side),
  // reach in body units, and where along the cephalothorax the hip sits. All
  // angles are positive and mirrored by `side` — a negative here would put the
  // leg on the opposite flank and the two sides would sit on top of each other.
  // Leg I reaches forward, IV trails behind and is the longest.
  const PAIRS = [
    [32, 2.45, 0.74],
    [68, 2.3, 0.55],
    [108, 2.15, 0.34],
    [143, 2.8, 0.16],
  ];
  const s = size;
  const RAD = Math.PI / 180;

  g.strokeStyle = colour;
  g.fillStyle = colour;
  g.lineCap = 'round';
  g.lineJoin = 'round';

  for (let pair = 0; pair < 4; pair++) {
    const [baseDeg, reach, along] = PAIRS[pair];
    for (const side of [-1, 1]) {
      // Alternate tetrapod: diagonal legs swing together, so the body is always
      // held up by four feet spread around it.
      const group = (pair + (side > 0 ? 1 : 0)) % 2;
      const swing = Math.sin((gait + group * 0.5) * TAU);

      const hip = { x: s * along, y: side * s * 0.26 };
      const theta = side * (baseDeg + swing * 11) * RAD;
      const len = s * reach * (1 + swing * 0.06);
      // The knee is pulled towards straight-out-sideways, so the leg bows away
      // from the body and comes back in to the foot. Pulling *towards* 90°
      // rather than adding a fixed offset is what keeps the rear legs arching
      // outward too instead of folding under the abdomen.
      const kneeA = side * (baseDeg + (90 - baseDeg) * 0.5) * RAD;
      const kneeR = len * (0.56 + Math.max(0, swing) * 0.07);
      const knee = { x: hip.x + Math.cos(kneeA) * kneeR, y: hip.y + Math.sin(kneeA) * kneeR };
      const foot = { x: hip.x + Math.cos(theta) * len, y: hip.y + Math.sin(theta) * len };

      g.lineWidth = lineWidth;
      g.beginPath();
      g.moveTo(hip.x, hip.y);
      g.lineTo(knee.x, knee.y);
      g.stroke();
      // The lower half of the leg is visibly finer than the thigh, and curves
      // down to the foot rather than meeting it in a straight line.
      g.lineWidth = lineWidth * 0.6;
      g.beginPath();
      g.moveTo(knee.x, knee.y);
      g.quadraticCurveTo(
        (knee.x + foot.x) / 2 + Math.cos(kneeA) * len * 0.1,
        (knee.y + foot.y) / 2 + Math.sin(kneeA) * len * 0.1,
        foot.x, foot.y
      );
      g.stroke();
    }
  }

  // Waist first, so the two segments read as joined rather than overlapping.
  g.lineWidth = s * 0.22;
  g.beginPath();
  g.moveTo(-s * 0.25, 0);
  g.lineTo(s * 0.3, 0);
  g.stroke();

  g.beginPath();
  g.ellipse(-s * 0.72, 0, s * 0.78, s * 0.62, 0, 0, TAU);
  g.fill();
  g.beginPath();
  g.ellipse(s * 0.46, 0, s * 0.5, s * 0.42, 0, 0, TAU);
  g.fill();

  // Pedipalps — the short pair under the face. Small, but their absence is why
  // a spider without them looks like it is missing something at the front.
  g.lineWidth = lineWidth * 0.7;
  for (const side of [-1, 1]) {
    g.beginPath();
    g.moveTo(s * 0.75, side * s * 0.16);
    g.quadraticCurveTo(s * 1.15, side * s * 0.3, s * 1.3, side * s * 0.14);
    g.stroke();
  }
}

const web = {
  id: 'web',
  name: 'Spider Web',
  category: 'halloween',
  scope: 'shape',
  description: 'A web anchored in a corner of the shape, with a spider that comes and goes.',
  params: [
    { key: 'color', type: 'color', label: 'Web colour', default: '#e8f0ff' },
    { key: 'corner', type: 'select', label: 'Anchor', default: 'top-left', options: ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'centre'] },
    { key: 'rings', type: 'range', label: 'Rings', default: 6, min: 2, max: 16, step: 1 },
    { key: 'spokes', type: 'range', label: 'Spokes', default: 10, min: 3, max: 28, step: 1 },
    { key: 'width', type: 'range', label: 'Thread width', default: 2, min: 0.5, max: 12, step: 0.25 },
    { key: 'scale', type: 'range', label: 'Size', default: 1, min: 0.2, max: 2, step: 0.01 },
    { key: 'spider', type: 'bool', label: 'Spider', default: true },
    { key: 'spiderSpeed', type: 'range', label: 'Spider speed', default: 0.12, min: 0.01, max: 1, step: 0.005 },
    { key: 'sway', type: 'range', label: 'Sway', default: 0.4, min: 0, max: 2, step: 0.01 },
  ],
  draw({ g, p, shape, t, noise }) {
    const { bbox } = shape;
    const corners = {
      'top-left': [bbox.x, bbox.y, 0, 90],
      'top-right': [bbox.x + bbox.w, bbox.y, 90, 180],
      'bottom-left': [bbox.x, bbox.y + bbox.h, 270, 360],
      'bottom-right': [bbox.x + bbox.w, bbox.y + bbox.h, 180, 270],
      centre: [bbox.cx, bbox.cy, 0, 360],
    };
    const [ax, ay, a0deg, a1deg] = corners[p.corner] || corners['top-left'];
    const a0 = (a0deg * Math.PI) / 180;
    const a1 = (a1deg * Math.PI) / 180;
    const maxR = Math.hypot(bbox.w, bbox.h) * (p.corner === 'centre' ? 0.45 : 0.85) * p.scale;
    const spokes = Math.round(p.spokes);
    const rings = Math.round(p.rings);
    const sway = (i) => noise.noise2(t * 0.4, i * 3.1) * p.sway * maxR * 0.01;

    g.save();
    g.clip(shape.path);
    g.strokeStyle = p.color;
    g.lineWidth = p.width;
    g.globalAlpha *= 0.85;

    for (let s = 0; s <= spokes; s++) {
      const a = lerp(a0, a1, s / spokes);
      g.beginPath();
      g.moveTo(ax, ay);
      g.lineTo(ax + Math.cos(a) * maxR + sway(s), ay + Math.sin(a) * maxR + sway(s + 7));
      g.stroke();
    }

    // Rings sag between spokes, which is what makes it look spun rather than drawn.
    for (let r = 1; r <= rings; r++) {
      const radius = (r / rings) * maxR;
      g.beginPath();
      for (let s = 0; s <= spokes; s++) {
        const a = lerp(a0, a1, s / spokes);
        const x = ax + Math.cos(a) * radius + sway(s + r);
        const y = ay + Math.sin(a) * radius + sway(s + r + 13);
        if (s === 0) g.moveTo(x, y);
        else {
          const aPrev = lerp(a0, a1, (s - 1) / spokes);
          const aMid = (a + aPrev) / 2;
          const sag = radius * 0.93;
          g.quadraticCurveTo(ax + Math.cos(aMid) * sag, ay + Math.sin(aMid) * sag, x, y);
        }
      }
      g.stroke();
    }

    if (p.spider) {
      const phase = frac(t * p.spiderSpeed);
      // Out along a thread, pause, back again.
      const out = phase < 0.5 ? phase * 2 : (1 - phase) * 2;
      const sa = lerp(a0, a1, 0.5 + noise.noise2(Math.floor(t * p.spiderSpeed), 0) * 0.3);
      const sr = 0.15 * maxR + out * maxR * 0.7;
      const sx = ax + Math.cos(sa) * sr;
      const sy = ay + Math.sin(sa) * sr;
      const bodyR = maxR * 0.03;

      // It faces the way it is going, and it is going backwards on the way in —
      // a spider that slides down its own thread nose-first and then reverses up
      // it without turning round is the tell that this is a sprite on a rail.
      const heading = phase < 0.5 ? sa : sa + Math.PI;
      // Legs only cycle while it is actually travelling. The pause at full
      // stretch is a pause, not a moonwalk.
      const moving = Math.abs(phase - 0.5) > 0.03;
      const gait = moving ? frac(t * p.spiderSpeed * 9) : 0.25;

      g.globalAlpha = 1;
      g.save();
      g.translate(sx, sy);
      g.rotate(heading);
      drawSpider(g, bodyR, gait, p.color, Math.max(0.8, p.width * 0.85));
      g.restore();
    }
    g.restore();
  },
};

const fog = {
  id: 'fog',
  name: 'Rolling Fog',
  category: 'halloween',
  scope: 'shape',
  description:
    'Drifting mist as a density field advected by a divergence-free flow, so it folds and curls instead of pulsing.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#8ea6c0' },
    { key: 'density', type: 'range', label: 'Density', default: 0.35, min: 0, max: 1, step: 0.01 },
    { key: 'scale', type: 'range', label: 'Scale', default: 2.2, min: 0.3, max: 10, step: 0.05 },
    { key: 'speed', type: 'range', label: 'Drift speed', default: 0.06, min: -0.6, max: 0.6, step: 0.005 },
    { key: 'swirl', type: 'range', label: 'Swirl', default: 0.5, min: 0, max: 2, step: 0.01 },
    { key: 'height', type: 'range', label: 'Height', default: 0.55, min: 0.05, max: 1, step: 0.01 },
    { key: 'detail', type: 'range', label: 'Detail', default: 52, min: 12, max: 120, step: 2 },
    { key: 'softness', type: 'range', label: 'Top softness', default: 0.6, min: 0, max: 1, step: 0.01 },
  ],
  draw({ g, p, shape, t, state, noise }) {
    const { bbox } = shape;
    if (bbox.w <= 2 || bbox.h <= 2 || p.density <= 0.001) return;

    const cols = Math.max(8, Math.round(p.detail));
    const rows = Math.max(8, Math.round((cols * bbox.h) / bbox.w));
    const field = ensureField(state, 'field', cols, rows);
    field.clear();

    const [cr, cg, cb] = (() => {
      const h = String(p.color).replace('#', '');
      const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
      const n = parseInt(full.slice(0, 6), 16) || 0;
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    })();

    const drift = t * p.speed;

    for (let y = 0; y < rows; y++) {
      const v = (y + 0.5) / rows;
      // Fog sits low and thins upward. Anything above the height is empty.
      const above = (1 - v) / Math.max(0.01, p.height);
      if (above > 1.2) continue;
      const vertical = clamp(1 - above, 0, 1) ** (0.6 + p.softness * 1.6);
      if (vertical <= 0.005) continue;

      for (let x = 0; x < cols; x++) {
        const u = (x + 0.5) / cols;

        // Advect the sample point along a curl-noise flow. A plain noise field
        // has sources and sinks, so fog driven by one bunches up and thins out;
        // a divergence-free flow conserves volume and the mist folds instead.
        const [fx, fy] = curlNoise(noise, u * p.scale * 0.6 + drift, v * p.scale * 0.6, t * 0.06);
        const warpAmount = p.swirl * 0.35;
        const su = u * p.scale + fx * warpAmount + drift;
        const sv = v * p.scale + fy * warpAmount;

        const n1 = noise.noise3(su, sv, t * 0.05);
        const n2 = noise.noise3(su * 2.3 + 4.1, sv * 2.3 - 1.7, t * 0.09);
        const detail = clamp(0.5 + 0.4 * n1 + 0.2 * n2, 0, 1);

        const density = clamp(detail * vertical * p.density * 1.6 - 0.06, 0, 1);
        if (density <= 0.008) continue;
        field.set(x, y, cr, cg, cb, density);
      }
    }

    g.save();
    g.clip(shape.path);
    field.blit(g, bbox.x, bbox.y, bbox.w, bbox.h);
    g.restore();
  },
};

const smoke = {
  id: 'smoke',
  name: 'Smoke',
  category: 'halloween',
  scope: 'shape',
  description:
    'A rising, self-shadowing plume. Denser at the source, thinning and spreading as it climbs.',
  params: [
    { key: 'color', type: 'color', label: 'Colour', default: '#59606b' },
    { key: 'shadow', type: 'color', label: 'Dense colour', default: '#14171c' },
    { key: 'density', type: 'range', label: 'Density', default: 0.6, min: 0, max: 1.5, step: 0.01 },
    { key: 'rise', type: 'range', label: 'Rise speed', default: 0.35, min: 0.01, max: 2, step: 0.01 },
    { key: 'spread', type: 'range', label: 'Spread', default: 0.5, min: 0.05, max: 1.5, step: 0.01 },
    { key: 'swirl', type: 'range', label: 'Swirl', default: 0.8, min: 0, max: 3, step: 0.01 },
    { key: 'scale', type: 'range', label: 'Scale', default: 2.6, min: 0.3, max: 10, step: 0.05 },
    { key: 'sourceX', type: 'range', label: 'Source X', default: 0.5, min: 0, max: 1, step: 0.01 },
    { key: 'detail', type: 'range', label: 'Detail', default: 52, min: 12, max: 120, step: 2 },
    { key: 'lift', type: 'range', label: 'Dissipation', default: 0.6, min: 0.05, max: 1, step: 0.01 },
  ],
  draw({ g, p, shape, t, state, noise }) {
    const { bbox } = shape;
    if (bbox.w <= 2 || bbox.h <= 2 || p.density <= 0.001) return;

    const cols = Math.max(8, Math.round(p.detail));
    const rows = Math.max(8, Math.round((cols * bbox.h) / bbox.w));
    const field = ensureField(state, 'field', cols, rows);
    field.clear();

    const climb = t * p.rise;

    // The same trick caustics uses: build the density-to-colour ramp once per
    // frame rather than once per cell. The old version called `mixLinear` per
    // cell — which assembles a CSS hex string — and then immediately parsed
    // that string back into the three bytes it had just formatted. Thousands of
    // times a frame, to arrive where it started.
    const RAMP_STEPS = 24;
    const ramp = [];
    for (let i = 0; i < RAMP_STEPS; i++) {
      const hex = mixLinear(p.color, p.shadow, i / (RAMP_STEPS - 1)).replace('#', '');
      const n = parseInt(hex, 16) || 0;
      ramp.push([(n >> 16) & 255, (n >> 8) & 255, n & 255]);
    }

    for (let y = 0; y < rows; y++) {
      const v = (y + 0.5) / rows;
      const hh = 1 - v; // 0 at the source, 1 at the top

      // The plume widens as it rises and dissipates as it goes.
      const width = p.spread * (0.18 + hh * 1.5);
      const fade = Math.pow(clamp(1 - hh / Math.max(0.05, p.lift), 0, 1), 0.9);
      if (fade <= 0.004) continue;

      for (let x = 0; x < cols; x++) {
        const u = (x + 0.5) / cols;
        const dx = (u - p.sourceX) / Math.max(0.02, width);
        if (dx * dx > 8) continue;
        const profile = Math.exp(-dx * dx * 0.9);

        const [fx, fy] = curlNoise(noise, u * p.scale * 0.5, (v * p.scale * 0.5) + climb, t * 0.08);
        const warp = p.swirl * 0.4;
        const su = u * p.scale + fx * warp;
        const sv = v * p.scale + climb + fy * warp;

        const n1 = noise.noise3(su, sv, t * 0.05);
        const n2 = noise.noise3(su * 2.1 + 7.3, sv * 2.1, t * 0.11);
        const turbulent = clamp(0.5 + 0.4 * n1 + 0.22 * n2, 0, 1);

        const density = clamp(profile * turbulent * fade * p.density * 1.7 - 0.05, 0, 1);
        if (density <= 0.008) continue;

        // Denser smoke is darker, because it blocks more of what is behind it.
        // Interpolating that in linear light keeps the mid-tones from going flat.
        const shade = ramp[Math.min(RAMP_STEPS - 1, (clamp(density * 1.1, 0, 1) * (RAMP_STEPS - 1)) | 0)];
        field.set(x, y, shade[0], shade[1], shade[2], density);
      }
    }

    g.save();
    g.clip(shape.path);
    field.blit(g, bbox.x, bbox.y, bbox.w, bbox.h);
    g.restore();
  },
};

const portal = {
  id: 'portal',
  name: 'Portal',
  category: 'halloween',
  scope: 'shape',
  description: 'A swirling vortex filling the shape. Doors become somewhere else.',
  params: [
    { key: 'color', type: 'color', label: 'Inner', default: '#8a2be2' },
    { key: 'color2', type: 'color', label: 'Outer', default: '#00ffc8' },
    { key: 'arms', type: 'range', label: 'Arms', default: 5, min: 1, max: 16, step: 1 },
    { key: 'twist', type: 'range', label: 'Twist', default: 3, min: 0, max: 12, step: 0.1 },
    { key: 'speed', type: 'range', label: 'Speed', default: 0.5, min: -3, max: 3, step: 0.01 },
    { key: 'detail', type: 'range', label: 'Detail', default: 60, min: 12, max: 200, step: 1 },
    { key: 'core', type: 'range', label: 'Core size', default: 0.15, min: 0, max: 0.8, step: 0.01 },
  ],
  draw({ g, p, shape, t }) {
    const { bbox } = shape;
    const R = Math.max(bbox.w, bbox.h) * 0.6;
    g.save();
    g.clip(shape.path);
    g.translate(bbox.cx, bbox.cy);
    g.globalCompositeOperation = 'lighter';

    const steps = Math.round(p.detail);
    g.lineCap = 'round';
    for (let a = 0; a < p.arms; a++) {
      const base = (a / p.arms) * TAU + t * p.speed;
      g.beginPath();
      for (let i = 0; i <= steps; i++) {
        const f = i / steps;
        const r = R * f;
        const angle = base + f * p.twist;
        const x = Math.cos(angle) * r;
        const y = Math.sin(angle) * r * (bbox.h / Math.max(1, bbox.w));
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      const grad = g.createRadialGradient(0, 0, 0, 0, 0, R);
      grad.addColorStop(0, rgba(p.color, 0.9));
      grad.addColorStop(1, rgba(p.color2, 0));
      g.strokeStyle = grad;
      g.lineWidth = R * 0.08;
      g.stroke();
    }

    if (p.core > 0) {
      const cr = R * p.core;
      const grad = g.createRadialGradient(0, 0, 0, 0, 0, cr);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.4, rgba(p.color, 0.8));
      grad.addColorStop(1, rgba(p.color, 0));
      g.fillStyle = grad;
      g.beginPath();
      g.arc(0, 0, cr, 0, TAU);
      g.fill();
    }
    g.restore();
  },
};

export default [bloodDrip, lightning, fire, candle, eyes, silhouette, ghost, web, fog, smoke, portal];
