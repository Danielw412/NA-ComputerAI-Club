/** Google Gemini streamGenerateContent over SSE, with thought summaries. */
import { parseData, postStream, ProviderError, requireKey } from '../http.ts'
import type { Droppable } from '../http.ts'
import { readSse } from '../sse.ts'
import { nativeEffort } from './provider.ts'
import type { Chunk, ProviderRequest } from './provider.ts'

const THINKING_BUDGET = { low: 1024, medium: 4096, high: 16384 } as const

interface GeminiEvent {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>
  promptFeedback?: { blockReason?: string }
  error?: { message?: string }
}

export async function* streamGemini(req: ProviderRequest): AsyncGenerator<Chunk> {
  const apiKey = requireKey(req.apiKey, 'gemini')
  const effort = nativeEffort(req.reasoning)
  const model = req.model.replace(/^models\//, '')

  const droppable: Droppable[] = []
  // Drop the budget first (some models only take thinkingLevel), then thinking entirely.
  if (effort) droppable.push({ name: 'budget', match: /thinking/i }, { name: 'thinking', match: /thinking|thought/i })
  if (req.json) droppable.push({ name: 'json', match: /mime|json/i })

  const res = await postStream({
    url: `${req.baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
    signal: req.signal,
    secret: apiKey,
    droppable,
    build: (dropped) => {
      const generationConfig: Record<string, unknown> = { maxOutputTokens: req.maxTokens }
      if (effort && !dropped.has('thinking')) {
        generationConfig.thinkingConfig = dropped.has('budget')
          ? { includeThoughts: true }
          : { includeThoughts: true, thinkingBudget: THINKING_BUDGET[effort] }
      }
      if (req.json && !dropped.has('json')) generationConfig.responseMimeType = 'application/json'
      return {
        headers: { 'x-goog-api-key': apiKey },
        body: {
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ role: 'user', parts: [{ text: req.user }] }],
          generationConfig,
        },
      }
    },
  })

  for await (const event of readSse(res.body, req.signal)) {
    const data = parseData<GeminiEvent>(event.data)
    if (data.error) throw new ProviderError(data.error.message ?? 'Stream error')
    if (data.promptFeedback?.blockReason) throw new ProviderError(`Prompt blocked: ${data.promptFeedback.blockReason}`)
    for (const part of data.candidates?.[0]?.content?.parts ?? []) {
      if (part.text) yield { kind: part.thought ? 'reasoning' : 'text', delta: part.text }
    }
  }
}
