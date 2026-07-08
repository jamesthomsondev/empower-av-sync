/**
 * Follower-side audio: plays the local soundtrack and continuously corrects it toward the
 * screen's video position. Small drifts are closed by nudging `playbackRate` (pitch
 * preserved) so there's no audible jump; large drifts (including a loop wrap) hard-seek.
 *
 * iOS autoplay gate: unlock() must run inside the join tap (fires play() before any await).
 */
import { SYNTH_SOUNDTRACK_URL } from '../content'
import { signedDrift, correctionRate } from '../sync/sync-math'

const HARD_SEEK_SEC = 0.45 // snap when drift is clearly uncorrectable by rate alone
const SEEK_COOLDOWN_MS = 8000 // iOS seeks stall playback — keep them rare
const SEEK_SETTLE_MS = 400 // after a hard seek, let iOS resume before re-steering
const LOCK_DEADBAND_SEC = 0.12 // hold rate=1 inside this band
const LOCKED_SEC = 0.02 // UI "locked" threshold (tighter than the correction deadband)
const DRIFT_EMA_ALPHA = 0.25 // smooth noisy drift samples before steering
const RATE_EPS = 0.003 // skip playbackRate writes that wouldn't audibly change
const TRACK_EPS_SEC = 0.003 // element time must advance by this much to be trusted
const RATE_GAIN = 0.5
const RATE_MIN = 0.97
const RATE_MAX = 1.03

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
  private routed = false
  private hardStopped = false
  private smoothedDriftSec = 0
  private lastSeekAt = 0
  private lastAppliedRate = 1
  private trackedSec = 0
  private lastTrackAt = 0
  private seekSettleUntil = 0
  unlocked = false

  constructor() {
    // Prime with the synthetic soundtrack so unlock() has something to play; the actual
    // track is swapped in via setSource() once we know which video the screen selected.
    const el = new Audio(SYNTH_SOUNDTRACK_URL)
    el.loop = true
    el.preload = 'auto'
    // Preserve pitch while we speed/slow to correct drift.
    el.preservesPitch = true
    const anyEl = el as unknown as Record<string, unknown>
    anyEl.mozPreservesPitch = true
    anyEl.webkitPreservesPitch = true
    this.el = el
    this.currentUrl = SYNTH_SOUNDTRACK_URL
  }

  /** Swap the soundtrack (keeps the same, already-unlocked element). No-op if unchanged. */
  setSource(url: string): void {
    if (!url || url === this.currentUrl) return
    this.currentUrl = url
    this.el.src = url // triggers a reload; the corrector re-seeks on the next tick
    this.trackedSec = 0
    this.lastTrackAt = 0
    this.smoothedDriftSec = 0
  }

  get currentTimeSec(): number {
    return this.el.currentTime
  }
  get duration(): number {
    return this.el.duration
  }
  /** True once the element is routed through Web Audio (ignores the iOS mute switch). */
  get routedThroughWebAudio(): boolean {
    return this.routed
  }

  /**
   * Call inside a real user gesture (the join tap).
   *
   * Besides satisfying the autoplay gate, we route the element through a Web Audio
   * graph. On iOS a bare <audio>/<video> element is "ambient" audio and is silenced by
   * the ringer/mute switch (and in silent mode) — playback keeps advancing but you hear
   * nothing. Audio played through the Web Audio API is NOT subject to that switch, so
   * connecting the element to an AudioContext makes it audible on iOS regardless. The
   * context must be created + resumed inside the gesture.
   */
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
          // createMediaElementSource may only be called once per element.
          this.ctx.createMediaElementSource(this.el).connect(this.ctx.destination)
          this.routed = true
        } catch {
          this.routed = false // routing unsupported; fall back to the bare element
        }
      }

      // Fire play() + resume() inside the gesture (before any long await).
      this.el.muted = false
      const playPromise = this.el.play()
      const resumePromise =
        this.ctx && this.ctx.state === 'suspended' ? this.ctx.resume() : Promise.resolve()
      await Promise.allSettled([playPromise, resumePromise])

      this.el.pause()
      this.el.currentTime = 0
      this.unlocked = true
    } catch {
      this.unlocked = true
    }
  }

  /** Re-resume the Web Audio context (iOS suspends it when backgrounded). Safe to call often. */
  resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {})
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

  /** Steer local audio toward `targetSec` (screen position). Returns info for the UI. */
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
      void this.el.play().catch(() => {}) // metadata not ready yet
      return { mode: 'idle', driftMs: 0, rate: this.lastAppliedRate }
    }

    if (this.el.paused) void this.el.play().catch(() => {})

    const localSec = this.sampleLocalSec()
    const rawDrift = signedDrift(localSec, targetSec, dur) // + = ahead
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
      const seekTo = ((targetSec % dur) + dur) % dur
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

  /** Drop corrector state after reconnect / wake so a hard seek can run immediately. */
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
