/**
 * Reading a phone scan.
 *
 * A .glb is written here from scratch and read back, because the interesting
 * failures in a glTF reader are all silent: a node transform left unapplied
 * puts the house at the origin facing the wrong way and still returns the right
 * number of triangles; an ignored byteStride reads garbage that is numerically
 * fine; a chunk length not rounded up to four bytes lands the reader in the
 * middle of the next header. None of those throw, and all of them produce a
 * relief map of something that is not a building.
 *
 *   node test/glb.test.mjs
 */

import { readGltfTriangles, meanNormal } from '../js/core/glb.js';

let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!cond) failures++;
};
const near = (a, b, tol = 1e-4) => Math.abs(a - b) <= tol;

/* ------------------------------------------------------------------ *
 * A .glb, written by hand
 * ------------------------------------------------------------------ */

/**
 * Two triangles in the z = 0 plane, with the positions interleaved with a
 * padding vector so the accessor has a stride worth honouring.
 */
const QUAD = [
  [0, 0, 0],
  [2, 0, 0],
  [2, 1, 0],
  [0, 1, 0],
];
const TRIS = [0, 1, 2, 0, 2, 3];

function buildGlb({ node, strided = true }) {
  const stride = strided ? 24 : 12;
  const positionBytes = QUAD.length * stride;
  const indexBytes = TRIS.length * 2;
  // Buffer views must start on a multiple of their component size.
  const indexOffset = positionBytes + ((4 - (positionBytes % 4)) % 4);
  const binLength = indexOffset + indexBytes;

  const bin = new Uint8Array(binLength + ((4 - (binLength % 4)) % 4));
  const dv = new DataView(bin.buffer);
  QUAD.forEach((p, i) => {
    dv.setFloat32(i * stride, p[0], true);
    dv.setFloat32(i * stride + 4, p[1], true);
    dv.setFloat32(i * stride + 8, p[2], true);
    if (strided) {
      // Padding the reader must skip. Poisoned, so reading it shows up.
      dv.setFloat32(i * stride + 12, 999, true);
      dv.setFloat32(i * stride + 16, 999, true);
      dv.setFloat32(i * stride + 20, 999, true);
    }
  });
  TRIS.forEach((v, i) => dv.setUint16(indexOffset + i * 2, v, true));

  const gltf = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, ...node }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: QUAD.length, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: TRIS.length, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBytes, ...(strided ? { byteStride: stride } : {}) },
      { buffer: 0, byteOffset: indexOffset, byteLength: indexBytes },
    ],
    buffers: [{ byteLength: bin.byteLength }],
  };

  // A JSON chunk whose length is deliberately not a multiple of four, so the
  // container's padding rule is exercised rather than assumed.
  let json = JSON.stringify(gltf);
  while (json.length % 4 !== 1) json = json.replace('"asset"', ' "asset"');
  const jsonBytes = new TextEncoder().encode(json);
  const jsonPadded = new Uint8Array(jsonBytes.length + ((4 - (jsonBytes.length % 4)) % 4));
  jsonPadded.fill(0x20);
  jsonPadded.set(jsonBytes);

  const total = 12 + 8 + jsonPadded.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, 0x46546c67, true);
  odv.setUint32(4, 2, true);
  odv.setUint32(8, total, true);
  odv.setUint32(12, jsonPadded.length, true);
  odv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonPadded, 20);
  const binHeader = 20 + jsonPadded.length;
  odv.setUint32(binHeader, bin.length, true);
  odv.setUint32(binHeader + 4, 0x004e4942, true);
  out.set(bin, binHeader + 8);
  return out;
}

/* ------------------------------------------------------------------ *
 * A plain read
 * ------------------------------------------------------------------ */

const plain = await readGltfTriangles(buildGlb({ node: {} }));
ok('two triangles', plain.triangles === 2, `${plain.triangles}`);
ok('four vertices', plain.positions.length === 12, `${plain.positions.length / 3}`);
ok(
  'the stride was honoured',
  !Array.from(plain.positions).some((v) => v === 999),
  Array.from(plain.positions.slice(0, 6)).join(',')
);
ok('the indices survived', Array.from(plain.indices).join(',') === TRIS.join(','));
ok('bounds are the quad', near(plain.bounds.max[0], 2) && near(plain.bounds.max[1], 1));

/* ------------------------------------------------------------------ *
 * Node transforms
 * ------------------------------------------------------------------ */

