/**
 * Project Gutenberg via Gutendex (§4). The breadth tier: ~75k books, quality
 * from excellent to raw OCR.
 *
 * Gutendex itself sends CORS headers; the EPUB files on gutenberg.org do not,
 * so downloads go through the proxy.
 */
import { bookIdFor } from '../core/ids'
import type { CatalogWork, TextEdition } from '../core/types'
import { fetchJson } from './proxy'

const BASE = 'https://gutendex.com'

interface GutendexAuthor {
  name: string
  birth_year: number | null
  death_year: number | null
}

interface GutendexBook {
  id: number
  title: string
  authors: GutendexAuthor[]
  translators: GutendexAuthor[]
  subjects: string[]
  bookshelves: string[]
  languages: string[]
  copyright: boolean | null
  media_type: string
  formats: Record<string, string>
  download_count: number
  summaries?: string[]
}

interface GutendexPage {
  count: number
  next: string | null
  previous: string | null
  results: GutendexBook[]
}

/** "Melville, Herman" → "Herman Melville". */
export function displayAuthor(name: string): string {
  if (!name.includes(',')) return name
  const [last = '', rest = ''] = name.split(',', 2)
  const first = rest.trim()
  return first ? `${first} ${last.trim()}` : last.trim()
}

function pickEpub(formats: Record<string, string>): string | undefined {
  // epub3.images is the richest of the three EPUB variants Gutenberg emits.
  const epub = formats['application/epub+zip']
  if (!epub) return undefined
  return epub
}

function pickCover(formats: Record<string, string>): string | undefined {
  return formats['image/jpeg']
}

function toWork(book: GutendexBook): CatalogWork | null {
  const epubUrl = pickEpub(book.formats)
  if (!epubUrl) return null
  const bookId = bookIdFor('gutenberg', String(book.id))
  const edition: TextEdition = {
    editionId: bookId,
    source: 'gutenberg',
    epubUrl,
    language: book.languages[0] ?? 'en',
    pageUrl: `https://www.gutenberg.org/ebooks/${book.id}`,
    translator: book.translators[0]?.name ? displayAuthor(book.translators[0].name) : undefined,
  }
  return {
    workId: bookId,
    title: book.title,
    authors: book.authors.map((a) => displayAuthor(a.name)),
    language: book.languages[0] ?? 'en',
    subjects: book.subjects.slice(0, 8),
    coverUrl: pickCover(book.formats),
    year: book.authors[0]?.death_year ?? undefined,
    editions: [edition],
    recordings: [],
    description: book.summaries?.[0],
  }
}

export interface GutendexQuery {
  search?: string
  languages?: string[]
  topic?: string
  ids?: number[]
  page?: number
  sort?: 'popular' | 'ascending' | 'descending'
}

export async function searchGutenberg(query: GutendexQuery, signal?: AbortSignal): Promise<CatalogWork[]> {
  const params = new URLSearchParams()
  if (query.search) params.set('search', query.search)
  if (query.languages?.length) params.set('languages', query.languages.join(','))
  if (query.topic) params.set('topic', query.topic)
  if (query.ids?.length) params.set('ids', query.ids.join(','))
  if (query.page) params.set('page', String(query.page))
  if (query.sort) params.set('sort', query.sort)
  params.set('mime_type', 'application/epub+zip')

  const page = await fetchJson<GutendexPage>(`${BASE}/books?${params}`, { signal })
  return page.results.map(toWork).filter((w): w is CatalogWork => w !== null)
}

export async function getGutenbergBook(id: number, signal?: AbortSignal): Promise<CatalogWork | null> {
  const page = await fetchJson<GutendexPage>(`${BASE}/books?ids=${id}`, { signal })
  const first = page.results[0]
  return first ? toWork(first) : null
}
