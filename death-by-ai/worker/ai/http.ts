/** HTTP, abort and error helpers shared by the real providers. */

/** Any failure of a provider call that should trigger a retry or fallback. */
export class ProviderError extends Error {
  status: number | undefined

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ProviderError'
    this.status = status
  }
}

/** An optional request feature that is dropped if a 400 response mentions it. */
export interface Droppable {
  name: string
  match: RegExp
}

export interface PostOptions {
  url: string
  /** Builds headers and body, leaving out any features already dropped. */
  build: (dropped: ReadonlySet<string>) => { headers: Record<string, string>; body: unknown }
  /** Features to try removing, in order, when a 400 response mentions them. */
  droppable?: Droppable[]
  signal: AbortSignal
  /** Redacted from error messages if a server echoes it back. */
  secret?: string
}

/**
 * POSTs JSON and returns a successful streaming response. Some compatible
 * hosts reject optional parameters (JSON mode, reasoning knobs) with a 400;
 * those are dropped one at a time and the request is resent.
 */
export async function postStream(options: PostOptions): Promise<Response & { body: ReadableStream<Uint8Array> }> {
  const dropped = new Set<string>()
  for (;;) {
    const { headers, body } = options.build(dropped)
    let res: Response
    try {
      res = await fetch(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: options.signal,
      })
    } catch (error) {
      if (options.signal.aborted) throw error
      throw new ProviderError(`Network error: ${errorMessage(error)}`)
    }
    if (res.ok && res.body) return res as Response & { body: ReadableStream<Uint8Array> }
    if (res.ok) throw new ProviderError('Response had no body', res.status)

    const text = redact(await res.text().catch(() => ''), options.secret).slice(0, 400)
    if (res.status === 400) {
      const feature = options.droppable?.find((d) => !dropped.has(d.name) && d.match.test(text))
      if (feature) {
        dropped.add(feature.name)
        continue
      }
    }
    throw new ProviderError(`HTTP ${res.status}: ${text || res.statusText}`, res.status)
  }
}

export function parseData<T>(data: string): T {
  try {
    return JSON.parse(data) as T
  } catch {
    throw new ProviderError(`Unparseable stream event: ${data.slice(0, 120)}`)
  }
}

export function bearer(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {}
}

export function requireKey(apiKey: string | undefined, provider: string): string {
  if (!apiKey) throw new ProviderError(`${provider}: API key is not set`)
  return apiKey
}

/**
 * Combines the caller's signal with a per-call timeout. Call `dispose` when
 * the call finishes so the timer does not keep running.
 */
export function callSignal(caller: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(new ProviderError(`Timed out after ${timeoutMs / 1000}s`)), timeoutMs)
  if (!caller) return { signal: timeout.signal, dispose: () => clearTimeout(timer) }
  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any([caller, timeout.signal]), dispose: () => clearTimeout(timer) }
  }
  const combined = new AbortController()
  const forward = (source: AbortSignal) => () => combined.abort(source.reason)
  const onCaller = forward(caller)
  const onTimeout = forward(timeout.signal)
  if (caller.aborted) combined.abort(caller.reason)
  caller.addEventListener('abort', onCaller, { once: true })
  timeout.signal.addEventListener('abort', onTimeout, { once: true })
  return {
    signal: combined.signal,
    dispose: () => {
      clearTimeout(timer)
      caller.removeEventListener('abort', onCaller)
      timeout.signal.removeEventListener('abort', onTimeout)
    },
  }
}

/** Resolves after `ms`, or rejects with the signal's reason if it aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function redact(text: string, secret: string | undefined): string {
  // Very short values can't be real keys, and redacting them would mangle the message.
  return secret && secret.length >= 8 ? text.split(secret).join('***') : text
}
