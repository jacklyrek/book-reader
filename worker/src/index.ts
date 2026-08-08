/**
 * CORS proxy (§6.1).
 *
 * Most public domain sources were not built for browser fetching: neither
 * gutenberg.org nor the LibriVox API sends `Access-Control-Allow-Origin`.
 * archive.org does, so the big files — the audio — go direct and never cross
 * this Worker.
 *
 * Design rules, all enforced below:
 *   - Allowlist target hosts. Never a general open proxy.
 *   - Restrict `Origin` to our own app.
 *   - Optionally require an HMAC signature on URLs the app minted.
 *   - Cache aggressively. Gutenberg EPUBs are immutable.
 *   - Stream through, passing `Range` upstream and back.
 */

export interface Env {
  /** Comma-separated list of origins allowed to call the proxy. */
  ALLOWED_ORIGINS: string
  /** Shared secret matching the client's VITE_PROXY_HMAC_KEY. */
  PROXY_HMAC_KEY?: string
  /** "false" disables signature checking (dev only). */
  REQUIRE_SIGNATURE?: string
  /**
   * Standard Ebooks' bulk OPDS feed is behind HTTP Basic auth (Patrons Circle
   * email as the username, empty password). Held here so the credential never
   * ships in the client bundle. Format: "email@example.com".
   */
  SE_OPDS_EMAIL?: string
}

/** Hosts we will fetch on the client's behalf, and nothing else. */
const ALLOWED_HOSTS = new Set([
  'gutenberg.org',
  'www.gutenberg.org',
  'gutendex.com',
  'librivox.org',
  'www.librivox.org',
  'standardebooks.org',
  'www.standardebooks.org',
  'archive.org',
  'www.archive.org',
  'openlibrary.org',
  'covers.openlibrary.org',
])

/** archive.org hands out per-node download hostnames. */
const ALLOWED_HOST_PATTERNS = [/^ia\d+\.us\.archive\.org$/, /^[a-z0-9-]+\.us\.archive\.org$/]

const MAX_UPSTREAM_BYTES = 600 * 1024 * 1024

function hostAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return ALLOWED_HOSTS.has(host) || ALLOWED_HOST_PATTERNS.some((pattern) => pattern.test(host))
}

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
}

function corsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers()
  const origin = request.headers.get('Origin')
  const allowed = allowedOrigins(env)
  if (origin && allowed.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set('Vary', 'Origin')
  }
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
  headers.set('Access-Control-Allow-Headers', 'Range, Content-Type')
  // Without this the client can't read Content-Range and resume a download.
  headers.set(
    'Access-Control-Expose-Headers',
    'Content-Length, Content-Range, Accept-Ranges, ETag, Content-Type',
  )
  headers.set('Access-Control-Max-Age', '86400')
  return headers
}

function originAllowed(request: Request, env: Env): boolean {
  const allowed = allowedOrigins(env)
  if (allowed.length === 0) return true // unconfigured: fail open in dev only
  const origin = request.headers.get('Origin')
  if (origin) return allowed.includes(origin)
  // Same-origin navigations and curl send no Origin; fall back to Referer so
  // an `<img src>` from our own page still works.
  const referer = request.headers.get('Referer')
  if (referer) {
    try {
      return allowed.includes(new URL(referer).origin)
    } catch {
      return false
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

function base64url(bytes: ArrayBuffer): string {
  let binary = ''
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return base64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)))
}

