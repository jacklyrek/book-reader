import type { JSX } from 'preact'
import { useCallback } from 'preact/hooks'
import { allProgress } from '../core/db'
import { bookDownloadProgress, downloadQueue } from '../core/downloads'
import { coverUrl, libraryVersion, listLibrary } from '../core/library'
import { overallPercent, progressVersion } from '../core/progress'
import { hrefFor, navigate } from '../core/router'
import { useAsync, useStore } from '../core/store'
import type { BookRecord, ProgressRecord } from '../core/types'
import { Cover, Empty, ProgressBar, Spinner } from './components'

interface Shelf {
  books: BookRecord[]
  progress: Map<string, ProgressRecord>
  covers: Map<string, string | undefined>
}

async function loadShelf(): Promise<Shelf> {
  const [books, progressRows] = await Promise.all([listLibrary(), allProgress()])
  const covers = new Map<string, string | undefined>()
  await Promise.all(
    books.map(async (book) => {
      covers.set(book.bookId, await coverUrl(book))
    }),
  )
  return {
    books,
    progress: new Map(progressRows.map((p) => [p.bookId, p])),
    covers,
  }
}

export function Library(): JSX.Element {
  const version = useStore(libraryVersion)
  const progressTick = useStore(progressVersion)
  const jobs = useStore(downloadQueue)
  const { data, loading } = useAsync(loadShelf, [version, progressTick])

  const open = useCallback((book: BookRecord, progress?: ProgressRecord) => {
    // Whichever mode you were last in wins; ties go to reading.
    const listening =
      progress?.positionSec !== undefined &&
      (progress.locator === undefined || (progress.audioPercent ?? 0) > (progress.percent ?? 0))
    navigate(listening ? { name: 'listen', bookId: book.bookId } : { name: 'read', bookId: book.bookId })
  }, [])

  if (loading && !data) return <Spinner label="Opening your library…" />
  const shelf = data ?? { books: [], progress: new Map(), covers: new Map() }

  if (shelf.books.length === 0) {
    return (
      <Empty
        title="Nothing on the shelf yet"
        body="Search the public domain — about 75,000 books from Project Gutenberg, 1,000 beautifully typeset ones from Standard Ebooks, and 20,000 LibriVox recordings."
        action={
          <a class="button button-primary" href={hrefFor({ name: 'search', query: '' })}>
            Search the catalog
          </a>
        }
      />
    )
  }

  const inProgress = shelf.books.filter((book) => {
    const percent = overallPercent(shelf.progress.get(book.bookId))
    return percent > 0.005 && percent < 0.995 && !book.finishedAt
  })

  return (
    <div class="library">
      {inProgress.length > 0 ? (
        <section class="shelf-section">
          <h2 class="section-head">Continue</h2>
          <div class="continue-row">
            {inProgress.map((book) => {
              const progress = shelf.progress.get(book.bookId)
              return (
                <button
                  type="button"
                  class="continue-card"
                  key={book.bookId}
                  onClick={() => open(book, progress)}
                >
                  <Cover
                    src={shelf.covers.get(book.bookId)}
                    title={book.title}
                    authors={book.authors}
                    size="lg"
                  />
                  <span class="continue-title">{book.title}</span>
                  <span class="continue-meta">
                    {progress?.label ?? `${Math.round(overallPercent(progress) * 100)}%`}
                  </span>
                  <ProgressBar value={overallPercent(progress)} label="Reading progress" />
                </button>
              )
            })}
          </div>
        </section>
      ) : null}

      <section class="shelf-section">
        <h2 class="section-head">All books</h2>
        <ul class="book-list">
          {shelf.books.map((book) => {
            const progress = shelf.progress.get(book.bookId)
            const download = bookDownloadProgress(jobs, book.bookId)
            return (
              <li key={book.bookId}>
                <button type="button" class="book-row" onClick={() => open(book, progress)}>
                  <Cover
                    src={shelf.covers.get(book.bookId)}
                    title={book.title}
                    authors={book.authors}
                    size="sm"
                  />
                  <span class="book-row-text">
                    <span class="book-row-title">{book.title}</span>
                    <span class="book-row-author">{book.authors.join(', ')}</span>
                    <span class="book-row-meta">
                      {book.finishedAt ? (
                        <span class="meta-done">Finished</span>
                      ) : overallPercent(progress) > 0 ? (
                        <span>{Math.round(overallPercent(progress) * 100)}% through</span>
                      ) : (
                        <span>Not started</span>
                      )}
                      {download.state === 'running' || download.state === 'queued' ? (
                        <span class="meta-downloading">
                          Downloading {Math.round(download.fraction * 100)}%
                        </span>
                      ) : download.state === 'done' ? (
                        <span class="meta-offline">Offline</span>
                      ) : download.state === 'error' ? (
                        <span class="meta-error">Download failed</span>
                      ) : null}
                    </span>
                  </span>
                </button>
                <a
                  class="book-row-info"
                  href={hrefFor({ name: 'book', workId: book.workId ?? book.bookId })}
                  aria-label={`Details for ${book.title}`}
                >
                  ⓘ
                </a>
              </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}
