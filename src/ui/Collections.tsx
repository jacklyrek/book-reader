import type { JSX } from 'preact'
import { useState } from 'preact/hooks'
import {
  collectionVersion,
  createCollection,
  listCollections,
  removeFromCollection,
  resolveShelf,
} from '../core/collections'
import { getCollection } from '../core/db'
import { libraryVersion, listLibrary } from '../core/library'
import { hrefFor } from '../core/router'
import { useAsync, useStore } from '../core/store'
import { Cover, Empty, ProgressBar, Spinner } from './components'

export function Collections(): JSX.Element {
  const version = useStore(collectionVersion)
  const libVersion = useStore(libraryVersion)
  const [name, setName] = useState('')
  const { data, loading } = useAsync(async () => {
    const [collections, books] = await Promise.all([listCollections(), listLibrary()])
    return { collections, books }
  }, [version, libVersion])

  if (loading && !data) return <Spinner />
  const { collections = [], books = [] } = data ?? {}

  return (
    <div class="collections">
      <ul class="collection-list">
        {collections.map((collection) => {
          const entries = resolveShelf(collection, books)
          const have = entries.filter((entry) => entry.book).length
          return (
            <li key={collection.id}>
              <a class="collection-card" href={hrefFor({ name: 'collection', id: collection.id })}>
                <span class="collection-name">{collection.name}</span>
                <span class="collection-meta">
                  {have} of {entries.length} on the shelf
                </span>
                <ProgressBar
                  value={entries.length ? have / entries.length : 0}
                  label={`${collection.name} progress`}
                />
              </a>
            </li>
          )
        })}
      </ul>

      <form
        class="new-collection"
        onSubmit={(event) => {
          event.preventDefault()
          if (!name.trim()) return
          void createCollection(name.trim()).then(() => setName(''))
        }}
      >
        <input
          type="text"
          placeholder="New shelf name"
          value={name}
          onInput={(event) => setName((event.currentTarget as HTMLInputElement).value)}
        />
        <button type="submit" class="button button-small">
          Create
        </button>
      </form>
    </div>
  )
}

export function CollectionDetail({ id }: { id: string }): JSX.Element {
  const version = useStore(collectionVersion)
  const libVersion = useStore(libraryVersion)
  const { data, loading } = useAsync(async () => {
    const [collection, books] = await Promise.all([getCollection(id), listLibrary()])
    return { collection, books }
  }, [id, version, libVersion])

  if (loading && !data) return <Spinner />
  if (!data?.collection) return <Empty title="Shelf not found" />

  const { collection, books } = data
  const entries = resolveShelf(collection, books)
  const have = entries.filter((entry) => entry.book).length

  return (
    <div class="collection-detail">
      <header class="collection-head">
        <h1>{collection.name}</h1>
        {collection.description ? <p>{collection.description}</p> : null}
        <ProgressBar value={entries.length ? have / entries.length : 0} label="Shelf progress" />
        <p class="note">
          {have} of {entries.length} in your library.
        </p>
      </header>

      <ul class="shelf-entries">
        {entries.map((entry, index) => (
          <li key={`${entry.title}-${index}`} class={entry.book ? 'have' : 'want'}>
            {entry.book ? (
              <a class="shelf-entry" href={hrefFor({ name: 'read', bookId: entry.book.bookId })}>
                <Cover
                  src={entry.book.coverKey}
                  title={entry.book.title}
                  authors={entry.book.authors}
                  size="sm"
                />
                <span class="shelf-entry-text">
                  <span class="shelf-title">{entry.title}</span>
                  <span class="shelf-author">{entry.author}</span>
                </span>
              </a>
            ) : (
              <a
                class="shelf-entry shelf-entry-missing"
                // Title and author as separate fields. Glued into one string
                // they read as a title no catalog has, and the search comes back
                // empty for a book that is definitely there.
                href={hrefFor({ name: 'search', query: entry.title, author: entry.author })}
              >
                <span class="cover cover-sm cover-fallback cover-empty" aria-hidden="true" />
                <span class="shelf-entry-text">
                  <span class="shelf-title">{entry.title}</span>
                  <span class="shelf-author">{entry.author}</span>
                  <span class="shelf-find">Find it →</span>
                </span>
              </a>
            )}
            {entry.book && collection.bookIds.includes(entry.book.bookId) ? (
              <button
                type="button"
                class="link-button"
                onClick={() => void removeFromCollection(collection.id, entry.book!.bookId)}
              >
                Remove
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
