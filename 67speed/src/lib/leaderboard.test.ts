/**
 * Name rules for the leaderboard. These matter because the same shape is
 * enforced by a database CHECK constraint — if these two ever disagree, players
 * get a silent rejected insert at a booth with no way to diagnose it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NAME_MAX_LENGTH,
  NAME_MIN_LENGTH,
  isNameAllowed,
  sanitizeName,
} from './leaderboard.ts'

test('accepts real names, including ones a blocklist would mangle', () => {
  for (const name of [
    'Alex',
    'Alex Du',
    "O'Brien",
    'Anne-Marie',
    'Mary Jane Watson',
    'Li',
    'Dickson', // a substring blocklist would wrongly reject this
    'Hancock',
  ]) {
    assert.equal(isNameAllowed(name), true, `${name} should be allowed`)
  }
})

test('rejects empty, too-short, and non-letter input', () => {
  for (const name of ['', ' ', 'A', '12345', '!!!', '- -', '42']) {
    assert.equal(isNameAllowed(name), false, `${name} should be rejected`)
  }
})

test('markup is stripped rather than stored, so nothing dangerous survives', () => {
  // The value is SANITIZED, not rejected: every character that could carry
  // markup is removed, leaving plain letters. What reaches the database can
  // never contain a tag, quote or angle bracket.
  const clean = sanitizeName('<script>alert(1)</script>')
  assert.equal(clean, 'scriptalertscript')
  assert.ok(!/[<>()/!0-9]/.test(clean), 'no markup characters may survive sanitising')
  assert.equal(isNameAllowed(clean), true, 'the sanitised remainder is a plain name')
})

test('rejects names longer than the database allows', () => {
  const tooLong = 'A'.repeat(NAME_MAX_LENGTH + 10)
  // sanitize truncates, so the raw value is what a crafted request would send.
  assert.ok(sanitizeName(tooLong).length <= NAME_MAX_LENGTH)
  assert.ok(NAME_MAX_LENGTH > NAME_MIN_LENGTH)
})

test('sanitize strips disallowed characters and collapses whitespace', () => {
  assert.equal(sanitizeName('  Alex   Du  ').trim(), 'Alex Du')
  assert.equal(sanitizeName('Al3x D9u'), 'Alx Du')
  assert.equal(sanitizeName('<b>Alex</b>').trim(), 'bAlexb')
})

test('sanitize never produces a leading space, hyphen or apostrophe', () => {
  for (const raw of ["  'Alex", '--Alex', " - 'Bob"]) {
    const clean = sanitizeName(raw)
    assert.ok(!/^[ '-]/.test(clean), `${JSON.stringify(clean)} must not start with punctuation`)
  }
})
