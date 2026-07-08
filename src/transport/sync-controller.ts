/**
 * Transport binding for the A/V sync spike (simpler sibling of the gallery's
 * session-controller: fixed leader, no epoch/migration/gossip — a star around the screen).
 *
 *  - SCREEN broadcasts a `beat` (video position + screen wall-clock) ~4×/sec, and answers
 *    a `clk` RPC with its current Date.now() so followers can estimate clock offset.
 *  - FOLLOWER stores the latest beat and periodically samples the clock offset (Cristian's
 *    algorithm, keeping the lowest-RTT sample). The actual audio correction lives in the
 *    media layer, driven from this controller's state.
 */
import type { Room } from 'trystero'
import { estimateOffset, bestOffset, type Beat, type ClockSample } from '../sync/sync-math'
import { APP_ID, RTC_CONFIG, RELAY_URLS, STRATEGY, loadStrategy } from './config'

export type Role = 'screen' | 'follower'

const BEAT_MS = 250 // screen broadcasts 4×/sec
const CLK_INTERVAL_MS = 3000 // follower re-samples clock offset every 3s
const CLK_TIMEOUT_MS = 2000
const CLK_WINDOW = 8 // rolling clock-sample window
const SCREEN_STALE_MS = 3000 // no beat for this long → screen considered offline
const RESYNC_GAP_MS = 4000 // beat gap longer than this ⇒ treat as reconnect / wake

export interface SyncState {
  role: Role
  roomCode: string
  selfId: string
  screenId: string | null
  offsetMs: number // add to follower Date.now() to get the screen's clock
  rttMs: number
  latestBeat: Beat | null
  lastBeatAt: number // follower-clock ms when the last beat arrived (0 = none)
  peerCount: number // other connected peers
  screenOnline: boolean
  clockReady: boolean // follower: true once a fresh clock offset sample is available
  syncEpoch: number // bumps on reconnect / resume — followers should resync audio
}

type Listener = () => void
type BeatSource = () => { mediaId: string; videoTime: number; playing: boolean; duration: number }

export interface SyncController {
  readonly role: Role
  readonly roomCode: string
  readonly selfId: string
  getState(): SyncState
  subscribe(fn: Listener): () => void
  setBeatSource(fn: BeatSource): void // screen only
  leave(): Promise<void>
}

export async function startScreen(roomCode: string): Promise<SyncController> {
  return create(roomCode, 'screen')
}
export async function joinAsFollower(roomCode: string): Promise<SyncController> {
  return create(roomCode, 'follower')
}

async function create(roomCode: string, role: Role): Promise<SyncController> {
  const { joinRoom, selfId } = await loadStrategy()

  const room: Room = joinRoom(
    {
      appId: APP_ID,
      password: roomCode,
      rtcConfig: RTC_CONFIG,
      ...(STRATEGY === 'nostr' && RELAY_URLS.length ? { relayConfig: { urls: RELAY_URLS } } : {}),
    },
    roomCode,
  )

  let state: SyncState = {
    role,
    roomCode,
    selfId,
    screenId: role === 'screen' ? selfId : null,
    offsetMs: 0,
    rttMs: 0,
    latestBeat: null,
    lastBeatAt: 0,
    peerCount: 0,
    screenOnline: role === 'screen',
    clockReady: role === 'screen',
    syncEpoch: 0,
  }
  const listeners = new Set<Listener>()
  const notify = () => listeners.forEach((f) => f())
  const set = (patch: Partial<SyncState>) => {
    state = { ...state, ...patch }
    notify()
  }

  const refreshPeers = () => set({ peerCount: Object.keys(room.getPeers()).length })
  room.onPeerJoin = () => refreshPeers()
  room.onPeerLeave = (id) => {
    if (id === state.screenId && role === 'follower') set({ screenOnline: false })
    refreshPeers()
  }

  // ── beat channel (screen → all) ──
  const beat = room.makeAction('beat')
  const rawBeatSend = beat.send as (d: unknown) => Promise<void>

  // ── clock RPC (follower → screen) ──
  const clk = room.makeAction('clk', { kind: 'request', onRequest: () => Date.now() })
  const clkRequest = (
    clk as unknown as {
      request: (d: unknown, o: { target: string; timeoutMs?: number }) => Promise<number>
    }
  ).request

  const timers: number[] = []
  let samples: ClockSample[] = []
  let beatSource: BeatSource | null = null

  if (role === 'screen') {
    timers.push(
      setInterval(() => {
        if (!beatSource) return
        const s = beatSource()
        const b: Beat = {
          mediaId: s.mediaId,
          videoTime: s.videoTime,
          wall: Date.now(),
          playing: s.playing,
          duration: s.duration,
        }
        void rawBeatSend(b)
      }, BEAT_MS) as unknown as number,
    )
  } else {
    const sampleClock = async () => {
      const sid = state.screenId
      if (!sid) return
      const t0 = Date.now()
      try {
        const tScreen = await clkRequest({}, { target: sid, timeoutMs: CLK_TIMEOUT_MS })
        const t2 = Date.now()
        samples = [...samples, estimateOffset(t0, tScreen, t2)].slice(-CLK_WINDOW)
        const best = bestOffset(samples)!
        set({ offsetMs: best.offset, rttMs: best.rtt, clockReady: true })
      } catch {
        /* timed out — retry next tick */
      }
    }

    beat.onMessage = (data, ctx) => {
      const now = Date.now()
      const gap = state.lastBeatAt ? now - state.lastBeatAt : 0
      const needsResync = !state.screenOnline || gap > RESYNC_GAP_MS
      if (needsResync) {
        samples = []
        set({ offsetMs: 0, rttMs: 0, clockReady: false })
        void sampleClock()
      }
      set({
        latestBeat: data as unknown as Beat,
        lastBeatAt: now,
        screenId: ctx.peerId,
        screenOnline: true,
        ...(needsResync ? { syncEpoch: state.syncEpoch + 1 } : {}),
      })
    }

    timers.push(
      setInterval(() => {
        void sampleClock()
        if (state.lastBeatAt && Date.now() - state.lastBeatAt > SCREEN_STALE_MS && state.screenOnline) {
          samples = []
          set({ screenOnline: false, clockReady: false, offsetMs: 0, rttMs: 0 })
        }
      }, CLK_INTERVAL_MS) as unknown as number,
    )
    // kick an early clock sample shortly after the first beats should have arrived
    timers.push(setTimeout(() => void sampleClock(), 800) as unknown as number)
  }

  refreshPeers()

  return {
    role,
    roomCode,
    selfId,
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    setBeatSource(fn) {
      beatSource = fn
    },
    async leave() {
      for (const id of timers) {
        clearInterval(id)
        clearTimeout(id)
      }
      listeners.clear()
      await room.leave()
    },
  }
}
