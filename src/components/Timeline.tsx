"use client";
import { useMemo, useRef, useState, useCallback, useEffect } from "react";
import { LibraryClip, TimelineAction, TimelineClip } from "@/types";

interface TimelineProps {
  clips: TimelineClip[];
  libraryClips: LibraryClip[];
  totalDuration: number;
  currentTime: number;
  onSeek: (time: number) => void;
  onAppendFromLibrary: (sourceClipId: string) => void;
  dispatch: React.Dispatch<TimelineAction>;
  selectedClipId: string | null;
  onSelectClip: (id: string | null) => void;
}

type TimelineTool = "select" | "cut" | "trim";

function formatTime(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function renderWaveform(waveform: number[]) {
  return waveform.map((sample, index) => (
    <span
      key={`${index}-${sample}`}
      className="flex-1 rounded-full bg-sky-300/75"
      style={{ height: `${Math.max(14, sample * 100)}%` }}
    />
  ));
}

function renderToolIcon(tool: TimelineTool | "delete") {
  switch (tool) {
    case "select":
      return (
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M5 3.5v15.7c0 .6.7.9 1.2.5l3.7-3 2.4 4.5c.2.4.7.6 1.1.4l1.7-.9c.4-.2.6-.7.4-1.1l-2.4-4.5 4.8-.6c.7-.1.9-.9.3-1.3L5.8 3A.7.7 0 0 0 5 3.5Z" />
        </svg>
      );
    case "cut":
      return (
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <circle cx="6.5" cy="6.5" r="2.75" />
          <circle cx="6.5" cy="17.5" r="2.75" />
          <path strokeLinecap="round" d="M9 8.5 19 3.5M9 15.5l10 5M9 12h4" />
        </svg>
      );
    case "trim":
      return (
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path strokeLinecap="round" d="M7 4v16M17 4v16" />
          <path strokeLinecap="round" strokeLinejoin="round" d="m10 8-3 4 3 4M14 8l3 4-3 4" />
        </svg>
      );
    case "delete":
      return (
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path strokeLinecap="round" d="M4 7h16M9.5 11.5v5M14.5 11.5v5M9 4h6l1 2H8l1-2Z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M6.5 7 7.2 19a1 1 0 0 0 1 .9h7.6a1 1 0 0 0 1-.9L17.5 7" />
        </svg>
      );
  }
}

export default function Timeline({
  clips,
  libraryClips,
  totalDuration,
  currentTime,
  onSeek,
  onAppendFromLibrary,
  dispatch,
  selectedClipId,
  onSelectClip,
}: TimelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [activeTool, setActiveTool] = useState<TimelineTool>("select");
  const [dragState, setDragState] = useState<{
    type: "move" | "trim-start" | "trim-end";
    clipId: string;
    startX: number;
    originalClip: TimelineClip;
    clipIndex: number;
  } | null>(null);

  const clipsWithOffsets = useMemo(() => {
    return clips.reduce<
      Array<
        TimelineClip & {
          source?: LibraryClip;
          sequenceStart: number;
          sequenceEnd: number;
        }
      >
    >((accumulator, clip) => {
      const previousEnd = accumulator[accumulator.length - 1]?.sequenceEnd || 0;
      const sequenceEnd = previousEnd + clip.duration;
      const source = clip.sourceClipId ? libraryClips.find((item) => item.id === clip.sourceClipId) : undefined;

      accumulator.push({
        ...clip,
        source,
        sequenceStart: previousEnd,
        sequenceEnd,
      });

      return accumulator;
    }, []);
  }, [clips, libraryClips]);

  const timelineWidth = useMemo(() => Math.max(totalDuration * 88 * zoom, 840), [totalDuration, zoom]);

  const getTimeFromX = useCallback(
    (clientX: number) => {
      const container = containerRef.current;
      if (!container) return 0;
      const rect = container.getBoundingClientRect();
      const x = clientX - rect.left + container.scrollLeft;
      return clamp((x / timelineWidth) * totalDuration, 0, totalDuration);
    },
    [timelineWidth, totalDuration]
  );

  const scrubToPosition = useCallback(
    (clientX: number) => {
      onSeek(getTimeFromX(clientX));
    },
    [getTimeFromX, onSeek]
  );

  const startScrubbing = useCallback(
    (clientX: number) => {
      setIsScrubbing(true);
      scrubToPosition(clientX);
    },
    [scrubToPosition]
  );

  const handleDragMove = useCallback(
    (clientX: number) => {
      if (!dragState) return;

      const deltaX = clientX - dragState.startX;
      const deltaTime = (deltaX / timelineWidth) * totalDuration;
      const original = dragState.originalClip;

      if (dragState.type === "trim-start" && original.type === "video") {
        const newStart = clamp(original.sourceStartTime + deltaTime, 0, original.sourceEndTime - 0.1);
        dispatch({ type: "TRIM_CLIP", clipId: dragState.clipId, newStart, newEnd: original.sourceEndTime });
        return;
      }

      if (dragState.type === "trim-end" && original.type === "video") {
        const maxEnd = original.sourceClipId
          ? libraryClips.find((clip) => clip.id === original.sourceClipId)?.duration ?? original.sourceEndTime
          : original.sourceEndTime;
        const newEnd = clamp(original.sourceEndTime + deltaTime, original.sourceStartTime + 0.1, maxEnd);
        dispatch({ type: "TRIM_CLIP", clipId: dragState.clipId, newStart: original.sourceStartTime, newEnd });
        return;
      }

      const newIndex = clamp(dragState.clipIndex + Math.round(deltaX / 140), 0, Math.max(clips.length - 1, 0));
      if (newIndex !== dragState.clipIndex) {
        dispatch({ type: "REORDER_CLIP", fromIndex: dragState.clipIndex, toIndex: newIndex });
        setDragState((state) => (state ? { ...state, clipIndex: newIndex } : state));
      }
    },
    [clips.length, dispatch, dragState, libraryClips, timelineWidth, totalDuration]
  );

  useEffect(() => {
    if (!isScrubbing) return;

    const handleWindowMouseMove = (event: MouseEvent) => {
      scrubToPosition(event.clientX);
    };

    const handleWindowMouseUp = () => {
      setIsScrubbing(false);
    };

    window.addEventListener("mousemove", handleWindowMouseMove);
    window.addEventListener("mouseup", handleWindowMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleWindowMouseMove);
      window.removeEventListener("mouseup", handleWindowMouseUp);
    };
  }, [isScrubbing, scrubToPosition]);

  useEffect(() => {
    if (!dragState) return;

    const handleWindowMouseMove = (event: MouseEvent) => {
      handleDragMove(event.clientX);
    };

    const handleWindowMouseUp = () => {
      setDragState(null);
    };

    window.addEventListener("mousemove", handleWindowMouseMove);
    window.addEventListener("mouseup", handleWindowMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleWindowMouseMove);
      window.removeEventListener("mouseup", handleWindowMouseUp);
    };
  }, [dragState, handleDragMove]);

  useEffect(() => {
    if (!isScrubbing && !dragState) return;

    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    return () => {
      document.body.style.userSelect = previousUserSelect;
    };
  }, [dragState, isScrubbing]);

  const handleSplit = useCallback(() => {
    if (!selectedClipId) return;

    const activeClip = clipsWithOffsets.find((clip) => clip.id === selectedClipId);
    if (!activeClip || activeClip.type !== "video") return;

    const localOffset = currentTime - activeClip.sequenceStart;
    const splitTime = activeClip.sourceStartTime + localOffset;
    if (splitTime <= activeClip.sourceStartTime || splitTime >= activeClip.sourceEndTime) return;

    dispatch({ type: "SPLIT_CLIP", clipId: activeClip.id, splitTime });
  }, [clipsWithOffsets, currentTime, dispatch, selectedClipId]);

  const handleDelete = useCallback(() => {
    if (!selectedClipId) return;
    dispatch({ type: "DELETE_CLIP", clipId: selectedClipId });
    onSelectClip(null);
  }, [dispatch, onSelectClip, selectedClipId]);

  const handleCutClip = useCallback(
    (clipId: string, clientX: number) => {
      const clip = clipsWithOffsets.find((item) => item.id === clipId);
      if (!clip || clip.type !== "video") return;

      const element = containerRef.current?.querySelector<HTMLElement>(`[data-clip-id="${clipId}"]`);
      if (!element) return;

      const rect = element.getBoundingClientRect();
      const localRatio = clamp((clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
      const splitTime = clip.sourceStartTime + clip.duration * localRatio;

      if (splitTime <= clip.sourceStartTime + 0.05 || splitTime >= clip.sourceEndTime - 0.05) return;

      dispatch({ type: "SPLIT_CLIP", clipId, splitTime });
      onSelectClip(clipId);
    },
    [clipsWithOffsets, dispatch, onSelectClip]
  );

  const playheadX = totalDuration > 0 ? (currentTime / totalDuration) * timelineWidth : 0;

  const toolButtons: Array<{
    id: TimelineTool | "delete";
    title: string;
    disabled?: boolean;
  }> = [
    { id: "select", title: "Select and move clips" },
    { id: "cut", title: "Cut clips where you click" },
    { id: "trim", title: "Trim by dragging clip edges" },
    { id: "delete", title: "Remove selected clip", disabled: !selectedClipId },
  ];

  return (
    <div className="flex h-full min-h-0 min-w-0 select-none flex-col overflow-hidden rounded-2xl border border-white/8 bg-[#111215]">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-white/8 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] uppercase tracking-[0.22em] text-white/32">Sequence</p>
          <p className="mt-1 text-sm text-white/80">Build the cut by dragging clips from the media bin.</p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={handleSplit}
            disabled={!selectedClipId}
            className="rounded-lg border border-white/10 bg-white/[0.05] px-3 py-2 text-[11px] font-medium text-white/82 transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-35"
          >
            Split At Playhead
          </button>
          <div className="ml-2 flex items-center gap-2 rounded-lg border border-white/8 bg-white/[0.03] px-2 py-1.5">
            <button
              onClick={() => setZoom((value) => Math.max(0.35, value / 1.25))}
              className="text-xs text-white/55 transition hover:text-white/85"
            >
              -
            </button>
            <span className="w-12 text-center text-[11px] font-medium text-white/55">{Math.round(zoom * 100)}%</span>
            <button
              onClick={() => setZoom((value) => Math.min(4, value * 1.25))}
              className="text-xs text-white/55 transition hover:text-white/85"
            >
              +
            </button>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="w-12 shrink-0 border-r border-white/8 bg-[#0d0f12]">
          <div className="flex h-12 items-center justify-center border-b border-white/8">
            <span className="text-[9px] font-medium uppercase tracking-[0.24em] text-white/22">Tools</span>
          </div>
          <div className="flex flex-col items-center gap-2 px-2 py-3">
            {toolButtons.map((tool) => {
              const isActive = tool.id === activeTool;
              const isDelete = tool.id === "delete";

              return (
                <button
                  key={tool.id}
                  type="button"
                  title={tool.title}
                  disabled={tool.disabled}
                  onClick={() => {
                    if (tool.id === "delete") {
                      handleDelete();
                      return;
                    }

                    setActiveTool(tool.id);
                  }}
                  className={`flex h-9 w-9 items-center justify-center rounded-lg border text-[11px] font-semibold uppercase tracking-[0.16em] transition ${
                    isDelete
                      ? "border-red-400/20 bg-red-500/10 text-red-200 hover:bg-red-500/16"
                      : isActive
                      ? "border-sky-400/35 bg-sky-400/14 text-sky-100"
                      : "border-white/10 bg-white/[0.04] text-white/58 hover:bg-white/[0.08] hover:text-white/85"
                  } disabled:cursor-not-allowed disabled:opacity-35`}
                >
                  {renderToolIcon(tool.id)}
                </button>
              );
            })}
          </div>
        </div>

        <div className="w-16 shrink-0 border-r border-white/8 bg-[#0f1013]">
          <div className="h-12 border-b border-white/8" />
          <div className="flex h-[92px] items-center justify-center border-b border-white/8 text-xs font-medium uppercase tracking-[0.18em] text-white/42">
            V1
          </div>
          <div className="flex h-[92px] items-center justify-center text-xs font-medium uppercase tracking-[0.18em] text-white/42">
            A1
          </div>
        </div>

        <div
          ref={containerRef}
          className={`relative min-h-0 min-w-0 flex-1 overflow-auto ${
            isDropTarget ? "bg-sky-400/[0.03]" : "bg-[#15171b]"
          }`}
          onMouseDown={(event) => {
            if (event.button !== 0) return;
            if ((event.target as HTMLElement).closest("[data-clip]")) return;
            startScrubbing(event.clientX);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setIsDropTarget(true);
          }}
          onDragLeave={() => setIsDropTarget(false)}
          onDrop={(event) => {
            event.preventDefault();
            setIsDropTarget(false);
            const sourceClipId = event.dataTransfer.getData("application/x-vibecut-library-clip");
            if (sourceClipId) onAppendFromLibrary(sourceClipId);
          }}
        >
          <div className="relative" style={{ width: timelineWidth }}>
            <div className="relative h-12 border-b border-white/8 bg-[#121418]">
              {Array.from({ length: Math.ceil((totalDuration || 30) / 5) + 1 }).map((_, index) => {
                const markerTime = index * 5;
                const markerX = totalDuration > 0 ? (markerTime / totalDuration) * timelineWidth : index * 88 * zoom;
                return (
                  <div key={markerTime} className="absolute inset-y-0 border-l border-white/6" style={{ left: markerX }}>
                    <span className="absolute left-1 top-2 text-[10px] uppercase tracking-[0.16em] text-white/24">
                      {formatTime(markerTime)}
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="relative h-[92px] border-b border-white/8 bg-[linear-gradient(180deg,_rgba(255,255,255,0.02),_transparent)]">
              {clipsWithOffsets.map((clip, index) => {
                const widthPercent = totalDuration > 0 ? (clip.duration / totalDuration) * 100 : 0;
                const leftPercent = totalDuration > 0 ? (clip.sequenceStart / totalDuration) * 100 : 0;
                const isSelected = clip.id === selectedClipId;
                const title = clip.label || clip.source?.fileName || "Still";

                return (
                  <div
                    key={clip.id}
                    data-clip
                    data-clip-id={clip.id}
                    className={`absolute inset-y-3 overflow-hidden rounded-xl border transition ${
                      isSelected
                        ? "border-sky-400/55 bg-sky-400/20 shadow-[0_0_0_1px_rgba(56,189,248,0.15)]"
                        : "border-white/8 bg-[#2c4668] hover:border-white/18"
                    }`}
                    style={{ left: `${leftPercent}%`, width: `${widthPercent}%`, minWidth: 78 }}
                  >
                    {clip.type === "video" && (
                      <div
                        className={`absolute inset-y-0 left-0 z-10 flex w-4 cursor-col-resize items-center justify-center transition ${
                          activeTool === "trim" ? "bg-sky-300/12" : "bg-black/10 hover:bg-white/18"
                        }`}
                        onMouseDown={(event) => {
                          event.stopPropagation();
                          onSelectClip(clip.id);
                          setDragState({
                            type: "trim-start",
                            clipId: clip.id,
                            startX: event.clientX,
                            originalClip: clip,
                            clipIndex: index,
                          });
                        }}
                      >
                        <span className="h-7 w-0.5 rounded-full bg-white/45" />
                      </div>
                    )}

                    <button
                      type="button"
                      className="flex h-full w-full items-end justify-between px-3 py-2 text-left"
                      onMouseDown={(event) => {
                        event.stopPropagation();
                        onSelectClip(clip.id);
                        if (activeTool !== "select") return;
                        setDragState({
                          type: "move",
                          clipId: clip.id,
                          startX: event.clientX,
                          originalClip: clip,
                          clipIndex: index,
                        });
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelectClip(clip.id);
                        if (activeTool === "cut") {
                          handleCutClip(clip.id, event.clientX);
                        }
                      }}
                    >
                      <div className="min-w-0">
                        <p className="truncate text-[11px] font-medium text-white/92">{title}</p>
                        <p className="mt-1 text-[10px] uppercase tracking-[0.14em] text-white/44">
                          {clip.type === "image"
                            ? `still ${formatTime(clip.duration)}`
                            : `${formatTime(clip.sourceStartTime)} - ${formatTime(clip.sourceEndTime)}`}
                        </p>
                      </div>
                      <span className="ml-3 rounded-md bg-black/18 px-2 py-1 text-[10px] uppercase tracking-[0.14em] text-white/54">
                        {formatTime(clip.duration)}
                      </span>
                    </button>

                    {clip.type === "video" && (
                      <div
                        className={`absolute inset-y-0 right-0 z-10 flex w-4 cursor-col-resize items-center justify-center transition ${
                          activeTool === "trim" ? "bg-sky-300/12" : "bg-black/10 hover:bg-white/18"
                        }`}
                        onMouseDown={(event) => {
                          event.stopPropagation();
                          onSelectClip(clip.id);
                          setDragState({
                            type: "trim-end",
                            clipId: clip.id,
                            startX: event.clientX,
                            originalClip: clip,
                            clipIndex: index,
                          });
                        }}
                      >
                        <span className="h-7 w-0.5 rounded-full bg-white/45" />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="relative h-[92px] bg-[linear-gradient(180deg,_rgba(56,189,248,0.04),_transparent)]">
              {clipsWithOffsets.map((clip) => {
                const widthPercent = totalDuration > 0 ? (clip.duration / totalDuration) * 100 : 0;
                const leftPercent = totalDuration > 0 ? (clip.sequenceStart / totalDuration) * 100 : 0;
                const waveform = clip.source?.waveform || [];
                const isSelected = clip.id === selectedClipId;

                return (
                  <div
                    key={`${clip.id}-audio`}
                    className={`absolute inset-y-3 rounded-xl border ${
                      isSelected
                        ? "border-sky-400/45 bg-sky-500/10"
                        : "border-white/8 bg-[#17303f]"
                    }`}
                    style={{ left: `${leftPercent}%`, width: `${widthPercent}%`, minWidth: 78 }}
                  >
                    <div className="flex h-full items-center gap-[2px] overflow-hidden px-3 py-3">
                      {waveform.length > 0 ? (
                        renderWaveform(waveform)
                      ) : (
                        <div className="h-px w-full bg-sky-200/28" />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {clips.length === 0 && (
              <div className="pointer-events-none absolute inset-x-0 top-20 flex justify-center">
                <div className="rounded-full border border-dashed border-white/10 bg-white/[0.03] px-4 py-2 text-[11px] uppercase tracking-[0.18em] text-white/34">
                  Drop ready clips here to start the sequence
                </div>
              </div>
            )}

            <button
              type="button"
              aria-label="Drag playhead"
              className="absolute inset-y-0 z-20 w-5 -translate-x-1/2 cursor-ew-resize bg-transparent"
              style={{ left: playheadX }}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (event.button !== 0) return;
                startScrubbing(event.clientX);
              }}
            >
              <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-sky-400" />
              <span className="pointer-events-none absolute left-1/2 top-2 h-3 w-3 -translate-x-1/2 rotate-45 bg-sky-400" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
