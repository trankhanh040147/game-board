/**
 * Formatting for the board. Every number on the site goes through here so the
 * mono face, the tabular figures and the "compact versus exact" decision stay
 * consistent.
 */

const int = new Intl.NumberFormat('en-US')
const TZ = 'Asia/Saigon'

export function count(n: number): string {
  return int.format(Math.round(n))
}

/** 922,922,447 -> "922.9M"; 849 -> "849"; 3_469 -> "3,469" */
export function compact(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1_000_000_000) return trim(n / 1_000_000_000) + 'B'
  if (abs >= 1_000_000) return trim(n / 1_000_000) + 'M'
  if (abs >= 10_000) return trim(n / 1_000) + 'K'
  return int.format(Math.round(n))
}

function trim(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, '')
}

/** ms -> "39 m", "23 h 36 m", "15 h 28 m" */
export function duration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—'
  const totalMin = Math.round(ms / 60_000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h === 0) return `${m} m`
  if (m === 0) return `${h} h`
  return `${h} h ${String(m).padStart(2, '0')} m`
}

/** ms -> "39 m" below an hour, "9.0 h" above it. Used everywhere agent work is shown. */
export function workTime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—'
  if (ms < 3_600_000) return duration(ms)
  return `${hours(ms)} h`
}

/** ms -> "23.6" (for the big counter) */
export function hours(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '0'
  return (Math.round((ms / 3_600_000) * 10) / 10).toFixed(1)
}

/** ms -> "15:28:41" clock style, for exactness */
export function clock(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—'
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

const dtfDateTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const dtfDate = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
})

const dtfTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const dtfDay = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit' })
const dtfMonth = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, month: 'short' })

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  return dtfDateTime.format(new Date(iso)).replace(',', '')
}

export function date(iso: string | null | undefined): string {
  if (!iso) return '—'
  return dtfDate.format(new Date(iso))
}

export function time(iso: string | null | undefined): string {
  if (!iso) return '—'
  return dtfTime.format(new Date(iso))
}

export function day(iso: string): string {
  return dtfDay.format(new Date(iso))
}

export function month(iso: string): string {
  return dtfMonth.format(new Date(iso))
}

export function pct(part: number, whole: number): string {
  if (!whole) return '0%'
  return `${Math.round((part / whole) * 100)}%`
}

/** ratio 0..1 formatted as a css custom property chunk */
export function widthVar(part: number, whole: number): string {
  const ratio = whole > 0 ? Math.max(0.004, Math.min(1, part / whole)) : 0
  return `--w:${(ratio * 100).toFixed(2)}%`
}

export function shortHash(text: string, len = 7): string {
  const m = text.match(/\(([0-9a-f]{7,40})\)/)
  return m && m[1] ? m[1].slice(0, len) : ''
}

/** "Tests: npm test — 112 passed" -> 112 */
export function passedCount(label: string): number | null {
  const m = label.match(/(\d+)\s*(?:\/\s*\d+\s*)?(?:tests?|checks?)?\s*(?:pass|passed)/i)
  if (m && m[1]) return Number(m[1])
  const m2 = label.match(/(\d+)\s*\/\s*\d+\s*(?:tests|checks)/i)
  if (m2 && m2[1]) return Number(m2[1])
  return null
}

/** A public exhibit does not need anyone's home directory: …/default-workspace/game. */
export function shortenPaths(text: string): string {
  return text.replace(/\/Users\/[^\s"'`<>()[\]]+/g, (match) => {
    const parts = match.split('/').filter(Boolean)
    const tail = parts.slice(-2).join('/')
    return tail ? `…/${tail}` : '…'
  })
}

/** Emoji and dingbats out of transcript text: the type does the talking. */
export function stripEmoji(text: string): string {
  return text
    .replace(/[\u2600-\u27BF\u2B00-\u2BFF\uFE0F\uFE0E]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}]/gu, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/** Everything a public page shows from a transcript passes through here. */
export function cleanDisplay(text: string): string {
  return stripEmoji(shortenPaths(text))
}

const VIETNAMESE = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệịỉĩọỏốồổỗộớờởỡợụủũứừửữựỳỵỷỹ]/i

export function hasVietnamese(text: string): boolean {
  return VIETNAMESE.test(text)
}

/**
 * Prompt text is shown verbatim except for pasted media URLs, which turn a
 * readable prompt into a wall of links. Words and structure are untouched.
 */
export function readablePrompt(text: string): string {
  return text
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/\[([^\]]{1,160})]\((?:https?:\/\/|www\.)[^)]*\)/g, '$1')
    .replace(/\(https?:\/\/[^)\s]{1,400}\)/g, '')
    .replace(/https?:\/\/\S{1,400}/g, '')
    .replace(/&#x20;/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Collapse whitespace for a single-line role description. */
export function oneLine(text: string, max = 220): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  return clean.slice(0, max - 1).replace(/[ ,.;:]$/, '') + '…'
}

export function firstSentences(text: string, max = 260): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  const cut = clean.slice(0, max)
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '))
  if (stop > max * 0.5) return cut.slice(0, stop + 1)
  return cut.replace(/[ ,;:]$/, '') + '…'
}
