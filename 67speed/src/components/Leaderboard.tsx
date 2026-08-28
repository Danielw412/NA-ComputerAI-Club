/**
 * Two boards behind a tab switch:
 *   FASTEST: highest single score, any mode, one row per name.
 *   MOST WINS: duel victories per name.
 *
 * Rendered as a real <table> inside a fixed-height scroll container, so the
 * board can hold any number of rows without changing the height of the page.
 * Before this, a long board pushed the home screen taller than the viewport and
 * the centred layout clipped the logo off the top where it could not be
 * scrolled back to.
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

/** Absolute date and time of the entry. Never relative ("3 days ago"). */
function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const date = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${date} · ${time}`
}

const TH = 'sticky top-0 z-10 bg-bg py-1.5 text-[9px] uppercase tracking-[0.14em] text-muted/70 sm:text-[10px] sm:tracking-[0.2em]'
const TD = 'border-t border-white/5 py-1.5 align-baseline'

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

  const empty = loaded && (tab === 'fastest' ? fastest.length === 0 : wins.length === 0)

  return (
    <div className="w-full max-w-2xl">
      <div className="mb-1 flex flex-col gap-1 border-b border-gold/30 pb-1 sm:flex-row sm:items-end sm:justify-between">
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
              className={`display px-2 py-1 text-base tracking-[0.12em] transition sm:px-3 sm:text-lg sm:tracking-[0.15em] ${
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
            Offline. Showing scores saved on this device.
          </span>
        )}
      </div>

      {empty ? (
        <p className="py-3 text-sm text-muted">
          {tab === 'fastest' ? 'No scores yet. Be the first.' : 'No duels won yet. Grab a friend.'}
        </p>
      ) : (
        // Fixed height + internal scroll: the page never grows with the board.
        // scroll-dark reserves the scrollbar's width instead of letting it
        // overlay the "When" column, and pr-3 keeps the bar off the text.
        <div className="scroll-dark max-h-56 overflow-y-auto overscroll-contain pr-1 sm:max-h-64 sm:pr-3">
          <table className="w-full table-fixed border-collapse font-mono text-xs sm:text-sm">
            {tab === 'fastest' ? (
              <>
                <thead>
                  <tr>
                    <th className={`${TH} w-7 text-left sm:w-10`}>#</th>
                    <th className={`${TH} text-left`}>Name</th>
                    <th className={`${TH} w-14 text-right sm:w-20`}>Score</th>
                    <th className={`${TH} hidden w-16 text-right sm:table-cell`}>Mode</th>
                    <th className={`${TH} hidden w-32 text-right sm:table-cell`}>When</th>
                  </tr>
                </thead>
                <tbody>
                  {fastest.map((e, i) => (
                    <tr key={`${e.name}-${e.date}-${i}`}>
                      <td className={`${TD} tnum text-muted`}>{i + 1}</td>
                      <td className={`${TD} min-w-0 pr-2`}>
                        <span className="display block truncate text-base tracking-wide text-ink sm:text-lg">
                          {e.name}
                        </span>
                        <span className="block truncate text-[9px] uppercase text-muted/70 sm:hidden">
                          {e.mode} · {formatWhen(e.date)}
                        </span>
                      </td>
                      <td className={`${TD} tnum text-right text-lg text-gold`}>{e.score}</td>
                      <td className={`${TD} hidden text-right text-[10px] uppercase text-muted sm:table-cell`}>
                        {e.mode}
                      </td>
                      <td className={`${TD} tnum hidden text-right text-[10px] text-muted/70 sm:table-cell`}>
                        {formatWhen(e.date)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </>
            ) : (
              <>
                <thead>
                  <tr>
                    <th className={`${TH} w-7 text-left sm:w-10`}>#</th>
                    <th className={`${TH} text-left`}>Name</th>
                    <th className={`${TH} w-24 text-right`}>Wins</th>
                    <th className={`${TH} w-24 text-right`}>Best</th>
                  </tr>
                </thead>
                <tbody>
                  {wins.map((w, i) => (
                    <tr key={`${w.name}-${i}`}>
                      <td className={`${TD} tnum text-muted`}>{i + 1}</td>
                      <td className={`${TD} display truncate text-lg tracking-wide text-ink`}>
                        {w.name}
                      </td>
                      <td className={`${TD} tnum text-right text-lg text-gold`}>{w.wins}</td>
                      <td className={`${TD} tnum text-right text-[10px] text-muted/70`}>
                        {w.bestScore}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </>
            )}
          </table>
        </div>
      )}
    </div>
  )
}
