/**
 * Two boards behind a tab switch:
 *   FASTEST   — highest single score, any mode.
 *   MOST WINS — duel victories per set of initials.
 *
 * A status badge appears ONLY when Supabase is configured but unreachable.
 * Before it is configured there is nothing wrong to report, so we stay quiet
 * rather than claiming the board is local when a backend is on the way.
 */
import { useEffect, useState } from 'react'
import {
  getTop,
  getWins,
  type LeaderboardSource,
  type ScoreEntry,
  type WinEntry,
} from '../lib/leaderboard'

type Tab = 'fastest' | 'wins'

/**
 * Absolute date AND time of the entry, e.g. "27 Aug · 11:42 PM".
 * Never relative ("3 days ago") — a booth screen gets read weeks later.
 */
function formatWhen(iso: string): { date: string; time: string } {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { date: '', time: '' }
  return {
    date: d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
    time: d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
  }
}

export function Leaderboard({ refreshKey = 0 }: { refreshKey?: number }) {
  const [tab, setTab] = useState<Tab>('fastest')
  const [fastest, setFastest] = useState<ScoreEntry[]>([])
  const [wins, setWins] = useState<WinEntry[]>([])
  const [source, setSource] = useState<LeaderboardSource>('unset')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let alive = true
    void Promise.all([getTop(), getWins()]).then(([top, w]) => {
      if (!alive) return
      setFastest(top.entries)
      setWins(w.entries)
      setSource(top.source)
      setLoaded(true)
    })
    return () => {
      alive = false
    }
  }, [refreshKey])

  const rows = tab === 'fastest' ? fastest.length : wins.length

  return (
    <div className="w-full max-w-2xl">
      <div className="mb-2 flex items-end justify-between border-b border-gold/30 pb-1">
        <div className="flex gap-1">
          {(
            [
              ['fastest', 'FASTEST'],
              ['wins', 'MOST WINS'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`display px-3 py-1 text-lg tracking-[0.15em] transition ${
                tab === key
                  ? 'border-b-2 border-gold text-gold'
                  : 'border-b-2 border-transparent text-muted hover:text-ink'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {source === 'offline' && (
          <span className="pb-1 text-[10px] uppercase tracking-[0.2em] text-danger">
            offline — showing saved scores
          </span>
        )}
      </div>

      {loaded && rows === 0 ? (
        <p className="py-3 text-sm text-muted">
          {tab === 'fastest' ? 'No scores yet. Be the first.' : 'No duels won yet. Grab a friend.'}
        </p>
      ) : tab === 'fastest' ? (
        <ol className="font-mono text-sm">
          {fastest.map((e, i) => {
            const when = formatWhen(e.date)
            return (
              <li
                key={`${e.name}-${e.date}-${i}`}
                className="flex items-baseline gap-3 border-b border-white/5 py-1"
              >
                <span className="tnum w-6 shrink-0 text-muted">{i + 1}</span>
                <span className="display flex-1 truncate text-lg tracking-wide text-ink">
                  {e.name}
                </span>
                <span className="tnum w-16 shrink-0 text-right text-lg text-gold">{e.score}</span>
                <span className="w-12 shrink-0 text-right text-[10px] uppercase text-muted">
                  {e.mode}
                </span>
                <span className="tnum w-28 shrink-0 text-right text-[10px] text-muted/70">
                  {when.date} · {when.time}
                </span>
              </li>
            )
          })}
        </ol>
      ) : (
        <ol className="font-mono text-sm">
          {wins.map((w, i) => (
            <li
              key={`${w.name}-${i}`}
              className="flex items-baseline gap-3 border-b border-white/5 py-1"
            >
              <span className="tnum w-6 shrink-0 text-muted">{i + 1}</span>
              <span className="display flex-1 truncate text-lg tracking-wide text-ink">
                {w.name}
              </span>
              <span className="tnum w-24 shrink-0 text-right text-lg text-gold">
                {w.wins} <span className="text-xs text-muted">{w.wins === 1 ? 'win' : 'wins'}</span>
              </span>
              <span className="tnum w-20 shrink-0 text-right text-[10px] text-muted/70">
                best {w.bestScore}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
