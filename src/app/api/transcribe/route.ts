import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { getGeminiClient, MODELS } from "@/lib/gemini";
import { v4 as uuid } from "uuid";

const execFileAsync = promisify(execFile);

export const runtime = "nodejs";
export const maxDuration = 60;

const TRANSCRIPTION_PROVIDER = (process.env.TRANSCRIPTION_PROVIDER ?? "local").toLowerCase();
const LOCAL_ALIGNER_URL = process.env.LOCAL_ALIGNER_URL ?? "http://127.0.0.1:8765";
const AUDIO_SAMPLE_RATE = 16000;

type ParsedWord = {
  text?: string;
  word?: string;
  startTime?: number;
  endTime?: number;
  start?: number;
  end?: number;
  confidence?: number;
  score?: number;
  aligned?: boolean;
  startSample?: number;
  endSample?: number;
};

type ParsedSegment = {
  id?: string;
  startTime?: number;
  endTime?: number;
  start?: number;
  end?: number;
  text?: string;
  words?: ParsedWord[];
};

type NormalizedWord = {
  id: string;
  segmentId: string;
  text: string;
  startTime: number;
  endTime: number;
  confidence: number | undefined;
  aligned: boolean;
  startSample?: number;
  endSample?: number;
};

type NormalizedSegment = {
  id: string;
  startTime: number;
  endTime: number;
  text: string;
  words: NormalizedWord[];
  alignmentSource: "whisperx" | "gemini";
  wordEditCapable: boolean;
};

type NormalizedPause = {
  id: string;
  startTime: number;
  endTime: number;
  duration: number;
};

type ProbeStream = {
  codec_type?: string;
};

type ProbeResult = {
  streams?: ProbeStream[];
};

type LocalSidecarResponse = {
  segments?: ParsedSegment[];
  pauses?: Array<{
    id?: string;
    startTime?: number;
    endTime?: number;
    start?: number;
    end?: number;
    duration?: number;
  }>;
  metadata?: Record<string, unknown>;
};

function parseJsonResponse(text: string) {
  const cleaned = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned);
}

function normalizeSeconds(value: unknown, fallback: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSamples(value: unknown, fallback?: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

async function detectPauseRanges(audioPath: string) {
  const { stderr } = await execFileAsync("ffmpeg", [
    "-hide_banner",
    "-i",
    audioPath,
    "-af",
    "silencedetect=noise=-35dB:d=0.2",
    "-f",
    "null",
    "-",
  ]);

  const pauses: NormalizedPause[] = [];
  let pendingStart: number | null = null;

  for (const line of stderr.split("\n")) {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
    if (startMatch) {
      pendingStart = parseFloat(startMatch[1]);
      continue;
    }

    const endMatch = line.match(/silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/);
    if (!endMatch) continue;

    const endTime = parseFloat(endMatch[1]);
    const duration = parseFloat(endMatch[2]);
    const startTime = pendingStart ?? Math.max(0, endTime - duration);
    pendingStart = null;

    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || duration < 0.2) continue;

    pauses.push({
      id: uuid(),
      startTime,
      endTime,
      duration,
    });
  }

  return pauses;
}

async function getMediaStreams(inputPath: string): Promise<ProbeResult> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_streams",
      inputPath,
    ]);

    return JSON.parse(stdout) as ProbeResult;
  } catch (error) {
    console.warn("ffprobe failed or is not installed", error);
    return { streams: [] };
  }
}

