import { type FormEvent, useState } from 'react'
import { LIMITS } from '../../shared/protocol.ts'
import { Logo } from '../components/ui.tsx'
import { ApiError, joinRoom, savedSeat } from '../lib/api.ts'
import { navigate } from '../lib/route.ts'

export function Join({ initialCode }: { initialCode: string }) {
  const [code, setCode] = useState(initialCode)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const seat = code.length === 6 ? savedSeat(code) : null

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    if (!/^\d{6}$/.test(code)) return setError('Enter the 6-digit code from the big screen.')
    if (!name.trim()) return setError('Enter a name so people know it’s you.')
    setBusy(true)
    setError('')
    try {
      await joinRoom(code, name.trim())
      navigate(`/play/${code}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not join. Try again.')
      setBusy(false)
    }
  }

  return (
    <main className="phone">
      <div className="bar">
        <Logo size={40} />
        <a
          className="link link-quiet small"
          href="/host"
          onClick={(e) => {
            e.preventDefault()
            navigate('/host')
          }}
        >
          Host a game
        </a>
      </div>

      <form className="phone-body" onSubmit={submit} noValidate>
        <div className="stack enter">
          <h1 className="display title-xl">Exit Code</h1>
          <p className="lede quiet">Survive the scenario. The AI decides if you make it.</p>
        </div>

        <div className="stack enter enter-late" style={{ marginTop: 'auto' }}>
          <label className="field">
            <span className="field-label">Game code</span>
            <input
              className="input input-code"
              inputMode="numeric"
              autoComplete="off"
              placeholder="000000"
              maxLength={6}
              value={code}
              autoFocus={!initialCode}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            />
          </label>
          <label className="field">
            <span className="field-label">Your name</span>
            <input
              className="input"
              autoComplete="nickname"
              autoCapitalize="words"
              enterKeyHint="go"
              maxLength={LIMITS.nameLength}
              value={name}
              autoFocus={Boolean(initialCode)}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <p className="form-error" role="alert">
            {error}
          </p>
        </div>

        <div className="phone-foot">
          <button className="btn btn-block" type="submit" disabled={busy}>
            {busy ? 'Joining' : 'Join game'}
          </button>
          {seat && (
            <button className="link" type="button" onClick={() => navigate(`/play/${code}`)}>
              Rejoin as {seat.name}
            </button>
          )}
        </div>
      </form>
    </main>
  )
}
