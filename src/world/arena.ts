import * as THREE from 'three';
import type { Arena, CircleObstacle, Quality } from '../core/types';

/**
 * TEMPORARY arena stub — arena-artist replaces this file (and the rest of src/world/).
 * Provides a flat sand yard, simple walls, lights and spawn points so the game loop is testable.
 */
export function createArena(scene: THREE.Scene, _renderer: THREE.WebGLRenderer, quality: Quality): Arena {
  const root = new THREE.Group();
  root.name = 'arena';
  scene.add(root);

  const hemi = new THREE.HemisphereLight(0xdfe8f0, 0x6b5b45, 1.35);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff0d8, 2.4);
  sun.position.set(-18, 26, 12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(quality === 'low' ? 1024 : 2048, quality === 'low' ? 1024 : 2048);
  sun.shadow.camera.left = -32;
  sun.shadow.camera.right = 32;
  sun.shadow.camera.top = 32;
  sun.shadow.camera.bottom = -32;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 80;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);
  scene.add(sun.target);

  const sand = new THREE.Mesh(
    new THREE.PlaneGeometry(64, 52),
    new THREE.MeshStandardMaterial({ color: 0xc9b388, roughness: 0.96, metalness: 0 }),
  );
  sand.rotation.x = -Math.PI / 2;
  sand.receiveShadow = true;
  root.add(sand);

  const wallMat = new THREE.MeshStandardMaterial({ color: 0x9a937f, roughness: 0.9 });
  const wallH = 4.2;
  const walls: [number, number, number, number][] = [
    [0, -24, 52, 1.6], [0, 24, 52, 1.6], [-25, 0, 1.6, 48], [25, 0, 1.6, 48],
  ];
  for (const [x, z, w, d] of walls) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, wallH, d), wallMat);
    wall.position.set(x, wallH / 2, z);
    wall.castShadow = true;
    wall.receiveShadow = true;
    root.add(wall);
  }

  const rock = new THREE.Mesh(
    new THREE.DodecahedronGeometry(3.4, 1),
    new THREE.MeshStandardMaterial({ color: 0x8a8172, roughness: 1 }),
  );
  rock.position.set(8, 1.6, 0);
  rock.scale.set(1.3, 0.8, 1);
  rock.castShadow = true;
  rock.receiveShadow = true;
  root.add(rock);

  const obstacles: CircleObstacle[] = [{ x: 8, z: 0, r: 3.6 }];
  const spawns: THREE.Vector3[] = [
    new THREE.Vector3(-12, 0, -14), new THREE.Vector3(12, 0, -14),
    new THREE.Vector3(-12, 0, 14), new THREE.Vector3(12, 0, 14),
    new THREE.Vector3(0, 0, -16), new THREE.Vector3(0, 0, 16),
  ];
  const teamSpawns = [
    [
      { position: new THREE.Vector3(-16, 0, -14), yaw: Math.PI * 0.75 },
      { position: new THREE.Vector3(-18, 0, -10), yaw: Math.PI * 0.75 },
      { position: new THREE.Vector3(-14, 0, -8), yaw: Math.PI * 0.75 },
      { position: new THREE.Vector3(-19, 0, -5), yaw: Math.PI * 0.75 },
    ],
    [
      { position: new THREE.Vector3(16, 0, -14), yaw: -Math.PI * 0.75 },
      { position: new THREE.Vector3(18, 0, -10), yaw: -Math.PI * 0.75 },
      { position: new THREE.Vector3(14, 0, -8), yaw: -Math.PI * 0.75 },
      { position: new THREE.Vector3(19, 0, -5), yaw: -Math.PI * 0.75 },
    ],
    [
      { position: new THREE.Vector3(-16, 0, 14), yaw: Math.PI * 0.25 },
      { position: new THREE.Vector3(-18, 0, 10), yaw: Math.PI * 0.25 },
      { position: new THREE.Vector3(-14, 0, 8), yaw: Math.PI * 0.25 },
      { position: new THREE.Vector3(-19, 0, 5), yaw: Math.PI * 0.25 },
    ],
    [
      { position: new THREE.Vector3(16, 0, 14), yaw: -Math.PI * 0.25 },
      { position: new THREE.Vector3(18, 0, 10), yaw: -Math.PI * 0.25 },
      { position: new THREE.Vector3(14, 0, 8), yaw: -Math.PI * 0.25 },
      { position: new THREE.Vector3(19, 0, 5), yaw: -Math.PI * 0.25 },
    ],
  ];

  return {
    root,
    bounds: { minX: -23.5, maxX: 23.5, minZ: -22.5, maxZ: 22.5 },
    obstacles,
    spawns,
    teamSpawns,
    playerSpawn: { position: new THREE.Vector3(0, 0, 12), yaw: Math.PI },
    update: () => undefined,
    setExcitement: () => undefined,
    cheer: () => undefined,
    clampPosition: (pos, radius) => {
      pos.x = THREE.MathUtils.clamp(pos.x, -23.5 + radius, 23.5 - radius);
      pos.z = THREE.MathUtils.clamp(pos.z, -22.5 + radius, 22.5 - radius);
      for (const o of obstacles) {
        const dx = pos.x - o.x;
        const dz = pos.z - o.z;
        const min = o.r + radius;
        const d = Math.hypot(dx, dz);
        if (d < min && d > 1e-5) {
          pos.x = o.x + (dx / d) * min;
          pos.z = o.z + (dz / d) * min;
        }
      }
    },
    dispose: () => {
      scene.remove(root);
      root.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          const mat = obj.material;
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
          else mat.dispose();
        }
      });
    },
  };
}
