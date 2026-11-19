/**
 * Claude through the official Anthropic SDK, streaming with adaptive thinking.
 *
 * Current Claude models (Haiku 5.5, Sonnet 5.5, Opus 5.5, Fable 5.x) take
 * `thinking: {type: 'adaptive'}` with depth set by `output_config.effort`
 * ('low' to 'xhigh' here); `budget_tokens` and sampling parameters are
 * rejected. Thinking text is omitted by default, so `display: 'summarized'`
 * is required for a visible trace.
 *
 * The SDK never retries (`maxRetries: 0`): the caller in index.ts retries once
 * and then falls back to the mock, so every failure here becomes a
 * ProviderError, except an abort, which rethrows the signal's reason.
 */
import Anthropic from '@anthropic-ai/sdk'
import { errorMessage, ProviderError, redact, requireKey } from '../http.ts'
import { isNativeMode } from './provider.ts'
import type { Chunk, NativeEffort, ProviderRequest } from './provider.ts'

/** The SDK's base URL: without `/v1`, which the SDK adds itself. */
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'
/**
 * Models that accept `fallbacks: 'default'` (a beta on the Messages API), which
 * reroutes a safety refusal to another model in the same call. Haiku 5.5 has none.
 */
const SERVER_FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-2', 'claude-fable-5-1'])

/** Optional request features, dropped in this order when a 400 mentions them. */
const DROPPABLE = [
  { name: 'fallbacks', match: /fallback/i },
  // Older models that predate adaptive thinking reject these; run them without a trace.
  { name: 'thinking', match: /thinking|effort|output_config|display/i },
] as const
type Feature = (typeof DROPPABLE)[number]['name']

type StreamEvent = Anthropic.RawMessageStreamEvent | Anthropic.Beta.BetaRawMessageStreamEvent

export async function* streamAnthropic(req: ProviderRequest): AsyncGenerator<Chunk> {
  const apiKey = requireKey(req.apiKey, 'anthropic')
  const baseURL = sdkBaseUrl(req.baseUrl)
  const effort = isNativeMode(req.reasoning) ? req.reasoning : undefined
  const offered = new Set<Feature>()
  if (baseURL === ANTHROPIC_BASE_URL && SERVER_FALLBACK_MODELS.has(req.model)) offered.add('fallbacks')
  if (effort) offered.add('thinking')

  // Logging off: the SDK would otherwise log raw stream data (player text, anything a proxy echoes) before we redact it.
  const client = new Anthropic({ apiKey, baseURL, maxRetries: 0, logLevel: 'off' })
  const fail = (error: unknown) => failure(error, req.signal, apiKey)

  let stream: AsyncIterable<StreamEvent>
  for (;;) {
    try {
      stream = await open(client, req, offered.has('thinking') ? effort : undefined, offered.has('fallbacks'))
      break
    } catch (error) {
      const feature = droppedFeature(error, offered)
      if (!feature || req.signal.aborted) throw fail(error)
      offered.delete(feature)
    }
  }

  let thinkingBlocks = 0
  let stopReason: string | null = null
  let finished = false
  try {
    for await (const event of untilAborted(stream, req.signal)) {
      switch (event.type) {
        case 'content_block_start':
          if (event.content_block.type === 'thinking' && thinkingBlocks++ > 0) yield { kind: 'reasoning', delta: '\n\n' }
          break
        case 'content_block_delta':
          if (event.delta.type === 'thinking_delta' && event.delta.thinking) yield { kind: 'reasoning', delta: event.delta.thinking }
          else if (event.delta.type === 'text_delta' && event.delta.text) yield { kind: 'text', delta: event.delta.text }
          break
        case 'message_delta':
          if (event.delta.stop_reason === 'refusal') throw new ProviderError('Model declined the request')
          stopReason = event.delta.stop_reason ?? stopReason
          break
        case 'message_stop':
          finished = true
          break
      }
    }
  } catch (error) {
    throw fail(error)
  }
  // The SDK ends the stream quietly when its signal aborts; surface that as the abort (or timeout) it is.
  if (req.signal.aborted) throw req.signal.reason
  // A cut-off answer may be missing an ending (or have a half-written one), so it counts as a failure (retry, then the mock).
  if (!finished) throw new ProviderError('The stream ended before the message was complete')
  if (stopReason !== 'end_turn' && stopReason !== 'stop_sequence') {
    throw new ProviderError(`The answer was cut off (stop reason: ${stopReason ?? 'none'})`)
  }
}

/** Iterates `source`, rejecting with the signal's reason as soon as it aborts, even if the body ignores the abort. */
async function* untilAborted<T>(source: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]()
  let onAbort = () => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  aborted.catch(() => {})
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), aborted])
      if (next.done) return
      yield next.value
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
    // Let the SDK cancel its request; don't wait on a body that may never settle.
    void iterator.return?.()?.catch(() => {})
  }
}

function open(client: Anthropic, req: ProviderRequest, effort: NativeEffort | undefined, serverFallback: boolean): Promise<AsyncIterable<StreamEvent>> {
  const params = {
    model: req.model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: [{ role: 'user' as const, content: req.user }],
    stream: true as const,
    ...(effort ? { thinking: { type: 'adaptive' as const, display: 'summarized' as const }, output_config: { effort } } : {}),
  }
  const options = { signal: req.signal }
  if (serverFallback) return client.beta.messages.create({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' }, options)
  return client.messages.create(params, options)
}

/** The optional feature a 400 response complains about, if it is one still being sent. */
function droppedFeature(error: unknown, offered: ReadonlySet<Feature>): Feature | undefined {
  if (!(error instanceof Anthropic.BadRequestError)) return undefined
  return DROPPABLE.find((d) => offered.has(d.name) && d.match.test(error.message))?.name
}

/** Maps any SDK failure to a ProviderError (key redacted), or to the abort reason when the call was aborted. */
function failure(error: unknown, signal: AbortSignal, apiKey: string): unknown {
  if (signal.aborted) return signal.reason ?? error
  if (error instanceof ProviderError) return error
  const status = error instanceof Anthropic.APIError ? error.status : undefined
  const prefix = status ? `HTTP ${status}` : error instanceof Anthropic.APIConnectionError ? 'Network error' : 'Anthropic error'
  return new ProviderError(redact(`${prefix}: ${errorMessage(error)}`, apiKey).slice(0, 400), status)
}

/** Accepts base URLs with or without the `/v1` suffix (older configs included it). */
function sdkBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
}
