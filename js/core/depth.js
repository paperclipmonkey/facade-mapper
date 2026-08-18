/**
 * The building as a surface, rather than as an outline.
 *
 * Everything the app knows about the house so far, somebody traced by hand over
 * a photograph. That is a remarkably good deal — four clicks buys you a window
 * that effects can light, bounce off and creep around — but it buys an *outline*
 * and nothing else. The wall inside it is assumed flat, the reveal around the
 * glass does not exist, and a lit sill is a rectangle somebody remembered to
 * draw.
 *
 * A depth scan changes what is being reasoned about. A window is not a shape on
 * a wall; it is the part of the wall that is set back a hundred millimetres, and
 * that is true in the dark, under ivy, and behind a hedge, none of which an edge
 * detector run on the photograph survives. So the primitive here is not depth —
 * it is *relief*: how far each point of the facade stands in front of, or behind,
 * the plane of the wall itself.
 *
 *     relief = 0      the wall
 *     relief < 0      set back  — window glass, doorway, an air brick
 *     relief > 0      standing proud — sill, lintel, porch, drainpipe, bay
 *
 * Two things fall out of that, and they are the reason this file exists:
 *
 *  - **Openings trace themselves.** A window is a connected region of negative
 *    relief with an area of about a square metre. Threshold, label, walk the
 *    boundary, and you have the polygon the user was going to draw, in the right
 *    place, square, and with a sensible guess at its tag.
 *
 *  - **The facade can be lit rather than painted.** Relief differentiates into a
 *    surface normal per pixel, and a normal is all a lighting model wants. Put a
 *    virtual lantern in front of the house and every reveal, sill and buttress
 *    shades correctly, because the shading is computed from the geometry that is
 *    actually there. That is the difference between a picture of a lantern and
 *    the house appearing to be lit by one.
 *
 * Relief is measured in metres and sampled on a grid that is square *on the
 * wall* — an orthographic view along the wall's own normal. That is deliberate:
 * it is the same space `core/rectify.js` builds when somebody marks a rectangle
 * and types its real size, so anything found here can be handed to the rest of
 * the app as ordinary world coordinates. The scan supplies for free the one fact
 * a single photograph cannot: the plane's actual pose, in metres.
 *
 * Nothing in here touches the DOM, a canvas or a project. It is arrays in,
 * arrays out, so it runs under Node in the tests.
 */

/* ------------------------------------------------------------------ *
 * Vectors
 *
 * Three-component, as plain arrays. Small enough that a helper library would
 * cost more to read than the arithmetic it replaces.
 * ------------------------------------------------------------------ */

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

function normalise3(v) {
  const len = Math.hypot(v[0], v[1], v[2]);
  return len > 1e-12 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 1];
}

/* ------------------------------------------------------------------ *
 * The wall plane
 * ------------------------------------------------------------------ */

/**
 * Eigenvectors of a symmetric 3x3, by cyclic Jacobi rotation.
 *
 * Wanted for one thing only: the least-squares plane through a set of points is
 * the eigenvector of their covariance with the smallest eigenvalue. The closed
 * form via the characteristic cubic is shorter to write and loses most of its
 * significant figures on exactly the input that matters here — a nearly planar
 * cloud, where two eigenvalues are large and equal-ish and the third is the
 * answer. Jacobi is unconditionally stable and this runs once per scan.
 *
 * @returns {{values:number[], vectors:number[][]}} vectors[i] belongs to values[i]
 */
