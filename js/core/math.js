/**
 * Geometry + linear algebra helpers.
 *
 * The one thing worth understanding here is the homography. A projector aimed at a
 * flat-ish wall and a camera looking at that same wall see the same plane from two
 * different places. Any two views of a plane are related by a 3x3 projective matrix,
 * so once we know that matrix we can convert "where it is in the camera image" into
 * "where the projector must draw it" — which is the entire trick behind auto-alignment.
 *
 * Coordinate conventions used across the app:
 *   world space     - normalised camera frame, u,v in [0,1]
 *   projector space - normalised projector output, s,t in [0,1]
 *   H maps world -> projector.
 */

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const TAU = Math.PI * 2;

/** Wrap into [0,1). Handles negatives, unlike a bare `%`. */
export function frac(x) {
  return x - Math.floor(x);
}

export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0 || 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
}

/* ------------------------------------------------------------------ *
 * 3x3 matrices, stored row-major as a flat array of 9 numbers.
 * ------------------------------------------------------------------ */

export const IDENTITY3 = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]);

export function mat3Mul(a, b) {
  const out = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] =
        a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

export function mat3Inverse(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!isFinite(det) || Math.abs(det) < 1e-14) return null;
  const inv = 1 / det;
  return [
    A * inv, (c * h - b * i) * inv, (b * f - c * e) * inv,
    B * inv, (a * i - c * g) * inv, (c * d - a * f) * inv,
    C * inv, (b * g - a * h) * inv, (a * e - b * d) * inv,
  ];
}

/**
 * Apply a homography to a point. Returns null when the point maps to (or past)
 * the horizon, where the projective divide blows up.
 */
export function applyH(m, x, y) {
  const w = m[6] * x + m[7] * y + m[8];
  if (Math.abs(w) < 1e-12) return null;
  return { x: (m[0] * x + m[1] * y + m[2]) / w, y: (m[3] * x + m[4] * y + m[5]) / w, w };
}

/** Like applyH but keeps the homogeneous w, which the WebGL warp needs. */
export function applyH3(m, x, y) {
  return [
    m[0] * x + m[1] * y + m[2],
    m[3] * x + m[4] * y + m[5],
    m[6] * x + m[7] * y + m[8],
  ];
}

/* ------------------------------------------------------------------ *
 * Symmetric eigen-decomposition (cyclic Jacobi).
 *
 * Used instead of a full SVD: solving a homography by DLT means finding the
 * null-space of A, which is the eigenvector of A'A with the smallest eigenvalue.
 * A'A is symmetric, and Jacobi on a 9x9 is both short and numerically solid.
 * ------------------------------------------------------------------ */

function jacobiEigen(Ain, n, sweeps = 60) {
  const A = Ain.slice();
  const V = new Float64Array(n * n);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;

  for (let sweep = 0; sweep < sweeps; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) off += A[p * n + q] * A[p * n + q];
    }
    if (off < 1e-24) break;

    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = A[p * n + q];
        if (Math.abs(apq) < 1e-30) continue;
        const theta = (A[q * n + q] - A[p * n + p]) / (2 * apq);
        const t =
          Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k * n + p];
          const akq = A[k * n + q];
          A[k * n + p] = c * akp - s * akq;
          A[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p * n + k];
          const aqk = A[q * n + k];
          A[p * n + k] = c * apk - s * aqk;
          A[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k * n + p];
          const vkq = V[k * n + q];
          V[k * n + p] = c * vkp - s * vkq;
          V[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }

  const values = new Array(n);
  for (let i = 0; i < n; i++) values[i] = A[i * n + i];
  return { values, vectors: V };
}

/**
 * Eigenvector belonging to the smallest eigenvalue of a symmetric matrix.
 *
 * Also returns the second-smallest and largest eigenvalues. Those are what tell
 * us whether the answer means anything: if the second-smallest is also
 * effectively zero, the null space has more than one dimension and any vector in
 * it "solves" the system equally well. The caller uses that to reject degenerate
 * point configurations instead of returning a confident-looking wrong matrix.
 */
