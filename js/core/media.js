/**
 * Media library.
 *
 * Video and image files are stored as Blobs in IndexedDB, which is shared across
 * tabs on the same origin. That's the key detail: a blob: URL minted in the
 * control tab is useless in a projector tab, but the underlying Blob is not.
 * Each tab reads the bytes itself and makes its own URL.
 *
 * Nothing is uploaded anywhere — the files never leave the machine, and the repo
 * stays small enough for GitHub Pages.
 */

import { putBlob, getBlob, deleteBlob } from './storage.js';
import { uid } from './state.js';

const BLOB_KEY = (id) => `media/${id}`;

/**
 * Import a File into the library. Returns the metadata record to add to the
 * project; the bytes go to IndexedDB under a matching key.
 */
export async function importMediaFile(file) {
  const kind = file.type.startsWith('video')
    ? 'video'
    : file.type.startsWith('image')
      ? 'image'
      : null;
  if (!kind) throw new Error(`Unsupported file type: ${file.type || 'unknown'}`);

  const id = uid('media');
  await putBlob(BLOB_KEY(id), file);

  const entry = {
    id,
    name: file.name,
    kind,
    mime: file.type,
    size: file.size,
    duration: null,
    width: null,
    height: null,
    addedAt: Date.now(),
  };

  // Probe dimensions/duration so the UI can show something useful and effects
  // can letterbox correctly before the element is ready.
  try {
    Object.assign(entry, await probe(file, kind));
  } catch (err) {
    console.warn('[media] probe failed', file.name, err);
  }
  return entry;
}

function probe(file, kind) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const done = (result) => {
      URL.revokeObjectURL(url);
      resolve(result);
    };
    const fail = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };

    if (kind === 'video') {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      v.onloadedmetadata = () =>
        done({ duration: v.duration, width: v.videoWidth, height: v.videoHeight });
      v.onerror = () => fail(new Error('Could not read video metadata'));
      v.src = url;
    } else {
      const img = new Image();
      img.onload = () => done({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => fail(new Error('Could not read image'));
      img.src = url;
    }
  });
}

export async function removeMedia(id) {
  await deleteBlob(BLOB_KEY(id));
}

/**
 * Per-tab cache of decoded media elements.
 *
 * Videos are driven off show time rather than left free-running, so two
 * projectors covering the same wall stay frame-aligned, and pausing the show
 * pauses the footage.
 */
export function createMediaPool({ onError } = {}) {
  const entries = new Map(); // id -> { entry, el, url, ready, failed }
  let manifest = [];

  function sync(mediaList) {
    manifest = mediaList || [];
    const wanted = new Set(manifest.map((m) => m.id));
    for (const [id, rec] of entries) {
      if (!wanted.has(id)) {
        release(rec);
        entries.delete(id);
      }
    }
  }

  function release(rec) {
    if (rec.el) {
      try {
        rec.el.pause?.();
      } catch {
        /* ignore */
      }
      rec.el.removeAttribute?.('src');
      rec.el.load?.();
    }
    if (rec.url) URL.revokeObjectURL(rec.url);
  }

  function load(id) {
    const entry = manifest.find((m) => m.id === id);
    if (!entry) return null;

    let rec = entries.get(id);
    if (rec) return rec;

    rec = { entry, el: null, url: null, ready: false, failed: false };
    entries.set(id, rec);

    getBlob(BLOB_KEY(id))
      .then((blob) => {
        if (!blob) throw new Error(`Media "${entry.name}" is missing from local storage`);
        rec.url = URL.createObjectURL(blob);
        if (entry.kind === 'video') {
          const v = document.createElement('video');
          v.muted = true;
          v.loop = true;
          v.playsInline = true;
          v.preload = 'auto';
          v.crossOrigin = 'anonymous';
          v.oncanplay = () => {
            rec.ready = true;
          };
          v.onerror = () => {
            rec.failed = true;
            onError?.(`Could not decode video "${entry.name}"`);
          };
          v.src = rec.url;
          // Autoplay is permitted because the element is muted; if the browser
          // still blocks it, the show-time sync below will keep nudging it.
          v.play().catch(() => {});
          rec.el = v;
        } else {
          const img = new Image();
          img.onload = () => {
            rec.ready = true;
          };
          img.onerror = () => {
            rec.failed = true;
            onError?.(`Could not decode image "${entry.name}"`);
          };
          img.src = rec.url;
          rec.el = img;
        }
      })
      .catch((err) => {
        rec.failed = true;
        onError?.(err.message);
      });

    return rec;
  }

  /** Element for an effect to draw, or null if it isn't decoded yet. */
  function get(id) {
    const rec = load(id);
    return rec?.ready && !rec.failed ? rec.el : null;
  }

  function meta(id) {
    return manifest.find((m) => m.id === id) || null;
  }

  /**
   * Nudge every loaded video towards where show time says it should be.
   *
   * Small drift is corrected by playbackRate so there's no visible stutter;
   * only a large gap (a seek, a scene change, a tab that was backgrounded)
   * justifies a hard seek.
   */
  function syncPlayback(showTime, running) {
    for (const rec of entries.values()) {
      const v = rec.el;
      if (!rec.ready || rec.failed || !v || v.tagName !== 'VIDEO') continue;
      const duration = v.duration;
      if (!isFinite(duration) || duration <= 0) continue;

      if (!running) {
        if (!v.paused) v.pause();
        continue;
      }
      if (v.paused) v.play().catch(() => {});

      const target = ((showTime % duration) + duration) % duration;
      const drift = target - v.currentTime;
      const wrapped = Math.abs(drift) > duration / 2;

      if (wrapped || Math.abs(drift) > 0.35) {
        v.currentTime = target;
        v.playbackRate = 1;
      } else if (Math.abs(drift) > 0.03) {
        v.playbackRate = Math.max(0.85, Math.min(1.15, 1 + drift * 0.5));
      } else if (v.playbackRate !== 1) {
        v.playbackRate = 1;
      }
    }
  }

  function dispose() {
    for (const rec of entries.values()) release(rec);
    entries.clear();
  }

  return { sync, get, meta, syncPlayback, dispose, list: () => manifest };
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
