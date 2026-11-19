import { useCallback, useEffect, useRef, useState } from 'react'
import type { HostMessage, PlayerMessage, RoomView, ServerMessage } from '../../shared/protocol.ts'
import type { SocketTarget } from './api.ts'

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting'
export type Ended = 'kicked' | 'closed' | 'expired'

export interface RoomConnection {
  room: RoomView | null
  status: ConnectionStatus
  ended: Ended | null
  /** Best estimate of serverNow − Date.now(), so countdowns match the server clock. */
  clockOffset: number
  /** False when the message could not be sent (socket not open). */
  send: (message: HostMessage | PlayerMessage) => boolean
}

const PING_EVERY_MS = 15_000
/** No pong within this long means the socket is dead even if it looks open. */
const PONG_DEADLINE_MS = 4_000

function apply(room: RoomView | null, message: ServerMessage): RoomView | null {
  if (message.t === 'state') return message.state
  if (!room || !('id' in message)) return room
  const outcome = room.outcomes[message.id]
  if (!outcome) return room
  let next = outcome
  if (message.t === 'delta') next = { ...outcome, reasoning: outcome.reasoning + message.text }
  else if (message.t === 'reset') next = { ...outcome, reasoning: '', story: '', narratorDecision: null, judgeDecision: null }
  else if (message.t === 'stage') next = { ...outcome, stage: message.stage }
  else if (message.t === 'decision') next = { ...outcome, judgeDecision: message.decision }
  return { ...room, outcomes: { ...room.outcomes, [message.id]: next } }
}

/**
 * Keeps one WebSocket to a room open, reconnecting with backoff and replacing
 * sockets that stop answering pings. Messages are applied once per animation
 * frame, so a burst of reasoning deltas from many players costs one render.
 */
export function useRoom(target: SocketTarget | null): RoomConnection {
  const url = target?.url ?? null
  const credential = target?.credential ?? ''
  const [room, setRoom] = useState<RoomView | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [ended, setEnded] = useState<Ended | null>(null)
  const [clockOffset, setClockOffset] = useState(0)
  const socketRef = useRef<WebSocket | null>(null)
  const readyRef = useRef(false)

  useEffect(() => {
    if (!url) return
    let socket: WebSocket | null = null
    let retry = 0
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let pingTimer: ReturnType<typeof setInterval> | undefined
    let pongTimer: ReturnType<typeof setTimeout> | undefined
    let drainTimer: ReturnType<typeof setTimeout> | undefined
    let frame = 0
    let queue: ServerMessage[] = []
    let stopped = false
    // The least-delayed snapshot gives the best clock estimate: delay only ever lowers it.
    let bestOffset = Number.NEGATIVE_INFINITY

    const drain = () => {
      frame = 0
      drainTimer = undefined
      const batch = queue
      queue = []
      setRoom((current) => batch.reduce(apply, current))
    }

    const scheduleDrain = () => {
      if (frame || drainTimer) return
      // Hidden tabs pause animation frames, so fall back to a timer there.
      if (document.hidden) drainTimer = setTimeout(drain, 300)
      else frame = requestAnimationFrame(drain)
    }

    const ping = () => {
      if (socket?.readyState !== WebSocket.OPEN || pongTimer) return
      socket.send('ping')
      pongTimer = setTimeout(() => socket?.close(), PONG_DEADLINE_MS)
    }

    const connect = () => {
      if (stopped) return
      readyRef.current = false
      const current = new WebSocket(url, ['exit-code', `auth.${credential}`])
      socket = current
      socketRef.current = current

      current.onopen = () => {
        retry = 0
        clearInterval(pingTimer)
        pingTimer = setInterval(ping, PING_EVERY_MS)
      }

      current.onmessage = (event) => {
        if (typeof event.data !== 'string') return
        if (event.data === 'pong') {
          clearTimeout(pongTimer)
          pongTimer = undefined
          return
        }
        let message: ServerMessage
        try {
          message = JSON.parse(event.data) as ServerMessage
        } catch {
          return
        }
        if (message.t === 'bye') {
          stopped = true
          setEnded(message.reason)
          return
        }
        if (message.t === 'state') {
          const sample = message.state.serverNow - Date.now()
          if (sample > bestOffset) {
            bestOffset = sample
            setClockOffset(sample)
          }
          // A snapshot supersedes everything queued before it.
          queue = []
          if (socketRef.current === current && !readyRef.current) {
            readyRef.current = true
            setStatus('open')
          }
        }
        queue.push(message)
        scheduleDrain()
      }

      current.onclose = () => {
        // The refs are shared across effect runs (StrictMode mounts twice), so only
        // the socket that currently owns them may clear them.
        if (socketRef.current === current) {
          socketRef.current = null
          readyRef.current = false
        }
        if (stopped || socket !== current) return
        clearInterval(pingTimer)
        clearTimeout(pongTimer)
        pongTimer = undefined
        setStatus('reconnecting')
        const delay = Math.min(5_000, 400 * 2 ** retry) + Math.random() * 300
        retry += 1
        retryTimer = setTimeout(connect, delay)
      }
    }

    // Phones drop or silently stall sockets when the screen locks; check as soon as it's back.
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || stopped) return
      if (queue.length) {
        clearTimeout(drainTimer)
        drainTimer = undefined
        drain()
      }
      if (!socket || socket.readyState === WebSocket.CLOSED) {
        clearTimeout(retryTimer)
        connect()
      } else {
        ping()
      }
    }

    setStatus('connecting')
    setEnded(null)
    connect()
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      stopped = true
      document.removeEventListener('visibilitychange', onVisible)
      clearTimeout(retryTimer)
      clearInterval(pingTimer)
      clearTimeout(pongTimer)
      clearTimeout(drainTimer)
      cancelAnimationFrame(frame)
      if (socket && socketRef.current === socket) {
        socketRef.current = null
        readyRef.current = false
      }
      socket?.close()
      setRoom(null)
    }
  }, [url, credential])

  const send = useCallback((message: HostMessage | PlayerMessage) => {
    const socket = socketRef.current
    if (socket?.readyState !== WebSocket.OPEN || !readyRef.current) return false
    socket.send(JSON.stringify(message))
    return true
  }, [])

  return { room, status, ended, clockOffset, send }
}
