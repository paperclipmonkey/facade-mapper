/**
 * Left-panel lists: projectors, shapes, effect layers, scenes, playlist, media.
 *
 * Each renderer is a pure "clear and rebuild" function. The lists are short
 * enough that diffing would cost more in complexity than it saves in frames, and
 * rebuilding keeps the DOM honest when the project is replaced wholesale by an
 * import or an undo.
 */

import { el, clear, escapeHtml } from './ui.js';
import { getEffect } from '../effects/registry.js';
import { formatBytes } from '../core/media.js';
import { storageUsage } from '../core/storage.js';
import { PROJECTOR_COLOURS } from './stage.js';

export function renderProjectorList(node, app) {
  clear(node);
  app.project.projectors.forEach((projector, index) => {
    const peer = app.presence.forProjector(projector.id);
    const selected = app.selection.type === 'projector' && app.selection.id === projector.id;
    const colour = PROJECTOR_COLOURS[index % PROJECTOR_COLOURS.length];

    const dot = el('span', { text: '●' });
    dot.style.color = colour;

    const item = el('div', { class: `list-item${selected ? ' selected' : ''}` }, [
      dot,
      el('span', { class: 'item-title', text: projector.name }),
      el('span', {
        class: `chip ${projector.calibration?.H ? 'good' : 'warn'}`,
        text: projector.calibration?.H ? 'aligned' : 'align',
      }),
      el('span', { class: `chip ${peer ? 'good' : ''}`, text: peer ? 'live' : 'closed' }),
    ]);
    item.addEventListener('click', () => app.select({ type: 'projector', id: projector.id }));
    node.appendChild(item);
  });

  if (!app.project.projectors.length) {
    node.appendChild(el('p', { class: 'panel-note', text: 'No projectors configured.' }));
  }
}

export function renderShapeList(node, app, filter = '') {
  clear(node);
  const query = filter.trim().toLowerCase();
  const shapes = app.project.shapes.filter((shape) => {
    if (!query) return true;
    return (
      shape.name.toLowerCase().includes(query) ||
      (shape.tags || []).some((t) => t.toLowerCase().includes(query))
    );
  });

  if (!shapes.length) {
    node.appendChild(
      el('p', {
        class: 'panel-note',
        html: query
          ? 'Nothing matches that filter.'
          : 'No shapes yet. Pick the <strong>Area</strong> tool and click round a window.',
      })
    );
    return;
  }

  for (const shape of shapes) {
    const selected = app.selection.type === 'shape' && app.selection.id === shape.id;

    const visibility = el('button', {
      type: 'button',
      class: `icon-btn${shape.visible !== false ? ' on' : ''}`,
      title: 'Show or hide',
      text: shape.visible !== false ? '◉' : '○',
    });
    visibility.addEventListener('click', (ev) => {
      ev.stopPropagation();
      app.pushUndo();
      shape.visible = shape.visible === false;
      app.commit();
    });

    // The other half of the link: what is actually lighting this shape up. A
    // shape you traced and never pointed anything at looks exactly like one
    // carrying four effects, and "nothing is happening on that window" is the
    // hardest thing to diagnose from a list that does not say.
    const hits = app.project.layers.filter(
      (layer) => layer.enabled !== false && targetedShapeIds(app, layer).includes(shape.id)
    );
    const effectsLabel = hits.length
      ? `${hits.length} effect${hits.length === 1 ? '' : 's'}`
      : 'no effects';

    const item = el('div', { class: `list-item${selected ? ' selected' : ''}` }, [
      visibility,
      el('span', { class: 'item-title', text: shape.name, title: shape.name }),
      shape.tags?.length ? el('span', { class: 'item-sub', text: `#${shape.tags[0]}${shape.tags.length > 1 ? `+${shape.tags.length - 1}` : ''}` }) : null,
      el('span', { class: 'item-sub', text: shape.closed ? 'area' : 'path' }),
      el('span', {
        class: `item-sub${hits.length ? '' : ' muted'}`,
        text: effectsLabel,
        title: hits.length
          ? hits.map((l) => l.name || getEffect(l.effect)?.name || l.effect).join(', ')
          : 'Nothing is drawing into this shape yet.',
      }),
    ]);
    item.addEventListener('click', () => app.select({ type: 'shape', id: shape.id }));
    item.addEventListener('mouseenter', () => app.highlightShapes?.([shape.id]));
    item.addEventListener('mouseleave', () => app.highlightShapes?.(null));
    node.appendChild(item);
  }
}

