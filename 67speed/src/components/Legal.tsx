/**
 * Terms / disclaimer and privacy notice.
 *
 * EVERY factual claim here was checked against the code on 2026-08-28:
 *   - no toDataURL / toBlob / captureStream / MediaRecorder anywhere, so camera
 *     frames genuinely cannot leave the browser;
 *   - the only outbound requests in src/ are the three Supabase leaderboard
 *     calls in src/lib/leaderboard.ts;
 *   - the five localStorage keys listed below are the complete set.
 *
 * If you change what the app stores or sends, change this file in the same
 * commit. A privacy notice that has drifted from the code is worse than none.
 */
import { useEffect } from 'react'

export type LegalTab = 'terms' | 'privacy'

/** Where people report a bad entry. Swap in a club email if you'd rather. */
const CONTACT_URL = 'https://github.com/Danielw412/NA-ComputerAI-Club/issues'

interface Props {
  tab: LegalTab | null
  onSelect: (tab: LegalTab) => void
  onClose: () => void
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h3 className="display mb-1 text-lg tracking-[0.15em] text-gold">{title}</h3>
      <div className="space-y-2 text-sm leading-relaxed text-ink/85">{children}</div>
    </section>
  )
}

export function Legal({ tab, onSelect, onClose }: Props) {
  useEffect(() => {
    if (!tab) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    // Capture phase so this wins over the app-wide Escape handler.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [tab, onClose])

  if (!tab) return null

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-3xl flex-col border border-gold/40 bg-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
          <div className="flex gap-1">
            {(
              [
                ['terms', 'TERMS & DISCLAIMER'],
                ['privacy', 'PRIVACY & DATA'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => onSelect(key)}
                className={`display px-3 py-1 text-base tracking-[0.12em] transition ${
                  tab === key
                    ? 'border-b-2 border-gold text-gold'
                    : 'border-b-2 border-transparent text-muted hover:text-ink'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            onClick={onClose}
            className="border border-white/20 px-3 py-1 text-xs uppercase tracking-[0.2em] text-muted hover:bg-white/5"
          >
            close
          </button>
        </div>

        <div className="scroll-dark overflow-y-auto px-6 py-5">
          {tab === 'terms' ? (
            <>
              <Section title="NOT AFFILIATED WITH NORTH ALLEGHENY">
                <p>
                  NA 67 SPEED is a student project made by members of the NA Computer &amp; AI
                  Club. It is <strong className="text-ink">not</strong> officially supported,
                  operated, endorsed, sponsored, reviewed, or backed by the North Allegheny
                  School District, any North Allegheny school, or their staff.
                </p>
                <p>
                  Opinions and content here are the club members&apos; own. &quot;NA&quot; refers
                  to the club&apos;s name only.
                </p>
              </Section>

              <Section title="USER-SUBMITTED NAMES">
                <p>
                  Leaderboard names are typed in by players. Entries are not reviewed before they
                  appear, so we cannot guarantee that every name is appropriate.
                </p>
                <p>
                  We remove anything inappropriate as soon as we see it, and we may remove or edit
                  any entry, for any reason, without notice.{' '}
                  <a
                    href={CONTACT_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-gold underline underline-offset-4"
                  >
                    Report an entry
                  </a>
                  .
                </p>
              </Section>

              <Section title="USE AT YOUR OWN RISK">
                <p>
                  This game asks you to move your arms quickly. Give yourself clear space, and
                  stop if you feel any pain or discomfort. Play sensibly and look after the people
                  around you.
                </p>
                <p>
                  The game is provided &quot;as is&quot;, without warranty of any kind. The club
                  and its members are not liable for any injury, loss, or damage arising from
                  using it.
                </p>
              </Section>
            </>
          ) : (
            <>
              <Section title="YOUR CAMERA NEVER LEAVES YOUR DEVICE">
                <p>
                  Pose detection runs entirely in your browser. Camera frames are{' '}
                  <strong className="text-ink">never uploaded, recorded, or transmitted</strong>{' '}
                  anywhere — not to us, not to anyone. No video or images are saved, not even on
                  your own device.
                </p>
                <p>
                  The camera only turns on once you pick a mode, and it switches off when you
                  return to the home screen.
                </p>
              </Section>

              <Section title="WHAT WE STORE — ONLY IF YOU SUBMIT A SCORE">
                <p>
                  Nothing is sent anywhere unless you finish a run and choose to put yourself on
                  the leaderboard. If you do, we store exactly four things:
                </p>
                <ul className="ml-5 list-disc space-y-1">
                  <li>the name you typed</li>
                  <li>your score, and which mode you played</li>
                  <li>whether you won, if it was a duel</li>
                  <li>the date and time you submitted</li>
                </ul>
                <p>
                  <strong className="text-ink">
                    The name you enter is shown publicly on the leaderboard.
                  </strong>{' '}
                  Use a first name or a nickname if you would rather not show your full name. You
                  can always press &quot;skip&quot; instead of entering one.
                </p>
                <p>
                  Leaderboard entries are held in a Supabase database. You can ask us to delete
                  yours at any time —{' '}
                  <a
                    href={CONTACT_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-gold underline underline-offset-4"
                  >
                    get in touch
                  </a>
                  .
                </p>
              </Section>

              <Section title="SAVED IN THIS BROWSER ONLY">
                <p>
                  These stay on the computer you are playing on and are never sent to us: your
                  personal best, your sound on/off choice, camera tuning settings, and a local
                  copy of the leaderboard so it still works offline. Clearing this site&apos;s
                  data removes all of them.
                </p>
              </Section>

              <Section title="WHAT WE DO NOT DO">
                <p>
                  No accounts, no sign-ups, no tracking cookies, no analytics, no advertising, and
                  no selling or sharing of data. We do not ask for your email, and we have no way
                  to identify you beyond the name you choose to type.
                </p>
                <p className="text-muted">
                  The site is hosted on Cloudflare Pages and the leaderboard runs on Supabase.
                  Like any website, those providers keep their own standard server logs, which can
                  include your IP address. We do not control, read, or use those logs.
                </p>
              </Section>
            </>
          )}

          <p className="mt-6 border-t border-white/10 pt-4 text-xs text-muted">
            Last updated 28 August 2026. Questions or removal requests:{' '}
            <a
              href={CONTACT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gold underline underline-offset-4"
            >
              club GitHub
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  )
}
