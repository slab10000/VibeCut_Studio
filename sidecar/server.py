from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import tempfile
import threading
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile

APP_TITLE = "VibeCut Studio WhisperX Sidecar"
AUDIO_SAMPLE_RATE = 16000
WHISPERX_MODEL = os.getenv("WHISPERX_MODEL", "large-v3")
WHISPERX_DEVICE = os.getenv("WHISPERX_DEVICE", "cpu")
WHISPERX_COMPUTE_TYPE = os.getenv("WHISPERX_COMPUTE_TYPE", "int8")
WHISPERX_BATCH_SIZE = int(os.getenv("WHISPERX_BATCH_SIZE", "16"))
# VAD (Voice Activity Detection) — filters out non-speech before transcription
WHISPERX_VAD_ONSET = float(os.getenv("WHISPERX_VAD_ONSET", "0.500"))
WHISPERX_VAD_OFFSET = float(os.getenv("WHISPERX_VAD_OFFSET", "0.363"))
# Silence detection thresholds for pause detection
SILENCE_NOISE_DB = os.getenv("SILENCE_NOISE_DB", "-35dB")
SILENCE_MIN_DURATION = float(os.getenv("SILENCE_MIN_DURATION", "0.2"))

app = FastAPI(title=APP_TITLE, version="0.1.0")

_model_lock = threading.Lock()
_transcribe_model: dict[str, Any] = {"key": None, "value": None}
_align_models: dict[tuple[str, str], tuple[Any, Any]] = {}


def whisperx_available() -> bool:
    return importlib.util.find_spec("whisperx") is not None


def require_whisperx():
    if not whisperx_available():
        raise HTTPException(
            status_code=503,
            detail="WhisperX is not installed. Run `npm run sidecar:install` and restart the sidecar.",
        )

    import whisperx  # type: ignore

    return whisperx


def require_binary(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise HTTPException(
            status_code=503,
            detail=f"`{name}` was not found on PATH. Install ffmpeg/ffprobe locally and retry.",
        )
    return path


def parse_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed == parsed else None


def get_transcribe_model(whisperx_module):
    cache_key = (WHISPERX_MODEL, WHISPERX_DEVICE, WHISPERX_COMPUTE_TYPE)

    with _model_lock:
        if _transcribe_model["key"] == cache_key and _transcribe_model["value"] is not None:
            return _transcribe_model["value"]

        model = whisperx_module.load_model(
            WHISPERX_MODEL,
            WHISPERX_DEVICE,
            compute_type=WHISPERX_COMPUTE_TYPE,
        )
        _transcribe_model["key"] = cache_key
        _transcribe_model["value"] = model
        return model


def get_align_model(whisperx_module, language_code: str):
    cache_key = (language_code, WHISPERX_DEVICE)
    with _model_lock:
        if cache_key in _align_models:
            return _align_models[cache_key]

        model, metadata = whisperx_module.load_align_model(language_code=language_code, device=WHISPERX_DEVICE)
        _align_models[cache_key] = (model, metadata)
        return model, metadata


def extract_audio(input_path: Path, output_path: Path) -> None:
    require_binary("ffmpeg")

    completed = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(input_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            str(AUDIO_SAMPLE_RATE),
            "-c:a",
            "pcm_s16le",
            "-y",
            str(output_path),
        ],
        capture_output=True,
        text=True,
    )

    if completed.returncode != 0:
        raise HTTPException(
            status_code=422,
            detail=completed.stderr.strip() or "Failed to extract audio from the uploaded clip.",
        )


def detect_pause_ranges(audio_path: Path) -> list[dict[str, Any]]:
    require_binary("ffmpeg")

    completed = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-i",
            str(audio_path),
            "-af",
            f"silencedetect=noise={SILENCE_NOISE_DB}:d={SILENCE_MIN_DURATION}",
            "-f",
            "null",
            "-",
        ],
        capture_output=True,
        text=True,
    )

    stderr = completed.stderr or ""
    pauses: list[dict[str, Any]] = []
    pending_start: float | None = None

    for line in stderr.splitlines():
        if "silence_start:" in line:
            pending_start = parse_float(line.split("silence_start:")[-1].strip())
            continue

        if "silence_end:" not in line or "silence_duration:" not in line:
            continue

        tail = line.split("silence_end:")[-1]
        end_part, duration_part = tail.split("|", maxsplit=1)
        end_time = parse_float(end_part.strip())
        duration = parse_float(duration_part.split("silence_duration:")[-1].strip())

        if end_time is None or duration is None:
            pending_start = None
            continue

        start_time = pending_start if pending_start is not None else max(0.0, end_time - duration)
        pending_start = None

        if duration < SILENCE_MIN_DURATION:
            continue

        pauses.append(
            {
                "id": str(uuid.uuid4()),
                "startTime": start_time,
                "endTime": end_time,
                "duration": duration,
            }
        )

    return pauses


def normalize_aligned_word(word: dict[str, Any]) -> dict[str, Any] | None:
    text = str(word.get("word") or word.get("text") or "").strip()
    start_time = parse_float(word.get("start"))
    end_time = parse_float(word.get("end"))

    if not text or start_time is None or end_time is None or end_time <= start_time:
        return None

    confidence = parse_float(word.get("score"))

    return {
        "id": str(uuid.uuid4()),
        "text": text,
        "startTime": start_time,
        "endTime": end_time,
        "confidence": confidence,
        "aligned": True,
        "startSample": int(round(start_time * AUDIO_SAMPLE_RATE)),
        "endSample": int(round(end_time * AUDIO_SAMPLE_RATE)),
    }


