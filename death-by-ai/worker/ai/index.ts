/**
 * The AI layer's public API: narrate a plan (streaming reasoning, a decision
 * and two endings), judge it independently, combine the two decisions into
 * the final verdict, describe the configured models, and the canned outcome
 * for empty plans.
 *
 * The room runs `narrate` and `judge` at the same time; neither sees the
 * other's output. Narrators stream through a StreamProvider (anthropic via
 * the official SDK; openai, openai-responses and gemini over fetch). Judges
 * are either one of those, asked for JSON, or `clef`, Cloudflare's decision
 * model on the Workers AI binding. Every real call is retried once; then the
 * narrator falls back to the mock and the judge to a plan-only heuristic.
 */
import { clampInt, hash } from './assess.ts'
import { callSignal, ProviderError } from './http.ts'
import { NarratorOutput } from './narration.ts'
import { judgePrompt, narratorPrompt, playerName } from './prompts.ts'
import type { Prompt } from './prompts.ts'
import { ANTHROPIC_BASE_URL, streamAnthropic } from './providers/anthropic.ts'
import { CLEF_DEFAULT_MODEL, judgeClef } from './providers/clef.ts'
import { streamGemini } from './providers/gemini.ts'
import { mockJudgement, mockNarration, streamMock } from './providers/mock.ts'
import { streamOpenAIResponses } from './providers/openai-responses.ts'
import { streamOpenAI } from './providers/openai.ts'
import { isNativeMode } from './providers/provider.ts'
import type { Chunk, ReasoningMode, StreamProvider } from './providers/provider.ts'
import { ThinkSplitter } from './think.ts'
import type {
  AiEnv,
  Effort,
  FinalVerdict,
  JudgeResult,
  ModelLabels,
  NarrateOptions,
  NarrationEvent,
  NarrationResult,
  PlanInput,
  Weights,
} from './types.ts'
import { GENERIC_REASONS, heuristicJudgement, parseJudgement } from './verdict.ts'

interface ProviderInfo {
  stream: StreamProvider
  baseUrl: string
  narratorModel: string
  judgeModel: string
}

const PROVIDERS: Record<string, ProviderInfo> = {
  openai: { stream: streamOpenAI, baseUrl: 'https://api.openai.com/v1', narratorModel: 'gpt-5-mini', judgeModel: 'gpt-5-mini' },
  'openai-responses': {
    stream: streamOpenAIResponses,
    baseUrl: 'https://api.openai.com/v1',
    narratorModel: 'gpt-5-mini',
    judgeModel: 'gpt-5-mini',
  },
  anthropic: { stream: streamAnthropic, baseUrl: ANTHROPIC_BASE_URL, narratorModel: 'claude-haiku-5-5', judgeModel: 'claude-haiku-5-5' },
  gemini: {
    stream: streamGemini,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    narratorModel: 'gemini-2.5-flash',
    judgeModel: 'gemini-2.5-flash',
  },
}

/** Friendly names for known model ids; anything else is shown as configured. */
const MODEL_NAMES: Record<string, string> = {
  'claude-haiku-5-5': 'Claude Haiku 5.5',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-fable-5-2': 'Claude Fable 5.2',
  '@cf/cloudflare/clef': 'Clef',
  '@cf/cloudflare/clef-flash': 'Clef Flash',
  '@cf/cloudflare/clef-omni': 'Clef Omni',
}

const HOST_EFFORTS: Effort[] = ['high', 'xhigh']

const DEFAULT_NARRATOR_MAX_TOKENS = 8000
const DEFAULT_JUDGE_MAX_TOKENS = 4000
const DEFAULT_TIMEOUT_SECONDS = 45
const DEFAULT_MOCK_DELAY_MS = 45
const DEFAULT_JUDGE_WEIGHT = 0.25

type Role = 'narrator' | 'judge'

/** A real provider, Clef, or the mock (with `unknown` set when the configured name was not recognised). */
type Resolved =
  | { kind: 'real'; name: string; info: ProviderInfo; model: string; baseUrl: string; apiKey: string | undefined; label: string }
  | { kind: 'clef'; model: string; label: string }
  | { kind: 'mock'; label: string; unknown: boolean }

