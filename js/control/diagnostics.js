/**
 * "Why can't I see it?"
 *
 * By some distance the most common way to lose an hour with this app is to add
 * an effect, see nothing on the wall, and have no idea which of the eight
 * plausible reasons is the one. Bypassed. Soloed out by another layer. Opacity
 * left at zero from an earlier fiddle. Pointed at `#window` before any shape was
 * tagged. Pointed at a shape that has since been hidden, or deleted. Master
 * down. Blacked out. Every one of those is knowable from the project object,
 * and none of them is visible in the list.
 *
 * So they are computed here and shown as a chip on the row and a sentence in
 * the inspector. Everything is a pure function of the project so it can be
 * tested, and so the same answers can be given anywhere they are useful.
 */

import { resolveTargets } from '../core/state.js';

/**
 * Reasons this layer will not put light on the wall right now.
 *
 * Ordered most-proximate first: if a layer is both bypassed and pointed at a
 * tag nothing carries, "it is bypassed" is the sentence you want first, because
 * it is the one you can act on without thinking.
 */
export function layerIssues(project, layer, effect) {
  const issues = [];
  if (!project || !layer) return issues;

  if (!effect) {
    issues.push({
      key: 'missing',
      level: 'bad',
      short: 'missing',
      text: `No effect called "${layer.effect}" is loaded. It was probably a custom effect that has been deleted.`,
    });
    return issues; // Nothing below this can be judged without the effect.
  }

  if (layer.enabled === false) {
    issues.push({ key: 'bypassed', level: 'warn', short: 'bypassed', text: 'This layer is bypassed. Click the ◉ beside it to switch it back on.' });
  }

  const soloed = project.layers?.some((l) => l.solo && l.enabled !== false);
  if (soloed && !layer.solo) {
    issues.push({ key: 'solo', level: 'warn', short: 'soloed out', text: 'Another layer is soloed, so only that one is drawing. Turn its S off.' });
  }

  if (layer.opacity === 0) {
    issues.push({ key: 'opacity', level: 'warn', short: 'opacity 0', text: 'Opacity is at zero.' });
  }

  // An effect that reads the building's surface has nothing to read until a
  // scan has been imported and placed. Silent otherwise, and indistinguishable
  // from every other reason a layer draws nothing.
  if (effect.needs === 'depth' && !project.scan?.enabled) {
    issues.push({
      key: 'no-scan',
      level: 'bad',
      short: 'no scan',
      text: 'This effect lights the real surface of the building, which needs a depth scan. Import one under Setup > Depth scan.',
    });
  }

  // Targeting is where the quiet failures live, so it is worth separating the
  // three ways it goes wrong — they have three different fixes.
  const wantsTargets = (layer.targets?.length || 0) + (layer.targetTags?.length || 0) > 0;
  if (wantsTargets) {
    const resolved = resolveTargets(project, layer);
    if (!resolved.length) {
      // Everything the layer *would* light if nothing were hidden — by id and
      // by tag both, because a preset points at `#wall` rather than at a shape
      // and hiding that wall must not be reported as "nothing carries #wall".
      const candidates = matchedShapes(project, layer);

      if (candidates.length) {
        issues.push({
          key: 'hidden',
          level: 'warn',
          short: 'shapes hidden',
          text: `${candidates.length === 1 ? `"${candidates[0].name}" is` : 'Every shape this points at is'} hidden. Click the ◉ in the Shapes list.`,
        });
      } else if ((layer.targetTags?.length || 0) > 0) {
        const tags = layer.targetTags.map((t) => `#${t}`).join(', ');
        issues.push({
          key: 'no-tag',
          level: 'warn',
          short: 'no shapes match',
          text: `Nothing carries ${tags}. Tag a shape with it, or point this at a shape directly.`,
        });
      } else {
        issues.push({
          key: 'deleted',
          level: 'warn',
          short: 'targets gone',
          text: 'The shapes this pointed at have been deleted. Give it new targets, or clear them to cover the whole frame.',
        });
      }
    }
  }

  return issues;
}

/**
 * Shapes a layer names, whether or not they are currently visible.
 *
 * `resolveTargets` drops hidden shapes, which is right for rendering and wrong
 * for explaining, since "it is hidden" and "it does not exist" need different
 * sentences and have different fixes.
 */
function matchedShapes(project, layer) {
  const wanted = (layer.targetTags || []).map((t) => String(t).toLowerCase());
  const ids = new Set(layer.targets || []);
  return (project.shapes || []).filter(
    (s) => ids.has(s.id) || s.tags?.some((t) => wanted.includes(String(t).toLowerCase()))
  );
}

/**
 * Reasons *nothing at all* is on the wall — the ones that are not any one
 * layer's fault.
 *
 * Blackout is the one that catches people, because the button is at the far
 * bottom-right of the window and B is easy to hit while thinking about
 * something else.
 */
export function showIssues(project, runtime = {}) {
  const issues = [];
  if (!project) return issues;

  const settings = project.settings || {};
  if (settings.blackout) {
    issues.push({ key: 'blackout', level: 'bad', text: 'The show is blacked out. Press B or the Blackout button to bring it back.' });
  }
  if ((settings.master ?? 1) === 0) {
    issues.push({ key: 'master', level: 'warn', text: 'Master is at zero, so every projector is dark.' });
  }
  if (runtime.playing === false) {
    issues.push({ key: 'paused', level: 'warn', text: 'The clock is paused, so nothing is animating. Press Space.' });
  }
  if (!project.projectors?.some((p) => p.calibration?.H)) {
    issues.push({ key: 'unaligned', level: 'info', text: 'No projector is aligned yet, so what you see in the preview will not land on the house.' });
  }

  const layers = project.layers || [];
  if (layers.length && layers.every((l) => l.enabled === false)) {
    issues.push({ key: 'all-bypassed', level: 'warn', text: 'Every effect is bypassed.' });
  }

  return issues;
}

/** One short line for a status area — the first thing wrong, or nothing. */
export function summarise(issues) {
  if (!issues.length) return '';
  return issues[0].text;
}
