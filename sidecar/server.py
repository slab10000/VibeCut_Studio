from __future__ import annotations

import concurrent.futures
import inspect
import importlib.util
import os
import re
import shutil
import subprocess
import tempfile
import threading
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile

from .audio_engine import AudioEngine

APP_TITLE = "VibeCut Studio WhisperX Sidecar"
AUDIO_SAMPLE_RATE = 16000
WHISPERX_MODEL = os.getenv("WHISPERX_MODEL", "large-v3")
WHISPERX_DEVICE = os.getenv("WHISPERX_DEVICE", "cpu")
WHISPERX_COMPUTE_TYPE = os.getenv("WHISPERX_COMPUTE_TYPE", "int8")
WHISPERX_BATCH_SIZE = int(os.getenv("WHISPERX_BATCH_SIZE", "16"))
# VAD (Voice Activity Detection) — filters out non-speech before transcription.
# Lower values = less aggressive filtering. The max-fidelity profile keeps
# short/filler words whenever possible and accepts the extra cleanup cost.
WHISPERX_VAD_ONSET = float(os.getenv("WHISPERX_VAD_ONSET", "0.200"))
WHISPERX_VAD_OFFSET = float(os.getenv("WHISPERX_VAD_OFFSET", "0.100"))
# Minimum language detection confidence to flag low-confidence auto-detection
# in the response metadata. We still attempt alignment and fall back only if
# the aligner actually fails.
WHISPERX_LANG_CONFIDENCE_MIN = float(os.getenv("WHISPERX_LANG_CONFIDENCE_MIN", "0.50"))
# Parallel chunked transcription settings.
# Chunk boundaries can hurt exact word timing, so chunking is opt-in and
# disabled by default in favor of whole-file transcription accuracy.
WHISPERX_CHUNK_DURATION = float(os.getenv("WHISPERX_CHUNK_DURATION", "0"))
WHISPERX_CHUNK_OVERLAP = float(os.getenv("WHISPERX_CHUNK_OVERLAP", "3"))
WHISPERX_CHUNK_WORKERS = int(os.getenv("WHISPERX_CHUNK_WORKERS", "4"))
# Silence detection thresholds for pause detection
SILENCE_NOISE_DB = os.getenv("SILENCE_NOISE_DB", "-35dB")
SILENCE_MIN_DURATION = float(os.getenv("SILENCE_MIN_DURATION", "0.2"))

app = FastAPI(title=APP_TITLE, version="0.1.0")

_model_lock = threading.Lock()
_transcribe_model: dict[str, Any] = {"key": None, "value": None}
_align_models: dict[tuple[str, str], tuple[Any, Any]] = {}
WORD_EDGE_PUNCTUATION = re.compile(r"(^[^\w']+|[^\w']+$)")


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


def filter_supported_kwargs(callable_obj: Any, kwargs: dict[str, Any]) -> dict[str, Any]:
    try:
        parameters = inspect.signature(callable_obj).parameters.values()
    except (TypeError, ValueError):
        return kwargs

    if any(parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in parameters):
        return kwargs

    supported_names = {parameter.name for parameter in parameters}
    return {key: value for key, value in kwargs.items() if key in supported_names}


def get_transcribe_model(whisperx_module):
    cache_key = (
        WHISPERX_MODEL,
        WHISPERX_DEVICE,
        WHISPERX_COMPUTE_TYPE,
        WHISPERX_VAD_ONSET,
        WHISPERX_VAD_OFFSET,
    )

    with _model_lock:
        if _transcribe_model["key"] == cache_key and _transcribe_model["value"] is not None:
            return _transcribe_model["value"]

        load_kwargs = filter_supported_kwargs(
            whisperx_module.load_model,
            {
                "compute_type": WHISPERX_COMPUTE_TYPE,
                "vad_options": {
                    "vad_onset": WHISPERX_VAD_ONSET,
                    "vad_offset": WHISPERX_VAD_OFFSET,
                },
            },
        )
        model = whisperx_module.load_model(WHISPERX_MODEL, WHISPERX_DEVICE, **load_kwargs)
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


def _transcribe_chunk(
    model,
    chunk_audio,
    chunk_offset: float,
    transcribe_kwargs: dict[str, Any],
) -> tuple[list[dict[str, Any]], str | None, float]:
    """Transcribe one audio chunk and shift all timestamps by chunk_offset."""
    result = model.transcribe(chunk_audio, **filter_supported_kwargs(model.transcribe, transcribe_kwargs))
    segments: list[dict[str, Any]] = []
    for seg in result.get("segments", []):
        shifted = dict(seg)
        shifted["start"] = (seg.get("start") or 0.0) + chunk_offset
        shifted["end"] = (seg.get("end") or 0.0) + chunk_offset
        shifted_words = []
        for w in seg.get("words", []):
            sw = dict(w)
            if sw.get("start") is not None:
                sw["start"] = sw["start"] + chunk_offset
            if sw.get("end") is not None:
                sw["end"] = sw["end"] + chunk_offset
            shifted_words.append(sw)
        shifted["words"] = shifted_words
        segments.append(shifted)
    lang = result.get("language")
    confidence = parse_float(result.get("language_probability")) or 0.0
    return segments, lang, confidence


