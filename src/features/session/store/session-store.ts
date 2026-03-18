import { create } from "zustand";
import type { DockTab, TranscriptSelection } from "@/shared/contracts";

interface SessionStore {
  selectedSourceClipId: string | null;
  selectedTimelineClipId: string | null;
  dockTab: DockTab;
  searchDraft: string;
  activeSearchQuery: string;
  transcriptSelection: TranscriptSelection | null;
  lastExplanation: string | null;
  pendingAiEditJobId: string | null;
  isDraggingOver: boolean;
  bootstrapError: string | null;
  setSelectedSourceClipId: (clipId: string | null) => void;
  setSelectedTimelineClipId: (clipId: string | null) => void;
  setDockTab: (dockTab: DockTab) => void;
  setSearchDraft: (searchDraft: string) => void;
  setActiveSearchQuery: (query: string) => void;
  setTranscriptSelection: (selection: TranscriptSelection | null) => void;
  setLastExplanation: (value: string | null) => void;
  setPendingAiEditJobId: (jobId: string | null) => void;
  setIsDraggingOver: (value: boolean) => void;
  setBootstrapError: (value: string | null) => void;
}

export const useSessionStore = create<SessionStore>((set) => ({
  selectedSourceClipId: null,
  selectedTimelineClipId: null,
  dockTab: "transcript",
  searchDraft: "",
  activeSearchQuery: "",
  transcriptSelection: null,
  lastExplanation: null,
  pendingAiEditJobId: null,
  isDraggingOver: false,
  bootstrapError: null,
  setSelectedSourceClipId: (selectedSourceClipId) => set({ selectedSourceClipId }),
  setSelectedTimelineClipId: (selectedTimelineClipId) => set({ selectedTimelineClipId }),
  setDockTab: (dockTab) => set({ dockTab }),
  setSearchDraft: (searchDraft) => set({ searchDraft }),
  setActiveSearchQuery: (activeSearchQuery) => set({ activeSearchQuery }),
  setTranscriptSelection: (transcriptSelection) => set({ transcriptSelection }),
  setLastExplanation: (lastExplanation) => set({ lastExplanation }),
  setPendingAiEditJobId: (pendingAiEditJobId) => set({ pendingAiEditJobId }),
  setIsDraggingOver: (isDraggingOver) => set({ isDraggingOver }),
  setBootstrapError: (bootstrapError) => set({ bootstrapError }),
}));
