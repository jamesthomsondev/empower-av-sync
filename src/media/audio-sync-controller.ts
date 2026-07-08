/**
 * Follower-side audio: plays the local soundtrack and continuously corrects it toward the
 * screen's video position.
 *
 * Engines:
 *  - Element (Android/desktop): <audio> routed through Web Audio. Small drifts are closed
 *    by nudging `playbackRate` (pitch preserved, no audible jump); large drifts hard-seek.
 *  - Buffer (iOS): Safari's media-element pipeline stalls >1s on seeks and spontaneously
 *    mid-playback, and it ignores fine playbackRate adjustments — element-side correction
 *    is unworkable there. Followers play a decoded AudioBuffer on the AudioContext clock
 *    instead (see BufferAudioEngine). While the soundtrack downloads/decodes the follower
 *    reports a 'syncing' state (silent — cleaner than the element's stuttery streaming
 *    playback); the element remains primed only as a fallback if fetch/decode fails.
 *
 * Autoplay gate: unlock() must run inside the join tap (fires play() before any await).
 */
import { SYNTH_SOUNDTRACK_URL } from '../content'
import { signedDrift, correctionRate } from '../sync/sync-math'
import { BufferAudioEngine } from './buffer-audio-engine'

const HARD_SEEK_SEC = 0.6 // only snap on large drift; the nudge closes anything smaller
const SEEK_COOLDOWN_MS = 8000 // keep hard seeks rare
const SEEK_SETTLE_MS = 400 // after a hard seek, let playback resume before re-steering
const LOCK_DEADBAND_SEC = 0.07 // hold rate=1 inside this band (±70ms — within the "good" A/V-sync range)
const LOCKED_SEC = 0.02 // UI "locked" threshold (tighter than the correction deadband)
const DRIFT_EMA_ALPHA = 0.25 // smooth noisy drift samples before steering
const RATE_EPS = 0.003 // skip playbackRate writes that wouldn't audibly change
const RATE_GAIN = 0.5
const RATE_MIN = 0.97
const RATE_MAX = 1.03
const MAX_LATENCY_SEC = 0.5 // clamp auto-measured output latency to something sane
const LATENCY_EMA_ALPHA = 0.2 // smooth the latency estimate
const IOS_FALLBACK_LATENCY_SEC = 0.12 // last resort when nothing reports (iOS)
const IS_IOS =
  typeof navigator !== 'undefined' &&
  (/iP(hone|ad|od)/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && (navigator.maxTouchPoints ?? 0) > 1))

export type CorrectionMode = 'idle' | 'syncing' | 'seek' | 'nudge' | 'locked'
export interface CorrectionInfo {
  mode: CorrectionMode
  driftMs: number // signed: + = local audio is AHEAD of the screen
  rate: number
}

export class AudioSyncController {
  private el: HTMLAudioElement
  private currentUrl: string
  private ctx: AudioContext | null = null
  private srcNode: MediaElementAudioSourceNode | null = null
  private routed = false
  private hardStopped = false
  private smoothedDriftSec = 0
  private lastSeekAt = 0
  private lastAppliedRate = 1
  private trackedSec = 0
  private lastTrackAt = 0
  private lastObservedSec = -1
  private seekSettleUntil = 0
  private needsInitialSync = true // snap to the live target on join/resync, however small the drift
  private measuredLatencySec = 0 // auto-measured output latency (see sampleOutputLatency)
  private bufferEngine: BufferAudioEngine | null = null
  private useBuffer = false // buffer engine is the active output (iOS, once decoded)
  private bufferUpgradePending = IS_IOS // element is bootstrapping while the buffer decodes
  unlocked = false

