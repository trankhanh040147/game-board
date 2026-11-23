import * as THREE from "three";
import type { CourtyardMap } from "./map";
import { worldUVs, type Assets } from "./assets";

export const TEAM_COLOR = { blue: 0x2563eb, orange: 0xea580c } as const;
export type Team = keyof typeof TEAM_COLOR;

// Player hitbox sizes come from core's sim constants once the WASM API is published.
export interface PlayerDims { width: number; height: number; headSize: number; headBottom: number; eyeHeight: number }

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(80, 1, 0.05, 500);
  private players = new Map<number, PlayerView>();
  private ghosts = new Map<number, THREE.Group>();
  readonly mapMeshes: THREE.Mesh[] = [];
  readonly rifle: Rifle;

  constructor(canvas: HTMLCanvasElement, map: CourtyardMap, private assets: Assets | null = null) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene.background = assets?.sky ?? new THREE.Color(0x9cc3e6);
    this.scene.fog = new THREE.Fog(0x9cc3e6, 40, 110);
    this.scene.add(new THREE.HemisphereLight(0xdbeafe, 0x57534e, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(12, 30, 8);
    this.scene.add(sun);
    this.buildMap(map);
    this.scene.add(this.camera);
    this.rifle = new Rifle(this.camera, assets?.rifle?.scene ?? null, assets?.vfx.muzzle_flash ?? null);
    this.resize();
    addEventListener("resize", () => this.resize());
  }

  private buildMap(map: CourtyardMap) {
    const t = this.assets?.textures ?? {};
    const mat = (tex: THREE.Texture | undefined, fallback: number, tint = 0xffffff) =>
      tex ? new THREE.MeshLambertMaterial({ map: tex, color: tint }) : new THREE.MeshLambertMaterial({ color: fallback });
    const mats: Record<string, THREE.Material> = {
      floor: mat(t.ground, 0x8b8578),
      wall: mat(t.wall, 0xc8bfae),
      block: mat(t.wall, 0xa8a29e, 0xd6d3d1),
      low: mat(t.cover, 0x78716c),
      crate: mat(t.wall, 0x92400e, 0xd97706),
    };
    for (const b of map.boxes) {
      const size = b.max.map((v, i) => v - b.min[i]) as [number, number, number];
      const kind = b.id === "floor" ? "floor" : b.id.startsWith("wall") ? "wall"
        : b.id.startsWith("low") ? "low" : b.id.startsWith("crate") ? "crate" : "block";
      const geo = new THREE.BoxGeometry(...size);
      worldUVs(geo, size, kind === "floor" ? 4 : 2);
      const mesh = new THREE.Mesh(geo, mats[kind]);
      mesh.position.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
      mesh.name = b.id;
      mesh.userData.world = true; // impact decals stick to map geometry only
      this.mapMeshes.push(mesh);
      this.scene.add(mesh);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color: 0x292524, transparent: true, opacity: 0.35 }));
      edges.position.copy(mesh.position);
      this.scene.add(edges);
    }
    // Spawn pads in team colours, so each end of the Courtyard reads at a glance.
    for (const team of ["blue", "orange"] as const) {
      for (const s of map.spawns[team]) {
        const pad = new THREE.Mesh(new THREE.CircleGeometry(0.6, 24), new THREE.MeshBasicMaterial({ color: TEAM_COLOR[team], transparent: true, opacity: 0.5 }));
        pad.rotation.x = -Math.PI / 2;
        pad.position.set(s[0], s[1] + 0.01, s[2]);
        this.scene.add(pad);
      }
    }
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Camera at the eye, looking along yaw/pitch (yaw 0 faces -Z, matching the sim). */
  setView(x: number, y: number, z: number, yaw: number, pitch: number) {
    this.camera.position.set(x, y, z);
    this.camera.rotation.set(pitch, yaw, 0, "YXZ");
  }

  /** Draws or moves another player. Feet position, sizes from the sim. */
  upsertPlayer(id: number, team: Team, x: number, y: number, z: number, yaw: number, dims: PlayerDims, alive = true, moving = false) {
    let p = this.players.get(id);
    if (!p || p.team !== team) {
      if (p) this.scene.remove(p.root);
      p = this.assets?.character ? modelPlayer(this.assets.character, team, dims) : { root: playerMesh(TEAM_COLOR[team], dims, false), team, mixer: null, idle: null, walk: null };
      this.players.set(id, p);
      this.scene.add(p.root);
    }
    p.root.visible = alive;
    p.root.position.set(x, y, z);
    p.root.rotation.y = yaw;
    if (p.walk && p.idle) {
      const want = moving ? p.walk : p.idle;
      if (!want.isRunning()) { (moving ? p.idle : p.walk).fadeOut(0.15); want.reset().fadeIn(0.15).play(); }
    }
  }

  /** Advances player animations by real frame time (cosmetic only, never the sim). */
  animate(dtMs: number) { for (const p of this.players.values()) p.mixer?.update(dtMs / 1000); }

  upsertGhost(id: number, x: number, y: number, z: number, yaw: number, dims: PlayerDims) {
    let g = this.ghosts.get(id);
    if (!g) { g = playerMesh(0xffffff, dims, true); this.ghosts.set(id, g); this.scene.add(g); }
    g.visible = true;
    g.position.set(x, y, z);
    g.rotation.y = yaw;
  }

  hideGhosts() { for (const g of this.ghosts.values()) g.visible = false; }

  removeMissing(alive: Set<number>) {
    for (const [id, p] of this.players) if (!alive.has(id)) { this.scene.remove(p.root); this.players.delete(id); }
    for (const [id, g] of this.ghosts) if (!alive.has(id)) { this.scene.remove(g); this.ghosts.delete(id); }
  }

  /** What a cosmetic tracer can stop at: the map and the players as drawn. */
  shotTargets(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [...this.mapMeshes];
    for (const p of this.players.values()) if (p.root.visible) out.push(p.root);
    return out;
  }

  render() { this.renderer.render(this.scene, this.camera); }
}

