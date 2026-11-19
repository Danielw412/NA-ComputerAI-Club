/** OpenAI Responses API, which streams reasoning summaries for o-series and GPT-5 models. */
import { bearer, parseData, postStream, ProviderError } from '../http.ts'
import type { Droppable } from '../http.ts'
import { readSse } from '../sse.ts'
import { nativeEffort } from './provider.ts'
import type { Chunk, ProviderRequest } from './provider.ts'

interface ResponsesEvent {
  type?: string
  delta?: string
  summary_index?: number
  message?: string
  error?: { message?: string }
  response?: { error?: { message?: string } | null; incomplete_details?: { reason?: string } | null }
}

export async function* streamOpenAIResponses(req: ProviderRequest): AsyncGenerator<Chunk> {
  const effort = nativeEffort(req.reasoning)
  const droppable: Droppable[] = []
  // Unverified organizations may not get reasoning summaries; keep the effort setting if so.
  if (effort) droppable.push({ name: 'summary', match: /summar/i }, { name: 'reasoning', match: /reasoning/i })
  if (req.json) droppable.push({ name: 'json', match: /text\.format|json/i })

  const res = await postStream({
    url: `${req.baseUrl}/responses`,
    signal: req.signal,
    secret: req.apiKey,
    droppable,
    build: (dropped) => {
      const body: Record<string, unknown> = {
        model: req.model,
        instructions: req.system,
        input: req.user,
        stream: true,
        store: false,
        max_output_tokens: req.maxTokens,
      }
      if (effort && !dropped.has('reasoning')) {
        body.reasoning = dropped.has('summary') ? { effort } : { effort, summary: 'auto' }
      }
      if (req.json && !dropped.has('json')) body.text = { format: { type: 'json_object' } }
      return { headers: bearer(req.apiKey), body }
    },
  })

  for await (const event of readSse(res.body, req.signal)) {
    const data = parseData<ResponsesEvent>(event.data)
    switch (data.type ?? event.event) {
      case 'response.reasoning_summary_part.added':
        if ((data.summary_index ?? 0) > 0) yield { kind: 'reasoning', delta: '\n\n' }
        break
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        if (data.delta) yield { kind: 'reasoning', delta: data.delta }
        break
      case 'response.output_text.delta':
        if (data.delta) yield { kind: 'text', delta: data.delta }
        break
      case 'response.failed':
        throw new ProviderError(data.response?.error?.message ?? 'Response failed')
      case 'error':
        throw new ProviderError(data.message ?? data.error?.message ?? 'Stream error')
    }
  }
}
