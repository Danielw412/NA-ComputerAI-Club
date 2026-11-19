/**
 * Streaming splitter for `<think>…</think>` (or `<thinking>…</thinking>`)
 * blocks inside a model's visible text. Tags may arrive split across chunks,
 * so a possible partial tag at the end of a chunk is held back until the
 * next chunk decides it.
 */

export interface Piece {
  kind: 'reasoning' | 'text'
  delta: string
}

const OPEN_OR_STRAY_CLOSE = /<(\/?)think(?:ing)?>/i
const CLOSE = /<\/think(?:ing)?>/i
const OPEN_TAGS = ['<think>', '<thinking>', '</think>', '</thinking>']
const CLOSE_TAGS = ['</think>', '</thinking>']

export class ThinkSplitter {
  #inThink = false
  #pending = ''

  push(chunk: string): Piece[] {
    const out: Piece[] = []
    let s = this.#pending + chunk
    this.#pending = ''
    while (s) {
      const match = (this.#inThink ? CLOSE : OPEN_OR_STRAY_CLOSE).exec(s)
      if (match) {
        this.#emit(out, s.slice(0, match.index))
        // Outside a think block, a stray closing tag is dropped without changing state.
        if (this.#inThink || match[1] !== '/') this.#inThink = !this.#inThink
        s = s.slice(match.index + match[0].length)
        continue
      }
      const lt = s.lastIndexOf('<')
      if (lt !== -1 && this.#couldBeTag(s.slice(lt))) {
        this.#emit(out, s.slice(0, lt))
        this.#pending = s.slice(lt)
      } else {
        this.#emit(out, s)
      }
      break
    }
    return out
  }

  /** Call at end of stream to release any held-back text. */
  flush(): Piece[] {
    const out: Piece[] = []
    this.#emit(out, this.#pending)
    this.#pending = ''
    return out
  }

  #couldBeTag(tail: string): boolean {
    const lower = tail.toLowerCase()
    return (this.#inThink ? CLOSE_TAGS : OPEN_TAGS).some((tag) => tag.startsWith(lower))
  }

  #emit(out: Piece[], delta: string): void {
    if (!delta) return
    const kind = this.#inThink ? 'reasoning' : 'text'
    const last = out[out.length - 1]
    if (last && last.kind === kind) last.delta += delta
    else out.push({ kind, delta })
  }
}
