"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PauseRange, TranscriptMetadata, TranscriptSegment, TranscriptSelection, TranscriptTimingMode } from "@/types";

interface TranscriptPanelProps {
  clipName?: string;
  segments: TranscriptSegment[];
  metadata?: TranscriptMetadata | null;
  pauses: PauseRange[];
  currentTime: number;
  canRetranscribe?: boolean;
  isRetranscribing?: boolean;
  languageOverride: string;
  selection: TranscriptSelection | null;
  activeRange?: { startTime: number; endTime: number } | null;
  timelineSourceRanges?: Array<{ startTime: number; endTime: number }>;
  isSavingManualTiming?: boolean;
  onSeek: (time: number) => void;
  onRetranscribe?: (options?: { discardManualCorrections?: boolean }) => void;
  onLanguageOverrideChange: (value: string) => void;
  onSaveManualTiming?: (input: { wordId: string; startTime: number; endTime: number }) => Promise<void>;
  onSelectionChange: (selection: TranscriptSelection | null) => void;
  onRemoveSelection: () => void;
  onRemoveSegment: (segmentId: string) => void;
  onRemovePause: (pauseId: string) => void;
  onRemoveLongPauses: (minimumDuration?: number) => void;
  activeSearchQuery?: string;
  searchResults: { id: string; score: number }[] | null;
}

interface DisplayWord {
  wordId: string;
  sourceClipId: string;
  segmentId: string;
  text: string;
  orderIndex: number;
  aligned: boolean;
  timingMode: TranscriptTimingMode;
  editable: boolean;
  confidence?: number;
  startTime?: number;
  endTime?: number;
  segmentStartTime: number;
  segmentEndTime: number;
}

interface ManualWordDraft {
  wordId: string;
  text: string;
  timingMode: TranscriptTimingMode;
  startTime: number;
  endTime: number;
}

