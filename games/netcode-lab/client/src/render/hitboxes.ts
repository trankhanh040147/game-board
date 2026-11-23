import * as THREE from "three";
import type { Vec3 } from "../game/events";

// P09 overlay (A.10, Valve's picture): the hitbox where the shooter saw the target (red) and the hitbox the server
// rewound to (blue). Both are drawn from real data: red from this client's drawn positions at fire time, blue from
// the server's shot event.

export interface HitboxDims { body: { half: number; top: number }; head: { half: number; bottom: number; top: number } }
const SHOW_MS = 2500;

export class HitboxOverlay {
  private items: { obj: THREE.Group; until: number }[] = [];
  constructor(private scene: THREE.Scene, private dims: HitboxDims) {}

  private box(p: Vec3, color: number): THREE.Group {
    const g = new THREE.Group();
    const mat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
    const mk = (half: number, y0: number, y1: number) => {
      const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(half * 2, y1 - y0, half * 2));
      const l = new THREE.LineSegments(geo, mat);
      l.position.set(0, (y0 + y1) / 2, 0);
      l.renderOrder = 30;
      return l;
    };
    g.add(mk(this.dims.body.half, 0, this.dims.head.bottom), mk(this.dims.head.half, this.dims.head.bottom, this.dims.head.top));
    g.position.set(p.x, p.y, p.z);
    return g;
  }

  show(now: number, clientSeen: Vec3 | null, serverRewound: Vec3 | null) {
    for (const [p, c] of [[clientSeen, 0xef4444], [serverRewound, 0x3b82f6]] as const) {
      if (!p) continue;
      const g = this.box(p, c);
      this.scene.add(g);
      this.items.push({ obj: g, until: now + SHOW_MS });
    }
  }

  update(now: number) {
    this.items = this.items.filter((i) => { if (now < i.until) return true; this.scene.remove(i.obj); return false; });
  }
}
