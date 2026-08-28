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
    ctx.strokeStyle = style.color
    ctx.fillStyle = style.color

    const core = Math.max(2, height * 0.004)

    // Build every arm chain into ONE path, then stroke it twice: a wide
    // translucent pass for the glow and a narrow solid pass for the line.
    //
    // This replaces ctx.shadowBlur, which was set once but applied per stroke —
    // 12 separately-blurred draws per frame with two players. Canvas shadow
    // blurring is one of the most expensive 2D operations there is, and it was
    // the main per-frame cost in duel mode. Two cheap strokes over a shared
    // path look near-identical and cost a fraction.
    ctx.beginPath()
    for (const [a, b] of ARM_CHAINS) {
      const la = lms[a]
      const lb = lms[b]
      if (!visible(la) || !visible(lb)) continue
      const [ax, ay] = px(la)
      const [bx, by] = px(lb)
      ctx.moveTo(ax, ay)
      ctx.lineTo(bx, by)
    }
    ctx.globalAlpha = 0.22
    ctx.lineWidth = core * 3.2
    ctx.stroke()
    ctx.globalAlpha = 1
    ctx.lineWidth = core
    ctx.stroke()

    // Wrist markers, also batched: one path for filled (arm raised), one for
    // outlined, instead of a blurred draw each.
    const r = Math.max(4, height * 0.011)
    const dots = (indices: number[], filled: boolean) => {
      let any = false
      ctx.beginPath()
      for (const idx of indices) {
        const lm = lms[idx]
        if (!visible(lm)) continue
        const [x, y] = px(lm)
        ctx.moveTo(x + r, y)
        ctx.arc(x, y, r, 0, Math.PI * 2)
        any = true
      }
      if (!any) return
      if (filled) {
        ctx.globalAlpha = 0.25
        ctx.lineWidth = core * 3.2
        ctx.stroke()
        ctx.globalAlpha = 1
        ctx.fill()
      } else {
        ctx.lineWidth = core
        ctx.stroke()
      }
    }

    const active = style.activeWrists
    dots(
      [active.left ? LM.LEFT_WRIST : -1, active.right ? LM.RIGHT_WRIST : -1].filter((i) => i >= 0),
      true,
    )
    dots(
      [!active.left ? LM.LEFT_WRIST : -1, !active.right ? LM.RIGHT_WRIST : -1].filter((i) => i >= 0),
      false,
    )

    ctx.globalAlpha = 1
  })
}
