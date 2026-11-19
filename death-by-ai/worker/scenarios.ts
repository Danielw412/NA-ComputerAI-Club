/** The scenario pool, read from scenarios.txt at build time. */
import type { ScenarioGroup } from '../shared/protocol.ts'
import SCENARIO_TEXT from '../scenarios.txt?raw'
import { parseScenarios } from './scenario-file.ts'

/** Used only if scenarios.txt is empty. */
export const FALLBACK_SCENARIO = "You're trapped in a sinking submarine with 60 seconds of oxygen left."

export const SCENARIO_GROUPS: readonly ScenarioGroup[] = parseScenarios(SCENARIO_TEXT)

const ALL: readonly string[] = SCENARIO_GROUPS.flatMap((g) => g.scenarios)

/**
 * A random scenario from the file. It never returns one in `never`, and it
 * avoids `avoid` until only those are left. Null when nothing is allowed.
 */
export function pickScenario(avoid: readonly string[], never: readonly string[] = []): string | null {
  const banned = new Set(never)
  const allowed = (ALL.length > 0 ? ALL : [FALLBACK_SCENARIO]).filter((s) => !banned.has(s))
  if (allowed.length === 0) return null
  const skip = new Set(avoid)
  const fresh = allowed.filter((s) => !skip.has(s))
  const pool = fresh.length > 0 ? fresh : allowed
  return pool[crypto.getRandomValues(new Uint32Array(1))[0] % pool.length]
}
