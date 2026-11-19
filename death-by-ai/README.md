# Exit Code

A survival party game for the NA Computer & AI Club. The host puts a game on the
projector and players join on their phones with a six-digit code. Each round
shows a deadly scenario. Players type a plan, and two models judge every plan
at the same time: one reasons about it live on screen and writes what happens,
and a second casts its own vote. Their weighted call decides who survives.
Survivors score points over several rounds.

The project folder is `death-by-ai`. It runs entirely on Cloudflare Workers.

**Play it:** [death-by-ai.nacomputerclub.workers.dev](https://death-by-ai.nacomputerclub.workers.dev)
(hosting a game needs the club's host password)

| | |
| --- | --- |
| Built with | React, TypeScript, Vite, Cloudflare Workers and Durable Objects, Claude API, Workers AI |
| Run it locally | [Run it on your computer](#run-it-on-your-computer) |
| Main code | [`src/`](src/) has the screens, [`worker/`](worker/) has the server, [`worker/ai/`](worker/ai/) talks to the AI models |
| Easiest change | Add a scenario to [`scenarios.txt`](scenarios.txt) |

## How a round works

1. The host starts a round and everyone sees the scenario. It is one the host
   picked in the lobby, or one drawn at random from `scenarios.txt`.
2. Players type a survival plan of up to 200 characters before the timer ends.
3. For every plan, two models read the scenario and plan at the same time, and
   each decides a survival chance and a cleverness score from 1 to 5:
   - **LLM** (80% of the decision). Streams its reasoning trace to the
     projector and to that player's phone. Then it gives its decision and writes
     two endings: one where the player survives and one where they die.
   - **Decision Model** (20%). Its call appears on the projector and the
     player's phone the moment it's ready, for example "Decision Model 18%".
4. The game weighs the two chances. Reaching the survive line (50% unless the
   host changes it) is a survival, and the matching ending becomes the story.
   Cleverness is weighed the same way.
5. The host reveals the players one at a time. The story types out, the verdict
   wipes across the screen, and a line shows each model's call, for example
   "LLM 72% · Decision Model 18% · 61% overall".

The screens call the two models **LLM** and **Decision Model**, whichever
providers are configured.

**Host controls for the decision:**
- **Survive at** (lobby): the combined chance a player needs, 30% to 70%.
- **Decision Model** on or off: in the lobby, or at any point in the game from
  the top bar. While it's off, the LLM decides alone. A switch during judging
  applies to every plan that hasn't finished yet.
6. Points: a survival is worth 100 plus 10 × cleverness. A death scores 0.

## Architecture

| Piece | Where |
| --- | --- |
| React app (host and player screens) | `src/` |
| Worker routes and host sign-in | `worker/index.ts`, `worker/auth.ts` |
| One Durable Object per game room | `worker/room.ts` |
| Model providers and prompts | `worker/ai/` |
| Scenario list | `scenarios.txt` |
| Wire protocol shared by both sides | `shared/protocol.ts` |

Each room is a Durable Object, addressed by its join code. Clients connect
with hibernatable WebSockets. The room stores the whole game as one value,
so the object can sleep between events. Model calls run in the room's alarm
handler, and reasoning deltas are batched and pushed to screens as they
arrive.

## Host password

Hosting is locked behind one shared password, stored as the Worker secret
`HOST_PASSWORD`. A host types it once per device and gets a signed session that
lasts `HOST_SESSION_HOURS` (12 by default). Changing the secret signs every
host out. Sign-in attempts are limited to 10 per minute per IP.

```bash
npx wrangler secret put HOST_PASSWORD
# Optional: any long random string. Protects the password if a session token leaks.
npx wrangler secret put HOST_SESSION_SECRET
```

Socket credentials travel in the WebSocket subprotocol header, not in the URL,
so they don't show up in request logs.

## Scenarios

`scenarios.txt` holds the scenario list, one per line, grouped under `## `
headings. Lines starting with `#` are comments. Add, edit or remove lines, then
redeploy.

In the lobby, the host can leave **Scenarios** on **Random** or choose
**Choose** to pick from the list or write their own. Picks play first, in the
order they were picked. Any rounds left over are drawn at random, without
repeats. **New scenario** during a round always draws at random.

Phones never receive the picks, but the picker opens on whichever screen you
press **Choose** on. To keep the picks secret from the room, pick before you
put the lobby on the projector, or sign in on your own device, open
`/host/<code>` there and pick from that device.

## Models

By default, the LLM is **Claude Haiku 5.5** through the Claude API, and the
Decision Model is **Clef Flash**, Cloudflare's decision model on Workers AI.

- **Narrator.** Haiku runs with adaptive thinking, and its summarized thinking
  streams to the screens as the reasoning trace. The host chooses the effort
  for each game in the lobby: **High** or **Extra high** (`xhigh`).
- **Decision model.** Clef reads the scenario and plan and answers four typed
  questions in one call: would the plan get the player out alive (a probability),
  how clever is it (1 to 5), and the main reason a player with this plan would
  survive or die. The reason that matches the final verdict is shown. Clef runs
  through the Worker's `AI` binding, so it needs no API key. The larger
  `@cf/cloudflare/clef` also works, at about 6× the Workers AI cost.
- **Weights.** `JUDGE_WEIGHT` sets how much the decision model counts (0.2 by
  default); the LLM counts for the rest. If one model fails and a stand-in
  fills in, the other model decides alone.

The narrator and the decision model are configured separately, so either can be
switched to another provider. Set the vars in `wrangler.jsonc`, and set the
keys as secrets.

| Var | Values |
| --- | --- |
| `NARRATOR_PROVIDER` | `anthropic` (default), `openai`, `openai-responses`, `gemini`, `mock` |
| `JUDGE_PROVIDER` | `clef` (default), `anthropic`, `openai`, `openai-responses`, `gemini`, `mock` |
| `NARRATOR_MODEL`, `JUDGE_MODEL` | Model ID: `claude-haiku-5-5` and `@cf/cloudflare/clef-flash` by default |
| `NARRATOR_BASE_URL`, `JUDGE_BASE_URL` | Optional, for OpenAI-compatible hosts |
| `NARRATOR_REASONING` | `high` (native thinking, effort chosen by the host), `tags` (asks the model to think in `<think>` tags) or `off` |
| `NARRATOR_MAX_TOKENS` | Output cap, including thinking. 32000 in `wrangler.jsonc`. |
| `JUDGE_WEIGHT` | How much the decision model's call counts, 0 to 1. 0.2 in `wrangler.jsonc`. |
| `AI_TIMEOUT_SECONDS` | Timeout for each model call. 90 in `wrangler.jsonc`. |
| `AI_CONCURRENCY` | Plans judged at once in a room, 1 to 20. 12 in `wrangler.jsonc`. Lower it if your Claude API tier rate-limits you. |
| `AI_PLANS_PER_RUN` | Plans started per run of the room. A plan can make up to 6 requests with retries, so 8 keeps a run under the Workers Free plan's 50. Raise it on Workers Paid. |

```bash
npx wrangler secret put NARRATOR_API_KEY   # your Claude API key
npx wrangler secret put JUDGE_API_KEY      # only if the judge uses a keyed provider
```

`openai` covers any Chat Completions-compatible API: OpenAI, OpenRouter, Groq,
DeepSeek, Together, xAI, Ollama, and Cloudflare Workers AI at
`https://api.cloudflare.com/client/v4/accounts/<account-id>/ai/v1`. Reasoning
is read from `reasoning_content`, `reasoning` or `<think>` blocks, whichever
the host returns.

If a provider fails, the game retries once and then falls back, so a round never
stalls: the narrator to the built-in mock, and the judge to a simple heuristic
that scores the plan. If one side falls back, the model that still works decides
alone; if both do, the two stand-ins are weighed as usual. With the mock
providers, the whole game runs offline, which is useful for rehearsals.

## Run it on your computer

Requires Node 22.12 or newer. Works on Windows, macOS and Linux.

```bash
cd death-by-ai
npm install
cp .dev.vars.example .dev.vars   # PowerShell: Copy-Item .dev.vars.example .dev.vars
# then set HOST_PASSWORD and NARRATOR_API_KEY in .dev.vars
npm run dev
```

Open `/host` on one screen and the root URL on a phone or a second browser.

Clef runs on Workers AI even in local dev, so `npm run dev` needs a Cloudflare
login (`npx wrangler login`), and Clef calls count against that account's Workers AI
usage. Set `CLOUDFLARE_ACCOUNT_ID` if your login reaches more than one account
(PowerShell: `$env:CLOUDFLARE_ACCOUNT_ID = "..."`).

No Cloudflare account? Set `NARRATOR_PROVIDER=mock` and `JUDGE_PROVIDER=mock` in
`.dev.vars` and run `npm run dev:offline`. The built-in mock models play the whole
game with no network.

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with the Worker and Durable Objects running locally |
| `npm run dev:offline` | The same, without the Workers AI connection or a Cloudflare login |
| `npm test` | Unit tests |
| `npm run build` | Type-check and build |
| `npm run deploy` | Build and deploy to Cloudflare |

## Deploy

```bash
npx wrangler login
npx wrangler secret put HOST_PASSWORD
npx wrangler secret put NARRATOR_API_KEY
npm run deploy
```

If your login can reach more than one Cloudflare account, set
`CLOUDFLARE_ACCOUNT_ID` first.