export function symmetricEigen3(m) {
  // Working copy of the matrix, row-major, and the accumulated rotation.
  const a = m.slice();
  let v = [1, 0, 0, 0, 1, 0, 0, 0, 1];

  for (let sweep = 0; sweep < 24; sweep++) {
    const off = a[1] * a[1] + a[2] * a[2] + a[5] * a[5];
    if (off < 1e-24) break;

    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      const apq = a[p * 3 + q];
      if (Math.abs(apq) < 1e-18) continue;
      const app = a[p * 3 + p];
      const aqq = a[q * 3 + q];

      // The rotation that zeroes this off-diagonal entry, via the stable form
      // of tan(theta) — the quadratic root nearer zero, so no cancellation.
      const theta = (aqq - app) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;

      for (let k = 0; k < 3; k++) {
        const akp = a[k * 3 + p];
        const akq = a[k * 3 + q];
        a[k * 3 + p] = c * akp - s * akq;
        a[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p * 3 + k];
        const aqk = a[q * 3 + k];
        a[p * 3 + k] = c * apk - s * aqk;
        a[q * 3 + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p];
        const vkq = v[k * 3 + q];
        v[k * 3 + p] = c * vkp - s * vkq;
        v[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }

  const values = [a[0], a[4], a[8]];
  const vectors = [0, 1, 2].map((i) => [v[i], v[3 + i], v[6 + i]]);
  const order = [0, 1, 2].sort((i, j) => values[i] - values[j]);
  return { values: order.map((i) => values[i]), vectors: order.map((i) => vectors[i]) };
}

/** Least-squares plane through a set of points, as { n, d } with n a unit normal. */
export function planeThrough(points, indices) {
  const list = indices || points.map((_, i) => i);
  const count = list.length;
  if (count < 3) return null;

  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const i of list) {
    cx += points[i][0];
    cy += points[i][1];
    cz += points[i][2];
  }
  cx /= count;
  cy /= count;
  cz /= count;

  const cov = new Float64Array(9);
  for (const i of list) {
    const x = points[i][0] - cx;
    const y = points[i][1] - cy;
    const z = points[i][2] - cz;
    cov[0] += x * x; cov[1] += x * y; cov[2] += x * z;
    cov[4] += y * y; cov[5] += y * z;
    cov[8] += z * z;
  }
  cov[3] = cov[1];
  cov[6] = cov[2];
  cov[7] = cov[5];

  const { vectors } = symmetricEigen3(Array.from(cov));
  const n = normalise3(vectors[0]);
  return { n, d: dot3(n, [cx, cy, cz]), centroid: [cx, cy, cz], count };
}

/** Signed distance from a point to a plane. Positive is the side `n` points to. */
export const planeDistance = (plane, p) => dot3(plane.n, p) - plane.d;

/**
 * The dominant plane in a point cloud, by RANSAC.
 *
 * A facade scan is not only the facade: there is ground in front of it, a hedge,
 * the return walls, sky-coloured noise where the photogrammetry gave up. A
 * least-squares fit to all of it tilts towards whatever happens to be biggest
 * and lands nowhere in particular. RANSAC asks the only question worth asking —
 * *which* plane has the most points on it — and then refits to those.
 *
 * `tolerance` is in metres and is the interesting knob: it is the answer to "how
 * far out of plane can brickwork be and still be the wall", and 25mm is about
 * right for a real house. Too tight and the render pass hunts one course of
 * bricks; too loose and it swallows the window reveals it exists to find.
 */
export function fitPlane(points, { tolerance = 0.025, iterations = 200, seed = 1, maxSamples = 40000 } = {}) {
  if (points.length < 3) return null;

  /**
   * Score each candidate against a subsample, refit against everything.
   *
   * A scan of a house is a million points and the loop below is quadratic in
   * the wrong way — every candidate plane is measured against every point. But
   * counting inliers is estimating a proportion, and a proportion does not get
   * meaningfully better past a few tens of thousands of samples. The precision
   * comes from the least-squares refit at the end, which does see all of them.
   */
  const stride = Math.max(1, Math.ceil(points.length / maxSamples));
  const sample = stride === 1 ? points : points.filter((_, i) => i % stride === 0);

  // Deterministic sampling. The whole app takes the view that the same input
  // must produce the same show, and "the auto-trace found a different set of
  // windows this time" would be an unpleasant way to discover otherwise.
  let s = seed >>> 0 || 1;
  const rand = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  const pick = () => (rand() * sample.length) | 0;

  let best = null;
  let bestCount = 0;

  for (let i = 0; i < iterations; i++) {
    const a = sample[pick()];
    const b = sample[pick()];
    const c = sample[pick()];
    const n = cross3(sub3(b, a), sub3(c, a));
    const len = Math.hypot(n[0], n[1], n[2]);
    // Three nearly collinear samples describe a plane only in the sense that
    // infinitely many contain them.
    if (len < 1e-9) continue;
    const plane = { n: [n[0] / len, n[1] / len, n[2] / len], d: 0 };
    plane.d = dot3(plane.n, a);

    let count = 0;
    for (let k = 0; k < sample.length; k++) {
      if (Math.abs(planeDistance(plane, sample[k])) < tolerance) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      best = plane;
    }
  }
  if (!best) return null;

  // Refit to the consensus set: RANSAC finds the right *plane*, from three
  // points, which is to say it finds the right plane with the accuracy of three
  // points. The least-squares pass over every inlier is what makes it precise.
  const inliers = [];
  for (let k = 0; k < points.length; k++) {
    if (Math.abs(planeDistance(best, points[k])) < tolerance) inliers.push(k);
  }
  const refined = planeThrough(points, inliers) || best;
  refined.inliers = inliers.length;
  refined.total = points.length;
  return refined;
}

/**
 * Point the plane's normal outwards, at where the camera must have been.
 *
 * A plane fit has no opinion about which of its two sides is the front, and
 * getting it wrong turns every window into a bay and every sill into a slot.
 * A scan does know, implicitly, in two ways: its triangles are wound so their
 * normals face the scanner, and everything it captured is a surface the scanner
 * could see. Prefer the winding when there is any; fall back to putting the bulk
 * of the cloud behind the wall, which is what a building is.
 */
export function orientPlane(plane, { meshNormal, points } = {}) {
  let sign = 0;
  if (meshNormal) sign = Math.sign(dot3(plane.n, meshNormal));
  if (!sign && points?.length) {
    let front = 0;
    for (const p of points) if (planeDistance(plane, p) > 0) front++;
    sign = front * 2 < points.length ? 1 : -1;
  }
  if (sign < 0) return { ...plane, n: plane.n.map((v) => -v), d: -plane.d };
  return plane;
}

/**
 * Right and up vectors for the wall, given which way is up in the scan.
 *
 * Level, not arbitrary: brick courses are horizontal and so are window heads,
 * and a relief map rotated three degrees produces shapes that are all very
 * slightly diamonds. Taking world up and removing the component along the wall
 * normal gives the steepest uphill direction *on the wall*, which is the one the
 * builder used.
 */
export function planeBasis(plane, up = [0, 1, 0]) {
  let u = sub3(up, plane.n.map((v) => v * dot3(up, plane.n)));
  // A ceiling or a floor: up lies along the normal and there is no uphill. Any
  // consistent choice will do, so take an axis the normal is not parallel to.
  if (Math.hypot(u[0], u[1], u[2]) < 1e-6) {
    const alt = Math.abs(plane.n[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
    u = sub3(alt, plane.n.map((v) => v * dot3(alt, plane.n)));
  }
  u = normalise3(u);
  const r = normalise3(cross3(u, plane.n));
  return { right: r, up: u, normal: plane.n.slice() };
}

/* ------------------------------------------------------------------ *
 * The relief map
 *
 * An orthographic view of the wall, along its own normal, at a fixed number of
 * millimetres per pixel. Square on the building rather than square in the
 * photograph, which is what makes everything downstream metric: a region's area
 * is in square metres, a threshold is in millimetres, and "is that a door" is a
 * question about a real object rather than about pixels.
 * ------------------------------------------------------------------ */

/** Nothing was seen here. NaN rather than 0, because 0 is a legitimate relief. */
const EMPTY = NaN;

export function createRelief(w, h, meta = {}) {
  const data = new Float32Array(w * h);
  data.fill(EMPTY);
  return {
    w,
    h,
    data,
    /** Size of one pixel on the wall, in metres. */
    scale: meta.scale || 1,
    /** Wall coordinates of pixel (0,0), in metres, relative to the plane origin. */
    originX: meta.originX || 0,
    originY: meta.originY || 0,
    plane: meta.plane || null,
    basis: meta.basis || null,
    at(x, y) {
      if (x < 0 || y < 0 || x >= w || y >= h) return EMPTY;
      return data[y * w + x];
    },
  };
}

export const isSeen = (v) => v === v;

/**
 * Rasterise a triangle mesh into a relief map, orthographically along the wall
 * normal.
 *
 * A depth buffer that keeps the *nearest* surface to the viewer, where the
 * viewer is at infinity out in front of the wall — so the porch roof wins over
 * the wall behind it, and the wall wins over the back of the house. Sorting
 * would give the same answer and cost more; a max test per pixel is the whole
 * of it.
 *
 * Triangles are handed over as flat vertex positions plus optional indices,
 * which is exactly how a glTF stores them, so nothing has to be repacked.
 *
 * @param {{positions:Float32Array|number[], indices?:Uint32Array|number[]}} mesh
 * @param {object} plane  from fitPlane, already oriented
 * @param {object} options  resolution: longest side in pixels; up: world up
 */
export function bakeRelief(mesh, plane, { resolution = 512, up = [0, 1, 0], margin = 0 } = {}) {
  const { positions } = mesh;
  const indices = mesh.indices || null;
  const vertexCount = positions.length / 3;
  const triangleCount = indices ? indices.length / 3 : vertexCount / 3;
  if (triangleCount < 1) return null;

  const basis = planeBasis(plane, up);
  const { right, up: upv, normal } = basis;

  // Every vertex, once, in wall coordinates: across, up, and out of the wall.
  const sx = new Float32Array(vertexCount);
  const sy = new Float32Array(vertexCount);
  const sz = new Float32Array(vertexCount);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const a = x * right[0] + y * right[1] + z * right[2];
    const b = x * upv[0] + y * upv[1] + z * upv[2];
    const c = x * normal[0] + y * normal[1] + z * normal[2] - plane.d;
    sx[i] = a;
    sy[i] = b;
    sz[i] = c;
    if (a < minX) minX = a;
    if (a > maxX) maxX = a;
    if (b < minY) minY = b;
    if (b > maxY) maxY = b;
  }

  const spanX = (maxX - minX) || 1e-3;
  const spanY = (maxY - minY) || 1e-3;
  minX -= spanX * margin;
  maxX += spanX * margin;
  minY -= spanY * margin;
  maxY += spanY * margin;

  const width = maxX - minX;
  const height = maxY - minY;
  const scale = Math.max(width, height) / resolution;
  const w = Math.max(2, Math.round(width / scale));
  const h = Math.max(2, Math.round(height / scale));

  const relief = createRelief(w, h, { scale, originX: minX, originY: minY, plane, basis });
  const data = relief.data;

  // Image y runs down while the wall's y runs up, so the eaves are at the top of
  // the picture. Everything that reads a relief map — the tracer, the normals,
  // the app's own world space — assumes that.
  const toPx = (a) => (a - minX) / scale;
  const toPy = (b) => (maxY - b) / scale;

  for (let t = 0; t < triangleCount; t++) {
    const i0 = indices ? indices[t * 3] : t * 3;
    const i1 = indices ? indices[t * 3 + 1] : t * 3 + 1;
    const i2 = indices ? indices[t * 3 + 2] : t * 3 + 2;

    const ax = toPx(sx[i0]);
    const ay = toPy(sy[i0]);
    const bx = toPx(sx[i1]);
    const by = toPy(sy[i1]);
    const cx = toPx(sx[i2]);
    const cy = toPy(sy[i2]);

    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    // Edge-on to the wall: it covers no pixels here, and dividing by its area
    // would spray infinities across the buffer.
    if (Math.abs(area) < 1e-9) continue;

    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy)));
    if (x1 < x0 || y1 < y0) continue;

    const az = sz[i0];
    const bz = sz[i1];
    const cz = sz[i2];

    for (let py = y0; py <= y1; py++) {
      const y = py + 0.5;
      for (let px = x0; px <= x1; px++) {
        const x = px + 0.5;
        // Barycentric weights by edge function, normalised by the signed area,
        // so the sign of the winding drops out and back faces rasterise too.
        const wa = ((bx - x) * (cy - y) - (by - y) * (cx - x)) / area;
        const wb = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) / area;
        const wc = 1 - wa - wb;
        if (wa < 0 || wb < 0 || wc < 0) continue;

        const z = wa * az + wb * bz + wc * cz;
        const idx = py * w + px;
        const prev = data[idx];
        if (!isSeen(prev) || z > prev) data[idx] = z;
      }
    }
  }

  return relief;
}

