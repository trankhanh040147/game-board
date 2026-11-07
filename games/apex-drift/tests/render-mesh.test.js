import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CAR_ORDER, CAR_SPECS, TRACK_DEFS, TRACK_ORDER } from '../src/sim/config.js';
import { createCanyonScenery, createCityScenery } from '../src/render/props.js';
import { buildTrackMeshes } from '../src/render/worldMesh.js';
import { buildTrack } from '../src/sim/track.js';
import {
  WHEEL_BASE,
  WHEEL_OFFSETS,
  WHEEL_RADIUS,
  WHEEL_TRACK,
  WHEEL_WIDTH,
  createCarBodyMesh,
  createWheelMesh,
} from '../src/render/carModel.js';

/* ------------------------------------------------------------- utilities -- */

function assertCleanMesh(mesh, label, { normalTolerance = 1e-4 } = {}) {
  assert.ok(mesh && typeof mesh === 'object', `${label}: no mesh returned`);
  assert.ok(mesh.vertexCount > 0, `${label}: empty mesh`);
  assert.equal(mesh.positions.length, mesh.vertexCount * 3, `${label}: positions length`);
  assert.equal(mesh.normals.length, mesh.vertexCount * 3, `${label}: normals length`);
  assert.equal(mesh.colors.length, mesh.vertexCount * 4, `${label}: colors length`);
  assert.equal(mesh.indices.length, mesh.triangleCount * 3, `${label}: indices length`);
  assert.equal(mesh.indices.length % 3, 0, `${label}: index count not a multiple of 3`);

  for (const [name, array] of [
    ['positions', mesh.positions],
    ['normals', mesh.normals],
    ['colors', mesh.colors],
  ]) {
    for (let i = 0; i < array.length; i += 1) {
      assert.ok(Number.isFinite(array[i]), `${label}: ${name}[${i}] is not finite`);
    }
  }
  for (let i = 0; i < mesh.indices.length; i += 1) {
    assert.ok(
      mesh.indices[i] >= 0 && mesh.indices[i] < mesh.vertexCount,
      `${label}: index ${mesh.indices[i]} out of range at ${i}`,
    );
  }
  for (let v = 0; v < mesh.vertexCount; v += 1) {
    const length = Math.hypot(mesh.normals[v * 3], mesh.normals[v * 3 + 1], mesh.normals[v * 3 + 2]);
    assert.ok(Math.abs(length - 1) < normalTolerance, `${label}: normal ${v} length ${length} is not unit`);
    for (let c = 0; c < 4; c += 1) {
      const channel = mesh.colors[v * 4 + c];
      assert.ok(channel >= 0 && channel <= 1, `${label}: colour channel ${channel} outside 0..1`);
    }
  }
}

