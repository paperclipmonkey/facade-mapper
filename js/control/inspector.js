/**
 * Right-hand inspector.
 *
 * Renders whatever is selected — a shape, an effect layer, or a projector — and
 * writes edits straight back into the project. Layer parameter controls are
 * generated from the effect's schema, so custom effects are first-class.
 */

import { el, clear, paramRow, toast, fmt } from './ui.js';
import { SHAPE_TAGS, RESERVED_KEYS } from '../core/state.js';
import { getEffect, listByCategory, defaultParams } from '../effects/registry.js';
import { openEffectPicker } from './effectPicker.js';
import { layerIssues } from './diagnostics.js';
import { voiceForLayer, VOICES, VOICE_OPTIONS } from '../core/soundscape.js';
import { POINT_PAIRS_NEEDED } from './calibration.js';
import { checkReachable, fireWebhook } from './webhooks.js';

export function renderInspector(container, app) {
  clear(container);
  const { type, id } = app.selection;
  const multi = type === 'layer' && (app.selection.ids || []).length > 1;

  if (type === 'shape') renderShape(container, app, id);
  else if (multi) renderLayerSelection(container, app);
  else if (type === 'layer') renderLayer(container, app, id);
  else if (type === 'projector') renderProjector(container, app, id);
  else if (type === 'scene') renderScene(container, app, id);
  else if (type === 'trigger') renderTrigger(container, app, id);
  else {
    container.appendChild(
      el('p', {
        class: 'panel-note',
        html:
          'Nothing selected.<br><br>Trace the house with the <strong>Area</strong> and <strong>Path</strong> tools, ' +
          'then add effects and point them at the shapes you made.',
      })
    );
  }
}

function heading(text, extra) {
  return el('h3', { class: 'panel-heading' }, [text, extra].filter(Boolean));
}

function nameField(value, onChange) {
  const input = el('input', { type: 'text', value: value ?? '' });
  input.addEventListener('change', () => onChange(input.value));
  return el('div', { class: 'inspector-title' }, [input]);
}

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

function renderShape(container, app, id) {
  const shape = app.project.shapes.find((s) => s.id === id);
  if (!shape) return;

  container.appendChild(
    nameField(shape.name, (value) => {
      app.pushUndo();
      shape.name = value;
      app.commit();
    })
  );

  container.appendChild(heading('Geometry'));

  const typeRow = el('div', { class: 'field' }, [el('span', { text: 'Type' })]);
  const typeSelect = el('select');
  typeSelect.append(
    el('option', { value: 'polygon', text: 'Closed area', selected: shape.closed }),
    el('option', { value: 'path', text: 'Open path', selected: !shape.closed })
  );
  typeSelect.addEventListener('change', () => {
    app.pushUndo();
    shape.closed = typeSelect.value === 'polygon';
    shape.type = typeSelect.value;
    app.commit();
  });
  typeRow.appendChild(typeSelect);
  container.appendChild(typeRow);

  container.appendChild(
    checkbox('Smooth corners', shape.smooth, (checked) => {
      app.pushUndo();
      shape.smooth = checked;
      app.commit();
    })
  );
  container.appendChild(
    checkbox('Visible', shape.visible !== false, (checked) => {
      app.pushUndo();
      shape.visible = checked;
      app.commit();
    })
  );
  container.appendChild(
    checkbox('Locked (ignore clicks)', !!shape.locked, (checked) => {
      app.pushUndo();
      shape.locked = checked;
      app.commit();
    })
  );

  container.appendChild(
    el('p', {
      class: 'panel-note',
      text: `${shape.points.length} points. Alt-click an edge to add one, alt-click a point to remove it. Shift-drag to line up with a neighbour.`,
    })
  );

  container.appendChild(heading('Tags'));
  container.appendChild(
    el('p', {
      class: 'panel-note',
      text: 'Effects can target every shape carrying a tag, so "all windows" stays correct as you add windows.',
    })
  );

  const tagWrap = el('div', { class: 'tag-picker' });
  const allTags = [...new Set([...SHAPE_TAGS, ...(shape.tags || [])])];
  for (const tag of allTags) {
    const on = shape.tags?.includes(tag);
    const button = el('button', { type: 'button', class: `tag-toggle${on ? ' on' : ''}`, text: tag });
    button.addEventListener('click', () => {
      app.pushUndo();
      shape.tags = shape.tags || [];
      const index = shape.tags.indexOf(tag);
      if (index >= 0) shape.tags.splice(index, 1);
      else shape.tags.push(tag);
      app.commit();
      app.refreshInspector();
    });
    tagWrap.appendChild(button);
  }
  container.appendChild(tagWrap);

  const customTag = el('input', { type: 'text', placeholder: 'Add your own tag…' });
  customTag.addEventListener('change', () => {
    const value = customTag.value.trim().toLowerCase();
    if (!value) return;
    app.pushUndo();
    shape.tags = [...new Set([...(shape.tags || []), value])];
    app.commit();
    app.refreshInspector();
  });
  container.appendChild(customTag);

  renderShapeEffects(container, app, shape);
}

/**
 * The effects on this shape, and the two ways to add one.
 *
 * "None yet." was a dead end. You had traced a window, you were looking at it,
 * you wanted to light it — and the panel told you nothing was pointed at it and
 * left you to go to another panel, add a layer, and find your way back to this
 * shape in a target list. Both routes now start here: pick a new effect from
 * the gallery, or point one you already have at it.
 */
