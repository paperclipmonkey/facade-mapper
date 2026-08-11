/**
 * Bloom and colour grading.
 *
 * This is the single biggest difference between "some shapes lit up" and
 * something that looks like a proper show. Three reasons:
 *
 *   Bloom. Real light spills. A bright window seen from the street has a halo
 *   around it, and light bleeds into the brickwork nearby. Without that, every
 *   projected edge is a hard cutout and the eye reads it as a sticker on the
 *   wall rather than the wall glowing.
 *
 *   Tonemapping. Effects happily produce values above 1.0 when they stack —
 *   two additive layers on one window, a lightning flash over a lit facade.
 *   Straight clipping turns those into flat white blobs with hard edges. A
 *   filmic curve rolls them off, so highlights keep their shape and colour.
 *
 *   Grading. Exposure, contrast, saturation and colour temperature applied
 *   globally, so a whole show can be pushed warm and moody or cold and harsh
 *   without touching forty individual effect parameters.
 *
 * It runs on the world buffer before the warp, in the same pass, so every
 * effect gets it — including ones written in the Code panel — and every
 * projector applies the identical curve, which is what keeps overlapping
 * projectors matching.
 */

/** Fullscreen triangle. Cheaper than a quad and avoids the diagonal seam. */
export const FULLSCREEN_VERT = `
attribute vec2 aPos;
varying vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/**
 * Bright-pass with a soft knee.
 *
 * A hard threshold makes bloom pop in and out as something crosses it, which
 * flickers horribly on a slow fade. The knee blends the region either side of
 * the threshold so brightness ramps into the bloom smoothly.
 */
export const BRIGHTPASS_FRAG = `
precision mediump float;
varying vec2 vUV;
uniform sampler2D uTex;
uniform float uThreshold;
uniform float uKnee;

