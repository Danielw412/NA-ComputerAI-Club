import { type FormEvent, useState } from 'react'
import { formatCode } from '../../shared/protocol.ts'
import { Logo } from '../components/ui.tsx'
import { ApiError, createRoom, forgetHost, hostSession, lastHostedRoom, signIn } from '../lib/api.ts'
import { navigate } from '../lib/route.ts'

export function HostHome() {
  const [session, setSession] = useState(hostSession)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const previous = session ? lastHostedRoom() : null

  const run = async (task: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await task()
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && session) {
        forgetHost()
        setSession(null)
      }
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const onSignIn = (event: FormEvent) => {
    event.preventDefault()
    if (!password) return setError('Enter the host password.')
    void run(async () => {
      setSession(await signIn(password))
      setPassword('')
    })
  }

  const onCreate = () =>
    void run(async () => {
      const code = await createRoom(session!)
      navigate(`/host/${code}`)
    })

  return (
    <main className="phone">
      <div className="bar">
        <Logo size={40} />
        {session && (
          <button
            className="link link-quiet small"
            onClick={() => {
              forgetHost()
              setSession(null)
            }}
          >
            Sign out
          </button>
        )}
      </div>

      {session ? (
        <div className="phone-body">
          <div className="stack enter">
            <h1 className="display title-xl">Host a game</h1>
            <p className="lede quiet">Put this screen on the projector. Players join from their phones with the code.</p>
          </div>
          <div className="phone-foot" style={{ marginTop: 'auto' }}>
            <p className="form-error" role="alert">
              {error}
            </p>
            <button className="btn btn-block" onClick={onCreate} disabled={busy}>
              {busy ? 'Creating game' : 'Create game'}
            </button>
            {previous && (
              <button className="link" onClick={() => navigate(`/host/${previous}`)}>
                Return to game {formatCode(previous)}
              </button>
            )}
          </div>
        </div>
      ) : (
        <form className="phone-body" onSubmit={onSignIn} noValidate>
          <div className="stack enter">
            <h1 className="display title-xl">Host a game</h1>
            <p className="lede quiet">Enter the host password. You’ll stay signed in on this device.</p>
          </div>
          <div className="stack enter enter-late" style={{ marginTop: 'auto' }}>
            <label className="field">
              <span className="field-label">Host password</span>
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                value={password}
                autoFocus
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <p className="form-error" role="alert">
              {error}
            </p>
          </div>
          <div className="phone-foot">
            <button className="btn btn-block" type="submit" disabled={busy}>
              {busy ? 'Signing in' : 'Sign in'}
            </button>
            <button type="button" className="link link-quiet" onClick={() => navigate('/')}>
              Join a game instead
            </button>
          </div>
        </form>
      )}
    </main>
  )
}
