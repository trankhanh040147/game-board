/**
 * Vertex builder + primitive shapes + mesh merging.
 *
 * Every visual object in the game uses one vertex format:
 *
 *   aPosition vec3 | aNormal vec3 | aColor vec4   (alpha = emissive 0..1)
 *
 * Static scenery is composed into a handful of huge meshes so the renderer can
 * issue one draw call per batch. Meshes are plain typed arrays, which keeps this
 * module usable from Node tests (no GL calls here).
 */

import {
  clamp01,
  mat4,
  normalMatrix3,
  transformPoint3,
} from './math.js';

export const IDENTITY_MATRIX = mat4();

const FLOATS_PER_VERTEX = 10; // 3 pos + 3 normal + 4 color

/**
 * @typedef {{
 *   positions: Float32Array,
 *   normals: Float32Array,
 *   colors: Float32Array,
 *   indices: Uint32Array,
 *   vertexCount: number,
 *   triangleCount: number,
 *   bounds: {min: number[], max: number[]},
 * }} Mesh
 */

/* Box faces, counter-clockwise when viewed from outside. */
const BOX_FACES = [
  { n: [1, 0, 0], c: [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]] },
  { n: [-1, 0, 0], c: [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]] },
  { n: [0, 1, 0], c: [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]] },
  { n: [0, -1, 0], c: [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]] },
  { n: [0, 0, 1], c: [[1, -1, 1], [1, 1, 1], [-1, 1, 1], [-1, -1, 1]] },
  { n: [0, 0, -1], c: [[-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1]] },
];

function rotateY(x, y, z, angle) {
  if (!angle) return [x, y, z];
  const s = Math.sin(angle);
  const c = Math.cos(angle);
  return [c * x + s * z, y, -s * x + c * z];
}

/** Axis remap used by cylinders: local +Y becomes the requested axis. */
function remapAxis(x, y, z, axis) {
  if (axis === 'x') return [y, -x, z];
  if (axis === 'z') return [x, -z, y];
  return [x, y, z];
}

function emptyMesh() {
  return {
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    colors: new Float32Array(0),
    indices: new Uint32Array(0),
    vertexCount: 0,
    triangleCount: 0,
    bounds: { min: [0, 0, 0], max: [0, 0, 0] },
  };
}

