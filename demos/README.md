# Computer vision demos

Two Python programs that open your webcam, find the people in view, and draw
their skeletons. They use [MediaPipe](https://ai.google.dev/edge/mediapipe), a
free set of AI models from Google, and [OpenCV](https://opencv.org/) to show the
video. These experiments led to the [67 SPEED](../67speed/) web game.

New to Python? Start with [Getting started](../docs/GETTING_STARTED.md).

## The demos

| File | What it does |
| --- | --- |
| [`human_tracking_demo.py`](human_tracking_demo.py) | Tracks up to five people's bodies, faces, and hands. Hand gestures trigger animated reactions. |
| [`speed_67_demo.py`](speed_67_demo.py) | The original desktop version of 67 SPEED for one or two players. |

## Run them

You need Python 3.10 or newer and a webcam. From the top folder of the
repository, install the libraries once:

```bash
python -m pip install numpy opencv-contrib-python mediapipe pillow
```

Then run either demo:

```bash
python demos/human_tracking_demo.py
python demos/speed_67_demo.py
```

The first run downloads the MediaPipe models, so it takes a moment to start.

To see extra options, like fullscreen or a more accurate model, add `--help`:

```bash
python demos/human_tracking_demo.py --help
```

## Controls

**`human_tracking_demo.py`:**

| Key | Action |
| --- | --- |
| `H` | Show or hide the hand overlay |
| `G` | Turn gesture reactions on or off |
| `D` | Show or hide debug info |
| `F` | Toggle fullscreen |
| `Q` or `Esc` | Quit |

**`speed_67_demo.py`:**

| Key | Action |
| --- | --- |
| `Space` or `S` | Start or play again |
| `R` | Restart |
| `1` or `2` | Choose the player count |
| `F` | Toggle fullscreen |
| `Q` or `Esc` | Quit |

## Ideas to try

- Change the skeleton colors in `human_tracking_demo.py` (look for
  `PERSON_COLORS`).
- Make a `speed_67_demo.py` round last 10 seconds instead of 15
  (look for `DEFAULT_ROUND_SECONDS`).
- Print a message whenever someone raises both hands.
