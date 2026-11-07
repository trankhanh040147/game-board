import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as meshModule from '../src/core/mesh.js';
import { mat4, multiply4, rotationY, translation4 } from '../src/core/math.js';

const {
  IDENTITY_MATRIX,
  createMeshBuilder,
  createUnitCubeMesh,
  mergeMeshes,
  countGeometry,
} = meshModule;

function assertFiniteMesh(mesh, label) {
  assert.ok(mesh.vertexCount > 0, `${label}: mesh has no vertices`);
  assert.equal(mesh.positions.length, mesh.vertexCount * 3, `${label}: positions length`);
  assert.equal(mesh.normals.length, mesh.vertexCount * 3, `${label}: normals length`);
  assert.equal(mesh.colors.length, mesh.vertexCount * 4, `${label}: colors length`);
  assert.equal(mesh.indices.length, mesh.triangleCount * 3, `${label}: indices length`);
  assert.equal(mesh.indices.length % 3, 0, `${label}: index count must be a multiple of 3`);

  for (const array of [mesh.positions, mesh.normals, mesh.colors]) {
    for (let i = 0; i < array.length; i += 1) {
      assert.ok(Number.isFinite(array[i]), `${label}: non-finite value at index ${i}`);
    }
  }
  for (let i = 0; i < mesh.indices.length; i += 1) {
    const index = mesh.indices[i];
    assert.ok(
      Number.isInteger(index) && index >= 0 && index < mesh.vertexCount,
      `${label}: index ${index} at ${i} is outside 0..${mesh.vertexCount - 1}`,
    );
  }
}

function triangleNormal(positions, ia, ib, ic) {
  const ax = positions[ia * 3];
  const ay = positions[ia * 3 + 1];
  const az = positions[ia * 3 + 2];
  const bx = positions[ib * 3] - ax;
  const by = positions[ib * 3 + 1] - ay;
  const bz = positions[ib * 3 + 2] - az;
  const cx = positions[ic * 3] - ax;
  const cy = positions[ic * 3 + 1] - ay;
  const cz = positions[ic * 3 + 2] - az;
  return [by * cz - bz * cy, bz * cx - bx * cz, bx * cy - by * cx];
}

test('mesh.js exposes the helpers documented in the contract', () => {
  assert.equal(
    typeof meshModule.transformPoint,
    'function',
    'docs/CONTRACT.md requires src/core/mesh.js to export transformPoint(matrix, x, y, z)',
  );
  assert.equal(
    typeof meshModule.meshBounds,
    'function',
    'docs/CONTRACT.md requires src/core/mesh.js to export meshBounds(mesh)',
  );
  assert.ok(IDENTITY_MATRIX instanceof Float32Array, 'IDENTITY_MATRIX must be a Float32Array');
  assert.equal(IDENTITY_MATRIX.length, 16, 'IDENTITY_MATRIX must have 16 elements');
});

test('addBox produces 24 vertices, 12 triangles, unit outward normals and tight bounds', () => {
  const builder = createMeshBuilder();
  builder.addBox(1, 2, 3, 2, 4, 6, { color: [0.5, 0.25, 0.125] });
  const mesh = builder.build();

  assert.equal(mesh.vertexCount, 24, 'a box has 6 faces * 4 vertices');
  assert.equal(mesh.triangleCount, 12, 'a box has 6 faces * 2 triangles');
  assertFiniteMesh(mesh, 'box');

  // Bounds: centred at (1,2,3) with full sizes (2,4,6).
  assert.deepEqual(mesh.bounds.min, [0, 0, 0], 'box min bounds');
  assert.deepEqual(mesh.bounds.max, [2, 4, 6], 'box max bounds');

  for (let v = 0; v < mesh.vertexCount; v += 1) {
    const nx = mesh.normals[v * 3];
    const ny = mesh.normals[v * 3 + 1];
    const nz = mesh.normals[v * 3 + 2];
    assert.ok(
      Math.abs(Math.hypot(nx, ny, nz) - 1) < 1e-5,
      `box vertex ${v} normal is not unit length: ${Math.hypot(nx, ny, nz)}`,
    );
    // Outward: the face normal points away from the box centre.
    const px = mesh.positions[v * 3] - 1;
    const py = mesh.positions[v * 3 + 1] - 2;
    const pz = mesh.positions[v * 3 + 2] - 3;
    assert.ok(nx * px + ny * py + nz * pz > 0, `box vertex ${v} normal points inward`);
  }

  // Counter-clockwise winding: the geometric normal must agree with the vertex normal.
  for (let t = 0; t < mesh.triangleCount; t += 1) {
    const a = mesh.indices[t * 3];
    const b = mesh.indices[t * 3 + 1];
    const c = mesh.indices[t * 3 + 2];
    const [gx, gy, gz] = triangleNormal(mesh.positions, a, b, c);
    const nx = mesh.normals[a * 3];
    const ny = mesh.normals[a * 3 + 1];
    const nz = mesh.normals[a * 3 + 2];
    assert.ok(gx * nx + gy * ny + gz * nz > 0, `box triangle ${t} is wound clockwise from outside`);
  }
});

