import { test } from 'node:test'
import assert from 'node:assert/strict'
import { combine, decisionWeights, describeModels, noPlanOutcome } from '../worker/ai/index.ts'
import type { JudgeResult, NarrationResult, Weights } from '../worker/ai/types.ts'

const DEFAULT: Weights = { narrator: 0.75, judge: 0.25 }

function narration(chance: number, cleverness: number, fallback = false): NarrationResult {
  return {
    chance,
    cleverness,
    model: fallback ? 'Mock narrator' : 'Claude Haiku 5.5',
    fallback,
    reasoning: 'r',
    stories: { survived: 'Sam survives.', died: 'Sam dies.' },
  }
}

function judgement(chance: number, cleverness: number, fallback = false): JudgeResult {
  return {
    chance,
    cleverness,
    model: fallback ? 'Heuristic judge' : 'Clef',
    fallback,
    reasons: { survived: 'Quick thinking saved the day.', died: 'The plan missed the real danger.' },
  }
}

test('combine: weighs the two chances and picks the matching story and reason', () => {
  const lived = combine(narration(0.8, 4), judgement(0.2, 2), DEFAULT)
  assert.deepEqual(lived, { survived: true, chance: 0.65, cleverness: 4, reason: 'Quick thinking saved the day.', story: 'Sam survives.' })

  const died = combine(narration(0.4, 2), judgement(0.6, 3), DEFAULT)
  assert.equal(died.chance, 0.45)
  assert.equal(died.survived, false)
  assert.equal(died.story, 'Sam dies.')
  assert.equal(died.reason, 'The plan missed the real danger.')

  // The judge can tip a close call.
  assert.equal(combine(narration(0.45, 3), judgement(0.95, 3), DEFAULT).survived, true)
})

test('combine: exactly 0.5 survives, just under does not, despite float noise', () => {
  assert.equal(combine(narration(0.5, 3), judgement(0.5, 3), DEFAULT).survived, true)
  const tipped = combine(narration(0.4, 3), judgement(0.8, 3), DEFAULT)
  assert.equal(tipped.chance, 0.5)
  assert.equal(tipped.survived, true)
  for (const w of [0.1, 0.2, 0.3, 0.6, 0.7, 0.9]) {
    assert.equal(combine(narration(0.5, 3), judgement(0.5, 3), { narrator: 1 - w, judge: w }).survived, true, `judge weight ${w}`)
  }
  assert.equal(combine(narration(0.4, 3), judgement(0.79, 3), DEFAULT).survived, false)
})

test('combine: a stand-in on one side lets the other decide alone', () => {
  const judgeFell = combine(narration(0.3, 2), judgement(0.95, 5, true), DEFAULT)
  assert.equal(judgeFell.chance, 0.3)
  assert.equal(judgeFell.cleverness, 2)
  assert.equal(judgeFell.survived, false)
  assert.equal(judgeFell.reason, 'The LLM judged the plan not good enough to survive.', 'a generic line, not the heuristic reason')
  assert.equal(judgeFell.story, 'Sam dies.')
  assert.equal(
    combine(narration(0.7, 2), judgement(0.1, 1, true), DEFAULT).reason,
    'The LLM judged the plan good enough to get out alive.',
  )

  const narratorFell = combine(narration(0.05, 1, true), judgement(0.6, 4), DEFAULT)
  assert.equal(narratorFell.chance, 0.6)
  assert.equal(narratorFell.cleverness, 4)
  assert.equal(narratorFell.survived, true)
  assert.equal(narratorFell.reason, 'Quick thinking saved the day.')
  assert.equal(narratorFell.story, 'Sam survives.', "the mock narrator's matching ending")

  // Both stand-ins: the usual weights, and the stand-in judge's reasons.
  const both = combine(narration(0.8, 4, true), judgement(0.2, 2, true), DEFAULT)
  assert.equal(both.chance, 0.65)
  assert.equal(both.reason, 'Quick thinking saved the day.')
})

test('combine: cleverness is the rounded weighted average', () => {
  assert.equal(combine(narration(0.5, 3), judgement(0.5, 5), DEFAULT).cleverness, 4, '3.5 rounds up')
  assert.equal(combine(narration(0.5, 2), judgement(0.5, 3), DEFAULT).cleverness, 2, '2.25 rounds down')
  assert.equal(combine(narration(0.5, 2), judgement(0.5, 3), { narrator: 0.5, judge: 0.5 }).cleverness, 3, '2.5 rounds up')
  assert.equal(combine(narration(0.5, 1), judgement(0.5, 5), { narrator: 0, judge: 1 }).cleverness, 5)
})

