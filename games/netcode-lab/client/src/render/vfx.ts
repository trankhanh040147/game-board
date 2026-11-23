import * as THREE from "three";

// Predicted shot cosmetics (B.3): muzzle flash, tracer, impact decal. Purely visual; the server decides hits.
// The tracer endpoint comes from a render-side pick against the drawn map and players, not from the sim's hitscan.

const TRACER_MS = 70;
const DECAL_MAX = 40;
const DECAL_MS = 8000;

export class ShotVfx {
  private ray = new THREE.Raycaster();
  private tracers: { line: THREE.Line; until: number }[] = [];
  private decals: { mesh: THREE.Mesh; born: number }[] = [];
  private decalMat: THREE.Material;
  private tracerMat = new THREE.LineBasicMaterial({ color: 0xfde68a, transparent: true, opacity: 0.85 });

  constructor(private scene: THREE.Scene, private camera: THREE.Camera, decalTex: THREE.Texture | null, private targets: () => THREE.Object3D[]) {
    this.decalMat = decalTex
      ? new THREE.MeshBasicMaterial({ map: decalTex, color: 0x1c1917, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }) // the CC0 sprite is light grey: tint it to read as a scorch
      : new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.8, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 });
  }

  /** Fires the cosmetic shot along the camera's view. Returns the picked point (or null when nothing is hit). */
  fire(now: number, muzzleWorld: THREE.Vector3): THREE.Vector3 | null {
    const origin = new THREE.Vector3();
    const dir = new THREE.Vector3();
    this.camera.getWorldPosition(origin);
    this.camera.getWorldDirection(dir);
    this.ray.set(origin, dir);
    this.ray.far = 200;
    const hits = this.ray.intersectObjects(this.targets(), true);
    const hit = hits[0];
    const end = hit ? hit.point.clone() : origin.clone().addScaledVector(dir, 200);
    const geo = new THREE.BufferGeometry().setFromPoints([muzzleWorld, end]);
    const line = new THREE.Line(geo, this.tracerMat);
    this.scene.add(line);
    this.tracers.push({ line, until: now + TRACER_MS });
    if (hit && hit.face && hit.object.userData.world) this.decal(now, hit.point, hit.face.normal.clone().transformDirection(hit.object.matrixWorld));
    return hit ? hit.point : null;
  }

  private decal(now: number, p: THREE.Vector3, n: THREE.Vector3) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.35, 0.35), this.decalMat);
    m.position.copy(p).addScaledVector(n, 0.005);
    m.lookAt(p.clone().add(n));
    m.rotateZ(Math.random() * Math.PI * 2); // cosmetic variation only
    this.scene.add(m);
    this.decals.push({ mesh: m, born: now });
    while (this.decals.length > DECAL_MAX) this.scene.remove(this.decals.shift()!.mesh);
  }

  update(now: number) {
    this.tracers = this.tracers.filter((t) => { if (now < t.until) return true; this.scene.remove(t.line); t.line.geometry.dispose(); return false; });
    this.decals = this.decals.filter((d) => { if (now - d.born < DECAL_MS) return true; this.scene.remove(d.mesh); return false; });
  }
}
