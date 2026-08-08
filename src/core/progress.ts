/**
 * Reading and listening position (§6.3, §7.1).
 *
 * Every write goes to IndexedDB first and to the outbox second, so the UI never
 * waits on the network.
 */
import { enqueueOutbox, getProgress, putProgress } from './db'
import { uid } from './ids'
import { deviceId } from './settings'
import { createStore } from './store'
import type { ProgressRecord } from './types'

/**
 * Two positions written within this window are treated as concurrent, and the
 * furthest one wins rather than the most recent. Stops a stale tab that syncs
 * late from rewinding you (§6.3).
 */
export const PROGRESS_TIE_WINDOW_MS = 5 * 60 * 1000

/** Bumped on every local write so open views can re-read. */
export const progressVersion = createStore(0)

async function write(bookId: string, patch: Partial<ProgressRecord>): Promise<ProgressRecord> {
  const existing = await getProgress(bookId)
  const record: ProgressRecord = {
    bookId,
    percent: 0,
    ...existing,
    ...patch,
    updatedAt: Date.now(),
    deviceId: await deviceId(),
  }
  await putProgress(record)
  await enqueueOutbox({
    id: uid('out'),
    table: 'progress',
    op: 'upsert',
    payload: record as unknown as Record<string, unknown>,
    createdAt: Date.now(),
    tries: 0,
  })
  progressVersion.set((n) => n + 1)
  return record
}

export async function recordTextProgress(
  bookId: string,
  patch: { locator?: string; percent: number; label?: string },
): Promise<ProgressRecord> {
  return write(bookId, patch)
}

export async function recordAudioProgress(
  bookId: string,
  patch: { trackIndex: number; positionSec: number; audioPercent?: number },
): Promise<ProgressRecord> {
  return write(bookId, patch)
}

/** How far through a book the reader is, taking the better of text and audio. */
export function overallPercent(progress: ProgressRecord | undefined): number {
  if (!progress) return 0
  return Math.max(progress.percent ?? 0, progress.audioPercent ?? 0)
}

/**
 * Last-write-wins, except that near-simultaneous writes resolve to the furthest
 * position (§6.3). Pure so it can be tested and reused by the sync loop.
 */
export function mergeProgress(
  local: ProgressRecord | undefined,
  remote: ProgressRecord | undefined,
): ProgressRecord | undefined {
  if (!local) return remote
  if (!remote) return local
  if (local.deviceId === remote.deviceId && local.updatedAt === remote.updatedAt) return local

  const concurrent = Math.abs(local.updatedAt - remote.updatedAt) <= PROGRESS_TIE_WINDOW_MS
  if (concurrent) {
    const winner = overallPercent(remote) > overallPercent(local) ? remote : local
    // Keep the later timestamp so the merged row wins against both parents.
    return { ...winner, updatedAt: Math.max(local.updatedAt, remote.updatedAt) }
  }
  return remote.updatedAt > local.updatedAt ? remote : local
}
