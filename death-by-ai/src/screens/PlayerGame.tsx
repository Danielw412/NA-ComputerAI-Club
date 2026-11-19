import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { formatCode, LIMITS, type RoomView } from '../../shared/protocol.ts'
import { rankPlayers } from '../components/Standings.tsx'
import {
  DecisionChip,
  formatSeconds,
  ROLE,
  Logo,
  ordinal,
  StageStatus,
  Tally,
  TimeBar,
  Trace,
  useSecondsLeft,
  Verdict,
  VerdictReason,
} from '../components/ui.tsx'
import { forgetSeat, savedSeat, type Seat, socketTarget } from '../lib/api.ts'
import { navigate } from '../lib/route.ts'
import { type Ended, type RoomConnection, useRoom } from '../lib/useRoom.ts'

export function PlayerGame({ code }: { code: string }) {
  const [seat] = useState(() => savedSeat(code))
  const target = useMemo(
    () => (seat ? socketTarget(code, 'player', `${seat.playerId}.${seat.token}`) : null),
    [seat, code],
  )
  const connection = useRoom(target)

  useEffect(() => {
    if (!seat) navigate(`/join/${code}`, true)
  }, [seat, code])

  useEffect(() => {
    if (connection.ended) forgetSeat(code)
  }, [connection.ended, code])

  if (!seat) return null
  if (connection.ended) return <EndedScreen reason={connection.ended} code={code} />

  const { room } = connection
  return (
    <main className="phone">
      <div className="bar">
        <Logo size={36} />
        <div className="bar-end">
          {room?.round && room.phase !== 'lobby' && room.phase !== 'final' && (
            <span className="small quiet">
              Round {room.round.number} of {room.settings.rounds}
            </span>
          )}
          <span className="numeric small">{formatCode(code)}</span>
        </div>
      </div>
      {connection.status !== 'open' && room && <p className="notice">Reconnecting</p>}
      {room ? <Phase room={room} seat={seat} connection={connection} /> : <Connecting />}
    </main>
  )
}

function Connecting() {
  return (
    <div className="phone-body phone-body-center">
      <p className="notice">Connecting to the game</p>
    </div>
  )
}

function Phase({ room, seat, connection }: { room: RoomView; seat: Seat; connection: RoomConnection }) {
  // Remount per phase and round (a scenario swap is a new round id) so drafts never carry over.
  const key = `${room.phase}:${room.round?.id ?? ''}`
  switch (room.phase) {
    case 'lobby':
      return <Lobby key={key} room={room} seat={seat} />
    case 'writing':
      return <Writing key={key} room={room} connection={connection} />
    case 'judging':
      return <Judging key={key} room={room} seat={seat} />
    case 'reveal':
      return <Reveal key={key} room={room} seat={seat} />
    case 'scores':
    case 'final':
      return <Scores key={key} room={room} seat={seat} />
  }
}

function Lobby({ room, seat }: { room: RoomView; seat: Seat }) {
  const others = room.players.length - 1
  return (
    <div className="phone-body phone-body-center">
      <div className="stack enter">
        <h1 className="display title-l">You’re in.</h1>
        <div>
          <span className="name">{seat.name}</span>
        </div>
        <p className="lede">Find your name on the big screen. The game starts when the host is ready.</p>
      </div>
      <p className="quiet enter enter-late">
        {others === 0 ? 'You’re the first one here.' : `${others} other ${others === 1 ? 'player' : 'players'} joined.`}
      </p>
    </div>
  )
}

