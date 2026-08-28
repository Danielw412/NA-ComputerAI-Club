/**
 * Camera + PoseLandmarker + the rAF inference loop.
 *
 * Framework-agnostic on purpose: the React layer just starts it, stops it, and
 * reads frames. Nothing here knows about game modes.
 *
 * Everything loads from vendored relative paths under /public — no CDN at
 * runtime, so this works on venue wifi or fully offline.
 */
import {
  FilesetResolver,
  PoseLandmarker,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision'
import {
  computePoseMetrics,
  INVALID_METRICS,
  ScaleRatioEstimator,
  type GeometryOptions,
  type PoseMetrics,
  type ShoulderReference,
} from './landmarks'

export const WASM_PATH = '/mediapipe/wasm'
export const MODEL_PATH = '/models/pose_landmarker_lite.task'

/** Above this measured inference cost we process every other camera frame. */
const INFERENCE_BUDGET_MS = 40

export interface PoseSample {
  landmarks: NormalizedLandmark[]
  metrics: PoseMetrics
}

export interface TrackerFrame {
  /** performance.now() at inference time. */
  tMs: number
  /** Poses sorted left-to-right AS THE PLAYERS SEE THEMSELVES (mirrored). */
  poses: PoseSample[]
  fps: number
  inferenceMs: number
  /** Camera frames deliberately dropped to protect the frame rate. */
  droppedFrames: number
}

export type FrameHandler = (frame: TrackerFrame) => void

export type TrackerStatus = 'idle' | 'starting' | 'running' | 'error'

export interface TrackerOptions {
  minVisibility: number
  reference: ShoulderReference
  numPoses: number
  /**
   * Fraction of the camera resolution actually fed to the model.
   *
   * The <video> keeps its full 1280x720 for display; inference runs on a
   * downscaled copy drawn into an offscreen canvas. Landmarks come back in
   * normalized 0..1 coordinates either way, so nothing downstream changes.
   *
   * 1.0 = feed the full frame. 0.5 = 640x360, which is still comfortably above
   * the lite model's 256x256 internal input, so landmark quality is unaffected
   * while the per-frame texture upload shrinks 4x.
   */
  inferenceScale: number
}

export const DEFAULT_TRACKER_OPTIONS: TrackerOptions = {
  minVisibility: 0.5,
  reference: 'sameSide',
  numPoses: 2,
  inferenceScale: 0.5,
}

export class PoseTracker {
  readonly video: HTMLVideoElement
  status: TrackerStatus = 'idle'
  error: string | null = null
  /** Camera resolution actually granted, for diagnostics. */
  displayWidth = 0
  displayHeight = 0
  inferenceWidth = 0
  inferenceHeight = 0

  private landmarker: PoseLandmarker | null = null
  private stream: MediaStream | null = null
  private rafId = 0
  private onFrame: FrameHandler | null = null
  private opts: TrackerOptions = { ...DEFAULT_TRACKER_OPTIONS }

  /** Offscreen downscale target for inference. */
  private infCanvas: HTMLCanvasElement
  private infCtx: CanvasRenderingContext2D | null = null
  /** One scale estimator per player slot, so a close-up player stays trackable. */
  private scaleRatios = [new ScaleRatioEstimator(), new ScaleRatioEstimator()]

  private lastVideoTime = -1
  private lastFrameAt = 0
  private fpsEma = 0
  private inferenceEma = 0
  private droppedFrames = 0
  private frameParity = 0

  constructor() {
    this.video = document.createElement('video')
    this.video.playsInline = true
    this.video.muted = true
    this.video.autoplay = true
    this.infCanvas = document.createElement('canvas')
  }

  setOptions(opts: Partial<TrackerOptions>): void {
    const prevPoses = this.opts.numPoses
    this.opts = { ...this.opts, ...opts }
    if (this.landmarker && this.opts.numPoses !== prevPoses) {
      void this.landmarker.setOptions({ numPoses: this.opts.numPoses })
    }
  }

  /** Warm the model without turning on the camera. Safe to call repeatedly. */
  async preload(): Promise<void> {
    if (this.landmarker) return
    const fileset = await FilesetResolver.forVisionTasks(WASM_PATH)
    this.landmarker = await PoseLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: MODEL_PATH,
        // WebGL, not WebGPU — MediaPipe's web vision tasks do not support WebGPU.
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numPoses: this.opts.numPoses,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputSegmentationMasks: false,
    })
  }

  async start(onFrame: FrameHandler): Promise<void> {
    if (this.status === 'running' || this.status === 'starting') return
    this.status = 'starting'
    this.error = null
    this.onFrame = onFrame

    try {
      await this.preload()
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: 1280,
          height: 720,
          frameRate: { ideal: 60, min: 30 },
        },
        audio: false,
      })
      this.video.srcObject = this.stream
      await this.video.play()
      this.resetCounters()
      this.status = 'running'
      this.rafId = requestAnimationFrame(this.loop)
    } catch (err) {
      this.status = 'error'
      this.error = describeCameraError(err)
      this.stopStream()
      throw err
    }
  }

  private resetCounters(): void {
    this.lastVideoTime = -1
    this.lastFrameAt = 0
    this.fpsEma = 0
    this.inferenceEma = 0
    this.droppedFrames = 0
    this.scaleRatios.forEach((r) => r.reset())
  }

  /** Stops the camera and the loop. Keeps the loaded model for a fast restart. */
  stop(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
    this.onFrame = null
    this.stopStream()
    if (this.status !== 'error') this.status = 'idle'
  }

  /** Full teardown, including the model. */
  dispose(): void {
    this.stop()
    this.landmarker?.close()
    this.landmarker = null
  }

  private stopStream(): void {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.video.srcObject = null
  }

  /**
   * Returns what the model should look at: either the video itself, or a
   * downscaled copy. Display quality is untouched either way.
   */
  private inferenceSource(): HTMLVideoElement | HTMLCanvasElement {
    const video = this.video
    const scale = this.opts.inferenceScale
    if (scale >= 0.999) {
      this.inferenceWidth = video.videoWidth
      this.inferenceHeight = video.videoHeight
      return video
    }
    const w = Math.max(64, Math.round(video.videoWidth * scale))
    const h = Math.max(64, Math.round(video.videoHeight * scale))
    if (this.infCanvas.width !== w || this.infCanvas.height !== h) {
      this.infCanvas.width = w
      this.infCanvas.height = h
      this.infCtx = this.infCanvas.getContext('2d', { willReadFrequently: false })
    }
    if (!this.infCtx) return video
    this.infCtx.drawImage(video, 0, 0, w, h)
    this.inferenceWidth = w
    this.inferenceHeight = h
    return this.infCanvas
  }

  private loop = (): void => {
    if (this.status !== 'running') return
    this.rafId = requestAnimationFrame(this.loop)

    const video = this.video
    const landmarker = this.landmarker
    if (!landmarker || video.readyState < 2 || !video.videoWidth) return

    this.displayWidth = video.videoWidth
    this.displayHeight = video.videoHeight

    // Guard: never run inference twice on the same camera frame. MediaPipe
    // rejects non-monotonic timestamps and it would be wasted work anyway.
    if (video.currentTime === this.lastVideoTime) return
    this.lastVideoTime = video.currentTime

    // Falling behind: drop this camera frame rather than let inference pile up
    // and starve rendering.
    this.frameParity ^= 1
    if (this.inferenceEma > INFERENCE_BUDGET_MS && this.frameParity === 0) {
      this.droppedFrames++
      return
    }

    const now = performance.now()
    if (this.lastFrameAt > 0) {
      const dt = now - this.lastFrameAt
      if (dt > 0) {
        const inst = 1000 / dt
        this.fpsEma = this.fpsEma === 0 ? inst : this.fpsEma * 0.9 + inst * 0.1
      }
    }
    this.lastFrameAt = now

    const source = this.inferenceSource()
    const t0 = performance.now()
    // Timestamps must increase monotonically; performance.now() guarantees it,
    // video.currentTime does not (it can repeat across seeks/stalls).
    const result = landmarker.detectForVideo(source, now)
    const cost = performance.now() - t0
    this.inferenceEma = this.inferenceEma === 0 ? cost : this.inferenceEma * 0.8 + cost * 0.2

    // Aspect is identical for video and the downscaled copy, so `h` is unchanged.
    const aspect = video.videoWidth / video.videoHeight
    const geo: GeometryOptions = {
      minVisibility: this.opts.minVisibility,
      reference: this.opts.reference,
    }
    const poses: PoseSample[] = (result.landmarks ?? []).map((landmarks, i) => ({
      landmarks,
      metrics: landmarks
        ? computePoseMetrics(landmarks, aspect, geo, this.scaleRatios[i])
        : INVALID_METRICS,
    }))

    // Re-sort every frame so player assignment survives people shuffling around.
    poses.sort((a, b) => a.metrics.screenX - b.metrics.screenX)

    this.onFrame?.({
      tMs: now,
      poses,
      fps: this.fpsEma,
      inferenceMs: this.inferenceEma,
      droppedFrames: this.droppedFrames,
    })
  }
}

function describeCameraError(err: unknown): string {
  const name = (err as { name?: string })?.name
  switch (name) {
    case 'NotAllowedError':
      return 'Camera permission denied. Allow camera access and reload.'
    case 'NotFoundError':
      return 'No camera found. Plug one in and reload.'
    case 'NotReadableError':
      return 'Camera is in use by another app. Close it (Zoom, Photo Booth) and retry.'
    default:
      return (err as Error)?.message ?? 'Could not start the camera.'
  }
}
