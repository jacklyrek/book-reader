// @vitest-environment happy-dom
/**
 * Search across the two things a reader actually types — a title or an author —
 * and the third thing a curated shelf asks for, which is both at once (§6.2,
 * §10).
 *
 * These pin down the quirks that made author search silently useless: LibriVox
 * matches per field rather than over free text, Gutendex ANDs every term of a
 * free-text query, and both catalogs file names and titles differently from the
 * way a canon list writes them.
 */
import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import { attemptsFor, scoreResult } from '../src/catalog/adapter'
import { searchLibriVox } from '../src/catalog/librivox'
import { surname } from '../src/core/ids'
import { hrefFor } from '../src/core/router'
import type { CatalogWork } from '../src/core/types'

function work(title: string, authors: string[], kind: 'text' | 'audio' | 'both'): CatalogWork {
  return {
    workId: `${kind}:${title}`,
    title,
    authors,
    language: 'en',
    subjects: [],
    editions:
      kind === 'audio'
        ? []
        : [
            {
              editionId: title,
              source: 'gutenberg',
              epubUrl: 'https://example.com/x.epub',
              language: 'en',
            },
          ],
    recordings:
      kind === 'text'
        ? []
        : [
            {
              recordingId: title,
              source: 'librivox',
              totalSeconds: 3600,
              readers: ['A Reader'],
              tracks: [],
              trackCount: 10,
            },
          ],
  }
}

const rank = (works: CatalogWork[], query: string, author?: string): string[] =>
  [...works]
    .sort((a, b) => scoreResult(b, query, author) - scoreResult(a, query, author))
    .map((w) => w.title)

test('a surname is what both catalogs agree on', () => {
  assert.equal(surname('Herman Melville'), 'Melville')
  assert.equal(surname('Melville, Herman'), 'Melville')
  assert.equal(surname('Jean-Jacques Rousseau'), 'Rousseau')
  assert.equal(surname('Michel de Montaigne'), 'Montaigne')
  // Single-name authors have to survive intact.
  assert.equal(surname('Homer'), 'Homer')
  assert.equal(surname('Montesquieu'), 'Montesquieu')
})

test('a plain query is asked once, exactly as typed', () => {
  assert.deepEqual(attemptsFor('Moby Dick'), [['Moby Dick']])
  assert.deepEqual(attemptsFor('Moby Dick', '  '), [['Moby Dick']])
})

test('a title-and-author query widens instead of coming back empty', () => {
  // "The Symposium Plato" matches nothing anywhere: Gutenberg files it as plain
  // "Symposium", so requiring "the", "symposium" and "plato" together fails.
  assert.deepEqual(attemptsFor('The Symposium', 'Plato'), [
    ['The Symposium Plato'],
    // Both loose queries, because the catalogs disagree on both sides: only the
    // author finds "Symposium", and only the title finds "The Brothers
    // Karamazov" under Gutenberg's "Dostoyevsky".
    ['The Symposium', 'Plato'],
  ])
})

test('a shelf entry whose author is its title asks once', () => {
  assert.deepEqual(attemptsFor('', 'Homer'), [['Homer']])
})

test('searching an author surfaces their books, not books about them', () => {
  const shelf = [
    work('Herman Melville, Mariner and Mystic', ['Raymond M. Weaver'], 'text'),
    work('Index of the Project Gutenberg Works of Herman Melville', ['Herman Melville'], 'text'),
    work('Typee: A Romance of the South Seas', ['Herman Melville'], 'both'),
  ]
  assert.equal(rank(shelf, 'Melville')[0], 'Typee: A Romance of the South Seas')
})

test('a title that merely opens with a name loses to that person’s work', () => {
  const shelf = [
    work('Jane Austen and Her Times', ['G. E. Mitton'], 'text'),
    work('Pride and Prejudice', ['Jane Austen'], 'both'),
  ]
  assert.equal(rank(shelf, 'Jane Austen')[0], 'Pride and Prejudice')
})

test('an exact title still beats an author reading of the same words', () => {
  const shelf = [
    work('Typee', ['Herman Melville'], 'both'),
    work('Herman Melville', ['Lewis Mumford'], 'text'),
  ]
  assert.equal(rank(shelf, 'Herman Melville')[0], 'Herman Melville')
})

test('a title query is not derailed by the author axis', () => {
  const shelf = [
    work('Moby Dick; Or, The Whale', ['Herman Melville'], 'both'),
    work('Typee', ['Herman Melville'], 'both'),
  ]
  assert.equal(rank(shelf, 'Moby Dick')[0], 'Moby Dick; Or, The Whale')
})

test('a named author picks the wanted title out of a widened result set', () => {
  // What the widened rung returns for "The Symposium" / Plato: everything by
  // Plato, titled the way Gutenberg titles it.
  const byPlato = [
    work('Apology', ['Plato'], 'text'),
    work('Symposium', ['Plato'], 'text'),
    work('Phaedrus', ['Plato'], 'text'),
  ]
  assert.equal(rank(byPlato, 'The Symposium', 'Plato')[0], 'Symposium')
})

test('a named author outranks the right title by the wrong person', () => {
  const shelf = [
    work('The Republic of the Future', ['Anna Bowman Dodd'], 'text'),
    work('The Republic', ['Plato'], 'text'),
  ]
  assert.equal(rank(shelf, 'The Republic', 'Plato')[0], 'The Republic')
})

// --- LibriVox query building ------------------------------------------------

let requested: string[] = []

afterEach(() => {
  requested = []
  vi.unstubAllGlobals()
})

function captureFetch(): void {
  requested = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      requested.push(String(url))
      return new Response('{"books":[]}', { headers: { 'Content-Type': 'application/json' } })
    }),
  )
}

test('LibriVox is asked for a title without its leading article', async () => {
  captureFetch()
  await searchLibriVox({ title: 'The Odyssey' })
  // LibriVox catalogues it as "Odyssey"; `^The Odyssey` matches nothing at all.
  assert.match(requested[0] ?? '', /title=%5EOdyssey/)
  assert.doesNotMatch(requested[0] ?? '', /The\+Odyssey|%5EThe/)
})

test('LibriVox is asked for an author by surname', async () => {
  captureFetch()
  await searchLibriVox({ author: 'Herman Melville' })
  // The author field is indexed on the surname; `^Herman Melville` is an error.
  assert.match(requested[0] ?? '', /author=%5EMelville/)
})

// --- routing ----------------------------------------------------------------

test('a search route carries its author as its own field', () => {
  // Glued into the query string it reads as a title no catalog has.
  assert.equal(
    hrefFor({ name: 'search', query: 'The Prince', author: 'Niccolo Machiavelli' }),
    '#/search?q=The%20Prince&a=Niccolo%20Machiavelli',
  )
  assert.equal(hrefFor({ name: 'search', query: 'moby dick' }), '#/search?q=moby%20dick')
})
