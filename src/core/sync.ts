/**
 * Cross-device sync (§6.3).
 *
 * One user, two devices — so last-write-wins on `updated_at`, no CRDTs. The one
 * refinement is that near-simultaneous *progress* writes resolve to the
 * furthest position instead of the latest, so a stale tab syncing late can't
 * rewind you (see mergeProgress).
 *
 * Local writes never block on the network: they land in IndexedDB and an
 * `outbox` row, which drains whenever we're online.
 */
import {
  allAnnotations,
  allBooks,
  deleteOutbox,
  drainableOutbox,
  getBook,
  getProgress,
  putAnnotation,
  putBook,
  putProgress,
  outboxSize,
} from './db'
import { libraryVersion } from './library'
import { mergeProgress, progressVersion } from './progress'
import { annotationVersion } from '../reader/annotations'
import { settings, updateSetting } from './settings'
import { createStore } from './store'
import { authState, supabase } from './supabase-client'
import type { AnnotationRecord, BookRecord, ProgressRecord } from './types'

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'error' | 'disabled'

export interface SyncState {
  status: SyncStatus
  pending: number
  lastSyncAt?: number
  error?: string
}

export const syncState = createStore<SyncState>({ status: 'disabled', pending: 0 })

const SYNC_INTERVAL_MS = 60_000
const MAX_OUTBOX_TRIES = 8

let timer: number | undefined
let inFlight = false

// ---------------------------------------------------------------------------
// Row mapping. camelCase on the client, snake_case in Postgres.
// ---------------------------------------------------------------------------

interface ProgressRow {
  user_id: string
  book_id: string
  locator: string | null
  percent: number
  label: string | null
  track_index: number | null
  position_sec: number | null
  audio_percent: number | null
  updated_at: string
  device_id: string
}

interface AnnotationRow {
  id: string
  user_id: string
  book_id: string
  locator: string
  kind: string
  color: string
  text: string | null
  note: string | null
  chapter: string | null
  created_at: string
  updated_at: string
  deleted: boolean
}

interface LibraryRow {
  user_id: string
  book_id: string
  work_id: string | null
  title: string
  authors: string[]
  language: string
  subjects: string[]
  description: string | null
  edition: unknown
  recording: unknown
  audio_bitrate: number | null
  playback_rate: number | null
  finished_at: string | null
  added_at: string
  updated_at: string
  deleted: boolean
}

const ms = (iso: string | null): number => (iso ? new Date(iso).getTime() : 0)
const iso = (millis: number): string => new Date(millis).toISOString()

function progressToRow(p: ProgressRecord, userId: string): ProgressRow {
  return {
    user_id: userId,
    book_id: p.bookId,
    locator: p.locator ?? null,
    percent: p.percent ?? 0,
    label: p.label ?? null,
    track_index: p.trackIndex ?? null,
    position_sec: p.positionSec ?? null,
    audio_percent: p.audioPercent ?? null,
    updated_at: iso(p.updatedAt),
    device_id: p.deviceId,
  }
}

function rowToProgress(row: ProgressRow): ProgressRecord {
  return {
    bookId: row.book_id,
    locator: row.locator ?? undefined,
    percent: row.percent ?? 0,
    label: row.label ?? undefined,
    trackIndex: row.track_index ?? undefined,
    positionSec: row.position_sec ?? undefined,
    audioPercent: row.audio_percent ?? undefined,
    updatedAt: ms(row.updated_at),
    deviceId: row.device_id,
  }
}

function annotationToRow(a: AnnotationRecord, userId: string): AnnotationRow {
  return {
    id: a.id,
    user_id: userId,
    book_id: a.bookId,
    locator: a.locator,
    kind: a.kind,
    color: a.color,
    text: a.text ?? null,
    note: a.note ?? null,
    chapter: a.chapter ?? null,
    created_at: iso(a.createdAt),
    updated_at: iso(a.updatedAt),
    deleted: a.deleted ?? false,
  }
}

