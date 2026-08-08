import type { JSX } from 'preact'
import { getBook } from '../core/db'
import { hrefFor, navigate } from '../core/router'
import { useAsync, useStore } from '../core/store'
import {
  annotationVersion,
  deleteAnnotation,
  downloadExport,
  exportBookAnnotations,
  listAnnotations,
  toMarkdown,
} from '../reader/annotations'
import { Empty, Spinner } from './components'

export function AnnotationsView({ bookId }: { bookId: string }): JSX.Element {
  const version = useStore(annotationVersion)
  const { data, loading, reload } = useAsync(async () => {
    const [book, annotations] = await Promise.all([getBook(bookId), listAnnotations(bookId)])
    return { book, annotations }
  }, [bookId, version])

  if (loading && !data) return <Spinner />
  if (!data?.book) return <Empty title="Book not found" />

  const { book, annotations } = data

  if (annotations.length === 0) {
    return (
      <Empty
        title="No highlights yet"
        body="Select a passage while reading to highlight it or attach a note."
        action={
          <a class="button" href={hrefFor({ name: 'read', bookId })}>
            Open {book.title}
          </a>
        }
      />
    )
  }

  const exportAs = async (format: 'md' | 'json') => {
    const entries = await exportBookAnnotations(bookId)
    const slug = book.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    if (format === 'md') {
      downloadExport(`${slug}.md`, toMarkdown(entries), 'text/markdown')
    } else {
      downloadExport(`${slug}.json`, JSON.stringify(entries, null, 2), 'application/json')
    }
  }

  return (
    <div class="annotations">
      <header class="annotations-head">
        <h1>{book.title}</h1>
        <p>{annotations.length} highlights and notes</p>
        <div class="button-row">
          <button type="button" class="button button-small" onClick={() => void exportAs('md')}>
            Export Markdown
          </button>
          <button
            type="button"
            class="button button-small button-quiet"
            onClick={() => void exportAs('json')}
          >
            Export JSON
          </button>
        </div>
        <p class="note">
          Exports carry the EPUB CFI locator, so a quote can move into the commonplace book and still
          point back at the exact passage.
        </p>
      </header>

      <ul class="annotation-list">
        {annotations.map((annotation) => (
          <li key={annotation.id} class={`annotation annotation-${annotation.kind}`}>
            <button
              type="button"
              class="annotation-body"
              onClick={() => {
                sessionStorage.setItem(
                  'pdr:handoff',
                  JSON.stringify({ bookId, spineIndex: -1, cfi: annotation.locator }),
                )
                navigate({ name: 'read', bookId })
              }}
            >
              {annotation.chapter ? <span class="annotation-chapter">{annotation.chapter}</span> : null}
              {annotation.kind === 'bookmark' ? (
                <span class="annotation-quote">Bookmark</span>
              ) : (
                <span class="annotation-quote" style={{ borderColor: annotation.color }}>
                  {annotation.text}
                </span>
              )}
              {annotation.note ? <span class="annotation-note">{annotation.note}</span> : null}
              <span class="annotation-date">
                {new Date(annotation.createdAt).toLocaleDateString()}
              </span>
            </button>
            <button
              type="button"
              class="link-button link-danger"
              onClick={() => void deleteAnnotation(annotation.id).then(reload)}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