/** Create a growable mesh builder. */
export function createMeshBuilder() {
  let vertexCapacity = 1024;
  let positions = new Float32Array(vertexCapacity * 3);
  let normals = new Float32Array(vertexCapacity * 3);
  let colors = new Float32Array(vertexCapacity * 4);
  let vertexCount = 0;

  let indexCapacity = 4096;
  let indices = new Uint32Array(indexCapacity);
  let indexCount = 0;

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  function growVertices(extra) {
    if (vertexCount + extra <= vertexCapacity) return;
    let capacity = vertexCapacity;
    while (vertexCount + extra > capacity) capacity *= 2;
    const nextPositions = new Float32Array(capacity * 3);
    const nextNormals = new Float32Array(capacity * 3);
    const nextColors = new Float32Array(capacity * 4);
    nextPositions.set(positions.subarray(0, vertexCount * 3));
    nextNormals.set(normals.subarray(0, vertexCount * 3));
    nextColors.set(colors.subarray(0, vertexCount * 4));
    positions = nextPositions;
    normals = nextNormals;
    colors = nextColors;
    vertexCapacity = capacity;
  }

  function growIndices(extra) {
    if (indexCount + extra <= indexCapacity) return;
    let capacity = indexCapacity;
    while (indexCount + extra > capacity) capacity *= 2;
    const next = new Uint32Array(capacity);
    next.set(indices.subarray(0, indexCount));
    indices = next;
    indexCapacity = capacity;
  }

  const builder = {
    get vertexCount() {
      return vertexCount;
    },
    get triangleCount() {
      return indexCount / 3;
    },

    /** Append one vertex; returns its index. */
    pushVertex(x, y, z, nx, ny, nz, r, g, b, emissive = 0) {
      growVertices(1);
      const p = vertexCount * 3;
      const c = vertexCount * 4;
      positions[p] = x;
      positions[p + 1] = y;
      positions[p + 2] = z;
      normals[p] = nx;
      normals[p + 1] = ny;
      normals[p + 2] = nz;
      colors[c] = r;
      colors[c + 1] = g;
      colors[c + 2] = b;
      colors[c + 3] = clamp01(emissive);
      if (x < min[0]) min[0] = x;
      if (y < min[1]) min[1] = y;
      if (z < min[2]) min[2] = z;
      if (x > max[0]) max[0] = x;
      if (y > max[1]) max[1] = y;
      if (z > max[2]) max[2] = z;
      vertexCount += 1;
      return vertexCount - 1;
    },

    /** Append a triangle from three existing vertex indices. */
    tri(a, b, c) {
      growIndices(3);
      indices[indexCount] = a;
      indices[indexCount + 1] = b;
      indices[indexCount + 2] = c;
      indexCount += 3;
      return builder;
    },

    /** Append a quad (a-b-c-d counter-clockwise from the front) as two triangles. */
    quad(a, b, c, d) {
      growIndices(6);
      indices[indexCount] = a;
      indices[indexCount + 1] = b;
      indices[indexCount + 2] = c;
      indices[indexCount + 3] = a;
      indices[indexCount + 4] = c;
      indices[indexCount + 5] = d;
      indexCount += 6;
      return builder;
    },

    /** Push a triangle from raw coordinates and a flat normal. */
    triangle(ax, ay, az, bx, by, bz, cx, cy, cz, normal, color, emissive = 0) {
      const [r, g, b] = color;
      const a = builder.pushVertex(ax, ay, az, normal[0], normal[1], normal[2], r, g, b, emissive);
      const bb = builder.pushVertex(bx, by, bz, normal[0], normal[1], normal[2], r, g, b, emissive);
      const cc = builder.pushVertex(cx, cy, cz, normal[0], normal[1], normal[2], r, g, b, emissive);
      return builder.tri(a, bb, cc);
    },

    /** Push a flat quad from four corner objects `{x,y,z}` and a normal. */
    flatQuad(a, b, c, d, normal, color, emissive = 0) {
      const [r, g, bl] = color;
      const ia = builder.pushVertex(a.x, a.y, a.z, normal[0], normal[1], normal[2], r, g, bl, emissive);
      const ib = builder.pushVertex(b.x, b.y, b.z, normal[0], normal[1], normal[2], r, g, bl, emissive);
      const ic = builder.pushVertex(c.x, c.y, c.z, normal[0], normal[1], normal[2], r, g, bl, emissive);
      const id = builder.pushVertex(d.x, d.y, d.z, normal[0], normal[1], normal[2], r, g, bl, emissive);
      return builder.quad(ia, ib, ic, id);
    },

    /**
     * Axis-aligned box, optionally rotated about its own centre.
     * @param {number} cx @param {number} cy @param {number} cz centre
     * @param {number} sx @param {number} sy @param {number} sz full sizes
     * @param {{color:number[], emissive?:number, rotationY?:number, colorTop?:number[], emissiveTop?:number}} opts
     */
    addBox(cx, cy, cz, sx, sy, sz, opts = {}) {
      const color = opts.color ?? [1, 1, 1];
      const colorTop = opts.colorTop ?? color;
      const emissive = opts.emissive ?? 0;
      const emissiveTop = opts.emissiveTop ?? emissive;
      const rotationY = opts.rotationY ?? 0;
      const hx = sx / 2;
      const hy = sy / 2;
      const hz = sz / 2;
      const cos = Math.cos(rotationY);
      const sin = Math.sin(rotationY);

      for (const face of BOX_FACES) {
        const isTop = face.n[1] === 1;
        const faceColor = isTop ? colorTop : color;
        const faceEmissive = isTop ? emissiveTop : emissive;
        const [fnx, fny, fnz] = rotateY(face.n[0], face.n[1], face.n[2], rotationY);
        const verts = face.c.map((corner) => {
          const lx = corner[0] * hx;
          const ly = corner[1] * hy;
          const lz = corner[2] * hz;
          return [
            cx + cos * lx + sin * lz,
            cy + ly,
            cz - sin * lx + cos * lz,
          ];
        });
        const ia = builder.pushVertex(
          verts[0][0], verts[0][1], verts[0][2], fnx, fny, fnz,
          faceColor[0], faceColor[1], faceColor[2], faceEmissive,
        );
        const ib = builder.pushVertex(
          verts[1][0], verts[1][1], verts[1][2], fnx, fny, fnz,
          faceColor[0], faceColor[1], faceColor[2], faceEmissive,
        );
        const ic = builder.pushVertex(
          verts[2][0], verts[2][1], verts[2][2], fnx, fny, fnz,
          faceColor[0], faceColor[1], faceColor[2], faceEmissive,
        );
        const id = builder.pushVertex(
          verts[3][0], verts[3][1], verts[3][2], fnx, fny, fnz,
          faceColor[0], faceColor[1], faceColor[2], faceEmissive,
        );
        builder.quad(ia, ib, ic, id);
      }
      return builder;
    },

    /**
     * Tapered cylinder. Axis `y` grows from the base centre upwards; `x` and `z`
     * grow along the positive axis from the given centre.
     * @param {{color:number[], emissive?:number, segments?:number, axis?:'x'|'y'|'z', capColor?:number[]}} opts
     */
    addCylinder(cx, cy, cz, radiusBottom, radiusTop, height, opts = {}) {
      const color = opts.color ?? [1, 1, 1];
      const capColor = opts.capColor ?? color;
      const emissive = opts.emissive ?? 0;
      const segments = Math.max(3, opts.segments ?? 12);
      const axis = opts.axis ?? 'y';
      const step = (Math.PI * 2) / segments;
      const slope = radiusBottom - radiusTop;

      const bottomRing = [];
      const topRing = [];
      const bottomNormals = [];
      const topNormals = [];

      for (let i = 0; i < segments; i += 1) {
        const angle = i * step;
        const ca = Math.cos(angle);
        const sa = Math.sin(angle);
        const normalLength = Math.hypot(ca * height, slope, sa * height) || 1;
        const nx = (ca * height) / normalLength;
        const ny = slope / normalLength;
        const nz = (sa * height) / normalLength;

        const bx = ca * radiusBottom;
        const bz = sa * radiusBottom;
        const tx = ca * radiusTop;
        const tz = sa * radiusTop;

        const [bpx, bpy, bpz] = remapAxis(bx, 0, bz, axis);
        const [tpx, tpy, tpz] = remapAxis(tx, height, tz, axis);
        const [bnx, bny, bnz] = remapAxis(nx, ny, nz, axis);
        const [tnx, tny, tnz] = remapAxis(nx, ny, nz, axis);

        bottomRing.push([cx + bpx, cy + bpy, cz + bpz]);
        topRing.push([cx + tpx, cy + tpy, cz + tpz]);
        bottomNormals.push([bnx, bny, bnz]);
        topNormals.push([tnx, tny, tnz]);
      }

      for (let i = 0; i < segments; i += 1) {
        const j = (i + 1) % segments;
        const [r, g, b] = color;
        const b0 = bottomRing[i];
        const b1 = bottomRing[j];
        const t1 = topRing[j];
        const t0 = topRing[i];
        const bn0 = bottomNormals[i];
        const bn1 = bottomNormals[j];
        const tn1 = topNormals[j];
        const tn0 = topNormals[i];

        const i0 = builder.pushVertex(b0[0], b0[1], b0[2], bn0[0], bn0[1], bn0[2], r, g, b, emissive);
        const i1 = builder.pushVertex(b1[0], b1[1], b1[2], bn1[0], bn1[1], bn1[2], r, g, b, emissive);
        const i2 = builder.pushVertex(t1[0], t1[1], t1[2], tn1[0], tn1[1], tn1[2], r, g, b, emissive);
        const i3 = builder.pushVertex(t0[0], t0[1], t0[2], tn0[0], tn0[1], tn0[2], r, g, b, emissive);
        builder.quad(i0, i3, i2, i1);
      }

      // Caps: bottom faces -axis, top faces +axis.
      const [capR, capG, capB] = capColor;
      const bottomNormal = remapAxis(0, -1, 0, axis);
      const topNormal = remapAxis(0, 1, 0, axis);
      const bottomCenter = remapAxis(0, 0, 0, axis);
      const topCenter = remapAxis(0, height, 0, axis);
      const bcx = cx + bottomCenter[0];
      const bcy = cy + bottomCenter[1];
      const bcz = cz + bottomCenter[2];
      const tcx = cx + topCenter[0];
      const tcy = cy + topCenter[1];
      const tcz = cz + topCenter[2];
      const bc = builder.pushVertex(
        bcx, bcy, bcz, bottomNormal[0], bottomNormal[1], bottomNormal[2], capR, capG, capB, emissive,
      );
      const tc = builder.pushVertex(
        tcx, tcy, tcz, topNormal[0], topNormal[1], topNormal[2], capR, capG, capB, emissive,
      );
      const bottomIndices = bottomRing.map((p) => {
        const n = bottomNormal;
        return builder.pushVertex(p[0], p[1], p[2], n[0], n[1], n[2], capR, capG, capB, emissive);
      });
      const topIndices = topRing.map((p) => {
        const n = topNormal;
        return builder.pushVertex(p[0], p[1], p[2], n[0], n[1], n[2], capR, capG, capB, emissive);
      });
      for (let i = 0; i < segments; i += 1) {
        const j = (i + 1) % segments;
        // Wound counter-clockwise as seen from outside the cap: the bottom cap
        // faces -axis, the top cap faces +axis.
        builder.tri(bc, bottomIndices[i], bottomIndices[j]);
        builder.tri(tc, topIndices[j], topIndices[i]);
      }
      return builder;
    },

    /** Low-poly UV sphere; cheap treetops, lamp heads and crowd blobs. */
    addSphere(cx, cy, cz, radius, opts = {}) {
      const color = opts.color ?? [1, 1, 1];
      const emissive = opts.emissive ?? 0;
      const segments = Math.max(4, opts.segments ?? 10);
      const rings = Math.max(3, opts.rings ?? 6);
      const [r, g, b] = color;
      const rows = [];
      for (let ring = 0; ring <= rings; ring += 1) {
        const phi = (ring / rings) * Math.PI;
        const ringRadius = Math.sin(phi) * radius;
        const y = Math.cos(phi) * radius;
        const row = [];
        for (let i = 0; i < segments; i += 1) {
          const angle = (i / segments) * Math.PI * 2;
          const x = Math.cos(angle) * ringRadius;
          const z = Math.sin(angle) * ringRadius;
          row.push(
            builder.pushVertex(
              cx + x, cy + y, cz + z,
              x / radius, y / radius, z / radius,
              r, g, b, emissive,
            ),
          );
        }
        rows.push(row);
      }
      // Pole caps are triangle fans (degenerate quads there would waste
      // triangles); the body in between is quads wound CCW from outside.
      for (let i = 0; i < segments; i += 1) {
        const j = (i + 1) % segments;
        builder.tri(rows[0][i], rows[1][j], rows[1][i]);
        const last = rings - 1;
        builder.tri(rows[rings][i], rows[last][i], rows[last][j]);
      }
      for (let ring = 1; ring < rings - 1; ring += 1) {
        for (let i = 0; i < segments; i += 1) {
          const j = (i + 1) % segments;
          builder.quad(rows[ring][i], rows[ring][j], rows[ring + 1][j], rows[ring + 1][i]);
        }
      }
      return builder;
    },

    /**
     * Flat ground quad centred at (x, y, z). `right` and `forward` are unit XZ
     * vectors; the normal is +Y.
     */
    addQuad(x, y, z, rightX, rightZ, forwardX, forwardZ, width, length, opts = {}) {
      const color = opts.color ?? [1, 1, 1];
      const emissive = opts.emissive ?? 0;
      const hw = width / 2;
      const hl = length / 2;
      const p = (rx, lx) => ({
        x: x + rightX * rx + forwardX * lx,
        y,
        z: z + rightZ * rx + forwardZ * lx,
      });
      const a = p(-hw, -hl);
      const b = p(-hw, hl);
      const c = p(hw, hl);
      const d = p(hw, -hl);
      return builder.flatQuad(a, b, c, d, [0, 1, 0], color, emissive);
    },

    /**
     * Ribbon strip along a list of rows. Each row is
     * `{x,y,z, rx,rz, halfWidth}` (or `halfWidthLeft`/`halfWidthRight`), where
     * `rx,rz` is the unit right vector. Emits up-facing quads; `twoSided` adds
     * a downward copy so the strip reads from any angle.
     * @param {Array<{x:number,y:number,z:number,rx:number,rz:number,halfWidth?:number,halfWidthLeft?:number,halfWidthRight?:number}>} rows
     */
    addRibbon(rows, opts = {}) {
      if (!rows || rows.length < 2) return builder;
      const color = opts.color ?? [1, 1, 1];
      const emissive = opts.emissive ?? 0;
      const rowColors = opts.rowColors ?? null;
      const left = [];
      const right = [];

      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        const hw = row.halfWidth ?? opts.halfWidth ?? 1;
        const hwl = row.halfWidthLeft ?? hw;
        const hwr = row.halfWidthRight ?? hw;
        const lx = row.x - row.rx * hwl;
        const lz = row.z - row.rz * hwl;
        const rx = row.x + row.rx * hwr;
        const rz = row.z + row.rz * hwr;
        left.push({ x: lx, y: row.y, z: lz });
        right.push({ x: rx, y: row.y, z: rz });
      }

      const indicesLeft = [];
      const indicesRight = [];
      for (let i = 0; i < rows.length; i += 1) {
        const c = rowColors ? rowColors[i] ?? color : color;
        const l = left[i];
        const r = right[i];
        indicesLeft.push(builder.pushVertex(l.x, l.y, l.z, 0, 1, 0, c[0], c[1], c[2], emissive));
        indicesRight.push(builder.pushVertex(r.x, r.y, r.z, 0, 1, 0, c[0], c[1], c[2], emissive));
      }
      for (let i = 0; i < rows.length - 1; i += 1) {
        builder.quad(indicesLeft[i], indicesLeft[i + 1], indicesRight[i + 1], indicesRight[i]);
        if (opts.twoSided) {
          builder.quad(indicesLeft[i], indicesRight[i], indicesRight[i + 1], indicesLeft[i + 1]);
        }
      }
      return builder;
    },

    /** Append a mesh, transformed by `matrix4` and optionally recoloured. */
    mergeMesh(mesh, matrix4 = IDENTITY_MATRIX, opts = {}) {
      if (!mesh || !mesh.vertexCount) return builder;
      const override = opts.color ?? null;
      const tint = opts.tint ?? null;
      const emissiveOverride = opts.emissive ?? null;
      const normalMatrix = normalMatrix3(matrix4);
      const base = vertexCount;

      for (let v = 0; v < mesh.vertexCount; v += 1) {
        const p = v * 3;
        const c = v * 4;
        const [x, y, z] = transformPoint3(
          matrix4, mesh.positions[p], mesh.positions[p + 1], mesh.positions[p + 2],
        );
        const nx = mesh.normals[p];
        const ny = mesh.normals[p + 1];
        const nz = mesh.normals[p + 2];
        let tnx = normalMatrix[0] * nx + normalMatrix[3] * ny + normalMatrix[6] * nz;
        let tny = normalMatrix[1] * nx + normalMatrix[4] * ny + normalMatrix[7] * nz;
        let tnz = normalMatrix[2] * nx + normalMatrix[5] * ny + normalMatrix[8] * nz;
        const len = Math.hypot(tnx, tny, tnz) || 1;
        tnx /= len;
        tny /= len;
        tnz /= len;

        let r = mesh.colors[c];
        let g = mesh.colors[c + 1];
        let b = mesh.colors[c + 2];
        if (override) {
          r = override[0];
          g = override[1];
          b = override[2];
        }
        if (tint) {
          r *= tint[0];
          g *= tint[1];
          b *= tint[2];
        }
        const emissive = emissiveOverride ?? mesh.colors[c + 3];
        builder.pushVertex(x, y, z, tnx, tny, tnz, clamp01(r), clamp01(g), clamp01(b), emissive);
      }

      for (let i = 0; i < mesh.indices.length; i += 1) {
        growIndices(1);
        indices[indexCount] = base + mesh.indices[i];
        indexCount += 1;
      }
      return builder;
    },

    /** Place an existing mesh with translation/yaw/scale. */
    addMeshAt(mesh, { x = 0, y = 0, z = 0, yaw = 0, scale = 1, color = null, tint = null, emissive = null } = {}) {
      const s = Math.sin(yaw) * scale;
      const c = Math.cos(yaw) * scale;
      const m = mat4();
      m[0] = c;
      m[2] = -s;
      m[5] = scale;
      m[8] = s;
      m[10] = c;
      m[12] = x;
      m[13] = y;
      m[14] = z;
      return builder.mergeMesh(mesh, m, { color, tint, emissive });
    },

    /** Finish and hand back an immutable mesh. */
    build() {
      const hasVertices = vertexCount > 0;
      return {
        positions: positions.slice(0, vertexCount * 3),
        normals: normals.slice(0, vertexCount * 3),
        colors: colors.slice(0, vertexCount * 4),
        indices: indices.slice(0, indexCount),
        vertexCount,
        triangleCount: Math.floor(indexCount / 3),
        bounds: hasVertices
          ? { min: [min[0], min[1], min[2]], max: [max[0], max[1], max[2]] }
          : { min: [0, 0, 0], max: [0, 0, 0] },
      };
    },
  };

  return builder;
}

