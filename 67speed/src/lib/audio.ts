/**
 * All game audio, synthesized with the Web Audio API. No audio files - nothing
 * to load, nothing to 404 on venue wifi.
 *
 * The AudioContext is created lazily on the first user gesture, because
 * browsers refuse to start one otherwise.
 */
const MUTE_KEY = 'cai67:muted'

export class GameAudio {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private _muted: boolean

  constructor() {
    let stored: string | null = null
    try {
      stored = localStorage.getItem(MUTE_KEY)
    } catch {
      /* storage disabled */
    }
    // Default ON (i.e. not muted), per spec.
    this._muted = stored === 'true'
  }

  get muted(): boolean {
    return this._muted
  }

  setMuted(muted: boolean): void {
    this._muted = muted
    try {
      localStorage.setItem(MUTE_KEY, String(muted))
    } catch {
      /* storage disabled */
    }
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.01)
    }
  }

  /** Must be called from a user gesture the first time. */
  resume(): void {
    const ctx = this.ensure()
    if (ctx && ctx.state === 'suspended') void ctx.resume()
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx
    try {
      this.ctx = new AudioContext()
      this.master = this.ctx.createGain()
      this.master.gain.value = this._muted ? 0 : 1
      this.master.connect(this.ctx.destination)
      return this.ctx
    } catch {
      return null
    }
  }

  private tone(opts: {
    freq: number
    durationMs: number
    type?: OscillatorType
    gain?: number
    sweepTo?: number
    delayMs?: number
  }): void {
    const ctx = this.ensure()
    if (!ctx || !this.master || this._muted) return
    const t0 = ctx.currentTime + (opts.delayMs ?? 0) / 1000
    const dur = opts.durationMs / 1000
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = opts.type ?? 'square'
    osc.frequency.setValueAtTime(opts.freq, t0)
    if (opts.sweepTo) osc.frequency.exponentialRampToValueAtTime(opts.sweepTo, t0 + dur)

    const peak = opts.gain ?? 0.25
    // Short attack + exponential decay: percussive, never clicky.
    gain.gain.setValueAtTime(0.0001, t0)
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.005)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)

    osc.connect(gain)
    gain.connect(this.master)
    osc.start(t0)
    osc.stop(t0 + dur + 0.02)
  }

  /**
   * One tick per counted rep, pitched up as the pace increases so a fast run
   * audibly climbs. `rate` is reps per second.
   */
  rep(rate: number): void {
    const clamped = Math.max(0, Math.min(12, rate))
    const freq = 620 + clamped * 55
    this.tone({ freq, durationMs: 40, type: 'square', gain: 0.16 })
  }

  /** 3 / 2 / 1 beeps. */
  countdownBeep(): void {
    this.tone({ freq: 440, durationMs: 120, type: 'square', gain: 0.2 })
  }

  /** GO. */
  go(): void {
    this.tone({ freq: 880, durationMs: 260, type: 'square', gain: 0.26 })
    this.tone({ freq: 1320, durationMs: 220, type: 'square', gain: 0.14, delayMs: 40 })
  }

  /** End of run. */
  horn(): void {
    this.tone({ freq: 320, durationMs: 900, type: 'sawtooth', gain: 0.22, sweepTo: 180 })
    this.tone({ freq: 240, durationMs: 900, type: 'square', gain: 0.12, sweepTo: 140 })
  }

  /** Every 25 reps during a run - a short rising triad, louder than a tick. */
  milestone(): void {
    const notes = [660, 880, 1170]
    notes.forEach((f, i) =>
      this.tone({ freq: f, durationMs: 130, type: 'square', gain: 0.2, delayMs: i * 55 }),
    )
  }

  /** Made the leaderboard. */
  fanfare(): void {
    const notes = [523, 659, 784, 1047]
    notes.forEach((f, i) =>
      this.tone({ freq: f, durationMs: 220, type: 'square', gain: 0.18, delayMs: i * 90 }),
    )
  }

  click(): void {
    this.tone({ freq: 520, durationMs: 30, type: 'square', gain: 0.12 })
  }
}

export const audio = new GameAudio()