interface PlayerView { root: THREE.Object3D; team: Team; mixer: THREE.AnimationMixer | null; idle: THREE.AnimationAction | null; walk: THREE.AnimationAction | null }

function modelPlayer(g: { scene: THREE.Object3D; animations: THREE.AnimationClip[] }, team: Team, d: PlayerDims): PlayerView {
  const model = g.scene.clone(true);
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      const src = m.material as THREE.MeshStandardMaterial;
      const tinted = src.clone();
      tinted.color = new THREE.Color(TEAM_COLOR[team]).lerp(new THREE.Color(0xffffff), 0.25);
      m.material = tinted;
    }
  });
  // Scale the model to the sim's player height; its own height is not the hitbox.
  const box = new THREE.Box3().setFromObject(model);
  const h = box.max.y - box.min.y;
  const k = d.height / h;
  model.scale.setScalar(k);
  model.position.y = -box.min.y * k;
  model.rotation.y = Math.PI; // the model faces +Z; sim yaw 0 faces -Z
  const root = new THREE.Group();
  root.add(model);
  const mixer = new THREE.AnimationMixer(model);
  const clip = (n: string) => g.animations.find((a) => a.name === n);
  const idleClip = clip("idle"), walkClip = clip("walk");
  const idle = idleClip ? mixer.clipAction(idleClip) : null;
  const walk = walkClip ? mixer.clipAction(walkClip) : null;
  idle?.play();
  return { root, team, mixer, idle, walk };
}

