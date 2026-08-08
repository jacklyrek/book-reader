import type { JSX } from 'preact'
import { hrefFor, route } from './core/router'
import { useStore } from './core/store'
import { syncState } from './core/sync'
import { AnnotationsView } from './ui/AnnotationsView'
import { BookDetail } from './ui/BookDetail'
import { CollectionDetail, Collections } from './ui/Collections'
import { Downloads } from './ui/Downloads'
import { Library } from './ui/Library'
import { NowPlaying } from './ui/NowPlaying'
import { PlayerView } from './ui/PlayerView'
import { ReaderView } from './ui/ReaderView'
import { Search } from './ui/Search'
import { SettingsView } from './ui/SettingsView'
import { StorageView } from './ui/StorageView'

const TITLES: Record<string, string> = {
  library: 'Library',
  search: 'Search',
  book: 'Book',
  downloads: 'Downloads',
  storage: 'Storage',
  settings: 'Settings',
  collections: 'Shelves',
  collection: 'Shelf',
  annotations: 'Highlights',
}

export function App(): JSX.Element {
  const current = useStore(route)
  const sync = useStore(syncState)

  // The reader and player are full-bleed: no app chrome, no tab bar.
  if (current.name === 'read') return <ReaderView bookId={current.bookId} />
  if (current.name === 'listen') return <PlayerView bookId={current.bookId} />

  return (
    <div class="app">
      <header class="app-bar">
        <h1 class="app-title">{TITLES[current.name] ?? 'Reader'}</h1>
        {sync.status === 'offline' ? <span class="sync-chip">offline</span> : null}
        {sync.pending > 0 ? <span class="sync-chip">{sync.pending} unsynced</span> : null}
      </header>

      <main class="app-main">
        {current.name === 'library' ? <Library /> : null}
        {current.name === 'search' ? <Search initialQuery={current.query} /> : null}
        {current.name === 'book' ? <BookDetail workId={current.workId} /> : null}
        {current.name === 'downloads' ? <Downloads /> : null}
        {current.name === 'storage' ? <StorageView /> : null}
        {current.name === 'settings' ? <SettingsView /> : null}
        {current.name === 'collections' ? <Collections /> : null}
        {current.name === 'collection' ? <CollectionDetail id={current.id} /> : null}
        {current.name === 'annotations' ? <AnnotationsView bookId={current.bookId} /> : null}
      </main>

      <NowPlaying />

      <nav class="tab-bar" aria-label="Main">
        <TabLink href={hrefFor({ name: 'library' })} active={current.name === 'library'} label="Library" glyph="▤" />
        <TabLink href={hrefFor({ name: 'search', query: '' })} active={current.name === 'search' || current.name === 'book'} label="Search" glyph="⌕" />
        <TabLink
          href={hrefFor({ name: 'collections' })}
          active={current.name === 'collections' || current.name === 'collection'}
          label="Shelves"
          glyph="◫"
        />
        <TabLink href={hrefFor({ name: 'downloads' })} active={current.name === 'downloads'} label="Downloads" glyph="↓" />
        <TabLink
          href={hrefFor({ name: 'settings' })}
          active={current.name === 'settings' || current.name === 'storage'}
          label="Settings"
          glyph="⚙"
        />
      </nav>
    </div>
  )
}

function TabLink({
  href,
  active,
  label,
  glyph,
}: {
  href: string
  active: boolean
  label: string
  glyph: string
}): JSX.Element {
  return (
    <a class={active ? 'tab tab-active' : 'tab'} href={href} aria-current={active ? 'page' : undefined}>
      <span class="tab-glyph" aria-hidden="true">
        {glyph}
      </span>
      <span class="tab-label">{label}</span>
    </a>
  )
}
