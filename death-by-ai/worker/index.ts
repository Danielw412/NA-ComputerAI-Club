import { cleanText, LIMITS } from '../shared/protocol.ts'
import { bearer, issueSession, passwordMatches, verifySession } from './auth.ts'
import { socketCredential } from './credentials.ts'
import type { Env } from './env.ts'
import { SCENARIO_GROUPS } from './scenarios.ts'

export { GameRoom } from './room.ts'

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}

function fail(status: number, error: string): Response {
  return json({ error }, status)
}

const BODY_LIMIT = 4096

/** Reads a small JSON body, counting bytes as they stream in. Null means too large. */
async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.body) return {}
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > BODY_LIMIT) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const TOO_LARGE = 'That request is too large.'

function newCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 900_000
  return String(100_000 + n)
}

function room(env: Env, code: string) {
  return env.ROOMS.get(env.ROOMS.idFromName(code))
}

async function login(request: Request, env: Env): Promise<Response> {
  if (!env.HOST_PASSWORD) {
    return fail(503, 'Hosting is not set up yet. Add the HOST_PASSWORD secret to the Worker.')
  }
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local'
  const gate = await env.LOGIN_LIMITER?.limit({ key: `login:${ip}` })
  if (gate && !gate.success) return fail(429, 'Too many attempts. Wait a minute and try again.')

  const body = await readJson(request)
  if (!body) return fail(413, TOO_LARGE)
  const { password } = body
  if (typeof password !== 'string' || !(await passwordMatches(env, password))) {
    return fail(401, 'That password is not right.')
  }
  return json(await issueSession(env))
}

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  const { pathname } = url
  const method = request.method

  if (pathname === '/api/host/login' && method === 'POST') return login(request, env)

  if (pathname === '/api/host/session' && method === 'GET') {
    const expiresAt = await verifySession(env, bearer(request))
    return expiresAt ? json({ expiresAt }) : fail(401, 'Sign in again to host.')
  }

  if (pathname === '/api/scenarios' && method === 'GET') {
    if (!(await verifySession(env, bearer(request)))) return fail(401, 'Sign in again to host.')
    return json({ groups: SCENARIO_GROUPS })
  }

  if (pathname === '/api/rooms' && method === 'POST') {
    if (!(await verifySession(env, bearer(request)))) return fail(401, 'Sign in again to host.')
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = newCode()
      if (await room(env, code).create(code)) return json({ code })
    }
    return fail(503, 'Could not find a free game code. Try again.')
  }

  const match = pathname.match(/^\/api\/rooms\/(\d{6})(\/join|\/socket)?$/)
  if (!match) return fail(404, 'Not found.')
  const [, code, action] = match
  const stub = room(env, code)

  if (!action && method === 'GET') return json(await stub.peek())

  if (action === '/join' && method === 'POST') {
    const body = await readJson(request)
    if (!body) return fail(413, TOO_LARGE)
    const result = await stub.join(cleanText(body.name, LIMITS.nameLength))
    return 'error' in result ? fail(result.status, result.error) : json(result)
  }

  if (action === '/socket' && method === 'GET') {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return fail(426, 'Expected a WebSocket upgrade.')
    }
    // X-Host-Exp is only ever set here, after the session is verified.
    const headers = new Headers(request.headers)
    headers.delete('X-Host-Exp')
    if (url.searchParams.get('role') === 'host') {
      const expiresAt = await verifySession(env, socketCredential(request))
      if (!expiresAt) return fail(401, 'Sign in again to host.')
      headers.set('X-Host-Exp', String(expiresAt))
    }
    return stub.fetch(new Request(request, { headers }))
  }

  return fail(405, 'Method not allowed.')
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request)
    try {
      return await route(request, env, url)
    } catch (error) {
      console.error('request failed', url.pathname, error)
      return fail(500, 'The server hit an error. Try again.')
    }
  },
} satisfies ExportedHandler<Env>