function renderShapeEffects(container, app, shape) {
  const isUser = (l) => l.targets?.includes(shape.id) || l.targetTags?.some((t) => shape.tags?.includes(t));
  const users = app.project.layers.filter(isUser);

  container.appendChild(heading('Effects on this shape'));

  if (!users.length) {
    container.appendChild(el('p', { class: 'panel-note', text: 'Nothing is lighting this yet.' }));
  } else {
    const list = el('div', { class: 'list compact' });
    for (const layer of users) {
      // Tag-targeted layers are not "on" this shape so much as on everything
      // like it, and unpicking one from here would silently change the others.
      const viaTag = !layer.targets?.includes(shape.id);
      const row = [
        el('span', { class: 'item-title', text: layer.name || getEffect(layer.effect)?.name || layer.effect }),
      ];
      if (viaTag) {
        const tags = (layer.targetTags || []).filter((t) => shape.tags?.includes(t));
        row.push(el('span', { class: 'item-sub', text: `via ${tags.map((t) => `#${t}`).join(', ')}` }));
      } else {
        const remove = el('button', { type: 'button', class: 'icon-btn', title: 'Take this effect off this shape', text: '×' });
        remove.addEventListener('click', (ev) => {
          ev.stopPropagation();
          app.pushUndo();
          layer.targets = (layer.targets || []).filter((t) => t !== shape.id);
          app.commit();
          app.refreshInspector();
        });
        row.push(remove);
      }
      const item = el('div', { class: 'list-item' }, row);
      item.addEventListener('click', () => app.select({ type: 'layer', id: layer.id }));
      list.appendChild(item);
    }
    container.appendChild(list);
  }

  const actions = el('div', { class: 'panel-actions' });

  const add = el('button', { type: 'button', class: 'btn small primary', text: 'Add an effect here…' });
  add.addEventListener('click', () => {
    openEffectPicker({
      current: null,
      closed: shape.closed !== false,
      onPick: (effectId) => app.addLayerForShape(effectId, shape.id),
    });
  });
  actions.appendChild(add);

  // Only offered when there is something to point: a dropdown listing nothing
  // is worse than no dropdown.
  const spare = app.project.layers.filter((l) => !isUser(l));
  if (spare.length) {
    const link = el('select', { class: 'select-inline' });
    link.appendChild(el('option', { value: '', text: 'Point an existing effect here…' }));
    for (const layer of spare) {
      link.appendChild(el('option', {
        value: layer.id,
        text: layer.name || getEffect(layer.effect)?.name || layer.effect,
      }));
    }
    link.addEventListener('change', () => {
      const layer = app.project.layers.find((l) => l.id === link.value);
      if (!layer) return;
      app.pushUndo();
      layer.targets = [...new Set([...(layer.targets || []), shape.id])];
      app.commit();
      app.refreshInspector();
      toast(`"${layer.name || getEffect(layer.effect)?.name}" now draws into ${shape.name}.`, 'good');
    });
    actions.appendChild(link);
  }

  container.appendChild(actions);

  if (shape.tags?.length) {
    container.appendChild(el('p', {
      class: 'panel-note',
      html: `Or point a layer at <strong>#${shape.tags[0]}</strong> and it lights every shape tagged that way, `
        + 'including ones you trace later.',
    }));
  }
}

/**
 * Several layers at once.
 *
 * No parameters — they belong to different effects and merging them would mean
 * inventing a "mixed" state for every control. What is genuinely shared is
 * whether they are on and whether they exist, and those are exactly the two
 * things you want when swapping one seasonal look for another.
 */
function renderLayerSelection(container, app) {
  const ids = new Set(app.selection.ids || []);
  const layers = app.project.layers.filter((l) => ids.has(l.id));

  container.appendChild(el('div', { class: 'inspector-title' }, [
    el('strong', { text: `${layers.length} effects selected` }),
  ]));

  const list = el('div', { class: 'list compact' });
  for (const layer of layers) {
    list.appendChild(el('div', { class: 'list-item' }, [
      el('span', { class: 'item-title', text: layer.name || getEffect(layer.effect)?.name || layer.effect }),
    ]));
  }
  container.appendChild(list);

  const actions = el('div', { class: 'panel-actions' });
  for (const [label, action] of [['Enable all', 'enable'], ['Bypass all', 'bypass']]) {
    const button = el('button', { type: 'button', class: 'btn small', text: label });
    button.addEventListener('click', () => app.layersBulk(action));
    actions.appendChild(button);
  }
  const remove = el('button', { type: 'button', class: 'btn small danger', text: `Delete ${layers.length}` });
  remove.addEventListener('click', () => app.deleteSelection());
  actions.appendChild(remove);
  container.appendChild(actions);

  container.appendChild(el('p', {
    class: 'panel-note',
    text: 'Click a single effect to edit its parameters.',
  }));
}

function checkbox(label, checked, onChange) {
  const input = el('input', { type: 'checkbox' });
  input.checked = !!checked;
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', { class: 'inline-check' }, [input, label]);
}

/* ------------------------------------------------------------------ *
 * Layers
 * ------------------------------------------------------------------ */

function renderLayer(container, app, id) {
  const layer = app.project.layers.find((l) => l.id === id);
  if (!layer) return;
  const effect = getEffect(layer.effect);

  container.appendChild(
    nameField(layer.name || effect?.name || layer.effect, (value) => {
      app.pushUndo();
      layer.name = value;
      app.commit();
    })
  );

  /**
   * Browsing beats guessing. The dropdown is kept — it is faster once you know
   * the name you want — but the Browse button opens a gallery that renders every
   * effect live on a shape like this layer's, which is the only way to choose
   * one you have not seen.
   */
  const chooseEffect = (id) => {
    if (!id || id === layer.effect) return;
    app.pushUndo();
    layer.effect = id;
    layer.params = { ...defaultParams(layer.effect), ...layer.params };
    layer.bindings = {};
    app.resetLayerState(layer.id);
    app.commit();
    app.refreshInspector();
  };

  const browseBtn = el('button', { type: 'button', class: 'btn small', text: 'Browse…' });
  browseBtn.addEventListener('click', () => {
    const target = app.project.shapes.find((s) => (layer.targets || []).includes(s.id));
    openEffectPicker({
      current: layer.effect,
      closed: target ? target.closed !== false : true,
      onPick: chooseEffect,
    });
  });

  /**
   * Wipe whatever this layer has accumulated and start it over.
   *
   * Plenty of effects build up state you cannot get back to any other way — a
   * wall of ivy, a pane of frost, a drift of snow on a sill. Until now the only
   * way to restart one was to nudge a parameter that happened to be part of its
   * cache key, which is a trick you have to know and which changes the look as
   * a side effect. This does the thing directly, for every effect at once.
   */
  const restartBtn = el('button', {
    type: 'button',
    class: 'btn small',
    text: 'Restart',
    title: 'Clear anything this effect has built up and start it again',
  });
  restartBtn.addEventListener('click', () => {
    app.resetLayerState(layer.id);
    toast(`${layer.name || effect?.name || layer.effect} restarted.`);
  });

  const effectRow = el('div', { class: 'field' }, [el('span', { text: 'Effect' })]);
  const effectSelect = el('select');
  for (const [category, effects] of listByCategory()) {
    const group = el('optgroup', { label: category });
    for (const def of effects) {
      group.appendChild(el('option', { value: def.id, text: def.name, selected: def.id === layer.effect }));
    }
    effectSelect.appendChild(group);
  }
  effectSelect.addEventListener('change', () => {
    app.pushUndo();
    layer.effect = effectSelect.value;
    // Keep any parameters the new effect happens to share (colour, speed…) and
    // fill the rest from its defaults, so swapping effects isn't destructive.
    layer.params = { ...defaultParams(layer.effect), ...layer.params };
    layer.bindings = {};
    app.resetLayerState(layer.id);
    app.commit();
    app.refreshInspector();
  });
  effectRow.appendChild(effectSelect);
  container.appendChild(effectRow);
  container.appendChild(el('div', { class: 'panel-actions' }, [browseBtn, restartBtn]));

  if (effect?.description) {
    container.appendChild(el('p', { class: 'panel-note', text: effect.description }));
  }

  // Everything standing between this layer and the wall, in order, in words.
  // The chip on the list row is the alarm; this is the explanation.
  for (const issue of layerIssues(app.project, layer, effect)) {
    container.appendChild(el('p', { class: `panel-note issue ${issue.level}`, text: issue.text }));
  }

  container.appendChild(heading('Targets'));
  container.appendChild(
    el('p', {
      class: 'panel-note',
      text: 'Leave everything unticked to cover the whole frame — that is what you want for snow, fog and lightning.',
    })
  );

  const tagWrap = el('div', { class: 'tag-picker' });
  const usedTags = [...new Set(app.project.shapes.flatMap((s) => s.tags || []))];
  for (const tag of usedTags) {
    const on = layer.targetTags?.includes(tag);
    const button = el('button', { type: 'button', class: `tag-toggle${on ? ' on' : ''}`, text: `#${tag}` });
    button.addEventListener('click', () => {
      app.pushUndo();
      layer.targetTags = layer.targetTags || [];
      const index = layer.targetTags.indexOf(tag);
      if (index >= 0) layer.targetTags.splice(index, 1);
      else layer.targetTags.push(tag);
      app.commit();
      app.refreshInspector();
    });
    tagWrap.appendChild(button);
  }
  if (usedTags.length) container.appendChild(tagWrap);

  const targetList = el('div', { class: 'target-list' });
  if (!app.project.shapes.length) {
    targetList.appendChild(el('p', { class: 'panel-note', text: 'No shapes traced yet.' }));
  }
  for (const shape of app.project.shapes) {
    const input = el('input', { type: 'checkbox' });
    input.checked = layer.targets?.includes(shape.id);
    input.addEventListener('change', () => {
      app.pushUndo();
      layer.targets = layer.targets || [];
      if (input.checked) layer.targets.push(shape.id);
      else layer.targets = layer.targets.filter((t) => t !== shape.id);
      app.commit();
    });
    targetList.appendChild(
      el('label', { class: 'inline-check' }, [
        input,
        shape.name,
        shape.tags?.length ? el('span', { class: 'item-sub', text: ` #${shape.tags.join(' #')}` }) : null,
      ])
    );
  }
  container.appendChild(targetList);

  container.appendChild(heading('Mix'));
  container.appendChild(
    paramRow(
      { key: 'opacity', type: 'range', label: 'Opacity', min: 0, max: 1, step: 0.01, default: 1 },
      layer.opacity ?? 1,
      null,
      {
        onChange: (value) => {
          layer.opacity = value;
          app.commitLive();
        },
      }
    )
  );

  const blendRow = el('div', { class: 'param-row' }, [el('label', { text: 'Blend' })]);
  const blendSelect = el('select');
  for (const mode of ['source-over', 'lighter', 'screen', 'multiply', 'overlay', 'difference', 'destination-out']) {
    blendSelect.appendChild(el('option', { value: mode, text: mode, selected: mode === (layer.blend || 'source-over') }));
  }
  blendSelect.addEventListener('change', () => {
    app.pushUndo();
    layer.blend = blendSelect.value;
    app.commit();
  });
  blendRow.append(el('div', { class: 'param-control' }, [blendSelect]), el('span'));
  container.appendChild(blendRow);

  /**
   * What this layer sounds like.
   *
   * `Automatic` is the effect's own voice — see `VOICE_FOR_EFFECT` in
   * core/soundscape.js — which is what makes a preset arrive with sound on it
   * already. The list is here rather than only on the remote because choosing
   * a voice is authoring and belongs where the rest of the authoring is; the
   * *level* is on both, because that is a thing you set standing outside.
   */
  const sounding = getEffect(layer.effect);
  const auto = voiceForLayer({ ...layer, sound: 'auto' }, sounding);
  const soundRow = el('div', { class: 'param-row' }, [el('label', { text: 'Sound' })]);
  const soundSelect = el('select');
  soundSelect.appendChild(
    el('option', {
      value: 'auto',
      text: auto ? `Automatic — ${VOICES.get(auto)?.name}` : 'Automatic — silent',
      selected: (layer.sound ?? 'auto') === 'auto',
    })
  );
  soundSelect.appendChild(el('option', { value: 'none', text: 'Silent', selected: layer.sound === 'none' }));
  for (const voice of VOICE_OPTIONS) {
    soundSelect.appendChild(
      el('option', { value: voice.id, text: voice.name, selected: layer.sound === voice.id })
    );
  }
  soundSelect.addEventListener('change', () => {
    app.pushUndo();
    layer.sound = soundSelect.value;
    app.commit();
  });
  soundRow.append(el('div', { class: 'param-control' }, [soundSelect]), el('span'));
  container.appendChild(soundRow);

  if (voiceForLayer(layer, sounding)) {
    container.appendChild(
      paramRow(
        { key: 'soundLevel', type: 'range', label: 'Volume', min: 0, max: 1, step: 0.01, default: 1 },
        layer.soundLevel ?? 1,
        null,
        {
          onChange: (value) => {
            layer.soundLevel = value;
            app.commitLive();
          },
        }
      )
    );
  }

  container.appendChild(
    paramRow(
      { key: 'softness', type: 'range', label: 'Softness', min: 0, max: 60, step: 0.5, default: 0 },
      layer.softness ?? 0,
      null,
      {
        onChange: (value) => {
          layer.softness = value;
          app.commitLive();
        },
      }
    )
  );
  container.appendChild(
    el('p', {
      class: 'panel-note',
      text: 'Softness blurs this layer alone. Use it when a hard-edged fill reads as a sticker rather than as light.',
    })
  );

  container.appendChild(
    paramRow(
      { key: 'stagger', type: 'range', label: 'Stagger (s)', min: 0, max: 5, step: 0.01, default: 0 },
      layer.stagger ?? 0,
      null,
      {
        onChange: (value) => {
          layer.stagger = value;
          app.commitLive();
        },
      }
    )
  );
  container.appendChild(
    el('p', {
      class: 'panel-note',
      text: 'Stagger delays each targeted shape a little more than the last, turning a simultaneous pulse into a sweep across the house.',
    })
  );

  if (effect?.params?.length) {
    container.appendChild(heading('Parameters'));
    for (const def of effect.params) {
      const value = layer.params?.[def.key] ?? def.default;
      const binding = layer.bindings?.[def.key] ?? null;
      container.appendChild(
        paramRow(def, value, binding, {
          mediaList: app.project.media,
          onChange: (next) => {
            layer.params = layer.params || {};
            layer.params[def.key] = next;
            app.commitLive();
          },
          onBindingChange: (next) => {
            app.pushUndo();
            layer.bindings = layer.bindings || {};
            if (next) layer.bindings[def.key] = next;
            else delete layer.bindings[def.key];
            // commitLive, not commit: re-rendering the inspector here would tear
            // down the modulation editor the user is still working in.
            app.commitLive();
          },
        })
      );
    }

    const reset = el('button', { type: 'button', class: 'btn small', text: 'Reset parameters' });
    reset.addEventListener('click', () => {
      app.pushUndo();
      layer.params = defaultParams(layer.effect);
      layer.bindings = {};
      app.commit();
      app.refreshInspector();
    });
    container.appendChild(reset);
  }
}

/* ------------------------------------------------------------------ *
 * Projectors
 * ------------------------------------------------------------------ */

function renderProjector(container, app, id) {
  const projector = app.project.projectors.find((p) => p.id === id);
  if (!projector) return;
  const peer = app.presence.forProjector(projector.id);

  container.appendChild(
    nameField(projector.name, (value) => {
      app.pushUndo();
      projector.name = value;
      app.commit();
    })
  );

  const status = el('div', { class: 'panel-actions' }, [
    el('span', {
      class: `chip ${peer ? 'good' : 'warn'}`,
      text: peer ? `connected · ${peer.width}×${peer.height}` : 'no tab open',
    }),
    el('span', {
      class: `chip ${projector.calibration?.H ? 'good' : 'warn'}`,
      text: projector.calibration?.H
        ? `aligned (${projector.calibration.mode})`
        : 'not aligned',
    }),
  ]);
  container.appendChild(status);

  const openBtn = el('button', { type: 'button', class: 'btn small primary', text: 'Open this projector tab' });
  openBtn.addEventListener('click', () => app.openProjectorTab(projector.id));

  const identifyBtn = el('button', { type: 'button', class: 'btn small', text: 'Identify' });
  identifyBtn.addEventListener('click', () => app.identifyProjector(projector.id));

  const fullscreenBtn = el('button', { type: 'button', class: 'btn small', text: 'Fullscreen it' });
  fullscreenBtn.addEventListener('click', () => app.commandProjector(projector.id, 'fullscreen'));

  container.appendChild(el('div', { class: 'panel-actions' }, [openBtn, identifyBtn, fullscreenBtn]));

  if (!peer) {
    container.appendChild(
      el('p', {
        class: 'panel-note',
        text: 'Fullscreen has to be triggered inside the projector tab itself, so if the button does nothing, click into that tab and press F.',
      })
    );
  }

  /* --- Alignment --- */

  container.appendChild(heading('Alignment'));

  /**
   * Grid density is really a question about the *wall*, so it is worded as one.
   * Three dots per axis is all a flat elevation needs — a homography fits that
   * exactly. More dots do not fit a better plane; they measure how far the wall
   * departs from one, which is the only way to align a surface that turns a
   * corner.
   */
  const surfaceSelect = el('select', { class: 'input' }, [
    ['3', 'Flat wall — 9 dots, fastest'],
    ['5', 'Slightly uneven — 25 dots'],
    ['7', 'Corners or several faces — 49 dots'],
  ].map(([value, label]) => el('option', {
    value,
    text: label,
    selected: String(projector.calibration?.gridSize || 3) === value,
  })));
  surfaceSelect.addEventListener('change', () => {
    projector.calibration = { ...(projector.calibration || {}), gridSize: Number(surfaceSelect.value) };
    app.commit();
  });
  container.appendChild(el('label', { class: 'field' }, [
    el('span', { text: 'Wall shape' }),
    surfaceSelect,
  ]));
  container.appendChild(el('p', {
    class: 'panel-note',
    text: 'A flat wall is a single plane, and nine dots pin it down exactly. Where two or three faces '
      + 'meet at a corner, no single plane fits — line up one face and the others are out. A denser '
      + 'pass measures that difference and bends the output to match. It takes longer, one dot at a '
      + 'time, and it is the fix for a wall you cannot get aligned on all sides at once.',
  }));

  const calibrateBtn = el('button', {
    type: 'button',
    class: 'btn small primary',
    text: projector.calibration?.H ? 'Re-align with camera' : 'Align with camera',
  });
  calibrateBtn.addEventListener('click', () => app.startCalibration(projector.id));

  const driftBtn = el('button', { type: 'button', class: 'btn small', text: 'Check for drift' });
  driftBtn.disabled = !projector.calibration?.H;
  driftBtn.addEventListener('click', () => app.checkProjectorDrift(projector.id));

  container.appendChild(el('div', { class: 'panel-actions' }, [calibrateBtn, driftBtn]));

  if (!app.camera.isRunning()) {
    container.appendChild(
      el('p', { class: 'panel-note', text: 'Start the camera in Setup to use automatic alignment.' })
    );
  }

  const quality = projector.calibration?.quality;
  if (quality) {
    container.appendChild(
      el('p', {
        class: 'panel-note',
        text: `Last solve: ${quality.rating}, average error ${fmt(quality.meanPx ?? 0)} px of a 1920-wide output, worst ${fmt(
          quality.maxPx ?? 0
        )} px, from ${quality.points} markers${quality.discarded ? ' (one outlier discarded)' : ''}.`,
      })
    );
  }

  // The same button opens the tool and closes it. A modal tool with no visible
  // way out is the thing being fixed here, and a second button somewhere else
  // would only be a second thing to fail to find.
  const editingCorners = app.tool === 'corners' && app.selection?.id === projector.id;
  const cornersBtn = el('button', {
    type: 'button',
    class: editingCorners ? 'btn small primary' : 'btn small',
    text: editingCorners
      ? 'Done aligning by hand'
      : (projector.calibration?.worldQuad ? 'Edit corners by hand' : 'Align by hand instead'),
  });
  cornersBtn.addEventListener('click', () => {
    if (editingCorners) app.finishManualCorners(projector.id);
    else app.beginManualCorners(projector.id);
  });
  container.appendChild(el('div', { class: 'panel-actions' }, [cornersBtn]));
  container.appendChild(
    el('p', {
      class: 'panel-note',
      text: editingCorners
        ? 'Drag the four handles to where the projector’s corners land on the wall. The alignment updates as you drag, so there is nothing to apply — Done, Escape, or switching the test pattern off all finish.'
        : 'Manual mode: put the projector on a test grid, then drag its four corners to where they land on the camera view. No camera needed — a photograph of the house works, as long as you can see where the corners fall.',
    })
  );

  /* --- Click-to-align --- */

  const align = app.tool === 'point' && app.pointAlign?.projectorId === projector.id ? app.pointAlign : null;
  const pointBtn = el('button', {
    type: 'button',
    class: align ? 'btn small primary' : 'btn small',
    text: align ? 'Done pointing' : 'Align by pointing…',
  });
  pointBtn.disabled = !align && !peer;
  pointBtn.addEventListener('click', () => {
    if (align) app.finishPointAlign(projector.id);
    else app.beginPointAlign(projector.id);
  });

  const pointActions = [pointBtn];
  if (align) {
    const undoBtn = el('button', { type: 'button', class: 'btn small', text: 'Undo last' });
    undoBtn.disabled = !align.pairs.length && !align.picking;
    undoBtn.addEventListener('click', () => app.pointAlignUndo());
    pointActions.push(undoBtn);
  }
  container.appendChild(el('div', { class: 'panel-actions' }, pointActions));

  if (align) {
    const need = POINT_PAIRS_NEEDED - align.pairs.length;
    const step = align.error
      ? align.error
      : align.picking
        ? `Now go to the projector tab and walk the crosshair onto that same spot on the house. `
          + `Arrow keys nudge it a pixel at a time; click or press Enter to place it. `
          + `(${align.pairs.length + 1} of ${POINT_PAIRS_NEEDED})`
        : need > 0
          ? `Click a feature on the camera view — a window corner, the top of the door. ${need} more to go.`
          // Four points fit exactly whatever they are, so quoting their
          // residual would be reporting the arithmetic rather than the
          // alignment. It only becomes a number worth showing at five.
          : `Aligned from ${align.pairs.length} points${
            align.pairs.length > POINT_PAIRS_NEEDED
              ? `, agreeing to ${fmt(align.residual * 1920)} px of a 1920-wide output`
              : ''
          }. Point at another feature to tighten it and to check none of them slipped, or press Done.`;
    container.appendChild(el('p', { class: align.error ? 'panel-note issue bad' : 'panel-note', text: step }));
  } else {
    container.appendChild(
      el('p', {
        class: 'panel-note',
        text: peer
          ? 'Pointing: mark a feature on the camera view, then drive a projected crosshair onto that same feature '
            + 'on the real house and click. Four of those align the projector. The points are on the building rather '
            + 'than on the edge of the beam, so it still works when the projector overshoots the wall.'
          : 'Pointing needs this projector’s tab open — the crosshair it puts up is the half of each pair that lands on the house.',
      })
    );
  }

  /* --- Output --- */

  container.appendChild(heading('Output'));
  container.appendChild(
    checkbox('Enabled', projector.enabled !== false, (checked) => {
      app.pushUndo();
      projector.enabled = checked;
      app.commit();
    })
  );
  container.appendChild(
    checkbox('Blackout this projector', !!projector.blackout, (checked) => {
      projector.blackout = checked;
      app.commitLive();
    })
  );

  container.appendChild(
    paramRow({ key: 'brightness', type: 'range', label: 'Brightness', min: 0, max: 1.5, step: 0.01, default: 1 }, projector.brightness ?? 1, null, {
      onChange: (value) => {
        projector.brightness = value;
        app.commitLive();
      },
    })
  );

  container.appendChild(
    paramRow({ key: 'quality', type: 'range', label: 'Render detail', min: 0.5, max: 2.5, step: 0.05, default: 1.25 }, projector.quality ?? 1.25, null, {
      onChange: (value) => {
        projector.quality = value;
        app.commitLive();
      },
    })
  );
  container.appendChild(
    el('p', {
      class: 'panel-note',
      text: 'Render detail trades sharpness against frame rate. Drop it if a projector tab struggles.',
    })
  );

  const patternRow = el('div', { class: 'param-row' }, [el('label', { text: 'Test pattern' })]);
  const patternSelect = el('select');
  for (const pattern of ['off', 'grid', 'corners', 'white', 'greyscale', 'red', 'green', 'blue']) {
    patternSelect.appendChild(
      el('option', { value: pattern, text: pattern, selected: pattern === (projector.testPattern || 'off') })
    );
  }
  patternSelect.addEventListener('change', () => {
    projector.testPattern = patternSelect.value;
    app.commitLive();
    // Manual alignment tells you that switching the pattern off finishes it.
    // That was simply untrue: the tool stayed open, the handles stayed on the
    // canvas, and the only way out was to guess at another tool button.
    if (patternSelect.value === 'off') app.finishManualCorners?.(projector.id);
  });
  patternRow.append(el('div', { class: 'param-control' }, [patternSelect]), el('span'));
  container.appendChild(patternRow);

  /* --- Edge blending --- */

  container.appendChild(heading('Edge blending'));
  container.appendChild(
    el('p', {
      class: 'panel-note',
      text: 'Where two projectors overlap, fade the overlapping edges on both so the seam disappears.',
    })
  );
  for (const edge of ['top', 'right', 'bottom', 'left']) {
    container.appendChild(
      paramRow({ key: edge, type: 'range', label: edge, min: 0, max: 0.5, step: 0.005, default: 0 }, projector.blend?.[edge] ?? 0, null, {
        onChange: (value) => {
          projector.blend = projector.blend || {};
          projector.blend[edge] = value;
          app.commitLive();
        },
      })
    );
  }
  container.appendChild(
    paramRow({ key: 'gamma', type: 'range', label: 'Blend gamma', min: 0.5, max: 4, step: 0.05, default: 1.8 }, projector.blend?.gamma ?? 1.8, null, {
      onChange: (value) => {
        projector.blend = projector.blend || {};
        projector.blend.gamma = value;
        app.commitLive();
      },
    })
  );

  /* --- Mesh warp --- */

  container.appendChild(heading('Surface warp'));
  container.appendChild(
    checkbox('Enable mesh warp', !!projector.mesh?.enabled, (checked) => {
      app.pushUndo();
      projector.mesh = projector.mesh || { cols: 3, rows: 3 };
      projector.mesh.enabled = checked;
      if (checked && !projector.mesh.offsets) {
        projector.mesh.offsets = new Array(projector.mesh.cols * projector.mesh.rows * 2).fill(0);
      }
      app.commit();
      app.refreshInspector();
    })
  );
  container.appendChild(
    el('p', {
      class: 'panel-note',
      text: 'The camera alignment assumes a flat wall. Turn this on to nudge a grid of control points for bays, porches and curved surfaces.',
    })
  );

  if (projector.mesh?.enabled) {
    const grid = el('div', { class: 'panel-actions' });
    for (const size of [2, 3, 4, 5, 7]) {
      const button = el('button', {
        type: 'button',
        class: `btn small${projector.mesh.cols === size ? ' active' : ''}`,
        text: `${size}×${size}`,
      });
      button.addEventListener('click', () => {
        app.pushUndo();
        projector.mesh.cols = size;
        projector.mesh.rows = size;
        projector.mesh.offsets = new Array(size * size * 2).fill(0);
        app.commit();
        app.refreshInspector();
      });
      grid.appendChild(button);
    }
    container.appendChild(grid);
    container.appendChild(meshGridEditor(projector, app));

    const resetMesh = el('button', { type: 'button', class: 'btn small', text: 'Flatten warp' });
    resetMesh.addEventListener('click', () => {
      app.pushUndo();
      projector.mesh.offsets = new Array(projector.mesh.cols * projector.mesh.rows * 2).fill(0);
      app.commit();
      app.refreshInspector();
    });
    container.appendChild(resetMesh);
  }

  /* --- Remove --- */

  container.appendChild(heading('Danger zone'));
  const removeBtn = el('button', { type: 'button', class: 'btn small danger', text: 'Remove projector' });
  removeBtn.addEventListener('click', () => {
    if (app.project.projectors.length <= 1) {
      toast('Keep at least one projector', 'bad');
      return;
    }
    if (!confirm(`Remove ${projector.name}? Its alignment will be lost.`)) return;
    app.pushUndo();
    app.project.projectors = app.project.projectors.filter((p) => p.id !== projector.id);
    app.select(null);
    app.commit();
  });
  container.appendChild(removeBtn);
}

/**
 * Drag-a-grid editor for the mesh warp.
 *
 * Deliberately a small abstract grid rather than an overlay on the stage: the
 * warp is in projector space, and showing it over the camera view would imply a
 * correspondence that doesn't exist until after the homography is applied.
 */
function meshGridEditor(projector, app) {
  const mesh = projector.mesh;
  const size = 208;
  const canvas = el('canvas', { width: size, height: size });
  canvas.style.cssText =
    'width:100%;max-width:208px;aspect-ratio:1;background:var(--bg-input);border:1px solid var(--line);border-radius:6px;cursor:grab;touch-action:none;margin-bottom:8px;';
  const g = canvas.getContext('2d');
  let dragging = -1;

  const offsetAt = (index, comp) => mesh.offsets?.[index * 2 + comp] ?? 0;

  function nodePosition(index) {
    const col = index % mesh.cols;
    const row = Math.floor(index / mesh.cols);
    const baseX = (col / (mesh.cols - 1)) * (size - 24) + 12;
    const baseY = (row / (mesh.rows - 1)) * (size - 24) + 12;
    // Offsets are in normalised projector units; scale them up so a small,
    // useful nudge is visible in a 208 px box.
    return { x: baseX + offsetAt(index, 0) * size * 2, y: baseY + offsetAt(index, 1) * size * 2 };
  }

  function paint() {
    g.clearRect(0, 0, size, size);
    g.strokeStyle = '#384156';
    g.lineWidth = 1;
    for (let row = 0; row < mesh.rows; row++) {
      g.beginPath();
      for (let col = 0; col < mesh.cols; col++) {
        const p = nodePosition(row * mesh.cols + col);
        if (col === 0) g.moveTo(p.x, p.y);
        else g.lineTo(p.x, p.y);
      }
      g.stroke();
    }
    for (let col = 0; col < mesh.cols; col++) {
      g.beginPath();
      for (let row = 0; row < mesh.rows; row++) {
        const p = nodePosition(row * mesh.cols + col);
        if (row === 0) g.moveTo(p.x, p.y);
        else g.lineTo(p.x, p.y);
      }
      g.stroke();
    }
    for (let i = 0; i < mesh.cols * mesh.rows; i++) {
      const p = nodePosition(i);
      g.beginPath();
      g.arc(p.x, p.y, i === dragging ? 6 : 4, 0, Math.PI * 2);
      g.fillStyle = i === dragging ? '#ffffff' : '#ff7a18';
      g.fill();
    }
  }

  canvas.addEventListener('pointerdown', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * size;
    const y = ((ev.clientY - rect.top) / rect.height) * size;
    let best = -1;
    let bestDist = 14;
    for (let i = 0; i < mesh.cols * mesh.rows; i++) {
      const p = nodePosition(i);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    if (best < 0) return;
    dragging = best;
    app.pushUndo();
    canvas.setPointerCapture(ev.pointerId);
    paint();
  });

  canvas.addEventListener('pointermove', (ev) => {
    if (dragging < 0) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * size;
    const y = ((ev.clientY - rect.top) / rect.height) * size;
    const col = dragging % mesh.cols;
    const row = Math.floor(dragging / mesh.cols);
    const baseX = (col / (mesh.cols - 1)) * (size - 24) + 12;
    const baseY = (row / (mesh.rows - 1)) * (size - 24) + 12;
    mesh.offsets[dragging * 2] = (x - baseX) / (size * 2);
    mesh.offsets[dragging * 2 + 1] = (y - baseY) / (size * 2);
    paint();
    app.commitLive();
  });

  const stop = () => {
    if (dragging < 0) return;
    dragging = -1;
    paint();
    app.commit();
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);

  paint();
  return canvas;
}

/* ------------------------------------------------------------------ *
 * Scenes
 * ------------------------------------------------------------------ */

function renderScene(container, app, id) {
  const scene = app.project.scenes.find((s) => s.id === id);
  if (!scene) return;

  container.appendChild(
    nameField(scene.name, (value) => {
      app.pushUndo();
      scene.name = value;
      app.commit();
    })
  );

  const hotkeyRow = el('div', { class: 'field' }, [el('span', { text: 'Hotkey' })]);
  const hotkeySelect = el('select');
  hotkeySelect.appendChild(el('option', { value: '', text: 'none', selected: !scene.hotkey }));
  for (let i = 1; i <= 9; i++) {
    hotkeySelect.appendChild(
      el('option', { value: String(i), text: String(i), selected: String(scene.hotkey) === String(i) })
    );
  }
  hotkeySelect.addEventListener('change', () => {
    app.pushUndo();
    scene.hotkey = hotkeySelect.value || null;
    app.commit();
  });
  hotkeyRow.appendChild(hotkeySelect);
  container.appendChild(hotkeyRow);

  container.appendChild(
    paramRow({ key: 'fade', type: 'range', label: 'Fade in (s)', min: 0, max: 10, step: 0.1, default: 0.6 }, scene.fade ?? 0.6, null, {
      onChange: (value) => {
        scene.fade = value;
        app.commitLive();
      },
    })
  );

  const captured = Object.keys(scene.state || {}).length;
  container.appendChild(
    el('p', {
      class: 'panel-note',
      text: `Holds the state of ${captured} effect${captured === 1 ? '' : 's'}. Switching to it crossfades every parameter that changed.`,
    })
  );

  const recapture = el('button', { type: 'button', class: 'btn small primary', text: 'Update from current state' });
  recapture.addEventListener('click', () => app.recaptureScene(scene.id));

  const apply = el('button', { type: 'button', class: 'btn small', text: 'Go to scene' });
  apply.addEventListener('click', () => app.activateScene(scene.id));

  const remove = el('button', { type: 'button', class: 'btn small danger', text: 'Delete' });
  remove.addEventListener('click', () => {
    app.pushUndo();
    app.project.scenes = app.project.scenes.filter((s) => s.id !== scene.id);
    app.project.show.playlist = (app.project.show.playlist || []).filter((e) => e.sceneId !== scene.id);
    if (app.project.show.activeScene === scene.id) app.project.show.activeScene = null;
    app.select(null);
    app.commit();
  });

  container.appendChild(el('div', { class: 'panel-actions' }, [recapture, apply, remove]));
}

/* ------------------------------------------------------------------ *
 * Triggers
 * ------------------------------------------------------------------ */

function renderTrigger(container, app, id) {
  const trigger = app.project.triggers.find((t) => t.id === id);
  if (!trigger) return;

  container.appendChild(
    nameField(trigger.name, (value) => {
      app.pushUndo();
      trigger.name = value;
      app.commit();
    })
  );

  const fire = el('button', { type: 'button', class: 'btn small primary', text: 'Fire it now' });
  fire.addEventListener('click', () => app.fireTrigger(trigger.id));
  container.appendChild(el('div', { class: 'panel-actions' }, [fire]));

  container.appendChild(
    checkbox('Armed', trigger.enabled !== false, (checked) => {
      trigger.enabled = checked;
      app.commitLive();
      app.refreshPanels();
    })
  );

  /* --- what sets it off --- */

  container.appendChild(heading('Fires on'));
  const sourceRow = el('div', { class: 'field' }, [el('span', { text: 'Source' })]);
  const sourceSelect = el('select');
  for (const [value, label] of [
    ['motion', 'Motion in the camera'],
    ['hotkey', 'A key press'],
    ['timer', 'A timer'],
    ['manual', 'Only when I press the button'],
  ]) {
    sourceSelect.appendChild(el('option', { value, text: label, selected: value === trigger.source }));
  }
  sourceSelect.addEventListener('change', () => {
    app.pushUndo();
    trigger.source = sourceSelect.value;
    app.commit();
    app.refreshInspector();
  });
  sourceRow.appendChild(sourceSelect);
  container.appendChild(sourceRow);

  if (trigger.source === 'motion') {
    container.appendChild(
      el('p', {
        class: 'panel-note',
        text:
          'Watch part of the camera view that your projectors do not light — the path, the drive, the gate. Aimed at the house itself it will fire on your own effects.',
      })
    );

    for (const [key, label] of [['x', 'Region left'], ['y', 'Region top'], ['w', 'Region width'], ['h', 'Region height']]) {
      container.appendChild(
        paramRow({ key, type: 'range', label, min: 0, max: 1, step: 0.005, default: 0.5 }, trigger.region?.[key] ?? 0.5, null, {
          onChange: (value) => {
            trigger.region = trigger.region || {};
            trigger.region[key] = value;
            app.commitLive();
          },
        })
      );
    }

    container.appendChild(
      paramRow({ key: 'sensitivity', type: 'range', label: 'Sensitivity', min: 0, max: 1, step: 0.01, default: 0.5 }, trigger.sensitivity ?? 0.5, null, {
        onChange: (value) => {
          trigger.sensitivity = value;
          app.commitLive();
        },
      })
    );
    container.appendChild(
      el('p', {
        class: 'panel-note',
        text: 'The Triggers panel shows a live reading of how much of the region is moving, and the level it has to beat.',
      })
    );
  }

  if (trigger.source === 'hotkey') {
    const keyRow = el('div', { class: 'field' }, [el('span', { text: 'Key' })]);
    const keyInput = el('input', { type: 'text', value: trigger.key || '', maxlength: '1' });
    keyInput.addEventListener('change', () => {
      app.pushUndo();
      trigger.key = keyInput.value.slice(0, 1).toLowerCase();
      app.commit();
    });
    keyRow.appendChild(keyInput);
    container.appendChild(keyRow);

    /**
     * Say which key is taken, rather than listing them and hoping.
     *
     * The editor's own handler runs first and does not fall through, so a
     * trigger on a reserved key is simply dead: it looks configured, reads as
     * configured, and never fires. Worth catching here rather than at eight
     * o'clock on the thirty-first.
     */
    const taken = RESERVED_KEYS[trigger.key];
    if (taken) {
      container.appendChild(
        el('p', {
          class: 'panel-note issue warn',
          text: `"${trigger.key}" already does ${taken}, so this trigger will never fire. Pick another key.`,
        })
      );
    } else {
      container.appendChild(
        el('p', { class: 'panel-note', text: 'Any single key the editor does not already use. Anything that can type can press it — including a doorbell wired to a USB button.' })
      );
    }
  }

  if (trigger.source === 'timer') {
    container.appendChild(
      paramRow({ key: 'every', type: 'range', label: 'Every (s)', min: 5, max: 1800, step: 5, default: 180 }, trigger.every ?? 180, null, {
        onChange: (value) => {
          trigger.every = value;
          app.commitLive();
        },
      })
    );
    container.appendChild(
      paramRow({ key: 'jitter', type: 'range', label: 'Randomness', min: 0, max: 1, step: 0.01, default: 0.5 }, trigger.jitter ?? 0.5, null, {
        onChange: (value) => {
          trigger.jitter = value;
          app.commitLive();
        },
      })
    );
    container.appendChild(
      el('p', { class: 'panel-note', text: 'Randomness spreads the firing around the interval so it does not become predictable.' })
    );
  }

  /* --- what it does --- */

  container.appendChild(heading('Does this'));

  const sceneRow = el('div', { class: 'field' }, [el('span', { text: 'Go to scene' })]);
  const sceneSelect = el('select');
  sceneSelect.appendChild(el('option', { value: '', text: '— none —' }));
  for (const scene of app.project.scenes) {
    sceneSelect.appendChild(el('option', { value: scene.id, text: scene.name, selected: scene.id === trigger.sceneId }));
  }
  sceneSelect.addEventListener('change', () => {
    app.pushUndo();
    trigger.sceneId = sceneSelect.value || null;
    app.commit();
  });
  sceneRow.appendChild(sceneSelect);
  container.appendChild(sceneRow);

  if (!app.project.scenes.length) {
    container.appendChild(
      el('p', { class: 'panel-note', text: 'Save a scene first — build the scare you want, then Scenes > Save current as scene.' })
    );
  }

  const soundRow = el('div', { class: 'field' }, [el('span', { text: 'Sound' })]);
  const soundSelect = el('select');
  soundSelect.appendChild(el('option', { value: '', text: '— none —' }));
  for (const entry of (app.project.media || []).filter((m) => m.kind === 'audio')) {
    soundSelect.appendChild(el('option', { value: entry.id, text: entry.name, selected: entry.id === trigger.sound }));
  }
  soundSelect.addEventListener('change', () => {
    app.pushUndo();
    trigger.sound = soundSelect.value || null;
    app.commit();
  });
  soundRow.appendChild(soundSelect);
  container.appendChild(soundRow);

  container.appendChild(
    paramRow({ key: 'soundVolume', type: 'range', label: 'Volume', min: 0, max: 2, step: 0.01, default: 1 }, trigger.soundVolume ?? 1, null, {
      onChange: (value) => {
        trigger.soundVolume = value;
        app.commitLive();
      },
    })
  );

  container.appendChild(
    paramRow({ key: 'hold', type: 'range', label: 'Hold (s)', min: 0, max: 60, step: 0.5, default: 6 }, trigger.hold ?? 6, null, {
      onChange: (value) => {
        trigger.hold = value;
        app.commitLive();
      },
    })
  );
  container.appendChild(
    el('p', {
      class: 'panel-note',
      text: 'After the hold it returns to whatever was playing. Set it to 0 to stay on the new scene.',
    })
  );

  container.appendChild(
    paramRow({ key: 'cooldown', type: 'range', label: 'Cooldown (s)', min: 0, max: 300, step: 1, default: 20 }, trigger.cooldown ?? 20, null, {
      onChange: (value) => {
        trigger.cooldown = value;
        app.commitLive();
      },
    })
  );
  container.appendChild(
    el('p', { class: 'panel-note', text: 'Minimum gap between firings, so one group of visitors gets one scare.' })
  );

  /* --- and tells the rest of the house --- */

  container.appendChild(heading('HTTP calls'));
  container.appendChild(
    el('p', {
      class: 'panel-note',
      html: 'For <strong>WLED</strong> and anything else on the network that takes a URL. '
        + '<em>Before</em> fires the instant the trigger does; <em>after</em> when the hold expires and '
        + 'the show goes back to what it was doing — so the whole house resets itself for the next group.',
    })
  );

  if (!trigger.http) {
    trigger.http = {
      before: { url: '', method: 'GET', body: '', mode: 'no-cors' },
      after: { url: '', method: 'GET', body: '', mode: 'no-cors' },
    };
  }

  for (const [when, label, placeholder] of [
    ['before', 'Before', 'http://wled.local/win&T=1&A=255&FX=45'],
    ['after', 'After', 'http://wled.local/win&PL=1'],
  ]) {
    const hook = trigger.http[when] || (trigger.http[when] = { url: '', method: 'GET', body: '', mode: 'no-cors' });

    const urlRow = el('div', { class: 'field' }, [el('span', { text: label })]);
    const url = el('input', { type: 'text', value: hook.url || '', placeholder, spellcheck: 'false' });
    const warn = el('p', { class: 'panel-note issue warn' });
    const check = () => {
      const problem = checkReachable(url.value);
      warn.textContent = problem || '';
      warn.hidden = !problem;
    };
    url.addEventListener('change', () => {
      app.pushUndo();
      hook.url = url.value.trim();
      check();
      app.commit();
    });
    url.addEventListener('input', check);
    check();
    urlRow.appendChild(url);
    container.appendChild(urlRow);
    container.appendChild(warn);

    if (hook.url) {
      const methodRow = el('div', { class: 'field' }, [el('span', { text: 'Method' })]);
      const method = el('select');
      for (const m of ['GET', 'POST', 'PUT']) {
        method.appendChild(el('option', { value: m, text: m, selected: (hook.method || 'GET') === m }));
      }
      method.addEventListener('change', () => {
        app.pushUndo();
        hook.method = method.value;
        app.commit();
        app.refreshInspector();
      });
      methodRow.appendChild(method);
      container.appendChild(methodRow);

      if (hook.method && hook.method !== 'GET') {
        const bodyRow = el('div', { class: 'field' }, [el('span', { text: 'Body' })]);
        const body = el('input', { type: 'text', value: hook.body || '', placeholder: '{"on":true,"bri":255}', spellcheck: 'false' });
        body.addEventListener('change', () => {
          app.pushUndo();
          hook.body = body.value;
          app.commit();
        });
        bodyRow.appendChild(body);
        container.appendChild(bodyRow);
      }

      container.appendChild(
        checkbox('Wait for a reply', hook.mode === 'cors', (checked) => {
          hook.mode = checked ? 'cors' : 'no-cors';
          app.commitLive();
        })
      );
      container.appendChild(
        el('p', {
          class: 'panel-note',
          text: 'Off is right for almost everything: the call still goes out, the reply is just '
            + 'ignored, and the device needs no CORS setup. Turn it on to find out why one is failing.',
        })
      );

      const test = el('button', { type: 'button', class: 'btn small', text: `Test ${label.toLowerCase()}` });
      test.addEventListener('click', async () => {
        const result = await fireWebhook(hook, { key: `test:${trigger.id}:${when}` });
        if (result.skipped) toast('Nothing to call — put a URL in first.');
        else if (result.ok) {
          toast(result.opaque
            ? 'Sent. The reply is hidden, so check the lights rather than this message.'
            : `Sent — the device replied ${result.status}.`, 'good');
        } else toast(result.error, 'bad');
      });
      container.appendChild(el('div', { class: 'panel-actions' }, [test]));
    }
  }

  const remove = el('button', { type: 'button', class: 'btn small danger', text: 'Delete trigger' });
  remove.addEventListener('click', () => {
    app.pushUndo();
    app.project.triggers = app.project.triggers.filter((t) => t.id !== trigger.id);
    app.select(null);
    app.commit();
  });
  container.appendChild(el('div', { class: 'panel-actions' }, [remove]));
}
