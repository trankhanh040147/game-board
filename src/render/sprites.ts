/**
 * FIRST HEARTH — procedural sprite bank
 * -------------------------------------
 * Trees, stumps, citizens, wildlife, caravans, site markers, props, glow and
 * particle textures, plus the cached building sprites produced by
 * buildingSprite.ts. Everything is baked into small offscreen canvases and
 * cached with a byte budget; nothing here is loaded from disk.
 */
import type { BuildingDef, SeasonId } from '../sim/types';
import { drawBuildingArt, buildingSpriteRect, type BuildingArt } from './buildingSprite';
import { Palette, type TreeSpecies } from './palette';
import {
  HALF_H,
  HALF_W,
  clamp,
  clamp01,
  cssColor,
  cssColorAlpha,
  darkenColor,
  hash2,
  hashInt,
  lightenColor,
  makeCanvas,
  mixColor,
  rgb,
} from './utils';

export interface Sprite {
  canvas: HTMLCanvasElement;
  /** map-space offset of the canvas top-left from the sprite anchor */
  x0: number;
  y0: number;
  mapW: number;
  mapH: number;
  scale: number;
  bytes: number;
}

export interface BuildingSprite extends Sprite {
  art: BuildingArt;
}

const TREE_SCALE = 2.2;
const TINY_SCALE = 3;
const MAX_BYTES = 96 * 1024 * 1024;

interface TreeColors {
  dark: number;
  mid: number;
  light: number;
  rim: number;
  trunk: number;
  trunkLit: number;
  bare: boolean;
  blossom: number;
  snow: number;
}

function treeColors(species: TreeSpecies, season: SeasonId, variant = 0): TreeColors {
  const snow = season === 'winter' ? 1 : 0;
  const base: TreeColors = {
    dark: 0x2f4a24,
    mid: 0x3f6a2e,
    light: 0x557f38,
    rim: 0x7fa04a,
    trunk: 0x5a4433,
    trunkLit: 0x7a5c42,
    bare: false,
    blossom: 0xe8c0cc,
    snow,
  };
  switch (species) {
    case 'oak':
      if (season === 'spring') return { ...base, dark: 0x2c4a22, mid: 0x3e6429, light: 0x5f8a36, rim: 0x8fb254, blossom: 0xeec2ce };
      if (season === 'autumn') return { ...base, dark: 0x7a3a1c, mid: 0xa85a24, light: 0xc9822e, rim: 0xe0b45e, blossom: 0 };
      if (season === 'winter') return { ...base, bare: true, trunk: 0x4f4034, trunkLit: 0x6b5a48 };
      return { ...base, dark: 0x223a1b, mid: 0x304f24, light: 0x466b2e, rim: 0x6f9440 };
    case 'pine':
      return {
        ...base,
        dark: 0x1e3227,
        mid: 0x294534,
        light: 0x365840,
        rim: 0x4a7050,
        trunk: 0x4a3a2c,
        trunkLit: 0x634d38,
        bare: false,
        blossom: 0,
      };
    case 'willow':
      if (season === 'autumn') {
        if (variant === 2) return { ...base, dark: 0x6b6a22, mid: 0x8a8a2e, light: 0xa8a83a, rim: 0xc9c46a, blossom: 0 };
        return { ...base, dark: 0x7f6a22, mid: 0xa88a2e, light: 0xc9a83a, rim: 0xe0cc6a, blossom: 0 };
      }
      if (season === 'winter') return { ...base, bare: true, trunk: 0x4f4034, trunkLit: 0x6b5a48 };
      return { ...base, dark: 0x3f5c24, mid: 0x557a2e, light: 0x76973a, rim: 0xa9c25a };
    case 'acacia':
      if (season === 'winter') return { ...base, dark: 0x4a4a2a, mid: 0x5f6034, light: 0x767842, rim: 0x989a5a, blossom: 0 };
      if (season === 'autumn') return { ...base, dark: 0x6b5a24, mid: 0x8a7430, light: 0xa89040, rim: 0xc9b05a, blossom: 0 };
      return { ...base, dark: 0x45521f, mid: 0x5c6f2c, light: 0x77893c, rim: 0x9fb060 };
    case 'palm':
      return {
        ...base,
        dark: 0x26502a,
        mid: 0x357038,
        light: 0x4a8c46,
        rim: 0x76b06a,
        trunk: 0x6b5638,
        trunkLit: 0x8a7048,
        blossom: 0,
      };
    case 'reed':
      if (season === 'winter') return { ...base, dark: 0x8a7a4a, mid: 0xa89458, light: 0xc4b06a, rim: 0xdccb8a, trunk: 0x8a7a4a, trunkLit: 0xa89458 };
      if (season === 'autumn') return { ...base, dark: 0x8a6a2a, mid: 0xa88a3a, light: 0xc4a84a, rim: 0xdccb7a };
      return { ...base, dark: 0x4f6b32, mid: 0x678a3e, light: 0x7fa64a, rim: 0xa9c26a };
    case 'bush':
      if (season === 'winter') return { ...base, dark: 0x5a5040, mid: 0x6b604a, light: 0x7f7358, rim: 0x94886a, bare: true, trunk: 0x5a5040, trunkLit: 0x6b604a };
      if (season === 'autumn') return { ...base, dark: 0x7a4a1c, mid: 0x9a6426, light: 0xb8842e, rim: 0xd4a44a };
      return { ...base, dark: 0x334f22, mid: 0x44682c, light: 0x587f34, rim: 0x7f9f48 };
    case 'snag':
    default:
      return {
        ...base,
        dark: 0x4f4a44,
        mid: 0x6b6660,
        light: 0x8a847a,
        rim: 0xa9a298,
        trunk: 0x4f4a44,
        trunkLit: 0x6b6660,
        bare: true,
        blossom: 0,
      };
  }
}

function drawCanopyBlob(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, color: number, alpha = 1): void {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = alpha >= 1 ? cssColor(color) : cssColorAlpha(color, alpha);
  ctx.fill();
}