/** Constant-time-ish comparison. Signatures are short; avoid the early exit. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const cors = corsHeaders(request, env)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }

    if (url.pathname === '/health') {
      return new Response('ok', { status: 200, headers: cors })
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: cors })
    }

    // Route: /p/{source}/{encoded-url}
    const match = /^\/p\/([a-z-]+)\/(.+)$/.exec(url.pathname)
    if (!match) {
      return new Response('Not found', { status: 404, headers: cors })
    }

    if (!originAllowed(request, env)) {
      return new Response('Forbidden origin', { status: 403, headers: cors })
    }

    const source = match[1] as string
    const encodedTarget = match[2] as string
    const payload = `${source}/${encodedTarget}`

    const requireSignature = env.REQUIRE_SIGNATURE !== 'false' && Boolean(env.PROXY_HMAC_KEY)
    if (requireSignature) {
      const provided = url.searchParams.get('sig') ?? ''
      const expected = await sign(payload, env.PROXY_HMAC_KEY as string)
      if (!safeEqual(provided, expected)) {
        return new Response('Bad signature', { status: 403, headers: cors })
      }
    }

    let target: URL
    try {
      target = new URL(decodeURIComponent(encodedTarget))
    } catch {
      return new Response('Malformed target URL', { status: 400, headers: cors })
    }

    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      return new Response('Unsupported protocol', { status: 400, headers: cors })
    }
    if (!hostAllowed(target.hostname)) {
      return new Response(`Host not allowed: ${target.hostname}`, { status: 403, headers: cors })
    }

    return proxy(request, target, env, ctx, cors)
  },
} satisfies ExportedHandler<Env>

async function proxy(
  request: Request,
  target: URL,
  env: Env,
  ctx: ExecutionContext,
  cors: Headers,
): Promise<Response> {
  const range = request.headers.get('Range')

  const upstreamHeaders = new Headers({
    // Some of these sites 403 an empty UA.
    'User-Agent': 'PublicDomainReader/0.1 (+https://github.com/)',
    Accept: '*/*',
  })
  if (range) upstreamHeaders.set('Range', range)

  // Standard Ebooks' bulk feeds need the Patrons Circle credential. It lives
  // here, in the Worker, and never reaches the browser.
  if (
    env.SE_OPDS_EMAIL &&
    target.hostname.endsWith('standardebooks.org') &&
    target.pathname.startsWith('/feeds/')
  ) {
    upstreamHeaders.set('Authorization', `Basic ${btoa(`${env.SE_OPDS_EMAIL}:`)}`)
  }

  // Cache only whole-object GETs. Caching range responses correctly is more
  // trouble than it saves, and the big ranged fetches are audio from
  // archive.org, which the client fetches directly anyway.
  const cacheable = request.method === 'GET' && !range
  const cache = caches.default
  const cacheKey = new Request(target.toString(), { method: 'GET' })

  if (cacheable) {
    const hit = await cache.match(cacheKey)
    if (hit) return withCors(hit, cors, 'HIT')
  }

  let upstream: Response
  try {
    upstream = await fetch(target.toString(), {
      method: request.method,
      headers: upstreamHeaders,
      redirect: 'follow',
    })
  } catch (error) {
    return new Response(`Upstream fetch failed: ${String(error)}`, { status: 502, headers: cors })
  }

  const length = Number(upstream.headers.get('content-length'))
  if (Number.isFinite(length) && length > MAX_UPSTREAM_BYTES) {
    return new Response('Upstream response too large', { status: 502, headers: cors })
  }

  if (cacheable && upstream.ok) {
    const toCache = new Response(upstream.body, upstream)
    // Gutenberg EPUBs and LibriVox metadata are effectively immutable; a day of
    // edge caching costs nothing and takes real load off both projects.
    toCache.headers.set('Cache-Control', 'public, max-age=86400')
    const [forCache, forClient] = tee(toCache)
    ctx.waitUntil(cache.put(cacheKey, forCache))
    return withCors(forClient, cors, 'MISS')
  }

  return withCors(upstream, cors, range ? 'RANGE' : 'BYPASS')
}

function tee(response: Response): [Response, Response] {
  if (!response.body) {
    return [response.clone(), response]
  }
  const [a, b] = response.body.tee()
  return [
    new Response(a, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    new Response(b, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
  ]
}

function withCors(response: Response, cors: Headers, cacheStatus: string): Response {
  const headers = new Headers(response.headers)
  for (const [key, value] of cors) headers.set(key, value)
  headers.set('X-Proxy-Cache', cacheStatus)
  // Upstream cookies are never useful to us and shouldn't reach the client.
  headers.delete('set-cookie')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
