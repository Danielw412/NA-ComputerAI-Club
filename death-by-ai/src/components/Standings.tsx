import { useLayoutEffect, useRef } from 'react'
import type { OutcomeView, PlayerView } from '../../shared/protocol.ts'
import { useCountUp, useReducedMotion } from '../lib/hooks.ts'
import { Tally } from './ui.tsx'

export interface Ranked extends PlayerView {
  rank: number
  previousScore: number
}

function compare(a: { score: number; survivals: number; name: string }, b: typeof a) {
  return b.score - a.score || b.survivals - a.survivals || a.name.localeCompare(b.name)
}

/** Standard competition ranking (1, 1, 3), plus each player's score before this round. */
export function rankPlayers(players: PlayerView[], roundPoints: Record<string, OutcomeView> = {}): Ranked[] {
  const sorted = [...players].sort(compare)
  return sorted.map((player) => ({
    ...player,
    rank: sorted.findIndex((p) => p.score === player.score && p.survivals === player.survivals) + 1,
    previousScore: player.score - (roundPoints[player.id]?.points ?? 0),
  }))
}

function Score({ value, from }: { value: number; from: number }) {
  return <span className="numeric standing-score">{useCountUp(value, from, 1100)}</span>
}

/**
 * Ranked list that slides each row from its pre-round position to its new one,
 * while scores count up. One orchestrated moment per scoreboard.
 */
export function Standings({
  ranked,
  you,
  limit = ranked.length,
  animate = true,
  className = '',
}: {
  ranked: Ranked[]
  you?: string | null
  limit?: number
  animate?: boolean
  className?: string
}) {
  const listRef = useRef<HTMLOListElement>(null)
  const reduced = useReducedMotion()
  const shown = ranked.slice(0, limit)

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list || !animate || reduced) return
    const before = [...ranked].sort((a, b) => compare({ ...a, score: a.previousScore }, { ...b, score: b.previousScore }))
    const rows = Array.from(list.children) as HTMLElement[]
    const height = rows[0]?.offsetHeight ?? 0
    rows.forEach((row, index) => {
      const id = row.dataset.id
      const previous = before.findIndex((p) => p.id === id)
      const offset = Math.min(previous, limit) - index
      if (!offset) return
      row.animate([{ transform: `translateY(${offset * height}px)` }, { transform: 'none' }], {
        duration: 1000,
        delay: 350,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
        fill: 'backwards',
      })
    })
    // Only on mount: the scoreboard is a single reveal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <ol ref={listRef} className={`standings ${className}`}>
      {shown.map((player) => (
        <li key={player.id} data-id={player.id} className={`standing${player.id === you ? ' standing-you' : ''}`}>
          <span className="standing-rank">{player.rank}</span>
          <span className="standing-name">{player.name}</span>
          <Tally history={player.history} />
          <Score value={player.score} from={animate ? player.previousScore : player.score} />
        </li>
      ))}
    </ol>
  )
}
