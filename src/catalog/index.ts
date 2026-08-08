/**
 * Catalog facade (§6.2).
 *
 * The design's recommendation is not to query three APIs live per search, and
 * that's right — the Supabase index is the production path. But the app has to
 * work before that index exists, so there are two adapters behind one
 * interface.
 *
 * Choosing the Supabase adapter is gated separately from `supabaseConfigured`
 * (which only means "sync/auth are available"): the catalog tables need the
 * ingest job to have populated them first, and a Supabase project set up
 * purely for cross-device sync shouldn't silently blank out search. Opt in
 * with `VITE_SUPABASE_CATALOG=true` once the index is actually built.
 */
import type { CatalogWork } from '../core/types'
import {
  attemptsFor,
  rankEditions,
  scoreResult,
  type CatalogAdapter,
  type SearchOptions,
} from './adapter'
import { searchGutenberg, getGutenbergBook } from './gutendex'
import { getLibriVoxBook, loadTracks, searchLibriVox } from './librivox'
import { dedupeById, dedupeEditions, mergeWorks } from './match'
import { newReleases, searchStandardEbooks } from './standardebooks'
import { supabaseCatalog, supabaseConfigured } from './supabase'

export { rankEditions, type CatalogAdapter, type SearchOptions }

/**
 * Live adapter: hits Gutendex, LibriVox and Standard Ebooks in parallel and
 * matches client-side. Slower and chattier than the index, but it needs no
 * backend at all.
 */
const liveCatalog: CatalogAdapter = {
  name: 'live',

  async search(query, options = {}) {
    const { signal, filter = 'all', limit = 40, author } = options

    const [texts, audio] = await Promise.all([
      filter === 'audio' ? [] : searchText(query, author, signal),
      filter === 'text' ? [] : searchAudio(query, author, signal),
    ])

    return mergeWorks(texts, audio)
      .filter((w) => {
        if (filter === 'audio') return w.recordings.length > 0
        if (filter === 'text') return w.editions.length > 0
        return true
      })
      .map(rankEditions)
      .sort((a, b) => scoreResult(b, query, author) - scoreResult(a, query, author))
      .slice(0, limit)
  },

  async getWork(workId, signal) {
    const [source, ...rest] = workId.split(':')
    const key = rest.join(':')
    if (source === 'gutenberg') {
      const work = await getGutenbergBook(Number(key), signal)
      return work ? await attachAudio(work, signal) : null
    }
    if (source === 'librivox') {
      const work = await getLibriVoxBook(key, signal)
      return work ? await attachText(work, signal) : null
    }
    if (source === 'standard-ebooks') {
      const results = await searchStandardEbooks(key.split('/').pop() ?? key, signal)
      const work = results.find((w) => w.workId === workId) ?? results[0] ?? null
      return work ? await attachAudio(work, signal) : null
    }
    return null
  },

  async featured(signal) {
    return (await settle(newReleases(signal))).map(rankEditions)
  },
}

/**
 * Gutendex and Standard Ebooks take one free-text query, so a title-and-author
 * search has to be asked as a string and widened if that comes back empty.
 */
async function searchText(
  query: string,
  author: string | undefined,
  signal?: AbortSignal,
): Promise<CatalogWork[]> {
  for (const rung of attemptsFor(query, author)) {
    const found = await Promise.all(
      rung.flatMap((attempt) => [
        settle(searchStandardEbooks(attempt, signal)),
        settle(searchGutenberg({ search: attempt, sort: 'popular' }, signal)),
      ]),
    )
    const works = dedupeEditions(found.flat())
    if (works.length > 0) return works
  }
  return []
}

/**
 * LibriVox matches per field rather than over free text, so it takes the title
 * and the author as they were given and never needs the widening above. Both
 * have to be asked: on the title alone — which is all this used to do —
 * searching for a writer never turns up a single recording of theirs.
 */
async function searchAudio(
  title: string,
  author: string | undefined,
  signal?: AbortSignal,
): Promise<CatalogWork[]> {
  const [byTitle, byAuthor] = await Promise.all([
    settle(searchLibriVox({ title, limit: 20 }, signal)),
    settle(searchLibriVox({ author: author ?? title, limit: 20 }, signal)),
  ])
  return dedupeById([...byTitle, ...byAuthor])
}

/** A text work opened cold: go find whether LibriVox has a reading of it. */
async function attachAudio(work: CatalogWork, signal?: AbortSignal): Promise<CatalogWork> {
  if (work.recordings.length > 0) return work
  // LibriVox retitles freely ("Moby Dick, or the Whale"), so the author's shelf
  // is often the only way to reach the recording.
  const merged = mergeWorks([work], await searchAudio(work.title, work.authors[0], signal))
  return rankEditions(merged[0] ?? work)
}

/** …and the reverse, for a recording opened cold. */
async function attachText(work: CatalogWork, signal?: AbortSignal): Promise<CatalogWork> {
  if (work.editions.length > 0) return work
  const [se, gutenberg] = await Promise.all([
    settle(searchStandardEbooks(work.title, signal)),
    settle(searchGutenberg({ search: work.title }, signal)),
  ])
  const texts = dedupeEditions([...se, ...gutenberg])
  const merged = mergeWorks(texts, [work])
  const withAudio = merged.find((w) => w.recordings.length > 0) ?? work
  return rankEditions(withAudio)
}

/** One dead source shouldn't blank the whole result list. */
async function settle<T>(promise: Promise<T[]>): Promise<T[]> {
  try {
    return await promise
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') return []
    console.warn('[catalog] source failed:', error)
    return []
  }
}

const catalogIndexEnabled =
  supabaseConfigured && (import.meta.env.VITE_SUPABASE_CATALOG as string | undefined) === 'true'

export const catalog: CatalogAdapter = catalogIndexEnabled ? supabaseCatalog : liveCatalog

export { liveCatalog }

/**
 * Track lists are big, so neither adapter returns them with search results.
 * Everything that needs to play or download audio calls this first.
 */
export async function ensureTracks(work: CatalogWork, signal?: AbortSignal): Promise<CatalogWork> {
  const recording = work.recordings[0]
  if (!recording || recording.tracks.length > 0) return work
  const tracks = await loadTracks(recording.recordingId, signal)
  return {
    ...work,
    recordings: work.recordings.map((r, i) => (i === 0 ? { ...r, tracks } : r)),
  }
}
