export interface DeployGame {
  url: string
  deployedAt?: string
}

export interface DeployFile {
  generatedAt?: string
  games?: Record<string, DeployGame>
  board?: { url: string; deployedAt?: string }
}
