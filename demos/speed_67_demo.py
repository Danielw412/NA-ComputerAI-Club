#!/usr/bin/env python3
"""One- or two-player webcam game for counting fast "67" arm motions.

The low-latency MediaPipe setup, camera handling, skeleton, colors, and
outlined text follow demos/human_tracking_demo.py, while this file remains a
small, pose-only fair demo.

Run:
    python demos/speed_67_demo.py

Keyboard:
    Space/S start or play again, R restart, 1/2 select player mode,
    F fullscreen, Q/Esc quit.
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
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional, Sequence


os.environ.setdefault("GLOG_minloglevel", "2")
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

DEPENDENCY_HINT = (
    f'"{sys.executable}" -m pip install numpy opencv-contrib-python mediapipe'
)

try:
    import cv2
    import mediapipe as mp
    import numpy as np
except (ImportError, ModuleNotFoundError) as exc:
    print("\n67 Speed could not start: a dependency is missing.", file=sys.stderr)
    print(f"Missing import: {exc}", file=sys.stderr)
    print(f"Install the required packages with:\n  {DEPENDENCY_HINT}\n", file=sys.stderr)
    raise SystemExit(2) from exc


APP_NAME = "67 Speed"
WINDOW_NAME = "67 Speed - Webcam Game"

# ---------------------------------------------------------------------------
# Fair-day tuning controls
# ---------------------------------------------------------------------------

DEFAULT_ROUND_SECONDS = 15.0
DEFAULT_COUNTDOWN_SECONDS = 3.0
DEFAULT_CAMERA_FPS = 60.0
DEFAULT_TRACKING_FPS = 60.0

# Lower these slightly if wrists disappear during very fast movement.
WRIST_VISIBILITY_THRESHOLD = 0.36
WRIST_PRESENCE_THRESHOLD = 0.42
BODY_CONFIDENCE_THRESHOLD = 0.36

# Distances are normalized by shoulder-to-hip torso length, making scoring
# similar when a player stands somewhat closer to or farther from the camera.
OPPOSITE_HAND_GAP_TORSOS = 0.52
MIN_EACH_WRIST_TRAVEL_TORSOS = 0.36

# Endpoint confirmation and lockout reject pose jitter and threshold bouncing
# without making quick, intentional motion feel sluggish.
ENDPOINT_HOLD_SECONDS = 0.025
ENDPOINT_MIN_SAMPLES = 2
MIN_TRANSITION_SECONDS = 0.075
COUNT_COOLDOWN_SECONDS = 0.14

# Never complete a transition across a meaningful tracking failure.
WRIST_TRACKING_GRACE_SECONDS = 0.34
PLAYER_TRACK_TTL_SECONDS = 1.05
POSE_DISPLAY_TTL_SECONDS = 0.85

# Person association uses the shoulder/hip center rather than moving wrists.
MAX_PERSON_ASSIGNMENT_DISTANCE = 0.34

MODEL_URLS = {
    "lite": (
        "pose_landmarker_lite.task",
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
        "pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
    ),
    "full": (
        "pose_landmarker_full.task",
        "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
        "pose_landmarker_full/float16/1/pose_landmarker_full.task",
    ),
}

# Projector-friendly BGR colors and pose geometry from the reference demo.
PERSON_COLORS = [
    (255, 229, 0),    # screen-left / one-player cyan
    (141, 77, 255),  # screen-right rose
]

POSE_CONNECTIONS = [
    (11, 12),
    (11, 13), (13, 15),
    (12, 14), (14, 16),
    (11, 23), (12, 24), (23, 24),
    (23, 25), (25, 27), (27, 29), (29, 31), (27, 31),
    (24, 26), (26, 28), (28, 30), (30, 32), (28, 32),
]
POSE_MAJOR_JOINTS = [
    0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
]
POSE_ANCHOR_JOINTS = (11, 12, 23, 24)


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def color_scale(color: tuple[int, int, int], factor: float) -> tuple[int, int, int]:
    return tuple(int(clamp(channel * factor, 0, 255)) for channel in color)


def normalized_to_pixel(point: Sequence[float], width: int, height: int) -> tuple[int, int]:
    return int(point[0] * width), int(point[1] * height)


def landmark_value(landmark: Any, name: str, default: float) -> float:
    value = getattr(landmark, name, default)
    return default if value is None else float(value)


def landmarks_to_array(landmarks: Sequence[Any]) -> np.ndarray:
    output = np.empty((len(landmarks), 5), dtype=np.float32)
    for index, landmark in enumerate(landmarks):
        output[index, 0] = landmark_value(landmark, "x", 0.0)
        output[index, 1] = landmark_value(landmark, "y", 0.0)
        output[index, 2] = landmark_value(landmark, "z", 0.0)
        output[index, 3] = landmark_value(landmark, "visibility", 1.0)
        output[index, 4] = landmark_value(landmark, "presence", 1.0)
    return output


def alpha_for_age(age: float, solid_for: float, disappear_at: float) -> float:
    if age <= solid_for:
        return 1.0
    if age >= disappear_at:
        return 0.0
    return 1.0 - (age - solid_for) / max(1e-6, disappear_at - solid_for)


class OneEuroFilter:
    """Adaptive smoothing: stable at rest, responsive during fast motion."""

    def __init__(self, min_cutoff: float = 3.2, beta: float = 0.46, d_cutoff: float = 1.0):
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


class LatestPoseResult:
    """Thread-safe mailbox retaining only the newest asynchronous result."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sequence = 0
        self._timestamp_ms = -1
        self._poses: list[np.ndarray] = []

    def publish(self, timestamp_ms: int, poses: list[np.ndarray]) -> None:
        with self._lock:
            if timestamp_ms < self._timestamp_ms:
                return
            self._sequence += 1
            self._timestamp_ms = timestamp_ms
            self._poses = poses

    def get_after(self, sequence: int) -> Optional[tuple[int, int, list[np.ndarray]]]:
        with self._lock:
            if self._sequence <= sequence:
                return None
            return self._sequence, self._timestamp_ms, self._poses


