/**
 * Audiobook player (§7.3). Most of the fiddly iOS work lives here.
 *
 * Three rules the design calls out, all of them learned the hard way:
 *
 *  1. Exactly one `<audio>` element, created at boot, never replaced. Creating
 *     a new element while backgrounded loses the audio session and playback
 *     dies silently. Track changes set `.src` on the same element.
 *  2. Offline audio is served from the service worker at `/media/{assetId}`,
 *     never from a `blob:` URL — blob URLs pin the file in memory and seek
 *     badly.
 *  3. The sleep timer is an absolute timestamp checked inside `timeupdate`.
 *     `setTimeout` gets throttled when backgrounded and overshoots by minutes.
 */
import { assetId as makeAssetId, getBook, hasAsset, putBook } from '../core/db'
import { settings } from '../core/settings'
import { createStore } from '../core/store'
import { recordAudioProgress } from '../core/progress'
import type { AudioTrack, BookRecord } from '../core/types'

export type SleepMode = 'off' | 'duration' | 'end-of-chapter' | 'end-of-book'

export interface SleepState {
  mode: SleepMode
  /** Absolute wall-clock ms. Compared against Date.now() on every timeupdate. */
  endsAt?: number
  fading: boolean
}

export interface PlayerState {
  bookId?: string
  title: string
  author: string
  coverUrl?: string
  tracks: AudioTrack[]
  trackIndex: number
  playing: boolean
  /** Position within the current track. */
  currentTime: number
  duration: number
  /** Position across the whole book, in seconds. */
  bookTime: number
  bookDuration: number
  rate: number
  sleep: SleepState
  loading: boolean
  offline: boolean
  error?: string
}

const EMPTY: PlayerState = {
  title: '',
  author: '',
  tracks: [],
  trackIndex: 0,
  playing: false,
  currentTime: 0,
  duration: 0,
  bookTime: 0,
  bookDuration: 0,
  rate: 1,
  sleep: { mode: 'off', fading: false },
  loading: false,
  offline: false,
}

export const playerState = createStore<PlayerState>(EMPTY)

const FADE_SECONDS = 20
const POSITION_STATE_MS = 1000
const PROGRESS_SAVE_MS = 5000

let audio: HTMLAudioElement | null = null
/** iOS makes HTMLMediaElement.volume read-only; detected once at boot. */
let volumeIsSettable = true
let lastPositionState = 0
let lastProgressSave = 0
let fadeFrom = 1

/**
 * Must stay inside the service worker's scope, which is the deploy base — `/`
 * at an origin root, `/<repo>/` on a GitHub project site. A URL outside that
 * scope is never intercepted, and offline audio silently 404s.
 */
export function mediaUrl(assetId: string): string {
  return `${import.meta.env.BASE_URL}media/${encodeURIComponent(assetId)}`
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/** Called once from main.tsx. The element outlives every book. */
export function initPlayer(): HTMLAudioElement {
  if (audio) return audio

  const element = document.createElement('audio')
  element.preload = 'metadata'
  element.setAttribute('playsinline', '')
  // Keeps the element in the DOM so Safari never garbage-collects the session.
  element.style.display = 'none'
  document.body.append(element)
  audio = element

  // Probe once, while silent, whether we can control volume at all.
  element.volume = 0.5
  volumeIsSettable = Math.abs(element.volume - 0.5) < 0.01
  element.volume = 1

  element.addEventListener('timeupdate', onTimeUpdate)
  element.addEventListener('ended', onEnded)
  element.addEventListener('loadedmetadata', onLoadedMetadata)
  element.addEventListener('play', () => patch({ playing: true, error: undefined }))
  element.addEventListener('pause', () => {
    patch({ playing: false })
    void saveProgress(true)
  })
  element.addEventListener('waiting', () => patch({ loading: true }))
  element.addEventListener('playing', () => patch({ loading: false }))
  element.addEventListener('error', () => {
    const code = element.error?.code
    patch({
      loading: false,
      error:
        code === MediaError.MEDIA_ERR_NETWORK
          ? 'Network error — this track is not downloaded and you appear to be offline.'
          : `Playback failed (${element.error?.message || 'unknown error'})`,
    })
  })

  window.addEventListener('pagehide', () => void saveProgress(true))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void saveProgress(true)
  })

  setUpMediaSession()
  return element
}

