/**
 * Hash router. Hash rather than History API so the app survives being served
 * from any path and so a hard reload inside the installed PWA never 404s.
 */
import { createStore } from './store'

export type Route =
  | { name: 'library' }
  | { name: 'search'; query: string }
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
      return { name: 'search', query: params.get('q') ?? '' }
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
      return `#/search?q=${encodeURIComponent(target.query)}`
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
  route.set(parseHash(href))
}

export function back(): void {
  if (history.length > 1) history.back()
  else navigate({ name: 'library' })
}

export function startRouter(): void {
  window.addEventListener('hashchange', () => {
    route.set(parseHash(location.hash))
    // A route change is a new screen; the phone should be at the top of it.
    window.scrollTo(0, 0)
  })
}
