/**
 * Rep counter regression tests. Run: npm test
 *
 * These drive the state machine with synthetic `h` trajectories, so they check
 * the counting rules themselves — auto-calibration, hysteresis, debounce,
 * dropout handling — without needing a camera or a human waving their arms.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PlayerRepCounter, DEFAULT_REP_CONFIG, type RepConfig } from './repCounter.ts'
import { computePoseMetrics, LM, ScaleRatioEstimator, type PoseMetrics } from './landmarks.ts'
import type { NormalizedLandmark } from '@mediapipe/tasks-vision'

const AUTO: RepConfig = DEFAULT_REP_CONFIG
const MANUAL: RepConfig = { ...DEFAULT_REP_CONFIG, mode: 'manual' }

function metrics(
  hLeft: number,
  hRight: number,
  opts: { valid?: boolean; usable?: boolean } = {},
): PoseMetrics {
  const usable = opts.usable ?? true
  return {
    valid: opts.valid ?? true,
    scale: 0.3,
    scaleSource: 'torso',
    torsoCenterX: 0.5,
    screenX: 0.5,
    left: { h: hLeft, visibility: 0.9, usable },
    right: { h: hRight, visibility: 0.9, usable },
  }
}

/** One pump: up past the top, back down to rest. `base` shifts the whole arc. */
function pump(c: PlayerRepCounter, startT: number, cfg: RepConfig, base = 0, amp = 1): number {
  const path = [0, 0.2, 0.45, 0.6, 0.45, 0.2, 0.0]
  let t = startT
  for (const p of path) {
    const h = base + p * amp
    c.update(metrics(h, h), t, cfg)
    t += 16
  }
  return t
}

// ---------------------------------------------------------------- manual mode

test('manual: counts one rep per wrist per pump', () => {
  const c = new PlayerRepCounter()
  let t = 0
  for (let i = 0; i < 10; i++) t = pump(c, t, MANUAL)
  assert.equal(c.count, 20)
  assert.equal(c.timeline.length, 20)
})

test('manual: a rep lands on the way down, not on the way up', () => {
  const c = new PlayerRepCounter()
  c.update(metrics(0.9, 0.9), 0, MANUAL)
  assert.equal(c.count, 0, 'raising the arms alone is not a rep')
  c.update(metrics(0.0, 0.0), 100, MANUAL)
  assert.equal(c.count, 2)
})

test('manual: hysteresis rejects jitter between the thresholds', () => {
  const c = new PlayerRepCounter()
  let t = 0
  c.update(metrics(0.6, 0.6), t, MANUAL)
  for (let i = 0; i < 200; i++) {
    const h = 0.16 + (i % 2) * 0.18 // oscillates 0.16 <-> 0.34, never crossing
    c.update(metrics(h, h), (t += 16), MANUAL)
  }
  assert.equal(c.count, 0)
})

test('manual: debounce suppresses counts faster than the window', () => {
  const c = new PlayerRepCounter()
  let t = 0
  c.update(metrics(0.6, 0.6), t, MANUAL)
  c.update(metrics(0.0, 0.0), (t += 10), MANUAL)
  assert.equal(c.count, 2)
  c.update(metrics(0.6, 0.6), (t += 10), MANUAL)
  c.update(metrics(0.0, 0.0), (t += 10), MANUAL) // 20ms after the last count
  assert.equal(c.count, 2, 'second cycle inside the debounce window must not count')
})

// ------------------------------------------------------------------ auto mode

test('auto: counts chest-height pumps that fixed thresholds would miss', () => {
  // Peak h ~0.30 — never reaches the fixed UP_THRESHOLD of 0.35.
  const manual = new PlayerRepCounter()
  const auto = new PlayerRepCounter()
  let t = 0
  for (let i = 0; i < 6; i++) t = pump(manual, t, MANUAL, 0, 0.5)
  t = 0
  for (let i = 0; i < 6; i++) t = pump(auto, t, AUTO, 0, 0.5)

  assert.equal(manual.count, 0, 'fixed thresholds miss a short pump entirely')
  assert.ok(auto.count >= 10, `auto should catch them, got ${auto.count}`)
})

test('auto: a constant offset between arms does not stop one from counting', () => {
  // This is the reported bug: one wrist sits systematically lower than the
  // other (shoulder tilt), so a shared absolute threshold catches only one arm.
  const manual = new PlayerRepCounter()
  const auto = new PlayerRepCounter()
  const OFFSET = 0.3
  const path = [0, 0.2, 0.45, 0.6, 0.45, 0.2, 0.0]

  for (const [counter, cfg] of [[manual, MANUAL], [auto, AUTO]] as const) {
    let t = 0
    for (let i = 0; i < 6; i++) {
      for (const p of path) {
        counter.update(metrics(p, p - OFFSET), t, cfg)
        t += 16
      }
    }
  }

  assert.ok(manual.debug('left').count > 0, 'left arm counts under manual')
  assert.equal(manual.debug('right').count, 0, 'offset right arm never crosses the fixed threshold')
  assert.ok(auto.debug('left').count >= 5, 'auto counts the left arm')
  assert.ok(auto.debug('right').count >= 5, 'auto counts the offset right arm too')
})