function el(): HTMLAudioElement {
  return audio ?? initPlayer()
}

function patch(partial: Partial<PlayerState>): void {
  playerState.set((prev) => ({ ...prev, ...partial }))
}

// ---------------------------------------------------------------------------
// Loading a book
// ---------------------------------------------------------------------------

export interface LoadOptions {
  trackIndex?: number
  positionSec?: number
  autoplay?: boolean
}

export async function loadBook(
  book: BookRecord,
  tracks: AudioTrack[],
  options: LoadOptions = {},
): Promise<void> {
  const element = el()
  const ordered = [...tracks].sort((a, b) => a.trackIndex - b.trackIndex)
  const bookDuration = ordered.reduce((sum, t) => sum + t.seconds, 0)

  patch({
    bookId: book.bookId,
    title: book.title,
    author: book.authors[0] ?? '',
    coverUrl: book.coverKey,
    tracks: ordered,
    trackIndex: options.trackIndex ?? 0,
    bookDuration,
    rate: book.playbackRate ?? 1,
    error: undefined,
  })

  element.playbackRate = book.playbackRate ?? 1
  setPreservesPitch(element, true)

  await selectTrack(options.trackIndex ?? 0, options.positionSec ?? 0, options.autoplay ?? false)
  updateMediaMetadata()
}

async function sourceForTrack(bookId: string, track: AudioTrack): Promise<{ src: string; offline: boolean }> {
  const id = makeAssetId(bookId, 'audio', track.trackIndex)
  if (await hasAsset(id)) return { src: mediaUrl(id), offline: true }
  // Streaming: archive.org sends CORS headers, so this needs no proxy.
  return { src: track.url, offline: false }
}

