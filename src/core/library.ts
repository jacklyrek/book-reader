/**
 * Turning a catalog result into a library item, and getting the bytes back out
 * again for the reader and the player.
 */
import { ensureTracks } from '../catalog/index'
import { fetchSource } from '../catalog/proxy'
import {
  allBooks,
  assetId as makeAssetId,
  deleteBook as dropBook,
  enqueueOutbox,
  getAsset,
  getBook,
  putBook,
} from './db'
import { queueAudiobook, queueCover, queueEpub, runQueue } from './downloads'
import { uid } from './ids'
import { settings } from './settings'
import { createStore } from './store'
import type { AudioRecording, BookRecord, CatalogWork, TextEdition } from './types'

/** Bumped whenever the library changes, so views re-read. */
export const libraryVersion = createStore(0)

function touch(): void {
  libraryVersion.set((n) => n + 1)
}

export function bookFromWork(
  work: CatalogWork,
  edition?: TextEdition,
  recording?: AudioRecording,
): BookRecord {
  const now = Date.now()
  return {
    bookId: work.workId,
    workId: work.workId,
    title: work.title,
    authors: work.authors,
    language: work.language,
    subjects: work.subjects,
    description: work.description,
    coverKey: work.coverUrl,
    edition: edition ?? work.editions[0],
    recording: recording ?? work.recordings[0],
    addedAt: now,
    updatedAt: now,
  }
}

async function record(book: BookRecord): Promise<void> {
  await putBook(book)
  await enqueueOutbox({
    id: uid('out'),
    table: 'library_items',
    op: book.deleted ? 'delete' : 'upsert',
    payload: book as unknown as Record<string, unknown>,
    createdAt: Date.now(),
    tries: 0,
  })
  touch()
}

export async function addToLibrary(
  work: CatalogWork,
  options: { edition?: TextEdition; recording?: AudioRecording } = {},
): Promise<BookRecord> {
  const existing = await getBook(work.workId)
  const book = existing
    ? { ...existing, ...bookFromWork(work, options.edition, options.recording), addedAt: existing.addedAt }
    : bookFromWork(work, options.edition, options.recording)
  await record(book)
  if (book.coverKey) {
    await queueCover(book, book.coverKey)
    void runQueue()
  }
  return book
}

export async function removeFromLibrary(bookId: string): Promise<void> {
  const book = await getBook(bookId)
  if (book) {
    // Tombstone for sync, then drop the local rows and bytes.
    await enqueueOutbox({
      id: uid('out'),
      table: 'library_items',
      op: 'delete',
      payload: { ...book, deleted: true, updatedAt: Date.now() } as unknown as Record<string, unknown>,
      createdAt: Date.now(),
      tries: 0,
    })
  }
  await dropBook(bookId)
  touch()
}

export async function listLibrary(): Promise<BookRecord[]> {
  return allBooks()
}

// ---------------------------------------------------------------------------
// Downloads, from the library's point of view
// ---------------------------------------------------------------------------

export async function downloadText(bookId: string): Promise<string | undefined> {
  const book = await getBook(bookId)
  if (!book?.edition) throw new Error('No text edition for this book')
  const result = await queueEpub(book, book.edition)
  if (!result.blocked) void runQueue()
  return result.warning
}

export async function downloadAudio(
  bookId: string,
  kbps = settings.get().audioBitrate,
): Promise<string | undefined> {
  const book = await getBook(bookId)
  if (!book?.recording) throw new Error('No recording for this book')

  let recording = book.recording
  if (recording.tracks.length === 0) {
    const filled = await ensureTracks({
      workId: book.workId ?? book.bookId,
      title: book.title,
      authors: book.authors,
      language: book.language,
      subjects: book.subjects,
      editions: book.edition ? [book.edition] : [],
      recordings: [recording],
    })
    recording = filled.recordings[0] ?? recording
    await record({ ...book, recording, audioBitrate: kbps, updatedAt: Date.now() })
  }

  const result = await queueAudiobook({ ...book, recording }, recording, kbps)
  if (!result.blocked) void runQueue()
  return result.warning
}

// ---------------------------------------------------------------------------
// Reading the bytes back
// ---------------------------------------------------------------------------

/**
 * The EPUB for a book, from IndexedDB if downloaded, otherwise fetched into
 * memory so "read now" works without committing to a download first.
 */
export async function loadEpub(bookId: string, signal?: AbortSignal): Promise<Blob> {
  const stored = await getAsset(makeAssetId(bookId, 'epub'))
  if (stored) return stored.blob

  const book = await getBook(bookId)
  if (!book?.edition) throw new Error('No text edition for this book')

  const response = await fetchSource(book.edition.epubUrl, { signal, timeoutMs: 120_000 })
  if (!response.ok) throw new Error(`Could not fetch EPUB: HTTP ${response.status}`)
  return response.blob()
}

/** Local cover if downloaded, remote URL otherwise, undefined if neither. */
export async function coverUrl(book: BookRecord): Promise<string | undefined> {
  const stored = await getAsset(makeAssetId(book.bookId, 'cover'))
  if (stored) return URL.createObjectURL(stored.blob)
  return book.coverKey
}

export async function setFinished(bookId: string, finished: boolean): Promise<void> {
  const book = await getBook(bookId)
  if (!book) return
  await record({ ...book, finishedAt: finished ? Date.now() : undefined, updatedAt: Date.now() })
}
