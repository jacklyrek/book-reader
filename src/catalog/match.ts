/**
 * Text ↔ audio matching (§6.2).
 *
 * The design puts this server-side against `pg_trgm`, which is right for the
 * nightly ingest over 75k rows. The same scoring runs on the client for the
 * live-API fallback path, so the two agree about what counts as a match. Expect
 * to be wrong ~10% of the time; that's what `matchConfidence` and the manual
 * overrides table are for.
 */
import { normalizeAuthor, normalizeTitle } from '../core/ids'
import type { CatalogWork } from '../core/types'

/** Sørensen–Dice over character bigrams — a decent stand-in for pg_trgm. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0

  const bigrams = new Map<string, number>()
  for (let i = 0; i < a.length - 1; i++) {
    const gram = a.slice(i, i + 2)
    bigrams.set(gram, (bigrams.get(gram) ?? 0) + 1)
  }

  let hits = 0
  for (let i = 0; i < b.length - 1; i++) {
    const gram = b.slice(i, i + 2)
    const count = bigrams.get(gram) ?? 0
    if (count > 0) {
      bigrams.set(gram, count - 1)
      hits++
    }
  }

  return (2 * hits) / (a.length - 1 + (b.length - 1))
}

/** Any author in common counts; catalogs disagree about co-authors and editors. */
export function authorSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  let best = 0
  for (const left of a) {
    for (const right of b) {
      best = Math.max(best, similarity(normalizeAuthor(left), normalizeAuthor(right)))
      if (best === 1) return 1
    }
  }
  return best
}

/**
 * Weighted title/author score in 0–1. Title carries more weight because
 * LibriVox author fields are entered by volunteers and are often wrong.
 */
export function matchScore(a: CatalogWork, b: CatalogWork): number {
  const title = similarity(normalizeTitle(a.title), normalizeTitle(b.title))
  const author = authorSimilarity(a.authors, b.authors)
  // A perfect title with no author agreement is still probably the same book.
  return title * 0.7 + author * 0.3
}

/** Below this, don't claim the audio belongs to the text. */
export const MATCH_THRESHOLD = 0.72
/** Below this, show the "we think this is the same book" warning in the UI. */
export const MATCH_CONFIDENT = 0.85

/**
 * Fold audio recordings into text works. Anything unmatched survives as its own
 * work — a LibriVox-only recording is still worth listening to.
 */
export function mergeWorks(textWorks: CatalogWork[], audioWorks: CatalogWork[]): CatalogWork[] {
  const merged: CatalogWork[] = textWorks.map((w) => ({ ...w, recordings: [...w.recordings] }))
  const claimed = new Set<number>()

  for (const target of merged) {
    let bestIndex = -1
    let bestScore = 0
    audioWorks.forEach((audio, index) => {
      if (claimed.has(index)) return
      const score = matchScore(target, audio)
      if (score > bestScore) {
        bestScore = score
        bestIndex = index
      }
    })

    if (bestIndex >= 0 && bestScore >= MATCH_THRESHOLD) {
      claimed.add(bestIndex)
      const audio = audioWorks[bestIndex]
      if (audio) {
        target.recordings.push(...audio.recordings)
        target.matchConfidence = bestScore
        target.coverUrl ??= audio.coverUrl
        target.description ||= audio.description
      }
    }
  }

  audioWorks.forEach((audio, index) => {
    if (!claimed.has(index)) merged.push(audio)
  })

  return merged
}

/** Drop repeats when two queries against one source overlap. */
export function dedupeById(works: CatalogWork[]): CatalogWork[] {
  const seen = new Map<string, CatalogWork>()
  for (const work of works) if (!seen.has(work.workId)) seen.set(work.workId, work)
  return [...seen.values()]
}

/**
 * Collapse the same text across sources into one work, keeping every edition.
 * Ranking (Standard Ebooks first) happens at render time via SOURCE_RANK.
 */
export function dedupeEditions(works: CatalogWork[]): CatalogWork[] {
  const out: CatalogWork[] = []
  for (const work of works) {
    const existing = out.find((w) => matchScore(w, work) >= MATCH_CONFIDENT)
    if (existing) {
      existing.editions.push(...work.editions)
      existing.recordings.push(...work.recordings)
      existing.coverUrl ??= work.coverUrl
      existing.description ||= work.description
      if (existing.subjects.length === 0) existing.subjects = work.subjects
    } else {
      out.push({ ...work, editions: [...work.editions], recordings: [...work.recordings] })
    }
  }
  return out
}