/**
 * Close the small gaps a scan leaves behind.
 *
 * Glass is the reason. A photogrammetry pass has nothing to match on a window
 * pane and a LiDAR pass gets no return from it, so the middle of every opening
 * comes back empty — precisely the regions this file exists to find, arriving as
 * holes rather than as depth. Growing the known values inwards a few pixels at a
 * time fills them from their own reveals, which is the correct answer: the pane
 * really is at about the depth of the frame it sits in.
 *
 * Bounded on purpose. Beyond a few centimetres of wall it stops being inference
 * and starts being invention, and a relief map that quietly invents a facade
 * where the scan saw sky is worse than one with holes in it.
 */
export function fillHoles(relief, passes = 8) {
  const { w, h, data } = relief;
  const next = new Float32Array(data.length);
  for (let pass = 0; pass < passes; pass++) {
    next.set(data);
    let filled = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (isSeen(data[idx])) continue;
        let sum = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const v = data[ny * w + nx];
            if (isSeen(v)) {
              sum += v;
              count++;
            }
          }
        }
        // Three neighbours, not one: a single known pixel is as likely to be
        // noise at the edge of the scan as it is to be a surface worth growing.
        if (count >= 3) {
          next[idx] = sum / count;
          filled++;
        }
      }
    }
    data.set(next);
    if (!filled) break;
  }
  return relief;
}

