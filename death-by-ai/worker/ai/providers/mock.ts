/**
 * Offline narrator and judge. Everything is derived from a hash of the
 * scenario, player name and plan, so the same input always produces the same
 * trace, decision and endings. The narrator and the judge hash with different
 * seeds, so like two real models they sometimes disagree about a plan.
 * Templates are filled with words from the plan so the trace reads like a
 * model actually considered it.
 */
import { assessPlan, baseChance, clampInt, hash, isDoomed, seededRandom, snippetOf } from '../assess.ts'
import type { PlanAssessment } from '../assess.ts'
import { sleep } from '../http.ts'
import { playerName } from '../prompts.ts'
import type { NarrationEvent, PlanInput } from '../types.ts'
import type { Judgement } from '../verdict.ts'

export interface MockNarration {
  reasoning: string
  /** 0 to 1, a whole percent. */
  chance: number
  cleverness: number
  stories: { survived: string; died: string }
}

/** What the mock narrator streams: its reasoning, then its decision. */
export type MockEvent = Exclude<NarrationEvent, { type: 'reset' }>

type Slots = Record<'name' | 'thing' | 'thing2' | 'move' | 'snip' | 'setup', string>
type Pick = (templates: readonly string[]) => string

// ---- Reasoning trace -------------------------------------------------------

const OPEN = [
  '{setup} The plan: "{snip}".',
  'Okay. {setup} And the plan is "{snip}".',
  'Let me read this carefully. {setup} {name} wrote: "{snip}".',
  '{setup} {name} is going with "{snip}". Let me think about whether that works.',
  'Alright, {name}\'s turn. {setup} Plan: "{snip}".',
  'Hmm. {setup} The answer {name} typed is "{snip}".',
  'So, {setup} {name}\'s idea: "{snip}". Interesting.',
  'New plan to evaluate. {setup} It says "{snip}".',
]
const OPEN_NO_SNIP = [
  '{setup} Let me look at what {name} submitted.',
  'Okay, {name}\'s turn. {setup}',
  'Hmm. {setup} Let me see what {name} came up with.',
]

