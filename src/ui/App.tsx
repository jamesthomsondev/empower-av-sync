import { useState } from 'react'
import { useSync } from '../hooks/useSync'
import { STRATEGY } from '../transport/config'
import { ScreenView } from './ScreenView'
import { FollowerView } from './FollowerView'
import { KeepAwakeOption } from './KeepAwakeOption'

export function App() {
  const api = useSync()

  if (api.phase === 'active' && api.state) {
    return api.state.role === 'screen' ? <ScreenView api={api} /> : <FollowerView api={api} />
  }
  return <Landing api={api} />
}

function Landing({ api }: { api: ReturnType<typeof useSync> }) {
  const params = new URLSearchParams(window.location.search)
  const [code, setCode] = useState(params.get('room')?.toUpperCase() ?? '')
  const connecting = api.phase === 'connecting'

  return (
    <main className="wrap">
      <h1>Empower — A/V Sync</h1>
      <p className="muted">
        Fixed screen leader · followers' audio synced to the video clock · over WebRTC ({STRATEGY})
      </p>
      {api.error && <p className="error">⚠ {api.error}</p>}

      <div className="card">
        <h2>Be the screen</h2>
        <p className="muted">
          Plays the looping video and drives everyone's audio. Use one device as the display.
        </p>
        <label className="field">
          <span className="muted small">Video</span>
          <select value={api.videoId} onChange={(e) => api.setVideoId(e.target.value)}>
            {api.videos.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
        <KeepAwakeOption api={api} />
        <button disabled={connecting} onClick={() => void api.becomeScreen()}>
          {connecting ? 'Starting…' : '📺 Be the screen'}
        </button>
      </div>

      <div className="card">
        <h2>Join as listener</h2>
        <p className="muted">Enter the screen's room code; your audio locks to the video.</p>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="e.g. K7QF"
          maxLength={8}
          autoCapitalize="characters"
          autoCorrect="off"
        />
        <KeepAwakeOption api={api} />
        <button disabled={connecting || code.trim().length < 3} onClick={() => void api.join(code)}>
          {connecting ? 'Connecting…' : '🎧 Join (tap to enable audio)'}
        </button>
        <p className="hint">The tap unlocks audio for this device (needed on iOS).</p>
      </div>
    </main>
  )
}