function formatTime(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function isFiniteNumber(value: number | undefined): value is number {
  return Number.isFinite(value);
}

function midpoint(start: number, end: number) {
  return start + (end - start) / 2;
}

function isSameBoundary(
  leftContainer: Node,
  leftOffset: number,
  rightContainer: Node,
  rightOffset: number
) {
  return leftContainer === rightContainer && leftOffset === rightOffset;
}

function tokenizeFallbackWords(segment: TranscriptSegment, startOrderIndex: number) {
  return segment.text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(
      (token, index): DisplayWord => ({
        wordId: `${segment.id}-fallback-${index}`,
        sourceClipId: segment.sourceClipId,
        segmentId: segment.id,
        text: token,
        orderIndex: startOrderIndex + index,
        aligned: false,
        timingMode: "approximate",
        editable: false,
        confidence: undefined,
        startTime: undefined,
        endTime: undefined,
        segmentStartTime: segment.startTime,
        segmentEndTime: segment.endTime,
      })
    );
}

function getWordElement(node: EventTarget | null) {
  if (!(node instanceof HTMLElement)) return null;
  return node.closest<HTMLElement>("[data-word-id]");
}

export default function TranscriptPanel({
  clipName,
  segments,
  metadata,
  pauses,
  currentTime,
  canRetranscribe,
  isRetranscribing,
  languageOverride,
  selection,
  activeRange,
  timelineSourceRanges = [],
  isSavingManualTiming,
  onSeek,
  onRetranscribe,
  onLanguageOverrideChange,
  onSaveManualTiming,
  onSelectionChange,
  onRemoveSelection,
  onRemoveSegment,
  onRemovePause,
  onRemoveLongPauses,
  activeSearchQuery,
  searchResults,
}: TranscriptPanelProps) {
  const transcriptTextRef = useRef<HTMLDivElement>(null);
  const suppressSelectionSyncRef = useRef(false);
  const [manualWordDraft, setManualWordDraft] = useState<ManualWordDraft | null>(null);

  const activeSegmentId = useMemo(() => {
    const active = segments.find((segment) => currentTime >= segment.startTime && currentTime < segment.endTime);
    return active?.id || null;
  }, [segments, currentTime]);

  const activeWordId = useMemo(() => {
    if (!activeSegmentId) return null;
    const segment = segments.find((s) => s.id === activeSegmentId);
    if (!segment) return null;
    const alignedWords = segment.words.filter((w) => w.timingMode !== "approximate" && Number.isFinite(w.startTime));
    if (alignedWords.length === 0) return null;
    // Exact match first
    const exact = alignedWords.find((w) => currentTime >= w.startTime && currentTime < w.endTime);
    if (exact) return exact.id;
    // Between words: return the most recently passed word so the highlight doesn't vanish
    const passed = alignedWords.filter((w) => w.startTime <= currentTime);
    return passed.length > 0 ? passed[passed.length - 1].id : alignedWords[0].id;
  }, [activeSegmentId, currentTime, segments]);

  const searchScoreMap = useMemo(() => {
    if (!searchResults) return null;
    const map = new Map<string, number>();
    for (const result of searchResults) map.set(result.id, result.score);
    return map;
  }, [searchResults]);

  const segmentWords = useMemo(() => {
    return segments.reduce<Array<{ segment: TranscriptSegment; words: DisplayWord[] }>>((accumulator, segment) => {
      const nextOrderIndex =
        accumulator[accumulator.length - 1]?.words[accumulator[accumulator.length - 1].words.length - 1]?.orderIndex + 1 || 0;

      const words =
        segment.words.length > 0
          ? segment.words.map((word, index) => ({
              wordId: word.id,
              sourceClipId: word.sourceClipId,
              segmentId: word.segmentId,
              text: word.text,
              orderIndex: nextOrderIndex + index,
              aligned: word.aligned,
              timingMode: word.timingMode,
              editable: word.editable,
              confidence: word.confidence,
              startTime: word.startTime,
              endTime: word.endTime,
              segmentStartTime: segment.startTime,
              segmentEndTime: segment.endTime,
            }))
          : tokenizeFallbackWords(segment, nextOrderIndex);

      accumulator.push({ segment, words });
      return accumulator;
    }, []);
  }, [segments]);

  const hasTimelineContext = timelineSourceRanges.length > 0;

  const segmentInTimeline = useMemo(() => {
    if (!hasTimelineContext) return null;
    const map = new Map<string, boolean>();
    for (const segment of segments) {
      const overlaps = timelineSourceRanges.some(
        (range) => segment.endTime > range.startTime && segment.startTime < range.endTime
      );
      map.set(segment.id, overlaps);
    }
    return map;
  }, [hasTimelineContext, segments, timelineSourceRanges]);

  const hasBatchOnlyRegions = useMemo(
    () => segments.some((segment) => !segment.wordEditCapable),
    [segments]
  );

  const buildSelectionFromDom = useCallback((): TranscriptSelection | null => {
    const root = transcriptTextRef.current;
    const nativeSelection = window.getSelection();

    if (!root || !nativeSelection || nativeSelection.rangeCount === 0 || nativeSelection.isCollapsed) {
      return null;
    }

    const range = nativeSelection.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return null;

    const allWords = Array.from(root.querySelectorAll<HTMLElement>("[data-word-id]"))
      .map((element) => ({
        element,
        wordId: element.dataset.wordId || "",
        sourceClipId: element.dataset.sourceClipId || "",
        segmentId: element.dataset.segmentId || "",
        orderIndex: Number(element.dataset.orderIndex ?? -1),
        aligned: element.dataset.aligned === "true",
        editable: element.dataset.editable === "true",
        startTime: element.dataset.startTime ? Number(element.dataset.startTime) : undefined,
        endTime: element.dataset.endTime ? Number(element.dataset.endTime) : undefined,
        segmentStartTime: Number(element.dataset.segmentStartTime ?? 0),
        segmentEndTime: Number(element.dataset.segmentEndTime ?? 0),
        isSelected: (() => {
          try {
            return range.intersectsNode(element);
          } catch {
            return false;
          }
        })(),
      }))
      .filter((word) => word.wordId && word.sourceClipId)
      .sort((left, right) => left.orderIndex - right.orderIndex);

    let selectedWords = allWords.filter((word) => word.isSelected);

    while (selectedWords.length > 0) {
      const firstSelected = selectedWords[0];
      const firstRange = document.createRange();
      firstRange.selectNodeContents(firstSelected.element);

      if (
        isSameBoundary(
          range.startContainer,
          range.startOffset,
          firstRange.endContainer,
          firstRange.endOffset
        )
      ) {
        selectedWords = selectedWords.slice(1);
        continue;
      }
      break;
    }

    while (selectedWords.length > 0) {
      const lastSelected = selectedWords[selectedWords.length - 1];
      const lastRange = document.createRange();
      lastRange.selectNodeContents(lastSelected.element);

      if (
        isSameBoundary(
          range.endContainer,
          range.endOffset,
          lastRange.startContainer,
          lastRange.startOffset
        )
      ) {
        selectedWords = selectedWords.slice(0, -1);
        continue;
      }
      break;
    }

    if (selectedWords.length === 0) return null;

    const firstWord = selectedWords[0];
    const lastWord = selectedWords[selectedWords.length - 1];
    const hasUnalignedWords = selectedWords.some((word) => !word.editable);
    const firstTimedWord = selectedWords.find((word) => Number.isFinite(word.startTime));
    const lastTimedWord = [...selectedWords].reverse().find((word) => Number.isFinite(word.endTime));
    const firstSelectedIndex = allWords.findIndex((word) => word.wordId === firstWord.wordId);
    const lastSelectedIndex = allWords.findIndex((word) => word.wordId === lastWord.wordId);
    const previousTimedWord = firstSelectedIndex <= 0
      ? null
      : [...allWords.slice(0, firstSelectedIndex)]
          .reverse()
          .find((word) => word.editable && isFiniteNumber(word.endTime)) || null;
    const nextTimedWord = lastSelectedIndex === -1
      ? null
      : allWords
          .slice(lastSelectedIndex + 1)
          .find((word) => word.editable && isFiniteNumber(word.startTime)) || null;

    let selectionStart = firstTimedWord?.startTime ?? firstWord.segmentStartTime;
    let selectionEnd = lastTimedWord?.endTime ?? lastWord.segmentEndTime;

    if (firstTimedWord && previousTimedWord && isFiniteNumber(previousTimedWord.endTime)) {
      const candidateStart = midpoint(previousTimedWord.endTime, firstTimedWord.startTime);
      if (candidateStart >= previousTimedWord.endTime && candidateStart <= firstTimedWord.startTime) {
        selectionStart = candidateStart;
      }
    }

    if (lastTimedWord && nextTimedWord && isFiniteNumber(nextTimedWord.startTime)) {
      const candidateEnd = midpoint(lastTimedWord.endTime, nextTimedWord.startTime);
      if (candidateEnd >= lastTimedWord.endTime && candidateEnd <= nextTimedWord.startTime) {
        selectionEnd = candidateEnd;
      }
    }

    if (selectionEnd <= selectionStart) {
      selectionStart = firstTimedWord?.startTime ?? firstWord.segmentStartTime;
      selectionEnd = lastTimedWord?.endTime ?? lastWord.segmentEndTime;
    }

    return {
      sourceClipId: firstWord.sourceClipId,
      wordIds: selectedWords.map((word) => word.wordId),
      startTime: selectionStart,
      endTime: selectionEnd,
      wordCount: selectedWords.length,
      hasUnalignedWords,
    };
  }, []);

  useEffect(() => {
    if (!activeWordId || !transcriptTextRef.current) return;
    const el = transcriptTextRef.current.querySelector(`[data-word-id="${activeWordId}"]`);
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeWordId]);

  useEffect(() => {
    const handleSelectionChange = () => {
      if (suppressSelectionSyncRef.current) return;
      onSelectionChange(buildSelectionFromDom());
    };

    document.addEventListener("selectionchange", handleSelectionChange);
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, [buildSelectionFromDom, onSelectionChange]);

  useEffect(() => {
    if (selection || !transcriptTextRef.current) return;

    const nativeSelection = window.getSelection();
    if (!nativeSelection || nativeSelection.rangeCount === 0) return;

    const range = nativeSelection.getRangeAt(0);
    if (!transcriptTextRef.current.contains(range.commonAncestorContainer)) return;

    suppressSelectionSyncRef.current = true;
    nativeSelection.removeAllRanges();
    requestAnimationFrame(() => {
      suppressSelectionSyncRef.current = false;
    });
  }, [selection]);

  const resolvedManualWordDraft = useMemo(() => {
    if (!manualWordDraft) return null;

    const stillExists = segments.some((segment) =>
      segment.words.some((word) => word.id === manualWordDraft.wordId)
    );

    return stillExists ? manualWordDraft : null;
  }, [manualWordDraft, segments]);

  const handleWordMouseUp = useCallback(
    (event: React.MouseEvent<HTMLSpanElement>) => {
      const wordElement = getWordElement(event.target);
      if (!wordElement) return;

      const nativeSelection = window.getSelection();
      if (nativeSelection && !nativeSelection.isCollapsed) return;

      suppressSelectionSyncRef.current = true;
      nativeSelection?.removeAllRanges();
      requestAnimationFrame(() => {
        suppressSelectionSyncRef.current = false;
      });

      onSelectionChange(null);
      const seekTime = Number(wordElement.dataset.startTime ?? wordElement.dataset.segmentStartTime ?? 0);
      const timingMode = (wordElement.dataset.timingMode as TranscriptTimingMode | undefined) || "approximate";
      onSeek(seekTime);

      if (timingMode === "approximate" || timingMode === "manual") {
        const startTime = Number(wordElement.dataset.startTime ?? wordElement.dataset.segmentStartTime ?? 0);
        const endTime = Number(wordElement.dataset.endTime ?? wordElement.dataset.segmentEndTime ?? startTime);
        setManualWordDraft({
          wordId: wordElement.dataset.wordId || "",
          text: wordElement.dataset.wordText || "",
          timingMode,
          startTime,
          endTime,
        });
        return;
      }

      setManualWordDraft(null);
    },
    [onSeek, onSelectionChange]
  );

  const hasManualWords = useMemo(
    () => segments.some((segment) => segment.words.some((word) => word.timingMode === "manual")),
    [segments]
  );

  const handleSaveManualTiming = useCallback(async () => {
    if (!resolvedManualWordDraft || !onSaveManualTiming) return;
    if (resolvedManualWordDraft.endTime <= resolvedManualWordDraft.startTime) return;

    await onSaveManualTiming({
      wordId: resolvedManualWordDraft.wordId,
      startTime: resolvedManualWordDraft.startTime,
      endTime: resolvedManualWordDraft.endTime,
    });

    setManualWordDraft((current) =>
      current
        ? {
            ...current,
            timingMode: "manual",
          }
        : current
    );
  }, [onSaveManualTiming, resolvedManualWordDraft]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="border-b border-white/8 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-[0.22em] text-white/32">Transcript</p>
            <p className="mt-1 truncate text-sm text-white/82">{clipName || "Select a clip"}</p>
          </div>
          <button
            type="button"
            onClick={() => onRetranscribe?.()}
            disabled={!canRetranscribe || isRetranscribing}
            className="shrink-0 rounded-md border border-sky-400/20 bg-sky-400/10 px-2.5 py-1.5 text-[11px] font-medium text-sky-100 transition hover:bg-sky-400/16 disabled:cursor-not-allowed disabled:opacity-35"
          >
            {isRetranscribing ? "Transcribing..." : "Re-Transcribe"}
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={languageOverride}
            onChange={(event) => onLanguageOverrideChange(event.target.value)}
            placeholder={metadata?.language ? `Lock language (detected: ${metadata.language})` : "Lock language (e.g. en)"}
            className="min-w-[180px] flex-1 rounded-md border border-white/10 bg-white/[0.05] px-3 py-2 text-xs text-white placeholder:text-white/28 focus:border-sky-400/40 focus:outline-none"
          />
          {hasManualWords && (
            <button
              type="button"
              onClick={() => onRetranscribe?.({ discardManualCorrections: true })}
              disabled={!canRetranscribe || isRetranscribing}
              className="shrink-0 rounded-md border border-amber-400/20 bg-amber-500/10 px-2.5 py-2 text-[11px] font-medium text-amber-100 transition hover:bg-amber-500/16 disabled:cursor-not-allowed disabled:opacity-35"
            >
              Re-Transcribe Fresh
            </button>
          )}
        </div>

        {metadata?.lowConfidenceLanguage && (
          <p className="mt-2 text-[11px] leading-5 text-amber-200/90">
            Language detection looked uncertain. Re-transcribe with a locked language code for better word coverage and timing.
          </p>
        )}

        {metadata && (
          <p className="mt-2 text-[11px] leading-5 text-white/34">
            {metadata.language ? `Detected ${metadata.language}` : "Language auto-detect"} ·{" "}
            {metadata.alignmentMode || "word alignment"} · {metadata.model || metadata.provider || "local transcription"}
          </p>
        )}
      </div>

      {activeSearchQuery && (
        <div className="border-b border-white/8 px-4 py-3">
          <p className="text-[10px] uppercase tracking-[0.2em] text-white/28">Search Context</p>
          <p className="mt-1 text-xs leading-5 text-white/58">
            Showing transcript matches for &quot;{activeSearchQuery}&quot;. Matching sections are highlighted below.
          </p>
        </div>
      )}

      <div className="border-b border-white/8 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[10px] uppercase tracking-[0.18em] text-white/30">Text Selection</p>
            <p className="mt-1 text-xs leading-5 text-white/46">
              Click and drag across the transcript to highlight a precise spoken range.
            </p>
          </div>
          <button
            onClick={onRemoveSelection}
            disabled={!selection || selection.hasUnalignedWords || selection.wordCount === 0}
            className="rounded-md border border-red-400/20 bg-red-500/10 px-2.5 py-1.5 text-[11px] font-medium text-red-200 transition hover:bg-red-500/16 disabled:cursor-not-allowed disabled:opacity-35"
          >
            Remove Selection
          </button>
        </div>

        {selection && (
          <p className={`mt-2 text-[11px] leading-5 ${selection.hasUnalignedWords ? "text-amber-300/90" : "text-white/42"}`}>
            {selection.hasUnalignedWords
              ? "This highlight includes approximate word timing. Fix the timing or use the segment remove action for that section."
              : `${selection.wordCount} word${selection.wordCount === 1 ? "" : "s"} selected.`}
          </p>
        )}

        {!selection && hasBatchOnlyRegions && (
          <p className="mt-2 text-[11px] leading-5 text-white/34">
            Some regions still use approximate timing and are not safe for destructive word edits until they are re-transcribed or manually corrected.
          </p>
        )}
      </div>

      {resolvedManualWordDraft && (
        <div className="border-b border-white/8 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-[0.18em] text-white/30">Word Timing</p>
              <p className="mt-1 text-xs leading-5 text-white/58">
                {resolvedManualWordDraft.timingMode === "approximate"
                  ? `\"${resolvedManualWordDraft.text}\" is approximate. Set exact boundaries from the playhead to make it safe for word-level edits.`
                  : `\"${resolvedManualWordDraft.text}\" has a manual timing override.`}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() =>
                  setManualWordDraft((current) => (current ? { ...current, startTime: currentTime } : current))
                }
                className="rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[11px] font-medium text-white/70 transition hover:bg-white/[0.08] hover:text-white/88"
              >
                Set Start Here
              </button>
              <button
                type="button"
                onClick={() =>
                  setManualWordDraft((current) => (current ? { ...current, endTime: currentTime } : current))
                }
                className="rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[11px] font-medium text-white/70 transition hover:bg-white/[0.08] hover:text-white/88"
              >
                Set End Here
              </button>
              <button
                type="button"
                onClick={() => void handleSaveManualTiming()}
                disabled={
                  !onSaveManualTiming ||
                  isSavingManualTiming ||
                  resolvedManualWordDraft.endTime <= resolvedManualWordDraft.startTime
                }
                className="rounded-md border border-emerald-400/20 bg-emerald-500/10 px-2.5 py-1.5 text-[11px] font-medium text-emerald-100 transition hover:bg-emerald-500/16 disabled:cursor-not-allowed disabled:opacity-35"
              >
                {isSavingManualTiming ? "Saving..." : "Save Timing"}
              </button>
            </div>
          </div>
          <p className="mt-2 text-[11px] leading-5 text-white/42">
            {formatTime(resolvedManualWordDraft.startTime)} - {formatTime(resolvedManualWordDraft.endTime)}
          </p>
        </div>
      )}

      {pauses.length > 0 && (
        <div className="border-b border-white/8 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-[0.18em] text-white/30">Pause Cleanup</p>
              <p className="mt-1 text-xs leading-5 text-white/46">
                Trim dead air with room tone preserved at the edges.
              </p>
            </div>
            <button
              onClick={() => onRemoveLongPauses()}
              className="rounded-md border border-amber-400/20 bg-amber-500/10 px-2.5 py-1.5 text-[11px] font-medium text-amber-200 transition hover:bg-amber-500/16"
            >
              Remove Long Pauses
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {pauses.slice(0, 10).map((pause) => (
              <button
                key={pause.id}
                onClick={() => onRemovePause(pause.id)}
                className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[10px] uppercase tracking-[0.16em] text-white/60 transition hover:bg-white/[0.08] hover:text-white/82"
              >
                {formatTime(pause.startTime)} - {formatTime(pause.endTime)}
              </button>
            ))}
          </div>
        </div>
      )}

      <div ref={transcriptTextRef} className="vibecut-select-text min-h-0 flex-1 overflow-y-auto">
        {segments.length === 0 ? (
          <div className="px-4 py-8 text-sm leading-6 text-white/36">
            Select a processed clip to inspect its transcript, search hits, and pauses.
          </div>
        ) : (
          segmentWords.map(({ segment, words }) => {
            const isActive = segment.id === activeSegmentId;
            const searchScore = searchScoreMap?.get(segment.id);
            const isHighlighted = searchScore !== undefined && searchScore > 0.5;
            const inSelectedRange =
              activeRange &&
              segment.endTime > activeRange.startTime &&
              segment.startTime < activeRange.endTime;
            const isRemovedFromTimeline = segmentInTimeline !== null && !segmentInTimeline.get(segment.id);

            return (
              <div
                key={segment.id}
                className={`border-b border-white/[0.05] px-4 py-3 transition ${
                  isRemovedFromTimeline
                    ? "opacity-30"
                    : isActive
                    ? "bg-sky-400/10"
                    : inSelectedRange
                    ? "bg-white/[0.035]"
                    : isHighlighted
                    ? "bg-amber-400/8"
                    : "hover:bg-white/[0.03]"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button type="button" className="min-w-0 text-left" onClick={() => onSeek(segment.startTime)}>
                    <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-white/28">
                      <span>
                        {formatTime(segment.startTime)} - {formatTime(segment.endTime)}
                      </span>
                      {searchScore !== undefined && (
                        <span className="rounded-full bg-amber-400/10 px-2 py-0.5 text-amber-300">
                          {Math.round(searchScore * 100)}%
                        </span>
                      )}
                      {isRemovedFromTimeline && (
                        <span className="rounded-full bg-red-400/10 px-2 py-0.5 text-red-300">
                          removed
                        </span>
                      )}
                      {!isRemovedFromTimeline && inSelectedRange && (
                        <span className="rounded-full bg-sky-400/10 px-2 py-0.5 text-sky-200">
                          in sequence clip
                        </span>
                      )}
                      {!segment.wordEditCapable && (
                        <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-white/58">
                          batch only
                        </span>
                      )}
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => onRemoveSegment(segment.id)}
                    className="rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-white/58 transition hover:bg-white/[0.08] hover:text-white/84"
                  >
                    Remove Batch
                  </button>
                </div>

                <div className={`mt-2 text-sm leading-7 ${isRemovedFromTimeline ? "text-white/30 line-through decoration-white/20" : "text-white/80"}`}>
                  {words.map((word, index) => {
                    const isSelected = selection?.wordIds.includes(word.wordId) ?? false;
                    const isActiveWord = word.wordId === activeWordId;
                    const isWordInTimeline = !hasTimelineContext || timelineSourceRanges.some(
                      (range) => {
                        const wStart = word.startTime ?? word.segmentStartTime;
                        const wEnd = word.endTime ?? word.segmentEndTime;
                        return wEnd > range.startTime && wStart < range.endTime;
                      }
                    );
                    return (
                      <span key={word.wordId}>
                        <span
                          className={`vibecut-word cursor-text rounded px-[1px] ${
                            isActiveWord
                              ? "bg-sky-400/30"
                              : isSelected
                              ? "bg-violet-400/30"
                              : !isWordInTimeline && !isRemovedFromTimeline
                              ? "text-white/30 line-through decoration-white/20"
                              : ""
                          }`}
                          data-word-id={word.wordId}
                          data-source-clip-id={word.sourceClipId}
                          data-segment-id={word.segmentId}
                          data-order-index={word.orderIndex}
                          data-aligned={word.aligned ? "true" : "false"}
                          data-editable={word.editable ? "true" : "false"}
                          data-timing-mode={word.timingMode}
                          data-word-text={word.text}
                          data-start-time={word.startTime !== undefined ? String(word.startTime) : ""}
                          data-end-time={word.endTime !== undefined ? String(word.endTime) : ""}
                          data-segment-start-time={String(word.segmentStartTime)}
                          data-segment-end-time={String(word.segmentEndTime)}
                          data-selected={isSelected ? "true" : "false"}
                          title={
                            word.timingMode === "approximate"
                              ? "Approximate timing. Use manual timing to make this word edit-safe."
                              : word.timingMode === "manual"
                              ? "Manual timing override."
                              : undefined
                          }
                          onMouseUp={handleWordMouseUp}
                          onDoubleClick={() =>
                            setManualWordDraft({
                              wordId: word.wordId,
                              text: word.text,
                              timingMode: word.timingMode,
                              startTime: word.startTime ?? word.segmentStartTime,
                              endTime: word.endTime ?? word.segmentEndTime,
                            })
                          }
                        >
                          <span
                            className={
                              word.timingMode === "approximate"
                                ? "rounded border-b border-dotted border-amber-300/80 bg-amber-400/8 text-amber-100"
                                : word.timingMode === "manual"
                                ? "rounded border-b border-dotted border-emerald-300/70 bg-emerald-400/8 text-emerald-50"
                                : undefined
                            }
                          >
                            {word.text}
                          </span>
                        </span>
                        {index < words.length - 1 ? " " : ""}
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
