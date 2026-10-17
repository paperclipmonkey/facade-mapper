/**
 * The automation, drawn.
 *
 * Every arrow on this picture is a button or a timer on a step, so it cannot
 * describe something the runtime will not do. The steps are laid out left to
 * right in the order they can be reached from the start: the start on the
 * left, and each column one press or timer further along.
 *
 * Going back to the start — every unanswered question does, after a while —
 * is not drawn as an arrow. Drawn, it is a fan of long lines from every box
 * back to the first, which says less than the note on each box does.
 *
 * It is a string of SVG rather than DOM, so the control tab, the remote and the
 * tests all draw it the same way, and a test can look at it without a browser.
 *
 * Live, it answers the question you have while testing on the path: *what
 * would this button do right now?* The current step is lit, every way out of
 * it is drawn bright with the press that takes it, and the last move made is
 * marked so a press that did something can be told from one that was dropped.
 */

import { EVENT_LABELS, startStep, stepById, exitsOf, timerSeconds } from './game.js';

const COL = 206;
const ROW = 96;
const NODE_W = 168;
const NODE_H = 64;
const PAD_X = 20;
const PAD_TOP = 44;
const PAD_BOTTOM = 28;

const fixed = (n) => Math.round(n * 10) / 10;

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** "2 min", "45 s", "1.5 s". */
export function formatSeconds(seconds) {
  const s = Number(seconds) || 0;
  if (s >= 60 && s % 60 === 0) return `${s / 60} min`;
  return `${Math.round(s * 10) / 10} s`;
}

/**
 * Where each step goes, in grid cells: `{ [id]: [col, row] }`.
 *
 * Breadth first from the start, ignoring the ways back to it, so a column is
 * "this many moves in". Steps nothing reaches are put in a column of their
 * own at the end, where they are easy to see and connect up.
 */
export function layoutSteps(game) {
  const steps = game?.steps || [];
  const start = startStep(game);
  const cells = {};
  if (!start) return cells;
  const columns = [];
  const place = (id, col) => {
    (columns[col] = columns[col] || []).push(id);
    cells[id] = [col, columns[col].length - 1];
  };
  place(start.id, 0);
  const queue = [start.id];
  while (queue.length) {
    const id = queue.shift();
    const [col] = cells[id];
    for (const { to } of exitsOf(game, stepById(game, id))) {
      if (to === start.id || cells[to]) continue;
      place(to, col + 1);
      queue.push(to);
    }
  }
  const orphanCol = columns.length;
  for (const step of steps) if (!cells[step.id]) place(step.id, orphanCol);
  return cells;
}

function center([col, row]) {
  return { x: PAD_X + NODE_W / 2 + col * COL, y: PAD_TOP + NODE_H / 2 + row * ROW };
}

/** Where the line from a box's centre towards `toward` leaves the box. */
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

/**
 * The arrows: every way out of every step except back to the start, grouped
 * by where they go, so "YES or NO" to the same step is one arrow with both
 * presses on it rather than two lines drawn on top of each other.
 */
export function graphEdges(game) {
  const start = startStep(game);
  const groups = new Map();
  for (const step of game?.steps || []) {
    for (const exit of exitsOf(game, step)) {
      if (start && exit.to === start.id && step.id !== start.id) continue;
      const key = `${step.id}>${exit.to}`;
      if (!groups.has(key)) groups.set(key, { key, from: step.id, to: exit.to, exits: [] });
      groups.get(key).exits.push(exit);
    }
  }
  return [...groups.values()];
}

function edgeLabel(game, edge) {
  const from = stepById(game, edge.from);
  return edge.exits
    .map((e) => (e.on === 'timeout' ? formatSeconds(timerSeconds(from)) : EVENT_LABELS[e.on] || e.on))
    .join(' / ');
}

/**
 * Draw the automation.
 *
 * @param {object} options
 * @param {object} options.game  The automation: `steps`, `start`.
 * @param {object} [options.snapshot]  The runtime's snapshot, to light it up.
 * @param {object} [options.names]  Per step id, the name of the scene it shows.
 * @param {string} [options.selected]  The step being edited, outlined.
 */
