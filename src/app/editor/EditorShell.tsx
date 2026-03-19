"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { v4 as uuid } from "uuid";
import MediaBin from "@/components/MediaBin";
import Timeline from "@/components/Timeline";
import VideoPlayer from "@/components/VideoPlayer";
import { dockFeatureManifests } from "@/features/registry/dock-manifests";
import { parseAiEditResult, useEnqueueAiEditMutation } from "@/features/ai/api";
import { useEnqueueExportMutation, pickSavePath } from "@/features/export/api";
import {
  listenForFileDrop,
  pickVideoPaths,
  useImportMediaMutation,
  useLibraryQuery,
  useRemoveMediaMutation,
} from "@/features/library/api";
import { useJobsQuery } from "@/features/jobs/api";
import { usePlaybackStore } from "@/features/playback/store/playback-store";
import { useCapabilitiesQuery, useProjectQuery } from "@/features/project/api";
import { useSessionStore } from "@/features/session/store/session-store";
import { searchTranscript, useEnqueueTranscriptMutation, useTranscriptQuery } from "@/features/transcript/api";
import { useApplyTimelinePatchMutation, useTimelineQuery } from "@/features/timeline/api";
import { useTimelineEditor } from "@/features/timeline/hooks/useTimelineEditor";
import type {
  EditCommandResponse,
  LibraryClip,
  MonitorMode,
  PauseRange,
  SearchHit,
  TimelineAction,
  TimelineClip,
  TimelineRange,
  TranscriptSelection,
} from "@/shared/contracts";
import { useDesktopEvents } from "@/shared/desktop/useDesktopEvents";

const ROOM_TONE_SECONDS = 0.12;
const DEFAULT_PAUSE_THRESHOLD_SECONDS = 0.4;
const SEEK_TOLERANCE_SECONDS = 0.08;
const PENDING_SOURCE_DURATION_EFFECT = "pending_source_duration";
const PENDING_TIMELINE_CLIP_DURATION_SECONDS = 1;
const PREVIEW_PANEL_MIN_HEIGHT = 250;
const TIMELINE_PANEL_MIN_HEIGHT = 180;
const TIMELINE_PANEL_AUTO_HEIGHT = 320;
const TIMELINE_PANEL_MAX_HEIGHT = 520;
const PANEL_RESIZE_HANDLE_HEIGHT = 4;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function formatTime(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function getErrorMessage(error: unknown) {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message.trim()) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return "Failed to import media.";
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
    track: 0,
    timelineStartMs: 0,
    durationMs: Math.round(Math.max(0, endTime - startTime) * 1000),
    mediaId: sourceClipId,
    sourceInMs: Math.round(startTime * 1000),
    playbackRate: 1,
    enabled: true,
    kind: "video",
    effects: [],
  };
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

