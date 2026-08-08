/**
 * The shape every catalog source is hidden behind, kept in its own module so
 * the Supabase and live adapters don't have to import each other.
 */
import { SOURCE_RANK, type CatalogWork } from '../core/types'

export interface SearchOptions {
  signal?: AbortSignal
  /** Restrict to works that have audio, or that have text. */
  filter?: 'all' | 'audio' | 'text'
  language?: string
  limit?: number
}

export interface CatalogAdapter {
  readonly name: string
  search(query: string, options?: SearchOptions): Promise<CatalogWork[]>
  getWork(workId: string, signal?: AbortSignal): Promise<CatalogWork | null>
  featured(signal?: AbortSignal): Promise<CatalogWork[]>
}

/** Standard Ebooks first, then Gutenberg, then the rest (§6.2). */
export function rankEditions(work: CatalogWork): CatalogWork {
  return {
    ...work,
    editions: [...work.editions].sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source]),
  }
}

export function scoreResult(work: CatalogWork, query: string): number {
  const needle = query.toLowerCase()
  const title = work.title.toLowerCase()
  let score = 0
  if (title === needle) score += 100
  else if (title.startsWith(needle)) score += 60
  else if (title.includes(needle)) score += 30
  if (work.authors.some((a) => a.toLowerCase().includes(needle))) score += 20
  // Prefer works we can both read and listen to, then better typesetting.
  if (work.editions.length && work.recordings.length) score += 15
  const best = work.editions[0]
  if (best) score += 10 - SOURCE_RANK[best.source] * 3
  return score
}
