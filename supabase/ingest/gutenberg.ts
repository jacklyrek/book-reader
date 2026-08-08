/**
 * Project Gutenberg ingest via Gutendex (§6.2).
 *
 * The design mentions the official RDF catalog dump as the alternative. The
 * dump is more complete and kinder to Gutenberg's servers for a full rebuild,
 * but it is a 900 MB tarball of one RDF file per book; Gutendex gives the same
 * fields as JSON with cursor pagination, and `?modified_since=` makes the
 * nightly run cheap. Use the dump if you ever need to rebuild from cold
 * without hammering the API.
 */
import { normalizeAuthor, normalizeTitle } from '../../src/core/ids.ts'
import {
  fetchWithRetry,
  nowIso,
  sleep,
  type EditionRow,
  type WorkRow,
} from './client.ts'

const BASE = 'https://gutendex.com'

interface GutendexBook {
  id: number
  title: string
  authors: { name: string; birth_year: number | null; death_year: number | null }[]
  translators: { name: string }[]
  subjects: string[]
  languages: string[]
  formats: Record<string, string>
  summaries?: string[]
  download_count: number
}

interface GutendexPage {
  count: number
  next: string | null
  results: GutendexBook[]
}

function displayAuthor(name: string): string {
  if (!name.includes(',')) return name
  const [last = '', rest = ''] = name.split(',', 2)
  const first = rest.trim()
  return first ? `${first} ${last.trim()}` : last.trim()
}

export interface GutenbergResult {
  works: WorkRow[]
  editions: EditionRow[]
}

export async function ingestGutenberg(options: { limit?: number } = {}): Promise<GutenbergResult> {
  const works: WorkRow[] = []
  const editions: EditionRow[] = []
  const stamp = nowIso()

  let url: string | null = `${BASE}/books?mime_type=application%2Fepub%2Bzip&languages=en`
  let pages = 0

  while (url) {
    const response = await fetchWithRetry(url)
    if (!response.ok) throw new Error(`Gutendex ${response.status} for ${url}`)
    const page = (await response.json()) as GutendexPage

    for (const book of page.results) {
      const epubUrl = book.formats['application/epub+zip']
      if (!epubUrl) continue

      const workId = `gutenberg:${book.id}`
      const authors = book.authors.map((a) => displayAuthor(a.name))

      works.push({
        work_id: workId,
        title: book.title,
        authors,
        norm_title: normalizeTitle(book.title),
        norm_author: normalizeAuthor(authors[0] ?? ''),
        language: book.languages[0] ?? 'en',
        subjects: book.subjects.slice(0, 12),
        cover_url: book.formats['image/jpeg'] ?? null,
        year: book.authors[0]?.death_year ?? null,
        description: book.summaries?.[0] ?? null,
        updated_at: stamp,
      })

      editions.push({
        edition_id: workId,
        work_id: workId,
        source: 'gutenberg',
        epub_url: epubUrl,
        bytes: null,
        language: book.languages[0] ?? 'en',
        page_url: `https://www.gutenberg.org/ebooks/${book.id}`,
        translator: book.translators[0]?.name ? displayAuthor(book.translators[0].name) : null,
        updated_at: stamp,
      })
    }

    pages++
    if (options.limit && works.length >= options.limit) break
    url = page.next
    // Gutendex is a small volunteer-run service. One request a second.
    await sleep(1000)
    if (pages % 25 === 0) console.log(`  …${works.length} works so far`)
  }

  return { works, editions }
}
