/**
 * Client half of the CORS proxy (§6.1). The Worker half is in worker/src/index.ts.
 *
 * Most public domain sources predate anyone fetching them from a browser:
 * gutenberg.org and the LibriVox API send no `Access-Control-Allow-Origin`.
 * archive.org does, so audio files — the big ones — go direct and never touch
 * our bandwidth.
 */
import type { SourceId } from '../core/types'

const PROXY_BASE = (import.meta.env.VITE_PROXY_BASE as string | undefined)?.replace(/\/$/, '') ?? ''
const HMAC_KEY = (import.meta.env.VITE_PROXY_HMAC_KEY as string | undefined) ?? ''

/** Hosts that answer CORS preflight correctly and can be fetched directly. */
const DIRECT_HOSTS = new Set([
  'archive.org',
  'www.archive.org',
  'ia800000.us.archive.org',
  'gutendex.com',
  'covers.openlibrary.org',
  'openlibrary.org',
])

const HOST_SOURCE: [RegExp, SourceId][] = [
  [/(^|\.)gutenberg\.org$/, 'gutenberg'],
  [/(^|\.)librivox\.org$/, 'librivox'],
  [/(^|\.)standardebooks\.org$/, 'standard-ebooks'],
  [/(^|\.)archive\.org$/, 'archive'],
  [/(^|\.)openlibrary\.org$/, 'openlibrary'],
]

export function sourceForUrl(url: string): SourceId | null {
  try {
    const { hostname } = new URL(url)
    for (const [pattern, source] of HOST_SOURCE) {
      if (pattern.test(hostname)) return source
    }
  } catch {
    /* not a URL */
  }
  return null
}

export function needsProxy(url: string): boolean {
  try {
    const { hostname } = new URL(url)
    if (DIRECT_HOSTS.has(hostname)) return false
    // archive.org's download CDN uses per-node hostnames (iaXXXXXX.us.archive.org).
    if (/\.us\.archive\.org$/.test(hostname)) return false
    return sourceForUrl(url) !== null
  } catch {
    return false
  }
}

let hmacKeyPromise: Promise<CryptoKey> | null = null

function importHmacKey(): Promise<CryptoKey> {
  hmacKeyPromise ??= crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(HMAC_KEY),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return hmacKeyPromise
}

function base64url(bytes: ArrayBuffer): string {
  let binary = ''
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Sign the proxy path so the Worker rejects URLs it did not mint.
 *
 * Note this is not a real secret — it ships in the client bundle. It raises the
 * cost of turning the Worker into an open proxy for a passer-by; the load
 * bearing controls are the host allowlist and the `Origin` check.
 */
async function sign(payload: string): Promise<string> {
  const key = await importHmacKey()
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return base64url(mac)
}

/**
 * Rewrite `url` to go through the proxy when the origin needs it. Returns the
 * URL unchanged when a direct fetch works, so callers can use this
 * unconditionally.
 */
export async function proxied(url: string): Promise<string> {
  if (!needsProxy(url)) return url
  if (!PROXY_BASE) {
    console.warn(
      `[proxy] ${new URL(url).hostname} needs a proxy but VITE_PROXY_BASE is unset; ` +
        'this fetch will fail CORS.',
    )
    return url
  }
  const source = sourceForUrl(url) ?? 'archive'
  const payload = `${source}/${encodeURIComponent(url)}`
  const target = `${PROXY_BASE}/p/${payload}`
  if (!HMAC_KEY) return target
  return `${target}?sig=${await sign(payload)}`
}

export interface FetchOptions extends RequestInit {
  /** Milliseconds before the request is aborted. Defaults to 30s. */
  timeoutMs?: number
}

/** `fetch`, routed through the proxy when needed, with a timeout. */
export async function fetchSource(url: string, options: FetchOptions = {}): Promise<Response> {
  const { timeoutMs = 30_000, signal, ...rest } = options
  const target = await proxied(url)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort)
  try {
    return await fetch(target, { ...rest, signal: controller.signal })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

export async function fetchJson<T>(url: string, options?: FetchOptions): Promise<T> {
  const response = await fetchSource(url, options)
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`)
  return (await response.json()) as T
}

export async function fetchXml(url: string, options?: FetchOptions): Promise<Document> {
  const response = await fetchSource(url, options)
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`)
  const text = await response.text()
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  const error = doc.querySelector('parsererror')
  if (error) throw new Error(`Malformed XML from ${url}`)
  return doc
}

export const proxyConfigured = Boolean(PROXY_BASE)
