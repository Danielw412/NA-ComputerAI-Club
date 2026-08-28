/**
 * Game state machine. Both modes share one engine; only the gate and the
 * results differ.
 *
 *   home -> poseCheck -> countdown -> running -> results -> home
 *
 * The clock is driven off tracker frames rather than setInterval, so the timer
 * can never drift away from what the counter actually saw.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { GameFrame, UsePoseTracker } from '../hooks/usePoseTracker'
import { audio } from '../lib/audio'
import type { GameMode } from '../lib/leaderboard'

export const RUN_DURATION_MS = 20_000
/** How long a valid pose must hold before the countdown starts. */
export const POSE_HOLD_MS = 1000
export const COUNTDOWN_MS = 3000
/** Final seconds where the timer turns red and pulses. */
export const DANGER_MS = 3000
/** Every N reps the run gets a shake + rising triad. Keeps a 20s sprint eventful. */
export const MILESTONE_EVERY = 25

export type Phase = 'home' | 'poseCheck' | 'countdown' | 'running' | 'results'

export interface RunResult {
  mode: GameMode
  /** Index 0 is always the left-hand player on screen. */
  scores: number[]
  durationMs: number
}

export interface GameState {
  phase: Phase
  mode: GameMode
  /** 0..1 of the pose-check hold that has been satisfied. */
  poseProgress: number
  /** Why the gate is not satisfied yet, shown to the player. */
  gateHint: string
  /** 3, 2, 1 or 0 (meaning GO). */
  countdownValue: number
  remainingMs: number
  liveScores: number[]
  /** Increments each time the combined score crosses a milestone. */
  milestoneKey: number
  result: RunResult | null
}

const INITIAL: GameState = {
  phase: 'home',
  mode: 'solo',
  poseProgress: 0,
  gateHint: '',
  countdownValue: 3,
  remainingMs: RUN_DURATION_MS,
  liveScores: [0, 0],
  milestoneKey: 0,
  result: null,
}

/**
 * Is the gate satisfied this frame? Solo needs one tracked player with both
 * wrists visible; duel needs exactly two, one on each side of the divider.
 */
function evaluateGate(mode: GameMode, frame: GameFrame): { ok: boolean; hint: string } {
  const valid = frame.players.filter((p) => p.valid)

  if (mode === 'solo') {
    const p = valid[0]
    if (!p) return { ok: false, hint: 'STEP INTO FRAME' }
    if (!p.left.usable || !p.right.usable) {
      return { ok: false, hint: 'STEP BACK UNTIL YOUR TORSO AND BOTH HANDS ARE IN FRAME' }
    }
    return { ok: true, hint: '' }
  }

  // Duel: exactly two players, one per side of the centre divider.
  if (valid.length < 2) return { ok: false, hint: 'TWO PLAYERS NEEDED' }
  if (valid.length > 2) return { ok: false, hint: 'ONLY TWO PLAYERS IN FRAME' }
  const [a, b] = valid
  const leftOk = a.screenX < 0.5
  const rightOk = b.screenX >= 0.5
  if (!leftOk || !rightOk) return { ok: false, hint: 'P1 STEP LEFT / P2 STEP RIGHT' }
  if (!a.left.usable || !a.right.usable || !b.left.usable || !b.right.usable) {
    return { ok: false, hint: 'BOTH HANDS IN FRAME FOR BOTH PLAYERS' }
  }
  return { ok: true, hint: '' }
}