/**
 * Contract alias: transform a point by a matrix.
 * @returns {[number, number, number]}
 */
export function transformPoint(matrix, x, y, z) {
  return transformPoint3(matrix, x, y, z);
}

/** Merge several completed meshes into one. */
export function mergeMeshes(meshes) {
  const builder = createMeshBuilder();
  for (const mesh of meshes) builder.mergeMesh(mesh);
  return builder.build();
}

/** A tiny unit cube mesh — handy for tests and placeholder props. */
export function createUnitCubeMesh(color = [1, 1, 1]) {
  return createMeshBuilder().addBox(0, 0.5, 0, 1, 1, 1, { color }).build();
}

/**
 * Axis-aligned bounds of a mesh (recomputed from positions when the cached
 * bounds are missing or stale).
 * @returns {{min:[number,number,number], max:[number,number,number]}}
 */
export function meshBounds(mesh) {
  if (!mesh || !mesh.positions || mesh.positions.length === 0) {
    return { min: [0, 0, 0], max: [0, 0, 0] };
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = mesh.positions[i + axis];
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
  }
  return { min, max };
}

/** Count vertices/triangles across batches. */
export function countGeometry(batches) {
  let vertices = 0;
  let triangles = 0;
  for (const batch of batches) {
    const mesh = batch.mesh ?? batch;
    vertices += mesh.vertexCount;
    triangles += mesh.triangleCount;
  }
  return { vertices, triangles };
}

export { emptyMesh, FLOATS_PER_VERTEX };
