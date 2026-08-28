import { useEffect, useRef } from 'react'
import { ConfettiCanvas } from '../lib/confetti'

/**
 * Fullscreen confetti layer. Increment `fire` to trigger a burst; `mode`
 * chooses the shape of it.
 */
export function Confetti({ fire, mode = 'cannons' }: { fire: number; mode?: 'cannons' | 'center' }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const engineRef = useRef<ConfettiCanvas | null>(null)

  useEffect(() => {
    if (!canvasRef.current) return
    engineRef.current = new ConfettiCanvas(canvasRef.current)
    return () => engineRef.current?.destroy()
  }, [])

  useEffect(() => {
    if (fire <= 0) return
    const engine = engineRef.current
    if (!engine) return
    if (mode === 'cannons') engine.cannons()
    else engine.burst({ x: 0.5, y: 0.5, count: 120, power: 16 })
  }, [fire, mode])

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 z-40 h-full w-full"
      aria-hidden="true"
    />
  )
}
