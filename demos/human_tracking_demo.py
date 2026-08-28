#!/usr/bin/env python3
"""Presentation-ready, multi-person webcam tracking with gesture reactions.

Tracks as many as five people with MediaPipe body, face, and hand landmarks.
Intentional hand gestures trigger person-specific animated reactions.  This
program deliberately does not classify whole-body poses.

Quick start (from the repository virtual environment):

    python demos/human_tracking_demo.py

First use downloads three MediaPipe model bundles (about 20 MB) to the local
application cache.  Useful options:

    python demos/human_tracking_demo.py --help
    python demos/human_tracking_demo.py --fullscreen
    python demos/human_tracking_demo.py --pose-model full

If dependencies are missing:

    python -m pip install numpy opencv-contrib-python mediapipe pillow

Keyboard: Q/Esc quit, F fullscreen, H hand overlay, G reactions, D debug.
"""

from __future__ import annotations

import argparse
import math
import os
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional, Sequence


# MediaPipe's native runtime otherwise prints routine delegate diagnostics over
# the presentation console. Real initialization errors are surfaced explicitly.
os.environ.setdefault("GLOG_minloglevel", "2")
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

DEPENDENCY_HINT = (
    f'"{sys.executable}" -m pip install numpy opencv-contrib-python mediapipe pillow'
)

try:
    import cv2
    import mediapipe as mp
    import numpy as np
    from PIL import Image, ImageDraw, ImageFont
except (ImportError, ModuleNotFoundError) as exc:
    print("\nHuman Tracking Demo could not start: a dependency is missing.", file=sys.stderr)
    print(f"Missing import: {exc}", file=sys.stderr)
    print(f"Install the required packages with:\n  {DEPENDENCY_HINT}\n", file=sys.stderr)
    raise SystemExit(2) from exc


APP_NAME = "Human Tracking Lab"
WINDOW_NAME = "Human Tracking Lab - Live Demo"
MAX_PEOPLE_LIMIT = 5

# RGB model bundles published by the MediaPipe project.  The application uses
# the lite pose model by default because five-person inference is demanding.
MODEL_URLS = {
    "pose_lite": (
        "pose_landmarker_lite.task",
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
        "pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
    ),
    "pose_full": (
        "pose_landmarker_full.task",
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
        "pose_landmarker_full/float16/1/pose_landmarker_full.task",
    ),
    "face": (
        "face_landmarker.task",
        "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
        "face_landmarker/float16/1/face_landmarker.task",
    ),
    "hand": (
        "hand_landmarker.task",
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/"
        "hand_landmarker/float16/1/hand_landmarker.task",
    ),
}

# Bright, projector-friendly BGR colors.  Active tracks never share a color.
PERSON_COLORS = [
    (255, 229, 0),    # cyan
    (141, 77, 255),   # rose
    (107, 255, 124),  # green
    (32, 176, 255),   # amber
    (255, 136, 179),  # violet
]

POSE_CONNECTIONS = [
    (11, 12),
    (11, 13), (13, 15),
    (12, 14), (14, 16),
    (11, 23), (12, 24), (23, 24),
    (23, 25), (25, 27), (27, 29), (29, 31), (27, 31),
    (24, 26), (26, 28), (28, 30), (30, 32), (28, 32),
]
POSE_MAJOR_JOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]
POSE_ANCHOR_JOINTS = [11, 12, 23, 24]

HAND_CONNECTIONS = [
    (0, 1), (1, 2), (2, 3), (3, 4),
    (0, 5), (5, 6), (6, 7), (7, 8),
    (5, 9), (9, 10), (10, 11), (11, 12),
    (9, 13), (13, 14), (14, 15), (15, 16),
    (13, 17), (17, 18), (18, 19), (19, 20),
    (17, 0),
]
HAND_TIPS = {4, 8, 12, 16, 20}

# A restrained subset of the 478-point face mesh: oval, eyes, eyebrows, nose,
# and mouth.  It communicates face tracking without obscuring the face.
FACE_CURVES = [
    [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365,
     379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234,
     127, 162, 21, 54, 103, 67, 109, 10],
    [33, 160, 158, 133, 153, 144, 33],
    [362, 385, 387, 263, 373, 380, 362],
    [70, 63, 105, 66, 107],
    [336, 296, 334, 293, 300],
    [168, 6, 197, 195, 5, 4, 1],
    [129, 98, 97, 2, 326, 327, 358],
    [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314,
     17, 84, 181, 91, 146, 61],
]

GESTURE_LABELS = {
    "THUMBS_UP": "Thumbs up",
    "THUMBS_DOWN": "Thumbs down",
    "PEACE": "Peace",
    "HEART": "Heart",
    "DOUBLE_THUMBS_UP": "Double thumbs up",
}

GESTURE_EMOJIS = {
    "THUMBS_UP": "👍",
    "THUMBS_DOWN": "👎",
    "PEACE": "✌️",
    "HEART": "❤️",
    "DOUBLE_THUMBS_UP": "👍👍",
}


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def color_scale(color: tuple[int, int, int], factor: float) -> tuple[int, int, int]:
    return tuple(int(clamp(channel * factor, 0, 255)) for channel in color)


def normalized_to_pixel(point: Sequence[float], width: int, height: int) -> tuple[int, int]:
    return int(point[0] * width), int(point[1] * height)


def landmark_value(landmark: Any, name: str, default: float) -> float:
    value = getattr(landmark, name, default)
    return default if value is None else float(value)


def landmarks_to_array(landmarks: Sequence[Any], include_confidence: bool = False) -> np.ndarray:
    columns = 5 if include_confidence else 3
    output = np.empty((len(landmarks), columns), dtype=np.float32)
    for index, landmark in enumerate(landmarks):
        output[index, 0] = landmark_value(landmark, "x", 0.0)
        output[index, 1] = landmark_value(landmark, "y", 0.0)
        output[index, 2] = landmark_value(landmark, "z", 0.0)
        if include_confidence:
            output[index, 3] = landmark_value(landmark, "visibility", 1.0)
            output[index, 4] = landmark_value(landmark, "presence", 1.0)
    return output


def alpha_for_age(age: float, solid_for: float, disappear_at: float) -> float:
    if age <= solid_for:
        return 1.0
    if age >= disappear_at:
        return 0.0
    return 1.0 - (age - solid_for) / max(1e-6, disappear_at - solid_for)


def point_to_box_distance(point: np.ndarray, box: tuple[float, float, float, float]) -> float:
    x1, y1, x2, y2 = box
    dx = max(x1 - point[0], 0.0, point[0] - x2)
    dy = max(y1 - point[1], 0.0, point[1] - y2)
    return math.hypot(dx, dy)


def array_box(points: np.ndarray, padding: float = 0.0) -> tuple[float, float, float, float]:
    if len(points) == 0:
        return (0.0, 0.0, 0.0, 0.0)
    x1, y1 = np.min(points[:, :2], axis=0)
    x2, y2 = np.max(points[:, :2], axis=0)
    return (
        float(clamp(x1 - padding, 0.0, 1.0)),
        float(clamp(y1 - padding, 0.0, 1.0)),
        float(clamp(x2 + padding, 0.0, 1.0)),
        float(clamp(y2 + padding, 0.0, 1.0)),
    )


def center_of_box(box: tuple[float, float, float, float]) -> np.ndarray:
    return np.array(((box[0] + box[2]) * 0.5, (box[1] + box[3]) * 0.5), dtype=np.float32)


def box_scale(box: tuple[float, float, float, float]) -> float:
    return max(0.01, math.hypot(box[2] - box[0], box[3] - box[1]))


def box_iou(
    first: tuple[float, float, float, float],
    second: tuple[float, float, float, float],
) -> float:
    intersection_width = max(0.0, min(first[2], second[2]) - max(first[0], second[0]))
    intersection_height = max(0.0, min(first[3], second[3]) - max(first[1], second[1]))
    intersection = intersection_width * intersection_height
    first_area = max(0.0, first[2] - first[0]) * max(0.0, first[3] - first[1])
    second_area = max(0.0, second[2] - second[0]) * max(0.0, second[3] - second[1])
    return intersection / max(1e-7, first_area + second_area - intersection)


def expanded_box(
    box: tuple[float, float, float, float],
    horizontal: float,
    vertical: float,
) -> tuple[float, float, float, float]:
    return (
        clamp(box[0] - horizontal, 0.0, 1.0),
        clamp(box[1] - vertical, 0.0, 1.0),
        clamp(box[2] + horizontal, 0.0, 1.0),
        clamp(box[3] + vertical, 0.0, 1.0),
    )


def optimal_assignment(
    costs: np.ndarray,
    gates: np.ndarray,
    miss_cost: float,
) -> list[tuple[int, int]]:
    """Small exact assignment solver; at five people exhaustive DP is cheap."""
    track_count, detection_count = costs.shape
    memo: dict[tuple[int, int], tuple[float, tuple[tuple[int, int], ...]]] = {}

    def solve(track_index: int, used_mask: int) -> tuple[float, tuple[tuple[int, int], ...]]:
        key = (track_index, used_mask)
        if key in memo:
            return memo[key]
        if track_index >= track_count:
            return 0.0, ()

        tail_cost, tail_pairs = solve(track_index + 1, used_mask)
        best = (miss_cost + tail_cost, tail_pairs)
        for detection_index in range(detection_count):
            if used_mask & (1 << detection_index):
                continue
            candidate_cost = float(costs[track_index, detection_index])
            if not math.isfinite(candidate_cost) or candidate_cost > gates[track_index, detection_index]:
                continue
            next_cost, next_pairs = solve(track_index + 1, used_mask | (1 << detection_index))
            option = (candidate_cost + next_cost, ((track_index, detection_index),) + next_pairs)
            if option[0] < best[0]:
                best = option
        memo[key] = best
        return best

    return list(solve(0, 0)[1])


class OneEuroFilter:
    """Adaptive low-pass filter: still landmarks are stable, fast ones stay responsive."""

    def __init__(self, min_cutoff: float = 1.35, beta: float = 0.075, d_cutoff: float = 1.0):
        self.min_cutoff = min_cutoff
        self.beta = beta
        self.d_cutoff = d_cutoff
        self.previous_value: Optional[np.ndarray] = None
        self.previous_derivative: Optional[np.ndarray] = None
        self.previous_time: Optional[float] = None

    @staticmethod
    def _alpha(dt: float, cutoff: np.ndarray | float) -> np.ndarray | float:
        tau = 1.0 / (2.0 * math.pi * cutoff)
        return 1.0 / (1.0 + tau / dt)

    def reset(self) -> None:
        self.previous_value = None
        self.previous_derivative = None
        self.previous_time = None

    def __call__(self, value: np.ndarray, timestamp: float) -> np.ndarray:
        value = np.asarray(value, dtype=np.float32)
        if self.previous_value is None or self.previous_value.shape != value.shape:
            self.previous_value = value.copy()
            self.previous_derivative = np.zeros_like(value)
            self.previous_time = timestamp
            return value.copy()

        previous_time = self.previous_time if self.previous_time is not None else timestamp
        dt = clamp(timestamp - previous_time, 1.0 / 240.0, 0.25)
        derivative = (value - self.previous_value) / dt
        derivative_alpha = self._alpha(dt, self.d_cutoff)
        derivative_hat = (
            derivative_alpha * derivative
            + (1.0 - derivative_alpha) * self.previous_derivative
        )
        cutoff = self.min_cutoff + self.beta * np.abs(derivative_hat)
        value_alpha = self._alpha(dt, cutoff)
        filtered = value_alpha * value + (1.0 - value_alpha) * self.previous_value
        self.previous_value = filtered.astype(np.float32, copy=False)
        self.previous_derivative = derivative_hat.astype(np.float32, copy=False)
        self.previous_time = timestamp
        return self.previous_value.copy()


