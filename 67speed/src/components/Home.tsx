/**
 * Home screen. Deliberately plain: play buttons, leaderboard, footer.
 * No camera runs here — getUserMedia is only called once a mode is chosen.
 */
import { Leaderboard } from './Leaderboard'
import type { GameMode } from '../lib/leaderboard'
import type { LegalTab } from './Legal'

/**
 * Other NA Computer & AI Club projects, shown in the footer. Every URL here was
 * confirmed to respond before being added — do not add a link you have not
 * loaded.
 */
const CLUB_LINKS = [
  { label: 'Schedule Share', href: 'https://schedule.naclubs.net' },
  { label: 'Club GitHub', href: 'https://github.com/Danielw412/NA-ComputerAI-Club' },
] as const

interface Props {
  onStart: (mode: GameMode) => void
  onTrackerTest: () => void
  onOpenLegal: (tab: LegalTab) => void
  starting: boolean
  error: string | null
  leaderboardKey: number
}

export function Home({
  onStart,
  onTrackerTest,
  onOpenLegal,
  starting,
  error,
  leaderboardKey,
}: Props) {
  const FOOTER_LINKS: ReadonlyArray<{
    label: string
    href?: string
    onClick?: () => void
  }> = [
    ...CLUB_LINKS,
    { label: 'Terms & Disclaimer', onClick: () => onOpenLegal('terms') },
    { label: 'Privacy & Data', onClick: () => onOpenLegal('privacy') },
  ]

  return (
    /*
      Scroll on the OUTER element, centre on the inner one with min-h-full.
      Putting overflow-y-auto and justify-center on the SAME element is the bug
      that clipped the logo: once centred content is taller than its container,
      the overflow spills off BOTH ends and the top cannot be scrolled back to.
      With this split the content centres while it fits and scrolls from the top
      once it does not.
    */
    <div className="scroll-dark relative z-20 h-full overflow-y-auto">
      <div className="flex min-h-full flex-col items-center justify-center gap-8 px-6 py-10">
      <div className="flex flex-col items-center gap-5">
        <img src="/na-club-logo-dark.png" alt="NA Computer & AI Club" className="h-28 w-28" />
        {/* Just "67" — the logo directly above already carries the NA mark,
            so repeating it in the wordmark was redundant. Sized up because two
            characters at the old size read as small rather than bold. */}
        <h1 className="display text-9xl leading-none tracking-[0.04em] text-gold">67 SPEED</h1>
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

      {/*
        One footer bar: all four links side by side, separated by hairlines
        rather than each being its own boxed button. Four separate boxes across
        two rows read as clutter competing with the SOLO/DUEL buttons; the
        arcade rule is that only the things you press mid-game should look
        pressable.
      */}
      <footer className="mt-2 flex w-full max-w-3xl flex-col items-center gap-3">
        <nav className="flex flex-wrap items-center justify-center divide-x divide-white/10 border-y border-white/10">
          {FOOTER_LINKS.map((item) => {
            const className =
              'group flex items-center gap-2 px-5 py-2.5 text-xs uppercase tracking-[0.2em] text-muted transition hover:bg-white/5 hover:text-gold'
            return item.href ? (
              <a
                key={item.label}
                href={item.href}
                target="_blank"
                rel="noopener noreferrer"
                className={className}
              >
                {item.label}
                <span aria-hidden="true" className="opacity-30 group-hover:opacity-100">
                  ↗
                </span>
              </a>
            ) : (
              <button key={item.label} onClick={item.onClick} className={className}>
                {item.label}
              </button>
            )
          })}
        </nav>

        <p className="text-[11px] uppercase tracking-[0.2em] text-muted">
          100% on-device — nothing leaves your computer
        </p>

        <p className="max-w-xl text-center text-[10px] leading-relaxed text-muted/55">
          Not affiliated with, endorsed by, or operated by the North Allegheny School District.
          A student project by the NA Computer &amp; AI Club.
        </p>

        <button
          onClick={onTrackerTest}
          className="text-[10px] uppercase tracking-[0.2em] text-muted/50 underline-offset-4 hover:text-muted hover:underline"
        >
          tracker test
        </button>
        </footer>
      </div>
    </div>
  )
}
