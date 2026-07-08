/**
 * React binding for the A/V sync spike.
 *  - Screen: owns a persistent looping <video> (unlocked in the "Be the screen" tap),
 *    mounts it into the view, and feeds its clock to the controller's beat source.
 *  - Follower: unlocks a local audio element in the join tap, then runs a ~15 Hz corrector
 *    that computes the screen's current position (latest beat + clock offset) and steers
 *    the audio via AudioSyncController.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  startScreen,
  joinAsFollower,
  type SyncController,
  type SyncState,
} from '../transport/sync-controller'
import { AudioSyncController, type CorrectionInfo } from '../media/audio-sync-controller'
import { computeTarget } from '../sync/sync-math'
import { VIDEOS, DEFAULT_VIDEO_ID, videoById, type VideoOption } from '../content'
import {
  readKeepAwakePref,
  useWakeLock,
  writeKeepAwakePref,
} from './useWakeLock'

const CORRECT_MS = 66 // ~15 Hz correction loop
const BEAT_FRESH_MS = 3000

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function makeRoomCode(len = 4): string {
  const buf = new Uint32Array(len)
  crypto.getRandomValues(buf)
  return Array.from(buf, (n) => ROOM_ALPHABET[n % ROOM_ALPHABET.length]).join('')
}


export type Phase = 'landing' | 'connecting' | 'active'

export interface SyncApi {
  phase: Phase
  error: string | null
  state: SyncState | null
  // follower live sync readout
  correction: CorrectionInfo
  localTime: number
  targetTime: number | null
  audioRouted: boolean // audio routed through Web Audio (ignores iOS mute switch)
  audioAutoLatencyMs: number // auto-measured output latency being compensated
  // video selection (screen)
  videos: VideoOption[]
  videoId: string
  setVideoId: (id: string) => void
  // wake lock (screen + listener)
  keepAwake: boolean
  setKeepAwake: (on: boolean) => void
  wakeLockSupported: boolean
  wakeLockActive: boolean
  // actions
  becomeScreen: () => Promise<void>
  join: (code: string) => Promise<void>
  leave: () => Promise<void>
  // screen video element mount point
  mountScreenVideo: (container: HTMLElement | null) => void
}

export function useSync(): SyncApi {
  const [controller, setController] = useState<SyncController | null>(null)
  const [state, setState] = useState<SyncState | null>(null)
  const [phase, setPhase] = useState<Phase>('landing')
  const [error, setError] = useState<string | null>(null)

  const [correction, setCorrection] = useState<CorrectionInfo>({ mode: 'idle', driftMs: 0, rate: 1 })
  const [localTime, setLocalTime] = useState(0)
  const [targetTime, setTargetTime] = useState<number | null>(null)
  const [videoId, setVideoId] = useState<string>(DEFAULT_VIDEO_ID)
  const [keepAwake, setKeepAwakeState] = useState(readKeepAwakePref)

  const setKeepAwake = useCallback((on: boolean) => {
    writeKeepAwakePref(on)
    setKeepAwakeState(on)
  }, [])


  const sessionActive = phase === 'active' && controller != null
  const { supported: wakeLockSupported, held: wakeLockActive } = useWakeLock(sessionActive, keepAwake)

  // Persistent screen video element (created once → survives being moved into the view,
  // preserving the iOS autoplay permission granted in the gesture). Its src is set when
  // becoming the screen, from the selected video option.
  const videoRef = useRef<HTMLVideoElement | null>(null)
  if (!videoRef.current) {
    const v = document.createElement('video')
    v.loop = true
    v.playsInline = true
    v.setAttribute('playsinline', '')
    v.setAttribute('webkit-playsinline', '')
    v.controls = true
    // The leader (local video) is muted. Only followers can hear the sound.
    v.muted = true
    v.style.width = '100%'
    v.style.height = 'auto'
    v.style.background = '#000'
    v.style.display = 'block'
    videoRef.current = v
  }
  const audioRef = useRef<AudioSyncController | null>(null)
  if (!audioRef.current) audioRef.current = new AudioSyncController()
  const syncEpochRef = useRef(0)

  useEffect(() => {
    if (!controller) return
    setState(controller.getState())
    return controller.subscribe(() => setState(controller.getState()))
  }, [controller])

  // Follower correction loop.
  useEffect(() => {
    if (!controller || controller.role !== 'follower') return
    const audio = audioRef.current!
    const id = setInterval(() => {
      audio.resume() // recover the Web Audio context if iOS suspended it (backgrounding)
      const st = controller.getState()
      if (st.syncEpoch !== syncEpochRef.current) {
        syncEpochRef.current = st.syncEpoch
        audio.resync()
      }
      const beat = st.latestBeat
      const now = Date.now()
      let target: number | null = null
      let playing = false
      if (beat && st.screenOnline && st.clockReady && now - st.lastBeatAt < BEAT_FRESH_MS) {
        audio.setSource(videoById(beat.mediaId).soundtrackUrl) // load the matching audio
        target = computeTarget(beat, st.offsetMs, now)
        playing = beat.playing
      }
      setCorrection(audio.correct(target, playing))
      setLocalTime(audio.currentTimeSec)
      setTargetTime(target)
    }, CORRECT_MS) as unknown as number
    return () => clearInterval(id)
  }, [controller])

  // Resume media after sleep / tab backgrounding (iOS suspends Web Audio + video).
  useEffect(() => {
    if (!controller) return
    const audio = audioRef.current!
    const video = videoRef.current!
    let screenWasPlaying = false

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (controller.role === 'screen') screenWasPlaying = !video.paused
        return
      }
      if (controller.role === 'follower') {
        audio.resume()
        audio.resync()
        syncEpochRef.current = controller.getState().syncEpoch
      } else if (screenWasPlaying) {
        void video.play().catch(() => {})
      }
    }

    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [controller])

  const becomeScreen = useCallback(async () => {
    setError(null)
    setPhase('connecting')
    try {
      const v = videoRef.current!
      const opt = videoById(videoId)
      if (!v.src.endsWith(opt.videoUrl) && v.getAttribute('src') !== opt.videoUrl) {
        v.src = opt.videoUrl
      }
      // Start playback inside the gesture
      try {
        await v.play()
      } catch {

        await v.play().catch(() => {})
      }
      const c = await startScreen(makeRoomCode())
      c.setBeatSource(() => ({
        mediaId: opt.id,
        videoTime: v.currentTime,
        playing: !v.paused,
        duration: v.duration || 0,
      }))
      setController(c)
      setPhase('active')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('landing')
    }
  }, [videoId])

  const join = useCallback(async (code: string) => {
    setError(null)
    setPhase('connecting')
    try {
      await audioRef.current!.unlock() // play() fired inside the gesture
      const c = await joinAsFollower(code.trim().toUpperCase())
      syncEpochRef.current = c.getState().syncEpoch
      setController(c)
      setPhase('active')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('landing')
    }
  }, [])

  const leave = useCallback(async () => {
    audioRef.current?.stop()
    videoRef.current?.pause()
    await controller?.leave()
    setController(null)
    setState(null)
    setPhase('landing')
  }, [controller])

  const mountScreenVideo = useCallback((container: HTMLElement | null) => {
    const v = videoRef.current!
    if (container) {
      if (v.parentElement !== container) container.appendChild(v)
    } else if (v.parentElement) {
      v.parentElement.removeChild(v)
    }
  }, [])

  return {
    phase,
    error,
    state,
    correction,
    localTime,
    targetTime,
    audioRouted: audioRef.current?.routedThroughWebAudio ?? false,
    audioAutoLatencyMs: audioRef.current?.autoLatencyMs ?? 0,
    videos: VIDEOS,
    videoId,
    setVideoId,
    keepAwake,
    setKeepAwake,
    wakeLockSupported,
    wakeLockActive,
    becomeScreen,
    join,
    leave,
    mountScreenVideo,
  }
}
