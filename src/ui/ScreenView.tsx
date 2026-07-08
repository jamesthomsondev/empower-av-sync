import type { SyncApi } from '../hooks/useSync'
import { QRCode } from './QRCode'
import { DebugPanel } from './DebugPanel'
import { KeepAwakeOption } from './KeepAwakeOption'

export function ScreenView({ api }: { api: SyncApi }) {
  const s = api.state!
  const joinUrl = `${window.location.origin}${window.location.pathname}?room=${s.roomCode}`
  const nowPlaying = api.videos.find((v) => v.id === api.videoId)?.label ?? api.videoId
  return (
    <main className="wrap">
      <header className="topbar">
        <div>
          <b>📺 Screen</b> <span className="muted">· room </span>
          <code className="roomcode big">{s.roomCode}</code>
        </div>
        <button className="ghost" onClick={() => void api.leave()}>
          Leave
        </button>
      </header>

      <p className="muted small">Playing: {nowPlaying}</p>
      <KeepAwakeOption api={api} />
      {/* The persistent looping video is mounted here. */}
      <div className="video-wrap" ref={api.mountScreenVideo} />

      <div className="share">
        <QRCode value={joinUrl} size={240} />
        <div>
          <p className="muted small">Scan to join as a listener (audio syncs to this video):</p>
          <p className="muted small">{joinUrl}</p>
          <p>
            Listeners: <b>{s.peerCount}</b>
          </p>
        </div>
      </div>

      <DebugPanel api={api} />
    </main>
  )
}
