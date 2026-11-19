import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react'
import { type Effort, formatCode, type HostSession, LIMITS, normalizePicks, type RoomView, stepKey } from '../../shared/protocol.ts'
import { ScenarioPicker } from '../components/ScenarioPicker.tsx'
import { rankPlayers, Standings } from '../components/Standings.tsx'
import {
  formatSeconds,
  DecisionChip,
  Logo,
  ROLE,
  QrCode,
  StageStatus,
  TimeBar,
  Trace,
  Typed,
  useSecondsLeft,
  Verdict,
  VerdictReason,
} from '../components/ui.tsx'
import { ApiError, createRoom, forgetHost, hostSession, rememberHostedRoom, socketTarget } from '../lib/api.ts'
import { useReducedMotion } from '../lib/hooks.ts'
import { navigate } from '../lib/route.ts'
import { type RoomConnection, useRoom } from '../lib/useRoom.ts'

type Send = RoomConnection['send']

export function HostGame({ code }: { code: string }) {
  const [session] = useState(hostSession)
  const target = useMemo(() => (session ? socketTarget(code, 'host', session.token) : null), [session, code])
  const connection = useRoom(target)

  // An expired or rotated password makes the socket upgrade fail with no message,
  // so check the session on load and whenever the socket has to reconnect.
  const reconnecting = connection.status === 'reconnecting'
  useEffect(() => {
    if (!session) {
      navigate('/host', true)
      return
    }
    const signOut = () => {
      forgetHost()
      navigate('/host', true)
    }
    if (session.expiresAt <= Date.now()) return signOut()
    fetch('/api/host/session', { headers: { Authorization: `Bearer ${session.token}` } })
      .then((r) => r.status === 401 && signOut())
      .catch(() => {})
  }, [session, reconnecting])

  useEffect(() => {
    if (connection.ended === 'expired') {
      forgetHost()
      navigate('/host', true)
    } else if (connection.ended) {
      rememberHostedRoom(null)
    }
  }, [connection.ended])

  if (!session) return null
  if (connection.ended) return <HostEnded />

  const { room } = connection
  if (!room) {
    return (
      <main className="host">
        <HostBar code={code} room={null} />
        <p className="notice">Connecting to the game</p>
      </main>
    )
  }

  const key = `${room.phase}:${room.round?.id ?? ''}`
  return (
    <main className={`host${room.phase === 'judging' ? ' host-fit' : ''}`}>
      <HostBar code={code} room={room} offline={connection.status !== 'open'} send={connection.send} />
      {room.phase === 'lobby' && (
        <Lobby key={key} room={room} send={connection.send} session={session} online={connection.status === 'open'} />
      )}
      {room.phase === 'writing' && <Writing key={key} room={room} connection={connection} />}
      {room.phase === 'judging' && <Judging key={key} room={room} send={connection.send} />}
      {room.phase === 'reveal' && <Reveal key={key} room={room} send={connection.send} />}
      {room.phase === 'scores' && <Scores key={key} room={room} send={connection.send} />}
      {room.phase === 'final' && <Final key={key} room={room} send={connection.send} />}
    </main>
  )
}

function HostBar({
  code,
  room,
  offline = false,
  send,
}: {
  code: string
  room: RoomView | null
  offline?: boolean
  send?: Send
}) {
  const inGame = room && room.phase !== 'lobby'
  const on = room?.settings.decisionModel ?? true
  return (
    <header className="bar">
      <div className="bar" style={{ gap: 20 }}>
        <Logo size={44} />
        {room?.round && inGame && room.phase !== 'final' && (
          <span className="host-meta quiet">
            Round {room.round.number} of {room.settings.rounds}
          </span>
        )}
      </div>
      <div className="bar-end host-meta">
        {offline && <span className="notice">Reconnecting</span>}
        {inGame && room.phase !== 'final' && send && (
          <button
            className="link link-quiet"
            aria-pressed={on}
            title={on ? 'Turn the Decision Model off: the LLM decides alone' : 'Turn the Decision Model back on'}
            onClick={() => send({ t: 'decisionModel', on: !on })}
          >
            {ROLE.judge} {on ? 'on' : 'off'}
          </button>
        )}
        {inGame && room.phase !== 'final' && (
          <span>
            <span className="quiet">Join with </span>
            <span className="numeric">{formatCode(code)}</span>
          </span>
        )}
      </div>
    </header>
  )
}

