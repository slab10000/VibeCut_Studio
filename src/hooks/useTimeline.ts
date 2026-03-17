"use client";
import { useReducer } from "react";
import { timelineReducer, initialTimelineState } from "@/lib/timeline";

export function useTimeline() {
  const [state, dispatch] = useReducer(timelineReducer, initialTimelineState);
  return { timeline: state, dispatch };
}