function drawTree(ctx: CanvasRenderingContext2D, species: TreeSpecies, variant: number, h: number, c: TreeColors): void {
  const s = h / 34;
  const rnd = (i: number): number => hash2(variant * 131 + i * 17, i * 29 + 7, 193);
  // contact shadow thrown to the south-east (sun from the upper-left)
  ctx.beginPath();
  ctx.ellipse(5.5 * s, 2.4 * s, h * 0.34, h * 0.125, 0, 0, Math.PI * 2);
  ctx.fillStyle = cssColorAlpha(0x11150c, 0.3);
  ctx.fill();

  const trunkH = h * (species === 'pine' ? 0.24 : species === 'palm' ? 0.52 : species === 'willow' ? 0.3 : species === 'acacia' ? 0.46 : species === 'reed' ? 0.2 : 0.4);
  const trunkW = Math.max(1.3, h * 0.05);

  // trunk: dark silhouette + lit left edge
  ctx.beginPath();
  ctx.moveTo(-trunkW, 0);
  ctx.lineTo(-trunkW * 0.62, -trunkH);
  ctx.lineTo(trunkW * 0.62, -trunkH);
  ctx.lineTo(trunkW, 0);
  ctx.closePath();
  ctx.fillStyle = cssColor(c.trunk);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-trunkW, 0);
  ctx.lineTo(-trunkW * 0.62, -trunkH);
  ctx.lineTo(0, -trunkH);
  ctx.lineTo(0, 0);
  ctx.closePath();
  ctx.fillStyle = cssColor(c.trunkLit);
  ctx.fill();
  // root flare
  ctx.beginPath();
  ctx.moveTo(-trunkW * 1.5, 0.6 * s);
  ctx.lineTo(-trunkW * 0.7, -1.6 * s);
  ctx.lineTo(trunkW * 0.7, -1.6 * s);
  ctx.lineTo(trunkW * 1.5, 0.6 * s);
  ctx.closePath();
  ctx.fillStyle = cssColor(darkenColor(c.trunk, 0.18));
  ctx.fill();

  const branch = (bx: number, by: number, tx: number, ty: number, w: number): void => {
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.quadraticCurveTo((bx + tx) / 2 + (rnd(7) - 0.5) * 3 * s, (by + ty) / 2, tx, ty);
    ctx.strokeStyle = cssColor(c.trunk);
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.stroke();
  };

  if (species === 'palm') {
    const topX = trunkW * 0.9;
    const topY = -trunkH;
    // curved trunk
    ctx.beginPath();
    ctx.moveTo(-trunkW, 0);
    ctx.quadraticCurveTo(-trunkW + 2 * s, -trunkH * 0.6, topX - trunkW, topY);
    ctx.lineTo(topX + trunkW, topY);
    ctx.quadraticCurveTo(trunkW + 2 * s, -trunkH * 0.6, trunkW * 1.6, 0);
    ctx.closePath();
    ctx.fillStyle = cssColor(c.trunk);
    ctx.fill();
    for (let i = 1; i < 6; i++) {
      const yy = -trunkH * (i / 6);
      ctx.beginPath();
      ctx.moveTo(-trunkW + 0.4 * s, yy);
      ctx.lineTo(trunkW * 1.3, yy - 0.7 * s);
      ctx.strokeStyle = cssColorAlpha(darkenColor(c.trunk, 0.3), 0.55);
      ctx.lineWidth = 0.7 * s;
      ctx.stroke();
    }
    for (let i = 0; i < 8; i++) {
      const a = -Math.PI * 0.96 + (i / 7) * Math.PI * 0.92 + (rnd(i) - 0.5) * 0.16;
      const len = h * (0.4 + rnd(i + 3) * 0.14);
      const ex = topX + Math.cos(a) * len;
      const ey = topY + Math.sin(a) * len * 0.6;
      // frond spine
      ctx.beginPath();
      ctx.moveTo(topX, topY);
      ctx.quadraticCurveTo(topX + Math.cos(a) * len * 0.55, topY + Math.sin(a) * len * 0.22 - 4 * s, ex, ey);
      ctx.strokeStyle = cssColor(i % 2 ? c.mid : c.dark);
      ctx.lineWidth = 1.7 * s;
      ctx.stroke();
      // leaflets
      for (let k = 1; k <= 4; k++) {
        const u = k / 5;
        const px = topX + (ex - topX) * u;
        const py = topY + (ey - topY) * u - Math.sin(u * Math.PI) * 2.4 * s;
        const ll = (3.6 - k * 0.5) * s;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + ll * 0.7, py + ll * 0.9);
        ctx.strokeStyle = cssColor(i % 2 ? c.light : c.mid);
        ctx.lineWidth = 0.8 * s;
        ctx.stroke();
      }
    }
    drawCanopyBlob(ctx, topX, topY, 2.4 * s, 1.8 * s, c.dark);
    return;
  }

  if (species === 'pine') {
    const tiers = 5;
    const baseW = h * 0.32;
    for (let i = 0; i < tiers; i++) {
      const u = i / tiers;
      const y = -trunkH - u * (h - trunkH) * 0.94;
      const w = baseW * (1 - u * 0.78) + 2 * s;
      const tierH = (h - trunkH) * 0.3;
      ctx.beginPath();
      ctx.moveTo(-w, y);
      ctx.lineTo(-w * 0.58, y - tierH * 0.32);
      ctx.lineTo(0, y - tierH);
      ctx.lineTo(w * 0.58, y - tierH * 0.32);
      ctx.lineTo(w, y);
      ctx.lineTo(w * 0.35, y - 1.4 * s);
      ctx.lineTo(-w * 0.35, y - 1.4 * s);
      ctx.closePath();
      ctx.fillStyle = cssColor(i % 2 === 0 ? c.mid : c.dark);
      ctx.fill();
      // lit left edge + needle streaks
      ctx.beginPath();
      ctx.moveTo(-w, y);
      ctx.lineTo(0, y - tierH);
      ctx.lineTo(-w * 0.25, y - tierH * 0.5);
      ctx.closePath();
      ctx.fillStyle = cssColorAlpha(c.light, 0.5);
      ctx.fill();
      // snow on the tiers
      if (c.snow > 0) {
        ctx.beginPath();
        ctx.moveTo(-w * 0.9, y - tierH * 0.06);
        ctx.lineTo(0, y - tierH * 0.94);
        ctx.lineTo(w * 0.62, y - tierH * 0.2);
        ctx.lineTo(w * 0.24, y - tierH * 0.22);
        ctx.closePath();
        ctx.fillStyle = cssColorAlpha(0xeef4f8, 0.5);
        ctx.fill();
      }
    }
    return;
  }

  if (species === 'reed') {
    const stalks = 6 + Math.floor(rnd(1) * 3);
    for (let i = 0; i < stalks; i++) {
      const sx = (i - stalks / 2) * 2.4 * s + (rnd(i) - 0.5) * 2 * s;
      const sh = h * (0.5 + rnd(i + 2) * 0.5);
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.quadraticCurveTo(sx + 1.4 * s, -sh * 0.6, sx + (rnd(i + 5) - 0.5) * 4 * s, -sh);
      ctx.strokeStyle = cssColor(i % 3 === 0 ? c.mid : c.dark);
      ctx.lineWidth = 1.1 * s;
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(sx + (rnd(i + 5) - 0.5) * 4 * s, -sh - 1.4 * s, 1.1 * s, 2.6 * s, 0, 0, Math.PI * 2);
      ctx.fillStyle = cssColor(mixColor(c.rim, 0x6b4a2f, 0.45));
      ctx.fill();
    }
    for (let i = 0; i < 5; i++) {
      const sx = (rnd(i + 9) - 0.5) * 9 * s;
      ctx.beginPath();
      ctx.moveTo(sx, 1);
      ctx.quadraticCurveTo(sx + 2 * s, -3 * s, sx + 3.4 * s, -6 * s);
      ctx.strokeStyle = cssColor(c.light);
      ctx.lineWidth = 0.8 * s;
      ctx.stroke();
    }
    return;
  }

  if (species === 'bush') {
    for (let i = 0; i < 4; i++) {
      const bx = (i - 1.5) * 3.2 * s + (rnd(i) - 0.5) * 2 * s;
      const by = -h * (0.2 + rnd(i) * 0.14);
      drawCanopyBlob(ctx, bx, by, h * 0.22, h * 0.18, i % 2 ? c.mid : c.dark);
    }
    drawCanopyBlob(ctx, -2.4 * s, -h * 0.4, h * 0.15, h * 0.12, c.light);
    drawCanopyBlob(ctx, -3.4 * s, -h * 0.44, h * 0.07, h * 0.05, c.rim, 0.8);
    return;
  }

  if (c.bare) {
    const tips: [number, number][] = [
      [-h * 0.32, -trunkH - h * 0.28],
      [h * 0.28, -trunkH - h * 0.36],
      [-h * 0.15, -trunkH - h * 0.5],
      [h * 0.15, -trunkH - h * 0.58],
      [0, -trunkH - h * 0.68],
      [h * 0.4, -trunkH - h * 0.18],
      [-h * 0.42, -trunkH - h * 0.16],
    ];
    for (let i = 0; i < tips.length; i++) {
      branch(0, -trunkH * (0.7 + (i % 3) * 0.1), tips[i][0], tips[i][1], Math.max(0.8, (1.7 - i * 0.12) * s));
    }
    if (c.snow > 0) {
      for (const [tx, ty] of tips) drawCanopyBlob(ctx, tx, ty - 0.8, 2.0 * s, 0.85 * s, 0xeef4f8, 0.55);
    }
    return;
  }

  if (species === 'willow') {
    const cy = -trunkH - h * 0.2;
    for (let i = 0; i < 5; i++) {
      const bx = (rnd(i) - 0.5) * h * 0.4;
      const by = cy + (rnd(i + 4) - 0.5) * h * 0.14;
      drawCanopyBlob(ctx, bx, by, h * 0.18, h * 0.14, i % 2 ? c.dark : c.mid);
    }
    drawCanopyBlob(ctx, -h * 0.14, cy - h * 0.08, h * 0.16, h * 0.11, c.light);
    drawCanopyBlob(ctx, -h * 0.2, cy - h * 0.12, h * 0.07, h * 0.05, c.rim, 0.85);
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * Math.PI - Math.PI * 0.03;
      const sx = Math.cos(a) * h * 0.26;
      const sy = cy + Math.sin(a) * h * 0.1;
      const len = h * (0.18 + rnd(i) * 0.26);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(sx * 1.18, sy + len * 0.62, sx * 1.02, sy + len);
      ctx.strokeStyle = cssColor(i % 3 === 0 ? c.light : c.mid);
      ctx.lineWidth = 1.0 * s;
      ctx.stroke();
    }
    return;
  }

  if (species === 'acacia') {
    branch(0, -trunkH * 0.8, -h * 0.18, -trunkH - h * 0.14, 1.4 * s);
    branch(0, -trunkH * 0.8, h * 0.18, -trunkH - h * 0.17, 1.4 * s);
    const cy = -trunkH - h * 0.19;
    for (let i = 0; i < 5; i++) {
      drawCanopyBlob(ctx, (rnd(i) - 0.5) * h * 0.62, cy + (rnd(i + 3) - 0.5) * h * 0.08, h * 0.19, h * 0.07, i % 2 ? c.dark : c.mid);
    }
    drawCanopyBlob(ctx, -h * 0.12, cy - h * 0.05, h * 0.14, h * 0.05, c.light);
    drawCanopyBlob(ctx, h * 0.06, cy - h * 0.03, h * 0.1, h * 0.04, c.rim, 0.8);
    return;
  }

  // oak / default: layered irregular canopy with a sunlit crown
  const cy = -trunkH - h * 0.2;
  const canopyR = h * 0.29;
  branch(0, -trunkH * 0.85, -h * 0.12, cy + h * 0.08, 1.5 * s);
  branch(0, -trunkH * 0.85, h * 0.14, cy + h * 0.1, 1.4 * s);
  // dark silhouette
  const lobes: [number, number, number][] = [
    [-0.72, 0.18, 0.56],
    [-0.32, -0.42, 0.62],
    [0.18, -0.5, 0.58],
    [0.66, -0.1, 0.52],
    [0.34, 0.34, 0.56],
    [-0.22, 0.46, 0.5],
    [0.02, 0.02, 0.66],
  ];
  for (const [lx, ly, lr] of lobes) {
    drawCanopyBlob(ctx, canopyR * lx, cy + canopyR * ly, canopyR * lr, canopyR * lr * 0.9, c.dark);
  }
  // mid layer, shifted up-left toward the sun
  for (let i = 0; i < lobes.length - 2; i++) {
    const [lx, ly, lr] = lobes[i];
    drawCanopyBlob(ctx, canopyR * lx - 1.4 * s, cy + canopyR * ly - 2.2 * s, canopyR * lr * 0.78, canopyR * lr * 0.7, i % 2 ? c.mid : c.dark);
  }
  // lit crown
  drawCanopyBlob(ctx, -canopyR * 0.34, cy - canopyR * 0.36, canopyR * 0.52, canopyR * 0.42, c.mid);
  drawCanopyBlob(ctx, -canopyR * 0.42, cy - canopyR * 0.46, canopyR * 0.36, canopyR * 0.28, c.light);
  drawCanopyBlob(ctx, -canopyR * 0.5, cy - canopyR * 0.52, canopyR * 0.2, canopyR * 0.15, c.rim);
  drawCanopyBlob(ctx, canopyR * 0.18, cy - canopyR * 0.5, canopyR * 0.22, canopyR * 0.15, lightenColor(c.light, 0.12));
  // sharp dark underside so the canopy sits on the trunk
  drawCanopyBlob(ctx, canopyR * 0.05, cy + canopyR * 0.52, canopyR * 0.5, canopyR * 0.18, darkenColor(c.dark, 0.2), 0.75);
  // leaf specks / edge leaves
  for (let i = 0; i < 12; i++) {
    const a = rnd(i) * Math.PI * 2;
    const rr = canopyR * (0.55 + rnd(i + 4) * 0.5);
    drawCanopyBlob(ctx, Math.cos(a) * rr - 1.2 * s, cy + Math.sin(a) * rr * 0.8, 1.3 * s, 1.0 * s, i % 3 === 0 ? c.rim : c.mid, 0.9);
  }
  // spring blossom: a few tiny pale blooms, not white blobs
  if (c.blossom && variant === 0) {
    for (let i = 0; i < 7; i++) {
      const a = rnd(i + 11) * Math.PI * 2;
      const rr = canopyR * (0.2 + rnd(i + 21) * 0.65);
      drawCanopyBlob(ctx, Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.7 - canopyR * 0.12, 0.62 * s, 0.5 * s, c.blossom, 0.6);
    }
  }
  void s;
}