class LatestResult:
    """Thread-safe mailbox that keeps only the newest asynchronous result."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sequence = 0
        self._timestamp_ms = -1
        self._value: Any = None

    def publish(self, timestamp_ms: int, value: Any) -> None:
        with self._lock:
            if timestamp_ms < self._timestamp_ms:
                return
            self._sequence += 1
            self._timestamp_ms = timestamp_ms
            self._value = value

    def get_after(self, sequence: int) -> Optional[tuple[int, int, Any]]:
        with self._lock:
            if self._sequence <= sequence:
                return None
            return self._sequence, self._timestamp_ms, self._value

    def age(self, current_timestamp_ms: int) -> float:
        with self._lock:
            if self._timestamp_ms < 0:
                return math.inf
            return max(0.0, (current_timestamp_ms - self._timestamp_ms) / 1000.0)


@dataclass
class PoseObservation:
    landmarks: np.ndarray
    anchor: np.ndarray
    box: tuple[float, float, float, float]
    scale: float
    nose: Optional[np.ndarray]
    quality: float


@dataclass
class FaceObservation:
    landmarks: np.ndarray
    box: tuple[float, float, float, float]
    center: np.ndarray
    scale: float


@dataclass
class HandObservation:
    landmarks: np.ndarray
    handedness: str
    score: float

    @property
    def wrist(self) -> np.ndarray:
        return self.landmarks[0, :2]

    @property
    def center(self) -> np.ndarray:
        return np.mean(self.landmarks[[0, 5, 9, 13, 17], :2], axis=0)


@dataclass
class GestureCandidate:
    name: str
    confidence: float
    origin: np.ndarray


@dataclass
class GestureEvent:
    track_id: int
    name: str
    confidence: float
    origin: np.ndarray
    color: tuple[int, int, int]


@dataclass
class PendingPose:
    observation: PoseObservation
    first_seen: float
    last_seen: float
    hits: int = 1


@dataclass
class PendingFace:
    observation: FaceObservation
    first_seen: float
    last_seen: float
    hits: int = 1


class GestureRecognizer:
    """Geometry-based intentional hand gesture recognizer.

    Classification is followed by temporal debouncing elsewhere; separating
    the two keeps a momentary landmark wobble from becoming a reaction.
    """

    FINGERS = ((5, 6, 8), (9, 10, 12), (13, 14, 16), (17, 18, 20))

    @staticmethod
    def _angle(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> float:
        first = a - b
        second = c - b
        denominator = max(1e-7, float(np.linalg.norm(first) * np.linalg.norm(second)))
        cosine = clamp(float(np.dot(first, second)) / denominator, -1.0, 1.0)
        return math.degrees(math.acos(cosine))

    @staticmethod
    def _metric_points(landmarks: np.ndarray, aspect_ratio: float) -> np.ndarray:
        points = landmarks[:, :2].astype(np.float32, copy=True)
        points[:, 0] *= aspect_ratio
        return points

    def classify_hand(
        self,
        hand: "HandTrack",
        aspect_ratio: float,
    ) -> Optional[GestureCandidate]:
        landmarks = hand.landmarks
        if landmarks is None or len(landmarks) < 21:
            return None
        points = self._metric_points(landmarks, aspect_ratio)
        wrist = points[0]
        palm_center = np.mean(points[[0, 5, 9, 13, 17]], axis=0)
        palm_scale = max(
            1e-5,
            0.5 * (
                float(np.linalg.norm(points[0] - points[9]))
                + float(np.linalg.norm(points[5] - points[17]))
            ),
        )

        extended: list[bool] = []
        curled: list[bool] = []
        for mcp_index, pip_index, tip_index in self.FINGERS:
            angle = self._angle(points[mcp_index], points[pip_index], points[tip_index])
            tip_distance = float(np.linalg.norm(points[tip_index] - wrist))
            pip_distance = max(1e-5, float(np.linalg.norm(points[pip_index] - wrist)))
            ratio = tip_distance / pip_distance
            extended.append(angle > 154.0 and ratio > 1.11)
            curled.append(angle < 120.0 or ratio < 0.99)

        thumb_angle = self._angle(points[2], points[3], points[4])
        thumb_reach = float(np.linalg.norm(points[4] - palm_center)) / palm_scale
        thumb_extended = thumb_angle > 150.0 and thumb_reach > 0.82
        thumb_vector = points[4] - points[2]
        thumb_length = max(1e-5, float(np.linalg.norm(thumb_vector)))
        vertical_component = -float(thumb_vector[1]) / thumb_length

        # A deliberate thumbs-up/down needs a vertical thumb and folded fingers.
        if all(curled) and thumb_extended and abs(vertical_component) > 0.78:
            confidence = clamp(
                0.84 + 0.13 * (abs(vertical_component) - 0.78) / 0.22,
                0.0,
                0.99,
            )
            name = "THUMBS_UP" if vertical_component > 0.0 else "THUMBS_DOWN"
            return GestureCandidate(name, confidence, landmarks[4, :2].copy())

        if extended[0] and extended[1] and curled[2] and curled[3]:
            separation = float(np.linalg.norm(points[8] - points[12])) / palm_scale
            if separation > 0.42:
                confidence = clamp(0.85 + 0.10 * min(separation - 0.42, 0.8), 0.0, 0.97)
                origin = np.mean(landmarks[[8, 12], :2], axis=0)
                return GestureCandidate("PEACE", confidence, origin)

        return None

    def classify_two_hands(
        self,
        hands: Sequence["HandTrack"],
        singles: Sequence[Optional[GestureCandidate]],
        aspect_ratio: float,
    ) -> Optional[GestureCandidate]:
        if len(hands) != 2:
            return None

        if all(candidate is not None and candidate.name == "THUMBS_UP" for candidate in singles):
            confidence = min(candidate.confidence for candidate in singles if candidate is not None)
            origin = np.mean([candidate.origin for candidate in singles if candidate is not None], axis=0)
            return GestureCandidate("DOUBLE_THUMBS_UP", confidence, origin.astype(np.float32))

        point_sets = [self._metric_points(hand.landmarks, aspect_ratio) for hand in hands]
        first, second = sorted(point_sets, key=lambda points: float(points[0, 0]))
        scale_first = 0.5 * (
            np.linalg.norm(first[0] - first[9]) + np.linalg.norm(first[5] - first[17])
        )
        scale_second = 0.5 * (
            np.linalg.norm(second[0] - second[9]) + np.linalg.norm(second[5] - second[17])
        )
        palm_scale = max(1e-5, float((scale_first + scale_second) * 0.5))

        thumb_distance = float(np.linalg.norm(first[4] - second[4])) / palm_scale
        index_distance = float(np.linalg.norm(first[8] - second[8])) / palm_scale
        wrist_distance = float(np.linalg.norm(first[0] - second[0])) / palm_scale
        index_y = float((first[8, 1] + second[8, 1]) * 0.5)
        thumb_y = float((first[4, 1] + second[4, 1]) * 0.5)
        vertical_gap = (thumb_y - index_y) / palm_scale
        first_inward = min(first[4, 0] - first[0, 0], first[8, 0] - first[0, 0]) / palm_scale
        second_inward = min(second[0, 0] - second[4, 0], second[0, 0] - second[8, 0]) / palm_scale
        wrist_below_index = min(first[0, 1] - index_y, second[0, 1] - index_y) / palm_scale

        # Both fingertip pairs must meet, with index tips above thumb tips.  The
        # wrists must also approach from opposite sides, which rejects ordinary
        # two-hand motion near the center of the image.
        if (
            thumb_distance < 0.90
            and index_distance < 1.00
            and 1.25 < wrist_distance < 5.2
            and vertical_gap > 0.12
            and first_inward > 0.10
            and second_inward > 0.10
            and wrist_below_index > 0.30
            and first[8, 1] < first[4, 1] + 0.12 * palm_scale
            and second[8, 1] < second[4, 1] + 0.12 * palm_scale
        ):
            closeness = 1.0 - 0.5 * (thumb_distance / 0.90 + index_distance / 1.00)
            confidence = clamp(0.86 + 0.12 * closeness, 0.84, 0.98)
            origin = np.mean(
                [hands[0].landmarks[4, :2], hands[1].landmarks[4, :2],
                 hands[0].landmarks[8, :2], hands[1].landmarks[8, :2]],
                axis=0,
            )
            return GestureCandidate("HEART", confidence, origin.astype(np.float32))
        return None

    def recognize(
        self,
        hands: Sequence["HandTrack"],
        aspect_ratio: float,
    ) -> Optional[GestureCandidate]:
        singles = [self.classify_hand(hand, aspect_ratio) for hand in hands]
        combined = self.classify_two_hands(hands, singles, aspect_ratio)
        if combined is not None:
            return combined
        valid = [candidate for candidate in singles if candidate is not None]
        return max(valid, key=lambda candidate: candidate.confidence, default=None)


class GestureDebouncer:
    HOLD_SECONDS = 0.72
    RELEASE_SECONDS = 0.45
    MAX_DETECTION_GAP = 0.16
    HEART_DETECTION_GAP = 0.28
    MIN_HITS = 7
    MIN_CONFIDENCE = 0.84
    GLOBAL_COOLDOWN = 1.10

    def __init__(self) -> None:
        self.candidate_name: Optional[str] = None
        self.candidate_since = 0.0
        self.candidate_last_seen = -math.inf
        self.candidate_hits = 0
        self.candidate_confidence_sum = 0.0
        self.latched_name: Optional[str] = None
        self.release_since: Optional[float] = None
        self.last_triggered = -math.inf
        self.debug_name = "-"

    def update(self, candidate: Optional[GestureCandidate], timestamp: float) -> Optional[GestureCandidate]:
        if candidate is not None and candidate.confidence < self.MIN_CONFIDENCE:
            candidate = None
        name = candidate.name if candidate is not None else None
        self.debug_name = name or "-"
        gap_limit = (
            self.HEART_DETECTION_GAP
            if (name == "HEART" or self.candidate_name == "HEART")
            else self.MAX_DETECTION_GAP
        )

        if self.latched_name is not None:
            if name == self.latched_name:
                self.release_since = None
            else:
                if self.release_since is None:
                    self.release_since = timestamp
                elif timestamp - self.release_since >= self.RELEASE_SECONDS:
                    self.latched_name = None
                    self.release_since = None

        if name is None:
            if timestamp - self.candidate_last_seen > gap_limit:
                self.candidate_name = None
                self.candidate_hits = 0
                self.candidate_confidence_sum = 0.0
            return None

        if name != self.candidate_name or timestamp - self.candidate_last_seen > gap_limit:
            self.candidate_name = name
            self.candidate_since = timestamp
            self.candidate_hits = 1
            self.candidate_confidence_sum = candidate.confidence
        else:
            self.candidate_hits += 1
            self.candidate_confidence_sum += candidate.confidence
        self.candidate_last_seen = timestamp

        held_long_enough = timestamp - self.candidate_since >= self.HOLD_SECONDS
        average_confidence = self.candidate_confidence_sum / max(1, self.candidate_hits)
        ready = (
            self.latched_name is None
            and held_long_enough
            and self.candidate_hits >= self.MIN_HITS
            and average_confidence >= self.MIN_CONFIDENCE
            and timestamp - self.last_triggered >= self.GLOBAL_COOLDOWN
        )
        if ready:
            self.latched_name = name
            self.last_triggered = timestamp
            self.release_since = None
            return candidate
        return None


@dataclass
class HandTrack:
    slot: int
    handedness: str
    score: float
    last_seen: float
    landmarks: Optional[np.ndarray] = None
    smoother: OneEuroFilter = field(default_factory=lambda: OneEuroFilter(3.2, 0.45))
    velocity: np.ndarray = field(
        default_factory=lambda: np.zeros((21, 2), dtype=np.float32)
    )

    @property
    def wrist(self) -> np.ndarray:
        if self.landmarks is None:
            return np.array((0.0, 0.0), dtype=np.float32)
        return self.landmarks[0, :2]

    def update(self, observation: HandObservation, timestamp: float) -> None:
        previous = self.landmarks
        previous_time = self.last_seen
        self.landmarks = self.smoother(observation.landmarks, timestamp)
        if previous is not None:
            dt = clamp(timestamp - previous_time, 1.0 / 120.0, 0.3)
            measured = (self.landmarks[:, :2] - previous[:, :2]) / dt
            speeds = np.linalg.norm(measured, axis=1)
            too_fast = speeds > 3.0
            measured[too_fast] *= (3.0 / speeds[too_fast])[:, None]
            self.velocity = 0.55 * self.velocity + 0.45 * measured
        self.handedness = observation.handedness
        self.score = observation.score
        self.last_seen = timestamp

    def display_landmarks(self, now: float) -> Optional[np.ndarray]:
        if self.landmarks is None:
            return None
        horizon = clamp(now - self.last_seen, 0.0, 0.065)
        if horizon <= 0.0:
            return self.landmarks
        predicted = self.landmarks.copy()
        predicted[:, :2] = np.clip(predicted[:, :2] + self.velocity * horizon, -0.08, 1.08)
        return predicted


class PersonTrack:
    def __init__(self, track_id: int, color_index: int) -> None:
        self.track_id = track_id
        self.color_index = color_index
        self.color = PERSON_COLORS[color_index]

        self.pose: Optional[np.ndarray] = None
        self.pose_box = (0.0, 0.0, 0.0, 0.0)
        self.pose_anchor = np.array((0.5, 0.5), dtype=np.float32)
        self.pose_scale = 0.25
        self.pose_velocity = np.zeros(2, dtype=np.float32)
        self.pose_landmark_velocity = np.zeros((33, 2), dtype=np.float32)
        self.pose_last_seen = -math.inf
        self.pose_smoother = OneEuroFilter(3.2, 0.38)

        self.face: Optional[np.ndarray] = None
        self.face_box = (0.0, 0.0, 0.0, 0.0)
        self.face_center = np.array((0.5, 0.35), dtype=np.float32)
        self.face_last_seen = -math.inf
        self.face_smoother = OneEuroFilter(2.35, 0.18)

        self.hands: dict[int, HandTrack] = {}
        self.hand_last_seen = -math.inf
        self._next_hand_slot = 0

        self.gesture = GestureDebouncer()
        self.label_text = ""
        self.label_until = 0.0

    @property
    def last_seen(self) -> float:
        return max(self.pose_last_seen, self.face_last_seen, self.hand_last_seen)

    def predicted_pose_anchor(self, timestamp: float) -> np.ndarray:
        horizon = clamp(timestamp - self.pose_last_seen, 0.0, 0.35)
        return np.clip(self.pose_anchor + self.pose_velocity * horizon, 0.0, 1.0)

    def shoulder_width(self) -> float:
        if self.pose is None:
            return 0.12
        return max(0.035, float(np.linalg.norm(self.pose[11, :2] - self.pose[12, :2])))

    def expected_face_center(self, now: float) -> Optional[np.ndarray]:
        nose = self.reliable_pose_point(0, now, threshold=0.24)
        if nose is not None:
            return nose
        left = self.reliable_pose_point(11, now, threshold=0.30)
        right = self.reliable_pose_point(12, now, threshold=0.30)
        if left is None or right is None:
            return None
        shoulder_center = (left + right) * 0.5
        return np.array(
            (shoulder_center[0], shoulder_center[1] - self.shoulder_width() * 0.62),
            dtype=np.float32,
        )

    def reliable_pose_point(self, index: int, now: float, threshold: float = 0.42) -> Optional[np.ndarray]:
        if self.pose is None or now - self.pose_last_seen > 0.9:
            return None
        point = self.pose[index]
        if point[3] < threshold or point[4] < threshold:
            return None
        return point[:2]

    def update_pose(self, observation: PoseObservation, timestamp: float) -> None:
        previous_pose = self.pose.copy() if self.pose is not None else None
        previous_time = self.pose_last_seen
        if math.isfinite(self.pose_last_seen):
            dt = clamp(timestamp - self.pose_last_seen, 1.0 / 120.0, 0.4)
            measured_velocity = (observation.anchor - self.pose_anchor) / dt
            speed = float(np.linalg.norm(measured_velocity))
            if speed > 2.0:
                measured_velocity *= 2.0 / speed
            self.pose_velocity = 0.72 * self.pose_velocity + 0.28 * measured_velocity
        filtered_coordinates = self.pose_smoother(observation.landmarks[:, :3], timestamp)
        self.pose = observation.landmarks.copy()
        self.pose[:, :3] = filtered_coordinates
        if previous_pose is not None:
            dt = clamp(timestamp - previous_time, 1.0 / 120.0, 0.35)
            measured = (self.pose[:, :2] - previous_pose[:, :2]) / dt
            speeds = np.linalg.norm(measured, axis=1)
            too_fast = speeds > 2.4
            measured[too_fast] *= (2.4 / speeds[too_fast])[:, None]
            reliable = (
                (self.pose[:, 3] > 0.40)
                & (self.pose[:, 4] > 0.40)
                & (previous_pose[:, 3] > 0.40)
                & (previous_pose[:, 4] > 0.40)
            )
            self.pose_landmark_velocity[reliable] = (
                0.62 * self.pose_landmark_velocity[reliable] + 0.38 * measured[reliable]
            )
            self.pose_landmark_velocity[~reliable] *= 0.5
        reliable = np.minimum(self.pose[:, 3], self.pose[:, 4]) > 0.42
        if np.any(reliable):
            self.pose_box = array_box(self.pose[reliable, :2], padding=0.018)
        else:
            self.pose_box = observation.box
        self.pose_anchor = observation.anchor.astype(np.float32)
        self.pose_scale = observation.scale
        self.pose_last_seen = timestamp

    def update_face(self, observation: FaceObservation, timestamp: float) -> None:
        self.face = self.face_smoother(observation.landmarks[:, :3], timestamp)
        self.face_box = array_box(self.face[:, :2], padding=0.008)
        self.face_center = center_of_box(self.face_box)
        self.face_last_seen = timestamp

    def display_pose(self, now: float) -> Optional[np.ndarray]:
        if self.pose is None:
            return None
        horizon = clamp(now - self.pose_last_seen, 0.0, 0.075)
        if horizon <= 0.0:
            return self.pose
        predicted = self.pose.copy()
        predicted[:, :2] = np.clip(
            predicted[:, :2] + self.pose_landmark_velocity * horizon,
            -0.10,
            1.10,
        )
        return predicted

    def _match_hand_slots(
        self,
        observations: Sequence[HandObservation],
        timestamp: float,
    ) -> list[tuple[int, int]]:
        active_slots = [
            slot for slot, hand in self.hands.items()
            if timestamp - hand.last_seen < 0.70
        ]
        if not active_slots or not observations:
            return []
        costs = np.full((len(active_slots), len(observations)), np.inf, dtype=np.float32)
        gates = np.full_like(costs, 0.16)
        for row, slot in enumerate(active_slots):
            hand = self.hands[slot]
            for column, observation in enumerate(observations):
                cost = float(np.linalg.norm(hand.wrist - observation.wrist))
                if hand.handedness and observation.handedness and hand.handedness != observation.handedness:
                    cost += 0.035
                costs[row, column] = cost
        pairs = optimal_assignment(costs, gates, miss_cost=0.13)
        return [(active_slots[row], column) for row, column in pairs]

    def update_hands(
        self,
        observations: Sequence[HandObservation],
        timestamp: float,
        recognizer: GestureRecognizer,
        aspect_ratio: float,
    ) -> Optional[GestureCandidate]:
        # Retain a hand briefly through a dropped detection, then free its slot.
        for slot in list(self.hands):
            if timestamp - self.hands[slot].last_seen > 0.72:
                del self.hands[slot]

        pairs = self._match_hand_slots(observations, timestamp)
        matched_observations: set[int] = set()
        for slot, observation_index in pairs:
            self.hands[slot].update(observations[observation_index], timestamp)
            matched_observations.add(observation_index)

        for observation_index, observation in enumerate(observations):
            if observation_index in matched_observations:
                continue
            if len(self.hands) >= 2:
                oldest = min(self.hands, key=lambda key: self.hands[key].last_seen)
                if timestamp - self.hands[oldest].last_seen > 0.20:
                    del self.hands[oldest]
                else:
                    continue
            slot = self._next_hand_slot
            self._next_hand_slot += 1
            hand = HandTrack(slot, observation.handedness, observation.score, timestamp)
            hand.update(observation, timestamp)
            self.hands[slot] = hand

        if observations:
            self.hand_last_seen = timestamp

        fresh_hands = [
            hand for hand in self.hands.values()
            if timestamp - hand.last_seen < 0.16 and hand.landmarks is not None
        ]
        candidate = recognizer.recognize(fresh_hands, aspect_ratio)
        return self.gesture.update(candidate, timestamp)

    def display_box(self, now: float) -> tuple[float, float, float, float]:
        point_sets: list[np.ndarray] = []
        if self.pose is not None and now - self.pose_last_seen < 0.9:
            valid = (self.pose[:, 3] > 0.38) & (self.pose[:, 4] > 0.38)
            if np.any(valid):
                point_sets.append(self.pose[valid, :2])
        if self.face is not None and now - self.face_last_seen < 0.8:
            point_sets.append(self.face[:, :2])
        for hand in self.hands.values():
            if hand.landmarks is not None and now - hand.last_seen < 0.45:
                point_sets.append(hand.landmarks[:, :2])
        if not point_sets:
            return self.pose_box if self.pose is not None else self.face_box
        return array_box(np.concatenate(point_sets, axis=0), padding=0.025)


class TrackManager:
    TRACK_TTL = 1.15

    def __init__(self, max_people: int) -> None:
        self.max_people = max_people
        self.tracks: list[PersonTrack] = []
        self.next_track_id = 1
        self.gesture_recognizer = GestureRecognizer()
        self.pending_poses: list[PendingPose] = []
        self.pending_faces: list[PendingFace] = []

    def prune(self, now: float) -> None:
        self.tracks = [track for track in self.tracks if now - track.last_seen <= self.TRACK_TTL]
        self.pending_poses = [item for item in self.pending_poses if now - item.last_seen <= 0.45]
        self.pending_faces = [item for item in self.pending_faces if now - item.last_seen <= 0.65]

    def _new_track(self) -> Optional[PersonTrack]:
        if len(self.tracks) >= self.max_people:
            return None
        used_colors = {track.color_index for track in self.tracks}
        color_index = next((index for index in range(len(PERSON_COLORS)) if index not in used_colors), 0)
        track = PersonTrack(self.next_track_id, color_index)
        self.next_track_id += 1
        self.tracks.append(track)
        return track

    @staticmethod
    def _poses_are_duplicates(first: PoseObservation, second: PoseObservation) -> bool:
        overlap = box_iou(first.box, second.box)
        anchor_distance = float(np.linalg.norm(first.anchor - second.anchor))
        shared = [
            index for index in (0, 11, 12, 13, 14, 23, 24, 25, 26)
            if (
                min(first.landmarks[index, 3], first.landmarks[index, 4]) > 0.40
                and min(second.landmarks[index, 3], second.landmarks[index, 4]) > 0.40
            )
        ]
        mean_landmark_distance = math.inf
        if len(shared) >= 3:
            mean_landmark_distance = float(np.mean(np.linalg.norm(
                first.landmarks[shared, :2] - second.landmarks[shared, :2], axis=1
            )))
        nose_distance = math.inf
        if first.nose is not None and second.nose is not None:
            nose_distance = float(np.linalg.norm(first.nose - second.nose))
        landmarks_match = (
            mean_landmark_distance < 0.045
            if len(shared) >= 3
            else nose_distance < 0.028
        )
        return (
            overlap > 0.52
            and anchor_distance < max(0.055, 0.16 * min(first.scale, second.scale))
            and landmarks_match
        )

    def _deduplicate_poses(self, observations: Sequence[PoseObservation]) -> list[PoseObservation]:
        kept: list[PoseObservation] = []
        for observation in sorted(observations, key=lambda item: item.quality, reverse=True):
            if any(self._poses_are_duplicates(observation, existing) for existing in kept):
                continue
            kept.append(observation)
        return sorted(kept, key=lambda item: float(item.anchor[0]))[:self.max_people]

    @staticmethod
    def _deduplicate_faces(observations: Sequence[FaceObservation]) -> list[FaceObservation]:
        kept: list[FaceObservation] = []
        for observation in sorted(observations, key=lambda item: item.scale, reverse=True):
            duplicate = any(
                box_iou(observation.box, existing.box) > 0.62
                and np.linalg.norm(observation.center - existing.center)
                < max(0.035, 0.45 * min(observation.scale, existing.scale))
                for existing in kept
            )
            if not duplicate:
                kept.append(observation)
        return kept

    def _queue_pose(self, observation: PoseObservation, timestamp: float) -> None:
        for track in self.tracks:
            if track.pose is None or timestamp - track.pose_last_seen >= self.TRACK_TTL:
                continue
            existing = self.make_pose_observation(track.pose)
            if existing is not None and self._poses_are_duplicates(observation, existing):
                return
        best: Optional[PendingPose] = None
        best_distance = math.inf
        for pending in self.pending_poses:
            distance = float(np.linalg.norm(observation.anchor - pending.observation.anchor))
            gate = max(0.055, 0.20 * max(observation.scale, pending.observation.scale))
            if distance < gate and distance < best_distance:
                best = pending
                best_distance = distance
        if best is None:
            self.pending_poses.append(PendingPose(observation, timestamp, timestamp))
            return
        best.observation = observation
        best.last_seen = timestamp
        best.hits += 1
        if best.hits >= 2 and timestamp - best.first_seen >= 0.035:
            track = self._new_track()
            if track is not None:
                track.update_pose(observation, timestamp)
            self.pending_poses = [item for item in self.pending_poses if item is not best]

    def _queue_face(self, observation: FaceObservation, timestamp: float) -> None:
        for track in self.tracks:
            if timestamp - track.face_last_seen < self.TRACK_TTL:
                if (
                    box_iou(observation.box, track.face_box) > 0.42
                    or np.linalg.norm(observation.center - track.face_center)
                    < max(0.04, 0.65 * observation.scale)
                ):
                    return
            expected_face = track.expected_face_center(timestamp)
            if expected_face is not None and np.linalg.norm(
                observation.center - expected_face
            ) < max(0.06, 0.85 * track.shoulder_width()):
                return
        best: Optional[PendingFace] = None
        best_distance = math.inf
        for pending in self.pending_faces:
            distance = float(np.linalg.norm(observation.center - pending.observation.center))
            gate = max(0.04, 0.65 * max(observation.scale, pending.observation.scale))
            if distance < gate and distance < best_distance:
                best = pending
                best_distance = distance
        if best is None:
            self.pending_faces.append(PendingFace(observation, timestamp, timestamp))
            return
        best.observation = observation
        best.last_seen = timestamp
        best.hits += 1
        if best.hits >= 3 and timestamp - best.first_seen >= 0.14:
            track = self._new_track()
            if track is not None:
                track.update_face(observation, timestamp)
            self.pending_faces = [item for item in self.pending_faces if item is not best]

    @staticmethod
    def _absorb_track(winner: PersonTrack, duplicate: PersonTrack) -> None:
        if duplicate.pose_last_seen > winner.pose_last_seen:
            winner.pose = duplicate.pose
            winner.pose_box = duplicate.pose_box
            winner.pose_anchor = duplicate.pose_anchor
            winner.pose_scale = duplicate.pose_scale
            winner.pose_velocity = duplicate.pose_velocity
            winner.pose_landmark_velocity = duplicate.pose_landmark_velocity
            winner.pose_last_seen = duplicate.pose_last_seen
        if duplicate.face_last_seen > winner.face_last_seen:
            winner.face = duplicate.face
            winner.face_box = duplicate.face_box
            winner.face_center = duplicate.face_center
            winner.face_last_seen = duplicate.face_last_seen
        for hand in sorted(duplicate.hands.values(), key=lambda item: item.last_seen, reverse=True):
            if len(winner.hands) >= 2:
                break
            new_slot = max(winner.hands, default=-1) + 1
            hand.slot = new_slot
            winner.hands[new_slot] = hand
        winner.hand_last_seen = max(winner.hand_last_seen, duplicate.hand_last_seen)
        if duplicate.label_until > winner.label_until:
            winner.label_text = duplicate.label_text
            winner.label_until = duplicate.label_until

    def _merge_duplicate_tracks(self, now: float) -> None:
        index = 0
        while index < len(self.tracks):
            other_index = index + 1
            while other_index < len(self.tracks):
                first = self.tracks[index]
                second = self.tracks[other_index]
                duplicate = False
                if (
                    first.pose is not None and second.pose is not None
                    and now - first.pose_last_seen < 0.65 and now - second.pose_last_seen < 0.65
                ):
                    first_observation = self.make_pose_observation(first.pose)
                    second_observation = self.make_pose_observation(second.pose)
                    duplicate = (
                        first_observation is not None
                        and second_observation is not None
                        and self._poses_are_duplicates(first_observation, second_observation)
                    )
                if not duplicate:
                    pose_track, face_track = (first, second)
                    if second.pose_last_seen > first.pose_last_seen:
                        pose_track, face_track = second, first
                    if (
                        now - pose_track.pose_last_seen < 0.65
                        and now - face_track.face_last_seen < 0.65
                        and now - face_track.pose_last_seen >= 0.65
                    ):
                        expected_face = pose_track.expected_face_center(now)
                        if expected_face is not None:
                            duplicate = float(np.linalg.norm(
                                expected_face - face_track.face_center
                            )) < max(0.055, 0.75 * pose_track.shoulder_width())
                if not duplicate and (
                    now - first.face_last_seen < 0.65
                    and now - second.face_last_seen < 0.65
                    and first.face is not None and second.face is not None
                ):
                    duplicate = (
                        box_iou(first.face_box, second.face_box) > 0.64
                        and np.linalg.norm(first.face_center - second.face_center) < 0.045
                    )
                if duplicate:
                    winner, loser = (first, second) if first.track_id < second.track_id else (second, first)
                    self._absorb_track(winner, loser)
                    self.tracks.remove(loser)
                    if loser is first:
                        index -= 1
                        break
                    continue
                other_index += 1
            index += 1

    @staticmethod
    def make_pose_observation(landmarks: np.ndarray) -> Optional[PoseObservation]:
        if len(landmarks) < 33:
            return None
        confidence = np.minimum(landmarks[:, 3], landmarks[:, 4])
        valid = (confidence > 0.36) & (landmarks[:, 0] > -0.15) & (landmarks[:, 0] < 1.15)
        valid &= (landmarks[:, 1] > -0.15) & (landmarks[:, 1] < 1.15)
        if np.count_nonzero(valid) < 4:
            return None

        anchor_indices = [index for index in POSE_ANCHOR_JOINTS if confidence[index] > 0.40]
        if len(anchor_indices) >= 2:
            anchor = np.mean(landmarks[anchor_indices, :2], axis=0)
        else:
            usable = [index for index in POSE_MAJOR_JOINTS if valid[index]]
            anchor = np.mean(landmarks[usable, :2], axis=0)
        box = array_box(landmarks[valid, :2], padding=0.01)
        nose = landmarks[0, :2].copy() if confidence[0] > 0.40 else None
        major_confidence = confidence[[index for index in POSE_MAJOR_JOINTS if valid[index]]]
        quality = float(np.mean(major_confidence)) if len(major_confidence) else 0.0
        return PoseObservation(
            landmarks,
            anchor.astype(np.float32),
            box,
            box_scale(box),
            nose,
            quality,
        )

    @staticmethod
    def make_face_observation(landmarks: np.ndarray) -> Optional[FaceObservation]:
        if len(landmarks) < 400:
            return None
        box = array_box(landmarks[:, :2], padding=0.005)
        return FaceObservation(landmarks, box, center_of_box(box), box_scale(box))

    def update_poses(self, pose_arrays: Sequence[np.ndarray], timestamp: float) -> None:
        self.prune(timestamp)
        raw_observations = [
            observation for array in pose_arrays
            if (observation := self.make_pose_observation(array)) is not None
        ]
        observations = self._deduplicate_poses(raw_observations)
        if not observations:
            return
        if not self.tracks:
            primary = max(observations, key=lambda item: item.quality)
            track = self._new_track()
            if track is not None:
                track.update_pose(primary, timestamp)
            for observation in observations:
                if observation is primary:
                    continue
                clearly_separate = float(np.linalg.norm(
                    observation.anchor - primary.anchor
                )) > max(0.18, 0.30 * max(observation.scale, primary.scale))
                if clearly_separate:
                    track = self._new_track()
                    if track is not None:
                        track.update_pose(observation, timestamp)
                else:
                    self._queue_pose(observation, timestamp)
            self._merge_duplicate_tracks(timestamp)
            return

        costs = np.full((len(self.tracks), len(observations)), np.inf, dtype=np.float32)
        gates = np.zeros_like(costs)
        for row, track in enumerate(self.tracks):
            for column, observation in enumerate(observations):
                if timestamp - track.pose_last_seen < self.TRACK_TTL:
                    distance = float(np.linalg.norm(
                        observation.anchor - track.predicted_pose_anchor(timestamp)
                    ))
                    size_change = abs(math.log(max(0.02, observation.scale) / max(0.02, track.pose_scale)))
                    shape_cost = 0.0
                    if track.pose is not None:
                        shared = [
                            index for index in POSE_ANCHOR_JOINTS
                            if observation.landmarks[index, 3] > 0.42 and track.pose[index, 3] > 0.42
                        ]
                        if shared:
                            current_shape = observation.landmarks[shared, :2] - observation.anchor
                            previous_shape = track.pose[shared, :2] - track.pose_anchor
                            shape_cost = float(np.mean(np.linalg.norm(current_shape - previous_shape, axis=1)))
                    costs[row, column] = distance + 0.035 * size_change + 0.12 * shape_cost
                    gates[row, column] = 0.10 + 0.48 * max(observation.scale, track.pose_scale)
                elif timestamp - track.face_last_seen < self.TRACK_TTL and observation.nose is not None:
                    costs[row, column] = float(np.linalg.norm(observation.nose - track.face_center))
                    gates[row, column] = max(0.09, 1.7 * box_scale(track.face_box))

        pairs = optimal_assignment(costs, gates, miss_cost=0.29)
        used_observations: set[int] = set()
        for track_index, observation_index in pairs:
            self.tracks[track_index].update_pose(observations[observation_index], timestamp)
            used_observations.add(observation_index)

        for observation_index, observation in enumerate(observations):
            if observation_index in used_observations:
                continue
            self._queue_pose(observation, timestamp)
        self._merge_duplicate_tracks(timestamp)

    def update_faces(self, face_arrays: Sequence[np.ndarray], timestamp: float) -> None:
        self.prune(timestamp)
        raw_observations = [
            observation for array in face_arrays
            if (observation := self.make_face_observation(array)) is not None
        ][:self.max_people]
        observations = self._deduplicate_faces(raw_observations)
        if not observations:
            return
        if not self.tracks:
            primary = max(observations, key=lambda item: item.scale)
            track = self._new_track()
            if track is not None:
                track.update_face(primary, timestamp)
            for observation in observations:
                if observation is not primary:
                    self._queue_face(observation, timestamp)
            return

        costs = np.full((len(self.tracks), len(observations)), np.inf, dtype=np.float32)
        gates = np.zeros_like(costs)
        for row, track in enumerate(self.tracks):
            for column, observation in enumerate(observations):
                if timestamp - track.face_last_seen < self.TRACK_TTL:
                    costs[row, column] = float(np.linalg.norm(observation.center - track.face_center))
                    gates[row, column] = max(
                        0.075,
                        1.6 * max(observation.scale, box_scale(track.face_box)),
                    )
                else:
                    expected_face = track.expected_face_center(timestamp)
                    if expected_face is not None:
                        direct_distance = float(np.linalg.norm(observation.center - expected_face))
                        pose_box_distance = point_to_box_distance(
                            observation.center,
                            expanded_box(track.pose_box, 0.025, 0.08),
                        )
                        costs[row, column] = direct_distance + 0.20 * pose_box_distance
                        gates[row, column] = max(0.085, 0.95 * track.shoulder_width())

        pairs = optimal_assignment(costs, gates, miss_cost=0.18)
        used_observations: set[int] = set()
        for track_index, observation_index in pairs:
            self.tracks[track_index].update_face(observations[observation_index], timestamp)
            used_observations.add(observation_index)

        for observation_index, observation in enumerate(observations):
            if observation_index in used_observations:
                continue
            self._queue_face(observation, timestamp)
        self._merge_duplicate_tracks(timestamp)

    def _hand_person_cost(
        self,
        track: PersonTrack,
        observation: HandObservation,
        timestamp: float,
    ) -> tuple[float, float]:
        costs: list[float] = []
        wrist_gates: list[float] = []
        for pose_index in (15, 16):
            wrist = track.reliable_pose_point(pose_index, timestamp, threshold=0.30)
            if wrist is not None:
                costs.append(float(np.linalg.norm(observation.wrist - wrist)))
                wrist_gates.append(max(0.075, 0.60 * track.shoulder_width()))
        for hand in track.hands.values():
            if timestamp - hand.last_seen < 0.65:
                costs.append(float(np.linalg.norm(observation.wrist - hand.wrist)) + 0.008)
                wrist_gates.append(0.15)

        display_box = track.display_box(timestamp)
        if display_box != (0.0, 0.0, 0.0, 0.0):
            costs.append(point_to_box_distance(observation.center, display_box) + 0.055)
            wrist_gates.append(0.18)
        if timestamp - track.face_last_seen < 0.8:
            costs.append(float(np.linalg.norm(observation.center - track.face_center)) + 0.07)
            wrist_gates.append(0.45)
        if not costs:
            return math.inf, 0.0
        best_index = int(np.argmin(costs))
        return costs[best_index], wrist_gates[best_index]

    def update_hands(
        self,
        observations: Sequence[HandObservation],
        timestamp: float,
        aspect_ratio: float,
    ) -> list[GestureEvent]:
        self.prune(timestamp)
        assignments: dict[int, list[HandObservation]] = {index: [] for index in range(len(self.tracks))}
        candidates: list[tuple[float, int, int]] = []
        for hand_index, observation in enumerate(observations):
            for track_index, track in enumerate(self.tracks):
                cost, gate = self._hand_person_cost(track, observation, timestamp)
                if cost <= gate:
                    candidates.append((cost, hand_index, track_index))

        used_hands: set[int] = set()
        person_capacity = {index: 2 for index in range(len(self.tracks))}
        for _, hand_index, track_index in sorted(candidates):
            if hand_index in used_hands or person_capacity[track_index] <= 0:
                continue
            assignments[track_index].append(observations[hand_index])
            used_hands.add(hand_index)
            person_capacity[track_index] -= 1

        events: list[GestureEvent] = []
        for track_index, track in enumerate(self.tracks):
            fired = track.update_hands(
                assignments[track_index], timestamp, self.gesture_recognizer, aspect_ratio
            )
            if fired is not None:
                track.label_text = GESTURE_LABELS[fired.name]
                track.label_until = timestamp + 1.55
                events.append(GestureEvent(
                    track.track_id,
                    fired.name,
                    fired.confidence,
                    fired.origin.copy(),
                    track.color,
                ))
        return events

    def visible_tracks(self, now: float) -> list[PersonTrack]:
        self.prune(now)
        return [
            track for track in self.tracks
            if now - max(track.pose_last_seen, track.face_last_seen) < 0.85
        ]


class InferenceHub:
    """Runs the three MediaPipe tasks asynchronously to keep camera latency low."""

    def __init__(
        self,
        model_paths: dict[str, Path],
        max_people: int,
        tracking_fps: float,
        hand_fps: float,
        face_fps: float,
    ) -> None:
        if not hasattr(mp, "tasks") or not hasattr(mp.tasks, "vision"):
            raise RuntimeError(
                "This MediaPipe build does not contain the Tasks vision API. "
                f"Upgrade it with: {DEPENDENCY_HINT}"
            )

        self.pose_results = LatestResult()
        self.face_results = LatestResult()
        self.hand_results = LatestResult()
        self._error_lock = threading.Lock()
        self._errors: deque[tuple[float, str]] = deque(maxlen=8)
        self._recent_images: deque[Any] = deque(maxlen=10)

        self.pose_interval = 1.0 / max(1.0, tracking_fps)
        self.hand_interval = 1.0 / max(1.0, hand_fps)
        self.face_interval = 1.0 / max(1.0, face_fps)
        self._next_pose = 0.0
        self._next_hand = 0.0
        self._next_face = 0.0
        self._last_auxiliary = "face"
        self.auxiliary_throttled = True
        self._closed = False

        vision = mp.tasks.vision
        base_options = mp.tasks.BaseOptions
        running_mode = vision.RunningMode.LIVE_STREAM

        try:
            self.pose_task = vision.PoseLandmarker.create_from_options(
                vision.PoseLandmarkerOptions(
                    base_options=base_options(model_asset_path=str(model_paths["pose"])),
                    running_mode=running_mode,
                    num_poses=max_people,
                    min_pose_detection_confidence=0.39,
                    min_pose_presence_confidence=0.38,
                    min_tracking_confidence=0.46,
                    output_segmentation_masks=False,
                    result_callback=self._pose_callback,
                )
            )
            self.face_task = vision.FaceLandmarker.create_from_options(
                vision.FaceLandmarkerOptions(
                    base_options=base_options(model_asset_path=str(model_paths["face"])),
                    running_mode=running_mode,
                    num_faces=max_people,
                    min_face_detection_confidence=0.46,
                    min_face_presence_confidence=0.44,
                    min_tracking_confidence=0.46,
                    output_face_blendshapes=False,
                    output_facial_transformation_matrixes=False,
                    result_callback=self._face_callback,
                )
            )
            self.hand_task = vision.HandLandmarker.create_from_options(
                vision.HandLandmarkerOptions(
                    base_options=base_options(model_asset_path=str(model_paths["hand"])),
                    running_mode=running_mode,
                    num_hands=max_people * 2,
                    min_hand_detection_confidence=0.41,
                    min_hand_presence_confidence=0.40,
                    min_tracking_confidence=0.44,
                    result_callback=self._hand_callback,
                )
            )
        except Exception as exc:
            for task_name in ("hand_task", "face_task", "pose_task"):
                task = getattr(self, task_name, None)
                if task is not None:
                    try:
                        task.close()
                    except Exception:
                        pass
            raise RuntimeError(
                "MediaPipe could not initialize its model bundles. The cache may be "
                "incomplete; retry with --redownload-models. "
                f"Original error: {exc}"
            ) from exc

    def _record_error(self, source: str, exc: BaseException) -> None:
        message = f"{source} inference warning: {type(exc).__name__}: {exc}"
        with self._error_lock:
            if not self._errors or self._errors[-1][1] != message:
                self._errors.append((time.perf_counter(), message))

    def pop_error(self) -> Optional[tuple[float, str]]:
        with self._error_lock:
            return self._errors.popleft() if self._errors else None

    def _pose_callback(self, result: Any, _image: Any, timestamp_ms: int) -> None:
        try:
            poses = [
                landmarks_to_array(landmarks, include_confidence=True)
                for landmarks in (getattr(result, "pose_landmarks", None) or [])
            ]
            self.pose_results.publish(timestamp_ms, poses)
        except Exception as exc:
            self._record_error("Pose", exc)

    def _face_callback(self, result: Any, _image: Any, timestamp_ms: int) -> None:
        try:
            faces = [
                landmarks_to_array(landmarks)
                for landmarks in (getattr(result, "face_landmarks", None) or [])
            ]
            self.face_results.publish(timestamp_ms, faces)
        except Exception as exc:
            self._record_error("Face", exc)

    def _hand_callback(self, result: Any, _image: Any, timestamp_ms: int) -> None:
        try:
            landmark_sets = getattr(result, "hand_landmarks", None) or []
            handedness_sets = getattr(result, "handedness", None) or []
            hands: list[HandObservation] = []
            for index, landmarks in enumerate(landmark_sets):
                label = ""
                score = 0.0
                if index < len(handedness_sets) and handedness_sets[index]:
                    category = handedness_sets[index][0]
                    label = (
                        getattr(category, "category_name", None)
                        or getattr(category, "display_name", None)
                        or ""
                    )
                    score = landmark_value(category, "score", 0.0)
                hands.append(HandObservation(landmarks_to_array(landmarks), label, score))
            self.hand_results.publish(timestamp_ms, hands)
        except Exception as exc:
            self._record_error("Hand", exc)

    def submit(
        self,
        bgr_image: np.ndarray,
        timestamp_ms: int,
        now: float,
        need_hands: bool,
        inference_width: int,
    ) -> None:
        if self._closed:
            return
        pose_due = now >= self._next_pose
        pose_lag = self.pose_results.age(timestamp_ms)
        self.auxiliary_throttled = not math.isfinite(pose_lag) or pose_lag > 0.16
        hand_due = need_hands and now >= self._next_hand
        face_due = now >= self._next_face
        auxiliary: Optional[str] = None
        if not self.auxiliary_throttled:
            if hand_due and face_due:
                auxiliary = "hand" if self._last_auxiliary == "face" else "face"
            elif hand_due:
                auxiliary = "hand"
            elif face_due:
                auxiliary = "face"
        if not pose_due and auxiliary is None:
            return

        analysis_width = min(inference_width, bgr_image.shape[1])
        if analysis_width < bgr_image.shape[1]:
            analysis_height = max(
                2,
                int(bgr_image.shape[0] * analysis_width / bgr_image.shape[1]),
            )
            analysis_height -= analysis_height % 2
            analysis_frame = cv2.resize(
                bgr_image,
                (analysis_width, analysis_height),
                interpolation=cv2.INTER_AREA,
            )
        else:
            analysis_frame = bgr_image
        rgb_image = np.ascontiguousarray(cv2.cvtColor(analysis_frame, cv2.COLOR_BGR2RGB))

        submitted = False
        try:
            image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_image)
        except Exception as exc:
            self._record_error("Image conversion", exc)
            return

        if pose_due:
            try:
                self.pose_task.detect_async(image, timestamp_ms)
                submitted = True
            except Exception as exc:
                self._record_error("Pose", exc)
            self._next_pose = now + self.pose_interval

        if auxiliary == "hand":
            try:
                self.hand_task.detect_async(image, timestamp_ms)
                submitted = True
            except Exception as exc:
                self._record_error("Hand", exc)
            self._next_hand = now + self.hand_interval
            self._last_auxiliary = "hand"

        elif auxiliary == "face":
            try:
                self.face_task.detect_async(image, timestamp_ms)
                submitted = True
            except Exception as exc:
                self._record_error("Face", exc)
            self._next_face = now + self.face_interval
            self._last_auxiliary = "face"

        # Keep backing arrays alive while the native tasks may still reference them.
        if submitted:
            self._recent_images.append(image)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        for task in (self.hand_task, self.face_task, self.pose_task):
            try:
                task.close()
            except Exception as exc:
                self._record_error("Shutdown", exc)
        self._recent_images.clear()


def default_model_directory() -> Path:
    if os.name == "nt" and os.getenv("LOCALAPPDATA"):
        base = Path(os.environ["LOCALAPPDATA"])
    else:
        base = Path(os.getenv("XDG_CACHE_HOME", Path.home() / ".cache"))
    return base / "HumanTrackingDemo" / "models"


def download_file(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".part")
    if temporary.exists():
        temporary.unlink()

    print(f"  Downloading {destination.name} ...")
    request = urllib.request.Request(url, headers={"User-Agent": "HumanTrackingDemo/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=45) as response, temporary.open("wb") as output:
            total = int(response.headers.get("Content-Length", "0") or "0")
            downloaded = 0
            next_report = 25
            while True:
                chunk = response.read(1024 * 256)
                if not chunk:
                    break
                output.write(chunk)
                downloaded += len(chunk)
                if total > 0:
                    percent = int(downloaded * 100 / total)
                    if percent >= next_report:
                        print(f"    {min(percent, 100):3d}%")
                        next_report += 25
        if temporary.stat().st_size < 512_000:
            raise RuntimeError("downloaded file is unexpectedly small")
        temporary.replace(destination)
    except (OSError, urllib.error.URLError, RuntimeError) as exc:
        if temporary.exists():
            temporary.unlink()
        raise RuntimeError(
            f"Could not download {destination.name}. Check the internet connection, "
            f"then run again. Source: {url}. Error: {exc}"
        ) from exc


def ensure_models(
    model_directory: Path,
    pose_model: str,
    redownload: bool,
) -> dict[str, Path]:
    model_directory.mkdir(parents=True, exist_ok=True)
    wanted = {
        "pose": MODEL_URLS[f"pose_{pose_model}"],
        "face": MODEL_URLS["face"],
        "hand": MODEL_URLS["hand"],
    }
    paths: dict[str, Path] = {}
    missing = []
    for role, (filename, url) in wanted.items():
        path = model_directory / filename
        if redownload and path.exists():
            path.unlink()
        if not path.exists() or path.stat().st_size < 512_000:
            missing.append((role, path, url))
        paths[role] = path

    if missing:
        print(f"First-time model setup in: {model_directory}")
        for _, path, url in missing:
            download_file(url, path)
        print("  Model setup complete.\n")
    return paths


def draw_outlined_text(
    frame: np.ndarray,
    text: str,
    position: tuple[int, int],
    font_scale: float,
    color: tuple[int, int, int],
    thickness: int = 1,
) -> None:
    cv2.putText(
        frame, text, (position[0] + 1, position[1] + 1),
        cv2.FONT_HERSHEY_SIMPLEX, font_scale, (10, 12, 16), thickness + 3, cv2.LINE_AA,
    )
    cv2.putText(
        frame, text, position, cv2.FONT_HERSHEY_SIMPLEX,
        font_scale, color, thickness, cv2.LINE_AA,
    )


def draw_person_overlays(
    frame: np.ndarray,
    tracks: Sequence[PersonTrack],
    now: float,
    show_hands: bool,
) -> None:
    height, width = frame.shape[:2]
    scale = clamp(height / 720.0, 0.70, 1.60)
    overlay = frame.copy()
    shadow = (5, 9, 15)

    for track in tracks:
        pose_opacity = alpha_for_age(now - track.pose_last_seen, 0.22, 0.92)
        face_opacity = alpha_for_age(now - track.face_last_seen, 0.25, 0.82)
        pose_color = color_scale(track.color, 0.18 + 0.82 * pose_opacity)

        if track.pose is not None and pose_opacity > 0.0:
            pose = track.display_pose(now)
            if pose is None:
                continue
            line_width = max(2, round(3 * scale))
            for start, end in POSE_CONNECTIONS:
                if (
                    pose[start, 3] < 0.48 or pose[end, 3] < 0.48
                    or pose[start, 4] < 0.42 or pose[end, 4] < 0.42
                ):
                    continue
                first = normalized_to_pixel(pose[start], width, height)
                second = normalized_to_pixel(pose[end], width, height)
                cv2.line(overlay, first, second, shadow, line_width + 4, cv2.LINE_AA)
                cv2.line(overlay, first, second, pose_color, line_width, cv2.LINE_AA)
            for index in POSE_MAJOR_JOINTS:
                point = pose[index]
                if point[3] < 0.50 or point[4] < 0.44:
                    continue
                center = normalized_to_pixel(point, width, height)
                radius = max(3, round((5 if index in (11, 12, 23, 24) else 4) * scale))
                cv2.circle(overlay, center, radius + 2, shadow, -1, cv2.LINE_AA)
                cv2.circle(overlay, center, radius, pose_color, -1, cv2.LINE_AA)
                cv2.circle(overlay, center, max(1, radius // 3), (245, 250, 252), -1, cv2.LINE_AA)

        if track.face is not None and face_opacity > 0.0:
            face_color = color_scale(track.color, 0.18 + 0.82 * face_opacity)
            line_width = max(1, round(1.7 * scale))
            for curve in FACE_CURVES:
                if max(curve) >= len(track.face):
                    continue
                points = np.asarray(
                    [normalized_to_pixel(track.face[index], width, height) for index in curve],
                    dtype=np.int32,
                )
                cv2.polylines(overlay, [points], False, shadow, line_width + 2, cv2.LINE_AA)
                cv2.polylines(overlay, [points], False, face_color, line_width, cv2.LINE_AA)
            for index in (1, 33, 133, 263, 362, 61, 291):
                center = normalized_to_pixel(track.face[index], width, height)
                cv2.circle(overlay, center, max(1, round(2 * scale)), face_color, -1, cv2.LINE_AA)

        if show_hands:
            for hand in track.hands.values():
                hand_landmarks = hand.display_landmarks(now)
                if hand_landmarks is None:
                    continue
                hand_opacity = alpha_for_age(now - hand.last_seen, 0.16, 0.48)
                if hand_opacity <= 0.0:
                    continue
                hand_color = color_scale(track.color, 0.18 + 0.82 * hand_opacity)
                line_width = max(1, round(2.2 * scale))
                for start, end in HAND_CONNECTIONS:
                    first = normalized_to_pixel(hand_landmarks[start], width, height)
                    second = normalized_to_pixel(hand_landmarks[end], width, height)
                    cv2.line(overlay, first, second, shadow, line_width + 3, cv2.LINE_AA)
                    cv2.line(overlay, first, second, hand_color, line_width, cv2.LINE_AA)
                for index, point in enumerate(hand_landmarks):
                    center = normalized_to_pixel(point, width, height)
                    radius = max(2, round((4.2 if index in HAND_TIPS else 2.7) * scale))
                    cv2.circle(overlay, center, radius + 1, shadow, -1, cv2.LINE_AA)
                    cv2.circle(overlay, center, radius, hand_color, -1, cv2.LINE_AA)

    cv2.addWeighted(overlay, 0.86, frame, 0.14, 0.0, frame)

    # Identity and gesture labels stay crisp after the translucent geometry pass.
    for track in tracks:
        box = track.display_box(now)
        if box == (0.0, 0.0, 0.0, 0.0):
            continue
        x1, y1 = normalized_to_pixel((box[0], box[1]), width, height)
        identity_y = max(round(72 * scale), y1 - round(8 * scale))
        cv2.circle(frame, (x1 + round(5 * scale), identity_y - round(4 * scale)),
                   max(3, round(4 * scale)), track.color, -1, cv2.LINE_AA)
        draw_outlined_text(
            frame, f"P{track.track_id}", (x1 + round(14 * scale), identity_y),
            0.42 * scale, track.color, max(1, round(scale)),
        )
        if track.label_text and now < track.label_until:
            label_x = int((box[0] + box[2]) * 0.5 * width)
            label_y = max(int(box[1] * height) - round(30 * scale), round(92 * scale))
            label_scale = 0.54 * scale
            (label_width, _), _ = cv2.getTextSize(
                track.label_text, cv2.FONT_HERSHEY_SIMPLEX, label_scale, max(1, round(scale))
            )
            draw_outlined_text(
                frame, track.label_text, (label_x - label_width // 2, label_y),
                label_scale, track.color, max(1, round(scale)),
            )


@dataclass
class ReactionEffect:
    gesture: str
    origin: np.ndarray
    started: float


class EmojiRenderer:
    """Caches native emoji glyphs as small RGBA sprites for cheap blending."""

    def __init__(self) -> None:
        windows_directory = Path(os.getenv("WINDIR", r"C:\Windows"))
        candidates = [
            windows_directory / "Fonts" / "seguiemj.ttf",
            Path("/System/Library/Fonts/Apple Color Emoji.ttc"),
            Path("/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf"),
            Path("/usr/share/fonts/truetype/noto/NotoEmoji-Regular.ttf"),
        ]
        self.font_path = next((path for path in candidates if path.exists()), None)
        if self.font_path is None:
            raise RuntimeError(
                "No system emoji font was found. Install or restore Segoe UI Emoji "
                "(Windows) or Noto Color Emoji (Linux)."
            )
        self.cache: dict[tuple[str, int], np.ndarray] = {}
        self.supported_sizes = self._probe_supported_sizes()

    def _probe_supported_sizes(self) -> list[int]:
        """Font sizes this emoji font will actually accept.

        Apple Color Emoji is a bitmap (sbix) font: it only contains a handful of
        fixed pixel strikes, and asking for any other size raises
        ``OSError: invalid pixel size``. On macOS the accepted set is roughly
        20/32/40/48/64/96/160, so the demo's old ``round(size/8)*8`` sizing
        crashed as soon as it landed on 28, 56, 72, 80 and so on. Scalable fonts
        (Noto, Segoe UI Emoji) accept everything and this returns empty, which
        disables the snapping below.
        """
        if self.font_path is None:
            return []
        candidates = [16, 20, 24, 28, 32, 40, 48, 56, 64, 72, 80, 96, 128, 160, 256]
        supported = []
        for size in candidates:
            try:
                ImageFont.truetype(str(self.font_path), size)
            except OSError:
                continue
            supported.append(size)
        # Every size worked => scalable font, no snapping needed.
        return [] if len(supported) == len(candidates) else supported

    def _snap_size(self, size: int) -> int:
        """Nearest size the font can actually render."""
        if not self.supported_sizes:
            return size
        return min(self.supported_sizes, key=lambda s: (abs(s - size), s))

    def _sprite(self, gesture: str, requested_size: int) -> np.ndarray:
        text = GESTURE_EMOJIS[gesture]
        font_size = max(28, int(round(requested_size / 8.0) * 8))
        key = (text, font_size)
        if key in self.cache:
            return self.cache[key]
        render_size = self._snap_size(font_size)
        font = ImageFont.truetype(str(self.font_path), render_size)
        bounds = font.getbbox(text)
        margin = max(4, render_size // 12)
        image = Image.new(
            "RGBA",
            (max(1, bounds[2] - bounds[0] + 2 * margin),
             max(1, bounds[3] - bounds[1] + 2 * margin)),
            (0, 0, 0, 0),
        )
        drawing = ImageDraw.Draw(image)
        position = (margin - bounds[0], margin - bounds[1])
        try:
            drawing.text(position, text, font=font, embedded_color=True)
        except (TypeError, ValueError, OSError):
            drawing.text(position, text, font=font, fill=(255, 255, 255, 255))
        # Rendered at a strike the font supports; scale to the size actually
        # asked for so reactions still grow and shrink smoothly.
        if render_size != font_size and image.width > 0 and image.height > 0:
            scale = font_size / render_size
            image = image.resize(
                (max(1, int(image.width * scale)), max(1, int(image.height * scale))),
                Image.LANCZOS,
            )
        sprite = np.asarray(image, dtype=np.uint8)
        self.cache[key] = sprite
        return sprite

    def draw(
        self,
        frame: np.ndarray,
        gesture: str,
        center: tuple[int, int],
        size: int,
        opacity: float,
    ) -> None:
        sprite = self._sprite(gesture, size)
        sprite_height, sprite_width = sprite.shape[:2]
        x1 = center[0] - sprite_width // 2
        y1 = center[1] - sprite_height // 2
        x2, y2 = x1 + sprite_width, y1 + sprite_height
        frame_x1, frame_y1 = max(0, x1), max(0, y1)
        frame_x2, frame_y2 = min(frame.shape[1], x2), min(frame.shape[0], y2)
        if frame_x1 >= frame_x2 or frame_y1 >= frame_y2:
            return
        sprite_x1, sprite_y1 = frame_x1 - x1, frame_y1 - y1
        sprite_x2 = sprite_x1 + frame_x2 - frame_x1
        sprite_y2 = sprite_y1 + frame_y2 - frame_y1
        cropped = sprite[sprite_y1:sprite_y2, sprite_x1:sprite_x2]
        alpha = cropped[:, :, 3:4].astype(np.float32) * (clamp(opacity, 0.0, 1.0) / 255.0)
        foreground = cropped[:, :, :3][:, :, ::-1].astype(np.float32)
        target = frame[frame_y1:frame_y2, frame_x1:frame_x2]
        background = target.astype(np.float32)
        target[:] = np.clip(foreground * alpha + background * (1.0 - alpha), 0, 255).astype(np.uint8)


class ReactionManager:
    DURATION = 1.70

    def __init__(self) -> None:
        self.effects: list[ReactionEffect] = []
        self.emoji = EmojiRenderer()

    def add(self, event: GestureEvent, now: float) -> None:
        self.effects.append(ReactionEffect(
            event.name,
            np.clip(event.origin.astype(np.float32), 0.0, 1.0),
            now,
        ))

    def clear(self) -> None:
        self.effects.clear()

    def _draw_effect(self, frame: np.ndarray, effect: ReactionEffect, now: float) -> None:
        elapsed = now - effect.started
        progress = elapsed / self.DURATION
        if progress < 0.0 or progress >= 1.0:
            return
        height, width = frame.shape[:2]
        unit = min(width, height)
        origin = normalized_to_pixel(effect.origin, width, height)
        fade_in = clamp(elapsed / 0.12, 0.0, 1.0)
        fade_out = clamp((self.DURATION - elapsed) / 0.35, 0.0, 1.0)
        alpha = fade_in * fade_out
        pop = 1.0 - (1.0 - clamp(elapsed / 0.22, 0.0, 1.0)) ** 3
        base_size = unit * (0.15 if effect.gesture == "DOUBLE_THUMBS_UP" else 0.12)
        size = int(base_size * (0.78 + 0.22 * pop))
        center = (
            int(origin[0] + math.sin(elapsed * 3.2) * unit * 0.012),
            int(origin[1] - unit * (0.035 + 0.055 * progress)),
        )
        self.emoji.draw(frame, effect.gesture, center, size, alpha)

    def draw(self, frame: np.ndarray, now: float) -> None:
        self.effects = [effect for effect in self.effects if now - effect.started < self.DURATION]
        for effect in self.effects:
            self._draw_effect(frame, effect, now)


def draw_ui(
    frame: np.ndarray,
    fps: float,
    people: int,
    faces: int,
    hands: int,
    show_hands: bool,
    reactions_enabled: bool,
    debug_lines: Sequence[str],
    warning: Optional[str],
) -> None:
    height, width = frame.shape[:2]
    scale = clamp(height / 540.0, 0.78, 1.45)
    compact = width < 820
    header_height = round((76 if compact else 58) * scale)
    footer_height = round(38 * scale)
    overlay = frame.copy()
    cv2.rectangle(overlay, (0, 0), (width, header_height), (22, 25, 31), -1)
    cv2.rectangle(overlay, (0, height - footer_height), (width, height), (22, 25, 31), -1)
    cv2.addWeighted(overlay, 0.70, frame, 0.30, 0.0, frame)

    title_y = round(27 * scale)
    draw_outlined_text(
        frame, "Live Human Tracking", (round(14 * scale), title_y),
        0.62 * scale, (80, 235, 210), max(1, round(1.4 * scale)),
    )
    stats = f"{fps:4.1f} FPS  |  People {people}  |  Faces {faces}  |  Hands {hands}"
    stats_scale = 0.43 * scale
    (stats_width, _), _ = cv2.getTextSize(
        stats, cv2.FONT_HERSHEY_SIMPLEX, stats_scale, max(1, round(scale))
    )
    stats_x = round(14 * scale) if compact else width - stats_width - round(14 * scale)
    stats_y = round(53 * scale) if compact else title_y
    draw_outlined_text(
        frame, stats, (stats_x, stats_y), stats_scale,
        (235, 240, 245), max(1, round(scale)),
    )

    controls = "Q Quit  |  F Fullscreen  |  H Hands  |  G Reactions  |  D Debug"
    controls_y = height - round(13 * scale)
    draw_outlined_text(
        frame, controls, (round(14 * scale), controls_y),
        0.36 * scale, (225, 230, 236), max(1, round(scale)),
    )
    if not compact:
        states = f"Hands {'ON' if show_hands else 'OFF'}  |  Reactions {'ON' if reactions_enabled else 'OFF'}"
        state_scale = 0.34 * scale
        (state_width, _), _ = cv2.getTextSize(
            states, cv2.FONT_HERSHEY_SIMPLEX, state_scale, max(1, round(scale))
        )
        draw_outlined_text(
            frame, states, (width - state_width - round(14 * scale), controls_y),
            state_scale, (100, 240, 160), max(1, round(scale)),
        )

    if debug_lines:
        panel_width = min(round(330 * scale), width)
        line_height = round(18 * scale)
        panel_height = round(12 * scale) + line_height * len(debug_lines)
        x1 = width - panel_width
        y1 = header_height
        debug_layer = frame.copy()
        cv2.rectangle(debug_layer, (x1, y1), (width, y1 + panel_height), (18, 21, 27), -1)
        cv2.addWeighted(debug_layer, 0.72, frame, 0.28, 0.0, frame)
        for index, line in enumerate(debug_lines):
            draw_outlined_text(
                frame, line,
                (x1 + round(9 * scale), y1 + round(17 * scale) + index * line_height),
                0.33 * scale, (195, 215, 230), max(1, round(scale)),
            )

    if warning:
        warning_text = warning[:105]
        warning_y = header_height + round(24 * scale)
        warning_layer = frame.copy()
        cv2.rectangle(
            warning_layer, (0, header_height),
            (width, header_height + round(34 * scale)), (25, 50, 115), -1,
        )
        cv2.addWeighted(warning_layer, 0.76, frame, 0.24, 0.0, frame)
        draw_outlined_text(
            frame, warning_text, (round(14 * scale), warning_y),
            0.36 * scale, (240, 245, 255), max(1, round(scale)),
        )


def draw_camera_warning(frame: np.ndarray, elapsed: float) -> None:
    dimmed = np.zeros_like(frame)
    cv2.addWeighted(frame, 0.32, dimmed, 0.68, 0.0, frame)
    height, width = frame.shape[:2]
    scale = clamp(height / 720.0, 0.75, 1.5)
    text = "CAMERA SIGNAL LOST - RETRYING"
    font = cv2.FONT_HERSHEY_DUPLEX
    (text_width, _), _ = cv2.getTextSize(text, font, 0.72 * scale, max(2, round(2 * scale)))
    cv2.putText(frame, text, ((width - text_width) // 2, height // 2), font, 0.72 * scale,
                (120, 190, 255), max(2, round(2 * scale)), cv2.LINE_AA)
    dots = "." * (1 + int(elapsed * 2) % 3)
    detail = f"Checking webcam connection{dots}"
    (detail_width, _), _ = cv2.getTextSize(detail, font, 0.38 * scale, max(1, round(scale)))
    cv2.putText(frame, detail, ((width - detail_width) // 2, height // 2 + round(34 * scale)),
                font, 0.38 * scale, (195, 205, 220), max(1, round(scale)), cv2.LINE_AA)


def open_camera(
    camera_index: int,
    requested_width: int,
    requested_height: int,
    requested_fps: float,
) -> tuple[Any, np.ndarray, str]:
    backends = [cv2.CAP_ANY]
    if os.name == "nt" and hasattr(cv2, "CAP_DSHOW"):
        backends.insert(0, cv2.CAP_DSHOW)

    errors: list[str] = []
    for backend in backends:
        capture = cv2.VideoCapture(camera_index, backend)
        if not capture.isOpened():
            errors.append(f"backend {backend}: device did not open")
            capture.release()
            continue

        if os.name == "nt":
            capture.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
        capture.set(cv2.CAP_PROP_FRAME_WIDTH, requested_width)
        capture.set(cv2.CAP_PROP_FRAME_HEIGHT, requested_height)
        capture.set(cv2.CAP_PROP_FPS, requested_fps)
        if hasattr(cv2, "CAP_PROP_BUFFERSIZE"):
            capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)

        first_frame: Optional[np.ndarray] = None
        deadline = time.perf_counter() + 3.0
        while time.perf_counter() < deadline:
            ok, candidate = capture.read()
            if ok and candidate is not None and candidate.size > 0:
                first_frame = candidate
                break
            time.sleep(0.04)
        if first_frame is None:
            errors.append(f"backend {backend}: opened, but returned no frames")
            capture.release()
            continue

        try:
            backend_name = capture.getBackendName()
        except Exception:
            backend_name = str(backend)
        return capture, first_frame, backend_name

    detail = "; ".join(errors) if errors else "unknown camera error"
    raise RuntimeError(
        f"Webcam {camera_index} could not be opened ({detail}). Close other camera "
        "applications and check the operating-system camera privacy permission."
    )


class HumanTrackingApplication:
    def __init__(self, args: argparse.Namespace, model_paths: dict[str, Path]) -> None:
        self.args = args
        self.model_paths = model_paths
        self.tracker = TrackManager(args.max_people)
        self.reactions = ReactionManager()
        self.show_hands = not args.hide_hands
        self.reactions_enabled = not args.no_reactions
        self.debug_enabled = False
        self.fullscreen = bool(args.fullscreen)
        self.sequence = {"pose": 0, "face": 0, "hand": 0}
        self.face_count = 0
        self.hand_count = 0
        self.face_count_time = -math.inf
        self.hand_count_time = -math.inf
        self.clock_origin = 0.0
        self.fps = 0.0
        self.last_frame_time = 0.0
        self.warning_text: Optional[str] = None
        self.warning_until = 0.0
        self.camera_description = ""

    def _event_time(self, timestamp_ms: int) -> float:
        return self.clock_origin + timestamp_ms / 1000.0

    def process_results(
        self,
        hub: InferenceHub,
        now: float,
        aspect_ratio: float,
    ) -> None:
        pose_item = hub.pose_results.get_after(self.sequence["pose"])
        if pose_item is not None:
            sequence, timestamp_ms, poses = pose_item
            self.sequence["pose"] = sequence
            self.tracker.update_poses(poses, self._event_time(timestamp_ms))

        face_item = hub.face_results.get_after(self.sequence["face"])
        if face_item is not None:
            sequence, timestamp_ms, faces = face_item
            self.sequence["face"] = sequence
            timestamp = self._event_time(timestamp_ms)
            self.tracker.update_faces(faces, timestamp)
            self.face_count = sum(
                timestamp - track.face_last_seen < 0.20
                for track in self.tracker.tracks
            )
            self.face_count_time = timestamp

        hand_item = hub.hand_results.get_after(self.sequence["hand"])
        if hand_item is not None:
            sequence, timestamp_ms, hands = hand_item
            self.sequence["hand"] = sequence
            timestamp = self._event_time(timestamp_ms)
            events = self.tracker.update_hands(hands, timestamp, aspect_ratio)
            self.hand_count = sum(
                timestamp - hand.last_seen < 0.20
                for track in self.tracker.tracks
                for hand in track.hands.values()
            )
            self.hand_count_time = timestamp
            for event in events:
                if self.reactions_enabled:
                    self.reactions.add(event, now)
                else:
                    track = next(
                        (item for item in self.tracker.tracks if item.track_id == event.track_id),
                        None,
                    )
                    if track is not None:
                        track.label_until = 0.0

        while True:
            error = hub.pop_error()
            if error is None:
                break
            _, message = error
            print(message, file=sys.stderr)
            self.warning_text = message
            self.warning_until = now + 4.0

        self.tracker.prune(now)

    def update_fps(self, now: float) -> None:
        if self.last_frame_time > 0.0:
            dt = clamp(now - self.last_frame_time, 1.0 / 240.0, 1.0)
            instantaneous = 1.0 / dt
            if self.fps <= 0.0:
                self.fps = instantaneous
            else:
                alpha = 1.0 - math.exp(-dt / 0.55)
                self.fps += alpha * (instantaneous - self.fps)
        self.last_frame_time = now

    def _debug_lines(
        self,
        hub: InferenceHub,
        current_timestamp_ms: int,
        frame_shape: tuple[int, ...],
        now: float,
    ) -> list[str]:
        if not self.debug_enabled:
            return []

        def format_age(value: float) -> str:
            return "wait" if not math.isfinite(value) else f"{value * 1000:4.0f}ms"

        lines = [
            f"CAM {frame_shape[1]}x{frame_shape[0]} | {self.camera_description}",
            "RESULT AGE  pose {}  face {}  hand {}".format(
                format_age(hub.pose_results.age(current_timestamp_ms)),
                format_age(hub.face_results.age(current_timestamp_ms)),
                format_age(hub.hand_results.age(current_timestamp_ms)),
            ),
            f"CPU AUXILIARY {'PAUSED (POSE PRIORITY)' if hub.auxiliary_throttled else 'ACTIVE'}",
            f"ACTIVE TRACKS {len(self.tracker.tracks)}/{self.args.max_people}",
        ]
        for track in self.tracker.tracks:
            lines.append(
                f"P{track.track_id:<2} age {max(0.0, now-track.last_seen)*1000:4.0f}ms  "
                f"hands {sum(now-hand.last_seen < 0.45 for hand in track.hands.values())}  "
                f"gesture {track.gesture.debug_name}"
            )
        return lines

    def _set_fullscreen(self) -> None:
        try:
            mode = cv2.WINDOW_FULLSCREEN if self.fullscreen else cv2.WINDOW_NORMAL
            cv2.setWindowProperty(WINDOW_NAME, cv2.WND_PROP_FULLSCREEN, mode)
        except cv2.error as exc:
            self.warning_text = f"Fullscreen control is unavailable: {exc}"
            self.warning_until = time.perf_counter() + 3.0

    def handle_key(self, key: int) -> bool:
        if key < 0:
            return False
        key &= 0xFF
        if key in (27, ord("q"), ord("Q")):
            return True
        if key in (ord("f"), ord("F")):
            self.fullscreen = not self.fullscreen
            self._set_fullscreen()
        elif key in (ord("h"), ord("H")):
            self.show_hands = not self.show_hands
        elif key in (ord("g"), ord("G")):
            self.reactions_enabled = not self.reactions_enabled
            if not self.reactions_enabled:
                self.reactions.clear()
                for track in self.tracker.tracks:
                    track.label_until = 0.0
        elif key in (ord("d"), ord("D")):
            self.debug_enabled = not self.debug_enabled
        return False

    @staticmethod
    def window_was_closed() -> bool:
        try:
            return cv2.getWindowProperty(WINDOW_NAME, cv2.WND_PROP_VISIBLE) < 1.0
        except cv2.error:
            return False

    def run(self) -> int:
        capture: Any = None
        hub: Optional[InferenceHub] = None
        exit_code = 0
        try:
            print(f"Opening webcam {self.args.camera} ...")
            capture, pending_frame, backend_name = open_camera(
                self.args.camera,
                self.args.width,
                self.args.height,
                self.args.camera_fps,
            )
            self.camera_description = backend_name
            actual_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
            actual_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
            actual_fps = capture.get(cv2.CAP_PROP_FPS)
            print(f"  Camera ready: {actual_width}x{actual_height} @ {actual_fps:.1f} FPS ({backend_name})")
            print("Loading MediaPipe tracking engines ...")
            hub = InferenceHub(
                self.model_paths,
                self.args.max_people,
                self.args.tracking_fps,
                self.args.hand_fps,
                self.args.face_fps,
            )
            print("  Tracking active. Press Q or Esc to quit.\n")

            try:
                cv2.namedWindow(WINDOW_NAME, cv2.WINDOW_NORMAL)
                cv2.resizeWindow(WINDOW_NAME, max(640, actual_width), max(480, actual_height))
            except cv2.error as exc:
                raise RuntimeError(
                    "OpenCV could not create a display window. A desktop session and an "
                    f"OpenCV build with GUI support are required. Original error: {exc}"
                ) from exc
            if self.fullscreen:
                self._set_fullscreen()

            self.clock_origin = time.perf_counter()
            self.last_frame_time = self.clock_origin
            last_timestamp_ms = -1
            last_good_frame: Optional[np.ndarray] = None
            failure_started: Optional[float] = None

            while True:
                now = time.perf_counter()
                if pending_frame is not None:
                    ok, frame = True, pending_frame
                    pending_frame = None
                else:
                    ok, frame = capture.read()

                if not ok or frame is None or frame.size == 0:
                    if failure_started is None:
                        failure_started = now
                    elapsed = now - failure_started
                    canvas = (
                        last_good_frame.copy()
                        if last_good_frame is not None
                        else np.zeros((self.args.height, self.args.width, 3), dtype=np.uint8)
                    )
                    draw_camera_warning(canvas, elapsed)
                    visible = self.tracker.visible_tracks(now)
                    face_count = self.face_count if now - self.face_count_time < 0.85 else 0
                    hand_count = self.hand_count if now - self.hand_count_time < 0.65 else 0
                    draw_ui(
                        canvas, self.fps, len(visible), face_count, hand_count,
                        self.show_hands, self.reactions_enabled, [], None,
                    )
                    cv2.imshow(WINDOW_NAME, canvas)
                    if self.handle_key(cv2.waitKey(30)) or self.window_was_closed():
                        break
                    if elapsed > 6.0:
                        print("Webcam stopped returning frames for more than six seconds.", file=sys.stderr)
                        exit_code = 1
                        break
                    continue

                failure_started = None
                frame = cv2.flip(frame, 1)
                last_good_frame = frame.copy()
                now = time.perf_counter()
                self.update_fps(now)

                aspect_ratio = frame.shape[1] / max(1, frame.shape[0])

                timestamp_ms = max(last_timestamp_ms + 1, int((now - self.clock_origin) * 1000.0))
                last_timestamp_ms = timestamp_ms
                hub.submit(
                    frame,
                    timestamp_ms,
                    now,
                    need_hands=self.show_hands or self.reactions_enabled,
                    inference_width=self.args.inference_width,
                )
                self.process_results(hub, now, aspect_ratio)

                visible_tracks = self.tracker.visible_tracks(now)
                draw_person_overlays(frame, visible_tracks, now, self.show_hands)
                if self.reactions_enabled:
                    self.reactions.draw(frame, now)

                face_count = self.face_count if now - self.face_count_time < 0.85 else 0
                hand_count = self.hand_count if now - self.hand_count_time < 0.65 else 0
                warning = self.warning_text if now < self.warning_until else None
                debug_lines = self._debug_lines(hub, timestamp_ms, frame.shape, now)
                draw_ui(
                    frame,
                    self.fps,
                    len(visible_tracks),
                    face_count,
                    hand_count,
                    self.show_hands,
                    self.reactions_enabled,
                    debug_lines,
                    warning,
                )

                cv2.imshow(WINDOW_NAME, frame)
                if self.handle_key(cv2.waitKey(1)) or self.window_was_closed():
                    break

        finally:
            if capture is not None:
                capture.release()
            if hub is not None:
                hub.close()
            try:
                cv2.destroyAllWindows()
                cv2.waitKey(1)
            except cv2.error:
                pass
        return exit_code


def positive_integer(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def people_count(value: str) -> int:
    parsed = int(value)
    if not 1 <= parsed <= MAX_PEOPLE_LIMIT:
        raise argparse.ArgumentTypeError(f"must be between 1 and {MAX_PEOPLE_LIMIT}")
    return parsed


def positive_float(value: str) -> float:
    parsed = float(value)
    if parsed <= 0.0:
        raise argparse.ArgumentTypeError("must be positive")
    return parsed


def parse_arguments(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Polished real-time body, face, hand, and intentional gesture tracking "
            "for as many as five people. No whole-body pose classification is used."
        ),
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--camera", type=int, default=0, help="webcam device index")
    parser.add_argument("--width", type=positive_integer, default=960, help="requested camera width")
    parser.add_argument("--height", type=positive_integer, default=540, help="requested camera height")
    parser.add_argument("--camera-fps", type=positive_float, default=30.0, help="requested webcam FPS")
    parser.add_argument(
        "--inference-width", type=positive_integer, default=640,
        help="analysis width; lower values trade detail for speed",
    )
    parser.add_argument(
        "--max-people", type=people_count, default=5,
        help="maximum simultaneous people (1-5)",
    )
    parser.add_argument(
        "--pose-model", choices=("lite", "full"), default="lite",
        help="lite favors multi-person FPS; full favors landmark precision",
    )
    parser.add_argument(
        "--tracking-fps", type=positive_float, default=30.0,
        help="maximum body submissions per second",
    )
    parser.add_argument(
        "--hand-fps", type=positive_float, default=16.0,
        help="maximum hand submissions per second when pose inference is current",
    )
    parser.add_argument(
        "--face-fps", type=positive_float, default=6.0,
        help="maximum face submissions per second when pose inference is current",
    )
    parser.add_argument(
        "--model-dir", type=Path, default=default_model_directory(),
        help="directory for automatically downloaded MediaPipe models",
    )
    parser.add_argument(
        "--redownload-models", action="store_true",
        help="replace cached model files before startup",
    )
    parser.add_argument(
        "--download-models-only", action="store_true",
        help="download/validate model files, then exit without opening the webcam",
    )
    parser.add_argument("--fullscreen", action="store_true", help="start in fullscreen mode")
    parser.add_argument("--hide-hands", action="store_true", help="start with hand overlay hidden")
    parser.add_argument("--no-reactions", action="store_true", help="start with gesture reactions disabled")
    parser.add_argument("--verbose", action="store_true", help="show a traceback if startup fails")
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_arguments(argv)
    try:
        cv2.setUseOptimized(True)
        if hasattr(cv2, "setNumThreads"):
            # MediaPipe already owns worker pools. Extra OpenCV workers contend
            # with them on lower-end CPUs and increase end-to-end latency.
            cv2.setNumThreads(1)

        model_paths = ensure_models(args.model_dir.resolve(), args.pose_model, args.redownload_models)
        if args.download_models_only:
            print("All required model bundles are ready:")
            for role, path in model_paths.items():
                print(f"  {role:>4}: {path}")
            return 0

        print(f"{APP_NAME} | OpenCV {cv2.__version__} | MediaPipe {getattr(mp, '__version__', '?')}")
        print(
            f"Configuration: up to {args.max_people} people, {args.pose_model} pose model, "
            f"{args.inference_width}px analysis width"
        )
        return HumanTrackingApplication(args, model_paths).run()
    except KeyboardInterrupt:
        print("\nInterrupted; closing the webcam.")
        return 130
    except Exception as exc:
        print(f"\n{APP_NAME} could not continue:\n  {exc}", file=sys.stderr)
        if args.verbose:
            traceback.print_exc()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