test('addBox honours colour, top colour and emissive options', () => {
  const builder = createMeshBuilder();
  builder.addBox(0, 0, 0, 1, 1, 1, {
    color: [1, 0, 0],
    colorTop: [0, 1, 0],
    emissive: 0.25,
    emissiveTop: 0.75,
  });
  const mesh = builder.build();
  let foundTop = false;
  for (let v = 0; v < mesh.vertexCount; v += 1) {
    const ny = mesh.normals[v * 3 + 1];
    const r = mesh.colors[v * 4];
    const g = mesh.colors[v * 4 + 1];
    const a = mesh.colors[v * 4 + 3];
    if (ny === 1) {
      foundTop = true;
      assert.equal(r, 0, 'top face uses colorTop[0]');
      assert.equal(g, 1, 'top face uses colorTop[1]');
      assert.equal(a, 0.75, 'top face uses emissiveTop');
    } else {
      assert.equal(r, 1, 'side faces use color[0]');
      assert.equal(g, 0, 'side faces use color[1]');
      assert.equal(a, 0.25, 'side faces use emissive');
    }
  }
  assert.ok(foundTop, 'expected a +Y facing face');
});

test('addBox supports rotationY around the box centre', () => {
  const builder = createMeshBuilder();
  builder.addBox(0, 0.5, 0, 4, 1, 2, { color: [1, 1, 1], rotationY: Math.PI / 2 });
  const mesh = builder.build();
  // Rotating a 4x1x2 box by 90 degrees swaps its X/Z extents.
  assert.ok(Math.abs(mesh.bounds.min[0] + 1) < 1e-5, `rotated box min x should be -1, got ${mesh.bounds.min[0]}`);
  assert.ok(Math.abs(mesh.bounds.max[0] - 1) < 1e-5, `rotated box max x should be 1, got ${mesh.bounds.max[0]}`);
  assert.ok(Math.abs(mesh.bounds.min[2] + 2) < 1e-5, `rotated box min z should be -2, got ${mesh.bounds.min[2]}`);
  assert.ok(Math.abs(mesh.bounds.max[2] - 2) < 1e-5, `rotated box max z should be 2, got ${mesh.bounds.max[2]}`);
});

test('addCylinder y axis grows up from the base centre', () => {
  const builder = createMeshBuilder();
  builder.addCylinder(0, 1, 0, 1, 1, 2, { color: [1, 1, 1], segments: 12 });
  const mesh = builder.build();
  assertFiniteMesh(mesh, 'y-cylinder');
  assert.ok(Math.abs(mesh.bounds.min[1] - 1) < 1e-5, `cylinder min y should be 1, got ${mesh.bounds.min[1]}`);
  assert.ok(Math.abs(mesh.bounds.max[1] - 3) < 1e-5, `cylinder max y should be 3, got ${mesh.bounds.max[1]}`);
  assert.ok(Math.abs(mesh.bounds.min[0] + 1) < 1e-4, `cylinder min x should be -1, got ${mesh.bounds.min[0]}`);
  assert.ok(Math.abs(mesh.bounds.max[0] - 1) < 1e-4, `cylinder max x should be 1, got ${mesh.bounds.max[0]}`);
  // 12 side quads + 12 bottom triangles + 12 top triangles.
  assert.equal(mesh.triangleCount, 12 * 2 + 12 * 2, 'cylinder triangle count');
});