const PROS = [
  'The key move is "{move}". That\'s concrete, which I like.',
  'Using the {thing} is actually smart. It directly addresses the problem.',
  '"{move}" plus the {thing}. That\'s a real method, not wishful thinking.',
  'There are actual steps here: "{move}" first, then the {thing}.',
  'The {thing} is doing a lot of work in this plan, and honestly it could hold up.',
  'Mentioning the {thing} shows {name} actually read the scenario.',
  'Physically, "{move}" could work if the timing is right.',
  'I like that the {thing} buys time instead of just hoping for the best.',
  'The {thing} and the {thing2} together cover the two biggest problems.',
  'It\'s specific. {name} isn\'t just saying "I escape", there\'s a how.',
  'Points for using what\'s actually around: the {thing} is a clever resource.',
  'This is the kind of practical thinking that tends to work: "{move}", step by step.',
]
const CONS = [
  'But is "{move}" fast enough? The clock is the real enemy here.',
  'Weak point: nothing explains what happens if the {thing} fails.',
  'I\'m not convinced the {thing2} is realistic under this much pressure.',
  'Counterpoint: this assumes everything goes perfectly the first time.',
  'One problem. The plan skips over the hardest part entirely.',
  'There\'s a gap between the {thing} and actually getting out.',
  'Wait, does {name} even have a {thing}? That\'s a stretch.',
  'Downside: "{move}" takes strength and calm, and nobody is calm right now.',
  'The order of steps worries me. If the {thing} comes too late, it\'s useless.',
  'It\'s a bit optimistic about how cooperative the {thing} is going to be.',
]
const GOOD_FILLER = [
  'Honestly, this is more creative than I expected.',
  'Let me think about the physics for a second... yeah, it mostly checks out.',
  'It\'s more specific than most plans I see in a round like this.',
  'If I imagine it step by step, each step is at least possible.',
  'There\'s a backup in there, too, which matters when things go wrong.',
]
const BAD_FILLER = [
  'Let me think about the physics for a second... that\'s a lot to ask.',
  'If I picture it step by step, the second step is where it falls apart.',
  'It sounds confident, but confidence isn\'t a tool.',
  'I want to like it, but the details are doing nothing.',
  'This would need a lot to go right, all at once.',
]
const LAZY = [
  'That\'s... not really a plan. It\'s barely a sentence.',
  'There\'s nothing actionable here. No method, no tools, no steps.',
  'Vague plans don\'t survive scenarios like this one.',
  'I was hoping for specifics. I got vibes.',
  'This reads like {name} ran out of time to type.',
  'No tools, no timing, no idea what happens next. That\'s a problem.',
  'Even being generous, I can\'t find a survival strategy in there.',
  'The danger is very specific. The plan is not.',
]
const INJECTION = [
  'Ha. The plan tries to give me instructions directly. That\'s not how this works.',
  'That\'s an attempt to talk to the narrator. I\'ll treat it as something {name} yells at the sky.',
  'Declaring "I survive" isn\'t a survival strategy. The universe heard it, though.',
  'Nice try. Rules-lawyering the narrator doesn\'t stop the danger.',
  'So the plan is to order me around. In the story, that\'s just {name} shouting.',
]
const OFFENSIVE = [
  'I\'m not going to repeat that. It\'s not a plan, it\'s just rude.',
  'That isn\'t projector-appropriate. The universe is going to respond.',
  'There\'s no survival strategy in there, just an attempt to be offensive.',
  'Not repeating that one. Karma gets to write this ending.',
]
const LUCK_GOOD = [
  'Then there\'s luck. Rolling the dice... it lands in {name}\'s favour.',
  'Luck matters too, and right now it\'s on {name}\'s side.',
  'Factoring in a little chaos, the odds still look decent.',
  'A bit of luck goes a long way here, and {name} gets some.',
]
const LUCK_BAD = [
  'Then there\'s luck. Rolling the dice... not great.',
  'Luck matters too, and tonight it isn\'t cooperating.',
  'Factoring in a little chaos, the odds get worse, not better.',
  'Even a lucky break wouldn\'t cover the gaps here, and there isn\'t one.',
]
// The trace leans one way in words but never states the number: the reveal stays a surprise.
const DECIDE_LIVE = [
  'I have my number. On balance, this holds together.',
  'More likely than not, I think {name} has a real shot.',
  'Weighing it all up, the plan mostly holds.',
  'I can see a way out here, if the timing works.',
]
const DECIDE_DIE = [
  'I have my number, and it is not a comfortable one.',
  'On balance, the odds look stacked against {name}.',
  "Weighing it all up, I don't think it holds.",
  'I can see this going wrong in a lot of ways.',
]

// ---- Story ------------------------------------------------------------------
// Each ending's final sentence carries the outcome; earlier sentences avoid
// outcome words, so both endings read unambiguously.

