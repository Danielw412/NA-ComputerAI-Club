/**
 * Offline tuner for auto-threshold mode.  Run: npm run tune
 *
 * Generates synthetic arm-pump signals with KNOWN ground-truth rep counts,
 * sweeps the auto-mode parameters, and reports which settings track real
 * players most accurately. This is why the dev panel has no dials to fiddle
 * with in auto mode: the tuning happens here, against reproducible scenarios,
 * instead of by eye at a noisy venue.
 *
 * Ground truth: the signal is a raised cosine whose phase advances at the pump
 * frequency. One completed cycle == one rep for that wrist.
 */
import { PlayerRepCounter, DEFAULT_REP_CONFIG, type RepConfig } from '../src/lib/pose/repCounter.ts'
import type { PoseMetrics } from '../src/lib/pose/landmarks.ts'

const FPS = 30
const DT = 1000 / FPS

/** Deterministic PRNG so runs are reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Scenario {
  name: string
  durationMs: number
  /** amplitude in torso lengths at time t */
  amp: (t: number) => number
  /** pump frequency in Hz at time t */
  freq: (t: number) => number
  /** vertical offset - simulates a wrist that rides low (shoulder tilt) */
  base?: number
  noise?: number
  /** fraction of frames where the pose is lost entirely */
  dropout?: number
  /** true when the player is not really pumping; any rep is a false positive */
  still?: boolean
}

const SCENARIOS: Scenario[] = [
  { name: 'steady fast overhead', durationMs: 20000, amp: () => 0.9, freq: () => 3.5 },
  { name: 'steady chest-height', durationMs: 20000, amp: () => 0.30, freq: () => 3.5 },
  { name: 'tiny pumps', durationMs: 20000, amp: () => 0.18, freq: () => 4 },
  { name: 'slow deliberate', durationMs: 20000, amp: () => 1.0, freq: () => 1.2 },
  { name: 'very fast', durationMs: 20000, amp: () => 0.7, freq: () => 6 },
  {
    name: 'fatigue ramp',
    durationMs: 20000,
    amp: (t) => 1.0 - 0.65 * (t / 20000),
    freq: (t) => 4.5 - 2.0 * (t / 20000),
  },
  {
    name: 'sudden amplitude drop',
    durationMs: 20000,
    amp: (t) => (t < 8000 ? 1.0 : 0.3),
    freq: () => 3.5,
  },
  { name: 'low-riding arm (tilt)', durationMs: 20000, amp: () => 0.6, freq: () => 3.5, base: -0.45 },
  { name: 'noisy tracking', durationMs: 20000, amp: () => 0.7, freq: () => 3.5, noise: 0.05 },
  { name: 'dropouts', durationMs: 20000, amp: () => 0.8, freq: () => 3.5, dropout: 0.15 },
  { name: 'very slow big pumps', durationMs: 20000, amp: () => 1.4, freq: () => 0.6 },
  { name: 'languid stretch', durationMs: 20000, amp: () => 1.8, freq: () => 0.35 },
  { name: 'heavy noise', durationMs: 20000, amp: () => 0.7, freq: () => 3.5, noise: 0.10 },
  { name: 'STILL (false positives)', durationMs: 20000, amp: () => 0, freq: () => 0, noise: 0.03, still: true },
  { name: 'STILL arms raised', durationMs: 20000, amp: () => 0, freq: () => 0, base: 0.9, noise: 0.03, still: true },
  { name: 'STILL very noisy', durationMs: 20000, amp: () => 0, freq: () => 0, noise: 0.07, still: true },
  { name: 'STILL micro-fidget', durationMs: 20000, amp: () => 0.05, freq: () => 1.2, noise: 0.02, still: true },
  { name: 'STILL talking/gesturing', durationMs: 20000, amp: () => 0.09, freq: () => 0.6, noise: 0.03, still: true },
]

interface Run {
  counted: number
  truth: number
}

function simulate(sc: Scenario, cfg: RepConfig, seed = 1): Run {
  const rand = mulberry32(seed)
  const counter = new PlayerRepCounter()
  let phase = 0
  let truth = 0
  const noise = sc.noise ?? 0
  const base = sc.base ?? 0

  for (let t = 0; t < sc.durationMs; t += DT) {
    const f = sc.freq(t)
    const prevPhase = phase
    phase += (f * DT) / 1000
    if (Math.floor(phase) > Math.floor(prevPhase)) truth++

    const a = sc.amp(t)
    const h = base + a * (0.5 - 0.5 * Math.cos(2 * Math.PI * phase)) + (rand() - 0.5) * 2 * noise

    const lost = sc.dropout ? rand() < sc.dropout : false
    const m: PoseMetrics = {
      valid: !lost,
      scale: 0.3,
      scaleSource: 'torso',
      torsoCenterX: 0.5,
      screenX: 0.5,
      left: { h, visibility: 0.9, usable: !lost },
      right: { h, visibility: 0.9, usable: !lost },
    }
    counter.update(m, t, cfg)
  }
  // Only the left wrist is scored here; both see the identical signal.
  return { counted: counter.debug('left').count, truth: sc.still ? 0 : truth }
}