@dataclass
class PoseObservation:
    landmarks: np.ndarray
    anchor: np.ndarray
    torso_scale: float
    quality: float


def make_pose_observation(landmarks: np.ndarray) -> Optional[PoseObservation]:
    if len(landmarks) < 33:
        return None

    confidence = np.minimum(landmarks[:, 3], landmarks[:, 4])
    valid = (
        (confidence > BODY_CONFIDENCE_THRESHOLD)
        & (landmarks[:, 0] > -0.15)
        & (landmarks[:, 0] < 1.15)
        & (landmarks[:, 1] > -0.15)
        & (landmarks[:, 1] < 1.15)
    )
    if np.count_nonzero(valid) < 4:
        return None

    usable_anchors = [index for index in POSE_ANCHOR_JOINTS if valid[index]]
    if len(usable_anchors) >= 2:
        anchor = np.mean(landmarks[usable_anchors, :2], axis=0)
    else:
        usable_major = [index for index in POSE_MAJOR_JOINTS if valid[index]]
        anchor = np.mean(landmarks[usable_major, :2], axis=0)

    shoulders_ready = bool(valid[11] and valid[12])
    hips_ready = bool(valid[23] and valid[24])
    shoulder_width = 0.0
    if shoulders_ready:
        shoulder_center = (landmarks[11, :2] + landmarks[12, :2]) * 0.5
        shoulder_width = float(np.linalg.norm(landmarks[11, :2] - landmarks[12, :2]))
    if hips_ready:
        hip_center = (landmarks[23, :2] + landmarks[24, :2]) * 0.5

    if shoulders_ready and hips_ready:
        torso_scale = float(np.linalg.norm(shoulder_center - hip_center))
    else:
        body_height = float(np.ptp(landmarks[valid, 1]))
        torso_scale = max(body_height * 0.30, shoulder_width * 1.15)

    torso_scale = clamp(torso_scale, 0.045, 0.55)
    major_confidence = confidence[[index for index in POSE_MAJOR_JOINTS if valid[index]]]
    quality = float(np.mean(major_confidence)) if len(major_confidence) else 0.0
    return PoseObservation(
        landmarks,
        np.asarray(anchor, dtype=np.float32),
        torso_scale,
        quality,
    )


def deduplicate_observations(observations: Sequence[PoseObservation]) -> list[PoseObservation]:
    kept: list[PoseObservation] = []
    for observation in sorted(observations, key=lambda item: item.quality, reverse=True):
        duplicate = False
        for existing in kept:
            anchor_distance = float(np.linalg.norm(observation.anchor - existing.anchor))
            if anchor_distance > 0.13:
                continue
            shared = [
                index for index in (0, 11, 12, 13, 14, 23, 24)
                if (
                    min(observation.landmarks[index, 3], observation.landmarks[index, 4])
                    > BODY_CONFIDENCE_THRESHOLD
                    and min(existing.landmarks[index, 3], existing.landmarks[index, 4])
                    > BODY_CONFIDENCE_THRESHOLD
                )
            ]
            if len(shared) >= 3:
                mean_distance = float(np.mean(np.linalg.norm(
                    observation.landmarks[shared, :2] - existing.landmarks[shared, :2],
                    axis=1,
                )))
                duplicate = mean_distance < 0.055
            else:
                duplicate = anchor_distance < 0.055
            if duplicate:
                break
        if not duplicate:
            kept.append(observation)
    return kept[:2]


