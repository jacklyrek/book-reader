/**
 * The service worker's range parser (§7.3). This is the piece that decides
 * whether seeking a 300 MB audiobook is instant or downloads the file first, so
 * it gets tested properly.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { parseRange } from '../src/core/range'

const SIZE = 1000

test('no header means serve the whole entity', () => {
  assert.equal(parseRange(null, SIZE), null)
  assert.equal(parseRange(undefined, SIZE), null)
  assert.equal(parseRange('', SIZE), null)
})

test('closed ranges are inclusive on both ends', () => {
  assert.deepEqual(parseRange('bytes=0-99', SIZE), { start: 0, end: 99 })
  assert.deepEqual(parseRange('bytes=100-199', SIZE), { start: 100, end: 199 })
  assert.deepEqual(parseRange('bytes=0-0', SIZE), { start: 0, end: 0 })
})

test('open-ended ranges run to the last byte', () => {
  assert.deepEqual(parseRange('bytes=500-', SIZE), { start: 500, end: 999 })
  assert.deepEqual(parseRange('bytes=0-', SIZE), { start: 0, end: 999 })
})

test('suffix ranges count back from the end', () => {
  assert.deepEqual(parseRange('bytes=-100', SIZE), { start: 900, end: 999 })
  // A suffix longer than the entity is clamped, not an error.
  assert.deepEqual(parseRange('bytes=-5000', SIZE), { start: 0, end: 999 })
})

test('an end past the entity is clamped', () => {
  assert.deepEqual(parseRange('bytes=900-99999', SIZE), { start: 900, end: 999 })
})

test('unsatisfiable ranges are reported, not clamped', () => {
  // Start at or past the end must be a 416, otherwise media elements loop.
  assert.equal(parseRange('bytes=1000-', SIZE), 'unsatisfiable')
  assert.equal(parseRange('bytes=1500-1600', SIZE), 'unsatisfiable')
  assert.equal(parseRange('bytes=-0', SIZE), 'unsatisfiable')
  assert.equal(parseRange('bytes=-', SIZE), 'unsatisfiable')
  assert.equal(parseRange('bytes=0-99', 0), 'unsatisfiable')
})

test('inverted ranges are unsatisfiable', () => {
  assert.equal(parseRange('bytes=500-100', SIZE), 'unsatisfiable')
})

test('unparseable and multi-range headers fall back to a full response', () => {
  // A full 200 is a legal answer to a multi-range request, and no media element
  // sends one.
  assert.equal(parseRange('bytes=0-10,20-30', SIZE), null)
  assert.equal(parseRange('items=0-10', SIZE), null)
  assert.equal(parseRange('nonsense', SIZE), null)
})

test('whitespace around the header is tolerated', () => {
  assert.deepEqual(parseRange('  bytes=10-20  ', SIZE), { start: 10, end: 20 })
})

test('a typical seek-to-90% request resolves to the tail', () => {
  const bigFile = 300 * 1024 * 1024
  const start = Math.floor(bigFile * 0.9)
  assert.deepEqual(parseRange(`bytes=${start}-`, bigFile), {
    start,
    end: bigFile - 1,
  })
})
