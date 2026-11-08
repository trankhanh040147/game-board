import registryRaw from '../../data/registry.json'

export interface MediaImage {
  src: string
  alt: string
}

export interface GameMedia {
  hero: string
  heroAlt: string
  gallery: MediaImage[]
}

export interface GameEntry {
  slug: string
  title: string
  subtitle: string
  genre: string
  accent: string
  accent2: string
  oneLiner: string
  description: string
  highlights: string[]
  tech: string[]
  year: number
  repoPath: string
  media: GameMedia
  playUrl: string
  sourceRef: string
  sortOrder: number
  /** Human-input requirements, shown next to the Play action. */
  requirements?: string
  /** Provenance line for shelf games; replaces the default 'session not exported' copy. */
  note?: string
}

export interface SiteInfo {
  title: string
  tagline: string
  repoUrl: string
  author: string
  authorUrl: string
}

interface RegistryFile {
  site: SiteInfo
  games: GameEntry[]
}

const registry = registryRaw as unknown as RegistryFile

export const site: SiteInfo = registry.site

export const games: GameEntry[] = [...registry.games].sort((a, b) => a.sortOrder - b.sortOrder)

export function gameBySlug(slug: string | undefined): GameEntry | undefined {
  if (!slug) return undefined
  return games.find((game) => game.slug === slug)
}
