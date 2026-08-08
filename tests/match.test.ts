/**
 * Title/author normalisation and text↔audio matching (§6.2).
 *
 * The design expects this to be wrong about 10% of the time. These tests pin
 * down the cases it must not get wrong.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { normalizeAuthor, normalizeTitle } from '../src/core/ids'
import {
  authorSimilarity,
  matchScore,
  mergeWorks,
  similarity,
  MATCH_THRESHOLD,
} from '../src/catalog/match'
import type { CatalogWork } from '../src/core/types'

function work(title: string, authors: string[], kind: 'text' | 'audio'): CatalogWork {
  return {
    workId: `${kind}:${title}`,
    title,
    authors,
    language: 'en',
    subjects: [],
    editions:
      kind === 'text'
        ? [
            {
              editionId: title,
              source: 'gutenberg',
              epubUrl: 'https://example.com/x.epub',
              language: 'en',
            },
          ]
        : [],
    recordings:
      kind === 'audio'
        ? [
            {
              recordingId: title,
              source: 'librivox',
              totalSeconds: 3600,
              readers: ['A Reader'],
              tracks: [],
              trackCount: 10,
            },
          ]
        : [],
  }
}

test('titles normalise past subtitles and leading articles', () => {
  assert.equal(normalizeTitle('Moby Dick; Or, The Whale'), 'moby dick')
  assert.equal(normalizeTitle('The Count of Monte Cristo'), 'count of monte cristo')
  assert.equal(normalizeTitle('A Tale of Two Cities'), 'tale of two cities')
  assert.equal(normalizeTitle('Les Misérables'), 'les miserables')
})

test('authors normalise across the two catalog conventions', () => {
  assert.equal(normalizeAuthor('Melville, Herman'), 'herman melville')
  assert.equal(normalizeAuthor('Herman Melville'), 'herman melville')
  assert.equal(normalizeAuthor('Dumas, Alexandre (père)'), 'alexandre dumas')
})

test('similarity is 1 for identical strings and 0 for disjoint ones', () => {
  assert.equal(similarity('moby dick', 'moby dick'), 1)
  assert.ok(similarity('moby dick', 'war and peace') < 0.2)
})

test('any author in common counts', () => {
  assert.equal(authorSimilarity(['Herman Melville'], ['Melville, Herman']), 1)
  assert.ok(authorSimilarity(['Charles Dickens', 'Wilkie Collins'], ['Wilkie Collins']) > 0.95)
  assert.equal(authorSimilarity([], ['Anyone']), 0)
})

test('the same book under two catalog conventions scores above threshold', () => {
  const text = work('Moby Dick; Or, The Whale', ['Melville, Herman'], 'text')
  const audio = work('Moby Dick', ['Herman Melville'], 'audio')
  assert.ok(matchScore(text, audio) >= MATCH_THRESHOLD)
})

test('different books by the same author stay below threshold', () => {
  const text = work('Great Expectations', ['Charles Dickens'], 'text')
  const audio = work('A Tale of Two Cities', ['Charles Dickens'], 'audio')
  assert.ok(matchScore(text, audio) < MATCH_THRESHOLD)
})

test('a perfect title with a wrong author still matches', () => {
  // LibriVox author fields are volunteer-entered; a title match carries most of
  // the weight for exactly this reason.
  const text = work('The Odyssey', ['Homer'], 'text')
  const audio = work('The Odyssey', ['Butler, Samuel'], 'audio')
  assert.ok(matchScore(text, audio) >= MATCH_THRESHOLD)
})

test('mergeWorks attaches audio to text and keeps orphans', () => {
  const texts = [
    work('Moby Dick; Or, The Whale', ['Melville, Herman'], 'text'),
    work('Middlemarch', ['George Eliot'], 'text'),
  ]
  const audios = [
    work('Moby Dick', ['Herman Melville'], 'audio'),
    work('The Wind in the Willows', ['Kenneth Grahame'], 'audio'),
  ]

  const merged = mergeWorks(texts, audios)

  const moby = merged.find((w) => w.title.startsWith('Moby Dick;'))
  assert.ok(moby, 'the text work survives')
  assert.equal(moby.recordings.length, 1, 'audio folded into the text work')
  assert.ok((moby.matchConfidence ?? 0) >= MATCH_THRESHOLD)

  const middlemarch = merged.find((w) => w.title === 'Middlemarch')
  assert.equal(middlemarch?.recordings.length, 0, 'unmatched text keeps no audio')

  // An audio-only recording is still worth listening to, so it survives as its
  // own work rather than being dropped.
  assert.ok(merged.some((w) => w.title === 'The Wind in the Willows'))
  assert.equal(merged.length, 3)
})

test('one recording is claimed by at most one work', () => {
  const texts = [
    work('The Odyssey', ['Homer'], 'text'),
    work('The Odyssey', ['Homer'], 'text'),
  ]
  const audios = [work('The Odyssey', ['Homer'], 'audio')]
  const merged = mergeWorks(texts, audios)
  const withAudio = merged.filter((w) => w.recordings.length > 0)
  assert.equal(withAudio.length, 1)
})
