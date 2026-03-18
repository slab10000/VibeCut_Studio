import type { ReactNode, RefObject } from "react";
import CommandInput from "@/components/CommandInput";
import TranscriptPanel from "@/components/TranscriptPanel";
import VibeFontPanel from "@/components/VibeFontPanel";
import type {
  DockTab,
  JobRecord,
  LibraryClip,
  PauseRange,
  SearchHit,
  SequenceItem,
  TranscriptSelection,
} from "@/shared/contracts";

interface InspectorRenderProps {
  selectedTimelineClip: SequenceItem | null;
  selectedSourceClip: LibraryClip | null;
  capabilitiesText: string[];
  jobs: JobRecord[];
  bootstrapError: string | null;
}

interface DockContext {
  videoRef: RefObject<HTMLVideoElement | null>;
  ai: {
    enabled: boolean;
    isProcessing: boolean;
    lastExplanation: string | null;
    onSubmit: (command: string) => void;
  };
  transcript: {
    clipName?: string;
    segments: LibraryClip["transcriptSegments"];
    pauses: PauseRange[];
    currentTime: number;
    canRetranscribe?: boolean;
    isRetranscribing?: boolean;
    selection: TranscriptSelection | null;
    activeRange?: { startTime: number; endTime: number } | null;
    onSeek: (time: number) => void;
    onRetranscribe?: () => void;
    onSelectionChange: (selection: TranscriptSelection | null) => void;
    onRemoveSelection: () => void;
    onRemoveSegment: (segmentId: string) => void;
    onRemovePause: (pauseId: string) => void;
    onRemoveLongPauses: (minimumDuration?: number) => void;
    activeSearchQuery?: string;
    searchResults: SearchHit[] | null;
  };
  inspector: InspectorRenderProps;
}

export interface DockFeatureManifest {
  id: DockTab;
  label: string;
  render: (context: DockContext) => ReactNode;
}