export function renderLayerList(node, app) {
  clear(node);
  const layers = [...app.project.layers].sort((a, b) => (a.order || 0) - (b.order || 0));

  if (!layers.length) {
    node.appendChild(
      el('p', {
        class: 'panel-note',
        html: 'No effects yet. <strong>Add effect</strong> to get started — try Candle Flicker on a window.',
      })
    );
    return;
  }

  layers.forEach((layer, index) => {
    const effect = getEffect(layer.effect);
    const selected = app.selection.type === 'layer' && app.selection.id === layer.id;

    const power = el('button', {
      type: 'button',
      class: `icon-btn${layer.enabled ? ' on' : ''}`,
      title: 'Enable or bypass',
      text: layer.enabled ? '◉' : '○',
    });
    power.addEventListener('click', (ev) => {
      ev.stopPropagation();
      layer.enabled = !layer.enabled;
      app.commitLive();
      app.refreshPanels();
    });

    const solo = el('button', {
      type: 'button',
      class: `icon-btn${layer.solo ? ' on' : ''}`,
      title: 'Solo — show only this',
      text: 'S',
    });
    solo.addEventListener('click', (ev) => {
      ev.stopPropagation();
      layer.solo = !layer.solo;
      app.commitLive();
      app.refreshPanels();
    });

    const up = el('button', { type: 'button', class: 'icon-btn', title: 'Move up', text: '▲' });
    up.addEventListener('click', (ev) => {
      ev.stopPropagation();
      reorder(app, layers, index, -1);
    });

    const down = el('button', { type: 'button', class: 'icon-btn', title: 'Move down', text: '▼' });
    down.addEventListener('click', (ev) => {
      ev.stopPropagation();
      reorder(app, layers, index, 1);
    });

    /**
     * What a layer *is* and what it *hits*, both readable without clicking.
     *
     * The old row said "1 target", which is a count rather than an answer — you
     * could not tell which window it pointed at without opening it. Worse, the
     * title fell back to a stored name that goes stale the moment the effect
     * changes: a layer created by a preset as "Night wash" and switched to Live
     * Camera still read as "Night wash", so the list actively lied about what
     * was running. The effect name is now always shown, whatever the layer is
     * called.
     */
    const effectName = effect?.name || layer.effect;
    const title = layer.name || effectName;
    const named = Boolean(layer.name) && layer.name !== effectName;
    const targets = describeTargets(app, layer);

    const item = el('div', { class: `list-item${selected ? ' selected' : ''}` }, [
      power,
      solo,
      el('span', { class: 'item-title', text: title, title }),
      el('span', {
        class: 'item-sub',
        text: named ? `${effectName} · ${targets}` : targets,
        title: named ? `${effectName} on ${targets}` : `on ${targets}`,
      }),
      up,
      down,
    ]);
    item.addEventListener('click', () => app.select({ type: 'layer', id: layer.id }));
    // Hovering a layer lights up the shapes it draws into, which is the fastest
    // way to answer "which one is Area 3?" without reading any labels.
    item.addEventListener('mouseenter', () => app.highlightShapes?.(targetedShapeIds(app, layer)));
    item.addEventListener('mouseleave', () => app.highlightShapes?.(null));
    node.appendChild(item);
  });
}

/** Shape ids a layer actually draws into, resolving its tag filter. */
export function targetedShapeIds(app, layer) {
  const ids = new Set(layer.targets || []);
  const tags = (layer.targetTags || []).map((t) => String(t).toLowerCase());
  if (tags.length) {
    for (const shape of app.project.shapes) {
      if ((shape.tags || []).some((t) => tags.includes(String(t).toLowerCase()))) ids.add(shape.id);
    }
  }
  return [...ids];
}

/** "porch and door", "4 × #window", "whole frame" — a phrase, not a count. */
function describeTargets(app, layer) {
  const tags = layer.targetTags || [];
  const ids = targetedShapeIds(app, layer);
  if (!ids.length && !tags.length) return 'whole frame';
  if (tags.length && ids.length > 3) return `${ids.length} × ${tags.map((t) => `#${t}`).join(', ')}`;
  const names = ids
    .map((id) => app.project.shapes.find((s) => s.id === id)?.name)
    .filter(Boolean);
  if (!names.length) return tags.length ? tags.map((t) => `#${t}`).join(', ') : 'whole frame';
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}