export default function EditorShell() {
  useDesktopEvents();

  const videoRef = useRef<HTMLVideoElement>(null);
  const centerColumnRef = useRef<HTMLElement>(null);
  const monitorModeRef = useRef<MonitorMode>("source");
  const activeProgramClipRef = useRef<string | null>(null);
  const transcriptionQueueRef = useRef(new Set<string>());
  const lastPersistedTimelineRef = useRef("");
  const handledAiJobRef = useRef<string | null>(null);

  const [leftPanelWidth, setLeftPanelWidth] = useState(300);
  const [rightPanelWidth, setRightPanelWidth] = useState(360);
  const [timelineHeightPreference, setTimelineHeightPreference] = useState<number | null>(null);
  const [maxTimelineHeight, setMaxTimelineHeight] = useState(320);
  type PanelDrag =
    | { panel: "left" | "right"; startX: number; startWidth: number }
    | { panel: "timeline"; startY: number; startHeight: number };
  const panelDragRef = useRef<PanelDrag | null>(null);
  const minimumTimelineHeight = Math.min(TIMELINE_PANEL_MIN_HEIGHT, maxTimelineHeight);
  const resolvedTimelineHeight =
    timelineHeightPreference === null
      ? clamp(TIMELINE_PANEL_AUTO_HEIGHT, minimumTimelineHeight, maxTimelineHeight)
      : clamp(timelineHeightPreference, minimumTimelineHeight, maxTimelineHeight);

  useEffect(() => {
    const element = centerColumnRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;

    const updateMaxTimelineHeight = () => {
      const availableHeight = element.clientHeight - PREVIEW_PANEL_MIN_HEIGHT - PANEL_RESIZE_HANDLE_HEIGHT;
      setMaxTimelineHeight(clamp(availableHeight, 0, TIMELINE_PANEL_MAX_HEIGHT));
    };

    updateMaxTimelineHeight();

    const observer = new ResizeObserver(() => {
      updateMaxTimelineHeight();
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const drag = panelDragRef.current;
      if (!drag) return;
      if (drag.panel === "left") {
        setLeftPanelWidth(clamp(drag.startWidth + (e.clientX - drag.startX), 200, 520));
      } else if (drag.panel === "right") {
        setRightPanelWidth(clamp(drag.startWidth - (e.clientX - drag.startX), 220, 520));
      } else if (drag.panel === "timeline") {
        setTimelineHeightPreference(
          clamp(drag.startHeight - (e.clientY - drag.startY), minimumTimelineHeight, maxTimelineHeight)
        );
      }
    };
    const onMouseUp = () => { panelDragRef.current = null; };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, [maxTimelineHeight, minimumTimelineHeight]);

  const selectedSourceClipId = useSessionStore((state) => state.selectedSourceClipId);
  const selectedTimelineClipId = useSessionStore((state) => state.selectedTimelineClipId);
  const dockTab = useSessionStore((state) => state.dockTab);
  const searchDraft = useSessionStore((state) => state.searchDraft);
  const activeSearchQuery = useSessionStore((state) => state.activeSearchQuery);
  const transcriptSelection = useSessionStore((state) => state.transcriptSelection);
  const lastExplanation = useSessionStore((state) => state.lastExplanation);
  const pendingAiEditJobId = useSessionStore((state) => state.pendingAiEditJobId);
  const isDraggingOver = useSessionStore((state) => state.isDraggingOver);
  const bootstrapError = useSessionStore((state) => state.bootstrapError);
  const setSelectedSourceClipId = useSessionStore((state) => state.setSelectedSourceClipId);
  const setSelectedTimelineClipId = useSessionStore((state) => state.setSelectedTimelineClipId);
  const setDockTab = useSessionStore((state) => state.setDockTab);
  const setSearchDraft = useSessionStore((state) => state.setSearchDraft);
  const setActiveSearchQuery = useSessionStore((state) => state.setActiveSearchQuery);
  const setTranscriptSelection = useSessionStore((state) => state.setTranscriptSelection);
  const setLastExplanation = useSessionStore((state) => state.setLastExplanation);
  const setPendingAiEditJobId = useSessionStore((state) => state.setPendingAiEditJobId);
  const setIsDraggingOver = useSessionStore((state) => state.setIsDraggingOver);
  const setBootstrapError = useSessionStore((state) => state.setBootstrapError);

  const monitorMode = usePlaybackStore((state) => state.monitorMode);
  const programTime = usePlaybackStore((state) => state.programTime);
  const sourceTime = usePlaybackStore((state) => state.sourceTime);
  const isPlaying = usePlaybackStore((state) => state.isPlaying);
  const setMonitorMode = usePlaybackStore((state) => state.setMonitorMode);
  const setProgramTime = usePlaybackStore((state) => state.setProgramTime);
  const setSourceTime = usePlaybackStore((state) => state.setSourceTime);
  const setIsPlaying = usePlaybackStore((state) => state.setIsPlaying);

  const [searchResults, setSearchResults] = useState<SearchHit[] | null>(null);

  const projectQuery = useProjectQuery();
  const libraryQuery = useLibraryQuery();
  const timelineQuery = useTimelineQuery();
  const jobsQuery = useJobsQuery();
  const capabilitiesQuery = useCapabilitiesQuery();
  const importMediaMutation = useImportMediaMutation();
  const removeMediaMutation = useRemoveMediaMutation();
  const applyTimelinePatchMutation = useApplyTimelinePatchMutation();
  const enqueueTranscriptMutation = useEnqueueTranscriptMutation();
  const enqueueAiEditMutation = useEnqueueAiEditMutation();
  const enqueueExportMutation = useEnqueueExportMutation();

  const libraryClips = libraryQuery.data || [];
  const serverTimelineClips = useMemo(() => timelineQuery.data || [], [timelineQuery.data]);
  const { timeline, dispatch: dispatchTimeline, dispatchWithUndo, undo } = useTimelineEditor(serverTimelineClips);
  const jobs = jobsQuery.data || [];
  const capabilities = capabilitiesQuery.data || null;

  const selectedSourceClip = useMemo(
    () => libraryClips.find((clip) => clip.id === selectedSourceClipId) || null,
    [libraryClips, selectedSourceClipId]
  );

  const selectedTimelineClip = useMemo(
    () => timeline.clips.find((clip) => clip.id === selectedTimelineClipId) || null,
    [selectedTimelineClipId, timeline.clips]
  );

  const transcriptSourceClipId = selectedTimelineClip?.sourceClipId || selectedSourceClipId;
  const transcriptQuery = useTranscriptQuery(transcriptSourceClipId);
  const transcriptClip =
    transcriptQuery.data ||
    libraryClips.find((clip) => clip.id === transcriptSourceClipId) ||
    null;

  const processingCount = useMemo(
    () => libraryClips.filter((clip) => clip.status === "queued" || clip.status === "processing").length,
    [libraryClips]
  );

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
      clipsWithOffsets.find((clip) => clampedTime >= clip.sequenceStart && clampedTime < clip.sequenceEnd) ||
      clipsWithOffsets[clipsWithOffsets.length - 1]
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

  const timelineSourceRanges = useMemo(() => {
    if (!transcriptSourceClipId) return [];
    return timeline.clips
      .filter((clip) => clip.type === "video" && clip.sourceClipId === transcriptSourceClipId)
      .map((clip) => ({ startTime: clip.sourceStartTime, endTime: clip.sourceEndTime }))
      .sort((a, b) => a.startTime - b.startTime);
  }, [timeline.clips, transcriptSourceClipId]);

  const transcriptPauses = useMemo(() => {
    if (!transcriptClip) return [] as PauseRange[];

    return transcriptClip.pauseRanges.filter((pause) => {
      if (!selectedTranscriptRange) return true;
      return pause.endTime > selectedTranscriptRange.startTime && pause.startTime < selectedTranscriptRange.endTime;
    });
  }, [selectedTranscriptRange, transcriptClip]);

  const monitorVideoUrl =
    monitorMode === "source"
      ? selectedSourceClip?.previewUrl || null
      : currentProgramPlacement?.type === "video"
      ? currentProgramPlacement.source?.previewUrl || null
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

  const activeAiJob = jobs.find((job) => job.id === pendingAiEditJobId);
  const activeTranscriptJob = transcriptClip
    ? jobs.find(
        (job) =>
          job.kind === "transcript" &&
          job.targetId === transcriptClip.id &&
          (job.status === "queued" || job.status === "running")
      ) || null
    : null;
  const isAiProcessing =
    enqueueAiEditMutation.isPending ||
    Boolean(activeAiJob && (activeAiJob.status === "queued" || activeAiJob.status === "running"));
  const isTranscriptProcessing =
    Boolean(
      transcriptClip &&
        (transcriptClip.transcriptStatus === "processing" ||
          transcriptClip.transcriptStatus === "queued" ||
          activeTranscriptJob)
    ) || false;
  const isExporting = jobs.some(
    (job) => job.kind === "export" && (job.status === "queued" || job.status === "running")
  );

  const queueTranscription = useCallback(
    async (clipOrId: LibraryClip | string) => {
      const clipId = typeof clipOrId === "string" ? clipOrId : clipOrId.id;
      if (transcriptionQueueRef.current.has(clipId)) return;

      const clip =
        typeof clipOrId === "string" ? libraryClips.find((item) => item.id === clipId) : clipOrId;
      if (!clip || clip.hasAudio === false) return;

      transcriptionQueueRef.current.add(clipId);
      try {
        await enqueueTranscriptMutation.mutateAsync(clipId);
      } finally {
        transcriptionQueueRef.current.delete(clipId);
      }
    },
    [enqueueTranscriptMutation, libraryClips]
  );

  const setVideoSource = useCallback((url: string, targetTime: number, autoplay: boolean) => {
    const video = videoRef.current;
    if (!video) return;

    const safeTargetTime = Math.max(0, targetTime);

    const seekAndPlay = () => {
      const apply = () => {
        try {
          if (Math.abs(video.currentTime - safeTargetTime) > SEEK_TOLERANCE_SECONDS) {
            video.currentTime = safeTargetTime;
          }
        } catch {
          return;
        }

        if (autoplay && video.paused) {
          void video.play().catch(() => {
            setIsPlaying(false);
          });
        }
      };

      if (video.readyState >= 1) apply();
      else video.addEventListener("loadedmetadata", apply, { once: true });
    };

    const currentSource = video.currentSrc || video.src;

    if (currentSource !== url) {
      video.pause();
      video.src = url;
      video.load();
      seekAndPlay();
      return;
    }

    seekAndPlay();
  }, [setIsPlaying]);

  const syncProgramPreview = useCallback(
    (time: number, autoplay: boolean) => {
      const clampedTime = clamp(time, 0, Math.max(timeline.totalDuration, 0));
      setProgramTime(clampedTime);

      const activeClip =
        clipsWithOffsets.find((clip) => clampedTime >= clip.sequenceStart && clampedTime < clip.sequenceEnd) ||
        clipsWithOffsets[clipsWithOffsets.length - 1];

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

      if (!activeClip.source?.previewUrl) return;

      const localTime = activeClip.sourceStartTime + (clampedTime - activeClip.sequenceStart);
      setVideoSource(activeClip.source.previewUrl, localTime, autoplay);
    },
    [clipsWithOffsets, setIsPlaying, setProgramTime, setVideoSource, timeline.totalDuration]
  );

  const syncSourcePreview = useCallback(
    (clip: LibraryClip | null, time: number, autoplay: boolean) => {
      if (!clip?.previewUrl) {
        videoRef.current?.pause();
        setIsPlaying(false);
        return;
      }

      setSourceTime(clamp(time, 0, clip.duration || 0));
      setVideoSource(clip.previewUrl, clamp(time, 0, clip.duration || 0), autoplay);
    },
    [setIsPlaying, setSourceTime, setVideoSource]
  );

  const applyEditOperations = useCallback(
    (data: EditCommandResponse) => {
      for (const operation of data.operations) {
        if (operation.type === "remove_time_range") {
          if (operation.startTime === undefined || operation.endTime === undefined || !operation.sourceClipId) continue;
          dispatchWithUndo({
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

          if (nextClips.length > 0) {
            dispatchWithUndo({ type: "APPLY_EDIT", clips: nextClips });
          }
          continue;
        }

        if (
          operation.type === "reorder" &&
          operation.fromIndex !== undefined &&
          operation.toIndex !== undefined
        ) {
          dispatchWithUndo({
            type: "REORDER_CLIP",
            fromIndex: operation.fromIndex,
            toIndex: operation.toIndex,
          });
        }
      }

      setLastExplanation(data.explanation);
      setMonitorMode("program");
    },
    [dispatchWithUndo, libraryClips, setLastExplanation, setMonitorMode]
  );

  const handleImportPaths = useCallback(async (paths: string[]) => {
    setBootstrapError(null);

    let imported: LibraryClip[] = [];
    try {
      imported = await importMediaMutation.mutateAsync(paths);
    } catch (error) {
      const message = getErrorMessage(error);
      console.error("Failed to import media:", error);
      setBootstrapError(message);
      return;
    }

    if (imported.length === 0) return;

    setSelectedSourceClipId(imported[0].id);
    setSelectedTimelineClipId(null);
    setDockTab("transcript");

    if (capabilities?.sidecarAvailable) {
      for (const clip of imported) {
        void queueTranscription(clip).catch((error) => {
          console.error("Failed to enqueue transcript job:", error);
        });
      }
    }
  }, [capabilities?.sidecarAvailable, importMediaMutation, queueTranscription, setBootstrapError, setDockTab, setSelectedSourceClipId, setSelectedTimelineClipId]);

  const handleImportRequest = useCallback(async () => {
    const paths = await pickVideoPaths();
    if (paths.length === 0) return;
    await handleImportPaths(paths);
  }, [handleImportPaths]);

  const handleSelectSourceClip = useCallback((clipId: string) => {
    setSelectedSourceClipId(clipId);
    setSelectedTimelineClipId(null);
    setMonitorMode("source");
    setDockTab("transcript");

    const clip = libraryClips.find((item) => item.id === clipId) || null;
    syncSourcePreview(clip, 0, false);
  }, [libraryClips, setDockTab, setMonitorMode, setSelectedSourceClipId, setSelectedTimelineClipId, syncSourcePreview]);

  const handleRemoveSelectedSourceClip = useCallback(async () => {
    if (!selectedSourceClipId || removeMediaMutation.isPending) return;

    const selectedIndex = libraryClips.findIndex((clip) => clip.id === selectedSourceClipId);
    if (selectedIndex === -1) return;

    const nextClip = libraryClips[selectedIndex + 1] || libraryClips[selectedIndex - 1] || null;

    try {
      await removeMediaMutation.mutateAsync(selectedSourceClipId);
    } catch (error) {
      console.error("Failed to remove media asset:", error);
      return;
    }

    setSearchResults((current) =>
      current ? current.filter((result) => result.sourceClipId !== selectedSourceClipId) : current
    );
    setTranscriptSelection(null);

    if (selectedTimelineClip?.sourceClipId === selectedSourceClipId) {
      setSelectedTimelineClipId(null);
    }

    setSelectedSourceClipId(nextClip?.id || null);

    if (monitorMode === "source") {
      if (nextClip) {
        syncSourcePreview(nextClip, 0, false);
      } else {
        setSourceTime(0);
        syncSourcePreview(null, 0, false);
      }
    }
  }, [
    libraryClips,
    monitorMode,
    removeMediaMutation,
    selectedSourceClipId,
    selectedTimelineClip?.sourceClipId,
    setSelectedSourceClipId,
    setSelectedTimelineClipId,
    setSourceTime,
    setTranscriptSelection,
    syncSourcePreview,
  ]);

  const handleSelectTimelineClip = useCallback((clipId: string | null) => {
    setSelectedTimelineClipId(clipId);
    if (!clipId) return;

    const clip = clipsWithOffsets.find((item) => item.id === clipId);
    if (!clip) return;

    if (clip.sourceClipId) setSelectedSourceClipId(clip.sourceClipId);
    setMonitorMode("program");
    setDockTab("inspector");
    syncProgramPreview(clip.sequenceStart, false);
  }, [clipsWithOffsets, setDockTab, setMonitorMode, setSelectedSourceClipId, setSelectedTimelineClipId, syncProgramPreview]);

  const handleAppendFromLibrary = useCallback((sourceClipId: string) => {
    const sourceClip = libraryClips.find((clip) => clip.id === sourceClipId);
    if (!sourceClip) return;

    const hasResolvedDuration = sourceClip.duration > 0;

    dispatchWithUndo({
      type: "ADD_SOURCE_CLIP",
      sourceClipId: sourceClip.id,
      duration: hasResolvedDuration ? sourceClip.duration : PENDING_TIMELINE_CLIP_DURATION_SECONDS,
      label: sourceClip.fileName,
      pendingSourceDuration: !hasResolvedDuration,
    });

    setSelectedSourceClipId(sourceClip.id);
    setMonitorMode("program");
  }, [dispatchWithUndo, libraryClips, setMonitorMode, setSelectedSourceClipId]);

  const handleSearch = useCallback(async (query: string) => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      setActiveSearchQuery("");
      setSearchResults(null);
      return;
    }

    setActiveSearchQuery(trimmedQuery);
    const results = await searchTranscript(trimmedQuery);
    setSearchResults(results);
    setDockTab("transcript");

    const topResult = results[0];
    if (topResult) {
      setSelectedSourceClipId(topResult.sourceClipId);
      setSelectedTimelineClipId(null);
      setMonitorMode("source");
      const clip = libraryClips.find((item) => item.id === topResult.sourceClipId) || null;
      const segment = clip?.transcriptSegments.find((item) => item.id === topResult.id);
      if (segment && clip) syncSourcePreview(clip, segment.startTime, false);
    }
  }, [libraryClips, setActiveSearchQuery, setDockTab, setMonitorMode, setSelectedSourceClipId, setSelectedTimelineClipId, syncSourcePreview]);

  const handleRemoveTranscriptSelection = useCallback(() => {
    if (!transcriptSelection || transcriptSelection.hasUnalignedWords) return;
    if (transcriptSelection.endTime <= transcriptSelection.startTime) return;

    dispatchWithUndo({
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
  }, [dispatchWithUndo, setMonitorMode, setTranscriptSelection, transcriptSelection]);

  const handleRemoveTranscriptSegment = useCallback((segmentId: string) => {
    const segment = transcriptClip?.transcriptSegments.find((item) => item.id === segmentId);
    if (!segment) return;

    dispatchWithUndo({ type: "REMOVE_SEGMENTS", segments: [segment] });
    setTranscriptSelection(null);
    setMonitorMode("program");
  }, [dispatchWithUndo, setMonitorMode, setTranscriptSelection, transcriptClip]);

  const handleRemovePause = useCallback((pauseId: string) => {
    const pause = transcriptPauses.find((item) => item.id === pauseId);
    if (!pause) return;

    const range = trimPauseForRoomTone(pause, selectedTranscriptRange);
    if (!range) return;

    dispatchWithUndo({ type: "REMOVE_RANGES", ranges: [range] });
    setMonitorMode("program");
  }, [dispatchWithUndo, selectedTranscriptRange, setMonitorMode, transcriptPauses]);

  const handleRemoveLongPauses = useCallback((minimumDuration = DEFAULT_PAUSE_THRESHOLD_SECONDS) => {
    const ranges = mergeTimelineRanges(
      transcriptPauses
        .filter((pause) => pause.duration >= minimumDuration)
        .map((pause) => trimPauseForRoomTone(pause, selectedTranscriptRange))
        .filter((range): range is TimelineRange => Boolean(range))
    );

    if (ranges.length === 0) return;

    dispatchWithUndo({ type: "REMOVE_RANGES", ranges });
    setMonitorMode("program");
  }, [dispatchWithUndo, selectedTranscriptRange, setMonitorMode, transcriptPauses]);

  const handleRetranscribe = useCallback(() => {
    if (!transcriptClip || transcriptClip.hasAudio === false || isTranscriptProcessing) return;
    setTranscriptSelection(null);
    void enqueueTranscriptMutation.mutateAsync(transcriptClip.id).catch((error) => {
      console.error("Failed to re-transcribe clip:", error);
    });
  }, [enqueueTranscriptMutation, isTranscriptProcessing, setTranscriptSelection, transcriptClip]);

  const handleMonitorSeek = useCallback((time: number) => {
    if (monitorMode === "program") {
      syncProgramPreview(time, false);
      return;
    }

    syncSourcePreview(selectedSourceClip, time, false);
  }, [monitorMode, selectedSourceClip, syncProgramPreview, syncSourcePreview]);

  const handleTimelineSeek = useCallback((time: number) => {
    setMonitorMode("program");
    syncProgramPreview(time, false);
  }, [setMonitorMode, syncProgramPreview]);

  const handleTranscriptSeek = useCallback((time: number) => {
    if (!transcriptClip) return;
    setSelectedSourceClipId(transcriptClip.id);
    setSelectedTimelineClipId(null);
    setMonitorMode("source");
    syncSourcePreview(transcriptClip, time, false);
  }, [setMonitorMode, setSelectedSourceClipId, setSelectedTimelineClipId, syncSourcePreview, transcriptClip]);

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

    if (!timeline.clips.length || currentProgramPlacement?.type === "image") return;

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

  const handleEditCommand = useCallback(async (command: string) => {
    setLastExplanation(null);
    const transcriptSegments = libraryClips.flatMap((clip) => clip.transcriptSegments);
    const pauseRanges = libraryClips.flatMap((clip) => clip.pauseRanges);
    const job = await enqueueAiEditMutation.mutateAsync({
      command,
      transcript: transcriptSegments,
      timeline: timeline.clips,
      pauses: pauseRanges,
    });
    setPendingAiEditJobId(job.id);
  }, [enqueueAiEditMutation, libraryClips, setLastExplanation, setPendingAiEditJobId, timeline.clips]);

  const handleExport = useCallback(async () => {
    if (timeline.clips.length === 0) return;
    const outputPath = await pickSavePath("vibecut-export.mp4");
    if (!outputPath) return;
    await enqueueExportMutation.mutateAsync({ clips: timeline.clips, outputPath });
  }, [enqueueExportMutation, timeline.clips]);

  useEffect(() => {
    monitorModeRef.current = monitorMode;
  }, [monitorMode]);

  useEffect(() => {
    activeProgramClipRef.current = currentProgramPlacement?.id || null;
  }, [currentProgramPlacement]);

  useEffect(() => {
    const nextError =
      (libraryQuery.error instanceof Error && libraryQuery.error.message) ||
      (timelineQuery.error instanceof Error && timelineQuery.error.message) ||
      (capabilitiesQuery.error instanceof Error && capabilitiesQuery.error.message) ||
      null;
    setBootstrapError(nextError);
  }, [capabilitiesQuery.error, libraryQuery.error, setBootstrapError, timelineQuery.error]);

  useEffect(() => {
    const selectedClipStillExists = selectedSourceClipId
      ? libraryClips.some((clip) => clip.id === selectedSourceClipId)
      : false;

    if (selectedClipStillExists) return;

    const nextSelectedClipId = libraryClips[0]?.id || null;
    if (selectedSourceClipId !== nextSelectedClipId) {
      setSelectedSourceClipId(nextSelectedClipId);
    }
  }, [libraryClips, selectedSourceClipId, setSelectedSourceClipId]);

  useEffect(() => {
    if (!selectedTimelineClipId) return;
    if (!timeline.clips.some((clip) => clip.id === selectedTimelineClipId)) {
      setSelectedTimelineClipId(null);
    }
  }, [selectedTimelineClipId, setSelectedTimelineClipId, timeline.clips]);

  useEffect(() => {
    let hasChanges = false;

    const reconciledClips = timeline.clips.map((clip) => {
      if (clip.type !== "video" || !clip.sourceClipId) return clip;
      if (!clip.effects.some((effect) => effect.type === PENDING_SOURCE_DURATION_EFFECT)) return clip;

      const sourceClip = libraryClips.find((item) => item.id === clip.sourceClipId);
      if (!sourceClip || sourceClip.duration <= 0) return clip;

      hasChanges = true;
      return {
        ...clip,
        sourceEndTime: sourceClip.duration,
        duration: sourceClip.duration,
        label: clip.label || sourceClip.fileName,
        effects: clip.effects.filter((effect) => effect.type !== PENDING_SOURCE_DURATION_EFFECT),
      };
    });

    if (!hasChanges) return;
    dispatchTimeline({ type: "SET_CLIPS", clips: reconciledClips });
  }, [dispatchTimeline, libraryClips, timeline.clips]);

  useEffect(() => {
    if (!timelineQuery.isSuccess) return;
    lastPersistedTimelineRef.current = JSON.stringify(timelineQuery.data || []);
  }, [timelineQuery.data, timelineQuery.isSuccess]);

  useEffect(() => {
    if (!timelineQuery.isSuccess) return;
    const signature = JSON.stringify(timeline.clips);
    if (!signature || signature === lastPersistedTimelineRef.current) return;
    lastPersistedTimelineRef.current = signature;
    applyTimelinePatchMutation.mutate({ kind: "replace_clips", clips: timeline.clips });
  }, [applyTimelinePatchMutation, timeline.clips, timelineQuery.isSuccess]);

  useEffect(() => {
    if (!capabilities?.sidecarAvailable) return;

    const pending = libraryClips.filter(
      (clip) =>
        clip.hasAudio !== false &&
        clip.transcriptStatus === "not_requested" &&
        !transcriptionQueueRef.current.has(clip.id)
    );

    pending.forEach((clip) => {
      void queueTranscription(clip.id).catch((error) => {
        console.error("Failed to enqueue transcript job:", error);
      });
    });
  }, [capabilities?.sidecarAvailable, libraryClips, queueTranscription]);

  // Keep a ref to the latest handleImportPaths so the listener never needs
  // to re-register when capabilities load (which would leave a dangling listener).
  const handleImportPathsRef = useRef(handleImportPaths);
  useEffect(() => { handleImportPathsRef.current = handleImportPaths; }, [handleImportPaths]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let cancelled = false;

    void listenForFileDrop((paths) => {
      void handleImportPathsRef.current(paths);
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else cleanup = unlisten;
    });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!pendingAiEditJobId) return;
    const job = jobs.find((item) => item.id === pendingAiEditJobId);
    if (!job) return;

    if (job.status === "complete" && handledAiJobRef.current !== job.id) {
      handledAiJobRef.current = job.id;
      const result = parseAiEditResult(job);
      if (result) applyEditOperations(result);
      setPendingAiEditJobId(null);
      return;
    }

    if (job.status === "error") {
      setLastExplanation(job.errorMessage || job.message || "AI edit command failed.");
      setPendingAiEditJobId(null);
    }
  }, [applyEditOperations, jobs, pendingAiEditJobId, setLastExplanation, setPendingAiEditJobId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (event.key === " ") {
        event.preventDefault();
        handleTogglePlay();
        return;
      }

      if ((event.key === "Delete" || event.key === "Backspace") && transcriptSelection && dockTab === "transcript") {
        event.preventDefault();
        handleRemoveTranscriptSelection();
        return;
      }

      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key === "Backspace") {
        event.preventDefault();
        void handleRemoveSelectedSourceClip();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key === "z") {
        event.preventDefault();
        undo();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [dockTab, handleRemoveSelectedSourceClip, handleRemoveTranscriptSelection, handleTogglePlay, transcriptSelection, undo]);

  useEffect(() => {
    const handleDragOver = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) {
        setIsDraggingOver(true);
      }
    };
    const handleDragLeave = (event: DragEvent) => {
      if (event.relatedTarget === null) setIsDraggingOver(false);
    };
    const handleDrop = () => setIsDraggingOver(false);

    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("drop", handleDrop);

    return () => {
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("drop", handleDrop);
    };
  }, [setIsDraggingOver]);

  useEffect(() => {
    if (monitorMode !== "source") return;

    if (!selectedSourceClip?.previewUrl) {
      videoRef.current?.pause();
      setIsPlaying(false);
      return;
    }

    const video = videoRef.current;
    const currentSource = video?.currentSrc || video?.src || "";
    if (currentSource !== selectedSourceClip.previewUrl) {
      syncSourcePreview(selectedSourceClip, sourceTime, false);
    }
  }, [monitorMode, selectedSourceClip, setIsPlaying, syncSourcePreview]);

  useEffect(() => {
    if (monitorMode !== "program") return;

    if (!currentProgramPlacement) {
      videoRef.current?.pause();
      setIsPlaying(false);
      return;
    }

    if (currentProgramPlacement.type === "image") {
      videoRef.current?.pause();
      setIsPlaying(false);
      return;
    }

    const previewUrl = currentProgramPlacement.source?.previewUrl;
    if (!previewUrl) return;

    const video = videoRef.current;
    const currentSource = video?.currentSrc || video?.src || "";
    if (currentSource !== previewUrl) {
      syncProgramPreview(programTime, false);
    }
  }, [currentProgramPlacement, monitorMode, setIsPlaying, syncProgramPreview]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !monitorVideoUrl) {
      setIsPlaying(false);
      return;
    }

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

    setIsPlaying(!video.paused && !video.ended);

    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);

    return () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
    };
  }, [clipsWithOffsets, monitorVideoUrl, setIsPlaying, setProgramTime, setSourceTime, syncProgramPreview, timeline.totalDuration]);

  const capabilitiesText = [
    `ffmpeg: ${capabilities?.ffmpegAvailable ? "available" : "missing"}`,
    `ffprobe: ${capabilities?.ffprobeAvailable ? "available" : "missing"}`,
    `transcription sidecar: ${capabilities?.sidecarAvailable ? "available" : "missing"}`,
    `hardware encoders: ${capabilities?.hardwareEncoding.join(", ") || "none detected"}`,
  ];

  const activeDockManifest = dockFeatureManifests.find((manifest) => manifest.id === dockTab) || dockFeatureManifests[0];
  const timelineDispatch = dispatchWithUndo as React.Dispatch<TimelineAction>;

  return (
    <div className="vibecut-shell relative flex h-screen min-w-0 flex-col overflow-hidden bg-[#0b0c0f] text-white">
      {isDraggingOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="rounded-3xl border-2 border-dashed border-sky-400/60 bg-sky-400/10 px-12 py-8 text-center">
            <p className="text-lg font-semibold text-sky-300">Drop video files to import</p>
            <p className="mt-1 text-sm text-white/40">MP4, MOV, WebM, AVI, MKV</p>
          </div>
        </div>
      )}

      <header data-tauri-drag-region className="flex items-center justify-between border-b border-white/8 bg-[#111215] py-3 pl-[88px] pr-5">
        <div className="flex items-center gap-4">
          <div>
            <p className="text-[10px] uppercase tracking-[0.24em] text-white/28">Workspace</p>
            <h1 className="mt-1 text-lg font-semibold text-white/92">{projectQuery.data?.name || "VibeCut Studio"}</h1>
          </div>
          <div className="hidden h-8 w-px bg-white/8 md:block" />
          <div className="hidden gap-4 text-[11px] uppercase tracking-[0.18em] text-white/34 md:flex">
            <span>{libraryClips.length} clips</span>
            <span>{timeline.clips.length} sequence items</span>
            <span>{formatTime(timeline.totalDuration)}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {processingCount > 0 && (
            <div className="rounded-full border border-amber-400/18 bg-amber-500/10 px-3 py-1.5 text-[11px] font-medium text-amber-200">
              Processing {processingCount} clip{processingCount === 1 ? "" : "s"}
            </div>
          )}
          <button
            onClick={() => void handleExport()}
            disabled={isExporting || timeline.clips.length === 0}
            className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-4 py-1.5 text-[11px] font-medium text-emerald-200 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isExporting ? (
              <>
                <div className="h-3 w-3 animate-spin rounded-full border-2 border-emerald-300/30 border-t-emerald-300" />
                Exporting...
              </>
            ) : (
              <>
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Export
              </>
            )}
          </button>
          {capabilities && (
            <div className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11px] font-medium text-white/64">
              {capabilities.hardwareEncoding[0] ? `GPU ${capabilities.hardwareEncoding[0]}` : "CPU fallback"}
            </div>
          )}
        </div>
      </header>

      {bootstrapError && (
        <div className="border-b border-red-400/12 bg-red-500/8 px-5 py-2 text-sm text-red-200/90">
          {bootstrapError}
        </div>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <div className="flex-none overflow-hidden" style={{ width: leftPanelWidth }}>
        <MediaBin
          clips={libraryClips}
          selectedClipId={selectedSourceClipId}
          onSelectClip={handleSelectSourceClip}
          onImportRequest={() => void handleImportRequest()}
          searchDraft={searchDraft}
          activeSearchQuery={activeSearchQuery}
          searchScores={clipSearchScores}
          isSearching={false}
          onSearchDraftChange={setSearchDraft}
          onSearchSubmit={() => void handleSearch(searchDraft)}
          onClearSearch={() => {
            setSearchDraft("");
            setActiveSearchQuery("");
            setSearchResults(null);
          }}
        />
        </div>

        {/* Left resize handle */}
        <div
          className="w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-sky-400/30 select-none"
          onMouseDown={(e) => {
            panelDragRef.current = { panel: "left", startX: e.clientX, startWidth: leftPanelWidth };
            e.preventDefault();
          }}
        />

        <main ref={centerColumnRef} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[#0d0e12]">
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
                      monitorMode === mode ? "bg-sky-400 text-black" : "text-white/45 hover:text-white/78"
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
              emptyLabel={monitorMode === "source" ? "Import a clip from disk" : "Build a sequence to preview it"}
              onTogglePlay={handleTogglePlay}
              onSeek={handleMonitorSeek}
            />
          </section>

          {/* Timeline resize handle */}
          <div
            className="h-1 shrink-0 cursor-row-resize bg-transparent transition-colors hover:bg-sky-400/30 select-none"
            onMouseDown={(e) => {
              panelDragRef.current = { panel: "timeline", startY: e.clientY, startHeight: resolvedTimelineHeight };
              e.preventDefault();
            }}
            onDoubleClick={() => setTimelineHeightPreference(null)}
            title="Drag to resize timeline. Double-click to auto-fit."
          />

          <section className="shrink-0 overflow-hidden p-4 pt-1" style={{ height: resolvedTimelineHeight }}>
            <Timeline
              clips={timeline.clips}
              libraryClips={libraryClips}
              totalDuration={timeline.totalDuration}
              currentTime={programTime}
              onSeek={handleTimelineSeek}
              onAppendFromLibrary={handleAppendFromLibrary}
              dispatch={timelineDispatch}
              selectedClipId={selectedTimelineClipId}
              onSelectClip={handleSelectTimelineClip}
            />
          </section>
        </main>

        {/* Right resize handle */}
        <div
          className="w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-sky-400/30 select-none"
          onMouseDown={(e) => {
            panelDragRef.current = { panel: "right", startX: e.clientX, startWidth: rightPanelWidth };
            e.preventDefault();
          }}
        />

        <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-[#141518]" style={{ width: rightPanelWidth, flexShrink: 0 }}>
          <div className="border-b border-white/8 px-4 py-3">
            <p className="text-[10px] uppercase tracking-[0.22em] text-white/32">Dock</p>
            <div className="mt-3 grid grid-cols-4 rounded-xl border border-white/8 bg-white/[0.03] p-1">
              {dockFeatureManifests.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setDockTab(tab.id)}
                  title={tab.label}
                  className={`min-w-0 truncate rounded-lg px-1.5 py-2 text-[10px] font-medium uppercase tracking-[0.12em] transition ${
                    dockTab === tab.id ? "bg-sky-400 text-black" : "text-white/42 hover:text-white/78"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
            {activeDockManifest.render({
              videoRef,
              ai: {
                enabled: Boolean(capabilities?.aiConfigured),
                isProcessing: isAiProcessing,
                lastExplanation,
                onSubmit: (command) => void handleEditCommand(command),
              },
              transcript: {
                clipName: transcriptClip?.fileName,
                segments: transcriptClip?.transcriptSegments || [],
                pauses: transcriptPauses,
                currentTime: activeTranscriptTime,
                canRetranscribe: Boolean(transcriptClip && transcriptClip.hasAudio !== false),
                isRetranscribing: isTranscriptProcessing,
                selection: transcriptSelection,
                activeRange: selectedTranscriptRange,
                timelineSourceRanges,
                onSeek: handleTranscriptSeek,
                onRetranscribe: handleRetranscribe,
                onSelectionChange: (selection: TranscriptSelection | null) => setTranscriptSelection(selection),
                onRemoveSelection: handleRemoveTranscriptSelection,
                onRemoveSegment: handleRemoveTranscriptSegment,
                onRemovePause: handleRemovePause,
                onRemoveLongPauses: handleRemoveLongPauses,
                activeSearchQuery,
                searchResults,
              },
              inspector: {
                selectedTimelineClip,
                selectedSourceClip,
                capabilitiesText,
                jobs,
                bootstrapError,
              },
            })}
          </div>
        </aside>
      </div>
    </div>
  );
}