test('addCylinder x and z axes extend along the positive axis', () => {
  const xBuilder = createMeshBuilder();
  xBuilder.addCylinder(2, 0, 0, 0.5, 0.5, 3, { segments: 8, axis: 'x' });
  const xMesh = xBuilder.build();
  assert.ok(Math.abs(xMesh.bounds.min[0] - 2) < 1e-5, `x-axis cylinder base at x=2, got ${xMesh.bounds.min[0]}`);
  assert.ok(Math.abs(xMesh.bounds.max[0] - 5) < 1e-5, `x-axis cylinder top at x=5, got ${xMesh.bounds.max[0]}`);
  assert.ok(xMesh.bounds.max[1] <= 0.5001, `x-axis cylinder radius on y, got ${xMesh.bounds.max[1]}`);

  const zBuilder = createMeshBuilder();
  zBuilder.addCylinder(0, 0, -1, 0.5, 0.5, 4, { segments: 8, axis: 'z' });
  const zMesh = zBuilder.build();
  assert.ok(Math.abs(zMesh.bounds.min[2] + 1) < 1e-5, `z-axis cylinder base at z=-1, got ${zMesh.bounds.min[2]}`);
  assert.ok(Math.abs(zMesh.bounds.max[2] - 3) < 1e-5, `z-axis cylinder top at z=3, got ${zMesh.bounds.max[2]}`);
});

test('every cylinder triangle is counter-clockwise relative to its vertex normal', () => {
  // The renderer culls back faces with CCW as the front face, so cap triangles
  // wound the wrong way are invisible (hollow tyres, no exhaust tips).
  for (const axis of ['y', 'x', 'z']) {
    const builder = createMeshBuilder();
    builder.addCylinder(0, 0, 0, 1, 0.6, 2, { segments: 10, axis });
    const mesh = builder.build();
    for (let t = 0; t < mesh.triangleCount; t += 1) {
      const a = mesh.indices[t * 3];
      const b = mesh.indices[t * 3 + 1];
      const c = mesh.indices[t * 3 + 2];
      const [gx, gy, gz] = triangleNormal(mesh.positions, a, b, c);
      const nx = mesh.normals[a * 3];
      const ny = mesh.normals[a * 3 + 1];
      const nz = mesh.normals[a * 3 + 2];
      assert.ok(
        gx * nx + gy * ny + gz * nz > 0,
        `cylinder axis '${axis}' triangle ${t} is wound clockwise relative to its normal (it will be culled)`,
      );
    }
  }
});

test('every sphere triangle is counter-clockwise relative to its vertex normal', () => {
  const builder = createMeshBuilder();
  builder.addSphere(0, 1, 0, 2, { segments: 10, rings: 6 });
  const mesh = builder.build();
  for (let t = 0; t < mesh.triangleCount; t += 1) {
    const a = mesh.indices[t * 3];
    const b = mesh.indices[t * 3 + 1];
    const c = mesh.indices[t * 3 + 2];
    const [gx, gy, gz] = triangleNormal(mesh.positions, a, b, c);
    const nx = mesh.normals[a * 3];
    const ny = mesh.normals[a * 3 + 1];
    const nz = mesh.normals[a * 3 + 2];
    assert.ok(
      gx * nx + gy * ny + gz * nz > 0,
      `sphere triangle ${t} is wound clockwise relative to its normal (it will be culled)`,
    );
  }
});

