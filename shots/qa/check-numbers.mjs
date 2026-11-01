// Content-truth spot check: compare numbers rendered on the board against
// data/telemetry/games.json, and verify the prompt text shown is the English
// textEn (and that Vietnamese originals do not leak into the UI).
// Run: node shots/qa/check-numbers.mjs board-final
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const label = process.argv[2] || 'final';
const board = JSON.parse(readFileSync(join(here, `board-${label}.json`), 'utf8'));
const data = JSON.parse(readFileSync(join(repo, 'data/telemetry/games.json'), 'utf8'));

const int = new Intl.NumberFormat('en-US');
const count = (n) => int.format(Math.round(n));
const trim = (n) => (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, '');
function compact(n) {
  const abs = Math.abs(n);
  if (abs >= 1e9) return trim(n / 1e9) + 'B';
  if (abs >= 1e6) return trim(n / 1e6) + 'M';
  if (abs >= 1e4) return trim(n / 1e3) + 'K';
  return count(n);
}
function duration(ms) {
  if (!ms || ms <= 0) return '—';
  const t = Math.round(ms / 60000); const h = Math.floor(t / 60); const m = t % 60;
  if (h === 0) return `${m} m`;
  if (m === 0) return `${h} h`;
  return `${h} h ${String(m).padStart(2, '0')} m`;
}
const hours = (ms) => (!ms || ms <= 0 ? '0' : (Math.round((ms / 3.6e6) * 10) / 10).toFixed(1));
const workTime = (ms) => (!ms || ms <= 0 ? '—' : ms < 3.6e6 ? duration(ms) : `${hours(ms)} h`);

function pagesByGame() {
  const map = {};
  for (const r of board.routes) {
    if (r.game) map[r.game] = r;
  }
  const makingOf = board.routes.find((r) => r.name === 'making-of');
  map.__makingOf = makingOf;
  return map;
}
const pages = pagesByGame();
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

const results = { generatedAt: new Date().toISOString(), label, base: board.base, checks: [], promptChecks: [], summary: {} };
let pass = 0, fail = 0;

for (const g of data.games) {
  const page = pages[g.slug];
  if (!page) { results.checks.push({ game: g.slug, field: 'page', status: 'MISSING', note: 'no exhibit route captured' }); fail++; continue; }
  const text = norm((page.desktop.expandedText || '') + ' ' + ((page.desktop.info && page.desktop.info.bodyText) || '') + ' ' + ((page.mobile.info && page.mobile.info.bodyText) || ''));
  const t = g.totals;
  const expectations = [
    ['totalTokens', t.totalTokens, 'tokens processed'],
    ['inputTokens', t.inputTokens, 'input'],
    ['outputTokens', t.outputTokens, 'output'],
    ['cacheReadTokens', t.cacheReadTokens, 'cache read'],
    ['prompts count', g.prompts.length, 'human prompt count'],
    ['lead steps', g.rounds.agentSteps, 'lead agent steps'],
    ['subagent steps', g.rounds.subagentSteps, 'subagent steps'],
    ['subagent sessions', g.rounds.subagentSessions, 'subagents'],
    ['agent work', g.activeMs, 'agent-hours / work time'],
    ['wall clock', g.durationMs, 'wall clock'],
    ['files created', g.files.created, 'files'],
    ['milestones', g.milestones.length, 'milestones'],
    ['thinking chars', g.thinking.totalChars, 'reasoning chars'],
  ];
  for (const [field, raw, note] of expectations) {
    let variants = [...new Set([count(raw), compact(raw), duration(raw), workTime(raw), hours(raw), String(raw)])].filter(Boolean);
    if (raw === 0) {
      results.checks.push({ game: g.slug, field, expected: '0', found: null, note: note + ' (zero: display should say solo/none)', n_a: true });
      continue;
    }
    const hit = variants.find((v) => v.length > 0 && text.includes(v)) || null;
    const ok = Boolean(hit);
    results.checks.push({ game: g.slug, field, expected: count(raw), variants, matched: hit, found: ok, note });
    ok ? pass++ : fail++;
  }

  // prompt text: English textEn must appear; for translated prompts the
  // Vietnamese original must NOT appear in the UI.
  for (const p of g.prompts) {
    const en = norm(p.textEn || p.text || '');
    const head = en.slice(0, Math.min(70, en.length));
    // the display may shorten paths; take a probe that avoids URLs/paths
    const probe = head.replace(/https?:\/\/\S+/g, '').replace(/\/Users\/\S+/g, '').trim();
    const shownOk = probe.length > 8 ? text.includes(probe) : true;
    let originalLeak = false;
    if (p.translated && p.text) {
      const vi = norm(p.text);
      const viProbe = vi.slice(0, 40);
      // Only a leak if a long, distinctive Vietnamese fragment is visible.
      originalLeak = viProbe.length > 20 && text.includes(viProbe) && /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i.test(viProbe);
    }
    results.promptChecks.push({ game: g.slug, at: p.at, lang: p.lang, translated: p.translated, englishShown: shownOk, probe: probe.slice(0, 60), vietnameseLeak: originalLeak });
    if (!shownOk && !p.translated) fail++;
  }
}