const ATTEMPT = [
  '{name} takes a deep breath and commits to the plan: "{snip}".',
  'Without hesitating, {name} goes for it: "{snip}".',
  '{name} cracks their knuckles and announces the plan: "{snip}".',
  'Everyone watches as {name} attempts "{snip}".',
  '{name} whispers "okay, here goes" and starts with the {thing}.',
  '{name} goes straight for the {thing}, moving fast.',
  'With no time to waste, {name} gets to work on the {thing}.',
  '{name} mutters "{snip}" one more time and begins.',
  'Heart pounding, {name} reaches for the {thing}.',
]
const ATTEMPT_LAZY = [
  '{name} tries the plan: "{snip}".',
  '{name} confidently announces "{snip}" and waits.',
  '{name} goes with "{snip}", and that is about it.',
]
const ATTEMPT_NO_SNIP = [
  '{name} faces the danger with no real plan at all.',
  '{name} shrugs at the danger and hopes for the best.',
]
const MIDDLE_GOOD = [
  'Against all odds, the {thing} works exactly as intended.',
  'It is not elegant, but the {thing} buys precious seconds.',
  'The {thing} holds, which surprises everyone, including {name}.',
  'A nervous moment passes, then the {thing} does its job.',
  'Physics, for once, cooperates.',
  'Somewhere a physics teacher nods approvingly.',
  'The timing is tight, but it is enough.',
  'There is a terrifying wobble, then everything clicks into place.',
  'Step by step, the plan comes together like it was rehearsed.',
]
const MIDDLE_BAD = [
  'Unfortunately, the {thing} turns out to be much harder to use than it sounded.',
  'The {thing} works for about three seconds.',
  'Physics files a formal complaint and wins.',
  'Halfway through, {name} realizes the plan has a very big gap.',
  'Things go sideways the moment the {thing} comes into play.',
  'It is a bold idea, but the clock disagrees.',
  'Then {name} trips over their own plan.',
  'The {thing} has other ideas.',
  'Step two, it turns out, was never really thought through.',
]
const MIDDLE_LAZY = [
  'That is the entire plan.',
  'The danger waits politely for a second step that never comes.',
  'Nobody, including {name}, knows what was supposed to happen next.',
  'The universe gives it a moment of polite silence.',
]
const MIDDLE_INJECTION = [
  '{name} shouts "{snip}" at the sky, very confidently.',
  '{name} reads the plan aloud like a legal document: "{snip}".',
]
const AFTER_INJECTION = [
  'The universe considers this request and declines.',
  'Reality does not take instructions from players.',
  'The narrator, unmoved, keeps narrating.',
]
const OFFENSIVE_STORY = [
  '{name} tries something so rude that the universe itself is offended.',
  '{name} opens their mouth, and a cosmic referee immediately blows a whistle.',
  '{name} attempts a plan that cannot be described on a school projector.',
]
const LUCKY_BREAK = [
  'Then, by sheer dumb luck, the danger simply loses interest.',
  'A ridiculous coincidence does all the work instead.',
  'Fate, feeling generous today, looks the other way.',
  'The universe sighs and lets it slide, just this once.',
]
const AFTER_OFFENSIVE = [
  'Karma arrives early and in a bad mood.',
  'A penalty flag the size of a bus drops from the sky.',
  'The universe responds with a single, very large anvil.',
]
const TWIST_GOOD = [
  'A lucky gust of wind helps at the very last second.',
  '{name} even remembers to look cool doing it.',
  'The crowd goes wild.',
  'A passing pigeon seems impressed.',
]
const TWIST_BAD = [
  'A seagull appears out of nowhere and makes everything worse.',
  'The backup plan was, sadly, the same plan.',
  'For a moment, it almost looks like it might work.',
  'A dramatic soundtrack starts playing, which is never a good sign.',
]
const END_LIVE = [
  '{name} survives, breathless and grinning.',
  '{name} escapes with seconds to spare and survives the round.',
  'Battered but alive, {name} survives to play another round.',
  '{name} makes it out alive.',
  'Against the odds, {name} survives.',
  '{name} walks away unharmed and extremely smug.',
  '{name} is rescued an hour later, alive and a little too proud.',
  '{name} survives, and will not stop talking about it.',
  'Somehow, {name} escapes completely unscathed.',
]
const END_DIE = [
  '{name} does not survive.',
  '{name} dies, dramatically and a little embarrassingly.',
  'And that is how {name} dies.',
  '{name} perishes, but with great style.',
  'Game over: {name} is dead.',
  '{name} is doomed, and the scoreboard agrees.',
  '{name} meets a swift and cartoonish demise.',
  'Sadly, {name} perishes before the clock runs out.',
  '{name} is never seen again, and is presumed dead.',
]

// ---- Verdict reasons --------------------------------------------------------

const REASON_LIVE = [
  'A concrete, workable plan, and luck cooperated.',
  'Using the {thing} was specific enough to actually work.',
  'Clear steps and believable physics got them out.',
  'Practical and specific: the {thing} made the difference.',
  'Risky, but the plan had a real method behind it.',
]
const REASON_DIE = [
  'Decent idea, but the timing fell apart.',
  'The plan skipped the hardest part of the problem.',
  'Luck ran out before the {thing} could save them.',
  'Too optimistic; the {thing} was never going to be enough.',
  'Creative, but physically it just doesn\'t hold up.',
]
const REASON_LUCKY = ['Pure luck; the plan itself did very little.', 'Fate was generous, even if the plan was not.']
const REASON_LAZY = ['Too vague to survive; there was no real plan.', 'A few words is not a survival plan.', 'No method, no tools, no chance.']
const REASON_INJECTION = ['Ordering the narrator around is not a survival strategy.', 'Declaring victory is not the same as earning it.']
const REASON_OFFENSIVE = ['Rude plans earn comedic consequences, not survival.', 'Not a real plan, and not projector-appropriate.']

