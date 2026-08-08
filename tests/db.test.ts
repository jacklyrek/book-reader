/**
 * The IndexedDB layer (§7.1), exercised against a real IndexedDB
 * implementation rather than a mock — the indexes and the delete cascade are
 * the parts worth testing, and a mock wouldn't have either.
 */
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { beforeEach, test } from 'vitest'
import {
  allBooks,
  annotationsForBook,
  assetId,
  assetSummaries,
  childJobs,
  db,
  deleteBook,
  drainableOutbox,
  enqueueOutbox,
  getAsset,
  getBook,
  getKV,
  hasAsset,
  putAnnotation,
  putAsset,
  putBook,
  putJob,
  putProgress,
  setKV,
  jobsByState,
} from '../src/core/db'
import { bookDownloadProgress } from '../src/core/downloads'
import type { AssetRecord, BookRecord, DownloadJob } from '../src/core/types'

function book(id: string, title = 'Moby Dick'): BookRecord {
  return {
    bookId: id,
    title,
    authors: ['Herman Melville'],
    language: 'en',
    subjects: [],
    addedAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function asset(bookId: string, kind: 'epub' | 'audio' | 'cover', trackIndex = 0, bytes = 1024): AssetRecord {
  return {
    assetId: assetId(bookId, kind, trackIndex),
    bookId,
    kind,
    trackIndex,
    blob: new Blob([new Uint8Array(bytes)]),
    bytes,
    mime: kind === 'audio' ? 'audio/mpeg' : 'application/epub+zip',
    createdAt: Date.now(),
  }
}

beforeEach(async () => {
  // Wipe between tests; fake-indexeddb persists for the module's lifetime.
  const database = await db()
  const stores = ['books', 'assets', 'progress', 'annotations', 'downloads', 'outbox', 'settings'] as const
  const tx = database.transaction(stores, 'readwrite')
  await Promise.all(stores.map((store) => tx.objectStore(store).clear()))
  await tx.done
})

test('asset ids are deterministic — the service worker depends on it', () => {
  assert.equal(assetId('gutenberg:2701', 'epub'), 'gutenberg:2701::epub::0')
  assert.equal(assetId('gutenberg:2701', 'audio', 12), 'gutenberg:2701::audio::12')
  // Same inputs, same id, so a re-download replaces rather than duplicates.
  assert.equal(assetId('x', 'audio', 3), assetId('x', 'audio', 3))
})

test('books round-trip and list newest first', async () => {
  await putBook({ ...book('a', 'First'), addedAt: 1000 })
  await putBook({ ...book('b', 'Second'), addedAt: 2000 })

  const books = await allBooks()
  assert.deepEqual(
    books.map((b) => b.title),
    ['Second', 'First'],
  )
  assert.equal((await getBook('a'))?.title, 'First')
})

test('deleted books are hidden from the shelf but keep their row', async () => {
  await putBook({ ...book('a'), deleted: true })
  assert.equal((await allBooks()).length, 0)
  assert.ok(await getBook('a'), 'the tombstone survives for sync')
})

test('asset summaries report bytes without loading blobs', async () => {
  await putBook(book('a'))
  await putAsset(asset('a', 'epub', 0, 500_000))
  await putAsset(asset('a', 'audio', 0, 20_000_000))
  await putAsset(asset('a', 'audio', 1, 18_000_000))
  await putAsset(asset('b', 'epub', 0, 300_000))

  const forBook = await assetSummaries('a')
  assert.equal(forBook.length, 3)
  assert.equal(
    forBook.reduce((sum, entry) => sum + entry.bytes, 0),
    38_500_000,
  )
  assert.equal((await assetSummaries()).length, 4, 'no filter returns every asset')
  // Summaries must not carry blobs, or the storage screen would load 300 MB.
  assert.ok(!('blob' in (forBook[0] as object)))
})

test('hasAsset distinguishes downloaded from not', async () => {
  await putAsset(asset('a', 'audio', 7))
  assert.equal(await hasAsset(assetId('a', 'audio', 7)), true)
  assert.equal(await hasAsset(assetId('a', 'audio', 8)), false)
})

test('the stored blob is byte-identical, and slices cleanly for range serving', async () => {
  const bytes = new Uint8Array(1000).map((_, i) => i % 256)
  await putAsset({ ...asset('a', 'audio'), blob: new Blob([bytes]), bytes: 1000 })

  const stored = await getAsset(assetId('a', 'audio'))
  assert.equal(stored?.blob.size, 1000)
  const slice = await stored!.blob.slice(100, 200).arrayBuffer()
  assert.equal(slice.byteLength, 100)
  assert.equal(new Uint8Array(slice)[0], 100)
})

test('deleting a book cascades to assets, progress and annotations', async () => {
  await putBook(book('a'))
  await putBook(book('keep'))
  await putAsset(asset('a', 'epub'))
  await putAsset(asset('a', 'audio', 1))
  await putAsset(asset('keep', 'epub'))
  await putProgress({ bookId: 'a', percent: 0.5, updatedAt: Date.now(), deviceId: 'd' })
  await putAnnotation({
    id: 'ann1',
    bookId: 'a',
    locator: 'epubcfi(/6/4!/4/2)',
    kind: 'highlight',
    color: '#e0b83a',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })

  await deleteBook('a')

  assert.equal(await getBook('a'), undefined)
  assert.equal((await assetSummaries('a')).length, 0)
  assert.equal((await annotationsForBook('a')).length, 0)
  assert.equal((await assetSummaries('keep')).length, 1, 'other books are untouched')
})

test('annotations are filtered by tombstone and ordered by creation', async () => {
  const base = {
    bookId: 'a',
    locator: 'epubcfi(/6/4!/4/2)',
    kind: 'highlight' as const,
    color: '#e0b83a',
    updatedAt: Date.now(),
  }
  await putAnnotation({ ...base, id: '2', createdAt: 2000 })
  await putAnnotation({ ...base, id: '1', createdAt: 1000 })
  await putAnnotation({ ...base, id: '3', createdAt: 3000, deleted: true })

  const rows = await annotationsForBook('a')
  assert.deepEqual(
    rows.map((r) => r.id),
    ['1', '2'],
  )
})

test('download jobs are queryable by state and by parent', async () => {
  const parent: DownloadJob = {
    jobId: 'p1',
    bookId: 'a',
    kind: 'audiobook',
    state: 'queued',
    bytesDone: 0,
    bytesTotal: 300,
    retries: 0,
    createdAt: 1,
    updatedAt: 1,
  }
  await putJob(parent)
  for (let i = 0; i < 3; i++) {
    await putJob({
      ...parent,
      jobId: `c${i}`,
      parentId: 'p1',
      kind: 'audio',
      trackIndex: i,
      state: i === 0 ? 'done' : 'queued',
      bytesDone: i === 0 ? 100 : 0,
      bytesTotal: 100,
    })
  }

  assert.equal((await childJobs('p1')).length, 3)
  assert.equal((await jobsByState('queued')).length, 3, 'parent + two children')

  // The parent job is excluded from the roll-up so its bytes aren't counted twice.
  const progress = bookDownloadProgress(await (await db()).getAll('downloads'), 'a')
  assert.equal(progress.bytesTotal, 300)
  assert.equal(progress.bytesDone, 100)
  assert.equal(progress.state, 'queued')
})

test('the outbox drains oldest first', async () => {
  for (const [id, createdAt] of [
    ['c', 3000],
    ['a', 1000],
    ['b', 2000],
  ] as const) {
    await enqueueOutbox({ id, table: 'progress', op: 'upsert', payload: {}, createdAt, tries: 0 })
  }
  assert.deepEqual(
    (await drainableOutbox()).map((item) => item.id),
    ['a', 'b', 'c'],
  )
})

test('the untyped KV corner stores derived caches', async () => {
  await setKV('readerOutlines', { 'gutenberg:2701': { spine: [{ index: 0 }] } })
  const value = await getKV<{ 'gutenberg:2701': { spine: { index: number }[] } }>('readerOutlines')
  assert.equal(value?.['gutenberg:2701']?.spine[0]?.index, 0)
  assert.equal(await getKV('nothing-here'), undefined)
})
