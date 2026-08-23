/**
 * The modulation editor, and the binding it is editing.
 *
 * A binding is the difference between a slider and a show: the parameter stops
 * being a number you chose and starts being one that breathes, chases the beat
 * or answers the microphone. All of it is authored through one small panel that
 * folds out under the parameter row.
 *
 * That panel is deliberately *not* re-rendered when the binding changes —
 * rebuilding the inspector under somebody's cursor would collapse the editor
 * they are typing in — and the price of that is a copy of the binding that has
 * to be kept honest by hand. It was not, in two ways that both end with the
 * panel describing something other than what the show is actually doing:
 *
 *   - The row remembered the binding as it stood when the inspector was drawn,
 *     so folding the editor away and opening it again offered you *off* for a
 *     parameter that was plainly modulated — and the first control you touched
 *     wrote that back.
 *   - A broken expression files its error on the binding, and nothing took it
 *     off again, so the red line under the box outlived every fix and got
 *     saved into the show.
 *
 * The DOM here is a stand-in — enough of one for `el()`, `after()` and a
 * `classList`. What is being checked is the bookkeeping, not the pixels.
 *
 *   node test/bindings.test.mjs
 */

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

/* ------------------------------------------------------------------ *
 * A stand-in for as much of a browser as the editor touches
 * ------------------------------------------------------------------ */

function makeNode(tag) {
  const listeners = new Map();
  const classes = new Set();
  const own = {};
  const node = {
    tagName: tag.toUpperCase(),
    children: [],
    parentNode: null,
    textContent: '',
    innerHTML: '',
    dataset: {},
    attributes: {},
    checked: false,
    /**
     * `value` the way the real thing has it, because `el()` reaches it through
     * `setAttribute`.
     *
     * A `<select>` with no value set of its own answers with whichever option
     * carries `selected`, and an `<input value="3">` answers "3" — both of
     * which are exactly what this file is checking a reopened editor for, so a
     * stand-in that leaves them empty would pass whatever the code did.
     */
    get value() {
      if (own.value !== undefined) return own.value;
      if (node.tagName === 'SELECT') {
        const picked = node.children.find((c) => c.attributes?.selected !== undefined);
        return picked ? picked.value : node.children[0]?.value ?? '';
      }
      return node.attributes.value ?? '';
    },
    set value(v) {
      own.value = v;
    },
    get className() {
      return [...classes].join(' ');
    },
    set className(v) {
      classes.clear();
      for (const c of String(v || '').split(/\s+/)) if (c) classes.add(c);
    },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c),
    },
    get firstChild() {
      return node.children[0] || null;
    },
    get nextElementSibling() {
      const kin = node.parentNode?.children || [];
      return kin[kin.indexOf(node) + 1] || null;
    },
    appendChild(child) {
      child.parentNode = node;
      node.children.push(child);
      return child;
    },
    append(...kids) {
      for (const k of kids) if (k) node.appendChild(k);
    },
    removeChild(child) {
      const at = node.children.indexOf(child);
      if (at >= 0) node.children.splice(at, 1);
      child.parentNode = null;
      return child;
    },
    remove() {
      node.parentNode?.removeChild(node);
    },
    /** Insert a sibling straight after this one, as the real thing does. */
    after(sibling) {
      const kin = node.parentNode;
      if (!kin) return;
      sibling.parentNode = kin;
      kin.children.splice(kin.children.indexOf(node) + 1, 0, sibling);
    },
    setAttribute(key, value) {
      node.attributes[key] = value;
    },
    getAttribute(key) {
      return node.attributes[key];
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    fire(type) {
      for (const fn of [...(listeners.get(type) || [])]) fn({ type, stopPropagation() {} });
    },
    focus() {},
  };
  return node;
}

globalThis.document = {
  createElement: (tag) => makeNode(tag),
  createTextNode: (text) => ({ tagName: '#text', textContent: text, children: [] }),
  getElementById: () => null,
};

const { paramRow } = await import('../js/control/ui.js');
const { evaluateBinding } = await import('../js/core/modulators.js');

/* ------------------------------------------------------------------ *
 * Walking the built panel
 * ------------------------------------------------------------------ */

function walk(node, out = []) {
  out.push(node);
  for (const child of node.children || []) walk(child, out);
  return out;
}

const DEF = { key: 'amount', type: 'range', label: 'Amount', default: 0.5, min: 0, max: 1, step: 0.01 };

