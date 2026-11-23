import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";

// CC0 assets from docs/ASSETS.md. A file that fails to load leaves its primitive fallback in place, and the failure is
// logged and listed on the start screen.
export interface Assets {
  character: GLTF | null;
  rifle: GLTF | null;
  textures: Partial<Record<"ground" | "wall" | "cover" | "grid", THREE.Texture>>;
  vfx: Partial<Record<"muzzle_flash" | "impact_decal" | "hit_marker" | "headshot" | "kill_icon", THREE.Texture>>;
  sky: THREE.Texture | null;
  failures: string[];
}

export async function loadAssets(): Promise<Assets> {
  const gltf = new GLTFLoader();
  const tex = new THREE.TextureLoader();
  const out: Assets = { character: null, rifle: null, textures: {}, vfx: {}, sky: null, failures: [] };
  const fail = (what: string) => (e: unknown) => {
    const msg = `${what}: ${(e as Error)?.message ?? String(e)}`;
    out.failures.push(msg);
    console.warn(`asset failed, using primitive fallback — ${msg}`);
  };
  await Promise.all([
    gltf.loadAsync("./models/character.glb").then((g) => { out.character = g; }, fail("models/character.glb")),
    gltf.loadAsync("./models/rifle.glb").then((g) => { out.rifle = g; }, fail("models/rifle.glb")),
    ...(["ground", "wall", "cover", "grid"] as const).map((k) =>
      tex.loadAsync(`./textures/${k}.png`).then((t) => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 4;
        out.textures[k] = t;
      }, fail(`textures/${k}.png`))),
    ...(["muzzle_flash", "impact_decal", "hit_marker", "headshot", "kill_icon"] as const).map((k) =>
      tex.loadAsync(`./textures/vfx/${k}.png`).then((t) => { t.colorSpace = THREE.SRGBColorSpace; out.vfx[k] = t; }, fail(`textures/vfx/${k}.png`))),
    tex.loadAsync("./textures/sky/sky.png").then((t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.mapping = THREE.EquirectangularReflectionMapping;
      out.sky = t;
    }, fail("textures/sky/sky.png")),
  ]);
  return out;
}

/** Rewrites a BoxGeometry's UVs so a texture tiles once per `tile` metres on every face. */
export function worldUVs(geo: THREE.BoxGeometry, size: [number, number, number], tile: number) {
  const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
  const [sx, sy, sz] = size;
  // BoxGeometry face order: +x, -x, +y, -y, +z, -z; 4 vertices each. (u, v) extents per face:
  const faces: [number, number][] = [[sz, sy], [sz, sy], [sx, sz], [sx, sz], [sx, sy], [sx, sy]];
  for (let f = 0; f < 6; f++) {
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, (uv.getX(k) * faces[f][0]) / tile, (uv.getY(k) * faces[f][1]) / tile);
    }
  }
  uv.needsUpdate = true;
}
