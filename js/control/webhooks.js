/**
 * Fire-and-forget HTTP calls, for the lights that are not projectors.
 *
 * Most houses that get projected on already have something else running —
 * WLED on the gutter, a smart plug on the inflatable, a relay on the fog
 * machine — and all of them speak HTTP. A trigger that jumps the projection to
 * a scare and *simultaneously* slams the roofline red is a different order of
 * thing from one that only does the projection, and the entire mechanism needed
 * is a `fetch` at the right two moments.
 *
 * Two moments, hence two hooks: **before**, at the instant the trigger fires,
 * and **after**, when the hold expires and the show goes back to what it was
 * doing. Wire an ambient scene into `after` and the whole house resets itself
 * for the next group without anyone touching anything.
 *
 * ── The thing that will catch you out ──────────────────────────────────────
 *
 * A page served over **https** may not call **http**. Browsers block it as
 * mixed content, silently, before the request leaves — and WLED, smart plugs
 * and the rest are all plain http on the local network. So a show driven from
 * the GitHub Pages copy cannot talk to them, no matter what is configured here.
 *
 * The fix is not a proxy or a certificate, it is to serve the control page the
 * same way as everything else it is talking to: over http, from the machine
 * running the show. This app is static files, so anything that serves a
 * directory will do. `checkReachable` below reports the situation rather than
 * leaving somebody to discover it in the dark on the night.
 *
 * ── The second thing ──────────────────────────────────────────────────────
 *
 * Requests default to `no-cors`. The response then cannot be read at all, which
 * sounds like a loss and is not: these calls are commands, nobody is waiting on
 * the answer, and the alternative is that every device you own has to be
 * configured to send CORS headers before it will do anything. WLED's classic
 * HTTP API — `/win&T=2` and friends — is all GET and works perfectly this way.
 * Switch a hook to `cors` when you actually want to see the failure.
 */

/** Ten seconds is a long time for a light switch, and stops a hang piling up. */
const TIMEOUT_MS = 10000;

/** Per-hook floor, so a motion trigger cannot machine-gun a device. */
const MIN_GAP_MS = 250;
const lastCall = new Map();

/**
 * Is this page allowed to talk to that URL at all?
 *
 * Returns a reason string when it certainly cannot, and null when it probably
 * can. Deliberately only catches what is knowable up front: an unreachable host
 * or a device that is switched off looks identical to success from here,
 * because `no-cors` gives an opaque response either way.
 */
export function checkReachable(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return 'That is not a URL. It needs the http:// on the front.';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `${parsed.protocol} is not something a browser can call from a page.`;
  }
  if (parsed.protocol === 'http:' && globalThis.location?.protocol === 'https:') {
    return 'This page is on https, so the browser will block a plain http call before it is sent. '
      + 'Serve the control page over http from the machine running the show.';
  }
  return null;
}

/**
 * Send one hook. Never throws, never blocks anything, returns what happened.
 *
 * The show is mid-scare when this runs. Nothing here may be allowed to delay a
 * frame or take the runtime down because a plug was unplugged, so every failure
 * path ends in a resolved promise carrying a description.
 */
export async function fireWebhook(hook, { key = 'hook' } = {}) {
  const url = String(hook?.url || '').trim();
  if (!url) return { skipped: true };

  const blocked = checkReachable(url);
  if (blocked) return { ok: false, error: blocked };

  const now = Date.now();
  if (now - (lastCall.get(key) || 0) < MIN_GAP_MS) return { skipped: true, throttled: true };
  lastCall.set(key, now);

  const method = (hook.method || 'GET').toUpperCase();
  const body = String(hook.body || '');
  const mode = hook.mode === 'cors' ? 'cors' : 'no-cors';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const init = { method, mode, signal: controller.signal, cache: 'no-store', redirect: 'follow' };
    if (method !== 'GET' && method !== 'HEAD' && body) {
      init.body = body;
      // `no-cors` only permits the three "simple" content types, and setting
      // anything else silently promotes the request to a preflighted one that
      // then fails. Devices that take JSON overwhelmingly parse the body
      // regardless of what it claims to be, so text/plain is the pragmatic
      // choice — and `cors` mode is there for when it is not.
      init.headers = { 'Content-Type': mode === 'cors' ? 'application/json' : 'text/plain' };
    }
    const res = await fetch(url, init);
    // An opaque response carries no status. Reaching this line at all means the
    // request left the machine, which is as much as no-cors can ever tell us.
    return { ok: true, status: mode === 'cors' ? res.status : null, opaque: mode !== 'cors' };
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? 'Timed out.' : String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Both hooks of a trigger, in the shape the UI stores them. */
export function triggerHooks(trigger) {
  return {
    before: trigger?.http?.before || null,
    after: trigger?.http?.after || null,
  };
}
