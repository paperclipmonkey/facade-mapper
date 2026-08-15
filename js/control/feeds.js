/**
 * Extra camera feeds, for effects rather than for alignment.
 *
 * The alignment camera is a measuring instrument. It has to be on a tripod, it
 * has to see the whole projected area, its exposure is pinned so the calibration
 * dots read consistently, and every shape you have ever traced is stored in its
 * coordinates. It is emphatically not a camera you point at people.
 *
 * A camera you point at people is a different job: a webcam on the doorstep for
 * a delayed mirror in a window, a spare phone watching the gate. Sharing one
 * device between the two means either the alignment moves or the effect looks
 * at the wall it is being projected onto — which is a feedback loop, and looks
 * like one.
 *
 * So effects may open their own. Streams are cached by device id and shared
 * between every layer asking for the same one, because a browser will happily
 * hand you four independent streams from one webcam and then run out of
 * bandwidth. Opening is lazy: nothing here touches a camera until a layer
 * actually asks for that device.
 */

const feeds = new Map();

/**
 * A `<video>` for this device, or null while it is still opening.
 *
 * Deliberately non-blocking. `draw` runs sixty times a second and cannot await
 * anything, so the first few frames after a layer asks for a new device return
 * null and draw nothing — the same thing that happens in a projector tab, which
 * has no camera at all.
 */
export function feed(deviceId) {
  if (!deviceId) return null;
  const existing = feeds.get(deviceId);
  if (existing) return existing.ready ? existing.video : null;

  const video = document.createElement('video');
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;
  const entry = { video, ready: false, stream: null, failed: false };
  feeds.set(deviceId, entry);

  navigator.mediaDevices
    ?.getUserMedia({ audio: false, video: { deviceId: { exact: deviceId } } })
    .then(async (stream) => {
      entry.stream = stream;
      video.srcObject = stream;
      await video.play().catch(() => {});
      entry.ready = true;
    })
    .catch(() => {
      // Unplugged, refused, or in use by something else. Remembered as failed
      // so we do not ask again sixty times a second for the rest of the evening.
      entry.failed = true;
    });

  return null;
}

/** Let go of a device — on project load, or when nothing references it. */
export function releaseFeed(deviceId) {
  const entry = feeds.get(deviceId);
  if (!entry) return;
  entry.stream?.getTracks?.().forEach((t) => t.stop());
  feeds.delete(deviceId);
}

/** Everything, on teardown. */
export function releaseAllFeeds() {
  for (const id of [...feeds.keys()]) releaseFeed(id);
}

/**
 * Close feeds nothing is using any more.
 *
 * A camera left open holds its light on and shows in the browser's tab
 * indicator, which is alarming if the layer that opened it was deleted an hour
 * ago. Called on commit with the set of device ids the project still asks for.
 */
export function pruneFeeds(wanted) {
  for (const id of [...feeds.keys()]) {
    if (!wanted.has(id)) releaseFeed(id);
  }
}

/** Cameras this browser can see. Labels only appear once permission is given. */
export async function listCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  } catch {
    return [];
  }
}
