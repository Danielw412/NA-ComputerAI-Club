/**
 * All-time leaderboard.
 *
 * Talks to Supabase over its PostgREST endpoint with plain fetch — no SDK
 * dependency, nothing extra in the bundle. If Supabase is not configured, or
 * the network is down at the venue, everything falls back to localStorage and
 * the game keeps working. A leaderboard outage must never block play.
 *
 * Setup instructions live in CLAUDE.md section 7.
 */
const URL_ENV = import.meta.env.VITE_SUPABASE_URL as string | undefined
const KEY_ENV = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

const LOCAL_KEY = 'cai67:leaderboard'
const BEST_KEY = 'cai67:personalBest'
export const TOP_N = 10
export const NAME_LENGTH = 3

export type GameMode = 'solo' | 'duel'

export interface ScoreEntry {
  name: string
  score: number
  mode: GameMode
  /** ISO date string. */
  date: string
}

export const remoteConfigured = Boolean(URL_ENV && KEY_ENV)

function headers(): Record<string, string> {
  return {
    apikey: KEY_ENV ?? '',
    Authorization: `Bearer ${KEY_ENV ?? ''}`,
    'Content-Type': 'application/json',
  }
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
 * Arcade initials are three characters, which is short enough that a blocklist
 * of the obvious ones is genuinely effective. Anything not A-Z is rejected
 * outright, so there is no unicode-lookalike surface to police.
 */
const BLOCKED = new Set([
  'ASS', 'FUK', 'FUC', 'FCK', 'FUX', 'SEX', 'CUM', 'TIT', 'FAG', 'FAG',
  'NIG', 'NGR', 'KKK', 'JEW', 'HOE', 'SLT', 'DIK', 'DIC', 'COK', 'CCK',
  'PUS', 'PSY', 'VAG', 'ANL', 'BUT', 'POO', 'PEE', 'WTF', 'STF', 'GAY',
  'HTL', 'NZI', 'SS0', 'RAP', 'KYS', 'DIE', 'PRN', 'XXX', 'BJ0', 'HIV',
])

export function sanitizeName(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, NAME_LENGTH)
}

export function isNameAllowed(name: string): boolean {
  const clean = sanitizeName(name)
  if (clean.length !== NAME_LENGTH) return false
  return !BLOCKED.has(clean)
}

// ----------------------------------------------------------------- remote

async function fetchRemote(): Promise<ScoreEntry[]> {
  if (!remoteConfigured) return []
  const url = `${URL_ENV}/rest/v1/scores?select=name,score,mode,created_at&order=score.desc&limit=${TOP_N}`
  const res = await fetch(url, { headers: headers() })
  if (!res.ok) throw new Error(`leaderboard fetch failed: ${res.status}`)
  const rows = (await res.json()) as Array<{
    name: string
    score: number
    mode: GameMode
    created_at: string
  }>
  return rows.map((r) => ({ name: r.name, score: r.score, mode: r.mode, date: r.created_at }))
}

async function submitRemote(entry: ScoreEntry): Promise<void> {
  if (!remoteConfigured) return
  const res = await fetch(`${URL_ENV}/rest/v1/scores`, {
    method: 'POST',
    headers: { ...headers(), Prefer: 'return=minimal' },
    body: JSON.stringify({ name: entry.name, score: entry.score, mode: entry.mode }),
  })
  if (!res.ok) throw new Error(`leaderboard submit failed: ${res.status}`)
}

// ------------------------------------------------------------------ public

export interface LeaderboardResult {
  entries: ScoreEntry[]
  /** True when these came from Supabase; false means local-only. */
  online: boolean
}

function rank(entries: ScoreEntry[]): ScoreEntry[] {
  return [...entries].sort((a, b) => b.score - a.score || a.date.localeCompare(b.date)).slice(0, TOP_N)
}

export async function getTop(): Promise<LeaderboardResult> {
  if (remoteConfigured) {
    try {
      return { entries: rank(await fetchRemote()), online: true }
    } catch {
      // Fall through to local — the booth keeps running.
    }
  }
  return { entries: rank(readLocal()), online: false }
}

/** True if `score` would place in the current top 10. */
export function qualifies(score: number, entries: ScoreEntry[]): boolean {
  if (score <= 0) return false
  if (entries.length < TOP_N) return true
  return score > entries[entries.length - 1].score
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
