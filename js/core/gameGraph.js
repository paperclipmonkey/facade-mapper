/**
 * The dare game, drawn.
 *
 * Every arrow on this picture is a row of the table in core/game.js, so the
 * picture cannot describe a game the runtime does not play. What is laid out
 * by hand is only *where* things go: automatic graph layout makes a different
 * tangle every time a transition is added, and this is a picture people learn
 * by position — the street on the left, the front door on the right, the
 * ladder climbing along the middle — the way they learn a floor plan.
 *
 * It is a string of SVG rather than DOM, so the control tab, the remote and the
 * tests all draw it the same way, and a test can look at it without a browser.
 *
 * Live, it answers the question you have while testing on the path: *what
 * would this button do right now?* The current state is lit, every way out of
 * it is drawn bright with the press that takes it, and the last move made is
 * marked so a press that did something can be told from one that was dropped.
 */

import { STATES, TRANSITIONS, EVENT_LABELS, ROLE_LABELS, guardPasses, guardPossible, topLevel } from './game.js';

const COL = 252;
const ROW = 118;
const NODE_W = 164;
const NODE_H = 70;
const PAD_X = 24;
const PAD_TOP = 56;
const PAD_BOTTOM = 86;

/**
 * Where each state sits, in grid cells.
 *
 * Columns run from the street to the house: the house waits on the left, the
 * tricks and questions are on the path in the middle, and the door is on the
 * right. The middle row is the way through; above it is the house arguing,
 * below it the goodbye and the walk home.
 */
export const LAYOUT = {
  attract: [0, 1],
  cooldown: [0, 2],
  persuade: [1, 0],
  ask: [2, 0],
  scare: [2, 1],
  approach: [3, 1],
  finale: [4, 1],
  reward: [3, 2],
  waiting: [4, 2],
};

/**
 * Edges that cannot go in a straight line without crossing a state.
 *
 * Waypoints in grid cells. Anything not listed is drawn as a gentle curve,
 * bent to its own left so that a pair going both ways — a trick and the
 * question after it — reads as two arrows rather than one line with two heads.
 */
const ROUTES = {
  // Along the gap under the middle row.
  'attract>approach': [[0.6, 1.47], [2.6, 1.47]],
  'approach>attract': [[3, 1.62], [0.45, 1.62]],
};

const COLS = 5;
const ROWS = 3;
export const GRAPH_SIZE = {
  w: PAD_X * 2 + (COLS - 1) * COL + NODE_W,
  h: PAD_TOP + (ROWS - 1) * ROW + NODE_H + PAD_BOTTOM,
};

const center = ([col, row]) => ({
  x: PAD_X + NODE_W / 2 + col * COL,
  y: PAD_TOP + NODE_H / 2 + row * ROW,
});

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const fixed = (n) => Math.round(n * 10) / 10;

/** Where the line from a state's centre towards `toward` leaves its box. */
function boxExit(c, toward, pad = 4) {
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (!dx && !dy) return { ...c };
  const sx = dx ? (NODE_W / 2 + pad) / Math.abs(dx) : Infinity;
  const sy = dy ? (NODE_H / 2 + pad) / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: c.x + dx * s, y: c.y + dy * s };
}

function arrowHead(tip, from, size = 9) {
  const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
  const a1 = angle + Math.PI * 0.84;
  const a2 = angle - Math.PI * 0.84;
  const p = (a) => `${fixed(tip.x + Math.cos(a) * size)},${fixed(tip.y + Math.sin(a) * size)}`;
  return `${fixed(tip.x)},${fixed(tip.y)} ${p(a1)} ${p(a2)}`;
}

const GUARD_SHORT = {
  more: 'more tricks',
  door: '',
  opening: '',
  closed: '',
  'opening-plead': '',
  'first-plead': '',
  plead: 'try again',
}

/**
 * The arrows: table rows grouped by where they go, so "YES or NO" from Attract
 * is one arrow with both presses on it rather than two lines drawn on top of
 * each other.
 */