def transcribe_parallel(
    model,
    audio,
    transcribe_kwargs: dict[str, Any],
) -> tuple[list[dict[str, Any]], str | None, float]:
    """Transcribe whole audio by default, or split into chunks when explicitly enabled."""
    if WHISPERX_CHUNK_DURATION <= 0 or WHISPERX_CHUNK_WORKERS <= 1:
        return _transcribe_chunk(model, audio, 0.0, transcribe_kwargs)

    chunk_samples = int(WHISPERX_CHUNK_DURATION * AUDIO_SAMPLE_RATE)
    if chunk_samples <= 0:
        return _transcribe_chunk(model, audio, 0.0, transcribe_kwargs)

    overlap_samples = max(0, int(WHISPERX_CHUNK_OVERLAP * AUDIO_SAMPLE_RATE))
    total_samples = len(audio)

    if total_samples <= chunk_samples:
        return _transcribe_chunk(model, audio, 0.0, transcribe_kwargs)

    # Build chunk slices: (audio_slice, offset_in_seconds)
    chunks: list[tuple[Any, float]] = []
    pos = 0
    while pos < total_samples:
        end = min(pos + chunk_samples + overlap_samples, total_samples)
        chunks.append((audio[pos:end], pos / AUDIO_SAMPLE_RATE))
        pos += chunk_samples
        if end >= total_samples:
            break

    if len(chunks) == 1:
        segs, lang, conf = _transcribe_chunk(model, audio, 0.0, transcribe_kwargs)
        return segs, lang, conf

    workers = min(WHISPERX_CHUNK_WORKERS, len(chunks))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [
            pool.submit(_transcribe_chunk, model, chunk_audio, offset, transcribe_kwargs)
            for chunk_audio, offset in chunks
        ]
        results = [f.result() for f in futures]

    # Merge: each chunk "owns" segments starting before the next chunk's non-overlapping start.
    merged_segments: list[dict[str, Any]] = []
    best_lang: str | None = None
    best_conf = 0.0

    for i, (chunk_segs, lang, conf) in enumerate(results):
        # Authority boundary: segments that start before the next chunk begins (non-overlap).
        next_chunk_start = chunks[i + 1][1] if i + 1 < len(chunks) else float("inf")

        for seg in chunk_segs:
            seg_start = seg.get("start") or 0.0
            if seg_start < next_chunk_start:
                merged_segments.append(seg)

        if conf > best_conf:
            best_conf = conf
            best_lang = lang

    # Sort by start time in case chunks arrived out of order.
    merged_segments.sort(key=lambda s: s.get("start") or 0.0)

    return merged_segments, best_lang, best_conf


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
        "timingMode": "exact",
        "editable": True,
        "startSample": int(round(start_time * AUDIO_SAMPLE_RATE)),
        "endSample": int(round(end_time * AUDIO_SAMPLE_RATE)),
    }


def normalize_match_token(text: str) -> str:
    return WORD_EDGE_PUNCTUATION.sub("", text.strip().lower())


def token_weight(text: str) -> int:
    return max(len(normalize_match_token(text)) or len(text.strip()), 1)


def interpolate_display_words(display_words: list[dict[str, Any]], segment_start: float, segment_end: float) -> list[dict[str, Any]]:
    if not display_words:
        return display_words

    index = 0
    while index < len(display_words):
        if display_words[index]["timingMode"] != "approximate":
            index += 1
            continue

        run_start = index
        while index < len(display_words) and display_words[index]["timingMode"] == "approximate":
            index += 1
        run_end = index - 1

        previous_exact = display_words[run_start - 1] if run_start > 0 else None
        next_exact = display_words[run_end + 1] if run_end + 1 < len(display_words) else None

        left_boundary = previous_exact["endTime"] if previous_exact else segment_start
        right_boundary = next_exact["startTime"] if next_exact else segment_end

        if right_boundary <= left_boundary:
            left_boundary = previous_exact["startTime"] if previous_exact else segment_start
            right_boundary = next_exact["endTime"] if next_exact else segment_end

        if right_boundary <= left_boundary:
            right_boundary = left_boundary + max(0.02 * (run_end - run_start + 1), 0.02)

        weights = [token_weight(display_words[word_index]["text"]) for word_index in range(run_start, run_end + 1)]
        total_weight = sum(weights) or len(weights)
        cursor = left_boundary

        for offset, word_index in enumerate(range(run_start, run_end + 1)):
            word = display_words[word_index]
            duration = (right_boundary - left_boundary) * (weights[offset] / total_weight)
            next_cursor = right_boundary if word_index == run_end else cursor + duration
            word["startTime"] = cursor
            word["endTime"] = max(next_cursor, cursor + 0.01)
            word["startSample"] = int(round(word["startTime"] * AUDIO_SAMPLE_RATE))
            word["endSample"] = int(round(word["endTime"] * AUDIO_SAMPLE_RATE))
            cursor = word["endTime"]

    return display_words