function smallestEigenvector(A, n) {
  const { values, vectors } = jacobiEigen(A, n);
  const order = [...values.keys()].sort((a, b) => values[a] - values[b]);
  const best = order[0];
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = vectors[i * n + best];
  return {
    vector: out,
    lambda: values[order[0]],
    lambda2: values[order[1]],
    lambdaMax: values[order[n - 1]],
  };
}

/* ------------------------------------------------------------------ *
 * Homography estimation (normalised DLT)
 * ------------------------------------------------------------------ */

/**
 * Hartley normalisation: shift points to have zero mean and scale so the mean
 * distance from the origin is sqrt(2). Without this, the DLT system is badly
 * conditioned and the resulting homography visibly drifts at the frame edges.
 */
function normalisePoints(pts) {
  const n = pts.length;
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
  }
  cx /= n;
  cy /= n;

  let mean = 0;
  for (const p of pts) mean += Math.hypot(p.x - cx, p.y - cy);
  mean /= n;

  const scale = mean > 1e-12 ? Math.SQRT2 / mean : 1;
  const T = [scale, 0, -scale * cx, 0, scale, -scale * cy, 0, 0, 1];
  const out = pts.map((p) => ({ x: (p.x - cx) * scale, y: (p.y - cy) * scale }));
  return { T, pts: out };
}

/**
 * Solve for H such that H * src ~= dst, in a least-squares sense.
 * Needs at least 4 correspondences; more is better and is what the
 * 3x3 calibration marker grid provides.
 *
 * @returns {number[]|null} row-major 3x3, normalised so H[8] === 1 where possible
 */
export function solveHomography(srcPts, dstPts) {
  const n = Math.min(srcPts.length, dstPts.length);
  if (n < 4) return null;

  const { T: T1, pts: src } = normalisePoints(srcPts.slice(0, n));
  const { T: T2, pts: dst } = normalisePoints(dstPts.slice(0, n));

  // Build A'A directly (9x9) rather than materialising the 2n x 9 A matrix.
  const AtA = new Float64Array(81);
  const row = new Float64Array(9);
  const accumulate = () => {
    for (let i = 0; i < 9; i++) {
      if (row[i] === 0) continue;
      for (let j = 0; j < 9; j++) AtA[i * 9 + j] += row[i] * row[j];
    }
  };

  for (let k = 0; k < n; k++) {
    const { x, y } = src[k];
    const { x: X, y: Y } = dst[k];

    row.set([-x, -y, -1, 0, 0, 0, X * x, X * y, X]);
    accumulate();
    row.set([0, 0, 0, -x, -y, -1, Y * x, Y * y, Y]);
    accumulate();
  }

  const { vector: h, lambda2, lambdaMax } = smallestEigenvector(AtA, 9);
  if (!h.every((v) => isFinite(v))) return null;

  // A unique solution needs a one-dimensional null space. When the second
  // smallest eigenvalue is also ~0 the configuration is degenerate — four points
  // with three on a line, say — and every vector in that space fits the given
  // points while mapping everything else somewhere arbitrary. Refusing here is
  // what turns a silently wrong projection into a visible error message.
  if (!(lambdaMax > 0) || lambda2 < 1e-9 * lambdaMax) return null;

  const Hn = h.slice();
  const T2inv = mat3Inverse(T2);
  if (!T2inv) return null;

  let H = mat3Mul(T2inv, mat3Mul(Hn, T1));

  // Normalise scale so matrices compare and serialise cleanly.
  const denom = H[8];
  if (Math.abs(denom) > 1e-12) H = H.map((v) => v / denom);
  return H.every((v) => isFinite(v)) ? H : null;
}

/** Mean and worst reprojection error, in destination units. */
export function homographyError(H, srcPts, dstPts) {
  let sum = 0;
  let max = 0;
  let count = 0;
  for (let i = 0; i < srcPts.length; i++) {
    const p = applyH(H, srcPts[i].x, srcPts[i].y);
    if (!p) continue;
    const e = Math.hypot(p.x - dstPts[i].x, p.y - dstPts[i].y);
    sum += e;
    if (e > max) max = e;
    count++;
  }
  return { mean: count ? sum / count : Infinity, max, count };
}

