/**
 * OpenAI-compatible Chat Completions. Covers OpenAI, OpenRouter, Groq,
 * DeepSeek, Together, xAI, Ollama and Cloudflare Workers AI's /ai/v1 endpoint.
 */
import { bearer, parseData, postStream, ProviderError } from '../http.ts'
import type { Droppable } from '../http.ts'
import { readSse } from '../sse.ts'
import { nativeEffort } from './provider.ts'
import type { Chunk, ProviderRequest } from './provider.ts'

interface ChatDelta {
  content?: string | null
  /** DeepSeek, Workers AI. */
  reasoning_content?: string | null
  /** OpenRouter, Groq. */
  reasoning?: string | null
  /** OpenRouter's structured form; usually duplicates `reasoning`. */
  reasoning_details?: Array<{ type?: string; text?: string; summary?: string }>
}

interface ChatEvent {
  choices?: Array<{ delta?: ChatDelta }>
  error?: { message?: string } | string
}

export async function* streamOpenAI(req: ProviderRequest): AsyncGenerator<Chunk> {
  const effort = nativeEffort(req.reasoning)
  const openRouter = /openrouter\.ai/i.test(req.baseUrl)
  // OpenAI's own reasoning models reject max_tokens; many compatible hosts only know max_tokens.
  const preferCompletionTokens = /api\.openai\.com/i.test(req.baseUrl)

  const droppable: Droppable[] = []
  if (req.json) droppable.push({ name: 'json', match: /response_format|json_object|json mode/i })
  droppable.push({ name: 'tokens', match: /max_(completion_)?tokens/i })
  if (effort) droppable.push({ name: 'reasoning', match: /reasoning/i })

  const res = await postStream({
    url: `${req.baseUrl}/chat/completions`,
    signal: req.signal,
    secret: req.apiKey,
    droppable,
    build: (dropped) => {
      const body: Record<string, unknown> = {
        model: req.model,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        stream: true,
      }
      const completionTokens = preferCompletionTokens !== dropped.has('tokens')
      body[completionTokens ? 'max_completion_tokens' : 'max_tokens'] = req.maxTokens
      if (effort && !dropped.has('reasoning')) {
        if (openRouter) body.reasoning = { effort }
        else body.reasoning_effort = effort
      }
      if (req.json && !dropped.has('json')) body.response_format = { type: 'json_object' }
      return { headers: bearer(req.apiKey), body }
    },
  })

  for await (const event of readSse(res.body, req.signal)) {
    const data = parseData<ChatEvent>(event.data)
    if (data.error) {
      throw new ProviderError(typeof data.error === 'string' ? data.error : (data.error.message ?? 'Stream error'))
    }
    const delta = data.choices?.[0]?.delta
    if (!delta) continue
    const reasoning = delta.reasoning_content || delta.reasoning || detailsText(delta.reasoning_details)
    if (reasoning) yield { kind: 'reasoning', delta: reasoning }
    if (delta.content) yield { kind: 'text', delta: delta.content }
  }
}

function detailsText(details: ChatDelta['reasoning_details']): string {
  if (!Array.isArray(details)) return ''
  return details.map((d) => d.text ?? d.summary ?? '').join('')
}
