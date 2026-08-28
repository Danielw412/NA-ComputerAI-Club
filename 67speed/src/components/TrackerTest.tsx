/**
 * Raw tracker harness — kept from build step 2 so counter accuracy can still be
 * checked by hand at any time (home screen -> "tracker test"). Not the game UI.
 */
import type { UsePoseTracker } from '../hooks/usePoseTracker'
import type { WristDebug } from '../lib/pose/repCounter'

export function TrackerTest({ tracker, onExit }: { tracker: UsePoseTracker; onExit: () => void }) {
  const running = tracker.status === 'running'
  const players = tracker.snapshot.players
  const p1 = players[0]

  if (!running) {
    return (
      <div className="relative z-20 flex h-full flex-col items-center justify-center gap-6 text-center">
        <h1 className="display text-5xl tracking-[0.1em] text-gold">TRACKER TEST</h1>
        <p className="max-w-lg text-sm text-muted">
          Count your pumps out loud and compare. Press D for traces and diagnostics.
        </p>
        <button
          onClick={() => void tracker.start()}
          disabled={tracker.status === 'starting'}
          className="display border-2 border-gold px-10 py-4 text-2xl tracking-[0.15em] text-gold hover:bg-gold/15 disabled:opacity-50"
        >
          {tracker.status === 'starting' ? 'LOADING MODEL…' : 'START CAMERA'}
        </button>
        {tracker.error && <p className="max-w-md text-danger">{tracker.error}</p>}
        <button
          onClick={onExit}
          className="text-xs uppercase tracking-[0.2em] text-muted underline-offset-4 hover:underline"
        >
          back
        </button>
      </div>
    )
  }

  return (
    <div className="relative z-20 flex h-full flex-col justify-between p-8">
      <div className="flex items-start justify-end gap-2">
        <button
          onClick={() => {
            tracker.stop()
            onExit()
          }}
          className="border border-white/25 px-4 py-2 text-xs uppercase tracking-[0.2em] text-muted hover:bg-white/5"
        >
          exit
        </button>
      </div>

      <div className="font-mono">
        <div className="flex items-baseline gap-6">
          <span className="text-sm uppercase tracking-[0.3em] text-muted">reps</span>
          <span className="tnum display text-[10rem] leading-none text-gold">
            {p1?.count ?? 0}
          </span>
        </div>
        <div className="mt-2 flex gap-10">
          <ArmReadout label="LEFT ARM" w={p1?.left} />
          <ArmReadout label="RIGHT ARM" w={p1?.right} />
        </div>
        <p className="mt-3 text-sm text-muted">
          scale {(p1?.scale ?? 0).toFixed(3)} ({p1?.scaleSource ?? '—'}) · poses{' '}
          {tracker.snapshot.poseCount} ·{' '}
          {p1?.valid ? 'tracking' : 'NO VALID POSE — shoulders must be visible'}
        </p>
      </div>

      <div className="flex items-end justify-between font-mono text-xs uppercase tracking-[0.2em] text-muted">
        <span>100% on-device — nothing leaves your computer</span>
        <span className="tnum">
          {tracker.snapshot.fps.toFixed(0)} fps · {tracker.snapshot.inferenceMs.toFixed(1)} ms ·{' '}
          {tracker.config.mode} · press D
        </span>
      </div>
    </div>
  )
}

function ArmReadout({ label, w }: { label: string; w?: WristDebug }) {
  const tooStill = w && w.usable && !w.armed
  return (
    <div className="font-mono">
      <div className="text-xs uppercase tracking-[0.25em] text-muted">{label}</div>
      <div className={`tnum display text-5xl ${w?.state === 'up' ? 'text-gold' : 'text-ink'}`}>
        {w?.count ?? 0}
      </div>
      <div className="tnum text-xs text-muted">
        {w?.usable ? `h ${w.h.toFixed(2)} · ${w.state}` : 'not visible'}
        {tooStill && ' · too still'}
      </div>
    </div>
  )
}
