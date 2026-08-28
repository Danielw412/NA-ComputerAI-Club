/**
 * All-time leaderboard.
 *
 * Talks to Supabase over its PostgREST endpoint with plain fetch — no SDK
 * dependency, nothing extra in the bundle. If Supabase is not configured, or
 * the network is down at the venue, everything falls back to localStorage and
 * the game keeps working. A leaderboard outage must never block play.
 */
// Optional chaining so this module can be imported by the node test runner,
// where Vite has not injected import.meta.env. Harmless in the browser build.
const ENV = import.meta.env as Record<string, string | undefined> | undefined
const URL_ENV = ENV?.VITE_SUPABASE_URL
const PUBLISHABLE_KEY_ENV = ENV?.VITE_SUPABASE_PUBLISHABLE_KEY
const LEGACY_ANON_KEY_ENV = ENV?.VITE_SUPABASE_ANON_KEY
// Supabase recommends publishable keys for new browser apps. Keep the legacy
// anon-key fallback so an existing deployment can migrate without code changes.
const KEY_ENV = PUBLISHABLE_KEY_ENV ?? LEGACY_ANON_KEY_ENV

const LOCAL_KEY = 'cai67:leaderboard'
const BEST_KEY = 'cai67:personalBest'
export const TOP_N = 10
export const NAME_MIN_LENGTH = 2
export const NAME_MAX_LENGTH = 24

export type GameMode = 'solo' | 'duel'

export interface ScoreEntry {
  name: string
  score: number
  mode: GameMode
  /** True only for the winner of a duel. Solo and dead heats are false. */
  won: boolean
  /** ISO date string. */
  date: string
}

/** A row on the MOST WINS board. */
export interface WinEntry {
  name: string
  wins: number
  bestScore: number
}

export const remoteConfigured = Boolean(URL_ENV && KEY_ENV)

function headers(): Record<string, string> {
  const result: Record<string, string> = {
    apikey: KEY_ENV ?? '',
    'Content-Type': 'application/json',
  }

  // Modern sb_publishable_* keys belong only in the apikey header. Legacy anon
  // keys are JWTs, so keep the old Bearer header only for that compatibility path.
  if (!PUBLISHABLE_KEY_ENV && LEGACY_ANON_KEY_ENV) {
    result.Authorization = `Bearer ${LEGACY_ANON_KEY_ENV}`
  }

  return result
}

// ------------------------------------------------------------------ local

function readLocal(): ScoreEntry[] {
  try {
    const raw = localStorage.getItem(LOCAL_KEY)
    return raw ? (JSON.parse(raw) as ScoreEntry[]) : []
  } catch {
    return []
  }
}

function writeLocal(entries: ScoreEntry[]): void {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(entries.slice(0, 50)))
  } catch {
    /* storage disabled */
  }
}

export function personalBest(): number {
  try {
    return Number(localStorage.getItem(BEST_KEY) ?? 0)
  } catch {
    return 0
  }
}

export function setPersonalBest(score: number): void {
  try {
    if (score > personalBest()) localStorage.setItem(BEST_KEY, String(score))
  } catch {
    /* storage disabled */
  }
}

// ------------------------------------------------------------- name filter

/**
 * Full names: first name, optional last name.
 *
 * Deliberately NO profanity blocklist. With three-letter initials a blocklist
 * worked, but against free-text names substring matching is worse than useless
 * — it rejects real people (Dickson, Hancock, Cummings) while anyone determined
 * just adds a space. Alex moderates by deleting individual rows instead, which
 * is the only approach that stays correct.
 *
 * What IS enforced is shape: letters plus spaces, hyphens and apostrophes, so
 * the board can't be used to inject markup or dump a paragraph into a row. The
 * same rule exists as a database constraint, so it holds even if the UI is
 * bypassed.
 */