async function selectTrack(index: number, positionSec: number, autoplay: boolean): Promise<void> {
  const state = playerState.get()
  const track = state.tracks[index]
  if (!state.bookId || !track) return

  const element = el()
  const { src, offline } = await sourceForTrack(state.bookId, track)

  // Setting `.src` on the existing element is the whole point — never create a
  // new one (§7.3).
  if (element.src !== new URL(src, location.href).href) {
    element.src = src
    element.load()
  }

  patch({ trackIndex: index, offline, currentTime: positionSec, loading: true })

  const seek = () => {
    if (positionSec > 0 && Number.isFinite(element.duration)) {
      element.currentTime = Math.min(positionSec, element.duration - 0.5)
    } else if (positionSec > 0) {
      element.currentTime = positionSec
    }
  }

  if (element.readyState >= 1) seek()
  else element.addEventListener('loadedmetadata', seek, { once: true })

  if (autoplay) await play()
  updateMediaMetadata()
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export async function play(): Promise<void> {
  try {
    await el().play()
  } catch (error) {
    // Autoplay policy: the first play of a session must come from a gesture.
    patch({
      error:
        (error as Error)?.name === 'NotAllowedError'
          ? 'Tap play to start — iOS requires a tap before the first sound.'
          : String(error),
    })
  }
}

export function pause(): void {
  el().pause()
}

export async function togglePlay(): Promise<void> {
  if (playerState.get().playing) pause()
  else await play()
}

export function seekTo(seconds: number): void {
  const element = el()
  const max = Number.isFinite(element.duration) ? element.duration : seconds
  element.currentTime = Math.max(0, Math.min(seconds, max))
  patch({ currentTime: element.currentTime })
  publishPositionState(true)
}

/**
 * Skip by seconds rather than by track. A 12-hour book has 40-minute sections;
 * "next track" is not what you want when you miss a sentence (§7.3).
 */
export function skip(seconds: number): void {
  const element = el()
  const target = element.currentTime + seconds

  if (target < 0) {
    const state = playerState.get()
    if (state.trackIndex > 0) {
      const previous = state.tracks[state.trackIndex - 1]
      const into = previous ? Math.max(0, previous.seconds + target) : 0
      void selectTrack(state.trackIndex - 1, into, state.playing)
      return
    }
    seekTo(0)
    return
  }

  if (Number.isFinite(element.duration) && target > element.duration) {
    const overshoot = target - element.duration
    void nextTrack(overshoot)
    return
  }

  seekTo(target)
}

export async function nextTrack(into = 0): Promise<void> {
  const state = playerState.get()
  if (state.trackIndex >= state.tracks.length - 1) {
    pause()
    return
  }
  await selectTrack(state.trackIndex + 1, into, state.playing)
}

export async function previousTrack(): Promise<void> {
  const state = playerState.get()
  // Same convention as every other player: restart the track first.
  if (el().currentTime > 3 || state.trackIndex === 0) {
    seekTo(0)
    return
  }
  await selectTrack(state.trackIndex - 1, 0, state.playing)
}

export async function goToTrack(index: number, positionSec = 0): Promise<void> {
  const state = playerState.get()
  if (index < 0 || index >= state.tracks.length) return
  await selectTrack(index, positionSec, state.playing)
}

/** Up to 2.0, with pitch preserved so the narrator doesn't turn into a chipmunk. */
export async function setRate(rate: number): Promise<void> {
  const clamped = Math.max(0.5, Math.min(2, rate))
  const element = el()
  element.playbackRate = clamped
  setPreservesPitch(element, true)
  patch({ rate: clamped })

  const { bookId } = playerState.get()
  if (!bookId) return
  const book = await getBook(bookId)
  if (book) await putBook({ ...book, playbackRate: clamped, updatedAt: Date.now() })
}

function setPreservesPitch(element: HTMLAudioElement, value: boolean): void {
  const target = element as HTMLAudioElement & {
    preservesPitch?: boolean
    webkitPreservesPitch?: boolean
  }
  if ('preservesPitch' in target) target.preservesPitch = value
  if ('webkitPreservesPitch' in target) target.webkitPreservesPitch = value
}

// ---------------------------------------------------------------------------
// Sleep timer (§7.3)
// ---------------------------------------------------------------------------

export function setSleepTimer(minutes: number): void {
  patch({
    sleep: { mode: 'duration', endsAt: Date.now() + minutes * 60_000, fading: false },
  })
  fadeFrom = el().volume
}

export function setSleepAtEndOfChapter(): void {
  patch({ sleep: { mode: 'end-of-chapter', fading: false } })
}

export function setSleepAtEndOfBook(): void {
  patch({ sleep: { mode: 'end-of-book', fading: false } })
}

export function cancelSleepTimer(): void {
  const element = el()
  if (volumeIsSettable) element.volume = 1
  patch({ sleep: { mode: 'off', fading: false } })
}

/** Extra minutes without restarting — the "I'm still awake" button. */
export function extendSleepTimer(minutes: number): void {
  const { sleep } = playerState.get()
  const base = sleep.endsAt && sleep.endsAt > Date.now() ? sleep.endsAt : Date.now()
  const element = el()
  if (volumeIsSettable) element.volume = 1
  patch({ sleep: { mode: 'duration', endsAt: base + minutes * 60_000, fading: false } })
}

/**
 * Runs inside `timeupdate`, which keeps firing during background playback —
 * unlike `setTimeout`, which iOS throttles to the point of overshooting by
 * minutes.
 */
function tickSleepTimer(): void {
  const { sleep } = playerState.get()
  if (sleep.mode !== 'duration' || !sleep.endsAt) return

  const remainingMs = sleep.endsAt - Date.now()
  const element = el()

  if (remainingMs <= 0) {
    element.pause()
    if (volumeIsSettable) element.volume = 1
    patch({ sleep: { mode: 'off', fading: false } })
    return
  }

  if (remainingMs <= FADE_SECONDS * 1000) {
    if (!sleep.fading) {
      fadeFrom = volumeIsSettable ? element.volume : 1
      patch({ sleep: { ...sleep, fading: true } })
    }
    // iOS ignores writes to `volume` (it is hardware-controlled), so the fade
    // is a no-op there and the timer simply pauses. Everywhere else it ramps.
    if (volumeIsSettable) {
      element.volume = Math.max(0, fadeFrom * (remainingMs / (FADE_SECONDS * 1000)))
    }
  }
}

export function sleepRemainingMs(): number | null {
  const { sleep } = playerState.get()
  if (sleep.mode !== 'duration' || !sleep.endsAt) return null
  return Math.max(0, sleep.endsAt - Date.now())
}

// ---------------------------------------------------------------------------
// Element events
// ---------------------------------------------------------------------------

function onLoadedMetadata(): void {
  const element = el()
  const state = playerState.get()
  const track = state.tracks[state.trackIndex]
  patch({
    // LibriVox's reported playtime is close but not exact; trust the file.
    duration: Number.isFinite(element.duration) ? element.duration : (track?.seconds ?? 0),
    loading: false,
  })
  publishPositionState(true)
}

function onTimeUpdate(): void {
  const element = el()
  const state = playerState.get()
  const elapsedBefore = state.tracks
    .slice(0, state.trackIndex)
    .reduce((sum, t) => sum + t.seconds, 0)

  patch({
    currentTime: element.currentTime,
    bookTime: elapsedBefore + element.currentTime,
  })

  tickSleepTimer()
  publishPositionState(false)

  const now = Date.now()
  if (now - lastProgressSave > PROGRESS_SAVE_MS) {
    lastProgressSave = now
    void saveProgress(false)
  }
}

async function onEnded(): Promise<void> {
  const state = playerState.get()

  if (state.sleep.mode === 'end-of-chapter') {
    patch({ sleep: { mode: 'off', fading: false } })
    await saveProgress(true)
    return
  }

  if (state.trackIndex >= state.tracks.length - 1) {
    if (state.sleep.mode === 'end-of-book') patch({ sleep: { mode: 'off', fading: false } })
    await saveProgress(true)
    return
  }

  // Advancing by setting `.src` on the same element, inside the ended handler,
  // is what keeps background playback alive across track boundaries.
  await selectTrack(state.trackIndex + 1, 0, true)
}

async function saveProgress(force: boolean): Promise<void> {
  const state = playerState.get()
  if (!state.bookId) return
  if (!force && !state.playing) return
  await recordAudioProgress(state.bookId, {
    trackIndex: state.trackIndex,
    positionSec: state.currentTime,
    audioPercent: state.bookDuration > 0 ? state.bookTime / state.bookDuration : 0,
  })
}

// ---------------------------------------------------------------------------
// Media Session (§7.3)
// ---------------------------------------------------------------------------

function setUpMediaSession(): void {
  if (!('mediaSession' in navigator)) return
  const session = navigator.mediaSession

  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    ['play', () => void play()],
    ['pause', () => pause()],
    ['seekbackward', () => skip(-settings.get().skipBackSeconds)],
    ['seekforward', () => skip(settings.get().skipForwardSeconds)],
    ['previoustrack', () => void previousTrack()],
    ['nexttrack', () => void nextTrack()],
    [
      'seekto',
      (details) => {
        if (typeof details.seekTime === 'number') seekTo(details.seekTime)
      },
    ],
    ['stop', () => pause()],
  ]

  for (const [action, handler] of handlers) {
    try {
      session.setActionHandler(action, handler)
    } catch {
      // Not every action is supported on every iOS version; skip quietly.
    }
  }
}

