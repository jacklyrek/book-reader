/**
 * Progress conflict resolution (§6.3).
 *
 * Last-write-wins, except that near-simultaneous writes resolve to the
 * *furthest* position — otherwise a stale tab that syncs late rewinds you.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mergeProgress, overallPercent, PROGRESS_TIE_WINDOW_MS } from '../src/core/progress'
import type { ProgressRecord } from '../src/core/types'

const BASE = 1_700_000_000_000

function record(patch: Partial<ProgressRecord> = {}): ProgressRecord {
  return {
    bookId: 'gutenberg:2701',
    percent: 0,
    updatedAt: BASE,
    deviceId: 'phone',
    ...patch,
  }
}

test('a missing side is not a conflict', () => {
  const only = record({ percent: 0.4 })
  assert.equal(mergeProgress(undefined, only), only)
  assert.equal(mergeProgress(only, undefined), only)
  assert.equal(mergeProgress(undefined, undefined), undefined)
})

test('a clearly later write wins even if it is behind', () => {
  const local = record({ percent: 0.8, updatedAt: BASE })
  const remote = record({
    percent: 0.2,
    updatedAt: BASE + PROGRESS_TIE_WINDOW_MS + 60_000,
    deviceId: 'mac',
  })
  // You really did go back to chapter two an hour later.
  assert.equal(mergeProgress(local, remote)?.percent, 0.2)
})

test('concurrent writes resolve to the furthest position', () => {
  const local = record({ percent: 0.55, updatedAt: BASE })
  const remote = record({ percent: 0.62, updatedAt: BASE + 60_000, deviceId: 'mac' })
  assert.equal(mergeProgress(local, remote)?.percent, 0.62)
})

test('a stale tab syncing late cannot rewind you', () => {
  // The phone is at 62%. The Mac's forgotten tab flushes 10% a minute later.
  const local = record({ percent: 0.62, updatedAt: BASE })
  const stale = record({ percent: 0.1, updatedAt: BASE + 60_000, deviceId: 'mac-stale-tab' })
  const merged = mergeProgress(local, stale)
  assert.equal(merged?.percent, 0.62)
  // The merged row carries the later timestamp so it beats both parents.
  assert.equal(merged?.updatedAt, BASE + 60_000)
})

test('audio position counts toward "furthest"', () => {
  const reading = record({ percent: 0.3, updatedAt: BASE })
  const listening = record({
    percent: 0,
    audioPercent: 0.7,
    trackIndex: 12,
    positionSec: 300,
    updatedAt: BASE + 10_000,
    deviceId: 'phone-2',
  })
  const merged = mergeProgress(reading, listening)
  assert.equal(merged?.audioPercent, 0.7)
  assert.equal(merged?.trackIndex, 12)
})

test('the tie window boundary is exclusive of later writes', () => {
  const local = record({ percent: 0.9, updatedAt: BASE })
  const justInside = record({
    percent: 0.1,
    updatedAt: BASE + PROGRESS_TIE_WINDOW_MS,
    deviceId: 'mac',
  })
  assert.equal(mergeProgress(local, justInside)?.percent, 0.9, 'inside the window: furthest wins')

  const justOutside = record({
    percent: 0.1,
    updatedAt: BASE + PROGRESS_TIE_WINDOW_MS + 1,
    deviceId: 'mac',
  })
  assert.equal(mergeProgress(local, justOutside)?.percent, 0.1, 'outside the window: latest wins')
})

test('overall progress takes the better of reading and listening', () => {
  assert.equal(overallPercent(record({ percent: 0.4, audioPercent: 0.1 })), 0.4)
  assert.equal(overallPercent(record({ percent: 0.1, audioPercent: 0.4 })), 0.4)
  assert.equal(overallPercent(undefined), 0)
})
