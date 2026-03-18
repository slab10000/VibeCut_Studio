export type ClipProcessingStatus =
  | "queued"
  | "processing"
  | "ready"
  | "error"
  | "proxy_building"
  | "draft_transcript_ready"
  | "alignment_pending"
  | "alignment_ready"
  | "embedding_ready"
  | "hardware_encoder_unavailable";

export type TranscriptStatus =
  | "not_requested"
  | "queued"
  | "processing"
  | "draft_ready"
  | "alignment_pending"
  | "alignment_ready"
  | "error";

export type EmbeddingStatus =
  | "not_requested"
  | "queued"
  | "processing"
  | "embedding_ready"
  | "error";

export type MonitorMode = "source" | "program";
export type DockTab = "ai" | "transcript" | "inspector" | "font";

export interface TranscriptWord {
  id: string;
  sourceClipId: string;
  segmentId: string;
  text: string;
  startTime: number;
  endTime: number;
  confidence?: number;
  aligned: boolean;
  startSample?: number;
  endSample?: number;
}

export interface TranscriptSegment {
  id: string;
  sourceClipId: string;
  startTime: number;
  endTime: number;
  text: string;
  words: TranscriptWord[];
  embedding?: number[];
  alignmentSource?: "whisperx" | "gemini" | "local" | string;
  wordEditCapable: boolean;
}

export interface TranscriptSelection {
  sourceClipId: string;
  wordIds: string[];
  startTime: number;
  endTime: number;
  wordCount: number;
  hasUnalignedWords: boolean;
}

export interface PauseRange {
  id: string;
  sourceClipId: string;
  startTime: number;
  endTime: number;
  duration: number;
}

export interface MediaAsset {
  id: string;
  sourcePath: string;
  fingerprint: string;
  fileName: string;
  duration: number;
  durationMs: number;
  status: ClipProcessingStatus;
  transcriptStatus: TranscriptStatus;
  embeddingStatus: EmbeddingStatus;
  transcriptSegments: TranscriptSegment[];
  pauseRanges: PauseRange[];
  embeddingsReady: boolean;
  waveform: number[];
  previewPath?: string | null;
  thumbnailPath?: string | null;
  waveformPath?: string | null;
  proxyPath?: string | null;
  previewUrl?: string | null;
  videoCodec?: string | null;
  audioCodec?: string | null;
  width?: number | null;
  height?: number | null;
  hasAudio?: boolean;
  error?: string | null;
}

export type LibraryClip = MediaAsset;

export interface SequenceEffect {
  id: string;
  type: string;
  config?: Record<string, unknown>;
}

export interface SequenceItem {
  id: string;
  type: "video" | "image";
  sourceClipId?: string;
  sourceStartTime: number;
  sourceEndTime: number;
  duration: number;
  label?: string;
  imageSrc?: string;
  sequenceId?: string;
  track: number;
  timelineStartMs: number;
  durationMs: number;
  mediaId?: string;
  sourceInMs: number;
  playbackRate: number;
  enabled: boolean;
  kind: "video" | "image";
  effects: SequenceEffect[];
}

export type TimelineClip = SequenceItem;

export interface TimelineState {
  clips: TimelineClip[];
  totalDuration: number;
}

export interface TimelineRange {
  sourceClipId: string;
  startTime: number;
  endTime: number;
  label?: string;
}

export type TimelineAction =
  | {
      type: "ADD_SOURCE_CLIP";
      sourceClipId: string;
      duration: number;
      label?: string;
      pendingSourceDuration?: boolean;
    }
  | { type: "REMOVE_SEGMENTS"; segments: TranscriptSegment[] }
  | { type: "REMOVE_RANGES"; ranges: TimelineRange[] }
  | { type: "INSERT_IMAGE"; afterClipId: string | null; imageSrc: string; duration: number; label?: string }
  | { type: "APPLY_EDIT"; clips: TimelineClip[] }
  | { type: "SPLIT_CLIP"; clipId: string; splitTime: number }
  | { type: "TRIM_CLIP"; clipId: string; newStart: number; newEnd: number }
  | { type: "DELETE_CLIP"; clipId: string }
  | { type: "REORDER_CLIP"; fromIndex: number; toIndex: number }
  | { type: "SET_CLIPS"; clips: TimelineClip[] };

export interface EditRange {
  sourceClipId?: string;
  startTime: number;
  endTime: number;
}

export interface EditOperation {
  type: string;
  sourceClipId?: string;
  startTime?: number;
  endTime?: number;
  fromIndex?: number;
  toIndex?: number;
  ranges?: EditRange[];
  prompt?: string;
  duration?: number;
  afterTime?: number;
  reason?: string;
}

export interface EditCommandResponse {
  operations: EditOperation[];
  explanation: string;
}

export interface AppCapabilities {
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  sidecarAvailable: boolean;
  aiConfigured: boolean;
  hardwareEncoding: string[];
  projectPath: string;
  cachePath: string;
}

export interface ProjectSummary {
  projectId: string;
  name: string;
}

export interface ProjectSnapshot extends ProjectSummary {
  mediaAssets: MediaAsset[];
  sequenceItems: SequenceItem[];
}

export interface SearchHit {
  id: string;
  sourceClipId: string;
  score: number;
}

export interface JobEvent {
  id: string;
  kind: string;
  targetId: string;
  status: "queued" | "running" | "complete" | "error";
  progress: number;
  message?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface JobRecord extends JobEvent {
  targetKind?: string | null;
  result?: Record<string, unknown> | null;
  errorMessage?: string | null;
  fingerprint?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface EntityChangeEvent {
  entityType: "project" | "library" | "timeline" | "transcript" | "job" | "capabilities";
  entityId?: string | null;
  operation: "created" | "updated" | "deleted" | "refreshed";
}

export interface DesktopBootstrap {
  project: ProjectSnapshot;
  jobs: JobRecord[];
  capabilities: AppCapabilities;
}

export interface TranscriptResponse {
  asset: MediaAsset;
  jobs: JobRecord[];
}

export type TimelinePatch =
  | {
      kind: "replace_clips";
      clips: SequenceItem[];
    };

export interface AiImageResponse {
  imageBase64: string;
  mimeType: string;
}

export interface AiStyleSuggestion {
  style: string;
  typography: string;
}

export interface AiVideoResponse {
  videoPath: string;
}

export interface AiFontResponse {
  fontFamily: string;
  color: string;
  textShadow: string;
  cssFilter: string;
}
