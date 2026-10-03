/**
 * Projected light onto a photograph of the house, the way light actually adds.
 *
 * A projector adds light to a surface; it cannot take any away. So a still of
 * a show is the house as the camera saw it, plus whatever the projector threw
 * at it — and the plus has to happen in *linear* light, because that is the
 * quantity that adds. Canvas's 'lighter' adds the gamma-encoded numbers
 * instead, and the difference is not subtle: a mid-red brick (#8f4a33)
 * projected onto a grey night wall (#484d56) comes out salmon pink, (215,151,
 * 137), because the wall's grey is added at several times its real strength.
 * In linear light the same two make (158,105,99), which is brick. Every effect
 * in every still was being washed out towards pastel by exactly this.
 *
 * The bloom and grade upstream already run in linear light for the same
 * reason (see js/render/postfx.js). This is the last step of that chain: decode
 * both pictures, add, clip at full scale, encode once.
 *
 * Used by tools/shot.html for the README stills and tools/review.html for
 * looking at effects on the demo house. It reads the pixels back, so it is for
 * stills, not for a projector tab.
 */

const TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Linear 0..1 to 8-bit sRGB, through a table fine enough not to band. */
const STEPS = 4096;
const TO_SRGB = new Uint8ClampedArray(STEPS + 1);
for (let i = 0; i <= STEPS; i++) {
  const l = i / STEPS;
  TO_SRGB[i] = Math.round((l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055) * 255);
}

/**
 * Draw `house` into `g`, then add `light` on top of it in linear light.
 *
 * Both are drawn at the full size of `g`'s canvas, so they can be any size —
 * the light is typically the WebGL canvas the bloom and grade went into.
 */
export function addLight(g, house, light) {
  const W = g.canvas.width;
  const H = g.canvas.height;
  g.drawImage(house, 0, 0, W, H);
  const base = g.getImageData(0, 0, W, H);

  const scratch = document.createElement('canvas');
  scratch.width = W;
  scratch.height = H;
  const sg = scratch.getContext('2d', { willReadFrequently: true });
  sg.drawImage(light, 0, 0, W, H);
  const add = sg.getImageData(0, 0, W, H).data;

  const d = base.data;
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = TO_LINEAR[d[i + c]] + TO_LINEAR[add[i + c]];
      d[i + c] = TO_SRGB[v >= 1 ? STEPS : (v * STEPS) | 0];
    }
  }
  g.putImageData(base, 0, 0);
}
