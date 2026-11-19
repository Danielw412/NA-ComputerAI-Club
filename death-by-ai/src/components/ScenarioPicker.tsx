import { type FormEvent, useEffect, useRef, useState } from 'react'
import { cleanText, type HostSession, LIMITS, type ScenarioGroup } from '../../shared/protocol.ts'
import { ApiError, fetchScenarios } from '../lib/api.ts'

let cached: ScenarioGroup[] | null = null

/**
 * Full-screen sheet for choosing which scenarios the game plays. Picks are
 * numbered in the order they'll be played; rounds without a pick are random.
 * Every change is sent straight away, so closing never loses work.
 */
export function ScenarioPicker({
  session,
  picked,
  rounds,
  online,
  onChange,
  onClose,
}: {
  session: HostSession
  picked: string[]
  rounds: number
  online: boolean
  onChange: (scenarios: string[]) => void
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [groups, setGroups] = useState<ScenarioGroup[] | null>(cached)
  const [error, setError] = useState('')
  const [picks, setPicks] = useState(picked)
  const [draft, setDraft] = useState('')
  const ownRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
  }, [])

  const load = () => {
    setError('')
    fetchScenarios(session)
      .then((list) => {
        cached = list
        setGroups(list)
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Could not load the scenarios.'))
  }
  useEffect(() => {
    if (!cached) load()
    // Load once per page; the list only changes on redeploy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const update = (next: string[]) => {
    setPicks(next)
    onChange(next)
  }
  const full = picks.length >= rounds
  const known = new Set(groups?.flatMap((g) => g.scenarios) ?? [])
  const toggle = (scenario: string) => {
    if (picks.includes(scenario)) {
      update(picks.filter((s) => s !== scenario))
      // An unpicked custom scenario disappears with its button, so focus goes back to where it was written.
      if (!known.has(scenario)) ownRef.current?.focus()
    } else if (!full) update([...picks, scenario])
  }

  const own = picks.filter((s) => !known.has(s))
  const shown: ScenarioGroup[] = [...(own.length > 0 ? [{ name: 'Your own', scenarios: own }] : []), ...(groups ?? [])]

  const addOwn = (event: FormEvent) => {
    event.preventDefault()
    const scenario = cleanText(draft, LIMITS.scenarioLength)
    if (!scenario || full) return
    if (!picks.includes(scenario)) update([...picks, scenario])
    setDraft('')
  }

  const random = Math.max(0, rounds - picks.length)
  const status = !online
    ? 'Reconnecting. Your picks save when the connection is back.'
    : picks.length === 0
      ? `Nothing picked. All ${rounds} rounds are random.`
      : picks.length > rounds
        ? `${picks.length} picked. Only the first ${rounds} play.`
        : random === 0
          ? `All ${rounds} rounds picked. Unpick one to choose another.`
          : `${picks.length} of ${rounds} rounds picked. ${random} ${random === 1 ? 'is' : 'are'} random.`

  return (
    <dialog
      ref={dialogRef}
      className="sheet"
      aria-labelledby="picker-title"
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <header className="sheet-head">
        <div className="stack" style={{ gap: 6 }}>
          <h2 id="picker-title" className="display title-l">
            Choose scenarios
          </h2>
          <p className="quiet">Picks play first, in the order you choose them. Any other rounds are random.</p>
        </div>
        <form className="sheet-own" onSubmit={addOwn}>
          <label className="visually-hidden" htmlFor="own-scenario">
            Write your own scenario
          </label>
          <input
            ref={ownRef}
            id="own-scenario"
            className="input"
            placeholder="Write your own"
            value={draft}
            maxLength={LIMITS.scenarioLength * 2}
            disabled={full}
            onChange={(e) => setDraft(Array.from(e.target.value).slice(0, LIMITS.scenarioLength).join(''))}
          />
          <button className="btn" type="submit" disabled={full || !draft.trim()}>
            Add
          </button>
        </form>
      </header>

      <div className="sheet-body">
        {error ? (
          <div className="stack" style={{ justifyItems: 'start' }}>
            <p className="form-error">{error}</p>
            <button className="link" onClick={load}>
              Try again
            </button>
          </div>
        ) : !groups ? (
          <p className="notice">Loading scenarios</p>
        ) : (
          shown.map((group) => (
            <section key={group.name} className="scenario-group">
              <h3 className="display scenario-group-name">{group.name}</h3>
              <ul className="scenario-list">
                {group.scenarios.map((scenario) => {
                  const index = picks.indexOf(scenario)
                  const on = index !== -1
                  return (
                    <li key={scenario}>
                      <button
                        className={`scenario${on && index >= rounds ? ' scenario-spare' : ''}`}
                        aria-pressed={on}
                        disabled={!on && full}
                        onClick={() => toggle(scenario)}
                      >
                        <span className="scenario-mark numeric" aria-hidden="true">
                          {on ? index + 1 : ''}
                        </span>
                        <span>
                          {on && (
                            <span className="visually-hidden">
                              {index < rounds ? `Round ${index + 1}: ` : 'Picked, but the game ends before it plays: '}
                            </span>
                          )}
                          {scenario}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))
        )}
      </div>

      <footer className="sheet-foot">
        <p role="status">{status}</p>
        <div className="host-foot-end">
          {picks.length > 0 && (
            <button className="link link-quiet" onClick={() => update([])}>
              Clear picks
            </button>
          )}
          <button className="btn" onClick={() => dialogRef.current?.close()}>
            Done
          </button>
        </div>
      </footer>
    </dialog>
  )
}
