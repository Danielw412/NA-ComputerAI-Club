# 67 SPEED

Browser-based webcam speed challenge for the NA Computer & AI Club. The app is a React + TypeScript + Vite static site. Pose detection runs locally in the browser with MediaPipe; there is no inference backend.

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

## Cloudflare Pages deployment

This project is designed to be hosted at the root of its own Pages domain or custom subdomain. Do not deploy it under a URL path such as `/67speed/`, because the MediaPipe model, WASM, fonts, and favicon intentionally use root-relative URLs.

Use these Cloudflare Pages settings:

| Setting | Value |
| --- | --- |
| Git repository | `Danielw412/NA-ComputerAI-Club` |
| Production branch | `main` |
| Root directory | `67speed` |
| Framework preset | `Vite` |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node version | `22.16.0` (pinned by `.node-version`) |

No Pages Functions, Workers, Wrangler configuration, or server runtime is required.

### Optional shared leaderboard

The game works without any environment variables and falls back to browser `localStorage` for the leaderboard.

To enable the existing Supabase-backed shared leaderboard, add these build environment variables in the Cloudflare Pages project:

```text
VITE_SUPABASE_URL=<your Supabase project URL>
VITE_SUPABASE_ANON_KEY=<your Supabase anon/publishable key>
```

These values are read by Vite at build time, so trigger a new deployment after adding or changing them.

### Custom domain

After the `*.pages.dev` deployment has been tested successfully, add the desired custom subdomain from the Pages project's **Custom domains** section. A domain such as `67.naclubs.net` is a good fit because the app expects to live at `/`.

## First-deployment checks

Before attaching a custom domain, test the generated `*.pages.dev` URL:

1. The home screen loads with the correct font/logo styling.
2. Starting a game prompts for camera permission over HTTPS.
3. After permission is granted, the camera preview appears and pose tracking starts without a model/WASM loading error.
4. Solo mode counts repetitions and finishes normally.
5. Duel mode detects two players and keeps separate scores.
6. Reloading the page still works from the site root.
7. If Supabase variables were configured, verify that leaderboard reads and writes are online. Otherwise, verify that the local leaderboard still works.

## Deployment notes

- MediaPipe assets are vendored under `public/`, so Vite copies them into the root of `dist/` unchanged.
- The pose model is loaded from `/models/pose_landmarker_lite.task`.
- MediaPipe WASM is loaded from `/mediapipe/wasm`.
- Webcam access requires a secure context; Cloudflare Pages serves the site over HTTPS.
