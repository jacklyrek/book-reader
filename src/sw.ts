/// <reference lib="webworker" />
/**
 * Service worker: offline app shell + HTTP range server for offline media
 * (§7.3).
 *
 * The point of `/media/{assetId}` is that `audio.src` never touches a `blob:`
 * URL. Blob URLs pin the whole file in memory and seek badly on iOS. Going
 * through the SW gives us real 206 responses, so Safari seeks by asking for a
 * byte range like it would from any server, and the same code path serves both
 * streamed and downloaded audio.
 *
 * This file imports nothing that the main entry also imports, so Rollup emits a
 * single self-contained `sw.js` with no shared chunks. That means raw IndexedDB
 * rather than `idb`; the constants below must stay in sync with src/core/db.ts.
 */
import { parseRange } from './core/range'

declare const self: ServiceWorkerGlobalScope

const DB_NAME = 'pdr'
const ASSET_STORE = 'assets'
const MEDIA_PREFIX = '/media/'

const SHELL_CACHE = 'pdr-shell-v1'
const SHELL_URLS = ['/', '/index.html', '/manifest.webmanifest']

// ---------------------------------------------------------------------------
// Install / activate
// ---------------------------------------------------------------------------

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE)
      // Individually, so one 404 in dev doesn't fail the whole install.
      await Promise.all(
        SHELL_URLS.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})),
      )
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(names.filter((n) => n !== SHELL_CACHE).map((n) => caches.delete(n)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | undefined)?.type === 'SKIP_WAITING') {
    void self.skipWaiting()
  }
})

// ---------------------------------------------------------------------------
// IndexedDB, by hand
// ---------------------------------------------------------------------------

interface StoredAsset {
  assetId: string
  bookId: string
  kind: string
  blob: Blob
  bytes: number
  mime: string
}

let dbHandle: Promise<IDBDatabase | null> | null = null

function openDatabase(): Promise<IDBDatabase | null> {
  dbHandle ??= new Promise<IDBDatabase | null>((resolve) => {
    // No version: never trigger an upgrade from the worker. If the page hasn't
    // created the database yet there is nothing to serve anyway.
    const req = indexedDB.open(DB_NAME)
    req.onsuccess = () => {
      const database = req.result
      database.onclose = () => {
        dbHandle = null
      }
      database.onversionchange = () => {
        database.close()
        dbHandle = null
      }
      resolve(database)
    }
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
  return dbHandle
}

async function readAsset(assetId: string): Promise<StoredAsset | null> {
  const database = await openDatabase()
  if (!database || !database.objectStoreNames.contains(ASSET_STORE)) return null
  return new Promise<StoredAsset | null>((resolve) => {
    let tx: IDBTransaction
    try {
      tx = database.transaction(ASSET_STORE, 'readonly')
    } catch {
      resolve(null)
      return
    }
    const req = tx.objectStore(ASSET_STORE).get(assetId)
    req.onsuccess = () => resolve((req.result as StoredAsset | undefined) ?? null)
    req.onerror = () => resolve(null)
  })
}

// ---------------------------------------------------------------------------
// Range serving
// ---------------------------------------------------------------------------

function mediaHeaders(mime: string): Headers {
  return new Headers({
    'Content-Type': mime || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    // The bytes already live on this device; an HTTP cache layer on top would
    // just double the storage cost.
    'Cache-Control': 'no-store',
  })
}

async function serveMedia(request: Request, assetId: string): Promise<Response> {
  const asset = await readAsset(assetId)
  if (!asset || !asset.blob) {
    return new Response('Asset not downloaded', { status: 404, statusText: 'Not Found' })
  }

  const size = asset.blob.size
  const headers = mediaHeaders(asset.mime || asset.blob.type)
  const range = parseRange(request.headers.get('range'), size)

  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${size}`)
    return new Response(null, { status: 416, statusText: 'Range Not Satisfiable', headers })
  }

  if (range === null) {
    headers.set('Content-Length', String(size))
    const body = request.method === 'HEAD' ? null : asset.blob
    return new Response(body, { status: 200, headers })
  }

  const { start, end } = range
  const length = end - start + 1
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
  headers.set('Content-Length', String(length))
  // `slice` is lazy — this does not read the file into memory.
  const body = request.method === 'HEAD' ? null : asset.blob.slice(start, end + 1, asset.mime)
  return new Response(body, { status: 206, statusText: 'Partial Content', headers })
}

// ---------------------------------------------------------------------------
// Shell caching
// ---------------------------------------------------------------------------

function isDevAsset(url: URL): boolean {
  return (
    url.pathname.startsWith('/@') ||
    url.pathname.startsWith('/src/') ||
    url.pathname.startsWith('/node_modules/') ||
    url.searchParams.has('t')
  )
}

async function handleNavigation(request: Request): Promise<Response> {
  try {
    const fresh = await fetch(request)
    const cache = await caches.open(SHELL_CACHE)
    void cache.put('/', fresh.clone())
    return fresh
  } catch {
    const cached = (await caches.match('/')) ?? (await caches.match('/index.html'))
    return (
      cached ??
      new Response('<h1>Offline</h1><p>The app shell has not been cached yet.</p>', {
        status: 503,
        headers: { 'Content-Type': 'text/html' },
      })
    )
  }
}

/** Cache-first for hashed build assets, which are immutable by construction. */
async function handleAsset(request: Request): Promise<Response> {
  const cache = await caches.open(SHELL_CACHE)
  const cached = await cache.match(request)
  if (cached) return cached
  const fresh = await fetch(request)
  if (fresh.ok && fresh.status === 200) void cache.put(request, fresh.clone())
  return fresh
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  if (url.origin !== self.location.origin) return
  if (request.method !== 'GET' && request.method !== 'HEAD') return

  if (url.pathname.startsWith(MEDIA_PREFIX)) {
    const assetId = decodeURIComponent(url.pathname.slice(MEDIA_PREFIX.length))
    event.respondWith(
      serveMedia(request, assetId).catch(
        (error: unknown) =>
          new Response(`Media error: ${String(error)}`, { status: 500 }),
      ),
    )
    return
  }

  if (isDevAsset(url)) return

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request))
    return
  }

  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(handleAsset(request).catch(() => fetch(request)))
  }
})

export {}
