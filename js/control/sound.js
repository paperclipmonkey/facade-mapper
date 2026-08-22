/**
 * Sound playback for triggers and scenes.
 *
 * Only the control tab plays audio. That is a deliberate choice: the projector
 * tabs are usually on displays with no speakers, and if every tab played the
 * same clip you would get four copies a few milliseconds apart, which sounds
 * like a flanger rather than a thunderclap.
 *
 * Uses WebAudio rather than <audio> elements because a scare needs to start on
 * the frame it is triggered, and because two scares overlapping should mix
 * rather than cut each other off.
 */

import { getBlob } from '../core/storage.js';

const BLOB_KEY = (id) => `media/${id}`;

export function createSoundPlayer({ onError } = {}) {
  let context = null;
  const buffers = new Map();   // media id -> AudioBuffer
  const pending = new Map();   // media id -> Promise
  const active = new Set();    // currently playing sources, so stopAll works

  function ensureContext() {
    if (!context) {
      context = new (window.AudioContext || window.webkitAudioContext)();
    }
    // Browsers suspend the context until a user gesture; every play attempt
    // nudges it, so the first click anywhere unblocks the rest of the evening.
    if (context.state === 'suspended') context.resume().catch(() => {});
    return context;
  }

  async function load(mediaId) {
    if (buffers.has(mediaId)) return buffers.get(mediaId);
    if (pending.has(mediaId)) return pending.get(mediaId);

    const task = (async () => {
      const blob = await getBlob(BLOB_KEY(mediaId));
      if (!blob) throw new Error('Sound is missing from local storage');
      const bytes = await blob.arrayBuffer();
      const buffer = await ensureContext().decodeAudioData(bytes);
      buffers.set(mediaId, buffer);
      pending.delete(mediaId);
      return buffer;
    })().catch((err) => {
      pending.delete(mediaId);
      onError?.(`Could not decode sound: ${err.message}`);
      return null;
    });

    pending.set(mediaId, task);
    return task;
  }

  /** Fire and forget. Returns immediately; decoding happens once, then is cached. */
  async function play(mediaId, { volume = 1, loop = false } = {}) {
    if (!mediaId) return null;
    const buffer = await load(mediaId);
    if (!buffer) return null;

    const ctx = ensureContext();
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = buffer;
    source.loop = loop;
    gain.gain.value = Math.max(0, Math.min(2, volume));
    source.connect(gain).connect(ctx.destination);
    source.start();

    active.add(source);
    source.onended = () => active.delete(source);
    return source;
  }

  function stopAll() {
    for (const source of active) {
      try {
        source.stop();
      } catch {
        /* already finished */
      }
    }
    active.clear();
  }

  /** Preload everything a show might fire, so the first scare isn't late. */
  async function warm(mediaList = []) {
    for (const entry of mediaList) {
      if (entry.kind === 'audio') await load(entry.id);
    }
  }

  return {
    play,
    stopAll,
    warm,
    forget: (id) => buffers.delete(id),
    /** Make the context without playing anything, so the ambience can share it. */
    ensureContext,
    get context() {
      return context;
    },
  };
}
