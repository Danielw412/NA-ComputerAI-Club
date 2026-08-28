/**
 * Pose landmark indices and the scale-invariant geometry the rep counter runs on.
 *
 * MediaPipe names landmarks from the SUBJECT's point of view: index 15 is the
 * subject's left wrist, which appears on the RIGHT of a mirrored preview.
 * That does not matter for counting (both wrists are counted independently),
 * but it matters for the duel-mode left/right split, so see `screenX` below.
 */
import type { NormalizedLandmark } from '@mediapipe/tasks-vision'

export const LM = {
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
} as const

/** The only chains we draw: shoulder -> elbow -> wrist, both arms. */
export const ARM_CHAINS: ReadonlyArray<readonly [number, number]> = [
  [LM.LEFT_SHOULDER, LM.LEFT_ELBOW],
  [LM.LEFT_ELBOW, LM.LEFT_WRIST],
  [LM.RIGHT_SHOULDER, LM.RIGHT_ELBOW],
  [LM.RIGHT_ELBOW, LM.RIGHT_WRIST],
]

export type WristSide = 'left' | 'right'

/**
 * Which shoulder each wrist is measured against.
 *
 * 'sameSide' (default) measures the left wrist against the LEFT shoulder and the
 * right wrist against the RIGHT shoulder. 'mid' uses the shoulder midpoint, as
 * the original spec described.
 *
 * Why the default changed: with 'mid', a player whose shoulders are even
 * slightly tilted gets equal-and-opposite offsets on the two arms - the
 * midpoint sits above one shoulder and below the other - so one arm clears a
 * fixed threshold and the other never does. That was the real cause of
 * "my right hand is up and it won't count". 'sameSide' cancels tilt and is
 * equally camera-shake-invariant, since a shoulder and its wrist both move
 * with the camera.
 */
export type ShoulderReference = 'sameSide' | 'mid'

/** Where the length used to normalize `h` came from, for diagnostics. */
export type ScaleSource = 'torso' | 'shoulders' | 'none'

export interface WristMetrics {
  /** Normalized height above the shoulder reference, in torso lengths. */
  h: number
  visibility: number
  /** False when this wrist is too occluded/off-frame to trust this frame. */
  usable: boolean
}

export interface PoseMetrics {
  /** False when the shoulder reference is unusable; the whole frame is skipped. */
  valid: boolean
  /** The normalizer actually used this frame. */
  scale: number
  scaleSource: ScaleSource
  /** Torso center in IMAGE coords (0..1, left of the raw sensor image). */
  torsoCenterX: number
  /**
   * Torso center in SCREEN coords (0..1, left of what the player sees).
   * The preview is mirrored, so this is 1 - torsoCenterX. Duel mode sorts on
   * this so "leftmost player" means leftmost as the players see themselves.
   */
  screenX: number
  left: WristMetrics
  right: WristMetrics
}

const UNUSABLE_WRIST: WristMetrics = { h: 0, visibility: 0, usable: false }
export const INVALID_METRICS: PoseMetrics = {
  valid: false,
  scale: 0,
  scaleSource: 'none',
  torsoCenterX: 0.5,
  screenX: 0.5,
  left: UNUSABLE_WRIST,
  right: UNUSABLE_WRIST,
}

export interface GeometryOptions {
  minVisibility: number
  reference: ShoulderReference
}

/**
 * Live estimate of torsoLength / shoulderWidth for the current player.
 *
 * Learned while the hips ARE visible, then reused to synthesise a scale when
 * they are not - which is what lets a player stand close enough that only their
 * upper body is in frame. Nothing here is a hardcoded anthropometric constant;
 * it is measured off the player in front of the camera. In adaptive threshold
 * mode the absolute scale barely matters anyway, since each wrist is compared
 * against its own observed range.
 */
export class ScaleRatioEstimator {
  /** Starts at 1.0 and self-corrects the first time hips are seen. */
  ratio = 1.0
  private seen = false

  observe(torsoLen: number, shoulderWidth: number): void {
    if (!(torsoLen > 0) || !(shoulderWidth > 0.01)) return
    const r = torsoLen / shoulderWidth
    if (!Number.isFinite(r) || r < 0.3 || r > 4) return
    this.ratio = this.seen ? this.ratio * 0.95 + r * 0.05 : r
    this.seen = true
  }

  reset(): void {
    this.ratio = 1.0
    this.seen = false
  }
}

/**
 * Landmarks are normalized independently by width and height, so raw distances
 * are anisotropic on a 16:9 frame. We rescale x into units of frame HEIGHT
 * before measuring, which keeps the normalizer a true length and leaves the
 * vertical `h` term exactly as the threshold constants assume.
 */
export function computePoseMetrics(
  lms: NormalizedLandmark[],
  aspect: number,
  opts: GeometryOptions,
  scaleRatio?: ScaleRatioEstimator,
): PoseMetrics {
  if (!lms || lms.length <= LM.RIGHT_HIP) return INVALID_METRICS
  const { minVisibility, reference } = opts

  const ls = lms[LM.LEFT_SHOULDER]
  const rs = lms[LM.RIGHT_SHOULDER]
  const lh = lms[LM.LEFT_HIP]
  const rh = lms[LM.RIGHT_HIP]

  // Shoulders are the one hard requirement: they are both the vertical
  // reference and the fallback normalizer.
  if (Math.min(ls.visibility, rs.visibility) < minVisibility) return INVALID_METRICS

  const shoulderMidX = (ls.x + rs.x) / 2
  const shoulderMidY = (ls.y + rs.y) / 2
  const shoulderWidth = Math.hypot((ls.x - rs.x) * aspect, ls.y - rs.y)

  const hipsVisible = Math.min(lh.visibility, rh.visibility) >= minVisibility
  const hipMidX = (lh.x + rh.x) / 2
  const hipMidY = (lh.y + rh.y) / 2

  let scale = 0
  let scaleSource: ScaleSource = 'none'
  if (hipsVisible) {
    const torsoLen = Math.hypot((shoulderMidX - hipMidX) * aspect, shoulderMidY - hipMidY)
    if (torsoLen > 0.02) {
      scale = torsoLen
      scaleSource = 'torso'
      scaleRatio?.observe(torsoLen, shoulderWidth)
    }
  }
  if (scaleSource === 'none' && shoulderWidth > 0.02) {
    // Hips out of frame (player standing close) - synthesise a torso length.
    scale = shoulderWidth * (scaleRatio?.ratio ?? 1)
    scaleSource = 'shoulders'
  }
  if (scaleSource === 'none' || !(scale > 0.02)) return INVALID_METRICS

  const refY = (side: WristSide) => {
    if (reference === 'mid') return shoulderMidY
    return side === 'left' ? ls.y : rs.y
  }

  const wrist = (i: number, side: WristSide): WristMetrics => {
    const w = lms[i]
    if (!w || w.visibility < minVisibility) return UNUSABLE_WRIST
    return {
      h: (refY(side) - w.y) / scale,
      visibility: w.visibility,
      usable: true,
    }
  }

  const torsoCenterX = hipsVisible ? (shoulderMidX + hipMidX) / 2 : shoulderMidX
  return {
    valid: true,
    scale,
    scaleSource,
    torsoCenterX,
    screenX: 1 - torsoCenterX,
    left: wrist(LM.LEFT_WRIST, 'left'),
    right: wrist(LM.RIGHT_WRIST, 'right'),
  }
}
