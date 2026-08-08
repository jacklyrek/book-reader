import { db, getSetting, setSetting } from './db'
import { uid } from './ids'
import { createStore } from './store'
import type { Settings } from './types'

export const DEFAULT_SETTINGS: Settings = {
  deviceId: '',
  theme: 'paper',
  fontSize: 19,
  fontFamily: 'Literata, Georgia, serif',
  lineHeight: 1.6,
  margin: 24,
  justify: true,
  hyphenate: true,
  flow: 'paginated',
  audioBitrate: 64,
  skipBackSeconds: 15,
  skipForwardSeconds: 30,
  cellularWarn: true,
  largeDownloadWarnMb: 200,
  autoEvictFinishedDays: null,
  narratorBlocklist: [],
}

export const settings = createStore<Settings>(DEFAULT_SETTINGS)

export async function loadSettings(): Promise<Settings> {
  const database = await db()
  const tx = database.transaction('settings', 'readonly')
  const store = tx.objectStore('settings')
  const loaded: Partial<Settings> = {}
  for await (const cursor of store.iterate()) {
    loaded[cursor.key as keyof Settings] = cursor.value as never
  }
  await tx.done

  let deviceId = loaded.deviceId
  if (!deviceId) {
    deviceId = uid('dev')
    await setSetting('deviceId', deviceId)
  }

  const merged = { ...DEFAULT_SETTINGS, ...loaded, deviceId }
  settings.set(merged)
  return merged
}

export async function updateSetting<K extends keyof Settings>(
  key: K,
  value: Settings[K],
): Promise<void> {
  settings.set((prev) => ({ ...prev, [key]: value }))
  await setSetting(key, value)
}

export async function deviceId(): Promise<string> {
  const current = settings.get().deviceId
  if (current) return current
  const stored = await getSetting('deviceId')
  if (stored) return stored
  const fresh = uid('dev')
  await setSetting('deviceId', fresh)
  settings.set((prev) => ({ ...prev, deviceId: fresh }))
  return fresh
}
