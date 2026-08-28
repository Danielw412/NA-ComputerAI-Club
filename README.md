<p align="center">
  <img src="67speed/public/na-club-logo-dark.png" alt="NA Computer &amp; AI Club" width="120">
</p>

<h1 align="center">NA Computer &amp; AI Club</h1>

<p align="center">
  Student-built software, computer vision, and machine learning projects.
</p>

## Featured project: 67 SPEED

[67 SPEED](https://67.naclubs.net) is a browser game that challenges one or two
players to pump their arms as fast as possible for 20 seconds. A webcam and
MediaPipe Pose count completed reps in real time.

Camera processing happens locally in the browser. The app does not upload or
record camera images. Players can optionally submit a nickname and score to a
shared Supabase leaderboard.

| Resource | Link |
| --- | --- |
| Play | [67.naclubs.net](https://67.naclubs.net) |
| Technical guide | [67speed/README.md](67speed/README.md) |
| Web app source | [67speed/](67speed/) |

### Technology

- React 19 and TypeScript
- Vite and Tailwind CSS
- MediaPipe Pose Landmarker
- Supabase Postgres
- Cloudflare Pages

## Other projects

### NA Schedule Share

Share and compare class schedules with other students.

- [Live site](https://schedule.naclubs.net)
- [Source repository](https://github.com/Danielw412/NA-ScheduleShare)

### Computer vision demos

The [`demos/`](demos/) directory contains the Python and OpenCV experiments
that led to 67 SPEED, including full-body tracking and a desktop version of the
game.

Install the demo dependencies and run either script:

```bash
pip install numpy opencv-contrib-python mediapipe
python demos/speed_67_demo.py
python demos/human_tracking_demo.py
```

The desktop 67 SPEED demo uses these controls:

| Key | Action |
| --- | --- |
| `Space` or `S` | Start or play again |
| `R` | Restart |
| `1` or `2` | Choose the player count |
| `F` | Toggle fullscreen |
| `Q` or `Esc` | Quit |

## Repository structure

```text
67speed/  React and TypeScript web game
demos/    Standalone Python computer vision demos
.github/  Continuous integration workflows
```

## Develop 67 SPEED locally

Requirements:

- Node.js 22.16.0, as pinned in `67speed/.node-version`
- npm
- A webcam for end-to-end game testing

```bash
cd 67speed
npm ci
npm run dev
```

The app opens on `http://localhost:5173` by default.

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run build` | Type-check and create a production build |
| `npm run lint` | Run Oxlint |
| `npm test` | Run the pose and leaderboard tests |
| `npm run tune` | Evaluate rep-counter settings with synthetic signals |
| `npm run check:db` | Check the configured Supabase leaderboard |

The game works without Supabase by using a browser-local leaderboard. To test
the shared leaderboard, copy `67speed/.env.example` to `67speed/.env.local` and
provide the public Supabase URL and publishable key. Never place a secret or
service-role key in a `VITE_*` variable.

## Privacy and safety

67 SPEED performs pose detection on the player's device. Camera images, pose
landmarks, and movement data are not sent to the club. The only optional public
submission is a leaderboard nickname and game result.

Players should use a non-identifying nickname and leave the leaderboard blank
if they are under 13. The in-app Privacy Notice and Terms of Use contain the
current details and should be updated whenever data handling changes.

The game involves fast arm movement. Test and play it with enough clear space,
and stop immediately if anyone feels pain, dizziness, or discomfort.

## Contributing

1. Create a focused branch.
2. Make and test your changes.
3. Open a pull request with a clear summary and verification notes.
4. Wait for the `67speed build` workflow when the change touches `67speed/`.

Please keep camera processing on-device, preserve keyboard and mobile support,
and update tests or documentation when behavior changes.

## Affiliation

This repository is an independent student project by the NA Computer & AI Club.
It is not operated, sponsored, endorsed, or reviewed by the North Allegheny
School District, any North Allegheny school, or their staff.
