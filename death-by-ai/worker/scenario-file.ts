/** Parses scenarios.txt. Kept free of bundler imports so tests can run it on the raw file. */
import { cleanText, LIMITS, type ScenarioGroup } from '../shared/protocol.ts'

const UNGROUPED = 'Scenarios'

/**
 * One scenario per line. "## Name" starts a group, other "#" lines are
 * comments, and blank lines are skipped. Overlong lines are cut to the
 * scenario limit, and a repeated scenario keeps only its first appearance.
 */
export function parseScenarios(text: string): ScenarioGroup[] {
  const groups: ScenarioGroup[] = []
  const seen = new Set<string>()
  let current: ScenarioGroup | null = null

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('## ')) {
      const name = cleanText(line.slice(3), 40) || UNGROUPED
      current = groups.find((g) => g.name === name) ?? null
      if (!current) {
        current = { name, scenarios: [] }
        groups.push(current)
      }
      continue
    }
    if (!line || line.startsWith('#')) continue
    const scenario = cleanText(line, LIMITS.scenarioLength)
    if (!scenario || seen.has(scenario)) continue
    seen.add(scenario)
    if (!current) {
      current = { name: UNGROUPED, scenarios: [] }
      groups.push(current)
    }
    current.scenarios.push(scenario)
  }
  return groups.filter((g) => g.scenarios.length > 0)
}