function reorder(app, ordered, index, direction) {
  const target = index + direction;
  if (target < 0 || target >= ordered.length) return;
  app.pushUndo();
  // Rewriting every order value keeps them dense and avoids ties after repeated
  // moves, which would make the sort unstable.
  const next = [...ordered];
  [next[index], next[target]] = [next[target], next[index]];
  next.forEach((layer, i) => {
    layer.order = i;
  });
  app.commit();
}

export function renderSceneList(node, app) {
  clear(node);
  if (!app.project.scenes.length) {
    node.appendChild(
      el('p', {
        class: 'panel-note',
        html:
          'A scene remembers which effects are on and how they are set. Build a look, then ' +
          '<strong>Save current as scene</strong>. Assign hotkeys 1–9 to switch instantly.',
      })
    );
    return;
  }

  for (const scene of app.project.scenes) {
    const selected = app.selection.type === 'scene' && app.selection.id === scene.id;
    const active = app.project.show?.activeScene === scene.id;

    const go = el('button', { type: 'button', class: 'icon-btn', title: 'Go to this scene', text: '▶' });
    go.addEventListener('click', (ev) => {
      ev.stopPropagation();
      app.activateScene(scene.id);
    });

    const item = el('div', { class: `list-item${selected ? ' selected' : ''}` }, [
      go,
      el('span', { class: 'item-title', text: scene.name }),
      scene.hotkey ? el('span', { class: 'chip', text: scene.hotkey }) : null,
      active ? el('span', { class: 'chip on', text: 'live' }) : null,
    ]);
    item.addEventListener('click', () => app.select({ type: 'scene', id: scene.id }));
    node.appendChild(item);
  }
}

export function renderPlaylist(node, app) {
  clear(node);
  const playlist = app.project.show?.playlist || [];
  if (!playlist.length) {
    node.appendChild(
      el('p', {
        class: 'panel-note',
        text: 'Add scenes here and hit Run show to let the house cycle through them on its own.',
      })
    );
    return;
  }

  playlist.forEach((entry, index) => {
    const scene = app.project.scenes.find((s) => s.id === entry.sceneId);
    const duration = el('input', { type: 'number', min: 1, max: 3600, step: 1, value: entry.duration ?? 30 });
    duration.style.width = '58px';
    duration.addEventListener('change', () => {
      entry.duration = Math.max(1, Number(duration.value) || 30);
      app.commit();
    });

    const remove = el('button', { type: 'button', class: 'icon-btn', title: 'Remove', text: '✕' });
    remove.addEventListener('click', () => {
      app.pushUndo();
      app.project.show.playlist.splice(index, 1);
      app.commit();
    });

    node.appendChild(
      el('div', { class: 'list-item' }, [
        el('span', { class: 'item-title', text: scene?.name || 'missing scene' }),
        duration,
        el('span', { class: 'item-sub', text: 's' }),
        remove,
      ])
    );
  });
}

export function renderSceneButtons(node, app) {
  clear(node);
  for (const scene of app.project.scenes) {
    const active = app.project.show?.activeScene === scene.id;
    const button = el('button', { type: 'button', class: `scene-btn${active ? ' active' : ''}` }, [
      scene.hotkey ? el('span', { class: 'hot', text: scene.hotkey }) : null,
      scene.name,
    ]);
    button.addEventListener('click', () => app.activateScene(scene.id));
    node.appendChild(button);
  }
}

export function renderMediaList(node, app) {
  clear(node);
  const media = app.project.media || [];
  if (!media.length) {
    node.appendChild(
      el('p', {
        class: 'panel-note',
        text: 'No media yet. Add a clip, then use the "Video / Image" effect to map it onto a shape.',
      })
    );
    return;
  }

  for (const entry of media) {
    const usedBy = app.project.layers.filter((l) => l.params?.source === entry.id).length;
    const remove = el('button', { type: 'button', class: 'icon-btn', title: 'Remove from library', text: '✕' });
    remove.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!confirm(`Remove "${entry.name}"? Effects using it will stop drawing.`)) return;
      await app.removeMedia(entry.id);
    });

    node.appendChild(
      el('div', { class: 'list-item' }, [
        el('span', { text: entry.kind === 'video' ? '🎞' : '🖼' }),
        el('span', { class: 'item-title', text: entry.name, title: entry.name }),
        el('span', {
          class: 'item-sub',
          text: `${formatBytes(entry.size)}${entry.duration ? ` · ${entry.duration.toFixed(1)}s` : ''}${
            usedBy ? ` · used ${usedBy}×` : ''
          }`,
        }),
        remove,
      ])
    );
  }
}

