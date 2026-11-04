/**
 * Scene renderer.
 *
 * One forward-rendering pass with four programs (see `shaders.js`). There are no
 * textures: every surface is vertex coloured, which keeps the asset pipeline at
 * zero and the draw call count tiny (the whole city is a handful of merged meshes).
 *
 * Scene contract is documented in `docs/CONTRACT.md`; the short version:
 *
 *   renderer.renderFrame({
 *     camera: {position, target, fov, near, far},
 *     sun, ambient, fog, sky, clear, time,
 *     objects: [{mesh, matrix?, tint?, emissiveScale?}],
 *     glows: [{x,y,z,size,color,intensity}],
 *     blobs: [{x,y,z,rx,rz,color?,opacity}],
 *     glowIntensity, blobOpacity,
 *   })
 */

import { identity4, invert4, multiply4, lookAt, perspective, normalMatrix3 } from '../core/math.js';
import { QUALITY } from '../sim/config.js';
import { createGLContext, createMeshVAO, createProgram, createSpriteBatch } from './gl.js';
import {
  BLOB_FRAGMENT,
  BLOB_VERTEX,
  GLOW_FRAGMENT,
  GLOW_VERTEX,
  MESH_FRAGMENT,
  MESH_VERTEX,
  SKY_FRAGMENT,
  SKY_VERTEX,
} from './shaders.js';

const FULLSCREEN_QUAD = new Float32Array([
  -1, -1, 1, -1, 1, 1,
  -1, -1, 1, 1, -1, 1,
]);

const IDENTITY = identity4();
const IDENTITY_NORMAL = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{dpr?:number, quality?:'low'|'medium'|'high', onContextLost?:Function}} [options]
 */
