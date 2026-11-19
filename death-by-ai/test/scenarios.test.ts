import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { LIMITS } from '../shared/protocol.ts'
import { parseScenarios } from '../worker/scenario-file.ts'

test('parses groups, skips comments and blank lines', () => {
  const groups = parseScenarios(
    ['# a comment', '', 'Loose scenario.', '## Space', '  Floating away.  ', '#another', '## Sea', 'Sinking.', ''].join('\r\n'),
  )
  assert.deepEqual(groups, [
    { name: 'Scenarios', scenarios: ['Loose scenario.'] },
    { name: 'Space', scenarios: ['Floating away.'] },
    { name: 'Sea', scenarios: ['Sinking.'] },
  ])
})

test('drops repeats and empty groups, merges a repeated group name, and caps length', () => {
  const long = 'x'.repeat(LIMITS.scenarioLength + 50)
  const groups = parseScenarios(['## A', 'One.', 'One.', '## Empty', '## A', 'Two.', long].join('\n'))
  assert.deepEqual(groups.map((g) => g.name), ['A'])
  assert.deepEqual(groups[0].scenarios.slice(0, 2), ['One.', 'Two.'])
  assert.equal(groups[0].scenarios[2].length, LIMITS.scenarioLength)
})

test('the shipped scenarios.txt is well formed', () => {
  const text = readFileSync(new URL('../scenarios.txt', import.meta.url), 'utf8')
  const groups = parseScenarios(text)
  const all = groups.flatMap((g) => g.scenarios)
  assert.ok(groups.length >= 2, 'expected several groups')
  assert.ok(all.length >= 30, `expected a full pool, got ${all.length}`)
  // No line may lose text to the length cap.
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'))
  assert.equal(lines.length, all.length, 'every scenario line is unique')
  for (const line of lines) assert.ok(Array.from(line.trim()).length <= LIMITS.scenarioLength, line)
})
