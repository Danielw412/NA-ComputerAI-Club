import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanText, formatCode, LIMITS, normalizePicks, pointsFor } from '../shared/protocol.ts'

test('cleanText collapses whitespace, strips control and bidi characters, and caps length', () => {
  assert.equal(cleanText('  hold   my\n\nbreath  ', 50), 'hold my breath')
  assert.equal(cleanText('a\u0007b‮c​d', 50), 'abcd')
  assert.equal(cleanText('abcdef', 3), 'abc')
  assert.equal(cleanText(42, 10), '')
})

test('cleanText never splits an emoji in half', () => {
  const out = cleanText('🛟🛟🛟', 2)
  assert.equal(out, '🛟🛟')
  assert.equal(Array.from(out).length, 2)
})

test('formatCode groups six digits', () => {
  assert.equal(formatCode('482913'), '482 913')
  assert.equal(formatCode('12'), '12')
})

test('points reward survival and cleverness', () => {
  assert.equal(pointsFor(false, 5), 0)
  assert.equal(pointsFor(true, 1), 110)
  assert.equal(pointsFor(true, 5), 150)
})

test('normalizePicks cleans, dedupes and caps the host picks', () => {
  const picks = normalizePicks([42, null, '  A  rogue\u0007 bot. ', 'A rogue bot.', '', ...'bcdefghij'.split('')])
  assert.equal(picks[0], 'A rogue bot.')
  assert.equal(picks.length, LIMITS.scenarioPicks)
  assert.equal(new Set(picks).size, picks.length)
  assert.equal(Array.from(normalizePicks(['x'.repeat(500)])[0]).length, LIMITS.scenarioLength)
})