// making-of table/ranking coverage
const mo = pages.__makingOf;
if (mo) {
  const t = norm((mo.desktop.expandedText || '') + ' ' + ((mo.desktop.info && mo.desktop.info.bodyText) || ''));
  const agg = {
    prompts: data.games.reduce((n, g) => n + g.prompts.length, 0),
    steps: data.games.reduce((n, g) => n + g.rounds.agentSteps + g.rounds.subagentSteps, 0),
    totalTokens: data.games.reduce((n, g) => n + g.totals.totalTokens, 0),
    cacheRead: data.games.reduce((n, g) => n + g.totals.cacheReadTokens, 0),
    output: data.games.reduce((n, g) => n + g.totals.outputTokens, 0),
    activeMs: data.games.reduce((n, g) => n + g.activeMs, 0),
  };
  const aggExpect = [
    ['agg prompts', count(agg.prompts)],
    ['agg agent steps', count(agg.steps)],
    ['agg tokens', compact(agg.totalTokens)],
    ['agg cache read', compact(agg.cacheRead)],
    ['agg output', compact(agg.output)],
    ['agg agent-hours', hours(agg.activeMs)],
  ];
  for (const [field, expected] of aggExpect) {
    const ok = t.includes(expected);
    results.checks.push({ game: 'all (making-of)', field, expected, found: ok });
    ok ? pass++ : fail++;
  }
  // agent-steps naming (post-rename requirement)
  results.makingOf = {
    usesAgentSteps: /agent steps/i.test(t),
    usesAgentTurns: /agent turns/i.test(t),
    definitionPresent: /A step is one\b|model response with its tool calls|one model response|each model response/i.test(t),
    snippet: (t.match(/.{0,120}agent steps.{0,180}/i) || [''])[0],
  };
  if (results.makingOf.usesAgentSteps) pass++; else fail++;
  if (!results.makingOf.usesAgentTurns) pass++; else fail++;
}

results.summary = { pass, fail, promptChecks: results.promptChecks.length, leaks: results.promptChecks.filter((p) => p.vietnameseLeak).length, englishMissing: results.promptChecks.filter((p) => !p.englishShown && !p.translated).length };
writeFileSync(join(here, `numbers-${label}.json`), JSON.stringify(results, null, 1));
console.log(JSON.stringify(results.summary, null, 1));
console.log('\nFAILED CHECKS:');
for (const c of results.checks.filter((c) => c.found === false)) console.log(' -', c.game, '|', c.field, '| expected:', JSON.stringify(c.expected), '| not found');
console.log('\nN/A (zero-value fields):');
for (const c of results.checks.filter((c) => c.n_a)) console.log(' -', c.game, '|', c.field, '| zero — display should say solo/none');
console.log('\nPROMPT CHECKS:');
for (const p of results.promptChecks) console.log(' -', p.game, p.at, p.lang, 'translated:', p.translated, '| English shown:', p.englishShown, '| VI leak:', p.vietnameseLeak, '|', p.probe.slice(0, 50));
console.log('\nMAKING-OF steps naming:', JSON.stringify(results.makingOf));
