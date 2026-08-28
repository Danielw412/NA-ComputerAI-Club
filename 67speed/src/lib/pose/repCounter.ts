/**
 * The rep counter. This is the whole game.
 *
 * One independent Schmitt trigger per wrist, driven by `h` = how far the wrist
 * is above its shoulder, measured in torso lengths. Because the shoulder and
 * the wrist both move when the CAMERA shakes, `h` cancels camera motion out -
 * shaking the laptop does not score. Keep that property.
 *
 * TWO THRESHOLD MODES:
 *
 *   'auto' (default) - each wrist calibrates against its OWN recent range of
 *   motion. Thresholds are placed at fractions of the range between that
 *   wrist's rolling minimum and maximum, so a player who pumps at chest height
 *   and a player who pumps overhead both score, and a tilted stance can't stop
 *   one arm from registering. There is nothing to tune.
 *
 *   'manual' - the original fixed UP/DOWN constants. Kept as an escape hatch.
 *
 * Both wrists count separately, so alternating arms scores faster in wall-clock
 * time than pumping both together. That is intended.
 */
import type { PoseMetrics, WristMetrics, WristSide } from './landmarks'

export type ThresholdMode = 'auto' | 'manual'

export interface RepConfig {
  mode: ThresholdMode
  /** manual mode only */
  upThreshold: number
  /** manual mode only */
  downThreshold: number
  debounceMs: number
  minVisibility: number
  /** auto: latch 'up' at this fraction of the observed range. */
  autoUpFrac: number
  /** auto: complete the rep at this fraction of the observed range. */
  autoDownFrac: number
  /** auto: below this range (in torso lengths) the wrist is treated as still. */
  autoMinRange: number
  /** auto: how far back the range of motion is measured, in ms. */
  autoWindowMs: number
}

export const DEFAULT_REP_CONFIG: RepConfig = {
  mode: 'auto',
  upThreshold: 0.35,
  downThreshold: 0.15,
  debounceMs: 70,
  minVisibility: 0.5,
  autoUpFrac: 0.65,
  autoDownFrac: 0.35,
  autoMinRange: 0.14,
  autoWindowMs: 700,
}

export type WristState = 'up' | 'down'

export interface RepEvent {
  /** ms since the run started. */
  t: number
  wrist: WristSide
}

export interface WristDebug {
  state: WristState
  h: number
  usable: boolean
  visibility: number
  count: number
  /** The thresholds actually in force this frame (auto ones move). */
  up: number
  down: number
  /** Rolling envelope, auto mode. */
  min: number
  max: number
  /** False in auto mode when the wrist isn't moving enough to count. */
  armed: boolean
}

/**
 * Range of motion over a sliding time window.
 *
 * Chosen over an exponentially-decaying envelope because the envelope failed a
 * realistic case: a player who pumps big and then tires keeps a stale high
 * maximum, the up-threshold stays out of reach, and they stop scoring exactly
 * when they are working hardest. A window simply forgets anything older than
 * `windowMs`, so thresholds track the player's CURRENT range.
 *
 * Window length is tuned by simulation, not by feel - see scripts/tuneAuto.ts.
 */
class RangeWindow {
  private ts: number[] = []
  private hs: number[] = []
  min = 0
  max = 0

  update(h: number, t: number, windowMs: number): void {
    this.ts.push(t)
    this.hs.push(h)
    const cutoff = t - windowMs
    let drop = 0
    while (drop < this.ts.length && this.ts[drop] < cutoff) drop++
    if (drop > 0) {
      this.ts.splice(0, drop)
      this.hs.splice(0, drop)
    }
    let lo = Infinity
    let hi = -Infinity
    for (const v of this.hs) {
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    this.min = lo
    this.max = hi
  }

  get range(): number {
    return this.max - this.min
  }

  reset(): void {
    this.ts = []
    this.hs = []
    this.min = 0
    this.max = 0
  }
}

interface WristRuntime {
  state: WristState
  lastCountAt: number
  count: number
  h: number
  visibility: number
  usable: boolean
  lastT: number
  window: RangeWindow
  up: number
  down: number
  armed: boolean
}

function newWristRuntime(): WristRuntime {
  return {
    state: 'down',
    lastCountAt: -Infinity,
    count: 0,
    h: 0,
    visibility: 0,
    usable: false,
    lastT: -1,
    window: new RangeWindow(),
    up: 0,
    down: 0,
    armed: false,
  }
}

export class PlayerRepCounter {
  count = 0
  timeline: RepEvent[] = []
  /** Frames dropped for bad landmarks - high means bad framing. */
  skippedFrames = 0

