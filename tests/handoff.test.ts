/**
 * Chapter-level read↔listen handoff (§7.4 tier 1).
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { buildMapping, spineForTrack, trackForSpine } from '../src/player/handoff'
import type { AudioTrack } from '../src/core/types'

function tracks(titles: string[]): AudioTrack[] {
  return titles.map((title, index) => ({
    trackIndex: index,
    title,
    url: `https://archive.org/x_${index}_64kb.mp3`,
    seconds: 600,
  }))
}

test('equal counts map one to one', () => {
  const spine = [0, 1, 2, 3].map((index) => ({ index }))
  const mapping = buildMapping(spine, tracks(['a', 'b', 'c', 'd']))

  assert.equal(mapping.strategy, 'one-to-one')
  assert.equal(trackForSpine(mapping, 2), 2)
  assert.equal(spineForTrack(mapping, 3), 3)
})

test('titles are matched past LibriVox section-number noise', () => {
  // The EPUB has front matter the recording skips, so the counts differ and we
  // fall through to label matching.
  const spine = [
    { index: 0, label: 'Title Page' },
    { index: 1, label: 'Loomings' },
    { index: 2, label: 'The Carpet-Bag' },
    { index: 3, label: 'The Spouter-Inn' },
  ]
  const mapping = buildMapping(
    spine,
    tracks(['01 - Loomings', '02 - The Carpet-Bag', '03 - The Spouter-Inn']),
  )

  assert.equal(mapping.strategy, 'label-match')
  assert.equal(trackForSpine(mapping, 1), 0)
  assert.equal(trackForSpine(mapping, 3), 2)
  assert.equal(spineForTrack(mapping, 2), 3)
})

test('unlabelled mismatched counts fall back to proportional', () => {
  const spine = Array.from({ length: 10 }, (_, index) => ({ index }))
  const mapping = buildMapping(spine, tracks(['a', 'b', 'c', 'd', 'e']))

  assert.equal(mapping.strategy, 'proportional')
  assert.equal(trackForSpine(mapping, 0), 0)
  assert.equal(trackForSpine(mapping, 9), 4)
  // Confidence is deliberately low; the UI surfaces this to the user.
  assert.ok(mapping.confidence < 0.5)
})

test('an empty side degrades without throwing', () => {
  const mapping = buildMapping([], tracks(['a']))
  assert.equal(mapping.confidence, 0)
  assert.equal(trackForSpine(mapping, 5), 0)
  assert.equal(spineForTrack(mapping, 5), 0)
})

test('an unmapped spine index falls back to the nearest earlier chapter', () => {
  const spine = [
    { index: 0, label: 'Chapter One' },
    { index: 1, label: 'Chapter Two' },
    { index: 2, label: 'Appendix Nobody Recorded' },
  ]
  const mapping = buildMapping(spine, tracks(['01 - Chapter One', '02 - Chapter Two']))
  // The appendix has no recording; land at the last section that does.
  assert.equal(trackForSpine(mapping, 2), 1)
})
