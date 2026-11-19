/**
 * One game room per Durable Object, addressed by its six-digit join code.
 *
 * Clients connect over hibernatable WebSockets. The whole game state is one
 * JSON value in storage, so the object can be evicted between events and
 * resume where it left off. A single alarm drives the writing deadline,
 * judging and idle cleanup. Model calls run inside the alarm handler, which
 * has a long wall-clock budget and is retried by the runtime if it dies.
 */
import { DurableObject } from 'cloudflare:workers'
import type {
  DecisionView,
  Effort,
  Fate,
  HostMessage,
  JoinResponse,
  OutcomeView,
  Phase,
  PlayerMessage,
  PlayerView,
  RoomView,
  ServerMessage,
  Settings,
  Stage,
} from '../shared/protocol.ts'
import { cleanText, LIMITS, normalizePicks, pointsFor, stepKey } from '../shared/protocol.ts'
import { callTimeoutMs, combine, decisionWeights, describeModels, judge, narrate, noPlanOutcome } from './ai/index.ts'
import { keepEnds } from './ai/prompts.ts'
import type { Decision, NarrationEvent, PlanInput } from './ai/types.ts'
import { socketCredential } from './credentials.ts'
import type { Env } from './env.ts'
import { intVar } from './env.ts'
import { FALLBACK_SCENARIO, pickScenario } from './scenarios.ts'

interface Player {
  id: string
  name: string
  token: string
  score: number
  survivals: number
  history: Fate[]
  joinedAt: number
  /** Set the first time the player's phone connects. */
  seen: boolean
}

interface Round {
  /** Unique per round (and per scenario swap), so stale work and submissions are dropped. */
  id: string
  number: number
  scenario: string
  deadline: number | null
  plans: Record<string, string>
  order: string[]
  revealIndex: number
  verdictShown: boolean
  scored: boolean
}

interface RoomState {
  code: string
  touchedAt: number
  phase: Phase
  settings: Settings
  players: Player[]
  round: Round | null
  outcomes: Record<string, OutcomeView>
  usedScenarios: string[]
}

interface Attachment {
  role: 'host' | 'player'
  playerId?: string
  /** Host session expiry, epoch ms. */
  exp?: number
}

type JoinResult = JoinResponse | { error: string; status: number }

const STATE_KEY = 'state'
const IDLE_MS = 3 * 3_600_000
/** Late submissions are accepted for this long after the visible timer ends. */
const GRACE_MS = 1_500
const DELTA_FLUSH_MS = 90
/** A seat that never connects is released after this long. */
const UNCLAIMED_SEAT_MS = 2 * 60_000
/** How long a dropped player gets to reconnect before writing ends without them. */
const RECONNECT_GRACE_MS = 5_000
/** Alarm handlers get 15 minutes of wall time; each judging slice must finish inside this. */
const JUDGING_SLICE_MS = 14 * 60_000
/** Per-outcome caps keep the stored room well under the 2 MB value limit with 40 players. */
const REASONING_CAP = 8_000
const STORY_CAP = 1_200
/** Room for a settings message carrying the full list of picked scenarios. */
const MESSAGE_LIMIT = 8_192
const SUBPROTOCOL = 'exit-code'
/** The ceiling for AI_CONCURRENCY. The real limit is usually the Claude API's rate limit for your account tier. */
const MAX_LANES = 20
const DEFAULT_SETTINGS: Settings = { rounds: 3, seconds: 60, effort: 'high', threshold: 50, decisionModel: true, scenarios: [] }
const HOST_TAG = 'host'
const playerTag = (id: string) => `p:${id}`

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('')
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function emptyOutcome(playerId: string, plan: string): OutcomeView {
  return {
    playerId,
    plan,
    stage: 'queued',
    reasoning: '',
    story: '',
    survived: null,
    cleverness: null,
    verdictReason: '',
    narratorDecision: null,
    judgeDecision: null,
    chance: null,
    points: null,
    narrator: '',
    judge: '',
    fallback: false,
  }
}

/** What a player may see of their own outcome before it's revealed: the trace and the decision model's call, nothing else. */
function masked(outcome: OutcomeView): OutcomeView {
  return {
    ...outcome,
    story: '',
    survived: null,
    cleverness: null,
    verdictReason: '',
    narratorDecision: null,
    chance: null,
    points: null,
  }
}

