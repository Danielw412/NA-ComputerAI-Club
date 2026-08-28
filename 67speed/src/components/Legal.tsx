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
    <section className="mb-6">
      <h3 className="display mb-1.5 text-base leading-tight tracking-[0.12em] text-gold sm:text-lg sm:tracking-[0.15em]">
        {title}
      </h3>
      <div className="space-y-2 text-sm leading-relaxed text-ink/85">{children}</div>
    </section>
  )
}

export function Legal({ tab, onSelect, onClose }: Props) {
  useEffect(() => {
    if (!tab) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
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
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/85 p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={tab === 'terms' ? 'Terms of Use' : 'Privacy Notice'}
        className="flex h-full max-h-none w-full max-w-3xl flex-col border-x border-gold/40 bg-surface sm:h-auto sm:max-h-[88dvh] sm:border"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-2 border-b border-white/10 px-3 py-3 sm:items-center sm:px-5">
          <div role="tablist" className="grid min-w-0 flex-1 grid-cols-2 gap-1">
            {(
              [
                ['terms', 'TERMS OF USE'],
                ['privacy', 'PRIVACY NOTICE'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={tab === key}
                onClick={() => onSelect(key)}
                className={`display min-w-0 px-1 py-2 text-sm leading-tight tracking-[0.08em] transition sm:px-3 sm:py-1 sm:text-base sm:tracking-[0.12em] ${
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
            className="shrink-0 border border-white/20 px-2.5 py-2 text-[10px] uppercase tracking-[0.14em] text-muted hover:bg-white/5 sm:px-3 sm:py-1 sm:text-xs sm:tracking-[0.2em]"
          >
            close
          </button>
        </div>

        <div className="scroll-dark safe-bottom overflow-y-auto px-4 py-5 sm:px-6">
          {tab === 'terms' ? (
            <>
              <Section title="ABOUT THESE TERMS">
                <p>
                  These Terms of Use apply when you play 67 SPEED or submit a leaderboard entry.
                  By using the site, you agree to follow them. If you do not agree, do not use the
                  site.
                </p>
                <p>
                  67 SPEED is an independent student project by the NA Computer &amp; AI Club. It
                  is not operated, sponsored, endorsed, or reviewed by the North Allegheny School
                  District, any North Allegheny school, or their staff.
                </p>
              </Section>

              <Section title="PLAY SAFELY">
                <p>
                  The game asks you to move your arms quickly. Use it only when you have enough
                  clear space. Keep away from people, furniture, cables, and other hazards. Stop
                  immediately if you feel pain, dizziness, or discomfort.
                </p>
                <p>
                  You are responsible for deciding whether you can safely participate and for
                  supervising younger players. Camera access is optional, but the game cannot run
                  without it.
                </p>
              </Section>

              <Section title="LEADERBOARD RULES">
                <p>
                  Leaderboard submissions are public. Use a nickname that does not identify you.
                  Never enter a full name, email address, phone number, social media handle, school
                  schedule, or other contact information. If you are under 13, do not submit a
                  leaderboard entry.
                </p>
                <p>
                  Do not submit offensive, threatening, impersonating, misleading, automated, or
                  fraudulent entries. We may hide, edit, or remove any entry and may restrict
                  access when needed to protect the game or its players. Entries are not reviewed
                  before publication.{' '}
                  <a
                    href={CONTACT_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-gold underline underline-offset-4"
                  >
                    Report a leaderboard entry
                  </a>
                  .
                </p>
              </Section>

              <Section title="AVAILABILITY AND DISCLAIMER">
                <p>
                  This site is provided for fun and education. It may be changed, interrupted, or
                  removed at any time. Scores and pose estimates can be inaccurate, and we do not
                  promise that the site will always be available, secure, or error-free.
                </p>
                <p>
                  To the fullest extent permitted by law, the site is provided &quot;as is&quot; and
                  without warranties. The club and its members are not responsible for indirect,
                  incidental, or consequential loss arising from use of the site. Nothing in these
                  terms excludes rights or liability that cannot legally be excluded.
                </p>
              </Section>

              <Section title="CHANGES AND CONTACT">
                <p>
                  We may update these terms when the game or its data practices change. The date
                  below shows the latest revision. Continued use after an update means the revised
                  terms apply.
                </p>
              </Section>
            </>
          ) : (
            <>
              <Section title="PRIVACY AT A GLANCE">
                <p>
                  Camera images and pose detection stay on your device. We do not receive or save
                  your video, photos, pose landmarks, or movement data. The only information you
                  can choose to send to us is a leaderboard entry.
                </p>
              </Section>

              <Section title="CAMERA AND POSE PROCESSING">
                <p>
                  After you choose a game mode and grant browser permission, MediaPipe processes
                  camera frames in your browser to estimate body landmarks and count arm pumps.
                  The app does not upload, record, export, or store camera frames. Camera access
                  stops when you return to the home screen or close the site.
                </p>
              </Section>

              <Section title="PUBLIC LEADERBOARD DATA">
                <p>
                  If you choose to submit an entry, we send these fields to our Supabase
                  leaderboard:
                </p>
                <ul className="ml-5 list-disc space-y-1">
                  <li>the nickname you entered</li>
                  <li>your score and game mode</li>
                  <li>whether the entry was a duel win</li>
                  <li>the submission date and time</li>
                </ul>
                <p>
                  <strong className="text-ink">
                    Your nickname, score, mode, and submission time can appear publicly.
                  </strong>{' '}
                  Use a nickname that does not identify you. Do not enter a full name or any
                  contact information. You can always choose &quot;skip&quot; and submit nothing.
                </p>
                <p>
                  Leaderboard entries remain until we remove them. To request removal, open a
                  GitHub issue with the nickname, score, mode, and approximate submission time.
                  Do not include any additional personal information.{' '}
                  <a
                    href={CONTACT_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-gold underline underline-offset-4"
                  >
                    Request removal
                  </a>
                  .
                </p>
              </Section>

              <Section title="SAVED ONLY IN YOUR BROWSER">
                <p>
                  The app stores your personal best, sound preference, camera tuning settings,
                  tracker settings, and a local backup of scores submitted from that browser.
                  This information stays in browser storage. Clearing this site&apos;s data removes
                  it from that device.
                </p>
              </Section>

              <Section title="HOSTING AND SERVICE PROVIDERS">
                <p>
                  Cloudflare Pages delivers the site, and Supabase hosts the leaderboard. Like
                  other hosting providers, they may process technical request data such as IP
                  addresses, browser details, timestamps, and security logs under their own terms
                  and privacy practices.
                </p>
                <p>
                  The club does not use accounts, analytics, advertising, tracking cookies, or
                  data sales in this app. We do not ask for an email address or precise location.
                </p>
              </Section>

              <Section title="CHILDREN'S PRIVACY">
                <p>
                  This site does not ask for your age. If you are under 13, play without submitting
                  a leaderboard entry. All players should use a non-identifying nickname and avoid
                  sharing personal information.
                </p>
              </Section>

              <Section title="CHANGES AND QUESTIONS">
                <p>
                  We will update this notice if the app begins collecting or using information in
                  a different way. Questions, privacy concerns, and removal requests can be sent
                  through the club GitHub link below.
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