test('addCylinder cap normals point along the axis', () => {
  const builder = createMeshBuilder();
  builder.addCylinder(0, 0, 0, 1, 0.5, 2, { segments: 6, axis: 'y' });
  const mesh = builder.build();
  let sawUp = false;
  let sawDown = false;
  for (let v = 0; v < mesh.vertexCount; v += 1) {
    const nx = mesh.normals[v * 3];
    const ny = mesh.normals[v * 3 + 1];
    const nz = mesh.normals[v * 3 + 2];
    assert.ok(Math.abs(Math.hypot(nx, ny, nz) - 1) < 1e-4, `cylinder vertex ${v} normal is not unit length`);
    if (ny > 0.999) sawUp = true;
    if (ny < -0.999) sawDown = true;
  }
  assert.ok(sawUp, 'cylinder top cap normal should point +Y');
  assert.ok(sawDown, 'cylinder bottom cap normal should point -Y');
});

test('addRibbon builds an up-facing strip and is safe on degenerate input', () => {
  const builder = createMeshBuilder();
  builder.addRibbon([], {});
  builder.addRibbon([{ x: 0, y: 0, z: 0, rx: 1, rz: 0, halfWidth: 2 }], {});
  assert.equal(builder.vertexCount, 0, 'ribbon with fewer than 2 rows must add nothing');
  assert.equal(builder.triangleCount, 0, 'ribbon with fewer than 2 rows must add no triangles');
  builder.addRibbon(null, {});
  assert.equal(builder.vertexCount, 0, 'ribbon with null rows must add nothing');

  const rows = [
    { x: 0, y: 0, z: 0, rx: 1, rz: 0, halfWidth: 2 },
    { x: 0, y: 0, z: 10, rx: 1, rz: 0, halfWidth: 2 },
    { x: 0, y: 0, z: 20, rx: 1, rz: 0, halfWidth: 2 },
  ];
  const ribbonBuilder = createMeshBuilder();
  ribbonBuilder.addRibbon(rows, { color: [0.2, 0.4, 0.6] });
  const ribbon = ribbonBuilder.build();
  assertFiniteMesh(ribbon, 'ribbon');
  assert.equal(ribbon.vertexCount, 6, '3 rows * 2 vertices');
  assert.equal(ribbon.triangleCount, 4, '2 segments * 2 triangles');
  assert.ok(Math.abs(ribbon.bounds.min[0] + 2) < 1e-5, `ribbon min x should be -2, got ${ribbon.bounds.min[0]}`);
  assert.ok(Math.abs(ribbon.bounds.max[0] - 2) < 1e-5, `ribbon max x should be 2, got ${ribbon.bounds.max[0]}`);
  assert.ok(Math.abs(ribbon.bounds.max[2] - 20) < 1e-5, `ribbon max z should be 20, got ${ribbon.bounds.max[2]}`);
  for (let v = 0; v < ribbon.vertexCount; v += 1) {
    assert.equal(ribbon.normals[v * 3], 0, 'ribbon normal x');
    assert.equal(ribbon.normals[v * 3 + 1], 1, 'ribbon normal y');
    assert.equal(ribbon.normals[v * 3 + 2], 0, 'ribbon normal z');
  }
});

test('addRibbon supports asymmetric widths and twoSided output', () => {
  const rows = [
    { x: 0, y: 0, z: 0, rx: 1, rz: 0, halfWidthLeft: 1, halfWidthRight: 3 },
    { x: 0, y: 0, z: 5, rx: 1, rz: 0, halfWidthLeft: 1, halfWidthRight: 3 },
  ];
  const builder = createMeshBuilder();
  builder.addRibbon(rows, { twoSided: true });
  const mesh = builder.build();
  assert.equal(mesh.triangleCount, 4, 'two-sided single segment = 4 triangles');
  assert.ok(Math.abs(mesh.bounds.min[0] + 1) < 1e-5, `asymmetric ribbon min x should be -1, got ${mesh.bounds.min[0]}`);
  assert.ok(Math.abs(mesh.bounds.max[0] - 3) < 1e-5, `asymmetric ribbon max x should be 3, got ${mesh.bounds.max[0]}`);
});

