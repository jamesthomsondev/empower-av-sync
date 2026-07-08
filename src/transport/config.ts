/**
 * Transport configuration. Trystero matchmaking strategy + ICE. Defaults to Nostr
 * (public-internet signaling, not same-LAN discovery). Swap via VITE_TRYSTERO_STRATEGY.
 */
export type Strategy = 'nostr' | 'mqtt' | 'torrent'

export const STRATEGY: Strategy = (import.meta.env.VITE_TRYSTERO_STRATEGY as Strategy) || 'nostr'

export const APP_ID = 'empower-av-sync-v1'

function buildIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ]
  const turnUrl = import.meta.env.VITE_TURN_URL
  if (turnUrl) {
    servers.push({
      urls: turnUrl,
      username: import.meta.env.VITE_TURN_USERNAME,
      credential: import.meta.env.VITE_TURN_CREDENTIAL,
    })
  }
  return servers
}

export const RTC_CONFIG: RTCConfiguration = { iceServers: buildIceServers() }

/** Optional relay override (see empower-peer-to-peer notes). Leave unset for Trystero defaults. */
export const RELAY_URLS: string[] = (import.meta.env.VITE_NOSTR_RELAYS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

export async function loadStrategy(): Promise<{
  joinRoom: typeof import('trystero/nostr').joinRoom
  selfId: string
}> {
  switch (STRATEGY) {
    case 'mqtt': {
      const m = await import('@trystero-p2p/mqtt')
      return { joinRoom: m.joinRoom, selfId: m.selfId }
    }
    case 'torrent': {
      const m = await import('@trystero-p2p/torrent')
      return { joinRoom: m.joinRoom, selfId: m.selfId }
    }
    case 'nostr':
    default: {
      const m = await import('trystero/nostr')
      return { joinRoom: m.joinRoom, selfId: m.selfId }
    }
  }
}