function resolve(env: AiEnv, role: Role): Resolved {
  const n = role === 'narrator'
  const raw = (n ? env.NARRATOR_PROVIDER : env.JUDGE_PROVIDER)?.trim() ?? ''
  const name = raw.toLowerCase()
  const mockLabel = n ? 'Mock narrator' : 'Mock judge'
  if (!name || name === 'mock') return { kind: 'mock', label: mockLabel, unknown: false }
  if (name === 'clef' && !n) {
    const model = env.JUDGE_MODEL?.trim() || CLEF_DEFAULT_MODEL
    return { kind: 'clef', model, label: modelName(model) }
  }
  const info = Object.hasOwn(PROVIDERS, name) ? PROVIDERS[name] : undefined
  if (!info) return { kind: 'mock', label: `${mockLabel} (unknown provider "${raw.slice(0, 30)}")`, unknown: true }
  const model = (n ? env.NARRATOR_MODEL : env.JUDGE_MODEL)?.trim() || (n ? info.narratorModel : info.judgeModel)
  const baseUrl = ((n ? env.NARRATOR_BASE_URL : env.JUDGE_BASE_URL)?.trim() || info.baseUrl).replace(/\/+$/, '')
  const apiKey = (n ? env.NARRATOR_API_KEY : env.JUDGE_API_KEY)?.trim() || undefined
  return { kind: 'real', name, info, model, baseUrl, apiKey, label: modelName(model) }
}

function modelName(model: string): string {
  return MODEL_NAMES[model.toLowerCase()] ?? model
}

/** The host's per-game effort applies only to a Claude narrator using native thinking; the lobby shows the choice on the same condition. */
function takesHostEffort(env: AiEnv, narrator: Resolved): boolean {
  return narrator.kind === 'real' && narrator.name === 'anthropic' && isNativeMode(reasoningMode(env.NARRATOR_REASONING))
}

export function describeModels(env: AiEnv): ModelLabels {
  const narrator = resolve(env, 'narrator')
  return {
    narrator: narrator.label,
    judge: resolve(env, 'judge').label,
    efforts: takesHostEffort(env, narrator) ? [...HOST_EFFORTS] : [],
    weights: decisionWeights(env),
  }
}

/** The configured weights: the judge's share from JUDGE_WEIGHT (default 0.25, clamped to 0–1), the narrator's the rest. */
export function decisionWeights(env: AiEnv): Weights {
  const raw = Number.parseFloat(env.JUDGE_WEIGHT ?? '')
  const judgeWeight = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : DEFAULT_JUDGE_WEIGHT
  return { narrator: 1 - judgeWeight, judge: judgeWeight }
}

/** Short reasons used when only the narrator's decision counts (the judge was a stand-in). */
const NARRATOR_ONLY_REASONS = {
  survived: 'The LLM judged the plan good enough to get out alive.',
  died: 'The LLM judged the plan not good enough to survive.',
} as const

/**
 * Weighs the two decisions into the final verdict. With no judge (the host
 * turned the decision model off), or when exactly one side is a stand-in
 * (fallback), the other decides alone. The player survives when the combined
 * chance reaches `threshold` (0.5 unless the host changed it); cleverness is
 * the rounded weighted average. The story and reason are the ones written for
 * the outcome that happened.
 */
export function combine(
  narration: NarrationResult,
  judgeResult: JudgeResult | null,
  weights: Weights,
  threshold = 0.5,
): FinalVerdict {
  const line = Math.min(1, Math.max(0, finiteOr(threshold, 0.5)))
  if (!judgeResult) {
    judgeResult = { chance: 0, cleverness: 1, model: '', fallback: false, reasons: NARRATOR_ONLY_REASONS }
    weights = { narrator: 1, judge: 0 }
  }
  let wn = finiteOr(weights.narrator, 0)
  let wj = finiteOr(weights.judge, 0)
  wn = Math.max(0, wn)
  wj = Math.max(0, wj)
  if (narration.fallback !== judgeResult.fallback) {
    wn = narration.fallback ? 0 : 1
    wj = 1 - wn
  }
  const total = wn + wj
  if (total > 0) {
    wn /= total
    wj /= total
  } else {
    wn = 1
    wj = 0
  }
  const unit = (x: number) => Math.min(1, Math.max(0, finiteOr(x, 0)))
  const clever = (x: number) => clampInt(finiteOr(x, 1), 1, 5)
  const raw = wn * unit(narration.chance) + wj * unit(judgeResult.chance)
  // The tolerance only absorbs float error (0.75 × 0.5 + 0.25 × 0.5 must survive); 0.4999996 does not.
  const survived = raw >= line - 1e-12
  // Stored tidy, but never on the wrong side of the line it was judged by.
  const chance = survived ? Math.max(line, round6(raw)) : Math.min(Math.max(0, line - 1e-6), round6(raw))
  const cleverness = clampInt(wn * clever(narration.cleverness) + wj * clever(judgeResult.cleverness), 1, 5)
  const outcome = survived ? 'survived' : 'died'
  const reasons = judgeResult.fallback && !narration.fallback ? NARRATOR_ONLY_REASONS : judgeResult.reasons
  return {
    survived,
    chance,
    cleverness,
    reason: reasons[outcome]?.trim() || GENERIC_REASONS[outcome],
    story: narration.stories[outcome]?.trim() ?? '',
  }
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6
}

