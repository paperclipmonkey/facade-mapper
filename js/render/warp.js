/**
 * Projective warp.
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
 */

import { applyH3, mat3Inverse, applyH, clamp, IDENTITY3 } from '../core/math.js';

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
uniform vec2 uResolution;
uniform vec4 uFeather;   // top, right, bottom, left, in fractions of the output
uniform float uGamma;
uniform float uBrightness;

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
  vec4 c = texture2D(uTex, vUV);

  // Soft-edge blending is computed in real output pixels, which is what matters
  // when two projectors overlap on the same wall.
  vec2 p = gl_FragCoord.xy / uResolution;
  float f = ramp(1.0 - p.y, uFeather.x)
          * ramp(1.0 - p.x, uFeather.y)
          * ramp(p.y, uFeather.z)
          * ramp(p.x, uFeather.w);
  f = pow(f, uGamma);

  gl_FragColor = vec4(c.rgb * f * uBrightness, 1.0);
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

/* ------------------------------------------------------------------ *
 * Renderer
 * ------------------------------------------------------------------ */

const DEFAULT_SUBDIVISIONS = 24;

export function createWarpRenderer(canvas) {
  const gl =
    canvas.getContext('webgl', { alpha: false, antialias: true, preserveDrawingBuffer: false }) ||
    canvas.getContext('experimental-webgl', { alpha: false });
  if (!gl) throw new Error('WebGL is not available in this browser');

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Warp program failed to link: ${gl.getProgramInfoLog(program)}`);
  }
  gl.useProgram(program);

  const loc = {
    aPos: gl.getAttribLocation(program, 'aPos'),
    aUV: gl.getAttribLocation(program, 'aUV'),
    uTex: gl.getUniformLocation(program, 'uTex'),
    uResolution: gl.getUniformLocation(program, 'uResolution'),
    uFeather: gl.getUniformLocation(program, 'uFeather'),
    uGamma: gl.getUniformLocation(program, 'uGamma'),
    uBrightness: gl.getUniformLocation(program, 'uBrightness'),
  };

  const posBuffer = gl.createBuffer();
  const uvBuffer = gl.createBuffer();
  const indexBuffer = gl.createBuffer();

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

  /**
   * Rebuild the warp mesh. Cheap enough to call whenever calibration changes,
   * far too expensive to call per frame — hence the key check.
   */
  function buildMesh({ H, region, mesh, subdivisions = DEFAULT_SUBDIVISIONS, force = false }) {
    const key = JSON.stringify({ H, region, mesh, subdivisions });
    if (!force && key === meshKey) return;
    meshKey = key;

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

  let textureSize = { w: 0, h: 0 };

  /** Upload the world render and draw the warped result. */
  function draw(source, { feather, gamma = 1.8, brightness = 1 } = {}) {
    const width = canvas.width;
    const height = canvas.height;
    gl.viewport(0, 0, width, height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!indexCount) return;

    gl.useProgram(program);
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
    gl.uniform1i(loc.uTex, 0);

    gl.uniform2f(loc.uResolution, width, height);
    const f = feather || { top: 0, right: 0, bottom: 0, left: 0 };
    gl.uniform4f(loc.uFeather, f.top || 0, f.right || 0, f.bottom || 0, f.left || 0);
    gl.uniform1f(loc.uGamma, gamma > 0 ? gamma : 1);
    gl.uniform1f(loc.uBrightness, brightness);

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
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  function dispose() {
    gl.deleteBuffer(posBuffer);
    gl.deleteBuffer(uvBuffer);
    gl.deleteBuffer(indexBuffer);
    gl.deleteTexture(texture);
    gl.deleteProgram(program);
  }

  return { gl, buildMesh, draw, clear, dispose };
}
