/**
 * Getting a phone scan out of a .glb and into a pile of triangles.
 *
 * A LiDAR or photogrammetry scan of the front of a house arrives as glTF, which
 * is a rich format describing materials, animation, skinning and cameras. None
 * of that is wanted here. `core/depth.js` needs vertex positions in world space
 * and the triangles between them, and everything else in the file is weight.
 *
 * So this is a reader, not a loader: no textures are decoded, no materials are
 * built, nothing is uploaded to a GPU. It walks the node tree accumulating
 * transforms, pulls POSITION and the index buffer out of each triangle
 * primitive, and concatenates. A twenty-megabyte scan of a terraced house comes
 * out as one Float32Array and one Uint32Array in a fraction of a second, and the
 * app takes on no dependency to do it.
 *
 * Both containers are handled: .glb, which is a binary envelope around the JSON
 * and one buffer, and .gltf, which is the JSON on its own with its buffers
 * either inline as data: URIs or beside it as .bin files. External .bin files
 * need fetching, so a `resolve` callback is taken for the one case where the
 * caller can supply them — a file picker that took the whole folder.
 */

const MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const COMPONENT = {
  5120: { array: Int8Array, size: 1 },
  5121: { array: Uint8Array, size: 1 },
  5122: { array: Int16Array, size: 2 },
  5123: { array: Uint16Array, size: 2 },
  5125: { array: Uint32Array, size: 4 },
  5126: { array: Float32Array, size: 4 },
};
const COMPONENTS_PER = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/** Split a .glb envelope into its JSON and its binary chunk. */
function readContainer(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength >= 12 && view.getUint32(0, true) === MAGIC) {
    const total = view.getUint32(8, true);
    let offset = 12;
    let json = null;
    let bin = null;
    while (offset + 8 <= Math.min(total, bytes.byteLength)) {
      const length = view.getUint32(offset, true);
      const type = view.getUint32(offset + 4, true);
      const start = offset + 8;
      if (type === CHUNK_JSON) json = new TextDecoder().decode(bytes.subarray(start, start + length));
      else if (type === CHUNK_BIN) bin = bytes.subarray(start, start + length);
      // Chunks are four-byte aligned, and a reader that ignores that walks off
      // into the middle of the next header on any file with an odd-length name.
      offset = start + length + ((4 - (length % 4)) % 4);
    }
    if (!json) throw new Error('This .glb has no JSON chunk');
    return { gltf: JSON.parse(json), bin };
  }

  // Not a container, so it should be the JSON itself.
  const text = new TextDecoder().decode(bytes).trim();
  if (!text.startsWith('{')) throw new Error('Not a glTF file');
  return { gltf: JSON.parse(text), bin: null };
}

