/**
 * Socket credentials travel in the WebSocket subprotocol list
 * (`exit-code, auth.<credential>`) rather than the URL, so they never land in
 * request logs. Hosts send their session token; players send `<id>.<token>`.
 */
const PREFIX = 'auth.'

export function socketCredential(request: Request): string {
  const header = request.headers.get('Sec-WebSocket-Protocol') ?? ''
  for (const part of header.split(',')) {
    const value = part.trim()
    if (value.startsWith(PREFIX)) return value.slice(PREFIX.length)
  }
  return ''
}