export function mockNarration(input: PlanInput): MockNarration {
  const name = playerName(input.playerName)
  const plan = input.plan.trim()
  const a = assessPlan(plan)
  const random = seededRandom(hash(`${input.scenario}\u0000${name}\u0000${plan}`))
  const chance = gutChance(a, random())
  const slots = slotsFor(input, a, name)
  const pick = picker(slots, random)

  const lean = chance >= 0.5
  const lines = isDoomed(a) ? doomedTrace(a, pick, random) : weighedTrace(a, lean, pick, random)
  const stories = isDoomed(a) ? doomedStories(a, pick) : weighedStories(pick, random)
  return { reasoning: lines.filter(Boolean).join('\n'), chance, cleverness: a.cleverness, stories }
}

/** The mock judge: its own opinion of the plan, from a different seed than the mock narrator. */
export function mockJudgement(input: PlanInput): Judgement {
  const name = playerName(input.playerName)
  const plan = input.plan.trim()
  const a = assessPlan(plan)
  const random = seededRandom(hash(`judge\u0000${input.scenario}\u0000${name}\u0000${plan}`))
  const chance = gutChance(a, random())
  const nudge = random()
  const cleverness = isDoomed(a) ? a.cleverness : clampInt(a.cleverness + (nudge < 0.2 ? -1 : nudge >= 0.8 ? 1 : 0), 1, 5)
  const pick = picker(slotsFor(input, a, name), random)
  const died = a.offensive ? REASON_OFFENSIVE : a.injection ? REASON_INJECTION : isDoomed(a) ? REASON_LAZY : REASON_DIE
  return { chance, cleverness, reasons: { survived: pick(isDoomed(a) ? REASON_LUCKY : REASON_LIVE), died: pick(died) } }
}

/**
 * Streams a narration's reasoning as word-sized chunks, pausing `delayMs`
 * between them and a little longer at line breaks, then the decision, then a
 * pause while the endings are "written", like a model would.
 */
export async function* streamMock(narration: MockNarration, delayMs: number, signal?: AbortSignal): AsyncGenerator<MockEvent> {
  let previous = ''
  for (const delta of words(narration.reasoning)) {
    signal?.throwIfAborted()
    const pause = previous.endsWith('\n') ? delayMs * 5 : delayMs
    if (pause > 0) await sleep(pause, signal)
    previous = delta
    yield { type: 'reasoning', delta }
  }
  if (delayMs > 0) await sleep(delayMs * 5, signal)
  signal?.throwIfAborted()
  yield { type: 'decision', chance: narration.chance, cleverness: narration.cleverness }
  // About as long as streaming two short endings would take.
  if (delayMs > 0) await sleep(delayMs * 30, signal)
  signal?.throwIfAborted()
}

/** A gut-feel chance: the plan's quality plus a seeded roll of luck, as a whole percent. */
function gutChance(a: PlanAssessment, roll: number): number {
  const raw = isDoomed(a) ? 0.02 + roll * 0.1 : Math.min(0.96, Math.max(0.04, baseChance(a) + (roll - 0.5) * 0.5))
  return Math.round(raw * 100) / 100
}

function slotsFor(input: PlanInput, a: PlanAssessment, name: string): Slots {
  return {
    name,
    thing: a.things[0] ?? '',
    thing2: a.things[1] ?? '',
    move: a.moves[0] ?? '',
    snip: a.snippet,
    setup: setupSentence(input.scenario, name),
  }
}

function picker(slots: Slots, random: () => number): Pick {
  return (templates) => {
    const usable = templates.map((t) => fill(t, slots)).filter((t): t is string => t !== null)
    return usable.length ? usable[Math.floor(random() * usable.length)] : ''
  }
}

