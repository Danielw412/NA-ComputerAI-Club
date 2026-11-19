import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readSse, SseParser } from '../worker/ai/sse.ts'
import type { SseEvent } from '../worker/ai/sse.ts'
import { ThinkSplitter } from '../worker/ai/think.ts'
import type { Piece } from '../worker/ai/think.ts'

function parseInPieces(text: string, size: number): SseEvent[] {
  const parser = new SseParser()
  const events: SseEvent[] = []
  for (let i = 0; i < text.length; i += size) events.push(...parser.push(text.slice(i, i + size)))
  events.push(...parser.flush())
  return events
}

const SAMPLE =
  ': keep-alive comment\r\n' +
  'event: content_block_delta\r\n' +
  'data: {"a":1}\r\n' +
  '\r\n' +
  'data: line one\r\n' +
  'data: line two\r\n' +
  '\r\n' +
  'event:ping\n' +
  'data:no-space\n' +
  '\n' +
  'data: [DONE]\n\n'

const EXPECTED: SseEvent[] = [
  { event: 'content_block_delta', data: '{"a":1}' },
  { event: 'message', data: 'line one\nline two' },
  { event: 'ping', data: 'no-space' },
  { event: 'message', data: '[DONE]' },
]

test('SSE parser gives identical events for every chunk size', () => {
  for (let size = 1; size <= SAMPLE.length; size++) {
    assert.deepEqual(parseInPieces(SAMPLE, size), EXPECTED, `chunk size ${size}`)
  }
})

test('SSE parser handles a CRLF split between chunks and bare CR endings', () => {
  const parser = new SseParser()
  assert.deepEqual(parser.push('data: x\r'), [])
  assert.deepEqual(parser.push('\n\r'), [])
  // The final '\r' might be half of '\r\n', so the second event waits for more input.
  assert.deepEqual(parser.push('\ndata: y\r\r'), [{ event: 'message', data: 'x' }])
  assert.deepEqual(parser.push('data: z\n\n'), [{ event: 'message', data: 'y' }, { event: 'message', data: 'z' }])
})

test('SSE parser flushes a final event that has no trailing blank line', () => {
  const parser = new SseParser()
  assert.deepEqual(parser.push('data: tail'), [])
  assert.deepEqual(parser.flush(), [{ event: 'message', data: 'tail' }])
})

test('readSse decodes UTF-8 split across byte chunks and stops at [DONE]', async () => {
  const bytes = new TextEncoder().encode('data: héllo 🚀\n\ndata: [DONE]\n\ndata: after\n\n')
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
      controller.close()
    },
  })
  const events: SseEvent[] = []
  for await (const event of readSse(body)) events.push(event)
  assert.deepEqual(events, [{ event: 'message', data: 'héllo 🚀' }])
})

test('readSse throws the abort reason when the signal aborts mid-stream', async () => {
  const controller = new AbortController()
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('data: first\n\n'))
    },
  })
  const seen: string[] = []
  await assert.rejects(async () => {
    for await (const event of readSse(body, controller.signal)) {
      seen.push(event.data)
      controller.abort(new Error('stop'))
    }
  }, /stop/)
  assert.deepEqual(seen, ['first'])
})

function split(chunks: string[]): Piece[] {
  const splitter = new ThinkSplitter()
  const pieces = [...chunks.flatMap((c) => splitter.push(c)), ...splitter.flush()]
  // Merge adjacent pieces of the same kind so assertions don't depend on chunking.
  const merged: Piece[] = []
  for (const p of pieces) {
    const last = merged[merged.length - 1]
    if (last?.kind === p.kind) last.delta += p.delta
    else merged.push({ ...p })
  }
  return merged
}

test('think splitter separates reasoning for every possible split point', () => {
  const text = 'intro <think>weigh the plan</think>The story.'
  const expected: Piece[] = [
    { kind: 'text', delta: 'intro ' },
    { kind: 'reasoning', delta: 'weigh the plan' },
    { kind: 'text', delta: 'The story.' },
  ]
  for (let i = 0; i <= text.length; i++) {
    for (let j = i; j <= text.length; j++) {
      assert.deepEqual(split([text.slice(0, i), text.slice(i, j), text.slice(j)]), expected, `split at ${i},${j}`)
    }
  }
})

test('think splitter accepts <thinking> and mixed case, and drops stray closing tags', () => {
  assert.deepEqual(split(['<THINKING>hm', 'm</Thinking>ok']), [
    { kind: 'reasoning', delta: 'hmm' },
    { kind: 'text', delta: 'ok' },
  ])
  assert.deepEqual(split(['story', '</think> more']), [{ kind: 'text', delta: 'story more' }])
})

test('think splitter keeps ordinary angle brackets as text', () => {
  assert.deepEqual(split(['a < b and x <', 'y> z <thi']), [{ kind: 'text', delta: 'a < b and x <y> z <thi' }])
})

test('think splitter emits an unterminated think block as reasoning', () => {
  assert.deepEqual(split(['<think>never closed']), [{ kind: 'reasoning', delta: 'never closed' }])
})
