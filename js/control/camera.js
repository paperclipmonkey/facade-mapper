/**
 * Camera capture for the control tab.
 *
 * The camera does two jobs: it's the surface you trace shapes on, and it's the
 * sensor for auto-alignment. Both want the same thing — a stable, unprocessed
 * image — which is why this tries to pin exposure and white balance where the
 * browser allows it. Auto-exposure hunting between a black frame and a bright
 * marker is the single most common reason calibration comes out wonky.
 */

const ANALYSIS_WIDTH = 480;

export function createCamera() {
  const video = document.createElement('video');
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;

  const analysisCanvas = document.createElement('canvas');
  const analysisCtx = analysisCanvas.getContext('2d', { willReadFrequently: true });

  let stream = null;
  let currentDeviceId = null;

  async function listDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  }

  async function start(deviceId = null, { width = 1920, height = 1080 } = {}) {
    stop();
    const constraints = {
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: width }, height: { ideal: height } }
        : { facingMode: 'environment', width: { ideal: width }, height: { ideal: height } },
    };

    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      if (deviceId) {
        // The saved device may have been unplugged since last time.
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
      } else {
        throw err;
      }
    }

    video.srcObject = stream;
    await video.play().catch(() => {});
    await waitForMetadata();

    const track = stream.getVideoTracks()[0];
    currentDeviceId = track?.getSettings?.().deviceId ?? deviceId;
    await lockExposure(track);

    return {
      deviceId: currentDeviceId,
      width: video.videoWidth,
      height: video.videoHeight,
      label: track?.label || 'Camera',
    };
  }

  function waitForMetadata() {
    if (video.videoWidth) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        video.removeEventListener('loadedmetadata', done);
        resolve();
      };
      video.addEventListener('loadedmetadata', done);
      setTimeout(done, 3000);
    });
  }

  /**
   * Best-effort manual exposure. Support is patchy and entirely optional — the
   * marker detection works either way, just with more margin when it succeeds.
   */
  async function lockExposure(track) {
    if (!track?.getCapabilities) return false;
    let capabilities;
    try {
      capabilities = track.getCapabilities();
    } catch {
      return false;
    }
    const advanced = [];
    if (capabilities.exposureMode?.includes('manual')) advanced.push({ exposureMode: 'manual' });
    else if (capabilities.exposureMode?.includes('continuous')) advanced.push({ exposureMode: 'continuous' });
    if (capabilities.whiteBalanceMode?.includes('manual')) advanced.push({ whiteBalanceMode: 'manual' });
    if (capabilities.focusMode?.includes('manual')) advanced.push({ focusMode: 'manual' });
    if (!advanced.length) return false;
    try {
      await track.applyConstraints({ advanced });
      return true;
    } catch {
      return false;
    }
  }

  function stop() {
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
    video.srcObject = null;
  }

  function isRunning() {
    return !!stream && video.readyState >= 2 && video.videoWidth > 0;
  }

  function aspect() {
    return video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
  }

  /**
   * Grab a downscaled greyscale frame for analysis.
   * Returns a Float32Array of luma in 0..255, plus its dimensions.
   *
   * The buffer is reused between calls. This runs about eight times a second
   * for as long as a motion trigger is armed — all evening — and a fresh
   * Float32Array plus a fresh ImageData each time is close to a megabyte of
   * garbage a second, produced forever, for a result that is consumed
   * immediately and never kept. The caller must not hold on to `luma` past the
   * next call, which is exactly how the motion detector already uses it.
   */
  let lumaBuffer = null;

  function captureLuma() {
    if (!isRunning()) return null;
    const w = ANALYSIS_WIDTH;
    const h = Math.max(1, Math.round(w / aspect()));
    if (analysisCanvas.width !== w || analysisCanvas.height !== h) {
      analysisCanvas.width = w;
      analysisCanvas.height = h;
      lumaBuffer = null;
    }
    analysisCtx.drawImage(video, 0, 0, w, h);
    const { data } = analysisCtx.getImageData(0, 0, w, h);
    if (!lumaBuffer || lumaBuffer.length !== w * h) lumaBuffer = new Float32Array(w * h);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      // Rec. 601 luma; the exact coefficients matter less than consistency.
      lumaBuffer[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    return { luma: lumaBuffer, width: w, height: h };
  }

  /** A still for tracing over, downscaled and JPEG-compressed to fit in storage. */
  async function captureStill({ maxWidth = 1280, quality = 0.72 } = {}) {
    if (!isRunning()) return null;
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, maxWidth / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality);
    });
  }

  return {
    video,
    start,
    stop,
    listDevices,
    isRunning,
    aspect,
    captureLuma,
    captureStill,
    get deviceId() {
      return currentDeviceId;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Blob detection
 * ------------------------------------------------------------------ */

/**
 * Find the brightest connected blob in a difference image.
 *
 * The approach is deliberately simple: subtract a reference frame taken with the
 * projector dark, find the single brightest pixel, then flood-fill outwards
 * while pixels stay above a fraction of that peak, and return the intensity-
 * weighted centroid. Restricting to one connected region is what stops a
 * streetlight or a reflection in a window from dragging the answer off-target.
 *
 * @returns {{x:number,y:number,strength:number,pixels:number}|null} centroid in 0..1
 */
export function findBrightestBlob(current, reference, width, height, { minPeak = 22, relative = 0.5 } = {}) {
  const n = width * height;
  const diff = new Float32Array(n);
  let peak = 0;
  let peakIndex = -1;

  for (let i = 0; i < n; i++) {
    const d = current[i] - reference[i];
    if (d > 0) diff[i] = d;
    if (diff[i] > peak) {
      peak = diff[i];
      peakIndex = i;
    }
  }

  if (peakIndex < 0 || peak < minPeak) return null;

  const threshold = peak * relative;
  const visited = new Uint8Array(n);
  const queue = [peakIndex];
  visited[peakIndex] = 1;

  let sumX = 0;
  let sumY = 0;
  let sumW = 0;
  let pixels = 0;

  while (queue.length) {
    const index = queue.pop();
    const weight = diff[index];
    const x = index % width;
    const y = (index / width) | 0;
    sumX += x * weight;
    sumY += y * weight;
    sumW += weight;
    pixels++;

    // Runaway guard: a blob covering a quarter of the frame is a lit wall, not a marker.
    if (pixels > n / 4) return null;

    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const ni = ny * width + nx;
      if (visited[ni] || diff[ni] < threshold) continue;
      visited[ni] = 1;
      queue.push(ni);
    }
  }

  if (sumW <= 0 || pixels < 4) return null;
  return {
    x: sumX / sumW / width,
    y: sumY / sumW / height,
    strength: peak,
    pixels,
  };
}
