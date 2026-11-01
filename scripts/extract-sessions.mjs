#!/usr/bin/env node
/**
 * extract-sessions.mjs — rebuild the public "build history" telemetry for the
 * three browser games built in DeepSeek Harness (DSH) sessions.
 *
 * Reads zstd-compressed v4 session logs, walks each game's session family
 * (root + descendant subagent sessions), and writes:
 *
 *   data/telemetry/games.json    per-game dataset (prompts, tokens, rounds,
 *                                tool usage, subagent roster, thinking
 *                                excerpts, milestones, files)
 *   data/telemetry/summary.json  cross-game aggregate + provenance
 *   docs/BUILD-HISTORY.md        human-readable report derived from the JSON
 *
 * No third-party dependencies: zstd is shelled out to (it ships with macOS /
 * Homebrew), everything else is node: builtins.
 *
 * Usage:
 *   node scripts/extract-sessions.mjs
 *   node scripts/extract-sessions.mjs --sessions-dir <dir> --no-report
 *   DSH_SESSIONS_DIR=<dir> node scripts/extract-sessions.mjs
 *
 * Rerunnable and deterministic: only `generatedAt` changes between runs.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const DEFAULT_SESSIONS_DIR =
  '/Users/vulcanlabs/.dsh/sessions/--Users-vulcanlabs-Documents-deepseek-harness-default-workspace--';

const ZSTD_BIN = process.env.ZSTD_BIN || '/opt/homebrew/bin/zstd';

/** Project roots that appear in tool paths; stripped to repo-relative paths. */
const WORKSPACE_PREFIXES = (
  process.env.DSH_WORKSPACE_ROOTS ||
  [
    '/Users/vulcanlabs/Documents/deepseek-harness/default-workspace/',
    '/Users/vulcanlabs/Documents/deepseek-harness/',
    '/Users/vulcanlabs/src/gh/game-board/',
  ].join(',')
).split(',').filter(Boolean);

/**
 * The three in-scope game families. A family root is the session whose
 * `session/title` eventually becomes one of these exact titles (the human
 * renamed every session to "Game: <name>" on 2026-11-01).
 */
// Slug + title MUST match data/registry.json (the site's identity source of truth).
const GAME_DEFS = [
  {
    slug: 'alien-shooter',
    title: 'Alien Shooter',
    tagline:
      'A neon alien-shooter built from a single one-line prompt — one turn, no subagents, no dependencies and no bundler.',
    titlePattern: /^game:\s*island\s*shooter$/i,
    aliases: [
      'Game: IslandShooter',
      'IslandShooter',
      'Alien Shooter',
      'Game Alien Shooter',
      'Built cho tôi 1 con',
      'games/alien-shooter',
    ],
  },
  {
    slug: 'blade-and-mount',
    title: 'Blade & Mount',
    tagline:
      'A Mount & Blade-style 3D tournament fighter in the browser, built by a Lead agent and seven specialist subagents.',
    titlePattern: /^game:\s*blade\s*&\s*mouse$/i,
    aliases: [
      'Game: Blade&Mouse',
      'Blade&Mouse',
      'Blade&Mount',
      'Blade & Mount',
      'blade-and-mount',
      'games/blade-and-mount',
    ],
  },
  {
    slug: 'first-hearth',
    title: 'First Hearth',
    tagline:
      'A living-world civilisation simulation — one wanderer, an unnamed valley, a hearth — built by a studio of eight specialist subagents.',
    titlePattern: /^game:\s*first\s*hearth$/i,
    aliases: ['Game: First Hearth', 'First Hearth', 'INFINITE CIVILIZATION', 'games/first-hearth'],
  },
];

const MILESTONE_KINDS = new Set([
  'plan',
  'scaffold',
  'implement',
  'test',
  'build',
  'qa',
  'commit',
  'art',
  'ship',
]);

/** Exact published schema (keys are validated, not just assumed). */
const SCHEMA = {
  game: [
    'slug',
    'title',
    'tagline',
    'rootSessionId',
    'startedAt',
    'endedAt',
    'durationMs',
    'spanMs',
    'activeMs',
    'sessionCount',
    'models',
    'totals',
    'rounds',
    'prompts',
    'toolUsage',
    'subagents',
    'thinking',
    'milestones',
    'files',
  ],
  totals: ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'],
  rounds: ['userTurns', 'agentSteps', 'subagentSessions', 'subagentSteps'],
  prompt: ['at', 'text', 'textEn', 'lang', 'chars', 'translated'],
  subagent: ['id', 'label', 'model', 'steps', 'tokens', 'durationMs', 'firstPrompt', 'firstPromptEn'],
  thinking: ['totalChars', 'excerpts'],
  excerpt: ['at', 'text'],
  milestone: ['at', 'kind', 'label'],
  files: ['created', 'byExtension'],
};

function sameKeys(obj, expected) {
  const keys = Object.keys(obj).sort();
  const want = [...expected].sort();
  return keys.length === want.length && keys.every((k, i) => k === want[i]);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    sessionsDir: process.env.DSH_SESSIONS_DIR || DEFAULT_SESSIONS_DIR,
    gamesPath: path.join(REPO_ROOT, 'data', 'telemetry', 'games.json'),
    summaryPath: path.join(REPO_ROOT, 'data', 'telemetry', 'summary.json'),
    reportPath: path.join(REPO_ROOT, 'docs', 'BUILD-HISTORY.md'),
    report: true,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sessions-dir') opts.sessionsDir = argv[++i];
    else if (a.startsWith('--sessions-dir=')) opts.sessionsDir = a.slice('--sessions-dir='.length);
    else if (a === '--out') opts.gamesPath = path.resolve(argv[++i]);
    else if (a.startsWith('--out=')) opts.gamesPath = path.resolve(a.slice('--out='.length));
    else if (a === '--no-report') opts.report = false;
    else if (a === '--self-test') opts.selfTest = true;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  opts.summaryPath = path.join(path.dirname(opts.gamesPath), 'summary.json');
  return opts;
}

/**
 * --self-test: prove the redaction layer actually catches the secret shapes we
 * promise never to publish. Exits non-zero on the first miss.
 */
