# Local WhisperX Sidecar

This service powers local transcription and word alignment for VibeCut Studio.

## Setup

1. Install system dependencies:
   - `ffmpeg`
   - `ffprobe`
2. Install Python dependencies:
   - `npm run sidecar:install`
3. Start the sidecar:
   - `npm run dev:sidecar`

## Endpoints

- `GET /health`
- `POST /transcribe`

`POST /transcribe` expects a multipart upload with one `video` file.
