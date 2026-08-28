import { useEffect, useRef, useState } from 'react'

/**
 * Rolls a number up from 0 to `target`. Used on the results screen so the score
 * lands with some weight instead of just appearing.
 *
 * Eases out, so it sprints then settles - the last few digits are the tense bit.
 */
export function useCountUp(target: number, durationMs = 1100, startDelayMs = 0): number {
  const [value, setValue] = useState(0)
  const rafRef = useRef(0)

  useEffect(() => {
    const reduced =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced || target <= 0) {
      setValue(target)
      return
    }

    let start = 0
    const tick = (now: number) => {
      if (!start) start = now
      const elapsed = now - start - startDelayMs
      if (elapsed < 0) {
        rafRef.current = requestAnimationFrame(tick)
        return
      }
      const p = Math.min(1, elapsed / durationMs)
      const eased = 1 - Math.pow(1 - p, 3)
      setValue(Math.round(target * eased))
      if (p < 1) rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [target, durationMs, startDelayMs])

  return value
}