export function graphEdges() {
  const groups = new Map();
  for (const t of TRANSITIONS) {
    if (t.quiet) continue;
    const key = `${t.from}>${t.to}`;
    if (!groups.has(key)) groups.set(key, { key, from: t.from, to: t.to, rows: [] });
    groups.get(key).rows.push(t);
  }
  return [...groups.values()];
}

function edgeLabel(rows) {
  const parts = [];
  for (const row of rows) {
    // A guarded timeout is named by its guard alone: "next rung" already says
    // the scare ended, and the gap between two boxes is only so wide.
    let text = EVENT_LABELS[row.on] || row.on;
    const guard = row.when ? GUARD_SHORT[row.when] ?? row.when : '';
    if (guard) text = row.on === 'timeout' ? guard : `${text} · ${guard}`;
    if (!parts.includes(text)) parts.push(text);
  }
  return parts.join(' / ');
}

/** The second line of a state's box: what it shows and for how long. */
function describe(state, game, names) {
  const def = STATES[state];
  const timing = game?.timing || {};
  const parts = [];
  const name = names?.[state];
  if (name) parts.push(name);
  if (def.timer && Number(timing[def.timer]) > 0) parts.push(`${timing[def.timer]} s`);
  return parts.join(' · ');
}

/**
 * Draw the machine.
 *
 * @param {object} options
 * @param {object} options.game  At least `door`, `rungs` (or `rungCount`) and `timing`.
 * @param {object} [options.snapshot]  The runtime's snapshot, to light it up.
 *   Without one this is the static diagram of the game as configured.
 * @param {object} [options.names]  Per state, what it shows: a scene or trigger
 *   name, so the boxes describe *this* show rather than the abstract machine.
 * @param {object} [options.missing]  Per state, true when it has nothing to show.
 * @param {object} [options.words]  Per state, what it says on the wall. Shown in
 *   quotes in place of the scene's name: the words are what make the tree read
 *   as a game rather than a list of scenes.
 * @param {object} [options.notes]  Per state, a third line — "words first", say.
 * @param {string} [options.selected]  The state being edited, outlined.
 */
