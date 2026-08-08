/**
 * LibriVox (§4). ~20k volunteer recordings. The API is not CORS-enabled, so
 * metadata goes through the proxy; the MP3s themselves live on archive.org and
 * are fetched directly.
 *
 * Narration quality is wildly variable, which is why `readers` is surfaced
 * everywhere and `settings.narratorBlocklist` exists.
 */
import { bookIdFor } from '../core/ids'
import type { AudioRecording, AudioTrack, CatalogWork } from '../core/types'
import { fetchJson } from './proxy'

const BASE = 'https://librivox.org/api/feed/audiobooks'

interface LvReader {
  reader_id: string
  display_name: string
}

interface LvSection {
  id: string
  section_number: string
  title: string
  listen_url: string
  language: string
  playtime: string
  file_name: string | null
  readers: LvReader[]
}

interface LvAuthor {
  id: string
  first_name: string
  last_name: string
  dob?: string
  dod?: string
}

interface LvBook {
  id: string
  title: string
  description: string
  url_text_source: string
  language: string
  copyright_year: string
  num_sections: string
  url_rss: string
  url_zip_file: string
  url_librivox: string
  url_iarchive?: string
  totaltime: string
  totaltimesecs: number
  authors: LvAuthor[]
  genres?: { id: string; name: string }[]
  sections?: LvSection[]
}

interface LvResponse {
  books?: LvBook[]
  error?: string
}

/** LibriVox reports languages as English names; the rest of the app uses codes. */
const LANGUAGE_CODES: Record<string, string> = {
  English: 'en',
  French: 'fr',
  German: 'de',
  Spanish: 'es',
  Italian: 'it',
  Dutch: 'nl',
  Portuguese: 'pt',
  Russian: 'ru',
  Latin: 'la',
  'Ancient Greek': 'grc',
  Chinese: 'zh',
  Japanese: 'ja',
  Hebrew: 'he',
  Polish: 'pl',
  Swedish: 'sv',
  Danish: 'da',
  Finnish: 'fi',
  Multilingual: 'mul',
}

export function languageCode(name: string): string {
  return LANGUAGE_CODES[name] ?? name.slice(0, 2).toLowerCase()
}

export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * LibriVox archive.org filenames encode the bitrate (`…_64kb.mp3`). The 128kbps
 * variant is usually present under the same name. Callers verify with a HEAD
 * before committing to a download (§7.1).
 */
export function withBitrate(url: string, kbps: number): string {
  return url.replace(/_(\d+)kb\.mp3$/i, `_${kbps}kb.mp3`)
}

export function availableBitrates(url: string): number[] {
  return /_\d+kb\.mp3$/i.test(url) ? [64, 128] : []
}

function archiveIdentifier(book: LvBook): string | undefined {
  const source = book.url_iarchive || book.url_zip_file
  const match = /archive\.org\/(?:details|download|compress)\/([^/?&]+)/.exec(source ?? '')
  return match?.[1]
}

function toTracks(book: LvBook): AudioTrack[] {
  return (book.sections ?? []).map((section, index) => ({
    trackIndex: Number(section.section_number) - 1 || index,
    title: section.title?.trim() || `Section ${section.section_number}`,
    // archive.org serves https on the apex host; www redirects, which costs a
    // round trip on every track change.
    url: section.listen_url.replace('://www.archive.org/', '://archive.org/'),
    seconds: Number(section.playtime) || 0,
    reader: section.readers?.[0]?.display_name,
  }))
}

function toRecording(book: LvBook): AudioRecording {
  const tracks = toTracks(book)
  const readers = [...new Set(tracks.map((t) => t.reader).filter((r): r is string => Boolean(r)))]
  const first = tracks[0]?.url
  return {
    recordingId: bookIdFor('librivox', book.id),
    source: 'librivox',
    pageUrl: book.url_librivox,
    totalSeconds: book.totaltimesecs || tracks.reduce((sum, t) => sum + t.seconds, 0),
    readers,
    tracks,
    trackCount: Number(book.num_sections) || tracks.length,
    bitrates: first ? availableBitrates(first) : [],
  }
}

export function toWork(book: LvBook): CatalogWork {
  const identifier = archiveIdentifier(book)
  return {
    workId: bookIdFor('librivox', book.id),
    title: book.title.trim(),
    authors: book.authors.map((a) => `${a.first_name} ${a.last_name}`.trim()).filter(Boolean),
    language: languageCode(book.language),
    subjects: (book.genres ?? []).map((g) => g.name),
    coverUrl: identifier ? `https://archive.org/services/img/${identifier}` : undefined,
    year: Number(book.copyright_year) || undefined,
    editions: [],
    recordings: [toRecording(book)],
    description: stripHtml(book.description ?? ''),
  }
}

export interface LibriVoxQuery {
  title?: string
  author?: string
  limit?: number
  offset?: number
  /** `extended=1` is what carries the per-section track list. */
  extended?: boolean
}

async function query(params: Record<string, string>, signal?: AbortSignal): Promise<LvBook[]> {
  const search = new URLSearchParams({ format: 'json', ...params })
  const response = await fetchJson<LvResponse>(`${BASE}/?${search}`, { signal })
  // The API answers a no-results search with `{"error":"..."}` rather than [].
  if (response.error) return []
  return response.books ?? []
}

export async function searchLibriVox(q: LibriVoxQuery, signal?: AbortSignal): Promise<CatalogWork[]> {
  const params: Record<string, string> = {
    limit: String(q.limit ?? 20),
    offset: String(q.offset ?? 0),
  }
  // `^` asks the API for a prefix match rather than an exact one.
  if (q.title) params['title'] = `^${q.title}`
  if (q.author) params['author'] = `^${q.author}`
  if (q.extended ?? false) params['extended'] = '1'

  const books = await query(params, signal)
  return books.map(toWork)
}

/** Full record including the section list — needed before any audio download. */
export async function getLibriVoxBook(id: string, signal?: AbortSignal): Promise<CatalogWork | null> {
  const books = await query({ id, extended: '1' }, signal)
  const first = books[0]
  return first ? toWork(first) : null
}

/**
 * Tracks are only present on `extended=1` responses, and search responses ask
 * for them without them being guaranteed. Fetch them on demand.
 */
export async function loadTracks(recordingId: string, signal?: AbortSignal): Promise<AudioTrack[]> {
  const id = recordingId.replace(/^librivox:/, '')
  const work = await getLibriVoxBook(id, signal)
  return work?.recordings[0]?.tracks ?? []
}
