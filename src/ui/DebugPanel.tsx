import type { ReactNode } from 'react'
import type { SyncApi } from '../hooks/useSync'

/** The instrument for this exploration: live drift, clock offset, RTT, correction mode. */
export function DebugPanel({ api }: { api: SyncApi }) {
  const s = api.state
  if (!s) return null
  const row = (k: string, v: ReactNode) => (
    <div className="dbg-row">
      <span className="dbg-key">{k}</span>
      <span className="dbg-val">{v}</span>
    </div>
  )

  return (
    <section className="debug">
      <h2>Debug — sync state</h2>
      {row('role', <b>{s.role}</b>)}
      {row('room', <code>{s.roomCode}</code>)}
      {row('my id', <code>{s.selfId.slice(0, 6)}</code>)}
      {row('peers', String(s.peerCount))}
      {row(
        'media',
        <code>{s.role === 'screen' ? api.videoId : (s.latestBeat?.mediaId ?? '—')}</code>,
      )}
      {s.role === 'follower' && (
        <>
          {row('screen id', <code>{s.screenId ? s.screenId.slice(0, 6) : '—'}</code>)}
          {row('screen', s.screenOnline ? '🟢 online' : '🔴 offline')}
          {row('clock offset', `${s.offsetMs.toFixed(0)} ms`)}
          {row('rtt', `${s.rttMs.toFixed(0)} ms`)}
          {row(
            'drift',
            <b className={driftClass(api.correction.driftMs)}>
              {api.correction.driftMs >= 0 ? '+' : ''}
              {api.correction.driftMs.toFixed(0)} ms
            </b>,
          )}
          {row('mode', <code>{api.correction.mode}</code>)}
          {row('playbackRate', api.correction.rate.toFixed(3))}
          {row('audio out', api.audioRouted ? 'web-audio (mute-switch safe)' : 'element')}
          {row('latency comp', `auto ${api.audioAutoLatencyMs.toFixed(0)} ms`)}
          {row(
            'local / target',
            <code>
              {api.localTime.toFixed(2)}s / {api.targetTime != null ? `${api.targetTime.toFixed(2)}s` : '—'}
            </code>,
          )}
        </>
      )}
    </section>
  )
}

function driftClass(driftMs: number): string {
  const a = Math.abs(driftMs)
  if (a < 50) return 'drift-good'
  if (a < 150) return 'drift-warn'
  return 'drift-bad'
}
