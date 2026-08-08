/**
 * Standard Ebooks (§4). ~1,000 meticulously typeset EPUBs — the best reading
 * experience by a wide margin, so these outrank every other source when an
 * edition exists (see SOURCE_RANK).
 *
 * Caveat the design doc predates: the bulk feeds (`/feeds/opds/all`,
 * `/feeds/atom/all`) now answer 401 with
 *   `WWW-Authenticate: Basic realm="Enter your Patrons Circle email address…"`.
 * Only `/feeds/atom/new-releases` (the 15 most recent) is public. The proxy
 * Worker holds the Patrons Circle credential and attaches it server-side, so it
 * never ships in the client bundle. Without a credential the adapter degrades
 * to the new-releases feed and the app leans on Gutenberg for breadth.
 */
import type { CatalogWork, TextEdition } from '../core/types'
import { fetchXml } from './proxy'

const BASE = 'https://standardebooks.org'
const SEARCH_FEED = `${BASE}/feeds/opds/all`
const PUBLIC_FEED = `${BASE}/feeds/atom/new-releases`

const ATOM = 'http://www.w3.org/2005/Atom'

function text(parent: Element, tag: string): string {
  const el = parent.getElementsByTagNameNS(ATOM, tag)[0] ?? parent.getElementsByTagName(tag)[0]
  return el?.textContent?.trim() ?? ''
}

interface FeedLink {
  href: string
  rel: string
  type: string
  title: string
  length: number
}

function links(entry: Element): FeedLink[] {
  return [...entry.getElementsByTagName('link')].map((el) => ({
    href: el.getAttribute('href') ?? '',
    rel: el.getAttribute('rel') ?? '',
    type: el.getAttribute('type') ?? '',
    title: el.getAttribute('title') ?? '',
    length: Number(el.getAttribute('length')) || 0,
  }))
}

/**
 * SE ships several EPUB builds per book. Prefer the "recommended compatible"
 * one: the advanced build uses CSS that older rendering engines choke on, and
 * we are running inside iOS Safari.
 */
function pickEpub(entry: Element): FeedLink | undefined {
  const epubs = links(entry).filter(
    (l) =>
      l.type === 'application/epub+zip' &&
      (l.rel === 'enclosure' || l.rel.includes('opds-spec.org/acquisition')),
  )
  if (epubs.length === 0) return undefined
  return (
    epubs.find((l) => /recommended|compatible/i.test(l.title)) ??
    epubs.find((l) => !/advanced/i.test(l.title)) ??
    epubs[0]
  )
}

function pickCover(entry: Element): string | undefined {
  const thumbnail = entry.getElementsByTagNameNS('*', 'thumbnail')[0]?.getAttribute('url')
  if (thumbnail) return thumbnail
  const image = links(entry).find((l) => l.rel.includes('opds-spec.org/image'))
  return image?.href
}

function entryToWork(entry: Element): CatalogWork | null {
  const epub = pickEpub(entry)
  if (!epub) return null

  const id = text(entry, 'id')
  const slug = id.replace(`${BASE}/ebooks/`, '')
  const authors = [...entry.getElementsByTagNameNS(ATOM, 'author')]
    .map((a) => a.getElementsByTagNameNS(ATOM, 'name')[0]?.textContent?.trim() ?? '')
    .filter(Boolean)

  const subjects = [...entry.getElementsByTagName('category')]
    .map((c) => c.getAttribute('term') ?? '')
    .filter(Boolean)

  const workId = `standard-ebooks:${slug}`
  const edition: TextEdition = {
    editionId: workId,
    source: 'standard-ebooks',
    epubUrl: epub.href,
    bytes: epub.length || undefined,
    language: text(entry, 'language') || 'en',
    pageUrl: links(entry).find((l) => l.rel === 'alternate')?.href ?? id,
  }

  const published = text(entry, 'published')

  return {
    workId,
    title: text(entry, 'title'),
    authors,
    language: edition.language,
    subjects: subjects.slice(0, 8),
    coverUrl: pickCover(entry),
    year: published ? new Date(published).getFullYear() : undefined,
    editions: [edition],
    recordings: [],
    description: text(entry, 'summary'),
  }
}

function parseFeed(doc: Document): CatalogWork[] {
  const entries = [...doc.getElementsByTagNameNS(ATOM, 'entry')]
  const source = entries.length ? entries : [...doc.getElementsByTagName('entry')]
  return source.map(entryToWork).filter((w): w is CatalogWork => w !== null)
}

/** True once we've learned this deployment has no Patrons Circle credential. */
let bulkFeedUnavailable = false

export async function searchStandardEbooks(
  query: string,
  signal?: AbortSignal,
  perPage = 20,
): Promise<CatalogWork[]> {
  if (!bulkFeedUnavailable) {
    try {
      const params = new URLSearchParams({ query, 'per-page': String(perPage) })
      const doc = await fetchXml(`${SEARCH_FEED}?${params}`, { signal })
      return parseFeed(doc)
    } catch (error) {
      const message = String(error)
      if (message.includes('401') || message.includes('403')) {
        console.info(
          '[standard-ebooks] bulk feed needs a Patrons Circle credential on the proxy; ' +
            'falling back to the public new-releases feed.',
        )
        bulkFeedUnavailable = true
      } else {
        throw error
      }
    }
  }

  // Degraded path: filter the 15 newest locally. Better than nothing, and it
  // keeps the "Standard Ebooks first" ranking honest when it does hit.
  const works = await newReleases(signal)
  const needle = query.toLowerCase()
  return works.filter(
    (w) =>
      w.title.toLowerCase().includes(needle) ||
      w.authors.some((a) => a.toLowerCase().includes(needle)),
  )
}

export async function newReleases(signal?: AbortSignal): Promise<CatalogWork[]> {
  const doc = await fetchXml(PUBLIC_FEED, { signal })
  return parseFeed(doc)
}

export function isBulkFeedUnavailable(): boolean {
  return bulkFeedUnavailable
}
