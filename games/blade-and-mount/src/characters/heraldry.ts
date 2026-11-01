import * as THREE from 'three';
import { mulberry32, clamp } from '../core/utils';
import { cssColor, shade, mixHex } from './shared';
import type { ShieldDef } from '../core/types';

/* ------------------------------------------------------------------ */
/* Canvas helpers                                                      */
/* ------------------------------------------------------------------ */

function canvas2d(w: number, h: number): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  return { c, ctx };
}

function textureFrom(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/** Cloth grain / wear overlay for painted surfaces. */
function clothGrain(ctx: CanvasRenderingContext2D, w: number, h: number, rng: () => number, amount = 1): void {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * 26 * amount;
    d[i] = clamp(d[i] + n, 0, 255);
    d[i + 1] = clamp(d[i + 1] + n, 0, 255);
    d[i + 2] = clamp(d[i + 2] + n, 0, 255);
  }
  ctx.putImageData(img, 0, 0);
  // Weave: faint vertical and horizontal threads.
  ctx.save();
  ctx.globalAlpha = 0.05;
  ctx.strokeStyle = '#000';
  for (let x = 0; x < w; x += 3) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
    ctx.stroke();
  }
  for (let y = 0; y < h; y += 3) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
    ctx.stroke();
  }
  ctx.restore();
}

