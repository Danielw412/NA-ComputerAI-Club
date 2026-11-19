/** Server-Sent Events parsing shared by every streaming provider. */

export interface SseEvent {
  /** The `event:` field, or 'message' when the server sent none. */
  event: string
  /** All `data:` lines of the event joined with '\n'. */
  data: string
}

/**
 * Incremental SSE parser. Feed it decoded text in arbitrary chunks and it
 * returns every event completed so far. Handles `\n`, `\r\n` and `\r` line
 * endings (including a `\r\n` split across chunks), multi-line `data:`,
 * `event:` names and `:` comments.
 */
export class SseParser {
  #buffer = ''
  #event = ''
  #data: string[] = []

  push(chunk: string): SseEvent[] {
    const out: SseEvent[] = []
    const buf = this.#buffer + chunk
    let start = 0
    for (let i = 0; i < buf.length; i++) {
      const c = buf[i]
      if (c !== '\n' && c !== '\r') continue
      // A trailing '\r' may be the first half of '\r\n'; wait for more input.
      if (c === '\r' && i === buf.length - 1) break
      this.#line(buf.slice(start, i), out)
      if (c === '\r' && buf[i + 1] === '\n') i++
      start = i + 1
    }
    this.#buffer = buf.slice(start)
    return out
  }

  /** Call at end of stream: completes a final line or event that lacked a terminator. */
  flush(): SseEvent[] {
    const out: SseEvent[] = []
    const rest = this.#buffer.replace(/\r$/, '')
    this.#buffer = ''
    if (rest) this.#line(rest, out)
    this.#line('', out)
    return out
  }

  #line(line: string, out: SseEvent[]): void {
    if (line === '') {
      if (this.#data.length > 0) out.push({ event: this.#event || 'message', data: this.#data.join('\n') })
      this.#event = ''
      this.#data = []
      return
    }
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') this.#data.push(value)
    else if (field === 'event') this.#event = value
  }
}

/**
 * Reads an SSE response body as events. Stops at an OpenAI-style `[DONE]`
 * sentinel. When `signal` aborts, the body is cancelled and the signal's
 * reason is thrown, even if the runtime would leave a stalled read pending.
 */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const parser = new SseParser()
  const onAbort = () => {
    reader.cancel(signal?.reason).catch(() => {})
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      signal?.throwIfAborted()
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      const events = done ? [...parser.push(decoder.decode()), ...parser.flush()] : parser.push(decoder.decode(value, { stream: true }))
      for (const event of events) {
        if (event.data.trim() === '[DONE]') return
        yield event
      }
      if (done) return
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    reader.cancel().catch(() => {})
  }
}
