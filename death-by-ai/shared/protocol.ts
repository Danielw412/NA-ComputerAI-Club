/** Wire protocol shared by the Worker, the room Durable Object and the React app. */

export const LIMITS = {
  nameLength: 16,
  planLength: 200,
  scenarioLength: 240,
  /** The longest game, so a pick for every round fits. */
  scenarioPicks: 7,
  maxPlayers: 40,
  rounds: [3, 5, 7] as const,
  seconds: [45, 60, 90] as const,
  efforts: ['high', 'xhigh'] as const,
  /** The combined survival chance (percent) a player needs to survive. */
  thresholds: [30, 40, 50, 60, 70] as const,
}

/** How hard the narrator thinks. The host picks it per game when the narrator supports it. */
export type Effort = (typeof LIMITS.efforts)[number]

export type Phase = 'lobby' | 'writing' | 'judging' | 'reveal' | 'scores' | 'final'

export type Stage = 'queued' | 'thinking' | 'writing' | 'deciding' | 'done'

export interface Settings {
  rounds: number
  seconds: number
  effort: Effort
  /** Survive at this combined chance or higher, as a percent. */
  threshold: number
  /** The decision model votes. The host can switch it off and on at any point in the game. */
  decisionModel: boolean
  /**
   * Scenarios the host picked, played from round 1 in this order. Rounds past
   * the end of the list draw at random. Sent only to hosts.
   */
  scenarios: string[]
}

export interface ScenarioGroup {
  name: string
  scenarios: string[]
}

/** One entry per scored round. 'none' means no plan was submitted. */
export type Fate = 'survived' | 'died' | 'none'

export interface PlayerView {
  id: string
  name: string
  score: number
  survivals: number
  history: Fate[]
  connected: boolean
  /** Submitted a plan in the current round. */
  submitted: boolean
}

/** One model's own decision about a plan. */
export interface DecisionView {
  /** Chance the player survives, 0 to 1. */
  chance: number
  /** Integer 1–5. */
  cleverness: number
  model: string
  /** The configured model failed and a stand-in decided. */
  fallback: boolean
}

export interface OutcomeView {
  playerId: string
  plan: string
  stage: Stage
  reasoning: string
  /** Hidden from players until revealed. */
  story: string
  survived: boolean | null
  cleverness: number | null
  verdictReason: string
  /** The narrator's decision. Hidden from players until revealed. */
  narratorDecision: DecisionView | null
  /** The decision model's decision, shown as soon as it is ready (the player sees their own live). */
  judgeDecision: DecisionView | null
  /** The weighted chance (0 to 1) the verdict came from. Hidden from players until revealed. */
  chance: number | null
  points: number | null
  narrator: string
  judge: string
  fallback: boolean
}

export interface RoundView {
  /** Changes when a round starts or its scenario is swapped. Submissions must echo it. */
  id: string
  number: number
  scenario: string
  /** Epoch ms when writing closes (writing phase only). */
  deadline: number | null
  /** Reveal order (player ids that submitted a plan). */
  order: string[]
  /** Index into `order` currently on screen during reveal. */
  revealIndex: number
  /** The projector has shown the current player's verdict (phones unmask it now). */
  verdictShown: boolean
}

export interface RoomView {
  code: string
  phase: Phase
  settings: Settings
  players: PlayerView[]
  round: RoundView | null
  /**
   * Host: every outcome, live. Player: their own outcome while judging,
   * plus every outcome already revealed on the big screen.
   */
  outcomes: Record<string, OutcomeView>
  /**
   * Display names, the effort levels the host can choose between (empty when
   * there is no choice), and how much each model's decision counts.
   */
  models: { narrator: string; judge: string; efforts: Effort[]; weights: { narrator: number; judge: number } }
  /** The receiving player, for player sockets. */
  you: string | null
  /** The plan the server accepted from the receiving player this round. */
  yourPlan: string | null
  serverNow: number
}

export type ServerMessage =
  | { t: 'state'; state: RoomView }
  | { t: 'delta'; id: string; field: 'reasoning'; text: string }
  /** The decision model's decision for one plan, sent the moment it is ready. */
  | { t: 'decision'; id: string; decision: DecisionView }
  | { t: 'reset'; id: string }
  | { t: 'stage'; id: string; stage: Stage }
  | { t: 'error'; message: string }
  /** The socket is being closed for good (kicked, room closed). */
  | { t: 'bye'; reason: 'kicked' | 'closed' | 'expired' }

/**
 * Identifies the exact screen a host command was pressed on. The server drops
 * commands whose step no longer matches, so a double press or a late click
 * can't skip a player.
 */
export function stepKey(phase: Phase, round: Pick<RoundView, 'id' | 'revealIndex' | 'verdictShown'> | null): string {
  return `${phase}:${round?.id ?? ''}:${round?.revealIndex ?? 0}:${round?.verdictShown ? 1 : 0}`
}

export type HostMessage =
  | { t: 'settings'; settings: Partial<Settings> }
  | { t: 'start' }
  | { t: 'kick'; id: string }
  | { t: 'endWriting' }
  /** Advance: skip judging, next player, next round, or final results. */
  | { t: 'next'; at: string }
  | { t: 'showVerdict'; at: string }
  /** Jump from the reveal straight to the scoreboard. */
  | { t: 'skipReveal'; at: string }
  | { t: 'skipScenario' }
  /** Allowed in any phase: plans judged from now on use (or skip) the decision model. */
  | { t: 'decisionModel'; on: boolean }
  | { t: 'playAgain' }
  | { t: 'close' }

export type PlayerMessage = { t: 'submit'; plan: string; roundId: string }

export interface JoinResponse {
  playerId: string
  token: string
  name: string
}

export interface HostSession {
  token: string
  expiresAt: number
}

export function formatCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code
}

/** Collapse whitespace and strip control characters from user text. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const flat = value
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  // Count code points, not UTF-16 units, so emoji are never split in half.
  return Array.from(flat).slice(0, max).join('').trim()
}

/** The host's scenario picks, cleaned, without repeats, and no more than the longest game plays. Used on both sides. */
export function normalizePicks(list: readonly unknown[]): string[] {
  const out: string[] = []
  for (const item of list) {
    const scenario = cleanText(item, LIMITS.scenarioLength)
    if (scenario && !out.includes(scenario)) out.push(scenario)
    if (out.length === LIMITS.scenarioPicks) break
  }
  return out
}

export function pointsFor(survived: boolean, cleverness: number): number {
  return survived ? 100 + cleverness * 10 : 0
}