def build_segment_payloads(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized_segments: list[dict[str, Any]] = []

    for raw_segment in segments:
        text = str(raw_segment.get("text") or "").strip()
        start_time = parse_float(raw_segment.get("start"))
        end_time = parse_float(raw_segment.get("end"))

        if not text or start_time is None or end_time is None or end_time <= start_time:
            continue

        words = [
            normalized_word
            for normalized_word in (
                normalize_aligned_word(word) for word in raw_segment.get("words", []) if isinstance(word, dict)
            )
            if normalized_word
        ]

        normalized_segments.append(
            {
                "id": str(uuid.uuid4()),
                "startTime": start_time,
                "endTime": end_time,
                "text": text,
                "words": words,
            }
        )

    return normalized_segments


@app.get("/health")
def health():
    ffmpeg_path = shutil.which("ffmpeg")
    ffprobe_path = shutil.which("ffprobe")
    whisperx_ready = whisperx_available()
    ready = bool(ffmpeg_path and ffprobe_path and whisperx_ready)

    return {
        "status": "ok" if ready else "degraded",
        "provider": "whisperx",
        "model": WHISPERX_MODEL,
        "device": WHISPERX_DEVICE,
        "computeType": WHISPERX_COMPUTE_TYPE,
        "ffmpeg": bool(ffmpeg_path),
        "ffprobe": bool(ffprobe_path),
        "whisperx": whisperx_ready,
        "ready": ready,
    }


@app.post("/transcribe")
async def transcribe(
    video: UploadFile | None = File(default=None),
    source_path: str | None = Form(default=None),
    display_name: str | None = Form(default=None),
    language: str | None = Form(default=None),
):
    require_binary("ffmpeg")
    require_binary("ffprobe")
    whisperx = require_whisperx()

    source_media_path: Path | None = None
    source_name = display_name or "input.mp4"

    if source_path:
        candidate = Path(source_path).expanduser()
        if not candidate.exists() or not candidate.is_file():
            raise HTTPException(status_code=422, detail="The requested source path does not exist.")
        source_media_path = candidate
        source_name = display_name or candidate.name
    elif video is not None:
        source_name = display_name or video.filename or "input.mp4"
    else:
        raise HTTPException(status_code=422, detail="Provide either an uploaded file or a local source path.")

    suffix = Path(source_name).suffix or ".mp4"

    with tempfile.TemporaryDirectory(prefix="vibecut-whisperx-") as temp_dir:
        temp_dir_path = Path(temp_dir)
        audio_path = temp_dir_path / "audio.wav"

        if source_media_path is None:
            input_path = temp_dir_path / f"input{suffix}"
            contents = await video.read()
            input_path.write_bytes(contents)
            source_media_path = input_path

        extract_audio(source_media_path, audio_path)
        pauses = detect_pause_ranges(audio_path)

        audio = whisperx.load_audio(str(audio_path))
        model = get_transcribe_model(whisperx)

        transcribe_kwargs: dict[str, Any] = {
            "batch_size": WHISPERX_BATCH_SIZE,
            "vad_options": {
                "vad_onset": WHISPERX_VAD_ONSET,
                "vad_offset": WHISPERX_VAD_OFFSET,
            },
        }
        if language:
            transcribe_kwargs["language"] = language

        transcription = model.transcribe(audio, **transcribe_kwargs)

        transcription_segments = transcription.get("segments", [])
        aligned_segments = transcription_segments
        alignment_mode = "aligned"

        language_code = transcription.get("language") or language
        if language_code:
            try:
                align_model, metadata = get_align_model(whisperx, language_code)
                aligned = whisperx.align(
                    transcription_segments,
                    align_model,
                    metadata,
                    audio,
                    WHISPERX_DEVICE,
                    return_char_alignments=False,
                )
                aligned_segments = aligned.get("segments", transcription_segments)
            except Exception:
                alignment_mode = "transcript-only"
                aligned_segments = [
                    {
                        "start": segment.get("start"),
                        "end": segment.get("end"),
                        "text": segment.get("text"),
                        "words": [],
                    }
                    for segment in transcription_segments
                ]
        else:
            alignment_mode = "transcript-only"
            aligned_segments = [
                {
                    "start": segment.get("start"),
                    "end": segment.get("end"),
                    "text": segment.get("text"),
                    "words": [],
                }
                for segment in transcription_segments
            ]

        segments = build_segment_payloads(aligned_segments)

        if not segments:
            raise HTTPException(status_code=422, detail="WhisperX did not return any valid transcript segments.")

        return {
            "segments": segments,
            "pauses": pauses,
            "metadata": {
                "provider": "whisperx",
                "model": WHISPERX_MODEL,
                "device": WHISPERX_DEVICE,
                "computeType": WHISPERX_COMPUTE_TYPE,
                "language": language_code,
                "alignmentMode": alignment_mode,
                "vadOnset": WHISPERX_VAD_ONSET,
                "vadOffset": WHISPERX_VAD_OFFSET,
            },
        }
