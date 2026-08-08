/**
 * Shelves (§10, "Great Books integration").
 *
 * A collection is either an ordinary user list or a *curated* one seeded from a
 * canon. Curated collections carry `wanted` entries — works that belong on the
 * shelf but aren't in the library yet — which is what turns the library UI from
 * "recently added" into something you can make progress against.
 */
import { allCollections, getCollection, putCollection } from './db'
import { normalizeAuthor, normalizeTitle } from './ids'
import { createStore } from './store'
import type { BookRecord, Collection } from './types'
import { GREAT_BOOKS_SEED } from './great-books'

export const collectionVersion = createStore(0)

export const GREAT_BOOKS_ID = 'great-books'

/**
 * Seed curated shelves once. Idempotent: re-running updates the wanted list
 * without touching which books the user has attached.
 */
export async function seedCuratedCollections(): Promise<void> {
  const existing = await getCollection(GREAT_BOOKS_ID)
  await putCollection({
    id: GREAT_BOOKS_ID,
    name: 'Great Books',
    description:
      'The Britannica Great Books of the Western World canon. Entries turn into shelf items as you add matching books.',
    bookIds: existing?.bookIds ?? [],
    curated: true,
    wanted: GREAT_BOOKS_SEED,
    updatedAt: Date.now(),
  })
  collectionVersion.set((n) => n + 1)
}

export async function listCollections(): Promise<Collection[]> {
  const rows = await allCollections()
  return rows.sort((a, b) => Number(b.curated ?? false) - Number(a.curated ?? false))
}

export async function createCollection(name: string, description?: string): Promise<Collection> {
  const collection: Collection = {
    id: `col_${normalizeTitle(name).replace(/\s+/g, '-') || Date.now().toString(36)}`,
    name,
    description,
    bookIds: [],
    updatedAt: Date.now(),
  }
  await putCollection(collection)
  collectionVersion.set((n) => n + 1)
  return collection
}

export async function addToCollection(collectionId: string, bookId: string): Promise<void> {
  const collection = await getCollection(collectionId)
  if (!collection || collection.bookIds.includes(bookId)) return
  await putCollection({
    ...collection,
    bookIds: [...collection.bookIds, bookId],
    updatedAt: Date.now(),
  })
  collectionVersion.set((n) => n + 1)
}

export async function removeFromCollection(collectionId: string, bookId: string): Promise<void> {
  const collection = await getCollection(collectionId)
  if (!collection) return
  await putCollection({
    ...collection,
    bookIds: collection.bookIds.filter((id) => id !== bookId),
    updatedAt: Date.now(),
  })
  collectionVersion.set((n) => n + 1)
}

export interface ShelfEntry {
  title: string
  author: string
  book?: BookRecord
}

/**
 * Line a curated list up against the library. Matching is deliberately loose —
 * catalog titles carry subtitles and translator names that the canon list
 * doesn't.
 */
export function resolveShelf(collection: Collection, books: BookRecord[]): ShelfEntry[] {
  const attached = new Set(collection.bookIds)
  const entries: ShelfEntry[] = (collection.wanted ?? []).map((wanted) => {
    const wantedTitle = normalizeTitle(wanted.title)
    const wantedAuthor = normalizeAuthor(wanted.author)
    const book = books.find((candidate) => {
      if (attached.has(candidate.bookId)) return false
      const titleMatch = normalizeTitle(candidate.title).startsWith(wantedTitle)
      const authorMatch = candidate.authors.some((a) => normalizeAuthor(a).includes(wantedAuthor))
      return titleMatch && authorMatch
    })
    return { title: wanted.title, author: wanted.author, book }
  })

  // Explicitly added books that aren't part of the canon list still belong.
  for (const bookId of collection.bookIds) {
    const book = books.find((b) => b.bookId === bookId)
    if (book) entries.push({ title: book.title, author: book.authors[0] ?? '', book })
  }

  return entries
}
