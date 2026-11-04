/**
 * Thin WebGL2 wrapper: context creation, program compilation, mesh upload and
 * the dynamic sprite buffer used for glow billboards and shadow blobs.
 *
 * Deliberately small — the renderer owns scene semantics, this module only
 * knows how to talk to the driver and how to fail loudly during development.
 */

/** @typedef {{ program: WebGLProgram, uniforms: Record<string, WebGLUniformLocation|null> }} CompiledProgram */

/**
 * Create a WebGL2 context, returning a friendly error instead of throwing so the
 * shell can show a fallback panel.
 */
export function createGLContext(canvas, options = {}) {
  const attributes = {
    alpha: false,
    antialias: options.antialias ?? true,
    depth: true,
    stencil: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: options.preserveDrawingBuffer ?? false,
    failIfMajorPerformanceCaveat: false,
    ...options.contextAttributes,
  };
  let gl = null;
  try {
    gl = canvas.getContext('webgl2', attributes);
  } catch (error) {
    return { gl: null, error: `WebGL2 context creation failed: ${error.message}` };
  }
  if (!gl) {
    return {
      gl: null,
      error:
        'WebGL2 is not available in this browser. Apex Drift needs WebGL2 (Chrome, Edge, Firefox or Safari 15+).',
    };
  }
  return { gl, error: null };
}

function compileShader(gl, type, source, label) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('could not create shader');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? 'unknown compile error';
    gl.deleteShader(shader);
    throw new Error(`${label} shader compile failed: ${log}`);
  }
  return shader;
}

/**
 * Compile and link a program, caching uniform locations by name.
 * @returns {CompiledProgram}
 */
export function createProgram(gl, vertexSource, fragmentSource, label = 'program') {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource, `${label} vertex`);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource, `${label} fragment`);
  const program = gl.createProgram();
  if (!program) throw new Error('could not create program');
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? 'unknown link error';
    gl.deleteProgram(program);
    throw new Error(`${label} link failed: ${log}`);
  }

  const uniforms = Object.create(null);
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) ?? 0;
  for (let i = 0; i < count; i += 1) {
    const info = gl.getActiveUniform(program, i);
    if (!info) continue;
    const name = info.name.replace(/\[0]$/, '');
    uniforms[name] = gl.getUniformLocation(program, info.name);
  }
  return { program, uniforms };
}

/**
 * Upload a mesh to the GPU. Vertex layout matches `src/core/mesh.js`:
 * position(3) at 0, normal(3) at 1, colour+emissive(4) at 2.
 */
export function createMeshVAO(gl, mesh) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

  const normalBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

  const colorBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.colors, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 0, 0);

  const indexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);

  return {
    vao,
    indexCount: mesh.indices.length,
    vertexCount: mesh.vertexCount,
    buffers: [positionBuffer, normalBuffer, colorBuffer, indexBuffer],
  };
}

/**
 * Dynamic interleaved sprite batch.
 *
 * Per-sprite vertex: centre(3) + corner(2) + colour(4) + size(1) = 10 floats.
 * A sprite is expanded into six vertices on the CPU, which keeps the shaders
 * trivial and the shader count low.
 */
export function createSpriteBatch(gl, capacity = 512) {
  const vertexCount = capacity * 6;
  const data = new Float32Array(vertexCount * 10);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const stride = 40;
  gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 12);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 20);
  gl.enableVertexAttribArray(3);
  gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 36);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  const cornerOrder = [
    [-1, -1], [1, -1], [1, 1],
    [-1, -1], [1, 1], [-1, 1],
  ];

  return {
    vao,
    buffer,
    data,
    capacity,
    stride,
    count: 0,

    begin() {
      this.count = 0;
      return this;
    },

    /**
     * Push one sprite; silently drops sprites beyond capacity.
     *
     * `a` is the packed per-sprite "extra" channel: glow billboards use it as
     * brightness, shadow blobs use it as the ellipse X radius (with `size` as the
     * Z radius).
     */
    push(x, y, z, r, g, b, a, size) {
      if (this.count >= this.capacity) return this;
      const base = this.count * 6 * 10;
      const d = data;
      for (let corner = 0; corner < 6; corner += 1) {
        const [cx, cy] = cornerOrder[corner];
        const offset = base + corner * 10;
        d[offset] = x;
        d[offset + 1] = y;
        d[offset + 2] = z;
        d[offset + 3] = cx;
        d[offset + 4] = cy;
        d[offset + 5] = r;
        d[offset + 6] = g;
        d[offset + 7] = b;
        d[offset + 8] = a;
        d[offset + 9] = size;
      }
      this.count += 1;
      return this;
    },

    /** Upload the staged vertices and draw them. */
    flush(gl2, mode = 'triangles') {
      if (this.count === 0) return 0;
      const floats = this.count * 6 * 10;
      gl2.bindVertexArray(this.vao);
      gl2.bindBuffer(gl2.ARRAY_BUFFER, this.buffer);
      gl2.bufferSubData(gl2.ARRAY_BUFFER, 0, data, 0, floats);
      gl2.drawArrays(gl2.TRIANGLES, 0, this.count * 6);
      gl2.bindVertexArray(null);
      return this.count;
    },

    dispose(gl2) {
      gl2.deleteBuffer(this.buffer);
      gl2.deleteVertexArray(this.vao);
    },
  };
}

/** Resize the drawing buffer to match the CSS size and device pixel ratio. */
export function resizeCanvasToDisplaySize(canvas, dpr = 1) {
  const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  const changed = canvas.width !== width || canvas.height !== height;
  if (changed) {
    canvas.width = width;
    canvas.height = height;
  }
  return { width, height, changed };
}
