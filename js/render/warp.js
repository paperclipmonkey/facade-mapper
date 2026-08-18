/**
 * Projective warp, with bloom and colour grading.
 *
 * The world render is a flat 2D canvas covering some rectangle of camera space.
 * Getting it onto the wall means applying the projector's homography — a
 * perspective transform that Canvas2D can't do, because its transform matrix is
 * only affine. Hence WebGL.
 *
 * The trick that makes it exact rather than approximate: we set each vertex's
 * clip-space `w` to the homography's own denominator. GL already divides varyings
 * by w during rasterisation, so texture coordinates come out perspective-correct
 * for free, even across a single quad. Subdividing the mesh then costs nothing in
 * accuracy and buys us the optional per-point warp for walls that aren't flat.
 *
 * Passes per frame:
 *   1. upload the world canvas
 *   2. bright-pass into a half-size target
 *   3. halve and blur down a five-level chain, then accumulate back up
 *   4. warp the mesh, adding bloom and applying the grade (see render/postfx.js)
 *
 * Every one of those steps happens in linear light — light adds linearly, and
 * blooming or blending gamma-encoded values is what makes halos read as sprayed
 * paint rather than as spill.
 *
 * Bloom is computed on the *unwarped* source, so it warps along with the image
 * and two projectors covering the same wall produce identical halos.
 */

import { applyH3, mat3Inverse, applyH, clamp, IDENTITY3 } from '../core/math.js';
import {
  FULLSCREEN_VERT,
  BRIGHTPASS_FRAG,
  BLUR_FRAG,
  COMBINE_FRAG,
  GRADE_GLSL,
  DEFAULT_GRADE,
  temperatureTint,
  createRenderTarget,
  disposeRenderTarget,
} from './postfx.js';

const VERT = `
attribute vec3 aPos;   // x, y in projector NDC; z carries the homography denominator
attribute vec2 aUV;
varying vec2 vUV;
void main() {
  float w = aPos.z;
  vUV = aUV;
  gl_Position = vec4(aPos.x * w, aPos.y * w, 0.0, w);
}`;

const FRAG = `
precision mediump float;
varying vec2 vUV;
uniform sampler2D uTex;
uniform sampler2D uBloom;
uniform float uBloomAmount;
uniform vec2 uResolution;
uniform vec4 uFeather;   // top, right, bottom, left, in fractions of the output
uniform float uGamma;
uniform float uBrightness;

${GRADE_GLSL}

float ramp(float x, float w) {
  return w <= 0.0001 ? 1.0 : clamp(x / w, 0.0, 1.0);
}

void main() {
  // Outside the source rectangle there is nothing to show; sampling would smear
  // the edge texel across the rest of the projector.
  if (vUV.x < 0.0 || vUV.x > 1.0 || vUV.y < 0.0 || vUV.y > 1.0) {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // Work in linear light: the scene, the bloom and the edge blend all describe
  // quantities of light, and light adds linearly. Encoding happens once, last.
  vec3 c = srgbToLinear(texture2D(uTex, vUV).rgb);
  if (uBloomAmount > 0.0) {
    c += srgbToLinear(texture2D(uBloom, vUV).rgb) * uBloomAmount;
  }
  c = applyGrade(c);

  // Soft-edge blending is computed in real output pixels, which is what matters
  // when two projectors overlap on the same wall. Attenuating in linear is what
  // makes two feathered edges sum back to the same brightness as one unfeathered
  // one — do it in gamma space and the overlap band reads as a bright seam.
  vec2 p = gl_FragCoord.xy / uResolution;
  float f = ramp(1.0 - p.y, uFeather.x)
          * ramp(1.0 - p.x, uFeather.y)
          * ramp(p.y, uFeather.z)
          * ramp(p.x, uFeather.w);
  f = pow(f, uGamma);

  gl_FragColor = vec4(linearToSrgb(c * f * uBrightness), 1.0);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader failed to compile: ${log}`);
  }
  return shader;
}

