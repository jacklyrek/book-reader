import type { JSX } from 'preact'
import { hrefFor } from '../core/router'
import { useStore } from '../core/store'
import { playerState, skip, togglePlay } from '../player/player'
import { settings } from '../core/settings'
import { ProgressBar } from './components'

/** Persistent mini-player. Visible on every screen except the player itself. */
export function NowPlaying(): JSX.Element | null {
  const state = useStore(playerState)
  const config = useStore(settings)

  if (!state.bookId || state.tracks.length === 0) return null

  const track = state.tracks[state.trackIndex]
  const fraction = state.bookDuration > 0 ? state.bookTime / state.bookDuration : 0

  return (
    <div class="now-playing">
      <ProgressBar value={fraction} label="Listening progress" />
      <div class="now-playing-row">
        <a class="now-playing-text" href={hrefFor({ name: 'listen', bookId: state.bookId })}>
          <span class="now-playing-title">{state.title}</span>
          <span class="now-playing-sub">{track?.title ?? ''}</span>
        </a>
        <button
          type="button"
          class="icon-button"
          onClick={() => skip(-config.skipBackSeconds)}
          aria-label={`Back ${config.skipBackSeconds} seconds`}
        >
          ↺
        </button>
        <button
          type="button"
          class="icon-button"
          onClick={() => void togglePlay()}
          aria-label={state.playing ? 'Pause' : 'Play'}
        >
          {state.playing ? '❚❚' : '▶'}
        </button>
      </div>
    </div>
  )
}