/**
 * Surface normals, in wall space, from the relief map.
 *
 * A central difference in each axis gives the two tangents of the surface, and
 * their cross product is the normal — the ordinary heightfield derivation, with
 * the one wrinkle that the height is in metres and the step is in metres too, so
 * the gradient is dimensionless and the normal comes out correct at any
 * resolution rather than merely consistent.
 *
 * Returned interleaved xyz per pixel, in the same order a WebGL texture wants,
 * with z out of the wall towards the viewer.
 */
export function normalsFromRelief(relief) {
  const { w, h, data, scale } = relief;
  const out = new Float32Array(w * h * 3);
  const sample = (x, y) => {
    const cx = x < 0 ? 0 : x >= w ? w - 1 : x;
    const cy = y < 0 ? 0 : y >= h ? h - 1 : y;
    const v = data[cy * w + cx];
    return isSeen(v) ? v : 0;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dzdx = (sample(x + 1, y) - sample(x - 1, y)) / (2 * scale);
      // Image y runs down, wall y runs up: the sign flip keeps a sill's top
      // face pointing at the sky rather than at the ground.
      const dzdy = (sample(x, y - 1) - sample(x, y + 1)) / (2 * scale);
      const len = Math.hypot(dzdx, dzdy, 1);
      const i = (y * w + x) * 3;
      out[i] = -dzdx / len;
      out[i + 1] = -dzdy / len;
      out[i + 2] = 1 / len;
    }
  }
  return out;
}