class SixtySevenMotionDetector:
    """Debounced two-endpoint state machine for complete 67 transitions."""

    def __init__(self) -> None:
        self.count = 0
        self.last_valid_sample = -math.inf
        self.last_count_time = -math.inf
        self.accepted_state = 0
        self.accepted_left_y = 0.0
        self.accepted_right_y = 0.0
        self.accepted_scale = 0.1
        self.accepted_time = -math.inf
        self.candidate_state = 0
        self.candidate_since = -math.inf
        self.candidate_samples = 0

    def reset_motion(self) -> None:
        self.last_valid_sample = -math.inf
        self.last_count_time = -math.inf
        self.accepted_state = 0
        self.accepted_left_y = 0.0
        self.accepted_right_y = 0.0
        self.accepted_scale = 0.1
        self.accepted_time = -math.inf
        self.candidate_state = 0
        self.candidate_since = -math.inf
        self.candidate_samples = 0

    def reset_round(self) -> None:
        self.count = 0
        self.reset_motion()

    def mark_missing(self, timestamp: float) -> None:
        if timestamp - self.last_valid_sample > WRIST_TRACKING_GRACE_SECONDS:
            self.reset_motion()

    def _accept_endpoint(
        self,
        state: int,
        left_y: float,
        right_y: float,
        scale: float,
        timestamp: float,
    ) -> None:
        self.accepted_state = state
        self.accepted_left_y = left_y
        self.accepted_right_y = right_y
        self.accepted_scale = scale
        self.accepted_time = timestamp

    def observe(
        self,
        left_y: float,
        right_y: float,
        torso_scale: float,
        timestamp: float,
        counting_enabled: bool,
    ) -> bool:
        if timestamp - self.last_valid_sample > WRIST_TRACKING_GRACE_SECONDS:
            self.reset_motion()
        self.last_valid_sample = timestamp

        signed_gap = (right_y - left_y) / max(0.025, torso_scale)
        if signed_gap >= OPPOSITE_HAND_GAP_TORSOS:
            state = 1   # left wrist up, right wrist down
        elif signed_gap <= -OPPOSITE_HAND_GAP_TORSOS:
            state = -1  # left wrist down, right wrist up
        else:
            state = 0

        if state == 0:
            self.candidate_state = 0
            self.candidate_since = -math.inf
            self.candidate_samples = 0
            return False

        if state != self.candidate_state:
            self.candidate_state = state
            self.candidate_since = timestamp
            self.candidate_samples = 1
            return False

        self.candidate_samples += 1
        stable = (
            self.candidate_samples >= ENDPOINT_MIN_SAMPLES
            and timestamp - self.candidate_since >= ENDPOINT_HOLD_SECONDS
        )
        if not stable:
            return False

        if self.accepted_state == 0:
            self._accept_endpoint(state, left_y, right_y, torso_scale, timestamp)
            return False

        if state == self.accepted_state:
            blend = 0.18
            self.accepted_left_y += blend * (left_y - self.accepted_left_y)
            self.accepted_right_y += blend * (right_y - self.accepted_right_y)
            self.accepted_scale += blend * (torso_scale - self.accepted_scale)
            self.accepted_time = timestamp
            return False

        comparison_scale = max(0.025, 0.5 * (torso_scale + self.accepted_scale))
        if self.accepted_state == 1:
            left_travel = (left_y - self.accepted_left_y) / comparison_scale
            right_travel = (self.accepted_right_y - right_y) / comparison_scale
        else:
            left_travel = (self.accepted_left_y - left_y) / comparison_scale
            right_travel = (right_y - self.accepted_right_y) / comparison_scale

        both_wrists_switched = (
            left_travel >= MIN_EACH_WRIST_TRAVEL_TORSOS
            and right_travel >= MIN_EACH_WRIST_TRAVEL_TORSOS
        )
        timing_is_valid = (
            timestamp - self.accepted_time >= MIN_TRANSITION_SECONDS
            and timestamp - self.last_count_time >= COUNT_COOLDOWN_SECONDS
        )
        if not both_wrists_switched or not timing_is_valid:
            # Keep the old endpoint after a partial move. If the second wrist
            # catches up, a later stable sample can still complete the motion.
            return False

        counted = False
        if counting_enabled:
            self.count += 1
            self.last_count_time = timestamp
            counted = True
        self._accept_endpoint(state, left_y, right_y, torso_scale, timestamp)
        return counted


class PlayerTrack:
    def __init__(self, slot: int) -> None:
        self.slot = slot
        self.color = PERSON_COLORS[slot]
        self.pose: Optional[np.ndarray] = None
        initial_x = 0.5 if slot == 0 else 0.75
        self.anchor = np.array((initial_x, 0.5), dtype=np.float32)
        self.anchor_velocity = np.zeros(2, dtype=np.float32)
        self.torso_scale = 0.16
        self.last_seen = -math.inf
        self.pose_smoother = OneEuroFilter(3.4, 0.52)
        self.motion = SixtySevenMotionDetector()

    def predicted_anchor(self, timestamp: float) -> np.ndarray:
        horizon = clamp(timestamp - self.last_seen, 0.0, 0.32)
        return np.clip(self.anchor + self.anchor_velocity * horizon, 0.0, 1.0)

    def reset_round(self) -> None:
        self.motion.reset_round()

    def begin_active_round(self) -> None:
        # First clear endpoint after GO arms the detector. A countdown movement
        # cannot spill over into the active score.
        self.motion.reset_motion()

    def update(
        self,
        observation: PoseObservation,
        timestamp: float,
        counting_enabled: bool,
    ) -> None:
        was_stale = timestamp - self.last_seen > PLAYER_TRACK_TTL_SECONDS
        if was_stale:
            self.pose_smoother.reset()
            self.motion.reset_motion()
            self.anchor_velocity.fill(0.0)
        elif math.isfinite(self.last_seen):
            dt = clamp(timestamp - self.last_seen, 1.0 / 120.0, 0.4)
            measured = (observation.anchor - self.anchor) / dt
            speed = float(np.linalg.norm(measured))
            if speed > 1.5:
                measured *= 1.5 / speed
            self.anchor_velocity = 0.72 * self.anchor_velocity + 0.28 * measured

        filtered_coordinates = self.pose_smoother(observation.landmarks[:, :3], timestamp)
        self.pose = observation.landmarks.copy()
        self.pose[:, :3] = filtered_coordinates
        self.anchor = observation.anchor.astype(np.float32)
        if was_stale:
            self.torso_scale = observation.torso_scale
        else:
            self.torso_scale += 0.28 * (observation.torso_scale - self.torso_scale)
        self.last_seen = timestamp

        left_wrist = self.pose[15]
        right_wrist = self.pose[16]
        wrists_are_reliable = (
            left_wrist[3] >= WRIST_VISIBILITY_THRESHOLD
            and right_wrist[3] >= WRIST_VISIBILITY_THRESHOLD
            and left_wrist[4] >= WRIST_PRESENCE_THRESHOLD
            and right_wrist[4] >= WRIST_PRESENCE_THRESHOLD
        )
        if wrists_are_reliable:
            self.motion.observe(
                float(left_wrist[1]),
                float(right_wrist[1]),
                self.torso_scale,
                timestamp,
                counting_enabled,
            )
        else:
            self.motion.mark_missing(timestamp)

    def tick(self, now: float) -> None:
        if now - self.last_seen > WRIST_TRACKING_GRACE_SECONDS:
            self.motion.mark_missing(now)


