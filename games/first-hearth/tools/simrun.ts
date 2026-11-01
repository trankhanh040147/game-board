/**
 * FIRST HEARTH — headless deterministic simulation runner (QA primary tool).
 *
 * Runs the real simulation (buildContent -> createNewGame -> tick()) without a
 * browser, catches/counts system errors, prints a compact daily/periodic report
 * and optionally dumps a JSON summary for balance analysis and regression tests.
 *
 * Usage:
 *   npx vite-node tools/simrun.ts -- --seed demo --days 300 --autoplay --verbose
 *   npx vite-node tools/simrun.ts -- --seed demo --days 400 --autoplay --out /tmp/sim.json
 *   npx vite-node tools/simrun.ts -- --autoplay --until-pop 25 --difficulty harsh
 *
 * Flags (all optional):
 *   --seed <string>        deterministic world seed              (default: demo)
 *   --days <n>             number of days to simulate            (default: 200)
 *   --autoplay             auto-research + auto-place buildings
 *   --difficulty <id>      gentle | balanced | harsh             (default: balanced)
 *   --until-pop <n>        stop early once population reaches n
 *   --report-every <n>     print a report row every n days       (default: 10)
 *   --out <path>           write JSON summary to path
 *   --width/--height <n>   world dimensions override
 *   --verbose              detailed log (placements, first errors, warnings)
 *   --quiet                only final summary (no report rows)
 *   --hash                 include a deterministic state hash in the summary
 *   --max-errors <n>       abort after n tick errors              (default: 25)
 *   --help                 show usage
 *
 * Exit code 0 = clean run, 1 = tick/action errors or content validation errors.
 */
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContent, validateContent } from '../src/sim/content/index';
import { createNewGame } from '../src/sim/state';
import { tick, snapshot } from '../src/sim/tick';
import { RULES } from '../src/sim/config';
import {
  capitalOf,
  dateLabel,
  foodDaysOf,
  seasonOf,
  totalPopulation,
  waterDaysOf,
  yearOf,
} from '../src/sim/core';
import { Autoplay } from './autoplay';
import type { AutoplayStats } from './autoplay';
import type { Content, GameState } from '../src/sim/types';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

interface Options {
  seed: string;
  days: number;
  autoplay: boolean;
  difficulty: 'gentle' | 'balanced' | 'harsh';
  untilPop: number;
  reportEvery: number;
  out: string | null;
  width: number | null;
  height: number | null;
  verbose: boolean;
  quiet: boolean;
  hash: boolean;
  maxErrors: number;
  csv: string | null;
  assertNoNan: boolean;
  assertNoNegativeStock: boolean;
  assertStartingStock: boolean;
  seeds: string[];
  help: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    seed: 'demo',
    days: 200,
    autoplay: false,
    difficulty: 'balanced',
    untilPop: 0,
    reportEvery: 10,
    out: null,
    width: null,
    height: null,
    verbose: false,
    quiet: false,
    hash: false,
    maxErrors: 25,
    csv: null,
    assertNoNan: false,
    assertNoNegativeStock: false,
    assertStartingStock: false,
    seeds: [],
    help: false,
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    let arg = args[i];
    if (!arg) continue;
    if (arg === '--' || arg.endsWith('simrun.ts') || arg.endsWith('simrun.mjs')) continue;
    let inlineValue: string | null = null;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) {
      inlineValue = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const take = (): string => {
      if (inlineValue !== null) return inlineValue;
      const next = args[++i];
      if (next === undefined) throw new Error(`Missing value for ${arg}`);
      return next;
    };
    switch (arg) {
      case '--seed':
        opts.seed = take();
        break;
      case '--days':
        opts.days = Math.max(1, Math.floor(Number(take())));
        break;
      case '--autoplay':
        opts.autoplay = true;
        break;
      case '--difficulty': {
        const v = take();
        if (v !== 'gentle' && v !== 'balanced' && v !== 'harsh') throw new Error(`Unknown difficulty "${v}" (gentle|balanced|harsh)`);
        opts.difficulty = v;
        break;
      }
      case '--until-pop':
        opts.untilPop = Math.max(0, Math.floor(Number(take())));
        break;
      case '--report-every':
        opts.reportEvery = Math.max(0, Math.floor(Number(take())));
        break;
      case '--out':
        opts.out = take();
        break;
      case '--csv':
        opts.csv = take();
        break;
      case '--seeds':
        opts.seeds = take()
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean);
        break;
      case '--assert-no-nan':
        opts.assertNoNan = true;
        break;
      case '--assert-no-negative-stock':
        opts.assertNoNegativeStock = true;
        break;
      case '--assert-starting-stock':
        opts.assertStartingStock = true;
        break;
      case '--width':
        opts.width = Math.max(16, Math.floor(Number(take())));
        break;
      case '--height':
        opts.height = Math.max(16, Math.floor(Number(take())));
        break;
      case '--max-errors':
        opts.maxErrors = Math.max(1, Math.floor(Number(take())));
        break;
      case '--verbose':
        opts.verbose = true;
        break;
      case '--quiet':
        opts.quiet = true;
        break;
      case '--hash':
        opts.hash = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw new Error(`Unknown flag "${arg}" (try --help)`);
    }
  }
  return opts;
}

