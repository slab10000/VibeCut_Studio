"""
audio_engine.py — Frame-accurate audio analysis for word boundary refinement.

Strategy
--------
WhisperX tells us *what* was said and gives approximate word times via its
wav2vec2 forced-alignment model (~20-50 ms accuracy). AudioEngine tells us
*exactly when* by doing two things:

1. Stream offset correction — many MP4/MOV files encode AAC audio with
   ~20-50 ms of encoder priming delay. The extracted WAV starts at sample 0
   (including priming silence), but the HTML5 video element and FFmpeg's trim
   filter use the container timeline which accounts for this via the edit list.
   AudioEngine detects this offset via ffprobe and subtracts it from all
   timestamps so they match the video timeline.

2. Silence-gap snapping — for every consecutive pair of aligned words in a
   segment, AudioEngine locates the lowest-energy frame in the silence gap
   between them and places the word boundary there. This ensures every cut
   point lands in natural silence — no audible artifacts when words are removed.
"""

from __future__ import annotations

import json
import subprocess
import uuid
from pathlib import Path
from typing import Any

import numpy as np

# ── Constants ─────────────────────────────────────────────────────────────────

# Energy analysis frame size. 5 ms gives sub-frame accuracy at 30 fps (33 ms).
_FRAME_MS = 5

# dB threshold below which a frame is considered silence.
# Mirrors SILENCE_NOISE_DB in server.py for consistent pause detection.
_SILENCE_DB = -35.0

# Maximum search window (ms) when looking for the lowest-energy cut point.
# Keeps snapping within a reasonable region around each word boundary.
_SNAP_WINDOW_MS = 80

# Minimum word duration after snapping (ms). Prevents words from collapsing
# to zero length if the gap between them is unusually short.
_MIN_WORD_MS = 30

# Maximum plausible audio stream offset (seconds). Values outside [0, MAX]
# are ignored — they likely indicate a non-standard container or probe error.
_OFFSET_MAX_S = 0.5

# Minimum silence duration to report as a pause range (seconds).
_PAUSE_MIN_S = 0.2


