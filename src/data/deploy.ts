import type { DeployFile } from '../types/deploy'

const deployModules = import.meta.glob('../../data/deploy.json', { eager: true }) as Record<
  string,
  { default: DeployFile }
>

const deployFile = Object.values(deployModules)[0]?.default

/**
 * Play URL resolution, in order: the deploy manifest, then the registry's
 * authored playUrl. If neither exists the site shows a "Deploy pending" state
 * rather than a dead link.
 */
export function deployUrl(slug: string): string | undefined {
  const game = deployFile?.games?.[slug]
  return game?.url
}

export const deployGeneratedAt = deployFile?.generatedAt

export const boardUrl = deployFile?.board?.url