test('combine: clamps out-of-range values and normalizes weights', () => {
  const wild = combine(narration(1.7, 9), judgement(-0.5, -3), DEFAULT)
  assert.equal(wild.chance, 0.75)
  assert.equal(wild.cleverness, 4, '0.75 × 5 + 0.25 × 1')
  const nan = combine(narration(Number.NaN, Number.NaN), judgement(Number.NaN, Number.NaN), DEFAULT)
  assert.equal(nan.chance, 0)
  assert.equal(nan.cleverness, 1)
  assert.equal(nan.survived, false)
  assert.equal(combine(narration(0.8, 3), judgement(0.2, 3), { narrator: 3, judge: 1 }).chance, 0.65, 'weights are normalized')
  assert.equal(combine(narration(0.8, 3), judgement(0.2, 3), { narrator: 0, judge: 0 }).chance, 0.8, 'all-zero weights fall back to the narrator')
  assert.equal(combine(narration(0.8, 3), judgement(0.2, 3), { narrator: -1, judge: 1 }).chance, 0.2)
})

test('decisionWeights: reads JUDGE_WEIGHT, defaulting to 0.25 and clamping to 0–1', () => {
  assert.deepEqual(decisionWeights({}), { narrator: 0.75, judge: 0.25 })
  assert.deepEqual(decisionWeights({ JUDGE_WEIGHT: '0.4' }), { narrator: 0.6, judge: 0.4 })
  assert.deepEqual(decisionWeights({ JUDGE_WEIGHT: ' 0.5 ' }), { narrator: 0.5, judge: 0.5 })
  assert.deepEqual(decisionWeights({ JUDGE_WEIGHT: '0' }), { narrator: 1, judge: 0 })
  assert.deepEqual(decisionWeights({ JUDGE_WEIGHT: '1' }), { narrator: 0, judge: 1 })
  assert.deepEqual(decisionWeights({ JUDGE_WEIGHT: '1.5' }), { narrator: 0, judge: 1 })
  assert.deepEqual(decisionWeights({ JUDGE_WEIGHT: '-2' }), { narrator: 1, judge: 0 })
  assert.deepEqual(decisionWeights({ JUDGE_WEIGHT: 'heavy' }), { narrator: 0.75, judge: 0.25 })
  assert.deepEqual(decisionWeights({ JUDGE_WEIGHT: '' }), { narrator: 0.75, judge: 0.25 })
  assert.deepEqual(describeModels({ JUDGE_WEIGHT: '0.4' }).weights, { narrator: 0.6, judge: 0.4 })
})

test('noPlanOutcome is a deterministic, short death with a reason', () => {
  const input = { scenario: 'A volcano erupts.', playerName: 'Sam', plan: '', round: 3 }
  const a = noPlanOutcome(input)
  assert.deepEqual(Object.keys(a).sort(), ['reason', 'reasoning', 'story'])
  assert.deepEqual(a, noPlanOutcome(input))
  assert.ok(a.story.includes('Sam'))
  assert.ok(a.story.split(/\s+/).length < 40)
  assert.match(a.story, /dies|does not survive|perishes|doomed|demise/)
  assert.ok(a.reasoning.length > 0)
  assert.equal(a.reason, 'No plan was submitted, so fate filled in the blank.')
})

test('combine: the 50% line is exact, and the stored chance never sits on the wrong side of it', () => {
  const below = combine(narration(0.4999996, 3), judgement(0.4999996, 3), DEFAULT)
  assert.equal(below.survived, false)
  assert.ok(below.chance < 0.5)
  const at = combine(narration(0.5, 3), judgement(0.5, 3), DEFAULT)
  assert.equal(at.survived, true)
  assert.equal(at.chance, 0.5)
})

test('combine: with the decision model off the LLM decides alone, and the survive line is the host threshold', () => {
  const alone = combine(narration(0.55, 4), null, { narrator: 0.8, judge: 0.2 })
  assert.equal(alone.survived, true)
  assert.equal(alone.chance, 0.55)
  assert.equal(alone.cleverness, 4)
  assert.equal(alone.reason, 'The LLM judged the plan good enough to get out alive.')

  const strict = combine(narration(0.65, 3), judgement(0.5, 3), { narrator: 0.8, judge: 0.2 }, 0.7)
  assert.equal(strict.survived, false, '62% does not reach a 70% line')
  assert.ok(strict.chance < 0.7)
  const lenient = combine(narration(0.35, 3), judgement(0.3, 3), { narrator: 0.8, judge: 0.2 }, 0.3)
  assert.equal(lenient.survived, true, '34% clears a 30% line')
})
