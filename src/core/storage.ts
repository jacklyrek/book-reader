/**
 * Storage management (§7.1). Quota is the binding constraint on this app — a
 * single LibriVox recording is 100–400 MB — so this is a first-class subsystem,
 * not a settings page.
 */
import { allBooks, assetSummaries, db, deleteAsset, getBook, putBook } from './db'
import { settings } from './settings'
import type { StorageReport } from './types'

/** Warn the user above this fraction of quota before starting a download. */
export const QUOTA_WARN_FRACTION = 0.8

export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  if (await navigator.storage.persisted?.()) return true
  try {
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

export async function estimate(): Promise<{ usage: number; quota: number }> {
  if (!navigator.storage?.estimate) return { usage: 0, quota: 0 }
  const { usage = 0, quota = 0 } = await navigator.storage.estimate()
  return { usage, quota }
}

export async function storageReport(): Promise<StorageReport> {
  const [{ usage, quota }, books, assets] = await Promise.all([
    estimate(),
    allBooks(),
    assetSummaries(),
  ])

  const byBook = new Map<string, { bytes: number; audioBytes: number; textBytes: number }>()
  let totalAssetBytes = 0
  for (const a of assets) {
    const entry = byBook.get(a.bookId) ?? { bytes: 0, audioBytes: 0, textBytes: 0 }
    entry.bytes += a.bytes
    if (a.kind === 'audio') entry.audioBytes += a.bytes
    else entry.textBytes += a.bytes
    byBook.set(a.bookId, entry)
    totalAssetBytes += a.bytes
  }

  const titles = new Map(books.map((b) => [b.bookId, b.title]))
  const perBook = [...byBook.entries()]
    .map(([bookId, v]) => ({
      bookId,
      title: titles.get(bookId) ?? '(removed book)',
      ...v,
    }))
    .sort((a, b) => b.bytes - a.bytes)

  return {
    usage,
    quota,
    persisted: (await navigator.storage?.persisted?.()) ?? false,
    perBook,
    totalAssetBytes,
  }
}

export interface QuotaCheck {
  ok: boolean
  /** True when the download would push usage past the warn threshold. */
  warn: boolean
  usage: number
  quota: number
  projectedFraction: number
  message?: string
}

/** Called before every download (§7.1). */
export async function checkQuota(incomingBytes: number): Promise<QuotaCheck> {
  const { usage, quota } = await estimate()
  if (!quota) {
    // Safari has been known to report 0. Don't block on an unknown.
    return { ok: true, warn: false, usage, quota, projectedFraction: 0 }
  }
  const projectedFraction = (usage + incomingBytes) / quota
  if (projectedFraction >= 1) {
    return {
      ok: false,
      warn: true,
      usage,
      quota,
      projectedFraction,
      message: `Not enough space: this needs ${formatBytes(incomingBytes)} but only ${formatBytes(
        Math.max(0, quota - usage),
      )} is free.`,
    }
  }
  if (projectedFraction >= QUOTA_WARN_FRACTION) {
    return {
      ok: true,
      warn: true,
      usage,
      quota,
      projectedFraction,
      message: `This will put you at ${Math.round(projectedFraction * 100)}% of available storage.`,
    }
  }
  return { ok: true, warn: false, usage, quota, projectedFraction }
}

/** Delete only the audio for a book, keeping the text, progress and notes. */
export async function evictAudio(bookId: string): Promise<number> {
  const assets = await assetSummaries(bookId)
  let freed = 0
  for (const a of assets) {
    if (a.kind !== 'audio') continue
    await deleteAsset(a.assetId)
    freed += a.bytes
  }
  return freed
}

export async function evictText(bookId: string): Promise<number> {
  const assets = await assetSummaries(bookId)
  let freed = 0
  for (const a of assets) {
    if (a.kind !== 'epub') continue
    await deleteAsset(a.assetId)
    freed += a.bytes
  }
  return freed
}

/** Drop every downloaded byte for a book; the library row and notes survive. */
export async function evictBookAssets(bookId: string): Promise<number> {
  const assets = await assetSummaries(bookId)
  let freed = 0
  for (const a of assets) {
    await deleteAsset(a.assetId)
    freed += a.bytes
  }
  return freed
}

/**
 * Optional auto-eviction (§7.1): delete audio for books finished more than N
 * days ago. Progress and annotations are deliberately kept.
 */
export async function runAutoEviction(): Promise<{ bookIds: string[]; freed: number }> {
  const days = settings.get().autoEvictFinishedDays
  if (!days) return { bookIds: [], freed: 0 }
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const books = await allBooks()
  const evicted: string[] = []
  let freed = 0
  for (const book of books) {
    if (!book.finishedAt || book.finishedAt > cutoff) continue
    const bytes = await evictAudio(book.bookId)
    if (bytes > 0) {
      evicted.push(book.bookId)
      freed += bytes
    }
  }
  return { bookIds: evicted, freed }
}

export async function markFinished(bookId: string, finished: boolean): Promise<void> {
  const book = await getBook(bookId)
  if (!book) return
  await putBook({
    ...book,
    finishedAt: finished ? Date.now() : undefined,
    updatedAt: Date.now(),
  })
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const mb = bytes / 1024 / 1024
  if (mb < 1) return `${Math.round(bytes / 1024)} KB`
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

/** Rough total for a whole IndexedDB reset — used by the danger-zone button. */
export async function nukeEverything(): Promise<void> {
  const database = await db()
  database.close()
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('pdr')
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    req.onblocked = () => resolve()
  })
  location.reload()
}
