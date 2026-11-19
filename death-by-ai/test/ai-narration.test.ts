import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NarratorOutput, parseDecision } from '../worker/ai/narration.ts'
import type { NarratorDecision } from '../worker/ai/narration.ts'

const SURVIVED = 'Sam floods the trunk and kicks upward. Sam bursts into the sunlight and survives.'
const DIED = 'Sam floods the trunk, but the hatch jams. Sam does not survive.'
const OUTPUT = `<decision>chance: 72, cleverness: 4</decision>\n<survived>\n${SURVIVED}\n</survived>\n<died>\n${DIED}\n</died>`

/** Pushes `text` in pieces of `size`, returning the result and how much text had arrived when the decision appeared. */
function feed(text: string, size: number) {
  const output = new NarratorOutput()
  let decision: NarratorDecision | null = null
  let seenAt = -1
  for (let i = 0; i < text.length; i += size) {
    const d = output.push(text.slice(i, i + size))
    if (d) {
      assert.equal(decision, null, 'the decision is reported once')
      decision = d
      seenAt = Math.min(text.length, i + size)
    }
  }
  return { decision, seenAt, result: output.finish() }
}

test('narrator output: the decision is reported as soon as its block closes, for every chunk size', () => {
  const closesAt = OUTPUT.indexOf('</decision>') + '</decision>'.length
  for (let size = 1; size <= OUTPUT.length; size++) {
    const { decision, seenAt, result } = feed(OUTPUT, size)
    assert.deepEqual(decision, { chance: 0.72, cleverness: 4 }, `size ${size}`)
    assert.ok(seenAt >= closesAt && seenAt < closesAt + size, `size ${size}: seen at ${seenAt}, closes at ${closesAt}`)
    assert.deepEqual(result, { decision: { chance: 0.72, cleverness: 4 }, stories: { survived: SURVIVED, died: DIED } })
  }
})

test('narrator output: every two-way split inside the tags parses the same', () => {
  for (let i = 0; i <= OUTPUT.length; i++) {
    const output = new NarratorOutput()
    const first = output.push(OUTPUT.slice(0, i))
    const second = output.push(OUTPUT.slice(i))
    assert.deepEqual(first ?? second, { chance: 0.72, cleverness: 4 }, `split at ${i}`)
    assert.deepEqual(output.finish().stories, { survived: SURVIVED, died: DIED }, `split at ${i}`)
  }
})

test('narrator output: the decision fires before any ending text has arrived', () => {
  const output = new NarratorOutput()
  assert.equal(output.push('Some preamble the model should not have written. <decision>chance: 30'), null)
  assert.equal(output.push(', cleverness: 2</deci'), null)
  assert.deepEqual(output.push('sion>'), { chance: 0.3, cleverness: 2 })
  assert.equal(output.push(`<survived>${SURVIVED}</survived>`), null)
  assert.equal(output.push(`<died>${DIED}</died>`), null)
  assert.deepEqual(output.finish().stories, { survived: SURVIVED, died: DIED })
})

test('narrator output: an unclosed decision is closed by the first ending tag, or by the end of the stream', () => {
  const byTag = new NarratorOutput()
  assert.equal(byTag.push('<decision>chance: 55, cleverness: 3\n<surv'), null)
  assert.deepEqual(byTag.push('ived>'), { chance: 0.55, cleverness: 3 })

  const atEnd = new NarratorOutput()
  assert.equal(atEnd.push(`<died>${DIED}</died><survived>${SURVIVED}</survived><decision>chance: 10, cleverness: 1`), null)
  assert.deepEqual(atEnd.finish(), { decision: { chance: 0.1, cleverness: 1 }, stories: { survived: SURVIVED, died: DIED } })
})

test('narrator output: endings may be unclosed, reordered and spread over lines', () => {
  const output = new NarratorOutput()
  output.push(`<decision chance="80" cleverness="5"/>\n<died>\n  ${DIED}\n</died>\n<survived>\nSam floods the trunk.\n\nSam survives.`)
  assert.deepEqual(output.finish(), {
    decision: { chance: 0.8, cleverness: 5 },
    stories: { survived: 'Sam floods the trunk. Sam survives.', died: DIED },
  })
})

test('narrator output: an invalid decision throws as soon as the block closes', () => {
  for (const block of ['chance: 140, cleverness: 3', 'chance: 50, cleverness: 9', 'chance: 50', 'cleverness: 4', 'chance: high, cleverness: 4', '']) {
    const output = new NarratorOutput()
    assert.throws(() => output.push(`<decision>${block}</decision>`), { name: 'ProviderError' }, block)
  }
})

test('narrator output: a missing decision or ending fails at the end', () => {
  const noDecision = new NarratorOutput()
  noDecision.push(`<survived>${SURVIVED}</survived><died>${DIED}</died>`)
  assert.throws(() => noDecision.finish(), /no decision/)

  const noDeath = new NarratorOutput()
  noDeath.push(`<decision>chance: 60, cleverness: 3</decision><survived>${SURVIVED}</survived>`)
  assert.throws(() => noDeath.finish(), /death ending/)

  const emptySurvival = new NarratorOutput()
  emptySurvival.push(`<decision>chance: 60, cleverness: 3</decision><survived>  </survived><died>${DIED}</died>`)
  assert.throws(() => emptySurvival.finish(), /survival ending/)
})

test('decision formats: percent signs, fractions, extra words and attribute style', () => {
  assert.deepEqual(parseDecision('chance: 72%, cleverness: 4'), { chance: 0.72, cleverness: 4 })
  assert.deepEqual(parseDecision('survival chance = 0.35 | cleverness = 2/5'), { chance: 0.35, cleverness: 2 })
  assert.deepEqual(parseDecision(' chance="0" cleverness="1"'), { chance: 0, cleverness: 1 })
  assert.deepEqual(parseDecision('Chance: 100\nCleverness: 5'), { chance: 1, cleverness: 5 })
  assert.equal(parseDecision('chance: -4, cleverness: 3'), null)
})

test('an ending cut short by another tag is rejected, and partial tags never end the decision early', () => {
  const cut = new NarratorOutput()
  cut.push(`<decision>chance: 60, cleverness: 3</decision><survived>${SURVIVED}<died>${DIED}</died>`)
  assert.throws(() => cut.finish(), /survival ending/)

  // A tag split across chunks ("<survived" + "_x>") is not one of ours and must not cut the decision short.
  const split = new NarratorOutput()
  assert.equal(split.push('<decision>chance: 60'), null)
  assert.equal(split.push(', cleverness: 3 <survived'), null)
  assert.deepEqual(split.push('</decision>'), { chance: 0.6, cleverness: 3 })

  // Only the very last ending may be missing its closing tag (the stream simply ended).
  const open = new NarratorOutput()
  open.push(`<decision>chance: 60, cleverness: 3</decision><survived>${SURVIVED}</survived><died>${DIED}`)
  assert.equal(open.finish().stories.died, DIED)
})
