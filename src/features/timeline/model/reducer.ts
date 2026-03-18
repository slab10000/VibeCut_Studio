import { TimelineAction, TimelineClip, TimelineRange, TimelineState } from "@/shared/contracts";
import { v4 as uuid } from "uuid";

const PENDING_SOURCE_DURATION_EFFECT = "pending_source_duration";

function computeTotalDuration(clips: TimelineClip[]): number {
  return clips.reduce((sum, clip) => sum + clip.duration, 0);
}

function withTimelineMetadata(clips: TimelineClip[]): TimelineClip[] {
  let currentStartMs = 0;

  return clips.map((clip) => {
    const durationMs = Math.round(clip.duration * 1000);
    const next = {
      ...clip,
      durationMs,
      timelineStartMs: currentStartMs,
      sourceInMs: Math.round(clip.sourceStartTime * 1000),
      playbackRate: clip.playbackRate || 1,
      enabled: clip.enabled ?? true,
      kind: clip.kind || clip.type,
      track: clip.track ?? 0,
      effects: clip.effects || [],
      mediaId: clip.mediaId || clip.sourceClipId,
    };

    currentStartMs += durationMs;
    return next;
  });
}

function buildVideoClip(
  sourceClipId: string,
  sourceStartTime: number,
  sourceEndTime: number,
  label?: string
): TimelineClip {
  return {
    id: uuid(),
    type: "video",
    sourceClipId,
    sourceStartTime,
    sourceEndTime,
    duration: Math.max(0, sourceEndTime - sourceStartTime),
    label,
    track: 0,
    timelineStartMs: 0,
    durationMs: 0,
    mediaId: sourceClipId,
    sourceInMs: Math.round(sourceStartTime * 1000),
    playbackRate: 1,
    enabled: true,
    kind: "video",
    effects: [],
  };
}

function stripPendingSourceDurationEffect(clip: TimelineClip): TimelineClip {
  if (!clip.effects.some((effect) => effect.type === PENDING_SOURCE_DURATION_EFFECT)) {
    return clip;
  }

  return {
    ...clip,
    effects: clip.effects.filter((effect) => effect.type !== PENDING_SOURCE_DURATION_EFFECT),
  };
}

function applyRemovedRanges(clips: TimelineClip[], ranges: TimelineRange[]) {
  const removeBySource = new Map<string, { start: number; end: number }[]>();
  for (const range of ranges) {
    const normalizedStart = Math.min(range.startTime, range.endTime);
    const normalizedEnd = Math.max(range.startTime, range.endTime);
    if (normalizedEnd <= normalizedStart) continue;

    const sourceRanges = removeBySource.get(range.sourceClipId) || [];
    sourceRanges.push({ start: normalizedStart, end: normalizedEnd });
    removeBySource.set(range.sourceClipId, sourceRanges);
  }

  const normalizedRanges = new Map<string, { start: number; end: number }[]>();
  for (const [sourceClipId, sourceRanges] of removeBySource.entries()) {
    const merged: { start: number; end: number }[] = [];
    for (const range of sourceRanges.sort((a, b) => a.start - b.start)) {
      const previous = merged[merged.length - 1];
      if (!previous || range.start > previous.end) {
        merged.push({ ...range });
        continue;
      }

      previous.end = Math.max(previous.end, range.end);
    }

    normalizedRanges.set(sourceClipId, merged);
  }

  const newClips: TimelineClip[] = [];
  for (const clip of clips) {
    if (clip.type !== "video" || !clip.sourceClipId) {
      newClips.push(clip);
      continue;
    }

    const removeRanges = normalizedRanges.get(clip.sourceClipId);
    if (!removeRanges || removeRanges.length === 0) {
      newClips.push(clip);
      continue;
    }

    let currentStart = clip.sourceStartTime;
    for (const range of removeRanges) {
      if (range.end <= clip.sourceStartTime || range.start >= clip.sourceEndTime) continue;
      const cutStart = Math.max(range.start, clip.sourceStartTime);
      const cutEnd = Math.min(range.end, clip.sourceEndTime);

      if (cutStart > currentStart) {
        newClips.push(buildVideoClip(clip.sourceClipId, currentStart, cutStart, clip.label));
      }

      currentStart = Math.max(currentStart, cutEnd);
    }

    if (currentStart < clip.sourceEndTime) {
      newClips.push(buildVideoClip(clip.sourceClipId, currentStart, clip.sourceEndTime, clip.label));
    }
  }

  return withTimelineMetadata(newClips);
}

