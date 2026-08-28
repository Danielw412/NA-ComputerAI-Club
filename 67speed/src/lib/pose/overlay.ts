/**
 * Skeleton overlay: thin gold arm chains only (shoulder -> elbow -> wrist),
 * not the full 33-point mesh. Cleaner and far more legible on camera.
 *
 * Drawn in normalized image coordinates. The canvas carries the same CSS
 * scaleX(-1) mirror as the video, so no flipping happens here.
 */
import type { NormalizedLandmark } from '@mediapipe/tasks-vision'
import { ARM_CHAINS, LM } from './landmarks'
import type { PoseSample } from './tracker'

export const GOLD = '#FAAA13'

export interface OverlayStyle {
  color: string
  /** Wrists currently above the up-threshold get a filled marker. */
  activeWrists: { left: boolean; right: boolean }
}

export function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  poses: PoseSample[],
  width: number,
  height: number,
  styles: OverlayStyle[],
): void {
  ctx.clearRect(0, 0, width, height)

  poses.forEach((pose, i) => {
    const lms = pose.landmarks
    if (!lms?.length) return
    const style = styles[i] ?? { color: GOLD, activeWrists: { left: false, right: false } }

    const px = (lm: NormalizedLandmark) => [lm.x * width, lm.y * height] as const
    const visible = (lm: NormalizedLandmark | undefined) => !!lm && lm.visibility >= 0.5

    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = Math.max(2, height * 0.004)
    ctx.strokeStyle = style.color
    ctx.shadowColor = style.color
    ctx.shadowBlur = Math.max(4, height * 0.012)

    for (const [a, b] of ARM_CHAINS) {
      const la = lms[a]
      const lb = lms[b]
      if (!visible(la) || !visible(lb)) continue
      const [ax, ay] = px(la)
      const [bx, by] = px(lb)
      ctx.beginPath()
      ctx.moveTo(ax, ay)
      ctx.lineTo(bx, by)
      ctx.stroke()
    }

    const wristDot = (idx: number, active: boolean) => {
      const lm = lms[idx]
      if (!visible(lm)) return
      const [x, y] = px(lm)
      const r = Math.max(4, height * 0.011)
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      if (active) {
        ctx.fillStyle = style.color
        ctx.fill()
      } else {
        ctx.stroke()
      }
    }
    wristDot(LM.LEFT_WRIST, style.activeWrists.left)
    wristDot(LM.RIGHT_WRIST, style.activeWrists.right)

    ctx.shadowBlur = 0
  })
}
