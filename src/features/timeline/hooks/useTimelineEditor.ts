import { useEffect, useReducer, useRef } from "react";
import type { TimelineAction, TimelineClip } from "@/shared/contracts";
import { initialTimelineState, timelineReducer } from "@/features/timeline/model/reducer";

export function useTimelineEditor(serverClips: TimelineClip[] = []) {
  const [timeline, dispatch] = useReducer(timelineReducer, initialTimelineState);
  const undoStackRef = useRef<TimelineClip[][]>([]);

  useEffect(() => {
    dispatch({ type: "SET_CLIPS", clips: serverClips });
  }, [serverClips]);

  const dispatchWithUndo = (action: TimelineAction) => {
    undoStackRef.current.push([...timeline.clips]);
    if (undoStackRef.current.length > 20) undoStackRef.current.shift();
    dispatch(action);
  };

  const undo = () => {
    const previous = undoStackRef.current.pop();
    if (!previous) return;
    dispatch({ type: "SET_CLIPS", clips: previous });
  };

  return {
    timeline,
    dispatch,
    dispatchWithUndo,
    undo,
  };
}
