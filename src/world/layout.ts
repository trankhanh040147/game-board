import * as THREE from 'three';
import type { CircleObstacle } from '../core/types';

/**
 * Pure data describing the arena's shape: play bounds, walls, stands, spawn
 * points, obstacles. No Three.js resources are created here, so this module is
 * safe to unit-test in Node.
 */

export interface ArenaBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface StandDef {
  id: 'west' | 'northWest' | 'northEast';
  /** Axis the stand runs along. */
  axis: 'x' | 'z';
  /** World coordinate the front (arena-facing) row sits on: x for west, z for north. */
  frontSpine: number;
  /** Rows of benches, front to back. */
  rows: number;
  rowDepth: number;
  rowRise: number;
  /** Bench height of the front row. */
  baseY: number;
  /** Extent along `axis` (world z for west, world x for north). */
  min: number;
  max: number;
  /** Facade / railing / roof geometry anchors (same spine axis). */
  fasciaSpine: number;
  railSpine: number;
  backWallSpine: number;
  roofFrontSpine: number;
  roofBackSpine: number;
  roofFrontY: number;
  roofBackY: number;
}

export interface ArenaLayout {
  bounds: ArenaBounds;
  /** Inner faces of the curtain wall. */
  wallInner: { x: number; z: number };
  wallThickness: number;
  wallHeight: number;
  wallOuter: { x: number; z: number };
  gate: { halfWidth: number; halfArch: number; archSpringY: number; archApexY: number; innerZ: number; outerZ: number };
  towerHalfWidth: number;
  stands: StandDef[];
  obstacles: CircleObstacle[];
  spawns: THREE.Vector3[];
  teamSpawns: { position: THREE.Vector3; yaw: number }[][];
  playerSpawn: { position: THREE.Vector3; yaw: number };
}

export const ARENA_LAYOUT: ArenaLayout = (() => {
  const wallInner = { x: 24.2, z: 23.2 };
  const wallThickness = 1.7;
  const wallHeight = 3.9;
  const wallOuter = { x: wallInner.x + wallThickness, z: wallInner.z + wallThickness };

  const west: StandDef = {
    id: 'west',
    axis: 'z',
    frontSpine: -26.95,
    rows: 5,
    rowDepth: 1.12,
    rowRise: 0.5,
    baseY: 4.45,
    min: -19.2,
    max: 19.2,
    fasciaSpine: -26.25,
    railSpine: -26.62,
    backWallSpine: -33.6,
    roofFrontSpine: -26.05,
    roofBackSpine: -34.0,
    roofFrontY: 8.7,
    roofBackY: 9.85,
  };
  const northWest: StandDef = {
    id: 'northWest',
    axis: 'x',
    frontSpine: -26.9,
    rows: 4,
    rowDepth: 1.12,
    rowRise: 0.5,
    baseY: 4.45,
    min: -23.2,
    max: -11.4,
    fasciaSpine: -26.2,
    railSpine: -26.55,
    backWallSpine: -31.6,
    roofFrontSpine: -26.0,
    roofBackSpine: -32.0,
    roofFrontY: 8.35,
    roofBackY: 9.2,
  };
  const northEast: StandDef = {
    ...northWest,
    id: 'northEast',
    min: 11.4,
    max: 23.2,
  };

  const obstacles: CircleObstacle[] = [
    { x: 10.4, z: 0.2, r: 3.5 }, // the big weathered rock
    { x: -14.0, z: 9.0, r: 1.8 },
    { x: -20.2, z: 10.8, r: 1.6 }, // crates
    { x: 20.4, z: -7.6, r: 1.5 }, // barrels
    { x: 7.8, z: 20.2, r: 1.9 }, // hay bales
    { x: -8.1, z: -19.9, r: 1.5 }, // weapon rack
    { x: -17.6, z: -18.6, r: 1.6 }, // fence / cart corner
  ];

  const spawns = [
    new THREE.Vector3(-2.1, 0, -20.4),
    new THREE.Vector3(2.1, 0, -20.4),
    new THREE.Vector3(0, 0, -21.4),
    new THREE.Vector3(-2.1, 0, 20.4),
    new THREE.Vector3(2.1, 0, 20.4),
    new THREE.Vector3(0, 0, 21.4),
    new THREE.Vector3(-20.4, 0, 3.5),
    new THREE.Vector3(20.4, 0, -3.0),
  ];

  const cornerYaw = (cx: number, cz: number): number => Math.atan2(-cx, -cz);
  const cornerGroup = (cx: number, cz: number): { position: THREE.Vector3; yaw: number }[] => {
    const yaw = cornerYaw(cx, cz);
    const offsets: [number, number][] = [
      [0, -1.05],
      [1.15, 0.15],
      [-1.15, 0.15],
      [0.3, 1.35],
    ];
    return offsets.map(([ox, oz]) => ({
      position: new THREE.Vector3(cx + ox, 0, cz + oz),
      yaw,
    }));
  };

  return {
    bounds: { minX: -23.8, maxX: 23.8, minZ: -22.8, maxZ: 22.8 },
    wallInner,
    wallThickness,
    wallHeight,
    wallOuter,
    gate: {
      halfWidth: 7.0,
      halfArch: 2.6,
      archSpringY: 3.0,
      archApexY: 5.6,
      innerZ: -wallInner.z,
      outerZ: -(wallInner.z + 5.4),
    },
    towerHalfWidth: 4.0,
    stands: [west, northWest, northEast],
    obstacles,
    spawns,
    teamSpawns: [cornerGroup(-16.2, -15.2), cornerGroup(16.2, -15.2), cornerGroup(-16.2, 15.2), cornerGroup(16.2, 15.2)],
    playerSpawn: { position: new THREE.Vector3(0, 0, 12), yaw: Math.PI },
  };
})();

