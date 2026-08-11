/**
 * Low-resolution density fields, drawn smoothly.
 *
 * Fire, smoke and fog are volumes, not collections of objects. Drawing them as
 * hundreds of additive circles is why particle-based versions read as "a bag of
 * marbles" — the eye picks out the individual sprites, and no amount of blur
 * hides that they are discs.
 *
 * The alternative is to evaluate a density field on a coarse grid, write it
 * into an ImageData, and let `drawImage` scale it up with the browser's own
 * bilinear filtering. That gives connected, wispy structure that genuinely
 * looks volumetric — and it is *faster*, because a 72x96 field is one upload
 * and one draw call instead of several hundred gradient fills.
 *
 * The resolution is deliberately low. At projector distance, and with bloom
 * downstream, the interpolation reads as soft light rather than as blur.
 */

/**
 * A reusable off-screen field buffer.
 *
 * Kept in an effect's `state` so the allocation happens once, not per frame.
 * Resolution changes reallocate; that only happens when a slider moves.
 */
export function createField(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, width | 0);
  canvas.height = Math.max(2, height | 0);
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  const image = ctx.createImageData(canvas.width, canvas.height);

  return {
    canvas,
    ctx,
    image,
    data: image.data,
    get width() {
      return canvas.width;
    },
    get height() {
      return canvas.height;
    },

    /** Zero every pixel, including alpha. */
    clear() {
      image.data.fill(0);
    },

    /**
     * Write one cell. Colour components are 0..255, alpha 0..1.
     *
     * Values are stored straight rather than premultiplied: the 2D context
     * expects unpremultiplied data in an ImageData, and premultiplying here
     * would darken everything by its own alpha twice.
     */
    set(x, y, r, g, b, a) {
      const i = (y * canvas.width + x) * 4;
      const d = image.data;
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = a < 0 ? 0 : a > 1 ? 255 : (a * 255) | 0;
    },

    /** Add into a cell, for effects that accumulate several contributions. */
    add(x, y, r, g, b, a) {
      const i = (y * canvas.width + x) * 4;
      const d = image.data;
      const alpha = a < 0 ? 0 : a > 1 ? 255 : (a * 255) | 0;
      d[i] = Math.min(255, d[i] + r);
      d[i + 1] = Math.min(255, d[i + 1] + g);
      d[i + 2] = Math.min(255, d[i + 2] + b);
      d[i + 3] = Math.min(255, d[i + 3] + alpha);
    },

    /**
     * Push the field to its own canvas and stretch it over a destination rect.
     *
     * `imageSmoothingEnabled` is what turns a grid of cells into a continuous
     * volume; without it this looks like Minecraft.
     */
    blit(g, x, y, w, h) {
      ctx.putImageData(image, 0, 0);
      const previous = g.imageSmoothingEnabled;
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(canvas, x, y, w, h);
      g.imageSmoothingEnabled = previous;
    },
  };
}

/**
 * Fetch a correctly-sized field from an effect's state, reallocating only when
 * the requested resolution actually changes.
 */
export function ensureField(state, key, width, height) {
  const existing = state[key];
  if (existing && existing.width === (width | 0) && existing.height === (height | 0)) {
    return existing;
  }
  const field = createField(width, height);
  state[key] = field;
  return field;
}

/**
 * Divergence-free ("curl") noise.
 *
 * Advecting smoke along a plain noise field makes it bunch up and thin out,
 * because that field has sources and sinks. Taking the curl of a potential
 * field gives a flow that conserves volume, which is what makes smoke swirl and
 * fold instead of pulsing. It is the single biggest difference between drifting
 * blobs and something that looks like it is moving through air.
 */
export function curlNoise(noise, x, y, z, epsilon = 0.35) {
  // Curl of a 2D potential is (dP/dy, -dP/dx).
  const p1 = noise.noise3(x, y + epsilon, z);
  const p2 = noise.noise3(x, y - epsilon, z);
  const p3 = noise.noise3(x + epsilon, y, z);
  const p4 = noise.noise3(x - epsilon, y, z);
  const scale = 1 / (2 * epsilon);
  return [(p1 - p2) * scale, -(p3 - p4) * scale];
}
