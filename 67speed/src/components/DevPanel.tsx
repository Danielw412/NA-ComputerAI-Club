/**
 * Hidden dev panel — toggled with "D". Diagnostics first, dials second.
 *
 * In auto mode there is deliberately nothing to tune: the trace graph is there
 * so you can SEE what each wrist is doing and why a rep did or didn't land.
 * Auto parameters are tuned offline by `npm run tune`, not by eye at a venue.
 */
import { useEffect, useRef, useState } from 'react'
import type { RepConfig, RepEvent } from '../lib/pose/repCounter'
import { DEFAULT_REP_CONFIG } from '../lib/pose/repCounter'
import type { TrackerOptions } from '../lib/pose/tracker'
import type { TrackerSnapshot, Traces } from '../hooks/usePoseTracker'
import type { WristSide } from '../lib/pose/landmarks'

interface Props {
  open: boolean
  snapshot: TrackerSnapshot
  config: RepConfig
  setConfig: (patch: Partial<RepConfig>) => void
  trackerOptions: TrackerOptions
  setTrackerOptions: (patch: Partial<TrackerOptions>) => void
  onReset: () => void
  getTimelines: () => RepEvent[][]
  getTraces: () => Traces
}

/**
 * Live trace of `h` with the (moving) thresholds drawn over it. Reading this is
 * how you diagnose a wrist that isn't counting: if the gold line never crosses
 * the upper rail, the arm isn't travelling far enough relative to its own
 * recent range; if the panel is shaded, the wrist is below autoMinRange and
 * deliberately disarmed.
 */
function TraceGraph({ side, getTraces }: { side: WristSide; getTraces: () => Traces }) {
  const ref = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const canvas = ref.current
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) return
      const pts = getTraces()[side]
      const w = canvas.width
      const h = canvas.height
      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = 'rgba(0,0,0,0.55)'
      ctx.fillRect(0, 0, w, h)
      if (pts.length < 2) return

      const t0 = pts[0].t
      const t1 = pts[pts.length - 1].t
      const span = Math.max(1, t1 - t0)
      let lo = Infinity
      let hi = -Infinity
      for (const p of pts) {
        lo = Math.min(lo, p.h, p.down)
        hi = Math.max(hi, p.h, p.up)
      }
      const pad = (hi - lo) * 0.15 || 0.1
      lo -= pad
      hi += pad
      const X = (t: number) => ((t - t0) / span) * w
      const Y = (v: number) => h - ((v - lo) / (hi - lo)) * h

      // Shade stretches where the wrist was disarmed (not moving enough).
      ctx.fillStyle = 'rgba(255,59,48,0.13)'
      for (let i = 1; i < pts.length; i++) {
        if (!pts[i].armed) ctx.fillRect(X(pts[i - 1].t), 0, Math.max(1, X(pts[i].t) - X(pts[i - 1].t)), h)
      }

      // Threshold rails.
      const rail = (key: 'up' | 'down', color: string) => {
        ctx.strokeStyle = color
        ctx.lineWidth = 1
        ctx.setLineDash([3, 3])
        ctx.beginPath()
        pts.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Y(p[key])) : ctx.moveTo(X(p.t), Y(p[key]))))
        ctx.stroke()
        ctx.setLineDash([])
      }
      rail('up', 'rgba(250,170,19,0.55)')
      rail('down', 'rgba(245,240,230,0.35)')

      // The signal.
      ctx.strokeStyle = '#FAAA13'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      pts.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Y(p.h)) : ctx.moveTo(X(p.t), Y(p.h))))
      ctx.stroke()

      // Counted reps.
      ctx.fillStyle = '#F5F0E6'
      for (const p of pts) {
        if (!p.rep) continue
        ctx.beginPath()
        ctx.arc(X(p.t), Y(p.h), 2.5, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [side, getTraces])

  return <canvas ref={ref} width={320} height={70} className="w-full rounded-sm ring-1 ring-white/10" />
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  suffix = '',
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  suffix?: string
}) {
  return (
    <label className="block">
      <div className="mb-1 flex justify-between text-[11px] uppercase tracking-wider text-muted">
        <span>{label}</span>
        <span className="tnum text-ink">
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        className="w-full accent-gold"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  )
}

