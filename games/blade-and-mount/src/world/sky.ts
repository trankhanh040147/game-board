import * as THREE from 'three';
import type { Quality } from '../core/types';

/**
 * Sky dome (procedural gradient + drifting fbm clouds + sun disc) and layered
 * distant hill silhouettes. One draw call for the sky, one per hill ridge.
 */

export interface SkySystem {
  group: THREE.Group;
  sunDirection: THREE.Vector3;
  update(time: number): void;
  dispose(): void;
}

function ridgeGeometry(
  seed: number,
  radius: number,
  baseHeight: number,
  amplitude: number,
  bottomColor: THREE.Color,
  topColor: THREE.Color,
  segments: number,
): THREE.BufferGeometry {
  const rnd = (n: number): number => {
    const x = Math.sin(seed * 127.1 + n * 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  const waves = [
    { freq: 2, amp: 0.36, phase: rnd(1) * 6.28 },
    { freq: 3, amp: 0.28, phase: rnd(2) * 6.28 },
    { freq: 5, amp: 0.24, phase: rnd(3) * 6.28 },
    { freq: 8, amp: 0.22, phase: rnd(4) * 6.28 },
    { freq: 13, amp: 0.17, phase: rnd(5) * 6.28 },
    { freq: 21, amp: 0.12, phase: rnd(6) * 6.28 },
    { freq: 34, amp: 0.07, phase: rnd(7) * 6.28 },
  ];
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const c = new THREE.Color();
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    let h = 0;
    for (const w of waves) {
      const s01 = 0.5 + 0.5 * Math.sin(a * w.freq + w.phase);
      // Sharpen crests so the skyline reads as mountains, not dunes.
      h += w.amp * Math.pow(s01, 1.9);
    }
    const height = baseHeight + amplitude * (h / 1.2);
    const x = Math.cos(a) * radius;
    const z = Math.sin(a) * radius;
    positions.push(x, -4, z);
    c.copy(bottomColor);
    colors.push(c.r, c.g, c.b);
    positions.push(x, height, z);
    c.copy(topColor);
    colors.push(c.r, c.g, c.b);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    const b = i * 2 + 1;
    const cIdx = i * 2 + 2;
    const d = i * 2 + 3;
    indices.push(a, cIdx, b, b, cIdx, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  return geo;
}

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAG = /* glsl */ `
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform vec3 uHaze;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform float uTime;
  uniform float uCloudCover;
  varying vec3 vDir;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < OCTAVES; i++) {
      v += a * vnoise(p);
      p = p * 2.03 + vec2(1.7, 9.2);
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec3 dir = normalize(vDir);
    float h = clamp(dir.y, 0.0, 1.0);

    // Painted late-afternoon sky: warm cream horizon into a soft blue zenith.
    vec3 col = mix(uHorizon, uZenith, pow(h, 0.48));
    col = mix(col, uHaze, pow(1.0 - h, 11.0) * 0.34);

    float mu = max(dot(dir, uSunDir), 0.0);
    col += uSunColor * pow(mu, 5.0) * 0.03 * (1.0 - h);
    col += uSunColor * pow(mu, 28.0) * 0.055;
    float disc = smoothstep(0.99935, 0.9998, mu);
    col += uSunColor * disc * 1.55;

    if (dir.y > 0.004) {
      // Project onto a cloud deck: smaller scale gives crisp cumulus shapes
      // instead of one flat grey smear.
      vec2 cp = dir.xz * vec2(2.6, 4.6) / (dir.y + 0.30);
      float t = uTime * 0.0035;

      float n1 = fbm(cp * 0.58 + vec2(t * 0.42, t * 0.16));
      float n2 = fbm(cp * 1.55 + vec2(-t * 0.34, t * 0.26) + 23.1);
      float n3 = fbm(cp * 4.1 + vec2(t * 0.75, -t * 0.3) + 5.7);
      float density = n1 * 0.5 + n2 * 0.32 + n3 * 0.18;

      float cover = smoothstep(0.615 - uCloudCover * 0.09, 0.675, density);
      // Clear only the very low band; keep structure through the view band.
      cover *= smoothstep(0.012, 0.075, dir.y);
      cover *= 1.0 - smoothstep(0.78, 0.95, dir.y) * 0.25;

      float lit = smoothstep(0.44, 0.74, density);
      vec3 cloudCol = mix(vec3(0.22, 0.35, 0.55), vec3(0.98, 0.97, 0.95), lit);
      cloudCol += uSunColor * pow(mu, 2.0) * 0.22 * lit;
      cloudCol += uSunColor * pow(mu, 14.0) * 0.18;
      col = mix(col, cloudCol, clamp(cover, 0.0, 0.88));

      // Painted high wisps.
      float cirrus = smoothstep(0.58, 0.86, fbm(vec2(cp.x * 0.3 + t * 0.12, cp.y * 3.4 + 11.0)));
      col = mix(col, vec3(1.0, 0.99, 0.96), cirrus * 0.12);
    }

    // Gentle lift of the very low band so the skyline reads hazy, not muddy.
    col = mix(col, uHaze, smoothstep(0.06, 0.0, dir.y) * 0.35);

    gl_FragColor = vec4(col * 0.92, 1.0);
  }
`;

export function createSky(quality: Quality, seed = 1337): SkySystem {
  const group = new THREE.Group();
  group.name = 'sky';

  const sunDirection = new THREE.Vector3(0.66, 0.36, 0.62).normalize();

  const uniforms = {
    uHorizon: { value: new THREE.Color('#e9dcc0') },
    uZenith: { value: new THREE.Color('#5b8fb4') },
    uHaze: { value: new THREE.Color('#ded5c0') },
    uSunDir: { value: sunDirection.clone() },
    uSunColor: { value: new THREE.Color('#ffe9c4') },
    uTime: { value: 0 },
    uCloudCover: { value: quality === 'low' ? 0.28 : 0.4 },
  };

  const skyGeo = new THREE.SphereGeometry(238, 40, 26);
  const skyMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    defines: { OCTAVES: quality === 'low' ? 3 : quality === 'medium' ? 4 : 5 },
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.name = 'sky-dome';
  sky.renderOrder = -1000;
  sky.frustumCulled = false;
  group.add(sky);

  // Distant hills: two ridges, far one paler for aerial perspective.
  const haze = new THREE.Color('#ded5c0');
  const ridgeColors = [
    { near: new THREE.Color('#4f6660'), far: new THREE.Color('#627770') },
    { near: new THREE.Color('#6d827e'), far: new THREE.Color('#819490') },
  ];
  const ridgeSpecs = [
    { radius: 148, base: 14, amp: 30, spec: ridgeColors[0], segments: 190 },
    { radius: 200, base: 22, amp: 40, spec: ridgeColors[1], segments: 160 },
  ];
  const hillMats: THREE.Material[] = [];
  for (let i = 0; i < ridgeSpecs.length; i++) {
    const r = ridgeSpecs[i];
    const geo = ridgeGeometry(seed + i * 17, r.radius, r.base, r.amp, haze, r.spec.near, r.segments);
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      fog: true,
      side: THREE.DoubleSide,
      toneMapped: true,
    });
    hillMats.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `hills-${i}`;
    mesh.renderOrder = -500 + i;
    mesh.frustumCulled = false;
    group.add(mesh);
  }

  return {
    group,
    sunDirection,
    update: (time: number) => {
      uniforms.uTime.value = time;
    },
    dispose: () => {
      skyGeo.dispose();
      skyMat.dispose();
      for (const m of hillMats) m.dispose();
      for (const child of group.children) {
        if (child instanceof THREE.Mesh) child.geometry.dispose();
      }
    },
  };
}
