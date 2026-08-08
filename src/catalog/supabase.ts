/**
 * Supabase-backed catalog (§6.2). One query per search against a pre-built
 * index, with ranking we control, instead of a fan-out to three APIs.
 *
 * The RPCs are defined in supabase/migrations/0001_catalog.sql and return rows
 * already shaped like CatalogWork.
 */
import { supabase, supabaseConfigured } from '../core/supabase-client'
import type { CatalogWork } from '../core/types'
import {
  attemptsFor,
  rankEditions,
  scoreResult,
  type CatalogAdapter,
  type SearchOptions,
} from './adapter'
import { dedupeById } from './match'

export { supabaseConfigured }

function coerce(row: unknown): CatalogWork | null {
  if (!row || typeof row !== 'object') return null
  const work = row as Partial<CatalogWork>
  if (!work.workId || !work.title) return null
  return rankEditions({
    workId: work.workId,
    title: work.title,
    authors: work.authors ?? [],
    language: work.language ?? 'en',
    subjects: work.subjects ?? [],
    coverUrl: work.coverUrl,
    year: work.year,
    editions: work.editions ?? [],
    recordings: (work.recordings ?? []).map((r) => ({ ...r, tracks: r.tracks ?? [] })),
    matchConfidence: work.matchConfidence,
    description: work.description,
  })
}

export const supabaseCatalog: CatalogAdapter = {
  name: 'supabase',

  async search(query: string, options: SearchOptions = {}) {
    const sb = supabase()
    if (!sb) return []

    // The RPC takes one text query and its `websearch_to_tsquery` ANDs the
    // terms, so a title-and-author search needs the same widening the live
    // adapter does rather than a schema change.
    let works: CatalogWork[] = []
    for (const rung of attemptsFor(query, options.author)) {
      const pages = await Promise.all(
        rung.map(async (attempt) => {
          const { data, error } = await sb.rpc('search_catalog', {
            q: attempt,
            lang: options.language ?? null,
            kind: options.filter ?? 'all',
            lim: options.limit ?? 40,
          })
          if (error) throw new Error(`catalog search failed: ${error.message}`)
          return ((data as unknown[]) ?? []).map(coerce).filter((w): w is CatalogWork => w !== null)
        }),
      )
      works = dedupeById(pages.flat())
      if (works.length > 0) break
    }

    // The index ranks against whichever query answered; when that was the
    // widened one, it ranked by author and knows nothing of the title we want.
    return options.author
      ? works.sort(
          (a, b) => scoreResult(b, query, options.author) - scoreResult(a, query, options.author),
        )
      : works
  },

  async getWork(workId: string) {
    const sb = supabase()
    if (!sb) return null
    const { data, error } = await sb.rpc('get_work', { work_id: workId })
    if (error) throw new Error(`catalog lookup failed: ${error.message}`)
    const rows = (data as unknown[]) ?? []
    return rows.length ? coerce(rows[0]) : null
  },

  async featured() {
    const sb = supabase()
    if (!sb) return []
    const { data, error } = await sb.rpc('featured_works', { lim: 24 })
    if (error) throw new Error(`featured lookup failed: ${error.message}`)
    return ((data as unknown[]) ?? []).map(coerce).filter((w): w is CatalogWork => w !== null)
  },
}