/**
 * Put zero on the wall.
 *
 * The plane fit is a least-squares answer to "where is the wall", and a
 * least-squares answer is pulled about by everything that is not wall — the
 * porch, the bay, a wheelie bin. That does not matter for the *orientation*,
 * which is what the fit is really for and which the whole facade agrees about,
 * but it does put the zero a centimetre or two out. Since every threshold below
 * is measured from zero, that centimetre is the difference between finding the
 * windows and finding the windows and half the brickwork.
 *
 * So take the mode instead of the mean: the most common relief on a wall is the
 * wall. Histogram at millimetre resolution and shift.
 */
export function levelRelief(relief, { binSize = 0.002 } = {}) {
  const { data } = relief;
  const bins = new Map();
  let best = 0;
  let bestKey = null;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (!isSeen(v)) continue;
    const key = Math.round(v / binSize);
    const count = (bins.get(key) || 0) + 1;
    bins.set(key, count);
    if (count > best) {
      best = count;
      bestKey = key;
    }
  }
  if (bestKey === null) return relief;

  // Refine within the winning bin and its neighbours, so the shift is not
  // quantised to the histogram — a 2mm step in the zero is visible as a fringe
  // of spurious relief right along a threshold.
  let sum = 0;
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (!isSeen(v)) continue;
    if (Math.abs(Math.round(v / binSize) - bestKey) <= 1) {
      sum += v;
      count++;
    }
  }
  const zero = count ? sum / count : bestKey * binSize;
  for (let i = 0; i < data.length; i++) {
    if (isSeen(data[i])) data[i] -= zero;
  }
  if (relief.plane) relief.plane = { ...relief.plane, d: relief.plane.d + zero };
  return relief;
}

/* ------------------------------------------------------------------ *
 * Finding the openings
 * ------------------------------------------------------------------ */

/**
 * Connected regions of the mask, 4-connected, as label ids.
 *
 * Four rather than eight on purpose: eight-connectivity joins regions that touch
 * only at a corner, and on a facade that is two windows either side of a mullion
 * becoming one window with a pinch in the middle.
 */
function label(mask, w, h, minPixels) {
  const labels = new Int32Array(w * h).fill(-1);
  const regions = [];
  const queue = new Int32Array(w * h);

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start] >= 0) continue;
    const id = regions.length;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    labels[start] = id;
    const pixels = [];

    while (head < tail) {
      const idx = queue[head++];
      pixels.push(idx);
      const x = idx % w;
      const y = (idx / w) | 0;
      if (x > 0 && mask[idx - 1] && labels[idx - 1] < 0) { labels[idx - 1] = id; queue[tail++] = idx - 1; }
      if (x < w - 1 && mask[idx + 1] && labels[idx + 1] < 0) { labels[idx + 1] = id; queue[tail++] = idx + 1; }
      if (y > 0 && mask[idx - w] && labels[idx - w] < 0) { labels[idx - w] = id; queue[tail++] = idx - w; }
      if (y < h - 1 && mask[idx + w] && labels[idx + w] < 0) { labels[idx + w] = id; queue[tail++] = idx + w; }
    }

    if (pixels.length >= minPixels) regions.push({ id, pixels });
    else for (const idx of pixels) labels[idx] = -1;
  }
  return regions;
}

