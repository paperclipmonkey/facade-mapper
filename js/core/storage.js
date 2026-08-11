/**
 * Persistence.
 *
 * Two stores, chosen deliberately:
 *
 *   localStorage - the project JSON (geometry, calibration, effects, scenes).
 *                  Small, synchronous, trivially exportable, and shared across
 *                  tabs on the same origin. This is the bit that matters: once
 *                  the projectors are aligned, reopening the page restores the
 *                  mapping without touching anything.
 *
 *   IndexedDB    - bulky binaries (video/image media, camera reference stills).
 *                  These would blow the ~5 MB localStorage budget instantly, and
 *                  Blobs stored here are readable from every tab, which is how
 *                  projector tabs get at media the control tab imported.
 */

import { migrateProject, createProject } from './state.js';

const LS_PREFIX = 'facade-mapper/';
const LS_CURRENT = `${LS_PREFIX}current`;
const LS_PROJECT = (id) => `${LS_PREFIX}project/${id}`;
const LS_INDEX = `${LS_PREFIX}index`;

const DB_NAME = 'facade-mapper';
const DB_VERSION = 1;
const STORE_BLOBS = 'blobs';

/* ------------------------------------------------------------------ *
 * Project index (so you can keep a Halloween show and a Christmas show)
 * ------------------------------------------------------------------ */

function readJson(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    console.warn('[storage] failed to read', key, err);
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    // Quota is the realistic failure here; surface it rather than silently losing work.
    console.error('[storage] failed to write', key, err);
    return false;
  }
}

export function listProjects() {
  const index = readJson(LS_INDEX, []);
  return Array.isArray(index) ? index : [];
}

function updateIndex(project) {
  const index = listProjects().filter((e) => e.id !== project.id);
  index.unshift({ id: project.id, name: project.name, updatedAt: project.updatedAt });
  writeJson(LS_INDEX, index.slice(0, 50));
}

export function saveProject(project) {
  project.updatedAt = Date.now();
  const ok = writeJson(LS_PROJECT(project.id), project);
  if (!ok) {
    return {
      ok: false,
      error:
        'Local storage is full. Remove a saved show, or drop the traced camera still (Settings > Clear reference image).',
    };
  }
  updateIndex(project);
  localStorage.setItem(LS_CURRENT, project.id);
  return { ok: true };
}

export function loadProject(id) {
  const target = id || localStorage.getItem(LS_CURRENT);
  if (!target) return null;
  const raw = readJson(LS_PROJECT(target));
  return raw ? migrateProject(raw) : null;
}

export function loadOrCreateProject() {
  return loadProject() || createProject('My house');
}

export function deleteProject(id) {
  localStorage.removeItem(LS_PROJECT(id));
  writeJson(LS_INDEX, listProjects().filter((e) => e.id !== id));
  if (localStorage.getItem(LS_CURRENT) === id) localStorage.removeItem(LS_CURRENT);
}

export function setCurrentProjectId(id) {
  localStorage.setItem(LS_CURRENT, id);
}

/** Rough byte count of what we're holding in localStorage, for the settings panel. */
export function storageUsage() {
  let bytes = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(LS_PREFIX)) continue;
    bytes += k.length + (localStorage.getItem(k)?.length || 0);
  }
  return bytes * 2; // UTF-16 code units
}

/* ------------------------------------------------------------------ *
 * Per-tab local preferences (not part of the shared project)
 * ------------------------------------------------------------------ */

export function getPref(key, fallback = null) {
  const v = readJson(`${LS_PREFIX}pref/${key}`);
  return v === null ? fallback : v;
}

export function setPref(key, value) {
  writeJson(`${LS_PREFIX}pref/${key}`, value);
}

/* ------------------------------------------------------------------ *
 * IndexedDB
 * ------------------------------------------------------------------ */

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_BLOBS)) db.createObjectStore(STORE_BLOBS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    try {
      result = fn(s);
    } catch (err) {
      reject(err);
      return;
    }
    t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function putBlob(key, blob) {
  await tx(STORE_BLOBS, 'readwrite', (s) => s.put(blob, key));
  return key;
}

export async function getBlob(key) {
  const req = await tx(STORE_BLOBS, 'readonly', (s) => s.get(key));
  return req ?? null;
}

export async function deleteBlob(key) {
  await tx(STORE_BLOBS, 'readwrite', (s) => s.delete(key));
}

/** How much disk the browser will let us have, and how much we've used. */
export async function estimateQuota() {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage, quota };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Import / export
 * ------------------------------------------------------------------ */

export function exportProjectFile(project) {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safe = (project.name || 'show').replace(/[^\w-]+/g, '-').toLowerCase();
  a.href = url;
  a.download = `${safe}.facade.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function importProjectFile(file) {
  const text = await file.text();
  const raw = JSON.parse(text);
  const project = migrateProject(raw);
  // Importing must not clobber a project already in storage under the same id.
  if (listProjects().some((e) => e.id === project.id)) {
    project.id = `${project.id}_imported`;
    project.name = `${project.name} (imported)`;
  }
  return project;
}
