/**
 * iOS follower audio engine: plays the soundtrack from a decoded AudioBuffer scheduled on
 * the AudioContext clock instead of an <audio> element. Safari's media-element pipeline
 * stalls for >1s on every seek and spontaneously mid-playback, which defeated every
 * element-side compensation strategy. Buffer playback has no such pipeline:
 *  - repositioning = swapping in a new AudioBufferSourceNode at an exact offset (cheap,
 *    sample-accurate, no stall),
 *  - rate nudges are honored (playbackRate is an AudioParam Safari respects),
 *  - output ignores the hardware mute switch, same as the element+WebAudio routing did.
 */
import { signedDrift, correctionRate } from '../sync/sync-math'
import type { CorrectionInfo, CorrectionMode } from './audio-sync-controller'

const HARD_RESTART_SEC = 0.25 // reposition instead of nudging beyond this drift
const RESTART_COOLDOWN_MS = 800 // keep repositions from thrashing
const SCHEDULE_AHEAD_SEC = 0.03 // start new sources slightly ahead so the clock mapping is exact
const LOCK_DEADBAND_SEC = 0.04
const LOCKED_SEC = 0.02
const DRIFT_EMA_ALPHA = 0.25
const RATE_EPS = 0.002
const RATE_GAIN = 0.5
const RATE_MIN = 0.98 // buffer sources don't preserve pitch — keep nudges subtle
const RATE_MAX = 1.02
const MAX_LATENCY_SEC = 0.5
const LATENCY_EMA_ALPHA = 0.2
const FALLBACK_LATENCY_SEC = 0.12 // iOS often reports no latency at all

export class BufferAudioEngine {
  private ctx: AudioContext | null = null
  private buffer: AudioBuffer | null = null
  private bufferUrl: string | null = null // url the decoded buffer belongs to
  private loadingUrl: string | null = null
  private desiredUrl: string | null = null
  private src: AudioBufferSourceNode | null = null
  // Clock mapping for the current source segment: position = startOffset + (ctxNow - startCtxTime) * rate
  private startCtxTime = 0
  private startOffset = 0
  private rate = 1
  private smoothedDriftSec = 0
  private lastRestartAt = 0
  private measuredLatencySec = 0
  private hardStopped = false
  private readonly onLoadFailed: (url: string) => void
  unlocked = false

  constructor(onLoadFailed: (url: string) => void) {
    this.onLoadFailed = onLoadFailed
  }

  /**
   * Must be called inside the join tap. Everything that needs the gesture (context
   * creation, resume, priming a silent source) happens synchronously before any await.
   */
  unlock(): Promise<void> {
    this.hardStopped = false
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return Promise.reject(new Error('Web Audio unavailable'))
    if (!this.ctx) this.ctx = new Ctx()
    // Prime output inside the gesture with a one-frame silent buffer.
    try {
      const silent = this.ctx.createBuffer(1, 1, this.ctx.sampleRate)
      const s = this.ctx.createBufferSource()
      s.buffer = silent
      s.connect(this.ctx.destination)
      s.start()
    } catch {
      /* priming is best-effort */
    }
    const resume = this.ctx.state !== 'running' ? this.ctx.resume() : Promise.resolve()
    this.unlocked = true
    return resume.catch(() => {})
  }

