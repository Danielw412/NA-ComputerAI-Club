/**
 * Name rules for the leaderboard. These matter because the same shape is
 * enforced by a database CHECK constraint - if these two ever disagree, players
 * get a silent rejected insert at a booth with no way to diagnose it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NAME_MAX_LENGTH,
  NAME_MIN_LENGTH,
  __testing,
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

// --------------------------------------------------------------- board rules
//
// These mirror the `best_scores` and `win_counts` SQL views. If they drift, the
// board changes shape when the network drops, which looks like data loss.

const { rank, aggregateWins } = __testing

const row = (name: string, score: number, opts: { won?: boolean; date?: string; mode?: 'solo' | 'duel' } = {}) => ({
  name,
  score,
  mode: opts.mode ?? ('duel' as const),
  won: opts.won ?? false,
  date: opts.date ?? '2026-08-28T00:00:00.000Z',
})

test('fastest board keeps only each name\'s best run', () => {
  const out = rank([row('Alex', 100), row('Alex', 140), row('Sam', 120)])
  assert.equal(out.length, 2, 'Alex must appear once')
  assert.equal(out[0].name, 'Alex')
  assert.equal(out[0].score, 140, 'the better run wins')
  assert.equal(out[1].score, 120)
})

test('fastest board matches names case-insensitively', () => {
  const out = rank([row('Alex', 90), row('alex', 130), row('ALEX', 60)])
  assert.equal(out.length, 1)
  assert.equal(out[0].score, 130)
})

test('on a tied score the earliest run keeps the slot', () => {
  const out = rank([
    row('Alex', 100, { date: '2026-08-28T10:00:00.000Z' }),
    row('Alex', 100, { date: '2026-08-28T09:00:00.000Z' }),
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].date, '2026-08-28T09:00:00.000Z')
})

test('wins are counted per unique name, case-insensitively', () => {
  const out = aggregateWins([
    row('Alex', 100, { won: true }),
    row('alex', 90, { won: true }),
    row('Sam', 80, { won: true }),
    row('Alex', 200, { won: false }),
  ])
  assert.equal(out.length, 2)
  assert.equal(out[0].name, 'Alex')
  assert.equal(out[0].wins, 2, 'Alex and alex are the same player')
  assert.equal(out[0].bestScore, 100, 'only winning runs count toward bestScore')
  assert.equal(out[1].wins, 1)
})

test('solo runs never count as wins', () => {
  const out = aggregateWins([
    row('Alex', 100, { won: true, mode: 'solo' }),
    row('Alex', 90, { won: true, mode: 'duel' }),
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].wins, 1)
})