/* ------------------------------------------------------------------ */
/* Pure gameplay helpers (unit-tested)                                 */
/* ------------------------------------------------------------------ */

/** Push a position inside the wall bounds and out of circular obstacles. */
export function clampArenaPosition(
  pos: { x: number; z: number },
  radius: number,
  bounds: ArenaBounds = ARENA_LAYOUT.bounds,
  obstacles: CircleObstacle[] = ARENA_LAYOUT.obstacles,
): void {
  pos.x = THREE.MathUtils.clamp(pos.x, bounds.minX + radius, bounds.maxX - radius);
  pos.z = THREE.MathUtils.clamp(pos.z, bounds.minZ + radius, bounds.maxZ - radius);
  for (const o of obstacles) {
    const dx = pos.x - o.x;
    const dz = pos.z - o.z;
    const min = o.r + radius;
    const d = Math.hypot(dx, dz);
    if (d < min) {
      if (d < 1e-5) {
        pos.x = o.x + min;
        pos.z = o.z;
      } else {
        pos.x = o.x + (dx / d) * min;
        pos.z = o.z + (dz / d) * min;
      }
    }
  }
}

/** True when a point is clear of every obstacle and inside the walls. */
export function isPositionClear(
  x: number,
  z: number,
  radius = 0.45,
  bounds: ArenaBounds = ARENA_LAYOUT.bounds,
  obstacles: CircleObstacle[] = ARENA_LAYOUT.obstacles,
): boolean {
  if (x < bounds.minX + radius || x > bounds.maxX - radius) return false;
  if (z < bounds.minZ + radius || z > bounds.maxZ - radius) return false;
  for (const o of obstacles) {
    if (Math.hypot(x - o.x, z - o.z) < o.r + radius) return false;
  }
  return true;
}

/** Crowd stand rows as (spine, height) pairs, used by both geometry and crowd. */
export function standRowPositions(stand: StandDef): { spine: number; y: number; row: number }[] {
  const rows: { spine: number; y: number; row: number }[] = [];
  for (let r = 0; r < stand.rows; r++) {
    rows.push({ spine: stand.frontSpine - r * stand.rowDepth, y: stand.baseY + r * stand.rowRise, row: r });
  }
  return rows;
}