/**
 * The outline of a set of pixels, as a polygon on the pixel lattice.
 *
 * Traced along the cracks between pixels rather than through their centres, so
 * the polygon is the actual boundary of the region and a one-pixel-wide sliver
 * still has an inside. Each boundary side is emitted as a directed segment with
 * the region on its left; consistent orientation is what lets the segments be
 * chained without any case analysis, and it makes the enclosing loop and any
 * holes come out with opposite winding, so the outline is simply the loop with
 * the largest area.
 */
export function traceOutline(pixels, w, h) {
  const inside = new Set(pixels);
  const has = (x, y) => x >= 0 && y >= 0 && x < w && y < h && inside.has(y * w + x);

  // Corner keys, on the (w+1) x (h+1) lattice of pixel corners.
  const key = (x, y) => y * (w + 1) + x;
  const edges = new Map();
  const addEdge = (ax, ay, bx, by) => {
    const k = key(ax, ay);
    const list = edges.get(k);
    if (list) list.push([bx, by]);
    else edges.set(k, [[bx, by]]);
  };

  for (const idx of pixels) {
    const x = idx % w;
    const y = (idx / w) | 0;
    if (!has(x, y - 1)) addEdge(x + 1, y, x, y);
    if (!has(x, y + 1)) addEdge(x, y + 1, x + 1, y + 1);
    if (!has(x - 1, y)) addEdge(x, y, x, y + 1);
    if (!has(x + 1, y)) addEdge(x + 1, y + 1, x + 1, y);
  }

  const loops = [];
  while (edges.size) {
    const [startKey, startList] = edges.entries().next().value;
    const sx = startKey % (w + 1);
    const sy = (startKey / (w + 1)) | 0;
    const loop = [{ x: sx, y: sy }];
    let cx = sx;
    let cy = sy;
    let list = startList;

    // Walk until the chain closes. Every corner has as many outgoing sides as
    // incoming ones, so it always does.
    while (list && list.length) {
      const [nx, ny] = list.pop();
      if (!list.length) edges.delete(key(cx, cy));
      cx = nx;
      cy = ny;
      if (cx === sx && cy === sy) break;
      loop.push({ x: cx, y: cy });
      list = edges.get(key(cx, cy));
    }
    if (loop.length >= 4) loops.push(loop);
  }
  if (!loops.length) return [];

  let best = loops[0];
  let bestArea = Math.abs(signedArea(best));
  for (const loop of loops.slice(1)) {
    const area = Math.abs(signedArea(loop));
    if (area > bestArea) {
      best = loop;
      bestArea = area;
    }
  }
  return dropCollinear(best);
}

function signedArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/** Drop the mid-points of straight runs. A crack-traced outline is mostly those. */
function dropCollinear(points) {
  const out = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[(i - 1 + n) % n];
    const b = points[i];
    const c = points[(i + 1) % n];
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(cross) > 1e-9) out.push(b);
  }
  return out.length >= 3 ? out : points;
}

/**
 * Douglas-Peucker, on a closed ring.
 *
 * A crack-traced window outline is a couple of hundred vertices of staircase.
 * Every one of them is real — that is genuinely where the boundary went — and
 * every one of them is noise, because the thing being described is a rectangle
 * with a rough edge. `tolerance` is in the same units as the points.
 */
export function simplifyClosed(points, tolerance) {
  if (points.length < 4) return points.slice();
  // Anchor at the two furthest-apart vertices, so the ring is split into two
  // open chains that Douglas-Peucker can each be run on honestly. Starting from
  // an arbitrary vertex leaves a kink there that no tolerance removes.
  let ai = 0;
  let bi = 0;
  let bestD2 = -1;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d2 = (points[i].x - points[j].x) ** 2 + (points[i].y - points[j].y) ** 2;
      if (d2 > bestD2) {
        bestD2 = d2;
        ai = i;
        bi = j;
      }
    }
    // Quadratic in the vertex count, and a traced outline can be long. The
    // furthest pair is only a starting anchor, so an approximate answer from a
    // subsample is as good as an exact one.
    if (points.length > 200) break;
  }

  const first = points.slice(ai, bi + 1);
  const second = points.slice(bi).concat(points.slice(0, ai + 1));
  const a = douglasPeucker(first, tolerance);
  const b = douglasPeucker(second, tolerance);
  return a.concat(b.slice(1, -1));
}

