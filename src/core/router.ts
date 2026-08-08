/**
 * Hash router. Hash rather than History API so the app survives being served
 * from any path and so a hard reload inside the installed PWA never 404s.
 */
import { createStore } from './store'

export type Route =
  | { name: 'library' }
  /** `author` narrows the search to one writer; curated shelves link that way. */
  | { name: 'search'; query: string; author?: string }
  | { name: 'book'; workId: string }
  | { name: 'read'; bookId: string }
  | { name: 'listen'; bookId: string }
  | { name: 'downloads' }
  | { name: 'storage' }
  | { name: 'settings' }
  | { name: 'collections' }
  | { name: 'collection'; id: string }
  | { name: 'annotations'; bookId: string }

export const route = createStore<Route>(parseHash(location.hash))

/**
 * The screen we came from, so pushed detail screens can offer a back link that
 * returns to the exact list — with its query — rather than to a bare tab.
 * Persisted, or reloading a detail page inside the PWA strands you there.
 */
const storedPrevious = sessionStorage.getItem('pdr:previous')
let previous: Route | null = storedPrevious ? parseHash(storedPrevious) : null

/**
 * The last query actually searched for. A book detail page is pushed on top of
 * the Search tab, so tapping Search to get back must not wipe the query; it
 * survives a reload of the installed PWA too.
 */
let lastSearchQuery = sessionStorage.getItem('pdr:lastSearch') ?? ''
let lastSearchAuthor = sessionStorage.getItem('pdr:lastSearchAuthor') ?? ''

export function previousRoute(): Route | null {
  return previous
}

/** The Search tab's target: the search in progress, not an empty one. */
export function searchRoute(): Route {
  return { name: 'search', query: lastSearchQuery, author: lastSearchAuthor || undefined }
}

/**
 * `navigate` and `hashchange` both land here, and both fire for a single
 * `location.hash` assignment, so the no-op case must not shift `previous`.
 */
function commit(next: Route, replace: boolean): void {
  const current = route.get()
  const changed = hrefFor(current) !== hrefFor(next)
  // A replace rewrites the current entry, so there is no new step to come back
  // from — Search rewrites its own URL on every keystroke.
  if (changed && !replace) {
    previous = current
    sessionStorage.setItem('pdr:previous', hrefFor(current))
  }
  if (next.name === 'search') {
    lastSearchQuery = next.query
    lastSearchAuthor = next.author ?? ''
    sessionStorage.setItem('pdr:lastSearch', lastSearchQuery)
    sessionStorage.setItem('pdr:lastSearchAuthor', lastSearchAuthor)
  }
  route.set(next)
}

function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '')
  const [path = '', queryString = ''] = raw.split('?')
  const segments = path.split('/').filter(Boolean).map(decodeURIComponent)
  const params = new URLSearchParams(queryString)

  const [head, ...rest] = segments
  const tail = rest.join('/')

  switch (head) {
    case undefined:
    case '':
      return { name: 'library' }
    case 'search':
      return { name: 'search', query: params.get('q') ?? '', author: params.get('a') || undefined }
    case 'book':
      return tail ? { name: 'book', workId: tail } : { name: 'library' }
    case 'read':
      return tail ? { name: 'read', bookId: tail } : { name: 'library' }
    case 'listen':
      return tail ? { name: 'listen', bookId: tail } : { name: 'library' }
    case 'downloads':
      return { name: 'downloads' }
    case 'storage':
      return { name: 'storage' }
    case 'settings':
      return { name: 'settings' }
    case 'collections':
      return tail ? { name: 'collection', id: tail } : { name: 'collections' }
    case 'annotations':
      return tail ? { name: 'annotations', bookId: tail } : { name: 'library' }
    default:
      return { name: 'library' }
  }
}

export function hrefFor(target: Route): string {
  switch (target.name) {
    case 'library':
      return '#/'
    case 'search':
      return target.author
        ? `#/search?q=${encodeURIComponent(target.query)}&a=${encodeURIComponent(target.author)}`
        : `#/search?q=${encodeURIComponent(target.query)}`
    case 'book':
      return `#/book/${encodeURIComponent(target.workId)}`
    case 'read':
      return `#/read/${encodeURIComponent(target.bookId)}`
    case 'listen':
      return `#/listen/${encodeURIComponent(target.bookId)}`
    case 'downloads':
      return '#/downloads'
    case 'storage':
      return '#/storage'
    case 'settings':
      return '#/settings'
    case 'collections':
      return '#/collections'
    case 'collection':
      return `#/collections/${encodeURIComponent(target.id)}`
    case 'annotations':
      return `#/annotations/${encodeURIComponent(target.bookId)}`
  }
}

export function navigate(target: Route, replace = false): void {
  const href = hrefFor(target)
  if (replace) history.replaceState(null, '', href)
  else location.hash = href
  commit(parseHash(href), replace)
}

export function back(): void {
  if (history.length > 1) history.back()
  else navigate({ name: 'library' })
}

export function startRouter(): void {
  // Seed from the entry URL so a deep link into `#/search?q=…` is remembered.
  commit(parseHash(location.hash), true)
  window.addEventListener('hashchange', () => {
    commit(parseHash(location.hash), false)
    // A route change is a new screen; the phone should be at the top of it.
    // `.app-main` is the scroller — `.app` is a 100dvh grid, so the window
    // itself never scrolls and scrolling it here did nothing.
    document.querySelector('.app-main')?.scrollTo(0, 0)
  })
}
