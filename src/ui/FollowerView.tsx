import type { SyncApi } from '../hooks/useSync'
import { DebugPanel } from './DebugPanel'
import { KeepAwakeOption } from './KeepAwakeOption'

export function FollowerView({ api }: { api: SyncApi }) {
  const s = api.state!
  const drift = api.correction.driftMs
  const cls =
    Math.abs(drift) < 50 ? 'drift-good' : Math.abs(drift) < 150 ? 'drift-warn' : 'drift-bad'

  return (
    <main className="wrap">
      <header className="topbar">
        <div>
          <b>🎧 Listener</b> <span className="muted">· room </span>
          <code className="roomcode">{s.roomCode}</code>
        </div>
        <button className="ghost" onClick={() => void api.leave()}>
          Leave
        </button>
      </header>

      <KeepAwakeOption api={api} />

      <p className="muted">
        Put on headphones — your audio is kept in sync with the screen's video. The big number
        is your live drift from the screen.
      </p>

      {!s.screenOnline ? (
        <div className="connecting">Waiting for the screen… (no sync beats yet)</div>
      ) : api.correction.mode === 'syncing' ? (
        <div className="connecting">Syncing audio… (downloading the soundtrack)</div>
      ) : (
        <div className={`drift-hero ${cls}`}>
          <div className="drift-num">
            {drift >= 0 ? '+' : ''}
            {drift.toFixed(0)}
            <span className="drift-unit"> ms</span>
          </div>
          <div className="muted small">
            {api.correction.mode} · rate {api.correction.rate.toFixed(3)}
          </div>
        </div>
      )}

      <DebugPanel api={api} />
    </main>
  )
}