  constructor() {
    const el = new Audio(SYNTH_SOUNDTRACK_URL)
    el.loop = true
    el.preload = 'auto'
    el.preservesPitch = true
    const anyEl = el as unknown as Record<string, unknown>
    anyEl.mozPreservesPitch = true
    anyEl.webkitPreservesPitch = true
    this.el = el
    this.currentUrl = SYNTH_SOUNDTRACK_URL
    if (IS_IOS) {
      this.bufferEngine = new BufferAudioEngine(() => this.fallbackToElement())
    }
  }

  private get bufferEngineWanted(): boolean {
    return this.bufferEngine != null && (this.useBuffer || this.bufferUpgradePending)
  }

  private fallbackToElement(): void {
    this.bufferUpgradePending = false
    if (!this.useBuffer) return // element is already (still) the active output
    this.useBuffer = false
    this.el.src = this.currentUrl
    this.resetAfterSourceChange()
  }

  setSource(url: string): void {
    if (!url) return
    const changed = url !== this.currentUrl
    this.currentUrl = url
    if (this.bufferEngineWanted) this.bufferEngine!.setSource(url) // kicks download+decode
    if (!this.bufferEngineWanted && changed) {
      this.el.src = url // element streams (the active output on non-iOS / after fallback)
      this.resetAfterSourceChange()
    }
  }

  private resetAfterSourceChange(): void {
    this.trackedSec = 0
    this.lastTrackAt = 0
    this.lastObservedSec = -1
    this.smoothedDriftSec = 0
    this.needsInitialSync = true
  }

  get currentTimeSec(): number {
    if (this.useBuffer) return this.bufferEngine!.currentTimeSec
    return this.trackedSec || this.el.currentTime
  }
  get duration(): number {
    if (this.useBuffer) return this.bufferEngine!.duration
    return this.el.duration
  }
  get routedThroughWebAudio(): boolean {
    return this.useBuffer || this.routed
  }
  get autoLatencyMs(): number {
    if (this.useBuffer) return this.bufferEngine!.autoLatencyMs
    return this.outputLatencySec() * 1000
  }

