/**
 * Home screen. Deliberately plain: buttons, leaderboard, privacy line.
 * No camera runs here — getUserMedia is only called once a mode is chosen.
 */
import { Leaderboard } from './Leaderboard'
import type { GameMode } from '../lib/leaderboard'

/**
 * Other NA Computer & AI Club projects. Every URL here was confirmed to
 * respond before being added — do not add a link you have not loaded.
 */
const CLUB_LINKS = [
  { label: 'Schedule Share', href: 'https://schedule.naclubs.net', icon: '🗓' },
  { label: 'Club GitHub', href: 'https://github.com/Danielw412/NA-ComputerAI-Club', icon: '⌨' },
] as const

interface Props {
  onStart: (mode: GameMode) => void
  onTrackerTest: () => void
  starting: boolean
  error: string | null
  leaderboardKey: number
}

export function Home({ onStart, onTrackerTest, starting, error, leaderboardKey }: Props) {
  return (
    <div className="relative z-20 flex h-full flex-col items-center justify-center gap-8 overflow-y-auto px-6 py-10">
      <div className="flex flex-col items-center gap-5">
        <img src="/na-club-logo-dark.png" alt="NA Computer & AI Club" className="h-28 w-28" />
        <h1 className="display text-7xl leading-none tracking-[0.06em] text-gold">
          NA 67 SPEED
        </h1>
      </div>

      <div className="flex flex-wrap items-stretch justify-center gap-4">
        <button
          onClick={() => onStart('solo')}
          disabled={starting}
          className="display border-2 border-gold bg-gold px-14 py-6 text-4xl tracking-[0.1em] text-bg transition hover:bg-gold/85 disabled:opacity-50"
        >
          SOLO
        </button>
        <button
          onClick={() => onStart('duel')}
          disabled={starting}
          className="display border-2 border-gold px-14 py-6 text-4xl tracking-[0.1em] text-gold transition hover:bg-gold/15 disabled:opacity-50"
        >
          DUEL 1v1
        </button>
      </div>

      {starting && (
        <p className="text-sm uppercase tracking-[0.25em] text-gold">starting camera…</p>
      )}
      {error && <p className="max-w-md text-center text-danger">{error}</p>}

      <Leaderboard refreshKey={leaderboardKey} />

      {/* Other club projects. Both URLs verified live before linking. */}
      <div className="flex flex-wrap items-center justify-center gap-3">
        {CLUB_LINKS.map((link) => (
          <a
            key={link.href}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="group flex items-center gap-2 border border-white/15 px-4 py-2 text-xs uppercase tracking-[0.2em] text-muted transition hover:border-gold/50 hover:text-gold"
          >
            <span aria-hidden="true" className="text-base leading-none">
              {link.icon}
            </span>
            {link.label}
            <span aria-hidden="true" className="opacity-40 group-hover:opacity-100">
              ↗
            </span>
          </a>
        ))}
      </div>

      <div className="flex flex-col items-center gap-2">
        <p className="text-xs uppercase tracking-[0.2em] text-muted">
          100% on-device — nothing leaves your computer
        </p>
        <button
          onClick={onTrackerTest}
          className="text-[10px] uppercase tracking-[0.2em] text-muted/60 underline-offset-4 hover:text-muted hover:underline"
        >
          tracker test
        </button>
      </div>
    </div>
  )
}