const USAGE = `First Hearth headless sim runner

  npx vite-node tools/simrun.ts -- --seed demo --days 300 --autoplay --verbose
  npx vite-node tools/simrun.ts -- --seed demo --days 400 --autoplay --out /tmp/sim.json

Flags: --seed <s> --days <n> --autoplay --difficulty gentle|balanced|harsh
       --until-pop <n> --report-every <n> --out <json> --csv <path> --width <n> --height <n>
       --seeds a,b,c (multi-seed matrix) --assert-no-nan --assert-no-negative-stock
       --assert-starting-stock --verbose --quiet --hash --max-errors <n> --help`;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const pad = (v: string | number, w: number, left = false): string => {
  const s = typeof v === 'number' ? String(v) : v;
  return left ? s.padEnd(w) : s.padStart(w);
};

function nowMs(): number {
  const p = globalThis.performance;
  return p && typeof p.now === 'function' ? p.now() : Date.now();
}

function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

interface TickError {
  day: number;
  where: 'tick' | 'autoplay';
  message: string;
  stack?: string;
}

function errText(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

/** Deep scan every number reachable from state (skipping transient cache). */
function scanNonFinite(state: GameState): { count: number; paths: string[] } {
  let count = 0;
  const paths: string[] = [];
  const seen = new Set<unknown>();
  const walk = (value: unknown, path: string, depth: number): void => {
    if (count > 40 || depth > 12) return;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        count++;
        if (paths.length < 40) paths.push(`${path}=${String(value)}`);
      }
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) walk(value[i], `${path}[${i}]`, depth + 1);
      return;
    }
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (depth === 0 && (key === 'cache' || key === 'world')) {
        // world is huge but still numeric-clean-critical: scan it, only skip cache
        if (key === 'cache') continue;
      }
      walk((value as Record<string, unknown>)[key], path ? `${path}.${key}` : key, depth + 1);
    }
  };
  walk(state, '', 0);
  return { count, paths };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

interface Row {
  day: number;
  year: number;
  season: string;
  pop: number;
  foodDays: number;
  waterDays: number;
  morale: number;
  health: number;
  treasury: number;
  insight: number;
  era: number;
  techs: number;
  buildings: number;
  unemployed: number;
  homeless: number;
  pollution: number;
  biodiversity: number;
  births: number;
  deaths: number;
  events: number;
  msPerDay: number;
}

function seasonShort(tick: number): string {
  return seasonOf(tick).slice(0, 3).toUpperCase();
}