function formatTime(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function renderInspector({
  selectedTimelineClip,
  selectedSourceClip,
  capabilitiesText,
  jobs,
  bootstrapError,
}: InspectorRenderProps) {
  return (
    <div className="h-full min-w-0 overflow-y-auto overflow-x-hidden p-4 space-y-4">
      <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
        <p className="text-[10px] uppercase tracking-[0.22em] text-white/32">Selection</p>
        {selectedTimelineClip ? (
          <div className="mt-4 space-y-3">
            <div>
              <p className="text-sm font-medium text-white/86">
                {selectedTimelineClip.label || selectedSourceClip?.fileName || "Sequence clip"}
              </p>
              <p className="mt-1 text-xs text-white/38">
                {selectedTimelineClip.type === "image" ? "Still frame clip" : "Video clip"}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs text-white/48">
              <div className="rounded-xl border border-white/8 bg-black/10 p-3">
                <p className="text-[10px] uppercase tracking-[0.16em] text-white/28">In</p>
                <p className="mt-1 font-medium text-white/78">{formatTime(selectedTimelineClip.sourceStartTime)}</p>
              </div>
              <div className="rounded-xl border border-white/8 bg-black/10 p-3">
                <p className="text-[10px] uppercase tracking-[0.16em] text-white/28">Out</p>
                <p className="mt-1 font-medium text-white/78">{formatTime(selectedTimelineClip.sourceEndTime)}</p>
              </div>
              <div className="rounded-xl border border-white/8 bg-black/10 p-3">
                <p className="text-[10px] uppercase tracking-[0.16em] text-white/28">Duration</p>
                <p className="mt-1 font-medium text-white/78">{formatTime(selectedTimelineClip.duration)}</p>
              </div>
              <div className="rounded-xl border border-white/8 bg-black/10 p-3">
                <p className="text-[10px] uppercase tracking-[0.16em] text-white/28">Source</p>
                <p className="mt-1 truncate font-medium text-white/78">
                  {selectedTimelineClip.sourceClipId || "Generated"}
                </p>
              </div>
            </div>
          </div>
        ) : selectedSourceClip ? (
          <div className="mt-4 space-y-3">
            <div>
              <p className="text-sm font-medium text-white/86">{selectedSourceClip.fileName}</p>
              <p className="mt-1 text-xs text-white/38">Library clip</p>
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs text-white/48">
              <div className="rounded-xl border border-white/8 bg-black/10 p-3">
                <p className="text-[10px] uppercase tracking-[0.16em] text-white/28">Duration</p>
                <p className="mt-1 font-medium text-white/78">{formatTime(selectedSourceClip.duration)}</p>
              </div>
              <div className="rounded-xl border border-white/8 bg-black/10 p-3">
                <p className="text-[10px] uppercase tracking-[0.16em] text-white/28">Status</p>
                <p className="mt-1 font-medium capitalize text-white/78">{selectedSourceClip.status}</p>
              </div>
              <div className="rounded-xl border border-white/8 bg-black/10 p-3">
                <p className="text-[10px] uppercase tracking-[0.16em] text-white/28">Transcript</p>
                <p className="mt-1 font-medium text-white/78">{selectedSourceClip.transcriptSegments.length} segments</p>
              </div>
              <div className="rounded-xl border border-white/8 bg-black/10 p-3">
                <p className="text-[10px] uppercase tracking-[0.16em] text-white/28">Preview</p>
                <p className="mt-1 font-medium text-white/78">
                  {selectedSourceClip.proxyPath ? "Proxy ready" : "Source file"}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <p className="mt-4 text-sm leading-6 text-white/36">Select a library clip or timeline item to inspect it.</p>
        )}
      </div>

      <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
        <p className="text-[10px] uppercase tracking-[0.22em] text-white/32">Desktop Status</p>
        <div className="mt-4 space-y-2 text-sm text-white/68">
          {capabilitiesText.map((line) => (
            <p key={line}>{line}</p>
          ))}
          {bootstrapError && <p className="text-red-300">{bootstrapError}</p>}
        </div>
      </div>

      {jobs.length > 0 && (
        <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
          <p className="text-[10px] uppercase tracking-[0.22em] text-white/32">Jobs</p>
          <div className="mt-4 space-y-3">
            {jobs.map((job) => (
              <div key={job.id} className="rounded-xl border border-white/8 bg-black/10 p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium text-white/84">{job.kind}</p>
                  <span className="text-[10px] uppercase tracking-[0.16em] text-white/42">{job.status}</span>
                </div>
                <p className="mt-1 text-xs text-white/44">{job.message || job.targetId}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export const dockFeatureManifests: DockFeatureManifest[] = [
  {
    id: "ai",
    label: "AI Edit",
    render: ({ ai }) => (
      <div className="flex h-full min-h-0 min-w-0 flex-col">
        <div className="border-b border-white/8 px-4 py-3">
          <p className="text-sm font-medium text-white/84">Edit by intent</p>
          <p className="mt-1 text-xs leading-5 text-white/38">
            AI edit commands are optional and run through the desktop backend when configured.
          </p>
        </div>
        <div className="min-h-0 min-w-0 space-y-4 overflow-y-auto overflow-x-hidden p-4">
          {!ai.enabled && (
            <div className="rounded-2xl border border-amber-400/20 bg-amber-500/10 p-4 text-sm leading-6 text-amber-100/90">
              Gemini-backed generation is currently disabled. Local editing, transcript cleanup, and timeline work
              continue to function without an API key.
            </div>
          )}
          <CommandInput onSubmit={ai.onSubmit} isProcessing={ai.isProcessing || !ai.enabled} lastExplanation={ai.lastExplanation} />
        </div>
      </div>
    ),
  },
  {
    id: "transcript",
    label: "Transcript",
    render: ({ transcript }) => (
      <TranscriptPanel
        clipName={transcript.clipName}
        segments={transcript.segments}
        pauses={transcript.pauses}
        currentTime={transcript.currentTime}
        canRetranscribe={transcript.canRetranscribe}
        isRetranscribing={transcript.isRetranscribing}
        selection={transcript.selection}
        activeRange={transcript.activeRange}
        onSeek={transcript.onSeek}
        onRetranscribe={transcript.onRetranscribe}
        onSelectionChange={transcript.onSelectionChange}
        onRemoveSelection={transcript.onRemoveSelection}
        onRemoveSegment={transcript.onRemoveSegment}
        onRemovePause={transcript.onRemovePause}
        onRemoveLongPauses={transcript.onRemoveLongPauses}
        activeSearchQuery={transcript.activeSearchQuery}
        searchResults={transcript.searchResults}
      />
    ),
  },
  {
    id: "font",
    label: "Font",
    render: ({ videoRef }) => <VibeFontPanel videoRef={videoRef} />,
  },
  {
    id: "inspector",
    label: "Inspector",
    render: ({ inspector }) => renderInspector(inspector),
  },
];
