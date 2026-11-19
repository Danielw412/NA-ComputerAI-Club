import { useMemo } from 'react'
import { encode } from 'uqr'
import type { DecisionView, Fate, OutcomeView, Stage } from '../../shared/protocol.ts'
import { useNow, useStickToBottom } from '../lib/hooks.ts'

/** The NA Computer & AI Club mark, drawn on its own 6×6 grid. */
export function Logo({ size = 40, title = 'NA Computer & AI Club' }: { size?: number; title?: string }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 1200 1200" role="img" aria-label={title}>
      <path
        fill="#faaa13"
        fillRule="evenodd"
        d="M0 0H200L400 200V0H600V200L800 0H1200V600H1000V400H800V600H400L200 400V600H0ZM800 250H1000V150H900Z"
      />
      <path d="M200 600H600V800H300L200 900L300 1000H600V1200H200L0 1000V800ZM800 600H1200V800H800V1000H1200V1200H800L600 1000V800Z" />
    </svg>
  )
}

export function QrCode({ value, label }: { value: string; label: string }) {
  const path = useMemo(() => {
    const { data, size } = encode(value, { ecc: 'M', border: 0 })
    let d = ''
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) if (data[y][x]) d += `M${x} ${y}h1v1h-1z`
    }
    return { d, size }
  }, [value])
  return (
    <svg className="qr" viewBox={`-2 -2 ${path.size + 4} ${path.size + 4}`} role="img" aria-label={label}>
      <rect x="-2" y="-2" width={path.size + 4} height={path.size + 4} fill="#fff" />
      <path d={path.d} fill="#000" shapeRendering="crispEdges" />
    </svg>
  )
}

/** Seconds left until `deadline` (server clock), or null when there is none. */
export function useSecondsLeft(deadline: number | null, clockOffset: number): number | null {
  const now = useNow(deadline !== null, 200)
  if (deadline === null) return null
  return Math.max(0, Math.ceil((deadline - (now + clockOffset)) / 1000))
}

export function formatSeconds(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function TimeBar({ deadline, total, clockOffset }: { deadline: number; total: number; clockOffset: number }) {
  const now = useNow(true, 100)
  const left = Math.max(0, deadline - (now + clockOffset))
  const fraction = Math.min(1, left / (total * 1000))
  return (
    <div className={`timebar${left < 10_000 ? ' timebar-low' : ''}`} aria-hidden="true">
      <div className="timebar-fill" style={{ transform: `scaleX(${fraction})`, transition: 'transform 100ms linear' }} />
    </div>
  )
}

const STAGE_TEXT: Record<Stage, string> = {
  queued: 'Waiting',
  thinking: 'Thinking',
  writing: 'Writing the story',
  deciding: 'Deciding',
  done: 'Decided',
}

export function StageStatus({ stage }: { stage: Stage }) {
  const tone = stage === 'done' ? ' status-done' : stage === 'queued' ? '' : ' status-live'
  return (
    <span className={`status${tone}`}>
      <span className="status-dot" aria-hidden="true" />
      <span className="status-text">{STAGE_TEXT[stage]}</span>
    </span>
  )
}

/** A streaming reasoning trace with a block cursor while the model is still thinking. */
export function Trace({
  text,
  live,
  className = '',
  placeholder = 'Reading the plan',
}: {
  text: string
  live: boolean
  className?: string
  placeholder?: string
}) {
  const ref = useStickToBottom<HTMLDivElement>(text)
  return (
    <div ref={ref} className={`trace-scroll ${className}`}>
      <p className="trace" aria-live="off">
        {text || (live ? placeholder : '')}
        {live && <span className="cursor" aria-hidden="true" />}
      </p>
    </div>
  )
}

export function Verdict({ outcome, host = false }: { outcome: OutcomeView; host?: boolean }) {
  const survived = outcome.survived === true
  return (
    <div
      className={`verdict ${survived ? 'verdict-survived' : 'verdict-died'}${host ? ' verdict-host' : ''}`}
      role="status"
    >
      <span className="verdict-word">{survived ? 'Survived' : 'Died'}</span>
      {survived && <span className="verdict-points">+{outcome.points ?? 0}</span>}
    </div>
  )
}

export function percent(chance: unknown): number | null {
  return typeof chance === 'number' && Number.isFinite(chance) ? Math.round(Math.min(1, Math.max(0, chance)) * 100) : null
}

/** What the screens call the two models, whichever vendors are configured. */
export const ROLE = { narrator: 'LLM', judge: 'Decision Model' } as const

/** One model's survival call, e.g. "Decision Model 18%". */
export function DecisionChip({ decision, role }: { decision: DecisionView; role: string }) {
  const value = percent(decision.chance)
  if (value === null) return null
  return (
    <span className="decision-chip">
      {role} {value}%<span className="visually-hidden"> chance of surviving</span>
    </span>
  )
}

/** A combined chance as shown beside the verdict: never rounded across the line it was judged by. */
function overallPercent(chance: number, survived: boolean | null, line: number): string {
  const value = Math.min(1, Math.max(0, chance)) * 100
  const rounded = Math.round(value)
  if (survived === false && rounded >= line) return `${Math.floor(value * 10) / 10}%`
  if (survived === true && rounded < line) return `${line}%`
  return `${rounded}%`
}

/** The verdict's one-line reason, and how each model called it. `threshold` is the survive line, in percent. */
export function VerdictReason({ outcome, threshold = 50 }: { outcome: OutcomeView; threshold?: number }) {
  // The breakdown appears only for a real combined verdict, not one the host forced by skipping.
  const combined = typeof outcome.chance === 'number' && Number.isFinite(outcome.chance)
  const calls = combined
    ? (
        [
          [ROLE.narrator, outcome.narratorDecision],
          [ROLE.judge, outcome.judgeDecision],
        ] as const
      )
        .filter(([, d]) => d && percent(d.chance) !== null)
        .map(([role, d]) => `${role} ${percent(d!.chance)}%${d!.fallback ? ' (stand-in)' : ''}`)
    : []
  if (!outcome.verdictReason && calls.length === 0) return null
  return (
    <div className="reason enter">
      {outcome.verdictReason && <p>{outcome.verdictReason}</p>}
      {calls.length > 0 && (
        <p className="reason-meta">
          {calls.join(' · ')} · {overallPercent(outcome.chance as number, outcome.survived, threshold)} overall
          {threshold !== 50 && `, ${threshold}% to survive`}
        </p>
      )}
    </div>
  )
}

export function Tally({ history, label }: { history: Fate[]; label?: string }) {
  if (history.length === 0) return null
  const survived = history.filter((h) => h === 'survived').length
  return (
    <span className="tally" role="img" aria-label={label ?? `Survived ${survived} of ${history.length} rounds`}>
      {history.map((fate, i) => (
        <span key={i} className={`tally-cell${fate === 'none' ? '' : ` tally-${fate}`}`} />
      ))}
    </span>
  )
}

export function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'
  return `${n}${suffix}`
}

/** Splits a story into words that fade in one after another. */
export function Typed({ text, msPerWord = 70, startDelay = 0 }: { text: string; msPerWord?: number; startDelay?: number }) {
  const words = text.split(/(\s+)/)
  let index = 0
  return (
    <>
      {words.map((word, i) => {
        if (/^\s+$/.test(word)) return word
        const delay = startDelay + index++ * msPerWord
        return (
          <span key={i} className="word" style={{ animationDelay: `${delay}ms` }}>
            {word}
          </span>
        )
      })}
    </>
  )
}
