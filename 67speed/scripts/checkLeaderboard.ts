/**
 * Verifies the Supabase leaderboard wiring end to end. Run: npm run check:db
 *
 * Read test always runs. Pass --write to additionally prove that inserts are
 * allowed and that deletes are NOT — i.e. that RLS is actually protecting the
 * table rather than just appearing to.
 *
 *   npm run check:db
 *   npm run check:db -- --write
 */
import { readFileSync } from 'node:fs'

function loadEnv(path: string): Record<string, string> {
  try {
    const out: Record<string, string> = {}
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
    return out
  } catch {
    return {}
  }
}

const env = { ...loadEnv('.env.local'), ...process.env } as Record<string, string>
const URL_ = env.VITE_SUPABASE_URL
const PUBLISHABLE = env.VITE_SUPABASE_PUBLISHABLE_KEY
const LEGACY_ANON = env.VITE_SUPABASE_ANON_KEY
const KEY = PUBLISHABLE ?? LEGACY_ANON

const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`)
const bad = (m: string) => console.log(`  \x1b[31m✗\x1b[0m ${m}`)
const info = (m: string) => console.log(`  \x1b[90m·\x1b[0m ${m}`)

if (!URL_ || !KEY) {
  console.log('\nSupabase is not configured.\n')
  info('Create 67speed/.env.local with VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.')
  info('See 67speed/README.md for the full setup, schema, and policies.')
  info('The game still works without this — the board falls back to local scores.')
  process.exit(1)
}

// Publishable keys (sb_publishable_*) belong in the apikey header ONLY.
// Legacy anon keys are JWTs and additionally take Authorization: Bearer.
// This must mirror headers() in src/lib/leaderboard.ts.
const headers: Record<string, string> = {
  apikey: KEY,
  'Content-Type': 'application/json',
}
if (!PUBLISHABLE && LEGACY_ANON) headers.Authorization = `Bearer ${LEGACY_ANON}`

let failures = 0

console.log(`\nChecking ${URL_}`)
console.log(`Key type: ${PUBLISHABLE ? 'publishable (apikey only)' : 'legacy anon JWT (apikey + bearer)'}\n`)

// 1. Read policy.
try {
  const res = await fetch(`${URL_}/rest/v1/scores?select=name,score,mode,won,created_at&order=score.desc&limit=10`, {
    headers,
  })
  if (res.ok) {
    const rows = (await res.json()) as unknown[]
    ok(`read works — ${rows.length} row(s) on the board`)
  } else {
    failures++
    const body = await res.text()
    bad(`read failed (${res.status}) — ${body.slice(0, 200)}`)
    if (res.status === 404) info('Table "scores" not found. Run the SQL in CLAUDE.md section 7.')
    if (res.status === 401) info('Check the anon key, and that the "public read" policy exists.')
  }
} catch (err) {
  failures++
  bad(`read failed — ${(err as Error).message}`)
}

// 2. Constraint check: a malformed name must be rejected by the DATABASE, not
//    just by the UI, or a crafted request could put anything on the board.
try {
  const res = await fetch(`${URL_}/rest/v1/scores`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify({ name: 'N4me W1th Digits', score: 1, mode: 'solo' }),
  })
  if (res.ok) {
    failures++
    bad('a name containing digits was ACCEPTED — the check constraint is missing')
    info('Re-run the create table statement in CLAUDE.md section 7.')
  } else {
    ok(`malformed names rejected server-side (${res.status})`)
  }
} catch (err) {
  failures++
  bad(`constraint check failed — ${(err as Error).message}`)
}

// 3. Anti-farming: a solo run must never be recordable as a duel win.
//    This was a REAL hole on 2026-08-27 — the live policy accepted it — so the
//    check stays permanently. It is a rejection test, so it leaves no row.
try {
  const res = await fetch(`${URL_}/rest/v1/scores`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'return=minimal' },
    // Score 1 on purpose: if the hole is open this row IS created, and a
    // score of 1 sits harmlessly at the bottom of the board instead of
    // squatting at #1 until someone clears it by hand.
    body: JSON.stringify({ name: 'HAX', score: 1, mode: 'solo', won: true }),
  })
  if (res.ok) {
    failures++
    bad('a SOLO row with won=true was ACCEPTED — the MOST WINS board can be farmed')
    info('This check LEAVES A ROW while the hole is open (it should have been')
    info('rejected). Delete every HAX row, then re-run supabase/schema.sql to')
    info('install the scores_won_only_duel constraint, then re-run this check.')
  } else {
    ok(`fake duel wins rejected server-side (${res.status})`)
  }
} catch (err) {
  failures++
  bad(`win-farming check failed — ${(err as Error).message}`)
}

// 4. The FASTEST board reads a deduplicating view; a missing view means the
//    board falls back to nothing rather than showing duplicate names.
try {
  const res = await fetch(
    `${URL_}/rest/v1/best_scores?select=name,score,mode,won,created_at&order=score.desc&limit=5`,
    { headers },
  )
  if (res.ok) {
    const rows = (await res.json()) as Array<{ name: string }>
    const names = rows.map((r) => r.name.toLowerCase())
    const unique = new Set(names)
    if (names.length !== unique.size) {
      failures++
      bad('best_scores returned duplicate names — the view is not deduplicating')
    } else {
      ok(`best_scores view works — ${rows.length} unique name(s)`)
    }
  } else {
    failures++
    bad(`best_scores view unreadable (${res.status}) — FASTEST board will be empty`)
    info('Re-run supabase/schema.sql; it creates the view and grants select on it.')
  }
} catch (err) {
  failures++
  bad(`best_scores check failed — ${(err as Error).message}`)
}

// 5. The MOST WINS board reads a view; a missing view is a silent empty board.
try {
  const res = await fetch(`${URL_}/rest/v1/win_counts?select=name,wins,best_score&limit=5`, {
    headers,
  })
  if (res.ok) {
    const rows = (await res.json()) as unknown[]
    ok(`win_counts view works — ${rows.length} name(s) with duel wins`)
  } else {
    failures++
    bad(`win_counts view unreadable (${res.status}) — MOST WINS will show empty`)
    info('Re-run supabase/schema.sql; it creates the view and grants select on it.')
  }
} catch (err) {
  failures++
  bad(`win_counts check failed — ${(err as Error).message}`)
}

if (process.argv.includes('--write')) {
  // 6. Insert policy.
  let inserted = false
  try {
    const res = await fetch(`${URL_}/rest/v1/scores`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=minimal' },
      // A full name on purpose: this is the positive control for the name
      // rule. Checking only that BAD names are rejected let a database that
      // rejected EVERY name report itself as healthy.
      body: JSON.stringify({ name: 'Check Bot', score: 1, mode: 'solo' }),
    })
    if (res.ok) {
      inserted = true
      ok('insert works — full names accepted (added "Check Bot", score 1)')
    } else {
      failures++
      const body = await res.text()
    bad(`insert of a normal full name FAILED (${res.status})`)
    info(body.slice(0, 240))
    info('If this names a check constraint, a stale one is still on the table.')
    info('Re-run supabase/schema.sql — it drops legacy 3-letter constraints.')
    }
  } catch (err) {
    failures++
    bad(`insert failed — ${(err as Error).message}`)
  }

  // 7. Delete MUST be refused. This is the security property that matters.
  try {
    const res = await fetch(`${URL_}/rest/v1/scores?name=eq.TST`, { method: 'DELETE', headers })
    const body = await res.text()
    // PostgREST returns 2xx with zero rows affected when RLS filters everything.
    if (res.ok && body.length <= 2) {
      ok('delete is blocked by RLS (no rows removed)')
    } else if (!res.ok) {
      ok(`delete refused (${res.status})`)
    } else {
      failures++
      bad('DELETE APPEARS TO HAVE WORKED — anyone could wipe your leaderboard')
      info('Make sure you did NOT create a delete policy for the anon role.')
    }
  } catch (err) {
    failures++
    bad(`delete check failed — ${(err as Error).message}`)
  }

  if (inserted) info('Remove the "Check Bot" row from the Supabase table editor when done.')
} else {
  info('Run with --write to also test insert and confirm deletes are blocked.')
}

console.log('')
if (failures === 0) {
  console.log('\x1b[32mLeaderboard backend looks good.\x1b[0m\n')
} else {
  console.log(`\x1b[31m${failures} check(s) failed.\x1b[0m See CLAUDE.md section 7.\n`)
  process.exit(1)
}
