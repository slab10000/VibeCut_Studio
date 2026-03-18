import { create } from "zustand";
import type { MonitorMode } from "@/shared/contracts";

interface PlaybackStore {
  monitorMode: MonitorMode;
  programTime: number;
  sourceTime: number;
  isPlaying: boolean;
  setMonitorMode: (mode: MonitorMode) => void;
  setProgramTime: (value: number) => void;
  setSourceTime: (value: number) => void;
  setIsPlaying: (value: boolean) => void;
}

export const usePlaybackStore = create<PlaybackStore>((set) => ({
  monitorMode: "source",
  programTime: 0,
  sourceTime: 0,
  isPlaying: false,
  setMonitorMode: (monitorMode) => set({ monitorMode }),
  setProgramTime: (programTime) => set({ programTime }),
  setSourceTime: (sourceTime) => set({ sourceTime }),
  setIsPlaying: (isPlaying) => set({ isPlaying }),
}));
