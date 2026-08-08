/**
 * IndexedDB schema and accessors (§7.1).
 *
 * The service worker deliberately does *not* import this module — it talks to
 * IndexedDB with the raw API so that it stays a zero-import bundle (see
 * src/sw.ts). Any change to DB_NAME / DB_VERSION / the `assets` store must be
 * mirrored there.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type {
  AnnotationRecord,
  AssetRecord,
  BookRecord,
  Collection,
  DownloadJob,
  OutboxItem,
  ProgressRecord,
  Settings,
} from './types'

export const DB_NAME = 'pdr'
export const DB_VERSION = 1

interface PdrSchema extends DBSchema {
  books: {
    key: string
    value: BookRecord
    indexes: { addedAt: number; updatedAt: number }
  }
  assets: {
    key: string
    value: AssetRecord
    indexes: { bookId: string; 'bookId-kind': [string, string] }
  }
  progress: {
    key: string
    value: ProgressRecord
    indexes: { updatedAt: number }
  }
  annotations: {
    key: string
    value: AnnotationRecord
    indexes: { bookId: string; updatedAt: number }
  }
  downloads: {
    key: string
    value: DownloadJob
    indexes: { state: string; bookId: string; parentId: string }
  }
  outbox: {
    key: string
    value: OutboxItem
    indexes: { createdAt: number }
  }
  collections: {
    key: string
    value: Collection
  }
  settings: {
    key: string
    value: unknown
  }
}

let dbPromise: Promise<IDBPDatabase<PdrSchema>> | null = null

export function db(): Promise<IDBPDatabase<PdrSchema>> {
  dbPromise ??= openDB<PdrSchema>(DB_NAME, DB_VERSION, {
    upgrade(database, oldVersion) {
      if (oldVersion < 1) {
        const books = database.createObjectStore('books', { keyPath: 'bookId' })
        books.createIndex('addedAt', 'addedAt')
        books.createIndex('updatedAt', 'updatedAt')

        const assets = database.createObjectStore('assets', { keyPath: 'assetId' })
        assets.createIndex('bookId', 'bookId')
        assets.createIndex('bookId-kind', ['bookId', 'kind'])

        const progress = database.createObjectStore('progress', { keyPath: 'bookId' })
        progress.createIndex('updatedAt', 'updatedAt')

        const annotations = database.createObjectStore('annotations', { keyPath: 'id' })
        annotations.createIndex('bookId', 'bookId')
        annotations.createIndex('updatedAt', 'updatedAt')

        const downloads = database.createObjectStore('downloads', { keyPath: 'jobId' })
        downloads.createIndex('state', 'state')
        downloads.createIndex('bookId', 'bookId')
        downloads.createIndex('parentId', 'parentId')

        const outbox = database.createObjectStore('outbox', { keyPath: 'id' })
        outbox.createIndex('createdAt', 'createdAt')

        database.createObjectStore('collections', { keyPath: 'id' })
        database.createObjectStore('settings')
      }
    },
    blocked() {
      console.warn('[db] upgrade blocked by another tab')
    },
    blocking() {
      // Another tab wants to upgrade; let go so it isn't stuck behind us.
      dbPromise?.then((d) => d.close())
      dbPromise = null
    },
  })
  return dbPromise
}

// --- books -----------------------------------------------------------------

export async function getBook(bookId: string): Promise<BookRecord | undefined> {
  return (await db()).get('books', bookId)
}

export async function putBook(book: BookRecord): Promise<void> {
  await (await db()).put('books', book)
}

export async function allBooks(): Promise<BookRecord[]> {
  const books = await (await db()).getAllFromIndex('books', 'addedAt')
  return books.filter((b) => !b.deleted).reverse()
}

export async function deleteBook(bookId: string): Promise<void> {
  const database = await db()
  const tx = database.transaction(['books', 'assets', 'progress', 'annotations'], 'readwrite')
  await tx.objectStore('books').delete(bookId)
  await tx.objectStore('progress').delete(bookId)
  const assetKeys = await tx.objectStore('assets').index('bookId').getAllKeys(bookId)
  for (const key of assetKeys) await tx.objectStore('assets').delete(key)
  const annKeys = await tx.objectStore('annotations').index('bookId').getAllKeys(bookId)
  for (const key of annKeys) await tx.objectStore('annotations').delete(key)
  await tx.done
}

// --- assets ----------------------------------------------------------------

/**
 * Deterministic asset ids. The service worker resolves `/media/{assetId}`
 * straight to a key lookup, so this format is load-bearing.
 */
export function assetId(bookId: string, kind: string, trackIndex = 0): string {
  return `${bookId}::${kind}::${trackIndex}`
}

export async function getAsset(id: string): Promise<AssetRecord | undefined> {
  return (await db()).get('assets', id)
}

export async function putAsset(asset: AssetRecord): Promise<void> {
  await (await db()).put('assets', asset)
}