export function DevPanel({
  open,
  snapshot,
  config,
  setConfig,
  trackerOptions,
  setTrackerOptions,
  onReset,
  getTimelines,
  getTraces,
}: Props) {
  const [copied, setCopied] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(id)
  }, [copied])

  if (!open) return null

  const copyTimeline = async () => {
    const payload = JSON.stringify(
      { config, trackerOptions, timelines: getTimelines(), exportedAt: new Date().toISOString() },
      null,
      2,
    )
    try {
      await navigator.clipboard.writeText(payload)
      setCopied(true)
    } catch {
      console.log(payload)
      setCopied(true)
    }
  }

  const fpsColor = snapshot.fps >= 30 ? 'text-gold' : snapshot.fps >= 20 ? 'text-ink' : 'text-danger'
  const p0 = snapshot.players[0]

  return (
    <div className="absolute top-4 left-4 z-30 max-h-[92vh] w-[23rem] overflow-y-auto border border-gold/30 bg-surface/95 p-4 font-mono text-xs text-ink shadow-2xl backdrop-blur">
      <div className="mb-3 flex items-center justify-between border-b border-white/10 pb-2">
        <span className="tracking-[0.2em] text-gold">DEV PANEL</span>
        <span className="text-muted">press D to hide</span>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1">
        <span className="text-muted">FPS</span>
        <span className={`tnum text-right ${fpsColor}`}>{snapshot.fps.toFixed(1)}</span>
        <span className="text-muted">inference</span>
        <span className="tnum text-right">{snapshot.inferenceMs.toFixed(1)} ms</span>
        <span className="text-muted">poses</span>
        <span className="tnum text-right">{snapshot.poseCount}</span>
        <span className="text-muted">dropped</span>
        <span className="tnum text-right">{snapshot.droppedFrames}</span>
        <span className="text-muted">display</span>
        <span className="tnum text-right">{snapshot.displayRes}</span>
        <span className="text-muted">inference in</span>
        <span className="tnum text-right">{snapshot.inferenceRes}</span>
        <span className="text-muted">scale ref</span>
        <span className="text-right">
          {p0?.scaleSource === 'shoulders' ? (
            <span className="text-gold">shoulders (hips out of frame)</span>
          ) : (
            (p0?.scaleSource ?? '—')
          )}
        </span>
      </div>

      {/* Mode switch. Auto is the default and needs no tuning. */}
      <div className="mb-3 border-t border-white/10 pt-3">
        <div className="mb-2 flex gap-2">
          {(['auto', 'manual'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setConfig({ mode: m })}
              className={`flex-1 border px-2 py-1 uppercase tracking-wider ${
                config.mode === m
                  ? 'border-gold bg-gold/15 text-gold'
                  : 'border-white/20 text-muted hover:bg-white/5'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        <p className="text-[11px] leading-relaxed text-muted">
          {config.mode === 'auto'
            ? 'Each wrist calibrates to its own range of motion. Nothing to tune — watch the traces below.'
            : 'Fixed thresholds. Only useful for debugging; a single number never fits every player.'}
        </p>
      </div>

      {config.mode === 'manual' && (
        <div className="mb-3 space-y-3 border-t border-white/10 pt-3">
          <Slider
            label="up threshold"
            value={config.upThreshold}
            min={-0.5}
            max={1.5}
            step={0.01}
            onChange={(v) => setConfig({ upThreshold: v })}
          />
          <Slider
            label="down threshold"
            value={config.downThreshold}
            min={-1.0}
            max={1.2}
            step={0.01}
            onChange={(v) => setConfig({ downThreshold: v })}
          />
          {config.downThreshold >= config.upThreshold && (
            <p className="text-danger">down ≥ up — the trigger cannot latch.</p>
          )}
        </div>
      )}

      <div className="mb-3 space-y-3 border-t border-white/10 pt-3">
        {(['left', 'right'] as const).map((side) => {
          const w = p0?.[side]
          return (
            <div key={side}>
              <div className="mb-1 flex items-baseline justify-between">
                <span className="text-gold">
                  {side === 'left' ? 'LEFT WRIST' : 'RIGHT WRIST'}{' '}
                  <span className="text-muted">(subject&apos;s own {side})</span>
                </span>
                <span className="tnum">{w?.count ?? 0} reps</span>
              </div>
              <TraceGraph side={side} getTraces={getTraces} />
              <div className="mt-1 flex justify-between text-[11px] text-muted">
                <span className="tnum">
                  h {w?.usable ? w.h.toFixed(2) : '—'} · {w?.state ?? '—'}
                </span>
                <span className="tnum">
                  range {w ? (w.max - w.min).toFixed(2) : '—'} · vis{' '}
                  {w?.visibility ? w.visibility.toFixed(2) : '—'}
                </span>
              </div>
              {w && !w.usable && (
                <p className="text-danger">not visible — this wrist is being skipped</p>
              )}
              {w && w.usable && !w.armed && config.mode === 'auto' && (
                <p className="text-muted">
                  disarmed: moving less than {config.autoMinRange} torso lengths
                </p>
              )}
            </div>
          )
        })}
        {!p0?.valid && <p className="text-danger">no valid pose — shoulders must be visible</p>}
      </div>

      <div className="mb-3 space-y-3 border-t border-white/10 pt-3">
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-wider text-muted">
            inference resolution
          </div>
          <div className="flex gap-2">
            {([1, 0.5, 0.35] as const).map((s) => (
              <button
                key={s}
                onClick={() => setTrackerOptions({ inferenceScale: s })}
                className={`flex-1 border px-2 py-1 ${
                  Math.abs(trackerOptions.inferenceScale - s) < 0.01
                    ? 'border-gold bg-gold/15 text-gold'
                    : 'border-white/20 text-muted hover:bg-white/5'
                }`}
              >
                {s === 1 ? 'full' : `${Math.round(s * 100)}%`}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-muted">
            Display always stays at full camera resolution.
          </p>
        </div>
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-wider text-muted">
            shoulder reference
          </div>
          <div className="flex gap-2">
            {(['sameSide', 'mid'] as const).map((r) => (
              <button
                key={r}
                onClick={() => setTrackerOptions({ reference: r })}
                className={`flex-1 border px-2 py-1 ${
                  trackerOptions.reference === r
                    ? 'border-gold bg-gold/15 text-gold'
                    : 'border-white/20 text-muted hover:bg-white/5'
                }`}
              >
                {r === 'sameSide' ? 'same side' : 'midpoint'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <button
        onClick={() => setShowAdvanced((v) => !v)}
        className="mb-2 w-full border border-white/15 px-2 py-1 text-left uppercase tracking-wider text-muted hover:bg-white/5"
      >
        {showAdvanced ? '▾' : '▸'} advanced
      </button>
      {showAdvanced && (
        <div className="mb-3 space-y-3">
          <Slider
            label="debounce"
            value={config.debounceMs}
            min={0}
            max={400}
            step={5}
            suffix=" ms"
            onChange={(v) => setConfig({ debounceMs: v })}
          />
          <Slider
            label="min visibility"
            value={config.minVisibility}
            min={0}
            max={0.95}
            step={0.05}
            onChange={(v) => setConfig({ minVisibility: v })}
          />
          <Slider
            label="auto window"
            value={config.autoWindowMs}
            min={200}
            max={2500}
            step={50}
            suffix=" ms"
            onChange={(v) => setConfig({ autoWindowMs: v })}
          />
          <Slider
            label="auto min range"
            value={config.autoMinRange}
            min={0.02}
            max={0.5}
            step={0.01}
            onChange={(v) => setConfig({ autoMinRange: v })}
          />
          <p className="text-[11px] leading-relaxed text-muted">
            These are tuned by simulation (npm run tune). Changing them by hand
            usually makes things worse.
          </p>
        </div>
      )}

      <div className="flex gap-2 border-t border-white/10 pt-3">
        <button
          className="flex-1 border border-gold/40 px-2 py-1 uppercase tracking-wider hover:bg-gold/10"
          onClick={onReset}
        >
          reset
        </button>
        <button
          className="flex-1 border border-gold/40 px-2 py-1 uppercase tracking-wider hover:bg-gold/10"
          onClick={copyTimeline}
        >
          {copied ? 'copied' : 'copy log'}
        </button>
        <button
          className="border border-white/20 px-2 py-1 uppercase tracking-wider text-muted hover:bg-white/5"
          onClick={() => setConfig(DEFAULT_REP_CONFIG)}
          title="restore tuned defaults"
        >
          rst
        </button>
      </div>
    </div>
  )
}
