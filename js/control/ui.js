/**
 * Small DOM helpers and the parameter-control factory.
 *
 * The inspector is generated entirely from each effect's `params` schema, so a
 * custom effect written in the Code panel gets the same controls, the same
 * modulation bindings and the same undo behaviour as a built-in. That's the
 * whole reason the schema exists rather than hand-written markup per effect.
 */

import { describeBinding, BINDING_TYPES, WAVES } from '../core/modulators.js';
import { listCameras } from './feeds.js';

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

let toastTimer = null;
export function toast(message, kind = '') {
  const node = document.getElementById('toast');
  if (!node) return;
  node.textContent = message;
  node.className = `toast ${kind}`;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, kind === 'bad' ? 7000 : 3200);
}

/** Format a number compactly for the value readout beside a slider. */
export function fmt(value) {
  if (typeof value !== 'number' || !isFinite(value)) return String(value ?? '');
  if (Number.isInteger(value)) return String(value);
  const abs = Math.abs(value);
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 10) return value.toFixed(1);
  if (abs >= 1) return value.toFixed(2);
  return value.toFixed(3);
}

/* ------------------------------------------------------------------ *
 * Parameter controls
 * ------------------------------------------------------------------ */

/**
 * Build one inspector row for a parameter definition.
 *
 * @param {object} def      { key, type, label, default, min, max, step, options }
 * @param {*} value         current static value
 * @param {object|null} binding current modulation binding
 * @param {object} handlers { onChange(value), onBindingChange(binding|null), mediaList }
 */