class AudioEngine:
    """
    Frame-accurate audio analysis engine.

    Parameters
    ----------
    audio : np.ndarray
        Mono float32 audio array as returned by ``whisperx.load_audio()``.
    sample_rate : int
        Audio sample rate (default 16 000 Hz, matching WhisperX's requirement).
    """

    def __init__(self, audio: np.ndarray, sample_rate: int = 16_000) -> None:
        self.audio = audio.astype(np.float32)
        self.sample_rate = sample_rate
        self._frame_size = max(1, sample_rate * _FRAME_MS // 1000)
        self._energy: np.ndarray | None = None

    # ── Internal helpers ───────────────────────────────────────────────────────

    def _ensure_energy(self) -> None:
        """Lazily compute per-frame RMS energy (single numpy pass)."""
        if self._energy is not None:
            return
        n_frames = len(self.audio) // self._frame_size
        frames = self.audio[: n_frames * self._frame_size].reshape(n_frames, self._frame_size)
        rms = np.sqrt(np.mean(frames ** 2, axis=1))
        # Clamp to tiny floor so log operations never hit -inf.
        self._energy = np.maximum(rms, 1e-9)

    def _t2f(self, t: float) -> int:
        """Convert seconds to frame index (floor)."""
        return max(0, int(t * self.sample_rate / self._frame_size))

    def _f2t(self, f: int) -> float:
        """Convert frame index to seconds."""
        return f * self._frame_size / self.sample_rate

    @property
    def _silence_linear(self) -> float:
        return 10 ** (_SILENCE_DB / 20.0)

    @property
    def _snap_frames(self) -> int:
        return max(1, int(_SNAP_WINDOW_MS * self.sample_rate / (1000 * self._frame_size)))

    @property
    def _min_word_frames(self) -> int:
        return max(1, int(_MIN_WORD_MS * self.sample_rate / (1000 * self._frame_size)))

    # ── Public API ─────────────────────────────────────────────────────────────

    def detect_stream_offset(self, source_path: Path) -> float:
        """
        Return the audio stream's ``start_time`` from the container.

        This value represents AAC encoder delay / priming silence embedded in
        the container. When FFmpeg extracts audio to a WAV file, this silence
        appears at the start of the WAV, causing WhisperX timestamps to be
        systematically ahead of the video's ``currentTime`` by this amount.

        Returns 0.0 if the offset cannot be detected or is implausible.
        """
        try:
            result = subprocess.run(
                [
                    "ffprobe",
                    "-v", "error",
                    "-select_streams", "a:0",
                    "-show_entries", "stream=start_time",
                    "-print_format", "json",
                    str(source_path),
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
            data = json.loads(result.stdout or "{}")
            streams = data.get("streams", [])
            if streams:
                raw = streams[0].get("start_time")
                if raw not in (None, "N/A", ""):
                    offset = float(raw)
                    if 0.0 < offset < _OFFSET_MAX_S:
                        return round(offset, 6)
        except Exception:
            pass
        return 0.0

    def apply_offset(
        self,
        segments: list[dict[str, Any]],
        pauses: list[dict[str, Any]],
        offset: float,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """
        Subtract ``offset`` from every timestamp in segments and pauses.

        Aligns WhisperX WAV-relative timestamps with the video container
        timeline so that ``word.startTime`` matches ``video.currentTime`` and
        FFmpeg's ``trim`` filter boundaries.
        """
        if offset <= 0.0:
            return segments, pauses

        def shift(t: float) -> float:
            return max(0.0, t - offset)

        shifted_segments: list[dict[str, Any]] = []
        for seg in segments:
            new_seg = dict(seg)
            if seg.get("start") is not None:
                new_seg["start"] = shift(float(seg["start"]))
            if seg.get("end") is not None:
                new_seg["end"] = shift(float(seg["end"]))
            shifted_words: list[dict[str, Any]] = []
            for word in seg.get("words", []):
                nw = dict(word)
                if nw.get("start") is not None:
                    nw["start"] = shift(float(nw["start"]))
                if nw.get("end") is not None:
                    nw["end"] = shift(float(nw["end"]))
                shifted_words.append(nw)
            new_seg["words"] = shifted_words
            shifted_segments.append(new_seg)

        shifted_pauses: list[dict[str, Any]] = []
        for pause in pauses:
            np_ = dict(pause)
            if pause.get("startTime") is not None:
                np_["startTime"] = shift(float(pause["startTime"]))
            if pause.get("endTime") is not None:
                np_["endTime"] = shift(float(pause["endTime"]))
            if np_["endTime"] > np_["startTime"]:
                np_["duration"] = round(np_["endTime"] - np_["startTime"], 4)
                shifted_pauses.append(np_)

        return shifted_segments, shifted_pauses

    def refine_segment_words(
        self,
        words: list[dict[str, Any]],
        segment_start: float,
        segment_end: float,
    ) -> list[dict[str, Any]]:
        """
        Snap every inter-word boundary to the lowest-energy frame in the gap.

        For each consecutive pair of words with valid timestamps, this finds
        the energy minimum in the silence gap between them and moves both
        ``word_A.end`` and ``word_B.start`` to that point. The result is that
        every cut placed at a word boundary lands in natural silence.

        Words without valid start/end (unaligned) are left untouched.
        """
        self._ensure_energy()
        if not words or self._energy is None:
            return words

        refined = [dict(w) for w in words]
        min_dur = self._min_word_frames * self._frame_size / self.sample_rate

        for i in range(len(refined) - 1):
            wa = refined[i]
            wb = refined[i + 1]

            # Skip if either word lacks valid aligned timestamps.
            gap_start_s = wa.get("end")
            gap_end_s = wb.get("start")
            if gap_start_s is None or gap_end_s is None:
                continue
            gap_start_s = float(gap_start_s)
            gap_end_s = float(gap_end_s)

            if gap_end_s <= gap_start_s:
                continue

            gap_start_f = self._t2f(gap_start_s)
            gap_end_f = self._t2f(gap_end_s)
            if gap_end_f <= gap_start_f:
                continue

            gap_energy = self._energy[gap_start_f:gap_end_f]
            if len(gap_energy) == 0:
                continue

            # Place the boundary at the minimum-energy frame in the gap.
            min_rel = int(np.argmin(gap_energy))
            cut_f = gap_start_f + min_rel
            cut_t = self._f2t(cut_f)

            # Guard: don't collapse either word below the minimum duration.
            wa_start = wa.get("start")
            wb_end = wb.get("end")
            if wa_start is None or wb_end is None:
                continue
            if (cut_t - float(wa_start)) < min_dur:
                continue
            if (float(wb_end) - cut_t) < min_dur:
                continue

            wa["end"] = round(cut_t, 4)
            wb["start"] = round(cut_t, 4)

        return refined

    def refine_all_segments(
        self, segments: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Apply word-boundary refinement to every segment."""
        result: list[dict[str, Any]] = []
        for seg in segments:
            new_seg = dict(seg)
            raw_words = seg.get("words", [])
            if raw_words:
                seg_start = float(seg.get("start") or 0.0)
                seg_end = float(seg.get("end") or 0.0)
                new_seg["words"] = self.refine_segment_words(raw_words, seg_start, seg_end)
            result.append(new_seg)
        return result

    def detect_pauses(
        self,
        min_duration: float = _PAUSE_MIN_S,
        threshold_db: float = _SILENCE_DB,
    ) -> list[dict[str, Any]]:
        """
        Detect silence ranges using pre-computed frame energies.

        Replaces the FFmpeg silencedetect subprocess call, reusing the audio
        array already loaded for transcription. Results are equivalent but
        slightly more precise (5 ms frame resolution vs. FFmpeg's sample-level
        output which still rounds to packet boundaries in practice).
        """
        self._ensure_energy()
        assert self._energy is not None

        threshold_linear = 10 ** (threshold_db / 20.0)
        is_silence = self._energy < threshold_linear

        pauses: list[dict[str, Any]] = []
        in_silence = False
        silence_start_f = 0

        for frame_idx in range(len(is_silence)):
            silent = bool(is_silence[frame_idx])
            if silent and not in_silence:
                in_silence = True
                silence_start_f = frame_idx
            elif not silent and in_silence:
                in_silence = False
                start_t = self._f2t(silence_start_f)
                end_t = self._f2t(frame_idx)
                duration = end_t - start_t
                if duration >= min_duration:
                    pauses.append(
                        {
                            "id": str(uuid.uuid4()),
                            "startTime": round(start_t, 4),
                            "endTime": round(end_t, 4),
                            "duration": round(duration, 4),
                        }
                    )

        # Handle silence that runs to the end of the audio.
        if in_silence:
            start_t = self._f2t(silence_start_f)
            end_t = len(self._energy) * self._frame_size / self.sample_rate
            duration = end_t - start_t
            if duration >= min_duration:
                pauses.append(
                    {
                        "id": str(uuid.uuid4()),
                        "startTime": round(start_t, 4),
                        "endTime": round(end_t, 4),
                        "duration": round(duration, 4),
                    }
                )

        return pauses