{
  // A quarter turn about Y, doubled, and moved. The quad's +x corner should end
  // up on -z at twice the distance, offset by the translation.
  const s = Math.SQRT1_2;
  const posed = await readGltfTriangles(
    buildGlb({ node: { rotation: [0, s, 0, s], scale: [2, 2, 2], translation: [10, 1, -4] } })
  );
  const corner = posed.positions.slice(3, 6); // QUAD[1] = (2, 0, 0)
  ok(
    'TRS is applied',
    near(corner[0], 10, 1e-3) && near(corner[1], 1, 1e-3) && near(corner[2], -8, 1e-3),
    `(${Array.from(corner).map((v) => v.toFixed(2))})`
  );
}

{
  // The explicit matrix form, column-major: a scale of 3 and a shove along x.
  const m = [3, 0, 0, 0, 0, 3, 0, 0, 0, 0, 3, 0, 5, 0, 0, 1];
  const posed = await readGltfTriangles(buildGlb({ node: { matrix: m } }));
  const corner = posed.positions.slice(3, 6);
  ok('an explicit matrix is applied', near(corner[0], 11) && near(corner[1], 0), `(${Array.from(corner).map((v) => v.toFixed(2))})`);
}

{
  // Nested nodes: the child's transform composes with its parent's, and a
  // reader that overwrites rather than multiplies passes every test above.
  const bytes = buildGlb({ node: {} });
  const text = new TextDecoder().decode(bytes.subarray(20, 20 + new DataView(bytes.buffer).getUint32(12, true)));
  const gltf = JSON.parse(text.trim());
  gltf.nodes = [{ translation: [100, 0, 0], children: [1] }, { translation: [0, 7, 0], mesh: 0 }];
  gltf.scenes = [{ nodes: [0] }];
  gltf.buffers = [{ byteLength: 1, uri: 'data:application/octet-stream;base64,AA==' }];
  // Rebuilt as a plain .gltf with the geometry inline, which also covers the
  // data: URI path that a .gltf exported "embedded" arrives as.
  const binStart = 20 + new DataView(bytes.buffer).getUint32(12, true) + 8;
  const bin = bytes.subarray(binStart);
  gltf.buffers = [{
    byteLength: bin.byteLength,
    uri: `data:application/octet-stream;base64,${Buffer.from(bin).toString('base64')}`,
  }];
  const nested = await readGltfTriangles(new TextEncoder().encode(JSON.stringify(gltf)));
  const first = nested.positions.slice(0, 3);
  ok(
    'nested transforms compose, and a .gltf with a data: URI reads',
    near(first[0], 100) && near(first[1], 7),
    `(${Array.from(first).map((v) => v.toFixed(1))})`
  );
}

/* ------------------------------------------------------------------ *
 * Refusals
 * ------------------------------------------------------------------ */

for (const [name, mutate, message] of [
  ['Draco is named, not swallowed', (g) => { g.extensionsRequired = ['KHR_draco_mesh_compression']; }, /Draco/],
  ['a separate .bin is named', (g) => { g.buffers = [{ byteLength: 4, uri: 'scene.bin' }]; }, /separate file/],
]) {
  const bytes = buildGlb({ node: {} });
  const jsonLength = new DataView(bytes.buffer).getUint32(12, true);
  const gltf = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)).trim());
  mutate(gltf);
  let error = null;
  try {
    await readGltfTriangles(new TextEncoder().encode(JSON.stringify(gltf)));
  } catch (err) {
    error = err.message;
  }
  ok(name, !!error && message.test(error), error || 'no error thrown');
}

{
  let error = null;
  try {
    await readGltfTriangles(new TextEncoder().encode('this is a jpeg, honestly'));
  } catch (err) {
    error = err.message;
  }
  ok('something that is not a glTF is refused', !!error, error);
}

/* ------------------------------------------------------------------ *
 * Which way it was looking
 * ------------------------------------------------------------------ */

{
  const normal = meanNormal(plain);
  ok('the mean normal faces the scanner', normal && near(normal[2], 1, 1e-6), `${normal?.map((v) => v.toFixed(3))}`);
  const flipped = { positions: plain.positions, indices: Uint32Array.from([0, 2, 1, 0, 3, 2]) };
  ok('and follows the winding', near(meanNormal(flipped)[2], -1, 1e-6));
}

console.log(failures ? `\n${failures} failing` : '\nAll passing');
process.exit(failures ? 1 : 0);