/** Space, Enter or → triggers the screen's main action. */
function useAdvanceKey(action: (() => void) | null) {
  useEffect(() => {
    if (!action) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (target.closest('input, textarea, button, a, [contenteditable]')) return
      if (event.repeat) return
      if (event.key === ' ' || event.key === 'Enter' || event.key === 'ArrowRight') {
        event.preventDefault()
        action()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [action])
}

// ------------------------------------------------------------------ lobby

const EFFORT_LABELS: Record<Effort, string> = { high: 'High', xhigh: 'Extra high' }

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i])

function Lobby({ room, send, session, online }: { room: RoomView; send: Send; session: HostSession; online: boolean }) {
  const joinUrl = `${location.origin}/join/${room.code}`
  const count = room.players.length
  const [confirmEnd, setConfirmEnd] = useState(false)
  const [picking, setPicking] = useState(false)
  const pickRef = useRef<HTMLButtonElement>(null)
  const { rounds } = room.settings
  const saved = room.settings.scenarios
  // Picks the server hasn't echoed yet. Everything reads these first, so reopening
  // the picker before the echo, or losing the connection, never drops an edit.
  const [pending, setPending] = useState<string[] | null>(null)
  const scenarios = pending ?? saved
  const picked = Math.min(scenarios.length, rounds)

  useEffect(() => {
    if (pending && sameList(pending, saved)) setPending(null)
  }, [pending, saved])

  // Resend unsaved picks once the connection is back.
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  useEffect(() => {
    if (online && pendingRef.current) send({ t: 'settings', settings: { scenarios: pendingRef.current } })
  }, [online, send])

  const changePicks = (list: string[]) => {
    const next = normalizePicks(list)
    setPending(next)
    send({ t: 'settings', settings: { scenarios: next } })
  }

  return (
    <>
      <section className="host-main">
        <div className="join-panel enter">
          <p className="host-text">
            Go to <strong>{location.host}</strong> and enter
          </p>
          <h1 className="code code-hero" aria-label={`Game code ${room.code.split('').join(' ')}`}>
            {formatCode(room.code)}
          </h1>
          <div className="settings">
            <Choice
              label="Rounds"
              options={LIMITS.rounds}
              value={room.settings.rounds}
              onChange={(rounds) => send({ t: 'settings', settings: { rounds } })}
            />
            <Choice
              label="Seconds to write"
              options={LIMITS.seconds}
              value={room.settings.seconds}
              onChange={(seconds) => send({ t: 'settings', settings: { seconds } })}
            />
            <Choice
              label="Survive at"
              options={LIMITS.thresholds}
              value={room.settings.threshold}
              format={(percent) => `${percent}%`}
              onChange={(threshold) => send({ t: 'settings', settings: { threshold } })}
            />
            <Choice
              label={ROLE.judge}
              options={['on', 'off'] as const}
              value={room.settings.decisionModel ? 'on' : 'off'}
              format={(value) => (value === 'on' ? 'On' : 'Off')}
              onChange={(value) => send({ t: 'decisionModel', on: value === 'on' })}
            />
            {room.models.efforts.length > 1 && (
              <Choice
                label="Thinking"
                options={room.models.efforts}
                value={room.settings.effort}
                format={(effort) => EFFORT_LABELS[effort]}
                onChange={(effort) => send({ t: 'settings', settings: { effort } })}
              />
            )}
            <div className="choice" role="group" aria-label="Scenarios">
              <span className="choice-label quiet">Scenarios</span>
              <button
                className="choice-option"
                aria-pressed={picked === 0}
                onClick={() => changePicks([])}
              >
                Random
              </button>
              <button ref={pickRef} className="choice-option" aria-pressed={picked > 0} onClick={() => setPicking(true)}>
                {picked > 0 ? `${picked} picked` : 'Choose'}
              </button>
            </div>
          </div>
        </div>
        <aside className="host-aside enter enter-late">
          <QrCode value={joinUrl} label={`QR code to join game ${room.code}`} />
        </aside>
      </section>

      <section className="stack">
        <h2 className="display title-m">
          {count === 0 ? 'Waiting for players' : `${count} ${count === 1 ? 'player' : 'players'}`}
        </h2>
        {count > 0 && (
          <ul className="names" aria-label="Players. Select a name to remove that player.">
            {room.players.map((p) => (
              <li key={p.id}>
                <button
                  className={`name name-button${p.connected ? '' : ' name-off'}`}
                  title={`Remove ${p.name}`}
                  onClick={() => send({ t: 'kick', id: p.id })}
                >
                  {p.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {picking && (
        <ScenarioPicker
          session={session}
          picked={scenarios}
          rounds={rounds}
          online={online}
          onChange={changePicks}
          onClose={() => {
            setPicking(false)
            requestAnimationFrame(() => pickRef.current?.focus())
          }}
        />
      )}

      <footer className="host-foot">
        <p className="small quiet">
          {room.settings.decisionModel
            ? `Decided by the ${ROLE.narrator} (${Math.round(room.models.weights.narrator * 100)}%) and the ${ROLE.judge} (${Math.round(room.models.weights.judge * 100)}%).`
            : `Decided by the ${ROLE.narrator} alone. The ${ROLE.judge} is off.`}
        </p>
        <div className="host-foot-end">
          {confirmEnd ? (
            <>
              <span className="small">End this game for everyone?</span>
              <button className="link" onClick={() => send({ t: 'close' })}>
                End game
              </button>
              <button className="link link-quiet" onClick={() => setConfirmEnd(false)}>
                Keep it
              </button>
            </>
          ) : (
            <button className="link link-quiet" onClick={() => setConfirmEnd(true)}>
              End game
            </button>
          )}
          <button className="btn" disabled={count === 0} onClick={() => send({ t: 'start' })}>
            Start game
          </button>
        </div>
      </footer>
    </>
  )
}

function Choice<T extends number | string>({
  label,
  options,
  value,
  format = String,
  onChange,
}: {
  label: string
  options: readonly T[]
  value: number | string
  format?: (value: T) => string
  onChange: (value: T) => void
}) {
  return (
    <div className="choice" role="group" aria-label={label}>
      <span className="choice-label quiet">{label}</span>
      {options.map((option) => (
        <button key={option} className="choice-option" aria-pressed={option === value} onClick={() => onChange(option)}>
          {format(option)}
        </button>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ writing

function Writing({ room, connection }: { room: RoomView; connection: RoomConnection }) {
  const round = room.round!
  const secondsLeft = useSecondsLeft(round.deadline, connection.clockOffset) ?? 0
  const submitted = room.players.filter((p) => p.submitted).length

  return (
    <>
      <section className="host-main">
        <h1 className="display host-title enter">{round.scenario}</h1>
        <aside className="host-aside enter enter-late">
          <div className="row">
            <span className="countdown" style={{ fontSize: 'clamp(48px, 6vw, 112px)', lineHeight: 1 }}>
              {formatSeconds(secondsLeft)}
            </span>
          </div>
          <p className="host-text">
            {submitted} of {room.players.length} plans in
          </p>
          <ul className="names">
            {room.players.map((p) => (
              <li key={p.id} className={`name${p.submitted ? ' name-done' : ''}${p.connected ? '' : ' name-off'}`}>
                {p.name}
              </li>
            ))}
          </ul>
        </aside>
      </section>

      <footer className="stack">
        {round.deadline && <TimeBar deadline={round.deadline} total={room.settings.seconds} clockOffset={connection.clockOffset} />}
        <div className="host-foot">
          <button className="link link-quiet" onClick={() => connection.send({ t: 'skipScenario' })}>
            New scenario
          </button>
          <button className="btn" onClick={() => connection.send({ t: 'endWriting' })}>
            End writing
          </button>
        </div>
      </footer>
    </>
  )
}

// ------------------------------------------------------------------ judging

function Judging({ room, send }: { room: RoomView; send: Send }) {
  const round = room.round!
  const names = useMemo(() => new Map(room.players.map((p) => [p.id, p.name])), [room.players])
  const done = round.order.filter((id) => room.outcomes[id]?.stage === 'done').length
  const count = round.order.length
  const cols = count <= 2 ? count : count <= 4 ? 2 : count <= 9 ? 3 : count <= 16 ? 4 : count <= 25 ? 5 : count <= 30 ? 6 : 8

  return (
    <>
      <section className="judging">
        <div className="row enter" style={{ alignItems: 'end' }}>
          <h1 className="display host-title">The AI is deciding.</h1>
          <p className="host-text quiet">
            {done} of {count} decided
          </p>
        </div>
        <div className={`lanes${count > 12 ? ' lanes-dense' : ''}`} style={{ '--cols': cols } as CSSProperties}>
          {round.order.map((id) => {
            const outcome = room.outcomes[id]
            if (!outcome) return null
            const thinking = outcome.stage === 'queued' || outcome.stage === 'thinking'
            return (
              <article key={id} className="lane">
                <h2 className="lane-name">{names.get(id) ?? 'Player'}</h2>
                <div className="lane-meta">
                  <StageStatus stage={outcome.stage} />
                  {outcome.judgeDecision && <DecisionChip decision={outcome.judgeDecision} role={ROLE.judge} />}
                </div>
                <Trace text={outcome.reasoning} live={thinking} className="trace-fade" placeholder="" />
              </article>
            )
          })}
        </div>
      </section>
      <footer className="host-foot">
        <span />
        <button className="link link-quiet" onClick={() => send({ t: 'next', at: stepKey(room.phase, round) })}>
          Skip to the results
        </button>
      </footer>
    </>
  )
}

// ------------------------------------------------------------------ reveal

const MS_PER_WORD = 65

function Reveal({ room, send }: { room: RoomView; send: Send }) {
  const round = room.round!
  const id = round.order[round.revealIndex]
  const outcome = room.outcomes[id]
  const player = room.players.find((p) => p.id === id)
  const reduced = useReducedMotion()
  // The server owns the verdict reveal, so phones unmask at the same moment as the projector.
  const showVerdict = round.verdictShown
  const at = stepKey(room.phase, round)
  const last = round.revealIndex + 1 >= round.order.length

  // The verdict lands once the story has finished typing.
  const storyMs = reduced || !outcome ? 0 : outcome.story.split(/\s+/).length * MS_PER_WORD + 1400
  useEffect(() => {
    if (!id || showVerdict) return
    // If the projector is offline when the story ends, keep trying until it's back.
    let timer = setTimeout(function reveal() {
      if (!send({ t: 'showVerdict', at })) timer = setTimeout(reveal, 1000)
    }, storyMs)
    return () => clearTimeout(timer)
  }, [id, showVerdict, storyMs, at, send])

  const advance = () => send(showVerdict ? { t: 'next', at } : { t: 'showVerdict', at })
  useAdvanceKey(advance)

  if (!outcome) return null

  return (
    <>
      <section key={id} className="host-main">
        <div className="stack" style={{ gap: 'clamp(16px, 2vw, 32px)' }}>
          <div className="row enter" style={{ alignItems: 'baseline' }}>
            <h1 className="display host-title">{player?.name ?? 'Player'}</h1>
            <span className="host-meta quiet">
              {round.revealIndex + 1} of {round.order.length}
            </span>
          </div>
          <blockquote className="plan-quote enter">{outcome.plan}</blockquote>
          <p className="story">{reduced ? outcome.story : <Typed text={outcome.story} msPerWord={MS_PER_WORD} startDelay={700} />}</p>
          {showVerdict && (
            <div className="stack">
              <Verdict outcome={outcome} host />
              <VerdictReason outcome={outcome} threshold={room.settings.threshold} />
            </div>
          )}
        </div>
        <aside className="host-aside enter enter-late">
          <p className="small quiet">How the {ROLE.narrator} reasoned</p>
          <Trace text={outcome.reasoning} live={false} className="reveal-trace trace-fade" />
        </aside>
      </section>
      <footer className="host-foot">
        {last ? (
          <span />
        ) : (
          <button className="link link-quiet" onClick={() => send({ t: 'skipReveal', at })}>
            Skip to scores
          </button>
        )}
        <button className="btn" onClick={advance}>
          {!showVerdict ? 'Show verdict' : last ? 'Show scores' : 'Next player'}
        </button>
      </footer>
    </>
  )
}

// ------------------------------------------------------------------ scores

function Scores({ room, send }: { room: RoomView; send: Send }) {
  const round = room.round!
  const ranked = useMemo(() => rankPlayers(room.players, room.outcomes), [room.players, room.outcomes])
  const last = round.number >= room.settings.rounds
  const survivors = Object.values(room.outcomes).filter((o) => o.survived).length
  const next = () => send({ t: 'next', at: stepKey(room.phase, round) })
  useAdvanceKey(next)

  return (
    <>
      <section className="stack">
        <div className="row enter" style={{ alignItems: 'end' }}>
          <h1 className="display host-title">{last ? 'Final round done.' : `After round ${round.number}`}</h1>
          <p className="host-text quiet">
            {survivors} of {Object.keys(room.outcomes).length} survived
          </p>
        </div>
        <Standings ranked={ranked} limit={10} className="standings-capped" />
      </section>
      <footer className="host-foot">
        <span />
        <button className="btn" onClick={next}>
          {last ? 'Show the winner' : 'Next round'}
        </button>
      </footer>
    </>
  )
}

function Final({ room, send }: { room: RoomView; send: Send }) {
  const ranked = useMemo(() => rankPlayers(room.players), [room.players])
  const [first, second, third] = ranked
  const rest = ranked.slice(3, 6)
  const winners = ranked.filter((p) => p.rank === 1)

  return (
    <>
      <section className="stack" style={{ gap: 'clamp(24px, 3vw, 48px)' }}>
        <h1 className="display host-title enter">
          {winners.length > 1 ? `${winners.map((w) => w.name).join(' and ')} tie for first.` : `${first?.name ?? 'Nobody'} wins.`}
        </h1>
        <div className="podium">
          {[second, first, third].map((player, i) =>
            player ? (
              <div
                key={player.id}
                className={`podium-place${player === first ? ' podium-first' : ''}`}
                style={{ animationDelay: `${[500, 1100, 200][i]}ms` }}
              >
                <div>
                  <p className="display title-m">{player.name}</p>
                  <p className="numeric quiet host-meta">{player.score} points</p>
                </div>
                <div className="podium-block" style={{ height: `${[13, 20, 8][i]}vh` }}>
                  {player.rank}
                </div>
              </div>
            ) : (
              <div key={i} />
            ),
          )}
        </div>
        {rest.length > 0 && (
          <div className="final-rest">
            <Standings ranked={rest} animate={false} />
          </div>
        )}
      </section>
      <footer className="host-foot">
        <span />
        <div className="host-foot-end">
          <button className="link link-quiet" onClick={() => send({ t: 'close' })}>
            End game
          </button>
          <button className="btn" onClick={() => send({ t: 'playAgain' })}>
            Play again
          </button>
        </div>
      </footer>
    </>
  )
}

function HostEnded() {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const create = async () => {
    const session = hostSession()
    if (!session) return navigate('/host')
    setBusy(true)
    try {
      navigate(`/host/${await createRoom(session)}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create a game. Try again.')
      setBusy(false)
    }
  }
  return (
    <main className="host">
      <HostBar code="" room={null} />
      <section className="stack enter" style={{ alignContent: 'center' }}>
        <h1 className="display host-title">This game has ended.</h1>
        <p className="host-text quiet">Players have been sent back to the join screen.</p>
        <p className="form-error" role="alert">
          {error}
        </p>
      </section>
      <footer className="host-foot">
        <span />
        <button className="btn" onClick={create} disabled={busy}>
          {busy ? 'Creating game' : 'Create a new game'}
        </button>
      </footer>
    </main>
  )
}