test('addQuad lays a flat XZ quad with +Y normals', () => {
  const builder = createMeshBuilder();
  builder.addQuad(0, 1, 0, 1, 0, 0, 1, 4, 8, { color: [0.5, 0.5, 0.5] });
  const mesh = builder.build();
  assert.equal(mesh.vertexCount, 4, 'quad vertices');
  assert.equal(mesh.triangleCount, 2, 'quad triangles');
  assert.ok(Math.abs(mesh.bounds.min[1] - 1) < 1e-9, 'quad is flat at y=1');
  assert.ok(Math.abs(mesh.bounds.max[1] - 1) < 1e-9, 'quad is flat at y=1');
  assert.ok(Math.abs(mesh.bounds.max[0] - 2) < 1e-5, `quad width along x, got max x ${mesh.bounds.max[0]}`);
  assert.ok(Math.abs(mesh.bounds.max[2] - 4) < 1e-5, `quad length along z, got max z ${mesh.bounds.max[2]}`);
  for (let v = 0; v < 4; v += 1) assert.equal(mesh.normals[v * 3 + 1], 1, 'quad normal +Y');
});

test('addSphere produces unit normals and the requested radius', () => {
  const builder = createMeshBuilder();
  builder.addSphere(5, 2, -3, 1.5, { segments: 8, rings: 6 });
  const mesh = builder.build();
  assertFiniteMesh(mesh, 'sphere');
  assert.ok(Math.abs(mesh.bounds.max[1] - 3.5) < 1e-4, `sphere top at y=3.5, got ${mesh.bounds.max[1]}`);
  assert.ok(Math.abs(mesh.bounds.min[1] - 0.5) < 1e-4, `sphere bottom at y=0.5, got ${mesh.bounds.min[1]}`);
  assert.ok(Math.abs(mesh.bounds.max[0] - 6.5) < 1e-4, `sphere +x at 6.5, got ${mesh.bounds.max[0]}`);
  for (let v = 0; v < mesh.vertexCount; v += 1) {
    const length = Math.hypot(
      mesh.normals[v * 3],
      mesh.normals[v * 3 + 1],
      mesh.normals[v * 3 + 2],
    );
    assert.ok(Math.abs(length - 1) < 1e-4, `sphere vertex ${v} normal length ${length}`);
  }
});

test('mergeMesh transforms positions and keeps indices in range', () => {
  const cube = createUnitCubeMesh([1, 1, 1]);
  const builder = createMeshBuilder();
  builder.mergeMesh(cube, translation4(10, 0, 0));
  const merged = builder.build();

  assert.equal(merged.vertexCount, cube.vertexCount, 'merge keeps vertex count');
  assert.equal(merged.triangleCount, cube.triangleCount, 'merge keeps triangle count');
  assert.ok(Math.abs(merged.bounds.min[0] - 9.5) < 1e-5, `merged min x should be 9.5, got ${merged.bounds.min[0]}`);
  assert.ok(Math.abs(merged.bounds.max[0] - 10.5) < 1e-5, `merged max x should be 10.5, got ${merged.bounds.max[0]}`);
  assertFiniteMesh(merged, 'merged cube');
});

test('mergeMesh rotates normals and supports colour override/tint', () => {
  const cube = createUnitCubeMesh([1, 1, 1]);
  const builder = createMeshBuilder();
  builder.mergeMesh(cube, rotationY(Math.PI / 2), { color: [0.25, 0.5, 0.75], emissive: 0.5 });
  const merged = builder.build();
  for (let v = 0; v < merged.vertexCount; v += 1) {
    const length = Math.hypot(
      merged.normals[v * 3],
      merged.normals[v * 3 + 1],
      merged.normals[v * 3 + 2],
    );
    assert.ok(Math.abs(length - 1) < 1e-5, `merged normal ${v} is not unit length`);
    assert.equal(merged.colors[v * 4], 0.25, 'colour override r');
    assert.equal(merged.colors[v * 4 + 1], 0.5, 'colour override g');
    assert.equal(merged.colors[v * 4 + 2], 0.75, 'colour override b');
    assert.equal(merged.colors[v * 4 + 3], 0.5, 'emissive override');
  }
});