function weighedTrace(a: PlanAssessment, lean: boolean, pick: Pick, random: () => number): string[] {
  // `lean` is true when the chance is at least 50%.
  const strong = a.score >= 0.5
  const lines = [pick(OPEN), pick(PROS)]
  if (random() < 0.5) lines.push(pick(PROS))
  lines.push(pick(CONS))
  if (random() < 0.6) lines.push(pick(strong ? GOOD_FILLER : BAD_FILLER))
  // Mention luck whenever the outcome runs against the plan's quality, so the trace explains it.
  if (lean !== strong || random() < 0.5) lines.push(pick(lean ? LUCK_GOOD : LUCK_BAD))
  lines.push(pick(lean ? DECIDE_LIVE : DECIDE_DIE))
  return dedupe(lines)
}

function doomedTrace(a: PlanAssessment, pick: Pick, random: () => number): string[] {
  const open = pick(a.snippet ? OPEN : OPEN_NO_SNIP)
  const lines = [open]
  if (a.offensive) lines.push(pick(OFFENSIVE), pick(OFFENSIVE))
  else if (a.injection) lines.push(pick(INJECTION), pick(INJECTION))
  else lines.push(pick(LAZY), pick(LAZY))
  if (random() < 0.5) lines.push(pick(LUCK_BAD))
  lines.push(pick(DECIDE_DIE))
  return dedupe(lines)
}

/** Both endings share their opening, so they read as two outcomes of the same attempt. */
function weighedStories(pick: Pick, random: () => number): MockNarration['stories'] {
  const opening = pick(ATTEMPT)
  const survived = [opening, pick(MIDDLE_GOOD)]
  if (random() < 0.45) survived.push(pick(TWIST_GOOD))
  survived.push(pick(END_LIVE))
  const died = [opening, pick(MIDDLE_BAD)]
  if (random() < 0.45) died.push(pick(TWIST_BAD))
  died.push(pick(END_DIE))
  return { survived: fitStory(dedupe(survived)), died: fitStory(dedupe(died)) }
}

function doomedStories(a: PlanAssessment, pick: Pick): MockNarration['stories'] {
  const [opening, middle] = a.offensive
    ? [pick(OFFENSIVE_STORY), pick(AFTER_OFFENSIVE)]
    : a.injection
      ? [pick(MIDDLE_INJECTION), pick(AFTER_INJECTION)]
      : [pick(a.snippet ? ATTEMPT_LAZY : ATTEMPT_NO_SNIP), pick(MIDDLE_LAZY)]
  return {
    survived: fitStory(dedupe([opening, pick(LUCKY_BREAK), pick(END_LIVE)])),
    died: fitStory(dedupe([opening, middle, pick(END_DIE)])),
  }
}

/** Keeps the story under 90 words by dropping middle sentences, never the outcome. */
function fitStory(sentences: string[]): string {
  const s = sentences.filter(Boolean)
  while (s.length > 2 && wordCount(s.join(' ')) >= 90) s.splice(s.length - 2, 1)
  return s.join(' ')
}

function setupSentence(scenario: string, name: string): string {
  const flat = scenario.replace(/\s+/g, ' ').trim()
  // Quote the first sentence whole; if it runs long, stop at a comma rather than mid-phrase.
  let first = flat.split(/(?<=[.!?])\s/)[0] ?? ''
  if (first.split(' ').length > 22) first = first.split(',')[0]
  const short = (first.split(' ').length > 22 ? snippetOf(first, 22) : first).replace(/[.!?…]+$/, '')
  const you = /^(you'?re|you are|youre)\s+/i.exec(short)
  if (you) return `${name} is ${short.slice(you[0].length)}.`
  return short ? `The scenario: ${short}.` : `${name} is in serious trouble.`
}

/** Fills `{slot}` placeholders; returns null if a template needs a slot that is empty. */
function fill(template: string, slots: Slots): string | null {
  let missing = false
  const out = template.replace(/\{(\w+)\}/g, (_, key: keyof Slots) => {
    const value = slots[key]
    if (!value) missing = true
    return value ?? ''
  })
  return missing ? null : out
}

function dedupe(lines: string[]): string[] {
  return [...new Set(lines.filter(Boolean))]
}

function words(text: string): string[] {
  return text.match(/\S+\s*/g) ?? []
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}