export async function deleteAsset(id: string): Promise<void> {
  await (await db()).delete('assets', id)
}

export async function assetsForBook(bookId: string): Promise<AssetRecord[]> {
  return (await db()).getAllFromIndex('assets', 'bookId', bookId)
}

/** Metadata-only listing. Avoids pulling hundreds of MB of blobs into memory. */
export async function assetSummaries(
  bookId?: string,
): Promise<{ assetId: string; bookId: string; kind: string; bytes: number; trackIndex?: number }[]> {
  const database = await db()
  const tx = database.transaction('assets', 'readonly')
  const store = tx.objectStore('assets')
  const out: { assetId: string; bookId: string; kind: string; bytes: number; trackIndex?: number }[] = []
  const source = bookId ? store.index('bookId').iterate(bookId) : store.iterate()
  for await (const cursor of source) {
    const v = cursor.value
    out.push({
      assetId: v.assetId,
      bookId: v.bookId,
      kind: v.kind,
      bytes: v.bytes,
      trackIndex: v.trackIndex,
    })
  }
  await tx.done
  return out
}

export async function hasAsset(id: string): Promise<boolean> {
  const key = await (await db()).getKey('assets', id)
  return key !== undefined
}

// --- progress --------------------------------------------------------------

export async function getProgress(bookId: string): Promise<ProgressRecord | undefined> {
  return (await db()).get('progress', bookId)
}

export async function putProgress(p: ProgressRecord): Promise<void> {
  await (await db()).put('progress', p)
}

export async function allProgress(): Promise<ProgressRecord[]> {
  return (await db()).getAll('progress')
}

// --- annotations -----------------------------------------------------------

export async function annotationsForBook(bookId: string): Promise<AnnotationRecord[]> {
  const rows = await (await db()).getAllFromIndex('annotations', 'bookId', bookId)
  return rows.filter((a) => !a.deleted).sort((a, b) => a.createdAt - b.createdAt)
}

export async function putAnnotation(a: AnnotationRecord): Promise<void> {
  await (await db()).put('annotations', a)
}

export async function getAnnotation(id: string): Promise<AnnotationRecord | undefined> {
  return (await db()).get('annotations', id)
}

export async function allAnnotations(): Promise<AnnotationRecord[]> {
  const rows = await (await db()).getAll('annotations')
  return rows.filter((a) => !a.deleted)
}

// --- downloads -------------------------------------------------------------

export async function putJob(job: DownloadJob): Promise<void> {
  await (await db()).put('downloads', job)
}

export async function getJob(jobId: string): Promise<DownloadJob | undefined> {
  return (await db()).get('downloads', jobId)
}

export async function allJobs(): Promise<DownloadJob[]> {
  return (await db()).getAll('downloads')
}

export async function jobsByState(state: string): Promise<DownloadJob[]> {
  return (await db()).getAllFromIndex('downloads', 'state', state)
}

export async function childJobs(parentId: string): Promise<DownloadJob[]> {
  return (await db()).getAllFromIndex('downloads', 'parentId', parentId)
}

export async function deleteJob(jobId: string): Promise<void> {
  await (await db()).delete('downloads', jobId)
}

// --- outbox ----------------------------------------------------------------

export async function enqueueOutbox(item: OutboxItem): Promise<void> {
  await (await db()).put('outbox', item)
}

export async function drainableOutbox(limit = 200): Promise<OutboxItem[]> {
  const rows = await (await db()).getAllFromIndex('outbox', 'createdAt')
  return rows.slice(0, limit)
}

export async function deleteOutbox(id: string): Promise<void> {
  await (await db()).delete('outbox', id)
}

export async function outboxSize(): Promise<number> {
  return (await db()).count('outbox')
}

// --- collections -----------------------------------------------------------

export async function allCollections(): Promise<Collection[]> {
  return (await db()).getAll('collections')
}

export async function putCollection(c: Collection): Promise<void> {
  await (await db()).put('collections', c)
}

export async function getCollection(id: string): Promise<Collection | undefined> {
  return (await db()).get('collections', id)
}

export async function deleteCollection(id: string): Promise<void> {
  await (await db()).delete('collections', id)
}

// --- settings (a plain key/value store) ------------------------------------

export async function getSetting<K extends keyof Settings>(
  key: K,
): Promise<Settings[K] | undefined> {
  return (await db()).get('settings', key as string) as Promise<Settings[K] | undefined>
}

export async function setSetting<K extends keyof Settings>(
  key: K,
  value: Settings[K],
): Promise<void> {
  await (await db()).put('settings', value, key as string)
}

/**
 * Untyped corner of the settings store, for derived caches that aren't user
 * preferences (e.g. the reader's per-book outline cache).
 */
export async function getKV<T>(key: string): Promise<T | undefined> {
  return (await db()).get('settings', key) as Promise<T | undefined>
}

export async function setKV<T>(key: string, value: T): Promise<void> {
  await (await db()).put('settings', value, key)
}
