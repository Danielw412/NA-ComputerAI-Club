/**
 * Results screen: the payoff. Score rolls up, confetti fires, the winner gets
 * the stage, and anyone who cracked the top 10 enters their name.
 *
 * In duel mode BOTH players can qualify - the loser of a 90-vs-88 match still
 * beat the board, and pretending otherwise would be unfair. They enter names
 * one after the other.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { RunResult } from '../game/useGame'
import { useCountUp } from '../hooks/useCountUp'
import { audio } from '../lib/audio'
import {
  NAME_MAX_LENGTH,
  NAME_MIN_LENGTH,
  getTop,
  isNameAllowed,
  personalBest,
  qualifies,
  sanitizeName,
  setPersonalBest,
  submit,
  type ScoreEntry,
} from '../lib/leaderboard'
import { Confetti } from './Confetti'

interface Props {
  result: RunResult
  onAgain: () => void
  onHome: () => void
  onSubmitted: () => void
}

interface Pending {
  playerIndex: number
  score: number
  won: boolean
  /** Why we are asking: a top-10 score, or a duel result worth recording. */
  reason: 'top10' | 'duel'
}

export function Results({ result, onAgain, onHome, onSubmitted }: Props) {
  const { mode, scores, durationMs } = result
  const best = scores.reduce((a, b) => Math.max(a, b), 0)
  const winnerIndex = scores.indexOf(best)
  const tie = mode === 'duel' && scores[0] === scores[1]

  const [prevBest] = useState(() => personalBest())
  const [queue, setQueue] = useState<Pending[]>([])
  const [name, setName] = useState('')
  const [rejected, setRejected] = useState(false)
  const [savedCount, setSavedCount] = useState(0)
  const [saveWarning, setSaveWarning] = useState<string | null>(null)
  const [confettiFire, setConfettiFire] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const isNewPersonalBest = mode === 'solo' && best > prevBest && prevBest > 0
  const delta = mode === 'solo' ? best - prevBest : 0

  // Score rolls up; the celebration lands as it finishes.
  const shown = useCountUp(best, 1100, 150)
  const shownP1 = useCountUp(scores[0] ?? 0, 1100, 150)
  const shownP2 = useCountUp(scores[1] ?? 0, 1100, 150)

  useEffect(() => {
    if (mode === 'solo') setPersonalBest(best)
    let alive = true
    void getTop().then(({ entries }) => {
      if (!alive) return

      if (mode === 'duel') {
        // Duels ALWAYS prompt both players. The MOST WINS board is counted from
        // these rows, so a win that nobody put a name to simply doesn't exist.
        // Either player can skip.
        setQueue(
          scores
            .map((score, playerIndex) => ({
              score,
              playerIndex,
              won: !tie && playerIndex === winnerIndex,
              reason: 'duel' as const,
            }))
            // A zero-rep player has nothing to record, and the database's
            // insert policy requires score >= 1 anyway.
            .filter((c) => c.score >= 1)
            .sort((a, b) => b.score - a.score),
        )
        return
      }

      // Solo: only interrupt for a score that actually made the board.
      setQueue(
        qualifies(best, entries)
          ? [{ score: best, playerIndex: 0, won: false, reason: 'top10' as const }]
          : [],
      )
    })
    return () => {
      alive = false
    }
  }, [best, mode, scores, tie, winnerIndex])

  // Fire confetti once the number has finished rolling.
  useEffect(() => {
    const worthCelebrating = mode === 'duel' || isNewPersonalBest || queue.length > 0
    if (!worthCelebrating) return
    const id = setTimeout(() => {
      setConfettiFire((k) => k + 1)
      if (queue.length > 0) audio.fanfare()
    }, 1150)
    return () => clearTimeout(id)
  }, [mode, isNewPersonalBest, queue.length])

  useEffect(() => {
    if (queue.length > 0) inputRef.current?.focus()
  }, [queue.length])

  const rps = durationMs > 0 ? best / (durationMs / 1000) : 0
  const current = queue[0]

  const save = async () => {
    if (!current) return
    const clean = sanitizeName(name).trim()
    if (!isNameAllowed(clean)) {
      setRejected(true)
      return
    }
    const entry: ScoreEntry = {
      name: clean,
      score: current.score,
      mode,
      won: current.won,
      date: new Date().toISOString(),
    }
    const result = await submit(entry)
    // Tell the player the truth. Saying "saved to the board" when the row was
    // rejected is how a broken leaderboard goes unnoticed for a whole event.
    setSaveWarning(
      result.saved === 'remote'
        ? null
        : 'Saved on this computer only. The online board could not be reached.',
    )
    setSavedCount((n) => n + 1)
    setName('')
    setQueue((q) => q.slice(1))
    onSubmitted()
  }

  const skip = () => {
    setName('')
    setRejected(false)
    setQueue((q) => q.slice(1))
  }

  const headline = useMemo(() => {
    if (mode === 'duel') return tie ? 'DEAD HEAT' : `PLAYER ${winnerIndex + 1} WINS`
    if (isNewPersonalBest) return 'NEW PERSONAL BEST'
    return 'TIME'
  }, [mode, tie, winnerIndex, isNewPersonalBest])

  return (
    <div className="scroll-dark relative z-20 h-full overflow-y-auto text-center">
      <div className="safe-bottom mobile-landscape-compact flex min-h-full flex-col items-center justify-center gap-4 px-4 pt-16 sm:gap-5 sm:px-6 sm:py-8">
      <Confetti fire={confettiFire} mode={mode === 'duel' ? 'cannons' : 'center'} />

      <p
        className={`winner-in display text-3xl leading-tight tracking-[0.1em] sm:text-5xl sm:tracking-[0.15em] ${
          mode === 'duel' || isNewPersonalBest ? 'text-gold' : 'text-muted'
        }`}
      >
        {headline}
      </p>

      {mode === 'duel' ? (
        <div className="flex w-full max-w-3xl items-end justify-center gap-3 sm:gap-16">
          {[shownP1, shownP2].map((s, i) => {
            const won = i === winnerIndex && !tie
            return (
              <div
                key={i}
                className={`flex flex-col items-center ${won ? 'winner-in' : 'rise-in opacity-80'}`}
              >
                <span
                  className={`display text-2xl tracking-[0.3em] ${won ? 'text-gold' : 'text-muted'}`}
                >
                  P{i + 1}
                </span>
                <span
                  className={`display tnum leading-none ${
                    won
                      ? 'trophy-glow text-[clamp(7rem,32vw,13rem)] text-gold'
                      : 'text-[clamp(5.5rem,25vw,9rem)] text-ink/70'
                  }`}
                >
                  {s}
                </span>
                {won && (
                  <span className="display mt-1 text-sm tracking-[0.4em] text-gold">WINNER</span>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <span className="display tnum trophy-glow text-[clamp(8rem,48vw,16rem)] leading-none text-gold">
          {shown}
        </span>
      )}

      <div className="rise-in flex flex-col gap-1 font-mono text-xs text-muted sm:flex-row sm:gap-10 sm:text-sm">
        <span className="tnum">{rps.toFixed(2)} reps/sec</span>
        {mode === 'solo' && (
          <span className="tnum">
            {delta > 0 && prevBest > 0 ? (
              <span className="text-gold">+{delta} over your best</span>
            ) : prevBest > 0 ? (
              `personal best ${prevBest}`
            ) : (
              'first run'
            )}
          </span>
        )}
      </div>

      {current && (
        <div className="rise-in relative flex w-full max-w-lg flex-col items-center gap-2 overflow-hidden border border-gold/40 bg-surface/90 px-4 py-4 sm:px-8 sm:py-5">
          <div className="pointer-events-none absolute inset-0 opacity-20">
            <div className="banner-sweep h-full w-1/3 bg-gradient-to-r from-transparent via-gold to-transparent" />
          </div>
          <p className="display text-lg leading-tight tracking-[0.12em] text-gold sm:text-2xl sm:tracking-[0.2em]">
            {current.reason === 'duel'
              ? `PLAYER ${current.playerIndex + 1}${current.won ? ', WINNER' : ''}: ENTER A NICKNAME`
              : 'TOP 10: ENTER A NICKNAME'}
          </p>
          <p className="tnum font-mono text-xs text-muted">
            score {current.score}
            {current.won && ' · counts toward MOST WINS'}
          </p>
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => {
              setRejected(false)
              setName(sanitizeName(e.target.value))
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save()
            }}
            maxLength={NAME_MAX_LENGTH}
            placeholder="Nickname"
            autoComplete="off"
            spellCheck={false}
            className="display w-full max-w-[22rem] border-b-2 border-gold bg-transparent text-center text-3xl tracking-[0.04em] text-ink outline-none placeholder:text-muted/30 sm:text-4xl sm:tracking-[0.06em]"
          />
          <p className="max-w-sm text-[10px] uppercase leading-relaxed tracking-[0.12em] text-muted sm:text-[11px] sm:tracking-[0.2em]">
            Shown publicly. Do not use your full name or contact information.
          </p>
          {rejected && (
            <p className="text-sm text-danger">
              Letters, spaces, hyphens and apostrophes only. Use {NAME_MIN_LENGTH} to{' '}
              {NAME_MAX_LENGTH} characters.
            </p>
          )}
          <div className="flex gap-3">
            <button
              onClick={() => void save()}
              disabled={!isNameAllowed(name)}
              className="display mt-1 border-2 border-gold px-8 py-2 text-xl tracking-[0.2em] text-gold hover:bg-gold/15 disabled:opacity-40"
            >
              SAVE
            </button>
            <button
              onClick={skip}
              className="mt-1 px-3 text-xs uppercase tracking-[0.2em] text-muted hover:text-ink"
            >
              skip
            </button>
          </div>
        </div>
      )}
      {savedCount > 0 && queue.length === 0 && (
        saveWarning ? (
          <p className="max-w-md text-sm text-danger">{saveWarning}</p>
        ) : (
          <p className="text-sm uppercase tracking-[0.3em] text-gold">saved to the board</p>
        )
      )}

      <div className="mt-1 flex w-full max-w-lg flex-col gap-3 sm:flex-row sm:gap-4">
        <button
          onClick={onAgain}
          className="display min-h-14 flex-1 border-2 border-gold bg-gold px-8 py-4 text-3xl tracking-[0.08em] text-bg hover:bg-gold/85 sm:px-16 sm:py-5 sm:text-4xl sm:tracking-[0.1em]"
        >
          GO AGAIN
        </button>
        <button
          onClick={onHome}
          className="display min-h-14 border-2 border-white/25 px-8 py-4 text-xl tracking-[0.1em] text-muted hover:bg-white/5 sm:py-5 sm:text-2xl"
        >
          HOME
        </button>
      </div>
      </div>
    </div>
  )
}
