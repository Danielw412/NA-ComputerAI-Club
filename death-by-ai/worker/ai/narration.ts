/**
 * Streaming parser for the narrator's visible output (everything after its
 * reasoning):
 *
 *   <decision>chance: 72, cleverness: 4</decision>
 *   <survived>The ending where the player survives.</survived>
 *   <died>The ending where the player dies.</died>
 *
 * Text arrives in arbitrary chunks, so the parser keeps the whole text and
 * re-reads it. The decision is reported once, as soon as its block is closed
 * (by `</decision>` or by the next ending tag); the endings are read when the
 * stream is over. Anything outside the tags is ignored.
 */
import { ProviderError } from './http.ts'
import { toChance, toCleverness } from './verdict.ts'

export interface NarratorDecision {
  /** 0 to 1. */
  chance: number
  /** Integer 1–5. */
  cleverness: number
}

export interface NarratorOutputResult {
  decision: NarratorDecision
  stories: { survived: string; died: string }
}

const DECISION_OPEN = /<\s*decision\b([^>]*)>/i
/** Where an unclosed decision block ends. */
const DECISION_END = /<\s*\/\s*decision\s*>|<\s*\/?\s*(?:survived|died)\s*>/i
const OUR_TAG = /<\s*\/?\s*(?:decision|survived|died)\b[^>]*>?/gi
const PAIR = /([A-Za-z][A-Za-z _-]*?)\s*[:=]\s*["']?(-?\d+(?:\.\d+)?)\s*(%)?/g

export class NarratorOutput {
  #text = ''
  #decision: NarratorDecision | null = null

  /**
   * Adds visible text. Returns the decision the first time it can be read,
   * otherwise null. Throws a ProviderError as soon as a closed decision block
   * turns out to be unusable, so a broken attempt can be retried early.
   */
  push(delta: string): NarratorDecision | null {
    this.#text += delta
    if (this.#decision) return null
    const block = decisionBlock(this.#text, false)
    if (block === null) return null
    return (this.#decision = requireDecision(block))
  }

  /** Call when the stream is complete. Throws a ProviderError if the decision or either ending is missing. */
  finish(): NarratorOutputResult {
    if (!this.#decision) {
      const block = decisionBlock(this.#text, true)
      if (block === null) throw new ProviderError('The narrator gave no decision')
      this.#decision = requireDecision(block)
    }
    const survived = ending(this.#text, 'survived')
    const died = ending(this.#text, 'died')
    if (!survived || !died) throw new ProviderError(`The narrator did not write the ${survived ? 'death' : 'survival'} ending`)
    return { decision: this.#decision, stories: { survived, died } }
  }
}

/** The decision block's attributes and contents, or null if it has not been closed yet (unless `final`). */
function decisionBlock(text: string, final: boolean): string | null {
  const open = DECISION_OPEN.exec(text)
  if (!open) return null
  const attributes = open[1]
  if (attributes.trimEnd().endsWith('/')) return attributes
  const rest = text.slice(open.index + open[0].length)
  const end = DECISION_END.exec(rest)
  if (end) return `${attributes} ${rest.slice(0, end.index)}`
  return final ? `${attributes} ${rest}` : null
}

/** Reads `chance: N` and `cleverness: C` pairs (also `chance="N"`); both must be present and in range. */
export function parseDecision(block: string): NarratorDecision | null {
  let chance: number | null = null
  let cleverness: number | null = null
  for (const [, rawKey, value, percent] of block.matchAll(PAIR)) {
    const key = rawKey.toLowerCase()
    if (chance === null && /chance|surviv|prob/.test(key)) chance = toChance(percent ? `${value}%` : value)
    else if (cleverness === null && /clever/.test(key)) cleverness = toCleverness(value, false)
  }
  return chance === null || cleverness === null ? null : { chance, cleverness }
}

function requireDecision(block: string): NarratorDecision {
  const decision = parseDecision(block)
  if (!decision) throw new ProviderError('The narrator gave an invalid decision')
  return decision
}

/**
 * An ending's text, between its exact opening and closing tags. A missing
 * closing tag is forgiven only when nothing else of ours follows (the stream
 * simply ended); an ending cut short by another tag is rejected.
 */
function ending(text: string, name: 'survived' | 'died'): string {
  const open = new RegExp(`<\\s*${name}\\s*>`, 'i').exec(text)
  if (!open) return ''
  const rest = text.slice(open.index + open[0].length)
  const close = new RegExp(`<\\s*\\/\\s*${name}\\s*>`, 'i').exec(rest)
  const other = /<\s*\/?\s*(?:decision|survived|died)\b/i.exec(rest)
  if (close && (!other || other.index >= close.index)) return tidy(rest.slice(0, close.index))
  return other ? '' : tidy(rest)
}

function tidy(text: string): string {
  return text.replace(OUR_TAG, '').replace(/\s+/g, ' ').trim()
}
