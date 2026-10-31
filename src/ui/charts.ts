/**
 * Canvas line charts for the Almanac. Deliberately tiny: no dependencies, DPR
 * aware, stepped down when the series is longer than the pixel width.
 */
import { fmt } from './util';

export type ChartTone = 'ember' | 'brass' | 'good' | 'warn' | 'info' | 'bad' | 'violet';

const TONES: Record<ChartTone, { line: string; fill: string; glow: string }> = {
  ember: { line: '#e07a37', fill: 'rgba(224,122,55,0.16)', glow: 'rgba(224,122,55,0.5)' },
  brass: { line: '#c9a55b', fill: 'rgba(201,165,91,0.14)', glow: 'rgba(201,165,91,0.42)' },
  good: { line: '#7fb069', fill: 'rgba(127,176,105,0.14)', glow: 'rgba(127,176,105,0.42)' },
  warn: { line: '#d9a84e', fill: 'rgba(217,168,78,0.14)', glow: 'rgba(217,168,78,0.42)' },
  info: { line: '#6f9db3', fill: 'rgba(111,157,179,0.15)', glow: 'rgba(111,157,179,0.42)' },
  bad: { line: '#cf5c49', fill: 'rgba(207,92,73,0.15)', glow: 'rgba(207,92,73,0.42)' },
  violet: { line: '#b48ad6', fill: 'rgba(180,138,214,0.15)', glow: 'rgba(180,138,214,0.42)' },
};

export interface ChartOpts {
  tone?: ChartTone;
  /** Optional fixed maximum (useful for 0..100 gauges). */
  max?: number;
  /** Formats the value labels. */
  format?: (v: number) => string;
  /** Show a year/date label under the x axis. */
  emptyLabel?: string;
  /** Draw a horizontal reference line at this value. */
  reference?: number;
  referenceLabel?: string;
}

function cssSize(canvas: HTMLCanvasElement): { w: number; h: number } {
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(40, Math.round(rect.width || canvas.clientWidth || 240));
  const h = Math.max(40, Math.round(rect.height || canvas.clientHeight || 110));
  return { w, h };
}

/** Draw a single-series line chart onto the canvas (idempotent). */
export function drawLineChart(canvas: HTMLCanvasElement, values: number[], opts: ChartOpts = {}): void {
  const { w, h } = cssSize(canvas);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const tone = TONES[opts.tone ?? 'ember'];
  const padL = 34;
  const padR = 8;
  const padT = 10;
  const padB = 14;
  const plotW = Math.max(1, w - padL - padR);
  const plotH = Math.max(1, h - padT - padB);
  const format = opts.format ?? ((v: number) => fmt(v));

  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length < 2) {
    ctx.fillStyle = 'rgba(141,125,103,0.85)';
    ctx.font = '11px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(opts.emptyLabel ?? 'Gathering the first days…', padL + plotW / 2, padT + plotH / 2);
    return;
  }

  let lo = Math.min(...clean);
  let hi = Math.max(...clean);
  if (opts.max !== undefined) hi = Math.max(hi, opts.max);
  if (opts.reference !== undefined) hi = Math.max(hi, opts.reference);
  if (hi - lo < 1e-6) {
    hi = lo + 1;
    lo = Math.max(0, lo - 0.5);
  }
  const padVal = (hi - lo) * 0.12;
  lo -= padVal;
  hi += padVal;
  if (lo > 0 && Math.min(...clean) >= 0) lo = Math.max(0, lo);

  const xOf = (i: number): number => padL + (i / (clean.length - 1)) * plotW;
  const yOf = (v: number): number => padT + plotH - ((v - lo) / (hi - lo)) * plotH;

  // Grid + axis labels
  ctx.strokeStyle = 'rgba(201,165,91,0.12)';
  ctx.lineWidth = 1;
  ctx.fillStyle = 'rgba(196,178,152,0.62)';
  ctx.font = '9.5px Inter, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const gridLines = 3;
  for (let i = 0; i <= gridLines; i++) {
    const v = lo + ((hi - lo) * i) / gridLines;
    const y = Math.round(yOf(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.fillText(format(v), padL - 5, y);
  }

  if (opts.reference !== undefined) {
    const y = Math.round(yOf(opts.reference)) + 0.5;
    ctx.strokeStyle = 'rgba(207,92,73,0.4)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Area
  const gradient = ctx.createLinearGradient(0, padT, 0, padT + plotH);
  gradient.addColorStop(0, tone.fill);
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.beginPath();
  ctx.moveTo(xOf(0), padT + plotH);
  clean.forEach((v, i) => ctx.lineTo(xOf(i), yOf(v)));
  ctx.lineTo(xOf(clean.length - 1), padT + plotH);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // Line
  ctx.beginPath();
  clean.forEach((v, i) => {
    const x = xOf(i);
    const y = yOf(v);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = tone.line;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.shadowColor = tone.glow;
  ctx.shadowBlur = 6;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Last point
  const lx = xOf(clean.length - 1);
  const ly = yOf(clean[clean.length - 1]);
  ctx.beginPath();
  ctx.arc(lx, ly, 2.4, 0, Math.PI * 2);
  ctx.fillStyle = tone.line;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(lx, ly, 4.8, 0, Math.PI * 2);
  ctx.strokeStyle = tone.glow;
  ctx.lineWidth = 1;
  ctx.stroke();

  // X labels: first / last
  ctx.fillStyle = 'rgba(141,125,103,0.7)';
  ctx.font = '9px Inter, sans-serif';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText('earliest', padL, h - 3);
  ctx.textAlign = 'right';
  ctx.fillText('now', w - padR, h - 3);
}

export interface SeriesChart {
  canvas: HTMLCanvasElement;
  draw(values: number[], opts?: ChartOpts): void;
}
