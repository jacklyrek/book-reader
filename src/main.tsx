import { render } from 'preact'
import { App } from './app'
import { seedCuratedCollections } from './core/collections'
import { loadQueue, runQueue } from './core/downloads'
import { initPlayer } from './player/player'
import { startRouter } from './core/router'
import { loadSettings } from './core/settings'
import { requestPersistence, runAutoEviction } from './core/storage'
import { initAuth } from './core/supabase-client'
import { startSync } from './core/sync'
import './styles/app.css'

/**
 * Boot order matters:
 *   1. Settings, because everything reads them.
 *   2. The audio element, created once at boot and never replaced (§7.3).
 *   3. The service worker, which serves `/media/*` — without it, offline audio
 *      simply doesn't play.
 * Everything after that is best-effort and must not block first paint.
 */
async function boot(): Promise<void> {
  await loadSettings()
  initPlayer()
  startRouter()

  const root = document.getElementById('app')
  if (!root) throw new Error('#app is missing from index.html')
  render(<App />, root)

  void registerServiceWorker()

  // Installed home-screen apps are exempt from the 7-day script-writable
  // storage cap, but asking costs nothing and covers the browser-tab case.
  void requestPersistence()

  await loadQueue()
  void runQueue()
  void seedCuratedCollections()
  void initAuth().then(() => startSync())
  void runAutoEviction()
}

async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    console.warn('[sw] unsupported — offline media will not play')
    return
  }
  // In dev Vite serves the worker from source; the built file lands next to
  // index.html, which is the origin root or `/<repo>/` on a project site.
  const base = import.meta.env.BASE_URL
  const url = import.meta.env.DEV ? '/src/sw.ts' : `${base}sw.js`
  try {
    const registration = await navigator.serviceWorker.register(url, {
      type: 'module',
      // A worker can never claim a scope broader than its own directory, so on
      // a project site this is `/<repo>/` and every in-app URL must sit under it.
      scope: import.meta.env.DEV ? '/' : base,
    })
    if (registration.waiting) {
      registration.waiting.postMessage({ type: 'SKIP_WAITING' })
    }
  } catch (error) {
    console.error('[sw] registration failed', error)
  }
}

void boot()
