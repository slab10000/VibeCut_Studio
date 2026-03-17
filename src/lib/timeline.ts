import { TimelineClip, TimelineState, TimelineAction, TimelineRange } from "@/types";
import { v4 as uuid } from "uuid";

function computeTotalDuration(clips: TimelineClip[]): number {
  return clips.reduce((sum, clip) => sum + clip.duration, 0);
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

  return newClips;
}

export function timelineReducer(state: TimelineState, action: TimelineAction): TimelineState {
  switch (action.type) {
    case "ADD_SOURCE_CLIP": {
      const newClip = buildVideoClip(action.sourceClipId, 0, action.duration, action.label);
      const clips = [...state.clips, newClip];
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
      };

      const clips = [...state.clips];
      if (action.afterClipId) {
        const idx = clips.findIndex((c) => c.id === action.afterClipId);
        clips.splice(idx + 1, 0, newClip);
      } else {
        clips.unshift(newClip);
      }

      return { ...state, clips, totalDuration: computeTotalDuration(clips) };
    }

    case "SPLIT_CLIP": {
      const clips = [...state.clips];
      const idx = clips.findIndex((c) => c.id === action.clipId);
      if (idx === -1) return state;

      const clip = clips[idx];
      if (clip.type !== "video" || !clip.sourceClipId) return state;
      if (action.splitTime <= clip.sourceStartTime || action.splitTime >= clip.sourceEndTime) return state;

      const left = buildVideoClip(clip.sourceClipId, clip.sourceStartTime, action.splitTime, clip.label);
      const right = buildVideoClip(clip.sourceClipId, action.splitTime, clip.sourceEndTime, clip.label);
      clips.splice(idx, 1, left, right);

      return { ...state, clips, totalDuration: computeTotalDuration(clips) };
    }

    case "TRIM_CLIP": {
      const clips = state.clips.map((clip) => {
        if (clip.id !== action.clipId || clip.type !== "video") return clip;
        return {
          ...clip,
          sourceStartTime: action.newStart,
          sourceEndTime: action.newEnd,
          duration: Math.max(0, action.newEnd - action.newStart),
        };
      });

      return { ...state, clips, totalDuration: computeTotalDuration(clips) };
    }

    case "DELETE_CLIP": {
      const clips = state.clips.filter((clip) => clip.id !== action.clipId);
      return { ...state, clips, totalDuration: computeTotalDuration(clips) };
    }

    case "REORDER_CLIP": {
      const clips = [...state.clips];
      const [moved] = clips.splice(action.fromIndex, 1);
      if (!moved) return state;
      clips.splice(action.toIndex, 0, moved);
      return { ...state, clips, totalDuration: computeTotalDuration(clips) };
    }

    case "APPLY_EDIT":
      return { ...state, clips: action.clips, totalDuration: computeTotalDuration(action.clips) };

    case "SET_CLIPS":
      return { ...state, clips: action.clips, totalDuration: computeTotalDuration(action.clips) };

    default:
      return state;
  }
}

export const initialTimelineState: TimelineState = {
  clips: [],
  totalDuration: 0,
};
