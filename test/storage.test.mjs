/**
 * Where the show is kept.
 *
 * The project lives in localStorage, and that is the whole of the app's
 * persistence: once the projectors are aligned, reopening the page has to give
 * you back the mapping you stood outside in the dark to get. Nothing here is
 * clever, and everything here is unforgiving — a project written over is a
 * project gone, with no server copy and no undo across a reload.
 *
 * Which is what makes the import path worth testing. It is the one place that
 * writes a project somebody did *not* just have open, under an id it works out
 * for itself, and it had exactly one collision's worth of headroom: importing
 * the same file twice landed on the same id both times, so the second import
 * silently replaced the first and everything done to it since.
 *
 * localStorage is a stand-in — a Map behind the four methods used — which is
 * enough to run the real module.
 *
 *   node test/storage.test.mjs
 */

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

/* ------------------------------------------------------------------ *
 * A stand-in for localStorage
 * ------------------------------------------------------------------ */

const store = new Map();
/** Set to a message to make every write fail, as a full disk does. */
let refuseWrites = null;

globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => {
    if (refuseWrites) throw new Error(refuseWrites);
    store.set(key, String(value));
  },
  removeItem: (key) => store.delete(key),
  key: (i) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
};

const {
  saveProject, loadProject, loadOrCreateProject, listProjects, deleteProject,
  setCurrentProjectId, storageUsage, getPref, setPref, importProjectFile,
} = await import('../js/core/storage.js');
const { createProject, createLayer, createShape } = await import('../js/core/state.js');

/** A file as the import path sees one. */
const asFile = (project) => ({ text: async () => JSON.stringify(project) });

const show = (id, name) => {
  const project = createProject(name);
  project.id = id;
  project.shapes = [createShape([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], { id: 'w1' })];
  project.layers = [createLayer('fill', { id: 'l1', name: 'Wash', targets: ['w1'] })];
  return project;
};

/* ------------------------------------------------------------------ *
 * Saving and loading
 * ------------------------------------------------------------------ */

console.log('— a show, saved and reopened —');
{
  const project = show('proj_a', 'The house');
  const result = saveProject(project);
  ok('saving reports success', result.ok === true);
  ok('and stamps when it happened', project.updatedAt > 0);

  const back = loadProject('proj_a');
  ok('it comes back', back?.id === 'proj_a' && back.name === 'The house');
  ok('with its shapes', back.shapes.length === 1 && back.shapes[0].id === 'w1');
  ok('and its layers pointing where they did', back.layers[0].targets[0] === 'w1');

  ok('saving makes it the current one', loadProject()?.id === 'proj_a');
  ok('a project nobody saved is not there', loadProject('proj_nope') === null);
}

{
  const second = show('proj_b', 'The other house');
  saveProject(second);
  const index = listProjects();
  ok('both shows are listed', index.length === 2, index.map((e) => e.id).join(', '));
  ok('most recently saved first', index[0].id === 'proj_b');

  saveProject(loadProject('proj_a'));
  ok('and saving one again moves it to the front', listProjects()[0].id === 'proj_a');
  ok('without duplicating it', listProjects().filter((e) => e.id === 'proj_a').length === 1);
}

/* ------------------------------------------------------------------ *
 * Importing
 * ------------------------------------------------------------------ */

console.log('\n— importing somebody else\'s show —');
{
  const shared = show('proj_shared', 'A friend’s show');
  const fresh = await importProjectFile(asFile(shared));
  ok('an id nobody is using is left alone', fresh.id === 'proj_shared');
  ok('and so is the name', fresh.name === 'A friend’s show');
  saveProject(fresh);

  const first = await importProjectFile(asFile(shared));
  ok('importing over one already here renames it', first.id === 'proj_shared_imported', first.id);
  ok('and says so', /\(imported\)$/.test(first.name), first.name);

  // The edit that used to disappear.
  first.layers[0].name = 'I changed this one';
  saveProject(first);

  const second = await importProjectFile(asFile(shared));
  ok('importing the same file again finds another id',
    second.id === 'proj_shared_imported_2', second.id);
  ok('and numbers the name so the two can be told apart',
    /\(imported 2\)$/.test(second.name), second.name);
  saveProject(second);

  ok('so the first import is still there, with what was done to it',
    loadProject('proj_shared_imported')?.layers[0].name === 'I changed this one');

  const third = await importProjectFile(asFile(shared));
  ok('and it keeps going', third.id === 'proj_shared_imported_3', third.id);

  ok('all of them are in the list', listProjects().filter((e) => e.id.startsWith('proj_shared')).length === 3,
    listProjects().map((e) => e.id).join(', '));
}

