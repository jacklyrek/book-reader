/**
 * HTTP byte-range parsing for the service worker's media server (§7.3).
 *
 * Kept in its own module so it can be unit tested without a ServiceWorker
 * global. It is imported *only* by src/sw.ts, so Rollup inlines it into the
 * single-file `sw.js` bundle rather than emitting a shared chunk.
 */

export interface ParsedRange {
  start: number
  end: number
}

/**
 * Parse a single `Range: bytes=…` header against a known entity size.
 *
 * - `null`            — no (or unparseable) range; caller should answer 200.
 * - `'unsatisfiable'` — caller must answer 416 with `Content-Range: bytes *\/size`.
 *
 * Multi-range requests (`bytes=0-10,20-30`) fall into the `null` case: serving
 * the full body is a legal response and no media element asks for them.
 */
export function parseRange(
  header: string | null | undefined,
  size: number,
): ParsedRange | null | 'unsatisfiable' {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null

  const rawStart = match[1] ?? ''
  const rawEnd = match[2] ?? ''
  if (rawStart === '' && rawEnd === '') return 'unsatisfiable'

  // A zero-length entity can satisfy no range at all.
  if (size <= 0) return 'unsatisfiable'

  let start: number
  let end: number

  if (rawStart === '') {
    // Suffix form: the final N bytes.
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 'unsatisfiable'
    if (start >= size) return 'unsatisfiable'
    end = Math.min(end, size - 1)
    if (end < start) return 'unsatisfiable'
  }

  return { start, end }
}