export function paramRow(def, value, binding, handlers) {
  const row = el('div', { class: 'param-row' });
  row.appendChild(el('label', { text: def.label || def.key, title: def.key }));

  const control = el('div', { class: 'param-control' });
  const commit = (v) => handlers.onChange(v);
  const bound = binding && binding.type && binding.type !== 'const';

  switch (def.type) {
    case 'range':
    case 'number': {
      const current = Number(value ?? def.default ?? 0);
      const input = el('input', {
        type: 'range',
        min: def.min ?? 0,
        max: def.max ?? 1,
        step: def.step ?? 0.01,
      });

      const readout = el('span', { class: 'param-value', text: fmt(current) });

      /**
       * Put a value on the slider, held to the range the engine will honour.
       *
       * The range on a parameter is not a suggestion. `resolveParams` clamps
       * every numeric parameter to `min`..`max` before the effect ever sees it,
       * and deliberately: a modulator or an expression can produce anything, and
       * effects should not have to defend themselves against it. So a value past
       * the end of the range is not a bigger setting, it is a number that will be
       * quietly reduced on its way to the wall.
       *
       * Which makes this the one thing the control must not do — accept a value
       * it knows will not be used. Typing 10 into a control that stops at 3 used
       * to store 10, display 10 and hand the effect 3, so every value above the
       * limit looked identical and the slider appeared to have stopped working.
       * Clamped here instead, and said out loud, so what you read is what is on
       * the house.
       */
      const limit = (n) => {
        let v = Number(n);
        if (!isFinite(v)) v = Number(def.default ?? 0);
        if (def.min !== undefined) v = Math.max(Number(def.min), v);
        if (def.max !== undefined) v = Math.min(Number(def.max), v);
        return v;
      };

      const place = (num) => {
        input.value = String(num);
        readout.textContent = fmt(num);
      };

      // A stored value out of range — an imported show, or an edit made while
      // this control was still willing to accept one — is shown as the value
      // that will actually be used rather than as itself.
      const shown = limit(current);
      place(shown);
      if (shown !== current) commit(shown);

      input.addEventListener('input', () => {
        readout.textContent = fmt(Number(input.value));
        commit(Number(input.value));
      });
      // Double-click the readout to type an exact value; sliders are hopeless
      // for "exactly 0.5", and for anything past the end of the track.
      readout.addEventListener('dblclick', () => {
        const entered = prompt(`${def.label || def.key}:`, String(input.value));
        if (entered === null) return;
        const num = Number(entered);
        if (!isFinite(num)) return;
        const held = limit(num);
        if (held !== num) {
          toast(`${def.label || def.key} goes from ${fmt(Number(def.min ?? 0))} to ${fmt(Number(def.max ?? 1))}. Set to ${fmt(held)}.`);
        }
        place(held);
        commit(held);
      });
      readout.title = 'Double-click to type a value';
      control.append(input, readout);
      break;
    }

    /**
     * A camera picker.
     *
     * Populated asynchronously, because enumerating devices is async and a
     * parameter row is not. It renders immediately with whatever it already
     * knows — the stored value and the default — and fills in the real list a
     * moment later, so the row never blocks the inspector.
     *
     * Labels are blank until the browser has granted camera permission at least
     * once, which is a privacy rule rather than a bug; the fallback is the
     * device's position in the list, which is enough to tell two apart.
     */
    case 'camera': {
      const select = el('select');
      const current = String(value ?? def.default ?? '');
      select.appendChild(el('option', { value: '', text: 'Alignment camera' }));
      if (current) select.appendChild(el('option', { value: current, text: 'Selected camera', selected: true }));
      select.addEventListener('change', () => commit(select.value));
      listCameras().then((cams) => {
        const chosen = select.value;
        clear(select);
        select.appendChild(el('option', { value: '', text: 'Alignment camera' }));
        cams.forEach((cam, i) => {
          select.appendChild(el('option', {
            value: cam.deviceId,
            text: cam.label || `Camera ${i + 1}`,
          }));
        });
        // A device that has since been unplugged still has to be shown, or
        // opening the inspector would silently retarget the layer.
        if (chosen && !cams.some((c) => c.deviceId === chosen)) {
          select.appendChild(el('option', { value: chosen, text: 'Camera (not connected)' }));
        }
        select.value = chosen;
      });
      /**
       * A URL as well as a device, because a lot of the cameras people already
       * have on the house are not USB webcams. Anything a browser can play goes
       * here — see the note on RTSP in docs/effects.md, which it cannot.
       */
      const url = el('input', {
        type: 'text',
        value: /^https?:/i.test(current) ? current : '',
        placeholder: 'or a stream URL — http://…',
        spellcheck: 'false',
      });
      url.addEventListener('change', () => {
        const value = url.value.trim();
        commit(value);
        if (value) select.value = '';
      });
      control.append(select, url);
      break;
    }

    case 'color': {
      const input = el('input', { type: 'color', value: String(value ?? def.default ?? '#ffffff') });
      const hex = el('input', { type: 'text', value: String(value ?? def.default ?? '#ffffff') });
      hex.style.fontFamily = 'var(--mono)';
      hex.style.fontSize = '11px';
      input.addEventListener('input', () => {
        hex.value = input.value;
        commit(input.value);
      });
      hex.addEventListener('change', () => {
        if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(hex.value)) {
          input.value = hex.value;
          commit(hex.value);
        } else {
          hex.value = input.value;
        }
      });
      control.append(input, hex);
      break;
    }

    case 'bool': {
      const input = el('input', { type: 'checkbox' });
      input.checked = !!value;
      input.addEventListener('change', () => commit(input.checked));
      control.appendChild(input);
      break;
    }

    case 'select': {
      const select = el('select');
      const options = def.options || [];
      for (const option of options) {
        select.appendChild(el('option', { value: option, text: option, selected: option === value }));
      }
      /**
       * A stored value that is not on the list still has to be shown.
       *
       * With no option marked selected a browser displays the *first* one, so an
       * imported show carrying a font or a mode this build does not have read as
       * though it were set to something it was not — and touching anything else
       * in the row committed that reading. The effect meanwhile went on using
       * the stored string and falling back internally, so the picture and the
       * panel disagreed with nothing to say which was right.
       */
      const stored = value ?? def.default;
      if (stored !== undefined && stored !== null && !options.includes(stored)) {
        select.appendChild(el('option', {
          value: String(stored),
          text: `${stored} — not available`,
          selected: true,
        }));
      }
      select.addEventListener('change', () => commit(select.value));
      control.appendChild(select);
      break;
    }

    case 'media': {
      const select = el('select');
      select.appendChild(el('option', { value: '', text: '— none —' }));
      for (const item of handlers.mediaList || []) {
        select.appendChild(
          el('option', { value: item.id, text: `${item.name}`, selected: item.id === value })
        );
      }
      select.addEventListener('change', () => commit(select.value));
      control.appendChild(select);
      break;
    }

    case 'text':
    default: {
      const input = el('input', { type: 'text', value: String(value ?? def.default ?? '') });
      input.addEventListener('input', () => commit(input.value));
      control.appendChild(input);
      break;
    }
  }

  row.appendChild(control);

  // Modulation needs somewhere to store the binding, and only numeric values
  // interpolate usefully — binding a colour to an LFO would just produce noise.
  const modulatable =
    typeof handlers.onBindingChange === 'function' &&
    (def.type === 'range' || def.type === 'number' || def.type === 'bool');

  if (modulatable) {
    const bindBtn = el('button', {
      type: 'button',
      class: `bind-btn${bound ? ' bound' : ''}`,
      title: bound ? `Modulated: ${describeBinding(binding)}` : 'Add modulation',
      text: bound ? '~' : '+',
    });
    // Keep the button's own appearance in sync without re-rendering the whole
    // inspector, which would collapse the editor mid-edit.
    const onBindingChange = (next) => {
      bindBtn.classList.toggle('bound', !!next);
      bindBtn.textContent = next ? '~' : '+';
      bindBtn.title = next ? `Modulated: ${describeBinding(next)}` : 'Add modulation';
      handlers.onBindingChange(next);
    };

    bindBtn.addEventListener('click', () => {
      const editor = row.nextElementSibling;
      if (editor?.classList.contains('binding-editor')) {
        editor.remove();
        return;
      }
      row.after(bindingEditor(def, binding, { ...handlers, onBindingChange }));
    });
    row.appendChild(bindBtn);
  } else {
    row.appendChild(el('span'));
  }

  return row;
}