test('auto: a still player scores nothing from sensor noise', () => {
  const c = new PlayerRepCounter()
  let t = 0
  for (let i = 0; i < 400; i++) {
    const noise = Math.sin(i * 1.7) * 0.02 // +/-0.02 torso lengths of jitter
    c.update(metrics(noise, -noise), (t += 16), AUTO)
  }
  assert.equal(c.count, 0, 'range below autoMinRange must not arm the trigger')
  assert.equal(c.debug('left').armed, false)
})

test('auto: calibrates on the first pump and counts it', () => {
  const c = new PlayerRepCounter()
  pump(c, 0, AUTO)
  assert.equal(c.count, 2, 'the very first pump should already register')
})

test('auto: recovers within about one window when the player tires', () => {
  const c = new PlayerRepCounter()
  let t = 0
  for (let i = 0; i < 5; i++) t = pump(c, t, AUTO, 0, 1.0) // big pumps
  const afterBig = c.count
  assert.ok(afterBig >= 8, `big pumps counted, got ${afterBig}`)

  // Amplitude collapses to a third. The sliding window still holds the old
  // peaks, so counting pauses for up to autoWindowMs — that is the designed
  // trade-off, not a bug. Give it one window plus a margin.
  const settleUntil = t + AUTO.autoWindowMs
  while (t < settleUntil) t = pump(c, t, AUTO, 0, 0.35)
  const afterSettle = c.count

  for (let i = 0; i < 8; i++) t = pump(c, t, AUTO, 0, 0.35)
  assert.ok(
    c.count > afterSettle + 10,
    `small pumps must count again once the window has turned over, got ${c.count - afterSettle}`,
  )
})

test('auto: a wrist that rides low still counts (the reported bug)', () => {
  // Right wrist sits a third of a torso length below the left throughout.
  const c = new PlayerRepCounter()
  const path = [0, 0.2, 0.45, 0.6, 0.45, 0.2, 0.0]
  let t = 0
  for (let i = 0; i < 10; i++) {
    for (const p of path) {
      c.update(metrics(p * 0.6, p * 0.6 - 0.33), t, AUTO)
      t += 16
    }
  }
  assert.ok(c.debug('left').count >= 8, `left counted ${c.debug('left').count}`)
  assert.ok(c.debug('right').count >= 8, `right counted ${c.debug('right').count}`)
  assert.ok(
    Math.abs(c.debug('left').count - c.debug('right').count) <= 1,
    'both arms should score within one rep of each other',
  )
})

// ------------------------------------------------------------------- dropouts

test('an invalid frame holds trigger state instead of handing out a free rep', () => {
  const c = new PlayerRepCounter()
  c.update(metrics(0.6, 0.6), 0, MANUAL)
  c.update(metrics(0, 0, { valid: false }), 16, MANUAL)
  c.update(metrics(0, 0, { valid: false }), 32, MANUAL)
  assert.equal(c.count, 0)
  c.update(metrics(0.02, 0.02), 48, MANUAL)
  assert.equal(c.count, 2, 'the in-flight rep should complete, not be lost')
  assert.ok(c.skippedFrames >= 2)
})

test('an unusable wrist does not rearm the other one', () => {
  const c = new PlayerRepCounter()
  c.update(metrics(0.6, 0.6), 0, MANUAL)
  c.update(metrics(0, 0, { usable: false }), 16, MANUAL)
  assert.equal(c.count, 0)
  c.update(metrics(0.05, 0.05), 32, MANUAL)
  assert.equal(c.count, 2)
})

test('both wrists count independently (alternating arms is not penalised)', () => {
  const alt = new PlayerRepCounter()
  let t = 0
  for (let i = 0; i < 8; i++) {
    alt.update(metrics(0.6, 0.0), t, MANUAL)
    alt.update(metrics(0.0, 0.6), (t += 100), MANUAL)
    t += 100
  }
  assert.equal(alt.debug('left').count, 8)
  assert.equal(alt.debug('right').count, 7) // its last rep is still in flight
  assert.equal(alt.count, 15)
  // NOTE: the "~2x" in the spec is about wall-clock RATE (you can alternate
  // faster than you can pump both arms together), not per-cycle scoring.
})

