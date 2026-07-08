/**
 * Unit checks for the pure sync math. Run: `node test/sync-sim.ts` (Node 24 type-strip).
 */
import {
  estimateOffset,
  bestOffset,
  computeTarget,
  signedDrift,
  correctionRate,
  type Beat,
} from '../src/sync/sync-math.ts'

let failures = 0
function assert(cond: boolean, label: string) {
  if (cond) console.log(`  ✓ ${label}`)
  else {
    console.error(`  ✗ FAIL: ${label}`)
    failures++
  }
}
const close = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol

console.log('\n[1] estimateOffset (Cristian) + bestOffset')
{
  const s = estimateOffset(1000, 5000, 1040)
  assert(close(s.rtt, 40), `rtt = 40 (got ${s.rtt})`)
  assert(close(s.offset, 3980), `offset = 3980 (got ${s.offset})`)
  const best = bestOffset([
    { rtt: 120, offset: 900 },
    { rtt: 30, offset: 1000 },
    { rtt: 80, offset: 950 },
  ])
  assert(best!.rtt === 30 && best!.offset === 1000, 'bestOffset picks lowest-RTT sample')
  assert(bestOffset([]) === null, 'bestOffset([]) === null')
}

console.log('\n[2] computeTarget (extrapolation + loop wrap)')
{
  const beat: Beat = { videoTime: 5, wall: 1000, playing: true, duration: 20 }
  assert(close(computeTarget(beat, 0, 1700), 5.7), 'linear: 5 + 0.7s = 5.7')
  const nearEnd: Beat = { videoTime: 19.5, wall: 1000, playing: true, duration: 20 }
  assert(close(computeTarget(nearEnd, 0, 1700), 0.2, 1e-6), 'wrap: 19.5 + 0.7 = 0.2')
  assert(close(computeTarget(nearEnd, 300, 1700), 0.5, 1e-6), 'clock offset applied (+0.3s)')
  const paused: Beat = { videoTime: 12.3, wall: 1000, playing: false, duration: 20 }
  assert(close(computeTarget(paused, 0, 9999), 12.3), 'paused: stays at videoTime')
}

console.log('\n[3] signedDrift (loop-aware, sign = local relative to target)')
{
  assert(close(signedDrift(5.0, 4.7, 20), 0.3), 'ahead by 0.3 → +0.3')
  assert(close(signedDrift(4.7, 5.0, 20), -0.3), 'behind by 0.3 → -0.3')
  // local just before wrap, target just after → local is BEHIND by 0.2 (not ahead by 19.8)
  const d = signedDrift(19.9, 0.1, 20)
  assert(close(d, -0.2, 1e-6), `loop seam: 19.9 vs 0.1 → -0.2 (got ${d.toFixed(3)})`)
  const d2 = signedDrift(0.1, 19.9, 20)
  assert(close(d2, 0.2, 1e-6), `loop seam other way: 0.1 vs 19.9 → +0.2 (got ${d2.toFixed(3)})`)
}

console.log('\n[4] correctionRate (sign + clamp)')
{
  assert(close(correctionRate(0), 1), 'no drift → rate 1')
  assert(correctionRate(0.05) < 1, 'ahead → slow down (<1)')
  assert(correctionRate(-0.05) > 1, 'behind → speed up (>1)')
  assert(close(correctionRate(0.05), 0.96), 'small ahead: 1 - 0.05*0.8 = 0.96')
  assert(correctionRate(5) === 0.94, 'large ahead clamps to 0.94')
  assert(correctionRate(-5) === 1.06, 'large behind clamps to 1.06')
}

console.log(`\n${failures === 0 ? '✅ ALL PASSED' : `❌ ${failures} FAILURE(S)`}\n`)
process.exit(failures === 0 ? 0 : 1)