/* ------------------------------------------------------------------ *
 * Polylines and paths
 * ------------------------------------------------------------------ */

export function boundingBox(points) {
  if (!points.length) return { x: 0, y: 0, w: 0, h: 0, cx: 0, cy: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
  };
}

export function polygonArea(points) {
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    a += points[j].x * points[i].y - points[i].x * points[j].y;
  }
  return a / 2;
}

export function polygonCentroid(points) {
  const a = polygonArea(points);
  if (Math.abs(a) < 1e-12) {
    const bb = boundingBox(points);
    return { x: bb.cx, y: bb.cy };
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const f = points[j].x * points[i].y - points[i].x * points[j].y;
    cx += (points[j].x + points[i].x) * f;
    cy += (points[j].y + points[i].y) * f;
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

export function pointInPolygon(pt, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x;
    const yi = points[i].y;
    const xj = points[j].x;
    const yj = points[j].y;
    if (yi > pt.y !== yj > pt.y && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi || 1e-12) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1) : 0;
  return { dist: Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)), t };
}

/**
 * Catmull-Rom through the given points, resampled into a dense polyline.
 * Used for "smooth" shapes so a chase running round a curved arch doesn't
 * visibly hop between vertices.
 */
export function smoothPolyline(points, closed, segmentsPerSpan = 12) {
  const n = points.length;
  if (n < 3) return points.slice();
  const at = (i) => {
    if (closed) return points[((i % n) + n) % n];
    return points[clamp(i, 0, n - 1)];
  };
  const out = [];
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    for (let s = 0; s < segmentsPerSpan; s++) {
      const t = s / segmentsPerSpan;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  if (!closed) out.push(points[n - 1]);
  return out;
}

/**
 * Arc-length table for a polyline, so effects can ask for "the point 30% of the
 * way round this window" and get an evenly-spaced answer regardless of how the
 * vertices happen to be distributed.
 */
export function buildPathSampler(points, closed) {
  const pts = points.slice();
  if (closed && pts.length > 1) pts.push(pts[0]);

  const cum = [0];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    cum.push(total);
  }

  /** @param {number} t 0..1 along the path (wraps when closed) */
  function at(t) {
    if (pts.length === 0) return { x: 0, y: 0, angle: 0 };
    if (pts.length === 1 || total <= 0) return { x: pts[0].x, y: pts[0].y, angle: 0 };
    const tt = closed ? frac(t) : clamp(t, 0, 1);
    const target = tt * total;

    // Binary search the cumulative-length table.
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= target) lo = mid;
      else hi = mid;
    }
    const span = cum[hi] - cum[lo] || 1e-9;
    const f = (target - cum[lo]) / span;
    const a = pts[lo];
    const b = pts[hi];
    return {
      x: lerp(a.x, b.x, f),
      y: lerp(a.y, b.y, f),
      angle: Math.atan2(b.y - a.y, b.x - a.x),
    };
  }

  return { at, length: total, points: pts };
}

/* ------------------------------------------------------------------ *
 * Colour
 * ------------------------------------------------------------------ */

export function hexToRgb(hex) {
  const h = String(hex || '#000000').replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full.slice(0, 6), 16);
  if (!isFinite(n)) return { r: 0, g: 0, b: 0 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgba(hex, alpha = 1) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${clamp(alpha, 0, 1)})`;
}

export function mixHex(a, b, t) {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  const to = (v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');
  return `#${to(lerp(A.r, B.r, t))}${to(lerp(A.g, B.g, t))}${to(lerp(A.b, B.b, t))}`;
}

/* ------------------------------------------------------------------ *
 * Deterministic randomness
 *
 * Effects run independently in every projector tab. If they used Math.random()
 * the same snowflake would land in two different places on two projectors that
 * overlap. Seeded generators keep every tab's output identical.
 * ------------------------------------------------------------------ */

export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 - small, fast, good enough for visuals. */
export function makeRng(seed) {
  let a = (typeof seed === 'string' ? hashString(seed) : seed >>> 0) || 1;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