export async function renderStorageInfo(node, app) {
  const local = storageUsage();
  let quotaText = '';
  const estimate = await app.estimateQuota();
  if (estimate?.quota) {
    quotaText = ` Browser storage in use: ${formatBytes(estimate.usage)} of about ${formatBytes(estimate.quota)}.`;
  }
  node.innerHTML =
    `Show data in local storage: <strong>${escapeHtml(formatBytes(local))}</strong>.${escapeHtml(quotaText)}` +
    ' Media and camera stills live in a separate, much larger store.';
}

/* ------------------------------------------------------------------ *
 * Triggers
 * ------------------------------------------------------------------ */

const SOURCE_LABEL = {
  motion: 'motion',
  hotkey: 'key',
  timer: 'timer',
  manual: 'manual',
};

export function renderTriggerList(node, app) {
  clear(node);
  const triggers = app.project.triggers || [];

  if (!triggers.length) {
    node.appendChild(
      el('p', {
        class: 'panel-note',
        html:
          'No triggers yet. A good first one: a <strong>motion</strong> trigger watching the path, ' +
          'firing a scene with lightning and a scream.',
      })
    );
    return;
  }

  for (const trigger of triggers) {
    const selected = app.selection.type === 'trigger' && app.selection.id === trigger.id;
    const scene = app.project.scenes.find((s) => s.id === trigger.sceneId);

    const power = el('button', {
      type: 'button',
      class: `icon-btn${trigger.enabled ? ' on' : ''}`,
      title: 'Arm or disarm',
      text: trigger.enabled ? '◉' : '○',
    });
    power.addEventListener('click', (ev) => {
      ev.stopPropagation();
      trigger.enabled = !trigger.enabled;
      app.commitLive();
      app.refreshPanels();
    });

    const test = el('button', { type: 'button', class: 'icon-btn', title: 'Fire it now', text: '⚡' });
    test.addEventListener('click', (ev) => {
      ev.stopPropagation();
      app.fireTrigger(trigger.id);
    });

    const item = el('div', { class: `list-item${selected ? ' selected' : ''}` }, [
      power,
      test,
      el('span', { class: 'item-title', text: trigger.name, title: trigger.name }),
      el('span', { class: 'item-sub', text: SOURCE_LABEL[trigger.source] || trigger.source }),
      scene ? null : el('span', { class: 'chip warn', text: 'no scene' }),
    ]);
    item.addEventListener('click', () => app.select({ type: 'trigger', id: trigger.id }));
    node.appendChild(item);
  }
}

/**
 * Live readout for motion triggers.
 *
 * Aiming a motion region is guesswork without feedback, so this shows the
 * measured activity against the threshold it has to clear.
 */
export function renderMotionStatus(node, app) {
  const motionTriggers = (app.project.triggers || []).filter((t) => t.source === 'motion' && t.enabled);

  if (!motionTriggers.length) {
    node.textContent = '';
    return;
  }
  if (!app.camera.isRunning()) {
    node.textContent = 'Start the camera in Setup for motion triggers to work.';
    return;
  }

  clear(node);
  for (const trigger of motionTriggers) {
    const activity = app.triggerActivity(trigger.id);
    const threshold = app.motionThreshold(trigger.sensitivity);
    const armed = app.triggerArmedIn(trigger.id, trigger.cooldown);
    const meter = el('div', { class: 'meter' }, [el('span')]);
    meter.firstElementChild.style.width = `${Math.min(100, (activity / Math.max(threshold, 1e-6)) * 50)}%`;

    node.appendChild(
      el('div', {}, [
        el('div', {
          class: 'panel-note',
          style: 'margin:0',
          text: `${trigger.name}: ${(activity * 100).toFixed(1)}% moving, fires at ${(threshold * 100).toFixed(1)}%${
            armed > 0.5 ? ` · re-arms in ${armed.toFixed(0)}s` : ' · armed'
          }`,
        }),
        meter,
      ])
    );
  }
}
