#!/usr/bin/env node
/**
 * FIRST HEARTH — balance matrix driver (QA).
 *
 * Runs tools/simrun.ts headlessly across seeds x difficulties and aggregates the
 * JSON summaries into a comparison table + a machine-readable report.
 *
 * Usage:
 *   node tools/balance.mjs --days 400 --seeds demo,alpha,beta,gamma,delta
 *   node tools/balance.mjs --days 400 --difficulties balanced,gentle,harsh --out /tmp/qa-balance.json
 *
 * Targets (docs/CONTENT-AUTHORING.md + task spec):
 *   - era 1 by day 40–80, era 2 by day 150–250 under autoplay
 *   - first tech before day ~30
 *   - population 10 before day ~60
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const viteNode = join(root, 'node_modules', '.bin', 'vite-node');
const simrun = join(here, 'simrun.ts');

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const days = Number(arg('days', '400'));
const seeds = arg('seeds', 'demo,alpha,beta,gamma,delta').split(',').filter(Boolean);
const difficulties = arg('difficulties', 'balanced,gentle,harsh').split(',').filter(Boolean);
const outPath = arg('out', join(tmpdir(), 'qa-balance.json'));
const verbose = process.argv.includes('--verbose');
const tmp = mkdtempSync(join(tmpdir(), 'hearth-balance-'));

function run(seed, difficulty) {
  const json = join(tmp, `${seed}-${difficulty}.json`);
  const args = [simrun, '--', '--seed', seed, '--days', String(days), '--autoplay', '--difficulty', difficulty, '--quiet', '--out', json];
  return new Promise((resolve) => {
    const child = spawn(viteNode, args, { cwd: root, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('exit', (code) => {
      if (verbose) process.stdout.write(stdout);
      if (verbose && stderr) process.stderr.write(stderr);
      let summary = null;
      try {
        summary = JSON.parse(readFileSync(json, 'utf8'));
      } catch {
        summary = null;
      }
      resolve({ seed, difficulty, code, stdout, stderr, summary, jsonPath: json });
    });
  });
}

function pad(v, w, left = false) {
  const s = String(v);
  return left ? s.padEnd(w) : s.padStart(w);
}

function dayOfEra(summary, era) {
  return summary?.milestones?.eraDays?.find((e) => e.era === era)?.day ?? null;
}

function tail(values, n) {
  if (!Array.isArray(values) || !values.length) return [];
  return values.slice(-n);
}

const rows = [];
for (const difficulty of difficulties) {
  for (const seed of seeds) {
    process.stdout.write(`running ${seed}/${difficulty} ... `);
    const result = await run(seed, difficulty);
    const s = result.summary;
    if (!s) {
      console.log(`FAILED (exit ${result.code})`);
      rows.push({ seed, difficulty, failed: true, code: result.code, stderr: result.stderr.slice(-800) });
      continue;
    }
    const foodDaysTail = tail(s.metrics?.foodDays ?? [], 60);
    const popTail = tail(s.metrics?.population ?? [], 60);
    const row = {
      seed,
      difficulty,
      daysRun: s.daysRun,
      stopReason: s.stopReason,
      errors: s.errorCount ?? (s.errors?.length ?? 0),
      nan: s.nan?.count ?? 0,
      firstTechDay: s.milestones?.firstTechDay ?? null,
      pop10Day: s.milestones?.pop10Day ?? null,
      era1Day: dayOfEra(s, 1),
      era2Day: dayOfEra(s, 2),
      finalPop: s.final?.pop ?? null,
      peakPop: s.milestones?.peakPopulation ?? null,
      finalFoodDays: s.final?.foodDays ?? null,
      avgFoodDaysLast60: foodDaysTail.length ? foodDaysTail.reduce((a, b) => a + b, 0) / foodDaysTail.length : null,
      avgPopLast60: popTail.length ? popTail.reduce((a, b) => a + b, 0) / popTail.length : null,
      starvingDays: s.milestones?.starvingDays ?? null,
      eventsFired: s.milestones?.eventsFired ?? null,
      techs: s.final?.techs ?? null,
      buildings: s.final?.buildings ?? null,
      insight: s.final?.insight ?? null,
      msPerDay: s.msPerDay ?? null,
      gameOver: s.gameOver ? `${s.gameOver.tick}:${s.gameOver.cause}` : null,
    };
    rows.push(row);
    console.log(
      `ok  era1=${row.era1Day ?? '-'} era2=${row.era2Day ?? '-'} pop=${row.finalPop} peak=${row.peakPop} tech=${row.techs} err=${row.errors} nan=${row.nan}`,
    );
  }
}

const header = ['  seed', 'difficulty', 'era1', 'era2', '1stTech', 'pop10', 'finalPop', 'peakPop', 'foodD~', 'starveD', 'events', 'techs', 'bld', 'ms/day'];
const widths = [12, 10, 5, 5, 7, 6, 8, 8, 7, 7, 6, 5, 4, 7];
console.log('\n' + header.map((h, i) => pad(h, widths[i], true)).join(' '));
for (const r of rows) {
  const cells = [
    r.seed,
    r.difficulty,
    r.era1Day ?? '-',
    r.era2Day ?? '-',
    r.firstTechDay ?? '-',
    r.pop10Day ?? '-',
    r.finalPop ?? '-',
    r.peakPop ?? '-',
    r.avgFoodDaysLast60 != null ? r.avgFoodDaysLast60.toFixed(1) : '-',
    r.starvingDays ?? '-',
    r.eventsFired ?? '-',
    r.techs ?? '-',
    r.buildings ?? '-',
    r.msPerDay ?? '-',
  ];
  console.log(cells.map((c, i) => pad(c, widths[i], i < 2)).join(' '));
}

// Target comparison (autoplay = "normal play" proxy).
console.log('\nTargets: era1 d40-80, era2 d150-250, first tech < d30, pop10 < d60');
const ok = [];
const warnings = [];
for (const r of rows) {
  if (r.errors || r.nan || r.gameOver) warnings.push(`${r.seed}/${r.difficulty}: errors=${r.errors} nan=${r.nan}${r.gameOver ? ` gameOver=${r.gameOver}` : ''}`);
  const label = `${r.seed}/${r.difficulty}`;
  if (r.era1Day === null) warnings.push(`${label}: era1 never reached`);
  else if (r.era1Day < 40) console.log(`  note ${label}: era1 early (day ${r.era1Day})`), ok.push(label);
  else if (r.era1Day > 80) warnings.push(`${label}: era1 late (day ${r.era1Day})`);
  else ok.push(label);
  if (r.era2Day !== null) {
    if (r.era2Day < 150) console.log(`  note ${label}: era2 early (day ${r.era2Day})`);
    else if (r.era2Day > 250) warnings.push(`${label}: era2 late (day ${r.era2Day})`);
  }
  if (r.firstTechDay !== null && r.firstTechDay > 30) warnings.push(`${label}: first tech late (day ${r.firstTechDay})`);
  if (r.pop10Day === null) warnings.push(`${label}: never reached pop 10`);
  else if (r.pop10Day > 60) warnings.push(`${label}: pop10 late (day ${r.pop10Day})`);
}
console.log(`\nrows: ${rows.length}, target-ok on era1: ${ok.length}, warnings: ${warnings.length}`);
for (const w of warnings) console.log(`  WARN ${w}`);

const report = { generatedAt: new Date().toISOString(), days, seeds, difficulties, rows, warnings };
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`\nbalance report: ${outPath}`);
process.exit(rows.some((r) => r.failed || r.errors || r.nan) ? 1 : 0);