function sampleRow(state: GameState, content: Content, msPerDay: number): Row {
  const cap = capitalOf(state);
  const living = state.citizens.filter((c) => c.alive);
  const avg = (sel: (c: GameState['citizens'][number]) => number): number => {
    if (!living.length) return 0;
    let s = 0;
    for (const c of living) s += sel(c);
    return s / living.length;
  };
  let pollutionSum = 0;
  let pollutionN = 0;
  for (const t of state.world.tiles) {
    if (t.settlementId < 0) continue;
    pollutionSum += t.pollution;
    pollutionN++;
  }
  return {
    day: state.tick,
    year: yearOf(state.tick),
    season: seasonShort(state.tick),
    pop: totalPopulation(state),
    foodDays: cap ? Math.round(foodDaysOf(state, content, cap) * 10) / 10 : 0,
    waterDays: cap ? Math.round(waterDaysOf(state, cap) * 10) / 10 : 0,
    morale: Math.round(avg((c) => c.morale) * 10) / 10,
    health: Math.round(avg((c) => c.health) * 10) / 10,
    treasury: cap ? Math.round(cap.treasury) : 0,
    insight: Math.round(state.research.insight * 10) / 10,
    era: state.research.era,
    techs: Object.keys(state.research.completed).length,
    buildings: state.buildings.filter((b) => b.progress >= 1).length,
    unemployed: cap ? Math.round(cap.unemployed) : 0,
    homeless: cap ? Math.round(cap.homeless) : 0,
    pollution: pollutionN ? Math.round((pollutionSum / pollutionN) * 10) / 10 : 0,
    biodiversity: Math.round(state.world.climate.biodiversity * 100) / 100,
    births: state.stats.citizensBorn,
    deaths: state.stats.citizensDied,
    events: state.events.history.length,
    msPerDay: Math.round(msPerDay * 1000) / 1000,
  };
}

function rowHeader(): string {
  return [
    pad('day', 5),
    pad('yr', 3),
    pad('sea', 4),
    pad('pop', 5),
    pad('foodD', 6),
    pad('watD', 5),
    pad('mor', 4),
    pad('hlt', 4),
    pad('treas', 6),
    pad('ins', 5),
    pad('era', 3),
    pad('tech', 5),
    pad('bld', 4),
    pad('unemp', 6),
    pad('hmless', 6),
    pad('poll', 5),
    pad('bio', 5),
    pad('birth', 5),
    pad('death', 5),
    pad('evt', 4),
    pad('ms/day', 7),
  ].join(' ');
}

function rowLine(r: Row): string {
  return [
    pad(r.day, 5),
    pad(r.year, 3),
    pad(r.season, 4),
    pad(r.pop, 5),
    pad(r.foodDays, 6),
    pad(r.waterDays, 5),
    pad(r.morale, 4),
    pad(r.health, 4),
    pad(r.treasury, 6),
    pad(r.insight, 5),
    pad(r.era, 3),
    pad(r.techs, 5),
    pad(r.buildings, 4),
    pad(r.unemployed, 6),
    pad(r.homeless, 6),
    pad(r.pollution, 5),
    pad(r.biodiversity, 5),
    pad(r.births, 5),
    pad(r.deaths, 5),
    pad(r.events, 4),
    pad(r.msPerDay, 7),
  ].join(' ');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function contentCounts(content: Content): Record<string, number> {
  return {
    resources: Object.keys(content.resources).length,
    buildings: Object.keys(content.buildings).length,
    recipes: Object.keys(content.recipes).length,
    techs: Object.keys(content.techs).length,
    biomes: Object.keys(content.biomes).length,
    sites: Object.keys(content.sites).length,
    events: Object.keys(content.events).length,
    policies: Object.keys(content.policies).length,
    doctrines: Object.keys(content.doctrines).length,
    eras: content.eras.length,
    milestones: content.milestones.length,
    achievements: content.achievements.length,
    megaprojects: Object.keys(content.megaprojects).length,
  };
}

export interface SimRunSummary {
  ok: boolean;
  seed: string;
  difficulty: string;
  content: Record<string, number>;
  requestedDays: number;
  daysRun: number;
  stopReason: string;
  finalTick: number;
  finalDate: string;
  wallMs: number;
  msPerDay: number;
  ticksPerSec: number;
  errors: TickError[];
  errorCount: number;
  nan: { count: number; paths: string[] };
  negativeStocks: { settlement: number; resource: string; amount: number }[];
  startingStock: Record<string, number> | null;
  gameOver: GameState['gameOver'];
  milestones: {
    firstTechDay: number | null;
    pop10Day: number | null;
    peakPopulation: number;
    eraDays: { era: number; day: number }[];
    techDays: { tech: string; day: number }[];
    starvingDays: number;
    decisionsResolved: number;
    eventsFired: number;
    doctrinesAdopted: number;
    settlements: number;
  };
  autoplay: AutoplayStats | null;
  final: Row;
  timeline: Row[];
  metrics: Record<string, number[]>;
  hash?: string;
}

/**
 * Multi-seed matrix: run this same harness once per seed (child processes keep
 * each run isolated and deterministic) and print a comparison table.
 */
function runSeedMatrix(opts: Options): void {
  const script = fileURLToPath(import.meta.url);
  const bin = join(process.cwd(), 'node_modules', '.bin', 'vite-node');
  const dir = mkdtempSync(join(tmpdir(), 'hearth-seeds-'));
  const seeds = opts.seeds;
  const rows: { seed: string; summary: SimRunSummary | null; exitCode: number }[] = [];
  let index = 0;
  const next = (): void => {
    if (index >= seeds.length) {
      finishSeedMatrix(opts, rows);
      return;
    }
    const seed = seeds[index++];
    const json = join(dir, `${seed}.json`);
    const args = [script, '--', '--seed', seed, '--days', String(opts.days), '--difficulty', opts.difficulty, '--quiet', '--out', json];
    if (opts.autoplay) args.push('--autoplay');
    if (opts.untilPop > 0) args.push('--until-pop', String(opts.untilPop));
    if (opts.hash) args.push('--hash');
    if (opts.assertNoNan) args.push('--assert-no-nan');
    if (opts.assertNoNegativeStock) args.push('--assert-no-negative-stock');
    if (opts.assertStartingStock) args.push('--assert-starting-stock');
    const child = spawn(bin, args, { cwd: process.cwd(), env: process.env });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', (code) => {
      let summary: SimRunSummary | null = null;
      try {
        summary = JSON.parse(readFileSync(json, 'utf8')) as SimRunSummary;
      } catch {
        summary = null;
      }
      if (!summary && stderr) console.error(`seed ${seed} failed: ${stderr.split('\n').slice(-4).join(' ')}`);
      rows.push({ seed, summary, exitCode: code ?? 1 });
      process.stdout.write(`  ${pad(seed, 12)} ${summary ? `era1=${eraOfSummary(summary, 1) ?? '-'} era2=${eraOfSummary(summary, 2) ?? '-'} pop10=${summary.milestones.pop10Day ?? '-'} pop=${summary.final.pop} peak=${summary.milestones.peakPopulation} techs=${summary.final.techs} err=${summary.errorCount} nan=${summary.nan.count}` : 'FAILED'}\n`);
      next();
    });
  };
  console.log(`running ${seeds.length} seeds x days=${opts.days} difficulty=${opts.difficulty} autoplay=${opts.autoplay ? 'on' : 'off'}`);
  next();
}

