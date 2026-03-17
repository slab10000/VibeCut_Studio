# VibeCut Studio

Desktop-first AI-native video editor for semantic search, transcript-driven edits, and timeline-based video workflows.

## Current foundation

- Next.js app shell with the current VibeCut Studio UI
- Multi-clip workspace with media bin, monitor, timeline, and transcript dock
- Gemini-powered semantic search and AI edit actions
- Local WhisperX sidecar for transcription and word alignment

## Local development

```bash
npm install
npm run sidecar:install
npm run dev:local
```

Or run the web app and sidecar separately:

```bash
npm run dev:web
npm run dev:sidecar
```

## Environment

Copy `.env.example` to `.env.local` and add the required keys:

```bash
GEMINI_API_KEY=your_key_here
```

## Direction

This repo is the clean product foundation for evolving VibeCut into a desktop-first app for macOS first, then Windows.