class PlayerPoseTracker:
    """Maintains stable screen-left/screen-right score identities."""

    def __init__(self, player_count: int) -> None:
        self.player_count = player_count
        self.players = [PlayerTrack(index) for index in range(player_count)]
        if player_count == 2:
            self.players[0].anchor[0] = 0.25

    def reset_round(self) -> None:
        for player in self.players:
            player.reset_round()

    def begin_active_round(self) -> None:
        for player in self.players:
            player.begin_active_round()

    def _update_one_player(
        self,
        observations: Sequence[PoseObservation],
        timestamp: float,
        counting_enabled: bool,
    ) -> None:
        if not observations:
            return
        player = self.players[0]
        if timestamp - player.last_seen <= PLAYER_TRACK_TTL_SECONDS:
            observation = min(
                observations,
                key=lambda item: float(np.linalg.norm(
                    item.anchor - player.predicted_anchor(timestamp)
                )),
            )
        else:
            observation = max(
                observations,
                key=lambda item: item.quality - 0.35 * abs(float(item.anchor[0]) - 0.5),
            )
        player.update(observation, timestamp, counting_enabled)

    def _update_two_players(
        self,
        observations: Sequence[PoseObservation],
        timestamp: float,
        counting_enabled: bool,
    ) -> None:
        assignments: dict[int, int] = {}
        candidates: list[tuple[float, int, int]] = []
        for slot, player in enumerate(self.players):
            if timestamp - player.last_seen > PLAYER_TRACK_TTL_SECONDS:
                continue
            predicted = player.predicted_anchor(timestamp)
            for observation_index, observation in enumerate(observations):
                distance = float(np.linalg.norm(observation.anchor - predicted))
                gate = MAX_PERSON_ASSIGNMENT_DISTANCE + 0.25 * max(
                    observation.torso_scale, player.torso_scale
                )
                if distance <= gate:
                    candidates.append((distance, slot, observation_index))

        used_slots: set[int] = set()
        used_observations: set[int] = set()
        for _, slot, observation_index in sorted(candidates):
            if slot in used_slots or observation_index in used_observations:
                continue
            assignments[slot] = observation_index
            used_slots.add(slot)
            used_observations.add(observation_index)

        stale_slots = [
            slot for slot, player in enumerate(self.players)
            if slot not in used_slots
            and timestamp - player.last_seen > PLAYER_TRACK_TTL_SECONDS
        ]
        remaining = [
            index for index in range(len(observations))
            if index not in used_observations
        ]

        if len(stale_slots) == 2 and len(remaining) >= 2:
            ordered = sorted(remaining, key=lambda index: float(observations[index].anchor[0]))
            assignments[0] = ordered[0]
            assignments[1] = ordered[-1]
        elif remaining and stale_slots:
            if len(stale_slots) == 2:
                observation_index = remaining[0]
                x = float(observations[observation_index].anchor[0])
                assignments[0 if x < 0.5 else 1] = observation_index
            else:
                slot = stale_slots[0]
                observation_index = min(
                    remaining,
                    key=lambda index: (
                        float(observations[index].anchor[0])
                        if slot == 0
                        else -float(observations[index].anchor[0])
                    ),
                )
                assignments[slot] = observation_index

        for slot, observation_index in assignments.items():
            self.players[slot].update(
                observations[observation_index], timestamp, counting_enabled
            )

    def update(
        self,
        pose_arrays: Sequence[np.ndarray],
        timestamp: float,
        counting_enabled: bool,
    ) -> None:
        observations = deduplicate_observations([
            observation
            for pose_array in pose_arrays
            if (observation := make_pose_observation(pose_array)) is not None
        ])
        if self.player_count == 1:
            self._update_one_player(observations, timestamp, counting_enabled)
        else:
            self._update_two_players(observations, timestamp, counting_enabled)

    def tick(self, now: float) -> None:
        for player in self.players:
            player.tick(now)


