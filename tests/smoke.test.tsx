// @vitest-environment happy-dom
/**
 * Boot smoke test. Not a UI test — it exists to catch import-time and
 * first-render crashes across the whole screen tree, which is the failure mode
 * that would otherwise only show up on the phone.
 */
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { render } from 'preact'
import { afterEach, beforeAll, test, vi } from 'vitest'
import { App } from '../src/app'
import { putBook } from '../src/core/db'
import { navigate } from '../src/core/router'
import { loadSettings, settings } from '../src/core/settings'
import type { BookRecord } from '../src/core/types'

beforeAll(() => {
  // The search screen fetches a featured list on mount. Tests don't talk to the
  // network — and an in-flight request would be aborted at teardown anyway.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{"results":[]}', { headers: { 'Content-Type': 'application/json' } })),
  )
})

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30))

function mount(): HTMLElement {
  const root = document.createElement('div')
  document.body.append(root)
  render(<App />, root)
  return root
}

afterEach(() => {
  document.body.innerHTML = ''
})

test('settings load with defaults and a generated device id', async () => {
  const loaded = await loadSettings()
  assert.ok(loaded.deviceId.startsWith('dev_'))
  assert.equal(loaded.theme, 'paper')
  assert.equal(settings.get().deviceId, loaded.deviceId)
})

test('the library screen renders its empty state without a library', async () => {
  navigate({ name: 'library' })
  const root = mount()
  await flush()

  assert.match(root.textContent ?? '', /Nothing on the shelf yet/)
  // The tab bar is the app frame; if it's missing, App itself failed.
  assert.equal(root.querySelectorAll('.tab').length, 5)
})

test('a book on the shelf renders as a row', async () => {
  const book: BookRecord = {
    bookId: 'gutenberg:2701',
    title: 'Moby Dick',
    authors: ['Herman Melville'],
    language: 'en',
    subjects: [],
    addedAt: Date.now(),
    updatedAt: Date.now(),
  }
  await putBook(book)

  navigate({ name: 'library' })
  const root = mount()
  await flush()

  assert.match(root.textContent ?? '', /Moby Dick/)
  assert.match(root.textContent ?? '', /Herman Melville/)
})

test('every chrome route renders without throwing', async () => {
  for (const route of [
    { name: 'search', query: '' },
    { name: 'downloads' },
    { name: 'storage' },
    { name: 'settings' },
    { name: 'collections' },
    { name: 'annotations', bookId: 'gutenberg:2701' },
  ] as const) {
    navigate(route)
    const root = mount()
    await flush()
    assert.ok((root.textContent ?? '').length > 0, `${route.name} rendered nothing`)
    render(null, root)
    root.remove()
  }
})

test('the now-playing bar stays hidden until something is loaded', async () => {
  navigate({ name: 'library' })
  const root = mount()
  await flush()
  assert.equal(root.querySelector('.now-playing'), null)
})
