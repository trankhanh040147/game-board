import * as THREE from 'three';
import { mulberry32, COLORS } from '../core/utils';
import type { Quality } from '../core/types';

type ParticleKind = 'blood' | 'spark' | 'dust';

const MAX_PARTICLES = 700;

class ParticleSystem {
  readonly points: THREE.Points;
  private positions: Float32Array;
  private velocities: Float32Array;
  private colors: Float32Array;
  private sizes: Float32Array;
  private alphas: Float32Array;
  private lives: Float32Array;
  private maxLives: Float32Array;
  private gravity: number;
  private drag: number;
  private count = 0;
  private geometry: THREE.BufferGeometry;
  private material: THREE.ShaderMaterial;
  private cursor = 0;

  constructor(scene: THREE.Scene, kind: ParticleKind) {
    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(MAX_PARTICLES * 3);
    this.velocities = new Float32Array(MAX_PARTICLES * 3);
    this.colors = new Float32Array(MAX_PARTICLES * 3);
    this.sizes = new Float32Array(MAX_PARTICLES);
    this.alphas = new Float32Array(MAX_PARTICLES);
    this.lives = new Float32Array(MAX_PARTICLES);
    this.maxLives = new Float32Array(MAX_PARTICLES);
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));
    geo.setDrawRange(0, 0);
    this.geometry = geo;

    const additive = kind === 'spark';
    this.gravity = kind === 'blood' ? -11 : kind === 'spark' ? -16 : -1.4;
    this.drag = kind === 'blood' ? 1.2 : kind === 'spark' ? 2.2 : 3.4;

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aAlpha;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (420.0 / max(1.0, -mv.z));
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec2 p = gl_PointCoord - 0.5;
          float d = length(p);
          float mask = smoothstep(0.5, 0.12, d);
          if (mask <= 0.001 || vAlpha <= 0.001) discard;
          gl_FragColor = vec4(vColor, mask * vAlpha);
        }
      `,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    scene.add(this.points);
  }

  spawn(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    life: number, size: number, color: THREE.Color,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % MAX_PARTICLES;
    this.count = Math.min(MAX_PARTICLES, this.count + 1);
    const i3 = i * 3;
    this.positions[i3] = x;
    this.positions[i3 + 1] = y;
    this.positions[i3 + 2] = z;
    this.velocities[i3] = vx;
    this.velocities[i3 + 1] = vy;
    this.velocities[i3 + 2] = vz;
    this.colors[i3] = color.r;
    this.colors[i3 + 1] = color.g;
    this.colors[i3 + 2] = color.b;
    this.sizes[i] = size;
    this.alphas[i] = 1;
    this.lives[i] = life;
    this.maxLives[i] = life;
    this.geometry.setDrawRange(0, MAX_PARTICLES);
  }

  update(dt: number): void {
    const pos = this.positions;
    const vel = this.velocities;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.lives[i] <= 0) continue;
      const i3 = i * 3;
      this.lives[i] -= dt;
      if (this.lives[i] <= 0) {
        this.alphas[i] = 0;
        continue;
      }
      vel[i3 + 1] += this.gravity * dt;
      const d = Math.max(0, 1 - this.drag * dt);
      vel[i3] *= d;
      vel[i3 + 1] *= d;
      vel[i3 + 2] *= d;
      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;
      if (pos[i3 + 1] < 0.02 && this.gravity < 0) {
        pos[i3 + 1] = 0.02;
        vel[i3 + 1] *= -0.12;
        vel[i3] *= 0.5;
        vel[i3 + 2] *= 0.5;
      }
      const t = this.lives[i] / this.maxLives[i];
      this.alphas[i] = t * t;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
    this.geometry.attributes.aColor.needsUpdate = true;
    this.geometry.attributes.aSize.needsUpdate = true;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
  }
}

interface Decal {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
}

const BLOOD_TEX_SIZE = 128;
function makeBloodTexture(rng: () => number): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = BLOOD_TEX_SIZE;
  canvas.height = BLOOD_TEX_SIZE;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, BLOOD_TEX_SIZE, BLOOD_TEX_SIZE);
  const cx = BLOOD_TEX_SIZE / 2;
  const cy = BLOOD_TEX_SIZE / 2;
  for (let i = 0; i < 9; i++) {
    const x = cx + (rng() - 0.5) * 54;
    const y = cy + (rng() - 0.5) * 46;
    const r = 6 + rng() * 22;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const shade = 40 + Math.floor(rng() * 40);
    g.addColorStop(0, `rgba(${shade + 40},8,8,0.92)`);
    g.addColorStop(0.6, `rgba(${shade},10,10,0.6)`);
    g.addColorStop(1, 'rgba(30,4,4,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 14; i++) {
    const a = rng() * Math.PI * 2;
    const d = 24 + rng() * 34;
    const r = 1 + rng() * 4;
    ctx.fillStyle = `rgba(70,10,10,${0.3 + rng() * 0.4})`;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Effects {
  private scene: THREE.Scene;
  private blood: ParticleSystem;
  private sparks: ParticleSystem;
  private dust: ParticleSystem;
  private rng: () => number;
  private decals: Decal[] = [];
  private bloodTexture: THREE.Texture;
  private decalGeo: THREE.PlaneGeometry;
  private decalMat: THREE.MeshBasicMaterial;
  private tmpColor = new THREE.Color();
  private quality: Quality;

  constructor(scene: THREE.Scene, quality: Quality, seed = 1337) {
    this.scene = scene;
    this.quality = quality;
    this.rng = mulberry32(seed);
    this.blood = new ParticleSystem(scene, 'blood');
    this.sparks = new ParticleSystem(scene, 'spark');
    this.dust = new ParticleSystem(scene, 'dust');
    this.bloodTexture = makeBloodTexture(this.rng);
    this.decalGeo = new THREE.PlaneGeometry(1.05, 1.05);
    this.decalMat = new THREE.MeshBasicMaterial({
      map: this.bloodTexture,
      transparent: true,
      depthWrite: false,
      opacity: 0.62,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      side: THREE.DoubleSide,
    });
  }

  bloodBurst(pos: THREE.Vector3, dir: THREE.Vector3, amount = 16): void {
    const n = this.quality === 'low' ? Math.floor(amount * 0.5) : amount;
    for (let i = 0; i < n; i++) {
      const spread = 1.7;
      const vx = dir.x * (1.2 + this.rng() * 3.4) + (this.rng() - 0.5) * spread;
      const vy = 0.6 + this.rng() * 3.6;
      const vz = dir.z * (1.2 + this.rng() * 3.4) + (this.rng() - 0.5) * spread;
      this.tmpColor.setHSL(0.995, 0.72, 0.12 + this.rng() * 0.16);
      this.blood.spawn(
        pos.x + (this.rng() - 0.5) * 0.16,
        pos.y + (this.rng() - 0.5) * 0.3,
        pos.z + (this.rng() - 0.5) * 0.16,
        vx, vy, vz,
        0.4 + this.rng() * 0.65,
        0.045 + this.rng() * 0.09,
        this.tmpColor,
      );
    }
  }

  sparkBurst(pos: THREE.Vector3, dir: THREE.Vector3, amount = 10): void {
    const n = this.quality === 'low' ? Math.floor(amount * 0.5) : amount;
    for (let i = 0; i < n; i++) {
      const vx = dir.x * (1.5 + this.rng() * 2.5) + (this.rng() - 0.5) * 3.4;
      const vy = 0.8 + this.rng() * 3.2;
      const vz = dir.z * (1.5 + this.rng() * 2.5) + (this.rng() - 0.5) * 3.4;
      this.tmpColor.setHSL(0.09 + this.rng() * 0.04, 1.0, 0.62 + this.rng() * 0.3);
      this.sparks.spawn(
        pos.x, pos.y, pos.z, vx, vy, vz,
        0.18 + this.rng() * 0.32,
        0.02 + this.rng() * 0.045,
        this.tmpColor,
      );
    }
  }

  dustPuff(pos: THREE.Vector3, amount = 5, strength = 1): void {
    if (this.quality === 'low') amount = Math.ceil(amount * 0.4);
    for (let i = 0; i < amount; i++) {
      const vx = (this.rng() - 0.5) * 1.5 * strength;
      const vy = 0.15 + this.rng() * 0.9;
      const vz = (this.rng() - 0.5) * 1.5 * strength;
      this.tmpColor.setHSL(0.11, 0.22, 0.6 + this.rng() * 0.12);
      this.dust.spawn(
        pos.x + (this.rng() - 0.5) * 0.3,
        0.08 + this.rng() * 0.12,
        pos.z + (this.rng() - 0.5) * 0.3,
        vx, vy, vz,
        0.6 + this.rng() * 0.9,
        0.12 + this.rng() * 0.22,
        this.tmpColor,
      );
    }
  }

  bloodDecal(pos: THREE.Vector3, scale = 1): void {
    const mesh = new THREE.Mesh(this.decalGeo, this.decalMat.clone());
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = this.rng() * Math.PI * 2;
    mesh.position.set(pos.x + (this.rng() - 0.5) * 0.7, 0.012 + this.rng() * 0.003, pos.z + (this.rng() - 0.5) * 0.7);
    const s = scale * (0.55 + this.rng() * 0.6);
    mesh.scale.setScalar(s);
    mesh.renderOrder = 1;
    this.scene.add(mesh);
    this.decals.push({ mesh, life: 20, maxLife: 20 });
    while (this.decals.length > 22) {
      const old = this.decals.shift();
      if (old) {
        this.scene.remove(old.mesh);
        (old.mesh.material as THREE.Material).dispose();
      }
    }
  }

  update(dt: number): void {
    this.blood.update(dt);
    this.sparks.update(dt);
    this.dust.update(dt);
    for (let i = this.decals.length - 1; i >= 0; i--) {
      const d = this.decals[i];
      d.life -= dt;
      const mat = d.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = Math.min(d.maxLife > 0 ? 1 : 0, (d.life / 6)) * 0.85;
      if (d.life <= 0) {
        this.scene.remove(d.mesh);
        mat.dispose();
        this.decals.splice(i, 1);
      }
    }
  }

  clearDecals(): void {
    for (const d of this.decals) {
      this.scene.remove(d.mesh);
      (d.mesh.material as THREE.Material).dispose();
    }
    this.decals.length = 0;
  }

  dispose(): void {
    this.clearDecals();
    this.blood.dispose(this.scene);
    this.sparks.dispose(this.scene);
    this.dust.dispose(this.scene);
    this.decalGeo.dispose();
    this.decalMat.dispose();
    this.bloodTexture.dispose();
  }
}

void COLORS;
