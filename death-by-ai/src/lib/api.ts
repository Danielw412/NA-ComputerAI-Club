import type { HostSession, JoinResponse, ScenarioGroup } from '../../shared/protocol.ts'

export class ApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init.headers },
    })
  } catch {
    throw new ApiError('Could not reach the game server. Check your connection and try again.', 0)
  }
  const body = (await response.json().catch(() => ({}))) as { error?: string }
  if (!response.ok) throw new ApiError(body.error ?? 'Something went wrong. Try again.', response.status)
  return body as T
}

// ------------------------------------------------------------ storage

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Private mode or storage blocked: the session just won't survive a reload.
  }
}

const HOST_KEY = 'exit-code:host'
const HOST_ROOM_KEY = 'exit-code:host-room'
const seatKey = (code: string) => `exit-code:seat:${code}`

export function hostSession(): HostSession | null {
  const session = read<HostSession>(HOST_KEY)
  return session && session.expiresAt > Date.now() ? session : null
}

export function forgetHost(): void {
  write(HOST_KEY, null)
}

export function lastHostedRoom(): string | null {
  return read<string>(HOST_ROOM_KEY)
}

export function rememberHostedRoom(code: string | null): void {
  write(HOST_ROOM_KEY, code)
}

export interface Seat extends JoinResponse {
  code: string
}

export function savedSeat(code: string): Seat | null {
  return read<Seat>(seatKey(code))
}

export function forgetSeat(code: string): void {
  write(seatKey(code), null)
}

// ------------------------------------------------------------ calls

export async function signIn(password: string): Promise<HostSession> {
  const session = await request<HostSession>('/api/host/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  })
  write(HOST_KEY, session)
  return session
}

export async function createRoom(session: HostSession): Promise<string> {
  const { code } = await request<{ code: string }>('/api/rooms', {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.token}` },
  })
  rememberHostedRoom(code)
  return code
}

/** The scenarios in scenarios.txt, grouped as in the file. Host only. */
export async function fetchScenarios(session: HostSession): Promise<ScenarioGroup[]> {
  const { groups } = await request<{ groups: ScenarioGroup[] }>('/api/scenarios', {
    headers: { Authorization: `Bearer ${session.token}` },
  })
  return groups
}

export async function peekRoom(code: string): Promise<{ exists: boolean; joinable: boolean }> {
  return request(`/api/rooms/${code}`)
}

export async function joinRoom(code: string, name: string): Promise<Seat> {
  const result = await request<JoinResponse>(`/api/rooms/${code}/join`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
  const seat = { ...result, code }
  write(seatKey(code), seat)
  return seat
}

export interface SocketTarget {
  url: string
  /** Sent in the WebSocket subprotocol list, never in the URL. */
  credential: string
}

export function socketTarget(code: string, role: 'host' | 'player', credential: string): SocketTarget {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return { url: `${protocol}//${location.host}/api/rooms/${code}/socket?role=${role}`, credential }
}
