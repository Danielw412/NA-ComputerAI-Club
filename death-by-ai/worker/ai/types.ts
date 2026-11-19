/**
 * Contract between the game room and the AI layer.
 *
 * Every player's plan goes to two models at the same time, and each decides
 * on its own from the scenario and the plan:
 *  1. The narrator LLM reasons about the plan (the reasoning is streamed to
 *     screens as a live trace), gives a survival chance and a cleverness
 *     rating, then writes two endings: one where the player survives and one
 *     where they die.
 *  2. The judge returns its own survival chance, cleverness rating and a
 *     short reason for each outcome.
 * `combine` weighs the two opinions (narrator 0.75, judge 0.25 by default)
 * into the final verdict, and the room shows the matching ending.
 *
 * Each step has its own provider settings, so they can be different vendors.
 * The default pairing is Claude (the `anthropic` provider, Claude Haiku 5.5)
 * as narrator, with the host picking effort 'high' or 'xhigh' per game, and
 * Cloudflare's Clef (the `clef` provider, on the Workers AI binding) as the
 * decision model. OpenAI, the OpenAI Responses API and Gemini also work for
 * either step; `mock` (the default when nothing is set) needs no keys.
 */
import type { WorkersAiBinding } from './providers/clef.ts'

export type { WorkersAiBinding }

/** Narrator effort the host can choose per game. */
export type Effort = 'high' | 'xhigh'

/** Provider settings read from Worker vars and secrets. All values are strings. */
export interface AiEnv {
  NARRATOR_PROVIDER?: string
  NARRATOR_MODEL?: string
  NARRATOR_BASE_URL?: string
  NARRATOR_API_KEY?: string
  /** 'low' | 'medium' | 'high' | 'xhigh' | 'tags' | 'off'. A per-game effort overrides the native levels. */
  NARRATOR_REASONING?: string
  NARRATOR_MAX_TOKENS?: string

  /** 'clef' uses the AI binding below and needs no key or base URL. */
  JUDGE_PROVIDER?: string
  JUDGE_MODEL?: string
  JUDGE_BASE_URL?: string
  JUDGE_API_KEY?: string
  JUDGE_MAX_TOKENS?: string
  /** The judge's share of the combined decision, 0 to 1 (default "0.25"); the narrator gets the rest. */
  JUDGE_WEIGHT?: string

  /** Per-call timeout in seconds. */
  AI_TIMEOUT_SECONDS?: string
  /** Mock provider pacing; '0' makes it instant (used by tests). */
  MOCK_DELAY_MS?: string

  /** Workers AI binding, used by the `clef` judge. */
  AI?: WorkersAiBinding
}

export interface NarrateOptions {
  /** Overrides the env effort when the narrator uses native reasoning; 'xhigh' becomes 'high' outside Anthropic. */
  effort?: Effort
}

export interface PlanInput {
  scenario: string
  playerName: string
  plan: string
  round: number
}

/** The narrator's live stream. Endings are not streamed: the room shows one after both decisions are in. */
export type NarrationEvent =
  | { type: 'reasoning'; delta: string }
  /** The narrator's own decision, emitted the moment it is parsed from the stream (before the endings are written). */
  | { type: 'decision'; chance: number; cleverness: number }
  /** Discard partial output: a retry or fallback is starting. */
  | { type: 'reset' }

/** One model's independent opinion of a plan. */
export interface Decision {
  /** Chance the player survives, 0 to 1. */
  chance: number
  /** Integer 1–5. */
  cleverness: number
  /** Friendly label, e.g. "Claude Haiku 5.5", "Clef", "Mock narrator". */
  model: string
  /** True when the configured provider failed and a stand-in (mock or heuristic) produced this. */
  fallback: boolean
}

export interface NarrationResult extends Decision {
  reasoning: string
  /** Both endings, written before the final verdict is known; the room shows the one that happens. */
  stories: { survived: string; died: string }
}

export interface JudgeResult extends Decision {
  /** Short, school-safe reasons (at most ~14 words), one per outcome. The room shows the one that matches the final verdict. */
  reasons: { survived: string; died: string }
}

/** How much each opinion counts. They sum to 1. */
export interface Weights {
  narrator: number
  judge: number
}

/** The combined verdict the room shows. */
export interface FinalVerdict {
  survived: boolean
  /** Combined chance, 0 to 1; survived when it is at least 0.5. */
  chance: number
  /** Integer 1–5. */
  cleverness: number
  reason: string
  story: string
}

export interface ModelLabels {
  /** Friendly names, e.g. "Claude Haiku 5.5" and "Clef"; unknown ids are shown as given. */
  narrator: string
  judge: string
  /** Effort choices the host may pick between; empty when the narrator has no native effort to set. */
  efforts: Effort[]
  /** How the two opinions are weighed. */
  weights: Weights
}