function rowToAnnotation(row: AnnotationRow): AnnotationRecord {
  return {
    id: row.id,
    bookId: row.book_id,
    locator: row.locator,
    kind: row.kind as AnnotationRecord['kind'],
    color: row.color,
    text: row.text ?? undefined,
    note: row.note ?? undefined,
    chapter: row.chapter ?? undefined,
    createdAt: ms(row.created_at),
    updatedAt: ms(row.updated_at),
    deleted: row.deleted,
  }
}

function bookToRow(b: BookRecord, userId: string): LibraryRow {
  return {
    user_id: userId,
    book_id: b.bookId,
    work_id: b.workId ?? null,
    title: b.title,
    authors: b.authors,
    language: b.language,
    subjects: b.subjects,
    description: b.description ?? null,
    edition: b.edition ?? null,
    recording: b.recording ? { ...b.recording, tracks: [] } : null,
    audio_bitrate: b.audioBitrate ?? null,
    playback_rate: b.playbackRate ?? null,
    finished_at: b.finishedAt ? iso(b.finishedAt) : null,
    added_at: iso(b.addedAt),
    updated_at: iso(b.updatedAt),
    deleted: b.deleted ?? false,
  }
}

function rowToBook(row: LibraryRow): BookRecord {
  return {
    bookId: row.book_id,
    workId: row.work_id ?? undefined,
    title: row.title,
    authors: row.authors ?? [],
    language: row.language,
    subjects: row.subjects ?? [],
    description: row.description ?? undefined,
    edition: (row.edition as BookRecord['edition']) ?? undefined,
    recording: (row.recording as BookRecord['recording']) ?? undefined,
    audioBitrate: row.audio_bitrate ?? undefined,
    playbackRate: row.playback_rate ?? undefined,
    finishedAt: row.finished_at ? ms(row.finished_at) : undefined,
    addedAt: ms(row.added_at),
    updatedAt: ms(row.updated_at),
    deleted: row.deleted,
  }
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

async function push(userId: string): Promise<void> {
  const sb = supabase()
  if (!sb) return

  const items = await drainableOutbox()
  for (const item of items) {
    try {
      if (item.table === 'progress') {
        const record = item.payload as unknown as ProgressRecord
        const { error } = await sb.from('progress').upsert(progressToRow(record, userId), {
          onConflict: 'user_id,book_id',
        })
        if (error) throw new Error(error.message)
      } else if (item.table === 'annotations') {
        const record = item.payload as unknown as AnnotationRecord
        const { error } = await sb.from('annotations').upsert(annotationToRow(record, userId))
        if (error) throw new Error(error.message)
      } else {
        const record = item.payload as unknown as BookRecord
        const { error } = await sb.from('library_items').upsert(bookToRow(record, userId), {
          onConflict: 'user_id,book_id',
        })
        if (error) throw new Error(error.message)
      }
      await deleteOutbox(item.id)
    } catch (error) {
      const tries = item.tries + 1
      if (tries >= MAX_OUTBOX_TRIES) {
        // Drop it rather than wedging the queue forever behind one bad row.
        console.error('[sync] dropping outbox item after repeated failures', item, error)
        await deleteOutbox(item.id)
        continue
      }
      // Stop on the first failure: order matters and the network is probably down.
      throw error
    }
  }
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

async function pull(userId: string, since: number): Promise<void> {
  const sb = supabase()
  if (!sb) return
  const sinceIso = iso(since)

  const [progressResult, annotationResult, libraryResult] = await Promise.all([
    sb.from('progress').select('*').eq('user_id', userId).gt('updated_at', sinceIso),
    sb.from('annotations').select('*').eq('user_id', userId).gt('updated_at', sinceIso),
    sb.from('library_items').select('*').eq('user_id', userId).gt('updated_at', sinceIso),
  ])

  for (const result of [progressResult, annotationResult, libraryResult]) {
    if (result.error) throw new Error(result.error.message)
  }

  // These write straight to IndexedDB via `./db`, bypassing the `record`/
  // `write`/`persist` wrappers that local edits go through — so, unlike a
  // local edit, a pulled row doesn't bump the version store an open view
  // reads from. Do that here, once per table, only if something changed:
  // open Library/Shelves/Highlights views are otherwise none the wiser that
  // new rows landed until the next full remount.
  let libraryChanged = false
  let progressChanged = false
  let annotationsChanged = false

  for (const row of (libraryResult.data ?? []) as LibraryRow[]) {
    const remote = rowToBook(row)
    const local = await getBook(remote.bookId)
    if (!local || remote.updatedAt > local.updatedAt) {
      // Never let a stale remote row clobber tracks we've already resolved.
      await putBook({ ...local, ...remote, recording: remote.recording ?? local?.recording })
      libraryChanged = true
    }
  }

  for (const row of (progressResult.data ?? []) as ProgressRow[]) {
    const remote = rowToProgress(row)
    const local = await getProgress(remote.bookId)
    const merged = mergeProgress(local, remote)
    if (merged && (!local || merged.updatedAt !== local.updatedAt || merged !== local)) {
      await putProgress(merged)
      progressChanged = true
    }
  }

  for (const row of (annotationResult.data ?? []) as AnnotationRow[]) {
    const remote = rowToAnnotation(row)
    await putAnnotation(remote)
    annotationsChanged = true
  }

  if (libraryChanged) libraryVersion.set((n) => n + 1)
  if (progressChanged) progressVersion.set((n) => n + 1)
  if (annotationsChanged) annotationVersion.set((n) => n + 1)
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

export async function syncNow(): Promise<void> {
  const auth = authState.get()
  if (auth.status !== 'signed-in') {
    syncState.set({ status: auth.status === 'unconfigured' ? 'disabled' : 'idle', pending: await outboxSize() })
    return
  }
  if (inFlight) return
  if (!navigator.onLine) {
    syncState.set((prev) => ({ ...prev, status: 'offline' }))
    return
  }

  inFlight = true
  syncState.set((prev) => ({ ...prev, status: 'syncing', error: undefined }))
  try {
    await push(auth.userId)
    const since = settings.get().lastSyncAt ?? 0
    await pull(auth.userId, since)
    const now = Date.now()
    await updateSetting('lastSyncAt', now)
    syncState.set({ status: 'idle', pending: await outboxSize(), lastSyncAt: now })
  } catch (error) {
    syncState.set({
      status: navigator.onLine ? 'error' : 'offline',
      pending: await outboxSize(),
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    inFlight = false
  }
}

export function startSync(): void {
  if (authState.get().status === 'unconfigured') {
    syncState.set({ status: 'disabled', pending: 0 })
    return
  }

  void syncNow()
  timer = window.setInterval(() => void syncNow(), SYNC_INTERVAL_MS)
  window.addEventListener('online', () => void syncNow())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncNow()
  })
  authState.subscribe((state) => {
    if (state.status === 'signed-in') void syncNow()
  })
}

export function stopSync(): void {
  if (timer !== undefined) window.clearInterval(timer)
  timer = undefined
}

/**
 * A fresh sign-in on a new device has `lastSyncAt = 0`, so the first pull
 * fetches everything. This also pushes the whole local library up, which is
 * what you want when the *first* device signs in and the server is empty.
 */
export async function fullResync(): Promise<void> {
  const auth = authState.get()
  if (auth.status !== 'signed-in') return
  const sb = supabase()
  if (!sb) return

  const [books, annotations] = await Promise.all([allBooks(), allAnnotations()])
  if (books.length > 0) {
    const { error } = await sb
      .from('library_items')
      .upsert(books.map((b) => bookToRow(b, auth.userId)), { onConflict: 'user_id,book_id' })
    if (error) throw new Error(error.message)
  }
  if (annotations.length > 0) {
    const { error } = await sb
      .from('annotations')
      .upsert(annotations.map((a) => annotationToRow(a, auth.userId)))
    if (error) throw new Error(error.message)
  }

  await updateSetting('lastSyncAt', 0)
  await syncNow()
}
