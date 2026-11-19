# Getting started

This guide is for anyone who is new to programming, GitHub, or this club. You
don't need to know anything yet. Go through the steps in order and you'll have
a project running on your own computer.

## 1. What is this repository?

A **repository** (or "repo") is a folder of code that's saved on GitHub, along
with the history of every change anyone has made to it. This repo holds several
club projects. Each one has its own folder:

| Folder | Project | Language |
| --- | --- | --- |
| [`demos/`](../demos/) | Webcam body-tracking demos | Python |
| [`67speed/`](../67speed/) | 67 SPEED, a webcam arm-pump game | TypeScript |
| [`death-by-ai/`](../death-by-ai/) | Exit Code, an AI party game | TypeScript |

You can read all the code right here on GitHub without installing anything.
Click a folder, then click a file.

## 2. Where to start reading

Every project folder has a `README.md`. GitHub shows it below the file list
when you open the folder. Read it first: it says what the project does, how to
run it, and which files matter most.

A good order if you're new:

1. **[`demos/`](../demos/)**: one Python file per demo, so it's easy to see the
   whole program.
2. **[`67speed/`](../67speed/)**: a full website. Its README explains, step by
   step, how a webcam image becomes a score.
3. **[`death-by-ai/`](../death-by-ai/)**: a website with its own server and AI
   models. It's the most advanced project here.

## 3. Install the tools

You only need the tools for the project you want to run.

**For everything:**

- [Git](https://git-scm.com/downloads) downloads the repository and tracks your
  changes.
- [Visual Studio Code](https://code.visualstudio.com/) (VS Code) is a free code
  editor. It has a built-in terminal.

**For the Python demos:**

- [Python](https://www.python.org/downloads/) 3.10 or newer. On Windows, tick
  **Add python.exe to PATH** on the first installer screen.

**For 67 SPEED and Exit Code:**

- [Node.js](https://nodejs.org/) version 22 (the "LTS" download). It includes
  `npm`, which installs the libraries a project needs.

To check that a tool installed correctly, open a terminal and run these. Each
should print a version number.

```bash
git --version
python --version
node --version
```

> **What's a terminal?** It's a window where you type commands instead of
> clicking. In VS Code, open one with **Terminal > New Terminal**. On Windows
> you can also use PowerShell. On a Mac, use the Terminal app.

## 4. Download the repository

In a terminal, go to the folder where you keep projects, then run:

```bash
git clone https://github.com/Danielw412/NA-ComputerAI-Club.git
cd NA-ComputerAI-Club
code .
```

`git clone` makes a copy of the repo on your computer. `cd` moves the terminal
into that folder. `code .` opens the folder in VS Code. If `code` isn't found,
open VS Code and use **File > Open Folder** instead.

## 5. Run your first project

The Python demos are the quickest. With a webcam plugged in, run:

```bash
python -m pip install numpy opencv-contrib-python mediapipe pillow
python demos/human_tracking_demo.py
```

The first command installs the libraries. The second starts the demo. Press
`Q` to quit. See [demos/README.md](../demos/README.md) for the other demo and
its controls.

To run a website project, follow the **Run it on your computer** section in its
README. It usually looks like this:

```bash
cd 67speed
npm install
npm run dev
```

Then open the `http://localhost:...` link the terminal prints. Press `Ctrl+C`
in the terminal to stop it.

## 6. Words you'll see

| Word | Meaning |
| --- | --- |
| **README** | A file that explains a folder. Always read it first. |
| **Terminal** | A window for typing commands. |
| **Git** | A tool that saves versions of code so you can undo and share changes. |
| **Clone** | Download a copy of a repository. |
| **Commit** | A saved snapshot of your changes, with a short message. |
| **Branch** | Your own copy of the code to work on without affecting anyone else. |
| **Pull request (PR)** | A request to add your branch's changes to the main project. |
| **npm** | Installs JavaScript libraries. `npm install` reads them from `package.json`. |
| **pip** | Installs Python libraries. |
| **`localhost`** | Your own computer, used as a web server while you test. |
| **Frontend** | The part of a website you see in the browser. |
| **Backend / server** | Code that runs on a computer somewhere else and the website talks to. |
| **Deploy** | Put a new version of a website online for everyone. |

## 7. Make your first change

Once something runs, try changing it. Edit a color, a word on screen, or a
number like the game length, save the file, and watch what happens. When
you've made something you want to share, follow
[CONTRIBUTING.md](../CONTRIBUTING.md).

Stuck? Ask in a club meeting. Everyone was new once.