class PoseInference:
    """Asynchronous pose-only MediaPipe pipeline optimized for low latency."""

    def __init__(self, model_path: Path, tracking_fps: float) -> None:
        if not hasattr(mp, "tasks") or not hasattr(mp.tasks, "vision"):
            raise RuntimeError(
                "This MediaPipe build does not contain the Tasks vision API. "
                f"Upgrade it with: {DEPENDENCY_HINT}"
            )

        self.results = LatestPoseResult()
        self.pose_interval = 1.0 / max(1.0, tracking_fps)
        self.next_submission = 0.0
        self._recent_images: deque[Any] = deque(maxlen=10)
        self._errors: deque[str] = deque(maxlen=6)
        self._error_lock = threading.Lock()
        self._closed = False

        vision = mp.tasks.vision
        try:
            self.pose_task = vision.PoseLandmarker.create_from_options(
                vision.PoseLandmarkerOptions(
                    base_options=mp.tasks.BaseOptions(model_asset_path=str(model_path)),
                    running_mode=vision.RunningMode.LIVE_STREAM,
                    num_poses=2,
                    min_pose_detection_confidence=0.38,
                    min_pose_presence_confidence=0.37,
                    min_tracking_confidence=0.45,
                    output_segmentation_masks=False,
                    result_callback=self._callback,
                )
            )
        except Exception as exc:
            raise RuntimeError(
                "MediaPipe could not initialize the pose model. The cache may be "
                "incomplete; retry with --redownload-model. "
                f"Original error: {exc}"
            ) from exc

    def _record_error(self, exc: BaseException) -> None:
        message = f"Pose inference warning: {type(exc).__name__}: {exc}"
        with self._error_lock:
            if not self._errors or self._errors[-1] != message:
                self._errors.append(message)

    def pop_error(self) -> Optional[str]:
        with self._error_lock:
            return self._errors.popleft() if self._errors else None

    def _callback(self, result: Any, _image: Any, timestamp_ms: int) -> None:
        try:
            poses = [
                landmarks_to_array(landmarks)
                for landmarks in (getattr(result, "pose_landmarks", None) or [])
            ]
            self.results.publish(timestamp_ms, poses)
        except Exception as exc:
            self._record_error(exc)

    def submit(
        self,
        bgr_image: np.ndarray,
        timestamp_ms: int,
        now: float,
        inference_width: int,
    ) -> None:
        if self._closed or now < self.next_submission:
            return
        self.next_submission = now + self.pose_interval

        analysis_width = min(inference_width, bgr_image.shape[1])
        if analysis_width < bgr_image.shape[1]:
            analysis_height = max(
                2, int(bgr_image.shape[0] * analysis_width / bgr_image.shape[1])
            )
            analysis_height -= analysis_height % 2
            analysis_frame = cv2.resize(
                bgr_image,
                (analysis_width, analysis_height),
                interpolation=cv2.INTER_AREA,
            )
        else:
            analysis_frame = bgr_image

        try:
            rgb = np.ascontiguousarray(cv2.cvtColor(analysis_frame, cv2.COLOR_BGR2RGB))
            image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            self.pose_task.detect_async(image, timestamp_ms)
            self._recent_images.append(image)
        except Exception as exc:
            self._record_error(exc)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self.pose_task.close()
        except Exception as exc:
            self._record_error(exc)
        self._recent_images.clear()


