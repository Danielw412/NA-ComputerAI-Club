import { useEffect, useLayoutEffect, useRef, useState } from 'react'

/** Current time, refreshed on an interval while `active`. */
export function useNow(active: boolean, intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [active, intervalMs])
  return now
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return reduced
}

/** Keeps a scroll container pinned to the bottom while content streams in, unless the reader scrolled up. */
export function useStickToBottom<T extends HTMLElement>(dependency: unknown) {
  const ref = useRef<T>(null)
  const pinned = useRef(true)
  useLayoutEffect(() => {
    const el = ref.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [dependency])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])
  return ref
}

/** Counts up to `target` with an ease-out curve, starting from `start` on first render. */
export function useCountUp(target: number, start = target, durationMs = 900): number {
  const reduced = useReducedMotion()
  const [value, setValue] = useState(start)
  const from = useRef(start)
  useEffect(() => {
    if (reduced) {
      setValue(target)
      from.current = target
      return
    }
    const began = performance.now()
    const origin = from.current
    let frame = 0
    const tick = (time: number) => {
      const t = Math.min(1, (time - began) / durationMs)
      const eased = 1 - (1 - t) ** 3
      setValue(Math.round(origin + (target - origin) * eased))
      if (t < 1) frame = requestAnimationFrame(tick)
      else from.current = target
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      from.current = target
    }
  }, [target, durationMs, reduced])
  return value
}
