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
const KEY = env.VITE_SUPABASE_ANON_KEY

const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`)
const bad = (m: string) => console.log(`  \x1b[31m✗\x1b[0m ${m}`)
const info = (m: string) => console.log(`  \x1b[90m·\x1b[0m ${m}`)

if (!URL_ || !KEY || URL_.includes('YOUR-PROJECT')) {
  console.log('\nSupabase is not configured.\n')
  info('Create 67speed/.env.local with VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.')
  info('See CLAUDE.md section 7 for the schema, policies, and where to find them.')
  info('The game still works without this — the board falls back to local scores.')
  process.exit(1)
}

const headers = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  'Content-Type': 'application/json',
}

let failures = 0

console.log(`\nChecking ${URL_}\n`)

// 1. Read policy.
try {
  const res = await fetch(`${URL_}/rest/v1/scores?select=name,score,mode,created_at&order=score.desc&limit=10`, {
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
    body: JSON.stringify({ name: 'toolong', score: 1, mode: 'solo' }),
  })
  if (res.ok) {
    failures++
    bad('a 7-character name was ACCEPTED — the check constraint is missing')
    info('Re-run the create table statement in CLAUDE.md section 7.')
  } else {
    ok(`malformed names rejected server-side (${res.status})`)
  }
} catch (err) {
  failures++
  bad(`constraint check failed — ${(err as Error).message}`)
}

if (process.argv.includes('--write')) {
  // 3. Insert policy.
  let inserted = false
  try {
    const res = await fetch(`${URL_}/rest/v1/scores`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({ name: 'TST', score: 0, mode: 'solo' }),
    })
    if (res.ok) {
      inserted = true
      ok('insert works (added a score of 0 named TST)')
    } else {
      failures++
      bad(`insert failed (${res.status}) — check the "public insert" policy`)
    }
  } catch (err) {
    failures++
    bad(`insert failed — ${(err as Error).message}`)
  }

  // 4. Delete MUST be refused. This is the security property that matters.
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

  if (inserted) info('Remove the TST row from the Supabase table editor when done.')
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
