import type { JSX } from 'preact'
import { useState } from 'preact/hooks'
import { proxyConfigured } from '../catalog/proxy'
import { catalog } from '../catalog/index'
import { settings, updateSetting } from '../core/settings'
import { useStore } from '../core/store'
import { authState, signInWithEmail, signOut, supabaseConfigured } from '../core/supabase-client'
import { fullResync, syncNow, syncState } from '../core/sync'
import { SegmentedControl, Slider, Toast, Toggle } from './components'

export function SettingsView(): JSX.Element {
  const config = useStore(settings)
  const auth = useStore(authState)
  const sync = useStore(syncState)
  const [email, setEmail] = useState('')
  const [toast, setToast] = useState<string | null>(null)

  return (
    <div class="settings">
      <section class="settings-section">
        <h2 class="section-head">Listening</h2>
        <SegmentedControl<string>
          label="Download quality"
          value={String(config.audioBitrate)}
          onChange={(value) => void updateSetting('audioBitrate', Number(value))}
          options={[
            { value: '64', label: '64 kbps' },
            { value: '128', label: '128 kbps' },
          ]}
        />
        <p class="note">
          64 kbps is plenty for spoken word and halves what a 12-hour book costs you in storage.
        </p>
        <Slider
          label="Skip back"
          value={config.skipBackSeconds}
          min={5}
          max={60}
          step={5}
          onInput={(value) => void updateSetting('skipBackSeconds', value)}
          format={(value) => `${value}s`}
        />
        <Slider
          label="Skip forward"
          value={config.skipForwardSeconds}
          min={5}
          max={60}
          step={5}
          onInput={(value) => void updateSetting('skipForwardSeconds', value)}
          format={(value) => `${value}s`}
        />
      </section>

      <section class="settings-section">
        <h2 class="section-head">Downloads</h2>
        <Toggle
          label="Warn before large downloads"
          hint="iOS Safari doesn't expose the connection type, so this is a manual setting rather than a cellular check."
          checked={config.cellularWarn}
          onChange={(value) => void updateSetting('cellularWarn', value)}
        />
        <Slider
          label="Warn above"
          value={config.largeDownloadWarnMb}
          min={50}
          max={1000}
          step={50}
          onInput={(value) => void updateSetting('largeDownloadWarnMb', value)}
          format={(value) => `${value} MB`}
        />
        <label class="field">
          <span>Auto-delete audio for finished books</span>
          <select
            value={String(config.autoEvictFinishedDays ?? '')}
            onChange={(event) => {
              const raw = (event.currentTarget as HTMLSelectElement).value
              void updateSetting('autoEvictFinishedDays', raw === '' ? null : Number(raw))
            }}
          >
            <option value="">Never</option>
            <option value="7">After 7 days</option>
            <option value="30">After 30 days</option>
            <option value="90">After 90 days</option>
          </select>
        </label>
        <p class="note">Progress and annotations are always kept.</p>
      </section>

      <section class="settings-section">
        <h2 class="section-head">Sync</h2>
        {!supabaseConfigured ? (
          <p class="note">
            Supabase isn't configured, so everything stays on this device. Set
            <code> VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> to sync across
            devices.
          </p>
        ) : auth.status === 'signed-in' ? (
          <>
            <p class="note">
              Signed in as {auth.email ?? auth.userId}. Status: {sync.status}
              {sync.pending > 0 ? ` · ${sync.pending} change(s) waiting to upload` : ''}
              {sync.lastSyncAt ? ` · last synced ${new Date(sync.lastSyncAt).toLocaleTimeString()}` : ''}
            </p>
            {sync.error ? <p class="warn-note">{sync.error}</p> : null}
            <div class="button-row">
              <button type="button" class="button button-small" onClick={() => void syncNow()}>
                Sync now
              </button>
              <button
                type="button"
                class="button button-small button-quiet"
                onClick={() =>
                  void fullResync().then(() => setToast('Pushed everything and pulled a fresh copy.'))
                }
              >
                Full resync
              </button>
              <button
                type="button"
                class="button button-small button-quiet"
                onClick={() => void signOut()}
              >
                Sign out
              </button>
            </div>
          </>
        ) : (
          <form
            class="signin"
            onSubmit={(event) => {
              event.preventDefault()
              void signInWithEmail(email)
                .then(() => setToast('Check your email for the sign-in link.'))
                .catch((error: unknown) =>
                  setToast(error instanceof Error ? error.message : String(error)),
                )
            }}
          >
            <input
              type="email"
              inputMode="email"
              autocomplete="email"
              placeholder="you@example.com"
              value={email}
              onInput={(event) => setEmail((event.currentTarget as HTMLInputElement).value)}
            />
            <button type="submit" class="button button-small">
              Send magic link
            </button>
          </form>
        )}
      </section>

      <section class="settings-section">
        <h2 class="section-head">Narrators</h2>
        <p class="note">
          LibriVox narration quality varies wildly. Readers listed here are hidden from search
          results.
        </p>
        <textarea
          class="note-input"
          rows={3}
          placeholder="One name per line"
          value={config.narratorBlocklist.join('\n')}
          onChange={(event) =>
            void updateSetting(
              'narratorBlocklist',
              (event.currentTarget as HTMLTextAreaElement).value
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean),
            )
          }
        />
      </section>

      <section class="settings-section">
        <h2 class="section-head">Diagnostics</h2>
        <dl class="diagnostics">
          <dt>Catalog</dt>
          <dd>{catalog.name === 'supabase' ? 'Supabase index' : 'Live APIs (no index)'}</dd>
          <dt>CORS proxy</dt>
          <dd>{proxyConfigured ? 'configured' : 'not configured'}</dd>
          <dt>Service worker</dt>
          <dd>{'serviceWorker' in navigator ? 'supported' : 'unsupported'}</dd>
          <dt>Installed</dt>
          <dd>
            {window.matchMedia('(display-mode: standalone)').matches ? 'yes (home screen)' : 'no (browser tab)'}
          </dd>
          <dt>Device</dt>
          <dd>{config.deviceId}</dd>
        </dl>
        <p class="note">
          Install to the home screen before relying on offline audio — a browser tab gets a smaller
          storage allowance and a shorter leash.
        </p>
      </section>

      <Toast message={toast} onDismiss={() => setToast(null)} />
    </div>
  )
}