const NAME_PATTERN = /^[A-Za-z][A-Za-z' -]*[A-Za-z]$/

/** Trim, collapse runs of whitespace, strip disallowed characters. */
export function sanitizeName(raw: string): string {
  return raw
    .replace(/[^A-Za-z' -]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[ '-]+/, '')
    .slice(0, NAME_MAX_LENGTH)
}

export function isNameAllowed(name: string): boolean {
  const clean = sanitizeName(name).trim()
  if (clean.length < NAME_MIN_LENGTH || clean.length > NAME_MAX_LENGTH) return false
  return NAME_PATTERN.test(clean)
}

// ----------------------------------------------------------------- remote

async function fetchRemote(): Promise<ScoreEntry[]> {
  if (!remoteConfigured) return []
  const url = `${URL_ENV}/rest/v1/scores?select=name,score,mode,won,created_at&order=score.desc&limit=${TOP_N}`
  const res = await fetch(url, { headers: headers() })
  if (!res.ok) throw new Error(`leaderboard fetch failed: ${res.status}`)
  const rows = (await res.json()) as Array<{
    name: string
    score: number
    mode: GameMode
    won: boolean
    created_at: string
  }>
  return rows.map((r) => ({
    name: r.name,
    score: r.score,
    mode: r.mode,
    won: r.won ?? false,
    date: r.created_at,
  }))
}

async function submitRemote(entry: ScoreEntry): Promise<void> {
  if (!remoteConfigured) return
  const res = await fetch(`${URL_ENV}/rest/v1/scores`, {
    method: 'POST',
    headers: { ...headers(), Prefer: 'return=minimal' },
    body: JSON.stringify({
      name: entry.name,
      score: entry.score,
      mode: entry.mode,
      won: entry.won,
    }),
  })
  if (!res.ok) throw new Error(`leaderboard submit failed: ${res.status}`)
}

// ------------------------------------------------------------------ public

/**
 * Where the board came from.
 *   'remote'    — live from Supabase, the real all-time board.
 *   'offline'   — Supabase is configured but unreachable right now.
 *   'unset'     — no Supabase credentials in this build (setup state, not an
 *                 error). The UI stays quiet about this rather than telling
 *                 players the board is local when a backend is on the way.
 */
export type LeaderboardSource = 'remote' | 'offline' | 'unset'

export interface LeaderboardResult {
  entries: ScoreEntry[]
  source: LeaderboardSource
  /** True when these came from Supabase. */
  online: boolean
}

function rank(entries: ScoreEntry[]): ScoreEntry[] {
  return [...entries].sort((a, b) => b.score - a.score || a.date.localeCompare(b.date)).slice(0, TOP_N)
}

export async function getTop(): Promise<LeaderboardResult> {
  if (remoteConfigured) {
    try {
      return { entries: rank(await fetchRemote()), source: 'remote', online: true }
    } catch {
      // Supabase configured but unreachable — fall back so the booth keeps
      // running, and say so honestly.
      return { entries: rank(readLocal()), source: 'offline', online: false }
    }
  }
  return { entries: rank(readLocal()), source: 'unset', online: false }
}

/** True if `score` would place in the current top 10. */
export function qualifies(score: number, entries: ScoreEntry[]): boolean {
  if (score <= 0) return false
  if (entries.length < TOP_N) return true
  return score > entries[entries.length - 1].score
}

/**
 * MOST WINS board.
 *
 * Served by the `win_counts` view when Supabase is reachable. Offline we
 * aggregate the local rows ourselves so the board still shows something —
 * the two paths must agree on the rule: duel victories only.
 */
export async function getWins(): Promise<{ entries: WinEntry[]; source: LeaderboardSource }> {
  if (remoteConfigured) {
    try {
      const url = `${URL_ENV}/rest/v1/win_counts?select=name,wins,best_score&order=wins.desc&limit=${TOP_N}`
      const res = await fetch(url, { headers: headers() })
      if (!res.ok) throw new Error(String(res.status))
      const rows = (await res.json()) as Array<{ name: string; wins: number; best_score: number }>
      return {
        entries: rows.map((r) => ({ name: r.name, wins: r.wins, bestScore: r.best_score })),
        source: 'remote',
      }
    } catch {
      return { entries: aggregateWins(readLocal()), source: 'offline' }
    }
  }
  return { entries: aggregateWins(readLocal()), source: 'unset' }
}

function aggregateWins(entries: ScoreEntry[]): WinEntry[] {
  const byName = new Map<string, WinEntry>()
  for (const e of entries) {
    if (e.mode !== 'duel' || !e.won) continue
    const cur = byName.get(e.name)
    if (cur) {
      cur.wins++
      cur.bestScore = Math.max(cur.bestScore, e.score)
    } else {
      byName.set(e.name, { name: e.name, wins: 1, bestScore: e.score })
    }
  }
  return [...byName.values()]
    .sort((a, b) => b.wins - a.wins || b.bestScore - a.bestScore)
    .slice(0, TOP_N)
}

export async function submit(entry: ScoreEntry): Promise<{ online: boolean }> {
  // Always keep a local copy first, so an offline booth still shows a board and
  // a failed network call never loses the score.
  writeLocal([...readLocal(), entry])
  try {
    await submitRemote(entry)
    return { online: remoteConfigured }
  } catch {
    return { online: false }
  }
}
