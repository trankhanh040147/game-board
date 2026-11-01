// Independent recomputation of telemetry from raw DSH session logs.
// Deliberately does NOT import scripts/extract-sessions.mjs — this is a
// from-scratch sum to check data/telemetry/games.json.
// Run: node shots/qa/recompute-telemetry.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const SESSIONS = '/Users/vulcanlabs/.dsh/sessions/--Users-vulcanlabs-Documents-deepseek-harness-default-workspace--';
const games = JSON.parse(readFileSync(join(repo, 'data/telemetry/games.json'), 'utf8'));
const summary = JSON.parse(readFileSync(join(repo, 'data/telemetry/summary.json'), 'utf8'));

const TAX = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'];

function loadSession(id) {
  const dir = join(SESSIONS, id);
  const f = join(dir, 'session.v4.jsonl.zstd');
  if (!existsSync(f)) return null;
  const raw = execFileSync('zstd', ['-dc', f], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip corrupt */ }
  }
  return out;
}

const report = { generatedAt: new Date().toISOString(), source: SESSIONS, games: [] };
for (const g of games.games) {
  const meta = summary.perGame.find((p) => p.slug === g.slug);
  const ids = meta.sessionIds;
  const sums = Object.fromEntries(TAX.map((k) => [k, 0]));
  const perSession = [];
  const userKinds = {};
  const promptTexts = [];
  let assistantMsgs = 0, toolCalls = 0, usageEvents = 0;
  const models = new Set();
  let firstT = Infinity, lastT = -Infinity;
  for (const id of ids) {
    const ev = loadSession(id);
    if (!ev) { perSession.push({ id, missing: true }); continue; }
    const s = Object.fromEntries(TAX.map((k) => [k, 0]));
    let sAssistant = 0, sTools = 0, sUsage = 0, sUser = 0;
    for (const e of ev) {
      if (e.type === 'assistant/message') {
        sAssistant++;
        const u = e.data && e.data.usage;
        if (u) { sUsage++; for (const k of TAX) s[k] += Number(u[k] || 0); }
      } else if (e.type === 'user/message') {
        const src = (e.data && e.data.source && e.data.source.kind) || 'unknown';
        userKinds[src] = (userKinds[src] || 0) + 1;
        if (src === 'user') {
          sUser++;
          const txt = (e.data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
          // count only real human prompts: skip injected notices
          if (!/^(The approval policy changed|The sandbox mode changed|Your message was delivered|Agent message from)/.test(txt)) {
            promptTexts.push({ at: e.time, text: txt.slice(0, 200), len: txt.length });
          }
        }
      } else if (e.type === 'tool/call') sTools++;
      for (const k of ['createdAt', 'time']) if (typeof e[k] === 'number') { firstT = Math.min(firstT, e[k]); lastT = Math.max(lastT, e[k]); }
      if (e.data && e.data.message && e.data.message.model) models.add(e.data.message.model);
      if (e.data && e.data.model) models.add(e.data.model);
    }
    for (const k of TAX) sums[k] += s[k];
    assistantMsgs += sAssistant; toolCalls += sTools; usageEvents += sUsage;
    perSession.push({ id, events: ev.length, assistantMsgs: sAssistant, toolCalls: sTools, usageEvents: sUsage, userMessages: sUser, totals: s });
  }
  const expected = g.totals;
  const compare = {};
  for (const k of TAX) compare[k] = { raw: sums[k], json: expected[k], match: sums[k] === expected[k] };
  // agent steps: assistant/message events per session family minus? compare with rounds.agentSteps
  const rootSession = perSession.find((p) => p.id === g.rootSessionId);
  report.games.push({
    slug: g.slug,
    sessionIds: ids.length,
    sessionsFound: perSession.filter((p) => !p.missing).length,
    recomputedTotals: sums,
    jsonTotals: expected,
    totalsMatch: Object.values(compare).every((c) => c.match),
    compare,
    recomputed: {
      assistantMessagesAllSessions: assistantMsgs,
      assistantMessagesRoot: rootSession ? rootSession.assistantMsgs : null,
      toolCallsAllSessions: toolCalls,
      usageEvents,
      userMessagesByKind: userKinds,
      humanPrompts: promptTexts.length,
    },
    json: {
      agentSteps: g.rounds.agentSteps,
      subagentSessions: g.rounds.subagentSessions,
      subagentSteps: g.rounds.subagentSteps,
      userTurns: g.rounds.userTurns,
      prompts: g.prompts.length,
    },
    rawPrompts: promptTexts,
    perSession,
    firstEvent: firstT === Infinity ? null : new Date(firstT).toISOString(),
    lastEvent: lastT === -Infinity ? null : new Date(lastT).toISOString(),
    models: [...models],
  });
}

writeFileSync(join(here, 'telemetry-recompute.json'), JSON.stringify(report, null, 1));
for (const g of report.games) {
  console.log(`\n=== ${g.slug} ===`);
  console.log('sessions found', g.sessionsFound, '/', g.sessionIds);
  console.log('totals match JSON:', g.totalsMatch);
  for (const k of TAX) console.log(`  ${k}: raw=${g.recomputedTotals[k]} json=${g.jsonTotals[k]} ${g.compare[k].match ? 'OK' : 'MISMATCH'}`);
  console.log('raw assistant msgs (all sessions):', g.recomputed.assistantMessagesAllSessions, '| root:', g.recomputed.assistantMessagesRoot);
  console.log('raw human prompts:', g.recomputed.humanPrompts, '| JSON prompts:', g.json.prompts, '| JSON userTurns:', g.json.userTurns);
  console.log('user/message kinds:', JSON.stringify(g.recomputed.userMessagesByKind));
  console.log('tool calls (all):', g.recomputed.toolCallsAllSessions, '| JSON toolUsage sum:', '?');
  console.log('raw prompt texts:');
  for (const p of g.rawPrompts) console.log('   -', JSON.stringify(p.text.replace(/\s+/g, ' ').slice(0, 110)));
}
console.log('\nwrote shots/qa/telemetry-recompute.json');
