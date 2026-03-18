"use client";
import { useMemo } from "react";
import { LibraryClip } from "@/types";

interface MediaBinProps {
  clips: LibraryClip[];
  selectedClipId: string | null;
  onSelectClip: (clipId: string) => void;
  onImportRequest: () => void;
  searchDraft: string;
  activeSearchQuery: string;
  searchScores: Map<string, number>;
  isSearching: boolean;
  onSearchDraftChange: (value: string) => void;
  onSearchSubmit: () => void;
  onClearSearch: () => void;
}

function formatTime(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function statusClasses(status: LibraryClip["status"]) {
  switch (status) {
    case "ready":
      return "bg-emerald-500/10 text-emerald-300 border-emerald-400/20";
    case "processing":
      return "bg-amber-500/10 text-amber-300 border-amber-400/20";
    case "error":
      return "bg-red-500/10 text-red-300 border-red-400/20";
    default:
      return "bg-white/6 text-white/45 border-white/10";
  }
}

export default function MediaBin({
  clips,
  selectedClipId,
  onSelectClip,
  onImportRequest,
  searchDraft,
  activeSearchQuery,
  searchScores,
  isSearching,
  onSearchDraftChange,
  onSearchSubmit,
  onClearSearch,
}: MediaBinProps) {
  const hasActiveSearch = activeSearchQuery.trim().length > 0;

  const orderedClips = useMemo(() => {
    if (!hasActiveSearch) return clips;

    const originalIndexes = new Map(clips.map((clip, index) => [clip.id, index]));
    return [...clips].sort((left, right) => {
      const scoreDiff = (searchScores.get(right.id) ?? -1) - (searchScores.get(left.id) ?? -1);
      if (Math.abs(scoreDiff) > 0.0001) return scoreDiff;
      return (originalIndexes.get(left.id) ?? 0) - (originalIndexes.get(right.id) ?? 0);
    });
  }, [clips, hasActiveSearch, searchScores]);

  return (
    <aside className="flex h-full min-h-0 min-w-0 select-none flex-col overflow-hidden bg-[#141518]">
      <div className="flex min-w-0 items-center justify-between gap-3 border-b border-white/8 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] uppercase tracking-[0.22em] text-white/35">Project</p>
          <h2 className="mt-1 text-sm font-medium text-white/90">Media Bin</h2>
        </div>
        <button
          type="button"
          onClick={onImportRequest}
          className="inline-flex shrink-0 cursor-pointer items-center rounded-md border border-white/10 bg-white/6 px-2.5 py-1.5 text-[11px] font-medium text-white/80 transition hover:bg-white/10"
        >
          Import
        </button>
      </div>

      <div className="mx-3 mt-3 rounded-xl border border-white/8 bg-white/[0.03] px-3 py-4 transition">
        <p className="text-xs font-medium text-white/88">Drop clips here</p>
        <p className="mt-1 text-[11px] leading-5 text-white/40">
          Import multiple files from disk and drag ready clips into the timeline.
        </p>
      </div>

      <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="px-4 pb-3">
          <div className="flex min-w-0 flex-wrap gap-2">
            <input
              type="text"
              placeholder="Search transcript text..."
              value={searchDraft}
              onChange={(event) => onSearchDraftChange(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && onSearchSubmit()}
              className="min-w-0 flex-1 basis-40 rounded-lg border border-white/10 bg-white/[0.05] px-3 py-2 text-sm text-white placeholder:text-white/26 focus:border-sky-400/40 focus:outline-none"
            />
            <button
              onClick={onSearchSubmit}
              disabled={isSearching || !searchDraft.trim()}
              className="shrink-0 rounded-lg border border-white/10 bg-white/[0.06] px-3 py-2 text-xs font-medium text-white/82 transition hover:bg-white/[0.1] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isSearching ? "..." : "Search"}
            </button>
            {hasActiveSearch && (
              <button
                onClick={onClearSearch}
                className="shrink-0 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs font-medium text-white/60 transition hover:bg-white/[0.08] hover:text-white/82"
              >
                Clear
              </button>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-1.5 text-[10px] uppercase tracking-[0.18em] text-white/32">
              <span className="min-w-0 truncate">
                {hasActiveSearch ? `Results for "${activeSearchQuery}"` : "Transcript search"}
              </span>
              <span className="shrink-0">{hasActiveSearch ? `${searchScores.size} ranked clips` : "Search by spoken text"}</span>
          </div>
        </div>

        <div className="flex items-center justify-between px-4 pb-2">
          <span className="text-[10px] uppercase tracking-[0.22em] text-white/30">Clips</span>
          <span className="text-[11px] text-white/35">{clips.length} items</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          {clips.length === 0 ? (
            <div className="rounded-xl border border-dashed border-white/8 bg-white/[0.02] px-4 py-6 text-center text-[12px] text-white/38">
              Add a few clips to start building a sequence.
            </div>
          ) : (
            <div className="space-y-2">
              {orderedClips.map((clip) => {
                const isSelected = clip.id === selectedClipId;
                const searchScore = searchScores.get(clip.id);
                return (
                  <button
                    key={clip.id}
                    type="button"
                    draggable={clip.status === "ready"}
                    onDragStart={(event) => {
                      document.body.style.userSelect = "none";
                      event.dataTransfer.setData("application/x-vibecut-library-clip", clip.id);
                      event.dataTransfer.effectAllowed = "copy";
                    }}
                    onDragEnd={() => {
                      document.body.style.userSelect = "";
                    }}
                    onClick={() => onSelectClip(clip.id)}
                    className={`w-full rounded-xl border p-2 text-left transition ${
                      isSelected
                        ? "border-sky-400/40 bg-sky-400/10"
                        : "border-white/8 bg-white/[0.03] hover:bg-white/[0.06]"
                    }`}
                  >
                    <div className="flex gap-3">
                      <div className="h-14 w-20 shrink-0 overflow-hidden rounded-lg bg-black/50">
                        <video
                          src={clip.previewUrl || undefined}
                          muted
                          preload="metadata"
                          className="h-full w-full object-cover opacity-85"
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <p className="truncate text-[12px] font-medium text-white/88">{clip.fileName}</p>
                          <div className="flex shrink-0 items-center gap-1.5">
                            {hasActiveSearch && searchScore !== undefined && (
                              <span className="rounded-md border border-amber-400/20 bg-amber-400/10 px-1.5 py-1 text-[10px] uppercase tracking-[0.16em] text-amber-300">
                                {Math.round(searchScore * 100)}%
                              </span>
                            )}
                            <span
                              className={`rounded-md border px-1.5 py-1 text-[10px] uppercase tracking-[0.16em] ${statusClasses(clip.status)}`}
                            >
                              {clip.status}
                            </span>
                          </div>
                        </div>
                        <div className="mt-2 flex items-center justify-between text-[10px] uppercase tracking-[0.16em] text-white/32">
                          <span>{formatTime(clip.duration)}</span>
                          <span>{clip.transcriptSegments.length} segs</span>
                        </div>
                        {clip.error && (
                          <p className="mt-2 line-clamp-2 text-[11px] leading-4 text-red-300/80">{clip.error}</p>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
