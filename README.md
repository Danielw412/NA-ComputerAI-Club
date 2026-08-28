<p align="center">
  <img src="67speed/public/na-club-logo-dark.png" alt="NA Computer &amp; AI Club" width="120">
</p>

<h1 align="center">NA Computer &amp; AI Club</h1>

<p align="center">
  Student-built software and machine-learning projects from the NA Computer &amp; AI Club.
</p>

---

## 🏆 Featured — 67 SPEED

**Pump your arms as fast as you can for 20 seconds. A webcam counts every rep.**

A browser game we built for the club fair. It uses real-time pose estimation to
track your arms through motion blur, counts reps with a self-calibrating signal
detector, and keeps an all-time leaderboard. Everything the camera sees is
processed on your own device — no video is ever uploaded.

| | |
| --- | --- |
| **Play it** | **[67.naclubs.net](https://67.naclubs.net)** |
| **How it works** | [The computer vision behind it →](67speed/README.md#how-it-works) |
| **Source** | [`67speed/`](67speed/) |
| **Built with** | React · TypeScript · Vite · MediaPipe Pose · Supabase · Cloudflare Pages |

> **Curious how a webcam counts reps at 30+ frames per second — and why shaking
> the laptop doesn't score you any points?**
> [Read the write-up →](67speed/README.md#how-it-works)

---

## Other projects

| Project | What it is | Links |
| --- | --- | --- |
| **NA Schedule Share** | Share and compare class schedules. | [Live](https://schedule.naclubs.net) · [Repo](https://github.com/Danielw412/NA-ScheduleShare) |
| **Pose demos** | Python/OpenCV experiments the web game grew out of — full-body tracking, and a desktop version of 67 SPEED. | [`demos/`](demos/) |

### Running the Python demos

```bash
pip install numpy opencv-contrib-python mediapipe
python demos/speed_67_demo.py       # desktop 67 SPEED (1 or 2 players)
python demos/human_tracking_demo.py # full-body tracking playground
```

`speed_67_demo.py` controls: **Space/S** start or play again, **R** restart,
**1/2** player count, **F** fullscreen, **Q/Esc** quit.

---

## Repository layout

```
67speed/    the 67 SPEED web game (React + TypeScript + Vite)
demos/      standalone Python computer-vision demos
```

## Contributing

Club members: branch, open a pull request, and let CI run. The
`67speed build` workflow runs the test suite and a production build on every PR
that touches `67speed/`.

---

<sub>Not affiliated with, endorsed by, or operated by the North Allegheny School
District. A student project by the NA Computer &amp; AI Club.</sub>