function positionsHash(mesh) {
  let hash = 2166136261;
  for (let i = 0; i < mesh.positions.length; i += 1) {
    hash ^= Math.round(mesh.positions[i] * 1000) | 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function triangleNormalAgreesWithNormal(mesh) {
  for (let t = 0; t < mesh.triangleCount; t += 1) {
    const ia = mesh.indices[t * 3];
    const ib = mesh.indices[t * 3 + 1];
    const ic = mesh.indices[t * 3 + 2];
    const ax = mesh.positions[ia * 3];
    const ay = mesh.positions[ia * 3 + 1];
    const az = mesh.positions[ia * 3 + 2];
    const bx = mesh.positions[ib * 3] - ax;
    const by = mesh.positions[ib * 3 + 1] - ay;
    const bz = mesh.positions[ib * 3 + 2] - az;
    const cx = mesh.positions[ic * 3] - ax;
    const cy = mesh.positions[ic * 3 + 1] - ay;
    const cz = mesh.positions[ic * 3 + 2] - az;
    const gx = by * cz - bz * cy;
    const gy = bz * cx - bx * cz;
    const gz = bx * cy - by * cx;
    const length = Math.hypot(gx, gy, gz);
    if (length < 1e-9) continue; // degenerate but harmless
    const nx = mesh.normals[ia * 3];
    const ny = mesh.normals[ia * 3 + 1];
    const nz = mesh.normals[ia * 3 + 2];
    assert.ok(
      gx * nx + gy * ny + gz * nz > 0,
      `triangle ${t} is wound clockwise relative to its vertex normal`,
    );
  }
}

/* ------------------------------------------------------------ car bodies -- */

test('car body meshes are clean, compact and car-sized', () => {
  for (const id of CAR_ORDER) {
    const mesh = createCarBodyMesh(CAR_SPECS[id].palette);
    assertCleanMesh(mesh, `${id} body`);
    assert.ok(
      mesh.triangleCount <= 1500,
      `${id} body uses ${mesh.triangleCount} triangles (budget 1500)`,
    );
    triangleNormalAgreesWithNormal(mesh);

    const { min, max } = mesh.bounds;
    const width = max[0] - min[0];
    const height = max[1] - min[1];
    const length = max[2] - min[2];

    assert.ok(Math.abs(min[0]) <= 1.1 && Math.abs(max[0]) <= 1.1, `${id} body half-width ${Math.max(Math.abs(min[0]), Math.abs(max[0]))} > 1.1 m`);
    assert.ok(width > 1.6 && width < 2.2, `${id} body width ${width.toFixed(2)} m outside 1.6-2.2`);
    assert.ok(min[1] >= -1e-6, `${id} body dips ${(-min[1]).toFixed(3)} m below the ground plane`);
    assert.ok(min[1] < 0.25, `${id} body floats ${min[1].toFixed(2)} m above the ground plane`);
    assert.ok(max[1] <= 1.3, `${id} body height ${max[1].toFixed(2)} m > 1.3 (contract ~1.15 m)`);
    assert.ok(height > 0.9 && height < 1.3, `${id} body height ${height.toFixed(2)} m outside 0.9-1.3`);
    assert.ok(Math.abs(min[2]) <= 2.4 && Math.abs(max[2]) <= 2.4, `${id} body length extends past +/-2.4 m`);
    assert.ok(length > 3.8 && length < 5.0, `${id} body length ${length.toFixed(2)} m outside 3.8-5.0`);
  }
});

test('car body origin sits at the ground contact centre', () => {
  const mesh = createCarBodyMesh(CAR_SPECS.vanko.palette);
  const { min, max } = mesh.bounds;
  const centreX = (min[0] + max[0]) / 2;
  const centreZ = (min[2] + max[2]) / 2;
  assert.ok(Math.abs(centreX) < 0.05, `body is not centred on x=0 (centre ${centreX.toFixed(3)})`);
  assert.ok(Math.abs(centreZ) < 0.1, `body is not centred on z=0 (centre ${centreZ.toFixed(3)})`);
});

test('car body carries emissive headlights at +Z and taillights at -Z', () => {
  const mesh = createCarBodyMesh(CAR_SPECS.vanko.palette);
  const emissive = [];
  for (let v = 0; v < mesh.vertexCount; v += 1) {
    const alpha = mesh.colors[v * 4 + 3];
    if (alpha > 0.4) {
      emissive.push({
        x: mesh.positions[v * 3],
        y: mesh.positions[v * 3 + 1],
        z: mesh.positions[v * 3 + 2],
        r: mesh.colors[v * 4],
        g: mesh.colors[v * 4 + 1],
        b: mesh.colors[v * 4 + 2],
      });
    }
  }
  assert.ok(emissive.length > 20, `expected emissive light vertices, got ${emissive.length}`);

  const front = emissive.filter((vertex) => vertex.z > 1.5);
  const rear = emissive.filter((vertex) => vertex.z < -1.5);
  assert.ok(front.length > 0, 'no emissive headlight vertices at the front');
  assert.ok(rear.length > 0, 'no emissive taillight vertices at the rear');

  for (const vertex of front) {
    assert.ok(vertex.r > 0.7 && vertex.g > 0.7 && vertex.b > 0.7, 'headlights should be white-ish');
  }
  for (const vertex of rear) {
    assert.ok(vertex.r > 0.5 && vertex.g < 0.6, `taillights should be red, got ${vertex.r}/${vertex.g}/${vertex.b}`);
  }
});

test('car body paint comes from the palette and changes per car', () => {
  const built = CAR_ORDER.map((id) => createCarBodyMesh(CAR_SPECS[id].palette));

  for (const [index, id] of CAR_ORDER.entries()) {
    const mesh = built[index];
    const paint = CAR_SPECS[id].palette.paint;
    let matches = 0;
    for (let v = 0; v < mesh.vertexCount; v += 1) {
      if (
        Math.abs(mesh.colors[v * 4] - paint[0]) < 0.01
        && Math.abs(mesh.colors[v * 4 + 1] - paint[1]) < 0.01
        && Math.abs(mesh.colors[v * 4 + 2] - paint[2]) < 0.01
      ) {
        matches += 1;
      }
    }
    assert.ok(matches > 100, `${id}: only ${matches} vertices use the paint colour`);
  }

  const hashes = built.map((mesh) => positionsHash(mesh));
  assert.equal(new Set(hashes).size, 1, 'body geometry should be shared across palettes (paint is vertex colour only)');
});

test('car body building is deterministic', () => {
  for (const id of CAR_ORDER) {
    const first = createCarBodyMesh(CAR_SPECS[id].palette);
    const second = createCarBodyMesh(CAR_SPECS[id].palette);
    assert.equal(first.vertexCount, second.vertexCount, `${id}: vertex count changed between builds`);
    assert.equal(first.triangleCount, second.triangleCount, `${id}: triangle count changed between builds`);
    assert.equal(positionsHash(first), positionsHash(second), `${id}: vertex positions changed between builds`);
  }
});

test('createCarBodyMesh tolerates missing or string colours', () => {
  const bare = createCarBodyMesh();
  assertCleanMesh(bare, 'default-palette body');
  const stringy = createCarBodyMesh({ paint: '#ff0000', accent: '#001122', glass: '#000000' });
  assertCleanMesh(stringy, 'string-palette body');
});

/* ----------------------------------------------------------------- wheels -- */

test('wheel meshes are clean and sit on the ground', () => {
  for (const id of CAR_ORDER) {
    const wheel = createWheelMesh(CAR_SPECS[id].palette);
    assertCleanMesh(wheel, `${id} wheel`);
    assert.ok(wheel.triangleCount <= 400, `${id} wheel uses ${wheel.triangleCount} triangles (budget 400)`);
    triangleNormalAgreesWithNormal(wheel); // sidewall caps must not be culled

    const { min, max } = wheel.bounds;
    const spanY = max[1] - min[1];
    const spanZ = max[2] - min[2];
    const spanX = max[0] - min[0];
    assert.ok(
      Math.abs(spanY - WHEEL_RADIUS * 2) < 0.03,
      `${id}: wheel diameter ${spanY.toFixed(3)} m should be ~${(WHEEL_RADIUS * 2).toFixed(3)} m`,
    );
    assert.ok(
      Math.abs(spanZ - WHEEL_RADIUS * 2) < 0.03,
      `${id}: wheel round in Z, diameter ${spanZ.toFixed(3)} m`,
    );
    assert.ok(
      Math.abs((min[1] + max[1]) / 2) < 0.01,
      `${id}: wheel centre should be at y=0, got ${((min[1] + max[1]) / 2).toFixed(3)}`,
    );
    assert.ok(
      Math.abs((min[2] + max[2]) / 2) < 0.01,
      `${id}: wheel centre should be at z=0, got ${((min[2] + max[2]) / 2).toFixed(3)}`,
    );
    assert.ok(
      spanX >= WHEEL_WIDTH * 0.95 && spanX <= WHEEL_WIDTH + 0.15,
      `${id}: wheel width along X is ${spanX.toFixed(3)} m (tyre ${WHEEL_WIDTH} m)`,
    );
  }
});

test('wheel constants describe a four-wheel car', () => {
  assert.ok(WHEEL_RADIUS > 0.2 && WHEEL_RADIUS < 0.6, `WHEEL_RADIUS ${WHEEL_RADIUS} out of range`);
  assert.ok(WHEEL_WIDTH > 0.15 && WHEEL_WIDTH < 0.5, `WHEEL_WIDTH ${WHEEL_WIDTH} out of range`);
  assert.ok(WHEEL_TRACK > 0.5 && WHEEL_TRACK < 1.2, `WHEEL_TRACK ${WHEEL_TRACK} out of range`);
  assert.ok(WHEEL_BASE > 0.8 && WHEEL_BASE < 2, `WHEEL_BASE ${WHEEL_BASE} out of range`);
  assert.equal(WHEEL_OFFSETS.length, 4, `expected 4 wheel offsets, got ${WHEEL_OFFSETS.length}`);

  const fronts = WHEEL_OFFSETS.filter((offset) => offset.front);
  const rears = WHEEL_OFFSETS.filter((offset) => !offset.front);
  const lefts = WHEEL_OFFSETS.filter((offset) => offset.left);
  assert.equal(fronts.length, 2, 'two front wheels');
  assert.equal(rears.length, 2, 'two rear wheels');
  assert.equal(lefts.length, 2, 'two left wheels');

  for (const offset of WHEEL_OFFSETS) {
    assert.ok(Math.abs(offset.y - WHEEL_RADIUS) < 1e-9, 'wheel centre must sit one radius above the ground');
    assert.ok(Math.abs(Math.abs(offset.x) - WHEEL_TRACK) < 1e-9, 'wheel x offset should be WHEEL_TRACK');
    assert.ok(Math.abs(Math.abs(offset.z) - WHEEL_BASE) < 1e-9, 'wheel z offset should be WHEEL_BASE');
    assert.ok(Number.isFinite(offset.y) && Number.isFinite(offset.z), 'wheel offsets must be finite');
  }

  // Front wheels face +Z and left wheels sit on -X, matching the car heading convention.
  for (const offset of WHEEL_OFFSETS) {
    assert.equal(offset.front, offset.z > 0, 'front flag should follow +Z');
    assert.equal(offset.left, offset.x < 0, 'left flag should follow -X');
  }
});

test('wheel building is deterministic and palette-driven', () => {
  const first = createWheelMesh(CAR_SPECS.vanko.palette);
  const second = createWheelMesh(CAR_SPECS.vanko.palette);
  assert.equal(first.triangleCount, second.triangleCount, 'wheel triangle count changed');
  assert.equal(positionsHash(first), positionsHash(second), 'wheel vertex positions changed');

  const other = createWheelMesh(CAR_SPECS.kira.palette);
  assert.equal(other.triangleCount, first.triangleCount, 'wheel geometry should not depend on palette');
  assert.notDeepEqual(
    Array.from(other.colors.slice(0, 40)),
    Array.from(first.colors.slice(0, 40)),
    'wheel rim/tyre colours should change with the palette',
  );
});

/* -------------------------------------------------------------- world mesh -- */

/* --------------------------------------------------------------- scenery -- */

function hashMesh(mesh) {
  let hash = 2166136261;
  for (let i = 0; i < mesh.positions.length; i += 7) {
    hash ^= Math.round(mesh.positions[i] * 100) | 0;
    hash = Math.imul(hash, 16777619);
    hash ^= Math.round(mesh.colors[i] * 100) | 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

test('both tracks build complete static world meshes under the triangle budget', () => {
  for (const id of TRACK_ORDER) {
    const def = TRACK_DEFS[id];
    const track = buildTrack(def);
    const built = buildTrackMeshes({ track, palette: def.palette, seed: def.seed });

    assert.ok(Array.isArray(built.batches) && built.batches.length >= 2, `${id}: expected several draw batches, got ${built.batches?.length}`);
    assert.ok(
      built.triangles <= 120_000,
      `${id}: ${built.triangles} triangles exceeds the 120k budget`,
    );

    let summed = 0;
    const names = new Set();
    for (const [index, batch] of built.batches.entries()) {
      assert.ok(batch.mesh, `${id}: batch ${index} has no mesh`);
      assert.equal(typeof batch.name, 'string', `${id}: batch ${index} has no name`);
      assert.ok(!names.has(batch.name), `${id}: duplicate batch name '${batch.name}'`);
      names.add(batch.name);
      // Procedural scenery accumulates float32 rounding through merges; the
      // shader renormalises, so allow a tight-but-not-exact tolerance here.
      assertCleanMesh(batch.mesh, `${id}/${batch.name}`, { normalTolerance: 2e-3 });
      assert.equal(batch.mesh.indices.length % 3, 0, `${id}/${batch.name}: index count not a multiple of 3`);
      summed += batch.mesh.triangleCount;
    }
    assert.equal(summed, built.triangles, `${id}: triangles field ${built.triangles} != summed batches ${summed}`);
    assert.ok(summed > 10_000, `${id}: only ${summed} triangles of static geometry`);

    assert.ok(Array.isArray(built.lamps), `${id}: lamps must be an array`);
    assert.ok(built.lamps.length > 0, `${id}: no lamp glow sources`);
    for (const [index, lamp] of built.lamps.slice(0, 200).entries()) {
      for (const axis of ['x', 'y', 'z', 'size']) {
        assert.ok(Number.isFinite(lamp[axis]), `${id}: lamp ${index} ${axis} is not finite`);
      }
      assert.ok(Array.isArray(lamp.color) && lamp.color.length === 3, `${id}: lamp ${index} has no colour`);
      for (const channel of lamp.color) {
        assert.ok(Number.isFinite(channel) && channel >= 0, `${id}: lamp ${index} colour channel ${channel}`);
      }
      assert.ok(lamp.size > 0, `${id}: lamp ${index} has a non-positive size`);
    }

    assert.ok(Array.isArray(built.minimap), `${id}: minimap must be an array`);
    assert.ok(
      built.minimap.length >= 40,
      `${id}: minimap outline has ${built.minimap.length} points (needs >= 40)`,
    );
    for (const [index, point] of built.minimap.entries()) {
      assert.ok(Array.isArray(point) && point.length === 2, `${id}: minimap point ${index} is not [x,z]`);
      assert.ok(Number.isFinite(point[0]) && Number.isFinite(point[1]), `${id}: minimap point ${index} is not finite`);
      let nearest = Infinity;
      for (const sample of track.samples) {
        nearest = Math.min(nearest, Math.hypot(point[0] - sample.x, point[1] - sample.z));
      }
      assert.ok(nearest < 20, `${id}: minimap point ${index} is ${nearest.toFixed(1)} m from the track`);
    }
  }
});

test('buildTrackMeshes is deterministic for a seed', () => {
  for (const id of TRACK_ORDER) {
    const def = TRACK_DEFS[id];
    const track = buildTrack(def);
    const first = buildTrackMeshes({ track, palette: def.palette, seed: def.seed });
    const second = buildTrackMeshes({ track, palette: def.palette, seed: def.seed });

    assert.equal(first.triangles, second.triangles, `${id}: triangle count changed between identical builds`);
    assert.equal(first.batches.length, second.batches.length, `${id}: batch count changed between identical builds`);
    for (let i = 0; i < first.batches.length; i += 1) {
      assert.equal(
        hashMesh(first.batches[i].mesh),
        hashMesh(second.batches[i].mesh),
        `${id}: batch '${first.batches[i].name}' differs between identical builds`,
      );
    }
    assert.deepEqual(first.lamps, second.lamps, `${id}: lamp list differs between identical builds`);
    assert.deepEqual(first.minimap, second.minimap, `${id}: minimap differs between identical builds`);
  }
});

test('city and canyon scenery build clean, deterministic prop meshes', () => {
  const cases = [
    ['neon-bay', createCityScenery],
    ['sunset-canyon', createCanyonScenery],
  ];
  for (const [id, createScenery] of cases) {
    const def = TRACK_DEFS[id];
    const track = buildTrack(def);
    const scenery = createScenery({ track, palette: def.palette, seed: def.seed });

    assert.ok(scenery && scenery.mesh, `${id}: scenery did not return a mesh`);
    assertCleanMesh(scenery.mesh, `${id} scenery`, { normalTolerance: 2e-3 });
    assert.ok(
      scenery.mesh.triangleCount <= 120_000,
      `${id}: scenery uses ${scenery.mesh.triangleCount} triangles (budget 120k)`,
    );
    assert.ok(scenery.mesh.triangleCount > 1_000, `${id}: scenery is suspiciously small (${scenery.mesh.triangleCount} tris)`);
    assert.ok(Array.isArray(scenery.lamps), `${id}: scenery.lamps must be an array`);
    for (const [index, lamp] of scenery.lamps.slice(0, 100).entries()) {
      assert.ok(Number.isFinite(lamp.x) && Number.isFinite(lamp.y) && Number.isFinite(lamp.z), `${id}: lamp ${index} position not finite`);
    }

    const again = createScenery({ track, palette: def.palette, seed: def.seed });
    assert.equal(scenery.mesh.triangleCount, again.mesh.triangleCount, `${id}: scenery triangle count not deterministic`);
    assert.equal(hashMesh(scenery.mesh), hashMesh(again.mesh), `${id}: scenery geometry not deterministic for a seed`);
    assert.deepEqual(scenery.lamps, again.lamps, `${id}: scenery lamps not deterministic`);
  }
});

test('scenery varies with the seed', () => {
  for (const [id, createScenery] of [['neon-bay', createCityScenery], ['sunset-canyon', createCanyonScenery]]) {
    const def = TRACK_DEFS[id];
    const track = buildTrack(def);
    const a = createScenery({ track, palette: def.palette, seed: def.seed });
    const b = createScenery({ track, palette: def.palette, seed: def.seed + 7 });
    assert.notEqual(hashMesh(a.mesh), hashMesh(b.mesh), `${id}: changing the seed did not change the scenery`);
  }
});
