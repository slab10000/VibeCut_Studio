"use client";
import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import {
  DockTab,
  EditCommandResponse,
  LibraryClip,
  MonitorMode,
  PauseRange,
  TimelineClip,
  TimelineRange,
  TranscriptSegment,
  TranscriptSelection,
} from "@/types";
import { cosineSimilarity } from "@/lib/embeddings";
import { useTimeline } from "@/hooks/useTimeline";
import { useTranscript } from "@/hooks/useTranscript";
import MediaBin from "./MediaBin";
import VideoPlayer from "./VideoPlayer";
import Timeline from "./Timeline";
import TranscriptPanel from "./TranscriptPanel";
import CommandInput from "./CommandInput";
import AssetGenPanel from "./AssetGenPanel";
import VibeFontPanel, { FontOverlayData } from "./VibeFontPanel";
import VibeTransitionPanel from "./VibeTransitionPanel";
import TextEditorBar from "./TextEditorBar";
import { v4 as uuid } from "uuid";

type SearchHit = { id: string; sourceClipId: string; score: number };
const ROOM_TONE_SECONDS = 0.12;
const DEFAULT_PAUSE_THRESHOLD_SECONDS = 0.4;
const LEFT_SIDEBAR_MIN_WIDTH = 240;
const LEFT_SIDEBAR_DEFAULT_WIDTH = 300;
const LEFT_SIDEBAR_MAX_WIDTH = 520;
const RIGHT_SIDEBAR_MIN_WIDTH = 280;
const RIGHT_SIDEBAR_DEFAULT_WIDTH = 360;
const RIGHT_SIDEBAR_MAX_WIDTH = 560;
const CENTER_PANEL_MIN_WIDTH = 720;
const RESIZE_HANDLE_WIDTH = 10;

type SidebarEdge = "left" | "right";

interface ResizeState {
  edge: SidebarEdge;
  startX: number;
  startLeftWidth: number;
  startRightWidth: number;
  containerWidth: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function formatTime(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function placeholderWaveform(seed: string, points = 36) {
  let hash = 0;
  for (let index = 0; index < seed.length; index++) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 9973;
  }

  return Array.from({ length: points }, (_, index) => {
    const value = Math.sin((hash + index * 13) / 11) * 0.18 + Math.cos((hash + index * 7) / 17) * 0.12;
    return clamp(0.28 + Math.abs(value), 0.18, 0.78);
  });
}

function buildWaveform(segments: TranscriptSegment[], duration: number, points = 36) {
  if (duration <= 0 || segments.length === 0) {
    return Array.from({ length: points }, () => 0.22);
  }

  const bins = Array.from({ length: points }, (_, index) => {
    const binStart = (index / points) * duration;
    const binEnd = ((index + 1) / points) * duration;

    let energy = 0;
    for (const segment of segments) {
      const overlap = Math.max(0, Math.min(segment.endTime, binEnd) - Math.max(segment.startTime, binStart));
      if (overlap <= 0) continue;
      energy += overlap / Math.max(duration / points, 0.25);
      energy += Math.min(segment.text.length / 120, 0.4);
    }

    return clamp(0.18 + Math.min(energy, 1.05) * 0.55, 0.18, 0.95);
  });

  return bins.map((value, index) => {
    const prev = bins[index - 1] ?? value;
    const next = bins[index + 1] ?? value;
    return clamp((prev + value * 2 + next) / 4, 0.18, 0.95);
  });
}

function buildTimelineClip(sourceClipId: string, startTime: number, endTime: number, label?: string): TimelineClip {
  return {
    id: uuid(),
    type: "video",
    sourceClipId,
    sourceStartTime: startTime,
    sourceEndTime: endTime,
    duration: Math.max(0, endTime - startTime),
    label,
  };
}

function getVideoDuration(objectUrl: string) {
  return new Promise<number>((resolve, reject) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.src = objectUrl;
    video.onloadedmetadata = () => resolve(video.duration || 0);
    video.onerror = () => reject(new Error("Failed to load clip metadata"));
  });
}

function mergeTimelineRanges(ranges: TimelineRange[]) {
  const mergedBySource = new Map<string, TimelineRange[]>();

  for (const range of ranges) {
    if (range.endTime <= range.startTime) continue;
    const nextRanges = [...(mergedBySource.get(range.sourceClipId) || []), range].sort(
      (a, b) => a.startTime - b.startTime
    );

    const merged: TimelineRange[] = [];
    for (const item of nextRanges) {
      const previous = merged[merged.length - 1];
      if (!previous || item.startTime > previous.endTime + 0.02) {
        merged.push({ ...item });
        continue;
      }

      previous.endTime = Math.max(previous.endTime, item.endTime);
    }

    mergedBySource.set(range.sourceClipId, merged);
  }

  return Array.from(mergedBySource.values()).flat();
}

function trimPauseForRoomTone(
  pause: PauseRange,
  bounds?: { startTime: number; endTime: number } | null,
  roomToneSeconds = ROOM_TONE_SECONDS
) {
  const boundedStart = bounds ? Math.max(bounds.startTime, pause.startTime) : pause.startTime;
  const boundedEnd = bounds ? Math.min(bounds.endTime, pause.endTime) : pause.endTime;
  const boundedDuration = boundedEnd - boundedStart;

  if (boundedDuration <= roomToneSeconds) return null;

  const sidePadding = roomToneSeconds / 2;
  const startTime = boundedStart + sidePadding;
  const endTime = boundedEnd - sidePadding;

  if (endTime <= startTime) return null;

  return {
    sourceClipId: pause.sourceClipId,
    startTime,
    endTime,
  };
}