function link(gl, vertSource, fragSource, label) {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertSource));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`${label} failed to link: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}

/* ------------------------------------------------------------------ *
 * Region of interest
 * ------------------------------------------------------------------ */

/**
 * The slice of world space a projector can actually reach.
 *
 * Rendering the whole camera frame for a projector that only covers the front
 * door would waste most of the pixels. Pushing the projector's own corners back
 * through the inverse homography gives the world rectangle worth rendering.
 */
export function computeRegion(H, { margin = 0.04, clampTo = 0.35 } = {}) {
  const full = { x: 0, y: 0, w: 1, h: 1 };
  if (!H) return full;
  const inv = mat3Inverse(H);
  if (!inv) return full;

  const corners = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [s, t] of corners) {
    const p = applyH(inv, s, t);
    // A corner mapping past the horizon means the projector's frustum extends
    // beyond the plane; fall back to the whole frame rather than guessing.
    if (!p || !isFinite(p.x) || !isFinite(p.y)) return full;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }

  minX = clamp(minX - margin, -clampTo, 1 + clampTo);
  minY = clamp(minY - margin, -clampTo, 1 + clampTo);
  maxX = clamp(maxX + margin, -clampTo, 1 + clampTo);
  maxY = clamp(maxY + margin, -clampTo, 1 + clampTo);

  const w = Math.max(0.02, maxX - minX);
  const h = Math.max(0.02, maxY - minY);
  return { x: minX, y: minY, w, h };
}

/* ------------------------------------------------------------------ *
 * Overlap and soft-edge blending
 * ------------------------------------------------------------------ */

/**
 * Work out how far each edge of a projector is overlapped by the others.
 *
 * Two projectors covering the same brickwork both emit into it, and light adds:
 * the overlap band comes out at twice the brightness with a hard seam down each
 * side of it. Nothing in the renderer can prevent that — there is no shared
 * frame buffer to composite into, only two lamps pointed at a wall — so the
 * only fix is for each projector to fade its own output out across the band, by
 * exactly the amount the other fades in. Two complementary ramps sum to one, and
 * the seam disappears.
 *
 * The ramps themselves are the shader's job and are applied in linear light,
 * which is the part that has to be right: attenuating gamma-encoded values
 * leaves a visible bright stripe no matter how carefully the widths are set.
 *
 * What this function adds is the widths. They were a manual measurement — stand
 * in the garden, nudge four numbers per projector, look, nudge again — and they
 * never needed to be, because the homographies already say precisely where each
 * projector lands on the wall. Walking inwards from each edge and asking "is
 * anybody else covering this?" gives the depth of the overlap directly.
 *
 * The median across each edge rather than the maximum: projectors are rarely
 * exactly parallel, so the band is usually a wedge, and the median is the width
 * that is right for most of the seam. It is also what a person tuning by eye
 * converges on.
 *
 * @param {number[]} H          this projector's world -> projector homography
 * @param {number[][]} others   the same for every other aligned projector
 * @returns {{top:number,right:number,bottom:number,left:number}} in 0..1 of this output
 */
export function computeEdgeBlends(H, others, { samples = 33, steps = 48, maxFeather = 0.45, margin = 0.004 } = {}) {
  const none = { top: 0, right: 0, bottom: 0, left: 0 };
  const inv = H ? mat3Inverse(H) : null;
  const peers = (others || []).filter(Boolean);
  if (!inv || !peers.length) return none;

  /** Is this point of my output also lit by somebody else? */
  const shared = (u, v) => {
    const world = applyH(inv, u, v);
    if (!world || !isFinite(world.x) || !isFinite(world.y)) return false;
    for (const other of peers) {
      const q = applyH(other, world.x, world.y);
      if (!q || !isFinite(q.x) || !isFinite(q.y)) continue;
      if (q.x > margin && q.x < 1 - margin && q.y > margin && q.y < 1 - margin) return true;
    }
    return false;
  };

  const median = (values) => {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  /**
   * The unbroken run of shared output starting at one edge, scanned inwards.
   * A run, not a count: a projector whose far edge happens to clip a third
   * projector must not widen the feather on the near one.
   */
  const depthsFor = (edge) => {
    const out = [];
    for (let s = 0; s < samples; s++) {
      const along = (s + 0.5) / samples;
      let depth = 0;
      for (let i = 0; i < steps; i++) {
        const into = ((i + 0.5) / steps) * maxFeather;
        const u = edge === 'left' ? into : edge === 'right' ? 1 - into : along;
        const v = edge === 'top' ? into : edge === 'bottom' ? 1 - into : along;
        if (!shared(u, v)) break;
        depth = into;
      }
      out.push(depth);
    }
    return out;
  };

  const result = {};
  for (const edge of ['top', 'right', 'bottom', 'left']) {
    const width = median(depthsFor(edge));
    // Under about two per cent of the output is a corner clip rather than a
    // seam, and feathering it would dim an edge for no reason.
    result[edge] = width < 0.02 ? 0 : Math.min(maxFeather, width);
  }
  return result;
}

/** Do two aligned projectors light any of the same wall? */
export function projectorsOverlap(a, b, samples = 13) {
  const inv = a ? mat3Inverse(a) : null;
  if (!inv || !b) return false;
  for (let i = 0; i < samples; i++) {
    for (let j = 0; j < samples; j++) {
      const world = applyH(inv, (i + 0.5) / samples, (j + 0.5) / samples);
      if (!world) continue;
      const q = applyH(b, world.x, world.y);
      if (q && q.x > 0.02 && q.x < 0.98 && q.y > 0.02 && q.y < 0.98) return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Mesh warp sampling
 * ------------------------------------------------------------------ */

/** Catmull-Rom weights, so dragging one control point bends its neighbourhood smoothly. */
function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/**
 * Sample the control-point offset field at (u, v) in 0..1.
 * `offsets` is a flat array of [dx, dy] pairs, row-major over cols x rows.
 */
export function sampleMesh(mesh, u, v) {
  if (!mesh?.enabled || !mesh.offsets?.length) return [0, 0];
  const cols = Math.max(2, mesh.cols | 0);
  const rows = Math.max(2, mesh.rows | 0);
  if (mesh.offsets.length < cols * rows * 2) return [0, 0];

  const fx = clamp(u, 0, 1) * (cols - 1);
  const fy = clamp(v, 0, 1) * (rows - 1);
  const ix = Math.min(cols - 1, Math.floor(fx));
  const iy = Math.min(rows - 1, Math.floor(fy));
  const tx = fx - ix;
  const ty = fy - iy;

  const at = (c, r, comp) => {
    const cc = clamp(c, 0, cols - 1);
    const rr = clamp(r, 0, rows - 1);
    return mesh.offsets[(rr * cols + cc) * 2 + comp] || 0;
  };

  const out = [0, 0];
  for (let comp = 0; comp < 2; comp++) {
    const col = [];
    for (let r = -1; r <= 2; r++) {
      col.push(
        catmull(at(ix - 1, iy + r, comp), at(ix, iy + r, comp), at(ix + 1, iy + r, comp), at(ix + 2, iy + r, comp), tx)
      );
    }
    out[comp] = catmull(col[0], col[1], col[2], col[3], ty);
  }
  return out;
}

/**
 * Re-address a correction mesh onto a different world space.
 *
 * The offsets are *valued* in projector space and *addressed* by position within
 * the projector's world-space region. Squaring up the wall changes what world
 * space means, which leaves the values perfectly valid and every one of the
 * addresses wrong. Rather than make somebody stand outside and recalibrate,
 * resample: walk the new grid, ask where each of its points used to live, and
 * read the old field there.
 *
 * @param {object} mesh          the existing mesh
 * @param {object} fromRegion    the region it was built against
 * @param {object} toRegion      the region it is wanted in
 * @param {(p:{x,y})=>{x,y}|null} toSource maps a new-world point to old-world
 */
export function resampleMesh(mesh, fromRegion, toRegion, toSource) {
  if (!mesh?.enabled || !mesh.offsets?.length) return mesh;
  if (!fromRegion || !toRegion || !(fromRegion.w > 0) || !(fromRegion.h > 0)) return mesh;

  const cols = Math.max(2, mesh.cols | 0);
  const rows = Math.max(2, mesh.rows | 0);
  const offsets = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const u = c / (cols - 1);
      const v = r / (rows - 1);
      const source = toSource({
        x: toRegion.x + u * toRegion.w,
        y: toRegion.y + v * toRegion.h,
      });
      const su = source ? (source.x - fromRegion.x) / fromRegion.w : u;
      const sv = source ? (source.y - fromRegion.y) / fromRegion.h : v;
      const [dx, dy] = sampleMesh(mesh, su, sv);
      offsets.push(dx, dy);
    }
  }
  return { ...mesh, cols, rows, offsets };
}

/* ------------------------------------------------------------------ *
 * Renderer
 * ------------------------------------------------------------------ */

const DEFAULT_SUBDIVISIONS = 24;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} [options]
 *   preserveDrawingBuffer - needed when something will drawImage() this canvas
 *   into another one, as the control tab's preview does. Costs a little
 *   performance, so projector outputs leave it off.
 */
export function createWarpRenderer(canvas, { preserveDrawingBuffer = false } = {}) {
  const gl =
    canvas.getContext('webgl', { alpha: false, antialias: true, preserveDrawingBuffer }) ||
    canvas.getContext('experimental-webgl', { alpha: false, preserveDrawingBuffer });
  if (!gl) throw new Error('WebGL is not available in this browser');

  const warpProgram = link(gl, VERT, FRAG, 'Warp program');
  const brightProgram = link(gl, FULLSCREEN_VERT, BRIGHTPASS_FRAG, 'Bright-pass program');
  const blurProgram = link(gl, FULLSCREEN_VERT, BLUR_FRAG, 'Blur program');
  const combineProgram = link(gl, FULLSCREEN_VERT, COMBINE_FRAG, 'Combine program');

  const loc = {
    aPos: gl.getAttribLocation(warpProgram, 'aPos'),
    aUV: gl.getAttribLocation(warpProgram, 'aUV'),
    uTex: gl.getUniformLocation(warpProgram, 'uTex'),
    uBloom: gl.getUniformLocation(warpProgram, 'uBloom'),
    uBloomAmount: gl.getUniformLocation(warpProgram, 'uBloomAmount'),
    uResolution: gl.getUniformLocation(warpProgram, 'uResolution'),
    uFeather: gl.getUniformLocation(warpProgram, 'uFeather'),
    uGamma: gl.getUniformLocation(warpProgram, 'uGamma'),
    uBrightness: gl.getUniformLocation(warpProgram, 'uBrightness'),
    uTint: gl.getUniformLocation(warpProgram, 'uTint'),
    uExposure: gl.getUniformLocation(warpProgram, 'uExposure'),
    uContrast: gl.getUniformLocation(warpProgram, 'uContrast'),
    uSaturation: gl.getUniformLocation(warpProgram, 'uSaturation'),
    uGradeGamma: gl.getUniformLocation(warpProgram, 'uGradeGamma'),
    uTonemap: gl.getUniformLocation(warpProgram, 'uTonemap'),
  };

  const brightLoc = {
    aPos: gl.getAttribLocation(brightProgram, 'aPos'),
    uTex: gl.getUniformLocation(brightProgram, 'uTex'),
    uThreshold: gl.getUniformLocation(brightProgram, 'uThreshold'),
    uKnee: gl.getUniformLocation(brightProgram, 'uKnee'),
  };
  const blurLoc = {
    aPos: gl.getAttribLocation(blurProgram, 'aPos'),
    uTex: gl.getUniformLocation(blurProgram, 'uTex'),
    uDirection: gl.getUniformLocation(blurProgram, 'uDirection'),
  };
  const combineLoc = {
    aPos: gl.getAttribLocation(combineProgram, 'aPos'),
    uNear: gl.getUniformLocation(combineProgram, 'uNear'),
    uFar: gl.getUniformLocation(combineProgram, 'uFar'),
    uFarWeight: gl.getUniformLocation(combineProgram, 'uFarWeight'),
  };

  const posBuffer = gl.createBuffer();
  const uvBuffer = gl.createBuffer();
  const indexBuffer = gl.createBuffer();

  // One oversized triangle covering clip space, for every fullscreen pass.
  const quadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  // Leave FLIP_Y off. The mesh's texture coordinates run top-down to match the
  // source canvas and the world region, so flipping on upload would mirror the
  // whole projection vertically.
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  // The world canvas has a transparent background; premultiplying on upload lets
  // the shader composite it over black with a plain multiply.
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.clearColor(0, 0, 0, 1);

  let indexCount = 0;
  let meshKey = '';
  /** The last descriptor, by identity, so the usual no-op costs one compare. */
  let lastMeshArgs = { H: undefined, region: undefined, mesh: undefined, subdivisions: undefined };
  let textureSize = { w: 0, h: 0 };

  /**
   * Bloom mip chain.
   *
   * A single blur at one resolution cannot produce a convincing halo: to spill
   * light a hundred pixels you would need a hundred-tap kernel. Instead the
   * bright-pass result is repeatedly halved, blurred a little at each level,
   * then accumulated back up. Each halving doubles the effective reach, so five
   * cheap levels cover a wide, smooth falloff — a tight core from the big
   * levels and a broad glow from the small ones.
   */
  const BLOOM_LEVELS = 5;
  let bloomChain = null;
  let bloomSourceSize = { w: 0, h: 0 };
  let bloomSupported = true;

  function ensureBloomChain(sourceW, sourceH) {
    if (bloomChain && bloomSourceSize.w === sourceW && bloomSourceSize.h === sourceH) return bloomChain;
    disposeBloomChain();

    const levels = [];
    let w = Math.max(4, Math.floor(sourceW / 2));
    let h = Math.max(4, Math.floor(sourceH / 2));

    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const a = createRenderTarget(gl, w, h);
      const b = createRenderTarget(gl, w, h);
      if (!a.complete || !b.complete) {
        // Some drivers refuse non-power-of-two colour attachments. Rather than
        // failing the whole render, drop bloom and keep projecting.
        disposeRenderTarget(gl, a);
        disposeRenderTarget(gl, b);
        for (const level of levels) {
          disposeRenderTarget(gl, level.a);
          disposeRenderTarget(gl, level.b);
        }
        bloomSupported = false;
        return null;
      }
      levels.push({ a, b, width: w, height: h });
      if (w <= 8 || h <= 8) break;
      w = Math.max(4, Math.floor(w / 2));
      h = Math.max(4, Math.floor(h / 2));
    }

    bloomChain = levels;
    bloomSourceSize = { w: sourceW, h: sourceH };
    return bloomChain;
  }

  function disposeBloomChain() {
    if (!bloomChain) return;
    for (const level of bloomChain) {
      disposeRenderTarget(gl, level.a);
      disposeRenderTarget(gl, level.b);
    }
    bloomChain = null;
    bloomSourceSize = { w: 0, h: 0 };
  }

  function drawFullscreen(program, attribLocation) {
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.enableVertexAttribArray(attribLocation);
    gl.vertexAttribPointer(attribLocation, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function renderToTarget(target, fn) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    fn();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** One separable blur step from `from` into `to`, along a single axis. */
  function blurStep(from, to, dx, dy) {
    gl.useProgram(blurProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, from.texture);
    gl.uniform1i(blurLoc.uTex, 0);
    gl.uniform2f(blurLoc.uDirection, dx, dy);
    renderToTarget(to, () => drawFullscreen(blurProgram, blurLoc.aPos));
  }

  /** Bright-pass, downsample-and-blur down the chain, then accumulate back up. */
  function buildBloom(grade) {
    const chain = ensureBloomChain(textureSize.w, textureSize.h);
    if (!chain || !chain.length) return null;

    const radius = Math.max(0.1, grade.bloomRadius ?? 1);

    // Bright-pass the source into the largest level.
    gl.useProgram(brightProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(brightLoc.uTex, 0);
    gl.uniform1f(brightLoc.uThreshold, grade.bloomThreshold ?? DEFAULT_GRADE.bloomThreshold);
    gl.uniform1f(brightLoc.uKnee, grade.bloomKnee ?? DEFAULT_GRADE.bloomKnee);
    renderToTarget(chain[0].a, () => drawFullscreen(brightProgram, brightLoc.aPos));

    // Blur each level, feeding the next one down from the level above it.
    for (let i = 0; i < chain.length; i++) {
      const level = chain[i];
      const source = i === 0 ? chain[0].a : chain[i - 1].a;
      blurStep(source, level.b, radius / level.width, 0);
      blurStep(level.b, level.a, 0, radius / level.height);
    }

    // Walk back up, adding each smaller level into the one above. The upsample
    // is free: sampling a small texture with LINEAR filtering interpolates it.
    let accumulator = chain[chain.length - 1].a;
    for (let i = chain.length - 2; i >= 0; i--) {
      const level = chain[i];
      gl.useProgram(combineProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, level.a.texture);
      gl.uniform1i(combineLoc.uNear, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, accumulator.texture);
      gl.uniform1i(combineLoc.uFar, 1);
      gl.uniform1f(combineLoc.uFarWeight, 0.8);
      renderToTarget(level.b, () => drawFullscreen(combineProgram, combineLoc.aPos));
      accumulator = level.b;
    }

    gl.activeTexture(gl.TEXTURE0);
    return accumulator;
  }

  /**
   * Rebuild the warp mesh. Cheap enough to call whenever calibration changes,
   * far too expensive to call per frame — hence the key check.
   */
  function buildMesh({ H, region, mesh, subdivisions = DEFAULT_SUBDIVISIONS, force = false }) {
    /**
     * Cheap identity check before the expensive one.
     *
     * This is called every frame by the control preview with the same arguments
     * every time, and `JSON.stringify` of the whole descriptor — a nine-element
     * matrix, a region, and a warp mesh that can carry ninety-eight offsets —
     * ran *before* the cache could reject it. Comparing the object identities
     * first settles the common case without building a string at all; the
     * stringify is only reached when something genuinely changed, or when a
     * caller passes fresh objects with equal contents.
     */
    if (!force
      && H === lastMeshArgs.H
      && region === lastMeshArgs.region
      && mesh === lastMeshArgs.mesh
      && subdivisions === lastMeshArgs.subdivisions) {
      return;
    }

    const key = JSON.stringify({ H, region, mesh, subdivisions });
    if (!force && key === meshKey) {
      lastMeshArgs = { H, region, mesh, subdivisions };
      return;
    }
    meshKey = key;
    lastMeshArgs = { H, region, mesh, subdivisions };

    const matrix = H || IDENTITY3;
    const n = mesh?.enabled ? Math.max(subdivisions, 32) : subdivisions;

    const positions = new Float32Array((n + 1) * (n + 1) * 3);
    const uvs = new Float32Array((n + 1) * (n + 1) * 2);
    const indices = new Uint16Array(n * n * 6);

    // If the plane maps with a negative denominator the whole quad is behind the
    // projector; flipping the matrix sign restores a usable orientation.
    const centre = applyH3(matrix, region.x + region.w / 2, region.y + region.h / 2);
    const flip = centre[2] < 0 ? -1 : 1;

    let vi = 0;
    let ui = 0;
    for (let row = 0; row <= n; row++) {
      const fy = row / n;
      const worldV = region.y + fy * region.h;
      for (let col = 0; col <= n; col++) {
        const fx = col / n;
        const worldU = region.x + fx * region.w;

        const [hx, hy, hw] = applyH3(matrix, worldU, worldV);
        const w = hw * flip;
        // Near-zero denominators are points on the horizon; nudging them keeps
        // the mesh finite instead of producing NaNs that kill the whole draw.
        const safeW = Math.abs(w) < 1e-6 ? 1e-6 * Math.sign(w || 1) : w;
        let s = (hx * flip) / safeW;
        let t = (hy * flip) / safeW;

        if (mesh?.enabled) {
          const [dx, dy] = sampleMesh(mesh, fx, fy);
          s += dx;
          t += dy;
        }

        positions[vi++] = s * 2 - 1;
        positions[vi++] = 1 - t * 2;
        positions[vi++] = safeW;

        uvs[ui++] = fx;
        uvs[ui++] = fy;
      }
    }

    let ii = 0;
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        const a = row * (n + 1) + col;
        const b = a + 1;
        const c = a + (n + 1);
        const d = c + 1;
        indices[ii++] = a;
        indices[ii++] = c;
        indices[ii++] = b;
        indices[ii++] = b;
        indices[ii++] = c;
        indices[ii++] = d;
      }
    }
    indexCount = ii;

    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
  }

  /** Upload the world render, build bloom, and draw the warped, graded result. */
  function draw(source, { feather, gamma = 1.8, brightness = 1, grade } = {}) {
    const width = canvas.width;
    const height = canvas.height;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!indexCount) return;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);

    // Reallocating the texture every frame makes the driver throw away and
    // recreate the backing store. Allocate once per size, then overwrite in
    // place — this runs 60 times a second for the whole show.
    if (textureSize.w !== source.width || textureSize.h !== source.height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      textureSize = { w: source.width, h: source.height };
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }

    const settings = { ...DEFAULT_GRADE, ...(grade || {}) };
    const bloomAmount = bloomSupported ? Math.max(0, settings.bloom ?? 0) : 0;
    const bloomTarget = bloomAmount > 0 ? buildBloom(settings) : null;

    // The bloom passes rebind the framebuffer and viewport; restore them.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);

    gl.useProgram(warpProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(loc.uTex, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bloomTarget ? bloomTarget.texture : texture);
    gl.uniform1i(loc.uBloom, 1);
    gl.uniform1f(loc.uBloomAmount, bloomTarget ? bloomAmount : 0);

    gl.uniform2f(loc.uResolution, width, height);
    const f = feather || { top: 0, right: 0, bottom: 0, left: 0 };
    gl.uniform4f(loc.uFeather, f.top || 0, f.right || 0, f.bottom || 0, f.left || 0);
    gl.uniform1f(loc.uGamma, gamma > 0 ? gamma : 1);
    gl.uniform1f(loc.uBrightness, brightness);

    const tint = temperatureTint(settings.temperature ?? 0);
    gl.uniform3f(loc.uTint, tint[0], tint[1], tint[2]);
    gl.uniform1f(loc.uExposure, settings.exposure ?? 1);
    gl.uniform1f(loc.uContrast, settings.contrast ?? 1);
    gl.uniform1f(loc.uSaturation, settings.saturation ?? 1);
    gl.uniform1f(loc.uGradeGamma, settings.gamma ?? 1);
    gl.uniform1f(loc.uTonemap, settings.tonemap === false ? 0 : 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.enableVertexAttribArray(loc.aPos);
    gl.vertexAttribPointer(loc.aPos, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
    gl.enableVertexAttribArray(loc.aUV);
    gl.vertexAttribPointer(loc.aUV, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0);
  }

  function clear() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  function dispose() {
    disposeBloomChain();
    gl.deleteBuffer(posBuffer);
    gl.deleteBuffer(uvBuffer);
    gl.deleteBuffer(indexBuffer);
    gl.deleteBuffer(quadBuffer);
    gl.deleteTexture(texture);
    gl.deleteProgram(warpProgram);
    gl.deleteProgram(brightProgram);
    gl.deleteProgram(blurProgram);
    gl.deleteProgram(combineProgram);
  }

  return { gl, buildMesh, draw, clear, dispose, get bloomSupported() { return bloomSupported; } };
}
