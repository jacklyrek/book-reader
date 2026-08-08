/**
 * Download pipeline (§7.5).
 *
 * Rules that shape this file:
 *   - One active transfer at a time. iOS gets unhappy with several concurrent
 *     large fetches and will kill them all rather than one.
 *   - Stream with a reader so byte progress is real, not a spinner.
 *   - Resume with `Range` after a failure, from bytes already persisted.
 *   - Verify the byte count against `Content-Length` before marking done. A
 *     truncated EPUB that won't open is the worst failure mode, because it
 *     looks downloaded.
 *   - An audiobook is a parent job with one child per track, and it resumes
 *     mid-book.
 */
import {
  allJobs,
  assetId as makeAssetId,
  childJobs,
  deleteJob,
  getJob,
  hasAsset,
  putAsset,
  putJob,
} from './db'
import { uid } from './ids'
import { proxied } from '../catalog/proxy'
import { settings } from './settings'
import { checkQuota, formatBytes } from './storage'
import { createStore } from './store'
import type {
  AudioRecording,
  AudioTrack,
  BookRecord,
  DownloadJob,
  TextEdition,
} from './types'

/** Live view of the queue for the UI. Mirrors the `downloads` store. */
export const downloadQueue = createStore<DownloadJob[]>([])

const MAX_RETRIES = 4
/** Persist job progress at most this often; IDB writes per chunk would thrash. */
const PROGRESS_PERSIST_MS = 1000

let running = false
let cancelled = new Set<string>()
let activeController: AbortController | null = null

// ---------------------------------------------------------------------------
// Queue bookkeeping
// ---------------------------------------------------------------------------

async function refresh(): Promise<void> {
  const jobs = await allJobs()
  downloadQueue.set(jobs.sort((a, b) => a.createdAt - b.createdAt))
}

async function upsert(job: DownloadJob): Promise<void> {
  await putJob(job)
  await refresh()
}

function newJob(partial: Omit<DownloadJob, 'jobId' | 'createdAt' | 'updatedAt' | 'retries'>): DownloadJob {
  const now = Date.now()
  return { jobId: uid('job'), retries: 0, createdAt: now, updatedAt: now, ...partial }
}

export async function loadQueue(): Promise<void> {
  // Anything left 'running' died with the last page. Put it back in the queue.
  const jobs = await allJobs()
  for (const job of jobs) {
    if (job.state === 'running') {
      await putJob({ ...job, state: 'queued', updatedAt: Date.now() })
    }
  }
  await refresh()
}

// ---------------------------------------------------------------------------
// Enqueueing
// ---------------------------------------------------------------------------

export interface QueueResult {
  jobIds: string[]
  /** Set when the caller should confirm with the user before we start. */
  warning?: string
  blocked?: boolean
}

export async function queueEpub(book: BookRecord, edition: TextEdition): Promise<QueueResult> {
  const assetId = makeAssetId(book.bookId, 'epub')
  if (await hasAsset(assetId)) return { jobIds: [] }

  const bytes = edition.bytes ?? 0
  const quota = await checkQuota(bytes)
  if (!quota.ok) return { jobIds: [], warning: quota.message, blocked: true }

  const job = newJob({
    bookId: book.bookId,
    kind: 'epub',
    assetId,
    url: edition.epubUrl,
    state: 'queued',
    bytesDone: 0,
    bytesTotal: bytes,
  })
  await upsert(job)
  return { jobIds: [job.jobId], warning: quota.warn ? quota.message : undefined }
}

export async function queueCover(book: BookRecord, coverUrl: string): Promise<void> {
  const assetId = makeAssetId(book.bookId, 'cover')
  if (await hasAsset(assetId)) return
  await upsert(
    newJob({
      bookId: book.bookId,
      kind: 'cover',
      assetId,
      url: coverUrl,
      state: 'queued',
      bytesDone: 0,
      bytesTotal: 0,
    }),
  )
}