  private wrists: Record<WristSide, WristRuntime> = {
    left: newWristRuntime(),
    right: newWristRuntime(),
  }

  reset(): void {
    this.count = 0
    this.timeline = []
    this.skippedFrames = 0
    this.wrists = { left: newWristRuntime(), right: newWristRuntime() }
  }

  /**
   * Clears the scores but KEEPS the auto-calibration envelope, so a run that
   * starts right after a warm-up doesn't have to re-learn the player's range.
   */
  resetScoresKeepCalibration(): void {
    this.count = 0
    this.timeline = []
    this.skippedFrames = 0
    for (const side of ['left', 'right'] as const) {
      const w = this.wrists[side]
      w.count = 0
      w.lastCountAt = -Infinity
      w.state = 'down'
    }
  }

  /**
   * Feed one frame. `t` is ms on the run clock (0 at run start).
   * Returns how many reps were counted on this frame (0, 1 or 2).
   */
  update(metrics: PoseMetrics, t: number, cfg: RepConfig): number {
    if (!metrics.valid) {
      this.skippedFrames++
      this.wrists.left.usable = false
      this.wrists.right.usable = false
      return 0
    }
    return this.updateWrist('left', metrics.left, t, cfg) +
      this.updateWrist('right', metrics.right, t, cfg)
  }

  private updateWrist(side: WristSide, m: WristMetrics, t: number, cfg: RepConfig): number {
    const w = this.wrists[side]
    w.usable = m.usable
    w.visibility = m.visibility

    if (!m.usable) {
      // Hold the trigger state: an arm that blinks out mid-pump should resume,
      // not silently rearm and hand out a free rep.
      this.skippedFrames++
      return 0
    }

    w.lastT = t
    w.h = m.h

    if (cfg.mode === 'manual') {
      w.up = cfg.upThreshold
      w.down = cfg.downThreshold
      w.armed = true
    } else {
      w.window.update(m.h, t, cfg.autoWindowMs)
      const range = w.window.range
      w.armed = range >= cfg.autoMinRange
      w.up = w.window.min + range * cfg.autoUpFrac
      w.down = w.window.min + range * cfg.autoDownFrac
      if (!w.armed) {
        // Not moving enough to be a pump - don't let sensor noise score.
        w.state = 'down'
        return 0
      }
    }

    if (w.state === 'down') {
      if (m.h > w.up) w.state = 'up'
      return 0
    }

    // state === 'up': the rep completes on the way back DOWN.
    if (m.h < w.down) {
      w.state = 'down'
      if (t - w.lastCountAt < cfg.debounceMs) return 0
      w.lastCountAt = t
      this.count++
      w.count++
      this.timeline.push({ t: Math.round(t), wrist: side })
      return 1
    }
    return 0
  }

  debug(side: WristSide): WristDebug {
    const w = this.wrists[side]
    return {
      state: w.state,
      h: w.h,
      usable: w.usable,
      visibility: w.visibility,
      count: w.count,
      up: w.up,
      down: w.down,
      min: w.window.min,
      max: w.window.max,
      armed: w.armed,
    }
  }

  /** Reps per second over a run of `durationMs`. */
  rate(durationMs: number): number {
    return durationMs > 0 ? this.count / (durationMs / 1000) : 0
  }
}
