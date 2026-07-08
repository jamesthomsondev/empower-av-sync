import type { SyncApi } from '../hooks/useSync'

export function KeepAwakeOption({ api }: { api: SyncApi }) {
  if (!api.wakeLockSupported) return null
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={api.keepAwake}
        onChange={(e) => api.setKeepAwake(e.target.checked)}
      />
      <span>
        Keep screen awake
        {api.wakeLockActive && <span className="muted"> (active)</span>}
      </span>
    </label>
  )
}
