/** The small internal interface every real provider implements. */

export interface Chunk {
  kind: 'reasoning' | 'text'
  delta: string
}

/** 'tags' = prompt the model to think inside <think> tags; 'off' = no reasoning parameters. */
export type ReasoningMode = 'low' | 'medium' | 'high' | 'xhigh' | 'tags' | 'off'

/** Effort levels a provider can send natively. Only the anthropic provider sends 'xhigh'. */
export type NativeEffort = 'low' | 'medium' | 'high' | 'xhigh'

export interface ProviderRequest {
  model: string
  /** Without a trailing slash. */
  baseUrl: string
  apiKey?: string
  system: string
  user: string
  maxTokens: number
  reasoning: ReasoningMode
  /** Ask for a JSON object response where the provider supports it cheaply. */
  json: boolean
  signal: AbortSignal
}

export type StreamProvider = (req: ProviderRequest) => AsyncGenerator<Chunk>

/** True when the mode asks for the provider's own reasoning parameters (not prompted tags, not off). */
export function isNativeMode(mode: ReasoningMode): mode is NativeEffort {
  return mode === 'low' || mode === 'medium' || mode === 'high' || mode === 'xhigh'
}

/**
 * The effort level for providers without 'xhigh' (it becomes 'high'), or
 * undefined when no reasoning parameters should be sent.
 */
export function nativeEffort(mode: ReasoningMode): 'low' | 'medium' | 'high' | undefined {
  if (!isNativeMode(mode)) return undefined
  return mode === 'xhigh' ? 'high' : mode
}
