/**
 * Standard Ebooks ingest (§6.2).
 *
 * The design doc assumed a public OPDS feed. As of now the bulk feeds answer
 * 401:
 *   WWW-Authenticate: Basic realm="Enter your Patrons Circle email address and
 *                                  leave the password empty."
 * So the full catalogue needs `SE_OPDS_EMAIL` (username, empty password).
 * Without it we fall back to `/feeds/atom/new-releases`, which is public but
 * carries only the 15 most recent books — enough to keep the app's front page
 * alive, not enough to be a catalogue.
 *
 * The feeds are machine-generated Atom with a stable shape, so this parses them
 * with regexes rather than pulling in an XML parser for a job that runs once a
 * night.
 */
import { normalizeAuthor, normalizeTitle } from '../../src/core/ids.ts'
import { fetchWithRetry, nowIso, type EditionRow, type WorkRow } from './client.ts'

const BASE = 'https://standardebooks.org'
const BULK_FEED = `${BASE}/feeds/opds/all`
const PUBLIC_FEED = `${BASE}/feeds/atom/new-releases`

interface ParsedEntry {
  id: string
  title: string
  authors: string[]
  summary: string
  subjects: string[]
  coverUrl: string | null
  epubUrl: string | null
  epubBytes: number | null
  language: string
  pageUrl: string | null
  published: string | null
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function tagText(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml)
  return match?.[1] ? decodeEntities(match[1].trim()) : ''
}

interface FeedLink {
  href: string
  rel: string
  type: string
  title: string
  length: number
}

function links(xml: string): FeedLink[] {
  const out: FeedLink[] = []
  for (const match of xml.matchAll(/<link\b([^>]*)\/?>/g)) {
    const attributes = match[1] ?? ''
    const attribute = (name: string): string =>
      decodeEntities(new RegExp(`${name}="([^"]*)"`).exec(attributes)?.[1] ?? '')
    out.push({
      href: attribute('href'),
      rel: attribute('rel'),
      type: attribute('type'),
      title: attribute('title'),
      length: Number(attribute('length')) || 0,
    })
  }
  return out
}

function parseEntry(xml: string): ParsedEntry {
  const all = links(xml)
  const epubs = all.filter(
    (link) =>
      link.type === 'application/epub+zip' &&
      (link.rel === 'enclosure' || link.rel.includes('opds-spec.org/acquisition')),
  )
  // SE ships several builds; the "advanced" one uses CSS that older engines
  // choke on, and we render inside iOS Safari.
  const epub =
    epubs.find((link) => /recommended|compatible/i.test(link.title)) ??
    epubs.find((link) => !/advanced/i.test(link.title)) ??
    epubs[0]

  const authors = [...xml.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/g)]
    .map((match) => decodeEntities((match[1] ?? '').trim()))
    .filter(Boolean)

  const subjects = [...xml.matchAll(/<category[^>]*term="([^"]*)"/g)]
    .map((match) => decodeEntities(match[1] ?? ''))
    .filter(Boolean)

  const thumbnail = /<media:thumbnail[^>]*url="([^"]*)"/.exec(xml)?.[1]
  const image = all.find((link) => link.rel.includes('opds-spec.org/image'))

  return {
    id: tagText(xml, 'id'),
    title: tagText(xml, 'title'),
    authors,
    summary: tagText(xml, 'summary'),
    subjects: subjects.slice(0, 12),
    coverUrl: thumbnail ? decodeEntities(thumbnail) : (image?.href ?? null),
    epubUrl: epub?.href ?? null,
    epubBytes: epub?.length || null,
    language: tagText(xml, 'dc:language') || 'en',
    pageUrl: all.find((link) => link.rel === 'alternate')?.href ?? null,
    published: tagText(xml, 'published') || null,
  }
}

function parseFeed(xml: string): ParsedEntry[] {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
    .map((match) => parseEntry(match[1] ?? ''))
    .filter((entry) => entry.epubUrl && entry.title)
}

export interface StandardEbooksResult {
  works: WorkRow[]
  editions: EditionRow[]
  degraded: boolean
}

export async function ingestStandardEbooks(): Promise<StandardEbooksResult> {
  const email = process.env['SE_OPDS_EMAIL'] ?? ''
  const stamp = nowIso()

  let entries: ParsedEntry[] = []
  let degraded = false

  if (email) {
    const response = await fetchWithRetry(BULK_FEED, {
      headers: { Authorization: `Basic ${Buffer.from(`${email}:`).toString('base64')}` },
    })
    if (response.ok) {
      entries = parseFeed(await response.text())
    } else if (response.status === 401 || response.status === 403) {
      console.warn(
        `[standard-ebooks] ${response.status} on the bulk feed — is ${email} a current Patrons Circle member?`,
      )
      degraded = true
    } else {
      throw new Error(`Standard Ebooks feed: HTTP ${response.status}`)
    }
  } else {
    console.warn('[standard-ebooks] SE_OPDS_EMAIL unset; using the public new-releases feed only.')
    degraded = true
  }

  if (degraded) {
    const response = await fetchWithRetry(PUBLIC_FEED)
    if (!response.ok) throw new Error(`Standard Ebooks public feed: HTTP ${response.status}`)
    entries = parseFeed(await response.text())
  }

  const works: WorkRow[] = []
  const editions: EditionRow[] = []

  for (const entry of entries) {
    const slug = entry.id.replace(`${BASE}/ebooks/`, '')
    const workId = `standard-ebooks:${slug}`

    works.push({
      work_id: workId,
      title: entry.title,
      authors: entry.authors,
      norm_title: normalizeTitle(entry.title),
      norm_author: normalizeAuthor(entry.authors[0] ?? ''),
      language: entry.language,
      subjects: entry.subjects,
      cover_url: entry.coverUrl,
      year: entry.published ? new Date(entry.published).getFullYear() : null,
      description: entry.summary || null,
      updated_at: stamp,
    })

    editions.push({
      edition_id: workId,
      work_id: workId,
      source: 'standard-ebooks',
      epub_url: entry.epubUrl as string,
      bytes: entry.epubBytes,
      language: entry.language,
      page_url: entry.pageUrl,
      translator: null,
      updated_at: stamp,
    })
  }

  return { works, editions, degraded }
}