/**
 * LibriVox publishes 64kbps and 128kbps builds of most recordings. 64 is fine
 * for spoken word and halves the storage bill; the user picks at download time.
 */
export function trackUrlForBitrate(track: AudioTrack, kbps: number): string {
  return track.url.replace(/_(\d+)kb\.mp3$/i, `_${kbps}kb.mp3`)
}

/** MP3 size from duration and bitrate — LibriVox rarely reports byte counts. */
export function estimateAudioBytes(recording: AudioRecording, kbps: number): number {
  const seconds =
    recording.totalSeconds || recording.tracks.reduce((sum, t) => sum + t.seconds, 0)
  return Math.round((seconds * kbps * 1000) / 8)
}

export async function queueAudiobook(
  book: BookRecord,
  recording: AudioRecording,
  kbps = settings.get().audioBitrate,
): Promise<QueueResult> {
  if (recording.tracks.length === 0) {
    throw new Error('Track list not loaded — call ensureTracks() first')
  }

  const estimated = estimateAudioBytes(recording, kbps)
  const quota = await checkQuota(estimated)
  if (!quota.ok) return { jobIds: [], warning: quota.message, blocked: true }

  const { largeDownloadWarnMb, cellularWarn } = settings.get()
  let warning = quota.warn ? quota.message : undefined
  if (cellularWarn && estimated > largeDownloadWarnMb * 1024 * 1024) {
    // navigator.connection is unavailable on iOS Safari, so we cannot detect
    // cellular — this is a manual setting rather than a smart check (§7.5).
    warning = `This is about ${formatBytes(estimated)}. Start it on Wi-Fi?`
  }

  const parent = newJob({
    bookId: book.bookId,
    kind: 'audiobook',
    state: 'queued',
    bytesDone: 0,
    bytesTotal: estimated,
  })
  await putJob(parent)

  const jobIds = [parent.jobId]
  for (const track of recording.tracks) {
    const assetId = makeAssetId(book.bookId, 'audio', track.trackIndex)
    if (await hasAsset(assetId)) continue
    const child = newJob({
      bookId: book.bookId,
      parentId: parent.jobId,
      kind: 'audio',
      assetId,
      trackIndex: track.trackIndex,
      url: trackUrlForBitrate(track, kbps),
      state: 'queued',
      bytesDone: 0,
      bytesTotal: track.bytes ?? Math.round((track.seconds * kbps * 1000) / 8),
    })
    await putJob(child)
    jobIds.push(child.jobId)
  }

  await refresh()
  return { jobIds, warning }
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export async function pauseAll(): Promise<void> {
  activeController?.abort()
  for (const job of await allJobs()) {
    if (job.state === 'queued' || job.state === 'running') {
      await putJob({ ...job, state: 'paused', updatedAt: Date.now() })
    }
  }
  await refresh()
}

export async function resumeAll(): Promise<void> {
  for (const job of await allJobs()) {
    if (job.state === 'paused' || job.state === 'error') {
      await putJob({ ...job, state: 'queued', retries: 0, error: undefined, updatedAt: Date.now() })
    }
  }
  await refresh()
  void runQueue()
}

export async function cancelJob(jobId: string): Promise<void> {
  cancelled.add(jobId)
  const job = await getJob(jobId)
  if (!job) return
  if (job.kind === 'audiobook') {
    for (const child of await childJobs(jobId)) await cancelJob(child.jobId)
  }
  activeController?.abort()
  await deleteJob(jobId)
  await refresh()
}

export async function cancelBook(bookId: string): Promise<void> {
  for (const job of await allJobs()) {
    if (job.bookId === bookId) await cancelJob(job.jobId)
  }
}

export async function clearFinishedJobs(): Promise<void> {
  for (const job of await allJobs()) {
    if (job.state === 'done' || job.state === 'cancelled') await deleteJob(job.jobId)
  }
  await refresh()
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

export async function runQueue(): Promise<void> {
  if (running) return
  running = true
  try {
    for (;;) {
      const jobs = await allJobs()
      const next = jobs
        .filter((j) => j.state === 'queued' && j.kind !== 'audiobook')
        .sort((a, b) => a.createdAt - b.createdAt)[0]
      if (!next) break
      await runJob(next)
      await rollUpParents()
    }
    await rollUpParents()
  } finally {
    running = false
  }
}

async function rollUpParents(): Promise<void> {
  const jobs = await allJobs()
  for (const parent of jobs.filter((j) => j.kind === 'audiobook')) {
    const children = jobs.filter((j) => j.parentId === parent.jobId)
    if (children.length === 0) {
      // Every track already present, or all cancelled.
      await putJob({ ...parent, state: 'done', bytesDone: parent.bytesTotal, updatedAt: Date.now() })
      continue
    }
    const bytesDone = children.reduce((sum, c) => sum + c.bytesDone, 0)
    const bytesTotal = children.reduce((sum, c) => sum + Math.max(c.bytesTotal, c.bytesDone), 0)
    const state: DownloadJob['state'] = children.every((c) => c.state === 'done')
      ? 'done'
      : children.some((c) => c.state === 'running')
        ? 'running'
        : children.some((c) => c.state === 'error')
          ? 'error'
          : children.every((c) => c.state === 'paused')
            ? 'paused'
            : 'queued'
    await putJob({ ...parent, bytesDone, bytesTotal, state, updatedAt: Date.now() })
  }
  await refresh()
}

async function runJob(job: DownloadJob): Promise<void> {
  if (!job.url || !job.assetId) {
    await upsert({ ...job, state: 'error', error: 'Job has no URL', updatedAt: Date.now() })
    return
  }

  await upsert({ ...job, state: 'running', error: undefined, updatedAt: Date.now() })

  try {
    const { blob, mime, etag } = await downloadWithResume(job)
    await putAsset({
      assetId: job.assetId,
      bookId: job.bookId,
      kind: job.kind === 'audiobook' ? 'audio' : job.kind,
      trackIndex: job.trackIndex,
      blob,
      bytes: blob.size,
      mime,
      etag,
      sourceUrl: job.url,
      createdAt: Date.now(),
    })
    await upsert({
      ...job,
      state: 'done',
      bytesDone: blob.size,
      bytesTotal: blob.size,
      partial: undefined,
      updatedAt: Date.now(),
    })
  } catch (error) {
    if (cancelled.has(job.jobId)) {
      cancelled.delete(job.jobId)
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    const retries = job.retries + 1
    const current = (await getJob(job.jobId)) ?? job

    // A pause aborts the in-flight fetch, which lands here. Re-queueing it
    // would immediately un-pause the download.
    if (current.state === 'paused' || current.state === 'cancelled') {
      await refresh()
      return
    }

    if (retries <= MAX_RETRIES) {
      // Keep whatever bytes we got; the retry resumes from there.
      await upsert({
        ...current,
        state: 'queued',
        retries,
        error: message,
        updatedAt: Date.now(),
      })
      await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 2 ** retries * 500)))
    } else {
      await upsert({ ...current, state: 'error', retries, error: message, updatedAt: Date.now() })
    }
  }
}

