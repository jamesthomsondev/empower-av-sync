/**
 * Follower-side audio: plays the local soundtrack and continuously corrects it toward the
 * screen's video position. Small drifts are closed by nudging `playbackRate` (pitch
 * preserved) so there's no audible jump; large drifts (including a loop wrap) hard-seek.
 *
 * iOS autoplay gate: unlock() must run inside the join tap (fires play() before any await).
 */
import { SYNTH_SOUNDTRACK_URL } from '../content'
import { signedDrift, correctionRate } from '../sync/sync-math'

const HARD_SEEK_SEC = 0.6 // iOS seeks stall — only snap on large drift
const SEEK_COOLDOWN_MS = 8000 // keep hard seeks rare
const SEEK_SETTLE_MS = 400 // after a hard seek, let iOS resume before re-steering
const LOCK_DEADBAND_SEC = 0.07 // hold rate=1 inside this band (±70ms — within the "good" A/V-sync range)
const LOCKED_SEC = 0.02 // UI "locked" threshold (tighter than the correction deadband)
const DRIFT_EMA_ALPHA = 0.25 // smooth noisy drift samples before steering
const RATE_EPS = 0.003 // skip playbackRate writes that wouldn't audibly change
const TRACK_EPS_SEC = 0.003 // element time must advance by this much to be trusted
const RATE_GAIN = 0.5
const RATE_MIN = 0.97
const RATE_MAX = 1.03
const MAX_LATENCY_SEC = 0.5 // clamp auto-measured output latency to something sane
const LATENCY_EMA_ALPHA = 0.2 // smooth the latency estimate
const IOS_FALLBACK_LATENCY_SEC = 0.12 // last resort when neither API reports (iOS)
const IS_IOS =
  typeof navigator !== 'undefined' &&
  (/iP(hone|ad|od)/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && (navigator.maxTouchPoints ?? 0) > 1))

export type CorrectionMode = 'idle' | 'seek' | 'nudge' | 'locked'
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
  private seekSettleUntil = 0
  private measuredLatencySec = 0 // auto-measured output latency (see sampleOutputLatency)
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
  }

  setSource(url: string): void {
    if (!url || url === this.currentUrl) return
    this.currentUrl = url
    this.el.src = url
    this.trackedSec = 0
    this.lastTrackAt = 0
    this.smoothedDriftSec = 0
  }

  get currentTimeSec(): number {
    return this.trackedSec || this.el.currentTime
  }
  get duration(): number {
    return this.el.duration
  }
  get routedThroughWebAudio(): boolean {
    return this.routed
  }

  async unlock(): Promise<void> {
    this.hardStopped = false
    this.smoothedDriftSec = 0
    this.lastAppliedRate = 1
    this.trackedSec = 0
    this.lastTrackAt = 0
    this.seekSettleUntil = 0
    if (this.unlocked) return
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (Ctx && !this.ctx) {
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
  }

  resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {})
  }

  /**
   * Web Audio output is delayed behind element.currentTime. Steer toward a target that
   * accounts for that latency so we don't perpetually chase a phantom ~500–700 ms gap.
   */
  /**
   * Auto-measure the device's true output latency (element position → what's actually
   * heard) so we can steer the element ahead by exactly that much — fully automatic, no
   * user calibration (this is BYOD).
   *
   * Primary signal: getOutputTimestamp() — (currentTime − contextTime) is the full
   * scheduling→output delay and reflects the REAL output path, INCLUDING Bluetooth
   * (which varies 100–300 ms and no fixed constant could cover). Fallback: outputLatency
   * (flaky — reads 0 on iOS Safari, and 0 until warmup even on Chrome). Last resort on
   * iOS, where both can read 0: a conservative default so audio isn't left uncompensated.
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
    if (L == null && IS_IOS && this.measuredLatencySec < 0.02) {
      L = IOS_FALLBACK_LATENCY_SEC
    }
    if (L == null) return
    L = Math.min(MAX_LATENCY_SEC, Math.max(0, L))
    this.measuredLatencySec = this.measuredLatencySec
      ? this.measuredLatencySec * (1 - LATENCY_EMA_ALPHA) + L * LATENCY_EMA_ALPHA
      : L
  }

  private outputLatencySec(): number {
    return this.routed ? this.measuredLatencySec : 0
  }
  get autoLatencyMs(): number {
    return this.outputLatencySec() * 1000
  }

  private steerTarget(targetSec: number, dur: number): number {
    const shift = this.outputLatencySec()
    if (shift <= 0) return targetSec
    return (((targetSec + shift) % dur) + dur) % dur
  }

  private setPlaybackRate(rate: number): void {
    if (Math.abs(rate - this.lastAppliedRate) <= RATE_EPS) return
    this.el.playbackRate = rate
    this.lastAppliedRate = rate
  }

  /** iOS often freezes `currentTime` after a seek; advance an internal clock when that happens. */
  private sampleLocalSec(): number {
    const observed = this.el.currentTime
    const now = Date.now()
    if (this.el.paused || this.lastTrackAt === 0) {
      this.trackedSec = observed
      this.lastTrackAt = now
      return observed
    }
    if (observed > this.trackedSec + TRACK_EPS_SEC) {
      this.trackedSec = observed
      this.lastTrackAt = now
      return observed
    }
    const dt = (now - this.lastTrackAt) / 1000
    this.trackedSec += dt * this.lastAppliedRate
    this.lastTrackAt = now
    return this.trackedSec
  }

  private syncTrackedSec(sec: number): void {
    this.trackedSec = sec
    this.lastTrackAt = Date.now()
  }

  correct(targetSec: number | null, playing: boolean): CorrectionInfo {
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

    if (
      settled &&
      cooldownElapsed &&
      Math.abs(rawDrift) > HARD_SEEK_SEC &&
      Math.abs(drift) > HARD_SEEK_SEC * 0.75
    ) {
      const seekTo = aim
      try {
        this.el.currentTime = seekTo
      } catch {
        /* not seekable yet */
      }
      this.syncTrackedSec(seekTo)
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
    this.smoothedDriftSec = 0
    this.lastSeekAt = 0
    this.seekSettleUntil = 0
    this.trackedSec = this.el.currentTime
    this.lastTrackAt = Date.now()
  }

  stop(): void {
    this.hardStopped = true
    this.el.pause()
    this.el.playbackRate = 1
    this.lastAppliedRate = 1
    this.trackedSec = 0
    this.lastTrackAt = 0
    this.seekSettleUntil = 0
  }
}
