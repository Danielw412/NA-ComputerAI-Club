# 67 SPEED

Browser-based webcam speed challenge for the NA Computer & AI Club. The frontend is React + TypeScript + Vite. Pose detection runs locally in the browser with MediaPipe. Supabase stores the shared leaderboard.

Production URL: `https://67.naclubs.net`

## Local development

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
```

Vite writes the deployable static site to `dist/`.

## Production architecture

- Cloudflare Pages hosts the static frontend at `67.naclubs.net`.
- MediaPipe model and WASM assets are served from the same Pages site.
- Webcam frames and pose inference stay in the user's browser.
- Supabase stores leaderboard entries only.
- No Cloudflare Worker, Pages Function, or inference server is required.

## 1. Create the Supabase backend

Create a dedicated Supabase project for 67 SPEED. Do not reuse an unrelated production project.

After the project is ready:

1. Open **SQL Editor** in Supabase.
2. Open `supabase/schema.sql` from this repository.
3. Run the entire file once.
4. Confirm that `public.scores` exists.
5. In **Settings > API Keys**, copy the **Publishable key** (`sb_publishable_...`). Do not use a secret/service-role key in the browser.
6. Copy the project API URL, which looks like `https://<project-ref>.supabase.co`.

The schema enables RLS and grants the public browser only the permissions required to read and insert leaderboard rows. Browser clients cannot update or delete scores.

## 2. Cloudflare Pages build settings

Create a Pages project from the GitHub repository `Danielw412/NA-ComputerAI-Club`.

Use these settings exactly:

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Root directory | `67speed` |
| Framework preset | `Vite` |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node version | `22.16.0` (pinned by `.node-version`) |

Because this repository contains multiple projects, configure **Settings > Build > Build watch paths** after the Pages project is created:

```text
Include paths: 67speed/*
Exclude paths: leave empty
```

That prevents unrelated changes elsewhere in the repository from rebuilding 67 SPEED.

## 3. Add Supabase environment variables

The production deployment requires these Vite build variables:

```text
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

In Cloudflare Pages, open **Settings > Variables and Secrets** and add both values for the production environment. Add the same values to preview deployments while testing the deployment PR.

These are build-time Vite variables. After adding or changing them, trigger a new deployment.

The publishable key is intentionally exposed to the browser. Security comes from Supabase RLS. Never put a Supabase secret key or service-role key in a `VITE_*` variable.

## 4. Test the deployment PR before merging

The Cloudflare deployment changes are prepared on the `cloudflare-pages-67speed` branch. Keep `main` as the Pages production branch.

After Git integration is connected, use the Cloudflare preview deployment for `cloudflare-pages-67speed` / PR #1 to test the final build before merging it. Cloudflare preview deployments do not replace the production deployment.

Verify all of the following on the preview URL:

1. The build completes successfully.
2. The home screen loads with the correct logo and font.
3. Starting a game prompts for camera permission over HTTPS.
4. The camera preview appears after permission is granted.
5. Pose tracking starts without a model or WASM loading error.
6. Solo mode counts repetitions and finishes normally.
7. Duel mode detects two players and keeps separate scores.
8. Submitting a leaderboard score succeeds.
9. Reloading the page still shows the shared Supabase leaderboard entry.
10. The browser console has no 401/403 errors from Supabase.

Only merge PR #1 after the preview passes these checks. Once merged, Cloudflare will automatically rebuild the `main` production deployment.

## 5. Connect `67.naclubs.net`

After the merged `main` deployment passes the same checks on its `*.pages.dev` URL:

1. Open the Pages project in Cloudflare.
2. Go to **Custom domains**.
3. Select **Set up a domain**.
4. Enter `67.naclubs.net`.
5. Activate the domain.

If `naclubs.net` is already managed in the same Cloudflare account, Cloudflare can create the required DNS record automatically. Otherwise, associate the custom domain in Pages first and then create the CNAME record requested by Cloudflare.

Do not merely create a CNAME manually without first adding the hostname under the Pages project's Custom domains section.

## Why the app must be at the domain root

The MediaPipe model, WASM, fonts, and favicon intentionally use root-relative paths such as:

```text
/models/pose_landmarker_lite.task
/mediapipe/wasm
/fonts/...
```

Hosting the app at `https://67.naclubs.net/` is therefore correct. Do not deploy it under a path such as `https://naclubs.net/67speed/` unless those paths are changed.

## Supabase leaderboard security note

The database rejects malformed names/modes/scores and blocks browser updates/deletes. However, because this is a public browser game with anonymous leaderboard submissions, a technically knowledgeable user can still call the public insert API directly and submit a fabricated score. RLS cannot prove that a score came from MediaPipe. For a club-fair leaderboard this may be acceptable; a cheat-resistant public leaderboard would require additional server-side verification.

## Files relevant to deployment

- `.node-version` — pins the Pages Node version.
- `.env.example` — documents required production environment variables.
- `supabase/schema.sql` — creates the leaderboard table, index, grants, constraints, and RLS policies.
- `public/models/pose_landmarker_lite.task` — vendored pose model.
- `public/mediapipe/wasm/` — vendored MediaPipe runtime.