function eraOfSummary(summary: SimRunSummary, era: number): number | null {
  return summary.milestones.eraDays.find((e) => e.era === era)?.day ?? null;
}

function finishSeedMatrix(opts: Options, rows: { seed: string; summary: SimRunSummary | null; exitCode: number }[]): void {
  const widths = [14, 6, 6, 6, 7, 7, 8, 8, 6, 6, 6];
  const header = ['seed', 'era1', 'era2', 'pop10', '1stTch', 'finalPop', 'peakPop', 'foodDays', 'techs', 'err', 'ms/day'];
  console.log('\n' + header.map((h, i) => pad(h, widths[i], true)).join(' '));
  let failures = 0;
  for (const row of rows) {
    if (!row.summary) {
      failures++;
      console.log(pad(row.seed, widths[0], true) + '  FAILED TO RUN');
      continue;
    }
    const st = row.summary;
    if (st.errorCount || st.nan.count) failures++;
    const cells = [
      row.seed,
      eraOfSummary(st, 1) ?? '-',
      eraOfSummary(st, 2) ?? '-',
      st.milestones.pop10Day ?? '-',
      st.milestones.firstTechDay ?? '-',
      st.final.pop,
      st.milestones.peakPopulation,
      st.final.foodDays,
      st.final.techs,
      st.errorCount,
      st.msPerDay,
    ];
    console.log(cells.map((c, i) => pad(c, widths[i], i === 0)).join(' '));
  }
  if (opts.csv) {
    try {
      const lines = ['seed,day,pop,foodDays,wood,stone,insight,era,techs,buildings,events'];
      for (const row of rows) {
        if (!row.summary || !row.summary.timeline) continue;
        for (const r of row.summary.timeline) {
          lines.push([row.seed, r.day, r.pop, r.foodDays, '', '', r.insight, r.era, r.techs, r.buildings, r.events].join(','));
        }
      }
      writeFileSync(opts.csv, lines.join('\n') + '\n');
      console.log(`csv (report-interval rows) written: ${opts.csv}`);
    } catch (e) {
      console.error(`failed to write csv: ${errText(e)}`);
    }
  }
  if (opts.out) {
    try {
      writeFileSync(opts.out, JSON.stringify({ days: opts.days, difficulty: opts.difficulty, autoplay: opts.autoplay, runs: rows.map((r) => ({ seed: r.seed, exitCode: r.exitCode, summary: r.summary })) }, null, 2));
      console.log(`matrix json written: ${opts.out}`);
    } catch (e) {
      console.error(`failed to write ${opts.out}: ${errText(e)}`);
    }
  }
  process.exit(failures ? 1 : 0);
}

