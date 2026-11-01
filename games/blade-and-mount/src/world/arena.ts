import * as THREE from 'three';
import type { Arena, CircleObstacle, Quality } from '../core/types';
import { clamp, damp } from '../core/utils';
import { ARENA_LAYOUT, clampArenaPosition } from './layout';
import { createArenaTextures, type ArenaTextureBank, type SurfaceTexture } from './textures';
import { GeoBatch, disposeMaterial } from './geo';
import { buildStructures, buildTimberFences } from './structures';
import { createSky } from './sky';
import { createCrowd } from './crowd';
import { createBanners } from './banners';
import { createProps } from './props';

export { ARENA_LAYOUT, clampArenaPosition, isPositionClear, standRowPositions } from './layout';

/**
 * THE OLD LISTS OF ALDERMERE — a Mount & Blade Warband-flavoured tournament
 * ground. Everything is procedural: canvas textures, generated geometry,
 * instanced crowd and cloth, animated shader dust and fabric.
 *
 * The arena owns the scene's sky, fog and lighting, plus:
 *   - play bounds + circular obstacles for movement/camera
 *   - spawn points near the gates and a 4x4 team spawn grid
 *   - crowd excitement / cheer API
 */

function surfaceMaterial(
  tex: SurfaceTexture,
  opts: {
    roughness?: number;
    metalness?: number;
    normalScale?: number;
    side?: THREE.Side;
    color?: number;
  } = {},
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    map: tex.map,
    normalMap: tex.normalMap ?? null,
    roughnessMap: tex.roughnessMap ?? null,
    normalScale: new THREE.Vector2(opts.normalScale ?? 0.75, opts.normalScale ?? 0.75),
    roughness: opts.roughness ?? 0.94,
    metalness: opts.metalness ?? 0,
    vertexColors: true,
    color: opts.color ?? 0xffffff,
    side: opts.side ?? THREE.FrontSide,
  });
}

