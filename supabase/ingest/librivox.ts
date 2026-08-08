/**
 * LibriVox ingest (§6.2). Paginates the whole API with `extended=1` so the
 * per-section track lists land in the catalog and the app never has to call
 * LibriVox at read time.
 *
 * Every recording gets a placeholder work row. The matcher (0003_match.sql)
 * then decides which of them fold into an existing text work; the leftovers
 * stay as audio-only works, which is correct — a LibriVox-only recording is
 * still worth listening to.
 */
import { normalizeAuthor, normalizeTitle } from '../../src/core/ids.ts'
import { fetchWithRetry, nowIso, sleep, type RecordingRow, type WorkRow } from './client.ts'

const BASE = 'https://librivox.org/api/feed/audiobooks'
const PAGE_SIZE = 50

interface LvSection {
  section_number: string
  title: string
  listen_url: string
  playtime: string
  readers?: { display_name: string }[]
}

interface LvBook {
  id: string
  title: string
  description: string
  language: string
  copyright_year: string
  num_sections: string
  url_librivox: string
  url_iarchive?: string
  url_zip_file?: string
  totaltimesecs: number
  authors: { first_name: string; last_name: string }[]
  genres?: { name: string }[]
  sections?: LvSection[]
}

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
  Multilingual: 'mul',
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
}

function archiveIdentifier(book: LvBook): string | null {
  const source = book.url_iarchive || book.url_zip_file || ''
  const match = /archive\.org\/(?:details|download|compress)\/([^/?&]+)/.exec(source)
  return match?.[1] ?? null
}

export interface LibriVoxResult {
  works: WorkRow[]
  recordings: RecordingRow[]
}

export async function ingestLibriVox(options: { limit?: number } = {}): Promise<LibriVoxResult> {
  const works: WorkRow[] = []
  const recordings: RecordingRow[] = []
  const stamp = nowIso()

  let offset = 0
  for (;;) {
    const url = `${BASE}/?format=json&extended=1&limit=${PAGE_SIZE}&offset=${offset}`
    const response = await fetchWithRetry(url)
    if (!response.ok) throw new Error(`LibriVox ${response.status} at offset ${offset}`)

    // A page past the end answers `{"error":"..."}` rather than an empty list.
    const payload = (await response.json()) as { books?: LvBook[]; error?: string }
    const books = payload.books ?? []
    if (payload.error || books.length === 0) break

    for (const book of books) {
      const workId = `librivox:${book.id}`
      const authors = book.authors
        .map((a) => `${a.first_name} ${a.last_name}`.trim())
        .filter(Boolean)
      const identifier = archiveIdentifier(book)

      const tracks = (book.sections ?? []).map((section, index) => ({
        trackIndex: Number(section.section_number) - 1 || index,
        title: section.title?.trim() || `Section ${section.section_number}`,
        url: section.listen_url.replace('://www.archive.org/', '://archive.org/'),
        seconds: Number(section.playtime) || 0,
        reader: section.readers?.[0]?.display_name,
      }))

      const readers = [
        ...new Set(tracks.map((t) => t.reader).filter((r): r is string => Boolean(r))),
      ]

      const normTitle = normalizeTitle(book.title)
      const normAuthor = normalizeAuthor(authors[0] ?? '')

      works.push({
        work_id: workId,
        title: book.title.trim(),
        authors,
        norm_title: normTitle,
        norm_author: normAuthor,
        language: LANGUAGE_CODES[book.language] ?? book.language.slice(0, 2).toLowerCase(),
        subjects: (book.genres ?? []).map((g) => g.name),
        cover_url: identifier ? `https://archive.org/services/img/${identifier}` : null,
        year: Number(book.copyright_year) || null,
        description: stripHtml(book.description ?? '').slice(0, 4000),
        updated_at: stamp,
      })

      recordings.push({
        recording_id: workId,
        work_id: workId,
        source: 'librivox',
        page_url: book.url_librivox ?? null,
        total_seconds: book.totaltimesecs || tracks.reduce((sum, t) => sum + t.seconds, 0),
        readers,
        track_count: Number(book.num_sections) || tracks.length,
        bitrates: [64, 128],
        tracks,
        norm_title: normTitle,
        norm_author: normAuthor,
        updated_at: stamp,
      })
    }

    offset += PAGE_SIZE
    if (options.limit && recordings.length >= options.limit) break
    if (offset % 500 === 0) console.log(`  …${recordings.length} recordings so far`)
    await sleep(600)
  }

  return { works, recordings }
}
