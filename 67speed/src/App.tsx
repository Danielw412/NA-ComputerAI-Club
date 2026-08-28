/**
 * Shell: owns the camera layers and switches between home, the live game, the
 * results screen, and the raw tracker harness.
 *
 * The <video> and overlay canvas are mounted once here and reused across
 * phases, so switching screens never restarts the camera mid-run.
 */
import { useEffect, useState } from 'react'
import { DevPanel } from './components/DevPanel'
import { GameScreen } from './components/GameScreen'
import { Home } from './components/Home'
import { Results } from './components/Results'
import { TrackerTest } from './components/TrackerTest'
import { useGame } from './game/useGame'
import { usePoseTracker } from './hooks/usePoseTracker'
import { audio } from './lib/audio'

type View = 'game' | 'trackerTest'

export default function App() {
  const tracker = usePoseTracker(2)
  const { state, startMode, goHome, goAgain } = useGame(tracker)
  const [devOpen, setDevOpen] = useState(false)
  const [view, setView] = useState<View>('game')
  const [muted, setMuted] = useState(audio.muted)
  const [leaderboardKey, setLeaderboardKey] = useState(0)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      // Never steal keys from the initials input.
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      if (e.key === 'd' || e.key === 'D') setDevOpen((v) => !v)
      // Booth ergonomics: F for fullscreen, Escape to bail back to home.
      if (e.key === 'f' || e.key === 'F') {
        if (document.fullscreenElement) void document.exitFullscreen()
        else void document.documentElement.requestFullscreen().catch(() => {})
      }
      if (e.key === 'Escape') {
        setView('game')
        goHome()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goHome])

  const cameraLive = tracker.status === 'running'
  const atHome = view === 'game' && state.phase === 'home'

  const toggleMute = () => {
    const next = !muted
    audio.setMuted(next)
    setMuted(next)
    if (!next) audio.resume()
  }

  return (
    <div className="relative h-full w-full overflow-hidden bg-bg">
      {/* Camera layers. The tracker owns the <video>; we just host it. */}
      <div ref={tracker.mountRef} className="mirrored absolute inset-0" />
      <canvas
        ref={tracker.canvasRef}
        className="mirrored absolute inset-0 h-full w-full object-cover"
      />
      {cameraLive && <div className="absolute inset-0 bg-black/45" />}

      <DevPanel
        open={devOpen}
        snapshot={tracker.snapshot}
        config={tracker.config}
        setConfig={tracker.setConfig}
        trackerOptions={tracker.trackerOptions}
        setTrackerOptions={tracker.setTrackerOptions}
        onReset={tracker.resetCounters}
        getTimelines={tracker.getTimelines}
        getTraces={tracker.getTraces}
      />

      <button
        onClick={toggleMute}
        title={muted ? 'Unmute' : 'Mute'}
        className="absolute top-4 right-4 z-40 border border-white/20 px-3 py-1.5 text-xs uppercase tracking-[0.2em] text-muted hover:bg-white/5"
        style={{ right: view === 'game' && !atHome ? '5.5rem' : '1rem' }}
      >
        {muted ? 'sound off' : 'sound on'}
      </button>

      {view === 'trackerTest' ? (
        <TrackerTest tracker={tracker} onExit={() => setView('game')} />
      ) : state.phase === 'home' ? (
        <Home
          onStart={(mode) => void startMode(mode)}
          onTrackerTest={() => setView('trackerTest')}
          starting={tracker.status === 'starting'}
          error={tracker.error}
          leaderboardKey={leaderboardKey}
        />
      ) : state.phase === 'results' && state.result ? (
        <Results
          result={state.result}
          onAgain={goAgain}
          onHome={goHome}
          onSubmitted={() => setLeaderboardKey((k) => k + 1)}
        />
      ) : (
        <GameScreen state={state} onQuit={goHome} />
      )}
    </div>
  )
}
