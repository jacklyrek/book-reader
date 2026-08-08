/**
 * Domain model. Client stores are §7.1; catalog rows are §6.2.
 *
 * Locators are EPUB CFI strings everywhere (§7.2). Audio positions are
 * (trackIndex, positionSec). A book may have both.
 */

export type SourceId =
  | 'standard-ebooks'
  | 'gutenberg'
  | 'librivox'
  | 'archive'
  | 'openlibrary'

/** Ranking used everywhere we have to choose between editions (§6.2). */
export const SOURCE_RANK: Record<SourceId, number> = {
  'standard-ebooks': 0,
  gutenberg: 1,
  archive: 2,
  librivox: 3,
  openlibrary: 4,
}

// ---------------------------------------------------------------------------
// Catalog (what search returns; mirrors the Supabase tables in §6.2)
// ---------------------------------------------------------------------------

export interface TextEdition {
  editionId: string
  source: SourceId
  /** Direct EPUB URL at the source. Fetched through the proxy when needed. */
  epubUrl: string
  /** Bytes, when the source tells us. Used for download warnings. */
  bytes?: number
  language: string
  /** Standard Ebooks / Gutenberg landing page, for attribution. */
  pageUrl?: string
  translator?: string
}

export interface AudioTrack {
  trackIndex: number
  title: string
  url: string
  seconds: number
  bytes?: number
  reader?: string
}

export interface AudioRecording {
  recordingId: string
  source: SourceId
  /** LibriVox project page. */
  pageUrl?: string
  totalSeconds: number
  readers: string[]
  /** Populated lazily — the catalog row only stores the section count. */
  tracks: AudioTrack[]
  trackCount: number
  /** LibriVox usually offers 64kbps and 128kbps (§7.1). */
  bitrates?: number[]
}

export interface CatalogWork {
  workId: string
  title: string
  authors: string[]
  language: string
  subjects: string[]
  coverUrl?: string
  year?: number
  editions: TextEdition[]
  recordings: AudioRecording[]
  /** 0–1 from the text↔audio fuzzy match (§6.2). Below ~0.8, show a warning. */
  matchConfidence?: number
  description?: string
}

// ---------------------------------------------------------------------------
// Library (IndexedDB, §7.1)
// ---------------------------------------------------------------------------

export type AssetKind = 'epub' | 'audio' | 'cover'

export interface BookRecord {
  bookId: string
  workId?: string
  title: string
  authors: string[]
  language: string
  subjects: string[]
  addedAt: number
  coverKey?: string
  description?: string
  /** The specific edition/recording the user chose to add. */
  edition?: TextEdition
  recording?: AudioRecording
  /** Chosen at download time (§7.1). */
  audioBitrate?: number
  /** Persisted per book, as the design specifies for playback speed (§7.3). */
  playbackRate?: number
  /** Set when the user marks it read, drives auto-eviction (§7.1). */
  finishedAt?: number
  updatedAt: number
  deleted?: boolean
}

export interface AssetRecord {
  assetId: string
  bookId: string
  kind: AssetKind
  trackIndex?: number
  blob: Blob
  bytes: number
  mime: string
  etag?: string
  sourceUrl?: string
  createdAt: number
}

export interface ProgressRecord {
  bookId: string
  /** EPUB CFI. */
  locator?: string
  /** 0–1 through the text. */
  percent: number
  /** Chapter label at the time of writing, for "Continue reading" cards. */
  label?: string
  trackIndex?: number
  positionSec?: number
  /** 0–1 through the audio, across all tracks. */
  audioPercent?: number
  updatedAt: number
  deviceId: string
}

export type AnnotationKind = 'highlight' | 'note' | 'bookmark'

export interface AnnotationRecord {
  id: string
  bookId: string
  /** EPUB CFI — shared locator format with the commonplace book (§10). */
  locator: string
  kind: AnnotationKind
  color: string
  /** The highlighted text itself, so exports stand alone. */
  text?: string
  note?: string
  /** TOC label, captured at creation. */
  chapter?: string
  createdAt: number
  updatedAt: number
  deleted?: boolean
}

export type DownloadState =
  | 'queued'
  | 'running'
  | 'paused'
  | 'done'
  | 'error'
  | 'cancelled'

export interface DownloadJob {
  jobId: string
  bookId: string
  /** Parent jobs group an audiobook's per-track children (§7.5). */
  parentId?: string
  kind: AssetKind | 'audiobook'
  assetId?: string
  url?: string
  trackIndex?: number
  state: DownloadState
  bytesDone: number
  bytesTotal: number
  retries: number
  error?: string
  /**
   * Bytes already fetched, persisted so a retry can resume with `Range`
   * instead of starting a 300 MB audiobook over (§7.5).
   */
  partial?: Blob
  createdAt: number
  updatedAt: number
}

export type OutboxTable = 'progress' | 'annotations' | 'library_items'

export interface OutboxItem {
  id: string
  table: OutboxTable
  op: 'upsert' | 'delete'
  /** Row keyed for last-write-wins conflict resolution (§6.3). */
  payload: Record<string, unknown>
  createdAt: number
  tries: number
  lastError?: string
}

export interface Collection {
  id: string
  name: string
  description?: string
  bookIds: string[]
  /** Curated shelves (e.g. the Great Books canon, §10) are seeded, not created. */
  curated?: boolean
  /** For curated shelves: entries not yet in the library. */
  wanted?: { title: string; author: string; workId?: string }[]
  updatedAt: number
}

export type ReaderTheme = 'paper' | 'sepia' | 'night' | 'black'

export interface Settings {
  deviceId: string
  theme: ReaderTheme
  fontSize: number
  fontFamily: string
  lineHeight: number
  /** Page inset in px, on top of the safe-area inset. */
  margin: number
  justify: boolean
  hyphenate: boolean
  /** 'paginated' | 'scrolled' */
  flow: 'paginated' | 'scrolled'
  audioBitrate: number
  skipBackSeconds: number
  skipForwardSeconds: number
  /** navigator.connection is unavailable on iOS Safari, so this is manual (§7.5). */
  cellularWarn: boolean
  largeDownloadWarnMb: number
  autoEvictFinishedDays: number | null
  narratorBlocklist: string[]
  lastSyncAt?: number
}

export interface StorageReport {
  usage: number
  quota: number
  persisted: boolean
  perBook: { bookId: string; title: string; bytes: number; audioBytes: number; textBytes: number }[]
  totalAssetBytes: number
}