function SidebarResizeHandle({
  edge,
  isActive,
  onPointerDown,
}: {
  edge: SidebarEdge;
  isActive: boolean;
  onPointerDown: (edge: SidebarEdge, event: React.PointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={edge === "left" ? "Resize media bin" : "Resize dock"}
      onPointerDown={(event) => onPointerDown(edge, event)}
      className="group relative flex h-full min-h-0 cursor-col-resize items-stretch justify-center touch-none select-none bg-[#0d0e12]"
    >
      <div
        className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition ${
          isActive ? "bg-sky-400/70" : "bg-white/8 group-hover:bg-white/18"
        }`}
      />
      <div
        className={`my-3 w-2 rounded-full transition ${
          isActive ? "bg-sky-400/16" : "bg-transparent group-hover:bg-white/[0.04]"
        }`}
      />
    </div>
  );
}

export default function Editor() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const editorColumnsRef = useRef<HTMLDivElement>(null);
  const monitorModeRef = useRef<MonitorMode>("source");
  const activeProgramClipRef = useRef<string | null>(null);
  const libraryClipsRef = useRef<LibraryClip[]>([]);
  const sourceTimeRef = useRef(0);
  const programTimeRef = useRef(0);

  const [libraryClips, setLibraryClips] = useState<LibraryClip[]>([]);
  const [selectedSourceClipId, setSelectedSourceClipId] = useState<string | null>(null);
  const [selectedTimelineClipId, setSelectedTimelineClipId] = useState<string | null>(null);
  const [monitorMode, setMonitorMode] = useState<MonitorMode>("source");
  const [dockTab, setDockTab] = useState<DockTab>("ai");
  const [transcriptSelection, setTranscriptSelection] = useState<TranscriptSelection | null>(null);
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(LEFT_SIDEBAR_DEFAULT_WIDTH);
  const [rightSidebarWidth, setRightSidebarWidth] = useState(RIGHT_SIDEBAR_DEFAULT_WIDTH);
  const [resizeState, setResizeState] = useState<ResizeState | null>(null);
  const [searchDraft, setSearchDraft] = useState("");
  const [activeSearchQuery, setActiveSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchHit[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [isEditProcessing, setIsEditProcessing] = useState(false);
  const [lastExplanation, setLastExplanation] = useState<string | null>(null);
  const [programTime, setProgramTime] = useState(0);
  const [sourceTime, setSourceTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeFontOverlay, setActiveFontOverlay] = useState<FontOverlayData | null>(null);
  const [showTextEditor, setShowTextEditor] = useState(false);
  const [showTransitionPanel, setShowTransitionPanel] = useState(false);
  const [hasHydrated, setHasHydrated] = useState(false);

  useEffect(() => {
    setHasHydrated(true);
  }, []);

  const [timelineHeight, setTimelineHeight] = useState(320);
  const dragRef = useRef<{ isDragging: boolean; startY: number; startHeight: number }>({ isDragging: false, startY: 0, startHeight: 0 });

  const { timeline, dispatch } = useTimeline();
  const { activeJobs, error: transcriptError, transcribe, embedTexts } = useTranscript();

  const clipsWithOffsets = useMemo(() => {
    let sequenceStart = 0;
    return timeline.clips.map((clip) => {
      const start = sequenceStart;
      const end = start + clip.duration;
      sequenceStart = end;
      const source = clip.sourceClipId ? libraryClips.find((item) => item.id === clip.sourceClipId) : undefined;
      return {
        ...clip,
        source,
        sequenceStart: start,
        sequenceEnd: end,
      };
    });
  }, [timeline.clips, libraryClips]);

  const selectedSourceClip = useMemo(
    () => libraryClips.find((clip) => clip.id === selectedSourceClipId) || null,
    [libraryClips, selectedSourceClipId]
  );

  const selectedTimelineClip = useMemo(
    () => timeline.clips.find((clip) => clip.id === selectedTimelineClipId) || null,
    [selectedTimelineClipId, timeline.clips]
  );

  const transcriptSourceClipId = selectedTimelineClip?.sourceClipId || selectedSourceClipId;
  const transcriptClip = useMemo(
    () => libraryClips.find((clip) => clip.id === transcriptSourceClipId) || null,
    [libraryClips, transcriptSourceClipId]
  );

  const allTranscriptSegments = useMemo(
    () => libraryClips.flatMap((clip) => clip.transcriptSegments),
    [libraryClips]
  );

  const searchableSegments = useMemo(
    () => allTranscriptSegments.filter((segment) => segment.embedding),
    [allTranscriptSegments]
  );

  const segmentLookup = useMemo(
    () => new Map(allTranscriptSegments.map((segment) => [segment.id, segment])),
    [allTranscriptSegments]
  );

  const processingCount = useMemo(
    () => libraryClips.filter((clip) => clip.status === "queued" || clip.status === "processing").length,
    [libraryClips]
  );

  const clipSearchScores = useMemo(() => {
    const scores = new Map<string, number>();
    for (const result of searchResults || []) {
      const current = scores.get(result.sourceClipId) ?? -1;
      if (result.score > current) scores.set(result.sourceClipId, result.score);
    }
    return scores;
  }, [searchResults]);

  const currentProgramPlacement = useMemo(() => {
    if (clipsWithOffsets.length === 0) return null;
    const clampedTime = clamp(programTime, 0, Math.max(timeline.totalDuration - 0.001, 0));
    return (
      clipsWithOffsets.find(
        (clip) => clampedTime >= clip.sequenceStart && clampedTime < clip.sequenceEnd
      ) || clipsWithOffsets[clipsWithOffsets.length - 1]
    );
  }, [clipsWithOffsets, programTime, timeline.totalDuration]);

  const activeTranscriptTime = useMemo(() => {
    if (!transcriptClip) return 0;

    if (selectedTimelineClip?.sourceClipId === transcriptClip.id && selectedTimelineClip.type === "video") {
      if (monitorMode === "program" && currentProgramPlacement?.id === selectedTimelineClip.id) {
        return selectedTimelineClip.sourceStartTime + (programTime - currentProgramPlacement.sequenceStart);
      }
      return selectedTimelineClip.sourceStartTime;
    }

    if (monitorMode === "source" && selectedSourceClipId === transcriptClip.id) {
      return sourceTime;
    }

    if (monitorMode === "program" && currentProgramPlacement?.sourceClipId === transcriptClip.id) {
      return currentProgramPlacement.sourceStartTime + (programTime - currentProgramPlacement.sequenceStart);
    }

    return 0;
  }, [
    currentProgramPlacement,
    monitorMode,
    programTime,
    selectedSourceClipId,
    selectedTimelineClip,
    sourceTime,
    transcriptClip,
  ]);

  const selectedTranscriptRange = useMemo(
    () =>
      selectedTimelineClip?.sourceClipId === transcriptSourceClipId && selectedTimelineClip.type === "video"
        ? { startTime: selectedTimelineClip.sourceStartTime, endTime: selectedTimelineClip.sourceEndTime }
        : null,
    [selectedTimelineClip, transcriptSourceClipId]
  );

  const transcriptPauses = useMemo(() => {
    if (!transcriptClip) return [] as PauseRange[];

    return transcriptClip.pauseRanges.filter((pause) => {
      if (!selectedTranscriptRange) return true;
      return pause.endTime > selectedTranscriptRange.startTime && pause.startTime < selectedTranscriptRange.endTime;
    });
  }, [selectedTranscriptRange, transcriptClip]);

  const monitorVideoUrl =
    monitorMode === "source"
      ? selectedSourceClip?.objectUrl || null
      : currentProgramPlacement?.type === "video"
      ? currentProgramPlacement.source?.objectUrl || null
      : null;

  const monitorImageSrc =
    monitorMode === "program" && currentProgramPlacement?.type === "image"
      ? currentProgramPlacement.imageSrc || null
      : null;

  const monitorCurrentTime = monitorMode === "program" ? programTime : sourceTime;
  const monitorDuration = monitorMode === "program" ? timeline.totalDuration : selectedSourceClip?.duration || 0;

  const monitorSubtitle =
    monitorMode === "source"
      ? selectedSourceClip?.fileName
      : currentProgramPlacement?.label || currentProgramPlacement?.source?.fileName || "Sequence monitor";

  const setClipState = useCallback((clipId: string, updater: (clip: LibraryClip) => LibraryClip) => {
    setLibraryClips((clips) => clips.map((clip) => (clip.id === clipId ? updater(clip) : clip)));
  }, []);

  const setVideoSource = useCallback((url: string, targetTime: number, autoplay: boolean) => {
    const video = videoRef.current;
    if (!video) return;

    const seekAndPlay = () => {
      const apply = () => {
        try {
          video.currentTime = Math.max(0, targetTime);
        } catch {
          // Ignore seek errors while metadata is still settling.
        }

        if (autoplay) {
          void video.play().catch(() => {
            setIsPlaying(false);
          });
        }
      };

      if (video.readyState >= 1) apply();
      else video.addEventListener("loadedmetadata", apply, { once: true });
    };

    if (video.src !== url) {
      video.pause();
      video.src = url;
      video.load();
      seekAndPlay();
      return;
    }

    seekAndPlay();
  }, []);

  const syncProgramPreview = useCallback(
    (time: number, autoplay: boolean) => {
      const clampedTime = clamp(time, 0, Math.max(timeline.totalDuration, 0));
      setProgramTime(clampedTime);

      const activeClip =
        clipsWithOffsets.find(
          (clip) => clampedTime >= clip.sequenceStart && clampedTime < clip.sequenceEnd
        ) || clipsWithOffsets[clipsWithOffsets.length - 1];

      activeProgramClipRef.current = activeClip?.id || null;

      if (!activeClip) {
        videoRef.current?.pause();
        setIsPlaying(false);
        return;
      }

      if (activeClip.type === "image") {
        videoRef.current?.pause();
        setIsPlaying(false);
        return;
      }

      if (!activeClip.source) return;

      const localTime = activeClip.sourceStartTime + (clampedTime - activeClip.sequenceStart);
      setVideoSource(activeClip.source.objectUrl, localTime, autoplay);
    },
    [clipsWithOffsets, setVideoSource, timeline.totalDuration]
  );

  const syncSourcePreview = useCallback(
    (clip: LibraryClip | null, time: number, autoplay: boolean) => {
      if (!clip) {
        videoRef.current?.pause();
        setIsPlaying(false);
        return;
      }

      setSourceTime(clamp(time, 0, clip.duration || 0));
      setVideoSource(clip.objectUrl, clamp(time, 0, clip.duration || 0), autoplay);
    },
    [setVideoSource]
  );

  const processLibraryClip = useCallback(
    async (clip: LibraryClip) => {
      setClipState(clip.id, (current) => ({ ...current, status: "processing", error: undefined }));

      try {
        const { segments: transcriptSegments, pauses } = await transcribe(clip.file, clip.id);
        const embeddings = await embedTexts(transcriptSegments.map((segment) => segment.text));
        const hydratedSegments = transcriptSegments.map((segment, index) => ({
          ...segment,
          embedding: embeddings[index] || undefined,
        }));
        const waveform = buildWaveform(hydratedSegments, clip.duration);

        setClipState(clip.id, (current) => ({
          ...current,
          status: "ready",
          transcriptSegments: hydratedSegments,
          pauseRanges: pauses,
          embeddingsReady: true,
          waveform,
        }));
      } catch (error) {
        setClipState(clip.id, (current) => ({
          ...current,
          status: "error",
          error: error instanceof Error ? error.message : "Failed to process clip",
        }));
      }
    },
    [embedTexts, setClipState, transcribe]
  );

  const handleAddFiles = useCallback(
    async (files: File[]) => {
      const prepared = await Promise.all(
        files.map(async (file) => {
          const objectUrl = URL.createObjectURL(file);
          let duration = 0;
          try {
            duration = await getVideoDuration(objectUrl);
          } catch {
            duration = 0;
          }

          return {
            id: uuid(),
            file,
            fileName: file.name,
            objectUrl,
            duration,
            status: "queued" as const,
            transcriptSegments: [],
            pauseRanges: [],
            embeddingsReady: false,
            waveform: placeholderWaveform(file.name),
          };
        })
      );

      if (prepared.length === 0) return;

      setLibraryClips((clips) => [...clips, ...prepared]);
      setSelectedSourceClipId((current) => current || prepared[0].id);
      setDockTab("transcript");

      for (const clip of prepared) {
        void processLibraryClip(clip);
      }
    },
    [processLibraryClip]
  );

  const handleSelectSourceClip = useCallback(
    (clipId: string) => {
      setSelectedSourceClipId(clipId);
      setSelectedTimelineClipId(null);
      setMonitorMode("source");
      setDockTab("transcript");

      const clip = libraryClips.find((item) => item.id === clipId) || null;
      syncSourcePreview(clip, 0, false);
    },
    [libraryClips, syncSourcePreview]
  );

  const handleSelectTimelineClip = useCallback(
    (clipId: string | null) => {
      setSelectedTimelineClipId(clipId);
      if (!clipId) return;

      const clip = clipsWithOffsets.find((item) => item.id === clipId);
      if (!clip) return;

      if (clip.sourceClipId) setSelectedSourceClipId(clip.sourceClipId);
      setMonitorMode("program");
      setDockTab("inspector");
      syncProgramPreview(clip.sequenceStart, false);
    },
    [clipsWithOffsets, syncProgramPreview]
  );

  const handleAppendFromLibrary = useCallback(
    (sourceClipId: string) => {
      const sourceClip = libraryClips.find((clip) => clip.id === sourceClipId);
      if (!sourceClip || sourceClip.status !== "ready") return;

      dispatch({
        type: "ADD_SOURCE_CLIP",
        sourceClipId: sourceClip.id,
        duration: sourceClip.duration,
        label: sourceClip.fileName,
      });

      setSelectedSourceClipId(sourceClip.id);
      setMonitorMode("program");
    },
    [dispatch, libraryClips]
  );

  const handleSearch = useCallback(
    async (query: string) => {
      const trimmedQuery = query.trim();
      if (!trimmedQuery) {
        setActiveSearchQuery("");
        setSearchResults(null);
        return;
      }

      setActiveSearchQuery(trimmedQuery);

      if (searchableSegments.length === 0) {
        setSearchResults([]);
        setDockTab("transcript");
        return;
      }

      setIsSearching(true);
      try {
        const res = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: trimmedQuery }),
        });

        if (!res.ok) throw new Error("Search failed");

        const { embedding } = await res.json();
        const results = searchableSegments
          .map((segment) => ({
            id: segment.id,
            sourceClipId: segment.sourceClipId,
            score: cosineSimilarity(embedding, segment.embedding!),
          }))
          .sort((a, b) => b.score - a.score);

        setSearchResults(results);
        setDockTab("transcript");

        const topResult = results[0];
        if (topResult) {
          setSelectedSourceClipId(topResult.sourceClipId);
          setSelectedTimelineClipId(null);
          setMonitorMode("source");
          const segment = segmentLookup.get(topResult.id);
          const clip = libraryClips.find((item) => item.id === topResult.sourceClipId) || null;
          if (segment && clip) syncSourcePreview(clip, segment.startTime, false);
        }
      } catch (error) {
        console.error(error);
      } finally {
        setIsSearching(false);
      }
    },
    [libraryClips, searchableSegments, segmentLookup, syncSourcePreview]
  );

  const handleSearchSubmit = useCallback(() => {
    void handleSearch(searchDraft);
  }, [handleSearch, searchDraft]);

  const handleClearSearch = useCallback(() => {
    setSearchDraft("");
    setActiveSearchQuery("");
    setSearchResults(null);
  }, []);

  const handleResizeStart = useCallback(
    (edge: SidebarEdge, event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();

      const container = editorColumnsRef.current;
      if (!container) return;

      setResizeState({
        edge,
        startX: event.clientX,
        startLeftWidth: leftSidebarWidth,
        startRightWidth: rightSidebarWidth,
        containerWidth: container.getBoundingClientRect().width,
      });
    },
    [leftSidebarWidth, rightSidebarWidth]
  );

  const handleTranscriptSelectionChange = useCallback((selection: TranscriptSelection | null) => {
    setTranscriptSelection((current) => {
      if (
        current?.sourceClipId === selection?.sourceClipId &&
        current?.startTime === selection?.startTime &&
        current?.endTime === selection?.endTime &&
        current?.wordCount === selection?.wordCount &&
        current?.hasUnalignedWords === selection?.hasUnalignedWords &&
        current?.wordIds.join("|") === selection?.wordIds.join("|")
      ) {
        return current;
      }

      return selection;
    });
  }, []);

  const handleRemoveTranscriptSelection = useCallback(() => {
    if (!transcriptSelection || transcriptSelection.hasUnalignedWords) return;
    if (transcriptSelection.endTime <= transcriptSelection.startTime) return;

    dispatch({
      type: "REMOVE_RANGES",
      ranges: [
        {
          sourceClipId: transcriptSelection.sourceClipId,
          startTime: transcriptSelection.startTime,
          endTime: transcriptSelection.endTime,
        },
      ],
    });
    setTranscriptSelection(null);
    setMonitorMode("program");
  }, [dispatch, transcriptSelection]);

  const handleRemoveTranscriptSegment = useCallback(
    (segmentId: string) => {
      const segment = transcriptClip?.transcriptSegments.find((item) => item.id === segmentId);
      if (!segment) return;

      dispatch({ type: "REMOVE_SEGMENTS", segments: [segment] });
      setTranscriptSelection(null);
      setMonitorMode("program");
    },
    [dispatch, transcriptClip]
  );

  const handleRemovePause = useCallback(
    (pauseId: string) => {
      const pause = transcriptPauses.find((item) => item.id === pauseId);
      if (!pause) return;

      const range = trimPauseForRoomTone(pause, selectedTranscriptRange);
      if (!range) return;

      dispatch({ type: "REMOVE_RANGES", ranges: [range] });
      setMonitorMode("program");
    },
    [dispatch, selectedTranscriptRange, transcriptPauses]
  );

  const handleRemoveLongPauses = useCallback(
    (minimumDuration = DEFAULT_PAUSE_THRESHOLD_SECONDS) => {
      const ranges = mergeTimelineRanges(
        transcriptPauses
          .filter((pause) => pause.duration >= minimumDuration)
          .map((pause) => trimPauseForRoomTone(pause, selectedTranscriptRange))
          .filter((range): range is TimelineRange => Boolean(range))
      );

      if (ranges.length === 0) return;

      dispatch({ type: "REMOVE_RANGES", ranges });
      setMonitorMode("program");
    },
    [dispatch, selectedTranscriptRange, transcriptPauses]
  );

  const handleInsertImage = useCallback(
    (imageSrc: string) => {
      const lastClip = selectedTimelineClipId
        ? timeline.clips.find((clip) => clip.id === selectedTimelineClipId) || null
        : timeline.clips[timeline.clips.length - 1] || null;

      dispatch({
        type: "INSERT_IMAGE",
        afterClipId: lastClip?.id || null,
        imageSrc,
        duration: 3,
        label: "AI still",
      });
      setMonitorMode("program");
    },
    [dispatch, selectedTimelineClipId, timeline.clips]
  );

  const handleEditCommand = useCallback(
    async (command: string) => {
      if (timeline.clips.length === 0) return;

      setIsEditProcessing(true);
      setLastExplanation(null);

      try {
        const activeSourceIds = new Set(
          timeline.clips
            .filter((clip) => clip.type === "video" && clip.sourceClipId)
            .map((clip) => clip.sourceClipId!)
        );

        const transcript = libraryClips
          .filter((clip) => activeSourceIds.has(clip.id))
          .flatMap((clip) =>
            clip.transcriptSegments.map((segment) => ({
              id: segment.id,
              sourceClipId: segment.sourceClipId,
              startTime: segment.startTime,
              endTime: segment.endTime,
              text: segment.text,
            }))
          );

        const res = await fetch("/api/edit-command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            command,
            transcript,
            timeline: {
              clips: clipsWithOffsets.map((clip, index) => ({
                id: clip.id,
                index,
                type: clip.type,
                label: clip.label || clip.source?.fileName || "Still",
                sourceClipId: clip.sourceClipId,
                sourceStartTime: clip.sourceStartTime,
                sourceEndTime: clip.sourceEndTime,
                sequenceStart: clip.sequenceStart,
                sequenceEnd: clip.sequenceEnd,
                duration: clip.duration,
              })),
              totalDuration: timeline.totalDuration,
            },
          }),
        });

        if (!res.ok) throw new Error("Edit command failed");
        const data: EditCommandResponse = await res.json();
        setLastExplanation(data.explanation);

        for (const operation of data.operations) {
          if (operation.type === "remove_time_range") {
            if (operation.startTime === undefined || operation.endTime === undefined || !operation.sourceClipId) continue;
            dispatch({
              type: "REMOVE_RANGES",
              ranges: [
                {
                  sourceClipId: operation.sourceClipId,
                  startTime: operation.startTime,
                  endTime: operation.endTime,
                },
              ],
            });
            continue;
          }

          if (operation.type === "keep_only_ranges" && operation.ranges) {
            const nextClips = operation.ranges
              .filter((range) => range.sourceClipId && range.endTime > range.startTime)
              .map((range) => {
                const source = libraryClips.find((clip) => clip.id === range.sourceClipId);
                return buildTimelineClip(range.sourceClipId!, range.startTime, range.endTime, source?.fileName);
              });

            if (nextClips.length > 0) dispatch({ type: "APPLY_EDIT", clips: nextClips });
            continue;
          }

          if (operation.type === "insert_image" && operation.prompt) {
            const imgRes = await fetch("/api/generate-image", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ prompt: operation.prompt }),
            });

            if (!imgRes.ok) continue;

            const { imageBase64, mimeType } = await imgRes.json();
            const src = `data:${mimeType};base64,${imageBase64}`;

            let afterClipId: string | null = null;
            if (operation.afterTime !== undefined) {
              const afterTime = operation.afterTime;
              const clip = clipsWithOffsets.find(
                (item) => afterTime >= item.sequenceStart && afterTime <= item.sequenceEnd
              );
              afterClipId = clip?.id || clipsWithOffsets[clipsWithOffsets.length - 1]?.id || null;
            }

            dispatch({
              type: "INSERT_IMAGE",
              afterClipId,
              imageSrc: src,
              duration: operation.duration || 3,
              label: "AI still",
            });
            continue;
          }

          if (
            operation.type === "reorder" &&
            operation.fromIndex !== undefined &&
            operation.toIndex !== undefined
          ) {
            dispatch({
              type: "REORDER_CLIP",
              fromIndex: operation.fromIndex,
              toIndex: operation.toIndex,
            });
          }
        }

        setMonitorMode("program");
      } catch (error) {
        console.error(error);
        setLastExplanation("Failed to process command. Please try again.");
      } finally {
        setIsEditProcessing(false);
      }
    },
    [clipsWithOffsets, dispatch, libraryClips, timeline.clips, timeline.totalDuration]
  );

  const handleMonitorSeek = useCallback(
    (time: number) => {
      if (monitorMode === "program") {
        syncProgramPreview(time, false);
        return;
      }

      syncSourcePreview(selectedSourceClip, time, false);
    },
    [monitorMode, selectedSourceClip, syncProgramPreview, syncSourcePreview]
  );

  const handleTimelineSeek = useCallback(
    (time: number) => {
      setMonitorMode("program");
      syncProgramPreview(time, false);
    },
    [syncProgramPreview]
  );

  const handleTranscriptSeek = useCallback(
    (time: number) => {
      if (!transcriptClip) return;
      setSelectedSourceClipId(transcriptClip.id);
      setSelectedTimelineClipId(null);
      setMonitorMode("source");
      syncSourcePreview(transcriptClip, time, false);
    },
    [syncSourcePreview, transcriptClip]
  );

  const handleTogglePlay = useCallback(() => {
    const video = videoRef.current;

    if (monitorMode === "source") {
      if (!selectedSourceClip) return;
      if (!video || video.paused) {
        syncSourcePreview(selectedSourceClip, sourceTime, true);
      } else {
        video.pause();
      }
      return;
    }

    if (!timeline.clips.length) return;
    if (currentProgramPlacement?.type === "image") {
      return;
    }

    if (!video || video.paused) {
      syncProgramPreview(programTime, true);
    } else {
      video.pause();
    }
  }, [
    currentProgramPlacement?.type,
    monitorMode,
    programTime,
    selectedSourceClip,
    sourceTime,
    syncProgramPreview,
    syncSourcePreview,
    timeline.clips.length,
  ]);

  useEffect(() => {
    monitorModeRef.current = monitorMode;
  }, [monitorMode]);

  useEffect(() => {
    activeProgramClipRef.current = currentProgramPlacement?.id || null;
  }, [currentProgramPlacement]);

  useEffect(() => {
    libraryClipsRef.current = libraryClips;
  }, [libraryClips]);

  useEffect(() => {
    sourceTimeRef.current = sourceTime;
  }, [sourceTime]);

  useEffect(() => {
    programTimeRef.current = programTime;
  }, [programTime]);

  useEffect(() => {
    if (!resizeState) return;

    const handlePointerMove = (event: PointerEvent) => {
      const delta = event.clientX - resizeState.startX;

      if (resizeState.edge === "left") {
        const maxLeftWidth = Math.min(
          LEFT_SIDEBAR_MAX_WIDTH,
          Math.max(
            LEFT_SIDEBAR_MIN_WIDTH,
            resizeState.containerWidth -
              resizeState.startRightWidth -
              RESIZE_HANDLE_WIDTH * 2 -
              CENTER_PANEL_MIN_WIDTH
          )
        );

        setLeftSidebarWidth(clamp(resizeState.startLeftWidth + delta, LEFT_SIDEBAR_MIN_WIDTH, maxLeftWidth));
        return;
      }

      const maxRightWidth = Math.min(
        RIGHT_SIDEBAR_MAX_WIDTH,
        Math.max(
          RIGHT_SIDEBAR_MIN_WIDTH,
          resizeState.containerWidth -
            resizeState.startLeftWidth -
            RESIZE_HANDLE_WIDTH * 2 -
            CENTER_PANEL_MIN_WIDTH
        )
      );

      setRightSidebarWidth(clamp(resizeState.startRightWidth - delta, RIGHT_SIDEBAR_MIN_WIDTH, maxRightWidth));
    };

    const handlePointerUp = () => {
      setResizeState(null);
    };

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [resizeState]);

  useEffect(() => {
    setTranscriptSelection(null);
  }, [transcriptSourceClipId]);

  useEffect(() => {
    if (monitorMode !== "source") return;
    syncSourcePreview(selectedSourceClip, sourceTimeRef.current, false);
  }, [monitorMode, selectedSourceClip, syncSourcePreview]);

  useEffect(() => {
    if (monitorMode !== "program" || timeline.clips.length === 0) return;
    syncProgramPreview(clamp(programTimeRef.current, 0, Math.max(timeline.totalDuration, 0)), false);
  }, [monitorMode, syncProgramPreview, timeline.clips, timeline.totalDuration]);

  useEffect(() => {
    if (timeline.clips.length === 0) {
      setProgramTime(0);
      if (monitorMode === "program") setIsPlaying(false);
      return;
    }

    if (monitorMode === "program" && programTime > timeline.totalDuration) {
      syncProgramPreview(timeline.totalDuration, false);
    }
  }, [monitorMode, programTime, syncProgramPreview, timeline.clips.length, timeline.totalDuration]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onTimeUpdate = () => {
      if (monitorModeRef.current === "source") {
        setSourceTime(video.currentTime);
        return;
      }

      const activeClip = clipsWithOffsets.find((clip) => clip.id === activeProgramClipRef.current);
      if (!activeClip || activeClip.type !== "video") return;

      const nextSequenceTime = activeClip.sequenceStart + (video.currentTime - activeClip.sourceStartTime);
      if (video.currentTime >= activeClip.sourceEndTime - 0.04) {
        const nextClip = clipsWithOffsets.find((clip) => clip.sequenceStart >= activeClip.sequenceEnd - 0.0001);
        if (!nextClip) {
          setProgramTime(timeline.totalDuration);
          video.pause();
          return;
        }

        syncProgramPreview(nextClip.sequenceStart, !video.paused);
        return;
      }

      setProgramTime(nextSequenceTime);
    };

    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);

    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);

    return () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
    };
  }, [clipsWithOffsets, syncProgramPreview, timeline.totalDuration]);

  useEffect(() => {
    return () => {
      for (const clip of libraryClipsRef.current) {
        URL.revokeObjectURL(clip.objectUrl);
      }
    };
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragRef.current.isDragging) return;
      const delta = e.clientY - dragRef.current.startY;
      setTimelineHeight(Math.max(150, dragRef.current.startHeight - delta));
    };

    const handleMouseUp = () => {
      if (dragRef.current.isDragging) {
        dragRef.current.isDragging = false;
        document.body.style.cursor = "default";
        document.body.style.userSelect = "";
      }
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  if (!hasHydrated) return <div className="h-screen bg-[#0b0c0f]" />;

  return (
    <div className="vibecut-shell flex h-screen min-w-0 flex-col overflow-hidden bg-[#0b0c0f] text-white">
      <header className="flex items-center justify-between border-b border-white/8 bg-[#111215] px-5 py-3">
        <div className="flex items-center gap-4">
          <div>
            <p className="text-[10px] uppercase tracking-[0.24em] text-white/28">Workspace</p>
            <h1 className="mt-1 text-lg font-semibold text-white/92">VibeCut Studio</h1>
          </div>
          <div className="hidden h-8 w-px bg-white/8 md:block" />
          <div className="hidden gap-4 text-[11px] uppercase tracking-[0.18em] text-white/34 md:flex">
            <span>{libraryClips.length} clips</span>
            <span>{timeline.clips.length} sequence items</span>
            <span>{formatTime(timeline.totalDuration)}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {(processingCount > 0 || activeJobs > 0) && (
            <div className="rounded-full border border-amber-400/18 bg-amber-500/10 px-3 py-1.5 text-[11px] font-medium text-amber-200">
              Processing {processingCount || activeJobs} clip{processingCount === 1 || activeJobs === 1 ? "" : "s"}
            </div>
          )}
          {transcriptError && (
            <div className="rounded-full border border-red-400/18 bg-red-500/10 px-3 py-1.5 text-[11px] font-medium text-red-200">
              {transcriptError}
            </div>
          )}
        </div>
      </header>

      <div
        ref={editorColumnsRef}
        className={`grid min-h-0 min-w-0 flex-1 overflow-hidden ${resizeState ? "select-none" : ""}`}
        style={{
          gridTemplateColumns: `${leftSidebarWidth}px ${RESIZE_HANDLE_WIDTH}px minmax(0,1fr) ${RESIZE_HANDLE_WIDTH}px ${rightSidebarWidth}px`,
        }}
      >
        <MediaBin
          clips={libraryClips}
          selectedClipId={selectedSourceClipId}
          onSelectClip={handleSelectSourceClip}
          onAddFiles={handleAddFiles}
          searchDraft={searchDraft}
          activeSearchQuery={activeSearchQuery}
          searchScores={clipSearchScores}
          isSearching={isSearching}
          onSearchDraftChange={setSearchDraft}
          onSearchSubmit={handleSearchSubmit}
          onClearSearch={handleClearSearch}
        />

        <SidebarResizeHandle
          edge="left"
          isActive={resizeState?.edge === "left"}
          onPointerDown={handleResizeStart}
        />

        <main className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-[#0d0e12]">
          <section className="flex min-h-[250px] flex-1 flex-col overflow-hidden p-4">
            <div className="mb-3 flex shrink-0 min-w-0 items-center justify-between gap-3">
              <div className="inline-flex rounded-xl border border-white/8 bg-[#131419] p-1">
                {(["source", "program"] as MonitorMode[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => {
                      setMonitorMode(mode);
                      if (mode === "source") syncSourcePreview(selectedSourceClip, sourceTime, false);
                      else syncProgramPreview(programTime, false);
                    }}
                    className={`rounded-lg px-4 py-2 text-xs font-medium uppercase tracking-[0.18em] transition ${
                      monitorMode === mode
                        ? "bg-sky-400 text-black"
                        : "text-white/45 hover:text-white/78"
                    }`}
                  >
                    {mode}
                  </button>
                ))}
              </div>

              <div className="hidden shrink-0 text-xs uppercase tracking-[0.2em] text-white/28 lg:block">
                {monitorMode === "source" ? "Media preview" : "Sequence preview"}
              </div>
            </div>

            <VideoPlayer
              videoRef={videoRef}
              videoUrl={monitorVideoUrl}
              imageSrc={monitorImageSrc}
              isPlaying={isPlaying}
              currentTime={monitorCurrentTime}
              duration={monitorDuration}
              title={monitorMode === "source" ? "Source" : "Program"}
              subtitle={monitorSubtitle}
              emptyLabel={monitorMode === "source" ? "Select a clip from the media bin" : "Build a sequence to preview it"}
              onTogglePlay={handleTogglePlay}
              onSeek={handleMonitorSeek}
              fontOverlay={activeFontOverlay}
            />
          </section>

          <div
            className="group relative z-10 flex h-3 w-full cursor-row-resize items-center justify-center -my-1.5 hover:bg-white/5 transition"
            onMouseDown={(e: React.MouseEvent) => {
              e.preventDefault();
              dragRef.current = {
                isDragging: true,
                startY: e.clientY,
                startHeight: timelineHeight,
              };
              document.body.style.cursor = "row-resize";
              document.body.style.userSelect = "none";
            }}
          >
            <div className="h-[2px] w-12 rounded-full bg-white/20 transition group-hover:bg-sky-400/80" />
          </div>

          <section 
            style={{ flexBasis: `${timelineHeight}px` }}
            className="min-h-[150px] shrink overflow-hidden p-4 pt-1"
          >
            <Timeline
              clips={timeline.clips}
              libraryClips={libraryClips}
              totalDuration={timeline.totalDuration}
              currentTime={programTime}
              onSeek={handleTimelineSeek}
              onAppendFromLibrary={handleAppendFromLibrary}
              dispatch={dispatch}
              selectedClipId={selectedTimelineClipId}
              onSelectClip={handleSelectTimelineClip}
            />
          </section>
        </main>

        <SidebarResizeHandle
          edge="right"
          isActive={resizeState?.edge === "right"}
          onPointerDown={handleResizeStart}
        />

        <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-[#141518]">
          <div className="border-b border-white/8 px-4 py-3">
            <p className="text-[10px] uppercase tracking-[0.22em] text-white/32">Dock</p>
            <div className="mt-3 grid grid-cols-3 rounded-xl border border-white/8 bg-white/[0.03] p-1">
              {([
                { id: "ai", label: "AI Edit" },
                { id: "transcript", label: "Transcript" },
                { id: "font", label: "Font" },
                { id: "inspector", label: "Inspector" },
              ] as { id: DockTab; label: string }[]).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setDockTab(tab.id)}
                  title={tab.label}
                  className={`min-w-0 truncate rounded-lg px-1.5 py-2 text-[10px] font-medium uppercase tracking-[0.12em] transition ${
                    dockTab === tab.id
                      ? "bg-sky-400 text-black"
                      : "text-white/42 hover:text-white/78"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
            {dockTab === "ai" && (
              <div className="flex h-full min-h-0 min-w-0 flex-col">
                <div className="border-b border-white/8 px-4 py-3">
                  <p className="text-sm font-medium text-white/84">Edit by intent</p>
                  <p className="mt-1 text-xs leading-5 text-white/38">
                    Run natural-language edits against the current sequence.
                  </p>
                </div>
                <div className="min-h-0 min-w-0 space-y-4 overflow-y-auto overflow-x-hidden p-4">
                  <CommandInput
                    onSubmit={handleEditCommand}
                    isProcessing={isEditProcessing}
                    lastExplanation={lastExplanation}
                  />
                  <button
                    onClick={() => setShowTransitionPanel(true)}
                    className="flex w-full items-center gap-2.5 rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2.5 text-xs text-sky-400 transition hover:bg-sky-500/10"
                  >
                    <div className="flex h-5 w-5 items-center justify-center rounded-full bg-sky-400/20">
                      <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                    </div>
                    <div className="text-left font-medium">AI Vibe Transition</div>
                  </button>
                  <AssetGenPanel onInsertImage={handleInsertImage} onAddFiles={handleAddFiles} />
                </div>
              </div>
            )}

            {dockTab === "transcript" && (
              <TranscriptPanel
                clipName={transcriptClip?.fileName}
                segments={transcriptClip?.transcriptSegments || []}
                pauses={transcriptPauses}
                currentTime={activeTranscriptTime}
                selection={transcriptSelection}
                activeRange={selectedTranscriptRange}
                onSeek={handleTranscriptSeek}
                onSelectionChange={handleTranscriptSelectionChange}
                onRemoveSelection={handleRemoveTranscriptSelection}
                onRemoveSegment={handleRemoveTranscriptSegment}
                onRemovePause={handleRemovePause}
                onRemoveLongPauses={handleRemoveLongPauses}
                activeSearchQuery={activeSearchQuery}
                searchResults={searchResults}
              />
            )}

            {dockTab === "font" && (
              <VibeFontPanel
                videoRef={videoRef}
                onApplyFont={(overlay) => {
                  setActiveFontOverlay(overlay);
                  setMonitorMode("program");
                }}
                onAddFiles={handleAddFiles}
              />
            )}

            {dockTab === "inspector" && (
              <div className="h-full min-w-0 overflow-y-auto overflow-x-hidden p-4 space-y-4">
                <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
                  <div className="flex items-center justify-between mb-4">
                    <p className="text-[10px] uppercase tracking-[0.22em] text-white/32">Selection</p>
                    <button 
                      onClick={() => setShowTextEditor(!showTextEditor)}
                      className={`rounded-lg px-3 py-1 text-[10px] font-bold uppercase tracking-wider transition ${
                        showTextEditor ? "bg-sky-400 text-black" : "bg-white/10 text-white hover:bg-white/20"
                      }`}
                    >
                      {showTextEditor ? "Close Editor" : "Add Custom Text"}
                    </button>
                  </div>
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
                          <p className="mt-1 font-medium text-white/78">
                            {formatTime(selectedTimelineClip.sourceStartTime)}
                          </p>
                        </div>
                        <div className="rounded-xl border border-white/8 bg-black/10 p-3">
                          <p className="text-[10px] uppercase tracking-[0.16em] text-white/28">Out</p>
                          <p className="mt-1 font-medium text-white/78">
                            {formatTime(selectedTimelineClip.sourceEndTime)}
                          </p>
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
                          <p className="mt-1 font-medium text-white/78">
                            {selectedSourceClip.transcriptSegments.length} segments
                          </p>
                        </div>
                        <div className="rounded-xl border border-white/8 bg-black/10 p-3">
                          <p className="text-[10px] uppercase tracking-[0.16em] text-white/28">Embeddings</p>
                          <p className="mt-1 font-medium text-white/78">
                            {selectedSourceClip.embeddingsReady ? "Ready" : "Pending"}
                          </p>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-4 text-sm leading-6 text-white/36">
                      Select a library clip or timeline item to inspect it.
                    </p>
                  )}
                </div>

                {showTextEditor && (
                  <TextEditorBar 
                    initialData={activeFontOverlay}
                    onApply={(overlay) => {
                      setActiveFontOverlay(overlay);
                      setMonitorMode("program");
                    }}
                  />
                )}
              </div>
            )}
          </div>
        </aside>
      </div>

      {showTransitionPanel && (
        <div className="fixed bottom-24 left-8 z-[100] w-full max-w-sm pointer-events-none">
          <div className="pointer-events-auto">
            <VibeTransitionPanel
              onCancel={() => setShowTransitionPanel(false)}
              onTransitionGenerated={async (videoUri) => {
                const clipId = uuid();
                const actualDuration = await getVideoDuration(videoUri).catch(() => 2);
                const file = new File([], "ai_transition.mp4", { type: "video/mp4" });
                const clip: LibraryClip = {
                  id: clipId,
                  file,
                  fileName: "AI Vibe Transition",
                  objectUrl: videoUri,
                  duration: actualDuration, 
                  status: "ready",
                  transcriptSegments: [],
                  pauseRanges: [],
                  embeddingsReady: false,
                  waveform: Array.from({ length: 36 }, () => 0.5),
                };
                setLibraryClips((prev) => [...prev, clip]);
                setShowTransitionPanel(false);
                dispatch({
                  type: "ADD_SOURCE_CLIP",
                  sourceClipId: clipId,
                  duration: clip.duration,
                  label: "AI Transition",
                });
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
