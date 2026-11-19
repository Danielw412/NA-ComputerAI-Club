<p align="center">
  <img src="docs/images/club-logo.png" alt="NA Computer &amp; AI Club" width="120">
</p>

<h1 align="center">NA Computer &amp; AI Club</h1>

<p align="center">
  Games, tools, and AI experiments built by students in the club.
</p>

**New to programming or GitHub?** Read [Getting started](docs/GETTING_STARTED.md)
first. It explains what this repository is, how to download it, and how to run
your first project, one step at a time.

## Projects

Every project lives in its own folder and has its own README with the details.
Pick one that sounds fun and open its folder.

| Project | What it is | Try it | Folder | Difficulty to run |
| --- | --- | --- | --- | --- |
| **67 SPEED** | Webcam game: pump your arms as fast as you can for 20 seconds | [67.naclubs.net](https://67.naclubs.net) | [`67speed/`](67speed/) | Medium |
| **Exit Code** | Party game: survive deadly scenarios while an AI judges your plan | [Play](https://death-by-ai.nacomputerclub.workers.dev) | [`death-by-ai/`](death-by-ai/) | Medium |
| **Computer vision demos** | Two Python scripts that track your body through a webcam | Run on your computer | [`demos/`](demos/) | Easiest |
| **NA Schedule Share** | Share and compare class schedules with other students | [schedule.naclubs.net](https://schedule.naclubs.net) | [Separate repo](https://github.com/Danielw412/NA-ScheduleShare) | — |

### 67 SPEED

A one- or two-player browser game. Your webcam watches you, and an AI model
called MediaPipe Pose finds your shoulders, elbows, and wrists to count each arm
pump. The camera video never leaves your computer. Players can post a nickname
and score to a shared leaderboard.

- **You'll learn about:** computer vision, React, TypeScript, and databases
- **Built with:** React, TypeScript, Vite, MediaPipe, Supabase, Cloudflare Pages
- **Read more:** [67speed/README.md](67speed/README.md)

### Exit Code

A multiplayer party game for a projector and phones. The host shows a deadly
scenario, players type a survival plan on their phones, and two AI models
decide who lives. One of them writes its reasoning live on the big screen.

- **You'll learn about:** large language models, real-time multiplayer, and servers
- **Built with:** React, TypeScript, Cloudflare Workers, Durable Objects, Claude API
- **Read more:** [death-by-ai/README.md](death-by-ai/README.md)

### Computer vision demos

Short Python programs that open your webcam and draw a skeleton over everyone
in view. One tracks up to five people and reacts to hand gestures. The other is
the original desktop version of 67 SPEED. They're the best place to start if
you've never run code before.

- **You'll learn about:** Python, OpenCV, and pose tracking
- **Built with:** Python, OpenCV, MediaPipe
- **Read more:** [demos/README.md](demos/README.md)

### NA Schedule Share

A website where students share and compare class schedules. Its code is kept in
a [separate repository](https://github.com/Danielw412/NA-ScheduleShare).

## What's in this repository

```text
NA-ComputerAI-Club/
├── 67speed/         67 SPEED, the webcam arm-pump game (website)
├── death-by-ai/     Exit Code, the AI survival party game (website + server)
├── demos/           Python webcam demos you can run on your own computer
├── docs/            Guides for new members, like Getting started
├── .github/         Automatic checks that run when someone changes the code
├── CONTRIBUTING.md  How to suggest a change
└── README.md        This page
```

Files and folders that start with a dot, like `.github/` or `.gitignore`, are
settings for tools. You can ignore them while you're learning.

## Want to help?

Read [CONTRIBUTING.md](CONTRIBUTING.md). It walks through making your first
change and asking for it to be added. Small fixes, like typos in a README, are a
great first contribution.

## Affiliation

This repository is an independent student project by the NA Computer & AI Club.
It is not operated, sponsored, endorsed, or reviewed by the North Allegheny
School District, any North Allegheny school, or their staff.
