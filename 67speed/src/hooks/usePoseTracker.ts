/**
 * React binding for PoseTracker.
 *
 * Deliberately does NOT setState per frame — the frame handler writes to refs
 * and draws to the canvas directly, and React state is published on a throttle
 * (or immediately when a rep lands, so the counter never feels laggy).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  PoseTracker,
  type TrackerFrame,
  type TrackerOptions,
  type TrackerStatus,
} from '../lib/pose/tracker'
import {
  PlayerRepCounter,
  type RepConfig,
  type RepEvent,
  type WristDebug,
} from '../lib/pose/repCounter'
import type { ScaleSource, WristSide } from '../lib/pose/landmarks'
import { drawSkeleton, GOLD, type OverlayStyle } from '../lib/pose/overlay'
import {
  loadRepConfig,
  loadTrackerOptions,
  saveRepConfig,
  saveTrackerOptions,
} from '../lib/config'

const PUBLISH_INTERVAL_MS = 80
/** How much history the dev-panel trace graph keeps. */
const TRACE_MS = 5000

export interface PlayerSnapshot {
  count: number
  left: WristDebug
  right: WristDebug
  scale: number
  scaleSource: ScaleSource
  screenX: number
  valid: boolean
}

export interface TrackerSnapshot {
  fps: number
  inferenceMs: number
  poseCount: number
  droppedFrames: number
  displayRes: string
  inferenceRes: string
  players: PlayerSnapshot[]
}

const EMPTY_SNAPSHOT: TrackerSnapshot = {
  fps: 0,
  inferenceMs: 0,
  poseCount: 0,
  droppedFrames: 0,
  displayRes: '—',
  inferenceRes: '—',
  players: [],
}

export interface TracePoint {
  t: number
  h: number
  up: number
  down: number
  armed: boolean
  rep: boolean
}

export type Traces = Record<WristSide, TracePoint[]>

/**
 * Per-frame callback for game logic. Fires at full frame rate and must NOT
 * setState — it exists so the game clock and phase gates can run without
 * re-rendering React 60 times a second.
 */
export interface GameFrame {
  tMs: number
  players: PlayerSnapshot[]
  poseCount: number
  repsThisFrame: number
}
export type FrameObserver = (frame: GameFrame) => void

export interface UsePoseTracker {
  status: TrackerStatus
  error: string | null
  snapshot: TrackerSnapshot
  config: RepConfig
  setConfig: (patch: Partial<RepConfig>) => void
  trackerOptions: TrackerOptions
  setTrackerOptions: (patch: Partial<TrackerOptions>) => void
  /** Resolves true when the camera is live, false if it could not start. */
  start: () => Promise<boolean>
  stop: () => void
  resetCounters: () => void
  getTimelines: () => RepEvent[][]
  /** Subscribe to raw frames for game logic. Returns an unsubscribe function. */
  subscribeFrames: (fn: FrameObserver) => () => void
  /** Clear scores but keep each wrist's learned range of motion. */
  resetScoresKeepCalibration: () => void
  /** Live per-wrist history for the dev panel graph. Player 0 only. */
  getTraces: () => Traces
  mountRef: (el: HTMLDivElement | null) => void
  canvasRef: React.RefObject<HTMLCanvasElement | null>
}

