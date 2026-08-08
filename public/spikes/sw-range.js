/**
 * Minimal range server for spike 4 (§8, risk 4).
 *
 * Deliberately standalone from src/sw.ts: the spike has to be runnable and
 * debuggable without the app around it. If this passes and src/sw.ts doesn't,
 * the bug is in the app, not in the technique.
 */

const DB = 'spike-range'
const STORE = 'assets'
const PREFIX = '/spikes/media/'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

function openDatabase() {
  return new Promise((resolve) => {
    const request = indexedDB.open(DB)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
  })
}

async function readAsset(id) {
  const db = await openDatabase()
  if (!db || !db.objectStoreNames.contains(STORE)) return null
  return new Promise((resolve) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(id)
    request.onsuccess = () => resolve(request.result ?? null)
    request.onerror = () => resolve(null)
  })
}

function parseRange(header, size) {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return 'unsatisfiable'
  if (size <= 0) return 'unsatisfiable'

  let start
  let end
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!suffix) return 'unsatisfiable'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
    if (start >= size) return 'unsatisfiable'
    end = Math.min(end, size - 1)
    if (end < start) return 'unsatisfiable'
  }
  return { start, end }
}

async function serve(request, id) {
  const asset = await readAsset(id)
  if (!asset?.blob) return new Response('Not stored', { status: 404 })

  const size = asset.blob.size
  const headers = new Headers({
    'Content-Type': asset.mime || 'audio/mpeg',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  })

  const range = parseRange(request.headers.get('range'), size)

  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${size}`)
    return new Response(null, { status: 416, headers })
  }

  if (range === null) {
    headers.set('Content-Length', String(size))
    return new Response(request.method === 'HEAD' ? null : asset.blob, { status: 200, headers })
  }

  const length = range.end - range.start + 1
  headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
  headers.set('Content-Length', String(length))
  // blob.slice is lazy — this does not read the file into memory.
  const body = request.method === 'HEAD' ? null : asset.blob.slice(range.start, range.end + 1)
  return new Response(body, { status: 206, headers })
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return
  if (!url.pathname.startsWith(PREFIX)) return
  const id = decodeURIComponent(url.pathname.slice(PREFIX.length))
  event.respondWith(serve(event.request, id).catch((error) => new Response(String(error), { status: 500 })))
})
