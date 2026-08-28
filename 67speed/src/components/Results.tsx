/**
 * Results + arcade-style initials entry for anyone who makes the top 10.
 */
import { useEffect, useRef, useState } from 'react'
import type { RunResult } from '../game/useGame'
import { audio } from '../lib/audio'
import {
  NAME_LENGTH,
  getTop,
  isNameAllowed,
  personalBest,
  qualifies,
  sanitizeName,
  setPersonalBest,
  submit,
  type ScoreEntry,
} from '../lib/leaderboard'

interface Props {
  result: RunResult
  onAgain: () => void
  onHome: () => void
  onSubmitted: () => void
}

export function Results({ result, onAgain, onHome, onSubmitted }: Props) {
  const { mode, scores, durationMs } = result
  const best = scores.reduce((a, b) => Math.max(a, b), 0)
  const winnerIndex = scores.indexOf(best)
  const tie = mode === 'duel' && scores[0] === scores[1]

  const [prevBest] = useState(() => personalBest())
  const [eligible, setEligible] = useState(false)
  const [name, setName] = useState('')
  const [saved, setSaved] = useState(false)
  const [rejected, setRejected] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (mode === 'solo') setPersonalBest(best)
    let alive = true
    void getTop().then(({ entries }) => {
      if (!alive) return
      const ok = qualifies(best, entries)
      setEligible(ok)
      if (ok) audio.fanfare()
    })
    return () => {
      alive = false
    }
  }, [best, mode])

  useEffect(() => {
    if (eligible && !saved) inputRef.current?.focus()
  }, [eligible, saved])

  const rps = durationMs > 0 ? best / (durationMs / 1000) : 0
  const delta = mode === 'solo' ? best - prevBest : 0

  const save = async () => {
    const clean = sanitizeName(name)
    if (!isNameAllowed(clean)) {
      setRejected(true)
      return
    }
    const entry: ScoreEntry = {
      name: clean,
      score: best,
      mode,
      date: new Date().toISOString(),
    }
    await submit(entry)
    setSaved(true)
    onSubmitted()
  }

  return (
    <div className="relative z-20 flex h-full flex-col items-center justify-center gap-6 px-6 text-center">
      {mode === 'duel' && (
        <p className="display text-5xl tracking-[0.15em] text-gold">
          {tie ? 'DEAD HEAT' : `PLAYER ${winnerIndex + 1} WINS`}
        </p>
      )}

      {mode === 'duel' ? (
        <div className="flex items-end gap-16">
          {scores.map((s, i) => (
            <div key={i} className="flex flex-col items-center">
              <span className={`display text-xl tracking-[0.3em] ${i === winnerIndex && !tie ? 'text-gold' : 'text-muted'}`}>
                P{i + 1}
              </span>
              <span className={`display tnum text-[10rem] leading-none ${i === winnerIndex && !tie ? 'text-gold' : 'text-ink'}`}>
                {s}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <span
          className="display tnum text-[16rem] leading-none text-gold"
          style={{ textShadow: '0 0 60px rgba(250,170,19,0.4)' }}
        >
          {best}
        </span>
      )}

      <div className="flex gap-10 font-mono text-sm text-muted">
        <span className="tnum">{rps.toFixed(2)} reps/sec</span>
        {mode === 'solo' && (
          <span className="tnum">
            {delta > 0 ? (
              <span className="text-gold">NEW PERSONAL BEST +{delta}</span>
            ) : prevBest > 0 ? (
              `personal best ${prevBest}`
            ) : (
              'first run'
            )}
          </span>
        )}
      </div>

      {eligible && !saved && (
        <div className="flex flex-col items-center gap-2 border border-gold/40 bg-surface/80 px-8 py-5">
          <p className="display text-2xl tracking-[0.2em] text-gold">TOP 10 — ENTER INITIALS</p>
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
            maxLength={NAME_LENGTH}
            placeholder="AAA"
            className="display w-40 border-b-2 border-gold bg-transparent text-center text-6xl tracking-[0.4em] text-ink outline-none placeholder:text-muted/30"
          />
          {rejected && (
            <p className="text-sm text-danger">Pick three letters. Keep it clean.</p>
          )}
          <button
            onClick={() => void save()}
            disabled={sanitizeName(name).length !== NAME_LENGTH}
            className="display mt-1 border-2 border-gold px-8 py-2 text-xl tracking-[0.2em] text-gold hover:bg-gold/15 disabled:opacity-40"
          >
            SAVE
          </button>
        </div>
      )}
      {saved && <p className="text-sm uppercase tracking-[0.3em] text-gold">saved to the board</p>}

      <div className="mt-2 flex gap-4">
        <button
          onClick={onAgain}
          className="display border-2 border-gold bg-gold px-16 py-5 text-4xl tracking-[0.1em] text-bg hover:bg-gold/85"
        >
          GO AGAIN
        </button>
        <button
          onClick={onHome}
          className="display border-2 border-white/25 px-8 py-5 text-2xl tracking-[0.1em] text-muted hover:bg-white/5"
        >
          HOME
        </button>
      </div>
    </div>
  )
}
