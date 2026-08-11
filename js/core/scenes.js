/**
 * Scenes and crossfades.
 *
 * A scene is a saved set of layer states — which layers are on, at what opacity,
 * with what parameter values. Switching scenes is stored as "we left scene A for
 * scene B at wall-clock time T over F seconds", not as a stream of interpolated
 * values. Every tab then computes the same blend from the same three numbers,
 * so a crossfade stays in step across projectors without any per-frame traffic.
 */

import { clamp, lerp } from './math.js';

/** Capture the current live state of every layer as a scene snapshot. */
export function captureScene(project) {
  const state = {};
  for (const layer of project.layers) {
    state[layer.id] = {
      enabled: !!layer.enabled,
      opacity: layer.opacity ?? 1,
      params: { ...layer.params },
    };
  }
  return state;
}

/** Blend factor for the running transition, 0 = fully previous, 1 = fully active. */
export function transitionProgress(show, now = Date.now()) {
  if (!show?.sceneChangeAt) return 1;
  const fade = Math.max(0, show.fade ?? 0);
  if (fade <= 0) return 1;
  return clamp((now - show.sceneChangeAt) / 1000 / fade, 0, 1);
}

function blendLayerState(from, to, f) {
  if (!from) return to;
  if (!to) return from;

  const params = { ...from.params, ...to.params };
  for (const key of Object.keys(params)) {
    const a = from.params?.[key];
    const b = to.params?.[key];
    if (typeof a === 'number' && typeof b === 'number') {
      params[key] = lerp(a, b, f);
    } else {
      // Strings, colours and booleans can't be meaningfully interpolated, so
      // they switch at the midpoint of the fade.
      params[key] = f < 0.5 ? a ?? b : b ?? a;
    }
  }

  // A layer that's on in only one of the two scenes fades its opacity rather
  // than popping, which is what makes a crossfade look like a crossfade.
  const fromOpacity = from.enabled ? from.opacity ?? 1 : 0;
  const toOpacity = to.enabled ? to.opacity ?? 1 : 0;
  const opacity = lerp(fromOpacity, toOpacity, f);

  return { enabled: opacity > 0.001, opacity, params };
}

/**
 * Produce the effective layer list for this instant.
 *
 * Returns fresh objects — the project's own layers are never mutated, so the
 * control tab's inspector keeps showing the authored values while the render
 * shows the blended ones.
 */
export function effectiveLayers(project, now = Date.now()) {
  const show = project.show || {};
  const scenes = new Map((project.scenes || []).map((s) => [s.id, s]));
  const active = scenes.get(show.activeScene);
  const previous = scenes.get(show.previousScene);

  if (!active) return project.layers;

  const f = transitionProgress(show, now);
  const out = [];

  for (const layer of project.layers) {
    const toState = active.state?.[layer.id];
    const fromState = previous?.state?.[layer.id];

    // A layer the scene says nothing about keeps its authored state.
    if (!toState && !fromState) {
      out.push(layer);
      continue;
    }

    const blended =
      f >= 1 || !fromState
        ? toState || { enabled: false, opacity: 0, params: layer.params }
        : blendLayerState(fromState, toState, f);

    out.push({
      ...layer,
      enabled: blended.enabled,
      opacity: blended.opacity,
      params: { ...layer.params, ...blended.params },
    });
  }

  return out;
}

/** Switch scenes, recording enough for every tab to reproduce the crossfade. */
export function activateScene(project, sceneId, { fade } = {}) {
  const scene = (project.scenes || []).find((s) => s.id === sceneId);
  if (!scene) return project.show;
  const show = project.show || (project.show = {});
  show.previousScene = show.activeScene || null;
  show.activeScene = sceneId;
  show.fade = fade ?? scene.fade ?? 0;
  show.sceneChangeAt = Date.now();
  return show;
}

/**
 * Advance an unattended playlist.
 *
 * Called once per frame in the control tab only — projector tabs follow the
 * broadcast result rather than each running their own timer, so they can't drift
 * onto different scenes.
 */
export function tickPlaylist(project, now = Date.now()) {
  const show = project.show;
  if (!show?.running || !show.playlist?.length) return false;

  const entries = show.playlist.filter((e) => (project.scenes || []).some((s) => s.id === e.sceneId));
  if (!entries.length) return false;

  if (!show.playlistStartedAt) {
    show.playlistStartedAt = now;
    show.playlistIndex = 0;
    activateScene(project, entries[0].sceneId, { fade: entries[0].fade });
    return true;
  }

  const current = entries[Math.min(show.playlistIndex ?? 0, entries.length - 1)];
  const elapsed = (now - show.playlistStartedAt) / 1000;
  if (elapsed < (current.duration ?? 30)) return false;

  let nextIndex = (show.playlistIndex ?? 0) + 1;
  if (nextIndex >= entries.length) {
    if (!show.loop) {
      show.running = false;
      return true;
    }
    nextIndex = 0;
  }
  if (show.shuffle && entries.length > 1) {
    // Avoid repeating the scene we just played.
    let pick = Math.floor(Math.random() * entries.length);
    if (pick === (show.playlistIndex ?? 0)) pick = (pick + 1) % entries.length;
    nextIndex = pick;
  }

  show.playlistIndex = nextIndex;
  show.playlistStartedAt = now;
  activateScene(project, entries[nextIndex].sceneId, { fade: entries[nextIndex].fade });
  return true;
}