/** A row inside a parent, so `after()` has somewhere to put the editor. */
function mountRow(binding, onBindingChange) {
  const host = makeNode('div');
  const row = paramRow(DEF, 0.5, binding, { onChange() {}, onBindingChange });
  host.appendChild(row);
  return { host, row };
}

const bindButton = (row) => walk(row).find((n) => n.classList.contains('bind-btn'));
const editorOf = (host) => host.children.find((n) => n.classList?.contains('binding-editor')) || null;
const selectIn = (node) => walk(node).find((n) => n.tagName === 'SELECT');
const labelled = (node, text) =>
  walk(node).find((n) => n.tagName === 'DIV' && n.children.some((c) => c.textContent === text));
const inputFor = (node, text) => labelled(node, text)?.children.find((c) => c.tagName === 'INPUT');

/* ------------------------------------------------------------------ *
 * Folding the editor away and opening it again
 * ------------------------------------------------------------------ */

console.log('— reopening the modulation editor —');

{
  let stored = null;
  const { host, row } = mountRow(null, (next) => { stored = next; });
  const btn = bindButton(row);
  ok('a plain parameter offers modulation', !!btn);

  btn.fire('click');
  const first = editorOf(host);
  ok('clicking it folds an editor out', !!first);

  const type = selectIn(first);
  type.value = 'lfo';
  type.fire('change');
  ok('choosing a shape binds the parameter', stored?.type === 'lfo', JSON.stringify(stored));

  const rate = inputFor(editorOf(host), 'Rate (Hz)');
  rate.value = '3';
  rate.fire('change');
  ok('and its rate is stored', stored?.rate === 3, JSON.stringify(stored));

  btn.fire('click');
  ok('clicking again folds it away', !editorOf(host));

  btn.fire('click');
  const second = editorOf(host);

  /**
   * The one that was wrong. The row held the binding as it stood when the
   * inspector was drawn — null — so this came back offering *off* for a
   * parameter the button beside it was still calling modulated, and the next
   * thing you touched wrote the LFO away.
   */
  ok('and opening it again shows the binding that is actually there',
    selectIn(second).value === 'lfo', selectIn(second).value);
  const reopenedRate = inputFor(second, 'Rate (Hz)')?.value;
  ok('with the rate you set, not the default',
    reopenedRate === 3 || reopenedRate === '3',
    reopenedRate === undefined ? 'no rate field at all' : String(reopenedRate));

  const wave = walk(second).filter((n) => n.tagName === 'SELECT')[1];
  if (wave) {
    wave.value = 'saw';
    wave.fire('change');
  }
  ok('so an edit after reopening keeps everything else',
    stored?.type === 'lfo' && stored?.rate === 3 && stored?.wave === 'saw',
    JSON.stringify(stored));
}

/* ------------------------------------------------------------------ *
 * A broken expression, and a fixed one
 * ------------------------------------------------------------------ */

console.log('\n— what the expression box says is wrong —');

const ctx = { t: 1, dt: 1 / 60, beat: 2, beatPhase: 0, bpm: 120, audio: { level: 0 }, i: 0, n: 1 };

{
  const binding = { type: 'expr', code: 'nope.missing' };
  evaluateBinding(binding, 0.5, DEF, ctx, 'L1:amount');
  ok('a broken expression reports itself', !!binding.__error, binding.__error || 'nothing');

  binding.code = 'base * 2';
  const value = evaluateBinding(binding, 0.5, DEF, ctx, 'L1:amount');
  ok('and a fixed one evaluates', value === 1, String(value));

  /**
   * It used to stay set for good: one typo left the red line under the box for
   * the rest of the session, and a show saved in that state carried the
   * message into the file.
   */
  ok('and stops reporting the fault it used to have',
    !('__error' in binding), binding.__error || '');
}

{
  const { host, row } = mountRow({ type: 'expr', code: 'base *' }, () => {});
  bindButton(row).fire('click');
  const editor = editorOf(host);
  const bad = walk(editor).filter((n) => n.classList.contains('code-status'));
  ok('a syntax error is reported without waiting for a frame', bad.length === 1,
    bad[0]?.textContent || 'nothing said');

  const area = walk(editor).find((n) => n.tagName === 'TEXTAREA');
  area.value = 'base * 2';
  area.fire('change');
  ok('and goes when the expression parses',
    walk(editorOf(host)).filter((n) => n.classList.contains('code-status')).length === 0);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