async function extractAudioFromVideoFile(videoFile: File) {
  const tempDir = await mkdtemp(join(tmpdir(), "vibecut-"));
  const inputExt = extname(videoFile.name) || ".mp4";
  const inputPath = join(tempDir, `input${inputExt}`);
  const outputPath = join(tempDir, "audio.wav");

  try {
    const buffer = Buffer.from(await videoFile.arrayBuffer());
    await writeFile(inputPath, buffer);

    const probe = await getMediaStreams(inputPath);
    const hasAudioStream = (probe.streams || []).some((stream) => stream.codec_type === "audio");

    if (!hasAudioStream) {
      return {
        audioBase64: null,
        mimeType: null,
        audioPath: null,
        cleanupPath: tempDir,
      };
    }

    await execFileAsync("ffmpeg", [
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(AUDIO_SAMPLE_RATE),
      "-c:a",
      "pcm_s16le",
      "-y",
      outputPath,
    ]);

    const audioBuffer = await readFile(outputPath);
    return {
      audioBase64: audioBuffer.toString("base64"),
      mimeType: "audio/wav",
      audioPath: outputPath,
      cleanupPath: tempDir,
    };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Audio extraction process failed: ${message}`);
  }
}

async function getVideoFile(req: Request) {
  const contentType = req.headers.get("content-type") || "";
  const rawVideoFileName = req.headers.get("x-video-filename");

  if (rawVideoFileName) {
    const buffer = await req.arrayBuffer();
    return new File([buffer], decodeURIComponent(rawVideoFileName), {
      type: contentType || "application/octet-stream",
    });
  }

  if (contentType.includes("multipart/form-data")) {
    const formData = await req.formData();
    const video = formData.get("video");
    if (video instanceof File) return video;
  }

  throw new Error("No source video file provided for local transcription.");
}

async function getAudioPayload(req: Request) {
  const contentType = req.headers.get("content-type") || "";
  const rawAudioFileName = req.headers.get("x-audio-filename");
  const rawVideoFileName = req.headers.get("x-video-filename");

  if (rawAudioFileName) {
    const buffer = Buffer.from(await req.arrayBuffer());

    if (buffer.length === 0) {
      throw new Error("No audio data provided");
    }

    return {
      audioBase64: buffer.toString("base64"),
      mimeType: contentType || "audio/mpeg",
      audioPath: null,
      cleanupPath: null,
    };
  }

  if (rawVideoFileName) {
    const buffer = await req.arrayBuffer();
    const file = new File([buffer], decodeURIComponent(rawVideoFileName), {
      type: contentType || "application/octet-stream",
    });

    return extractAudioFromVideoFile(file);
  }

  if (contentType.includes("multipart/form-data")) {
    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      throw new Error("Failed to parse upload body. Please retry the video upload.");
    }

    const video = formData.get("video");

    if (!(video instanceof File)) {
      throw new Error("No video file provided");
    }

    return extractAudioFromVideoFile(video);
  }

  const { audioBase64, mimeType } = await req.json();

  if (!audioBase64) {
    throw new Error("No audio data provided");
  }

  return {
    audioBase64,
    mimeType: mimeType || "audio/wav",
    audioPath: null,
    cleanupPath: null,
  };
}

function normalizeLocalWord(segmentId: string, word: ParsedWord) {
  const text = typeof word.text === "string" ? word.text.trim() : typeof word.word === "string" ? word.word.trim() : "";
  if (!text) return null;

  const startTime = normalizeSeconds(word.startTime ?? word.start, Number.NaN);
  const endTime = normalizeSeconds(word.endTime ?? word.end, Number.NaN);
  const hasBoundaries = Number.isFinite(startTime) && Number.isFinite(endTime) && endTime > startTime;
  const aligned = typeof word.aligned === "boolean" ? word.aligned && hasBoundaries : hasBoundaries;

  const safeStart = hasBoundaries ? startTime : 0;
  const safeEnd = hasBoundaries ? endTime : safeStart;
  const startSample = normalizeSamples(word.startSample, aligned ? Math.round(safeStart * AUDIO_SAMPLE_RATE) : undefined);
  const endSample = normalizeSamples(word.endSample, aligned ? Math.round(safeEnd * AUDIO_SAMPLE_RATE) : undefined);

  return {
    id: uuid(),
    segmentId,
    text,
    startTime: safeStart,
    endTime: safeEnd,
    confidence:
      typeof word.confidence === "number"
        ? word.confidence
        : typeof word.score === "number"
        ? word.score
        : undefined,
    aligned,
    startSample,
    endSample,
  } satisfies NormalizedWord;
}

function normalizeLocalResponse(payload: unknown) {
  const parsed = payload as LocalSidecarResponse;
  if (!parsed || !Array.isArray(parsed.segments)) {
    throw new Error("Local WhisperX sidecar returned an invalid transcript payload.");
  }

  const segments = parsed.segments.reduce<NormalizedSegment[]>((accumulator, segment) => {
    const text = typeof segment.text === "string" ? segment.text.trim() : "";
    const startTime = normalizeSeconds(segment.startTime ?? segment.start, Number.NaN);
    const endTime = normalizeSeconds(segment.endTime ?? segment.end, Number.NaN);

    if (!text || !Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
      return accumulator;
    }

    const id = typeof segment.id === "string" && segment.id.trim() ? segment.id : uuid();
    const words = Array.isArray(segment.words)
      ? segment.words
          .flatMap((word) => {
            const normalized = normalizeLocalWord(id, word);
            return normalized ? [normalized] : [];
          })
          .sort((left, right) => left.startTime - right.startTime)
      : [];

    accumulator.push({
      id,
      startTime,
      endTime,
      text,
      words,
      alignmentSource: "whisperx",
      wordEditCapable: words.some((word) => word.aligned),
    });

    return accumulator;
  }, []);

  if (segments.length === 0) {
    throw new Error("Local WhisperX sidecar did not return any valid transcript segments.");
  }

  const pauses = Array.isArray(parsed.pauses)
    ? parsed.pauses.reduce<NormalizedPause[]>((accumulator, pause) => {
        const startTime = normalizeSeconds(pause.startTime ?? pause.start, Number.NaN);
        const endTime = normalizeSeconds(pause.endTime ?? pause.end, Number.NaN);
        const duration = normalizeSeconds(pause.duration, endTime - startTime);

        if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
          return accumulator;
        }

        accumulator.push({
          id: typeof pause.id === "string" && pause.id.trim() ? pause.id : uuid(),
          startTime,
          endTime,
          duration,
        });
        return accumulator;
      }, [])
    : [];

  return { segments, pauses };
}

async function checkLocalAlignerHealth() {
  try {
    const response = await fetch(`${LOCAL_ALIGNER_URL}/health`, { method: "GET", cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Health check returned ${response.status}`);
    }
  } catch (error) {
    console.error("Local aligner health check failed:", error);
    throw new Error(
      `Local WhisperX sidecar is unavailable at ${LOCAL_ALIGNER_URL}. Run "npm run sidecar:install" once, then "npm run dev:sidecar" and retry.`
    );
  }
}