/** The expandable modulation panel that appears under a bound parameter. */
function bindingEditor(def, binding, handlers) {
  const current = binding && binding.type ? { ...binding } : { type: 'const' };
  const wrap = el('div', { class: 'binding-editor' });

  const update = (patch) => {
    Object.assign(current, patch);
    handlers.onBindingChange(current.type === 'const' ? null : { ...current });
    rebuild();
  };

  const typeRow = el('div', { class: 'field' }, [el('span', { text: 'Modulate' })]);
  const typeSelect = el('select');
  for (const type of BINDING_TYPES) {
    typeSelect.appendChild(
      el('option', {
        value: type,
        text: { const: 'off', lfo: 'LFO', audio: 'audio', random: 'random', env: 'envelope', expr: 'expression' }[type],
        selected: type === current.type,
      })
    );
  }
  typeSelect.addEventListener('change', () => update({ type: typeSelect.value }));
  typeRow.appendChild(typeSelect);

  const body = el('div');

  function numberField(label, key, { min, max, step, fallback }) {
    const input = el('input', {
      type: 'number',
      min,
      max,
      step,
      value: current[key] ?? fallback,
    });
    input.addEventListener('change', () => update({ [key]: Number(input.value) }));
    return el('div', { class: 'field' }, [el('span', { text: label }), input]);
  }

  function checkField(label, key, fallback = false) {
    const input = el('input', { type: 'checkbox' });
    input.checked = current[key] ?? fallback;
    input.addEventListener('change', () => update({ [key]: input.checked }));
    return el('label', { class: 'inline-check' }, [input, label]);
  }

  function rebuild() {
    clear(body);
    const span = (def.max ?? 1) - (def.min ?? 0);

    switch (current.type) {
      case 'lfo': {
        const waveSelect = el('select');
        for (const wave of WAVES) {
          waveSelect.appendChild(el('option', { value: wave, text: wave, selected: wave === (current.wave || 'sine') }));
        }
        waveSelect.addEventListener('change', () => update({ wave: waveSelect.value }));
        body.append(
          el('div', { class: 'field' }, [el('span', { text: 'Wave' }), waveSelect]),
          checkField('Lock to beat', 'sync'),
          numberField(current.sync ? 'Beats/cycle' : 'Rate (Hz)', 'rate', {
            min: 0.01, max: 64, step: 0.01, fallback: current.sync ? 1 : 0.5,
          }),
          numberField('Depth', 'depth', { min: -span * 2, max: span * 2, step: span / 100, fallback: span / 4 }),
          numberField('Phase', 'phase', { min: 0, max: 1, step: 0.01, fallback: 0 }),
          numberField('Spread per shape', 'spread', { min: -1, max: 1, step: 0.01, fallback: 0 }),
          checkField('Positive only', 'unipolar')
        );
        break;
      }
      case 'audio': {
        const bandSelect = el('select');
        for (const band of ['level', 'low', 'mid', 'high']) {
          bandSelect.appendChild(el('option', { value: band, text: band, selected: band === (current.band || 'level') }));
        }
        bandSelect.addEventListener('change', () => update({ band: bandSelect.value }));
        body.append(
          el('div', { class: 'field' }, [el('span', { text: 'Band' }), bandSelect]),
          numberField('Depth', 'depth', { min: -span * 2, max: span * 2, step: span / 100, fallback: span / 2 }),
          el('p', { class: 'panel-note', text: 'Enable the microphone in Setup for this to do anything.' })
        );
        break;
      }
      case 'random':
        body.append(
          numberField('Changes / s', 'rate', { min: 0.05, max: 30, step: 0.05, fallback: 2 }),
          numberField('Depth', 'depth', { min: -span * 2, max: span * 2, step: span / 100, fallback: span / 4 }),
          numberField('Smoothing', 'smooth', { min: 0, max: 0.99, step: 0.01, fallback: 0 }),
          checkField('Positive only', 'unipolar')
        );
        break;
      case 'env':
        body.append(
          numberField('Beats per hit', 'division', { min: 0.0625, max: 16, step: 0.0625, fallback: 1 }),
          numberField('Decay (s)', 'decay', { min: 0.01, max: 8, step: 0.01, fallback: 0.4 }),
          numberField('Attack shape', 'attack', { min: 0, max: 1, step: 0.01, fallback: 0 }),
          numberField('Depth', 'depth', { min: -span * 2, max: span * 2, step: span / 100, fallback: span })
        );
        break;
      case 'expr': {
        const area = el('textarea', {
          class: 'binding-expr',
          spellcheck: 'false',
          placeholder: 'base + 0.4 * sin(t * TAU * 0.5 + i)',
        });
        area.value = current.code ?? 'base';
        area.addEventListener('change', () => update({ code: area.value }));
        body.append(
          area,
          el('p', {
            class: 'panel-note',
            html:
              'Available: <code>t</code> <code>beat</code> <code>i</code> <code>n</code> <code>base</code> ' +
              '<code>level</code> <code>low</code> <code>mid</code> <code>high</code> <code>shape</code>, ' +
              'plus <code>sin cos noise fbm clamp lerp smoothstep rand saw tri square TAU</code>.',
          })
        );
        if (current.__error) body.append(el('p', { class: 'code-status bad', text: current.__error }));
        break;
      }
      default:
        body.append(el('p', { class: 'panel-note', text: 'This parameter holds a fixed value.' }));
    }
  }

  rebuild();
  wrap.append(typeRow, body);
  return wrap;
}
