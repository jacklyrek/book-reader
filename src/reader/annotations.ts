/**
 * Highlights, notes and bookmarks (§7.1, M4).
 *
 * Resolving §10: locators are EPUB CFIs and exports carry the source URL and
 * chapter alongside the quote, so a highlight can move into the commonplace
 * book without losing its provenance.
 */
import { annotationsForBook, enqueueOutbox, getAnnotation, getBook, putAnnotation } from '../core/db'
import { uid } from '../core/ids'
import { createStore } from '../core/store'
import type { AnnotationKind, AnnotationRecord, BookRecord } from '../core/types'

export const HIGHLIGHT_COLORS = [
  { name: 'Yellow', value: '#e0b83a' },
  { name: 'Green', value: '#5f9e6a' },
  { name: 'Blue', value: '#4f7fb0' },
  { name: 'Pink', value: '#c06b8a' },
  { name: 'Grey', value: '#8b8680' },
] as const

/** Bumped on every write so open views re-read. */
export const annotationVersion = createStore(0)

async function persist(annotation: AnnotationRecord): Promise<AnnotationRecord> {
  await putAnnotation(annotation)
  await enqueueOutbox({
    id: uid('out'),
    table: 'annotations',
    op: annotation.deleted ? 'delete' : 'upsert',
    payload: annotation as unknown as Record<string, unknown>,
    createdAt: Date.now(),
    tries: 0,
  })
  annotationVersion.set((n) => n + 1)
  return annotation
}

export async function createAnnotation(input: {
  bookId: string
  locator: string
  kind: AnnotationKind
  color?: string
  text?: string
  note?: string
  chapter?: string
}): Promise<AnnotationRecord> {
  const now = Date.now()
  return persist({
    id: uid('ann'),
    color: HIGHLIGHT_COLORS[0].value,
    ...input,
    createdAt: now,
    updatedAt: now,
  })
}

export async function updateAnnotation(
  id: string,
  patch: Partial<Pick<AnnotationRecord, 'note' | 'color' | 'kind'>>,
): Promise<AnnotationRecord | null> {
  const existing = await getAnnotation(id)
  if (!existing) return null
  return persist({ ...existing, ...patch, updatedAt: Date.now() })
}

export async function deleteAnnotation(id: string): Promise<void> {
  const existing = await getAnnotation(id)
  if (!existing) return
  // Tombstone rather than a hard delete, so the other device drops it too.
  await persist({ ...existing, deleted: true, updatedAt: Date.now() })
}

export async function listAnnotations(bookId: string): Promise<AnnotationRecord[]> {
  return annotationsForBook(bookId)
}

// ---------------------------------------------------------------------------
// Export (§10 — shared shape with the commonplace book)
// ---------------------------------------------------------------------------

export interface ExportedAnnotation {
  quote?: string
  note?: string
  kind: AnnotationKind
  chapter?: string
  /** EPUB CFI. The shared locator format. */
  locator: string
  createdAt: string
  book: {
    title: string
    authors: string[]
    bookId: string
    source?: string
    sourceUrl?: string
  }
}

export async function exportBookAnnotations(bookId: string): Promise<ExportedAnnotation[]> {
  const [book, annotations] = await Promise.all([getBook(bookId), annotationsForBook(bookId)])
  if (!book) return []
  return annotations.map((a) => toExport(a, book))
}

function toExport(annotation: AnnotationRecord, book: BookRecord): ExportedAnnotation {
  return {
    quote: annotation.text,
    note: annotation.note,
    kind: annotation.kind,
    chapter: annotation.chapter,
    locator: annotation.locator,
    createdAt: new Date(annotation.createdAt).toISOString(),
    book: {
      title: book.title,
      authors: book.authors,
      bookId: book.bookId,
      source: book.edition?.source,
      sourceUrl: book.edition?.pageUrl,
    },
  }
}

export function toMarkdown(entries: ExportedAnnotation[]): string {
  if (entries.length === 0) return ''
  const book = entries[0]?.book
  const lines: string[] = []
  if (book) {
    lines.push(`# ${book.title}`)
    if (book.authors.length) lines.push(`*${book.authors.join(', ')}*`)
    if (book.sourceUrl) lines.push(`\n[Source](${book.sourceUrl})`)
    lines.push('')
  }

  let chapter: string | undefined
  for (const entry of entries) {
    if (entry.chapter && entry.chapter !== chapter) {
      chapter = entry.chapter
      lines.push(`\n## ${chapter}\n`)
    }
    if (entry.kind === 'bookmark') {
      lines.push(`- 🔖 Bookmark — \`${entry.locator}\``)
      continue
    }
    if (entry.quote) {
      lines.push(entry.quote.split('\n').map((l) => `> ${l}`).join('\n'))
    }
    if (entry.note) lines.push(`\n${entry.note}`)
    lines.push(`\n<!-- cfi: ${entry.locator} -->\n`)
  }
  return lines.join('\n')
}

/** Triggers a share-sheet download; there's no File System Access API on iOS. */
export function downloadExport(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