{
  /**
   * The index is capped, so a project can be in storage with no entry in it.
   * A collision with one of those is invisible right up until it happens.
   */
  const orphan = show('proj_orphan', 'Off the end of the index');
  saveProject(orphan);
  localStorage.removeItem('facade-mapper/index');
  const imported = await importProjectFile(asFile(orphan));
  ok('a project the index has forgotten is still not written over',
    imported.id !== 'proj_orphan', imported.id);
  ok('and the one in storage is untouched', loadProject('proj_orphan')?.name === 'Off the end of the index');
}

{
  const raw = { name: 'From an older version', layers: [{ id: 'l9', effect: null }] };
  const migrated = await importProjectFile(asFile(raw));
  ok('an imported file goes through the migration like any other',
    migrated.layers[0].effect === 'fill' && Array.isArray(migrated.projectors));
}

/* ------------------------------------------------------------------ *
 * Deleting
 * ------------------------------------------------------------------ */

console.log('\n— deleting one —');
{
  saveProject(show('proj_temp', 'Temporary'));
  ok('it is current after saving', loadProject()?.id === 'proj_temp');
  deleteProject('proj_temp');
  ok('deleting removes it from the list', !listProjects().some((e) => e.id === 'proj_temp'));
  ok('and from storage', loadProject('proj_temp') === null);
  ok('and stops it being the current one', loadProject()?.id !== 'proj_temp');
  ok('deleting one that is not there is not an error',
    (deleteProject('proj_never'), true));

  setCurrentProjectId('proj_a');
  ok('the current one can be pointed elsewhere', loadProject()?.id === 'proj_a');
}

/* ------------------------------------------------------------------ *
 * When there is no room left
 * ------------------------------------------------------------------ */

console.log('\n— a full disk —');
{
  refuseWrites = 'QuotaExceededError';
  // The module is supposed to say so on the console as well; captured rather
  // than left to print in the middle of the run.
  const complaints = [];
  const realError = console.error;
  console.error = (...args) => complaints.push(args.join(' '));
  const result = saveProject(show('proj_big', 'Too big'));
  console.error = realError;
  refuseWrites = null;

  ok('a refused write is reported rather than swallowed', result.ok === false);
  ok('and complained about where somebody debugging would see it',
    complaints.some((line) => /failed to write/.test(line)));
  ok('and the message says what to do about it',
    /storage is full/i.test(result.error) && /remove|drop/i.test(result.error), result.error);
  ok('and nothing half-written is left in the list',
    !listProjects().some((e) => e.id === 'proj_big'));
}

/* ------------------------------------------------------------------ *
 * Per-tab preferences
 * ------------------------------------------------------------------ */

console.log('\n— preferences, which are this tab\'s alone —');
{
  ok('an unset preference gives the fallback', getPref('nothing', 'fallback') === 'fallback');
  setPref('panel', 'layers');
  ok('a set one comes back', getPref('panel', 'shapes') === 'layers');

  /**
   * `false` and `0` are answers, not absences. A fallback that overrode them
   * would make a switch impossible to turn off and a slider impossible to zero.
   */
  setPref('showNames', false);
  ok('false survives the round trip', getPref('showNames', true) === false);
  setPref('opacity', 0);
  ok('and so does zero', getPref('opacity', 1) === 0);
  setPref('shape', { w: 3, h: 4 });
  ok('and an object', getPref('shape').w === 3);

  ok('preferences are not projects', !listProjects().some((e) => e.id === 'panel'));
}

{
  const bytes = storageUsage();
  ok('storage usage is a number of bytes', bytes > 0 && Number.isFinite(bytes), `${bytes}`);
  // Only this app's keys: something else on the origin is not the app's problem.
  localStorage.setItem('somebody-elses-key', 'x'.repeat(5000));
  ok('and counts only what this app put there', storageUsage() === bytes,
    `${storageUsage()} vs ${bytes}`);
}

{
  store.clear();
  const made = loadOrCreateProject();
  ok('with nothing saved at all, a new show is made', !!made.id && made.layers.length === 0);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
