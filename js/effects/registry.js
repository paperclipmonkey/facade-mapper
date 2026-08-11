/**
 * Effect registry.
 *
 * An effect is a plain object with a `params` schema and a `draw(ctx)` function.
 * Built-ins are imported statically (no build step, so the list is explicit);
 * user effects are compiled at runtime from source held in the project, which is
 * what lets you write a new effect in the control tab and have every projector
 * tab pick it up without a reload.
 *
 * The contract handed to `draw` is documented in the Help panel and the README;
 * the starter template lives in js/control/help.js.
 */

import basic from './builtin/basic.js';
import paths from './builtin/paths.js';
import halloween from './builtin/halloween.js';
import christmas from './builtin/christmas.js';
import text from './builtin/text.js';
import mediaEffects from './builtin/media.js';

export const CATEGORIES = ['basic', 'path', 'halloween', 'christmas', 'text', 'media', 'custom'];

const builtins = new Map();
for (const list of [basic, paths, halloween, christmas, text, mediaEffects]) {
  for (const def of list) builtins.set(def.id, normaliseEffect(def, true));
}

/** Fill in optional fields so consumers never have to null-check. */
function normaliseEffect(def, isBuiltin = false) {
  return {
    id: def.id,
    name: def.name || def.id,
    category: def.category || 'custom',
    description: def.description || '',
    /** 'shape' draws once per target; 'global' draws once over the whole frame. */
    scope: def.scope || 'shape',
    /** Effects that light a whole area look wrong stroked, and vice versa. */
    params: Array.isArray(def.params) ? def.params : [],
    init: typeof def.init === 'function' ? def.init : null,
    draw: typeof def.draw === 'function' ? def.draw : () => {},
    builtin: isBuiltin,
  };
}

/* ------------------------------------------------------------------ *
 * User effects
 * ------------------------------------------------------------------ */

const userEffects = new Map();
const compileErrors = new Map();
let compileGeneration = 0;

/**
 * Compile a user module from source.
 *
 * A blob: URL plus dynamic import() gives real ES module semantics — imports of
 * the app's own helpers work, `export default` works, and syntax errors surface
 * with useful line numbers. `new Function` would be simpler but loses all three.
 */
const LIB_URL = new URL('./lib.js', import.meta.url).href;

async function compileUserEffect(record) {
  // Relative specifiers can't resolve from a blob: URL, so bind the helper
  // namespace with an absolute import. Appending it rather than prepending keeps
  // the user's line numbers intact in syntax errors — import declarations are
  // hoisted, so position in the file doesn't matter.
  const code = `${record.code || ''}\n;import * as fx from ${JSON.stringify(LIB_URL)};\n`;
  const blob = new Blob([code], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  try {
    const mod = await import(/* @vite-ignore */ url);
    const def = mod.default;
    if (!def || typeof def !== 'object') {
      throw new Error('Module must `export default` an effect object');
    }
    if (typeof def.draw !== 'function') {
      throw new Error('Effect object needs a draw(ctx) function');
    }
    const normalised = normaliseEffect({ ...def, id: record.id, category: def.category || 'custom' });
    normalised.name = def.name || record.name || record.id;
    return { ok: true, effect: normalised };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  } finally {
    // Revoke on the next turn: the import has already been fetched by then, and
    // revoking synchronously can race the module loader in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * Recompile every user effect in the project.
 *
 * Called on load and whenever the code changes in any tab. Returns a map of
 * id -> error message for anything that failed, so the editor can show it.
 */
export async function loadUserEffects(records = []) {
  const generation = ++compileGeneration;
  const results = await Promise.all(
    records.map(async (record) => ({ record, result: await compileUserEffect(record) }))
  );
  // A newer load started while we were compiling; discard these results.
  if (generation !== compileGeneration) return Object.fromEntries(compileErrors);

  userEffects.clear();
  compileErrors.clear();
  for (const { record, result } of results) {
    if (result.ok) {
      userEffects.set(record.id, result.effect);
    } else {
      compileErrors.set(record.id, result.error);
    }
  }
  return Object.fromEntries(compileErrors);
}

export function getCompileErrors() {
  return Object.fromEntries(compileErrors);
}

/* ------------------------------------------------------------------ *
 * Lookup
 * ------------------------------------------------------------------ */

export function getEffect(id) {
  return userEffects.get(id) || builtins.get(id) || null;
}

export function listEffects() {
  return [...builtins.values(), ...userEffects.values()];
}

export function listByCategory() {
  const grouped = new Map(CATEGORIES.map((c) => [c, []]));
  for (const e of listEffects()) {
    if (!grouped.has(e.category)) grouped.set(e.category, []);
    grouped.get(e.category).push(e);
  }
  for (const list of grouped.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return [...grouped.entries()].filter(([, list]) => list.length);
}

/** Default parameter object for a newly created layer. */
export function defaultParams(effectId) {
  const def = getEffect(effectId);
  if (!def) return {};
  const out = {};
  for (const p of def.params) out[p.key] = p.default;
  return out;
}
