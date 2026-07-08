import { useCallback, useEffect, useRef, useState } from 'react'

const STORAGE_KEY = 'empower-keep-awake'

export function readKeepAwakePref(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function writeKeepAwakePref(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0')
  } catch {
    /* private mode */
  }
}

export function isWakeLockSupported(): boolean {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator
}

/** Keep the display awake during an active session (Screen Wake Lock API). */
export function useWakeLock(active: boolean, enabled: boolean) {
  const sentinelRef = useRef<WakeLockSentinel | null>(null)
  const [held, setHeld] = useState(false)
  const supported = isWakeLockSupported()

  const release = useCallback(async () => {
    const s = sentinelRef.current
    if (!s) return
    sentinelRef.current = null
    setHeld(false)
    try {
      await s.release()
    } catch {
      /* already released */
    }
  }, [])

  const acquire = useCallback(async () => {
    if (!supported || !active || !enabled || document.visibilityState !== 'visible') return
    if (sentinelRef.current) return
    try {
      const s = await navigator.wakeLock.request('screen')
      sentinelRef.current = s
      setHeld(true)
      s.addEventListener('release', () => {
        if (sentinelRef.current === s) {
          sentinelRef.current = null
          setHeld(false)
        }
      })
    } catch {
      setHeld(false)
    }
  }, [supported, active, enabled])

  useEffect(() => {
    void acquire()
    return () => {
      void release()
    }
  }, [active, enabled, acquire, release])

  // Browsers release the lock when the tab is hidden — re-acquire on return.
  useEffect(() => {
    if (!active || !enabled) return
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void acquire()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [active, enabled, acquire])

  return { supported, held }
}