  resume(): void {
    if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {})
  }

  setSource(url: string): void {
    if (!url) return
    this.desiredUrl = url
    this.load(url) // dedupes internally; retries if the context wasn't ready yet
  }

  hasBufferFor(url: string): boolean {
    return this.buffer != null && this.bufferUrl === url
  }

  private load(url: string): void {
    if (this.bufferUrl === url || this.loadingUrl === url || !this.ctx) return
    this.loadingUrl = url
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`fetch ${r.status}`)
        return r.arrayBuffer()
      })
      .then((ab) => this.ctx!.decodeAudioData(ab))
      .then((buf) => {
        if (this.desiredUrl !== url) return
        this.buffer = buf
        this.bufferUrl = url
        this.stopSource() // next correct() starts playback at the live target
      })
      .catch(() => {
        if (this.desiredUrl === url) this.onLoadFailed(url)
      })
      .finally(() => {
        if (this.loadingUrl === url) this.loadingUrl = null
      })
  }

  private stopSource(): void {
    if (this.src) {
      try {
        this.src.stop()
      } catch {
        /* already stopped */
      }
      this.src.disconnect()
      this.src = null
    }
  }

  private positionSec(ctxNow: number): number {
    const dur = this.buffer!.duration
    const raw = this.startOffset + (ctxNow - this.startCtxTime) * this.rate
    return ((raw % dur) + dur) % dur
  }

  /** Swap in a fresh source node starting at `offset`, scheduled slightly ahead for exactness. */
  private startAt(offset: number, ctxNow: number): void {
    const ctx = this.ctx!
    const buf = this.buffer!
    const dur = buf.duration
    this.stopSource()
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.loop = true
    src.loopStart = 0
    src.loopEnd = dur
    src.connect(ctx.destination)
    const when = ctxNow + SCHEDULE_AHEAD_SEC
    const startOffset = (((offset + SCHEDULE_AHEAD_SEC) % dur) + dur) % dur
    src.start(when, startOffset)
    this.src = src
    this.startCtxTime = when
    this.startOffset = startOffset
    this.rate = 1
    this.smoothedDriftSec = 0
    this.lastRestartAt = Date.now()
  }

  private setRate(rate: number, ctxNow: number): void {
    if (!this.src || Math.abs(rate - this.rate) <= RATE_EPS) return
    // Re-anchor the clock mapping at the moment the rate changes.
    this.startOffset = this.positionSec(ctxNow)
    this.startCtxTime = ctxNow
    this.rate = rate
    this.src.playbackRate.value = rate
  }

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
    if (L == null && this.measuredLatencySec < 0.02) L = FALLBACK_LATENCY_SEC
    if (L == null) return
    L = Math.min(MAX_LATENCY_SEC, Math.max(0, L))
    this.measuredLatencySec = this.measuredLatencySec
      ? this.measuredLatencySec * (1 - LATENCY_EMA_ALPHA) + L * LATENCY_EMA_ALPHA
      : L
  }

  get autoLatencyMs(): number {
    return this.measuredLatencySec * 1000
  }

  get currentTimeSec(): number {
    if (!this.ctx || !this.buffer || !this.src) return 0
    return this.positionSec(this.ctx.currentTime)
  }

  get duration(): number {
    return this.buffer?.duration ?? NaN
  }

  correct(targetSec: number | null, playing: boolean): CorrectionInfo {
    if (this.hardStopped) {
      this.stopSource()
      return { mode: 'idle', driftMs: 0, rate: 1 }
    }
    if (!this.ctx || !this.buffer) {
      if (this.desiredUrl) this.load(this.desiredUrl)
      return { mode: 'idle', driftMs: 0, rate: 1 }
    }
    if (targetSec == null || !playing) {
      this.stopSource()
      return { mode: 'idle', driftMs: 0, rate: 1 }
    }

    this.resume()
    this.sampleOutputLatency()
    const dur = this.buffer.duration
    const ctxNow = this.ctx.currentTime
    const aim = (((targetSec + this.measuredLatencySec) % dur) + dur) % dur

    if (!this.src) {
      this.startAt(aim, ctxNow)
      return { mode: 'seek', driftMs: 0, rate: 1 }
    }

    const pos = this.positionSec(ctxNow)
    const rawDrift = signedDrift(pos, aim, dur)
    this.smoothedDriftSec =
      DRIFT_EMA_ALPHA * rawDrift + (1 - DRIFT_EMA_ALPHA) * this.smoothedDriftSec
    const drift = this.smoothedDriftSec
    const now = Date.now()

    if (Math.abs(rawDrift) > HARD_RESTART_SEC && now - this.lastRestartAt >= RESTART_COOLDOWN_MS) {
      this.startAt(aim, ctxNow)
      return { mode: 'seek', driftMs: rawDrift * 1000, rate: 1 }
    }

    if (Math.abs(drift) < LOCK_DEADBAND_SEC) {
      this.setRate(1, ctxNow)
      return {
        mode: (Math.abs(rawDrift) < LOCKED_SEC ? 'locked' : 'nudge') as CorrectionMode,
        driftMs: rawDrift * 1000,
        rate: 1,
      }
    }

    const rate = correctionRate(drift, RATE_GAIN, RATE_MIN, RATE_MAX)
    this.setRate(rate, ctxNow)
    return {
      mode: (Math.abs(rawDrift) < LOCKED_SEC ? 'locked' : 'nudge') as CorrectionMode,
      driftMs: rawDrift * 1000,
      rate: this.rate,
    }
  }

  resync(): void {
    this.smoothedDriftSec = 0
    this.lastRestartAt = 0
    this.stopSource() // next correct() restarts at the live target
  }

  stop(): void {
    this.hardStopped = true
    this.stopSource()
  }
}
