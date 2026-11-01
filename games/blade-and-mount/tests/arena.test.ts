import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  ARENA_LAYOUT,
  clampArenaPosition,
  isPositionClear,
  standRowPositions,
} from '../src/world/layout';
import { createCrowd } from '../src/world/crowd';
import { BANNER_ANCHOR_DATA, PENNANT_POLE_DATA } from '../src/world/banners';

const bounds = ARENA_LAYOUT.bounds;
const obstacles = ARENA_LAYOUT.obstacles;

describe('arena layout', () => {
  it('has sane playable bounds', () => {
    expect(bounds.minX).toBeLessThan(bounds.maxX);
    expect(bounds.minZ).toBeLessThan(bounds.maxZ);
    // Roughly the design spec: x ∈ ±24, z ∈ ±23.
    expect(bounds.maxX).toBeGreaterThan(20);
    expect(bounds.maxZ).toBeGreaterThan(18);
  });

  it('keeps the player spawn inside the walls and clear of obstacles', () => {
    const { position, yaw } = ARENA_LAYOUT.playerSpawn;
    expect(Number.isFinite(yaw)).toBe(true);
    expect(position.x).toBeGreaterThanOrEqual(bounds.minX);
    expect(position.x).toBeLessThanOrEqual(bounds.maxX);
    expect(position.z).toBeGreaterThanOrEqual(bounds.minZ);
    expect(position.z).toBeLessThanOrEqual(bounds.maxZ);
    expect(isPositionClear(position.x, position.z, 0.45)).toBe(true);
  });

  it('provides safe generic melee spawns near the gates', () => {
    expect(ARENA_LAYOUT.spawns.length).toBeGreaterThanOrEqual(6);
    for (const spawn of ARENA_LAYOUT.spawns) {
      expect(spawn.y).toBe(0);
      expect(isPositionClear(spawn.x, spawn.z, 0.45)).toBe(true);
    }
  });

  it('provides four teams of four clear, sensible corner spawns', () => {
    const teams = ARENA_LAYOUT.teamSpawns;
    expect(teams).toHaveLength(4);
    const corners = new Set<string>();
    for (const group of teams) {
      expect(group).toHaveLength(4);
      for (const spawn of group) {
        expect(Number.isFinite(spawn.yaw)).toBe(true);
        expect(isPositionClear(spawn.position.x, spawn.position.z, 0.45)).toBe(true);
        // Grouped near a corner, not in the middle of the lists.
        expect(Math.abs(spawn.position.x)).toBeGreaterThan(10);
        expect(Math.abs(spawn.position.z)).toBeGreaterThan(10);
        corners.add(`${Math.sign(spawn.position.x)},${Math.sign(spawn.position.z)}`);
      }
    }
    expect(corners.size).toBe(4);
  });

  it('never places a spawn inside an obstacle', () => {
    const allPoints = [
      ...ARENA_LAYOUT.spawns,
      ...ARENA_LAYOUT.teamSpawns.flat().map((s) => s.position),
      ARENA_LAYOUT.playerSpawn.position,
    ];
    for (const p of allPoints) {
      for (const o of obstacles) {
        expect(Math.hypot(p.x - o.x, p.z - o.z)).toBeGreaterThan(o.r + 0.35);
      }
    }
  });

  it('keeps the centre of the lists free for fighting', () => {
    for (const o of obstacles) {
      const dist = Math.hypot(o.x, o.z);
      // Only allow the iconic boulder to sit near the middle, and only off-centre.
      expect(dist > 7 || (Math.abs(o.x) > 7 && Math.abs(o.z) < 6)).toBe(true);
    }
  });
});

describe('clampArenaPosition', () => {
  it('keeps a position inside the walls for its radius', () => {
    const pos = { x: 999, z: -999 };
    clampArenaPosition(pos, 0.4);
    expect(pos.x).toBeLessThanOrEqual(bounds.maxX - 0.4 + 1e-6);
    expect(pos.z).toBeGreaterThanOrEqual(bounds.minZ + 0.4 - 1e-6);
  });

  it('pushes positions out of circular obstacles', () => {
    for (const o of obstacles) {
      const pos = { x: o.x + 0.05, z: o.z + 0.05 };
      clampArenaPosition(pos, 0.4);
      expect(Math.hypot(pos.x - o.x, pos.z - o.z)).toBeGreaterThanOrEqual(o.r + 0.4 - 1e-3);
    }
  });

  it('leaves a clear position untouched', () => {
    const pos = { x: 0, z: 0 };
    clampArenaPosition(pos, 0.4);
    expect(Math.hypot(pos.x - 0, pos.z - 0)).toBeLessThan(1e-6);
  });

  it('is stable when called repeatedly (no jitter/NaN)', () => {
    const pos = { x: -23.9, z: 22.9 };
    clampArenaPosition(pos, 0.4);
    const once = { ...pos };
    clampArenaPosition(pos, 0.4);
    expect(pos.x).toBeCloseTo(once.x, 6);
    expect(pos.z).toBeCloseTo(once.z, 6);
    expect(Number.isNaN(pos.x)).toBe(false);
    expect(Number.isNaN(pos.z)).toBe(false);
  });
});

describe('stand rows', () => {
  it('lays out every crowd row with rising height and receding depth', () => {
    for (const stand of ARENA_LAYOUT.stands) {
      const rows = standRowPositions(stand);
      expect(rows).toHaveLength(stand.rows);
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i].y).toBeGreaterThan(rows[i - 1].y);
        expect(rows[i].spine).toBeLessThan(rows[i - 1].spine);
      }
      // Benches sit above the curtain wall so the crowd is visible.
      expect(rows[0].y).toBeGreaterThan(ARENA_LAYOUT.wallHeight);
    }
  });
});

