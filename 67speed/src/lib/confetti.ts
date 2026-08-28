/**
 * Confetti, hand-rolled on a 2D canvas.
 *
 * Deliberately not a dependency: this is ~90 lines, it keeps the bundle small,
 * and - more importantly - the whole app has to work offline from vendored
 * assets, so every package we don't add is one less thing to vendor.
 *
 * Colours are the club palette. Nothing here is random enough to look noisy:
 * particles get a spread cone, gravity, drag, and per-particle spin so the
 * whole burst settles rather than sprays.
 */
const COLORS = ['#FAAA13', '#FFD275', '#F5F0E6', '#8A6800']

export interface BurstOptions {
  /** 0..1 of canvas width/height. */
  x?: number
  y?: number
  count?: number
  /** Radians. -PI/2 is straight up. */
  angle?: number
  spread?: number
  power?: number
}

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  w: number
  h: number
  rot: number
  vrot: number
  color: string
  life: number
  maxLife: number
}

const GRAVITY = 0.28
const DRAG = 0.992

export class ConfettiCanvas {
  private particles: Particle[] = []
  private raf = 0
  private ctx: CanvasRenderingContext2D | null
  private reduced: boolean
  private canvas: HTMLCanvasElement

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.reduced =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  private resize(): void {
    const { clientWidth, clientHeight } = this.canvas
    if (this.canvas.width !== clientWidth || this.canvas.height !== clientHeight) {
      this.canvas.width = clientWidth
      this.canvas.height = clientHeight
    }
  }

  burst(opts: BurstOptions = {}): void {
    if (this.reduced) return
    this.resize()
    const w = this.canvas.width
    const h = this.canvas.height
    const {
      x = 0.5,
      y = 0.45,
      count = 90,
      angle = -Math.PI / 2,
      spread = Math.PI / 2.2,
      power = 13,
    } = opts

    for (let i = 0; i < count; i++) {
      const a = angle + (Math.random() - 0.5) * spread
      const speed = power * (0.55 + Math.random() * 0.75)
      const maxLife = 90 + Math.random() * 70
      this.particles.push({
        x: x * w,
        y: y * h,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        w: 5 + Math.random() * 7,
        h: 8 + Math.random() * 8,
        rot: Math.random() * Math.PI,
        vrot: (Math.random() - 0.5) * 0.35,
        color: COLORS[(Math.random() * COLORS.length) | 0],
        life: 0,
        maxLife,
      })
    }
    this.start()
  }

  /** Two side cannons, angled inward - reads as a "winner" moment. */
  cannons(): void {
    this.burst({ x: 0.02, y: 0.75, angle: -Math.PI / 3.2, spread: Math.PI / 4, count: 70, power: 20 })
    this.burst({
      x: 0.98,
      y: 0.75,
      angle: -Math.PI + Math.PI / 3.2,
      spread: Math.PI / 4,
      count: 70,
      power: 20,
    })
  }

  private start(): void {
    if (this.raf) return
    const tick = () => {
      const ctx = this.ctx
      if (!ctx) return
      const w = this.canvas.width
      const h = this.canvas.height
      ctx.clearRect(0, 0, w, h)

      for (const p of this.particles) {
        p.life++
        p.vy += GRAVITY
        p.vx *= DRAG
        p.vy *= DRAG
        p.x += p.vx
        p.y += p.vy
        p.rot += p.vrot

        const fade = Math.max(0, 1 - p.life / p.maxLife)
        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.rotate(p.rot)
        ctx.globalAlpha = fade
        ctx.fillStyle = p.color
        // Squash on the spin axis so pieces read as tumbling foil.
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.rot)))
        ctx.restore()
      }

      this.particles = this.particles.filter((p) => p.life < p.maxLife && p.y < h + 40)

      if (this.particles.length === 0) {
        ctx.clearRect(0, 0, w, h)
        this.raf = 0
        return
      }
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  destroy(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.particles = []
  }
}