function finiteOr(value: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export async function narrate(
  env: AiEnv,
  input: PlanInput,
  onEvent: (e: NarrationEvent) => void,
  signal?: AbortSignal,
  options?: NarrateOptions,
): Promise<NarrationResult> {
  signal?.throwIfAborted()
  const cfg = resolve(env, 'narrator')
  let dirty = false
  const emit = (e: NarrationEvent) => {
    dirty = true
    onEvent(e)
  }
  const reset = () => {
    if (dirty) onEvent({ type: 'reset' })
    dirty = false
  }

  if (cfg.kind === 'real') {
    const reasoning = narratorReasoning(env, takesHostEffort(env, cfg) ? options?.effort : undefined)
    const prompt = narratorPrompt(input, reasoning)
    const maxTokens = positiveInt(env.NARRATOR_MAX_TOKENS, DEFAULT_NARRATOR_MAX_TOKENS)
    for (let attempt = 0; attempt < 2; attempt++) {
      reset()
      const output = new NarratorOutput()
      let announced = false
      const onText = (delta: string) => {
        const decision = output.push(delta)
        if (decision) {
          announced = true
          emit({ type: 'decision', ...decision })
        }
      }
      try {
        const out = await runCall(cfg, prompt, { maxTokens, reasoning, json: false }, callTimeoutMs(env), signal, {
          reasoning: (delta) => emit({ type: 'reasoning', delta }),
          text: onText,
        })
        const { decision, stories } = output.finish()
        if (!announced) emit({ type: 'decision', ...decision })
        return { ...decision, reasoning: out.reasoning, stories, model: cfg.label, fallback: false }
      } catch (error) {
        rethrowIfAborted(signal, error)
      }
    }
    reset()
  }

  const mock = mockNarration(input)
  let reasoning = ''
  for await (const event of streamMock(mock, mockDelay(env), signal)) {
    if (event.type === 'reasoning') reasoning += event.delta
    emit(event)
  }
  return {
    chance: mock.chance,
    cleverness: mock.cleverness,
    reasoning,
    stories: mock.stories,
    model: cfg.kind === 'mock' ? cfg.label : 'Mock narrator',
    fallback: cfg.kind !== 'mock' || cfg.unknown,
  }
}

/**
 * The judge's independent decision from the scenario and plan alone. It
 * resolves as soon as the judge answers, so the room can show it before the
 * narrator has finished.
 */
export async function judge(env: AiEnv, input: PlanInput, signal?: AbortSignal): Promise<JudgeResult> {
  signal?.throwIfAborted()
  const cfg = resolve(env, 'judge')

  if (cfg.kind === 'mock') return { ...mockJudgement(input), model: cfg.label, fallback: cfg.unknown }

  if (cfg.kind === 'clef') {
    for (let attempt = 0; attempt < 2; attempt++) {
      // A missing binding will not appear on a retry.
      if (!env.AI) break
      const { signal: call, dispose } = callSignal(signal, callTimeoutMs(env))
      try {
        const judgement = await judgeClef(env.AI, cfg.model, input, call)
        return { ...judgement, model: cfg.label, fallback: false }
      } catch (error) {
        rethrowIfAborted(signal, error)
      } finally {
        dispose()
      }
    }
    return heuristicFallback(input)
  }

  const prompt = judgePrompt(input)
  const maxTokens = positiveInt(env.JUDGE_MAX_TOKENS, DEFAULT_JUDGE_MAX_TOKENS)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = await runCall(cfg, prompt, { maxTokens, reasoning: 'off', json: true }, callTimeoutMs(env), signal)
      const parsed = parseJudgement(out.text)
      if (!parsed) throw new ProviderError('Unparseable judgement')
      return { ...parsed, model: cfg.label, fallback: false }
    } catch (error) {
      rethrowIfAborted(signal, error)
    }
  }
  return heuristicFallback(input)
}

function heuristicFallback(input: PlanInput): JudgeResult {
  return { ...heuristicJudgement(input.plan), model: 'Heuristic judge', fallback: true }
}

