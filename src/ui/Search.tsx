import type { JSX } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { catalog } from '../catalog/index'
import { proxyConfigured } from '../catalog/proxy'
import { hrefFor, navigate } from '../core/router'
import type { CatalogWork } from '../core/types'
import { Cover, Empty, ErrorNote, SegmentedControl, Spinner } from './components'
import { formatDuration } from '../player/player'

type Filter = 'all' | 'text' | 'audio'

export function Search({ initialQuery }: { initialQuery: string }): JSX.Element {
  const [query, setQuery] = useState(initialQuery)
  const [filter, setFilter] = useState<Filter>('all')
  const [results, setResults] = useState<CatalogWork[]>([])
  const [featured, setFeatured] = useState<CatalogWork[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Featured is the Standard Ebooks new-releases feed — a decent front page
  // when there's no query yet.
  useEffect(() => {
    let cancelled = false
    catalog
      .featured()
      .then((works) => {
        if (!cancelled) setFeatured(works)
      })
      .catch(() => {
        /* front page is optional */
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      setResults([])
      setLoading(false)
      return
    }

    const controller = new AbortController()
    const timer = setTimeout(() => {
      setLoading(true)
      setError(null)
      catalog
        .search(trimmed, { signal: controller.signal, filter })
        .then((works) => {
          setResults(works)
          setLoading(false)
        })
        .catch((cause: unknown) => {
          if ((cause as Error)?.name === 'AbortError') return
          setError(cause instanceof Error ? cause : new Error(String(cause)))
          setLoading(false)
        })
      navigate({ name: 'search', query: trimmed }, true)
    }, 350)

    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [query, filter])

  const showFeatured = query.trim().length < 2

  return (
    <div class="search">
      <div class="search-bar">
        <input
          ref={inputRef}
          type="search"
          class="search-input"
          placeholder="Title or author"
          value={query}
          autocomplete="off"
          autocorrect="off"
          spellcheck={false}
          enterkeyhint="search"
          onInput={(event) => setQuery((event.currentTarget as HTMLInputElement).value)}
        />
      </div>

      <SegmentedControl<Filter>
        value={filter}
        onChange={setFilter}
        label="Filter results"
        options={[
          { value: 'all', label: 'All' },
          { value: 'text', label: 'To read' },
          { value: 'audio', label: 'To hear' },
        ]}
      />

      {!proxyConfigured ? (
        <p class="note">
          No CORS proxy configured. Gutenberg and LibriVox results will be missing until
          <code> VITE_PROXY_BASE</code> points at the Worker (§6.1).
        </p>
      ) : null}

      {error ? <ErrorNote error={error} /> : null}
      {loading ? <Spinner label="Searching…" /> : null}

      {showFeatured ? (
        featured.length > 0 ? (
          <section class="shelf-section">
            <h2 class="section-head">New from Standard Ebooks</h2>
            <ResultList works={featured} />
          </section>
        ) : null
      ) : !loading && results.length === 0 ? (
        <Empty title="No matches" body="Try the author's surname, or a shorter title." />
      ) : (
        <ResultList works={results} />
      )}
    </div>
  )
}

function ResultList({ works }: { works: CatalogWork[] }): JSX.Element {
  return (
    <ul class="result-list">
      {works.map((work) => {
        const edition = work.editions[0]
        const recording = work.recordings[0]
        return (
          <li key={work.workId}>
            <a class="result-row" href={hrefFor({ name: 'book', workId: work.workId })}>
              <Cover src={work.coverUrl} title={work.title} authors={work.authors} size="sm" />
              <span class="result-text">
                <span class="result-title">{work.title}</span>
                <span class="result-author">{work.authors.join(', ') || 'Unknown author'}</span>
                <span class="result-meta">
                  {edition ? (
                    <span class={`chip chip-${edition.source}`}>
                      {edition.source === 'standard-ebooks' ? 'Standard Ebooks' : 'Gutenberg'}
                    </span>
                  ) : null}
                  {recording ? (
                    <span class="chip chip-librivox">
                      {formatDuration(recording.totalSeconds)} audio
                    </span>
                  ) : null}
                  {work.matchConfidence !== undefined && work.matchConfidence < 0.85 ? (
                    <span class="chip chip-warn" title="Text and audio were matched automatically">
                      audio match uncertain
                    </span>
                  ) : null}
                </span>
              </span>
            </a>
          </li>
        )
      })}
    </ul>
  )
}