function playerMesh(color: number, d: PlayerDims, ghost: boolean): THREE.Group {
  const mat = ghost
    ? new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.7, depthTest: false })
    : new THREE.MeshLambertMaterial({ color });
  const bodyH = d.headBottom;
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(d.width, bodyH, d.width), mat);
  body.position.y = bodyH / 2;
  const head = new THREE.Mesh(new THREE.BoxGeometry(d.headSize, d.headSize, d.headSize), mat);
  head.position.y = bodyH + d.headSize / 2;
  g.add(body, head);
  if (!ghost) {
    // A visor on the -Z face shows which way the player looks.
    const visor = new THREE.Mesh(new THREE.BoxGeometry(d.headSize * 0.8, d.headSize * 0.25, 0.02), new THREE.MeshBasicMaterial({ color: 0x111827 }));
    visor.position.set(0, bodyH + d.headSize * 0.6, -d.headSize / 2 - 0.011);
    g.add(visor);
  }
  g.renderOrder = ghost ? 10 : 0;
  return g;
}

/** First-person rifle made of boxes. Recoil and muzzle flash are cosmetic and client-only (B.3). */
export class Rifle {
  private root = new THREE.Group();
  private flash: THREE.Object3D;
  private kick = 0;
  private flashUntil = 0;
  private restZ = -0.42;

  constructor(camera: THREE.Camera, model: THREE.Object3D | null, flashTex: THREE.Texture | null = null) {
    if (model) {
      const m = model.clone(true);
      const box = new THREE.Box3().setFromObject(m);
      const len = box.max.z - box.min.z;
      m.scale.setScalar(0.5 / len); // about 0.5 m in hand
      this.root.add(m);
      this.flash = flashTex
        ? new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }))
        : new THREE.Mesh(new THREE.OctahedronGeometry(0.05), new THREE.MeshBasicMaterial({ color: 0xfde68a }));
      if (flashTex) this.flash.scale.setScalar(0.16);
      this.flash.position.set(0, 0.015, -0.27);
      this.flash.visible = false;
      this.root.add(this.flash);
      this.root.position.set(0.24, -0.22, -0.42);
      this.restZ = -0.42;
      this.root.traverse((o) => { o.renderOrder = 20; });
      camera.add(this.root);
      return;
    }
    const dark = new THREE.MeshLambertMaterial({ color: 0x1f2937 });
    const grey = new THREE.MeshLambertMaterial({ color: 0x4b5563 });
    const parts: [THREE.Material, [number, number, number], [number, number, number]][] = [
      [dark, [0.07, 0.09, 0.5], [0, 0, 0]],          // receiver
      [grey, [0.035, 0.035, 0.38], [0, 0.015, -0.42]], // barrel
      [dark, [0.06, 0.14, 0.06], [0, -0.1, 0.08]],   // grip
      [grey, [0.05, 0.12, 0.08], [0, -0.09, -0.1]],  // magazine
      [dark, [0.06, 0.08, 0.2], [0, -0.01, 0.32]],   // stock
      [grey, [0.02, 0.04, 0.12], [0, 0.065, 0]],     // sight rail
    ];
    for (const [m, s, p] of parts) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...s), m);
      mesh.position.set(...p);
      this.root.add(mesh);
    }
    this.flash = new THREE.Mesh(new THREE.OctahedronGeometry(0.06), new THREE.MeshBasicMaterial({ color: 0xfde68a }));
    this.flash.position.set(0, 0.015, -0.66);
    this.flash.visible = false;
    this.root.add(this.flash);
    this.root.position.set(0.2, -0.17, -0.42);
    this.root.scale.setScalar(0.45);
    this.root.traverse((o) => { o.renderOrder = 20; });
    camera.add(this.root);
  }

  /** World position of the muzzle, where tracers start. */
  muzzleWorld(): THREE.Vector3 { return this.flash.getWorldPosition(new THREE.Vector3()); }

  fire(now: number) {
    this.kick = 1;
    this.flashUntil = now + 45;
    this.flash.rotation.z = Math.random() * Math.PI; // cosmetic only, not part of any shot
  }

  update(now: number, dtMs: number) {
    this.kick = Math.max(0, this.kick - dtMs / 90);
    this.root.position.z = this.restZ + this.kick * 0.04;
    this.root.rotation.x = this.kick * 0.08;
    this.flash.visible = now < this.flashUntil;
  }
}