export function createArena(scene: THREE.Scene, renderer: THREE.WebGLRenderer, quality: Quality): Arena {
  const seed = 20261031;
  const root = new THREE.Group();
  root.name = 'arena';
  scene.add(root);

  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const textures: ArenaTextureBank = createArenaTextures({ quality, seed, anisotropy: maxAniso });

  /* ---------------- Materials ---------------- */
  const stoneMat = surfaceMaterial(textures.stone, { roughness: 0.94, normalScale: 0.55, color: 0xe9d9bd });
  const woodMat = surfaceMaterial(textures.wood, { roughness: 0.89, normalScale: 0.65, color: 0xfff2dc });
  const shingleMat = surfaceMaterial(textures.shingle, { roughness: 0.95, normalScale: 0.6, color: 0xf2e4cc });
  const plasterMat = surfaceMaterial(textures.plaster, { roughness: 0.96, normalScale: 0.35 });
  const metalMat = surfaceMaterial(textures.metal, { roughness: 0.55, metalness: 0.6, normalScale: 0.3 });
  const hayMat = surfaceMaterial(textures.hay, { roughness: 1, normalScale: 0.6 });
  const ownedMaterials = [stoneMat, woodMat, shingleMat, plasterMat, metalMat, hayMat];

  /* ---------------- Sky + lighting ---------------- */
  const sky = createSky(quality, seed);
  root.add(sky.group);

  scene.background = new THREE.Color(0xd8cfbb);
  scene.fog = new THREE.Fog(0xd8cfbb, 120, 360);

  const hemi = new THREE.HemisphereLight(0xb2cfe4, 0x9b8f7c, 0.98);
  const ambient = new THREE.AmbientLight(0xbcc4c8, 0.8);
  root.add(ambient);
  root.add(hemi);

  const sun = new THREE.DirectionalLight(0xffdfb2, 3.1);
  sun.position.copy(sky.sunDirection).multiplyScalar(72);
  sun.target.position.set(0, 0, -3);
  sun.castShadow = true;
  const shadowSize = quality === 'high' ? 2048 : quality === 'medium' ? 1536 : 1024;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  sun.shadow.camera.left = -42;
  sun.shadow.camera.right = 42;
  sun.shadow.camera.top = 42;
  sun.shadow.camera.bottom = -42;
  sun.shadow.camera.near = 8;
  sun.shadow.camera.far = 170;
  sun.shadow.bias = -0.00035;
  sun.shadow.normalBias = 0.045;
  sun.shadow.radius = quality === 'low' ? 1 : 1.6;
  root.add(sun);
  root.add(sun.target);

  const fill = new THREE.DirectionalLight(0xa3bcd0, 0.44);
  fill.position.set(sun.position.x * -0.4, 22, sun.position.z * -0.6);
  root.add(fill);

  /* ---------------- Ground ---------------- */
  const groundGeo = new THREE.PlaneGeometry(72, 63, 1, 1);
  const sandMat = new THREE.MeshStandardMaterial({
    map: textures.sand.map,
    normalMap: textures.sand.normalMap ?? null,
    roughnessMap: textures.sand.roughnessMap ?? null,
    normalScale: new THREE.Vector2(0.6, 0.6),
    roughness: 0.96,
    metalness: 0,
    color: 0xffffff,
  });
  const ground = new THREE.Mesh(groundGeo, sandMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, 0, 0);
  ground.receiveShadow = true;
  ground.name = 'sand-floor';
  root.add(ground);

  const outerTex = textures.outer.map;
  outerTex.repeat.set(9, 9);
  const outerGeo = new THREE.PlaneGeometry(440, 440, 1, 1);
  const outerMat = new THREE.MeshStandardMaterial({ map: outerTex, roughness: 1, metalness: 0, color: 0xdad2b6 });
  const outer = new THREE.Mesh(outerGeo, outerMat);
  outer.rotation.x = -Math.PI / 2;
  outer.position.set(0, -0.06, 0);
  outer.receiveShadow = true;
  outer.name = 'outer-ground';
  root.add(outer);

  /* ---------------- Wall-base ambient occlusion ---------------- */
  const aoMat = new THREE.MeshBasicMaterial({
    map: textures.aoStrip,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const aoH = 1.05;
  const aoPlanes: [number, number, number, number, number, number][] = [
    // x, z, y, width, rotY, ?
    [0, -ARENA_LAYOUT.wallInner.z + 0.04, aoH / 2, ARENA_LAYOUT.wallInner.x * 2, 0, 0],
    [0, ARENA_LAYOUT.wallInner.z - 0.04, aoH / 2, ARENA_LAYOUT.wallInner.x * 2, Math.PI, 0],
    [-ARENA_LAYOUT.wallInner.x + 0.04, 0, aoH / 2, ARENA_LAYOUT.wallInner.z * 2, Math.PI / 2, 0],
    [ARENA_LAYOUT.wallInner.x - 0.04, 0, aoH / 2, ARENA_LAYOUT.wallInner.z * 2, -Math.PI / 2, 0],
  ];
  for (const [x, z, y, width, ry] of aoPlanes) {
    const g = new THREE.PlaneGeometry(width, aoH);
    const mesh = new THREE.Mesh(g, aoMat);
    mesh.position.set(x, y, z);
    mesh.rotation.y = ry;
    mesh.renderOrder = 1;
    root.add(mesh);
  }

  /* ---------------- Static geometry batches ---------------- */
  const batch = new GeoBatch();
  buildStructures(batch, ARENA_LAYOUT, seed);
  buildTimberFences(batch, seed);
  const props = createProps({
    layout: ARENA_LAYOUT,
    textures,
    batch,
    quality,
    seed,
  });
  const banners = createBanners({
    layout: ARENA_LAYOUT,
    textures,
    batch,
    seed,
  });
  const batches = batch.build({
    stone: { material: stoneMat, castShadow: true, receiveShadow: true },
    wood: { material: woodMat, castShadow: true, receiveShadow: true },
    shingle: { material: shingleMat, castShadow: true, receiveShadow: true },
    plaster: { material: plasterMat, castShadow: true, receiveShadow: true },
    metal: { material: metalMat, castShadow: true, receiveShadow: true },
    hay: { material: hayMat, castShadow: true, receiveShadow: true },
  });
  root.add(batches);
  root.add(banners.group);
  root.add(props.group);

  /* ---------------- Crowd ---------------- */
  const crowd = createCrowd(scene, ARENA_LAYOUT, quality, seed);
  root.add(crowd.group);

  let targetExcitement = 0.3;
  let excitement = 0.3;

  // Return private copies so game code can shuffle/mutate spawns without
  // touching the shared layout module (which is also unit-tested).
  const obstacles: CircleObstacle[] = ARENA_LAYOUT.obstacles.map((o) => ({ ...o }));
  const bounds = { ...ARENA_LAYOUT.bounds };
  const spawns = ARENA_LAYOUT.spawns.map((v) => v.clone());
  const teamSpawns = ARENA_LAYOUT.teamSpawns.map((group) =>
    group.map((s) => ({ position: s.position.clone(), yaw: s.yaw })),
  );
  const playerSpawn = {
    position: ARENA_LAYOUT.playerSpawn.position.clone(),
    yaw: ARENA_LAYOUT.playerSpawn.yaw,
  };

  return {
    root,
    bounds,
    obstacles,
    spawns,
    teamSpawns,
    playerSpawn,
    update: (dt: number, time: number) => {
      const step = clamp(dt, 0, 0.1);
      excitement = damp(excitement, targetExcitement, 2.4, Math.max(0.0001, step));
      sky.update(time);
      crowd.update(step, time);
      banners.update(time, excitement);
      props.update(step, time);
    },
    setExcitement: (level01: number) => {
      targetExcitement = clamp(level01, 0, 1);
      crowd.setExcitement(targetExcitement);
    },
    cheer: (strength01?: number) => {
      crowd.cheer(strength01 ?? 1);
      targetExcitement = Math.min(1, targetExcitement + 0.3);
      crowd.setExcitement(targetExcitement);
    },
    clampPosition: (pos: THREE.Vector3, radius: number) => {
      clampArenaPosition(pos, radius, bounds, obstacles);
    },
    dispose: () => {
      scene.remove(root);
      root.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else if (mat) mat.dispose();
      });
      for (const mat of ownedMaterials) disposeMaterial(mat);
      scene.remove(sun);
      scene.remove(sun.target);
      sun.shadow.map?.dispose();
      sky.dispose();
      crowd.dispose();
      banners.dispose();
      props.dispose();
      textures.dispose();
      scene.fog = null;
      scene.background = null;
    },
  };
}
