/**
 * The media pool, and the gap between asking the disk and hearing back.
 *
 * A clip lives in IndexedDB, so `load` cannot hand back an element: it files a
 * record, asks for the bytes, and finishes the job whenever the disk answers.
 * Everything the pool does about *forgetting* a clip — a project reload, a
 * media entry deleted, the tab tearing down — happens synchronously, and so
 * can happen in the middle of that.
 *
 * Nothing said so. The fetch would land on a record nobody held any more, mint
 * an object URL, build a `<video>` and call `play()` on it — and a detached
 * media element goes on decoding, with nothing left in the map to release it.
 * Import a clip, change your mind, and the machine driving the projectors is
 * quietly decoding video for the rest of the evening.
 *
 * The browser here is a stand-in with a disk you answer by hand, which is the
 * only way to be standing in the gap when the delete lands.
 *
 *   node test/media.test.mjs
 */

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};

/* ------------------------------------------------------------------ *
 * A disk that answers when this file says so
 * ------------------------------------------------------------------ */

const disk = new Map();
/** Every transaction opened and not yet completed, so a read can be held open. */
const pending = [];

globalThis.indexedDB = {
  open() {
    const req = {};
    queueMicrotask(() => {
      req.result = {
        objectStoreNames: { contains: () => true },
        transaction() {
          const t = { reads: [] };
          pending.push(t);
          return {
            objectStore: () => ({
              get(key) {
                const request = { result: undefined };
                t.reads.push({ key, request });
                return request;
              },
              put() { return { result: undefined }; },
              delete() { return { result: undefined }; },
            }),
            set oncomplete(fn) { t.oncomplete = fn; },
            get oncomplete() { return t.oncomplete; },
            set onerror(fn) { t.onerror = fn; },
            set onabort(fn) { t.onabort = fn; },
          };
        },
      };
      req.onsuccess?.();
    });
    return req;
  },
};

/**
 * Nothing completes until this is called, which is what lets a test stand in
 * the gap between asking the disk and hearing back.
 */
async function settle() {
  for (let i = 0; i < 8; i++) {
    while (pending.length) {
      const t = pending.shift();
      for (const { key, request } of t.reads) request.result = disk.get(key);
      t.oncomplete?.();
    }
    await new Promise((r) => setImmediate(r));
  }
}

/* ------------------------------------------------------------------ *
 * Elements, and whether anybody let go of them
 * ------------------------------------------------------------------ */

let liveUrls = 0;
let playing = 0;
const built = [];

globalThis.URL = {
  createObjectURL() { liveUrls++; return `blob:${liveUrls}`; },
  revokeObjectURL() { liveUrls--; },
};

function fakeVideo() {
  const el = {
    tagName: 'VIDEO', muted: false, loop: false, playsInline: false,
    preload: '', crossOrigin: '', src: '', paused: true, seeking: false,
    currentTime: 0, playbackRate: 1, duration: 10,
    play() { if (el.paused) playing++; el.paused = false; return Promise.resolve(); },
    pause() { if (!el.paused) playing--; el.paused = true; },
    removeAttribute() { el.src = ''; },
    load() {},
  };
  built.push(el);
  return el;
}

globalThis.document = { createElement: (tag) => (tag === 'video' ? fakeVideo() : { tagName: tag.toUpperCase() }) };
globalThis.Image = class { constructor() { this.tagName = 'IMG'; built.push(this); } removeAttribute() {} };

const { createMediaPool } = await import('../js/core/media.js');
const { getBlob } = await import('../js/core/storage.js');

/* ------------------------------------------------------------------ *
 * What "not there" comes back as
 * ------------------------------------------------------------------ */

console.log('— asking the disk for something that is not on it —');

{
  const answer = getBlob('media/nothing-like-this');
  await settle();
  const blob = await answer;
  /**
   * The transaction helper used to fall back to the *request* whenever the
   * request's result was undefined — which is exactly the case that has a
   * meaning. So this came back truthy, and the `if (!blob) throw` in both
   * callers, whose whole job is to say "that file is not on this machine",
   * never fired once.
   */
  ok('a missing blob is null, not the request that went looking for it',
    blob === null, `${typeof blob}: ${JSON.stringify(blob)?.slice(0, 60)}`);
}


const clip = { id: 'm1', name: 'waves.mp4', kind: 'video', mime: 'video/mp4' };
disk.set('media/m1', { size: 10 });

/* ------------------------------------------------------------------ *
 * The ordinary path
 * ------------------------------------------------------------------ */

console.log('— a clip that stays —');

{
  built.length = 0;
  const pool = createMediaPool({});
  pool.sync([clip]);
  pool.get('m1');
  await settle();

  ok('the clip is decoded and playing', built.length === 1 && !built[0].paused);
  ok('and the pool hands it over', pool.get('m1') === built[0]
    || pool.get('m1') === null, 'ready is set by the element itself');

  built[0].oncanplay?.();
  ok('once it says it can play, it is what an effect gets', pool.get('m1') === built[0]);

  pool.dispose();
  ok('and disposing lets go of the object URL', liveUrls === 0, `${liveUrls} still out`);
  ok('and stops it playing', built[0].paused);
}

/* ------------------------------------------------------------------ *
 * Changing your mind while the disk is busy
 * ------------------------------------------------------------------ */

console.log('\n— a clip dropped before the disk answers —');

{
  built.length = 0;
  playing = 0;
  const pool = createMediaPool({});
  pool.sync([clip]);
  pool.get('m1');            // asks the disk; nothing has answered yet
  ok('nothing has been built yet', built.length === 0);

  pool.sync([]);             // the media entry is deleted while the read is out
  await settle();

  /**
   * The whole point. The record was gone from the map by the time the bytes
   * arrived, so anything built for it could never be released — a detached
   * `<video>`, playing, for the rest of the evening.
   */
  ok('nothing is built for a clip nobody wants any more', built.length === 0,
    `${built.length} elements`);
  ok('and no object URL is minted for it', liveUrls === 0, `${liveUrls} still out`);
  ok('and nothing is left playing', playing === 0, `${playing} playing`);
}

{
  built.length = 0;
  playing = 0;
  const pool = createMediaPool({});
  pool.sync([clip]);
  pool.get('m1');
  pool.dispose();            // the tab tears down mid-read
  await settle();
  ok('the same on the way out of the tab', built.length === 0 && liveUrls === 0 && playing === 0,
    `${built.length} elements, ${liveUrls} urls, ${playing} playing`);
}

/* ------------------------------------------------------------------ *
 * A clip that is not there at all
 * ------------------------------------------------------------------ */

console.log('\n— a clip whose bytes have gone —');

{
  built.length = 0;
  const said = [];
  const pool = createMediaPool({ onError: (m) => said.push(m) });
  pool.sync([{ ...clip, id: 'gone' }]);
  pool.get('gone');
  await settle();
  ok('it says so once', said.length === 1, said.join(' | '));
  ok('and an effect asking for it gets null', pool.get('gone') === null);

  // And it does not say so again after the pool has been told to forget it.
  const quiet = [];
  const pool2 = createMediaPool({ onError: (m) => quiet.push(m) });
  pool2.sync([{ ...clip, id: 'gone2' }]);
  pool2.get('gone2');
  pool2.sync([]);
  await settle();
  ok('a clip dropped mid-read complains about nothing', quiet.length === 0, quiet.join(' | '));
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