export function timelineReducer(state: TimelineState, action: TimelineAction): TimelineState {
  switch (action.type) {
    case "ADD_SOURCE_CLIP": {
      const newClip = buildVideoClip(action.sourceClipId, 0, action.duration, action.label);
      if (action.pendingSourceDuration) {
        newClip.effects = [
          {
            id: uuid(),
            type: PENDING_SOURCE_DURATION_EFFECT,
            config: { sourceClipId: action.sourceClipId },
          },
        ];
      }
      const clips = withTimelineMetadata([...state.clips, newClip]);
      return { ...state, clips, totalDuration: computeTotalDuration(clips) };
    }

    case "REMOVE_SEGMENTS": {
      const newClips = applyRemovedRanges(
        state.clips,
        action.segments.map((segment) => ({
          sourceClipId: segment.sourceClipId,
          startTime: segment.startTime,
          endTime: segment.endTime,
        }))
      );
      return { ...state, clips: newClips, totalDuration: computeTotalDuration(newClips) };
    }

    case "REMOVE_RANGES": {
      const newClips = applyRemovedRanges(state.clips, action.ranges);
      return { ...state, clips: newClips, totalDuration: computeTotalDuration(newClips) };
    }

    case "INSERT_IMAGE": {
      const newClip: TimelineClip = {
        id: uuid(),
        type: "image",
        sourceStartTime: 0,
        sourceEndTime: action.duration,
        duration: action.duration,
        imageSrc: action.imageSrc,
        label: action.label,
        track: 0,
        timelineStartMs: 0,
        durationMs: 0,
        sourceInMs: 0,
        playbackRate: 1,
        enabled: true,
        kind: "image",
        effects: [],
      };

      const clips = [...state.clips];
      if (action.afterClipId) {
        const idx = clips.findIndex((clip) => clip.id === action.afterClipId);
        clips.splice(idx + 1, 0, newClip);
      } else {
        clips.unshift(newClip);
      }

      const normalized = withTimelineMetadata(clips);
      return { ...state, clips: normalized, totalDuration: computeTotalDuration(normalized) };
    }

    case "SPLIT_CLIP": {
      const clips = [...state.clips];
      const idx = clips.findIndex((clip) => clip.id === action.clipId);
      if (idx === -1) return state;

      const clip = clips[idx];
      if (clip.type !== "video" || !clip.sourceClipId) return state;
      if (action.splitTime <= clip.sourceStartTime || action.splitTime >= clip.sourceEndTime) return state;

      const left = buildVideoClip(clip.sourceClipId, clip.sourceStartTime, action.splitTime, clip.label);
      const right = buildVideoClip(clip.sourceClipId, action.splitTime, clip.sourceEndTime, clip.label);
      clips.splice(idx, 1, left, right);

      const normalized = withTimelineMetadata(clips);
      return { ...state, clips: normalized, totalDuration: computeTotalDuration(normalized) };
    }

    case "TRIM_CLIP": {
      const clips = withTimelineMetadata(
        state.clips.map((clip) => {
          if (clip.id !== action.clipId || clip.type !== "video") return clip;
          const nextClip = stripPendingSourceDurationEffect(clip);
          return {
            ...nextClip,
            sourceStartTime: action.newStart,
            sourceEndTime: action.newEnd,
            duration: Math.max(0, action.newEnd - action.newStart),
          };
        })
      );

      return { ...state, clips, totalDuration: computeTotalDuration(clips) };
    }

    case "DELETE_CLIP": {
      const clips = withTimelineMetadata(state.clips.filter((clip) => clip.id !== action.clipId));
      return { ...state, clips, totalDuration: computeTotalDuration(clips) };
    }

    case "REORDER_CLIP": {
      const clips = [...state.clips];
      const [moved] = clips.splice(action.fromIndex, 1);
      if (!moved) return state;
      clips.splice(action.toIndex, 0, moved);
      const normalized = withTimelineMetadata(clips);
      return { ...state, clips: normalized, totalDuration: computeTotalDuration(normalized) };
    }

    case "APPLY_EDIT": {
      const clips = withTimelineMetadata(action.clips);
      return { ...state, clips, totalDuration: computeTotalDuration(clips) };
    }

    case "SET_CLIPS": {
      const clips = withTimelineMetadata(action.clips);
      return { ...state, clips, totalDuration: computeTotalDuration(clips) };
    }

    default:
      return state;
  }
}

export const initialTimelineState: TimelineState = {
  clips: [],
  totalDuration: 0,
};
