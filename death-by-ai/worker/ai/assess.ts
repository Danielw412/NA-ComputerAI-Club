/**
 * Deterministic plan analysis used by the mock narrator and the heuristic
 * judge: hashing, keyword extraction and a rough quality score.
 */

/** 32-bit FNV-1a. */
export function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32: a tiny seeded PRNG returning floats in [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const STOPWORDS = new Set(
  (
    'the a an and or but if then so to of in on at by for with from into onto out up down over under is are was were be been ' +
    'am i me my mine we us our you your he she it its they them their this that these those there here what which who whom ' +
    'will would should could can may might must shall do does did doing have has had having not no yes just very really ' +
    'also too as than about around through while before after until when where how why all any some each every both ' +
    'get got gets make makes made take takes took use uses using try tries going gonna wanna like okay ok im ill ive dont cant wont ' +
    'its thats theres lets let one two three thing things stuff something anything everything ' +
    // Particles and prepositions end a noun phrase ("the fire extinguisher off the wall").
    'off away back inside outside along across behind beside toward towards against upon without within near onto'
  ).split(' '),
)

const ACTION_VERBS = new Set(
  (
    'build built grab climb swim dive seal patch plug block jam wedge tie cut pry break smash hack reroute rewire wire short ' +
    'signal call radio flash shout yell whistle distract lure trap trick bait hide run sprint jump leap roll crawl slide ' +
    'vent flood drain pump burn light ignite extinguish freeze cool heat melt dig tunnel push pull lift throw toss fling ' +
    'launch eject inflate float paddle row steer drive fly glide parachute rappel lower hoist anchor brace barricade lock ' +
    'unlock open close shut disconnect unplug reboot restart override decode solve read follow map mark count time ' +
    'breathe exhale hold conserve ration share split trade negotiate bribe befriend tame feed sing dance improvise craft ' +
    'fashion rig attach strap wrap cover shield deflect redirect bounce reflect mirror pour spray coat'
  ).split(' '),
)

const SEQUENCE = /\b(then|first|second|next|while|before|after|until|so that|using|by|once|finally)\b/g
const LAZY = /\b(idk|i don'?t know|nothing|no idea|give up|accept|pray|cry|sleep|nap|panic|lol|lmao|whatever|hope|die|dunno)\b/
const INJECTION =
  /\b(?:(?:ignore|disregard|forget) (?:all |any |the |your |previous |prior |above |earlier )*(?:instructions|rules|prompt)|system prompt|as an ai\b|(?:you|narrator) must (?:let|make|say|write)|i (?:automatically |instantly |simply |just )?(?:survive|win)(?=\s*(?:[.!,;]|$))|i cannot die|i'?m immortal|i am immortal)/i
// Deliberately short and exact: enough to keep the mock from quoting rude words back on a projector.
const PROFANITY =
  /\b(?:f+u+c+k\w*|sh+i+t+(?:s|ty|ting|ted|head)?|bitch\w*|cunts?|puss(?:y|ies)|whores?|sluts?|bastards?|assholes?|nazis?|retard(?:s|ed)?|porn\w*|sex(?:y|ual)?|rap(?:e|ed|es|ing))\b/i

export interface PlanAssessment {
  /** Rough plan quality in [0, 1]. */
  score: number
  /** Integer 1–5. */
  cleverness: number
  /** Objects and ideas the plan relies on, most specific first. */
  things: string[]
  /** Action verbs the plan uses. */
  moves: string[]
  /** The first few words of the plan, for quoting. */
  snippet: string
  tooShort: boolean
  lazy: boolean
  injection: boolean
  offensive: boolean
}

export function assessPlan(plan: string): PlanAssessment {
  const text = plan.trim()
  const lower = text.toLowerCase()
  const words = lower.match(/[a-z0-9']+/g) ?? []
  const offensive = PROFANITY.test(lower)
  const injection = INJECTION.test(text)

  const content = [...new Set(words.filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w) && !w.includes("'")))]
  const actions = words.filter(isAction).length
  const sequence = lower.match(SEQUENCE)?.length ?? 0
  const tooShort = text.length < 15 || words.length < 4
  const lazy = LAZY.test(lower) && content.length < 7

  let score =
    Math.min(1, content.length / 12) * 0.4 +
    Math.min(1, actions / 3) * 0.3 +
    Math.min(1, sequence / 2) * 0.15 +
    (/\d/.test(text) ? 0.05 : 0) +
    Math.min(0.1, text.length / 800)
  if (lazy) score -= 0.35
  if (injection || offensive) score = 0
  score = Math.max(0, Math.min(1, score))

  const cleverness = tooShort || injection || offensive ? 1 : clampInt(1 + Math.round(score * 4), 1, 5)
  const things = offensive ? [] : objectsOf(lower, content)
  const moves = offensive ? [] : content.filter(isAction).slice(0, 3)
  const snippet = offensive ? '' : snippetOf(text, 8)

  return { score, cleverness, things, moves, snippet, tooShort, lazy, injection, offensive }
}

const DETERMINER = /\b(?:the|a|an|my|some|his|her|their|its|this|that|every|any)\s+((?:[a-z-]+\s+){0,3}[a-z-]+)/g
const NOT_NOUN = /(ly|ward|wards)$/

/**
 * Objects the plan relies on, in order of appearance: short noun phrases
 * after a determiner ("the emergency oxygen mask" → "oxygen mask"), falling
 * back to the longest plain words.
 */
function objectsOf(lower: string, content: string[]): string[] {
  const phrases: string[] = []
  for (const match of lower.matchAll(DETERMINER)) {
    const words: string[] = []
    for (const word of match[1].split(/\s+/)) {
      if (STOPWORDS.has(word) || isAction(word) || NOT_NOUN.test(word)) break
      words.push(word)
    }
    const phrase = words.slice(-2).join(' ')
    if (phrase.length >= 3 && !phrases.includes(phrase)) phrases.push(phrase)
  }
  const used = new Set(phrases.flatMap((p) => p.split(' ')))
  const singles = content
    .filter((w) => !used.has(w) && !isAction(w) && !NOT_NOUN.test(w) && !/(ing|ed)$/.test(w))
    .sort((a, b) => b.length - a.length)
  return [...phrases, ...singles].slice(0, 3)
}

function isAction(word: string): boolean {
  return ACTION_VERBS.has(word) || ACTION_VERBS.has(word.replace(/(ing|ed|es|s)$/, ''))
}

export function snippetOf(text: string, maxWords: number): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ')
  const cut = words.slice(0, maxWords).join(' ').replace(/[\s,;:.!?-]+$/, '')
  return words.length > maxWords ? `${cut}…` : cut
}

export function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** True for plans that cannot reasonably succeed: too short, lazy, an injection attempt or offensive. */
export function isDoomed(a: PlanAssessment): boolean {
  return a.tooShort || a.lazy || a.injection || a.offensive
}

/** A plan's survival chance from its quality alone, before any luck: about 1 in 10 for weak plans, 9 in 10 for strong ones. */
export function baseChance(a: PlanAssessment): number {
  if (isDoomed(a)) return 0.05
  return Math.min(0.92, Math.max(0.12, 0.1 + a.score * 0.9))
}