export function createRenderer(canvas, options = {}) {
  const { gl, error } = createGLContext(canvas, options);
  if (!gl) {
    return {
      ok: false,
      error,
      gl: null,
      resize() {},
      uploadMesh() {
        return null;
      },
      renderFrame() {},
      setQuality() {},
      dispose() {},
      stats: { drawCalls: 0, triangles: 0, glows: 0, blobs: 0 },
      quality: 'low',
    };
  }

  let qualityLevel = options.quality ?? 'medium';
  let qualitySettings = QUALITY[qualityLevel] ?? QUALITY.medium;
  let dpr = Math.min(options.dpr ?? (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1), 2);
  let contextLost = false;

  const meshProgram = createProgram(gl, MESH_VERTEX, MESH_FRAGMENT, 'mesh');
  const skyProgram = createProgram(gl, SKY_VERTEX, SKY_FRAGMENT, 'sky');
  const glowProgram = createProgram(gl, GLOW_VERTEX, GLOW_FRAGMENT, 'glow');
  const blobProgram = createProgram(gl, BLOB_VERTEX, BLOB_FRAGMENT, 'blob');

  const skyVAO = gl.createVertexArray();
  const skyBuffer = gl.createBuffer();
  gl.bindVertexArray(skyVAO);
  gl.bindBuffer(gl.ARRAY_BUFFER, skyBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, FULLSCREEN_QUAD, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  const glowBatch = createSpriteBatch(gl, 700);
  const blobBatch = createSpriteBatch(gl, 400);
  const meshCache = new WeakMap();

  const invViewProjection = new Float32Array(16);
  const projection = new Float32Array(16);
  const view = new Float32Array(16);
  const viewProjection = new Float32Array(16);
  const cameraPos = [0, 0, 0];
  const cameraRight = [1, 0, 0];
  const cameraUp = [0, 1, 0];

  const stats = { drawCalls: 0, triangles: 0, glows: 0, blobs: 0 };

  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    contextLost = true;
    if (options.onContextLost) options.onContextLost();
  });

  function uploadMesh(mesh) {
    if (!mesh || !mesh.vertexCount) return null;
    const cached = meshCache.get(mesh);
    if (cached) return cached;
    const uploaded = createMeshVAO(gl, mesh);
    meshCache.set(mesh, uploaded);
    return uploaded;
  }

  function resize() {
    const width = Math.max(1, Math.round((canvas.clientWidth || 960) * dpr));
    const height = Math.max(1, Math.round((canvas.clientHeight || 540) * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    return { width: canvas.width, height: canvas.height };
  }

  function setQuality(level) {
    if (!QUALITY[level]) return;
    qualityLevel = level;
    qualitySettings = QUALITY[level];
    dpr = Math.min(
      options.dpr ?? (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1),
      qualitySettings.dpr,
    );
    resize();
  }

  function computeCameraMatrices(scene) {
    const camera = scene.camera;
    lookAt(camera.position, camera.target, [0, 1, 0], view);
    const aspect = canvas.width / Math.max(1, canvas.height);
    perspective(camera.fov ?? 0.95, aspect, camera.near ?? 0.3, camera.far ?? 1600, projection);
    multiply4(viewProjection, projection, view);
    cameraPos[0] = camera.position[0];
    cameraPos[1] = camera.position[1];
    cameraPos[2] = camera.position[2];
    // Camera basis for billboards: right = normalize(cross(up, forward)).
    const fx = camera.target[0] - camera.position[0];
    const fy = camera.target[1] - camera.position[1];
    const fz = camera.target[2] - camera.position[2];
    const flen = Math.hypot(fx, fy, fz) || 1;
    const forwardX = fx / flen;
    const forwardY = fy / flen;
    const forwardZ = fz / flen;
    let rightX = forwardZ;
    let rightZ = -forwardX;
    const rightLen = Math.hypot(rightX, rightZ) || 1;
    rightX /= rightLen;
    rightZ /= rightLen;
    cameraRight[0] = rightX;
    cameraRight[1] = 0;
    cameraRight[2] = rightZ;
    cameraUp[0] = cameraRight[1] * forwardZ - cameraRight[2] * forwardY;
    cameraUp[1] = cameraRight[2] * forwardX - cameraRight[0] * forwardZ;
    cameraUp[2] = cameraRight[0] * forwardY - cameraRight[1] * forwardX;
    const upLen = Math.hypot(cameraUp[0], cameraUp[1], cameraUp[2]) || 1;
    cameraUp[0] /= upLen;
    cameraUp[1] /= upLen;
    cameraUp[2] /= upLen;
    return aspect;
  }

  function drawSky(scene) {
    if (!scene.sky) return;
    const sky = scene.sky;
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    invert4(invViewProjection, viewProjection);
    gl.useProgram(skyProgram.program);
    const u = skyProgram.uniforms;
    gl.uniformMatrix4fv(u.uInvViewProj, false, invViewProjection);
    gl.uniform3fv(u.uCameraPos, cameraPos);
    gl.uniform3fv(u.uTop, sky.top ?? [0.02, 0.03, 0.08]);
    gl.uniform3fv(u.uHorizon, sky.horizon ?? [0.1, 0.08, 0.16]);
    gl.uniform3fv(u.uBottom, sky.bottom ?? [0.01, 0.01, 0.02]);
    gl.uniform3fv(u.uSunDir, scene.sun?.direction ?? [0, 1, 0]);
    gl.uniform3fv(u.uSunColor, scene.sun?.color ?? [1, 1, 1]);
    gl.uniform1f(u.uSunGlow, sky.sunGlow ?? 0.4);
    gl.uniform1f(u.uSunSize, sky.sunSize ?? 0.01);
    gl.uniform1f(u.uStars, sky.stars ?? 0);
    gl.uniform1f(u.uTime, scene.time ?? 0);
    gl.bindVertexArray(skyVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
  }

  function drawObjects(scene) {
    if (!scene.objects || scene.objects.length === 0) return;
    gl.useProgram(meshProgram.program);
    const u = meshProgram.uniforms;
    const sun = scene.sun ?? { direction: [0, 1, 0], color: [1, 1, 1] };
    const ambient = scene.ambient ?? { sky: [0.3, 0.3, 0.35], ground: [0.1, 0.1, 0.1], intensity: 1 };
    const fog = scene.fog ?? { color: [0, 0, 0], near: 100, far: 800 };
    const far = Math.min(fog.far ?? 800, qualitySettings.drawDistance ?? 800);

    gl.uniformMatrix4fv(u.uViewProj, false, viewProjection);
    gl.uniform3fv(u.uSunDir, sun.direction);
    gl.uniform3fv(u.uSunColor, sun.color);
    gl.uniform3fv(u.uAmbientSky, ambient.sky);
    gl.uniform3fv(u.uAmbientGround, ambient.ground);
    gl.uniform1f(u.uAmbientIntensity, ambient.intensity ?? 1);
    gl.uniform3fv(u.uFogColor, fog.color);
    gl.uniform1f(u.uFogNear, Math.min(fog.near ?? 100, far * 0.5));
    gl.uniform1f(u.uFogFar, far);
    gl.uniform3fv(u.uCameraPos, cameraPos);

    const tint = [1, 1, 1];
    for (const object of scene.objects) {
      const uploaded = object.uploaded ?? uploadMesh(object.mesh);
      if (!uploaded) continue;
      const matrix = object.matrix ?? IDENTITY;
      gl.uniformMatrix4fv(u.uModel, false, matrix);
      if (object.matrix) {
        gl.uniformMatrix3fv(u.uNormalMat, false, normalMatrix3(matrix));
      } else {
        gl.uniformMatrix3fv(u.uNormalMat, false, IDENTITY_NORMAL);
      }
      if (object.tint) {
        tint[0] = object.tint[0];
        tint[1] = object.tint[1];
        tint[2] = object.tint[2];
        gl.uniform3fv(u.uTint, tint);
      } else {
        gl.uniform3f(u.uTint, 1, 1, 1);
      }
      gl.uniform1f(u.uEmissiveScale, object.emissiveScale ?? 1);
      gl.bindVertexArray(uploaded.vao);
      gl.drawElements(gl.TRIANGLES, uploaded.indexCount, gl.UNSIGNED_INT, 0);
      stats.drawCalls += 1;
      stats.triangles += uploaded.indexCount / 3;
    }
    gl.bindVertexArray(null);
  }

  function drawBlobs(scene) {
    if (!scene.blobs || scene.blobs.length === 0 || !qualitySettings.shadows) return;
    const batch = blobBatch.begin();
    for (const blob of scene.blobs) {
      const color = blob.color ?? [0.01, 0.012, 0.02];
      batch.push(blob.x, blob.y, blob.z, color[0], color[1], color[2], blob.rx ?? 1.6, blob.rz ?? 3.2);
    }
    if (batch.count === 0) return;
    gl.useProgram(blobProgram.program);
    const u = blobProgram.uniforms;
    gl.uniformMatrix4fv(u.uViewProj, false, viewProjection);
    gl.uniform1f(u.uOpacity, (scene.blobOpacity ?? 1) * 0.95);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);
    batch.flush(gl);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    stats.blobs += batch.count;
  }

  function drawGlows(scene) {
    if (!scene.glows || scene.glows.length === 0) return;
    if (qualitySettings.glows <= 0) return;
    const batch = glowBatch.begin();
    for (const glow of scene.glows) {
      const color = glow.color ?? [1, 1, 1];
      batch.push(
        glow.x, glow.y, glow.z,
        color[0], color[1], color[2],
        (glow.intensity ?? 1) * qualitySettings.glows,
        glow.size ?? 1,
      );
    }
    if (batch.count === 0) return;
    gl.useProgram(glowProgram.program);
    const u = glowProgram.uniforms;
    gl.uniformMatrix4fv(u.uViewProj, false, viewProjection);
    gl.uniform3fv(u.uCamRight, cameraRight);
    gl.uniform3fv(u.uCamUp, cameraUp);
    gl.uniform1f(u.uIntensity, scene.glowIntensity ?? 1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.disable(gl.CULL_FACE);
    gl.depthMask(false);
    batch.flush(gl);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    stats.glows += batch.count;
  }

  function renderFrame(scene) {
    if (contextLost) return;
    stats.drawCalls = 0;
    stats.triangles = 0;
    stats.glows = 0;
    stats.blobs = 0;

    computeCameraMatrices(scene);

    const clear = scene.clear ?? [0.02, 0.02, 0.04];
    gl.clearColor(clear[0], clear[1], clear[2], 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    drawSky(scene);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    drawObjects(scene);
    drawBlobs(scene);
    drawGlows(scene);
  }

  return {
    ok: true,
    error: null,
    gl,
    programs: { meshProgram, skyProgram, glowProgram, blobProgram },
    stats,
    resize,
    uploadMesh,
    renderFrame,
    setQuality,
    get quality() {
      return qualityLevel;
    },
    get dpr() {
      return dpr;
    },
    get contextLost() {
      return contextLost;
    },
    dispose() {
      glowBatch.dispose(gl);
      blobBatch.dispose(gl);
      gl.deleteBuffer(skyBuffer);
      gl.deleteVertexArray(skyVAO);
    },
  };
}

export { QUALITY };