function selfTest() {
  const redactor = makeRedactor();
  // Samples are assembled at runtime so this file itself contains no
  // token-shaped literals (a secret scanner should find nothing here).
  const join = (...parts) => parts.join('');
  const rep = (ch, n) => ch.repeat(n);
  const samples = [
    join('ghp', '_', rep('a', 36)), // github token shape
    join('sk-', rep('b', 24)), // openai/deepseek key shape
    join('AKIA', rep('C', 16)), // aws access key id shape
    join('xoxb', '-', rep('1', 12), '-', rep('x', 12)), // slack token shape
    join('AIza', rep('d', 33)), // google api key shape
    join('eyJ', rep('e', 12), '.', rep('f', 12), '.', rep('g', 12)), // jwt shape
    join('-----BEGIN', ' RSA PRIVATE KEY-----\n', rep('h', 24), '\n-----END', ' RSA PRIVATE KEY-----'),
    join('OPENAI_API_KEY', '=', 'sk-', rep('i', 20)), // .env-style secret
    join('password', ': ', rep('j', 12)),
    join('someone.personal', '@', 'example.com'),
  ];
  const out = samples.map((sample, i) => redactor.redact(sample, `self-test[${i}]`));
  const leaked = out.filter((sample) =>
    /gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|xox[abpsr]-|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.|PRIVATE KEY|password|someone\.personal@/.test(
      sample,
    ),
  );
  const report = redactor.report();
  console.log(
    `self-test: ${samples.length} secret-shaped samples, ${report.total} redactions, ` +
      `${report.byKind ? Object.keys(report.byKind).length : 0} categories`,
  );
  for (const [kind, count] of Object.entries(report.byKind)) console.log(`  ${kind}: ${count}`);
  if (leaked.length) {
    console.error('self-test FAILED — unredacted output:', leaked);
    process.exit(1);
  }
  console.log('self-test PASSED — all samples redacted');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const TZ_OFFSET_MIN = 7 * 60; // every in-scope session ran in Asia/Saigon (UTC+7)

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

/** ISO-8601 with an explicit +07:00 offset (wall-clock readable, unambiguous). */
function iso(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  const d = new Date(ms + TZ_OFFSET_MIN * 60000);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` +
    `.${pad(d.getUTCMilliseconds(), 3)}+07:00`
  );
}

function humanLocal(ms) {
  if (ms == null) return '—';
  const d = new Date(ms + TZ_OFFSET_MIN * 60000);
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  );
}

function humanDuration(ms) {
  if (ms == null || ms < 0) return '—';
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 1) return `${Math.round(ms / 1000)} s`;
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  const parts = [];
  if (d) parts.push(`${d} d`);
  if (h) parts.push(`${h} h`);
  if (m && !d) parts.push(`${m} min`);
  return parts.join(' ') || `${totalMin} min`;
}

function nf(n) {
  return Number(n ?? 0).toLocaleString('en-US');
}

function pct(part, whole) {
  if (!whole) return '0%';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function trunc(s, n) {
  if (!s) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  return t.slice(0, n - 1).trimEnd() + '…';
}

function relPath(p) {
  if (!p) return '';
  let out = String(p).trim();
  for (const prefix of WORKSPACE_PREFIXES) {
    if (out.startsWith(prefix)) {
      out = out.slice(prefix.length);
      break;
    }
  }
  out = out.replace(/^\.\//, '');
  return out;
}

function extOf(p) {
  const base = path.basename(p);
  const idx = base.lastIndexOf('.');
  if (idx <= 0) return '(none)';
  const ext = base.slice(idx).toLowerCase();
  // Filter absurd "extensions" (long suffixes are filenames, not extensions).
  if (ext.length > 10) return '(none)';
  return ext;
}

function sortObjectByCount(obj) {
  return Object.fromEntries(
    Object.entries(obj).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  );
}

function safeJsonParse(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readSessionText(file) {
  try {
    return execFileSync(ZSTD_BIN, ['-dc', file], {
      maxBuffer: 1024 * 1024 * 1024,
      encoding: 'utf8',
    });
  } catch (err) {
    return execFileSync('zstd', ['-dc', file], {
      maxBuffer: 1024 * 1024 * 1024,
      encoding: 'utf8',
    });
  }
}

// ---------------------------------------------------------------------------
// Prompt cleaning
// ---------------------------------------------------------------------------

/**
 * Injected blocks are recorded as their own user/message events with a
 * non-"user" source kind (runtime-context, skill-catalog, time-context,
 * user-approval, agent-message, subagent-settled, tool-jobs,
 * working-directory). We only ever look at source.kind === 'user'.
 * As a belt-and-braces measure, strip inline system-reminder blocks and any
 * leading DSH control line that may have been folded into a human message.
 */
const INLINE_INJECTIONS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>\s*/gi,
  /^\s*The approval policy changed from [^\n]*(?:\n|$)/gim,
  /^\s*The DSH file policy[^\n]*(?:\n|$)/gim,
  /^\s*The working directory changed from [^\n]*(?:\n|$)/gim,
  /^\s*Time sampled while preparing turn [^\n]*(?:\n|$)/gim,
  /^\s*Current runtime context\. This snapshot supersedes [\s\S]*?(?=\n\n\S|$)/gim,
];

function cleanPromptText(raw) {
  let text = String(raw ?? '');
  for (const re of INLINE_INJECTIONS) text = text.replace(re, '');
  // Keep the human's text verbatim (including internal whitespace); only
  // normalise line endings and trim the outer edges.
  return text.replace(/\r\n/g, '\n').trim();
}

function messageTextContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/** Boilerplate paragraphs that DSH prepends to subagent mission prompts. */
const MISSION_NOISE = [
  /^Working directory:/i,
  /^Your shared task id\b/i,
  /^Today is\b/i,
  /^Current runtime context/i,
  /^You are an AI agent/i,
  /^Your task id is\b/i,
];

function missionExcerpt(raw, maxLen = 260) {
  const paragraphs = String(raw || '')
    .split(/\n{2,}/)
    .map((p) => p.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);
  const kept = paragraphs.filter((p) => !MISSION_NOISE.some((re) => re.test(p)));
  let text = (kept.length ? kept : paragraphs).join('\n\n');
  if (text.length > maxLen) text = text.slice(0, maxLen).trimEnd() + '…';
  return text;
}

function imageCountOf(content) {
  if (!Array.isArray(content)) return 0;
  return content.filter((b) => b && b.type === 'image').length;
}

// ---------------------------------------------------------------------------
// English translations for the published exhibit
//
// The site is English-only, but the dataset keeps the human's verbatim words.
// Each prompt therefore carries `text` (verbatim, original language) and
// `textEn` (faithful English translation; identical when the original already
// is English). Translations are keyed by SHA-256 of the verbatim text so that
// the mapping cannot drift silently if the log changes.
// ---------------------------------------------------------------------------

const VIETNAMESE_RE =
  /[ăâđêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/i;

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function detectPromptLang(text) {
  return VIETNAMESE_RE.test(text) ? 'vi' : 'en';
}

/** Filled when a Vietnamese prompt has no curated translation (should stay empty). */
const MISSING_TRANSLATIONS = [];

const PROMPT_TRANSLATIONS = new Map([
  [
    'c209911293e707794e3a0df8b8906014ba1120a53656049be249bdad8283edf2',
    {
      lang: 'vi',
      en: `Build me an Alien Shooter game.`,
    },
  ],
  [
    'a47cdf0fe7b997bcd69a67bf1d6382a91b9e0983437ccc209b578960fb5f0f7c',
    {
      lang: 'vi',
      en: `Please build me the game Blade And Mount — build a Tournament mode where the fighting feels real. Use 3D or some engine, up to you, just make sure the quality is like a real game. Take as long as you want.

Based on what I've found out about this mode:
## 1. Explaining the parameters in the image

[Mount & Blade: Warband - release date, videos, screenshots, reviews on RAWG](https://images.openai.com/static-rsc-4/aRWe0Is09VoZWdtSdZxogehCijZ4ibacjDXTue_0B2pwSRFs56P0dU8XNW3tjZlkhfDPWPdhCkUjBp8CYUApuD1dsu-ZCMjoKDNUFjGx9wVFvLCs7FiA8C5RdJrh1ZT6Z2UQC5bgxu4YQvN5SUuW9sIbL9pufsWu633vKmw9V20?purpose=inline)

[rawg.io](https://rawg.io/games/mount-blade-warband?utm_source=chatgpt.com)

In the top-left corner:

| Parameter               | Meaning                                    |
| ----------------------- | ------------------------------------------ |
| Opponents Beaten: 9     | You have knocked out 9 opponents           |
| Opponents Remaining: 26 | 26 opponents have not been knocked out yet |

So at the time the screenshot was taken, you had knocked out 9 people and there were still 26 opponents left.

In the bottom-left corner:

- Speed bonus: +14%: The attack gets bonus damage from movement speed.
- Delivered 27 damage: You just dealt 27 damage.
- Regular Fighter knocked unconscious: A regular fighter has been knocked unconscious.
- You got 8 experience: You received 8 experience points.

## 2. The Melee Fight mechanic in Mount & Blade

This is the free-for-all style of combat in the arena.

[Mount & Blade: Warband - release date, videos, screenshots, reviews on RAWG](https://images.openai.com/static-rsc-4/aRWe0Is09VoZWdtSdZxogehCijZ4ibacjDXTue_0B2pwSRFs56P0dU8XNW3tjZlkhfDPWPdhCkUjBp8CYUApuD1dsu-ZCMjoKDNUFjGx9wVFvLCs7FiA8C5RdJrh1ZT6Z2UQC5bgxu4YQvN5SUuW9sIbL9pufsWu633vKmw9V20?purpose=inline)

How it works:

1. You step into the arena.
2. The system brings many opponents onto the field.
3. Everyone fights free-for-all; there is no team of yours or enemy team.
4. You have to knock out as many opponents as possible.
5. If you are knocked unconscious, the fight ends.
6. The reward depends on how many people you knock out.

One notable point: opponents don't necessarily all appear at the start. The game can bring in more opponents in waves. When the number of remaining people gets low, the remaining opponents may appear faster.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://mountandblade.fandom.com\\&sz=32)

Fandom



Rewards by number of opponents knocked out (classic Mount & Blade mechanic):

| Opponents knocked out | Denars | XP  |
| --------------------- | ------ | --- |
| 0–2                   | 0      | 0   |
| 3–5                   | 5      | 5   |
| 6–9                   | 10     | 10  |
| 10–19                 | 25     | 10  |
| 20+                   | 60     | 10  |
| Final victory         | 250    | 200 |

This is the Melee Fight reward table in the classic version; other versions or mods may adjust it.&#x20;

[image](https://www.google.com/s2/favicons?domain=https://mountandblade.fandom.com\\&sz=32)

Fandom



## 3. The actual Tournament mechanic

Tournament is a competition with multiple rounds, unlike Melee Fight.

[Mount & Blade: Warband - release date, videos, screenshots, reviews on RAWG](https://images.openai.com/static-rsc-4/aRWe0Is09VoZWdtSdZxogehCijZ4ibacjDXTue_0B2pwSRFs56P0dU8XNW3tjZlkhfDPWPdhCkUjBp8CYUApuD1dsu-ZCMjoKDNUFjGx9wVFvLCs7FiA8C5RdJrh1ZT6Z2UQC5bgxu4YQvN5SUuW9sIbL9pufsWu633vKmw9V20?purpose=inline)

[Mount Blade Warband \\[WIP\\]\\[SP\\]\\[TR\\]Floris Mod Pack & %100 Tamamlanmış Türkçe Yama (Güncelleme:1.1) | DonanımHaber Forum](https://images.openai.com/static-rsc-4/D_7ppf0Zgk_jVU7CsMNbOUzTeJlJX67NugZUSd7PVLWz2DwJtKABMXMDBtatcTyDFFCa1Hxp3wNZOc4NaMe6HmZrIHawmDejeqzDLjWwpsJp8EuxHDwyLrY1-Vn3YyMMW_fIZSn9PMKJewpvg6u7b5BYg4zsK9y4rsIh0234OIc?purpose=inline)

[Ragnar Lodbrok - Chapter 2: The Velvet Viking : r/mountandblade](https://images.openai.com/static-rsc-4/eTUii9VCa_Ap5ppahyYqcx6p-fZXN_xR5K_kSntzayGij2zSDPc4vE_zlC-lHQRflPLiJpw56xmqxFB2NEaX7WN4UtjM7D14oVh9tl0xQ0go9773FaGZmyhyLU240r6e0Vktg872TOvBa_ByX074fYu7rl6O8MUAkt2BcyCdkz0?purpose=inline)

6

In Mount & Blade: Warband:

- 2–4 teams take part.
- Each team has 1–8 fighters.
- You are placed on a random team.
- Equipment is provided by the system.
- You have to fight through many rounds.
- Being knocked out does not always mean immediate elimination: in the early rounds you can still qualify to advance.

The classic Tournament has 6 tiers.

Tournament rewards:

- Prize money when you win.
- You can bet on yourself before each round.
- Increases renown.
- Increases relations with the city.
- A chance to win and impress a lady.&#x20;

  [image](https://www.google.com/s2/favicons?domain=https://mountandblade.fandom.com\\&sz=32)

  Fandom+1



## 4. What if you're playing Bannerlord?

[135. Renown at tournaments at Mount & Blade II: Bannerlord Nexus - Mods and community](https://images.openai.com/static-rsc-4/pTXrsdNcSMrNRYY_PmIH9aAAt-RfJB87Jl4RiGx_wl7NfuqypXXFG2cGn0VaFoo_dZ0PW8vC6_zeKyFyuEgSLUete7oFR5_bypbby5Xqv3VBykjIKQcm-PUNjPB5rUp3Tn83-B71KP38D_AVikN9J2J8ZwZC4h8ssAQlovNIu44?purpose=inline)

[nexusmods.com](https://www.nexusmods.com/mountandblade2bannerlord/articles/1249?utm_source=chatgpt.com)

In Mount & Blade II: Bannerlord, the Tournament has a different mechanic:

- Usually 16 participants.
- Split into teams.
- 4 rounds.
- Eliminated teams do not advance.
- You can bet up to 150 denars per round (300 with the Deep Pockets perk).
- The winner receives an equipment or horse reward.&#x20;

  [image](https://www.google.com/s2/favicons?domain=https://mountandblade.fandom.com\\&sz=32)

  Fandom+1



## 5. I want to pinpoint exactly which version you're playing

Looking at the image, I want to confirm one detail so I can explain the mechanics correctly, especially how scoring and rewards are calculated.

Which version are you playing?

Mount & Blade: Warband

Mount & Blade II: Bannerlord

Mount & Blade (the original)

A mod (Perisno, Floris, etc.)

Not sure which version

Which mode do you want to understand?

Free-for-all arena combat (as in the image)

Tournament – a multi-round competition

Both, including prize money, XP and how to win

Confirm

I can analyze in depth how the system spawns opponents, calculates damage and XP, and how to make money efficiently from the arena.

https://www.youtube.com/watch?v=cUYw0S8bxiM`,
    },
  ],
  [
    'f4f563f804104fabcf206323ac58c82fa84b64fd450758de030ddf17a16a3f1a',
    {
      lang: 'vi',
      en: `Not good yet — the movement isn't smooth at all, and the strikes don't touch the body -> it looks like fighting from a distance, a game bug. When moving, every now and then the foot doesn't lift off the ground at all.`,
    },
  ],
  [
    '3bb68ee5f6496453ce5e61d6b1fded58054d8df7d1463088b22e5a14d49c1bed',
    {
      lang: 'vi',
      en: `It's a bit better now, but still not good enough.
The movement is very awkward — everything from moving, dodging to fighting looks very stiff, not smooth and fluid like those world-class games -> we may need to research more to improve it.
When the enemy falls it isn't a collapse animation either, they just stay standing there.
And there's no variety of weapons for the player to choose from.`,
    },
  ],
  [
    'b159e0a8bb34e1a787c9644022dda3a58c5d238636756627d8e741cb6277584b',
    {
      lang: 'vi',
      en: `Please stop the server for me.`,
    },
  ],
  [
    '245515622a7de08aa7834df0f7b723f1e9eafb2d38e08f026e8ff9d14d487659',
    {
      lang: 'vi',
      en: `There are quite a lot of problems right now, find and fix the root cause:
- The game is quite stuttery and laggy, it feels like 1 FPS, or some kind of glitching
- Decisions keep having to be made constantly; the player hasn't had time to do anything before having to make decisions continuously.
- When you first enter the game there's no tutorial (Game Tour), I don't understand anything at all`,
    },
  ],
  [
    'cf1ee5cf9546928d1862f30889c575e3462c7928cd847b3685f8630441f645e6',
    {
      lang: 'vi',
      en: `move this conversation into the game-board workspace`,
    },
  ],
]);

/**
 * Returns the language of a prompt plus its English rendering. English prompts
 * pass through unchanged; Vietnamese prompts use the curated map above.
 */
function translatePrompt(text) {
  const lang = detectPromptLang(text);
  if (lang === 'en') return { lang, textEn: text, translated: false };
  const hash = sha256Hex(text);
  const hit = PROMPT_TRANSLATIONS.get(hash);
  if (hit) return { lang, textEn: hit.en, translated: true };
  MISSING_TRANSLATIONS.push({ lang, hash, chars: text.length, head: text.slice(0, 120) });
  return { lang, textEn: text, translated: false };
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { kind: 'api-key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'slack-token', re: /\bxox[abpsr]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'google-key', re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi },
  {
    kind: 'private-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    kind: 'env-secret',
    re: /\b([A-Z][A-Z0-9_]{2,}(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_PASS|API_KEY|ACCESS_KEY))\s*[:=]\s*["']?([^\s"']{6,})/g,
  },
  { kind: 'password', re: /\b(?:password|passwd|pwd)\s*[:=]\s*["']?([^\s"']{6,})/gi },
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
];

function makeRedactor() {
  const counts = new Map();
  const locations = new Map();
  function redact(value, where) {
    if (typeof value !== 'string' || !value) return value;
    let out = value;
    for (const { kind, re } of SECRET_PATTERNS) {
      out = out.replace(re, (match) => {
        counts.set(kind, (counts.get(kind) || 0) + 1);
        const locs = locations.get(where) || new Set();
        locs.add(kind);
        locations.set(where, locs);
        return kind === 'email' ? '[REDACTED-EMAIL]' : '[REDACTED]';
      });
    }
    return out;
  }
  function report() {
    return {
      total: [...counts.values()].reduce((a, b) => a + b, 0),
      byKind: sortObjectByCount(Object.fromEntries(counts)),
      locations: [...locations.entries()]
        .map(([where, kinds]) => ({ where, kinds: [...kinds].sort() }))
        .sort((a, b) => a.where.localeCompare(b.where)),
    };
  }
  return { redact, report };
}

// ---------------------------------------------------------------------------
// Pass 1 — index every session dir (header + all title events)
// ---------------------------------------------------------------------------

function indexSessions(sessionsDir) {
  if (!fs.existsSync(sessionsDir)) {
    throw new Error(`Sessions dir not found: ${sessionsDir}`);
  }
  const dirs = fs
    .readdirSync(sessionsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(sessionsDir, d.name))
    .filter((d) => fs.existsSync(path.join(d, 'session.v4.jsonl.zstd')))
    .sort();

  const sessions = new Map();
  for (const dir of dirs) {
    const file = path.join(dir, 'session.v4.jsonl.zstd');
    let text;
    try {
      text = readSessionText(file);
    } catch (err) {
      console.warn(`  ! cannot decompress ${file}: ${err.message}`);
      continue;
    }
    const lines = text.split('\n');
    let header = null;
    const titles = [];
    let firstHumanPrompt = null;
    let humanPromptCount = 0;
    let lastTime = null;
    for (const line of lines) {
      if (!line) continue;
      // Cheap pre-filter: pass-1 only cares about a handful of event types.
      if (
        !header &&
        line.startsWith('{"type":"session"')
      ) {
        try {
          header = JSON.parse(line);
        } catch {
          /* ignore */
        }
        continue;
      }
      if (
        !line.includes('"type":"session/title"') &&
        !line.includes('"type":"user/message"') &&
        !line.includes('"type":"turn/end"')
      ) {
        continue;
      }
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      const d = ev.data || {};
      if (typeof ev.time === 'number' && (!lastTime || ev.time > lastTime)) lastTime = ev.time;
      if (ev.type === 'session/title' && d.title) {
        titles.push({
          title: d.title,
          at: ev.time,
          source: (d.source && d.source.kind) || 'unknown',
        });
      } else if (ev.type === 'user/message' && (d.source || {}).kind === 'user') {
        humanPromptCount += 1;
        if (firstHumanPrompt == null) {
          firstHumanPrompt = cleanPromptText(messageTextContent(d.content));
        }
      } else if (ev.type === 'turn/end' && typeof ev.time === 'number') {
        // Tracked separately below; kept here only to advance lastTime.
      }
    }
    if (!header || !header.id) {
      console.warn(`  ! no session header in ${file} (skipped)`);
      continue;
    }
    sessions.set(header.id, {
      id: header.id,
      dirName: path.basename(dir),
      file,
      header,
      createdAt: header.createdAt,
      parentSession: header.parentSession || null,
      cwd: header.cwd || '',
      agentPreset: header.agentPreset || null,
      delegationDepth: header.delegationDepth ?? null,
      titles,
      finals: titles.length ? titles[titles.length - 1].title : null,
      firstHumanPrompt,
      humanPromptCount,
      lastTime,
    });
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// Family selection
// ---------------------------------------------------------------------------

function resolveFamilies(sessions) {
  const used = new Set();
  const families = [];
  for (const def of GAME_DEFS) {
    const candidates = [...sessions.values()]
      .filter((s) => !s.parentSession && s.titles.some((t) => def.titlePattern.test(t.title || '')))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    if (!candidates.length) {
      throw new Error(
        `Could not find a root session whose session/title matches ${def.titlePattern}. ` +
          `Pass --sessions-dir or check the title pattern.`,
      );
    }
    const root = candidates[0] || null;
    // Walk descendants via the session header's parentSession link.
    const familyIds = [root.id];
    const queue = [root.id];
    while (queue.length) {
      const cur = queue.shift();
      for (const s of sessions.values()) {
        if (s.parentSession === cur && !familyIds.includes(s.id)) {
          familyIds.push(s.id);
          queue.push(s.id);
        }
      }
    }
    // Guard: never claim a session twice.
    for (const id of familyIds) used.add(id);
    families.push({ def, root, sessions: familyIds.map((id) => sessions.get(id)) });
  }
  const excluded = [...sessions.values()].filter((s) => !used.has(s.id));
  return { families, used, excluded };
}

// ---------------------------------------------------------------------------
// Pass 2 — full parse of an in-scope session
// ---------------------------------------------------------------------------

function parseSession(session) {
  const text = readSessionText(session.file);
  const rec = {
    id: session.id,
    createdAt: session.createdAt,
    agentPreset: session.agentPreset,
    parentSession: session.parentSession,
    lines: 0,
    outOfOrder: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    },
    usageEvents: 0,
    duplicateUsageEvents: 0,
    assistantMessages: 0,
    steps: 0,
    turns: 0,
    turnDurations: [],
    models: new Map(),
    titles: [],
    prompts: [], // {seq, at, text, chars, images}
    promptsRaw: 0,
    promptsSkipped: 0,
    reasoning: [], // {seq, at, turn, step, text} — blocks long enough to sample
    reasoningChars: 0, // every reasoning character, including short blocks
    calls: [],
    results: new Map(),
    children: [], // subagent/catalog entries
    teamMembers: new Map(),
    presented: [], // deliverables/presented
    todos: 0,
    firstEventTime: null,
    lastEventTime: null,
    firstBuildTime: null, // last activity that is not a title-only rename
    toolCalls: 0,
    errorResults: 0,
  };

  const seenUsageIds = new Set();
  const openTurns = new Map();
  let prevTime = null;

  const lines = text.split('\n');
  for (const line of lines) {
    if (!line) continue;
    rec.lines += 1;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const type = ev.type;
    if (type === 'session') continue; // header already parsed
    const d = ev.data || {};
    const time = typeof ev.time === 'number' ? ev.time : null;
    if (time != null) {
      if (rec.firstEventTime == null || time < rec.firstEventTime) rec.firstEventTime = time;
      if (rec.lastEventTime == null || time > rec.lastEventTime) rec.lastEventTime = time;
      if (prevTime != null && time < prevTime) rec.outOfOrder += 1;
      prevTime = time;
    }
    switch (type) {
      case 'user/message': {
        const kind = (d.source || {}).kind || 'unknown';
        const textPart = cleanPromptText(messageTextContent(d.content));
        if (kind === 'user') {
          rec.promptsRaw += 1;
          if (textPart && textPart.length > 0) {
            rec.prompts.push({
              seq: ev.seq ?? null,
              at: time,
              text: textPart,
              chars: textPart.length,
              images: imageCountOf(d.content),
            });
            if (rec.firstBuildTime == null || time > rec.firstBuildTime) {
              // human prompt is always "build activity"
              rec.firstBuildTime = time;
            }
          } else {
            rec.promptsSkipped += 1;
          }
        }
        break;
      }
      case 'assistant/message': {
        rec.assistantMessages += 1;
        const msg = d.message || {};
        const msgId = msg.id || `seq:${ev.seq}`;
        if (!seenUsageIds.has(msgId)) {
          seenUsageIds.add(msgId);
          const u = d.usage || {};
          rec.usageEvents += 1;
          for (const k of [
            'inputTokens',
            'outputTokens',
            'cacheReadTokens',
            'cacheWriteTokens',
            'totalTokens',
          ]) {
            rec.usage[k] += typeof u[k] === 'number' ? u[k] : 0;
          }
        } else {
          rec.duplicateUsageEvents += 1;
        }
        const model = ((msg.source || {}).model || '').trim();
        if (model) rec.models.set(model, (rec.models.get(model) || 0) + 1);
        const content = Array.isArray(msg.content) ? msg.content : [];
        for (const block of content) {
          if (block && block.type === 'reasoning' && typeof block.text === 'string') {
            const rtext = block.text.trim();
            rec.reasoningChars += rtext.length;
            // Excerpts are 200–1200 chars, so shorter blocks are counted but
            // not kept as candidates.
            if (rtext.length >= 200) {
              rec.reasoning.push({
                seq: ev.seq ?? null,
                at: time,
                turn: d.turn ?? null,
                step: d.step ?? null,
                text: rtext,
              });
            }
          }
        }
        break;
      }
      case 'step/start':
        rec.steps += 1;
        break;
      case 'turn/start':
        rec.turns += 1;
        if (time != null) openTurns.set(d.turn ?? rec.turns, time);
        break;
      case 'turn/end': {
        const t = d.turn ?? rec.turns;
        const start = openTurns.get(t);
        if (start != null && time != null && time >= start) {
          rec.turnDurations.push({ turn: t, start, end: time, ms: time - start });
          openTurns.delete(t);
        }
        if (time != null) {
          rec.firstBuildTime = rec.firstBuildTime == null ? time : Math.max(rec.firstBuildTime, time);
        }
        break;
      }
      case 'tool/call': {
        rec.toolCalls += 1;
        const name = d.name || 'unknown';
        const args = safeJsonParse(d.arguments);
        const call = {
          seq: ev.seq ?? null,
          time,
          turn: d.turn ?? null,
          step: d.step ?? null,
          name,
          callId: d.callId || null,
        };
        if (name === 'write' || name === 'edit' || name === 'read') {
          call.path = args && typeof args.file_path === 'string' ? args.file_path : null;
        } else if (name === 'bash') {
          call.command = args && typeof args.command === 'string' ? args.command : '';
        } else if (name === 'todo_write') {
          call.todoCount = args && Array.isArray(args.todos) ? args.todos.length : 0;
        } else if (name === 'team_task_create') {
          call.subject = args && typeof args.subject === 'string' ? args.subject : '';
        } else if (name === 'create_goal') {
          call.objective = args && typeof args.objective === 'string' ? args.objective : '';
        } else if (name === 'present') {
          call.files = args && Array.isArray(args.files) ? args.files : [];
        } else {
          call.argsText = d.arguments ? String(d.arguments) : '';
        }
        rec.calls.push(call);
        break;
      }
      case 'tool/result': {
        const msg = d.message || {};
        const callId = msg.toolCallId || (msg.source || {}).callId || null;
        const textOut = messageTextContent(msg.content);
        if (msg.isError) rec.errorResults += 1;
        if (callId) {
          const prev = rec.results.get(callId);
          if (!prev) {
            rec.results.set(callId, {
              isError: Boolean(msg.isError),
              text: textOut,
            });
          } else if (prev.text.length < textOut.length) {
            prev.text = textOut;
            prev.isError = prev.isError || Boolean(msg.isError);
          }
        }
        break;
      }
      case 'subagent/catalog': {
        if (d.childId) {
          rec.children.push({
            childId: d.childId,
            label: d.label || '',
            mode: d.mode || '',
            at: time,
            childCreatedAt: d.childCreatedAt ?? null,
          });
        }
        break;
      }
      case 'team/member': {
        const m = d.member || d;
        if (m && m.id) {
          rec.teamMembers.set(m.id, {
            name: m.name || '',
            description: m.description || '',
            status: m.status || '',
          });
        }
        break;
      }
      case 'deliverables/presented': {
        if (Array.isArray(d.files)) {
          rec.presented.push({ at: time, files: d.files });
        }
        break;
      }
      case 'session/title': {
        rec.titles.push({
          title: d.title || '',
          at: time,
          source: (d.source && d.source.kind) || 'unknown',
        });
        break;
      }
      default:
        break;
    }
  }

  // Unpaired turn starts still count as activity end time.
  for (const start of openTurns.values()) {
    rec.firstBuildTime = rec.firstBuildTime == null ? start : Math.max(rec.firstBuildTime, start);
  }
  if (rec.firstBuildTime == null) rec.firstBuildTime = rec.lastEventTime;
  rec.modelsTop = [...rec.models.entries()].sort((a, b) => b[1] - a[1]);
  rec.modalModel = rec.modelsTop.length ? rec.modelsTop[0][0] : null;
  return rec;
}

// ---------------------------------------------------------------------------
// File-creation extraction (write calls + bash heredocs/redirects)
// ---------------------------------------------------------------------------

const BASH_FILE_PATTERNS = [
  /\bcat\s*>>?\s*([^\s;|&<>()"']+)/g,
  /\btee\s+(?:-a\s+)?([^\s;|&<>()"']+)/g,
  /(?:^|[\s&;])>>?\s*([\w./-]+\.(?:ts|tsx|js|mjs|cjs|json|css|html|md|txt|svg|ya?ml|glsl|wgsl))\b/g,
];

function createdFilesOf(recs) {
  const byPath = new Map();
  const push = (rawPath, time, via) => {
    if (!rawPath) return;
    let p = String(rawPath).trim();
    if (!p || p === '&1' || p === '&2' || p.startsWith('&')) return;
    if (p.startsWith('/tmp/') || p.includes('/node_modules/') || p.startsWith('/dev/')) return;
    const rel = relPath(p);
    if (!rel || rel.startsWith('/') || rel.startsWith('../') || rel.startsWith('~')) return;
    if (rel.includes('node_modules/')) return;
    const prev = byPath.get(rel);
    if (!prev) byPath.set(rel, { path: rel, time, via });
    else if (time != null && (prev.time == null || time < prev.time)) {
      prev.time = time;
      prev.via = via;
    }
  };
  for (const rec of recs) {
    for (const call of rec.calls) {
      if (call.name === 'write' && call.path && typeof call.path === 'string') {
        push(call.path, call.time, 'write');
      } else if (call.name === 'bash' && call.command) {
        for (const re of BASH_FILE_PATTERNS) {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(call.command)) !== null) push(m[1], call.time, 'bash');
        }
      }
    }
  }
  return [...byPath.values()].sort((a, b) => (a.time ?? 0) - (b.time ?? 0) || a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

/** Strip `<<'EOF' … EOF` bodies: file *contents* must never look like commands. */
function stripHeredocs(command) {
  const lines = String(command || '').split('\n');
  const out = [];
  let marker = null;
  for (const line of lines) {
    if (marker) {
      if (line.trim() === marker) marker = null;
      continue;
    }
    out.push(line);
    const m = line.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (m) marker = m[1];
  }
  return out.join('\n');
}

/** Executable shell segments: split on && || ; | and newlines, drop heredoc bodies. */
function shellSegments(command) {
  return stripHeredocs(command)
    .split(/&&|\|\||;|\n|\|/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A segment with leading env assignments / `time` / `sudo` removed. */
function executable(seg) {
  return seg
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '')
    .replace(/^(?:time|sudo|command|do|then)\s+/, '')
    .trim();
}

/** First segment whose executable form matches `re`, returned whole for labels. */
function findSegment(segments, re) {
  for (const seg of segments) {
    if (re.test(executable(seg))) return executable(seg);
  }
  return '';
}

function cmdShort(command) {
  const seg = shellSegments(command)[0] || String(command || '');
  const c = seg.replace(/\s+/g, ' ').trim();
  const patterns = [
    /npm run build/,
    /npm test/,
    /npx vitest run/,
    /vitest run/,
    /npx vitest/,
    /npx vite build/,
    /vite build/,
    /npx tsc --noEmit/,
    /tsc --noEmit/,
    /node (tools|tests)\/[\w./-]+/,
    /npx playwright/,
    /git commit/,
    /npm run typecheck/,
  ];
  for (const p of patterns) {
    const m = c.match(p);
    if (m) return m[0];
  }
  return c.split(/\s+/).slice(0, 3).join(' ');
}

/** Pass/fail evidence from a tool result, tailored to the kind of command. */
function testEvidence(text) {
  if (!text) return '';
  const t = String(text).replace(/\s+/g, ' ');
  const m1 = t.match(/Tests\s+(\d+)\s+passed/) || t.match(/Test Files\s+(\d+)\s+passed/);
  if (m1) return `${m1[1]} passed`;
  const m2 = t.match(/(\d+)\s+passed/) || t.match(/(\d+)\s*\/\s*(\d+)\s+(?:checks?\s+)?pass/i);
  if (m2) return m2[0];
  if (/\bfailed\b/i.test(t) || /FAIL\s/.test(t)) return 'failures reported';
  return '';
}

function buildEvidence(text) {
  if (!text) return '';
  const t = String(text).replace(/\s+/g, ' ');
  const m = t.match(/built in [\d.]+ ?s/i) || t.match(/✓ \d+ modules transformed/);
  if (m) return m[0];
  return '';
}

function typecheckEvidence(text) {
  if (!text) return '';
  const t = String(text).replace(/\s+/g, ' ');
  const m = t.match(/(\d+)\s+error TS/);
  if (m) return `${m[1]} TS error(s)`;
  return /error TS/.test(t) ? 'TS errors' : 'clean';
}

/** Short, human label for a headless-QA command: screenshot name or script. */
function qaShort(segment) {
  if (!segment) return '';
  const out = segment.match(/--out\s+["']?([^\s"']+)/);
  if (out) {
    const rel = relPath(out[1]);
    return rel.startsWith('/') ? path.basename(rel) : rel;
  }
  const script = segment.match(/(?:node\s+|cat >\s*)([\w.-]*\.mjs)/);
  if (script) return script[1];
  return cmdShort(segment);
}

const TEST_CMD = [
  { re: /^npm test\b/, short: 'npm test' },
  { re: /^npx vitest run\b/, short: 'vitest run' },
  { re: /^vitest run\b/, short: 'vitest run' },
  { re: /^npx vitest\b/, short: 'vitest' },
  { re: /^node (?:tools|tests)\/[\w./-]*test[\w./-]*/, short: null },
];

const BUILD_CMD = [
  { re: /^npm run build\b/, short: 'npm run build' },
  { re: /^npx vite build\b/, short: 'npx vite build' },
  { re: /^vite build\b/, short: 'vite build' },
  { re: /^npm run typecheck\b/, short: 'npm run typecheck' },
];

const QA_CMD =
  /^(?:node|npx|bash|sh|zsh|deno|bun)\s+(?!-e\b)[^;|&]*?(?:tools\/shot\.mjs|(?:^|[\s/])shot\.mjs|tools\/qa\/|playwright test|puppeteer\s|playwright\s|profile-fps|profile-render|profile-panels|acceptance|final-check|realtime-check|tour-check|skip-check|look-fog|live-decisions|\/tmp\/pwtest)/;

// ---------------------------------------------------------------------------
// Repository history
//
// Commit milestones are read from the real git history, never invented:
//   alien-shooter    → plain folder, no repo history (verified by path query)
//   blade-and-mount  → its own 5-commit history, imported via a subtree merge
//   first-hearth     → the pre-monorepo history that preceded the restructure
// ---------------------------------------------------------------------------

function runGit(args) {
  try {
    return execFileSync('git', ['-C', REPO_ROOT, ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

const COMMIT_CACHE = new Map();
const REPO_NOISE =
  /^(?:chore\(repo\)|chore\(workspace\)|feat\(data\)|chore: merge|Initial commit|chore: import)(?=$|:|\s)/i;

function commitInfo(shas) {
  const out = [];
  for (const sha of shas) {
    const line = runGit(['show', '-s', '--format=%h%x09%at%x09%s', sha]);
    if (!line) continue;
    const [shortSha, at, ...subjectParts] = line.split('\t');
    const time = Number(at) * 1000;
    if (!shortSha || !Number.isFinite(time)) continue;
    out.push({ sha: shortSha, time, subject: subjectParts.join('\t').trim() });
  }
  return out;
}

function repoCommitsFor(slug) {
  if (COMMIT_CACHE.has(slug)) return COMMIT_CACHE.get(slug);
  let commits = [];
  if (runGit(['rev-parse', '--is-inside-work-tree']) === 'true') {
    if (slug === 'blade-and-mount') {
      const importSha =
        runGit(['log', '--all', '--format=%H', '--grep=import Blade & Mount', '-1']).split('\n')[0] || '';
      if (importSha) {
        const shas = runGit(['rev-list', '--reverse', `${importSha}^2`]).split('\n').filter(Boolean);
        commits = commitInfo(shas).filter((c) => !REPO_NOISE.test(c.subject));
      }
    } else if (slug === 'first-hearth') {
      const restructure =
        runGit(['log', '--all', '--format=%H', '--grep=restructure into a monorepo', '-1']).split('\n')[0] || '';
      if (restructure) {
        const firstParent = runGit(['rev-parse', `${restructure}^`]);
        const shas = runGit(['rev-list', '--reverse', firstParent]).split('\n').filter(Boolean);
        commits = commitInfo(shas).filter((c) => !REPO_NOISE.test(c.subject));
      }
    } else {
      // alien-shooter was built as a plain folder in a scratch workspace with
      // no git repo (verified in its session log: no git init/commit ever ran),
      // and the monorepo import carries no game history. There are no build
      // commits to publish — do not mine later editorial commits from the
      // monorepo, they are not part of the build.
      commits = [];
    }
  }
  COMMIT_CACHE.set(slug, commits);
  return commits;
}

function buildMilestones(recs, createdFiles, gameDef, repoCommits) {
  const childrenById = new Map();
  for (const rec of recs) {
    for (const c of rec.children) childrenById.set(c.childId, { ...c, parent: rec.id });
  }
  const merged = [];
  for (const rec of recs) {
    for (const call of rec.calls) merged.push({ rec, call });
  }
  merged.sort((a, b) => (a.call.time ?? 0) - (b.call.time ?? 0));

  const candidates = [];
  const add = (time, kind, label, isSpawn = false) => {
    if (!time || !label) return;
    candidates.push({ time, kind, label: label.trim(), isSpawn });
  };

  // plan — todo list / goal / shared task board / first design doc
  const firstTodo = merged.find(({ call }) => call.name === 'todo_write' && call.todoCount > 0);
  if (firstTodo) add(firstTodo.call.time, 'plan', `Plan written: ${firstTodo.call.todoCount} todos queued`);
  const firstGoal = merged.find(({ call }) => call.name === 'create_goal' && call.objective);
  if (firstGoal) add(firstGoal.call.time, 'plan', `Goal set: ${trunc(firstGoal.call.objective, 100)}`);
  const firstTask = merged.find(({ call }) => call.name === 'team_task_create' && call.subject);
  if (firstTask) add(firstTask.call.time, 'plan', `Shared task board opened: ${trunc(firstTask.call.subject, 100)}`);
  const firstDesignDoc = createdFiles.find((f) => /(^|\/)docs\/[^/]+\.md$/i.test(f.path) && !/qa/i.test(f.path));
  if (firstDesignDoc) add(firstDesignDoc.time, 'plan', `Design doc: ${firstDesignDoc.path}`);

  // scaffold — very first file created anywhere
  if (createdFiles.length) {
    add(createdFiles[0].time, 'scaffold', `First file written: ${createdFiles[0].path}`);
  }

  // implement — first source file
  const firstSource = createdFiles.find(
    (f) => /\.(ts|tsx|js|jsx|mjs)$/i.test(f.path) && !/(^|\/)(tests?|tools)\//.test(f.path),
  );
  if (firstSource) add(firstSource.time, 'implement', `First source module: ${firstSource.path}`);

  // art — first stylesheet / art asset
  const firstCss = createdFiles.find((f) => /\.css$/i.test(f.path));
  if (firstCss) add(firstCss.time, 'art', `Visual design starts: ${firstCss.path}`);
  const firstArtAsset = createdFiles.find(
    (f) => /\.(png|svg|glb|gltf|jpg|webp|mp3|wav|ogg)$/i.test(f.path) && !/favicon/i.test(f.path),
  );
  if (firstArtAsset) add(firstArtAsset.time, 'art', `First art/audio asset: ${firstArtAsset.path}`);

  // Subagent spawns — the team forming is a milestone in its own right.
  const spawnOrder = [...childrenById.entries()].sort(
    (a, b) => (a[1].childCreatedAt || a[1].at || 0) - (b[1].childCreatedAt || b[1].at || 0),
  );
  for (const [childId, entry] of spawnOrder) {
    const parentRec = recs.find((r) => r.id === entry.parent);
    const member = parentRec && parentRec.teamMembers.get(childId);
    const role = (member && member.name) || '';
    const desc = (member && member.description) || entry.label || '';
    const time = entry.childCreatedAt || entry.at;
    const kind = /artist|audio|render|art\b|visual|ui\b/i.test(role)
      ? 'art'
      : /qa|test/i.test(role)
        ? 'qa'
        : 'implement';
    add(time, kind, `Spawned ${role || 'subagent'} — ${trunc(desc, 92)}`, true);
  }

  // Real git commits (subject + sha, timestamp from the commit itself).
  for (const c of repoCommits) {
    add(c.time, 'commit', `Commit: ${trunc(c.subject, 110)} (${c.sha})`);
  }

  // test / build / typecheck / qa / commit / ship from bash + tools
  for (const { rec, call } of merged) {
    const time = call.time;
    const result = call.callId ? rec.results.get(call.callId) : null;
    const isError = Boolean(result && result.isError);
    const text = result ? result.text : '';
    if (call.name === 'bash' && call.command) {
      const cmd = call.command;
      const segments = shellSegments(cmd);
      const testSeg = findSegment(segments, new RegExp(TEST_CMD.map((p) => p.re.source).join('|')));
      if (testSeg) {
        const hit = TEST_CMD.find((p) => p.re.test(testSeg));
        let short = hit.short;
        if (!short) {
          const m = testSeg.match(hit.re);
          short = `node ${m ? m[0].replace(/^node\s+/, '') : 'test'}`;
        }
        const ev = testEvidence(text);
        add(time, 'test', `Tests: ${short}${ev ? ` — ${ev}` : isError ? ' — failed' : ''}`);
      }
      const buildSeg = findSegment(segments, new RegExp(BUILD_CMD.map((p) => p.re.source).join('|')));
      if (buildSeg) {
        const hit = BUILD_CMD.find((p) => p.re.test(buildSeg));
        const ev = buildEvidence(text);
        add(time, 'build', `Build: ${hit.short}${ev ? ` — ${ev}` : isError ? ' — failed' : ' — ok'}`);
      } else {
        const tscSeg = findSegment(segments, /^npx tsc --noEmit\b|^tsc --noEmit\b/);
        if (tscSeg) {
          add(time, 'build', `Typecheck: tsc --noEmit — ${isError ? 'failed' : typecheckEvidence(text)}`);
        }
      }
      // Scripted headless verification (projects with no test framework):
      // node <script>.mjs runs that end with "ERRORS: []" are real, verifiable checks.
      const scriptSeg = segments.map(executable).find((seg) => /^node\s+(?:\.\/)?([\w.-]+\.mjs)\b/.test(seg));
      if (scriptSeg) {
        const name = scriptSeg.match(/^node\s+(?:\.\/)?([\w.-]+\.mjs)\b/)[1];
        const base = name.replace(/\.mjs$/, '');
        const zeroErrors = /ERRORS:\s*\[\s*\]/.test(text);
        const assertionGroups = [...text.matchAll(/^([A-Z][A-Z0-9 ]+?TEST):/gm)].length;
        if (zeroErrors && /^(smoke|verify|final|mobile|checks?)/i.test(base)) {
          add(
            time,
            'test',
            `Browser checks: ${name}${assertionGroups ? ` — ${assertionGroups} assertion groups` : ''}, 0 page errors`,
          );
        } else if (zeroErrors && /^balance/i.test(base)) {
          const bal = text.match(/BALANCE:\s*(\{[^\n]*\})/);
          add(time, 'qa', `Balance run: ${name}${bal ? ` — ${trunc(bal[1], 120)}` : ''} (0 page errors)`);
        }
      }
      // Syntax gate for no-build projects: node --check on every JS file.
      const syntaxSegs = segments.map(executable).filter((seg) => /^node --check\b/.test(seg));
      if (syntaxSegs.length) {
        const okCount = [...text.matchAll(/^OK\s+\S+/gm)].length;
        add(time, 'build', `Syntax check: node --check${okCount ? ` — ${okCount} JS files OK` : ' — ok'}`);
      }
      const qaSeg = segments.map(executable).find((seg) => QA_CMD.test(seg));
      if (qaSeg) {
        add(time, 'qa', `Headless QA: ${qaShort(qaSeg)}${isError ? ' — failed' : ''}`);
      }
      // (commit milestones come from repository history, above)
      if (segments.some((seg) => /^mv\b[\s\S]*game-board/.test(executable(seg)))) {
        add(time, 'ship', 'Moved the finished game into the game-board repository');
      } else {
        const shipSeg = findSegment(segments, /^(?:npm publish|wrangler deploy|gh release create)\b/);
        if (shipSeg) add(time, 'ship', `Shipped: ${trunc(cmdShort(shipSeg), 90)}`);
      }
    }
    if (call.name === 'present') {
      const files = Array.isArray(call.files) ? call.files : [];
      const names = files.map((f) => relPath((f && f.path) || '')).filter(Boolean).slice(0, 3);
      add(time, 'ship', `Presented ${files.length} deliverable${files.length === 1 ? '' : 's'}: ${names.join(', ')}`);
    }
  }

  // Cap per kind, always keeping first and last so the full arc is visible.
  // Spawns get their own budget: the roster bend is the point of the exhibit.
  const caps = {
    plan: 2,
    scaffold: 1,
    implement: 2,
    test: 3,
    build: 2,
    qa: 2,
    commit: 6,
    art: 4,
    ship: 2,
  };
  const spawnCap = 9;
  const dedupe = (arr) => {
    const seen = new Set();
    return arr.filter((c) => {
      const key = `${c.kind}|${c.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const pickFrom = (arr, cap) => {
    arr.sort((a, b) => a.time - b.time);
    if (arr.length <= cap) return arr.slice();
    const keep = [arr[0]];
    for (let i = 1; i < cap - 1; i++) {
      keep.push(arr[Math.round((i * (arr.length - 1)) / (cap - 1))]);
    }
    keep.push(arr[arr.length - 1]);
    return dedupe(keep);
  };
  const byKind = new Map();
  const spawns = [];
  for (const c of dedupe(candidates)) {
    if (!MILESTONE_KINDS.has(c.kind)) continue;
    if (c.isSpawn) {
      spawns.push(c);
      continue;
    }
    const arr = byKind.get(c.kind) || [];
    arr.push(c);
    byKind.set(c.kind, arr);
  }
  const picked = pickFrom(spawns, spawnCap);
  for (const [kind, arr] of byKind) {
    picked.push(...pickFrom(arr, caps[kind] ?? 2));
  }
  picked.sort((a, b) => a.time - b.time || a.kind.localeCompare(b.kind));
  return dedupe(picked).map((c) => ({ at: iso(c.time), kind: c.kind, label: c.label }));
}

// ---------------------------------------------------------------------------
// Thinking excerpts
// ---------------------------------------------------------------------------

const THINK_CATS = [
  {
    name: 'ideation',
    re: /\b(design|architect|architectur|scope|approach|strategy|plan|decide|we need|i need|first step|structure|trade-?off)\b/i,
  },
  {
    name: 'debug',
    re: /\b(bug|broken|crash|error|fails?|failing|why|root cause|regress|stuck|fix|issue|wrong)\b/i,
  },
  {
    name: 'qa',
    re: /\b(test|tests|verify|assert|screenshot|playwright|puppeteer|qa|fps|performance|profile|benchmark|checks?)\b/i,
  },
];

function selectThinkingExcerpts(recs, rootId, target = 9) {
  const all = [];
  const extent = { min: Infinity, max: -Infinity };
  const totalChars = recs.reduce((sum, r) => sum + (r.reasoningChars || 0), 0);
  for (const rec of recs) {
    for (const r of rec.reasoning) {
      if (r.at == null) continue;
      extent.min = Math.min(extent.min, r.at);
      extent.max = Math.max(extent.max, r.at);
      all.push({ ...r, sessionId: rec.id, isRoot: rec.id === rootId });
    }
  }
  if (!all.length) return { totalChars, excerpts: [] };
  const span = Math.max(1, extent.max - extent.min);
  const seenText = new Set();
  const candidates = [];
  for (const r of all) {
    if (r.text.length < 200) continue;
    // Slice a verbatim window: prefer a clean sentence boundary inside 900..1200.
    let excerpt;
    if (r.text.length <= 1200) {
      excerpt = r.text;
    } else {
      const head = r.text.slice(0, 1200);
      const cutCandidates = [
        head.lastIndexOf('. '),
        head.lastIndexOf('.\n'),
        head.lastIndexOf('\n\n'),
        head.lastIndexOf('; '),
      ].filter((i) => i >= 600);
      const cut = cutCandidates.length ? Math.max(...cutCandidates) + 1 : 1200;
      excerpt = r.text.slice(0, cut).trimEnd();
    }
    if (excerpt.length < 200) continue;
    if (seenText.has(excerpt)) continue;
    seenText.add(excerpt);
    let score = 0;
    const cats = [];
    for (const cat of THINK_CATS) {
      const hits = (excerpt.match(cat.re) || []).length;
      if (hits) {
        cats.push(cat.name);
        score += Math.min(hits, 6) * 6;
      }
    }
    // Prefer mid-length, information-dense blocks.
    score += Math.max(0, 30 - Math.abs(excerpt.length - 700) / 40);
    if (r.isRoot) score += 6;
    const bucket = Math.floor(((r.at - extent.min) / span) * 10);
    score += (10 - Math.abs(bucket - 5)) * 1.5;
    candidates.push({ ...r, excerpt, score, cats, bucket });
  }
  candidates.sort((a, b) => b.score - a.score);

  const picked = [];
  const perSession = new Map();
  const perBucket = new Map();
  const catCount = new Map();
  const sessionsWithReasoning = new Set(candidates.map((c) => c.sessionId)).size;
  // One agent session (IslandShooter) may carry the whole quota; a studio run
  // spreads excerpts across the Lead and its specialists.
  const maxPerSession = Math.max(2, Math.ceil((target * 1.8) / Math.max(1, sessionsWithReasoning)));
  const take = (c) => {
    picked.push(c);
    perSession.set(c.sessionId, (perSession.get(c.sessionId) || 0) + 1);
    perBucket.set(c.bucket, (perBucket.get(c.bucket) || 0) + 1);
    for (const cat of c.cats) catCount.set(cat, (catCount.get(cat) || 0) + 1);
  };
  // Anchor: the Lead's first substantial reasoning block — how the build was framed.
  const anchor = candidates
    .filter((c) => c.isRoot && c.bucket === 0)
    .sort((a, b) => a.at - b.at)[0];
  if (anchor) take(anchor);
  // 1) satisfy category targets (ideation / debugging / QA)
  const catTargets = { ideation: 3, debug: 3, qa: 2 };
  for (const cat of Object.keys(catTargets)) {
    for (let i = 0; i < catTargets[cat] && picked.length < target; i++) {
      const next = candidates.find(
        (c) =>
          !picked.includes(c) &&
          c.cats.includes(cat) &&
          (perSession.get(c.sessionId) || 0) < maxPerSession &&
          (perBucket.get(c.bucket) || 0) < 2,
      );
      if (next) take(next);
    }
  }
  // 2) fill with best remaining, keeping time and agent diversity
  for (const c of candidates) {
    if (picked.length >= target) break;
    if (picked.includes(c)) continue;
    if ((perSession.get(c.sessionId) || 0) >= maxPerSession) continue;
    if ((perBucket.get(c.bucket) || 0) >= 2) continue;
    take(c);
  }
  // 3) if still short, relax the bucket constraint
  for (const c of candidates) {
    if (picked.length >= target) break;
    if (picked.includes(c)) continue;
    if ((perSession.get(c.sessionId) || 0) >= maxPerSession + 1) continue;
    take(c);
  }
  picked.sort((a, b) => a.at - b.at);
  return {
    totalChars,
    excerpts: picked.map((c) => ({ at: iso(c.at), text: c.excerpt })),
  };
}

// ---------------------------------------------------------------------------
// Family aggregation
// ---------------------------------------------------------------------------

function buildGame(family, redactor) {
  const { def, root } = family;
  const recs = family.sessions
    .map((s) => (s.__rec || (s.__rec = parseSession(s))))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  const rootRec = recs.find((r) => r.id === root.id);
  if (!rootRec) throw new Error(`Root session ${root.id} not parsed`);

  // ---- totals -------------------------------------------------------------
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };
  for (const rec of recs) {
    for (const k of Object.keys(totals)) totals[k] += rec.usage[k] || 0;
  }
  const componentSum =
    totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;

  // ---- rounds -------------------------------------------------------------
  const prompts = rootRec.prompts
    .slice()
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
    .map((p) => {
      const tr = translatePrompt(p.text);
      return {
        at: iso(p.at),
        text: redactor.redact(p.text, `games[${def.slug}].prompts.text`),
        textEn: redactor.redact(tr.textEn, `games[${def.slug}].prompts.textEn`),
        lang: tr.lang,
        chars: p.chars,
        translated: tr.translated,
      };
    });
  const subagentRecs = recs.filter((r) => r.id !== root.id);
  const rounds = {
    userTurns: prompts.length,
    agentSteps: rootRec.steps,
    subagentSessions: subagentRecs.length,
    subagentSteps: subagentRecs.reduce((sum, r) => sum + r.steps, 0),
  };

  // ---- time ---------------------------------------------------------------
  // startTime  = session created
  // endTime    = last build activity (assistant/tool/turn), ignoring later
  //              bookkeeping renames → durationMs is the "build window"
  // spanEnd    = very last event in the family, including those renames
  //              → spanMs is the full session-family span
  const startTime = root.createdAt;
  const endTime = recs.reduce((max, r) => Math.max(max, r.firstBuildTime ?? 0), 0) || null;
  const spanEnd = recs.reduce((max, r) => Math.max(max, r.lastEventTime ?? 0), 0) || null;
  // Turn time is summed per agent. Subagents run in parallel with the Lead, so
  // `activeMs` is agent-time (agent-hours), not elapsed time — never compare it
  // directly against the wall clock.
  const leadActiveMs = rootRec.turnDurations.reduce((s, t) => s + t.ms, 0);
  const activeMs = recs.reduce(
    (sum, r) => sum + r.turnDurations.reduce((s, t) => s + t.ms, 0),
    0,
  );
  const durationMs = endTime && startTime ? endTime - startTime : 0;
  const spanMs = spanEnd && startTime ? spanEnd - startTime : durationMs;

  // ---- models -------------------------------------------------------------
  const modelCounts = new Map();
  for (const rec of recs) {
    for (const [model, count] of rec.models) {
      modelCounts.set(model, (modelCounts.get(model) || 0) + count);
    }
  }
  const models = [...modelCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([m]) => m);

  // ---- tool usage ---------------------------------------------------------
  const toolUsage = {};
  for (const rec of recs) {
    for (const call of rec.calls) toolUsage[call.name] = (toolUsage[call.name] || 0) + 1;
  }

  // ---- subagents ----------------------------------------------------------
  const catalogByChild = new Map();
  for (const rec of recs) {
    for (const c of rec.children) {
      catalogByChild.set(c.childId, { ...c, parentId: rec.id });
    }
  }
  const subagents = subagentRecs
    .slice()
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .map((rec) => {
      const parent = recs.find((r) => r.id === rec.parentSession);
      const member = parent ? parent.teamMembers.get(rec.id) : null;
      const catalog = catalogByChild.get(rec.id);
      const firstPromptRaw = rec.prompts.length ? rec.prompts[0].text : '';
      const role = (member && member.name) || '';
      let description = (catalog && catalog.label) || (member && member.description) || '';
      if (!description) description = (rec.titles.length ? rec.titles[rec.titles.length - 1].title : '') || '';
      if (!description) description = firstPromptRaw.split('\n')[0];
      const label = role ? `${role} — ${trunc(description, 145)}` : trunc(description, 160);
      const firstPrompt = missionExcerpt(firstPromptRaw, 280);
      const firstPromptEn = translatePrompt(firstPrompt).textEn;
      return {
        id: rec.id,
        label: redactor.redact(label, `games[${def.slug}].subagents.label`),
        model: rec.modalModel,
        steps: rec.steps,
        tokens: rec.usage.totalTokens || 0,
        durationMs: rec.firstBuildTime && rec.createdAt ? rec.firstBuildTime - rec.createdAt : 0,
        firstPrompt: redactor.redact(firstPrompt, `games[${def.slug}].subagents.firstPrompt`),
        firstPromptEn: redactor.redact(
          firstPromptEn,
          `games[${def.slug}].subagents.firstPromptEn`,
        ),
      };
    });

  // ---- thinking -----------------------------------------------------------
  const thinking = selectThinkingExcerpts(recs, root.id);
  thinking.excerpts = thinking.excerpts.map((e) => ({
    at: e.at,
    text: redactor.redact(e.text, `games[${def.slug}].thinking`),
  }));

  // ---- files --------------------------------------------------------------
  const createdFiles = createdFilesOf(recs);
  const byExtension = {};
  for (const f of createdFiles) {
    const ext = extOf(f.path);
    byExtension[ext] = (byExtension[ext] || 0) + 1;
  }
  const files = { created: createdFiles.length, byExtension: sortObjectByCount(byExtension) };

  // ---- milestones ---------------------------------------------------------
  const repoCommits = repoCommitsFor(def.slug);
  const milestones = buildMilestones(recs, createdFiles, def, repoCommits).map((m) => ({
    at: m.at,
    kind: m.kind,
    label: redactor.redact(m.label, `games[${def.slug}].milestones`),
  }));

  // NOTE: strictly the schema requested for games[] — `activeMs`, turn count,
  // aliases and session ids all live in summary.json instead of extra keys.
  const game = {
    slug: def.slug,
    title: def.title,
    tagline: redactor.redact(def.tagline, `games[${def.slug}].tagline`),
    rootSessionId: root.id,
    startedAt: iso(startTime),
    endedAt: iso(endTime),
    durationMs, // build window: first event → last build activity
    spanMs, // full family span: first event → last event (includes 11-01 renames)
    activeMs, // summed model turn time across every agent in the family
    sessionCount: recs.length,
    models,
    totals,
    rounds,
    prompts,
    toolUsage: sortObjectByCount(toolUsage),
    subagents,
    thinking: {
      totalChars: thinking.totalChars,
      excerpts: thinking.excerpts,
    },
    milestones,
    files,
  };
  return {
    game,
    meta: {
      recs,
      rootRec,
      componentSum,
      createdFiles,
      activeMs,
      leadActiveMs,
      subagentActiveMs: activeMs - leadActiveMs,
      spanMs,
      repoCommits,
      commitCount: repoCommits.length,
      turns: rootRec.turns,
      modelCounts: sortObjectByCount(Object.fromEntries(modelCounts)),
    },
  };
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function fenceFor(text) {
  const longest = Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1));
  return '`'.repeat(Math.max(4, longest));
}

function renderReport(games, summary, opts) {
  const now = iso(Date.now());
  const lines = [];
  const push = (s = '') => lines.push(s);
  const pgOf = (slug) => summary.perGame.find((p) => p.slug === slug) || {};

  const total = summary.totals;
  push('# Build History — three browser games, one vibe-coding run');
  push();
  push(
    `> Generated ${now} from **${summary.sessionsInStore} DeepSeek Harness session logs** ` +
      `(${summary.sessionsInScope} in scope, ${summary.sessionsOutOfScope} unrelated).`,
  );
  push('>');
  push('> Rebuild with `node scripts/extract-sessions.mjs` — this report and both JSON files are generated from the raw `session.v4.jsonl.zstd` logs. Do not hand-edit.');
  push();
  push('## At a glance');
  push();
  push('| Game | Prompts | Turns | Agent steps | Subagents | Subagent steps | Total tokens | Wall-clock span | Build window | Model-active |');
  push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const g of games) {
    push(
      `| **${g.title}** | ${g.rounds.userTurns} | ${pgOf(g.slug).turns} | ${nf(g.rounds.agentSteps)} | ` +
        `${g.rounds.subagentSessions} | ${nf(g.rounds.subagentSteps)} | ${nf(g.totals.totalTokens)} | ` +
        `${humanDuration(g.spanMs)} | ${humanDuration(g.durationMs)} | ${humanDuration(g.activeMs)} |`,
    );
  }
  push(
    `| **All three** | **${total.prompts}** | — | **${nf(total.steps)}** | **${total.subagentSessions}** | ` +
      `**${nf(total.subagentSteps)}** | **${nf(total.tokens.totalTokens)}** | — | — | **${humanDuration(total.activeMs)}** |`,
  );
  push();
  push(
    'Column definitions: **wall-clock span** (`spanMs`) = first session event → last event in the family (it includes the 2026-11-01 rename pass, so it can be much longer than the build itself); **build window** (`durationMs`) = first event → last build activity; **model-active** (`activeMs`) = summed model turn time across every agent in the family. Subagents run in parallel with the Lead, so model-active is agent-hours and can exceed the wall clock.',
  );
  push();
  push(
    `${summary.sessionsInScope} sessions across ${games.length} families; ` +
      `${nf(total.toolCalls)} tool calls, ${nf(total.filesCreated)} files created, ` +
      `${nf(total.thinkingChars)} characters of private reasoning sampled into ${games.reduce(
        (n, g) => n + g.thinking.excerpts.length,
        0,
      )} published excerpts. ${summary.translations.translated} Vietnamese prompt(s) translated to English for publication; ` +
      `originals kept in the JSON.`,
  );
  push();
  push('### Tokens by game');
  push();
  push('| Game | Input | Output | Cache read | Cache write | Total |');
  push('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const g of games) {
    push(
      `| ${g.title} | ${nf(g.totals.inputTokens)} | ${nf(g.totals.outputTokens)} | ` +
        `${nf(g.totals.cacheReadTokens)} | ${nf(g.totals.cacheWriteTokens)} | ${nf(g.totals.totalTokens)} |`,
    );
  }
  push(
    `| **Total** | **${nf(total.tokens.inputTokens)}** | **${nf(total.tokens.outputTokens)}** | ` +
      `**${nf(total.tokens.cacheReadTokens)}** | **${nf(total.tokens.cacheWriteTokens)}** | ` +
      `**${nf(total.tokens.totalTokens)}** |`,
  );
  push();
  push('### How the time was spent');
  push();
  push('**Three different clocks, all published.** `spanMs` is the full session-family span (first event → last event, including the 11-01 rename pass). `durationMs` is the build window (first event → last build activity). `activeMs` is summed model turn time across every agent — subagents run **in parallel with the Lead**, so it is agent-hours, not elapsed time. “Span minus Lead active” below is everything that was not the Lead agent working: the human walking away, overnight gaps, and the later bookkeeping pass. Note that `durationMs` is still elapsed time — for the two multi-agent games it contains the overnight gaps between turns, so read `activeMs` for actual model work.');
  push();
  push('| Game | First event | Last event | Wall-clock span (`spanMs`) | Build window (`durationMs`, elapsed) | Lead active | Model-active (all agents) | Span minus Lead active |');
  push('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |');
  for (const g of games) {
    const p2 = pgOf(g.slug);
    const spanEnd = new Date(new Date(g.startedAt).getTime() + g.spanMs);
    push(
      `| ${g.title} | ${g.startedAt ? g.startedAt.slice(0, 19).replace('T', ' ') : '—'} | ` +
        `${iso(spanEnd.getTime())?.slice(0, 19).replace('T', ' ') || '—'} | ${humanDuration(g.spanMs)} | ` +
        `${humanDuration(g.durationMs)} | ${humanDuration(p2.leadActiveMs)} | ${humanDuration(p2.activeMs)} | ` +
        `${humanDuration(Math.max(0, g.spanMs - (p2.leadActiveMs || 0)))} |`,
    );
  }
  push();
  push(
    `Across the three games the agents logged **${humanDuration(summary.totals.activeMs)}** of model turn time ` +
      `(${humanDuration(summary.totals.leadActiveMs)} Lead + ${humanDuration(summary.totals.subagentActiveMs)} subagents) ` +
      `inside ~${humanDuration(games.reduce((n, g) => n + g.durationMs, 0))} of build windows.`,
  );
  push();
  push('All timestamps in this report are local Asia/Saigon (UTC+7), matching `at` fields in the JSON.');
  push();

  for (const g of games) {
    const meta = summary.perGame.find((p) => p.slug === g.slug);
    push('---');
    push();
    push(`## ${g.title}`);
    push();
    push(`*${g.tagline}*`);
    push();
    push(`- **Slug:** \`${g.slug}\``);
    push(`- **Root session:** \`${g.rootSessionId}\``);
    push(
      `- **Aliases:** ${(pgOf(g.slug).aliases || []).map((a) => `\`${a}\``).join(', ') || '—'}`,
    );
    push(`- **Models:** ${g.models.map((m) => `\`${m}\``).join(', ') || '—'}`);
    push(
      `- **Sessions:** ${meta.sessions} (1 Lead + ${g.rounds.subagentSessions} subagents) · ` +
        `**Prompt messages:** ${g.rounds.userTurns} · **Turns:** ${pgOf(g.slug).turns} · ` +
        `**Steps:** ${nf(g.rounds.agentSteps)} Lead + ${nf(g.rounds.subagentSteps)} subagent`,
    );
    push(
      `- **Tokens:** ${nf(g.totals.totalTokens)} total ` +
        `(${nf(g.totals.inputTokens)} input · ${nf(g.totals.outputTokens)} output · ` +
        `${nf(g.totals.cacheReadTokens)} cache read · ${nf(g.totals.cacheWriteTokens)} cache write)`,
    );
    push(
      `- **Files created:** ${nf(g.files.created)} — ` +
        Object.entries(g.files.byExtension)
          .slice(0, 8)
          .map(([ext, n]) => `${ext} ${n}`)
          .join(' · '),
    );
    push(`- **Thinking captured:** ${nf(g.thinking.totalChars)} chars (${g.thinking.excerpts.length} excerpts published)`);
    push(
      `- **Time:** span ${humanDuration(g.spanMs)} · build window ${humanDuration(g.durationMs)} · ` +
        `model-active ${humanDuration(g.activeMs)} across ${g.sessionCount} agent session(s)`,
    );
    const commitCountHere = pgOf(g.slug).commits || 0;
    const commitShasHere = g.milestones
      .filter((m) => m.kind === 'commit')
      .map((m) => (m.label.match(/\(([0-9a-f]{7,})\)$/) || [])[1])
      .filter(Boolean);
    push(
      commitCountHere
        ? `- **Commits:** ${commitCountHere} from the repository’s real git history` +
            (commitShasHere.length
              ? ` (${commitShasHere.join(', ')}${commitCountHere > commitShasHere.length ? ', …' : ''})`
              : '')
        : '- **Commits:** none — built as a plain folder without a git repository (see caveats)',
    );
    push();
    push('### Tools used');
    push();
    push('| Tool | Calls |');
    push('| --- | ---: |');
    for (const [name, n] of Object.entries(g.toolUsage)) push(`| \`${name}\` | ${nf(n)} |`);
    push();
    push('### Prompts (English)');
    push();
    push(
      '_The public site is English-only, so prompts are shown in translation. The human’s verbatim words — Vietnamese included — are preserved in `data/telemetry/games.json` as `prompts[].text`; `prompts[].textEn` holds the English rendering._',
    );
    push();
    if (!g.prompts.length) {
      push('_No human prompts found._');
      push();
    }
    g.prompts.forEach((p, i) => {
      const fence = fenceFor(p.textEn);
      const origin =
        p.lang === 'en' ? 'English original' : p.translated ? 'translated from Vietnamese' : 'untranslated Vietnamese';
      push(`**${i + 1}. ${p.at ? p.at.slice(0, 19).replace('T', ' ') : '—'}** · ${nf(p.chars)} chars · ${origin}`);
      push();
      push(fence + 'text');
      push(p.textEn);
      push(fence);
      push();
    });
    if (g.subagents.length) {
      push('### Subagent roster');
      push();
      push('| Agent | Model | Steps | Tokens | Duration | Mission prompt (excerpt) |');
      push('| --- | --- | ---: | ---: | ---: | --- |');
      for (const s of g.subagents) {
        push(
          `| ${s.label.replace(/\|/g, '\\|')} | \`${s.model || '—'}\` | ${nf(s.steps)} | ` +
            `${nf(s.tokens)} | ${humanDuration(s.durationMs)} | ` +
            `${(s.firstPromptEn || s.firstPrompt || '').replace(/\s*\n+\s*/g, ' / ').replace(/\|/g, '\\|')} |`,
        );
      }
      push();
    }
    push('### Timeline');
    push();
    push('| When | Kind | Milestone |');
    push('| --- | --- | --- |');
    for (const m of g.milestones) {
      push(`| ${m.at.slice(0, 19).replace('T', ' ')} | \`${m.kind}\` | ${m.label.replace(/\|/g, '\\|')} |`);
    }
    push();
  }

  // ---- provenance ---------------------------------------------------------
  push('---');
  push();
  push('## Data provenance');
  push();
  push(`- **Source:** \`${opts.sessionsDir}\` — ${summary.sessionsInStore} session directories, each holding \`session.v4.jsonl.zstd\` (zstd-compressed JSONL, DSH v4 schema). Decompressed with \`zstd -dc\`.`);
  push(`- **Scope:** ${summary.sessionsInStore} sessions existed in the store; **${summary.sessionsInScope} belong to the three game families** (${games.map((g) => `${g.title} ${summary.perGame.find((p) => p.slug === g.slug).sessions}`).join(', ')}). The other ${summary.sessionsOutOfScope} are unrelated (Seleya work, DSH feature research, Fabric Harness, pnpm fixes, greetings) and are excluded.`);
  push('- **Family detection:** a family root is a session whose `session/title` finally becomes `Game: IslandShooter`, `Game: Blade&Mouse` or `Game: First Hearth` (the human renamed them on 2026-11-01 14:15–14:25). Descendants are discovered by walking `session.parentSession` links in each file header — never by directory name (some directories are `session-<uuid>` and some are bare `<uuid>`).');
  push('- **Token accounting:** exact sums over distinct `assistant/message` events (`data.usage`), deduplicated by message id per session; a session is counted exactly once. `totalTokens` matches the four components on every event.');
  push('- **Character counts:** `chars` and `thinking.totalChars` are JavaScript string lengths (UTF-16 code units), so an emoji counts as 2 — consistent with how the site will measure the same strings.');
  push('- **Rounds:** `userTurns` counts only human `user/message` events (`source.kind === "user"`); injected blocks (`runtime-context`, `skill-catalog`, `time-context`, `agent-message`, `subagent-settled`, `tool-jobs`, `working-directory`, `user-approval`) are excluded. `agentSteps` counts `step/start` events in the Lead session; `subagentSteps` sums the subagent sessions.');
  push('- **Prompts:** verbatim human text, order preserved, original language preserved (Vietnamese stays Vietnamese). Injected prompt plumbing was stripped at the event level; inline `<system-reminder>` blocks and leading DSH control lines were also removed.');
  push(
    `- **Language:** the exhibit is English-only, so every prompt carries \`textEn\` (a faithful translation) plus \`translated\`/\`lang\` flags alongside the verbatim \`text\`. ` +
      `Of ${summary.translations.prompts} prompts, ${summary.translations.translated} were Vietnamese and are translated, and ${summary.translations.englishOriginals} ` +
      `${summary.translations.englishOriginals === 1 ? 'was' : 'were'} already English. Subagent mission excerpts carry \`firstPromptEn\` the same way. ` +
      `Translations are editorial: faithful to the original wording and tone, with no requirements added or removed.`,
  );
  push('- **Milestones:** derived mechanically from tool calls and their results — first file written, first source module, design docs, team/spawn events, test runs with pass counts, builds/typechecks, headless screenshot QA, real git commits and `present` deliverables. Capped per kind to keep the timeline readable while always keeping the first and last occurrence.');
  push('- **Commits:** read from the repository’s actual git history (`git log` / `git rev-list`), never from the transcript: Blade & Mount’s five-commit subtree history, and First Hearth’s twelve pre-monorepo build commits (the chain that ended at the original project repo’s `e1ce7bf`; rewritten shas by the monorepo import are what is published). Alien Shooter has none — it was built as a plain folder and its session never initialised git. Labels are `Commit: <subject> (<sha7>)` with the commit’s own timestamp.');
  push('- **Files created:** unique paths from `write` tool calls plus files created through bash heredocs/redirects (`cat > path <<EOF`, `tee`), normalised to repo-relative paths. `/tmp` scratch files and `node_modules` are ignored.');
  push('- **Thinking excerpts:** verbatim slices (200–1200 chars) of `reasoning` content blocks, selected across the whole family and across the timeline for ideation / debugging / QA coverage.');
  push('- **Clocks in the data:** `games.json` carries three per game. `spanMs` = first event → last event in the family (includes the 11-01 rename pass). `durationMs` = build window, first event → last build activity. `activeMs` = summed model turn time over every agent session in the family (agent-hours; subagents run in parallel with the Lead, so it is not elapsed time). `sessionCount` = number of agent sessions in the family. `summary.json` also carries `leadActiveMs`, `subagentActiveMs` and `sessionIds`.');
  push();
  push('## Redaction');
  push();
  if (summary.redactions.total === 0) {
    push('Nothing token-shaped was found in any published field. The extractor still scans every output string for GitHub/OpenAI/AWS/Slack/Google tokens, JWTs, bearer tokens, private keys, `.env`-style secrets, passwords and e-mail addresses, and would replace them with `[REDACTED]`.');
  } else {
    push(`**${summary.redactions.total} secret-shaped string(s) were replaced with \`[REDACTED]\` / \`[REDACTED-EMAIL]\` before writing.**`);
    push();
    push('| Kind | Count |');
    push('| --- | ---: |');
    for (const [kind, n] of Object.entries(summary.redactions.byKind)) push(`| ${kind} | ${n} |`);
    push();
    push('Affected fields:');
    push();
    for (const loc of summary.redactions.locations) push(`- \`${loc.where}\` — ${loc.kinds.join(', ')}`);
    push();
    push('No raw token, key or private e-mail appears in any generated file.');
  }
  push();
  push('## Caveats');
  push();
  for (const caveat of summary.caveats) push(`- ${caveat}`);
  push();
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validate(games, summary) {
  const problems = [];
  const warnings = [];
  const checks = [];

  const ok = (name, detail) => checks.push({ name, status: 'PASS', detail });
  const warn = (name, detail) => {
    warnings.push({ name, detail });
    checks.push({ name, status: 'WARN', detail });
  };
  const fail = (name, detail) => {
    problems.push({ name, detail });
    checks.push({ name, status: 'FAIL', detail });
  };

  if (!Array.isArray(games) || games.length !== 3) {
    fail('games.length', `expected 3 games, got ${Array.isArray(games) ? games.length : 'n/a'}`);
  } else {
    ok('games.length', '3 game families present');
  }

  for (const g of games || []) {
    const prefix = g.slug;
    if (!(g.totals.totalTokens > 0)) fail(`${prefix}.totalTokens`, 'must be > 0');
    else ok(`${prefix}.totalTokens`, `${nf(g.totals.totalTokens)} tokens`);

    const sum =
      g.totals.inputTokens + g.totals.outputTokens + g.totals.cacheReadTokens + g.totals.cacheWriteTokens;
    if (sum !== g.totals.totalTokens) {
      fail(`${prefix}.totals`, `component sum ${sum} !== totalTokens ${g.totals.totalTokens}`);
    } else ok(`${prefix}.totals`, 'token components sum to totalTokens');

    if (!sameKeys(g, SCHEMA.game)) {
      fail(`${prefix}.schema`, `game keys differ from schema: ${Object.keys(g).join(',')}`);
    } else ok(`${prefix}.schema`, 'game keys match the declared schema');
    if (!sameKeys(g.totals, SCHEMA.totals)) fail(`${prefix}.totals.schema`, 'totals keys differ');
    if (!sameKeys(g.rounds, SCHEMA.rounds)) fail(`${prefix}.rounds.schema`, 'rounds keys differ');
    if (!sameKeys(g.files, SCHEMA.files)) fail(`${prefix}.files.schema`, 'files keys differ');
    if (!sameKeys(g.thinking, SCHEMA.thinking)) fail(`${prefix}.thinking.schema`, 'thinking keys differ');

    for (const p of g.prompts) {
      if (!sameKeys(p, SCHEMA.prompt)) {
        fail(`${prefix}.prompts.schema`, `prompt keys differ: ${Object.keys(p).join(',')}`);
        break;
      }
    }
    const badLang = g.prompts.find((p) => !['vi', 'en'].includes(p.lang));
    if (badLang) fail(`${prefix}.prompts.lang`, `unexpected lang ${badLang.lang}`);
    const missingEn = g.prompts.find((p) => !p.textEn || !p.textEn.trim());
    if (missingEn) fail(`${prefix}.prompts.textEn`, 'empty English text');
    const untranslated = g.prompts.filter((p) => p.lang === 'vi' && !p.translated);
    if (untranslated.length) {
      fail(`${prefix}.prompts.translated`, `${untranslated.length} Vietnamese prompt(s) without an English translation`);
    } else if (g.prompts.some((p) => p.lang === 'vi')) {
      ok(`${prefix}.prompts.translated`, `${g.prompts.filter((p) => p.lang === 'vi').length} Vietnamese prompt(s) translated to English`);
    }
    const enMismatch = g.prompts.find((p) => p.lang === 'en' && p.textEn !== p.text);
    if (enMismatch) warn(`${prefix}.prompts.textEn`, 'English prompt whose textEn differs from text');
    for (const s2 of g.subagents) {
      if (!sameKeys(s2, SCHEMA.subagent)) {
        fail(`${prefix}.subagents.schema`, `subagent keys differ: ${Object.keys(s2).join(',')}`);
        break;
      }
      if (!s2.firstPromptEn) fail(`${prefix}.subagents.firstPromptEn`, `missing English excerpt for ${s2.id}`);
    }
    for (const m of g.milestones) {
      if (!sameKeys(m, SCHEMA.milestone)) {
        fail(`${prefix}.milestones.schema`, 'milestone keys differ');
        break;
      }
    }
    for (const e of g.thinking.excerpts) {
      if (!sameKeys(e, SCHEMA.excerpt)) {
        fail(`${prefix}.thinking.excerpts.schema`, 'excerpt keys differ');
        break;
      }
    }

    if (g.prompts.length >= 3) {
      ok(`${prefix}.prompts`, `${g.prompts.length} human prompts`);
    } else {
      warn(
        `${prefix}.prompts`,
        `only ${g.prompts.length} human prompt(s) in the root session (target was >= 3); the log contains no other human turns`,
      );
    }
    if (g.prompts.some((p) => !p.text || !p.chars)) fail(`${prefix}.prompts.text`, 'empty prompt text');
    if (g.prompts.some((p) => p.chars !== p.text.length)) {
      warn(`${prefix}.prompts.chars`, 'chars column recomputed from text length');
    }
    if (!g.rounds.userTurns) warn(`${prefix}.rounds.userTurns`, 'zero human turns');
    if (!(g.rounds.agentSteps > 0)) fail(`${prefix}.rounds.agentSteps`, 'no steps recorded');
    if (g.rounds.subagentSessions > 0 && !(g.rounds.subagentSteps > 0)) {
      fail(`${prefix}.rounds.subagentSteps`, 'subagent sessions with no steps');
    }
    for (const s of g.subagents) {
      if (!(s.tokens > 0)) fail(`${prefix}.subagents[${s.id}].tokens`, 'subagent tokens must be > 0');
      if (!(s.steps > 0)) fail(`${prefix}.subagents[${s.id}].steps`, 'subagent steps must be > 0');
    }
    if (g.subagents.length) {
      ok(`${prefix}.subagents`, `${g.subagents.length} subagents with tokens/steps`);
    }
    if (g.thinking.totalChars <= 0) fail(`${prefix}.thinking`, 'no reasoning captured');
    else ok(`${prefix}.thinking`, `${nf(g.thinking.totalChars)} chars, ${g.thinking.excerpts.length} excerpts`);
    for (const [i, e] of g.thinking.excerpts.entries()) {
      if (e.text.length < 200 || e.text.length > 1200) {
        fail(`${prefix}.thinking.excerpts[${i}]`, `length ${e.text.length} outside 200..1200`);
      }
    }
    if (g.milestones.length < 4) {
      warn(`${prefix}.milestones`, `only ${g.milestones.length} milestones derived`);
    } else ok(`${prefix}.milestones`, `${g.milestones.length} milestones`);
    for (const m of g.milestones) {
      if (!MILESTONE_KINDS.has(m.kind)) fail(`${prefix}.milestones.kind`, `unknown kind ${m.kind}`);
    }
    if (g.files.created <= 0) warn(`${prefix}.files`, 'no created files detected');
    else ok(`${prefix}.files`, `${g.files.created} files across ${Object.keys(g.files.byExtension).length} extensions`);
    if (!g.startedAt || !g.endedAt) fail(`${prefix}.time`, 'missing startedAt/endedAt');
    if (!(g.durationMs >= 0)) fail(`${prefix}.durationMs`, 'negative duration');
    if (!(g.spanMs >= g.durationMs)) {
      fail(`${prefix}.spanMs`, `spanMs ${g.spanMs} < durationMs ${g.durationMs}`);
    }
    if (g.sessionCount !== g.rounds.subagentSessions + 1) {
      fail(`${prefix}.sessionCount`, `expected ${g.rounds.subagentSessions + 1} sessions, got ${g.sessionCount}`);
    }
    if (!(g.activeMs > 0) || g.activeMs > g.durationMs * 6) {
      warn(`${prefix}.activeMs`, `model-active ${humanDuration(g.activeMs)} vs build window ${humanDuration(g.durationMs)} — check parallelism assumption`);
    } else {
      ok(`${prefix}.activeMs`, `${humanDuration(g.activeMs)} of model turn time across ${g.sessionCount} agent(s)`);
    }
    if (g.endedAt && g.startedAt && new Date(g.endedAt) < new Date(g.startedAt)) {
      fail(`${prefix}.time`, 'endedAt before startedAt');
    }
    if (!g.models.length) fail(`${prefix}.models`, 'no model recorded');
    const toolTotal = Object.values(g.toolUsage).reduce((a, b) => a + b, 0);
    if (!toolTotal) fail(`${prefix}.toolUsage`, 'no tool calls');
    else ok(`${prefix}.toolUsage`, `${nf(toolTotal)} tool calls across ${Object.keys(g.toolUsage).length} tools`);
  }

  const t = summary.translations;
  if (t.missing.length) {
    fail('summary.translations', `${t.missing.length} prompt(s) missing an English translation`);
  } else if (t.translated + t.englishOriginals !== t.prompts) {
    fail('summary.translations', 'prompt language coverage does not add up');
  } else {
    ok(
      'summary.translations',
      `${t.prompts} prompts (${t.translated} translated from Vietnamese, ${t.englishOriginals} English originals); ` +
        `${t.subagentFirstPromptsEnglish}/${t.subagentFirstPrompts} subagent excerpts have English`,
    );
  }

  if (summary.sessionsInScope !== (games || []).reduce((n, g) => n + summary.perGame.find((p) => p.slug === g.slug).sessions, 0)) {
    fail('summary.sessionsInScope', 'does not match per-game session counts');
  } else ok('summary.sessionsInScope', `${summary.sessionsInScope} sessions`);

  return { problems, warnings, checks };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selfTest) selfTest();
  const started = Date.now();
  const log = opts.quiet ? () => {} : (...a) => console.log(...a);

  log('▸ DeepSeek Harness session store:', opts.sessionsDir);
  if (!fs.existsSync(opts.sessionsDir)) {
    console.error(`Sessions dir not found: ${opts.sessionsDir}`);
    process.exit(1);
  }

  log('▸ pass 1 — indexing session headers and titles…');
  const sessions = indexSessions(opts.sessionsDir);
  log(`  ${sessions.size} sessions indexed`);

  log('▸ resolving the three game families…');
  const { families, excluded } = resolveFamilies(sessions);
  const inScope = families.reduce((n, f) => n + f.sessions.length, 0);
  for (const f of families) {
    log(
      `  ${f.def.title}: root ${f.root.id} + ${f.sessions.length - 1} subagent session(s) ` +
        `(${f.def.aliases ? f.def.aliases[0] : ''})`,
    );
  }
  log(`  ${inScope} of ${sessions.size} sessions in scope; ${excluded.length} unrelated`);

  const redactor = makeRedactor();
  log('▸ pass 2 — extracting events, usage, prompts, reasoning, tools…');
  const built = [];
  for (const family of families) {
    const { game, meta } = buildGame(family, redactor);
    built.push({ family, game, meta });
    log(
      `  ${game.title}: ${nf(game.totals.totalTokens)} tokens, ${game.rounds.agentSteps} steps, ` +
        `${game.prompts.length} prompts, ${game.subagents.length} subagents, ${game.milestones.length} milestones`,
    );
  }

  const generatedAt = iso(Date.now());
  const games = built.map((b) => b.game);

  // ---------------------------------------------------------------- summary
  const totalTokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
  const totalToolUsage = {};
  const modelWide = new Map();
  let totalSteps = 0;
  let totalSubSteps = 0;
  let totalSubSessions = 0;
  let totalPrompts = 0;
  let totalActive = 0;
  let totalCalls = 0;
  let totalFiles = 0;
  let totalThinking = 0;
  for (const { game: g, meta } of built) {
    for (const k of Object.keys(totalTokens)) totalTokens[k] += g.totals[k];
    for (const [name, n] of Object.entries(g.toolUsage)) totalToolUsage[name] = (totalToolUsage[name] || 0) + n;
    for (const m of g.models) modelWide.set(m, (modelWide.get(m) || 0) + 1);
    totalSteps += g.rounds.agentSteps;
    totalSubSteps += g.rounds.subagentSteps;
    totalSubSessions += g.rounds.subagentSessions;
    totalPrompts += g.rounds.userTurns;
    totalActive += meta.activeMs || 0;
    totalCalls += Object.values(g.toolUsage).reduce((a, b) => a + b, 0);
    totalFiles += g.files.created;
    totalThinking += g.thinking.totalChars;
  }
  const redactions = redactor.report();
  const perGame = built.map(({ family, game, meta }) => ({
    slug: game.slug,
    title: game.title,
    aliases: family.def.aliases,
    rootSessionId: game.rootSessionId,
    sessions: family.sessions.length,
    sessionIds: family.sessions.map((s) => s.id),
    prompts: game.prompts.length,
    promptsTranslated: game.prompts.filter((p) => p.translated).length,
    promptsEnglish: game.prompts.filter((p) => p.lang === 'en').length,
    turns: meta.turns,
    steps: game.rounds.agentSteps,
    subagentSessions: game.rounds.subagentSessions,
    subagentSteps: game.rounds.subagentSteps,
    tokens: game.totals.totalTokens,
    durationMs: game.durationMs,
    spanMs: game.spanMs,
    activeMs: meta.activeMs,
    leadActiveMs: meta.leadActiveMs,
    subagentActiveMs: meta.subagentActiveMs,
    filesCreated: game.files.created,
    commits: meta.commitCount,
    milestones: game.milestones.length,
    thinkingChars: game.thinking.totalChars,
    from: game.startedAt,
    to: game.endedAt,
  }));
  const pg = (slug) => perGame.find((p) => p.slug === slug) || {};
  const allPrompts = games.flatMap((g) => g.prompts);
  const allSubagents = games.flatMap((g) => g.subagents);
  const translations = {
    prompts: allPrompts.length,
    translated: allPrompts.filter((p) => p.translated).length,
    englishOriginals: allPrompts.filter((p) => p.lang === 'en').length,
    vietnameseOriginals: allPrompts.filter((p) => p.lang === 'vi').length,
    subagentFirstPrompts: allSubagents.length,
    subagentFirstPromptsEnglish: allSubagents.filter((s2) => Boolean(s2.firstPromptEn)).length,
    missing: MISSING_TRANSLATIONS.map((m) => ({ hash: m.hash, chars: m.chars })),
    policy: 'English-only site; verbatim originals stay in prompts[].text / subagents[].firstPrompt, English renderings are prompts[].textEn / subagents[].firstPromptEn.',
  };
  const caveats = [];
  const island = games.find((g) => g.slug === 'alien-shooter');
  if (island && island.prompts.length < 3) {
    caveats.push(
      `**Alien Shooter has only ${island.prompts.length} human prompt.** The log contains exactly one human turn — “Build me an Alien Shooter game.” (${island.prompts[0] ? island.prompts[0].chars : '?'} characters in the original Vietnamese; verbatim original preserved in the JSON). The whole game was built inside that single turn (${island.rounds.agentSteps} steps, ${humanDuration(pg('alien-shooter').leadActiveMs)} of model-active time). The ">= 3 prompts" expectation does not hold for this family; nothing was invented to satisfy it.`,
    );
  }
  const blade = games.find((g) => g.slug === 'blade-and-mount');
  if (blade) {
    caveats.push(
      '**Slugs and titles follow `data/registry.json`; the DSH session titles keep their original names.** The registry (the site’s identity source of truth) uses `alien-shooter`, `blade-and-mount`, `first-hearth` with titles “Alien Shooter”, “Blade & Mount”, “First Hearth”. The sessions were originally titled `Game: IslandShooter`, `Game: Blade&Mouse` and `Game: First Hearth`, and every Blade & Mount subagent mission calls the project “Blade & Mount”; all original names are preserved in `aliases` in summary.json.',
    );
  }
  caveats.push(
    `**Three clocks are published, because wall-clock alone overstates the work.** \`spanMs\` is the full family span (first event → last event) and includes the 11-01 rename pass: Alien Shooter’s 43-minute build window sits inside a ${humanDuration(pg('alien-shooter').spanMs || island.spanMs)} span. \`durationMs\` is the build window (first event → last build activity). \`activeMs\` is summed model turn time across every agent (agent-hours; subagents run in parallel). Blade & Mount sat idle ${humanDuration(Math.max(0, blade.spanMs - pg('blade-and-mount').leadActiveMs))} between Lead turns inside its span; First Hearth's turn 1 ended at 00:11 and turn 2 only started at 07:59 the next morning.`,
  );
  caveats.push(
    '**The 2026-11-01 14:15–14:25 pass is bookkeeping, not building.** The three sessions were renamed to `Game: …` with no agent work attached in Alien Shooter’s case — that is why `spanMs` is far longer than `durationMs` for it. The last Blade & Mount and First Hearth turns at ~14:16–14:22 (“Please stop the server for me.” and “move this conversation into the game-board workspace”, translated) are real human turns and are included.',
  );
  caveats.push(
    '**Alien Shooter has no build step and no commits, and the report does not pretend otherwise.** It is plain HTML/CSS/Canvas JS with zero dependencies: the only “build” gate was a syntax check (`node --check`, captured as a `build` milestone) and verification was scripted headless-browser runs (`smoke.mjs`, `verify.mjs`, `final.mjs`, `balance.mjs`) that report `ERRORS: []`, captured as `test`/`qa` milestones. Its session never ran `git init`/`commit`, and the monorepo import carries no game history, so there are zero commit milestones for it.',
  );
  caveats.push(
    '**Commit milestones come from version control, not from the session transcript.** Blade & Mount’s five commits are its imported subtree history; First Hearth’s are the pre-monorepo chain (originally `0748e03…e1ce7bf`, rebased by the monorepo import — the current shas are in the data). Each label carries the real commit subject and a 7-character sha, timestamped with the commit’s own author time.',
  );
  caveats.push(
    '**First Hearth was moved into this repository during its final turn.** The game was built in `~/Documents/deepseek-harness/default-workspace/first-hearth` and `mv`-ed into `~/src/gh/game-board` at the end, which is why the paths in its milestones look mixed.',
  );
  caveats.push(
    '**Token figures include subagent sessions.** Summing only Lead sessions would understate output ~3× for the two multi-agent games; the per-game totals here are family-wide.',
  );
  caveats.push(
    '**Prompts are only human `user/message` events.** Agent-to-agent traffic (`agent-message`, `subagent-settled`) and DSH plumbing are deliberately excluded, so “prompts” means what the human actually typed or pasted.',
  );

  const summary = {
    generatedAt,
    sessionsInStore: sessions.size,
    sessionsInScope: inScope,
    sessionsOutOfScope: excluded.length,
    families: games.length,
    totals: {
      prompts: totalPrompts,
      steps: totalSteps,
      subagentSessions: totalSubSessions,
      subagentSteps: totalSubSteps,
      tokens: totalTokens,
      durationMs: games.reduce((m, g) => Math.max(m, g.durationMs), 0),
      spanMs: games.reduce((n, g) => n + g.durationMs, 0),
      activeMs: totalActive,
      leadActiveMs: perGame.reduce((n, p2) => n + (p2.leadActiveMs || 0), 0),
      subagentActiveMs: perGame.reduce((n, p2) => n + (p2.subagentActiveMs || 0), 0),
      toolCalls: totalCalls,
      filesCreated: totalFiles,
      thinkingChars: totalThinking,
    },
    toolUsage: sortObjectByCount(totalToolUsage),
    models: [...modelWide.keys()],
    perGame,
    translations,
    redactions,
    caveats,
    excludedSessions: excluded
      .map((s) => ({
        id: s.id,
        title: s.finals || (s.titles.length ? s.titles[s.titles.length - 1].title : ''),
        createdAt: iso(s.createdAt),
        reason: s.parentSession && !inScope ? 'descendant of an unrelated session' : 'unrelated session',
      }))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))),
    provenance: {
      sessionsDir: opts.sessionsDir,
      decompressor: 'zstd -dc',
      sessionFormat: 'v4 JSONL',
      timezone: 'Asia/Saigon (UTC+7)',
      generatedBy: 'scripts/extract-sessions.mjs',
      gamesJson: path.relative(REPO_ROOT, opts.gamesPath),
      summaryJson: path.relative(REPO_ROOT, opts.summaryPath),
      report: opts.report ? path.relative(REPO_ROOT, opts.reportPath) : null,
      extractionMs: null, // filled after validation
    },
  };

  // ---------------------------------------------------------------- write
  fs.mkdirSync(path.dirname(opts.gamesPath), { recursive: true });
  fs.writeFileSync(opts.gamesPath, JSON.stringify({ generatedAt, games }, null, 2) + '\n');

  log('▸ validating…');
  const validation = validate(games, summary);

  // Re-read to prove the JSON on disk parses.
  let reparsedGames;
  try {
    reparsedGames = JSON.parse(fs.readFileSync(opts.gamesPath, 'utf8'));
    checksJsonParse(reparsedGames);
  } catch (err) {
    validation.problems.push({ name: 'games.json.parse', detail: err.message });
    validation.checks.push({ name: 'games.json.parse', status: 'FAIL', detail: err.message });
  }
  function checksJsonParse(parsed) {
    if (!parsed || !Array.isArray(parsed.games) || parsed.games.length !== 3) {
      throw new Error('re-read games.json does not contain 3 games');
    }
  }

  summary.provenance.extractionMs = Date.now() - started;
  fs.writeFileSync(opts.summaryPath, JSON.stringify(summary, null, 2) + '\n');

  // ---------------------------------------------------------------- report
  if (opts.report) {
    const report = renderReport(games, summary, opts);
    fs.mkdirSync(path.dirname(opts.reportPath), { recursive: true });
    fs.writeFileSync(opts.reportPath, report + '\n');
    log(`  report written: ${path.relative(REPO_ROOT, opts.reportPath)} (${nf(report.length)} chars)`);
  }

  // ---------------------------------------------------------------- output
  const elapsed = Date.now() - started;
  console.log('');
  console.log('Validation summary');
  console.log('==================');
  for (const c of validation.checks) {
    console.log(`  [${c.status}] ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  console.log('');
  console.log(
    `  ${validation.checks.filter((c) => c.status === 'PASS').length} passed, ` +
      `${validation.warnings.length} warning(s), ${validation.problems.length} failure(s)`,
  );
  if (validation.warnings.length) {
    console.log('');
    console.log('  Warnings (kept honest, not “fixed” by inventing data):');
    for (const w of validation.warnings) console.log(`    - ${w.name}: ${w.detail}`);
  }
  if (validation.problems.length) {
    console.log('');
    console.log('  FAILURES:');
    for (const p of validation.problems) console.log(`    - ${p.name}: ${p.detail}`);
  }
  console.log('');
  console.log('Outputs');
  console.log('=======');
  console.log(`  ${path.relative(REPO_ROOT, opts.gamesPath)}   (${nf(fs.statSync(opts.gamesPath).size)} bytes)`);
  console.log(`  ${path.relative(REPO_ROOT, opts.summaryPath)} (${nf(fs.statSync(opts.summaryPath).size)} bytes)`);
  if (opts.report) {
    console.log(`  ${path.relative(REPO_ROOT, opts.reportPath)} (${nf(fs.statSync(opts.reportPath).size)} bytes)`);
  }
  console.log('');
  console.log(`Done in ${(elapsed / 1000).toFixed(1)}s.`);
  if (validation.problems.length) process.exit(1);
}

main();
