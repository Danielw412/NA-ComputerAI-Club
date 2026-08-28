/**
 * Home screen. Deliberately plain: play buttons, leaderboard, footer.
 * No camera runs here - getUserMedia is only called once a mode is chosen.
 */
import { Leaderboard } from './Leaderboard'
import type { GameMode } from '../lib/leaderboard'
import type { LegalTab } from './Legal'

/**
 * Other NA Computer & AI Club projects, shown in the footer. Every URL here was
 * confirmed to respond before being added - do not add a link you have not
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
    { label: 'Terms of Use', onClick: () => onOpenLegal('terms') },
    { label: 'Privacy Notice', onClick: () => onOpenLegal('privacy') },
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
      <div className="safe-bottom flex min-h-full flex-col items-center justify-center gap-6 px-4 pt-16 sm:gap-8 sm:px-6 sm:py-10">
      <div className="flex min-w-0 flex-col items-center gap-3 sm:gap-5">
        <img src="/na-club-logo-dark.png" alt="NA Computer & AI Club" className="h-20 w-20 sm:h-28 sm:w-28" />
        {/* Just "67" - the logo directly above already carries the NA mark,
            so repeating it in the wordmark was redundant. Sized up because two
            characters at the old size read as small rather than bold. */}
        <h1 className="display whitespace-nowrap text-[clamp(4.25rem,22vw,8rem)] leading-none tracking-[0.03em] text-gold">
          67 SPEED
        </h1>
      </div>

      <div className="flex w-full max-w-sm flex-col items-stretch justify-center gap-3 sm:max-w-2xl sm:flex-row sm:gap-4">
        <button
          onClick={() => onStart('solo')}
          disabled={starting}
          className="display min-h-16 w-full border-2 border-gold bg-gold px-8 py-4 text-3xl tracking-[0.1em] text-bg transition hover:bg-gold/85 disabled:opacity-50 sm:w-auto sm:px-14 sm:py-6 sm:text-4xl"
        >
          SOLO
        </button>
        <button
          onClick={() => onStart('duel')}
          disabled={starting}
          className="display min-h-16 w-full border-2 border-gold px-8 py-4 text-3xl tracking-[0.1em] text-gold transition hover:bg-gold/15 disabled:opacity-50 sm:w-auto sm:px-14 sm:py-6 sm:text-4xl"
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
        <nav className="grid w-full grid-cols-2 border-y border-white/10 sm:flex sm:w-auto sm:flex-wrap sm:items-center sm:justify-center sm:divide-x sm:divide-white/10">
          {FOOTER_LINKS.map((item) => {
            const className =
              'group flex min-w-0 items-center justify-center gap-1.5 px-2 py-3 text-center text-[10px] uppercase tracking-[0.12em] text-muted transition hover:bg-white/5 hover:text-gold sm:px-5 sm:py-2.5 sm:text-xs sm:tracking-[0.2em]'
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

        <p className="text-center text-[10px] uppercase tracking-[0.14em] text-muted sm:text-[11px] sm:tracking-[0.2em]">
          100% on-device. Camera images stay on your computer.
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
