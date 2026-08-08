import type { JSX } from 'preact'
import { useState } from 'preact/hooks'
import { catalog, ensureTracks } from '../catalog/index'
import { getBook, getProgress } from '../core/db'
import { bookDownloadProgress, downloadQueue, estimateAudioBytes } from '../core/downloads'
import {
  addToLibrary,
  downloadAudio,
  downloadText,
  libraryVersion,
  removeFromLibrary,
} from '../core/library'
import { overallPercent } from '../core/progress'
import { hrefFor, navigate } from '../core/router'
import { settings } from '../core/settings'
import { evictBookAssets, formatBytes } from '../core/storage'
import { useAsync, useStore } from '../core/store'
import type { CatalogWork } from '../core/types'
import { formatDuration } from '../player/player'
import { Badge, Cover, Empty, ErrorNote, ProgressBar, SegmentedControl, Spinner, Toast } from './components'

interface DetailData {
  work: CatalogWork | null
  inLibrary: boolean
  percent: number
}

export function BookDetail({ workId }: { workId: string }): JSX.Element {
  const version = useStore(libraryVersion)
  const jobs = useStore(downloadQueue)
  const config = useStore(settings)
  const [bitrate, setBitrate] = useState(config.audioBitrate)
  const [toast, setToast] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const { data, error, loading, reload } = useAsync<DetailData>(async () => {
    const [local, progress] = await Promise.all([getBook(workId), getProgress(workId)])

    // A book already on the shelf renders from local state, so the detail page
    // works offline.
    if (local) {
      return {
        work: {
          workId: local.workId ?? local.bookId,
          title: local.title,
          authors: local.authors,
          language: local.language,
          subjects: local.subjects,
          coverUrl: local.coverKey,
          description: local.description,
          editions: local.edition ? [local.edition] : [],
          recordings: local.recording ? [local.recording] : [],
        },
        inLibrary: true,
        percent: overallPercent(progress),
      }
    }

    const work = await catalog.getWork(workId)
    return { work, inLibrary: false, percent: 0 }
  }, [workId, version])

  if (loading && !data) return <Spinner label="Loading…" />
  if (error) return <ErrorNote error={error} />
  if (!data?.work) return <Empty title="Not found" body="That book isn't in the catalog." />

  const { work, inLibrary, percent } = data
  const edition = work.editions[0]
  const recording = work.recordings[0]
  const download = bookDownloadProgress(jobs, work.workId)
  const estimatedAudio = recording ? estimateAudioBytes(recording, bitrate) : 0

  const run = async (fn: () => Promise<string | undefined | void>) => {
    setBusy(true)
    try {
      const warning = await fn()
      if (typeof warning === 'string') setToast(warning)
    } catch (cause) {
      setToast(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
      reload()
    }
  }

  return (
    <div class="detail">
      <div class="detail-head">
        <Cover src={work.coverUrl} title={work.title} authors={work.authors} size="lg" />
        <div class="detail-head-text">
          <h1 class="detail-title">{work.title}</h1>
          <p class="detail-author">{work.authors.join(', ') || 'Unknown author'}</p>
          <div class="badges">
            {edition ? (
              <Badge tone="text">
                {edition.source === 'standard-ebooks' ? 'Standard Ebooks' : 'Project Gutenberg'}
              </Badge>
            ) : null}
            {recording ? <Badge tone="audio">{formatDuration(recording.totalSeconds)}</Badge> : null}
            {work.matchConfidence !== undefined && work.matchConfidence < 0.85 ? (
              <Badge tone="warn">audio match uncertain</Badge>
            ) : null}
          </div>
          {percent > 0 ? (
            <div class="detail-progress">
              <ProgressBar value={percent} label="Progress" />
              <span>{Math.round(percent * 100)}%</span>
            </div>
          ) : null}
        </div>
      </div>

      <div class="detail-actions">
        {edition ? (
          <a class="button button-primary" href={hrefFor({ name: 'read', bookId: work.workId })}>
            Read
          </a>
        ) : null}
        {recording ? (
          <a class="button" href={hrefFor({ name: 'listen', bookId: work.workId })}>
            Listen
          </a>
        ) : null}
        {!inLibrary ? (
          <button
            type="button"
            class="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const filled = recording ? await ensureTracks(work) : work
                await addToLibrary(filled)
              })
            }
          >
            Add to library
          </button>
        ) : null}
      </div>

      {work.description ? (
        <section class="detail-section">
          <h2 class="section-head">About</h2>
          <p class="detail-description">{work.description}</p>
        </section>
      ) : null}

      {inLibrary ? (
        <section class="detail-section">
          <h2 class="section-head">Offline</h2>

          {edition ? (
            <div class="offline-row">
              <div>
                <div class="offline-title">Text</div>
                <div class="offline-sub">
                  {edition.bytes ? formatBytes(edition.bytes) : 'size unknown'} ·{' '}
                  {edition.source === 'standard-ebooks' ? 'Standard Ebooks' : 'Gutenberg'}
                </div>
              </div>
              <button
                type="button"
                class="button button-small"
                disabled={busy}
                onClick={() => void run(() => downloadText(work.workId))}
              >
                Download
              </button>
            </div>
          ) : null}

          {recording ? (
            <div class="offline-block">
              <div class="offline-row">
                <div>
                  <div class="offline-title">Audio</div>
                  <div class="offline-sub">
                    {recording.trackCount} sections · about {formatBytes(estimatedAudio)}
                    {recording.readers.length ? ` · read by ${recording.readers.join(', ')}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  class="button button-small"
                  disabled={busy}
                  onClick={() => void run(() => downloadAudio(work.workId, bitrate))}
                >
                  Download
                </button>
              </div>
              {recording.bitrates && recording.bitrates.length > 1 ? (
                <SegmentedControl<string>
                  label="Audio quality"
                  value={String(bitrate)}
                  onChange={(value) => setBitrate(Number(value))}
                  options={recording.bitrates.map((rate) => ({
                    value: String(rate),
                    label: `${rate} kbps · ${formatBytes(estimateAudioBytes(recording, rate))}`,
                  }))}
                />
              ) : null}
            </div>
          ) : null}

          {download.state !== 'none' && download.state !== 'done' ? (
            <div class="offline-progress">
              <ProgressBar value={download.fraction} label="Download progress" />
              <span>
                {formatBytes(download.bytesDone)} of {formatBytes(download.bytesTotal)}
              </span>
            </div>
          ) : null}

          {download.state === 'done' ? (
            <button
              type="button"
              class="button button-small button-quiet"
              onClick={() =>
                void run(async () => {
                  const freed = await evictBookAssets(work.workId)
                  return `Freed ${formatBytes(freed)}. Progress and notes kept.`
                })
              }
            >
              Remove downloaded files
            </button>
          ) : null}
        </section>
      ) : null}

      {recording && recording.tracks.length > 0 ? (
        <section class="detail-section">
          <h2 class="section-head">Sections</h2>
          <ol class="track-list">
            {recording.tracks.slice(0, 60).map((track) => (
              <li key={track.trackIndex}>
                <span class="track-title">{track.title}</span>
                <span class="track-time">{formatDuration(track.seconds)}</span>
              </li>
            ))}
          </ol>
          {recording.tracks.length > 60 ? (
            <p class="note">…and {recording.tracks.length - 60} more.</p>
          ) : null}
        </section>
      ) : null}

      {work.subjects.length > 0 ? (
        <section class="detail-section">
          <h2 class="section-head">Subjects</h2>
          <div class="badges">
            {work.subjects.map((subject) => (
              <Badge key={subject}>{subject}</Badge>
            ))}
          </div>
        </section>
      ) : null}

      {inLibrary ? (
        <section class="detail-section">
          <a class="button button-quiet" href={hrefFor({ name: 'annotations', bookId: work.workId })}>
            Highlights &amp; notes
          </a>
          <button
            type="button"
            class="button button-danger"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await removeFromLibrary(work.workId)
                navigate({ name: 'library' })
              })
            }
          >
            Remove from library
          </button>
        </section>
      ) : null}

      <Toast message={toast} onDismiss={() => setToast(null)} />
    </div>
  )
}
