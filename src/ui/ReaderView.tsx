import type { JSX } from 'preact'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { ensureTracks } from '../catalog/index'
import { getBook, getProgress } from '../core/db'
import { loadEpub } from '../core/library'
import { recordTextProgress } from '../core/progress'
import { back, hrefFor, navigate } from '../core/router'
import { settings, updateSetting } from '../core/settings'
import { useStore } from '../core/store'
import type { AnnotationRecord, BookRecord, ReaderTheme } from '../core/types'
import { buildMapping, describeMapping, trackForSpine } from '../player/handoff'
import { loadBook as loadPlayerBook } from '../player/player'
import {
  createAnnotation,
  deleteAnnotation,
  HIGHLIGHT_COLORS,
  listAnnotations,
  updateAnnotation,
} from '../reader/annotations'
import { Reader, type ReaderLocation } from '../reader/reader'
import { FONT_STACKS, THEMES } from '../reader/themes'
import { ErrorNote, SegmentedControl, Sheet, Slider, Spinner, Toggle } from './components'

type Panel = 'none' | 'toc' | 'type' | 'search' | 'note'

export function ReaderView({ bookId }: { bookId: string }): JSX.Element {
  const config = useStore(settings)
  const containerRef = useRef<HTMLDivElement>(null)
  const readerRef = useRef<Reader | null>(null)

  const [book, setBook] = useState<BookRecord | null>(null)
  const [location, setLocation] = useState<ReaderLocation | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<Error | null>(null)
  const [chromeVisible, setChromeVisible] = useState(true)
  const [panel, setPanel] = useState<Panel>('none')
  const [annotations, setAnnotations] = useState<AnnotationRecord[]>([])
  const [selection, setSelection] = useState<{ cfi: string; text: string } | null>(null)
  const [activeAnnotation, setActiveAnnotation] = useState<AnnotationRecord | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [searchResults, setSearchResults] = useState<{ label: string; cfi: string; excerpt: string }[]>([])
  const [handoffNote, setHandoffNote] = useState<string | null>(null)

  // --- open ----------------------------------------------------------------

  useEffect(() => {
    let cancelled = false
    const reader = new Reader()
    readerRef.current = reader

    void (async () => {
      try {
        const [record, progress, notes] = await Promise.all([
          getBook(bookId),
          getProgress(bookId),
          listAnnotations(bookId),
        ])
        if (!record) throw new Error('That book is not in your library.')
        if (cancelled) return
        setBook(record)
        setAnnotations(notes)

        const blob = await loadEpub(bookId)
        if (cancelled || !containerRef.current) return

        await reader.open(containerRef.current, blob, {
          bookId,
          lastLocation: progress?.locator ?? null,
          settings: settings.get(),
          callbacks: {
            onRelocate: (next) => {
              setLocation(next)
              void recordTextProgress(bookId, {
                locator: next.cfi,
                percent: next.fraction,
                label: next.label,
              })
            },
            onSelection: (next) => setSelection(next ? { cfi: next.cfi, text: next.text } : null),
            onAnnotationClick: (cfi) => {
              const found = notes.find((a) => a.locator === cfi)
              if (found) {
                setActiveAnnotation(found)
                setNoteDraft(found.note ?? '')
                setPanel('note')
              }
            },
            onError: (cause) => setError(cause),
          },
        })

        if (cancelled) return
        await reader.applyAnnotations(notes)

        // A listen→read handoff overrides stored progress: the player knows
        // where you actually are (§7.4).
        const handoff = sessionStorage.getItem('pdr:handoff')
        if (handoff) {
          sessionStorage.removeItem('pdr:handoff')
          try {
            const parsed = JSON.parse(handoff) as {
              bookId: string
              spineIndex?: number
              cfi?: string
            }
            if (parsed.bookId === bookId) {
              // A CFI (from the annotations list) is more precise than a spine
              // index (from the player), so it wins.
              if (parsed.cfi) await reader.goTo(parsed.cfi)
              else if (typeof parsed.spineIndex === 'number' && parsed.spineIndex >= 0) {
                await reader.goToSpineIndex(parsed.spineIndex)
              }
            }
          } catch {
            /* malformed handoff, ignore */
          }
        }
        const note = sessionStorage.getItem('pdr:handoffNote')
        if (note) {
          sessionStorage.removeItem('pdr:handoffNote')
          setHandoffNote(note)
        }

        setStatus('ready')
      } catch (cause) {
        if (cancelled) return
        setError(cause instanceof Error ? cause : new Error(String(cause)))
        setStatus('error')
      }
    })()

    return () => {
      cancelled = true
      reader.close()
      readerRef.current = null
    }
  }, [bookId])

  // Typography changes re-render in place; no need to reopen the book.
  useEffect(() => {
    readerRef.current?.applySettings(config)
  }, [config])

  // --- input ---------------------------------------------------------------

  const onTap = useCallback((event: MouseEvent) => {
    const reader = readerRef.current
    if (!reader) return
    const width = window.innerWidth
    const x = event.clientX
    if (x < width * 0.28) reader.goLeft()
    else if (x > width * 0.72) reader.goRight()
    else setChromeVisible((visible) => !visible)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const reader = readerRef.current
      if (!reader || panel !== 'none') return
      if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
        event.preventDefault()
        reader.goRight()
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault()
        reader.goLeft()
      } else if (event.key === 'Escape') {
        back()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [panel])

  // --- annotations ---------------------------------------------------------

  const refreshAnnotations = useCallback(async () => {
    setAnnotations(await listAnnotations(bookId))
  }, [bookId])

  const highlight = useCallback(
    async (color: string) => {
      const reader = readerRef.current
      if (!reader || !selection) return
      const created = await createAnnotation({
        bookId,
        locator: selection.cfi,
        kind: 'highlight',
        color,
        text: selection.text,
        chapter: location?.label,
      })
      await reader.addAnnotation(created)
      reader.clearSelection()
      setSelection(null)
      await refreshAnnotations()
    },
    [bookId, selection, location, refreshAnnotations],
  )

  const addBookmark = useCallback(async () => {
    if (!location?.cfi) return
    await createAnnotation({
      bookId,
      locator: location.cfi,
      kind: 'bookmark',
      color: HIGHLIGHT_COLORS[0].value,
      chapter: location.label,
    })
    await refreshAnnotations()
  }, [bookId, location, refreshAnnotations])

  // --- handoff (§7.4) ------------------------------------------------------

  const switchToAudio = useCallback(async () => {
    const reader = readerRef.current
    if (!reader || !book) return
    if (!book.recording) {
      setHandoffNote('No recording is linked to this book.')
      return
    }

    const filled = await ensureTracks({
      workId: book.workId ?? book.bookId,
      title: book.title,
      authors: book.authors,
      language: book.language,
      subjects: book.subjects,
      editions: book.edition ? [book.edition] : [],
      recordings: [book.recording],
    })
    const recording = filled.recordings[0]
    if (!recording || recording.tracks.length === 0) {
      setHandoffNote('Could not load the recording’s section list.')
      return
    }

    const mapping = buildMapping(reader.spine, recording.tracks)
    const trackIndex = trackForSpine(mapping, location?.index ?? 0)
    setHandoffNote(describeMapping(mapping))

    await loadPlayerBook({ ...book, recording }, recording.tracks, { trackIndex, autoplay: false })
    navigate({ name: 'listen', bookId })
  }, [book, bookId, location])

  // --- render --------------------------------------------------------------

  if (status === 'error') {
    return (
      <div class="reader-error">
        <ErrorNote error={error ?? new Error('Could not open this book')} />
        <button type="button" class="button" onClick={back}>
          Back
        </button>
      </div>
    )
  }

  const palette = THEMES[config.theme]

  return (
    <div
      class={`reader-screen${chromeVisible ? '' : ' chrome-hidden'}`}
      style={{ background: palette.bg, color: palette.fg }}
    >
      {status === 'loading' ? <Spinner label="Opening…" /> : null}

      <div class="reader-surface" ref={containerRef} onClick={onTap} />

      <header class="reader-bar reader-bar-top">
        <button type="button" class="icon-button" onClick={back} aria-label="Back">
          ‹
        </button>
        <span class="reader-chapter">{location?.label ?? book?.title ?? ''}</span>
        <div class="reader-bar-actions">
          <button
            type="button"
            class="icon-button"
            onClick={() => setPanel('search')}
            aria-label="Search in book"
          >
            ⌕
          </button>
          <button
            type="button"
            class="icon-button"
            onClick={() => void addBookmark()}
            aria-label="Bookmark this page"
          >
            ⚑
          </button>
        </div>
      </header>

      <footer class="reader-bar reader-bar-bottom">
        <button type="button" class="icon-button" onClick={() => setPanel('toc')} aria-label="Contents">
          ☰
        </button>
        <div class="reader-scrub">
          <input
            type="range"
            min={0}
            max={1000}
            value={Math.round((location?.fraction ?? 0) * 1000)}
            onChange={(event) =>
              void readerRef.current?.goToFraction(
                Number((event.currentTarget as HTMLInputElement).value) / 1000,
              )
            }
            aria-label="Position in book"
          />
          <span class="reader-percent">
            {Math.round((location?.fraction ?? 0) * 100)}%
            {location?.pagesLeftInChapter !== undefined
              ? ` · ${location.pagesLeftInChapter} pages left in chapter`
              : ''}
          </span>
        </div>
        {book?.recording ? (
          <button
            type="button"
            class="icon-button"
            onClick={() => void switchToAudio()}
            aria-label="Switch to audio"
          >
            ⏻
          </button>
        ) : null}
        <button type="button" class="icon-button" onClick={() => setPanel('type')} aria-label="Typography">
          Aa
        </button>
      </footer>

      {selection ? (
        <div class="selection-bar">
          {HIGHLIGHT_COLORS.map((color) => (
            <button
              key={color.value}
              type="button"
              class="swatch"
              style={{ background: color.value }}
              aria-label={`Highlight ${color.name}`}
              onClick={() => void highlight(color.value)}
            />
          ))}
          <button
            type="button"
            class="button button-small"
            onClick={() => {
              setNoteDraft('')
              setActiveAnnotation(null)
              setPanel('note')
            }}
          >
            Note
          </button>
        </div>
      ) : null}

      {handoffNote ? (
        <div class="toast" onClick={() => setHandoffNote(null)}>
          {handoffNote}
        </div>
      ) : null}

      <TypographySheet open={panel === 'type'} onClose={() => setPanel('none')} />

      <Sheet open={panel === 'toc'} onClose={() => setPanel('none')} title="Contents">
        <ul class="toc-list">
          {readerRef.current?.toc.map((item, index) => (
            <li key={`${item.href}-${index}`}>
              <button
                type="button"
                onClick={() => {
                  void readerRef.current?.goTo(item.href)
                  setPanel('none')
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
        {annotations.length > 0 ? (
          <a class="button button-quiet" href={hrefFor({ name: 'annotations', bookId })}>
            {annotations.length} highlights &amp; notes
          </a>
        ) : null}
      </Sheet>

      <SearchSheet
        open={panel === 'search'}
        onClose={() => {
          setPanel('none')
          readerRef.current?.clearSearch()
          setSearchResults([])
        }}
        results={searchResults}
        onSearch={async (query) => {
          const reader = readerRef.current
          if (!reader) return
          setSearchResults([])
          const found: { label: string; cfi: string; excerpt: string }[] = []
          for await (const result of reader.search(query)) {
            found.push(result)
            if (found.length % 5 === 0) setSearchResults([...found])
            if (found.length >= 200) break
          }
          setSearchResults(found)
        }}
        onPick={(cfi) => {
          void readerRef.current?.goTo(cfi)
          setPanel('none')
        }}
      />

      <Sheet
        open={panel === 'note'}
        onClose={() => {
          setPanel('none')
          setActiveAnnotation(null)
        }}
        title={activeAnnotation ? 'Edit note' : 'Add note'}
      >
        {activeAnnotation?.text ? <blockquote class="note-quote">{activeAnnotation.text}</blockquote> : null}
        {!activeAnnotation && selection ? <blockquote class="note-quote">{selection.text}</blockquote> : null}
        <textarea
          class="note-input"
          rows={5}
          value={noteDraft}
          placeholder="What struck you?"
          onInput={(event) => setNoteDraft((event.currentTarget as HTMLTextAreaElement).value)}
        />
        <div class="sheet-actions">
          <button
            type="button"
            class="button button-primary"
            onClick={() =>
              void (async () => {
                const reader = readerRef.current
                if (activeAnnotation) {
                  await updateAnnotation(activeAnnotation.id, { note: noteDraft })
                } else if (selection) {
                  const created = await createAnnotation({
                    bookId,
                    locator: selection.cfi,
                    kind: 'note',
                    color: HIGHLIGHT_COLORS[0].value,
                    text: selection.text,
                    note: noteDraft,
                    chapter: location?.label,
                  })
                  await reader?.addAnnotation(created)
                  reader?.clearSelection()
                  setSelection(null)
                }
                await refreshAnnotations()
                setPanel('none')
                setActiveAnnotation(null)
              })()
            }
          >
            Save
          </button>
          {activeAnnotation ? (
            <button
              type="button"
              class="button button-danger"
              onClick={() =>
                void (async () => {
                  await deleteAnnotation(activeAnnotation.id)
                  await readerRef.current?.removeAnnotation(activeAnnotation.locator)
                  await refreshAnnotations()
                  setPanel('none')
                  setActiveAnnotation(null)
                })()
              }
            >
              Delete
            </button>
          ) : null}
        </div>
      </Sheet>
    </div>
  )
}

function TypographySheet({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  const config = useStore(settings)
  return (
    <Sheet open={open} onClose={onClose} title="Typography">
      <SegmentedControl<ReaderTheme>
        label="Theme"
        value={config.theme}
        onChange={(theme) => void updateSetting('theme', theme)}
        options={(Object.keys(THEMES) as ReaderTheme[]).map((key) => ({
          value: key,
          label: THEMES[key].name,
        }))}
      />

      <label class="field">
        <span>Typeface</span>
        <select
          value={config.fontFamily}
          onChange={(event) =>
            void updateSetting('fontFamily', (event.currentTarget as HTMLSelectElement).value)
          }
        >
          {FONT_STACKS.map((font) => (
            <option key={font.value} value={font.value}>
              {font.label}
            </option>
          ))}
        </select>
      </label>

      <Slider
        label="Text size"
        value={config.fontSize}
        min={14}
        max={30}
        onInput={(value) => void updateSetting('fontSize', value)}
        format={(value) => `${value}px`}
      />
      <Slider
        label="Line height"
        value={config.lineHeight}
        min={1.2}
        max={2.2}
        step={0.05}
        onInput={(value) => void updateSetting('lineHeight', value)}
        format={(value) => value.toFixed(2)}
      />
      <Slider
        label="Margins"
        value={config.margin}
        min={8}
        max={64}
        onInput={(value) => void updateSetting('margin', value)}
        format={(value) => `${value}px`}
      />

      <SegmentedControl<'paginated' | 'scrolled'>
        label="Layout"
        value={config.flow}
        onChange={(flow) => void updateSetting('flow', flow)}
        options={[
          { value: 'paginated', label: 'Pages' },
          { value: 'scrolled', label: 'Scroll' },
        ]}
      />

      <Toggle
        label="Justify"
        checked={config.justify}
        onChange={(value) => void updateSetting('justify', value)}
      />
      <Toggle
        label="Hyphenate"
        hint="Needed for justified text to look right on a narrow column."
        checked={config.hyphenate}
        onChange={(value) => void updateSetting('hyphenate', value)}
      />
    </Sheet>
  )
}

function SearchSheet({
  open,
  onClose,
  results,
  onSearch,
  onPick,
}: {
  open: boolean
  onClose: () => void
  results: { label: string; cfi: string; excerpt: string }[]
  onSearch: (query: string) => Promise<void>
  onPick: (cfi: string) => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)

  return (
    <Sheet open={open} onClose={onClose} title="Search in book">
      <form
        class="search-in-book"
        onSubmit={(event) => {
          event.preventDefault()
          if (query.trim().length < 2) return
          setSearching(true)
          void onSearch(query.trim()).finally(() => setSearching(false))
        }}
      >
        <input
          type="search"
          value={query}
          placeholder="Find a phrase"
          enterkeyhint="search"
          onInput={(event) => setQuery((event.currentTarget as HTMLInputElement).value)}
        />
        <button type="submit" class="button button-small">
          Find
        </button>
      </form>
      {searching ? <Spinner label="Searching the whole book…" /> : null}
      <ul class="search-results">
        {results.map((result) => (
          <li key={result.cfi}>
            <button type="button" onClick={() => onPick(result.cfi)}>
              <span class="search-result-label">{result.label}</span>
              <span class="search-result-excerpt">{result.excerpt}</span>
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  )
}
