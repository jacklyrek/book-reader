/**
 * Catalog facade (§6.2).
 *
 * The design's recommendation is not to query three APIs live per search, and
 * that's right — the Supabase index is the production path. But the app has to
 * work before that index exists, so there are two adapters behind one
 * interface and the choice is made by whether Supabase is configured.
 */
import type { CatalogWork } from '../core/types'
import { rankEditions, scoreResult, type CatalogAdapter, type SearchOptions } from './adapter'
import { searchGutenberg, getGutenbergBook } from './gutendex'
import { getLibriVoxBook, loadTracks, searchLibriVox } from './librivox'
import { dedupeEditions, mergeWorks } from './match'
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
    const { signal, filter = 'all', limit = 40 } = options
    const wantText = filter !== 'audio'
    const wantAudio = filter !== 'text'

    const [se, gutenberg, librivox] = await Promise.all([
      wantText ? settle(searchStandardEbooks(query, signal)) : [],
      wantText ? settle(searchGutenberg({ search: query, sort: 'popular' }, signal)) : [],
      wantAudio ? settle(searchLibriVox({ title: query, limit: 20 }, signal)) : [],
    ])

    const textWorks = dedupeEditions([...se, ...gutenberg])
    const works = mergeWorks(textWorks, librivox)
    const filtered = works.filter((w) => {
      if (filter === 'audio') return w.recordings.length > 0
      if (filter === 'text') return w.editions.length > 0
      return true
    })

    return filtered
      .map(rankEditions)
      .sort((a, b) => scoreResult(b, query) - scoreResult(a, query))
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

/** A text work opened cold: go find whether LibriVox has a reading of it. */
async function attachAudio(work: CatalogWork, signal?: AbortSignal): Promise<CatalogWork> {
  if (work.recordings.length > 0) return work
  const candidates = await settle(searchLibriVox({ title: work.title, limit: 10 }, signal))
  const merged = mergeWorks([work], candidates)
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

export const catalog: CatalogAdapter = supabaseConfigured ? supabaseCatalog : liveCatalog

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