async function transcribeWithLocalAligner(videoFile: File) {
  await checkLocalAlignerHealth();

  const formData = new FormData();
  formData.set("video", videoFile);

  const response = await fetch(`${LOCAL_ALIGNER_URL}/transcribe`, {
    method: "POST",
    body: formData,
    cache: "no-store",
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const detail =
      typeof payload?.detail === "string"
        ? payload.detail
        : typeof payload?.error === "string"
        ? payload.error
        : `Local WhisperX transcription failed (${response.status}).`;
    throw new Error(detail);
  }

  return normalizeLocalResponse(payload);
}

function normalizeGeminiSegments(payload: unknown) {
  const parsed = Array.isArray(payload)
    ? (payload as ParsedSegment[])
    : Array.isArray((payload as { segments?: ParsedSegment[] } | null)?.segments)
    ? ((payload as { segments: ParsedSegment[] }).segments)
    : [];

  return parsed.reduce<NormalizedSegment[]>((accumulator, segment) => {
    const text = typeof segment.text === "string" ? segment.text.trim() : "";
    const startTime = normalizeSeconds(segment.startTime ?? segment.start, Number.NaN);
    const endTime = normalizeSeconds(segment.endTime ?? segment.end, Number.NaN);

    if (!text || !Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
      return accumulator;
    }

    accumulator.push({
      id: uuid(),
      startTime,
      endTime,
      text,
      words: [],
      alignmentSource: "gemini",
      wordEditCapable: false,
    });

    return accumulator;
  }, []);
}

async function transcribeWithGemini(req: Request) {
  const { audioBase64, mimeType, audioPath, cleanupPath } = await getAudioPayload(req);

  if (!audioBase64) {
    return { segments: [] as NormalizedSegment[], pauses: [] as NormalizedPause[], cleanupPath };
  }

  const ai = getGeminiClient();
  const response = await ai.models.generateContent({
    model: MODELS.REASONING,
    contents: [
      {
        role: "user",
        parts: [
          {
            inlineData: {
              mimeType,
              data: audioBase64,
            },
          },
          {
            text: `Transcribe this audio with precise segment timestamps. Return ONLY valid JSON (no markdown fences, no extra text).

Format:
{
  "segments": [
    {
      "startTime": 0.0,
      "endTime": 5.2,
      "text": "spoken words here"
    }
  ]
}

Rules:
- Break into natural segments of roughly 3-10 seconds each
- startTime and endTime are in seconds as floating point numbers
- Timestamps must be accurate and non-overlapping
- Include all spoken words
- Each segment should be a complete thought or sentence when possible`,
          },
        ],
      },
    ],
  });

  const text = response.text?.trim() || "[]";
  const parsed = parseJsonResponse(text);
  const segments = normalizeGeminiSegments(parsed);
  const pauses = audioPath ? await detectPauseRanges(audioPath) : [];

  return { segments, pauses, cleanupPath };
}

export async function POST(req: Request) {
  let cleanupPath: string | null = null;

  try {
    if (TRANSCRIPTION_PROVIDER === "local") {
      const videoFile = await getVideoFile(req);
      const result = await transcribeWithLocalAligner(videoFile);
      return NextResponse.json(result);
    }

    const result = await transcribeWithGemini(req);
    cleanupPath = result.cleanupPath;
    return NextResponse.json({ segments: result.segments, pauses: result.pauses });
  } catch (error) {
    console.error("Transcription error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Transcription failed" },
      { status: 500 }
    );
  } finally {
    if (cleanupPath) {
      await rm(cleanupPath, { recursive: true, force: true });
    }
  }
}
