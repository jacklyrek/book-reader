import type { SourceId } from './types'

export function uid(prefix = ''): string {
  const raw =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36)
  return prefix ? `${prefix}_${raw}` : raw
}

/**
 * Book ids are derived from the source, not random, so the same book added on
 * two devices converges to one row instead of two (§6.3).
 */
export function bookIdFor(source: SourceId, sourceKey: string): string {
  return `${source}:${sourceKey}`
}

/** Normalisation shared with the server-side matcher (supabase/ingest/match.ts). */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[;:—–-].*$/, '') // drop subtitles
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The one part of a name every catalog agrees on.
 *
 * Gutendex files authors as "Machiavelli, Niccolò" and LibriVox matches its
 * `author` parameter against the surname alone, so "Niccolo Machiavelli" finds
 * nothing in either until it's cut down to "Machiavelli". Single-name authors
 * (Homer, Montesquieu, Virgil) pass through untouched.
 */
export function surname(author: string): string {
  const trimmed = author.trim()
  if (trimmed.includes(',')) return trimmed.split(',')[0]?.trim() || trimmed
  const parts = trimmed.split(/\s+/)
  return parts[parts.length - 1] ?? trimmed
}

export function normalizeAuthor(author: string): string {
  // Catalogs disagree on "Melville, Herman" vs "Herman Melville".
  const flipped = author.includes(',')
    ? author.split(',').map((s) => s.trim()).reverse().join(' ')
    : author
  return flipped
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(sir|dr|mr|mrs|ms|jr|sr|pere|fils)\b/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