function main(): void {
  let opts: Options;
  try {
    opts = parseArgs(process.argv);
  } catch (e) {
    console.error(`argument error: ${errText(e)}`);
    console.error(USAGE);
    process.exit(2);
  }
  if (opts.help) {
    console.log(USAGE);
    process.exit(0);
  }

  if (opts.seeds.length > 1) {
    runSeedMatrix(opts);
    return;
  }
  if (opts.seeds.length === 1 && !opts.seed) opts.seed = opts.seeds[0];

  const startedAt = nowMs();
  const content = buildContent();
  const validation = validateContent(content);
  const counts = contentCounts(content);
  if (opts.verbose) {
    console.log(`content: ${JSON.stringify(counts)}`);
    if (validation.warnings.length) {
      console.log(`content warnings (${validation.warnings.length}):`);
      for (const w of validation.warnings.slice(0, 25)) console.log(`  ! ${w}`);
      if (validation.warnings.length > 25) console.log(`  ... and ${validation.warnings.length - 25} more`);
    }
  }
  if (validation.errors.length) {
    console.error(`CONTENT VALIDATION FAILED: ${validation.errors.length} error(s)`);
    for (const e of validation.errors.slice(0, 40)) console.error(`  x ${e}`);
    process.exit(1);
  }

  const state = createNewGame(content, {
    seed: opts.seed,
    difficulty: opts.difficulty,
    width: opts.width ?? undefined,
    height: opts.height ?? undefined,
  });
  if (opts.verbose) {
    const cap = capitalOf(state);
    console.log(`new game: seed="${opts.seed}" difficulty=${opts.difficulty} capital=${cap?.name ?? '?'}@(${cap?.x},${cap?.y}) citizens=${state.citizens.filter((c) => c.alive).length}`);
  }

  const autoplay = opts.autoplay ? new Autoplay() : null;
  const errors: TickError[] = [];
  const timeline: Row[] = [];
  const csvRows: string[] = [];
  const csvHeader = 'seed,day,pop,foodDays,wood,stone,insight,era,techs,buildings,events';
  let startingStock: Record<string, number> | null = null;
  const eraDays: { era: number; day: number }[] = [];
  const techDays: { tech: string; day: number }[] = [];
  let firstTechDay: number | null = null;
  let pop10Day: number | null = null;
  let peakPopulation = 0;
  let lastEra = state.research.era;
  let starvationDays = 0;
  const knownTechs = new Set(Object.keys(state.research.completed));
  const tickStart = nowMs();
  let daysRun = 0;
  let stopReason = 'days';

  const recordMilestones = (): void => {
    for (const tech of Object.keys(state.research.completed)) {
      if (!knownTechs.has(tech)) {
        knownTechs.add(tech);
        techDays.push({ tech, day: state.tick });
        if (firstTechDay === null) firstTechDay = state.tick;
      }
    }
    const pop = totalPopulation(state);
    if (pop > peakPopulation) peakPopulation = pop;
    if (pop10Day === null && pop >= 10) pop10Day = state.tick;
    if (state.research.era !== lastEra) {
      lastEra = state.research.era;
      eraDays.push({ era: lastEra, day: state.tick });
    }
    const cap = capitalOf(state);
    if (cap && cap.foodDays < 1) starvationDays++;
  };

  for (let i = 0; i < opts.days; i++) {
    if (opts.untilPop > 0 && totalPopulation(state) >= opts.untilPop) {
      stopReason = 'until-pop';
      break;
    }
    if (state.gameOver) {
      stopReason = 'game-over';
      break;
    }
    if (autoplay) {
      try {
        autoplay.run(state, content);
        const logs = autoplay.takeLogs();
        if (opts.verbose) for (const l of logs) console.log(`  ${l}`);
      } catch (e) {
        errors.push({ day: state.tick, where: 'autoplay', message: errText(e), stack: e instanceof Error ? e.stack : undefined });
        if (opts.verbose) console.error(`  autoplay error day ${state.tick}: ${errText(e)}`);
      }
    }
    try {
      tick(state, content, RULES);
      daysRun++;
    } catch (e) {
      errors.push({ day: state.tick, where: 'tick', message: errText(e), stack: e instanceof Error ? e.stack : undefined });
      if (opts.verbose) console.error(`  tick error day ${state.tick}: ${errText(e)}`);
      // A throwing system aborts the day; continue so later days can be analysed.
      daysRun++;
    }
    recordMilestones();

    if (i === 0) {
      const cap0 = capitalOf(state);
      if (cap0) startingStock = { wood: cap0.stock.wood ?? 0, stone: cap0.stock.stone ?? 0, berries: cap0.stock.berries ?? 0, fiber: cap0.stock.fiber ?? 0 };
    }
    if (opts.csv) {
      const capCsv = capitalOf(state);
      csvRows.push(
        [
          opts.seed,
          state.tick,
          totalPopulation(state),
          capCsv ? Math.round(foodDaysOf(state, content, capCsv) * 10) / 10 : 0,
          capCsv ? Math.round((capCsv.stock.wood ?? 0) * 10) / 10 : 0,
          capCsv ? Math.round((capCsv.stock.stone ?? 0) * 10) / 10 : 0,
          Math.round(state.research.insight * 10) / 10,
          state.research.era,
          Object.keys(state.research.completed).length,
          state.buildings.filter((b) => b.progress >= 1).length,
          state.events.history.length,
        ].join(','),
      );
    }

    if (!opts.quiet && opts.reportEvery > 0 && (state.tick % opts.reportEvery === 0 || i === opts.days - 1)) {
      const elapsed = nowMs() - tickStart;
      const msPerDay = elapsed / Math.max(1, daysRun);
      if (timeline.length === 0) console.log(rowHeader());
      const row = sampleRow(state, content, msPerDay);
      timeline.push(row);
      console.log(rowLine(row));
    }
    if (errors.length >= opts.maxErrors) {
      stopReason = 'too-many-errors';
      break;
    }
  }

  // ---- final summary ----
  const wallMs = nowMs() - startedAt;
  const simMs = nowMs() - tickStart;
  const msPerDay = daysRun ? simMs / daysRun : 0;
  const nan = scanNonFinite(state);
  const negativeStocks: { settlement: number; resource: string; amount: number }[] = [];
  for (const st of state.settlements) {
    for (const res of Object.keys(st.stock)) {
      const amount = st.stock[res];
      if (Number.isFinite(amount) && amount < -1e-6) negativeStocks.push({ settlement: st.id, resource: res, amount: Math.round(amount * 1000) / 1000 });
    }
  }
  const finalRow = sampleRow(state, content, msPerDay);

  const summary: SimRunSummary = {
    ok: errors.length === 0,
    seed: opts.seed,
    difficulty: opts.difficulty,
    content: counts,
    requestedDays: opts.days,
    daysRun,
    stopReason,
    finalTick: state.tick,
    finalDate: dateLabel(state.tick),
    wallMs: Math.round(wallMs),
    msPerDay: Math.round(msPerDay * 1000) / 1000,
    ticksPerSec: msPerDay ? Math.round(1000 / msPerDay) : 0,
    errors: errors.slice(0, 50),
    errorCount: errors.length,
    nan,
    negativeStocks,
    startingStock,
    gameOver: state.gameOver,
    milestones: {
      firstTechDay,
      pop10Day,
      peakPopulation,
      eraDays,
      techDays,
      starvingDays: starvationDays,
      decisionsResolved: autoplay?.stats.decisionsResolved ?? 0,
      eventsFired: state.events.history.length,
      doctrinesAdopted: autoplay?.stats.doctrines ?? 0,
      settlements: state.settlements.length,
    },
    autoplay: autoplay?.stats ?? null,
    final: finalRow,
    timeline,
    metrics: state.metrics.series,
  };
  if (opts.hash) summary.hash = fnv1a(snapshot(state));

  if (!opts.quiet) {
    console.log('');
    console.log('-- summary ' + '-'.repeat(60));
  }
  console.log(
    `seed=${opts.seed} difficulty=${opts.difficulty} autoplay=${opts.autoplay ? 'on' : 'off'} days=${daysRun}/${opts.days} stop=${stopReason} errors=${errors.length} nan=${nan.count} ${opts.hash ? `hash=${summary.hash} ` : ''}wall=${summary.wallMs}ms ${summary.msPerDay}ms/day (~${summary.ticksPerSec} days/s)`,
  );
  console.log(
    `final: ${summary.finalDate} pop=${finalRow.pop} foodDays=${finalRow.foodDays} waterDays=${finalRow.waterDays} morale=${finalRow.morale} health=${finalRow.health} treasury=${finalRow.treasury} insight=${finalRow.insight} era=${finalRow.era} techs=${finalRow.techs} buildings=${finalRow.buildings} unemployed=${finalRow.unemployed} homeless=${finalRow.homeless} pollution=${finalRow.pollution} biodiversity=${finalRow.biodiversity} births=${finalRow.births} deaths=${finalRow.deaths} events=${finalRow.events}`,
  );
  console.log(
    `milestones: firstTechDay=${firstTechDay ?? '-'} pop10Day=${pop10Day ?? '-'} peakPop=${peakPopulation} eras=${eraDays.map((e) => `era${e.era}@d${e.day}`).join(',') || '-'} starvingDays=${starvationDays} settlements=${state.settlements.length}`,
  );
  if (autoplay) {
    console.log(
      `autoplay: placed=${autoplay.stats.placed.length} roads=${autoplay.stats.roads} techs=${autoplay.stats.techsChosen} decisions=${autoplay.stats.decisionsResolved} doctrines=${autoplay.stats.doctrines} failedPlacements=${autoplay.stats.failedPlacements}`,
    );
  }
  if (errors.length) {
    console.log(`errors (first ${Math.min(5, errors.length)} of ${errors.length}):`);
    for (const e of errors.slice(0, 5)) console.log(`  day ${e.day} [${e.where}] ${e.message}`);
    if (opts.verbose) for (const e of errors.slice(0, 2)) if (e.stack) console.log(e.stack);
  }
  if (nan.count) {
    console.log(`NON-FINITE NUMBERS: ${nan.count}`);
    for (const p of nan.paths.slice(0, 15)) console.log(`  ${p}`);
  }

  const assertions: string[] = [];
  if (opts.assertNoNan && nan.count > 0) assertions.push(`assert-no-nan failed: ${nan.count} non-finite value(s)`);
  if (opts.assertNoNegativeStock && negativeStocks.length > 0) assertions.push(`assert-no-negative-stock failed: ${negativeStocks.map((x) => `${x.resource}=${x.amount}`).join(', ')}`);
  if (opts.assertStartingStock) {
    const ss = startingStock ?? {};
    if ((ss.wood ?? 0) < 15) assertions.push(`assert-starting-stock failed: wood=${ss.wood?.toFixed(1)} after first day (expected >= 15)`);
    if ((ss.stone ?? 0) < 8) assertions.push(`assert-starting-stock failed: stone=${ss.stone?.toFixed(1)} after first day (expected >= 8)`);
    if ((ss.fiber ?? 0) < 3) assertions.push(`assert-starting-stock failed: fiber=${ss.fiber?.toFixed(1)} after first day (expected >= 3)`);
  }
  if (assertions.length) {
    console.error('ASSERTION FAILURES:');
    for (const a of assertions) console.error(`  x ${a}`);
  }

  if (opts.out) {
    try {
      writeFileSync(opts.out, JSON.stringify(summary, null, 2));
      if (!opts.quiet) console.log(`json summary written: ${opts.out}`);
    } catch (e) {
      console.error(`failed to write ${opts.out}: ${errText(e)}`);
    }
  }
  if (opts.csv) {
    try {
      writeFileSync(opts.csv, [csvHeader, ...csvRows].join('\n') + '\n');
      if (!opts.quiet) console.log(`csv written: ${opts.csv} (${csvRows.length} rows)`);
    } catch (e) {
      console.error(`failed to write ${opts.csv}: ${errText(e)}`);
    }
  }

  process.exit(assertions.length ? 1 : errors.length === 0 ? 0 : 1);
}

main();
