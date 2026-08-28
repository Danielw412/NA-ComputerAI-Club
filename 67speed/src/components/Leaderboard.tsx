import { useEffect, useState } from 'react'
import { getTop, type LeaderboardResult } from '../lib/leaderboard'

export function Leaderboard({ refreshKey = 0 }: { refreshKey?: number }) {
  const [data, setData] = useState<LeaderboardResult | null>(null)

  useEffect(() => {
    let alive = true
    void getTop().then((r) => alive && setData(r))
    return () => {
      alive = false
    }
  }, [refreshKey])

  const entries = data?.entries ?? []

  return (
    <div className="w-full max-w-md">
      <div className="mb-2 flex items-baseline justify-between border-b border-gold/30 pb-1">
        <h2 className="display text-xl tracking-[0.2em] text-gold">ALL-TIME TOP 10</h2>
        {data && !data.online && (
          <span className="text-[10px] uppercase tracking-[0.2em] text-muted">local only</span>
        )}
      </div>
      {entries.length === 0 ? (
        <p className="py-3 text-sm text-muted">No scores yet. Be the first.</p>
      ) : (
        <ol className="font-mono text-sm">
          {entries.map((e, i) => (
            <li
              key={`${e.name}-${e.date}-${i}`}
              className="flex items-baseline gap-3 border-b border-white/5 py-1"
            >
              <span className="tnum w-6 text-muted">{i + 1}</span>
              <span className="display w-14 text-lg tracking-widest text-ink">{e.name}</span>
              <span className="tnum flex-1 text-right text-lg text-gold">{e.score}</span>
              <span className="w-12 text-right text-[10px] uppercase text-muted">{e.mode}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
