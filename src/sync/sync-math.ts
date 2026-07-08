/**
 * Pure, unit-testable sync helpers. No DOM, no transport.
 *
 * The screen (leader) periodically emits a Beat carrying where its looping video is and
 * the screen wall-clock at that instant. A follower estimates the screen↔follower clock
 * offset (Cristian's algorithm), extrapolates the screen's current video position, and
 * computes a signed, loop-aware drift for its local audio — then either hard-seeks or
 * nudges playbackRate to close it.
 */

export interface Beat {
  mediaId: string // which video the screen is playing (→ follower loads the matching audio)
  videoTime: number // screen's video.currentTime captured at `wall`
  wall: number // screen's Date.now() when the beat was emitted
  playing: boolean
  duration: number // loop length (video duration), seconds
}

export interface ClockSample {
  rtt: number // round-trip time, ms
  offset: number // add to a follower Date.now() to get the screen's clock, ms
}

/**
 * Cristian's algorithm. `t0`/`t2` are follower-clock ms (send/receive); `tScreen` is the
 * screen-clock ms stamped when it replied. Returns RTT and the clock offset.
 */
export function estimateOffset(t0: number, tScreen: number, t2: number): ClockSample {
  const rtt = Math.max(0, t2 - t0)
  const offset = tScreen - (t0 + t2) / 2
  return { rtt, offset }
}

/** The least-jittered estimate is the sample with the smallest RTT. */
export function bestOffset(samples: readonly ClockSample[]): ClockSample | null {
  if (samples.length === 0) return null
  return samples.reduce((a, b) => (b.rtt < a.rtt ? b : a))
}

/**
 * Where the screen's video is *right now*, wrapped into [0, duration).
 * `now` and `offsetMs` are in follower terms; `beat.wall` is in screen terms.
 */
export function computeTarget(beat: Beat, offsetMs: number, now: number): number {
  const elapsedSec = (now + offsetMs - beat.wall) / 1000
  const raw = beat.videoTime + (beat.playing ? Math.max(0, elapsedSec) : 0)
  const d = beat.duration
  if (!isFinite(d) || d <= 0) return Math.max(0, raw)
  return ((raw % d) + d) % d
}

/**
 * Signed shortest distance from `local` to `target` around a loop of `duration`.
 * Positive ⇒ local is AHEAD of target (audio should slow down to let target catch up).
 * Handles the loop seam (e.g. local 19.9, target 0.1, duration 20 ⇒ +0.2, not +19.8).
 */
export function signedDrift(local: number, target: number, duration: number): number {
  if (!isFinite(duration) || duration <= 0) return local - target
  const half = duration / 2
  return ((((local - target + half) % duration) + duration) % duration) - half
}

/**
 * Playback rate that gently closes a small drift.
 * `driftSec` > 0 (ahead) ⇒ rate < 1 (slow down); < 0 (behind) ⇒ rate > 1 (speed up).
 */
export function correctionRate(driftSec: number, gain = 0.8, min = 0.94, max = 1.06): number {
  const rate = 1 - driftSec * gain
  return Math.min(max, Math.max(min, rate))
}