function drawStump(ctx: CanvasRenderingContext2D, h: number, c: TreeColors): void {
  const s = h / 34;
  ctx.beginPath();
  ctx.ellipse(0, 2 * s, 9 * s, 4 * s, 0, 0, Math.PI * 2);
  ctx.fillStyle = cssColorAlpha(0x0a0806, 0.25);
  ctx.fill();
  // trunk stub
  ctx.beginPath();
  ctx.moveTo(-3.4 * s, 0);
  ctx.lineTo(-3.4 * s, -4.5 * s);
  ctx.lineTo(0, -5.5 * s);
  ctx.lineTo(3.4 * s, -4.5 * s);
  ctx.lineTo(3.4 * s, 0);
  ctx.closePath();
  ctx.fillStyle = cssColor(c.trunk);
  ctx.fill();
  // cut face with rings
  ctx.beginPath();
  ctx.ellipse(0, -5.2 * s, 3.4 * s, 1.5 * s, 0, 0, Math.PI * 2);
  ctx.fillStyle = cssColor(lightenColor(c.trunk, 0.25));
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(0, -5.2 * s, 1.8 * s, 0.8 * s, 0, 0, Math.PI * 2);
  ctx.strokeStyle = cssColorAlpha(darkenColor(c.trunk, 0.3), 0.8);
  ctx.lineWidth = 0.6 * s;
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Small actors
// ---------------------------------------------------------------------------

const SKIN = [0xe0b48c, 0xc9946a, 0xa9764f, 0x8a5c3a, 0xf0c9a4, 0xb98a62];

function drawCitizen(ctx: CanvasRenderingContext2D, classId: string, sex: 'm' | 'f', frame: number, seed: number): void {
  const s = 1;
  const skin = SKIN[seed % SKIN.length];
  const cloth = classId === 'artisan' ? 0x5f7f9a : classId === 'scholar' ? 0x6b5a8a : classId === 'merchant' ? 0x9e5a3a : 0x8a6a4a;
  const clothLit = lightenColor(cloth, 0.16);
  // shadow
  ctx.beginPath();
  ctx.ellipse(0, 0.5, 4.4, 1.7, 0, 0, Math.PI * 2);
  ctx.fillStyle = cssColorAlpha(0x0a0806, 0.3);
  ctx.fill();
  const step = frame === 1 ? 1.4 : frame === 3 ? -1.4 : 0;
  const bob = frame === 1 || frame === 3 ? -0.5 : 0;
  // legs
  ctx.strokeStyle = cssColor(darkenColor(cloth, 0.35));
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(-1.1, -3.4);
  ctx.lineTo(-1.5 + step * 0.5, -0.6);
  ctx.moveTo(1.1, -3.4);
  ctx.lineTo(1.5 - step * 0.5, -0.6);
  ctx.stroke();
  // body
  ctx.beginPath();
  ctx.moveTo(-2.3, -3.2 + bob);
  ctx.lineTo(-1.9, -8.2 + bob);
  ctx.lineTo(1.9, -8.2 + bob);
  ctx.lineTo(2.3, -3.2 + bob);
  ctx.closePath();
  ctx.fillStyle = cssColor(cloth);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-2.3, -3.2 + bob);
  ctx.lineTo(-1.9, -8.2 + bob);
  ctx.lineTo(0, -8.2 + bob);
  ctx.lineTo(0, -3.2 + bob);
  ctx.closePath();
  ctx.fillStyle = cssColor(clothLit);
  ctx.fill();
  // belt
  ctx.fillStyle = cssColor(darkenColor(cloth, 0.45));
  ctx.fillRect(-2.1, -4.6 + bob, 4.2, 0.9);
  // arms
  ctx.strokeStyle = cssColor(clothLit);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-1.9, -7.6 + bob);
  ctx.lineTo(-3.1 + step * 0.7, -4.8 + bob);
  ctx.moveTo(1.9, -7.6 + bob);
  ctx.lineTo(3.1 - step * 0.7, -4.8 + bob);
  ctx.stroke();
  // head
  ctx.beginPath();
  ctx.arc(0, -9.6 + bob, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = cssColor(skin);
  ctx.fill();
  // hair
  ctx.beginPath();
  ctx.arc(0, -10 + bob, 2.5, Math.PI * 1.02, Math.PI * 2.02);
  ctx.fillStyle = cssColor(sex === 'm' ? 0x4a3a2c : 0x6b4a30);
  ctx.fill();
  if (sex === 'f') {
    ctx.beginPath();
    ctx.ellipse(0, -8.6 + bob, 1.9, 1.4, 0, 0, Math.PI * 2);
    ctx.fillStyle = cssColor(sex === 'f' ? 0x6b4a30 : 0x4a3a2c);
    ctx.fill();
  }
}