function douglasPeucker(points, tolerance) {
  if (points.length < 3) return points.slice();
  const first = points[0];
  const last = points[points.length - 1];
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const len = Math.hypot(dx, dy);

  let worst = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const d = len > 1e-12
      ? Math.abs((p.x - first.x) * dy - (p.y - first.y) * dx) / len
      : Math.hypot(p.x - first.x, p.y - first.y);
    if (d > worst) {
      worst = d;
      index = i;
    }
  }
  if (worst <= tolerance) return [first, last];
  const left = douglasPeucker(points.slice(0, index + 1), tolerance);
  const right = douglasPeucker(points.slice(index), tolerance);
  return left.concat(right.slice(1));
}

/* ------------------------------------------------------------------ *
 * From relief to shapes
 * ------------------------------------------------------------------ */

/**
 * Ground level, as the lowest row of the relief that saw anything much.
 *
 * Only ever used to answer "does this opening reach the floor", which is what
 * separates a door from a tall window and is otherwise unanswerable — the two
 * are the same rectangle. A row count rather than the single lowest pixel,
 * because one stray point of a bush is not the ground.
 */
function groundRow(relief) {
  const { w, h, data } = relief;
  const need = Math.max(4, w * 0.05);
  for (let y = h - 1; y >= 0; y--) {
    let seen = 0;
    for (let x = 0; x < w; x++) if (isSeen(data[y * w + x])) seen++;
    if (seen >= need) return y;
  }
  return h - 1;
}

/**
 * What kind of thing is this, and how sure are we.
 *
 * Guesses, and labelled as guesses — the tags exist so that a layer pointed at
 * "window" lights the windows, and a wrong one costs a click to fix. The
 * measurements are in metres, which is the only reason these rules can be
 * written down at all: a door is not "a tall rectangle", it is two metres tall
 * and standing on the ground, and that is a statement about a building rather
 * than about an image.
 */
function classify({ width, height, depth, bottomToGround, topToEaves }) {
  const aspect = width / Math.max(height, 1e-6);

  if (depth < 0) {
    if (height > 1.7 && height < 2.8 && width > 0.6 && width < 2.0 && bottomToGround < 0.4) {
      return { tag: 'door', confidence: 0.9 };
    }
    if (height > 0.3 && width > 0.25 && aspect > 0.15 && aspect < 6 && width * height < 12) {
      // Anything set back by more than about a foot stopped being a window
      // reveal and became a passage, an alley, or the gap to the next building.
      return { tag: 'window', confidence: depth > -0.35 ? 0.85 : 0.4 };
    }
    return { tag: '', confidence: 0.2 };
  }

  if (height < 0.35 && width > height * 2.5) return { tag: 'trim', confidence: 0.6 };
  if (topToEaves < 0.5 && height > 0.4 && aspect < 2) return { tag: 'chimney', confidence: 0.5 };
  if (width > 1.2 && height > 1.2) return { tag: 'wall', confidence: 0.4 };
  return { tag: 'trim', confidence: 0.35 };
}

/**
 * Everything on this facade that is not flush with the wall.
 *
 * The one function the rest of the app actually wants. Threshold the relief in
 * both directions, label what is left, trace it, simplify it, and hand back
 * polygons in normalised wall coordinates with a tag and the measurements the
 * guess was made from.
 *
 * `threshold` is in metres and is the only judgement call: below it, the surface
 * counts as wall. 20mm clears rendered brickwork and a coat of pebbledash, and
 * is comfortably under the 50-100mm a window reveal gives you.
 */