function decisionView(decision: Decision): DecisionView {
  return {
    chance: Math.min(1, Math.max(0, decision.chance)),
    cleverness: decision.cleverness,
    model: decision.model,
    fallback: decision.fallback,
  }
}

export class GameRoom extends DurableObject<Env> {
  private state: RoomState | null = null
  private judging: Promise<void> | null = null
  private judgingAbort: AbortController | null = null
  /** In-flight model work per player, so a kick can stop it. */
  private jobs = new Map<string, AbortController>()
  /** Reasoning text waiting for the next batched send, by player id. */
  private pending = new Map<string, string>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  /** Writing can't end early before this time, so a dropped phone can reconnect. */
  private graceUntil = 0
  private graceTimer: ReturnType<typeof setTimeout> | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    void ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get<RoomState>(STATE_KEY)) ?? null
      // Rooms saved before a settings field existed get its default.
      if (this.state) this.state.settings = { ...DEFAULT_SETTINGS, ...this.state.settings }
    })
  }

  // ---------------------------------------------------------------- RPC

  /** Claims this code for a new game. False when a live game already has it. */
  async create(code: string): Promise<boolean> {
    if (this.live()) return false
    if (this.state) await this.destroy()
    this.state = {
      code,
      touchedAt: Date.now(),
      phase: 'lobby',
      settings: { ...DEFAULT_SETTINGS },
      players: [],
      round: null,
      outcomes: {},
      usedScenarios: [],
    }
    await this.save()
    return true
  }

  async peek(): Promise<{ exists: boolean; joinable: boolean }> {
    const s = this.live()
    return {
      exists: s !== null,
      joinable: s !== null && s.phase !== 'final' && s.players.length < LIMITS.maxPlayers,
    }
  }

  async join(name: string): Promise<JoinResult> {
    const s = this.live()
    if (!s) return { error: 'No game uses that code. Check the code on the big screen.', status: 404 }
    if (!name) return { error: 'Enter a name to join.', status: 400 }
    if (s.phase === 'final') return { error: 'This game has finished. Ask the host for a new code.', status: 409 }

    // Release seats that were reserved but never connected, so they can't fill the room.
    const now = Date.now()
    s.players = s.players.filter((p) => p.seen || now - p.joinedAt < UNCLAIMED_SEAT_MS || this.isConnected(p.id))

    if (s.players.length >= LIMITS.maxPlayers) return { error: 'This game is full.', status: 409 }
    if (s.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return { error: 'Someone in this game already has that name. Pick another.', status: 409 }
    }
    // Late joiners get blank entries for rounds already scored, so tallies line up.
    const scoredRounds = s.round ? s.round.number - (s.round.scored ? 0 : 1) : 0
    const history: Fate[] = Array.from({ length: scoredRounds }, () => 'none')
    const player: Player = {
      id: randomHex(6),
      token: randomHex(16),
      name,
      score: 0,
      survivals: 0,
      history,
      joinedAt: now,
      seen: false,
    }
    s.players.push(player)
    this.touch()
    await this.save()
    this.broadcastState()
    return { playerId: player.id, token: player.token, name }
  }

  // ---------------------------------------------------------------- sockets

  async fetch(request: Request): Promise<Response> {
    const s = this.live()
    const hostExp = Number(request.headers.get('X-Host-Exp'))
    const isHost = Number.isFinite(hostExp) && hostExp > Date.now()
    const credential = socketCredential(request)
    const [playerId = '', token = ''] = credential.split('.')
    const player = isHost ? undefined : s?.players.find((p) => p.id === playerId)
    const headers = { 'Sec-WebSocket-Protocol': SUBPROTOCOL }

    // Anything queued so far belongs before this socket's first snapshot.
    this.flush()
    const { 0: client, 1: server } = new WebSocketPair()

    if (!s || (!isHost && (!player || !sameSecret(player.token, token)))) {
      // Accept, explain and close, so the client can tell "removed" from "offline".
      server.accept()
      server.send(JSON.stringify({ t: 'bye', reason: s ? 'kicked' : 'closed' } satisfies ServerMessage))
      server.close(4000, 'gone')
      return new Response(null, { status: 101, webSocket: client, headers })
    }

    const attachment: Attachment = isHost ? { role: 'host', exp: hostExp } : { role: 'player', playerId: player!.id }
    this.ctx.acceptWebSocket(server, isHost ? [HOST_TAG] : [playerTag(player!.id)])
    server.serializeAttachment(attachment)
    this.send(server, { t: 'state', state: this.view(attachment) })
    if (player) {
      if (!player.seen) {
        player.seen = true
        await this.save()
      }
      this.broadcastState()
    }
    return new Response(null, { status: 101, webSocket: client, headers })
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (!this.live() || typeof raw !== 'string' || raw.length > MESSAGE_LIMIT) return
    let message: unknown
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (!message || typeof message !== 'object') return
    const attachment = ws.deserializeAttachment() as Attachment | null
    if (attachment?.role === 'host') {
      if (!this.hostValid(ws, attachment)) return
      await this.onHost(message as HostMessage)
    } else if (attachment?.playerId) {
      await this.onPlayer(attachment.playerId, message as PlayerMessage)
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      ws.close()
    } catch {
      // Already closed.
    }
    const attachment = ws.deserializeAttachment() as Attachment | null
    if (attachment?.role !== 'player' || !this.live()) return
    this.broadcastState()
    if (this.state?.phase === 'writing') {
      this.graceUntil = Date.now() + RECONNECT_GRACE_MS
      this.scheduleFinishCheck(this.state.round?.id)
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws)
  }

  // ---------------------------------------------------------------- alarm

  async alarm(): Promise<void> {
    const s = this.state
    if (!s) return
    if (s.phase !== 'judging' && Date.now() - s.touchedAt >= IDLE_MS) {
      await this.destroy()
      return
    }
    if (s.phase === 'writing' && s.round?.deadline && Date.now() >= s.round.deadline + GRACE_MS) {
      await this.endWriting()
    } else if (s.phase === 'judging') {
      await this.runJudging()
    }
    // Every phase needs some alarm (deadline, judging, or idle cleanup).
    if (this.state && !this.judging && (await this.ctx.storage.getAlarm()) === null) await this.save()
  }

  // ---------------------------------------------------------------- messages

  private async onHost(message: HostMessage): Promise<void> {
    const s = this.state!
    this.touch()
    switch (message.t) {
      case 'settings': {
        if (s.phase !== 'lobby') return
        const { rounds, seconds, effort, scenarios, threshold } = message.settings ?? {}
        if ((LIMITS.rounds as readonly number[]).includes(rounds as number)) s.settings.rounds = rounds as number
        if ((LIMITS.seconds as readonly number[]).includes(seconds as number)) s.settings.seconds = seconds as number
        if ((LIMITS.thresholds as readonly number[]).includes(threshold as number)) s.settings.threshold = threshold as number
        if ((LIMITS.efforts as readonly string[]).includes(effort as string)) s.settings.effort = effort as Effort
        if (Array.isArray(scenarios)) s.settings.scenarios = normalizePicks(scenarios)
        await this.save()
        this.broadcastState()
        return
      }
      case 'start':
        if (s.phase === 'lobby' && s.players.length > 0) await this.startRound(1)
        return
      case 'decisionModel':
        if (typeof message.on !== 'boolean' || s.settings.decisionModel === message.on) return
        s.settings.decisionModel = message.on
        await this.save()
        this.broadcastState()
        return
      case 'kick':
        await this.kick(String(message.id))
        return
      case 'endWriting':
        if (s.phase === 'writing') await this.endWriting()
        return
      case 'skipScenario':
        if (s.phase === 'writing' && s.round) await this.startRound(s.round.number, true)
        return
      case 'next':
        if (this.atStep(message.at)) await this.next()
        return
      case 'showVerdict':
        if (s.phase === 'reveal' && s.round && this.atStep(message.at)) {
          s.round.verdictShown = true
          await this.save()
          this.broadcastState()
        }
        return
      case 'skipReveal':
        if (s.phase === 'reveal' && this.atStep(message.at)) await this.enterScores()
        return
      case 'playAgain':
        if (s.phase === 'final') await this.playAgain()
        return
      case 'close':
        await this.destroy()
        return
    }
  }

  private async onPlayer(playerId: string, message: PlayerMessage): Promise<void> {
    const s = this.state!
    const round = s.round
    if (message.t !== 'submit' || s.phase !== 'writing' || !round?.deadline) return
    // A plan typed for a scenario the host has since swapped out doesn't count.
    if (message.roundId !== round.id || Date.now() > round.deadline + GRACE_MS) return
    if (!s.players.some((p) => p.id === playerId)) return
    const plan = cleanText(message.plan, LIMITS.planLength)
    if (!plan) return
    round.plans[playerId] = plan
    this.touch()
    await this.save()
    this.broadcastState()
    await this.finishWritingIfAllIn(round.id)
  }

  // ---------------------------------------------------------------- game flow

  /** Starts round `number` with the host's pick for it, or a random scenario when there is none or the host swapped it. */
  private async startRound(number: number, swap = false): Promise<void> {
    const s = this.state!
    const picked = s.settings.scenarios
    // A draw never reveals a pick saved for a later round, and a swap never redraws the scenario it replaces.
    const never = [...picked.slice(number), ...(swap && s.round ? [s.round.scenario] : [])]
    const drawn = (!swap && picked[number - 1]) || pickScenario([...s.usedScenarios, ...picked], never)
    // Nothing left to swap in (a very short scenarios.txt): keep the current round as it is.
    if (!drawn && swap) return
    const scenario = drawn || FALLBACK_SCENARIO
    this.cancelJudging()
    s.usedScenarios = [...s.usedScenarios, scenario].slice(-30)
    s.round = {
      id: randomHex(6),
      number,
      scenario,
      deadline: Date.now() + s.settings.seconds * 1000,
      plans: {},
      order: [],
      revealIndex: 0,
      verdictShown: false,
      scored: false,
    }
    s.outcomes = {}
    s.phase = 'writing'
    this.graceUntil = 0
    await this.save()
    this.broadcastState()
  }

  /** Ends writing early once every connected player has a plan in. */
  private async finishWritingIfAllIn(roundId: string | undefined): Promise<void> {
    const s = this.state
    const round = s?.round
    if (!s || !round || s.phase !== 'writing' || round.id !== roundId) return
    if (Date.now() < this.graceUntil) {
      this.scheduleFinishCheck(roundId)
      return
    }
    const connected = s.players.filter((p) => this.isConnected(p.id))
    if (connected.length > 0 && connected.every((p) => round.plans[p.id])) await this.endWriting()
  }

  private scheduleFinishCheck(roundId: string | undefined): void {
    if (this.graceTimer) clearTimeout(this.graceTimer)
    this.graceTimer = setTimeout(
      () => {
        this.graceTimer = null
        void this.finishWritingIfAllIn(roundId)
      },
      Math.max(0, this.graceUntil - Date.now()) + 50,
    )
  }

  private async endWriting(): Promise<void> {
    const s = this.state!
    const round = s.round!
    round.deadline = null
    round.order = shuffle(s.players.filter((p) => round.plans[p.id]).map((p) => p.id))
    s.outcomes = {}
    for (const player of s.players) {
      const plan = round.plans[player.id]
      if (plan) {
        s.outcomes[player.id] = emptyOutcome(player.id, plan)
        continue
      }
      const canned = noPlanOutcome(this.planInput(player, ''))
      s.outcomes[player.id] = {
        ...emptyOutcome(player.id, ''),
        stage: 'done',
        reasoning: canned.reasoning,
        story: canned.story,
        survived: false,
        cleverness: 1,
        verdictReason: canned.reason,
        chance: 0,
        points: 0,
      }
    }
    if (round.order.length === 0) {
      await this.enterScores()
      return
    }
    // Saving in the judging phase schedules an immediate alarm, which runs the models.
    s.phase = 'judging'
    await this.save()
    this.broadcastState()
  }

  private runJudging(): Promise<void> {
    if (this.judging) return this.judging
    const s = this.state!
    const round = s.round!
    const controller = new AbortController()
    this.judgingAbort = controller
    const queue = round.order.filter((id) => s.outcomes[id] && s.outcomes[id].stage !== 'done')
    // Workers caps an invocation at 6 connections *waiting for response headers*. A streaming call stops counting
    // once its stream starts, so lanes past six only wait a moment for headers, not for a whole story.
    // Each alarm run has its own outgoing-request allowance (50 on the Workers Free plan), and one plan can use
    // up to six (two narrator tries, each of which may resend once without an optional feature, plus two verdict
    // tries). So a run starts at most this many plans, and the rest continue in a fresh run a moment later.
    const perRun = intVar(this.env.AI_PLANS_PER_RUN, 8, 1, 1000)
    const lanes = Math.min(intVar(this.env.AI_CONCURRENCY, 6, 1, MAX_LANES), queue.length, perRun)
    // Worst case for one plan: two narration attempts, two verdict attempts, then the mock.
    const timeoutMs = callTimeoutMs(this.env)
    const lastStart = Date.now() + JUDGING_SLICE_MS - (4 * timeoutMs + 30_000)
    let started = 0

    this.judging = (async () => {
      await Promise.all(
        Array.from({ length: lanes }, async () => {
          // Each lane always takes one plan, so a slice can never make zero progress.
          let first = true
          while (queue.length > 0 && !controller.signal.aborted && started < perRun && (first || Date.now() < lastStart)) {
            first = false
            started += 1
            await this.judgeOne(queue.shift()!, round.id, controller.signal)
          }
        }),
      )
      if (controller.signal.aborted || !this.isCurrent(round.id) || this.state?.phase !== 'judging') return
      const unfinished = round.order.some((id) => this.state!.outcomes[id]?.stage !== 'done')
      if (unfinished) {
        // Out of time or requests for this run: continue in a fresh alarm.
        await this.ctx.storage.setAlarm(Date.now() + 250)
        return
      }
      await this.enterReveal()
    })().finally(() => {
      this.judging = null
      if (this.judgingAbort === controller) this.judgingAbort = null
    })
    return this.judging
  }

  private async judgeOne(playerId: string, roundId: string, roundSignal: AbortSignal): Promise<void> {
    const s = this.state!
    const outcome = s.outcomes[playerId]
    const player = s.players.find((p) => p.id === playerId)
    if (!outcome || !player || outcome.stage === 'done' || roundSignal.aborted || !this.isCurrent(roundId)) return

    const job = new AbortController()
    this.jobs.set(playerId, job)
    const signal = AbortSignal.any([roundSignal, job.signal])
    // Results only count while this exact outcome is still the live one.
    const alive = () => !signal.aborted && this.isCurrent(roundId) && this.state?.outcomes[playerId] === outcome
    const input = this.planInput(player, outcome.plan)

    try {
      // A resumed job starts over; clients drop any partial trace or decision they hold.
      outcome.reasoning = ''
      outcome.story = ''
      outcome.narratorDecision = null
      outcome.judgeDecision = null
      const labels = describeModels(this.env)
      outcome.narrator = labels.narrator
      outcome.judge = labels.judge
      this.sendTo(playerId, { t: 'reset', id: playerId }, true)
      this.setStage(outcome, 'thinking')

      // Both models read the plan at the same time. The narrator streams its reasoning;
      // the decision model's call goes out to screens the moment it lands. With the
      // decision model switched off, the narrator decides alone.
      const judged = s.settings.decisionModel
        ? judge(this.env, input, signal).then((result) => {
            if (alive() && this.state?.settings.decisionModel) {
              outcome.judgeDecision = decisionView(result)
              outcome.judge = result.model
              this.sendTo(playerId, { t: 'decision', id: playerId, decision: outcome.judgeDecision }, true)
            }
            return result
          })
        : Promise.resolve(null)
      const narration = narrate(this.env, input, (event) => alive() && this.onNarration(outcome, event), signal, {
        effort: s.settings.effort,
      }).then((result) => {
        // Still waiting on the decision model.
        if (alive() && this.state?.settings.decisionModel && !outcome.judgeDecision) this.setStage(outcome, 'deciding')
        return result
      })
      const [told, decided] = await Promise.all([narration, judged])
      if (!alive()) return
      this.flush()
      // Switched off while this plan was being judged: its call no longer counts.
      const vote = this.state?.settings.decisionModel ? decided : null
      if (!vote) outcome.judgeDecision = null
      const final = combine(told, vote, decisionWeights(this.env), (this.state?.settings.threshold ?? 50) / 100)
      outcome.reasoning = clip(told.reasoning, REASONING_CAP)
      outcome.narratorDecision = decisionView(told)
      outcome.narrator = told.model
      outcome.fallback = told.fallback || Boolean(vote?.fallback)
      outcome.story = keepEnds(final.story, STORY_CAP)
      outcome.chance = Math.min(1, Math.max(0, final.chance))
      this.settle(outcome, final.survived, final.cleverness, clip(final.reason, 200))
    } catch (error) {
      if (!alive()) return
      console.error('judging failed', error)
      this.settle(outcome, true, 1, 'The AI lost track of this plan, so it gets the benefit of the doubt.')
    } finally {
      if (this.jobs.get(playerId) === job) this.jobs.delete(playerId)
    }
    await this.save()
  }

  private onNarration(outcome: OutcomeView, event: NarrationEvent): void {
    const id = outcome.playerId
    if (event.type === 'reset') {
      // A retry or fallback: the narrator's partial trace is void and it thinks again. The judge's call stands.
      outcome.reasoning = ''
      this.dropPending(id)
      this.sendTo(id, { t: 'reset', id }, true)
      if (outcome.judgeDecision) this.sendTo(id, { t: 'decision', id, decision: outcome.judgeDecision }, true)
      if (outcome.stage !== 'thinking') this.setStage(outcome, 'thinking')
      return
    }
    if (event.type === 'decision') {
      // The number itself is recorded only once the narration succeeds, so an attempt that fails
      // later (or a skip) can never show a provisional score. The stage tells screens it's writing.
      if (outcome.stage === 'thinking') {
        this.flush()
        this.setStage(outcome, 'writing')
      }
      return
    }
    const room = REASONING_CAP - outcome.reasoning.length
    if (room <= 0) return
    const delta = event.delta.slice(0, room)
    outcome.reasoning += delta
    this.pending.set(id, (this.pending.get(id) ?? '') + delta)
    this.flushTimer ??= setTimeout(() => this.flush(), DELTA_FLUSH_MS)
  }

  /** Records a verdict and marks the outcome done. */
  private settle(outcome: OutcomeView, survived: boolean, cleverness: number, reason: string): void {
    outcome.survived = survived
    outcome.cleverness = cleverness
    outcome.verdictReason = reason
    outcome.points = pointsFor(survived, cleverness)
    if (!outcome.story) {
      const name = this.state?.players.find((p) => p.id === outcome.playerId)?.name ?? 'This player'
      outcome.story = `${name}'s fate got lost somewhere in the machine. They wander out of the scenario confused, but alive.`
    }
    this.setStage(outcome, 'done')
  }

  private async enterReveal(): Promise<void> {
    const s = this.state!
    const round = s.round!
    round.order = round.order.filter((id) => s.outcomes[id] && s.players.some((p) => p.id === id))
    round.revealIndex = 0
    round.verdictShown = false
    if (round.order.length === 0) {
      await this.enterScores()
      return
    }
    s.phase = 'reveal'
    await this.save()
    this.broadcastState()
  }

  private async enterScores(): Promise<void> {
    const s = this.state!
    const round = s.round!
    if (!round.scored) {
      for (const player of s.players) {
        const outcome = s.outcomes[player.id]
        const settled = outcome?.stage === 'done'
        player.history = [...player.history, !settled || !outcome.plan ? 'none' : outcome.survived ? 'survived' : 'died']
        if (!settled) continue
        player.score += outcome.points ?? 0
        if (outcome.survived) player.survivals += 1
      }
      round.scored = true
    }
    s.phase = 'scores'
    await this.save()
    this.broadcastState()
  }

  private async next(): Promise<void> {
    const s = this.state!
    const round = s.round
    if (!round) return
    if (s.phase === 'judging') {
      // Host skipped the wait: stop the models and settle anything still running.
      this.cancelJudging()
      for (const id of round.order) {
        const outcome = s.outcomes[id]
        if (outcome && outcome.stage !== 'done') {
          this.settle(outcome, true, 1, 'The AI ran out of time, so this plan gets the benefit of the doubt.')
        }
      }
      await this.enterReveal()
    } else if (s.phase === 'reveal') {
      if (round.revealIndex + 1 >= round.order.length) {
        await this.enterScores()
        return
      }
      round.revealIndex += 1
      round.verdictShown = false
      await this.save()
      this.broadcastState()
    } else if (s.phase === 'scores') {
      if (round.number < s.settings.rounds) {
        await this.startRound(round.number + 1)
        return
      }
      s.phase = 'final'
      await this.save()
      this.broadcastState()
    }
  }

  private async playAgain(): Promise<void> {
    const s = this.state!
    this.cancelJudging()
    for (const player of s.players) {
      player.score = 0
      player.survivals = 0
      player.history = []
    }
    s.phase = 'lobby'
    s.round = null
    s.outcomes = {}
    await this.save()
    this.broadcastState()
  }

  private async kick(playerId: string): Promise<void> {
    const s = this.state!
    const index = s.players.findIndex((p) => p.id === playerId)
    if (index === -1) return
    s.players.splice(index, 1)
    this.jobs.get(playerId)?.abort()
    this.dropPending(playerId)
    for (const ws of this.ctx.getWebSockets(playerTag(playerId))) {
      this.send(ws, { t: 'bye', reason: 'kicked' })
      try {
        ws.close(4001, 'removed')
      } catch {
        // Already closed.
      }
    }

    const round = s.round
    if (round) {
      delete round.plans[playerId]
      const position = round.order.indexOf(playerId)
      const shown = s.phase === 'reveal' && position !== -1 && position <= round.revealIndex
      if (!shown && s.phase !== 'scores' && s.phase !== 'final') {
        if (position !== -1) round.order.splice(position, 1)
        delete s.outcomes[playerId]
      }
    }
    await this.save()
    this.broadcastState()

    if (s.phase === 'writing') await this.finishWritingIfAllIn(round?.id)
    else if (s.phase === 'reveal' && round && round.revealIndex >= round.order.length) await this.enterScores()
  }

  /** Ends the room: tells every client, closes sockets and wipes storage. */
  private async destroy(): Promise<void> {
    this.cancelJudging()
    for (const ws of this.ctx.getWebSockets()) {
      this.send(ws, { t: 'bye', reason: 'closed' })
      try {
        ws.close(4002, 'closed')
      } catch {
        // Already closed.
      }
    }
    this.state = null
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
  }

  // ---------------------------------------------------------------- helpers

  private live(): RoomState | null {
    const s = this.state
    if (!s) return null
    if (s.phase !== 'judging' && Date.now() - s.touchedAt >= IDLE_MS) return null
    return s
  }

  private atStep(at: unknown): boolean {
    const s = this.state
    return Boolean(s && at === stepKey(s.phase, s.round))
  }

  private isCurrent(roundId: string): boolean {
    return this.state?.round?.id === roundId
  }

  private isConnected(playerId: string): boolean {
    return this.ctx.getWebSockets(playerTag(playerId)).some((ws) => ws.readyState === WebSocket.READY_STATE_OPEN)
  }

  /** False (and the socket is closed) once the host's session has expired. */
  private hostValid(ws: WebSocket, attachment: Attachment): boolean {
    if ((attachment.exp ?? 0) > Date.now()) return true
    this.send(ws, { t: 'bye', reason: 'expired' })
    try {
      ws.close(4003, 'expired')
    } catch {
      // Already closed.
    }
    return false
  }

  private planInput(player: Player, plan: string): PlanInput {
    const round = this.state!.round!
    return { scenario: round.scenario, playerName: player.name, plan, round: round.number }
  }

  private cancelJudging(): void {
    this.judgingAbort?.abort()
    this.judgingAbort = null
    for (const job of this.jobs.values()) job.abort()
    this.jobs.clear()
    this.pending.clear()
  }

  private dropPending(playerId: string): void {
    this.pending.delete(playerId)
  }

  private touch(): void {
    if (this.state) this.state.touchedAt = Date.now()
  }

  /** When the single alarm should fire for the current phase, or null to leave it as is. */
  private alarmAt(s: RoomState): number | null {
    if (s.phase === 'writing' && s.round?.deadline) return s.round.deadline + GRACE_MS
    // While a judging pass runs it owns the alarm; otherwise start (or resume) one now.
    if (s.phase === 'judging') return this.judging ? null : Date.now()
    return s.touchedAt + IDLE_MS
  }

  /**
   * Persists the room and its alarm together. The two writes are issued with no
   * await between them, so the runtime commits them atomically.
   */
  private async save(): Promise<void> {
    const s = this.state
    if (!s) return
    const at = this.alarmAt(s)
    const writes: Promise<unknown>[] = [this.ctx.storage.put(STATE_KEY, s)]
    if (at !== null) writes.push(this.ctx.storage.setAlarm(at))
    await Promise.all(writes)
  }

  private setStage(outcome: OutcomeView, stage: Stage): void {
    outcome.stage = stage
    this.sendTo(outcome.playerId, { t: 'stage', id: outcome.playerId, stage }, true)
  }

  // ---------------------------------------------------------------- output

  private view(attachment: Attachment): RoomView {
    const s = this.state!
    const round = s.round
    const players: PlayerView[] = s.players.map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      survivals: p.survivals,
      history: p.history,
      connected: this.isConnected(p.id),
      submitted: Boolean(round?.plans[p.id]),
    }))

    let outcomes: Record<string, OutcomeView> = s.outcomes
    if (attachment.role === 'player') {
      outcomes = {}
      // A verdict unlocks when the projector shows it, not when its turn starts. If the host skipped
      // to the scores, the players never shown on the big screen stay private to themselves.
      const ended = s.phase === 'scores' || s.phase === 'final'
      const shown = round && (s.phase === 'reveal' || ended) ? round.revealIndex + (round.verdictShown ? 1 : 0) : 0
      const revealed = new Set(round ? round.order.slice(0, shown) : [])
      for (const [id, outcome] of Object.entries(s.outcomes)) {
        if (revealed.has(id) || (ended && id === attachment.playerId)) outcomes[id] = outcome
        else if (id === attachment.playerId) outcomes[id] = masked(outcome)
      }
    }

    return {
      code: s.code,
      phase: s.phase,
      // Players would otherwise see every upcoming scenario the host picked.
      settings: attachment.role === 'host' ? s.settings : { ...s.settings, scenarios: [] },
      players,
      round: round
        ? {
            id: round.id,
            number: round.number,
            scenario: round.scenario,
            deadline: round.deadline,
            order: round.order,
            revealIndex: round.revealIndex,
            verdictShown: round.verdictShown,
          }
        : null,
      outcomes,
      models: describeModels(this.env),
      you: attachment.playerId ?? null,
      yourPlan: (attachment.playerId && round?.plans[attachment.playerId]) || null,
      serverNow: Date.now(),
    }
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message))
    } catch {
      // Socket went away; its close handler cleans up.
    }
  }

  /** Host sockets whose session is still valid. Expired ones are told and closed. */
  private hostSockets(): WebSocket[] {
    return this.ctx.getWebSockets(HOST_TAG).filter((ws) => {
      const attachment = ws.deserializeAttachment() as Attachment | null
      return attachment ? this.hostValid(ws, attachment) : false
    })
  }

  /** Sends to every host, and optionally to the given player's own sockets. */
  private sendTo(playerId: string, message: ServerMessage, includePlayer: boolean): void {
    const data = JSON.stringify(message)
    const targets = this.hostSockets()
    if (includePlayer) targets.push(...this.ctx.getWebSockets(playerTag(playerId)))
    for (const ws of targets) {
      try {
        ws.send(data)
      } catch {
        // Socket went away.
      }
    }
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    // Players watch only their own reasoning; hosts watch everyone's.
    for (const [id, text] of this.pending) this.sendTo(id, { t: 'delta', id, field: 'reasoning', text }, true)
    this.pending.clear()
  }

  private broadcastState(): void {
    if (!this.state) return
    this.flush()
    const hosts = new Set(this.hostSockets())
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null
      if (!attachment || (attachment.role === 'host' && !hosts.has(ws))) continue
      this.send(ws, { t: 'state', state: this.view(attachment) })
    }
  }
}