export function renderGameGraph({ game = {}, snapshot = null, names = {}, selected = null } = {}) {
  const steps = game.steps || [];
  const live = snapshot && snapshot.enabled !== false ? snapshot : null;
  const current = live?.step || null;
  const last = live?.last && live.last.ago < 12 ? live.last : null;
  const start = startStep(game);
  const cells = layoutSteps(game);

  const cols = Math.max(1, ...Object.values(cells).map(([c]) => c + 1));
  const rows = Math.max(1, ...Object.values(cells).map(([, r]) => r + 1));
  const w = PAD_X * 2 + (cols - 1) * COL + NODE_W;
  const h = PAD_TOP + (rows - 1) * ROW + NODE_H + PAD_BOTTOM;

  const out = [];
  out.push(
    // Never drawn bigger than it is: two steps should not fill the screen.
    `<svg xmlns="http://www.w3.org/2000/svg" class="gg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="max-width:${w}px" ` +
      `role="img" aria-label="The automation: its steps and the presses and timers that move between them">`
  );
  if (!steps.length) {
    out.push(`<text class="gg-legend" x="${PAD_X}" y="${PAD_TOP}">No steps yet.</text></svg>`);
    return out.join('');
  }

  // Arrows first, so the boxes sit on top of their ends.
  const labels = [];
  out.push(`<g class="gg-edges">`);
  for (const edge of graphEdges(game)) {
    if (!cells[edge.from] || !cells[edge.to]) continue;
    const a = center(cells[edge.from]);
    const b = center(cells[edge.to]);
    const fromCurrent = current === edge.from;
    const justTaken = last && last.from === edge.from && last.to === edge.to;

    const cls = ['gg-edge'];
    if (current && !fromCurrent) cls.push('gg-dim');
    if (fromCurrent) cls.push('gg-live');
    if (justTaken) cls.push('gg-last');

    let d;
    let tip;
    let tipFrom;
    let mid;
    if (edge.from === edge.to) {
      // Back to itself, as a loop off the right-hand side.
      const right = a.x + NODE_W / 2;
      tip = { x: right + 3, y: a.y + 14 };
      tipFrom = { x: right + 40, y: a.y + 30 };
      d = `M${fixed(right)},${fixed(a.y - 14)} C${fixed(right + 44)},${fixed(a.y - 40)} ${fixed(right + 44)},${fixed(a.y + 40)} ${fixed(tip.x)},${fixed(tip.y)}`;
      mid = { x: right + 36, y: a.y };
    } else if (cells[edge.to][0] > cells[edge.from][0]) {
      // Onwards: a gentle curve, bent to its own left so a pair going both
      // ways reads as two arrows.
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const nx = (b.y - a.y) / len;
      const ny = -(b.x - a.x) / len;
      const control = { x: (a.x + b.x) / 2 + nx * 24, y: (a.y + b.y) / 2 + ny * 24 };
      const s = boxExit(a, control);
      tip = boxExit(b, control);
      tipFrom = control;
      d = `M${fixed(s.x)},${fixed(s.y)} Q${fixed(control.x)},${fixed(control.y)} ${fixed(tip.x)},${fixed(tip.y)}`;
      mid = { x: 0.25 * s.x + 0.5 * control.x + 0.25 * tip.x, y: 0.25 * s.y + 0.5 * control.y + 0.25 * tip.y };
    } else {
      // Back along the line, or up or down the same column: over the top of
      // the boxes, so it does not run through any of them.
      const top = Math.min(a.y, b.y) - NODE_H / 2;
      const lift = 26 + Math.abs(cells[edge.to][0] - cells[edge.from][0]) * 6;
      const s = { x: a.x + (b.x < a.x ? -NODE_W / 4 : NODE_W / 4), y: a.y - NODE_H / 2 - 3 };
      tip = { x: b.x + (b.x < a.x ? NODE_W / 4 : -NODE_W / 4), y: b.y - NODE_H / 2 - 4 };
      const c1 = { x: s.x, y: top - lift };
      const c2 = { x: tip.x, y: top - lift };
      tipFrom = c2;
      d = `M${fixed(s.x)},${fixed(s.y)} C${fixed(c1.x)},${fixed(c1.y)} ${fixed(c2.x)},${fixed(c2.y)} ${fixed(tip.x)},${fixed(tip.y)}`;
      mid = { x: (s.x + tip.x) / 2, y: top - lift * 0.75 };
    }

    out.push(
      `<g class="${cls.join(' ')}" data-from="${esc(edge.from)}" data-to="${esc(edge.to)}">` +
        `<path d="${d}" />` +
        `<polygon points="${arrowHead(tip, tipFrom)}" />` +
        `</g>`
    );
    labels.push({ text: edgeLabel(game, edge), mid, cls });
  }
  out.push(`</g>`);

  // Labels after every line, so no arrow is drawn through somebody else's words.
  out.push(`<g class="gg-labels">`);
  for (const label of labels) {
    const width = label.text.length * 6.4 + 12;
    out.push(
      `<g class="${label.cls.join(' ').replace(/gg-edge/, 'gg-label')}">` +
        `<rect x="${fixed(label.mid.x - width / 2)}" y="${fixed(label.mid.y - 9)}" width="${fixed(width)}" height="17" rx="8" />` +
        `<text x="${fixed(label.mid.x)}" y="${fixed(label.mid.y + 4)}" text-anchor="middle">${esc(label.text)}</text>` +
        `</g>`
    );
  }
  out.push(`</g>`);

  out.push(`<g class="gg-nodes">`);
  for (const step of steps) {
    const cell = cells[step.id];
    if (!cell) continue;
    const c = center(cell);
    const x = c.x - NODE_W / 2;
    const y = c.y - NODE_H / 2;
    const cls = ['gg-node'];
    if (step === start) cls.push('gg-start');
    if (step.alert) cls.push('gg-alert');
    if (step.id === current) cls.push('gg-current');
    else if (current) cls.push('gg-dim');
    if (last && last.to === step.id && step.id !== current) cls.push('gg-was');
    if (step.id === selected) cls.push('gg-selected');

    const words = String(step.words || '').trim();
    const sub = words ? `“${words.replace(/\s*\n\s*/g, ' ')}”` : names[step.id] || (step.sceneId ? 'a scene' : 'keeps the house as it is');

    let foot = '';
    const seconds = timerSeconds(step);
    if (step.id === current && live?.remaining !== null && live?.remaining !== undefined) {
      foot = `${Math.ceil(live.remaining)} s left`;
    } else if (seconds && start && step.after.to === start.id && step !== start) {
      foot = `↺ to the start after ${formatSeconds(seconds)}`;
    } else if (step === start) {
      foot = 'start';
    }

    out.push(
      `<g class="${cls.join(' ')}" data-step="${esc(step.id)}" tabindex="0">` +
        `<title>${esc(step.name || 'Untitled')}</title>` +
        `<rect x="${x}" y="${y}" width="${NODE_W}" height="${NODE_H}" rx="10" />` +
        `<rect class="gg-stripe" x="${x}" y="${y}" width="5" height="${NODE_H}" rx="2" />` +
        `<text class="gg-title" x="${x + 14}" y="${y + 21}">${esc(clip(step.name || 'Untitled', 22))}</text>` +
        `<text class="gg-sub${words ? ' gg-words' : ''}" x="${x + 14}" y="${y + 38}">${esc(clip(sub, 26))}</text>` +
        (foot ? `<text class="gg-foot" x="${x + 14}" y="${y + 55}">${esc(clip(foot, 30))}</text>` : '') +
        `</g>`
    );
  }
  out.push(`</g>`);

  out.push(`</svg>`);
  return out.join('');
}

function clip(text, max) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