def reconcile_display_words(text: str, aligned_words: list[dict[str, Any]], segment_start: float, segment_end: float) -> list[dict[str, Any]]:
    raw_tokens = [token for token in text.split() if token.strip()]
    exact_words = sorted(aligned_words, key=lambda word: (word["startTime"], word["endTime"]))
    display_words: list[dict[str, Any]] = []
    exact_index = 0

    for token in raw_tokens:
        normalized_token = normalize_match_token(token)
        matched_word = None
        if exact_index < len(exact_words):
            candidate = exact_words[exact_index]
            if normalize_match_token(candidate["text"]) == normalized_token:
                matched_word = dict(candidate)
                exact_index += 1

        if matched_word is not None:
            display_words.append(matched_word)
            continue

        display_words.append(
            {
                "id": str(uuid.uuid4()),
                "text": token,
                "startTime": segment_start,
                "endTime": segment_end,
                "confidence": None,
                "aligned": False,
                "timingMode": "approximate",
                "editable": False,
                "startSample": int(round(segment_start * AUDIO_SAMPLE_RATE)),
                "endSample": int(round(segment_end * AUDIO_SAMPLE_RATE)),
            }
        )

    for leftover in exact_words[exact_index:]:
        display_words.append(dict(leftover))

    return interpolate_display_words(display_words, segment_start, segment_end)


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
        words.sort(key=lambda word: (word["startTime"], word["endTime"]))
        display_words = reconcile_display_words(text, words, start_time, end_time)

        normalized_segments.append(
            {
                "id": str(uuid.uuid4()),
                "startTime": start_time,
                "endTime": end_time,
                "text": text,
                "rawText": text,
                "alignedWords": words,
                "displayWords": display_words,
                "words": display_words,
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

        audio = whisperx.load_audio(str(audio_path))

        # ── Audio engine: initialise once, reuse across all analysis steps ──
        engine = AudioEngine(audio, AUDIO_SAMPLE_RATE)

        # Detect AAC encoder delay / container start_time offset so that
        # WhisperX timestamps align with the HTML5 video timeline and the
        # FFmpeg trim boundaries used at export time.
        stream_offset = engine.detect_stream_offset(source_media_path)

        # Pause detection reuses the already-loaded audio array — no extra
        # subprocess needed and the 5 ms frame resolution is more precise
        # than the FFmpeg silencedetect output.
        pauses = engine.detect_pauses(min_duration=SILENCE_MIN_DURATION)

        model = get_transcribe_model(whisperx)

        transcribe_kwargs: dict[str, Any] = {
            "batch_size": WHISPERX_BATCH_SIZE,
        }
        if language:
            transcribe_kwargs["language"] = language

        transcription_segments, detected_language, lang_confidence = transcribe_parallel(
            model, audio, transcribe_kwargs
        )

        aligned_segments = transcription_segments
        alignment_mode = "aligned"

        language_code = detected_language or language
        alignment_eligible = bool(language_code and transcription_segments)

        if alignment_eligible:
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

        # ── Snap word boundaries to silence gaps ────────────────────────────
        # This replaces wav2vec2 alignment's approximate end/start times with
        # the lowest-energy frame in each inter-word gap — ensuring every cut
        # lands in natural silence rather than mid-phoneme.
        aligned_segments = engine.refine_all_segments(aligned_segments)

        # ── Apply stream offset so timestamps match the video timeline ──────
        aligned_segments, pauses = engine.apply_offset(aligned_segments, pauses, stream_offset)

        low_confidence_language = bool(
            not language and language_code and lang_confidence < WHISPERX_LANG_CONFIDENCE_MIN
        )
        if low_confidence_language:
            alignment_mode = f"{alignment_mode}-low-confidence-language"

        segments = build_segment_payloads(aligned_segments)

        if not segments:
            raise HTTPException(
                status_code=422,
                detail=(
                    "No speech was detected in this clip. "
                    "Check that the video has audible dialogue and is not silent."
                ),
            )

        return {
            "segments": segments,
            "pauses": pauses,
            "metadata": {
                "provider": "whisperx",
                "model": WHISPERX_MODEL,
                "device": WHISPERX_DEVICE,
                "computeType": WHISPERX_COMPUTE_TYPE,
                "language": language_code,
                "languageConfidence": lang_confidence,
                "alignmentMode": alignment_mode,
                "languageLocked": bool(language),
                "lowConfidenceLanguage": low_confidence_language,
                "audioStreamOffset": stream_offset,
                "vadOnset": WHISPERX_VAD_ONSET,
                "vadOffset": WHISPERX_VAD_OFFSET,
            },
        }