function drawDeer(ctx: CanvasRenderingContext2D, frame: number, seed: number): void {
  const s = 1;
  const body = 0x8a6a44;
  const bodyLit = 0xa98a5c;
  ctx.beginPath();
  ctx.ellipse(0, 0.5, 7, 2, 0, 0, Math.PI * 2);
  ctx.fillStyle = cssColorAlpha(0x0a0806, 0.28);
  ctx.fill();
  const step = frame % 2 === 0 ? 1.2 : -1.2;
  ctx.strokeStyle = cssColor(darkenColor(body, 0.3));
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(-4, -4);
  ctx.lineTo(-4 + step * 0.6, 0);
  ctx.moveTo(-2.4, -4);
  ctx.lineTo(-2.4 - step * 0.6, 0);
  ctx.moveTo(3.4, -4);
  ctx.lineTo(3.4 + step * 0.6, 0);
  ctx.moveTo(4.8, -4);
  ctx.lineTo(4.8 - step * 0.6, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(0, -6, 6, 3.4, 0, 0, Math.PI * 2);
  ctx.fillStyle = cssColor(body);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(-1, -7, 4.6, 2.2, 0, 0, Math.PI * 2);
  ctx.fillStyle = cssColor(bodyLit);
  ctx.fill();
  // neck + head
  ctx.beginPath();
  ctx.moveTo(4, -7);
  ctx.lineTo(7.5, -12);
  ctx.lineTo(9.2, -11.4);
  ctx.lineTo(5.6, -5.6);
  ctx.closePath();
  ctx.fillStyle = cssColor(body);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(8.6, -12.4, 2.4, 1.6, -0.3, 0, Math.PI * 2);
  ctx.fillStyle = cssColor(bodyLit);
  ctx.fill();
  // antlers
  if (seed % 2 === 0) {
    ctx.strokeStyle = cssColor(0xd9c8a8);
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(8.4, -13.4);
    ctx.lineTo(7.6, -17.5);
    ctx.moveTo(7.9, -15.4);
    ctx.lineTo(6.4, -16.6);
    ctx.moveTo(9.6, -13.8);
    ctx.lineTo(10.6, -17.2);
    ctx.stroke();
  }
  // tail
  ctx.beginPath();
  ctx.ellipse(-5.6, -6.6, 1.2, 1.8, 0.4, 0, Math.PI * 2);
  ctx.fillStyle = cssColor(0xf0e4cd);
  ctx.fill();
}

function drawBird(ctx: CanvasRenderingContext2D, frame: number): void {
  ctx.strokeStyle = cssColor(0x2a241c);
  ctx.lineWidth = 1.1;
  ctx.lineCap = 'round';
  const up = frame === 1 ? -3 : frame === 3 ? 1 : -1;
  ctx.beginPath();
  ctx.moveTo(-5, 0);
  ctx.quadraticCurveTo(-2.5, up, 0, 0);
  ctx.quadraticCurveTo(2.5, up, 5, 0);
  ctx.stroke();
}

function drawCart(ctx: CanvasRenderingContext2D, seed: number): void {
  const wood = 0x6b4a2f;
  const woodLit = 0x8a6440;
  ctx.beginPath();
  ctx.ellipse(0, 0.5, 12, 2.6, 0, 0, Math.PI * 2);
  ctx.fillStyle = cssColorAlpha(0x0a0806, 0.26);
  ctx.fill();
  // wheels
  for (const wx of [-4, 5]) {
    ctx.beginPath();
    ctx.arc(wx, -3.6, 3.4, 0, Math.PI * 2);
    ctx.strokeStyle = cssColor(darkenColor(wood, 0.3));
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(wx, -3.6, 0.8, 0, Math.PI * 2);
    ctx.fillStyle = cssColor(woodLit);
    ctx.fill();
  }
  // bed
  ctx.beginPath();
  ctx.moveTo(-7, -6.4);
  ctx.lineTo(7, -6.4);
  ctx.lineTo(6.4, -3.4);
  ctx.lineTo(-6.4, -3.4);
  ctx.closePath();
  ctx.fillStyle = cssColor(wood);
  ctx.fill();
  // cargo
  ctx.beginPath();
  ctx.ellipse(-1, -8, 4.4, 2.6, 0, 0, Math.PI * 2);
  ctx.fillStyle = cssColor(mixColor(woodLit, 0xc9b98a, 0.5));
  ctx.fill();
  ctx.strokeStyle = cssColor(darkenColor(wood, 0.2));
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(-5, -9);
  ctx.lineTo(3, -9);
  ctx.stroke();
  // ox / horse in front
  ctx.strokeStyle = cssColor(0x4a3a2c);
  ctx.lineWidth = 1.2;
  const step = seed % 2 === 0 ? 1 : -1;
  ctx.beginPath();
  ctx.moveTo(10, -4);
  ctx.lineTo(10 + step * 0.8, 0);
  ctx.moveTo(13, -4);
  ctx.lineTo(13 - step * 0.8, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(11.4, -6.4, 3.6, 2.2, 0, 0, Math.PI * 2);
  ctx.fillStyle = cssColor(0x6b5638);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(14.6, -8.6, 1.6, 1.1, -0.3, 0, Math.PI * 2);
  ctx.fillStyle = cssColor(0x7a6440);
  ctx.fill();
  // driver
  ctx.beginPath();
  ctx.arc(-8, -10.6, 1.5, 0, Math.PI * 2);
  ctx.fillStyle = cssColor(0xd9b08a);
  ctx.fill();
  ctx.fillStyle = cssColor(0x6b4a2f);
  ctx.fillRect(-9.2, -9.4, 2.4, 3.2);
}

function drawExpedition(ctx: CanvasRenderingContext2D, seed: number): void {
  // two walking figures + banner
  const cloth = 0x5f6a4a;
  ctx.beginPath();
  ctx.ellipse(0, 0.5, 9, 2.2, 0, 0, Math.PI * 2);
  ctx.fillStyle = cssColorAlpha(0x0a0806, 0.28);
  ctx.fill();
  for (let i = 0; i < 2; i++) {
    const x = i === 0 ? -3.4 : 2.6;
    const bob = (seed + i) % 2 === 0 ? 0 : -0.6;
    ctx.strokeStyle = cssColor(0x3a3028);
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(x - 0.8, -3.4 + bob);
    ctx.lineTo(x - 1.4, 0);
    ctx.moveTo(x + 0.8, -3.4 + bob);
    ctx.lineTo(x + 1.4, 0);
    ctx.stroke();
    ctx.fillStyle = cssColor(i === 0 ? cloth : 0x6b5a3a);
    ctx.fillRect(x - 1.6, -8 + bob, 3.2, 4.6);
    ctx.beginPath();
    ctx.arc(x, -9.6 + bob, 1.6, 0, Math.PI * 2);
    ctx.fillStyle = cssColor(0xd9b08a);
    ctx.fill();
    // pack
    ctx.fillStyle = cssColor(0x8a5a3a);
    ctx.fillRect(x - 2.8, -7.4 + bob, 1.6, 3);
  }
  // banner pole
  ctx.strokeStyle = cssColor(0x5a4433);
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(6.4, 0);
  ctx.lineTo(6.4, -15);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(6.6, -15);
  ctx.lineTo(13, -13.4);
  ctx.lineTo(6.6, -11.8);
  ctx.closePath();
  ctx.fillStyle = cssColor(0xc9a55b);
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Site markers
// ---------------------------------------------------------------------------

function drawSiteMarker(ctx: CanvasRenderingContext2D, kind: string, color: number, t = 0): void {
  const stone = 0x8a8478;
  const stoneLit = 0xa9a298;
  switch (kind) {
    case 'ruin': {
      // broken columns + fallen blocks
      for (let i = 0; i < 3; i++) {
        const x = -8 + i * 7;
        const h = 10 + (i % 2) * 6;
        ctx.fillStyle = cssColor(i === 1 ? stoneLit : stone);
        ctx.fillRect(x, -h, 4, h);
        ctx.fillStyle = cssColor(lightenColor(stone, 0.1));
        ctx.fillRect(x, -h - 1.4, 4, 1.4);
      }
      ctx.fillStyle = cssColor(darkenColor(stone, 0.15));
      ctx.fillRect(-4, 0, 7, 2.6);
      ctx.fillRect(4, 1.4, 5, 2);
      break;
    }
    case 'shrine': {
      // stone plinth + gem
      ctx.fillStyle = cssColor(stone);
      ctx.fillRect(-6, -4, 12, 4);
      ctx.fillStyle = cssColor(stoneLit);
      ctx.fillRect(-4.4, -9, 8.8, 5);
      ctx.beginPath();
      ctx.moveTo(0, -17);
      ctx.lineTo(3, -12.4);
      ctx.lineTo(0, -8);
      ctx.lineTo(-3, -12.4);
      ctx.closePath();
      ctx.fillStyle = cssColor(mixColor(color, 0xffffff, 0.25));
      ctx.fill();
      break;
    }
    case 'grove': {
      // little sacred grove
      for (let i = 0; i < 3; i++) {
        const x = -8 + i * 7;
        ctx.strokeStyle = cssColor(0x4a3a2c);
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, -8);
        ctx.stroke();
        ctx.beginPath();
        ctx.ellipse(x, -11, 6, 4.4, 0, 0, Math.PI * 2);
        ctx.fillStyle = cssColor(i === 1 ? 0x4f7f3a : 0x3f6a30);
        ctx.fill();
      }
      break;
    }
    case 'spring': {
      // pool + stones
      ctx.beginPath();
      ctx.ellipse(0, -1, 11, 5, 0, 0, Math.PI * 2);
      ctx.fillStyle = cssColor(mixColor(color, 0x2a6b8a, 0.5));
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(-2, -2, 5, 2, 0, 0, Math.PI * 2);
      ctx.fillStyle = cssColorAlpha(0xbfe6f2, 0.4);
      ctx.fill();
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        ctx.beginPath();
        ctx.ellipse(Math.cos(a) * 11, -1 + Math.sin(a) * 5, 2.2, 1.4, 0, 0, Math.PI * 2);
        ctx.fillStyle = cssColor(stone);
        ctx.fill();
      }
      break;
    }
    case 'cave': {
      // rock arch
      ctx.beginPath();
      ctx.ellipse(0, -2, 13, 9, 0, Math.PI, Math.PI * 2);
      ctx.fillStyle = cssColor(0x6b655c);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-6, -1);
      ctx.quadraticCurveTo(0, -12, 6, -1);
      ctx.lineTo(6, 0);
      ctx.lineTo(-6, 0);
      ctx.closePath();
      ctx.fillStyle = cssColor(0x14100c);
      ctx.fill();
      break;
    }
    case 'crater': {
      // scorched ring with glow
      ctx.beginPath();
      ctx.ellipse(0, -1, 14, 7, 0, 0, Math.PI * 2);
      ctx.fillStyle = cssColor(0x3a3230);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(0, -1.6, 8, 4, 0, 0, Math.PI * 2);
      ctx.fillStyle = cssColor(0x14100c);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(0, -2, 3.4, 1.8, 0, 0, Math.PI * 2);
      ctx.fillStyle = cssColorAlpha(mixColor(color, 0xff9d4d, 0.6), 0.8);
      ctx.fill();
      break;
    }
    case 'wreck': {
      // broken hull
      ctx.beginPath();
      ctx.moveTo(-13, -3);
      ctx.quadraticCurveTo(0, 6, 13, -3);
      ctx.lineTo(9, -6);
      ctx.quadraticCurveTo(0, 0, -9, -6);
      ctx.closePath();
      ctx.fillStyle = cssColor(0x5a4632);
      ctx.fill();
      ctx.strokeStyle = cssColor(0x3a2c1e);
      ctx.lineWidth = 1;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(-8 + i * 3, -4.4);
        ctx.lineTo(-6 + i * 3, -1);
        ctx.stroke();
      }
      ctx.strokeStyle = cssColor(0x8a6440);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(0, -4);
      ctx.lineTo(3, -16);
      ctx.stroke();
      break;
    }
    case 'observatory': {
      // stone ring + telescope mast
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        ctx.fillStyle = cssColor(i % 2 ? stoneLit : stone);
        ctx.fillRect(Math.cos(a) * 11 - 1, Math.sin(a) * 5.4 - 2, 2.4, 3);
      }
      ctx.beginPath();
      ctx.ellipse(0, -1, 7, 3.4, 0, 0, Math.PI * 2);
      ctx.fillStyle = cssColor(0x3a3a40);
      ctx.fill();
      ctx.strokeStyle = cssColor(0xc9a55b);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(-2, -2);
      ctx.lineTo(6, -18);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(6, -18, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = cssColorAlpha(0xffe0a0, 0.9);
      ctx.fill();
      break;
    }
    default: {
      // wonder / obelisk
      ctx.beginPath();
      ctx.moveTo(-3, 0);
      ctx.lineTo(-1.6, -20);
      ctx.lineTo(0, -24);
      ctx.lineTo(1.6, -20);
      ctx.lineTo(3, 0);
      ctx.closePath();
      ctx.fillStyle = cssColor(mixColor(0xd4af37, color, 0.3));
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0, -24);
      ctx.lineTo(1.6, -20);
      ctx.lineTo(0, -18);
      ctx.lineTo(-1.6, -20);
      ctx.closePath();
      ctx.fillStyle = cssColor(0xfff0c0);
      ctx.fill();
      break;
    }
  }
  void t;
}

