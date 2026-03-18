# VibeCut Studio — Feature Documentation

A reference for understanding the app's capabilities, architecture, and data flows to enable parallelized development.

---

## Table of Contents

1. [App Overview](#app-overview)
2. [Architecture](#architecture)
3. [Feature Areas](#feature-areas)
   - [Media Library](#media-library)
   - [Transcription](#transcription)
   - [Timeline Editing](#timeline-editing)
   - [Transcript-Based Editing](#transcript-based-editing)
   - [AI Content Generation](#ai-content-generation)
   - [AI Edit Commands](#ai-edit-commands)
   - [Export & Rendering](#export--rendering)
   - [Job Queue](#job-queue)
   - [Search](#search)
   - [Playback](#playback)
4. [Data Models](#data-models)
5. [Communication Patterns](#communication-patterns)
6. [State Management](#state-management)
7. [Directory Map](#directory-map)

---

## App Overview

VibeCut Studio is a **desktop video editor focused on AI-powered editing**. Its core differentiator is the ability to edit video by selecting transcript text — powered by WhisperX word-level alignment — plus AI assistance via the Gemini API for editing suggestions and asset generation.

Built with:

- **Tauri (Rust)** — desktop shell and business logic
- **React + TypeScript** — UI
- **Python/FastAPI sidecar** — WhisperX transcription server
- **Gemini API** — AI content generation and edit reasoning
- **FFmpeg** — media processing and export
- **SQLite** — local project database

---

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│  Frontend (React + TypeScript)                             │
│  Components → Feature Slices → Tauri IPC (invoke)          │
├────────────────────────────────────────────────────────────┤
│  Backend (Rust + Tauri)                                    │
│  tauri_commands → application/workflows → db.rs            │
│  Events emitted to frontend: jobs-updated, entities-changed│
├────────────────────────────────────────────────────────────┤
│  Python Sidecar  (localhost:8765)                          │
│  POST /transcribe · GET /health                            │
├────────────────────────────────────────────────────────────┤
│  External: Gemini API (images, video, style, edit AI)      │
│  Local: FFmpeg/FFprobe (probing, rendering, silence)       │
└────────────────────────────────────────────────────────────┘
```

**Event flow:** Backend jobs complete → emit `jobs-updated` / `entities-changed` Tauri events → frontend React Query cache invalidation → UI re-renders.

---

## Feature Areas

---

### Media Library

**What:** Import, organize, and inspect video clips. Each imported clip becomes a `MediaAsset`.

**Entry points:**

- `src/components/MediaBin.tsx` — UI panel
- `src/features/library/api.ts` — React Query hooks (`useLibraryList`, `useLibraryImport`, `useLibraryRemove`)
- `src-tauri/src/tauri_commands/mutations.rs` — `library_import_paths`, `library_remove`
- `src-tauri/src/application/workflows.rs` — `import_media_paths()`

**Import flow:**

1. User drops files or picks via dialog.
2. `library_import_paths(paths[])` is invoked.
3. Backend runs FFprobe (codec, duration, dimensions), SHA256 fingerprint, waveform generation, thumbnail/preview creation.
4. `MediaAsset` row inserted into SQLite `media_assets` table.
5. `entities-changed` event emitted → frontend refetches library list.

**Deduplication:** If a file's fingerprint already exists, it is not re-imported.

**Status field:** `ClipProcessingStatus` — `queued | processing | ready | error`

---

### Transcription

**What:** Run WhisperX speech-to-text on a clip to get segment and word-level timestamps. Also detects silence/pause ranges.

**Entry points:**

- `src/components/TranscriptPanel.tsx` — displays transcript
- `src/features/transcript/api.ts` — `useTranscript`, `useEnqueueTranscript`
- `src-tauri/src/application/workflows.rs` — `enqueue_transcript()`
- `sidecar/server.py` — WhisperX server, `/transcribe` endpoint

**Transcription flow:**

1. User selects a clip and triggers transcription.
2. Backend creates a `JobRecord` (kind=`transcript`) and emits `jobs-updated`.
3. Background task POSTs video to sidecar (`POST /transcribe`).
4. Sidecar: extracts audio → runs WhisperX model → performs word-level alignment → detects silences.
5. Returns `segments[]` (with nested `words[]`) and `pauses[]`.
6. Backend stores results in `transcript_segments`, `transcript_words`, `pause_ranges` tables.
7. Job marked complete → `jobs-updated` event → frontend re-renders transcript.

**Transcript data structure:**

```
Segment
  ├── start_time / end_time
  ├── text
  └── words[]
        ├── text
        ├── start_time / end_time (word-level)
        ├── confidence
        └── aligned: bool
```

**Models:** WhisperX models are cached in-memory in the sidecar after first load. Language auto-detection is supported; word alignment is skipped if confidence is below threshold.

---

### Timeline Editing

**What:** A visual sequence editor. The timeline is an ordered list of `SequenceItem`s — trimmed clips placed at specific time positions.

**Entry points:**

- `src/components/Timeline.tsx` — visual timeline UI
- `src/features/timeline/api.ts` — `useTimeline`, `useTimelinePatch`
- `src/features/timeline/hooks/useTimelineEditor.ts` — editing logic
- `src/features/timeline/model/reducer.ts` — immutable state reducer
- `src-tauri/src/tauri_commands/mutations.rs` — `timeline_apply_patch`

**SequenceItem fields:**

- `source_clip_id` — references a `MediaAsset`
- `source_start_time` / `source_end_time` — in-clip trim points
- `timeline_start_ms` — position in the sequence
- `duration_ms` — rendered duration
- `track` — video track layer
- `playback_rate` — speed factor
- `kind` — `video | image`
- `effects[]` — applied effects

**Patching:** The timeline is updated via `timeline_apply_patch(patch)`. The patch replaces sequence items atomically. The frontend reducer (`reducer.ts`) builds the new item list, and it is sent in a single command.

---

### Transcript-Based Editing

**What:** Select words in the transcript and remove them from the timeline. This is the core editing paradigm — edit by reading, not by scrubbing.

**Entry points:**

- `src/components/TranscriptPanel.tsx` — word selection UI
- `src/app/editor/EditorShell.tsx` — handles selection → patch logic
- `src-tauri/src/tauri_commands/mutations.rs` — `timeline_apply_patch`

**Selection flow:**

1. User clicks/drags to select words in the `TranscriptPanel`.
2. `onSelectionChange()` builds a `TranscriptSelection` (word IDs, time range, source clip ID).
3. User clicks "Remove Selection".
4. Frontend computes new clip boundaries by removing the selected time range.
5. Calls `timeline_apply_patch()` with updated `SequenceItem` list.
6. `entities-changed` emitted → timeline re-fetches and re-renders.

**Pause removal:** `onRemoveLongPauses()` filters `pause_ranges` by a minimum duration threshold and removes all matching ranges from the timeline in one patch.

---

### AI Content Generation

**What:** Generate images, transition videos, and font suggestions using the Gemini API.

**Entry points:**

- `src/components/ImageGenPanel.tsx` — image generation UI
- `src/components/VibeTransitionPanel.tsx` — transition generation UI
- `src/components/VibeFontPanel.tsx` — font suggestion UI
- `src/features/ai/api.ts` — API call hooks
- `src-tauri/src/application/workflows.rs` — `ai_generate_image()`, `ai_generate_video()`, `ai_generate_transition()`, `ai_generate_font()`

**Image generation:**

- User enters a text prompt, optionally provides a reference image (base64).
- Calls `ai_generate_image(prompt, referenceBase64?, referenceMime?)`.
- Gemini 2.0 Flash returns a base64 image.
- Displayed in the `ImageGenPanel`.

**Transition generation:**

- Extracts last frame of preceding clip and first frame of next clip.
- Calls `ai_generate_transition(lastFrame, nextFrame?, description?)`.
- Gemini generates a short video bridging the two frames.
- Returned `video_path` is inserted as a `SequenceItem` into the timeline.
- Uses polling to wait for async Gemini video operations to complete.

**Font suggestions:**

- Calls `ai_generate_font(imageBase64)`.
- Gemini analyzes the image and returns: `font_family`, `color`, `text_shadow`, `cssFilter`.
- Applied in the `VibeFontPanel` as CSS styling.

---

### AI Edit Commands

**What:** User writes a natural-language edit instruction. Gemini reasons over the transcript and timeline, returning structured edit operations.

**Entry points:**

- `src/components/CommandInput.tsx` — text input UI
- `src/app/editor/EditorShell.tsx` — handles job result → apply flow
- `src/features/ai/api.ts` — `useEnqueueAiEditCommand`
- `src-tauri/src/application/workflows.rs` — `enqueue_ai_edit()`

**Edit command flow:**

1. User types a command (e.g., "remove all filler words").
2. `ai_enqueue_edit_command(command, transcript_segments, timeline_clips)` invoked.
3. Backend creates a `JobRecord` (kind=`ai_edit`) with full context in `payload`.
4. Background task sends prompt + context to Gemini.
5. Gemini returns `EditCommandResponse`:
   ```
   {
     operations: [
       { type: "DELETE_RANGE", sourceClipId, startTime, endTime },
       ...
     ],
     explanation: "string"
   }
   ```
6. Job completes → `jobs-updated` event.
7. Frontend stores `explanation` in `SessionStore` for display.
8. User reviews operations, clicks "Apply".
9. `parseAiEditResult()` converts operations to a timeline patch.
10. `timeline_apply_patch()` applies the changes.

**Operation types:** `DELETE_RANGE`, `INSERT_GAP`, `TRIM_CLIP`, and others.

---

### Export & Rendering

**What:** Render the current timeline to an MP4 file using FFmpeg.

**Entry points:**

- `src/app/editor/EditorShell.tsx` — export button + file dialog
- `src/features/export/api.ts` — `useEnqueueExport`
- `src-tauri/src/application/workflows.rs` — `export_timeline_direct()`

**Export flow:**

1. User clicks Export → file save dialog (`pickSavePath()`).
2. `export_enqueue(clips, outputPath)` invoked.
3. Backend creates a `JobRecord` (kind=`export`).
4. Background task:
   - For each `SequenceItem`: extract segment `[source_start, source_end]` from source file.
   - Apply `playback_rate` adjustment.
   - Render intermediate file.
   - Merge all intermediates with FFmpeg concat.
   - Write final MP4 to `outputPath`.
5. Job completes → `result.videoPath` available in job record.
6. Frontend notifies user.

**Hardware acceleration:** `runtime.rs` detects available hardware encoders (VideoToolbox on macOS, NVENC, AMF, etc.) and uses them when available.

---

### Job Queue

**What:** An async task system for long-running operations. All heavy work (transcription, export, AI calls) runs as background jobs without blocking the UI.

**Entry points:**

- `src/features/jobs/api.ts` — `useJobs` query
- `src-tauri/src/domain/jobs.rs` — job state transitions
- `src-tauri/src/application/events.rs` — `emit_job_update()`

**Job record fields:**

- `id` — UUID
- `kind` — `transcript | export | ai_edit | ...`
- `target_kind` / `target_id` — resource being processed
- `status` — `queued | running | complete | error`
- `progress` — `0.0` to `1.0`
- `message` — human-readable status string
- `payload` — job input (JSON)
- `result` — job output (JSON)
- `error_message`
- `fingerprint` — deduplication key (prevents duplicate jobs)
- `created_at` / `updated_at`

**Deduplication:** Jobs with the same `fingerprint` are not re-enqueued.

**Events:** Every job status change emits a `jobs-updated` Tauri event. Frontend listeners call `queryClient.invalidateQueries(queryKeys.jobs())` to re-fetch job list.

---

### Search

**What:** Full-text and semantic search across transcripts.

**Entry points:**

- `src/components/MediaBin.tsx` — search input UI
- `src/features/transcript/api.ts` — search hooks
- `src-tauri/src/application/workflows.rs` — `search_query()`
- `src/core/search.ts` — frontend search/embedding logic

**Search is embedding-based:** transcripts are embedded and searched semantically. Results link back to source clip + timestamp, enabling the user to jump to relevant moments.

---

### Playback

**What:** In-app video preview with two monitor modes — Source (raw imported clip) and Program (rendered timeline output).

**Entry points:**

- `src/components/VideoPlayer.tsx` — player UI
- `src/features/playback/store/playback-store.ts` — Zustand store
- `src/hooks/useVideoPlayer.ts`

**PlaybackStore state:**

- `currentTime` — playback cursor position (seconds)
- `mode` — `source | program`
- `activeClipId` — which clip is being previewed

When a transcript word is clicked, `currentTime` is set to the word's `start_time`, seeking the player.

---

## Data Models

### MediaAsset

Represents an imported video file.

| Field                       | Type       | Notes                              |
| --------------------------- | ---------- | ---------------------------------- |
| `id`                        | string     | UUID                               |
| `source_path`               | string     | Absolute file path                 |
| `fingerprint`               | string     | SHA256 hash                        |
| `duration`                  | f64        | Seconds                            |
| `status`                    | enum       | `queued\|processing\|ready\|error` |
| `transcript_status`         | enum       |                                    |
| `waveform`                  | Vec\<f64\> | Audio visualization                |
| `preview_path`              | string?    | Low-res preview                    |
| `thumbnail_path`            | string?    |                                    |
| `proxy_path`                | string?    | Optimized playback proxy           |
| `video_codec / audio_codec` | string     |                                    |
| `width / height`            | i32        |                                    |
| `has_audio`                 | bool       |                                    |

### SequenceItem

One clip in the timeline.

| Field               | Type                  | Notes                 |
| ------------------- | --------------------- | --------------------- |
| `id`                | string                |                       |
| `source_clip_id`    | string?               | References MediaAsset |
| `source_start_time` | f64                   | In-clip in-point      |
| `source_end_time`   | f64                   | In-clip out-point     |
| `timeline_start_ms` | i64                   | Position in sequence  |
| `duration_ms`       | i64                   |                       |
| `track`             | i64                   | Layer                 |
| `playback_rate`     | f64                   | Speed                 |
| `kind`              | enum                  | `video\|image`        |
| `effects`           | Vec\<SequenceEffect\> |                       |

### TranscriptSegment / TranscriptWord

Hierarchical transcript data.

```
TranscriptSegment
  └── TranscriptWord
        ├── text
        ├── start_time / end_time   ← word-level timing
        ├── confidence
        └── aligned: bool
```

### JobRecord

Async task record. See [Job Queue](#job-queue) section above.

---

## Communication Patterns

### Frontend → Backend (Tauri `invoke`)

| Command                   | Type     | Description                |
| ------------------------- | -------- | -------------------------- |
| `project_get`             | query    | Load project metadata      |
| `library_list`            | query    | Get all MediaAssets        |
| `library_import_paths`    | mutation | Import video files         |
| `library_remove`          | mutation | Delete a clip              |
| `timeline_get`            | query    | Get SequenceItems          |
| `timeline_apply_patch`    | mutation | Replace timeline items     |
| `transcript_get`          | query    | Get transcript for a clip  |
| `transcript_enqueue`      | mutation | Queue transcription job    |
| `jobs_list`               | query    | Get all JobRecords         |
| `export_enqueue`          | mutation | Queue export job           |
| `ai_enqueue_edit_command` | mutation | Queue AI edit job          |
| `ai_generate_image`       | mutation | Direct Gemini image call   |
| `ai_generate_video`       | mutation | Direct Gemini video call   |
| `ai_generate_transition`  | mutation | Generate transition video  |
| `ai_generate_font`        | mutation | Font suggestion from image |
| `capabilities_get`        | query    | System capabilities check  |
| `search_query`            | query    | Search transcripts         |

### Backend → Frontend (Tauri events)

| Event              | Payload         | Trigger               |
| ------------------ | --------------- | --------------------- |
| `jobs-updated`     | JobRecord       | Any job status change |
| `entities-changed` | `{entity_type}` | DB entity modified    |

Frontend listens via `useDesktopEvents` (`src/shared/desktop/useDesktopEvents.ts`) and invalidates the matching React Query cache key.

### Backend → Sidecar (HTTP)

```
GET  /health      → sidecar capabilities (ffmpeg, whisperx, device)
POST /transcribe  → {segments, pauses, metadata}
```

---

## State Management

Two separate state systems:

### React Query (server state)

Caches backend data. Keys defined in `src/shared/query/keys.ts`.

| Query Key        | Data             | Invalidated by                       |
| ---------------- | ---------------- | ------------------------------------ |
| `library`        | MediaAsset[]     | `entities-changed` (media)           |
| `timeline`       | SequenceItem[]   | `entities-changed` (timeline)        |
| `transcript(id)` | Segments + Words | `jobs-updated` (transcript complete) |
| `jobs`           | JobRecord[]      | `jobs-updated`                       |
| `project`        | Project          | `entities-changed` (project)         |
| `capabilities`   | system caps      | on mount                             |

### Zustand (client state)

**SessionStore** (`src/features/session/store/session-store.ts`):

- Selected clip IDs
- `TranscriptSelection` (selected words + time range)
- Active dock tab
- Search query string
- Last AI explanation

**PlaybackStore** (`src/features/playback/store/playback-store.ts`):

- `currentTime`
- `mode` (source | program)
- `activeClipId`

---

## Directory Map

```
VibeCut_Studio/
├── src/                            # React frontend
│   ├── app/editor/EditorShell.tsx  # Main layout + orchestration
│   ├── components/                 # UI panels
│   │   ├── MediaBin.tsx            # Library
│   │   ├── TranscriptPanel.tsx     # Transcript display/selection
│   │   ├── Timeline.tsx            # Timeline editor
│   │   ├── VideoPlayer.tsx         # Playback
│   │   ├── ImageGenPanel.tsx       # AI image gen
│   │   ├── VibeTransitionPanel.tsx # AI transition gen
│   │   ├── VibeFontPanel.tsx       # Font suggestions
│   │   └── CommandInput.tsx        # AI edit commands
│   ├── features/                   # Feature slices
│   │   ├── library/api.ts
│   │   ├── transcript/api.ts
│   │   ├── timeline/api.ts + hooks/ + model/
│   │   ├── ai/api.ts
│   │   ├── export/api.ts
│   │   ├── jobs/api.ts
│   │   ├── project/api.ts
│   │   ├── playback/store/
│   │   └── session/store/
│   ├── shared/
│   │   ├── contracts/types.ts      # All TS types
│   │   ├── desktop/transport.ts    # Tauri invoke wrapper
│   │   └── query/keys.ts           # React Query key factories
│   └── core/
│       ├── search.ts
│       └── timeline.ts
│
├── src-tauri/src/                  # Rust backend
│   ├── main.rs                     # Tauri app + command registration
│   ├── db.rs                       # SQLite CRUD
│   ├── models.rs                   # Data model structs
│   ├── state.rs                    # AppState (db, cache_dir)
│   ├── application/
│   │   ├── workflows.rs            # Core business logic
│   │   └── events.rs               # Event emission helpers
│   ├── infrastructure/
│   │   ├── runtime.rs              # FFmpeg, waveform, HW detection
│   │   └── providers.rs            # Gemini API, sidecar HTTP client
│   ├── domain/
│   │   └── jobs.rs                 # Job state transitions
│   └── tauri_commands/
│       ├── queries.rs              # Read commands
│       ├── mutations.rs            # Write commands
│       └── jobs.rs                 # Job enqueue commands
│
└── sidecar/
    └── server.py                   # FastAPI + WhisperX transcription
```

---

## Parallelization Notes

These feature areas are largely independent and can be worked on in parallel:

| Area                   | Dependencies                         | Can work independently? |
| ---------------------- | ------------------------------------ | ----------------------- |
| Media Library UI       | `library/api.ts`, `MediaBin.tsx`     | Yes                     |
| Transcription backend  | `workflows.rs`, `server.py`          | Yes                     |
| Timeline reducer/logic | `timeline/model/reducer.ts`          | Yes                     |
| AI generation panels   | `ai/api.ts`, `*Panel.tsx`            | Yes                     |
| Export logic           | `workflows.rs` export section        | Yes (independent of AI) |
| Playback               | `VideoPlayer.tsx`, playback-store    | Yes                     |
| Search                 | `search.ts`, `search_query` workflow | Yes                     |
| Job queue display      | `jobs/api.ts`, job UI in EditorShell | Yes                     |

**Shared contracts:** All features share `src/shared/contracts/types.ts` and `src/shared/query/keys.ts`. Changes to these affect all features.

**EditorShell** (`src/app/editor/EditorShell.tsx`) orchestrates all panels and is the integration point — it is the most likely source of merge conflicts when working in parallel.
