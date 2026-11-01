import gamesRaw from '../../data/telemetry/games.json'
import summaryRaw from '../../data/telemetry/summary.json'
import { hasVietnamese } from '../lib/format'
import { games as registryGames, type GameEntry } from './registry'

/* ------------------------------------------------------------------
   Raw shapes. Fields are optional because the extraction script owns
   this data; the site must keep rendering if a field disappears.
   ------------------------------------------------------------------ */

export interface PromptRecord {
  at?: string
  text?: string
  textEn?: string
  lang?: string
  chars?: number
  translated?: boolean
}

export interface SubagentRecord {
  id?: string
  label?: string
  model?: string
  steps?: number
  tokens?: number
  durationMs?: number
  firstPrompt?: string
  firstPromptEn?: string
}

export interface ThinkingExcerpt {
  at?: string
  text?: string
}

export interface Milestone {
  at?: string
  kind?: string
  label?: string
}

export interface Totals {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  totalTokens?: number
}

export interface GameTelemetry {
  slug?: string
  title?: string
  tagline?: string
  rootSessionId?: string
  startedAt?: string
  endedAt?: string
  durationMs?: number
  spanMs?: number
  activeMs?: number
  sessionCount?: number
  models?: string[]
  totals?: Totals
  rounds?: {
    userTurns?: number
    agentSteps?: number
    subagentSessions?: number
    subagentSteps?: number
  }
  prompts?: PromptRecord[]
  toolUsage?: Record<string, number>
  subagents?: SubagentRecord[]
  thinking?: { totalChars?: number; excerpts?: ThinkingExcerpt[] }
  milestones?: Milestone[]
  files?: { created?: number; byExtension?: Record<string, number> }
}

interface GamesFile {
  generatedAt?: string
  games?: GameTelemetry[]
}

interface SummaryFile {
  generatedAt?: string
  sessionsInScope?: number
  sessionsInStore?: number
  totals?: {
    prompts?: number
    steps?: number
    subagentSteps?: number
    subagentSessions?: number
    tokens?: Totals
    durationMs?: number
    activeMs?: number
    toolCalls?: number
    filesCreated?: number
    thinkingChars?: number
  }
  toolUsage?: Record<string, number>
  models?: string[]
  translations?: { prompts?: number; chars?: number } | Record<string, unknown>
  redactions?: { total?: number; byKind?: Record<string, number> }
  caveats?: string[]
  provenance?: Record<string, string>
}

const gamesFile = gamesRaw as unknown as GamesFile
const summaryFile = summaryRaw as unknown as SummaryFile

export const generatedAt: string | undefined = gamesFile.generatedAt
export const summary = summaryFile
export const models: string[] = summaryFile.models ?? []

/** The extractor used older family slugs; keep both names working. */
const ALIASES: Record<string, string[]> = {
  'alien-shooter': ['island-shooter', 'alien-shooter'],
  'blade-and-mount': ['blade-and-mouse', 'blade-and-mount'],
  'first-hearth': ['first-hearth', 'first-hearth'],
}

export const telemetryGames: GameTelemetry[] = gamesFile.games ?? []

function rawFor(slug: string): GameTelemetry | undefined {
  const aliases = ALIASES[slug] ?? [slug]
  const bySlug = telemetryGames.find((game) => game.slug && aliases.includes(game.slug))
  if (bySlug) return bySlug
  const entry = registryGames.find((game) => game.slug === slug)
  const title = entry?.title.toLowerCase()
  return telemetryGames.find((game) => game.title && title && game.title.toLowerCase() === title)
}

/* ------------------------------------------------------------------
   Derived build views: registry identity + telemetry numbers
   ------------------------------------------------------------------ */

export interface Build extends GameEntry {
  raw: GameTelemetry
  prompts: PromptRecord[]
  subagents: SubagentRecord[]
  thinking: ThinkingExcerpt[]
  milestones: Milestone[]
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  wallMs: number
  activeMs: number
  leadSteps: number
  subagentSteps: number
  agentTurns: number
  subagentSessions: number
  toolCalls: number
  tools: Array<{ name: string; count: number }>
  filesCreated: number
  filesByExtension: Array<{ ext: string; count: number }>
  thinkingChars: number
  sessionCount: number
  models: string[]
  teamSize: number
}

export function promptEn(prompt: PromptRecord): string {
  return prompt.textEn ?? prompt.text ?? ''
}

