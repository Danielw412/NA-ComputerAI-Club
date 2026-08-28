/**
 * The live game surface: pose gate, countdown, and the run itself.
 *
 * The video and skeleton canvas are rendered by App underneath this; everything
 * here sits on top of a 45% black scrim so the UI stays readable.
 */
import { useEffect, useRef, useState } from 'react'
import { DANGER_MS, RUN_DURATION_MS, type GameState } from '../game/useGame'

interface Props {
  state: GameState
  onQuit: () => void
}

/** Fires a short gold sweep at the screen edge on every counted rep. */
function useRepFlash(total: number) {
  const [flashKey, setFlashKey] = useState(0)
  const prev = useRef(total)
  useEffect(() => {
    if (total > prev.current) setFlashKey((k) => k + 1)
    prev.current = total
  }, [total])
  return flashKey
}

function Counter({
  value,
  label,
  leading,
  huge,
}: {
  value: number
  label?: string
  leading?: boolean
  huge?: boolean
}) {
  const [popKey, setPopKey] = useState(0)
  const prev = useRef(value)
  useEffect(() => {
    if (value !== prev.current) setPopKey((k) => k + 1)
    prev.current = value
  }, [value])

  return (
    <div className="flex flex-col items-center">
      {label && (
        <span
          className={`display text-2xl tracking-[0.3em] ${leading ? 'text-gold' : 'text-muted'}`}
        >
          {label}
        </span>
      )}
      <span
        key={popKey}
        className={`rep-pop tnum display leading-none text-gold ${
          huge ? 'text-[18rem]' : 'text-[11rem]'
        }`}
        style={{ textShadow: '0 0 40px rgba(250,170,19,0.35)' }}
      >
        {value}
      </span>
    </div>
  )
}

export function GameScreen({ state, onQuit }: Props) {
  const {
    phase,
    mode,
    remainingMs,
    liveScores,
    poseProgress,
    gateHint,
    countdownValue,
    milestoneKey,
  } = state
  const total = liveScores.reduce((a, b) => a + b, 0)
  const flashKey = useRepFlash(total)
  const danger = phase === 'running' && remainingMs <= DANGER_MS
  const pct = Math.max(0, Math.min(1, remainingMs / RUN_DURATION_MS))

  const p1 = liveScores[0] ?? 0
  const p2 = liveScores[1] ?? 0

  return (
    <div className="relative z-20 h-full w-full">
      {/* Rep feedback sweep. Keyed so each rep restarts the animation. */}
      {flashKey > 0 && (
        <div key={flashKey} className="edge-flash pointer-events-none absolute inset-0 z-30" />
      )}

      {/* Milestone: a thick double shockwave and a gold wash. No number — it
          collided with the counter and read as a random digit above the score. */}
      {phase === 'running' && milestoneKey > 0 && (
        <div
          key={`ms-${milestoneKey}`}
          className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center"
        >
          <div className="milestone-wash absolute inset-0 bg-gold/25" />
          <div
            className="milestone-ring absolute h-[30rem] w-[30rem] rounded-full border-[18px] border-gold"
            style={{ boxShadow: '0 0 90px rgba(250,170,19,0.85), inset 0 0 60px rgba(250,170,19,0.5)' }}
          />
          <div className="milestone-ring-2 absolute h-[30rem] w-[30rem] rounded-full border-[10px] border-ink/70" />
        </div>
      )}

      {/* Duel divider and per-side lead glow. */}
      {mode === 'duel' && phase !== 'results' && (
        <>
          <div className="pointer-events-none absolute inset-y-0 left-1/2 z-20 w-px -translate-x-1/2 bg-gold/70 shadow-[0_0_18px_rgba(250,170,19,0.8)]" />
          {phase === 'running' && p1 !== p2 && (
            <div
              className={`lead-glow pointer-events-none absolute inset-y-0 z-10 w-1/2 ${
                p1 > p2 ? 'left-0' : 'right-0'
              }`}
              style={{
                background:
                  'radial-gradient(ellipse at center, rgba(250,170,19,0.20) 0%, rgba(250,170,19,0) 70%)',
              }}
            />
          )}
        </>
      )}

      {/* Draining timer bar across the top. */}
      {phase === 'running' && (
        <div className="absolute top-0 left-0 z-30 h-1.5 w-full bg-white/10">
          <div
            className={`h-full transition-[width] duration-100 ease-linear ${
              danger ? 'danger-pulse bg-danger' : 'bg-gold'
            }`}
            style={{ width: `${pct * 100}%` }}
          />
        </div>
      )}

      <div className="absolute top-4 right-4 z-30">
        <button
          onClick={onQuit}
          className="border border-white/25 px-3 py-1.5 text-[10px] uppercase tracking-[0.2em] text-muted hover:bg-white/5"
        >
          quit
        </button>
      </div>

      {/* --- Pose gate --- */}
      {phase === 'poseCheck' && (
        <div className="flex h-full flex-col items-center justify-center gap-6 text-center">
          <div className="relative h-28 w-28">
            <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
              <circle cx="50" cy="50" r="45" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="4" />
              <circle
                cx="50"
                cy="50"
                r="45"
                fill="none"
                stroke="var(--color-gold)"
                strokeWidth="4"
                strokeDasharray={`${2 * Math.PI * 45}`}
                strokeDashoffset={`${2 * Math.PI * 45 * (1 - poseProgress)}`}
                strokeLinecap="round"
              />
            </svg>
          </div>
          <p className="display max-w-3xl text-4xl tracking-[0.1em] text-ink">
            {gateHint || 'HOLD STILL…'}
          </p>
          <p className="text-xs uppercase tracking-[0.3em] text-muted">
            {mode === 'duel' ? 'two players · one each side' : 'get your whole upper body in frame'}
          </p>
        </div>
      )}

      {/* --- Countdown --- */}
      {phase === 'countdown' && (
        <div className="flex h-full items-center justify-center">
          <span
            key={countdownValue}
            className="slam display text-[22rem] leading-none text-gold"
            style={{ textShadow: '0 0 80px rgba(250,170,19,0.5)' }}
          >
            {countdownValue > 0 ? countdownValue : 'GO'}
          </span>
        </div>
      )}

      {/* --- Live run --- */}
      {phase === 'running' && (
        <div
          key={`shake-${milestoneKey}`}
          className={`flex h-full flex-col items-center justify-center ${
            milestoneKey > 0 ? 'shake' : ''
          }`}
        >
          <div
            className={`display tnum absolute top-8 left-1/2 -translate-x-1/2 text-5xl ${
              danger ? 'danger-pulse text-danger' : 'text-ink'
            }`}
          >
            {(remainingMs / 1000).toFixed(1)}
          </div>

          {mode === 'solo' ? (
            <Counter value={p1} huge />
          ) : (
            <div className="flex w-full items-center justify-around">
              <Counter value={p1} label="P1" leading={p1 > p2} />
              <Counter value={p2} label="P2" leading={p2 > p1} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
