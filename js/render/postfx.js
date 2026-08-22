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

/**
 * sRGB <-> linear conversion, shared by every pass.
 *
 * This matters more than it sounds. Canvas hands us gamma-encoded sRGB, but
 * light adds linearly: two lamps of brightness 0.5 make 1.0, not 0.5^(1/2.2) * 2.
 * Blurring and adding bloom on gamma-encoded values makes halos far too bright
 * in the mid-tones and shifts their hue, which is exactly the "glowing sticker"
 * look. Doing the whole post chain in linear and encoding once at the end is
 * what makes a halo look like light spilling rather than paint sprayed around
 * the edge.
 */
export const COLOR_SPACE_GLSL = `
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 linearToSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}`;

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

${COLOR_SPACE_GLSL}

void main() {
  // Everything downstream of here — blur, accumulate, add — happens in linear
  // light. The main pass linearises the scene to match before adding it.
  vec3 c = srgbToLinear(texture2D(uTex, vUV).rgb);
  float brightness = max(c.r, max(c.g, c.b));

  // Soft knee curve, as used in most modern engines.
  float knee = max(uKnee, 0.0001);
  float soft = clamp(brightness - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float contribution = max(soft, brightness - uThreshold) / max(brightness, 0.0001);

  // Stored back through the sRGB curve. An 8-bit target holding linear values
  // has almost no precision in the darks, and bloom lives in the darks.
  gl_FragColor = vec4(linearToSrgb(c * contribution), 1.0);
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

${COLOR_SPACE_GLSL}

void main() {
  // Decode, filter in linear, re-encode. Blurring gamma-encoded values makes a
  // bright core bleed too far and a dim one barely bleed at all.
  vec3 sum = srgbToLinear(texture2D(uTex, vUV).rgb) * 0.227027;
  vec2 off1 = uDirection * 1.3846153846;
  vec2 off2 = uDirection * 3.2307692308;

  sum += srgbToLinear(texture2D(uTex, vUV + off1).rgb) * 0.3162162162;
  sum += srgbToLinear(texture2D(uTex, vUV - off1).rgb) * 0.3162162162;
  sum += srgbToLinear(texture2D(uTex, vUV + off2).rgb) * 0.0702702703;
  sum += srgbToLinear(texture2D(uTex, vUV - off2).rgb) * 0.0702702703;

  gl_FragColor = vec4(linearToSrgb(sum), 1.0);
}`;

/** Combines two bloom levels so the halo has both a tight core and a wide spill. */
export const COMBINE_FRAG = `
precision mediump float;
varying vec2 vUV;
uniform sampler2D uNear;
uniform sampler2D uFar;
uniform float uFarWeight;

${COLOR_SPACE_GLSL}

void main() {
  vec3 sum = srgbToLinear(texture2D(uNear, vUV).rgb)
           + srgbToLinear(texture2D(uFar, vUV).rgb) * uFarWeight;
  gl_FragColor = vec4(linearToSrgb(sum), 1.0);
}`;

/**
 * GLSL fragment shared by the warp shader. Kept here so the grading maths lives
 * next to the explanation rather than buried in the warp module.
 */
export const GRADE_GLSL = `
${COLOR_SPACE_GLSL}

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

/**
 * Grade a *linear* colour and return a *linear* colour.
 *
 * Exposure and tonemapping belong in linear — that is what they model. Contrast
 * and saturation are perceptual, so they pivot in the encoded domain around mid
 * grey; doing contrast in linear crushes shadows far harder than expected.
 */
vec3 applyGrade(vec3 linearColour) {
  vec3 c = linearColour * uTint * uExposure;

  // Filmic roll-off, in linear, where the curve is defined.
  c = max(c, 0.0);
  c = mix(min(c, vec3(1.0)), acesFilmic(c), uTonemap);

  // Perceptual adjustments in encoded space.
  vec3 enc = linearToSrgb(c);
  enc = (enc - 0.5) * uContrast + 0.5;
  float luma = dot(enc, vec3(0.2126, 0.7152, 0.0722));
  enc = mix(vec3(luma), enc, uSaturation);
  enc = pow(max(enc, 0.0), vec3(1.0 / max(uGradeGamma, 0.01)));

  return srgbToLinear(clamp(enc, 0.0, 1.0));
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
  bloom: 0.35,
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
      bloom: 0.5, bloomThreshold: 0.5, bloomKnee: 0.35, bloomRadius: 1.4,
      exposure: 1.05, contrast: 1.18, saturation: 0.92, temperature: -0.35,
      gamma: 0.95, tonemap: true,
    },
  },
  {
    id: 'ember',
    name: 'Ember',
    description: 'Warm and heavy. Fire, pumpkins, blood.',
    values: {
      bloom: 0.45, bloomThreshold: 0.55, bloomKnee: 0.3, bloomRadius: 1.2,
      exposure: 1.1, contrast: 1.12, saturation: 1.25, temperature: 0.45,
      gamma: 1.05, tonemap: true,
    },
  },
  {
    id: 'frost',
    name: 'Frost',
    description: 'Clean, cold and bright. Snow, icicles, stars.',
    values: {
      bloom: 0.42, bloomThreshold: 0.6, bloomKnee: 0.25, bloomRadius: 1.6,
      exposure: 1.05, contrast: 1.02, saturation: 0.95, temperature: -0.2,
      gamma: 1.05, tonemap: true,
    },
  },
  {
    id: 'white-wall',
    name: 'White wall',
    description: 'For rendered, painted or pale brick. Crushes the low end hard, because a light wall shows every bit of grey a projector cannot help emitting.',
    values: {
      // A projector cannot emit darkness, and a white wall reflects three or
      // four times as much of the grey it does emit as brick does. So the black
      // parts of the frame are the problem: gamma below one and a firm contrast
      // pull the low end down towards where the wall disappears, and a slightly
      // lower exposure keeps the mid-tones off the ceiling once the extra
      // reflectance is doing its work. Saturation stays near neutral because a
      // white surface already reproduces colour properly — the boost that makes
      // brick look alive makes render look like a cartoon.
      bloom: 0.32, bloomThreshold: 0.68, bloomKnee: 0.2, bloomRadius: 1.1,
      exposure: 0.95, contrast: 1.3, saturation: 1.02, temperature: 0,
      gamma: 0.82, tonemap: true,
    },
  },
  {
    id: 'deep',
    name: 'Deep',
    description: 'Everything under water. A big soft halo, because that is what light does in water, and the red pulled out from under it.',
    values: {
      /**
       * The bloom is the physics here, not the polish.
       *
       * Water scatters: a bright thing seen through several metres of it has a
       * halo, and the halo is wide and soft rather than the tight ring a lens
       * gives. So the radius goes up and the threshold comes *down*, which
       * means even the middling values bloom a little — that is the veiling
       * glare you get looking at anything through a few metres of sea, and it
       * is most of why an underwater picture has no true blacks in it.
       *
       * Gamma above one lifts those shadows the rest of the way. A projector
       * that leaves the bottom of the frame at zero is showing you the wall,
       * and there is no wall down there; there is water.
       */
      bloom: 0.52, bloomThreshold: 0.46, bloomKnee: 0.45, bloomRadius: 2,
      exposure: 1, contrast: 1.04, saturation: 1.15, temperature: -0.3,
      gamma: 1.06, tonemap: true,
    },
  },
  {
    id: 'saturated',
    name: 'Saturated',
    description: 'Punchy colour with a big halo. Fairy lights and chases.',
    values: {
      bloom: 0.62, bloomThreshold: 0.45, bloomKnee: 0.4, bloomRadius: 1.3,
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
