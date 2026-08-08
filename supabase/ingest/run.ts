/**
 * Nightly catalog ingest (§6.2).
 *
 *   npm run ingest -- --source=all
 *   npm run ingest -- --source=librivox --limit=200
 *   npm run ingest -- --source=match
 *
 * Sources are independent: a LibriVox outage should not stop Gutenberg from
 * refreshing. Matching runs last, in Postgres.
 */
import { serviceClient, upsertBatched, type EditionRow, type RecordingRow, type WorkRow } from './client.ts'
import { ingestGutenberg } from './gutenberg.ts'
import { ingestLibriVox } from './librivox.ts'
import { ingestStandardEbooks } from './standardebooks.ts'

type Source = 'gutenberg' | 'standardebooks' | 'librivox' | 'match' | 'all'

function parseArgs(): { source: Source; limit?: number } {
  const args = process.argv.slice(2)
  const get = (name: string): string | undefined =>
    args.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1]
  const source = (get('source') ?? 'all') as Source
  const limitRaw = get('limit')
  return { source, limit: limitRaw ? Number(limitRaw) : undefined }
}

async function main(): Promise<void> {
  const { source, limit } = parseArgs()
  const client = serviceClient()
  const started = Date.now()

  const works: WorkRow[] = []
  const editions: EditionRow[] = []
  const recordings: RecordingRow[] = []

  const wants = (name: Source): boolean => source === 'all' || source === name

  if (wants('standardebooks')) {
    console.log('Standard Ebooks…')
    try {
      const result = await ingestStandardEbooks()
      works.push(...result.works)
      editions.push(...result.editions)
      console.log(
        `  ${result.works.length} works${result.degraded ? ' (degraded: public feed only)' : ''}`,
      )
    } catch (error) {
      console.error('  failed:', error)
    }
  }

  if (wants('gutenberg')) {
    console.log('Project Gutenberg…')
    try {
      const result = await ingestGutenberg({ limit })
      works.push(...result.works)
      editions.push(...result.editions)
      console.log(`  ${result.works.length} works`)
    } catch (error) {
      console.error('  failed:', error)
    }
  }

  if (wants('librivox')) {
    console.log('LibriVox…')
    try {
      const result = await ingestLibriVox({ limit })
      works.push(...result.works)
      recordings.push(...result.recordings)
      console.log(`  ${result.recordings.length} recordings`)
    } catch (error) {
      console.error('  failed:', error)
    }
  }

  if (works.length > 0) {
    console.log('Writing works…')
    await upsertBatched(client, 'works', works, 'work_id')
  }
  if (editions.length > 0) {
    console.log('Writing editions…')
    await upsertBatched(client, 'editions', editions, 'edition_id')
  }
  if (recordings.length > 0) {
    console.log('Writing recordings…')
    await upsertBatched(client, 'recordings', recordings, 'recording_id')
  }

  if (wants('match') || source === 'all') {
    console.log('Matching text ↔ audio…')
    const { data, error } = await client.rpc('rebuild_edition_links', {
      p_threshold: 0.72,
      p_title_weight: 0.7,
    })
    if (error) {
      console.error('  matching failed:', error.message)
    } else {
      const row = (data as { links_created: number; overrides_applied: number }[] | null)?.[0]
      console.log(`  ${row?.links_created ?? 0} links, ${row?.overrides_applied ?? 0} overrides`)
    }
  }

  console.log(`Done in ${Math.round((Date.now() - started) / 1000)}s`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