// ---------------------------------------------------------------------------
// Sprite bank
// ---------------------------------------------------------------------------

export class SpriteBank {
  palette: Palette;
  private trees = new Map<string, Sprite>();
  private buildings = new Map<string, BuildingSprite>();
  private misc = new Map<string, Sprite>();
  private bytes = 0;
  private buildingScale = 1.5;
  private buildingSeason: SeasonId = 'summer';
  private snowBucket = 0;
  buildingCount = 0;

  constructor(palette: Palette) {
    this.palette = palette;
  }

  get bytesUsed(): number {
    return this.bytes;
  }

  /** Building sprites are baked at the zoom-appropriate texel density. */
  setBuildingScale(scale: number): void {
    const next = clamp(scale, 1, 3);
    if (Math.abs(next - this.buildingScale) < 0.2) return;
    this.buildingScale = next;
    this.dropBuildings();
  }

  setSeason(season: SeasonId, snow: number): void {
    const snowBucket = Math.round(clamp01(snow) * 5);
    if (season === this.buildingSeason && snowBucket === this.snowBucket) return;
    this.buildingSeason = season;
    this.snowBucket = snowBucket;
    this.dropBuildings();
  }

  private dropBuildings(): void {
    for (const s of this.buildings.values()) this.bytes -= s.bytes;
    this.buildings.clear();
    this.buildingCount = 0;
  }