export function useGame(tracker: UsePoseTracker) {
  const [state, setState] = useState<GameState>(INITIAL)

  // Everything the frame loop touches lives in refs; React state is published
  // only when something user-visible actually changes.
  const phaseRef = useRef<Phase>('home')
  const modeRef = useRef<GameMode>('solo')
  const gateSinceRef = useRef<number>(0)
  const phaseStartRef = useRef<number>(0)
  const lastCountdownDigitRef = useRef<number>(-1)
  const lastMilestoneRef = useRef<number>(0)
  const milestoneKeyRef = useRef<number>(0)
  const publishedRef = useRef<Partial<GameState>>({})

  const setPhase = useCallback((phase: Phase, tMs: number) => {
    phaseRef.current = phase
    phaseStartRef.current = tMs
    gateSinceRef.current = 0
    setState((s) => ({ ...s, phase }))
  }, [])

  /** Publishes only when a displayed value actually changed. */
  const publish = useCallback((patch: Partial<GameState>) => {
    const prev = publishedRef.current
    let changed = false
    for (const [k, v] of Object.entries(patch)) {
      const key = k as keyof GameState
      if (Array.isArray(v)) {
        const p = prev[key] as unknown[] | undefined
        if (!p || p.length !== v.length || v.some((x, i) => x !== p[i])) changed = true
      } else if (prev[key] !== v) {
        changed = true
      }
    }
    if (!changed) return
    publishedRef.current = { ...prev, ...patch }
    setState((s) => ({ ...s, ...patch }))
  }, [])

  const onFrame = useCallback(
    (frame: GameFrame) => {
      const phase = phaseRef.current
      const mode = modeRef.current
      const t = frame.tMs

      if (phase === 'poseCheck') {
        const { ok, hint } = evaluateGate(mode, frame)
        if (!ok) {
          gateSinceRef.current = 0
          publish({ poseProgress: 0, gateHint: hint })
          return
        }
        if (gateSinceRef.current === 0) gateSinceRef.current = t
        const held = t - gateSinceRef.current
        publish({ poseProgress: Math.min(1, held / POSE_HOLD_MS), gateHint: '' })
        if (held >= POSE_HOLD_MS) {
          lastCountdownDigitRef.current = -1
          setPhase('countdown', t)
        }
        return
      }

      if (phase === 'countdown') {
        const elapsed = t - phaseStartRef.current
        const remaining = COUNTDOWN_MS - elapsed
        const digit = Math.max(0, Math.ceil(remaining / 1000))
        if (digit !== lastCountdownDigitRef.current) {
          lastCountdownDigitRef.current = digit
          if (digit > 0) audio.countdownBeep()
        }
        publish({ countdownValue: digit })
        if (elapsed >= COUNTDOWN_MS) {
          audio.go()
          // Keep the calibration learned during the pose check, drop the score.
          tracker.resetScoresKeepCalibration()
          // Both must reset per run, or run 2 announces "50" at 25 reps.
          lastMilestoneRef.current = 0
          milestoneKeyRef.current = 0
          publish({ liveScores: [0, 0], remainingMs: RUN_DURATION_MS, milestoneKey: 0 })
          setPhase('running', t)
        }
        return
      }

      if (phase === 'running') {
        const elapsed = t - phaseStartRef.current
        const remaining = Math.max(0, RUN_DURATION_MS - elapsed)
        const scores = frame.players.map((p) => p.count)

        if (frame.repsThisFrame > 0) {
          const secs = Math.max(0.5, elapsed / 1000)
          const total = scores.reduce((a, b) => a + b, 0)
          audio.rep(total / secs)

          // Milestone: shake the screen and play a rising triad.
          const milestone = Math.floor(total / MILESTONE_EVERY)
          if (total > 0 && milestone > lastMilestoneRef.current) {
            lastMilestoneRef.current = milestone
            milestoneKeyRef.current += 1
            audio.milestone()
          }
        }

        publish({
          remainingMs: remaining,
          liveScores: scores,
          milestoneKey: milestoneKeyRef.current,
        })

        if (remaining <= 0) {
          audio.horn()
          const finalScores = mode === 'solo' ? [scores[0] ?? 0] : [scores[0] ?? 0, scores[1] ?? 0]
          publishedRef.current = {}
          setState((s) => ({
            ...s,
            phase: 'results',
            remainingMs: 0,
            result: { mode, scores: finalScores, durationMs: RUN_DURATION_MS },
          }))
          phaseRef.current = 'results'
        }
      }
    },
    [publish, setPhase, tracker],
  )

  useEffect(() => tracker.subscribeFrames(onFrame), [tracker, onFrame])

  const startMode = useCallback(
    async (mode: GameMode) => {
      audio.resume()
      audio.click()
      modeRef.current = mode
      publishedRef.current = {}
      setState({ ...INITIAL, mode, phase: 'poseCheck' })
      phaseRef.current = 'poseCheck'
      gateSinceRef.current = 0
      tracker.setTrackerOptions({ numPoses: mode === 'duel' ? 2 : 1 })
      const ok = await tracker.start()
      if (!ok) {
        // Camera denied or unavailable — fall straight back to the home screen,
        // which is where the error message is shown. Otherwise the player would
        // stare at "HOLD STILL" forever with no camera running.
        phaseRef.current = 'home'
        setState({ ...INITIAL })
      }
    },
    [tracker],
  )

  const goHome = useCallback(() => {
    audio.click()
    phaseRef.current = 'home'
    publishedRef.current = {}
    tracker.stop()
    setState({ ...INITIAL })
  }, [tracker])

  /** Replay the same mode without going back to the home screen. */
  const goAgain = useCallback(() => {
    audio.click()
    publishedRef.current = {}
    tracker.resetScoresKeepCalibration()
    setState((s) => ({ ...INITIAL, mode: s.mode, phase: 'poseCheck' }))
    phaseRef.current = 'poseCheck'
    gateSinceRef.current = 0
  }, [tracker])

  return { state, startMode, goHome, goAgain }
}
