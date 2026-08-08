/**
 * Shared plumbing for the nightly ingest (§6.2).
 *
 * Runs with the service role key, so it must never be bundled into the app.
 * `npm run ingest` executes this tree with Node's built-in type stripping — no
 * build step for a job that runs on a schedule.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const URL = process.env['SUPABASE_URL'] ?? ''
const SERVICE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? ''

export function serviceClient(): SupabaseClient {
  if (!URL || !SERVICE_KEY) {
    throw new Error(
      'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running the ingest.',
    )
  }
  return createClient(URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export interface WorkRow {
  work_id: string
  title: string
  authors: string[]
  norm_title: string
  norm_author: string
  language: string
  subjects: string[]
  cover_url: string | null
  year: number | null
  description: string | null
  updated_at: string
}

export interface EditionRow {
  edition_id: string
  work_id: string
  source: 'standard-ebooks' | 'gutenberg' | 'archive'
  epub_url: string
  bytes: number | null
  language: string
  page_url: string | null
  translator: string | null
  updated_at: string
}

export interface RecordingRow {
  recording_id: string
  work_id: string
  source: string
  page_url: string | null
  total_seconds: number
  readers: string[]
  track_count: number
  bitrates: number[]
  tracks: unknown[]
  norm_title: string
  norm_author: string
  updated_at: string
}

const BATCH = 500

/** Upsert in batches; a single 75k-row statement will time out. */
export async function upsertBatched<T extends object>(
  client: SupabaseClient,
  table: string,
  rows: T[],
  conflictColumn: string,
): Promise<number> {
  let written = 0
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH)
    // The generated Supabase types are for a typed schema we don't generate
    // here; the row shapes above are the contract.
    const { error } = await client
      .from(table)
      .upsert(chunk as never, { onConflict: conflictColumn })
    if (error) throw new Error(`${table} upsert failed at row ${i}: ${error.message}`)
    written += chunk.length
    process.stdout.write(`\r  ${table}: ${written}/${rows.length}`)
  }
  if (rows.length > 0) process.stdout.write('\n')
  return written
}

/** Politeness delay. These are volunteer-run services; don't hammer them. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  attempts = 4,
): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        headers: {
          'User-Agent': 'PublicDomainReader-ingest/0.1',
          ...(init.headers ?? {}),
        },
      })
      if (response.status === 429 || response.status >= 500) {
        throw new Error(`HTTP ${response.status}`)
      }
      return response
    } catch (error) {
      lastError = error
      await sleep(2 ** attempt * 1000)
    }
  }
  throw new Error(`Failed after ${attempts} attempts: ${url} (${String(lastError)})`)
}

export const nowIso = (): string => new Date().toISOString()