describe('crowd', () => {
  it('builds 150–220 instanced spectators at high quality', () => {
    const crowd = createCrowd(null as unknown as THREE.Scene, ARENA_LAYOUT, 'high', 20261031);
    expect(crowd.count).toBeGreaterThanOrEqual(150);
    expect(crowd.count).toBeLessThanOrEqual(220);
    expect(crowd.group.children.length).toBeGreaterThan(0);
    crowd.dispose();
  });

  it('scales the crowd down on lower quality presets', () => {
    const low = createCrowd(null as unknown as THREE.Scene, ARENA_LAYOUT, 'low', 7);
    expect(low.count).toBeGreaterThan(60);
    expect(low.count).toBeLessThan(150);
    low.dispose();
  });

  it('reacts to excitement and cheer without throwing', () => {
    const crowd = createCrowd(null as unknown as THREE.Scene, ARENA_LAYOUT, 'medium', 11);
    expect(() => {
      crowd.setExcitement(0.9);
      crowd.update(0.016, 1.2);
      crowd.cheer(1);
      crowd.update(0.016, 1.3);
      crowd.cheer(0);
      crowd.update(0.016, 2.9);
    }).not.toThrow();
    crowd.dispose();
  });
});

/* ------------------------------------------------------------------ */
/* Camera / spawn clearance                                            */
/* ------------------------------------------------------------------ */

/** Intro fly-through: (0,10.5,-20) → just behind the player. */
function introCameraPath(): THREE.Vector3[] {
  const spawn = ARENA_LAYOUT.playerSpawn;
  const yaw = spawn.yaw;
  const behind = new THREE.Vector3(
    spawn.position.x - Math.sin(yaw) * 3.15,
    spawn.position.y + 1.7,
    spawn.position.z - Math.cos(yaw) * 3.15,
  );
  const start = new THREE.Vector3(0, 10.5, -20);
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= 80; i++) {
    const t = i / 80;
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const p = start.clone().lerp(behind, e);
    p.y += Math.sin(e * Math.PI) * 1.2;
    points.push(p);
  }
  return points;
}

function pointSegmentDistance(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const ab = b.clone().sub(a);
  const ap = p.clone().sub(a);
  const denom = ab.lengthSq() || 1e-6;
  const t = THREE.MathUtils.clamp(ap.dot(ab) / denom, 0, 1);
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

describe('intro camera clearance', () => {
  const path = introCameraPath();

  it('starts and ends where the game expects', () => {
    expect(path[0].distanceTo(new THREE.Vector3(0, 10.5, -20))).toBeLessThan(1e-6);
    const end = path[path.length - 1];
    expect(end.x).toBeCloseTo(0, 3);
    expect(end.y).toBeCloseTo(1.7, 3);
    expect(end.z).toBeGreaterThan(ARENA_LAYOUT.playerSpawn.position.z);
  });

  it('never flies through a ground obstacle', () => {
    for (const o of obstacles) {
      const center = new THREE.Vector3(o.x, 0, o.z);
      const min = Math.min(...path.map((p) => p.distanceTo(center)));
      // Camera can pass above low props; obstacles are all below ~2.5 m.
      expect(min).toBeGreaterThan(Math.min(o.r + 0.4, 3.2));
    }
  });

  it('never clips the gatehouse mass or stand roofs', () => {
    // Gatehouse AABB (stone + storey + roof overhang).
    const minGate = new THREE.Vector3(-8.2, 5.9, -29.4);
    const maxGate = new THREE.Vector3(8.2, 11.5, -22.1);
    for (const p of path) {
      const insideX = p.x > minGate.x && p.x < maxGate.x;
      const insideZ = p.z > minGate.z && p.z < maxGate.z;
      const insideY = p.y > minGate.y && p.y < maxGate.y;
      expect(insideX && insideZ && insideY).toBe(false);
    }
  });

  it('keeps clear of every banner pole and cloth anchor', () => {
    for (const pole of PENNANT_POLE_DATA) {
      const base = new THREE.Vector3(pole.x, pole.y, pole.z);
      const top = new THREE.Vector3(pole.x, pole.y + pole.height, pole.z);
      for (const p of path) {
        expect(pointSegmentDistance(p, base, top)).toBeGreaterThan(0.9);
      }
    }
    for (const anchor of BANNER_ANCHOR_DATA) {
      const cloth = new THREE.Vector3(anchor.x, anchor.y - anchor.height * 0.5, anchor.z);
      for (const p of path) {
        expect(p.distanceTo(cloth)).toBeGreaterThan(1.0);
      }
    }
  });
});

describe('round spawn wedges vs scenery', () => {
  it('keeps props out of every team’s inward spawn wedge', () => {
    for (const group of ARENA_LAYOUT.teamSpawns) {
      const c = new THREE.Vector3();
      for (const s of group) c.add(s.position);
      c.multiplyScalar(1 / group.length);
      c.y = 0;
      const center = new THREE.Vector3(0, 0, 0);
      for (const o of obstacles) {
        const p = new THREE.Vector3(o.x, 0, o.z);
        const d = pointSegmentDistance(p, c, center);
        expect(d).toBeGreaterThan(o.r + 0.7);
      }
    }
  });

  it('keeps banner poles high above the fighting floor', () => {
    for (const pole of PENNANT_POLE_DATA) {
      expect(pole.y).toBeGreaterThan(ARENA_LAYOUT.wallHeight * 0.9);
    }
  });
});
