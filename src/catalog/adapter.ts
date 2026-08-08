/**
 * The shape every catalog source is hidden behind, kept in its own module so
 * the Supabase and live adapters don't have to import each other.
 */
import { normalizeAuthor, normalizeTitle, surname } from '../core/ids'
import { SOURCE_RANK, type CatalogWork } from '../core/types'
import { authorSimilarity, similarity } from './match'

export interface SearchOptions {
  signal?: AbortSignal
  /** Restrict to works that have audio, or that have text. */
  filter?: 'all' | 'audio' | 'text'
  language?: string
  limit?: number
  /**
   * Look for `query` as a title *by this author*. Curated shelves know both
   * halves, and no source's free-text search can express that on its own.
   */
  author?: string
}

export interface CatalogAdapter {
  readonly name: string
  search(query: string, options?: SearchOptions): Promise<CatalogWork[]>
  getWork(workId: string, signal?: AbortSignal): Promise<CatalogWork | null>
  featured(signal?: AbortSignal): Promise<CatalogWork[]>
}

/**
 * How to put a title-and-author search to a source that only takes free text:
 * a list of rungs, tried in order until one answers, each rung a set of queries
 * whose results are pooled.
 *
 * No free-text source lets us ask for the two as separate fields, and they all
 * AND the terms — Gutendex against title-or-author, Postgres through
 * `websearch_to_tsquery`. So "The Symposium Plato" asks for a book carrying
 * "the", "symposium" *and* "plato", which is nothing: Gutenberg files it as
 * plain "Symposium". When the precise question comes back empty, ask the two
 * loose ones together — everything titled like this, plus everything by this
 * author — and let `scoreResult` pick the book out of the pool. Both are needed,
 * because the catalogs disagree about spellings on both sides: Gutenberg has
 * "Dostoyevsky" where the canon says "Dostoevsky", so only the title finds
 * Karamazov, while only the author finds "Symposium".
 */
export function attemptsFor(query: string, author?: string): string[][] {
  if (!author?.trim()) return [[query]]
  const last = surname(author)
  const specific = `${query} ${last}`.trim()
  return specific === last ? [[last]] : [[specific], [query, last]]
}

/** Standard Ebooks first, then Gutenberg, then the rest (§6.2). */
export function rankEditions(work: CatalogWork): CatalogWork {
  return {
    ...work,
    editions: [...work.editions].sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source]),
  }
}

export function scoreResult(work: CatalogWork, query: string, author?: string): number {
  const needle = normalizeTitle(query)
  const title = normalizeTitle(work.title)

  // Exact beats prefix beats substring. Below that, fall back to the same
  // similarity the matcher uses — capped so a fuzzy hit can never outrank a real
  // substring one — because a widened search returns titles worded differently
  // from the one that was asked for ("Symposium" for "The Symposium").
  let titleScore = 0
  if (needle && title === needle) titleScore = 100
  else if (needle && title.startsWith(needle)) titleScore = 60
  else if (needle && title.includes(needle)) titleScore = 30
  else titleScore = 25 * similarity(title, needle)

  let score: number
  if (author) {
    // A named author is a constraint rather than a guess, so it adds to the
    // title score instead of competing with it: the right title by the wrong
    // person is still the wrong book.
    score = titleScore + 50 * authorSimilarity(work.authors, [author])
  } else {
    // Free text is a title *or* an author, so take the better reading rather
    // than the sum. Summing is what floats "Index of the Project Gutenberg
    // Works of Herman Melville" above Moby Dick on a search for "Melville" —
    // it scores as a title match and an author match, and it is neither.
    //
    // Weighted between a prefix and an exact title match: a book that merely
    // opens with a writer's name ("Jane Austen and Her Times") is a weaker
    // answer to their name than a book they wrote, but a title that *is* the
    // query still wins.
    const authorNeedle = normalizeAuthor(query)
    const authorScore =
      authorNeedle && work.authors.some((a) => normalizeAuthor(a).includes(authorNeedle)) ? 70 : 0
    score = Math.max(titleScore, authorScore)
  }

  // Prefer works we can both read and listen to, then better typesetting.
  if (work.editions.length && work.recordings.length) score += 15
  const best = work.editions[0]
  if (best) score += 10 - SOURCE_RANK[best.source] * 3
  return score
}