const NO_PLAN_STORIES = [
  '{name} stares at the empty text box as the clock hits zero. The danger, confused by the lack of effort, takes its time. {name} dies.',
  '{name} submits absolutely nothing, which is bold but not a strategy. The universe fills in the blank itself. {name} does not survive.',
  '{name} is still deciding what to type when fate makes the decision instead. {name} perishes, plan-free.',
  'Paralysed by choice, {name} chooses nothing at all. Silence turns out to be a terrible survival tool. {name} is doomed.',
  '{name} goes completely blank, which the danger takes as an invitation. And that is how {name} dies.',
  '{name} leaves the plan empty, hoping nobody will notice. Fate notices. {name} meets a swift, cartoonish demise.',
]
const NO_PLAN_REASONING = [
  'No plan was submitted.\nThere is nothing to evaluate. No method, no tools, no steps.\nWithout a plan, there is only fate.\nDecision: {name} does not make it.',
  'The plan box is empty.\nI looked for a strategy and found only whitespace.\nWhitespace is not a survival tool.\nVerdict: game over for {name}.',
  'Nothing here. {name} ran out of time, or ideas, or both.\nEven a terrible plan beats no plan.\nFinal call: not today, {name}.',
]

/** The deterministic outcome for a player who submitted nothing: a death, cleverness 1. Never calls a model. */
export function noPlanOutcome(input: PlanInput): { reasoning: string; story: string; reason: string } {
  const name = playerName(input.playerName)
  const h = hash(`${input.scenario}\u0000${name}\u0000${input.round}`)
  const fill = (t: string) => t.replaceAll('{name}', name)
  return {
    reasoning: fill(NO_PLAN_REASONING[h % NO_PLAN_REASONING.length]),
    story: fill(NO_PLAN_STORIES[(h >>> 8) % NO_PLAN_STORIES.length]),
    reason: 'No plan was submitted, so fate filled in the blank.',
  }
}

interface CallOptions {
  maxTokens: number
  reasoning: ReasoningMode
  json: boolean
}

interface CallSink {
  reasoning: (delta: string) => void
  /** Visible text, after any `<think>` blocks have been routed to reasoning. */
  text: (delta: string) => void
}

/**
 * One provider call under a timeout. Reasoning and text deltas go to `sink`
 * as they arrive; `<think>` blocks inside the text are routed to reasoning.
 */
async function runCall(
  cfg: Extract<Resolved, { kind: 'real' }>,
  prompt: Prompt,
  options: CallOptions,
  timeout: number,
  caller: AbortSignal | undefined,
  sink?: CallSink,
): Promise<{ reasoning: string; text: string }> {
  const { signal, dispose } = callSignal(caller, timeout)
  const splitter = new ThinkSplitter()
  let reasoning = ''
  let text = ''
  const take = (pieces: Chunk[]) => {
    for (const piece of pieces) {
      if (piece.kind === 'reasoning') {
        reasoning += piece.delta
        sink?.reasoning(piece.delta)
      } else {
        text += piece.delta
        sink?.text(piece.delta)
      }
    }
  }
  try {
    const stream = cfg.info.stream({
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      system: prompt.system,
      user: prompt.user,
      maxTokens: options.maxTokens,
      reasoning: options.reasoning,
      json: options.json,
      signal,
    })
    for await (const chunk of stream) take(chunk.kind === 'text' ? splitter.push(chunk.delta) : [chunk])
    take(splitter.flush())
    return { reasoning: reasoning.trim(), text: text.trim() }
  } finally {
    dispose()
  }
}

function rethrowIfAborted(signal: AbortSignal | undefined, error: unknown): void {
  if (signal?.aborted) throw signal.reason ?? error
}

function reasoningMode(value: string | undefined): ReasoningMode {
  const v = value?.trim().toLowerCase()
  return v === 'low' || v === 'high' || v === 'xhigh' || v === 'tags' || v === 'off' ? v : 'medium'
}

/** The env reasoning mode, with the host's per-game effort taking over native levels (never tags or off). */
function narratorReasoning(env: AiEnv, effort: Effort | undefined): ReasoningMode {
  const mode = reasoningMode(env.NARRATOR_REASONING)
  return effort && isNativeMode(mode) && (effort === 'high' || effort === 'xhigh') ? effort : mode
}

/** Timeout for one model call. The room budgets its judging slices with this same value. */
export function callTimeoutMs(env: AiEnv): number {
  const seconds = Number.parseFloat(env.AI_TIMEOUT_SECONDS ?? '')
  // Capped so a whole judging slice stays inside the Durable Object alarm's wall-clock limit.
  return Math.min(120, Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_TIMEOUT_SECONDS) * 1000
}

function mockDelay(env: AiEnv): number {
  const ms = Number.parseFloat(env.MOCK_DELAY_MS ?? '')
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_MOCK_DELAY_MS
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