  reset(): void {
    this.trees.clear();
    this.buildings.clear();
    this.misc.clear();
    this.bytes = 0;
  }

  private account(bytes: number): void {
    this.bytes += bytes;
    if (this.bytes <= MAX_BYTES) return;
    // evict the cheapest-to-rebuild caches first
    for (const s of this.trees.values()) this.bytes -= s.bytes;
    this.trees.clear();
    if (this.bytes > MAX_BYTES) {
      for (const s of this.buildings.values()) this.bytes -= s.bytes;
      this.buildings.clear();
    }
    if (this.bytes > MAX_BYTES) {
      for (const s of this.misc.values()) this.bytes -= s.bytes;
      this.misc.clear();
    }
  }

  private make(key: string, cache: Map<string, Sprite>, x0: number, y0: number, mapW: number, mapH: number, scale: number, draw: (ctx: CanvasRenderingContext2D) => void): Sprite {
    const canvas = makeCanvas(mapW * scale, mapH * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable');
    ctx.setTransform(scale, 0, 0, scale, -x0 * scale, -y0 * scale);
    ctx.imageSmoothingEnabled = true;
    draw(ctx);
    const bytes = canvas.width * canvas.height * 4;
    const sprite: Sprite = { canvas, x0, y0, mapW, mapH, scale, bytes };
    cache.set(key, sprite);
    this.account(bytes);
    return sprite;
  }

  // -- trees ---------------------------------------------------------------

  tree(species: TreeSpecies, variant: number, sizeClass: number, season: SeasonId): Sprite {
    const key = `${species}|${variant}|${sizeClass}|${season}`;
    const hit = this.trees.get(key);
    if (hit) return hit;
    const h = [28, 38, 49][sizeClass] ?? 38;
    const w = [36, 48, 60][sizeClass] ?? 48;
    const y0 = -(h + 14);
    const mapH = h + 14 + 8;
    const c = treeColors(species, season, variant);
    return this.make(key, this.trees, -w * 0.5, y0, w, mapH, TREE_SCALE, (ctx) => {
      drawTree(ctx, species, variant, h, c);
    });
  }

  stump(species: TreeSpecies, season: SeasonId): Sprite {
    const key = `stump|${species}|${season}`;
    const hit = this.trees.get(key);
    if (hit) return hit;
    const h = 24;
    const c = treeColors(species, season, 0);
    return this.make(key, this.trees, -16, -26, 32, 34, TREE_SCALE, (ctx) => {
      drawStump(ctx, h, c);
    });
  }

  // -- buildings -----------------------------------------------------------

  building(def: BuildingDef, condition: number): BuildingSprite {
    const condBucket = condition > 0.72 ? 2 : condition > 0.38 ? 1 : 0;
    const key = `${def.id}|${this.buildingScale.toFixed(2)}|${condBucket}|${this.buildingSeason}|${this.snowBucket}`;
    const hit = this.buildings.get(key);
    if (hit) return hit;
    const rect = buildingSpriteRect(def);
    const canvas = makeCanvas(rect.mapW * this.buildingScale, rect.mapH * this.buildingScale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable');
    ctx.setTransform(this.buildingScale, 0, 0, this.buildingScale, -rect.x0 * this.buildingScale, -rect.y0 * this.buildingScale);
    ctx.imageSmoothingEnabled = true;
    const { art } = drawBuildingArt(ctx, def, {
      scale: this.buildingScale,
      condition,
      season: this.buildingSeason,
      snow: this.snowBucket / 5,
    });
    const bytes = canvas.width * canvas.height * 4;
    const sprite: BuildingSprite = { canvas, x0: rect.x0, y0: rect.y0, mapW: rect.mapW, mapH: rect.mapH, scale: this.buildingScale, bytes, art };
    this.buildings.set(key, sprite);
    this.account(bytes);
    this.buildingCount = this.buildings.size;
    return sprite;
  }

  // -- actors --------------------------------------------------------------

  citizen(classId: string, sex: 'm' | 'f', frame: number, seed: number): Sprite {
    const key = `cit|${classId}|${sex}|${frame}|${seed % SKIN.length}`;
    const hit = this.misc.get(key);
    if (hit) return hit;
    return this.make(key, this.misc, -8, -16, 16, 20, TINY_SCALE, (ctx) => {
      drawCitizen(ctx, classId, sex, frame, seed);
    });
  }

  deer(frame: number, variant: number): Sprite {
    const key = `deer|${frame}|${variant}`;
    const hit = this.misc.get(key);
    if (hit) return hit;
    return this.make(key, this.misc, -14, -20, 28, 24, TINY_SCALE, (ctx) => {
      drawDeer(ctx, frame, variant);
    });
  }

  bird(frame: number): Sprite {
    const key = `bird|${frame}`;
    const hit = this.misc.get(key);
    if (hit) return hit;
    return this.make(key, this.misc, -6, -5, 12, 10, TINY_SCALE, (ctx) => {
      drawBird(ctx, frame);
    });
  }

  cart(variant: number): Sprite {
    const key = `cart|${variant}`;
    const hit = this.misc.get(key);
    if (hit) return hit;
    return this.make(key, this.misc, -12, -14, 30, 18, TINY_SCALE, (ctx) => {
      drawCart(ctx, variant);
    });
  }

  expedition(variant: number): Sprite {
    const key = `exp|${variant}`;
    const hit = this.misc.get(key);
    if (hit) return hit;
    return this.make(key, this.misc, -12, -20, 28, 24, TINY_SCALE, (ctx) => {
      drawExpedition(ctx, variant);
    });
  }

  site(kind: string, color: number): Sprite {
    const key = `site|${kind}|${color}`;
    const hit = this.misc.get(key);
    if (hit) return hit;
    return this.make(key, this.misc, -20, -30, 40, 40, 2, (ctx) => {
      drawSiteMarker(ctx, kind, color);
    });
  }

  /** Rock / ore outcrop for a deposit; colour follows the resource. */
  deposit(color: number, sizeClass: number): Sprite {
    const key = `dep|${color}|${sizeClass}`;
    const hit = this.misc.get(key);
    if (hit) return hit;
    const w = 22 + sizeClass * 8;
    const h = 14 + sizeClass * 5;
    return this.make(key, this.misc, -w * 0.5, -h - 4, w, h + 10, 2, (ctx) => {
      const rockDark = mixColor(0x5a5248, color, 0.35);
      const rockLit = mixColor(0x8a8274, color, 0.4);
      ctx.beginPath();
      ctx.ellipse(0, 2, w * 0.45, 3.2, 0, 0, Math.PI * 2);
      ctx.fillStyle = cssColorAlpha(0x0a0806, 0.25);
      ctx.fill();
      // cluster of angular rocks
      const rocks: [number, number, number, number][] = [
        [-w * 0.22, 0, w * 0.24, h * 0.7],
        [w * 0.1, 1, w * 0.28, h * 0.86],
        [w * 0.32, 3, w * 0.16, h * 0.5],
      ];
      for (let i = 0; i < rocks.length; i++) {
        const [rx, ry, rw, rh] = rocks[i];
        ctx.beginPath();
        ctx.moveTo(rx - rw, ry);
        ctx.lineTo(rx - rw * 0.5, ry - rh);
        ctx.lineTo(rx + rw * 0.3, ry - rh * 0.92);
        ctx.lineTo(rx + rw, ry - rh * 0.2);
        ctx.lineTo(rx + rw * 0.7, ry);
        ctx.closePath();
        ctx.fillStyle = cssColor(i === 1 ? rockLit : rockDark);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(rx - rw * 0.5, ry - rh);
        ctx.lineTo(rx + rw * 0.3, ry - rh * 0.92);
        ctx.lineTo(rx + rw * 0.1, ry - rh * 0.55);
        ctx.closePath();
        ctx.fillStyle = cssColorAlpha(lightenColor(rockLit, 0.12), 1);
        ctx.fill();
      }
      // ore glints
      const glint = mixColor(color, 0xffffff, 0.45);
      for (let i = 0; i < 4; i++) {
        const gx = (hash2(i, 3, 7) - 0.5) * w * 0.7;
        const gy = -hash2(i, 5, 9) * h * 0.6 + 1;
        ctx.beginPath();
        ctx.arc(gx, gy, 0.9, 0, Math.PI * 2);
        ctx.fillStyle = cssColor(glint);
        ctx.fill();
      }
    });
  }

  // -- textures ------------------------------------------------------------

  /** Soft radial glow, cached per colour. */
  glow(color: number): Sprite {
    const key = `glow|${color}`;
    const hit = this.misc.get(key);
    if (hit) return hit;
    const size = 64;
    return this.make(key, this.misc, -size / 2, -size / 2, size, size, 1, (ctx) => {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, size / 2);
      g.addColorStop(0, cssColorAlpha(color, 0.85));
      g.addColorStop(0.35, cssColorAlpha(color, 0.4));
      g.addColorStop(1, cssColorAlpha(color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  smokePuff(): Sprite {
    const key = 'puff';
    const hit = this.misc.get(key);
    if (hit) return hit;
    const size = 48;
    return this.make(key, this.misc, -size / 2, -size / 2, size, size, 1, (ctx) => {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, size / 2);
      g.addColorStop(0, 'rgba(200,196,188,0.55)');
      g.addColorStop(0.5, 'rgba(170,166,158,0.26)');
      g.addColorStop(1, 'rgba(150,146,140,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  spark(): Sprite {
    const key = 'spark';
    const hit = this.misc.get(key);
    if (hit) return hit;
    const size = 16;
    return this.make(key, this.misc, -size / 2, -size / 2, size, size, 1, (ctx) => {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, size / 2);
      g.addColorStop(0, 'rgba(255,240,200,0.95)');
      g.addColorStop(0.4, 'rgba(255,170,80,0.5)');
      g.addColorStop(1, 'rgba(255,120,40,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  cloud(): Sprite {
    const key = 'cloud';
    const hit = this.misc.get(key);
    if (hit) return hit;
    const size = 256;
    return this.make(key, this.misc, -size / 2, -size / 2, size, size, 1, (ctx) => {
      const g = ctx.createRadialGradient(0, 0, size * 0.1, 0, 0, size / 2);
      g.addColorStop(0, 'rgba(20,26,34,0.22)');
      g.addColorStop(0.55, 'rgba(20,26,34,0.12)');
      g.addColorStop(1, 'rgba(20,26,34,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  /** Pre-rendered grain tile for the film-grain overlay. */
  grain(): Sprite {
    const key = 'grain';
    const hit = this.misc.get(key);
    if (hit) return hit;
    const size = 128;
    return this.make(key, this.misc, 0, 0, size, size, 1, (ctx) => {
      const img = ctx.createImageData(size, size);
      for (let i = 0; i < size * size; i++) {
        const v = (hashInt(i * 2654435761) * 255) | 0;
        img.data[i * 4] = v;
        img.data[i * 4 + 1] = v;
        img.data[i * 4 + 2] = v;
        img.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    });
  }

  /** Vignette overlay canvas (radial darkness at the edges). */
  vignette(w: number, h: number, key: string): Sprite {
    const ck = `vig|${w}x${h}|${key}`;
    const hit = this.misc.get(ck);
    if (hit) return hit;
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D unavailable');
    const g = ctx.createRadialGradient(w / 2, h * 0.46, Math.min(w, h) * 0.3, w / 2, h * 0.5, Math.max(w, h) * 0.72);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.65, 'rgba(8,6,4,0.16)');
    g.addColorStop(1, 'rgba(6,5,3,0.55)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    const sprite: Sprite = { canvas, x0: 0, y0: 0, mapW: w, mapH: h, scale: 1, bytes: w * h * 4 };
    this.misc.set(ck, sprite);
    this.account(sprite.bytes);
    return sprite;
  }

  /** Palette helper: a stable ground-tint colour for a biome (minimap etc.). */
  minimapColor(biome: string): number {
    const st = this.palette.styleById(biome);
    return st.isWaterBiome ? st.waterResolved : st.ground;
  }

  static colorOf(color: number): string {
    return cssColor(color);
  }
}

/** Helper exposed for renderers that need the tile anchor used by sprites. */
export function spriteAnchor(tx: number, ty: number, heightPx: number): { x: number; y: number } {
  return { x: (tx - ty) * HALF_W, y: (tx + ty) * HALF_H + HALF_H - heightPx };
}

/** Helper used by the renderer to derive per-tile deterministic variants. */
export function tileHash(x: number, y: number, seed = 0): number {
  return hash2(x, y, seed);
}

/** Convenience for deterministic integer variant selection. */
export function tileVariant(x: number, y: number, modulo: number, seed = 0): number {
  return Math.floor(hash2(x, y, seed) * modulo) % Math.max(1, modulo);
}

/** Exposed for tests/debug. */
export function colorToCss(c: number): string {
  return cssColor(c);
}

/** Deep colour helper for renderer tinting. */
export function tint(base: number, amount: number): number {
  return rgb((base >> 16) & 0xff, (base >> 8) & 0xff, base & 0xff) && clamp(amount, 0, 1) >= 0
    ? mixColor(base, 0xffffff, clamp(amount, 0, 1) * 0.12)
    : base;
}