function Writing({ room, connection }: { room: RoomView; connection: RoomConnection }) {
  const round = room.round!
  const accepted = room.yourPlan
  const [plan, setPlan] = useState(accepted ?? '')
  const [editing, setEditing] = useState(false)
  // The text sent but not yet confirmed by the server.
  const [sending, setSending] = useState<string | null>(null)
  const secondsLeft = useSecondsLeft(round.deadline, connection.clockOffset) ?? 0
  const submitted = Boolean(accepted) && !editing
  const remaining = LIMITS.planLength - Array.from(plan).length
  const waitingOn = room.players.filter((p) => !p.submitted && p.connected).length
  const lockedRef = useRef<HTMLHeadingElement>(null)
  const acceptedAtSend = useRef<string | null>(null)

  // The server echoes the accepted plan in the next snapshot; only then is it locked in.
  useEffect(() => {
    if (sending === null || accepted === null) return
    const echoed = accepted === sending.trim().replace(/\s+/g, ' ')
    if (echoed || accepted !== acceptedAtSend.current) {
      setSending(null)
      setEditing(false)
    }
  }, [accepted, sending])

  // A dropped message never gets confirmed; let the player send again once reconnected.
  useEffect(() => {
    if (connection.status !== 'open') setSending(null)
  }, [connection.status])

  // The submit button disappears on lock-in, so move focus to the confirmation.
  useEffect(() => {
    if (submitted) lockedRef.current?.focus({ preventScroll: true })
  }, [submitted])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!plan.trim() || secondsLeft === 0 || sending !== null) return
    acceptedAtSend.current = accepted
    if (connection.send({ t: 'submit', plan, roundId: round.id })) setSending(plan)
  }

  return (
    <form className="phone-body" onSubmit={submit}>
      <div className="stack">
        <div className="row">
          <span className="countdown title-m" aria-label={`${secondsLeft} seconds left`}>
            {formatSeconds(secondsLeft)}
          </span>
        </div>
        {round.deadline && <TimeBar deadline={round.deadline} total={room.settings.seconds} clockOffset={connection.clockOffset} />}
      </div>

      <h1 className="display title-m enter">{round.scenario}</h1>

      <p className="visually-hidden" role="status">
        {submitted ? 'Plan locked in.' : ''}
      </p>
      {submitted ? (
        <div className="stack enter" style={{ marginTop: 'auto' }}>
          <h2 ref={lockedRef} tabIndex={-1} className="display title-l">
            Plan locked in.
          </h2>
          <blockquote className="plan-quote">{accepted}</blockquote>
          <p className="quiet">
            {waitingOn > 0
              ? `Waiting for ${waitingOn} more ${waitingOn === 1 ? 'player' : 'players'}.`
              : 'Everyone is in. The AI is about to read the plans.'}
          </p>
          {secondsLeft > 0 && (
            <button
              type="button"
              className="link"
              style={{ justifySelf: 'start' }}
              onClick={() => {
                setPlan(accepted ?? '')
                setEditing(true)
              }}
            >
              Edit plan
            </button>
          )}
        </div>
      ) : (
        <>
          <label className="field enter enter-late" style={{ marginTop: 'auto' }}>
            <span className="visually-hidden">Your survival plan</span>
            <textarea
              className="input textarea"
              placeholder="How do you survive?"
              value={plan}
              maxLength={LIMITS.planLength * 2}
              enterKeyHint="send"
              autoFocus
              onChange={(e) => setPlan(Array.from(e.target.value).slice(0, LIMITS.planLength).join(''))}
              onKeyDown={(e) => {
                // Enter while an IME is composing confirms the candidate, it doesn't submit.
                if (e.nativeEvent.isComposing || e.keyCode === 229) return
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  e.currentTarget.form?.requestSubmit()
                }
              }}
            />
            <span className="small quiet">{remaining} characters left</span>
          </label>
          <div className="phone-foot">
            <button
              className="btn btn-block"
              type="submit"
              disabled={!plan.trim() || secondsLeft === 0 || sending !== null || connection.status !== 'open'}
            >
              {secondsLeft === 0
                ? 'Time’s up'
                : sending !== null
                  ? 'Sending'
                  : connection.status !== 'open'
                    ? 'Reconnecting'
                    : accepted
                      ? 'Update plan'
                      : 'Submit plan'}
            </button>
            {editing && accepted && (
              <button type="button" className="link link-quiet" onClick={() => setEditing(false)}>
                Keep my first plan
              </button>
            )}
          </div>
        </>
      )}
    </form>
  )
}