function wearScratches(ctx: CanvasRenderingContext2D, w: number, h: number, rng: () => number, count = 26): void {
  ctx.save();
  for (let i = 0; i < count; i++) {
    const x = rng() * w;
    const y = rng() * h;
    const len = 3 + rng() * 22;
    const a = rng() * Math.PI;
    ctx.strokeStyle = rng() > 0.45 ? `rgba(255,248,235,${0.05 + rng() * 0.15})` : `rgba(20,14,10,${0.05 + rng() * 0.18})`;
    ctx.lineWidth = 0.6 + rng() * 1.3;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }
  // Grime at the lower edge.
  const g = ctx.createLinearGradient(0, h * 0.55, 0, h);
  g.addColorStop(0, 'rgba(30,22,14,0)');
  g.addColorStop(1, 'rgba(30,22,14,0.32)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* ------------------------------------------------------------------ */
/* Emblems                                                             */
/* ------------------------------------------------------------------ */

export type Emblem = 'cross' | 'chevron' | 'lion' | 'star' | 'bars' | 'sun';

function paintEmblem(
  ctx: CanvasRenderingContext2D,
  emblem: Emblem,
  cx: number,
  cy: number,
  size: number,
  fill: string,
  outline: string,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = outline;
  ctx.lineWidth = Math.max(2, size * 0.055);
  ctx.fillStyle = fill;

  const paint = (fn: () => void): void => {
    ctx.beginPath();
    fn();
    ctx.fill();
    ctx.stroke();
  };

  switch (emblem) {
    case 'cross': {
      paint(() => {
        const a = size * 0.17;
        const l = size * 0.56;
        ctx.moveTo(-a, -l);
        ctx.lineTo(a, -l);
        ctx.lineTo(a, -a);
        ctx.lineTo(l, -a);
        ctx.lineTo(l, a);
        ctx.lineTo(a, a);
        ctx.lineTo(a, l);
        ctx.lineTo(-a, l);
        ctx.lineTo(-a, a);
        ctx.lineTo(-l, a);
        ctx.lineTo(-l, -a);
        ctx.lineTo(-a, -a);
        ctx.closePath();
      });
      break;
    }
    case 'chevron': {
      paint(() => {
        const w = size * 0.5;
        const h = size * 0.36;
        const t = size * 0.16;
        ctx.moveTo(0, -h);
        ctx.lineTo(w, h * 0.62);
        ctx.lineTo(w - t, h * 0.62);
        ctx.lineTo(0, -h + t * 1.55);
        ctx.lineTo(-w + t, h * 0.62);
        ctx.lineTo(-w, h * 0.62);
        ctx.closePath();
      });
      paint(() => {
        const w = size * 0.5;
        const h = size * 0.36;
        const t = size * 0.16;
        const y = h * 0.42;
        ctx.moveTo(0, -h + y);
        ctx.lineTo(w, h * 0.62 + y);
        ctx.lineTo(w - t, h * 0.62 + y);
        ctx.lineTo(0, -h + t * 1.55 + y);
        ctx.lineTo(-w + t, h * 0.62 + y);
        ctx.lineTo(-w, h * 0.62 + y);
        ctx.closePath();
      });
      break;
    }
    case 'lion': {
      // Stylised rampant lion: body, raised forelegs, head, tail.
      paint(() => {
        const s = size * 0.5;
        ctx.moveTo(-s * 0.55, s * 0.95);
        ctx.quadraticCurveTo(-s * 0.75, s * 0.2, -s * 0.4, -s * 0.15);
        ctx.quadraticCurveTo(-s * 0.25, -s * 0.5, -s * 0.05, -s * 0.6);
        // head
        ctx.quadraticCurveTo(s * 0.05, -s * 0.78, s * 0.26, -s * 0.7);
        ctx.quadraticCurveTo(s * 0.45, -s * 0.6, s * 0.4, -s * 0.42);
        ctx.lineTo(s * 0.56, -s * 0.5);
        ctx.lineTo(s * 0.36, -s * 0.2);
        ctx.quadraticCurveTo(s * 0.7, -s * 0.05, s * 0.72, s * 0.3);
        ctx.quadraticCurveTo(s * 0.74, s * 0.62, s * 0.5, s * 0.95);
        ctx.lineTo(s * 0.34, s * 0.9);
        ctx.quadraticCurveTo(s * 0.38, s * 0.4, s * 0.18, s * 0.25);
        ctx.quadraticCurveTo(s * 0.02, s * 0.1, s * 0.0, s * 0.5);
        ctx.lineTo(s * 0.05, s * 0.95);
        ctx.lineTo(-s * 0.12, s * 0.95);
        ctx.lineTo(-s * 0.18, s * 0.35);
        ctx.quadraticCurveTo(-s * 0.3, s * 0.55, -s * 0.36, s * 0.95);
        ctx.closePath();
      });
      // Legs / mane accents.
      ctx.save();
      ctx.strokeStyle = outline;
      ctx.lineWidth = Math.max(1.5, size * 0.03);
      ctx.beginPath();
      ctx.moveTo(-size * 0.3, -size * 0.05);
      ctx.lineTo(-size * 0.48, -size * 0.2);
      ctx.moveTo(size * 0.5, size * 0.5);
      ctx.lineTo(size * 0.68, size * 0.62);
      ctx.stroke();
      ctx.restore();
      break;
    }
    case 'star': {
      paint(() => {
        const spikes = 5;
        const outer = size * 0.52;
        const inner = outer * 0.42;
        for (let i = 0; i < spikes * 2; i++) {
          const r = i % 2 === 0 ? outer : inner;
          const a = -Math.PI / 2 + (i * Math.PI) / spikes;
          const x = Math.cos(a) * r;
          const y = Math.sin(a) * r;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
      });
      break;
    }
    case 'bars': {
      paint(() => {
        const w = size * 0.52;
        const t = size * 0.105;
        const gap = size * 0.2;
        for (let i = -1; i <= 1; i++) {
          ctx.rect(-w, i * gap - t / 2, w * 2, t);
        }
      });
      break;
    }
    case 'sun': {
      paint(() => {
        const r = size * 0.28;
        ctx.arc(0, 0, r, 0, Math.PI * 2);
      });
      ctx.save();
      ctx.fillStyle = fill;
      ctx.strokeStyle = outline;
      ctx.lineWidth = Math.max(1.5, size * 0.03);
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const r0 = size * 0.32;
        const r1 = size * 0.5;
        const w = size * 0.055;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r0 + Math.cos(a + Math.PI / 2) * w, Math.sin(a) * r0 + Math.sin(a + Math.PI / 2) * w);
        ctx.lineTo(Math.cos(a + 0.12) * r1, Math.sin(a + 0.12) * r1);
        ctx.lineTo(Math.cos(a) * r0 - Math.cos(a + Math.PI / 2) * w, Math.sin(a) * r0 - Math.sin(a + Math.PI / 2) * w);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
      break;
    }
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* Shield faces                                                        */
/* ------------------------------------------------------------------ */

const shieldTexCache = new Map<string, THREE.CanvasTexture>();

export function shieldTextureKey(shield: ShieldDef): string {
  return `sh:${shield.id}:${shield.emblem}:${shield.color}:${shield.color2}`;
}

/** Paint a heraldic shield face. The texture is shaped to the shield silhouette. */
export function shieldTexture(shield: ShieldDef): THREE.Texture | null {
  const key = shieldTextureKey(shield);
  const cached = shieldTexCache.get(key);
  if (cached) return cached;
  const SIZE = 256;
  const made = canvas2d(SIZE, SIZE);
  if (!made) return null;
  const { c, ctx } = made;
  const rng = mulberry32(0x51a7 ^ (shield.color + shield.color2 * 13));
  ctx.clearRect(0, 0, SIZE, SIZE);

  // Silhouette path so the paint never bleeds outside the shield edge.
  ctx.save();
  const silk = shieldSilhouette(shield.id);
  silk(ctx, SIZE, SIZE);
  ctx.clip();

  // Base field.
  ctx.fillStyle = cssColor(shield.color);
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Faint vertical planks / leather strips for physical depth.
  for (let i = 0; i < 10; i++) {
    const x = (i / 9) * SIZE;
    ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.05)';
    ctx.fillRect(x, 0, SIZE / 9 + 1, SIZE);
  }

  // Heraldic division.
  const emblem = shield.emblem;
  const secondary = cssColor(shield.color2);
  switch (shield.id) {
    case 'kite':
    case 'heater': {
      // Chief band + pale behind the emblem.
      ctx.fillStyle = secondary;
      ctx.globalAlpha = 0.9;
      ctx.fillRect(0, SIZE * 0.08, SIZE, SIZE * 0.05);
      ctx.globalAlpha = 1;
      break;
    }
    case 'round': {
      ctx.fillStyle = secondary;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.arc(SIZE / 2, SIZE / 2, SIZE * 0.27, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      break;
    }
    case 'tower': {
      ctx.fillStyle = secondary;
      ctx.globalAlpha = 0.55;
      ctx.fillRect(SIZE * 0.12, SIZE * 0.1, SIZE * 0.76, SIZE * 0.05);
      ctx.fillRect(SIZE * 0.12, SIZE * 0.85, SIZE * 0.76, SIZE * 0.05);
      ctx.globalAlpha = 1;
      break;
    }
  }

  // Emblem (drawn slightly above centre for heaters).
  const ecy = shield.id === 'kite' ? SIZE * 0.44 : shield.id === 'tower' ? SIZE * 0.47 : SIZE * 0.47;
  paintEmblem(
    ctx,
    emblem,
    SIZE / 2,
    ecy,
    SIZE * 0.34,
    secondary,
    cssColor(shade(shield.color, 0.42)),
  );

  // Border.
  ctx.strokeStyle = secondary;
  ctx.lineWidth = SIZE * 0.045;
  silk(ctx, SIZE, SIZE);
  ctx.stroke();
  ctx.strokeStyle = cssColor(shade(shield.color, 0.45));
  ctx.lineWidth = SIZE * 0.012;
  silk(ctx, SIZE, SIZE);
  ctx.stroke();

  // Edge shadow to fake curvature.
  const grad = ctx.createRadialGradient(SIZE * 0.42, SIZE * 0.36, SIZE * 0.06, SIZE / 2, SIZE / 2, SIZE * 0.62);
  grad.addColorStop(0, 'rgba(255,246,224,0.13)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.34)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SIZE, SIZE);

  clothGrain(ctx, SIZE, SIZE, rng, 0.7);
  wearScratches(ctx, SIZE, SIZE, rng, 30);
  ctx.restore();

  const tex = textureFrom(c);
  shieldTexCache.set(key, tex);
  return tex;
}

function shieldSilhouette(id: ShieldDef['id']): (ctx: CanvasRenderingContext2D, w: number, h: number) => void {
  if (id === 'kite') {
    return (ctx, w, h) => {
      const m = w * 0.045;
      ctx.beginPath();
      ctx.moveTo(m, m + w * 0.04);
      ctx.quadraticCurveTo(w / 2, -m + w * 0.02, w - m, m + w * 0.04);
      ctx.quadraticCurveTo(w - m, h * 0.55, w / 2, h - m);
      ctx.quadraticCurveTo(m, h * 0.55, m, m + w * 0.04);
      ctx.closePath();
    };
  }
  if (id === 'heater') {
    return (ctx, w, h) => {
      const m = w * 0.05;
      ctx.beginPath();
      ctx.moveTo(m, m + w * 0.03);
      ctx.quadraticCurveTo(w / 2, -m, w - m, m + w * 0.03);
      ctx.lineTo(w - m, h * 0.5);
      ctx.quadraticCurveTo(w * 0.82, h * 0.86, w / 2, h - m);
      ctx.quadraticCurveTo(w * 0.18, h * 0.86, m, h * 0.5);
      ctx.closePath();
    };
  }
  if (id === 'round') {
    return (ctx, w) => {
      ctx.beginPath();
      ctx.arc(w / 2, w / 2, w / 2 - w * 0.025, 0, Math.PI * 2);
      ctx.closePath();
    };
  }
  return (ctx, w, h) => {
    const m = w * 0.05;
    const r = w * 0.14;
    roundedRect(ctx, m, m, w - m * 2, h - m * 2, r);
  };
}

/* ------------------------------------------------------------------ */
/* Tabard / surcoat                                                    */
/* ------------------------------------------------------------------ */

const tabardTexCache = new Map<string, THREE.CanvasTexture>();

export function tabardTextureKey(color1: number, color2: number, pattern: number, emblem: Emblem): string {
  return `tb:${color1}:${color2}:${pattern}:${emblem}`;
}

export function tabardTexture(color1: number, color2: number, pattern: number, emblem: Emblem): THREE.Texture | null {
  const key = tabardTextureKey(color1, color2, pattern, emblem);
  const cached = tabardTexCache.get(key);
  if (cached) return cached;
  const W = 128;
  const H = 256;
  const made = canvas2d(W, H);
  if (!made) return null;
  const { c, ctx } = made;
  const rng = mulberry32(0x71b3 ^ (color1 + color2 * 31 + pattern * 7));

  ctx.fillStyle = cssColor(color1);
  ctx.fillRect(0, 0, W, H);

  if (pattern === 1) {
    // Party per pale.
    ctx.fillStyle = cssColor(color2);
    ctx.fillRect(W / 2, 0, W / 2, H);
  } else if (pattern === 2) {
    // Quarterly.
    ctx.fillStyle = cssColor(color2);
    ctx.fillRect(W / 2, 0, W / 2, H / 2);
    ctx.fillRect(0, H / 2, W / 2, H / 2);
  }

  // Emblem on the chest.
  const contrast = pattern === 0 ? color2 : color1;
  paintEmblem(ctx, emblem, W / 2, H * 0.24, W * 0.3, cssColor(contrast), cssColor(shade(contrast, 0.4)));

  // Hem band.
  ctx.fillStyle = cssColor(color2);
  ctx.fillRect(0, H - 16, W, 16);
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fillRect(0, H - 18, W, 3);

  clothGrain(ctx, W, H, rng, 1);
  wearScratches(ctx, W, H, rng, 22);

  // Ambient occlusion towards the bottom and edges.
  const g = ctx.createLinearGradient(0, H * 0.45, 0, H);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.3)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const tex = textureFrom(c);
  tabardTexCache.set(key, tex);
  return tex;
}

/* ------------------------------------------------------------------ */
/* Shields geometry                                                    */
/* ------------------------------------------------------------------ */

/** Build the shield silhouette as a 2D shape in metres (origin at shield centre). */
export function shieldShape(shield: ShieldDef): THREE.Shape {
  const w = shield.width;
  const h = shield.height;
  const hw = w / 2;
  const hh = h / 2;
  const s = new THREE.Shape();
  if (shield.id === 'kite') {
    s.moveTo(-hw, hh);
    s.quadraticCurveTo(0, hh + h * 0.06, hw, hh);
    s.quadraticCurveTo(hw * 0.96, -hh * 0.2, 0, -hh);
    s.quadraticCurveTo(-hw * 0.96, -hh * 0.2, -hw, hh);
  } else if (shield.id === 'heater') {
    s.moveTo(-hw, hh);
    s.quadraticCurveTo(0, hh + h * 0.08, hw, hh);
    s.lineTo(hw * 0.98, -hh * 0.18);
    s.quadraticCurveTo(hw * 0.72, -hh * 0.72, 0, -hh);
    s.quadraticCurveTo(-hw * 0.72, -hh * 0.72, -hw * 0.98, -hh * 0.18);
    s.closePath();
  } else if (shield.id === 'round') {
    const r = hw;
    s.absarc(0, 0, r, 0, Math.PI * 2, false);
  } else {
    // Tower: slightly tapered rounded rectangle.
    const r = Math.min(hw, hh) * 0.24;
    const x0 = -hw * 0.94;
    const x1 = hw * 0.94;
    const y0 = -hh * 0.94;
    const y1 = hh * 0.97;
    s.moveTo(x0 + r, y1);
    s.lineTo(x1 - r, y1);
    s.quadraticCurveTo(x1, y1, x1, y1 - r);
    s.lineTo(x1, y0 + r);
    s.quadraticCurveTo(x1, y0, x1 - r, y0);
    s.lineTo(x0 + r, y0);
    s.quadraticCurveTo(x0, y0, x0, y0 + r);
    s.lineTo(x0, y1 - r);
    s.quadraticCurveTo(x0, y1, x0 + r, y1);
    s.closePath();
  }
  return s;
}

/**
 * Shield face geometry with UVs mapped from the shield's bounding box.
 * Depth is added so the shield reads as a physical object from the side.
 */
export function shieldFaceGeometry(shield: ShieldDef): THREE.BufferGeometry {
  const shape = shieldShape(shield);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.035,
    bevelEnabled: true,
    bevelThickness: 0.012,
    bevelSize: 0.01,
    bevelSegments: 1,
    curveSegments: 8,
  });
  geo.translate(0, 0, -0.0175);
  const hw = shield.width / 2;
  const hh = shield.height / 2;
  const pos = geo.getAttribute('position');
  const uv = geo.getAttribute('uv');
  const arr = uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    arr.setXY(i, pos.getX(i) / (hw * 2) + 0.5, pos.getY(i) / (hh * 2) + 0.5);
  }
  arr.needsUpdate = true;
  return geo;
}

/** Convert emblem from a shield definition to the shared emblem type. */
export function shieldEmblem(shield: ShieldDef): Emblem {
  return shield.emblem;
}

export function mixShieldColors(shield: ShieldDef, tint: number): ShieldDef {
  const t = (tint % 7) / 40;
  return {
    ...shield,
    color: mixHex(shield.color, 0xfff0d8, t * 0.25),
    color2: mixHex(shield.color2, 0x2a1c12, t * 0.3),
  };
}
