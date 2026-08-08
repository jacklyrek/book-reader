import type { JSX } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { ensureTracks } from '../catalog/index'
import { getBook, getProgress } from '../core/db'
import { coverUrl } from '../core/library'
import { back, navigate } from '../core/router'
import { settings } from '../core/settings'
import { useStore } from '../core/store'
import type { BookRecord } from '../core/types'
import { buildMapping, describeMapping, spineForTrack } from '../player/handoff'
import {
  cancelSleepTimer,
  extendSleepTimer,
  formatDuration,
  formatTime,
  goToTrack,
  isVolumeSettable,
  loadBook,
  nextTrack,
  playerState,
  previousTrack,
  seekTo,
  setRate,
  setSleepAtEndOfChapter,
  setSleepTimer,
  skip,
  sleepRemainingMs,
  togglePlay,
} from '../player/player'
import { cachedOutline } from '../reader/reader'
import { Cover, ErrorNote, Sheet, Spinner } from './components'

const SPEEDS = [0.75, 1, 1.15, 1.25, 1.5, 1.75, 2]
const SLEEP_MINUTES = [5, 10, 15, 30, 45, 60]

export function PlayerView({ bookId }: { bookId: string }): JSX.Element {
  const state = useStore(playerState)
  const config = useStore(settings)
  const [book, setBook] = useState<BookRecord | null>(null)
  const [cover, setCover] = useState<string | undefined>()
  const [panel, setPanel] = useState<'none' | 'tracks' | 'sleep' | 'speed'>('none')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [, forceTick] = useState(0)

  // Load the book into the shared element if it isn't already the one playing.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const record = await getBook(bookId)
      if (!record || cancelled) return
      setBook(record)
      setCover(await coverUrl(record))

      if (playerState.get().bookId === bookId && playerState.get().tracks.length > 0) return
      if (!record.recording) {
        setLoadError('This book has no linked recording.')
        return
      }

      try {
        const filled = await ensureTracks({
          workId: record.workId ?? record.bookId,
          title: record.title,
          authors: record.authors,
          language: record.language,
          subjects: record.subjects,
          editions: record.edition ? [record.edition] : [],
          recordings: [record.recording],
        })
        const recording = filled.recordings[0]
        if (!recording || recording.tracks.length === 0) {
          setLoadError('Could not load the section list for this recording.')
          return
        }
        const progress = await getProgress(bookId)
        if (cancelled) return
        await loadBook({ ...record, recording }, recording.tracks, {
          trackIndex: progress?.trackIndex ?? 0,
          positionSec: progress?.positionSec ?? 0,
          autoplay: false,
        })
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [bookId])

  // The sleep countdown is derived from an absolute timestamp; re-render it.
  useEffect(() => {
    if (state.sleep.mode !== 'duration') return
    const timer = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [state.sleep.mode])

  const track = state.tracks[state.trackIndex]
  const remaining = sleepRemainingMs()

  const switchToText = async (): Promise<void> => {
    if (!book?.edition) return
    const outline = await cachedOutline(bookId)
    if (!outline || outline.spine.length === 0) {
      // Never opened the text on this device — just open it; the reader will
      // resume from stored progress.
      navigate({ name: 'read', bookId })
      return
    }
    const mapping = buildMapping(outline.spine, state.tracks)
    const spineIndex = spineForTrack(mapping, state.trackIndex)
    const entry = outline.spine[spineIndex]
    sessionStorage.setItem('pdr:handoff', JSON.stringify({ bookId, spineIndex: entry?.index ?? 0 }))
    sessionStorage.setItem('pdr:handoffNote', describeMapping(mapping))
    navigate({ name: 'read', bookId })
  }

  if (loadError) {
    return (
      <div class="player-screen">
        <ErrorNote error={loadError} />
        <button type="button" class="button" onClick={back}>
          Back
        </button>
      </div>
    )
  }

  if (!book || state.tracks.length === 0) return <Spinner label="Loading the recording…" />

  return (
    <div class="player-screen">
      <header class="player-head">
        <button type="button" class="icon-button" onClick={back} aria-label="Back">
          ‹
        </button>
        <span class="player-head-title">{book.title}</span>
        <span class="player-head-spacer" />
      </header>

      <div class="player-art">
        <Cover src={cover} title={book.title} authors={book.authors} size="lg" />
      </div>

      <div class="player-meta">
        <h1 class="player-title">{track?.title ?? book.title}</h1>
        <p class="player-author">{book.authors.join(', ')}</p>
        <p class="player-source">
          {state.offline ? 'Playing from this device' : 'Streaming from archive.org'}
          {track?.reader ? ` · read by ${track.reader}` : ''}
        </p>
      </div>

      {state.error ? <ErrorNote error={state.error} /> : null}

      <div class="player-scrub">
        <input
          type="range"
          min={0}
          max={Math.max(1, Math.floor(state.duration))}
          value={Math.floor(state.currentTime)}
          onChange={(event) => seekTo(Number((event.currentTarget as HTMLInputElement).value))}
          aria-label="Position in section"
        />
        <div class="player-times">
          <span>{formatTime(state.currentTime)}</span>
          <span>−{formatTime(Math.max(0, state.duration - state.currentTime))}</span>
        </div>
        <div class="player-book-progress">
          Section {state.trackIndex + 1} of {state.tracks.length} ·{' '}
          {formatDuration(Math.max(0, state.bookDuration - state.bookTime))} left in the book
        </div>
      </div>

      <div class="player-transport">
        <button type="button" class="icon-button" onClick={() => void previousTrack()} aria-label="Previous section">
          ⏮
        </button>
        <button
          type="button"
          class="icon-button skip"
          onClick={() => skip(-config.skipBackSeconds)}
          aria-label={`Back ${config.skipBackSeconds} seconds`}
        >
          ↺{config.skipBackSeconds}
        </button>
        <button
          type="button"
          class="play-button"
          onClick={() => void togglePlay()}
          aria-label={state.playing ? 'Pause' : 'Play'}
        >
          {state.loading ? '…' : state.playing ? '❚❚' : '▶'}
        </button>
        <button
          type="button"
          class="icon-button skip"
          onClick={() => skip(config.skipForwardSeconds)}
          aria-label={`Forward ${config.skipForwardSeconds} seconds`}
        >
          ↻{config.skipForwardSeconds}
        </button>
        <button type="button" class="icon-button" onClick={() => void nextTrack()} aria-label="Next section">
          ⏭
        </button>
      </div>

      <div class="player-tools">
        <button type="button" class="tool" onClick={() => setPanel('speed')}>
          {state.rate.toFixed(2).replace(/0$/, '')}×
        </button>
        <button type="button" class="tool" onClick={() => setPanel('sleep')}>
          {remaining !== null ? formatTime(remaining / 1000) : state.sleep.mode === 'end-of-chapter' ? 'End of section' : 'Sleep'}
        </button>
        <button type="button" class="tool" onClick={() => setPanel('tracks')}>
          Sections
        </button>
        {book.edition ? (
          <button type="button" class="tool" onClick={() => void switchToText()}>
            Read
          </button>
        ) : null}
      </div>

      <Sheet open={panel === 'speed'} onClose={() => setPanel('none')} title="Playback speed">
        <div class="speed-grid">
          {SPEEDS.map((speed) => (
            <button
              key={speed}
              type="button"
              class={Math.abs(state.rate - speed) < 0.01 ? 'speed speed-active' : 'speed'}
              onClick={() => void setRate(speed)}
            >
              {speed}×
            </button>
          ))}
        </div>
        <p class="note">Pitch is preserved, so the narrator still sounds like themselves.</p>
      </Sheet>

      <Sheet open={panel === 'sleep'} onClose={() => setPanel('none')} title="Sleep timer">
        <div class="speed-grid">
          {SLEEP_MINUTES.map((minutes) => (
            <button
              key={minutes}
              type="button"
              class="speed"
              onClick={() => {
                setSleepTimer(minutes)
                setPanel('none')
              }}
            >
              {minutes} min
            </button>
          ))}
          <button
            type="button"
            class={state.sleep.mode === 'end-of-chapter' ? 'speed speed-active' : 'speed'}
            onClick={() => {
              setSleepAtEndOfChapter()
              setPanel('none')
            }}
          >
            End of section
          </button>
        </div>
        {remaining !== null ? (
          <div class="sheet-actions">
            <button type="button" class="button" onClick={() => extendSleepTimer(10)}>
              +10 minutes
            </button>
            <button type="button" class="button button-quiet" onClick={cancelSleepTimer}>
              Cancel timer
            </button>
          </div>
        ) : null}
        {!isVolumeSettable() ? (
          <p class="note">
            iOS controls playback volume in hardware, so the timer stops the audio rather than fading
            it out.
          </p>
        ) : (
          <p class="note">Audio fades out over the last 20 seconds.</p>
        )}
      </Sheet>

      <Sheet open={panel === 'tracks'} onClose={() => setPanel('none')} title="Sections">
        <ol class="track-picker">
          {state.tracks.map((item) => (
            <li key={item.trackIndex}>
              <button
                type="button"
                class={item.trackIndex === state.trackIndex ? 'active' : undefined}
                onClick={() => {
                  void goToTrack(item.trackIndex)
                  setPanel('none')
                }}
              >
                <span class="track-title">{item.title}</span>
                <span class="track-time">{formatTime(item.seconds)}</span>
              </button>
            </li>
          ))}
        </ol>
      </Sheet>
    </div>
  )
}