function decodeDataUri(uri) {
  const comma = uri.indexOf(',');
  const meta = uri.slice(5, comma);
  const body = uri.slice(comma + 1);
  if (!meta.endsWith(';base64')) return new TextEncoder().encode(decodeURIComponent(body));
  const binary = atob(body);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/* ------------------------------------------------------------------ *
 * Node transforms
 * ------------------------------------------------------------------ */

function multiply(a, b) {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

/** A node's local matrix, from either the explicit form or its TRS parts. */
function localMatrix(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return Float64Array.from(node.matrix);

  const [tx, ty, tz] = node.translation || [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];

  const x2 = qx + qx;
  const y2 = qy + qy;
  const z2 = qz + qz;
  const xx = qx * x2;
  const xy = qx * y2;
  const xz = qx * z2;
  const yy = qy * y2;
  const yz = qy * z2;
  const zz = qz * z2;
  const wx = qw * x2;
  const wy = qw * y2;
  const wz = qw * z2;

  // Column-major, as glTF stores matrices.
  return Float64Array.from([
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ]);
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

/**
 * Every triangle in the file, in world space.
 *
 * @param {ArrayBuffer|Uint8Array} data  the bytes of a .glb or .gltf
 * @param {object} [options]
 *   resolve  async (uri) => Uint8Array, for buffers stored beside the file
 *   limit    stop after this many triangles, so a careless drop cannot hang the tab
 * @returns {Promise<{positions:Float32Array, indices:Uint32Array, triangles:number, bounds:object}>}
 */
export async function readGltfTriangles(data, { resolve = null, limit = 4_000_000 } = {}) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const { gltf, bin } = readContainer(bytes);

  const required = gltf.extensionsRequired || [];
  if (required.includes('KHR_draco_mesh_compression')) {
    // Worth naming rather than failing obscurely: Draco is common in exports
    // meant for the web, and the fix is one dropdown in the exporting app.
    throw new Error('This file is Draco-compressed. Re-export it with compression turned off.');
  }
  if (required.includes('EXT_meshopt_compression')) {
    throw new Error('This file is meshopt-compressed. Re-export it with compression turned off.');
  }

  const buffers = await Promise.all(
    (gltf.buffers || []).map(async (buffer, i) => {
      if (!buffer.uri) {
        if (i === 0 && bin) return bin;
        throw new Error('This file expects an embedded buffer that is not there');
      }
      if (buffer.uri.startsWith('data:')) return decodeDataUri(buffer.uri);
      if (resolve) return resolve(buffer.uri);
      throw new Error(`This .gltf keeps its geometry in a separate file (${buffer.uri}). Export as .glb instead.`);
    })
  );

  /** Read an accessor as a flat typed array, honouring the view's stride. */
  const readAccessor = (index) => {
    const accessor = gltf.accessors?.[index];
    if (!accessor) return null;
    const spec = COMPONENT[accessor.componentType];
    const per = COMPONENTS_PER[accessor.type];
    if (!spec || !per) return null;

    const out = new (accessor.componentType === 5126 ? Float32Array : Float64Array)(accessor.count * per);
    if (accessor.bufferView === undefined) return out; // legitimately all zeroes

    const view = gltf.bufferViews[accessor.bufferView];
    const buffer = buffers[view.buffer];
    const base = (view.byteOffset || 0) + (accessor.byteOffset || 0);
    const stride = view.byteStride || spec.size * per;
    const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

    const readOne = {
      5120: (o) => dv.getInt8(o),
      5121: (o) => dv.getUint8(o),
      5122: (o) => dv.getInt16(o, true),
      5123: (o) => dv.getUint16(o, true),
      5125: (o) => dv.getUint32(o, true),
      5126: (o) => dv.getFloat32(o, true),
    }[accessor.componentType];

    for (let i = 0; i < accessor.count; i++) {
      for (let c = 0; c < per; c++) out[i * per + c] = readOne(base + i * stride + c * spec.size);
    }
    return out;
  };

  const positions = [];
  const indices = [];
  let vertexBase = 0;
  let triangles = 0;
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };

  const visit = (nodeIndex, parent) => {
    const node = gltf.nodes?.[nodeIndex];
    if (!node) return;
    const world = multiply(parent, localMatrix(node));

    if (node.mesh !== undefined) {
      for (const primitive of gltf.meshes?.[node.mesh]?.primitives || []) {
        // Mode 4 is TRIANGLES. Strips and fans exist but no scanner emits them,
        // and quietly reading one as a soup would fold the mesh in on itself.
        if (primitive.mode !== undefined && primitive.mode !== 4) continue;
        const pos = readAccessor(primitive.attributes?.POSITION);
        if (!pos) continue;

        const count = pos.length / 3;
        for (let i = 0; i < count; i++) {
          const x = pos[i * 3];
          const y = pos[i * 3 + 1];
          const z = pos[i * 3 + 2];
          const wx = world[0] * x + world[4] * y + world[8] * z + world[12];
          const wy = world[1] * x + world[5] * y + world[9] * z + world[13];
          const wz = world[2] * x + world[6] * y + world[10] * z + world[14];
          positions.push(wx, wy, wz);
          if (wx < bounds.min[0]) bounds.min[0] = wx;
          if (wy < bounds.min[1]) bounds.min[1] = wy;
          if (wz < bounds.min[2]) bounds.min[2] = wz;
          if (wx > bounds.max[0]) bounds.max[0] = wx;
          if (wy > bounds.max[1]) bounds.max[1] = wy;
          if (wz > bounds.max[2]) bounds.max[2] = wz;
        }

        const idx = primitive.indices !== undefined ? readAccessor(primitive.indices) : null;
        if (idx) {
          for (let i = 0; i + 2 < idx.length; i += 3) {
            indices.push(vertexBase + idx[i], vertexBase + idx[i + 1], vertexBase + idx[i + 2]);
            triangles++;
          }
        } else {
          for (let i = 0; i + 2 < count; i += 3) {
            indices.push(vertexBase + i, vertexBase + i + 1, vertexBase + i + 2);
            triangles++;
          }
        }
        vertexBase += count;
        if (triangles > limit) throw new Error(`This scan has more than ${limit.toLocaleString()} triangles. Decimate it first.`);
      }
    }

    for (const child of node.children || []) visit(child, world);
  };

  const identity = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const scene = gltf.scenes?.[gltf.scene ?? 0];
  const roots = scene?.nodes || gltf.nodes?.map((_, i) => i) || [];
  for (const root of roots) visit(root, identity);

  if (!triangles) throw new Error('No triangles in this file');
  return {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
    triangles,
    bounds,
    /** Whether the scan appears to be in metres, which every phone scanner emits. */
    span: bounds.max.map((v, i) => v - bounds.min[i]),
  };
}

/**
 * The area-weighted average of the triangle normals, which is how a scan says
 * which way it was looking.
 *
 * Used only to point the fitted wall plane outwards. A scanner captures the
 * surfaces it can see and winds them to face itself, so the mean normal of the
 * facade points, roughly, back at where somebody stood in the road.
 */
export function meanNormal({ positions, indices }) {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  const count = indices ? indices.length / 3 : positions.length / 9;
  for (let t = 0; t < count; t++) {
    const i0 = (indices ? indices[t * 3] : t * 3) * 3;
    const i1 = (indices ? indices[t * 3 + 1] : t * 3 + 1) * 3;
    const i2 = (indices ? indices[t * 3 + 2] : t * 3 + 2) * 3;
    const ax = positions[i1] - positions[i0];
    const ay = positions[i1 + 1] - positions[i0 + 1];
    const az = positions[i1 + 2] - positions[i0 + 2];
    const bx = positions[i2] - positions[i0];
    const by = positions[i2 + 1] - positions[i0 + 1];
    const bz = positions[i2 + 2] - positions[i0 + 2];
    // Not normalised per triangle: the cross product's length is twice the
    // area, so leaving it is the area weighting.
    nx += ay * bz - az * by;
    ny += az * bx - ax * bz;
    nz += ax * by - ay * bx;
  }
  const len = Math.hypot(nx, ny, nz);
  return len > 1e-12 ? [nx / len, ny / len, nz / len] : null;
}