export function usePoseTracker(maxPlayers = 2): UsePoseTracker {
  const trackerRef = useRef<PoseTracker | null>(null)
  if (trackerRef.current === null) trackerRef.current = new PoseTracker()
  const tracker = trackerRef.current

  const countersRef = useRef<PlayerRepCounter[]>([])
  if (countersRef.current.length !== maxPlayers) {
    countersRef.current = Array.from({ length: maxPlayers }, () => new PlayerRepCounter())
  }

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const configRef = useRef<RepConfig>(loadRepConfig())
  const optionsRef = useRef<TrackerOptions>(loadTrackerOptions())
  const runStartRef = useRef<number>(0)
  const lastPublishRef = useRef<number>(0)
  const tracesRef = useRef<Traces>({ left: [], right: [] })
  const observersRef = useRef<Set<FrameObserver>>(new Set())

  const [config, setConfigState] = useState<RepConfig>(configRef.current)
  const [trackerOptions, setTrackerOptionsState] = useState<TrackerOptions>(optionsRef.current)
  const [status, setStatus] = useState<TrackerStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<TrackerSnapshot>(EMPTY_SNAPSHOT)

  // Apply persisted tracker options before the first frame.
  useEffect(() => {
    tracker.setOptions(optionsRef.current)
  }, [tracker])

  const setConfig = useCallback((patch: Partial<RepConfig>) => {
    const next = { ...configRef.current, ...patch }
    configRef.current = next
    saveRepConfig(next)
    setConfigState(next)
  }, [])

  const setTrackerOptions = useCallback(
    (patch: Partial<TrackerOptions>) => {
      const next = { ...optionsRef.current, ...patch }
      optionsRef.current = next
      saveTrackerOptions(next)
      tracker.setOptions(next)
      setTrackerOptionsState(next)
    },
    [tracker],
  )

  const handleFrame = useCallback(
    (frame: TrackerFrame) => {
      const cfg = configRef.current
      const counters = countersRef.current
      if (runStartRef.current === 0) runStartRef.current = frame.tMs
      const t = frame.tMs - runStartRef.current

      let repsThisFrame = 0
      const players: PlayerSnapshot[] = []
      for (let i = 0; i < counters.length; i++) {
        const pose = frame.poses[i]
        const counter = counters[i]
        let added = 0
        if (pose) added = counter.update(pose.metrics, t, cfg)
        repsThisFrame += added
        players.push({
          count: counter.count,
          left: counter.debug('left'),
          right: counter.debug('right'),
          scale: pose?.metrics.scale ?? 0,
          scaleSource: pose?.metrics.scaleSource ?? 'none',
          screenX: pose?.metrics.screenX ?? 0,
          valid: pose?.metrics.valid ?? false,
        })
      }

      // Trace history for player 1, used by the dev panel graph.
      const p0 = players[0]
      if (p0) {
        for (const side of ['left', 'right'] as const) {
          const w = p0[side]
          const buf = tracesRef.current[side]
          buf.push({
            t,
            h: w.h,
            up: w.up,
            down: w.down,
            armed: w.armed,
            rep: false,
          })
          while (buf.length && t - buf[0].t > TRACE_MS) buf.shift()
        }
      }
      if (repsThisFrame > 0 && p0) {
        for (const side of ['left', 'right'] as const) {
          const buf = tracesRef.current[side]
          const last = buf[buf.length - 1]
          if (last && p0[side].state === 'down') last.rep = true
        }
      }

      const canvas = canvasRef.current
      if (canvas) {
        const video = tracker.video
        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
          canvas.width = video.videoWidth
          canvas.height = video.videoHeight
        }
        const ctx = canvas.getContext('2d')
        if (ctx) {
          const styles: OverlayStyle[] = frame.poses.map((_, i) => ({
            color: GOLD,
            activeWrists: {
              left: counters[i]?.debug('left').state === 'up',
              right: counters[i]?.debug('right').state === 'up',
            },
          }))
          drawSkeleton(ctx, frame.poses, canvas.width, canvas.height, styles)
        }
      }

      // Game logic runs every frame, before the throttled React publish.
      if (observersRef.current.size) {
        const gameFrame: GameFrame = {
          tMs: frame.tMs,
          players,
          poseCount: frame.poses.length,
          repsThisFrame,
        }
        for (const fn of observersRef.current) fn(gameFrame)
      }

      const now = frame.tMs
      if (repsThisFrame > 0 || now - lastPublishRef.current >= PUBLISH_INTERVAL_MS) {
        lastPublishRef.current = now
        setSnapshot({
          fps: frame.fps,
          inferenceMs: frame.inferenceMs,
          poseCount: frame.poses.length,
          droppedFrames: frame.droppedFrames,
          displayRes: `${tracker.displayWidth}x${tracker.displayHeight}`,
          inferenceRes: `${tracker.inferenceWidth}x${tracker.inferenceHeight}`,
          players,
        })
      }
    },
    [tracker],
  )

  const resetCounters = useCallback(() => {
    countersRef.current.forEach((c) => c.reset())
    tracesRef.current = { left: [], right: [] }
    runStartRef.current = 0
  }, [])

  const start = useCallback(async (): Promise<boolean> => {
    setError(null)
    setStatus('starting')
    try {
      resetCounters()
      tracker.setOptions(optionsRef.current)
      await tracker.start(handleFrame)
      setStatus('running')
      return true
    } catch (err) {
      setStatus('error')
      setError(tracker.error ?? (err as Error).message)
      return false
    }
  }, [tracker, handleFrame, resetCounters])

  const stop = useCallback(() => {
    tracker.stop()
    setStatus('idle')
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height)
    setSnapshot(EMPTY_SNAPSHOT)
  }, [tracker])

  const mountRef = useCallback(
    (el: HTMLDivElement | null) => {
      const video = tracker.video
      if (el && video.parentElement !== el) {
        video.className = 'absolute inset-0 h-full w-full object-cover'
        el.appendChild(video)
      }
    },
    [tracker],
  )

  const getTimelines = useCallback(() => countersRef.current.map((c) => c.timeline), [])

  const subscribeFrames = useCallback((fn: FrameObserver) => {
    observersRef.current.add(fn)
    return () => {
      observersRef.current.delete(fn)
    }
  }, [])

  const resetScoresKeepCalibration = useCallback(() => {
    countersRef.current.forEach((c) => c.resetScoresKeepCalibration())
    tracesRef.current = { left: [], right: [] }
  }, [])
  const getTraces = useCallback(() => tracesRef.current, [])

  useEffect(() => () => tracker.dispose(), [tracker])

  return {
    status,
    error,
    snapshot,
    config,
    setConfig,
    trackerOptions,
    setTrackerOptions,
    start,
    stop,
    resetCounters,
    getTimelines,
    subscribeFrames,
    resetScoresKeepCalibration,
    getTraces,
    mountRef,
    canvasRef,
  }
}
