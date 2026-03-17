export type ClipProcessingStatus = "queued" | "processing" | "ready" | "error";
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
  alignmentSource?: "whisperx" | "gemini";
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

export interface LibraryClip {
  id: string;
  file: File;
  fileName: string;
  objectUrl: string;
  duration: number;
  status: ClipProcessingStatus;
  transcriptSegments: TranscriptSegment[];
  pauseRanges: PauseRange[];
  embeddingsReady: boolean;
  waveform: number[];
  error?: string;
}

export interface TimelineClip {
  id: string;
  type: "video" | "image";
  sourceClipId?: string;
  sourceStartTime: number;
  sourceEndTime: number;
  duration: number;
  label?: string;
  imageSrc?: string;
}

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
  | { type: "ADD_SOURCE_CLIP"; sourceClipId: string; duration: number; label?: string }
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
