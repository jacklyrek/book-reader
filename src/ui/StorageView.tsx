import type { JSX } from 'preact'
import { useState } from 'preact/hooks'
import { libraryVersion } from '../core/library'
import { hrefFor } from '../core/router'
import {
  evictAudio,
  evictBookAssets,
  evictText,
  formatBytes,
  nukeEverything,
  QUOTA_WARN_FRACTION,
  requestPersistence,
  runAutoEviction,
  storageReport,
} from '../core/storage'
import { useAsync, useStore } from '../core/store'
import { Empty, ProgressBar, Spinner, Toast } from './components'

/**
 * The storage dashboard (§7.1). Quota is the binding constraint on this app, so
 * this is a real screen: per-book bytes, sorted, with a way to free space
 * without losing your place or your notes.
 */
export function StorageView(): JSX.Element {
  const version = useStore(libraryVersion)
  const [nonce, setNonce] = useState(0)
  const [toast, setToast] = useState<string | null>(null)
  const { data, loading } = useAsync(storageReport, [version, nonce])

  if (loading && !data) return <Spinner label="Measuring…" />
  if (!data) return <Empty title="Storage unavailable" />

  const fraction = data.quota > 0 ? data.usage / data.quota : 0
  const free = Math.max(0, data.quota - data.usage)

  const act = async (fn: () => Promise<number>, label: string) => {
    const freed = await fn()
    setToast(`${label}: freed ${formatBytes(freed)}`)
    setNonce((n) => n + 1)
  }

  return (
    <div class="storage">
      <section class="storage-summary">
        <ProgressBar value={fraction} label="Storage used" />
        <div class="storage-numbers">
          <span>
            <strong>{formatBytes(data.usage)}</strong> used
          </span>
          <span>{formatBytes(free)} free</span>
        </div>
        {fraction >= QUOTA_WARN_FRACTION ? (
          <p class="warn-note">
            Above {Math.round(QUOTA_WARN_FRACTION * 100)}% — new downloads will warn before starting.
          </p>
        ) : null}
        <p class="note">
          {data.persisted
            ? 'Storage is marked persistent, so Safari will not evict it to reclaim space.'
            : 'Storage is not marked persistent yet.'}
        </p>
        {!data.persisted ? (
          <button
            type="button"
            class="button button-small"
            onClick={() =>
              void requestPersistence().then((granted) => {
                setToast(granted ? 'Persistent storage granted.' : 'Safari declined for now.')
                setNonce((n) => n + 1)
              })
            }
          >
            Request persistent storage
          </button>
        ) : null}
      </section>

      <section class="storage-section">
        <h2 class="section-head">By book</h2>
        {data.perBook.length === 0 ? (
          <p class="note">Nothing downloaded yet.</p>
        ) : (
          <ul class="storage-list">
            {data.perBook.map((entry) => (
              <li key={entry.bookId}>
                <div class="storage-row">
                  <a class="storage-title" href={hrefFor({ name: 'book', workId: entry.bookId })}>
                    {entry.title}
                  </a>
                  <span class="storage-bytes">{formatBytes(entry.bytes)}</span>
                </div>
                <div class="storage-breakdown">
                  {entry.audioBytes > 0 ? <span>audio {formatBytes(entry.audioBytes)}</span> : null}
                  {entry.textBytes > 0 ? <span>text {formatBytes(entry.textBytes)}</span> : null}
                </div>
                <div class="storage-actions">
                  {entry.audioBytes > 0 ? (
                    <button
                      type="button"
                      class="link-button"
                      onClick={() => void act(() => evictAudio(entry.bookId), 'Audio removed')}
                    >
                      Delete audio
                    </button>
                  ) : null}
                  {entry.textBytes > 0 ? (
                    <button
                      type="button"
                      class="link-button"
                      onClick={() => void act(() => evictText(entry.bookId), 'Text removed')}
                    >
                      Delete text
                    </button>
                  ) : null}
                  <button
                    type="button"
                    class="link-button link-danger"
                    onClick={() => void act(() => evictBookAssets(entry.bookId), 'Files removed')}
                  >
                    Delete all files
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p class="note">Deleting files keeps the book on your shelf, along with progress and notes.</p>
      </section>

      <section class="storage-section">
        <h2 class="section-head">Housekeeping</h2>
        <button
          type="button"
          class="button button-small"
          onClick={() =>
            void runAutoEviction().then(({ bookIds, freed }) => {
              setToast(
                bookIds.length
                  ? `Cleared audio for ${bookIds.length} finished book(s), freeing ${formatBytes(freed)}.`
                  : 'Nothing to clear.',
              )
              setNonce((n) => n + 1)
            })
          }
        >
          Run auto-eviction now
        </button>
        <button
          type="button"
          class="button button-small button-danger"
          onClick={() => {
            if (confirm('Delete the entire local database — books, downloads, notes and progress?')) {
              void nukeEverything()
            }
          }}
        >
          Erase all local data
        </button>
      </section>

      <Toast message={toast} onDismiss={() => setToast(null)} />
    </div>
  )
}
