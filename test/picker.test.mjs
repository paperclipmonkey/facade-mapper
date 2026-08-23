/**
 * The effect browser.
 *
 * Picking an effect from a list of eighty-odd names is picking blind, so the
 * picker renders every one of them live, through the real renderer, on a shape
 * the size of the one the layer targets. Rendering eighty-odd live canvases at
 * once would be silly, so only the cards actually on screen animate and an
 * IntersectionObserver decides which those are.
 *
 * That observer is the part with a trap in it. It holds its targets: taking a
 * card out of the DOM does not end the observation, and the whole card set is
 * rebuilt on *every keystroke* in the search box. Typing four letters left four
 * sets of eighty-odd detached cards — each with its own canvas — observed and
 * unreachable for as long as the dialog stayed open, on the machine that is
 * also driving the projectors.
 *
 * Nothing about that is visible: the picker works, the search works, and the
 * cost is memory on a tab nobody is watching the memory of. So this counts what
 * is being observed, which is the only number that says so.
 *
 * The DOM here is a stand-in — enough of one for `el()`, a dialog and a
 * counting observer. The frame loop is deliberately never run: this is about
 * the bookkeeping around the cards, and `robustness.test.mjs` is about what
 * they draw.
 *
 *   node test/picker.test.mjs
 */

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

/* ------------------------------------------------------------------ *
 * A stand-in for as much of a browser as the picker touches
 * ------------------------------------------------------------------ */

function makeNode(tag) {
  const listeners = new Map();
  const node = {
    tagName: tag.toUpperCase(),
    children: [],
    parentNode: null,
    className: '',
    textContent: '',
    dataset: {},
    hidden: false,
    value: '',
    attributes: {},
    get firstChild() {
      return node.children[0] || null;
    },
    appendChild(child) {
      child.parentNode = node;
      node.children.push(child);
      return child;
    },
    removeChild(child) {
      const at = node.children.indexOf(child);
      if (at >= 0) node.children.splice(at, 1);
      child.parentNode = null;
      return child;
    },
    replaceChildren() {
      node.children.length = 0;
    },
    setAttribute(key, value) {
      node.attributes[key] = value;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    /** Fire a handler the way the browser would. */
    fire(type) {
      for (const fn of [...(listeners.get(type) || [])]) fn({ type });
    },
    focus() {},
    // Dialogs.
    showModal() {
      node.open = true;
    },
    close() {
      node.open = false;
      node.fire('close');
    },
    // Canvases.
    getContext() {
      return {
        canvas: node,
        clearRect() {},
        setTransform() {},
        save() {},
        restore() {},
        drawImage() {},
      };
    },
  };
  return node;
}

const effectDialog = makeNode('dialog');
const effectDialogBody = makeNode('div');

globalThis.document = {
  createElement: (tag) => makeNode(tag),
  createTextNode: (text) => ({ tagName: '#text', textContent: text, children: [] }),
  getElementById: (id) =>
    id === 'effectDialog' ? effectDialog : id === 'effectDialogBody' ? effectDialogBody : null,
};

/** Everything currently observed, which is the number this file exists to check. */
const observed = new Set();
globalThis.IntersectionObserver = class {
  constructor() {
    this.targets = new Set();
  }
  observe(target) {
    this.targets.add(target);
    observed.add(target);
  }
  unobserve(target) {
    this.targets.delete(target);
    observed.delete(target);
  }
  disconnect() {
    for (const target of this.targets) observed.delete(target);
    this.targets.clear();
  }
};

// The frame loop is not what is being tested, and running it would want a real
// canvas. Handing back a token nothing ever calls is enough.
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

const { openEffectPicker, effectLabel } = await import('../js/control/effectPicker.js');
const { listEffects, getEffect } = await import('../js/effects/registry.js');

/* ------------------------------------------------------------------ *
 * Walking the built page
 * ------------------------------------------------------------------ */

function walk(node, out = []) {
  out.push(node);
  for (const child of node.children || []) walk(child, out);
  return out;
}

const cardsOnPage = () => walk(effectDialogBody).filter((n) => /(^| )effect-card/.test(n.className));
const searchBox = () => walk(effectDialogBody).find((n) => n.attributes?.type === 'search');
const type = (query) => {
  const box = searchBox();
  box.value = query;
  box.fire('input');
};

/* ------------------------------------------------------------------ *
 * Opening it
 * ------------------------------------------------------------------ */

console.log('— the gallery —');

let picked = null;
openEffectPicker({ current: 'fill', closed: true, onPick: (id) => { picked = id; } });

const total = listEffects().length;
ok('every effect in the library gets a card', cardsOnPage().length === total,
  `${cardsOnPage().length} cards for ${total} effects`);
ok('and every card is being watched', observed.size === cardsOnPage().length,
  `${observed.size} observed`);
ok('the dialog is open', effectDialog.open === true);

/* ------------------------------------------------------------------ *
 * Searching it
 * ------------------------------------------------------------------ */

console.log('\n— searching —');

type('fire');
const fireCards = cardsOnPage().length;
ok('a query narrows the gallery', fireCards > 0 && fireCards < total, `${fireCards} of ${total}`);
ok('and the cards that went are no longer watched', observed.size === fireCards,
  `${observed.size} observed, ${fireCards} on the page`);

/**
 * The one that was wrong.
 *
 * Typing is one rebuild per keystroke, and without letting go of the previous
 * set each one added its whole card list to the observer for good. Four letters
 * of "snow" used to leave four times the cards being watched; the count below
 * is the count of cards that exist.
 */
for (const query of ['s', 'sn', 'sno', 'snow']) type(query);
const snowCards = cardsOnPage().length;
ok('typing a word letter by letter leaves one set of cards, not four',
  observed.size === snowCards, `${observed.size} observed, ${snowCards} on the page`);

type('');
ok('clearing the box brings the whole library back', cardsOnPage().length === total);
ok('with nothing left over from the searches', observed.size === total, `${observed.size}`);

type('zzzznothing');
ok('a query that matches nothing shows no cards', cardsOnPage().length === 0);
ok('and watches nothing', observed.size === 0, `${observed.size}`);
ok('but says so rather than showing an empty box',
  walk(effectDialogBody).some((n) => /Nothing matches/.test(n.textContent || '')));

/* ------------------------------------------------------------------ *
 * Closing it
 * ------------------------------------------------------------------ */

console.log('\n— picking one, and closing —');

type('snow');
const snowCard = cardsOnPage()[0];
snowCard.fire('click');
ok('clicking a card reports an effect that exists', !!picked && !!getEffect(picked), String(picked));
ok('and closes the dialog', effectDialog.open === false);
ok('and stops watching everything', observed.size === 0, `${observed.size}`);

// Opened and shut again: the second visit must not inherit the first's cards.
picked = null;
openEffectPicker({ current: null, closed: false, onPick: (id) => { picked = id; } });
ok('a second visit starts from one set of cards', observed.size === cardsOnPage().length,
  `${observed.size} observed, ${cardsOnPage().length} on the page`);
effectDialog.close();
ok('and dismissing it with Escape lets go of them too', observed.size === 0, `${observed.size}`);

ok('an effect id reads back as the name a human picked it by',
  effectLabel('fill') === getEffect('fill').name, effectLabel('fill'));
ok('and an id that is not an effect reads back as itself',
  effectLabel('no-such-effect') === 'no-such-effect');

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
