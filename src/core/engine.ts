import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import type { Quality } from './types';
import { clamp } from './utils';

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uDamage: { value: 0 },
    uVignette: { value: 0.34 },
    uGrain: { value: 0.032 },
    uDesaturate: { value: 0.06 },
    uWarm: { value: 0.02 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uDamage;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uDesaturate;
    uniform float uWarm;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    void main() {
      vec2 uv = vUv;
      vec2 center = uv - 0.5;
      float r2 = dot(center, center);

      // subtle chromatic aberration toward the edges
      float ca = 0.0016 * r2;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + center * ca).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - center * ca).b;

      // gentle warm grade + contrast
      float luma = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(luma), col, 1.0 - uDesaturate);
      col += vec3(uWarm, uWarm * 0.7, -uWarm * 0.35);
      col = (col - 0.5) * 1.045 + 0.5;

      // damage pulse at the edges
      float vig = smoothstep(0.92, 0.25, r2 * (1.0 + uVignette));
      col *= mix(1.0, 0.72, (1.0 - vig) * 0.85 * 0.7);
      col = mix(col, vec3(0.45, 0.02, 0.02), uDamage * smoothstep(0.12, 0.55, r2) * 0.55);

      // film grain
      float grain = hash(uv * uResolution.xy * 0.45 + uTime * 31.0) - 0.5;
      col += grain * uGrain;

      gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
    }
  `,
};

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;
  readonly container: HTMLElement;
  quality: Quality;
  time = 0;
  private composer: EffectComposer | null = null;
  private renderPass: RenderPass | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private gradePass: ShaderPass | null = null;
  private smaaPass: SMAAPass | null = null;
  private outputPass: OutputPass | null = null;
  private basePixelRatio = 1;
  private usePost = true;
  private resizeObserver: ResizeObserver | null = null;
  private damage = 0;
  onResize: ((w: number, h: number) => void) | null = null;

  constructor(container: HTMLElement, quality: Quality = 'high') {
    this.container = container;
    this.quality = quality;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'game-canvas';
    container.appendChild(this.canvas);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      powerPreference: 'high-performance',
      alpha: false,
      stencil: false,
    });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.info.autoReset = false;
    this.basePixelRatio = Math.min(window.devicePixelRatio || 1, quality === 'high' ? 2 : quality === 'medium' ? 1.5 : 1);
    this.renderer.setPixelRatio(this.basePixelRatio);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xcfd3cc);
    this.scene.fog = new THREE.Fog(0xd8d2c0, 44, 150);

    this.camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.08, 260);
    this.camera.position.set(0, 3, 10);

    this.resize();
    window.addEventListener('resize', this.onWindowResize);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(container);
    }
    this.rebuildComposer();
  }

  private onWindowResize = () => this.resize();

  resize(): void {
    const w = Math.max(320, this.container.clientWidth || window.innerWidth);
    const h = Math.max(240, this.container.clientHeight || window.innerHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.composer?.setSize(w, h);
    if (this.bloomPass) this.bloomPass.resolution.set(w, h);
    if (this.gradePass) this.gradePass.uniforms.uResolution.value.set(w, h);
    this.onResize?.(w, h);
  }

  private clearComposer(): void {
    if (this.composer) {
      this.composer.dispose();
      this.composer = null;
    }
    this.bloomPass = null;
    this.gradePass = null;
    this.smaaPass = null;
    this.outputPass = null;
    this.renderPass = null;
  }

  rebuildComposer(): void {
    this.clearComposer();
    this.usePost = this.quality !== 'low';
    this.basePixelRatio = Math.min(window.devicePixelRatio || 1, this.quality === 'high' ? 2 : this.quality === 'medium' ? 1.5 : 1);
    this.renderer.setPixelRatio(this.usePost ? Math.min(this.basePixelRatio, 1.5) : this.basePixelRatio);
    this.renderer.shadowMap.enabled = true;
    if (!this.usePost) {
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.resize();
      return;
    }
    const size = this.renderer.getSize(new THREE.Vector2());
    const w = Math.max(320, size.x);
    const h = Math.max(240, size.y);

    const composer = new EffectComposer(this.renderer);
    composer.setPixelRatio(this.renderer.getPixelRatio());
    composer.setSize(w, h);
    this.renderPass = new RenderPass(this.scene, this.camera);
    composer.addPass(this.renderPass);

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(w, h),
      this.quality === 'high' ? 0.26 : 0.18,
      0.6,
      0.86,
    );
    composer.addPass(this.bloomPass);

    this.gradePass = new ShaderPass(GradeShader);
    this.gradePass.uniforms.uResolution.value.set(w, h);
    this.gradePass.uniforms.uGrain.value = this.quality === 'high' ? 0.03 : 0.015;
    composer.addPass(this.gradePass);

    if (this.quality === 'high') {
      this.smaaPass = new SMAAPass();
      this.smaaPass.setSize(w, h);
      composer.addPass(this.smaaPass);
    }

    this.outputPass = new OutputPass();
    composer.addPass(this.outputPass);
    this.composer = composer;
    this.resize();
  }

  setQuality(quality: Quality): void {
    if (this.quality === quality) return;
    this.quality = quality;
    this.rebuildComposer();
  }

  /** 0..1 red damage vignette driven by combat. */
  setDamagePulse(v: number): void {
    this.damage = clamp(v, 0, 1);
    if (this.gradePass) this.gradePass.uniforms.uDamage.value = this.damage;
  }

  update(dt: number): void {
    this.time += dt;
    if (this.gradePass) {
      this.gradePass.uniforms.uTime.value = this.time;
      this.gradePass.uniforms.uDamage.value = this.damage;
    }
  }

  render(): void {
    this.renderer.info.reset();
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    window.removeEventListener('resize', this.onWindowResize);
    this.resizeObserver?.disconnect();
    this.clearComposer();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