void main() {
  vec3 c = texture2D(uTex, vUV).rgb;
  float brightness = max(c.r, max(c.g, c.b));

  // Soft knee curve, as used in most modern engines.
  float knee = max(uKnee, 0.0001);
  float soft = clamp(brightness - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float contribution = max(soft, brightness - uThreshold) / max(brightness, 0.0001);

  gl_FragColor = vec4(c * contribution, 1.0);
}`;

/**
 * Separable Gaussian, nine taps using linear-sampling pairs.
 *
 * Sampling between texels lets the hardware do half the filtering, so nine
 * weights cost five fetches. Run once horizontally and once vertically per
 * bloom level.
 */
export const BLUR_FRAG = `
precision mediump float;
varying vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uDirection;   // texel step, one axis at a time

void main() {
  vec3 sum = texture2D(uTex, vUV).rgb * 0.227027;
  vec2 off1 = uDirection * 1.3846153846;
  vec2 off2 = uDirection * 3.2307692308;

  sum += texture2D(uTex, vUV + off1).rgb * 0.3162162162;
  sum += texture2D(uTex, vUV - off1).rgb * 0.3162162162;
  sum += texture2D(uTex, vUV + off2).rgb * 0.0702702703;
  sum += texture2D(uTex, vUV - off2).rgb * 0.0702702703;

  gl_FragColor = vec4(sum, 1.0);
}`;

/** Combines two bloom levels so the halo has both a tight core and a wide spill. */
export const COMBINE_FRAG = `
precision mediump float;
varying vec2 vUV;
uniform sampler2D uNear;
uniform sampler2D uFar;
uniform float uFarWeight;

void main() {
  gl_FragColor = vec4(texture2D(uNear, vUV).rgb + texture2D(uFar, vUV).rgb * uFarWeight, 1.0);
}`;

/**
 * GLSL fragment shared by the warp shader. Kept here so the grading maths lives
 * next to the explanation rather than buried in the warp module.
 */
export const GRADE_GLSL = `
uniform vec3 uTint;          // colour temperature, precomputed on the CPU
uniform float uExposure;
uniform float uContrast;
uniform float uSaturation;
uniform float uGradeGamma;
uniform float uTonemap;      // 0 = clip, 1 = filmic roll-off

// Narkowicz's ACES approximation. Cheap, and it keeps bright colour from
// stampeding to white the way a straight clamp does.
vec3 acesFilmic(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

vec3 applyGrade(vec3 c) {
  c *= uTint * uExposure;

  // Contrast pivots around mid grey so it doesn't also shift overall brightness.
  c = (c - 0.5) * uContrast + 0.5;

  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(luma), c, uSaturation);

  c = max(c, 0.0);
  c = mix(c, acesFilmic(c), uTonemap);
  c = pow(c, vec3(1.0 / max(uGradeGamma, 0.01)));

  return clamp(c, 0.0, 1.0);
}`;

/**
 * Convert a colour temperature control (-1 cool .. 0 neutral .. +1 warm) into an
 * RGB multiplier. Approximates a blackbody shift without needing a full CIE
 * conversion, which would be overkill for a slider.
 */
export function temperatureTint(temperature = 0, strength = 1) {
  const t = Math.max(-1, Math.min(1, temperature)) * strength;
  if (t >= 0) {
    // Warm: hold red, pull green slightly, drop blue.
    return [1, 1 - 0.16 * t, 1 - 0.45 * t];
  }
  // Cool: drop red, hold blue.
  const c = -t;
  return [1 - 0.4 * c, 1 - 0.1 * c, 1];
}

/** Defaults that read as a neutral, slightly filmic starting point. */
export const DEFAULT_GRADE = Object.freeze({
  bloom: 0.55,
  bloomThreshold: 0.62,
  bloomKnee: 0.28,
  bloomRadius: 1,
  exposure: 1,
  contrast: 1.04,
  saturation: 1.08,
  temperature: 0,
  gamma: 1,
  tonemap: true,
});

/** A few looks worth starting from, tuned against the built-in presets. */
export const GRADE_PRESETS = [
  {
    id: 'neutral',
    name: 'Neutral',
    description: 'Gentle bloom, mild contrast. A sane default.',
    values: { ...DEFAULT_GRADE },
  },
  {
    id: 'haunted',
    name: 'Haunted',
    description: 'Cold, high-contrast and blown-out. Suits candles, fog and lightning.',
    values: {
      bloom: 0.85, bloomThreshold: 0.5, bloomKnee: 0.35, bloomRadius: 1.4,
      exposure: 1.05, contrast: 1.18, saturation: 0.92, temperature: -0.35,
      gamma: 0.95, tonemap: true,
    },
  },
  {
    id: 'ember',
    name: 'Ember',
    description: 'Warm and heavy. Fire, pumpkins, blood.',
    values: {
      bloom: 0.75, bloomThreshold: 0.55, bloomKnee: 0.3, bloomRadius: 1.2,
      exposure: 1.1, contrast: 1.12, saturation: 1.25, temperature: 0.45,
      gamma: 1.05, tonemap: true,
    },
  },
  {
    id: 'frost',
    name: 'Frost',
    description: 'Clean, cold and bright. Snow, icicles, stars.',
    values: {
      bloom: 0.7, bloomThreshold: 0.6, bloomKnee: 0.25, bloomRadius: 1.6,
      exposure: 1.05, contrast: 1.02, saturation: 0.95, temperature: -0.2,
      gamma: 1.05, tonemap: true,
    },
  },
  {
    id: 'saturated',
    name: 'Saturated',
    description: 'Punchy colour with a big halo. Fairy lights and chases.',
    values: {
      bloom: 1, bloomThreshold: 0.45, bloomKnee: 0.4, bloomRadius: 1.3,
      exposure: 1.08, contrast: 1.1, saturation: 1.45, temperature: 0.1,
      gamma: 1, tonemap: true,
    },
  },
  {
    id: 'flat',
    name: 'Flat (off)',
    description: 'No bloom, no curve. Use when checking alignment.',
    values: {
      bloom: 0, bloomThreshold: 1, bloomKnee: 0.1, bloomRadius: 1,
      exposure: 1, contrast: 1, saturation: 1, temperature: 0, gamma: 1, tonemap: false,
    },
  },
];

/**
 * Off-screen render target. WebGL1 with plain RGBA is deliberate — half-float
 * targets need an extension that isn't universal, and bloom on 8-bit is
 * perfectly convincing at projector brightness.
 */
export function createRenderTarget(gl, width, height) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  return { texture, framebuffer, width, height, complete };
}

export function disposeRenderTarget(gl, target) {
  if (!target) return;
  gl.deleteTexture(target.texture);
  gl.deleteFramebuffer(target.framebuffer);
}