class GameClock:
    WAITING = "waiting"
    COUNTDOWN = "countdown"
    ACTIVE = "active"
    FINISHED = "finished"

    def __init__(self, round_seconds: float, countdown_seconds: float) -> None:
        self.round_seconds = round_seconds
        self.countdown_seconds = countdown_seconds
        self.phase = self.WAITING
        self.phase_started = time.perf_counter()
        self.round_ends = math.inf

    def wait(self, now: float) -> None:
        self.phase = self.WAITING
        self.phase_started = now
        self.round_ends = math.inf

    def start(self, now: float) -> None:
        self.phase = self.COUNTDOWN
        self.phase_started = now
        self.round_ends = math.inf

    def update(self, now: float) -> Optional[str]:
        if (
            self.phase == self.COUNTDOWN
            and now - self.phase_started >= self.countdown_seconds
        ):
            self.phase = self.ACTIVE
            self.phase_started = now
            self.round_ends = now + self.round_seconds
            return self.ACTIVE
        if self.phase == self.ACTIVE and now >= self.round_ends:
            self.phase = self.FINISHED
            self.phase_started = now
            return self.FINISHED
        return None

    def time_remaining(self, now: float) -> float:
        if self.phase == self.ACTIVE:
            return max(0.0, self.round_ends - now)
        if self.phase == self.FINISHED:
            return 0.0
        return self.round_seconds

    def countdown_number(self, now: float) -> int:
        remaining = self.countdown_seconds - (now - self.phase_started)
        return max(1, int(math.ceil(remaining)))


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
    request = urllib.request.Request(url, headers={"User-Agent": "67SpeedDemo/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=45) as response, temporary.open("wb") as output:
            while True:
                chunk = response.read(1024 * 256)
                if not chunk:
                    break
                output.write(chunk)
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


def ensure_pose_model(model_directory: Path, pose_model: str, redownload: bool) -> Path:
    model_directory.mkdir(parents=True, exist_ok=True)
    filename, url = MODEL_URLS[pose_model]
    path = model_directory / filename
    if redownload and path.exists():
        path.unlink()
    if not path.exists() or path.stat().st_size < 512_000:
        print(f"First-time model setup in: {model_directory}")
        download_file(url, path)
        print("  Model setup complete.\n")
    return path


def draw_outlined_text(
    frame: np.ndarray,
    text: str,
    position: tuple[int, int],
    font_scale: float,
    color: tuple[int, int, int],
    thickness: int = 1,
) -> None:
    cv2.putText(
        frame,
        text,
        (position[0] + 1, position[1] + 1),
        cv2.FONT_HERSHEY_SIMPLEX,
        font_scale,
        (10, 12, 16),
        thickness + 3,
        cv2.LINE_AA,
    )
    cv2.putText(
        frame,
        text,
        position,
        cv2.FONT_HERSHEY_SIMPLEX,
        font_scale,
        color,
        thickness,
        cv2.LINE_AA,
    )


def draw_centered_text(
    frame: np.ndarray,
    text: str,
    center_x: int,
    baseline_y: int,
    font_scale: float,
    color: tuple[int, int, int],
    thickness: int,
) -> None:
    (text_width, _), _ = cv2.getTextSize(
        text, cv2.FONT_HERSHEY_SIMPLEX, font_scale, thickness
    )
    draw_outlined_text(
        frame,
        text,
        (center_x - text_width // 2, baseline_y),
        font_scale,
        color,
        thickness,
    )


def draw_pose_overlays(frame: np.ndarray, players: Sequence[PlayerTrack], now: float) -> None:
    height, width = frame.shape[:2]
    scale = clamp(height / 720.0, 0.70, 1.60)
    overlay = frame.copy()
    shadow = (5, 9, 15)

    for player in players:
        if player.pose is None:
            continue
        opacity = alpha_for_age(
            now - player.last_seen, 0.20, POSE_DISPLAY_TTL_SECONDS
        )
        if opacity <= 0.0:
            continue
        pose = player.pose
        color = color_scale(player.color, 0.20 + 0.80 * opacity)
        line_width = max(2, round(3 * scale))
        for start, end in POSE_CONNECTIONS:
            if (
                pose[start, 3] < 0.46
                or pose[end, 3] < 0.46
                or pose[start, 4] < 0.40
                or pose[end, 4] < 0.40
            ):
                continue
            first = normalized_to_pixel(pose[start], width, height)
            second = normalized_to_pixel(pose[end], width, height)
            cv2.line(overlay, first, second, shadow, line_width + 4, cv2.LINE_AA)
            cv2.line(overlay, first, second, color, line_width, cv2.LINE_AA)

        for index in POSE_MAJOR_JOINTS:
            point = pose[index]
            if point[3] < 0.48 or point[4] < 0.42:
                continue
            center = normalized_to_pixel(point, width, height)
            radius = max(3, round((5 if index in POSE_ANCHOR_JOINTS else 4) * scale))
            cv2.circle(overlay, center, radius + 2, shadow, -1, cv2.LINE_AA)
            cv2.circle(overlay, center, radius, color, -1, cv2.LINE_AA)
            cv2.circle(
                overlay, center, max(1, radius // 3), (245, 250, 252), -1, cv2.LINE_AA
            )

    cv2.addWeighted(overlay, 0.86, frame, 0.14, 0.0, frame)


def winner_text(players: Sequence[PlayerTrack]) -> str:
    if len(players) < 2:
        return f"FINAL: {players[0].motion.count}"
    left = players[0].motion.count
    right = players[1].motion.count
    if left > right:
        return "LEFT PLAYER WINS"
    if right > left:
        return "RIGHT PLAYER WINS"
    return "TIE GAME"


def draw_game_ui(
    frame: np.ndarray,
    game: GameClock,
    tracker: PlayerPoseTracker,
    now: float,
    warning: Optional[str],
) -> None:
    height, width = frame.shape[:2]
    scale = clamp(height / 720.0, 0.70, 1.60)
    header_height = round(158 * scale)
    layer = frame.copy()
    cv2.rectangle(layer, (0, 0), (width, header_height), (7, 12, 20), -1)
    cv2.addWeighted(layer, 0.64, frame, 0.36, 0.0, frame)

    draw_centered_text(
        frame,
        f"{game.time_remaining(now):04.1f}",
        width // 2,
        round(48 * scale),
        1.25 * scale,
        (246, 248, 252),
        max(2, round(2 * scale)),
    )

    if tracker.player_count == 1:
        player = tracker.players[0]
        draw_centered_text(
            frame,
            str(player.motion.count),
            width // 2,
            round(132 * scale),
            2.75 * scale,
            player.color,
            max(3, round(3 * scale)),
        )
        draw_centered_text(
            frame,
            "67 COUNT",
            width // 2,
            round(154 * scale),
            0.36 * scale,
            (225, 232, 240),
            max(1, round(scale)),
        )
    else:
        for player, center_x, label in (
            (tracker.players[0], width // 5, "LEFT  67s"),
            (tracker.players[1], width * 4 // 5, "RIGHT  67s"),
        ):
            draw_centered_text(
                frame,
                str(player.motion.count),
                center_x,
                round(112 * scale),
                2.25 * scale,
                player.color,
                max(3, round(3 * scale)),
            )
            draw_centered_text(
                frame,
                label,
                center_x,
                round(148 * scale),
                0.38 * scale,
                player.color,
                max(1, round(scale)),
            )

    message_y = round(height * 0.72)
    if game.phase == GameClock.WAITING:
        mode_text = f"{tracker.player_count} PLAYER"
        if tracker.player_count == 2:
            mode_text += "S"
        draw_centered_text(
            frame,
            mode_text,
            width // 2,
            message_y - round(36 * scale),
            0.70 * scale,
            (246, 248, 252),
            max(2, round(2 * scale)),
        )
        draw_centered_text(
            frame,
            "PRESS SPACE TO START",
            width // 2,
            message_y,
            0.88 * scale,
            (246, 248, 252),
            max(2, round(2 * scale)),
        )
    elif game.phase == GameClock.COUNTDOWN:
        draw_centered_text(
            frame,
            str(game.countdown_number(now)),
            width // 2,
            round(height * 0.66),
            4.6 * scale,
            (255, 244, 92),
            max(4, round(5 * scale)),
        )
    elif game.phase == GameClock.FINISHED:
        draw_centered_text(
            frame,
            winner_text(tracker.players),
            width // 2,
            message_y - round(28 * scale),
            0.98 * scale,
            (255, 244, 92),
            max(2, round(2 * scale)),
        )
        draw_centered_text(
            frame,
            "SPACE TO PLAY AGAIN",
            width // 2,
            message_y + round(18 * scale),
            0.55 * scale,
            (238, 242, 248),
            max(1, round(scale)),
        )

    draw_centered_text(
        frame,
        "SPACE START   R RESTART   1/2 MODE   F FULLSCREEN   Q QUIT",
        width // 2,
        height - round(14 * scale),
        0.32 * scale,
        (218, 225, 234),
        max(1, round(scale)),
    )

    if warning:
        draw_centered_text(
            frame,
            warning,
            width // 2,
            header_height + round(28 * scale),
            0.37 * scale,
            (120, 190, 255),
            max(1, round(scale)),
        )


def draw_camera_warning(frame: np.ndarray, elapsed: float) -> None:
    dimmed = np.zeros_like(frame)
    cv2.addWeighted(frame, 0.32, dimmed, 0.68, 0.0, frame)
    height, width = frame.shape[:2]
    scale = clamp(height / 720.0, 0.70, 1.60)
    draw_centered_text(
        frame,
        "CAMERA SIGNAL LOST - RETRYING",
        width // 2,
        height // 2,
        0.72 * scale,
        (120, 190, 255),
        max(2, round(2 * scale)),
    )
    dots = "." * (1 + int(elapsed * 2) % 3)
    draw_centered_text(
        frame,
        f"Checking webcam connection{dots}",
        width // 2,
        height // 2 + round(34 * scale),
        0.38 * scale,
        (195, 205, 220),
        max(1, round(scale)),
    )


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


class SixtySevenApplication:
    def __init__(self, args: argparse.Namespace, model_path: Path) -> None:
        self.args = args
        self.model_path = model_path
        self.game = GameClock(args.round_seconds, args.countdown_seconds)
        self.tracker = PlayerPoseTracker(args.mode)
        self.fullscreen = bool(args.fullscreen)
        self.result_sequence = 0
        self.clock_origin = 0.0
        self.warning_text: Optional[str] = None
        self.warning_until = 0.0

    def _set_fullscreen(self) -> None:
        try:
            mode = cv2.WINDOW_FULLSCREEN if self.fullscreen else cv2.WINDOW_NORMAL
            cv2.setWindowProperty(WINDOW_NAME, cv2.WND_PROP_FULLSCREEN, mode)
        except cv2.error as exc:
            self.warning_text = f"Fullscreen control unavailable: {exc}"
            self.warning_until = time.perf_counter() + 3.0

    def _set_player_count(self, count: int, now: float) -> None:
        self.tracker = PlayerPoseTracker(count)
        self.game.wait(now)

    def _start_round(self, now: float) -> None:
        self.tracker.reset_round()
        self.game.start(now)

    def handle_key(self, key: int, now: float) -> bool:
        if key < 0:
            return False
        key &= 0xFF
        if key in (27, ord("q"), ord("Q")):
            return True
        if key in (ord("1"), ord("2")):
            self._set_player_count(int(chr(key)), now)
        elif key in (ord(" "), ord("s"), ord("S"), ord("r"), ord("R")):
            self._start_round(now)
        elif key in (ord("f"), ord("F")):
            self.fullscreen = not self.fullscreen
            self._set_fullscreen()
        return False

    @staticmethod
    def window_was_closed() -> bool:
        try:
            return cv2.getWindowProperty(WINDOW_NAME, cv2.WND_PROP_VISIBLE) < 1.0
        except cv2.error:
            return False

    def _advance_game(self, now: float) -> None:
        transition = self.game.update(now)
        if transition == GameClock.ACTIVE:
            self.tracker.begin_active_round()

    def _process_inference_result(self, inference: PoseInference, now: float) -> None:
        item = inference.results.get_after(self.result_sequence)
        if item is None:
            return
        sequence, timestamp_ms, pose_arrays = item
        self.result_sequence = sequence
        sample_time = self.clock_origin + timestamp_ms / 1000.0
        counting_enabled = (
            self.game.phase == GameClock.ACTIVE
            and now < self.game.round_ends
            and sample_time < self.game.round_ends
        )
        self.tracker.update(pose_arrays, sample_time, counting_enabled)

    def run(self) -> int:
        capture: Any = None
        inference: Optional[PoseInference] = None
        exit_code = 0
        try:
            print(f"Opening webcam {self.args.camera} ...")
            capture, pending_frame, backend_name = open_camera(
                self.args.camera,
                self.args.width,
                self.args.height,
                self.args.camera_fps,
            )
            actual_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
            actual_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
            actual_fps = capture.get(cv2.CAP_PROP_FPS)
            print(
                f"  Camera ready: {actual_width}x{actual_height} @ "
                f"{actual_fps:.1f} FPS ({backend_name})"
            )
            print("Loading MediaPipe pose tracking ...")
            inference = PoseInference(self.model_path, self.args.tracking_fps)
            print("  Tracking active. Press Space to start; Q or Esc to quit.\n")

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
            last_timestamp_ms = -1
            last_good_frame: Optional[np.ndarray] = None
            failure_started: Optional[float] = None

            while True:
                now = time.perf_counter()
                self._advance_game(now)
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
                    self.tracker.tick(now)
                    draw_camera_warning(canvas, elapsed)
                    draw_game_ui(canvas, self.game, self.tracker, now, None)
                    cv2.imshow(WINDOW_NAME, canvas)
                    if self.handle_key(cv2.waitKey(30), now) or self.window_was_closed():
                        break
                    if elapsed > 6.0:
                        print(
                            "Webcam stopped returning frames for more than six seconds.",
                            file=sys.stderr,
                        )
                        exit_code = 1
                        break
                    continue

                failure_started = None
                frame = cv2.flip(frame, 1)
                last_good_frame = frame.copy()
                now = time.perf_counter()
                self._advance_game(now)

                timestamp_ms = max(
                    last_timestamp_ms + 1,
                    int((now - self.clock_origin) * 1000.0),
                )
                last_timestamp_ms = timestamp_ms
                inference.submit(frame, timestamp_ms, now, self.args.inference_width)
                self._process_inference_result(inference, now)
                self.tracker.tick(now)

                while True:
                    error = inference.pop_error()
                    if error is None:
                        break
                    print(error, file=sys.stderr)
                    self.warning_text = error
                    self.warning_until = now + 3.0

                draw_pose_overlays(frame, self.tracker.players, now)
                warning = self.warning_text if now < self.warning_until else None
                draw_game_ui(frame, self.game, self.tracker, now, warning)
                cv2.imshow(WINDOW_NAME, frame)

                if self.handle_key(cv2.waitKey(1), now) or self.window_was_closed():
                    break

        finally:
            if capture is not None:
                capture.release()
            if inference is not None:
                inference.close()
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


def positive_float(value: str) -> float:
    parsed = float(value)
    if parsed <= 0.0:
        raise argparse.ArgumentTypeError("must be positive")
    return parsed


def parse_arguments(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "One- or two-player webcam game that counts complete 67 arm-position "
            "switches during a timed round."
        ),
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--camera", type=int, default=0, help="webcam device index")
    parser.add_argument("--width", type=positive_integer, default=960, help="requested camera width")
    parser.add_argument("--height", type=positive_integer, default=540, help="requested camera height")
    parser.add_argument(
        "--camera-fps", type=positive_float, default=DEFAULT_CAMERA_FPS,
        help="requested webcam FPS",
    )
    parser.add_argument(
        "--inference-width", type=positive_integer, default=640,
        help="analysis width; lower values trade detail for speed",
    )
    parser.add_argument(
        "--tracking-fps", type=positive_float, default=DEFAULT_TRACKING_FPS,
        help="maximum pose submissions per second",
    )
    parser.add_argument(
        "--round-seconds", type=positive_float, default=DEFAULT_ROUND_SECONDS,
        help="timed round length",
    )
    parser.add_argument(
        "--countdown-seconds", type=positive_float, default=DEFAULT_COUNTDOWN_SECONDS,
        help="pre-round countdown length",
    )
    parser.add_argument(
        "--mode", type=int, choices=(1, 2), default=1,
        help="initial player count; keyboard 1/2 can change it",
    )
    parser.add_argument(
        "--pose-model", choices=("lite", "full"), default="lite",
        help="lite favors speed; full favors landmark precision",
    )
    parser.add_argument(
        "--model-dir", type=Path, default=default_model_directory(),
        help="directory for the automatically downloaded pose model",
    )
    parser.add_argument(
        "--redownload-model", action="store_true",
        help="replace the cached pose model before startup",
    )
    parser.add_argument(
        "--download-model-only", action="store_true",
        help="download/validate the pose model, then exit without opening the webcam",
    )
    parser.add_argument("--fullscreen", action="store_true", help="start in fullscreen mode")
    parser.add_argument("--verbose", action="store_true", help="show a traceback on startup failure")
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_arguments(argv)
    try:
        cv2.setUseOptimized(True)
        if hasattr(cv2, "setNumThreads"):
            cv2.setNumThreads(1)

        model_path = ensure_pose_model(
            args.model_dir.resolve(), args.pose_model, args.redownload_model
        )
        if args.download_model_only:
            print(f"Pose model ready: {model_path}")
            return 0

        print(
            f"{APP_NAME} | OpenCV {cv2.__version__} | "
            f"MediaPipe {getattr(mp, '__version__', '?')}"
        )
        print(
            f"Configuration: {args.round_seconds:g}s round, {args.pose_model} pose model, "
            f"{args.inference_width}px analysis width"
        )
        return SixtySevenApplication(args, model_path).run()
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
