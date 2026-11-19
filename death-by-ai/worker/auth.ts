/**
 * Host sign-in. Hosts type the HOST_PASSWORD secret once and receive a signed,
 * expiring session token. The signing key is derived from the password, so
 * rotating the secret signs every host out.
 */
import type { Env } from './env.ts'
import { intVar } from './env.ts'

const encoder = new TextEncoder()

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', encoder.encode(text))
}

/**
 * The key covers the password, so changing it signs every host out. The
 * optional HOST_SESSION_SECRET adds random key material, so a leaked token
 * can't be used to test password guesses offline.
 */
function signingKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(`exit-code/host-session/${env.HOST_SESSION_SECRET ?? ''}/${env.HOST_PASSWORD ?? ''}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

export async function passwordMatches(env: Env, attempt: string): Promise<boolean> {
  if (!env.HOST_PASSWORD) return false
  // Hash both sides so the comparison is constant-time and length-independent.
  const [a, b] = await Promise.all([sha256(attempt), sha256(env.HOST_PASSWORD)])
  return crypto.subtle.timingSafeEqual(a, b)
}

export async function issueSession(env: Env): Promise<{ token: string; expiresAt: number }> {
  const hours = intVar(env.HOST_SESSION_HOURS, 12, 1, 24 * 30)
  const expiresAt = Date.now() + hours * 3_600_000
  const payload = toBase64Url(encoder.encode(JSON.stringify({ exp: expiresAt })))
  const key = await signingKey(env)
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)))
  return { token: `${payload}.${toBase64Url(signature)}`, expiresAt }
}

/** Returns the session expiry when the token is valid, otherwise null. */
export async function verifySession(env: Env, token: string | null | undefined): Promise<number | null> {
  if (!env.HOST_PASSWORD || !token) return null
  const [payload, signature, extra] = token.split('.')
  if (!payload || !signature || extra !== undefined) return null
  const signatureBytes = fromBase64Url(signature)
  if (!signatureBytes) return null
  const key = await signingKey(env)
  const valid = await crypto.subtle.verify('HMAC', key, signatureBytes, encoder.encode(payload))
  if (!valid) return null
  try {
    const bytes = fromBase64Url(payload)
    const { exp } = JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array())) as { exp?: unknown }
    return typeof exp === 'number' && exp > Date.now() ? exp : null
  } catch {
    return null
  }
}

export function bearer(request: Request): string | null {
  const header = request.headers.get('Authorization') ?? ''
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null
}
