"use client";
import { useReducer } from "react";
import { timelineReducer, initialTimelineState } from "@/features/timeline/model/reducer";

export function useTimeline() {
  const [state, dispatch] = useReducer(timelineReducer, initialTimelineState);
  return { timeline: state, dispatch };
}
