import type { AiEnv } from './ai/types.ts'
import type { GameRoom } from './room.ts'

export interface Env extends AiEnv {
  ROOMS: DurableObjectNamespace<GameRoom>
  ASSETS: Fetcher
  /** Optional Workers rate-limit binding for host sign-in attempts. */
  LOGIN_LIMITER?: RateLimit
  /** Secret. The password hosts type to unlock hosting. */
  HOST_PASSWORD?: string
  /** Optional secret. Extra random key material for signing host sessions. */
  HOST_SESSION_SECRET?: string
  HOST_SESSION_HOURS?: string
  /** Max plans judged at once per room. */
  AI_CONCURRENCY?: string
  /** Max plans started per alarm run, to stay inside the per-run outgoing request limit. */
  AI_PLANS_PER_RUN?: string
}

export function intVar(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(value ?? '', 10)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}