export function toBuild(entry: GameEntry): Build | undefined {
  const raw = rawFor(entry.slug)
  if (!raw) return undefined
  const rounds = raw.rounds ?? {}
  const totals = raw.totals ?? {}
  const leadSteps = rounds.agentSteps ?? 0
  const subagentSteps = rounds.subagentSteps ?? 0
  const tools = Object.entries(raw.toolUsage ?? {})
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
  const filesByExtension = Object.entries(raw.files?.byExtension ?? {})
    .map(([ext, count]) => ({ ext, count }))
    .sort((a, b) => b.count - a.count)

  return {
    ...entry,
    raw,
    prompts: raw.prompts ?? [],
    subagents: raw.subagents ?? [],
    thinking: (raw.thinking?.excerpts ?? []).filter(
      (excerpt) =>
        Boolean(excerpt.text) &&
        Boolean(excerpt.at) &&
        // An English-only site never shows a Vietnamese excerpt by accident.
        !hasVietnamese(excerpt.text ?? ''),
    ),
    milestones: (raw.milestones ?? []).filter((milestone) => milestone.at && milestone.label),
    inputTokens: totals.inputTokens ?? 0,
    outputTokens: totals.outputTokens ?? 0,
    cacheReadTokens: totals.cacheReadTokens ?? 0,
    cacheWriteTokens: totals.cacheWriteTokens ?? 0,
    totalTokens: totals.totalTokens ?? 0,
    wallMs: raw.durationMs ?? 0,
    activeMs: raw.activeMs ?? 0,
    leadSteps,
    subagentSteps,
    agentTurns: leadSteps + subagentSteps,
    subagentSessions: rounds.subagentSessions ?? 0,
    toolCalls: tools.reduce((sum, tool) => sum + tool.count, 0),
    tools,
    filesCreated: raw.files?.created ?? 0,
    filesByExtension,
    thinkingChars: raw.thinking?.totalChars ?? 0,
    sessionCount: raw.sessionCount ?? 1,
    models: raw.models ?? [],
    teamSize: raw.subagents?.length ?? 0,
  }
}

export const builds: Build[] = registryGames
  .map(toBuild)
  .filter((build): build is Build => Boolean(build))

export function buildBySlug(slug: string | undefined): Build | undefined {
  if (!slug) return undefined
  return builds.find((build) => build.slug === slug)
}

/* ------------------------------------------------------------------
   Aggregate
   ------------------------------------------------------------------ */

export interface Aggregate {
  games: number
  prompts: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  totalTokens: number
  wallMs: number
  activeMs: number
  leadSteps: number
  subagentSteps: number
  agentTurns: number
  subagentSessions: number
  toolCalls: number
  filesCreated: number
  thinkingChars: number
  teamSize: number
  tools: Array<{ name: string; count: number }>
}

function sumBy(buildsList: Build[], pick: (build: Build) => number): number {
  return buildsList.reduce((sum, build) => sum + pick(build), 0)
}

const toolTotals = new Map<string, number>()
for (const build of builds) {
  for (const tool of build.tools) {
    toolTotals.set(tool.name, (toolTotals.get(tool.name) ?? 0) + tool.count)
  }
}

export const aggregate: Aggregate = {
  games: builds.length,
  prompts: sumBy(builds, (build) => build.prompts.length),
  inputTokens: sumBy(builds, (build) => build.inputTokens),
  outputTokens: sumBy(builds, (build) => build.outputTokens),
  cacheReadTokens: sumBy(builds, (build) => build.cacheReadTokens),
  totalTokens: sumBy(builds, (build) => build.totalTokens),
  wallMs: sumBy(builds, (build) => build.wallMs),
  activeMs: sumBy(builds, (build) => build.activeMs),
  leadSteps: sumBy(builds, (build) => build.leadSteps),
  subagentSteps: sumBy(builds, (build) => build.subagentSteps),
  agentTurns: sumBy(builds, (build) => build.agentTurns),
  subagentSessions: sumBy(builds, (build) => build.subagentSessions),
  toolCalls: sumBy(builds, (build) => build.toolCalls),
  filesCreated: sumBy(builds, (build) => build.filesCreated),
  thinkingChars: sumBy(builds, (build) => build.thinkingChars),
  teamSize: sumBy(builds, (build) => build.teamSize),
  tools: Array.from(toolTotals.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count),
}

/** Prompt timestamps for the timeline: what the human actually typed, and when. */
export interface PromptMark {
  at: string
  slug: string
  title: string
  text: string
}

export const allPrompts: PromptMark[] = builds.flatMap((build) =>
  build.prompts.flatMap((prompt) =>
    prompt.at
      ? [
          {
            at: prompt.at,
            slug: build.slug,
            title: build.title,
            text: promptEn(prompt),
          },
        ]
      : [],
  ),
)

export function spanOfPrompts(): { from: number; to: number } {
  const times = allPrompts.map((mark) => new Date(mark.at).getTime())
  const starts = builds.flatMap((build) => (build.raw.startedAt ? [new Date(build.raw.startedAt).getTime()] : []))
  const ends = builds.flatMap((build) => (build.raw.endedAt ? [new Date(build.raw.endedAt).getTime()] : []))
  const all = [...times, ...starts, ...ends]
  const min = Math.min(...all)
  const max = Math.max(...all)
  return { from: min, to: max }
}

export const MODEL_LABEL = models[0] ?? 'deepseek-v4.1-flash'