export function renderGameGraph({ game = {}, snapshot = null, names = {}, missing = {}, words = {}, notes = {}, selected = null } = {}) {
  const live = snapshot && snapshot.enabled !== false ? snapshot : null;
  const current = live?.state || null;
  const level = live?.level || 1;
  const rungCount = game.rungCount ?? game.rungs?.length ?? 0;
  const shape = { ...game, rungs: { length: rungCount } };
  const top = topLevel(shape);
  const last = live?.last && live.last.ago < 12 ? live.last : null;

  const out = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" class="gg" viewBox="0 0 ${GRAPH_SIZE.w} ${GRAPH_SIZE.h}" ` +
      `role="img" aria-label="The dare game: states and the presses that move between them">`
  );

  // The way a group walks, which is the way to read it.
  const headY = 22;
  const pathLeft = center(LAYOUT.ask).x - NODE_W / 2;
  const pathRight = center(LAYOUT.approach).x + NODE_W / 2;
  out.push(`<g class="gg-zones">`);
  out.push(`<text class="gg-zone" x="${center(LAYOUT.attract).x}" y="${headY}" text-anchor="middle">STREET</text>`);
  out.push(
    `<text class="gg-zone" x="${(pathLeft + pathRight) / 2}" y="${headY}" text-anchor="middle">PATH — far enough back to read</text>`
  );
  out.push(
    `<text class="gg-zone gg-zone-door" x="${center(LAYOUT.finale).x}" y="${headY}" text-anchor="middle">DOOR — too close for words</text>`
  );
  out.push(
    `<line class="gg-zone-rule" x1="${pathLeft}" x2="${pathRight}" y1="${headY + 10}" y2="${headY + 10}" />`
  );
  out.push(`</g>`);

  // Arrows first, so the boxes sit on top of their ends.
  const labels = [];
  out.push(`<g class="gg-edges">`);
  for (const edge of graphEdges()) {
    const a = center(LAYOUT[edge.from]);
    const b = center(LAYOUT[edge.to]);
    // Could this arrow ever be taken in this game? Not "top rung, no door"
    // while the door is on, and not "next rung" on a ladder of one.
    const applicable = edge.rows.some((row) => guardPossible(row.when, shape));
    const fromCurrent = current === edge.from;
    const takeable = fromCurrent && edge.rows.some((row) => guardPasses(row.when, shape, level, live?.attempt || 0));
    const justTaken = last && last.from === edge.from && last.to === edge.to;

    const cls = ['gg-edge'];
    if (!applicable) cls.push('gg-off');
    if (current && !fromCurrent) cls.push('gg-dim');
    if (takeable) cls.push('gg-live');
    if (justTaken) cls.push('gg-last');

    let d;
    let tipFrom;
    let tip;
    let mid;
    const route = ROUTES[edge.key];
    if (edge.from === edge.to) {
      // Back to itself — "ask again" — as a loop off the right-hand side.
      const right = a.x + NODE_W / 2;
      const start = { x: right, y: a.y - 14 };
      tip = { x: right + 3, y: a.y + 14 };
      tipFrom = { x: right + 40, y: a.y + 30 };
      d = `M${fixed(start.x)},${fixed(start.y)} C${fixed(right + 44)},${fixed(a.y - 40)} ${fixed(right + 44)},${fixed(a.y + 40)} ${fixed(tip.x)},${fixed(tip.y)}`;
      mid = { x: right + 40, y: a.y };
    } else if (route) {
      const points = route.map(([col, row]) => ({
        x: PAD_X + NODE_W / 2 + col * COL,
        y: PAD_TOP + NODE_H / 2 + row * ROW,
      }));
      const start = boxExit(a, points[0]);
      tip = boxExit(b, points[points.length - 1]);
      tipFrom = points[points.length - 1];
      const all = [start, ...points, tip];
      d = `M${all.map((p) => `${fixed(p.x)},${fixed(p.y)}`).join(' L')}`;
      const m0 = all[Math.floor((all.length - 1) / 2)];
      const m1 = all[Math.floor((all.length - 1) / 2) + 1];
      mid = { x: (m0.x + m1.x) / 2, y: (m0.y + m1.y) / 2 };
    } else {
      // Bend to the left of the direction of travel.
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const nx = (b.y - a.y) / len;
      const ny = -(b.x - a.x) / len;
      const bend = 16;
      const control = { x: (a.x + b.x) / 2 + nx * bend * 2, y: (a.y + b.y) / 2 + ny * bend * 2 };
      const start = boxExit(a, control);
      tip = boxExit(b, control);
      tipFrom = control;
      d = `M${fixed(start.x)},${fixed(start.y)} Q${fixed(control.x)},${fixed(control.y)} ${fixed(tip.x)},${fixed(tip.y)}`;
      // The point halfway along a quadratic.
      mid = {
        x: 0.25 * start.x + 0.5 * control.x + 0.25 * tip.x,
        y: 0.25 * start.y + 0.5 * control.y + 0.25 * tip.y,
      };
    }

    out.push(
      `<g class="${cls.join(' ')}" data-from="${edge.from}" data-to="${edge.to}">` +
        `<path d="${d}" />` +
        `<polygon points="${arrowHead(tip, tipFrom)}" />` +
        `</g>`
    );
    labels.push({ text: edgeLabel(edge.rows), mid, cls });
  }
  out.push(`</g>`);

  // Labels after every line, so no arrow is drawn through somebody else's words.
  out.push(`<g class="gg-labels">`);
  for (const label of labels) {
    const width = label.text.length * 6.2 + 10;
    out.push(
      `<g class="${label.cls.join(' ').replace(/gg-edge/, 'gg-label')}">` +
        `<rect x="${fixed(label.mid.x - width / 2)}" y="${fixed(label.mid.y - 9)}" width="${fixed(width)}" height="17" rx="8" />` +
        `<text x="${fixed(label.mid.x)}" y="${fixed(label.mid.y + 4)}" text-anchor="middle">${esc(label.text)}</text>` +
        `</g>`
    );
  }
  out.push(`</g>`);

  out.push(`<g class="gg-nodes">`);
  for (const [state, cell] of Object.entries(LAYOUT)) {
    const def = STATES[state];
    const c = center(cell);
    const x = c.x - NODE_W / 2;
    const y = c.y - NODE_H / 2;
    const cls = ['gg-node', `gg-zone-${def.zone}`];
    if (state === current) cls.push('gg-current');
    else if (current) cls.push('gg-dim');
    if (last && last.to === state && state !== current) cls.push('gg-was');
    if (missing[state]) cls.push('gg-missing');
    if (state === 'approach' && !game.door) cls.push('gg-off');
    if (state === selected) cls.push('gg-selected');

    let title = def.label;
    if (def.levelled && !def.staged) title += state === current ? ` ${level}/${top}` : ` ×${top}`;
    const said = words[state] ? `“${String(words[state]).replace(/\s*\n\s*/g, ' ')}”` : '';
    const sub = said || describe(state, game, names);
    let foot = '';
    if (state === current && live?.saying) {
      foot = `saying “${String(live.saying.text).replace(/\s*\n\s*/g, ' ')}”`;
    } else if (state === current && live?.remaining !== null && live?.remaining !== undefined) {
      foot = `${Math.ceil(live.remaining)} s left`;
    } else if (missing[state]) {
      foot = 'nothing set';
    } else if (notes[state]) {
      foot = notes[state];
    }

    out.push(
      `<g class="${cls.join(' ')}" data-state="${state}" tabindex="0">` +
        `<title>${esc(`${def.label} — ${def.note}`)}</title>` +
        `<rect x="${x}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="10" />` +
        `<rect class="gg-stripe" x="${x}" y="${y}" width="5" height="${NODE_H}" rx="2" />` +
        `<text class="gg-title" x="${x + 14}" y="${y + 22}">${esc(title)}</text>` +
        `<text class="gg-sub${said ? ' gg-words' : ''}" x="${x + 14}" y="${y + 40}">${esc(clip(sub, 26))}</text>` +
        (foot ? `<text class="gg-foot" x="${x + 14}" y="${y + 58}">${esc(clip(foot, 28))}</text>` : '') +
        `</g>`
    );
  }
  out.push(`</g>`);

  // The arrows not drawn, said once.
  const legendY = GRAPH_SIZE.h - 18;
  out.push(
    `<text class="gg-legend" x="${PAD_X}" y="${legendY}">` +
      `${ROLE_LABELS.treat} from any moment of a visit goes to Happy Halloween. ` +
      `Orange edge: on the path, words work. Blue: at the door, sound and light only. ` +
      `</text>`
  );

  out.push(`</svg>`);
  return out.join('');
}

function clip(text, max) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * A button that presses on the way down and holds after a while, like a
 * Matter button: `initial_press` at once, `long_press` if it is still down.
 *
 * The one piece of DOM in this file. It lives here because both pages that
 * draw the game also need a NO you can hold to stop a trick, and the remote does
 * not load the control tab's modules.
 */
export function holdable(button, onPress, onHold, holdMs = 800) {
  let timer = null;
  const up = () => {
    clearTimeout(timer);
    timer = null;
    button.classList.remove('held');
  };
  button.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    onPress();
    clearTimeout(timer);
    timer = setTimeout(() => {
      button.classList.add('held');
      onHold();
    }, holdMs);
  });
  for (const event of ['pointerup', 'pointercancel', 'pointerleave']) button.addEventListener(event, up);
  // A keyboard press is a press; there is no holding a key down for long.
  button.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      onPress();
    }
  });
}