interface DownloadResult {
  blob: Blob
  mime: string
  etag?: string
}

async function downloadWithResume(job: DownloadJob): Promise<DownloadResult> {
  const existing = job.partial
  const offset = existing?.size ?? 0

  const controller = new AbortController()
  activeController = controller

  const url = await proxied(job.url as string)
  const headers = new Headers()
  if (offset > 0) headers.set('Range', `bytes=${offset}-`)

  const response = await fetch(url, { headers, signal: controller.signal })

  // A server that ignores our Range gives us the whole body again; start over
  // rather than concatenating a duplicate prefix.
  const resuming = offset > 0 && response.status === 206
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`)
  }
  if (offset > 0 && !resuming) {
    await upsert({ ...job, partial: undefined, bytesDone: 0, updatedAt: Date.now() })
  }

  const contentLength = Number(response.headers.get('content-length')) || 0
  const expectedTotal = resuming ? offset + contentLength : contentLength
  const mime = response.headers.get('content-type')?.split(';')[0]?.trim() ?? guessMime(job)
  const etag = response.headers.get('etag') ?? undefined

  if (!response.body) {
    // No streaming support: fall back to a single buffered read.
    const blob = await response.blob()
    verifyLength(blob.size, expectedTotal)
    return { blob, mime, etag }
  }

  const chunks: BlobPart[] = resuming && existing ? [existing] : []
  let received = resuming ? offset : 0
  let lastPersist = 0

  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (cancelled.has(job.jobId)) throw new Error('cancelled')
      chunks.push(value as BlobPart)
      received += value.byteLength

      const now = Date.now()
      if (now - lastPersist > PROGRESS_PERSIST_MS) {
        lastPersist = now
        const current = (await getJob(job.jobId)) ?? job
        if (current.state === 'paused') throw new Error('paused')
        await upsert({
          ...current,
          bytesDone: received,
          bytesTotal: Math.max(expectedTotal, received),
          updatedAt: now,
        })
      }
    }
  } catch (error) {
    // Persist the partial so the retry can resume instead of restarting.
    if (chunks.length > 0 && !cancelled.has(job.jobId)) {
      const partial = new Blob(chunks, { type: mime })
      const current = (await getJob(job.jobId)) ?? job
      await upsert({ ...current, partial, bytesDone: partial.size, updatedAt: Date.now() })
    }
    throw error
  } finally {
    activeController = null
    reader.releaseLock()
  }

  const blob = new Blob(chunks, { type: mime })
  verifyLength(blob.size, expectedTotal)
  return { blob, mime, etag }
}

/**
 * A silently truncated file is worse than a failed download, because it looks
 * like it worked. Only trust the check when the server told us a length.
 */
function verifyLength(actual: number, expected: number): void {
  if (expected > 0 && actual !== expected) {
    throw new Error(`Truncated: got ${actual} bytes, expected ${expected}`)
  }
  if (actual === 0) throw new Error('Empty response')
}

function guessMime(job: DownloadJob): string {
  if (job.kind === 'epub') return 'application/epub+zip'
  if (job.kind === 'audio') return 'audio/mpeg'
  return 'application/octet-stream'
}

// ---------------------------------------------------------------------------
// Queries used by the UI
// ---------------------------------------------------------------------------

export function jobsForBook(jobs: DownloadJob[], bookId: string): DownloadJob[] {
  return jobs.filter((j) => j.bookId === bookId)
}

export function bookDownloadProgress(
  jobs: DownloadJob[],
  bookId: string,
): { state: DownloadJob['state'] | 'none'; fraction: number; bytesDone: number; bytesTotal: number } {
  const relevant = jobs.filter((j) => j.bookId === bookId && j.kind !== 'audiobook')
  if (relevant.length === 0) return { state: 'none', fraction: 0, bytesDone: 0, bytesTotal: 0 }
  const bytesDone = relevant.reduce((sum, j) => sum + j.bytesDone, 0)
  const bytesTotal = relevant.reduce((sum, j) => sum + Math.max(j.bytesTotal, j.bytesDone), 0)
  const state = relevant.every((j) => j.state === 'done')
    ? 'done'
    : relevant.some((j) => j.state === 'running')
      ? 'running'
      : relevant.some((j) => j.state === 'error')
        ? 'error'
        : relevant.some((j) => j.state === 'queued')
          ? 'queued'
          : 'paused'
  return {
    state,
    fraction: bytesTotal > 0 ? Math.min(1, bytesDone / bytesTotal) : 0,
    bytesDone,
    bytesTotal,
  }
}