test('resetScoresKeepCalibration clears the score but keeps the learned range', () => {
  const c = new PlayerRepCounter()
  let t = 0
  for (let i = 0; i < 4; i++) t = pump(c, t, AUTO)
  const learnedMax = c.debug('left').max
  c.resetScoresKeepCalibration()
  assert.equal(c.count, 0)
  assert.equal(c.debug('left').max, learnedMax)
  // The next pump counts immediately, no re-learning gap.
  pump(c, t, AUTO)
  assert.equal(c.count, 2)
})

// ------------------------------------------------------------------- geometry

/** Build a 33-landmark pose. `tilt` raises the left shoulder in image space. */
function buildPose(opts: {
  tilt?: number
  leftWristY: number
  rightWristY: number
  hipsVisible?: boolean
}): NormalizedLandmark[] {
  const { tilt = 0, leftWristY, rightWristY, hipsVisible = true } = opts
  const lms: NormalizedLandmark[] = Array.from({ length: 33 }, () => ({
    x: 0.5,
    y: 0.5,
    z: 0,
    visibility: 0.9,
  }))
  lms[LM.LEFT_SHOULDER] = { x: 0.4, y: 0.4 - tilt, z: 0, visibility: 0.9 }
  lms[LM.RIGHT_SHOULDER] = { x: 0.6, y: 0.4 + tilt, z: 0, visibility: 0.9 }
  lms[LM.LEFT_HIP] = { x: 0.42, y: 0.7, z: 0, visibility: hipsVisible ? 0.9 : 0.1 }
  lms[LM.RIGHT_HIP] = { x: 0.58, y: 0.7, z: 0, visibility: hipsVisible ? 0.9 : 0.1 }
  lms[LM.LEFT_WRIST] = { x: 0.35, y: leftWristY, z: 0, visibility: 0.9 }
  lms[LM.RIGHT_WRIST] = { x: 0.65, y: rightWristY, z: 0, visibility: 0.9 }
  return lms
}

const GEO = { minVisibility: 0.5, reference: 'sameSide' as const }

test('geometry: sameSide reference cancels shoulder tilt', () => {
  // Both wrists the same distance above their OWN shoulder.
  const pose = buildPose({ tilt: 0.05, leftWristY: 0.4 - 0.05 - 0.1, rightWristY: 0.4 + 0.05 - 0.1 })
  const m = computePoseMetrics(pose, 16 / 9, GEO)
  assert.ok(m.valid)
  assert.ok(
    Math.abs(m.left.h - m.right.h) < 1e-9,
    `sameSide should give equal h, got ${m.left.h} vs ${m.right.h}`,
  )
})

test('geometry: mid reference is what skews the two arms apart under tilt', () => {
  const pose = buildPose({ tilt: 0.05, leftWristY: 0.4 - 0.05 - 0.1, rightWristY: 0.4 + 0.05 - 0.1 })
  const m = computePoseMetrics(pose, 16 / 9, { ...GEO, reference: 'mid' })
  assert.ok(
    Math.abs(m.left.h - m.right.h) > 0.2,
    'mid reference offsets the arms in opposite directions — the original bug',
  )
})

test('geometry: falls back to shoulder width when the hips are out of frame', () => {
  const withHips = computePoseMetrics(
    buildPose({ leftWristY: 0.3, rightWristY: 0.3 }),
    16 / 9,
    GEO,
    new ScaleRatioEstimator(),
  )
  const est = new ScaleRatioEstimator()
  // Learn the ratio while the hips are visible...
  computePoseMetrics(buildPose({ leftWristY: 0.3, rightWristY: 0.3 }), 16 / 9, GEO, est)
  // ...then lose them.
  const noHips = computePoseMetrics(
    buildPose({ leftWristY: 0.3, rightWristY: 0.3, hipsVisible: false }),
    16 / 9,
    GEO,
    est,
  )
  assert.equal(withHips.scaleSource, 'torso')
  assert.equal(noHips.scaleSource, 'shoulders')
  assert.ok(noHips.valid, 'a player standing close must still be trackable')
  assert.ok(
    Math.abs(noHips.left.h - withHips.left.h) < 0.05,
    `the synthesised scale should closely match the measured one, got ${noHips.left.h} vs ${withHips.left.h}`,
  )
})

test('geometry: invisible shoulders invalidate the frame', () => {
  const pose = buildPose({ leftWristY: 0.3, rightWristY: 0.3 })
  pose[LM.LEFT_SHOULDER] = { ...pose[LM.LEFT_SHOULDER], visibility: 0.1 }
  assert.equal(computePoseMetrics(pose, 16 / 9, GEO).valid, false)
})
