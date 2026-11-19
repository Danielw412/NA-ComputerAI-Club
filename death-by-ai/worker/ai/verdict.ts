/** Parsing the LLM judges' JSON, shared number parsing, and the plan-only heuristic judge. */
import { assessPlan, baseChance, clampInt, isDoomed } from './assess.ts'

export interface Judgement {
  /** 0 to 1. */
  chance: number
  /** Integer 1–5. */
  cleverness: number
  reasons: { survived: string; died: string }
}

/** Used when a judge gives no usable reason for an outcome. */
export const GENERIC_REASONS = {
  survived: 'The plan gave them a real chance, and it held up.',
  died: 'The plan was not enough to beat the danger.',
} as const

const MAX_REASON_WORDS = 14

/**
 * Extracts a judgement from model output: tolerates code fences, prose around
 * the JSON, single quotes, trailing commas, unquoted keys and loose values
 * such as `"chance": "72%"`. Returns null when no usable chance is found.
 */
export function parseJudgement(raw: string): Judgement | null {
  const text = raw.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').replace(/```(?:json)?/gi, '')
  for (const candidate of objectCandidates(text)) {
    const value = parseLoose(candidate)
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const f = lowerKeys(value as Record<string, unknown>)
    const chance = toChance(f.chance ?? f.survival_chance ?? f.chance_percent ?? f.probability ?? f.survival)
    if (chance === null) continue
    const clever = toCleverness(f.cleverness ?? f.clever ?? f.score, true)
    return {
      chance,
      cleverness: clever ?? 3,
      reasons: {
        survived: tidyReason(firstString(f.if_survived, f.why_survived, f.survived_reason, f.reason_survived)) || GENERIC_REASONS.survived,
        died: tidyReason(firstString(f.if_died, f.why_died, f.died_reason, f.reason_died)) || GENERIC_REASONS.died,
      },
    }
  }
  return null
}

/**
 * A survival chance as 0 to 1, or null. Values are whole-number percents
 * ("72", 72, "72%"); a plain number strictly between 0 and 1 is read as a
 * fraction. Anything outside 0–100% is not an answer.
 */
export function toChance(value: unknown): number | null {
  let n: number
  let percent = false
  if (typeof value === 'number') n = value
  else if (typeof value === 'string') {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*(%)?/.exec(value)
    if (!m) return null
    n = Number.parseFloat(m[1])
    percent = Boolean(m[2])
  } else return null
  if (!Number.isFinite(n)) return null
  const chance = !percent && n > 0 && n < 1 ? n : n / 100
  return chance >= 0 && chance <= 1 ? chance : null
}

/**
 * Cleverness as an integer 1–5, or null when there is no number. Strict mode
 * rejects numbers outside 1–5; lenient mode clamps them.
 */
export function toCleverness(value: unknown, lenient: boolean): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseFloat(value) : Number.NaN
  if (!Number.isFinite(n)) return null
  if (!lenient && (n < 1 || n > 5)) return null
  return clampInt(n, 1, 5)
}

/** Balanced `{…}` spans, outermost first, skipping braces inside strings. */
function objectCandidates(text: string): string[] {
  const out: string[] = []
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0
    let quote = ''
    for (let i = start; i < text.length; i++) {
      const c = text[i]
      if (quote) {
        if (c === '\\') i++
        else if (c === quote) quote = ''
      } else if (c === '"' || c === "'") quote = c
      else if (c === '{') depth++
      else if (c === '}' && --depth === 0) {
        out.push(text.slice(start, i + 1))
        break
      }
    }
  }
  return out
}

function parseLoose(candidate: string): unknown {
  try {
    return JSON.parse(candidate)
  } catch {
    // Fall through to repairs.
  }
  const repaired = candidate
    // Single-quoted strings to double-quoted (apostrophes inside double quotes are left alone).
    .replace(/"(?:[^"\\]|\\.)*"|'((?:[^'\\]|\\.)*)'/g, (match, inner: string | undefined) =>
      inner === undefined ? match : JSON.stringify(inner.replace(/\\'/g, "'")),
    )
    .replace(/([{,]\s*)([A-Za-z_][\w]*)\s*:/g, '$1"$2":')
    .replace(/,\s*([}\]])/g, '$1')
    // Bare percents such as `"chance": 72%`.
    .replace(/:\s*(-?\d+(?:\.\d+)?)\s*%/g, ': "$1%"')
  try {
    return JSON.parse(repaired)
  } catch {
    return null
  }
}

function lowerKeys(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k.toLowerCase().trim(), v]))
}

function firstString(...values: unknown[]): string {
  for (const v of values) if (typeof v === 'string' && v.trim()) return v
  return ''
}

export function tidyReason(reason: string): string {
  const flat = reason.replace(/\s+/g, ' ').trim()
  const words = flat.split(' ').filter(Boolean)
  if (words.length <= MAX_REASON_WORDS) return flat
  return `${words.slice(0, MAX_REASON_WORDS).join(' ').replace(/[,;:.!?-]+$/, '')}…`
}

/** The stand-in judge when the configured one fails: an opinion from the plan alone, with no luck. */
export function heuristicJudgement(plan: string): Judgement {
  const a = assessPlan(plan)
  const doomed = isDoomed(a)
  return {
    chance: Math.round(baseChance(a) * 100) / 100,
    cleverness: a.cleverness,
    reasons: {
      survived: doomed ? 'Pure luck; the plan itself did very little.' : 'The plan had real, workable steps.',
      died: a.offensive
        ? 'Rude plans earn comedic consequences, not survival.'
        : a.injection
          ? 'Ordering the narrator around is not a survival strategy.'
          : doomed
            ? 'Too vague to survive; there was no real plan.'
            : GENERIC_REASONS.died,
    },
  }
}