function updateMediaMetadata(): void {
  if (!('mediaSession' in navigator)) return
  const state = playerState.get()
  const track = state.tracks[state.trackIndex]
  const artwork: MediaImage[] = state.coverUrl
    ? [
        { src: state.coverUrl, sizes: '512x512', type: 'image/jpeg' },
        { src: state.coverUrl, sizes: '256x256', type: 'image/jpeg' },
      ]
    : []

  navigator.mediaSession.metadata = new MediaMetadata({
    title: track?.title ?? state.title,
    artist: state.author,
    album: state.title,
    artwork,
  })
}

/**
 * `setPositionState` drives the lock-screen scrubber. Throttled to ~1/sec —
 * calling it on every `timeupdate` makes the scrubber stutter, and its
 * behaviour varies across iOS versions, so every call is guarded.
 */
function publishPositionState(force: boolean): void {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return
  const now = Date.now()
  if (!force && now - lastPositionState < POSITION_STATE_MS) return
  lastPositionState = now

  const element = el()
  const duration = element.duration
  if (!Number.isFinite(duration) || duration <= 0) return

  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate: element.playbackRate || 1,
      position: Math.min(element.currentTime, duration),
    })
    navigator.mediaSession.playbackState = element.paused ? 'paused' : 'playing'
  } catch {
    // Safari throws if position > duration during a seek. Non-fatal.
  }
}

// ---------------------------------------------------------------------------
// Helpers for the UI
// ---------------------------------------------------------------------------

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.round((seconds % 3600) / 60)
  if (hours === 0) return `${minutes} min`
  return `${hours} hr ${minutes} min`
}

export function isVolumeSettable(): boolean {
  return volumeIsSettable
}