export function findOpenings(relief, {
  threshold = 0.02,
  minArea = 0.06,
  simplify = 0.03,
  snapRectangles = true,
  rectangleFill = 0.86,
} = {}) {
  const { w, h, data, scale } = relief;
  const minPixels = Math.max(9, Math.round(minArea / (scale * scale)));
  const ground = groundRow(relief);

  // The topmost row that saw anything, for "is this near the eaves".
  let eaves = 0;
  for (let y = 0; y < h; y++) {
    let seen = 0;
    for (let x = 0; x < w; x++) if (isSeen(data[y * w + x])) seen++;
    if (seen >= Math.max(4, w * 0.05)) { eaves = y; break; }
  }

  const found = [];
  for (const sign of [-1, 1]) {
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (isSeen(v) && v * sign > threshold) mask[i] = 1;
    }

    for (const region of label(mask, w, h, minPixels)) {
      const outline = traceOutline(region.pixels, w, h);
      if (outline.length < 3) continue;

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of outline) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      const boxPixels = (maxX - minX) * (maxY - minY);
      const fill = boxPixels > 0 ? region.pixels.length / boxPixels : 0;

      // The depth of the region itself, as a median: the mean is dragged by the
      // sloping reveal around the edge of every opening, so a 100mm window
      // reads as 60mm and the classifier starts calling it shallow.
      const depths = region.pixels.map((i) => data[i]).sort((a, b) => a - b);
      const depth = depths[depths.length >> 1];

      /**
       * Openings are rectangles, and a rectangle drawn as a rectangle is worth
       * more than a faithful record of where the render was chipped. Only when
       * the region really does fill its box, though — a porch arch or a bay
       * would be badly served by being squared off, and it will not pass this.
       */
      let points = outline;
      let squared = false;
      if (snapRectangles && fill >= rectangleFill) {
        points = [
          { x: minX, y: minY },
          { x: maxX, y: minY },
          { x: maxX, y: maxY },
          { x: minX, y: maxY },
        ];
        squared = true;
      } else {
        points = simplifyClosed(outline, simplify / scale);
      }
      if (points.length < 3) continue;

      const width = (maxX - minX) * scale;
      const height = (maxY - minY) * scale;
      const guess = classify({
        width,
        height,
        depth,
        bottomToGround: (ground - maxY) * scale,
        topToEaves: (minY - eaves) * scale,
      });

      found.push({
        points: points.map((p) => ({ x: p.x / w, y: p.y / h })),
        pixels: points,
        tag: guess.tag,
        confidence: guess.confidence,
        squared,
        depth,
        width,
        height,
        area: region.pixels.length * scale * scale,
        bbox: { x: minX / w, y: minY / h, w: (maxX - minX) / w, h: (maxY - minY) / h },
      });
    }
  }

  // Biggest first: it is the order somebody would have traced them in, and it
  // puts the door and the bay above the air bricks in the shape list.
  found.sort((a, b) => b.area - a.area);
  return found;
}

/** Metric size of the whole relief map, for placing it in the world. */
export function reliefExtent(relief) {
  return {
    width: relief.w * relief.scale,
    height: relief.h * relief.scale,
    aspect: (relief.w * relief.scale) / (relief.h * relief.scale),
    scale: relief.scale,
  };
}

/* ------------------------------------------------------------------ *
 * Lighting the surface
 * ------------------------------------------------------------------ */

/**
 * Is anything between this point on the wall and a lamp in front of it?
 *
 * March along the ray and ask the heightfield whether it is above it. A
 * heightfield cannot occlude in any subtler way than that, so for this geometry
 * the answer is not an approximation of shadowing — it *is* shadowing, and it is
 * what makes a projected lantern read as a lantern rather than as a bright
 * patch: the porch throws its shadow onto the path, and the sills throw theirs
 * up the wall when the light is below them.
 *
 * Coordinates are metres in the relief map's own frame: x across from its left
 * edge, y *down* from its top edge, z out of the wall towards the viewer. That
 * matches the way the rest of the app measures y and is what `depthField`
 * hands to effects.
 *
 * Returns 0 for lit and 1 for fully shadowed, with the values between covering
 * the first few centimetres of blocker. That fade is not a penumbra — a real one
 * needs the lamp to have a size — but it costs nothing and removes the staircase
 * that a hard test leaves along every shadow edge crossing a surface at a
 * shallow angle, which is the artefact anyone actually notices.
 */
export function occlusion(relief, x, y, z, lx, ly, lz, {
  steps = 18,
  reach = 2.6,
  bias = 0.006,
  slope = 0.01,
  soften = 0.035,
} = {}) {
  const dx = lx - x;
  const dy = ly - y;
  const dz = lz - z;
  const dist = Math.hypot(dx, dy, dz);
  if (!(dist > 1e-4)) return 0;

  const { w, h, data, scale } = relief;
  const span = Math.min(dist, reach);

  for (let s = 1; s <= steps; s++) {
    const t = (s / steps) * span;
    const px = ((x + (dx / dist) * t) / scale) | 0;
    const py = ((y + (dy / dist) * t) / scale) | 0;
    // Off the edge of the scan is not a blocker. Treating it as one would ring
    // the whole relief map in a black border.
    if (px < 0 || py < 0 || px >= w || py >= h) return 0;
    const surface = data[py * w + px];
    if (!isSeen(surface)) continue;
    const over = surface - (z + (dz / dist) * t) - (bias + t * slope);
    if (over > 0) return soften > 0 ? Math.min(1, over / soften) : 1;
  }
  return 0;
}