function Judging({ room, seat }: { room: RoomView; seat: Seat }) {
  const outcome = room.outcomes[seat.playerId]
  if (!outcome || !outcome.plan) {
    return (
      <div className="phone-body phone-body-center">
        <div className="stack enter">
          <h1 className="display title-l">No plan this round.</h1>
          <p className="lede">The AI is reading everyone else’s. Watch the big screen.</p>
        </div>
      </div>
    )
  }
  const live = outcome.stage !== 'done'
  return (
    <div className="phone-body">
      <div className="stack enter">
        <h1 className="display title-l">{live ? 'The AI is reading your plan.' : 'The AI has decided.'}</h1>
        <div className="lane-meta">
          <StageStatus stage={outcome.stage} />
          {outcome.judgeDecision && <DecisionChip decision={outcome.judgeDecision} role={ROLE.judge} />}
        </div>
        <p className="visually-hidden" role="status">
          {outcome.judgeDecision
            ? `The ${ROLE.judge} gives you a survival chance of ${Math.round(outcome.judgeDecision.chance * 100)}%.`
            : ''}
        </p>
      </div>
      <Trace text={outcome.reasoning} live={outcome.stage === 'queued' || outcome.stage === 'thinking'} className="enter enter-late" />
      {!live && <p className="quiet">Watch the big screen for your fate.</p>}
    </div>
  )
}

function Reveal({ room, seat }: { room: RoomView; seat: Seat }) {
  const outcome = room.outcomes[seat.playerId]
  const round = room.round!
  const mine = outcome?.survived !== null && outcome?.survived !== undefined
  const onScreen = round.order[round.revealIndex] === seat.playerId

  if (mine && outcome) {
    return (
      <div className="phone-body">
        <Verdict outcome={outcome} />
        <p className="story">{outcome.story}</p>
        <VerdictReason outcome={outcome} threshold={room.settings.threshold} />
      </div>
    )
  }

  const position = round.order.indexOf(seat.playerId)
  const ahead = position - round.revealIndex
  return (
    <div className="phone-body phone-body-center">
      <div className="stack enter">
        <h1 className="display title-l">{onScreen ? 'You’re on the big screen.' : 'Eyes on the big screen.'}</h1>
        <p className="lede">
          {position === -1
            ? 'You sat this round out.'
            : onScreen
              ? 'The verdict lands any second.'
              : ahead === 1
                ? 'You’re up next.'
                : `${ahead} players before you.`}
        </p>
      </div>
    </div>
  )
}

function Scores({ room, seat }: { room: RoomView; seat: Seat }) {
  const ranked = rankPlayers(room.players, room.outcomes)
  const me = ranked.find((p) => p.id === seat.playerId)
  const outcome = room.outcomes[seat.playerId]
  const final = room.phase === 'final'
  if (!me) return null

  return (
    <div className="phone-body">
      <div className="stack enter">
        <h1 className="display title-xl">{final ? `You finished ${ordinal(me.rank)}.` : `You’re ${ordinal(me.rank)}.`}</h1>
        <p className="lede">
          <span className="numeric">{me.score}</span> points
          {!final && outcome && (outcome.points ?? 0) > 0 && <span className="quiet">, {outcome.points} this round</span>}
        </p>
        <Tally history={me.history} />
      </div>

      {!final && outcome && (
        <div className="stack enter enter-late">
          {outcome.plan ? <blockquote className="plan-quote">{outcome.plan}</blockquote> : null}
          <p>{outcome.story}</p>
        </div>
      )}

      {final && (
        <div className="phone-foot" style={{ marginTop: 'auto' }}>
          <p className="quiet">Thanks for playing. The host can start a new game from the big screen.</p>
        </div>
      )}
    </div>
  )
}

function EndedScreen({ reason, code }: { reason: Ended; code: string }) {
  return (
    <main className="phone">
      <div className="bar">
        <Logo size={36} />
      </div>
      <div className="phone-body phone-body-center">
        <div className="stack enter">
          <h1 className="display title-l">{reason === 'kicked' ? 'You were removed from this game.' : 'This game has ended.'}</h1>
          <p className="lede">
            {reason === 'kicked' ? 'You can join again with a different name.' : 'Ask the host for a new code to keep playing.'}
          </p>
        </div>
      </div>
      <div className="phone-foot">
        <button className="btn btn-block" onClick={() => navigate(reason === 'kicked' ? `/join/${code}` : '/')}>
          {reason === 'kicked' ? 'Join again' : 'Join another game'}
        </button>
      </div>
    </main>
  )
}