test('mergeMesh applies a tint by multiplication', () => {
  const cube = createUnitCubeMesh([0.8, 0.4, 0.2]);
  const builder = createMeshBuilder();
  builder.mergeMesh(cube, mat4(), { tint: [0.5, 1, 0.25] });
  const merged = builder.build();
  assert.ok(Math.abs(merged.colors[0] - 0.4) < 1e-5, `tinted r should be 0.4, got ${merged.colors[0]}`);
  assert.ok(Math.abs(merged.colors[1] - 0.4) < 1e-5, `tinted g should be 0.4, got ${merged.colors[1]}`);
  assert.ok(Math.abs(merged.colors[2] - 0.05) < 1e-5, `tinted b should be 0.05, got ${merged.colors[2]}`);
});

test('mergeMesh ignores empty or missing meshes', () => {
  const builder = createMeshBuilder();
  builder.mergeMesh(null, mat4());
  builder.mergeMesh({ vertexCount: 0 }, mat4());
  assert.equal(builder.vertexCount, 0, 'merging nothing adds nothing');
  assert.equal(builder.triangleCount, 0, 'merging nothing adds no triangles');
});

test('mergeMeshes combines complete meshes', () => {
  const a = createUnitCubeMesh();
  const b = createUnitCubeMesh();
  const merged = mergeMeshes([a, b]);
  assert.equal(merged.vertexCount, a.vertexCount + b.vertexCount, 'merged vertex count');
  assert.equal(merged.triangleCount, a.triangleCount + b.triangleCount, 'merged triangle count');
  const counted = countGeometry([{ mesh: a }, { mesh: b }]);
  assert.deepEqual(counted, { vertices: 48, triangles: 24 }, 'countGeometry totals');
});

test('build() is idempotent and returns independent copies', () => {
  const builder = createMeshBuilder();
  builder.addBox(0, 0.5, 0, 1, 1, 1, { color: [1, 0, 0] });
  const first = builder.build();
  const second = builder.build();

  assert.equal(first.vertexCount, second.vertexCount, 'vertex count stable across build()');
  assert.equal(first.triangleCount, second.triangleCount, 'triangle count stable across build()');
  assert.deepEqual(Array.from(first.positions), Array.from(second.positions), 'positions stable across build()');
  assert.notEqual(first.positions, second.positions, 'build() must not hand back the same mutable buffer');

  // Mutating the returned mesh must not corrupt the builder.
  first.positions[0] = 999;
  const third = builder.build();
  assert.notEqual(third.positions[0], 999, 'returned meshes are copies');
});

test('an empty builder builds a valid empty mesh', () => {
  const mesh = createMeshBuilder().build();
  assert.equal(mesh.vertexCount, 0, 'empty mesh vertex count');
  assert.equal(mesh.triangleCount, 0, 'empty mesh triangle count');
  assert.equal(mesh.indices.length, 0, 'empty mesh index count');
  assert.deepEqual(mesh.bounds.min, [0, 0, 0], 'empty mesh min bounds');
  assert.deepEqual(mesh.bounds.max, [0, 0, 0], 'empty mesh max bounds');
});

test('large vertex counts grow the builder buffers', () => {
  const builder = createMeshBuilder();
  for (let i = 0; i < 3000; i += 1) {
    builder.addBox(i * 2, 0, 0, 1, 1, 1, { color: [1, 1, 1] });
  }
  const mesh = builder.build();
  assert.equal(mesh.vertexCount, 3000 * 24, 'large builder vertex count');
  assert.equal(mesh.triangleCount, 3000 * 12, 'large builder triangle count');
  assert.equal(mesh.positions.length, mesh.vertexCount * 3, 'large builder positions length');
});

test('createUnitCubeMesh has its base on y=0', () => {
  const cube = createUnitCubeMesh([0.5, 0.5, 0.5]);
  assertFiniteMesh(cube, 'unit cube');
  assert.deepEqual(cube.bounds.min, [-0.5, 0, -0.5], 'unit cube min bounds');
  assert.deepEqual(cube.bounds.max, [0.5, 1, 0.5], 'unit cube max bounds');
});