/** Total absolute error across scenarios, with false positives weighted hard. */
function score(cfg: RepConfig): { err: number; rows: string[] } {
  let err = 0
  const rows: string[] = []
  for (const sc of SCENARIOS) {
    let e = 0
    let counted = 0
    let truth = 0
    for (let seed = 1; seed <= 3; seed++) {
      const r = simulate(sc, cfg, seed)
      counted += r.counted
      truth += r.truth
      // A phantom rep on a still player is worse than a missed rep on a real one.
      e += sc.still ? r.counted * 3 : Math.abs(r.counted - r.truth)
    }
    err += e / 3
    const pct = truth > 0 ? ((counted / truth) * 100).toFixed(0) + '%' : '-'
    rows.push(
      `    ${sc.name.padEnd(24)} counted ${String(Math.round(counted / 3)).padStart(3)}` +
        ` / truth ${String(Math.round(truth / 3)).padStart(3)}  (${pct})`,
    )
  }
  return { err, rows }
}

const windows = [300, 400, 500, 700, 900, 1200, 1600, 2200]
const fracs: Array<[number, number]> = [
  [0.6, 0.4],
  [0.65, 0.35],
  [0.7, 0.3],
  [0.75, 0.25],
  [0.8, 0.2],
]
const minRanges = [0.06, 0.09, 0.12, 0.16]

let best: { cfg: RepConfig; err: number } | null = null
const results: Array<{ cfg: RepConfig; err: number }> = []

for (const autoWindowMs of windows) {
  for (const [autoUpFrac, autoDownFrac] of fracs) {
    for (const autoMinRange of minRanges) {
      const cfg: RepConfig = {
        ...DEFAULT_REP_CONFIG,
        mode: 'auto',
        autoWindowMs,
        autoUpFrac,
        autoDownFrac,
        autoMinRange,
      }
      const { err } = score(cfg)
      results.push({ cfg, err })
      if (!best || err < best.err) best = { cfg, err }
    }
  }
}

results.sort((a, b) => a.err - b.err)
console.log('Top 10 configurations (lower error is better):\n')
for (const r of results.slice(0, 10)) {
  const c = r.cfg
  console.log(
    `  err ${r.err.toFixed(1).padStart(7)}   window ${String(c.autoWindowMs).padStart(4)}ms` +
      `  up ${c.autoUpFrac}  down ${c.autoDownFrac}  minRange ${c.autoMinRange}`,
  )
}

console.log('\nPer-scenario detail for the winner:')
const winner = best!.cfg
console.log(
  `  window ${winner.autoWindowMs}ms  up ${winner.autoUpFrac}  down ${winner.autoDownFrac}` +
    `  minRange ${winner.autoMinRange}\n`,
)
console.log(score(winner).rows.join('\n'))

console.log('\nCurrent DEFAULT_REP_CONFIG for comparison:')
const cur = score({ ...DEFAULT_REP_CONFIG, mode: 'auto' })
console.log(`  err ${cur.err.toFixed(1)}`)
console.log(cur.rows.join('\n'))

console.log('\nHand-picked robust candidates:')
const candidates: Array<[string, Partial<RepConfig>]> = [
  ['w300 .60/.40 mr.16', { autoWindowMs: 300, autoUpFrac: 0.6, autoDownFrac: 0.4, autoMinRange: 0.16 }],
  ['w500 .65/.35 mr.12', { autoWindowMs: 500, autoUpFrac: 0.65, autoDownFrac: 0.35, autoMinRange: 0.12 }],
  ['w500 .65/.35 mr.16', { autoWindowMs: 500, autoUpFrac: 0.65, autoDownFrac: 0.35, autoMinRange: 0.16 }],
  ['w700 .65/.35 mr.14', { autoWindowMs: 700, autoUpFrac: 0.65, autoDownFrac: 0.35, autoMinRange: 0.14 }],
  ['w700 .70/.30 mr.14', { autoWindowMs: 700, autoUpFrac: 0.7, autoDownFrac: 0.3, autoMinRange: 0.14 }],
  ['w900 .65/.35 mr.14', { autoWindowMs: 900, autoUpFrac: 0.65, autoDownFrac: 0.35, autoMinRange: 0.14 }],
]
for (const [label, patch] of candidates) {
  const c = { ...DEFAULT_REP_CONFIG, mode: 'auto' as const, ...patch }
  const r = score(c)
  const worst = r.rows
    .map((row) => row.trim())
    .filter((row) => !row.includes('100%') && !row.includes('(-)'))
  console.log(`  ${label.padEnd(20)} err ${r.err.toFixed(1).padStart(6)}   ${worst.join(' | ') || 'all exact'}`)
}

console.log('\nFixed-threshold (manual 0.35/0.15) for comparison:')
const man = score({ ...DEFAULT_REP_CONFIG, mode: 'manual' })
console.log(`  err ${man.err.toFixed(1)}`)
console.log(man.rows.join('\n'))