  async unlock(): Promise<void> {
    this.hardStopped = false
    this.smoothedDriftSec = 0
    this.lastAppliedRate = 1
    this.trackedSec = 0
    this.lastTrackAt = 0
    this.seekSettleUntil = 0
    this.needsInitialSync = true
    // iOS: unlock the buffer engine's context inside this gesture (idempotent — also
    // clears its stopped state on re-join). The element below is primed too since it
    // bootstraps playback while the buffer decodes and is the fallback if decode fails.
    const bufferUnlock = this.bufferEngineWanted
      ? this.bufferEngine!.unlock().catch(() => {
          this.fallbackToElement()
        })
      : null
    if (this.unlocked) {
      if (bufferUnlock) await bufferUnlock
      return
    }
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      // On iOS the element is only the fallback and plays directly (no Web Audio routing:
      // Safari's MediaElementSource pipeline is the thing we're avoiding).
      if (Ctx && !this.ctx && !IS_IOS) {
        this.ctx = new Ctx()
        try {
          // Create the source but DON'T connect to the destination yet — priming the
          // element (below) then makes no sound, so the listener never hears the test
          // soundtrack blip during the join tap. We connect after priming.
          this.srcNode = this.ctx.createMediaElementSource(this.el)
          this.routed = true
        } catch {
          this.routed = false
        }
      }

      // Prime inside the gesture to unlock the element + resume the context. Muted, and
      // (when routed) not yet connected to output → silent.
      this.el.muted = true
      const playPromise = this.el.play()
      const resumePromise =
        this.ctx && this.ctx.state === 'suspended' ? this.ctx.resume() : Promise.resolve()
      await Promise.allSettled([playPromise, resumePromise])

      this.el.pause()
      this.el.currentTime = 0
      this.el.muted = false
      // Now route to the output for real, audible playback.
      if (this.srcNode && this.ctx) this.srcNode.connect(this.ctx.destination)
      this.unlocked = true
    } catch {
      this.unlocked = true
    }
    if (bufferUnlock) await bufferUnlock
  }

  resume(): void {
    if (this.bufferEngineWanted) this.bufferEngine!.resume()
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {})
  }

  /**
   * Auto-measure the device's true output latency (element position → what's actually
   * heard) so we can steer the element ahead by exactly that much — fully automatic, no
   * user calibration (this is BYOD).
   *
   * Primary signal: getOutputTimestamp() — (currentTime − contextTime) is the full
   * scheduling→output delay and reflects the REAL output path, INCLUDING Bluetooth
   * (which varies 100–300 ms and no fixed constant could cover). Fallback: outputLatency
   * (flaky — reads 0 until warmup even on Chrome).
   */
  private sampleOutputLatency(): void {
    const ctx = this.ctx
    if (!ctx) return
    let L: number | null = null
    const g = ctx.getOutputTimestamp?.()
    if (g && typeof g.contextTime === 'number' && g.contextTime > 0) {
      const d = ctx.currentTime - g.contextTime
      if (d > 0.001 && d < 1) L = d
    }
    if (L == null && typeof ctx.outputLatency === 'number' && ctx.outputLatency > 0) {
      L = ctx.outputLatency + (ctx.baseLatency ?? 0)
    }
    if (L == null) return
    L = Math.min(MAX_LATENCY_SEC, Math.max(0, L))
    this.measuredLatencySec = this.measuredLatencySec
      ? this.measuredLatencySec * (1 - LATENCY_EMA_ALPHA) + L * LATENCY_EMA_ALPHA
      : L
  }

  private outputLatencySec(): number {
    if (this.routed) return this.measuredLatencySec
    // Plain element output (the iOS fallback) has real device latency we can't measure.
    return IS_IOS ? IOS_FALLBACK_LATENCY_SEC : 0
  }

  private steerTarget(targetSec: number, dur: number): number {
    const shift = this.outputLatencySec()
    if (shift <= 0) return targetSec
    return (((targetSec + shift) % dur) + dur) % dur
  }

  private setPlaybackRate(rate: number): void {
    // Compare against the element's ACTUAL rate, not a cache of what we last wrote —
    // engines may silently reset playbackRate to 1 after seeks/stalls/interruptions,
    // and trusting a cache would leave the nudge corrector permanently inert.
    this.lastAppliedRate = rate
    const actual = this.el.playbackRate
    if (Math.abs(rate - actual) <= RATE_EPS) return
    try {
      this.el.playbackRate = rate
    } catch {
      /* some engines reject rates mid-load */
    }
  }

  /**
   * Honest local clock: trust any fresh element reading — even one BEHIND the previous
   * value — and advance an internal clock ONLY while the element clock is genuinely
   * frozen (e.g. briefly around seeks). A forward-only ratchet here once let the
   * synthetic clock detach from real playback and measure drift against its own
   * assumption, hiding genuine desync.
   */
  private sampleLocalSec(): number {
    const observed = this.el.currentTime
    const now = Date.now()
    const alive = observed !== this.lastObservedSec
    this.lastObservedSec = observed
    if (alive || this.el.paused || this.lastTrackAt === 0) {
      this.trackedSec = observed
      this.lastTrackAt = now
      return observed
    }
    const dt = (now - this.lastTrackAt) / 1000
    this.trackedSec += dt * (this.el.playbackRate || 1)
    this.lastTrackAt = now
    return this.trackedSec
  }

  correct(targetSec: number | null, playing: boolean): CorrectionInfo {
    if (this.bufferUpgradePending) {
      if (this.bufferEngine!.hasBufferFor(this.currentUrl)) {
        // Decoded soundtrack just became available — the buffer engine takes over
        // (it snaps straight onto the live target on its first tick).
        this.bufferUpgradePending = false
        this.useBuffer = true
      } else {
        // Stay silent while downloading/decoding rather than limping along on the
        // stuttery element pipeline; the UI shows this as "syncing".
        if (!this.el.paused) this.el.pause()
        return { mode: 'syncing', driftMs: 0, rate: 1 }
      }
    }
    if (this.useBuffer) return this.bufferEngine!.correct(targetSec, playing)
    if (this.hardStopped) {
      if (!this.el.paused) this.el.pause()
      return { mode: 'idle', driftMs: 0, rate: 1 }
    }

    if (targetSec == null || !playing) {
      if (!this.el.paused) this.el.pause()
      this.setPlaybackRate(1)
      return { mode: 'idle', driftMs: 0, rate: 1 }
    }

    const dur = this.el.duration
    if (!isFinite(dur) || dur <= 0) {
      void this.el.play().catch(() => {})
      return { mode: 'idle', driftMs: 0, rate: this.lastAppliedRate }
    }

    if (this.el.paused) void this.el.play().catch(() => {})

    this.sampleOutputLatency() // keep the auto latency estimate fresh
    const localSec = this.sampleLocalSec()
    const aim = this.steerTarget(targetSec, dur)
    const rawDrift = signedDrift(localSec, aim, dur)
    this.smoothedDriftSec =
      DRIFT_EMA_ALPHA * rawDrift + (1 - DRIFT_EMA_ALPHA) * this.smoothedDriftSec
    const drift = this.smoothedDriftSec

    const now = Date.now()
    const cooldownElapsed = now - this.lastSeekAt >= SEEK_COOLDOWN_MS
    const settled = now >= this.seekSettleUntil

    const needsSnap =
      this.needsInitialSync ||
      (settled &&
        cooldownElapsed &&
        Math.abs(rawDrift) > HARD_SEEK_SEC &&
        Math.abs(drift) > HARD_SEEK_SEC * 0.75)

    if (needsSnap) {
      this.needsInitialSync = false
      try {
        this.el.currentTime = aim
      } catch {
        /* not seekable yet — the next tick retries via drift */
      }
      this.trackedSec = aim
      this.lastTrackAt = now
      this.lastObservedSec = this.el.currentTime
      this.smoothedDriftSec = 0
      this.lastSeekAt = now
      this.seekSettleUntil = now + SEEK_SETTLE_MS
      this.setPlaybackRate(1)
      return { mode: 'seek', driftMs: rawDrift * 1000, rate: 1 }
    }

    if (now < this.seekSettleUntil) {
      return { mode: 'nudge', driftMs: rawDrift * 1000, rate: this.lastAppliedRate }
    }

    if (Math.abs(drift) < LOCK_DEADBAND_SEC) {
      this.setPlaybackRate(1)
      return {
        mode: (Math.abs(rawDrift) < LOCKED_SEC ? 'locked' : 'nudge') as CorrectionMode,
        driftMs: rawDrift * 1000,
        rate: 1,
      }
    }

    const rate = correctionRate(drift, RATE_GAIN, RATE_MIN, RATE_MAX)
    this.setPlaybackRate(rate)
    return {
      mode: (Math.abs(rawDrift) < LOCKED_SEC ? 'locked' : 'nudge') as CorrectionMode,
      driftMs: rawDrift * 1000,
      rate: this.lastAppliedRate,
    }
  }

  resync(): void {
    if (this.useBuffer) {
      this.bufferEngine!.resync()
      return
    }
    this.smoothedDriftSec = 0
    this.lastSeekAt = 0
    this.seekSettleUntil = 0
    this.needsInitialSync = true
    this.trackedSec = this.el.currentTime
    this.lastTrackAt = Date.now()
  }

  stop(): void {
    this.bufferEngine?.stop()
    this.hardStopped = true
    this.el.pause()
    this.el.playbackRate = 1
    this.lastAppliedRate = 1
    this.trackedSec = 0
    this.lastTrackAt = 0
    this.seekSettleUntil = 0
    this.needsInitialSync = true
  }
}
